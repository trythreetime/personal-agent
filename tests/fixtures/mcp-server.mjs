import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appendFile, readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
const log = async (event) => {
  if (process.env.MCP_TEST_LOG)
    await appendFile(
      process.env.MCP_TEST_LOG,
      JSON.stringify({ ...event, pid: process.pid }) + '\n',
    );
};
await log({
  event: 'start',
  modelKeyInherited: Boolean(process.env.DEEPSEEK_API_KEY),
  customCredential: process.env.TEST_TOKEN === 'fixture-secret',
});
if (process.argv[2] === 'exit') process.exit(1);
if (process.argv[2] === 'hang') {
  globalThis.setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (process.argv[2] === 'schema') {
  const unsupported = new Server(
    { name: 'unsupported-schema', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  unsupported.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'read_note',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', patternProperties: { '^allowed': { type: 'string' } } },
      },
    ],
  }));
  await unsupported.connect(new StdioServerTransport());
} else {
  let changed = false;
  if (process.env.MCP_TEST_STATE)
    changed = (await readFile(process.env.MCP_TEST_STATE, 'utf8').catch(() => '')) === 'changed';
  const server = new McpServer({ name: 'fixture-mcp', version: '1.0.0' });
  server.registerTool(
    'read_note',
    {
      description: changed ? 'changed contract' : 'fixture readonly note',
      inputSchema: {
        noteId: z.enum([
          'ok',
          'wait',
          'error',
          'big',
          'text-only',
          'non-text-only',
          'mixed-text-first',
          'mixed-image-first',
        ]),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ noteId }, extra) => {
      await log({ event: 'call', noteId });
      if (noteId === 'wait') await setTimeout(10_000, undefined, { signal: extra.signal });
      if (noteId === 'error')
        return { isError: true, content: [{ type: 'text', text: 'secret-fixture-error-detail' }] };
      const text = { type: 'text', text: 'fixture text block' };
      const image = { type: 'image', data: 'AA==', mimeType: 'image/png' };
      if (noteId === 'text-only')
        return { content: [text, { type: 'text', text: 'second text block' }] };
      if (noteId === 'non-text-only') return { content: [image] };
      if (noteId === 'mixed-text-first') return { content: [text, image] };
      if (noteId === 'mixed-image-first') return { content: [image, text] };
      return {
        content: [
          { type: 'text', text: noteId === 'big' ? 'a'.repeat(128_001) : 'fixture note content' },
        ],
      };
    },
  );
  server.registerTool(
    'write_note',
    { inputSchema: {}, annotations: { readOnlyHint: false } },
    async () => ({ content: [{ type: 'text', text: 'not allowed' }] }),
  );
  await server.connect(new StdioServerTransport());
}
