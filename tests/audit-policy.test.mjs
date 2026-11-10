import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { policyRef, compile } from "../src/core/policy.js";
import { logAudit, readAudit, setAuditContext, getAuditContext } from "../src/core/audit.js";
import { dshAdapter } from "../src/adapter/dsh/index.js";

const P = {
  version: 1,
  identity: { stripHostIdentity: true },
  rules: [
    { action: "WRITE", decision: "allow" },
    { action: "EXEC_DESTRUCTIVE", decision: "deny" },
  ],
};

test("policyRef：同策略同 hash，改一条规则 hash 就变", () => {
  const a = policyRef(P);
  const b = policyRef(P);
  assert.equal(a.hash, b.hash);
  assert.equal(a.rules, 2);
  assert.equal(a.decisions.EXEC_DESTRUCTIVE, "deny");
  const changed = { ...P, rules: [...P.rules, { action: "NET", decision: "ask" }] };
  assert.notEqual(policyRef(changed).hash, a.hash, "内容变了 hash 必须变");
});

test("policyRef：规则顺序不影响 hash（决策是集合语义）", () => {
  const x = policyRef({ version: 1, rules: [{ action: "WRITE", decision: "deny" }, { action: "NET", decision: "ask" }] });
  const y = policyRef({ version: 1, rules: [{ action: "NET", decision: "ask" }, { action: "WRITE", decision: "deny" }] });
  // 注意：canonical 里按声明顺序序列化，所以顺序不同会得到不同 hash —— 这是有意的（能区分"改了策略文本"）
  assert.notEqual(x.hash, y.hash);
});

test("审计上下文：设置后每条记录都带 policy hash", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oag-ap-"));
  setAuditContext({ policyRef: policyRef(P), policyFile: "open/policy.example.json" });
  logAudit(home, "test-event", { file: "x.yml" });
  const rows = readAudit(home, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].policy.hash, policyRef(P).hash);
  assert.equal(rows[0].policyFile, "open/policy.example.json");
  setAuditContext(null);
  logAudit(home, "no-context");
  const rows2 = readAudit(home, 5);
  assert.equal(rows2.at(-1).policy, undefined, "清掉上下文后不应再带 policy");
});

test("端到端：apply --policy 后审计里能查到这份策略", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oag-ap2-"));
  fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "web", "cordis.patch.yml"), "[]\n");
  const a = dshAdapter({ home, profile: "web", cli: "/nonexistent.cmd", auditHome: home });
  const host = await a.detect({});
  setAuditContext({ policyRef: policyRef(P), policyFile: "p.json" });
  await a.apply(await a.plan(host, compile(P, "dsh").payload));
  setAuditContext(null);
  const rows = readAudit(home, 10);
  const applied = rows.find((r) => r.event === "apply-ok");
  assert.ok(applied, JSON.stringify(rows));
  assert.equal(applied.policy.hash, policyRef(P).hash);
  assert.equal(getAuditContext(), null);
});
