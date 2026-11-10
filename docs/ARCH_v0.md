> **状态：DRAFT · 未交叉审**
> 本稿由单一模型（deepseek-v4-pro）产出，**尚未**经过第二模型逻辑审。
> 已实证：DSH 语义（本机 dump-config）、Codex `--ask-for-approval` 取值与说明（本机 codex-cli 0.166.0 --help）。
> 未核：Claude Code 权限/hook 细节（本机未装该 CLI，官方页面抓取失败）、Codex granular 逐类拒绝。

# ARCH_v0 —— 宿主无关的 AI Agent 开放层（open-agent-gate）

> 状态：草案 v0.1（进行中，未定稿）
> 定位：一个**公开 GitHub 库**，给多种 AI 编码宿主提供统一的「开放模式」配置层，只走官方扩展面，不做源码补丁。

---

## 0. 一句话

把「读豁免 / 写豁免 / 命令执行豁免 / 网络豁免 / 身份句 / 自动继续」六个**能力**抽象成宿主无关的契约；每个宿主由一个**适配器**负责把能力映射到该宿主的官方配置键 / 官方 hooks / 官方插件 API，并给出该键**真实语义的可验证断言**。默认 fail-closed，全程可审计、可回滚。

**不是**：又一个 `claude-yolo` / `dsh-purge` 式「改源码 / 终端级自动按键」的破甲工具。

---

## 1. 目标与非目标

### 1.1 目标

1. **宿主无关**：同一套能力描述（profile）能在 Claude Code、Codex CLI、Cursor、opencode、Cline、Continue.dev 等宿主间语义一致地落地。用户换宿主，不改自己的意图表达。
2. **只走官方扩展面**：settings/config 文件、官方 hooks、官方插件/扩展 API、env var、wrapper 进程。**0 处宿主源码补丁**（node_modules/app.asar/site-packages 一律不碰）。
3. **语义可验证**：每个开关写成「可验证断言」，而不是「枚举名猜测」。用宿主自己的 `--dump-config` / 配置读回 / hook 实测来证明断言成立，证明不了就标 `UNDOCUMENTED`。
4. **fail-closed 默认**：任何一步出错，恢复宿主的保守默认（还原审批、还原身份句），绝不留下无人看管的自动执行。
5. **可审计 + 可回滚**：audit jsonl 记录每次 apply/revert/verify；幂等 revert + 写前备份。
6. **公开库**：MIT，文档（本文）即 `docs/ARCH.md`，测试不依赖真实宿主。

### 1.2 非目标（明确不做）

- ❌ 不修改宿主源码 / 不解包 app.asar / 不改 site-packages。
- ❌ 不做终端级自动按键（`tmux send-keys` / `capture-pane` 识别审批弹窗并回车）。这类是 hack，见 §7，标记为「非官方、会被封堵、不在本库范围」。
- ❌ 不绕过**组织管理策略**（managed settings / requirements.toml / 企业 dashboard 配置）。凡是宿主明确「managed 层不可被用户层覆盖」的，本库只读、不写、明说做不到。
- ❌ 不「解除所有限制」。本库的能力是**分层的、可选择的**，默认即最小开放面。
- ❌ 不覆盖所有宿主。v0.1 只做 2 个宿主（§8），其余进能力矩阵标注但不实现。

### 1.3 铁律（来自踩过的坑）

1. **枚举名不等于语义**。DSH 的 `approval.policy: never` 语义是「需要审批的动作被**自动拒绝**」（NEVER_SENTENCE 原文：actions that require approval are rejected automatically），不是「全放开」。而 Codex 的 `approval_policy: "never"` 语义恰恰相反——「**从不**弹审批」（官方标注 risky）。**同一个枚举字面量 `never`，在两个宿主里意思相反**。所以本库的每个开关必须落到「可验证断言」，禁止凭名字猜。
2. **配置写入必须：幂等 + 托管块(marker) + 写前备份 + verify 用宿主自己读回实证**。
3. **能力由「效果」定义，不由「键名」定义**。一个能力 = 「某类动作不触发审批」这个效果；适配器的职责是把效果翻译成宿主键，并证明该键确实产生该效果。

---

## 2. 能力模型

六个能力是正交的。用户 profile 只声明「想要哪些」，不声明「怎么写」。

