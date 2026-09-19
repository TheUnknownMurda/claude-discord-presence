'use strict';

/**
 * Local-only daily usage tracking. Stores a simple map of
 * { "YYYY-MM-DD": secondsClaudeWasOpen } in stats.json. Used to show
 * "• 1h 23m today" in the presence tooltip and by `claude-presence stats`.
 * This data NEVER leaves the machine and old entries are pruned automatically.
 *
 * Writes are buffered: the daemon records a few seconds on every poll, and
 * rewriting the whole file that often is pointless disk churn. Seconds
 * accumulate in memory and are flushed at most once a minute (and always on
 * shutdown). Readers add the un-flushed remainder so totals are never stale.
 */

const fs = require('fs');
const { statsPath, ensureDataDir } = require('./paths');
const { writeFileAtomic } = require('./fs-utils');

const RETENTION_MS = 60 * 24 * 3600 * 1000; // keep ~60 days
const FLUSH_INTERVAL_MS = 60 * 1000;

// Seconds recorded but not yet written to disk, and the day they belong to.
let pending = 0;
let pendingKey = null;
let lastFlush = 0;

/** Local date key for a Date (defaults to now), e.g. "2026-06-12". */
function dayKey(date) {
  const d = date || new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function today() {
  return dayKey();
}

// The parsed file, kept for a few seconds: one poll asks for today's, this
// month's and the streak total several times over, and each used to re-read
// and re-parse stats.json. The TTL keeps a CLI command (another process)
// from ever seeing a stale total for long, and every write refreshes it.
const LOAD_CACHE_MS = 5 * 1000;
let loadCache = { at: 0, data: null };

function loadAll() {
  const now = Date.now();
  if (loadCache.data && now - loadCache.at < LOAD_CACHE_MS) return { ...loadCache.data };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(statsPath(), 'utf8')) || {};
  } catch (_) {
    data = {};
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  loadCache = { at: now, data };
  return { ...data };
}

function saveAll(data) {
  try {
    ensureDataDir();
    // Atomic write: a crash mid-save can never truncate stats.json (which
    // loadAll would then read as {} — silently wiping all usage history).
    writeFileAtomic(statsPath(), JSON.stringify(data));
    loadCache = { at: Date.now(), data: { ...data } };
  } catch (_) {
    /* stats are best-effort; never crash the daemon over them */
  }
}

/** Forgets the in-memory copy so the next read hits the disk (tests). */
function resetCache() {
  loadCache = { at: 0, data: null };
}

/** Writes any buffered seconds to disk and prunes old days. */
function flush() {
  lastFlush = Date.now();
  if (!pending || !pendingKey) return;
  const data = loadAll();
  data[pendingKey] = (data[pendingKey] || 0) + pending;
  pending = 0;
  pendingKey = null;

  const cutoff = Date.now() - RETENTION_MS;
  for (const k of Object.keys(data)) {
    const t = Date.parse(k);
    if (!Number.isNaN(t) && t < cutoff) delete data[k];
  }
  saveAll(data);
}

/**
 * Buffers `seconds` against today's total, flushing periodically.
 * @returns {number} today's total including the un-flushed remainder
 */
function addSeconds(seconds) {
  const key = today();
  // Crossing midnight: bank the previous day before starting the new one.
  if (pendingKey && pendingKey !== key) flush();
  pending += Math.max(0, seconds);
  pendingKey = key;
  if (Date.now() - lastFlush >= FLUSH_INTERVAL_MS) flush();
  return getTodaySeconds();
}

/** Un-flushed seconds that belong to `key`. */
function pendingFor(key) {
  return pendingKey === key ? pending : 0;
}

function getDaySeconds(key) {
  return (loadAll()[key] || 0) + pendingFor(key);
}

function getTodaySeconds() {
  return getDaySeconds(today());
}

/** Total seconds recorded so far this calendar month. */
function getMonthSeconds() {
  const prefix = today().slice(0, 7); // "YYYY-MM"
  const data = loadAll();
  let total = 0;
  for (const key of Object.keys(data)) {
    if (key.startsWith(prefix)) total += data[key] || 0;
  }
  if (pendingKey && pendingKey.startsWith(prefix)) total += pending;
  return total;
}

