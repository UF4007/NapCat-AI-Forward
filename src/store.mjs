// On-disk state, one pair of files per conversation ("group-<id>" or "private-<id>"):
//   <dataDir>/logs/<conversation>.jsonl   every message, one JSON record per line
//   <dataDir>/memory/<conversation>.md    long-term memory written by compression
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONVERSATION_ID = /^(group|private)-\d+$/;

export class Store {
  constructor(dataDir) {
    this.logsDir = join(dataDir, 'logs');
    this.memoryDir = join(dataDir, 'memory');
    mkdirSync(this.logsDir, { recursive: true });
    mkdirSync(this.memoryDir, { recursive: true });
  }

  // record: { time, message_id?, user_id, name, text, self? }
  appendLog(conversation, record) {
    appendFileSync(join(this.logsDir, `${conversation}.jsonl`), `${JSON.stringify(record)}\n`);
  }

  readLog(conversation) {
    return readLogFile(join(this.logsDir, `${conversation}.jsonl`));
  }

  readMemory(conversation) {
    try {
      return readFileSync(join(this.memoryDir, `${conversation}.md`), 'utf8').trim();
    } catch {
      return '';
    }
  }

  writeMemory(conversation, text) {
    const file = join(this.memoryDir, `${conversation}.md`);
    writeFileSync(`${file}.tmp`, `${text.trim()}\n`);
    renameSync(`${file}.tmp`, file);
  }
}

export function readLogFile(file) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return content.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// Returns { total, records }: the newest `limit` matches, in chronological order.
// query: whitespace-separated keywords that must all appear (case-insensitive) in the name or text.
export function searchLogs(logsDir, { conversation, query = '', userId, since, until, limit = 20 } = {}) {
  if (conversation && !CONVERSATION_ID.test(conversation)) throw new Error(`invalid conversation id: ${conversation}`);
  let files;
  try {
    files = conversation ? [`${conversation}.jsonl`] : readdirSync(logsDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    files = [];
  }
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  const from = since ? Date.parse(since) : -Infinity;
  const to = until ? Date.parse(until) : Infinity;
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error('since/until must be ISO 8601 date-times');

  const matches = [];
  for (const f of files) {
    for (const r of readLogFile(join(logsDir, f))) {
      const t = Date.parse(r.time);
      if (t < from || t > to) continue;
      if (userId != null && String(r.user_id) !== String(userId)) continue;
      const haystack = `${r.name}\n${r.text}`.toLowerCase();
      if (keywords.every((k) => haystack.includes(k))) matches.push({ conversation: f.slice(0, -'.jsonl'.length), ...r });
    }
  }
  matches.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return { total: matches.length, records: matches.slice(-limit) };
}

// "2026-10-23 17:05" in the given time zone.
export function formatTime(time, timeZone) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(time));
}
