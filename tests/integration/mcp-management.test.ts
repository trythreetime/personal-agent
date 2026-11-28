import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, stat, rm, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createApp } from '../../apps/server/src/app.js';
import { emptyUsage, type AgentRuntime } from '../../packages/core/src/index.js';
import type { McpWrite, McpListDto } from '../../packages/contracts/src/index.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
class ManagedRuntime implements AgentRuntime {
  async execute(...[plan, tools]: Parameters<AgentRuntime['execute']>) {
    const tool = tools.find((item) => item.id === 'mcp_managed__read_note');
    const output = tool ? JSON.stringify(await tool.execute({ noteId: 'ok' })) : 'no managed tool';
    return { output, usage: emptyUsage() };
  }
}
async function setup(runtime: AgentRuntime = new ManagedRuntime()) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-management-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  let services = await createApp({
    root: resolve('.'),
    dataDir: dir,
    env: { AGENT_DEMO_MODE: 'true' },
    runtime,
  });
  cleanup.push(() => services.app.close());
  return {
    get services() {
      return services;
    },
    dir,
    async restart() {
      await services.app.close();
      services = await createApp({
        root: resolve('.'),
        dataDir: dir,
        env: { AGENT_DEMO_MODE: 'true' },
        runtime,
      });
    },
  };
}
const list = async (s: Awaited<ReturnType<typeof setup>>) =>
  (await s.services.app.inject('/api/mcp')).json<McpListDto>();
