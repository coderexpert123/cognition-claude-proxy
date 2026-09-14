// Model catalog: live-synced from GetCliModelConfigs (application/proto unary),
// falling back to a bundled snapshot captured 2026-09-14.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE } from "./codeium.js";
import { fStr, fMsg, decodeMsg } from "./proto.js";

const SNAPSHOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "models.json"
);

let cache = null;

// GetCliModelConfigs request = bare protobuf (no Connect envelope),
// content-type application/proto, single f1 = metadata message.
function buildConfigRequest(apiKey) {
  const meta = Buffer.concat([
    fStr(1, "devin-cli"),
    fStr(2, "3000.10.21"),
    fStr(3, apiKey),
    fStr(5, process.platform === "win32" ? "windows" : process.platform),
    fStr(7, "3000.10.21"),
    fStr(12, "chisel"),
    fStr(28, "chisel"),
  ]);
  return fMsg(1, meta);
}

// Response: repeated f1 = model entries.
//   f1=display name, f18=context window, f22=model id,
//   f23={f13=max output tokens, f23=family slug}, f32×N=pricing rows.
export function parseModelConfigs(buf) {
  const models = [];
  for (const { f, wt, v } of decodeMsg(buf)) {
    if (f !== 1 || wt !== 2) continue;
    const m = decodeMsg(v);
    const get = (n, w) => m.find((x) => x.f === n && x.wt === w)?.v;
    const id = get(22, 2)?.toString("utf8");
    if (!id) continue;
    let maxOutput = null;
    let family = null;
    const cfg = get(23, 2);
    if (cfg) {
      const c = decodeMsg(cfg);
      maxOutput = c.find((x) => x.f === 13 && x.wt === 0)?.v ?? null;
      family = c.find((x) => x.f === 23 && x.wt === 2)?.v?.toString("utf8") ?? null;
    }
    models.push({
      id,
      name: get(1, 2)?.toString("utf8") ?? id,
      context: get(18, 0) ?? null,
      maxOutput,
      family,
    });
  }
  return models;
}

async function fetchModels(apiKey) {
  const resp = await fetch(
    `${BASE}/exa.api_server_pb.ApiServerService/GetCliModelConfigs`,
    {
      method: "POST",
      headers: {
        "content-type": "application/proto",
        authorization: `Basic ${apiKey}-${apiKey}`,
      },
      body: buildConfigRequest(apiKey),
    }
  );
  if (!resp.ok) throw new Error(`GetCliModelConfigs ${resp.status}`);
  const models = parseModelConfigs(Buffer.from(await resp.arrayBuffer()));
  if (!models.length) throw new Error("empty model config response");
  return models;
}

export async function getModels(apiKey) {
  if (cache) return cache;
  try {
    cache = await fetchModels(apiKey);
    cache.source = "live";
  } catch (e) {
    cache = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
    cache.source = `snapshot (${e.message})`;
  }
  return cache;
}

export function contextFor(models, id) {
  return models.find((m) => m.id === id)?.context ?? null;
}
