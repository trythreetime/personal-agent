# 自定义技能与 MCP 扩展

## 新增技能

在 `resources/skills` 中增加一个目录，例如 `report-writing`，创建 SKILL.md：

```markdown
---
name: report-writing
displayName: 报告撰写
description: 将已读取的资料整理成结构清晰的报告。
---

# 报告撰写

先确认报告目的，读取任务资料，区分事实与推断，再生成摘要、正文和待确认事项。
```

name 必须为唯一 ID，允许字母、数字、下划线与连字符，长度不超过 80。displayName 可选，description 必填。需要引用资料时放入该技能的 references 或 assets，使用 read_skill_resource 按相对路径读取。首版只读取受限大小的文本资源，不执行 scripts，不跟随逃逸资源根的符号链接。

在 `resources/workers/analyst.yaml` 或新增的数字人配置中将 `report-writing` 加入 skillIds。数字人还需要绑定 load_skill 和所需资源工具，权限策略也必须允许相应工具。

重启后启动扫描会校验配置，网页显示绑定的技能。模型先看到技能索引，调用 load_skill 后才获得正文，引用资料通过 read_skill_resource 加载。已有运行保存固定技能快照，不随资源更新改变。

## 新增数字人和模型

复制数字人 YAML，修改唯一 id、身份、职责、modelId、skillIds、toolIds 和 permissionPolicyId，重启即可通过网页选择。

新增模型写入 config/models.yaml，通过 apiKeyRef 引用环境变量。provider 为 openai 或 openai-compatible，protocol 为 responses 或 chat_completions。兼容服务不要求支持供应商 strict 扩展，Core 始终校验参数。特殊供应商行为在 agent-runtime/models 中增加适配，不放入网页或业务用例。

## 自定义 MCP

