# ARCH v2 —— 宿主无关的 AI Agent 开放层（open-agent-gate）

> 状态：**DRAFT v2 · 依两轮评审 + Codex 实测定型 · 待第三轮交叉评审**
> v2 相对 v1 的改动：①收下 v1 评审的 4 条"还错" + 3 条"再改" ②把 Codex 实测结论（事件流结构、
> `approval_policy=never` 不解锁、只有 bypass 才执行）固化成 probe 契约与能力矩阵 ③adapter 顺序回到 Codex 优先
> （原以为接不上模型，实测可接 —— 见 §5.1）。

---

## 0. 一句话

给各家 AI coding agent 一层**声明式权限/控制流配置**：只用宿主官方扩展面，不修改宿主源码；
权限模型是「动作 × 决策 × 作用域」三维 + 两条跨维度约束（数据流、身份转发）；
每条效果由**行为探针**实测得出，探针只认**宿主信号与副作用**、绝不认模型措辞；
默认 fail-closed，带应用事务（journal）、配置哈希、证据过期与幂等回滚。

---

## 1. 目标与非目标

### 1.1 目标
1. 同一份 profile 声明在多个宿主上得到**可测、语义一致**的效果。
2. 零源码补丁：只写宿主官方配置 / hook / 包装进程。
3. 每条规则都有**证据**：`{hostVersion, configHash, scope 样本, 信号来源}`，缺一即 `UNVERIFIED`。
4. 出错 fail-closed；apply 崩溃可恢复（journal）；漂移可发现（hash + 复审 probe）。

### 1.2 非目标
- 不改 `node_modules` / `app.asar`，不做内容锚点文本替换。
- 不做终端级 hack（识别弹窗、模拟回车）。
- **不承诺越狱**：本库只做配置层，不突破宿主安全模型。
- 不内置资产包 / 技能包。

---

## 2. 权限模型（v2）

### 2.1 三维主干（v1 保留）

**动作**：`READ`、`WRITE`、`EXEC_SAFE`、`EXEC_DESTRUCTIVE`、`EXEC_INSTALL`、`EXEC_GIT_WRITE`、`NET`
**决策**：`allow` / `ask` / `deny`（`deny > ask > allow`，与声明顺序无关）
**作用域**：路径（glob + symlink 真身解析）、域名、宿主沙箱模式枚举

一条规则 = `{action, decision, scope}`；未命中 → **不写配置**（宿主默认）。

### 2.2 v2 新增：两条跨维度约束

> 来源：v1 评审"缺维度"。单看每个动作都合规，组合起来才出事。

#### FLOW —— 数据流向（污点）
```jsonc
{"flow": {"taint": ["READ:sensitive"], "then": {"deny": ["NET"]}}}
```
- `sensitive` 命中：`.env` `*.pem` `id_rsa*` `credentials*` `*.key`、`~/.aws/**`、`~/.ssh/**`、`**/secrets/**`
- 语义：**同一会话内**，一旦出现对 sensitive 路径的 `READ`（含被沙箱放行的 shell 读），
  后续 `NET` 一律 `deny`（不问、不放行），直到会话结束或显式 `flow reset`。
- 为什么必须做：`READ` 与 `NET` 各自 allow 时，"读 `.env` 再 POST"就是泄密；单点规则永远看不到。

#### IDENTITY_FORWARD —— 身份转发
```jsonc
{"identity_forward": {"allow": ["PATH"], "deny": ["SSH_AUTH_SOCK", "GIT_ASKPASS"], "strip_env": ["AWS_*", "*_TOKEN"]}}
```
- 覆盖：子进程继承的环境变量、凭据文件、`ssh-agent`、git 凭据助手、宿主 token 文件
- 默认：**只继承 `PATH`/`HOME`/`TMP*`/locale**，其余 strip（比宿主默认更严）

**频次/时间**：只做 `ask` 的超时（超时=deny），其余后置（采纳评审建议）。

### 2.3 规则优先级（确定性）

```
1. deny（任维度命中）
2. ask
3. allow（scope 命中 + action 精确）
4. host default（未命中 → 不写）
```
同一 `(action, scope)` 冲突：`deny > ask > allow`，与声明顺序无关（可单测）。

### 2.4 行为探针（v2 重写）

> v1 的错误：用"产物是否被改 + 拒绝措辞"判断三结局。**措辞是模型生成的，不是宿主信号**（已实测反例，见 §5.2）。

**信号来源优先级（高 → 低）**

