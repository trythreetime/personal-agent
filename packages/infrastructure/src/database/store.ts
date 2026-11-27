import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, asc, count, desc, eq, gt, max, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  emptyUsage,
  PlatformError,
  type PlatformStore,
  type Catalog,
  type UploadRecord,
  type StoredRun,
  type TaskRecord,
} from '@digital-worker/core';
import {
  isTerminal,
  type EventInput,
  type RunEvent,
  type RunStatus,
  type Usage,
  type SessionDto,
} from '@digital-worker/contracts';
import * as s from './schema/index.js';

export class SqlitePlatformStore implements PlatformStore {
  private client;
  private db;
  constructor(path: string) {
    this.client = new Database(path);
    this.client.pragma('foreign_keys = ON');
    this.client.pragma('journal_mode = WAL');
    this.client.pragma('busy_timeout = 5000');
    this.db = drizzle(this.client);
    this.client.exec(
      'CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, hash TEXT NOT NULL)',
    );
    const migrationRoot = new URL('../../migrations/', import.meta.url);
    const names = readdirSync(migrationRoot)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    const ids = new Set<string>();
    this.client.pragma('foreign_keys = OFF');
    try {
      this.client.transaction(() => {
        for (const name of names) {
          const id = name.slice(0, 4);
          if (ids.has(id)) throw new Error('迁移编号重复');
          ids.add(id);
          const source = readFileSync(new URL(name, migrationRoot), 'utf8');
          const hash = createHash('sha256').update(source).digest('hex');
          const applied = this.client
            .prepare('SELECT hash FROM _migrations WHERE id = ?')
            .get(id) as { hash: string } | undefined;
          if (applied && applied.hash !== hash)
            throw new Error('已应用迁移内容变化，请增加新的迁移');
          if (!applied) {
            this.client.exec(source);
            this.client.prepare('INSERT INTO _migrations VALUES (?, ?)').run(id, hash);
          }
        }
        const violations = this.client.pragma('foreign_key_check') as unknown[];
        if (violations.length) throw new Error('数据库迁移外键校验失败');
      })();
    } catch (error) {
      this.client.close();
      throw error;
    } finally {
      if (this.client.open) this.client.pragma('foreign_keys = ON');
    }
  }
  async importCatalog(c: Catalog) {
    this.db.transaction((tx) => {
      for (const w of c.workers)
        tx.insert(s.workers)
          .values({ id: w.id, data: w })
          .onConflictDoUpdate({ target: s.workers.id, set: { data: w } })
          .run();
      for (const m of c.models)
        tx.insert(s.models)
          .values({ id: m.id, data: m })
          .onConflictDoUpdate({ target: s.models.id, set: { data: m } })
          .run();
      for (const p of c.policies)
        tx.insert(s.policies)
          .values({ id: p.id, data: p })
          .onConflictDoUpdate({ target: s.policies.id, set: { data: p } })
          .run();
      for (const { body: _, resources: __, ...skill } of c.skills)
        tx.insert(s.skills)
          .values({ id: skill.id, data: skill })
          .onConflictDoUpdate({ target: s.skills.id, set: { data: skill } })
          .run();
    });
  }
  async saveUpload(record: UploadRecord) {
    this.db.insert(s.uploads).values(record).run();
  }
  async getUpload(id: string) {
    return this.db.select().from(s.uploads).where(eq(s.uploads.id, id)).get() ?? null;
  }
  private task(id: string): TaskRecord | null {
    const t = this.db.select().from(s.tasks).where(eq(s.tasks.id, id)).get();
    if (!t) return null;
    const upload = t.uploadId
      ? this.db.select().from(s.uploads).where(eq(s.uploads.id, t.uploadId)).get()
      : null;
    const {
      snapshot: _,
      attempt: __,
      ...run
    } = this.db.select().from(s.runs).where(eq(s.runs.taskId, id)).get()!;
    return {
      ...t,
      upload: upload
        ? { id: upload.id, name: upload.name, size: upload.size, createdAt: upload.createdAt }
        : null,
      run,
    };
  }
  async findByRequestKey(key: string) {
    const t = this.db.select().from(s.tasks).where(eq(s.tasks.requestKey, key)).get();
    return t ? this.task(t.id) : null;
  }
  async createTask(args: Parameters<PlatformStore['createTask']>[0]) {
    return this.db.transaction((tx) => {
      const previous = tx
        .select()
        .from(s.tasks)
        .where(eq(s.tasks.requestKey, args.requestKey))
        .get();
      if (previous) {
        if (previous.requestDigest !== args.requestDigest)
          throw new PlatformError('IDEMPOTENCY_CONFLICT', '提交标识已用于其他内容', 409);
        return this.task(previous.id)!;
      }
      if (args.input.sessionId) {
        const session = tx.select().from(s.sessions).where(eq(s.sessions.id, args.sessionId)).get();
        if (!session) throw new PlatformError('NOT_FOUND', '会话不存在', 404);
        if (session.workerId !== args.input.workerId)
          throw new PlatformError('SESSION_NOT_AUTHORIZED', '会话不属于当前数字人', 403);
        const busy = tx
          .select({ id: s.runs.id })
          .from(s.runs)
          .innerJoin(s.tasks, eq(s.tasks.id, s.runs.taskId))
          .where(
            and(
              eq(s.tasks.sessionId, args.sessionId),
              inArray(s.runs.status, ['queued', 'running']),
            ),
          )
          .get();
        if (busy)
          throw new PlatformError('SESSION_BUSY', '当前会话正在回复，请等待完成后再发送', 409);
      }
      const inherited =
        args.input.sessionId && !args.input.uploadId
          ? tx
              .select({ uploadId: s.tasks.uploadId })
              .from(s.tasks)
              .where(and(eq(s.tasks.sessionId, args.sessionId), isNotNull(s.tasks.uploadId)))
              .orderBy(desc(s.tasks.createdAt), desc(s.tasks.id))
              .get()?.uploadId
          : null;
      const uploadId = args.input.uploadId ?? inherited;
      const upload = uploadId
        ? tx.select().from(s.uploads).where(eq(s.uploads.id, uploadId)).get()
        : null;
      if (uploadId && !upload) throw new PlatformError('NOT_FOUND', '上传文件不存在', 404);
      if (upload?.taskId) {
        const owner = tx.select().from(s.tasks).where(eq(s.tasks.id, upload.taskId)).get();
        if (
          !args.input.sessionId ||
          owner?.sessionId !== args.sessionId ||
          owner.workerId !== args.input.workerId
        )
          throw new PlatformError('UPLOAD_ALREADY_BOUND', '文件属于其他会话，请重新上传', 409);
      }
      const createdAt = new Date().toISOString();
      if (!args.input.sessionId)
        tx.insert(s.sessions)
          .values({ id: args.sessionId, workerId: args.input.workerId, createdAt })
          .run();
      tx.insert(s.tasks)
        .values({
          id: args.id,
          sessionId: args.sessionId,
          workerId: args.input.workerId,
          workerName: args.snapshot.worker.name,
          uploadId: upload?.id ?? null,
          input: args.input.input,
          requestKey: args.requestKey,
          requestDigest: args.requestDigest,
          createdAt,
        })
        .run();
      if (upload && !upload.taskId)
        tx.update(s.uploads).set({ taskId: args.id }).where(eq(s.uploads.id, upload.id)).run();
      tx.insert(s.runs)
        .values({
          id: args.runId,
          taskId: args.id,
          status: 'queued',
          snapshot: args.snapshot,
          usage: emptyUsage(),
          createdAt,
        })
        .run();
      tx.insert(s.messages)
        .values({
          id: crypto.randomUUID(),
          sessionId: args.sessionId,
          taskId: args.id,
          role: 'user',
          content: args.input.input,
        })
        .run();
      this.append(args.runId, { type: 'run.queued', payload: {} });
      return this.task(args.id)!;
    });
  }
  async getTask(id: string) {
    return this.task(id);
  }
  async listTasks(limit: number, offset: number, workerId?: string, sessionId?: string) {
    const filter = and(
      workerId ? eq(s.tasks.workerId, workerId) : undefined,
      sessionId ? eq(s.tasks.sessionId, sessionId) : undefined,
    );
    const rows = this.db
      .select({ id: s.tasks.id })
      .from(s.tasks)
      .where(filter)
      .orderBy(desc(s.tasks.createdAt), desc(sql`${s.tasks}.rowid`))
      .limit(limit)
      .offset(offset)
      .all();
    return {
      items: rows.map((t) => this.task(t.id)!),
      total: this.db.select({ n: count() }).from(s.tasks).where(filter).get()!.n,
    };
  }
  private sessionQuery() {
    return this.db
      .select({
        id: s.sessions.id,
        workerId: s.sessions.workerId,
        createdAt: s.sessions.createdAt,
        title: sql<string>`coalesce((select substr(input, 1, 40) from tasks where sessionId = sessions.id order by createdAt asc, rowid asc limit 1), '新会话')`,
        updatedAt:
          sql<string>`coalesce((select max(createdAt) from tasks where sessionId = sessions.id), sessions.createdAt)`.as(
            'updated_at',
          ),
        taskCount: sql<number>`(select count(*) from tasks where sessionId = sessions.id)`,
        lastStatus: sql<
          SessionDto['lastStatus']
        >`coalesce((select r.status from agent_runs r join tasks t on r.taskId=t.id where t.sessionId=sessions.id order by t.createdAt desc, t.rowid desc limit 1), 'queued')`,
      })
      .from(s.sessions);
  }
  async getSession(id: string) {
    return this.sessionQuery().where(eq(s.sessions.id, id)).get() ?? null;
  }
  async listSessions(workerId: string, limit: number, offset: number) {
    return {
      items: this.sessionQuery()
        .where(eq(s.sessions.workerId, workerId))
        .orderBy(desc(sql`updated_at`), desc(s.sessions.id))
        .limit(limit)
        .offset(offset)
        .all(),
      total: this.db
        .select({ n: count() })
        .from(s.sessions)
        .where(eq(s.sessions.workerId, workerId))
        .get()!.n,
    };
  }
  async sessionHistory(sessionId: string, beforeTaskId: string) {
    const rows = this.db
      .select({ role: s.messages.role, content: s.messages.content })
      .from(s.messages)
      .innerJoin(s.tasks, eq(s.tasks.id, s.messages.taskId))
      .innerJoin(s.runs, eq(s.runs.taskId, s.tasks.id))
      .where(
        and(
          eq(s.messages.sessionId, sessionId),
          ne(s.tasks.id, beforeTaskId),
          eq(s.runs.status, 'succeeded'),
        ),
      )
      .orderBy(desc(s.tasks.createdAt), desc(sql`${s.tasks}.rowid`), asc(s.messages.role))
      .limit(20)
      .all()
      .reverse();
    const result: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    let length = 0;
    for (let i = rows.length - 2; i >= 0; i -= 2) {
      const pair = rows.slice(i, i + 2);
      const size = pair.reduce((sum, message) => sum + message.content.length, 0);
      if (length + size > 32_000) break;
      if (pair[0]?.role === 'user' && pair[1]?.role === 'assistant') {
        result.unshift(...(pair as Array<{ role: 'user' | 'assistant'; content: string }>));
        length += size;
      }
    }
    return result;
  }
  async getRun(id: string) {
    return this.db.select().from(s.runs).where(eq(s.runs.id, id)).get() ?? null;
  }
  async claimNext(): Promise<StoredRun | null> {
    return this.db.transaction((tx) => {
      const run = tx
        .select()
        .from(s.runs)
        .where(eq(s.runs.status, 'queued'))
        .orderBy(asc(s.runs.createdAt), asc(s.runs.id))
        .get();
      if (!run) return null;
      const startedAt = new Date().toISOString();
      tx.update(s.runs)
        .set({ status: 'running', startedAt })
        .where(and(eq(s.runs.id, run.id), eq(s.runs.status, 'queued')))
        .run();
      return { ...run, status: 'running', startedAt };
    });
  }
  private append(runId: string, event: EventInput): RunEvent {
    const seq =
      (this.db
        .select({ value: max(s.events.seq) })
        .from(s.events)
        .where(eq(s.events.runId, runId))
        .get()?.value ?? 0) + 1;
    const data: RunEvent = {
      ...event,
      schemaVersion: 1,
      runId,
      seq,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(s.events).values({ runId, seq, type: event.type, data }).run();
    return data;
  }
  async appendEvent(runId: string, event: EventInput) {
    return this.db.transaction(() => this.append(runId, event));
  }
  async events(runId: string, after: number, limit: number) {
    return this.db
      .select()
      .from(s.events)
      .where(and(eq(s.events.runId, runId), gt(s.events.seq, after)))
      .orderBy(asc(s.events.seq))
      .limit(limit)
      .all()
      .map((e) => e.data);
  }
  async lastSeq(runId: string) {
    return (
      this.db
        .select({ value: max(s.events.seq) })
        .from(s.events)
        .where(eq(s.events.runId, runId))
        .get()?.value ?? 0
    );
  }
  async finish(
    runId: string,
    status: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'>,
    result: { output?: string; usage?: Usage; error?: { code: string; message: string } },
  ) {
    this.db.transaction((tx) => {
      const run = tx.select().from(s.runs).where(eq(s.runs.id, runId)).get();
      if (!run || isTerminal(run.status)) return;
      const usage = result.usage ?? run.usage;
      tx.update(s.runs)
        .set({
          status,
          output: result.output ?? null,
          usage,
          error: result.error ?? null,
          endedAt: new Date().toISOString(),
        })
        .where(eq(s.runs.id, runId))
        .run();
      if (status === 'succeeded') {
        const task = tx.select().from(s.tasks).where(eq(s.tasks.id, run.taskId)).get()!;
        tx.insert(s.messages)
          .values({
            id: crypto.randomUUID(),
            taskId: task.id,
            sessionId: task.sessionId,
            role: 'assistant',
            content: result.output ?? '',
          })
          .run();
        this.append(runId, { type: 'run.completed', payload: { taskId: run.taskId, usage } });
      } else if (status === 'failed')
        this.append(runId, {
          type: 'run.failed',
          payload: result.error ?? { code: 'RUN_FAILED', message: '执行失败' },
        });
      else this.append(runId, { type: 'run.cancelled', payload: {} });
    });
  }
  async recordTool(args: Parameters<PlatformStore['recordTool']>[0]) {
    this.db.insert(s.toolCalls).values(args).run();
  }
  async toolCalls(runId: string) {
    return this.db
      .select({
        callId: s.toolCalls.callId,
        toolId: s.toolCalls.toolId,
        status: s.toolCalls.status,
        summary: s.toolCalls.summary,
        durationMs: s.toolCalls.durationMs,
      })
      .from(s.toolCalls)
      .where(eq(s.toolCalls.runId, runId))
      .all();
  }
  async recoverInterrupted() {
    for (const r of this.db.select().from(s.runs).where(eq(s.runs.status, 'running')).all())
      await this.finish(r.id, 'failed', {
        error: { code: 'PROCESS_INTERRUPTED', message: '服务重启，执行已中断，请重新提交' },
      });
  }
  close() {
    this.client.close();
  }
}
