import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3101',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm build && AGENT_DEMO_MODE=true AGENT_DATA_DIR=data/e2e PORT=3101 pnpm start',
    url: 'http://127.0.0.1:3101',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
