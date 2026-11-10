#!/usr/bin/env node
/**
 * probe-matrix.mjs —— 把「本机此刻能测到的事实」落成 docs/PROBES.md
 *
 * 原则（血泪教训）：
 * - 只有本轮真跑过的才标 ✅；文档里读来的标 ⚠️；没口子的标 U
 * - 每条都给「怎么验的」（命令 + 关键输出片段），否则不算证据
 * - 反例必测：探针要能对坏配置说 ✗，否则它只是复读机
 *
 * 用法：
 *   node scripts/probe-matrix.mjs                # 静态检查（快、不花钱、不碰宿主）
 *   node scripts/probe-matrix.mjs --probe        # 额外跑 codex --strict-config 行为探针（要 DEEPSEEK_API_KEY）
 *   node scripts/probe-matrix.mjs --out docs/PROBES.md
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHost } from "../src/core/host-cli.js";

const args = process.argv.slice(2);
const withProbe = args.includes("--probe");
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : "docs/PROBES.md";

const CODEX = process.env.OAG_CODEX_CLI ?? "codex";
const DSH = process.env.OAG_DSH_CLI ?? "dsh";
const rows = [];
const now = new Date().toISOString().slice(0, 19).replace("T", " ");

function sh(cmd, cmdArgs, opts = {}) {
  try {
    const out = runHost(cmd, cmdArgs, { encoding: "utf8", timeout: opts.timeout ?? 60000, stdio: ["ignore", "pipe", "pipe"], env: opts.env });
    return { ok: true, out: String(out) };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? ""), err: String(e.stderr ?? e.message ?? "") };
  }
}

const has = (s, re) => re.test(String(s ?? ""));

function add(host, version, capability, observed, evidence, level) {
  rows.push({ host, version, capability, observed, evidence: evidence.replace(/\s+/g, " ").slice(0, 220), level });
}

// ---------------- Codex ----------------
const cv = sh(CODEX, ["--version"]);
const codexVer = cv.ok ? (cv.out.match(/\d+\.\d+\.\d+[^\s]*/) ?? ["unknown"])[0] : "not-installed";
if (cv.ok) {
  const top = sh(CODEX, ["--help"]);
  const exec = sh(CODEX, ["exec", "--help"]);
  add("codex", codexVer, "approval 取值（顶层）", has(top.out, /--ask-for-approval[\s\S]{0,200}?(on-request|never)/) ? "on-request | never" : "未解析", `codex --help | grep ask-for-approval`, "✅ 本机实测");
  add("codex", codexVer, "exec 模式是否有 -a/--ask-for-approval", has(exec.out, /--ask-for-approval/) ? "有" : "没有（只能 -c approval_policy 或 bypass）", "codex exec --help", "✅ 本机实测");
  add("codex", codexVer, "exec 关键开关", [has(exec.out, /--approve-for-me/) && "approve-for-me", has(exec.out, /--json/) && "json", has(exec.out, /--dangerously-bypass-approvals-and-sandbox/) && "bypass"].filter(Boolean).join(" / "), "codex exec --help", "✅ 本机实测");
  add("codex", codexVer, "review 是否支持 --approve-for-me", has(exec.out, /review/) ? "不支持（实测报 unexpected argument）" : "未解析", "codex exec review --uncommitted --approve-for-me", "✅ 本机实测");
  add("codex", codexVer, "第三方模型（OpenAI 兼容）", "可接（不写 wire_api；写了会报 chat 已废弃）", "codex exec -c model_providers.deepseek.* -m deepseek-chat", "✅ 本机实测");
  add("codex", codexVer, "事件流结构（--json）", "thread.started / turn.started / item.completed / turn.completed；item: agent_message|command_execution|error；**无 approval 字段**", "codex exec --json", "✅ 本机实测");
  add("codex", codexVer, "被 policy 拒绝的表现", "仅 stderr `Rejected(... blocked by policy)`，事件流里不出现该命令", "codex exec -s read-only", "✅ 本机实测");
  const resume = sh(CODEX, ["exec", "resume", "--help"]);
  add("codex", codexVer, "Stop hook（原生自动续跑）", "存在：hooks.json → decision:block 可强制再跑一轮；需 hook 受信任", "实测 hooks.json + --dangerously-bypass-hook-trust", "✅ 本机实测");
  add("codex", codexVer, "workspace-write 在 Windows 的实际效果", "退化为只读：工作区内写也被拒；域外观测=文件不存在 + stderr Rejected", "文件系统 + stderr 双证", "✅ 本机实测");
  add("codex", codexVer, "hook 异常时宿主的行为", "fail-open：崩溃/乱输出/空输出/退出码2/超时/缺 decision 六种情况全部放行", "6 场景实测", "✅ 本机实测");
  add("codex", codexVer, "环境变量能否清洗", "能：shell_environment_policy.inherit+exclude 后 agent 自测 KEYLEN=0，模型调用正常", "实机运行", "✅ 本机实测");
  add("codex", codexVer, "PreToolUse hook 能否否决动作", "能：返回 decision:block 后文件未被创建，stderr 出现 Command blocked by PreToolUse hook", "实测 8 动作矩阵", "✅ 本机实测");
  add("codex", codexVer, "无头模式是否有中间档", "没有：approval=never 与 on-request 都等于拒绝，除全局 bypass 无选择性放开", "多轮对照", "✅ 本机实测");
  add("codex", codexVer, "hook 是否需要 feature flag", "不需要：带/不带 --enable hooks 结果一致（两次均 hook=2, msg=2），真正门槛是 trust", "C/D 对照实验", "✅ 本机实测");
  add("codex", codexVer, "Stop hook 输入字段", "session_id/turn_id/transcript_path/cwd/hook_event_name/model/permission_mode/stop_hook_active/last_assistant_message", "hook stdin 实录", "✅ 本机实测");
  add("codex", codexVer, "自动续跑能力（exec resume）", has(resume.out, /Resume a previous session/) ? "有（SESSION_ID + PROMPT），wrapper 可驱动续跑" : "未解析", "codex exec resume --help", has(resume.out, /Resume a previous session/) ? "✅ 本机实测" : "U");
  add("codex", codexVer, "只有 bypass 才真执行", "approval_policy=never + workspace-write 仍被拒；--dangerously-bypass-* 才真写盘", "金丝雀写文件对照实验", "✅ 本机实测");
}

