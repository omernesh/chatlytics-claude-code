---
name: list-allowlist
description: Show your bot's access-policy allow-list (the contacts and groups whose WhatsApp messages reach the bot) from inside Claude Code — no admin UI needed. Use when the user runs /list-allowlist, or says "list the allowlist", "what's on my allowlist", "who can DM the bot", "show the bot's allow-list", "who's whitelisted". Read-only. Part of the `whatsapp` inbox family.
---

# /list-allowlist

Show the **current bot's access-policy allow-list** — the contacts (DM) and groups whose
messages reach the bot. Talks directly to the bot-self REST API (`/api/v1/bot/me`) with
the bot bearer — no admin session, no web UI. **Read-only**: this never modifies anything.

## Preconditions

- `CHATLYTICS_BOT_TOKEN` (a `sk_bot_*` value) and `CHATLYTICS_API_URL` must be set in the
  environment (same vars the `whatsapp` inbox skill uses). If either is missing, tell the
  user to configure the chatlytics MCP / bot token and stop.

## Read the allow-list

GET the bot's own record:

```bash
curl -s "$CHATLYTICS_API_URL/api/v1/bot/me" \
  -H "Authorization: Bearer $CHATLYTICS_BOT_TOKEN"
```

From the JSON, take:

- `.access_policy.dm.entries` — the DM (contact) allow-list (may be absent → treat as `[]`).
- `.access_policy.group.entries` — the group allow-list (may be absent → treat as `[]`).

Each entry is a JID (`…@c.us` / `…@lid` for contacts, `…@g.us` for groups).

If the GET returns 401, the bot token is invalid/expired — say so plainly and stop. Any
other non-200 → report the status and body, don't fabricate a list.

## Resolve each JID to a display name

For every entry, resolve a human-readable name via the chatlytics MCP so the output reads
`<name> — <jid>` instead of a bare number:

- `chatlytics_directory({ search: "<numeric local part of the jid>" })` — the response is
  `{ contacts: [{ jid, displayName, isGroup, … }] }`. Match the row whose `jid` equals the
  entry's JID (or whose local part matches, to handle a `@lid` → phone hop) and use its
  `displayName`.
- Fallback: `chatlytics_search({ query: "<numeric local part>" })`.

Resolution is best-effort — if a JID resolves to no name, render it as `<jid>` alone (don't
block the listing on a missing name). Batch the lookups; don't ask the user anything (this
is a read-only report).

## Render

Print two grouped sections with counts, e.g.:

```
🔓 Bot allow-list

DM (3):
  • Omer Nesher — 972544329000@c.us
  • Sammie — 972555713995@c.us
  • +972∙∙∙∙∙∙32 — 972506981332@c.us

Groups (1):
  • Sammie Test Group — 120363421825201386@g.us
```

If a bucket is empty, show `DM (0): (none)` / `Groups (0): (none)`. If BOTH buckets are
empty, say the allow-list is empty and remind the user they can add entries with
`/add-to-allowlist`.

## Notes

- This is the bot's **security boundary** — these are exactly the senders whose messages the
  bot will receive (and, for DM-paired routing, react to trigger-lessly). Listing it is safe
  and read-only.
- To change it: `/add-to-allowlist <contact-or-group> [dm|group]` to add,
  `/remove-from-allowlist <contact-or-group> [dm|group]` to remove.
