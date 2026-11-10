/** Claude Code 侧闸门：同一套意图判定，换的是工具名映射 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { install, status, remove } from "../src/adapter/claude/hooks.js";

const policy = {
  version: 1,
  rules: [
    { action: "READ", decision: "allow", scope: { paths: ["D:/w/**"] } },
    { action: "WRITE", decision: "allow", scope: { paths: ["D:/w/**"] } },
    { action: "EXEC_SAFE", decision: "allow", scope: {} },
    { action: "EXEC_DESTRUCTIVE", decision: "deny", scope: {} },
    { action: "EXEC_INSTALL", decision: "ask", scope: {} },
    { action: "EXEC_GIT_WRITE", decision: "ask", scope: {} },
    { action: "NET", decision: "deny", scope: {} },
  ],
};

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "oag-cc-"));
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  const policyPath = path.join(base, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2));
  install({ claudeHome: home, policyPath, auditPath: path.join(base, "audit.jsonl") });
  return { base, home, script: path.join(home, "oag-guard-claude.mjs") };
}

const run = (script, ev) => {
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(ev), encoding: "utf8", timeout: 15000 });
  let out = {};
  try {
    out = JSON.parse(r.stdout || "{}");
  } catch {
    out = { decision: "invalid" };
  }
  return { ...out, exitCode: r.status, raw: r.stdout };
};

test("Bash 破坏性 → block；普通 → allow", () => {
  const { script } = setup();
  assert.equal(run(script, { tool_name: "Bash", tool_input: { command: "rm -rf D:/w/x" }, cwd: "D:/w" }).decision, "block");
  assert.equal(run(script, { tool_name: "Bash", tool_input: { command: "echo hi" }, cwd: "D:/w" }).decision, undefined);
});

test("Write/Edit 越界 → block；目录内 → allow", () => {
  const { script } = setup();
  assert.equal(run(script, { tool_name: "Write", tool_input: { file_path: "C:/secret/a" }, cwd: "D:/w" }).decision, "block");
  assert.equal(run(script, { tool_name: "Edit", tool_input: { file_path: "C:/secret/a" }, cwd: "D:/w" }).decision, "block");
  assert.equal(run(script, { tool_name: "Write", tool_input: { file_path: "D:/w/a" }, cwd: "D:/w" }).decision, undefined);
});

test("Read 越界（.env）→ block", () => {
  const { script } = setup();
  assert.equal(run(script, { tool_name: "Read", tool_input: { file_path: "D:/Programs/hermes_data/.env" }, cwd: "D:/w" }).decision, "block");
});

test("WebFetch → NET deny", () => {
  const { script } = setup();
  assert.equal(run(script, { tool_name: "WebFetch", tool_input: {}, cwd: "D:/w" }).decision, "block");
});

test("未知工具 → 默认拒绝", () => {
  const { script } = setup();
  const out = run(script, { tool_name: "mcp_do_sql", tool_input: {}, cwd: "D:/w" });
  assert.equal(out.decision, "block");
  assert.match(out.reason, /未知工具/);
});

test("策略被删 → fail-closed block", () => {
  const { script, base } = setup();
  fs.rmSync(path.join(base, "policy.json"), { force: true });
  assert.equal(run(script, { tool_name: "Bash", tool_input: { command: "echo hi" }, cwd: "D:/w" }).decision, "block");
});

test("安装/状态/卸载：保留用户已有 hook", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "oag-cc2-"));
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  const settings = path.join(home, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user" }] }] }, theme: "dark" }, null, 2));
  const policyPath = path.join(base, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2));

  install({ claudeHome: home, policyPath, auditPath: path.join(base, "audit.jsonl") });
  let cfg = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(cfg.hooks.PreToolUse.length, 2, "用户条目 + 我们");
  assert.equal(cfg.theme, "dark");
  assert.equal(status(home).installed, true);

  remove(home);
  cfg = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(cfg.hooks.PreToolUse.length, 1);
  assert.equal(status(home).installed, false);
});

test("拒绝时必须 exit 2 + 新格式（Claude 只有 exit 2 算阻断，其它非零是 fail-open）", () => {
  const { script } = setup();
  const out = run(script, { tool_name: "Bash", tool_input: { command: "rm -rf D:/w/x" }, cwd: "D:/w" });
  assert.equal(out.exitCode, 2, "必须 exit 2");
  assert.equal(out.hookSpecificOutput?.permissionDecision, "deny", "必须用新格式");
  assert.ok(out.hookSpecificOutput?.permissionDecisionReason, "必须带原因");
  assert.equal(out.decision, "block", "旧格式同时保留");
});

test("放行时必须 exit 0 且不输出 allow", () => {
  const { script } = setup();
  const out = run(script, { tool_name: "Bash", tool_input: { command: "echo hi" }, cwd: "D:/w" });
  assert.equal(out.exitCode, 0);
  assert.equal(out.decision, undefined, "不得输出 allow/decision");
});

test("良性工具放行（避免未知工具 deny 误杀）", () => {
  const { script } = setup();
  for (const t of ["TodoWrite", "ExitPlanMode"]) {
    const out = run(script, { tool_name: t, tool_input: {}, cwd: "D:/w" });
    assert.equal(out.exitCode, 0, t);
    assert.equal(out.decision, undefined, t);
  }
});

test("Task（子 agent）= spawn_host → 拒绝", () => {
  const { script } = setup();
  const out = run(script, { tool_name: "Task", tool_input: {}, cwd: "D:/w" });
  assert.equal(out.exitCode, 2);
});

test("空输入 → 拒绝（exit 2）", () => {
  const { script } = setup();
  const r = spawnSync(process.execPath, [script], { input: "", encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 2);
});
