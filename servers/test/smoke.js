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

function makeMockServer({
  toolsResponse = null,
  toolsStatus = 200,
  captureLog,
  // v4.0 Phase 337 additions
  botMeResponse = null,
  botMeStatus = 200,
  updatesResponse = null,
  updatesStatus = 200,
  ackResponse = { acked: 1, cursor: "advanced" },
  ackStatus = 200,
}) {
  // toolsResponse: object to return as JSON for GET /api/v1/bot/me/tools
  //   null + toolsStatus 200 → return { tools: [...9 default tools...] }
  // toolsStatus: HTTP status for /bot/me/tools
  // botMeResponse: body for GET /api/v1/bot/me (Phase 337); null → default identity
  // updatesResponse: body for GET /api/v1/bot/updates (Phase 337); null → default
  // ackResponse: body for POST /api/v1/bot/updates/ack (Phase 337); default {acked:1}
  return new Promise((res) => {
    const server = createServer((req, response) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        // Strip querystring for matching but capture full url for assertions.
        const fullUrl = req.url;
        const pathOnly = fullUrl.split("?")[0];
        captureLog.push({
          method: req.method,
          url: fullUrl,
          path: pathOnly,
          authorization: req.headers["authorization"] || null,
          body: Buffer.concat(chunks).toString("utf8"),
        });

        // /api/v1/bot/me/tools — drives the catalog filter
        if (pathOnly === "/api/v1/bot/me/tools" && req.method === "GET") {
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
              { name: "chatlytics_poll", description: "x" },
            ],
          };
          response.end(JSON.stringify(body));
          return;
        }

        // /api/v1/bot/me — identity verify (Phase 337)
        if (pathOnly === "/api/v1/bot/me" && req.method === "GET") {
          response.statusCode = botMeStatus;
          response.setHeader("Content-Type", "application/json");
          if (botMeStatus !== 200) {
            response.end(JSON.stringify({ error: "mock_failure" }));
            return;
          }
          const body = botMeResponse ?? {
            bot_id: 1,
            display_name: "Default Mock Bot",
            bot_token_fp: "deadbeef",
            session_id: "mock_session",
          };
          response.end(JSON.stringify(body));
          return;
        }

        // /api/v1/bot/updates — long-poll GET (Phase 337)
        if (pathOnly === "/api/v1/bot/updates" && req.method === "GET") {
          response.statusCode = updatesStatus;
          response.setHeader("Content-Type", "application/json");
          if (updatesStatus !== 200) {
            response.end(JSON.stringify({ error: "mock_failure" }));
            return;
          }
          const body = updatesResponse ?? { envelopes: [], cursor: "empty" };
          response.end(JSON.stringify(body));
          return;
        }

        // /api/v1/bot/updates/ack — POST ack (Phase 337)
        if (pathOnly === "/api/v1/bot/updates/ack" && req.method === "POST") {
          response.statusCode = ackStatus;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(ackResponse));
          return;
        }

        // /health — used by chatlytics_health tool
        if (pathOnly === "/health" && req.method === "GET") {
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

async function driveBundle({
  env,
  sendToolsList = true,
  // Phase 337: when provided, fire this tools/call INSTEAD of the default
  // chatlytics_health (e.g. { name: "chatlytics_poll", arguments: {...} }).
  customToolCall = null,
  // Phase 337: time to wait after issuing tools/call so the server has time
  // to respond and the mock captures the request. Long-poll ack/get requires
  // more time than chatlytics_health.
  postCallWaitMs = 800,
}) {
  const captureLog = []; // collected by the mock; the caller wires this in
  const stdoutChunks = [];
  const stderrChunks = [];
  const child = spawn(process.execPath, [BUNDLE_SRC], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => stdoutChunks.push(c));
  child.stderr.on("data", (c) => stderrChunks.push(c));

  // Settle child startup (give fetchAllowedTools + fetchBotIdentity a chance to fire)
  await new Promise((r) => setTimeout(r, 900));

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
    // fire a tools/call — default is chatlytics_health, override via customToolCall
    await new Promise((r) => setTimeout(r, 100));
    const params = customToolCall ?? { name: "chatlytics_health", arguments: {} };
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params,
      }) + "\n",
    );
  }

  await new Promise((r) => setTimeout(r, postCallWaitMs));
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => {});

  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

