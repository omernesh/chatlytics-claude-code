# Changelog

> Versioned independently from the parent Chatlytics monorepo (currently
> v3.30.0). The plugin tracks the **Chatlytics REST API contract**, not the
> monorepo version.

All notable changes to the Chatlytics Claude Code plugin are documented here.

## 1.1.1 — 2026-05-14

### Fixed (E2E install-test findings)

- **`.claude-plugin/marketplace.json` was missing.** Without it,
  `claude plugin marketplace add` fails with "Marketplace file not found".
  Added single-plugin marketplace manifest pointing at `./` (self-marketplace
  pattern like `n8n-mcp-skills`). Install flow now:
  `claude plugin marketplace add omernesh/chatlytics-claude-code` →
  `claude plugin install chatlytics@chatlytics-claude-code`.
- **`repository` field was an object, not a string.** Claude Code's plugin
  validator rejected `{type, url}` shape. Flattened to a single URL string.
- **MCP server failed to start after install** because `claude plugin install`
  does not run `npm install`. Replaced the post-install dependency-fetch
  pattern with a **single bundled MCP server** (`servers/chatlytics-mcp.bundle.js`,
  ~715KB) produced via esbuild. Beta users now install + run with zero
  `npm install` steps. The `npm install` story remains for plugin developers
  rebuilding the bundle (`npm run build`).
- README + QUICKSTART updated with the correct two-step install commands.

## 1.1.0 — 2026-05-14

First public release as a dedicated repo (`omernesh/chatlytics-claude-code`),
split out from the Chatlytics monorepo with full git history preserved.

### Added

- **Manifest fields**: `license` (MIT), `homepage`, and `repository` added
  to `.claude-plugin/plugin.json` so Claude Code's plugin manager can render
  proper install metadata. (CC-P1)
- **Top-level `package.json`** with a `postinstall` hook that runs
  `npm install` inside `servers/`, so a fresh clone or `claude plugin install`
  ends up with usable `node_modules/`. Also exposes `npm test` and
  `npm run setup` shortcuts. (CC-P4)
- **Smoke test** at `servers/test/smoke.js` (`npm test`) that asserts
  `GET /health` returns `webhook_registered: true` with the configured
  bearer token. Documented in the README's "Verify install" section. (CC-P5)
- **Name-resolution path in `chatlytics_read`**: input that doesn't look
  like a JID (no `@c.us` / `@g.us` / `@lid` / `@newsletter` suffix) is
  pre-resolved via the `search` action. Multiple matches return an
  actionable picker error; zero matches return a clear "not found"
  error. Tool description updated to match the new behavior. (CC-P6)
- **CHANGELOG** and version-coupling note (this file). (CC-P7)

### Changed

- **Repo split**: the plugin lives in its own repo at
  `omernesh/chatlytics-claude-code`. Beta install path is now
  `claude plugin install github:omernesh/chatlytics-claude-code`. The
  monorepo's onboarding doc (`docs/onboarding/claude-code.md`) was rewritten
  to reflect the new repo URL and the actual 6-tool surface (the previous
  doc advertised 7 tools that didn't exist + a bogus `npx chatlytics-mcp`
  snippet). (CC-P2, CC-P3)
- Bumped MCP server `name` -> `chatlytics`, `version` -> `1.1.0` in
  `servers/chatlytics-mcp.js` and `servers/package.json` to match the
  plugin manifest.

## 1.0.0 — 2026-04-23

Initial cut of the plugin inside the Chatlytics monorepo
(`waha-oc-plugin/chatlytics-plugin/`). Phases 154-158 in
`.planning/milestones/v3.13-phases/` covered scoping, MCP server
implementation, skill authoring, and onboarding integration.

### Added

- MCP server (`servers/chatlytics-mcp.js`) with 6 tools backed by the
  Chatlytics REST API: `chatlytics_send`, `chatlytics_read`,
  `chatlytics_search`, `chatlytics_directory`, `chatlytics_actions`,
  `chatlytics_health`.
- Skill at `skills/chatlytics/SKILL.md` covering trigger phrasing, message
  formatting (no markdown, WhatsApp's `*bold*` / `_italic_`), and best
  practices.
- `.claude-plugin/plugin.json` manifest and `.mcp.json` registration with
  `CHATLYTICS_API_URL` / `CHATLYTICS_API_KEY` / `CHATLYTICS_SESSION`
  passthrough.
- README with quick-start install + configure + usage examples.
