# 业务核心

目标包名为 `@digital-worker/core`。domain 定义数字人、模型、技能、工具、权限、任务、运行与会话；application 组织创建、执行、取消、查询与授权；ports 定义外部依赖接口。

内部包仅依赖 contracts。不得导入 Runtime、Infrastructure、Fastify、Drizzle 或 Agents SDK。所有工具执行通过统一授权入口。

`src/domain` 包含实体、配置 Schema 和注册表，`src/ports` 定义适配接口，`src/application/platform.ts` 组织生命周期；上下文构建与授权工具入口分别位于 application/context 和 application/tools。

首版存储接口聚合为事务边界明确的 PlatformStore，避免将一次原子操作拆成多个独立仓储调用。接口所有权和依赖边界见 [架构基线](../../docs/architecture-v1.md)。
