import type {
  CreateTask,
  EventInput,
  RunEvent,
  RunStatus,
  TaskDto,
  Usage,
  SessionDto,
} from '@digital-worker/contracts';
import type {
  Catalog,
  ExecutionPlan,
  ExecutionSnapshot,
  RuntimeResult,
  RuntimeTool,
  StoredRun,
  TaskRecord,
  UploadRecord,
  ConversationMessage,
} from '../domain/index.js';
import type { McpServerConfig, McpToolInfo } from '@digital-worker/contracts';
import type { ToolDefinition } from '../domain/index.js';

export interface ManagedMcpEntry {
  name: string;
  config: McpServerConfig;
  workerIds: string[];
  configurationRevision?: number;
}
export interface McpSettingsState {
  revision: number;
  entries: ManagedMcpEntry[];
  secrets: Record<string, string>;
}
export interface McpSettingsStore {
  load(): Promise<McpSettingsState | null>;
  save(state: McpSettingsState): Promise<void>;
}
export interface McpToolBundle {
  tools: ToolDefinition[];
  info: McpToolInfo[];
  close(): Promise<void>;
}
export interface McpConnector {
  inspect(config: McpServerConfig, secrets: Record<string, string>): Promise<McpToolInfo[]>;
  prepare(config: McpServerConfig, secrets: Record<string, string>): Promise<McpToolBundle>;
}

export interface PlatformStore {
  importCatalog(catalog: Catalog): Promise<void>;
  saveUpload(record: UploadRecord): Promise<void>;
  getUpload(id: string): Promise<UploadRecord | null>;
  findByRequestKey(key: string): Promise<TaskRecord | null>;
  createTask(args: {
    id: string;
    sessionId: string;
    runId: string;
    requestKey: string;
    requestDigest: string;
    input: CreateTask;
    snapshot: ExecutionSnapshot;
  }): Promise<TaskDto>;
  getTask(id: string): Promise<TaskRecord | null>;
  listTasks(
    limit: number,
    offset: number,
    workerId?: string,
    sessionId?: string,
  ): Promise<{ items: TaskDto[]; total: number }>;
  getSession(id: string): Promise<SessionDto | null>;
  listSessions(
    workerId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: SessionDto[]; total: number }>;
  sessionHistory(sessionId: string, beforeTaskId: string): Promise<ConversationMessage[]>;
  getRun(id: string): Promise<StoredRun | null>;
  claimNext(): Promise<StoredRun | null>;
  appendEvent(runId: string, event: EventInput): Promise<RunEvent>;
  events(runId: string, after: number, limit: number): Promise<RunEvent[]>;
  lastSeq(runId: string): Promise<number>;
  finish(
    runId: string,
    status: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'>,
    result: { output?: string; usage?: Usage; error?: { code: string; message: string } },
  ): Promise<void>;
  recordTool(args: {
    runId: string;
    callId: string;
    toolId: string;
    status: string;
    summary: string;
    durationMs: number;
  }): Promise<void>;
  toolCalls(
    runId: string,
  ): Promise<
    Array<{ callId: string; toolId: string; status: string; summary: string; durationMs: number }>
  >;
  recoverInterrupted(): Promise<void>;
  close(): void;
}
export interface FileStore {
  save(data: Uint8Array): Promise<{ storageKey: string; hash: string }>;
  remove(storageKey: string): Promise<void>;
  read(storageKey: string): Promise<string>;
  ensureWorkspace(workerId: string, taskId: string): Promise<void>;
}
export interface CredentialResolver {
  resolve(ref: string): string;
  available(ref: string): boolean;
}
export interface AgentRuntime {
  execute(
    plan: ExecutionPlan,
    tools: RuntimeTool[],
    emit: (event: Extract<EventInput, { type: 'output.delta' | 'usage.updated' }>) => Promise<void>,
    signal: AbortSignal,
  ): Promise<RuntimeResult>;
}
export interface Logger {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}
