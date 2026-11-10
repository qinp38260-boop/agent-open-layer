/**
 * 安全写入 core（甲骨架 + v2 的 journal + 甲坑#2 的竞态窗口）
 *
 * 顺序（每步失败都有专属错误码，绝不静默）：
 *   0. 写 journal（崩溃后 recover 可用）
 *   1. 重读文件并比对 baseHash → 不符 E_RACE（这一步必须在 backup 之后 write 之前也要再做一次）
 *   2. 备份（带时间戳，记 hash）
 *   3. 随机临时文件 + O_EXCL + 期望权限 → 原子 rename
 *   4. 读回 + 调 verifyByHost → 失败则用备份还原；还原失败 E_ROLLBACK_FAILED
 *   5. 清 journal
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { AdapterError, ErrorCode } from "../adapter/types.js";

export const sha256 = (s) => crypto.createHash("sha256").update(s ?? "").digest("hex");

export async function readOrNull(file) {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
}

function journalPath(file) {
  return `${file}.oag-journal.json`;
}

/** 崩溃恢复：发现残留 journal 就返回它，让 CLI 决定恢复而不是自动继续 */
export function readJournal(file) {
  try {
    return JSON.parse(fs.readFileSync(journalPath(file), "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {{ file: string, after: string, baseHash: string|null, verify?: (text:string)=>Promise<{ok:boolean,reason?:string}> }} opts
 */
export async function safeWrite(opts) {
  const { file, after, baseHash } = opts;
  const verify = opts.verify ?? (async () => ({ ok: true }));

  // 1) 竞态检查（写前）
  const current = await readOrNull(file);
  if (sha256(current) !== (baseHash ?? sha256(null))) {
    throw new AdapterError(ErrorCode.RACE, `文件在 plan 之后被改动：${file}`, { baseHash, now: sha256(current) });
  }

  // 0+2) journal + 备份
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
    throw new AdapterError(ErrorCode.BACKUP_FAILED, `备份失败：${e.message}`);
  }

  // 1b) 再检一次竞态（backup 与 write 之间是真实窗口 —— 甲坑#2）
  const again = await readOrNull(file);
  if (sha256(again) !== (baseHash ?? sha256(null))) {
    await restore(backup.path, file);
    throw new AdapterError(ErrorCode.RACE, `备份与写入之间文件被外部改动：${file}`);
  }

  // 3) 原子写
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* 新文件用 0600 */
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
    throw new AdapterError(ErrorCode.WRITE_FAILED, `写入失败：${e.message}`);
  }

  // 4) 读回 + 宿主语义验证
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
      throw new AdapterError(ErrorCode.ROLLBACK_FAILED, `验证失败且还原失败，请手工用备份：${backup.path}（${e.message}）`, { backup });
    }
    throw new AdapterError(ErrorCode.VERIFY_FAILED, `写入后验证失败，已用备份还原：${v.reason ?? "未知原因"}`, { backup });
  }

  // 5) 清 journal
  try {
    fs.rmSync(journalPath(file), { force: true });
  } catch {
    /* ignore */
  }
  return { backup, changed: true };
}

async function restore(backupPath, file) {
  const content = await fsp.readFile(backupPath, "utf8");
  fs.writeFileSync(file, content, "utf8");
}

/** revert：after=null 表示回到 before（移除托管块），其余逻辑同 safeWrite */
export async function safeRevert(opts) {
  return safeWrite({ ...opts, after: opts.before ?? "" });
}