// Phase 337 — extract the tools/call response (id=3) from stdout for assertions.
function parseToolCallResponse(stdout) {
  const lines = stdout.split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === 3 && (msg.result || msg.error)) return msg;
    } catch {}
  }
  return null;
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
    // Phase 337: tool count bumped 8 → 9 (chatlytics_poll added).
    if (toolNames.length !== 9) {
      fail(`fail-open: tools/list returned ${toolNames.length} tools, expected 9. names=${JSON.stringify(toolNames)}`);
    }
    ok(`fail-OPEN: /bot/me/tools 503 → 9 tools registered (${toolNames.join(", ")})`);
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — v4.0 CC-V2 (Phase 337) assertions: /bot/me identity verify +
// chatlytics_poll tool semantics.
// ---------------------------------------------------------------------------

// --- Assertion 4: /bot/me identity logged at boot (bot-token mode) ---
async function assertBotIdentityLog() {
  const captureLog = [];
  const { server, port } = await makeMockServer({
    captureLog,
    botMeResponse: { bot_id: 7, display_name: "Test Bot", bot_token_fp: "abc12345", session_id: "s1" },
  });
  const BOT_TOKEN = "sk_bot_IDENTITY_TEST_TOKEN_42";

  try {
    const result = await driveBundle({
      env: {
        CHATLYTICS_API_URL: `http://127.0.0.1:${port}`,
        CHATLYTICS_BOT_TOKEN: BOT_TOKEN,
      },
    });
    const botMeReq = captureLog.find((r) => r.path === "/api/v1/bot/me");
    if (!botMeReq) fail("bot-identity: /api/v1/bot/me was not called");
    if (botMeReq.authorization !== `Bearer ${BOT_TOKEN}`) {
      fail(`bot-identity: /api/v1/bot/me Authorization expected 'Bearer ${BOT_TOKEN}', got '${botMeReq.authorization}'`);
    }
    if (!result.stderr.includes("Bot identity: Test Bot (fp=abc12345)")) {
      fail(`bot-identity: stderr missing 'Bot identity: Test Bot (fp=abc12345)'. stderr=${result.stderr.slice(0, 600)}`);
    }
    // INV-02 regression
    if (result.stderr.includes(BOT_TOKEN)) {
      fail("bot-identity: INV-02 violation — raw BOT_TOKEN appeared in stderr");
    }
    ok("CC-V2-01: /bot/me identity logged at boot (display_name + fp, no plaintext token)");
  } finally {
    server.close();
  }
}

// --- Assertion 5: /bot/me fail-OPEN on 503 ---
async function assertBotMeFailOpen() {
  const captureLog = [];
  const { server, port } = await makeMockServer({ captureLog, botMeStatus: 503 });
  const BOT_TOKEN = "sk_bot_BOTME_FAILOPEN_TOKEN_99";

  try {
    const result = await driveBundle({
      env: {
        CHATLYTICS_API_URL: `http://127.0.0.1:${port}`,
        CHATLYTICS_BOT_TOKEN: BOT_TOKEN,
      },
    });
    if (!result.stderr.includes("/bot/me returned 503")) {
      fail(`bot-me-failopen: stderr missing '/bot/me returned 503'. stderr=${result.stderr.slice(0, 600)}`);
    }
    // Server must still register chatlytics_poll (catalog-driven; default mock
    // returns 9 tools incl chatlytics_poll). tools/list returns all of them.
    const toolNames = parseToolsList(result.stdout);
    if (!toolNames) fail(`bot-me-failopen: tools/list response not found in stdout`);
    if (!toolNames.includes("chatlytics_poll")) {
      fail(`bot-me-failopen: chatlytics_poll missing from tools/list. names=${JSON.stringify(toolNames)}`);
    }
    ok("CC-V2-01: /bot/me 503 → fail-open (chatlytics_poll still registered)");
  } finally {
    server.close();
  }
}

