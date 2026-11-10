import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dshAdapter } from "../src/adapter/dsh/index.js";
import { composeBlock, stripBlock } from "../src/core/managed-block.js";
import { safeWrite, readOrNull, sha256 } from "../src/core/safe-write.js";
import { ErrorCode, exitCodeFor, AdapterError } from "../src/adapter/types.js";

const FRAG = `# 注释被剔除\n- id: system-prompt\n  config:\n    includeHarnessIdentity: false\n`;

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oag-"));
  fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "web", "cordis.patch.yml"), "[]\n");
  return home;
}

test("apply 后重复 apply 是 no-op（不叠块）", async () => {
  const home = tmpHome();
  const a = dshAdapter({ home, profile: "web", cli: "/nonexistent.cmd" });
  const host = await a.detect({});
  const p1 = await a.plan(host, { id: "x", body: FRAG });
  assert.equal(p1.changed, true);
  const r1 = await a.apply(p1);
  assert.equal(r1.changed, true);

  const p2 = await a.plan(host, { id: "x", body: FRAG });
  assert.equal(p2.changed, false, "第二次 plan 应判定无变化");
  const r2 = await a.apply(p2);
  assert.equal(r2.changed, false);

  const text = await readOrNull(host.configPath);
  assert.equal(text.split("# >>> open-agent-gate managed").length, 2, "只应有一个托管块");
});

test("revert 保留用户手写内容", async () => {
  const home = tmpHome();
  const file = path.join(home, "profiles", "web", "cordis.patch.yml");
  fs.writeFileSync(file, "# 我的注释\n- id: mine\n  config: {}\n");
  const a = dshAdapter({ home, profile: "web", cli: "/nonexistent.cmd" });
  const host = await a.detect({});
  await a.apply(await a.plan(host, { id: "x", body: FRAG }));
  assert.ok((await readOrNull(file)).includes("mine"));
  await a.revert(host);
  const after = await readOrNull(file);
  assert.ok(after.includes("mine"), "用户内容必须保留");
  assert.ok(!after.includes("open-agent-gate"), "托管块必须移除");
});

test("BEGIN 无 END → E_MARKER_CORRUPT", () => {
  const broken = "# >>> open-agent-gate managed (do not edit)\n- id: a\n";
  assert.throws(
    () => composeBlock(broken, FRAG, { managedBlock: true, format: "yaml", commentSafe: true }),
    (e) => e.code === ErrorCode.MARKER_CORRUPT,
  );
});

test("JSON 宿主（commentSafe=false）→ E_CAPABILITY_MISSING，不猜", () => {
  assert.throws(
    () => composeBlock("{}", FRAG, { managedBlock: true, format: "json", commentSafe: false }),
    (e) => e.code === ErrorCode.CAPABILITY_MISSING,
  );
});

test("plan 之后文件被外部改动 → apply 抛 E_RACE 且不写盘", async () => {
  const home = tmpHome();
  const file = path.join(home, "profiles", "web", "cordis.patch.yml");
  const a = dshAdapter({ home, profile: "web", cli: "/nonexistent.cmd" });
  const host = await a.detect({});
  const plan = await a.plan(host, { id: "x", body: FRAG });
  fs.writeFileSync(file, "# 外部改动\n[]\n");
  await assert.rejects(() => a.apply(plan), (e) => e.code === ErrorCode.RACE);
  assert.equal(await readOrNull(file), "# 外部改动\n[]\n", "竞态失败必须原样不动");
});

test("verify 失败 → 用备份还原并抛 E_VERIFY_FAILED", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oag-v-")), "cfg.yml");
  fs.writeFileSync(file, "before\n");
  const baseHash = sha256("before\n");
  await assert.rejects(
    () => safeWrite({ file, after: "after\n", baseHash, verify: async () => ({ ok: false, reason: "故意失败" }) }),
    (e) => e.code === ErrorCode.VERIFY_FAILED,
  );
  assert.equal(fs.readFileSync(file, "utf8"), "before\n", "验证失败必须还原");
});

test("verify 跳过 → 退出码 2（未验证≠通过）", async () => {
  const home = tmpHome();
  const a = dshAdapter({ home, profile: "web", cli: "/nonexistent.cmd" });
  const host = await a.detect({});
  await a.apply(await a.plan(host, { id: "x", body: FRAG })); // 先让块真的写进去
  const v = await a.verifyHost(host, { id: "x", body: FRAG }); // 没给 expect → 未验证
  assert.equal(v.ok, false);
  assert.equal(v.skipped, true);
  const err = new AdapterError(ErrorCode.VERIFY_SKIPPED, v.reason);
  assert.equal(exitCodeFor(err), 2);
});

test("profile 名逃逸 → E_PROFILE_INVALID", () => {
  assert.throws(() => dshAdapter({ home: tmpHome(), profile: "../../evil" }), (e) => e.code === ErrorCode.PROFILE_INVALID);
});

test("stripBlock 只认整行标记", () => {
  const text = `# 提到 # >>> open-agent-gate managed (do not edit) 这种字样不算块\n[]\n`;
  const r = stripBlock(text);
  assert.equal(r.had, false);
});
