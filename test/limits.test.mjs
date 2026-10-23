// Keeping requests bounded: bursts, size-based compression, recovery from rejected requests, concurrency.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { chat, lastUserText, message, quotedId, readJsonl, replyText, sleep, startBridge, startMocks, waitUntil, writeConfig } from './helpers.mjs';

const isCompression = (body) => body.messages[0].content.startsWith('你负责整理');

test('a burst during a slow request is cut to the newest messages, keeping the @-mention, and nothing gets stuck', async (t) => {
  const mocks = await startMocks({
    llm: async (body, n) => {
      if (n === 1) await sleep(1500); // the first request is slow
      return lastUserText(body).includes('@你') ? chat('在的') : chat('[NO_REPLY]');
    },
  });
  t.after(mocks.close);
  await startBridge(t, mocks, writeConfig(mocks, { group: { allow: [777] }, memory: { maxBatchMessages: 30 } }));

  mocks.send(message('group', '第一条', { id: 1, groupId: 777 }));
  await waitUntil(() => mocks.llmCalls.length === 1);
  for (let i = 0; i < 100; i++) {
    // message 110 @-mentions the bot early in the burst
    mocks.send(message('group', `刷屏 ${i}`, { id: 100 + i, groupId: 777, at: i === 10 }));
  }
  await waitUntil(() => mocks.actions.length === 1);

  const lines = lastUserText(mocks.llmCalls[1]).split('\n');
  assert.equal(lines[0], '（期间还有 70 条较早的消息已省略）');
  assert.equal(lines.length, 31);
  assert.equal(lines[1], 'Alice(42)：@你刷屏 10', 'the mention is kept even though it is old');
  assert.equal(lines.at(-1), 'Alice(42)：刷屏 99');
  assert.equal(quotedId(mocks.actions[0]), '110');
  assert.equal(replyText(mocks.actions[0]), '在的');

  mocks.send(message('group', ' 还在吗', { id: 300, groupId: 777, at: true }));
  await waitUntil(() => mocks.actions.length === 2);
  assert.equal(replyText(mocks.actions[1]), '在的');
});

test('compression also starts when the context is too long in characters, not only in entries', async (t) => {
  const mocks = await startMocks({ llm: (body) => (isCompression(body) ? chat('摘要') : chat('好')) });
  t.after(mocks.close);
  await startBridge(t, mocks, writeConfig(mocks, { memory: { maxContextMessages: 40, maxContextChars: 300, keepRecentMessages: 10 } }));

  // three 100-character messages: 6 entries, far below 40, but 303 characters > 300
  for (let n = 1; n <= 3; n++) {
    mocks.send(message('private', `${n}`.repeat(100), { id: n }));
    await waitUntil(() => mocks.actions.length === n);
  }
  await waitUntil(() => mocks.llmCalls.some(isCompression));
  // the first request after compression carries at most half the character budget of context
  mocks.send(message('private', '下一条', { id: 4 }));
  await waitUntil(() => mocks.actions.length === 4);
  const next = mocks.llmCalls.findLast((b) => !isCompression(b));
  const contextChars = next.messages.slice(1, -1).reduce((sum, m) => sum + m.content.length, 0);
  assert.ok(contextChars <= 150, `context is ${contextChars} characters`);
  assert.match(next.messages[0].content, /摘要/);
});

