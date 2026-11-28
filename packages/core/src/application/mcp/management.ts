import {
  mcpWriteSchema,
  mcpProbeSchema,
  type McpListDto,
  type McpServerDto,
  type McpWrite,
  type McpProbe,
} from '@digital-worker/contracts';
import { PlatformError } from '../../domain/index.js';
import type {
  McpSettingsStore,
  McpSettingsState,
  McpConnector,
  McpToolBundle,
  ManagedMcpEntry,
} from '../../ports/index.js';
import type { AgentPlatform } from '../platform.js';

export const managedMcpTokenRef = (id: string) =>
  'env:MCP_WEB_' + id.replaceAll('-', '_').toUpperCase() + '_TOKEN';
export class McpManagement {
  private state: McpSettingsState = { revision: 0, entries: [], secrets: {} };
  private statuses = new Map<string, Pick<McpServerDto, 'state' | 'error'>>();
  private current = new Map<string, McpToolBundle>();
  private bundles = new Set<McpToolBundle>();
  private tail = Promise.resolve();
  private stopped = false;
  constructor(
    private store: McpSettingsStore,
    private connector: McpConnector,
    private platform: AgentPlatform,
  ) {}
  async initialize(seed: ManagedMcpEntry[]) {
    this.state = (await this.store.load()) ?? { revision: 0, entries: seed, secrets: {} };
    for (const entry of this.state.entries) {
      if (!entry.config.enabled) {
        this.statuses.set(entry.config.id, { state: 'disabled', error: null });
        continue;
      }
      try {
        const bundle = await this.prepare(entry, this.state.secrets);
        this.current.set(entry.config.id, bundle);
        this.bundles.add(bundle);
        this.statuses.set(entry.config.id, { state: 'ready', error: null });
      } catch (error) {
        const safe =
          error instanceof PlatformError
            ? error
            : new PlatformError('MCP_CONFIGURATION_FAILED', 'MCP 配置加载失败');
        this.statuses.set(entry.config.id, {
          state: 'error',
          error: { code: safe.code, message: safe.message },
        });
      }
    }
    this.apply();
    await this.store.save(this.state);
  }
  list(): McpListDto {
    return {
      revision: this.state.revision,
      items: this.state.entries.map((entry) => ({
        name: entry.name,
        config: entry.config,
        workerIds: entry.workerIds,
        tools: this.current.get(entry.config.id)?.info ?? [],
        ...(this.statuses.get(entry.config.id) ?? { state: 'disabled' as const, error: null }),
        hasManagedToken: Boolean(this.state.secrets[entry.config.id]),
      })),
    };
  }
  private validateWorkers(entry: ManagedMcpEntry) {
    const ids = new Set(this.platform.listWorkers().map((worker) => worker.id));
    if (entry.workerIds.some((id) => !ids.has(id)))
      throw new PlatformError('MCP_WORKER_NOT_FOUND', '绑定的数字人不存在');
  }
  private async prepare(entry: ManagedMcpEntry, secrets: Record<string, string>) {
    this.validateWorkers(entry);
    if (!entry.config.allowedTools.length)
      throw new PlatformError('MCP_TOOLS_REQUIRED', '启用服务前请至少选择一个只读工具');
    const bundle = await this.connector.prepare(entry.config, secrets);
    // A credential-only edit must have its own identity too. Keep raw schema
    // fingerprints inside the connector and persist only this non-secret revision.
    return {
      ...bundle,
      tools: bundle.tools.map((tool) => ({
        ...tool,
        source: tool.source && {
          ...tool.source,
          version: tool.source.version + ':' + (entry.configurationRevision ?? 0),
        },
      })),
    };
  }
  private apply() {
    this.platform.applyMcp(
      this.state.entries.flatMap((entry) => {
        const bundle = this.current.get(entry.config.id);
        return entry.config.enabled && bundle
          ? [{ serverId: entry.config.id, workerIds: entry.workerIds, tools: bundle.tools }]
          : [];
      }),
    );
  }
  private draft(input: McpProbe) {
    const entry: ManagedMcpEntry = {
      config: structuredClone(input.config),
      name: input.name,
      workerIds: [...new Set(input.workerIds)],
    };
    const secrets = { ...this.state.secrets };
    if (input.bearerToken && input.clearBearerToken)
      throw new PlatformError('MCP_TOKEN_CONFLICT', '不能同时填写和清除凭证');
    if (
      (input.bearerToken || input.clearBearerToken) &&
      entry.config.transport !== 'streamable-http'
    )
      throw new PlatformError('MCP_TOKEN_TRANSPORT', '直接填写的 Bearer 凭证仅用于 HTTP 服务');
    if (input.bearerToken && entry.config.transport === 'streamable-http') {
      secrets[entry.config.id] = input.bearerToken;
      entry.config.bearerTokenRef = managedMcpTokenRef(entry.config.id);
    }
    if (input.clearBearerToken) {
      delete secrets[entry.config.id];
      if (
        entry.config.transport === 'streamable-http' &&
        entry.config.bearerTokenRef === managedMcpTokenRef(entry.config.id)
      )
        delete entry.config.bearerTokenRef;
    }
    if (entry.config.transport === 'stdio') delete secrets[entry.config.id];
    this.validateWorkers(entry);
    return { entry, secrets };
  }
  async probe(input: McpProbe) {
    if (this.stopped) throw new PlatformError('SERVICE_STOPPING', '服务正在关闭', 503);
    const { entry, secrets } = this.draft(mcpProbeSchema.parse(input));
    return { tools: await this.connector.inspect(entry.config, secrets) };
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(() => {
      if (this.stopped) throw new PlatformError('SERVICE_STOPPING', '服务正在关闭', 503);
      return action();
    });
    this.tail = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }
  private revision(expected: number) {
    if (this.state.revision !== expected)
      throw new PlatformError('MCP_REVISION_CONFLICT', '配置已被其他页面更新，请刷新后再保存', 409);
  }
  save(input: McpWrite, updateId?: string) {
    return this.serial(async () => {
      input = mcpWriteSchema.parse(input);
      this.revision(input.expectedRevision);
      const exists = this.state.entries.some((entry) => entry.config.id === input.config.id);
      if (updateId && (updateId !== input.config.id || !exists))
        throw new PlatformError('MCP_NOT_FOUND', '服务不存在或服务 ID 不可修改', 404);
      if (!updateId && exists) throw new PlatformError('MCP_ID_EXISTS', '服务 ID 已存在', 409);
      const { entry, secrets } = this.draft(input);
      entry.configurationRevision = this.state.revision + 1;
      let bundle: McpToolBundle | undefined;
      if (entry.config.enabled) bundle = await this.prepare(entry, secrets);
      const next: McpSettingsState = {
        revision: this.state.revision + 1,
        secrets,
        entries: exists
          ? this.state.entries.map((old) => (old.config.id === entry.config.id ? entry : old))
          : [...this.state.entries, entry],
      };
      try {
        await this.store.save(next);
      } catch (error) {
        await bundle?.close();
        throw error;
      }
      this.state = next;
      this.current.delete(entry.config.id);
      if (bundle) {
        this.current.set(entry.config.id, bundle);
        this.bundles.add(bundle);
      }
      this.statuses.set(entry.config.id, {
        state: entry.config.enabled ? 'ready' : 'disabled',
        error: null,
      });
      this.apply();
      return this.list();
    });
  }
  remove(id: string, expectedRevision: number) {
    return this.serial(async () => {
      this.revision(expectedRevision);
      if (!this.state.entries.some((entry) => entry.config.id === id))
        throw new PlatformError('MCP_NOT_FOUND', 'MCP 服务不存在', 404);
      const secrets = { ...this.state.secrets };
      delete secrets[id];
      const next = {
        revision: this.state.revision + 1,
        secrets,
        entries: this.state.entries.filter((entry) => entry.config.id !== id),
      };
      await this.store.save(next);
      this.state = next;
      this.current.delete(id);
      this.statuses.delete(id);
      this.apply();
      return this.list();
    });
  }
  async close() {
    this.stopped = true;
    await this.tail;
    await Promise.allSettled([...this.bundles].map((bundle) => bundle.close()));
  }
}
