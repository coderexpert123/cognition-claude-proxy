# cognition-claude-proxy — Agentic Brain

## What this is

A zero-dependency Node.js proxy that bridges the Anthropic Messages API to
the Devin CLI's Connect-RPC inference backend, so Claude Code (or any
Anthropic-compatible harness) can use Devin's model catalog — SWE-2,
GLM-5.2, DeepSeek V4.1 Flash, etc. — as its backend.

## Repo state

Two branches exist — this is load-bearing, not incidental:

- **`master`** — private working branch. Never push to GitHub.
- **`main`** — public branch. Keep its history and content free of
  internal process references and private working files.

The public repo is at `https://github.com/coderexpert123/cognition-claude-proxy`
(tagged `v0.1.0`, MIT licensed).

## Intelligence layers

1. **Protocol** — the wire format is documented inline in `src/codeium.js`
   and `src/proto.js` (Connect-RPC `connect+proto`, 5-byte framed stream,
   field mappings).
2. **Source** — `src/`: `server.js` (HTTP), `translate.js` (Anthropic↔Connect-RPC),
   `codeium.js` (upstream client), `proto.js` (protobuf codec), `config.js`
   (credential loader), `models.js` + `models.json` (catalog sync).
3. **Harness integration** — `bin/dclaude.bat` (wrapper), `claude-settings.json`
   (generated modelPicker rows), `scripts/gen-settings.js` (generator).

## Brain files

- `src/codeium.js` — consult when debugging upstream request/response issues
- `src/models.json` — consult when model catalog changes; regenerate via
  live `GetCliModelConfigs` response
- `claude-settings.json` — generated, do not hand-edit; run
  `node scripts/gen-settings.js` after `models.json` updates

## Model waterfall (pinned 2026-09-16)

- fable/planner → `deepseek-v4-1-flash-max[1m]` (paid, 1M, max thinking;
  architecture-level planning subagent only)
- opus/main thread + deep-plan → `glm-5-2` (free, 200K)
- sonnet/execute + verify → `swe-2-max` (free, 262K, max effort; builder and
  verifier run as separate dispatches)
- haiku/background → `swe-2-medium` (free, 262K)
- `dclaude --free` → fable/planner `glm-5-2` (replaces paid deepseek);
  opus stays on `glm-5-2`, sonnet/haiku stay on SWE-2 (already free)
- `dclaude --swe2` → all tiers `swe-2-max` (haiku `swe-2-medium`); use when
  non-SWE-2 models are unavailable — wins over `--free`

Effort is baked into the model variant (`-max`=xhigh, `-high`=high,
`-medium`=medium), so selecting the model ID pins effort automatically.

## Headless subagent dispatch (Devin CLI)

`run_subagent` is buggy — never use it. All subagent work is dispatched as a
headless `devin -p` subprocess via `exec` (background, `timeout: 0`),
monitored with `get_output(shell_id)` until exit. Run from the repo root:

- **planner:** `devin -p "<task>" --model deepseek-v4-1-flash-max --permission-mode auto --respect-workspace-trust false`
- **deep-planner:** `devin -p "<task>" --model glm-5-2 --permission-mode auto --respect-workspace-trust false`
- **builder:** `devin -p "<task>" --model swe-2-max --permission-mode accept-edits --respect-workspace-trust false`
- **verifier:** `devin -p "<task>" --model swe-2-max --permission-mode auto --respect-workspace-trust false`
  — a separate dispatch, never a continuation of the builder's session

Handoff is file-based: planner writes `plan.md`, deep-planner writes
`spec.md`, builder writes code (verify via `git diff`), verifier writes
`verify.md`. The orchestrator reads the artifact file after the subprocess exits.

Context windows: 1M models use `[1m]` suffix (stripped before upstream);
200K models use `behavesAs: "claude-opus-4-6"`; 262K models use env
`CLAUDE_CODE_MAX_CONTEXT_TOKENS=262000`. Precedence: `[1m]` > `behavesAs`
> env > 200K default.

## Gotchas

- **Upstream content filter** rejects certain phrases in Claude Code's system
  prompt. `sanitizeSystem` replaces the whole prompt with a neutral one + env
  bullets. Tool descriptions: strip file-access claims + cap at 480 chars
  (`sanitizeToolDesc`).
- **`[1m]` is the only context suffix Claude Code parses** — `[262k]` is
  rejected and stays in the model id sent upstream.
- **Cloud MCP connectors are disabled** when `ANTHROPIC_AUTH_TOKEN` is set
  (local proxy auth overrides claude.ai login). Local/stdio MCPs work fine.
- **The proxy uses local Devin CLI credentials** to authenticate. Free models
  (GLM-5.2, SWE-2) are the safest targets.
- **`dclaude` is in the user PATH** (`D:\My Repos\cognition-claude-proxy\bin`)
  — persistent across reboots. New terminals pick it up; already-open
  terminals need a restart.
- **`%~1` in the bat arg loop strips quotes** — `-p "create a file..."`
  became `-p create a file...` and claude only saw "create". Fixed by
  re-quoting each arg with `"%~1"`. The batch arg loop is fragile — if
  argument quoting breaks again, check `bin/dclaude.bat` first.
- **Multiple instances are safe** — `dclaude` health-checks the proxy on
  :8765 before starting. If already up, it reuses it. Second-instance
  `EADDRINUSE` is caught by `server.on("error")` and exits cleanly.
- **Upstream tool-call IDs can violate Anthropic's `^[a-zA-Z0-9_-]+$`**
  pattern (dots/colons/etc). `sanitizeToolId` in `translate.js` replaces
  invalid chars with `_` in BOTH directions — outbound so Claude Code never
  stores a bad ID, inbound so stored bad IDs from pre-fix sessions get
  cleaned on resume. Deterministic so tool_use/tool_result pairs stay
  matched. Fixed after `400 messages.N.content.N.tool_use.id` on resume.
- **Upstream can transiently fail valid requests** (`invalid_argument`,
  `internal`). The proxy normalizes requests (`normalizeChisel` merges
  consecutive assistant messages and stubs orphaned tool_results), clamps
  out-of-range sampling params, and retries upstream calls before the SSE
  response commits (`withRetries`, `CCP_MAX_ATTEMPTS`, default 8) — for
  streams the gate is the first content event, not the first frame, since
  errors can arrive after a leading metadata frame. Exhausted flaky failures
  surface as HTTP 500 so retrying clients get a second pass.
