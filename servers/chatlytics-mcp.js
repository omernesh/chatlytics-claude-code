import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// v4.0 MCP-SCOPED-01 (Phase 334) — env-var resolution
// BOT_TOKEN takes precedence; API_KEY is the legacy v3.37 fallback. AUTH_VALUE
// is what callApi() emits in `Authorization: Bearer <value>` regardless of
// which env var supplied it. AUTH_MODE is the LABEL emitted at boot for
// observability — NEVER log the raw value (INV-02 token plaintext discipline).
const API_URL = process.env.CHATLYTICS_API_URL || "https://node.chatlytics.ai";
const BOT_TOKEN = process.env.CHATLYTICS_BOT_TOKEN || "";
const API_KEY = process.env.CHATLYTICS_API_KEY || "";
const DEFAULT_SESSION = process.env.CHATLYTICS_SESSION || "";
const AUTH_VALUE = BOT_TOKEN || API_KEY;
const AUTH_MODE = BOT_TOKEN ? "bot_token" : (API_KEY ? "api_key" : "none");

// v2.1.2 — first-use onboarding. When no bot token is configured
// (AUTH_MODE === "none"), every user-facing DATA tool short-circuits with this
// relayable prompt instead of falling through to an unauthenticated 401. The
// 401/403 path in callApi() is the WRONG-token message (a token IS set but bad)
// and stays distinct. Do NOT mention BotDaddy — that onboarding route isn't live.
const NO_TOKEN_PROMPT = [
  "⚠️ Chatlytics needs a bot token before it can send or read WhatsApp.",
  "",
  "No CHATLYTICS_BOT_TOKEN is configured yet. Get one (it looks like `sk_bot_…`) either way:",
  "  • Web UI — sign in at https://app.chatlytics.ai → Bots → Create Bot, then copy the token (shown only once).",
  "  • CLI — `chatlytics bots create --session <your-session-id> --name <bot-name>` (needs an admin API key).",
  "",
  "Then add it to the `env` block of your `.claude/settings.json` as `CHATLYTICS_BOT_TOKEN` and restart Claude Code.",
  "You can re-check anytime with the `chatlytics_login` tool.",
].join("\n");

// IN-01: Warn on missing env vars at startup
if (!process.env.CHATLYTICS_API_URL) {
  console.error("[chatlytics-mcp] CHATLYTICS_API_URL not set — using default https://node.chatlytics.ai");
}
if (AUTH_MODE === "none") {
  console.error("[chatlytics-mcp] Warning: neither CHATLYTICS_BOT_TOKEN nor CHATLYTICS_API_KEY set — API calls will be unauthenticated");
} else {
  // v4.0 MCP-SCOPED-01: log auth MODE, never the value. DO NOT CHANGE — INV-02.
  console.error(`[chatlytics-mcp] Auth mode: ${AUTH_MODE}`);
}

