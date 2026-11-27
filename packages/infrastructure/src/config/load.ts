import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  workerConfigSchema,
  modelConfigSchema,
  policySchema,
  type Catalog,
  type Skill,
  PlatformError,
} from '@digital-worker/core';
import { confined } from '../files/store.js';

const settingsSchema = z.object({
  maxTurns: z.number().int().min(1).max(30),
  timeoutMs: z.number().int().min(100).max(600_000),
  maxUploadBytes: z.number().int().min(1).max(2_097_152),
});
const yaml = async (path: string) => parse(await readFile(path, 'utf8'));
async function resources(root: string, relative = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const e of await readdir(join(root, relative), { withFileTypes: true })) {
    const key = relative ? `${relative}/${e.name}` : e.name;
    if (e.isSymbolicLink()) throw new PlatformError('RESOURCE_FORBIDDEN', '技能资源不允许符号链接');
    if (e.isDirectory()) Object.assign(files, await resources(root, key));
    else if (/\.(md|txt|json|yaml|yml|csv)$/i.test(key)) {
      const text = await readFile(await confined(root, key), 'utf8');
      if (Buffer.byteLength(text) > 2_097_152)
        throw new PlatformError('SKILL_TOO_LARGE', '技能引用文件过大');
      files[key] = text;
    }
  }
  return files;
}
export async function loadConfiguration(root: string, env: NodeJS.ProcessEnv = process.env) {
  const limits = settingsSchema.parse(await yaml(resolve(root, 'config/platform.yaml')));
  const models = z.array(modelConfigSchema).parse(await yaml(resolve(root, 'config/models.yaml')));
  for (const m of models) {
    if (m.id === 'deepseek') {
      m.model = env.DEEPSEEK_MODEL?.trim() || m.model;
      m.baseURL = env.DEEPSEEK_BASE_URL?.trim() || m.baseURL;
    }
    if (m.id === 'openai') m.model = env.OPENAI_MODEL?.trim() || m.model;
    modelConfigSchema.parse(m);
  }
  const policies = z
    .array(policySchema)
    .parse(await yaml(resolve(root, 'config/permissions.yaml')));
  const workerRoot = resolve(root, 'resources/workers');
  const workers = [];
  for (const name of (await readdir(workerRoot)).filter((n) => /\.ya?ml$/.test(n)).sort())
    workers.push(workerConfigSchema.parse(await yaml(await confined(workerRoot, name))));
  const skillRoot = resolve(root, 'resources/skills');
  const skills: Skill[] = [];
  for (const e of (await readdir(skillRoot, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!e.isDirectory()) continue;
    const rootDir = await confined(skillRoot, e.name);
    const content = await readFile(await confined(rootDir, 'SKILL.md'), 'utf8');
    if (Buffer.byteLength(content) > 2_097_152)
      throw new PlatformError('SKILL_TOO_LARGE', '技能正文过大');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
    if (!match) throw new PlatformError('INVALID_SKILL', '技能缺少 YAML 元数据');
    const meta = z
      .object({
        name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
        description: z.string().min(1),
        displayName: z.string().optional(),
      })
      .parse(parse(match[1]));
    const refs: Record<string, string> = {};
    for (const dir of ['references', 'assets']) {
      const exists = (await readdir(rootDir)).includes(dir);
      if (!exists) continue;
      const dirPath = await confined(rootDir, dir);
      for (const [key, value] of Object.entries(await resources(dirPath)))
        refs[`${dir}/${key}`] = value;
    }
    skills.push({
      id: meta.name,
      name: meta.displayName || meta.name,
      description: meta.description,
      body: match[2].trim(),
      resources: refs,
      version: createHash('sha256')
        .update(content + JSON.stringify(refs))
        .digest('hex'),
    });
  }
  if (env.AGENT_DEMO_MODE === 'true') {
    models.push({
      id: 'local-demo',
      name: '本地演示 · 无模型调用',
      provider: 'demo',
      protocol: 'chat_completions',
      baseURL: 'http://localhost',
      model: 'deterministic-demo',
      apiKeyRef: 'env:UNUSED_DEMO_KEY',
      enabled: true,
      maxOutputTokens: 4096,
    });
    for (const w of workers) w.modelId = 'local-demo';
  }
  const catalog: Catalog = { models, workers, policies, skills };
  return { catalog, limits };
}
