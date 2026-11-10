# ARCH v1 —— 宿主无关的 AI Agent 开放层（open-agent-gate）

> 状态：**DRAFT v1 · 依 v0 评审重写 · 待第二轮交叉评审**
> v1 相对 v0 的改动全部来自 `docs/review-v0-claude.md` 的 2 条致命 + 6 条重要意见，逐条在 §11 对账。
> 已实测事实打 ✅，只有文档依据打 ⚠️，查不到口子打 U。

---

## 0. 一句话

给各家 AI coding agent 一层**声明式权限/控制流配置**：只用宿主官方扩展面（配置层、hooks、plugin API），
**不修改宿主源码**，权限模型是「动作 × 决策 × 作用域」三维，宿主真实行为由**行为探针**实测而非断言自证，
默认 fail-closed，带审计、配置哈希与幂等回滚。

---

## 1. 目标与非目标

### 1.1 目标
1. 用**同一份 profile 声明**，在多个宿主上得到语义一致的效果（更宽松的读/写/执行/网络，或更严格）。
2. **零源码补丁**：只写宿主官方认可的配置文件 / hook 脚本 / 包装进程。
3. 每一条效果都可**实测验证**：probe（金丝雀动作）→ 观察决策 → 记入矩阵，附宿主版本。
4. 出错必须**fail-closed**：未声明即宿主默认；apply 失败必须回滚；漂移必须中止。

### 1.2 非目标
- 不修改 `node_modules` / `app.asar` / 反编译产物；不做内容锚点文本替换（那是 `*-purge` 类项目的路线，锚点随版本漂）。
- 不做终端级 hack（识别弹窗、模拟回车、tmux send-keys）。
- 不提供"越狱"保证：本库只做配置层，**不承诺突破宿主的安全模型**。
- 不内置资产包/技能包/演练包（供应链面）。

---

## 2. 权限模型：动作 × 决策 × 作用域

> v0 的错误：把「问不问」（审批）和「能到哪」（边界）压进一个 `*_EXEMPT` 能力枚举里。
> DSH `approval.policy=never` 是 *更严*（自动拒绝），Codex `--ask-for-approval never` 是 *更松*（从不询问），
> 二者真正差别在**边界轴**（sandbox 范围）而不在审批轴。v1 拆开。

### 2.1 三个正交维度

**动作（Action）** —— 被约束的行为，细分到能对应真实拦截点：

| Action | 含义 | 典型拦截点 |
|---|---|---|
| `READ` | 读文件 / 列目录 / 搜索 | 宿主读工具、sandbox 读路径 |
| `WRITE` | 创建 / 修改 / 删除文件 | 写工具、sandbox 写路径、受保护路径（`.git` `.env`） |
| `EXEC_SAFE` | 只读或幂等的命令（`ls` `git status` `cat`） | shell 工具 |
| `EXEC_DESTRUCTIVE` | 不可逆（`rm -rf` `git reset --hard` `format` `DROP`） | 同上 + 红线规则 |
| `EXEC_INSTALL` | 改变环境（`npm i -g` `pip install` `choco`） | 同上 |
| `EXEC_GIT_WRITE` | 改仓库状态（`commit` `push` `rebase`） | 同上 |
| `NET` | 出网请求（域名/URL） | fetch 工具、sandbox 网络白名单 |

> `EXEC_*` 的判据必须是**结构化命令解析**（argv 级 + 二进制真身解析，如 `/bin/rm`、`sh -c 'rm …'`），
> 不能用「命令文本前缀匹配」当安全边界（v0 已标注但未落为硬约束，v1 落为**硬约束**，见 §7.4）。

**决策（Decision）** —— 每个动作在每个作用域上的处置：

| Decision | 语义 |
|---|---|
| `allow` | 不询问，直接执行 |
| `ask` | 询问；无应答通道时**失败关闭**（不是挂起，不是放行） |
| `deny` | 拒绝，且**不可被更宽的 allow 覆盖**（deny 优先级最高） |

