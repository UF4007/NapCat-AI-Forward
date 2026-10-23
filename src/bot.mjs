// Decides what happens to each incoming message: batch it, ask the model, and reply (or stay silent).
import { assistantLine, Chat, clipTail, compressIfNeeded, contextLine, rebuildContext, Thread, trimContext } from './conversation.mjs';
import { recentRecords } from './history.mjs';
import { Llm } from './llm.mjs';
import { downloadImage, imageUrls, isMentioned, plainText, render, replyId } from './message.mjs';
import { formatTime } from './time.mjs';

export const NO_REPLY = '[NO_REPLY]';
const RESET_COMMANDS = new Set(['/reset', '/重置']);
// Statuses with which providers reject a request itself, most often because it is longer than the model accepts.
const REJECTED = new Set([400, 413, 422]);
// In global mode the model sometimes copies the "[group-123]" label it sees on every line; it is not meant to be sent.
const LEADING_LABEL = /^\s*\[(?:group|private)-\d+\]\s*/;

// The newest `max` messages, always including the latest @-mention.
function limitBatch(messages, mention, max) {
  if (messages.length <= max) return messages;
  const kept = messages.slice(-max);
  if (mention && !kept.includes(mention)) kept.splice(0, 1, mention); // the mention is older than all kept ones
  return kept;
}

export class Bot {
  constructor(config, { memoryStore, tools, onebot }) {
    this.config = config;
    this.memoryStore = memoryStore;
    this.tools = tools;
    this.onebot = onebot;
    this.llm = new Llm(config.llm);
    this.global = config.conversation.mode === 'global';
    this.chats = new Map();
    this.threads = new Map();
    this.groupAllow = new Set(config.group.allow);
    this.privateAllow = new Set(config.private.allow);
  }

  accepts(ev) {
    if (ev.post_type !== 'message') return false;
    if (ev.message_type === 'group') return !this.groupAllow.size || this.groupAllow.has(String(ev.group_id));
    if (ev.message_type === 'private') {
      return this.config.private.enabled && (!this.privateAllow.size || this.privateAllow.has(String(ev.user_id)));
    }
    return false;
  }

  onEvent(ev) {
    if (!this.accepts(ev)) return;
    const chat = this.chat(ev);
    chat.intake = chat.intake.then(() => this.receive(chat, ev)).catch((e) => console.error(`${chat.key}: ${e.stack || e}`));
  }

  chat(ev) {
    const isGroup = ev.message_type === 'group';
    const targetId = isGroup ? ev.group_id : ev.user_id;
    const key = `${isGroup ? 'group' : 'private'}-${targetId}`;
    if (!this.chats.has(key)) {
      const chat = new Chat(key, { isGroup, targetId }, this.thread(key, isGroup));
      chat.restored = this.restore(chat, ev);
      this.chats.set(key, chat);
    }
    return this.chats.get(key);
  }

  thread(chatKey, isGroup) {
    const key = this.global ? 'global' : chatKey;
    if (!this.threads.has(key)) {
      const { maxMemoryChars } = this.config.memory;
      this.threads.set(key, new Thread(key, this.memoryStore, { labelled: this.global, isPrivate: !this.global && !isGroup, maxMemoryChars }));
    }
    return this.threads.get(key);
  }

  // The first time a chat is seen (e.g. after a restart), add its latest messages from QQ to the context.
  async restore(chat, firstEvent) {
    const { keepRecentMessages, maxMessageChars, maxContextChars } = this.config.memory;
    let restored;
    try {
      restored = { context: rebuildContext(await recentRecords(this.onebot, chat.key, keepRecentMessages, firstEvent), chat, maxMessageChars) };
      trimContext(restored, keepRecentMessages, maxContextChars / 2);
    } catch (e) {
      console.error(`${chat.key}: could not load recent history from NapCat: ${e.message}`);
      return;
    }
    await chat.thread.run(() => chat.thread.context.push(...restored.context));
  }

  async receive(chat, ev) {
    await chat.restored;
    const msg = await this.describe(ev);
    if (!msg.text) return;

    if (RESET_COMMANDS.has(msg.plain) && (!chat.isGroup || msg.mentioned)) {
      return chat.thread.run(() => {
        chat.thread.context = [];
        chat.pending = [];
        this.reply(chat, '上下文已清空。', chat.isGroup ? msg.id : undefined, { remember: false });
      });
    }
    chat.pending.push(msg);
    this.schedule(chat, !chat.isGroup || msg.mentioned);
  }