| 能力 ID | 名称 | 效果定义（可验证断言） | 误判风险（为什么不能只看键名） |
|---|---|---|---|
| `READ_EXEMPT` | 读豁免 | 读取/搜索工作区文件**不**触发审批弹窗 | 宿主可能只豁免工作区内读、工作区外读仍弹；网络路径读可能永远不豁免 |
| `WRITE_EXEMPT` | 写豁免 | 创建/编辑文件**不**触发审批 | 受保护路径（`.git`/`.claude`/`.env`）可能永不豁免；symlink 指向外部时行为不同 |
| `SHELL_EXEMPT` | 命令执行豁免 | 执行 shell 命令**不**触发审批 | `Bash(rm *)` 这类**前缀匹配不是安全边界**（`/bin/rm`、`sh -c 'rm …'` 可绕过）；危险命令可能有熔断（`rm -rf /` 仍弹） |
| `NET_EXEMPT` | 网络豁免 | 网络请求（fetch/curl 域名）**不**触发审批 | 与 sandbox 域名白名单是两回事：裸 `WebFetch` allow 不改变 sandbox 可达域名 |
| `IDENTITY` | 身份句 | 宿主强加的身份/人格前缀被移除或替换为自定义 | 有些宿主身份句在 system prompt 里、可被 `system` 键整体替换；有些根本没有官方口子 |
| `AUTO_CONTINUE` | 自动继续 | 一轮结束/被 stop 后，无需人工输入自动进入下一轮 | 这是最容易 fail-open 的能力；多数宿主**没有官方配置键**，只能靠 hooks 或 wrapper |

> 能力与「安全」的关系：`*_EXEMPT` 类能力本质是**放权**，风险随豁免面扩大而上升。本库把每个能力做成独立开关，用户必须显式声明；任何未被声明的能力一律保持宿主保守默认（fail-closed）。

### 2.1 能力 → 断言 的通用规则

每个适配器必须为它支持的每个能力提供一份 `assertions[]`，形如：

```jsonc
{
  "capability": "SHELL_EXEMPT",
  "host": "codex",
  "mechanism": "config",                    // config | hook | wrapper | plugin
  "writes": "approval_policy = \"never\"",
  "assertion": "宿主在命令执行前不再弹出审批（官方标注 risky；与 sandbox_mode 正交）",
  "evidence": "codex --dump-config 读回 + 官方 config-reference 原文",
  "confidence": "VERIFIED"                   // VERIFIED | UNVERIFIED | UNDOCUMENTED
}
```

**confidence 三档**：
- `VERIFIED`：有官方文档原文 + 能在不碰真实宿主的前提下用读回/解析验证。
- `UNVERIFIED`：有官方文档原文，但当前版本未在真实宿主实测。
- `UNDOCUMENTED`：找不到官方口子，诚实标注，不编。

---

## 3. 适配器契约

### 3.1 目录与类型（TypeScript 签名，与现有 dsh-open 一致用 Node/ESM）

```ts
// 能力集合
type Capability =
  | 'READ_EXEMPT' | 'WRITE_EXEMPT' | 'SHELL_EXEMPT'
  | 'NET_EXEMPT'  | 'IDENTITY'      | 'AUTO_CONTINUE';

type CapabilitySet = Partial<Record<Capability, boolean>>;

// 用户意图（宿主无关）
interface ProfileSpec {
  readonly name: string;
  readonly capabilities: CapabilitySet;   // 只声明想要的，未声明 = 不碰
  readonly identity?: {                   // IDENTITY=true 时可选
    readonly mode: 'remove' | 'replace';
    readonly text?: string;
  };
}

// 能力矩阵单元
interface CapabilityCell {
  readonly level: 'OFFICIAL' | 'WORKAROUND' | 'IMPOSSIBLE' | 'UNDOCUMENTED';
  readonly mechanism: 'config' | 'hook' | 'wrapper' | 'plugin' | null;
  readonly assertions: Assertion[];
}

// 宿主探测结果
interface DetectionResult {
  readonly hostId: string;
  readonly installed: boolean;
  readonly version: string | null;
  readonly configLayers: ConfigLayer[];   // 每个可写层：路径 + 是否 managed + 优先级
  readonly readOnly: string[];            // managed 层，本库只读不写
}

// 只读现状
interface HostState {
  readonly effectiveConfig: unknown;      // 宿主读回的生效配置（结构随宿主而异）
  readonly managedOverrides: string[];    // 被 managed 层压住的项
}

// dry-run 计划
interface Plan {
  readonly steps: Step[];                 // 每条：写哪个文件、托管块内写什么、备份路径
  readonly failsClosed: boolean;          // 任何 step 失败是否可整体回滚
}

// apply 结果
interface ApplyResult {
  readonly ok: boolean;
  readonly backupPaths: string[];
  readonly written: string[];             // 写过的文件
  readonly verification: VerifyResult;
}

// verify 结果（用宿主读回实证）
interface VerifyResult {
  readonly ok: boolean;
  readonly hostReadback: unknown;         // --dump-config / 官方读回原文
  readonly assertionsPassed: Assertion[];
  readonly assertionsFailed: Assertion[];
}

// 错误语义：所有方法返回 discriminated union，不抛裸异常
type AdapterResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdapterError };

interface AdapterError {
  readonly kind:
    | 'HOST_NOT_FOUND'          // 宿主未安装
    | 'MANAGED_LAYER_READONLY'  // 目标层被组织管理，不可写
    | 'KEY_NOT_SUPPORTED'       // 该能力在本宿主无官方口子
    | 'SEMANTIC_CONFLICT'       // 键存在但语义与能力断言冲突（如 DSH 的 never）
    | 'VERIFY_FAILED'           // 写入后读回不匹配
    | 'ROLLBACK_FAILED';        // 回滚未完成，必须人工介入
  readonly message: string;
  readonly revertState: 'CLEAN' | 'REVERTED' | 'MANUAL_REQUIRED';
}
```

