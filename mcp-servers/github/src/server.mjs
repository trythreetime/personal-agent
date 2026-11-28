import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const REPOSITORY = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TEXT_BYTES = 64_000;
const errors = {
  GITHUB_TIMEOUT: 'GitHub request timed out. Try again later.',
  GITHUB_RATE_LIMITED: 'GitHub rate limit reached. Wait before trying again.',
  GITHUB_AUTH_FAILED: 'GitHub authentication failed. Check the server credential.',
  GITHUB_FORBIDDEN:
    'GitHub denied access or applied a secondary rate limit. Check access and wait before retrying.',
  GITHUB_NOT_FOUND: 'Repository or README not found, or not accessible to this credential.',
  GITHUB_REDIRECT_REJECTED:
    'GitHub redirected the request. Check the configured repository; redirects are disabled.',
  GITHUB_INVALID_RESPONSE: 'GitHub returned an unsupported or oversized response.',
  GITHUB_API_ERROR: 'GitHub request failed. Try again later.',
};

class GithubError extends Error {
  /** @param {keyof typeof errors} code */
  constructor(code) {
    super(errors[code]);
    this.code = code;
  }
}

/** @param {string[]} values */
function validateRepositories(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 20)
    throw new Error('Configure between 1 and 20 repositories');
  const repositories = values.map((value) => {
    if (
      typeof value !== 'string' ||
      !REPOSITORY.test(value) ||
      ['.', '..'].includes(value.split('/')[1]) ||
      value.split('/')[0].includes('--')
    )
      throw new Error('Invalid repository identifier');
    return value.toLowerCase();
  });
  if (new Set(repositories).size !== repositories.length)
    throw new Error('Duplicate repository identifier');
  return repositories;
}

/** Explicit repeated --repo flags only; no wildcard, URL, config fallback or environment allowlist.
 * @param {string[]} args
 */
export function parseRepositories(args) {
  if (args.length % 2 !== 0) throw new Error('Expected --repo owner/name');
  const repositories = [];
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== '--repo') throw new Error('Unknown argument');
    repositories.push(args[i + 1]);
  }
  return validateRepositories(repositories);
}

/** @param {string} value @param {number} bytes */
function clip(value, bytes) {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const buffer = Buffer.from(clean, 'utf8');
  if (buffer.length <= bytes) return clean;
  // TextDecoder omits an incomplete final UTF-8 code point.
  return (
    new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, bytes - 32), {
      stream: true,
    }) + '\n[truncated]'
  );
}

