/**
 * cordis.patch.yml 的「托管块」读写。
 * 只碰自己标记的块，用户手写的内容原样保留；写前备份，可原样还原。
 */
import fs from "node:fs";
import path from "node:path";

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
  const i = text.indexOf(BEGIN);
  if (i < 0) return { text, had: false };
  const j = text.indexOf(END, i);
  if (j < 0) return { text, had: false };
  const tail = text.slice(j + END.length).replace(/^[ \t]*\r?\n?/, "");
  return { text: text.slice(0, i) + tail, had: true };
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
  const { text: without, had } = stripBlock(current);
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
  const tmp = p + ".dsh-open.tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, p);
}
