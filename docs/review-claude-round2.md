# Claude 第二轮评审（对我的 guard v2 修改）

- 2026-11-11
- 内容：对我按它上轮意见做的四处修改的复审 + Claude Code hook schema + Windows 路径变体优先级 + 最该做的一件事
- 原文照录，未改写

---

评估独立Windows账户的权限配置与文件访问控制
Thought for 1m 39s

核对Claude Code钩子的文档结构。

决定是否查证Claude Code钩子的配置格式。

检查钩子的输出格式与退出码。

正在评估对方的发现，并比较钩子的失败开放风险。

正在评估对方的沙箱与权限结论。

比较提权方式与沙箱的权限边界。

比较独立Windows账户与WSL2两种方案的权限边界。

正在比较路径规范化与符号链接的绕过方式。

正在梳理路径规范化与符号链接的优先级。

正在核对路径判断的比对顺序与放行条件。

核对Claude Code钩子的权限与失败处理方式。

对外部模型接口与审计闸门的组合方案作评估。

设计一个会在运行后比对配置文件的包装脚本。

正在评估包装脚本的前后比对方案。

梳理宿主级失败开放的漏洞与补救方向。

评估独立Windows账户的权限配置与文件访问控制。

复审结论
标注沿用：[实测] 是你的实测，我无法复核，按你给的采信；[推断] 是机制推理；[不确定] 需要你验证。

先说总评：你这轮最有价值的是两个实测，宿主 hook 全部 fail-open，以及环境变量清洗后 KEYLEN=0。方向是对的。但有几处"看起来堵上了、实际没堵"，以及一整层没做。

1. 方向对不对，哪里在"加戏"
改对了的

fail-open 实测：它推翻了"hook 异常等于拒绝"的默认假设，是整轮价值最高的发现。[实测]
环境变量清洗：对"别好心办坏事"收益最大，也是唯一真正降低了被读走风险的改动。[实测] 局限：它只防 $env: 直读。同主体子进程可以用 ReadProcessMemory 读宿主进程环境，也可以读磁盘上的 auth.json 之类。[推断] 对手滑级别够用，对目标驱动的 agent 不算数。
audit 标 critical、sandbox plan 如实写"挡不挡主动拆解"：诚实度高。
需要修正，或有"加戏"风险的

(a) "错误路径全改拒绝"只覆盖脚本自己能活着跑到的错误。 宿主级 fail-open 仍在，以下情况脚本没机会输出 block：

进程起不来（解释器不在 PATH、被杀、OOM）
超时（你测过，12 秒挂起 → 放行）
脚本里的灾难性正则回溯
最后一项是真实攻击面：构造超长或病态命令，让闸门超时，宿主放行。[推断] 对策：

脚本内自带看门狗，限时低于宿主超时，到点输出 block。
输入大小上限，超限直接 deny。
匹配逻辑不用回溯型正则。
把你测宿主的 6 种异常矩阵，原样打到你自己的闸门上（延迟注入、巨大输入、杀进程、坏 JSON）。现在你测了宿主的行为，还没测自己脚本在这 6 种下的行为。
(b) spawn_host / cred_read 是写法黑名单。 git -c credential.helper=… credential fill、Python 里调用、先写脚本再执行，都能绕过。它们是便宜的 tripwire，可以留，但不要算进任何层级声明，也别让文档读起来像"凭据已受保护"。凭据真正的防线是它们不在 agent 主体的可见范围内。

(c) canary 是时点检查。 快测只测脚本逻辑，不测宿主接线；--live 才测接线。两者都只覆盖运行前。事实 3 已经证明运行中闸门可以被拆，所以 canary 对"运行中被拆"无能为力。这正是我上轮说的 L5 域外监督器的位置，你还没做。

(d) 事实 1 的证据是 agent 自述。 我上轮要求"证据来自 agent 之外的观察"，这条没满足。"文件系统只读"可能的原因：

