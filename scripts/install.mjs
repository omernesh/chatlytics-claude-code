#!/usr/bin/env node
// Chatlytics MCP — scripted user-scope install (P3 plugin survivability).
//
// Why this exists: Claude Code plugin installs land the MCP bundle inside a
// VERSION-PINNED plugin cache directory that is wiped/replaced on every plugin
// update. Operators who register the server by absolute path (claude mcp add)
// then lose the server on the next update. This script copies the bundle to a
// STABLE path outside any cache and registers it user-scoped.
//
// Stable path: ~/.chatlytics/mcp/chatlytics-mcp.mjs
//   - `.mjs` extension is deliberate: the bundle is an ES module and the
//     stable path has NO package.json next to it. A `.js` copy crashes Node
//     with "Cannot use import statement outside a module". DO NOT rename to .js.
//
// Usage:
//   node scripts/install.mjs --token sk_bot_xxx [--url https://node.chatlytics.ai] [--session sess_id]
//   node scripts/install.mjs            # reads CHATLYTICS_BOT_TOKEN / CHATLYTICS_API_URL / CHATLYTICS_SESSION from env
//   node scripts/install.mjs --dry-run  # show what would happen, change nothing
//
// Idempotent: re-running overwrites the copied bundle and re-registers the
// MCP server (remove-then-add).

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DEFAULT_URL = "https://node.chatlytics.ai";

// --- arg parsing (tiny, prompt-free) ----------------------------------------
const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const DRY_RUN = args.includes("--dry-run");
const botToken = argValue("--token") ?? process.env.CHATLYTICS_BOT_TOKEN ?? "";
const apiKey = argValue("--api-key") ?? process.env.CHATLYTICS_API_KEY ?? "";
const apiUrl = argValue("--url") ?? process.env.CHATLYTICS_API_URL ?? DEFAULT_URL;
const session = argValue("--session") ?? process.env.CHATLYTICS_SESSION ?? "";
const destPath =
  argValue("--dest") ?? join(homedir(), ".chatlytics", "mcp", "chatlytics-mcp.mjs");

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Chatlytics MCP user-scope installer

Copies the bundled MCP server to a stable path (default:
${join(homedir(), ".chatlytics", "mcp", "chatlytics-mcp.mjs")})
and registers it with: claude mcp add -s user chatlytics ...

Options:
  --token <sk_bot_...>   Bot token (preferred; or env CHATLYTICS_BOT_TOKEN)
  --api-key <key>        Legacy admin api_key fallback (or env CHATLYTICS_API_KEY)
  --url <url>            API base URL (default ${DEFAULT_URL}; or env CHATLYTICS_API_URL)
  --session <id>         Optional session id (or env CHATLYTICS_SESSION)
  --dest <path>          Override the stable bundle path
  --dry-run              Print actions without executing
`);
  process.exit(0);
}

// --- locate the bundle --------------------------------------------------------
// Prefer the .mjs bundle (v2.2.0+); fall back to the legacy .js name so the
// script also works from an older checkout.
const candidates = [
  join(REPO_ROOT, "servers", "chatlytics-mcp.bundle.mjs"),
  join(REPO_ROOT, "servers", "chatlytics-mcp.bundle.js"),
];
const bundleSrc = candidates.find((p) => existsSync(p));
if (!bundleSrc) {
  console.error(
    `[install] FAIL: bundle not found. Looked for:\n  ${candidates.join("\n  ")}\n` +
      `Run \`cd servers && npm install && npm run build\` first.`,
  );
  process.exit(1);
}

// --- require a credential (prompt-free, clear instructions) -------------------
if (!botToken && !apiKey) {
  console.error(`[install] FAIL: no credential provided.

Chatlytics needs a bot token (preferred) or a legacy admin api_key:
  * Bot token (sk_bot_...): sign in at https://app.chatlytics.ai -> Bots ->
    Create Bot, copy the token (shown ONCE), then re-run:
      node scripts/install.mjs --token sk_bot_your-token
  * Or set CHATLYTICS_BOT_TOKEN in your environment and re-run with no args.
  * Legacy fallback: --api-key <key> or CHATLYTICS_API_KEY (cannot drive
    chatlytics_poll long-poll inbound; prefer a bot token).`);
  process.exit(1);
}

// --- copy bundle to the stable path -------------------------------------------
console.log(`[install] bundle source: ${bundleSrc}`);
console.log(`[install] stable path:   ${destPath}`);
if (!DRY_RUN) {
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(bundleSrc, destPath); // overwrite = idempotent update
  console.log(`[install] copied bundle (overwrites any previous copy).`);
}

// --- register with claude mcp (user scope) ------------------------------------
// On Windows the `claude` launcher is a .cmd shim, so spawn must go through a
// shell. We build a fully quoted command string ourselves to keep arg handling
// identical on both platforms (paths may contain spaces).
const isWin = process.platform === "win32";
function quote(a) {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, isWin ? '""' : '\\"')}"` : a;
}
function runClaude(cliArgs, { ignoreFailure = false } = {}) {
  const cmd = ["claude", ...cliArgs.map(quote)].join(" ");
  // INV-02: never print credential plaintext.
  let redacted = cmd;
  if (botToken) redacted = redacted.split(botToken).join("sk_bot_***");
  if (apiKey) redacted = redacted.split(apiKey).join("***");
  console.log(`[install] $ ${redacted}`);
  if (DRY_RUN) return true;
  const res = spawnSync(cmd, { shell: true, stdio: "inherit" });
  if (res.status !== 0 && !ignoreFailure) {
    console.error(
      `[install] FAIL: \`claude\` exited ${res.status ?? "?"}. Is the Claude Code CLI on your PATH?`,
    );
    process.exit(1);
  }
  return res.status === 0;
}

// Idempotency: remove any prior registration first (ignore "not found").
runClaude(["mcp", "remove", "-s", "user", "chatlytics"], { ignoreFailure: true });

const envArgs = [];
if (botToken) envArgs.push("-e", `CHATLYTICS_BOT_TOKEN=${botToken}`);
if (!botToken && apiKey) envArgs.push("-e", `CHATLYTICS_API_KEY=${apiKey}`);
envArgs.push("-e", `CHATLYTICS_API_URL=${apiUrl}`);
if (session) envArgs.push("-e", `CHATLYTICS_SESSION=${session}`);

runClaude(["mcp", "add", "-s", "user", "chatlytics", ...envArgs, "--", "node", destPath]);

console.log(`
[install] DONE. chatlytics MCP registered user-scoped at:
  ${destPath}
  API URL: ${apiUrl}
  Auth:    ${botToken ? "bot_token (CHATLYTICS_BOT_TOKEN)" : "api_key (legacy CHATLYTICS_API_KEY)"}

NOTE: restart your Claude Code session now -- mid-session MCP installs do NOT
surface tools until the session restarts. After restarting, verify with the
chatlytics_login tool.

Re-run this script any time to update the bundle copy (e.g. after a plugin
update or git pull) -- it is idempotent.`);