### 3.2 适配器接口

```ts
interface HostAdapter {
  readonly id: string;                                  // 'claude-code' | 'codex' | ...
  readonly capabilities: Record<Capability, CapabilityCell>; // 能力矩阵（静态，随文档版本走）
  detect(): Promise<AdapterResult<DetectionResult>>;
  read(): Promise<AdapterResult<HostState>>;
  plan(profile: ProfileSpec): Promise<AdapterResult<Plan>>;
  apply(profile: ProfileSpec): Promise<AdapterResult<ApplyResult>>;
  verify(profile: ProfileSpec): Promise<AdapterResult<VerifyResult>>;
  revert(): Promise<AdapterResult<ApplyResult>>;         // 幂等，只动托管块
}
```

### 3.3 错误语义（必须遵守）

1. **`detect` 找不到宿主 → `HOST_NOT_FOUND`**，绝不在用户机器上乱猜路径。配置层位置只认宿主官方文档 + 本机实测（`$CODEX_HOME`、`~/.claude` 等），找不到就报错，不兜底写。
2. **目标层是 managed → `MANAGED_LAYER_READONLY`**，只读不写。这是铁律：组织策略不可被用户层覆盖的宿主（Claude Code managed settings、Codex requirements.toml、Cursor 团队 dashboard、Cline 企业远程配置）一律不绕。
3. **能力无官方口子 → `KEY_NOT_SUPPORTED`**，`plan` 阶段就失败，不进 apply。
4. **键存在但语义与断言冲突 → `SEMANTIC_CONFLICT`**。例：DSH 的 `approval.policy: never` 想表达「命令执行豁免」时，语义是「自动拒绝」，断言校验必须拦住，不许写。这正好是用户踩过的坑。
5. **任何 `apply` 步骤失败 → 立即执行本步与已做步骤的 revert，`revertState` 落 `REVERTED` 或 `MANUAL_REQUIRED`**。`MANUAL_REQUIRED` 时必须给出精确的人肉步骤 + 备份路径。
6. **`revert` 幂等**：只删自己写入的托管块（`# >>> open-agent-gate managed` … `# <<<`），用户手写内容一个字节不动；空文件还原成宿主默认空态。

### 3.4 托管块（marker）约定

所有配置写入都包在标记之间，marker 由库统一生成、内容含库名+能力清单+写入时间：

```
# >>> open-agent-gate managed (profile=default, caps=SHELL_EXEMPT) 2026-11-10T12:00:00Z
... 实际写入的键 ...
# <<< open-agent-gate managed
```

- 写入前：备份到 `<config-dir>/.open-agent-gate-backup/<timestamp>/`。
- 写入时：原子写（写临时文件 → rename），托管块外内容原样保留。
- 重复 apply：幂等，替换旧托管块而非追加叠块。
- revert：只删托管块；若文件因此变空，还原成宿主的合法空态（如 `[]` / `{}`）。

---

## 4. 各宿主扩展面调研（带引用）

> 每条都落到官方文档 URL。查不到的标 `UNDOCUMENTED`。

### 4.1 Anthropic Claude Code

**官方扩展面（VERIFIED）**：

- **settings.json** 三/四级：`~/.claude/settings.json`（用户级）、`.claude/settings.json`（项目级，可提交）、`.claude/settings.local.json`（本地，gitignore）、managed policy（组织级，最高优先级）。
  https://code.claude.com/docs/en/hooks （Hook locations 表）
