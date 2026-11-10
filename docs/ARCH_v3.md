# ARCH v3 —— 合成稿（甲骨架 + 乙两条洞察 + v2 的 fail-closed）

> 状态：**已实现并有测试**（21/21 通过）· 真宿主 `dsh 0.1.0-rc.7` 冒烟通过（只 plan 未写）
> 来源：`DESIGN_A.md`（甲，可编译 + smoke 通过）、`DESIGN_B.md`（乙，纯设计但有两条关键洞察）、v2 的 journal/隔离/注入防护

## 1. 抽象形状（取甲的"基类承载共享动作"）

adapter 只回答三件事，共享安全动作全部在 core：

| 层 | 职责 |
|---|---|
| `src/adapter/types.js` | 错误码 → 退出码固定表、`AdapterError`、JSDoc 类型契约 |
| `src/core/managed-block.js` | 托管块整行匹配 / 幂等整块替换 / 损坏检测 / `commentSafe` 能力位 |
| `src/core/safe-write.js` | journal → 竞态双检 → 备份 → 原子写 → 读回验证 → 失败还原 |
| `src/adapter/registry.js` | 注册 + 自动探测（首个 detect 成功的 adapter 胜） |
| `src/adapter/dsh/index.js` | 参考实现：`detect / capabilities / plan / planRevert / apply / revert / verifyHost` |

## 2. 逐条决策（谁提的 → 怎么落地）

| 来源 | 意见 | v3 落地 | 验证 |
|---|---|---|---|
| 甲 坑#1 | YAML 的可去重追加搬到 TOML/JSON 会叠重复键 → 托管块必须**整块替换**、各 adapter 自实现 | `composeBlock` 对已有块一律 replace-block；`capabilities().format` 决定策略 | `apply 后重复 apply 是 no-op`（测试 1） |
| 甲 坑#2 | 竞态窗口在 **backup 之后、write 之前** → write 必须重读比对 | `safeWrite` 做**两次** hash 比对（写前 + 备份后写前） | `plan 之后文件被外部改动 → E_RACE 且不写盘`（测试 5） |
| 甲 坑#3 | **skipped ≠ 通过**，需要非零退出码 | 新增 `E_VERIFY_SKIPPED → exit 2`，与失败 `1` 区分 | `verify 跳过 → 退出码 2`（测试 7） |
| 乙 坑#2 | **JSON 不支持注释 → marker 放不进去**，要靠能力位切策略 | `commentSafe=false` 时 core 直接抛 `E_CAPABILITY_MISSING`，不猜 | `JSON 宿主 → E_CAPABILITY_MISSING`（测试 4） |
| 乙 坑#3 | **版本探测 ≠ 能力探测**；verify 应调宿主自带 validate | `capabilities()` 独立声明；`verifyHost()` 跑 `dsh --dump-config` 并用 `payload.expect` 断言 | 真宿主冒烟：`host 0.1.0-rc.7` + plan 正常 |
| v2 | apply 崩溃要能恢复 | `safeWrite` 写 `.oag-journal.json`，`readJournal()` 供 CLI 判 `RECOVER_REQUIRED` | 代码在，CLI 接线属 v3.1 |
| v2 | 路径逃逸 | `assertProfileName` + `path.resolve` containment 双校验 | `profile 名逃逸 → E_PROFILE_INVALID`（测试 8） |
| v2 | 隔离执行（审查器可能改工作区） | 记在 `scripts/codex-review.sh`（默认隔离复制），core 不涉及 | 已有实测 |

## 3. 现在能干什么

```bash
node --test tests/adapter.test.mjs    # 9 条 adapter 契约测试
node --test tests/*.test.mjs          # 全套 21 条
```

真宿主：

```js
import { dshAdapter } from "./src/adapter/dsh/index.js";
const a = dshAdapter({ profile: "web", cli: "D:/Programs/hermes_data/node/dsh.cmd" });
const host = await a.detect(process.env);          // { id:'dsh', version:'0.1.0-rc.7', configPath }
const plan = await a.plan(host, { id:'identity', body: "...", expect: /includeHarnessIdentity:\s*false/ });
await a.apply(plan);                               // 走 safeWrite（备份/竞态/读回/还原）
await a.verifyHost(host, payload);                 // 跑 --dump-config 实证
```

## 4. 还没做（明确欠账）

1. **CLI 接线**：现有 `bin/dsh-open.js` 还是 v0 的直写逻辑，未切到 adapter（v3.1 第一件事）
2. **Codex / Claude Code adapter**：目录预留，未实现（Codex = TOML 无 marker，需命名空间序列化）
3. **journal 恢复入口**：`readJournal()` 有了，但 CLI 还没在启动时拦 `RECOVER_REQUIRED`
4. **并发锁**：多进程同时 apply 仍可能交错（journal 能事后发现，不能事前互斥）
5. **审计一致性**：`audit.jsonl` 仍是旧模块，未与 adapter 层统一

## 5. 复盘：这是三方各出一块的结果

- 甲（V4 Pro）给了**可编译骨架 + safeWrite 顺序**，且 smoke 我自己复现过
- 乙（Claude）给了**两条抽象层会崩的坑**（JSON marker、版本≠能力），这两条甲和 v2 都没提
- v2 给了 **journal / 隔离 / 注入防护**（都是这几天实测踩出来的）
- 三方单独任何一个都不完整；**"设计 → 审计 → 实测 → 合成"这条链是有效的**