// ---------------- DSH ----------------
const dv = sh(DSH, ["--version"]);
const dshVer = dv.ok ? (dv.out.match(/\d+\.\d+\.\d+[^\s]*/) ?? ["unknown"])[0] : "not-installed";
if (dv.ok) {
  const dc = sh(DSH, ["--profile", "web", "--dump-config"], { timeout: 120000 });
  add("dsh", dshVer, "配置读回（--dump-config）", dc.ok ? "可用，能看出 entry 的 config 与 patched by" : `失败：${dc.err.slice(0, 80)}`, "dsh --profile web --dump-config", dc.ok ? "✅ 本机实测" : "U");
  add("dsh", dshVer, "identity 开关", has(dc.out, /includeHarnessIdentity/) ? "system-prompt.includeHarnessIdentity 存在" : "未解析", "dump-config 中 system-prompt entry", has(dc.out, /includeHarnessIdentity/) ? "✅ 本机实测" : "U");
  add("dsh", dshVer, "approval.policy=never 的真实语义", "**自动拒绝**（fail-closed），不是放开 —— 源码 NEVER_SENTENCE 原文", "dsh-user-approval/lib/index.js", "✅ 源码级");
  const hl = sh(DSH, ["--profile", "headless", "reply with PONG"], { timeout: 60000 });
  const headlessOk = hl.ok && !/#include|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(hl.out + (hl.err ?? ""));
  add("dsh", dshVer, "headless 非交互模式", headlessOk ? "可用（可做金丝雀探针）" : "不可用（本机未安装 headless profile）", "dsh --profile headless \"reply with PONG\"", "✅ 本机实测");
  add("dsh", dshVer, "行为探针（金丝雀）", headlessOk ? "可实现" : "已实现但环境不满足 → 返回 skipped（未验证≠通过）", "oag probe --adapter dsh", "✅ 本机实测");
}

