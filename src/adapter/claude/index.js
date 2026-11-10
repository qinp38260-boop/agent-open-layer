/**
 * Claude Code adapter（JSON，不能放 marker）
 * 乙的坑#2 的正解：写进宿主键空间里的一个命名空间对象，幂等覆盖，写后重解析校验。
 */
import fs from "node:fs";
import path from "node:path";
import { AdapterError, ErrorCode } from "../types.js";
import { readOrNull, sha256, safeWrite } from "../../core/safe-write.js";
import { setJsonNamespace, getJsonNamespace } from "../../core/key-merge.js";

const NS = "_openAgentGate";

export function claudeAdapter(options = {}) {
  return {
    id: "claude-code",

    async detect(env = process.env) {
      const home = options.home ?? env.CLAUDE_CONFIG_DIR ?? path.join(env.USERPROFILE ?? env.HOME ?? "", ".claude");
      if (!fs.existsSync(home)) throw new AdapterError(ErrorCode.HOST_NOT_FOUND, `Claude 配置目录不存在：${home}`);
      const configPath = options.configPath ?? path.join(home, "settings.json");
      return { id: "claude-code", version: options.version ?? "unknown", configPath };
    },

    capabilities() {
      // JSON 不支持注释 → 不能用 marker；走命名空间键
      return { managedBlock: false, format: "json", commentSafe: false, namespace: NS };
    },

    async plan(host, payload) {
      if (!payload?.patch?.json) throw new AdapterError(ErrorCode.CAPABILITY_MISSING, "claude adapter 需要 payload.patch.json");
      const before = await readOrNull(host.configPath);
      const after = setJsonNamespace(before, NS, { ...(getJsonNamespace(before, NS) ?? {}), ...payload.patch.json });
      return { host, file: host.configPath, before, after, baseHash: sha256(before), changed: after !== (before ?? ""), payload };
    },

    async planRevert(host) {
      const before = await readOrNull(host.configPath);
      if (before === null) return { host, file: host.configPath, before, after: null, baseHash: sha256(null), changed: false };
      let obj;
      try {
        obj = JSON.parse(before);
      } catch (e) {
        throw new AdapterError(ErrorCode.CAPABILITY_MISSING, `settings.json 不是合法 JSON：${e.message}`);
      }
      delete obj[NS];
      const after = JSON.stringify(obj, null, 2) + "\n";
      return { host, file: host.configPath, before, after, baseHash: sha256(before), changed: after !== before, payload: { id: "revert" } };
    },

    async apply(plan) {
      if (!plan.changed) return { backup: null, changed: false };
      return safeWrite({
        file: plan.file,
        after: plan.after,
        baseHash: plan.baseHash,
        home: options.auditHome,
        action: "apply",
        verify: async (text) => {
          let obj;
          try {
            obj = JSON.parse(text);
          } catch (e) {
            return { ok: false, reason: `写后 JSON 解析失败：${e.message}` };
          }
          for (const [k, v] of Object.entries(plan.payload.patch.json)) {
            if (JSON.stringify(obj?.[NS]?.[k]) !== JSON.stringify(v)) return { ok: false, reason: `读回 ${NS}.${k} 不匹配` };
          }
          return { ok: true };
        },
      });
    },

    async revert(host) {
      const plan = await this.planRevert(host);
      if (!plan.changed) return { backup: null, changed: false };
      return safeWrite({ file: plan.file, after: plan.after, baseHash: plan.baseHash, home: options.auditHome, action: "revert" });
    },

    async verifyHost(host, payload) {
      const text = await readOrNull(host.configPath);
      if (text === null) return { ok: false, reason: "settings.json 不存在" };
      const ns = getJsonNamespace(text, NS);
      if (!ns) return { ok: false, reason: `缺少命名空间 ${NS}` };
      if (!payload?.patch?.json) return { ok: false, skipped: true, reason: "payload 未声明 patch.json → 未验证" };
      for (const [k, v] of Object.entries(payload.patch.json)) {
        if (JSON.stringify(ns[k]) !== JSON.stringify(v)) return { ok: false, reason: `${NS}.${k} 不匹配` };
      }
      return { ok: true, source: "file-readback" };
    },
  };
}
