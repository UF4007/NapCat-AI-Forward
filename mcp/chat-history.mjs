#!/usr/bin/env node
// MCP server (stdio) that searches QQ chat history through NapCat. Nothing is kept on disk: each search pages
// backwards through the conversation's history with NapCat's history actions and filters the messages here.
// Usage: node mcp/chat-history.mjs [path/to/config.json]   (defaults to ./config.json)
import { createInterface } from 'node:readline';
import { loadConfig } from '../src/config.mjs';
import { historyPages, parseConversation } from '../src/history.mjs';
import { OneBot } from '../src/onebot.mjs';
import { formatTime } from '../src/time.mjs';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const config = loadConfig(process.argv[2] || 'config.json');
// stdout carries the protocol, so connection messages go to stderr; the connection opens on the first search.
const onebot = new OneBot(config.onebot, { log: console.error });

const TOOL = {
  name: 'search_chat_history',
  description: '搜索 QQ 聊天记录（直接从 QQ 读取）。可按关键词、发送者 QQ 号和时间范围筛选；从最新的消息往前找，返回最新的若干条匹配消息（按时间先后排列）。',
  inputSchema: {
    type: 'object',
    properties: {
      conversation: { type: 'string', description: '会话 ID，例如 group-123456 或 private-10001' },
      query: { type: 'string', description: '关键词，用空格分隔，全部包含才算匹配；留空表示不按内容筛选' },
      user_id: { type: 'string', description: '只看这个 QQ 号发送的消息' },
      since: { type: 'string', description: '起始时间（ISO 8601，带时区，例如 2026-10-22T20:00:00+08:00）' },
      until: { type: 'string', description: '结束时间（ISO 8601，带时区）' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回多少条，默认 20' },
    },
    required: ['conversation'],
  },
};

// Only conversations the bridge itself would answer in may be searched.
function allowed({ isGroup, id }) {
  if (isGroup) return !config.group.allow.length || config.group.allow.includes(id);
  return config.private.enabled && (!config.private.allow.length || config.private.allow.includes(id));
}

async function search(args) {
  const conversation = parseConversation(args.conversation);
  if (!allowed(conversation)) throw new Error(`会话 ${args.conversation} 不在配置允许的范围内`);
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  const keywords = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const since = args.since ? Date.parse(args.since) : -Infinity;
  const until = args.until ? Date.parse(args.until) : Infinity;
  if (Number.isNaN(since) || Number.isNaN(until)) throw new Error('since/until 必须是 ISO 8601 时间，例如 2026-10-22T20:00:00+08:00');
  const { maxScanMessages } = config.history;

  await onebot.ready();
  const matches = [];
  let scanned = 0;
  let capped = false;
  scan: for await (const page of historyPages(onebot, args.conversation)) {
    for (const r of page.reverse()) { // newest first
      if (scanned >= maxScanMessages) {
        capped = true;
        break scan;
      }
      scanned++;
      if (r.time > until) continue;
      if (r.time < since) break scan;
      if (args.user_id && String(r.userId) !== String(args.user_id)) continue;
      if (!keywords.every((k) => `${r.name}\n${r.text}`.toLowerCase().includes(k))) continue;
      matches.push(r);
      if (matches.length >= limit) break scan;
    }
  }

  const more = capped ? `\n更早的消息没有搜索（每次最多查看 ${maxScanMessages} 条），可以用 since/until 缩小时间范围后再查。` : '';
  if (!matches.length) return `在查看过的 ${scanned} 条消息里没有找到匹配的聊天记录。${more}`;
  const lines = matches.reverse().map((r) => `[${formatTime(r.time, config.timezone)}] ${r.name}(${r.userId})${r.self ? '（你）' : ''}：${r.text}`);
  const full = matches.length >= limit ? '，只显示最新的这些，可能还有更早的' : '';
  return `找到 ${matches.length} 条匹配的消息（时区 ${config.timezone}${full}）：\n${lines.join('\n')}${more}`;
}

async function handle(method, params = {}) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'napcat-ai-forward-chat-history', version: '0.3.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: [TOOL] };
    case 'tools/call': {
      if (params.name !== TOOL.name) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { code: -32602 });
      try {
        return { content: [{ type: 'text', text: await search(params.arguments || {}) }] };
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
rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (msg.id == null || !msg.method) return; // notifications and stray responses need no answer
  try {
    send({ id: msg.id, result: await handle(msg.method, msg.params) });
  } catch (e) {
    send({ id: msg.id, error: { code: e.code || -32603, message: e.message } });
  }
});
rl.on('close', () => process.exit(0));
