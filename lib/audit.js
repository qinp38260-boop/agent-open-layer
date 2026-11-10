import fs from "node:fs";
import path from "node:path";

/** 追加一行 JSON 到 <home>/dsh-open/audit.jsonl，超过 1MB 轮转保留 1 份。 */
export function logAudit(home, event, data = {}) {
  try {
    const dir = path.join(home, "dsh-open");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "audit.jsonl");
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
      fs.renameSync(file, file + ".1");
    }
    const row = { at: new Date().toISOString(), event, pid: process.pid, ...data };
    fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

export function readAudit(home, limit = 20) {
  const file = path.join(home, "dsh-open", "audit.jsonl");
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
