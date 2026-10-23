// OpenAI-compatible chat completions, with a tool-calling loop.
const THINK = /<think>[\s\S]*?<\/think>/g; // reasoning models such as deepseek-r1

// tools: OpenAI function definitions; onToolCall(name, argumentsJson) -> string result.
// After llm.maxToolRounds rounds of tool calls the model is asked again without tools, so it has to answer.
export async function complete(llm, messages, { tools = [], onToolCall } = {}) {
  const conversation = [...messages];
  for (let round = 0; ; round++) {
    const useTools = tools.length > 0 && round < llm.maxToolRounds;
    const r = await fetch(`${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({ model: llm.model, messages: conversation, ...(useTools ? { tools } : {}) }),
      signal: AbortSignal.timeout(llm.timeoutSeconds * 1000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const message = (await r.json()).choices[0].message;
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
