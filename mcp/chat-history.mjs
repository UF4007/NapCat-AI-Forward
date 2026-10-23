#!/usr/bin/env node
// MCP server (stdio) that searches the chat logs the bridge writes to <dataDir>/logs.
// Usage: node mcp/chat-history.mjs [path/to/config.json]   (defaults to ./config.json)
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { loadConfig } from '../src/config.mjs';
import { formatTime, searchLogs } from '../src/store.mjs';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const config = loadConfig(process.argv[2] || 'config.json');
const logsDir = join(config.dataDir, 'logs');

const TOOL = {
  name: 'search_chat_history',
  description: '搜索 QQ 聊天记录。可按关键词、发送者 QQ 号和时间范围筛选，返回最新的匹配消息（按时间先后排列）。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '关键词，用空格分隔，全部包含才算匹配；留空表示不按内容筛选' },
      conversation: { type: 'string', description: '会话 ID，例如 group-123456 或 private-10001；留空表示搜索全部会话' },
      user_id: { type: 'string', description: '只看这个 QQ 号发送的消息' },
      since: { type: 'string', description: '起始时间（ISO 8601，带时区，例如 2026-10-22T20:00:00+08:00）' },
      until: { type: 'string', description: '结束时间（ISO 8601，带时区）' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回多少条，默认 20' },
    },
  },
};

function search(args) {
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  const { total, records } = searchLogs(logsDir, {
    conversation: args.conversation || undefined,
    query: args.query || '',
    userId: args.user_id || undefined,
    since: args.since || undefined,
    until: args.until || undefined,
    limit,
  });
  if (!total) return '没有找到匹配的聊天记录。';
  const lines = records.map((r) => {
    const where = args.conversation ? '' : `[${r.conversation}] `;
    return `${where}[${formatTime(r.time, config.timezone)}] ${r.name}(${r.user_id})${r.self ? '（你）' : ''}：${r.text}`;
  });
  return `共找到 ${total} 条，显示最新的 ${records.length} 条（时区 ${config.timezone}）：\n${lines.join('\n')}`;
}

function handle(method, params = {}) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'napcat-ai-forward-chat-history', version: '0.2.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: [TOOL] };
    case 'tools/call': {
      if (params.name !== TOOL.name) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { code: -32602 });
      try {
        return { content: [{ type: 'text', text: search(params.arguments || {}) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (msg.id == null || !msg.method) return; // notifications and stray responses need no answer
  try {
    send({ id: msg.id, result: handle(msg.method, msg.params) });
  } catch (e) {
    send({ id: msg.id, error: { code: e.code || -32603, message: e.message } });
  }
});
rl.on('close', () => process.exit(0));