Windows 沙箱未完成 setup。[不确定] Codex 的 Windows 沙箱有 elevated/unelevated 之分，elevated 需要一次性管理员初始化。如果它能工作，会创建专用沙箱用户，这恰好是你需要的"另一个主体"，不用自己搭。
项目没标 trusted，导致回落只读。[不确定]（projects.<path>.trust_level）
配置没生效。
在外部（Procmon 或宿主之外的 Test-Path）确认前，别在文档里写"Windows 没有中间档"，写"在我的环境、我的配置下观察到"。

(e) 我上轮那条说重了。 “reason 里写允许范围 = 绕行路线图”不准确。允许范围本身不是绕行路径，真正的信号是重复尝试。你删掉它的代价是 agent 不知道该往哪写，会多耗几轮。折中：把允许范围放进 AGENTS.md / system prompt 前置告知，reason 只写原因。

(f) 100 个测试通过，测的是逻辑，不是接线。 不要把它当有效性证据。

漏掉的层（最重要，且都不需要管理员）

L5-lite：oag run -- codex exec … 包装器。 运行前在包装器进程内存里记下基线哈希：闸门脚本、hooks.json、配置、规则文件，外加配置即代码集合（.git/hooks、.git/config、package.json 脚本、.vscode/tasks.json、.github/workflows、.envrc）和持久化点（schtasks、Run 键）。运行后比对，有变化就标记 tainted 并拒绝晋升。同主体下对手滑场景足够；对主动拆解不够，但至少把静默失效变成可检测失效。你"配置即代码只标 persistence"的问题也在这里解决：事后 diff 是确定性的，事前拦截不是。
L6 产物晋升： agent 只在 clone 里工作，运行前对真实仓库做快照（git bundle 加 tag），产物经 diff 审查再进真实仓库。这对"生产代码"是最直接的保护，且不依赖任何拦截的完备性。
写后执行洗白的便宜半解： 闸门看到 write 时记录路径与哈希，之后 exec 的第一个参数是 .py/.ps1/.js/.bat 且在本会话写入集合里，则按 ask，无头下即拒绝。能覆盖直接调用，覆盖不了 npm test / make 这类间接执行。[推断] 状态文件要放在策略可写域之外，否则又是 (4) 的老问题。

2. Claude Code hook schema
结构基本对。 我手头没有 2.1.322 的实机验证，以下是我对文档的记忆：[不确定：版本差异]

json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Glob|Grep|WebFetch|WebSearch|mcp__.*",
        "hooks": [ { "type": "command", "command": "...", "timeout": 10 } ] }
    ]
  }
}
差异和坑（按危害排序）：

退出码语义与 Codex 不同。 Claude 里 exit 2 才是阻断，stderr 回传给模型；其他非零退出（含脚本未捕获异常的 exit 1）是非阻断错误，即 fail-open。[推断，把握较高] 所以入口必须最外层 try/catch，任何异常都 exit 2。这又印证了"两个宿主的失败语义必须各测一遍，不能迁移假设"。
输出格式： {"decision":"block"} 是旧格式，对 PreToolUse 已标注弃用（仍映射）。新格式是：
json
   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
[不确定] 2.1.322 是否还兼容旧格式，建议用新格式，并配合 exit 2 兜底。
3. 闸门永远不要输出 allow。 允许就什么都不输出、exit 0，交给 Claude 自己的权限流程。[推断] hook 的 allow 可能跳过权限提示，你的闸门不该有"放宽"的能力。
4. 工具名映射不全： 还有 MultiEdit、NotebookEdit（字段 notebook_path）、Glob/Grep（path，且 Grep 能读内容，要按 read 处理）、WebSearch、Task（子 agent）、mcp__*。字段名：Write/Edit/Read 用 file_path，Bash 用 command，WebFetch 用 url，payload 里有 cwd。
5. "未知工具 → deny"会误杀自带工具（TodoWrite、ExitPlanMode 等）。要有一份明确的良性工具白名单，否则可用性会崩。
6. 配置位置： ~/.claude/settings.json 同主体可写，和 Codex 的 hooks.json 是同一个缺陷。Claude 有托管设置，优先级最高、用户层不能覆盖，Windows 上大致在 C:\Program Files\ClaudeCode\managed-settings.json。[不确定] 路径随版本变，请核对文档。它需要管理员写入一次，写入后 agent 账号无法修改。这是你"闸门所有权换主体"在 Claude 侧最便宜的实现。
7. 你没有 CLI 不是理由。 你有 DeepSeek/GLM 的 key，两家都提供 Anthropic 兼容端点，可以用 ANTHROPIC_BASE_URL 指过去，npm i -g 装上跑无头。[不确定] 请核对各家端点。在真机跑通之前，文档里 Claude 侧应写"未验证"，不要写"已支持"。

