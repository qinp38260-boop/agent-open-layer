#!/usr/bin/env node
/**
 * 闸门外壳（fail-closed shim）
 *
 * 存在理由（实测）：Codex 0.167.0 对 hook 的任何故障都是 fail-open ——
 * 崩溃 / 乱输出 / 空输出 / 退出码 2 / 退出码 2+stderr / 超时 / 缺 decision，
 * 7 种情况实测全部放行（scripts/hook-failopen-probe.mjs 可复现，含两个对照）。
 * 宿主没有能改成"失败即拦"的配置项，所以只能在 hook 外面套一层：
 * 只要被包裹的闸门没能给出明确的 decision，本外壳就自己输出 block。
 *
 * 用法（hooks.json 的 command）：
 *   node "<codexHome>/oag-shim.mjs" "<codexHome>/oag-guard.mjs"
 *
 * 覆盖范围与边界（别夸大）：
 *   覆盖：闸门崩溃/超时被杀/抛异常/输出坏 JSON/输出空/自己忘了给 decision
 *   不覆盖：hooks.json 被删改、hook 信任被关、宿主根本不调用 hook —— 那是"闸门不在"，
 *          只能靠 ACL（L0）+ canary 预检 + 审计断档发现
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const target = process.argv[2];
const TIMEOUT_MS = Number(process.argv[3] || 6000); // 必须小于宿主 hook.timeout_sec

function block(why) {
  // 宿主认这个格式：decision=block + reason
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: `OAG_SHIM 拒绝（闸门未能确认放行）：${why}`,
    })
  );
  process.exit(0);
}

let payload = "";
try {
  payload = readFileSync(0, "utf8");
} catch (e) {
  block(`读不到事件体：${e && e.message}`);
}

if (!target) block("没有指定闸门脚本路径");

const r = spawnSync(process.execPath, [target], {
  input: payload,
  encoding: "utf8",
  timeout: TIMEOUT_MS,
});

if (r.error) block(`闸门没能运行：${r.error.code || r.error.message}`);
if (r.status !== 0) block(`闸门退出码 ${r.status}${r.stderr ? "：" + String(r.stderr).slice(0, 120) : ""}`);

const out = String(r.stdout || "").trim();
if (!out) block("闸门输出为空");
let j;
try {
  j = JSON.parse(out);
} catch {
  block(`闸门输出不是 JSON：${out.slice(0, 80)}`);
}
if (!j || typeof j !== "object" || Array.isArray(j)) block("闸门输出不是 JSON 对象");

// 宿主的约定：`{}`（空对象）= 不反对，照常执行。这是真闸门"放行"时的实际输出形状，
// 早先这里要求必须有 decision 字段，会把所有放行也拦掉 —— 实测踩到（见 e2e 用例 1）。
if (Object.keys(j).length === 0) {
  process.stdout.write("{}");
  process.exit(0);
}
if (!("decision" in j)) block(`闸门给了对象但没 decision：${out.slice(0, 60)}`);

process.stdout.write(out); // 原样转发闸门的判断
