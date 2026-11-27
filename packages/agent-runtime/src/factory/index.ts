import { Agent, tool } from '@openai/agents';
import { z } from 'zod';
import type { CredentialResolver, ExecutionPlan, RuntimeTool } from '@digital-worker/core';
import { createModel } from '../models/index.js';
export function createAgent(
  plan: ExecutionPlan,
  tools: RuntimeTool[],
  credentials: CredentialResolver,
) {
  return new Agent({
    name: plan.snapshot.worker.name,
    instructions: plan.instructions,
    model: createModel(plan.model, credentials),
    modelSettings: {
      maxTokens: plan.model.maxOutputTokens,
      preserveRawUsage: true,
      ...(plan.model.thinkingMode
        ? { providerData: { thinking: { type: plan.model.thinkingMode } } }
        : {}),
    },
    tools: tools.map((t) => {
      if (plan.model.provider !== 'openai-compatible')
        return tool({
          name: t.id,
          description: t.description,
          parameters: t.parameters,
          execute: (args) => t.execute(args),
          errorFunction: null,
        });
      const schema = z.toJSONSchema(t.parameters);
      // 兼容服务不启用供应商 strict 扩展；参数仍由 Core 的 Zod Schema 校验。
      // 重新构造普通 JSON 对象，避免将 Zod 附带的 Standard Schema 元信息传给 SDK。
      return tool({
        name: t.id,
        description: t.description,
        strict: false,
        parameters: {
          type: 'object',
          properties: schema.properties ?? {},
          required: schema.required ?? [],
          additionalProperties: true,
        },
        execute: (args) => t.execute(args),
        errorFunction: null,
      });
    }),
  });
}
