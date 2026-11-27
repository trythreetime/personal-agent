import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../../apps/server/src/app.js';

test.each(['usage', 'no-usage', 'max-turns'])(
  '真实 Agents SDK 验证兼容工具循环、用量与轮次限制 %s',
  async (scenario) => {
    const hasUsage = scenario === 'usage';
    const requests: Array<Record<string, any>> = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      requests.push(data);
      const n = requests.length;
      const message = data.messages.find((m: any) => m.role === 'system' || m.role === 'developer');
      const fileId = String(message.content).match(/"fileId":"([^"]+)"/)![1];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (delta: unknown, finish_reason: string | null = null, usage?: unknown) =>
        res.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`,
        );
      if (n <= 2 || scenario === 'max-turns') {
        const name = n === 1 ? 'load_skill' : 'read_file';
        send({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${n}`,
              type: 'function',
              function: {
                name,
                arguments: JSON.stringify(
                  n === 1
                    ? { skillId: 'requirement-analysis', offset: 0, limit: 32000 }
                    : { fileId, offset: 0, limit: 32000 },
                ),
              },
            },
          ],
        });
        send(
          {},
          'tool_calls',
          hasUsage ? { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } : undefined,
        );
      } else {
        send({ role: 'assistant', content: '# SDK 兼容验收\n\n已加载技能并读取文档。' });
        send(
          {},
          'stop',
          hasUsage ? { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } : undefined,
        );
      }
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无法启动测试接口');
    const dataDir = await mkdtemp(join(tmpdir(), 'sdk-test-'));
    const services = await createApp({
      root: resolve('.'),
      dataDir,
      env: {
        DEEPSEEK_API_KEY: 'test-only-not-a-real-key',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        DEEPSEEK_MODEL: 'fixture-model',
      },
    });
    try {
      const upload = await services.platform.upload(
        '需求.md',
        Buffer.from('需要网页执行和历史记录。'),
      );
      const task = await services.platform.createTask(
        { workerId: 'requirements-analyst', input: '分析文档', uploadId: upload.id },
        crypto.randomUUID(),
      );
      await expect
        .poll(async () => (await services.platform.task(task.id)).run.status)
        .toBe(scenario === 'max-turns' ? 'failed' : 'succeeded');
      const done = await services.platform.task(task.id);
      if (scenario === 'max-turns') {
        expect(done.run.error?.code).toBe('MAX_TURNS_EXCEEDED');
        expect(requests).toHaveLength(10);
        return;
      }
      expect(done.run.output).toContain('SDK 兼容验收');
      expect(requests).toHaveLength(3);
      expect(requests[0].tools.every((t: any) => t.function.strict === false)).toBe(true);
      expect(requests[0].thinking).toEqual({ type: 'disabled' });
      expect(requests[2].messages.filter((m: any) => m.role === 'tool')).toHaveLength(2);
      expect((await services.store.toolCalls(task.run.id)).map((t) => t.toolId)).toEqual([
        'load_skill',
        'read_file',
      ]);
      expect(done.run.usage).toEqual(
        hasUsage
          ? { inputTokens: 30, outputTokens: 12 }
          : { inputTokens: null, outputTokens: null },
      );
      expect(
        (await services.store.events(task.run.id, 0, 100))
          .filter((e) => e.type === 'output.delta')
          .map((e) => e.payload),
      ).toEqual([{ delta: '# SDK 兼容验收\n\n已加载技能并读取文档。' }]);
      if (hasUsage) {
        const followup = await services.platform.createTask(
          { workerId: task.workerId, sessionId: task.sessionId, input: '请继续细化验收标准' },
          crypto.randomUUID(),
        );
        await expect
          .poll(async () => (await services.platform.task(followup.id)).run.status)
          .toBe('succeeded');
        expect(requests[3].messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ role: 'user', content: '分析文档' }),
            expect.objectContaining({
              role: 'assistant',
              content: '# SDK 兼容验收\n\n已加载技能并读取文档。',
            }),
            expect.objectContaining({ role: 'user', content: '请继续细化验收标准' }),
          ]),
        );
      }
    } finally {
      await services.app.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
