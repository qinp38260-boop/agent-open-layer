/**
 * 策略引擎（v4）：把「动作 × 决策 × 作用域」编译成各宿主能落地的配置，
 * 并**显式报告做不到的部分**（不是静默丢弃）。
 *
 * 设计原则：
 * - deny > ask > allow，与声明顺序无关（确定性，可单测）
 * - 只编译有「已验证语义」的映射；映射不到的进 unsupported，CLI 必须以非零退出码提示
 * - 同一条规则可在多个宿主上有不同落地方式（dsh 用 identity 文本，codex 用 TOML 键）
 */
import crypto from "node:crypto";
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

/** 策略指纹：内容哈希 + 决策摘要，用于审计里"这条记录对应哪份策略" */
export function policyRef(policy) {
  validatePolicy(policy);
  const canonical = JSON.stringify({
    version: policy.version,
    identity: policy.identity ?? null,
    autoContinue: policy.autoContinue ?? null,
    rules: (policy.rules ?? []).map((r) => ({ action: r.action, decision: r.decision, scope: r.scope ?? {} })),
  });
  const table = decisionTable(policy);
  return {
    hash: crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16),
    rules: (policy.rules ?? []).length,
    decisions: table,
    identity: Boolean(policy.identity?.stripHostIdentity),
    autoContinue: policy.autoContinue?.enabled ?? false,
  };
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
/** 从 WRITE=allow 的 scope.paths 里取绝对目录，作为 Codex 的 writable_roots */
export function collectRoots(policy, action) {
  const out = new Set();
  const isAbs = (p) => /^[A-Za-z]:[\/]/.test(p) || p.startsWith("/");
  for (const r of policy.rules ?? []) {
    if (r.action !== action || r.decision !== "allow") continue;
    for (const raw of r.scope?.paths ?? []) {
      const p = String(raw).replace(/^!/, "");
      if (!isAbs(p)) continue;
      // 去掉 glob 部分，保留静态目录前缀
      const cut = p.search(/[*?[{]/);
      const base = cut === -1 ? p : p.slice(0, p.lastIndexOf("/", cut) + 1) || p;
      out.add(base.replace(/[\/]+$/, "") || "/");
    }
  }
  return [...out];
}

export function collectWritableRoots(policy) {
  return collectRoots(policy, "WRITE");
}

export function collectReadableRoots(policy) {
  return collectRoots(policy, "READ");
}

/**
 * host × OS 能力矩阵（Claude 意见："编得出来但在此环境无效"比 unsupported 更糟）
 * 三态：
 *   effective        —— 在此宿主 + 此 OS 上确有行为效果（有实测支撑）
 *   ineffective-here —— 键存在，但在当前 OS 上退化/无效（例如 Windows 的 workspace-write）
 *   unsupported      —— 宿主的扩展面里没有对应键
 */
export function capability(hostId, key, os = process.platform) {
  if (hostId === "codex") {
    if (key === "sandbox_mode.workspace-write" && os === "win32") {
      return {
        status: "ineffective-here",
        why: "已实测：Windows 上 workspace-write 退化为只读（工作区内写也被拒）；宿主的 seatbelt/landlock 类沙箱在 Windows 无对应实现",
      };
    }
    if (key === "sandbox_mode.danger-full-access") {
      return { status: "effective", why: "已实测：可写任意位置（等于无边界）" };
    }
    if (key === "sandbox_workspace_write.network_access") {
      return { status: "effective", why: "已实测：宿主接受该键（严格配置校验无报错）" };
    }
    if (key === "shell_environment_policy") {
      return { status: "effective", why: "已实测：agent 自测 KEYLEN=0（密钥不在工具环境），模型调用正常" };
    }
    if (key === "pretooluse_hook") {
      return { status: "effective", why: "已实测：可真实否决动作；但宿主对 hook 异常 fail-open（6 场景），闸门必须自身 fail-closed" };
    }
  }
  if (hostId === "claude-code") {
    if (key === "permissions") return { status: "effective", why: "包内取证（settings.json → permissions.{allow,deny,ask}）" };
    if (key === "pretooluse_hook") {
      return { status: "unverified", why: "包内取证：hooks.PreToolUse 存在；本机无 CLI，未真机验证；据 Claude 评述 exit 2 才是阻断" };
    }
  }
  if (hostId === "dsh") {
    if (key === "identity") return { status: "effective", why: "已实测：cordis.patch.yml 的 system-prompt 段被宿主接受" };
    if (key === "pretooluse_hook") return { status: "unsupported", why: "DSH 无 PreToolUse hook 入口" };
  }
  return { status: "unsupported", why: "宿主扩展面无此键" };
}

export function compile(policy, hostId, caps = {}) {
  validatePolicy(policy);
  const table = decisionTable(policy);
  const unsupported = [];
  const os = caps.os ?? process.platform;
  const out = { host: hostId, payload: null, unsupported, notes: [], capabilities: [] };
  const cap = (key) => {
    const c = capability(hostId, key, os);
    out.capabilities.push({ key, ...c });
    if (c.status === "ineffective-here") out.notes.push(`⚠ ${key} 在此环境无效：${c.why}`);
    return c;
  };
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
    // ask 优先于 allow：策略里有「要问我」的动作时，不能落成 never（never=从不询问）
    const headless = caps.headless === true;
    if (execDecisions.includes("ask") && !headless) toml.approval_policy = '"on-request"';
    else if (execDecisions.includes("ask") && headless) {
      // 实测：codex exec（无头）里 approval=on-request 无人可问 → 连无害命令都被拒
      toml.approval_policy = '"never"';
      out.notes.push("无头模式：ask 无对象可问 → 落成 never（不弹窗）；危险动作只能靠沙箱 + writable_roots 限制");
    }
    else if (execDecisions.includes("allow")) toml.approval_policy = '"never"';
    else if (execDecisions.every((d) => d === "deny")) unsupported.push({ action: "EXEC_*", decision: "deny", reason: "Codex 没有「一律拒绝执行」的键；只能靠 sandbox read-only + 不给 bypass" });
    if (want("READ") === "deny" || want("WRITE") === "deny") toml.sandbox_mode = '"read-only"';
    if (want("READ") === "allow" && want("WRITE") === "allow") {
      const c = cap("sandbox_mode.workspace-write");
      // 在此环境无效时仍然发出，但明确标注；调用方可用 --require-effective 拒绝继续
      toml.sandbox_mode = '"workspace-write"';
      if (c.status === "ineffective-here") {
        out.notes.push("该键在 Windows 上不产生限制效果：实际隔离必须依赖主体隔离（L0）或闸门");
      }
    }
    // 已实测接受（--strict-config 无报错）：[sandbox_workspace_write] network_access / writable_roots
    const netD = want("NET");
    if (netD === "deny" || netD === "ask") toml["sandbox_workspace_write.network_access"] = "false";
    if (netD === "allow") toml["sandbox_workspace_write.network_access"] = "true";
    if (netD === "ask") out.notes.push("NET=ask 在 Codex 上落成 network_access=false（它只有开/关，没有「问我」）");

    // 已实测接受：shell_environment_policy.inherit / exclude（--strict-config 不报错）
    // 目的：让 agent 的 shell 里根本没有密钥 —— Claude 评审里"最便宜的收益"
    toml["shell_environment_policy.inherit"] = '"core"';
    toml["shell_environment_policy.exclude"] = JSON.stringify([
      "*KEY*", "*TOKEN*", "*SECRET*", "*PASSWORD*", "*CREDENTIAL*", "*SESSION*",
      "AWS_*", "GITHUB_*", "GH_*", "DEEPSEEK_*", "OPENAI_*", "ANTHROPIC_*", "GLM_*",
    ]);
    out.notes.push("已清洗工具环境变量（密钥类不进 agent 的 shell）");

    // 范围化放开：WRITE=allow 的 scope.paths 里取绝对路径 → writable_roots（这是"分开"的关键键）
    const roots = collectWritableRoots(policy);
    if (roots.length && toml.sandbox_mode === '"workspace-write"') {
      toml["sandbox_workspace_write.writable_roots"] = JSON.stringify(roots);
      out.notes.push(`writable_roots=${roots.length} 个目录（写只限这些目录，其余仍被沙箱拦）`);
    }
    if (roots.length && toml.sandbox_mode === '"read-only"') {
      out.notes.push("策略含放开目录，但 READ/WRITE 有 deny → 沙箱定为 read-only，writable_roots 不生效");
    }
    if (policy.autoContinue?.enabled) unsupported.push({ action: "AUTO_CONTINUE", decision: "allow", reason: "Codex 自动继续走 Stop hook：配置层做不到，用 `oag hook install --adapter codex`（运行时需 --dangerously-bypass-hook-trust）" });
    if (Object.keys(toml).length) out.payload = { id: "policy", patch: { toml } };
    return out;
  }

  if (hostId === "claude-code") {
    // 依据：官方包 @anthropic-ai/claude-code 2.1.322 的 sdk-tools.d.ts + claude.exe 字符串
    //   settings: ~/.claude/settings.json，键 permissions.{allow,deny,ask}，规则形如 "Bash(git *)" / "Read(~/.zshrc)"
    //   模式枚举：default | acceptEdits | auto | dontAsk | plan | bypassPermissions
    //   bypassPermissions 需启动参数 --dangerously-skip-permissions，故不由我们代设
    const TOOLS = {
      READ: ["Read", "Glob", "Grep"],
      WRITE: ["Write", "Edit", "NotebookEdit"],
      EXEC_SAFE: ["Bash"],
      EXEC_DESTRUCTIVE: ["Bash"],
      EXEC_INSTALL: ["Bash"],
      EXEC_GIT_WRITE: ["Bash"],
      NET: ["WebFetch", "WebSearch"],
    };
    const buckets = { allow: [], deny: [], ask: [] };
    for (const a of ACTIONS) {
      const d = table[a];
      if (!d) continue;
      for (const tool of TOOLS[a] ?? []) if (!buckets[d].includes(tool)) buckets[d].push(tool);
    }
    // 同一工具可能被多条规则命中：deny > ask > allow，所以在写盘前先做一次"桶内去重降级"
    buckets.allow = buckets.allow.filter((t) => !buckets.deny.includes(t) && !buckets.ask.includes(t));
    buckets.ask = buckets.ask.filter((t) => !buckets.deny.includes(t));
    const permissions = {};
    for (const [k, v] of Object.entries(buckets)) if (v.length) permissions[k] = v;
    if (Object.keys(permissions).length) out.payload = { id: "policy", patch: { json: { permissions } } };
    if (policy.identity?.stripHostIdentity) {
      unsupported.push({ action: "IDENTITY", decision: "allow", reason: "Claude Code 身份句无官方键（CLAUDE.md 只能追加），标 UNDOCUMENTED" });
    }
    if (policy.autoContinue?.enabled) {
      unsupported.push({ action: "AUTO_CONTINUE", decision: "allow", reason: "Claude Code 自动继续需 Stop hook（配置层做不到，hook 层待 v4.4）" });
    }
    out.notes.push("Claude Code 权限映射依据包内证据（binary strings + d.ts），未在真机跑过 → 证据等级 ⚠️");
    return out;
  }

  throw new AdapterError(ErrorCode.HOST_NOT_FOUND, `未知宿主：${hostId}`);
}

/** 编译结果里只要有 unsupported，就说明"策略没被完整落地" —— 用来决定退出码 */
export function coverage(compiled) {
  const total = (compiled.payload ? 1 : 0) + compiled.unsupported.length;
  return { landed: compiled.payload ? 1 : 0, total, complete: compiled.unsupported.length === 0 && compiled.payload !== null };
}
