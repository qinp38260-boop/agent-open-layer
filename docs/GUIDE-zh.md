# agent-open-layer 使用说明书（中文详解）

> 面向使用者，不是 API 文档。每条结论后面都写着"凭什么这么说"（实测 / 配置 / 未验证）。
> 最后更新：2026-11-11，本机 Windows 11 + Codex CLI 0.167.0 + DeepSeek Harness 0.1.0-rc.7。

---

## 一、这玩意儿到底解决什么问题

一句话：**让 AI 干活时"放开手脚"，但放开的范围是你写下来的，而且它干的每件事都留痕、都能回退。**

打个比方，三种做法：

| 做法 | 类比 | 问题 |
|---|---|---|
| 每次操作都问人 | 每拿一件工具都请示领导 | 人累死，等于没自动化 |
| 全放开（各种"破甲/解锁"补丁） | 把仓库钥匙给临时工 | 出事才知道，且改的是宿主源码，升级就崩 |
| **本方案** | 给临时工一间带门禁的独立工位 + 监控 + 出门安检 | 他能在工位里随便干，出了工位什么都不行，干完的东西你验货才入库 |

最后一条是本项目的定位：**审批点从"每一次工具调用"挪到"产物晋升"**。
Agent 在隔离环境里自由干活，人只审它最终交出来的 diff。

## 二、它不是什么（先说清楚，避免误解）

- **不是"越狱/破甲"工具**。它不解除宿主限制，而是把限制写清楚、执行得更确定。
- **不保证能挡住有恶意意图的 agent**——除非你把 L0（换安全主体）做了。同账号下它只是"防手滑 + 留痕"。
  实测证据：同账号时让它删 `hooks.json` 里的闸门**它真删掉了**，还顺手把 ACL 恢复原样。
- **不改宿主源码**。零处源码补丁：只写宿主自己的配置层 / hook / 插件 API。
  对比某个社区补丁项目：它打 86 处源码补丁，宿主一升级就要重新对锚点（实测在 0.1.0-rc.7 上漂移 14 条 / 78 个锚点）。
- **不内置别人的技能包/资产**。

## 三、现在做到什么程度（证据等级）

四个等级的定义：

- `probe-verified`：真跑过，看到了宿主信号或真实副作用
- `config-only`：只写了配置，没有行为验证
- `unverified`：没测
- `missing`：缺件

| 层 | 做什么 | 状态 | 凭什么 |
|---|---|---|---|
| **L0 主体隔离** | 换一个 Windows 账号跑 agent，用 NTFS ACL 划边界 | ✅ 实测 14 项 | 以 `agent_runner` 身份：能写 `D:/agent-work`；读 `.env`、写用户目录、列 `.ssh`、写 `C:\Windows` 全被拒 |
| **L0 闸门抗篡改** | agent 改不掉/删不掉自己的闸门 | ✅ 实测 | 改 `hooks.json`、改闸门脚本、**删**闸门脚本、改 `policy.json` —— 4 项全 BLOCKED |
| **L0 闸门可运行** | 闸门在那个账号下必须**读得到、跑得起来** | ✅ 实测 | `node oag-guard.mjs` 以 `agent_runner` 执行，空事件输出 `{"decision":"block"}`，退出码 0 |
| **L1 写范围** | 只允许在工作目录写 | ✅ 实测（8 动作矩阵） | 工作区外写、第二个目录写、删除、装包、git 提交全被拦 |
| **L2 网络** | 沙箱断网 + 动作层兜底 | ✅ 实测 | 受限档：本机蜜标服务**收到 0 个请求**（服务端视角，不是 agent 自称）；放开档对照蜜标命中且拿到 `example.com` 真实标题；闸门对 `curl` 事件实测返回 block |
| **L3 凭据** | 不让 agent 环境里有钥匙 + 硬拦凭据采集 | ✅ 实测 | agent 自测 `KEYLEN=0`（拿不到 key）而模型照常能调；`git credential fill` / `.ssh` / DPAPI 一律 deny |
| **L4 宿主策略 + 闸门** | fail-closed、canary、看门狗 | ✅ 实测 | 宿主对 hook 异常是 fail-open（6/6 场景全放行），所以闸门必须自己坏了自己拒 |
| **L5 域外监督** | 跑前记基线、跑后比对，变了标 tainted | ✅ 实测 | 运行中改 `package.json` → tainted，退出码 11 |
| **L6 产物晋升** | 跑前 git 快照，人审 diff 才合并 | ✅ 实测 | 真仓库演练：快照可 `git bundle verify`，`git checkout -- .` 能干净回退 |

跑一次自己看：

