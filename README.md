# agent-open-layer

> **This is not a security sandbox.** On a Windows box without administrator rights this project gives you
> *intent-level* blocking and evidence. It has been observed to **let actions through when the hook fails
> (6/6 in testing)**, a split-up command sequence can get around intent matching, and network isolation has only
> been verified by a honeypot on **the paths that were probed** — not on every egress path.
> Do not use it to contain an untrusted or adversarial agent.
>
> **装好后，agent 在正常情况下会被拦在 `D:/agent-work` 内并留下记录；这不等于它无法越界。
> 出现拦截记录说明在起作用，没有记录不能说明没有越界。重要数据不要放在 agent 能访问的机器上。**

**Config-first permission & control layer for AI coding agents** — *not* a "make it unlimited" switch.

Uses each host's **official extension surfaces only** (config layer / hooks / plugin API).
**Zero patches to host source.** Nothing in `node_modules` is touched, no `.asar` is rewritten,
no content anchors are replaced.

What it buys you: **explicit policy, an action-level guard, audit with policy fingerprints,
transactional rollback, and a pre-run/post-run supervisor**.
What it does **not** buy you: a security boundary against a determined agent *by itself* —
that requires a different security principal (L0). Read
[docs/SECURITY-BOUNDARY.md](docs/SECURITY-BOUNDARY.md) before trusting it with anything you care about.

> 中文详细说明（面向使用者，含每层怎么验、怎么停用与恢复）：[docs/GUIDE-zh.md](docs/GUIDE-zh.md)
> 分层设计与完成状态：[docs/LAYERS.md](docs/LAYERS.md)

## Status — what is actually verified (2026-11-11)

Measured on Windows 11 with Codex CLI 0.167.0 / DeepSeek Harness 0.1.0-rc.7.
"Verified" means a probe or a real side effect was observed, not that the code looks right.

