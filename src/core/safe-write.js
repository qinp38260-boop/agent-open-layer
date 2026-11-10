/**
 * 安全写入 core（甲骨架 + v2 journal + 甲坑#2 竞态窗口 + v3 并发锁/审计/恢复）
 *
 * 顺序（每步失败都有专属错误码，绝不静默）：
 *   0. 抢锁（O_EXCL；陈旧锁可接管但记账）
 *   1. 残留 journal → E_RECOVER_REQUIRED（必须先 recover，不自动继续）
 *   2. 重读并比对 baseHash → 不符 E_RACE
 *   3. 备份 + 写 journal
 *   4. 备份后再比一次 baseHash（真实竞态窗口 —— 甲坑#2）
 *   5. 随机临时文件 + O_EXCL + 期望权限 → 原子 rename
 *   6. 读回 + verify → 失败用备份还原；还原失败 E_ROLLBACK_FAILED
 *   7. 清 journal + 放锁 + 审计
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { AdapterError, ErrorCode } from "../adapter/types.js";
import { acquire, release } from "./lock.js";
import { logAudit } from "./audit.js";

export const sha256 = (s) => crypto.createHash("sha256").update(s ?? "").digest("hex");

export async function readOrNull(file) {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
}

export function journalPath(file) {
  return `${file}.oag-journal.json`;
}

export function readJournal(file) {
  try {
    return JSON.parse(fs.readFileSync(journalPath(file), "utf8"));
  } catch {
    return null;
  }
}

function clearJournal(file) {
  try {
    fs.rmSync(journalPath(file), { force: true });
  } catch {
    /* ignore */
  }
}

async function restore(backupPath, file) {
  const content = await fsp.readFile(backupPath, "utf8");
  fs.writeFileSync(file, content, "utf8");
}

/** 崩溃恢复：用 journal 里的备份还原，成功才清 journal。绝不自动继续写入。 */
export async function recover(file, { home } = {}) {
  const j = readJournal(file);
  if (!j) return { recovered: false, reason: "没有残留 journal" };
  if (!j.backup?.path || !fs.existsSync(j.backup.path)) {
    logAudit(home, "recover-failed", { file, reason: "journal 里的备份不存在" });
    throw new AdapterError(ErrorCode.ROLLBACK_FAILED, `journal 存在但备份缺失：${j.backup?.path ?? "?"}`);
  }
  const restored = await fsp.readFile(j.backup.path, "utf8");
  fs.writeFileSync(file, restored, "utf8");
  clearJournal(file);
  logAudit(home, "recover", { file, from: j.backup.path, stage: j.stage });
  return { recovered: true, from: j.backup.path, stage: j.stage };
}

/**
 * @param {{ file: string, after: string, baseHash: string|null, verify?: Function, home?: string, action?: string }} opts
 */
export async function safeWrite(opts) {
  const { file, after, baseHash } = opts;
  const verify = opts.verify ?? (async () => ({ ok: true }));
  const home = opts.home;
  const action = opts.action ?? "apply";

  const lock = acquire(file);
  try {
    if (readJournal(file)) {
      logAudit(home, "apply-blocked-recover", { file });
      throw new AdapterError(ErrorCode.RECOVER_REQUIRED, `发现残留 journal，请先运行 recover：${journalPath(file)}`);
    }

    const current = await readOrNull(file);
    if (sha256(current) !== (baseHash ?? sha256(null))) {
      logAudit(home, "apply-race", { file, action });
      throw new AdapterError(ErrorCode.RACE, `文件在 plan 之后被改动：${file}`, { baseHash, now: sha256(current) });
    }

    const backupDir = path.join(path.dirname(file), ".oag-backup");
    let backup = null;
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const bak = path.join(backupDir, `${path.basename(file)}.${stamp}.bak`);
      if (current !== null) await fsp.copyFile(file, bak);
      else await fsp.writeFile(bak, "", "utf8");
      backup = { path: bak, hash: sha256(current) };
      fs.writeFileSync(
        journalPath(file),
        JSON.stringify({ at: new Date().toISOString(), file, backup, stage: "backup-done", afterHash: sha256(after) }),
        "utf8",
      );
    } catch (e) {
      logAudit(home, "apply-backup-failed", { file, message: e.message });
      throw new AdapterError(ErrorCode.BACKUP_FAILED, `备份失败：${e.message}`);
    }

    const again = await readOrNull(file);
    if (sha256(again) !== (baseHash ?? sha256(null))) {
      await restore(backup.path, file);
      clearJournal(file);
      logAudit(home, "apply-race-window", { file, action });
      throw new AdapterError(ErrorCode.RACE, `备份与写入之间文件被外部改动：${file}`);
    }

    let mode = 0o600;
    try {
      mode = fs.statSync(file).mode & 0o777;
    } catch {
      /* 新文件 0600 */
    }
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${crypto.randomBytes(6).toString("hex")}`);
    try {
      const fd = fs.openSync(tmp, "wx", mode);
      try {
        fs.writeFileSync(fd, after, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      clearJournal(file);
      logAudit(home, "apply-write-failed", { file, message: e.message });
      throw new AdapterError(ErrorCode.WRITE_FAILED, `写入失败：${e.message}`);
    }

    const written = await readOrNull(file);
    let v;
    try {
      v = await verify(written);
    } catch (e) {
      v = { ok: false, reason: `verify 抛错：${e.message}` };
    }
    if (!v.ok) {
      try {
        await restore(backup.path, file);
      } catch (e) {
        logAudit(home, "apply-rollback-failed", { file, backup: backup.path });
        throw new AdapterError(ErrorCode.ROLLBACK_FAILED, `验证失败且还原失败，请手工用备份：${backup.path}（${e.message}）`, { backup });
      }
      clearJournal(file);
      logAudit(home, "apply-verify-failed", { file, reason: v.reason });
      throw new AdapterError(ErrorCode.VERIFY_FAILED, `写入后验证失败，已用备份还原：${v.reason ?? "未知原因"}`, { backup });
    }

    clearJournal(file);
    logAudit(home, `${action}-ok`, { file, backup: backup?.path, from: backup?.hash, to: sha256(after) });
    return { backup, changed: true };
  } finally {
    release(lock);
  }
}
