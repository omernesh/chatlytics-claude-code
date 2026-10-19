// StreamInbox — the MCP server's background WebSocket consumer (v3.0.0).
//
// The MCP server holds ONE bot stream socket in the background and buffers
// envelopes in memory; `chatlytics_poll` returns from that buffer. Reconnect
// policy mirrors chatlytics-hermes 5.0.0 `_inbound_loop` exactly (see
// ./stream.mjs `reconnectDelay`).
//
// ACK TIMING — ack-on-return, NOT ack-on-receipt:
//   An envelope is acked only after `chatlytics_poll` has handed it to the
//   model (the tool result is built and returned; the ack frame is sent on
//   the next tick). Until then it stays unacked server-side, so if this
//   process dies with envelopes in the buffer the server redelivers them to
//   the next consumer — nothing held only in this process's memory can be
//   lost. This is the long-poll contract the plugin had (the server deleted
//   nothing until the client acked a cursor it had already received) and
//   design doc §9 ("acks once the tool result has been returned").
//
// BUFFER BOUND — enforced by the SERVER, not by spilling:
//   We send `ready.max_inflight = bufferMax`. The server never has more than
//   max_inflight unacked envelopes in flight to one socket, and nothing in
//   the buffer is acked, so the buffer can never exceed bufferMax. We
//   deliberately do NOT "spill oldest": acks are cumulative, so dropping an
//   envelope and later acking a newer one would delete the dropped envelope
//   server-side without anyone having seen it — a silent loss. A buffer that
//   somehow overflows anyway (a server bug) closes the socket instead; the
//   unacked envelopes are redelivered on resume.
//
// LAZY + IDLE RELEASE: the socket opens on the first `chatlytics_poll` call,
// not at boot. Every Claude Code session spawns its own MCP server process;
// connecting them all at boot would make every session a consumer and the
// server's newest-wins rule would flap them (4409) while messages queued into
// sessions that never read them. After `idleMs` without a poll AND with an
// empty buffer the socket is closed and the bot released. With envelopes
// still unread the socket is kept: each reconnect redelivers them with
// delivery_count+1, and the server dead-letters at 3 attempts.
//
// Control envelopes: `ready.caps` is [] — this plugin has never handled
// `kind: "control"` envelopes (long-poll never sent `caps=control`), so the
// server keeps discarding them for this consumer, unchanged.

import {
  CLOSE_SLOW_CONSUMER,
  CLOSE_SUPERSEDED,
  DedupeCache,
  HEALTHY_RESET_MS,
  MAX_INFLIGHT_CEIL,
  STREAM_AUTH_RETRY_MS,
  STREAM_FORCED_RETRY_MS,
  STREAM_REPROBE_MS,
  reconnectDelay,
  runStreamOnce,
} from "./stream.mjs";

export const DEFAULT_BUFFER_MAX = MAX_INFLIGHT_CEIL; // 256
export const DEFAULT_IDLE_MS = 10 * 60 * 1000;
/** Client close code for "my buffer overflowed" (4000-4999 = application). */
export const CLOSE_CLIENT_OVERFLOW = 4000;

export class StreamInbox {
  constructor({
    baseUrl,
    token,
    userAgent,
    transport = "auto",
    bufferMax = DEFAULT_BUFFER_MAX,
    idleMs = DEFAULT_IDLE_MS,
    reprobeMs = STREAM_REPROBE_MS,
    forcedRetryMs = STREAM_FORCED_RETRY_MS,
    authRetryMs = STREAM_AUTH_RETRY_MS,
    idleCheckMs = 30_000,
    log = () => {},
    runOnce = runStreamOnce,
    WebSocketImpl,
    now = () => Date.now(),
    rand = Math.random,
  }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.userAgent = userAgent;
    this.configured = transport;
    this.bufferMax = Math.max(1, Math.min(MAX_INFLIGHT_CEIL, Math.floor(bufferMax) || DEFAULT_BUFFER_MAX));
    this.maxInflight = this.bufferMax;
    this.idleMs = idleMs;
    this.reprobeMs = reprobeMs;
    this.forcedRetryMs = forcedRetryMs;
    this.authRetryMs = authRetryMs;
    this.idleCheckMs = idleCheckMs;
    this._log = log;
    this._runOnce = runOnce;
    this._WebSocketImpl = WebSocketImpl;
    this._now = now;
    this._rand = rand;

    this.dedupe = new DedupeCache();
    /** Unreturned envelopes on the CURRENT socket, seq order. */
    this.buffer = [];
    /** Highest cursor handed to the model: {cursor, seq}. */
    this.position = null;
    /** Cursor the server will have acked (sent or about to be sent). */
    this._ackedSeq = 0;
    this._hintCursor = null;
    this._serverAckedCursor = null;
    this._conn = null;
    this._connId = null;

    this.transport = transport === "longpoll" ? "longpoll" : "idle";
    this.detail = transport === "longpoll" ? "configured (transport: longpoll)" : "not started (opens on the first chatlytics_poll)";
    this.since = now();
    this.lastError = null;
    this.failingSince = null;
    this.authRejected = false;

    this._running = false;
    this._stopped = false;
    this._lastActivity = 0;
    this._idleRelease = false;
    this._waiters = new Set();
    this._sleepWake = null;
    this._ac = null;
    this._idleTimer = null;
    this._loopPromise = null;
  }

