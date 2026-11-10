/**
 * DSH adapter（v3 参考实现）
 * 只回答三件事：宿主在哪/什么版本、该写什么、宿主认不认。
 * 所有写盘动作走 core/safe-write.js。
 */
import fs from "node:fs";
import path from "node:path";
import { AdapterError, ErrorCode } from "../types.js";
import { composeBlock, stripBlock } from "../../core/managed-block.js";
import { readOrNull, sha256, safeWrite } from "../../core/safe-write.js";
import { runHost } from "../../core/host-cli.js";

const PROFILE_RE = /^[A-Za-z0-9._-]+$/;

function assertProfileName(profile) {
  const p = String(profile ?? "");
  if (!PROFILE_RE.test(p) || p.includes("..")) {
    throw new AdapterError(ErrorCode.PROFILE_INVALID, `profile 名不合法：${p.slice(0, 40)}`);
  }
  return p;
}

export function dshAdapter(options = {}) {
  const profile = assertProfileName(options.profile ?? "web");
  const cli = options.cli ?? process.env.OAG_DSH_CLI ?? "dsh";

  return {
    id: "dsh",

    /** 定位宿主：home → profiles/<profile>/cordis.patch.yml；版本读 @deepseek-ai 包的 package.json */
    async detect(env = process.env) {
      const home = options.home ?? env.DSH_HOME ?? path.join(env.USERPROFILE ?? env.HOME ?? "", ".dsh");
      const profiles = path.join(home, "profiles");
      const dir = path.join(profiles, profile);
      if (!fs.existsSync(profiles)) {
        throw new AdapterError(ErrorCode.HOST_NOT_FOUND, `DSH profiles 目录不存在：${profiles}`);
      }
      // 版本探测（乙的坑#3：版本 ≠ 能力，这里只用来记录，能力由 capabilities() 独立声明）
      let version = "unknown";
      const aiBase = path.join(profiles, "node_modules", "@deepseek-ai");
      try {
        version = JSON.parse(fs.readFileSync(path.join(aiBase, "dsh", "package.json"), "utf8")).version ?? "unknown";
      } catch {
        version = "unknown";
      }
      // 双保险：resolve 后必须仍在 profiles 内
      const resolved = path.resolve(dir);
      if (resolved !== path.resolve(profiles) && !resolved.startsWith(path.resolve(profiles) + path.sep)) {
        throw new AdapterError(ErrorCode.PROFILE_INVALID, `profile 路径逃出 profiles：${resolved}`);
      }
      return { id: "dsh", version, configPath: path.join(dir, "cordis.patch.yml") };
    },

    /** 能力是声明，不是从版本推出来的 */
    capabilities() {
      return { managedBlock: true, format: "yaml", commentSafe: true };
    },

    /** 纯函数：算出 before/after/hash，不写盘 */
    async plan(host, payload) {
      const before = await readOrNull(host.configPath);
      const { text: after, mode } = composeBlock(before, payload.body, this.capabilities());
      return {
        host,
        file: host.configPath,
        before,
        after,
        baseHash: sha256(before),
        changed: after !== before,
        mode,
        payload,
      };
    },

    async planRevert(host) {
      const before = await readOrNull(host.configPath);
      const stripped = stripBlock(before ?? "");
      if (stripped.unterminated) {
        throw new AdapterError(ErrorCode.MARKER_CORRUPT, "托管块 BEGIN 存在但缺少 END，拒绝改写");
      }
      const after = stripped.text.trim() === "" ? "[]\n" : stripped.text.replace(/\s*$/, "") + "\n";
      return { host, file: host.configPath, before, after, baseHash: sha256(before), changed: after !== before, payload: { id: "revert", body: "" } };
    },

    async apply(plan) {
      if (!plan.changed) return { backup: null, changed: false };
      return safeWrite({ file: plan.file, after: plan.after, baseHash: plan.baseHash, verify: (text) => this.verifyText(plan, text) });
    },

    async revert(host) {
      const plan = await this.planRevert(host);
      if (!plan.changed) return { backup: null, changed: false };
      // 注意：这里写的是 plan.after（剥离后的内容）；plan.before 是"当前盘上内容"，不是目标
      return safeWrite({ file: plan.file, after: plan.after, baseHash: plan.baseHash });
    },

    /** ① 文本层：块在不在 ② 宿主层：跑 dsh --dump-config 看宿主是否真认（乙的坑#3） */
    async verifyHost(host, payload) {
      const text = await readOrNull(host.configPath);
      if (text === null) return { ok: false, reason: "配置文件不存在" };
      if (!text.includes("# >>> open-agent-gate managed")) return { ok: false, reason: "托管块缺失" };
      if (!payload?.expect) return { ok: false, reason: "未声明 expect 断言 → 未验证（不算通过）", skipped: true };
      try {
        const out = runHost(cli, ["--profile", profile, "--dump-config"], {
          encoding: "utf8",
          timeout: 120000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const ok = payload.expect.test(out);
        return ok ? { ok: true, source: "host-cli" } : { ok: false, reason: `--dump-config 未体现断言 ${payload.expect}` };
      } catch (e) {
        // 跑不动 ≠ 通过：明确 skipped，由 CLI 给非零退出码（甲坑#3）
        return { ok: false, skipped: true, reason: `宿主 CLI 跑不动：${String(e.message).split("\n")[0]}` };
      }
    },

    async verifyText(plan, text) {
      if (!text || !text.includes("# >>> open-agent-gate managed")) return { ok: false, reason: "写入后读回没有托管块" };
      return { ok: true };
    },
  };
}
