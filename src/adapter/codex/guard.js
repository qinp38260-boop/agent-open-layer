/**
 * Codex PreToolUse 闸门（动作级拦截）
 *
 * 为什么需要它：实测 codex exec（无头）里，approval=never 与 on-request 都等于"拒绝一切"，
 * 除了 --dangerously-bypass-approvals-and-sandbox 没有任何"选择性放开"的路径。
 * 也就是说：要么全拦（干不了活），要么全开（危险）。
 * 官方还给了一扇门：PreToolUse hook —— 每个工具调用前跑我们的脚本，
 * 返回 {"decision":"block","reason":...} 即可否决（实测：文件确实没被创建，stderr 有
 * "Command blocked by PreToolUse hook"）。
 *
 * 所以"分开"的落地是：沙箱被迫全开（bypass），但每个动作先过我们的策略闸门。
 * 这比 dsh-purge 的做法更细：它把原生闸门拆了不设防，我们拆了原生闸门后装自己的闸门，
 * 规则写在 policy 文件里，可审可改可回滚。
 *
 * 实测事件结构（codex-cli 0.167.0）：
 *   {session_id, turn_id, transcript_path, cwd, hook_event_name:"PreToolUse", model,
 *    permission_mode, tool_name:"Bash", tool_input:{command:"..."}, tool_use_id}
 * 所有写文件动作也走 Bash（apply_patch 以 shell 命令形式出现）。
 */
import fs from "node:fs";
import path from "node:path";
import { decisionTable, policyRef, collectWritableRoots, collectReadableRoots } from "../../core/policy.js";

export const GUARD_SCRIPT = "oag-guard.mjs";
export const GUARD_STATE = ".oag-guard.json";

/** 破坏性：删/格式化/重置历史 */
const DESTRUCTIVE = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/i,
  /\brmdir\s+\/s/i,
  /\bdel\s+\/[fsq]/i,
  /\bRemove-Item\b/i,
  /\*\*\*\s*Delete File:/i,
  /\*\*\*\s*Delete Directory:/i,
  /\b(erase|del)\s+\S+/i,
  /\[System\.IO\.File\]::Delete/i,
  /\[System\.IO\.Directory\]::Delete/i,
  /(^|[;&|]\s*)rm\s+(?!-)/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*[fd]/i,
  /\bgit\s+push\b.*(--force|-f)\b/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\btaskkill\b.*\/f/i,
  /\bshutdown\b|\breboot\b/i,
  />\s*\/dev\/sd[a-z]/i,
];

/** 装包：会改环境 */
const INSTALL = [
  /\bnpm\s+(i|install|add)\b/i,
  /\bpnpm\s+(i|install|add)\b/i,
  /\byarn\s+(add|install)\b/i,
  /\bpip3?\s+install\b/i,
  /\buv\s+(pip\s+)?(add|install)\b/i,
  /\bwinget\s+install\b/i,
  /\bchoco\s+install\b/i,
  /\bapt(-get)?\s+install\b/i,
  /\bcargo\s+install\b/i,
];

/** 改 git 历史/远端 */
const GIT_WRITE = [/\bgit\s+(commit|push|merge|rebase|tag|cherry-pick)\b/i];

/** 联网 */
const NETWORK = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bInvoke-WebRequest\b/i,
  /\bInvoke-RestMethod\b/i,
  /\bssh\b/,
  /\bscp\b/,
  /\bgit\s+clone\b/i,
  /\bnc\s+-/i,
];

/** 写动作的迹象（配合绝对路径做范围判断） */
const WRITE_HINT = [/>/, /\bcp\b/i, /\bmv\b/i, /\btee\b/i, /New-Item/i, /Set-Content/i, /Add-Content/i, /apply_patch/i, /Out-File/i];

