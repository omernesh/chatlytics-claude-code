import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.CHATLYTICS_API_URL || "http://localhost:8050";
const API_KEY = process.env.CHATLYTICS_API_KEY || "";
const DEFAULT_SESSION = process.env.CHATLYTICS_SESSION || "";

async function callApi(method, path, body) {
  const url = `${API_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

  const opts = { method, headers };
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

const server = new McpServer({ name: "chatlytics", version: "1.0.0" });

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
  "Read recent messages from a WhatsApp chat",
  {
    chatId: z.string().describe("Chat ID or contact name to read messages from"),
    limit: z.number().optional().default(10).describe("Number of messages to fetch (default 10)"),
  },
  async ({ chatId, limit }) => {
    try {
      const result = await callApi("POST", "/api/v1/actions", {
        action: "readMessages",
        params: { chatId, limit },
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
