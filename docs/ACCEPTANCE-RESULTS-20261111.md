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

## 四、L0 主体隔离：账号已启用，但**审计发现隔离并不成立**

### 4.1 已确认有效的部分

| 项 | 证据 |
|---|---|
| 账号 | `net user agent_runner` → 账户启用 **Yes**（用户已提权启用） |
| 密钥 | `.env` 上 `agent_runner:(N)` → 读不到 |
| 闸门文件 | `oag-guard.mjs` / `policy.json` 上 `agent_runner:(RX)` → 文件级不可写 |
| 用户目录 | `C:\Users\p1553` 上无 agent_runner 的 ACE |

### 4.2 发现的真问题（此前 14 项验收没覆盖）

`D:\` 根 ACL 含 **`Authenticated Users:(OI)(CI)(M)`** —— agent_runner 是已认证用户，
继承该权限后**对整个 D 盘可写**（`D:\temp`、`D:\openlib` 等）。

此前的验收清单只测了 `C:\` 下的目标（用户目录 / 系统目录 / `.env`），
所以一路“BLOCKED”，看不出这个洞。

**准确结论：L0 目前 = “挡住 C:\ 敏感区”，≠ “只能写工作目录”。**

还有一个未验证点：`.codex` 文件虽是 `agent_runner:(RX)`，但父目录给了它 `(M)`，
Windows 上“能否删除子文件”取决于父目录的 DELETE_CHILD，**需以该账号实跑确认**（缺口令）。

### 4.3 修复方案：**原方案已否决（会伤到主人账号）**

第一版方案是「D 盘根 Authenticated Users 从 (M) 降为 (RX)」。实测后**撤回**：

```
D:\Programs\hermes_data / D:\openlib / D:\wechat-scanner / D:\temp
  → 全部只有 Authenticated Users:(I)(M)，没有任何 p1553 的显式 ACE
```

也就是说，**主人自己的 D 盘写权限也来自同一条继承 ACE**。降级后第一个被拦住的是主人，
不是 agent。这是"装锁把自家门焊死"。

更根本的限制：显式 deny 会继承到子目录且无法被子目录的 allow 覆盖，
所以"给一个标准用户划一小块地盘、其余锁死"在**共享权限的单盘**上靠 ACL 做不到。

**修正后的可选方案**（仅在确实需要时执行，需管理员，含备份与回滚）：
先给 p1553 补显式 (M) → 再把根上 Authenticated Users 降 (RX) → 工作目录破继承。
清单与回滚见桌面 `L0隔离说明_含可选方案.txt`。

**默认建议：不动 D 盘权限。** 单用户机器上，这种改动的破坏面大于收益。
日常降风险用零副作用的一条：`net user agent_runner /active:no`（用时再开）。

### 4.4 行为验收（14 项）未做

必须以 agent_runner 身份实跑 `D:\agent-work\_run.cmd`（脚本内 9 处过期路径已改好）。
缺口令 → **未做**，因此 L0 仍标 `config-only`，不升级。

## 五、当前整体状态

| 层 | 状态 |
|---|---|
| L0 主体隔离 | 🟡 config-only（账号停用，需提权启用） |
| L1 写目录白名单 | 🟡 config-only（靠 ACL 执行，随 L0） |
| L2 网络出口 | ✅ probe-verified（蜜标服务端 0 请求 + 阴性对照） |
| L4 闸门 | ✅ probe-verified（4 类路径逃逸已修；宿主 fail-open 已用外壳补上；20/20 重复拦得住） |
| DSH 适配 | ✅ probe-verified（宿主读回 + 无头真跑 + 还原字节一致） |
| Claude Code 适配 | 🟡 config-only（宿主未安装，且 Bash 粒度限制已记录） |
