/**
 * 动作归一化（手术刀级判定的核心）
 *
 * 为什么要这一层：
 *   实测教训 —— 按"命令写法"堵，等于鼓励 agent 换一种写法绕过。
 *   我们堵了 Remove-Item，它就改用 apply_patch 的 *** Delete File:，
 *   结果文件照样被删。这不是它恶意，是它"好心办坏事"（目标没变，换了条路）。
 *
 * 所以判定必须按「意图 × 目标」：
 *   1) 先把任何工具调用归一成 { op, targets }，op 只有 8 种；
 *   2) 再拿 op × targets 去比策略，与书写形式无关；
 *   3) 拒绝时给出"可替代做法"和"不要换写法重试"，避免它另辟蹊径。
 *
 * 本文件不 import 任何东西 —— 因为它会被原样内联进生成的 hook 脚本里。
 */

export const OPS = ["read", "write", "delete", "destroy", "exec", "net", "install", "git_write"];

/** 意图识别表：按"效果"归组，不按工具名。新增写法只加一条正则。 */
const INTENT = [
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

const ABS = /(?:^|[\s"'(=:,])((?:[A-Za-z]:[\\/]|~[\\/]|\/(?:[\w.-]+\/)*)[^\s"'()|;&]*)/g;

/** 反斜杠归一 + 去尾斜杠 + 小写（跨平台比较用） */
export function normPath(p) {
  let s = String(p).trim().replace(/^["']|["']$/g, "");
  s = s.split(String.fromCharCode(92)).join("/");
  s = s.replace(/\/+/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s.toLowerCase();
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
    default: return "EXEC_SAFE";
  }
}

/** 哪些 op 需要做"目标是否在允许目录内"的检查 */
export function scopedOps() {
  return ["read", "write", "delete"];
}
