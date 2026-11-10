import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compose, stripBlock, blockBody, BEGIN } from "../lib/patchfile.js";

const FRAG = `
# 注释行应被剔除
- id: approval
  config:
    policy: never
- id: system-prompt
  config:
    includeHarnessIdentity: false
`;

test("空文件填充", () => {
  const block = blockBody(FRAG);
  const { next, mode } = compose("", block);
  assert.equal(mode, "fill-empty");
  assert.ok(next.includes(BEGIN));
  assert.ok(next.includes("policy: never"));
  assert.ok(!next.includes("注释行应被剔除"));
});

test("[] 占位替换为托管块", () => {
  const block = blockBody(FRAG);
  const { next, mode } = compose("# 我的注释\n[]\n", block);
  assert.equal(mode, "fill-empty");
  assert.ok(next.includes("# 我的注释"));
  assert.ok(!next.trim().endsWith("[]"));
});

test("已有用户条目时追加而不是覆盖", () => {
  const block = blockBody(FRAG);
  const cur = "- id: 我自己的东西\n  config: {}\n";
  const { next, mode } = compose(cur, block);
  assert.equal(mode, "append");
  assert.ok(next.includes("我自己的东西"));
  assert.ok(next.includes("policy: never"));
});

test("重复 apply 幂等", () => {
  const block = blockBody(FRAG);
  const once = compose("[]\n", block).next;
  const twice = compose(once, block);
  assert.equal(twice.mode, "replace-block");
  assert.equal(twice.next.trim(), once.trim());
  // 只应有一个托管块
  assert.equal(once.split(BEGIN).length, 2);
  assert.equal(twice.next.split(BEGIN).length, 2);
});

test("revert 后回到空数组，且保留用户内容", () => {
  const block = blockBody(FRAG);
  const cur = "- id: 我自己的东西\n  config: {}\n";
  const withBlock = compose(cur, block).next;
  const { text: without } = stripBlock(withBlock);
  assert.ok(without.includes("我自己的东西"));
  assert.ok(!without.includes("policy: never"));
});

// —— 回归：codex 审查发现的 3 类问题 ——
test("marker 只在整行出现时才处理（用户正文里的同名字样不误删）", () => {
  const block = blockBody(FRAG);
  const cur = `# 说明: 提到 ${BEGIN} 这种字样不应被当成块\n[]\n`;
  const { next } = compose(cur, block);
  assert.ok(next.includes("提到"));
  assert.ok(next.includes("policy: never"));
});

test("BEGIN 有但 END 缺失 → 抛 UNTERMINATED_BLOCK，不叠第二个块", () => {
  const block = blockBody(FRAG);
  const broken = `${BEGIN}  dsh-open:v1\n- id: approval\n`;
  assert.throws(() => compose(broken, block), (e) => e.code === "UNTERMINATED_BLOCK");
});