```bash
node bin/oag.js layers --policy open/policy.dev.json --codex-home D:/agent-work/.codex
```

它会输出每层的等级，并给出**最弱一环**——这是本项目最重要的汇报纪律：一张全绿的表等于骗人。

## 四、三种典型用法

### 用法 A：让宿主帮我审代码（最安全，收益最快）

```bash
node bin/oag.js guard install --codex-home D:/agent-work/.codex --policy open/policy.review.json
node bin/oag.js guard canary --codex-home D:/agent-work/.codex --live
```

然后走 `codex exec --json ... "只读审查这几个文件，输出 file:line — bug — impact，最多 5 条"`。
审完看 `oag audit`。

### 用法 B：让 agent 干活（开 dev 档 + 闸门）

```bash
node bin/oag.js guard install --codex-home D:/agent-work/.codex --policy open/policy.dev.json
node bin/oag.js run --cwd D:/agent-work/repo --codex-home D:/agent-work/.codex \
    --policy D:/agent-work/.codex/policy.json --snapshot D:/agent-work/repo --fail-on-taint -- <命令>
```

退出码 `0` 干净、`10` canary 没过没开跑、`11` 有文件被动过（tainted）。

### 用法 C：只要审计，不要拦

`policy.review.json` 里把决策改成 `allow` 但保留审计即可；闸门照样记 `policy.hash`，
事后能查"这次跑的是哪份策略"。

## 五、核心概念（三句话）

1. **动作 × 决策 × 作用域**：不是"开/关"，而是"什么动作、允许/询问/拒绝、在哪个范围内"。
   优先级 `deny > ask > allow`。
2. **按意图归一，不按写法堵**：只堵 `Remove-Item` 没用，它会改用 `del` / `rm` / `apply_patch *** Delete File:`。
   所以先把每次工具调用归一成 `{动作, 目标}` 再判定；测试写成等价断言（同一意图的每种写法必须同一决策）。
3. **主体决定安全属性**：同一份闸门代码，同账号下是"警示牌"，两个账号下才是"门"。

## 六、L0 详解：为什么必须换主体，怎么落地

### 6.1 为什么

实测：同账号时 agent 能改自己的闸门——它先"保存 ACL → 临时移除 Deny → 改文件 → 恢复 Deny"，
审计里甚至看不出异常。因为文件属于该账号，账号就拥有 `WRITE_DAC`。

换主体后：文件所有者是你，agent 只有"读+执行"，**拿不到 `WRITE_DAC` → 改不了、也删不掉**。

### 6.2 建账号（只需一次，要管理员）

```powershell
net user agent_runner * /add      \ 交互输两次密码
mkdir D:/agent-work
icacls D:/agent-work /grant "agent_runner:(OI)(CI)M"
icacls "D:\Programs\hermes_data\.env" /deny "agent_runner:(F)"
```

**注意：建账号要管理员，但改 ACL 不要**——目录所有者本身就有授权权限。
所以"需要提权"不是不做隔离的理由，助手能把除"输一次密码"以外的活全干完。

### 6.3 ACL 怎么写（有个坑，务必看）

**不要**用 `icacls /deny ...:(W)`。`(W)` 这个宏 = `FILE_GENERIC_WRITE`，里面含 **`SYNCHRONIZE`**，
而"打开文件"本身就需要 `SYNCHRONIZE` → deny 它等于 deny 打开，**连读都废了**。

后果比"读不到"严重：**闸门脚本也是用这个账号跑的**，它读不到 `policy.json` 就会失败 →
宿主对 hook 异常 fail-open → **保护静默消失，而表面看还"拦住了"**（这条我们真踩过）。

正解（切断继承 + 只授读执行）：

```cmd
icacls "D:/agent-work\.codex\hooks.json" /inheritance:r ^
  /grant "p1553:(F)" /grant "SYSTEM:(F)" /grant "Administrators:(F)" /grant "agent_runner:(RX)"
```

要对这四个文件都做：`hooks.json`、`oag-guard.mjs`、`policy.json`、`config.toml`。

### 6.4 验收（必须"从外面判"，不听它自述）

写一个 PS 脚本，**以 agent_runner 身份**跑，把结果写到 `D:\acceptance-result.txt`，然后你从外面读这个文件。
必须同时验三类：

| 类别 | 项目 | 期望 |
|---|---|---|
| 能干活 | 写工作目录 | ALLOWED |
| 隔离住 | 读 `.env` / 写用户目录 / 列 `.ssh` / 写 `C:\Windows` | BLOCKED |
| 改不了 | 改 hooks.json / 改闸门脚本 / 删闸门脚本 / 改 policy.json | BLOCKED |
| **能跑起来** | 读 hooks.json、读 policy.json、执行闸门脚本（空事件） | ALLOWED，且输出含 block |
| 工具链 | `node --version`、codex.exe 可读 | ALLOWED |

