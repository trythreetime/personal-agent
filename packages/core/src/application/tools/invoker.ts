import type { PlatformStore } from '../../ports/index.js';
import {
  PlatformError,
  type ToolContext,
  type ToolDefinition,
  type RuntimeTool,
} from '../../domain/index.js';
import { isTerminal } from '@digital-worker/contracts';

export function authorizedTools(
  definitions: ToolDefinition[],
  context: ToolContext,
  store: PlatformStore,
): RuntimeTool[] {
  return definitions.map((tool) => ({
    id: tool.id,
    description: tool.description,
    parameters: tool.parameters,
    inputSchema: tool.inputSchema,
    async execute(input) {
      const callId = crypto.randomUUID();
      const start = Date.now();
      const emit = (type: 'tool.denied' | 'tool.failed', code: string) =>
        store.appendEvent(context.runId, { type, payload: { callId, toolId: tool.id, code } });
      try {
        context.signal.throwIfAborted();
        const run = await store.getRun(context.runId);
        if (!run || isTerminal(run.status))
          throw new PlatformError('RUN_NOT_ACTIVE', '运行已结束', 409);
        const { worker, policy } = context.snapshot;
        if (
          !tool.enabled ||
          !worker.toolIds.includes(tool.id) ||
          !policy.allowedToolIds.includes(tool.id)
        )
          throw new PlatformError('TOOL_NOT_AUTHORIZED', '工具未获授权', 403);
        if (tool.source && !(worker.mcpServerIds ?? []).includes(tool.source.serverId))
          throw new PlatformError('MCP_NOT_AUTHORIZED', 'MCP 服务未绑定到当前数字人', 403);
        if (tool.source && context.snapshot.toolVersions?.[tool.id] !== tool.source.version)
          throw new PlatformError(
            'TOOL_CONFIGURATION_CHANGED',
            '工具配置已变更，请新建任务后重试',
            409,
          );
        if (tool.requiresApproval || tool.riskLevel === 'high')
          throw new PlatformError('APPROVAL_NOT_SUPPORTED', '首版不支持需审批或高风险工具', 403);
        const parsed = tool.parameters.safeParse(input);
        if (!parsed.success) throw new PlatformError('INVALID_TOOL_INPUT', '工具参数无效');
        await store.appendEvent(context.runId, {
          type: 'tool.started',
          payload: {
            callId,
            toolId: tool.id,
            summary: tool.source ? '调用已授权的 MCP 只读工具' : '只读访问已授权资源',
          },
        });
        const result = await tool.execute(parsed.data, context);
        context.signal.throwIfAborted();
        const durationMs = Date.now() - start;
        await store.recordTool({
          runId: context.runId,
          callId,
          toolId: tool.id,
          status: 'completed',
          summary: tool.source ? 'MCP 调用完成' : '读取完成',
          durationMs,
        });
        await store.appendEvent(context.runId, {
          type: 'tool.completed',
          payload: {
            callId,
            toolId: tool.id,
            durationMs,
            summary: tool.source ? 'MCP 调用完成' : '读取完成',
          },
        });
        return result;
      } catch (error) {
        if (context.signal.aborted) throw error;
        const safe =
          error instanceof PlatformError
            ? error
            : new PlatformError('TOOL_EXECUTION_FAILED', '工具执行失败');
        const denied = safe.status === 403;
        await store.recordTool({
          runId: context.runId,
          callId,
          toolId: tool.id,
          status: denied ? 'denied' : 'failed',
          summary: safe.code,
          durationMs: Date.now() - start,
        });
        await emit(denied ? 'tool.denied' : 'tool.failed', safe.code);
        return { error: { code: safe.code, message: safe.message } };
      }
    },
  }));
}
