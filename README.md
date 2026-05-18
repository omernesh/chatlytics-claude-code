# Chatlytics Plugin for Claude Code

> **The fastest path from `claude plugin install` to your first WhatsApp message.**

WhatsApp messaging superpowers for your Claude Code agent — send to anyone, read any chat, search the directory, dispatch arbitrary Chatlytics actions. Backed by the [Chatlytics](https://chatlytics.ai) REST API. **Zero setup beyond two env vars. Self-contained 715 KB bundle. No `npm install` required.**

[![npm](https://img.shields.io/npm/v/@chatlytics/claude-code.svg)](https://www.npmjs.com/package/@chatlytics/claude-code) [![Node](https://img.shields.io/node/v/@chatlytics/claude-code.svg)](https://www.npmjs.com/package/@chatlytics/claude-code) [![License](https://img.shields.io/npm/l/@chatlytics/claude-code.svg)](LICENSE)

The plugin ships:

- **8 MCP tools** — `chatlytics_send`, `chatlytics_read`, `chatlytics_search`,
  `chatlytics_directory`, `chatlytics_actions`, `chatlytics_health`,
  `chatlytics_login`, `chatlytics_dispatch`.
- **A skill** that teaches Claude Code *when* and *how* to use WhatsApp —
  disambiguation patterns, name resolution, error handling, dispatch
  composition.

## Why chatlytics-claude-code?

- **Name-first, JID-second** — say "send hello to Joe" or "read the marketing
  channel"; the plugin resolves names through the Chatlytics directory before
  sending. Ambiguous names return a picker error with candidates so the agent
  can prompt the user to disambiguate.
- **Self-contained bundle** — single ~715 KB ESM file (esbuild). No
  `npm install` for end users; the bundle ships every dependency inline.
- **Strict JID validation** — matches the Python sibling's regex
  (`/@(c\.us|g\.us|lid|newsletter)$/i`); ambiguous chat-id strings (bare
  phone numbers, display names) never reach the gateway. Pair with
  `chatlytics_search` for human-readable input.
- **Dispatch escape hatch** — `chatlytics_dispatch` exposes any Chatlytics
  REST action by name, so the plugin is never the bottleneck when a new
  Chatlytics capability ships.
- **Cross-stack parity** — same contract as the Python
  [chatlytics-hermes](https://pypi.org/project/chatlytics-hermes/) plugin
  (v3.0+). Build agents in either runtime; the surface stays consistent.

> **New here? Read [QUICKSTART.md](./QUICKSTART.md) — first WhatsApp message from Claude Code in under 5 minutes.**

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

Set these environment variables in your Claude Code settings
(`.claude/settings.json` `env` block, or your shell):

```
CHATLYTICS_API_URL=https://app.chatlytics.ai
CHATLYTICS_API_KEY=your-api-key
CHATLYTICS_SESSION=your-session-id   # optional
```

The plugin's `.mcp.json` declares these three vars and Claude Code passes
them through to the MCP server stdio process.

## Verify install

Easiest path: in any Claude Code session, ask:

> use `chatlytics_login` to test my connection

You should get back `✅ Connected to ${URL}. Webhook registered. Sessions: N.`
or a clear error explaining what to fix.

Alternative — run the standalone smoke test from a checked-out repo:

```bash
cd servers
CHATLYTICS_API_URL=https://app.chatlytics.ai \
CHATLYTICS_API_KEY=your-api-key \
npm test
```

The test calls `GET ${CHATLYTICS_API_URL}/health` with your bearer token and
asserts that `webhook_registered: true`. Exits 0 on success, 1 on failure
with a clear error.

## Usage

Just ask Claude Code:

- "Send a WhatsApp message to Joe saying hello"
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
