// Per-conversation state: short-term context, messages waiting to be handled, and long-term memory.
import { complete } from './llm.mjs';

export class Conversation {
  constructor(key, { isGroup, targetId }, store, keepRecentMessages) {
    this.key = key;
    this.isGroup = isGroup;
    this.targetId = targetId; // group_id or user_id
    this.pending = []; // described messages not yet handled
    this.firstPendingAt = 0;
    this.timer = null;
    this.intake = Promise.resolve(); // keeps incoming messages in arrival order
    this.tail = Promise.resolve(); // serialises flushes, so replies keep their order
    this.memory = store.readMemory(key);
    // after a restart, pick up where the log left off
    this.context = rebuildContext(store.readLog(key).slice(-keepRecentMessages), isGroup);
  }

  run(fn) {
    const run = this.tail.then(fn);
    this.tail = run.catch((e) => console.error(`${this.key}: ${e.stack || e}`));
    return run;
  }
}

// How one incoming message reads in the context.
export const contextLine = (isGroup, { name, userId, text }) => (isGroup ? `${name}(${userId})：${text}` : text);

function rebuildContext(records, isGroup) {
  const context = [];
  for (const r of records) {
    if (r.self) {
      context.push({ role: 'assistant', content: r.text });
      continue;
    }
    const line = contextLine(isGroup, { name: r.name, userId: r.user_id, text: r.text });
    const last = context.at(-1);
    if (last?.role === 'user') last.content += `\n${line}`;
    else context.push({ role: 'user', content: line });
  }
  return context;
}

const compressPrompt = (maxChars) =>
  '你负责整理一个 QQ 聊天机器人的长期记忆。把"已有记忆"和"新的聊天记录"合并成一份更新后的记忆，用简洁的要点写出：'
  + `参与者及其特点和偏好、重要的事实与约定、还在进行中的话题。删掉过时或无关紧要的内容，总长度不超过 ${maxChars} 字。只输出记忆本身。`;

// When the context grows past memory.maxContextMessages, fold everything but the newest
// memory.keepRecentMessages into the memory file.
export async function compressIfNeeded(conv, { llm, memory, store }) {
  if (conv.context.length <= memory.maxContextMessages) return;
  const old = conv.context.slice(0, conv.context.length - memory.keepRecentMessages);
  const transcript = old
    .map((m) => (m.role === 'assistant' ? `你：${m.content}` : conv.isGroup ? m.content : `对方：${m.content}`))
    .join('\n');
  try {
    const summary = await complete(llm, [
      { role: 'system', content: compressPrompt(memory.maxMemoryChars) },
      { role: 'user', content: `已有记忆：\n${conv.memory || '（无）'}\n\n新的聊天记录：\n${transcript}` },
    ]);
    if (!summary) throw new Error('the model returned an empty summary');
    conv.memory = summary;
    store.writeMemory(conv.key, summary);
    conv.context.splice(0, old.length);
  } catch (e) {
    console.error(`memory compression failed for ${conv.key}: ${e.message}`);
    // try again next time, but never let the context grow without bound
    if (conv.context.length > memory.maxContextMessages * 2) {
      conv.context.splice(0, conv.context.length - memory.maxContextMessages);
    }
  }
}