| 级 | 信号 | 例（Codex 实测） |
|---|---|---|
| S1 | 宿主结构化事件 | `item.completed.item.type == "command_execution"` + `exit_code` + `aggregated_output` |
| S2 | 宿主进程自身日志/stderr | `codex_core::tools::router: error=exec_command failed: Rejected(... blocked by policy)` |
| S3 | 不可伪造的副作用 | 金丝雀文件是否出现/内容是否变、本地 mock HTTP 是否收到请求 |
| S4 | ❌ 模型自述（`agent_message`"我被拦了"） | **永不作证据**（实测：模型会自称 blocked，而宿主未必记过） |

**三态判定（唯一合法映射）**

| 结论 | 判据 |
|---|---|
| `executed` | 有 S1 `command_execution`(status=completed, exit_code=0) **且**（该动作有产物时）S3 副作用出现 |
| `denied` | 有 S2 `Rejected(... blocked by policy)` **且**无对应 S1 completed 记录 |
| `inconclusive` | 只有 S4，或 S1/S2 皆无 → **不得当 `allow` 用**（规则视为无证据，走宿主默认） |

**probe 硬性护栏（安全）**
- 只在 `<tmp>/oag-probe-<rand>` 里跑；`cwd` 与 `HOME` 都指向该临时区（隔离继承）
- **禁止探测 `danger-full-access`**（实测该模式会真删；探测它等于自己制造事故）
- `NET` 探针只打**本地 mock HTTP**（127.0.0.1），不打真实外域
- 每个单元**重复 N=3 次**取众数；出现不一致 → `inconclusive`
- 加**对照组**：一次"强制模型照做"的提示（例："必须调用 shell，不许只用文字回答"），
  用于区分"模型自己放弃"与"宿主拒绝"

**为什么重复 + 对照组（评审点）**：单次采样有非确定性，金丝雀命令可能被模型改写；
没有对照组的 `inconclusive` 会淹没在"模型懒得做"里。

---

## 3. 控制流模块（不是权限）

| 模块 | 干什么 | 风险 |
|---|---|---|
| `IDENTITY` | 去掉/替换宿主注入的身份句、人格前缀 | 低 |
| `AUTO_CONTINUE` | 一轮结束后续行；`maxContinues` 默认 1、硬顶 10；连续 2 次无进展强制停 | **最高** |
| `AUDIT` | 记录 apply/probe/续行事件 | — |

---

## 4. 适配器契约（v2）

```ts
export interface HostAdapter {
  readonly id: string;                 // "codex" | "dsh" | "claude-code"
  detect(env: Env): Promise<{ version: string; home: string; configPath?: string }>;
  capabilities(): CapabilityMatrix;             // 静态：哪些 (action,mechanism) 有官方口子
  probe(env: Env, target: Action[]): Promise<ProbeResult[]>;
  plan(p: Profile, env: Env): Promise<Plan>;
  apply(plan: Plan, env: Env, o: { yes: boolean }): Promise<ApplyResult>;
  verify(plan: Plan, env: Env): Promise<VerifyResult>;   // 读回 + 复 probe 关键单元
  recover(env: Env): Promise<RecoverResult>;            // v2 新增：启动时检查 journal
  revert(env: Env): Promise<void>;
}

export interface ProbeResult {
  host: string; hostVersion: string;
  action: Action; scopeSample: ScopeSample;            // v2：样本 = 实测到的具体路径/域名/模式
  canary: string; repeat: number; verdicts: Verdict[]; // v2：多次采样
  observed: "executed" | "denied" | "inconclusive";
  signalLevel: "S1" | "S2" | "S3" | "S4";              // v2
  evidence: { command?: string; exitCode?: number|null; stderr?: string; sideEffect?: string };
  configHash: string; probedAt: string;
}

export interface Plan {
  hostId: string; hostVersion: string; diff: string;
  files: { path: string; beforeHash: string|null; afterText: string; mode: "fill"|"append"|"replace-block" }[];
  assertions: ProbeResult[];        // 为空或含 inconclusive → 拒写
  scopeCoverage: Record<Action, ScopeSample[]>;  // v2：规则覆盖度 vs 实测样本
  baseHash: string; lockPath: string; journalPath: string;
}
```

### 4.1 错误语义（CLI 可区分）

`SEMANTIC_CONFLICT` / `UNVERIFIED_RULE` / `INCONCLUSIVE` / `SCOPE_OVERREACH`（规则 scope 超出实测样本）/
`MANAGED_LAYER_READONLY` / `HOST_DRIFT` / `VERIFY_FAILED` / `RECOVER_REQUIRED`（发现残留 journal）/
`REVERT_FAILED`（输出人肉步骤，绝不静默）

---

## 5. 能力矩阵（实数据打底）