**作用域（Scope）** —— 动作能到达的边界：

| Scope 维度 | 形式 | 例 |
|---|---|---|
| 路径 | glob + 显式解析后比对（防 symlink 逃逸） | `workspace/**`, `!workspace/.git/**` |
| 域名 | host 白名单（可含端口/子域策略） | `api.github.com`, `*.pypi.org` |
| 沙箱模式 | 宿主原生枚举的映射（不是我们发明的词） | Codex `read-only`/`workspace-write`/`danger-full-access` |

**一条规则 = `{action, decision, scope}`。** 缺省：任何未命中规则的 `(action, scope)` →
使用**宿主默认**（fail-closed by construction：我们不主动放宽）。

### 2.2 规则优先级（确定性，必须可单测）

```
1. deny      （任何维度命中即 deny，最高优先）
2. ask
3. allow     （仅在 scope 命中且 action 精确匹配时）
4. host default（未命中 → 不写任何配置）
```
同一 (action, scope) 多条规则冲突时：**deny > ask > allow**，与声明顺序无关（避免"后声明覆盖前声明"的隐蔽 bug）。

### 2.3 语义断言 → 行为探针

**v0 的错误**：把「断言」写成适配器作者的自然语言（"这里应该是不再询问"），
而误判语义的正是写它的同一个人；`--dump-config` 只证明键值被写入，不证明行为。

**v1 定义**：断言必须由**探针实测**得出，配置键只是"怎么改"，不是"改成了什么"。

```jsonc
// probe 结果 = 矩阵单元的唯一合法来源
{
  "host": "codex",
  "hostVersion": "0.166.0",          // 必须来自 `codex --version`
  "action": "EXEC_DESTRUCTIVE",
  "scope": {"cwd": "sandbox-tmp"},
  "canary": "rm -rf ./canary-dir",   // 金丝雀动作
  "observed": "executed",            // executed | asked | denied | error
  "decision": "allow",               // 由 observed 推导
  "evidence": {"stdout": "…", "exitCode": 0},
  "probedAt": "2026-11-10T15:02:11Z"
}
```

**探针协议（probe）**
1. 在**临时工作区**（`<tmp>/oag-probe-<rand>`）里准备金丝雀素材：一个可删目录、一个 `.git` 目录、一个只读文件、一个外域 URL。
2. 用宿主的**非交互模式**（Codex `exec`、Claude Code `-p`）依次请求执行金丝雀动作。
3. 观察三类结局：**执行了 / 被问 / 被拒**（看产物是否真被改变 + 退出码 + 输出里的拒绝措辞）。
4. 结果写 `probe-report-<host>-<version>.json`，并成为能力矩阵的**唯一数据源**。
5. probe 期间不改任何宿主配置；probe 完清理临时区。

> 约束：探针在有网环境下会真的出网 → `NET` 探针默认只打**本地 mock 服务器**（127.0.0.1 上一个记录请求的 HTTP 服务），
> 不打真实外域，避免探测行为外泄数据。

---

## 3. 控制流模块（**不是权限**）

v0 把 `IDENTITY` 与 `AUTO_CONTINUE` 塞进权限模型 → 语义被稀释。v1 单列：

| 模块 | 干什么 | 为什么不属于权限 | 风险等级 |
|---|---|---|---|
| `IDENTITY` | 移除/替换宿主注入的身份句、人格前缀 | 不影响任何动作能否执行 | 低（可读性/合规风险） |
| `AUTO_CONTINUE` | 一轮结束后自动续行（无需人工输入） | 不改变单步权限，只改变"谁按继续" | **最高**（可放大误操作次数） |
| `AUDIT` | 记录每次 apply/probe/连续性事件 | — | — |

**AUTO_CONTINUE 硬性护栏**
- 只在显式声明时启用；默认关闭
- 必须设 `maxContinues`（默认 1；硬上限 10）
- 每轮续行写 audit（含轮次、原因、上一步动作摘要）
- 连续 2 次无实质进展（无文件变更、无新工具调用）→ 强制停

