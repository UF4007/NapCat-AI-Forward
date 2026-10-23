// Loads config.json and fills in defaults. Relative paths in the file resolve against the file's own directory.
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULTS = {
  onebot: { url: 'ws://127.0.0.1:3001', token: '' },
  llm: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', timeoutSeconds: 120, maxToolRounds: 5 },
  bot: { name: '', systemPrompt: '你是一个简洁友好的 QQ 助手。' },
  private: { enabled: true, allow: [] },
  // reply: "auto" lets the model decide on every batch of messages; "mention" answers only when @-mentioned.
  group: { reply: 'auto', allow: [], debounceSeconds: 8, maxWaitSeconds: 30 },
  vision: { enabled: false, stickers: false, maxImages: 4, maxImageMB: 10 },
  memory: { maxContextMessages: 40, keepRecentMessages: 10, maxMemoryChars: 2000 },
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  dataDir: 'data',
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

  if (!['auto', 'mention'].includes(config.group.reply)) {
    throw new Error(`group.reply must be "auto" or "mention", got ${JSON.stringify(config.group.reply)}`);
  }
  if (!config.llm.model) throw new Error('llm.model is required');
  const { maxContextMessages, keepRecentMessages } = config.memory;
  if (!(keepRecentMessages < maxContextMessages)) {
    throw new Error('memory.keepRecentMessages must be smaller than memory.maxContextMessages');
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: config.timezone });
  } catch {
    throw new Error(`timezone must be an IANA time zone such as "Asia/Shanghai", got ${JSON.stringify(config.timezone)}`);
  }
  return config;
}
