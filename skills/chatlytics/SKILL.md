---
name: chatlytics
description: Send and receive WhatsApp messages via Chatlytics. Use when the user asks to message someone on WhatsApp, read WhatsApp chats, or manage WhatsApp contacts/groups.
---

# Chatlytics — WhatsApp for Claude Code

You have WhatsApp messaging capabilities via the Chatlytics MCP tools.

## Available Tools

| Tool | Use When |
|------|----------|
| `chatlytics_send` | User wants to send a WhatsApp message |
| `chatlytics_read` | User wants to read recent messages from a chat |
| `chatlytics_search` | User wants to find a contact or group |
| `chatlytics_directory` | User wants to browse all contacts/groups |
| `chatlytics_actions` | User asks what WhatsApp operations are available |
| `chatlytics_health` | User asks about connection status |

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

## Best Practices

- Always confirm before sending messages to new contacts
- Don't send multiple messages in rapid succession (rate limited)
- For media (images, files), mention to the user that media sending is available via additional actions
- If `chatlytics_health` returns unhealthy, tell the user the WhatsApp connection is down
