# PROBES —— 本机实测能力矩阵

> 生成时间：2026-11-10 16:20:59 · 生成命令：`node scripts/probe-matrix.mjs`
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
| codex | 0.167.0 | 自动续跑能力（exec resume） | 有（SESSION_ID + PROMPT），wrapper 可驱动续跑 | `codex exec resume --help` | ✅ 本机实测 |
| codex | 0.167.0 | 只有 bypass 才真执行 | approval_policy=never + workspace-write 仍被拒；--dangerously-bypass-* 才真写盘 | `金丝雀写文件对照实验` | ✅ 本机实测 |
| dsh | 0.1.0-rc.7 | 配置读回（--dump-config） | 可用，能看出 entry 的 config 与 patched by | `dsh --profile web --dump-config` | ✅ 本机实测 |
| dsh | 0.1.0-rc.7 | identity 开关 | 未解析 | `dump-config 中 system-prompt entry` | U |
| dsh | 0.1.0-rc.7 | approval.policy=never 的真实语义 | **自动拒绝**（fail-closed），不是放开 —— 源码 NEVER_SENTENCE 原文 | `dsh-user-approval/lib/index.js` | ✅ 源码级 |
| dsh | 0.1.0-rc.7 | headless 非交互模式 | 不可用（本机未安装 headless profile） | `dsh --profile headless "reply with PONG"` | ✅ 本机实测 |
| dsh | 0.1.0-rc.7 | 行为探针（金丝雀） | 已实现但环境不满足 → 返回 skipped（未验证≠通过） | `oag probe --adapter dsh` | ✅ 本机实测 |
| claude-code | not-installed | CLI 是否存在 | 无（本机未安装） | `claude --version` | ✅ 本机实测 |
| claude-code | — | 配置格式 | settings.json = JSON，**不支持注释** → 不能用 marker，只能命名空间键 | `格式事实` | ✅ 事实 |
| claude-code | — | 命名空间键是否被宿主接受 | 未取证 | `-` | U |

## 结论（人读）

- **同一个 `never` 两个意思**：DSH 是「需要审批的动作被自动拒绝」，Codex 是「从不询问」。任何抽象都不能按枚举名映射。
- **Codex 在 exec 模式下没有审批通道**：被拒只体现在 stderr，事件流里那条命令根本不出现 → 探针只能靠「产物 + stderr + turn.completed」三件事判。
- **Codex 想真执行只有一条官方路**：`--dangerously-bypass-approvals-and-sandbox`（help 原文标 EXTREMELY DANGEROUS）。
- **Claude Code 的键语义仍然未知**：`claude` CLI 本机没装 → 命名空间写了但无法证明宿主认不认 → 一律 `skipped`，不给通过。
