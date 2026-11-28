# MCP 接入验收记录

日期：2026-11-27（Asia/Shanghai）。

## 自动化验证

- `pnpm typecheck`：通过。
- `pnpm test`：35 项通过；依赖边界检查通过。
- `pnpm test:e2e`：6 项通过；包含生产构建。
- 协议：实际 Stdio 子进程与本机 Streamable HTTP；固定 Bearer 和显式 Stdio 环境凭证。
- 覆盖：发现、白名单、数字人绑定、配置版本、Schema、SDK 工具循环、服务错误、结果大小、超时、取消、握手中关闭、子进程清理。
- 网页：查询入口、MCP 工具记录、连续两轮、刷新恢复；既有上传、历史、小屏和 Markdown 安全场景均通过。

## 真实供应商验证

使用本地既有 DeepSeek 配置（Chat Completions、非思考模式），没有将凭证写入记录，也没有使用用户私有文档。

- 请求：加载需求分析技能，使用 MCP 读取 platform-overview，说明项目代号、平台能力、资料编号与版本。
- Task：`b2a9051b-718c-4a89-a918-439a4fef52d4`。
- Session：`07bee978-522f-4d13-a7fa-f4c72a056a43`。
- 运行结果：succeeded。
- 实际工具调用：load_skill completed；mcp_reference__read_note completed。模型在同一轮发起了两项工具请求，SDK 并行执行；当前没有强制技能与工具的先后依赖。
- 输出：准确给出“青禾”，资料编号 platform-overview、版本 1.0，说明网页数字人会话、Skill、MCP 与权限校验。
- 未调用 read_file，没有读取上传文档。

本地会话记录不随代码提交，重新部署时应重新验收。演示模式与本地兼容模型测试分别记录，均不冒充真实模型结果。

## MCP 管理续作最终验证

日期：2026-11-28（Asia/Shanghai）。保留以上 2026-11-27 的历史验收记录；本次没有重新调用真实供应商。

从既有工作区确认本次目标为 MCP 网页管理：Stdio / HTTP 连接探测、只读工具选择、数字人绑定、增删改与启停、凭证保存，以及活动和排队任务的配置快照。现有实现与 8 项管理集成测试已完整，续作补充浏览器管理闭环、修正文档中的旧路径与未实现描述，并统一源码格式。

最终命令与结果：

| 命令 | 结果 |
| --- | --- |
| `pnpm format` | 通过；Mcp.vue、管理集成测试与新增浏览器测试完成格式统一 |
| `pnpm typecheck` | 通过；TypeScript 与 Vue 类型检查均成功 |
| `pnpm test` | 通过；依赖边界检查与 6 个测试文件、43 项集成测试全部通过 |
| `pnpm build` | 通过；包含类型检查与 Vite 生产构建 |
| `pnpm test:e2e` | 通过；7 项浏览器验收全部通过，包含独立生产构建与本机 3101 服务 |
| `pnpm exec prettier --check "{apps,packages,scripts,tests,mcp-servers}/**/*.{ts,mjs,vue,css,json,html}" "*.{ts,json}"` | 通过 |
| `git diff --check` | 通过 |

仓库未定义独立 lint 命令；使用约定的类型检查、依赖边界检查、格式检查、集成测试与浏览器验收。浏览器使用演示模型与真实 MCP 示例服务、独立端口 3101 和 data/e2e，不依赖真实模型或用户凭证。新增浏览器场景验证导航、真实连接发现、新增与绑定、绑定工具生效、刷新、编辑、停用移除新任务工具、删除与小屏无横向溢出。

中途失败与处理：

- 沙箱中的 `pnpm test`：33 项通过、10 项失败，并有 6 项未处理错误；本机 HTTP 监听被 `listen EPERM` 拒绝，相关测试超时。诊断命令 `pnpm exec vitest run tests/integration/sdk-compatible.test.ts` 同样因监听限制导致 3 项失败。允许本机测试监听后重新运行 `pnpm test`，43 项全部通过。
- 沙箱中的 `pnpm test:e2e`：构建完成，但 tsx 创建本地管道被 `EPERM` 拒绝，测试服务未能启动。允许本机测试进程后重试。
- 新增管理用例首次完整执行为 6 项通过、1 项失败；之后 `pnpm test:e2e --grep 'MCP 管理页'` 的 3 次定位调试仍失败。原因依次为 Ant Design Drawer 不提供预期 dialog role、Escape 关闭抽屉、确认按钮文字包含中文空格。修正测试定位与交互后，完整 `pnpm test:e2e` 为 7 项通过，无需变更已有页面逻辑。
- 最后一次测试定位修改后，Prettier 检查指出浏览器测试文件格式问题；重新执行 `pnpm format` 并复查通过。

原有 51 个已修改或未跟踪源码文件全部保留。本次未提交、未部署，也未重置或清理工作区。


## MCP 混合输出完整性修复

日期：2026-11-28（Asia/Shanghai）。本轮只修复 MCP 结果内容校验，未改变网页逻辑，未调用真实模型或外部业务服务。

### 复现与最小修复

原实现用 filter 取出文本块，再拼接为成功结果。通过真实 Stdio MCP 服务复现：文本 + 图片、图片 + 文本两种顺序都会丢弃图片，仅返回文本，违反“非文本结果必须失败”的约定。

现在先检查整个 content 数组：任一块不是 text 或其 text 不是字符串，即抛出现有的 MCP_RESULT_UNSUPPORTED；只有全部为文本块时才拼接。原有空内容拒绝、isError 与大小限制保持不变。

新增四项协议回归：纯文本（两块，验证完整拼接）、纯非文本（图片）、文本在前的混合内容、图片在前的混合内容。每项均检查子进程退出，失败场景不接受部分文本成功结果。

