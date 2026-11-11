/** TOML 键的位置：键在 ≠ 键生效（落在 [section] 之后会被宿主忽略） */
import test from "node:test";
import assert from "node:assert/strict";
import { setTomlKey, findMisplacedRootKeys } from "../src/core/key-merge.js";

// 真实踩过的坏配置形状：model 写在 [model_providers.deepseek] 之后 → 被静默忽略 → 请求全超时
const BROKEN = `approval_policy = "never"
sandbox_mode = "workspace-write"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"

model_provider = "deepseek"
model = "deepseek-chat"
`;

test("能识别落在 [section] 之后的裸根键（真实事故形状）", () => {
  const bad = findMisplacedRootKeys(BROKEN);
  assert.deepEqual(bad.map((b) => b.key), ["model_provider", "model"]);
  assert.equal(bad[0].afterTable, "model_providers.deepseek");
  // 段内的 name/base_url 不是根键，不该被报（它们本来就在那一层）
});

test("点号根键不被误报（sandbox_workspace_write.x = ... 是合法相对写法）", () => {
  const text = `approval_policy = "never"

[some_table]
k = 1

sandbox_workspace_write.network_access = false
`;
  assert.deepEqual(findMisplacedRootKeys(text), []);
});

test("oag 自己生成的形状（无 section、全是点号根键）零误报", () => {
  const text = `approval_policy = "on-request"
sandbox_mode = "workspace-write"
sandbox_workspace_write.network_access = false
shell_environment_policy.inherit = "core"
sandbox_workspace_write.writable_roots = ["D:/agent-work"]
`;
  assert.deepEqual(findMisplacedRootKeys(text), []);
});

test("setTomlKey 往已有 section 的文件里加根键时，必须插在首个 section 之前", () => {
  const out = setTomlKey(BROKEN, "model_provider", '"deepseek"');
  const lines = out.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const at = lines.findIndex((l) => l.startsWith("model_provider ="));
  assert.ok(firstTable >= 0);
  assert.ok(at >= 0 && at < firstTable, `根键被放到了 section 之后（第 ${at + 1} 行，section 在第 ${firstTable + 1} 行）`);
  // 插对位置后，只剩原本就错位的那条 model
  assert.deepEqual(findMisplacedRootKeys(out).map((b) => b.key), ["model"]);
});

test("setTomlKey 覆盖已有键时不应制造新的错位", () => {
  const clean = `approval_policy = "never"

[model_providers.deepseek]
name = "DeepSeek"
`;
  const out = setTomlKey(clean, "approval_policy", '"on-request"');
  assert.deepEqual(findMisplacedRootKeys(out), []);
});
