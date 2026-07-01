# Chatlytics Plugin for Claude Code

> **Like a Telegram bot, but for your WhatsApp.** Paste a bot token,
> get a WhatsApp-driven agent.

Give your Claude Code agent WhatsApp messaging superpowers via the
[Chatlytics](https://chatlytics.ai) REST API.

The plugin ships:

- **10 MCP tools** — `chatlytics_send`, `chatlytics_read`, `chatlytics_search`,
  `chatlytics_directory`, `chatlytics_actions`, `chatlytics_health`,
  `chatlytics_login`, `chatlytics_dispatch`, `chatlytics_poll`,
  `chatlytics_configure`.
- **A skill** that teaches Claude Code when and how to use WhatsApp.
- **WhatsApp inbox** — real-time inbound delivery via a session-driven background
  listener + 4 companion skills (`/whatsapp`, `/reply-whatsapp`, `/send-whatsapp`,
  `/react-whatsapp`) + a `SessionStart` hook that starts the listener automatically.

**Works on Windows, macOS, and Linux** — pure Node, no OS-specific code.

> **New here? Read [QUICKSTART.md](./QUICKSTART.md) — first WhatsApp message from Claude Code in under 5 minutes.**

**Docs:** [Tool reference](./docs/TOOLS.md) ·
[Authentication & scoping](./docs/AUTHENTICATION.md) ·
[Troubleshooting](./docs/TROUBLESHOOTING.md)

---

## What's new in v2.7.0 — real-time inbox

The background daemon model is replaced by a **session-driven listener** that
delivers messages in real time (~2s), directly into the conversation:

```
────────────────────────────────────────
📱 whatsapp message from Jane Doe: "see you at 5"
────────────────────────────────────────
```

- **SessionStart hook** runs `daemon/wa-listener-autostart.mjs` when a Claude Code
  session starts. It kicks off a background poll loop (`daemon/wa-poll-once.mjs`)
  that the session itself drives.
- Messages appear **in the conversation, in real time** — no waiting for your
  next prompt. Edits show an `(edited)` tag.
- **Single-consumer guard** — only one Claude Code session listens at a time via
  a heartbeat lock (`~/.claude/whatsapp-cc/`). A second session stands down
  automatically so messages are never split across sessions.
- **Cross-platform** — works on Windows, macOS, and Linux. State (lock + cursor)
  lives in `~/.claude/whatsapp-cc/`.
- No desktop notifications (removed in v2.7.0) — messages land directly in the
  conversation.

---

## Install

Two-step install via Claude Code's plugin manager:

```bash
claude plugin marketplace add omernesh/chatlytics-claude-code
claude plugin install chatlytics@chatlytics-claude-code
```

That fetches a single self-contained bundled MCP server
(`servers/chatlytics-mcp.bundle.mjs`) plus skills and hooks. **No `npm install`
needed** — the bundle ships all dependencies inline.

### Install from npm

The plugin is published to npm as
[`@chatlytics/claude-code`](https://www.npmjs.com/package/@chatlytics/claude-code).
Install it and run the bundled installer — it copies the MCP server to a stable
path and registers it user-scoped (same durable install as the scripted path
below, no git clone required):

```bash
npm install -g @chatlytics/claude-code
chatlytics-mcp-install --token sk_bot_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Or run it once without a global install:

```bash
npx -p @chatlytics/claude-code chatlytics-mcp-install --token sk_bot_xxx
```

Re-run after `npm update -g @chatlytics/claude-code` to refresh the stable copy.

### Scripted user-scope install (recommended for operators)

Plugin-cache directories are version-pinned and wiped on every plugin update.
For a durable, plugin-manager-independent install, use the bundled installer.
It copies the server to a stable path (`~/.chatlytics/mcp/chatlytics-mcp.mjs`)
and registers it user-scoped:

```bash
git clone https://github.com/omernesh/chatlytics-claude-code.git
cd chatlytics-claude-code
node scripts/install.mjs --token sk_bot_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Options (all prompt-free; env vars work too):

```bash
node scripts/install.mjs \
  --token sk_bot_xxx \                       # or env CHATLYTICS_BOT_TOKEN (preferred)
  --url https://node.chatlytics.ai \         # or env CHATLYTICS_API_URL (this is the default)
# --dry-run                                  # print actions, change nothing
```

The script is **idempotent** — re-run it after a `git pull` to refresh the
stable copy and re-register. Under the hood it runs:

```bash
claude mcp add -s user chatlytics \
  -e CHATLYTICS_BOT_TOKEN=sk_bot_... \
  -e CHATLYTICS_API_URL=https://node.chatlytics.ai \
  -- node ~/.chatlytics/mcp/chatlytics-mcp.mjs
```

> **Restart required:** mid-session installs do NOT surface tools until the
> Claude Code session restarts.

### Local / development install

```bash
git clone https://github.com/omernesh/chatlytics-claude-code.git
cd chatlytics-claude-code
cd servers && npm install && npm run build   # rebuild bundle after source edits
```

---

## Setup

Minimal setup is a single env var — your bot token. Set it in your Claude Code
settings (global `~/.claude/settings.json` recommended):

```json
{
  "env": {
    "CHATLYTICS_BOT_TOKEN": "sk_bot_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

Get your bot token from the **Chatlytics dashboard** at
[app.chatlytics.ai](https://app.chatlytics.ai): go to **Bots**, then reveal and
copy the `sk_bot_…` token. **The plaintext token appears once — store it
somewhere safe.** You can rotate it at any time from the same page.

`CHATLYTICS_API_URL` is **optional** — it defaults to `https://node.chatlytics.ai`
(the hosted Chatlytics API) — you normally never need to set it.

```json
{
  "env": {
    "CHATLYTICS_BOT_TOKEN": "sk_bot_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "CHATLYTICS_API_URL": "https://node.chatlytics.ai"
  }
}
```

---

## Verify install

In any Claude Code session, ask:

> use `chatlytics_login` to test my connection

Expected response:

```
✅ Connected to Chatlytics at https://node.chatlytics.ai (auth mode: bot_token).
Webhook registered. Sessions: 1.
Bot: my-bot (fp=a1b2c3d4)
Session: abc12345_yourname
Default bot: yes
```

If you see a clear error instead, check the **Troubleshooting** section below.

---

## WhatsApp inbox

Once the session starts, the listener runs automatically. Allow-listed contacts
and groups deliver their messages directly into your conversation:

```
────────────────────────────────────────
📱 whatsapp message from Jane Doe: "see you at 5"
────────────────────────────────────────
```

To receive messages from a contact or group, add them to the allow-list:

```
/add-to-allowlist Jane Doe
/add-to-allowlist Team Chat group
```

### Companion skills

| Skill | What it does |
|-------|-------------|
| `/whatsapp` | Check the inbox on demand |
| `/send-whatsapp <contact> <message>` | Send a new WhatsApp message |
| `/reply-whatsapp [contact] <message>` | Reply to a received message |
| `/react-whatsapp [contact] <emoji>` | React to a message |
| `/add-to-allowlist <contact-or-group> [dm\|group]` | Allow a contact/group's messages to reach you |
| `/list-allowlist` | Show the current allow-list |
| `/remove-from-allowlist <contact-or-group> [dm\|group]` | Remove from the allow-list |

### How it works

1. A **SessionStart hook** starts the background poll loop when Claude Code launches.
2. The listener long-polls Chatlytics for new messages addressed to your bot.
3. Each incoming message is framed and delivered **into the conversation in real time**
   (~2s latency).
4. The **single-consumer guard** ensures only one session listens at a time — open
   a second Claude Code window and it stands down gracefully.

State lives in `~/.claude/whatsapp-cc/` (lock, cursor). Requires `CHATLYTICS_BOT_TOKEN`.

---

## MCP tools

The plugin ships 10 MCP tools:

| Tool | What it does |
|------|-------------|
| `chatlytics_send` | Send a message to any contact or group |
| `chatlytics_read` | Read recent messages from a chat |
| `chatlytics_search` | Find a contact, group, or channel by name |
| `chatlytics_directory` | Browse all known chats |
| `chatlytics_actions` | List the full action catalog (~100 actions) |
| `chatlytics_health` | Check connection and session status |
| `chatlytics_login` | Validate your bot token and confirm identity |
| `chatlytics_dispatch` | Invoke any action by name (polls, reactions, media, groups, labels…) |
| `chatlytics_poll` | Long-poll for inbound messages (bot token required) |
| `chatlytics_configure` | Self-configure the bot (trigger, access policy, display name…) |

`chatlytics_send` and `chatlytics_read` accept either a JID
(`972544329000@c.us`, `120363...@g.us`) or a contact/group name — names are
auto-resolved. Ambiguous names return a picker listing candidates.

Example asks:

- "Send a WhatsApp message to Omer saying hello"
- "Read my recent messages from the Team Chat group"
- "Create a WhatsApp group called Beta Testers with Omer and Sammie"
- "Send a poll to Team Chat asking lunch options"
- "Add a 🔥 reaction to my last message in Team Chat"
- "Mute the marketing channel for 24 hours"

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Messages not showing | `CHATLYTICS_BOT_TOKEN` missing or wrong | Verify the token is set in `~/.claude/settings.json` and restart the session |
| Two sessions open — only one shows messages | Expected behavior — single-consumer guard | The second session stands down by design; close one session |
| `HTTP 401` | Bad, rotated, or revoked token | Rotate at app.chatlytics.ai → Bots, copy the new `sk_bot_*`, update settings, restart |
| `HTTP 403` | Token valid but action not permitted | Check the bot's permission scope in the Chatlytics dashboard |
| Request times out (`AbortError`) | `CHATLYTICS_API_URL` points at a dead/unroutable address | Use `https://node.chatlytics.ai` (the default) |
| Connection refused (instant) | Wrong host or port | Verify `CHATLYTICS_API_URL`; hosted default is `https://node.chatlytics.ai` (no port) |
| `HTTP 502` during `chatlytics_poll` | Too many simultaneous long-poll consumers | Keep the number of concurrent Claude Code sessions low; retry after a moment |
| Tools missing after install | Mid-session install | Restart the Claude Code session |
| `webhook_registered` not true | WhatsApp session disconnected | Open app.chatlytics.ai → Sessions and re-scan the QR code |

Full failure matrix: [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md).

---

## Versioning

The plugin is versioned independently from the Chatlytics service. It tracks
the **Chatlytics REST API contract**. See [CHANGELOG.md](./CHANGELOG.md) for
plugin release notes.

## License

MIT — see [LICENSE](./LICENSE).
