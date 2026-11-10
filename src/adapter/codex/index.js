/**
 * Codex CLI adapter（TOML，无 marker）
 * 乙的坑#2：TOML 虽然有注释，但**逐键合并**才是幂等做法（marker 里重复写同一键会让 TOML 解析冲突），
 * 所以这里走 key-merge：改 ~/.codex/config.toml 的顶层键，已存在则原地替换。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AdapterError, ErrorCode } from "../types.js";
import { readOrNull, sha256, safeWrite } from "../../core/safe-write.js";
import { setTomlKey, getTomlKey } from "../../core/key-merge.js";

export function codexAdapter(options = {}) {
  const cli = options.cli ?? "codex";

  return {
    id: "codex",

    async detect(env = process.env) {
      const home = options.home ?? env.CODEX_HOME ?? path.join(env.USERPROFILE ?? env.HOME ?? "", ".codex");
      if (!fs.existsSync(home)) throw new AdapterError(ErrorCode.HOST_NOT_FOUND, `Codex home 不存在：${home}`);
      const configPath = path.join(home, "config.toml");
      let version = "unknown";
      try {
        version = execFileSync(cli, ["--version"], {
          encoding: "utf8",
          shell: /\.(cmd|bat)$/i.test(cli),
          timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim().split(/\s+/).pop();
      } catch {
        /* CLI 不在 PATH 也算探测成功：版本未知 */
      }
      return { id: "codex", version, configPath };
    },

    capabilities() {
      return { managedBlock: false, format: "toml", commentSafe: true, keyMerge: true };
    },

    async plan(host, payload) {
      if (!payload?.patch?.toml) throw new AdapterError(ErrorCode.CAPABILITY_MISSING, "codex adapter 需要 payload.patch.toml");
      const before = await readOrNull(host.configPath);
      let after = before ?? "";
      for (const [k, literal] of Object.entries(payload.patch.toml)) after = setTomlKey(after, k, literal);
      return { host, file: host.configPath, before, after, baseHash: sha256(before), changed: after !== (before ?? ""), payload };
    },

    async planRevert(host) {
      return { host, file: host.configPath, before: null, after: null, baseHash: null, changed: false };
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
          for (const [k, literal] of Object.entries(plan.payload.patch.toml)) {
            if (getTomlKey(text, k) !== literal) return { ok: false, reason: `读回键 ${k} 不等于 ${literal}` };
          }
          return { ok: true };
        },
      });
    },

    async revert() {
      throw new AdapterError(ErrorCode.CAPABILITY_MISSING, "codex adapter 的 revert 未实现（需记录原值才能安全回滚）");
    },

    /** 文本层校验；有 expect 才可能判定通过，否则 skipped（未验证≠通过） */
    async verifyHost(host, payload) {
      const text = await readOrNull(host.configPath);
      if (text === null) return { ok: false, reason: "config.toml 不存在" };
      const keys = Object.keys(payload?.patch?.toml ?? {});
      if (!keys.length) return { ok: false, skipped: true, reason: "payload 未声明 patch.toml → 未验证" };
      for (const k of keys) {
        if (getTomlKey(text, k) === undefined) return { ok: false, reason: `键 ${k} 不在文件里` };
      }
      return { ok: true, source: "file-readback" };
    },
  };
}
