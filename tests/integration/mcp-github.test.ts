import { afterEach, expect, test, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGithubServer, parseRepositories } from '../../mcp-servers/github/src/server.mjs';
import { McpToolRegistry } from '../../packages/agent-runtime/src/index.js';
import { mcpServerConfigSchema } from '../../packages/contracts/src/index.js';
import { EnvironmentCredentials } from '../../packages/infrastructure/src/index.js';

const repo = 'octo/project';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const issue = (number = 7) => ({
  number,
  title: 'Fix a bug',
  state: 'open',
  body: 'Details about the bug',
  html_url: `https://github.com/${repo}/issues/${number}`,
});
const pull = (number = 9) => ({
  ...issue(number),
  html_url: `https://github.com/${repo}/pull/${number}`,
  pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${number}` },
});
const json = (data: unknown, init?: ResponseInit) => new Response(JSON.stringify(data), init);
async function connection(
  fetchImpl = vi.fn<typeof fetch>(async () => json([])),
  options: { timeoutMs?: number; token?: string } = {},
) {
  const server = createGithubServer({ repositories: [repo], fetchImpl, ...options });
  const client = new Client({ name: 'github-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanup.push(
    () => server.close(),
    () => client.close(),
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, fetchImpl };
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: { repository: repo, ...args } });
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content.every((part) => part.type === 'text')).toBe(true);
  return { isError: result.isError, text: content.map((part) => part.text).join('\n') };
}

test('GitHub 固定白名单必须显式配置；标识符、重复项和启动参数严格校验', () => {
  expect(parseRepositories(['--repo', 'Octo/Project', '--repo', 'org/.github'])).toEqual([
    repo,
    'org/.github',
  ]);
  for (const args of [
    [],
    ['--repo'],
    ['--allow-all', 'true'],
    ['--repo', '*'],
    ['--repo', 'https://github.com/octo/project'],
    ['--repo', '../project'],
    ['--repo', 'octo/..'],
    ['--repo', 'octo/.'],
    ['--repo', 'octo/project/extra'],
    ['--repo', 'octo/project?x=1'],
    ['--repo', 'octo/%2e%2e'],
    ['--repo', 'octo/project#x'],
    ['--repo', 'octo /project'],
    ['--repo', '-octo/project'],
    ['--repo', 'bad--owner/project'],
    ['--repo', `${'a'.repeat(40)}/project`],
    ['--repo', `octo/${'a'.repeat(101)}`],
    ['--repo', repo, '--repo', 'OCTO/PROJECT'],
    Array.from({ length: 21 }, (_, i) => ['--repo', `org/repo-${i}`]).flat(),
  ])
    expect(() => parseRepositories(args)).toThrow();
  expect(() => createGithubServer({ repositories: [] })).toThrow();
  expect(() => createGithubServer({ repositories: ['../escape'] })).toThrow();
  expect(() => createGithubServer({ repositories: [repo], token: 'bad\ntoken' })).toThrow();
});

test('GitHub 独立 Stdio 服务可通过现有平台发现；五个只读工具及 Schema 均受支持', async () => {
  const config = mcpServerConfigSchema.parse({
    id: 'github',
    transport: 'stdio',
    command: process.execPath,
    args: ['mcp-servers/github/src/index.mjs', '--repo', repo],
    allowedTools: [
      'read_readme',
      'list_issues',
      'search_issues',
      'list_pull_requests',
      'search_pull_requests',
    ],
  });
  const registry = new McpToolRegistry([config], new EnvironmentCredentials({}), resolve('.'));
  cleanup.push(() => registry.close());
  const inspected = await registry.inspect(config);
  expect(inspected).toHaveLength(5);
  expect(inspected.every((tool) => tool.supported && tool.readOnly)).toBe(true);
  const tools = await registry.discover();
  expect(tools.map((tool) => tool.id).sort()).toEqual(
    config.allowedTools.map((name) => `mcp_github__${name}`).sort(),
  );
  for (const tool of tools) {
    expect(tool.parameters.safeParse({ repository: 'other/private', query: 'bug' }).success).toBe(
      false,
    );
    expect(tool.source?.serverId).toBe('github');
    expect(tool.requiresApproval).toBe(false);
  }
  const search = tools.find((tool) => tool.id === 'mcp_github__search_issues')!;
  expect(search.parameters.safeParse({ repository: repo, query: '中文 bug' }).success).toBe(true);
  expect(
    search.parameters.safeParse({ repository: repo, query: 'repo:other/private' }).success,
  ).toBe(false);
});

test('GitHub CLI 缺少白名单时失败关闭且不向 stdout 或 stderr 输出凭证', () => {
  const child = spawnSync(process.execPath, ['mcp-servers/github/src/index.mjs'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_TOKEN: 'startup-secret' },
  });
  expect(child.status).toBe(1);
  expect(child.stdout).toBe('');
  expect(child.stderr).toContain('GitHub MCP startup failed');
  expect(child.stderr).not.toContain('startup-secret');
});

test.each([
  ['read_readme', '# README\nHello', '/repos/octo/project/readme', '#readme'],
  ['list_issues', [issue(), pull()], '/repos/octo/project/issues', '/issues/7'],
  ['search_issues', { items: [issue()], incomplete_results: false }, '/search/issues', '/issues/7'],
  ['list_pull_requests', [pull()], '/repos/octo/project/pulls', '/pull/9'],
  [
    'search_pull_requests',
    { items: [pull()], incomplete_results: false },
    '/search/issues',
    '/pull/9',
  ],
] as const)(
  'GitHub %s 只发送固定域名 GET，返回有界文本与可信来源 URL',
  async (name, data, path, source) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      typeof data === 'string' ? new Response(data) : json(data),
    );
    const { client } = await connection(fetchImpl, { token: 'github-fixture-secret' });
    const search = name.startsWith('search');
    const result = await call(
      client,
      name,
      search ? { query: 'bug fix', state: 'closed', page: 2, limit: 3 } : {},
    );
    expect(result.isError).not.toBe(true);
    expect(result.text).toContain(`https://github.com/${repo}${source}`);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(64_000);
    expect(result.text).not.toContain('github-fixture-secret');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    const requestUrl = new URL(String(url));
    expect(requestUrl.origin).toBe('https://api.github.com');
    expect(requestUrl.pathname).toBe(path);
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      headers: { Authorization: 'Bearer github-fixture-secret' },
    });
    if (search) {
      expect(requestUrl.searchParams.get('q')).toBe(
        `repo:${repo} is:${name.endsWith('pull_requests') ? 'pr' : 'issue'} is:closed in:title,body "bug fix"`,
      );
      expect(requestUrl.searchParams.get('page')).toBe('2');
      expect(requestUrl.searchParams.get('per_page')).toBe('3');
    } else if (name !== 'read_readme') {
      expect(requestUrl.searchParams.get('state')).toBe('open');
      expect(requestUrl.searchParams.get('per_page')).toBe('10');
      expect(requestUrl.searchParams.get('page')).toBe('1');
    } else {
      expect(init?.headers).toMatchObject({ Accept: 'application/vnd.github.raw+json' });
      expect(result.text).toContain('# README\nHello');
    }
    if (name === 'list_issues') expect(result.text).not.toContain('/pull/9');
  },
);

