# Changelog

> Versioned independently from the parent Chatlytics monorepo (currently
> v3.30.0). The plugin tracks the **Chatlytics REST API contract**, not the
> monorepo version.

All notable changes to the Chatlytics Claude Code plugin are documented here.

## [2.7.0] — 2026-06-25

### Changed

- **Real-time inbox re-architected — background poll loop, not a daemon.** Replaced the
  always-on daemon + `UserPromptSubmit` inject-hook with a single **SessionStart** hook
  that starts a background poll loop driven by the session itself. Replies now surface
  **in the conversation in real time** (~2s), as a clean framed line — no waiting for
  your next prompt, and no desktop notification. The old inject-hook lag (a reply only
  appeared on your next keystroke) and the Windows-only toast are both gone.
- **Cross-platform — Windows, macOS, and Linux.** The poller and hook are pure Node
  (`fs`/`path`/`os`/`fetch`), find each other via `import.meta.url`, and keep lock +
  cursor state under `~/.claude/whatsapp-cc/` via `os.homedir()`. No PowerShell, no
  OS-specific APIs.
- **Single-consumer guard.** A heartbeat lock (`listener.lock`) ensures only ONE Claude
  Code session polls the bot queue at a time — open a second session and it detects the
  active listener and stands down, so messages are never split or lost.

### Added

- **Framed inbox messages** — inbound WhatsApp is wrapped in a horizontal-rule frame with
  a 📱 marker so it stands out in the conversation. Still mirrors WhatsApp faithfully
  (every message and edit, in full — the v2.5.2 fidelity guarantee is preserved).
- **Sender-name resolution in the poller** — `@lid` senders resolve to real display names
  (message → `remoteJidAlt` → directory), falling back to the number only when unknown.
- **Queue draining (ack)** — the poller now `POST`s `/api/v1/bot/updates/ack`, so the
  server-side delivery queue drains instead of growing; this also restores true long-poll
  behavior (near-zero latency).

### Removed

- The background daemon (`daemon.mjs`, `ensure-daemon.mjs`) and the `UserPromptSubmit`
  inject-hook (`inject-hook.mjs`) — superseded by the SessionStart poll loop. The v2.6.0
  desktop toast push is removed along with it.

### Security

- The poller reads `CHATLYTICS_BOT_TOKEN` from the environment only — no token is embedded
  in any shipped file.

## [2.6.0] — 2026-06-24

### Added

- **Real-time desktop push on every new inbound.** The background inbox daemon now
  fires a Windows desktop toast the instant a new allow-listed WhatsApp message is
  appended — so you see it even while idle in another window. Title is
  `WhatsApp · <sender>` (`… in <group>` for groups); body is the security-stripped
  text preview (first ~180 chars, newlines collapsed). Fully **fail-open**: spawned
  as a detached PowerShell process that never blocks or crashes the poll loop, with a
  three-tier fallback — BurntToast → WinRT toast → `NotifyIcon` balloon. Untrusted
  message text is passed via `-EncodedCommand` + environment variables so it can never
  break quoting or execute. Anti-spam: the startup backlog flush is suppressed, and a
  batch of more than 5 new messages collapses to one `N new WhatsApp messages` summary
  toast. Configurable in `~/.claude/whatsapp-cc/config.json` via
  `{"notify":{"enabled":true,"ntfyUrl":null}}` — set `enabled:false` to silence toasts,
  or set `ntfyUrl` to also best-effort POST the title+body to an ntfy endpoint.
- **`/list-allowlist`** — show the bot's access-policy allow-list (DM + group buckets)
  from inside Claude Code, resolving each JID to a display name via the chatlytics MCP.
  Read-only. Part of the `whatsapp` inbox family.
- **`/remove-from-allowlist <contact-or-group> [dm|group]`** — remove a contact or group
  from the bot's allow-list (the inverse of `/add-to-allowlist`), with read-merge-write,
  scope inference from the JID suffix, not-present detection (never PATCHes a no-op), and
  a post-write re-GET confirmation. Part of the `whatsapp` inbox family.

## [2.5.2] — 2026-06-24

### Fixed

