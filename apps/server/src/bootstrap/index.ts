import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AgentPlatform, type AgentRuntime } from '@digital-worker/core';
import {
  loadConfiguration,
  SqlitePlatformStore,
  LocalFileStore,
  EnvironmentCredentials,
  builtinTools,
  createLogger,
} from '@digital-worker/infrastructure';
import { OpenAIAgentRuntime } from '@digital-worker/agent-runtime';

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
  const platform = new AgentPlatform({
    catalog,
    limits,
    store,
    files,
    credentials,
    logger,
    runtime,
    tools: builtinTools(store, files),
  });
  try {
    await platform.start();
  } catch (error) {
    store.close();
    throw error;
  }
  return { platform, store, limits, logger };
}
