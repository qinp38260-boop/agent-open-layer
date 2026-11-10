/**
 * adapter 契约 v3（甲骨架 + 乙的能力位 + v2 的 fail-closed）
 *
 * 设计取舍：
 * - 共享安全动作（备份/baseHash/原子写/读回/回滚/journal）全部在 core，adapter 只回答三件事：
 *   ① 宿主在哪、什么版本 ② 该写什么内容（纯函数）③ 怎么验证宿主真的认了
 * - 错误码 → 退出码 是固定表；"验证没跑"必须有独立非零码，禁止和"通过"混用
 * - Capabilities.commentSafe=false 的宿主（JSON/TOML）不能放行内 marker，必须由 adapter 自带序列化，
 *   core 直接抛 E_CAPABILITY_MISSING 而不是猜
 */

export const ErrorCode = Object.freeze({
  HOST_NOT_FOUND: "E_HOST_NOT_FOUND",
  VERSION_UNSUPPORTED: "E_VERSION_UNSUPPORTED",
  CAPABILITY_MISSING: "E_CAPABILITY_MISSING",
  MARKER_CORRUPT: "E_MARKER_CORRUPT",
  RACE: "E_RACE",
  BACKUP_FAILED: "E_BACKUP_FAILED",
  WRITE_FAILED: "E_WRITE_FAILED",
  VERIFY_FAILED: "E_VERIFY_FAILED",
  VERIFY_SKIPPED: "E_VERIFY_SKIPPED",
  ROLLBACK_FAILED: "E_ROLLBACK_FAILED",
  PROFILE_INVALID: "E_PROFILE_INVALID",
});

/** 退出码约定：0=成功或无需动作；1=验证失败；2=验证未能进行（未验证≠通过）；3=宿主/版本；4=竞态；5=IO；7=回滚失败 */
export const EXIT_CODES = Object.freeze({
  [ErrorCode.HOST_NOT_FOUND]: 3,
  [ErrorCode.VERSION_UNSUPPORTED]: 3,
  [ErrorCode.CAPABILITY_MISSING]: 3,
  [ErrorCode.MARKER_CORRUPT]: 6,
  [ErrorCode.RACE]: 4,
  [ErrorCode.BACKUP_FAILED]: 5,
  [ErrorCode.WRITE_FAILED]: 5,
  [ErrorCode.VERIFY_FAILED]: 1,
  [ErrorCode.VERIFY_SKIPPED]: 2,
  [ErrorCode.ROLLBACK_FAILED]: 7,
  [ErrorCode.PROFILE_INVALID]: 3,
});

export class AdapterError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.detail = detail;
  }
}

export function exitCodeFor(err) {
  if (err && err.code && EXIT_CODES[err.code] !== undefined) return EXIT_CODES[err.code];
  return 5;
}

/**
 * @typedef {{ id: string, version: string, configPath: string }} HostInfo
 * @typedef {{ managedBlock: boolean, format: 'yaml'|'toml'|'json', commentSafe: boolean }} Capabilities
 * @typedef {{ id: string, body: string, expect?: RegExp }} Payload
 * @typedef {{ host: HostInfo, file: string, before: string|null, after: string|null, baseHash: string|null, changed: boolean, payload: Payload }} Plan
 * @typedef {{ path: string, hash: string }|null} BackupRef
 * @typedef {{ backup: BackupRef, changed: boolean }} ApplyResult
 */