### 本轮实际验证

| 命令 | 结果 |
| --- | --- |
| 修复前：`pnpm exec vitest run tests/integration/mcp.test.ts -t 'MCP 输出仅接受完整文本结果'` | 2 通过、2 失败、14 跳过；两种混合内容用例均复现缺陷 |
| 修复后：`pnpm exec vitest run tests/integration/mcp.test.ts tests/integration/mcp-sdk.test.ts tests/integration/mcp-management.test.ts` | 3 个测试文件、27 项全部通过 |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 依赖边界检查通过，6 个测试文件、47 项全部通过 |
| `pnpm build` | 通过，包含 TypeScript/Vue 检查与 Vite 生产构建 |
| `pnpm exec prettier --check packages/agent-runtime/src/mcp/index.ts tests/fixtures/mcp-server.mjs tests/integration/mcp.test.ts` | 三个相关源码文件格式检查通过 |

本轮未运行 e2e：没有改动网页、共享契约或 HTTP API，变更限于 MCP 工具结果校验。上节的浏览器验收记录为此前结果，不作为本轮重新执行的结果。

工作区范围：仅修改 Runtime MCP 结果校验、测试 MCP 服务、协议回归测试、扩展说明和本验收记录。原 51 项已暂存内容保持不变；原验收记录保留为未改写前缀，既有浏览器测试的未暂存修改保留。未 stage、commit、push 或 deploy。

## GitHub 只读 MCP 服务

日期：2026-11-28（Asia/Shanghai）。接续现有 MCP 工作，保留此前全部已暂存和未暂存变更。此次通过现有 Stdio / MCP Registry / Core 授权入口添加独立服务，不修改公共契约、Runtime、Core、网页、现有服务配置或数字人绑定。

交付范围：

- `mcp-servers/github/package.json`：独立工作区包，复用已锁定的 MCP SDK / Zod 版本；`pnpm-lock.yaml` 仅新增该包的 importer，无依赖升级。
- `mcp-servers/github/src/index.mjs`、`server.mjs`、`server.d.mts`：显式 `--repo` 白名单启动、固定枚举 Schema、五个只读工具、声明类型与安全 API 访问。
- `mcp-servers/github/README.md`、`config/mcp-github.example.yaml`：可选接入、凭证引用、数字人绑定和查询/分页/内容限制；示例不会被默认加载。
- `tests/integration/mcp-github.test.ts`：35 项聚焦验证，包含真实 Stdio 平台发现与 MCP 内存协议调用；GitHub API 由 fetch 替身提供，不访问 GitHub、不使用真实凭证或模型。
- 本验收记录仅追加此节；之前记录保持原样。

覆盖：启动白名单缺失/非法/重复/过长、每个工具的跨仓库拒绝、未知写工具拒绝、现有平台 Schema 转换与只读发现、五个读工具、固定 GET/域名/凭证头、README 与条目来源 URL、搜索范围与类型、中文短语、非法查询/页数/数量/额外参数、PR 过滤、搜索不完整标记、401/403/404/422/429/503、限流头、同域/跨域跳转拒绝、网络异常、请求与响应体超时、非法 API 结构/编号/来源、响应大小与读取取消、多字节文本截断。

实际验证命令与结果：

| 命令 | 结果 |
| --- | --- |
| `pnpm exec tsc --noEmit --allowJs --checkJs --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck mcp-servers/github/src/server.mjs mcp-servers/github/src/index.mjs` | 停在工具自身的 `Verifying lockfile against supply-chain policies (407 entries)` 阶段，未进入 tsc；中断，退出 130。改用已安装的本地二进制完成以下检查 |
| `node_modules/.bin/vitest run tests/integration/mcp-github.test.ts` | 最终 1 个文件、35 项全部通过 |
| `node_modules/.bin/tsc --noEmit --allowJs --checkJs --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck mcp-servers/github/src/server.mjs mcp-servers/github/src/index.mjs` | 通过；检查新增 JavaScript 实现与入口 |
| `node_modules/.bin/tsc --noEmit` | 通过；检查服务端、共享包与测试 TypeScript，不运行 Vue 检查 |
| `node scripts/check-boundaries.mjs` | 通过；包括独立 GitHub MCP 包 |
| `node_modules/.bin/prettier --write mcp-servers/github/package.json mcp-servers/github/src/index.mjs mcp-servers/github/src/server.mjs mcp-servers/github/src/server.d.mts mcp-servers/github/README.md config/mcp-github.example.yaml tests/integration/mcp-github.test.ts` | 通过；只格式化新增文件 |
| `node_modules/.bin/prettier --check mcp-servers/github/package.json mcp-servers/github/src/index.mjs mcp-servers/github/src/server.mjs mcp-servers/github/src/server.d.mts mcp-servers/github/README.md config/mcp-github.example.yaml tests/integration/mcp-github.test.ts` | 通过 |
| `git diff --check` | 通过 |

初次本地检查中，JS checkJs 发现查询/列表参数联合类型不满足字符串字典，补充 JSDoc 类型后通过。首次聚焦测试为 33 通过、2 失败：SDK 对未知工具返回 `isError` 而非 reject，修正测试断言；搜索 Issues 误将 API 返回的 PR 按列表过滤，修正为拒绝错误类型的搜索结果。修正后复跑 35 项全部通过。

未运行全量测试、构建或 e2e；没有改动网页闭环。没有执行真实 GitHub API 或供应商验收，实际仓库、token 权限与 GitHub 搜索索引行为需在按示例配置后验证；不把模拟 API 结果当作真实服务验收。当前功能按设计限制为默认分支 README 和一页 Issue/PR 摘要，无写工具、任意仓库/URL/分支/路径参数或自动重试。未 stage、commit、push 或 deploy。