- **Inbox now mirrors WhatsApp faithfully — every message, in full.** The
  inject-hook no longer burst-collapses runs of messages or truncates them to
  300 chars, and it no longer suppresses "⏳ working…" placeholders. Each inbox
  line renders as its own `whatsapp message from <name>: <full text>` (edits as
  `… (edited): …`). The point of an allow-list inbox is to see everything an
  allow-listed contact/group sends; collapsing/truncating defeated that. A
  generous 8000-char safety bound remains (real messages never hit it). Security
  wrapper, muting, lockfile, and fail-open behavior are unchanged.

## [2.5.1] — 2026-06-24

### Changed

- **`/send-whatsapp` is now fire-and-forget.** The skill sends once via
  `chatlytics_send({ to, text })` (no `session` — the bot token pins it
  server-side), confirms with a single `✅ Sent to <name>: "<message>"` line,
  and **stops**. It explicitly must NOT call `chatlytics_poll` or wait for the
  reply: the reply arrives passively via the background inbox daemon. (Polling
  directly would drain envelopes the daemon owns, silently losing messages.)
- **Passive inbox lines read like a chat.** The UserPromptSubmit inject-hook
  now renders inbound messages as `whatsapp message from <name>: <text>` (and
  `whatsapp message from <name> in <group>: <text>` for groups) instead of the
  old `<number> [dm]: …` shape. `<name>`/`<group>` use the daemon-resolved
  `sender_name`/`chat_name`; unresolved senders fall back to the number as
  before. The UNTRUSTED-DATA security wrapper, ✏️ "(edited)" replace-in-place,
  burst-collapse, muting, lockfile, and fail-open behavior are all preserved.

### Added

- **Background cached name resolution in the daemon.** Before appending each
  envelope, the daemon best-effort resolves the sender's (and a group's)
  display name and stamps `sender_name` / `chat_name` onto the envelope.
  Resolution uses `GET /api/v1/directory?search=<localpart>` (direct for
  `@c.us` / `@g.us`); for `@lid` senders it fetches one message to read the
  phone-form `remoteJidAlt`, directory-searches that phone, and falls back to
  the message `pushName`. Results (positive and negative) are cached on disk in
  `~/.claude/whatsapp-cc/names.json` with a 1h TTL (10m for negatives), bounded
  to 1000 entries. Every lookup is wrapped in try/catch with a 5s fetch timeout
  so name resolution can never block or crash the poll loop — an unresolved JID
  simply appends without a name and the hook shows the number.

## [2.5.0] — 2026-06-22

### Added

- **WhatsApp inbox daemon bundled into the plugin** (`daemon/`). The plugin now
  ships three Node scripts (`daemon.mjs`, `ensure-daemon.mjs`, `inject-hook.mjs`)
  that previously had to be manually placed in `~/.claude/whatsapp-cc/`.
- **SessionStart hook** (`hooks/hooks.json`) — probes port 7656 and spawns the
  long-poll daemon as a detached background process if it is not already running.
  One daemon per machine; idempotent across all Claude Code sessions.
- **UserPromptSubmit hook** (`hooks/hooks.json`) — reads new lines from
  `~/.claude/whatsapp-cc/inbox.jsonl` and injects them as `additionalContext`
  above every prompt. Fail-open: empty inbox or missing spool file is a
  silent no-op, never blocks a prompt.
- **4 WhatsApp inbox skills** (`skills/whatsapp/`, `skills/reply-whatsapp/`,
  `skills/send-whatsapp/`, `skills/react-whatsapp/`) — auto-discovered by
  Claude Code from the `skills/` directory alongside the existing `chatlytics`
  skill. No `skills:` manifest key needed.
- Data path (`~/.claude/whatsapp-cc/`) is unchanged — scripts moved into the
  plugin, runtime data stays in the user home dir.

## [2.4.1] — 2026-06-22

### Fixed

