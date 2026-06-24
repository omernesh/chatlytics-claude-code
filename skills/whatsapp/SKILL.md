---
name: whatsapp
description: Check your WhatsApp inbox inside Claude Code. Use when the user runs /whatsapp, says "check whatsapp", "any new messages", "whatsapp inbox", or wants to see recent WhatsApp messages. New messages surface automatically in real time via the background listener — you don't need to run /whatsapp to watch. Companion verbs: /reply-whatsapp, /send-whatsapp, /react-whatsapp.
---

# WhatsApp in Claude Code

WhatsApp messages are delivered **in real time** — you don't need to run `/whatsapp`
to watch for them. New messages appear directly in the conversation (framed with a
visual border) as soon as they arrive, via the background listener the session drives.

## How the real-time delivery works

1. **On session start**, `daemon/wa-listener-autostart.mjs` runs automatically
   (SessionStart hook). It starts a background poll loop (`daemon/wa-poll-once.mjs`)
   that the session itself drives.
2. The poll loop long-polls Chatlytics for new envelopes addressed to the bot.
3. Each incoming message is framed and delivered **directly into the conversation**:

```
────────────────────────────────────────
📱 whatsapp message from Jane Doe: "see you at 5"
────────────────────────────────────────
```

Edits arrive with an `(edited)` tag. Only one Claude Code session listens at a time
(heartbeat lock in `~/.claude/whatsapp-cc/`); a second session stands down automatically.

You only need to run `/whatsapp` when you want to **manually review the recent inbox**
or check listener status.

## /whatsapp — manual inbox review

1. Read `~/.claude/whatsapp-cc/state.json` to get the `recent` list (last 20 envelope summaries) and `last` (most recent).
2. Read the tail of `~/.claude/whatsapp-cc/inbox.jsonl` for full message bodies (last ~20–30 lines).
3. Display a formatted summary to the user:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━
WhatsApp Inbox (last N messages)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
[dm]    Ran Margalit:      "hey man, how are you"          (2 min ago)
[group] Dev Team / Ran:    "can you review the PR?"        (5 min ago)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Reply with /reply-whatsapp
```

If the listener is not running (no recent messages, lock file absent), tell the user:
> The WhatsApp listener is not running. It starts automatically on session launch.
> Start a new Claude Code session to restart it.

**There is NO polling loop, NO ScheduleWakeup, NO chatlytics_poll call in /whatsapp.**
The listener handles real-time delivery. `/whatsapp` is a read-only inbox viewer.

## Rendering inbox lines

When displaying messages from `inbox.jsonl`:
- **Strip** any leading line starting with `[SECURITY:` — server's untrusted-data framing, not content.
- Show: `[<chat_type>] <sender_jid stripped of @suffix>: "<text preview, ~120 chars>"`
- Timestamp: show relative time from `received_at` (ms epoch) or `ts`.

## Replying / sending / reacting

Use the companion skills — they read `~/.claude/whatsapp-cc/state.json` for context:

- `/reply-whatsapp <text>` → reply to `state.last` (most recent inbound).
- `/reply-whatsapp <contact> <text>` → reply to that contact's last message.
- `/send-whatsapp <contact> <text>` → new outbound message.
- `/react-whatsapp <emoji>` (or `<contact> <emoji>`) → react to last (or named) message.

All sends go through `chatlytics_send` / `chatlytics_dispatch`. Pass `session` = `sessionId` from the envelope, and `to` = `entity_jid`.

## Notes

- **No active watch loop to stop** — the listener is session-bound. It stops when the
  Claude Code session ends. A new session restarts it automatically.
- **Single consumer** — only one session holds the listener lock at a time. Open a
  second session and it stands down gracefully; messages go to the first session.
- **Media URLs** — media URLs are time-limited. Open `url=` links soon after the message arrives.
- **Latency** — ~2s for delivery under normal conditions.