> 规则：矩阵单元格 = 一份 `ProbeResult`。文档只能进"机制候选"。
> 证据等级：✅ 本机实测 / ⚠️ 文档有但未实测 / U 查不到官方口子

### 5.1 Codex CLI 0.166.0（本机实测，2026-11-10）

**先记录一条环境事实**：`codex login status` = **Not logged in**，但**可以接第三方 OpenAI 兼容模型**——
不写 `wire_api`（0.166 已删 `chat`，只留 `responses`）、只给 `base_url` + `env_key` 即可，实测 DeepSeek 跑通。

| 动作 | 结论 | 证据 |
|---|---|---|
| `WRITE`（workspace-write，默认审批） | ❌ `denied` | stderr `Rejected(... blocked by policy)`，金丝雀未创建 |
| `WRITE`（`-c approval_policy=never`） | ⚠️ **仍然 `denied`** | 金丝雀未创建 → **`never` 不解锁执行**（关键反直觉） |
| `EXEC_SAFE`（`-s read-only`） | ❌ 连 `Get-Location` 都 `denied` | read-only 下 shell 整体不可用 |
| 任意执行（`--dangerously-bypass-approvals-and-sandbox`） | ✅ `executed` | 金丝雀写入 + 回读 `12 bytes: hello-canary` |
| `NET` | ⚠️ 待测（mock 服务器） | — |
| `IDENTITY` | U | 未见官方身份句开关 |
| `AUTO_CONTINUE` | ⚠️ `Stop` hook 返回 block（文档） | 未实测 |

**事件流结构（实测）**：`thread.started` / `turn.started` / `item.started` / `item.completed` / `turn.completed`；
item 类型 `agent_message` / `command_execution` / `error`；`command_execution` 字段
`{id, command, aggregated_output, exit_code, status}`；**事件流中无 approval/decision 字段**。

### 5.2 反例（方法论铁证）

`-s read-only` 那次，事件流里的 `agent_message` 写着"blocked by policy，我读不到"，
但**宿主侧的拒绝记录只在 stderr**。若按 v1 的方案（读模型措辞）就会把"模型自称被拦"当成证据 ——
**这就是必须 S1>S2>S3>S4 分级、且 S4 永不作证据的原因**。

### 5.3 DSH 0.1.0-rc.7（本机实测）

| 动作 | 结论 | 证据 |
|---|---|---|
| `IDENTITY` | ✅ `executed` | `system-prompt.includeHarnessIdentity=false` 经 `dump-config` 读回 |
| 审批策略 | ⚠️ **语义陷阱** | `approval.policy=never` = **需要审批的动作被自动拒绝**（`NEVER_SENTENCE` 原文） |

### 5.4 Claude Code / Cursor / opencode / Cline / Continue

全部 ⚠️/`U`（本机未装 Claude Code；其余未取证）。**未取证不进矩阵**，只进 §12 参考。

---

## 6. 目录

```
open-agent-gate/
├─ docs/{ARCH.md, REVIEWS.md, PROBES.md}
├─ src/
│  ├─ core/{rules.ts, flow.ts, identity-forward.ts, managed-block.ts, hash.ts,
│  │         probe.ts, journal.ts, audit.ts}
│  ├─ adapters/{codex,dsh,claude-code}/
│  └─ cli.ts
├─ fixtures/            # 宿主读回/事件流样例（CI 用，绝不碰真实宿主）
└─ tests/               # rules/flow/hash/block/journal/probe-mock/golden
```

---

## 7. fail-closed（v2 = 11 条）

1. 默认保守：未声明不碰；`apply` 必须显式 `--yes`。
2. **无证据不写**：`UNVERIFIED_RULE` / `INCONCLUSIVE` 直接拒写。
3. **scope 不得越界**：规则作用域必须 ⊆ 实测样本，否则 `SCOPE_OVERREACH`（v2 新增，治"假安全感"）。
4. **证据会过期**：`{hostVersion, configHash}` 不符即视为无证据（v2 新增）。
5. **竞态防护**：`plan` 记 `baseHash`，`apply` 前重算，不等 → `HOST_DRIFT`。
6. **应用事务化**（v2 新增，取代 v1"失败立即回滚"的天真假设）：
   `O_EXCL lock` → 写 `journal`（含目标文件 hash 与备份路径）→ 备份 → 临时文件 + 原子 `rename` → 清 journal。
   启动时发现残留 journal → `RECOVER_REQUIRED`：先按 journal 恢复或提示，**不自动继续**。