const ABS_PATH = /(?:^|[\s"'(=])((?:[A-Za-z]:[\\/]|\/)[^\s"')]+)/g;

/**
 * 把一个工具调用归类到 动作 × 决策
 * @returns {{action: string, decision: string, reason: string}}
 */
export function classify({ toolName, command, policy, cwd }) {
  const table = decisionTable(policy);
  const cmd = String(command ?? "");
  const decide = (action, reason) => ({ action, decision: table[action] ?? "allow", reason });

  for (const re of DESTRUCTIVE) if (re.test(cmd)) return decide("EXEC_DESTRUCTIVE", `匹配破坏性模式 ${String(re)}`);
  for (const re of INSTALL) if (re.test(cmd)) return decide("EXEC_INSTALL", `匹配装包模式 ${String(re)}`);
  for (const re of GIT_WRITE) if (re.test(cmd)) return decide("EXEC_GIT_WRITE", `匹配 git 写模式 ${String(re)}`);
  for (const re of NETWORK) if (re.test(cmd)) return decide("NET", `匹配联网模式 ${String(re)}`);

  // 写动作 + 绝对路径越界
  const norm = (p) => path.resolve(p).split(String.fromCharCode(92)).join("/").toLowerCase().replace(/[/]+$/, "");
  const inRoots = (abs, roots) => roots.some((r) => abs === r || abs.startsWith(r + "/"));
  const looksWrite = WRITE_HINT.some((re) => re.test(cmd));
  if (looksWrite) {
    const roots = collectWritableRoots(policy).map(norm);
    const hits = [];
    for (const m of cmd.matchAll(ABS_PATH)) {
      const raw = m[1].replace(/[;,)]+$/, "");
      const abs = norm(path.resolve(cwd ?? ".", raw));
      if (!inRoots(abs, roots)) hits.push(raw);
    }
    // scope 违规 = deny，与 table 里 WRITE 的决策无关（WRITE=allow 只对"允许目录内"生效）
    if (hits.length) return { action: "WRITE", decision: "deny", reason: `写目标在允许目录之外：${hits.slice(0, 3).join(", ")}` };
    return decide("WRITE", "写目标在允许目录内");
  }

  if (toolName && toolName !== "Bash" && /write|edit|patch/i.test(toolName)) return decide("WRITE", `工具 ${toolName} 属写操作`);

  // 读范围：命令里出现的绝对路径若不在允许读目录内 → deny（涉密场景最关键的一条）
  const readRoots = collectReadableRoots(policy).map(norm);
  if (readRoots.length) {
    const outside = [];
    for (const m of cmd.matchAll(ABS_PATH)) {
      const raw = m[1].replace(/[;,)]+$/, "");
      const abs = norm(path.resolve(cwd ?? ".", raw));
      if (!inRoots(abs, readRoots)) outside.push(raw);
    }
    if (outside.length) return { action: "READ", decision: "deny", reason: `读取目标在允许目录之外：${outside.slice(0, 3).join(", ")}` };
  }
  return decide("EXEC_SAFE", "未命中受限模式");
}

