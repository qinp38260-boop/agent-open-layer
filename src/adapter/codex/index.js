/**
 * Codex CLI adapter（TOML，无 marker）
 *
 * 两个关键点：
 * 1) 幂等靠"键级合并"（乙的坑#2）：TOML 里放 marker 再重复写同一键会解析冲突
 * 2) revert 必须记得原值：apply 前把「每个键原来的字面量 / 原本不存在」写进 sidecar state，
 *    revert 时按键还原或删除。没 state 就抛错，绝不瞎猜。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AdapterError, ErrorCode } from "../types.js";
import { readOrNull, sha256, safeWrite } from "../../core/safe-write.js";
import { setTomlKey, getTomlKey, removeTomlKey } from "../../core/key-merge.js";
import { runHost } from "../../core/host-cli.js";

const stateFileFor = (configPath) => `${configPath}.oag-state.json`;

function readState(configPath) {
  try {
    return JSON.parse(fs.readFileSync(stateFileFor(configPath), "utf8"));
  } catch {
    return null;
  }
}

function writeState(configPath, state) {
  const tmp = `${stateFileFor(configPath)}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", flag: "wx" });
  fs.renameSync(tmp, stateFileFor(configPath));
}

export function codexAdapter(options = {}) {
  const cli = options.cli ?? process.env.OAG_CODEX_CLI ?? "codex";

  return {
    id: "codex",

    async detect(env = process.env) {
      const home = options.home ?? env.CODEX_HOME ?? path.join(env.USERPROFILE ?? env.HOME ?? "", ".codex");
      if (!fs.existsSync(home)) throw new AdapterError(ErrorCode.HOST_NOT_FOUND, `Codex home 不存在：${home}`);
      const configPath = path.join(home, "config.toml");
      let version = "unknown";
      try {
        version = runHost(cli, ["--version"], {
          encoding: "utf8",
          timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"],
        })
          .trim()
          .split(/\s+/)
          .pop();
      } catch {
        /* CLI 不在 PATH：版本未知，但仍可探测 */
      }
      return { id: "codex", version, configPath };
    },

    capabilities() {
      return { managedBlock: false, format: "toml", commentSafe: true, keyMerge: true, revert: true, probe: true };
    },

    async plan(host, payload) {
      if (!payload?.patch?.toml) throw new AdapterError(ErrorCode.CAPABILITY_MISSING, "codex adapter 需要 payload.patch.toml");
      const before = await readOrNull(host.configPath);
      const keys = {};
      for (const [k, literal] of Object.entries(payload.patch.toml)) {
        keys[k] = { next: literal, orig: getTomlKey(before ?? "", k) ?? null };
      }
      let after = before ?? "";
      for (const [k, literal] of Object.entries(payload.patch.toml)) after = setTomlKey(after, k, literal);
      return { host, file: host.configPath, before, after, baseHash: sha256(before), changed: after !== (before ?? ""), payload, state: { keys } };
    },

    async apply(plan) {
      if (!plan.changed) return { backup: null, changed: false };
      // 先落 state（revert 的唯一依据），再写配置
      writeState(plan.file, { at: new Date().toISOString(), file: plan.file, keys: plan.state.keys });
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

    /** 用 sidecar state 逐键还原；原本不存在就删掉这一行 */
    async revert(host) {
      const state = readState(host.configPath);
      if (!state?.keys) {
        throw new AdapterError(ErrorCode.CAPABILITY_MISSING, `没有 state 文件，无法安全回滚：${stateFileFor(host.configPath)}`);
      }
      const before = await readOrNull(host.configPath);
      let after = before ?? "";
      for (const [k, v] of Object.entries(state.keys)) {
        after = v.orig === null ? removeTomlKey(after, k) : setTomlKey(after, k, v.orig);
      }
      if (after === (before ?? "")) return { backup: null, changed: false };

      const r = await safeWrite({
        file: host.configPath,
        after,
        baseHash: sha256(before),
        home: options.auditHome,
        action: "revert",
        verify: async (text) => {
          for (const [k, v] of Object.entries(state.keys)) {
            const now = getTomlKey(text, k);
            if (v.orig === null && now !== undefined) return { ok: false, reason: `键 ${k} 应被删除` };
            if (v.orig !== null && now !== v.orig) return { ok: false, reason: `键 ${k} 应还原为 ${v.orig}` };
          }
          return { ok: true };
        },
      });
      try {
        fs.rmSync(stateFileFor(host.configPath), { force: true });
      } catch {
        /* ignore */
      }
      return r;
    },

    /** 文本层校验；有 patch 才可能通过，否则 skipped（未验证≠通过） */
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

    /**
     * 行为探针：让**宿主自己**校验配置（乙的坑#3：别只查文本在不在）
     *   ① `--strict-config` → 未知字段会被宿主直接报错（最强的宿主信号）
     *   ② 真跑一次最小对话 → turn.completed + 有回复 才算"宿主接受了配置"
     * 需要模型 API；没 key 就 skipped，绝不当通过。
     */
    async probe(host, opts = {}) {
      const env = opts.env ?? process.env;
      const keyEnv = opts.keyEnv ?? "DEEPSEEK_API_KEY";
      const baseUrl = opts.baseUrl ?? "https://api.deepseek.com/v1";
      const model = opts.model ?? "deepseek-chat";
      if (!env[keyEnv]) return { ok: false, skipped: true, reason: `缺少 ${keyEnv}，probe 未执行（未验证≠通过）`, steps: [] };

      const work = opts.workDir ?? fs.mkdtempSync(path.join(opts.tmpRoot ?? path.dirname(host.configPath), "oag-probe-"));
      fs.mkdirSync(work, { recursive: true });
      const args = [
        "exec", "--strict-config", "--json", "--skip-git-repo-check", "-C", work,
        "-c", "model_provider=deepseek",
        "-c", "model_providers.deepseek.name=DeepSeek",
        "-c", `model_providers.deepseek.base_url=${baseUrl}`,
        "-c", `model_providers.deepseek.env_key=${keyEnv}`,
        "-m", model,
        "reply with the single word PONG",
      ];

      const steps = [];
      let out = "";
      let err = "";
      try {
        out = runHost(cli, args, {
          encoding: "utf8",
          timeout: opts.timeoutMs ?? 180000,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...env, CODEX_HOME: path.dirname(host.configPath) },
        });
      } catch (e) {
        out = String(e.stdout ?? "");
        err = String(e.stderr ?? e.message ?? "");
      }

      const blob = out + err;
      const schemaBad = /unknown configuration field|Error loading config\.toml/i.test(blob);
      steps.push({
        name: "schema-accepted",
        ok: !schemaBad,
        detail: schemaBad ? blob.split("\n").slice(0, 3).join(" ") : "宿主 --strict-config 未报未知字段",
      });

      const turnDone = /"type":"turn\.completed"/.test(out);
      const answered = /PONG/i.test(out) || /"type":"agent_message"/.test(out);
      const spawnErr = /ENOENT|spawnSync/i.test(err);
      steps.push({
        name: "host-ran",
        ok: turnDone && answered,
        detail: turnDone
          ? "turn.completed + 有回复"
          : spawnErr
            ? `宿主 CLI 无法执行（${cli}）—— 检查路径/PATH`
            : `没有 turn.completed；stderr: ${(err || out).split("\n").filter(Boolean).slice(0, 2).join(" ").slice(0, 200)}`,
      });

      try {
        fs.rmSync(work, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      return { ok: steps.every((s) => s.ok), skipped: false, signal: "host-cli", host: { id: host.id, version: host.version }, steps };
    },
  };
}
