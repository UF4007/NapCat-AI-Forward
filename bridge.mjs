// NapCat (OneBot 11, forward WebSocket) <-> OpenAI-compatible chat API bridge.
// Private messages are always answered; group messages only when the bot is @-mentioned.
// With VISION=true, images in the message (or in the message it replies to) are sent to the model.
// Send /reset to clear the conversation's context.
// No dependencies: needs Node 22+ for the global WebSocket and fetch.

const env = process.env;
const WS_URL = env.ONEBOT_WS || 'ws://127.0.0.1:3001';
const WS_TOKEN = env.ONEBOT_TOKEN || '';
const BASE_URL = (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const API_KEY = env.LLM_API_KEY || '';
const MODEL = env.LLM_MODEL || 'gpt-4o-mini';
const SYSTEM_PROMPT = env.SYSTEM_PROMPT || '你是一个简洁友好的 QQ 助手。';
const HISTORY_MESSAGES = Number(env.HISTORY_MESSAGES || 20);
// Comma-separated group ids; empty means every group.
const ALLOW_GROUPS = new Set((env.ALLOW_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number));
const VISION = env.VISION === 'true'; // only for models that accept image input
const VISION_STICKERS = env.VISION_STICKERS === 'true';
const IMAGE_MAX_BYTES = Number(env.IMAGE_MAX_MB || 10) * 1024 * 1024;
const MAX_IMAGES = 4; // per message, counting the replied-to message

const THINK = /<think>[\s\S]*?<\/think>/g; // reasoning models such as deepseek-r1

const history = new Map(); // conversation key -> [{ role, content }]
const queues = new Map(); // conversation key -> tail of its promise chain
const pending = new Map(); // echo -> callback for OneBot action responses
let echoSeq = 0;

// Run fn after everything already queued for this conversation, so replies keep their order.
function inOrder(key, fn) {
  const run = (queues.get(key) || Promise.resolve()).then(fn);
  queues.set(key, run.catch(() => {}));
  return run;
}

// Call a OneBot action and wait for the response carrying the same echo.
function call(ws, action, params) {
  const echo = `bridge-${++echoSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(echo);
      reject(new Error(`${action} timed out`));
    }, 10_000);
    pending.set(echo, (res) => {
      clearTimeout(timer);
      pending.delete(echo);
      if (res.status === 'ok') resolve(res.data);
      else reject(new Error(`${action} failed: ${res.message || res.wording || res.retcode}`));
    });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

const textOf = (segments) => segments.filter((s) => s.type === 'text').map((s) => s.data.text || '').join('').trim();

// Stickers: shop faces carry emoji_id; picture sub_type 0 is a normal picture, anything else is a sticker kind.
const isSticker = (d) => d.emoji_id != null || (d.sub_type != null && Number(d.sub_type) !== 0);
const imagesOf = (segments) =>
  segments.filter((s) => s.type === 'image' && s.data.url && (VISION_STICKERS || !isSticker(s.data))).map((s) => s.data.url);

function parse(ev) {
  const me = String(ev.self_id);
  const segments = Array.isArray(ev.message) ? ev.message : []; // NapCat's default array format
  return {
    text: textOf(segments),
    mentioned: segments.some((s) => s.type === 'at' && String(s.data.qq) === me),
    images: imagesOf(segments),
    replyId: segments.find((s) => s.type === 'reply')?.data.id,
  };
}

function sniffImageType(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

// QQ image links expire and are often unreachable from model providers, so send the bytes as a data URL.
async function downloadImage(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (Number(r.headers.get('content-length') || 0) > IMAGE_MAX_BYTES) throw new Error('image too large');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > IMAGE_MAX_BYTES) throw new Error('image too large');
  const type = (r.headers.get('content-type') || '').split(';')[0].trim();
  return `data:${type.startsWith('image/') ? type : sniffImageType(buf)};base64,${buf.toString('base64')}`;
}

// content: what the model sees this turn (may include images); historyText: what is remembered afterwards.
async function chat(key, content, historyText) {
  const h = history.get(key) || [];
  history.set(key, h);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...h, { role: 'user', content }];
  h.push({ role: 'user', content: historyText });
  let reply;
  try {
    const r = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    reply = (await r.json()).choices[0].message.content || '';
  } catch (e) {
    h.pop(); // drop the unanswered question so the history stays user/assistant paired
    throw e;
  }
  reply = reply.replace(THINK, '').trim() || '（空回复）';
  h.push({ role: 'assistant', content: reply });
  h.splice(0, h.length - HISTORY_MESSAGES);
  return reply;
}

async function handle(ws, ev) {
  const { text, mentioned, images, replyId } = parse(ev);
  let key, action, target, speaker;
  if (ev.message_type === 'group') {
    if (!mentioned || (ALLOW_GROUPS.size && !ALLOW_GROUPS.has(Number(ev.group_id)))) return;
    const s = ev.sender || {};
    speaker = `${s.card || s.nickname || ev.user_id}：`; // the group shares one context, so say who is talking
    [key, action, target] = [`g${ev.group_id}`, 'send_group_msg', { group_id: ev.group_id }];
  } else {
    speaker = '';
    [key, action, target] = [`p${ev.user_id}`, 'send_private_msg', { user_id: ev.user_id }];
  }
  if (!text && !replyId && !(VISION && images.length)) return;

  // A reply brings the quoted message's text and images along: "@bot 这张图是什么" under someone's picture.
  let quoted = '';
  let imageUrls = images;
  if (replyId != null && text !== '/reset' && text !== '/重置') {
    try {
      const segments = (await call(ws, 'get_msg', { message_id: replyId })).message;
      if (Array.isArray(segments)) {
        quoted = textOf(segments);
        imageUrls = [...imagesOf(segments), ...images];
      }
    } catch (e) {
      console.error('could not load the replied-to message:', e.message);
    }
  }

  const results = VISION ? await Promise.allSettled(imageUrls.slice(0, MAX_IMAGES).map(downloadImage)) : [];
  const dataUrls = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  for (const r of results) if (r.status === 'rejected') console.error('image download failed:', r.reason.message);
  const failed = results.length - dataUrls.length;

  const reply = await inOrder(key, async () => {
    if (text === '/reset' || text === '/重置') {
      history.delete(key);
      return '上下文已清空。';
    }
    if (!text && !quoted && !dataUrls.length) return failed ? '图片加载失败，请稍后再试。' : null;

    const prompt = speaker + (quoted ? `（引用：${quoted}）` : '') + text + (failed ? ` [${failed} 张图片加载失败]` : '');
    const content = dataUrls.length
      ? [...(prompt ? [{ type: 'text', text: prompt }] : []), ...dataUrls.map((url) => ({ type: 'image_url', image_url: { url } }))]
      : prompt;
    const historyText = `${prompt}${dataUrls.length ? ` [图片×${dataUrls.length}]` : ''}`.trim();
    try {
      return await chat(key, content, historyText);
    } catch (e) {
      return `出错了：${e.message}`;
    }
  });

  if (reply == null || ws.readyState !== WebSocket.OPEN) return;
  const message = [
    { type: 'reply', data: { id: String(ev.message_id) } },
    { type: 'text', data: { text: reply } },
  ];
  ws.send(JSON.stringify({ action, params: { ...target, message } }));
}

function connect() {
  const url = new URL(WS_URL);
  if (WS_TOKEN) url.searchParams.set('access_token', WS_TOKEN);
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => console.log(`connected to ${WS_URL}`));
  ws.addEventListener('message', ({ data }) => {
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    if (ev.echo != null && pending.has(ev.echo)) return pending.get(ev.echo)(ev);
    if (ev.post_type !== 'message') return; // other action responses, heartbeats, notices
    handle(ws, ev).catch((e) => console.error('handle failed:', e));
  });
  ws.addEventListener('error', () => {}); // a close event always follows
  ws.addEventListener('close', () => {
    console.log('disconnected, retrying in 5s');
    setTimeout(connect, 5000);
  });
}

connect();
