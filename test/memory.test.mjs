import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { chat, lastUserText, listFiles, message, sleep, startBridge, startMocks, waitUntil, writeConfig } from './helpers.mjs';

const isCompression = (body) => body.messages[0].content.startsWith('你负责整理');
const isShortening = (body) => body.messages[0].content.startsWith('你负责精简');
const NOW = '现在是 \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}（Asia/Shanghai）。';
const readOr = (file, fallback) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
};

test('memory: a long context is compressed into the memory file, and both survive a restart', async (t) => {
  const mocks = await startMocks({
    llm: (body) => (isCompression(body) ? chat('- 对方喜欢猫') : chat(`回答:${lastUserText(body)}`)),
  });
  t.after(mocks.close);
  const config = writeConfig(mocks, { memory: { maxContextMessages: 4, keepRecentMessages: 2, maxMemoryChars: 100 } });
  const memoryFile = join(dirname(config), 'data/memory/private-42.md');
  const bridge = await startBridge(t, mocks, config);
  const ask = async (text, n) => {
    mocks.send(message('private', text, { id: n }));
    await waitUntil(() => mocks.actions.length === n);
  };
  const chats = () => mocks.llmCalls.filter((b) => !isCompression(b));

  await ask('我喜欢猫', 1);
  await ask('你呢', 2);
  assert.equal(mocks.llmCalls.length, 2, '4 context messages: not over the limit yet');

  await ask('再见', 3); // 6 messages > 4: the oldest 4 are folded into memory
  await waitUntil(() => mocks.llmCalls.some(isCompression));
  const compression = mocks.llmCalls.find(isCompression);
  assert.match(compression.messages[0].content, /不超过 100 字/);
  assert.match(compression.messages[0].content, /"对方"就是和你私聊的那个人/);
  assert.match(compression.messages[1].content,
    new RegExp(`^${NOW}\n\n已有记忆：\n（无）\n\n新的聊天记录：\n【\\d{4}-\\d{2}-\\d{2}】\n对方：我喜欢猫\n你：回答:我喜欢猫\n对方：你呢\n你：回答:你呢$`));
  await waitUntil(() => readOr(memoryFile, '') === '- 对方喜欢猫\n');

  await ask('还记得吗', 4);
  const fourth = chats()[3].messages;
  assert.match(fourth[0].content, /长期记忆[\s\S]*- 对方喜欢猫/);
  assert.deepEqual(fourth.slice(1).map((m) => m.content), ['再见', '回答:再见', '还记得吗']);

  // after a restart, memory comes from the file and recent context from QQ's history (via NapCat)
  await bridge.stop();
  const historyCallsBefore = mocks.historyCalls.length;
  await startBridge(t, mocks, config);
  await ask('重启了', 5);
  assert.equal(mocks.historyCalls.length, historyCallsBefore + 1);
  const fifth = chats()[4].messages;
  assert.match(fifth[0].content, /- 对方喜欢猫/);
  assert.deepEqual(fifth.slice(1).map((m) => m.content), ['还记得吗', '回答:还记得吗', '重启了']);
  assert.deepEqual(listFiles(join(dirname(config), 'data')), ['memory/private-42.md'], 'only the memory file is written');
});