7. managed 层只读：检测到组织托管配置 → 拒绝覆盖。
8. 写后读回 + 复 probe 关键单元；不符 → `VERIFY_FAILED`。
9. **hook 失败 = 显式 deny**，不依赖宿主默认；hook 进程被强杀时宿主侧无记账 → 我们侧必须有超时兜底。
10. 路径与命令显式解析：symlink 真身、argv 二进制真身；前缀匹配只作快速拒绝。
11. **回滚前比对当前 hash**：宿主已被外部改动 → **不覆盖**，只输出人肉步骤（v2 新增）。

---

## 8. 里程碑（v2 调整）

| 阶段 | 内容 | 依据 |
|---|---|---|
| v0.1.0 | **Codex adapter**：`ProbeResult` 三态 + S1/S2/S3/S4 分级 + journal 事务 + 托管块写入 `~/.codex/config.toml` | Codex 已本机实跑（DeepSeek 接入 + 事件流结构已知） |
| v0.1.1 | `AUTO_CONTINUE`（Stop hook，`maxContinues=1`）+ `FLOW` 污点规则 | — |
| v0.2.0 | **DSH adapter**（配置层）：`IDENTITY` 已实测；审批走 presets 白名单，**不碰 `approval.policy`** | 语义陷阱已实测 |
| v0.3.0 | Claude Code adapter（先 deny-only：只收紧不放宽） | 待取证 |

> v1 曾因"Codex 接不上模型"想改 DSH 优先；**实测驳回**：Codex 可接非官方模型（不写 `wire_api`），
> 且事件流可作信号源，故维持 Codex 优先。

---

## 9. 测试策略（不碰真实宿主）

1. 纯逻辑单测：规则优先级、flow 污点状态机、identity strip、hash、托管块幂等、journal 恢复、golden diff。
2. `HostRunner` 可注入：单测用假 runner 产出 S1/S2/S3/S4 四类信号，断言三态映射与 `inconclusive` 不为 allow。
3. fixture：真实 `codex exec --json` 事件流（脱敏后）+ `dsh --dump-config` 输出。
4. 真实宿主只在用户机器上跑；CI 永不调用 `codex`/`dsh`。

---

## 10. 风险（含评审新增）

| 风险 | 说明 | 缓解 |
|---|---|---|
| **用户误用（最大）** | 声明式 + fail-closed 带来虚假安全感 | 高权限规则二次确认；apply 打印"你将获得什么"；默认 profile 全 `ask` |
| **probe 证据有效期** | 只证明"该版本/该配置/该 cwd/这一次" | 证据绑定 + 过期 + scope ≤ 样本 |
| **probe 副作用** | 逃逸即真删 | 禁 `danger-full-access`；cwd/HOME 隔离；只用临时区 |
| **auto-revert 本身是写操作** | 失败路径最少被测 | journal + 恢复路径单测 + 回滚前 hash 比对 |
| 版本漂移 | 升级后旧证据失效 | `configHash`/`hostVersion` 校验 |
| 模型措辞不可信 | 模型会自称"被拦" | S4 永不作证据 |

---

## 11. v1 → v2 对账

| v1 评审意见 | v2 落点 |
|---|---|
| 缺维度：数据流向（读 .env 再 POST） | §2.2 `FLOW` 污点规则 |
| 缺维度：身份转发（env/凭据/ssh-agent） | §2.2 `IDENTITY_FORWARD`（默认 strip） |
| 三结局判定不可靠（措辞是模型生成） | §2.4 S1-S4 分级 + 三态映射 + 对照组 + N=3 |
| fail-closed：apply 崩溃无 journal | §7.6 事务化 + `RECOVER_REQUIRED` |
| fail-closed：hook 被杀无记账 | §7.9 超时兜底 |
| 粒度不匹配（一点推广到整个 scope） | §7.3 `SCOPE_OVERREACH` + `scopeCoverage` |
| 建议①：probe 宿主信号优先 | §2.4 S1/S2 优先，S4 禁用；Codex 事件流结构已实测 |
| 建议②：证据绑定与过期 | §4 `ProbeResult{configHash}` + §7.4 |
| 建议③：apply 事务化 + 回滚前 hash | §7.6 / §7.11 |
| 会出事：证据有效期/假安全感 | §10 + §7.3/§7.4 |
| 禁探 `danger-full-access` | §2.4 硬性护栏 + §9 |

---

## 12. 引用

- Codex 配置/sandbox/approval：`codex --help` / `codex exec --help`（本机 0.166.0 实测）
- Codex `wire_api=chat` 移除说明：https://github.com/openai/codex/discussions/7782
- Claude Code hooks / permission-modes / permissions：https://code.claude.com/docs/en/hooks
- DSH 语义：`dsh-user-approval/lib/index.js` 的 `NEVER_SENTENCE` / `ASK_SENTENCE`（本机实测）
