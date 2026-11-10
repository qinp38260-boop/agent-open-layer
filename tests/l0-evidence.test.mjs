/** L0 验收证据判定：只认"以目标身份跑出来、且敏感项被拒"的文件 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeL0, parseEvidence } from "../src/core/l0-evidence.js";

const GOOD = `=== identity ===
whoami: PC\agent_runner
isAdmin: False

write D:\work\l0-ok.txt : ALLOWED
read hermes_data\.env : BLOCKED :: UnauthorizedAccessException
write C:\Users\p1553_x.txt : BLOCKED :: UnauthorizedAccessException
list C:\Users\p1553\.ssh : BLOCKED :: UnauthorizedAccessException
write C:\Windows_x.txt : BLOCKED :: UnauthorizedAccessException

summary: ...
`;

function tmp(content) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oag-l0-")), "r.txt");
  fs.writeFileSync(p, content, "utf8");
  return p;
}

test("正例：目标身份 + 工作区可写 + 敏感项全拒 → 通过", () => {
  const r = judgeL0({ evidencePath: tmp(GOOD), account: "agent_runner" });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.status, "probe-verified");
  assert.equal(r.allowed.length, 1);
  assert.ok(r.blocked.length >= 4);
});

test("反例：不是目标账号跑的 → 不通过（哪怕结果看起来对）", () => {
  const r = judgeL0({ evidencePath: tmp(GOOD.replace("agent_runner", "p1553")), account: "agent_runner" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不是目标账号|whoami/);
});

test("反例：沙箱账号是管理员 → 不通过", () => {
  const r = judgeL0({ evidencePath: tmp(GOOD.replace("isAdmin: False", "isAdmin: True")), account: "agent_runner" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /管理员/);
});

test("反例：敏感项没被拦住 → 不通过", () => {
  const bad = GOOD.replace("read hermes_data\.env : BLOCKED", "read hermes_data\.env : ALLOWED");
  const r = judgeL0({ evidencePath: tmp(bad), account: "agent_runner" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /\.env|敏感项/);
});

test("反例：工作区写也失败 → 沙箱账号没法干活，不通过", () => {
  const bad = GOOD.replace("write D:\work\l0-ok.txt : ALLOWED", "write D:\work\l0-ok.txt : BLOCKED");
  const r = judgeL0({ evidencePath: tmp(bad), account: "agent_runner" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /工作目录写/);
});

test("证据文件不存在 → missing（不是通过）", () => {
  const r = judgeL0({ evidencePath: path.join(os.tmpdir(), "definitely-not-here-xyz.txt") });
  assert.equal(r.ok, false);
  assert.equal(r.status, "missing");
});

test("解析：BOM 和 CRLF 都能处理", () => {
  const p = tmp("\uFEFFwhoami: PC\agent_runner\r\nisAdmin: False\r\nread .env : BLOCKED\r\n");
  const r = judgeL0({ evidencePath: p, account: "agent_runner" });
  assert.equal(r.whoami, "PC\agent_runner");
  assert.equal(parseEvidence("\uFEFFx").whoami, "");
});
