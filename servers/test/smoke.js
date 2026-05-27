#!/usr/bin/env node
// Chatlytics MCP smoke test.
//
// Two modes:
//   - Live mode (default when CHATLYTICS_API_URL + CHATLYTICS_API_KEY env vars set):
//     hits a real Chatlytics REST endpoint, verifies /health is 200 +
//     webhook_registered:true.
//   - Bundle-behavior mode (run unconditionally after live mode):
//     spawns chatlytics-mcp.js as a child process against a local mock HTTP
//     server, verifies the v4.0 MCP-SCOPED-01..03 contract:
//       1. Env-var precedence (BOT_TOKEN beats API_KEY when both set)
//       2. Legacy fallback (API_KEY emits Bearer when BOT_TOKEN unset)
//       3. Fail-OPEN on /api/v1/bot/me/tools outage (all 8 tools register)
//
// Exits 0 on success, 1 on first failure.
//
// Usage:
//   CHATLYTICS_API_URL=https://app.chatlytics.ai \
//   CHATLYTICS_API_KEY=your-key \
//   node test/smoke.js
//
// Or: npm test (from servers/)

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { once } from "node:events";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BUNDLE_SRC = resolve(__dirname, "..", "chatlytics-mcp.js");

function fail(msg) {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[smoke] OK:   ${msg}`);
}

// ---------------------------------------------------------------------------
// Phase 1 — legacy live-endpoint check (kept for back-compat with `npm test`
// against a real chatlytics dev server). Skipped when env vars are unset.
// ---------------------------------------------------------------------------
async function liveModeCheck() {
  const API_URL = process.env.CHATLYTICS_API_URL;
  const API_KEY = process.env.CHATLYTICS_API_KEY;
  if (!API_URL || !API_KEY) {
    ok("live-mode check skipped (CHATLYTICS_API_URL/CHATLYTICS_API_KEY not set)");
    return;
  }
  const url = `${API_URL.replace(/\/+$/, "")}/health`;
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
    fail(`webhook_registered is not true (got ${JSON.stringify(body.webhook_registered)})`);
  }
  ok("webhook_registered: true");
}

// ---------------------------------------------------------------------------
// Phase 2 — bundle behavior assertions (v4.0 MCP-SCOPED-01..03).
//
// Strategy:
//   - Start a local node HTTP mock that captures every inbound request
//     (method, path, headers) and returns canned responses keyed by path.
//   - Spawn chatlytics-mcp.js as a child process with controlled env vars
//     pointing at the mock.
//   - Drive the bundle via stdin JSON-RPC: initialize → tools/list →
//     tools/call(chatlytics_health).
//   - Read stdout / stderr; assert against captured requests + emitted logs.
// ---------------------------------------------------------------------------

function makeMockServer({ toolsResponse = null, toolsStatus = 200, captureLog }) {
  // toolsResponse: object to return as JSON for GET /api/v1/bot/me/tools
  //   null + toolsStatus 200 → return { tools: [...8 default tools...] }
  // toolsStatus: HTTP status for /bot/me/tools
  return new Promise((res) => {
    const server = createServer((req, response) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        captureLog.push({
          method: req.method,
          url: req.url,
          authorization: req.headers["authorization"] || null,
          body: Buffer.concat(chunks).toString("utf8"),
        });

        // /api/v1/bot/me/tools — drives the catalog filter
        if (req.url === "/api/v1/bot/me/tools" && req.method === "GET") {
          response.statusCode = toolsStatus;
          response.setHeader("Content-Type", "application/json");
          if (toolsStatus !== 200) {
            response.end(JSON.stringify({ error: "mock_failure" }));
            return;
          }
          const body = toolsResponse ?? {
            tools: [
              { name: "chatlytics_send", description: "x" },
              { name: "chatlytics_read", description: "x" },
              { name: "chatlytics_search", description: "x" },
              { name: "chatlytics_actions", description: "x" },
              { name: "chatlytics_directory", description: "x" },
              { name: "chatlytics_health", description: "x" },
              { name: "chatlytics_login", description: "x" },
              { name: "chatlytics_dispatch", description: "x" },
            ],
          };
          response.end(JSON.stringify(body));
          return;
        }

        // /health — used by chatlytics_health tool
        if (req.url === "/health" && req.method === "GET") {
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ status: "ok", webhook_registered: true, sessions: 1 }));
          return;
        }

        response.statusCode = 404;
        response.end("not_found");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      res({ server, port });
    });
  });
}

async function driveBundle({ env, sendToolsList = true }) {
  const captureLog = []; // collected by the mock; the caller wires this in
  const stdoutChunks = [];
  const stderrChunks = [];
  const child = spawn(process.execPath, [BUNDLE_SRC], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => stdoutChunks.push(c));
  child.stderr.on("data", (c) => stderrChunks.push(c));

  // Settle child startup (give fetchAllowedTools a chance to fire)
  await new Promise((r) => setTimeout(r, 700));

  // JSON-RPC initialize
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1" },
      },
    }) + "\n",
  );

  // Sent "initialized" notification (required by MCP handshake)
  await new Promise((r) => setTimeout(r, 100));
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n",
  );

  if (sendToolsList) {
    await new Promise((r) => setTimeout(r, 100));
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
    );
    // also fire a chatlytics_health tool call to provoke /health request
    await new Promise((r) => setTimeout(r, 100));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "chatlytics_health", arguments: {} },
      }) + "\n",
    );
  }

  await new Promise((r) => setTimeout(r, 800));
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => {});

  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

function parseToolsList(stdout) {
  // stdout is line-delimited JSON-RPC; find the response for id=2
  const lines = stdout.split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
        return msg.result.tools.map((t) => t.name);
      }
    } catch {}
  }
  return null;
}

// --- Assertion 1: env-var precedence (BOT_TOKEN beats API_KEY) ---
async function assertEnvVarPrecedence() {
  const captureLog = [];
  const { server, port } = await makeMockServer({ captureLog });
  const BOT_TOKEN = "sk_bot_PRECEDENCE_TEST_TOKEN_42";
  const API_KEY = "legacy_api_key_should_be_ignored";

  try {
    const result = await driveBundle({
      env: {
        CHATLYTICS_API_URL: `http://127.0.0.1:${port}`,
        CHATLYTICS_BOT_TOKEN: BOT_TOKEN,
        CHATLYTICS_API_KEY: API_KEY,
      },
    });
    // The mock captured every request. /bot/me/tools was hit at startup;
    // /api/v1/actions or /health was hit during tools/call(chatlytics_health).
    const botMeRequest = captureLog.find((r) => r.url === "/api/v1/bot/me/tools");
    if (!botMeRequest) fail("env-precedence: /bot/me/tools was not called");
    if (botMeRequest.authorization !== `Bearer ${BOT_TOKEN}`) {
      fail(
        `env-precedence: /bot/me/tools Authorization expected 'Bearer ${BOT_TOKEN}', got '${botMeRequest.authorization}'`,
      );
    }
    const healthRequest = captureLog.find((r) => r.url === "/health");
    if (!healthRequest) fail("env-precedence: /health was not called");
    if (healthRequest.authorization !== `Bearer ${BOT_TOKEN}`) {
      fail(
        `env-precedence: /health Authorization expected 'Bearer ${BOT_TOKEN}', got '${healthRequest.authorization}'`,
      );
    }
    if (!result.stderr.includes("Auth mode: bot_token")) {
      fail(`env-precedence: stderr missing 'Auth mode: bot_token' line. stderr=${result.stderr.slice(0, 400)}`);
    }
    // INV-02: raw token MUST NOT appear in stderr
    if (result.stderr.includes(BOT_TOKEN)) {
      fail("env-precedence: INV-02 violation — raw BOT_TOKEN appeared in stderr");
    }
    ok("MCP-SCOPED-01: BOT_TOKEN env-var precedence + Bearer header verified");
  } finally {
    server.close();
  }
}

