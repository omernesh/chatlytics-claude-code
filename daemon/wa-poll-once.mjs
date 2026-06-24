/**
 * wa-poll-once.mjs — WhatsApp inbox long-poll loop + resolve + format.
 *
 * Long-polls the chatlytics bot updates endpoint in an INTERNAL loop, resolves
 * each sender's display name (LID -> phone -> directory), formats each envelope
 * into a clean line, and prints ONE json object {lines, cursor, count} to stdout
 * then exits — but ONLY when there are lines to deliver (or after ~20 min idle,
 * or on a surfaced error). Empty cycles re-poll internally so the CC session
 * stays dormant (no context bloat) until a real message arrives.
 *
 * Run as a BACKGROUND task: when it exits with lines, the CC session is
 * re-invoked, prints `lines` verbatim (already clean — no raw envelope, no
 * wrapper), and relaunches. The cursor is self-managed via poll-cursor.json and
 * the singleton lock is heartbeated each cycle.
 *
 * Usage: node wa-poll-once.mjs "<cursor>" "<ownerSessionId>"   (both optional)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

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

// Loop internally: long-poll repeatedly, only RETURN (exit the process → wake the
// CC session) when there are lines to deliver, on an error worth surfacing, or
// after MAX_CYCLES (~20 min) to refresh + avoid an indefinitely stuck background
// task. Empty cycles just re-poll, so the CC session stays DORMANT (no context
// bloat) until a real message arrives. Each long-poll blocks ~55s server-side,
// so there is no tight spin.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!TOKEN) {
    return { lines: [], cursor, count: 0, error: 'CHATLYTICS_BOT_TOKEN not set' };
  }
  // The chatlytics /bot/updates endpoint returns IMMEDIATELY — it does NOT hold
  // the connection for timeout_ms (measured ~0.4s). So pace polls with a sleep
  // rather than relying on a server-side long-poll. Loop ~18 min, then yield back
  // to the CC session (idle refresh). ~5s poll cadence = ~5s worst-case latency.
  const MAX_MS = 18 * 60 * 1000;
  const POLL_INTERVAL_MS = 2000;
  const start = Date.now();
  let cur = cursor;
  // Ack what was already delivered last run, draining the server queue. Once the
  // queue is truly empty, GET long-polls (blocks ≤ timeout_ms) → near-zero latency.
  await ackCursor(cur);
  while (Date.now() - start < MAX_MS) {
    heartbeat();
    let res;
    try { res = await pollOnce(cur); }
    catch (e) { return { lines: [], cursor: cur, count: 0, error: String((e && e.message) || e) }; }
    cur = res.cursor;
    if (res.count > 0) return res;       // deliver
    if (res.error) return res;           // surface auth/HTTP errors instead of looping on them
    await sleep(POLL_INTERVAL_MS);
  }
  return { lines: [], cursor: cur, count: 0, idle: true };
}

// NOTE: no process.exit() — on Windows, forcing exit while undici's HTTP handles
// are mid-close trips a libuv assertion (UV_HANDLE_CLOSING, exit 9). Returning and
// letting the event loop drain exits cleanly (code 0). Connection:close on the
// request (see fetchT) lets the socket close promptly so drain is fast.
try {
  const out = await main();
  console.log(JSON.stringify(out));
} catch (e) {
  console.log(JSON.stringify({ lines: [], cursor, count: 0, error: String((e && e.message) || e) }));
}
