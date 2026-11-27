import { setTimeout } from 'node:timers/promises';
import { PlatformError, emptyUsage, type AgentRuntime } from '@digital-worker/core';

// 显式启用的固定流程，用于无凭证的本地体验和确定性验收，不模拟模型用量。
export class DemoRuntime implements AgentRuntime {
  async execute(...[plan, tools, emit, signal]: Parameters<AgentRuntime['execute']>) {
    const invoke = async (id: string, args: unknown) => {
      const tool = tools.find((t) => t.id === id);
      if (!tool) throw new PlatformError('DEMO_TOOL_MISSING', '演示需要绑定技能加载与文件读取工具');
      const value = (await tool.execute(args)) as Record<string, unknown>;
      if (value.error) throw new PlatformError('DEMO_TOOL_FAILED', '演示工具调用失败');
      return value;
    };
    await setTimeout(180, undefined, { signal });
    if (plan.snapshot.skills.length)
      await invoke('load_skill', { skillId: plan.snapshot.skills[0].id });
    let content = '';
    let offset = 0;
    if (plan.fileId)
      do {
        const result = await invoke('read_file', { fileId: plan.fileId, offset });
        content += String(result.content);
        offset = Number(result.nextOffset);
        if (!result.truncated) break;
      } while (offset < 2_097_152);
    const lines = content
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((s) => s.replace(/^[#*>\-\d.\s]+/, '').slice(0, 140));
    const output = [
      plan.fileId ? '# 需求分析预览' : '# 对话预览',
      '> 当前为本地演示模式。以下内容由固定模板与文档摘录组成，未调用大模型，不代表真实智能分析结果。',
      '## 需求摘要',
      plan.fileId
        ? `已读取 **${plan.fileName}**，共 ${content.length.toLocaleString('zh-CN')} 个字符。`
        : '本次是文字会话，没有上传文档。',
      `本次要求：${plan.input}`,
      ...(plan.history.length
        ? [`本会话已有 ${plan.history.length / 2} 轮已完成对话，以下为本次固定流程预览。`]
        : []),
      '## 文档摘录',
      ...lines.map((s) => `- ${s}`),
      '## 功能列表',
      '请接入真实模型，依据全文识别功能、优先级与约束。演示流程只验证文件和技能的受控调用。',
      '## 开发任务',
      '- 复核业务目标与使用场景。\n- 明确输入、处理过程与输出。\n- 为每项功能补充交付物和依赖。',
      '## 验收标准',
      `${plan.fileId ? '- 当前任务已加载绑定技能并读取上传文件。' : '- 已完成文字消息的传递与绑定技能加载。'}\n- 执行过程与结果可以保存、回看。\n- 刷新页面后可以恢复已经保存的输出。`,
      '## 待确认问题',
      '- 文档中的优先级、规模和边界是否已由需求方确认？\n- 接入真实模型后，复核分析与文档原文是否一致。',
    ].join('\n\n');
    for (let i = 0; i < output.length; i += 35) {
      await setTimeout(25, undefined, { signal });
      await emit({ type: 'output.delta', payload: { delta: output.slice(i, i + 35) } });
    }
    return { output, usage: emptyUsage() };
  }
}
