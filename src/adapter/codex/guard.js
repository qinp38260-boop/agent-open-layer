/**
 * Codex PreToolUse 闸门（按意图判定，手术刀级）
 *
 * 为什么按意图而不按写法：
 *   实测教训 —— 只堵 Remove-Item，agent 就换 apply_patch 的 *** Delete File:，
 *   文件照样被删。它没有恶意，只是"好心办坏事"。所以判定层先归一成
 *   {op, targets}（见 src/core/actions.js），再比策略，与书写形式无关。
 *
 * 已知边界（实测，别信"能关住"）：
 *   闸门是 $CODEX_HOME 下的两个普通文件。agent 若有写权限，可以：
 *     · 删掉 hooks.json 里的 PreToolUse 条目
 *     · 把本脚本改成一行 process.stdout.write("{}")
 *   ACL 也不行：文件属于当前账号时，账号能改自己的锁（实测它自己移除 Deny 再改）。
 *   → 真正的边界必须换安全主体（独立账号 / 容器 / 虚拟机）。本闸门只做
 *     「误操作与手滑防线 + 审计 + 可回滚」，不承担主动攻击防护。
 */
import fs from "node:fs";
import path from "node:path";
import { decisionTable, policyRef, collectRoots } from "../../core/policy.js";
import { normalizeToolCall, actionFor, scopedOps, normPath } from "../../core/actions.js";

export const GUARD_SCRIPT = "oag-guard.mjs";
export const GUARD_STATE = ".oag-guard.json";
export const GUARD_DENY_STATE = ".oag-guard-denies.json";

/**
 * 判定一次工具调用（纯函数，单测与运行时共用）
 * @returns {{op:string, action:string, decision:string, reason:string, targets:string[]}}
 */
export function classify({ toolName, command, policy, cwd }) {
  const table = decisionTable(policy);
  const { op, targets, why } = normalizeToolCall({ toolName, command, cwd });
  const action = actionFor(op);
  const decision = table[action] ?? "allow";

  if (scopedOps().includes(op)) {
    const roots = collectRoots(policy, op === "read" ? "READ" : "WRITE").map(normPath);
    if (roots.length) {
      const outside = targets.filter((t) => !roots.some((r) => t === r || t.startsWith(r + "/")));
      if (outside.length) {
        return { op, action, decision: "deny", targets, reason: `目标不在允许目录内：${outside.slice(0, 3).join(", ")}` };
      }
    } else if (targets.length && decision === "allow") {
      return { op, action, decision: "deny", targets, reason: `策略未开放任何目录，但动作涉及路径：${targets.slice(0, 2).join(", ")}` };
    }
  }
  return { op, action, decision, targets, reason: why };
}

/** 安装时把 actions.js 内联进生成的脚本（脚本必须能独立运行） */
function inlinedActions() {
  const p = new URL("../../core/actions.js", import.meta.url);
  let src = fs.readFileSync(p, "utf8");
  src = src.replace(/^export\s+/gm, "");
  src = src.replace(/^\/\*\*[\s\S]*?\*\/\s*/m, "");
  return src;
}

