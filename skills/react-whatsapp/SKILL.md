---
name: react-whatsapp
description: React with an emoji to a WhatsApp message from inside Claude Code. Use when the user runs /react-whatsapp, or says "react 👍 to <contact>'s message" / "thumbs up the last one" / "react to that with ❤️". Forms — /react-whatsapp <emoji> reacts to the most recent message; /react-whatsapp <contact> <emoji> reacts to that contact's last message. Part of the `whatsapp` inbox skill.
---

# /react-whatsapp

Add an emoji reaction to a WhatsApp message via the chatlytics MCP.

## Parse the arguments

Read `~/.claude/whatsapp-cc/state.json` first (need `last` / `recent[]` for the target's `messageId` + `chatJid` + `sessionId`).

1. **`/react-whatsapp <emoji>`** — target `state.last`.
2. **`/react-whatsapp <contact> <emoji>`** — if a leading prefix matches a known `recent[]` sender name, that contact's most recent entry is the target; the trailing token is the emoji.

The reaction needs the **full `messageId`** (`true_<chat>_<short>` form) — take it from the target's `messageId` in state. If the target has no `messageId` stored, tell the user you can't react to it (older message before tracking) and offer to reply instead.

## React

```
chatlytics_dispatch({
  action: "react",
  target: <chatJid>,
  session: <sessionId>,
  parameters: { chatId: <chatJid>, messageId: <full messageId>, emoji: <emoji> }
})
```

To remove a reaction, pass `parameters.remove: true` (emoji optional). Note: reactions must be enabled on the account (if `reactionLevel` is off the dispatch returns a disabled message — relay it).

## Confirm

One line: `✅ Reacted <emoji> to <name>'s message`. Report errors plainly.

## Example
- `/react-whatsapp 👍` → 👍 on the last received message.
- `/react-whatsapp ran margalit ❤️` → ❤️ on Ran Margalit's last message.
