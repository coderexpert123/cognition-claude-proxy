// Connect-RPC client for the Devin CLI's inference backend (application/connect+proto).

import crypto from "node:crypto";
import zlib from "node:zlib";
import { fVarint, fStr, fMsg, fF64, decodeMsg } from "./proto.js";

export const BASE = process.env.CCP_UPSTREAM || "https://server.codeium.com";
const RPC_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";

const CLIENT_NAME = "devin-cli";
const CLIENT_VERSION = "3000.10.31";
const APP_NAME = "chisel";

// ---------- request building ----------

function buildMetadata(apiKey) {
  return Buffer.concat([
    fStr(1, CLIENT_NAME),
    fStr(2, CLIENT_VERSION),
    fStr(3, apiKey),
    fStr(4, "en"), // locale
    fStr(5, process.platform === "win32" ? "windows" : process.platform),
    fStr(7, CLIENT_VERSION),
    fStr(12, APP_NAME),
    fStr(28, APP_NAME),
  ]);
}

// chisel message: {f2: role, f3: text, f6: toolcall, f7: call_id, f11: thinking, f12: sig, f18: 'sealed'}
// roles: 1=user, 2=assistant, 4=tool_result
function buildChatMessage(m) {
  const parts = [fMsg(1, fStr(6, m.id || crypto.randomUUID()))];
  parts.push(fVarint(2, m.role));
  if (m.text) parts.push(fStr(3, m.text));
  for (const tc of m.toolCalls || []) {
    parts.push(
      fMsg(
        6,
        Buffer.concat([
          fStr(1, tc.id),
          fStr(2, tc.name),
          fStr(3, tc.argsJson || "{}"),
        ])
      )
    );
  }
  if (m.toolCallId) parts.push(fStr(7, m.toolCallId));
  if (m.thinking) parts.push(fStr(11, m.thinking));
  if (m.signature) {
    parts.push(fStr(12, m.signature));
    parts.push(fStr(18, "sealed"));
  }
  return fMsg(3, Buffer.concat(parts));
}

function buildCompletionConfig(req) {
  // upstream rejects out-of-range sampling params — clamp into the legal
  // envelope rather than pass client values through
  const temp = req.temperature > 0 && req.temperature <= 1 ? req.temperature : 1.0;
  const topP = req.top_p > 0 && req.top_p <= 1 ? req.top_p : 0.95;
  const topK = Number.isInteger(req.top_k) && req.top_k >= 1 ? req.top_k : 40;
  const maxTok = req.max_tokens >= 1 ? Math.floor(req.max_tokens) : 128000;
  return Buffer.concat([
    fVarint(1, 1),
    fVarint(2, maxTok),
    fVarint(3, 400),
    fF64(5, temp),
    fVarint(7, topK),
    fF64(8, topP),
  ]);
}

function buildTool(t) {
  const name = t.name || "tool";
  const desc = t.description || "";
  const schema = JSON.stringify(t.input_schema || { type: "object" });
  return fMsg(
    10,
    Buffer.concat([fStr(1, name), fStr(2, desc), fStr(3, schema)])
  );
}

export function buildRequestBody({ apiKey, system, messages, tools, model, completion }) {
  const chunks = [
    fMsg(1, buildMetadata(apiKey)),
    fStr(2, system || ""),
    ...messages.map(buildChatMessage),
    fVarint(7, 5),
    fMsg(8, completion),
    ...(tools || []).map(buildTool),
    fMsg(15, Buffer.concat([
      fStr(1, crypto.randomUUID()),
      fVarint(2, 1),
      fVarint(3, 4),
    ])),
    fStr(16, crypto.randomUUID()),
    fVarint(20, 1),
    fStr(21, model),
  ];
  const msg = Buffer.concat(chunks);
  const header = Buffer.alloc(5);
  header.writeUInt32BE(msg.length, 1); // header[0] stays 0 (uncompressed data frame)
  return Buffer.concat([header, msg]);
}

