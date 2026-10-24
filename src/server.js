#!/usr/bin/env node
// cognition-claude-proxy — Anthropic Messages API frontend for the Devin CLI backend.
// Local-only: binds 127.0.0.1, expects the dummy ANTHROPIC_AUTH_TOKEN Claude Code sends.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadApiKey } from "./config.js";
import { BASE, buildCompletionConfig, sendChat } from "./codeium.js";
import { getModels } from "./models.js";
import {
  anthropicToChisel,
  eventsToMessage,
  ChiselToAnthropicStream,
} from "./translate.js";

const PORT = parseInt(process.env.CCP_PORT || "8765", 10);
const DEFAULT_MODEL = process.env.CCP_DEFAULT_MODEL || "swe-2-high";

let API_KEY = null;
function apiKey() {
  if (!API_KEY) API_KEY = loadApiKey();
  return API_KEY;
}

function anthropicError(res, status, type, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// Upstream intermittently returns invalid_argument/internal errors for valid
// requests (a per-attempt coin flip, not a per-request verdict). Retries are
// cheap — the failure arrives fast, before any content — so bounded retries
// mask the outage. Deterministic errors are excluded from retry.
const MAX_ATTEMPTS = parseInt(process.env.CCP_MAX_ATTEMPTS || "8", 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Edge read-timeout defense (proxy fronts such as Cloudflare 524): the edge
// kills a response that hasn't STARTED (~120s), but the window closes once
// bytes flow. So keep the first-event buffer uncommitted for
// HEADER_GRACE_MS — fast upstream failures still map to real HTTP statuses —
// then send headers + SSE heartbeat comments and let slow upstreams (and the
// retry loop) take as long as they need.
const HEADER_GRACE_MS = parseInt(process.env.CCP_HEADER_GRACE_MS || "60000", 10);
const SSE_PING_MS = parseInt(process.env.CCP_SSE_PING_MS || "15000", 10);

function retryableUpstream(e) {
  if (e.name === "AbortError") return false;
  if (["unauthenticated", "permission_denied", "failed_precondition"].includes(e.code)) return false;
  if (/prompt is too long/i.test(e.message)) return false;
  return true;
}

// Run `attempt()` up to MAX_ATTEMPTS times while errors stay retryable.
// Returns [result, attempts]; rethrows the last error when exhausted.
async function withRetries(attempt) {
  let tries = 0;
  while (true) {
    tries++;
    try {
      return [await attempt(), tries];
    } catch (e) {
      if (!retryableUpstream(e) || tries >= MAX_ATTEMPTS) {
        e.attempts = tries;
        throw e;
      }
      if (process.env.CCP_DEBUG)
        console.log(`[retry ${tries}/${MAX_ATTEMPTS}] ${e.message.slice(0, 140)}`);
      await sleep(150 * tries + Math.floor(Math.random() * 100));
    }
  }
}

// Status to surface when retries are exhausted. Flaky-class failures get 500
// so clients that retry 5xx (but never 4xx) get a second pass; deterministic
// upstream verdicts pass through untouched.
function finalStatus(e) {
  return retryableUpstream(e) ? 500 : e.status || 502;
}

async function handleMessages(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return anthropicError(res, 400, "invalid_request_error", "invalid JSON body");
  }

  const model = body.model || DEFAULT_MODEL;
  if (process.env.CCP_DEBUG) {
    console.log(
      `[req] model=${model} stream=${!!body.stream} msgs=${(body.messages || []).length} tools=${(body.tools || []).length} max=${body.max_tokens} thinking=${JSON.stringify(body.thinking || null)}`
    );
    const dump = path.join(os.tmpdir(), `ccp-req-${Date.now()}.json`);
    fs.writeFileSync(dump, JSON.stringify(body, null, 2));
    console.log(`[req] dump -> ${dump}`);
  }
  const chiselReq = anthropicToChisel(body);
  if (!chiselReq.messages.length)
    return anthropicError(res, 400, "invalid_request_error",
      "no user/assistant content after translation (upstream would 400)");
  const requestFields = {
    apiKey: apiKey(),
    system: chiselReq.system,
    messages: chiselReq.messages,
    tools: chiselReq.tools,
    model,
    completion: buildCompletionConfig({
      max_tokens: chiselReq.completion.max_tokens,
      temperature: chiselReq.completion.temperature,
      top_k: chiselReq.completion.top_k,
      top_p: chiselReq.completion.top_p,
    }),
  };

  if (body.stream) {
    // Buffer before committing to 200 status.
    let sseLog = null;
    const ac = new AbortController();
    // If the buffer outlives HEADER_GRACE_MS, startPing commits headers and
    // emits ": ping" comments so the edge read window can't fire mid-wait;
    // pings also cover idle gaps during generation until res.end().
    let graceTimer = null, pingTimer = null;
    const stopTimers = () => { clearTimeout(graceTimer); clearInterval(pingTimer); };
    res.on("close", () => { ac.abort(); stopTimers(); }); // client gone -> stop consuming upstream
    try {
      const sendSseHead = () => {
        if (res.headersSent) return;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
      };
      const startPing = () => {
        sendSseHead();
        if (pingTimer) return;
        pingTimer = setInterval(() => {
          if (!res.destroyed) res.write(": ping\n\n");
        }, SSE_PING_MS);
        pingTimer.unref?.();
      };
      // Pull until the first content-bearing event before committing the SSE
      // response: upstream can emit a metadata frame first and deliver its
      // error right AFTER it, so gating on frame 1 alone misses the failure.
      // Content = text/thinking/tool/stop/trailer. A fresh sendChat() per
      // attempt re-rolls routing entropy (fresh ids).
      let gen, buffered, tries;
      graceTimer = setTimeout(startPing, HEADER_GRACE_MS);
      graceTimer.unref?.();
      try {
        [[gen, buffered], tries] = await withRetries(async () => {
          const g = sendChat(apiKey(), requestFields, { signal: ac.signal });
          const buf = [];
          for (let i = 0; i < 10; i++) {
            const r = await g.next();
            if (r.done) break;
            buf.push(r.value);
            const v = r.value;
            if (v.text || v.thinking || v.tool || v.toolArgsDelta || v.signature ||
                v.stop !== undefined || v.trailer) break;
          }
          return [g, buf];
        });
      } finally {
        clearTimeout(graceTimer);
      }
      startPing(); // commits headers now if the grace timer didn't already

      const tx = new ChiselToAnthropicStream(model);
      let nEvents = 0;
      sseLog = process.env.CCP_DEBUG_SSE
        ? fs.createWriteStream(path.join(os.tmpdir(), `ccp-sse-${Date.now()}.log`))
        : null;
      const write = (s) => { sseLog?.write(s); res.write(s); };
      for (const ev of buffered) {
        nEvents++;
        if (nEvents === 1 && process.env.CCP_DEBUG)
          console.log("[ev0]", JSON.stringify(ev).slice(0, 200));
        for (const s of tx.feed(ev)) write(s);
      }
      for await (const ev of gen) {
        nEvents++;
        for (const s of tx.feed(ev)) write(s);
      }
      for (const s of tx.finish()) write(s);
      if (process.env.CCP_DEBUG)
        console.log(`[resp] events=${nEvents} stop=${tx.stopReason} tries=${tries}`);
      sseLog?.end();
      stopTimers();
      res.end();
    } catch (e) {
      stopTimers();
      if (e.name !== "AbortError") console.error("[upstream error]", e.message);
      sseLog?.end();
      if (res.destroyed) return; // client already gone — nothing to write to
      const note = e.attempts > 1 ? ` (${e.attempts} upstream attempts)` : "";
      if (!res.headersSent) {
        anthropicError(res, finalStatus(e), "api_error", e.message + note);
      } else {
        // Stream already committed — deliver the failure as an SSE error
        // event (what the real API does) instead of a silent truncation.
        res.write(
          `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: e.message + note } })}\n\n`
        );
        res.end();
      }
    }
  } else {
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    try {
      // Nothing is committed until the whole upstream stream is collected,
      // so the full request is retried, not just the first event.
      const [events, tries] = await withRetries(async () => {
        const evs = [];
        for await (const ev of sendChat(apiKey(), requestFields, { signal: ac.signal }))
          evs.push(ev);
        return evs;
      });
      const msg = eventsToMessage(events, model);
      if (process.env.CCP_DEBUG)
        console.log(`[resp] events=${events.length} blocks=${msg.content.length} stop=${msg.stop_reason} tries=${tries}`);
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(msg));
    } catch (e) {
      if (e.name !== "AbortError") console.error("[upstream error]", e.message);
      if (!res.destroyed) {
        const note = e.attempts > 1 ? ` (${e.attempts} upstream attempts)` : "";
        anthropicError(res, finalStatus(e), "api_error", e.message + note);
      }
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  try {
    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, upstream: BASE }));
    }
    if (req.method === "GET" && url === "/v1/models") {
      const models = await getModels(apiKey());
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          // Anthropic /v1/models shape (+vendor extras for context/max_output)
          data: models.map((m) => ({
            type: "model",
            id: m.id,
            display_name: m.name,
            created_at: "2025-01-01T00:00:00Z",
            context_window: m.context,
            max_output_tokens: m.maxOutput,
            family: m.family,
          })),
          has_more: false,
          first_id: models[0]?.id,
          last_id: models[models.length - 1]?.id,
          source: models.source,
        })
      );
    }
    if (req.method === "POST" && url === "/v1/messages") {
      return await handleMessages(req, res);
    }
    if (req.method === "POST" && url === "/v1/messages/count_tokens") {
      const raw = await readBody(req);
      const est = Math.ceil(raw.length / 8);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: est }));
    }
    anthropicError(res, 404, "not_found_error", `no route ${req.method} ${url}`);
  } catch (e) {
    if (!res.headersSent) anthropicError(res, 500, "api_error", String(e));
    else if (!res.destroyed) res.end();
  }
});

server.on("error", (e) => {
  console.error(`failed to bind 127.0.0.1:${PORT}: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`cognition-claude-proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`upstream: ${BASE}`);
  console.log(`default model: ${DEFAULT_MODEL}`);
});
