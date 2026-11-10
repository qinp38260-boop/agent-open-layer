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

export function judgeL0({ evidencePath = DEFAULT_EVIDENCE_PATH, account = DEFAULT_ACCOUNT } = {}) {
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
