# MCP Tool Reference (v2.2.0)

The plugin registers **10 MCP tools**, all backed by the Chatlytics REST API.
Every request carries `Authorization: Bearer <credential>` where the credential
is `CHATLYTICS_BOT_TOKEN` (preferred) or the legacy `CHATLYTICS_API_KEY` —
see [AUTHENTICATION.md](./AUTHENTICATION.md).

In bot-token mode the server may filter this catalog per bot: at startup the
plugin calls `GET /api/v1/bot/me/tools` and registers only the tools the bot's
`permission_scope` allows. If that endpoint is unreachable, the plugin
**fails open** and registers all 10 tools (the server-side scope check at
dispatch time remains the security boundary).

## Summary

| Tool | What it does | Endpoint(s) | Auth required |
|------|--------------|-------------|---------------|
| `chatlytics_send` | Send a text message to a contact/group | `POST /api/v1/send` (name→JID resolution via `POST /api/v1/actions` `search`) | bot token or api_key |
| `chatlytics_read` | Read recent messages from a chat | `POST /api/v1/actions` (`readMessages`) | bot token or api_key |
| `chatlytics_search` | Find contacts/groups/channels by name | `POST /api/v1/actions` (`search`) | bot token or api_key |
| `chatlytics_directory` | Browse contacts, groups, newsletters | `GET /api/v1/directory` | bot token or api_key |
| `chatlytics_actions` | List the full ~100-action catalog | `GET /api/v1/actions` | bot token or api_key |
| `chatlytics_health` | Chatlytics + WhatsApp connection status | `GET /health` | none required (diagnostics) |
| `chatlytics_login` | Validate credential + surface bot identity | `GET /health`, `GET /api/v1/bot/me`, `GET /api/v1/bot/me/pairings` | any (gives onboarding prompt when unset) |
| `chatlytics_dispatch` | Invoke any catalog action by name | `POST /api/v1/actions` | bot token or api_key (bot tokens are allowlist-scoped — see below) |
| `chatlytics_poll` | Long-poll for inbound messages | `GET /api/v1/bot/updates`, `POST /api/v1/bot/updates/ack` | **bot token only** |
| `chatlytics_configure` | Self-configure the bot (name, trigger, filters) | `PATCH /api/v1/bot/me` | **bot token only** |

When no credential is configured at all (`AUTH_MODE === "none"`), every data
tool short-circuits with a get-a-token onboarding prompt instead of a raw 401.
`chatlytics_health` and `chatlytics_login` stay usable for diagnostics.

## Tool details

### chatlytics_send

```
chatlytics_send(to, text, session?)
```

- `to` — contact name, phone number, or JID. Non-JID input is resolved through
  the `search` action; zero matches and ambiguous matches return actionable
  errors (the ambiguous case lists up to 10 candidates with their JIDs).
- All auth modes send through the gated `POST /api/v1/send` route (unified in
  v2.1.1/P6). For bot tokens the server pins the session to the bot's own, so
  `session` is optional. Legacy api_key callers **must** provide a session
  (per-call `session` or `CHATLYTICS_SESSION`) — `/api/v1/send` requires one
  and returns an actionable 400 if it's missing.

### chatlytics_read

```
chatlytics_read(chatId, limit?)   # limit defaults to 10
```

Accepts a JID (`972544329000@c.us`, `1203...@g.us`, `...@lid`,
`...@newsletter`) or a name (auto-resolved like `chatlytics_send`). Calls the
`readMessages` action.

### chatlytics_search

```
chatlytics_search(query)
```

Fuzzy search across contacts, groups, and channels via the `search` action.

### chatlytics_directory

```
chatlytics_directory(type?, search?, limit?)   # type: contact | group | newsletter
```

### chatlytics_actions

```
chatlytics_actions()
```

Lists the full action catalog (~100 actions) for use with
`chatlytics_dispatch`.

### chatlytics_health

