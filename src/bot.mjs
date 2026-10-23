// Decides what happens to each incoming message: log it, batch it, ask the model, and reply (or stay silent).
import { compressIfNeeded, contextLine, Conversation } from './conversation.mjs';
import { complete } from './llm.mjs';
import { downloadImage, imageUrls, isMentioned, plainText, render, replyId } from './message.mjs';
import { formatTime } from './store.mjs';

export const NO_REPLY = '[NO_REPLY]';
const RESET_COMMANDS = new Set(['/reset', '/重置']);

export class Bot {
  constructor(config, { store, tools, onebot }) {
    this.config = config;
    this.store = store;
    this.tools = tools;
    this.onebot = onebot;
    this.conversations = new Map();
    this.groupAllow = new Set(config.group.allow);
    this.privateAllow = new Set(config.private.allow);
    this.selfId = null;
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
    this.selfId = ev.self_id;
    const conv = this.conversation(ev);
    conv.intake = conv.intake.then(() => this.receive(conv, ev)).catch((e) => console.error(`${conv.key}: ${e.stack || e}`));
  }

  conversation(ev) {
    const isGroup = ev.message_type === 'group';
    const targetId = isGroup ? ev.group_id : ev.user_id;
    const key = `${isGroup ? 'group' : 'private'}-${targetId}`;
    if (!this.conversations.has(key)) {
      this.conversations.set(key, new Conversation(key, { isGroup, targetId }, this.store, this.config.memory.keepRecentMessages));
    }
    return this.conversations.get(key);
  }

  async receive(conv, ev) {
    const msg = await this.describe(ev);
    if (!msg.text) return;
    const time = ev.time ? new Date(ev.time * 1000).toISOString() : new Date().toISOString();
    this.store.appendLog(conv.key, { time, message_id: ev.message_id, user_id: ev.user_id, name: msg.name, text: msg.text });

    if (RESET_COMMANDS.has(msg.plain) && (!conv.isGroup || msg.mentioned)) {
      return conv.run(() => {
        conv.context = [];
        conv.pending = [];
        this.reply(conv, '上下文已清空。', msg.id, { remember: false });
      });
    }
    conv.pending.push(msg);
    this.schedule(conv, !conv.isGroup || msg.mentioned);
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
      userId: ev.user_id,
      name: ev.sender?.card || ev.sender?.nickname || String(ev.user_id),
      text,
      plain: plainText(segments),
      mentioned: isMentioned(segments, ev.self_id),
      images,
    };
  }

  // Group messages are collected until the chat has been quiet for debounceSeconds (at most maxWaitSeconds);
  // private messages and @-mentions are handled right away.
  schedule(conv, immediate) {
    const { debounceSeconds, maxWaitSeconds } = this.config.group;
    const now = Date.now();
    if (!conv.firstPendingAt) conv.firstPendingAt = now;
    const delay = immediate ? 0 : Math.max(0, Math.min(debounceSeconds * 1000, conv.firstPendingAt + maxWaitSeconds * 1000 - now));
    clearTimeout(conv.timer);
    conv.timer = setTimeout(() => conv.run(() => this.flush(conv)), delay);
  }

  async flush(conv) {
    const batch = conv.pending.splice(0);
    conv.firstPendingAt = 0;
    if (!batch.length) return;
    const text = batch.map((m) => contextLine(conv.isGroup, m)).join('\n');
    conv.context.push({ role: 'user', content: text });

    const mention = batch.findLast((m) => m.mentioned);
    const mustReply = !conv.isGroup || Boolean(mention);
    if (!mustReply && this.config.group.reply === 'mention') return this.compress(conv); // just listen

    let reply;
    try {
      const content = await this.withImages(batch, text);
      reply = await complete(this.config.llm, this.messages(conv, content), {
        tools: this.tools.definitions,
        onToolCall: (name, args) => this.tools.call(name, args, { conversation: conv.key }),
      });
    } catch (e) {
      console.error(`LLM request failed for ${conv.key}: ${e.message}`);
      if (!conv.isGroup) conv.context.pop(); // so the user can simply ask again
      if (mustReply) this.reply(conv, `出错了：${e.message}`, batch.at(-1).id, { remember: false });
      return;
    }

    if (conv.isGroup && (!reply || reply.includes(NO_REPLY))) return this.compress(conv); // the model chose silence
    this.reply(conv, reply || '（空回复）', conv.isGroup ? mention?.id : batch.at(-1).id);
    await this.compress(conv);
  }

  // The batch text, plus its images (downloaded and inlined) when vision is enabled.
  async withImages(batch, text) {
    const { vision } = this.config;
    if (!vision.enabled) return text;
    const urls = batch.flatMap((m) => m.images).slice(-vision.maxImages);
    const results = await Promise.allSettled(urls.map((url) => downloadImage(url, vision.maxImageMB * 1024 * 1024)));
    const dataUrls = [];
    for (const r of results) {
      if (r.status === 'fulfilled') dataUrls.push(r.value);
      else console.error(`image download failed: ${r.reason.message}`);
    }
    const failed = results.length - dataUrls.length;
    const note = failed ? `\n（有 ${failed} 张图片加载失败）` : '';
    if (!dataUrls.length) return text + note;
    return [{ type: 'text', text: text + note }, ...dataUrls.map((url) => ({ type: 'image_url', image_url: { url } }))];
  }

  // The context holds text only; this turn's entry is swapped for the version carrying images.
  messages(conv, content) {
    return [{ role: 'system', content: this.systemPrompt(conv) }, ...conv.context.slice(0, -1), { role: 'user', content }];
  }

  systemPrompt(conv) {
    const { bot, group, timezone } = this.config;
    const lines = [bot.systemPrompt];
    if (bot.name) lines.push(`你的名字是「${bot.name}」。`);
    lines.push(`当前时间：${formatTime(Date.now(), timezone)}（${timezone}）。`);
    if (conv.isGroup) {
      lines.push(`你在 QQ 群 ${conv.targetId} 里（会话 ID：${conv.key}）。群消息的格式是"昵称(QQ号)：内容"，"@你"表示有人提到了你。你每次看到的是一批新消息。`);
      if (group.reply === 'auto') {
        lines.push(`只有在有人 @ 你、叫你的名字、明确向你提问，或者你确实有很有价值的内容可以补充时才发言；被 @ 时一定要回复。其他情况只输出 ${NO_REPLY}，不要输出任何别的内容。`);
      }
      lines.push('发言时直接说你要说的话，不要加"昵称："这样的前缀。');
    } else {
      lines.push(`你正在和 QQ 用户 ${conv.targetId} 私聊（会话 ID：${conv.key}）。`);
    }
    if (conv.memory) lines.push(`以下是你对这个会话的长期记忆（由较早的聊天整理而来）：\n${conv.memory}`);
    return lines.join('\n');
  }

  reply(conv, text, quoteId, { remember = true } = {}) {
    const message = [
      ...(quoteId != null ? [{ type: 'reply', data: { id: String(quoteId) } }] : []),
      { type: 'text', data: { text } },
    ];
    const target = conv.isGroup ? { group_id: conv.targetId } : { user_id: conv.targetId };
    this.onebot.send(conv.isGroup ? 'send_group_msg' : 'send_private_msg', { ...target, message });
    this.store.appendLog(conv.key, { time: new Date().toISOString(), user_id: this.selfId, name: this.config.bot.name || '我', text, self: true });
    if (remember) conv.context.push({ role: 'assistant', content: text });
  }

  compress(conv) {
    return compressIfNeeded(conv, { llm: this.config.llm, memory: this.config.memory, store: this.store });
  }
}
