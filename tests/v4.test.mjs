import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitTxn, recoverTxn, txnJournalPath } from "../src/core/txn.js";
import { runWithContinue, defaultShouldContinue, HARD_MAX_CONTINUES } from "../src/core/auto-continue.js";
import { dshAdapter } from "../src/adapter/dsh/index.js";
import { sha256, readOrNull } from "../src/core/safe-write.js";
import { ErrorCode } from "../src/adapter/types.js";

const mk = (n = 2) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oag-txn-"));
  const files = [];
  for (let i = 0; i < n; i += 1) {
    const p = path.join(dir, `cfg${i}.yml`);
    fs.writeFileSync(p, `old${i}\n`);
    files.push({ path: p, after: `new${i}\n`, baseHash: sha256(`old${i}\n`) });
  }
  return { dir, files };
};

test("事务：两个文件一起改成功，journal 清理干净", async () => {
  const { files } = mk(2);
  const r = await commitTxn({ files });
  assert.equal(r.changed, true);
  assert.equal(await readOrNull(files[0].path), "new0\n");
  assert.equal(await readOrNull(files[1].path), "new1\n");
  assert.equal(fs.existsSync(txnJournalPath(files)), false, "journal 应清理");
});

test("事务：任一文件有残留 journal → E_RECOVER_REQUIRED，一个都不改", async () => {
  const { files } = mk(2);
  fs.writeFileSync(`${files[1].path}.oag-journal.json`, "{}");
  await assert.rejects(() => commitTxn({ files }), (e) => e.code === ErrorCode.RECOVER_REQUIRED);
  assert.equal(await readOrNull(files[0].path), "old0\n");
  assert.equal(await readOrNull(files[1].path), "old1\n");
});

test("事务：竞态（plan 后文件被改）→ 全部不动", async () => {
  const { files } = mk(2);
  fs.writeFileSync(files[1].path, "changed-externally\n");
  await assert.rejects(() => commitTxn({ files }), (e) => e.code === ErrorCode.RACE);
  assert.equal(await readOrNull(files[0].path), "old0\n", "第一个文件也不能被改");
});

test("事务：校验失败 → 全量回滚", async () => {
  const { files } = mk(2);
  await assert.rejects(
    () => commitTxn({ files, verifyAll: async () => ({ ok: false, reason: "故意失败" }) }),
    (e) => e.code === ErrorCode.VERIFY_FAILED,
  );
  assert.equal(await readOrNull(files[0].path), "old0\n");
  assert.equal(await readOrNull(files[1].path), "old1\n");
  assert.equal(fs.existsSync(txnJournalPath(files)), false);
});

test("事务：残留 journal 可 recover 全量还原", async () => {
  const { files, dir } = mk(2);
  // 造一个"改了一半"的现场
  const bak0 = path.join(dir, "b0.bak");
  const bak1 = path.join(dir, "b1.bak");
  fs.writeFileSync(bak0, "old0\n");
  fs.writeFileSync(bak1, "old1\n");
  fs.writeFileSync(files[0].path, "new0\n");
  fs.writeFileSync(txnJournalPath(files), JSON.stringify({
    at: new Date().toISOString(),
    files: [
      { path: files[0].path, backup: bak0 },
      { path: files[1].path, backup: bak1 },
    ],
  }));
  const r = await recoverTxn(files, {});
  assert.equal(r.recovered, true);
  assert.equal(await readOrNull(files[0].path), "old0\n");
  assert.equal(await readOrNull(files[1].path), "old1\n");
  assert.equal(fs.existsSync(txnJournalPath(files)), false);
});

test("自动续跑：出现完成标记就停，不浪费轮次", async () => {
  const calls = [];
  const r = await runWithContinue({
    prompt: "go",
    maxContinues: 3,
    runner: async ({ prompt, round }) => {
      calls.push({ prompt, round });
      return { text: round === 0 ? "working on it" : "DONE", sessionId: "s1" };
    },
  });
  assert.equal(calls.length, 2, "第2轮出现 DONE 后应停止");
  assert.equal(r.continues, 1);
  assert.equal(r.sessionId, "s1");
});

test("自动续跑：空回复不续跑；上限硬约束 10", async () => {
  const empty = await runWithContinue({ prompt: "x", maxContinues: 3, runner: async () => ({ text: "" }) });
  assert.equal(empty.rounds.length, 1);

  let n = 0;
  const many = await runWithContinue({ prompt: "x", maxContinues: 999, runner: async () => { n += 1; return { text: "still going" }; } });
  assert.equal(many.rounds.length, HARD_MAX_CONTINUES + 1, "轮数 = 1 + 硬上限");
  assert.ok(n <= HARD_MAX_CONTINUES + 1);
});

test("自动续跑：runner 抛错立即停，不吞错", async () => {
  await assert.rejects(
    () => runWithContinue({ prompt: "x", maxContinues: 2, runner: async () => { throw new Error("boom"); } }),
    (e) => e.code === ErrorCode.WRITE_FAILED && /boom/.test(e.message),
  );
});

test("defaultShouldContinue：完成标记不续、空文本不续", () => {
  assert.equal(defaultShouldContinue({ text: "DONE", round: 1, maxContinues: 3 }), false);
  assert.equal(defaultShouldContinue({ text: "", round: 1, maxContinues: 3 }), false);
  assert.equal(defaultShouldContinue({ text: "still working", round: 1, maxContinues: 3 }), true);
  assert.equal(defaultShouldContinue({ text: "still working", round: 3, maxContinues: 3 }), false, "到上限必须停");
});

test("DSH 行为探针：headless 不可用 → skipped（绝不当通过）", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oag-dp-"));
  fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "web", "cordis.patch.yml"), "[]\n");
  const a = dshAdapter({ home, profile: "web", cli: "/nonexistent.cmd" });
  const host = await a.detect({});
  const r = await a.probe(host, { runner: async () => { throw Object.assign(new Error("boom"), { stderr: "ERR_MODULE_NOT_FOUND profiles/headless/#include" }); } });
  assert.equal(r.skipped, true);
  assert.equal(r.ok, false);
  assert.match(r.reason, /headless profile 不可用/);
});

test("DSH 行为探针：文件真出现 → executed（S3 副作用）", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oag-dp2-"));
  fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "web", "cordis.patch.yml"), "[]\n");
  const a = dshAdapter({ home, profile: "web", cli: "/nonexistent.cmd" });
  const host = await a.detect({});
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "oag-dpw-"));
  const r = await a.probe(host, {
    workDir: work,
    runner: async () => {
      fs.writeFileSync(path.join(work, "canary.txt"), "hello-canary");
      return "done";
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.observed, "executed");
  assert.equal(r.signal, "S3");
});

test("DSH 行为探针：没产物也没拒绝措辞 → inconclusive（不是通过）", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oag-dp3-"));
  fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "web", "cordis.patch.yml"), "[]\n");
  const a = dshAdapter({ home, profile: "web", cli: "/nonexistent.cmd" });
  const host = await a.detect({});
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "oag-dpw2-"));
  const r = await a.probe(host, { workDir: work, runner: async () => "I could not manage to do that." });
  assert.equal(r.ok, false);
  assert.equal(r.observed, "inconclusive");
});
