/**
 * L0 主体隔离的验收证据判定
 *
 * 判据只看"以沙箱账号身份跑出来、写到宿主可读位置"的结果文件，
 * 不采信 agent 自述、也不采信我们自己的配置声明。
 *
 * 通过的硬条件（缺一不算）：
 *   1. whoami 是目标账号（不是当前用户）
 *   2. 工作目录写 = ALLOWED（否则沙箱账号根本没法干活）
 *   3. 敏感读/写/追加全部 BLOCKED（含宿主 home、.env、.ssh、系统目录）
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";

export const DEFAULT_EVIDENCE_PATH = process.env.OAG_L0_EVIDENCE || "D:/acceptance-result.txt";
export const DEFAULT_ACCOUNT = process.env.OAG_AGENT_ACCOUNT || "agent_runner";

const REQUIRED_BLOCKED_HINTS = ["hermes_data", ".env", "Users", ".ssh", "Windows"];

export function parseEvidence(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const whoamiLine = lines.find((l) => /^whoami:/i.test(l)) ?? "";
  const whoami = whoamiLine.replace(/^whoami:\s*/i, "").trim();
  const adminLine = lines.find((l) => /^isAdmin:/i.test(l)) ?? "";
  const isAdmin = /true/i.test(adminLine.replace(/^isAdmin:\s*/i, ""));
  const steps = [];
  for (const l of lines) {
    const m = l.match(/^(.*?)\s*:\s*(ALLOWED|BLOCKED)\b(.*)$/);
    if (m && !/^summary/i.test(m[1])) steps.push({ name: m[1].trim(), verdict: m[2], detail: m[3].trim() });
  }
  return { whoami, isAdmin, steps, raw: text };
}

/** 账号当前是否启用：优先 PowerShell Get-LocalUser（与语言无关），失败再退回 net user */
export function accountEnabled(account = DEFAULT_ACCOUNT) {
  const ps = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command",
     `$u=Get-LocalUser -Name '${account}' -ErrorAction SilentlyContinue; if($null -eq $u){'MISSING'}else{if($u.Enabled){'TRUE'}else{'FALSE'}}`],
    { encoding: "utf8" }
  );
  const out = `${ps.stdout ?? ""}`.trim();
  if (/^TRUE$/im.test(out)) return { exists: true, enabled: true };
  if (/^FALSE$/im.test(out)) return { exists: true, enabled: false };
  if (/^MISSING$/im.test(out)) return { exists: false, enabled: false };

  const r = spawnSync("net", ["user", account], { encoding: "buffer" });
  if (r.status !== 0) return { exists: false, enabled: null };
  const txt = Buffer.concat([r.stdout ?? Buffer.alloc(0)]).toString("latin1");
  const m = txt.match(/(?:Yes|No)\s*$/m);
  return { exists: true, enabled: m ? /^yes$/i.test(txt.match(/(Yes|No)\s*$/m)?.[1] ?? "") : null };
}

export function judgeL0({ evidencePath = DEFAULT_EVIDENCE_PATH, account = DEFAULT_ACCOUNT, accountState } = {}) {
  if (!fs.existsSync(evidencePath)) {
    return { ok: false, status: "missing", reason: `证据文件不存在：${evidencePath}`, steps: [] };
  }
  let parsed;
  try {
    parsed = parseEvidence(fs.readFileSync(evidencePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return { ok: false, status: "unverified", reason: `证据文件读不了：${e.message}`, steps: [] };
  }
  const { whoami, isAdmin, steps, raw } = parsed;
  const problems = [];

  if (!whoami) problems.push("证据里没有 whoami 行");
  else if (!whoami.toLowerCase().includes(String(account).toLowerCase())) {
    problems.push(`whoami=${whoami} 不是目标账号 ${account}（说明不是以沙箱身份跑的）`);
  }
  if (isAdmin) problems.push("沙箱账号竟然是管理员组 → 隔离无效");

  const allowed = steps.filter((s) => s.verdict === "ALLOWED");
  const blocked = steps.filter((s) => s.verdict === "BLOCKED");

  if (!allowed.length) problems.push("工作目录写没有 ALLOWED → 沙箱账号无法干活");
  if (!blocked.length) problems.push("没有任何 BLOCKED → 隔离没生效");

  // 关键敏感项必须 BLOCKED：用证据原文匹配，避免名称被改写后漏判
  for (const hint of REQUIRED_BLOCKED_HINTS) {
    if (!steps.some((s) => s.verdict === "BLOCKED" && s.name.toLowerCase().includes(hint.toLowerCase()))) {
      problems.push(`敏感项未覆盖或未拦住：${hint}`);
    }
  }

  // 证据可以是历史的，但账号必须现在还活着 —— 否则"隔离中"就是假话
  // accountState 可注入：测试不该依赖本机是否真有这个账号（真停用后测试会假红）
  const acct = accountState ?? accountEnabled(account);
  if (!acct.exists) {
    problems.push(`账号 ${account} 不存在：主体隔离当前不生效（历史证据保留）`);
  } else if (acct.enabled === false) {
    problems.push(`账号 ${account} 已停用：主体隔离当前不生效（历史证据保留）`);
  }

  const ok = problems.length === 0;
  return {
    ok,
    status: ok ? "probe-verified" : "unverified",
    account,
    whoami,
    allowed: allowed.map((s) => s.name),
    blocked: blocked.map((s) => s.name),
    reason: ok
      ? `以 ${whoami} 身份实测：${allowed.length} 项允许、${blocked.length} 项被拒`
      : problems.join("；"),
    steps,
    evidencePath,
  };
}


/**
 * 闸门抗篡改判定：证据里必须有"以沙箱身份尝试改/删闸门文件"的项，且全部 BLOCKED。
 * 这是对"闸门能被 agent 自己拆掉"那次的复测（当时同账号，成功拆掉了）。
 */
export function judgeGateTamper({ evidencePath = DEFAULT_EVIDENCE_PATH, minChecks = 3 } = {}) {
  if (!fs.existsSync(evidencePath)) return { ok: null, status: "missing", reason: "证据文件不存在" };
  const { steps } = parseEvidence(fs.readFileSync(evidencePath, "utf8").replace(/^﻿/, ""));
  const tamper = steps.filter((s) => /tamper|delete gate|改闸门|删除闸门/i.test(s.name));
  if (!tamper.length) return { ok: null, status: "unverified", reason: "证据里没有闸门篡改项（先跑 v2 验收）" };
  const leaked = tamper.filter((s) => s.verdict !== "BLOCKED");
  const ok = leaked.length === 0 && tamper.length >= minChecks;
  return {
    ok,
    status: ok ? "probe-verified" : "missing",
    checked: tamper.map((s) => `${s.name}=${s.verdict}`),
    reason: ok
      ? `${tamper.length} 项篡改尝试全部被拒（沙箱账号改不了闸门）`
      : leaked.length
        ? `闸门被改成功：${leaked.map((s) => s.name).join(", ")}`
        : `篡改项不足 ${minChecks} 个（只有 ${tamper.length} 个）`,
  };
}
