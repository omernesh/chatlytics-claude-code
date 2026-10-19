// WebSocket bot stream transport — chatlytics `chatlytics.bot.v1` (v3.0.0).
//
// Transport ONLY: the wire protocol and the reconnect contract. It knows
// nothing about MCP or the inbox daemon. Mirrors chatlytics-hermes 5.0.0
// (`src/chatlytics_hermes/stream.py`) — same constants, same reconnect policy.
//
// Wire contract (server: chatlytics.ai `src/botstream/protocol.ts`; design
// `docs/architecture/bot-update-delivery-v2.md` §3):
//   - Upgrade with `Authorization: Bearer sk_bot_*` (header ONLY — a token in
//     the URL is refused) and subprotocol `chatlytics.bot.v1`. No compression.
//   - Server sends `hello`; we answer `ready {caps, cursor?, max_inflight?}`
//     within 10 s.
//   - Server sends one `env {seq, cursor, id, envelope, delivery_count}` per
//     envelope, at most `max_inflight` unacked at a time. `ack {cursor}` is
//     cumulative. Unacked envelopes are redelivered after a reconnect only
//     (no visibility timer on a live socket — D10).
//   - Server pings every 30 s (under Caddy's 120 s read_timeout). `ws`
//     answers pings automatically; we reconnect if nothing at all arrives for
//     75 s (watchdog).
//
// INV-02: the bearer is only ever placed in the upgrade header. Nothing here
// logs it.

import WebSocket from "ws";

export const SUBPROTOCOL = "chatlytics.bot.v1";
export const STREAM_PATH = "/api/v1/bot/stream";

/** Client watchdog: no ping and no frame for this long = dead socket (§3.2). */
export const WATCHDOG_MS = 75_000;
/** `hello` must arrive within this long after the upgrade. */
export const HELLO_TIMEOUT_MS = 15_000;
/** Upgrade handshake bound (DNS + TCP + TLS + HTTP 101). */
export const HANDSHAKE_TIMEOUT_MS = 30_000;
/** A connection that stayed up this long resets the backoff counter (§3.6). */
export const HEALTHY_RESET_MS = 60_000;
/** Full-jitter backoff (§3.6): random(0, min(30 s, 0.5 s * 2^n)). */
export const BACKOFF_CAP_MS = 30_000;
export const BACKOFF_BASE_MS = 500;
/** 4409 (another consumer took the socket): long escalating backoff. */
export const SUPERSEDED_BACKOFF_MS = 60_000;
export const SUPERSEDED_BACKOFF_CAP_MS = 300_000;
/** Fallback (404/426) re-probe cadence, `transport: auto`. */
export const STREAM_REPROBE_MS = 600_000;
/** `transport: stream` against a server with no stream route: retry cadence. */
export const STREAM_FORCED_RETRY_MS = 60_000;
/** 4401/4403/401/403: the bot is stopped; slow re-check (bot resumed?). */
export const STREAM_AUTH_RETRY_MS = 300_000;
/** Dedupe window (§3.6: at least the last 1,000 ids or 24 h). */
export const DEDUPE_MAX = 2000;
export const DEDUPE_TTL_MS = 24 * 3600 * 1000;
/** Server window ceiling (protocol.ts MAX_INFLIGHT_CEIL). */
export const MAX_INFLIGHT_CEIL = 256;

// §3.3 close codes.
export const CLOSE_NORMAL = 1000;
export const CLOSE_SERVICE_RESTART = 1012;
export const CLOSE_TRY_AGAIN_LATER = 1013;
export const CLOSE_PROTOCOL_ERROR = 4400;
export const CLOSE_TOKEN_INVALID = 4401;
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_SLOW_CONSUMER = 4408;
export const CLOSE_SUPERSEDED = 4409;

/**
 * Handshake statuses that mean "this server has no stream route" — the ONLY
 * answers that make `transport: auto` fall back to long-poll. 404 is the
 * server's flag-off answer (byte-identical to a missing route); 426 is an old
 * server that predates the subprotocol. Everything else (503/429/409/5xx/
 * transport error) is transient: back off and retry the stream.
 */