已实现 Stdio 与 Streamable HTTP 连接器，位于 `packages/agent-runtime/src/mcp`。平台发现工具后转换为 ToolDefinition，经 Core 授权入口调用，不直接将 MCPServer 挂到 Agent 的 mcpServers 上。[Agents SDK MCP 说明](https://openai.github.io/openai-agents-js/guides/mcp/)

### 直接体验

默认 `config/mcp.yaml` 启用 reference 服务，执行 `node mcp-servers/reference/src/index.mjs`。该独立进程通过官方 MCP 服务端 SDK 暴露 read_note，只读取 `mcp-servers/reference/resources/notes` 内的两份公开资料，不读取用户上传、平台数据库或模型密钥。

运行 `pnpm dev`，打开需求分析师，新建会话，点击“查询 MCP 示例资料”并发送，或输入：

> 查询示例资料：请通过 MCP 读取 platform-overview，说明示例项目代号和平台能力，并注明资料编号和版本。

预期项目代号为“青禾”，来源 platform-overview，版本 1.0。执行过程包含 load_skill 和 `MCP · reference / read_note`，刷新后保留。`pnpm dev:demo` 也实际连接 MCP，但模型部分是明确标记的固定演示流程；真实供应商验收另外记录。

### 网页管理

打开“MCP 管理”，新增服务并填写 Stdio 命令与逐行参数，或 Streamable HTTP 地址。点击“测试连接”发现工具，选择受支持的只读工具与数字人，再保存。也可先停用保存，稍后完成连接。支持编辑、启停与删除；服务 ID 创建后不可修改，并发修改冲突需刷新重试。探测不会保存配置。

HTTP Bearer 凭证可直接填写，留空保留已有值，或显式清除；接口只返回是否配置，不回显密钥。也可填写 env:变量名引用服务端凭证。直接填写的凭证以明文保存在本机数据目录的 `mcp-settings.json`，权限为 0600，不随代码提交。Stdio 只支持 envRefs 凭证引用。

保存后，所选服务工具同步到数字人绑定与 Core 权限策略，新任务立即生效。当前进程内的活动和排队任务继续使用原连接、工具定义和凭证快照；停用、删除或更换凭证不改写已有任务。

### 初始配置与自定义服务

`config/mcp.yaml` 只在数据目录尚无 `mcp-settings.json` 时导入；之后以网页保存的配置为准，修改 YAML 不覆盖已有设置。首次启动可在 YAML 中增加服务。下面是远程服务配置示例，地址和工具名需要替换为实际服务提供的值：

```yaml
- id: docs
  transport: streamable-http
  url: https://your-mcp.example/mcp
  bearerTokenRef: env:MCP_DOCS_TOKEN
  allowedTools: [search_docs]
  timeoutMs: 10000
  enabled: true
```

在本地 `.env` 中填写 MCP_DOCS_TOKEN；无需凭证时省略 bearerTokenRef。当前远程认证支持固定 Bearer 引用，不包含 OAuth 授权流程。地址仅允许 HTTPS 或本机 HTTP，不允许通过 URL 用户信息、查询参数或片段传入凭证。

本地 Stdio 服务配置示例：

```yaml
- id: docs
  transport: stdio
  command: node
  args: [path/to/your-mcp-server.mjs]
  envRefs:
    SERVICE_TOKEN: env:MCP_DOCS_TOKEN
  allowedTools: [search_docs]
  timeoutMs: 10000
  enabled: true
```

Stdio 使用 command 与 args 启动，不通过 Shell 拼接。cwd 固定为项目根目录，只传递基础系统变量和 envRefs 显式指定的环境变量，不继承模型密钥。服务 ID 为小写字母开头、最多 24 位的小写字母/数字/连字符；工具名允许 1–32 位字母、数字、下划线和连字符。

数字人还要绑定服务和工具：

```yaml
mcpServerIds: [docs]
toolIds: [load_skill, read_skill_resource, read_file, mcp_docs__search_docs]
```

首次导入时根据 worker 的 mcpServerIds 建立服务绑定，管理用例将白名单工具同步到 worker.toolIds 与对应 policy.allowedToolIds。网页绑定使用相同入口。平台工具 ID 固定为 `mcp_<服务ID>__<原始工具名>`；服务白名单、数字人绑定、权限策略均通过后才可调用。启用但未绑定的服务也会测试连接，数字人无法调用其工具。

### 参数、结果与生命周期

首版仅接受管理员白名单中且服务声明 readOnlyHint=true 的工具；只读标记是服务声明，不能替代工具白名单和平台授权。暂不接入写操作和人工审批。

参数必须是可转换成 Zod 对象的 JSON Schema，支持基本类型、properties、required、additionalProperties、enum/const、数值和字符串约束、数组 items/长度与嵌套 anyOf。尚未验证的约束（例如外部引用、patternProperties、format）会拒绝启用，不静默丢弃校验。SDK 使用非 strict 工具协议，Core 仍根据实际 Schema 校验每次调用。

只接收文本结果：整个 content 数组必须全部为文本块；包含图片、资源等非文本块时，即使同时包含文本，也整次工具调用失败，不截取文本部分作为成功结果。远程 isError、非文本结果、超过 128,000 UTF-8 字节的结果均记录失败。远程协议异常映射为平台错误，不向网页、日志或模型转发原始异常细节。自定义服务返回的正常文本属于该服务提供的数据。

启用保存前发现并校验服务，随后关闭连接；失败不会覆盖已有有效配置。启动时重新发现所有已启用服务；缺少凭证或无法发现工具时将服务标记为异常，不影响工作台启动，可在网页修正后重新保存。执行每个工具时建立独立连接，重新核对工具定义，成功、失败、取消或超时后关闭。下次调用重新连接，不自动重试工具执行；SDK 可能在协议协商阶段重启 Stdio 进程。

每次运行保存 MCP 工具配置及 Schema 的 hash 和非敏感配置修订号，不保存连接对象或已解析凭证。进程内保留已有任务的旧工具与凭证闭包；排队任务在重启后遇到版本不匹配会拒绝执行该工具，须重新提交。服务端工具定义发生变化同样拒绝调用。关闭平台会中止正在进行的调用。当前不提供常驻连接池、OAuth、MCP Resources/Prompts 或跨会话服务状态恢复。
