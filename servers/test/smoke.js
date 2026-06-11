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
//       3. Fail-OPEN on /api/v1/bot/me/tools outage (all 10 tools register)
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
import { dirname, resolve, join } from "node:path";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BUNDLE_SRC = resolve(__dirname, "..", "chatlytics-mcp.js");
const BUNDLE_DIST = resolve(__dirname, "..", "chatlytics-mcp.bundle.mjs");

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
  // v5.0/P6 additions
  sendResponse = { ok: true, id: "msg_mock_1" },
  sendStatus = 200,
  actionsResponse = null,
  actionsStatus = 200,
  patchBotMeResponse = null,
  patchBotMeStatus = 200,
  // v5.0/P10 additions
  pairingsResponse = null,
  pairingsStatus = 404,  // default 404 = endpoint not yet live (fail-open)
}) {
  // toolsResponse: object to return as JSON for GET /api/v1/bot/me/tools
  //   null + toolsStatus 200 → return { tools: [...10 default tools...] }
  // toolsStatus: HTTP status for /bot/me/tools
  // botMeResponse: body for GET /api/v1/bot/me (Phase 337); null → default identity
  // updatesResponse: body for GET /api/v1/bot/updates (Phase 337); null → default
  // ackResponse: body for POST /api/v1/bot/updates/ack (Phase 337); default {acked:1}
  // pairingsResponse: body for GET /api/v1/bot/me/pairings (v5.0/P10); null → default
  // pairingsStatus: HTTP status for /bot/me/pairings (default 404 = not yet live)
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
              { name: "chatlytics_configure", description: "x" },
            ],
          };
          response.end(JSON.stringify(body));
          return;
        }

        // /api/v1/bot/me/pairings — bot self-pairings (v5.0/P10)
        // Must be checked BEFORE the bare /bot/me handler (longer path wins).
        if (pathOnly === "/api/v1/bot/me/pairings" && req.method === "GET") {
          response.statusCode = pairingsStatus;
          response.setHeader("Content-Type", "application/json");
          if (pairingsStatus === 404) {
            response.end(JSON.stringify({ error: "not_found" }));
            return;
          }
          if (pairingsStatus !== 200) {
            response.end(JSON.stringify({ error: "mock_failure" }));
            return;
          }
          const body = pairingsResponse ?? {
            pairings: [
              { entity_jid: "120363421825201386@g.us", entity_type: "group" },
              { entity_jid: "972544329000@c.us", entity_type: "contact" },
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

        // /api/v1/bot/me PATCH — self-config (v5.0/P6 chatlytics_configure)
        if (pathOnly === "/api/v1/bot/me" && req.method === "PATCH") {
          response.statusCode = patchBotMeStatus;
          response.setHeader("Content-Type", "application/json");
          if (patchBotMeStatus !== 200) {
            response.end(JSON.stringify({ error: "mock_failure" }));
            return;
          }
          const body = patchBotMeResponse ?? {
            bot_id: 1,
            display_name: "Configured Mock Bot",
            bot_token_fp: "deadbeef",
          };
          response.end(JSON.stringify(body));
          return;
        }

        // /api/v1/send POST — unified send route (v5.0/P6)
        if (pathOnly === "/api/v1/send" && req.method === "POST") {
          response.statusCode = sendStatus;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(sendResponse));
          return;
        }

        // /api/v1/actions POST — search (resolveChatId) + legacy dispatch
        if (pathOnly === "/api/v1/actions" && req.method === "POST") {
          response.statusCode = actionsStatus;
          response.setHeader("Content-Type", "application/json");
          // Default: a single search match so resolveChatId resolves cleanly.
          const body = actionsResponse ?? {
            contacts: [{ chatId: "972500000000@c.us", name: "Mock Contact", type: "contact" }],
          };
          response.end(JSON.stringify(body));
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
    // Phase 337: 8 → 9 (chatlytics_poll). v5.0/P6: 9 → 10 (chatlytics_configure).
    if (toolNames.length !== 10) {
      fail(`fail-open: tools/list returned ${toolNames.length} tools, expected 10. names=${JSON.stringify(toolNames)}`);
    }
    ok(`fail-OPEN: /bot/me/tools 503 → 10 tools registered (${toolNames.join(", ")})`);
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

// ---------------------------------------------------------------------------
// Phase 4 — v5.0/P6 assertions: unified /api/v1/send + chatlytics_configure.
// ---------------------------------------------------------------------------

// --- Assertion 9: chatlytics_send in api_key mode targets /api/v1/send (NOT /actions) ---
async function assertSendUnifiedApiKeyMode() {
  const captureLog = [];
  const { server, port } = await makeMockServer({ captureLog });
  const API_KEY = "legacy_api_key_send_42";

  try {
    const result = await driveBundle({
      env: {
        CHATLYTICS_API_URL: `http://127.0.0.1:${port}`,
        CHATLYTICS_BOT_TOKEN: "",
        CHATLYTICS_API_KEY: API_KEY,
        CHATLYTICS_SESSION: "sess_default",
      },
      customToolCall: {
        name: "chatlytics_send",
        // JID input so resolveChatId returns immediately (no /actions search hop).
        arguments: { to: "972544329000@c.us", text: "hello unified" },
      },
      postCallWaitMs: 1200,
    });
    const sendReq = captureLog.find((r) => r.path === "/api/v1/send" && r.method === "POST");
    if (!sendReq) {
      fail(`send-unified: POST /api/v1/send was not called. capture=${JSON.stringify(captureLog.map(c => `${c.method} ${c.url}`))}`);
    }
    // In api_key mode, /api/v1/actions must NOT carry a send action.
    const actionsSend = captureLog.find(
      (r) => r.path === "/api/v1/actions" && r.method === "POST" && r.body.includes('"send"')
    );
    if (actionsSend) {
      fail(`send-unified: api_key send incorrectly hit /api/v1/actions with a send action. body=${actionsSend.body.slice(0, 200)}`);
    }
    if (sendReq.authorization !== `Bearer ${API_KEY}`) {
      fail(`send-unified: /api/v1/send Authorization expected 'Bearer ${API_KEY}', got '${sendReq.authorization}'`);
    }
    let parsed;
    try { parsed = JSON.parse(sendReq.body); } catch { fail(`send-unified: /send body not JSON. raw=${sendReq.body}`); }
    if (parsed.chatId !== "972544329000@c.us") {
      fail(`send-unified: /send body chatId expected '972544329000@c.us', got '${parsed.chatId}'`);
    }
    if (parsed.text !== "hello unified") {
      fail(`send-unified: /send body text expected 'hello unified', got '${parsed.text}'`);
    }
    if (parsed.session !== "sess_default") {
      fail(`send-unified: /send body session expected 'sess_default' (DEFAULT_SESSION), got '${parsed.session}'`);
    }
    const callResp = parseToolCallResponse(result.stdout);
    if (!callResp || callResp.result?.isError) {
      fail(`send-unified: tool response errored. resp=${JSON.stringify(callResp).slice(0, 400)}`);
    }
    ok("v5.0/P6: chatlytics_send (api_key mode) → POST /api/v1/send, NOT /api/v1/actions");
  } finally {
    server.close();
  }
}

// --- Assertion 9b (M2): chatlytics_send api_key mode WITHOUT a session still
//     targets /api/v1/send, and the server's missing-session 400 is surfaced as
//     an actionable error to the caller (NOT silently dropped). ---
async function assertSendApiKeyNoSessionSurfacesError() {
  const captureLog = [];
  // Mock /api/v1/send to return a 400 with a session-shaped error whenever the
  // request body has no session — mirroring the real server contract.
  const { server, port } = await makeMockServer({
    captureLog,
    sendStatus: 400,
    sendResponse: { error: "session is required" },
  });
  const API_KEY = "legacy_api_key_nosession_42";

  try {
    const result = await driveBundle({
      env: {
        CHATLYTICS_API_URL: `http://127.0.0.1:${port}`,
        CHATLYTICS_BOT_TOKEN: "",
        CHATLYTICS_API_KEY: API_KEY,
        // CHATLYTICS_SESSION intentionally UNSET (no default session available)
        CHATLYTICS_SESSION: "",
      },
      customToolCall: {
        name: "chatlytics_send",
        // JID input so resolveChatId returns immediately (no /actions search hop).
        arguments: { to: "972544329000@c.us", text: "no session here" },
      },
      postCallWaitMs: 1200,
    });
    // The send MUST still target /api/v1/send (unification holds even with no session).
    const sendReq = captureLog.find((r) => r.path === "/api/v1/send" && r.method === "POST");
    if (!sendReq) {
      fail(`send-nosession: POST /api/v1/send was not called. capture=${JSON.stringify(captureLog.map(c => `${c.method} ${c.url}`))}`);
    }
    // With no session available, the bundle sends `undefined` (omitted from JSON).
    let parsed;
    try { parsed = JSON.parse(sendReq.body); } catch { fail(`send-nosession: /send body not JSON. raw=${sendReq.body}`); }
    if (parsed.session !== undefined) {
      fail(`send-nosession: /send body session expected undefined (no default), got '${parsed.session}'`);
    }
    // The 400 missing-session error MUST be surfaced to the caller, not dropped.
    const callResp = parseToolCallResponse(result.stdout);
    if (!callResp) fail(`send-nosession: tools/call response not found. stdout=${result.stdout.slice(0, 600)}`);
    if (callResp.result?.isError !== true) {
      fail(`send-nosession: response missing isError:true (server 400 was dropped). resp=${JSON.stringify(callResp).slice(0, 400)}`);
    }
    const text = callResp.result?.content?.[0]?.text || "";
    if (!/session/i.test(text)) {
      fail(`send-nosession: surfaced error missing 'session'. text=${text.slice(0, 400)}`);
    }
    ok("v5.0/P6 (M2): chatlytics_send (api_key, no session) → /api/v1/send + server missing-session 400 surfaced as actionable error");
  } finally {
    server.close();
  }
}

// --- Assertion 10: chatlytics_configure (bot mode) → PATCH /bot/me with translated body ---
async function assertConfigureTranslatesBody() {
  const captureLog = [];
  const { server, port } = await makeMockServer({ captureLog });
  const BOT_TOKEN = "sk_bot_CONFIGURE_TOKEN_42";

  try {
    const result = await driveBundle({
      env: {
        CHATLYTICS_API_URL: `http://127.0.0.1:${port}`,
        CHATLYTICS_BOT_TOKEN: BOT_TOKEN,
      },
      customToolCall: {
        name: "chatlytics_configure",
        arguments: {
          display_name: "New Name",
          trigger: { word: "!bot", operator: "startswith", require_both: true },
          prefix: "[bot] ",
          suffix: " — sent by bot",
          keyword_filter: { keywords: ["urgent"], scope: ["group"] },
          access_policy: { dm: { entries: ["111@c.us"] }, group: { entries: ["g1@g.us"] } },
        },
      },
      postCallWaitMs: 1200,
    });
    const patchReq = captureLog.find((r) => r.path === "/api/v1/bot/me" && r.method === "PATCH");
    if (!patchReq) {
      fail(`configure: PATCH /api/v1/bot/me was not called. capture=${JSON.stringify(captureLog.map(c => `${c.method} ${c.url}`))}`);
    }
    if (patchReq.authorization !== `Bearer ${BOT_TOKEN}`) {
      fail(`configure: PATCH Authorization expected 'Bearer ${BOT_TOKEN}', got '${patchReq.authorization}'`);
    }
    let b;
    try { b = JSON.parse(patchReq.body); } catch { fail(`configure: PATCH body not JSON. raw=${patchReq.body}`); }

    if (b.display_name !== "New Name") fail(`configure: display_name not translated. body=${patchReq.body}`);
    // trigger.word → trigger_config.trigger_words:[word]
    if (!b.trigger_config || JSON.stringify(b.trigger_config.trigger_words) !== JSON.stringify(["!bot"])) {
      fail(`configure: trigger.word → trigger_words:['!bot'] failed. trigger_config=${JSON.stringify(b.trigger_config)}`);
    }
    if (b.trigger_config.trigger_operator !== "startswith") fail(`configure: trigger_operator not translated`);
    if (b.trigger_config.require_both !== true) fail(`configure: require_both not translated`);
    // prefix / suffix modules
    if (b.modules?.["message-prefix"]?.config?.prefix !== "[bot] ") fail(`configure: prefix module mistranslated. modules=${JSON.stringify(b.modules)}`);
    if (b.modules?.["message-suffix"]?.config?.suffix !== " — sent by bot") fail(`configure: suffix module mistranslated`);
    // keyword-filter
    if (JSON.stringify(b.modules?.["keyword-filter"]?.config) !== JSON.stringify({ keywords: ["urgent"], scope: ["group"] })) {
      fail(`configure: keyword-filter mistranslated. got=${JSON.stringify(b.modules?.["keyword-filter"]?.config)}`);
    }
    // access-policy MUST be allow_list, never allow_all
    const ap = b.modules?.["access-policy"]?.config;
    if (!ap || ap.dm?.type !== "allow_list" || JSON.stringify(ap.dm?.entries) !== JSON.stringify(["111@c.us"])) {
      fail(`configure: access-policy dm not allow_list. got=${JSON.stringify(ap)}`);
    }
    if (ap.group?.type !== "allow_list" || JSON.stringify(ap.group?.entries) !== JSON.stringify(["g1@g.us"])) {
      fail(`configure: access-policy group not allow_list. got=${JSON.stringify(ap)}`);
    }
    if (patchReq.body.includes("allow_all")) {
      fail(`configure: allow_all MUST NEVER be sent. body=${patchReq.body}`);
    }
    // No identity/authority fields leaked
    for (const forbidden of ["session", "account", "is_default", "permission_scope", "bot_token", "token"]) {
      if (Object.prototype.hasOwnProperty.call(b, forbidden)) {
        fail(`configure: forbidden identity field '${forbidden}' present in PATCH body. body=${patchReq.body}`);
      }
    }
    const callResp = parseToolCallResponse(result.stdout);
    if (!callResp || callResp.result?.isError) {
      fail(`configure: tool response errored. resp=${JSON.stringify(callResp).slice(0, 400)}`);
    }
    ok("v5.0/P6: chatlytics_configure (bot mode) → PATCH /bot/me with friendly→wire translation (allow_list only, no identity fields)");
  } finally {
    server.close();
  }
}

// --- Assertion 11: chatlytics_configure rejects api_key-only mode (no API call) ---
async function assertConfigureRejectsApiKeyMode() {
  const captureLog = [];
  const { server, port } = await makeMockServer({ captureLog });
  const API_KEY = "legacy_api_key_configure_42";

  try {
    const result = await driveBundle({
      env: {
        CHATLYTICS_API_URL: `http://127.0.0.1:${port}`,
        CHATLYTICS_BOT_TOKEN: "",
        CHATLYTICS_API_KEY: API_KEY,
      },
      customToolCall: {
        name: "chatlytics_configure",
        arguments: { display_name: "Should Not Apply" },
      },
      postCallWaitMs: 800,
    });
    // PATCH /bot/me MUST NOT be called in api_key mode.
    const patchReq = captureLog.find((r) => r.path === "/api/v1/bot/me" && r.method === "PATCH");
    if (patchReq) {
      fail(`configure-rejects-apikey: PATCH /bot/me should NOT be called in api_key mode (got ${JSON.stringify(patchReq)})`);
    }
    const callResp = parseToolCallResponse(result.stdout);
    if (!callResp) fail(`configure-rejects-apikey: tools/call response not found. stdout=${result.stdout.slice(0, 600)}`);
    if (callResp.result?.isError !== true) {
      fail(`configure-rejects-apikey: response missing isError:true. resp=${JSON.stringify(callResp).slice(0, 400)}`);
    }
    const text = callResp.result?.content?.[0]?.text || "";
    if (!text.includes("requires CHATLYTICS_BOT_TOKEN")) {
      fail(`configure-rejects-apikey: error text missing 'requires CHATLYTICS_BOT_TOKEN'. text=${text.slice(0, 400)}`);
    }
    ok("v5.0/P6: chatlytics_configure under api_key mode → isError, no PATCH issued");
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Phase 5 — v5.0/P10 assertions: chatlytics_login identity enrichment.
// ---------------------------------------------------------------------------

// --- Assertion 13: chatlytics_login (bot mode) surfaces identity + pairings ---
async function assertLoginSurfacesBotIdentity() {
  const captureLog = [];
  const { server, port } = await makeMockServer({
    captureLog,
    botMeResponse: {
      bot_id: 3,
      display_name: "Sammie",
      bot_token_fp: "cafebabe",
      session_id: "3cf11776_logan",
      is_default: true,
    },
    pairingsStatus: 200,
    pairingsResponse: {
      pairings: [
        { entity_jid: "120363421825201386@g.us", entity_type: "group" },
        { entity_jid: "972544329000@c.us", entity_type: "contact" },
      ],
    },
  });
  const BOT_TOKEN = "sk_bot_LOGIN_IDENTITY_TOKEN_42";

  try {
    const result = await driveBundle({
      env: {
        CHATLYTICS_API_URL: `http://127.0.0.1:${port}`,
        CHATLYTICS_BOT_TOKEN: BOT_TOKEN,
      },
      customToolCall: { name: "chatlytics_login", arguments: {} },
      postCallWaitMs: 1500,
    });

    // Verify /bot/me was called (at-call-time re-fetch)
    const meReqs = captureLog.filter((r) => r.path === "/api/v1/bot/me" && r.method === "GET");
    if (meReqs.length === 0) fail("login-identity: GET /api/v1/bot/me was not called");
    // The at-call-time fetch must carry Bearer
    const loginMeReq = meReqs[meReqs.length - 1]; // last one is the chatlytics_login call
    if (loginMeReq.authorization !== `Bearer ${BOT_TOKEN}`) {
      fail(`login-identity: /bot/me Authorization expected 'Bearer ${BOT_TOKEN}', got '${loginMeReq.authorization}'`);
    }

    // Verify /bot/me/pairings was called
    const pairingsReq = captureLog.find((r) => r.path === "/api/v1/bot/me/pairings" && r.method === "GET");
    if (!pairingsReq) fail("login-identity: GET /api/v1/bot/me/pairings was not called");
    if (pairingsReq.authorization !== `Bearer ${BOT_TOKEN}`) {
      fail(`login-identity: /bot/me/pairings Authorization expected 'Bearer ${BOT_TOKEN}', got '${pairingsReq.authorization}'`);
    }

    // Verify tool response content
    const callResp = parseToolCallResponse(result.stdout);
    if (!callResp || callResp.result?.isError) {
      fail(`login-identity: tool response errored or missing. resp=${JSON.stringify(callResp).slice(0, 600)}`);
    }
    const text = callResp.result?.content?.[0]?.text || "";

    if (!text.includes("Sammie")) fail(`login-identity: response missing display_name 'Sammie'. text=${text.slice(0, 600)}`);
    if (!text.includes("cafebabe")) fail(`login-identity: response missing fp 'cafebabe'. text=${text.slice(0, 600)}`);
    if (!text.includes("3cf11776_logan")) fail(`login-identity: response missing session_id. text=${text.slice(0, 600)}`);
    if (!text.includes("yes")) fail(`login-identity: response missing is_default:yes. text=${text.slice(0, 600)}`);
    if (!text.includes("120363421825201386@g.us")) fail(`login-identity: response missing group pairing JID. text=${text.slice(0, 600)}`);
    if (!text.includes("972544329000@c.us")) fail(`login-identity: response missing contact pairing JID. text=${text.slice(0, 600)}`);
    // INV-02: raw token MUST NOT appear in the tool response text
    if (text.includes(BOT_TOKEN)) fail("login-identity: INV-02 violation — raw BOT_TOKEN appeared in tool response text");

    ok("v5.0/P10: chatlytics_login (bot mode) surfaces display_name + session_id + fp + is_default + pairings");
  } finally {
    server.close();
  }
}

// --- Assertion 14: chatlytics_login with pairings 404 still succeeds (fail-open) ---
async function assertLoginPairings404FailOpen() {
  const captureLog = [];
  const { server, port } = await makeMockServer({
    captureLog,
    botMeResponse: {
      bot_id: 5,
      display_name: "TestBot",
      bot_token_fp: "feedface",
      session_id: "test_sess",
      is_default: false,
    },
    // Default pairingsStatus = 404 — simulates endpoint not yet implemented
  });
  const BOT_TOKEN = "sk_bot_PAIRINGS_FAILOPEN_TOKEN_99";

  try {
    const result = await driveBundle({
      env: {
        CHATLYTICS_API_URL: `http://127.0.0.1:${port}`,
        CHATLYTICS_BOT_TOKEN: BOT_TOKEN,
      },
      customToolCall: { name: "chatlytics_login", arguments: {} },
      postCallWaitMs: 1500,
    });

    const callResp = parseToolCallResponse(result.stdout);
    if (!callResp || callResp.result?.isError) {
      fail(`login-pairings-failopen: tool response errored (should succeed even on 404 pairings). resp=${JSON.stringify(callResp).slice(0, 600)}`);
    }
    const text = callResp.result?.content?.[0]?.text || "";
    // Identity still surfaces even when pairings 404
    if (!text.includes("TestBot")) fail(`login-pairings-failopen: display_name missing. text=${text.slice(0, 600)}`);
    if (!text.includes("feedface")) fail(`login-pairings-failopen: fp missing. text=${text.slice(0, 600)}`);
    // No pairings section when 404 (endpoint not live)
    if (text.includes("Paired entities")) fail(`login-pairings-failopen: 'Paired entities' should NOT appear on 404. text=${text.slice(0, 600)}`);
    // No error from the pairings failure
    if (text.includes("❌")) fail(`login-pairings-failopen: login returned error indicator (should be success). text=${text.slice(0, 600)}`);
    // INV-02
    if (text.includes(BOT_TOKEN)) fail("login-pairings-failopen: INV-02 violation — raw BOT_TOKEN in tool response");

    ok("v5.0/P10: chatlytics_login pairings 404 → fail-open (identity surfaces, no pairings section, no error)");
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Phase 6 — v2.2.0/P3 packaging assertion: the SHIPPED bundle must be a
// portable ES module. Historical landmine: the bundle shipped as `.js` inside
// the plugin dir (where servers/package.json `"type":"module"` made it work),
// but copying it OUT to a stable path (no package.json) crashed Node with
// "Cannot use import statement outside a module" until manually renamed .mjs.
// This assertion copies the bundle to a bare temp dir and boots it there.
// ---------------------------------------------------------------------------
async function assertBundlePortableEsm() {
  if (!existsSync(BUNDLE_DIST)) {
    fail(`portable-esm: ${BUNDLE_DIST} missing — run \`npm run build\` first`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "chatlytics-mcp-smoke-"));
  const copied = join(tmp, "chatlytics-mcp.mjs"); // NO package.json next to it
  copyFileSync(BUNDLE_DIST, copied);
  try {
    const stderrChunks = [];
    const child = spawn(process.execPath, [copied], {
      env: { ...process.env, CHATLYTICS_API_URL: "http://127.0.0.1:1", CHATLYTICS_BOT_TOKEN: "sk_bot_PORTABLE_SMOKE" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", (c) => stderrChunks.push(c));
    await new Promise((r) => setTimeout(r, 1200));
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    if (stderr.includes("Cannot use import statement outside a module")) {
      fail(`portable-esm: bundle copied to a bare dir crashed as CJS. stderr=${stderr.slice(0, 400)}`);
    }
    if (stderr.includes("SyntaxError")) {
      fail(`portable-esm: bundle copy hit a SyntaxError. stderr=${stderr.slice(0, 400)}`);
    }
    if (!stderr.includes("[chatlytics-mcp]")) {
      fail(`portable-esm: bundle copy did not emit boot log. stderr=${stderr.slice(0, 400)}`);
    }
    ok("v2.2.0/P3: bundle (.mjs) boots from a bare temp dir — no rename landmine");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  await liveModeCheck();
  await assertBundlePortableEsm();
  await assertEnvVarPrecedence();
  await assertApiKeyFallback();
  await assertFailOpenOnCatalogOutage();
  await assertBotIdentityLog();
  await assertBotMeFailOpen();
  await assertPollToolEnvelope();
  await assertPollAckOrder();
  await assertPollRejectsApiKeyMode();
  await assertSendUnifiedApiKeyMode();
  await assertSendApiKeyNoSessionSurfacesError();
  await assertConfigureTranslatesBody();
  await assertConfigureRejectsApiKeyMode();
  await assertLoginSurfacesBotIdentity();
  await assertLoginPairings404FailOpen();
  console.log("[smoke] PASS — 15 bundle-behavior assertions green");
  process.exit(0);
})().catch((e) => {
  fail(`unhandled error: ${e?.stack || e}`);
});
