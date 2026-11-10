# agent-open-layer

**Config-first "open mode" for AI coding agents.** Uses each host's *official* extension
surfaces only — never patches `node_modules`, never rewrites host source.

> v0.2 ships one adapter (DeepSeek Harness). The host-agnostic adapter contract is v0.3 — see [ROADMAP.md](ROADMAP.md).

## Why not a "purge"-style patcher

| | typical `*-purge` patcher | agent-open-layer |
|---|---|---|
| Mechanism | content-anchor text replacement inside host source | writes the host's own patch layer (`cordis.patch.yml`) |
| Patches needed | dozens (58 in the one we evaluated) | **0 source patches** |
| Host upgrade | anchors drift → manual re-anchoring (14 patches / 78 anchors drifted on 0.1.0) | **nothing to re-anchor** (config keys are the contract) |
| Failure mode | host won't boot | config ignored / readable error |
| Rollback | snapshot + revert | delete the managed block |

## Install / use

```bash
git clone https://github.com/<you>/agent-open-layer.git
cd agent-open-layer

node bin/dsh-open.js status            # host version, installed?
node bin/dsh-open.js plan              # dry-run: show the exact diff
node bin/dsh-open.js apply --yes       # backup -> write managed block -> audit -> verify
node bin/dsh-open.js verify            # re-read host config as proof
node bin/dsh-open.js revert --yes      # remove managed block (your own entries untouched)
node bin/dsh-open.js audit 20          # last 20 audit rows
node --test tests/patchfile.test.mjs   # 5 unit tests
```

On Windows the host CLI is a `.cmd`, so pass it explicitly:

```bash
node bin/dsh-open.js verify --dsh-cli "<path-to>/dsh.cmd"
```

## What v0.2 actually changes

```yaml
- id: system-prompt
  config:
    includeHarnessIdentity: false   # drop "You are an AI agent powered by DeepSeek Harness."
    persona: ""
```

That's it. **One** documented key, affecting identity text only. Nothing about permissions.

### The lesson that shaped this repo

v0.1 set `approval.policy: never` believing "never = stop asking". The host's own
model-facing sentence says the opposite:

> `NEVER_SENTENCE` = *"Approval prompts are disabled in this session: actions that require
> approval are **rejected automatically** — do not request sandbox escalation."*

So `never` is **fail-closed**. Shipping it as an "open mode" switch would have broken every
action that needs permission. Hard rule in this repo:

> Every switch's true semantics must be quoted from the host's own prompt/source in a comment
> next to it. Enum names are not documentation.

## Managed-block rules (why it cannot break your config)

- Only touches lines between `# >>> agent-open-layer managed block` and `# <<< ...`
- Empty file or `[]` → fill; your own entries present → append (never overwrite)
- `apply` is **idempotent** (no stacked blocks)
- Backs up to `profiles/<profile>/.dsh-open-backup/` before every write
- `revert` restores `[]` when nothing else remains

## Layout

```
bin/dsh-open.js            CLI: status/plan/apply/revert/verify/audit
lib/host.js                host discovery: home / profiles / version
lib/patchfile.js           managed block, backup, atomic write
lib/audit.js               audit.jsonl (1MB rotation)
open/dsh-open.patch.yml    the config layer (edit this to add switches)
tests/patchfile.test.mjs   unit tests
SECURITY.md                what it touches, fail-closed policy, disclosure
ROADMAP.md                 adapter contract, per-host capability matrix (v0.3)
```

## Safety posture

- **fail-closed**: on any doubt the host keeps its conservative defaults
- No auto-rewrite on startup; `apply` is always explicit
- Audit + idempotent revert + pre-write backup
- No bundled asset packs / skill packs / "redteam" content
- Read [SECURITY.md](SECURITY.md) before using it on a machine you care about

## v3 adapter layer (multi-host)

`bin/oag.js` drives any registered host adapter. Shared safety work (lock → journal → race check →
backup → atomic write → read-back verify → restore) lives in `src/core/safe-write.js`; an adapter only
answers three things: *where is the host / which version*, *what text should be written*, *how to verify
the host actually accepted it*.

