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

## MCP 接入边界

当前尚无 MCP 连接器。后续实现需要增加以下具体部分：

1. Infrastructure 读取 MCP 配置与凭证引用，Core 定义服务描述和数字人绑定规则。
2. agent-runtime 增加 mcp 模块，使用 SDK 连接本地 Stdio 或远程 Streamable HTTP，负责发现、连接清理与异常处理。
3. 将发现的工具转换成平台 ToolDefinition，采用含服务 ID 的唯一工具 ID，并校验参数 Schema。
4. 工具执行通过 Core 的 AuthorizedToolInvoker，再由 Runtime 桥接调用 MCP；不能直接将未经平台授权的 MCP 工具暴露给 Agent。
5. 对本地服务启动、远程服务凭证、工具过滤、超时、重连和跨数字人访问增加验证。

完成这些适配后，增加普通 MCP 服务可以通过配置与绑定完成。当前不提供虚假的 config/mcp.yaml 或空连接器，也不能仅添加 MCP URL 就调用远程工具。
