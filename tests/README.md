# 集成与网页验收

单元测试放在对应源码旁。本目录的 integration 覆盖跨模块行为，e2e 覆盖网页闭环，fixtures 提供确定性模型与需求文档。

重点验证工具授权、任务提交幂等、事件补读、终态原子保存、取消和重启处理。真实模型另完成一次完整验收，确认实际工具调用与协议兼容。

integration/platform.test.ts 验证业务和数据边界；integration/sessions.test.ts 验证多轮会话、附件隔离、并发与旧数据迁移；integration/sdk-compatible.test.ts 通过本机 HTTP 流验证实际 Agents SDK 的工具循环、多轮历史、用量缺失与轮次上限；e2e/workbench.spec.ts 验证数字人卡片、会话抽屉、历史切换、刷新恢复、小屏和 Markdown 安全。

执行 `pnpm test` 和 `pnpm test:e2e`。首次网页验收需执行 `pnpm exec playwright install chromium`。网页测试使用演示环境；真实模型验收需在本地配置凭证后另行执行。

当前通过 43 项集成测试与 7 项浏览器验收。integration/mcp.test.ts 通过真实 Stdio 和本机 Streamable HTTP 验证工具发现、Bearer 与环境凭证、参数校验、授权、工具漂移、错误、超时、取消、握手中关闭和子进程清理；integration/mcp-sdk.test.ts 使用真实 Agents SDK 与真实 MCP 服务，本地兼容模型接口返回确定性工具请求，验证完整工具循环。integration/mcp-management.test.ts 验证管理接口的连接探测、增删改、绑定即时生效、并发冲突、保存回滚、凭证不回显及重启保留，并验证 URL/凭证/启用状态变化后活动与排队任务仍使用旧快照。浏览器新增 MCP 管理的连接测试、新增绑定、编辑、停用、删除、刷新恢复与小屏验收。网页 MCP 场景使用固定模型流程，但查询经过真实 MCP 协议，不能作为真实模型验收的替代。

2026-11-27 已另行使用真实 DeepSeek 完成 Skill → MCP reference/read_note → 来源与版本回答的验收。详情见 docs/mcp-verification.md。