```bash
node bin/oag.js adapters                       # dsh, codex, claude-code
node bin/oag.js status                         # host + version + capabilities
node bin/oag.js plan                           # dry-run diff
node bin/oag.js apply --yes                    # locked, journalled, verified, audited
node bin/oag.js verify                         # 0 pass / 1 fail / 2 unverified
node bin/oag.js recover --yes                  # restore from the journal's backup
node bin/oag.js audit 20
```

Per-host mechanics (why they differ):

| host | format | mechanism |
|---|---|---|
| DSH | YAML | line-anchored managed block (`# >>> … <<<`) |
| Codex | TOML | **key merge** + sidecar state file for safe `revert` |
| Claude Code | JSON | **namespace object** (`_openAgentGate`) — JSON has no comments, so no markers |

`probe` asks the **host itself** to validate the config (not just "is the text there"):

```bash
node bin/oag.js probe --adapter codex --cli <path-to>/codex.cmd
#   ✓ schema-accepted   宿主 --strict-config 未报未知字段
#   ✓ host-ran          turn.completed + 有回复
```

If no `DEEPSEEK_API_KEY` is available it returns `skipped` (exit 2) — never a pass.

Exit codes: `0` ok · `1` verify failed · `2` unverified/needs `--yes` · `3` host/version · `4` race/lock ·
`5` IO · `6` recover required / marker corrupt · `7` rollback failed.

## Policy engine + doctor (v4)

Describe *intent*, not config snippets; the engine compiles it per host and **refuses to pretend**:

```bash
node bin/oag.js policy                       # 预览：决策表 + 每宿主"能落地/做不到"
node bin/oag.js policy --require-complete    # 有任何 unsupported 就 exit 2（CI 用）
node bin/oag.js apply --policy open/policy.example.json --yes
node bin/oag.js doctor                       # 跨宿主自检（宿主/配置可解析/残留/审计）
node bin/oag.js doctor --json                # 机器可读
node bin/oag.js continue --adapter codex --max 1 --prompt "..."   # 自动续跑（wrapper，硬上限 10）
node bin/oag.js probe --adapter dsh          # 行为探针（金丝雀；环境不满足则 skipped）
```

`continue` uses the host's own `exec resume <session>` (Codex verified); it is a **wrapper** because
no host exposes an "auto-continue" config key. Native alternative (also verified):

```bash
node bin/oag.js hook install --codex-home ~/.codex --max 2   # Stop hook -> decision:block
node bin/oag.js hook status | remove
```
Codex only runs hooks that are **trusted** — invoke with `--dangerously-bypass-hook-trust` or complete
its trust flow. The generated hook refuses to loop (`stop_hook_active`) and counts per session. `probe` classifies by S3 side-effect > S2 denial text >
`inconclusive` — never a pass without evidence. Multi-file changes go through `src/core/txn.js`
(all-or-nothing, with its own journal and recovery).

Policy shape (`open/policy.example.json`): `{version, identity, rules[{action,decision,scope}], autoContinue}`.
Precedence is `deny > ask > allow`, independent of declaration order. Actions: `READ / WRITE /
EXEC_SAFE / EXEC_DESTRUCTIVE / EXEC_INSTALL / EXEC_GIT_WRITE / NET`.

Compilation is capability-aware — e.g. Codex gets `approval_policy="never"` for `EXEC_* = allow`,
`sandbox_mode="read-only"` for `WRITE = deny`; DSH only gets `identity` because it has no verified
relaxation key (`approval.policy=never` means **auto-reject**, not "open"). Everything unlandable is
reported as `unsupported` with a reason. See [docs/ARCH_v4.md](docs/ARCH_v4.md).

## Second reviewer (cheap)

`scripts/codex-review.sh` drives an external agent harness (Codex CLI) with a third-party
OpenAI-compatible model to review your own code — good for finding real bugs without
spending review-model quota:

```bash
./scripts/codex-review.sh                        # review uncommitted changes
./scripts/codex-review.sh --files "src/a.js lib/b.js" --max 5
./scripts/codex-review.sh --base main --focus correctness --strict
```

Requires `codex` on PATH, `DEEPSEEK_API_KEY` in env or `D:/Programs/hermes_data/.env`,
and `--approve-for-me` semantics (verified on codex-cli 0.167.0). Findings are **candidates** —
verify each against the code and add a regression test per fix.

## License

MIT
