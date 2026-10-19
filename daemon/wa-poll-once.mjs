/**
 * wa-poll-once.mjs — WhatsApp inbox listener: bot stream + resolve + format.
 *
 * v3.0.0 (chatlytics#793 Phase 4): receives over the chatlytics bot WebSocket
 * stream (`/api/v1/bot/stream`, subprotocol `chatlytics.bot.v1`) instead of
 * long-poll. Holds the socket until envelopes arrive, resolves each sender's
 * display name (LID -> phone -> directory), formats each envelope into a clean
 * line, and prints ONE json object {lines, cursor, count} to stdout then exits
 * — but ONLY when there are lines to deliver (or after ~18 min idle, or on a
 * surfaced error). Idle time is a held socket (server pings every 30 s), so
 * the CC session stays dormant until a real message arrives.
 *
 * ACK TIMING (at-least-once, never drop): the stream ack for a batch is sent
 * only AFTER its JSON line has been written to stdout — the hand-off to the
 * CC session. The printed cursor is also persisted (poll-cursor.json) and sent
 * as `ready.cursor` on the next launch, so an ack lost to a crash is still
 * honoured (the server resumes from max(server, client)). Ids of printed
 * envelopes are persisted too (last 2000 / 24 h) so a redelivery after a crash
 * is acked without being shown twice.
 *
 * CHATLYTICS_TRANSPORT = auto (default) | stream | longpoll — same contract as
 * the MCP server: auto falls back to the v2.x long-poll loop ONLY on 404/426
 * and re-probes every 600 s; transient failures back off and retry the stream.
 *
 * Run as a BACKGROUND task: when it exits with lines, the CC session is
 * re-invoked, prints `lines` verbatim (already clean — no raw envelope, no
 * wrapper), and relaunches. The singleton lock is heartbeated while running.
 *
 * Shipped as daemon/wa-poll-once.bundle.mjs (esbuild, `ws` inlined) so it runs
 * with no node_modules next to it. Build: `npm --prefix servers run build`.
 *
 * Usage: node wa-poll-once.bundle.mjs "<cursor>" "<ownerSessionId>"   (both optional)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  CLOSE_SUPERSEDED,
  DedupeCache,
  HEALTHY_RESET_MS,
  STREAM_REPROBE_MS,
  parseTransport,
  reconnectDelay,
  runStreamOnce,
} from '../servers/lib/stream.mjs';

const TOKEN = (process.env.CHATLYTICS_BOT_TOKEN && process.env.CHATLYTICS_BOT_TOKEN.trim()) || '';
const API = ((process.env.CHATLYTICS_API_URL && process.env.CHATLYTICS_API_URL.trim()) || 'https://node.chatlytics.ai')
  .replace(/\/+$/, '');
const DIR = path.join(os.homedir(), '.claude', 'whatsapp-cc');
const CURSOR_FILE = path.join(DIR, 'poll-cursor.json');
const LOCK_FILE = path.join(DIR, 'listener.lock');
const owner = (process.argv[3] || '').trim();

// Resolve cursor: explicit arg wins, else the persisted cursor file, else empty.
let cursor = (process.argv[2] || '').trim();
if (!cursor) {
  try { cursor = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')).cursor || ''; } catch { cursor = ''; }
}

// Heartbeat the singleton lock so other sessions' SessionStart guard sees an
// active listener and won't start a second consumer. Preserve the owner the
// autostart hook claimed; only refresh ts. Fail-open. Called each poll cycle.
function heartbeat() {
  try {
    let prevOwner = owner || 'unknown';
    try { prevOwner = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).owner || prevOwner; } catch {}
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ owner: prevOwner, ts: Date.now() }));
  } catch { /* fail-open */ }
}

const H = { Authorization: `Bearer ${TOKEN}`, Connection: 'close' };
const nameCache = new Map();

