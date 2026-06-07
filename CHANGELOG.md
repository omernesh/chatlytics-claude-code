# Changelog

> Versioned independently from the parent Chatlytics monorepo (currently
> v3.30.0). The plugin tracks the **Chatlytics REST API contract**, not the
> monorepo version.

All notable changes to the Chatlytics Claude Code plugin are documented here.

## [2.1.2] — 2026-06-07

### Added

- **First-use onboarding: data tools now return a clear get-a-token prompt
  (Web UI + CLI routes) when no `CHATLYTICS_BOT_TOKEN` is set, instead of a
  confusing 401.** When `AUTH_MODE === "none"`, `chatlytics_send`,
  `chatlytics_dispatch`, `chatlytics_read`, `chatlytics_search`,
  `chatlytics_poll`, `chatlytics_actions`, and `chatlytics_directory`
  short-circuit with a relayable prompt telling the user a bot token is
  required and how to get one (sign in → Bots → Create Bot, or
  `chatlytics bots create`). `chatlytics_health` (diagnostics) and
  `chatlytics_login` (recheck surface) are intentionally not guarded.

### Fixed

- **Stale `Settings → API Keys` wording → `Bots → Create Bot`.** The
  `chatlytics_login` no-token branch wrongly pointed users at the old
  API-Keys settings page; it now uses the shared onboarding prompt.

## 2.1.1 — 2026-06-06

### Fixed

- **`chatlytics_send` routes bot-token callers through the gated
  `POST /api/v1/send`.** Server v4.5.4 denies send-class verbs on the generic
  `POST /api/v1/actions` dispatcher for bot tokens (`sk_bot_*`) so that pairing
  (`checkBotPairing`) + session-pin gates always run (INV-09) — a bot dispatching
  `{action:"send"}` now gets `403 bot_send_via_dispatch_denied`. When
  `AUTH_MODE === "bot_token"`, `chatlytics_send` resolves the recipient name to a
  JID (mirrors `chatlytics_read`) and posts `{chatId, text}` to `/api/v1/send`;
  the server pins the session to the bot's own. Operator `CHATLYTICS_API_KEY`
  callers keep the legacy `/api/v1/actions` path (server-side session default) to
  avoid a 400 regression when no session is configured. Bundle rebuilt.

### Known limitations

- Richer sends (poll/list/media) via `chatlytics_dispatch` remain operator-only
  for now — bot tokens get `403 bot_action_not_dispatchable` until a gated
  dispatch path lands. Use `chatlytics_send` for text.

## 2.1.0 — 2026-06-05

### Changed

- **Default base URL is now `https://node.chatlytics.ai`** (Cloudflare-proxied
  tunnel → hpg5:8050). Token-only onboarding: a user only sets
  `CHATLYTICS_BOT_TOKEN` — no URL, username, or password. `CHATLYTICS_BASE_URL`
  stays an optional override.

## 2.0.0 — 2026-05-28 (v4.0 CC-PLUGIN-V2 — Phase 337)

### Added

- **Telegram-style "paste your bot token" onboarding.** Plugin reads
  `CHATLYTICS_BOT_TOKEN` (`sk_bot_*`), verifies at boot via
  `GET /api/v1/bot/me`, logs identity (`display_name` + 8-char fingerprint,
  never plaintext — INV-02).
- **`chatlytics_poll` MCP tool.** Drives the v4.0 long-poll endpoint
  (`GET /api/v1/bot/updates` + `POST /api/v1/bot/updates/ack`) — agents can
  receive inbound WhatsApp messages without exposing an HTTP webhook URL.
  Bot-token mode only (P335 endpoint is bot-bearer-scoped).
- **`.mcp.json` declares `CHATLYTICS_BOT_TOKEN`** alongside the existing 3 env
  vars (back-compat: `CHATLYTICS_API_KEY` still passed through).
- **5 new bundle-behavior smoke assertions** in `servers/test/smoke.js`:
  bot identity log + INV-02 regression, fail-open on `/bot/me` outage,
  poll envelope passthrough, ack ordering (POST /ack BEFORE GET /updates),
  and api_key-mode rejection of `chatlytics_poll`.

### Changed

- README + QUICKSTART rewritten with Telegram-style framing. Lead env var
  is `CHATLYTICS_BOT_TOKEN`; `CHATLYTICS_API_KEY` documented as legacy v3.37
  fallback (not removed — back-compat).
- SKILL.md gains an "Authentication" section and an "Inbound: long-poll
  mode" section.
- MCP server version `1.2.1` → `2.0.0` (preserves the 1.2.1 marketing-flair
  release in between).
- Tool count `8 → 9` (added `chatlytics_poll`).
- Pre-existing fail-OPEN smoke now asserts 9 registered tools instead of 8.

### Compatibility

- Back-compat with v1.x: existing `CHATLYTICS_API_KEY` users continue to
  function for all 8 v3.37 tools. The new `chatlytics_poll` tool returns
  a clear migration error when called in api_key mode.
