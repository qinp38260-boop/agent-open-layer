# ROADMAP

## v0.1（已完成，已发布）
- DSH 适配器：配置层托管块（官方 `cordis.patch.yml`，0 处源码补丁）
- CLI：`status / plan / apply --yes / revert --yes / verify / audit`
- 幂等写入 + 写前备份 + 审计 jsonl + 单测（5 条）

## v0.2（本次）
- **修正语义错误**：`approval.policy: never` = 自动拒绝（fail-closed），不是放开；
  默认配置里移除该项，把宿主原文引到注释里当证据
- 文档增加「每个开关必须取证」的硬规矩 + SECURITY.md

## v0.3（待做）
- **宿主无关**：抽出 adapter 契约（`detect() / readConfig() / plan() / apply() / verify()`），
  DSH 只是第一个 adapter
- 逐个宿主取证并给能力矩阵（能落地的写 ✅，只能变通的写 ⚠️，做不到写 ❌，查不到标 UNDOCUMENTED）：
  - Anthropic Claude Code：`settings.json`、`hooks.PreToolUse`、`--permission-mode`
  - OpenAI Codex CLI：`config.toml` 的 `approval_policy` / `sandbox_mode`
  - Cursor / opencode / Cline / Continue
- 真正的「放宽执行」路线：`permission-presets` 白名单 + 危险命令黑名单 + 审计回放，
  而不是关闭审批门（关闭审批门在多数宿主里等于 fail-closed 或招致无提示执行）
- CI：node 18/20/22 matrix 跑 `node --test`

## 非目标
- 不修改宿主源码（这是与 `*-purge` 类项目的根本区别）
- 不做「静默自我放行」（改自己配置以绕过限制）
- 不内置任何第三方资产包 / 技能包 / 演练包
