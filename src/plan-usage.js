'use strict';

/**
 * Real plan usage, read from the desktop app's own cache.
 *
 * The Claude Desktop App polls your subscription's rate-limit meters (the
 * ones shown in its "plan usage" tray) about every 15 minutes and appends a
 * sample to `plan-usage-history.json` in its data directory:
 *
 *   { "version": 2, "samples": [ { "t": <epoch ms>, "org": "<uuid>",
 *                                  "u": { "fh": <0-100>, "sd": <0-100> } }, … ] }
 *
 *   fh = percent of the rolling 5-hour window used
 *   sd = percent of the rolling 7-day window used
 *
 * This is the one place a genuinely accurate "how much of my plan have I
 * used" number exists locally, so we read the newest sample and expose it as
 * the {usage5h} / {usage7d} placeholders and, optionally, in the tooltip.
 * The file is only refreshed while the desktop app runs, so a sample older
 * than MAX_AGE_MS is treated as unavailable rather than shown stale.
 *
 * Privacy: two percentages and a timestamp are read; the organisation id is
 * used only to keep samples from one account together, never exposed.
 */

const fs = require('fs');
const path = require('path');
const claudeData = require('./claude-data');

const FILE_NAME = 'plan-usage-history.json';
const CACHE_TTL_MS = 60 * 1000;
const MAX_AGE_MS = 45 * 60 * 1000; // three missed 15-minute samples → stale
const MAX_BYTES = 4 * 1024 * 1024; // the file grows forever; read only the tail

let cache = { at: 0, value: null };

/** Candidate paths of the history file, existing or not. */
function candidateFiles() {
  return claudeData.desktopRoots().map((root) => path.join(root, FILE_NAME));
}

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Parses the history file's content into the newest usable sample. */
function parse(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return null;
  }
  const samples = data && Array.isArray(data.samples) ? data.samples : null;
  if (!samples || !samples.length) return null;
  // Walk backwards for the newest sample that actually carries numbers.
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (!s || !Number.isFinite(s.t) || !s.u || typeof s.u !== 'object') continue;
    const fiveHourPct = clampPct(s.u.fh);
    const sevenDayPct = clampPct(s.u.sd);
    if (fiveHourPct === null && sevenDayPct === null) continue;
    return { at: s.t, fiveHourPct, sevenDayPct };
  }
  return null;
}

/**
 * Reads the newest sample from the first history file that exists. Large
 * files are read from the end only: samples are appended chronologically, so
 * the tail — re-wrapped into valid JSON — is all we need.
 */
function readNewest() {
  for (const file of candidateFiles()) {
    let st;
    try { st = fs.statSync(file); } catch (_) { continue; }
    if (!st.isFile() || !st.size) continue;
    let text;
    try {
      if (st.size <= MAX_BYTES) {
        text = fs.readFileSync(file, 'utf8');
      } else {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(MAX_BYTES);
          const n = fs.readSync(fd, buf, 0, MAX_BYTES, st.size - MAX_BYTES);
          const tail = buf.slice(0, n).toString('utf8');
          // Resume at the first complete sample object in the tail.
          const start = tail.indexOf('{"t"');
          text = start >= 0 ? `{"samples":[${tail.slice(start).replace(/\]\s*\}\s*$/, '')}]}` : '';
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch (_) {
      continue;
    }
    const sample = parse(text);
    if (sample) return { ...sample, file };
  }
  return null;
}

/**
 * The newest plan-usage sample, or null when none exists or it is stale.
 * @returns {{at: number, fiveHourPct: ?number, sevenDayPct: ?number,
 *            ageMs: number, file: string}|null}
 */
function current() {
  const now = Date.now();
  if (now - cache.at < CACHE_TTL_MS) return cache.value;
  let value = null;
  try {
    const sample = readNewest();
    if (sample) {
      const ageMs = Math.max(0, now - sample.at);
      value = ageMs <= MAX_AGE_MS ? { ...sample, ageMs } : null;
    }
  } catch (_) {
    /* never let this throw into the daemon loop */
  }
  cache = { at: now, value };
  return value;
}

/** The newest sample regardless of age (for `doctor`), or null. */
function latestAnyAge() {
  try {
    const sample = readNewest();
    return sample ? { ...sample, ageMs: Math.max(0, Date.now() - sample.at) } : null;
  } catch (_) {
    return null;
  }
}

/** "60%" for a percentage, or '' when unknown. */
function formatPct(value) {
  return value === null || value === undefined ? '' : `${value}%`;
}

/** Drops the cache — used by tests and by `doctor` for a fresh reading. */
function resetCache() {
  cache = { at: 0, value: null };
}

module.exports = { current, latestAnyAge, parse, formatPct, candidateFiles, resetCache, MAX_AGE_MS };
