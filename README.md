# Chatlytics Plugin for Claude Code

> **Like a Telegram bot, but for your WhatsApp.** Paste a bot token,
> get a WhatsApp-driven agent.

Give your Claude Code agent WhatsApp messaging superpowers via the
[Chatlytics](https://chatlytics.ai) REST API.

The plugin ships:

- **10 MCP tools** — `chatlytics_send`, `chatlytics_read`, `chatlytics_search`,
  `chatlytics_directory`, `chatlytics_actions`, `chatlytics_health`,
  `chatlytics_login`, `chatlytics_dispatch`, `chatlytics_poll`,
  `chatlytics_configure`.
- **A skill** that teaches Claude Code when and how to use WhatsApp.
- **WhatsApp inbox** — passive inbound delivery via a background long-poll
  daemon + 4 companion skills (`/whatsapp`, `/reply-whatsapp`, `/send-whatsapp`,
  `/react-whatsapp`) + two Claude Code hooks (SessionStart launcher,
  UserPromptSubmit injector).

> **New here? Read [QUICKSTART.md](./QUICKSTART.md) — first WhatsApp message from Claude Code in under 5 minutes.**

**Docs:** [Tool reference](./docs/TOOLS.md) ·
[Authentication & scoping](./docs/AUTHENTICATION.md) ·
[Troubleshooting](./docs/TROUBLESHOOTING.md)

## What's new in v2.5.0 — WhatsApp inbox

Installing the plugin now auto-starts a **background long-poll daemon** (singleton,
~1 req/min idle) that surfaces inbound WhatsApp messages passively into any Claude
Code session — no manual polling, no slash command needed.

- **SessionStart hook** — runs `daemon/ensure-daemon.mjs` at session launch. It
  probes port 7656; if the daemon is not running it spawns `daemon/daemon.mjs`
  as a detached background process. One daemon per machine, shared across sessions.
- **UserPromptSubmit hook** — runs `daemon/inject-hook.mjs` on every prompt. It
  reads any new lines from `~/.claude/whatsapp-cc/inbox.jsonl` and prepends them
  as `additionalContext` so incoming messages appear above your prompt text.
  Fail-open: a missing spool file or empty inbox is a silent no-op.
- **4 companion skills** auto-discovered from `skills/`:
  - `/whatsapp` — manual inbox review + daemon status
  - `/reply-whatsapp` — reply to a contact by name or to the last message
  - `/send-whatsapp` — start a new outbound conversation
  - `/react-whatsapp` — add an emoji reaction to a message
- **Data lives in `~/.claude/whatsapp-cc/`** (inbox.jsonl, state.json, cursor.json,
  read-state.json). Scripts ship inside the plugin; data stays in your home dir.
- **Requires `CHATLYTICS_BOT_TOKEN`** — same token you already set for the MCP tools.
  The daemon uses the bot's long-poll endpoint (`GET /api/v1/bot/updates`).
- **Edit display** — the inject-hook uses replace-in-place for cross-turn edits
  (placeholder suppressed; edits appear inline). New messages arrive as a new
  context block on the next prompt.

## What's new in v2.2.0

- **Bundle ships as `.mjs`** (`servers/chatlytics-mcp.bundle.mjs`) — the old
  `.js`→`.mjs` rename step is dead. The bundle now loads from any path, with
  or without a colocated `package.json`.
- **Scripted user-scope install** (`scripts/install.mjs`) — copies the bundle
  to a stable path outside the version-pinned plugin cache and registers it
  via `claude mcp add -s user`. Survives plugin updates; idempotent.
- **`chatlytics_configure`** (v2.1.x line) — bot self-config via
  `PATCH /api/v1/bot/me`. Tool count is now **10**.
- **Unified send path** — `chatlytics_send` posts to the gated
  `POST /api/v1/send` for all auth modes (see
  [Authentication & scoping](./docs/AUTHENTICATION.md)).

## What's new in v2.0 (Phase 337 — CC-PLUGIN-V2)

- **Telegram-style "paste your bot token" onboarding.** The plugin now reads
  `CHATLYTICS_BOT_TOKEN` (`sk_bot_*`), verifies the token at startup via
  `GET /api/v1/bot/me`, and logs the resolved bot identity (`display_name`
  + 8-char fingerprint — INV-02, plaintext never leaves the operator
  machine).
- **`chatlytics_poll` MCP tool** drives the v4.0 long-poll endpoint
  (`GET /api/v1/bot/updates` + `POST /api/v1/bot/updates/ack`). Agents can
  receive WhatsApp messages addressed to the bot without exposing a public
  webhook URL.
- **Fail-open on transient outage.** Both `/bot/me/tools` (catalog filter)
  and `/bot/me` (identity verify) degrade gracefully — server outage during
  Claude Code startup widens the tool catalog but never blocks boot.
- **`.mcp.json` propagates `CHATLYTICS_BOT_TOKEN`** in addition to the
  legacy 3 env vars. Back-compat: `CHATLYTICS_API_KEY` continues to work.
- **5 new bundle-behavior smoke assertions** covering identity log, fail-open,
  poll querystring, ack ordering, and api_key-mode rejection of `chatlytics_poll`.

## Install

Two-step install via Claude Code's plugin manager:

```bash
claude plugin marketplace add omernesh/chatlytics-claude-code
claude plugin install chatlytics@chatlytics-claude-code
```

That fetches a single self-contained bundled MCP server
(`servers/chatlytics-mcp.bundle.mjs`, ~730KB) plus the skill. **No `npm install`
needed** — the bundle ships all dependencies inline. The `.mjs` extension is
deliberate (v2.2.0+): the bundle is an ES module that now loads from ANY path,
with or without a colocated `package.json`.

### Scripted user-scope install (recommended for operators)

Plugin-cache directories are **version-pinned and wiped on every plugin
update** — anything registered by absolute path into the cache dies on
upgrade. For a durable, plugin-manager-independent install, use the bundled
installer. It copies the server to a stable path
(`~/.chatlytics/mcp/chatlytics-mcp.mjs`) and registers it user-scoped:

```bash
git clone https://github.com/omernesh/chatlytics-claude-code.git
cd chatlytics-claude-code
node scripts/install.mjs --token sk_bot_your-token
```

Options (all prompt-free; env vars work too):

```bash
node scripts/install.mjs \
  --token sk_bot_xxx \                       # or env CHATLYTICS_BOT_TOKEN (preferred)
  --url https://node.chatlytics.ai \         # or env CHATLYTICS_API_URL (this is the default)
  --session your-session-id                  # or env CHATLYTICS_SESSION (optional)
# --api-key <key>                            # legacy CHATLYTICS_API_KEY fallback
# --dry-run                                  # print actions, change nothing
```

The script is **idempotent** — re-run it after a `git pull` (or plugin update)
to refresh the stable copy and re-register. Under the hood it runs:

```bash
claude mcp add -s user chatlytics \
  -e CHATLYTICS_BOT_TOKEN=sk_bot_... \
  -e CHATLYTICS_API_URL=https://node.chatlytics.ai \
  -- node ~/.chatlytics/mcp/chatlytics-mcp.mjs
```

> **Restart required:** mid-session `claude mcp add` installs do NOT surface
> tools until the Claude Code session restarts. Restart, then verify with the
> `chatlytics_login` tool.

**URL guidance:** the default `https://node.chatlytics.ai` (Cloudflare tunnel)
works anywhere. On-prem/LAN operators should prefer the direct LAN URL
(e.g. `http://192.168.1.133:8050`) — it avoids the Cloudflare tunnel's
concurrent long-poll limit (see Troubleshooting).

### Local / development install

If you're working on the plugin itself:

```bash
git clone https://github.com/omernesh/chatlytics-claude-code.git
cd chatlytics-claude-code
cd servers && npm install && npm run build   # rebuild bundle after source edits
```

The `build` script (esbuild) re-bundles `chatlytics-mcp.js` → `chatlytics-mcp.bundle.mjs`.
The bundle is the file Claude Code actually runs; ship it on every release.
Keep the `.mjs` extension — a `.js` copy outside `servers/` (no
`"type":"module"` package.json next to it) crashes Node with
"Cannot use import statement outside a module". The smoke test enforces this
by booting a copy of the bundle from a bare temp dir.

## Setup

Minimal setup is a single env var — your bot token. Set it in your Claude
Code settings (`.claude/settings.json` `env` block, or your shell):

```
CHATLYTICS_BOT_TOKEN=sk_bot_your-bot-token        # the only required var
```

That's it. `CHATLYTICS_API_URL` is **optional** — it defaults to
`https://node.chatlytics.ai` (the hosted Chatlytics API). Override it only
if you self-host or point at a non-default endpoint:

```
# CHATLYTICS_API_URL=https://node.chatlytics.ai   # optional — this is the default
# CHATLYTICS_API_KEY=your-api-key                 # legacy v3.37 fallback (see note)
# CHATLYTICS_SESSION=your-session-id              # legacy api_key only — leave unset for bot tokens
```

The plugin's `.mcp.json` passes `CHATLYTICS_API_URL`, `CHATLYTICS_BOT_TOKEN`,
and `CHATLYTICS_API_KEY` through to the MCP server. `CHATLYTICS_SESSION` is
**not** injected by the plugin (removed in v2.4.1) — bot-token users never
need it (the server pins the session server-side); legacy api_key users should
set it manually in their settings `env` block if needed.

**Note on `CHATLYTICS_API_KEY`:** v3.37 operators using the shared admin
api_key bearer can keep using it — the plugin falls back to it when
`CHATLYTICS_BOT_TOKEN` is unset. The legacy path stays back-compat for the
8 v3.37 tools but cannot drive `chatlytics_poll` or `chatlytics_configure`
(both are bot-bearer scoped on the server side). New installs should use
`CHATLYTICS_BOT_TOKEN`.

**Auth scoping in one paragraph:** all requests carry
`Authorization: Bearer <credential>` (never `X-Api-Key`). Text sends go
through the gated `POST /api/v1/send` for every auth mode; on the generic
`POST /api/v1/actions` dispatcher, bot tokens are confined to a server-side
dispatchable-actions allowlist (no admin/destructive verbs —
`403 bot_action_not_dispatchable`; send-class verbs there return
`403 bot_send_via_dispatch_denied`). Full details:
[docs/AUTHENTICATION.md](./docs/AUTHENTICATION.md).

## Verify install

Easiest path: in any Claude Code session, ask:

> use `chatlytics_login` to test my connection

You should get back

```
✅ Connected to Chatlytics at <URL> (auth mode: bot_token). Webhook registered. Sessions: N.
Bot: <display_name> (fp=<8-char fingerprint>)
Session: <session_id>
Default bot: yes
```

or a clear error explaining what to fix. In bot-token mode the identity block
is fetched fresh from `GET /api/v1/bot/me`; paired entities are listed too
once the server exposes `GET /api/v1/bot/me/pairings` (fail-open until then).

Alternative — run the standalone smoke test from a checked-out repo:

```bash
cd servers
npm test
```

That runs 15 bundle-behavior assertions against a local mock server (no
credentials needed). To also hit a live endpoint, set **both**
`CHATLYTICS_API_URL` and `CHATLYTICS_API_KEY` — the test then calls
`GET ${CHATLYTICS_API_URL}/health` with the bearer and asserts
`webhook_registered: true`. Exits 0 on success, 1 on failure.

## Troubleshooting connection errors

The quick matrix below covers connection failures; the full failure matrix
(auth errors, 403 scope denials, poll cursor errors, plugin-cache wipes) is
in [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md).

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Requests **time out** (~10–30s, `AbortError`) | `CHATLYTICS_API_URL` points at a dead/unroutable IP (classic case: a stale Tailscale IP whose data-plane died — TCP half-connects, HTTP hangs) | Switch to the DNS URL `https://node.chatlytics.ai`, or the LAN URL (e.g. `http://192.168.1.133:8050`) if on-prem. Re-run `node scripts/install.mjs --url <new-url>`. |
| **Connection refused** (instant) | Wrong host or port — something answered routing but nothing listens there | Verify host/port. Hosted default is `https://node.chatlytics.ai` (no port in the URL — Cloudflare proxies 443). |
| **HTTP 401** | Bad/rotated/revoked token | Rotate at app.chatlytics.ai → Bots, copy the new `sk_bot_*`, re-run the install script with `--token`. |
| **HTTP 502** (especially during `chatlytics_poll`) | Cloudflare tunnel concurrent long-poll limit (~4 concurrent long-polls per tunnel) | Use the LAN URL instead of `node.chatlytics.ai` for on-prem consumers; keep remote consumers few. |
| Tools missing after install | Mid-session `claude mcp add` — tools don't surface until restart | Restart the Claude Code session. |

## Usage

Just ask Claude Code:

- "Send a WhatsApp message to Omer saying hello"
- "Read my recent WhatsApp messages from the Team Chat group"
- "Search for the marketing channel"
- "Check if WhatsApp is connected"

`chatlytics_send` and `chatlytics_read` accept either a JID
(`972544329000@c.us`, `120363...@g.us`) or a contact/group name — names are
auto-resolved through the `search` action. Ambiguous names return a picker
error listing the candidates so the agent can prompt the user to disambiguate.

## Versioning

The plugin is versioned independently from the Chatlytics monorepo
(currently v3.30.0). The plugin tracks the **Chatlytics REST API contract**,
not the monorepo version. See [CHANGELOG.md](./CHANGELOG.md) for plugin
release notes.

## License

MIT — see [LICENSE](./LICENSE) (or the `license` field of `.claude-plugin/plugin.json`).