// fetch with a CLEARABLE timeout. AbortSignal.timeout() leaves a pending timer
// that, on Windows, makes process.exit() trip a libuv assertion (exit 9) during
// teardown. A manual AbortController + clearTimeout has no lingering handle.
async function fetchT(url, ms, init) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, headers: { ...H, ...(init && init.headers) }, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// Drain the server-side delivery queue up to `cur` (POST /bot/updates/ack {cursor}).
// Called on startup with the LAST-delivered cursor — i.e. envelopes already shown
// to the user on the previous run. This is at-least-once: we never ack a message
// before it has been rendered, so a crash can re-deliver but never drop. Without
// this the per-bot queue grows unboundedly (queue_depth backlog) and the backlog
// also makes GET return immediately instead of long-polling. Fail-open.
async function ackCursor(cur) {
  if (!cur) return;
  try {
    await fetchT(`${API}/api/v1/bot/updates/ack`, 8000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor: cur }),
    });
  } catch { /* fail-open */ }
}

function localPart(jid) {
  if (!jid) return '';
  const i = String(jid).indexOf('@');
  return i > 0 ? String(jid).slice(0, i) : String(jid);
}

// Skip session-id-shaped pushnames ("3cf11776_logan") and bare numbers.
function isBadName(n) {
  if (!n) return true;
  const s = String(n).trim();
  if (!s) return true;
  if (/^[0-9a-f]{6,}_/i.test(s)) return true;     // session-id shaped
  if (/^\+?[\d\s().-]+$/.test(s)) return true;     // pure phone/number
  return false;
}

async function jget(path, params) {
  const u = new URL(`${API}${path}`);
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetchT(u.toString(), 8000);
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

// LID/JID -> display name. Best-effort, fail-open to '' (caller falls back to digits).
async function resolveName(jid) {
  if (!jid) return '';
  if (nameCache.has(jid)) return nameCache.get(jid);
  let name = '';
  try {
    let searchTerm = localPart(jid);
    // @lid is not directly in the directory — hop via a message to get the phone.
    if (String(jid).includes('@lid')) {
      const j = await jget('/api/v1/messages', { chatId: jid, limit: 1 });
      const msgs = j?.messages ?? j?.data?.messages ?? (Array.isArray(j) ? j : []);
      const alt = msgs?.[0]?._data?.key?.remoteJidAlt ?? msgs?.[0]?.remoteJidAlt ?? '';
      if (alt && String(alt).includes('@')) searchTerm = localPart(alt);
    }
    const d = await jget('/api/v1/directory', { search: searchTerm });
    const contacts = d?.contacts ?? d?.data?.contacts ?? [];
    const hit = contacts.find(c => localPart(c.jid) === searchTerm) ?? contacts[0];
    const cand = hit?.displayName ?? hit?.name ?? '';
    if (!isBadName(cand)) name = String(cand).trim();
  } catch { /* fail-open */ }
  nameCache.set(jid, name);
  return name;
}

function stripSecurity(text) {
  if (!text) return '';
  const lines = String(text).split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trimStart().startsWith('[SECURITY:')) i++;
  return lines.slice(i).join('\n').trim();
}

async function formatEnvelope(env) {
  const senderJid = env.sender_jid ?? env.entity_jid ?? '';
  let sender = (env.sender_name && String(env.sender_name).trim()) || '';
  if (!sender) sender = (await resolveName(senderJid)) || localPart(senderJid) || 'unknown';
  const text = stripSecurity(env.text ?? '');
  const editTag = env.edited === true ? ' (edited)' : '';
  if (env.chat_type === 'group') {
    let grp = (env.chat_name && String(env.chat_name).trim()) || '';
    if (!grp) grp = (await resolveName(env.entity_jid)) || localPart(env.entity_jid) || 'group';
    return `whatsapp message from ${sender}${editTag} in ${grp}: "${text}"`;
  }
  return `whatsapp message from ${sender}${editTag}: "${text}"`;
}

async function pollOnce(cur) {
  const params = { timeout_ms: 55000 };
  if (cur) params.cursor = cur;
  const u = new URL(`${API}/api/v1/bot/updates`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));

  const res = await fetchT(u.toString(), 60000);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { lines: [], cursor: cur, count: 0, error: `http ${res.status} ${body.slice(0, 120)}` };
  }
  const p = await res.json();
  const envelopes = Array.isArray(p.envelopes) ? p.envelopes : [];
  const newCursor = typeof p.cursor === 'string' ? p.cursor : cur;
  try { fs.writeFileSync(CURSOR_FILE, JSON.stringify({ cursor: newCursor, ts: Date.now() })); } catch { /* fail-open */ }
  const lines = [];
  for (const env of envelopes) {
    try { lines.push(await formatEnvelope(env)); } catch { /* skip one bad envelope */ }
  }
  return { lines, cursor: newCursor, count: lines.length };
}

