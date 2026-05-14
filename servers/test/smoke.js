#!/usr/bin/env node
// Chatlytics MCP smoke test.
// Verifies the configured Chatlytics REST endpoint is reachable, authenticated,
// and reporting a registered WhatsApp webhook. Exits 0 on success, 1 on failure.
//
// Usage:
//   CHATLYTICS_API_URL=https://app.chatlytics.ai \
//   CHATLYTICS_API_KEY=your-key \
//   node test/smoke.js
//
// Or: npm test (from servers/)

const API_URL = process.env.CHATLYTICS_API_URL;
const API_KEY = process.env.CHATLYTICS_API_KEY;

function fail(msg) {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[smoke] OK:   ${msg}`);
}

if (!API_URL) fail("CHATLYTICS_API_URL is not set in environment");
if (!API_KEY) fail("CHATLYTICS_API_KEY is not set in environment");

const url = `${API_URL.replace(/\/+$/, "")}/health`;

(async () => {
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    fail(`network error calling ${url}: ${e.message}`);
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail(`non-JSON response from ${url} (status ${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    fail(`HTTP ${res.status} from ${url}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  ok(`reached ${url} (HTTP ${res.status})`);

  if (body.webhook_registered !== true) {
    fail(`webhook_registered is not true (got ${JSON.stringify(body.webhook_registered)}). Full response: ${JSON.stringify(body)}`);
  }
  ok("webhook_registered: true");

  console.log("[smoke] PASS — Chatlytics is reachable and webhook is registered");
  process.exit(0);
})();
