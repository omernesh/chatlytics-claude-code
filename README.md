# Chatlytics Plugin for Claude Code

> **Like a Telegram bot, but for your WhatsApp.** Paste a bot token,
> get a WhatsApp-driven agent.

Give your Claude Code agent WhatsApp messaging superpowers via the
[Chatlytics](https://chatlytics.ai) REST API.

The plugin ships:

- **9 MCP tools** — `chatlytics_send`, `chatlytics_read`, `chatlytics_search`,
  `chatlytics_directory`, `chatlytics_actions`, `chatlytics_health`,
  `chatlytics_login`, `chatlytics_dispatch`, `chatlytics_poll`.
- **A skill** that teaches Claude Code when and how to use WhatsApp.

> **New here? Read [QUICKSTART.md](./QUICKSTART.md) — first WhatsApp message from Claude Code in under 5 minutes.**

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
(`servers/chatlytics-mcp.bundle.js`, ~715KB) plus the skill. **No `npm install`
needed** — the bundle ships all dependencies inline.

### Local / development install

If you're working on the plugin itself:

```bash
git clone https://github.com/omernesh/chatlytics-claude-code.git
cd chatlytics-claude-code
cd servers && npm install && npm run build   # rebuild bundle after source edits
```

The `build` script (esbuild) re-bundles `chatlytics-mcp.js` → `chatlytics-mcp.bundle.js`.
The bundle is the file Claude Code actually runs; ship it on every release.

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
# CHATLYTICS_SESSION=your-session-id              # optional
# CHATLYTICS_API_KEY=your-api-key                 # legacy v3.37 fallback (see note)
```

The plugin's `.mcp.json` declares all four vars and Claude Code passes
them through to the MCP server stdio process.

**Note on `CHATLYTICS_API_KEY`:** v3.37 operators using the shared admin
api_key bearer can keep using it — the plugin falls back to it when
`CHATLYTICS_BOT_TOKEN` is unset. The legacy path stays back-compat for the
8 v3.37 tools but cannot drive `chatlytics_poll` (which is bot-bearer
scoped on the server side). New installs should use `CHATLYTICS_BOT_TOKEN`.

## Verify install

Easiest path: in any Claude Code session, ask:

> use `chatlytics_login` to test my connection

You should get back `✅ Connected to ${URL}. Webhook registered. Sessions: N.`
or a clear error explaining what to fix.

Alternative — run the standalone smoke test from a checked-out repo:

```bash
cd servers
CHATLYTICS_BOT_TOKEN=sk_bot_your-bot-token \
npm test
```

`CHATLYTICS_API_URL` is optional and defaults to `https://node.chatlytics.ai`;
override it inline only if you self-host.

The test calls `GET ${CHATLYTICS_API_URL}/health` with your bearer token and
asserts that `webhook_registered: true`. Exits 0 on success, 1 on failure
with a clear error.

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
