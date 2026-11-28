import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { mcpServerConfigSchema } from '@digital-worker/contracts';
import { PlatformError, type McpSettingsState, type McpSettingsStore } from '@digital-worker/core';
const schema = z
  .object({
    revision: z.number().int().nonnegative(),
    entries: z.array(
      z
        .object({
          name: z.string().min(1).max(80),
          config: mcpServerConfigSchema,
          workerIds: z.array(z.string()),
          configurationRevision: z.number().int().nonnegative().default(0),
        })
        .strict(),
    ),
    secrets: z.record(z.string(), z.string()),
  })
  .strict();
export class LocalMcpSettingsStore implements McpSettingsStore {
  constructor(private path: string) {}
  async load(): Promise<McpSettingsState | null> {
    try {
      const state = schema.parse(JSON.parse(await readFile(this.path, 'utf8')));
      if (new Set(state.entries.map((entry) => entry.config.id)).size !== state.entries.length)
        throw new Error('Duplicate service');
      await chmod(this.path, 0o600);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new PlatformError('MCP_SETTINGS_INVALID', '本地 MCP 配置无法读取，请检查配置文件');
    }
  }
  async save(state: McpSettingsState) {
    const temporary = this.path + '.' + crypto.randomUUID() + '.tmp';
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(schema.parse(state), null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, this.path);
    } catch {
      throw new PlatformError('MCP_SETTINGS_SAVE_FAILED', 'MCP 配置保存失败，原配置保持不变', 500);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
