import { z } from 'zod';
import type { RunDto, TaskDto, UploadDto, Usage } from '@digital-worker/contracts';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const workerConfigSchema = z.object({
  id,
  name: z.string().min(1),
  description: z.string(),
  role: z.string(),
  instructions: z.string().min(1),
  modelId: id,
  skillIds: z.array(id),
  toolIds: z.array(id),
  mcpServerIds: z.array(id).default([]),
  permissionPolicyId: id,
  status: z.enum(['active', 'disabled']).default('active'),
});
export const modelConfigSchema = z.object({
  id,
  name: z.string(),
  provider: z.enum(['openai', 'openai-compatible', 'demo']),
  protocol: z.enum(['responses', 'chat_completions']),
  baseURL: z.url(),
  apiKeyRef: z.string().regex(/^env:[A-Z][A-Z0-9_]*$/),
  model: z.string().min(1),
  maxOutputTokens: z.number().int().positive().default(4096),
  enabled: z.boolean().default(true),
  thinkingMode: z.enum(['enabled', 'disabled']).optional(),
});
export const policySchema = z.object({
  id,
  allowedToolIds: z.array(id),
  readTaskFile: z.boolean(),
  readSkillResources: z.boolean(),
});
export type Worker = z.infer<typeof workerConfigSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type PermissionPolicy = z.infer<typeof policySchema>;
export { mcpServerConfigSchema } from '@digital-worker/contracts';
export type { McpServerConfig } from '@digital-worker/contracts';
export const mcpToolId = (serverId: string, toolName: string) =>
  'mcp_' + serverId + '__' + toolName;
export interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  body: string;
  resources: Record<string, string>;
}
export interface Catalog {
  workers: Worker[];
  models: ModelConfig[];
  policies: PermissionPolicy[];
  skills: Skill[];
}
export interface ExecutionSnapshot {
  worker: Worker;
  model: ModelConfig;
  policy: PermissionPolicy;
  skills: Skill[];
  toolVersions?: Record<string, string>;
}
export interface ExecutionPlan {
  taskId: string;
  runId: string;
  workerId: string;
  fileId: string | null;
  fileName: string | null;
  input: string;
  history: ConversationMessage[];
  instructions: string;
  model: ModelConfig;
  limits: { maxTurns: number; timeoutMs: number };
  snapshot: ExecutionSnapshot;
}
export interface UploadRecord extends UploadDto {
  storageKey: string;
  hash: string;
  taskId: string | null;
}
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface StoredRun extends RunDto {
  snapshot: ExecutionSnapshot;
}
export interface TaskRecord extends TaskDto {
  requestKey: string;
  requestDigest: string;
}
export interface ToolContext {
  taskId: string;
  runId: string;
  workerId: string;
  fileId: string | null;
  snapshot: ExecutionSnapshot;
  signal: AbortSignal;
}
export interface ToolDefinition {
  id: string;
  description: string;
  parameters: z.ZodObject;
  inputSchema?: Record<string, unknown>;
  source?: { type: 'mcp'; serverId: string; toolName: string; version: string };
  riskLevel: 'low' | 'medium' | 'high';
  requiresApproval: boolean;
  enabled: boolean;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
}
export interface RuntimeTool {
  id: string;
  description: string;
  parameters: z.ZodObject;
  inputSchema?: Record<string, unknown>;
  execute: (args: unknown) => Promise<unknown>;
}
export interface RuntimeResult {
  output: string;
  usage: Usage;
}
export class PlatformError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'PlatformError';
  }
}
export const emptyUsage = (): Usage => ({ inputTokens: null, outputTokens: null });
export class Registry<T extends { id: string }> {
  private items = new Map<string, T>();
  constructor(items: T[]) {
    for (const item of items) {
      if (this.items.has(item.id))
        throw new PlatformError('DUPLICATE_ID', `重复的资源 ID：${item.id}`);
      this.items.set(item.id, item);
    }
  }
  get(id: string): T {
    const item = this.items.get(id);
    if (!item) throw new PlatformError('RESOURCE_NOT_FOUND', '引用的资源不存在', 404);
    return item;
  }
  has(id: string) {
    return this.items.has(id);
  }
  all() {
    return [...this.items.values()];
  }
}
