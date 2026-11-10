/**
 * 策略引擎（v4）：把「动作 × 决策 × 作用域」编译成各宿主能落地的配置，
 * 并**显式报告做不到的部分**（不是静默丢弃）。
 *
 * 设计原则：
 * - deny > ask > allow，与声明顺序无关（确定性，可单测）
 * - 只编译有「已验证语义」的映射；映射不到的进 unsupported，CLI 必须以非零退出码提示
 * - 同一条规则可在多个宿主上有不同落地方式（dsh 用 identity 文本，codex 用 TOML 键）
 */
import { AdapterError, ErrorCode } from "../adapter/types.js";

export const ACTIONS = [
  "READ",
  "WRITE",
  "EXEC_SAFE",
  "EXEC_DESTRUCTIVE",
  "EXEC_INSTALL",
  "EXEC_GIT_WRITE",
  "NET",
];
export const DECISIONS = ["allow", "ask", "deny"];
const PRECEDENCE = { deny: 3, ask: 2, allow: 1 };

/** 校验策略结构；错就抛，不做"尽力而为" */
export function validatePolicy(policy) {
  if (!policy || typeof policy !== "object") throw new AdapterError(ErrorCode.PROFILE_INVALID, "策略必须是对象");
  if (policy.version !== 1) throw new AdapterError(ErrorCode.PROFILE_INVALID, `不支持的策略版本：${policy.version}`);
  const rules = policy.rules ?? [];
  if (!Array.isArray(rules)) throw new AdapterError(ErrorCode.PROFILE_INVALID, "rules 必须是数组");
  rules.forEach((r, i) => {
    if (!ACTIONS.includes(r.action)) {
      throw new AdapterError(ErrorCode.PROFILE_INVALID, `rules[${i}].action 非法：${r.action}（允许：${ACTIONS.join("/")}）`);
    }
    if (!DECISIONS.includes(r.decision)) {
      throw new AdapterError(ErrorCode.PROFILE_INVALID, `rules[${i}].decision 非法：${r.decision}（允许：allow/ask/deny）`);
    }
    if (r.scope !== undefined && (typeof r.scope !== "object" || Array.isArray(r.scope))) {
      throw new AdapterError(ErrorCode.PROFILE_INVALID, `rules[${i}].scope 必须是对象`);
    }
  });
  if (policy.autoContinue && typeof policy.autoContinue.maxContinues === "number" && policy.autoContinue.maxContinues > 10) {
    throw new AdapterError(ErrorCode.PROFILE_INVALID, "autoContinue.maxContinues 硬上限是 10");
  }
  return true;
}

/** 同一 action 多规则冲突时取最严（deny>ask>allow），与顺序无关 */
export function effectiveDecision(policy, action) {
  const hits = (policy.rules ?? []).filter((r) => r.action === action);
  if (!hits.length) return null;
  return hits.reduce((acc, r) => (PRECEDENCE[r.decision] > PRECEDENCE[acc] ? r.decision : acc), "allow");
}

/** 汇总成一张 action → decision 表（便于打印与测试） */
export function decisionTable(policy) {
  const out = {};
  for (const a of ACTIONS) {
    const d = effectiveDecision(policy, a);
    if (d) out[a] = d;
  }
  return out;
}

/**
 * 编译到具体宿主。
 * 只输出「已验证」的落地方式（见 docs/PROBES.md）；映射不到的一律进 unsupported。
 */
export function compile(policy, hostId, caps = {}) {
  validatePolicy(policy);
  const table = decisionTable(policy);
  const unsupported = [];
  const out = { host: hostId, payload: null, unsupported, notes: [] };
  const want = (a) => table[a] ?? null;

  if (hostId === "dsh") {
    // DSH：identity 有已验证的官方键；审批语义是"never=自动拒绝"，不能拿来当 allow
    const lines = [];
    if (policy.identity?.stripHostIdentity) {
      lines.push("- id: system-prompt", "  config:", "    includeHarnessIdentity: false", '    persona: ""');
    }
    if (lines.length) out.payload = { id: "policy", body: lines.join("\n") + "\n", expect: "includeHarnessIdentity:\\s*false" };
    for (const a of ACTIONS) {
      if (!table[a]) continue;
      if (a === "WRITE" || a === "EXEC_SAFE" || a === "EXEC_DESTRUCTIVE" || a === "EXEC_INSTALL" || a === "EXEC_GIT_WRITE" || a === "NET" || a === "READ") {
        unsupported.push({ action: a, decision: table[a], reason: "DSH 该动作无已验证的官方放宽/收紧键（approval.policy=never 语义是自动拒绝，不能当 allow 用）" });
      }
    }
    if (policy.autoContinue?.enabled) unsupported.push({ action: "AUTO_CONTINUE", decision: "allow", reason: "DSH 自动续行无官方键" });
    return out;
  }

  if (hostId === "codex") {
    const toml = {};
    // 已实测：--ask-for-approval 取值 on-request|never，语义分别是「由模型决定何时问」「从不询问」
    const execDecisions = ["EXEC_SAFE", "EXEC_DESTRUCTIVE", "EXEC_INSTALL", "EXEC_GIT_WRITE"].map(want).filter(Boolean);
    if (execDecisions.includes("allow")) toml.approval_policy = '"never"';
    else if (execDecisions.includes("ask")) toml.approval_policy = '"on-request"';
    else if (execDecisions.every((d) => d === "deny")) unsupported.push({ action: "EXEC_*", decision: "deny", reason: "Codex 没有「一律拒绝执行」的键；只能靠 sandbox read-only + 不给 bypass" });
    if (want("READ") === "deny" || want("WRITE") === "deny") toml.sandbox_mode = '"read-only"';
    if (want("READ") === "allow" && want("WRITE") === "allow") toml.sandbox_mode = '"workspace-write"';
    if (want("NET") === "deny") unsupported.push({ action: "NET", decision: "deny", reason: "Codex 无独立网络开关（随 sandbox 模式走）" });
    if (policy.autoContinue?.enabled) unsupported.push({ action: "AUTO_CONTINUE", decision: "allow", reason: "Codex 自动继续需 Stop hook，属 hook 层（v4.1）" });
    if (Object.keys(toml).length) out.payload = { id: "policy", patch: { toml } };
    return out;
  }

  if (hostId === "claude-code") {
    // Claude Code：已实测 JSON 无注释 → 只能命名空间；键语义未取证 → 一律 unsupported
    if (policy.identity?.stripHostIdentity) {
      unsupported.push({ action: "IDENTITY", decision: "allow", reason: "Claude Code 身份句无官方键（CLAUDE.md 只能追加），标 UNDOCUMENTED" });
    }
    for (const a of ACTIONS) {
      if (table[a]) unsupported.push({ action: a, decision: table[a], reason: "Claude Code 权限键语义未取证（本机无 CLI），不落盘以免误导" });
    }
    out.notes.push("Claude Code 适配器当前只做探测与命名空间保留，不做权限写入");
    return out;
  }

  throw new AdapterError(ErrorCode.HOST_NOT_FOUND, `未知宿主：${hostId}`);
}

/** 编译结果里只要有 unsupported，就说明"策略没被完整落地" —— 用来决定退出码 */
export function coverage(compiled) {
  const total = (compiled.payload ? 1 : 0) + compiled.unsupported.length;
  return { landed: compiled.payload ? 1 : 0, total, complete: compiled.unsupported.length === 0 && compiled.payload !== null };
}
