import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  AgentPlatform,
  McpManagement,
  managedMcpTokenRef,
  type AgentRuntime,
  type CredentialResolver,
  type McpConnector,
} from '@digital-worker/core';
import {
  loadConfiguration,
  SqlitePlatformStore,
  LocalFileStore,
  EnvironmentCredentials,
  builtinTools,
  createLogger,
  LocalMcpSettingsStore,
} from '@digital-worker/infrastructure';
import { OpenAIAgentRuntime, McpToolRegistry } from '@digital-worker/agent-runtime';

export interface BootstrapOptions {
  root: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  runtime?: AgentRuntime;
  limits?: { timeoutMs?: number; maxTurns?: number };
}
export async function bootstrap(options: BootstrapOptions) {
  const { root } = options;
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? resolve(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const loaded = await loadConfiguration(root, env);
  const { catalog } = loaded;
  const limits = { ...loaded.limits, ...options.limits };
  const store = new SqlitePlatformStore(resolve(dataDir, 'platform.sqlite'));
  const files = new LocalFileStore(
    resolve(dataDir, 'uploads'),
    options.dataDir ? resolve(dataDir, 'workspaces') : resolve(root, 'workspaces'),
  );
  const credentials = new EnvironmentCredentials(env);
  const logger = createLogger();
  const runtime = options.runtime ?? new OpenAIAgentRuntime(credentials);
  const scopedCredentials = (secrets: Record<string, string>): CredentialResolver => {
    const values = new Map(
      Object.entries(secrets).map(([id, token]) => [managedMcpTokenRef(id), token]),
    );
    return {
      available: (ref) => Boolean(values.get(ref)) || credentials.available(ref),
      resolve: (ref) => values.get(ref) ?? credentials.resolve(ref),
    };
  };
  const connector: McpConnector = {
    async inspect(config, secrets) {
      const registry = new McpToolRegistry([], scopedCredentials(secrets), root);
      try {
        return await registry.inspect(config);
      } finally {
        await registry.close();
      }
    },
    async prepare(config, secrets) {
      const registry = new McpToolRegistry([config], scopedCredentials(secrets), root);
      try {
        const tools = await registry.discover();
        return {
          tools,
          info: tools.map((tool) => ({
            id: tool.id,
            name: tool.source!.toolName,
            description: tool.description,
            readOnly: true,
            supported: true,
            inputSchema: tool.inputSchema!,
          })),
          close: () => registry.close(),
        };
      } catch (error) {
        await registry.close();
        throw error;
      }
    },
  };
  const baseCatalog = {
    ...catalog,
    workers: catalog.workers.map((worker) => ({
      ...worker,
      mcpServerIds: [],
      toolIds: worker.toolIds.filter((id) => !id.startsWith('mcp_')),
    })),
    policies: catalog.policies.map((policy) => ({
      ...policy,
      allowedToolIds: policy.allowedToolIds.filter((id) => !id.startsWith('mcp_')),
    })),
  };
  const platform = new AgentPlatform({
    catalog: baseCatalog,
    limits,
    store,
    files,
    credentials,
    logger,
    runtime,
    tools: builtinTools(store, files),
  });
  const mcp = new McpManagement(
    new LocalMcpSettingsStore(resolve(dataDir, 'mcp-settings.json')),
    connector,
    platform,
  );
  try {
    await mcp.initialize(
      loaded.mcpServers.map((config) => ({
        config,
        name: config.id === 'reference' ? '内置资料服务' : config.id,
        workerIds: catalog.workers
          .filter((worker) => worker.mcpServerIds.includes(config.id))
          .map((worker) => worker.id),
      })),
    );
    await platform.start();
    return { platform, store, limits, logger, mcp };
  } catch (error) {
    await mcp.close();
    store.close();
    throw error;
  }
}
