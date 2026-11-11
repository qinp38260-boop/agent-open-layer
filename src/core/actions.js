/**
 * 动作归一化（手术刀级判定的核心）
 *
 * 为什么要这一层：
 *   实测教训 —— 按"命令写法"堵，等于鼓励 agent 换一种写法绕过。
 *   我们堵了 Remove-Item，它就改用 apply_patch 的 *** Delete File:，
 *   结果文件照样被删。这不是它恶意，是它"好心办坏事"（目标没变，换了条路）。
 *
 * 所以判定必须按「意图 × 目标」：
 *   1) 先把任何工具调用归一成 { op, targets }；
 *   2) 再拿 op × targets 去比策略，与书写形式无关；
 *   3) 逃逸类（嵌套启动宿主、凭据采集）无条件拒绝，不看策略。
 *
 * 本文件不 import 任何东西 —— 因为它会被原样内联进生成的 hook 脚本里。
 */

export const OPS = [
  "read",
  "write",
  "delete",
  "destroy",
  "exec",
  "net",
  "install",
  "git_write",
  "spawn_host",
  "cred_read",
];

/** 会被宿主本人日后执行的"配置即代码"文件（延迟执行面）：写它们要单独标记 */
export const PERSISTENCE_RE =
  /(\.git[\\/]hooks|\.gitconfig|core\.hooksPath|core\.fsmonitor|\.vscode[\\/]tasks\.json|package\.json|\.npmrc|\.envrc|\.github[\\/]workflows|Makefile|conftest\.py)/i;

/** 意图识别表：按"效果"归组，不按工具名。新增写法只加一条正则。 */
const INTENT = [
  {
    // 嵌套启动另一个宿主 = 试图绕过本闸门（新进程没有我们的 hook）
    op: "spawn_host",
    forms: [
      /\b(codex|dsh|claude)\b.{0,60}\b(exec|run|--dangerously|--profile)\b/i,
      /\bcodex\.exe\b/i,
    ],
  },
  {
    // 凭据采集：不读文件也能拿到令牌的路子
    op: "cred_read",
    forms: [
      /\bgit\s+credential\b/i,
      /\bcmdkey\b/i,
      /\bsecurity\s+find-generic-password\b/i,
      /\bvault\s+(read|list)\b/i,
      /\.ssh[\\/](id_rsa|id_ed25519|config)\b/i,
      /\.aws[\\/](credentials|config)\b/i,
      /\bdpapi\b/i,
      /\bcryptunprotectdata\b/i,
    ],
  },
  {
    op: "delete",
    forms: [
      /\brm\s+(-\S+\s+)*[^\s|;&]+/i,
      /\bremove-item\b/i,
      /\b(erase|del)\b\s+\S+/i,
      /\brmdir\b/i,
      /\bunlink\b/i,
      /\[system\.io\.file\]::delete/i,
      /\[system\.io\.directory\]::delete/i,
      /\*\*\*\s*delete\s+(file|directory):/i,
      /\bgit\s+rm\b/i,
    ],
  },
  {
    op: "destroy",
    forms: [
      /\bgit\s+reset\s+--hard\b/i,
      /\bgit\s+clean\s+-[a-z]*[fd]/i,
      /\bgit\s+push\b.*(--force|-f)\b/i,
      /\bgit\s+branch\s+-D\b/i,
      /\bgit\s+stash\s+(drop|clear)\b/i,
      /\bgit\s+checkout\s+--\s+\./i,
      /\bdrop\s+(table|database)\b/i,
      /\btruncate\s+table\b/i,
      /\bformat\s+[a-z]:/i,
      /\bmkfs\b/i,
      /\bshutdown\b|\breboot\b/i,
      /\btaskkill\b.*\/f/i,
    ],
  },
  {
    op: "install",
    forms: [
      /\b(npm|pnpm|yarn)\s+(i|install|add)\b/i,
      /\bpip3?\s+install\b/i,
      /\buv\s+(pip\s+)?(add|install)\b/i,
      /\b(winget|choco|scoop)\s+install\b/i,
      /\bapt(-get)?\s+install\b/i,
      /\bcargo\s+install\b/i,
      /\bgo\s+install\b/i,
    ],
  },
  {
    op: "git_write",
    forms: [/\bgit\s+(commit|push|merge|rebase|tag|cherry-pick|reset|clean|checkout|switch|stash|restore)\b/i],
  },
  {
    op: "net",
    forms: [
      /\bcurl\b/i,
      /\bwget\b/i,
      /\binvoke-webrequest\b/i,
      /\binvoke-restmethod\b/i,
      /\bstart-bitstransfer\b/i,
      /\bssh\b/,
      /\bscp\b/,
      /\bsftp\b/,
      /\bgit\s+clone\b/i,
      /\bnc\s+-/i,
      /\btelnet\b/i,
    ],
  },
  {
    op: "write",
    forms: [
      /\*\*\*\s*add\s+file:/i,
      /\*\*\*\s*update\s+file:/i,
      /\*\*\*\s*move\s+to:/i,
      /\bset-content\b/i,
      /\badd-content\b/i,
      /\bout-file\b/i,
      /\bnew-item\b/i,
      /\bcopy-item\b/i,
      /\bmove-item\b/i,
      /\btee\b/i,
      /\bcp\b/i,
      /\bmv\b/i,
      /(^|[^0-9&])>>?\s*\S+/,
      /\bapply_patch\b/i,
      /\btouch\b/i,
      /\bmkdir\b/i,
    ],
  },
  {
    op: "read",
    forms: [
      /\bget-content\b/i,
      /\bcat\b/i,
      /\btype\s+/i,
      /\bhead\b/i,
      /\btail\b/i,
      /\bmore\b/i,
      /\bless\b/i,
      /\bselect-string\b/i,
      /\bfindstr\b/i,
      /\[system\.io\.file\]::readall/i,
    ],
  },
];

