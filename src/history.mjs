// Chat history, read from QQ through NapCat's history actions. Nothing is stored locally.
import { render } from './message.mjs';

export const CONVERSATION_ID = /^(group|private)-(\d+)$/;
const PAGE_SIZE = 50;

export function parseConversation(conversation) {
  const m = CONVERSATION_ID.exec(conversation || '');
  if (!m) throw new Error(`invalid conversation id: ${conversation}`);
  return { isGroup: m[1] === 'group', id: m[2] };
}

// One history message as plain data: { time (ms), messageId, userId, name, text, self }.
export function toRecord(m) {
  return {
    time: m.time * 1000,
    messageId: m.message_id,
    userId: m.user_id,
    name: m.sender?.card || m.sender?.nickname || String(m.user_id),
    text: render(Array.isArray(m.message) ? m.message : [], m.self_id),
    self: String(m.user_id) === String(m.self_id),
  };
}

// Pages of history, newest page first, each in chronological order. A page is fetched backwards from the oldest
// message of the previous one; NapCat includes that anchor again (dropped here) and reports running past the
// first message of the conversation as an error.
export async function* historyPages(onebot, conversation, pageSize = PAGE_SIZE) {
  const { isGroup, id } = parseConversation(conversation);
  const action = isGroup ? 'get_group_msg_history' : 'get_friend_msg_history';
  const target = isGroup ? { group_id: id } : { user_id: id };
  const seen = new Set();
  let anchor;
  for (;;) {
    let data;
    try {
      data = await onebot.call(action, {
        ...target,
        count: pageSize,
        ...(anchor == null ? {} : { message_seq: String(anchor) }),
        parse_mult_msg: false,
        disable_get_url: true,
      }, 30_000);
    } catch (e) {
      if (anchor == null) throw e;
      return;
    }
    const page = (data?.messages || []).filter((m) => !seen.has(m.message_id)).sort((a, b) => a.time - b.time);
    if (!page.length) return;
    for (const m of page) seen.add(m.message_id);
    yield page.map(toRecord);
    anchor = page[0].message_id;
  }
}

// The `count` messages just before `before` (an incoming message event), oldest first.
export async function recentRecords(onebot, conversation, count, before) {
  for await (const page of historyPages(onebot, conversation, count + 5)) {
    const index = page.findIndex((r) => String(r.messageId) === String(before.message_id));
    const earlier = index >= 0 ? page.slice(0, index) : page.filter((r) => r.time < before.time * 1000);
    return earlier.slice(-count);
  }
  return [];
}
