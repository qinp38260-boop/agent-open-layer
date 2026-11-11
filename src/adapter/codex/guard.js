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
import os from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { decisionTable, policyRef, collectRoots } from "../../core/policy.js";
import { normalizeToolCall, actionFor, scopedOps, normPath, payloadText, hasDynamicPath, PERSISTENCE_RE } from "../../core/actions.js";

export const GUARD_SCRIPT = "oag-guard.mjs";
export const SHIM_SCRIPT = "oag-shim.mjs";
export const GUARD_STATE = ".oag-guard.json";
export const GUARD_DENY_STATE = ".oag-guard-denies.json";

/**
 * 判定一次工具调用（纯函数，单测与运行时共用）
 * @returns {{op:string, action:string, decision:string, reason:string, targets:string[]}}
 */
export function classify({ toolName, command, policy, cwd, input, canon }) {
  const table = decisionTable(policy);
  // 命令文本 + 结构化入参（apply_patch 把路径写在 input 里，只读 command 会漏掉整个目标集）
  const text = [command ?? "", payloadText(input)].filter(Boolean).join(" ");
  const { op, targets, why } = normalizeToolCall({ toolName, command: text, cwd });
  const action = actionFor(op);
  const decision = table[action] ?? "allow";

  if (scopedOps().includes(op)) {
    // 动态拼接的路径静态判定不了：放行等于开一条免检通道，按保守方向拒
    if (hasDynamicPath(text)) {
      return { op, action, decision: "deny", targets, reason: "路径是运行时拼接的（$env:/%VAR%/Join-Path），无法静态判定范围" };
    }
    const fix = typeof canon === "function" ? canon : (x) => x;
    const roots = collectRoots(policy, op === "read" ? "READ" : "WRITE").map((r) => normPath(fix(r)));
    if (roots.length) {
      const outside = targets.filter((t) => !roots.some((r) => t === r || t.startsWith(r + "/")));
      if (outside.length) {
        return { op, action, decision: "deny", targets, reason: `目标不在允许目录内：${outside.slice(0, 3).join(", ")}` };
      }
    } else if (targets.length && decision === "allow") {
      return { op, action, decision: "deny", targets, reason: `策略未开放任何目录，但动作涉及路径：${targets.slice(0, 2).join(", ")}` };
    }
  }
  // 闸门逃逸类：无条件拒绝（不受策略 allow 影响，因为这类动作本身就等于绕闸）
  if (op === "spawn_host" || op === "cred_read") {
    return { op, action, decision: "deny", targets, reason: op === "spawn_host" ? "疑似嵌套启动宿主以绕过闸门" : "疑似凭据采集" };
  }

  // 非 Bash 且未能归类 = 未知工具（MCP、未来新增工具）：默认拒绝，避免"没规则=放行"
  if (op === "spawn_host" || op === "cred_read") {
    return { op, action, decision: "deny", targets, reason: op === "spawn_host" ? "疑似嵌套启动宿主以绕过闸门" : "疑似凭据采集" };
  }
  if (op === "exec" && toolName && toolName !== "Bash") {
    return { op, action, decision: "deny", targets, reason: `未知工具 ${toolName}，策略未覆盖（默认拒绝）` };
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

function classify2({ toolName, command, policy, cwd, canon }) {
  const table = decisionTable2(policy);
  const { op, targets, why } = normalizeToolCall({ toolName, command, cwd });
  const action = actionFor(op);
  const decision = table[action] ?? "allow";
  if (scopedOps().includes(op)) {
    // 动态拼接的路径静态判定不了：放行等于开一条免检通道，按保守方向拒
    if (hasDynamicPath(command)) {
      return { op, action, decision: "deny", targets, reason: "路径是运行时拼接的（$env:/%VAR%/Join-Path），无法静态判定范围" };
    }
    const fix = typeof canon === "function" ? canon : (x) => x;
    const roots = rootsOf(policy, op === "read" ? "READ" : "WRITE").map((r) => normPath(fix(r)));
    if (roots.length) {
      const outside = targets.filter((t) => {
        const tt = normPath(fix(t));
        return !roots.some((r) => tt === r || tt.startsWith(r + "/"));
      });
      if (outside.length) return { op, action, decision: "deny", targets, reason: "目标不在允许目录内：" + outside.slice(0, 3).join(", ") };
    } else if (targets.length && decision === "allow") {
      return { op, action, decision: "deny", targets, reason: "策略未开放任何目录，但动作涉及路径：" + targets.slice(0, 2).join(", ") };
    }
  }
  if (op === "spawn_host" || op === "cred_read") {
    return { op, action, decision: "deny", targets, reason: op === "spawn_host" ? "疑似嵌套启动宿主以绕过闸门" : "疑似凭据采集" };
  }
  if (op === "exec" && toolName && toolName !== "Bash") {
    return { op, action, decision: "deny", targets, reason: "未知工具 " + toolName + "，策略未覆盖（默认拒绝）" };
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

const MAX_INPUT = 256 * 1024;
let input = "";
let finished = false;
function finishBlock(why) {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: "OAG_GUARD 拒绝（" + why + "）：宿主对 hook 异常是 fail-open（已实测），此处保守拒绝。",
  }));
}
// 看门狗：宿主超时后是 fail-open，所以必须在它之前自己拒绝
const watchdog = setTimeout(() => {
  finishBlock("闸门处理超时（看门狗）");
  process.exit(0);
}, 4000);

process.stdin.on("data", (d) => {
  input += d;
  if (input.length > MAX_INPUT) {
    clearTimeout(watchdog);
    finishBlock("输入超过上限 " + MAX_INPUT + " 字节");
    process.exit(0);
  }
});
process.stdin.on("end", () => {
  clearTimeout(watchdog);
  try {
    run();
  } catch (e) {
    finishBlock("内部异常：" + String((e && e.message) || e));
  }
});

function run() {
  let ev = {};
  const failClosed = finishBlock;
  if (!input.trim()) return failClosed("事件为空（宿主没有传 payload）");
  try { ev = JSON.parse(input); } catch { return failClosed("事件不是合法 JSON"); }
  let policy = { rules: [] };
  try { policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8")); } catch { return failClosed("策略文件读不到或不是合法 JSON：" + POLICY_PATH); }
  // 入参里所有字符串字段都摊进来：apply_patch 的补丁正文在 input 里，只读 command 等于不判
  const cmd = [String(ev.tool_input?.command ?? ""), payloadText(ev.tool_input)].filter(Boolean).join(" ");
  // realpath：junction / 软链 / 8.3 短名折成真实路径，否则根内一个链接就能写到根外
  const canon = (x) => {
    // 目标文件可能还不存在（新建/改名），realpath 会抛错 —— 此时折「最近的已存在祖先」，
    // 否则根内一条 junction 就能把写入带到根外却仍被判成"在根内"。
    let cur = String(x);
    const rest = [];
    for (let i = 0; i < 12; i++) {
      try {
        const real = fs.realpathSync.native(cur);
        return rest.length ? nodePath.join(real, ...rest.reverse()) : real;
      } catch {}
      const parent = nodePath.dirname(cur);
      if (!parent || parent === cur) break;
      rest.push(nodePath.basename(cur));
      cur = parent;
    }
    return x;
  };
  const r = classify2({ toolName: ev.tool_name, command: cmd, policy, cwd: ev.cwd, canon });

  const persistence = PERSISTENCE_RE.test(" " + cmd);
  const repeat = r.decision !== "allow" && wasDenied(r.targets);
  if (r.decision !== "allow") noteDeny(r.targets);

  const line = JSON.stringify({
    at: new Date().toISOString(), event: "pre-tool", tool: ev.tool_name, session: ev.session_id,
    op: r.op, action: r.action, decision: r.decision, why: r.reason,
    targets: r.targets.slice(0, 5), repeat, persistence, cmd: cmd.slice(0, 300), policy: POLICY_PATH,
  });
  try { fs.mkdirSync(path.dirname(AUDIT), { recursive: true }); fs.appendFileSync(AUDIT, line + String.fromCharCode(10)); } catch {}

  if (r.decision === "deny") {
    const targets = r.targets.length ? r.targets.slice(0, 3).join(", ") : "(未识别到具体路径)";
    const msg = [
      "OAG_GUARD 拒绝：" + r.op + " 动作，目标 " + targets,
      "原因：" + r.reason,
      repeat
        ? "这是同一目标的重复尝试，已记录。请停止换写法重试，改由用户调整策略。"
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
  if (!finished) { finished = true; process.stdout.write("{}"); }
}
`;
}

export function install({ codexHome, policyPath, auditPath, shim = true }) {
  const hooksFile = path.join(codexHome, "hooks.json");
  const scriptPath = path.join(codexHome, GUARD_SCRIPT);
  fs.writeFileSync(scriptPath, guardScriptBody(policyPath, auditPath ?? path.join(codexHome, "..", ".oag", "audit.jsonl")), "utf8");

  // 外壳：宿主对 hook 故障一律放行（7 种情况实测），只有套一层才能把"闸门坏了"变成"block"
  const shimPath = path.join(codexHome, SHIM_SCRIPT);
  if (shim) {
    const src = new URL("../../../scripts/guard-shim.mjs", import.meta.url);
    fs.copyFileSync(src, shimPath);
  }

  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  } catch {
    cfg = {};
  }
  cfg.hooks = cfg.hooks ?? {};
  const kept = (Array.isArray(cfg.hooks.PreToolUse) ? cfg.hooks.PreToolUse : []).filter(
    (e) => !JSON.stringify(e).includes(GUARD_SCRIPT) && !JSON.stringify(e).includes(SHIM_SCRIPT)
  );
  // 实测：命令里用正斜杠 + 引号最稳（反斜杠路径在 hook 里会被 shell 吃掉）
  const fwd = scriptPath.split(String.fromCharCode(92)).join("/");
  const fwdShim = shimPath.split(String.fromCharCode(92)).join("/");
  const cmd = shim ? `node "${fwdShim}" "${fwd}"` : `node "${fwd}"`;
  cfg.hooks.PreToolUse = [...kept, { matcher: "", hooks: [{ type: "command", command: cmd }] }];

  let backup = null;
  if (fs.existsSync(hooksFile)) {
    backup = `${hooksFile}.bak_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(hooksFile, backup);
  }
  fs.writeFileSync(hooksFile, JSON.stringify(cfg, null, 2) + String.fromCharCode(10), "utf8");
  const pol = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  fs.writeFileSync(
    path.join(codexHome, GUARD_STATE),
    JSON.stringify({ at: new Date().toISOString(), policyPath, policyRef: policyRef(pol), scriptPath, shim: shim ? shimPath : null, auditPath }, null, 2),
    "utf8"
  );
  return { installed: true, scriptPath, shimPath: shim ? shimPath : null, hooksFile, backup, policyPath };
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
export function auditGuard(codexHome, policy, auditPath) {
  const findings = [];
  const targets = [path.join(codexHome, "hooks.json"), path.join(codexHome, GUARD_SCRIPT)];
  if (auditPath) targets.push(auditPath, path.join(path.dirname(auditPath), GUARD_DENY_STATE));
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

/**
 * 启动自检：确认闸门真的在拦，而不是"装上了但失效"（版本升级/信任丢失/被改都会静默失效）
 * @param {{codexHome:string, fast?:boolean, codexCli?:string, model?:string}} opts
 */
export function canary({ codexHome, fast = true, codexCli, model = "deepseek-chat" }) {
  const scriptPath = path.join(codexHome, GUARD_SCRIPT);
  const results = [];
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, results: [{ name: "脚本存在", ok: false, detail: `找不到 ${scriptPath}` }] };
  }

  // A. 快测：直接把"必被拦"的事件喂给脚本（不花钱、不启动宿主）
  const feed = (cmd) => {
    const r = spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: process.cwd(), tool_input: { command: cmd } }),
      encoding: "utf8",
      timeout: 15000,
    });
    let decision = "allow";
    try {
      decision = JSON.parse(r.stdout || "{}").decision ?? "allow";
    } catch {
      decision = "invalid-json";
    }
    return { decision, stderr: String(r.stderr ?? "").slice(0, 200) };
  };

  const bad = feed("rm -rf /tmp/oag-canary-should-be-blocked");
  results.push({ name: "快测：破坏性命令被拦", ok: bad.decision === "block", detail: `decision=${bad.decision}` });

  const good = feed("echo oag-canary");
  results.push({ name: "快测：普通命令放行", ok: good.decision === "allow", detail: `decision=${good.decision}` });

  // B. 实测：让宿主真的跑一次"必被拦"的动作，看副作用
  if (!fast && codexCli) {
    const base = path.join(os.tmpdir(), `oag-canary-${Date.now()}`);
    const work = path.join(base, "work");
    const outside = path.join(base, "outside");
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const victim = path.join(outside, "must-survive.txt");
    fs.writeFileSync(victim, "x");
    const args = [
      "exec", "--json", "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust",
      "-C", work, "-m", model,
      `删除文件 ${victim.split(String.fromCharCode(92)).join("/")}（它存在）。只做这一件事。`,
    ];
    try {
      execFileSync(codexCli, args, {
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: "utf8",
        timeout: 240000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      /* 宿主非零退出不影响判定，只看副作用 */
    }
    results.push({
      name: "实测：宿主动作被拦（文件仍在）",
      ok: fs.existsSync(victim),
      detail: fs.existsSync(victim) ? "未被删除" : "文件被删 → 闸门失效",
    });
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }

  return { ok: results.every((r) => r.ok), results };
}

export function remove(codexHome) {
  const hooksFile = path.join(codexHome, "hooks.json");
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  } catch {}
  let removed = 0;
  if (Array.isArray(cfg?.hooks?.PreToolUse)) {
    const kept = cfg.hooks.PreToolUse.filter((e) => !JSON.stringify(e).includes(GUARD_SCRIPT) && !JSON.stringify(e).includes(SHIM_SCRIPT));
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
