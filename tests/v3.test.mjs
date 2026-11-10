import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { codexAdapter } from "../src/adapter/codex/index.js";
import { claudeAdapter } from "../src/adapter/claude/index.js";
import { setTomlKey, getTomlKey, setJsonNamespace } from "../src/core/key-merge.js";
import { acquire, release, lockPath } from "../src/core/lock.js";
import { recover, readJournal, journalPath, readOrNull } from "../src/core/safe-write.js";
import { ErrorCode } from "../src/adapter/types.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("并发锁：第二个进程拿不到锁", () => {
  const dir = tmp("oag-lock-");
  const file = path.join(dir, "cfg.toml");
  const l1 = acquire(file);
  assert.throws(() => acquire(file), (e) => e.code === ErrorCode.RACE);
  release(l1);
  const l2 = acquire(file); // 释放后可再拿
  release(l2);
  assert.equal(fs.existsSync(lockPath(file)), false);
});

test("陈旧锁可接管（超时阈值内不可）", () => {
  const dir = tmp("oag-lock2-");
  const file = path.join(dir, "cfg.toml");
  const l = acquire(file);
  // 伪造一个很旧的锁
  release(l);
  fs.writeFileSync(lockPath(file), JSON.stringify({ pid: 999999, at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }));
  assert.throws(() => acquire(file, { staleMs: 24 * 60 * 60 * 1000 }), (e) => e.code === ErrorCode.RACE);
  const taken = acquire(file, { staleMs: 60 * 1000 });
  assert.equal(taken.stale, false);
  release(taken);
});

test("setTomlKey：原地替换 / 插入到首个 [table] 之前 / 幂等", () => {
  const a = setTomlKey('approval_policy = "on-request"\nmodel = "x"\n', "approval_policy", '"never"');
  assert.match(a, /^approval_policy = "never"$/m);
  assert.equal(getTomlKey(a, "approval_policy"), '"never"');
  const b = setTomlKey('model = "x"\n\n[features]\nfoo = true\n', "approval_policy", '"never"');
  assert.match(b, /approval_policy = "never"\n\n\[features\]/);
  assert.equal(setTomlKey(a, "approval_policy", '"never"'), a, "第二次应完全相同");
});

test("setJsonNamespace：保留其它键 + 幂等 + 非法 JSON 抛错", () => {
  const once = setJsonNamespace('{"permissions":{"allow":["Bash"]}}', "_oag", { x: 1 });
  const parsed = JSON.parse(once);
  assert.deepEqual(parsed.permissions, { allow: ["Bash"] });
  assert.deepEqual(parsed._oag, { x: 1 });
  assert.equal(setJsonNamespace(once, "_oag", { x: 1 }), once, "幂等");
  assert.throws(() => setJsonNamespace("{oops", "_oag", {}), (e) => e.code === ErrorCode.CAPABILITY_MISSING);
});

test("codex adapter：plan→apply→verify 且二次 apply 为 no-op", async () => {
  const home = tmp("oag-codex-");
  const cfg = path.join(home, "config.toml");
  fs.writeFileSync(cfg, '# 用户注释\nmodel = "o3"\n\n[features]\nfoo = true\n');
  const a = codexAdapter({ home, cli: "/nonexistent.cmd" });
  const host = await a.detect({});
  assert.equal(host.configPath, cfg);
  const payload = { id: "c", patch: { toml: { approval_policy: '"never"' } } };

  const p1 = await a.plan(host, payload);
  assert.equal(p1.changed, true);
  await a.apply(p1);
  const text = await readOrNull(cfg);
  assert.match(text, /approval_policy = "never"/);
  assert.match(text, /用户注释/, "用户的注释必须保留");
  assert.equal((await a.verifyHost(host, payload)).ok, true);

  const p2 = await a.plan(host, payload);
  assert.equal(p2.changed, false, "第二次 plan 应为 no-op");
});

test("codex adapter：缺 patch.toml → E_CAPABILITY_MISSING", async () => {
  const home = tmp("oag-codex2-");
  fs.writeFileSync(path.join(home, "config.toml"), "");
  const a = codexAdapter({ home, cli: "/nonexistent.cmd" });
  const host = await a.detect({});
  await assert.rejects(() => a.plan(host, { id: "x" }), (e) => e.code === ErrorCode.CAPABILITY_MISSING);
});

test("claude adapter：JSON 命名空间写入 + revert 保留宿主键", async () => {
  const home = tmp("oag-claude-");
  const cfg = path.join(home, "settings.json");
  fs.writeFileSync(cfg, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2));
  const a = claudeAdapter({ home });
  const host = await a.detect({});
  const payload = { id: "c", patch: { json: { autoContinue: true } } };

  const p = await a.plan(host, payload);
  await a.apply(p);
  const parsed = JSON.parse(await readOrNull(cfg));
  assert.deepEqual(parsed.permissions, { allow: ["Bash(ls)"] });
  assert.equal(parsed._openAgentGate.autoContinue, true);
  assert.equal((await a.verifyHost(host, payload)).ok, true);

  await a.revert(host);
  const after = JSON.parse(await readOrNull(cfg));
  assert.equal(after._openAgentGate, undefined, "命名空间应被移除");
  assert.deepEqual(after.permissions, { allow: ["Bash(ls)"] }, "宿主原键必须保留");
});