async function callApi(method, path, body) {
  const url = `${API_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  // v4.0 MCP-SCOPED-02: single Bearer header path; value sourced from BOT_TOKEN
  // (preferred) or API_KEY (legacy fallback). NO new header types.
  if (AUTH_VALUE) headers["Authorization"] = `Bearer ${AUTH_VALUE}`;

  const opts = { method, headers, signal: AbortSignal.timeout(30_000) };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    // CC-P8 + v4.0 MCP-SCOPED-01: distinct, actionable error for auth failures
    // so the LLM can relay the fix path. References BOTH env-var names; do not
    // interpolate token values into the message (INV-02).
    if (res.status === 401 || res.status === 403) {
      const rawBody = typeof data === "string" ? data : JSON.stringify(data);
      throw new Error(
        `Chatlytics API rejected the credential (HTTP ${res.status}). ` +
          `Verify CHATLYTICS_BOT_TOKEN (preferred, v4.0+) or CHATLYTICS_API_KEY ` +
          `(legacy v3.37) in your .claude/settings.json matches the value from ` +
          `https://app.chatlytics.ai. Run 'chatlytics_health' or 'chatlytics_login' to retest. ` +
          `Raw response: ${rawBody.slice(0, 300)}`
      );
    }
    throw new Error(`HTTP ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

// v4.0 MCP-SCOPED-03 (Phase 334) — fetch the bot's filtered tool catalog at
// startup. Fail-OPEN policy: when bot-token mode is active but the endpoint
// is unreachable, register ALL 8 tools. P327 checkBotScope at REST dispatch
// (api-v1.ts) remains the security boundary, so a permissive catalog cannot
// grant a bot extra capabilities. UX trade: operator visibility may temporarily
// widen during a chatlytics outage. DO NOT switch to fail-CLOSED without
// revisiting the security model (T-334-10 in 334-02 threat register).
async function fetchAllowedTools() {
  if (AUTH_MODE !== "bot_token") return null;
  try {
    const res = await fetch(`${API_URL}/api/v1/bot/me/tools`, {
      headers: { Authorization: `Bearer ${BOT_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[chatlytics-mcp] /bot/me/tools returned ${res.status} — registering ALL tools (fail-open)`);
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data?.tools)) {
      console.error(`[chatlytics-mcp] /bot/me/tools response missing tools[] — registering ALL tools (fail-open)`);
      return null;
    }
    return new Set(data.tools.map(t => t.name));
  } catch (e) {
    console.error(`[chatlytics-mcp] /bot/me/tools fetch failed: ${e.message} — registering ALL tools (fail-open)`);
    return null;
  }
}

const allowed = await fetchAllowedTools();
const allow = (name) => allowed === null || allowed.has(name);
if (allowed !== null) {
  console.error(`[chatlytics-mcp] Filtered tool catalog: ${allowed.size}/10 tools allowed (${[...allowed].join(", ")})`);
}

// v4.0 CC-V2-01 (Phase 337) — verify bot identity at boot. Bot-token mode
// only; legacy api_key mode skips this (the endpoint is bot-bearer-scoped).
// Fail-OPEN on transport / 5xx (continue boot, warn to stderr). On 401/403,
// log an actionable rotate-token message and continue — we do NOT exit
// non-zero because Claude Code quarantines servers that exit non-zero, and
// the LLM still needs `chatlytics_login` to surface the failure to the user.
// INV-02: NEVER log the raw bot token — only the server-supplied 8-char
// fingerprint (which is derived from the same SHA256 the gateway uses).
async function fetchBotIdentity() {
  if (AUTH_MODE !== "bot_token") return null;
  try {
    const res = await fetch(`${API_URL}/api/v1/bot/me`, {
      headers: { Authorization: `Bearer ${BOT_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      console.error(
        `[chatlytics-mcp] /bot/me returned ${res.status} — your CHATLYTICS_BOT_TOKEN ` +
          `appears invalid or revoked. Rotate at https://app.chatlytics.ai → ` +
          `Bots → rotate-token, then update .claude/settings.json and restart Claude Code.`
      );
      return null;
    }
    if (!res.ok) {
      console.error(`[chatlytics-mcp] /bot/me returned ${res.status} — continuing fail-open`);
      return null;
    }
    const data = await res.json();
    return data;
  } catch (e) {
    console.error(`[chatlytics-mcp] /bot/me fetch failed: ${e.message} — continuing fail-open`);
    return null;
  }
}

const botIdentity = await fetchBotIdentity();
if (botIdentity) {
  // INV-02: fingerprint comes from the server, derived from SHA256(bot_token).
  // Never interpolate BOT_TOKEN into a log line — only the fp the server
  // sent us. The contract test in test/smoke.js (assertBotIdentityLog)
  // regression-checks that the raw token does not appear in stderr.
  // P337 REVIEW MED-01 fix: defensive fallbacks for both fields so a
  // server-side payload regression never produces a silent boot.
  const name = botIdentity.display_name || "(unnamed bot)";
  const fp = botIdentity.bot_token_fp || "unknown";
  console.error(`[chatlytics-mcp] Bot identity: ${name} (fp=${fp})`);
}

// v4.0 CC-V2-02 (Phase 337) — long-poll inbound knobs. Clamped client-side
// to MAX so callers never send a value the server would clip anyway.
const DEFAULT_LONGPOLL_TIMEOUT_MS = 25_000;
const MAX_LONGPOLL_TIMEOUT_MS = 60_000;
const MIN_LONGPOLL_TIMEOUT_MS = 1_000;
function clampLongPollTimeout(value) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_LONGPOLL_TIMEOUT_MS;
  return Math.min(Math.max(MIN_LONGPOLL_TIMEOUT_MS, n), MAX_LONGPOLL_TIMEOUT_MS);
}