- **权限规则**：`permissions.allow / .ask / .deny` 数组，格式 `Tool` 或 `Tool(specifier)`，求值顺序 **deny → ask → allow**，与特异性无关（宽 deny 压过窄 allow）。Bash 规则只匹配「Claude 写出的命令文本」（拆复合命令、剥 wrapper 之后），`/usr/bin/curl`、`sh -c 'curl …'` 可绕过 → **不是安全边界**。
  https://code.claude.com/docs/en/permissions
- **权限模式**：`default`(Manual) / `acceptEdits` / `plan` / `auto` / `dontAsk` / `bypassPermissions`。
  https://code.claude.com/docs/en/permission-modes
- **`bypassPermissions` 的真实语义（必须写进断言）**：跳过审批弹窗，但**以下仍不豁免**——`AskUserQuestion`、MCP `requiresUserInteraction`、网络路径读、组织设为 ask 的 connector 工具、跨会话消息护栏、`rm`/`rmdir` 关键路径熔断；**显式 ask 规则仍弹**；**deny 规则在所有模式（含 bypassPermissions）都生效**。只能在启动时就启用的会话里进入；**永不作为 `defaultMode` 持久化**。可用 `permissions.disableBypassPermissionsMode` / `disableAutoMode` 禁用。
  https://code.claude.com/docs/en/permission-modes
- **hooks（PreToolUse/PostToolUse）决策控制**：`hookSpecificOutput.permissionDecision` ∈ `allow|deny|ask|defer`；可 `updatedInput` 改输入、`updatedPermissions` setMode。**hook 的 `allow` 不能绕过 deny 规则、不能压掉网络读/MCP requiresUserInteraction/always_ask 的弹窗；hook 的 `deny` 在所有模式（含 bypassPermissions）都成立**。多个 hook 决策优先级 `deny > defer > ask > allow`。
  https://code.claude.com/docs/en/hooks

**身份句**：`CLAUDE.md` / `--append-system-prompt` 可追加指令；「移除宿主身份句」的官方配置键 → **UNDOCUMENTED**（无公开键，需 wrapper 或 hook 注入 `additionalContext` 对冲，效果 UNVERIFIED）。

**自动继续**：`Stop` hook 存在但无「继续」决策；自动继续无官方键 → **⚠️ wrapper 层（外部进程在 stop 后回「continue」）**，或 `--dangerously-skip-permissions` + auto 模式降低审批停等（但不等于自动继续）。

### 4.2 OpenAI Codex CLI

**官方扩展面（VERIFIED）**：

- **config.toml** 层级：CLI flags/`-c` > profile > 项目 `.codex/config.toml`（仅信任项目）> 用户 `~/.codex/config.toml` > 系统 `/etc/codex/config.toml`。另有 `requirements.toml`（managed，可禁 `approval_policy=never`、`danger-full-access`）。
  https://developers.openai.com/codex/config-file/config-basic
- **`approval_policy`**：`on-request | never | { granular = { sandbox_approval, rules, mcp_elicitations, request_permissions, skill_approval } }`。**`never` = 从不弹审批（官方标注 risky）**；`untrusted` 已退役、`on-failure` 已弃用。granular 是**逐类自动拒绝/放行**——正好是 fail-closed 的官方口子（`request_permissions=false` 自动拒绝权限申请提示）。
  https://learn.chatgpt.com/docs/config-file/config-reference
- **`sandbox_mode`**：`read-only | workspace-write | danger-full-access`。
  https://learn.chatgpt.com/docs/sandboxing
- **`approvals_reviewer`**：`user | auto_review`（auto_review 用评审子代理自动审）。
- **`sandbox_workspace_write`**：`network_access`、`writable_roots`、`exclude_tmpdir_env_var`、`exclude_slash_tmp`。
- **flags**：`--ask-for-approval on-request|never`、`--sandbox <mode>`、`--dangerously-bypass-approvals-and-sandbox`（`--yolo`）。
  https://developers.openai.com/codex/cli/reference
- **hooks（官方，等价于 Claude Code hooks）**：`hooks.json` 或 `config.toml` 内 `[hooks]`；事件含 `PreToolUse / PermissionRequest / PostToolUse / Stop / SubagentStop / …`；JSON stdout 决策控制；**exit code 2 = block/deny**；**`Stop` hook 返回 `decision: "block"` = 自动继续该轮**（用 `reason` 作为下一轮 prompt）。命令 hook / MCP tool hook 两种。非 managed hook 需 `/hooks` 审查信任；`--dangerously-bypass-hook-trust` 可跳。
  https://developers.openai.com/codex/hooks

