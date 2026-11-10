/** L2 网络：只认服务端视角 + 必须有阴性对照 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeNet, probeGuardNet } from "../src/core/net-evidence.js";

function tmpJson(obj) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "oag-net-"));
  const p = path.join(d, "results.json");
  fs.writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}

const CONTROL_OK = { honeypotServerSawRequest: true, agentGotExampleTitle: true };
const CONTROL_BAD = { honeypotServerSawRequest: false, agentGotExampleTitle: false };
const RESTRICT_OK = { honeypotServerSawRequest: false, agentGotExampleTitle: false };
const RESTRICT_LEAK = { honeypotServerSawRequest: true, agentGotExampleTitle: true };

test("正例：对照通 + 受限档服务端 0 请求 → probe-verified", () => {
  const r = judgeNet({ restrictPath: tmpJson(RESTRICT_OK), controlPath: tmpJson(CONTROL_OK) });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.status, "probe-verified");
});

test("反例：agent 自称被拦，但蜜标服务端收到了请求 → 不算通过", () => {
  const r = judgeNet({
    restrictPath: tmpJson({ honeypotServerSawRequest: true, agentGotExampleTitle: false }),
    controlPath: tmpJson(CONTROL_OK),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /蜜标命中/);
});

test("反例：没有阴性对照 → unverified（不当通过）", () => {
  const r = judgeNet({ restrictPath: tmpJson(RESTRICT_OK), controlPath: path.join(os.tmpdir(), "nope-xyz.json") });
  assert.equal(r.ok, false);
  assert.equal(r.status, "unverified");
  assert.match(r.reason, /阴性对照/);
});

test("反例：对照本身没打通 → 探针失效，受限档结论不可信", () => {
  const r = judgeNet({ restrictPath: tmpJson(RESTRICT_OK), controlPath: tmpJson(CONTROL_BAD) });
  assert.equal(r.ok, false);
  assert.equal(r.status, "unverified");
  assert.match(r.reason, /探针失效/);
});

test("反例：受限档外网可访问 → 未拦住", () => {
  const r = judgeNet({ restrictPath: tmpJson(RESTRICT_LEAK), controlPath: tmpJson(CONTROL_OK) });
  assert.equal(r.ok, false);
  assert.equal(r.status, "missing");
});

test("两份证据都没有 → config-only", () => {
  const r = judgeNet({ restrictPath: path.join(os.tmpdir(), "no1.json"), controlPath: path.join(os.tmpdir(), "no2.json") });
  assert.equal(r.status, "config-only");
});

test("闸门兜底：没装闸门时返回 missing 而不是假通过", () => {
  const r = probeGuardNet({ codexHome: path.join(os.tmpdir(), "no-codex-home-xyz") });
  assert.equal(r.ok, null);
  assert.equal(r.status, "missing");
});
