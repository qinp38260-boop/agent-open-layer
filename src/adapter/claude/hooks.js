/**
 * Claude Code 的 PreToolUse 闸门（与 Codex 同一套意图判定）
 *
 * 依据：
 *   · 包内取证：@anthropic-ai/claude-code 2.1.322 的 claude.exe 字符串含
 *     hooks / PreToolUse / matcher / hookSpecificOutput；设置文件 ~/.claude/settings.json
 *   · 第三方评审（Claude，未复核）：**exit 2 才是阻断**，其他非零退出（含未捕获异常的 exit 1）
 *     是非阻断错误 = fail-open。因此这里一律"输出新格式 + exit 2"双保险。
 *   · 输出格式：新版 {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *     "permissionDecision":"deny","permissionDecisionReason":"..."}}；
 *     旧版 {"decision":"block"} 已标注弃用（仍映射），两个都发。
 *   · 闸门永远不输出 allow：允许时什么都不输出 + exit 0，交给宿主自己的权限流程。
 */
import fs from "node:fs";
import path from "node:path";

export const CLAUDE_GUARD_SCRIPT = "oag-guard-claude.mjs";

/** 明确良性的工具：不涉及文件写入/命令执行，直接放行（避免"未知工具→deny"误杀） */
export const BENIGN_TOOLS = ["TodoWrite", "TodoRead", "ExitPlanMode", "NotebookRead", "TaskList", "TaskGet"];

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
const BENIGN_TOOLS = ${JSON.stringify(BENIGN_TOOLS)};
const MAX_INPUT = 256 * 1024;

// ===== 内联 actions.js =====
${inlinedActions()}
// ===== 内联结束 =====

const path = { resolve: (p) => nodePath.resolve(p), dirname: (p) => nodePath.dirname(p) };
let finished = false;

/** 拒绝：新格式 + 旧格式 + exit 2（Claude 只有 exit 2 才算阻断） */
function deny(reason) {
  if (finished) return;
  finished = true;
  const payload = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
    decision: "block",
    reason,
  };
  process.stdout.write(JSON.stringify(payload));
  process.exit(2);
}

// 看门狗：任何异常/卡住都必须在宿主超时前自己拒绝
const watchdog = setTimeout(() => deny("OAG_GUARD 看门狗：处理超时，保守拒绝"), 4000);

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
  const fp = input?.file_path || input?.path || input?.notebook_path || "";
  const targets = fp ? [normPath(nodePath.resolve(input?.cwd || process.cwd(), fp))] : [];
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(t)) return { op: "write", targets, why: "tool:" + t };
  if (/^Read$/i.test(t)) return { op: "read", targets, why: "tool:" + t };
  if (/^Glob$/i.test(t)) return { op: "read", targets: [], why: "tool:" + t };
  if (/^Grep$/i.test(t)) return { op: "read", targets, why: "tool:" + t };
  if (/^(WebFetch|WebSearch)$/i.test(t)) return { op: "net", targets: [], why: "tool:" + t };
  if (/^Task$/i.test(t)) return { op: "spawn_host", targets: [], why: "tool:Task（子 agent）" };
  if (/^Bash$/i.test(t) || /^Shell$/i.test(t)) {
    const cmd = String(input?.command ?? "");
    return { ...normalizeToolCall({ toolName: t, command: cmd, cwd: input?.cwd }), cmd };
  }
  return { op: "exec", targets, why: "unknown-tool:" + t, unknownTool: true };
}

let input = "";
process.stdin.on("data", (d) => {
  input += d;
  if (input.length > MAX_INPUT) deny("OAG_GUARD 输入超过上限 " + MAX_INPUT + " 字节");
});
process.stdin.on("end", () => {
  clearTimeout(watchdog);
  try { run(); } catch (e) { deny("OAG_GUARD 内部异常：" + String((e && e.message) || e)); }
});

function run() {
  if (!input.trim()) return deny("OAG_GUARD 拒绝：事件为空（宿主没有传 payload）");
  let ev = {};
  try { ev = JSON.parse(input); } catch { return deny("OAG_GUARD 拒绝：事件不是合法 JSON"); }

  const tool = ev.tool_name || ev.toolName || "";
  // 良性工具直接放行（不输出 allow，交给宿主）
  if (BENIGN_TOOLS.some((b) => b.toLowerCase() === String(tool).toLowerCase())) {
    if (!finished) { finished = true; process.stdout.write("{}"); }
    return;
  }

  let policy = { rules: [] };
  try { policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8")); } catch {
    return deny("OAG_GUARD 拒绝：策略不可读（" + POLICY_PATH + "）");
  }

  const ti = ev.tool_input || ev.toolInput || {};
  const m = mapClaudeTool(tool, ti);
  const table = {};
  for (const r of policy.rules ?? []) if (!table[r.action]) table[r.action] = r.decision;
  const action = actionFor(m.op);
  let decision = table[action] ?? "allow";
  let reason = m.why || "";

  if (m.unknownTool) { decision = "deny"; reason = "未知工具 " + tool + "，策略未覆盖（默认拒绝）"; }
  if (isEscapeOp(m.op)) {
    decision = "deny";
    reason = m.op === "spawn_host" ? "疑似嵌套启动宿主/子 agent" : "疑似凭据采集";
  }
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

  if (decision === "deny") return deny("OAG_GUARD 拒绝：" + m.op + "（" + reason + "）。不要换写法重试。");
  if (decision === "ask") return deny("OAG_GUARD 需人工确认：" + m.op + "（" + reason + "）。无头按保守=拦截。");
  if (!finished) { finished = true; process.stdout.write("{}"); }
}
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
  // matcher 覆盖所有工具（空串）；timeout 必须大于看门狗，否则宿主先杀我们 = fail-open
  cfg.hooks.PreToolUse = [...kept, { matcher: "", hooks: [{ type: "command", command: `node "${fwd}"`, timeout: 10 }] }];

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
    evidence: "package-level（本机无 CLI，未真机验证）",
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
