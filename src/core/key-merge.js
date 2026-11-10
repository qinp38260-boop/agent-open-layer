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
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*$`, "m");
  const line = `${key} = ${valueLiteral}`;
  if (re.test(src)) return src.replace(re, line);
  const lines = src.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  if (firstTable < 0) return (src.trimEnd() ? src.trimEnd() + "\n" : "") + line + "\n";
  const head = lines.slice(0, firstTable);
  const tail = lines.slice(firstTable);
  while (head.length && head[head.length - 1].trim() === "") head.pop();
  return [...head, line, "", ...tail].join("\n");
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
