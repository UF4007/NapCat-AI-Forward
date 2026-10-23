// NapCat (OneBot 11, forward WebSocket) <-> OpenAI-compatible chat API bridge.
// Private messages are always answered; group messages only when the bot is @-mentioned.
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

const THINK = /<think>[\s\S]*?<\/think>/g; // reasoning models such as deepseek-r1

const history = new Map(); // conversation key -> [{ role, content }]
const queues = new Map(); // conversation key -> tail of its promise chain

// Run fn after everything already queued for this conversation, so replies keep their order.
function inOrder(key, fn) {
  const run = (queues.get(key) || Promise.resolve()).then(fn);
  queues.set(key, run.catch(() => {}));
  return run;
}

function parse(ev) {
  const me = String(ev.self_id);
  const segments = Array.isArray(ev.message) ? ev.message : []; // NapCat's default array format
  const text = segments.filter((s) => s.type === 'text').map((s) => s.data.text || '').join('').trim();
  const mentioned = segments.some((s) => s.type === 'at' && String(s.data.qq) === me);
  return { text, mentioned };
}

async function chat(key, text) {
  const h = history.get(key) || [];
  history.set(key, h);
  h.push({ role: 'user', content: text });
  let reply;
  try {
    const r = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...h] }),
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
  const { text, mentioned } = parse(ev);
  if (!text) return;
  let key, action, target, prompt;
  if (ev.message_type === 'group') {
    if (!mentioned || (ALLOW_GROUPS.size && !ALLOW_GROUPS.has(Number(ev.group_id)))) return;
    const s = ev.sender || {};
    prompt = `${s.card || s.nickname || ev.user_id}：${text}`; // the group shares one context, so say who is talking
    [key, action, target] = [`g${ev.group_id}`, 'send_group_msg', { group_id: ev.group_id }];
  } else {
    prompt = text;
    [key, action, target] = [`p${ev.user_id}`, 'send_private_msg', { user_id: ev.user_id }];
  }

  const reply = await inOrder(key, async () => {
    if (text === '/reset' || text === '/重置') {
      history.delete(key);
      return '上下文已清空。';
    }
    try {
      return await chat(key, prompt);
    } catch (e) {
      return `出错了：${e.message}`;
    }
  });

  if (ws.readyState !== WebSocket.OPEN) return;
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
    if (ev.post_type !== 'message') return; // action responses, heartbeats, notices
    handle(ws, ev).catch((e) => console.error('handle failed:', e));
  });
  ws.addEventListener('error', () => {}); // a close event always follows
  ws.addEventListener('close', () => {
    console.log('disconnected, retrying in 5s');
    setTimeout(connect, 5000);
  });
}

connect();
