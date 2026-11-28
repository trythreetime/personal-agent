import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const notes = {
  'platform-overview': new URL('../resources/notes/platform-overview.md', import.meta.url),
  'acceptance-guide': new URL('../resources/notes/acceptance-guide.md', import.meta.url),
};
const server = new McpServer({ name: 'reference-notes', version: '1.0.0' });
server.registerTool(
  'read_note',
  {
    description: '读取平台示例资料。platform-overview 是平台说明，acceptance-guide 是验收约定。',
    inputSchema: { noteId: z.enum(['platform-overview', 'acceptance-guide']) },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ noteId }) => ({
    content: [{ type: 'text', text: await readFile(fileURLToPath(notes[noteId]), 'utf8') }],
  }),
);
await server.connect(new StdioServerTransport());
