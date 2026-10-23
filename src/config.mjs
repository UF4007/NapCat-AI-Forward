// Loads config.json and fills in defaults. Relative paths in the file resolve against the file's own directory.
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULTS = {
  onebot: { url: 'ws://127.0.0.1:3001', token: '' },
  llm: {
    baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', timeoutSeconds: 120, maxToolRounds: 5, maxConcurrentRequests: 4,
  },
  bot: { name: '', systemPrompt: '你是一个简洁友好的 QQ 助手。' },
  private: { enabled: true, allow: [] },
  // reply: "auto" lets the model decide on every batch of messages; "mention" answers only when @-mentioned.
  group: { reply: 'auto', allow: [], debounceSeconds: 8, maxWaitSeconds: 30 },
  vision: { enabled: false, stickers: false, maxImages: 4, maxImageMB: 10 },
  // Context limits: compression starts past maxContextMessages entries or maxContextChars characters.
  // maxMemoryChars caps the memory file; in global mode it defaults to 4000, as one memory covers every chat.
  memory: {
    maxContextMessages: 40, maxContextChars: 12000, keepRecentMessages: 10, maxMemoryChars: 2000, maxBatchMessages: 30, maxMessageChars: 1000,
  },
  // Chat history search (mcp/chat-history.mjs) reads at most this many messages back from QQ per search.
  history: { maxScanMessages: 1000 },
  // mode: "separate" gives every group and private chat its own context and memory; "global" makes them all
  // share one context, one memory and one queue, handled strictly one batch at a time.
  conversation: { mode: 'separate' },
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  dataDir: 'data', // long-term memory files only; chat history stays in QQ
  mcpServers: {},
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function merge(defaults, value) {
  if (value === undefined) return defaults;
  if (!isPlainObject(defaults) || !Object.keys(defaults).length) return value;
  if (!isPlainObject(value)) throw new Error(`expected an object, got ${JSON.stringify(value)}`);
  const out = {};
  for (const k of new Set([...Object.keys(defaults), ...Object.keys(value)])) out[k] = merge(defaults[k], value[k]);
  return out;
}

export function loadConfig(path) {
  const file = resolve(path);
  let raw;
  try {
    if (statSync(file).isDirectory()) throw new Error('is a directory');
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read config ${file}: ${e.message} (copy config.example.json to config.json first)`);
  }
  const config = merge(DEFAULTS, raw);
  config.baseDir = dirname(file);
  config.dataDir = resolve(config.baseDir, config.dataDir);
  config.group.allow = config.group.allow.map(String);
  config.private.allow = config.private.allow.map(String);
  if (config.conversation.mode === 'global' && raw.memory?.maxMemoryChars === undefined) config.memory.maxMemoryChars = 4000;

  if (!['separate', 'global'].includes(config.conversation.mode)) {
    throw new Error(`conversation.mode must be "separate" or "global", got ${JSON.stringify(config.conversation.mode)}`);
  }
  if (!['auto', 'mention'].includes(config.group.reply)) {
    throw new Error(`group.reply must be "auto" or "mention", got ${JSON.stringify(config.group.reply)}`);
  }
  if (!config.llm.model) throw new Error('llm.model is required');
  const positive = {
    'llm.maxConcurrentRequests': config.llm.maxConcurrentRequests,
    'memory.maxBatchMessages': config.memory.maxBatchMessages,
    'memory.maxMemoryChars': config.memory.maxMemoryChars,
    'history.maxScanMessages': config.history.maxScanMessages,
  };
  for (const [name, value] of Object.entries(positive)) {
    if (!(Number.isInteger(value) && value >= 1)) throw new Error(`${name} must be a whole number of at least 1`);
  }
  const { maxContextMessages, keepRecentMessages, maxContextChars, maxMessageChars } = config.memory;
  if (!(keepRecentMessages < maxContextMessages)) {
    throw new Error('memory.keepRecentMessages must be smaller than memory.maxContextMessages');
  }
  if (!(maxMessageChars > 0 && maxContextChars > 0)) throw new Error('memory.maxContextChars and memory.maxMessageChars must be positive');
  try {
    new Intl.DateTimeFormat('en', { timeZone: config.timezone });
  } catch {
    throw new Error(`timezone must be an IANA time zone such as "Asia/Shanghai", got ${JSON.stringify(config.timezone)}`);
  }
  return config;
}
