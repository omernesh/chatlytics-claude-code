# Submission to claude-plugins-official

This plugin currently distributes via its own marketplace
(`omernesh/chatlytics-claude-code`). That's the right path for **closed beta**.

For **public launch**, submit to Anthropic's curated marketplace
(`claude-plugins-official`) so Claude Code users get the plugin without
running `claude plugin marketplace add` first.

## Where to submit

- **Claude.ai form:** https://claude.ai/settings/plugins/submit
- **Console form:** https://platform.claude.com/plugins/submit

## Submission readiness checklist

| Field | Status | Source |
|-------|--------|--------|
| Public GitHub repo | ✅ | https://github.com/omernesh/chatlytics-claude-code |
| `.claude-plugin/plugin.json` | ✅ | `name`, `version`, `description`, `author`, `license`, `homepage`, `repository` all populated |
| `.claude-plugin/marketplace.json` | ✅ | Single-plugin marketplace with category, keywords |
| README.md | ✅ | Quick install + setup + usage |
| QUICKSTART.md | ✅ | Beta-tester-targeted, <5 min to first message |
| CHANGELOG.md | ✅ | Versioned independently from Chatlytics monorepo |
| LICENSE | ✅ | MIT |
| Smoke test | ✅ | `servers/test/smoke.js` verifies `/health` + `webhook_registered:true` |
| Bundled MCP server | ✅ | `servers/chatlytics-mcp.bundle.js` (esbuild, single file, no deps) |
| Tag/version coupling | ✅ | Plugin version === `package.json` version === `marketplace.json` version |

## What's missing for submission (nice-to-have polish)

- **Logo / icon** — 256x256 PNG. Nothing official required, but the catalog
  at https://claude.com/plugins shows icons.
- **Screenshots** — 1-3 PNGs showing Claude Code interacting with WhatsApp
  via the plugin (e.g., `> use chatlytics_login` reply, `> send hello to Omer`
  flow). Used in the catalog detail view.
- **Longer description** — current is ~30 words; submission form may accept
  1-2 paragraphs with use-case framing.
- **Demo video** — optional, 30-60s screen capture of an end-to-end task.

## Pre-submission steps when public-launch is ready

1. Bump version to a clean `1.x.0` (e.g., `1.2.0`) with a "Submitted to
   claude-plugins-official" CHANGELOG entry.
2. Tag the release in git: `git tag v1.2.0 && git push --tags`.
3. Capture screenshots — at minimum: install command + `chatlytics_login`
   success + send-message flow + read-messages flow.
4. Submit via the form. Provide the GitHub repo URL; Anthropic clones it
   from `marketplace.json`.
5. Watch for reviewer feedback. Typical asks: clearer security warning
   (the plugin moves user data through a third-party API), MFA / API key
   rotation guidance, rate-limit story.

## After acceptance

- Users no longer need `claude plugin marketplace add omernesh/chatlytics-claude-code`.
- Install becomes: `claude plugin install chatlytics@claude-plugins-official`.
- The self-marketplace at `omernesh/chatlytics-claude-code` stays as a
  beta channel — bleeding-edge versions for testers before they land in
  the official catalog.