  // A message as the model will read it, including what it replies to (fetched with get_msg).
  async describe(ev) {
    const segments = Array.isArray(ev.message) ? ev.message : [];
    const { vision } = this.config;
    let text = render(segments, ev.self_id);
    let images = imageUrls(segments, vision);
    const quoteId = replyId(segments);
    if (quoteId != null) {
      try {
        const original = await this.onebot.call('get_msg', { message_id: quoteId });
        const quotedSegments = Array.isArray(original?.message) ? original.message : [];
        const who = original.sender?.card || original.sender?.nickname || original.user_id;
        const quoted = render(quotedSegments, ev.self_id).slice(0, 200);
        if (quoted) text = `（回复 ${who}：${quoted}）${text}`;
        images = [...imageUrls(quotedSegments, vision), ...images];
      } catch (e) {
        console.error(`could not load replied-to message ${quoteId}: ${e.message}`);
      }
    }
    return {
      id: ev.message_id,
      time: ev.time ? ev.time * 1000 : Date.now(),
      userId: ev.user_id,
      name: ev.sender?.card || ev.sender?.nickname || String(ev.user_id),
      text,
      plain: plainText(segments),
      mentioned: isMentioned(segments, ev.self_id),
      images,
    };
  }

  // Group messages are collected until the chat has been quiet for debounceSeconds (at most maxWaitSeconds);
  // private messages and @-mentions are handled right away. Either way the batch then waits its turn on the
  // chat's thread, which handles one batch at a time.
  schedule(chat, immediate) {
    const { debounceSeconds, maxWaitSeconds } = this.config.group;
    const now = Date.now();
    if (!chat.firstPendingAt) chat.firstPendingAt = now;
    const delay = immediate ? 0 : Math.max(0, Math.min(debounceSeconds * 1000, chat.firstPendingAt + maxWaitSeconds * 1000 - now));
    clearTimeout(chat.timer);
    chat.timer = setTimeout(() => chat.thread.run(() => this.flush(chat)), delay);
  }

  async flush(chat) {
    const pending = chat.pending.splice(0);
    chat.firstPendingAt = 0;
    if (!pending.length) return;
    const { memory, group } = this.config;
    const { thread } = chat;

    // A burst (e.g. while the previous request was running) is cut to the newest messages; the rest stay in QQ.
    const mention = pending.findLast((m) => m.mentioned);
    const batch = limitBatch(pending, mention, memory.maxBatchMessages);
    const lines = batch.map((m) => contextLine(chat, m, memory.maxMessageChars));
    const omitted = pending.length - batch.length;
    if (omitted) {
      lines.unshift(`（期间还有 ${omitted} 条较早的消息已省略${this.tools.definitions.length ? '，需要时可以搜索聊天记录' : ''}）`);
    }
    thread.context.push({ role: 'user', content: clipTail(lines.join('\n'), memory.maxContextChars / 2), time: batch[0].time });

    const mustReply = !chat.isGroup || Boolean(mention);
    if (!mustReply && group.reply === 'mention') return this.compress(thread); // just listen

    const images = await this.loadImages(batch);
    let reply;
    let error;
    try {
      reply = await this.ask(chat, images);
    } catch (e) {
      error = e;
    }
    // A rejected request is most likely longer than the model accepts (which may be less than maxContextChars
    // allows). Rather than failing on every later message, retry with a shorter context, and then with only
    // this batch, cut to a single message's length, and without long-term memory.
    const fallbacks = [[memory.keepRecentMessages, memory.maxContextChars / 4, true], [1, memory.maxMessageChars, false]];
    for (const [keep, budget, withMemory] of fallbacks) {
      if (!REJECTED.has(error?.status)) break;
      const shorter = withMemory ? 'a shorter context' : 'only this batch and no long-term memory';
      console.error(`${chat.key}: request rejected (${error.message}), retrying with ${shorter}`);
      trimContext(thread, keep, budget);
      error = undefined;
      try {
        reply = await this.ask(chat, images, { withMemory });
      } catch (e) {
        error = e;
      }
    }

    if (this.global && reply) reply = reply.replace(LEADING_LABEL, '');
    // In a group the reply quotes the latest @-mention. In a private chat it quotes the last message only when it
    // would otherwise be unclear what it answers: several messages were answered at once, or newer ones arrived
    // while the model was busy.
    const unclear = pending.length > 1 || chat.pending.length > 0;
    const quote = chat.isGroup ? mention?.id : unclear ? batch.at(-1).id : undefined;
    if (error) {
      console.error(`LLM request failed for ${chat.key}: ${error.message}`);
      if (!chat.isGroup) thread.context.pop(); // so the user can simply ask again
      if (mustReply) this.reply(chat, `出错了：${error.message}`, quote, { remember: false });
    } else if (chat.isGroup && (!reply || reply.includes(NO_REPLY))) {
      // the model chose silence
    } else {
      this.reply(chat, reply || '（空回复）', quote);
    }
    await this.compress(thread);
  }

