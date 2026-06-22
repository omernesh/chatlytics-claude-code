# Chatlytics for Claude Code — Quickstart

Goal: send your first WhatsApp message from Claude Code in under 5 minutes.

This guide is for beta testers. It assumes no prior knowledge of MCP servers,
plugins, or the Chatlytics REST API.

---

## 1. Prerequisites

You need:

- **Claude Code installed** — see https://docs.claude.com/en/docs/claude-code
  if you don't have it yet.
- **A Chatlytics account.** This is a private beta. If you don't have one,
  email **omernesher@gmail.com** to request beta access.
- **A paired WhatsApp session** — your Chatlytics account dashboard at
  https://app.chatlytics.ai shows whether your phone is linked. If the
  session shows `WORKING`, you're good. If not, scan the QR code in the
  Chatlytics admin panel from your phone (Settings → Linked Devices in
  WhatsApp).

---

## 2. Get your bot token (v4.0 Telegram-style onboarding)

1. Go to **https://app.chatlytics.ai**.
2. Sign in.
3. Navigate to **Bots → Create Bot**, name it something like "claude-code",
   pick the WhatsApp session it should ride, and copy the `sk_bot_*` token.
   **The plaintext token appears ONCE — store it somewhere safe.** Rotating
   later regenerates the value.

Also note your **session ID** from the dashboard (e.g. `abc12345_yourname`).
You'll need it in step 4.

If the Bots UI is not yet live in your account, you can provision a bot via
the REST API directly:

```bash
curl -sS -X POST https://app.chatlytics.ai/api/v1/bots \
  -H "Authorization: Bearer $CHATLYTICS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"display_name": "claude-code", "session_id": "abc12345_yourname"}' \
  | jq -r '.bot_token'
```

The returned `sk_bot_*` is your `CHATLYTICS_BOT_TOKEN`.

**Legacy v3.37 fallback:** the plugin still accepts `CHATLYTICS_API_KEY`
(operator/admin shared bearer). Skip step 2 if you're staying on the legacy
path — but note that `chatlytics_poll` (long-poll inbound) requires a bot
token.

---

## 3. Install the plugin

Two commands in your terminal:

```bash
claude plugin marketplace add omernesh/chatlytics-claude-code
claude plugin install chatlytics@chatlytics-claude-code
```

The first command registers the GitHub repo as a Claude Code marketplace.
The second installs the `chatlytics` plugin from it. The MCP server ships
as a single self-contained bundle — **no `npm install` needed**.

Verify it landed:

```bash
claude plugin list
```

You should see `chatlytics@chatlytics-claude-code` with status `✔ enabled`.

### Alternative: scripted user-scope install (survives plugin updates)

Plugin-cache directories are version-pinned and wiped on every plugin update.
If you prefer a durable standalone install (no plugin manager involved), use
the installer script — it copies the MCP bundle to a stable path
(`~/.chatlytics/mcp/chatlytics-mcp.mjs`) and registers it user-scoped:

```bash
git clone https://github.com/omernesh/chatlytics-claude-code.git
cd chatlytics-claude-code
node scripts/install.mjs --token sk_bot_your-token
```

Re-running the script is safe — it updates the copy and re-registers. With
this route you can skip the `env` block in step 4 (the token/URL are baked
into the MCP registration); the restart in step 4 still applies.

---

## 4. Configure

Open your Claude Code settings file:

- **Per-project:** `.claude/settings.json` in the project root.
- **Global (recommended for beta):** `~/.claude/settings.json` on macOS/Linux,
  `%USERPROFILE%\.claude\settings.json` on Windows.

Add or merge the following `env` block (recommended v4.0 shape — the bot
token is the only required var):

```json
{
  "env": {
    "CHATLYTICS_BOT_TOKEN": "sk_bot_paste-your-token-here"
  }
}
```

`CHATLYTICS_API_URL` is optional — it defaults to
`https://node.chatlytics.ai` (the hosted API). Set it only if you self-host.
`CHATLYTICS_SESSION` is **not needed for bot tokens** — the server pins the
session to the bot's own. Do not set it in your settings env for bot-token
mode; it is only relevant for legacy api_key sends (see below).

For legacy v3.37 setups still on the operator api_key (here the session IS
needed for sends):

```json
{
  "env": {
    "CHATLYTICS_API_KEY": "paste-your-api-key-here",
    "CHATLYTICS_SESSION": "your-session-id"
  }
}
```

If the file already has other keys, merge into the existing `env` object —
don't overwrite the whole file.

Restart Claude Code so it picks up the new env vars. **The restart is not
optional** — MCP servers added or reconfigured mid-session do not surface
their tools until the session restarts.

---

## 5. Verify

In any Claude Code session, ask:

> use chatlytics_login to test my connection

Claude should reply with something like:

```
✅ Connected to Chatlytics at https://node.chatlytics.ai (auth mode: bot_token).
Webhook registered. Sessions: 1.
Bot: claude-code (fp=a1b2c3d4)
Session: abc12345_yourname
Default bot: no
```

