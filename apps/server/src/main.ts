import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createApp } from './app.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const port = Number(process.env.PORT || 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为有效端口');
const { app, logger } = await createApp({
  root,
  dataDir: process.env.AGENT_DATA_DIR ? resolve(root, process.env.AGENT_DATA_DIR) : undefined,
});
try {
  await app.listen({ host: '127.0.0.1', port });
} catch (error) {
  await app.close();
  throw error;
}
logger.info(
  {
    url: `http://127.0.0.1:${port}`,
    mode: process.env.AGENT_DEMO_MODE === 'true' ? 'demo' : 'live',
  },
  '数字人平台已启动',
);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
  });
