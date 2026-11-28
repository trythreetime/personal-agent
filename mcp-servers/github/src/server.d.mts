import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function parseRepositories(args: string[]): string[];
export function createGithubServer(options: {
  repositories: string[];
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): McpServer;
