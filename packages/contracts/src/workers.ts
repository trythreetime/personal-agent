import { z } from 'zod';
export const workerDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  role: z.string(),
  status: z.enum(['active', 'disabled']),
  skills: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  tools: z.array(z.string()),
  modelName: z.string(),
  mode: z.enum(['live', 'demo']),
  ready: z.boolean(),
  unavailableReason: z.string().nullable(),
});
export type WorkerDto = z.infer<typeof workerDtoSchema>;
