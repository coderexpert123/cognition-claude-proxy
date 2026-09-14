# cognition-claude-proxy — Agentic Brain

## What this is

A zero-dependency Node.js proxy that exposes Cognition/Devin's internal
Codeium Connect-RPC inference backend (`server.codeium.com`) through the
Anthropic Messages API, so Claude Code (or any Anthropic-compatible harness)
can use Devin's model catalog — SWE-2, GLM-5.2, DeepSeek V4.1 Flash, etc. —
as its backend.

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

- `PROTOCOL.md` — consult when debugging upstream request/response issues
- `src/models.json` — consult when model catalog changes; regenerate via
  live `GetCliModelConfigs` capture
- `claude-settings.json` — generated, do not hand-edit; run
  `node scripts/gen-settings.js` after `models.json` updates

## Model waterfall (pinned 2026-09-14)

- fable/orchestrate → `glm-5-2` (free, 200K)
- opus/deep-plan → `deepseek-v4-1-flash-max[1m]` (1M, max thinking)
- sonnet/execute → `swe-2-max` (free, 262K, max effort)
- verifier → `glm-5-2` (free, 200K, high — dispatched explicitly)
- haiku/background → `swe-2-medium` (free, 262K)
- `dclaude --free` → opus/deep-plan `glm-5-2` (replaces paid deepseek);
  sonnet/haiku stay on SWE-2 (already free)

Effort is baked into the model variant (`-max`=xhigh, `-high`=high,
`-medium`=medium), so selecting the model ID pins effort automatically.

## Headless subagent dispatch (Devin CLI)

`run_subagent` is buggy — never use it. All subagent work is dispatched as a
headless `devin -p` subprocess via `exec` (background, `timeout: 0`),
monitored with `get_output(shell_id)` until exit. Run from the repo root:

- **deep-planner:** `devin -p "<task>" --model deepseek-v4-1-flash-max --permission-mode auto --respect-workspace-trust false`
- **builder:** `devin -p "<task>" --model swe-2-max --permission-mode accept-edits --respect-workspace-trust false`
- **verifier:** `devin -p "<task>" --model glm-5-2 --permission-mode auto --respect-workspace-trust false`

Handoff is file-based: planner writes `spec.md`, builder writes code
(verify via `git diff`), verifier writes `verify.md`. The orchestrator
reads the artifact file after the subprocess exits.

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
