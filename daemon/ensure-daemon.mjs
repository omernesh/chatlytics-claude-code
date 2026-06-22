/**
 * WhatsApp CC — SessionStart daemon launcher
 *
 * Probes 127.0.0.1:7656 (the daemon's singleton port).
 *   - If the port answers → daemon already running → exit 0 silently.
 *   - If the port is refused → spawn daemon.mjs detached and exit 0.
 *
 * FAIL-OPEN: any error → silently exit 0. Never block session startup.
 */

import net from 'net';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Resolve daemon path relative to this file (both live in the same directory)
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DAEMON_PATH = path.join(__dirname, 'daemon.mjs');

const SINGLETON_PORT = 7656;
const SINGLETON_HOST = '127.0.0.1';
const PROBE_TIMEOUT  = 2000; // ms

try {
  await main();
} catch {
  // Fail-open: any unexpected error → exit 0, never block startup
  process.exit(0);
}

async function main() {
  const running = await probeDaemon();
  if (running) {
    // Already up — nothing to do
    process.exit(0);
  }

  // Spawn detached, disconnect stdio so this process can exit immediately
  try {
    const child = spawn(
      process.execPath,   // same node binary that's running this launcher
      [DAEMON_PATH],
      {
        detached: true,
        stdio: 'ignore',
        // Inherit environment so node can resolve paths normally
        env: process.env,
      }
    );
    child.unref(); // Don't keep the parent alive waiting for the child
  } catch {
    // Spawn failed — log to stderr but don't crash CC startup
    process.stderr.write('[whatsapp-cc] WARNING: failed to spawn daemon.mjs\n');
  }

  process.exit(0);
}

/**
 * Attempt a TCP connection to the singleton port.
 * Resolves true  → daemon is listening.
 * Resolves false → connection refused / timed out.
 */
function probeDaemon() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled  = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => done(false), PROBE_TIMEOUT);

    socket.once('connect', () => {
      clearTimeout(timer);
      done(true);
    });

    socket.once('error', () => {
      clearTimeout(timer);
      done(false);
    });

    socket.connect(SINGLETON_PORT, SINGLETON_HOST);
  });
}