function input(revision: number): McpWrite {
  return {
    config: {
      id: 'managed',
      transport: 'stdio',
      command: 'node',
      args: ['tests/fixtures/mcp-server.mjs'],
      envRefs: {},
      enabled: true,
      allowedTools: ['read_note'],
      timeoutMs: 3000,
    },
    name: '网页管理测试',
    workerIds: ['requirements-analyst'],
    expectedRevision: revision,
  };
}
async function task(s: Awaited<ReturnType<typeof setup>>, text = 'test') {
  const value = await s.services.platform.createTask(
    { workerId: 'requirements-analyst', input: text },
    crypto.randomUUID(),
  );
  await expect
    .poll(async () => (await s.services.platform.task(value.id)).run.status)
    .toBe('succeeded');
  return s.services.platform.task(value.id);
}
test('网页配置导入、探测不保存，新增/绑定/更新/停用/删除即时生效且重启保留', async () => {
  const s = await setup();
  const initial = await list(s);
  const reference = initial.items.find((entry) => entry.config.id === 'reference')!;
  expect(reference.config.transport).toBe('stdio');
  if (reference.config.transport !== 'stdio') throw new Error('Expected local reference service');
  expect(reference.config.args).toContain('mcp-servers/reference/src/index.mjs');
  const value = input(initial.revision);
  const { expectedRevision, ...draft } = value;
  const probe = await s.services.app.inject({
    method: 'POST',
    url: '/api/mcp/probe',
    payload: { ...draft, config: { ...value.config, allowedTools: [] } },
  });
  expect(probe.statusCode).toBe(200);
  expect(probe.json().tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'read_note', readOnly: true, supported: true }),
      expect.objectContaining({ name: 'write_note', readOnly: false }),
    ]),
  );
  expect((await list(s)).revision).toBe(initial.revision);
  const saved = await s.services.app.inject({ method: 'POST', url: '/api/mcp', payload: value });
  expect(saved.statusCode).toBe(201);
  expect(s.services.platform.listWorkers()[0].tools).toContain('mcp_managed__read_note');
  expect((await task(s)).run.output).toContain('fixture note content');
  await s.restart();
  expect((await list(s)).items.find((entry) => entry.config.id === 'managed')?.name).toBe(
    '网页管理测试',
  );
  expect((await task(s)).run.output).toContain('fixture note content');
  let current = await list(s);
  const update = await s.services.app.inject({
    method: 'PUT',
    url: '/api/mcp/managed',
    payload: {
      ...value,
      name: '已编辑服务',
      config: { ...value.config, enabled: false },
      expectedRevision: current.revision,
    },
  });
  expect(update.statusCode).toBe(200);
  expect(s.services.platform.listWorkers()[0].tools).not.toContain('mcp_managed__read_note');
  expect((await task(s)).run.output).toBe('no managed tool');
  current = await list(s);
  const removed = await s.services.app.inject({
    method: 'DELETE',
    url: '/api/mcp/managed',
    payload: { expectedRevision: current.revision },
  });
  expect(removed.statusCode).toBe(200);
  await s.restart();
  expect((await list(s)).items.some((entry) => entry.config.id === 'managed')).toBe(false);
});
test('保存失败、未知数字人、重复 ID、白名单与并发版本冲突不覆盖有效配置', async () => {
  const s = await setup();
  const initial = await list(s);
  const value = input(initial.revision);
  expect(
    (
      await s.services.app.inject({
        method: 'POST',
        url: '/api/mcp',
        payload: { ...value, workerIds: ['unknown'] },
      })
    ).statusCode,
  ).toBe(400);
  const missing = await s.services.app.inject({
    method: 'POST',
    url: '/api/mcp',
    payload: { ...value, config: { ...value.config, allowedTools: ['missing_tool'] } },
  });
  expect(missing.json().code).toBe('MCP_TOOL_NOT_FOUND');
  const unsafe = await s.services.app.inject({
    method: 'POST',
    url: '/api/mcp',
    payload: { ...value, config: { ...value.config, allowedTools: ['write_note'] } },
  });
  expect(unsafe.json().code).toBe('MCP_TOOL_NOT_READ_ONLY');
  expect((await list(s)).revision).toBe(initial.revision);
  expect(
    (await s.services.app.inject({ method: 'POST', url: '/api/mcp', payload: value })).statusCode,
  ).toBe(201);
  const current = await list(s);
  const duplicate = await s.services.app.inject({
    method: 'POST',
    url: '/api/mcp',
    payload: { ...value, expectedRevision: current.revision },
  });
  expect(duplicate.statusCode).toBe(409);
  const replies = await Promise.all(
    ['first', 'second'].map((name) =>
      s.services.app.inject({
        method: 'PUT',
        url: '/api/mcp/managed',
        payload: { ...value, name, expectedRevision: current.revision },
      }),
    ),
  );
  expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
  const beforeFailure = await list(s);
  const file = join(s.dir, 'mcp-settings.json');
  await rename(file, file + '.backup');
  await mkdir(file);
  try {
    const failed = await s.services.app.inject({
      method: 'PUT',
      url: '/api/mcp/managed',
      payload: { ...value, name: 'must not apply', expectedRevision: beforeFailure.revision },
    });
    expect(failed.statusCode).toBe(500);
    expect(await list(s)).toEqual(beforeFailure);
  } finally {
    await rm(file, { recursive: true });
    await rename(file + '.backup', file);
  }
});
test('活动任务与排队任务在停用后继续使用原快照，新任务不再获得该服务', async () => {
  let started!: () => void, release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let count = 0;
  const runtime: AgentRuntime = {
    async execute(...[, tools]: Parameters<AgentRuntime['execute']>) {
      if (++count === 1) {
        started();
        await gate;
      }
      const tool = tools.find((item) => item.id === 'mcp_reference__read_note');
      return {
        output: tool
          ? JSON.stringify(await tool.execute({ noteId: 'platform-overview' }))
          : 'disabled',
        usage: emptyUsage(),
      };
    },
  };
  const s = await setup(runtime);
  const first = await s.services.platform.createTask(
    { workerId: 'requirements-analyst', input: 'first' },
    crypto.randomUUID(),
  );
  await entered;
  const second = await s.services.platform.createTask(
    { workerId: 'requirements-analyst', input: 'queued' },
    crypto.randomUUID(),
  );
  try {
    const current = await list(s);
    const ref = current.items.find((entry) => entry.config.id === 'reference')!;
    expect(
      (
        await s.services.app.inject({
          method: 'PUT',
          url: '/api/mcp/reference',
          payload: {
            config: { ...ref.config, enabled: false },
            name: ref.name,
            workerIds: ref.workerIds,
            expectedRevision: current.revision,
          },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    release();
  }
  for (const value of [first, second]) {
    await expect
      .poll(async () => (await s.services.platform.task(value.id)).run.status)
      .toBe('succeeded');
    expect((await s.services.platform.task(value.id)).run.output).toContain('青禾');
  }
  expect((await task(s)).run.output).toBe('disabled');
});
test('HTTP 凭证只写不回显，重启后可连接，清除与持久化权限正确', async () => {
  const remote = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer saved-fixture-token') {
      res.writeHead(401).end();
      return;
    }
    const mcp = new McpServer({ name: 'private-docs', version: '1.0.0' });
    mcp.registerTool(
      'lookup',
      { inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((done) => remote.listen(0, '127.0.0.1', done));
  cleanup.push(() => new Promise<void>((done) => remote.close(() => done())));
  const address = remote.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const s = await setup();
  const value = {
    config: {
      id: 'private',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:' + address.port + '/mcp',
      enabled: true,
      allowedTools: ['lookup'],
      timeoutMs: 3000,
    },
    name: '私有资料',
    workerIds: [],
    bearerToken: 'saved-fixture-token',
    expectedRevision: (await list(s)).revision,
  };
  const saved = await s.services.app.inject({ method: 'POST', url: '/api/mcp', payload: value });
  expect(saved.statusCode).toBe(201);
  expect(saved.body).not.toContain('saved-fixture-token');
  expect((await stat(join(s.dir, 'mcp-settings.json'))).mode & 0o777).toBe(0o600);
  await s.restart();
  const current = await list(s);
  const entry = current.items.find((item) => item.config.id === 'private')!;
  expect(entry.hasManagedToken).toBe(true);
  expect(entry.state).toBe('ready');
  const updated = await s.services.app.inject({
    method: 'PUT',
    url: '/api/mcp/private',
    payload: {
      config: entry.config,
      name: '修改名称',
      workerIds: [],
      expectedRevision: current.revision,
    },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.body).not.toContain('saved-fixture-token');
  const after = await list(s);
  const cleared = await s.services.app.inject({
    method: 'PUT',
    url: '/api/mcp/private',
    payload: {
      config: { ...entry.config, enabled: false },
      name: '停用并清除',
      workerIds: [],
      clearBearerToken: true,
      expectedRevision: after.revision,
    },
  });
  expect(cleared.statusCode).toBe(200);
  expect(
    cleared.json<McpListDto>().items.find((item) => item.config.id === 'private')?.hasManagedToken,
  ).toBe(false);
  expect(await readFile(join(s.dir, 'mcp-settings.json'), 'utf8')).not.toContain(
    'saved-fixture-token',
  );
});
test('跨站请求不能配置或启动 MCP 进程', async () => {
  const s = await setup();
  const response = await s.services.app.inject({
    method: 'POST',
    url: '/api/mcp/probe',
    headers: { origin: 'https://untrusted.example' },
    payload: { ...input(0), expectedRevision: undefined },
  });
  expect(response.statusCode).toBe(403);
  expect(response.json().code).toBe('ORIGIN_FORBIDDEN');
});

test.each(['edit-url', 'rotate-token', 'disable'] as const)(
  '配置保存立即作用于新任务，活动与排队任务固定旧连接及凭证：%s',
  async (change) => {
    const calls: Array<{ query: string; server: string; credential: string }> = [];
    async function endpoint(label: string) {
      const server = createServer(async (request, response) => {
        const credential =
          request.headers.authorization === 'Bearer old-fixture-token'
            ? 'old'
            : request.headers.authorization === 'Bearer new-fixture-token'
              ? 'new'
              : null;
        if (!credential) {
          response.writeHead(401).end();
          return;
        }
        const mcp = new McpServer({ name: 'snapshot-reference', version: '1.0.0' });
        mcp.registerTool(
          'lookup',
          {
            description: 'Read a fixture note',
            inputSchema: { query: z.string() },
            annotations: { readOnlyHint: true },
          },
          async ({ query }) => {
            calls.push({ query, server: label, credential });
            return { content: [{ type: 'text', text: label + ':' + credential }] };
          },
        );
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.on('close', () => {
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(request, response);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture address');
      return 'http://127.0.0.1:' + address.port + '/mcp';
    }
    const originalUrl = await endpoint('original');
    const updatedUrl = await endpoint('updated');
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime: AgentRuntime = {
      async execute(...[plan, tools]: Parameters<AgentRuntime['execute']>) {
        if (plan.input === 'active') {
          entered();
          await gate;
        }
        const tool = tools.find((tool) => tool.id === 'mcp_pinned__lookup');
        const result = tool ? await tool.execute({ query: plan.input }) : 'not bound';
        return { output: JSON.stringify(result), usage: emptyUsage() };
      },
    };
    const s = await setup(runtime);
    const saved = await s.services.app.inject({
      method: 'POST',
      url: '/api/mcp',
      payload: {
        config: {
          id: 'pinned',
          transport: 'streamable-http',
          url: originalUrl,
          enabled: true,
          allowedTools: ['lookup'],
          timeoutMs: 3000,
        },
        name: 'Pinned credentials',
        workerIds: ['requirements-analyst'],
        bearerToken: 'old-fixture-token',
        expectedRevision: (await list(s)).revision,
      },
    });
    expect(saved.statusCode).toBe(201);
    const active = await s.services.platform.createTask(
      { workerId: 'requirements-analyst', input: 'active' },
      crypto.randomUUID(),
    );
    await started;
    const queued = await s.services.platform.createTask(
      { workerId: 'requirements-analyst', input: 'queued' },
      crypto.randomUUID(),
    );
    expect(queued.run.status).toBe('queued');
    try {
      const current = await list(s);
      const entry = current.items.find((entry) => entry.config.id === 'pinned')!;
      const response = await s.services.app.inject({
        method: 'PUT',
        url: '/api/mcp/pinned',
        payload: {
          config: {
            ...entry.config,
            ...(change === 'edit-url' ? { url: updatedUrl } : {}),
            ...(change === 'disable' ? { enabled: false } : {}),
          },
          name: entry.name,
          workerIds: entry.workerIds,
          expectedRevision: current.revision,
          ...(change === 'rotate-token' ? { bearerToken: 'new-fixture-token' } : {}),
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toMatch(/old-fixture-token|new-fixture-token/);
    } finally {
      release();
    }
    for (const value of [active, queued]) {
      await expect
        .poll(async () => (await s.services.platform.task(value.id)).run.status)
        .toBe('succeeded');
      expect((await s.services.platform.task(value.id)).run.output).toContain('original:old');
    }
    const fresh = await task(s, 'fresh');
    expect(fresh.run.output).toContain(
      change === 'disable' ? 'not bound' : change === 'edit-url' ? 'updated:old' : 'original:new',
    );
    expect(calls.filter((call) => call.query === 'active' || call.query === 'queued')).toEqual([
      { query: 'active', server: 'original', credential: 'old' },
      { query: 'queued', server: 'original', credential: 'old' },
    ]);
    if (change !== 'disable') {
      const oldRun = (await s.services.store.getRun(queued.run.id))!;
      const newRun = (await s.services.store.getRun(fresh.run.id))!;
      expect(newRun.snapshot.toolVersions?.mcp_pinned__lookup).not.toBe(
        oldRun.snapshot.toolVersions?.mcp_pinned__lookup,
      );
    }
  },
);
