// Conversation state, in two layers:
//   Chat    one QQ group or private chat: incoming messages wait there to be batched, and replies go back to it.
//   Thread  what the model sees: short-term context, long-term memory, and the queue that handles one batch at a
//           time. With conversation.mode "separate" every chat has its own thread; with "global" all chats share one.
// Context entries are { role, content, time }: content is a string, time (ms) is when the entry's first message was
// sent. Only role and content go to the model. Their total size is kept within the memory limits.
import { formatDate, formatTime } from './time.mjs';

export class Thread {
  // labelled: several chats share this thread, so every line names its chat ("[group-123] …").
  constructor(key, memoryStore, { labelled, isPrivate, maxMemoryChars }) {
    this.key = key; // memory file name: "group-<id>", "private-<id>" or "global"
    this.labelled = labelled;
    this.isPrivate = isPrivate; // a separate private chat: lines carry no speaker, so the transcript adds one
    const memory = memoryStore.read(key);
    this.memory = clipMemory(memory, maxMemoryChars); // e.g. a file edited by hand, or a lowered limit
    if (this.memory.length < memory.length) {
      console.error(`${key}: memory file has ${memory.length} characters, over memory.maxMemoryChars; using the first ${this.memory.length}`);
    }
    this.context = []; // filled from QQ history as chats are first seen (see Bot.restore)
    this.tail = Promise.resolve();
  }

  run(fn) {
    const run = this.tail.then(fn);
    this.tail = run.catch((e) => console.error(`${this.key}: ${e.stack || e}`));
    return run;
  }
}

export class Chat {
  constructor(key, { isGroup, targetId }, thread) {
    this.key = key; // "group-<id>" or "private-<id>"
    this.isGroup = isGroup;
    this.targetId = targetId; // group_id or user_id
    this.thread = thread;
    this.pending = []; // described messages not yet handled
    this.firstPendingAt = 0;
    this.timer = null;
    this.intake = Promise.resolve(); // keeps incoming messages in arrival order
    this.restored = Promise.resolve(); // recent history loaded when the chat is first seen
  }
}

const clipHead = (text, max) => (text.length <= max ? text : `${text.slice(0, max)}…（过长已截断）`);

// Keeps the end of the text, which in a batch holds the newest messages.
export const clipTail = (text, max) => (text.length <= max ? text : `…（前文过长已截断）\n${text.slice(-max)}`);

export const contextChars = (context) => context.reduce((n, m) => n + m.content.length, 0);

// How one incoming message reads in the context; very long messages are cut (QQ keeps them whole).
export function contextLine(chat, { name, userId, text }, maxChars) {
  const body = clipHead(text, maxChars);
  if (chat.thread.labelled) return `[${chat.key}] ${name}(${userId})：${body}`;
  return chat.isGroup ? `${name}(${userId})：${body}` : body;
}

// How one of the bot's own messages reads in the context.
export const assistantLine = (chat, text) => (chat.thread.labelled ? `[${chat.key}] ${text}` : text);

// Context from one chat's history records ({ self, name, userId, text }, oldest first): the bot's own messages
// become assistant turns, consecutive messages from others are joined into one user turn.
export function rebuildContext(records, chat, maxMessageChars) {
  const context = [];
  for (const r of records) {
    if (r.self) {
      context.push({ role: 'assistant', content: assistantLine(chat, r.text), time: r.time });
      continue;
    }
    const line = contextLine(chat, r, maxMessageChars);
    const last = context.at(-1);
    if (last?.role === 'user') last.content += `\n${line}`;
    else context.push({ role: 'user', content: line, time: r.time });
  }
  return context;
}

// How many of the newest entries fit: at most `keep`, within `budget` characters, but always at least one.
function recentCount(context, keep, budget) {
  let count = 0;
  let chars = 0;
  for (let i = context.length - 1; i >= 0 && count < keep; i--) {
    chars += context[i].content.length;
    if (count > 0 && chars > budget) break;
    count++;
  }
  return count;
}

// Drops all but the newest entries that fit, and cuts the newest one if it alone is over budget.
// holder: anything with a `context` array (a thread, or a context being assembled).
export function trimContext(holder, keep, budget) {
  holder.context.splice(0, holder.context.length - recentCount(holder.context, keep, budget));
  const last = holder.context.at(-1);
  if (last && last.content.length > budget) last.content = clipTail(last.content, budget);
}