const ABS = /(?:^|[\s"'"(=:,])((?:[\\/]{2}[?.][\\/]?)?(?:[A-Za-z]:[\\/]|~[\\/]|\/(?:[\w.-]+\/)*)[^\s"'()|;&]*)/g;

/**
 * 路径归一：反斜杠 + 去尾斜杠 + 小写，并且**解析 . 与 ..**、拆掉 Windows 的几层伪装
 *
 * 为什么必须做这些（每一条都对应一种真实绕过）：
 *   1) `..` —— `D:/work/../Windows/x` 用 startsWith 判根时会话通过，实际写到系统目录；
 *   2) `\\?\` / `\\.\` 设备前缀 —— 加了前缀后 Win32 不再折叠 `..`，等于绕过 1 的补丁；
 *   3) ADS（`a.txt:hidden`）—— Windows 视作写 a.txt 的备用流，前缀判定会误判对象；
 *   4) 尾部点与空格 —— Win32 会静默丢弃（`work.` == `work`），不剥就等于给了个"假名"。
 * 归一化只做字符串层面（不碰磁盘），真实软链/junction 由调用方用 realpath 再折一次。
 */
export function normPath(p) {
  let raw = String(p ?? "").trim().replace(/^["']|["']$/g, "");
  raw = raw.split(String.fromCharCode(92)).join("/");
  raw = raw.replace(/^\/+[?.](?=\/)/, ""); // \?\ 与 \.\ 前缀（设备命名空间）
  raw = raw.replace(/\/+/g, "/");
  raw = raw.replace(/^\/+(?=[a-zA-Z]:)/, ""); // 去前缀后可能留下 /D:/...

  let drive = "";
  const dm = raw.match(/^([a-zA-Z]:)(?=\/|$)/);
  if (dm) {
    drive = dm[1].toLowerCase();
    raw = raw.slice(2);
  }

  const stack = [];
  for (let seg of raw.split("/")) {
    if (!seg) continue;
    if (seg !== "." && seg !== "..") {
      const i = seg.indexOf(":"); // ':' 之后是 NTFS 流名
      seg = (i >= 0 ? seg.slice(0, i) : seg).replace(/[. ]+$/, ""); // 尾部点/空格 Win32 会丢
      if (!seg) continue;
    }
    if (seg === ".") continue;
    if (seg === "..") {
      stack.pop(); // 根之上再 .. 无意义，丢掉
      continue;
    }
    stack.push(seg);
  }
  const body = stack.join("/");
  let out;
  if (drive) out = drive + (body ? "/" + body : "");
  else if (stack.length) out = "/" + body;
  else out = ".";
  return out.toLowerCase();
}

/**
 * 把工具调用的入参拍平成一段文本，用于意图/目标识别。
 *
 * 实测教训：只读 `tool_input.command` 时，`apply_patch` 这类"路径写在结构化字段里"的
 * 调用完全绕过闸门 —— command 是空的，抽出来的 targets 也是空的，白名单根本没被执行。
 * 所以任何看起来像"命令/补丁/路径"的字符串字段都要摊进来。
 */
export function payloadText(input, depth = 0) {
  if (input == null || depth > 3) return "";
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return input.map((x) => payloadText(x, depth + 1)).join(" ");
  if (typeof input !== "object") return "";
  const parts = [];
  for (const k of Object.keys(input)) parts.push(payloadText(input[k], depth + 1));
  return parts.filter(Boolean).join(" ");
}

function joinPath(cwd, rel) {
  const base = normPath(cwd || ".");
  if (!base || base === ".") return rel;
  return base + "/" + String(rel).replace(/^[.][\\/]/, "");
}

/** 从命令文本里抽目标路径（绝对路径 + 相对的"像文件名"的 token） */
export function extractTargets(text, cwd) {
  const out = new Set();
  const s = String(text ?? "");
  for (const m of s.matchAll(ABS)) {
    let raw = m[1].replace(/[;,)]+$/, "");
    if (!raw) continue;
    if (raw.startsWith("~")) raw = raw.slice(1);
    const n = normPath(raw);
    if (/^[a-z]:\//.test(n) || n.startsWith("/")) out.add(n);
    else out.add(normPath(joinPath(cwd, raw)));
  }
  for (const m of s.matchAll(/(?:Add File:|Update File:|Delete File:|Move to:|-Path\s+|LiteralPath\s+)([^\s"'<>|;]+)/gi)) {
    const raw = m[1].replace(/[;,)]+$/, "");
    if (raw && !/^[A-Za-z]:[\\/]/.test(raw)) out.add(normPath(joinPath(cwd, raw)));
  }
  return [...out];
}

/** 归一：任何工具调用 → { op, targets, why } */
export function normalizeToolCall({ toolName, command, cwd }) {
  const raw = String(command ?? "");
  const text = raw.toLowerCase();
  for (const group of INTENT) {
    for (const re of group.forms) {
      if (re.test(text)) return { op: group.op, targets: extractTargets(raw, cwd), why: String(re) };
    }
  }
  const tn = String(toolName ?? "");
  if (/write|edit|patch/i.test(tn)) return { op: "write", targets: extractTargets(raw, cwd), why: `tool:${tn}` };
  if (/read/i.test(tn)) return { op: "read", targets: extractTargets(raw, cwd), why: `tool:${tn}` };
  return { op: "exec", targets: extractTargets(raw, cwd), why: "default-exec" };
}

/** op → 策略里的动作名 */
export function actionFor(op) {
  switch (op) {
    case "read": return "READ";
    case "write": return "WRITE";
    case "delete":
    case "destroy": return "EXEC_DESTRUCTIVE";
    case "install": return "EXEC_INSTALL";
    case "git_write": return "EXEC_GIT_WRITE";
    case "net": return "NET";
    case "spawn_host":
    case "cred_read": return "EXEC_DESTRUCTIVE"; // 归最严一档；实际由 guard 无条件拒绝
    default: return "EXEC_SAFE";
  }
}

/** 哪些 op 需要做"目标是否在允许目录内"的检查 */
export function scopedOps() {
  return ["read", "write", "delete"];
}

/** 无条件拒绝的"逃逸类"意图（不受策略 allow 影响） */
export function isEscapeOp(op) {
  return op === "spawn_host" || op === "cred_read";
}
