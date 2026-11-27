# 智能体运行适配

目标包名为 `@digital-worker/agent-runtime`。实现 Core 的 AgentRuntime 接口，将执行计划转换为 SDK Agent，适配模型、工具、流式事件、轮次限制与取消。

允许依赖 Core、contracts 和 OpenAI Agents SDK。SDK 只能在本包使用。工具执行必须回调 Core 的授权入口，不直接操作业务数据库或绕过权限读取文件。

`src/factory` 创建 Agent 与工具桥接，`src/models` 选择协议，`src/runner` 执行与归一化事件。兼容协议不启用供应商 strict 工具扩展，输入仍经过 Core 的 Zod 校验；仅保留可见文本，不输出内部推理链。追踪不向外部导出。

DeepSeek 预设采用非思考模式，避免首版引入推理历史回放约定；默认模型来自 [DeepSeek 当前 Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)，可通过环境变量覆盖。不同供应商的实际兼容性需要各自凭证验证。

未来 MCP 与 SDK Session 适配在本包增加。DemoRuntime 是显式启用的固定流程，不能作为真实模型验收结果。
