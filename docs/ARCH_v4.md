# ARCH v4 —— 策略引擎 + 自检（从"写配置"升级到"可证明的策略"）

> 状态：**已实现 + 45/45 测试通过** · 真机 `oag doctor` 健康、`oag policy` 输出能力缺口
> v4 只加两件事，但都是把工具箱变工具的质变：**策略可以被形式化描述**、**系统能自己体检**。

## 1. 策略 DSL（动作 × 决策 × 作用域）

```jsonc
{ "version": 1,
  "identity": { "stripHostIdentity": true },
  "rules": [
    { "action": "READ",              "decision": "allow", "scope": { "paths": ["workspace/**"] } },
    { "action": "WRITE",             "decision": "allow", "scope": { "paths": ["workspace/**"] } },
    { "action": "EXEC_DESTRUCTIVE",  "decision": "deny",  "scope": {} },
    { "action": "EXEC_INSTALL",      "decision": "ask",   "scope": {} },
    { "action": "NET",               "decision": "ask",   "scope": { "domains": ["api.github.com"] } }
  ],
  "autoContinue": { "enabled": false, "maxContinues": 1 } }
```

- 动作 7 类：`READ / WRITE / EXEC_SAFE / EXEC_DESTRUCTIVE / EXEC_INSTALL / EXEC_GIT_WRITE / NET`
- 决策 3 档：`allow / ask / deny`，**冲突时 deny > ask > allow，与声明顺序无关**（可单测）
- 未声明的动作 = 不存在 → 走宿主默认（我们不主动放宽）

## 2. 编译：能落地就落地，落不了就明说

`compile(policy, hostId)` 输出 `{ payload, unsupported[], notes[] }`，**没有静默丢弃**：

| 宿主 | 落地方式（已验证语义） | 明确报"做不到"的部分 |
|---|---|---|
| DSH | `identity` → `system-prompt.includeHarnessIdentity=false` | 其余全部：DSH 没有已验证的放宽键；`approval.policy=never` 语义是**自动拒绝**，绝不能当 allow |
| Codex | `EXEC_*` 的 allow/ask → `approval_policy="never"/"on-request"`；读/写 deny → `sandbox_mode="read-only"` | `EXEC_*` 全 deny（无"一律拒绝"键）、`NET` 独立开关、`AUTO_CONTINUE`（需 Stop hook） |
| Claude Code | 暂无（键语义未取证） | 全部，理由写"未取证，不落盘以免误导" |

真实输出（`oag policy`）：
```
codex  落地=有  完整=是
  payload: {"id":"policy","patch":{"toml":{"approval_policy":"\"never\"","sandbox_mode":"\"workspace-write\""}}}
dsh    落地=有  完整=否
  ✗ 做不到 EXEC_DESTRUCTIVE(deny) — DSH 该动作无已验证的官方键（approval.policy=never 语义是自动拒绝）
claude-code 落地=无 完整=否
```

`--require-complete` 时，只要**任一宿主有 unsupported** 就退 2 —— CI 可以用它拦住"策略以为生效了"的假象。

## 3. `doctor`：跨宿主自检（只读）

每个宿主 4 项 + 全局 1 项：

| 检查 | 抓什么 |
|---|---|
| `detect` | 宿主是否在、版本（未安装 → **skip**，不算 fail） |
| `config-exists` | 配置文件是否存在 |
| `config-parsable` | JSON 可解析 / TOML 无重复顶层键 / YAML 托管块标记成对 |
| `leftovers` | 我们自己的 `journal / lock / state` 是否残留（残留 → apply 会被拦） |
| 审计 | `<home>/.oag/audit.jsonl` 是否可读，最后一条事件 |

真机结果：
```
oag doctor  健康
  dsh  v0.1.0-rc.7   ✓✓✓✓
  codex v0.167.0     ✓✓✓✓
  claude-code        ✓ 未安装（跳过）
```
`--json` 输出机器可读，退出码 0 健康 / 1 有问题。

## 4. 退出码（全工具统一）

`0` 成功 · `1` verify/doctor 失败 · `2` 未验证 / 需 `--yes` / 策略不完整 · `3` 宿主或版本 ·
`4` 竞态或锁 · `5` IO · `6` 需 recover / 块损坏 · `7` 回滚失败

