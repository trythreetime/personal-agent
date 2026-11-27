import { z } from 'zod';
export const uploadDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  size: z.number(),
  createdAt: z.string(),
});
export type UploadDto = z.infer<typeof uploadDtoSchema>;
