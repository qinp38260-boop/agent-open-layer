/**
 * Codex 原生 AUTO_CONTINUE（Stop hook）
 *
 * 实测证据（codex-cli 0.167.0，2026-11-11）：
 *   · `$CODEX_HOME/hooks.json` 结构 = {hooks:{Stop:[{matcher,hooks:[{type:"command",command}]}]}}
 *   · Stop hook 通过 stdin 收到：{session_id, turn_id, transcript_path, cwd, hook_event_name:"Stop",
 *     model, permission_mode, stop_hook_active, last_assistant_message}
 *   · 输出 {"decision":"block","reason":"..."} 会让宿主**再跑一轮**（实测一轮里出现 2 条 agent_message）
 *   · **必须 trusted**：不加 `--dangerously-bypass-hook-trust` 时 hook 根本不触发
 *     （二进制里有 hook_trust / trusted_content_hash / hooksPath）
 *
 * 因此本模块只负责"装/卸/查"，是否绕过 trust 由调用方在命令行显式承担。
 * 防死循环：stop_hook_active=true 时一律放行；每会话计数到 maxContinues 后放行。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const HOOK_SCRIPT_NAME = "oag-stop-hook.mjs";
export const STATE_NAME = ".oag-continue.json";
const MARKER = "oag-auto-continue";

export function hooksPath(codexHome) {
  return path.join(codexHome, "hooks.json");
}

function backupFile(p) {
  if (!fs.existsSync(p)) return null;
  const bak = `${p}.bak_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(p, bak);
  return bak;
}

function readHooks(codexHome) {
  try {
    return JSON.parse(fs.readFileSync(hooksPath(codexHome), "utf8"));
  } catch {
    return null;
  }
}

/** 我们的 hook 条目（幂等：靠 command 里出现的脚本名识别） */
function isOurs(entry) {
  return JSON.stringify(entry).includes(HOOK_SCRIPT_NAME);
}

export function status(codexHome) {
  const cfg = readHooks(codexHome);
  const stops = cfg?.hooks?.Stop ?? [];
  const installed = stops.some((e) => isOurs(e));
  const scriptExists = fs.existsSync(path.join(codexHome, HOOK_SCRIPT_NAME));
  return { installed, scriptExists, hooksFile: hooksPath(codexHome), stopHooks: stops.length };
}

/**
 * 安装 Stop hook（保留用户已有的其它 hook 条目）
 * @param {{ codexHome: string, maxContinues?: number, continuePrompt?: string, cli?: string }} opts
 */
export function install(opts) {
  const codexHome = opts.codexHome;
  if (!codexHome || !fs.existsSync(codexHome)) throw new Error(`codex home 不存在：${codexHome}`);
  const maxContinues = Math.max(0, Math.min(opts.maxContinues ?? 1, 10));
  const continuePrompt = opts.continuePrompt ?? "Continue from where you stopped. Reply done when finished.";

  // 1) 写 hook 脚本（内容含参数，可直接读）
  const scriptPath = path.join(codexHome, HOOK_SCRIPT_NAME);
  const script = `// 由 open-agent-layer 生成：Codex Stop hook（原生自动续跑）
// 防死循环：stop_hook_active 为 true 时放行；每会话计数到上限放行。
import fs from "node:fs";
const MAX = ${maxContinues};
const PROMPT = ${JSON.stringify(continuePrompt)};
const STATE = ${JSON.stringify(path.join(codexHome, STATE_NAME))};
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let ev = {};
  try { ev = JSON.parse(input || "{}"); } catch { process.stdout.write("{}"); return; }
  if (ev.stop_hook_active) { process.stdout.write("{}"); return; } // 已经在续跑里，放行
  let st = {};
  try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
  const sid = ev.session_id || "unknown";
  const n = (st[sid]?.count ?? 0) + 1;
  st[sid] = { count: n, at: new Date().toISOString() };
  try { fs.writeFileSync(STATE, JSON.stringify(st)); } catch {}
  if (n > MAX) { process.stdout.write("{}"); return; } // 到上限放行
  process.stdout.write(JSON.stringify({ decision: "block", reason: PROMPT }));
});
`;
  fs.writeFileSync(scriptPath, script, "utf8");

  // 2) 合并 hooks.json
  const cfg = readHooks(codexHome) ?? {};
  cfg.hooks = cfg.hooks ?? {};
  const stops = Array.isArray(cfg.hooks.Stop) ? cfg.hooks.Stop : [];
  const kept = stops.filter((e) => !isOurs(e));
  const entry = {
    matcher: "",
    hooks: [{ type: "command", command: `node "${scriptPath}"`, marker: MARKER }],
  };
  cfg.hooks.Stop = [...kept, entry];
  const backup = backupFile(hooksPath(codexHome));
  fs.writeFileSync(hooksPath(codexHome), JSON.stringify(cfg, null, 2) + String.fromCharCode(10), "utf8");
  return { installed: true, scriptPath, maxContinues, continuePrompt, backup, hooksFile: hooksPath(codexHome) };
}

/** 卸载：摘掉我们的条目、删脚本与计数状态；hooks.json 变空则删文件 */
export function remove(codexHome) {
  const cfg = readHooks(codexHome);
  let removed = 0;
  if (cfg?.hooks?.Stop) {
    const kept = cfg.hooks.Stop.filter((e) => !isOurs(e));
    removed = cfg.hooks.Stop.length - kept.length;
    cfg.hooks.Stop = kept;
    if (!cfg.hooks.Stop.length) delete cfg.hooks.Stop;
    if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  }
  const backup = backupFile(hooksPath(codexHome));
  if (cfg && Object.keys(cfg).length) fs.writeFileSync(hooksPath(codexHome), JSON.stringify(cfg, null, 2) + String.fromCharCode(10), "utf8");
  else if (fs.existsSync(hooksPath(codexHome))) fs.rmSync(hooksPath(codexHome), { force: true });
  for (const f of [HOOK_SCRIPT_NAME, STATE_NAME]) {
    const p = path.join(codexHome, f);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  return { removed, backup, hooksFile: hooksPath(codexHome) };
}

/** 供测试/调试：直接跑一次 hook 脚本，喂入事件、看输出 */
export function simulate(codexHome, event) {
  const scriptPath = path.join(codexHome, HOOK_SCRIPT_NAME);
  return execFileSync(process.execPath, [scriptPath], { input: JSON.stringify(event), encoding: "utf8" });
}