// --- Assertion 2: legacy API_KEY fallback ---
async function assertApiKeyFallback() {
  const captureLog = [];
  const { server, port } = await makeMockServer({ captureLog });
  const API_KEY = "legacy_api_key_fallback_42";

  try {
    const result = await driveBundle({
      env: {
        CHATLYTICS_API_URL: `http://127.0.0.1:${port}`,
        CHATLYTICS_BOT_TOKEN: "", // explicitly unset
        CHATLYTICS_API_KEY: API_KEY,
      },
    });
    // Legacy mode: /bot/me/tools MUST NOT be called (fetchAllowedTools returns null
    // when AUTH_MODE !== "bot_token")
    const botMeRequest = captureLog.find((r) => r.url === "/api/v1/bot/me/tools");
    if (botMeRequest) {
      fail("fallback: /bot/me/tools should NOT be called in api_key mode (got " + JSON.stringify(botMeRequest) + ")");
    }
    const healthRequest = captureLog.find((r) => r.url === "/health");
    if (!healthRequest) fail("fallback: /health was not called");
    if (healthRequest.authorization !== `Bearer ${API_KEY}`) {
      fail(
        `fallback: /health Authorization expected 'Bearer ${API_KEY}', got '${healthRequest.authorization}'`,
      );
    }
    if (!result.stderr.includes("Auth mode: api_key")) {
      fail(`fallback: stderr missing 'Auth mode: api_key'. stderr=${result.stderr.slice(0, 400)}`);
    }
    ok("MCP-SCOPED-01 (back-compat): API_KEY fallback emits Bearer header");
  } finally {
    server.close();
  }
}

// --- Assertion 3: fail-OPEN on /bot/me/tools 503 ---
async function assertFailOpenOnCatalogOutage() {
  const captureLog = [];
  const { server, port } = await makeMockServer({ captureLog, toolsStatus: 503 });
  const BOT_TOKEN = "sk_bot_FAILOPEN_TEST_TOKEN_99";

  try {
    const result = await driveBundle({
      env: {
        CHATLYTICS_API_URL: `http://127.0.0.1:${port}`,
        CHATLYTICS_BOT_TOKEN: BOT_TOKEN,
      },
    });
    if (!result.stderr.includes("registering ALL tools (fail-open)")) {
      fail(`fail-open: stderr missing 'registering ALL tools (fail-open)'. stderr=${result.stderr.slice(0, 600)}`);
    }
    const toolNames = parseToolsList(result.stdout);
    if (!toolNames) fail(`fail-open: tools/list response not found in stdout. stdout=${result.stdout.slice(0, 600)}`);
    if (toolNames.length !== 8) {
      fail(`fail-open: tools/list returned ${toolNames.length} tools, expected 8. names=${JSON.stringify(toolNames)}`);
    }
    ok(`fail-OPEN: /bot/me/tools 503 → 8 tools registered (${toolNames.join(", ")})`);
  } finally {
    server.close();
  }
}

(async () => {
  await liveModeCheck();
  await assertEnvVarPrecedence();
  await assertApiKeyFallback();
  await assertFailOpenOnCatalogOutage();
  console.log("[smoke] PASS — all bundle-behavior assertions green");
  process.exit(0);
})().catch((e) => {
  fail(`unhandled error: ${e?.stack || e}`);
});
