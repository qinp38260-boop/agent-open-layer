/**
 * cordis.patch.yml 的「托管块」读写。
 * 只碰自己标记的块，用户手写的内容原样保留；写前备份，可原样还原。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const BEGIN = "# >>> dsh-open managed block (do not edit)";
export const END = "# <<< dsh-open managed block";
export const VERSION_TAG = "dsh-open:v1";

export function readFileOr(p, fallback) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return fallback;
  }
}

export function stripBlock(text) {
  // 修 #5（codex 审查）：按"整行"匹配标记，而不是裸子串——用户正文里出现同样字样不会误删
  const lines = text.split(/\r?\n/);
  const b = lines.findIndex((l) => l.startsWith(BEGIN));
  if (b < 0) return { text, had: false };
  const e = lines.findIndex((l, i) => i > b && l.startsWith(END));
  if (e < 0) return { text, had: false, unterminated: true };
  const out = [...lines.slice(0, b), ...lines.slice(e + 1)];
  return { text: out.join("\n"), had: true };
}

/** 托管块内容（来自 open/dsh-open.patch.yml，去掉文件头注释） */
export function blockBody(fragment) {
  const body = fragment
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n")
    .trim();
  return `${BEGIN}  ${VERSION_TAG}\n${body}\n${END}\n`;
}

/**
 * 计算写入后的文本。
 * - 已有托管块 → 替换
 * - 文件为空 或 正文只有 [] → 替换整个正文（保留头部注释）
 * - 其他 → 追加到末尾（YAML 列表项可续写）
 */
export function compose(current, block) {
  const { text: without, had, unterminated } = stripBlock(current);
  // 修 #5 续：BEGIN 在但 END 缺失 → 拒绝改写，避免叠出第二个块
  if (unterminated) {
    const err = new Error("托管块 BEGIN 存在但缺少 END 标记，拒绝改写（请先手工修复该文件）");
    err.code = "UNTERMINATED_BLOCK";
    throw err;
  }
  if (had) {
    const rest = without.replace(/\s*$/, "");
    return { next: rest === "" ? block : rest + "\n" + block, mode: "replace-block" };
  }
  const stripped = without
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("#"))
    .join("")
    .trim();
  if (stripped === "" || stripped === "[]") {
    const header = without
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith("#"))
      .join("\n");
    return { next: (header ? header + "\n" : "") + block, mode: "fill-empty" };
  }
  return { next: without.trimEnd() + "\n" + block, mode: "append" };
}

export function backup(p) {
  if (!fs.existsSync(p)) return null;
  const dir = path.join(path.dirname(p), ".dsh-open-backup");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dst = path.join(dir, `cordis.patch.yml.${stamp}.bak`);
  fs.copyFileSync(p, dst);
  return dst;
}

export function writeAtomic(p, text) {
  // 修 #4（codex 审查）：可预测的临时名 + 覆盖式写入 → symlink 预创建可劫持；且不保留权限位
  const dir = path.dirname(p);
  const tmp = path.join(dir, `.${path.basename(p)}.tmp-${crypto.randomBytes(6).toString("hex")}`);
  let mode;
  try {
    mode = fs.statSync(p).mode & 0o777;
  } catch {
    mode = 0o600; // 新文件默认 0600，不跟着 umask 变成 world-readable
  }
  const fd = fs.openSync(tmp, "wx", mode); // O_EXCL：目标已存在（含 symlink）直接失败
  try {
    fs.writeFileSync(fd, text, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
  try {
    fs.chmodSync(p, mode);
  } catch {
    /* Windows 上 chmod 语义有限，失败不致命 */
  }
}
