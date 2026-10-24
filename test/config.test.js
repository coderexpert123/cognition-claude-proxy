import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialsPath, loadApiKey } from "../src/config.js";

const home = path.join(path.sep, "home", "tester");

test("Windows uses %APPDATA%\\devin", () => {
  const env = { APPDATA: path.join("C:", "Users", "t", "AppData", "Roaming") };
  assert.equal(
    credentialsPath({ platform: "win32", env, home }),
    path.join(env.APPDATA, "devin", "credentials.toml")
  );
});

test("Windows falls back to home\\AppData\\Roaming", () => {
  assert.equal(
    credentialsPath({ platform: "win32", env: {}, home }),
    path.join(home, "AppData", "Roaming", "devin", "credentials.toml")
  );
});

test("macOS uses the XDG data dir, not the config dir", () => {
  assert.equal(
    credentialsPath({ platform: "darwin", env: {}, home }),
    path.join(home, ".local", "share", "devin", "credentials.toml")
  );
});

test("XDG_DATA_HOME overrides the macOS default", () => {
  const env = { XDG_DATA_HOME: path.join(home, "xdg-data") };
  assert.equal(
    credentialsPath({ platform: "darwin", env, home }),
    path.join(env.XDG_DATA_HOME, "devin", "credentials.toml")
  );
});

test("CCP_CREDENTIALS wins on every platform", () => {
  const env = { CCP_CREDENTIALS: path.join(home, "custom.toml"), APPDATA: "x" };
  assert.equal(
    credentialsPath({ platform: "win32", env, home }),
    env.CCP_CREDENTIALS
  );
  assert.equal(
    credentialsPath({ platform: "darwin", env, home }),
    env.CCP_CREDENTIALS
  );
});

test("loadApiKey reads windsurf_api_key from CCP_CREDENTIALS", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-config-"));
  const file = path.join(dir, "credentials.toml");
  fs.writeFileSync(file, 'windsurf_api_key = "test-key"\n');
  const prev = { ...process.env };
  try {
    delete process.env.CCP_API_KEY;
    process.env.CCP_CREDENTIALS = file;
    assert.equal(loadApiKey(), "test-key");
  } finally {
    process.env = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadApiKey names the resolved path when the file is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-config-"));
  const missing = path.join(dir, "credentials.toml");
  const prev = { ...process.env };
  try {
    delete process.env.CCP_API_KEY;
    process.env.CCP_CREDENTIALS = missing;
    assert.throws(() => loadApiKey(), (e) => e.message.includes(missing));
  } finally {
    process.env = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
