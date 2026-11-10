/**
 * 手术刀级判定测试：
 * 同一意图的**所有已知写法**必须落到同一个 op 和同一个决策上 ——
 * 否则 agent 会换一种写法绕过去（这就是"好心办坏事"的技术形态）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeToolCall, actionFor, extractTargets, normPath } from "../src/core/actions.js";
import { classify } from "../src/adapter/codex/guard.js";

const policy = {
  version: 1,
  rules: [
    { action: "READ", decision: "allow", scope: { paths: ["D:/w/**"] } },
    { action: "WRITE", decision: "allow", scope: { paths: ["D:/w/**"] } },
    { action: "EXEC_SAFE", decision: "allow", scope: {} },
    { action: "EXEC_DESTRUCTIVE", decision: "deny", scope: {} },
    { action: "EXEC_INSTALL", decision: "ask", scope: {} },
    { action: "EXEC_GIT_WRITE", decision: "ask", scope: {} },
    { action: "NET", decision: "deny", scope: {} },
  ],
};

const norm = (command, toolName = "Bash") => normalizeToolCall({ toolName, command, cwd: "D:/w" });
const clsf = (command, toolName = "Bash") => classify({ toolName, command, policy, cwd: "D:/w" });

test("删除：8 种写法必须全部归一到 delete 且被 deny", () => {
  const forms = [
    "rm target.txt",
    "rm -rf D:/w/sub",
    "Remove-Item target.txt",
    "Remove-Item -LiteralPath 'target.txt' -Force",
    "del target.txt",
    "erase target.txt",
    "[System.IO.File]::Delete('D:/w/target.txt')",
    "*** Begin Patch\n*** Delete File: target.txt\n*** End Patch",
    "git rm target.txt",
  ];
  for (const c of forms) {
    const r = norm(c);
    assert.equal(r.op, "delete", `写法未归一到 delete: ${c}`);
    const d = clsf(c);
    assert.equal(d.action, "EXEC_DESTRUCTIVE", c);
    assert.equal(d.decision, "deny", c);
  }
});

test("写入：5 种写法归一为 write，且目录内放行", () => {
  const forms = [
    "Set-Content -Path D:/w/a.txt -Value x",
    "echo x > D:/w/a.txt",
    "New-Item -ItemType File -Path D:/w/a.txt",
    "*** Begin Patch\n*** Add File: D:/w/a.txt\n+x\n*** End Patch",
    "copy-item D:/w/src.txt D:/w/dst.txt",
  ];
  for (const c of forms) {
    assert.equal(norm(c).op, "write", c);
    assert.equal(clsf(c).decision, "allow", c);
  }
});

test("写入越界：同一意图换写法也必须 deny（不能靠换工具绕过）", () => {
  const forms = [
    "Set-Content -Path C:/secret/a.txt -Value x",
    "*** Begin Patch\n*** Add File: C:/secret/a.txt\n+x\n*** End Patch",
    "copy-item D:/w/a.txt C:/secret/b.txt",
    "New-Item -ItemType File -Path 'C:/secret/c.txt'",
  ];
  for (const c of forms) {
    const d = clsf(c);
    assert.equal(d.op, "write", c);
    assert.equal(d.decision, "deny", `越界写必须拦：${c}`);
    assert.match(d.reason, /允许目录|不在允许/, c);
  }
});

test("读取越界：5 种写法都必须 deny", () => {
  const forms = [
    "Get-Content C:/secret/key.txt",
    "cat C:/secret/key.txt",
    "type C:/secret/key.txt",
    "select-string -path C:/secret/key.txt -pattern x",
    "[System.IO.File]::ReadAllText('C:/secret/key.txt')",
  ];
  for (const c of forms) {
    const d = clsf(c);
    assert.equal(d.op, "read", c);
    assert.equal(d.decision, "deny", c);
  }
});

test("装包 / git 写 / 联网：写法归一后按策略走", () => {
  for (const c of ["npm i x", "pnpm add x", "pip install x", "winget install x", "go install x"]) {
    assert.equal(norm(c).op, "install", c);
    assert.equal(clsf(c).decision, "ask", c);
  }
  for (const c of ["git commit -m x", "git push", "git rebase -i HEAD~2", "git reset --hard"]) {
    const d = clsf(c);
    assert.ok(["git_write", "delete", "destroy"].includes(d.op), c);
    assert.ok(["ask", "deny"].includes(d.decision), c);
  }
  for (const c of ["curl https://x", "wget https://x", "Invoke-WebRequest https://x", "git clone https://x"]) {
    assert.equal(norm(c).op, "net", c);
    assert.equal(clsf(c).decision, "deny", c);
  }
});

test("普通命令不误报（避免过度拦截）", () => {
  for (const c of ["echo hello", "git status", "ls -la", "node --version", "npm run build", "pytest -q"]) {
    const d = clsf(c);
    assert.equal(d.decision, "allow", `不该拦：${c}`);
    assert.equal(d.op, "exec", c);
  }
});

test("路径归一：反斜杠/大小写/尾斜杠视为同一路径", () => {
  assert.equal(normPath("D:\\W\\Sub\\"), "d:/w/sub");
  assert.equal(normPath("D:/w/sub"), "d:/w/sub");
  assert.equal(normPath('"D:/w/sub"'), "d:/w/sub");
});

test("目标抽取：相对路径按 cwd 解析", () => {
  const t = extractTargets("Set-Content -Path sub/a.txt -Value x", "D:/w");
  assert.ok(t.includes("d:/w/sub/a.txt"), JSON.stringify(t));
});

test("actionFor 映射稳定", () => {
  assert.equal(actionFor("delete"), "EXEC_DESTRUCTIVE");
  assert.equal(actionFor("install"), "EXEC_INSTALL");
  assert.equal(actionFor("git_write"), "EXEC_GIT_WRITE");
  assert.equal(actionFor("net"), "NET");
  assert.equal(actionFor("write"), "WRITE");
  assert.equal(actionFor("read"), "READ");
  assert.equal(actionFor("exec"), "EXEC_SAFE");
});