test('memory: the transcript is grouped by date, and the prompt keeps lasting facts while old events fade', async (t) => {
  const mocks = await startMocks({ llm: (body) => (isCompression(body) ? chat('- 记忆') : chat('好')) });
  t.after(mocks.close);
  await startBridge(t, mocks, writeConfig(mocks, {
    group: { reply: 'mention', allow: [777], debounceSeconds: 0.05 },
    memory: { maxContextMessages: 3, keepRecentMessages: 1 },
  }));
  const days = [['2026-10-19T02:00:00Z', '19 日的事'], ['2026-10-20T01:00:00Z', '20 日上午'], ['2026-10-20T03:00:00Z', '20 日中午'], ['2026-10-21T02:00:00Z', '21 日的事']];
  for (const [i, [iso, text]] of days.entries()) {
    mocks.send(message('group', text, { id: i + 1, groupId: 777, time: Date.parse(iso) / 1000 }));
    await sleep(300); // one batch each
  }
  await waitUntil(() => mocks.llmCalls.some(isCompression));
  const [system, user] = mocks.llmCalls.find(isCompression).messages;
  assert.match(user.content, new RegExp(`^${NOW}\n\n已有记忆：\n（无）\n\n新的聊天记录：\n`
    + '【2026-10-19】\nAlice\\(42\\)：19 日的事\n【2026-10-20】\nAlice\\(42\\)：20 日上午\nAlice\\(42\\)：20 日中午$'));
  for (const rule of ['## 人物与长期事实', '不因为时间久远而删减', '## 近期经过', '按日期从近到远', '越久远越简略', '先删减最久远的经过']) {
    assert.ok(system.content.includes(rule), rule);
  }
  assert.doesNotMatch(system.content, /共用|私聊的那个人/);
});

// 219 characters: lasting facts first, then events from newest to oldest
const LONG = ['## 人物与长期事实', '- 小明（10001）：程序员，喜欢猫', '## 近期经过', ...Array.from({ length: 10 }, (_, i) => `- 10-${21 - i}：发生了第 ${i + 1} 件事`)].join('\n');
const CUT = LONG.split('\n').slice(0, 6).join('\n'); // the whole lines that fit in 100 characters, up to 10-19
const SHORT = '## 人物与长期事实\n- 小明：喜欢猫';

for (const [how, shorten, expected] of [
  ['shortened by the model', () => chat(SHORT), SHORT],
  ['cut at a line break when the model makes it no shorter', () => chat(`${LONG}\n- 多出来的一行`), CUT],
  ['cut at a line break when shortening fails', () => ({ status: 500, text: 'down' }), CUT],
]) {
  test(`memory: a summary over maxMemoryChars is ${how}`, async (t) => {
    const mocks = await startMocks({ llm: (body) => (isCompression(body) ? chat(LONG) : isShortening(body) ? shorten() : chat('好')) });
    t.after(mocks.close);
    const config = writeConfig(mocks, { memory: { maxContextMessages: 4, keepRecentMessages: 2, maxMemoryChars: 100 } });
    await startBridge(t, mocks, config);
    for (let n = 1; n <= 3; n++) {
      mocks.send(message('private', `第 ${n} 条`, { id: n }));
      await waitUntil(() => mocks.actions.length === n);
    }
    await waitUntil(() => readOr(join(dirname(config), 'data/memory/private-42.md'), '') === `${expected}\n`);
    const [system, user] = mocks.llmCalls.find(isShortening).messages;
    assert.match(system.content, /它现在有 219 字，超过了 100 字的上限/);
    assert.equal(user.content, LONG);

    mocks.send(message('private', '第 4 条', { id: 4 }));
    await waitUntil(() => mocks.actions.length === 4);
    assert.ok(mocks.llmCalls.at(-1).messages[0].content.endsWith(`\n${expected}`), 'the next request carries the limited memory');
  });
}

test('memory: a memory file longer than maxMemoryChars is cut when it is loaded', async (t) => {
  const mocks = await startMocks({ llm: () => chat('好') });
  t.after(mocks.close);
  const config = writeConfig(mocks, { memory: { maxMemoryChars: 100 } });
  mkdirSync(join(dirname(config), 'data/memory'), { recursive: true });
  writeFileSync(join(dirname(config), 'data/memory/private-42.md'), `${LONG}\n`); // e.g. edited by hand
  await startBridge(t, mocks, config);
  mocks.send(message('private', '你好', { id: 1 }));
  await waitUntil(() => mocks.actions.length === 1);
  assert.ok(mocks.llmCalls[0].messages[0].content.endsWith(`长期记忆（由较早的聊天整理而来）：\n${CUT}`));
});
