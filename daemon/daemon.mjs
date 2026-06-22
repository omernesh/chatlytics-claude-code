/**
 * WhatsApp CC Daemon — background long-poll worker
 *
 * Singleton: holds TCP port 127.0.0.1:7656 for the process lifetime.
 * On EADDRINUSE → another instance is running → exit 0.
 *
 * File ownership (this daemon ONLY writes these):
 *   inbox.jsonl   — append-only log of received envelopes
 *   cursor.json   — {cursor: "<opaque>"} persistence
 *   state.json    — {last: {...}, recent: [...20...]}
 *   daemon.log    — rotated at ~5 MB
 *   seen.json     — {ids: [...]} dedup ring-buffer
 *
 * Never writes (except D8 compaction): read-state.json (written ONLY during compaction), config.json
 */

import net from 'net';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// ─── Paths ────────────────────────────────────────────────────────────────────

const DIR = path.join(os.homedir(), '.claude', 'whatsapp-cc');
const CURSOR_FILE  = path.join(DIR, 'cursor.json');
const INBOX_FILE   = path.join(DIR, 'inbox.jsonl');
const STATE_FILE   = path.join(DIR, 'state.json');
const LOG_FILE     = path.join(DIR, 'daemon.log');
const CONFIG_FILE  = path.join(DIR, 'config.json');   // read-only for daemon
const SEEN_FILE    = path.join(DIR, 'seen.json');
const READ_STATE_FILE = path.join(DIR, 'read-state.json');

const SINGLETON_PORT = 7656;
const SINGLETON_HOST = '127.0.0.1';

const LOG_MAX_BYTES   = 5 * 1024 * 1024; // 5 MB rotate threshold
const RECENT_MAX      = 20;
const BACKOFF_INIT    = 1000;
const BACKOFF_MAX     = 30_000;
const AUTH_BACKOFF_MAX = 300_000;
const POLL_TIMEOUT    = 55_000;          // server hold time
const FETCH_TIMEOUT   = 60_000;          // AbortSignal — must exceed POLL_TIMEOUT
const SEEN_MAX        = 500;
const INBOX_MAX_BYTES = 5 * 1024 * 1024;

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;

    // Rotate if over limit
    let size = 0;
    try { size = fs.statSync(LOG_FILE).size; } catch { /* ok */ }
    if (size > LOG_MAX_BYTES) {
      fs.writeFileSync(LOG_FILE, `[${new Date().toISOString()}] --- log truncated (exceeded ${LOG_MAX_BYTES} bytes) ---\n`);
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Never let logging throw
  }
}

// ─── Config resolution ───────────────────────────────────────────────────────

function readSettings() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (err) {
    // File missing or unreadable — return empty (caller will detect missing token)
    return { _readError: err.message };
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    return { _parseError: err.message };
  }
}

function isPlaceholder(val) {
  // Treat "${...}" unexpanded template literals as UNSET
  return !val || typeof val !== 'string' || val.startsWith('${');
}

function resolveConfig() {
  const settings = readSettings();
  const env = settings?.env ?? {};

  let token = env.CHATLYTICS_BOT_TOKEN ?? '';
  if (isPlaceholder(token)) token = process.env.CHATLYTICS_BOT_TOKEN ?? '';
  if (isPlaceholder(token)) token = '';

  let apiUrl = env.CHATLYTICS_API_URL ?? '';
  if (isPlaceholder(apiUrl)) apiUrl = process.env.CHATLYTICS_API_URL ?? '';
  if (isPlaceholder(apiUrl)) apiUrl = '';
  if (!apiUrl) apiUrl = 'https://node.chatlytics.ai';
  // Strip trailing slash
  apiUrl = apiUrl.replace(/\/+$/, '');

  return { token, apiUrl };
}

// ─── Singleton port guard ────────────────────────────────────────────────────

function acquireSingleton() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log(`Singleton port ${SINGLETON_PORT} already in use — another daemon is running. Exiting.`);
        process.exit(0);
      }
      reject(err);
    });

    server.listen(SINGLETON_PORT, SINGLETON_HOST, () => {
      log(`Singleton acquired on ${SINGLETON_HOST}:${SINGLETON_PORT}`);
      resolve(server);
    });
  });
}

// ─── Cursor persistence ───────────────────────────────────────────────────────

function loadCursor() {
  try {
    const raw = fs.readFileSync(CURSOR_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.cursor === 'string' ? parsed.cursor : null;
  } catch {
    return null;
  }
}

function saveCursor(cursor) {
  try {
    fs.writeFileSync(CURSOR_FILE, JSON.stringify({ cursor }) + '\n');
  } catch (err) {
    log(`WARN: could not save cursor: ${err.message}`);
  }
}

// ─── State persistence ────────────────────────────────────────────────────────

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { last: null, recent: [] };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  } catch (err) {
    log(`WARN: could not save state: ${err.message}`);
  }
}