  // ---------------------------------------------------------------- status

  _setTransport(t, detail) {
    if (t !== this.transport) {
      this.transport = t;
      this.since = this._now();
    }
    this.detail = detail;
    this._notify();
  }

  status() {
    return {
      configured: this.configured,
      transport: this.transport,
      detail: this.detail,
      since: new Date(this.since).toISOString(),
      connected: !!this._conn?.open,
      conn_id: this._connId,
      buffered: this.buffer.filter((e) => !e.dup).length,
      max_inflight: this.maxInflight,
      last_error: this.lastError,
    };
  }

  /** True once the first attempt has an answer (or there is nothing to wait for). */
  get settled() {
    return this.transport === "stream" || this.transport === "longpoll" || this.transport === "stopped" || (this.transport === "starting" && this.lastError != null);
  }

  // --------------------------------------------------------------- control

  /** A chatlytics_poll call arrived: mark activity, start the loop if needed. */
  touch(hintCursor) {
    this._lastActivity = this._now();
    if (!this.position && typeof hintCursor === "string" && hintCursor) this._hintCursor = hintCursor;
    if (this.configured === "longpoll" || this._stopped) return;
    if (!this._running) this._start();
  }

  _active() {
    return this._now() - this._lastActivity < this.idleMs;
  }

  _start() {
    this._running = true;
    this._idleRelease = false;
    if (this.transport === "idle") this._setTransport("starting", "connecting");
    this._idleTimer = setInterval(() => this._idleCheck(), this.idleCheckMs);
    this._idleTimer.unref?.();
    this._loopPromise = this._loop()
      .catch((e) => this._log("error", `inbound loop crashed: ${e?.stack || e}`))
      .finally(() => {
        this._running = false;
        clearInterval(this._idleTimer);
        this._idleTimer = null;
        if (this._stopped) return;
        if (this.transport !== "stopped") {
          this._setTransport("idle", "released after inactivity (reopens on the next chatlytics_poll)");
        }
        // A poll that landed while the loop was winding down: serve it.
        if (this._active()) this._start();
      });
  }

  _idleCheck() {
    if (this._active()) return;
    if (this._conn?.open && this.buffer.length === 0) {
      this._idleRelease = true;
      this._log("info", `stream idle for ${Math.round(this.idleMs / 1000)}s with nothing buffered — releasing the bot`);
      this._conn.close(1000, "client idle");
    } else if (!this._conn) {
      this._idleRelease = true;
      this._wake();
    }
  }

  async stop() {
    this._stopped = true;
    this._ac?.abort();
    this._wake();
    clearInterval(this._idleTimer);
    try {
      await this._loopPromise;
    } catch {
      /* ignore */
    }
    this._notify();
  }

