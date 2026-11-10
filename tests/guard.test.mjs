import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/adapter/codex/guard.js";

const policy = {
  version: 1,
  rules: [
    { action: "READ", decision: "allow", scope: {} },
    { action: "WRITE", decision: "allow", scope: { paths: ["D:/work/**"] } },
    { action: "EXEC_SAFE", decision: "allow", scope: {} },
    { action: "EXEC_DESTRUCTIVE", decision: "deny", scope: {} },
    { action: "EXEC_INSTALL", decision: "ask", scope: {} },
    { action: "EXEC_GIT_WRITE", decision: "ask", scope: {} },
    { action: "NET", decision: "deny", scope: {} },
  ],
};
const cls = (command, toolName = "Bash") => classify({ toolName, command, policy, cwd: "D:/work" });

test("破坏性命令 → deny", () => {
  for (const c of ["rm -rf /tmp/x", "git reset --hard HEAD~3", "git push --force origin main", "del /f a.txt", "DROP TABLE users;"]) {
    assert.equal(cls(c).decision, "deny", c);
    assert.equal(cls(c).action, "EXEC_DESTRUCTIVE", c);
  }
});

test("各种删除写法都必须 deny（含无 flag 的普通删除）", () => {
  for (const c of ["Remove-Item target.txt", "del a.txt", "erase a.txt", "rm a.txt",
                   "[System.IO.File]::Delete('x')", "[System.IO.Directory]::Delete('d')",
                   "rm -rf dir", "Remove-Item -Recurse dir",
                   "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch"]) {
    const r = cls(c);
    assert.equal(r.decision, "deny", c);
    assert.equal(r.action, "EXEC_DESTRUCTIVE", c);
  }
});

test("装包 → ask", () => {
  for (const c of ["npm install is-number", "pip install requests", "pnpm add lodash", "uv pip install rich"]) {
    assert.equal(cls(c).action, "EXEC_INSTALL", c);
    assert.equal(cls(c).decision, "ask", c);
  }
});

test("git 写 → ask", () => {
  for (const c of ["git commit -m x", "git push origin main", "git rebase -i HEAD~2"]) {
    assert.equal(cls(c).action, "EXEC_GIT_WRITE", c);
  }
});

test("联网 → deny", () => {
  for (const c of ["curl https://api.github.com", "wget http://x/y", "ssh root@host", "git clone https://x"]) {
    assert.equal(cls(c).action, "NET", c);
    assert.equal(cls(c).decision, "deny", c);
  }
});

test("写允许目录内 → allow；越界 → deny", () => {
  const inside = classify({ toolName: "Bash", command: "Set-Content -Path D:/work/out.txt -Value hi", policy, cwd: "D:/work" });
  assert.equal(inside.decision, "allow", "允许目录内应放行");
  const outside = classify({ toolName: "Bash", command: "Set-Content -Path D:/other/out.txt -Value hi", policy, cwd: "D:/work" });
  assert.equal(outside.action, "WRITE");
  assert.equal(outside.decision, "deny", "越界写必须拦");
});

test("普通命令 → allow", () => {
  for (const c of ["echo hello", "git status", "ls -la", "node --version"]) {
    assert.equal(cls(c).decision, "allow", c);
    assert.equal(cls(c).action, "EXEC_SAFE", c);
  }
});

test("破坏性优先于写检查（rm -rf 不会被当成普通写）", () => {
  const r = cls("rm -rf D:/work/old");
  assert.equal(r.action, "EXEC_DESTRUCTIVE");
  assert.equal(r.decision, "deny");
});
