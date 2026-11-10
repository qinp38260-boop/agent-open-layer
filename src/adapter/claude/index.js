/**
 * Claude Code adapter（settings.json）
 *
 * 依据（不是猜）：官方包 @anthropic-ai/claude-code 2.1.322
 *   · sdk-tools.d.ts: mode = default | acceptEdits | auto | dontAsk | plan | bypassPermissions
 *   · claude.exe 字符串: ~/.claude/settings.json、permissions.{allow,deny,ask,additionalDirectories}
 *     规则形如 "Bash(git *)"、"Read(~/.zshrc)"、"Edit(.claude-test/specs/**)"
 *   · "Cannot set permission mode to bypassPermissions because the session was not launched with
 *      --dangerously-skip-permissions" → bypass 模式不由我们代设
 * 证据等级：⚠️ 包内取证（binary + d.ts），**未在真机运行**（本机没装 claude CLI）。
 * 写法：JSON 深合并（数组并集，幂等）；revert 用 sidecar state 精确摘掉我们加的条目。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AdapterError, ErrorCode } from "../types.js";
import { readOrNull, sha256, safeWrite } from "../../core/safe-write.js";
import { mergeJsonKey } from "../../core/key-merge.js";

const stateFileFor = (configPath) => `${configPath}.oag-state.json`;

const readState = (p) => {
  try {
    return JSON.parse(fs.readFileSync(stateFileFor(p), "utf8"));
  } catch {
    return null;
  }
};

function writeState(p, state) {
  const tmp = `${stateFileFor(p)}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", flag: "wx" });
  fs.renameSync(tmp, stateFileFor(p));
}

export function claudeAdapter(options = {}) {
  return {
    id: "claude-code",

    async detect(env = process.env) {
      const home = options.home ?? env.CLAUDE_CONFIG_DIR ?? path.join(env.USERPROFILE ?? env.HOME ?? "", ".claude");
      if (!fs.existsSync(home)) throw new AdapterError(ErrorCode.HOST_NOT_FOUND, `Claude 配置目录不存在：${home}`);
      const configPath = options.configPath ?? path.join(home, "settings.json");
      return { id: "claude-code", version: options.version ?? "2.1.322(包内取证)", configPath };
    },

    capabilities() {
      return {
        managedBlock: false,
        format: "json",
        commentSafe: false,
        keyMerge: true,
        permissions: true,
        revert: true,
        autoContinue: false, // 需 Stop hook，配置层做不到
      };
    },

    async plan(host, payload) {
      const patch = payload?.patch?.json;
      if (!patch) throw new AdapterError(ErrorCode.CAPABILITY_MISSING, "claude adapter 需要 payload.patch.json");
      const before = await readOrNull(host.configPath);
      let after = before ?? "{}";
      const added = {};
      for (const [k, v] of Object.entries(patch)) {
        after = mergeJsonKey(after, k, v);
        added[k] = v;
      }
      return { host, file: host.configPath, before, after, baseHash: sha256(before), changed: after !== (before ?? ""), payload, state: { keys: added } };
    },

    async planRevert(host) {
      const state = readState(host.configPath);
      if (!state?.keys) return { host, file: host.configPath, before: null, after: null, baseHash: null, changed: false };
      const before = await readOrNull(host.configPath);
      let obj;
      try {
        obj = JSON.parse(before ?? "{}");
      } catch (e) {
        throw new AdapterError(ErrorCode.CAPABILITY_MISSING, `settings.json 不是合法 JSON：${e.message}`);
      }
      for (const [k, v] of Object.entries(state.keys)) {
        if (!obj[k] || typeof obj[k] !== "object") continue;
        for (const [sub, val] of Object.entries(v)) {
          if (Array.isArray(val) && Array.isArray(obj[k][sub])) {
            obj[k][sub] = obj[k][sub].filter((x) => !val.includes(x));
            if (!obj[k][sub].length) delete obj[k][sub];
          } else if (obj[k][sub] === val) {
            delete obj[k][sub];
          }
        }
        if (!Object.keys(obj[k]).length) delete obj[k];
      }
      const after = JSON.stringify(obj, null, 2) + String.fromCharCode(10);
      return { host, file: host.configPath, before, after, baseHash: sha256(before), changed: after !== (before ?? ""), payload: { id: "revert" } };
    },

    async apply(plan) {
      if (!plan.changed) return { backup: null, changed: false };
      writeState(plan.file, { at: new Date().toISOString(), file: plan.file, keys: plan.state.keys });
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
            for (const [sub, val] of Object.entries(v)) {
              const got = obj?.[k]?.[sub];
              if (Array.isArray(val)) {
                if (!Array.isArray(got) || !val.every((x) => got.includes(x))) return { ok: false, reason: `读回 ${k}.${sub} 缺少条目` };
              } else if (got !== val) return { ok: false, reason: `读回 ${k}.${sub} 不匹配` };
            }
          }
          return { ok: true };
        },
      });
    },

    async revert(host) {
      const plan = await this.planRevert(host);
      if (!plan.changed) return { backup: null, changed: false };
      const r = await safeWrite({ file: plan.file, after: plan.after, baseHash: plan.baseHash, home: options.auditHome, action: "revert" });
      try {
        fs.rmSync(stateFileFor(host.configPath), { force: true });
      } catch {
        /* ignore */
      }
      return r;
    },

    /** 只读校验：我们声明的条目必须在数组里；没有声明就 skipped（未验证≠通过） */
    async verifyHost(host, payload) {
      const text = await readOrNull(host.configPath);
      if (text === null) return { ok: false, reason: "settings.json 不存在" };
      const patch = payload?.patch?.json;
      if (!patch) return { ok: false, skipped: true, reason: "payload 未声明 patch.json → 未验证" };
      let obj;
      try {
        obj = JSON.parse(text);
      } catch (e) {
        return { ok: false, reason: `settings.json 解析失败：${e.message}` };
      }
      for (const [k, v] of Object.entries(patch)) {
        for (const [sub, val] of Object.entries(v)) {
          const got = obj?.[k]?.[sub];
          if (Array.isArray(val)) {
            if (!Array.isArray(got) || !val.every((x) => got.includes(x))) return { ok: false, reason: `${k}.${sub} 缺少条目` };
          } else if (got !== val) return { ok: false, reason: `${k}.${sub} 不匹配` };
        }
      }
      return { ok: true, source: "file-readback", evidence: "package-level" };
    },
  };
}