  // The batch's images, downloaded for inlining when vision is enabled.
  async loadImages(batch) {
    const { vision } = this.config;
    if (!vision.enabled) return { dataUrls: [], note: '' };
    const urls = batch.flatMap((m) => m.images).slice(-vision.maxImages);
    const results = await Promise.allSettled(urls.map((url) => downloadImage(url, vision.maxImageMB * 1024 * 1024)));
    const dataUrls = [];
    for (const r of results) {
      if (r.status === 'fulfilled') dataUrls.push(r.value);
      else console.error(`image download failed: ${r.reason.message}`);
    }
    const failed = results.length - dataUrls.length;
    return { dataUrls, note: failed ? `\n（有 ${failed} 张图片加载失败）` : '' };
  }

  // Asks the model about the newest context entry, with this turn's images attached.
  ask(chat, { dataUrls, note }, { withMemory = true } = {}) {
    const text = chat.thread.context.at(-1).content + note;
    const content = dataUrls.length
      ? [{ type: 'text', text }, ...dataUrls.map((url) => ({ type: 'image_url', image_url: { url } }))]
      : text;
    return this.llm.complete(this.messages(chat, content, withMemory), {
      tools: this.tools.definitions,
      onToolCall: (name, args) => this.tools.call(name, args, { conversation: chat.key }),
    });
  }

  // The context holds text only; this turn's entry is swapped for the version carrying images.
  messages(chat, content, withMemory) {
    const earlier = chat.thread.context.slice(0, -1).map(({ role, content: text }) => ({ role, content: text }));
    return [{ role: 'system', content: this.systemPrompt(chat, withMemory) }, ...earlier, { role: 'user', content }];
  }

  systemPrompt(chat, withMemory) {
    const { bot, group, timezone } = this.config;
    const lines = [bot.systemPrompt];
    if (bot.name) lines.push(`你的名字是「${bot.name}」。`);
    lines.push(`当前时间：${formatTime(Date.now(), timezone)}（${timezone}）。`);
    const where = chat.isGroup ? `QQ 群 ${chat.targetId}` : `和 QQ 用户 ${chat.targetId} 的私聊`;
    if (this.global) {
      lines.push('你同时在多个 QQ 群和私聊里，所有对话共用这一份上下文。每条消息前的 [group-群号] 表示来自哪个群，[private-QQ号] 表示私聊；'
        + '格式是"[会话 ID] 昵称(QQ号)：内容"，"@你"表示有人提到了你。你每次看到的是某一个会话里的一批新消息。');
      lines.push(`这批新消息来自 [${chat.key}]（${where}），你的回复只会发到那里。`);
    } else if (chat.isGroup) {
      lines.push(`你在 QQ 群 ${chat.targetId} 里（会话 ID：${chat.key}）。群消息的格式是"昵称(QQ号)：内容"，"@你"表示有人提到了你。你每次看到的是一批新消息。`);
    } else {
      lines.push(`你正在和 QQ 用户 ${chat.targetId} 私聊（会话 ID：${chat.key}）。`);
    }
    if (chat.isGroup && group.reply === 'auto') {
      lines.push(`只有在有人 @ 你、叫你的名字、明确向你提问，或者你确实有很有价值的内容可以补充时才发言；被 @ 时一定要回复。其他情况只输出 ${NO_REPLY}，不要输出任何别的内容。`);
    }
    if (this.global) lines.push('发言时直接说你要说的话，不要加"[会话 ID]"标签或"昵称："这样的前缀。');
    else if (chat.isGroup) lines.push('发言时直接说你要说的话，不要加"昵称："这样的前缀。');
    const { memory } = chat.thread;
    if (memory && withMemory) {
      lines.push(this.global
        ? `以下是你的长期记忆（由所有群和私聊的较早聊天整理而来）：\n${memory}`
        : `以下是你对这个会话的长期记忆（由较早的聊天整理而来）：\n${memory}`);
    }
    return lines.join('\n');
  }

  reply(chat, text, quoteId, { remember = true } = {}) {
    const message = [
      ...(quoteId != null ? [{ type: 'reply', data: { id: String(quoteId) } }] : []),
      { type: 'text', data: { text } },
    ];
    const target = chat.isGroup ? { group_id: chat.targetId } : { user_id: chat.targetId };
    this.onebot.send(chat.isGroup ? 'send_group_msg' : 'send_private_msg', { ...target, message });
    if (remember) chat.thread.context.push({ role: 'assistant', content: assistantLine(chat, text), time: Date.now() });
  }

  compress(thread) {
    const { memory, timezone } = this.config;
    return compressIfNeeded(thread, { llm: this.llm, memory, memoryStore: this.memoryStore, timezone });
  }
}
