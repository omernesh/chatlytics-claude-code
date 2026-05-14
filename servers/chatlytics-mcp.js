import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.CHATLYTICS_API_URL || "http://localhost:8050";
const API_KEY = process.env.CHATLYTICS_API_KEY || "";
const DEFAULT_SESSION = process.env.CHATLYTICS_SESSION || "";

// IN-01: Warn on missing env vars at startup
if (!process.env.CHATLYTICS_API_URL) {
  console.error("[chatlytics-mcp] Warning: CHATLYTICS_API_URL not set — using default http://localhost:8050");
}
if (!process.env.CHATLYTICS_API_KEY) {
  console.error("[chatlytics-mcp] Warning: CHATLYTICS_API_KEY not set — API calls will be unauthenticated");
}

async function callApi(method, path, body) {
  const url = `${API_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

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
    throw new Error(`HTTP ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

const server = new McpServer({ name: "chatlytics", version: "1.1.0" });

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
server.tool(
  "chatlytics_send",
  "Send a WhatsApp message to a contact, group, or phone number",
  {
    to: z.string().describe("Contact name, phone number, or chat ID"),
    text: z.string().describe("Message text to send"),
    session: z.string().optional().describe("Session ID (uses default if omitted)"),
  },
  async ({ to, text, session }) => {
    try {
      const result = await callApi("POST", "/api/v1/actions", {
        action: "send",
        params: { chatId: to, text },
        session: session || DEFAULT_SESSION || undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  }
);

// 2. Read recent messages from a chat
server.tool(
  "chatlytics_read",
  "Read recent messages from a WhatsApp chat. Accepts a JID (preferred) or a contact/group name (auto-resolved via search; ambiguous names return a picker error).",
  {
    chatId: z.string().describe("Chat JID (e.g. 972544329000@c.us, 12036...@g.us) or a contact/group name to auto-resolve"),
    limit: z.number().optional().default(10).describe("Number of messages to fetch (default 10)"),
  },
  async ({ chatId, limit }) => {
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

// 3. Search contacts/groups by name
server.tool(
  "chatlytics_search",
  "Search for WhatsApp contacts, groups, or channels by name",
  {
    query: z.string().describe("Search query (name, phone number, or keyword)"),
  },
  async ({ query }) => {
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

// 4. List all available WhatsApp actions
server.tool(
  "chatlytics_actions",
  "List all available WhatsApp actions supported by Chatlytics",
  {},
  async () => {
    try {
      const result = await callApi("GET", "/api/v1/actions");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  }
);

// 5. Browse contacts and groups directory
server.tool(
  "chatlytics_directory",
  "Browse WhatsApp contacts, groups, and newsletters",
  {
    type: z.enum(["contact", "group", "newsletter"]).optional().describe("Filter by type"),
    search: z.string().optional().describe("Search filter"),
    limit: z.number().optional().describe("Max results to return"),
  },
  async ({ type, search, limit }) => {
    try {
      const params = new URLSearchParams();
      if (type) params.set("type", type);
      if (search) params.set("search", search);
      if (limit) params.set("limit", String(limit));
      const qs = params.toString();
      const result = await callApi("GET", `/api/v1/directory${qs ? `?${qs}` : ""}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  }
);

// 6. Check Chatlytics connection health
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

const transport = new StdioServerTransport();
await server.connect(transport);
