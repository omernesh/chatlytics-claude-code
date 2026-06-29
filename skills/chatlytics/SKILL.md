---
name: chatlytics
description: Send and receive WhatsApp messages via Chatlytics. Use when the user asks to message someone on WhatsApp, read WhatsApp chats, or manage WhatsApp contacts/groups.
---

# Chatlytics — WhatsApp for Claude Code

You have WhatsApp messaging capabilities via the Chatlytics MCP tools.

## Authentication (v4.0 — Phase 337)

The plugin reads its bearer credential with this precedence:

1. **`CHATLYTICS_BOT_TOKEN`** (preferred, v4.0+) — `sk_bot_*` per-bot token.
   Provision at https://app.chatlytics.ai → Bots. Identifies the bot to the
   server (scoped to its `permission_scope`). Required for `chatlytics_poll`.
2. **`CHATLYTICS_API_KEY`** (legacy v3.37 fallback) — operator/admin bearer.
   Still works for the 8 v3.37 tools but cannot drive the bot-scoped tools
   (`chatlytics_poll`, `chatlytics_configure`).

The plugin verifies its identity at boot via `GET /api/v1/bot/me` (bot-token
mode only) and logs `Bot identity: <display_name> (fp=<8-char>)`. INV-02 —
the plaintext token is NEVER logged.

`CHATLYTICS_API_URL` is **optional** — it defaults to
`https://node.chatlytics.ai` (the hosted Chatlytics API). Set only
`CHATLYTICS_BOT_TOKEN` for the standard hosted setup; override the URL only
when self-hosting or pointing at a non-default endpoint.

## Available Tools

| Tool | Use When |
|------|----------|
| `chatlytics_send` | User wants to send a WhatsApp message |
| `chatlytics_read` | User wants to read recent messages from a chat |
| `chatlytics_search` | User wants to find a contact or group |
| `chatlytics_directory` | User wants to browse all contacts/groups |
| `chatlytics_actions` | User asks what WhatsApp operations are available |
| `chatlytics_health` | User asks about connection status |
| `chatlytics_login` | User just installed the plugin and wants to verify their bot token + connection |
| `chatlytics_dispatch` | User asks for any action beyond send/read/search (groups, polls, reactions, labels, media, presence, etc.) |
| `chatlytics_poll` | Poll for inbound WhatsApp messages (long-poll, webhook-less). Requires `CHATLYTICS_BOT_TOKEN`. |
| `chatlytics_configure` | User wants to change the bot's own display name, trigger word, message prefix/suffix, keyword filter, or DM/group allow-lists. Requires `CHATLYTICS_BOT_TOKEN`. |

## How to Send Messages

Use `chatlytics_send` with the recipient's name or phone number:
- By name: `chatlytics_send(to: "Omer", text: "Hello!")`
- By phone: `chatlytics_send(to: "972544329000", text: "Hello!")`
- To group: `chatlytics_send(to: "Team Chat", text: "Meeting at 3pm")`

The system resolves names to WhatsApp IDs automatically.

## Message Formatting

WhatsApp does NOT support markdown. Use plain text only:
- No `**bold**` or `*italic*` — use WhatsApp formatting: *bold*, _italic_, ~strikethrough~, ```monospace```
- Keep messages short — WhatsApp is a chat app, not email
- Use line breaks for structure, not headers
- Emojis are fine but use sparingly

## Reading Messages

Use `chatlytics_read` with a chat ID to see recent messages. To find the chat ID:
1. Use `chatlytics_search` to find the contact/group
2. Use the returned `chatId` or `jid` field

## Advanced actions

The 6 core tools (send/read/search/directory/actions/health) cover the common
cases. For everything else — group management, polls, reactions, labels, media,
status, presence, profile updates — use `chatlytics_dispatch`.

Workflow:
1. Call `chatlytics_actions` to discover the full catalog (~100 actions).
2. Pick the action name that matches the user's intent.
3. Call `chatlytics_dispatch` with `action`, optional `target` (chat ID or
   contact/group name), and an action-specific `parameters` object.

Examples:

- "Create a WhatsApp group called 'Beta Testers' with these contacts":
  `chatlytics_dispatch(action: "createGroup", parameters: { name: "Beta Testers", participants: ["972544329000@c.us", "..."] })`

- "Send a poll to the team chat with 3 options":
  `chatlytics_dispatch(action: "sendPoll", target: "Team Chat", parameters: { poll: { name: "Lunch?", options: ["Pizza", "Sushi", "Salad"], multipleAnswers: false } })`

- "Add a fire reaction to message X":
  `chatlytics_dispatch(action: "react", parameters: { messageId: "true_972...@c.us_3EB0...", reaction: "🔥" })`

If the action name is wrong, the API returns a clear error — call
`chatlytics_actions` to re-check the catalog.

Bot-token scoping: on the dispatch route, bot tokens are confined to a
server-side dispatchable-actions allowlist — admin/destructive verbs return
`403 bot_action_not_dispatchable`, and send-class verbs return
`403 bot_send_via_dispatch_denied` (use `chatlytics_send` for text sends —
it routes through the gated `/api/v1/send`).

## Self-configuration

Use `chatlytics_configure` (bot-token mode only) when the user wants to
change how THIS bot presents or behaves: `display_name`, `trigger`
(word/operator/require_both), outbound `prefix`/`suffix`, `keyword_filter`
(keywords + dm/group scope), or `access_policy` DM/group allow-lists. Only
the fields you pass are updated. Identity and permissions (session, account,
default-bot status, permission scope, the token) CANNOT be changed here —
the server rejects them.

## Inbound: long-poll mode

When `CHATLYTICS_BOT_TOKEN` is configured, the agent can receive inbound
WhatsApp messages addressed to the bot WITHOUT running an HTTP webhook
server. Use `chatlytics_poll`:

1. First call: `chatlytics_poll({ timeout_ms: 25000 })` — blocks up to 25s
   for the first envelope.
2. Response shape: `{ envelopes: [{ seq, from, text, ... }], cursor }`.
   Empty `envelopes` is normal — it just means no traffic during the wait.
3. Resume call: pass `cursor` back as `{ cursor, timeout_ms: 25000 }`.
4. Once the user-facing reply for a batch is sent, ack the cursor:
   `chatlytics_poll({ ack: cursor_of_last_handled, cursor, timeout_ms })`.
   The ack is best-effort; failures log but do not block.

Long-poll is bot-scoped. `chatlytics_poll` returns an actionable error if
the operator only has `CHATLYTICS_API_KEY` set — tell them to provision a
bot token at https://app.chatlytics.ai → Bots.

Webhook mode (the plugin shipping a public URL the chatlytics server POSTs
to) is the alternative for plugins that already expose an HTTP server; the
two are mutually exclusive per bot — each bot has either a webhook URL or
a long-poll queue, never both at the same time.

## Best Practices

- Always confirm before sending messages to new contacts
- Don't send multiple messages in rapid succession (rate limited)
- For media (images, files), use `chatlytics_dispatch` with the media-send action (e.g. `sendImage`, `sendFile`) — discover the exact name via `chatlytics_actions`
- If `chatlytics_health` returns unhealthy, tell the user the WhatsApp connection is down