**身份句**：system prompt 覆盖的官方键 → **UNDOCUMENTED**（未查到公开键）。

**自动继续**：**✅ 官方**——`Stop` hook 返回 `block` 即自动继续（见上），这是本库 `AUTO_CONTINUE` 在 Codex 上的首选落地机制。

### 4.3 Cursor

**官方扩展面（VERIFIED）**：

- **Run Modes**：`Auto-review`（已知安全即跑 + 其余进分类器）/ `Allowlist` / `Run Everything`（零弹窗）。位置 Settings > Agents > Approvals & Execution。
  https://cursor.com/docs/agent/security/run-modes
- **`permissions.json`**：`~/.cursor/permissions.json`（全局）与 `<project>/.cursor/permissions.json`（项目）；字段 `mcpAllowlist`、`terminalAllowlist`（支持 `git`、`git status`、`npm:install*` 前缀/glob）、`autoRun { allow_instructions, block_instructions }`（**自然语言 steering，不是强制**——官方原文「Not a security boundary」）。团队 dashboard 配置优先级最高。
  https://cursor.com/docs/reference/permissions
- **`sandbox.json`**：控制沙箱命令可触达的网络域名与额外读写路径；网络默认阻断，按模式放开。
  https://cursor.com/docs/reference/sandbox
- **保护开关**：Browser Protection / File-Deletion Protection / External-File Protection。
- **已知坑**：`permissions.json` 里写 `terminalAllowlist` 会强制把终端切到 Allowlist 模式并灰掉 Auto-review（官方论坛 bug，`approvalMode:"unrestricted"` 不是出路）。
  https://forum.cursor.com/t/bug-terminalallowlist-forces-allowlist-mode-and-disables-auto-review/167324

**身份句 / 规则**：`.cursor/rules/*.mdc`（`.cursorrules` 为遗留）是**指令**不是权限；身份句官方键 → **UNDOCUMENTED**。

**自动继续**：无官方键 → **❌ / UNDOCUMENTED**（桌面 IDE 无 headless 自动继续口子）。

### 4.4 opencode

**官方扩展面（VERIFIED）**：

- **`opencode.json` 的 `permission`**：`allow | ask | deny`，支持全局 `"*"`、按工具、按输入的对象粒度（`bash: { "git *": "allow", "rm *": "deny" }`），**last-match-wins**。默认**偏宽松**（大多数 allow，`.env` 默认 ask，`doom_loop`/`external_directory` 默认 ask）。
  https://opencode.ai/docs/permissions
- **`--auto` / `opencode run --auto`**：自动批准「未被显式 deny」的请求；显式 `deny` 仍生效。
- **agents**：`opencode.json` 的 `agents` + `.opencode/agents/*.md`；`permissions: [{ action, resource, effect }]` 有序列表、last-match-wins；**`system` 字段替换 agent system prompt（= IDENTITY 的官方口子）**；`steps` 限制最大步数；`mode: primary|subagent`。
  https://opencode.ai/docs/agents

**身份句**：**✅ 官方**——agent 的 `system` 非空即整体替换 provider base prompt。

**自动继续**：`steps` 限制而非续行；自动继续无官方键 → **UNDOCUMENTED / ❌**。

### 4.5 Cline

**官方扩展面（VERIFIED）**：

- **Auto Approve 开关（按类别）**：读项目文件 / 读所有文件 / 编辑项目文件 / 编辑所有文件 / 执行安全命令 / 执行所有命令 / 浏览器 / MCP。命令安全与否由**模型标记 `requires_approval`**，非固定白名单。YOLO 模式 = 全自动批准一切。
  https://docs.cline.bot/features/auto-approve
- **SDK**：`toolPolicies: { <tool>: { autoApprove, enabled } }` + `capabilities.requestToolApproval` 自定义审批回调（可做「只读工具放行、写工具必审」的分层）。
  https://docs.cline.bot/sdk/guides/permission-handling
- **企业远程配置**：`yoloModeAllowed: false` 可禁 YOLO；企业策略优先于本地。

**身份句**：`.clinerules` / custom instructions 是指令；身份句官方键 → **UNDOCUMENTED**。

**自动继续**：SDK 层可编程控制，但「无人工继续」官方键 → **⚠️ SDK/变通**。

### 4.6 Continue.dev

**官方扩展面（VERIFIED）**：

