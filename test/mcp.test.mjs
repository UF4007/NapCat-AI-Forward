import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpClient } from '../src/mcp-client.mjs';
import { chat, message, replyText, ROOT, startBridge, startMocks, toolCalls, waitUntil, writeConfig } from './helpers.mjs';

const SERVER = join(ROOT, 'mcp/chat-history.mjs');
const textOf = (result) => result.content.map((c) => c.text).join('\n');

// A data dir with logs for two groups; returns the config path the chat-history server reads.
function seedLogs(dir = mkdtempSync(join(tmpdir(), 'naf-mcp-')), extraConfig = {}) {
  mkdirSync(join(dir, 'data/logs'), { recursive: true });
  const write = (name, records) => writeFileSync(join(dir, 'data/logs', name), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  write('group-777.jsonl', [
    { time: '2026-10-20T12:00:00.000Z', message_id: 1, user_id: 1, name: '小红', text: '下周三是小明的生日' },
    { time: '2026-10-21T12:00:00.000Z', message_id: 2, user_id: 2, name: '小刚', text: '生日蛋糕我来订' },
    { time: '2026-10-21T13:00:00.000Z', message_id: 3, user_id: 1, name: '小红', text: '今天吃什么' },
  ]);
  write('group-888.jsonl', [{ time: '2026-10-21T12:30:00.000Z', message_id: 4, user_id: 3, name: '路人', text: '888 群的生日秘密' }]);
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ timezone: 'Asia/Shanghai', dataDir: join(dir, 'data'), ...extraConfig }));
  return config;
}

test('chat-history server: keyword, sender and time filters, scoped to one conversation', async (t) => {
  const client = await McpClient.start('chat_history', { command: process.execPath, args: [SERVER, seedLogs()] });
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name), ['search_chat_history']);

  const birthday = textOf(await client.callTool('search_chat_history', { query: '生日', conversation: 'group-777' }));
  assert.match(birthday, /共找到 2 条/);
  assert.match(birthday, /\[2026-10-20 20:00\] 小红\(1\)：下周三是小明的生日/); // shown in Asia/Shanghai
  assert.match(birthday, /生日蛋糕我来订/);
  assert.doesNotMatch(birthday, /888/);

  assert.match(textOf(await client.callTool('search_chat_history', { conversation: 'group-777', user_id: '2' })), /共找到 1 条[\s\S]*蛋糕/);
  const since = textOf(await client.callTool('search_chat_history', { query: '生日', conversation: 'group-777', since: '2026-10-21T00:00:00+08:00' }));
  assert.match(since, /共找到 1 条[\s\S]*蛋糕/);
  assert.match(textOf(await client.callTool('search_chat_history', { query: '生日' })), /\[group-888\]/, 'no conversation: search everywhere');
  assert.match(textOf(await client.callTool('search_chat_history', { query: '不存在的词' })), /没有找到/);

  const bad = await client.callTool('search_chat_history', { conversation: '../../etc/passwd' });
  assert.equal(bad.isError, true);
});

test('chat-history server works with the official MCP SDK client', async (t) => {
  const client = new Client({ name: 'sdk-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, seedLogs()] }));
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
    llm: (body, n) => {
      if (n === 1) {
        // the model tries to peek into another group
        return toolCalls(['chat_history__search_chat_history', { query: '生日', conversation: 'group-888' }]);
      }
      return chat('小明下周三过生日');
    },
  });
  t.after(mocks.close);
  const dir = mkdtempSync(join(tmpdir(), 'naf-e2e-'));
  seedLogs(dir);
  const config = writeConfig(mocks, {
    group: { reply: 'mention' },
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

  const result = second.messages.find((m) => m.role === 'tool');
  assert.equal(result.tool_call_id, 'call_0');
  assert.match(result.content, /下周三是小明的生日/);
  assert.doesNotMatch(result.content, /888/, 'the search stayed in group-777');
});
