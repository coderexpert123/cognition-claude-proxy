// Simple smoke test: checks /health and /v1/models.
// Run: node scripts/test.js
// Requires the proxy to be running (node src/server.js).

const port = process.env.CCP_PORT || 8765;
const base = `http://localhost:${port}`;

async function main() {
  let failures = 0;

  // 1. Health check
  try {
    const res = await fetch(`${base}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.ok !== true) throw new Error(`ok !== true: ${JSON.stringify(body)}`);
    console.log(`PASS  /health  ->  ${JSON.stringify(body)}`);
  } catch (e) {
    console.error(`FAIL  /health  ->  ${e.message}`);
    console.error(`       Is the proxy running? Start it with: node src/server.js`);
    failures++;
  }

  // 2. Models endpoint
  try {
    const res = await fetch(`${base}/v1/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const count = body.data?.length ?? 0;
    if (count === 0) throw new Error(`no models returned`);
    const hasSwe2 = body.data.some(m => m.id?.startsWith("swe-2"));
    const hasGlm = body.data.some(m => m.id?.startsWith("glm-5"));
    console.log(`PASS  /v1/models  ->  ${count} models, swe-2:${hasSwe2}, glm-5:${hasGlm}`);
  } catch (e) {
    console.error(`FAIL  /v1/models  ->  ${e.message}`);
    failures++;
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log(`\nAll checks passed.`);
  }
}

main();
