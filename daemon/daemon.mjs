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
import { spawn } from 'child_process';
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
const NAMES_FILE   = path.join(DIR, 'names.json');     // resolved-name cache

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
const NAME_TTL_MS     = 60 * 60 * 1000;  // 1h — re-resolve names at most hourly
const NAME_CACHE_MAX  = 1000;            // bound the on-disk name cache
const NAME_FETCH_TIMEOUT = 5_000;        // per-request cap; resolution is best-effort
const NAME_NEGATIVE_TTL_MS = 10 * 60 * 1000; // remember "no name" for 10m to skip refetch

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

/**
 * Read the optional notify config from config.json (read-only for the daemon).
 * Shape: { notify: { enabled: bool, ntfyUrl: string|null } }. Defaults: enabled=true,
 * ntfyUrl=null. Always returns a sane object — never throws.
 */
function readNotifyConfig() {
  const fallback = { enabled: true, ntfyUrl: null };
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const n = obj && typeof obj === 'object' ? obj.notify : null;
    if (!n || typeof n !== 'object') return fallback;
    const enabled = n.enabled === false ? false : true;   // default true
    const ntfyUrl = (typeof n.ntfyUrl === 'string' && n.ntfyUrl.trim()) ? n.ntfyUrl.trim() : null;
    return { enabled, ntfyUrl };
  } catch {
    return fallback;
  }
}

// ─── Desktop notifications (FEATURE 1 — fail-open, never blocks the poll loop) ──
//
// notify(title, body) shows a Windows toast via a DETACHED PowerShell process so
// it never blocks. Untrusted WhatsApp text reaches the body, so the PS payload is
// passed via -EncodedCommand (base64-UTF16LE) — the text NEVER touches the command
// line as literal characters and cannot break quoting or execute. The PS script
// itself reads the title/body from environment variables (CCWA_TITLE / CCWA_BODY),
// belt-and-suspenders against any injection.
//
// Three fallbacks, each tried in order inside the spawned PS process:
//   1. BurntToast  (New-BurntToastNotification) — if the module imports.
//   2. WinRT toast ([Windows.UI.Notifications.ToastNotificationManager]) with the
//      PowerShell AppId.
//   3. NotifyIcon balloon tip (System.Windows.Forms).
// Any failure is swallowed. The whole thing is best-effort.

const TOAST_PS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$title = $env:CCWA_TITLE
$body  = $env:CCWA_BODY
if (-not $title) { $title = 'WhatsApp' }
if (-not $body)  { $body  = '' }

function Show-BurntToast {
  Import-Module BurntToast -ErrorAction Stop
  New-BurntToastNotification -Text $title, $body -ErrorAction Stop
  return $true
}

function Show-WinRT {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  $tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $tpl.GetElementsByTagName('text')
  $texts.Item(0).AppendChild($tpl.CreateTextNode($title)) | Out-Null
  $texts.Item(1).AppendChild($tpl.CreateTextNode($body)) | Out-Null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  return $true
}

function Show-Balloon {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  Add-Type -AssemblyName System.Drawing -ErrorAction Stop
  $ni = New-Object System.Windows.Forms.NotifyIcon
  $ni.Icon = [System.Drawing.SystemIcons]::Information
  $ni.BalloonTipTitle = $title
  $ni.BalloonTipText  = $body
  $ni.Visible = $true
  $ni.ShowBalloonTip(8000)
  Start-Sleep -Milliseconds 9000
  $ni.Dispose()
  return $true
}

