# L6 产物晋升流程（已演练，2026-11-11）

目标：**agent 的产出必须经过审查才进真实仓库**；它自己改的东西由 diff 决定去留，不由它说。

## 一次完整运行（真机记录）

```bash
oag run --cwd D:/agent-work/repo-demo --codex-home D:/agent-work/.codex \
        --policy D:/agent-work/.codex/policy.json \
        --snapshot D:/agent-work/repo-demo --fail-on-taint \
        -- <要跑的命令>
```

输出（原文）：

```
监督运行  监控 7 个路径，canary 先过
  退出码：11  快照：D:\agent-work\repo-demo\.oag-snapshots\pre-run-2026-11-10T19-34-27-724Z.bundle
⚠ tainted：运行期间有 1 个被监控文件发生变化
    [modified] D:\agent-work\repo-demo\package.json
```

## 四步

1. **跑前快照**：`git bundle create`（`.oag-snapshots/pre-run-*.bundle`），`git bundle verify` 通过
2. **跑**：canary 先过（闸门必须活着），否则直接不开跑（退出码 10）
3. **跑后比对**：闸门脚本 / hooks.json / 宿主配置 / 策略 / `.git/hooks` / `.git/config` /
   `package.json` / `.vscode/tasks.json` / `.github/workflows` / `.envrc` 任一变化 → `tainted`（退出码 11）
4. **人工审查**：`git status` + `git diff`，看清楚再决定合并或回退

## 这次实际抓到的

```diff
- {}
+ {"scripts":{"postinstall":"echo pwned"}}
```

`postinstall` 是典型的**持久化风险**：写入时看不出来，但你下次 `npm install` 就会执行它。
只标 `tainted` 不拦是对的 —— 拦截器判断不了意图，diff 能。

## 回退

```bash
git checkout -- .          # 放弃这次改动
git bundle verify <bundle>  # 需要时从快照恢复：git clone <bundle> 或 git fetch <bundle>
```

## 局限（照实写）

- 只监控**已存在**的持久化点；新建的目录（比如新出现的 `.github/workflows`）在首次出现时能发现，
  但更深层的间接执行（`npm run`、Makefile、`conftest.py`）覆盖不到
- 快照只覆盖 git 仓库；非 git 目录只能比对哈希，无法回滚
- 同主体下 tainted 只是"可检测的失效"；真正的边界在 L0
