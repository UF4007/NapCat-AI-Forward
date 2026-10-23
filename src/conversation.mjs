// Per-conversation state: short-term context, messages waiting to be handled, and long-term memory.
// Context entries are { role, content } with string content; their total size is kept within the memory limits.

export class Conversation {
  constructor(key, { isGroup, targetId }, memoryStore) {
    this.key = key;
    this.isGroup = isGroup;
    this.targetId = targetId; // group_id or user_id
    this.pending = []; // described messages not yet handled
    this.firstPendingAt = 0;
    this.timer = null;
    this.intake = Promise.resolve(); // keeps incoming messages in arrival order
    this.tail = Promise.resolve(); // serialises flushes, so replies keep their order
    this.memory = memoryStore.read(key);
    this.context = []; // filled from QQ history when the conversation is first seen (see Bot.restore)
  }

  run(fn) {
    const run = this.tail.then(fn);
    this.tail = run.catch((e) => console.error(`${this.key}: ${e.stack || e}`));
    return run;
  }
}

const clipHead = (text, max) => (text.length <= max ? text : `${text.slice(0, max)}…（过长已截断）`);

// Keeps the end of the text, which in a batch holds the newest messages.
export const clipTail = (text, max) => (text.length <= max ? text : `…（前文过长已截断）\n${text.slice(-max)}`);

export const contextChars = (context) => context.reduce((n, m) => n + m.content.length, 0);

// How one incoming message reads in the context; very long messages are cut (QQ keeps them whole).
export const contextLine = (isGroup, { name, userId, text }, maxChars) => {
  const body = clipHead(text, maxChars);
  return isGroup ? `${name}(${userId})：${body}` : body;
};

// Context from history records ({ self, name, userId, text }, oldest first): the bot's own messages become
// assistant turns, consecutive messages from others are joined into one user turn.
export function rebuildContext(records, isGroup, maxMessageChars) {
  const context = [];
  for (const r of records) {
    if (r.self) {
      context.push({ role: 'assistant', content: r.text });
      continue;
    }
    const line = contextLine(isGroup, r, maxMessageChars);
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
export function trimContext(conv, keep, budget) {
  conv.context.splice(0, conv.context.length - recentCount(conv.context, keep, budget));
  const last = conv.context.at(-1);
  if (last && last.content.length > budget) last.content = clipTail(last.content, budget);
}

const compressPrompt = (maxChars) =>
  '你负责整理一个 QQ 聊天机器人的长期记忆。把"已有记忆"和"新的聊天记录"合并成一份更新后的记忆，用简洁的要点写出：'
  + `参与者及其特点和偏好、重要的事实与约定、还在进行中的话题。删掉过时或无关紧要的内容，总长度不超过 ${maxChars} 字。只输出记忆本身。`;

// When the context has more than memory.maxContextMessages entries or memory.maxContextChars characters, fold
// everything but the newest entries (at most keepRecentMessages, within half the character budget) into the
// memory file. If the model is unavailable this is retried next time, unless the context is twice over the
// limits, in which case the oldest entries are dropped without a summary (they remain in the chat log).
export async function compressIfNeeded(conv, { llm, memory, memoryStore }) {
  const messages = conv.context.length;
  const chars = contextChars(conv.context);
  if (messages <= memory.maxContextMessages && chars <= memory.maxContextChars) return;

  const budget = memory.maxContextChars / 2;
  const old = conv.context.slice(0, conv.context.length - recentCount(conv.context, memory.keepRecentMessages, budget));
  if (old.length) {
    const transcript = old
      .map((m) => (m.role === 'assistant' ? `你：${m.content}` : conv.isGroup ? m.content : `对方：${m.content}`))
      .join('\n');
    try {
      const summary = await llm.complete([
        { role: 'system', content: compressPrompt(memory.maxMemoryChars) },
        { role: 'user', content: `已有记忆：\n${conv.memory || '（无）'}\n\n新的聊天记录：\n${clipTail(transcript, memory.maxContextChars)}` },
      ]);
      if (!summary) throw new Error('the model returned an empty summary');
      conv.memory = summary;
      memoryStore.write(conv.key, summary);
    } catch (e) {
      console.error(`memory compression failed for ${conv.key}: ${e.message}`);
      if (messages <= memory.maxContextMessages * 2 && chars <= memory.maxContextChars * 2) return;
    }
  }
  trimContext(conv, memory.keepRecentMessages, budget);
}
