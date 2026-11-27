import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createApp } from '../../apps/server/src/app.js';
import { SqlitePlatformStore, loadConfiguration } from '../../packages/infrastructure/src/index.js';
import {
  emptyUsage,
  type AgentRuntime,
  type ExecutionPlan,
} from '../../packages/core/src/index.js';
import { FixtureRuntime, BlockingRuntime } from '../fixtures/runtime.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(runtime: AgentRuntime = new FixtureRuntime()) {
  const dataDir = await mkdtemp(join(tmpdir(), 'conversation-test-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const services = await createApp({
    root: resolve('.'),
    dataDir,
    env: { AGENT_DEMO_MODE: 'true' },
    runtime,
  });
  cleanup.push(() => services.app.close());
  return services;
}
async function wait(s: Awaited<ReturnType<typeof setup>>, id: string) {
  await expect.poll(async () => (await s.platform.task(id)).run.status).toBe('succeeded');
  return s.platform.task(id);
}
test('同一数字人内新建文字会话、连续追问并传递真实历史', async () => {
  const seen: ExecutionPlan[] = [];
  const fixture = new FixtureRuntime();
  const s = await setup({
    async execute(...args) {
      seen.push(args[0]);
      return fixture.execute(...args);
    },
  });
  const a = await s.platform.createTask(
    { workerId: 'requirements-analyst', input: '我的项目叫星河' },
    crypto.randomUUID(),
  );
  await wait(s, a.id);
  const b = await s.platform.createTask(
    { workerId: a.workerId, sessionId: a.sessionId, input: '刚才项目叫什么？' },
    crypto.randomUUID(),
  );
  await wait(s, b.id);
  expect(b.sessionId).toBe(a.sessionId);
  expect(b.upload).toBeNull();
  expect(seen[1].history).toHaveLength(2);
  expect(seen[1].history[0]).toEqual({ role: 'user', content: '我的项目叫星河' });
  expect(seen[1].history[1].role).toBe('assistant');
  const sessions = (await s.app.inject(`/api/sessions?workerId=${a.workerId}`)).json();
  expect(sessions.items).toHaveLength(1);
  expect(sessions.items[0]).toMatchObject({
    id: a.sessionId,
    title: '我的项目叫星河',
    taskCount: 2,
  });
  const turns = (
    await s.app.inject(`/api/tasks?workerId=${a.workerId}&sessionId=${a.sessionId}`)
  ).json();
  expect(turns.total).toBe(2);
  expect(JSON.stringify(sessions)).not.toMatch(/snapshot|apiKeyRef|storageKey/);
});
test('追问复用本会话文档，其他会话不能复用且历史互不混入', async () => {
  const seen: ExecutionPlan[] = [];
  const fixture = new FixtureRuntime();
  const s = await setup({
    async execute(...args) {
      seen.push(args[0]);
      return fixture.execute(...args);
    },
  });
  const upload = await s.platform.upload('私有需求.md', Buffer.from('只有这个会话可读取的需求'));
  const a = await s.platform.createTask(
    { workerId: 'requirements-analyst', input: '分析文档', uploadId: upload.id },
    crypto.randomUUID(),
  );
  await wait(s, a.id);
  const b = await s.platform.createTask(
    { workerId: a.workerId, input: '补充验收标准', sessionId: a.sessionId },
    crypto.randomUUID(),
  );
  expect((await wait(s, b.id)).upload?.id).toBe(upload.id);
  expect((await s.store.toolCalls(b.run.id)).map((t) => t.toolId)).toContain('read_file');
  const c = await s.platform.createTask(
    { workerId: a.workerId, input: '新会话，不带附件' },
    crypto.randomUUID(),
  );
  await wait(s, c.id);
  expect(seen[2].history).toEqual([]);
  expect(c.upload).toBeNull();
  await expect(
    s.platform.createTask(
      { workerId: a.workerId, input: '越权复用', uploadId: upload.id, sessionId: c.sessionId },
      crypto.randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'UPLOAD_ALREADY_BOUND' });
});
test('同一会话回复期间拒绝并发消息，其他会话可以排队', async () => {
  const s = await setup(new BlockingRuntime());
  const a = await s.platform.createTask(
    { workerId: 'requirements-analyst', input: '第一条' },
    crypto.randomUUID(),
  );
  await expect(
    s.platform.createTask(
      { workerId: a.workerId, input: '并发消息', sessionId: a.sessionId },
      crypto.randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'SESSION_BUSY' });
  const b = await s.platform.createTask(
    { workerId: a.workerId, input: '另一个会话' },
    crypto.randomUUID(),
  );
  expect(b.sessionId).not.toBe(a.sessionId);
  await s.platform.cancel(a.run.id);
  await s.platform.cancel(b.run.id);
});
test('会话绑定的数字人不可被提交参数覆盖', async () => {
  const s = await setup();
  const a = await s.platform.createTask(
    { workerId: 'requirements-analyst', input: '原会话' },
    crypto.randomUUID(),
  );
  await wait(s, a.id);
  const run = await s.platform.run(a.run.id);
  const other = { ...run.snapshot.worker, id: 'other-worker' };
  const { catalog } = await loadConfiguration(resolve('.'), { AGENT_DEMO_MODE: 'true' });
  await s.store.importCatalog({ ...catalog, workers: [...catalog.workers, other] });
  await expect(
    s.store.createTask({
      id: crypto.randomUUID(),
      sessionId: a.sessionId,
      runId: crypto.randomUUID(),
      requestKey: crypto.randomUUID(),
      requestDigest: 'fixture',
      input: { workerId: other.id, sessionId: a.sessionId, input: '越权追问' },
      snapshot: { ...run.snapshot, worker: other },
    }),
  ).rejects.toMatchObject({ code: 'SESSION_NOT_AUTHORIZED' });
  expect((await s.app.inject('/api/sessions?workerId=other-worker')).json().items).toEqual([]);
});
test('旧版数据库升级后保留原会话、附件、消息与运行记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'migration-test-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'old.sqlite');
  const require = createRequire(
    new URL('../../packages/infrastructure/package.json', import.meta.url),
  );
  const Database = require('better-sqlite3');
  const old = new Database(path);
  const source = await readFile('packages/infrastructure/migrations/0001_initial.sql', 'utf8');
  old.exec(source);
  old.exec('CREATE TABLE _migrations(id TEXT PRIMARY KEY, hash TEXT NOT NULL)');
  old
    .prepare('INSERT INTO _migrations VALUES (?,?)')
    .run('0001', createHash('sha256').update(source).digest('hex'));
  const { catalog } = await loadConfiguration(resolve('.'), { AGENT_DEMO_MODE: 'true' });
  const worker = catalog.workers[0];
  const snapshot = {
    worker,
    model: catalog.models.at(-1)!,
    skills: catalog.skills,
    policy: catalog.policies[0],
  };
  const id = crypto.randomUUID(),
    sid = crypto.randomUUID(),
    uid = crypto.randomUUID(),
    rid = crypto.randomUUID(),
    now = new Date().toISOString();
  old.prepare('INSERT INTO digital_workers VALUES (?,?)').run(worker.id, JSON.stringify(worker));
  old.prepare('INSERT INTO sessions VALUES (?,?,?)').run(sid, worker.id, now);
  old
    .prepare('INSERT INTO uploads VALUES (?,?,?,?,?,?,?)')
    .run(uid, 'old.md', 10, 'fixture-key', 'fixture-hash', null, now);
  old
    .prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, sid, worker.id, worker.name, uid, '旧版消息', 'old-request', 'fixture', now);
  old
    .prepare('INSERT INTO agent_runs VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      rid,
      id,
      1,
      'succeeded',
      JSON.stringify(snapshot),
      '旧版回复',
      JSON.stringify(emptyUsage()),
      null,
      now,
      now,
      now,
    );
  old.prepare('UPDATE uploads SET taskId=? WHERE id=?').run(id, uid);
  old
    .prepare('INSERT INTO messages VALUES (?,?,?,?,?)')
    .run(crypto.randomUUID(), sid, id, 'user', '旧版消息');
  old
    .prepare('INSERT INTO messages VALUES (?,?,?,?,?)')
    .run(crypto.randomUUID(), sid, id, 'assistant', '旧版回复');
  old.close();
  const store = new SqlitePlatformStore(path);
  cleanup.push(async () => store.close());
  expect((await store.getTask(id))?.upload?.id).toBe(uid);
  expect((await store.getTask(id))?.run.output).toBe('旧版回复');
  expect((await store.getSession(sid))?.title).toBe('旧版消息');
  expect(await store.sessionHistory(sid, 'not-current')).toHaveLength(2);
  const next = await store.createTask({
    id: crypto.randomUUID(),
    sessionId: sid,
    runId: crypto.randomUUID(),
    requestKey: crypto.randomUUID(),
    requestDigest: 'next',
    input: { workerId: worker.id, sessionId: sid, input: '升级后追问' },
    snapshot,
  });
  expect(next.upload?.id).toBe(uid);
});
