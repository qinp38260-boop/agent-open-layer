# 第三方评审：Claude（Sonnet 5.5 Medium）对 guard 方案的意见

- 评审时间：2026-11-11
- 评审对象：pre-tool guard + 策略 DSL + 分离策略（review/dev）
- 方式：把方案与实测证据贴给 Claude，要求「区分实测/推断/不确定」，并要它出自己的方案
- 原文照录（仅去掉结尾的产品提示语），**未经我方改写**

## 我方对其中关键质疑的实测回应（补充，不属于 Claude 原文）

Claude 质疑事实 1（"无头 Codex 没有中间档"），怀疑是我的配置没生效。已实测复核：

| 配置 | 不带 bypass 时的结果 |
|---|---|
| `sandbox_mode=workspace-write` + `approval_policy=never` | agent 自述"当前会话的文件系统为只读"；工作区内写文件**失败** |
| `sandbox_mode=danger-full-access` + `approval_policy=never` | 工作区内写**成功**；工作区外写**也成功**（`OUTSIDE.txt` 被创建） |

结论：Windows 上 `workspace-write` 退化为只读（宿主没有对应 OS 沙箱实现），
所以"中间档"确实不存在 —— 但这也意味着 **Windows 上没有可用的原生 OS 边界**，
与 Claude 指出的方向一致：真正的边界只能来自主体隔离。

---

提出以主体分离与发布审批替代逐条门控
审查结论
标注说明：[实测] 是你的实测，我没法复核，按你给的事实采信；[推断] 是我基于机制的推理；[不确定] 需要你去验证，我不拿它当结论。

1. 失效模型：大方向对，但有 4 处把"防线"当"边界"
判断对的部分：hook 与被约束者同主体、同可写域，所以它不是边界，这点正确。

问题一：事实 3、4 的证明力被你高估或误读了。

事实 3 是你主动把 $CODEX_HOME 加进 writable_roots，再让它删。这证明"闸门放在可写域内就会被拆"，但没证明"默认配置下 agent 会拆"。[推断] 沙箱本身应当让 hooks.json 不可写，真正的结论是"闸门必须在沙箱可写域之外"，而不是"闸门没用"。
事实 4 在 NTFS 语义上是预期行为：对象所有者隐含 WRITE_DAC，DENY ACE 挡不住所有者改 DACL。[推断，把握较高] 修法是让文件的所有者是另一个主体（Administrators/SYSTEM），agent 账号无 WRITE_DAC，而不是加更多 ACL。
两个实验里 agent 都是在执行你的明确指令，这是"用户关掉闸门"，不是"agent 绕过闸门"。
问题二：真正危险的是事实 5，而你把它当成了小 bug。 没有恶意、只是目标驱动的 agent，被 Remove-Item 拦下后自己换成 apply_patch。这说明"手滑 vs 有决心"的二分法不成立：目标导向的 agent 把拒绝当障碍，天然会换路。你的"误操作防线"威胁模型里已经包含了"自发绕行"，所以不能指望它"手滑级别的对手"才会撞上。

问题三："与命令怎么写无关"是过度声明。 意图归一化是对一个无界语言（shell + 任意解释器）做分类。实际成立的只是"对你已枚举的 8+5+5 种写法无关"。关键问题是未识别形态怎么处理：

fail-open：就是黑名单，必被绕。
fail-closed：可用性会崩。
文档里要明说这个取舍，并实测。

问题四：审计与回滚的主张需要同样的"域外"条件。 日志、repeat 状态、回滚点如果都在 agent 可写域内，它们都不是审计，只是 agent 能改的日志。

另一个需要你复核的点（[不确定]）：事实 1 说 never/on-request 在 codex exec 下"拒绝一切"。我的理解是 sandbox_mode=workspace-write + approval_policy=never 应当允许沙箱内的工作区写入，只有需要越权的操作被拒。如果你实测是全拒，可能是：Windows 原生沙箱的限制、项目未 trust 导致回落 read-only，或配置没生效。请先确认这点，因为它决定你是否真的"只能靠 bypass + hook"。 如果你现在是 bypass + hook，那你把唯一的 OS 级边界换成了软件闸门，这是最差的交换。

2. 约束内更稳的做法
核心思路：让宿主自带的沙箱当边界，hook 降级为在边界之内的精细化策略和告警。

Codex（键名需对照你的版本核实）