```
chatlytics_health()
```

Returns the raw `/health` payload. Not gated on a credential — useful for
diagnosing URL/connectivity problems before auth is configured.

### chatlytics_login

```
chatlytics_login()
```

The post-install verification tool. Checks `/health` and asserts
`webhook_registered: true`. On success returns:

```
✅ Connected to Chatlytics at <URL> (auth mode: bot_token). Webhook registered. Sessions: N.
Bot: <display_name> (fp=<8-char fingerprint>)
Session: <session_id>
Default bot: yes|no
Paired entities (N): <jid> [type], ... 
```

The identity block (bot-token mode only) re-fetches `GET /api/v1/bot/me` at
call time so it's always fresh. The pairings block comes from
`GET /api/v1/bot/me/pairings` and is **fail-open**: a 404 (endpoint not yet
implemented server-side) or any error simply omits the block — login still
succeeds. The raw token is never included; only the server-derived 8-char
fingerprint (INV-02).

### chatlytics_dispatch

```
chatlytics_dispatch(action, target?, parameters?, session?)
```

Generic dispatcher for everything beyond send/read/search: `createGroup`,
`sendPoll`, `react`, `muteChat`, label management, presence, profile, media
sends, etc. Discover names with `chatlytics_actions`.

**Bot-token scoping (server v4.5.4+):** on `POST /api/v1/actions`, bot tokens
are confined to a server-side dispatchable-actions allowlist — admin and
destructive verbs are not dispatchable and return
`403 bot_action_not_dispatchable`. Send-class verbs are also denied on this
route for bots (`403 bot_send_via_dispatch_denied`) — text sends must go
through `chatlytics_send`, which targets the gated `/api/v1/send` route where
pairing and session-pin checks run. Per-verb `actions_denied` in the bot's
`permission_scope` is authoritative on top of the allowlist. The legacy
operator api_key is not subject to the bot allowlist.

### chatlytics_poll

```
chatlytics_poll(cursor?, timeout_ms?, ack?)
```

Drives the v4.0 long-poll inbound endpoints — receive WhatsApp messages
addressed to your bot without exposing a webhook URL:

- `GET /api/v1/bot/updates?cursor=...&timeout_ms=...` — blocks up to
  `timeout_ms` for new envelopes. Default 25 000 ms, clamped client-side to
  [1 000, 60 000]. The fetch timeout is `timeout_ms + 5s` so the client never
  races the server's wait.
- `POST /api/v1/bot/updates/ack` `{cursor}` — when `ack` is passed, the ack is
  POSTed **before** the GET. Best-effort: ack failures are logged to stderr
  and never block the poll.

Returns `{ envelopes: [...], cursor }`. Empty `envelopes` on a 200 is a normal
long-poll timeout, not an error. Pass the returned `cursor` on the next call
to resume; pass the same value as `ack` to ack-and-resume in one call
(passing `ack` without `cursor` acks, then re-polls from seq 0).

**Bot-token only.** The server route is resolved via the bot bearer; the
plugin short-circuits with a clear migration error if only
`CHATLYTICS_API_KEY` is set. An HTTP 400 usually means `invalid_cursor` (e.g.
after a token rotation) — drop the cursor and re-poll fresh.

### chatlytics_configure

```
chatlytics_configure(display_name?, trigger?, prefix?, suffix?, keyword_filter?, access_policy?)
```

Self-configures **this** bot via `PATCH /api/v1/bot/me`. Friendly flat fields
are translated to the server's strict wire contract; only the fields you pass
are updated. Configurable: display name, trigger word/operator/require_both,
outbound message prefix/suffix, keyword filter (keywords + dm/group scope),
and DM/group access allow-lists (always allow-lists — the server rejects
`allow_all`).

Identity and authority fields (session, account, default-bot status,
`permission_scope`, the token itself) are **not** editable here — the server
rejects them and the tool never sends them. **Bot-token only.**
