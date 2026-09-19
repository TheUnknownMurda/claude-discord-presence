'use strict';

/**
 * Best-effort detection of which Claude model is in use.
 *
 * IMPORTANT: the Claude Desktop App does NOT expose the selected model in any
 * stable, documented location. The only place a model ID reliably appears on
 * disk is inside Claude Code / agent-mode session transcripts, as the
 * `"model"` field of each assistant message. We read the live session's
 * transcript when Claude Code's registry names one (see claude-sessions.js),
 * else the few most-recently-modified ones, and take the newest model field.
 * This is inherently approximate (it reflects agent sessions, not necessarily
 * the chat model) and may break when the app changes its internal layout, so
 * callers MUST treat a null result as normal and fall back to the configured
 * label.
 *
 * Matching is anchored on the JSON field, not on any "claude-…" text: a
 * conversation that merely *mentions* a model id (a pasted doc, a system
 * prompt echoed into a tool result) must not change what is displayed.
 *
 * Transcripts are append-only, so we read from the END of the file: the last
 * model field in the file is the one currently in use.
 *
 * Display names come from Claude Code's own model catalogue cache when it is
 * present (so "claude-fable-5-1" reads "Fable 5.1" exactly as the app names
 * it), with a heuristic fallback for ids the catalogue doesn't know.
 *
 * Privacy: we read only a small slice of the newest session files, extract the
 * model identifier, and never store, log, or transmit conversation content.
 */

const fs = require('fs');
const path = require('path');
const claudeData = require('./claude-data');
const claudeSessions = require('./claude-sessions');

// The `"model":"claude-…"` field as Claude Code writes it. Global so
// .matchAll() yields every occurrence; we keep the last one.
const MODEL_FIELD_RE = /"model"\s*:\s*"(claude-[a-z0-9-]+)"/gi;
// Loose fallback for other transcript layouts (used only when no field matched).
const MODEL_ID_RE = /claude-(?:opus|sonnet|haiku|fable)-[0-9]+(?:-[0-9]+)*/gi;

const CACHE_TTL_MS = 30 * 1000;
const MAX_READ_BYTES = 512 * 1024; // how much of a transcript's tail we read
const MAX_FILES_SCANNED = 12; // how many recent files to try before giving up

const CATALOG_TTL_MS = 10 * 60 * 1000;

let cache = { at: 0, value: null };
let catalogCache = { at: 0, map: null };

/**
 * "claude-opus-4-8" → "Opus 4.8"; "claude-haiku-4-5-20251001" → "Haiku 4.5".
 * With a catalogue (id → name) the app's own display name wins.
 */
function friendlyModel(id, catalog) {
  const key = String(id).toLowerCase();
  if (catalog && typeof catalog[key] === 'string' && catalog[key].trim()) return catalog[key].trim();
  let m = key.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const parts = m.split('-');
  const family = parts.shift() || '';
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  const version = parts.join('.');
  return version ? `${name} ${version}` : name;
}

/**
 * Claude Code caches the model catalogue it was served (id → display name)
 * under ~/.claude/cache/model-catalog/*.json. Newest file wins.
 * @returns {Object<string,string>|null}
 */
function loadCatalog() {
  const now = Date.now();
  if (catalogCache.map !== null && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.map;
  let map = null;
  try {
    const dir = path.join(claudeData.claudeCodeDir(), 'cache', 'model-catalog');
    const files = fs.readdirSync(dir)
      .filter((n) => /\.json$/i.test(n))
      .map((n) => {
        const file = path.join(dir, n);
        let mtime = 0;
        try { mtime = fs.statSync(file).mtimeMs; } catch (_) {}
        return { file, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const { file } of files) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const models = data && data.catalog && data.catalog.config && Array.isArray(data.catalog.config.models)
        ? data.catalog.config.models
        : null;
      if (!models) continue;
      map = {};
      for (const m of models) {
        if (m && typeof m.id === 'string' && typeof m.name === 'string') map[m.id.toLowerCase()] = m.name;
      }
      break;
    }
  } catch (_) {
    map = null;
  }
  catalogCache = { at: now, map: map || {} };
  return map;
}

/** Reads the tail of a transcript and returns the last model id in it, or null. */
function readModelIdFrom(file) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, MAX_READ_BYTES);
    if (len <= 0) return null;
    const start = st.size - len; // tail, not head
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const text = buf.toString('utf8');
      let last = null;
      for (const m of text.matchAll(MODEL_FIELD_RE)) last = m[1];
      if (last) return last.toLowerCase();
      const loose = text.match(MODEL_ID_RE);
      if (loose && loose.length) return loose[loose.length - 1].toLowerCase();
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

/** Same as readModelIdFrom but rendered for display. */
function readModelFrom(file) {
  const id = readModelIdFrom(file);
  return id ? friendlyModel(id, loadCatalog()) : null;
}

/**
 * Returns the best-effort friendly model name (e.g. "Opus 4.8"), or null if it
 * couldn't be determined. Cached for 30s so this stays cheap to call on every
 * poll.
 * @param {Set<number>} [knownPids]  Claude process ids, if the caller has them
 */
function detect(knownPids) {
  const now = Date.now();
  if (now - cache.at < CACHE_TTL_MS) return cache.value;
  let value = null;
  try {
    // The session that is actually open is the one whose model matters.
    const live = claudeSessions.primary(knownPids);
    const liveFile = live ? claudeData.transcriptFor(live.cwd, live.sessionId) : null;
    if (liveFile) value = readModelFrom(liveFile);
    // Newest transcript first (the common case), falling back to slightly
    // older sessions so one model-less file at the top doesn't blank out
    // detection entirely.
    if (!value) {
      for (const { file } of claudeData.transcripts(MAX_FILES_SCANNED)) {
        if (file === liveFile) continue;
        value = readModelFrom(file);
        if (value) break;
      }
    }
  } catch (_) {
    /* never let detection throw into the daemon loop */
  }
  cache = { at: now, value };
  return value;
}

/** Drops the caches — used by tests and by `doctor` for a fresh reading. */
function resetCache() {
  cache = { at: 0, value: null };
  catalogCache = { at: 0, map: null };
}

module.exports = { detect, friendlyModel, readModelIdFrom, loadCatalog, resetCache };
