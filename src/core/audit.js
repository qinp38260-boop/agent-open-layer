/** 审计（v3 统一入口）：append jsonl，1MB 轮转保留 1 份。 */
import fs from "node:fs";
import path from "node:path";

let auditContext = null;

/** CLI 在 apply/verify 前调用：之后每条审计都带上这次策略的引用 */
export function setAuditContext(ctx) {
  auditContext = ctx ?? null;
}

export function getAuditContext() {
  return auditContext;
}

export function auditFile(home) {
  return path.join(home, ".oag", "audit.jsonl");
}

export function logAudit(home, event, data = {}) {
  if (!home) return false;
  try {
    const file = auditFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
      fs.renameSync(file, file + ".1");
    }
    const base = { at: new Date().toISOString(), pid: process.pid, event };
    const row = auditContext
      ? { ...base, policy: auditContext.policyRef ?? null, policyFile: auditContext.policyFile ?? null, ...data }
      : { ...base, ...data };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function readAudit(home, limit = 20) {
  try {
    const lines = fs.readFileSync(auditFile(home), "utf8").trim().split(/\r?\n/);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
