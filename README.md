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
