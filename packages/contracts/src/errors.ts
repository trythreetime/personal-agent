import { z } from 'zod';
export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
