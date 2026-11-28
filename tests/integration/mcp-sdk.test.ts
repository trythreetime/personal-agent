import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../../apps/server/src/app.js';

test('真实 Agents SDK 经 Core 调用真实 MCP，保留工具结果与事件', async () => {
  const requests: Array<Record<string, any>> = [];
  const http = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    requests.push(data);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: unknown, finish_reason: string | null = null) =>
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'chatcmpl-mcp-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          '\n\n',
      );
    const n = requests.length;
    if (n <= 2) {
      send({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'mcp-call-' + n,
            type: 'function',
            function: {
              name: n === 1 ? 'load_skill' : 'mcp_reference__read_note',
              arguments: JSON.stringify(
                n === 1 ? { skillId: 'requirement-analysis' } : { noteId: 'platform-overview' },
              ),
            },
          },
        ],
      });
      send({}, 'tool_calls');
    } else {
      send({
        role: 'assistant',
        content: '示例项目代号：青禾。来源：platform-overview，版本 1.0。',
      });
      send({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const dir = await mkdtemp(join(tmpdir(), 'mcp-sdk-'));
  let services: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    services = await createApp({
      root: resolve('.'),
      dataDir: dir,
      env: {
        DEEPSEEK_API_KEY: 'fixture-model-key',
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + address.port + '/v1',
      },
    });
    const task = await services.platform.createTask(
      { workerId: 'requirements-analyst', input: '查询示例资料，说明项目代号和来源' },
      crypto.randomUUID(),
    );
    await expect
      .poll(async () => (await services!.platform.task(task.id)).run.status)
      .toBe('succeeded');
    expect((await services.platform.task(task.id)).run.output).toContain('青禾');
    expect(requests).toHaveLength(3);
    const mcpTool = requests[0].tools.find(
      (tool: any) => tool.function.name === 'mcp_reference__read_note',
    );
    expect(mcpTool.function.parameters.properties.noteId.enum).toContain('platform-overview');
    expect(mcpTool.function.strict).toBe(false);
    const results = requests[2].messages.filter((message: any) => message.role === 'tool');
    expect(results).toHaveLength(2);
    expect(results[1].content).toContain('示例项目代号：青禾');
    expect(results[1].content).not.toContain('fixture-model-key');
    expect((await services.store.toolCalls(task.run.id)).map((call) => call.toolId)).toEqual([
      'load_skill',
      'mcp_reference__read_note',
    ]);
    expect(
      (await services.store.events(task.run.id, 0, 100)).some(
        (event) =>
          event.type === 'tool.completed' && event.payload.toolId === 'mcp_reference__read_note',
      ),
    ).toBe(true);
  } finally {
    await services?.app.close();
    await new Promise<void>((done) => http.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
});