第四类最容易被漏：文件在、改不动、但**闸门根本起不来**，等于没有。

**脚本本身要注意**：PowerShell 5.1 把 UTF-8 无 BOM 当 ANSI/GBK 读，中文标签会打断语法，
窗口一闪就关，看起来像"权限拦住了"。所以验收脚本一律 **纯 ASCII + UTF-8 BOM**，
外面再套一层 `cmd` 把输出重定向到日志（窗口关了也能查）。

### 6.5 停用与恢复

```powershell
net user agent_runner /active:no    \ 停用（要管理员；非管理员报"系统错误 5"）
net user agent_runner /active:yes   \ 恢复（ACL、闸门、证据都还在，不用重配）
```

停用后 `oag layers` 会**自动回落**成：

```
[L0 主体隔离] config-only
   账号 agent_runner 已停用 → 隔离当前不生效（历史证据与 ACL 保留，启用即恢复）
```

**状态是要判定的，不是靠记忆的**：证据是历史，账号存活是当下，两个都查才算数。

## 六点五、L2 网络：怎么证明它真的断网了

**先记住一个原则：不听 agent 说自己被拦了。** 它完全可能编造"blocked by policy"。
所以判据全部从**外面**取证：

1. 起一个本机蜜标服务：`http://127.0.0.1:17891/<随机token>` —— 它收到几个请求，是客观事实
2. 让 agent 去访问蜜标 + `https://example.com`，要求它原样打印返回内容
3. **阴性对照**：同一探针在"放开档"（`--dangerously-bypass-approvals-and-sandbox`）必须
   蜜标命中 **且** 拿到 `example.com` 的真实标题 —— 否则说明探针本身是瞎的，受限档结论一律不算
4. 受限档（`network_access=false`）必须：蜜标**服务端 0 请求** + 拿不到外网真实内容

实测结果（本机）：

| 档位 | 蜜标服务端 | agent 拿到的内容 |
|---|---|---|
| 放开（对照） | **命中 1 次** | 蜜标正文 + `Example Domain` 标题 |
| 受限 `network_access=false` | **0 次** | 无（它自己说 "blocked by policy: network access restricted"） |

关键在**第一列**：请求根本没到服务器，说明是系统层面断的，不是模型嘴上说说。

跑法：

```bash
node scripts/net-probe.mjs --base D:/temp/net-bypass --bypass   # 先跑对照
node scripts/net-probe.mjs --base D:/temp/net-restrict          # 再跑受限档
node bin/oag.js layers --policy open/policy.dev.json --codex-home D:/agent-work/.codex
```

兜底一层：宿主沙箱被绕过（`--bypass`）时，闸门在**动作层**拦 `curl/wget/Invoke-WebRequest`
（`probeGuardNet()` 真跑一次闸门喂 curl 事件，看它返回不返回 block，而不是读代码猜）。

**本机的现实**（这条路走不通的部分，照实说）：WSL 服务被禁用（`0x80070422`）、Docker 未安装、
当前账号非管理员 → **加不了防火墙规则**。Windows 防火墙也不支持"按用户"过滤出口，
真正的按主体断网需要 WFP 过滤器（要驱动 + 管理员）。所以本机 L2 只能做到
"宿主沙箱断网 + 闸门兜底"这两层。

## 七、闸门（PreToolUse）五条铁律

1. **fail-closed**：宿主对 hook 崩溃/超时/坏 JSON 一律放行（实测 6/6），所以闸门必须自己坏了自己拒。
2. **看门狗 + 输入上限**：慢的闸门等于没有闸门（超时=放行）。
3. **审计写在可写域之外**：放在 agent 能改的地方，那不叫审计。
4. **拒绝文案不写允许范围**：对误操作是提示，对目标驱动的 agent 就是绕行路线图。
5. **每次运行前先 canary**：版本升级、trust 缺失，都表现为**静默失效**。

装完必须验的两个动作：

```bash
node bin/oag.js guard canary --codex-home D:/agent-work/.codex        # 快测：破坏性被拦、普通放行
node bin/oag.js guard canary --codex-home D:/agent-work/.codex --live # 真让宿主去删一个必须存活的文件
```

## 八、L6 产物晋升：跑完由 diff 决定去留

```
跑前快照 → 跑 → 跑后比对 → 人审 diff → 合并 或 回退
```

真机演练抓到的东西（这就是它的价值）：

```diff
- {}
+ {"scripts":{"postinstall":"echo pwned"}}
```

