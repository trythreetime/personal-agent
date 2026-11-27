import { z } from 'zod';
export const runStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const isTerminal = (s: RunStatus) =>
  s === 'succeeded' || s === 'failed' || s === 'cancelled';
export const usageSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
});
export type Usage = z.infer<typeof usageSchema>;
export const runDtoSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  status: runStatusSchema,
  output: z.string().nullable(),
  usage: usageSchema,
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type RunDto = z.infer<typeof runDtoSchema>;
