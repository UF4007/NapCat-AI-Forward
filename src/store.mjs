// Long-term memory: one Markdown file per conversation ("group-<id>" or "private-<id>", or "global" in global
// mode) in <dataDir>/memory.
// This is the only thing written to disk; chat history itself is read from QQ through NapCat.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class MemoryStore {
  constructor(dataDir) {
    this.dir = join(dataDir, 'memory');
    mkdirSync(this.dir, { recursive: true });
  }

  read(conversation) {
    try {
      return readFileSync(join(this.dir, `${conversation}.md`), 'utf8').trim();
    } catch {
      return '';
    }
  }

  write(conversation, text) {
    const file = join(this.dir, `${conversation}.md`);
    writeFileSync(`${file}.tmp`, `${text.trim()}\n`);
    renameSync(`${file}.tmp`, file);
  }
}
