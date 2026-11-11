# 验收结果（2026-11-11）

三件事：**20 次重复验收**、**DSH 适配宿主级实测**、**Claude Code 适配（未安装 → 仅配置级）**、**L0 主体隔离（需你提权）**。

---

## 一、20 次重复验收

判据只看金丝雀文件是否被创建 + 宿主是否报 blocked，**不看 agent 自述**。
可复现：`node scripts/repeat-acceptance.mjs --n 20 --case block`

### 必须被拦住的动作（写根外）

| 项 | 结果 |
|---|---|
| 通过率 | **20/20** |
| 金丝雀 | 20 次全部 absent |
| 宿主 block 信息 | 20 次全部出现 |
| 耗时 | 中位 **15.8s**，最快 13.9s，最慢 23s |

证据：`docs/evidence/repeat-acceptance-block.json`

### 必须放行的动作（写根内）

| 项 | 结果 |
|---|---|
| 通过率 | **20/20**（金丝雀 20 次全部被创建 = 没有误拦） |
| 耗时 | 中位 **14.3s** |

证据：`docs/evidence/repeat-acceptance-allow.json`

**这一组是必要的反向对照**：只测"拦得住"不测"不误拦"，闸门退化成"全部拒绝"也会拿满分。

---

## 二、DSH 适配：宿主级实测通过

| 步骤 | 结果 |
|---|---|
| 生成补丁 | `oag apply --adapter dsh` 写入 `~/.dsh/profiles/web/cordis.patch.yml` 托管块 |
| **宿主读回** | `dsh --profile web --dump-config` 输出里出现 `includeHarnessIdentity: false` / `persona: ''` ✅ |
| **无头真跑** | `dsh --profile headless "reply with exactly PONG"` → **PONG** ✅（加了补丁后宿主照常工作） |
| `oag verify` | 带 `--cli` 时 **通过（host-cli）** ✅ |
| 还原 | `oag revert` 后与原文件 **字节一致**（diff 无差异），宿主 dump-config 0 报错 |

### 实测发现的一个坑

`oag verify --adapter dsh` 不带 `--cli` 时报 `spawnSync dsh ENOENT` —— 因为 DSH 装在
`D:\Programs\hermes_data\node\dsh.cmd`，不在 PATH 里。**必须带 `--cli` 才能做宿主级校验**，
否则会误显示"未验证"。（建议后续让 verify 自动在 dsh home 附近找 CLI。）

---

## 三、Claude Code 适配：**未安装宿主，只能到配置级**

本机**没有** Claude Code CLI（无 `~/.claude`，无 `@anthropic-ai` 包），所以做不到宿主级实测。
能做的：用临时 home 生成并校验配置。

生成结果（`policy.dev.json`）：

```json
{ "permissions": {
  "allow": ["Read","Glob","Grep","Write","Edit","NotebookEdit"],
  "deny":  ["Bash","WebFetch","WebSearch"]
} }
```

JSON 合法、`oag verify` 通过（file-readback）。

### 这里有个必须讲清的局限

**Bash 落进了 deny**，尽管策略里 `EXEC_SAFE=allow`。原因：Claude Code 的权限规则只能按
**工具名**粒度给（`Bash` 一个名字覆盖安全命令和危险命令），我方按 deny>ask>allow 取最严，
于是把 Bash 整体拒了。这是"宁可误拦"的选择，**不是 bug，但也意味着 Claude Code 上跑不了任何
shell 命令**。要真正区分，只能写 `Bash(git *)` 这种模式规则 —— 尚未实现。

---

## 四、L0 主体隔离：**卡在权限，需要你执行一条命令**

实测状态：

```
net user agent_runner        → 账户启用: No（已停用）
whoami /groups | 管理员组     → 0 条（当前会话非管理员）
```

**当前会话建不了也启用不了账号**。需要你在**管理员 PowerShell**里跑一条：

```powershell
net user agent_runner /active:yes
```

启用后我就能跑完整的 14 项验收 + 4 项抗篡改，把 L0 从 `config-only` 变成 `probe-verified`。
（不想开就把这句忽略，L0 保持"未生效"，文档已如实标注当前态。）

---

## 五、当前整体状态

| 层 | 状态 |
|---|---|
| L0 主体隔离 | 🟡 config-only（账号停用，需提权启用） |
| L1 写目录白名单 | 🟡 config-only（靠 ACL 执行，随 L0） |
| L2 网络出口 | ✅ probe-verified（蜜标服务端 0 请求 + 阴性对照） |
| L4 闸门 | ✅ probe-verified（4 类路径逃逸已修；宿主 fail-open 已用外壳补上；20/20 重复拦得住） |
| DSH 适配 | ✅ probe-verified（宿主读回 + 无头真跑 + 还原字节一致） |
| Claude Code 适配 | 🟡 config-only（宿主未安装，且 Bash 粒度限制已记录） |
