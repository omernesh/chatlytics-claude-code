# Chatlytics Plugin for Claude Code

Give your Claude Code agent WhatsApp messaging superpowers via the
[Chatlytics](https://chatlytics.ai) REST API.

The plugin ships:

- **8 MCP tools** — `chatlytics_send`, `chatlytics_read`, `chatlytics_search`,
  `chatlytics_directory`, `chatlytics_actions`, `chatlytics_health`,
  `chatlytics_login`, `chatlytics_dispatch`.
- **A skill** that teaches Claude Code when and how to use WhatsApp.

> **New here? Read [QUICKSTART.md](./QUICKSTART.md) — first WhatsApp message from Claude Code in under 5 minutes.**

## Install

The simplest path is via Claude Code's plugin manager:

```bash
claude plugin install github:omernesh/chatlytics-claude-code
```

That fetches the manifest, MCP server, and skill into your Claude Code plugin
directory and runs `npm install` for the MCP server (via the plugin's
`postinstall` hook).

### Local / development install

If you've cloned this repo manually:

```bash
git clone https://github.com/omernesh/chatlytics-claude-code.git
cd chatlytics-claude-code
npm install        # installs servers/ deps via the postinstall hook
claude plugin install .
```

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

Run the bundled smoke test against your Chatlytics instance:

```bash
cd servers
CHATLYTICS_API_URL=https://app.chatlytics.ai \
CHATLYTICS_API_KEY=your-api-key \
npm test
```

The test calls `GET ${CHATLYTICS_API_URL}/health` with your bearer token and
asserts that `webhook_registered: true`. Exits 0 on success, 1 on failure
with a clear error.

You can also exercise it from inside Claude Code by asking it to use the
`chatlytics_health` tool.

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
