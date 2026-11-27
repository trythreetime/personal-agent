# 项目约定

本项目第一版以网页单任务闭环为交付范围。架构与职责以 docs/architecture-v1.md 为准，运行方式见 README.md。

- apps/web 的运行时代码只能依赖 contracts；服务端凭证不得进入前端。
- 网页基础控件使用 Ant Design Vue，统一主题在 apps/web/src/ui/theme.ts；自定义 CSS 负责页面布局与消息内容样式。
- core 定义业务规则、授权和端口，不导入 Fastify、数据库、磁盘或 SDK 实现。
- Agents SDK 仅在 agent-runtime 使用，SDK 类型和原始事件不得泄漏到公共契约。
- infrastructure 实现 Core 端口，server/bootstrap 完成具体装配。
- 所有工具必须经过 Core 授权入口。Skill 和后续 MCP 不得绕过该入口。
- 后续功能只有出现实际调用者时才建立模块，不铺空文件或无实现的接口。
- 修改共享契约后检查前后端消费者；改变数据库结构时新增迁移，不修改已应用迁移。
- 运行 pnpm typecheck 和 pnpm test；修改网页闭环时再运行 pnpm test:e2e。网页测试使用独立端口与 data/e2e，不依赖真实模型或用户凭证。
- 使用 pnpm format 统一源码格式。真实供应商验收与演示、兼容接口测试分别记录。
