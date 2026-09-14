// Credential loading: reads windsurf_api_key from the Devin CLI's
// credentials.toml, or CCP_API_KEY env override.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function loadApiKey() {
  if (process.env.CCP_API_KEY) return process.env.CCP_API_KEY;

  const base =
    process.env.APPDATA ||
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"));
  const credPath =
    process.env.CCP_CREDENTIALS ||
    path.join(base, "devin", "credentials.toml");

  let text;
  try {
    text = fs.readFileSync(credPath, "utf8");
  } catch {
    throw new Error(
      `credentials file not readable at ${credPath}. ` +
        `Set CCP_API_KEY or CCP_CREDENTIALS instead.`
    );
  }
  const m = text.match(/windsurf_api_key\s*=\s*["']([^"'\n]+)["']/);
  if (!m)
    throw new Error(
      `windsurf_api_key not found in ${credPath}. Set CCP_API_KEY instead.`
    );
  return m[1];
}
