'use strict';

/**
 * Answers "is the user actually DOING something with Claude right now?",
 * as opposed to merely having the app open in the background.
 *
 * Two signals, strongest first:
 *   1. Claude Code's live session registry says a session is `busy`
 *      (Claude is generating) — that is activity by definition.
 *   2. The modification time of Claude's own files: session transcripts are
 *      appended to as a conversation progresses, and the desktop app writes
 *      to its storage when its UI does something for you. If the newest
 *      write is within the configured window, we call it active.
 *
 * The desktop app's log heartbeat is deliberately not a signal (see
 * claude-data.js): it fires whether or not anyone is there.
 *
 * This is best-effort by nature: it can be wrong if Claude changes where it
 * stores things, so `isActive()` returns null (= "no idea") rather than
 * guessing, and callers must fall back to their previous behaviour.
 *
 * Privacy: only mtimes and the registry's status flag are read — never file
 * contents.
 */

const claudeData = require('./claude-data');
const claudeSessions = require('./claude-sessions');

const CACHE_TTL_MS = 5 * 1000; // the poll loop calls this often; keep it cheap

let cache = { at: 0, value: undefined };

/**
 * Epoch ms of Claude's most recent activity, or null if undetectable. Cached.
 * A busy session counts as "right now".
 * @param {Set<number>} [knownPids]  Claude process ids, if the caller has them
 */
function lastActivityMs(knownPids) {
  const now = Date.now();
  if (cache.value !== undefined && now - cache.at < CACHE_TTL_MS) return cache.value;
  let value = null;
  try {
    if (claudeSessions.anyBusy(knownPids)) {
      value = now;
    } else {
      value = claudeData.lastWriteMs();
      // An idle-but-open session whose status flipped more recently than any
      // file write still counts as activity at that moment.
      for (const s of claudeSessions.liveSessions(knownPids)) {
        if (s.lastActivity && (!value || s.lastActivity > value)) value = s.lastActivity;
      }
    }
  } catch (_) {
    /* never let detection throw into the daemon loop */
  }
  cache = { at: now, value };
  return value;
}

/**
 * @param {number} windowSeconds  how recent a write must be to count as active
 * @param {Set<number>} [knownPids]
 * @returns {boolean|null} true / false, or null when it can't be determined
 */
function isActive(windowSeconds, knownPids) {
  const last = lastActivityMs(knownPids);
  if (!last) return null;
  const win = Math.max(30, Number(windowSeconds) || 180) * 1000;
  // A clock jump (or a file dated in the future) shouldn't read as "idle".
  return Date.now() - last <= win;
}

/** Seconds since Claude last did anything, or null if undetectable. */
function secondsSinceActivity(knownPids) {
  const last = lastActivityMs(knownPids);
  if (!last) return null;
  return Math.max(0, Math.round((Date.now() - last) / 1000));
}

/** Drops the cache — used by tests and by `doctor` for a fresh reading. */
function resetCache() {
  cache = { at: 0, value: undefined };
}

module.exports = { isActive, lastActivityMs, secondsSinceActivity, resetCache };