/** Extract the stable summary fields from an envelope */
function envelopeSummary(env) {
  return {
    chatJid:   env.entity_jid   ?? null,
    sessionId: env.session_id   ?? null,
    sender:    env.sender_jid   ?? null,
    messageId: env.message_id   ?? null,
    chatType:  env.chat_type    ?? null,
    ts:        env.ts           ?? null,
  };
}

// ─── Seen dedup ───────────────────────────────────────────────────────────────

function loadSeen() {
  try {
    const raw = fs.readFileSync(SEEN_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.ids) ? parsed.ids : [];
  } catch {
    return [];
  }
}

function saveSeen(seenIds) {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify({ ids: seenIds }) + '\n');
  } catch (err) {
    log(`WARN: could not save seen.json: ${err.message}`);
  }
}

// ─── Inbox append ─────────────────────────────────────────────────────────────

function appendInbox(envelope) {
  try {
    const record = { ...envelope, received_at: Date.now() };
    fs.appendFileSync(INBOX_FILE, JSON.stringify(record) + '\n');
    return true;
  } catch (err) {
    log(`WARN: could not append to inbox: ${err.message}`);
    return false;
  }
}

// ─── Inbox compaction (D8) ────────────────────────────────────────────────────

function maybeCompactInbox() {
  // D8: The ONE sanctioned case where the daemon writes read-state.json.
  // Race with inject-hook is benign: a concurrent hook that read the old large
  // readBytes will see fileSize <= readBytes after the atomic swap and no-op.
  try {
    let inboxSize = 0;
    try { inboxSize = fs.statSync(INBOX_FILE).size; } catch { return; }
    if (inboxSize <= INBOX_MAX_BYTES) return;

    // Read the current hook's read offset
    let readBytes = 0;
    try {
      const rs = JSON.parse(fs.readFileSync(READ_STATE_FILE, 'utf8'));
      readBytes = typeof rs.readBytes === 'number' ? rs.readBytes : 0;
    } catch { readBytes = 0; }

    if (readBytes <= 0) {
      log('Compaction skipped: nothing consumed yet (readBytes=0).');
      return;
    }
    if (readBytes > inboxSize) {
      log(`Compaction skipped: readBytes (${readBytes}) > inboxSize (${inboxSize}).`);
      return;
    }

    // Read the unread tail [readBytes, EOF)
    const tailLen = inboxSize - readBytes;
    const fd = fs.openSync(INBOX_FILE, 'r');
    const buf = Buffer.allocUnsafe(tailLen);
    const bytesRead = fs.readSync(fd, buf, 0, tailLen, readBytes);
    fs.closeSync(fd);
    const tail = buf.slice(0, bytesRead);

    // Atomic swap
    const tmpFile = INBOX_FILE + '.tmp';
    fs.writeFileSync(tmpFile, tail);
    fs.renameSync(tmpFile, INBOX_FILE);

    // Reset hook read pointer to 0
    fs.writeFileSync(READ_STATE_FILE, JSON.stringify({ readBytes: 0 }) + '\n');

    const newSize = tail.length;
    log(`Inbox compacted: ${inboxSize} → ${newSize} bytes (${readBytes} bytes consumed prefix removed).`);
  } catch (err) {
    log(`WARN: inbox compaction failed: ${err.message}`);
  }
}

// ─── ACK (best-effort, fire-and-forget) ──────────────────────────────────────

async function ackCursor(apiUrl, token, cursor) {
  await fetch(`${apiUrl}/api/v1/bot/updates/ack`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ cursor }),
    signal: AbortSignal.timeout(10_000),
  });
}

// ─── Main poll loop ───────────────────────────────────────────────────────────

