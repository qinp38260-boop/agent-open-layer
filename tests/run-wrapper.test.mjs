import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { baseline, diffBaseline, watchList, runWatched } from "../src/core/run-wrapper.js";

test("基线：文件改动/创建/删除都能被发现", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oag-run-"));
  const a = path.join(dir, "a.txt");
  fs.writeFileSync(a, "1");
  const base = baseline([a, path.join(dir, "new.txt")]);
  fs.writeFileSync(a, "2");
  fs.writeFileSync(path.join(dir, "new.txt"), "x");
  const changes = diffBaseline(base);
  assert.equal(changes.length, 2);
  assert.ok(changes.some((c) => c.kind === "modified"));
  assert.ok(changes.some((c) => c.kind === "created"));
});

test("watchList 包含闸门文件与配置即代码", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oag-watch-"));
  fs.mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n");
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  const list = watchList({ cwd: dir, codexHome: path.join(dir, ".codex"), policyPath: path.join(dir, "p.json") });
  assert.ok(list.some((p) => p.endsWith("package.json")));
  assert.ok(list.some((p) => p.endsWith(".git") + path.sep + "config" || p.endsWith(".git/config") || p.includes("hooks")));
  assert.ok(list.some((p) => p.endsWith("hooks.json")));
});

test("运行期间改了被监控文件 → tainted，且退出码可收紧", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oag-run2-"));
  const target = path.join(dir, "package.json");
  fs.writeFileSync(target, "{}");
  const node = process.execPath;
  // 子进程改文件（模拟"配置即代码被写"）
  const r = runWatched({
    argv: [node, "-e", `require("fs").writeFileSync(${JSON.stringify(target)}, "{\\"x\\":1}")`],
    cwd: dir,
    watch: watchList({ cwd: dir, codexHome: path.join(dir, ".codex") }),
    failOnTaint: true,
  });
  assert.equal(r.tainted, true, JSON.stringify(r.changes));
  assert.equal(r.code, 11, "failOnTaint 应把退出码改成 11");
});

test("canary 不通过 → 不开跑（退出码 10）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oag-run3-"));
  const marker = path.join(dir, "should-not-exist.txt");
  const r = runWatched({
    argv: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
    cwd: dir,
    watch: [],
    canaryFn: () => ({ ok: false, results: [] }),
  });
  assert.equal(r.code, 10);
  assert.equal(fs.existsSync(marker), false, "canary 失败时不得执行子命令");
});

test("未被改动时 tainted=false", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oag-run4-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  const r = runWatched({
    argv: [process.execPath, "-e", "process.exit(0)"],
    cwd: dir,
    watch: watchList({ cwd: dir, codexHome: path.join(dir, ".codex") }),
  });
  assert.equal(r.tainted, false);
  assert.equal(r.code, 0);
});