// --- Assertion 6: chatlytics_poll passthrough — Bearer + querystring + envelope ---
async function assertPollToolEnvelope() {
  const captureLog = [];
  const { server, port } = await makeMockServer({
    captureLog,
    updatesResponse: {
      envelopes: [{ seq: 1, from: "972544329000@c.us", text: "hi" }],
      cursor: "cur1",
    },
  });
  const BOT_TOKEN = "sk_bot_POLL_ENV_TOKEN_42";

  try {
    const result = await driveBundle({
      env: {
        CHATLYTICS_API_URL: `http://127.0.0.1:${port}`,
        CHATLYTICS_BOT_TOKEN: BOT_TOKEN,
      },
      customToolCall: {
        name: "chatlytics_poll",
        arguments: { cursor: "prev", timeout_ms: 5000 },
      },
      postCallWaitMs: 1500,
    });
    const updReq = captureLog.find((r) => r.path === "/api/v1/bot/updates" && r.method === "GET");
    if (!updReq) fail(`poll-envelope: GET /api/v1/bot/updates was not called. capture=${JSON.stringify(captureLog.map(c => c.url))}`);
    if (updReq.authorization !== `Bearer ${BOT_TOKEN}`) {
      fail(`poll-envelope: /bot/updates Authorization expected 'Bearer ${BOT_TOKEN}', got '${updReq.authorization}'`);
    }
    if (!updReq.url.includes("cursor=prev")) {
      fail(`poll-envelope: /bot/updates url missing 'cursor=prev'. url=${updReq.url}`);
    }
    if (!updReq.url.includes("timeout_ms=5000")) {
      fail(`poll-envelope: /bot/updates url missing 'timeout_ms=5000'. url=${updReq.url}`);
    }
    const callResp = parseToolCallResponse(result.stdout);
    if (!callResp || !callResp.result) {
      fail(`poll-envelope: tools/call response missing or errored. stdout=${result.stdout.slice(0, 800)}`);
    }
    const text = callResp.result.content?.[0]?.text || "";
    if (!text.includes(`"cursor": "cur1"`)) {
      fail(`poll-envelope: tool response text missing cursor=cur1. text=${text.slice(0, 400)}`);
    }
    ok("CC-V2-02: chatlytics_poll → GET /bot/updates with Bearer + querystring + envelope passthrough");
  } finally {
    server.close();
  }
}

