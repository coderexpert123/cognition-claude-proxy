#!/usr/bin/env node
// cognition-claude-proxy — Anthropic Messages API frontend for the
// Cognition/Codeium exa.api_server_pb.ApiServerService backend.
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
    // Buffer first event before committing to 200 status.
    let sseLog = null;
    const ac = new AbortController();
    res.on("close", () => ac.abort()); // client gone -> stop consuming upstream
    try {
      const gen = sendChat(apiKey(), requestFields, { signal: ac.signal });
      const first = await gen.next();

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      const tx = new ChiselToAnthropicStream(model);
      let nEvents = 0;
      sseLog = process.env.CCP_DEBUG_SSE
        ? fs.createWriteStream(path.join(os.tmpdir(), `ccp-sse-${Date.now()}.log`))
        : null;
      const write = (s) => { sseLog?.write(s); res.write(s); };
      if (!first.done) {
        nEvents++;
        if (process.env.CCP_DEBUG) console.log("[ev0]", JSON.stringify(first.value).slice(0, 200));
        for (const s of tx.feed(first.value)) write(s);
      }
      for await (const ev of gen) {
        nEvents++;
        for (const s of tx.feed(ev)) write(s);
      }
      for (const s of tx.finish()) write(s);
      if (process.env.CCP_DEBUG) console.log(`[resp] events=${nEvents} stop=${tx.stopReason}`);
      sseLog?.end();
      res.end();
    } catch (e) {
      if (e.name !== "AbortError") console.error("[upstream error]", e.message);
      sseLog?.end();
      if (res.destroyed) return; // client already gone — nothing to write to
      if (!res.headersSent) {
        anthropicError(res, e.status || 502, "api_error", e.message);
      } else {
        // Stream already committed — deliver the failure as an SSE error
        // event (what the real API does) instead of a silent truncation.
        res.write(
          `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: e.message } })}\n\n`
        );
        res.end();
      }
    }
  } else {
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    try {
      const events = [];
      for await (const ev of sendChat(apiKey(), requestFields, { signal: ac.signal }))
        events.push(ev);
      const msg = eventsToMessage(events, model);
      if (process.env.CCP_DEBUG)
        console.log(`[resp] events=${events.length} blocks=${msg.content.length} stop=${msg.stop_reason}`);
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(msg));
    } catch (e) {
      if (e.name !== "AbortError") console.error("[upstream error]", e.message);
      if (!res.destroyed) anthropicError(res, e.status || 502, "api_error", e.message);
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
