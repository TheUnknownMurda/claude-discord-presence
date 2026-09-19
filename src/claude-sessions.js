'use strict';

/**
 * Live Claude Code sessions, straight from Claude Code's own registry.
 *
 * Every running Claude Code session (terminal or the desktop app's Code tab)
 * keeps a small JSON file at ~/.claude/sessions/<pid>.json for as long as it
 * runs, holding — among other things — its process id, working directory,
 * start time, the title you gave it and whether it is currently `busy`
 * (Claude is generating) or `idle` (waiting for you). It is removed on exit.
 *
 * That makes it a far more precise source than file mtimes for three things:
 *   - is Claude Code in use at all (a session whose process is alive)
 *   - is it doing something right now (`status === 'busy'`)
 *   - when the session started (`startedAt`), for the elapsed timer
 *
 * A crash can leave a stale file behind, so a session only counts when its
 * PID still exists. When the caller knows which PIDs are Claude processes
 * (the daemon does, from its process scan) a listed PID is trusted outright
 * and an unlisted one must also have been touched recently, which defends
 * against a dead session's PID being reused by something else.
 *
 * Privacy: these files hold no conversation content. The only free-text field
 * read is `name`, the session title, and it is exposed solely as the opt-in
 * {title} placeholder.
 */

const fs = require('fs');
const path = require('path');
const claudeData = require('./claude-data');
const { isAlive } = require('./single-instance');

const CACHE_TTL_MS = 5 * 1000;
const MAX_ENTRIES = 64; // nobody has more live sessions than this
const STALE_AFTER_MS = 7 * 24 * 3600 * 1000; // ignore registry files older than a week
// When the caller's process scan doesn't list a PID (Claude Code may run as
// `node`, or under a name the config doesn't watch) we still trust the entry
// as long as it is alive and was touched recently — a crash-orphaned file
// whose PID got reused is old by then.
const UNVERIFIED_MAX_AGE_MS = 12 * 3600 * 1000;

let cache = { at: 0, key: null, list: null };

/** ~/.claude/sessions — where the registry lives. */
function registryDir() {
  return path.join(claudeData.claudeCodeDir(), 'sessions');
}

function readEntry(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
  if (!data || typeof data !== 'object' || !Number.isInteger(data.pid)) return null;
  return {
    pid: data.pid,
    sessionId: typeof data.sessionId === 'string' ? data.sessionId : null,
    cwd: typeof data.cwd === 'string' ? data.cwd : null,
    startedAt: Number.isFinite(data.startedAt) ? data.startedAt : null,
    status: data.status === 'busy' ? 'busy' : 'idle',
    statusUpdatedAt: Number.isFinite(data.statusUpdatedAt) ? data.statusUpdatedAt : null,
    updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : null,
    title: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null,
    entrypoint: typeof data.entrypoint === 'string' ? data.entrypoint : null,
    version: typeof data.version === 'string' ? data.version : null,
  };
}

/**
 * Sessions whose process is alive, most recently active first.
 * @param {Set<number>} [knownPids]  PIDs the caller has verified are Claude
 *   processes; when given, a registry entry must be one of them.
 * @returns {Array<object>}
 */
function liveSessions(knownPids) {
  const now = Date.now();
  const key = knownPids ? [...knownPids].sort().join(',') : '';
  if (cache.list && cache.key === key && now - cache.at < CACHE_TTL_MS) return cache.list;

  const list = [];
  let names = [];
  try {
    names = fs.readdirSync(registryDir()).filter((n) => /^\d+\.json$/.test(n)).slice(0, MAX_ENTRIES);
  } catch (_) {
    /* no registry (older Claude Code, or never run) — empty list */
  }
  for (const name of names) {
    const file = path.join(registryDir(), name);
    const entry = readEntry(file);
    if (!entry) continue;
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch (_) { continue; }
    if (now - mtime > STALE_AFTER_MS) continue;
    let alive;
    if (knownPids && knownPids.has(entry.pid)) alive = true;
    else if (knownPids && knownPids.size) alive = isAlive(entry.pid) && now - mtime <= UNVERIFIED_MAX_AGE_MS;
    else alive = isAlive(entry.pid);
    if (!alive) continue;
    entry.lastActivity = Math.max(entry.statusUpdatedAt || 0, entry.updatedAt || 0, mtime) || null;
    list.push(entry);
  }
  // Busy sessions first, then whichever moved most recently.
  list.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'busy' ? -1 : 1;
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });
  cache = { at: now, key, list };
  return list;
}

/** The session most worth showing (busy first, then most recent), or null. */
function primary(knownPids) {
  return liveSessions(knownPids)[0] || null;
}

/** True when any live session is generating right now. */
function anyBusy(knownPids) {
  return liveSessions(knownPids).some((s) => s.status === 'busy');
}

/** Earliest start time across live sessions (epoch ms), or null. */
function earliestStart(knownPids) {
  let earliest = null;
  for (const s of liveSessions(knownPids)) {
    if (s.startedAt && (earliest === null || s.startedAt < earliest)) earliest = s.startedAt;
  }
  return earliest;
}

/** Drops the cache — used by tests and by `doctor` for a fresh reading. */
function resetCache() {
  cache = { at: 0, key: null, list: null };
}

module.exports = { registryDir, liveSessions, primary, anyBusy, earliestStart, resetCache };