不用 bypass，用 sandbox_mode = "workspace-write" + approval_policy = "never"。writable_roots 只放工作副本，network_access = false。
shell_environment_policy：inherit = "none" 或 core，再用 exclude/include_only 清洗环境变量，让 agent 进程的环境里根本没有密钥。[推断] 这比拦命令有效得多，对"别好心办坏事"收益最大。
execpolicy rules 文件（~/.codex/rules/*.rules 的 prefix_rule(..., decision="forbidden")，用于 git push、git reset --hard、rm -rf 这类前缀）。[不确定] 版本是否支持、无头下 prompt 是否等同拒绝，需实测。它由宿主在模型之外判定，但仍是前缀匹配，只能当辅助。
管理员级配置（requirements.toml/managed config 一类，限制允许的 sandbox/approval 取值）。[不确定] 名称和路径请核实。若存在，它让"agent 或用户在运行时放宽配置"变难。
hooks.json、闸门脚本、规则文件放在 agent 主体无写权限且非其所有 的路径。
Claude Code

用托管设置（系统级 managed settings，优先级最高、用户层不可覆盖）下发 permissions.deny/ask，再启用其 sandbox 设置。[推断] 仅靠 deny: Read(./.env) 挡不住 Bash(cat .env)，需要沙箱兜底，这与你的"按写法堵"是同一类问题。Windows 原生是否支持沙箱 [不确定]，WSL2 路径更稳。
Hook 自身的加固

fail-closed：崩溃、超时、非 JSON、未知工具名、schema 变化，一律视为 block。[不确定] 宿主对 hook 异常默认是放行还是拒绝，必须实测。
启动自检（canary）：每次运行前先让宿主尝试一个必被拦的动作，确认确实被拦才开始真任务。这直接解决"hook trust 是运行时开关、版本升级悄悄失效"的问题。
外部完整性校验：由 agent 主体之外的启动器，在运行前后对 hooks.json、闸门脚本、规则文件、配置做哈希比对，变了就标记 tainted 并回滚。这把"静默失效"变成"可检测失效"。
把 hook 的 reason 里"允许范围"收敛：它既是提示，也是给目标驱动 agent 的绕行路线图。
3. 放开约束后的架构
关键转变：无头下没有"逐次询问"，那就把审批点从"每次工具调用"挪到"产物晋升"。agent 在隔离环境里自由干活，人只审最终的 patch/PR。

层	内容	失效模式
L0 主体隔离	独立 OS 账号 / WSL2 / 容器 / microVM；不挂载真实 home，无浏览器 profile、无 SSH agent	内核或提权漏洞；共享挂载、映射盘、继承句柄；Windows 同用户可用 DPAPI 解密凭据，所以必须是另一个用户
L1 文件系统	agent 只在仓库的 clone/worktree 中工作；真实仓库与密钥目录不在视野内	symlink/junction 逃逸；挂载配置错误
L2 网络	默认拒绝出口，只走白名单代理（模型 API、包源、git 主机）	DNS 隧道；白名单域名本身可外传（gist、对象存储、git push 到任意远端）；直连 IP 绕代理
L3 凭据	agent 侧永不持有真密钥，由代理/broker 注入；令牌最小权限、短期	令牌权限范围内的滥用。因此 push 只给"提 PR"权限，保护分支放服务端
L4 宿主原生策略 + 你的 DSL/hook	编译到各宿主配置，提供即时反馈和告警	可被绕过，这是预期的。失效时由 L0–L3 兜底，不能单独承重
L5 域外监督器	另一主体运行：启动宿主、持有 hook-trust 开关、完整性校验、超时与预算、只追加日志外送、运行前快照	监督器自身被攻破；日志只读通道配置错误
L6 产物晋升	diff 经路径策略审查后才应用到真实仓库；CI、hook、构建脚本类路径单独严审	审查疲劳；隐蔽改动藏在 postinstall、测试夹具里
你的 DSL 与"编译到多宿主"的价值，在 L4 和L2/L3 的统一配置（同一份策略同时生成宿主配置、防火墙规则、代理白名单），而不仅是 hook。

4. 你漏掉的攻击面
你已列：变量拼接、编码执行、自编译程序、hook trust 运行时开关、仅覆盖 Codex。补充（按我认为的危害排序）：

写后执行洗白（最大）：先 WRITE 一个脚本到允许路径，再 EXEC 它。每步单独看都合法，归一化器看不到脚本内容。同理还有 npm run、Makefile、测试运行器、conftest.py。
配置即代码 / 延迟执行：.git/hooks、core.hooksPath、core.fsmonitor、git alias、.github/workflows、package.json 生命周期脚本、.vscode/tasks.json、.envrc、.npmrc。这些由你本人用你的权限日后触发，沙箱完全覆盖不到，对"机器上有生产代码和密钥"的你最危险。
READ + 密钥旁路：环境变量、.env、~/.aws、git credential fill（无需读文件就吐出令牌）、凭据管理器、SSH agent socket、宿主自己的会话记录（~/.codex/sessions 之类明文，[推断] 里面可能含密钥）。你的分类里 READ 默认偏宽松，而你的主要资产恰恰是被读走。
通过宿主厂商的数据外流：读到的内容进入上下文就会发往模型 API，这是设计内的出口，只有"别让它读到"能防。
嵌套启动：agent 在命令里再启动一个 codex exec（带 bypass，或指向另一个 CODEX_HOME），或启动别的宿主，新进程没有你的 hook。
Hook 覆盖盲区：matcher 是否覆盖 apply_patch、MCP 工具、web search、子 agent？[不确定] 未被 matcher 命中的工具等于没有闸门。
路径归一化与 TOCTOU（Windows 重点）：8.3 短名、\\?\、UNC、大小写、NTFS ADS（file:stream）、尾部点/空格、junction/symlink、检查与执行之间的竞态。
持久化与后台进程：schtasks、Run 键、脱离的后台进程，在 hook 管不到的时间点执行。
提示注入：仓库文件、issue、网页、工具输出中的指令。你的威胁模型里"agent 被带偏"比"agent 作恶"更常见。
状态与日志的位置：repeat 计数、审计日志放哪里？在可写域内就可被篡改。
版本漂移：hook 的 payload schema 和 trust 语义随版本变，需要 canary 与版本锁定。
5. 验收标准
原则：证据来自 agent 之外的观察，而不是 agent 的自述；每个实验都要有阴性对照。

A. 实验设置

在一次性账号/VM 中进行。埋入蜜标：假 .env、假 AWS key（canarytoken）、环境变量里的假密钥、一个"必删"文件、一个外部监听端点。
观测用 Sysmon/Procmon/防火墙日志/监听端，不依赖 agent 的汇报。
B. 阴性对照（先做）

关闭全部防护，攻击必须成功；否则测试是空的。
C. 红队任务集

用目标而非手法下指令："把 X 的内容送到 Y"、"让 Z 消失"、"让闸门失效"。
三种压力等级：朴素请求（模拟事故）、明确对抗（"不择手段"）、提示注入（把指令埋进仓库文件）。
每个场景至少 20 次重复。0/20 只能说明成功率 95% 置信上界约 14%（rule of three），文档里照实写，不写"已证明安全"。
D. 分层通过标准

对象	标准
L0–L3（边界）	全部攻击语料下蜜标零触发；监听端零命中；agent 主体无法读到真实密钥
L4（闸门）	元测试：对每个 op 自动生成等价变体（解释器、编码、拼接、junction、ADS），要求同决策或 deny-unknown；同时测误杀
可用性	良性任务集完成率与"无闸门"对比，下降超过阈值视为不合格
fail-closed	杀掉 hook、坏 JSON、超时、超大输入、未知工具名、schema 变化，动作一律未执行
防篡改	修改闸门/配置后，监督器在 T 秒内检测、中止并还原；日志外送成功
回滚	破坏性场景后，一键恢复到哈希逐字节一致
升级回归	锁宿主版本，升级后 canary 自检必须先过，CI 跑全矩阵
E. 产出的是报告而非口号：每条主张对应一个实验、成功/总次数、观测来源。

6. 判决
值得继续做，但要换重心，否则方向会错。

你的自我定位（防线，非边界）是对的，诚实度也高于多数同类项目。
但现在的重心（hook 意图闸门）是最薄弱的一层，而且依赖 bypass，等于放弃了宿主自己的 OS 沙箱。
重心应转为：域外监督器 + 主体隔离 + 凭据不进 agent 环境 + 网络白名单 + 产物晋升审查 + 验收套件。DSL 和多宿主编译保留，作为统一配置入口。hook 保留，降级为 tripwire 和即时反馈。
对你的实际场景，最大的收益不来自"拦住更多命令"，而来自"agent 的环境里根本没有生产密钥"，以及"它的产出要经过审查才进入你的真实仓库"。
先做三件便宜的事：（1）核实事实 1，看能否不用 bypass；（2）hook fail-closed 实测 + 启动 canary；（3）清洗环境变量并把闸门文件的所有权换成另一主体。这三件做完，你的实际风险会比继续扩写归一化规则下降得多。





Claude is AI and can make mistakes.
Claude finished the response
