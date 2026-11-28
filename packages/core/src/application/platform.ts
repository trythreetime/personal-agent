import {
  createTaskSchema,
  isTerminal,
  type CreateTask,
  type WorkerDto,
} from '@digital-worker/contracts';
import {
  PlatformError,
  Registry,
  type Catalog,
  type ToolDefinition,
  type ExecutionSnapshot,
} from '../domain/index.js';
import type {
  AgentRuntime,
  CredentialResolver,
  FileStore,
  Logger,
  PlatformStore,
} from '../ports/index.js';
import { buildPlan } from './context/builder.js';
import { authorizedTools } from './tools/invoker.js';

export interface PlatformDependencies {
  catalog: Catalog;
  tools: ToolDefinition[];
  store: PlatformStore;
  files: FileStore;
  runtime: AgentRuntime;
  credentials: CredentialResolver;
  logger: Logger;
  limits: { maxTurns: number; timeoutMs: number; maxUploadBytes: number };
}
export class AgentPlatform {
  private toolHistory = new Map<string, ToolDefinition>();
  private workers;
  private models;
  private skills;
  private policies;
  private tools;
  private active: { runId: string; controller: AbortController; cancelled: boolean } | null = null;
  private dispatching: Promise<void> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  constructor(private deps: PlatformDependencies) {
    this.workers = new Registry(deps.catalog.workers);
    this.models = new Registry(deps.catalog.models);
    this.skills = new Registry(deps.catalog.skills);
    this.policies = new Registry(deps.catalog.policies);
    this.tools = new Registry(deps.tools);
    this.rememberTools(deps.tools);
    for (const policy of this.policies.all()) {
      for (const id of policy.allowedToolIds) this.tools.get(id);
    }
    for (const w of this.workers.all()) {
      this.models.get(w.modelId);
      this.policies.get(w.permissionPolicyId);
      for (const id of w.skillIds) this.skills.get(id);
      for (const id of w.toolIds) this.tools.get(id);
      for (const id of w.toolIds) {
        const source = this.tools.get(id).source;
        if (source && !w.mcpServerIds.includes(source.serverId))
          throw new PlatformError('MCP_NOT_BOUND', 'MCP 工具需要绑定对应的服务');
      }
    }
  }
  private rememberTools(tools: ToolDefinition[]) {
    for (const tool of tools)
      if (tool.source) this.toolHistory.set(tool.id + '@' + tool.source.version, tool);
  }
  applyMcp(entries: Array<{ serverId: string; workerIds: string[]; tools: ToolDefinition[] }>) {
    const mcpTools = entries.flatMap((entry) => entry.tools);
    const workers = this.deps.catalog.workers.map((worker) => {
      const bound = entries.filter((entry) => entry.workerIds.includes(worker.id));
      return {
        ...worker,
        mcpServerIds: bound.map((entry) => entry.serverId),
        toolIds: [
          ...worker.toolIds.filter((id) => !id.startsWith('mcp_')),
          ...bound.flatMap((entry) => entry.tools.map((tool) => tool.id)),
        ],
      };
    });
    const policies = this.deps.catalog.policies.map((policy) => ({
      ...policy,
      allowedToolIds: [
        ...new Set([
          ...policy.allowedToolIds.filter((id) => !id.startsWith('mcp_')),
          ...workers
            .filter((worker) => worker.permissionPolicyId === policy.id)
            .flatMap((worker) => worker.toolIds.filter((id) => id.startsWith('mcp_'))),
        ]),
      ],
    }));
    const tools = [...this.deps.tools.filter((tool) => !tool.source), ...mcpTools];
    const workerRegistry = new Registry(workers);
    const policyRegistry = new Registry(policies);
    const toolRegistry = new Registry(tools);
    this.rememberTools(mcpTools);
    this.workers = workerRegistry;
    this.policies = policyRegistry;
    this.tools = toolRegistry;
    this.deps.catalog = { ...this.deps.catalog, workers, policies };
  }
  async start() {
    await this.deps.store.importCatalog(this.deps.catalog);
    await this.deps.store.recoverInterrupted();
    this.stopped = false;
    this.tick = setInterval(() => this.wake(), 250);
    this.tick.unref();
    this.wake();
  }
  listWorkers(): WorkerDto[] {
    return this.workers.all().map((w) => {
      const model = this.models.get(w.modelId);
      const ready =
        w.status === 'active' &&
        model.enabled &&
        (model.provider === 'demo' || this.deps.credentials.available(model.apiKeyRef));
      return {
        id: w.id,
        name: w.name,
        role: w.role,
        status: w.status,
        description: w.description,
        skills: w.skillIds.map((id) => {
          const s = this.skills.get(id);
          return { id: s.id, name: s.name, description: s.description };
        }),
        tools: w.toolIds,
        modelName: model.name,
        mode: model.provider === 'demo' ? 'demo' : 'live',
        ready,
        unavailableReason: ready
          ? null
          : w.status === 'disabled'
            ? '该数字人已停用，仍可查看历史会话'
            : !model.enabled
              ? '该数字人绑定的模型已停用'
              : '请在服务端 .env 配置模型 API Key 后重启服务',
      };
    });
  }
  async upload(name: string, data: Uint8Array) {
    if (!/\.(md|txt)$/i.test(name))
      throw new PlatformError('UNSUPPORTED_FILE', '仅支持 Markdown 和纯文本文件');
    if (data.byteLength === 0 || data.byteLength > this.deps.limits.maxUploadBytes)
      throw new PlatformError('UPLOAD_SIZE', '文件必须为非空且不超过 2 MiB', 413);
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      throw new PlatformError('INVALID_ENCODING', '请上传 UTF-8 编码的文本');
    }
    if (data.includes(0)) throw new PlatformError('INVALID_TEXT', '文件包含二进制内容');
    const safeName = name
      .split(/[\\/]/)
      .at(-1)!
      .replace(/[\x00-\x1f\x7f]/g, '')
      .slice(0, 180);
    const file = await this.deps.files.save(data);
    const upload = {
      ...file,
      id: crypto.randomUUID(),
      name: safeName,
      size: data.byteLength,
      createdAt: new Date().toISOString(),
      taskId: null,
    };
    try {
      await this.deps.store.saveUpload(upload);
    } catch (error) {
      await this.deps.files.remove(file.storageKey);
      throw error;
    }
    return { id: upload.id, name: upload.name, size: upload.size, createdAt: upload.createdAt };
  }
  async createTask(input: CreateTask, requestKey: string) {
    input = createTaskSchema.parse(input);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestKey))
      throw new PlatformError('INVALID_IDEMPOTENCY_KEY', '需要有效的 Idempotency-Key');
    if (this.stopped) throw new PlatformError('SERVICE_STOPPING', '服务正在关闭', 503);
    const requestDigest = JSON.stringify(input);
    const previous = await this.deps.store.findByRequestKey(requestKey);
    if (previous) {
      if (previous.requestDigest !== requestDigest)
        throw new PlatformError('IDEMPOTENCY_CONFLICT', '此提交标识已用于其他内容', 409);
      return previous;
    }
    const worker = this.workers.get(input.workerId);
    const model = this.models.get(worker.modelId);
    if (worker.status !== 'active' || !model.enabled)
      throw new PlatformError('WORKER_DISABLED', '数字人或模型已停用', 409);
    if (model.provider !== 'demo' && !this.deps.credentials.available(model.apiKeyRef))
      throw new PlatformError('MODEL_NOT_CONFIGURED', '请先在服务端 .env 配置模型 API Key', 409);
    const policy = this.policies.get(worker.permissionPolicyId);
    const snapshot: ExecutionSnapshot = {
      worker,
      model,
      policy,
      skills: worker.skillIds.map((id) => this.skills.get(id)),
      toolVersions: Object.fromEntries(
        worker.toolIds.flatMap((id) => {
          const source = this.tools.get(id).source;
          return source ? [[id, source.version]] : [];
        }),
      ),
    };
    const task = await this.deps.store.createTask({
      id: crypto.randomUUID(),
      sessionId: input.sessionId ?? crypto.randomUUID(),
      runId: crypto.randomUUID(),
      input,
      requestKey,
      requestDigest,
      snapshot,
    });
    this.wake();
    return task;
  }
  async task(id: string) {
    const t = await this.deps.store.getTask(id);
    if (!t) throw new PlatformError('NOT_FOUND', '任务不存在', 404);
    return t;
  }
  async run(id: string) {
    const r = await this.deps.store.getRun(id);
    if (!r) throw new PlatformError('NOT_FOUND', '运行不存在', 404);
    return r;
  }
  async session(id: string) {
    const session = await this.deps.store.getSession(id);
    if (!session) throw new PlatformError('NOT_FOUND', '会话不存在', 404);
    return session;
  }
  async cancel(id: string) {
    const run = await this.run(id);
    if (isTerminal(run.status)) return run;
    if (this.active?.runId === id) {
      this.active.cancelled = true;
      this.active.controller.abort();
    } else await this.deps.store.finish(id, 'cancelled', {});
    return this.run(id);
  }
  wake() {
    if (this.stopped || this.dispatching) return;
    this.dispatching = this.dispatch()
      .catch(() => this.deps.logger.error({ code: 'DISPATCH_FAILED' }, '运行派发失败'))
      .finally(() => {
        this.dispatching = null;
      });
  }
  private async dispatch() {
    while (!this.stopped) {
      const run = await this.deps.store.claimNext();
      if (!run) return;
      const task = await this.task(run.taskId);
      if (isTerminal((await this.run(run.id)).status)) continue;
      const controller = new AbortController();
      const state = { runId: run.id, controller, cancelled: false };
      this.active = state;
      const timeoutSignal = AbortSignal.timeout(this.deps.limits.timeoutMs);
      const signal = AbortSignal.any([controller.signal, timeoutSignal]);
      try {
        await this.deps.files.ensureWorkspace(task.workerId, task.id);
        const history = await this.deps.store.sessionHistory(task.sessionId, task.id);
        const plan = buildPlan(run, task, this.deps.limits, history);
        const definitions = run.snapshot.worker.toolIds
          .map((id) => {
            const version = run.snapshot.toolVersions?.[id];
            return (version && this.toolHistory.get(id + '@' + version)) || this.tools.get(id);
          })
          .filter(
            (t) =>
              t.enabled &&
              run.snapshot.policy.allowedToolIds.includes(t.id) &&
              (t.id !== 'read_file' || task.upload),
          );
        const tools = authorizedTools(
          definitions,
          {
            taskId: task.id,
            runId: run.id,
            workerId: task.workerId,
            fileId: task.upload?.id ?? null,
            snapshot: run.snapshot,
            signal,
          },
          this.deps.store,
        );
        await this.deps.store.appendEvent(run.id, {
          type: 'run.started',
          payload: {
            workerName: run.snapshot.worker.name,
            modelName: run.snapshot.model.name,
            mode: run.snapshot.model.provider === 'demo' ? 'demo' : 'live',
          },
        });
        const result = await this.deps.runtime.execute(
          plan,
          tools,
          async (event) => {
            signal.throwIfAborted();
            await this.deps.store.appendEvent(run.id, event);
          },
          signal,
        );
        signal.throwIfAborted();
        await this.deps.store.finish(run.id, 'succeeded', result);
      } catch (error) {
        if (state.cancelled) await this.deps.store.finish(run.id, 'cancelled', {});
        else {
          const safe = timeoutSignal.aborted
            ? new PlatformError('RUN_TIMEOUT', '执行超时，请缩小任务后重试')
            : this.stopped
              ? new PlatformError('PROCESS_INTERRUPTED', '服务关闭导致执行中断')
              : error instanceof PlatformError
                ? error
                : new PlatformError('RUN_FAILED', '执行失败，请检查模型配置后重试');
          await this.deps.store.finish(run.id, 'failed', {
            error: { code: safe.code, message: safe.message },
          });
          this.deps.logger.error({ runId: run.id, code: safe.code }, '任务执行失败');
        }
      } finally {
        this.active = null;
      }
    }
  }
  async stop() {
    this.stopped = true;
    if (this.tick) clearInterval(this.tick);
    this.active?.controller.abort();
    await this.dispatching;
  }
}