const server = new McpServer({ name: "chatlytics", version: "2.0.0" });

// Detect WhatsApp JID-shaped strings. WAHA uses 4 suffix families:
//   <phone>@c.us           — 1:1 contacts
//   <id>@g.us              — groups
//   <id>@lid               — NOWEB linked-id form
//   <id>@newsletter        — channels / newsletters
function looksLikeJid(s) {
  if (typeof s !== "string" || s.length === 0) return false;
  return /@(c\.us|g\.us|lid|newsletter)$/i.test(s);
}

// CC-P6: pre-resolve a human name to a JID via the search action.
// Returns a JID string on a single match. Throws on zero or multiple matches
// (with a clear, actionable error message for the LLM to relay to the user).
async function resolveChatId(input) {
  if (looksLikeJid(input)) return input;

  const result = await callApi("POST", "/api/v1/actions", {
    action: "search",
    params: { query: input },
  });

  // Search response shape varies (WAHA + directory results merged). Normalize:
  //  - flat array of {chatId|jid|id, name, type}
  //  - { contacts: [], groups: [], channels: [] }
  const candidates = [];
  const collect = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const c of arr) {
      const jid = c?.chatId || c?.jid || c?.id;
      if (jid && looksLikeJid(jid)) {
        candidates.push({ jid, name: c?.name || c?.displayName || jid, type: c?.type });
      }
    }
  };
  if (Array.isArray(result)) collect(result);
  else if (result && typeof result === "object") {
    collect(result.contacts);
    collect(result.groups);
    collect(result.channels);
    collect(result.newsletters);
    collect(result.results);
  }

  if (candidates.length === 0) {
    throw new Error(
      `No WhatsApp contact, group, or channel found matching "${input}". ` +
      `Use chatlytics_search or chatlytics_directory to browse available chats.`
    );
  }
  if (candidates.length > 1) {
    const list = candidates
      .slice(0, 10)
      .map((c) => `  - ${c.name} (${c.jid})${c.type ? ` [${c.type}]` : ""}`)
      .join("\n");
    throw new Error(
      `Multiple matches for "${input}" — please pick one and pass the JID instead:\n${list}`
    );
  }
  return candidates[0].jid;
}

