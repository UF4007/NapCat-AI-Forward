import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { chat, lastUserText, listFiles, message, startBridge, startMocks, waitUntil, writeConfig } from './helpers.mjs';

const isCompression = (body) => body.messages[0].content.startsWith('你负责整理');

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
  assert.equal(compression.messages[1].content, '已有记忆：\n（无）\n\n新的聊天记录：\n对方：我喜欢猫\n你：回答:我喜欢猫\n对方：你呢\n你：回答:你呢');
  await waitUntil(() => {
    try {
      return readFileSync(memoryFile, 'utf8') === '- 对方喜欢猫\n';
    } catch {
      return false;
    }
  });

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