// v2.x long-poll loop — kept verbatim for `CHATLYTICS_TRANSPORT=longpoll` and
// for the auto fallback while the server has no stream route (404/426).
// Loops internally: only RETURNS when there are lines to deliver, on an error
// worth surfacing, or at `deadline` (null). Empty cycles re-poll.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_INTERVAL_MS = 2000;

async function longPollLoop(deadline) {
  // Ack what was already delivered last run, draining the server queue.
  await ackCursor(cursor);
  while (Date.now() < deadline) {
    heartbeat();
    let res;
    try { res = await pollOnce(cursor); }
    catch (e) { return { lines: [], cursor, count: 0, error: String((e && e.message) || e) }; }
    cursor = res.cursor;
    if (res.count > 0) return res;       // deliver
    if (res.error) return res;           // surface auth/HTTP errors instead of looping on them
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

// ---------------------------------------------------------------------------
// v3.0.0 stream path
// ---------------------------------------------------------------------------

const VERSION = '3.0.0';
// Coalesce a burst into one hand-off: print once the stream has been quiet for
// QUIET_MS after the last new envelope (at most COALESCE_MAX_MS after the
// first). A burst that fits the window is then handed off whole, so nothing is
// sent-but-not-printed when we close (that would burn a delivery attempt —
// the server dead-letters at 3).
const QUIET_MS = 400;
const COALESCE_MAX_MS = 2000;
const DAEMON_MAX_INFLIGHT = 64;
// How long to wait for `acked` after printing before closing anyway (the
// persisted cursor covers a lost ack on the next launch).
const ACKED_WAIT_MS = 3000;

function loadState() {
  try { return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')) || {}; } catch { return {}; }
}

function saveState(cur, dedupe) {
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(CURSOR_FILE, JSON.stringify({ cursor: cur, ts: Date.now(), ids: dedupe.entries() }));
  } catch { /* fail-open */ }
}

function writeStdout(line) {
  return new Promise((resolve) => {
    try { process.stdout.write(line + '\n', () => resolve()); } catch { resolve(); }
  });
}

/**
 * Serve the stream until something is delivered (printed), a terminal answer
 * arrives, or `deadline`. Reconnects per the §3.6 contract in between.
 * Returns {kind: 'delivered'|'deadline'|'unavailable'|'auth', ...}.
 */
async function streamSession(deadline, dedupe) {
  let attempt = 0;
  let supersededStreak = 0;
  while (Date.now() < deadline) {
    heartbeat();
    const ac = new AbortController();
    const untilDeadline = setTimeout(() => ac.abort(), Math.max(0, deadline - Date.now()));
    const beat = setInterval(heartbeat, 60_000);
    let pending = [];          // frames received, not yet handed off (seq order)
    let flushTimer = null;
    let firstAt = 0;
    let flushing = null;       // promise of the hand-off in progress
    let delivered = false;
    let ackedWaiter = null;

    const flush = (conn) => {
      flushTimer = null;
      const batch = pending.splice(0);
      const fresh = batch.filter((f) => !f.dup);
      if (fresh.length === 0) return;
      const last = batch[batch.length - 1];
      flushing = (async () => {
        const lines = [];
        for (const f of fresh) {
          try { lines.push(await formatEnvelope(f.envelope)); } catch { /* skip one bad envelope */ }
          if (f.id) dedupe.add(f.id);
        }
        cursor = last.cursor;
        saveState(cursor, dedupe);                     // resume point survives a crash
        await writeStdout(JSON.stringify({ lines, cursor, count: lines.length }));
        delivered = true;
        // ACK only after the hand-off line is written.
        let ackTimer = null;
        const acked = new Promise((r) => { ackedWaiter = r; ackTimer = setTimeout(r, ACKED_WAIT_MS); });
        if (conn.ack(last.cursor)) await acked;
        clearTimeout(ackTimer);
        conn.close(1000, 'delivered');
      })().catch(() => { conn.close(1000, 'delivered'); });
    };

    const outcome = await runStreamOnce({
      baseUrl: API,
      token: TOKEN,
      userAgent: `chatlytics-claude-code-inbox/${VERSION}`,
      cursor: cursor || undefined,
      caps: [],
      maxInflight: DAEMON_MAX_INFLIGHT,
      signal: ac.signal,
      onEnv: (frame, conn) => {
        if (delivered || flushing) return;        // closing; anything later is redelivered
        if (typeof frame.cursor !== 'string' || !frame.cursor) return;
        const dup = typeof frame.id === 'string' && dedupe.seen(frame.id);
        if (dup && pending.length === 0) {
          // Already shown on an earlier run: ack it, nothing to print.
          cursor = frame.cursor;
          conn.ack(frame.cursor);
          saveState(cursor, dedupe);
          return;
        }
        pending.push({ id: frame.id, cursor: frame.cursor, envelope: frame.envelope, dup });
        if (dup && !firstAt) return;
        if (!firstAt) firstAt = Date.now();
        clearTimeout(flushTimer);
        const wait = Math.max(0, Math.min(QUIET_MS, firstAt + COALESCE_MAX_MS - Date.now()));
        flushTimer = setTimeout(() => flush(conn), wait);
      },
      onAcked: () => { ackedWaiter?.(); },
    });
    clearTimeout(untilDeadline);
    clearInterval(beat);
    clearTimeout(flushTimer);
    if (flushing) await flushing;
    if (delivered) return { kind: 'delivered' };
    if (Date.now() >= deadline || outcome.error === 'stopped') return { kind: 'deadline' };
    if (outcome.unavailable) return { kind: 'unavailable', status: outcome.httpStatus };
    if (outcome.authRejected) return { kind: 'auth', detail: outcome.describe() };

    if (outcome.connectedMs >= HEALTHY_RESET_MS) attempt = 0;
    if (outcome.closeCode === CLOSE_SUPERSEDED) supersededStreak += 1;
    else if (outcome.connectedMs >= HEALTHY_RESET_MS) supersededStreak = 0;
    const delay = reconnectDelay(outcome, attempt, supersededStreak);
    attempt += 1;
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
  }
  return { kind: 'deadline' };
}

// Loop ~18 min, then yield back to the CC session (idle refresh).
const MAX_MS = 18 * 60 * 1000;

async function main() {
  if (!TOKEN) {
    return { lines: [], cursor, count: 0, error: 'CHATLYTICS_BOT_TOKEN not set' };
  }
  const transport = parseTransport(process.env.CHATLYTICS_TRANSPORT);
  const deadline = Date.now() + MAX_MS;
  if (transport === 'longpoll') {
    return (await longPollLoop(deadline)) || { lines: [], cursor, count: 0, idle: true };
  }
  const dedupe = new DedupeCache();
  dedupe.load(loadState().ids);
  while (Date.now() < deadline) {
    const r = await streamSession(deadline, dedupe);
    if (r.kind === 'delivered') return null; // already printed
    if (r.kind === 'deadline') break;
    if (r.kind === 'auth') {
      return { lines: [], cursor, count: 0, error: `stream rejected the bot token (${r.detail}) — verify CHATLYTICS_BOT_TOKEN, or resume the bot at https://app.chatlytics.ai` };
    }
    if (r.kind === 'unavailable') {
      if (transport === 'stream') {
        return { lines: [], cursor, count: 0, error: `CHATLYTICS_TRANSPORT=stream but the server has no stream route (HTTP ${r.status}); set CHATLYTICS_TRANSPORT=auto to use long-poll` };
      }
      // auto: long-poll until the re-probe, then try the stream again.
      const res = await longPollLoop(Math.min(deadline, Date.now() + STREAM_REPROBE_MS));
      if (res) return res;
    }
  }
  return { lines: [], cursor, count: 0, idle: true };
}

// NOTE: no process.exit() — on Windows, forcing exit while undici's HTTP handles
// are mid-close trips a libuv assertion (UV_HANDLE_CLOSING, exit 9). Returning and
// letting the event loop drain exits cleanly (code 0). Connection:close on the
// request (see fetchT) lets the socket close promptly so drain is fast.
try {
  const out = await main();
  if (out) console.log(JSON.stringify(out));
} catch (e) {
  console.log(JSON.stringify({ lines: [], cursor, count: 0, error: String((e && e.message) || e) }));
}
