/** MCP 工具接入：未声明即拒；声明了才按声明判定（fail-closed） */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { classify, install } from "../src/adapter/codex/guard.js";
import { parseMcpToolName, findMcpDeclaration, judgeMcpCall } from "../src/core/mcp.js";
import { issueSession, sessionsDir } from "../src/core/session.js";

const ROOT = "/srv/agent-work";
const POLICY = {
  version: 1,
  rules: [
    { action: "READ", decision: "allow", scope: { paths: [ROOT + "/**"] } },
    { action: "WRITE", decision: "allow", scope: { paths: [ROOT + "/**"] } },
    { action: "EXEC_SAFE", decision: "allow", scope: {} },
    { action: "NET", decision: "deny", scope: {} },
  ],
  mcp: {
    "files/read_file": { action: "READ", paths: [ROOT + "/**"] },
    "files/write_file": { action: "WRITE", paths: [ROOT + "/**"] },
    "files/globby": { action: "READ" },                       // 故意缺 paths
    "codex_apps/*": { action: "NET", decision: "deny" },
    "harmless/ping": { action: "NET", decision: "allow" },
  },
};

test("工具名解析：mcp__server__tool", () => {
  assert.deepEqual(parseMcpToolName("mcp__ologs__get_profile"), { server: "ologs", tool: "get_profile" });
  assert.deepEqual(parseMcpToolName("mcp__codex_apps__user_messaging__send_message"),
                   { server: "codex_apps", tool: "user_messaging__send_message" });
  assert.equal(parseMcpToolName("Bash"), null);
});

test("未声明的 MCP 工具 → 拒绝（不能因为名字看着无害就放行）", () => {
  const r = judgeMcpCall({ policy: POLICY, toolName: "mcp__secret_stuff__dump_env", targets: [] });
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /未在策略/);
});

test("声明为 READ：目标在范围内放行，越界拒绝", () => {
  const inside = judgeMcpCall({ policy: POLICY, toolName: "mcp__files__read_file", targets: [ROOT + "/a.txt"] });
  assert.equal(inside.decision, "allow", inside.reason);
  const outside = judgeMcpCall({ policy: POLICY, toolName: "mcp__files__read_file", targets: ["/etc/passwd"] });
  assert.equal(outside.decision, "deny");
  assert.match(outside.reason, /越界/);
});

test("声明为 WRITE 但抽不到目标 → 拒绝（无法验证范围）", () => {
  const r = judgeMcpCall({ policy: POLICY, toolName: "mcp__files__write_file", targets: [] });
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /抽不到目标/);
});

test("声明缺 paths 的读写类 → 拒绝", () => {
  const r = judgeMcpCall({ policy: POLICY, toolName: "mcp__files__globby", targets: [ROOT + "/a"] });
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /没给 paths/);
});

test("通配声明 server/* 生效；NET 类按 decision（缺省 deny）", () => {
  const deny = judgeMcpCall({ policy: POLICY, toolName: "mcp__codex_apps__user_messaging__send_message", targets: [] });
  assert.equal(deny.decision, "deny");
  const allow = judgeMcpCall({ policy: POLICY, toolName: "mcp__harmless__ping", targets: [] });
  assert.equal(allow.decision, "allow", allow.reason);
  // 未写 decision 的 NET 默认 deny
  const p2 = { mcp: { "x/y": { action: "NET" } } };
  assert.equal(judgeMcpCall({ policy: p2, toolName: "mcp__x__y" }).decision, "deny");
});

test("classify：MCP 工具走到 mcp 分支，而不是落到'未知工具'", () => {
  const okCall = classify({
    toolName: "mcp__files__read_file", input: { path: ROOT + "/a.txt" }, policy: POLICY, cwd: ROOT,
  });
  assert.equal(okCall.op, "mcp");
  assert.equal(okCall.decision, "allow", okCall.reason);

  const badCall = classify({
    toolName: "mcp__files__read_file", input: { path: "/etc/passwd" }, policy: POLICY, cwd: ROOT,
  });
  assert.equal(badCall.decision, "deny", badCall.reason);
});

/* ---------- 生成脚本一致性（防止内联逻辑与模块漂移） ---------- */
function setupGenerated() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "oag-mcp-"));
  const codexHome = path.join(base, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  const policyPath = path.join(codexHome, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(POLICY, null, 2));
  install({ codexHome, policyPath, auditPath: path.join(base, "audit.jsonl") });
  return { codexHome, policyPath, script: path.join(codexHome, "oag-guard.mjs"), dir: sessionsDir({ policyPath }) };
}

function feedScript(script, ev, sid) {
  const env = { ...process.env };
  if (sid) env.OAG_SESSION = sid; else delete env.OAG_SESSION;
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(ev), encoding: "utf8", env, timeout: 20000 });
  let j = {};
  try { j = JSON.parse(r.stdout || "{}"); } catch {}
  return { decision: j.decision ?? "allow", reason: String(j.reason ?? "") };
}

test("生成脚本：未声明拒 / 声明内放行 / 越界拒（与模块逻辑一致）", () => {
  const { script, dir } = setupGenerated();
  const t = issueSession({ dir, maxDenies: 99, policy: "x" });
  const ev = (name, input) => ({ hook_event_name: "PreToolUse", tool_name: name, cwd: ROOT, tool_input: input });

  const undeclared = feedScript(script, ev("mcp__mystery__do", {}), t.sid);
  assert.equal(undeclared.decision, "block", undeclared.reason);
  assert.match(undeclared.reason, /未在策略/);

  const inside = feedScript(script, ev("mcp__files__read_file", { path: ROOT + "/a.txt" }), t.sid);
  assert.equal(inside.decision, "allow", inside.reason);

  const outside = feedScript(script, ev("mcp__files__read_file", { path: "/etc/passwd" }), t.sid);
  assert.equal(outside.decision, "block");
  assert.match(outside.reason, /越界/);
});
