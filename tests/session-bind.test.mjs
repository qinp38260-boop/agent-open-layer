/** 会话强绑定（OAG_BIND）+ 越界熔断：不带票据就什么都干不了 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { install } from "../src/adapter/codex/guard.js";
import { issueSession, readSession, tickDeny, clearSession, sessionsDir } from "../src/core/session.js";
import { runWatched } from "../src/core/run-wrapper.js";

const POLICY = (root) => ({
  version: 1,
  rules: [
    { action: "WRITE", decision: "allow", scope: { paths: [root + "/**"] } },
    { action: "READ", decision: "allow", scope: { paths: [root + "/**"] } },
    { action: "EXEC_SAFE", decision: "allow", scope: {} },
    { action: "EXEC_DESTRUCTIVE", decision: "deny", scope: {} },
    { action: "NET", decision: "deny", scope: {} },
  ],
});

function setup({ maxDenies = 3 } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "oag-bind-"));
  const codexHome = path.join(base, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  const root = path.join(base, "work");
  fs.mkdirSync(root, { recursive: true });
  const policyPath = path.join(codexHome, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(POLICY(root), null, 2));
  install({ codexHome, policyPath, auditPath: path.join(base, "audit.jsonl") });
  const script = path.join(codexHome, "oag-guard.mjs");
  const dir = sessionsDir({ policyPath });
  return { base, codexHome, root, policyPath, script, dir, maxDenies };
}

function feed(script, ev, sid) {
  const env = { ...process.env };
  delete env.OAG_SESSION;
  if (sid) env.OAG_SESSION = sid;
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(ev), encoding: "utf8", env, timeout: 20000 });
  let j = {};
  try { j = JSON.parse(r.stdout || "{}"); } catch {}
  return { decision: j.decision ?? "allow", reason: j.reason ?? "" };
}

const inRoot = (root) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: root, tool_input: { command: `Set-Content -Path ${root}/ok.txt -Value hi` } });
const escape = (root) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: root, tool_input: { command: `Set-Content -Path ${root}/../outside.txt -Value hi` } });

test("没有票据（裸跑宿主）→ 一切动作都被拒", () => {
  const { script, root } = setup();
  const r = feed(script, inRoot(root), null);
  assert.equal(r.decision, "block", r.reason);
  assert.match(r.reason, /OAG_BIND/);
});

test("伪造票据（sid 不存在）→ 拒", () => {
  const { script, root } = setup();
  const r = feed(script, inRoot(root), "fake-sid");
  assert.equal(r.decision, "block");
  assert.match(r.reason, /票据不存在/);
});

test("票据过期 → 拒", () => {
  const { script, root, dir } = setup();
  const t = issueSession({ dir, ttlSec: 1, policy: "x" });
  const f = path.join(dir, t.sid + ".json");
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.startedAt = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(f, JSON.stringify(j));
  const r = feed(script, inRoot(root), t.sid);
  assert.equal(r.decision, "block");
  assert.match(r.reason, /过期/);
});

test("有效票据 + 根内 → 放行", () => {
  const { script, root, dir } = setup();
  const t = issueSession({ dir, policy: "x" });
  const r = feed(script, inRoot(root), t.sid);
  assert.equal(r.decision, "allow", r.reason);
});

test("越界达到上限 → 冻结；冻结后连合法动作也拒", () => {
  const { script, root, dir } = setup({ maxDenies: 3 });
  const t = issueSession({ dir, policy: "x", maxDenies: 3 });
  for (let i = 1; i <= 3; i++) {
    const r = feed(script, escape(root), t.sid);
    assert.equal(r.decision, "block");
    if (i === 3) assert.match(r.reason, /熔断/);
  }
  const after = readSession(dir, t.sid);
  assert.equal(after.frozen, true);
  const legit = feed(script, inRoot(root), t.sid);
  assert.equal(legit.decision, "block");
  assert.match(legit.reason, /已冻结/);
});

test("wrapper：会话被冻结后必须杀掉子进程（退出码 13）", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "oag-kill-"));
  const child = path.join(base, "sleep.mjs");
  fs.writeFileSync(child, "setTimeout(() => process.exit(0), 30000);");
  const t0 = Date.now();
  const r = await runWatched({
    argv: [process.execPath, child],
    cwd: base,
    watch: [],
    canaryFn: null,
    isFrozen: () => Date.now() - t0 > 1200,
    pollMs: 200,
  });
  assert.equal(r.code, 13, `期望 13，实际 ${r.code}`);
  assert.equal(r.frozen, true);
  assert.ok(Date.now() - t0 < 15000, "没有及时杀掉");
});
