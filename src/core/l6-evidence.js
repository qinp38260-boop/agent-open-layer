/**
 * L6 产物晋升：判定"是否真在真实仓库上演练过"
 *
 * 只看两件硬事实：
 *   1. 存在跑前快照 bundle（说明真的跑了 oag run --snapshot）
 *   2. 该 bundle 能被 git 校验通过（说明快照可用，不是空文件）
 * 缺任何一个都只能是 config-only。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function judgeL6({ snapshotDir = process.env.OAG_L6_SNAPSHOT_DIR || "D:/work/repo-demo/.oag-snapshots" } = {}) {
  if (!fs.existsSync(snapshotDir)) {
    return { ok: false, status: "config-only", reason: `未找到演练快照目录：${snapshotDir}` };
  }
  const bundles = fs
    .readdirSync(snapshotDir)
    .filter((f) => f.endsWith(".bundle"))
    .map((f) => path.join(snapshotDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!bundles.length) {
    return { ok: false, status: "config-only", reason: "演练目录存在但没有 bundle" };
  }
  const latest = bundles[0];
  const r = spawnSync("git", ["bundle", "verify", latest], { encoding: "utf8" });
  const verified = r.status === 0 && /complete history|records a complete/i.test(`${r.stdout}${r.stderr}`);
  return {
    ok: verified,
    status: verified ? "probe-verified" : "config-only",
    snapshot: latest,
    bundleCount: bundles.length,
    reason: verified
      ? `真实仓库演练过：${bundles.length} 份跑前快照，最新可被 git 校验（${path.basename(latest)}）`
      : `快照存在但 git 校验未通过：${(r.stderr || r.stdout || "").slice(0, 80)}`,
  };
}