test('GitHub 白名单在每个 MCP 工具强制执行；无法调用写工具', async () => {
  const { client, fetchImpl } = await connection();
  const { tools } = await client.listTools();
  expect(tools).toHaveLength(5);
  for (const tool of tools) {
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool.inputSchema.additionalProperties).toBe(false);
    for (const repository of [
      'other/private',
      'octo/project/../private',
      'https://github.com/octo/project',
      'OCTO/PROJECT',
      '*',
    ]) {
      expect(
        (
          await call(client, tool.name, {
            repository,
            ...(tool.name.startsWith('search') ? { query: 'bug' } : {}),
          })
        ).isError,
      ).toBe(true);
    }
  }
  expect((await call(client, 'create_issue')).isError).toBe(true);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('GitHub 查询、页数、数量及未知参数在 HTTP 请求前拒绝', async () => {
  const { client, fetchImpl } = await connection();
  for (const name of [
    'list_issues',
    'search_issues',
    'list_pull_requests',
    'search_pull_requests',
  ]) {
    const base = name.startsWith('search') ? { query: 'bug' } : {};
    for (const invalid of [
      { page: 0 },
      { page: -1 },
      { page: 11 },
      { page: 1.5 },
      { page: '1' },
      { limit: 0 },
      { limit: -1 },
      { limit: 21 },
      { limit: 1.5 },
      { limit: '10' },
      { state: 'merged' },
      { number: '../1' },
      { url: 'https://evil.invalid' },
    ])
      expect((await call(client, name, { ...base, ...invalid })).isError).toBe(true);
  }
  for (const query of [
    '',
    ' ',
    'a'.repeat(161),
    'repo:other/private',
    'bug" OR repo:other/private',
    'x\\y',
    'bug\nfix',
    'bug\u0000fix',
  ]) {
    for (const name of ['search_issues', 'search_pull_requests'])
      expect((await call(client, name, { query })).isError).toBe(true);
  }
  expect((await call(client, 'search_issues')).isError).toBe(true);
  expect((await call(client, 'read_readme', { path: '../secret' })).isError).toBe(true);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('GitHub 公共仓库无需凭证；搜索固定仓库与类型、保留不完整标记、不自动翻页', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    json({ items: [issue()], incomplete_results: true }),
  );
  const { client } = await connection(fetchImpl);
  const result = await call(client, 'search_issues', { query: 'bug OR fix', state: 'all' });
  expect(result.isError).not.toBe(true);
  expect(result.text).toContain('Incomplete search results: true');
  expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('q')).toBe(
    `repo:${repo} is:issue in:title,body "bug OR fix"`,
  );
  expect(fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test.each([
  [401, {}, 'GITHUB_AUTH_FAILED'],
  [403, {}, 'GITHUB_FORBIDDEN'],
  [403, { 'x-ratelimit-remaining': '0' }, 'GITHUB_RATE_LIMITED'],
  [403, { 'retry-after': '20' }, 'GITHUB_RATE_LIMITED'],
  [404, {}, 'GITHUB_NOT_FOUND'],
  [422, {}, 'GITHUB_API_ERROR'],
  [429, {}, 'GITHUB_RATE_LIMITED'],
  [503, {}, 'GITHUB_API_ERROR'],
  [
    301,
    { location: 'https://api.github.com/repos/other/private/issues' },
    'GITHUB_REDIRECT_REJECTED',
  ],
  [302, { location: 'https://evil.invalid/leak' }, 'GITHUB_REDIRECT_REJECTED'],
] as const)(
  'GitHub API %s 映射安全错误 %s，不泄漏响应、不重试或跟随跳转',
  async (status, headers, code) => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('raw-secret github-fixture-secret', { status, headers }),
    );
    const { client } = await connection(fetchImpl, { token: 'github-fixture-secret' });
    const result = await call(client, 'list_issues');
    expect(result.isError).toBe(true);
    expect(result.text).toContain(code);
    expect(result.text).not.toMatch(/secret|evil\.invalid|other\/private/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  },
);

test('GitHub 网络异常仅返回安全错误', async () => {
  const { client } = await connection(
    vi.fn<typeof fetch>(async () => {
      throw new Error('network-secret');
    }),
  );
  expect(await call(client, 'read_readme')).toEqual({
    isError: true,
    text: expect.stringContaining('GITHUB_API_ERROR'),
  });
  expect((await call(client, 'read_readme')).text).not.toContain('network-secret');
});

test.each([false, true])('GitHub 超时取消 HTTP 请求和慢速响应体（body=%s）', async (body) => {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const signal = init!.signal!;
    if (body)
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          },
        }),
      );
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const { client } = await connection(fetchImpl, { timeoutMs: 25 });
  const result = await call(client, 'read_readme');
  expect(result.isError).toBe(true);
  expect(result.text).toContain('GITHUB_TIMEOUT');
  expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

