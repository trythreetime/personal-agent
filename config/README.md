# 平台配置

第一版在此建立 platform.yaml、models.yaml 与 permissions.yaml。数字人预设放在 resources/workers，技能放在 resources/skills。

配置保存凭证引用，例如 `env:OPENAI_API_KEY`，不保存明文密钥。配置由启动流程校验后导入；变更在下次启动生效，活动 Run 使用固定版本。

platform.yaml 设置执行轮次、超时与上传限制，models.yaml 包含 DeepSeek 和 OpenAI 预设，permissions.yaml 定义分析师只读策略。缺少模型凭证时允许启动工作台，相关数字人标记为未就绪并禁止提交任务。

`.env.example` 中的模型名和 Base URL 可覆盖相应预设；自定义模型直接添加配置并修改数字人的 modelId。首版兼容协议工具不启用供应商 strict 扩展。
