'use strict';

/**
 * Best-effort details about the CURRENT Claude session: which project folder it
 * runs in, the git branch, its title, how many prompts you've sent, how many
 * tokens it has produced/added to its context, and when it started.
 *
 * Where this comes from: Claude Code writes one append-only JSONL transcript
 * per session (see claude-data.js). Each line is a JSON object which — in
 * current builds — carries `cwd`, `gitBranch`, `type` and `timestamp` fields,
 * and assistant lines carry `message.usage` token counts. When Claude Code's
 * live registry (claude-sessions.js) names the session that is actually open,
 * we read exactly that transcript; otherwise the most recently written one.
 *
 * Counting is precise on purpose: a transcript's `"type":"user"` lines are
 * mostly tool RESULTS fed back to the model, not things you typed. Only lines
 * whose content is plain text count as a prompt. Every line is decoded just
 * long enough to classify it — message text is never kept, stored or logged.
 *
 * Every field is optional and may be null: the desktop app alone (without
 * Claude Code) leaves no transcript, and Anthropic can change this layout at
 * any time. Callers MUST treat null as normal — the presence simply omits the
 * corresponding placeholder.
 */

const fs = require('fs');
const path = require('path');
const claudeData = require('./claude-data');
const claudeSessions = require('./claude-sessions');

const CACHE_TTL_MS = 10 * 1000; // the poll loop asks often; keep it cheap
const TAIL_BYTES = 256 * 1024; // how much of the transcript's end we read
const HEAD_BYTES = 8 * 1024; // enough for the first line (session start)
const MAX_SCAN_BYTES = 16 * 1024 * 1024; // safety cap for a full (first) count
const MAX_LINE_BYTES = 2 * 1024 * 1024; // a single line bigger than this is skipped

