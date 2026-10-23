// conversation.mode "global": every group and private chat shares one context, one memory and one queue.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { chat, lastUserText, listFiles, message, quotedId, replyText, ROOT, SELF_ID, sleep, startBridge, startMocks, toolCalls, waitUntil, writeConfig } from './helpers.mjs';

const GLOBAL = { conversation: { mode: 'global' } };
const isCompression = (body) => body.messages[0].content.startsWith('你负责整理');

test('global: chats share one labelled context, and each reply goes back to the chat it answers', async (t) => {
  const mocks = await startMocks({
    llm: (body) => {
      const text = lastUserText(body);
      if (text.includes('@你')) return chat('[group-888] 我在'); // a copied label must not be sent
      if (text.startsWith('[private-42]')) return chat('私聊收到');
      return chat('[NO_REPLY]');
    },
  });
  t.after(mocks.close);
  const config = writeConfig(mocks, { ...GLOBAL, bot: { name: '小助手' }, group: { allow: [777, 888] } });
  await startBridge(t, mocks, config);

  mocks.send(message('group', '777 群的消息', { id: 1, groupId: 777, userId: 1001, name: '小红' }));
  await waitUntil(() => mocks.llmCalls.length === 1);
  mocks.send(message('group', '888 群的消息', { id: 2, groupId: 888, userId: 1002, name: '小刚' }));
  await waitUntil(() => mocks.llmCalls.length === 2);
  mocks.send(message('private', '私聊的消息', { id: 3 }));
  await waitUntil(() => mocks.actions.length === 1);

  assert.equal(mocks.actions[0].action, 'send_private_msg');
  assert.equal(mocks.actions[0].params.user_id, 42);
  assert.equal(replyText(mocks.actions[0]), '私聊收到');
  const [system, ...context] = mocks.llmCalls[2].messages;
  assert.match(system.content, /所有对话共用这一份上下文/);
  assert.match(system.content, /这批新消息来自 \[private-42\]（和 QQ 用户 42 的私聊），你的回复只会发到那里/);
  assert.doesNotMatch(system.content, /NO_REPLY/, 'a private batch is always answered');
  assert.deepEqual(context.map((m) => m.content), ['[group-777] 小红(1001)：777 群的消息', '[group-888] 小刚(1002)：888 群的消息', '[private-42] Alice(42)：私聊的消息']);

  mocks.send(message('group', ' 在吗', { id: 4, groupId: 888, userId: 1002, name: '小刚', at: true }));
  await waitUntil(() => mocks.actions.length === 2);
  assert.equal(mocks.actions[1].action, 'send_group_msg');
  assert.equal(mocks.actions[1].params.group_id, 888);
  assert.equal(quotedId(mocks.actions[1]), '4');
  assert.equal(replyText(mocks.actions[1]), '我在', 'the copied label is stripped');
  const fourth = mocks.llmCalls[3].messages;
  assert.match(fourth[0].content, /这批新消息来自 \[group-888\]（QQ 群 888）/);
  assert.match(fourth[0].content, /只输出 \[NO_REPLY\]/);
  assert.deepEqual(fourth.at(-2), { role: 'assistant', content: '[private-42] 私聊收到' }, 'what the bot said, and where');
  assert.deepEqual(listFiles(join(dirname(config), 'data')), []);
});

test('global: one queue for everything, so requests never overlap and replies keep arrival order', async (t) => {
  const mocks = await startMocks({
    llm: async (body) => {
      await sleep(300);
      return chat(`回复 ${lastUserText(body).match(/^\[private-(\d+)\]/)[1]}`);
    },
  });
  t.after(mocks.close);
  await startBridge(t, mocks, writeConfig(mocks, { ...GLOBAL, llm: { maxConcurrentRequests: 4 } }));
  for (const userId of [42, 43, 44]) mocks.send(message('private', '你好', { id: userId, userId }));
  await waitUntil(() => mocks.actions.length === 3);
  assert.equal(mocks.maxInFlight, 1);
  assert.deepEqual(mocks.actions.map((a) => [a.params.user_id, replyText(a)]), [[42, '回复 42'], [43, '回复 43'], [44, '回复 44']]);
});

test('global: one memory file for all chats', async (t) => {
  const mocks = await startMocks({ llm: (body) => (isCompression(body) ? chat('- 记忆') : chat('好')) });
  t.after(mocks.close);
  const config = writeConfig(mocks, { ...GLOBAL, memory: { maxContextMessages: 4, keepRecentMessages: 2 } });
  await startBridge(t, mocks, config);
  for (const [n, userId] of [[1, 42], [2, 43], [3, 42]]) {
    mocks.send(message('private', `第 ${n} 条`, { id: n, userId }));
    await waitUntil(() => mocks.actions.length === n);
  }
  await waitUntil(() => mocks.llmCalls.some(isCompression));
  const [system, { content: transcript }] = mocks.llmCalls.find(isCompression).messages;
  assert.match(system.content, /不超过 4000 字/, 'more room by default, as one memory covers every chat');
  assert.match(system.content, /由多个群和私聊共用/);
  assert.match(transcript, /\[private-42\] Alice\(42\)：第 1 条\n你：\[private-42\] 好\n\[private-43\] Alice\(43\)：第 2 条/);
  await waitUntil(() => listFiles(join(dirname(config), 'data')).length === 1);
  assert.deepEqual(listFiles(join(dirname(config), 'data')), ['memory/global.md']);
});

const groupMessage = (groupId, id, iso, userId, name, text) => ({
  post_type: 'message', message_type: 'group', group_id: groupId, self_id: SELF_ID, message_id: id,
  time: Date.parse(iso) / 1000, user_id: userId, sender: { nickname: name, card: '' }, message: [{ type: 'text', data: { text } }],
});

test('global: the model chooses which chat to search, within the allowed ones', async (t) => {
  const mocks = await startMocks({
    llm: (_body, n) => (n === 1
      ? toolCalls(
        ['chat_history__search_chat_history', { query: '秘密', conversation: 'group-888' }],
        ['chat_history__search_chat_history', { query: '秘密', conversation: 'group-999' }],
      )
      : chat('找到了')),
  });
  t.after(mocks.close);
  mocks.history['group-888'] = [groupMessage(888, 500, '2026-10-21T12:30:00Z', 4, '路人', '888 群的秘密')];
  mocks.history['group-999'] = [groupMessage(999, 600, '2026-10-21T12:30:00Z', 5, '外人', '999 群的秘密')];
  const dir = mkdtempSync(join(tmpdir(), 'naf-global-'));
  const config = writeConfig(mocks, {
    ...GLOBAL,
    group: { reply: 'mention', allow: [777, 888] },
    mcpServers: {
      // the MCP server reads the same config file
      chat_history: { command: process.execPath, args: [join(ROOT, 'mcp/chat-history.mjs'), join(dir, 'config.json')], conversationArgument: 'conversation' },
    },
  }, dir);
  await startBridge(t, mocks, config);

  mocks.send(message('group', ' 888 群有什么秘密', { id: 1, groupId: 777, at: true }));
  await waitUntil(() => mocks.actions.length === 1);
  const [first, second] = mocks.llmCalls;
  const tool = first.tools.find((x) => x.function.name === 'chat_history__search_chat_history');
  assert.ok('conversation' in tool.function.parameters.properties, 'in global mode the model names the chat');
  const results = second.messages.filter((m) => m.role === 'tool');
  assert.match(results[0].content, /888 群的秘密/);
  assert.match(results[1].content, /不在配置允许的范围内/);
  assert.doesNotMatch(results[1].content, /999 群的秘密/);
});
