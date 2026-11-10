import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePolicy, effectiveDecision, decisionTable, compile, coverage } from "../src/core/policy.js";
import { tomlDuplicateKeys, doctor } from "../src/core/doctor.js";
import { ErrorCode } from "../src/adapter/types.js";
import { dshAdapter } from "../src/adapter/dsh/index.js";
import { codexAdapter } from "../src/adapter/codex/index.js";
import { claudeAdapter } from "../src/adapter/claude/index.js";

const base = () => ({
  version: 1,
  identity: { stripHostIdentity: true },
  rules: [
    { action: "EXEC_SAFE", decision: "allow" },
    { action: "EXEC_DESTRUCTIVE", decision: "deny" },
    { action: "WRITE", decision: "allow" },
  ],
});

test("策略校验：非法 action / decision / 版本都要抛 PROFILE_INVALID", () => {
  assert.throws(() => validatePolicy({ version: 2, rules: [] }), (e) => e.code === ErrorCode.PROFILE_INVALID);
  assert.throws(() => validatePolicy({ version: 1, rules: [{ action: "FLY", decision: "allow" }] }), (e) => e.code === ErrorCode.PROFILE_INVALID);
  assert.throws(() => validatePolicy({ version: 1, rules: [{ action: "WRITE", decision: "maybe" }] }), (e) => e.code === ErrorCode.PROFILE_INVALID);
  assert.equal(validatePolicy(base()), true);
});

test("冲突取最严，与声明顺序无关", () => {
  const a = { version: 1, rules: [{ action: "WRITE", decision: "allow" }, { action: "WRITE", decision: "deny" }] };
  const b = { version: 1, rules: [{ action: "WRITE", decision: "deny" }, { action: "WRITE", decision: "allow" }] };
  assert.equal(effectiveDecision(a, "WRITE"), "deny");
  assert.equal(effectiveDecision(b, "WRITE"), "deny");
  assert.equal(effectiveDecision(a, "NET"), null, "未声明的动作应为 null（走宿主默认）");
});

test("决策表只包含声明过的动作", () => {
  const t = decisionTable(base());
  assert.deepEqual(Object.keys(t).sort(), ["EXEC_DESTRUCTIVE", "EXEC_SAFE", "WRITE"]);
  assert.equal(t.EXEC_DESTRUCTIVE, "deny");
});

test("compile → dsh：只落地 identity，其余明确 unsupported（不静默丢）", () => {
  const c = compile(base(), "dsh");
  assert.ok(c.payload.body.includes("includeHarnessIdentity: false"));
  const actions = c.unsupported.map((u) => u.action).sort();
  assert.deepEqual(actions, ["EXEC_DESTRUCTIVE", "EXEC_SAFE", "WRITE"]);
  assert.equal(coverage(c).complete, false);
});

test("compile → codex：allow→approval_policy=never，ask→on-request", () => {
  const allowAll = { version: 1, rules: [{ action: "EXEC_SAFE", decision: "allow" }] };
  assert.equal(compile(allowAll, "codex").payload.patch.toml.approval_policy, '"never"');
  const askAll = { version: 1, rules: [{ action: "EXEC_SAFE", decision: "ask" }] };
  assert.equal(compile(askAll, "codex").payload.patch.toml.approval_policy, '"on-request"');
});

test("compile → codex：READ/WRITE deny 落到 sandbox read-only", () => {
  const p = { version: 1, rules: [{ action: "WRITE", decision: "deny" }] };
  assert.equal(compile(p, "codex").payload.patch.toml.sandbox_mode, '"read-only"');
});

test("compile → claude-code：键语义未取证 → 全部 unsupported，不落盘", () => {
  const c = compile(base(), "claude-code");
  assert.equal(c.payload, null);
  assert.ok(c.unsupported.length >= 3);
  assert.ok(c.unsupported.every((u) => typeof u.reason === "string" && u.reason.length > 5));
  assert.ok(c.unsupported.some((u) => u.action === "IDENTITY"));
});

test("tomlDuplicateKeys 能抓到重复顶层键", () => {
  assert.deepEqual(tomlDuplicateKeys('a = 1\na = 2\n[t]\na = 3\n'), ["a"]);
  assert.deepEqual(tomlDuplicateKeys('a = 1\n[t]\nb = 2\n'), []);
});

test("doctor：健康环境全绿；有 journal 残留则报 fail", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oag-doc-"));
  fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
  const cfg = path.join(home, "profiles", "web", "cordis.patch.yml");
  fs.writeFileSync(cfg, "[]\n");
  const adapters = [dshAdapter({ home, profile: "web", cli: "/nonexistent.cmd" })];
  const ok = await doctor({ adapters, home });
  assert.equal(ok.ok, true, JSON.stringify(ok.failed));

  fs.writeFileSync(`${cfg}.oag-journal.json`, JSON.stringify({ backup: { path: "x" } }));
  const bad = await doctor({ adapters, home });
  assert.equal(bad.ok, false);
  assert.ok(bad.failed.includes("dsh:leftovers"));
});

test("doctor：codex 重复键 + claude JSON 坏了都能被抓到", async () => {
  const ch = fs.mkdtempSync(path.join(os.tmpdir(), "oag-doc2-"));
  fs.writeFileSync(path.join(ch, "config.toml"), 'a = 1\na = 2\n');
  const dh = fs.mkdtempSync(path.join(os.tmpdir(), "oag-doc3-"));
  fs.writeFileSync(path.join(dh, "settings.json"), "{oops");
  const adapters = [codexAdapter({ home: ch, cli: "/nonexistent.cmd" }), claudeAdapter({ home: dh })];
  const r = await doctor({ adapters, home: null });
  assert.equal(r.ok, false);
  assert.ok(r.failed.some((f) => f.startsWith("codex:config-parsable")));
  assert.ok(r.failed.some((f) => f.startsWith("claude-code:config-parsable")));
});

test("回归：策略引擎给的字符串 expect 也能被 dsh verifyHost 使用（不能要求 RegExp）", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oag-exp-"));
  fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
  const cfg = path.join(home, "profiles", "web", "cordis.patch.yml");
  fs.writeFileSync(cfg, "[]\n");
  const a = dshAdapter({ home, profile: "web", cli: "/nonexistent.cmd" });
  const host = await a.detect({});
  const compiled = compile({ version: 1, identity: { stripHostIdentity: true }, rules: [] }, "dsh");
  assert.equal(typeof compiled.payload.expect, "string", "策略编译产出的是字符串");
  await a.apply(await a.plan(host, compiled.payload));
  const v = await a.verifyHost(host, compiled.payload);
  // CLI 跑不动 → skipped（不算通过），但绝不能因为 expect 是字符串就抛 TypeError
  assert.equal(v.ok, false);
  assert.match(v.reason, /宿主 CLI 跑不动|未体现断言/);
  assert.ok(!/is not a function/.test(v.reason), "不能出现 TypeError 文案");
});

test("回归：非默认 home 的 dsh verifyHost 必须 skipped（不能拿别的目录冒充读回）", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oag-hm-"));
  fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "web", "cordis.patch.yml"), "[]\n");
  const a = dshAdapter({ home, profile: "web", cli: "/nonexistent.cmd" });
  const host = await a.detect({});
  const compiled = compile({ version: 1, identity: { stripHostIdentity: true }, rules: [] }, "dsh");
  await a.apply(await a.plan(host, compiled.payload));
  const v = await a.verifyHost(host, compiled.payload);
  assert.equal(v.skipped, true);
  assert.match(v.reason, /非宿主默认 home/);
});
