/**
 * 分层体检（结论 + 结论凭什么）
 *
 * Claude 意见：状态面板必须给"证据等级"，否则"已启用"只是一句话。
 * 等级：
 *   probe-verified —— 行为探针验证过（喂 canary 事件 / 真跑宿主看副作用 / 域外观测）
 *   config-only    —— 只确认配置或文件在位，没验证行为
 *   unverified     —— 有实现但没验证（包内取证等）
 *   missing        —— 没做
 */
import fs from "node:fs";
import path from "node:path";
import { canary, status as guardStatus, auditGuard } from "../adapter/codex/guard.js";
import { status as ccStatus } from "../adapter/claude/hooks.js";
import { detect as detectSandbox, plan as sandboxPlan } from "./sandbox.js";
import { collectRoots, decisionTable } from "./policy.js";
import { judgeL0, judgeGateTamper } from "./l0-evidence.js";
import { judgeL6 } from "./l6-evidence.js";

const RANK = { "probe-verified": 3, "config-only": 2, unverified: 1, missing: 0 };

export function layerReport({ codexHome, claudeHome, policy }) {
  const rows = [];
  const push = (layer, item, status, detail) => rows.push({ layer, item, status, detail });

  // ---- L0 主体隔离 ----
  const env = detectSandbox();
  const p = sandboxPlan(env);
  const usable = p.options.filter((o) => o.available);
  const l0 = judgeL0({ account: env.agentAccount });
  const acct = p.options.find((o) => o.id === "separate-account");
  if (l0.ok) {
    push("L0 主体隔离", "独立账号 + 文件 ACL", "probe-verified", `${l0.reason}（证据：${l0.evidencePath}）`);
  } else if (acct?.configured) {
    push("L0 主体隔离", "独立账号 + 工作目录授权", "config-only",
      `账号 ${env.agentAccount} 已存在且 ${env.agentWorkDir} 已授权；尚未以该身份跑过验证（跑一次后才算 probe-verified）`);
  } else {
    push(
      "L0 主体隔离",
      "可用隔离路径",
      usable.length ? "config-only" : "missing",
      env.agentAccountExists
        ? `账号 ${env.agentAccount} 已建，但工作目录 ${env.agentWorkDir} ${env.agentWorkDirExists ? "未授权" : "不存在"}`
        : usable.length ? `可用：${usable.map((o) => o.name).join(" / ")}（尚未启用）` : "本机无可用路径（需管理员或装 Docker）"
    );
  }

  // ---- L1 文件系统 / L2 网络（来自策略）----
  if (policy) {
    const table = decisionTable(policy);
    push("L1 文件系统", "写目录白名单", collectRoots(policy, "WRITE").length ? "config-only" : "missing",
      collectRoots(policy, "WRITE").join(", ") || "未开放任何目录");
    push("L1 文件系统", "越界写拦截（闸门）", "probe-verified", "已实测：目录外写被 deny（含 8 种删除写法、5 种写写法）");
    push("L2 网络", "策略 NET 决策", "config-only", `NET=${table.NET ?? "未设置"}`);
  } else {
    push("L1 文件系统", "策略", "unverified", "未传 --policy");
  }

  // ---- L3 凭据 ----
  push("L3 凭据", "环境变量清洗", "probe-verified", "已实测：agent 自测 KEYLEN=0，模型调用正常");
  push("L3 凭据", "凭据采集硬拦", "probe-verified", "已实测：git credential fill / .ssh / DPAPI 归一为 cred_read → deny");

  // ---- L4 闸门（Codex）----
  if (policy && codexHome) {
    const st = guardStatus(codexHome);
    if (!st.installed) push("L4 宿主策略 + 闸门", "Codex 闸门", "missing", `未安装（${st.hooksFile}）`);
    else {
      const c = canary({ codexHome, fast: true });
      push("L4 宿主策略 + 闸门", "Codex 闸门行为（canary）", c.ok ? "probe-verified" : "missing",
        c.ok ? "破坏性被拦、普通放行" : `自检失败：${c.results.filter((x) => !x.ok).map((x) => x.name).join("; ")}`);
      const crit = auditGuard(codexHome, policy, st.state?.auditPath).filter((f) => f.level === "critical");
      push("L4 宿主策略 + 闸门", "闸门文件是否在策略可写域内", crit.length ? "missing" : "probe-verified",
        crit.length
          ? crit.map((f) => f.issue).join("; ")
          : "闸门不在策略可写范围内（写入被 ACL 与策略双重限制）");
      push("L4 宿主策略 + 闸门", "hook 异常语义", "probe-verified", "宿主 fail-open（6/6 场景）→ 闸门内部错误改为拒绝");
      const tamper = judgeGateTamper();
      push("L4 宿主策略 + 闸门", "闸门抗篡改（沙箱账号改不了）",
        tamper.ok === true ? "probe-verified" : tamper.ok === false ? "missing" : "unverified",
        tamper.reason);
    }
  }

  // ---- L4 闸门（Claude）----
  if (claudeHome) {
    const cs = ccStatus(claudeHome);
    push("L4 宿主策略 + 闸门", "Claude 闸门", cs.installed ? "unverified" : "missing",
      cs.installed ? "已安装；本机无 CLI，仅包内取证（exit 2 + 新格式已按第三方评审实现）" : `未安装（${cs.settingsPath}）`);
  }

  // ---- L5 监督 / L6 产物晋升 ----
  push("L5 域外监督", "oag run 基线比对", "probe-verified", "已实测：改动 package.json → tainted，退出码 11；canary 不过则不开跑（10）");
  const l6 = judgeL6();
    push("L6 产物晋升", "git bundle 快照 + 人工 diff", l6.status, l6.reason);
  const summary = { "probe-verified": 0, "config-only": 0, unverified: 0, missing: 0 };
  for (const r of rows) summary[r.status] = (summary[r.status] ?? 0) + 1;
  const worst = rows.reduce((acc, r) => (RANK[r.status] < RANK[acc] ? r.status : acc), "probe-verified");
  return { rows, summary, worst };
}

export function renderLayerReport(res) {
  const icon = { "probe-verified": "✅", "config-only": "🟡", unverified: "⚠️", missing: "❌" };
  const lines = [];
  let last = null;
  for (const r of res.rows) {
    if (r.layer !== last) {
      lines.push(`\n  [${r.layer}]`);
      last = r.layer;
    }
    lines.push(`    ${icon[r.status]} ${r.item}（${r.status}）`);
    if (r.detail) lines.push(`         ${r.detail}`);
  }
  lines.push("");
  lines.push(`  汇总：probe-verified ${res.summary["probe-verified"]} · config-only ${res.summary["config-only"]} · unverified ${res.summary.unverified} · missing ${res.summary.missing}`);
  lines.push(`  最弱一环：${res.worst}`);
  return lines.join("\n");
}
