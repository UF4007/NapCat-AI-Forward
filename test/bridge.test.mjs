// Runs bridge.mjs against a mock NapCat (OneBot 11 WebSocket server) and a mock OpenAI-compatible endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const BRIDGE = fileURLToPath(new URL('../bridge.mjs', import.meta.url));
const SELF_ID = 10000;

// extra: additional segments appended after the text, e.g. images or a reply.
function message(type, text, { at = false, id, groupId, extra = [] } = {}) {
  return {
    post_type: 'message',
    message_type: type,
    self_id: SELF_ID,
    message_id: id,
    user_id: 42,
    ...(groupId ? { group_id: groupId } : {}),
    sender: { nickname: 'Alice', card: '' },
    message: [
      ...(at ? [{ type: 'at', data: { qq: String(SELF_ID) } }] : []),
      ...(text ? [{ type: 'text', data: { text } }] : []),
      ...extra,
    ],
  };
}

const image = (url, data = {}) => ({ type: 'image', data: { file: 'x.jpg', url, sub_type: 0, ...data } });

// One HTTP server plays every role: POST /v1/chat/completions is the LLM, GET serves `files` (the QQ image CDN),
// and WebSocket upgrades are NapCat.
// onLlm(body, callNumber) returns { status?, json? , text? }; onConnection(ws, connectionNumber) drives NapCat's side.
async function startMocks({ onLlm, onConnection, files = {} }) {
  const llmCalls = [];
  const connections = [];
  const fileHits = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      fileHits.push(req.url);
      const file = files[req.url];
      res.writeHead(file ? 200 : 404, { 'Content-Type': file?.type || 'text/plain' });
      return res.end(file?.body || 'not found');
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    llmCalls.push(parsed);
    const { status = 200, json, text } = onLlm(parsed, llmCalls.length);
    res.writeHead(status, { 'Content-Type': json ? 'application/json' : 'text/plain' });
    res.end(json ? JSON.stringify(json) : text);
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    connections.push(new URL(req.url, 'http://mock'));
    onConnection(ws, connections.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const close = () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  };
  return { port: server.address().port, llmCalls, connections, fileHits, close };
}

