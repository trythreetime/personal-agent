# 集成与网页验收

单元测试放在对应源码旁。本目录的 integration 覆盖跨模块行为，e2e 覆盖网页闭环，fixtures 提供确定性模型与需求文档。

重点验证工具授权、任务提交幂等、事件补读、终态原子保存、取消和重启处理。真实模型另完成一次完整验收，确认实际工具调用与协议兼容。

integration/platform.test.ts 验证业务和数据边界；integration/sessions.test.ts 验证多轮会话、附件隔离、并发与旧数据迁移；integration/sdk-compatible.test.ts 通过本机 HTTP 流验证实际 Agents SDK 的工具循环、多轮历史、用量缺失与轮次上限；e2e/workbench.spec.ts 验证数字人卡片、会话弹框、历史切换、刷新恢复、小屏和 Markdown 安全。

执行 `pnpm test` 和 `pnpm test:e2e`。首次网页验收需执行 `pnpm exec playwright install chromium`。网页测试使用演示环境；真实模型验收需在本地配置凭证后另行执行。
