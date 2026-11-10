/**
 * Claude Code 的 PreToolUse 闸门（与 Codex 同一套意图判定）
 *
 * 依据（包内取证，未真机运行 —— 本机没装 claude CLI）：
 *   @anthropic-ai/claude-code 2.1.322 的 claude.exe 字符串里出现：
 *     hooks / PreToolUse / PostToolUse / matcher / hookSpecificOutput
 *   设置文件：~/.claude/settings.json
 *
 * 与 Codex 的差异只在"工具名 → 意图"的映射：
 *   Codex：几乎所有动作都走 Bash（含 apply_patch）
 *   Claude：Read / Write / Edit / Bash / Glob / Grep / WebFetch 分开
 * 判定本身复用 src/core/actions.js（同一套 op × targets）。
 */
import fs from "node:fs";
import path from "node:path";

export const CLAUDE_GUARD_SCRIPT = "oag-guard-claude.mjs";

function inlinedActions() {
  const p = new URL("../../core/actions.js", import.meta.url);
  let src = fs.readFileSync(p, "utf8");
  src = src.replace(/^export\s+/gm, "");
  src = src.replace(/^\/\*\*[\s\S]*?\*\/\s*/m, "");
  return src;
}

export function buildScript(policyPath, auditPath) {
  return `// 由 open-agent-layer 生成：Claude Code PreToolUse 意图闸门。请勿手改。
import fs from "node:fs";
import nodePath from "node:path";
const POLICY_PATH = ${JSON.stringify(policyPath)};
const AUDIT = ${JSON.stringify(auditPath)};

// ===== 内联 actions.js =====
${inlinedActions()}
// ===== 内联结束 =====

const path = { resolve: (p) => nodePath.resolve(p), dirname: (p) => nodePath.dirname(p) };

function rootsOf(policy, action) {
  const out = [];
  for (const r of policy.rules ?? []) {
    if (r.action !== action || r.decision !== "allow") continue;
    for (const raw of r.scope?.paths ?? []) {
      const p = String(raw).replace(/^!/, "");
      if (!/^[A-Za-z]:[\\\\/]/.test(p) && !p.startsWith("/")) continue;
      const cut = p.search(/[*?[{]/);
      const base = cut === -1 ? p : p.slice(0, p.lastIndexOf("/", cut) + 1) || p;
      out.push(normPath(base));
    }
  }
  return out;
}

/** Claude 的工具名 → 意图（工具自带语义，不需要猜命令） */
function mapClaudeTool(toolName, input) {
  const t = String(toolName || "");
  const fp = input?.file_path || input?.path || "";
  const targets = fp ? [normPath(nodePath.resolve(input?.cwd || process.cwd(), fp))] : [];
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(t)) return { op: "write", targets, why: "tool:" + t };
  if (/^Read$/i.test(t)) return { op: "read", targets, why: "tool:" + t };
  if (/^(WebFetch|WebSearch)$/i.test(t)) return { op: "net", targets: [], why: "tool:" + t };
  if (/^Bash$/i.test(t) || /^Shell$/i.test(t)) {
    const cmd = String(input?.command ?? "");
    return { ...normalizeToolCall({ toolName: t, command: cmd, cwd: input?.cwd }), cmd };
  }
  if (/^(Glob|Grep)$/i.test(t)) return { op: "read", targets: [], why: "tool:" + t };
  return { op: "exec", targets, why: "unknown-tool:" + t, unknownTool: true };
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const failClosed = (why) =>
    process.stdout.write(JSON.stringify({ decision: "block", reason: "OAG_GUARD 自检失败（" + why + "）" }));
  let ev = {};
  try { ev = JSON.parse(input || "{}"); } catch { return failClosed("事件不是合法 JSON"); }
  let policy = { rules: [] };
  try { policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8")); } catch { return failClosed("策略不可读"); }

  const tool = ev.tool_name || ev.toolName || "";
  const ti = ev.tool_input || ev.toolInput || {};
  const m = mapClaudeTool(tool, ti);
  const table = {};
  for (const r of policy.rules ?? []) if (!table[r.action]) table[r.action] = r.decision;
  const action = actionFor(m.op);
  let decision = table[action] ?? "allow";
  let reason = m.why || "";

  if (m.unknownTool) { decision = "deny"; reason = "未知工具，策略未覆盖（默认拒绝）"; }
  if (isEscapeOp(m.op)) { decision = "deny"; reason = m.op === "spawn_host" ? "疑似嵌套启动宿主" : "疑似凭据采集"; }
  if (scopedOps().includes(m.op)) {
    const roots = rootsOf(policy, m.op === "read" ? "READ" : "WRITE");
    if (roots.length) {
      const outside = m.targets.filter((t) => !roots.some((r) => t === r || t.startsWith(r + "/")));
      if (outside.length) { decision = "deny"; reason = "目标不在允许目录内：" + outside.slice(0, 2).join(", "); }
    } else if (m.targets.length && decision === "allow") {
      decision = "deny"; reason = "策略未开放任何目录，但动作涉及路径";
    }
  }

  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    fs.appendFileSync(AUDIT, JSON.stringify({
      at: new Date().toISOString(), host: "claude-code", event: "pre-tool", tool,
      op: m.op, action, decision, reason, targets: m.targets.slice(0, 5),
      persistence: PERSISTENCE_RE.test(String(ti.command ?? "") + " " + String(ti.file_path ?? "")),
    }) + String.fromCharCode(10));
  } catch {}

  if (decision === "deny") {
    process.stdout.write(JSON.stringify({ decision: "block", reason: "OAG_GUARD 拒绝：" + m.op + "（" + reason + "）。不要换写法重试。" }));
    return;
  }
  if (decision === "ask") {
    process.stdout.write(JSON.stringify({ decision: "block", reason: "OAG_GUARD 需人工确认：" + m.op + "（" + reason + "）。无头按保守=拦截。" }));
    return;
  }
  process.stdout.write("{}");
});
`;
}