---

## 4. 适配器契约

```ts
export type Action =
  | "READ" | "WRITE"
  | "EXEC_SAFE" | "EXEC_DESTRUCTIVE" | "EXEC_INSTALL" | "EXEC_GIT_WRITE"
  | "NET";
export type Decision = "allow" | "ask" | "deny";
export interface Scope { paths?: string[]; denyPaths?: string[]; domains?: string[]; sandbox?: string }
export interface Rule { action: Action; decision: Decision; scope: Scope }
export interface Profile { rules: Rule[]; identity?: IdentitySpec; autoContinue?: AutoContinueSpec }

export interface HostAdapter {
  readonly id: string;                                  // "codex" | "claude-code" | "dsh"
  detect(env: Env): Promise<{ version: string; home: string; configPath?: string }>;
  capabilities(): CapabilityMatrix;                     // 静态声明：哪些 (action, mechanism) 有官方口子
  probe(env: Env, target: Action[]): Promise<ProbeResult[]>;   // 行为实测（只读宿主，写临时区）
  plan(p: Profile, env: Env): Promise<Plan>;            // 纯函数：输出 diff + 断言 + baseHash
  apply(plan: Plan, env: Env, opts: { yes: boolean }): Promise<ApplyResult>;
  verify(plan: Plan, env: Env): Promise<VerifyResult>;  // 读回 + 再 probe 关键动作
  revert(env: Env): Promise<void>;                      // 幂等
}
```

### 4.1 `Plan` 必备字段

```ts
interface Plan {
  hostId: string;
  hostVersion: string;
  diff: string;              // 人可读
  files: { path: string; beforeHash: string | null; afterText: string; mode: "fill" | "append" | "replace-block" }[];
  assertions: ProbeResult[]; // 空数组 = 未验证 → apply 必须拒绝（§7.2）
  baseHash: string;          // apply 前环境指纹（§7.3）
}
```

### 4.2 错误语义（必须在 CLI 上可区分）

| code | 含义 | 处置 |
|---|---|---|
| `SEMANTIC_CONFLICT` | 声明要求与 probe 结果相反（如要求 allow，宿主实测 deny） | 拒绝写入 |
| `UNVERIFIED_RULE` | 该规则没有 probe 证据 | 拒绝写入（除非 `--allow-unverified` 且写 audit） |
| `MANAGED_LAYER_READONLY` | 目标配置被组织策略托管 | 拒绝 |
| `HOST_DRIFT` | apply 前 baseHash 变了（plan→apply 竞态） | 中止 + 重新 plan |
| `VERIFY_FAILED` | 读回不匹配 | 自动 revert |
| `REVERT_FAILED` | 回滚失败 | 输出精确人肉步骤 + 备份路径，绝不静默 |

---

## 5. 能力矩阵（数据来自 probe，不是文档）

> 规则：**矩阵单元格 = 一份 probe-report**。文档只能进"机制候选"，不能直接进矩阵。
> 当前实测进度：Codex ✅（本机 0.166.0，帮助文本已核）；Claude Code ⚠️ 未装；DSH ✅ 语义已核（作为反例保留）。