// --- Assertion 7: ack issued BEFORE GET when chatlytics_poll is called with ack ---
async function assertPollAckOrder() {
  const captureLog = [];
  const { server, port } = await makeMockServer({
    captureLog,
    updatesResponse: { envelopes: [], cursor: "after_ack" },
  });
  const BOT_TOKEN = "sk_bot_POLL_ACK_TOKEN_42";

  try {
    await driveBundle({
      env: {
        CHATLYTICS_API_URL: `http://127.0.0.1:${port}`,
        CHATLYTICS_BOT_TOKEN: BOT_TOKEN,
      },
      customToolCall: {
        name: "chatlytics_poll",
        arguments: { ack: "old_cursor", cursor: "old_cursor", timeout_ms: 2000 },
      },
      postCallWaitMs: 1500,
    });
    // Find first ACK and first GET indices in captureLog.
    const ackIdx = captureLog.findIndex(
      (r) => r.path === "/api/v1/bot/updates/ack" && r.method === "POST"
    );
    const getIdx = captureLog.findIndex(
      (r) => r.path === "/api/v1/bot/updates" && r.method === "GET"
    );
    if (ackIdx < 0) fail(`poll-ack-order: POST /bot/updates/ack was not called. capture=${JSON.stringify(captureLog.map(c => `${c.method} ${c.url}`))}`);
    if (getIdx < 0) fail(`poll-ack-order: GET /bot/updates was not called.`);
    if (ackIdx >= getIdx) {
      fail(`poll-ack-order: ack (idx=${ackIdx}) MUST come BEFORE get (idx=${getIdx}).`);
    }
    // Validate ack body shape
    const ackReq = captureLog[ackIdx];
    let parsedBody;
    try {
      parsedBody = JSON.parse(ackReq.body);
    } catch {
      fail(`poll-ack-order: ack body is not JSON. raw=${ackReq.body}`);
    }
    if (parsedBody.cursor !== "old_cursor") {
      fail(`poll-ack-order: ack body cursor expected 'old_cursor', got '${parsedBody.cursor}'`);
    }
    if (ackReq.authorization !== `Bearer ${BOT_TOKEN}`) {
      fail(`poll-ack-order: ack Authorization expected 'Bearer ${BOT_TOKEN}', got '${ackReq.authorization}'`);
    }
    ok("CC-V2-02: chatlytics_poll(ack=...) → POST /bot/updates/ack BEFORE GET /bot/updates");
  } finally {
    server.close();
  }
}

// --- Assertion 8: chatlytics_poll rejects api_key-only mode ---
async function assertPollRejectsApiKeyMode() {
  const captureLog = [];
  const { server, port } = await makeMockServer({ captureLog });
  const API_KEY = "legacy_api_key_only_42";

  try {
    const result = await driveBundle({
      env: {
        CHATLYTICS_API_URL: `http://127.0.0.1:${port}`,
        CHATLYTICS_BOT_TOKEN: "",
        CHATLYTICS_API_KEY: API_KEY,
      },
      customToolCall: {
        name: "chatlytics_poll",
        arguments: { timeout_ms: 1000 },
      },
      postCallWaitMs: 800,
    });
    // /bot/updates MUST NOT be called in api_key mode
    const updReq = captureLog.find((r) => r.path === "/api/v1/bot/updates");
    if (updReq) {
      fail(`poll-rejects-apikey: /bot/updates should NOT be called in api_key mode (got ${JSON.stringify(updReq)})`);
    }
    const callResp = parseToolCallResponse(result.stdout);
    if (!callResp) fail(`poll-rejects-apikey: tools/call response not found in stdout=${result.stdout.slice(0, 600)}`);
    // MCP tool errors come back as result with isError:true (not as JSON-RPC error)
    const isError = callResp.result?.isError === true;
    const text = callResp.result?.content?.[0]?.text || "";
    if (!isError) {
      fail(`poll-rejects-apikey: tool response missing isError:true. resp=${JSON.stringify(callResp).slice(0, 600)}`);
    }
    if (!text.includes("requires CHATLYTICS_BOT_TOKEN")) {
      fail(`poll-rejects-apikey: error text missing 'requires CHATLYTICS_BOT_TOKEN'. text=${text.slice(0, 400)}`);
    }
    ok("CC-V2-02: chatlytics_poll under api_key mode → isError with actionable migration hint");
  } finally {
    server.close();
  }
}

(async () => {
  await liveModeCheck();
  await assertEnvVarPrecedence();
  await assertApiKeyFallback();
  await assertFailOpenOnCatalogOutage();
  await assertBotIdentityLog();
  await assertBotMeFailOpen();
  await assertPollToolEnvelope();
  await assertPollAckOrder();
  await assertPollRejectsApiKeyMode();
  console.log("[smoke] PASS — 8 bundle-behavior assertions green");
  process.exit(0);
})().catch((e) => {
  fail(`unhandled error: ${e?.stack || e}`);
});
