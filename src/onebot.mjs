// OneBot 11 forward-WebSocket client: reconnects on its own, delivers events, and calls actions.
export class OneBot {
  // log: where connection messages go (the MCP server passes console.error, since its stdout is the protocol).
  constructor({ url, token }, { log = console.log } = {}) {
    this.url = url;
    this.token = token;
    this.log = log;
    this.ws = null;
    this.pending = new Map(); // echo -> callback for action responses
    this.seq = 0;
    this.onEvent = () => {};
  }

  connect() {
    const url = new URL(this.url);
    if (this.token) url.searchParams.set('access_token', this.token);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('open', () => this.log(`connected to ${this.url}`));
    ws.addEventListener('message', ({ data }) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.echo != null && this.pending.has(msg.echo)) this.pending.get(msg.echo)(msg);
      else if (msg.post_type) this.onEvent(msg);
    });
    ws.addEventListener('error', () => {}); // a close event always follows
    ws.addEventListener('close', () => {
      this.log('disconnected, retrying in 5s');
      setTimeout(() => this.connect(), 5000);
    });
  }

  // Connects if needed and resolves once the connection is open.
  async ready(timeoutMs = 10_000) {
    if (!this.ws) this.connect();
    const deadline = Date.now() + timeoutMs;
    while (this.ws.readyState !== WebSocket.OPEN) {
      if (Date.now() > deadline) throw new Error(`cannot connect to NapCat at ${this.url}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // Fire and forget; returns false when not connected.
  send(action, params) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ action, params }));
    return true;
  }

  // Calls an action and resolves with its `data`.
  call(action, params, timeoutMs = 10_000) {
    const echo = `bridge-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`${action} timed out`));
      }, timeoutMs);
      this.pending.set(echo, (res) => {
        clearTimeout(timer);
        this.pending.delete(echo);
        if (res.status === 'ok') resolve(res.data);
        else reject(new Error(`${action} failed: ${res.message || res.wording || res.retcode}`));
      });
      if (this.ws?.readyState !== WebSocket.OPEN) return this.pending.get(echo)({ status: 'failed', message: 'not connected' });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }
}