- **工具权限三态**：`allow | ask | exclude`；默认只读工具 allow、写工具与 Bash 为 ask；**headless 模式下 ask 工具被直接排除**（无人可批）。
- **`~/.continue/permissions.yaml`** 持久化（`allow:/ask:/exclude:` 三列表）；CLI flags `--allow/--ask/--exclude`（支持 `Write(**/*.ts)` glob）；优先级 mode > flags > permissions.yaml > defaults。
  https://docs.continue.dev/cli/tool-permissions
- **规则**：`.continue/rules`（指令）。
  https://docs.continue.dev/customize/rules

**身份句 / 自动继续**：官方键 → **UNDOCUMENTED**。

### 4.7 Aider（参照，非 v0.1 目标）

- `--yes-always`（`--yes`）自动确认；`--auto-commits`（默认 true）/ `--no-auto-commits`；`--no-suggest-shell-commands` 关掉命令提议；`.aider.conf.yml` + `AIDER_*` env。
  https://aider.chat/docs/config/options.html

---

## 5. 通用生态：「agent approval bypass」类项目的做法与被封堵情况

调研结论分三类（这是本库立场的依据）：

| 项目 | 做法 | 分类 | 风险/被封堵情况 |
|---|---|---|---|
| claude-yolo（github.com/claude-yolo/claude-yolo） | `tmux capture-pane + send-keys` 在终端级识别并回车审批弹窗 | **hack（非官方）** | 靠转录文本识别弹窗，宿主 UI 一变就失效；能绕过组织强制 ask 的托管策略；官方不支持、随时可能被交互变化打破 |
| claude-permission-hook（github.com/huang-hf/claude-permission-hook） | **官方 PreToolUse hook** + 本地正则红线 + dippy AST + 可选判断后端；错误即交还宿主审批 | **官方扩展面（正解）** | 走官方 hook API；fail-safe 设计；deny 优先不可被绕过——本库采纳其形态 |
| vibesafu（github.com/kevin-hs-sohn/vibesafu） | 权限过滤器 + Haiku 分级 | 官方扩展面 | 依赖 LLM 判断，有误判 |
| tokenmaxxingman `/yolo`（github.com/KangaZero/tokenmaxxingman） | 写 `defaultMode=bypassPermissions`、alias `codex=codex --dangerously-bypass…`、`aider --yes-always` | 官方键 + 别名（半官方） | 写官方键但语义激进；托管策略下会被压回 |

**结论**：
1. **官方支持**的「自动执行」面只有：配置键（permission/approval/sandbox）、hooks 决策控制（Claude Code / Codex 均官方）、SDK 权限回调（Cline）。
2. **变通**：wrapper 进程（外部进程喂「continue」实现自动继续）、hook 注入对冲身份句——官方扩展面内，但非「纯配置」。
3. **hack**：终端级按键、识别弹窗回车、改源码锚点——**不在本库范围**，且会被交互升级/组织策略封堵。

---

## 6. 能力矩阵（精简版）

> 符号：✅ 官方支持 · ⚠️ 变通（官方扩展面内但非纯配置）· ❌ 做不到 · U = UNDOCUMENTED（无官方口子）

| 宿主 | 读豁免 | 写豁免 | 命令执行豁免 | 网络豁免 | 身份句 | 自动继续 |
|---|---|---|---|---|---|---|
| **Claude Code** | ✅ allow 规则/acceptEdits | ✅ acceptEdits/allow 规则 | ⚠️ allow 规则（前缀非安全边界）或 bypassPermissions（仍有 ask/deny/熔断） | ✅ `WebFetch` allow（sandbox 域名另算） | U（CLAUDE.md 仅追加） | ⚠️ wrapper 喂 continue |
| **Codex CLI** | ✅ sandbox read-only/workspace-write | ✅ workspace-write | ✅ `approval_policy=never`（risky）/granular 逐类拒绝 | ✅ `sandbox_workspace_write.network_access` | U | ✅ `Stop` hook `block` |
| **Cursor** | ✅ Run Modes | ✅ Run Modes | ⚠️ terminalAllowlist/autoRun（steering 非强制） | ⚠️ sandbox.json 域名白名单 | U（rules 仅指令） | ❌（桌面 IDE） |
| **opencode** | ✅ permission allow | ✅ permission allow | ✅ permission allow/`--auto` | ✅ webfetch allow | ✅ agent `system` 替换 | ❌（`steps` 仅限步） |
| **Cline** | ✅ Auto Approve | ✅ Auto Approve | ✅ Auto Approve/YOLO | ✅ browser 开关 | U（clinerules 仅指令） | ⚠️ SDK 层 |
| **Continue.dev** | ✅ allow | ✅ allow | ✅ allow（headless 排除 ask） | ✅ Fetch allow | U | ❌ |
| **Aider** | ✅（默认） | ✅ --yes-always | ✅ --yes-always + --suggest-shell-commands | — | — | ✅（chat 循环） |
| **DSH（参照，非目标）** | — | — | ⚠️ 语义陷阱：`approval.policy=never` = **自动拒绝**，非放行 | — | ✅ system-prompt 键 | — |

