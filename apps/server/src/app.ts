import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { PlatformError } from '@digital-worker/core';
import {
  createTaskSchema,
  runDtoSchema,
  taskDtoSchema,
  sessionDtoSchema,
} from '@digital-worker/contracts';
import { bootstrap, type BootstrapOptions } from './bootstrap/index.js';
import { streamEvents } from './http/sse/index.js';

const idParams = z.object({ id: z.string().uuid() });
export async function createApp(options: BootstrapOptions) {
  const services = await bootstrap(options);
  const { platform, store, limits, logger } = services;
  const app = Fastify({ logger: false, bodyLimit: 65_536 });
  const connections = new Set<() => void>();
  app.addHook('onRequest', async (request) => {
    let host: string;
    try {
      host = new URL(`http://${request.headers.host}`).hostname;
    } catch {
      throw new PlatformError('HOST_FORBIDDEN', '访问地址不受信任', 403);
    }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host))
      throw new PlatformError('HOST_FORBIDDEN', '仅允许本机访问', 403);
    const origin = request.headers.origin;
    if (origin) {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new PlatformError('ORIGIN_FORBIDDEN', '来源不受信任', 403);
      }
      const allowedPorts = [
        String(options.env?.WEB_PORT ?? process.env.WEB_PORT ?? 5173),
        String(options.env?.PORT ?? process.env.PORT ?? 3100),
      ];
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
        parsed.protocol !== 'http:' ||
        !allowedPorts.includes(parsed.port)
      )
        throw new PlatformError('ORIGIN_FORBIDDEN', '来源不受信任', 403);
    }
  });
  await app.register(multipart, {
    limits: { fileSize: limits.maxUploadBytes, files: 1, fields: 0, parts: 1 },
  });
  app.setErrorHandler((error, request, reply) => {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = '服务内部错误，请稍后重试';
    if (error instanceof PlatformError) {
      status = error.status;
      code = error.code;
      message = error.message;
    } else if (error instanceof ZodError) {
      status = 400;
      code = 'INVALID_INPUT';
      message = '输入格式无效，请检查后重试';
    } else if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'FST_REQ_FILE_TOO_LARGE'
    ) {
      status = 413;
      code = 'UPLOAD_SIZE';
      message = '文件超过 2 MiB 限制';
    } else if (
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode < 500
    ) {
      status = error.statusCode;
      code = 'INVALID_REQUEST';
      message = '请求格式或文件数量无效';
    }
    if (status >= 500) logger.error({ requestId: request.id, code }, 'HTTP 请求失败');
    reply.code(status).send({ code, message, requestId: request.id });
  });
  app.get('/api/health', async () => ({
    status: 'ready',
    version: '0.1.0',
    mode: platform.listWorkers().some((w) => w.mode === 'demo') ? 'demo' : 'live',
  }));
  app.get('/api/workers', async () => ({ items: platform.listWorkers() }));
  app.get('/api/workers/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const worker = platform.listWorkers().find((w) => w.id === id);
    if (!worker) throw new PlatformError('NOT_FOUND', '数字人不存在', 404);
    return worker;
  });
  app.post('/api/uploads', async (request, reply) => {
    const file = await request.file();
    if (!file) throw new PlatformError('UPLOAD_REQUIRED', '请选择文件');
    const data = await file.toBuffer();
    if (file.file.truncated) throw new PlatformError('UPLOAD_SIZE', '文件超过限制', 413);
    return reply.code(201).send(await platform.upload(file.filename, data));
  });
  app.post('/api/tasks', async (request, reply) => {
    const input = createTaskSchema.parse(request.body);
    const key = z.string().parse(request.headers['idempotency-key']);
    return reply.code(202).send(taskDtoSchema.parse(await platform.createTask(input, key)));
  });
  app.get('/api/tasks', async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
        workerId: z.string().optional(),
        sessionId: z.string().uuid().optional(),
      })
      .parse(request.query);
    const result = await store.listTasks(
      query.limit,
      query.offset,
      query.workerId,
      query.sessionId,
    );
    return { items: result.items.map((t) => taskDtoSchema.parse(t)), total: result.total };
  });
  app.get('/api/tasks/:id', async (request) =>
    taskDtoSchema.parse(await platform.task(idParams.parse(request.params).id)),
  );
  app.get('/api/sessions', async (request) => {
    const query = z
      .object({
        workerId: z.string().min(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);
    const result = await store.listSessions(query.workerId, query.limit, query.offset);
    return {
      items: result.items.map((session) => sessionDtoSchema.parse(session)),
      total: result.total,
    };
  });
  app.get('/api/sessions/:id', async (request) =>
    sessionDtoSchema.parse(await platform.session(idParams.parse(request.params).id)),
  );
  app.get('/api/runs/:id', async (request) => {
    const id = idParams.parse(request.params).id;
    return { ...runDtoSchema.parse(await platform.run(id)), toolCalls: await store.toolCalls(id) };
  });
  app.post('/api/runs/:id/cancel', async (request) =>
    runDtoSchema.parse(await platform.cancel(idParams.parse(request.params).id)),
  );
  app.get('/api/runs/:id/events', async (request, reply) => {
    const id = idParams.parse(request.params).id;
    await platform.run(id);
    const query = z
      .object({ after: z.coerce.number().int().min(0).default(0) })
      .parse(request.query);
    const after =
      request.headers['last-event-id'] === undefined
        ? query.after
        : z.coerce.number().int().min(0).parse(request.headers['last-event-id']);
    if (after > (await store.lastSeq(id)))
      throw new PlatformError('INVALID_CURSOR', '事件游标超出范围');
    streamEvents(reply, store, id, after, connections);
  });
  const webRoot = resolve(options.root, 'apps/web/dist');
  if (existsSync(webRoot)) {
    await app.register(staticFiles, { root: webRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ code: 'NOT_FOUND', message: '接口不存在', requestId: request.id })
        : reply.sendFile('index.html'),
    );
  }
  app.addHook('preClose', async () => {
    for (const close of connections) close();
    await platform.stop();
  });
  app.addHook('onClose', async () => {
    store.close();
  });
  return { app, ...services };
}