The bot identity block appears in bot-token mode (it's fetched live from
`GET /api/v1/bot/me`); paired entities are listed too where the server
supports it. If you see a ❌ instead, jump to **Common issues** below.

---

## 6. Send your first message

Ask Claude:

> send "hello from claude code" to Omer on WhatsApp

(replace "Omer" with any contact or group name from your WhatsApp).

Claude will:

1. Resolve the name to a WhatsApp ID via search.
2. Send the message through Chatlytics.
3. Confirm with the message ID.

Open WhatsApp on your phone and verify the message landed.

---

## 7. Common issues

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `❌ Chatlytics API rejected the credential (HTTP 401)` | Bot token (or legacy api_key) wrong, expired, revoked, or grace-window-expired after rotation | If on `CHATLYTICS_BOT_TOKEN`: rotate at app.chatlytics.ai → Bots → rotate-token, copy the new `sk_bot_*`, update `.claude/settings.json`, restart Claude Code. If on legacy `CHATLYTICS_API_KEY`: re-copy from Settings → API Keys. |
| `❌ Chatlytics API rejected the credential (HTTP 403)` | Credential valid but lacks permission for the requested action (bot's `permission_scope` blocks it) | Either pick a tool inside the bot's allowed actions, or update the bot's `permission_scope` at app.chatlytics.ai → Bots → <bot> → Permissions. Legacy api_key path: contact support — your account may not be enabled. |
| `chatlytics_poll requires CHATLYTICS_BOT_TOKEN` | Tried to long-poll while only `CHATLYTICS_API_KEY` is set | Long-poll inbound is bot-scoped. Provision a bot token (step 2 above) and add `CHATLYTICS_BOT_TOKEN` to `.claude/settings.json`. |
| `network error calling .../health` or `AbortError` (request **times out**) | `CHATLYTICS_API_URL` points at a dead/unroutable IP (e.g. a stale Tailscale IP — TCP half-connects, HTTP hangs) | Switch to the DNS URL `https://node.chatlytics.ai` (or your LAN URL if on-prem). No trailing slash. |
| **Connection refused** (fails instantly) | Wrong host or port — nothing is listening there | Verify host/port. The hosted URL is `https://node.chatlytics.ai` with no port (Cloudflare proxies 443). |
| **HTTP 502**, especially during `chatlytics_poll` | Cloudflare tunnel concurrent long-poll limit (~4 concurrent long-polls) | On-prem consumers should use the LAN URL instead of `node.chatlytics.ai`. |
| `⚠️ webhook_registered is not true` | WhatsApp session disconnected or never paired | Open https://app.chatlytics.ai → Sessions. Re-scan the QR code from WhatsApp on your phone. |
| `No WhatsApp contact, group, or channel found matching "X"` | Name doesn't match any chat | Ask Claude to "search my WhatsApp for X" — the search tool is fuzzier than send/read. |
| `Multiple matches for "X"` | Ambiguous name | Claude will list candidates with their JIDs. Reply with the specific JID. |
| Tool not found in Claude Code | Plugin not installed, or settings not loaded | Re-run `claude plugin install ...`. Confirm `.claude/settings.json` is valid JSON. Restart Claude Code. |
| `session not found` from the API | `CHATLYTICS_SESSION` doesn't match a real session ID | Check the exact session ID at app.chatlytics.ai → Sessions. Copy it verbatim into settings. |

---

## 8. Going further

The plugin ships **10 MCP tools**:

- `chatlytics_send` — send a message
- `chatlytics_read` — read recent messages
- `chatlytics_search` — find a contact/group/channel
- `chatlytics_directory` — browse all chats
- `chatlytics_actions` — list the full ~100-action catalog
- `chatlytics_health` — connection status
- `chatlytics_login` — validate your bot token / api key
- `chatlytics_dispatch` — invoke any action by name (create groups, send
  polls, react to messages, manage labels, change presence, send media, etc.)
- `chatlytics_poll` — long-poll for inbound WhatsApp messages addressed to
  your bot (webhook-less). Requires `CHATLYTICS_BOT_TOKEN`.
- `chatlytics_configure` — self-configure the bot (display name, trigger,
  prefix/suffix, keyword filter, access policy). Requires `CHATLYTICS_BOT_TOKEN`.

Deeper docs:

- [docs/TOOLS.md](./docs/TOOLS.md) — full per-tool reference (params,
  endpoints, auth requirements).
- [docs/AUTHENTICATION.md](./docs/AUTHENTICATION.md) — bot-token vs legacy
  api_key, boot-time identity verification, permission scoping.
- [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) — the full failure
  matrix (a superset of the table above).
- [`skills/chatlytics/SKILL.md`](./skills/chatlytics/SKILL.md) — the same
  guide Claude itself reads when deciding how to use these tools.

Example advanced asks Claude can handle:

- "create a WhatsApp group called Beta Testers with Omer and Sammie"
- "add a 🔥 reaction to my last message in the Team Chat"
- "send a poll to Team Chat asking lunch options"
- "mute the marketing channel for 24 hours"

If something's broken or unclear, ping **omernesher@gmail.com** — beta
feedback shapes v1.