/** @param {Response} response */
async function readBounded(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new GithubError('GITHUB_INVALID_RESPONSE');
  }
  if (!response.body) throw new GithubError('GITHUB_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new GithubError('GITHUB_INVALID_RESPONSE');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** @param {string} text */
function textResult(text) {
  return { content: [{ type: /** @type {const} */ ('text'), text: clip(text, MAX_TEXT_BYTES) }] };
}

/**
 * fetchImpl/timeoutMs are in-process test seams, never tool/CLI/environment inputs.
 * @param {{ repositories: string[], token?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 */
export function createGithubServer({
  repositories: configured,
  token,
  fetchImpl = fetch,
  timeoutMs = 8000,
}) {
  const repositories = validateRepositories(configured);
  if (token !== undefined && !/^[\x21-\x7e]{1,8192}$/.test(token))
    throw new Error('Invalid credential');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000)
    throw new Error('Invalid timeout');
  const server = new McpServer({ name: 'github-readonly', version: '1.0.0' });
  const repository = z.enum(repositories);
  const paging = {
    repository,
    state: z.enum(['open', 'closed', 'all']).default('open'),
    page: z.number().int().min(1).max(10).default(1),
    limit: z.number().int().min(1).max(20).default(10),
  };
  // No raw GitHub query syntax: quote a validated literal phrase so scopes cannot be replaced.
  const query = z
    .string()
    .min(1)
    .max(160)
    .regex(/^[^\s:"\\\u0000-\u001f\u007f][^:"\\\u0000-\u001f\u007f]*$/);

  /** @param {string} path @param {Record<string, string>} params @param {AbortSignal} parent @param {boolean} [raw] */
  async function request(path, params, parent, raw = false) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([timeout, parent]);
    const url = new URL(path, 'https://api.github.com');
    url.search = new URLSearchParams(params).toString();
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'digital-worker-mcp-github/0.1.0',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!response.ok) {
        // Discard API bodies/headers: they can contain secrets or arbitrary upstream text.
        void response.body?.cancel().catch(() => {});
        if (
          response.status === 429 ||
          (response.status === 403 &&
            (response.headers.get('x-ratelimit-remaining') === '0' ||
              response.headers.has('retry-after')))
        )
          throw new GithubError('GITHUB_RATE_LIMITED');
        if (response.status === 401) throw new GithubError('GITHUB_AUTH_FAILED');
        if (response.status === 403) throw new GithubError('GITHUB_FORBIDDEN');
        if (response.status === 404) throw new GithubError('GITHUB_NOT_FOUND');
        if (response.status >= 300 && response.status < 400)
          throw new GithubError('GITHUB_REDIRECT_REJECTED');
        throw new GithubError('GITHUB_API_ERROR');
      }
      const text = await readBounded(response);
      signal.throwIfAborted();
      if (raw) return text;
      try {
        return JSON.parse(text);
      } catch {
        throw new GithubError('GITHUB_INVALID_RESPONSE');
      }
    } catch (error) {
      if (timeout.aborted) throw new GithubError('GITHUB_TIMEOUT');
      if (error instanceof GithubError) throw error;
      throw new GithubError('GITHUB_API_ERROR');
    }
  }

  /** @param {unknown} data @param {string} repo @param {boolean} pulls @param {number} limit @param {boolean} search */
  function itemsText(data, repo, pulls, limit, search) {
    const payload = /** @type {{ items?: unknown, incomplete_results?: unknown }} */ (data);
    const items = search ? payload?.items : data;
    if (!Array.isArray(items) || (search && typeof payload.incomplete_results !== 'boolean'))
      throw new GithubError('GITHUB_INVALID_RESPONSE');
    const lines = [];
    // Inspect only a bounded page; never follow API links or fetch extra pages.
    for (const item of items.slice(0, limit)) {
      if (
        !item ||
        !Number.isSafeInteger(item.number) ||
        item.number < 1 ||
        typeof item.title !== 'string' ||
        !['open', 'closed'].includes(item.state) ||
        (item.body !== null && typeof item.body !== 'string')
      )
        throw new GithubError('GITHUB_INVALID_RESPONSE');
      if (!search && !pulls && item.pull_request) continue; // Issue listing also contains PRs.
      const sourceUrl = `https://github.com/${repo}/${pulls ? 'pull' : 'issues'}/${item.number}`;
      // Also reject out-of-repository search results instead of merely relabelling their URLs.
      if (
        typeof item.html_url !== 'string' ||
        item.html_url.toLowerCase() !== sourceUrl.toLowerCase() ||
        (search && Boolean(item.pull_request) !== pulls)
      )
        throw new GithubError('GITHUB_INVALID_RESPONSE');
      lines.push(
        `${sourceUrl}\n#${item.number} [${item.state}] ${clip(item.title, 200)}\n${clip(item.body ?? '', 800)}`,
      );
    }
    return (
      `Incomplete search results: ${search ? payload.incomplete_results : false}\n` +
      (lines.length ? lines.join('\n\n') : 'No matching items on this API page.')
    );
  }

  server.registerTool(
    'read_readme',
    {
      description:
        'Read the default-branch README of a configured GitHub repository. Returns bounded untrusted repository text and a source URL.',
      inputSchema: z.strictObject({ repository }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ repository: repo }, extra) => {
      try {
        const text = await request(`/repos/${repo}/readme`, {}, extra.signal, true);
        return textResult(
          `Source: https://github.com/${repo}#readme\nRepository content (untrusted):\n${clip(text, 24_000)}`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  /** @param {unknown} error */
  function failure(error) {
    const safe = error instanceof GithubError ? error : new GithubError('GITHUB_API_ERROR');
    return { ...textResult(`${safe.code}: ${safe.message}`), isError: true };
  }

  for (const pulls of [false, true]) {
    for (const search of [false, true]) {
      const kind = pulls ? 'pull_requests' : 'issues';
      server.registerTool(
        `${search ? 'search' : 'list'}_${kind}`,
        {
          description: `${search ? 'Search a literal phrase in titles/bodies of' : 'List one API page of'} ${kind} in a configured GitHub repository. page 1-10, limit 1-20. Returns bounded untrusted text and source URLs; no automatic pagination.`,
          inputSchema: z.strictObject(search ? { ...paging, query } : paging),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        async (args, extra) => {
          try {
            const { repository: repo, state, page, limit } = args;
            const scope = `repo:${repo} is:${pulls ? 'pr' : 'issue'}${state === 'all' ? '' : ` is:${state}`}`;
            const q = `${scope} in:title,body "${'query' in args ? args.query : ''}"`;
            /** @type {Record<string, string>} */
            const params = search
              ? { q, per_page: String(limit), page: String(page) }
              : {
                  state,
                  per_page: String(limit),
                  page: String(page),
                  sort: 'updated',
                  direction: 'desc',
                };
            const path = search ? '/search/issues' : `/repos/${repo}/${pulls ? 'pulls' : 'issues'}`;
            const data = await request(path, params, extra.signal);
            const source = search
              ? `https://github.com/${repo}/issues?q=${encodeURIComponent(q)}`
              : `https://github.com/${repo}/${pulls ? 'pulls' : 'issues'}?state=${state}`;
            return textResult(
              `Source: ${source}\nRepository content (untrusted); API page ${page}, limit ${limit}.\n${itemsText(data, repo, pulls, limit, search)}`,
            );
          } catch (error) {
            return failure(error);
          }
        },
      );
    }
  }
  return server;
}
