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
import { doctor } from "../src/core/doctor.js";
import { compile, validatePolicy, decisionTable, coverage, ACTIONS } from "../src/core/policy.js";
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
  const opt = { yes: false, profile: "web", adapter: null, payload: null, policy: null, home: null, cli: null, dshHome: null, codexHome: null, claudeHome: null, n: 20, model: null, keyEnv: null, baseUrl: null, json: false, requireComplete: false };
  for (let i = 1; i < a.length; i += 1) {
    const t = a[i];
    if (t === "--yes" || t === "-y") opt.yes = true;
    else if (t === "--profile") opt.profile = a[++i];
    else if (t === "--adapter") opt.adapter = a[++i];
    else if (t === "--payload") opt.payload = a[++i];
    else if (t === "--home") opt.home = a[++i];
    else if (t === "--cli") opt.cli = a[++i];
    else if (t === "--dsh-cli") opt.dshCli = a[++i];
    else if (t === "--codex-cli") opt.codexCli = a[++i];
    else if (t === "--model") opt.model = a[++i];
    else if (t === "--key-env") opt.keyEnv = a[++i];
    else if (t === "--base-url") opt.baseUrl = a[++i];
    else if (t === "--dsh-home") opt.dshHome = a[++i];
    else if (t === "--codex-home") opt.codexHome = a[++i];
    else if (t === "--claude-home") opt.claudeHome = a[++i];
    else if (t === "--policy") opt.policy = a[++i];
    else if (t === "--json") opt.json = true;
    else if (t === "--require-complete") opt.requireComplete = true;
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
  bootstrap({
    profile: opt.profile,
    dshHome: opt.dshHome ?? opt.home,
    dshCli: opt.adapter === "dsh" ? (opt.cli ?? opt.dshCli) : opt.dshCli,
    codexHome: opt.codexHome,
    codexCli: opt.adapter === "codex" ? (opt.cli ?? opt.codexCli) : opt.codexCli,
    claudeHome: opt.claudeHome,
    auditHome: opt.dshHome ?? opt.codexHome ?? opt.claudeHome ?? null,
  });

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

  if (cmd === "doctor") {
    const adapters = list().map((id) => get(id));
    const rep = await doctor({ adapters, home: opt.dshHome ?? opt.codexHome ?? opt.claudeHome ?? null });
    if (opt.json) {
      console.log(JSON.stringify(rep, null, 2));
    } else {
      console.log(`${C.b}oag doctor${C.x}  ${rep.ok ? `${C.g}健康${C.x}` : `${C.r}有问题${C.x}`}`);
      for (const h of rep.hosts) {
        console.log(`
  ${C.b}${h.id}${C.x} v${h.version}  ${h.configPath ?? ""}`);
        for (const c of h.checks) console.log(`    ${c.ok ? `${C.g}✓${C.x}` : `${C.r}✗${C.x}`} ${c.name.padEnd(16)} ${C.d}${c.detail ?? ""}${C.x}`);
      }
      if (rep.audit?.path) console.log(`
  审计: ${rep.audit.path}${rep.audit.last ? `（最后一条 ${rep.audit.last.event}）` : "（空）"}`);
    }
    process.exitCode = rep.ok ? 0 : 1;
    return;
  }

  if (cmd === "policy") {
    const file = opt.policy ?? "open/policy.example.json";
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    validatePolicy(raw);
    const table = decisionTable(raw);
    console.log(`${C.b}policy${C.x} ${file}`);
    console.log(`  生效决策: ${Object.entries(table).map(([k, v]) => `${k}=${v}`).join("  ") || "(无规则)"}`);
    if (raw.identity?.stripHostIdentity) console.log("  identity: 去掉宿主身份句");
    if (raw.autoContinue?.enabled) console.log(`  autoContinue: 开（maxContinues=${raw.autoContinue.maxContinues ?? 1}）`);
    let incomplete = false;
    for (const id of list()) {
      const c = compile(raw, id);
      const cov = coverage(c);
      if (!cov.complete) incomplete = true;
      console.log(`
  ${C.b}${id}${C.x}  落地=${cov.landed ? "有" : "无"}  完整=${cov.complete ? `${C.g}是${C.x}` : `${C.y}否${C.x}`}`);
      if (c.payload) console.log(`    ${C.d}payload:${C.x} ${JSON.stringify(c.payload).slice(0, 160)}`);
      for (const u of c.unsupported) console.log(`    ${C.y}✗ 做不到${C.x} ${u.action}(${u.decision}) — ${u.reason}`);
      for (const n of c.notes ?? []) console.log(`    ${C.d}备注：${n}${C.x}`);
    }
    process.exitCode = opt.requireComplete && incomplete ? 2 : 0;
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
    let payload;
    if (opt.policy) {
      const rawPolicy = JSON.parse(fs.readFileSync(opt.policy, "utf8"));
      const c = compile(rawPolicy, adapter.id);
      if (!c.payload) {
        console.log(`${C.y}该策略在 ${adapter.id} 上没有可落地部分${C.x}`);
        for (const u of c.unsupported) console.log(`  ✗ ${u.action}(${u.decision}) — ${u.reason}`);
        process.exitCode = 2;
        return;
      }
      payload = c.payload;
      for (const u of c.unsupported) console.log(`${C.y}⚠ 未落地${C.x} ${u.action}(${u.decision}) — ${u.reason}`);
    } else {
      payload = payloadOf(opt);
    }
    const plan = await adapter.plan(host, payload);
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

  if (cmd === "probe") {
    if (typeof adapter.probe !== "function") {
      console.log(`${C.y}${adapter.id} 没有实现 probe（未验证≠通过）${C.x}`);
      process.exitCode = 2;
      return;
    }
    const r = await adapter.probe(host, { model: opt.model ?? undefined, keyEnv: opt.keyEnv ?? undefined, baseUrl: opt.baseUrl ?? undefined });
    console.log(`${C.b}probe${C.x}  ${adapter.id} ${host.version}  skipped=${r.skipped ?? false}`);
    for (const s of r.steps ?? []) console.log(`  ${s.ok ? `${C.g}✓${C.x}` : `${C.r}✗${C.x}`} ${s.name}  ${C.d}${s.detail ?? ""}${C.x}`);
    if (r.skipped) {
      console.log(`${C.y}未执行：${r.reason}${C.x}`);
      process.exitCode = 2;
      return;
    }
    // probe 结果落审计
    const { logAudit } = await import("../src/core/audit.js");
    logAudit(opt.dshHome ?? opt.codexHome ?? null, "probe", { adapter: adapter.id, host: host.version, ok: r.ok, steps: r.steps });
    console.log(r.ok ? `${C.g}probe 通过（宿主自己确认了配置与运行）${C.x}` : `${C.r}probe 未通过${C.x}`);
    process.exitCode = r.ok ? 0 : 1;
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
