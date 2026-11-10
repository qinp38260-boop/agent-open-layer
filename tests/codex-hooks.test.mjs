import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { install, remove, status, simulate, HOOK_SCRIPT_NAME } from "../src/adapter/codex/hooks.js";

const mk = (hooks) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oag-hook-"));
  if (hooks) fs.writeFileSync(path.join(home, "hooks.json"), JSON.stringify(hooks, null, 2));
  return home;
};

test("安装：合并进已有 hooks.json，用户条目一条不少", () => {
  const home = mk({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo user" }] }], SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } });
  const r = install({ codexHome: home, maxContinues: 2 });
  assert.equal(r.installed, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "hooks.json"), "utf8"));
  assert.equal(cfg.hooks.Stop.length, 2, "用户 + 我们");
  assert.ok(JSON.stringify(cfg).includes("echo user"));
  assert.ok(cfg.hooks.SessionStart, "其它事件必须保留");
  assert.equal(fs.existsSync(path.join(home, HOOK_SCRIPT_NAME)), true);
});

test("重复安装幂等（不会叠出两条自己的）", () => {
  const home = mk();
  install({ codexHome: home, maxContinues: 1 });
  install({ codexHome: home, maxContinues: 3 });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "hooks.json"), "utf8"));
  assert.equal(cfg.hooks.Stop.length, 1);
  const script = fs.readFileSync(path.join(home, HOOK_SCRIPT_NAME), "utf8");
  assert.match(script, /const MAX = 3/, "脚本应被更新到最新上限");
});

test("hook 脚本：计数到上限就放行，stop_hook_active 一律放行", () => {
  const home = mk();
  install({ codexHome: home, maxContinues: 2, continuePrompt: "go on" });
  const ev = { session_id: "s1", hook_event_name: "Stop", stop_hook_active: false };
  const o1 = JSON.parse(simulate(home, ev).trim());
  const o2 = JSON.parse(simulate(home, ev).trim());
  const o3 = JSON.parse(simulate(home, ev).trim());
  assert.equal(o1.decision, "block");
  assert.equal(o1.reason, "go on");
  assert.equal(o2.decision, "block");
  assert.equal(o3.decision, undefined, "超过上限必须放行");
  const active = JSON.parse(simulate(home, { ...ev, stop_hook_active: true }).trim());
  assert.equal(active.decision, undefined, "本身已在续跑中 → 放行，防死循环");
});

test("计数按 session 隔离", () => {
  const home = mk();
  install({ codexHome: home, maxContinues: 1 });
  const a = { session_id: "A", stop_hook_active: false };
  const b = { session_id: "B", stop_hook_active: false };
  assert.equal(JSON.parse(simulate(home, a).trim()).decision, "block");
  assert.equal(JSON.parse(simulate(home, a).trim()).decision, undefined, "A 已用完");
  assert.equal(JSON.parse(simulate(home, b).trim()).decision, "block", "B 还有额度");
});

test("卸载：只摘自己的，用户条目保留；再卸一次不报错", () => {
  const home = mk({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo user" }] }] } });
  install({ codexHome: home, maxContinues: 1 });
  const r = remove(home);
  assert.equal(r.removed, 1);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "hooks.json"), "utf8"));
  assert.equal(cfg.hooks.Stop.length, 1);
  assert.ok(JSON.stringify(cfg).includes("echo user"));
  assert.equal(fs.existsSync(path.join(home, HOOK_SCRIPT_NAME)), false);
  const r2 = remove(home);
  assert.equal(r2.removed, 0, "重复卸载应安全");
  assert.equal(status(home).installed, false);
});
