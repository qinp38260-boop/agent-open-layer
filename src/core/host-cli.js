/**
 * 跨平台调用宿主 CLI。
 *
 * 两个实测坑：
 * 1) npm 在 git-bash 下装的 bin shim 是 POSIX shell 脚本（无扩展名），Windows CreateProcess
 *    不能直接执行 → execFileSync 报 ENOENT。同名 `.cmd` 才是 Windows 能跑的入口。
 * 2) shell:true 时 Node 把 args 用空格拼起来而**不加引号** → 带空格的 prompt 被拆成多个参数
 *    （实测：`reply with the single word PONG` → "unexpected argument 'with'"）。
 *    所以走 shell 时必须自己引号化。
 */
import fs from "node:fs";
import { execSync, execFileSync } from "node:child_process";

export function resolveHostCli(cli) {
  if (/\.(cmd|bat)$/i.test(cli)) return { cmd: cli, pre: [], shell: true };
  if (process.platform !== "win32") return { cmd: cli, pre: [], shell: false };
  const shim = `${cli}.cmd`;
  if (fs.existsSync(shim)) return { cmd: shim, pre: [], shell: true };
  if (/\.(js|mjs|cjs)$/i.test(cli)) return { cmd: process.execPath, pre: [cli], shell: false };
  return { cmd: cli, pre: [], shell: false };
}

const quote = (s) => {
  const v = String(s);
  return /[\s"&|<>^()]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
};

export function runHost(cli, args, opts = {}) {
  const r = resolveHostCli(cli);
  const all = [...r.pre, ...args];
  if (r.shell) {
    const line = [r.cmd, ...all].map(quote).join(" ");
    return execSync(line, { ...opts, shell: true });
  }
  return execFileSync(r.cmd, all, opts);
}
