import { setTimeout } from 'node:timers/promises';
import { emptyUsage, type AgentRuntime } from '../../packages/core/src/index.js';

export class FixtureRuntime implements AgentRuntime {
  async execute(...[plan, tools, emit, signal]: Parameters<AgentRuntime['execute']>) {
    signal.throwIfAborted();
    await tools
      .find((t) => t.id === 'load_skill')!
      .execute({ skillId: plan.snapshot.skills[0].id });
    const file = plan.fileId
      ? ((await tools.find((t) => t.id === 'read_file')!.execute({ fileId: plan.fileId })) as {
          content: string;
        })
      : { content: plan.input };
    const output = `# 验收结果\n\n${file.content}\n\n任务要求：${plan.input}`;
    await emit({ type: 'output.delta', payload: { delta: output } });
    return { output, usage: emptyUsage() };
  }
}
export class BlockingRuntime implements AgentRuntime {
  async execute(...[, , , signal]: Parameters<AgentRuntime['execute']>) {
    await setTimeout(10_000, undefined, { signal });
    return { output: '不应执行到此处', usage: emptyUsage() };
  }
}