// 1. Send a WhatsApp message
if (allow("chatlytics_send")) {
  server.tool(
    "chatlytics_send",
    "Send a WhatsApp message to a contact, group, or phone number",
    {
      to: z.string().describe("Contact name, phone number, or chat ID"),
      text: z.string().describe("Message text to send"),
      session: z.string().optional().describe("Session ID (uses default if omitted)"),
    },
    async ({ to, text, session }) => {
      if (AUTH_MODE === "none") {
        return { isError: true, content: [{ type: "text", text: NO_TOKEN_PROMPT }] };
      }
      try {
        // v5.0/P6: UNIFIED send path — ALL auth modes now POST /api/v1/send.
        // Previously only bot_token used /send while api_key/none fell through to
        // the generic /api/v1/actions dispatcher. Server v4.5.4 denies send-class
        // verbs on /api/v1/actions for bot callers (403
        // bot_send_via_dispatch_denied), and /api/v1/send is the single gated
        // route that runs executeOutboundGates → checkBotPairing + session-pin
        // (INV-09). /api/v1/send needs a real JID, so resolve human names first
        // (mirrors chatlytics_read) for every mode. The server pins the session
        // to the bot's own for bot tokens (session optional); for api_key callers
        // we still forward session || DEFAULT_SESSION so the prior
        // default-resolution behavior is preserved — if no session is available
        // we send `undefined` and let the server surface any missing-session
        // error rather than silently dropping the send.
        const chatId = await resolveChatId(to);
        const result = await callApi("POST", "/api/v1/send", {
          chatId,
          text,
          session: session || DEFAULT_SESSION || undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    }
  );
}

// 2. Read recent messages from a chat
if (allow("chatlytics_read")) {
  server.tool(
    "chatlytics_read",
    "Read recent messages from a WhatsApp chat. Accepts a JID (preferred) or a contact/group name (auto-resolved via search; ambiguous names return a picker error).",
    {
      chatId: z.string().describe("Chat JID (e.g. 972544329000@c.us, 12036...@g.us) or a contact/group name to auto-resolve"),
      limit: z.number().optional().default(10).describe("Number of messages to fetch (default 10)"),
    },
    async ({ chatId, limit }) => {
      if (AUTH_MODE === "none") {
        return { isError: true, content: [{ type: "text", text: NO_TOKEN_PROMPT }] };
      }
      try {
        // CC-P6: resolve human names to JIDs before calling readMessages
        // (which silently fails on non-JID input).
        const resolved = await resolveChatId(chatId);
        const result = await callApi("POST", "/api/v1/actions", {
          action: "readMessages",
          params: { chatId: resolved, limit },
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    }
  );
}

// 3. Search contacts/groups by name
if (allow("chatlytics_search")) {
  server.tool(
    "chatlytics_search",
    "Search for WhatsApp contacts, groups, or channels by name",
    {
      query: z.string().describe("Search query (name, phone number, or keyword)"),
    },
    async ({ query }) => {
      if (AUTH_MODE === "none") {
        return { isError: true, content: [{ type: "text", text: NO_TOKEN_PROMPT }] };
      }
      try {
        const result = await callApi("POST", "/api/v1/actions", {
          action: "search",
          params: { query },
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    }
  );
}

// 4. List all available WhatsApp actions
if (allow("chatlytics_actions")) {
  server.tool(
    "chatlytics_actions",
    "List all available WhatsApp actions supported by Chatlytics",
    {},
    async () => {
      if (AUTH_MODE === "none") {
        return { isError: true, content: [{ type: "text", text: NO_TOKEN_PROMPT }] };
      }
      try {
        const result = await callApi("GET", "/api/v1/actions");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    }
  );
}

// 5. Browse contacts and groups directory
if (allow("chatlytics_directory")) {
  server.tool(
    "chatlytics_directory",
    "Browse WhatsApp contacts, groups, and newsletters",
    {
      type: z.enum(["contact", "group", "newsletter"]).optional().describe("Filter by type"),
      search: z.string().optional().describe("Search filter"),
      limit: z.number().optional().describe("Max results to return"),
    },
    async ({ type, search, limit }) => {
      if (AUTH_MODE === "none") {
        return { isError: true, content: [{ type: "text", text: NO_TOKEN_PROMPT }] };
      }
      try {
        // CC-P10: clean URL build — single conditional path, no double-prepend.
        const params = new URLSearchParams();
        if (type) params.set("type", type);
        if (search) params.set("search", search);
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        const path = qs ? `/api/v1/directory?${qs}` : "/api/v1/directory";
        const result = await callApi("GET", path);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    }
  );
}

// 6. Check Chatlytics connection health
if (allow("chatlytics_health")) {
  server.tool(
    "chatlytics_health",
    "Check Chatlytics and WhatsApp connection status",
    {},
    async () => {
      try {
        const result = await callApi("GET", "/health");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    }
  );
}

// 8. Validate the API key + connection (CC-P8).
// Runs once after install to verify setup. Returns a clear pass/fail summary
// with troubleshooting hints so non-technical users can self-diagnose.
//
// v4.0 MCP-SCOPED-03 carve-out: chatlytics_login is in ALWAYS_ALLOW_TOOLS
// server-side (src/bot-tool-filter.ts). The allow() check here is defensive
// — when bot-token mode is active, the server's /bot/me/tools response ALWAYS
// includes chatlytics_login so allow() returns true. When legacy api_key mode
// or fail-open is active, allowed===null so allow() also returns true.
// Therefore this tool is effectively unconditionally registered. The wrap
// is kept for symmetry + future-proofing.
if (allow("chatlytics_login")) {
  server.tool(
    "chatlytics_login",
    "Validate the Chatlytics API key + connection. Run this once after install to verify setup. Returns a clear pass/fail with troubleshooting hints.",
    {},
    async () => {
      if (!AUTH_VALUE) {
        // v2.1.2: surface the shared first-use onboarding prompt (Web UI + CLI
        // routes to get a sk_bot_* token). Fixes the stale "Settings → API Keys"
        // guidance — bots are provisioned at Bots → Create Bot.
        return {
          isError: true,
          content: [{ type: "text", text: NO_TOKEN_PROMPT }],
        };
      }
      try {
        const result = await callApi("GET", "/health");
        const webhookOk = result?.webhook_registered === true;
        const sessions = Array.isArray(result?.sessions)
          ? result.sessions.length
          : typeof result?.sessions === "number"
            ? result.sessions
            : "unknown";
        if (!webhookOk) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `⚠️  Connected to Chatlytics at ${API_URL}, but webhook_registered is not true ` +
                  `(got ${JSON.stringify(result?.webhook_registered)}). WhatsApp inbound may be down. ` +
                  `Contact support or check the Chatlytics admin panel.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `✅ Connected to Chatlytics at ${API_URL} (auth mode: ${AUTH_MODE}). ` +
                `Webhook registered. Sessions: ${sessions}.`,
            },
          ],
        };
      } catch (e) {
        // callApi already formats 401/403 with the friendly auth-error message.
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `❌ ${e.message}`,
            },
          ],
        };
      }
    }
  );
}

// 7. Dispatch any Chatlytics channel action by name (CC-P9).
// Chatlytics exposes ~100 WhatsApp actions (groups, polls, reactions, media,
// status, presence, labels, etc). chatlytics_send/read/search cover the 6
// most common operations; this tool covers everything else.
if (allow("chatlytics_dispatch")) {
  server.tool(
    "chatlytics_dispatch",
    "Dispatch any Chatlytics channel action by name. Use chatlytics_actions to list the full catalog (~100 actions including createGroup, sendPoll, muteChat, addLabel, setProfilePicture, etc). Use chatlytics_send/read/search for the 6 common operations — this is for everything else.",
    {
      action: z.string().describe("Action name from the Chatlytics catalog (e.g. 'createGroup', 'sendPoll', 'muteChat')"),
      target: z.string().optional().describe("Chat ID, JID, or contact/group name (action-dependent)"),
      parameters: z.record(z.any()).optional().describe("Action-specific parameters object"),
      session: z.string().optional().describe("Session ID (uses default if omitted)"),
    },
    async ({ action, target, parameters, session }) => {
      if (AUTH_MODE === "none") {
        return { isError: true, content: [{ type: "text", text: NO_TOKEN_PROMPT }] };
      }
      try {
        const body = { action };
        if (target !== undefined) body.target = target;
        if (parameters !== undefined) body.params = parameters;
        if (session || DEFAULT_SESSION) body.session = session || DEFAULT_SESSION;
        const result = await callApi("POST", "/api/v1/actions", body);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    }
  );
}

// 9. Long-poll inbound (CC-V2-02, Phase 337).
// Drives the v4.0 long-poll endpoints (P335):
//   GET  /api/v1/bot/updates        — blocks ≤ timeout_ms for new envelopes
//   POST /api/v1/bot/updates/ack    — advances cursor for delivered envelopes
//
// Bot-token mode ONLY. The server-side routes are gated by
// `resolveBotFromBearer` (P324) — an operator/admin api_key Bearer would 401.
// We short-circuit client-side with a clear, actionable error to save a
// round-trip and give the LLM a clearer signal it can relay to the user.
//
// Uses bespoke fetch (NOT callApi) because:
//   - We need the longer AbortSignal window (timeout_ms + 5s buffer) to let
//     the server's long-poll wait actually return; callApi's 30s default
//     would clip a 60s wait.
//   - We tolerate 200 with empty envelopes (long-poll timeout) as a normal
//     return — no error.
// We still reuse the 401/403 error formatting path from callApi by re-using
// its error shape pattern (manual replication kept tight; if the auth
// header logic ever changes, update both paths).
if (allow("chatlytics_poll")) {
  server.tool(
    "chatlytics_poll",
    "Poll the Chatlytics long-poll endpoint for inbound WhatsApp messages addressed to your bot. Returns immediately with any queued envelopes, or blocks up to timeout_ms for new arrivals. Pass the `cursor` from the previous response to resume; pass `ack` (cursor) to advance the server-side delivery cursor in the same call. Requires CHATLYTICS_BOT_TOKEN (sk_bot_*) — bot-scoped endpoint.",
    {
      cursor: z.string().optional().describe("Opaque cursor from a previous response. Omit on first call."),
      timeout_ms: z.number().optional().describe(`Max ms to block waiting for new envelopes. Default ${DEFAULT_LONGPOLL_TIMEOUT_MS}, clamped [${MIN_LONGPOLL_TIMEOUT_MS}, ${MAX_LONGPOLL_TIMEOUT_MS}].`),
      ack: z.string().optional().describe("Cursor of the latest envelope you've handled. If set, POSTs /bot/updates/ack BEFORE the GET. Best-effort — ack failures log but do not block. NOTE: pass the SAME value as `cursor` in the same call to ack-and-resume; passing `ack` without `cursor` will ack then re-poll from seq 0."),
    },
    async ({ cursor, timeout_ms, ack }) => {
      if (AUTH_MODE === "none") {
        return { isError: true, content: [{ type: "text", text: NO_TOKEN_PROMPT }] };
      }
      if (AUTH_MODE !== "bot_token") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `chatlytics_poll requires CHATLYTICS_BOT_TOKEN (sk_bot_*) — long-poll ` +
                `inbound is bot-scoped (P335). The legacy CHATLYTICS_API_KEY operator ` +
                `bearer cannot drive this endpoint. Provision a bot token at ` +
                `https://app.chatlytics.ai → Bots, then add CHATLYTICS_BOT_TOKEN to your ` +
                `.claude/settings.json env block and restart Claude Code.`,
            },
          ],
        };
      }

      // Best-effort ack first.
      if (ack && typeof ack === "string" && ack.length > 0) {
        try {
          const ackRes = await fetch(`${API_URL}/api/v1/bot/updates/ack`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${BOT_TOKEN}`,
            },
            body: JSON.stringify({ cursor: ack }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!ackRes.ok) {
            // Don't fail the poll over an ack hiccup — just log.
            console.error(`[chatlytics-mcp] chatlytics_poll: ack returned HTTP ${ackRes.status} — proceeding with GET`);
          }
        } catch (e) {
          console.error(`[chatlytics-mcp] chatlytics_poll: ack network error: ${e.message} — proceeding with GET`);
        }
      }

      const tms = clampLongPollTimeout(timeout_ms);
      const qs = new URLSearchParams();
      if (cursor) qs.set("cursor", cursor);
      qs.set("timeout_ms", String(tms));
      const url = `${API_URL}/api/v1/bot/updates?${qs.toString()}`;

      try {
        const res = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${BOT_TOKEN}` },
          // Allow the server's clamped wait plus a 5s buffer so we don't
          // race the server's response with our own AbortSignal.
          signal: AbortSignal.timeout(tms + 5_000),
        });
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    `Chatlytics rejected the bot token (HTTP ${res.status}). ` +
                    `Verify CHATLYTICS_BOT_TOKEN in .claude/settings.json matches the ` +
                    `value from https://app.chatlytics.ai → Bots. If you rotated recently, ` +
                    `the old token's 24h grace window may have expired.`,
                },
              ],
            };
          }
          if (res.status === 400) {
            // Most common case: invalid_cursor after rotation. Suggest restart.
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    `Chatlytics returned HTTP 400 from /bot/updates — most often ` +
                    `'invalid_cursor' after a token rotation. Drop the cursor and ` +
                    `re-poll with no cursor (fresh start). Raw: ${typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)}`,
                },
              ],
            };
          }
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `HTTP ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text", text: `chatlytics_poll network error: ${e.message}` }],
        };
      }
    }
  );
}

// 10. Self-configure the bot's presentation, trigger, and filters (v5.0/P6).
// Bot-token mode ONLY — drives PATCH /api/v1/bot/me (the P5 self-config
// endpoint). Accepts a FRIENDLY flat schema and TRANSLATES it to the server's
// strict wire contract. Identity/authority fields (session, account, is_default,
// permission_scope, the token itself) are NOT editable here — the server rejects
// them with 400, and this tool never sends them. Only the friendly fields the
// caller actually provides are forwarded (no empty module objects).
if (allow("chatlytics_configure")) {
  server.tool(
    "chatlytics_configure",
    "Self-configure THIS bot's own presentation and behavior: display name, trigger words/operator, message prefix/suffix, keyword filter, and DM/group access allow-lists. Drives PATCH /api/v1/bot/me. Requires CHATLYTICS_BOT_TOKEN (sk_bot_*). Identity and permissions (session, account, default-bot status, permission scope, the token) CANNOT be changed here — those are administrative and are rejected by the server. Only the fields you pass are updated; omit a field to leave it unchanged. Access policies are always allow-lists.",
    {
      display_name: z.string().min(1).max(128).optional().describe("New display name for the bot (1..128 chars)."),
      trigger: z
        .object({
          word: z.string().optional().describe("Single trigger word the bot listens for (e.g. '!sammie')."),
          operator: z.string().optional().describe("Trigger operator (e.g. 'contains', 'startswith')."),
          require_both: z.boolean().optional().describe("Require both the trigger word AND a mention/condition."),
        })
        .optional()
        .describe("Trigger configuration. Pass `word` to set the (single) trigger word."),
      prefix: z.string().optional().describe("Text prepended to every outbound message (message-prefix module)."),
      suffix: z.string().optional().describe("Text appended to every outbound message (message-suffix module)."),
      keyword_filter: z
        .object({
          keywords: z.array(z.string()).optional().describe("Keywords the bot reacts to."),
          scope: z.array(z.enum(["dm", "group"])).optional().describe("Where the filter applies: 'dm' and/or 'group'."),
        })
        .optional()
        .describe("Keyword-filter module config."),
      access_policy: z
        .object({
          dm: z.object({ entries: z.array(z.string()) }).optional().describe("DM allow-list JIDs/numbers."),
          group: z.object({ entries: z.array(z.string()) }).optional().describe("Group allow-list JIDs."),
        })
        .optional()
        .describe("Access policy. Always an allow-list (the server rejects allow_all)."),
    },
    async ({ display_name, trigger, prefix, suffix, keyword_filter, access_policy }) => {
      if (AUTH_MODE === "none") {
        return { isError: true, content: [{ type: "text", text: NO_TOKEN_PROMPT }] };
      }
      // Bot-token mode ONLY — mirror chatlytics_poll's api_key rejection.
      if (AUTH_MODE !== "bot_token") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `chatlytics_configure requires CHATLYTICS_BOT_TOKEN (sk_bot_*) — bot ` +
                `self-config is bot-scoped (PATCH /api/v1/bot/me). The legacy ` +
                `CHATLYTICS_API_KEY operator bearer cannot drive this endpoint. ` +
                `Provision a bot token at https://app.chatlytics.ai → Bots, then add ` +
                `CHATLYTICS_BOT_TOKEN to your .claude/settings.json env block and ` +
                `restart Claude Code.`,
            },
          ],
        };
      }

      // Translate the FRIENDLY flat schema → the strict P5 wire body. Only
      // include a key when the caller actually provided the corresponding
      // friendly field, so the server's .strict() validator never sees an empty
      // module object. NEVER send identity/authority fields. ALWAYS use
      // type:"allow_list" for access policy (the server rejects allow_all).
      const body = {};

      if (display_name !== undefined) body.display_name = display_name;

      if (trigger !== undefined) {
        const tc = {};
        if (trigger.word !== undefined) tc.trigger_words = [trigger.word];
        if (trigger.operator !== undefined) tc.trigger_operator = trigger.operator;
        if (trigger.require_both !== undefined) tc.require_both = trigger.require_both;
        // Only attach trigger_config if at least one sub-field was provided.
        if (Object.keys(tc).length > 0) body.trigger_config = tc;
      }

      // Modules — build lazily; only attach modules.* keys the caller asked for.
      const modules = {};
      if (prefix !== undefined) {
        modules["message-prefix"] = { config: { prefix } };
      }
      if (suffix !== undefined) {
        modules["message-suffix"] = { config: { suffix } };
      }
      if (keyword_filter !== undefined) {
        const cfg = {};
        if (keyword_filter.keywords !== undefined) cfg.keywords = keyword_filter.keywords;
        if (keyword_filter.scope !== undefined) cfg.scope = keyword_filter.scope;
        if (Object.keys(cfg).length > 0) modules["keyword-filter"] = { config: cfg };
      }
      if (access_policy !== undefined) {
        const cfg = {};
        if (access_policy.dm !== undefined) {
          cfg.dm = { type: "allow_list", entries: access_policy.dm.entries };
        }
        if (access_policy.group !== undefined) {
          cfg.group = { type: "allow_list", entries: access_policy.group.entries };
        }
        if (Object.keys(cfg).length > 0) modules["access-policy"] = { config: cfg };
      }
      if (Object.keys(modules).length > 0) body.modules = modules;

      if (Object.keys(body).length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "chatlytics_configure: nothing to update — pass at least one of " +
                "display_name, trigger, prefix, suffix, keyword_filter, or access_policy.",
            },
          ],
        };
      }

      try {
        const result = await callApi("PATCH", "/api/v1/bot/me", body);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    }
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