/**
 * The last `days` calendar days, oldest first — including days with no usage,
 * so callers can render an even bar chart.
 * @returns {Array<{date: string, seconds: number}>}
 */
function getLastDays(days) {
  const n = Math.max(1, Math.floor(days) || 7);
  const data = loadAll();
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = dayKey(d);
    out.push({ date: key, seconds: (data[key] || 0) + pendingFor(key) });
  }
  return out;
}

/**
 * Every day on record (plus un-flushed seconds), oldest first.
 * @returns {Array<{date: string, seconds: number}>}
 */
function getAllDays() {
  const data = loadAll();
  if (pendingKey) data[pendingKey] = (data[pendingKey] || 0) + pending;
  return Object.keys(data)
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort()
    .map((date) => ({ date, seconds: data[date] || 0 }));
}

/**
 * Length of the current run of consecutive days with real usage, counting back
 * from today. A day counts once it has at least `minSeconds`. Today not having
 * started yet does NOT break the streak (it just isn't counted), so the number
 * only drops after a full day has gone by unused.
 * @param {number} [minSeconds=60]
 */
function getStreakDays(minSeconds) {
  const min = Number.isFinite(minSeconds) ? Math.max(0, minSeconds) : 60;
  const data = loadAll();
  const secondsOn = (key) => (data[key] || 0) + pendingFor(key);

  const now = new Date();
  let streak = 0;
  for (let i = 0; i < 3650; i++) {
    const key = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
    if (secondsOn(key) >= min) streak++;
    else if (i > 0) break; // a gap ends the streak
  }
  return streak;
}

/** The day with the most usage on record, or null when there is none. */
function getBusiestDay() {
  let best = null;
  for (const day of getAllDays()) {
    if (!best || day.seconds > best.seconds) best = day;
  }
  return best && best.seconds > 0 ? best : null;
}

/** Mean seconds per day over the last `days` calendar days (including empty ones). */
function getAverageSeconds(days) {
  const window = getLastDays(days);
  if (!window.length) return 0;
  const total = window.reduce((sum, d) => sum + d.seconds, 0);
  return Math.round(total / window.length);
}

/** The full history as CSV (`date,seconds,human`), suitable for a spreadsheet. */
function toCsv() {
  const rows = ['date,seconds,human'];
  for (const day of getAllDays()) {
    rows.push(`${day.date},${day.seconds},${formatDuration(day.seconds)}`);
  }
  return rows.join('\n') + '\n';
}

/** A machine-readable summary + full history, for `stats --json`. */
function toJson() {
  return {
    generatedAt: new Date().toISOString(),
    today: getTodaySeconds(),
    week: getLastDays(7).reduce((sum, d) => sum + d.seconds, 0),
    month: getMonthSeconds(),
    total: getTotalSeconds(),
    streakDays: getStreakDays(),
    averagePerDay: getAverageSeconds(14),
    busiestDay: getBusiestDay(),
    days: getAllDays(),
  };
}

/** Grand total of every day still on record. */
function getTotalSeconds() {
  const data = loadAll();
  let total = pending;
  for (const key of Object.keys(data)) total += data[key] || 0;
  return total;
}

/** Formats seconds as a compact human string: "1h 23m", "45m", "12s". */
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/**
 * Like formatDuration but never second-resolution, so a value derived from it
 * doesn't change on every poll (which would push a Discord update every time
 * and burn through the rate limit): "1h 23m", "45m", "<1m".
 */
function formatDurationCoarse(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return '<1m';
  return formatDuration(s - (s % 60));
}

module.exports = {
  addSeconds,
  flush,
  resetCache,
  getDaySeconds,
  getTodaySeconds,
  getMonthSeconds,
  getLastDays,
  getAllDays,
  getStreakDays,
  getBusiestDay,
  getAverageSeconds,
  getTotalSeconds,
  toCsv,
  toJson,
  formatDuration,
  formatDurationCoarse,
  today,
  dayKey,
};
