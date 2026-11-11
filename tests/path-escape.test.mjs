/** 路径逃逸：白名单必须有"归一化 + 折真实路径"两层，否则 startsWith 是被绕过的装饰 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { normPath } from "../src/core/actions.js";
import { classify } from "../src/adapter/codex/guard.js";

const BS = String.fromCharCode(92);
const ROOT = "D:/agent-work";
const POLICY = { rules: [{ action: "WRITE", decision: "allow", scope: { paths: [ROOT + "/**"] } }] };
const canonReal = (x) => {
  let cur = String(x);
  const rest = [];
  for (let i = 0; i < 12; i++) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {}
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    rest.push(path.basename(cur));
    cur = parent;
  }
  return x;
};

/* ---------- 归一化本身 ---------- */
test("normPath：.. 必须被解析（否则 startsWith 判根形同虚设）", () => {
  assert.equal(normPath("D:/agent-work/../Windows/x.dll"), "d:/windows/x.dll");
  assert.equal(normPath("D:/agent-work/a/b/../../../Windows/x.dll"), "d:/windows/x.dll");
  assert.equal(normPath("D:" + BS + "agent-work" + BS + ".." + BS + "Windows" + BS + "x.dll"), "d:/windows/x.dll");
});

test("normPath：\\\\?\\ 设备前缀要被拆掉（Win32 加了它就不折叠 ..）", () => {
  assert.equal(normPath(BS + BS + "?" + BS + "D:" + BS + "agent-work" + BS + ".." + BS + "Windows" + BS + "x.dll"), "d:/windows/x.dll");
  assert.equal(normPath(BS + BS + "." + BS + "D:" + BS + "Windows"), "d:/windows");
});

test("normPath：ADS 流名、尾部点与空格（Win32 会静默丢弃）", () => {
  assert.equal(normPath("D:/agent-work/ok.txt:hidden.exe"), "d:/agent-work/ok.txt");
  assert.equal(normPath("D:/agent-work./x.txt"), "d:/agent-work/x.txt");
  assert.equal(normPath("D:/agent-work/x.txt. "), "d:/agent-work/x.txt");
});

test("normPath：正常路径与根不被误伤", () => {
  assert.equal(normPath("D:/agent-work/ok.txt"), "d:/agent-work/ok.txt");
  assert.equal(normPath("D:/"), "d:");
  assert.equal(normPath("."), ".");
  assert.equal(normPath("D:/a/./b/"), "d:/a/b");
});

/* ---------- 闸门判定 ---------- */
function decide(ev, extra = {}) {
  return classify({ policy: POLICY, cwd: ROOT, ...ev, ...extra });
}

test("apply_patch：路径写在结构化 input 里也必须被抽出来（只读 command 会整条漏判）", () => {
  const bad = decide({
    toolName: "apply_patch",
    input: { input: "*** Begin Patch\n*** Add File: D:/agent-work/../Windows/Temp/e.txt\n+x\n*** End Patch" },
  });
  assert.equal(bad.decision, "deny", bad.reason);
  const good = decide({
    toolName: "apply_patch",
    input: { input: "*** Begin Patch\n*** Add File: D:/agent-work/ok.txt\n+x\n*** End Patch" },
  });
  assert.equal(good.decision, "allow", good.reason);
});

test("shell：.. 穿越必须拦住，根内正常写入必须放行", () => {
  assert.equal(decide({ toolName: "shell", command: "Set-Content -Path D:/agent-work/../Windows/Temp/e.txt -Value hi" }).decision, "deny");
  assert.equal(decide({ toolName: "shell", command: "Set-Content -Path D:/agent-work/ok.txt -Value hi" }).decision, "allow");
});

test("shell：\\\\?\\ 前缀路径要能被识别成目标并拦住", () => {
  const r = decide({
    toolName: "shell",
    command: "Set-Content -Path " + BS + BS + "?" + BS + "D:" + BS + "agent-work" + BS + ".." + BS + "Windows" + BS + "x.txt -Value hi",
  });
  assert.equal(r.decision, "deny", r.reason);
});