3. Windows 路径变体，先补哪两个
前提原则（比具体变体更重要）： 评估必须不对称。任一表示命中 deny → deny；allow 必须所有表示都落在允许范围内。 你现在最危险的方向是 deny 规则按字符串匹配，变体让它漏掉，比如 \\?\C:\repo\.env 不匹配 **\.env。

第一优先：reparse point（junction / symlink）。 它不是字符串问题，写入会真实落到允许范围之外。

匹配前先做 OS 级规范化：找到路径最深的已存在祖先，fs.realpathSync.native（或 GetFinalPathNameByHandle）解析，再拼上剩余部分。这一步同时消灭 junction、8.3 短名、\\?\ 前缀、大小写差异。
把"创建链接"（mklink、New-Item -ItemType Junction|SymbolicLink、fsutil reparsepoint）单独归为 op，默认 deny。
残余：检查与使用之间的 TOCTOU 无法根除。[推断]
第二优先：deny 规则上的字符串级变体。 规范化前先做：

剥 \\?\、\\.\ 前缀；\\localhost\c$\x 转成 C:\x；其他 UNC 默认 deny
剥 ADS：.env::$DATA 就等于 .env，.env:stream 指向它的流，对 deny 规则是直接绕过
每段剥尾部的点和空格
展开 ~、%VAR%、$env:VAR，展开不了的变量/子表达式一律视为 unknown → deny（这也顺带处理了你已知的"变量拼接"）
大小写不敏感比较
相对路径用 payload 里的 cwd 解析
8.3 短名、\\?\ 在第一优先的规范化里已被覆盖，所以第二优先只需补 ADS 和尾部点/空格，加上上面的不对称规则。

4. 现在最该做的一件事
用管理员权限一次性建一个专用的标准本地账号，让宿主以该账号运行。

要管理员，一次。之后日常启动不需要。
账号对真实用户目录和真实仓库无权限（注意 D:\code 这类非 profile 目录常被 Users 组可读，要显式处理继承）。
对工作副本是 Modify。
闸门脚本、hooks.json、规则文件、Claude 托管设置：所有者设为 Administrators，agent 账号只有读和执行，所在目录无写入权限，只开放 sessions/、log/ 这类必须写的子目录。这样它拿不到 WRITE_DAC，事实 4 的"自己改 ACL"自然失败。[推断] 验证方式是直接让 agent 对这些文件尝试改、改名、改所有者。
审计日志给 agent 账号只追加不可改。[推断]
这一步同时解决：事实 3（闸门被拆）、事实 4（ACL 自改）、凭据可见性（生产密钥不在它的视野里，cred_read 黑名单降级为锦上添花）、以及"没有原生中间档"（在账号边界内用 bypass，hook 退为 tripwire）。其他改动都是在加规则，这一步是在换主体。

5. 判决
你现在做的是一个诚实的、带自检的意图 tripwire；离"手术刀级"差三样：一个域外主体（上面那件事）、一个事后可检测的监督包装器（L5-lite + L6），以及外部观测下带次数的红队数据。 其余的归一化规则再补多少，都不会改变你的风险等级。





Claude is AI and can make mistakes.
Claude finished the response
