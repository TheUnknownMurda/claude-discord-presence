'use strict';

/**
 * Single-instance guard — the mechanism that guarantees only ONE helper
 * daemon ever runs, no matter how many times Claude (or the user) starts it.
 *
 * Strategy:
 *   - The lock is a small JSON file ({ pid, startedAt }) created ATOMICALLY
 *     with the `wx` flag (fails if it already exists). This makes acquisition
 *     race-safe even if two daemons launch at the exact same moment.
 *   - If the lock already exists we read the stored PID and check whether that
 *     process is still alive (`process.kill(pid, 0)`). If alive → we refuse to
 *     start. If dead (a crash left a stale lock) → we take it over.
 *   - release() only removes the lock if WE own it, so a second process can
 *     never delete the first's lock.
 */

const fs = require('fs');
const { lockPath, ensureDataDir } = require('./paths');

/** Returns true if a process with the given PID currently exists. */
function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually signal
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it (still "alive").
    return e.code === 'EPERM';
  }
}

/** Reads and parses the lock file, or null if absent/corrupt. */
function readLock() {
  try {
    const data = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
    if (data && typeof data.pid === 'number') return data;
  } catch (_) {
    /* missing or corrupt */
  }
  return null;
}

/** PID of the currently-running daemon, or null if none. */
function getRunningPid() {
  const lock = readLock();
  return lock && isAlive(lock.pid) ? lock.pid : null;
}

function writeLockExclusive(payload) {
  const fd = fs.openSync(lockPath(), 'wx'); // throws EEXIST if present
  try {
    fs.writeSync(fd, payload);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Attempts to become the single running instance.
 * @returns {{acquired: boolean, pid: number|null, replacedStale?: boolean}}
 */
function acquire() {
  ensureDataDir();
  const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() });

  try {
    writeLockExclusive(payload);
    return { acquired: true, pid: process.pid };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;

    // A lock already exists — is its owner still alive?
    const lock = readLock();
    if (lock && isAlive(lock.pid) && lock.pid !== process.pid) {
      return { acquired: false, pid: lock.pid };
    }

    // Stale (crash-left) or our own — replace it.
    try {
      fs.unlinkSync(lockPath());
    } catch (_) {
      /* ignore */
    }
    try {
      writeLockExclusive(payload);
      return { acquired: true, pid: process.pid, replacedStale: true };
    } catch (e2) {
      const again = readLock();
      return { acquired: false, pid: again ? again.pid : null };
    }
  }
}

/** Removes the lock, but only if this process owns it. */
function release() {
  const lock = readLock();
  if (lock && lock.pid === process.pid) {
    try {
      fs.unlinkSync(lockPath());
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = { acquire, release, readLock, getRunningPid, isAlive };