  _wake() {
    const w = this._sleepWake;
    this._sleepWake = null;
    w?.();
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, Math.max(0, ms));
      t.unref?.();
      function done() {
        clearTimeout(t);
        resolve();
      }
      this._sleepWake = done;
    });
  }

  /** Should the loop keep going after a connection ended / during a sleep? */
  _keepRunning() {
    if (this._stopped) return false;
    if (this._idleRelease) return false;
    return this._active();
  }

  // ------------------------------------------------------------ the buffer

  _notify() {
    for (const w of [...this._waiters]) w();
  }

  _readyCursor() {
    return this.position?.cursor || this._hintCursor || undefined;
  }

  _onEnv(frame, conn) {
    const id = typeof frame.id === "string" ? frame.id : null;
    const seq = Number(frame.seq);
    const cursor = typeof frame.cursor === "string" ? frame.cursor : null;
    if (!cursor || !Number.isFinite(seq)) return;
    if (id && this.dedupe.seen(id)) {
      // Already handed to the model. With nothing unreturned ahead of it the
      // cumulative ack is safe now; otherwise keep a placeholder so the ack
      // that covers the unreturned envelopes before it also covers it.
      if (this.buffer.length === 0) {
        this._advance(cursor, seq);
        this._sendAck(conn);
      } else {
        this.buffer.push({ seq, cursor, id, envelope: null, dup: true });
      }
      return;
    }
    if (!frame.envelope || typeof frame.envelope !== "object") return;
    this.buffer.push({ seq, cursor, id, envelope: frame.envelope, dup: false });
    if (this.buffer.length > this.bufferMax) {
      // Cannot happen while the server honours max_inflight (nothing here is
      // acked). Never drop: close, let the server redeliver on resume.
      this._log("warn", `stream buffer exceeded ${this.bufferMax} (server sent past max_inflight) — reconnecting; nothing is dropped`);
      conn.close(CLOSE_CLIENT_OVERFLOW, "client buffer full");
      return;
    }
    this._notify();
  }

  _advance(cursor, seq) {
    if (!this.position || seq >= this.position.seq) this.position = { cursor, seq };
  }

  _sendAck(conn = this._conn) {
    if (!this.position || this.position.seq <= this._ackedSeq) return;
    if (conn?.ack(this.position.cursor)) this._ackedSeq = this.position.seq;
    // Socket down: `position` goes out as ready.cursor on the next connect —
    // the server resumes from max(server, client), trusting the client.
  }

  hasDeliverable() {
    return this.buffer.some((e) => !e.dup);
  }

  /** Resolve when there is something to return, the transport changes, or `ms` elapses. */
  waitFor(predicate, ms) {
    if (predicate()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const check = () => {
        if (predicate()) finish(true);
      };
      const t = setTimeout(() => finish(false), Math.max(0, ms));
      t.unref?.();
      const finish = (v) => {
        clearTimeout(t);
        this._waiters.delete(check);
        resolve(v);
      };
      this._waiters.add(check);
    });
  }

  whenSettled(ms) {
    return this.waitFor(() => this.settled, ms);
  }

  waitForEnvelopes(ms) {
    return this.waitFor(() => this.hasDeliverable() || this.transport === "longpoll" || this.transport === "stopped", ms);
  }

  /**
   * Hand everything buffered to the caller. The caller returns it to the
   * model, THEN calls `ackDelivered()` (ack-on-return).
   */
  take() {
    const entries = this.buffer.splice(0);
    const envelopes = [];
    for (const e of entries) {
      if (e.dup) continue;
      envelopes.push(e.envelope);
      if (e.id) this.dedupe.add(e.id);
    }
    if (entries.length > 0) {
      const last = entries[entries.length - 1];
      this._advance(last.cursor, last.seq);
    }
    const cursor = this.position?.cursor || this._serverAckedCursor || this._hintCursor || null;
    return { envelopes, cursor };
  }

  ackDelivered() {
    this._sendAck();
  }

  // -------------------------------------------------------------- the loop

  async _loop() {
    let attempt = 0;
    let supersededStreak = 0;
    let lastFailureClass = null;
    let fallbackLogged = false;
    while (this._keepRunning()) {
      this._ac = new AbortController();
      const outcome = await this._runOnce({
        baseUrl: this.baseUrl,
        token: this.token,
        userAgent: this.userAgent,
        cursor: this._readyCursor(),
        caps: [],
        maxInflight: this.maxInflight,
        signal: this._ac.signal,
        WebSocketImpl: this._WebSocketImpl,
        log: this._log,
        onOpen: (hello, conn) => {
          this._conn = conn;
          this._connId = hello.conn_id ?? null;
          if (typeof hello.server_acked_cursor === "string") this._serverAckedCursor = hello.server_acked_cursor;
          this.lastError = null;
          this.failingSince = null;
          this.authRejected = false;
          const changed = this.transport !== "stream";
          this._setTransport("stream", `connected (conn_id=${hello.conn_id})`);
          if (changed) this._log("info", `inbound: STREAM connected (conn_id=${hello.conn_id}, max_inflight=${this.maxInflight})`);
        },
        onEnv: (frame, conn) => this._onEnv(frame, conn),
      });
      this._conn = null;
      this._connId = null;
      // Every unreturned envelope is unacked: the server redelivers it on
      // resume (same id — the dedupe cache keeps the model from seeing one
      // twice). Placeholders for already-returned ids go too.
      this.buffer.length = 0;
      if (this._stopped) return;
      if (this._idleRelease && outcome.hello) return;

      if (outcome.unavailable) {
        if (this.configured === "auto") {
          this._setTransport("longpoll", `stream unavailable (HTTP ${outcome.httpStatus}); re-probing every ${Math.round(this.reprobeMs / 1000)}s`);
          if (!fallbackLogged) {
            this._log("info", `inbound: stream not enabled on this server (HTTP ${outcome.httpStatus}) — using long-poll; re-probing every ${Math.round(this.reprobeMs / 1000)}s`);
            fallbackLogged = true;
          }
          await this._sleep(this.reprobeMs);
          attempt = 0;
          continue;
        }
        this.lastError = outcome.describe();
        this._setTransport("stopped", `transport is 'stream' but the server has no stream route (HTTP ${outcome.httpStatus}); retrying every ${Math.round(this.forcedRetryMs / 1000)}s`);
        this._log("error", `inbound: transport is 'stream' but the server has no stream route (HTTP ${outcome.httpStatus}) — NOT receiving. Set CHATLYTICS_TRANSPORT=auto to fall back to long-poll.`);
        await this._sleep(this.forcedRetryMs);
        continue;
      }

      if (outcome.authRejected) {
        this.authRejected = true;
        this.lastError = outcome.describe();
        this._setTransport("stopped", `token rejected (${outcome.describe()})`);
        this._log(
          "error",
          `inbound: bot token REJECTED by the stream (${outcome.describe()}) — stopped; re-checking every ${Math.round(this.authRetryMs / 1000)}s. ` +
            `Verify CHATLYTICS_BOT_TOKEN, or resume the bot at https://app.chatlytics.ai → Bots.`,
        );
        await this._sleep(this.authRetryMs);
        attempt = 0;
        continue;
      }

      // A normal / transient ending: reconnect.
      if (outcome.connectedMs >= HEALTHY_RESET_MS) attempt = 0;
      if (outcome.closeCode === CLOSE_SUPERSEDED) {
        supersededStreak += 1;
        this._log(
          "warn",
          `inbound: stream SUPERSEDED (4409) — another consumer connected with this bot token ` +
            `(another Claude Code session polling, the inbox listener, or a second gateway?). Backing off before reclaiming (streak ${supersededStreak}).`,
        );
      } else if (outcome.connectedMs >= HEALTHY_RESET_MS) {
        supersededStreak = 0;
      }
      if (outcome.closeCode === CLOSE_SLOW_CONSUMER) {
        this.maxInflight = Math.max(1, Math.floor(this.maxInflight / 2));
      }
      const delay = reconnectDelay(outcome, attempt, supersededStreak, this._rand);
      attempt += 1;
      const failure = outcome.describe();
      this.lastError = failure;
      if (outcome.hello) {
        this.failingSince = null;
        this._setTransport("stream", `reconnecting after ${failure}`);
        this._log("info", `inbound: stream disconnected (${failure}, up ${Math.round(outcome.connectedMs / 1000)}s) — reconnecting in ${(delay / 1000).toFixed(1)}s`);
        lastFailureClass = null;
      } else {
        if (this.failingSince == null) this.failingSince = this._now();
        if (this.transport !== "longpoll") this._setTransport(this.transport === "idle" ? "starting" : this.transport, `stream attempt failed: ${failure}`);
        const cls = failure.split(" (")[0];
        if (cls !== lastFailureClass) {
          this._log("warn", `inbound: stream attempt failed: ${failure} — retrying in ${(delay / 1000).toFixed(1)}s (transient; not falling back to long-poll)`);
        }
        lastFailureClass = cls;
      }
      await this._sleep(delay);
    }
  }
}
