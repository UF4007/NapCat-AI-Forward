import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { chat, lastUserText, message, quotedId, readJsonl, replyText, sleep, startBridge, startMocks, waitUntil, writeConfig } from './helpers.mjs';

const group = (text, id, opts = {}) => message('group', text, { id, groupId: 777, ...opts });

test('auto mode: batches messages, the model decides whether to speak, @ is answered right away', async (t) => {
  const mocks = await startMocks({
    llm: (body) => {
      const text = lastUserText(body);
      if (text.includes('@你')) return chat('我在');
      if (text.includes('天气')) return chat('明天晴');
      return chat('[NO_REPLY]');
    },
  });
  t.after(mocks.close);
  const config = writeConfig(mocks, { bot: { name: '小助手' }, group: { allow: [777] } });
  await startBridge(t, mocks, config);

  // messages 100 ms apart (inside the 300 ms debounce) become one batch; the model stays silent
  mocks.send(group('大家好', 1));
  await sleep(100);
  mocks.send(group('中午吃饭了吗', 2, { userId: 43, name: 'Bob' }));
  await sleep(100);
  mocks.send(group('吃了', 3));
  await waitUntil(() => mocks.llmCalls.length === 1);
  assert.equal(lastUserText(mocks.llmCalls[0]), 'Alice(42)：大家好\nBob(43)：中午吃饭了吗\nAlice(42)：吃了');
  const system = mocks.llmCalls[0].messages[0].content;
  assert.match(system, /你的名字是「小助手」/);
  assert.match(system, /只输出 \[NO_REPLY\]/);

  // a group outside the allow-list is ignored entirely
  mocks.send(message('group', '明天天气怎么样', { id: 9, groupId: 888 }));
  await sleep(600);
  assert.equal(mocks.llmCalls.length, 1);
  assert.equal(mocks.actions.length, 0, 'silence means nothing is sent');

  // the model chooses to speak: sent without quoting anyone
  mocks.send(group('明天天气怎么样', 4, { userId: 43, name: 'Bob' }));
  await waitUntil(() => mocks.actions.length === 1);
  assert.equal(mocks.actions[0].action, 'send_group_msg');
  assert.equal(mocks.actions[0].params.group_id, 777);
  assert.equal(replyText(mocks.actions[0]), '明天晴');
  assert.equal(quotedId(mocks.actions[0]), undefined);

  // an @ is handled immediately and quoted
  const before = Date.now();
  mocks.send(group(' 在吗', 5, { at: true }));
  await waitUntil(() => mocks.actions.length === 2);
  assert.ok(Date.now() - before < 300, 'no debounce for @-mentions');
  assert.equal(replyText(mocks.actions[1]), '我在');
  assert.equal(quotedId(mocks.actions[1]), '5');
  assert.deepEqual(mocks.llmCalls[2].messages.slice(1), [
    { role: 'user', content: 'Alice(42)：大家好\nBob(43)：中午吃饭了吗\nAlice(42)：吃了' }, // silence leaves no assistant turn
    { role: 'user', content: 'Bob(43)：明天天气怎么样' },
    { role: 'assistant', content: '明天晴' },
    { role: 'user', content: 'Alice(42)：@你 在吗' },
  ]);

  const dir = dirname(config);
  assert.equal(readJsonl(join(dir, 'data/logs/group-777.jsonl')).length, 7, '5 messages + 2 replies');
  assert.ok(!existsSync(join(dir, 'data/logs/group-888.jsonl')), 'not-allowed groups are not logged');
});

test('mention mode: listens to everything but only answers @-mentions', async (t) => {
  const mocks = await startMocks({ llm: () => chat('收到') });
  t.after(mocks.close);
  await startBridge(t, mocks, writeConfig(mocks, { group: { reply: 'mention' } }));

  mocks.send(group('今晚八点开会', 1));
  mocks.send(group('好的', 2, { userId: 43, name: 'Bob' }));
  await sleep(700);
  assert.equal(mocks.llmCalls.length, 0);

  mocks.send(group(' 几点开会？', 3, { at: true, userId: 44, name: 'Carol' }));
  await waitUntil(() => mocks.actions.length === 1);
  assert.equal(quotedId(mocks.actions[0]), '3');
  const [system, ...rest] = mocks.llmCalls[0].messages;
  assert.doesNotMatch(system.content, /NO_REPLY/);
  assert.deepEqual(rest, [
    { role: 'user', content: 'Alice(42)：今晚八点开会\nBob(43)：好的' },
    { role: 'user', content: 'Carol(44)：@你 几点开会？' },
  ]);
});
