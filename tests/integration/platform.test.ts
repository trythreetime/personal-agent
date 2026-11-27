import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../../apps/server/src/app.js';
import { authorizedTools, type AgentRuntime, emptyUsage } from '../../packages/core/src/index.js';
import {
  builtinTools,
  LocalFileStore,
  confined,
  loadConfiguration,
} from '../../packages/infrastructure/src/index.js';
import { isTerminal, type TaskDto } from '../../packages/contracts/src/index.js';
import { FixtureRuntime, BlockingRuntime } from '../fixtures/runtime.js';

const root = resolve('.');
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup(
  runtime: AgentRuntime = new FixtureRuntime(),
  env: NodeJS.ProcessEnv = { AGENT_DEMO_MODE: 'true' },
  limits?: { timeoutMs?: number; maxTurns?: number },
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'worker-test-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const services = await createApp({ root, dataDir, env, runtime, limits });
  cleanup.push(() => services.app.close());
  return { ...services, dataDir };
}
async function submit(
  services: Awaited<ReturnType<typeof setup>>,
  content = '核心需求：网页操作，刷新后保留记录。',
  key = crypto.randomUUID(),
) {
  const upload = await services.platform.upload('需求.md', Buffer.from(content));
  const input = { workerId: 'requirements-analyst', input: '分析文档', uploadId: upload.id };
  const task = await services.platform.createTask(input, key);
  return { task, input, key };
}
async function terminal(services: Awaited<ReturnType<typeof setup>>, id: string) {
  await expect
    .poll(async () => (await services.platform.task(id)).run.status)
    .toSatisfy(isTerminal);
  return services.platform.task(id);
}
test('上传 API 校验文件类型与编码，数字人 DTO 不泄露配置', async () => {
  const s = await setup();
  const workers = await s.app.inject('/api/workers');
  expect(workers.statusCode).toBe(200);
  expect(workers.body).not.toMatch(/apiKeyRef|instructions|baseURL|storageKey/);
  const form = new FormData();
  form.append('file', new Blob(['# 需求\n网页分析']), '需求.md');
  const req = new Request('http://localhost', { method: 'POST', body: form });
  const response = await s.app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { 'content-type': req.headers.get('content-type')! },
    payload: Buffer.from(await req.arrayBuffer()),
  });
  expect(response.statusCode).toBe(201);
  expect(response.json().name).toBe('需求.md');
  await expect(s.platform.upload('bad.pdf', Buffer.from('text'))).rejects.toMatchObject({
    code: 'UNSUPPORTED_FILE',
  });
  await expect(s.platform.upload('bad.txt', Buffer.from([0xff, 0xfe]))).rejects.toMatchObject({
    code: 'INVALID_ENCODING',
  });
  await expect(s.platform.upload('big.txt', new Uint8Array(2_097_153))).rejects.toMatchObject({
    code: 'UPLOAD_SIZE',
  });
});
test('单次执行调用真实受控工具并持久化结果、事件与调用记录', async () => {
  const s = await setup();
  const { task } = await submit(s);
  const done = await terminal(s, task.id);
  expect(done.run.status).toBe('succeeded');
  expect(done.run.output).toContain('核心需求');
  const events = await s.store.events(task.run.id, 0, 100);
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  expect(events.at(-1)?.type).toBe('run.completed');
  expect((await s.store.toolCalls(task.run.id)).map((t) => t.toolId)).toEqual([
    'load_skill',
    'read_file',
  ]);
  const dto = await s.app.inject(`/api/tasks/${task.id}`);
  expect(dto.body).not.toMatch(/storageKey|requestKey|apiKeyRef|snapshot/);
});
test('并发重复提交返回同一个任务，内容变化与文件复用被拒绝', async () => {
  const s = await setup();
  const upload = await s.platform.upload('a.txt', Buffer.from('测试需求'));
  const key = crypto.randomUUID();
  const input = { workerId: 'requirements-analyst', input: '分析', uploadId: upload.id };
  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      s.app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { 'idempotency-key': key },
        payload: input,
      }),
    ),
  );
  expect(responses.every((r) => r.statusCode === 202)).toBe(true);
  expect(new Set(responses.map((r) => r.json().id)).size).toBe(1);
  expect((await s.store.listTasks(10, 0)).total).toBe(1);
  await expect(s.platform.createTask({ ...input, input: '不同内容' }, key)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await expect(s.platform.createTask(input, crypto.randomUUID())).rejects.toMatchObject({
    code: 'UPLOAD_ALREADY_BOUND',
  });
});
test('跨任务文件、未绑定技能和技能路径穿越由授权入口拒绝并审计', async () => {
  let foreignId = '';
  const runtime: AgentRuntime = {
    async execute(plan, tools) {
      const read = tools.find((t) => t.id === 'read_file')!;
      const skill = tools.find((t) => t.id === 'load_skill')!;
      const resource = tools.find((t) => t.id === 'read_skill_resource')!;
      expect(await read.execute({ fileId: foreignId })).toMatchObject({
        error: { code: 'FILE_NOT_AUTHORIZED' },
      });
      expect(await skill.execute({ skillId: 'not-bound' })).toMatchObject({
        error: { code: 'SKILL_NOT_AUTHORIZED' },
      });
      expect(
        await resource.execute({ skillId: plan.snapshot.skills[0].id, path: '../../.env' }),
      ).toMatchObject({ error: { code: 'RESOURCE_FORBIDDEN' } });
      return { output: '授权边界验证完成', usage: emptyUsage() };
    },
  };
  const s = await setup(runtime);
  foreignId = (await s.platform.upload('foreign.txt', Buffer.from('其他任务资料'))).id;
  const { task } = await submit(s);
  await terminal(s, task.id);
  expect(
    (await s.store.events(task.run.id, 0, 100)).filter((e) => e.type === 'tool.denied'),
  ).toHaveLength(3);
});
test('工具白名单不能被直接调用绕过', async () => {
  const s = await setup(new BlockingRuntime());
  const { task } = await submit(s);
  await expect.poll(async () => (await s.platform.run(task.run.id)).status).toBe('running');
  const run = await s.platform.run(task.run.id);
  const files = new LocalFileStore(join(s.dataDir, 'uploads'), join(s.dataDir, 'workspaces'));
  const snapshot = { ...run.snapshot, policy: { ...run.snapshot.policy, allowedToolIds: [] } };
  const tools = authorizedTools(
    builtinTools(s.store, files),
    {
      taskId: task.id,
      runId: run.id,
      workerId: task.workerId,
      fileId: task.upload!.id,
      snapshot,
      signal: new AbortController().signal,
    },
    s.store,
  );
  expect(
    await tools.find((t) => t.id === 'read_file')!.execute({ fileId: task.upload!.id }),
  ).toMatchObject({ error: { code: 'TOOL_NOT_AUTHORIZED' } });
  await s.platform.cancel(run.id);
});
test('路径范围检查拒绝目录穿越与符号链接逃逸', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'path-test-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'inside'));
  await writeFile(join(dir, 'secret.txt'), 'secret');
  await symlink(join(dir, 'secret.txt'), join(dir, 'inside/link.txt'));
  await expect(confined(join(dir, 'inside'), '../secret.txt')).rejects.toMatchObject({
    code: 'RESOURCE_FORBIDDEN',
  });
  await expect(confined(join(dir, 'inside'), 'link.txt')).rejects.toMatchObject({
    code: 'RESOURCE_FORBIDDEN',
  });
});
test('运行超时会中止执行并保存明确错误', async () => {
  const s = await setup(new BlockingRuntime(), { AGENT_DEMO_MODE: 'true' }, { timeoutMs: 100 });
  const { task } = await submit(s);
  const done = await terminal(s, task.id);
  expect(done.run.status).toBe('failed');
  expect(done.run.error?.code).toBe('RUN_TIMEOUT');
});
test('异常内容不进入用户结果与审计事件', async () => {
  const runtime: AgentRuntime = {
    async execute() {
      throw new Error('sk-private-test-value /Users/private/path');
    },
  };
  const s = await setup(runtime);
  const { task } = await submit(s);
  const done = await terminal(s, task.id);
  expect(done.run.error?.code).toBe('RUN_FAILED');
  expect(JSON.stringify(await s.store.events(task.run.id, 0, 100))).not.toMatch(
    /sk-private|\/Users\/private/,
  );
});
test('排队和运行中的任务都可取消，重复取消不产生重复终态', async () => {
  const s = await setup(new BlockingRuntime());
  const a = await submit(s);
  await expect.poll(async () => (await s.platform.run(a.task.run.id)).status).toBe('running');
  const b = await submit(s);
  await s.platform.cancel(b.task.run.id);
  await s.platform.cancel(a.task.run.id);
  expect((await terminal(s, a.task.id)).run.status).toBe('cancelled');
  expect((await s.platform.run(b.task.run.id)).status).toBe('cancelled');
  await s.platform.cancel(a.task.run.id);
  expect(
    (await s.store.events(a.task.run.id, 0, 100)).filter((e) => e.type === 'run.cancelled'),
  ).toHaveLength(1);
});
test('重启保留历史，将遗留 running 标为中断，并继续尚未执行任务', async () => {
  const s = await setup();
  await s.platform.stop();
  const { catalog } = await loadConfiguration(root, { AGENT_DEMO_MODE: 'true' });
  const worker = catalog.workers[0];
  const snapshot = {
    worker,
    model: catalog.models.find((m) => m.id === worker.modelId)!,
    policy: catalog.policies[0],
    skills: catalog.skills,
  };
  async function queued() {
    const upload = await s.platform.upload('a.md', Buffer.from('重启恢复需求'));
    return s.store.createTask({
      id: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      requestKey: crypto.randomUUID(),
      requestDigest: 'fixture',
      input: { workerId: worker.id, input: '分析', uploadId: upload.id },
      snapshot,
    });
  }
  const a = await queued();
  await s.store.claimNext();
  const b = await queued();
  await s.app.close();
  const next = await createApp({
    root,
    dataDir: s.dataDir,
    env: { AGENT_DEMO_MODE: 'true' },
    runtime: new FixtureRuntime(),
  });
  cleanup.push(() => next.app.close());
  expect((await next.platform.task(a.id)).run.error?.code).toBe('PROCESS_INTERRUPTED');
  await expect.poll(async () => (await next.platform.task(b.id)).run.status).toBe('succeeded');
  expect((await next.store.events(a.run.id, 0, 100)).at(-1)?.type).toBe('run.failed');
});
test('SSE 可重放和游标补读，终态后关闭，越界游标被拒绝', async () => {
  const s = await setup();
  const { task } = await submit(s);
  await terminal(s, task.id);
  const address = await s.app.listen({ host: '127.0.0.1', port: 0 });
  const first = await fetch(`${address}/api/runs/${task.run.id}/events`);
  const full = await first.text();
  expect(full).toContain('event: run.completed');
  const ids = [...full.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  expect(ids).toEqual(ids.map((_, i) => i + 1));
  const replay = await fetch(`${address}/api/runs/${task.run.id}/events?after=0`, {
    headers: { 'Last-Event-ID': '2' },
  });
  expect(await replay.text()).not.toMatch(/^id: [12]$/m);
  expect((await fetch(`${address}/api/runs/${task.run.id}/events?after=99999`)).status).toBe(400);
});
test('模型未配置时可查看工作台但提交被阻止，不泄露密钥或 SDK 错误', async () => {
  const s = await setup(new FixtureRuntime(), {});
  expect(s.platform.listWorkers()[0].ready).toBe(false);
  const upload = await s.platform.upload('a.txt', Buffer.from('需求'));
  await expect(
    s.platform.createTask(
      { workerId: 'requirements-analyst', input: '分析', uploadId: upload.id },
      crypto.randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
  expect(
    (await s.app.inject({ url: '/api/workers', headers: { origin: 'https://evil.example' } }))
      .statusCode,
  ).toBe(403);
  expect(
    (await s.app.inject({ url: '/api/health', headers: { host: 'evil.example' } })).statusCode,
  ).toBe(403);
});
