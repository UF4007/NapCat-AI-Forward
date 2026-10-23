import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { chat, image, lastUserText, message, quotedId, readJsonl, replyText, startBridge, startMocks, waitUntil, writeConfig } from './helpers.mjs';

test('private chat: replies with context, /reset clears it, everything is logged', async (t) => {
  const mocks = await startMocks({ llm: (body) => chat(`<think>推理</think>回答:${lastUserText(body)}`) });
  t.after(mocks.close);
  const config = writeConfig(mocks, { onebot: { token: 'secret' } });
  await startBridge(t, mocks, config);
  assert.equal(mocks.connections[0].searchParams.get('access_token'), 'secret');

  // vision is off: the image becomes a placeholder and is never downloaded
  mocks.send(message('private', '你好', { id: 1, extra: [image(mocks.url('/never.jpg'))] }));
  await waitUntil(() => mocks.actions.length === 1);
  assert.equal(mocks.actions[0].action, 'send_private_msg');
  assert.equal(mocks.actions[0].params.user_id, 42);
  assert.equal(quotedId(mocks.actions[0]), '1');
  assert.equal(replyText(mocks.actions[0]), '回答:你好[图片]'); // <think> stripped
  assert.deepEqual(mocks.fileHits, []);

  mocks.send(message('private', '再问', { id: 2 }));
  await waitUntil(() => mocks.actions.length === 2);
  const second = mocks.llmCalls[1].messages;
  assert.match(second[0].content, /私聊（会话 ID：private-42）/);
  assert.deepEqual(second.slice(1), [
    { role: 'user', content: '你好[图片]' },
    { role: 'assistant', content: '回答:你好[图片]' },
    { role: 'user', content: '再问' },
  ]);

  mocks.send(message('private', '/reset', { id: 3 }));
  await waitUntil(() => mocks.actions.length === 3);
  assert.equal(replyText(mocks.actions[2]), '上下文已清空。');
  mocks.send(message('private', '新问题', { id: 4 }));
  await waitUntil(() => mocks.actions.length === 4);
  assert.equal(mocks.llmCalls.length, 3, '/reset does not call the model');
  assert.deepEqual(mocks.llmCalls[2].messages.map((m) => m.role), ['system', 'user']);

  const log = readJsonl(join(dirname(config), 'data/logs/private-42.jsonl'));
  assert.deepEqual(log.map((r) => [r.self ? 'bot' : r.user_id, r.text]), [
    [42, '你好[图片]'], ['bot', '回答:你好[图片]'],
    [42, '再问'], ['bot', '回答:再问'],
    [42, '/reset'], ['bot', '上下文已清空。'],
    [42, '新问题'], ['bot', '回答:新问题'],
  ]);
});

test('private chat: reports LLM errors without keeping the failed question, and reconnects after a drop', async (t) => {
  const mocks = await startMocks({ llm: (_body, n) => (n === 1 ? { status: 500, text: 'upstream boom' } : chat('好的')) });
  t.after(mocks.close);
  await startBridge(t, mocks, writeConfig(mocks));

  mocks.send(message('private', '第一问', { id: 1 }));
  await waitUntil(() => mocks.actions.length === 1);
  assert.match(replyText(mocks.actions[0]), /^出错了：HTTP 500/);

  mocks.sockets[0].close();
  await waitUntil(() => mocks.connections.length === 2, 15_000); // the bridge waits 5 s before reconnecting
  mocks.send(message('private', '第二问', { id: 2 }));
  await waitUntil(() => mocks.actions.length === 2);
  assert.equal(replyText(mocks.actions[1]), '好的');
  assert.deepEqual(mocks.llmCalls[1].messages.slice(1), [{ role: 'user', content: '第二问' }]);
});