export const UNAVAILABLE_STATUSES = new Set([404, 426]);

export const TRANSPORTS = new Set(["auto", "stream", "longpoll"]);

/** Normalize a configured transport; unknown values (incl. an unexpanded `${…}`) → auto. */
export function parseTransport(raw, warn = () => {}) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return "auto";
  if (TRANSPORTS.has(v)) return v;
  warn(`transport ${JSON.stringify(String(raw).slice(0, 40))} is not one of auto/stream/longpoll — using 'auto'`);
  return "auto";
}

/** Bounded LRU of handled `env.id` values (count + age bound). */
export class DedupeCache {
  constructor(maxItems = DEDUPE_MAX, ttlMs = DEDUPE_TTL_MS, now = () => Date.now()) {
    this._items = new Map(); // id -> ts (insertion order = age order)
    this._max = maxItems;
    this._ttl = ttlMs;
    this._now = now;
  }
  seen(id) {
    const ts = this._items.get(id);
    if (ts === undefined) return false;
    if (this._now() - ts > this._ttl) {
      this._items.delete(id);
      return false;
    }
    return true;
  }
  add(id) {
    this._items.delete(id);
    this._items.set(id, this._now());
    while (this._items.size > this._max) {
      this._items.delete(this._items.keys().next().value);
    }
  }
  get size() {
    return this._items.size;
  }
  /** [[id, ts], ...] oldest first — for persisting (daemon). */
  entries() {
    return [...this._items.entries()];
  }
  load(entries) {
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number") this._items.set(e[0], e[1]);
    }
    while (this._items.size > this._max) this._items.delete(this._items.keys().next().value);
  }
}

/** §3.6 backoff: random(0, min(30 s, 0.5 s * 2^attempt)). */
export function fullJitter(attempt, rand = Math.random) {
  return rand() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
}

/**
 * Milliseconds to wait before the next stream attempt (non-terminal outcomes).
 * Same policy as chatlytics-hermes `reconnect_delay`:
 *   - 4409 superseded: long, escalating, jittered (60 s → 300 s cap).
 *   - `reconnect` frame then close (1012 deploy / token_rotated, 1013 …):
 *     after_ms + random(0, after_ms) — after_ms 0 reconnects now.
 *   - refused upgrade with Retry-After (409/429/503): that + up to 1 s, never
 *     below the jittered backoff.
 *   - otherwise full-jitter backoff; 4400 floors at 5–10 s (do not hot-loop).
 */
export function reconnectDelay(outcome, attempt, supersededStreak, rand = Math.random) {
  if (outcome.closeCode === CLOSE_SUPERSEDED) {
    const base = Math.min(SUPERSEDED_BACKOFF_CAP_MS, SUPERSEDED_BACKOFF_MS * 2 ** Math.max(0, supersededStreak - 1));
    return base + rand() * (base / 2);
  }
  if (outcome.reconnectAfterMs != null && outcome.closeCode != null) {
    const after = Math.max(0, outcome.reconnectAfterMs);
    return after + rand() * after;
  }
  if (outcome.retryAfterMs != null) {
    return Math.max(outcome.retryAfterMs + rand() * 1000, fullJitter(attempt, rand));
  }
  let delay = fullJitter(attempt, rand);
  if (outcome.closeCode === CLOSE_PROTOCOL_ERROR) delay = Math.max(delay, 5000 + rand() * 5000);
  return delay;
}

/** `https://host` → `wss://host/api/v1/bot/stream` (http → ws). */
export function streamUrl(baseUrl) {
  let base = String(baseUrl).replace(/\/+$/, "");
  if (base.startsWith("https://")) base = "wss://" + base.slice("https://".length);
  else if (base.startsWith("http://")) base = "ws://" + base.slice("http://".length);
  return base + STREAM_PATH;
}

function parseRetryAfterMs(headers) {
  const raw = headers?.["retry-after"];
  if (raw == null) return null;
  const n = Number(String(Array.isArray(raw) ? raw[0] : raw).trim());
  return Number.isFinite(n) && n >= 0 ? n * 1000 : null;
}

