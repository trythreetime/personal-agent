import { Runner, setTracingDisabled, user, assistant } from '@openai/agents';
import {
  PlatformError,
  emptyUsage,
  type AgentRuntime,
  type CredentialResolver,
} from '@digital-worker/core';
import { createAgent } from '../factory/index.js';
import { DemoRuntime } from './demo.js';

export class OpenAIAgentRuntime implements AgentRuntime {
  private runner = new Runner({ tracingDisabled: true, traceIncludeSensitiveData: false });
  private demo = new DemoRuntime();
  constructor(private credentials: CredentialResolver) {
    setTracingDisabled(true);
  }
  async execute(...args: Parameters<AgentRuntime['execute']>) {
    const [plan, tools, emit, signal] = args;
    if (plan.model.provider === 'demo') return this.demo.execute(...args);
    let buffer = '';
    let lastFlush = Date.now();
    const flush = async () => {
      if (buffer) {
        const delta = buffer;
        buffer = '';
        await emit({ type: 'output.delta', payload: { delta } });
        lastFlush = Date.now();
      }
    };
    // 工具边界前刷新文本，保证工具与输出的持久化顺序。
    const wrapped = tools.map((t) => ({
      ...t,
      execute: async (input: unknown) => {
        await flush();
        return t.execute(input);
      },
    }));
    try {
      const agent = createAgent(plan, wrapped, this.credentials);
      const input = plan.history.length
        ? [
            ...plan.history.map((message) =>
              message.role === 'user' ? user(message.content) : assistant(message.content),
            ),
            user(plan.input),
          ]
        : plan.input;
      const result = await this.runner.run(agent, input, {
        stream: true,
        signal,
        maxTurns: plan.limits.maxTurns,
      });
      for await (const event of result) {
        signal.throwIfAborted();
        if (event.type === 'raw_model_stream_event' && event.data.type === 'output_text_delta') {
          buffer += event.data.delta;
          if (Date.now() - lastFlush >= 100 || buffer.length >= 4096) await flush();
        }
      }
      await result.completed;
      await flush();
      const responses = result.rawResponses;
      const total = (a: string, b: string) => {
        const counts = responses.map((r) => r.rawUsage?.[a] ?? r.rawUsage?.[b]);
        return counts.length && counts.every((n) => typeof n === 'number')
          ? counts.reduce<number>((sum, n) => sum + Number(n), 0)
          : null;
      };
      const usage = responses.length
        ? {
            inputTokens: total('prompt_tokens', 'input_tokens'),
            outputTokens: total('completion_tokens', 'output_tokens'),
          }
        : emptyUsage();
      await emit({ type: 'usage.updated', payload: usage });
      const output = result.finalOutput;
      if (typeof output !== 'string' || !output.trim())
        throw new PlatformError('EMPTY_MODEL_OUTPUT', '模型未返回有效文本');
      return { output, usage };
    } catch (error) {
      if (signal.aborted || error instanceof PlatformError) throw error;
      const info = error as { name?: string; status?: number };
      if (info.name === 'MaxTurnsExceededError')
        throw new PlatformError('MAX_TURNS_EXCEEDED', '达到执行轮次上限，请缩小任务后重试');
      if (info.status === 401 || info.status === 403)
        throw new PlatformError('MODEL_AUTH_FAILED', '模型凭证无效或权限不足');
      if (info.status === 429)
        throw new PlatformError('MODEL_RATE_LIMIT', '模型请求受限，请稍后重试');
      throw new PlatformError('MODEL_REQUEST_FAILED', '模型调用失败，请检查模型、地址及网络连接');
    }
  }
}