async function pollLoop(token, apiUrl) {
  let cursor      = loadCursor();
  let backoff     = BACKOFF_INIT;
  let authBackoff = 30_000;
  let lastAckWarnAt = 0;
  let seenIds     = loadSeen();
  const seenSet   = new Set(seenIds);

  log(`Poll loop starting. API: ${apiUrl}. Cursor: ${cursor ? cursor.slice(0, 20) + '…' : 'none'}`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // Build URL
      const url = new URL(`${apiUrl}/api/v1/bot/updates`);
      url.searchParams.set('timeout_ms', String(POLL_TIMEOUT));
      if (cursor) url.searchParams.set('cursor', cursor);

      const res = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });

      if (res.status === 401 || res.status === 403) {
        log(`Auth error ${res.status} — check CHATLYTICS_BOT_TOKEN. Sleeping ${authBackoff}ms before retry.`);
        await sleep(authBackoff);
        authBackoff = Math.min(authBackoff * 2, AUTH_BACKOFF_MAX);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log(`HTTP ${res.status} from poll endpoint. Body: ${body.slice(0, 200)}. Backing off ${backoff}ms.`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX);
        continue;
      }

      // Reset auth backoff and general backoff on any successful response
      authBackoff = 30_000;
      backoff = BACKOFF_INIT;

      const payload = await res.json();
      const envelopes = Array.isArray(payload.envelopes) ? payload.envelopes : [];
      const newCursor = typeof payload.cursor === 'string' ? payload.cursor : cursor;

      if (envelopes.length > 0) {
        log(`Received ${envelopes.length} envelope(s). New cursor: ${newCursor ? newCursor.slice(0, 20) + '…' : 'none'}`);

        // Process envelopes — dedup + append
        const state = loadState();
        let allAppended = true;
        let anyProcessed = false;

        for (const envelope of envelopes) {
          const msgId = envelope.message_id ?? null;

          // D7: Skip duplicates.
          // EDIT envelopes reuse the original message_id — key them as
          // "<id>:edit:<ts>" so each edit passes dedup independently while
          // true replays (same id + same edited state + same ts) are still dropped.
          const seenKey = (msgId && envelope.edited)
            ? `${msgId}:edit:${envelope.ts}`
            : msgId;

          if (seenKey && seenSet.has(seenKey)) {
            log(`DEBUG: skipping duplicate envelope ${seenKey}`);
            continue;
          }

          const ok = appendInbox(envelope);
          if (!ok) {
            log(`ERROR: failed to append envelope to inbox (message_id=${msgId ?? 'unknown'}). Will not advance cursor.`);
            allAppended = false;
          } else {
            // Track in seen set
            if (seenKey) {
              seenSet.add(seenKey);
              seenIds.push(seenKey);
              // Keep ring-buffer bounded
              if (seenIds.length > SEEN_MAX) {
                const removed = seenIds.shift();
                seenSet.delete(removed);
              }
            }

            const summary = envelopeSummary(envelope);
            state.last = summary;
            // Prepend to recent, keep last 20
            state.recent = [summary, ...(state.recent ?? [])].slice(0, RECENT_MAX);
            anyProcessed = true;
          }
        }

        if (anyProcessed) {
          saveSeen(seenIds);
        }

        if (allAppended) {
          saveState(state);
          maybeCompactInbox();

          // Persist cursor
          if (newCursor) {
            cursor = newCursor;
            saveCursor(cursor);
          }

          // ACK best-effort with throttled warn
          if (cursor) {
            ackCursor(apiUrl, token, cursor).catch(err => {
              const now = Date.now();
              if (now - lastAckWarnAt > 60_000) {
                log(`WARN: ack failed: ${err.message}`);
                lastAckWarnAt = now;
              }
            });
          }
        } else {
          // At least one append failed — do NOT advance cursor; apply backoff
          log(`ERROR: one or more envelope appends failed. Not advancing cursor. Backing off ${backoff}ms.`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_MAX);
        }
      } else {
        // Empty long-poll response (server timeout with no messages) — normal
        if (newCursor && newCursor !== cursor) {
          cursor = newCursor;
          saveCursor(cursor);
        }
        // No backoff on empty — immediately re-poll
      }
    } catch (err) {
      // Network errors, AbortError (fetch timeout), parse errors, etc.
      log(`Poll error: ${err.name}: ${err.message}. Backing off ${backoff}ms.`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  // Ensure output dir exists
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* already exists */ }

  log('WhatsApp CC daemon starting…');

  // Resolve config first — fail fast on missing token
  const settings = readSettings();
  const { token, apiUrl } = resolveConfig();
  if (!token) {
    if (settings._readError) {
      log(`ERROR: Cannot read ~/.claude/settings.json: ${settings._readError}. Fix the file or set CHATLYTICS_BOT_TOKEN in the environment. Exiting.`);
    } else if (settings._parseError) {
      log(`ERROR: ~/.claude/settings.json is corrupt (JSON parse error: ${settings._parseError}). Fix or regenerate the file. Exiting.`);
    } else {
      log('ERROR: CHATLYTICS_BOT_TOKEN is not set or is an unexpanded placeholder. ' +
          'Set it in ~/.claude/settings.json under env.CHATLYTICS_BOT_TOKEN. Exiting.');
    }
    process.exit(1);
  }

  // Acquire singleton port — exits 0 if another daemon is running
  const server = await acquireSingleton();

  // D6: Graceful shutdown
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log(`Received ${sig}, shutting down.`);
      server.close();
      process.exit(0);
    });
  }

  // Run poll loop (never returns)
  await pollLoop(token, apiUrl);
}

main().catch(err => {
  log(`FATAL: ${err.stack ?? err.message}`);
  process.exit(1);
});
