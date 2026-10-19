// Bot stream (chatlytics.bot.v1) client tests — run against a LOCAL fake
// WebSocket server (./fake-stream-server.mjs). No network, no real token.
//
//   node --test test/stream.test.mjs      (part of `npm test`)
//
// Every spawned child gets a SCRUBBED env (no CHATLYTICS_* from the developer
// machine) and a temp HOME, so a test can never connect to production with a
// real bot token or touch ~/.claude/whatsapp-cc.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLOSE_PROTOCOL_ERROR,
  CLOSE_SUPERSEDED,
  DedupeCache,
  StreamOutcome,
  fullJitter,
  parseTransport,
  reconnectDelay,
  runStreamOnce,
  streamUrl,
} from "../lib/stream.mjs";
import { StreamInbox, CLOSE_CLIENT_OVERFLOW } from "../lib/inbox.mjs";
import { startFakeStreamServer, cursorFor, seqOf, tick, until } from "./fake-stream-server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SRC = resolve(__dirname, "..", "chatlytics-mcp.js");
const DAEMON_BUNDLE = resolve(__dirname, "..", "..", "daemon", "wa-poll-once.bundle.mjs");
const TOKEN = "sk_bot_TEST_ONLY_not_a_real_token";

function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CHATLYTICS_")) env[k] = v;
  return { ...env, ...extra };
}

function makeInbox(fake, over = {}) {
  const logs = [];
  const inbox = new StreamInbox({
    baseUrl: fake.url,
    token: TOKEN,
    userAgent: "test/1",
    transport: "auto",
    log: (level, msg) => logs.push(`${level} ${msg}`),
    rand: () => 0, // deterministic: zero jitter
    ...over,
  });
  inbox.logs = logs;
  return inbox;
}

// --------------------------------------------------------------- pure logic

describe("reconnect policy (mirrors chatlytics-hermes reconnect_delay)", () => {
  const o = (fields) => Object.assign(new StreamOutcome(), fields);
  test("1012 + reconnect frame → after_ms + jitter(0..after_ms)", () => {
    assert.equal(reconnectDelay(o({ closeCode: 1012, reconnectAfterMs: 1000 }), 5, 0, () => 0), 1000);
    assert.equal(reconnectDelay(o({ closeCode: 1012, reconnectAfterMs: 1000 }), 5, 0, () => 0.999), 1999);
  });
  test("token_rotated (after_ms 0) → reconnect now", () => {
    assert.equal(reconnectDelay(o({ closeCode: 1012, reconnectReason: "token_rotated", reconnectAfterMs: 0 }), 3, 0, () => 0.7), 0);
  });
  test("4409 → long escalating backoff 60 s → 300 s cap", () => {
    assert.equal(reconnectDelay(o({ closeCode: CLOSE_SUPERSEDED }), 0, 1, () => 0), 60_000);
    assert.equal(reconnectDelay(o({ closeCode: CLOSE_SUPERSEDED }), 0, 2, () => 0), 120_000);
    assert.equal(reconnectDelay(o({ closeCode: CLOSE_SUPERSEDED }), 0, 9, () => 0), 300_000);
    assert.equal(reconnectDelay(o({ closeCode: CLOSE_SUPERSEDED }), 0, 1, () => 1), 90_000);
  });
  test("refused upgrade with Retry-After → Retry-After (+≤1 s), never below backoff floor", () => {
    assert.equal(reconnectDelay(o({ httpStatus: 503, retryAfterMs: 5000 }), 0, 0, () => 0), 5000);
    assert.equal(reconnectDelay(o({ httpStatus: 429, retryAfterMs: 0 }), 10, 0, () => 1), 30_000);
  });
  test("1013 / network → full jitter min(30 s, 0.5 s·2^n)", () => {
    assert.equal(reconnectDelay(o({ closeCode: 1013 }), 0, 0, () => 1), 500);
    assert.equal(reconnectDelay(o({ error: "transport error" }), 3, 0, () => 1), 4000);
    assert.equal(reconnectDelay(o({ error: "x" }), 20, 0, () => 1), 30_000);
    assert.ok(fullJitter(4) >= 0 && fullJitter(4) <= 8000);
  });
  test("4400 → floored at 5–10 s (no hot loop)", () => {
    assert.equal(reconnectDelay(o({ closeCode: CLOSE_PROTOCOL_ERROR }), 0, 0, () => 0), 5000);
  });
  test("outcome classification", () => {
    assert.ok(o({ httpStatus: 404 }).unavailable);
    assert.ok(o({ httpStatus: 426 }).unavailable);
    for (const s of [409, 429, 500, 503]) assert.ok(!o({ httpStatus: s }).unavailable, `${s} is transient`);
    for (const f of [{ httpStatus: 401 }, { httpStatus: 403 }, { closeCode: 4401 }, { closeCode: 4403 }]) assert.ok(o(f).authRejected);
    assert.ok(!o({ closeCode: 4409 }).authRejected);
  });
  test("transport parsing + URL", () => {
    assert.equal(parseTransport(undefined), "auto");
    assert.equal(parseTransport("STREAM"), "stream");
    assert.equal(parseTransport("longpoll"), "longpoll");
    assert.equal(parseTransport("${CHATLYTICS_TRANSPORT}"), "auto");
    assert.equal(streamUrl("https://node.chatlytics.ai/"), "wss://node.chatlytics.ai/api/v1/bot/stream");
    assert.equal(streamUrl("http://127.0.0.1:9"), "ws://127.0.0.1:9/api/v1/bot/stream");
  });
  test("dedupe cache: bounded by count and age", () => {
    let now = 0;
    const d = new DedupeCache(3, 1000, () => now);
    for (const id of ["a", "b", "c", "d"]) d.add(id);
    assert.equal(d.size, 3);
    assert.ok(!d.seen("a") && d.seen("d"));
    now = 1001;
    assert.ok(!d.seen("d"), "expired after ttl");
  });
});