| 动作 | Codex 0.166.0 | Claude Code | DSH 0.1.0-rc.7 |
|---|---|---|---|
| `READ` | ⚠️ 官方 `sandbox` 枚举含只读模式（probe 待跑） | ⚠️ allow 规则（文档） | — |
| `WRITE` | ⚠️ `workspace-write` / `danger-full-access`（probe 待跑） | ⚠️ acceptEdits/allow（文档） | — |
| `EXEC_SAFE` | ✅ `--ask-for-approval never` + `--sandbox` | ⚠️ allow 规则 | ⚠️ **反例：`never` = 自动拒绝** |
| `EXEC_DESTRUCTIVE` | ⚠️ 需 probe 确认 `rm -rf` 是否被熔断 | ⚠️ hook 可 deny（文档） | U |
| `EXEC_INSTALL` | ⚠️ 同 `EXEC_SAFE`，需单独 probe | U | U |
| `EXEC_GIT_WRITE` | ⚠️ 需 probe（`.git` 保护） | ⚠️ 受保护路径可能永远 ask | U |
| `NET` | ✅ `--sandbox` + `workspace-write` 网络开关（需 probe 本地 mock） | ⚠️ WebFetch allow ≠ sandbox 域 | — |
| `IDENTITY` | U | U（CLAUDE.md 仅追加） | ✅ `system-prompt.includeHarnessIdentity=false` |
| `AUTO_CONTINUE` | ⚠️ Stop hook 返回 block（文档，v1 待 probe） | ⚠️ wrapper 喂 continue | — |

---

## 6. 目录结构（v1）

```
open-agent-gate/
├─ docs/{ARCH.md, REVIEWS.md}
├─ src/
│  ├─ core/
│  │  ├─ rules.ts          # 三维规则 + 优先级（§2.2，纯函数，全单测）
│  │  ├─ managed-block.ts  # 托管块/幂等/备份/原子写
│  │  ├─ hash.ts           # baseHash（文件内容 + 版本 + git status）
│  │  ├─ audit.ts
│  │  └─ probe.ts          # 探针驱动（沙箱临时区 + 本地 mock HTTP）
│  ├─ adapters/{codex,claude-code,dsh}/
│  └─ cli.ts               # status|probe|plan|apply|verify|revert|audit
├─ fixtures/               # 宿主读回样例（CI 用，不碰真实宿主）
└─ tests/                  # rules/hash/managed-block/probe-mock/golden-diff
```

---

## 7. fail-closed（v1 = 8 条，v0 是 7 条）

1. **默认保守**：未声明能力不碰；`apply` 必须显式 `--yes`。
2. **无证据不写**：`UNVERIFIED_RULE` 直接拒绝（v0 缺失）。
3. **竞态防护**：`plan` 记录 `baseHash`；`apply` 前重算，不等 → `HOST_DRIFT` 中止（v0 缺失）。
4. **managed 层只读**：检测到组织托管配置 → 拒绝覆盖。
5. **写后读回**：`verify` 读回 + 对关键动作**再 probe**；不符 → `VERIFY_FAILED` → 自动 revert。
6. **hook 失败 = 显式 deny**：hook 脚本异常/超时/无输出 → 返回 deny + 原因；
   **不依赖"交还宿主默认"**（v0 的错误假设：多数宿主把非 2 退出码当放行，headless 下会挂起或误放行）。
7. **路径与命令必须显式解析**：symlink 解析到真实路径再比 glob；命令按 argv 解析二进制真身，
   前缀匹配仅作**快速拒绝**，不作**放行**依据。
8. **回滚兜底**：apply 中途失败立即回滚；回滚失败输出人肉步骤 + 备份路径。

---

## 8. v0.1 范围（先 Codex，后 Claude Code）

**顺序调整理由（采纳评审）**：Codex 配置是声明式 TOML、可 `--dump-config` 读回、有 `Stop` hook 可做自动继续，
**最容易做"配置 → probe → 验证"闭环**；Claude Code 的 hook 语义（非 2 退出码=放行）风险更高，应后做。

| 阶段 | 交付 |
|---|---|
| v0.1.0 | Codex 适配器：`READ/WRITE/NET/EXEC_*` 规则 → 生成 `~/.codex/config.toml` 托管块；`probe` 跑 4 类金丝雀；`verify` 读回 + 复 probe |
| v0.1.1 | `AUTO_CONTINUE`（Stop hook + `maxContinues=1`） |
| v0.2.0 | Claude Code 适配器（hook 型，先做 deny-only 模式：只收紧不放宽） |
| v0.3.0 | DSH 适配器（配置层，`approval.policy` 语义反例作为回归用例） |

