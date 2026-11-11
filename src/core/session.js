/**
 * 会话强绑定（OAG_BIND）：让"闸门"从"可以绕过的挂件"变成"必须带着才能干活"
 *
 * 做法：
 *   1. 由 wrapper（`oag run`）签发一次性会话票据，并通过环境变量 OAG_SESSION 注入子进程；
 *      hook 进程继承该环境变量 → 闸门每次判定前先校验票据。
 *   2. 票据不存在 / 过期 / 已冻结 / 策略指纹不符 → 闸门**拒掉一切动作**（fail-closed）。
 *      直接裸跑 codex（不经 wrapper）拿不到票据 → 什么也做不了。
 *   3. 每次越界计数；达到 maxDenies → 冻结票据，wrapper 看到冻结就杀掉子进程（退出码 13）。
 *
 * 边界（别夸大）：这挡的是"忘记/故意不经 wrapper 启动"和"越界后继续硬试"。
 * 挡不住的是：能改票据文件的账号（票据放在 codexHome 同级 .oag 下，需要 ACL 保护）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const SESSION_ENV = "OAG_SESSION";
export const DEFAULT_TTL_SEC = 3600;
export const DEFAULT_MAX_DENIES = 3;

/**
 * 票据目录：**以策略文件所在目录为准**（闸门脚本读策略，天然知道这个位置）。
 * 早先用 codexHome 推导，测试里 policy 与 codexHome 不同时就对不上 → 票据"不存在" → 误拒。
 */
export function sessionsDir({ codexHome = "", policyPath = "" } = {}) {
  const base = policyPath ? path.dirname(policyPath) : codexHome;
  return path.join(base, ".oag-sessions");
}

export function ticketPath(dir, sid) {
  return path.join(dir, `${sid}.json`);
}

export function policyRef(policyText) {
  return crypto.createHash("sha256").update(String(policyText ?? "")).digest("hex").slice(0, 16);
}

/** 签发会话票据 */
export function issueSession({ codexHome = "", policyPath = "", dir = "", ttlSec = DEFAULT_TTL_SEC, maxDenies = DEFAULT_MAX_DENIES, policy } = {}) {
  const sid = crypto.randomUUID();
  const t = {
    sid,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ttlSec,
    maxDenies,
    denies: 0,
    frozen: false,
    policyRef: policy ? policyRef(policy) : null,
  };
  const _dir = dir || sessionsDir({ codexHome, policyPath });
  fs.mkdirSync(_dir, { recursive: true });
  t.dir = _dir;
  fs.writeFileSync(ticketPath(_dir, sid), JSON.stringify(t, null, 2), "utf8");
  return t;
}

export function readSession(dir, sid) {
  try {
    return JSON.parse(fs.readFileSync(ticketPath(dir, sid), "utf8"));
  } catch {
    return null;
  }
}

export function writeSession(dir, t) {
  try {
    fs.writeFileSync(ticketPath(dir, t.sid), JSON.stringify(t, null, 2), "utf8");
  } catch {}
}

/** 校验票据；返回 {ok, reason}。任何异常都按不通过处理 */
export function validateSession({ dir, sid, expectPolicyRef = null, now = Date.now() } = {}) {
  if (!sid) return { ok: false, reason: "没有会话票据（未经 oag run 启动？）" };
  const t = readSession(dir, sid);
  if (!t) return { ok: false, reason: `票据不存在：${sid}` };
  if (t.frozen) return { ok: false, reason: "会话已冻结（越界次数超限），请人工介入" };
  const age = (now - Date.parse(t.startedAt)) / 1000;
  if (!Number.isFinite(age) || age > t.ttlSec) return { ok: false, reason: `票据已过期（${Math.round(age)}s > ${t.ttlSec}s）` };
  if (expectPolicyRef && t.policyRef && t.policyRef !== expectPolicyRef) {
    return { ok: false, reason: "策略指纹与会话不一致（策略被换过）" };
  }
  return { ok: true, ticket: t };
}

/** 越界计数；达到上限则冻结 */
export function tickDeny({ dir, sid, reason = "" } = {}) {
  const t = readSession(dir, sid);
  if (!t) return null;
  t.denies = (t.denies ?? 0) + 1;
  t.lastDenyReason = String(reason).slice(0, 200);
  t.lastDenyAt = new Date().toISOString();
  if (t.maxDenies && t.denies >= t.maxDenies) {
    t.frozen = true;
    t.frozenAt = new Date().toISOString();
    t.frozenReason = `越界 ${t.denies} 次，达到上限 ${t.maxDenies}`;
  }
  writeSession(dir, t);
  return t;
}

export function freezeSession({ dir, sid, reason } = {}) {
  const t = readSession(dir, sid);
  if (!t) return null;
  t.frozen = true;
  t.frozenAt = new Date().toISOString();
  t.frozenReason = reason ?? "手动冻结";
  writeSession(dir, t);
  return t;
}

export function clearSession({ dir, sid } = {}) {
  try {
    fs.unlinkSync(ticketPath(dir, sid));
  } catch {}
}
