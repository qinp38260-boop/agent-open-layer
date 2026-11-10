#!/usr/bin/env node
/**
 * open-agent-gate CLI (v3)
 *
 *   oag adapters                         列出已注册 adapter
 *   oag status   [--adapter id]          探测宿主 + 显示能力
 *   oag plan     [--adapter id] [--payload '<json>'|file]     dry-run，打印 diff
 *   oag apply    [--adapter id] [--payload ...] [--yes]       备份→锁→原子写→读回→审计
 *   oag revert   [--adapter id] [--yes]
 *   oag verify   [--adapter id] [--payload ...]
 *   oag recover  [--adapter id] [--yes]   发现残留 journal 时用备份还原
 *   oag audit    [n]
 *
 * 全局：--home <path>  --profile <name>  --cli <path>  --dsh-home/--codex-home/--claude-home
 * 退出码：0 成功 / 1 验证失败 / 2 未验证 / 3 宿主或版本 / 4 竞态或锁 / 5 IO / 6 需恢复或块损坏 / 7 回滚失败
 */
import fs from "node:fs";
import path from "node:path";
import { bootstrap, list, get, detectAny } from "../src/adapter/index.js";
import { AdapterError, ErrorCode, exitCodeFor } from "../src/adapter/types.js";
import { readAudit } from "../src/core/audit.js";
import { recover as recoverFile, journalPath } from "../src/core/safe-write.js";

