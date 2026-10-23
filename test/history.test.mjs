// Unit tests for reading history through NapCat, with a fake OneBot connection.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historyPages, recentRecords } from '../src/history.mjs';

const msg = (id, time, userId = 1) => ({ message_id: id, time, user_id: userId, self_id: 10000, sender: { nickname: `u${userId}` }, message: [{ type: 'text', data: { text: `m${id}` } }] });

// A fake connection that answers history calls from a list of responses (an Error is thrown).
function fakeOneBot(responses) {
  const calls = [];
  return {
    calls,
    async call(action, params) {
      calls.push({ action, params });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { messages: next };
    },
  };
}

const collect = async (pages) => {
  const out = [];
  for await (const page of pages) out.push(page.map((r) => r.messageId));
  return out;
};

test('historyPages: pages backwards from the oldest message, dropping the repeated anchor', async () => {
  const onebot = fakeOneBot([[msg(3, 30), msg(4, 40)], [msg(1, 10), msg(2, 20), msg(3, 30)], [msg(1, 10)]]);
  assert.deepEqual(await collect(historyPages(onebot, 'group-777', 3)), [[3, 4], [1, 2]]);
  assert.deepEqual(onebot.calls.map((c) => [c.action, c.params.group_id, c.params.message_seq]), [
    ['get_group_msg_history', '777', undefined], ['get_group_msg_history', '777', '3'], ['get_group_msg_history', '777', '1'],
  ]);
});

test('historyPages: an error after the first page means the start of history; on the first page it is real', async () => {
  const ended = fakeOneBot([[msg(2, 20)], new Error('消息2不存在')]);
  assert.deepEqual(await collect(historyPages(ended, 'private-42')), [[2]]);
  assert.equal(ended.calls[0].action, 'get_friend_msg_history');

  const broken = fakeOneBot([new Error('not connected')]);
  await assert.rejects(collect(historyPages(broken, 'private-42')), /not connected/);
  await assert.rejects(collect(historyPages(broken, '../etc')), /invalid conversation id/);
});

test('recentRecords: the messages just before the given one, never it or anything newer', async () => {
  const page = [msg(1, 10), msg(2, 20, 10000), msg(3, 30), msg(4, 30)];
  const records = await recentRecords(fakeOneBot([page]), 'group-777', 5, { message_id: 3, time: 30 });
  assert.deepEqual(records.map((r) => [r.messageId, r.self, r.text]), [[1, false, 'm1'], [2, true, 'm2']]);
  // when the message is not in the page, fall back to time: strictly earlier only
  const byTime = await recentRecords(fakeOneBot([page]), 'group-777', 5, { message_id: 99, time: 30 });
  assert.deepEqual(byTime.map((r) => r.messageId), [1, 2]);
  assert.deepEqual((await recentRecords(fakeOneBot([page]), 'group-777', 1, { message_id: 99, time: 31 })).map((r) => r.messageId), [4]);
});