// Memory has two parts: people and lasting facts, which do not fade, and events, newest first and shorter the
// older they are. Listing the oldest events last means that cutting an over-long memory drops them first.
function compressPrompt(maxChars, thread) {
  const lines = [
    '你负责整理一个 QQ 聊天机器人（下面称"你"）的长期记忆。把"已有记忆"和"新的聊天记录"合并成一份更新后的记忆，'
      + `只输出记忆本身，总长度不超过 ${maxChars} 字。记忆固定分成两部分：`,
    '',
    '## 人物与长期事实',
    '按人整理：称呼和 QQ 号、身份、性格、偏好、和你的关系；以及长期有效的事实和约定。这部分不因为时间久远而删减，只在信息过时或被推翻时修改。',
    '',
    '## 近期经过',
    '按日期从近到远记录发生过的事，每条以日期开头（例如"10-21："），越久远越简略：',
    '- 最近三天：保留具体细节，包括谁说了什么、有什么结论、还有什么没做完',
    '- 三天到两周前：每天压缩成一两句',
    '- 两周以前：只保留至今仍有影响的结论，其余删掉；值得长期记住的内容移到"人物与长期事实"',
    '',
    '无关紧要的闲聊不用记。篇幅不够时，先删减最久远的经过，再精简人物与长期事实。',
  ];
  if (thread.labelled) {
    lines.push('这份记忆由多个群和私聊共用：人物条目注明主要在哪些群出现，经过条目注明发生在哪个群或私聊（[group-群号] 或 [private-QQ号]）。');
  } else if (thread.isPrivate) {
    lines.push('这是一段私聊，聊天记录里的"对方"就是和你私聊的那个人。');
  }
  return lines.join('\n');
}

const shortenPrompt = (length, maxChars) =>
  `你负责精简一个 QQ 聊天机器人的长期记忆。它现在有 ${length} 字，超过了 ${maxChars} 字的上限。`
  + '保持原有的结构，把它精简到上限以内：先删减最久远的经过，再合并相近的条目。只输出记忆本身。';

// Cuts text to at most max characters, at a line break if that keeps at least half of it.
export function clipMemory(text, max) {
  if (text.length <= max) return text;
  const lineEnd = text.lastIndexOf('\n', max);
  return text.slice(0, lineEnd >= max / 2 ? lineEnd : max).trimEnd();
}

// Memory never exceeds maxChars: an over-long summary gets one request to shorten it, and whatever is still too
// long is cut, which drops the oldest events first.
async function limitMemory(text, { llm, key, maxChars }) {
  if (text.length <= maxChars) return text;
  try {
    const shorter = await llm.complete([
      { role: 'system', content: shortenPrompt(text.length, maxChars) },
      { role: 'user', content: text },
    ]);
    if (shorter && shorter.length < text.length) text = shorter;
  } catch (e) {
    console.error(`could not shorten the memory of ${key}: ${e.message}`);
  }
  if (text.length > maxChars) console.error(`memory of ${key} has ${text.length} characters, cutting it to ${maxChars}`);
  return clipMemory(text, maxChars);
}

// The entries as text under date headings, so the model can tell recent events from old ones.
function transcript(entries, { isPrivate }, timezone) {
  const lines = [];
  let day;
  for (const m of entries) {
    const date = m.time ? formatDate(m.time, timezone) : day;
    if (date !== day) lines.push(`【${date}】`);
    day = date;
    lines.push(m.role === 'assistant' ? `你：${m.content}` : isPrivate ? `对方：${m.content}` : m.content);
  }
  return lines.join('\n');
}

// When the context has more than memory.maxContextMessages entries or memory.maxContextChars characters, fold
// everything but the newest entries (at most keepRecentMessages, within half the character budget) into the
// memory file. If the model is unavailable this is retried next time, unless the context is twice over the
// limits, in which case the oldest entries are dropped without a summary (they remain in QQ).
export async function compressIfNeeded(thread, { llm, memory, memoryStore, timezone }) {
  const messages = thread.context.length;
  const chars = contextChars(thread.context);
  if (messages <= memory.maxContextMessages && chars <= memory.maxContextChars) return;

  const budget = memory.maxContextChars / 2;
  const old = thread.context.slice(0, thread.context.length - recentCount(thread.context, memory.keepRecentMessages, budget));
  if (old.length) {
    const now = `现在是 ${formatTime(Date.now(), timezone)}（${timezone}）。`;
    const records = clipTail(transcript(old, thread, timezone), memory.maxContextChars);
    try {
      const summary = await llm.complete([
        { role: 'system', content: compressPrompt(memory.maxMemoryChars, thread) },
        { role: 'user', content: `${now}\n\n已有记忆：\n${thread.memory || '（无）'}\n\n新的聊天记录：\n${records}` },
      ]);
      if (!summary) throw new Error('the model returned an empty summary');
      thread.memory = await limitMemory(summary, { llm, key: thread.key, maxChars: memory.maxMemoryChars });
      memoryStore.write(thread.key, thread.memory);
    } catch (e) {
      console.error(`memory compression failed for ${thread.key}: ${e.message}`);
      if (messages <= memory.maxContextMessages * 2 && chars <= memory.maxContextChars * 2) return;
    }
  }
  trimContext(thread, memory.keepRecentMessages, budget);
}