test.each([
  'not JSON',
  {},
  [{ ...issue(), number: -1 }],
  [{ ...issue(), number: 1.5 }],
  [{ ...issue(), html_url: 'https://github.com/other/private/issues/7' }],
  [{ ...issue(), html_url: 'https://evil.invalid/issues/7' }],
  [{ ...issue(), body: {} }],
])('GitHub 拒绝无效 API 结果 %j', async (data) => {
  const { client } = await connection(
    vi.fn<typeof fetch>(async () => (typeof data === 'string' ? new Response(data) : json(data))),
  );
  const result = await call(client, 'list_issues');
  expect(result.isError).toBe(true);
  expect(result.text).toContain('GITHUB_INVALID_RESPONSE');
});

test('GitHub 搜索拒绝越界仓库、错误类型和不完整的响应结构', async () => {
  for (const data of [
    { items: [pull()], incomplete_results: false },
    {
      items: [{ ...issue(), html_url: 'https://github.com/other/private/issues/7' }],
      incomplete_results: false,
    },
    { items: [issue()] },
    { items: null, incomplete_results: false },
  ]) {
    const { client } = await connection(vi.fn<typeof fetch>(async () => json(data)));
    const result = await call(client, 'search_issues', { query: 'bug' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('GITHUB_INVALID_RESPONSE');
  }
});

test.each([false, true])(
  'GitHub API 响应超过 1 MiB 时拒绝并取消读取（length=%s）',
  async (length) => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1_048_577));
            },
            cancel,
          }),
          { headers: length ? { 'content-length': '1048577' } : {} },
        ),
    );
    const { client } = await connection(fetchImpl);
    const result = await call(client, 'read_readme');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('GITHUB_INVALID_RESPONSE');
    // Both early header rejection and streamed overflow must release the response.
    expect(cancel).toHaveBeenCalled();
  },
);

test('GitHub README 和条目多字节文本截断保留来源；按数量限制不返回整页原始数据', async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('资料'.repeat(50_000)))
    .mockResolvedValueOnce(
      json(
        Array.from({ length: 21 }, (_, i) => ({
          ...issue(i + 1),
          title: '标题'.repeat(1000),
          body: '正文'.repeat(1000),
        })),
      ),
    );
  const { client } = await connection(fetchImpl);
  const readme = await call(client, 'read_readme');
  expect(readme.isError).not.toBe(true);
  expect(Buffer.byteLength(readme.text)).toBeLessThan(25_000);
  expect(readme.text).toContain(`https://github.com/${repo}#readme`);
  expect(readme.text).toContain('[truncated]');
  expect(readme.text).not.toContain('\ufffd');
  const list = await call(client, 'list_issues', { limit: 20 });
  expect(list.isError).not.toBe(true);
  expect(Buffer.byteLength(list.text)).toBeLessThanOrEqual(64_000);
  expect(list.text).toContain(`https://github.com/${repo}/issues/20`);
  expect(list.text).not.toContain(`https://github.com/${repo}/issues/21`);
  expect(list.text).not.toContain('\ufffd');
});
