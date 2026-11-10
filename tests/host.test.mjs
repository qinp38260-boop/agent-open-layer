import test from "node:test";
import assert from "node:assert/strict";
import { profileDir, patchFile, assertProfile } from "../lib/host.js";

const HOME = "D:/fakehome";

test("正常 profile 名字返回 profiles 下的绝对路径", () => {
  const p = profileDir(HOME, "web");
  assert.ok(/profiles[\\/]web$/.test(p), p);
});

test(".. 逃逸被拒", () => {
  assert.throws(() => profileDir(HOME, "../../evil"), (e) => e.code === "BAD_PROFILE");
  assert.throws(() => profileDir(HOME, ".."), (e) => e.code === "BAD_PROFILE");
  assert.throws(() => profileDir(HOME, "."), (e) => e.code === "BAD_PROFILE");
});

test("绝对路径/分隔符/空名被拒", () => {
  assert.throws(() => profileDir(HOME, "C:/Windows"), (e) => e.code === "BAD_PROFILE");
  assert.throws(() => profileDir(HOME, "a/b"), (e) => e.code === "BAD_PROFILE");
  assert.throws(() => profileDir(HOME, ""), (e) => e.code === "BAD_PROFILE");
});

test("patchFile 同样受保护（不能绕到别的目录写 cordis.patch.yml）", () => {
  assert.throws(() => patchFile(HOME, "../../nodepilot"), (e) => e.code === "BAD_PROFILE");
});

test("assertProfile 放行合法名字（含 . _ -）", () => {
  for (const ok of ["web", "desktop", "my_profile", "v1.2", "a-b"]) {
    assert.equal(assertProfile(ok), ok);
  }
});
