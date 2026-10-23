// OpenAI-compatible chat completions, with a tool-calling loop and a cap on concurrent requests.
const THINK = /<think>[\s\S]*?<\/think>/g; // reasoning models such as deepseek-r1

// Lets at most `max` tasks run at once; the rest wait in arrival order.
class Limiter {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.waiting = [];
  }

  async run(fn) {
    if (this.active < this.max) this.active++;
    else await new Promise((resolve) => this.waiting.push(resolve)); // the slot is handed over on release
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export class Llm {
  // config: the llm section of config.json
  constructor(config) {
    this.config = config;
    this.limiter = new Limiter(config.maxConcurrentRequests);
  }

  // tools: OpenAI function definitions; onToolCall(name, argumentsJson) -> string result.
  // After maxToolRounds rounds of tool calls the model is asked again without tools, so it has to answer.
  // Throws on HTTP errors; the error carries the response status as `status`.
  async complete(messages, { tools = [], onToolCall } = {}) {
    const conversation = [...messages];
    for (let round = 0; ; round++) {
      const useTools = tools.length > 0 && round < this.config.maxToolRounds;
      const message = await this.limiter.run(() => this.request({ messages: conversation, ...(useTools ? { tools } : {}) }));
      if (!useTools || !message.tool_calls?.length) return (message.content || '').replace(THINK, '').trim();

      conversation.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        let result;
        try {
          result = await onToolCall(call.function.name, call.function.arguments);
        } catch (e) {
          result = `工具调用失败：${e.message}`;
        }
        conversation.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
  }

  async request(body) {
    const { baseUrl, apiKey, model, timeoutSeconds } = this.config;
    const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, ...body }),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: r.status });
    return (await r.json()).choices[0].message;
  }
}
