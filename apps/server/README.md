# 后端服务

Fastify 负责 HTTP、文件上传传输、SSE 和静态网页。bootstrap 是具体适配器的装配入口，连接 Core、Runtime 和 Infrastructure，并管理启动恢复与关闭。

路由仅完成校验、调用应用用例和响应映射；业务流程在 Core，SQL 与文件操作在 Infrastructure，SDK 调用在 Runtime。

入口为 `src/main.ts`，装配在 `src/bootstrap`，HTTP 路由映射在 `src/app.ts`，SSE 传输在 `src/http/sse`。接口数量较少，暂不拆分重复的路由与控制器文件。

接口与生命周期见 [架构基线](../../docs/architecture-v1.md)。`pnpm start` 默认监听本机 3100 端口；构建后同源提供 Web。
