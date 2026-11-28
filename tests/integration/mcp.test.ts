import { afterEach, expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { McpToolRegistry } from '../../packages/agent-runtime/src/index.js';
import {
  authorizedTools,
  mcpServerConfigSchema,
  type McpServerConfig,
  type ToolContext,
} from '../../packages/core/src/index.js';
import { EnvironmentCredentials } from '../../packages/infrastructure/src/index.js';
import { createApp } from '../../apps/server/src/app.js';
import { BlockingRuntime } from '../fixtures/runtime.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function folder() {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-test-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function registry(overrides: Record<string, unknown> = {}) {
  const dir = await folder();
  const log = join(dir, 'calls.jsonl');
  const state = join(dir, 'state.txt');
  const config = mcpServerConfigSchema.parse({
    id: 'fixture',
    transport: 'stdio',
    command: 'node',
    args: ['tests/fixtures/mcp-server.mjs'],
    allowedTools: ['read_note'],
    timeoutMs: 2000,
    envRefs: {
      MCP_TEST_LOG: 'env:TEST_LOG',
      MCP_TEST_STATE: 'env:TEST_STATE',
      TEST_TOKEN: 'env:TEST_TOKEN',
    },
    ...overrides,
  });
  const env = { TEST_LOG: log, TEST_STATE: state, TEST_TOKEN: 'fixture-secret' };
  const manager = new McpToolRegistry([config], new EnvironmentCredentials(env), resolve('.'));
  cleanup.push(() => manager.close());
  return { manager, config, log, state };
}
const context = (signal = new AbortController().signal) => ({ signal }) as ToolContext;
async function records(path: string): Promise<Array<Record<string, any>>> {
  return (await readFile(path, 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function childrenClosed(log: string) {
  await expect
    .poll(async () =>
      (await records(log))
        .filter((r) => r.event === 'start')
        .every((r) => {
          try {
            process.kill(r.pid, 0);
            return false;
          } catch {
            return true;
          }
        }),
    )
    .toBe(true);
}
test('Stdio 真实发现、调用、凭证显式传递与子进程清理', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'must-not-forward-model-key');
  const { manager, log } = await registry();
  const tools = await manager.discover();
  expect(tools.map((t) => t.id)).toEqual(['mcp_fixture__read_note']);
  expect(tools[0].parameters.safeParse({ noteId: 'outside-root' }).success).toBe(false);
  expect(await tools[0].execute({ noteId: 'ok' }, context())).toMatchObject({
    content: 'fixture note content',
  });
  const starts = (await records(log)).filter((r) => r.event === 'start');
  // SDK protocol negotiation may respawn a v1 server; tool execution must remain single-shot.
  expect(starts.length).toBeGreaterThanOrEqual(2);
  expect((await records(log)).filter((r) => r.event === 'call')).toHaveLength(1);
  expect(starts.every((r) => r.customCredential && !r.modelKeyInherited)).toBe(true);
  await childrenClosed(log);
});
test.each([
  [{ allowedTools: ['unknown'] }, 'MCP_TOOL_NOT_FOUND'],
  [{ allowedTools: ['write_note'] }, 'MCP_TOOL_NOT_READ_ONLY'],
  [{ args: ['tests/fixtures/mcp-server.mjs', 'exit'] }, 'MCP_CONNECTION_FAILED'],
  [{ args: ['tests/fixtures/mcp-server.mjs', 'schema'] }, 'MCP_SCHEMA_UNSUPPORTED'],
  [{ args: ['tests/fixtures/mcp-server.mjs', 'hang'], timeoutMs: 500 }, 'MCP_TIMEOUT'],
] as const)('发现失败清理进程且不暴露协议错误 %j', async (overrides, code) => {
  const { manager, log } = await registry(overrides);
  await expect(manager.discover()).rejects.toMatchObject({ code });
  await childrenClosed(log);
});
test.each([
  ['error', 'MCP_TOOL_ERROR'],
  ['big', 'MCP_RESULT_TOO_LARGE'],
] as const)('MCP 返回 %s 不伪装成成功', async (noteId, code) => {
  const { manager, log } = await registry();
  const [tool] = await manager.discover();
  await expect(tool.execute({ noteId }, context())).rejects.toMatchObject({ code });
  await childrenClosed(log);
});
test.each(['text-only', 'non-text-only', 'mixed-text-first', 'mixed-image-first'] as const)(
  'MCP 输出仅接受完整文本结果：%s',
  async (noteId) => {
    const { manager, log } = await registry();
    const [tool] = await manager.discover();
    const result = tool.execute({ noteId }, context());
    if (noteId === 'text-only') {
      await expect(result).resolves.toEqual({
        serverId: 'fixture',
        toolName: 'read_note',
        content: 'fixture text block\nsecond text block',
      });
    } else {
      await expect(result).rejects.toMatchObject({ code: 'MCP_RESULT_UNSUPPORTED' });
    }
    await childrenClosed(log);
  },
);
test('超时和取消终止调用，下一次调用重新建立干净连接', async () => {
  const { manager, log } = await registry({ timeoutMs: 600 });
  const [tool] = await manager.discover();
  await expect(tool.execute({ noteId: 'wait' }, context())).rejects.toMatchObject({
    code: 'MCP_TIMEOUT',
  });
  await childrenClosed(log);
  const controller = new AbortController();
  const pending = tool.execute({ noteId: 'wait' }, context(controller.signal));
  const settled = expect(pending).rejects.toBeTruthy();
  await expect
    .poll(async () => (await records(log)).filter((r) => r.event === 'call').length)
    .toBe(2);
  controller.abort();
  await settled;
  await childrenClosed(log);
  await expect(tool.execute({ noteId: 'ok' }, context())).resolves.toMatchObject({
    content: 'fixture note content',
  });
});
test('服务工具定义漂移时拒绝执行，关闭注册表后拒绝新连接', async () => {
  const { manager, state, log } = await registry();
  const [tool] = await manager.discover();
  await writeFile(state, 'changed');
  await expect(tool.execute({ noteId: 'ok' }, context())).rejects.toMatchObject({
    code: 'MCP_TOOL_CHANGED',
  });
  expect((await records(log)).filter((r) => r.event === 'call')).toHaveLength(0);
  await manager.close();
  await expect(tool.execute({ noteId: 'ok' }, context())).rejects.toMatchObject({
    code: 'MCP_CLOSED',
  });
});
test('Core 阻止跨数字人 MCP 绑定、旧版本和非法参数，留下失败记录', async () => {
  const dir = await folder();
  const services = await createApp({
    root: resolve('.'),
    dataDir: dir,
    env: { AGENT_DEMO_MODE: 'true' },
    runtime: new BlockingRuntime(),
  });
  cleanup.push(() => services.app.close());
  const { manager, log } = await registry();
  const [tool] = await manager.discover();
  const task = await services.platform.createTask(
    { workerId: 'requirements-analyst', input: 'test' },
    crypto.randomUUID(),
  );
  const run = (await services.store.getRun(task.run.id))!;
  const snapshot = {
    ...run.snapshot,
    worker: { ...run.snapshot.worker, toolIds: [tool.id], mcpServerIds: ['fixture'] },
    policy: { ...run.snapshot.policy, allowedToolIds: [tool.id] },
    toolVersions: { [tool.id]: tool.source!.version },
  };
  const invoke = (changed = snapshot) =>
    authorizedTools(
      [tool],
      {
        ...context(),
        taskId: task.id,
        runId: task.run.id,
        workerId: task.workerId,
        fileId: null,
        snapshot: changed,
      },
      services.store,
    )[0];
  expect(
    await invoke({ ...snapshot, worker: { ...snapshot.worker, mcpServerIds: [] } }).execute({
      noteId: 'ok',
    }),
  ).toMatchObject({ error: { code: 'MCP_NOT_AUTHORIZED' } });
  expect(await invoke({ ...snapshot, toolVersions: {} }).execute({ noteId: 'ok' })).toMatchObject({
    error: { code: 'TOOL_CONFIGURATION_CHANGED' },
  });
  expect(await invoke().execute({ noteId: '../private' })).toMatchObject({
    error: { code: 'INVALID_TOOL_INPUT' },
  });
  expect((await records(log)).filter((r) => r.event === 'call')).toHaveLength(0);
  expect(
    (await services.store.events(task.run.id, 0, 100)).some(
      (event) => event.type === 'tool.denied',
    ),
  ).toBe(true);
  const failure = await invoke().execute({ noteId: 'error' });
  expect(failure).toMatchObject({ error: { code: 'MCP_TOOL_ERROR' } });
  expect(JSON.stringify(failure)).not.toContain('secret-fixture');
  expect(
    (await services.store.events(task.run.id, 0, 100)).some(
      (event) => event.type === 'tool.failed' && event.payload.code === 'MCP_TOOL_ERROR',
    ),
  ).toBe(true);
});
test('Streamable HTTP 真实握手、Bearer 凭证与只读调用', async () => {
  const tokens: string[] = [];
  const server = createServer(async (req, res) => {
    tokens.push(req.headers.authorization ?? '');
    if (req.headers.authorization !== 'Bearer fixture-http-secret') {
      res.writeHead(401).end();
      return;
    }
    const mcp = new McpServer({ name: 'http-reference', version: '1.0.0' });
    mcp.registerTool(
      'lookup',
      { inputSchema: { query: z.string().min(1) }, annotations: { readOnlyHint: true } },
      async ({ query }) => ({ content: [{ type: 'text', text: 'HTTP reference: ' + query }] }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const config = mcpServerConfigSchema.parse({
    id: 'http',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:' + address.port + '/mcp',
    bearerTokenRef: 'env:MCP_TOKEN',
    allowedTools: ['lookup'],
    timeoutMs: 3000,
  });
  const manager = new McpToolRegistry(
    [config],
    new EnvironmentCredentials({ MCP_TOKEN: 'fixture-http-secret' }),
    resolve('.'),
  );
  cleanup.push(() => manager.close());
  const [tool] = await manager.discover();
  expect(await tool.execute({ query: '网页验收' }, context())).toMatchObject({
    content: 'HTTP reference: 网页验收',
  });
  expect(tokens.length).toBeGreaterThan(1);
  expect(tokens.every((token) => token === 'Bearer fixture-http-secret')).toBe(true);
});
test('MCP 配置拒绝地址内凭证与未知字段', () => {
  expect(
    mcpServerConfigSchema.safeParse({
      id: 'a',
      transport: 'streamable-http',
      url: 'https://example.com/mcp?token=secret',
      allowedTools: ['read'],
    }).success,
  ).toBe(false);
  expect(
    mcpServerConfigSchema.safeParse({
      id: 'a',
      transport: 'stdio',
      command: 'node',
      allowedTools: ['read'],
      token: 'inline-secret',
    }).success,
  ).toBe(false);
});

test('服务关闭中止正在握手的 MCP 并清理子进程', async () => {
  const { manager, log } = await registry({
    args: ['tests/fixtures/mcp-server.mjs', 'hang'],
    timeoutMs: 3000,
  });
  const pending = manager.discover();
  const failed = expect(pending).rejects.toBeTruthy();
  await expect.poll(async () => (await records(log)).some((r) => r.event === 'start')).toBe(true);
  await manager.close();
  await failed;
  await childrenClosed(log);
});
