/**
 * L0 主体隔离 · 环境探测与方案推荐
 *
 * 设计前提（已实测）：闸门与 ACL 都挡不住"主动拆解"，真正的边界必须换安全主体。
 * 本模块不做隔离，只回答一个问题：**这台机器上现在能用哪条隔离路径，怎么用。**
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

const run = (cmd, args = [], timeout = 8000) => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout, windowsHide: true });
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), code: r.status };
  } catch (e) {
    return { ok: false, out: String(e.message), code: -1 };
  }
};

export function detect() {
  const d = { platform: process.platform, home: os.homedir() };

  if (process.platform === "win32") {
    const ed = run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "/v", "EditionID"]);
    const m = ed.out.match(/EditionID\s+REG_SZ\s+(\S+)/);
    d.edition = m ? m[1] : null;
    d.sandboxFeature = Boolean(d.edition && /Professional|Enterprise|Education/i.test(d.edition));
  }

  const wslVersion = run("wsl", ["--version"]);
  d.wslInstalled = wslVersion.ok || /WSL/i.test(wslVersion.out);
  // 服务被禁用时 --status 会返回 0x80070422
  const wslStatus = run("wsl", ["--status"]);
  const wslOut = wslStatus.out || "";
  if (/0x80070422/.test(wslOut)) {
    d.wslServiceRunning = false;
    d.wslError = "服务已禁用 (ERROR_SERVICE_DISABLED 0x80070422)";
  } else if (!wslStatus.ok) {
    d.wslServiceRunning = false;
    d.wslError = `wsl --status 返回 ${wslStatus.code}`;
  } else {
    const list = run("wsl", ["-l", "-v"]);
    d.wslServiceRunning = list.ok && !/0x80070422/.test(list.out || "");
    d.wslError = d.wslServiceRunning ? null : "发行版列表读取失败（服务可能未启动）";
  }

  // 独立账号（L0 最便宜的一条）现状探测
  const acc = run("net", ["user", process.env.OAG_AGENT_ACCOUNT || "agent_runner"]);
  d.agentAccount = process.env.OAG_AGENT_ACCOUNT || "agent_runner";
  d.agentAccountExists = acc.ok && !/找不到|not found|没有此用户/i.test(acc.out);
  const workDir = process.env.OAG_AGENT_WORK || "D:/work";
  d.agentWorkDir = workDir;
  d.agentWorkDirExists = fs.existsSync(workDir);
  if (d.agentWorkDirExists) {
    const acl = run("icacls", [workDir]);
    d.agentWorkDirGranted = acl.ok && new RegExp(d.agentAccount + ":.*\(M\)|" + d.agentAccount + ":\(OI\)", "i").test(acl.out);
  } else d.agentWorkDirGranted = false;

  const docker = run("docker", ["--version"]);
  d.dockerInstalled = docker.ok;
  d.dockerVersion = docker.ok ? docker.out.split("\n")[0] : null;

  return d;
}

/**
 * 给出可用方案（按隔离强度排序），每条含：可用性、前置条件、具体命令、以及"挡不挡得住主动拆解"
 */