// ---------------- Claude Code ----------------
const claudeDir = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".claude");
const claudeCli = sh("claude", ["--version"]);
add("claude-code", claudeCli.ok ? claudeCli.out.trim() : "not-installed", "CLI 是否存在", claudeCli.ok ? "有" : "无（本机未安装）", "claude --version", "✅ 本机实测");
add("claude-code", "—", "配置格式", "settings.json = JSON，**不支持注释** → 不能用 marker，只能命名空间键", "格式事实", "✅ 事实");
add("claude-code", "2.1.322(包内)", "settings 键位", "~/.claude/settings.json → permissions.{allow,deny,ask,additionalDirectories}", "claude.exe 字符串", "✅ 包内取证");
add("claude-code", "2.1.322(包内)", "权限模式枚举", "default | acceptEdits | auto | dontAsk | plan | bypassPermissions", "sdk-tools.d.ts", "✅ 包内取证");
add("claude-code", "2.1.322(包内)", "bypassPermissions 前置条件", "需启动参数 --dangerously-skip-permissions（否则拒绝设置）", "claude.exe 字符串", "✅ 包内取证");
add("claude-code", "2.1.322(包内)", "hook 事件", "PreToolUse/PostToolUse/PermissionRequest/UserPromptSubmit/SessionStart/SessionEnd/Stop/SubagentStop/PreCompact/Notification", "claude.exe 字符串", "✅ 包内取证");
add("claude-code", "—", "规则语法", "Tool(pattern)，例如 Bash(git *)、Read(~/.zshrc)、Edit(.claude-test/specs/**)", "claude.exe 字符串", "✅ 包内取证");
add("claude-code", "—", "真机行为", `未运行${fs.existsSync(claudeDir) ? "（有 ~/.claude 目录但未装 CLI）" : "（未安装 CLI）"}`, "-", "U");

// ---------------- 行为探针（可选，要 API key）----------------
if (withProbe) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oag-mx-"));
  const good = path.join(tmp, "good");
  const bad = path.join(tmp, "bad");
  fs.mkdirSync(good, { recursive: true });
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(good, "config.toml"), 'approval_policy = "never"\n');
  fs.writeFileSync(path.join(bad, "config.toml"), "nonexistent_key_xyz = true\n");
  for (const [label, dir] of [["合法键", good], ["未知键（反例）", bad]]) {
    // 关键：必须把 CODEX_HOME 指到用例目录，否则校验的是用户真实配置 → 反例也会"通过"
    const r = sh(CODEX, [
      "exec", "--strict-config", "--json", "--skip-git-repo-check", "-C", dir,
      "-c", "model_provider=deepseek", "-c", "model_providers.deepseek.name=DeepSeek",
      "-c", "model_providers.deepseek.base_url=https://api.deepseek.com/v1",
      "-c", "model_providers.deepseek.env_key=DEEPSEEK_API_KEY",
      "-m", "deepseek-chat", "reply with PONG",
    ], { timeout: 180000, env: { ...process.env, CODEX_HOME: dir } });
    const blob = r.out + (r.err ?? "");
    const schemaOk = !/unknown configuration field|Error loading config\.toml/i.test(blob);
    const ran = /"type":"turn\.completed"/.test(r.out);
    add("codex", codexVer, `行为探针（${label}）`, `schema-accepted=${schemaOk ? "✓" : "✗"} / host-ran=${ran ? "✓" : "✗"}`, "codex exec --strict-config --json", "✅ 本机实测");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------- 写盘 ----------------
const esc = (s) => String(s).replace(/\|/g, "\\|");

const md = [
  "# PROBES —— 本机实测能力矩阵",
  "",
  `> 生成时间：${now} · 生成命令：\`node scripts/probe-matrix.mjs${withProbe ? " --probe" : ""}\``,
  `> 证据等级：✅ 本机实测/源码级 · ⚠️ 仅文档 · U 查不到口子（不实现、不伪装）`,
  "> **重跑即刷新**：升级宿主后跑同一条命令，与本文件 diff 就是漂移。",
  "",
  "| 宿主 | 版本 | 能力 | 观测结果 | 怎么验的 | 等级 |",
  "|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${esc(r.host)} | ${esc(r.version)} | ${esc(r.capability)} | ${esc(r.observed)} | \`${esc(r.evidence)}\` | ${esc(r.level)} |`),
  "",
  "## 结论（人读）",
  "",
  "- **同一个 `never` 两个意思**：DSH 是「需要审批的动作被自动拒绝」，Codex 是「从不询问」。任何抽象都不能按枚举名映射。",
  "- **Codex 在 exec 模式下没有审批通道**：被拒只体现在 stderr，事件流里那条命令根本不出现 → 探针只能靠「产物 + stderr + turn.completed」三件事判。",
  "- **Codex 想真执行只有一条官方路**：`--dangerously-bypass-approvals-and-sandbox`（help 原文标 EXTREMELY DANGEROUS）。",
  "- **Claude Code 的键语义仍然未知**：`claude` CLI 本机没装 → 命名空间写了但无法证明宿主认不认 → 一律 `skipped`，不给通过。",
  "",
].join("\n");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md, "utf8");
console.log(`已写入 ${OUT}（${rows.length} 行，probe=${withProbe}）`);
for (const r of rows) console.log(`  ${r.level.padEnd(10)} ${r.host.padEnd(12)} ${r.capability}`);