export function guardScriptBody(policyPath, auditPath) {
  return `// 由 open-agent-layer 生成：Codex PreToolUse 策略闸门。请勿手改，用 oag guard 重装。
import fs from "node:fs";
const POLICY_PATH = ${JSON.stringify(policyPath)};
const AUDIT = ${JSON.stringify(auditPath)};
const DESTRUCTIVE = ${JSON.stringify(DESTRUCTIVE.map((r) => ({ s: r.source, f: r.flags })))};
const INSTALL = ${JSON.stringify(INSTALL.map((r) => ({ s: r.source, f: r.flags })))};
const GIT_WRITE = ${JSON.stringify(GIT_WRITE.map((r) => ({ s: r.source, f: r.flags })))};
const NETWORK = ${JSON.stringify(NETWORK.map((r) => ({ s: r.source, f: r.flags })))};
const WRITE_HINT = ${JSON.stringify(WRITE_HINT.map((r) => ({ s: r.source, f: r.flags })))};
const ABS_PATH = /(?:^|[\\s"'(=])((?:[A-Za-z]:[\\\\/]|\\/)[^\\s"')]+)/g;
const path = await import("node:path");

function table(policy) {
  const t = {};
  for (const r of policy.rules ?? []) if (!t[r.action]) t[r.action] = r.decision;
  return t;
}
const norm = (p) => path.resolve(p).split(String.fromCharCode(92)).join("/").toLowerCase();
const inRoots = (abs, rs) => rs.some((r) => abs === r || abs.startsWith(r + "/"));
function roots(policy, action) {
  const out = [];
  for (const r of policy.rules ?? []) {
    if (r.action !== action || r.decision !== "allow") continue;
    for (const raw of r.scope?.paths ?? []) {
      const p = String(raw).replace(/^!/, "");
      if (!/^[A-Za-z]:[\\\\/]/.test(p) && !p.startsWith("/")) continue;
      const cut = p.search(/[*?[{]/);
      const base = cut === -1 ? p : p.slice(0, p.lastIndexOf("/", cut) + 1) || p;
      out.push(base.replace(/[\\\\/]+$/, "").toLowerCase());
    }
  }
  return out;
}
function classify(cmd, toolName, cwd, policy) {
  const t = table(policy);
  const pick = (a, why) => ({ action: a, decision: t[a] ?? "allow", why });
  const hit = (arr) => arr.find((x) => new RegExp(x.s, x.f).test(cmd));
  let m;
  if ((m = hit(DESTRUCTIVE))) return pick("EXEC_DESTRUCTIVE", "destructive:" + m.s.slice(0, 40));
  if ((m = hit(INSTALL))) return pick("EXEC_INSTALL", "install:" + m.s.slice(0, 40));
  if ((m = hit(GIT_WRITE))) return pick("EXEC_GIT_WRITE", "git-write:" + m.s.slice(0, 40));
  if ((m = hit(NETWORK))) return pick("NET", "network:" + m.s.slice(0, 40));
  const looksWrite = Boolean(hit(WRITE_HINT));
  if (looksWrite) {
    const rs = roots(policy, "WRITE").map(norm);
    const hits = [];
    for (const m of cmd.matchAll(ABS_PATH)) {
      const raw = m[1].replace(/[;,)]+$/, "");
      const abs = norm(path.resolve(cwd || ".", raw));
      if (!inRoots(abs, rs)) hits.push(raw);
    }
    if (hits.length) return { action: "WRITE", decision: "deny", why: "outside-roots:" + hits.slice(0, 2).join(",") };
    return pick("WRITE", "inside-roots");
  }
  if (toolName && toolName !== "Bash" && /write|edit|patch/i.test(toolName)) return pick("WRITE", "tool:" + toolName);
  const rr = roots(policy, "READ").map(norm);
  if (rr.length) {
    const outside = [];
    for (const m of cmd.matchAll(ABS_PATH)) {
      const raw = m[1].replace(/[;,)]+$/, "");
      const abs = norm(path.resolve(cwd || ".", raw));
      if (!inRoots(abs, rr)) outside.push(raw);
    }
    if (outside.length) return { action: "READ", decision: "deny", why: "read-outside-roots:" + outside.slice(0, 2).join(",") };
  }
  return pick("EXEC_SAFE", "default");
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let ev = {};
  try { ev = JSON.parse(input || "{}"); } catch { process.stdout.write("{}"); return; }
  let policy = { rules: [] };
  try { policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8")); } catch { process.stdout.write("{}"); return; }
  const cmd = String(ev.tool_input?.command ?? "");
  const r = classify(cmd, ev.tool_name, ev.cwd, policy);
  const line = JSON.stringify({
    at: new Date().toISOString(), event: "pre-tool", tool: ev.tool_name, session: ev.session_id,
    action: r.action, decision: r.decision, why: r.why, cmd: cmd.slice(0, 200),
    policy: POLICY_PATH,
  });
  try { fs.mkdirSync(path.dirname(AUDIT), { recursive: true }); fs.appendFileSync(AUDIT, line + String.fromCharCode(10)); } catch {}
  if (r.decision === "deny") {
    process.stdout.write(JSON.stringify({ decision: "block", reason: "OAG_GUARD deny " + r.action + " (" + r.why + "). 策略：" + POLICY_PATH }));
    return;
  }
  if (r.decision === "ask") {
    // 无头环境无人可问：按策略意图"不放行"，并注明可改为 allow 或交互模式放行
    process.stdout.write(JSON.stringify({ decision: "block", reason: "OAG_GUARD ask " + r.action + " (" + r.why + "). 无头模式按保守处理=拦截；要放行请在策略里改成 allow。" }));
    return;
  }
  process.stdout.write("{}");
});
`;
}