---

## 9. 测试策略（不碰真实宿主）

1. **纯逻辑单测**：规则优先级、glob/symlink 解析、hash、托管块幂等/还原、golden diff。
2. **probe mock**：把 probe 的"宿主"抽象成可注入的 `HostRunner`，单测里用假 runner 返回 `executed/asked/denied`，
   断言规则→决策映射正确。
3. **fixture 读回**：把真实 `--dump-config` 输出存成 fixture，验证解析与 verify 判定。
4. **真实宿主只在用户机器上跑**（`probe`/`verify` 需要真 CLI），CI 永不调用。

---

## 10. 风险（评审指出，必须写进 README）

| 风险 | 说明 | 缓解 |
|---|---|---|
| **用户误用（最大）** | "声明式 + fail-closed"给人虚假安全感，用户可能不知情开了 bypass 级权限 | 高权限规则强制二次确认 + 每次 apply 打印"你将获得什么" + 默认 profile 只有 `ask` |
| 宿主版本漂移 | 键改名/语义变，矩阵悄悄失效 | probe 带版本号；verify 复 probe；漂移 → `HOST_DRIFT`/`VERIFY_FAILED` |
| hook 语义差异 | 非 2 退出码含义因宿主而异 | 只做显式 deny，不依赖默认；能力矩阵单元格必附 probe |
| 取证难度 | 部分宿主无官方口子 | 诚实标 U，不实现，不伪装 |

---

## 11. v0 → v1 对账（逐条对应 `review-v0-claude.md`）

| 评审意见 | v1 落点 | 状态 |
|---|---|---|
| 致命①：审批轴与边界轴混在一起 → 动作×决策×作用域 | §2.1 三维模型；`Rule{action,decision,scope}` | ✅ 已重构 |
| 致命②：断言是手写自证 → 行为探针 | §2.3 probe 协议；`Plan.assertions` 必须来自 probe；`UNVERIFIED_RULE` 拒写 | ✅ 已重构 |
| 重要①：IDENTITY/AUTO_CONTINUE 不是权限 | §3 控制流单列 + AUTO_CONTINUE 硬护栏 | ✅ |
| 重要②：SHELL 太粗 | §2.1 拆成 `EXEC_SAFE/DESTRUCTIVE/INSTALL/GIT_WRITE` | ✅ |
| 重要③：hook 的 fail-closed 不可靠 | §7.6 改为**显式 deny**，不依赖宿主默认 | ✅ |
| 重要④：symlink / 前缀 / plan→apply 竞态 / 升级语义 | §7.3 baseHash、§7.7 显式解析 | ✅ |
| 重要⑤：v0.1 应先做 Codex | §8 顺序调整 | ✅ |
| 建议①：断言→行为探针（金丝雀 + 版本） | §2.3 + §5 矩阵数据源 | ✅ |
| 建议②：控制流单列 + 三维权限 | §2 + §3 | ✅ |
| 建议③：hook 显式 deny + apply 前后哈希 | §7.6 + §7.3 | ✅ |
| 遗留未决 | Claude Code hook 语义未本机实测（`claude` 未安装）→ 标 ⚠️；Codex probe 尚未跑（v0.1.0 第一件事） | ⚠️ |

---

## 12. 引用（v1 新增/沿用）

- Anthropic Claude Code Hooks：https://code.claude.com/docs/en/hooks
- Claude Code 权限模式：https://code.claude.com/docs/en/permission-modes
- OpenAI Codex 配置参考：https://developers.openai.com/codex/config-reference
- Codex Sandbox：https://developers.openai.com/codex/sandbox
- 本机实测：`codex --help`（0.166.0）、`dsh --profile web --dump-config`（0.1.0-rc.7）、
  `dsh-user-approval/lib/index.js` 的 `NEVER_SENTENCE` / `ASK_SENTENCE`
