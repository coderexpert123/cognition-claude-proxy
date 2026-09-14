// Generates claude-settings.json from src/models.json.
// Each model becomes a modelPicker row with context-window handling:
//   >=1M        -> "[1m]" suffix on the row model (stripped before upstream)
//   <=200K      -> behavesAs "claude-opus-4-6" (catalog 200K window)
//   200K..1M    -> no suffix/behavesAs; env CLAUDE_CODE_MAX_CONTEXT_TOKENS=262000 applies
// Run: node scripts/gen-settings.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const models = JSON.parse(fs.readFileSync(path.join(root, "src", "models.json"), "utf8"));

function rowFor(m) {
  const ctx = m.context ?? 0;
  let model = m.id;
  let behavesAs;
  if (ctx >= 1_000_000) model = `${m.id}[1m]`;
  else if (ctx <= 200_000) behavesAs = "claude-opus-4-6";
  // 200K < ctx < 1M: rely on env CLAUDE_CODE_MAX_CONTEXT_TOKENS=262000
  const label = m.name;
  const desc = `${Math.round(ctx / 1000)}K ctx${m.family ? ` · ${m.family}` : ""}`;
  const r = { model, label, description: desc };
  if (behavesAs) r.behavesAs = behavesAs;
  return r;
}

// Curated ordering: SWE-2 first (free promo), then GLM, DeepSeek, then rest by family.
const priority = ["swe-2", "glm-5.2", "deepseek-v4-1-flash", "deepseek-v4-flash", "deepseek-v4-pro"];
function rank(m) {
  const i = priority.findIndex((p) => (m.family ?? "").startsWith(p));
  return i === -1 ? 99 : i;
}
models.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));

const settings = {
  modelPicker: {
    options: models.map(rowFor),
    replaceBuiltInOptions: false,
  },
};

const out = path.join(root, "claude-settings.json");
fs.writeFileSync(out, JSON.stringify(settings, null, 2) + "\n");
console.log(`wrote ${out} (${models.length} rows)`);
