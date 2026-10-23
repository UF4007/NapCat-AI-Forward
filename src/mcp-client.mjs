// Minimal Model Context Protocol client over stdio (newline-delimited JSON-RPC 2.0): enough to list and call tools.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const PROTOCOL_VERSION = '2025-11-25';

export class McpClient {
  constructor(name, child) {
    this.name = name;
    this.child = child;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.closed = false;
    child.stdin.on('error', () => {}); // a dead server surfaces through 'exit'
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    const fail = (why) => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`MCP server "${name}" ${why}`));
      }
      this.pending.clear();
    };
    child.on('error', (e) => fail(`failed: ${e.message}`));
    child.on('exit', (code) => fail(`exited with code ${code}`));
  }

  // spec: { command, args?, env?, cwd? }
  static async start(name, { command, args = [], env = {}, cwd }) {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    const client = new McpClient(name, child);
    try {
      await client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'napcat-ai-forward', version: '0.2.0' },
      });
      client.notify('notifications/initialized');
    } catch (e) {
      client.close();
      throw e;
    }
    return client;
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else p.resolve(msg.result);
    } else if (msg.id != null && msg.method) {
      // Requests from the server: answer pings, decline everything else (sampling, roots, ...).
      const reply = msg.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Method not found' } };
      this.write({ jsonrpc: '2.0', id: msg.id, ...reply });
    }
  }

  write(msg) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(method, params, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.name}" is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }

  close() {
    this.closed = true;
    this.child.kill();
  }
}