/** How one connection attempt ended. Drives the reconnect policy. */
export class StreamOutcome {
  constructor() {
    this.httpStatus = null; // refused upgrade
    this.retryAfterMs = null;
    this.closeCode = null; // websocket close code
    this.reconnectReason = null; // last `reconnect` frame
    this.reconnectAfterMs = null;
    this.error = null;
    this.hello = false;
    this.connectedMs = 0;
    this.envelopes = 0;
  }
  get unavailable() {
    return UNAVAILABLE_STATUSES.has(this.httpStatus);
  }
  get authRejected() {
    return this.httpStatus === 401 || this.httpStatus === 403 || this.closeCode === CLOSE_TOKEN_INVALID || this.closeCode === CLOSE_FORBIDDEN;
  }
  describe() {
    if (this.httpStatus != null) return `upgrade refused HTTP ${this.httpStatus}` + (this.error ? ` (${this.error})` : "");
    if (this.closeCode != null) {
      const extra = this.reconnectReason ? `, reconnect=${this.reconnectReason}` : "";
      return `closed ${this.closeCode}${extra}` + (this.error ? ` (${this.error})` : "");
    }
    return this.error || "disconnected";
  }
}

/**
 * Open ONE stream connection and serve it until it closes. Resolves (never
 * rejects) with a StreamOutcome for the caller's reconnect policy.
 *
 * Acking is the CALLER's decision — this function never acks on its own. The
 * `conn` handle passed to `onOpen`/`onEnv` exposes `ack(cursor)` (returns
 * false when the socket is no longer open) and `close(code, reason)`.
 *
 * opts: { baseUrl, token, userAgent, cursor?, caps (default []), maxInflight?,
 *         onOpen(hello, conn), onEnv(frame, conn), onAcked(frame), signal?,
 *         log?(level, msg), WebSocketImpl? (tests) }
 */
