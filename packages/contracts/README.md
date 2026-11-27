# 共享契约

目标包名为 `@digital-worker/contracts`。定义前后端共享的请求、响应、状态、平台事件与错误 Schema，并从 Zod 推导 TypeScript 类型。

不依赖其他内部包，不包含业务用例、Node.js 专属模块、凭证或 SDK 类型。公共变更必须同步考虑 Web 和 server 消费者。

源码按 workers、sessions、uploads、tasks、runs、events 和 errors 划分，公开入口为 `src/index.ts`。Task 创建支持可选 sessionId 和 uploadId，TaskDto.upload 可以为空；SessionDto 保存安全的会话摘要。事件使用 schemaVersion 与 Run 内连续 seq，前端不消费 SDK 原始事件。
