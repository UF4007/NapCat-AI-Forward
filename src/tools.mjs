// Exposes the tools of every configured MCP server to the model as OpenAI function tools.
import { McpClient } from './mcp-client.mjs';

const MAX_RESULT_CHARS = 8000;

// config.mcpServers: { <name>: { command, args?, env?, conversationArgument? } }
// conversationArgument names a tool argument that the bridge always fills with the current conversation id and
// hides from the model, so a tool like chat history search can never be pointed at another conversation.
export async function loadTools(config) {
  const clients = [];
  const entries = [];
  for (const [server, spec] of Object.entries(config.mcpServers)) {
    try {
      const client = await McpClient.start(server, { ...spec, cwd: config.baseDir });
      clients.push(client);
      for (const tool of await client.listTools()) {
        const name = `${server}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        const parameters = structuredClone(tool.inputSchema || { type: 'object', properties: {} });
        const forced = spec.conversationArgument;
        if (forced) {
          delete parameters.properties?.[forced];
          if (Array.isArray(parameters.required)) parameters.required = parameters.required.filter((p) => p !== forced);
        }
        entries.push({ name, client, tool: tool.name, forced, definition: { type: 'function', function: { name, description: tool.description || '', parameters } } });
      }
      console.log(`MCP server "${server}" ready`);
    } catch (e) {
      console.error(`MCP server "${server}" unavailable: ${e.message}`);
    }
  }

  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    definitions: entries.map((e) => e.definition),

    async call(name, argumentsJson, { conversation }) {
      const entry = byName.get(name);
      if (!entry) return `未知工具：${name}`;
      let args;
      try {
        args = argumentsJson ? JSON.parse(argumentsJson) : {};
      } catch {
        return '工具参数不是合法的 JSON。';
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {};
      if (entry.forced) args[entry.forced] = conversation;
      const result = await entry.client.callTool(entry.tool, args);
      const text = (result.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
        || (result.structuredContent ? JSON.stringify(result.structuredContent) : '');
      return `${result.isError ? '工具返回错误：' : ''}${text}`.slice(0, MAX_RESULT_CHARS);
    },

    close() {
      for (const c of clients) c.close();
    },
  };
}
