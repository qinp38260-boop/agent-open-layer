#!/usr/bin/env node
/**
 * dsh-open CLI
 *   status                    宿主版本 / 装没装 / 托管块是否一致
 *   plan                      只打印将要写入的 diff（默认 dry-run）
 *   apply [--yes]             备份 → 写托管块 → 审计 → verify
 *   revert [--yes]            移除托管块（用户自己写的内容不动）
 *   verify                    dsh --dump-config 实证 policy=never
 *   audit [n]                 最近 n 条审计
 *
 * 全局参数：--home <path>  --profile <name>  --dsh-cli <path>  --fragment <yml>
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dshHome, hostVersion, patchFile, profileDir, assertProfile } from "../lib/host.js";
import { BEGIN, END, VERSION_TAG, compose, stripBlock, blockBody, backup, writeAtomic, readFileOr } from "../lib/patchfile.js";
import { logAudit, readAudit } from "../lib/audit.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argv() {
  const a = process.argv.slice(2);
  const cmd = a[0] || "status";
  const opt = { yes: false, profile: "web", home: null, dshCli: null, fragment: null, n: 20 };
  for (let i = 1; i < a.length; i += 1) {
    const t = a[i];
    if (t === "--yes" || t === "-y") opt.yes = true;
    else if (t === "--profile") opt.profile = a[++i];
    else if (t === "--home") opt.home = a[++i];
    else if (t === "--dsh-cli") opt.dshCli = a[++i];
    else if (t === "--fragment") opt.fragment = a[++i];
    else if (/^\d+$/.test(t)) opt.n = Number(t);
  }
  return { cmd, opt };
}

const C = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[90m", b: "\x1b[1m", x: "\x1b[0m" };

function printDiff(before, after) {
  const b = new Set(before.split(/\r?\n/));
  const a = new Set(after.split(/\r?\n/));
  for (const line of before.split(/\r?\n/)) if (!a.has(line)) console.log(`${C.r}- ${line}${C.x}`);
  for (const line of after.split(/\r?\n/)) if (!b.has(line)) console.log(`${C.g}+ ${line}${C.x}`);
}

function fragmentText(opt) {
  const p = opt.fragment || path.join(ROOT, "open", "dsh-open.patch.yml");
  const text = readFileOr(p, null);
  if (text === null) throw new Error(`fragment 不存在: ${p}`);
  return text;
}

const PROFILE_RE = /^[A-Za-z0-9._-]+$/;

function verify(opt, home) {
  const cli = opt.dshCli || process.env.DSH_OPEN_CLI || "dsh";
  // 修 #1（codex 审查）：profile 会进入命令行，必须白名单校验，否则 cmd 注入
  if (!PROFILE_RE.test(opt.profile)) {
    return { ok: false, skipped: true, reason: `profile 名不合法（只允许 字母数字._-）：${String(opt.profile).slice(0, 40)}` };
  }
  // 修 #2：dsh 本身没有 --home，自定义 home 无法读回 → 明确"不可验证"，绝不假装通过
  const defaultHome = dshHome(null);
  if (path.resolve(home) !== path.resolve(defaultHome)) {
    return { ok: false, skipped: true, reason: `--home 不是宿主默认目录，dsh 无法读回，拒绝给出验证结论` };
  }
  const custom = Boolean(opt.dshCli || process.env.DSH_OPEN_CLI);
  if (custom) {
    // 修 #1 续：自定义 CLI 路径必须真实存在，且不含 shell 元字符
    if (!fs.existsSync(cli)) return { ok: false, skipped: true, reason: `--dsh-cli 不存在：${cli}` };
    if (/["&|<>^]/.test(cli)) return { ok: false, skipped: true, reason: `--dsh-cli 含非法字符` };
  }
  const isCmdScript = /\.(cmd|bat)$/i.test(cli);
  const run = () => {
    const out = execFileSync(cli, ["--profile", opt.profile, "--dump-config"], {
      encoding: "utf8",
      shell: isCmdScript, // 只有 .cmd/.bat 才需要 shell；profile 已白名单校验
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out;
  };
  let out;
  try {
    out = run();
  } catch (e) {
    return { ok: false, reason: `跑不动 dsh（${cli}）：${String(e.message).split("\n")[0]}`, skipped: true };
  }
  const policyNever = /- id: approval\b[\s\S]{0,200}?policy:\s*never/.test(out);
  const noIdentity = /- id: system-prompt\b[\s\S]{0,300}?includeHarnessIdentity:\s*false/.test(out);
  return { ok: policyNever && noIdentity, policyNever, noIdentity, cli };
}

function main() {
  const { cmd, opt } = argv();
  // 修（codex 审查发现）：profile 会拼进文件路径，先硬校验，非法直接退
  try {
    assertProfile(opt.profile);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
  const home = dshHome(opt.home);
  const host = hostVersion(home);
  const pf = patchFile(home, opt.profile);
  const current = readFileOr(pf, "");

  if (cmd === "status") {
    const { had } = stripBlock(current);
    console.log(`${C.b}dsh-open${C.x} ${VERSION_TAG}`);
    console.log(`  home      : ${home}`);
    console.log(`  profile   : ${opt.profile}`);
    console.log(`  patch 文件: ${pf} ${fs.existsSync(pf) ? "" : `${C.y}(不存在)${C.x}`}`);
    console.log(`  宿主版本  : ${host.version} ${C.d}(${host.from || "未探测到"})${C.x}`);
    console.log(`  托管块    : ${had ? `${C.g}已安装${C.x}` : `${C.d}未安装（配置为官方默认）${C.x}`}`);
    if (had) {
      const body = current.slice(current.indexOf(BEGIN), current.indexOf(END));
      console.log(`  内容摘要  : ${body.split(/\r?\n/).filter((l) => /policy|persona|includeHarness/.test(l)).map((l) => l.trim()).join(" | ")}`);
    }
    return;
  }

  if (cmd === "plan") {
    const block = blockBody(fragmentText(opt));
    const { next, mode } = compose(current, block);
    console.log(`${C.b}dsh-open plan${C.x}  home=${home} profile=${opt.profile} 宿主=${host.version}`);
    console.log(`${C.d}模式: ${mode}  →  ${pf}${C.x}\n`);
    printDiff(current, next);
    console.log(`\n${C.d}（dry-run，未写入。要落地：dsh-open apply --yes）${C.x}`);
    return;
  }

  if (cmd === "apply") {
    const block = blockBody(fragmentText(opt));
    const { next, mode } = compose(current, block);
    const same = next.replace(/\s+$/, "") === current.replace(/\s+$/, "");
    if (same) {
      console.log(`${C.g}已是最新，无需写入${C.x}（mode=${mode}）`);
      return;
    }
    console.log(`${C.b}dsh-open apply${C.x}  mode=${mode}  host=${host.version}`);
    printDiff(current, next);
    if (!opt.yes) {
      console.log(`\n${C.y}dry-run：加 --yes 才写入${C.x}`);
      return;
    }
    fs.mkdirSync(profileDir(home, opt.profile), { recursive: true });
    const bak = backup(pf);
    writeAtomic(pf, next);
    logAudit(home, "apply", { profile: opt.profile, mode, host: host.version, backup: bak, file: pf });
    console.log(`${C.g}已写入${C.x}${bak ? `  备份: ${bak}` : ""}`);
    const v = verify(opt, home);
    if (v.skipped) console.log(`${C.y}verify 跳过：${v.reason}${C.x}`);
    else console.log(v.ok ? `${C.g}verify 通过${C.x} policy=never / 无宿主身份句` : `${C.r}verify 未通过${C.x} policyNever=${v.policyNever} noIdentity=${v.noIdentity}`);
    return;
  }

  if (cmd === "revert") {
    const { text: without, had } = stripBlock(current);
    if (!had) {
      console.log(`${C.y}没有托管块，无需还原${C.x}`);
      return;
    }
    const rest = without
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("#"))
      .join("")
      .trim();
    const next = rest === "" ? "[]\n" : without.trimEnd() + "\n";
    console.log(`${C.b}dsh-open revert${C.x}`);
    printDiff(current, next);
    if (!opt.yes) {
      console.log(`\n${C.y}dry-run：加 --yes 才写入${C.x}`);
      return;
    }
    const bak = backup(pf);
    writeAtomic(pf, next);
    logAudit(home, "revert", { profile: opt.profile, backup: bak, file: pf });
    console.log(`${C.g}已还原${C.x}${bak ? `  备份: ${bak}` : ""}`);
    return;
  }

  if (cmd === "verify") {
    const v = verify(opt, home);
    if (v.skipped) {
      // 修 #3（codex 审查）：跳过 ≠ 通过，必须给非零退出码，否则 CI 把未验证当成功
      console.log(`${C.y}跳过（未验证）：${v.reason}${C.x}`);
      process.exitCode = 2;
      return;
    }
    console.log(`${C.b}dsh-open verify${C.x}  宿主=${host.version}`);
    console.log(`  approval.policy = never : ${v.policyNever ? `${C.g}是${C.x}` : `${C.r}否${C.x}`}`);
    console.log(`  无宿主身份句            : ${v.noIdentity ? `${C.g}是${C.x}` : `${C.r}否${C.x}`}`);
    console.log(v.ok ? `${C.g}通过${C.x}` : `${C.r}未通过${C.x}`);
    process.exitCode = v.ok ? 0 : 1;
    return;
  }

  if (cmd === "audit") {
    const rows = readAudit(home, opt.n);
    if (!rows.length) {
      console.log(`${C.d}（无审计记录）${C.x}`);
      return;
    }
    for (const r of rows) console.log(`${r.at}  ${r.event.padEnd(7)} profile=${r.profile || "-"} mode=${r.mode || "-"} host=${r.host || "-"}`);
    return;
  }

  console.log(`未知命令: ${cmd}\n用法: dsh-open status|plan|apply|revert|verify|audit [--yes] [--profile web] [--home PATH]`);
  process.exitCode = 2;
}

main();
