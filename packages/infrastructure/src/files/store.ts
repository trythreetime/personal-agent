import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PlatformError, type FileStore } from '@digital-worker/core';

export async function confined(root: string, relative: string) {
  if (
    !relative ||
    relative.includes('\0') ||
    relative.includes('\\') ||
    relative.split('/').includes('..')
  )
    throw new PlatformError('RESOURCE_FORBIDDEN', '资源路径不允许', 403);
  const [base, target] = await Promise.all([realpath(root), realpath(resolve(root, relative))]);
  if (!target.startsWith(base + sep))
    throw new PlatformError('RESOURCE_FORBIDDEN', '资源超出授权范围', 403);
  return target;
}
export class LocalFileStore implements FileStore {
  constructor(
    private uploadRoot: string,
    private workspaceRoot: string,
  ) {}
  async save(data: Uint8Array) {
    await mkdir(this.uploadRoot, { recursive: true });
    const storageKey = randomUUID();
    await writeFile(resolve(this.uploadRoot, storageKey), data, { flag: 'wx', mode: 0o600 });
    return { storageKey, hash: createHash('sha256').update(data).digest('hex') };
  }
  async read(storageKey: string) {
    return readFile(await confined(this.uploadRoot, storageKey), 'utf8');
  }
  async remove(storageKey: string) {
    if (/^[a-f0-9-]{36}$/.test(storageKey))
      await rm(resolve(this.uploadRoot, storageKey), { force: true });
  }
  async ensureWorkspace(workerId: string, taskId: string) {
    if (!/^[\w-]+$/.test(workerId) || !/^[\w-]+$/.test(taskId))
      throw new PlatformError('RESOURCE_FORBIDDEN', '工作目录无效', 403);
    await mkdir(resolve(this.workspaceRoot, workerId, 'tasks', taskId), { recursive: true });
  }
}
