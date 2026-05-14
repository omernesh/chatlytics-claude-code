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

## 2. Get your API key

1. Go to **https://app.chatlytics.ai**.
2. Sign in.
3. Navigate to **Settings → API Keys**.
4. Click **Create Key**, give it a name like "claude-code", and copy the key.
   You won't be able to see it again — store it somewhere safe.

Also note your **session ID** from the dashboard (e.g. `abc12345_yourname`).
You'll need it in step 4.

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

---

## 4. Configure

Open your Claude Code settings file:

- **Per-project:** `.claude/settings.json` in the project root.
- **Global (recommended for beta):** `~/.claude/settings.json` on macOS/Linux,
  `%USERPROFILE%\.claude\settings.json` on Windows.

Add or merge the following `env` block:

```json
{
  "env": {
    "CHATLYTICS_API_URL": "https://app.chatlytics.ai",
    "CHATLYTICS_API_KEY": "paste-your-key-here",
    "CHATLYTICS_SESSION": "your-session-id"
  }
}
```

If the file already has other keys, merge into the existing `env` object —
don't overwrite the whole file.

Restart Claude Code so it picks up the new env vars.

---

## 5. Verify

In any Claude Code session, ask:

> use chatlytics_login to test my connection

Claude should reply with something like:

```
✅ Connected to Chatlytics at https://app.chatlytics.ai.
Webhook registered. Sessions: 1.
```

If you see a ❌ instead, jump to **Common issues** below.

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
| `❌ Chatlytics API rejected the key (HTTP 401)` | API key wrong, expired, or revoked | Re-copy from app.chatlytics.ai → Settings → API Keys. Update `.claude/settings.json`. Restart Claude Code. |
| `❌ Chatlytics API rejected the key (HTTP 403)` | Key valid but lacks permission | Contact support — your account may not be enabled for API access yet. |
| `network error calling .../health` or `AbortError` | `CHATLYTICS_API_URL` wrong, or your network can't reach it | Double-check the URL has no trailing slash and is `https://app.chatlytics.ai` (not `http://`, not your local IP). |
| `⚠️ webhook_registered is not true` | WhatsApp session disconnected or never paired | Open https://app.chatlytics.ai → Sessions. Re-scan the QR code from WhatsApp on your phone. |
| `No WhatsApp contact, group, or channel found matching "X"` | Name doesn't match any chat | Ask Claude to "search my WhatsApp for X" — the search tool is fuzzier than send/read. |
| `Multiple matches for "X"` | Ambiguous name | Claude will list candidates with their JIDs. Reply with the specific JID. |
| Tool not found in Claude Code | Plugin not installed, or settings not loaded | Re-run `claude plugin install ...`. Confirm `.claude/settings.json` is valid JSON. Restart Claude Code. |
| `session not found` from the API | `CHATLYTICS_SESSION` doesn't match a real session ID | Check the exact session ID at app.chatlytics.ai → Sessions. Copy it verbatim into settings. |

---

## 8. Going further

The plugin ships **8 MCP tools**:

- `chatlytics_send` — send a message
- `chatlytics_read` — read recent messages
- `chatlytics_search` — find a contact/group/channel
- `chatlytics_directory` — browse all chats
- `chatlytics_actions` — list the full ~100-action catalog
- `chatlytics_health` — connection status
- `chatlytics_login` — validate your API key
- `chatlytics_dispatch` — invoke any action by name (create groups, send
  polls, react to messages, manage labels, change presence, send media, etc.)

For the full catalog and advanced patterns, see
[`skills/chatlytics/SKILL.md`](./skills/chatlytics/SKILL.md). It's the same
guide Claude itself reads when deciding how to use these tools.

Example advanced asks Claude can handle:

- "create a WhatsApp group called Beta Testers with Omer and Sammie"
- "add a 🔥 reaction to my last message in the Team Chat"
- "send a poll to Team Chat asking lunch options"
- "mute the marketing channel for 24 hours"

If something's broken or unclear, ping **omernesher@gmail.com** — beta
feedback shapes v1.