const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const BRANCH_RE = /"gitBranch"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const TITLE_RE = /"customTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const TIMESTAMP_RE = /"timestamp"\s*:\s*"([^"]+)"/;
const USER_LINE_RE = /"type"\s*:\s*"user"/;
const ASSISTANT_LINE_RE = /"type"\s*:\s*"assistant"/;

let cache = { at: 0, value: null };

// Transcripts are append-only, so prompt/token totals are kept per file and
// only the bytes added since the last look are parsed. A file that shrank or
// was replaced is simply recounted from the start.
let counters = { file: null, offset: 0, prompts: 0, tokens: 0, carry: '' };

/** Reads `len` bytes of `file` starting at `start`, or '' on any error. */
function readSlice(file, start, len) {
  if (len <= 0) return '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, start);
    return buf.slice(0, read).toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

/** Last capture of a global regex in `text`, JSON-unescaped, or null. */
function lastMatch(text, re) {
  re.lastIndex = 0;
  let value = null;
  for (const m of text.matchAll(re)) value = m[1];
  if (value == null) return null;
  try {
    return JSON.parse(`"${value}"`); // turns \\ and \" back into real chars
  } catch (_) {
    return value;
  }
}

/** "C:\\dev\\my-app" → "my-app"; tolerant of both path separators. */
function projectNameFromCwd(cwd) {
  if (!cwd) return null;
  const cleaned = String(cwd).replace(/[\\/]+$/, '');
  const name = cleaned.split(/[\\/]/).pop();
  return name || null;
}

/**
 * Falls back to the transcript's parent directory name, which Claude Code
 * derives from the project path (e.g. "C--dev-my-app"). Only used when no
 * `cwd` field is present; it's approximate on purpose.
 */
function projectNameFromDir(file) {
  const dir = path.basename(path.dirname(file));
  if (!dir || dir === 'projects') return null;
  const parts = dir.split('-').filter(Boolean);
  // Drop a leading drive letter segment ("C--dev-my-app" → "dev-my-app").
  if (parts.length > 1 && /^[a-z]$/i.test(parts[0])) parts.shift();
  return parts.length ? parts.join('-') : null;
}

/**
 * Git reports "HEAD" for a detached head or a folder that isn't a repository
 * at all — neither is a branch anyone wants on their profile.
 */
function cleanBranch(branch) {
  if (!branch) return null;
  const b = String(branch).trim();
  return b && b !== 'HEAD' ? b : null;
}

/**
 * Classifies one transcript line. Returns { prompt: 0|1, tokens: n }.
 * A prompt is a `user` line whose content is text (a string, or an array of
 * text blocks) — tool results come back as `tool_result` blocks and sidechain
 * (sub-agent) traffic is not something you typed.
 */
function classifyLine(line) {
  const out = { prompt: 0, tokens: 0 };
  if (!line || line.length > MAX_LINE_BYTES) return out;
  const isUser = USER_LINE_RE.test(line);
  const isAssistant = !isUser && ASSISTANT_LINE_RE.test(line);
  if (!isUser && !isAssistant) return out;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (_) {
    return out;
  }
  if (!obj || typeof obj !== 'object' || obj.isSidechain) return out;
  const message = obj.message && typeof obj.message === 'object' ? obj.message : null;
  if (obj.type === 'user') {
    const content = message ? message.content : undefined;
    if (typeof content === 'string') {
      out.prompt = content.trim() ? 1 : 0;
    } else if (Array.isArray(content) && content.length) {
      const hasToolResult = content.some((b) => b && b.type === 'tool_result');
      const hasText = content.some((b) => b && b.type === 'text' && String(b.text || '').trim());
      out.prompt = !hasToolResult && hasText ? 1 : 0;
    }
  } else if (obj.type === 'assistant' && message && message.usage && typeof message.usage === 'object') {
    // Tokens the session produced or added to its context. Cache READS are
    // left out on purpose: every turn re-reads the whole context, so counting
    // them makes a one-prompt session look like tens of millions of tokens.
    const u = message.usage;
    for (const key of ['input_tokens', 'cache_creation_input_tokens', 'output_tokens']) {
      const n = Number(u[key]);
      if (Number.isFinite(n) && n > 0) out.tokens += n;
    }
  }
  return out;
}

/**
 * Prompt and token totals for `file`, parsing only what was appended since
 * the previous call (or everything, the first time / after a rewrite).
 * @returns {{prompts: ?number, tokens: ?number}}
 */
function countIncremental(file, size) {
  if (counters.file !== file || size < counters.offset) {
    counters = { file, offset: 0, prompts: 0, tokens: 0, carry: '' };
  }
  let start = counters.offset;
  // A brand-new, very large history: cap the work and count the newest part
  // (the count is then a floor — still far better than counting tool results).
  if (start === 0 && size > MAX_SCAN_BYTES) start = size - MAX_SCAN_BYTES;
  if (size > start) {
    const text = counters.carry + readSlice(file, start, size - start);
    const lines = text.split('\n');
    // The last piece may be a half-written line: keep it for the next pass.
    counters.carry = lines.pop() || '';
    for (const line of lines) {
      const { prompt, tokens } = classifyLine(line);
      counters.prompts += prompt;
      counters.tokens += tokens;
    }
    counters.offset = size;
  }
  // Count a complete-but-unterminated final line too (Claude Code ends every
  // line with \n, but be tolerant); it is re-parsed on the next append.
  let prompts = counters.prompts;
  let tokens = counters.tokens;
  if (counters.carry && counters.carry.trim().endsWith('}')) {
    const extra = classifyLine(counters.carry);
    prompts += extra.prompt;
    tokens += extra.tokens;
  }
  return { prompts: prompts > 0 ? prompts : null, tokens: tokens > 0 ? tokens : null };
}

function readSession(file, live) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return null; }
  if (!st.size) return null;

  const tail = readSlice(file, Math.max(0, st.size - TAIL_BYTES), Math.min(st.size, TAIL_BYTES));
  const head = st.size > TAIL_BYTES ? readSlice(file, 0, HEAD_BYTES) : tail;

  const cwd = (live && live.cwd) || lastMatch(tail, CWD_RE);
  const startedIso = (head.match(TIMESTAMP_RE) || [])[1] || null;
  const startedMs = startedIso ? Date.parse(startedIso) : NaN;
  const counts = countIncremental(file, st.size);

  return {
    file,
    project: projectNameFromCwd(cwd) || projectNameFromDir(file),
    cwd: cwd || null,
    branch: cleanBranch(lastMatch(tail, BRANCH_RE)),
    title: (live && live.title) || lastMatch(tail, TITLE_RE) || null,
    messages: counts.prompts,
    tokens: counts.tokens,
    status: live ? live.status : null,
    sessionStart: (live && live.startedAt) || (Number.isFinite(startedMs) ? startedMs : null),
    lastWrite: st.mtimeMs,
    live: !!live,
  };
}

/**
 * Details of the session that is open right now (per Claude Code's registry),
 * else the most-recently-written one, or null when none is readable.
 * Cached for 10s so calling this on every poll is essentially free.
 * @param {Set<number>} [knownPids]  Claude process ids, if the caller has them
 * @returns {{file: string, project: ?string, cwd: ?string, branch: ?string,
 *            title: ?string, messages: ?number, tokens: ?number,
 *            status: ?string, sessionStart: ?number, lastWrite: number,
 *            live: boolean}|null}
 */
function detect(knownPids) {
  const now = Date.now();
  if (now - cache.at < CACHE_TTL_MS) return cache.value;
  let value = null;
  try {
    const live = claudeSessions.primary(knownPids);
    const file = live ? claudeData.transcriptFor(live.cwd, live.sessionId) : null;
    if (file) {
      value = readSession(file, live);
    } else {
      const newest = claudeData.transcripts(1)[0];
      if (newest) value = readSession(newest.file, null);
    }
  } catch (_) {
    /* never let detection throw into the daemon loop */
  }
  cache = { at: now, value };
  return value;
}

/** "13247" → "13.2k", "2810000" → "2.8M"; '' for nothing. */
function formatTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1e9) return `${(v / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(v));
}

/** Drops the caches — used by tests and by `doctor` for a fresh reading. */
function resetCache() {
  cache = { at: 0, value: null };
  counters = { file: null, offset: 0, prompts: 0, tokens: 0, carry: '' };
}

module.exports = {
  detect,
  resetCache,
  projectNameFromCwd,
  projectNameFromDir,
  cleanBranch,
  classifyLine,
  countIncremental,
  formatTokens,
};
