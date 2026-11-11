#!/usr/bin/env node
/**
 * 用"临时密钥"跑一次远端 workflow，跑完立刻删掉 secret。
 *
 * 口径（用户定）：运行的时候再配 secret；不明文；只在需要运行时再配。
 *
 * 安全约束（写死在代码里，不靠人记）：
 *   1. 仓库必须是 private —— 公开库直接拒绝
 *   2. 密钥只从本机 .env 读，不打印、不落盘、不写日志
 *   3. 无论成功失败，finally 一定删 secret
 *   4. 依赖 gh CLI（它负责 libsodium 加密，避免手搓 sealed box）
 *
 * 用法：
 *   node scripts/run-with-ephemeral-secret.mjs --repo owner/name --workflow run-agent.yml \
 *        --secret-name DEEPSEEK_API_KEY --env-key DEEPSEEK_API_KEY [--ref main] [--wait]
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const arg = (f, d = null) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};
const has = (f) => process.argv.includes(f);

const repo = arg("--repo");
const workflow = arg("--workflow");
const secretName = arg("--secret-name", "DEEPSEEK_API_KEY");
const envKey = arg("--env-key", "DEEPSEEK_API_KEY");
const ref = arg("--ref", "main");
if (!repo || !workflow) {
  console.error("用法：--repo owner/name --workflow xxx.yml [--secret-name NAME] [--env-key NAME] [--ref main] [--wait]");
  process.exit(2);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

// 1) 仓库必须 private（硬约束）。这一段走纯 REST，不依赖 gh —— 保证"拒绝公开库"永远可用，
//    即使 gh 没装、下载被墙，也不会因为工具缺失而跳过安全检查。
function token() {
  const envFile = arg("--env-file", "D:/Programs/hermes_data/.env");
  try {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*GITHUB_TOKEN\s*=\s*(.+)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  return process.env.GITHUB_TOKEN ?? "";
}
async function repoPrivate(full) {
  const tk = token();
  const r = await fetch(`https://api.github.com/repos/${full}`, {
    headers: { Authorization: `Bearer ${tk}`, Accept: "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return { private: Boolean(j.private), full_name: j.full_name };
}

try {
  const info = await repoPrivate(repo);
  if (!info.private) {
    console.error(`拒绝执行：${repo} 是公开仓库（private=false）。真实运行只能在私库，公开库永不配密钥。`);
    process.exit(3);
  }
  console.log(`  仓库检查通过：${info.full_name} 是私有仓库`);
} catch (e) {
  console.error(`读不到仓库信息，按拒绝处理：${String(e.message).slice(0, 160)}`);
  process.exit(2);
}

// 2) 之后的"写 secret / 触发 / 删 secret"依赖 gh（它负责 libsodium 加密）
const gh = run("gh", ["--version"]);
if (gh.code !== 0) {
  console.error("第二阶段需要 gh CLI（负责 secret 加密）。Windows 安装：winget install --id GitHub.cli");
  console.error("注意：仓库可见性检查已在上面完成，未因缺 gh 而被跳过。");
  process.exit(2);
}

// 2) 从本机 .env 读密钥（不打印）
const envFile = arg("--env-file", "D:/Programs/hermes_data/.env");
let key = "";
try {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*${envKey}\\s*=\\s*(.+)$`));
    if (m) key = m[1].trim().replace(/^["']|["']$/g, "");
  }
} catch {
  console.error(`读不到 ${envFile}`);
  process.exit(2);
}
if (!key) {
  console.error(`.env 里没有 ${envKey}`);
  process.exit(2);
}
console.log(`  密钥来源：${envFile}（${envKey}，长度 ${key.length}，不打印内容）`);

let setOk = false;
try {
  // 3) 配置 secret（gh 内部做 sealed box 加密）
  const set = spawnSync("gh", ["secret", "set", secretName, "--repo", repo, "--body", key], { encoding: "utf8" });
  if (set.status !== 0) {
    console.error(`设置 secret 失败：${(set.stderr ?? "").slice(0, 200)}`);
    process.exit(4);
  }
  setOk = true;
  console.log(`  已临时配置 ${secretName} → ${repo}`);

  // 4) 触发 workflow
  const dispatch = run("gh", ["workflow", "run", workflow, "--repo", repo, "--ref", ref]);
  if (dispatch.code !== 0) {
    console.error(`触发失败：${dispatch.err.slice(0, 200)}`);
    process.exit(5);
  }
  console.log(`  已触发 ${workflow} @ ${ref}`);

  // 5) 可选：等这次运行结束
  if (has("--wait")) {
    const list = run("gh", ["run", "list", "--repo", repo, "--workflow", workflow, "--limit", "1", "--json", "databaseId,status"]);
    let id = "";
    try {
      id = JSON.parse(list.out)[0]?.databaseId ?? "";
    } catch {}
    if (id) {
      console.log(`  等待 run ${id} ...`);
      const w = run("gh", ["run", "watch", String(id), "--repo", repo, "--exit-status"], { timeout: 1800000 });
      console.log(`  运行结束，exit=${w.code}`);
    }
  }
} finally {
  // 6) 无论如何都删（这是硬约束）
  if (setOk) {
    const del = run("gh", ["secret", "delete", secretName, "--repo", repo]);
    console.log(del.code === 0 ? `  已删除临时 secret ${secretName}` : `  ⚠ 删除失败，请手动删：gh secret delete ${secretName} --repo ${repo}`);
  }
}
