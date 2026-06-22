---
name: whatsapp
description: Check your WhatsApp inbox inside Claude Code. Use when the user runs /whatsapp, says "check whatsapp", "any new messages", "whatsapp inbox", or wants to see recent WhatsApp messages. New messages now surface automatically on every prompt via the inject-hook — you don't need to run /whatsapp to watch. Companion verbs: /reply-whatsapp, /send-whatsapp, /react-whatsapp.
---

# WhatsApp in Claude Code

WhatsApp messages are delivered **passively** — you don't need to run `/whatsapp` to watch for them. New messages surface automatically at the top of your next prompt via the `inject-hook` background system.

## How the passive delivery works

1. **On session start**, `ensure-daemon.mjs` runs automatically (SessionStart hook). It probes port 7656 and spawns the long-poll daemon if it is not already running.
2. **The daemon** (`daemon.mjs`) runs detached in the background, long-polling chatlytics for new envelopes and appending them to `~/.claude/whatsapp-cc/inbox.jsonl`.
3. **On every prompt you submit**, `inject-hook.mjs` (UserPromptSubmit hook) reads any new inbox lines and injects them as context above your prompt — so you see incoming messages without running any command.

You only need to run `/whatsapp` when you want to **manually review the recent inbox** or check daemon status.

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
Daemon: running (port 7656 active) | Last: <ts of last.ts>
Reply with /reply-whatsapp
```

To check daemon status, probe port 7656:
```js
// Use net.createConnection({port:7656, host:'127.0.0.1'})
// success → running; ECONNREFUSED → not running
```

If daemon is not running, tell the user:
> The WhatsApp daemon is not running. It starts automatically on session launch. Start a new terminal/session or run:
> `node ~/.claude/whatsapp-cc/ensure-daemon.mjs`

**There is NO polling loop, NO ScheduleWakeup, NO chatlytics_poll call in /whatsapp.**
The hook system handles real-time delivery. `/whatsapp` is a read-only inbox viewer.

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

- **No active watch loop** — the daemon is always-on. `/whatsapp stop` is not a valid concept; stop the daemon by killing the process holding port 7656 (see README.md).
- **One inbox per machine** — the daemon holds a singleton on port 7656 per machine. Multiple CC sessions see the same `inbox.jsonl`; the `read-state.json` per-session pointer tracks what each session has consumed.
- **Media URLs** — WAHA media URLs are time-limited. Open `url=` links soon after the message arrives.
- **Latency** — up to one long-poll cycle (~55s) for delivery if no messages are queued.
