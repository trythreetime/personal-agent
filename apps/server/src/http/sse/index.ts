import type { FastifyReply } from 'fastify';
import type { PlatformStore } from '@digital-worker/core';
import { isTerminal } from '@digital-worker/contracts';

export function streamEvents(
  reply: FastifyReply,
  store: PlatformStore,
  runId: string,
  after: number,
  connections: Set<() => void>,
) {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.write(': connected\n\n');
  let cursor = after;
  let busy = false;
  let blocked = false;
  let closed = false;
  let heartbeatAt = Date.now();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    connections.delete(end);
  };
  const end = () => {
    cleanup();
    response.end();
  };
  const write = (data: string) => {
    if (!response.write(data)) {
      blocked = true;
      response.once('drain', () => {
        blocked = false;
      });
    }
  };
  const poll = async () => {
    if (closed || busy || blocked) return;
    busy = true;
    try {
      for (const e of await store.events(runId, cursor, 100)) {
        write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        cursor = e.seq;
        if (blocked) break;
      }
      const run = await store.getRun(runId);
      if (run && isTerminal(run.status) && cursor >= (await store.lastSeq(runId))) {
        end();
        return;
      }
      if (Date.now() - heartbeatAt > 15_000) {
        write(': heartbeat\n\n');
        heartbeatAt = Date.now();
      }
    } catch {
      cleanup();
      response.destroy();
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void poll();
  }, 250);
  timer.unref();
  response.once('close', cleanup);
  connections.add(end);
  void poll();
}