| Layer | What it does | Evidence |
|---|---|---|
| **L0** principal isolation | separate OS account + NTFS ACLs | **probe-verified** — 14 checks as `agent_runner`: workspace writable; `.env` read / user dir write / `.ssh` list / `C:\\Windows` write all BLOCKED |
| **L0** gate tamper-resistance | agent cannot edit or delete its own gate | **probe-verified** — modify hooks.json / modify guard script / delete guard script / modify policy.json all BLOCKED |
| **L0** gate still runnable | gate must be readable+executable *by that account* | **probe-verified** — `node oag-guard.mjs` runs as `agent_runner`, empty event → `{"decision":"block"}` |
| **L1** write scoping | allowlist of writable roots, outside denied | **probe-verified** (8-action matrix) |
| **L2** network | sandbox egress + action-level fallback | **probe-verified (narrow)** — under `network_access=false` a local honeypot recorded **0 requests on the probed path** (server-side view, not the agent's claim); negative control (`--dangerously-bypass`) hit the honeypot and fetched `example.com`. This does **not** prove shell/git/pip/DNS/raw-socket egress is blocked |
| **L3** credentials | env scrubbing + credential-collection hard deny | **probe-verified** — agent self-test `KEYLEN=0`, model call still works; `git credential fill` / `.ssh` / DPAPI → deny |
| **L4** host policy + guard | fail-closed guard, canary, watchdog | **probe-verified** — host fails open on 6/6 hook failures, so the guard closes on its own errors |
| **L5** out-of-band supervision | baseline hashes before/after a run, taint detection | **probe-verified** — editing `package.json` → tainted, exit 11 |
| **L6** promote-after-review | pre-run `git bundle` snapshot, human reviews diff | **probe-verified** — real repo rehearsal, bundle verifies, rollback works |

Test suite: **125/125**.

```bash
node --test tests/*.test.mjs
```

## The one picture

```
        user's account (owns the gate files, can change policy)
                    |
        +-----------v------------+
        |  policy.json (rules)   |  action x decision x scope
        +-----------+------------+
                    | compiled to host config + PreToolUse guard
   +----------------v-----------------+
   | sandbox account (L0)             |  separate principal -> cannot edit the gate
   |   host process + guard           |  guard: fail-closed, audited
   |   writable: D:\\work only         |
   +----------------+-----------------+
                    | artifacts (patches / diffs)
        +-----------v------------+
        | human reviews the diff |  L6: snapshot -> run -> taint check -> promote
        +------------------------+
```

Key idea: **approval moves from "every tool call" to "artifact promotion"**. The agent works freely
inside an isolated principal, and a human reviews what it actually produced.

## Install / use

```bash
git clone https://github.com/qinp38260-boop/agent-open-layer.git
cd agent-open-layer
node bin/oag.js status                  # host versions, which are configured
node bin/oag.js plan --adapter codex    # what would change (dry run)
```

### Commands

| Command | Purpose |
|---|---|
| `oag status` | host versions, adapter readiness |
| `oag plan --adapter <a>` | show the exact config delta, change nothing |
| `oag apply --adapter <a>` | write the managed block + sidecar state (backed up first) |
| `oag probe --adapter <a>` | **behavioral** probe: does the host really honor it (writes a canary, checks the side effect) |
| `oag verify --adapter <a>` | verify current state matches the policy |
| `oag recover --adapter <a>` | roll back the managed block from the transaction log |
| `oag audit [--policy <p>]` | read the audit log, grouped by policy fingerprint |
| `oag doctor` | environment/host sanity, with check marks |
| `oag guard status\|install\|remove\|canary\|audit` | the PreToolUse action gate |
| `oag run -- <cmd>` | supervisor: baseline -> run -> taint check (exit 0/10/11) |
| `oag sandbox plan\|check` | detect what isolation this machine can do (account / WSL / container) |
| `oag layers` | per-layer evidence level + **the weakest link** |

## Policy DSL

```json
{
  "version": 1,
  "identity": { "stripHostIdentity": true },
  "rules": [
    { "action": "READ",             "decision": "allow", "scope": { "paths": ["workspace/**", "!workspace/.git/**"] } },
    { "action": "WRITE",            "decision": "allow", "scope": { "paths": ["workspace/**"] } },
    { "action": "EXEC_SAFE",        "decision": "allow", "scope": {} },
    { "action": "EXEC_DESTRUCTIVE", "decision": "deny",  "scope": {} },
    { "action": "EXEC_INSTALL",     "decision": "ask",   "scope": {} },
    { "action": "EXEC_GIT_WRITE",   "decision": "ask",   "scope": {} },
    { "action": "NET",              "decision": "ask",   "scope": { "domains": ["api.github.com"] } }
  ],
  "autoContinue": { "enabled": false, "maxContinues": 1 }
}
```

Precedence: `deny > ask > allow`. Two profiles ship in `open/`: `policy.review.json` (read-only review)
and `policy.dev.json` (writable workspace, everything else gated).

**Intent, not syntax.** The guard normalizes every tool call to `{op, targets}` before judging, because
blocking one spelling just teaches the agent another (`rm` -> `del` -> `Remove-Item` -> `apply_patch *** Delete File:`).
Tests are equivalence assertions: every spelling of the same intent must get the same decision.

## The gate (PreToolUse)

```bash
node bin/oag.js guard install --codex-home D:/agent-work/.codex --policy D:/agent-work/.codex/policy.json
node bin/oag.js guard canary --codex-home D:/agent-work/.codex --live   # proves it blocks a live host action
```

Properties that are non-negotiable, each backed by a measurement:

1. **fail-closed** — the host fails open on hook crashes/timeouts/garbage (6/6 measured), so bad JSON,
   unreadable policy, timeout, empty event => `block`.
2. **watchdog + input cap** — a slow guard is an absent guard.
3. **audit outside the writable domain** — audit inside the agent's writable area is not audit.
4. **the denial message never lists allowed paths** — that is a bypass roadmap for a goal-directed agent.
5. **canary before every run** — version upgrades and missing hook-trust show up as *silent* failure.

## L0: separate principal (the real boundary)

Create the account once (admin), then everything else needs no elevation:

```powershell
net user agent_runner * /add
mkdir D:/agent-work
icacls D:/agent-work /grant "agent_runner:(OI)(CI)M"
icacls "D:\Programs\hermes_data\.env" /deny "agent_runner:(F)"
```

Gate files must be **readable + executable but not writable** by that account. Do **not** use
`icacls /deny ...:(W)` — `(W)` includes `SYNCHRONIZE`, which is required to open a file at all, so the
guard can no longer read its own policy and dies -> host fails open -> **protection silently disappears**.
Correct form:

```cmd
icacls "D:/agent-work\.codex\hooks.json" /inheritance:r ^
  /grant "p1553:(F)" /grant "SYSTEM:(F)" /grant "Administrators:(F)" /grant "agent_runner:(RX)"
```

The acceptance script must be ASCII + UTF-8 BOM (PowerShell 5.1 reads BOM-less UTF-8 as ANSI and breaks on CJK).
Run it **as the sandbox account** and judge the file it wrote, from outside.

Stop / resume (state is a fact to be judged, never remembered):

```powershell
net user agent_runner /active:no
net user agent_runner /active:yes
```

`/active:no` needs admin (non-admin => system error 5); revoking ACLs only needs file ownership.
After stopping, `oag layers` reports L0 as `config-only`: *"account disabled -> isolation not in effect
(evidence and ACLs kept; enabling restores it)"*. It will not keep claiming "isolated".

## L6: promote after review

```bash
oag run --cwd D:/agent-work/repo --codex-home D:/agent-work/.codex \
        --policy D:/agent-work/.codex/policy.json \
        --snapshot D:/agent-work/repo --fail-on-taint -- <command>
```

Exit codes: `0` clean / `10` canary failed (never started) / `11` tainted.
A rehearsal caught `package.json` -> `{"scripts":{"postinstall":"echo pwned"}}` —
writes look innocent, the diff does not lie. See [docs/L6-WORKFLOW.md](docs/L6-WORKFLOW.md).

## Measured host facts (do not re-derive these the hard way)

| Fact | Measurement |
|---|---|
| Windows `workspace-write` + `never` | degrades to **read-only**, even inside the workspace |
| Windows `danger-full-access` | writes **outside** the workspace too -> no native OS boundary on Windows |
| headless approvals | `never` and `on-request` both mean "deny everything" (nobody to ask) |
| host hook failures | **fail-open 6/6**: crash / garbage / empty / exit2 / timeout / no decision |
| env scrubbing | `shell_environment_policy.inherit="core"` + excludes => agent sees `KEYLEN=0`, model still works |
| `matcher:"*"` in hooks.json | matches nothing; use `matcher:""` |
| hook trust | requires `--dangerously-bypass-hook-trust` (or the official trust flow), otherwise silently skipped |

## Exit codes

`0` ok · `1` verification failed · `2` verification could not run · `3` host capability missing ·
`4` race · `5` IO · `6` marker corrupted · `7` rollback failed · `10` canary failed · `11` tainted.

## Evidence and docs

- [docs/GUIDE-zh.md](docs/GUIDE-zh.md) — 中文详细说明（推荐从这里开始）
- [docs/LAYERS.md](docs/LAYERS.md) — per-layer status and gaps
- [docs/SECURITY-BOUNDARY.md](docs/SECURITY-BOUNDARY.md) — what was measured, including the failures
- [docs/PROBES.md](docs/PROBES.md) — probe matrix
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) — acceptance standard (negative control first, rule of three)
- [docs/evidence/](docs/evidence/) — raw acceptance output produced by the sandbox account

## What this does NOT do (read before trusting it)

- It does not make a host "unlimited" or "jailbroken".
- Without L0 it is **a tripwire, not a boundary**: same principal means the agent can edit the gate.
  (Measured: with a single account it did remove the deny ACE, edit the hook, and put it back.)
- Indirect execution (Makefile, `npm run`, `conftest.py`) is only partially covered by the monitored set.
- Network policy at L2 is a declaration; enforcement depends on the host's sandbox.
- The Claude Code adapter is derived from package strings (no live Claude CLI on the test machine) —
  treat it as `config-only` until you probe it yourself.

## License

MIT — see [LICENSE](LICENSE).