export function install({ codexHome, policyPath, auditPath, maxHint }) {
  const hooksFile = path.join(codexHome, "hooks.json");
  const scriptPath = path.join(codexHome, GUARD_SCRIPT);
  fs.writeFileSync(scriptPath, guardScriptBody(policyPath, auditPath ?? path.join(codexHome, "..", ".oag", "audit.jsonl")), "utf8");

  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  } catch {
    cfg = {};
  }
  cfg.hooks = cfg.hooks ?? {};
  const kept = (Array.isArray(cfg.hooks.PreToolUse) ? cfg.hooks.PreToolUse : []).filter(
    (e) => !JSON.stringify(e).includes(GUARD_SCRIPT)
  );
  cfg.hooks.PreToolUse = [
    ...kept,
    // 实测：命令里用正斜杠 + 引号最稳（反斜杠路径在 hook 里会被 shell 吃掉）
    { matcher: "", hooks: [{ type: "command", command: `node "${scriptPath.split(String.fromCharCode(92)).join("/")}"` }] },
  ];
  let backup = null;
  if (fs.existsSync(hooksFile)) {
    backup = `${hooksFile}.bak_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(hooksFile, backup);
  }
  fs.writeFileSync(hooksFile, JSON.stringify(cfg, null, 2) + String.fromCharCode(10), "utf8");
  fs.writeFileSync(
    path.join(codexHome, GUARD_STATE),
    JSON.stringify({ at: new Date().toISOString(), policyPath, policyRef: policyRef(JSON.parse(fs.readFileSync(policyPath, "utf8"))), scriptPath, auditPath }, null, 2),
    "utf8"
  );
  return { installed: true, scriptPath, hooksFile, backup, policyPath };
}

export function status(codexHome) {
  const hooksFile = path.join(codexHome, "hooks.json");
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  } catch {}
  const pre = Array.isArray(cfg?.hooks?.PreToolUse) ? cfg.hooks.PreToolUse : [];
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(path.join(codexHome, GUARD_STATE), "utf8"));
  } catch {}
  return {
    installed: pre.some((e) => JSON.stringify(e).includes(GUARD_SCRIPT)),
    scriptExists: fs.existsSync(path.join(codexHome, GUARD_SCRIPT)),
    hooksFile,
    state,
  };
}

export function remove(codexHome) {
  const hooksFile = path.join(codexHome, "hooks.json");
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  } catch {}
  let removed = 0;
  if (Array.isArray(cfg?.hooks?.PreToolUse)) {
    const kept = cfg.hooks.PreToolUse.filter((e) => !JSON.stringify(e).includes(GUARD_SCRIPT));
    removed = cfg.hooks.PreToolUse.length - kept.length;
    cfg.hooks.PreToolUse = kept;
    if (!kept.length) delete cfg.hooks.PreToolUse;
    if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  }
  let backup = null;
  if (fs.existsSync(hooksFile)) {
    backup = `${hooksFile}.bak_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(hooksFile, backup);
  }
  if (Object.keys(cfg).length) fs.writeFileSync(hooksFile, JSON.stringify(cfg, null, 2) + String.fromCharCode(10), "utf8");
  else if (fs.existsSync(hooksFile)) fs.rmSync(hooksFile, { force: true });
  for (const f of [GUARD_SCRIPT, GUARD_STATE]) {
    const p = path.join(codexHome, f);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  return { removed, backup };
}
