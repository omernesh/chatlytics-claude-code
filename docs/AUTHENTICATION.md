# Authentication (v2.2.0)

## Credential precedence

The MCP server resolves its bearer credential from the environment in this
order:

1. **`CHATLYTICS_BOT_TOKEN`** (preferred, v4.0+) — a per-bot `sk_bot_*`
   token. Identifies the **bot** to the server and is scoped to that bot's
   `permission_scope`. Required for `chatlytics_poll` and
   `chatlytics_configure`.
2. **`CHATLYTICS_API_KEY`** (legacy v3.37 fallback) — the shared
   operator/admin bearer. Still works for the 8 v3.37 tools, but cannot drive
   the bot-scoped endpoints (long-poll inbound, bot self-config).

Whichever variable supplies the value, every request goes out as a single
header: `Authorization: Bearer <value>`. There is no `X-Api-Key` header —
if you see 401s with an otherwise-correct token, check that nothing in your
stack is rewriting the auth header.

If **neither** variable is set, the server boots in `none` mode: data tools
return a get-a-token onboarding prompt instead of a raw 401, and
`chatlytics_health` / `chatlytics_login` remain usable for diagnostics.

## Where the credential lives

Set the env vars in your Claude Code settings `env` block — the plugin's
`.mcp.json` declares all four `CHATLYTICS_*` vars with `${VAR}` interpolation,
so Claude Code substitutes your settings values when spawning the MCP server:

- Per-project: `.claude/settings.json`
- Global: `~/.claude/settings.json` (`%USERPROFILE%\.claude\settings.json` on
  Windows)

```json
{
  "env": {
    "CHATLYTICS_BOT_TOKEN": "sk_bot_paste-your-token-here"
  }
}
```

`CHATLYTICS_API_URL` is optional (default `https://node.chatlytics.ai`).
`CHATLYTICS_SESSION` is **not injected by the plugin** — the `.mcp.json`
env block does not include it (removed in v2.4.1 to prevent a placeholder
leak). Bot-token users never need it (the server pins the session to the
bot's own). Legacy api_key users who need it should set it manually in their
settings `env` block.

Alternatively, the scripted user-scope install
(`node scripts/install.mjs --token sk_bot_...`) bakes the env vars into the
`claude mcp add -s user` registration, so no settings edit is needed.

**Restart Claude Code after changing any of these** — MCP servers only read
env at spawn time, and mid-session changes don't surface until the session
restarts.

## Getting a bot token

Sign in at https://app.chatlytics.ai → **Bots → Create Bot**, pick the
WhatsApp session it should ride, and copy the `sk_bot_*` token. The plaintext
appears **once** (on create, and once more on rotate) — everywhere else only
an 8-char fingerprint is shown (INV-02). After a rotation the old token has a
24h grace window.

## Boot-time identity verification

In bot-token mode the server performs two startup calls:

1. `GET /api/v1/bot/me/tools` — fetches the bot's filtered tool catalog and
   registers only the allowed tools. **Fail-open:** if the endpoint is
   unreachable or malformed, all 10 tools register (the server-side scope
   check at dispatch time is the real security boundary, so a wide catalog
   can't grant extra capability).
2. `GET /api/v1/bot/me` — verifies the token and logs the resolved identity
   to stderr: `Bot identity: <display_name> (fp=<8-char>)`. On 401/403 it
   logs an actionable rotate-token message; on transport errors or 5xx it
   warns and continues. The server **never exits non-zero** over an identity
   failure (Claude Code quarantines servers that do), so a bad token still
   boots — use `chatlytics_login` to surface the failure.

In both paths the raw token is never logged — only the server-supplied
fingerprint. A smoke-test assertion regression-checks this.

## Authorization scoping (what a bot token can and can't do)

- **Text sends** go through the gated `POST /api/v1/send` for **all** auth
  modes. That route runs the outbound gates (bot pairing + session pin); for
  bot tokens the server pins the session to the bot's own.
- **Generic dispatch** (`chatlytics_dispatch` → `POST /api/v1/actions`)
  confines bot tokens to a server-side **dispatchable-actions allowlist** —
  no admin or destructive verbs (`403 bot_action_not_dispatchable`), and no
  send-class verbs on this route (`403 bot_send_via_dispatch_denied`; use
  `chatlytics_send`). Per-verb `actions_denied` in the bot's
  `permission_scope` applies on top.
- **Bot-scoped endpoints** (`/api/v1/bot/updates`, `PATCH /api/v1/bot/me`)
  accept only `sk_bot_*` bearers — the legacy api_key 401s there, and the
  plugin short-circuits client-side with a migration message.
- The legacy `CHATLYTICS_API_KEY` is a full-access operator bearer and is not
  subject to the bot allowlist. New installs should use a bot token.

## Error surfaces

`HTTP 401/403` responses from any tool are rewritten into an actionable
message that names both env vars and points at
https://app.chatlytics.ai — see
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for the full failure matrix.
