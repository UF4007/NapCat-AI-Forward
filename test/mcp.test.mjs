import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpClient } from '../src/mcp-client.mjs';
import { chat, message, replyText, ROOT, SELF_ID, startBridge, startMocks, toolCalls, waitUntil, writeConfig } from './helpers.mjs';

const SERVER = join(ROOT, 'mcp/chat-history.mjs');
const textOf = (result) => result.content.map((c) => c.text).join('\n');

const groupMessage = (groupId, id, iso, userId, name, text) => ({
  post_type: 'message', message_type: 'group', group_id: groupId, self_id: SELF_ID, message_id: id,
  time: Date.parse(iso) / 1000, user_id: userId, sender: { nickname: name, card: '' }, message: [{ type: 'text', data: { text } }],
});

// QQ history as NapCat would serve it: two relevant messages, then 120 newer ones that a search has to page past.
function seedHistory(mocks) {
  const filler = Array.from({ length: 120 }, (_, i) => groupMessage(
    777, 100 + i, new Date(Date.parse('2026-10-22T00:00:00Z') + i * 60_000).toISOString(), 3, '小李', `今天吃什么 ${i}`,
  ));
  mocks.history['group-777'] = [
    groupMessage(777, 1, '2026-10-20T12:00:00Z', 1, '小红', '下周三是小明的生日'),
    groupMessage(777, 2, '2026-10-21T12:00:00Z', 2, '小刚', '生日蛋糕我来订'),
    ...filler,
  ];
  mocks.history['group-888'] = [groupMessage(888, 500, '2026-10-21T12:30:00Z', 4, '路人', '888 群的生日秘密')];
}

async function startServer(t, overrides = {}) {
  const mocks = await startMocks();
  t.after(mocks.close);
  seedHistory(mocks);
  const config = writeConfig(mocks, { group: { allow: [777] }, ...overrides });
  const client = await McpClient.start('chat_history', { command: process.execPath, args: [SERVER, config] });
  t.after(() => client.close());
  const search = async (args) => client.callTool('search_chat_history', args);
  return { mocks, client, search, config };
}

test('chat-history server: searches QQ history through NapCat, paging back as far as needed', async (t) => {
  const { mocks, client, search } = await startServer(t);
  const tools = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name), ['search_chat_history']);

  const birthday = textOf(await search({ query: '生日', conversation: 'group-777' }));
  assert.match(birthday, /找到 2 条/);
  assert.match(birthday, /\[2026-10-20 20:00\] 小红\(1\)：下周三是小明的生日/); // shown in Asia/Shanghai
  assert.match(birthday, /生日蛋糕我来订/);
  assert.doesNotMatch(birthday, /888/);
  const pages = mocks.historyCalls.map((r) => r.params);
  assert.ok(pages.length >= 3, 'paged back past the 120 newer messages');
  assert.equal(pages[0].message_seq, undefined, 'the first page is the latest messages');
  assert.equal(pages[1].message_seq, '170', 'the next page starts from the oldest message of the previous one');

  assert.match(textOf(await search({ conversation: 'group-777', user_id: '2' })), /找到 1 条[\s\S]*蛋糕/);
  assert.match(textOf(await search({ query: '生日', conversation: 'group-777', since: '2026-10-21T00:00:00+08:00' })), /找到 1 条[\s\S]*蛋糕/);
  const newest = textOf(await search({ query: '生日', conversation: 'group-777', limit: 1 }));
  assert.match(newest, /找到 1 条[\s\S]*只显示最新的这些[\s\S]*蛋糕/);
  assert.match(textOf(await search({ query: '不存在的词', conversation: 'group-777' })), /在查看过的 122 条消息里没有找到/);
});

test('chat-history server: refuses conversations outside the config, and stops at history.maxScanMessages', async (t) => {
  const { search } = await startServer(t, { history: { maxScanMessages: 30 } });
  const other = await search({ query: '生日', conversation: 'group-888' });
  assert.equal(other.isError, true);
  assert.match(textOf(other), /不在配置允许的范围内/);
  assert.equal((await search({ conversation: '../../etc/passwd' })).isError, true);
  assert.equal((await search({ query: '生日' })).isError, true, 'a conversation is required');

  const capped = textOf(await search({ query: '生日', conversation: 'group-777' }));
  assert.match(capped, /在查看过的 30 条消息里没有找到/);
  assert.match(capped, /每次最多查看 30 条/);
});

test('chat-history server writes nothing but JSON-RPC to stdout, even while connecting to NapCat', async (t) => {
  const mocks = await startMocks();
  t.after(mocks.close);
  seedHistory(mocks);
  const child = spawn(process.execPath, [SERVER, writeConfig(mocks)], { stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => child.kill());
  const lines = [];
  createInterface({ input: child.stdout }).on('line', (line) => lines.push(line));
  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'search_chat_history', arguments: { query: '蛋糕', conversation: 'group-777' } } });
  await waitUntil(() => lines.some((l) => l.includes('"id":2')));
  for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, '2.0', `not a JSON-RPC message: ${line}`);
});

test('chat-history server works with the official MCP SDK client', async (t) => {
  const mocks = await startMocks();
  t.after(mocks.close);
  seedHistory(mocks);
  const client = new Client({ name: 'sdk-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, writeConfig(mocks)] }));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.equal(tools[0].name, 'search_chat_history');
  const result = await client.callTool({ name: 'search_chat_history', arguments: { query: '蛋糕', conversation: 'group-777' } });
  assert.match(textOf(result), /生日蛋糕我来订/);
});

test('our MCP client works with a server built on the official SDK', async (t) => {
  const client = await McpClient.start('sdk_echo', { command: process.execPath, args: [join(ROOT, 'test/fixtures/sdk-echo-server.mjs')] });
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name), ['echo']);
  assert.equal(textOf(await client.callTool('echo', { text: '你好' })), 'echo:你好');
});

test('bridge: the model searches chat history through MCP, always within the current conversation', async (t) => {
  const mocks = await startMocks({
    llm: (_body, n) => (n === 1
      // the model tries to peek into another group
      ? toolCalls(['chat_history__search_chat_history', { query: '生日', conversation: 'group-888' }])
      : chat('小明下周三过生日')),
  });
  t.after(mocks.close);
  seedHistory(mocks);
  const dir = mkdtempSync(join(tmpdir(), 'naf-e2e-'));
  const config = writeConfig(mocks, {
    group: { reply: 'mention' }, // every group is allowed, so only the forced argument keeps the search in place
    mcpServers: {
      chat_history: { command: process.execPath, args: [SERVER, join(dir, 'config.json')], conversationArgument: 'conversation' },
    },
  }, dir);
  await startBridge(t, mocks, config);

  mocks.send(message('group', ' 谁要过生日？', { at: true, id: 10, groupId: 777 }));
  await waitUntil(() => mocks.actions.length === 1);
  assert.equal(replyText(mocks.actions[0]), '小明下周三过生日');

  const [first, second] = mocks.llmCalls;
  const tool = first.tools.find((x) => x.function.name === 'chat_history__search_chat_history');
  assert.ok(tool, 'MCP tools are offered to the model');
  assert.ok(!('conversation' in tool.function.parameters.properties), 'the forced argument is hidden from the model');
  assert.ok(!tool.function.parameters.required?.includes('conversation'));

  const result = second.messages.find((m) => m.role === 'tool');
  assert.equal(result.tool_call_id, 'call_0');
  assert.match(result.content, /下周三是小明的生日/);
  assert.doesNotMatch(result.content, /888/, 'the search stayed in group-777');
});
