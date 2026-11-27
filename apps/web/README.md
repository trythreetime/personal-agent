# 网页应用

Vue 3 + Ant Design Vue 4.2.6 操作入口。第一个菜单通过卡片展示数字人，点击后打开双栏会话抽屉：左侧历史会话，右侧消息、执行过程与输入框。支持新会话、连续追问、可选附件、停止回复和数字人详情；增删改数字人暂不开放。

只能导入 `@digital-worker/contracts`，通过 HTTP 与 SSE 使用后端；不得导入 Core、数据库、Agents SDK 或读取服务端凭证。

入口为 `src/main.ts`，数字人目录为 `src/pages/Workers.vue`，抽屉与消息位于 `src/features/workers`，SSE 消费在 `src/features/tasks/useRun.ts`。Markdown 清理统一在 `src/lib/markdown.ts`。选择状态保存到网址，历史任务链接兼容打开对应会话。

界面基础控件使用 Ant Design Vue：Layout / Menu 负责导航，Card 展示数字人，右侧 Drawer 承载会话，Modal 独立展示数字人详情，手机端通过 Drawer 展开会话列表，消息输入和附件使用 Textarea / Upload，执行记录使用 Table。图标来自 `@ant-design/icons-vue`。主题与中文语言配置集中在 `src/ui/theme.ts`，`src/style.css` 负责布局和会话内容样式。页面路由按需加载。

`SessionSidebar.vue` 复用桌面侧栏和手机抽屉中的会话列表；抽屉焦点、遮罩与滚动由组件库管理。文件选择后仍在发送时调用业务上传接口。

在仓库根目录运行 `pnpm dev` 或 `pnpm dev:demo`。页面与后端边界见 [架构基线](../../docs/architecture-v1.md)。