- Server-side dependency: requires chatlytics v3.37+ for `/api/v1/bot/me`
  + `/api/v1/bot/me/tools` (P333/P334) and v4.0 (P335) for the long-poll
  endpoints (`/api/v1/bot/updates(/ack)`).

## [1.2.1] - 2026-05-18

Cosmetic release — no functional changes, no API surface changes.
`npm install @chatlytics/claude-code@1.2.0` and `@1.2.1` are behaviourally
identical. The bump exists solely so the marketing-flair description and
README tagline land on the npm registry page (npm bakes the description
into the published artifact and refuses re-uploads of the same version).

### Changed

- **Package description** (`package.json`) sharpened to "WhatsApp
  messaging superpowers for Claude Code — 8 MCP tools + a teaching skill,
  name-resolved sends, full directory access, via the Chatlytics REST API"
- **README opening** rewritten with a bold superlative tagline, shields.io
  badges (npm version, Node compat, license), and "Why
  chatlytics-claude-code?" section with bold-led bullets. Inspired by the
  positioning style of the deprecated `waha-openclaw-channel` npm package.
- **Example contact name** in README Usage section: `Omer` → `Joe`
  (more international).
- **Bundle metadata** — `servers/chatlytics-mcp.js` MCP server version
  literal bumped to match the package version; bundle rebuilt.

### Preserved (all from 1.2.0)

- 8 MCP tools (unchanged)
- `looksLikeJid` regex `/@(c\.us|g\.us|lid|newsletter)$/i` (unchanged)
- `chatlytics_send` resolveChatId integration from 1.2.0 (unchanged)
- 715 KB self-contained ESM bundle (rebuilt with new version literal)

## 1.2.0 — 2026-05-18

### Coordination

- Bundle aligned with **chatlytics-hermes 3.0.0** on PyPI
  (https://pypi.org/project/chatlytics-hermes/3.0.0/), the first
  public PyPI publish of the sibling Python Hermes plugin. The JS
  bundle and the Python plugin now share the same JID-handling
  contract end-to-end.

### Fixed

- **`chatlytics_send` was bypassing `resolveChatId()`** — a drift
  bug carried over from `1.0.0`. The handler now mirrors
  `chatlytics_read`: bare names and phone numbers are resolved
  to a JID via the `search` action before the API call. Existing
  JID-passing callers are unaffected (the resolver short-circuits
  on JID input). Ambiguous names return the same actionable
  picker error the `chatlytics_read` tool returns.

### Verified

- **`looksLikeJid()` regex** (`/@(c\.us|g\.us|lid|newsletter)$/i`)
  confirmed identical to chatlytics-hermes 3.0.0's Phase 14
  canonical JID rule (`_JID_PATTERN = r"^.+@(c\.us|g\.us|lid|newsletter)$"`
  in `src/chatlytics_hermes/tools.py`). Phone numbers and display
  names are rejected at JID-detection time in BOTH plugins, ensuring
  uniform behavior across the Python Hermes plugin and the JS MCP
  bundle. No code change — alignment was already in place since
  `1.1.0`; this entry documents the cross-repo invariant for the
  record.

### Internal

- Esbuild bundle regenerated (`servers/chatlytics-mcp.bundle.js`,
  714.4 KB).
- Version constants aligned across `package.json` (root),
  `servers/package.json`, and the `McpServer` constructor literal
  in `servers/chatlytics-mcp.js`. Drift between `1.1.0` in
  `package.json` and `1.1.2` in the CHANGELOG (artifact of the
  hotfix commits in `1.1.1` / `1.1.2` not bumping `package.json`)
  is reconciled by jumping straight to `1.2.0` everywhere.
- **8 tools registered** (no change from `1.1.x`):
  `chatlytics_send`, `chatlytics_read`, `chatlytics_search`,
  `chatlytics_actions`, `chatlytics_directory`,
  `chatlytics_health`, `chatlytics_login`, `chatlytics_dispatch`.

### Out of scope (Phase 21)

- npm publish (`@chatlytics/claude-code` first-ever publish)
- `"private": true` → `false` flip
- Package rename to scoped `@chatlytics/claude-code`
- `"files":` allowlist + `.npmignore`
- `v1.2.0` git tag

## 1.1.2 — 2026-05-15

### Fixed (real-user E2E install testing — second pass)

- **`.mcp.json` env block hardcoded empty strings**, which OVERRODE the user's
  values from `~/.claude/settings.json`. Symptom: after configuring the 3
  CHATLYTICS_* env vars and running `/reload-plugins`, `chatlytics_login`
  still reported `❌ CHATLYTICS_API_KEY is not set`. Root cause: Claude Code
  passes the `env` block from `.mcp.json` to the spawned MCP child process
  verbatim. Empty-string values overwrite parent-process env vars at spawn.
  Fix: switched to `${VAR}` interpolation so Claude Code substitutes the
  user's settings.json values at server-spawn time.

After upgrading to 1.1.2, users may need to fully restart Claude Code (not
just `/reload-plugins`) so the MCP server child process re-spawns with the
corrected env interpolation.

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
