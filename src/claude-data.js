'use strict';

/**
 * Locates the Claude Desktop App / Claude Code data on disk.
 *
 * There is no single documented location, and it differs per install:
 *   - Windows: %LOCALAPPDATA%\Claude (logs) and %APPDATA%\Claude (app state)
 *   - macOS:   ~/Library/Application Support/Claude
 *   - Linux:   $XDG_CONFIG_HOME/Claude (or ~/.config/Claude)
 *   - Claude Code (all platforms): ~/.claude, with one JSONL transcript per
 *     session under ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * So we probe every candidate and use whichever exist. Several things are
 * derived from that: which model is in use (model-detector), which session is
 * open (session-info / claude-sessions), when Claude was last doing something
 * (activity-detector) and how much of the plan is used (plan-usage).
 *
 * Privacy: only file METADATA (paths, mtimes) is used here. Reading file
 * contents is the caller's job and is limited to a handful of named fields.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Sub-directories that hold per-session transcripts, relative to a root.
const SESSION_SUBDIRS = ['projects', 'claude-code-sessions', 'sessions'];
const TRANSCRIPT_RE = /\.jsonl?$/i;
const MAX_DEPTH = 5;
const MAX_FILES = 400; // hard cap so a huge history can't stall a poll

// The directory walk is the single most expensive thing the poll loop does
// (readdir + stat on up to MAX_FILES files), and three detectors ask for it
// on every poll. One short-lived cache turns that into one walk per poll.
const TRANSCRIPTS_CACHE_MS = 5 * 1000;
let transcriptsCache = { at: 0, list: null };

// The desktop app's own storage, written by the renderer when the UI does
// something for you (conversation cache, drafts, settings). Its `logs/` folder
// is deliberately NOT in this list: main.log receives a heartbeat roughly every
// minute whether or not anyone is using the app, which made "active" mean
// "open" for the desktop app.
const DESKTOP_STORAGE_DIRS = ['IndexedDB', 'Local Storage', 'Session Storage'];

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function homeDir() {
  return os.homedir();
}

/** The Claude Code data directory (~/.claude), whether or not it exists. */
function claudeCodeDir() {
  return path.join(homeDir(), '.claude');
}

/** Every directory the DESKTOP app might store data in, existing or not. */
function desktopRoots() {
  const home = homeDir();
  const roots = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    roots.push(path.join(local, 'Claude'), path.join(roaming, 'Claude'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support', 'Claude'));
  } else {
    roots.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude'));
  }
  return roots;
}

// Root lookups go through module.exports so a test (or a future config
// override) can point them elsewhere without touching the real machine.
const self = () => module.exports;

/** Every directory Claude might store data in, existing or not. */
function candidateRoots() {
  return [...self().desktopRoots(), self().claudeCodeDir()];
}

/** The subset of candidateRoots() that actually exists on this machine. */
function roots() {
  return candidateRoots().filter(isDir);
}

/**
 * The folder name Claude Code derives from a working directory for its
 * transcripts: every character outside [A-Za-z0-9] becomes "-", so
 * "C:\dev\my app" → "C--dev-my-app". Needed to jump straight to a live
 * session's transcript instead of walking the whole history.
 */
function encodeCwd(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Path of a session's transcript, or null when it doesn't exist. Tries the
 * derived folder first and falls back to a bounded search by session id.
 */
function transcriptFor(cwd, sessionId) {
  if (!sessionId || !/^[a-z0-9-]+$/i.test(String(sessionId))) return null;
  const projects = path.join(self().claudeCodeDir(), 'projects');
  if (cwd) {
    const direct = path.join(projects, encodeCwd(cwd), `${sessionId}.jsonl`);
    try {
      if (fs.statSync(direct).isFile()) return direct;
    } catch (_) {
      /* not there — fall through to the search */
    }
  }
  const wanted = `${sessionId}.jsonl`.toLowerCase();
  for (const t of transcripts(MAX_FILES)) {
    if (path.basename(t.file).toLowerCase() === wanted) return t.file;
  }
  return null;
}

/** Collects transcript files under `dir` into `out`, bounded in depth and count. */
function collect(dir, depth, out) {
  if (depth < 0 || out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, depth - 1, out);
    } else if (entry.isFile() && TRANSCRIPT_RE.test(entry.name)) {
      try {
        out.push({ file: full, mtime: fs.statSync(full).mtimeMs });
      } catch (_) {
        /* vanished between readdir and stat — ignore */
      }
    }
  }
}

/**
 * Session transcripts, newest first. The walk is cached for a few seconds so
 * the detectors that all call this on the same poll share one pass.
 * @param {number} limit  how many to return
 * @returns {Array<{file: string, mtime: number}>}
 */
function transcripts(limit) {
  const now = Date.now();
  if (!transcriptsCache.list || now - transcriptsCache.at > TRANSCRIPTS_CACHE_MS) {
    const found = [];
    for (const root of roots()) {
      for (const sub of SESSION_SUBDIRS) {
        const dir = path.join(root, sub);
        if (isDir(dir)) collect(dir, MAX_DEPTH, found);
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    transcriptsCache = { at: now, list: found };
  }
  return transcriptsCache.list.slice(0, Math.max(1, limit));
}

/** Newest mtime of any regular file directly inside `dir`, or 0. */
function newestFileMtime(dir, depth) {
  let newest = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) newest = Math.max(newest, newestFileMtime(full, depth - 1));
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const { mtimeMs } = fs.statSync(full);
      if (mtimeMs > newest) newest = mtimeMs;
    } catch (_) {
      /* ignore */
    }
  }
  return newest;
}

/** Newest mtime among the desktop app's own log files (a coarse liveness signal). */
function newestLogMtime() {
  let newest = 0;
  for (const root of self().desktopRoots()) {
    newest = Math.max(newest, newestFileMtime(path.join(root, 'logs'), 0));
  }
  return newest || null;
}

/**
 * Newest write to the desktop app's storage (IndexedDB / Local Storage), in
 * epoch ms, or null when no such directory exists. Unlike the logs this only
 * moves when the app's UI actually stores something.
 */
function newestDesktopStorageMtime() {
  let newest = 0;
  for (const root of self().desktopRoots()) {
    for (const sub of DESKTOP_STORAGE_DIRS) {
      newest = Math.max(newest, newestFileMtime(path.join(root, sub), 2));
    }
  }
  return newest || null;
}

/**
 * When Claude last did something for you (a transcript append or a desktop
 * storage write), in epoch ms, or null if no Claude data could be found at
 * all on this machine.
 */
function lastWriteMs() {
  const newestTranscript = transcripts(1)[0];
  const candidates = [
    newestTranscript ? newestTranscript.mtime : 0,
    newestDesktopStorageMtime() || 0,
  ];
  const newest = Math.max(...candidates);
  return newest > 0 ? newest : null;
}

/** Drops the transcript cache — used by tests and `doctor`. */
function resetCache() {
  transcriptsCache = { at: 0, list: null };
}

module.exports = {
  candidateRoots,
  desktopRoots,
  claudeCodeDir,
  roots,
  encodeCwd,
  transcriptFor,
  transcripts,
  lastWriteMs,
  newestLogMtime,
  newestDesktopStorageMtime,
  resetCache,
};
