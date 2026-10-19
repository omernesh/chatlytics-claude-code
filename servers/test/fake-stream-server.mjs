// Local fake of the chatlytics bot stream (`/api/v1/bot/stream`,
// `chatlytics.bot.v1`) for tests. Speaks the server side of the protocol
// closely enough to exercise every client branch: hello → ready → env/ack,
// cumulative acks, redelivery of unacked envelopes on reconnect, reconnect
// frames + close codes, and refused upgrades (plain HTTP statuses).

import { createServer } from "node:http";
import { WebSocketServer } from "ws";

export const SUBPROTOCOL = "chatlytics.bot.v1";

export function cursorFor(seq) {
  return Buffer.from(JSON.stringify({ fp: "sk_bot_fake…", seq })).toString("base64url");
}
export function seqOf(cursor) {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")).seq;
  } catch {
    return null;
  }
}

/**
 * opts.refuse(req) → null | { status, headers? }  — refuse the upgrade.
 * opts.onReady(conn, ready) — called once per connection after `ready`.
 * opts.autoPump (default true) — send queued envelopes up to max_inflight.
 * opts.http(req, res) → bool — optional plain-HTTP handler (long-poll mock).
 */
export async function startFakeStreamServer(opts = {}) {
  const state = {
    queue: [], // { seq, id, envelope, deliveryCount }
    nextSeq: 1,
    serverAcked: 0,
    upgrades: [], // { url, headers }
    readies: [],
    acks: [],
    events: [], // ordered log: "ack:<seq>", "env:<seq>", "ready", "close:<code>"
    conns: [],
    httpRequests: [],
  };
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });
  const server = createServer((req, res) => {
    state.httpRequests.push({ method: req.method, url: req.url, headers: req.headers });
    if (opts.http && opts.http(req, res, state)) return;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  server.on("upgrade", (req, socket, head) => {
    state.upgrades.push({ url: req.url, headers: req.headers });
    const refusal = opts.refuse ? opts.refuse(req, state) : null;
    if (refusal) {
      const extra = Object.entries(refusal.headers || {})
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("");
      socket.end(`HTTP/1.1 ${refusal.status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n${extra}\r\n`);
      return;
    }
    if (!req.url.startsWith("/api/v1/bot/stream")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
  });

  function onConnection(ws, req) {
    const conn = { ws, req, sentSeq: 0, ackedSeq: 0, maxInflight: 32, ready: null, inflight: new Set() };
    state.conns.push(conn);
    conn.send = (f) => ws.send(JSON.stringify(f));
    conn.pump = () => {
      if (!conn.ready) return;
      for (const e of state.queue) {
        if (e.seq <= conn.sentSeq) continue;
        if (conn.inflight.size >= conn.maxInflight) break;
        conn.sentSeq = e.seq;
        conn.inflight.add(e.seq);
        e.deliveryCount += 1;
        state.events.push(`env:${e.seq}`);
        conn.send({ t: "env", seq: e.seq, cursor: cursorFor(e.seq), id: e.id, envelope: e.envelope, delivery_count: e.deliveryCount });
      }
    };
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString("utf8"));
      if (f.t === "ready") {
        conn.ready = f;
        state.readies.push(f);
        state.events.push("ready");
        conn.maxInflight = f.max_inflight || 32;
        const clientSeq = f.cursor ? seqOf(f.cursor) || 0 : 0;
        conn.sentSeq = Math.max(state.serverAcked, clientSeq);
        conn.ackedSeq = conn.sentSeq;
        if (opts.onReady) opts.onReady(conn, f, state);
        if (opts.autoPump !== false) conn.pump();
      } else if (f.t === "ack") {
        const seq = seqOf(f.cursor);
        state.acks.push(seq);
        state.events.push(`ack:${seq}`);
        const upTo = Math.min(seq, conn.sentSeq);
        let acked = 0;
        if (upTo > conn.ackedSeq) {
          const before = state.queue.length;
          state.queue = state.queue.filter((e) => e.seq > upTo);
          acked = before - state.queue.length;
          conn.ackedSeq = upTo;
          state.serverAcked = Math.max(state.serverAcked, upTo);
        }
        for (const s of [...conn.inflight]) if (s <= upTo) conn.inflight.delete(s);
        conn.send({ t: "acked", cursor: cursorFor(Math.max(upTo, conn.ackedSeq)), acked });
        if (opts.autoPump !== false) conn.pump();
      }
    });
    ws.on("close", (code) => state.events.push(`close:${code}`));
    conn.send({
      t: "hello",
      v: 1,
      conn_id: `c${state.conns.length}`,
      bot_fp: "sk_bot_fake…",
      session_id: "s1",
      heartbeat_ms: 30000,
      max_inflight: 32,
      server_acked_cursor: cursorFor(state.serverAcked),
      resume_hint_ms: 1000,
    });
    if (opts.onConnection) opts.onConnection(conn, state);
  }

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const api = {
    url: `http://127.0.0.1:${port}`,
    state,
    /** Enqueue an envelope; live connections are pumped. */
    enqueue(envelope, id) {
      const seq = state.nextSeq++;
      state.queue.push({ seq, id: id ?? `id-${seq}`, envelope, deliveryCount: 0 });
      for (const c of state.conns) if (c.ws.readyState === 1) c.pump();
      return seq;
    },
    live() {
      return state.conns.filter((c) => c.ws.readyState === 1);
    },
    async close() {
      for (const c of state.conns) {
        try {
          c.ws.terminate();
        } catch {
          /* ignore */
        }
      }
      wss.close();
      await new Promise((r) => server.close(r));
    },
  };
  return api;
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export async function until(pred, ms = 3000, step = 10) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await tick(step);
  }
  return false;
}
