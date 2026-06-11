# Troubleshooting (v2.2.0)

First diagnostic step is always the same: ask Claude to run
`chatlytics_login`. It checks `/health`, asserts `webhook_registered: true`,
and (in bot-token mode) surfaces the bot's identity. `chatlytics_health`
works even with no credential configured — use it to separate connectivity
problems from auth problems.

## Failure matrix

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `⚠️ Chatlytics needs a bot token...` onboarding prompt | Neither `CHATLYTICS_BOT_TOKEN` nor `CHATLYTICS_API_KEY` is set | Create a bot at https://app.chatlytics.ai → Bots → Create Bot, add `CHATLYTICS_BOT_TOKEN` to your settings `env` block (or re-run `node scripts/install.mjs --token ...`), restart Claude Code. |
| `Chatlytics API rejected the credential (HTTP 401)` | Token wrong, revoked, rotated past its 24h grace window — or something is stripping/rewriting the `Authorization: Bearer` header | Rotate at app.chatlytics.ai → Bots → rotate-token, copy the new `sk_bot_*`, update settings (or `install.mjs --token`), restart. Note the API uses `Authorization: Bearer`, **not** `X-Api-Key`. |
| `Chatlytics API rejected the credential (HTTP 403)` | Credential valid but the bot's `permission_scope` blocks the action | Use a tool inside the bot's allowed actions, or update the scope at app.chatlytics.ai → Bots → Permissions. |
| `403 bot_action_not_dispatchable` from `chatlytics_dispatch` | Bot tokens are confined to a dispatchable-actions allowlist on `/api/v1/actions` — admin/destructive verbs are operator-only | Use the operator api_key path for admin operations, or stay within the dispatchable set (`chatlytics_actions` lists the catalog). |
| `403 bot_send_via_dispatch_denied` | Tried `chatlytics_dispatch(action: "send")` with a bot token — send-class verbs are denied on the generic dispatcher | Use `chatlytics_send` — it targets the gated `POST /api/v1/send` route. |
| `chatlytics_poll requires CHATLYTICS_BOT_TOKEN` | Long-poll inbound is bot-scoped; the legacy api_key can't drive it | Provision a bot token and add `CHATLYTICS_BOT_TOKEN`; restart Claude Code. Same applies to `chatlytics_configure`. |
| HTTP 400 from `chatlytics_poll` | Usually `invalid_cursor` (e.g. after a token rotation) | Drop the cursor and re-poll with no `cursor` (fresh start). |
| HTTP 400 "...session..." from `chatlytics_send` (api_key mode) | `/api/v1/send` requires a session; the legacy dispatcher used to default it server-side | Set `CHATLYTICS_SESSION` (or pass `session` per call). Bot tokens are unaffected — the server pins the bot's own session. |
| Requests **time out** (~10–30s, `AbortError`) | `CHATLYTICS_API_URL` points at a dead/unroutable IP (classic: a stale Tailscale IP — TCP half-connects, HTTP hangs) | Switch to the DNS URL `https://node.chatlytics.ai`, or your LAN URL if on-prem. Re-run `node scripts/install.mjs --url <new-url>`. |
| **Connection refused** (instant) | Wrong host or port — nothing listens there | Hosted default is `https://node.chatlytics.ai`, no port in the URL (Cloudflare proxies 443). |
| **HTTP 502**, especially during `chatlytics_poll` | Cloudflare tunnel concurrent long-poll limit (~4 concurrent long-polls per tunnel) | On-prem consumers should use the LAN URL instead of `node.chatlytics.ai`; keep remote long-poll consumers few. |
| `⚠️ webhook_registered is not true` from `chatlytics_login` | WhatsApp session disconnected or never paired | app.chatlytics.ai → Sessions → re-scan the QR code from WhatsApp on your phone. |
| `No WhatsApp contact, group, or channel found matching "X"` | Name resolution found nothing | Ask Claude to `chatlytics_search` for it — search is fuzzier than the send/read resolver. |
| `Multiple matches for "X"` | Ambiguous name | The error lists up to 10 candidates with JIDs — retry with the exact JID. |
| Tools missing after install / `claude mcp add` | Mid-session MCP installs do **not** surface tools until the session restarts | Restart the Claude Code session, then verify with `chatlytics_login`. |
| MCP server gone after a plugin update | The plugin cache is version-pinned and wiped on every update; absolute-path registrations into the cache die with it | Use the scripted user-scope install (`node scripts/install.mjs`) — it copies the bundle to the stable path `~/.chatlytics/mcp/chatlytics-mcp.mjs`, outside any cache. Idempotent; re-run after updates. |
| `Cannot use import statement outside a module` | A copy of the bundle was renamed `.js` and placed where no `"type":"module"` package.json applies | Keep the `.mjs` extension (v2.2.0+ ships `chatlytics-mcp.bundle.mjs` precisely so it loads from any path). |
| `session not found` from the API | `CHATLYTICS_SESSION` doesn't match a real session ID | Copy the exact session ID from app.chatlytics.ai → Sessions. |

## Reading the server's startup log

The MCP server logs to stderr at boot (visible in Claude Code's MCP logs):

- `Auth mode: bot_token` / `api_key` — which credential was picked up. A
  warning appears instead when neither is set.
- `Bot identity: <name> (fp=<8-char>)` — bot-token verification succeeded
  (`GET /api/v1/bot/me`). A 401/403 here logs a rotate-token instruction but
  does **not** kill the server — run `chatlytics_login` to confirm.
- `Filtered tool catalog: N/10 tools allowed (...)` — the bot's
  `permission_scope` trimmed the tool list via `GET /api/v1/bot/me/tools`.
  If that endpoint is down you'll see a fail-open warning and all 10 tools.

The raw token never appears in any log line — only the 8-char fingerprint
(INV-02).

## Standalone smoke test

From a checked-out repo:

```bash
cd servers
npm test
```

Runs 15 bundle-behavior assertions against a local mock server (no
credentials needed). Additionally, when **both** `CHATLYTICS_API_URL` and
`CHATLYTICS_API_KEY` are set, it first runs a live check: `GET /health` with
the bearer, asserting `webhook_registered: true`. The live phase is skipped
otherwise (it does not read `CHATLYTICS_BOT_TOKEN`). Exits 0 on success.