## 5. v4.2 补齐的三块（原欠账，已完成）

### 5.1 多文件事务 `src/core/txn.js`
`commitTxn({files:[{path,after,baseHash}]})`：按路径排序抢锁 → 残留 journal 拦截 → 全量竞态检查 →
全量备份 + 事务 journal → 备份后再全量比一次 hash → **先全部写临时文件，再全部 rename** →
校验失败则**全量还原** → 清 journal。
`recoverTxn()` 按事务 journal 全量还原。测试覆盖：成功/残留 journal 拒写/竞态一个都不动/校验失败全回滚/recover。

### 5.2 AUTO_CONTINUE `src/core/auto-continue.js` + `oag continue`
实测结论：**Codex 没有"自动继续"的配置键**，官方能力是 `codex exec resume <SESSION_ID> <PROMPT>`
（`codex exec resume --help` 实测存在）→ 续跑只能 wrapper 驱动。

护栏：`maxContinues` 默认 1、**硬上限 10**、空回复不续、出现 `DONE/✅/任务完成` 停、runner 抛错立即停并审计。

真机结果（DeepSeek，两轮）：
```
第1轮: A canary probe is a small, low-risk test change deployed to verify ...
第2轮: A canary probe is a small, low-risk test deployment used to verify ...
共 2 轮（续跑 1 次，上限 1）  session=01a1c642-...
```
→ **resume 确实续上了同一会话**（不是重开）。

### 5.3 DSH 行为探针 `dshAdapter.probe`
用 `dsh --profile headless "<prompt>"` 真跑，按可信度判：**S3 副作用（文件出现且内容对）> S2 宿主拒绝措辞 > 其余 inconclusive**。
真机现状：本机**没有 headless profile** → 如实返回 `skipped`（"未验证≠通过"），并把真实报错带出来。

### 5.4 审计 ↔ 策略联动（v4.3，已完成）
- `policyRef(policy)` → `{hash(16位), rules, decisions, identity, autoContinue}`
- `setAuditContext({policyRef, policyFile})` 之后，**每条审计记录都带** `policy.hash`
- 真机：`apply --policy` 写入的审计行现在长这样
  `{"event":"apply-ok","policy":{"hash":"93ff611264110e06","rules":7,"decisions":{...}}}`
- `oag audit` 直接显示 `policy:93ff611264110e06`

### 5.5 DSH 金丝雀真跑通（v4.3）
卡点不是探针代码，是**宿主侧两个真问题**：
1. **`~/.dsh/.credentials.yaml` 格式不对**：原文件是 `version/refs/records` 三段式，
   而 `dsh-credentials-local@0.1.0-rc.7` 的 `parseCredentialsDocument` 只接受**扁平映射**
   （凭据名 → 字符串），于是 `version`/`refs`/`records` 都被当成凭据名校验 → 报 "must be a string"。
   → 已按扁平格式重写（密钥值原样搬过去），原文件留了两份 `.bak_*`。
2. **headless profile 未安装** → 安了一个最小 profile（`bundles: [dsh-base, dsh-headless]`）。

结果：
```
oag probe --adapter dsh
  ✓ canary-write  文件已写入：hello-canary
probe 通过（宿主自己确认了配置与运行）     ← S3 副作用证据
```
顺带修掉我自己的一个污染：probe 的临时目录原本建在 `<profile>/` 下（残留过一次），现改到系统 temp。

### 5.6 仍待做
1. Codex/Claude 的 **Stop hook** 原生续跑（现在 wrapper 已可用，hook 属优化）
2. Claude Code 的权限键语义取证（本机无 CLI）

## 6. 复盘：什么叫"更高级"

不是功能堆得多，而是**三件事同时成立**：
1. 意图可以被形式化（策略 DSL，而不是一堆手写配置片段）
2. 落地可以被证明（probe / verify / doctor，而不是"我写了所以它应该生效"）
3. 做不到的必须说出来（unsupported + 非零退出码，而不是静默降级）

这轮里 `doctor` 当场抓到我两个 bug：`--cli` 串到别的宿主（codex 被报成 v0.1.0-rc.7）、未安装的宿主被当失败。
