import { z } from 'zod';
import { runDtoSchema } from './runs.js';
import { uploadDtoSchema } from './uploads.js';
export const createTaskSchema = z
  .object({
    workerId: z.string().min(1),
    input: z.string().trim().min(1).max(10_000),
    uploadId: z.string().uuid().optional(),
    sessionId: z.string().uuid().optional(),
  })
  .strict();
export type CreateTask = z.infer<typeof createTaskSchema>;
export const taskDtoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  workerId: z.string(),
  workerName: z.string(),
  input: z.string(),
  createdAt: z.string(),
  upload: uploadDtoSchema.nullable(),
  run: runDtoSchema,
});
export type TaskDto = z.infer<typeof taskDtoSchema>;
