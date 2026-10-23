// An MCP server built with the official SDK, used to check that our hand-written client interoperates with it.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'sdk-echo', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'echo', description: 'Echoes the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({ content: [{ type: 'text', text: `echo:${req.params.arguments.text}` }] }));
await server.connect(new StdioServerTransport());
