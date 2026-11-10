/**
 * adapter 注册表：按 id 取，或按顺序自动探测（首个 detect 成功者胜）。
 */
import { AdapterError, ErrorCode } from "./types.js";

const registry = new Map();

export function register(adapter) {
  if (!adapter?.id) throw new AdapterError(ErrorCode.CAPABILITY_MISSING, "adapter 必须有 id");
  registry.set(adapter.id, adapter);
  return adapter;
}

export function get(id) {
  const a = registry.get(id);
  if (!a) throw new AdapterError(ErrorCode.HOST_NOT_FOUND, `未注册的 adapter: ${id}（已注册：${[...registry.keys()].join(", ")}）`);
  return a;
}

export function list() {
  return [...registry.keys()];
}

export async function detectAny(env = process.env) {
  const errors = [];
  for (const a of registry.values()) {
    try {
      const host = await a.detect(env);
      if (host) return { adapter: a, host };
    } catch (e) {
      errors.push({ id: a.id, message: e.message, code: e.code });
    }
  }
  throw new AdapterError(ErrorCode.HOST_NOT_FOUND, `没有适配的宿主：${JSON.stringify(errors)}`);
}

export function _reset() {
  registry.clear();
}
