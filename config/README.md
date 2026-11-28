# 平台配置

第一版在此建立 platform.yaml、models.yaml、permissions.yaml 与 mcp.yaml。数字人预设放在 resources/workers，技能放在 resources/skills。

此目录的配置保存凭证引用，例如 `env:OPENAI_API_KEY`，不保存明文密钥。模型、技能与数字人配置由启动流程校验后导入；变更在下次启动生效，活动 Run 使用固定版本。

platform.yaml 设置执行轮次、超时与上传限制，models.yaml 包含 DeepSeek 和 OpenAI 预设，permissions.yaml 定义分析师只读策略。缺少模型凭证时允许启动工作台，相关数字人标记为未就绪并禁止提交任务。

`.env.example` 中的模型名和 Base URL 可覆盖相应预设；自定义模型直接添加配置并修改数字人的 modelId。首版兼容协议工具不启用供应商 strict 扩展。

`mcp.yaml` 是首次启动时的服务种子，worker 的 mcpServerIds 用于导入初始绑定。后续以数据目录中的 `mcp-settings.json` 为准，修改 YAML 不会覆盖网页保存的配置。网页“MCP 管理”支持连接测试、工具白名单、数字人绑定、启停和删除；绑定同步到 Core 的数字人工具与权限策略，新任务立即生效，已有任务沿用快照。启用服务会经过发现与校验；启动时连接失败的服务标记为异常，不影响其他服务，可在网页修正后重新保存。

网页输入的 HTTP Bearer 凭证以明文保存在本机 `mcp-settings.json` 中，文件权限为 0600，API 不回显密钥；也可只保存服务端环境变量引用。该文件属于运行时私有数据，不提交仓库。Stdio 凭证仍通过 envRefs 引用。配置示例见 docs/extensions.md。