test('a request the model rejects is retried with a shorter context, so the conversation recovers', async (t) => {
  const LIMIT = 2500; // the model's real limit, far below what maxContextChars allows
  const mocks = await startMocks({
    llm: (_body, _n, size) => (size > LIMIT ? { status: 400, text: 'context length exceeded' } : chat('ok')),
  });
  t.after(mocks.close);
  await startBridge(t, mocks, writeConfig(mocks, { memory: { maxContextChars: 100000, maxMessageChars: 1000 } }));
  const ask = async (n) => {
    mocks.send(message('private', 'a'.repeat(800), { id: n }));
    await waitUntil(() => mocks.actions.length === n);
  };

  await ask(1);
  await ask(2);
  const before = mocks.llmCalls.length;
  await ask(3); // the context is now over the model's limit
  const attempts = mocks.llmSizes.slice(before);
  assert.equal(attempts.length, 3, 'rejected, rejected after the first trim, accepted with only this batch');
  assert.ok(attempts[0] > LIMIT && attempts[1] > LIMIT && attempts[2] <= LIMIT);
  assert.equal(replyText(mocks.actions[2]), 'ok', 'the user gets a normal answer, not an error');
  assert.deepEqual(mocks.llmCalls.at(-1).messages.map((m) => m.role), ['system', 'user']);

  const beforeNext = mocks.llmCalls.length;
  await ask(4);
  assert.equal(mocks.llmCalls.length - beforeNext, 1, 'the next message goes through at once');
});

test('long messages and long batches are cut in the context, while the log keeps them whole', async (t) => {
  const mocks = await startMocks({ llm: () => chat('好') });
  t.after(mocks.close);
  const config = writeConfig(mocks, { group: { reply: 'mention' }, memory: { maxMessageChars: 50, maxContextChars: 400 } });
  await startBridge(t, mocks, config);

  mocks.send(message('private', 'x'.repeat(200), { id: 1 }));
  await waitUntil(() => mocks.actions.length === 1);
  assert.equal(lastUserText(mocks.llmCalls[0]), `${'x'.repeat(50)}…（过长已截断）`);
  assert.equal(readJsonl(join(dirname(config), 'data/logs/private-42.jsonl'))[0].text.length, 200);

  // ten 50-character group lines plus a mention, all in one batch: cut to the newest 200 characters
  for (let i = 0; i < 10; i++) mocks.send(message('group', `${i}`.repeat(50), { id: 10 + i, groupId: 777 }));
  mocks.send(message('group', ' 总结一下', { id: 30, groupId: 777, at: true }));
  await waitUntil(() => mocks.actions.length === 2);
  const batch = lastUserText(mocks.llmCalls[1]);
  assert.ok(batch.startsWith('…（前文过长已截断）\n'));
  assert.ok(batch.endsWith('Alice(42)：@你 总结一下'));
  assert.ok(batch.length <= 200 + '…（前文过长已截断）\n'.length);
});

test('while the model keeps failing, the group context still stays bounded', async (t) => {
  const mocks = await startMocks({ llm: () => ({ status: 500, text: 'down' }) }); // compression fails too
  t.after(mocks.close);
  await startBridge(t, mocks, writeConfig(mocks, {
    group: { debounceSeconds: 0.05 },
    memory: { maxContextMessages: 4, keepRecentMessages: 2 },
  }));

  for (let i = 0; i < 12; i++) {
    const before = mocks.llmCalls.length;
    mocks.send(message('group', `第 ${i} 条`, { id: i, groupId: 777 }));
    await waitUntil(() => mocks.llmCalls.length > before);
  }
  const chats = mocks.llmCalls.filter((b) => !isCompression(b));
  const longest = Math.max(...chats.map((b) => b.messages.length - 1));
  assert.ok(longest <= 4 * 2 + 1, `a request carried ${longest} context entries`);
  assert.equal(mocks.actions.length, 0, 'failures in a group without @ stay quiet');
});

for (const max of [1, 2]) {
  test(`llm.maxConcurrentRequests = ${max} caps simultaneous model requests across conversations`, async (t) => {
    const mocks = await startMocks({
      llm: async () => {
        await sleep(300);
        return chat('好');
      },
    });
    t.after(mocks.close);
    await startBridge(t, mocks, writeConfig(mocks, { llm: { maxConcurrentRequests: max } }));
    for (const userId of [42, 43, 44]) mocks.send(message('private', '你好', { id: userId, userId }));
    await waitUntil(() => mocks.actions.length === 3);
    assert.equal(mocks.maxInFlight, max);
  });
}
