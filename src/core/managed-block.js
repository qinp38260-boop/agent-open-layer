/**
 * 托管块 core：整行匹配 + 幂等整块替换 + 损坏检测。
 * 只支持"能写注释"的格式（yaml/toml-nl）；commentSafe=false（JSON）时明确抛错，不猜。
 */
import { AdapterError, ErrorCode } from "../adapter/types.js";

export const MARKERS = {
  begin: "# >>> open-agent-gate managed (do not edit)",
  end: "# <<< open-agent-gate managed",
};

export function normalizeBody(fragment) {
  return fragment
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n")
    .trim();
}

export function blockFor(fragment) {
  return `${MARKERS.begin}\n${normalizeBody(fragment)}\n${MARKERS.end}`;
}

/** 返回 { text, had, unterminated }；按整行匹配，避免正文同名字样被误删 */
export function stripBlock(text, markers = MARKERS) {
  const lines = String(text ?? "").split(/\r?\n/);
  const b = lines.findIndex((l) => l.startsWith(markers.begin));
  if (b < 0) return { text: String(text ?? ""), had: false, unterminated: false };
  const e = lines.findIndex((l, i) => i > b && l.startsWith(markers.end));
  if (e < 0) return { text: String(text ?? ""), had: true, unterminated: true };
  return { text: [...lines.slice(0, b), ...lines.slice(e + 1)].join("\n"), had: true, unterminated: false };
}

/**
 * 生成新全文（纯函数，不写盘）。
 * - 有块 → 整块替换（TOML/JSON 追加会叠重复键，所以必须整块替换，采纳甲的坑#1）
 * - 空/仅 [] → 填充
 * - 有用户内容 → 追加（仅在 commentSafe 且格式为 yaml 时允许）
 */
export function composeBlock(current, fragment, caps) {
  if (!caps?.managedBlock) {
    throw new AdapterError(ErrorCode.CAPABILITY_MISSING, "宿主不支持托管块");
  }
  if (caps.commentSafe === false) {
    // 乙的坑#2：JSON 不支持注释，marker 放不进去 → 必须由 adapter 提供命名空间序列化
    throw new AdapterError(ErrorCode.CAPABILITY_MISSING, `格式 ${caps.format} 不支持行内 marker，需 adapter 自带命名空间序列化`);
  }
  const cur = String(current ?? "");
  const block = blockFor(fragment);
  const stripped = stripBlock(cur, MARKERS);
  if (stripped.unterminated) {
    throw new AdapterError(ErrorCode.MARKER_CORRUPT, "托管块 BEGIN 存在但缺少 END，拒绝改写");
  }
  if (stripped.had) {
    const rest = stripped.text.replace(/\s*$/, "");
    return { text: rest === "" ? block : rest + "\n" + block, mode: "replace-block" };
  }
  const bare = cur
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("#"))
    .join("")
    .trim();
  if (bare === "" || bare === "[]") {
    const header = cur
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith("#"))
      .join("\n");
    return { text: (header ? header + "\n" : "") + block, mode: "fill-empty" };
  }
  return { text: cur.replace(/\s*$/, "") + "\n" + block, mode: "append" };
}
