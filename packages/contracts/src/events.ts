import { z } from 'zod';
import { usageSchema } from './runs.js';
const base = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  seq: z.number().int().positive(),
  createdAt: z.string(),
});
const types = {
  'run.queued': z.object({}),
  'run.started': z.object({
    workerName: z.string(),
    modelName: z.string(),
    mode: z.enum(['demo', 'live']),
  }),
  'output.delta': z.object({ delta: z.string() }),
  'tool.started': z.object({ callId: z.string(), toolId: z.string(), summary: z.string() }),
  'tool.completed': z.object({
    callId: z.string(),
    toolId: z.string(),
    durationMs: z.number(),
    summary: z.string(),
  }),
  'tool.failed': z.object({ callId: z.string(), toolId: z.string(), code: z.string() }),
  'tool.denied': z.object({ callId: z.string(), toolId: z.string(), code: z.string() }),
  'usage.updated': usageSchema,
  'run.completed': z.object({ taskId: z.string(), usage: usageSchema }),
  'run.failed': z.object({ code: z.string(), message: z.string() }),
  'run.cancelled': z.object({}),
} as const;
type Payloads = { [K in keyof typeof types]: z.infer<(typeof types)[K]> };
export type EventInput = {
  [K in keyof Payloads]: { type: K; payload: Payloads[K] };
}[keyof Payloads];
export type RunEvent = EventInput & z.infer<typeof base>;
export function parseRunEvent(value: unknown): RunEvent {
  const envelope = base
    .extend({
      type: z.enum(Object.keys(types) as [keyof typeof types, ...(keyof typeof types)[]]),
      payload: z.unknown(),
    })
    .parse(value);
  return { ...envelope, payload: types[envelope.type].parse(envelope.payload) } as RunEvent;
}
