import { z } from 'zod';
import { runStatusSchema } from './runs.js';

export const sessionDtoSchema = z.object({
  id: z.string().uuid(),
  workerId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  taskCount: z.number().int().nonnegative(),
  lastStatus: runStatusSchema,
});
export type SessionDto = z.infer<typeof sessionDtoSchema>;
