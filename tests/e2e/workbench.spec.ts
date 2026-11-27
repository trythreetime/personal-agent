import { test, expect, type Page } from '@playwright/test';

async function openWorker(page: Page) {
  await page.getByRole('button', { name: '打开需求分析师的会话', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('消息内容')).toBeEnabled();
}
async function newSession(page: Page) {
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByLabel('消息内容')).toHaveValue('');
}
async function send(page: Page, text: string) {
  await page.getByLabel('消息内容').fill(text);
  const posted = page.waitForResponse(
    (response) => response.url().endsWith('/api/tasks') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const response = await posted;
  expect(response.status()).toBe(202);
  const created = await response.json();
  await expect(page.locator(`[data-task-id="${created.id}"]`).locator('.status-pill')).toHaveText(
    '已完成',
    { timeout: 15_000 },
  );
}
test('数字人卡片打开会话，上传、追问、刷新恢复和历史深链接均可用', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '我的数字人' })).toBeVisible();
  expect(
    await page
      .locator('.worker-card')
      .first()
      .evaluate((el) => el.getBoundingClientRect().width),
  ).toBeGreaterThan(260);
  await page.screenshot({ path: 'test-results/workers-desktop.png', fullPage: true });
  await openWorker(page);
  await expect
    .poll(async () => {
      const bounds = await page
        .locator('.worker-drawer > .ant-drawer-content-wrapper')
        .boundingBox();
      const viewport = page.viewportSize()!;
      return Boolean(
        bounds &&
          Math.abs(bounds.x + bounds.width - viewport.width) < 1 &&
          bounds.y === 0 &&
          bounds.height === viewport.height,
      );
    })
    .toBe(true);
  expect(
    await page.locator('.chat-composer').evaluate((el) => el.getBoundingClientRect().height),
  ).toBeLessThan(160);
  await newSession(page);
  await page
    .getByTestId('document-upload')
    .locator('input[type=file]')
    .setInputFiles('tests/fixtures/sample.md');
  await send(page, '请分析团队任务管理需求，给出验收标准');
  await expect(page.locator('.session-item .session-title').first()).toHaveCSS('display', 'block');
  await expect(page.locator('.session-item .session-item-meta').first()).toHaveCSS(
    'display',
    'flex',
  );
  await expect(page.locator('.markdown').last()).toContainText('团队任务管理需求');
  const sessionId = new URL(page.url()).searchParams.get('session');
  expect(sessionId).toBeTruthy();
  await page.getByRole('button', { name: '查看执行过程', exact: true }).last().click();
  await expect(page.locator('.chat-trace').last()).toContainText('load_skill 已完成');
  await expect(page.locator('.chat-trace').last()).toContainText('read_file 已完成');
  await send(page, '请进一步说明优先级');
  expect(new URL(page.url()).searchParams.get('session')).toBe(sessionId);
  await expect(page.locator('.conversation-turn')).toHaveCount(2);
  await expect(page.locator('.markdown').last()).toContainText('请进一步说明优先级');
  await page.reload();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.conversation-turn')).toHaveCount(2);
  await expect(page.locator('.markdown').first()).toContainText('团队任务管理需求');
  const conversationHeight = await page
    .locator('.conversation-scroll')
    .evaluate((el) => el.clientHeight);
  await page.getByRole('button', { name: '数字人详情', exact: true }).click();
  const details = page.getByRole('dialog', { name: '数字人详情', exact: true });
  await expect(details).toBeVisible();
  await expect.poll(() => details.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expect(details).toContainText('需求分析');
  await expect(details).toContainText('read_file');
  await expect(page.locator('.conversation-scroll')).toHaveJSProperty(
    'clientHeight',
    conversationHeight,
  );
  await page.screenshot({ path: 'test-results/worker-details-desktop.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.locator('.conversation-turn')).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get('session')).toBe(sessionId);
  await page.screenshot({ path: 'test-results/conversation-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '关闭对话', exact: true }).click();
  await page.getByRole('link', { name: /执行记录/ }).click();
  await page.getByRole('link', { name: 'sample.md', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`session=${sessionId}`));
  await expect(page.locator('.conversation-turn')).toHaveCount(2);
  expect(errors).toEqual([]);
});
test('新会话可直接发文字，切换历史不会混入其他会话', async ({ page }) => {
  await page.goto('/');
  await openWorker(page);
  await newSession(page);
  await send(page, '第一段独立会话：项目叫星河');
  const first = new URL(page.url()).searchParams.get('session');
  await newSession(page);
  await send(page, '第二段独立会话：项目叫远山');
  const second = new URL(page.url()).searchParams.get('session');
  expect(second).not.toBe(first);
  await expect(page.locator('.conversation-turn')).toHaveCount(1);
  await expect(page.locator('.user-bubble')).toHaveText('第二段独立会话：项目叫远山');
  await page.locator(`[data-session-id="${first}"]`).click();
  await expect(page.locator('.user-bubble')).toHaveText('第一段独立会话：项目叫星河');
  await page.locator(`[data-session-id="${second}"]`).click();
  await expect(page.locator('.user-bubble')).toHaveText('第二段独立会话：项目叫远山');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('所有数字人以卡片展示，不同数字人的会话列表独立加载', async ({ page }) => {
  await page.route('**/api/workers', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.items.push({
      ...body.items[0],
      id: 'test-writer',
      name: '报告助理',
      role: '报告撰写',
      description: '整理材料并编写报告。',
    });
    await route.fulfill({ response, json: body });
  });
  await page.goto('/');
  await expect(page.locator('.worker-card')).toHaveCount(2);
  await page.getByRole('button', { name: '打开报告助理的会话', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: '报告助理', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.session-list')).toContainText('还没有会话');
  await expect(page.locator('.conversation-turn')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭对话', exact: true }).click();
  await openWorker(page);
  await expect(page.locator('.session-item').first()).toBeVisible();
});
test('小屏抽屉无横向溢出，可打开会话列表并发送消息', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await openWorker(page);
  await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByLabel('消息内容')).toBeVisible();
  await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  await newSession(page);
  await send(page, '移动端文字会话');
  await page.getByRole('button', { name: '数字人详情', exact: true }).click();
  const details = page.getByRole('dialog', { name: '数字人详情', exact: true });
  await expect(details).toBeVisible();
  await expect.poll(() => details.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  const bounds = await details.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await details.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(details).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    await page
      .getByRole('dialog')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/conversation-mobile.png', fullPage: true });
});
test('Markdown 回复不会执行脚本或自动加载远程资源', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:3101/')) external.push(request.url());
  });
  await page.goto('/');
  await openWorker(page);
  await newSession(page);
  await page
    .getByTestId('document-upload')
    .locator('input[type=file]')
    .setInputFiles({
      name: 'unsafe.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(
        '# 需求\n<img src="https://invalid.example/exfil">\n<script>window.alert("unsafe")</script>\n<iframe src="https://invalid.example/frame"></iframe>',
      ),
    });
  await send(page, '分析这份文档');
  await expect(page.locator('.markdown img, .markdown script, .markdown iframe')).toHaveCount(0);
  expect(external).toEqual([]);
});