export function runStreamOnce(opts) {
  const {
    baseUrl,
    token,
    userAgent,
    cursor,
    caps = [],
    maxInflight,
    onOpen,
    onEnv,
    onAcked,
    signal,
    log = () => {},
    WebSocketImpl = WebSocket,
    watchdogMs = WATCHDOG_MS,
    helloTimeoutMs = HELLO_TIMEOUT_MS,
  } = opts;
  const outcome = new StreamOutcome();
  return new Promise((resolve) => {
    let settled = false;
    let openedAt = null;
    let watchdog = null;
    let helloTimer = null;
    let ws;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearTimeout(helloTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (openedAt != null) outcome.connectedMs = Date.now() - openedAt;
      resolve(outcome);
    };
    const conn = {
      ack(c) {
        if (!ws || ws.readyState !== WebSocketImpl.OPEN || typeof c !== "string" || !c) return false;
        try {
          ws.send(JSON.stringify({ t: "ack", cursor: c }));
          return true;
        } catch {
          return false;
        }
      },
      close(code = CLOSE_NORMAL, reason = "") {
        try {
          if (ws && (ws.readyState === WebSocketImpl.OPEN || ws.readyState === WebSocketImpl.CONNECTING)) ws.close(code, reason);
        } catch {
          /* ignore */
        }
      },
      get open() {
        return !!ws && ws.readyState === WebSocketImpl.OPEN;
      },
    };
    const onAbort = () => {
      if (!outcome.error) outcome.error = "stopped";
      conn.close(CLOSE_NORMAL, "client stopping");
      // If the close handshake hangs, do not wait for it.
      setTimeout(() => {
        try {
          ws?.terminate();
        } catch {
          /* ignore */
        }
      }, 2000).unref?.();
    };
    if (signal?.aborted) {
      outcome.error = "stopped";
      return finish();
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        outcome.error = `no ping or frame for ${Math.round(watchdogMs / 1000)}s (watchdog)`;
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }, watchdogMs);
      watchdog.unref?.();
    };

    try {
      ws = new WebSocketImpl(streamUrl(baseUrl), SUBPROTOCOL, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent },
        perMessageDeflate: false,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        maxPayload: 4 * 1024 * 1024,
      });
    } catch (e) {
      outcome.error = `transport error (${e?.message || e})`.slice(0, 300);
      return finish();
    }

    ws.on("unexpected-response", (_req, res) => {
      outcome.httpStatus = res.statusCode;
      outcome.retryAfterMs = parseRetryAfterMs(res.headers);
      const chunks = [];
      res.on("data", (c) => {
        if (chunks.length < 4) chunks.push(c);
      });
      const done = () => {
        const body = Buffer.concat(chunks).toString("utf8").replace(/\s+/g, " ").trim().slice(0, 200);
        if (body && !outcome.error) outcome.error = body;
        finish();
        // Release the request socket (ws leaves it to an unexpected-response listener).
        try {
          _req.destroy();
        } catch {
          /* ignore */
        }
      };
      res.on("end", done);
      res.on("close", done);
      res.on("error", done);
      setTimeout(done, 1000).unref?.();
    });
    ws.on("open", () => {
      openedAt = Date.now();
      alive();
      helloTimer = setTimeout(() => {
        if (!outcome.hello) {
          outcome.error = "no hello within deadline";
          conn.close(CLOSE_PROTOCOL_ERROR, "no hello");
        }
      }, helloTimeoutMs);
      helloTimer.unref?.();
    });
    ws.on("ping", alive);
    ws.on("pong", alive);
    ws.on("message", (raw, isBinary) => {
      alive();
      if (isBinary) return; // not part of chatlytics.bot.v1
      let frame;
      try {
        frame = JSON.parse(raw.toString("utf8"));
      } catch {
        log("warn", "stream: non-JSON frame ignored");
        return;
      }
      if (!frame || typeof frame !== "object") return;
      if (!outcome.hello) {
        if (frame.t !== "hello") {
          outcome.error = `first frame was not hello (t=${frame.t})`;
          conn.close(CLOSE_PROTOCOL_ERROR, "expected hello");
          return;
        }
        outcome.hello = true;
        clearTimeout(helloTimer);
        const ready = { t: "ready", caps: [...caps] };
        if (cursor) ready.cursor = cursor;
        if (maxInflight) ready.max_inflight = Math.max(1, Math.min(MAX_INFLIGHT_CEIL, Math.floor(maxInflight)));
        try {
          ws.send(JSON.stringify(ready));
        } catch (e) {
          outcome.error = `ready send failed (${e?.message || e})`;
          return;
        }
        try {
          onOpen?.(frame, conn);
        } catch (e) {
          log("warn", `stream: onOpen threw: ${e?.message || e}`);
        }
        return;
      }
      switch (frame.t) {
        case "env":
          outcome.envelopes += 1;
          try {
            onEnv?.(frame, conn);
          } catch (e) {
            log("warn", `stream: onEnv threw (seq=${frame.seq}): ${e?.message || e}`);
          }
          break;
        case "acked":
          try {
            onAcked?.(frame);
          } catch {
            /* ignore */
          }
          break;
        case "reconnect":
          outcome.reconnectReason = frame.reason ? String(frame.reason) : null;
          outcome.reconnectAfterMs = Number.isFinite(Number(frame.after_ms)) ? Number(frame.after_ms) : 0;
          break;
        case "error":
          outcome.error = `${frame.code}: ${String(frame.message || "").slice(0, 200)}`;
          log("warn", `stream: server error frame ${outcome.error}`);
          break;
        default:
          break; // unknown frame types are ignored (forward compat)
      }
    });
    ws.on("close", (code) => {
      if (outcome.httpStatus == null) outcome.closeCode = code;
      finish();
    });
    ws.on("error", (e) => {
      if (outcome.httpStatus == null && !outcome.error) outcome.error = `transport error (${e?.code || e?.message || e})`.slice(0, 300);
      // 'close' follows an 'error' once the socket existed; if it never opened
      // (DNS / refused / TLS) ws still emits 'close'. finish() is idempotent.
      if (ws.readyState === WebSocketImpl.CLOSED) finish();
    });
  });
}
