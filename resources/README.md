# 数字人与技能资源

workers 存放数字人 YAML 预设，skills 存放包含 SKILL.md、references 和 assets 的技能资源。首个预设为需求分析师，绑定需求分析技能与受控只读工具。

启动扫描技能元数据，执行时按需读取正文。技能不能扩展工具权限，第一版不执行技能脚本。

已提供 `workers/analyst.yaml` 和 `skills/requirement-analysis`。增加自定义 Skill 的完整步骤见 [扩展说明](../docs/extensions.md)。
