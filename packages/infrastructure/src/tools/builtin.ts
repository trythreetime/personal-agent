import { z } from 'zod';
import {
  PlatformError,
  type FileStore,
  type PlatformStore,
  type ToolDefinition,
} from '@digital-worker/core';
const paging = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(32_000).default(32_000),
};
function page(text: string, offset: unknown, limit: unknown) {
  const start = Number(offset);
  const end = Math.min(text.length, start + Number(limit));
  if (start > text.length) throw new PlatformError('INVALID_TOOL_INPUT', '读取位置超出文件末尾');
  return {
    content: text.slice(start, end),
    offset: start,
    nextOffset: end,
    totalChars: text.length,
    truncated: end < text.length,
  };
}
export function builtinTools(store: PlatformStore, files: FileStore): ToolDefinition[] {
  const common = { riskLevel: 'low' as const, requiresApproval: false, enabled: true };
  return [
    {
      ...common,
      id: 'read_file',
      description: '读取当前任务绑定的文本文件。超过一页时按 nextOffset 继续读取。',
      parameters: z.object({ fileId: z.string(), ...paging }),
      async execute(args, ctx) {
        if (!ctx.fileId || !ctx.snapshot.policy.readTaskFile || args.fileId !== ctx.fileId)
          throw new PlatformError('FILE_NOT_AUTHORIZED', '无权读取此文件', 403);
        const upload = await store.getUpload(ctx.fileId);
        const current = await store.getTask(ctx.taskId);
        const owner = upload?.taskId ? await store.getTask(upload.taskId) : null;
        if (
          !upload ||
          !current ||
          !owner ||
          owner.sessionId !== current.sessionId ||
          current.workerId !== ctx.workerId ||
          owner.workerId !== ctx.workerId ||
          ctx.snapshot.worker.id !== ctx.workerId
        )
          throw new PlatformError('FILE_NOT_AUTHORIZED', '文件不属于当前数字人的会话', 403);
        return page(await files.read(upload.storageKey), args.offset, args.limit);
      },
    },
    {
      ...common,
      id: 'load_skill',
      description: '按技能 ID 读取已绑定技能的 SKILL.md 正文。支持分段读取。',
      parameters: z.object({ skillId: z.string(), ...paging }),
      async execute(args, ctx) {
        const skill = ctx.snapshot.skills.find((s) => s.id === args.skillId);
        if (!skill || !ctx.snapshot.worker.skillIds.includes(skill.id))
          throw new PlatformError('SKILL_NOT_AUTHORIZED', '技能未绑定到当前数字人', 403);
        return {
          skillId: skill.id,
          version: skill.version,
          ...page(skill.body, args.offset, args.limit),
          resources: Object.keys(skill.resources),
        };
      },
    },
    {
      ...common,
      id: 'read_skill_resource',
      description: '读取已绑定技能 references 或 assets 中的文本资源。',
      parameters: z.object({ skillId: z.string(), path: z.string(), ...paging }),
      async execute(args, ctx) {
        const skill = ctx.snapshot.skills.find((s) => s.id === args.skillId);
        const path = String(args.path);
        if (
          !ctx.snapshot.policy.readSkillResources ||
          !skill ||
          !ctx.snapshot.worker.skillIds.includes(skill.id) ||
          !Object.hasOwn(skill.resources, path)
        )
          throw new PlatformError('RESOURCE_FORBIDDEN', '技能资源未授权', 403);
        return page(skill.resources[path], args.offset, args.limit);
      },
    },
  ];
}
