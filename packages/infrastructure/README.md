# 基础设施适配

目标包名为 `@digital-worker/infrastructure`。实现 Core 的存储、配置、文件、技能资源、凭证和日志接口；持有 SQLite 连接、迁移、仓储以及内置工具的具体操作。

允许依赖 Core 和 contracts。不得导入 Runtime 或 Agents SDK，不决定任务状态流转或工具是否授权。工具的实际文件操作在此实现，授权由 Core 完成。

`src/database/schema` 定义 Drizzle Schema，`src/database/store.ts` 实现 PlatformStore 和事务；`migrations` 保存带校验的迁移。配置、文件、技能、内置工具、凭证和日志分别保存在对应 src 子目录。

技能发现与文本快照加载暂集中在 config/load.ts，工具按需向模型提供正文，脚本不执行。后续需要多种技能来源时再抽取独立 SkillSource。
