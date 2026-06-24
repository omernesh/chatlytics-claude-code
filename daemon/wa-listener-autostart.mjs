/**
 * wa-listener-autostart.mjs — SessionStart hook (singleton-guarded).
 *
 * Real-time WhatsApp inbox for the LIVE interactive CC session, the clean way:
 * NO daemon, NO listener subagent (subagents run in-process, can't be killed, and
 * render an ugly wrapper). Instead this hook injects an instruction telling the
 * main session to drive `wa-poll-once.mjs` as a background-task loop.
 *
 * SINGLETON: the bot updates queue has ONE consumer — two pollers split/lose
 * messages. A heartbeat lock (listener.lock {owner, ts}) lets only one session
 * own the listener. If another session is actively polling (fresh lock, different
 * owner) this hook injects nothing actionable, so this session starts no listener.
 *
 * FAIL-OPEN: any error -> exit 0, never block session start.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Per-user data lives under ~/.claude/whatsapp-cc/ (stable, independent of where
// this hook is installed). The poller is a SIBLING of this file, located via
// import.meta.url — so this works whether installed standalone in
// ~/.claude/whatsapp-cc/ OR bundled in the plugin at ${CLAUDE_PLUGIN_ROOT}/daemon/.
const DIR = path.join(os.homedir(), '.claude', 'whatsapp-cc');
const LOCK_FILE = path.join(DIR, 'listener.lock');
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wa-poll-once.mjs');
const FRESH_MS = 180000; // 3 min — tolerates a few missed poll cycles

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function emit(ctx) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx },
  }) + '\n');
}

try {
  let sessionId = 'unknown';
  try {
    const input = JSON.parse(readStdin() || '{}');
    if (input && typeof input.session_id === 'string' && input.session_id) sessionId = input.session_id;
  } catch { /* ignore */ }

  let lock = null;
  try { lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { lock = null; }
  const now = Date.now();
  const fresh = lock && typeof lock.ts === 'number' && (now - lock.ts) < FRESH_MS;

  // Another session is actively listening -> do NOT start a second consumer.
  if (fresh && lock.owner && lock.owner !== sessionId) {
    emit('WhatsApp inbox: a listener is already active in another Claude Code session, '
      + 'so THIS session is NOT starting one (single-consumer rule — two pollers would split/lose messages). '
      + 'Do not run wa-poll-once.mjs, the old daemon, or a listener subagent here. '
      + 'The lock self-expires ~3 min after the other session stops polling.');
    process.exit(0);
  }

  // Free / stale / already ours -> claim and start.
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ owner: sessionId, ts: now }));
  } catch { /* fail-open */ }

  emit([
    `WhatsApp inbox listener — you are the active listener owner for this machine (session ${sessionId}).`,
    'Start the real-time inbox NOW and keep it running while this session is active:',
    `1. Launch a background task: node "${SCRIPT}" "" "${sessionId}"  (run_in_background).`,
    '2. When it completes, Read its output file — it prints one JSON line {lines, cursor, count}.',
    '3. Print the inbound wrapped in a NOTICEABLE frame so it stands out from your other output, exactly like this (horizontal rule, the lines, horizontal rule):',
    '   ────────────────────────────────────────',
    '   📱 <each entry of `lines`, one per row, verbatim>',
    '   ────────────────────────────────────────',
    '   The `lines` are already clean (`whatsapp message from <name>: "..."`). Never show the raw JSON or any agent-message wrapper.',
    '4. IMMEDIATELY relaunch the same background task. Always keep exactly ONE poll in flight, even while doing other work.',
    'You are the ONLY consumer of the WhatsApp queue: do NOT also start the daemon or a listener subagent (subagents zombie + render an ugly wrapper). The script self-manages the cursor (poll-cursor.json) and heartbeats the singleton lock. Architecture: memory whatsapp-in-cc-skills.',
  ].join('\n'));
  process.exit(0);
} catch {
  process.exit(0);
}
