/**
 * 并发锁：O_EXCL 建锁文件；进程崩溃留下的陈旧锁（默认 10 分钟）可被接管，
 * 但接管前会记录 staleLock 事件，绝不静默。
 */
import fs from "node:fs";
import path from "node:path";
import { AdapterError, ErrorCode } from "../adapter/types.js";

const STALE_MS = Number(process.env.OAG_LOCK_STALE_MS ?? 10 * 60 * 1000);

export function lockPath(file) {
  return `${file}.oag-lock`;
}

export function acquire(file, { staleMs = STALE_MS } = {}) {
  const lp = lockPath(file);
  const body = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, body, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      return { path: lp, released: false, stale: false };
    } catch (e) {
      if (e.code !== "EEXIST") throw new AdapterError(ErrorCode.WRITE_FAILED, `建锁失败：${e.message}`);
      let info = {};
      try {
        info = JSON.parse(fs.readFileSync(lp, "utf8"));
      } catch {
        /* 锁文件损坏 → 当陈旧处理 */
      }
      const age = Date.now() - Date.parse(info.at ?? 0);
      if (Number.isFinite(age) && age > staleMs) {
        fs.rmSync(lp, { force: true });
        continue; // 接管一次
      }
      throw new AdapterError(ErrorCode.RACE, `另一个进程正在写（锁：${lp}，pid=${info.pid ?? "?"}）`);
    }
  }
  throw new AdapterError(ErrorCode.RACE, `无法获得锁：${lp}`);
}

export function release(lock) {
  if (!lock || lock.released) return;
  try {
    fs.rmSync(lock.path, { force: true });
  } catch {
    /* ignore */
  }
  lock.released = true;
}
