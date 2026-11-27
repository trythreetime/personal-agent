import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import type { Catalog, ExecutionSnapshot } from '@digital-worker/core';
import type { RunStatus, Usage, RunEvent } from '@digital-worker/contracts';
export const workers = sqliteTable('digital_workers', {
  id: text().primaryKey(),
  data: text({ mode: 'json' }).$type<Catalog['workers'][number]>().notNull(),
});
export const models = sqliteTable('model_configs', {
  id: text().primaryKey(),
  data: text({ mode: 'json' }).$type<Catalog['models'][number]>().notNull(),
});
export const skills = sqliteTable('skill_catalog', {
  id: text().primaryKey(),
  data: text({ mode: 'json' })
    .$type<Omit<Catalog['skills'][number], 'body' | 'resources'>>()
    .notNull(),
});
export const policies = sqliteTable('permission_policies', {
  id: text().primaryKey(),
  data: text({ mode: 'json' }).$type<Catalog['policies'][number]>().notNull(),
});
export const sessions = sqliteTable('sessions', {
  id: text().primaryKey(),
  workerId: text()
    .notNull()
    .references(() => workers.id),
  createdAt: text().notNull(),
});
export const uploads = sqliteTable('uploads', {
  id: text().primaryKey(),
  name: text().notNull(),
  size: integer().notNull(),
  storageKey: text().notNull(),
  hash: text().notNull(),
  taskId: text()
    .unique()
    .references((): AnySQLiteColumn => tasks.id),
  createdAt: text().notNull(),
});
export const tasks = sqliteTable('tasks', {
  id: text().primaryKey(),
  sessionId: text()
    .notNull()
    .references(() => sessions.id),
  workerId: text()
    .notNull()
    .references(() => workers.id),
  workerName: text().notNull(),
  uploadId: text().references(() => uploads.id),
  input: text().notNull(),
  requestKey: text().notNull().unique(),
  requestDigest: text().notNull(),
  createdAt: text().notNull(),
});
export const runs = sqliteTable(
  'agent_runs',
  {
    id: text().primaryKey(),
    taskId: text()
      .notNull()
      .references(() => tasks.id),
    attempt: integer().notNull().default(1),
    status: text().$type<RunStatus>().notNull(),
    snapshot: text({ mode: 'json' }).$type<ExecutionSnapshot>().notNull(),
    output: text(),
    usage: text({ mode: 'json' }).$type<Usage>().notNull(),
    error: text({ mode: 'json' }).$type<{ code: string; message: string }>(),
    createdAt: text().notNull(),
    startedAt: text(),
    endedAt: text(),
  },
  (t) => [uniqueIndex('run_attempt').on(t.taskId, t.attempt)],
);
export const messages = sqliteTable('messages', {
  id: text().primaryKey(),
  sessionId: text()
    .notNull()
    .references(() => sessions.id),
  taskId: text()
    .notNull()
    .references(() => tasks.id),
  role: text().notNull(),
  content: text().notNull(),
});
export const events = sqliteTable(
  'run_events',
  {
    runId: text()
      .notNull()
      .references(() => runs.id),
    seq: integer().notNull(),
    type: text().notNull(),
    data: text({ mode: 'json' }).$type<RunEvent>().notNull(),
  },
  (t) => [uniqueIndex('run_event_seq').on(t.runId, t.seq)],
);
export const toolCalls = sqliteTable('tool_calls', {
  callId: text().primaryKey(),
  runId: text()
    .notNull()
    .references(() => runs.id),
  toolId: text().notNull(),
  status: text().notNull(),
  summary: text().notNull(),
  durationMs: integer().notNull(),
});
