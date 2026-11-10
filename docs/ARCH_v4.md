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

## 5. 还没做（下一步的靶子）

1. **多文件事务**：一次策略要改 2 个文件时，目前是逐文件 journal；需要 txn（全成或全回滚）
2. **`AUTO_CONTINUE` 的 hook 落地**：Codex `Stop` hook / Claude Code `Stop` hook（要先取证 hook 协议）
3. **DSH 行为探针**：`--dump-config` 只能证明写进去了；金丝雀读写删还没做
4. **策略 diff 与审计联动**：现在 audit 记"写了什么"，没记"对应哪条策略规则"

## 6. 复盘：什么叫"更高级"

不是功能堆得多，而是**三件事同时成立**：
1. 意图可以被形式化（策略 DSL，而不是一堆手写配置片段）
2. 落地可以被证明（probe / verify / doctor，而不是"我写了所以它应该生效"）
3. 做不到的必须说出来（unsupported + 非零退出码，而不是静默降级）

这轮里 `doctor` 当场抓到我两个 bug：`--cli` 串到别的宿主（codex 被报成 v0.1.0-rc.7）、未安装的宿主被当失败。
