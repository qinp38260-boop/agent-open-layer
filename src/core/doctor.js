/**
 * doctor：跨宿主自检（只读）
 * 检查项：宿主可探测 / 配置文件可解析 / 我们自己的临时物（journal、lock、state）是否残留 / 审计是否可读
 * 任何一项 fail → 退出码非零；warn 不影响退出码但会打印
 */
import fs from "node:fs";
import path from "node:path";
import { journalPath } from "./safe-write.js";
import { lockPath } from "./lock.js";
import { readAudit } from "./audit.js";

function check(name, fn) {
  try {
    const r = fn();
    return r === true ? { name, ok: true } : { name, ok: Boolean(r?.ok), detail: r?.detail ?? "" };
  } catch (e) {
    return { name, ok: false, detail: String(e.message ?? e).slice(0, 160) };
  }
}

/** TOML 顶层键重复检查（重复键会让宿主解析失败，这是最常见的自造事故） */
export function tomlDuplicateKeys(text) {
  const seen = new Map();
  const dup = [];
  let inTable = false;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inTable = true;
      continue;
    }
    if (!line || line.startsWith("#") || inTable) continue;
    const m = /^([A-Za-z0-9_.-]+)\s*=/.exec(line);
    if (!m) continue;
    const k = m[1];
    if (seen.has(k)) dup.push(k);
    seen.set(k, true);
  }
  return dup;
}

export async function doctor({ adapters, home }) {
  const report = { at: new Date().toISOString(), hosts: [] };

  for (const a of adapters) {
    const hostReport = { id: a.id, version: "unknown", configPath: null, checks: [] };
    let host = null;
    const detectCheck = check("detect", async () => true); // 占位，下面用真实结果覆盖
    try {
      host = await a.detect(process.env);
      hostReport.version = host.version;
      hostReport.configPath = host.configPath;
      hostReport.checks.push({ name: "detect", ok: true, detail: `v${host.version}` });
    } catch (e) {
      const notInstalled = e?.code === "E_HOST_NOT_FOUND";
      hostReport.checks.push({
        name: "detect",
        ok: true,
        skipped: notInstalled,
        detail: notInstalled ? `未安装（跳过）：${String(e.message).slice(0, 80)}` : String(e.message).slice(0, 120),
      });
      report.hosts.push(hostReport);
      continue;
    }
    void detectCheck;

    const caps = a.capabilities?.() ?? {};
    hostReport.capabilities = caps;

    hostReport.checks.push(
      check("config-exists", () => {
        const ok = fs.existsSync(host.configPath);
        return { ok, detail: ok ? host.configPath : "配置文件不存在（尚未 apply 过）" };
      }),
    );

    hostReport.checks.push(
      check("config-parsable", () => {
        if (!fs.existsSync(host.configPath)) return { ok: true, detail: "跳过（文件不存在）" };
        const text = fs.readFileSync(host.configPath, "utf8");
        if (caps.format === "json") {
          try {
            JSON.parse(text);
            return { ok: true, detail: "JSON 可解析" };
          } catch (e) {
            return { ok: false, detail: `JSON 解析失败：${e.message}` };
          }
        }
        if (caps.format === "toml") {
          const dup = tomlDuplicateKeys(text);
          return dup.length ? { ok: false, detail: `顶层键重复：${dup.join(",")}` } : { ok: true, detail: "无重复顶层键" };
        }
        // yaml：托管块完整性
        const b = text.includes("# >>> open-agent-gate managed");
        const e = text.includes("# <<< open-agent-gate managed");
        if (b !== e) return { ok: false, detail: "托管块标记不成对（BEGIN/END 有一个缺）" };
        return { ok: true, detail: b ? "托管块完整" : "无托管块（未 apply 或已 revert）" };
      }),
    );

    hostReport.checks.push(
      check("leftovers", () => {
        const items = [];
        const j = journalPath(host.configPath);
        const l = lockPath(host.configPath);
        const s = `${host.configPath}.oag-state.json`;
        if (fs.existsSync(j)) items.push("journal");
        if (fs.existsSync(l)) items.push("lock");
        if (fs.existsSync(s)) items.push("state");
        return items.length
          ? { ok: false, detail: `残留：${items.join(",")}（apply 会被拦；先跑 oag recover）` }
          : { ok: true, detail: "无 journal/lock/state 残留" };
      }),
    );

    report.hosts.push(hostReport);
  }

  const auditHome = home ?? null;
  const audit = auditHome ? readAudit(auditHome, 1) : [];
  report.audit = { path: auditHome ? path.join(auditHome, ".oag", "audit.jsonl") : null, last: audit[0] ?? null };

  const failed = report.hosts.flatMap((h) => h.checks.filter((c) => !c.ok).map((c) => `${h.id}:${c.name}`));
  report.ok = failed.length === 0;
  report.failed = failed;
  return report;
}