// ---------------------------------------------------------- transport (wire)

describe("runStreamOnce — handshake + ready", () => {
  test("bearer in header, subprotocol, no token in URL, ready{caps,cursor,max_inflight}", async () => {
    const fake = await startFakeStreamServer();
    try {
      const ac = new AbortController();
      const p = runStreamOnce({ baseUrl: fake.url, token: TOKEN, userAgent: "t/1", cursor: cursorFor(7), caps: [], maxInflight: 16, signal: ac.signal });
      assert.ok(await until(() => fake.state.readies.length === 1));
      const up = fake.state.upgrades[0];
      assert.equal(up.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(up.headers["sec-websocket-protocol"], "chatlytics.bot.v1");
      assert.ok(!up.url.includes(TOKEN) && !up.url.includes("token"), "token never in the URL");
      assert.ok(!/deflate/.test(up.headers["sec-websocket-extensions"] || ""), "no compression");
      assert.deepEqual(fake.state.readies[0], { t: "ready", caps: [], cursor: cursorFor(7), max_inflight: 16 });
      ac.abort();
      const out = await p;
      assert.ok(out.hello);
      assert.equal(out.closeCode, 1000);
    } finally {
      await fake.close();
    }
  });

  test("watchdog: nothing for the window → reconnect (socket terminated)", async () => {
    const fake = await startFakeStreamServer();
    try {
      const out = await runStreamOnce({ baseUrl: fake.url, token: TOKEN, userAgent: "t/1", caps: [], watchdogMs: 200 });
      assert.match(out.error, /watchdog/);
      assert.ok(out.hello);
    } finally {
      await fake.close();
    }
  });

  test("server pings keep the watchdog fed", async () => {
    const fake = await startFakeStreamServer({
      onConnection: (conn) => {
        const t = setInterval(() => conn.ws.readyState === 1 && conn.ws.ping(), 50);
        conn.ws.on("close", () => clearInterval(t));
      },
    });
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 600);
      const out = await runStreamOnce({ baseUrl: fake.url, token: TOKEN, userAgent: "t/1", caps: [], watchdogMs: 200, signal: ac.signal });
      assert.equal(out.error, "stopped", "aborted by us, not by the watchdog");
    } finally {
      await fake.close();
    }
  });

  for (const [status, headers] of [[401], [403], [404], [409, { "Retry-After": "3" }], [426], [429, { "Retry-After": "2" }], [503, { "Retry-After": "5" }]]) {
    test(`refused upgrade HTTP ${status} is reported (status + Retry-After)`, async () => {
      const fake = await startFakeStreamServer({ refuse: () => ({ status, headers }) });
      try {
        const out = await runStreamOnce({ baseUrl: fake.url, token: TOKEN, userAgent: "t/1", caps: [] });
        assert.equal(out.httpStatus, status);
        assert.equal(out.hello, false);
        if (headers) assert.equal(out.retryAfterMs, Number(headers["Retry-After"]) * 1000);
      } finally {
        await fake.close();
      }
    });
  }

  test("reconnect frame + close code are captured", async () => {
    const fake = await startFakeStreamServer({
      onReady: (conn) => {
        conn.send({ t: "reconnect", reason: "deploy", after_ms: 250 });
        conn.ws.close(1012, "deploy");
      },
    });
    try {
      const out = await runStreamOnce({ baseUrl: fake.url, token: TOKEN, userAgent: "t/1", caps: [] });
      assert.equal(out.closeCode, 1012);
      assert.equal(out.reconnectReason, "deploy");
      assert.equal(out.reconnectAfterMs, 250);
    } finally {
      await fake.close();
    }
  });
});