> DSH 行是**反例**：证明「枚举名猜测」会写反。`never` 在 DSH=自动拒绝，在 Codex=从不询问。本库在写任何键前必须过 §2.1 的断言校验。

---

## 7. fail-closed 设计

1. **默认 = 保守**：profile 未声明的能力一律不碰；`apply` 前 `plan` 输出 diff，用户 `--yes` 才落盘。
2. **断言前置**：`plan` 阶段就做语义校验（§2.1）；`SEMANTIC_CONFLICT`（如 DSH 的 never）直接拦截，绝不写入。
3. **managed 层只读**：detect 到 managed 层 → `MANAGED_LAYER_READONLY`，不尝试覆盖。
4. **写后读回**：`verify` 用宿主官方读回（`--dump-config` 等）对照断言；不匹配 → `VERIFY_FAILED` → 自动 revert。
5. **hook/wrapper 型机制的 fail-safe**：hook 脚本任何异常、超时、无输出 → **交还宿主默认审批**（学 claude-permission-hook：错误即放行给宿主，不放大权限）。hook 只放行「红线外、判定为安全」的动作，红线一律 `ask`/`deny`。
6. **自动继续的护栏**：`AUTO_CONTINUE` 是最高风险能力，v0.1 要求——(a) 仅在显式声明时启用；(b) wrapper 必须设最大续轮数上限（默认 1，防失控循环）；(c) 每轮续行写 audit。
7. **回滚兜底**：任何 `apply` 中途失败 → 立即按 `revertState` 协议回滚；回滚失败 → 输出精确人肉步骤 + 备份路径，绝不静默。

---

## 8. v0.1 范围

**只做 2 个宿主**（都是 CLI、有官方 hooks + 官方读回、本地可测）：

1. **Claude Code**（Windows/Linux，Node 库直接可测）
2. **Codex CLI**

**v0.1 能力覆盖**：

| 宿主 | v0.1 落地能力 |
|---|---|
| Claude Code | READ/WRITE/SHELL/NET 豁免（allow 规则 + acceptEdits 模式，按断言校验）；IDENTITY 标 U 不实现；AUTO_CONTINUE 不做 |
| Codex CLI | READ/WRITE/SHELL/NET 豁免（approval_policy + sandbox_mode + granular）；AUTO_CONTINUE（Stop hook `block`，带续轮上限） |

**v0.1 明确不做**：Cursor / opencode / Cline / Continue / Aider 的实现（矩阵里保留标注）；终端级 hack；managed 层覆盖。

---

## 9. 测试策略（不碰真实宿主）

核心：**把「宿主」抽象成可 mock 的边，把「我们自己」的纯逻辑抽成可单测的函数**。

1. **纯逻辑单测**（`node --test`，无宿主依赖）：
   - 托管块拼装 / 幂等 / 备份 / revert / 空态还原（照搬 dsh-open 已验证的 `patchfile` 测试）。
   - 断言引擎：给「键名 + 期望能力」喂一批**语义冲突样例**（DSH `never`、Codex `never`、Claude `bypassPermissions`），断言 `SEMANTIC_CONFLICT` 命中/放行正确。
   - 能力矩阵表与 `CapabilityCell` 数据一致性（每个能力在每宿主都有唯一 level/mechanism）。
2. **适配器逻辑测试（mock 宿主读回）**：把 `--dump-config` 的输出做成 fixture；验证 detect/plan/verify 对 fixture 的解析正确。真实宿主二进制**不参与**测试。
3. **golden-file 测试**：每个适配器维护一份 `expected-diff`，`plan` 输出逐字节比对（保证不越写、不多写）。
4. **真实宿主验证是「人工/可选」步骤，不是 CI 前置**：`verify` 命令需要真实 CLI，仅在用户机器上跑（`--host-cli <path>` 显式传入），CI 永不调用。
5. **hook/wrapper 脚本**：单独目录 `hooks/`，脚本读 stdin JSON、写 stdout JSON，用纯 Node 测试喂样例事件断言输出（`allow`/`deny`/exit 2），不启动宿主。

