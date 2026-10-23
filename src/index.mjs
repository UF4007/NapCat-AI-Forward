#!/usr/bin/env node
// Entry point. Usage: node src/index.mjs [path/to/config.json]   (defaults to ./config.json)
import { Bot } from './bot.mjs';
import { loadConfig } from './config.mjs';
import { OneBot } from './onebot.mjs';
import { Store } from './store.mjs';
import { loadTools } from './tools.mjs';

let config;
try {
  config = loadConfig(process.argv[2] || 'config.json');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const store = new Store(config.dataDir);
const tools = await loadTools(config);
const onebot = new OneBot(config.onebot);
const bot = new Bot(config, { store, tools, onebot });
onebot.onEvent = (ev) => bot.onEvent(ev);
onebot.connect();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    tools.close();
    process.exit(0);
  });
}
