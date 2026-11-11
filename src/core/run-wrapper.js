/**
 * oag run —— 监督包装器（P2）
 *
 * 解决的问题（Claude 意见）：
 *   "配置即代码"和"持久化点"是**延迟执行**面：写入时无法判定后果，
 *   事前拦截不确定，但**事后 diff 是确定的**。
 *   所以：运行前在包装器进程里记下基线哈希，运行后重新比对，变了就标 tainted。
 *
 * 同时做两件事：
 *   · 运行前跑 canary（闸门必须在活着），不过就不开跑
 *   · 可选 --snapshot：对 git 仓库做 bundle 快照，出事可回到运行前
 *
 * 局限（写在文档里）：同主体下这只能"把静默失效变成可检测失效"，不能阻止它发生。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

/** 会被"日后用你的权限"执行的东西：写入时无法判定，只能事后比对 */
export const PERSISTENCE_TARGETS = [
  ".git/config",
  ".git/hooks",
  ".gitattributes",
  ".vscode/tasks.json",
  ".vscode/settings.json",
  ".npmrc",
  ".envrc",
  "package.json",
  ".github/workflows",
  "Makefile",
  "conftest.py",
];

function sha256File(p) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return dirHash(p);
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

function dirHash(dir) {
  try {
    const names = fs.readdirSync(dir).sort();
    const h = crypto.createHash("sha256");
    for (const n of names) {
      const p = path.join(dir, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) h.update(dirHash(p));
      else h.update(n + ":" + crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"));
    }
    return "dir:" + h.digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/** 记录一组路径的基线（不存在记 null） */
export function baseline(paths) {
  const out = {};
  for (const p of paths) out[p] = sha256File(p);
  return out;
}

/** 与基线比较，返回变化项 */
export function diffBaseline(base) {
  const changes = [];
  for (const [p, before] of Object.entries(base)) {
    const after = sha256File(p);
    if (before !== after) changes.push({ path: p, before, after, kind: before === null ? "created" : after === null ? "deleted" : "modified" });
  }
  return changes;
}

/** 需要监控的路径：闸门自身 + 宿主配置 + 配置即代码 */
export function watchList({ cwd, codexHome, claudeHome, policyPath }) {
  const list = [];
  const add = (p) => p && list.push(p);
  add(policyPath);
  if (codexHome) {
    add(path.join(codexHome, "hooks.json"));
    add(path.join(codexHome, "oag-guard.mjs"));
    add(path.join(codexHome, "config.toml"));
  }
  if (claudeHome) {
    add(path.join(claudeHome, "settings.json"));
    add(path.join(claudeHome, "oag-guard-claude.mjs"));
  }
  for (const rel of PERSISTENCE_TARGETS) {
    const p = path.join(cwd, rel.split("/").join(path.sep));
    if (fs.existsSync(p)) add(p);
  }
  return list;
}

/**
 * 跑一次被监督的命令
 * @returns {{code:number, tainted:boolean, changes:Array, snapshot?:string, canaryOk:boolean}}
 */
export async function runWatched({ argv, cwd, watch, canaryFn, snapshotRepo, failOnTaint = false, env = null, isFrozen = null, pollMs = 800 }) {
  const result = { code: 0, tainted: false, changes: [], snapshot: null, canaryOk: true };

  // 1) canary 先过（闸门必须活着，否则不跑）
  if (canaryFn) {
    const c = canaryFn();
    result.canaryOk = c.ok;
    if (!c.ok) {
      result.code = 10;
      result.error = "canary 未通过，拒绝开跑";
      return result;
    }
  }

  // 2) 可选 git 快照
  if (snapshotRepo) {
    const dir = path.join(snapshotRepo, ".oag-snapshots");
    fs.mkdirSync(dir, { recursive: true });
    const bundle = path.join(dir, `pre-run-${new Date().toISOString().replace(/[:.]/g, "-")}.bundle`);
    const r = spawnSync("git", ["bundle", "create", bundle, "--all"], { cwd: snapshotRepo, encoding: "utf8" });
    result.snapshot = r.status === 0 ? bundle : `失败：${(r.stderr || "").slice(0, 120)}`;
  }

  // 3) 基线
  const base = baseline(watch);

  // 4) 跑（异步 spawn：要给"会话冻结则杀进程"留出监控窗口）
  // Windows 上 .cmd/.bat 不能直接 spawn（EINVAL），必须过 shell
  const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(String(argv[0]));
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    stdio: "inherit",
    shell: needsShell,
    env: env ? { ...process.env, ...env } : process.env,
  });
  let killedForFrozen = false;
  const timer = isFrozen
    ? setInterval(() => {
        try {
          if (isFrozen()) {
            killedForFrozen = true;
            result.frozen = true;
            child.kill();
          }
        } catch {}
      }, pollMs)
    : null;
  const status = await new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: 1 }));
  });
  if (timer) clearInterval(timer);
  result.code = killedForFrozen ? 13 : status.code ?? 1;
  if (killedForFrozen) result.error = "会话已熔断：越界次数超限，进程被终止";

  // 5) 事后比对
  result.changes = diffBaseline(base);
  result.tainted = result.changes.length > 0;
  if (result.tainted && failOnTaint) result.code = 11;
  return result;
}
