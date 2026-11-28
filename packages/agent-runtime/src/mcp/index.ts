import { createHash } from 'node:crypto';
import { MCPServerStdio, MCPServerStreamableHttp, type MCPServer } from '@openai/agents';
import { z } from 'zod';
import {
  PlatformError,
  mcpToolId,
  type CredentialResolver,
  type McpServerConfig,
  type ToolDefinition,
} from '@digital-worker/core';
import type { McpToolInfo } from '@digital-worker/contracts';

const silentLogger = {
  namespace: 'platform-mcp',
  debug() {},
  warn() {},
  error() {},
  dontLogModelData: true,
  dontLogToolData: true,
};
function aborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}
type DiscoveredTool = Awaited<ReturnType<MCPServer['listTools']>>[number];
// Fail closed for constraints the first adapter has not verified with Zod.
function checkSchema(schema: unknown): void {
  if (typeof schema === 'boolean') return;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    throw new Error('Invalid schema');
  const value = schema as Record<string, unknown>;
  const allowed = new Set([
    '$schema',
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'title',
    'description',
    'default',
    'minLength',
    'maxLength',
    'pattern',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minItems',
    'maxItems',
    'anyOf',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error('Unsupported constraint');
  if (value.properties) for (const item of Object.values(value.properties)) checkSchema(item);
  if (value.items !== undefined) checkSchema(value.items);
  if (value.additionalProperties !== undefined) checkSchema(value.additionalProperties);
  if (value.anyOf) {
    if (!Array.isArray(value.anyOf)) throw new Error('Invalid anyOf');
    for (const item of value.anyOf) checkSchema(item);
  }
}
function toolVersion(config: McpServerConfig, tool: DiscoveredTool) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        config,
        name: tool.name,
        schema: tool.inputSchema,
        description: tool.description,
        annotations: tool.annotations,
      }),
    )
    .digest('hex');
}
export class McpToolRegistry {
  private controllers = new Set<AbortController>();
  private pending = new Set<Promise<unknown>>();
  private stopped = false;
  constructor(
    private servers: McpServerConfig[],
    private credentials: CredentialResolver,
    private root: string,
  ) {}
  private client(config: McpServerConfig): MCPServer {
    const common = {
      name: config.id,
      timeout: config.timeoutMs,
      cacheToolsList: false,
      maxListPages: 4,
      logger: silentLogger,
    };
    if (config.transport === 'stdio') {
      const env: Record<string, string> = {};
      // Explicit credentials only; never inherit the platform's model keys.
      for (const name of ['PATH', 'HOME', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP'])
        if (process.env[name]) env[name] = process.env[name]!;
      for (const [name, ref] of Object.entries(config.envRefs)) {
        if (!this.credentials.available(ref))
          throw new PlatformError('MCP_AUTH_NOT_CONFIGURED', 'MCP 服务凭证未配置');
        env[name] = this.credentials.resolve(ref);
      }
      return new MCPServerStdio({
        ...common,
        command: config.command,
        args: config.args,
        cwd: this.root,
        env,
      });
    }
    const headers: Record<string, string> = {};
    if (config.bearerTokenRef) {
      if (!this.credentials.available(config.bearerTokenRef))
        throw new PlatformError('MCP_AUTH_NOT_CONFIGURED', 'MCP 服务凭证未配置');
      headers.Authorization = 'Bearer ' + this.credentials.resolve(config.bearerTokenRef);
    }
    return new MCPServerStreamableHttp({ ...common, url: config.url, requestInit: { headers } });
  }
  private async session<T>(
    config: McpServerConfig,
    parent: AbortSignal | undefined,
    action: (server: MCPServer, signal: AbortSignal) => Promise<T>,
  ) {
    if (this.stopped) throw new PlatformError('MCP_CLOSED', 'MCP 服务正在关闭');
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = AbortSignal.any([controller.signal, timeout, ...(parent ? [parent] : [])]);
    let server: MCPServer | undefined;
    let connected = false;
    const work = (async () => {
      try {
        signal.throwIfAborted();
        server = this.client(config);
        const connection = server.connect();
        // A connection that resolves after cancellation must not retain a child/session.
        void connection
          .then(() => {
            if (signal.aborted) return server!.close();
          })
          .catch(() => {});
        await aborted(connection, signal);
        connected = true;
        return await aborted(action(server, signal), signal);
      } catch (error) {
        if (parent?.aborted || controller.signal.aborted) throw error;
        if (timeout.aborted) throw new PlatformError('MCP_TIMEOUT', 'MCP 服务连接或调用超时');
        if (error instanceof PlatformError) throw error;
        throw new PlatformError(
          connected ? 'MCP_REQUEST_FAILED' : 'MCP_CONNECTION_FAILED',
          connected
            ? 'MCP 工具调用失败，请检查服务后重试'
            : 'MCP 服务连接失败，请检查配置与服务状态',
        );
      } finally {
        if (server) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            server.close().catch(() => {}),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 2000);
            }),
          ]);
          clearTimeout(timer);
        }
        this.controllers.delete(controller);
      }
    })();
    this.pending.add(work);
    try {
      return await work;
    } finally {
      this.pending.delete(work);
    }
  }
  async discover(): Promise<ToolDefinition[]> {
    const definitions: ToolDefinition[] = [];
    for (const config of this.servers.filter((server) => server.enabled)) {
      const listed = await this.session(config, undefined, (server) => server.listTools());
      const names = new Set(listed.map((tool) => tool.name));
      if (names.size !== listed.length)
        throw new PlatformError('MCP_DUPLICATE_TOOL', 'MCP 服务返回了重复工具');
      for (const name of config.allowedTools) {
        const tool = listed.find((item) => item.name === name);
        if (!tool) throw new PlatformError('MCP_TOOL_NOT_FOUND', '配置的 MCP 工具未在服务中发现');
        if (tool.annotations?.readOnlyHint !== true)
          throw new PlatformError('MCP_TOOL_NOT_READ_ONLY', '首版仅接入明确标记为只读的 MCP 工具');
        let parameters: z.ZodObject;
        try {
          checkSchema(tool.inputSchema);
          const parsed = z.fromJSONSchema(tool.inputSchema);
          if (!(parsed instanceof z.ZodObject)) throw new Error('Object schema required');
          parameters = parsed;
          // Reject schemas that cannot also be represented for the model.
          z.toJSONSchema(parameters);
        } catch {
          throw new PlatformError(
            'MCP_SCHEMA_UNSUPPORTED',
            'MCP 参数 Schema 暂不支持，请使用可转换的对象 Schema',
          );
        }
        const version = toolVersion(config, tool);
        definitions.push({
          id: mcpToolId(config.id, name),
          description: (
            'MCP 只读工具（服务 ' +
            config.id +
            '）：' +
            (tool.description || name)
          ).slice(0, 4000),
          parameters,
          inputSchema: tool.inputSchema,
          source: { type: 'mcp', serverId: config.id, toolName: name, version },
          riskLevel: 'medium',
          requiresApproval: false,
          enabled: true,
          execute: (args, context) =>
            this.session(config, context.signal, async (server, signal) => {
              // Check the discovered contract again after reconnecting; no silent tool drift.
              const current = (await server.listTools()).find((item) => item.name === name);
              if (!current || toolVersion(config, current) !== version)
                throw new PlatformError(
                  'MCP_TOOL_CHANGED',
                  'MCP 工具定义已变更，请重启服务后新建任务',
                );
              const result = await server.callToolResult!(name, args, undefined, { signal });
              if (result.isError) throw new PlatformError('MCP_TOOL_ERROR', 'MCP 工具返回执行错误');
              if (
                result.content.some((item) => item.type !== 'text' || typeof item.text !== 'string')
              )
                throw new PlatformError('MCP_RESULT_UNSUPPORTED', '首版 MCP 工具须返回文本内容');
              const text = result.content.map((item) => item.text).join('\n');
              if (!text)
                throw new PlatformError('MCP_RESULT_UNSUPPORTED', '首版 MCP 工具须返回文本内容');
              if (Buffer.byteLength(text, 'utf8') > 128_000)
                throw new PlatformError('MCP_RESULT_TOO_LARGE', 'MCP 返回内容过大，请缩小查询范围');
              return { serverId: config.id, toolName: name, content: text };
            }),
        });
      }
    }
    return definitions;
  }
  async inspect(config: McpServerConfig): Promise<McpToolInfo[]> {
    const tools = await this.session(config, undefined, (server) => server.listTools());
    if (tools.length > 128)
      throw new PlatformError('MCP_TOO_MANY_TOOLS', '服务工具数量超过首版上限 128');
    return tools.map((tool) => {
      let supported = /^[a-zA-Z0-9_-]{1,32}$/.test(tool.name);
      try {
        checkSchema(tool.inputSchema);
        const parsed = z.fromJSONSchema(tool.inputSchema);
        if (!(parsed instanceof z.ZodObject)) supported = false;
        z.toJSONSchema(parsed);
      } catch {
        supported = false;
      }
      return {
        id: mcpToolId(config.id, tool.name),
        name: tool.name,
        description: (tool.description ?? '').slice(0, 4000),
        readOnly: tool.annotations?.readOnlyHint === true,
        supported,
        inputSchema: tool.inputSchema,
      };
    });
  }
  async close() {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.pending]);
  }
}