test("junction：根内链接指向根外时必须拦住（真实建 junction 验证，建不了则跳过）", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "oag-junc-"));
  const root = path.join(base, "root");
  const out = path.join(base, "outside");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const link = path.join(root, "escape");
  const mk = spawnSync("cmd", ["/c", `mklink /J "${link}" "${out}"`], { encoding: "utf8" });
  if (!fs.existsSync(link)) {
    assert.ok(mk.status !== 0 || true, "环境不支持 junction，跳过");
    return;
  }
  const policy = { rules: [{ action: "WRITE", decision: "allow", scope: { paths: [root + "/**"] } }] };
  const hit = classify({
    toolName: "shell",
    command: `Set-Content -Path ${link}/escaped.txt -Value hi`,
    policy,
    cwd: root,
    canon: canonReal,
  });
  assert.equal(hit.decision, "deny", `junction 逃逸未被拦：${hit.reason}`);
});

test("realpath 折祖先：目标文件不存在时也要折（新建文件是常态）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oag-canon-"));
  const p = path.join(tmp, "no-such-dir", "no-such-file.txt");
  const got = canonReal(p);
  assert.ok(got.toLowerCase().startsWith(fs.realpathSync.native(tmp).toLowerCase()), `折错了：${got}`);
  assert.ok(got.toLowerCase().endsWith("no-such-file.txt"));
});

/* ---------- 同类绕过清单（ESCAPE-TODO.md）实测后固化的几条 ---------- */
import { extractTargets, hasDynamicPath } from "../src/core/actions.js";

test("UNC 管理共享与 \\?\UNC 必须被当成目标（原先抽不出来 → 直接放行）", () => {
  const BS = String.fromCharCode(92);
  const unc = `${BS}${BS}localhost${BS}D$${BS}Windows${BS}x.txt`;
  const exts = extractTargets(`Set-Content -Path ${unc} -Value hi`, "D:/agent-work");
  assert.ok(exts.some((x) => x.includes("localhost")), `没抽到 UNC：${JSON.stringify(exts)}`);
  const r = classify({ toolName: "shell", command: `Set-Content -Path ${unc} -Value hi`, policy: POLICY, cwd: ROOT });
  assert.equal(r.decision, "deny", r.reason);
});

test("UNC 下普通 http URL 不能被误当本地路径", () => {
  const exts = extractTargets("curl https://api.github.com/zen", "D:/agent-work");
  assert.ok(!exts.some((x) => x.startsWith("/localhost") || x.includes("api.github.com")), `URL 被当路径：${JSON.stringify(exts)}`);
});

test("$env / Join-Path 这类运行时拼接：静态判不了就拒（否则等于免检通道）", () => {
  const cmd = "Set-Content -Path (Join-Path $env:USERPROFILE '.." + String.fromCharCode(92) + "Windows" + String.fromCharCode(92) + "x.txt') -Value hi";
  assert.equal(hasDynamicPath(cmd), true);
  const r = classify({ toolName: "shell", command: cmd, policy: POLICY, cwd: ROOT });
  assert.equal(r.decision, "deny", r.reason);
  assert.match(r.reason, /运行时拼接/);
});

test("8.3 短名穿越：靠 .. 解析拦住（短名本身不影响判定）", () => {
  const BS = String.fromCharCode(92);
  const r = classify({
    toolName: "shell",
    command: `Set-Content -Path D:${BS}AGENTW~1${BS}..${BS}Windows${BS}x.txt -Value hi`,
    policy: POLICY, cwd: ROOT,
  });
  assert.equal(r.decision, "deny", r.reason);
});

test("Move-Item 跨根：目标在根外必须拦", () => {
  const r = classify({
    toolName: "shell",
    command: "Move-Item D:/agent-work/a.txt D:/Windows/a.txt",
    policy: POLICY, cwd: ROOT,
  });
  assert.equal(r.decision, "deny", r.reason);
});
