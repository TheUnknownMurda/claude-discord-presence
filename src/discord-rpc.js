'use strict';

/**
 * Minimal, dependency-free Discord Rich Presence client.
 *
 * Discord exposes a local IPC endpoint that desktop apps use to set presence:
 *   - Windows: a named pipe  \\?\pipe\discord-ipc-N   (N = 0..9)
 *   - macOS/Linux: a unix socket in the temp/runtime dir: discord-ipc-N
 *
 * The wire format is dead simple: each frame is
 *   [ int32 LE opcode ][ int32 LE payload-length ][ UTF-8 JSON payload ]
 *
 * We implement only what we need: HANDSHAKE, then SET_ACTIVITY frames. This
 * avoids pulling in (and trusting) a third-party npm package.
 *
 * Docs reference: https://discord.com/developers/docs/topics/rpc
 */

const net = require('net');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

/** All socket paths Discord might be listening on, in priority order. */
function ipcCandidates() {
  const list = [];
  if (process.platform === 'win32') {
    for (let i = 0; i < 10; i++) list.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    return list;
  }
  const base =
    process.env.XDG_RUNTIME_DIR ||
    process.env.TMPDIR ||
    process.env.TMP ||
    process.env.TEMP ||
    '/tmp';
  // Plain temp dir plus the sandboxed locations used by Flatpak/Snap installs.
  const subdirs = [
    '',
    'app/com.discordapp.Discord/',
    'app/com.discordapp.DiscordCanary/',
    'snap.discord/',
    'snap.discord-canary/',
  ];
  for (const sub of subdirs) {
    for (let i = 0; i < 10; i++) {
      list.push(path.join(base, sub, `discord-ipc-${i}`));
    }
  }
  return list;
}

class DiscordRPC extends EventEmitter {
  constructor(clientId, logger) {
    super();
    this.clientId = clientId;
    this.log = logger || console;
    this.socket = null;
    this.connected = false; // true only after a successful handshake
    this.buffer = Buffer.alloc(0);
    this._want = false; // whether we should be (re)connecting
    this._reconnectTimer = null;
    this._reconnectDelay = 3000;
    this._user = null; // the Discord user we connected as
  }

  /** Begin connecting (and stay connected, retrying as needed). */
  start() {
    this._want = true;
    this._connect();
  }

  _connect() {
    if (!this._want || this.socket) return;
    const candidates = ipcCandidates();

    const tryNext = (idx) => {
      if (!this._want) return;
      if (idx >= candidates.length) {
        this._scheduleReconnect(); // Discord not up yet — back off and retry
        return;
      }
      const sock = net.createConnection(candidates[idx]);
      let settled = false;
      sock.once('connect', () => {
        settled = true;
        this.socket = sock;
        this._attach(sock);
        this._send(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
      });
      sock.once('error', () => {
        if (settled) return;
        try { sock.destroy(); } catch (_) {}
        tryNext(idx + 1);
      });
    };
    tryNext(0);
  }

  _attach(sock) {
    sock.on('data', (chunk) => this._onData(chunk));
    sock.on('close', () => this._onClose());
    sock.on('error', (err) => this.log.debug && this.log.debug('RPC socket error: ' + err.message));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // A single chunk may contain several frames, or a partial one.
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const len = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + len) break; // wait for the rest
      const payload = this.buffer.slice(8, 8 + len);
      this.buffer = this.buffer.slice(8 + len);
      let data = null;
      try { data = JSON.parse(payload.toString('utf8')); } catch (_) {}
      this._handleFrame(op, data);
    }
  }

  _handleFrame(op, data) {
    if (op === OP.PING) {
      this._send(OP.PONG, data);
      return;
    }
    if (op === OP.CLOSE) {
      this._onClose();
      return;
    }
    if (op === OP.FRAME && data) {
      // The handshake response arrives as a DISPATCH/READY frame.
      if (data.evt === 'READY' || data.cmd === 'DISPATCH') {
        if (!this.connected) {
          this.connected = true;
          this._reconnectDelay = 3000;
          this._user = data.data && data.data.user;
          this.emit('connected', this._user);
        }
      } else if (data.evt === 'ERROR') {
        this.emit('rpc-error', data.data);
      }
    }
  }

  _send(op, data) {
    if (!this.socket) return false;
    try {
      const json = Buffer.from(JSON.stringify(data), 'utf8');
      const header = Buffer.alloc(8);
      header.writeInt32LE(op, 0);
      header.writeInt32LE(json.length, 4);
      this.socket.write(Buffer.concat([header, json]));
      return true;
    } catch (e) {
      this.log.debug && this.log.debug('RPC send failed: ' + e.message);
      return false;
    }
  }

  /** Set the rich-presence activity (or pass null to clear it). */
  setActivity(activity) {
    if (!this.connected) return false;
    return this._send(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: activity || null },
      nonce: crypto.randomUUID(),
    });
  }

  clearActivity() {
    return this.setActivity(null);
  }

  _onClose() {
    const wasConnected = this.connected;
    this.connected = false;
    if (this.socket) { try { this.socket.destroy(); } catch (_) {} }
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    if (wasConnected) this.emit('disconnected');
    if (this._want) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || !this._want) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, this._reconnectDelay);
    // Exponential-ish backoff, capped at 30s.
    this._reconnectDelay = Math.min(Math.floor(this._reconnectDelay * 1.5), 30000);
  }

  /** Stop trying to connect and tear everything down. */
  destroy() {
    this._want = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.socket) { try { this.socket.destroy(); } catch (_) {} }
    this.socket = null;
    this.connected = false;
  }
}

/**
 * One-shot probe used by `doctor`: resolves true if any Discord IPC socket
 * accepts a connection within `timeoutMs`.
 */
function isDiscordAvailable(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const candidates = ipcCandidates();
    let done = false;
    let idx = 0;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const tryNext = () => {
      if (done) return;
      if (idx >= candidates.length) return finish(false);
      const sock = net.createConnection(candidates[idx++]);
      sock.once('connect', () => { try { sock.destroy(); } catch (_) {} finish(true); });
      sock.once('error', () => { try { sock.destroy(); } catch (_) {} tryNext(); });
    };
    tryNext();
  });
}

module.exports = { DiscordRPC, isDiscordAvailable, ipcCandidates };
