// Test harness: a mock NapCat (OneBot 11 WebSocket server), a mock OpenAI-compatible endpoint and a mock image CDN,
// all on one local HTTP server, plus helpers to run the bridge against them with a temporary config.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
export async function startMocks({ llm = () => chat('好的'), files = {} } = {}) {
  const state = { llmCalls: [], llmSizes: [], actions: [], connections: [], fileHits: [], sockets: [], getMsg: {}, inFlight: 0, maxInFlight: 0 };
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
      if (request.action !== 'get_msg') return state.actions.push(request);
      const found = state.getMsg[request.params.message_id];
      ws.send(JSON.stringify(found
        ? { status: 'ok', retcode: 0, data: found, echo: request.echo }
        : { status: 'failed', retcode: 1400, message: 'not found', echo: request.echo }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  state.port = server.address().port;
  state.url = (path) => `http://127.0.0.1:${state.port}${path}`;
  state.send = (event) => state.sockets.at(-1).send(JSON.stringify(event));
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
export function message(type, text, { at = false, id, groupId, userId = 42, name = 'Alice', extra = [] } = {}) {
  return {
    post_type: 'message',
    message_type: type,
    self_id: SELF_ID,
    message_id: id,
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

export function readJsonl(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
