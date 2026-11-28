import { z } from 'zod';
const mcpCommon = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
  enabled: z.boolean().default(true),
  allowedTools: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/)).max(128),
  timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
};
const credentialRef = z.string().regex(/^env:[A-Z][A-Z0-9_]*$/);
export const mcpServerConfigSchema = z.discriminatedUnion('transport', [
  z
    .object({
      ...mcpCommon,
      transport: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      envRefs: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), credentialRef).default({}),
    })
    .strict(),
  z
    .object({
      ...mcpCommon,
      transport: z.literal('streamable-http'),
      url: z.url().refine((value) => {
        const u = new URL(value);
        return (
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          (u.protocol === 'https:' ||
            (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
        );
      }, 'MCP 地址须为 HTTPS 或本机 HTTP，凭证通过环境变量引用'),
      bearerTokenRef: credentialRef.optional(),
    })
    .strict(),
]);
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const mcpWriteSchema = z
  .object({
    config: mcpServerConfigSchema,
    name: z.string().trim().min(1).max(80),
    workerIds: z.array(z.string().min(1).max(80)).max(100),
    bearerToken: z.string().trim().min(1).max(8192).optional(),
    clearBearerToken: z.boolean().optional(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export const mcpProbeSchema = mcpWriteSchema.omit({ expectedRevision: true });
export const mcpRevisionSchema = z
  .object({ expectedRevision: z.number().int().nonnegative() })
  .strict();
export interface McpToolInfo {
  id: string;
  name: string;
  description: string;
  readOnly: boolean;
  supported: boolean;
  inputSchema: Record<string, unknown>;
}
export interface McpServerDto {
  config: McpServerConfig;
  name: string;
  workerIds: string[];
  tools: McpToolInfo[];
  state: 'ready' | 'disabled' | 'error';
  error: { code: string; message: string } | null;
  hasManagedToken: boolean;
}
export interface McpListDto {
  revision: number;
  items: McpServerDto[];
}
export type McpWrite = z.infer<typeof mcpWriteSchema>;
export type McpProbe = z.infer<typeof mcpProbeSchema>;
