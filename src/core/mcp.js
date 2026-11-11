/**
 * MCP 工具接入：把不透明的 MCP 调用纳入同一判定层
 *
 * 问题：MCP 工具对闸门是黑盒 —— 名字叫 `mcp__ologs__get_profile`，谁也不知道它读文件、
 * 发网络、还是写盘。此前一律按"未知工具 → 拒绝"处理（安全但等于 MCP 全废）。
 *
 * 做法（声明式，fail-closed）：
 *   在策略里显式声明每个 MCP 工具的能力，闸门只按声明判定；
 *   没声明 → 拒（不能因为"看起来无害"就放行）。
 *
 * 策略写法（policy.json）：
 *   "mcp": {
 *     "ologs/get_profile":                      { "action": "READ",  "paths": ["/srv/agent-work/**"] },
 *     "files/read_file":                        { "action": "READ",  "paths": ["/srv/agent-work/**"] },
 *     "files/write_file":                       { "action": "WRITE", "paths": ["/srv/agent-work/**"] },
 *     "codex_apps/*":                           { "action": "NET",   "decision": "deny" }
 *   }
 *
 * 匹配顺序：精确 `server/tool` → `server/*` → `*`
 * 语义：
 *   - action ∈ READ/WRITE/DELETE：必须能从入参里抽出目标路径，且全部在 paths 允许范围内；
 *     抽不出目标 → 拒（无法验证 = 不放行）
 *   - action ∈ NET/EXEC_*：按 decision（缺省 deny）
 */
export const MCP_PREFIX = "mcp__";

/** `mcp__server__tool` → {server, tool}；不是 MCP 工具返回 null */
export function parseMcpToolName(toolName) {
  const n = String(toolName ?? "");
  if (!n.startsWith(MCP_PREFIX)) return null;
  const rest = n.slice(MCP_PREFIX.length);
  const i = rest.indexOf("__");
  if (i <= 0) return { server: rest, tool: "" }; // mcp__server__* 之类的退化写法
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

/** 在策略里找该 MCP 工具的声明 */
export function findMcpDeclaration(policy, toolName) {
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return { found: false, parsed: null };
  const table = policy?.mcp ?? {};
  const exact = `${parsed.server}/${parsed.tool}`;
  const candidates = [exact, `${parsed.server}/*`, "*"];
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(table, key)) {
      return { found: true, parsed, key, decl: table[key] ?? {}, candidates };
    }
  }
  return { found: false, parsed, candidates };
}

const SCOPED = new Set(["READ", "WRITE", "DELETE"]);

/**
 * 把声明里的路径化成一个"根"：`/srv/agent-work/**` → `/srv/agent-work`
 * （和 guard 里 rootsOf 的处理一致；否则拿整串做前缀比较会把自己判成越界）
 */
function declaredRoot(p) {
  const raw = String(p ?? "");
  const cut = raw.search(/[*?[{]/);
  if (cut === -1) return raw;
  const slash = raw.lastIndexOf("/", cut);
  return slash > 0 ? raw.slice(0, slash) : raw;
}

/**
 * 判定一次 MCP 调用
 * @returns {{decision:"allow"|"deny", action:string, targets:string[], reason:string}}
 */
export function judgeMcpCall({ policy, toolName, targets = [], normPath = (x) => x, canon = (x) => x }) {
  const { found, parsed, key, decl } = findMcpDeclaration(policy, toolName);
  const label = parsed ? `${parsed.server}/${parsed.tool}` : String(toolName);
  if (!found) {
    return {
      decision: "deny",
      action: "MCP_UNDECLARED",
      targets,
      reason: `MCP 工具 ${label} 未在策略 mcp 段声明能力（fail-closed）：先在 policy.json 的 mcp 里写明 action 与 paths`,
    };
  }
  const action = String(decl.action ?? "").toUpperCase();
  if (!action) {
    return { decision: "deny", action: "MCP_UNDECLARED", targets, reason: `MCP 声明 ${key} 缺少 action 字段` };
  }

  // 需要路径证明的动作
  if (SCOPED.has(action)) {
    const paths = Array.isArray(decl.paths) ? decl.paths : [];
    if (!paths.length) {
      return { decision: "deny", action, targets, reason: `MCP 声明 ${key} 是 ${action} 类但没给 paths：无法验证范围` };
    }
    if (!targets.length) {
      return { decision: "deny", action, targets, reason: `MCP 声明 ${key} 是 ${action} 类，但入参里抽不到目标路径：无法验证` };
    }
    const roots = paths.map((p) => normPath(canon(declaredRoot(p))));
    const outside = targets.filter((t) => {
      const tt = normPath(canon(t));
      return !roots.some((r) => tt === r || tt.startsWith(r + "/"));
    });
    if (outside.length) {
      return { decision: "deny", action, targets, reason: `MCP ${label} 目标越界：${outside.slice(0, 3).join(", ")}` };
    }
    return { decision: "allow", action, targets, reason: `MCP ${label} 目标在声明范围内` };
  }

  // 其它动作：按声明 decision（缺省 deny）
  const d = String(decl.decision ?? "deny").toLowerCase();
  const decision = d === "allow" ? "allow" : "deny";
  return { decision, action, targets, reason: `MCP ${label} → ${action} 按声明 ${decision}` };
}
