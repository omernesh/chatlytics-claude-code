---
name: reply-whatsapp
description: Reply to a WhatsApp message from inside Claude Code. Use when the user runs /reply-whatsapp, or says "reply to <contact> …" / "tell <contact> …" / "reply: …" about a WhatsApp message that arrived in the session. Two forms — /reply-whatsapp <text> replies to the most recent message; /reply-whatsapp <contact> <text> replies to that contact. Part of the `whatsapp` inbox skill.
---

# /reply-whatsapp

Reply to a WhatsApp message that arrived in this session, via the chatlytics MCP. State lives in `~/.claude/whatsapp-cc/state.json` (written by the `whatsapp` skill — read that skill for the state shape).

## Parse the arguments

Read `state.json` first (need `last` and the `recent[]` sender names).

1. **`/reply-whatsapp <text>`** — no leading contact name → target `state.last`.
2. **`/reply-whatsapp <contact> <text>`** — decide if the first word(s) are a contact name by matching the longest prefix of the args against the names in `state.recent[]` (case-insensitive, fuzzy ok). If a prefix matches a known recent sender, that's the **target** and the rest is the **text**. If nothing matches, treat the WHOLE args as text replying to `state.last` (don't guess a stranger as a name).

Resolve the target to a concrete chat:
- From the matched `recent[]`/`last` entry use `chatJid` (the chat id) and `sessionId`.
- If the user named a contact NOT in recent (they want to reply to someone who hasn't messaged), fall back to passing the name as `to` and omit session (default) — but prefer the recent entry when present.

## Send

```
chatlytics_send({ to: <chatJid or contact name>, text: <reply text>, session: <sessionId> })
```

- `to` = the resolved `chatJid` when available (most reliable; avoids name ambiguity), else the contact name (chatlytics fuzzy-resolves it).
- `session` = the originating `sessionId` from state so the reply goes out on the right account; omit only if unknown.

## Confirm

One line: `✅ Replied to <name>: "<text>"`. If the send errors, report the error and (if it's auth) point to the `CHATLYTICS_BOT_TOKEN` setup (your bot token is your API key). Do not silently swallow a failure.

## Examples
- `/reply-whatsapp hey man, all good` → replies to whoever sent the last message.
- `/reply-whatsapp ran margalit hey man, how are you` → replies to Ran Margalit's chat.