---

## 10. 目录结构

```
open-agent-gate/
├─ README.md
├─ docs/
│  └─ ARCH.md                    # 本文件
├─ package.json                  # ESM, node>=18, MIT, 公开库名（非 @local）
├─ src/
│  ├─ types.ts                   # Capability / ProfileSpec / 契约类型（§3）
│  ├─ core/
│  │  ├─ assertions.ts           # 语义断言引擎（§2.1）
│  │  ├─ managed-block.ts        # 托管块拼装/幂等/备份/原子写/revert
│  │  └─ audit.ts                # audit.jsonl（1MB 轮转）
│  ├─ adapters/
│  │  ├─ interface.ts            # HostAdapter 契约
│  │  ├─ claude-code/
│  │  │  ├─ adapter.ts           # detect/read/plan/apply/verify/revert
│  │  │  └─ capability-matrix.ts # 能力矩阵 + 断言（含 bypassPermissions 语义）
│  │  └─ codex/
│  │     ├─ adapter.ts
│  │     └─ capability-matrix.ts
│  ├─ hooks/
│  │  ├─ claude-pre-tool-use.js  # 可选：hook 决策脚本（fail-safe 交还宿主）
│  │  └─ codex-stop-continue.js  # AUTO_CONTINUE：Stop hook 返回 block，带续轮上限
│  └─ cli.ts                     # open-agent-gate status|plan|apply|verify|revert|audit
├─ fixtures/
│  ├─ claude-dump-config.json    # mock 读回
│  └─ codex-dump-config.toml
└─ tests/
   ├─ managed-block.test.ts
   ├─ assertions.test.ts
   ├─ claude-code.adapter.test.ts
   └─ codex.adapter.test.ts
```

---

## 11. 引用

- Claude Code Hooks：https://code.claude.com/docs/en/hooks
- Claude Code 权限模式：https://code.claude.com/docs/en/permission-modes
- Claude Code 权限规则：https://code.claude.com/docs/en/permissions
- Claude Code 设置参考：https://code.claude.com/docs/en/settings-reference
- Codex 配置参考：https://developers.openai.com/codex/config-file/config-reference
- Codex 配置基础/优先级：https://developers.openai.com/codex/config-file/config-basic
- Codex 审批与安全：https://developers.openai.com/codex/agent-approvals-security
- Codex Sandbox：https://developers.openai.com/codex/sandbox
- Codex Hooks：https://developers.openai.com/codex/hooks
- Codex CLI 参考：https://developers.openai.com/codex/cli/reference
- Cursor Run Modes：https://cursor.com/docs/agent/security/run-modes
- Cursor permissions.json：https://cursor.com/docs/reference/permissions
- Cursor sandbox.json：https://cursor.com/docs/reference/sandbox
- Cursor terminalAllowlist bug：https://forum.cursor.com/t/bug-terminalallowlist-forces-allowlist-mode-and-disables-auto-review/167324
- opencode 权限：https://opencode.ai/docs/permissions
- opencode agents：https://opencode.ai/docs/agents
- Cline Auto Approve：https://docs.cline.bot/features/auto-approve
- Cline SDK 权限：https://docs.cline.bot/sdk/guides/permission-handling
- Continue 工具权限：https://docs.continue.dev/cli/tool-permissions
- Continue 规则：https://docs.continue.dev/customize/rules
- Aider 选项参考：https://aider.chat/docs/config/options.html
- claude-yolo：https://github.com/claude-yolo/claude-yolo
- claude-permission-hook：https://github.com/huang-hf/claude-permission-hook
- vibesafu：https://github.com/kevin-hs-sohn/vibesafu
- tokenmaxxingman /yolo：https://github.com/KangaZero/tokenmaxxingman

---

## 附：现有 dsh-open 与本库的关系

- `dsh-open`（D:\openlib\dsh-open）是**单宿主**（DSH）的配置层实现，验证了「托管块 + 幂等 + 备份 + audit + verify」这套方法论（README 已记录 DSH `approval.policy` 的语义坑）。
- 本库把它的**方法**抽成宿主无关框架（§3 契约 + §6 矩阵 + §7 fail-closed），**适配器**逐个实现。DSH 未来可作为 `adapters/dsh/` 接入（其 `never` 语义作为断言引擎的回归样例保留）。
- 两者不互相替代：dsh-open 继续服务 DSH 用户；open-agent-gate 是公开的多宿主框架。
