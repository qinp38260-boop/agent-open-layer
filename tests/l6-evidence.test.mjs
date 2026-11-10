/** L6：只认"真跑过 + 快照可校验"，不认"能力就绪" */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeL6 } from "../src/core/l6-evidence.js";

test("没有快照目录 → config-only", () => {
  const r = judgeL6({ snapshotDir: path.join(os.tmpdir(), "no-such-snap-xyz") });
  assert.equal(r.ok, false);
  assert.equal(r.status, "config-only");
});

test("目录空 → config-only", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "oag-l6-"));
  const r = judgeL6({ snapshotDir: d });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有 bundle/);
});

test("有 bundle 且 git 校验通过 → probe-verified", async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "oag-l6-ok-"));
  const repo = path.join(d, "repo");
  fs.mkdirSync(repo);
  const { spawnSync } = await import("node:child_process");
  const sh = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
  sh(["init", "-q"], repo);
  sh(["config", "user.email", "t@t"], repo);
  sh(["config", "user.name", "t"], repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "x");
  sh(["add", "-A"], repo);
  sh(["commit", "-qm", "init"], repo);
  const snap = path.join(d, "snaps");
  fs.mkdirSync(snap);
  const b = path.join(snap, "pre-run-test.bundle");
  const created = sh(["bundle", "create", b, "HEAD"], repo);
  if (created.status !== 0) return t.skip("git bundle 不可用");
  const r = judgeL6({ snapshotDir: snap });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.status, "probe-verified");
  assert.equal(r.bundleCount, 1);
});