// ------------------------------------------------------------- StreamInbox

describe("StreamInbox — buffer, dedupe, ack timing", () => {
  test("happy path: lazy open, buffered, take() returns {envelopes, cursor}, ack only after ackDelivered()", async () => {
    const fake = await startFakeStreamServer();
    const inbox = makeInbox(fake);
    try {
      await tick(50);
      assert.equal(fake.state.upgrades.length, 0, "no socket before the first poll (lazy)");
      inbox.touch();
      await inbox.whenSettled(2000);
      assert.equal(inbox.transport, "stream");
      assert.ok(await until(() => fake.state.readies.length === 1));
      assert.deepEqual(fake.state.readies[0].caps, [], "no control caps — the plugin never handled control envelopes");
      fake.enqueue({ text: "one" });
      fake.enqueue({ text: "two" });
      assert.ok(await inbox.waitForEnvelopes(2000));
      await until(() => inbox.buffer.length === 2);
      assert.deepEqual(fake.state.acks, [], "NOT acked on receipt");
      const r = inbox.take();
      assert.deepEqual(r.envelopes.map((e) => e.text), ["one", "two"]);
      assert.equal(seqOf(r.cursor), 2);
      await tick(50);
      assert.deepEqual(fake.state.acks, [], "still not acked until the result is returned");
      inbox.ackDelivered();
      assert.ok(await until(() => fake.state.acks.length === 1));
      assert.deepEqual(fake.state.acks, [2], "one cumulative ack for the batch");
      assert.equal(fake.state.queue.length, 0);
      assert.equal(inbox.status().transport, "stream");
    } finally {
      await inbox.stop();
      await fake.close();
    }
  });

  test("process dies before the model reads: nothing acked → redelivered to the next consumer", async () => {
    const fake = await startFakeStreamServer();
    const a = makeInbox(fake);
    a.touch();
    await a.whenSettled(2000);
    fake.enqueue({ text: "unread" });
    await until(() => a.buffer.length === 1);
    await a.stop(); // simulated death: buffer lost, no ack sent
    assert.deepEqual(fake.state.acks, []);
    const b = makeInbox(fake);
    try {
      b.touch();
      assert.ok(await b.waitForEnvelopes(2000));
      const r = b.take();
      assert.deepEqual(r.envelopes.map((e) => e.text), ["unread"]);
      assert.equal(fake.state.queue[0].deliveryCount, 2, "redelivered, delivery_count+1");
    } finally {
      await b.stop();
      await fake.close();
    }
  });

  test("dedupe on env.id: a redelivered id is never shown twice, and is acked", async () => {
    const fake = await startFakeStreamServer();
    const inbox = makeInbox(fake);
    try {
      inbox.touch();
      await inbox.whenSettled(2000);
      fake.enqueue({ text: "hello" }, "MSG-1");
      await inbox.waitForEnvelopes(2000);
      assert.equal(inbox.take().envelopes.length, 1);
      // Ack lost (never sent) + the same message enqueued again under the same id.
      fake.enqueue({ text: "hello (dup)" }, "MSG-1");
      await until(() => fake.state.acks.length === 1, 2000);
      assert.deepEqual(fake.state.acks, [2], "duplicate acked straight away (nothing unreturned ahead of it)");
      assert.equal(inbox.buffer.length, 0);
      assert.equal(inbox.take().envelopes.length, 0);
    } finally {
      await inbox.stop();
      await fake.close();
    }
  });

  test("a duplicate behind an unreturned envelope is NOT acked early (cumulative ack would delete the unread one)", async () => {
    const fake = await startFakeStreamServer();
    const inbox = makeInbox(fake);
    try {
      inbox.touch();
      await inbox.whenSettled(2000);
      inbox.dedupe.add("SEEN");
      fake.enqueue({ text: "unread" }, "NEW");
      fake.enqueue({ text: "dup" }, "SEEN");
      await until(() => inbox.buffer.length === 2);
      await tick(50);
      assert.deepEqual(fake.state.acks, [], "no ack while 'unread' is still buffered");
      const r = inbox.take();
      assert.deepEqual(r.envelopes.map((e) => e.text), ["unread"]);
      inbox.ackDelivered();
      assert.ok(await until(() => fake.state.acks.length === 1));
      assert.deepEqual(fake.state.acks, [2], "the batch ack covers the placeholder too");
    } finally {
      await inbox.stop();
      await fake.close();
    }
  });

  test("reconnect resumes from the position handed to the model (ready.cursor), unread is redelivered", async () => {
    const fake = await startFakeStreamServer();
    const inbox = makeInbox(fake);
    try {
      inbox.touch();
      await inbox.whenSettled(2000);
      fake.enqueue({ text: "a" });
      await inbox.waitForEnvelopes(2000);
      inbox.take(); // returned, ack not yet sent (simulates a socket drop before the ack)
      fake.enqueue({ text: "b" });
      await until(() => inbox.buffer.length === 1);
      fake.live()[0].ws.close(1012, "deploy"); // no reconnect frame → backoff (rand 0 → immediate)
      assert.ok(await until(() => fake.state.readies.length === 2, 3000));
      assert.equal(seqOf(fake.state.readies[1].cursor), 1, "ready.cursor carries the un-acked position");
      assert.ok(await inbox.waitForEnvelopes(2000));
      assert.deepEqual(inbox.take().envelopes.map((e) => e.text), ["b"], "only the unread one comes back");
    } finally {
      await inbox.stop();
      await fake.close();
    }
  });

  test("buffer bound = ready.max_inflight; the server window caps it, nothing is spilled", async () => {
    const fake = await startFakeStreamServer();
    const inbox = makeInbox(fake, { bufferMax: 3 });
    try {
      inbox.touch();
      assert.ok(await until(() => fake.state.readies.length === 1));
      assert.equal(fake.state.readies[0].max_inflight, 3);
      for (let i = 0; i < 5; i++) fake.enqueue({ text: `m${i}` });
      await until(() => inbox.buffer.length === 3);
      await tick(80);
      assert.equal(inbox.buffer.length, 3, "window full — the server holds the rest");
      assert.deepEqual(inbox.take().envelopes.map((e) => e.text), ["m0", "m1", "m2"]);
      inbox.ackDelivered();
      assert.ok(await until(() => inbox.buffer.length === 2));
      assert.deepEqual(inbox.take().envelopes.map((e) => e.text), ["m3", "m4"]);
    } finally {
      await inbox.stop();
      await fake.close();
    }
  });

  test("a server that overruns the window → client closes 4000 and nothing is acked or dropped", async () => {
    const fake = await startFakeStreamServer({
      onReady: (conn) => {
        conn.maxInflight = 99; // misbehave: ignore the client's max_inflight
      },
    });
    const inbox = makeInbox(fake, { bufferMax: 2 });
    try {
      inbox.touch();
      await inbox.whenSettled(2000);
      for (let i = 0; i < 3; i++) fake.enqueue({ text: `m${i}` });
      assert.ok(await until(() => fake.state.events.includes(`close:${CLOSE_CLIENT_OVERFLOW}`), 2000));
      assert.deepEqual(fake.state.acks, []);
      assert.equal(fake.state.queue.length, 3, "all three still queued server-side");
    } finally {
      await inbox.stop();
      await fake.close();
    }
  });
});