function startBridge(port, env = {}) {
  return spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      ONEBOT_WS: `ws://127.0.0.1:${port}/`,
      ONEBOT_TOKEN: '',
      LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
      LLM_API_KEY: 'k',
      LLM_MODEL: 'm',
      ALLOW_GROUPS: '',
      ...env,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

async function waitUntil(predicate, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the bridge');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const replyText = (action) => action.params.message[1].data.text;
const repliedTo = (action) => action.params.message[0].data.id;

test('answers private messages and group @-mentions, honours the allow-list and /reset', async (t) => {
  const actions = [];
  let napcat;
  const mocks = await startMocks({
    onLlm: (body) => ({
      json: { choices: [{ message: { role: 'assistant', content: `<think>推理</think>回答:${body.messages.at(-1).content}` } }] },
    }),
    onConnection: (ws) => {
      napcat = ws;
      ws.on('message', (data) => actions.push(JSON.parse(data)));
      ws.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' }));
      ws.send(JSON.stringify(message('group', '没有 @ 我，不该回', { id: 1, groupId: 777 })));
      ws.send(JSON.stringify(message('group', ' 你好', { at: true, id: 2, groupId: 777 })));
      // VISION is off in this test, so the image must be ignored and never downloaded
      ws.send(JSON.stringify(message('private', '私聊问题', { id: 3, extra: [image(`http://127.0.0.1:${mocks.port}/never.jpg`)] })));
      ws.send(JSON.stringify(message('group', ' 不在白名单的群', { at: true, id: 4, groupId: 888 })));
    },
  });
  const bridge = startBridge(mocks.port, { ONEBOT_TOKEN: 'secret', ALLOW_GROUPS: '777,999' });
  t.after(() => {
    bridge.kill();
    mocks.close();
  });

  await waitUntil(() => actions.length === 2);
  napcat.send(JSON.stringify(message('private', '/reset', { id: 5 })));
  await waitUntil(() => actions.length === 3);
  napcat.send(JSON.stringify(message('private', '再问一次', { id: 6 })));
  await waitUntil(() => actions.length === 4);
  await new Promise((r) => setTimeout(r, 300)); // nothing else (e.g. a reply to message 1 or group 888) may arrive

  assert.equal(mocks.connections[0].searchParams.get('access_token'), 'secret');
  const byId = Object.fromEntries(actions.map((a) => [repliedTo(a), a]));
  assert.deepEqual(Object.keys(byId).sort(), ['2', '3', '5', '6']);

  assert.equal(byId[2].action, 'send_group_msg');
  assert.equal(byId[2].params.group_id, 777);
  assert.equal(replyText(byId[2]), '回答:Alice：你好'); // sender name added, <think> stripped

  assert.equal(byId[3].action, 'send_private_msg');
  assert.equal(byId[3].params.user_id, 42);
  assert.equal(replyText(byId[3]), '回答:私聊问题');

  assert.equal(replyText(byId[5]), '上下文已清空。');
  const afterReset = mocks.llmCalls.find((b) => b.messages.at(-1).content === '再问一次');
  assert.deepEqual(afterReset.messages.map((m) => m.role), ['system', 'user']);

  const firstPrivate = mocks.llmCalls.find((b) => b.messages.at(-1).content === '私聊问题');
  assert.equal(firstPrivate.messages.length, 2, 'group and private contexts are separate');
  assert.deepEqual(mocks.fileHits, [], 'images are not downloaded when VISION is off');
});

test('with VISION on, sends images (including the replied-to message) as data URLs and remembers only placeholders', async (t) => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);
  const actions = [];
  const getMsgCalls = [];
  let napcat;
  const mocks = await startMocks({
    files: {
      '/cat.png': { type: 'application/octet-stream', body: PNG }, // no usable content type: must be sniffed
      '/dog.jpg': { type: 'image/jpeg', body: JPEG },
      '/sticker.png': { type: 'image/png', body: PNG },
      '/big.png': { type: 'image/png', body: Buffer.alloc(4096) },
    },
    onLlm: () => ({ json: { choices: [{ message: { content: '看到了' } }] } }),
    onConnection: (ws) => {
      napcat = ws;
      const url = (path) => `http://127.0.0.1:${mocks.port}${path}`;
      ws.on('message', (data) => {
        const req = JSON.parse(data);
        if (req.action !== 'get_msg') return actions.push(req);
        getMsgCalls.push(req.params);
        const original = [{ type: 'text', data: { text: '原消息' } }, image(url('/dog.jpg'))];
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 99, message: original }, echo: req.echo }));
      });
      // a normal picture plus a sticker (sub_type 1) that must be skipped
      ws.send(JSON.stringify(message('group', ' 这是什么', {
        at: true, id: 1, groupId: 777, extra: [image(url('/cat.png')), image(url('/sticker.png'), { sub_type: 1 })],
      })));
    },
  });
  const bridge = startBridge(mocks.port, { VISION: 'true', IMAGE_MAX_MB: String(2048 / 1024 / 1024) });
  t.after(() => {
    bridge.kill();
    mocks.close();
  });

  await waitUntil(() => actions.length === 1);
  // reply to a message that holds a picture
  napcat.send(JSON.stringify(message('group', ' 那这张呢', {
    at: true, id: 2, groupId: 777, extra: [{ type: 'reply', data: { id: '99' } }],
  })));
  await waitUntil(() => actions.length === 2);
  // a private picture over the size limit: answered directly, the model is not called
  napcat.send(JSON.stringify(message('private', '', { id: 3, extra: [image(`http://127.0.0.1:${mocks.port}/big.png`)] })));
  await waitUntil(() => actions.length === 3);

  const [first, second] = mocks.llmCalls;
  assert.deepEqual(first.messages.at(-1).content, [
    { type: 'text', text: 'Alice：这是什么' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
  ]);
  assert.ok(!mocks.fileHits.includes('/sticker.png'), 'stickers are skipped');

  assert.deepEqual(getMsgCalls, [{ message_id: '99' }]);
  assert.deepEqual(second.messages.at(-1).content, [
    { type: 'text', text: 'Alice：（引用：原消息）那这张呢' },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${JPEG.toString('base64')}` } },
  ]);
  // the earlier turn is remembered as text with a placeholder, not as image data
  assert.deepEqual(second.messages[1], { role: 'user', content: 'Alice：这是什么 [图片×1]' });

  assert.equal(mocks.llmCalls.length, 2, 'the oversized image never reached the model');
  assert.equal(replyText(actions[2]), '图片加载失败，请稍后再试。');
});

test('reports LLM errors without keeping the failed question, and reconnects after a drop', async (t) => {
  const actions = [];
  const mocks = await startMocks({
    onLlm: (_body, call) => (call === 1 ? { status: 500, text: 'upstream boom' } : { json: { choices: [{ message: { content: '好的' } }] } }),
    onConnection: (ws, n) => {
      ws.on('message', (data) => {
        actions.push(JSON.parse(data));
        if (n === 1) ws.close(); // drop the bridge after its first reply
      });
      ws.send(JSON.stringify(message('private', n === 1 ? '第一问' : '第二问', { id: n })));
    },
  });
  const bridge = startBridge(mocks.port);
  t.after(() => {
    bridge.kill();
    mocks.close();
  });

  await waitUntil(() => actions.length === 2, 15_000); // the bridge waits 5 s before reconnecting

  assert.match(replyText(actions[0]), /^出错了：HTTP 500/);
  assert.equal(replyText(actions[1]), '好的');
  assert.equal(mocks.connections.length, 2, 'bridge reconnected');
  assert.deepEqual(mocks.llmCalls[1].messages.slice(1).map((m) => m.content), ['第二问']);
});
