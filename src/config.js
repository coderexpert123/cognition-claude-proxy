// Credential loading: reads windsurf_api_key from the Devin CLI's
// credentials.toml, or CCP_API_KEY env override.
//
// Devin CLI follows XDG on every Unix, macOS included: credentials live in
// the DATA dir ($XDG_DATA_HOME/devin or ~/.local/share/devin), not the
// config dir (~/.config/devin). Windows uses %APPDATA%\devin.
// https://docs.devin.ai/cli/enterprise/devin-auth

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function credentialsPath({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (env.CCP_CREDENTIALS) return env.CCP_CREDENTIALS;
  if (platform === "win32")
    return path.join(
      env.APPDATA || path.join(home, "AppData", "Roaming"),
      "devin",
      "credentials.toml"
    );
  return path.join(
    env.XDG_DATA_HOME || path.join(home, ".local", "share"),
    "devin",
    "credentials.toml"
  );
}

export function loadApiKey() {
  if (process.env.CCP_API_KEY) return process.env.CCP_API_KEY;

  const credPath = credentialsPath();
  let text;
  try {
    text = fs.readFileSync(credPath, "utf8");
  } catch {
    throw new Error(
      `credentials file not readable at ${credPath}. ` +
        `Run \`devin auth login\` or set CCP_API_KEY / CCP_CREDENTIALS.`
    );
  }
  const m = text.match(/windsurf_api_key\s*=\s*["']([^"'\n]+)["']/);
  if (!m)
    throw new Error(
      `windsurf_api_key not found in ${credPath}. Set CCP_API_KEY instead.`
    );
  return m[1];
}
