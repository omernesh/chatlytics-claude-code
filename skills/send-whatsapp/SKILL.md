---
name: send-whatsapp
description: Send a brand-new WhatsApp message to a contact or group from inside Claude Code. Use when the user runs /send-whatsapp, or says "send a whatsapp to <contact> …" / "message <contact> on whatsapp …" / "whatsapp <contact> …". Form — /send-whatsapp <contact> <message>. Part of the `whatsapp` inbox skill.
---

# /send-whatsapp

Start a new WhatsApp conversation/message (not a reply) via the chatlytics MCP.

## Parse the arguments

`/send-whatsapp <contact> <message>` — the first token(s) are the recipient name/number, the rest is the message.

Splitting name from message: a contact name is usually 1–3 words. Prefer matching the longest prefix against:
1. names in `~/.claude/whatsapp-cc/state.json` `recent[]` (if present), then
2. a directory lookup: `chatlytics_search({ query: "<candidate name>" })` or `chatlytics_directory({ search: "<candidate>" })` to confirm the recipient exists.

If the recipient is ambiguous (multiple matches) or not found, ask the user to clarify rather than sending to the wrong chat. Phone numbers (e.g. `+972…`) can be passed straight through as `to`.

## Send

```
chatlytics_send({ to: <contact name | phone | chatJid>, text: <message> })
```
Omit `session` to use the default session, unless the user specified an account. chatlytics fuzzy-resolves names → JIDs.

## Confirm

One line: `✅ Sent to <name>: "<message>"`. Report send errors plainly (don't swallow). If auth fails, point to the chatlytics MCP token setup.

## Example
- `/send-whatsapp dana call you in 10` → new message to Dana.
- `/send-whatsapp +972544329000 hey` → new message to that number.
