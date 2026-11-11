/**
 * 无注释格式（JSON / TOML）的"键级合并"写入器。
 * 为什么不放 marker：乙的坑#2 —— JSON 不支持注释，marker 根本放不进去。
 * 策略：写进宿主自己的键空间（命名空间对象 / 顶层键），幂等覆盖，写后重解析校验。
 */
import { AdapterError, ErrorCode } from "../adapter/types.js";

/** JSON：把我们的一段配置合并进指定命名空间键，其余键原样保留 */
export function setJsonNamespace(text, key, value) {
  let obj = {};
  const src = String(text ?? "").trim();
  if (src !== "") {
    try {
      obj = JSON.parse(src);
    } catch (e) {
      throw new AdapterError(ErrorCode.CAPABILITY_MISSING, `目标不是合法 JSON：${e.message}`);
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      throw new AdapterError(ErrorCode.CAPABILITY_MISSING, "目标 JSON 顶层不是对象");
    }
  }
  const next = { ...obj, [key]: value };
  return JSON.stringify(next, null, 2) + "\n";
}

/** 深合并一个 JSON 键：对象递归合并、数组取并集（幂等），其它键原样保留 */
export function mergeJsonKey(text, key, partial) {
  let obj = {};
  const src = String(text ?? "").trim();
  if (src !== "") {
    try {
      obj = JSON.parse(src);
    } catch (e) {
      throw new AdapterError(ErrorCode.CAPABILITY_MISSING, `目标不是合法 JSON：${e.message}`);
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      throw new AdapterError(ErrorCode.CAPABILITY_MISSING, "目标 JSON 顶层不是对象");
    }
  }
  const mergeObj = (a = {}, b = {}) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      const cur = out[k];
      if (Array.isArray(v) && Array.isArray(cur)) out[k] = [...new Set([...cur, ...v])];
      else if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) out[k] = mergeObj(cur, v);
      else out[k] = v;
    }
    return out;
  };
  const next = { ...obj, [key]: mergeObj(obj[key] ?? {}, partial) };
  return JSON.stringify(next, null, 2) + String.fromCharCode(10);
}

export function getJsonNamespace(text, key) {
  try {
    const obj = JSON.parse(String(text ?? "{}"));
    return obj?.[key];
  } catch {
    return undefined;
  }
}

/** TOML：设置一个顶层键（已存在则原地替换那一行，否则插到第一个 [table] 之前） */
export function setTomlKey(text, key, valueLiteral) {
  const src = String(text ?? "").replace(/\r\n/g, "\n");
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc}\\s*=.*$`, "m");
  const line = `${key} = ${valueLiteral}`;

  /** 插到第一个 [table] 之前（根区），没有 table 就追加到末尾 */
  const insertAtRoot = (base) => {
    const lines = base.split("\n");
    const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
    if (firstTable < 0) return (base.trimEnd() ? base.trimEnd() + "\n" : "") + line + "\n";
    const head = lines.slice(0, firstTable);
    const tail = lines.slice(firstTable);
    while (head.length && head[head.length - 1].trim() === "") head.pop();
    return [...head, line, "", ...tail].join("\n");
  };

  if (re.test(src)) {
    // 位置自愈：若该键现在落在某个 [table] 之后，它其实属于那个 table（宿主会忽略），
    // 原地替换只会把错位永久保留下来 —— 必须先删掉再按根键重新插入。
    const misplaced = findMisplacedRootKeys(src).some((b) => b.key === key);
    if (misplaced) {
      const removed = src.replace(new RegExp(`^${esc}\\s*=.*\\n?`, "m"), "");
      return insertAtRoot(removed);
    }
    return src.replace(re, line);
  }
  return insertAtRoot(src);
}

/**
 * Codex 的已知根键。只查这些：section 内部的键（比如 [model_providers.deepseek] 的 name/base_url）
 * 看着和根键一模一样，纯文本无法区分，所以必须靠"这个键本来该在哪一层"来判断。
 */
export const KNOWN_ROOT_KEYS = [
  "approval_policy", "sandbox_mode", "model", "model_provider", "model_reasoning_effort",
  "model_reasoning_summary", "model_verbosity", "model_context_window", "model_max_output_tokens",
  "review_model", "disable_response_storage", "windows_wsl_setup_acknowledged", "hide_agent_reasoning",
  "notify", "instructions", "developer_instructions", "file_opener", "commit_attribution",
];

/**
 * 找出"落在某个 [table] 之后却本该是根键"的行。
 *
 * 为什么必须查：TOML 里 [section] 之后的裸键属于该 section，于是
 * `model = "..."` 写在 [model_providers.deepseek] 之后就成了 model_providers.deepseek.model，
 * codex 报 "is ignored" 后**静默改用默认模型** —— 表现是请求全超时/Reconnecting，
 * 极难联想到是"行放错了位置"（真踩过）。
 *
 * @param {string} text  TOML 文本
 * @param {string[]} rootKeys  要查的键（默认 KNOWN_ROOT_KEYS）
 */
export function findMisplacedRootKeys(text, rootKeys = KNOWN_ROOT_KEYS) {
  const want = new Set(rootKeys);
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const seenTable = [];
  const bad = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const t = line.match(/^\[([^\]]+)\]/);
    if (t) {
      seenTable.push(t[1]);
      continue;
    }
    if (!seenTable.length) continue; // 还在根区，位置本来就对
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!kv || !want.has(kv[1])) continue;
    bad.push({ key: kv[1], afterTable: seenTable[seenTable.length - 1] });
  }
  return bad;
}

export function getTomlKey(text, key) {
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+)$`, "m");
  const m = re.exec(String(text ?? ""));
  return m ? m[1].trim() : undefined;
}

/** 删掉某个顶层键（回滚"原本不存在"的键要用这个） */
export function removeTomlKey(text, key) {
  const src = String(text ?? "").replace(/\r\n/g, "\n");
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*\\n?`, "m");
  return src.replace(re, "");
}