$ok = $false
try { $ok = Show-BurntToast } catch { $ok = $false }
if (-not $ok) { try { $ok = Show-WinRT } catch { $ok = $false } }
if (-not $ok) { try { $ok = Show-Balloon } catch { $ok = $false } }
`;

let cachedEncodedToastCommand = null;
function encodedToastCommand() {
  if (cachedEncodedToastCommand) return cachedEncodedToastCommand;
  cachedEncodedToastCommand = Buffer.from(TOAST_PS_SCRIPT, 'utf16le').toString('base64');
  return cachedEncodedToastCommand;
}

/**
 * Fire a Windows desktop toast for (title, body). Detached + best-effort: any
 * failure is swallowed so the poll loop is never blocked or crashed.
 * Title/body are passed via env vars — untrusted text never reaches the command line.
 */
function notify(title, body) {
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedToastCommand()],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          CCWA_TITLE: String(title ?? 'WhatsApp'),
          CCWA_BODY:  String(body ?? ''),
        },
      },
    );
    child.on('error', () => { /* swallow — fail-open */ });
    child.unref();
  } catch {
    // never let a toast failure touch the poll loop
  }
}

/**
 * Best-effort POST to an ntfy URL with a Title header. Untrusted text goes in the
 * BODY (not a header) so it cannot inject extra headers. Swallows all errors.
 */
function notifyNtfy(ntfyUrl, title, body) {
  try {
    if (!ntfyUrl || typeof ntfyUrl !== 'string') return;
    // ntfy Title header must be a single line; collapse + ASCII-ish for safety.
    const safeTitle = String(title ?? 'WhatsApp').replace(/[\r\n]+/g, ' ').slice(0, 200);
    fetch(ntfyUrl, {
      method: 'POST',
      headers: { 'Title': safeTitle },
      body: String(body ?? ''),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => { /* swallow */ });
  } catch {
    // fail-open
  }
}

/**
 * Build the (title, body) a new inbound envelope should surface.
 * title: "WhatsApp · <sender>" plus " in <group>" for groups.
 * body:  security-stripped text preview, newlines collapsed, ~180 chars.
 */
function buildNotification(env) {
  const sender = (env.sender_name && String(env.sender_name).trim())
    || localPart(env.sender_jid ?? '')
    || 'WhatsApp';
  let title = `WhatsApp · ${sender}`;
  if (env.chat_type === 'group') {
    const grp = (env.chat_name && String(env.chat_name).trim())
      || localPart(env.entity_jid ?? '')
      || 'group';
    title += ` in ${grp}`;
  }
  const cleaned = cleanSecurityPreview(env.text ?? '');
  const collapsed = cleaned.replace(/\s+/g, ' ').trim();
  const body = collapsed.length > 180 ? collapsed.slice(0, 179) + '…' : collapsed;
  return { title, body };
}

/**
 * Strip the leading [SECURITY: …] framing line(s) before previewing — same rule the
 * inject-hook uses (cleanDisplayText). Best-effort.
 */
function cleanSecurityPreview(text) {
  try {
    if (!text) return '';
    const lines = String(text).split('\n');
    let i = 0;
    while (i < lines.length && lines[i].trimStart().startsWith('[SECURITY:')) i++;
    return lines.slice(i).join('\n').trim();
  } catch {
    return '';
  }
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

// ─── Name resolution (best-effort, cached, fail-open) ─────────────────────────
//
// Stamps `sender_name` (and for groups `chat_name`) onto the envelope BEFORE
// appendInbox so the inject-hook can render "whatsapp message from <name>".
//
// Resolution is NEVER allowed to block or crash the poll loop:
//   • every fetch has a short AbortSignal timeout (NAME_FETCH_TIMEOUT)
//   • everything is wrapped in try/catch — any failure → no name stamped
//   • results (including negative "no name found") are cached on disk with a TTL
//     so we don't refetch the same JID for every message.
//
// Endpoints used (probed live against the bot token, 2026-06-24):
//   GET /api/v1/directory?search=<numeric-localpart>
//        → {contacts:[{jid, displayName, isGroup}], ...}. Works directly for
//          @c.us DM senders and @g.us groups (search by the numeric local part,
//          match the row whose jid === the queried jid).
//   GET /api/v1/messages?chatId=<lid>&limit=1
//        → [{_data:{key:{remoteJidAlt:"<phone>@s.whatsapp.net"}, pushName}}].
//          @lid senders are NOT in the directory under their LID, so we fetch one
//          message to learn the phone-form alt JID, then directory-search that
//          phone. pushName is the final fallback if the directory has no name.

const nameCache = new Map();   // jid → { name: string|null, ts: number }
let nameCacheDirty = false;

function loadNameCache() {
  try {
    const raw = fs.readFileSync(NAMES_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [jid, entry] of Object.entries(obj)) {
        if (entry && typeof entry.ts === 'number') {
          nameCache.set(jid, { name: entry.name ?? null, ts: entry.ts });
        }
      }
    }
  } catch {
    // Missing/corrupt cache → start empty (fail-open)
  }
}

function saveNameCache() {
  if (!nameCacheDirty) return;
  try {
    // Bound the cache: keep the most-recently-stamped NAME_CACHE_MAX entries.
    let entries = Array.from(nameCache.entries());
    if (entries.length > NAME_CACHE_MAX) {
      entries.sort((a, b) => b[1].ts - a[1].ts);
      entries = entries.slice(0, NAME_CACHE_MAX);
      nameCache.clear();
      for (const [jid, entry] of entries) nameCache.set(jid, entry);
    }
    const obj = {};
    for (const [jid, entry] of entries) obj[jid] = entry;
    fs.writeFileSync(NAMES_FILE, JSON.stringify(obj) + '\n');
    nameCacheDirty = false;
  } catch (err) {
    log(`WARN: could not save names.json: ${err.message}`);
  }
}

/** Cache lookup honoring positive (NAME_TTL_MS) and negative (NAME_NEGATIVE_TTL_MS) TTLs. */
function cachedName(jid) {
  const entry = nameCache.get(jid);
  if (!entry) return undefined;            // unknown → caller should resolve
  const age = Date.now() - entry.ts;
  const ttl = entry.name ? NAME_TTL_MS : NAME_NEGATIVE_TTL_MS;
  if (age > ttl) return undefined;          // stale → re-resolve
  return entry.name;                        // string OR null (cached negative)
}

function putName(jid, name) {
  nameCache.set(jid, { name: name ?? null, ts: Date.now() });
  nameCacheDirty = true;
}

/** Numeric local part of a JID, e.g. "972555713995@c.us" → "972555713995". */
function localPart(jid) {
  if (!jid || typeof jid !== 'string') return '';
  const at = jid.indexOf('@');
  return at > 0 ? jid.slice(0, at) : jid;
}

async function fetchJson(url, token) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(NAME_FETCH_TIMEOUT),
  });
  if (!res.ok) return null;
  return await res.json();
}

/** Directory search by the numeric local part; return the displayName of the row
 *  whose jid matches `wantJid` (preferred) or the sole exact-localpart row. */
async function directoryName(jid, apiUrl, token) {
  const lp = localPart(jid);
  if (!lp) return null;
  const url = `${apiUrl}/api/v1/directory?search=${encodeURIComponent(lp)}`;
  const data = await fetchJson(url, token);
  const rows = data && Array.isArray(data.contacts) ? data.contacts : [];
  if (rows.length === 0) return null;
  // Prefer an exact jid match.
  const exact = rows.find(r => r && r.jid === jid);
  if (exact && exact.displayName) return String(exact.displayName);
  // Else a row whose local part matches exactly (handles @lid→@c.us phone hop).
  const lpMatch = rows.find(r => r && localPart(r.jid) === lp && r.displayName);
  if (lpMatch) return String(lpMatch.displayName);
  return null;
}

/**
 * Resolve a human display name for a JID. Returns a string or null.
 * Strategy:
 *   1. directory search by local part (works for @c.us / @g.us)
 *   2. for @lid: fetch one message → remoteJidAlt phone → directory search;
 *      fall back to that message's pushName.
 * Cached (positive + negative). Best-effort: any error → null.
 */
async function resolveName(jid, apiUrl, token) {
  if (!jid || typeof jid !== 'string') return null;
  const hit = cachedName(jid);
  if (hit !== undefined) return hit;   // cached string or cached null

  let name = null;
  try {
    name = await directoryName(jid, apiUrl, token);

    if (!name && jid.endsWith('@lid')) {
      // LID is not directly in the directory — learn its phone-form alt JID and
      // its pushName from a single recent message.
      const msgs = await fetchJson(
        `${apiUrl}/api/v1/messages?chatId=${encodeURIComponent(jid)}&limit=1`,
        token,
      );
      const m = Array.isArray(msgs) && msgs.length ? msgs[0] : null;
      const altRaw = m?._data?.key?.remoteJidAlt ?? '';
      const pushName = typeof m?._data?.pushName === 'string' ? m._data.pushName.trim() : '';
      if (altRaw) {
        // "<phone>@s.whatsapp.net" → "<phone>@c.us"
        const phone = localPart(altRaw);
        if (phone) {
          name = await directoryName(`${phone}@c.us`, apiUrl, token);
        }
      }
      // pushName is the WhatsApp profile name — a reasonable fallback, but skip
      // values that look like an internal session id (e.g. "3cf11776_logan").
      if (!name && pushName && !/^[0-9a-f]{6,}_/i.test(pushName)) {
        name = pushName;
      }
    }
  } catch {
    // network/parse/timeout → leave name null (envelope appended without a name)
    name = null;
  }

  putName(jid, name);
  return name;
}

/**
 * Mutate `envelope` in place, stamping sender_name (+ chat_name for groups).
 * Wrapped so it can NEVER throw into the poll loop.
 */
async function stampNames(envelope, apiUrl, token) {
  try {
    const senderJid = envelope.sender_jid ?? null;
    if (senderJid) {
      const sn = await resolveName(senderJid, apiUrl, token);
      if (sn) envelope.sender_name = sn;
    }
    if (envelope.chat_type === 'group') {
      const groupJid = envelope.entity_jid ?? null;
      if (groupJid) {
        const cn = await resolveName(groupJid, apiUrl, token);
        if (cn) envelope.chat_name = cn;
      }
    }
  } catch {
    // best-effort — never block/crash the loop
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
  loadNameCache();

  // FEATURE 1: notifications. `firstCycle` guards the startup backlog flush — the
  // first poll after daemon start never dumps a pile of toasts (it summarizes if
  // large). After the first cycle, normal live notifications apply.
  let firstCycle = true;
  const NOTIFY_CAP = 5;

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
        const appendedThisBatch = [];   // FEATURE 1: newly-appended inbounds to notify

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

          // Best-effort: stamp sender_name / chat_name BEFORE append so the
          // inject-hook can render "whatsapp message from <name>". Never throws
          // (cached + short-timeout + try/catch inside).
          await stampNames(envelope, apiUrl, token);

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
            appendedThisBatch.push(envelope);
          }
        }

        if (anyProcessed) {
          saveSeen(seenIds);
          saveNameCache();
        }

        // FEATURE 1: desktop push for newly-appended inbounds. Best-effort,
        // fail-open, never blocks. Skip the startup backlog flush (firstCycle).
        try {
          if (!firstCycle && appendedThisBatch.length > 0) {
            const cfg = readNotifyConfig();
            if (cfg.enabled) {
              if (appendedThisBatch.length > NOTIFY_CAP) {
                // Anti-spam: one summary toast instead of a burst.
                const title = 'WhatsApp';
                const body = `${appendedThisBatch.length} new WhatsApp messages`;
                notify(title, body);
                if (cfg.ntfyUrl) notifyNtfy(cfg.ntfyUrl, title, body);
              } else {
                for (const env of appendedThisBatch) {
                  const { title, body } = buildNotification(env);
                  notify(title, body);
                  if (cfg.ntfyUrl) notifyNtfy(cfg.ntfyUrl, title, body);
                }
              }
            }
          }
        } catch (err) {
          log(`WARN: notify failed (non-fatal): ${err.message}`);
        }
        firstCycle = false;

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