const C = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[90m", b: "\x1b[1m", x: "\x1b[0m" };

const DEFAULT_PAYLOAD = {
  id: "identity",
  body: '- id: system-prompt\n  config:\n    includeHarnessIdentity: false\n    persona: ""\n',
  expect: "includeHarnessIdentity:\\s*false",
};

function argv() {
  const a = process.argv.slice(2);
  const cmd = a[0] ?? "status";
  const opt = { yes: false, profile: "web", adapter: null, payload: null, home: null, cli: null, dshHome: null, codexHome: null, claudeHome: null, n: 20 };
  for (let i = 1; i < a.length; i += 1) {
    const t = a[i];
    if (t === "--yes" || t === "-y") opt.yes = true;
    else if (t === "--profile") opt.profile = a[++i];
    else if (t === "--adapter") opt.adapter = a[++i];
    else if (t === "--payload") opt.payload = a[++i];
    else if (t === "--home") opt.home = a[++i];
    else if (t === "--cli") opt.cli = a[++i];
    else if (t === "--dsh-home") opt.dshHome = a[++i];
    else if (t === "--codex-home") opt.codexHome = a[++i];
    else if (t === "--claude-home") opt.claudeHome = a[++i];
    else if (/^\d+$/.test(t)) opt.n = Number(t);
  }
  return { cmd, opt };
}

function payloadOf(opt) {
  if (!opt.payload) return structuredClone(DEFAULT_PAYLOAD);
  const raw = fs.existsSync(opt.payload) ? fs.readFileSync(opt.payload, "utf8") : opt.payload;
  const p = JSON.parse(raw);
  if (p.expect) p.expect = new RegExp(p.expect, "m");
  return p;
}

function printDiff(before, after) {
  const b = new Set(String(before ?? "").split(/\r?\n/));
  const a = new Set(String(after ?? "").split(/\r?\n/));
  for (const l of String(before ?? "").split(/\r?\n/)) if (!a.has(l)) console.log(`${C.r}- ${l}${C.x}`);
  for (const l of String(after ?? "").split(/\r?\n/)) if (!b.has(l)) console.log(`${C.g}+ ${l}${C.x}`);
}

async function main() {
  const { cmd, opt } = argv();
  bootstrap({ profile: opt.profile, dshHome: opt.dshHome ?? opt.home, dshCli: opt.cli, codexHome: opt.codexHome, claudeHome: opt.claudeHome, auditHome: opt.dshHome ?? opt.codexHome ?? opt.claudeHome ?? null });

  if (cmd === "adapters") {
    console.log(`${C.b}已注册 adapter${C.x}: ${list().join(", ")}`);
    return;
  }
  if (cmd === "audit") {
    const home = opt.dshHome ?? opt.codexHome ?? opt.claudeHome ?? process.env.USERPROFILE;
    const rows = readAudit(home, opt.n);
    if (!rows.length) console.log(`${C.d}（无审计记录：${path.join(home, ".oag", "audit.jsonl")}）${C.x}`);
    for (const r of rows) console.log(`${r.at}  ${String(r.event).padEnd(24)} ${r.file ?? ""}`);
    return;
  }

  const adapter = opt.adapter ? get(opt.adapter) : (await detectAny(process.env)).adapter;
  const host = await adapter.detect(process.env);
  const caps = adapter.capabilities();

  if (cmd === "status") {
    console.log(`${C.b}${adapter.id}${C.x}  version=${host.version}`);
    console.log(`  config : ${host.configPath}`);
    console.log(`  caps   : ${JSON.stringify(caps)}`);
    const j = journalPath(host.configPath);
    if (fs.existsSync(j)) console.log(`  ${C.y}⚠ 有残留 journal，apply 会被拦：${j}${C.x}`);
    return;
  }

  if (cmd === "plan") {
    const plan = await adapter.plan(host, payloadOf(opt));
    console.log(`${C.b}plan${C.x}  ${adapter.id}  changed=${plan.changed}  file=${plan.file}`);
    printDiff(plan.before, plan.after);
    return;
  }

  if (cmd === "apply") {
    const plan = await adapter.plan(host, payloadOf(opt));
    if (!plan.changed) {
      console.log(`${C.g}已是最新，无需写入${C.x}`);
      return;
    }
    console.log(`${C.b}apply${C.x}  ${adapter.id}  file=${plan.file}`);
    printDiff(plan.before, plan.after);
    if (!opt.yes) {
      console.log(`${C.y}dry-run：加 --yes 才写入${C.x}`);
      process.exitCode = 2;
      return;
    }
    const r = await adapter.apply(plan);
    console.log(`${C.g}已写入${C.x}${r.backup ? `  备份: ${r.backup.path}` : ""}`);
    const v = await adapter.verifyHost(host, payloadOf(opt));
    if (v.ok) console.log(`${C.g}verify 通过${C.x}（${v.source ?? "?"}）`);
    else {
      console.log(`${C.y}verify 未通过：${v.reason}${C.x}`);
      process.exitCode = v.skipped ? 2 : 1;
    }
    return;
  }

  if (cmd === "verify") {
    const v = await adapter.verifyHost(host, payloadOf(opt));
    if (v.ok) console.log(`${C.g}通过${C.x}（${v.source ?? "?"}）`);
    else {
      console.log(`${C.y}${v.skipped ? "未验证（不算通过）" : "未通过"}：${v.reason}${C.x}`);
      process.exitCode = v.skipped ? 2 : 1;
    }
    return;
  }

  if (cmd === "revert") {
    if (!opt.yes) {
      console.log(`${C.y}dry-run：加 --yes 才还原${C.x}`);
      process.exitCode = 2;
      return;
    }
    const r = await adapter.revert(host);
    console.log(r.changed ? `${C.g}已还原${C.x}` : `${C.d}无需还原${C.x}`);
    return;
  }

  if (cmd === "recover") {
    const j = journalPath(host.configPath);
    if (!fs.existsSync(j)) {
      console.log(`${C.d}没有残留 journal${C.x}`);
      return;
    }
    if (!opt.yes) {
      console.log(`${C.y}发现 journal：${j}\n加 --yes 执行还原（会用备份覆盖当前文件）${C.x}`);
      process.exitCode = 2;
      return;
    }
    const r = await recoverFile(host.configPath, { home: opt.dshHome ?? opt.codexHome ?? null });
    console.log(`${C.g}已用备份还原${C.x}: ${r.from}`);
    return;
  }

  throw new AdapterError(ErrorCode.CAPABILITY_MISSING, `未知命令：${cmd}`);
}

main().catch((e) => {
  const code = exitCodeFor(e);
  console.error(`${C.r}[${e.code ?? "E_UNKNOWN"}] ${e.message}${C.x}`);
  process.exitCode = code;
});