export { buildCompletionConfig };

// ---------- response parsing ----------

// One Connect frame -> normalized event
export function decodeEvent(payload) {
  const fields = decodeMsg(payload);
  const ev = {};
  for (const { f, wt, v } of fields) {
    if (wt !== 2) {
      if (f === 4) ev.flag4 = v;
      if (f === 5) ev.stop = v;
      continue;
    }
    switch (f) {
      case 3:
        ev.text = (ev.text || "") + v.toString("utf8");
        break;
      case 6: {
        // tool call: start has {f1:id, f2:name}; delta has {f3:args}
        const sub = decodeMsg(v);
        for (const s of sub) {
          if (s.wt !== 2) continue;
          const t = s.v.toString("utf8");
          if (s.f === 1) (ev.tool = ev.tool || {}).id = t;
          else if (s.f === 2) (ev.tool = ev.tool || {}).name = t;
          else if (s.f === 3) ev.toolArgsDelta = (ev.toolArgsDelta || "") + t;
        }
        break;
      }
      case 7: {
        // meta: f2/f3/f5 counters, f9 model, f8 request ids
        const sub = decodeMsg(v);
        for (const s of sub) {
          if (s.f === 9 && s.wt === 2) ev.model = s.v.toString("utf8");
          if (s.f === 2 && s.wt === 0) ev.inputTokens = s.v;
          if (s.f === 3 && s.wt === 0) ev.outputTokens = s.v;
          if (s.f === 5 && s.wt === 0) ev.cachedTokens = s.v;
        }
        break;
      }
      case 9:
        ev.thinking = (ev.thinking || "") + v.toString("utf8");
        break;
      case 10:
        ev.signature = v.toString("utf8");
        break;
      case 21:
        ev.sealed = v.toString("utf8") === "sealed";
        break;
      default:
        break;
    }
  }
  return ev;
}

// POST a request, yield decoded events as frames stream in.
export async function* sendChat(apiKey, requestFields, { signal } = {}) {
  const body = buildRequestBody(requestFields);
  const resp = await fetch(BASE + RPC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      authorization: `Basic ${apiKey}-${apiKey}`,
    },
    body,
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`upstream ${resp.status}: ${text.slice(0, 500)}`);
    err.status = resp.status;
    throw err;
  }

  const reader = resp.body.getReader();
  try {
    let buf = Buffer.alloc(0);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = Buffer.concat([buf, Buffer.from(value)]);
      // frames: 1B flag + 4B len + payload
      while (buf.length >= 5) {
        const flag = buf[0];
        const ln = buf.readUInt32BE(1);
        if (buf.length < 5 + ln) break;
        const payload = buf.subarray(5, 5 + ln);
        buf = buf.subarray(5 + ln);
        if (flag & 0x02) {
          // Connect end-stream frame: JSON {error?, metadata?}. An error here
          // means the stream failed mid-way — surface it, don't end cleanly.
          const raw = payload.toString("utf8");
          let t = null;
          try { t = JSON.parse(raw); } catch {}
          if (t && t.error) {
            const err = new Error(
              `upstream stream error ${t.error.code || "unknown"}: ${String(t.error.message || raw).slice(0, 300)}`
            );
            err.code = t.error.code || "unknown";
            err.status =
              { unauthenticated: 401, permission_denied: 403, resource_exhausted: 429, failed_precondition: 400, invalid_argument: 400 }[
                t.error.code
              ] || 502;
            throw err;
          }
          yield { trailer: true, raw };
          continue;
        }
        if (flag & 0x01) {
          // frame payload is compressed (server chose it)
          yield decodeEvent(zlib.gunzipSync(payload));
          continue;
        }
        yield decodeEvent(payload);
      }
    }
    if (buf.length) throw new Error(`upstream stream truncated mid-frame (${buf.length} bytes left)`);
  } finally {
    reader.cancel().catch(() => {});
  }
}
