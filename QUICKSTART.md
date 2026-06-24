# Chatlytics for Claude Code — Quickstart

Goal: send your first WhatsApp message from Claude Code and receive replies in real time — in under 5 minutes.

---

## 1. Prerequisites

- **Claude Code installed** — see https://docs.claude.com/en/docs/claude-code
- **A Chatlytics account** with a linked WhatsApp session. Sign in at
  [app.chatlytics.ai](https://app.chatlytics.ai). Under **Sessions**, the session
  should show `WORKING`. If not, scan the QR code from WhatsApp on your phone
  (Settings → Linked Devices).

---

## 2. Get your bot token

1. Go to [app.chatlytics.ai](https://app.chatlytics.ai) and sign in.
2. Navigate to **Bots**.
3. Reveal and copy your `sk_bot_…` token.

That token is your `CHATLYTICS_BOT_TOKEN`. The plaintext is shown once — store
it somewhere safe. You can rotate it from the same page at any time.

---

## 3. Install the plugin

```bash
claude plugin marketplace add omernesh/chatlytics-claude-code
claude plugin install chatlytics@chatlytics-claude-code
```

No `npm install` needed — the MCP server ships as a single self-contained bundle.

Verify it landed:

```bash
claude plugin list
# → chatlytics@chatlytics-claude-code  ✔ enabled
```

---

## 4. Add your bot token

Open your Claude Code settings. Global settings apply to all projects
(recommended):

- **macOS / Linux:** `~/.claude/settings.json`
- **Windows:** `%USERPROFILE%\.claude\settings.json`

Add or merge the `env` block:

```json
{
  "env": {
    "CHATLYTICS_BOT_TOKEN": "sk_bot_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

`CHATLYTICS_API_URL` is optional — it defaults to `https://node.chatlytics.ai`.

**Restart Claude Code** so it picks up the new env var. The restart is required —
the MCP server does not surface its tools until the session restarts.

---

## 5. Verify the connection

In a new Claude Code session, ask:

> use chatlytics_login to test my connection

Expected output:

```
✅ Connected to Chatlytics at https://node.chatlytics.ai (auth mode: bot_token).
Webhook registered. Sessions: 1.
Bot: my-bot (fp=a1b2c3d4)
Session: abc12345_yourname
Default bot: yes
```

If you see a `❌`, check the **Common issues** table below.

---

## 6. Send your first message

Ask Claude:

> send "hello from claude code" to Omer on WhatsApp

Claude will resolve the name, send the message, and confirm with the message ID.
Check your phone — the message should be there.

---

## 7. Receive messages in real time

The session-start hook fires automatically. To receive a contact's messages,
add them to the allow-list:

```
/add-to-allowlist Omer
```

The next message they send will appear directly in your conversation:

```
────────────────────────────────────────
📱 whatsapp message from Omer: "got it, thanks"
────────────────────────────────────────
```

To reply:

```
/reply-whatsapp got it!
```

Only one Claude Code session listens at a time (single-consumer guard). If you
have two sessions open, close the second one to hand the listener back.

---

## 8. Common issues

| Symptom | Fix |
|---------|-----|
| `❌ HTTP 401` | Token wrong or rotated — update `CHATLYTICS_BOT_TOKEN` in settings and restart |
| `❌ HTTP 403` | Token valid but action blocked — check the bot's permission scope in the Chatlytics dashboard |
| Messages not showing | Verify `CHATLYTICS_BOT_TOKEN` is set; restart the session; check `/list-allowlist` |
| Request times out | `CHATLYTICS_API_URL` is pointing somewhere wrong — reset it to `https://node.chatlytics.ai` |
| Tools not found | Restart Claude Code after install |
| `webhook_registered` not true | Session disconnected — re-scan QR at app.chatlytics.ai → Sessions |

---

## 9. What's next

| Skill | What it does |
|-------|-------------|
| `/whatsapp` | Check the inbox on demand |
| `/send-whatsapp <contact> <message>` | Send a new message |
| `/reply-whatsapp [contact] <message>` | Reply to a received message |
| `/react-whatsapp [contact] <emoji>` | React to a message |
| `/add-to-allowlist <contact-or-group> [dm\|group]` | Allow a contact/group's messages |
| `/list-allowlist` | Show the allow-list |
| `/remove-from-allowlist <contact-or-group> [dm\|group]` | Remove from the allow-list |

For the full tool reference and advanced examples, see
[README.md](./README.md) and [docs/TOOLS.md](./docs/TOOLS.md).