export function guardScriptBody(policyPath, auditPath) {
  return `// 由 open-agent-layer 生成：Codex PreToolUse 意图闸门。请勿手改，用 oag guard 重装。
import fs from "node:fs";
import nodePath from "node:path";
const POLICY_PATH = ${JSON.stringify(policyPath)};
const AUDIT = ${JSON.stringify(auditPath)};
const DENY_STATE = ${JSON.stringify(path.join(path.dirname(auditPath), GUARD_DENY_STATE))};

// ===== 内联 actions.js（与主模块同源） =====
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

function decisionTable2(policy) {
  const t = {};
  for (const r of policy.rules ?? []) if (!t[r.action]) t[r.action] = r.decision;
  return t;
}

function classify2({ toolName, command, policy, cwd }) {
  const table = decisionTable2(policy);
  const { op, targets, why } = normalizeToolCall({ toolName, command, cwd });
  const action = actionFor(op);
  const decision = table[action] ?? "allow";
  if (scopedOps().includes(op)) {
    const roots = rootsOf(policy, op === "read" ? "READ" : "WRITE");
    if (roots.length) {
      const outside = targets.filter((t) => !roots.some((r) => t === r || t.startsWith(r + "/")));
      if (outside.length) return { op, action, decision: "deny", targets, reason: "目标不在允许目录内：" + outside.slice(0, 3).join(", ") };
    } else if (targets.length && decision === "allow") {
      return { op, action, decision: "deny", targets, reason: "策略未开放任何目录，但动作涉及路径：" + targets.slice(0, 2).join(", ") };
    }
  }
  return { op, action, decision, targets, reason: why };
}

function noteDeny(targets) {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(DENY_STATE, "utf8")); } catch {}
  const now = Date.now();
  for (const t of targets) st[t] = now;
  for (const [k, v] of Object.entries(st)) if (now - v > 600000) delete st[k];
  try { fs.mkdirSync(path.dirname(DENY_STATE), { recursive: true }); fs.writeFileSync(DENY_STATE, JSON.stringify(st)); } catch {}
}
function wasDenied(targets) {
  try {
    const st = JSON.parse(fs.readFileSync(DENY_STATE, "utf8"));
    const now = Date.now();
    return targets.some((t) => st[t] && now - st[t] < 600000);
  } catch { return false; }
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let ev = {};
  try { ev = JSON.parse(input || "{}"); } catch { process.stdout.write("{}"); return; }
  let policy = { rules: [] };
  try { policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8")); } catch { process.stdout.write("{}"); return; }
  const cmd = String(ev.tool_input?.command ?? "");
  const r = classify2({ toolName: ev.tool_name, command: cmd, policy, cwd: ev.cwd });

  const repeat = r.decision !== "allow" && wasDenied(r.targets);
  if (r.decision !== "allow") noteDeny(r.targets);

  const line = JSON.stringify({
    at: new Date().toISOString(), event: "pre-tool", tool: ev.tool_name, session: ev.session_id,
    op: r.op, action: r.action, decision: r.decision, why: r.reason,
    targets: r.targets.slice(0, 5), repeat, cmd: cmd.slice(0, 300), policy: POLICY_PATH,
  });
  try { fs.mkdirSync(path.dirname(AUDIT), { recursive: true }); fs.appendFileSync(AUDIT, line + String.fromCharCode(10)); } catch {}

  if (r.decision === "deny") {
    const targets = r.targets.length ? r.targets.slice(0, 3).join(", ") : "(未识别到具体路径)";
    const roots = rootsOf(policy, r.op === "read" ? "READ" : "WRITE");
    const msg = [
      "OAG_GUARD 拒绝：" + r.op + " 动作，目标 " + targets,
      "原因：" + r.reason,
      "允许范围：" + (roots.length ? roots.join(", ") : "(未开放任何目录)"),
      repeat
        ? "这是同一目标的重复尝试：请停止换写法重试，改由用户调整策略。"
        : "请不要换用其他命令或工具重试同一目标；确需执行请让用户改策略。",
    ].join(" | ");
    process.stdout.write(JSON.stringify({ decision: "block", reason: msg }));
    return;
  }
  if (r.decision === "ask") {
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: "OAG_GUARD 需人工确认：" + r.op + "（" + r.reason + "）。无头模式无人可问，按保守处理=拦截；要放行请在策略里改成 allow，或改用可交互宿主。",
    }));
    return;
  }
  process.stdout.write("{}");
});
`;
}

export function install({ codexHome, policyPath, auditPath }) {
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
  // 实测：命令里用正斜杠 + 引号最稳（反斜杠路径在 hook 里会被 shell 吃掉）
  const fwd = scriptPath.split(String.fromCharCode(92)).join("/");
  cfg.hooks.PreToolUse = [...kept, { matcher: "", hooks: [{ type: "command", command: `node "${fwd}"` }] }];

  let backup = null;
  if (fs.existsSync(hooksFile)) {
    backup = `${hooksFile}.bak_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(hooksFile, backup);
  }
  fs.writeFileSync(hooksFile, JSON.stringify(cfg, null, 2) + String.fromCharCode(10), "utf8");
  const pol = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  fs.writeFileSync(
    path.join(codexHome, GUARD_STATE),
    JSON.stringify({ at: new Date().toISOString(), policyPath, policyRef: policyRef(pol), scriptPath, auditPath }, null, 2),
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

/** 体检：闸门自己会不会被 agent 拆掉 */
export function auditGuard(codexHome, policy) {
  const findings = [];
  const targets = [path.join(codexHome, "hooks.json"), path.join(codexHome, GUARD_SCRIPT)];
  const writeRoots = collectRoots(policy, "WRITE").map(normPath);
  for (const t of targets) {
    const n = normPath(t);
    const hit = writeRoots.find((r) => n === r || n.startsWith(r + "/"));
    if (hit) findings.push({ level: "critical", file: t, issue: `闸门文件在可写目录内（${hit}）→ agent 可以改掉它` });
  }
  if (!findings.length) findings.push({ level: "info", file: "-", issue: "闸门文件不在策略的可写范围内（这一项通过）" });
  findings.push({
    level: "warning",
    file: "-",
    issue: "同账号 ACL 不构成边界：文件所有者=运行账号时可自行移除 Deny 再改（已实测）",
  });
  return findings;
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
