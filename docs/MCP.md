# MCP 工具接入

## 结论先说

以前：MCP 工具落在"未知工具 → 默认拒绝"，**安全但等于 MCP 全废**。
现在：**在策略里声明能力的 MCP 工具才放行，没声明的一律拒**（fail-closed）。

## 命名约定（实测自 codex 0.167.0 二进制）

```
mcp__<server>__<tool>
例：mcp__ologs__get_profile
     mcp__codex_apps__user_messaging__send_message
```

## 策略写法

```json
{
  "mcp": {
    "files/read_file":   { "action": "READ",  "paths": ["/srv/agent-work/**"] },
    "files/write_file":  { "action": "WRITE", "paths": ["/srv/agent-work/**"] },
    "codex_apps/*":      { "action": "NET",   "decision": "deny" },
    "harmless/ping":     { "action": "NET",   "decision": "allow" }
  }
}
```

匹配顺序：精确 `server/tool` → `server/*` → `*`。

## 判定语义

| 声明 | 闸门怎么判 |
|---|---|
| 未声明 | **拒绝**：`MCP 工具 X 未在策略 mcp 段声明能力` |
| `READ` / `WRITE` / `DELETE` + `paths` | 从入参抽取目标路径，**全部**落在 `paths` 内才放行；越界拒 |
| 读/写类但**抽不到目标路径** | **拒绝**（无法验证 = 不放行） |
| 读/写类但**没写 paths** | **拒绝** |
| `NET` / `EXEC_*` | 按 `decision`（缺省 **deny**） |

## 为什么这么设计（不猜能力）

MCP 工具对闸门是黑盒：`mcp__ologs__get_profile` 到底读文件、发网络、还是写盘，看名字看不出来。
猜错一次就是漏放。所以选择**显式声明**：谁想用某个 MCP 工具，就在策略里写清它的能力与范围。

另外：MCP 分支必须排在通用 `READ/WRITE` 白名单判定**之前** —— 否则工具名里带 `read` 的
（`mcp__files__read_file`）会先被通用规则吃掉，声明里的 `paths` 就形同虚设。这条实测踩过，已固化进测试。

## 已验证 / 未验证

| 项 | 状态 |
|---|---|
| 未声明即拒、声明内放行、越界拒、缺 paths 拒、通配生效、NET 缺省 deny | ✅ `tests/mcp-guard.test.mjs` 8 条 |
| 模块判定 与 **生成的闸门脚本** 行为一致 | ✅ 同一测试里对生成脚本实跑 |
| 与真实 MCP server 的端到端调用 | ❌ **未验证**（本机没有配置 MCP server） |
