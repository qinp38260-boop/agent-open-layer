# PROBES —— 本机实测能力矩阵

> 生成时间：2026-11-10 18:03:17 · 生成命令：`node scripts/probe-matrix.mjs`
> 证据等级：✅ 本机实测/源码级 · ⚠️ 仅文档 · U 查不到口子（不实现、不伪装）
> **重跑即刷新**：升级宿主后跑同一条命令，与本文件 diff 就是漂移。

| 宿主 | 版本 | 能力 | 观测结果 | 怎么验的 | 等级 |
|---|---|---|---|---|---|
| codex | 0.167.0 | approval 取值（顶层） | on-request \| never | `codex --help \| grep ask-for-approval` | ✅ 本机实测 |
| codex | 0.167.0 | exec 模式是否有 -a/--ask-for-approval | 没有（只能 -c approval_policy 或 bypass） | `codex exec --help` | ✅ 本机实测 |
| codex | 0.167.0 | exec 关键开关 | approve-for-me / json / bypass | `codex exec --help` | ✅ 本机实测 |
| codex | 0.167.0 | review 是否支持 --approve-for-me | 不支持（实测报 unexpected argument） | `codex exec review --uncommitted --approve-for-me` | ✅ 本机实测 |
| codex | 0.167.0 | 第三方模型（OpenAI 兼容） | 可接（不写 wire_api；写了会报 chat 已废弃） | `codex exec -c model_providers.deepseek.* -m deepseek-chat` | ✅ 本机实测 |
| codex | 0.167.0 | 事件流结构（--json） | thread.started / turn.started / item.completed / turn.completed；item: agent_message\|command_execution\|error；**无 approval 字段** | `codex exec --json` | ✅ 本机实测 |
| codex | 0.167.0 | 被 policy 拒绝的表现 | 仅 stderr `Rejected(... blocked by policy)`，事件流里不出现该命令 | `codex exec -s read-only` | ✅ 本机实测 |
| codex | 0.167.0 | Stop hook（原生自动续跑） | 存在：hooks.json → decision:block 可强制再跑一轮；需 hook 受信任 | `实测 hooks.json + --dangerously-bypass-hook-trust` | ✅ 本机实测 |
| codex | 0.167.0 | PreToolUse hook 能否否决动作 | 能：返回 decision:block 后文件未被创建，stderr 出现 Command blocked by PreToolUse hook | `实测 8 动作矩阵` | ✅ 本机实测 |
| codex | 0.167.0 | 无头模式是否有中间档 | 没有：approval=never 与 on-request 都等于拒绝，除全局 bypass 无选择性放开 | `多轮对照` | ✅ 本机实测 |
| codex | 0.167.0 | hook 是否需要 feature flag | 不需要：带/不带 --enable hooks 结果一致（两次均 hook=2, msg=2），真正门槛是 trust | `C/D 对照实验` | ✅ 本机实测 |
| codex | 0.167.0 | Stop hook 输入字段 | session_id/turn_id/transcript_path/cwd/hook_event_name/model/permission_mode/stop_hook_active/last_assistant_message | `hook stdin 实录` | ✅ 本机实测 |
| codex | 0.167.0 | 自动续跑能力（exec resume） | 有（SESSION_ID + PROMPT），wrapper 可驱动续跑 | `codex exec resume --help` | ✅ 本机实测 |
| codex | 0.167.0 | 只有 bypass 才真执行 | approval_policy=never + workspace-write 仍被拒；--dangerously-bypass-* 才真写盘 | `金丝雀写文件对照实验` | ✅ 本机实测 |
| dsh | 0.1.0-rc.7 | 配置读回（--dump-config） | 可用，能看出 entry 的 config 与 patched by | `dsh --profile web --dump-config` | ✅ 本机实测 |
| dsh | 0.1.0-rc.7 | identity 开关 | 未解析 | `dump-config 中 system-prompt entry` | U |
| dsh | 0.1.0-rc.7 | approval.policy=never 的真实语义 | **自动拒绝**（fail-closed），不是放开 —— 源码 NEVER_SENTENCE 原文 | `dsh-user-approval/lib/index.js` | ✅ 源码级 |
| dsh | 0.1.0-rc.7 | headless 非交互模式 | 可用（可做金丝雀探针） | `dsh --profile headless "reply with PONG"` | ✅ 本机实测 |
| dsh | 0.1.0-rc.7 | 行为探针（金丝雀） | 可实现 | `oag probe --adapter dsh` | ✅ 本机实测 |
| claude-code | not-installed | CLI 是否存在 | 无（本机未安装） | `claude --version` | ✅ 本机实测 |
| claude-code | — | 配置格式 | settings.json = JSON，**不支持注释** → 不能用 marker，只能命名空间键 | `格式事实` | ✅ 事实 |
| claude-code | 2.1.322(包内) | settings 键位 | ~/.claude/settings.json → permissions.{allow,deny,ask,additionalDirectories} | `claude.exe 字符串` | ✅ 包内取证 |
| claude-code | 2.1.322(包内) | 权限模式枚举 | default \| acceptEdits \| auto \| dontAsk \| plan \| bypassPermissions | `sdk-tools.d.ts` | ✅ 包内取证 |
| claude-code | 2.1.322(包内) | bypassPermissions 前置条件 | 需启动参数 --dangerously-skip-permissions（否则拒绝设置） | `claude.exe 字符串` | ✅ 包内取证 |
| claude-code | 2.1.322(包内) | hook 事件 | PreToolUse/PostToolUse/PermissionRequest/UserPromptSubmit/SessionStart/SessionEnd/Stop/SubagentStop/PreCompact/Notification | `claude.exe 字符串` | ✅ 包内取证 |
| claude-code | — | 规则语法 | Tool(pattern)，例如 Bash(git *)、Read(~/.zshrc)、Edit(.claude-test/specs/**) | `claude.exe 字符串` | ✅ 包内取证 |
| claude-code | — | 真机行为 | 未运行（未安装 CLI） | `-` | U |

## 结论（人读）

- **同一个 `never` 两个意思**：DSH 是「需要审批的动作被自动拒绝」，Codex 是「从不询问」。任何抽象都不能按枚举名映射。
- **Codex 在 exec 模式下没有审批通道**：被拒只体现在 stderr，事件流里那条命令根本不出现 → 探针只能靠「产物 + stderr + turn.completed」三件事判。
- **Codex 想真执行只有一条官方路**：`--dangerously-bypass-approvals-and-sandbox`（help 原文标 EXTREMELY DANGEROUS）。
- **Claude Code 的键语义仍然未知**：`claude` CLI 本机没装 → 命名空间写了但无法证明宿主认不认 → 一律 `skipped`，不给通过。
