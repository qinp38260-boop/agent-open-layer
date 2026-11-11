#!/usr/bin/env node
/**
 * 假宿主：模拟"一个宿主进程在钩子约束下干活"，用来在**没有模型密钥**的环境里
 * 验证 `oag run` 的会话票据 + 越界熔断 + 杀进程链路。
 *
 * 它做的事就是宿主会做的事：把工具调用事件喂给闸门，看闸门放不放。
 *   ① 根内写 → 期望 allow
 *   ② 越界写 → 期望 block（并给会话记一票）
 *   ③ 之后不停地再试 → 被冻结后 wrapper 应当杀掉本进程
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const arg = (f, d) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};
const GUARD = arg("--guard", "/srv/codex-home/oag-guard.mjs");
const ROOT = arg("--root", "/srv/agent-work");
const SID = process.env.OAG_SESSION ?? "";

function callGuard(toolInput) {
  const ev = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    cwd: ROOT,
    session_id: SID,
    tool_input: toolInput,
  });
  const r = spawnSync(process.execPath, [GUARD], { input: ev, encoding: "utf8", timeout: 20000 });
  let j = {};
  try {
    j = JSON.parse(r.stdout || "{}");
  } catch {}
  return { decision: j.decision ?? "allow", reason: String(j.reason ?? "") };
}

const log = (m) => console.log(`  [fake-host] ${m}`);

log(`session=${SID ? SID.slice(0, 8) : "(无票据)"}  guard=${GUARD}`);

// ① 根内：期望 allow
const inside = callGuard({ command: `touch ${path.join(ROOT, "inside.txt")}` });
log(`① 根内写 → ${inside.decision}`);
if (inside.decision !== "allow") {
  log("根内也被拦了，说明策略/路径有问题，直接退出");
  process.exit(2);
}

// ② 越界：期望 block
const esc = callGuard({ command: `touch ${path.join(ROOT, "..", "outside.txt")}` });
log(`② 越界写 → ${esc.decision}  ${esc.reason.slice(0, 60)}`);
if (esc.decision !== "block") {
  log("越界没被拦住 ← 这是严重问题");
  process.exit(3);
}

// ③ 继续硬试：应当被冻结，然后被 wrapper 杀掉
for (let i = 1; i <= 30; i++) {
  const r = callGuard({ command: `touch ${path.join(ROOT, "..", `try-${i}.txt`)}` });
  log(`③ 第 ${i} 次重试 → ${r.decision}${/冻结/.test(r.reason) ? "（已冻结）" : ""}`);
  await new Promise((res) => setTimeout(res, 600));
}
log("30 次重试都没被杀 ← wrapper 的熔断处置失效");
process.exit(4);
