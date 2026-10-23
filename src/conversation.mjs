// Conversation state, in two layers:
//   Chat    one QQ group or private chat: incoming messages wait there to be batched, and replies go back to it.
//   Thread  what the model sees: short-term context, long-term memory, and the queue that handles one batch at a
//           time. With conversation.mode "separate" every chat has its own thread; with "global" all chats share one.
// Context entries are { role, content } with string content; their total size is kept within the memory limits.

export class Thread {
  // labelled: several chats share this thread, so every line names its chat ("[group-123] …").
  constructor(key, memoryStore, { labelled, isPrivate }) {
    this.key = key; // memory file name: "group-<id>", "private-<id>" or "global"
    this.labelled = labelled;
    this.isPrivate = isPrivate; // a separate private chat: lines carry no speaker, so the transcript adds one
    this.memory = memoryStore.read(key);
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
      context.push({ role: 'assistant', content: assistantLine(chat, r.text) });
      continue;
    }
    const line = contextLine(chat, r, maxMessageChars);
    const last = context.at(-1);
    if (last?.role === 'user') last.content += `\n${line}`;
    else context.push({ role: 'user', content: line });
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

const compressPrompt = (maxChars) =>
  '你负责整理一个 QQ 聊天机器人的长期记忆。把"已有记忆"和"新的聊天记录"合并成一份更新后的记忆，用简洁的要点写出：'
  + `参与者及其特点和偏好、重要的事实与约定、还在进行中的话题。删掉过时或无关紧要的内容，总长度不超过 ${maxChars} 字。只输出记忆本身。`;

// When the context has more than memory.maxContextMessages entries or memory.maxContextChars characters, fold
// everything but the newest entries (at most keepRecentMessages, within half the character budget) into the
// memory file. If the model is unavailable this is retried next time, unless the context is twice over the
// limits, in which case the oldest entries are dropped without a summary (they remain in QQ).
export async function compressIfNeeded(thread, { llm, memory, memoryStore }) {
  const messages = thread.context.length;
  const chars = contextChars(thread.context);
  if (messages <= memory.maxContextMessages && chars <= memory.maxContextChars) return;

  const budget = memory.maxContextChars / 2;
  const old = thread.context.slice(0, thread.context.length - recentCount(thread.context, memory.keepRecentMessages, budget));
  if (old.length) {
    const transcript = old
      .map((m) => (m.role === 'assistant' ? `你：${m.content}` : thread.isPrivate ? `对方：${m.content}` : m.content))
      .join('\n');
    try {
      const summary = await llm.complete([
        { role: 'system', content: compressPrompt(memory.maxMemoryChars) },
        { role: 'user', content: `已有记忆：\n${thread.memory || '（无）'}\n\n新的聊天记录：\n${clipTail(transcript, memory.maxContextChars)}` },
      ]);
      if (!summary) throw new Error('the model returned an empty summary');
      thread.memory = summary;
      memoryStore.write(thread.key, summary);
    } catch (e) {
      console.error(`memory compression failed for ${thread.key}: ${e.message}`);
      if (messages <= memory.maxContextMessages * 2 && chars <= memory.maxContextChars * 2) return;
    }
  }
  trimContext(thread, memory.keepRecentMessages, budget);
}
