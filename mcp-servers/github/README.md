# GitHub 只读 MCP

独立 Stdio 服务，只访问 `https://api.github.com`，通过现有 MCP Registry → Core 授权入口接入。没有写工具，不依赖平台内部模块或 Agents SDK。默认不启用、不绑定数字人。

## 启动与配置

在项目根目录安装工作区依赖后运行：

```sh
node mcp-servers/github/src/index.mjs --repo your-org/your-repo --repo another-org/another-repo
```

必须显式配置 1–20 个 `--repo owner/name`。仓库 ID 规范化为小写；拒绝 URL、通配符、重复项、路径穿越、百分号编码及非法 owner/name。没有动态仓库发现、任意 URL、API Base URL、分支、路径或写操作参数。工具的 `repository` 只接受启动白名单枚举，不能通过查询修改范围。修改白名单须更新服务参数；平台会重新发现 Schema，并沿用现有配置版本校验。

平台配置见 [config/mcp-github.example.yaml](../../config/mcp-github.example.yaml)。将其中的仓库改为实际批准的仓库；新数据目录可把条目加入 `config/mcp.yaml`，并按 [扩展说明](../../docs/extensions.md) 配置 worker 的 `mcpServerIds`。已有 `mcp-settings.json` 时应使用网页“MCP 管理”新增 Stdio 服务，逐行填入相同参数，测试连接、选择工具与数字人后保存。YAML 不覆盖网页已有配置。

公共仓库可匿名读取。私有仓库在平台服务端环境配置 `MCP_GITHUB_TOKEN`，并使用示例中的 `envRefs`，只把该引用解析为子进程的 `GITHUB_TOKEN`。直接启动服务时则设置 `GITHUB_TOKEN`。不要把 token 放入 args、YAML 明文、网页前端或工具参数。省略 token 时不发送 Authorization；空值或非法凭证格式会拒绝启动。

建议使用只授权白名单仓库的 fine-grained token，并授予 Contents、Issues、Pull requests 的 read 权限；不授予写权限。服务本身始终只发送 GET。相关权限和 API 行为见 [README API](https://docs.github.com/en/rest/repos/contents#get-a-repository-readme)、[Issues API](https://docs.github.com/en/rest/issues/issues#list-repository-issues)、[Pull requests API](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests) 与 [Search API](https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests)。

## 工具

| 工具                   | 参数与结果                                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| `read_readme`          | `repository`；读取默认分支的 README 原文，来源为该仓库的 `#readme` 链接 |
| `list_issues`          | `repository`，可选 `state`、`page`、`limit`；读取一页 Issues，排除 PR   |
| `search_issues`        | 同上，加必填 `query`；限定该仓库、Issue 类型、标题和正文                |
| `list_pull_requests`   | 同分页参数；读取一页 PR                                                 |
| `search_pull_requests` | 同分页参数，加必填 `query`；限定该仓库、PR 类型、标题和正文             |

`state` 为 `open`（默认）、`closed` 或 `all`；`page` 为整数 1–10（默认 1）；`limit` 为整数 1–20（默认 10）。不接受字符串数字、额外参数、任意 issue/PR number。返回值中的条目编号也必须是正安全整数。

搜索接受 1–160 字符的字面短语，支持中文；拒绝纯空白、控制字符、冒号、双引号和反斜线。服务自行添加不可覆盖的 `repo:` / `is:` / `in:title,body` 条件，并把输入放入引号中，不接受原始 GitHub 搜索语法。例如 `query: "bug fix"` 搜索该短语，`query: "repo:other/private"` 会失败。GitHub 搜索受索引时效影响；若 API 标记 `incomplete_results`，结果明确保留该标记。

结果仅为文本，包含查询来源与每条 Issue/PR 的 GitHub URL、编号、状态、标题和正文摘要。逐项校验 API 来源 URL 与请求仓库匹配；不请求 API 返回的 URL。README 最多约 24,000 UTF-8 字节，标题 200 字节、正文 800 字节，整次结果不超过 64,000 字节；截断显式标记。仓库内容视为不可信数据。每次调用只请求一页，不自动分页；Issues API 同页的 PR 会被过滤，因此返回数可能低于 limit，空页不表示后续页没有 Issue。读取的是当前状态，不提供不可变历史快照、评论、文件或 PR diff。

## 失败与验证

单次请求含响应体读取在内最多 8 秒，响应体最多 1 MiB；失败为 MCP `isError`，不返回部分成功文本或原始 API 错误/凭证。401、403、404、限流、重定向、网络、超时和无效/过大响应均映射为固定安全错误。403 的限流头或 429 映射 `GITHUB_RATE_LIMITED`；其他 403 同样提示检查权限并等待，不自动重试或休眠。参见 [GitHub 限流说明](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)。

不跟随任何重定向，包括仓库迁移/重命名，以免绕过固定白名单；确认新仓库后显式更新配置。不提供自定义 API 地址或 GitHub Enterprise 接入。

聚焦验证：`pnpm exec vitest run tests/integration/mcp-github.test.ts`。测试使用真实 MCP 协议、伪造 GitHub fetch 响应及真实 Stdio 发现，不调用 GitHub、不依赖凭证或真实模型。实际执行命令与结果见 [验收记录](../../docs/mcp-verification.md)。
