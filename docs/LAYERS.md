# 设计层级（L0–L4）与完成状态

> 这份文件回答一个问题：**"你要的每一层，做到哪了？"**
> 状态只有三种：✅ 已实现且有实测 / ⚠️ 已实现但证据等级低 / ❌ 未做。

## 总览

| 层 | 目的 | 状态 | 挡"误操作" | 挡"主动拆解" |
|---|---|---|---|---|
| **L0 主体隔离** | 换安全主体，agent 改不到自己以外的东西 | ⚠️ 脚手架就绪，**待你提权执行** | ✅ | ✅ |
| **L1 文件系统** | 写/读限定在允许目录 | ✅ 已实现（策略 + 闸门 + writable_roots） | ✅ | ❌ |
| **L2 网络** | 默认断网，只走白名单 | ✅ 已实现（network_access=false, NET=deny/ask） | ✅ | ❌ |
| **L3 凭据** | agent 的环境里没有钥匙 | ✅ 已实现并实测（`KEYLEN=0`） | ✅ | ✅（对"读环境变量"这一路） |
| **L4 宿主策略 + DSL + 闸门** | 统一策略入口 + 即时拦截 + 审计 | ✅ 已实现（Codex 实测 / Claude 包内取证） | ✅ | ❌ |

## L0 主体隔离

**已交付**
- `oag sandbox plan`：探测本机（Windows 版本、WSL 状态、Docker、Hyper-V），给出可用路径 + 精确命令 + 每条"挡不挡主动拆解"
- `sandbox/devcontainer.json`：容器方案（`--cap-drop=ALL --security-opt=no-new-privileges`，不挂宿主 home）
- `sandbox/wsl-sandbox.ps1`：WSL2 一次性发行版（up/exec/down/status）
- `sandbox/agent.wsb`：Windows Sandbox（只读挂载工作副本；需 Pro/Enterprise）

**本机实测结论**（`oag sandbox plan`）

| 方案 | 本机可用性 | 原因 |
|---|---|---|
| Windows Sandbox | ⛔ | `EditionID=CoreCountrySpecific`（Home 版无此功能） |
| WSL2 | ⛔（可启用） | 已装 2.4.12，但 `wsl --status` 返回 `0x80070422`（服务被禁用） |
| Docker/devcontainer | ⛔ | 未安装 Docker |
| 独立 Windows 账号 + ACL | ✅ 可行 | **需要管理员权限创建账号** |

**未完成的原因**：需要管理员权限（建账号 / 启服务）。这是唯一一件我做不了的事。

## L1 文件系统

- 策略里 `READ` / `WRITE` 带 `scope.paths`，编译到宿主的 `writable_roots`
- 闸门按"意图 × 绝对路径"判定：越界写 / 越界读（含 `.env`、`.ssh`）一律 deny
- 已知缺口：**symlink/junction、8.3 短名、NTFS ADS、`\\?\` 前缀** 这些 Windows 路径归一化变体尚未覆盖（Claude 指出，已验证是真实缺口，未修）

## L2 网络

- `sandbox_workspace_write.network_access=false`（已实测被宿主接受）
- `NET=deny` 时，`curl`/`wget`/`Invoke-WebRequest`/`git clone` 等在闸门层直接 deny
- 已知缺口：DNS 隧道、白名单域名本身可外传、直连 IP 绕代理 —— 都需要 L0 的出口网关才能解决

## L3 凭据（收益最大的一层）

实测：下发
```toml
shell_environment_policy.inherit = "core"
shell_environment_policy.exclude = ["*KEY*","*TOKEN*","*SECRET*","*PASSWORD*","*CREDENTIAL*","*SESSION*","AWS_*","GITHUB_*","GH_*","DEEPSEEK_*","OPENAI_*","ANTHROPIC_*","GLM_*"]
```
之后 agent 自己执行 `Write-Output ('KEYLEN=' + $env:DEEPSEEK_API_KEY.Length)` → **`KEYLEN=0`**，而模型调用正常（`env_key` 读宿主进程环境，不是工具环境）。

- 另外硬拦 `cred_read` 意图：`git credential fill`、`cmdkey`、`.ssh/id_rsa`、`.aws/credentials`、DPAPI
- 已知缺口：`~/.codex/sessions` 之类宿主自己的会话明文里可能含敏感内容，未处理

## L4 宿主策略 + DSL + 闸门

**已实现**
- 策略 DSL：`动作 × 决策 × 作用域`，`deny > ask > allow`，编不出来的明确 `unsupported`
- 编译到：Codex（approval/sandbox/network/writable_roots/shell_environment_policy）、Claude Code（permissions.{allow,deny,ask}）、DSH（identity 托管块，其余标 unsupported）
- 闸门：**同一套意图判定装到两个宿主**
  - Codex：`oag guard install --adapter codex`（✅ 真机实测）
  - Claude Code：`oag guard install --adapter claude-code`（⚠️ 包内取证，本机无 CLI）
- 意图归一：`read/write/delete/destroy/exec/net/install/git_write/spawn_host/cred_read` 共 10 种
- 逃逸硬拦：`spawn_host`（嵌套启动宿主）、`cred_read`（凭据采集）不受策略 allow 影响
- fail-closed：宿主对 hook 异常是 **fail-open（6 场景实测）**，所以闸门自身坏 JSON / 策略缺失 → 一律 block
- canary：`oag guard canary [--live]`，实测能让"闸门被改坏"暴露出来
- 审计：每次判定写 jsonl（含 op/decision/targets/repeat/persistence/policy 路径）

**已知缺口**
- 写后执行洗白（先写脚本再执行）只记录不拦
- 配置即代码（`.git/hooks`、`package.json` 脚本、`.vscode/tasks.json`）只标 `persistence:true`
- 闸门自身在 agent 可写域内时可被拆（实测），`oag guard audit` 会报 critical
- DSH 无 PreToolUse hook，闸门覆盖不到

## 与 dsh-purge 的层面对比

| 层 | dsh-purge（86 条源码补丁） | 本项目 |
|---|---|---|
| L0 | 无（与 agent 同主体） | 脚手架就绪，待提权执行 |
| L1 | 改源码把 fs 围栏摘掉（更松） | 策略 + 闸门（更紧） |
| L2 | 联网不受限 | 默认断网 |
| L3 | 不处理（agent 能看到宿主环境） | 环境变量清洗（实测 KEYLEN=0） |
| L4 | 内容锚点补丁（升级即漂移） | 官方配置 + hook（升级不返工，能力缺失明说） |

## 下一步（按收益排序）

1. **你提权做 L0**：建独立账号 或 启用 WSL —— 这是唯一能挡"主动拆解"的一层
2. Windows 路径归一化补全（junction / 8.3 / ADS / `\\?\`）
3. 写后执行洗白的检测（先标记后再决定是否拦）
4. 验收套件落地：阴性对照 + 20 次重复 + 蜜标 + 域外观测