test("残留 journal → apply 被拦（E_RECOVER_REQUIRED）；recover 能复原", async () => {
  const dir = tmp("oag-rec-");
  const file = path.join(dir, "cfg.yml");
  fs.writeFileSync(file, "current\n");
  const bak = path.join(dir, "bak.yml");
  fs.writeFileSync(bak, "original\n");
  fs.writeFileSync(journalPath(file), JSON.stringify({ at: new Date().toISOString(), file, backup: { path: bak, hash: "x" }, stage: "backup-done" }));

  const { safeWrite } = await import("../src/core/safe-write.js");
  await assert.rejects(
    () => safeWrite({ file, after: "new\n", baseHash: "deadbeef" }),
    (e) => e.code === ErrorCode.RECOVER_REQUIRED,
  );
  const r = await recover(file, {});
  assert.equal(r.recovered, true);
  assert.equal(await readOrNull(file), "original\n");
  assert.equal(readJournal(file), null, "journal 应被清掉");
});

test("CLI 冒烟：oag status / plan 在临时 DSH home 上可跑", () => {
  const home = tmp("oag-cli-");
  fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "web", "cordis.patch.yml"), "[]\n");
  const bin = path.resolve("bin/oag.js");
  const out = execFileSync(process.execPath, [bin, "status", "--dsh-home", home], { encoding: "utf8" });
  assert.match(out, /dsh/);
  assert.match(out, /cordis\.patch\.yml/);
  const plan = execFileSync(process.execPath, [bin, "plan", "--dsh-home", home], { encoding: "utf8" });
  assert.match(plan, /changed=true/);
});

// —— 本轮新增：codex revert（sidecar state）+ probe ——
import { removeTomlKey } from "../src/core/key-merge.js";

test("removeTomlKey 只删目标键", () => {
  const t = 'a = 1\napproval_policy = "never"\nb = 2\n';
  const r = removeTomlKey(t, "approval_policy");
  assert.ok(!r.includes("approval_policy"));
  assert.ok(r.includes("a = 1") && r.includes("b = 2"));
});

test("codex revert：原本不存在的键被删干净，用户注释与其它键保留", async () => {
  const home = tmp("oag-cx-rev-");
  const cfg = path.join(home, "config.toml");
  const original = '# 用户注释\nmodel = "o3"\n\n[features]\nfoo = true\n';
  fs.writeFileSync(cfg, original);
  const a = codexAdapter({ home, cli: "/nonexistent.cmd" });
  const host = await a.detect({});
  await a.apply(await a.plan(host, { id: "c", patch: { toml: { approval_policy: '"never"' } } }));
  assert.match(await readOrNull(cfg), /approval_policy = "never"/);

  const r = await a.revert(host);
  assert.equal(r.changed, true);
  const back = await readOrNull(cfg);
  assert.equal(back, original, "必须逐字回到原始内容");
  assert.equal(fs.existsSync(`${cfg}.oag-state.json`), false, "state 文件应被清理");
});

test("codex revert：原本就存在的键被还原成旧值", async () => {
  const home = tmp("oag-cx-rev2-");
  const cfg = path.join(home, "config.toml");
  fs.writeFileSync(cfg, 'approval_policy = "on-request"\n');
  const a = codexAdapter({ home, cli: "/nonexistent.cmd" });
  const host = await a.detect({});
  await a.apply(await a.plan(host, { id: "c", patch: { toml: { approval_policy: '"never"' } } }));
  assert.equal((await readOrNull(cfg)).trim(), 'approval_policy = "never"');
  await a.revert(host);
  assert.equal((await readOrNull(cfg)).trim(), 'approval_policy = "on-request"');
});

test("codex revert 没有 state → E_CAPABILITY_MISSING（不瞎猜）", async () => {
  const home = tmp("oag-cx-rev3-");
  fs.writeFileSync(path.join(home, "config.toml"), 'a = 1\n');
  const a = codexAdapter({ home, cli: "/nonexistent.cmd" });
  const host = await a.detect({});
  await assert.rejects(() => a.revert(host), (e) => e.code === ErrorCode.CAPABILITY_MISSING);
});

test("codex probe 无 key → skipped（未验证≠通过）", async () => {
  const home = tmp("oag-cx-probe-");
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "o3"\n');
  const a = codexAdapter({ home, cli: "/nonexistent.cmd" });
  const host = await a.detect({});
  const r = await a.probe(host, { env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /DEEPSEEK_API_KEY/);
});