describe("StreamInbox — close codes and fallback", () => {
  test("1012 + reconnect{after_ms} → reconnects after after_ms", async () => {
    let n = 0;
    const fake = await startFakeStreamServer({
      onReady: (conn) => {
        if (++n === 1) {
          conn.send({ t: "reconnect", reason: "deploy", after_ms: 300 });
          conn.ws.close(1012, "deploy");
        }
      },
    });
    const inbox = makeInbox(fake);
    try {
      inbox.touch();
      const t0 = Date.now();
      assert.ok(await until(() => fake.state.readies.length === 2, 3000));
      assert.ok(Date.now() - t0 >= 280, `waited after_ms (${Date.now() - t0}ms)`);
      assert.equal(inbox.transport, "stream");
    } finally {
      await inbox.stop();
      await fake.close();
    }
  });

  test("token_rotated (after_ms 0) → immediate reconnect", async () => {
    let n = 0;
    const fake = await startFakeStreamServer({
      onReady: (conn) => {
        if (++n === 1) {
          conn.send({ t: "reconnect", reason: "token_rotated", after_ms: 0 });
          conn.ws.close(1012, "rotated");
        }
      },
    });
    const inbox = makeInbox(fake, { rand: () => 0.9 });
    try {
      inbox.touch();
      const t0 = Date.now();
      assert.ok(await until(() => fake.state.readies.length === 2, 2000));
      assert.ok(Date.now() - t0 < 1000);
    } finally {
      await inbox.stop();
      await fake.close();
    }
  });

  for (const [label, refuse] of [
    ["HTTP 503 + Retry-After", { status: 503, headers: { "Retry-After": "0" } }],
    ["HTTP 429", { status: 429, headers: { "Retry-After": "0" } }],
    ["HTTP 409", { status: 409, headers: { "Retry-After": "0" } }],
    ["HTTP 500", { status: 500 }],
  ]) {
    test(`${label} → backoff + retry the STREAM (never a long-poll fallback)`, async () => {
      let n = 0;
      const fake = await startFakeStreamServer({ refuse: () => (++n <= 2 ? refuse : null) });
      const inbox = makeInbox(fake);
      try {
        inbox.touch();
        assert.ok(await until(() => fake.state.readies.length === 1, 4000), "connected on the 3rd attempt");
        assert.equal(inbox.transport, "stream");
        assert.equal(fake.state.httpRequests.filter((r) => r.url.startsWith("/api/v1/bot/updates")).length, 0, "no long-poll");
      } finally {
        await inbox.stop();
        await fake.close();
      }
    });
  }

  test("1013 / network close → backoff + retry, not fallback", async () => {
    let n = 0;
    const fake = await startFakeStreamServer({
      onReady: (conn) => {
        if (++n === 1) conn.ws.close(1013, "try again");
      },
    });
    const inbox = makeInbox(fake);
    try {
      inbox.touch();
      assert.ok(await until(() => fake.state.readies.length === 2, 3000));
      assert.equal(inbox.transport, "stream");
    } finally {
      await inbox.stop();
      await fake.close();
    }
  });

  test("4409 superseded → long backoff + loud warning (does not hot-loop)", async () => {
    const fake = await startFakeStreamServer({
      onReady: (conn) => {
        conn.send({ t: "reconnect", reason: "superseded", after_ms: 0 });
        conn.ws.close(4409, "superseded");
      },
    });
    const inbox = makeInbox(fake);
    try {
      inbox.touch();
      assert.ok(await until(() => inbox.logs.some((l) => l.includes("SUPERSEDED (4409)")), 2000));
      await tick(400);
      assert.equal(fake.state.readies.length, 1, "no reconnect within the 60 s superseded backoff");
      assert.match(inbox.logs.find((l) => l.includes("4409")), /^warn /);
    } finally {
      await inbox.stop();
      await fake.close();
    }
  });

  for (const code of [4401, 4403]) {
    test(`close ${code} → stopped with a clear error, no reconnect loop`, async () => {
      const fake = await startFakeStreamServer({ onReady: (conn) => conn.ws.close(code, "nope") });
      const inbox = makeInbox(fake);
      try {
        inbox.touch();
        await until(() => inbox.transport === "stopped", 2000);
        assert.equal(inbox.transport, "stopped");
        assert.ok(inbox.authRejected);
        assert.ok(inbox.logs.some((l) => l.startsWith("error ") && l.includes("REJECTED")));
        await tick(300);
        assert.equal(fake.state.readies.length, 1);
      } finally {
        await inbox.stop();
        await fake.close();
      }
    });
  }

  for (const status of [401, 403]) {
    test(`HTTP ${status} on upgrade → stopped`, async () => {
      const fake = await startFakeStreamServer({ refuse: () => ({ status }) });
      const inbox = makeInbox(fake);
      try {
        inbox.touch();
        await inbox.whenSettled(2000);
        assert.equal(inbox.transport, "stopped");
        assert.ok(inbox.authRejected);
        await tick(300);
        assert.equal(fake.state.upgrades.length, 1, "no retry storm");
      } finally {
        await inbox.stop();
        await fake.close();
      }
    });
  }

  for (const status of [404, 426]) {
    test(`HTTP ${status} (auto) → long-poll fallback, re-probed every reprobeMs, switches back by itself`, async () => {
      let enabled = false;
      const fake = await startFakeStreamServer({ refuse: () => (enabled ? null : { status }) });
      const inbox = makeInbox(fake, { reprobeMs: 300 });
      try {
        inbox.touch();
        await inbox.whenSettled(2000);
        assert.equal(inbox.transport, "longpoll");
        assert.ok(await until(() => fake.state.upgrades.length >= 2, 2000), "re-probed");
        enabled = true;
        inbox.touch();
        assert.ok(await until(() => inbox.transport === "stream", 2000), "back on the stream once the server enables it");
      } finally {
        await inbox.stop();
        await fake.close();
      }
    });
  }

  test("transport: stream + 404 → stopped with an actionable error (no fallback)", async () => {
    const fake = await startFakeStreamServer({ refuse: () => ({ status: 404 }) });
    const inbox = makeInbox(fake, { transport: "stream" });
    try {
      inbox.touch();
      await inbox.whenSettled(2000);
      assert.equal(inbox.transport, "stopped");
      assert.ok(!inbox.authRejected);
      assert.match(inbox.detail, /no stream route/);
    } finally {
      await inbox.stop();
      await fake.close();
    }
  });

  test("4408 slow consumer → next ready asks for half the window", async () => {
    let n = 0;
    const fake = await startFakeStreamServer({ onReady: (conn) => ++n === 1 && conn.ws.close(4408, "slow") });
    const inbox = makeInbox(fake, { bufferMax: 64 });
    try {
      inbox.touch();
      assert.ok(await until(() => fake.state.readies.length === 2, 3000));
      assert.equal(fake.state.readies[0].max_inflight, 64);
      assert.equal(fake.state.readies[1].max_inflight, 32);
    } finally {
      await inbox.stop();
      await fake.close();
    }
  });

  test("idle release: no poll for idleMs + empty buffer → socket closed 1000; reopens on the next poll", async () => {
    const fake = await startFakeStreamServer();
    const inbox = makeInbox(fake, { idleMs: 200, idleCheckMs: 50 });
    try {
      inbox.touch();
      await inbox.whenSettled(2000);
      assert.ok(await until(() => fake.state.events.includes("close:1000"), 2000));
      assert.ok(await until(() => inbox.transport === "idle", 1000));
      inbox.touch();
      assert.ok(await until(() => fake.state.readies.length === 2, 2000));
    } finally {
      await inbox.stop();
      await fake.close();
    }
  });

  test("idle with unread envelopes → socket KEPT (a reconnect would burn a delivery attempt)", async () => {
    const fake = await startFakeStreamServer();
    const inbox = makeInbox(fake, { idleMs: 150, idleCheckMs: 30 });
    try {
      inbox.touch();
      await inbox.whenSettled(2000);
      fake.enqueue({ text: "unread" });
      await until(() => inbox.buffer.length === 1);
      await tick(400);
      assert.ok(!fake.state.events.some((e) => e.startsWith("close:")), "still open");
      assert.equal(inbox.transport, "stream");
    } finally {
      await inbox.stop();
      await fake.close();
    }
  });
});

