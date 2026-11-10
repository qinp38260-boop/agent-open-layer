/**
 * 闸门 v2 的失败语义测试（这些点是 Claude 批评后补的）
 * 重点：宿主对 hook 异常是 fail-open（已实测 6 种异常全放行），
 *       所以闸门自己必须 fail-closed —— 出错就拒绝，绝不输出"放行"。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { install, canary, classify } from "../src/adapter/codex/guard.js";
import { compile } from "../src/core/policy.js";

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

function installTemp(pol = policy) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "oag-v2-"));
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  const policyPath = path.join(base, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(pol, null, 2));
  install({ codexHome: home, policyPath, auditPath: path.join(base, "audit.jsonl") });
  return { base, home, policyPath, script: path.join(home, "oag-guard.mjs") };
}

const feed = (script, payload) => {
  const r = spawnSync(process.execPath, [script], { input: payload, encoding: "utf8", timeout: 15000 });
  try {
    return JSON.parse(r.stdout || "{}");
  } catch {
    return { decision: "invalid-json", raw: r.stdout, stderr: r.stderr };
  }
};

test("fail-closed：事件不是合法 JSON → 必须 block", () => {
  const { script } = installTemp();
  const out = feed(script, "{{{not json");
  assert.equal(out.decision, "block", JSON.stringify(out));
  assert.match(out.reason, /拒绝|自检失败/);
});

test("fail-closed：策略文件被删 → 必须 block（不能当放行）", () => {
  const { script, policyPath } = installTemp();
  fs.rmSync(policyPath, { force: true });
  const out = feed(script, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: "D:/w", tool_input: { command: "echo hi" } }));
  assert.equal(out.decision, "block", JSON.stringify(out));
});

test("fail-closed：策略文件内容损坏 → 必须 block", () => {
  const { script, policyPath } = installTemp();
  fs.writeFileSync(policyPath, "{ broken json");
  const out = feed(script, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: "D:/w", tool_input: { command: "echo hi" } }));
  assert.equal(out.decision, "block", JSON.stringify(out));
});

test("未知工具（非 Bash 且无法归类）→ deny", () => {
  const r = classify({ toolName: "mcp_do_something", command: "", policy, cwd: "D:/w" });
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /未知工具/);
});

test("拒绝消息不再泄露允许目录（避免给 agent 绕行路线图）", () => {
  const { script } = installTemp();
  const out = feed(script, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: "D:/w", tool_input: { command: "Set-Content -Path C:/secret/a.txt -Value x" } }));
  assert.equal(out.decision, "block");
  assert.ok(!out.reason.includes("d:/w"), `不应出现允许目录：${out.reason}`);
});

test("canary：未安装时失败；安装后快测通过", () => {
  const bad = canary({ codexHome: fs.mkdtempSync(path.join(os.tmpdir(), "oag-none-")), fast: true });
  assert.equal(bad.ok, false);

  const { home } = installTemp();
  const ok = canary({ codexHome: home, fast: true });
  assert.equal(ok.ok, true, JSON.stringify(ok.results));
  assert.equal(ok.results.length, 2);
});

test("canary：闸门被改坏（输出恒为 {}）时必须报失败", () => {
  const { home, script } = installTemp();
  fs.writeFileSync(script, 'process.stdout.write("{}");');
  const r = canary({ codexHome: home, fast: true });
  assert.equal(r.ok, false, "闸门失效必须被发现");
  assert.ok(r.results.some((x) => !x.ok && /破坏性/.test(x.name)));
});

test("compile(codex)：必须下发环境变量清洗（密钥不进 agent 的 shell）", () => {
  const c = compile(policy, "codex", { headless: true });
  const toml = c.payload.patch.toml;
  assert.ok(toml["shell_environment_policy.inherit"], "缺 inherit");
  const exclude = JSON.parse(toml["shell_environment_policy.exclude"]);
  assert.ok(exclude.some((p) => p.includes("KEY")), JSON.stringify(exclude));
  assert.ok(exclude.some((p) => p.includes("TOKEN")), JSON.stringify(exclude));
  assert.ok(c.notes.some((n) => n.includes("环境变量")));
});
