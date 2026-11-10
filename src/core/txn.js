/**
 * 多文件事务：一次改 N 个文件，**全成或全回滚**。
 * 为什么需要：策略可能同时触及多个宿主配置；逐个 safeWrite 会在中途失败时留下"改了一半"的状态。
 *
 * 顺序：
 *   1. 按路径排序抢锁（固定顺序防死锁）
 *   2. 任一文件有残留 journal → E_RECOVER_REQUIRED
 *   3. 全量竞态检查（hash 与 plan 时一致）
 *   4. 全量备份 + 写事务 journal（含 N 条记录）
 *   5. 备份后再全量比一次 hash（甲坑#2 的窗口）
 *   6. 逐个写临时文件（O_EXCL）→ 全部写完后逐个 rename
 *   7. 校验（可选 verifyAll）→ 失败则全量还原
 *   8. 清 journal + 放锁 + 审计
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AdapterError, ErrorCode } from "../adapter/types.js";
import { acquire, release } from "./lock.js";
import { sha256, readOrNull, journalPath } from "./safe-write.js";
import { logAudit } from "./audit.js";

export function txnJournalPath(files) {
  return `${path.dirname(files[0].path)}${path.sep}.oag-txn.json`;
}

export function readTxnJournal(files) {
  try {
    return JSON.parse(fs.readFileSync(txnJournalPath(files), "utf8"));
  } catch {
    return null;
  }
}

async function restoreAll(entries) {
  const done = [];
  for (const e of entries) {
    if (!e.backup || !fs.existsSync(e.backup)) continue;
    const content = await readOrNull(e.backup);
    fs.writeFileSync(e.path, content ?? "", "utf8");
    done.push(e.path);
  }
  return done;
}

/**
 * @param {{ files: {path:string, after:string, baseHash:string|null}[], home?:string, action?:string, verifyAll?:Function }} opts
 */
export async function commitTxn(opts) {
  const files = [...opts.files].sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length) return { changed: false, files: [] };
  const action = opts.action ?? "apply-txn";
  const txnPath = txnJournalPath(files);
  const locks = [];

  try {
    for (const f of files) locks.push(acquire(f.path));

    if (fs.existsSync(txnPath)) {
      throw new AdapterError(ErrorCode.RECOVER_REQUIRED, `发现残留事务 journal，请先 recover：${txnPath}`);
    }
    for (const f of files) {
      if (fs.existsSync(journalPath(f.path))) {
        throw new AdapterError(ErrorCode.RECOVER_REQUIRED, `文件有残留 journal：${journalPath(f.path)}`);
      }
    }

    // 竞态检查（写前）
    for (const f of files) {
      const cur = await readOrNull(f.path);
      if (sha256(cur) !== (f.baseHash ?? sha256(null))) {
        throw new AdapterError(ErrorCode.RACE, `文件在 plan 之后被改动：${f.path}`);
      }
    }

    // 备份 + 事务 journal
    const entries = [];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const f of files) {
      const dir = path.join(path.dirname(f.path), ".oag-backup");
      fs.mkdirSync(dir, { recursive: true });
      const bak = path.join(dir, `${path.basename(f.path)}.${stamp}.bak`);
      const cur = await readOrNull(f.path);
      if (cur !== null) await fs.promises.copyFile(f.path, bak);
      else await fs.promises.writeFile(bak, "", "utf8");
      entries.push({ path: f.path, backup: bak, beforeHash: sha256(cur), afterHash: sha256(f.after) });
    }
    fs.writeFileSync(txnPath, JSON.stringify({ at: new Date().toISOString(), action, stage: "backup-done", files: entries }, null, 2), "utf8");

    // 备份后再检一次
    for (const f of files) {
      const cur = await readOrNull(f.path);
      if (sha256(cur) !== (f.baseHash ?? sha256(null))) {
        await restoreAll(entries);
        fs.rmSync(txnPath, { force: true });
        throw new AdapterError(ErrorCode.RACE, `备份与写入之间被外部改动：${f.path}`);
      }
    }

    // 先全部写临时文件，再全部 rename（缩小"改一半"的窗口）
    const temps = [];
    for (const f of files) {
      let mode = 0o600;
      try {
        mode = fs.statSync(f.path).mode & 0o777;
      } catch {
        /* 新文件 0600 */
      }
      const tmp = path.join(path.dirname(f.path), `.${path.basename(f.path)}.txn-${crypto.randomBytes(5).toString("hex")}`);
      const fd = fs.openSync(tmp, "wx", mode);
      try {
        fs.writeFileSync(fd, f.after, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      temps.push({ tmp, target: f.path, mode });
    }
    const renamed = [];
    try {
      for (const t of temps) {
        fs.renameSync(t.tmp, t.target);
        renamed.push(t);
      }
    } catch (e) {
      for (const t of temps) {
        try {
          fs.rmSync(t.tmp, { force: true });
        } catch {
          /* ignore */
        }
      }
      const restored = await restoreAll(entries);
      fs.rmSync(txnPath, { force: true });
      logAudit(opts.home, "txn-write-failed", { action, error: e.message, restored });
      throw new AdapterError(ErrorCode.WRITE_FAILED, `事务写入失败（已还原 ${restored.length} 个文件）：${e.message}`);
    }

    // 校验
    if (typeof opts.verifyAll === "function") {
      let v;
      try {
        v = await opts.verifyAll(files);
      } catch (e) {
        v = { ok: false, reason: String(e.message ?? e) };
      }
      if (!v?.ok) {
        const restored = await restoreAll(entries);
        fs.rmSync(txnPath, { force: true });
        logAudit(opts.home, "txn-verify-failed", { action, reason: v?.reason, restored });
        throw new AdapterError(ErrorCode.VERIFY_FAILED, `事务校验失败（已还原 ${restored.length} 个）：${v?.reason ?? ""}`);
      }
    }

    fs.rmSync(txnPath, { force: true });
    logAudit(opts.home, `${action}-ok`, { files: files.map((f) => f.path) });
    return { changed: true, files: files.map((f) => f.path) };
  } finally {
    for (const l of locks) release(l);
  }
}

/** 崩溃恢复：按事务 journal 全量还原 */
export async function recoverTxn(files, { home } = {}) {
  const j = readTxnJournal(files);
  if (!j) return { recovered: false, reason: "没有残留事务 journal" };
  const restored = await restoreAll(j.files ?? []);
  fs.rmSync(txnJournalPath(files), { force: true });
  logAudit(home, "txn-recover", { restored });
  return { recovered: true, restored };
}