/** 安装到 ~/.claude/settings.json 的 hooks.PreToolUse */
export function install({ claudeHome, policyPath, auditPath }) {
  const settingsPath = path.join(claudeHome, "settings.json");
  const scriptPath = path.join(claudeHome, CLAUDE_GUARD_SCRIPT);
  fs.writeFileSync(scriptPath, buildScript(policyPath, auditPath ?? path.join(claudeHome, "..", ".oag", "audit.jsonl")), "utf8");

  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {}
  cfg.hooks = cfg.hooks ?? {};
  const kept = (Array.isArray(cfg.hooks.PreToolUse) ? cfg.hooks.PreToolUse : []).filter(
    (e) => !JSON.stringify(e).includes(CLAUDE_GUARD_SCRIPT)
  );
  const fwd = scriptPath.split(String.fromCharCode(92)).join("/");
  cfg.hooks.PreToolUse = [...kept, { matcher: "", hooks: [{ type: "command", command: `node "${fwd}"` }] }];

  let backup = null;
  if (fs.existsSync(settingsPath)) {
    backup = `${settingsPath}.bak_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(settingsPath, backup);
  }
  fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + String.fromCharCode(10), "utf8");
  return { installed: true, settingsPath, scriptPath, backup };
}

export function status(claudeHome) {
  const settingsPath = path.join(claudeHome, "settings.json");
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {}
  const pre = Array.isArray(cfg?.hooks?.PreToolUse) ? cfg.hooks.PreToolUse : [];
  return {
    installed: pre.some((e) => JSON.stringify(e).includes(CLAUDE_GUARD_SCRIPT)),
    scriptExists: fs.existsSync(path.join(claudeHome, CLAUDE_GUARD_SCRIPT)),
    settingsPath,
  };
}

export function remove(claudeHome) {
  const settingsPath = path.join(claudeHome, "settings.json");
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {}
  let removed = 0;
  if (Array.isArray(cfg?.hooks?.PreToolUse)) {
    const kept = cfg.hooks.PreToolUse.filter((e) => !JSON.stringify(e).includes(CLAUDE_GUARD_SCRIPT));
    removed = cfg.hooks.PreToolUse.length - kept.length;
    cfg.hooks.PreToolUse = kept;
    if (!kept.length) delete cfg.hooks.PreToolUse;
    if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  }
  let backup = null;
  if (fs.existsSync(settingsPath)) {
    backup = `${settingsPath}.bak_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(settingsPath, backup);
  }
  if (Object.keys(cfg).length) fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + String.fromCharCode(10), "utf8");
  for (const f of [CLAUDE_GUARD_SCRIPT]) {
    const p = path.join(claudeHome, f);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  return { removed, backup };
}