// ------------------------------------------------- MCP: chatlytics_poll contract

function rpcClient(child) {
  let buf = "";
  const waiters = new Map();
  child.stdout.on("data", (c) => {
    buf += c.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && waiters.has(msg.id)) {
          waiters.get(msg.id)(msg);
          waiters.delete(msg.id);
        }
      } catch {
        /* not JSON */
      }
    }
  });
  let id = 0;
  return {
    call(method, params) {
      const myId = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
      return new Promise((resolve, reject) => {
        waiters.set(myId, resolve);
        setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 20_000);
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
  };
}

async function startMcp(fake, extraEnv = {}) {
  const child = spawn(process.execPath, [MCP_SRC], {
    env: cleanEnv({ CHATLYTICS_API_URL: fake.url, CHATLYTICS_BOT_TOKEN: TOKEN, ...extraEnv }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (c) => stderr.push(c.toString("utf8")));
  const rpc = rpcClient(child);
  await rpc.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  rpc.notify("notifications/initialized", {});
  const poll = async (args = {}) => {
    const r = await rpc.call("tools/call", { name: "chatlytics_poll", arguments: args });
    const text = r.result?.content?.[0]?.text ?? "";
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* error text */
    }
    return { isError: !!r.result?.isError, text, json };
  };
  const stop = async () => {
    child.stdin.end();
    await new Promise((r) => {
      const t = setTimeout(() => {
        child.kill();
        r();
      }, 4000);
      child.on("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  };
  return { child, rpc, poll, stop, stderr };
}

const healthHttp = (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", webhook_registered: true, healthy: true }));
    return true;
  }
  return false;
};

describe("MCP server — chatlytics_poll contract over the stream", () => {
  test("same args, same {envelopes, cursor} result; acked after the result is returned; health reports transport", async () => {
    const fake = await startFakeStreamServer({ http: healthHttp });
    const mcp = await startMcp(fake);
    try {
      assert.equal(fake.state.upgrades.length, 0, "no socket at boot (lazy)");
      fake.enqueue({ chat_type: "dm", sender_jid: "1@c.us", text: "hi" });
      const r1 = await mcp.poll({ timeout_ms: 5000 });
      assert.ok(!r1.isError, r1.text);
      assert.deepEqual(Object.keys(r1.json).sort(), ["cursor", "envelopes"], "result shape unchanged");
      assert.deepEqual(r1.json.envelopes.map((e) => e.text), ["hi"]);
      assert.equal(seqOf(r1.json.cursor), 1);
      assert.ok(await until(() => fake.state.acks.includes(1), 2000), "acked after return");
      const evAck = fake.state.events.indexOf("ack:1");
      assert.ok(evAck > fake.state.events.indexOf("env:1"));

      // Empty poll times out like long-poll did: 200-shaped, empty envelopes.
      const t0 = Date.now();
      const r2 = await mcp.poll({ cursor: r1.json.cursor, timeout_ms: 1000 });
      assert.ok(!r2.isError);
      assert.deepEqual(r2.json.envelopes, []);
      assert.ok(Date.now() - t0 >= 900, "blocked up to timeout_ms");

      // A message arriving mid-wait returns promptly.
      setTimeout(() => fake.enqueue({ text: "later" }), 200);
      const r3 = await mcp.poll({ cursor: r2.json.cursor, ack: r2.json.cursor, timeout_ms: 5000 });
      assert.deepEqual(r3.json.envelopes.map((e) => e.text), ["later"]);
      assert.equal(fake.state.httpRequests.filter((r) => r.url.startsWith("/api/v1/bot/updates")).length, 0, "no long-poll request at all");

      const h = await mcp.rpc.call("tools/call", { name: "chatlytics_health", arguments: {} });
      const hj = JSON.parse(h.result.content[0].text);
      assert.equal(hj.inbound.transport, "stream");
      assert.equal(hj.inbound.configured, "auto");
      assert.ok(!h.result.content[0].text.includes(TOKEN), "INV-02: no token in health output");
      assert.ok(!mcp.stderr.join("").includes(TOKEN), "INV-02: no token in stderr");
    } finally {
      await mcp.stop();
      await fake.close();
    }
  });

  test("the model's `ack` argument cannot ack envelopes it has not been shown", async () => {
    const fake = await startFakeStreamServer();
    const mcp = await startMcp(fake);
    try {
      const r0 = await mcp.poll({ timeout_ms: 1000 }); // opens the socket
      assert.deepEqual(r0.json.envelopes, []);
      fake.enqueue({ text: "unseen" });
      await tick(200);
      // A poll whose ack names a cursor AHEAD of what was returned, on a call
      // that returns nothing new… the stream path ignores `ack`.
      await mcp.rpc.call("tools/call", { name: "chatlytics_health", arguments: {} }).catch(() => {});
      assert.deepEqual(fake.state.acks, []);
      const r1 = await mcp.poll({ ack: cursorFor(99), timeout_ms: 2000 });
      assert.deepEqual(r1.json.envelopes.map((e) => e.text), ["unseen"], "still delivered");
    } finally {
      await mcp.stop();
      await fake.close();
    }
  });

  test("404 on the upgrade (auto) → the v2.x long-poll path serves the call", async () => {
    const fake = await startFakeStreamServer({
      refuse: () => ({ status: 404 }),
      http: (req, res) => {
        if (req.url.startsWith("/api/v1/bot/updates")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ envelopes: [{ text: "via long-poll" }], cursor: "lp-cursor" }));
          return true;
        }
        return false;
      },
    });
    const mcp = await startMcp(fake);
    try {
      const r = await mcp.poll({ timeout_ms: 2000 });
      assert.deepEqual(r.json, { envelopes: [{ text: "via long-poll" }], cursor: "lp-cursor" });
      assert.equal(fake.state.httpRequests.filter((x) => x.url.startsWith("/api/v1/bot/updates")).length, 1);
    } finally {
      await mcp.stop();
      await fake.close();
    }
  });

  test("CHATLYTICS_TRANSPORT=longpoll → never opens a socket", async () => {
    const fake = await startFakeStreamServer({
      http: (req, res) => {
        if (req.url.startsWith("/api/v1/bot/updates")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ envelopes: [], cursor: "c" }));
          return true;
        }
        return false;
      },
    });
    const mcp = await startMcp(fake, { CHATLYTICS_TRANSPORT: "longpoll" });
    try {
      const r = await mcp.poll({ timeout_ms: 1000 });
      assert.deepEqual(r.json, { envelopes: [], cursor: "c" });
      assert.equal(fake.state.upgrades.length, 0);
    } finally {
      await mcp.stop();
      await fake.close();
    }
  });

  test("4401 → chatlytics_poll returns the actionable token error", async () => {
    const fake = await startFakeStreamServer({ onReady: (conn) => conn.ws.close(4401, "revoked") });
    const mcp = await startMcp(fake);
    try {
      const r = await mcp.poll({ timeout_ms: 3000 });
      assert.ok(r.isError);
      assert.match(r.text, /rejected the bot token \(HTTP 401\)/);
      assert.ok(!r.text.includes(TOKEN));
    } finally {
      await mcp.stop();
      await fake.close();
    }
  });

  test("stdin close (Claude Code exits) → socket closed cleanly with 1000", async () => {
    const fake = await startFakeStreamServer();
    const mcp = await startMcp(fake);
    await mcp.poll({ timeout_ms: 1000 });
    assert.equal(fake.live().length, 1);
    await mcp.stop();
    assert.ok(await until(() => fake.state.events.includes("close:1000"), 3000));
    await fake.close();
  });
});

