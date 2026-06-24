---
name: remove-from-allowlist
description: Remove a WhatsApp contact or group from your bot's access-policy allow-list from inside Claude Code — no admin UI needed. Use when the user runs /remove-from-allowlist, or says "remove <contact> from the allowlist", "stop getting <x>'s messages", "take <group> off the allowlist", "un-whitelist <contact>", "block <contact> from the bot". Form — /remove-from-allowlist <contact-or-group> [dm|group]. Part of the `whatsapp` inbox family.
---

# /remove-from-allowlist

Remove a contact (DM) or group from the **current bot's access-policy allow-list** so its
messages no longer reach the bot. Talks directly to the bot-self REST API (`/api/v1/bot/me`)
with the bot bearer — no admin session, no web UI.

This is the inverse of `/add-to-allowlist`. The allow-list is the bot's **security
boundary**, so be conservative: resolve precisely, and never remove an entry you're not
certain about.

## Preconditions

- `CHATLYTICS_BOT_TOKEN` (a `sk_bot_*` value) and `CHATLYTICS_API_URL` must be set in the
  environment (same vars the `whatsapp` inbox skill uses). If either is missing, tell the
  user to configure the chatlytics MCP / bot token and stop.

## Parse the arguments

`/remove-from-allowlist <contact-or-group> [dm|group]`

- Everything except an optional trailing `dm` / `group` keyword is the contact/group name
  (or a raw JID / phone number).
- **Scope**: if the user gave `dm` or `group`, use it. Otherwise infer it from the resolved
  JID suffix:
  - `…@g.us` → `group`
  - `…@c.us` / `…@lid` → `dm`
  If you can't tell (e.g. a bare name that could be either), ask the user which bucket —
  don't guess, this is a security boundary.

## Resolve the target to a JID

Same rules as `/add-to-allowlist`:

- A raw JID (`…@c.us`, `…@g.us`, `…@lid`) or phone number → use it directly (the canonical
  form is what's stored).
- Otherwise resolve the name via the chatlytics MCP:
  - contacts: `chatlytics_search({ query: "<name>" })` or
    `chatlytics_directory({ search: "<name>", type: "contact" })`
  - groups: `chatlytics_directory({ search: "<name>", type: "group" })`

If there are multiple matches or none, **ask the user to clarify rather than guessing** —
removing the wrong entry silently re-blocks a contact. Prefer the canonical `@c.us` / `@g.us`
JID from the match.

## Read the current entries (read-merge-write)

The PATCH **replaces** a bucket's `entries`, so you must send the FULL reduced list. First
read the current one:

```bash
curl -s "$CHATLYTICS_API_URL/api/v1/bot/me" \
  -H "Authorization: Bearer $CHATLYTICS_BOT_TOKEN"
```

From the JSON, take `.access_policy.<scope>.entries` (may be absent → treat as `[]`).

**Match the target JID against the entries in canonical form.** Account for `@c.us` vs `@lid`
vs a bare phone — compare by the numeric local part if an exact string match fails. If the
target is **not present** in that bucket, say so plainly (`<name> (<jid>) is not on the bot's
<scope> allow-list — nothing to remove.`) and **stop — do NOT PATCH**.

If present, build the reduced list = all current entries EXCEPT the matched one.

## Save

PATCH the reduced full list for the chosen bucket only (the other bucket is preserved
server-side):

```bash
curl -s -X PATCH "$CHATLYTICS_API_URL/api/v1/bot/me" \
  -H "Authorization: Bearer $CHATLYTICS_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modules":{"access-policy":{"config":{"<scope>":{"type":"allow_list","entries":[<reduced JIDs>]}}}}}'
```

`<scope>` is `dm` or `group`. Keep `type` as `"allow_list"`.

## Confirm

Re-GET `/api/v1/bot/me` (or trust the PATCH response) and verify the matched JID is GONE
from `.access_policy.<scope>.entries`. Only then report one line:

`✅ Removed <name> (<jid>) from the bot's <scope> allow-list (<N> entries left).`

**Never claim success unless the entry is actually absent from the returned `access_policy`.**
Report errors plainly (a 401 → bot token invalid/expired; a 400 → bad payload). If the re-GET
still shows the entry, say the removal did not take and show the current list.

## Examples

- `/remove-from-allowlist Sammie Nesher` → resolves Sammie → removes his `@c.us` from the
  **dm** allow-list (his DMs no longer reach the bot).
- `/remove-from-allowlist "Family Group" group` → removes the group `@g.us` from the
  **group** allow-list.
- `/remove-from-allowlist 972555713995 dm` → removes `972555713995@c.us` from the dm bucket.