- **`CHATLYTICS_SESSION` placeholder leak → 403 `bot_session_mismatch`.**
  The `.mcp.json` env block previously included
  `"CHATLYTICS_SESSION": "${CHATLYTICS_SESSION}"`. When the user (correctly)
  never defined `CHATLYTICS_SESSION`, Claude Code passed the literal unexpanded
  string `${CHATLYTICS_SESSION}` into the MCP process. The MCP server read it
  as `DEFAULT_SESSION` and forwarded it to `POST /api/v1/send`, which returned
  403 `bot_session_mismatch` (the bot token is already session-pinned
  server-side, so the mismatched literal session was rejected).
  Two-part fix: (1) removed `CHATLYTICS_SESSION` from the `.mcp.json` env
  block — bot-token users never need it; legacy api_key users who need it
  should set it manually in their settings `env` block. (2) added a `${`-guard
  in `DEFAULT_SESSION` initialization so any stale unexpanded placeholder
  that leaks in from an older `.mcp.json` is treated as unset rather than
  forwarded to the API.

## [2.4.0] — 2026-06-22

### Added

- **Auto-grant 8h DM access when sending to a non-allow-listed recipient.**
  `chatlytics_send` now, in bot-token mode for a DM (`@c.us`) target, checks
  whether the recipient is in the bot's DM allow-list; if not, it creates an 8h
  time-limited access grant (`POST /api/v1/bot/me/access-grants`) so the
  recipient's REPLY routes back to this bot's inbox (dm-paired) instead of being
  dropped — then auto-expires. Without this you could message a new number from
  Claude Code but never see their answer. The grant also creates the outbound
  pairing the send needs (INV-09). Best-effort: a grant failure never blocks the
  send. A one-line note is appended to the send result when a grant is created.

## [2.3.0] — 2026-06-22

### Fixed

- **Name → JID resolution now uses the fast directory index instead of a
  timeout-prone live search.** `resolveChatId()` (the implicit hop behind
  `chatlytics_send` / `chatlytics_read` when given a contact/group *name*) and
  the `chatlytics_search` tool both called `POST /api/v1/actions {action:"search"}`,
  which triggers a **live WAHA query** that routinely times out for bot tokens
  (observed 25s+, past `callApi`'s 30s ceiling) — so name-based sends hung. Both
  now call `GET /api/v1/directory?search=`, a local SQLite lookup that returns
  `{jid, displayName, isGroup}` immediately. Substring matches that return
  several rows prefer a single exact (case-insensitive) name match before the
  disambiguation picker. JIDs passed directly are unaffected.

## [2.2.0] — 2026-06-11

### Changed

- **Bundle ships as `chatlytics-mcp.bundle.mjs` (was `.bundle.js`) — kills the
  rename landmine.** The bundle is an ES module; the old `.js` name only worked
  inside `servers/` because `servers/package.json` has `"type":"module"`.
  Copying the bundle out to a stable path (the recommended survivability
  pattern) crashed Node with "Cannot use import statement outside a module"
  until manually renamed `.mjs`. The build output, `.mcp.json` entry, and docs
  now use `.mjs` so the bundle loads from ANY path. A new smoke assertion
  boots a copy of the bundle from a bare temp dir (no `package.json`) to lock
  this in (15 bundle-behavior assertions total).

### Added

- **`scripts/install.mjs` — scripted user-scope install.** Copies the bundle
  to a stable path outside any version-pinned plugin cache
  (`~/.chatlytics/mcp/chatlytics-mcp.mjs`) and registers it via
  `claude mcp add -s user chatlytics -e CHATLYTICS_BOT_TOKEN=... -- node <path>`.
  Idempotent (remove-then-add + overwrite-copy), prompt-free (token/url from
  args or env; clear get-a-token instructions when missing), Windows + POSIX,
  INV-02 (credentials redacted from printed commands). Also exposed as
  `npm run install:user` and a `chatlytics-mcp-install` bin entry.
- **Docs: session-restart requirement + connection troubleshooting matrix.**
  Mid-session `claude mcp add` does not surface tools until the Claude Code
  session restarts (now documented in README + QUICKSTART). New troubleshooting
  mapping: timeout → dead/unroutable IP (use DNS/LAN URL); connection refused →
  wrong host/port; 401 → bad/rotated token; 502 → Cloudflare tunnel concurrent
  long-poll limit (use LAN URL on-prem).

### Fixed

- Docs drift: tool count corrected to 10 (`chatlytics_configure` was missing
  from README/QUICKSTART/marketplace descriptions).

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
