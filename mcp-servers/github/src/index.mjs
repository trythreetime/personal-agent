import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGithubServer, parseRepositories } from './server.mjs';

try {
  const repositories = parseRepositories(process.argv.slice(2));
  const server = createGithubServer({ repositories, token: process.env.GITHUB_TOKEN });
  await server.connect(new StdioServerTransport());
} catch {
  // Keep stdout exclusively for MCP; never print arguments, credentials or raw errors.
  process.stderr.write('GitHub MCP startup failed: check --repo allowlist and GITHUB_TOKEN.\n');
  process.exitCode = 1;
}