`postinstall` 是典型持久化：写入时看不出来，你下次 `npm install` 才发作。
**闸门拦不了意图，但 diff 骗不了人。**

局限（照实写）：只覆盖已存在的持久化点；非 git 目录只能比哈希、不能回退；
间接执行（`npm run`、Makefile、`conftest.py`）覆盖不到。

## 九、命令速查

| 命令 | 用途 |
|---|---|
| `oag status` | 宿主版本、适配器就绪情况 |
| `oag plan --adapter codex` | 只显示要改什么（dry run） |
| `oag apply --adapter codex` | 写入受管区块（先备份） |
| `oag probe --adapter codex` | 行为探针：宿主到底认不认（真写一个 canary 看副作用） |
| `oag verify --adapter codex` | 校验当前状态与策略一致 |
| `oag recover --adapter codex` | 从事务日志回滚 |
| `oag audit --policy <p>` | 按策略指纹读审计 |
| `oag doctor` | 环境/宿主自检 |
| `oag guard status\|install\|remove\|canary\|audit` | 动作闸门 |
| `oag run ... -- <cmd>` | 外部监督（基线→跑→taint） |
| `oag sandbox plan` | 本机能做哪种隔离（账号/WSL/容器） |
| `oag layers` | 每层证据等级 + 最弱一环 |

退出码：`0` 成功 · `1` 验证失败 · `2` 验证无法进行 · `3` 宿主能力缺失 · `4` 竞态 · `5` IO ·
`6` 标记损坏 · `7` 回滚失败 · `10` canary 未过 · `11` tainted。

## 十、踩过的坑（每条都是实测）

| 现象 | 根因 | 正解 |
|---|---|---|
| Windows 上 `workspace-write` 写不进工作区 | 该模式下退化为只读 | 别指望它当边界；用闸门 + L0 |
| `danger-full-access` 能写工作区外 | 无原生 OS 边界 | 同上 |
| 无头模式 `never` / `on-request` 都拒一切 | 没人可问 | 要选择性放开只能做在动作层（闸门） |
| hook 装了不触发 | `matcher:"*"` 匹配不到，且需要 trust | 用 `matcher:""` + `--dangerously-bypass-hook-trust` |
| 闸门崩了但没拦住 | 宿主 fail-open | 闸门自己 fail-closed + canary |
| 改 ACL 后闸门起不来 | `DENY(W)` 含 `SYNCHRONIZE`，连读都禁 | `/inheritance:r` + `(RX)` |
| 验收脚本"起不来" | PS 5.1 按 ANSI 读无 BOM 的 UTF-8 | ASCII + BOM + 日志重定向 |
| 测试突然假红 | 测试依赖了本机账号状态 | 状态注入（`accountState`），测试不碰真实机器 |
| 说"拦住了"其实没跑 | 启动失败被当成策略拒绝 | 分开判定：`ENOENT`/usage 错误 ≠ 被拦 |

## 十一、证据在哪看

- `docs/evidence/l0-acceptance-*.txt` —— 沙箱账号跑出来的原始验收输出
- `docs/SECURITY-BOUNDARY.md` —— 每条边界是怎么测的，**包括失败的那些**
- `docs/PROBES.md` —— 探针矩阵
- `docs/ACCEPTANCE.md` —— 验收标准（阴性对照先行、重复次数、rule of three）
- `docs/L6-WORKFLOW.md` —— 晋升流程与真机记录

## 十二、还没做的（诚实清单）

1. **L2 网络**：目前只是策略声明，没有独立的出口控制。
2. **Claude Code 适配器**：只有包内字符串取证（本机没装 Claude CLI），标 `config-only`，
   真要用先自己 probe 一次。
3. **WSL / 容器沙箱**：脚手架在 `sandbox/`，未在真机跑通（本机 WSL 服务被禁用）。
4. **L6 自动化**：现在快照与 taint 是自动的，"审 diff 后合并"仍是人工。
5. **Windows 上无原生 OS 边界**：这是宿主限制，不是本项目能补的。

## 十三、名词解释

- **宿主（host）**：跑 agent 的那个 CLI/客户端，如 Codex CLI、Claude Code、DSH。
- **闸门（guard）**：挂在宿主 `PreToolUse` 上的脚本，每个工具调用前判一次，可以拦。
- **canary**：故意做一件"必须被拦"的事，用来证明闸门还活着。
- **taint**：跑完之后发现被监控文件变了，标记为"可能被改过"。
- **主体（principal）**：操作系统层面的"谁"，这里是你的账号 vs 沙箱账号。
- **证据等级**：`probe-verified / config-only / unverified / missing`，见第三节。