// ------------------------------------------------------------ inbox daemon

function runDaemon(fake, home, args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DAEMON_BUNDLE, ...args], {
      env: cleanEnv({ CHATLYTICS_API_URL: fake.url, CHATLYTICS_BOT_TOKEN: TOKEN, HOME: home, USERPROFILE: home, ...extraEnv }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    const killer = setTimeout(() => child.kill(), 15_000);
    child.on("exit", (code) => {
      clearTimeout(killer);
      resolve({ code, out: out.trim() });
    });
  });
}

describe("inbox daemon (wa-poll-once.bundle.mjs) over the stream", { skip: !existsSync(DAEMON_BUNDLE) && "bundle not built" }, () => {
  test("prints the batch, acks only AFTER printing, persists the cursor, resumes with it", async () => {
    const fake = await startFakeStreamServer();
    const home = mkdtempSync(join(tmpdir(), "cc3-daemon-"));
    try {
      fake.enqueue({ chat_type: "dm", sender_jid: "1@c.us", sender_name: "Dana", text: "first" }, "A");
      fake.enqueue({ chat_type: "group", sender_jid: "2@c.us", sender_name: "Eli", chat_name: "Team", entity_jid: "9@g.us", text: "second" }, "B");
      const r1 = await runDaemon(fake, home);
      const j1 = JSON.parse(r1.out);
      assert.deepEqual(j1.lines, ['whatsapp message from Dana: "first"', 'whatsapp message from Eli in Team: "second"']);
      assert.equal(j1.count, 2);
      assert.deepEqual(fake.state.acks, [2], "one cumulative ack, after the print");
      assert.deepEqual(fake.state.readies[0].caps, []);
      const st = JSON.parse(readFileSync(join(home, ".claude", "whatsapp-cc", "poll-cursor.json"), "utf8"));
      assert.equal(seqOf(st.cursor), 2);
      assert.deepEqual(st.ids.map((e) => e[0]), ["A", "B"]);
      assert.equal(fake.state.httpRequests.filter((x) => x.url.startsWith("/api/v1/bot/updates")).length, 0);

      // Next launch: resumes from the persisted cursor; a redelivered id is acked, not reprinted.
      fake.enqueue({ text: "again", sender_name: "Dana" }, "A");
      fake.enqueue({ text: "third", sender_name: "Dana" }, "C");
      const r2 = await runDaemon(fake, home);
      assert.equal(seqOf(fake.state.readies[1].cursor), 2, "ready.cursor = persisted cursor");
      assert.deepEqual(JSON.parse(r2.out).lines, ['whatsapp message from Dana: "third"']);
    } finally {
      rmSync(home, { recursive: true, force: true });
      await fake.close();
    }
  });

  test("auth refusal is surfaced as an error line (no loop)", async () => {
    const fake = await startFakeStreamServer({ refuse: () => ({ status: 401 }) });
    const home = mkdtempSync(join(tmpdir(), "cc3-daemon-"));
    try {
      const r = await runDaemon(fake, home);
      const j = JSON.parse(r.out);
      assert.match(j.error, /rejected the bot token/);
      assert.ok(!r.out.includes(TOKEN));
      assert.equal(fake.state.upgrades.length, 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      await fake.close();
    }
  });

  test("404 (auto) → falls back to the v2.x long-poll loop", async () => {
    const fake = await startFakeStreamServer({
      refuse: () => ({ status: 404 }),
      http: (req, res) => {
        if (req.url.startsWith("/api/v1/bot/updates")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ envelopes: [{ text: "lp", sender_name: "Dana" }], cursor: "lp1" }));
          return true;
        }
        return false;
      },
    });
    const home = mkdtempSync(join(tmpdir(), "cc3-daemon-"));
    try {
      const r = await runDaemon(fake, home);
      assert.deepEqual(JSON.parse(r.out).lines, ['whatsapp message from Dana: "lp"']);
    } finally {
      rmSync(home, { recursive: true, force: true });
      await fake.close();
    }
  });
});