export function plan(env = detect()) {
  const opts = [];

  if (process.platform === "win32") {
    opts.push({
      id: "windows-sandbox",
      name: "Windows Sandbox（.wsb，双击即开，用完即毁）",
      isolation: "强：独立内核实例 + 独立文件系统",
      blocksDeliberate: true,
      available: env.sandboxFeature === true,
      why: env.sandboxFeature
        ? "本机是 Pro/Enterprise/Education，功能可用"
        : `本机 EditionID=${env.edition ?? "未知"}，Home 版没有该功能`,
      steps: env.sandboxFeature
        ? ["确认「Windows 沙盒」功能已启用（可选功能）", "双击 sandbox\\agent.wsb", "把工作副本只读挂载进去"]
        : ["需要升级到 Windows 专业版（无法绕过）"],
    });
  }

  opts.push({
    id: "wsl2",
    name: "WSL2 一次性发行版",
    isolation: "中强：独立 Linux 主体 + 独立文件系统（默认能访问 /mnt/d，需手动规避）",
    blocksDeliberate: true,
    available: env.wslInstalled && env.wslServiceRunning,
    why: !env.wslInstalled
      ? "未安装 WSL"
      : env.wslServiceRunning
        ? "WSL 已安装且服务在跑"
        : `WSL 已安装但服务不可用：${env.wslError}`,
    steps: env.wslServiceRunning
      ? ["wsl --export Ubuntu $env:USERPROFILE\\oag-wsl\\rootfs.tar（首次）", "sandbox\\wsl-sandbox.ps1 up", "工作副本 clone 到 /root 下，产物用 git diff 取出"]
      : ["【需管理员】sc config LxssManager start= auto", "【需管理员】net start LxssManager", "之后走上面三步"],
    needsAdmin: !env.wslServiceRunning,
  });

  opts.push({
    id: "docker-devcontainer",
    name: "Docker + devcontainer（VS Code Reopen in Container）",
    isolation: "中：独立镜像与文件系统，共享内核（容器逃逸面小于 VM）",
    blocksDeliberate: "部分（内核共享；建议配合 --cap-drop=ALL --network=none）",
    available: env.dockerInstalled === true,
    why: env.dockerInstalled ? `已装 Docker：${env.dockerVersion}` : "未安装 Docker Desktop（Home 版可用 WSL2 后端）",
    steps: ["安装 Docker Desktop 并启用 WSL2 后端", "仓库根目录打开 → Reopen in Container", "容器内 clone 工作副本，产物走 git diff"],
  });

  opts.push({
    id: "separate-account",
    name: "独立 Windows 账号 + 文件 ACL",
    isolation: "强（对文件系统而言）：另一个安全主体，改不了你的 ACL",
    blocksDeliberate: true,
    available: true,
    configured: Boolean(env.agentAccountExists && env.agentWorkDirGranted),
    why: env.agentAccountExists
      ? `账号 ${env.agentAccount} 已存在；工作目录 ${env.agentWorkDir} ${env.agentWorkDirExists ? (env.agentWorkDirGranted ? "已授权 Modify" : "存在但未授权") : "不存在"}`
      : "任何 Windows 都能做，但需要管理员权限创建账号",
    steps: [
      "【需管理员】net user agent_runner /add",
      "【需管理员】net localgroup Users agent_runner /add",
      "【需管理员】icacls \"D:\\work\" /grant agent_runner:(OI)(CI)M",
      "【需管理员】icacls \"D:\\sensitive\" /deny agent_runner:(OI)(CI)(F)",
      "runas /user:agent_runner \"<codex.exe> exec ...\"",
    ],
    needsAdmin: true,
  });

  return { env, options: opts };
}

/** 渲染成可读文本（CLI 用） */
export function renderPlan(p) {
  const lines = [];
  lines.push(`  环境：${p.env.platform}${p.env.edition ? ` / ${p.env.edition}` : ""}`);
  lines.push(`        WSL=${p.env.wslInstalled ? (p.env.wslServiceRunning ? "可用" : `已装但不可用(${p.env.wslError})`) : "未装"}` +
    ` | Docker=${p.env.dockerInstalled ? "已装" : "未装"}` +
    (p.env.platform === "win32" ? ` | WindowsSandbox=${p.env.sandboxFeature ? "可用" : "不可用"}` : ""));
  lines.push("");
  for (const o of p.options) {
    const flag = o.available ? "✅ 可用" : "⛔ 不可用";
    lines.push(`  ${flag}  ${o.name}`);
    lines.push(`        隔离强度：${o.isolation}`);
    lines.push(`        挡主动拆解：${o.blocksDeliberate === true ? "能" : o.blocksDeliberate}`);
    lines.push(`        原因：${o.why}${o.needsAdmin ? "（需要管理员）" : ""}`);
    for (const s of o.steps) lines.push(`          · ${s}`);
    lines.push("");
  }
  return lines.join("\n");
}
