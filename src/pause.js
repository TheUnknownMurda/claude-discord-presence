'use strict';

/**
 * The pause switch, shared by the CLI and the daemon.
 *
 * A pause is a file (paths.pausePath()) rather than a signal, because Windows
 * has no usable signals and because a file survives a daemon restart — pausing
 * then rebooting keeps the presence hidden, which is what people expect.
 *
 * The file holds JSON: { since, until }. `until` is optional and drives
 * `pause --for 30m`: once it has passed, the daemon deletes the file and the
 * presence comes back on its own.
 */

const fs = require('fs');
const { pausePath, ensureDataDir } = require('./paths');
const { writeFileAtomic } = require('./fs-utils');

/** Parses "45", "30m", "2h", "1d" into milliseconds, or null when invalid. */
function parseDuration(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*$/i.exec(String(text || ''));
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (m[2] || 'm').toLowerCase(); // bare numbers mean minutes
  const factor = { s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 86400 * 1000 }[unit];
  return Math.round(value * factor);
}

/** The raw pause record, or null when not paused. */
function read() {
  let text;
  try {
    text = fs.readFileSync(pausePath(), 'utf8');
  } catch (_) {
    return null; // no file → not paused
  }
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object') return data;
  } catch (_) {
    /* pre-1.2 files held a bare ISO timestamp: treat as an open-ended pause */
  }
  return { since: text.trim() || null };
}

/** Milliseconds until the pause expires; null when it never does. */
function remainingMs(record) {
  const rec = record === undefined ? read() : record;
  if (!rec || !rec.until) return null;
  const until = Date.parse(rec.until);
  if (Number.isNaN(until)) return null;
  return until - Date.now();
}

/**
 * Whether the presence should currently be hidden. An expired timed pause is
 * cleared here, so the very next poll shows the presence again.
 */
function isPaused() {
  const rec = read();
  if (!rec) return false;
  const left = remainingMs(rec);
  if (left !== null && left <= 0) {
    clear();
    return false;
  }
  return true;
}

/**
 * Turns the pause on.
 * @param {?number} durationMs  auto-resume after this long (null = until resumed)
 * @returns {{since: string, until: ?string}}
 */
function set(durationMs) {
  ensureDataDir();
  const now = Date.now();
  const record = {
    since: new Date(now).toISOString(),
    until: durationMs ? new Date(now + durationMs).toISOString() : null,
  };
  writeFileAtomic(pausePath(), JSON.stringify(record));
  return record;
}

/** Turns the pause off. Returns true when a pause was actually removed. */
function clear() {
  try {
    fs.unlinkSync(pausePath());
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { parseDuration, read, remainingMs, isPaused, set, clear };
