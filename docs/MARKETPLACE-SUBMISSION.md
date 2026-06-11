# Marketplace Submission Instructions

> Submission steps for getting `chatlytics-claude-code` listed in the
> `anthropics/claude-plugins-official` marketplace.

**Status as of 2026-06-11:** Plugin is v2.2.0, tagged + pushed. v1.1.2 was
live-verified end-to-end (real WhatsApp send from Claude Code, 2026-05-16);
the v2.x line adds bot-token auth, long-poll inbound, bot self-config, and a
scripted user-scope installer. Ready to submit. The submission step requires
a web form (PRs from non-Anthropic authors are auto-closed by the marketplace
repo's CI).

## Submit

1. **Open the official form** (auth-gated, web only — no CLI / API equivalent):
   - claude.ai: <https://claude.ai/settings/plugins/submit>
   - Console: <https://platform.claude.com/plugins/submit>

2. **Paste the repo URL:**

   ```
   https://github.com/omernesh/chatlytics-claude-code
   ```

3. **Pitch (copy-paste ready):**

   > **Chatlytics** — WhatsApp messaging for Claude Code via the
   > [Chatlytics](https://chatlytics.ai) gateway. 10 MCP tools
   > (`chatlytics_send`, `chatlytics_read`, `chatlytics_search`,
   > `chatlytics_dispatch`, `chatlytics_login`, `chatlytics_actions`,
   > `chatlytics_directory`, `chatlytics_health`, `chatlytics_poll`,
   > `chatlytics_configure`) plus an auto-triggering skill that fires on
   > WhatsApp asks. Telegram-style bot-token onboarding (`sk_bot_*`,
   > verified at boot via `GET /api/v1/bot/me`) and long-poll inbound
   > (no public webhook needed). Bundled single-file MCP server — zero
   > `npm install` after `claude plugin install`. MIT licensed. Smoke test
   > (`npm test`) runs 15 bundle-behavior assertions plus an optional live
   > `GET /health` check asserting `webhook_registered:true`. Live-verified
   > end-to-end (real WhatsApp send from Claude Code).

4. **Submit and wait.** Anthropic will run automated security/privacy review
   (`.github/policy/prompt.md` checks scope, telemetry, description honesty,
   AUP compliance). Approval typically takes 1–7 days. They'll then pin a
   commit SHA into `claude-plugins-official/marketplace.json`.

## Why this should pass automated review

- **Narrow MCP scope** — no Claude Code hooks, no PostToolUse, no shell
  execution
- **BYO telemetry** — the MCP server only POSTs to the user's own Chatlytics
  instance (URL + API key configured by the user in `~/.claude/settings.json`)
- **Honest description** — README + QUICKSTART describe behavior accurately,
  no marketing fluff
- **Manifest completeness** — `license`, `repository`, `homepage`, `author`
  fields all populated in both `plugin.json` and `marketplace.json`
- **Reproducible install** — v2.2.0 tag pinned on GitHub; bundled MCP server
  ships in `servers/chatlytics-mcp.bundle.mjs` (no post-install steps)

## After approval

- Update `README.md` install snippet to use the official marketplace name
- Bump `CHANGELOG.md` with a "listed in official marketplace" line
- Cross-post to the Chatlytics docs site
