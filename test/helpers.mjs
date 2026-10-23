// Test harness: a mock NapCat (OneBot 11 WebSocket server), a mock OpenAI-compatible endpoint and a mock image CDN,
// all on one local HTTP server, plus helpers to run the bridge against them with a temporary config.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SELF_ID = 10000;

export const chat = (content) => ({ json: { choices: [{ message: { role: 'assistant', content } }] } });
export const toolCalls = (...calls) => ({
  json: {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: calls.map(([name, args], i) => ({ id: `call_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })),
      },
    }],
  },
});

// The text the model was asked about in this request (text part of the last user message).
export function lastUserText(body) {
  const content = body.messages.findLast((m) => m.role === 'user').content;
  return typeof content === 'string' ? content : content.find((p) => p.type === 'text')?.text ?? '';
}

// llm(body, callNumber) -> response (or a promise of one); files: { path: { type, body } }.
// state.getMsg ({ message_id: data }) answers get_msg and may be filled in after start.
// state.maxInFlight records the most LLM requests that were open at the same time.
// state.history ({ conversation: [OneBot message, oldest first] }) plays QQ's message store: every event sent with
// state.send and every message the bridge sends is appended, and the two history actions read from it.
export async function startMocks({ llm = () => chat('好的'), files = {} } = {}) {
  const state = {
    llmCalls: [], llmSizes: [], actions: [], connections: [], fileHits: [], sockets: [], getMsg: {}, history: {}, historyCalls: [],
    inFlight: 0, maxInFlight: 0,
  };
  let nextId = 900000;
  const remember = (conversation, msg) => (state.history[conversation] ||= []).push(msg);

  // NapCat's get_group_msg_history / get_friend_msg_history: the latest `count` messages, or with message_seq
  // (a message id) the `count` messages up to and including it; an empty result is reported as an error.
  const history = (conversation, { count, message_seq: anchor }) => {
    const list = state.history[conversation] || [];
    const end = anchor == null ? list.length : list.findIndex((m) => String(m.message_id) === String(anchor)) + 1;
    const page = end > 0 ? list.slice(Math.max(0, end - count), end) : [];
    return page.length ? { status: 'ok', retcode: 0, data: { messages: page } } : { status: 'failed', retcode: 1400, message: `消息${anchor}不存在` };
  };

  const answer = (request) => {
    const p = request.params;
    switch (request.action) {
      case 'get_msg': {
        const found = state.getMsg[p.message_id];
        return found ? { status: 'ok', retcode: 0, data: found } : { status: 'failed', retcode: 1400, message: 'not found' };
      }
      case 'get_group_msg_history':
        state.historyCalls.push(request);
        return history(`group-${p.group_id}`, p);
      case 'get_friend_msg_history':
        state.historyCalls.push(request);
        return history(`private-${p.user_id}`, p);
      case 'send_group_msg':
      case 'send_private_msg': {
        state.actions.push(request);
        const isGroup = request.action === 'send_group_msg';
        remember(isGroup ? `group-${p.group_id}` : `private-${p.user_id}`, {
          post_type: 'message', message_type: isGroup ? 'group' : 'private', self_id: SELF_ID, user_id: SELF_ID,
          message_id: nextId++, time: Math.floor(Date.now() / 1000), sender: { nickname: '机器人' }, message: p.message,
          ...(isGroup ? { group_id: p.group_id } : {}),
        });
        return null; // fire and forget
      }
      default:
        state.actions.push(request);
        return null;
    }
  };
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      state.fileHits.push(req.url);
      const file = files[req.url];
      res.writeHead(file ? 200 : 404, { 'Content-Type': file?.type || 'text/plain' });
      return res.end(file?.body || 'not found');
    }
    state.maxInFlight = Math.max(state.maxInFlight, ++state.inFlight);
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    state.llmCalls.push(parsed);
    state.llmSizes.push(body.length);
    const { status = 200, json, text } = await llm(parsed, state.llmCalls.length, body.length);
    state.inFlight--;
    res.writeHead(status, { 'Content-Type': json ? 'application/json' : 'text/plain' });
    res.end(json ? JSON.stringify(json) : text);
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    state.connections.push(new URL(req.url, 'http://mock'));
    state.sockets.push(ws);
    ws.on('message', (data) => {
      const request = JSON.parse(data);
      const response = answer(request);
      if (response && request.echo != null) ws.send(JSON.stringify({ ...response, echo: request.echo }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  state.port = server.address().port;
  state.url = (path) => `http://127.0.0.1:${state.port}${path}`;
  // like NapCat, events go to every connected client (the bridge, and the chat-history MCP server once it connects)
  state.send = (event) => {
    if (event.post_type === 'message') {
      remember(event.message_type === 'group' ? `group-${event.group_id}` : `private-${event.user_id}`, event);
    }
    for (const ws of wss.clients) ws.send(JSON.stringify(event));
  };
  state.close = () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  };
  return state;
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => (isObject(a) && isObject(b) ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, merge(a[k], b[k])])) : b ?? a);

// Writes a config for the mocks (overrides are deep-merged) and returns its path.
export function writeConfig(mocks, overrides = {}, dir = mkdtempSync(join(tmpdir(), 'naf-'))) {
  const config = merge({
    onebot: { url: `ws://127.0.0.1:${mocks.port}/`, token: '' },
    llm: { baseUrl: `http://127.0.0.1:${mocks.port}/v1`, apiKey: 'k', model: 'm' },
    group: { reply: 'auto', debounceSeconds: 0.3, maxWaitSeconds: 3 },
    timezone: 'Asia/Shanghai',
    dataDir: join(dir, 'data'),
  }, overrides);
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

// Starts the bridge, waits for it to connect, and registers cleanup on the test context.
export async function startBridge(t, mocks, configPath) {
  const connectionsBefore = mocks.connections.length;
  const child = spawn(process.execPath, [join(ROOT, 'src/index.mjs'), configPath], { stdio: ['ignore', 'ignore', 'inherit'] });
  const exited = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
  };
  t.after(stop);
  await waitUntil(() => mocks.connections.length > connectionsBefore);
  return { stop };
}

export async function waitUntil(predicate, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the bridge');
    await sleep(20);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// extra: additional segments appended after the text, e.g. images or a reply.
export function message(type, text, { at = false, id, groupId, userId = 42, name = 'Alice', extra = [], time = Math.floor(Date.now() / 1000) } = {}) {
  return {
    post_type: 'message',
    message_type: type,
    self_id: SELF_ID,
    message_id: id,
    time,
    user_id: userId,
    ...(groupId ? { group_id: groupId } : {}),
    sender: { nickname: name, card: '' },
    message: [
      ...(at ? [{ type: 'at', data: { qq: String(SELF_ID) } }] : []),
      ...(text ? [{ type: 'text', data: { text } }] : []),
      ...extra,
    ],
  };
}

export const image = (url, data = {}) => ({ type: 'image', data: { file: 'x.jpg', url, sub_type: 0, ...data } });

export const replyText = (action) => action.params.message.find((s) => s.type === 'text').data.text;
export const quotedId = (action) => action.params.message.find((s) => s.type === 'reply')?.data.id;

// Every file under dir, as paths relative to it (the bridge may only ever write memory files).
export function listFiles(dir) {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
      .map((e) => relative(dir, join(e.parentPath, e.name))).sort();
  } catch {
    return [];
  }
}
