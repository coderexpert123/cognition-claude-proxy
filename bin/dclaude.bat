@echo off
REM Devin CLI model backend wrapper using cognition-claude-proxy
REM
REM DCLAUDE ISOLATION PRINCIPLE:
REM All DCLAUDE-specific customizations must go in DCLAUDE-specific locations:
REM   - Memory: ~/.claude/projects/DCLAUDE/memory/
REM   - Settings/hooks: Only add to global settings.json if they check DCLAUDE_SESSION
REM DO NOT add DCLAUDE-specific items to main/global config
REM
REM RISK NOTE: this proxy uses your local Devin CLI credentials
REM (windsurf_api_key from %%APPDATA%%\devin\credentials.toml) to call the
REM Devin CLI's inference backend. GLM-5.2 and SWE-2 are free during the
REM current promo.
REM
REM USAGE:
REM   dclaude            -> DeepSeek/GLM/SWE-2 waterfall (default)
REM   dclaude --free     -> free models only (replaces the paid deepseek planner with glm-5-2;
REM                       sonnet/haiku stay on free SWE-2)
REM   dclaude -p "..."   -> args pass through to claude

SETLOCAL ENABLEDELAYEDEXPANSION
if not defined CCP_PORT set "CCP_PORT=8765"

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: node is not installed.
    exit /b 1
)

if not defined CCP_PROXY_DIR set "CCP_PROXY_DIR=%~dp0.."

REM Parse --free flag out of args (claude doesn't know it)
REM Re-quote each arg with "%~1" to preserve spaces in prompts
set "FREE_MODE=0"
set "PASSED_ARGS="
:argloop
if "%~1"=="" goto argdone
if /i "%~1"=="--free" (
    set "FREE_MODE=1"
) else (
    set "PASSED_ARGS=!PASSED_ARGS! "%~1""
)
shift
goto argloop
:argdone

if not defined TAVILY_API_KEY echo WARNING: TAVILY_API_KEY is not set. Tavily web search will be unavailable.

curl -sf -o nul "http://localhost:%CCP_PORT%/health" >nul 2>nul
if errorlevel 1 (
    echo Starting cognition-claude-proxy on port %CCP_PORT%...
    start /b "" node "%CCP_PROXY_DIR%\src\server.js"
    timeout /t 2 /nobreak >nul
)

set "ANTHROPIC_BASE_URL=http://localhost:%CCP_PORT%"
set "ANTHROPIC_AUTH_TOKEN=test"
set "API_TIMEOUT_MS=3000000"
set "DCLAUDE_SESSION=1"

REM Harness-native model catalog + per-model context windows via --settings.
REM claude-settings.json is generated from src/models.json (run scripts/gen-settings.js
REM after `devin models list` changes). Context handling:
REM   1M models  -> "[1m]" suffix on row model (stripped before upstream; beats env)
REM   200K models-> behavesAs "claude-opus-4-6" (catalog 200K; beats env)
REM   262K models-> env CLAUDE_CODE_MAX_CONTEXT_TOKENS=262000 (below)
REM   <262K      -> behavesAs 200K (safe under-assume)
set "CLAUDE_CODE_MAX_CONTEXT_TOKENS=262000"
set "SETTINGS_FILE=%CCP_PROXY_DIR%\claude-settings.json"

REM Model waterfall. Tiers map to Claude Code's fable/opus/sonnet/haiku aliases.
REM   fable  = planner subagent only (architecture-level planning)
REM   opus   = main thread (orchestrate, integrate, land) + deep-planner subagent
REM   sonnet = builder AND verifier subagents (separate dispatches, max effort)
REM   haiku  = background (light tasks)
REM --free fallback: replace the paid planner model (deepseek) with glm-5-2.
REM Sonnet/haiku stay on SWE-2 (free) — no reason to switch free tiers.
if "%FREE_MODE%"=="1" (
    set "ANTHROPIC_DEFAULT_FABLE_MODEL=glm-5-2"
    set "ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5-2"
    set "ANTHROPIC_DEFAULT_SONNET_MODEL=swe-2-max"
    set "ANTHROPIC_DEFAULT_HAIKU_MODEL=swe-2-medium"
    set "WATERFALL_NAME=Free fallback (planner glm-5-2 / main glm-5-2 / exec+verify swe-2-max / bg swe-2-med)"
) else (
    set "ANTHROPIC_DEFAULT_FABLE_MODEL=deepseek-v4-1-flash-max[1m]"
    set "ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5-2"
    set "ANTHROPIC_DEFAULT_SONNET_MODEL=swe-2-max"
    set "ANTHROPIC_DEFAULT_HAIKU_MODEL=swe-2-medium"
    set "WATERFALL_NAME=planner DeepSeek-V4.1-Flash-Max / main GLM-5.2 / exec+verify SWE-2-Max / bg SWE-2-Med"
)
set "ANTHROPIC_MODEL=opus"

echo.
echo [Devin CLI models via Connect-RPC]
echo.
echo Waterfall: !WATERFALL_NAME!
echo   fable  planner          - %ANTHROPIC_DEFAULT_FABLE_MODEL%
echo   opus   main + deep-plan - %ANTHROPIC_DEFAULT_OPUS_MODEL%
echo   sonnet execute + verify - %ANTHROPIC_DEFAULT_SONNET_MODEL%
echo   haiku  background       - %ANTHROPIC_DEFAULT_HAIKU_MODEL%
echo.
echo Default model: opus (%ANTHROPIC_DEFAULT_OPUS_MODEL%)
echo Context: 1M models use [1m] suffix, 200K use behavesAs, 262K use env=262000
echo Proxy: http://localhost:%CCP_PORT%
echo Settings: %SETTINGS_FILE%
echo.
echo Tavily web search: ENABLED
echo Built-in WebSearch is disabled -- it's Anthropic's server-side tool and
echo doesn't work through a local proxy.
echo.

claude --settings "%SETTINGS_FILE%" --disallowedTools WebSearch!PASSED_ARGS!
