'use strict';

/**
 * Configuration loading/saving with sane defaults.
 *
 * On first run a `config.json` is written to the data directory from
 * DEFAULT_CONFIG. On every load the user's file is deep-merged over the
 * defaults, so upgrading the plugin (which may add new keys) never requires
 * the user to hand-edit their config — missing keys are filled in.
 */

const fs = require('fs');
const { configPath, ensureDataDir } = require('./paths');
const { writeFileAtomic } = require('./fs-utils');
const themes = require('./themes');
const template = require('./template');

// ════════════════════════════════════════════════════════════════════════════
// ► THE ONE-TIME SETUP SWITCH ◄
// Paste a shared Discord Application ID between the quotes below and commit it.
// Once it's set, EVERYONE who installs this build gets working Rich Presence
// with ZERO setup — no Developer Portal, no copying IDs, no per-user config.
//
// To create it (about 2 minutes, done ONCE by you — not by your users):
//   1. https://discord.com/developers/applications → New Application, name it
//      "Claude" (this becomes the "Playing Claude" label).
//   2. Copy its Application ID (the long number) and paste it below.
//   3. Rich Presence → Art Assets → upload the large icon as key `claude`
//      (optional: `active` / `idle` overlays). Uploaded once here, it shows for
//      every installer — they never touch Discord.
//
// Leave it empty and the app still works, falling back to a per-user ID that
// each person supplies via `claude-presence setup` or their config file.
// ════════════════════════════════════════════════════════════════════════════
const DEFAULT_CLIENT_ID = '1515659802209026170';

const DEFAULT_CONFIG = {
  // ── Discord ───────────────────────────────────────────────────────────
  // Leave empty to use the shared Discord app baked into this build
  // (DEFAULT_CLIENT_ID above) — that's the zero-setup default, and what most
  // users should keep. Only set this to override with your OWN Discord
  // Application ID. See the README.
  clientId: '',

  // ── Detection ─────────────────────────────────────────────────────────
  pollIntervalSeconds: 15, // how often to check whether Claude is running
  claudeProcessNames: ['Claude.exe', 'Claude'], // matched case-insensitively
  detectActiveWindow: false, // if true, distinguish "active" (focused) vs "idle"

  // Tell "actually using Claude" apart from "Claude is just open". Claude
  // Code's own session registry says whether a session is busy (generating);
  // otherwise we look at how recently Claude wrote to its own session/storage
  // files (mtimes only — never contents). Falls back to "active" whenever it
  // can't tell.
  activity: {
    detect: true,
    idleAfterSeconds: 300, // no Claude activity for this long → show the idle line
    hideWhenIdle: false, // true = clear the presence entirely while idle
    pauseStatsWhenIdle: false, // true = only count time you're actually active

    // Claude Code (the CLI/agent) may run inside a terminal, with no
    // "Claude.exe" window to find. When this is on, a live Claude Code session
    // (from its registry) — or, on older builds, a very recent write to its
    // session files — also counts as "Claude is in use".
    detectClaudeCode: true,
    claudeCodeWindowSeconds: 120, // fallback: how fresh a write must be to count
  },

  // ── Behaviour ─────────────────────────────────────────────────────────
  // 'clear' = keep the helper running and just hide the presence when Claude
  //           closes (re-shows on reopen). 'exit' = shut the helper down.
  onClaudeClose: 'clear',

  logLevel: 'info', // error | warn | info | debug
  // Show the elapsed timer. It counts from when the current Claude Code
  // session started (per its registry), else from when the Claude app's
  // process was launched — not merely from when this helper noticed it.
  showTimer: true,

  // Which model you're using. The Claude app doesn't reliably expose this, so
  // the label is the dependable source; `detect` is best-effort and may be blank.
  model: {
    show: true,
    label: 'Opus 4.8', // shown like "Opus 4.8 · Actively in a conversation"
    detect: true, // best-effort auto-detection from local Claude session files
  },

  // The desktop app is a flat subscription (no per-message $), so instead of a
  // misleading dollar figure we show your plan name + real, locally-measured time.
  usage: {
    show: true,
    planLabel: 'Claude', // e.g. "Claude", "Claude Pro", "Claude Max"
    showToday: true,
    showMonth: true,
    // The desktop app caches your plan's real rate-limit meters (% of the
    // 5-hour and 7-day windows used). When present and fresh they join the
    // tooltip as "5h 60% · week 38%" and drive {usage5h} / {usage7d}.
    showLimits: true,
    // Also show the plan on the always-visible second line (as "Model · Plan"),
    // not just in the large-icon hover tooltip. Off by default.
    showOnCard: false,
  },

  // The project/repo you're working in, read from the live Claude Code
  // session (its `cwd` / `gitBranch` fields — never your messages).
  // Available to any text field as {project}, {branch}, {title} (the session's
  // title), {messages} (prompts sent) and {tokens}.
  project: {
    show: true,
    detect: true,
    label: '', // pin a name here to override detection entirely
  },

  // Name of a built-in look to start from (see `claude-presence theme list`):
  // default | minimal | coder | stats | chill. Anything you set explicitly in
  // this file still wins over the theme.
  theme: 'default',

  // ── Presence appearance ───────────────────────────────────────────────
  // Every text field below may contain {placeholders}, substituted live:
  //   {model} {plan} {project} {branch} {title} {messages} {tokens} {sessions}
  //   {status} {session} {today} {month} {total} {streak} {idle}
  //   {usage5h} {usage7d} {time}
  // A placeholder with nothing behind it disappears cleanly — together with
  // the words of its " · "-separated segment — so "{model} · {project}" reads
  // just "Opus 4.8" outside a project. "{messages:prompt|prompts}" renders
  // "1 prompt" / "12 prompts".
  presence: {
    // Discord activity type: 0 Playing · 2 Listening · 3 Watching · 5 Competing
    activeType: 0,

    // Each image is EITHER an art-asset key uploaded to your Discord app
    // (Developer Portal → Rich Presence → Art Assets) OR a full https URL to a
    // hosted PNG/JPG (no upload needed — Discord proxies it). See the README.
    largeImage: 'claude',
    largeText: 'Claude',
    smallImageActive: '',
    smallImageIdle: '',
    smallTextActive: 'Active',
    smallTextIdle: 'Idle',

    // Text lines. `details` is the top line; `state` is the second line.
    details: 'Chatting with Claude',
    detailsIdle: '', // optional distinct top line while idle (blank = reuse `details`)
    stateActive: 'Actively in a conversation',
    stateIdle: 'Claude is open',

    // Show "{messages} of N" as Discord's party counter, using the turn count
    // of the current Claude Code session. Off by default: it's approximate.
    showMessageCount: false,

    // If non-empty, the top line rotates through these over time.
    rotateMessages: [
      'Asking Claude the big questions',
      'Pair-programming with Claude',
      'Brainstorming with Claude',
      'Refactoring with a friend',
    ],
    rotateIntervalSeconds: 30,

    // Up to 2 buttons (Discord limit). URLs must be http(s).
    buttons: [
      { label: 'Try Claude', url: 'https://claude.ai' },
      { label: 'Get this plugin', url: 'https://github.com/TheUnknownMurda/claude-discord-presence' },
    ],
  },
};

/** Recursively merges `override` onto `base` (arrays are replaced wholesale). */
function deepMerge(base, override) {
  if (override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) {
    return Array.isArray(override) ? override : base;
  }
  if (base && typeof base === 'object' && override && typeof override === 'object') {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = deepMerge(base[key], override[key]);
    }
    return out;
  }
  return override;
}

/**
 * Applies the named theme between the defaults and the user's file, so a theme
 * fills in what the user hasn't set while every explicit user value still wins.
 */
function withTheme(user) {
  const name = (user && user.theme) || DEFAULT_CONFIG.theme;
  const preset = themes.get(name);
  const base = preset ? deepMerge(DEFAULT_CONFIG, preset) : DEFAULT_CONFIG;
  return deepMerge(base, user || {});
}

/** Loads config, creating it from defaults on first run. Throws on invalid JSON. */
function load() {
  ensureDataDir();
  const p = configPath();
  if (!fs.existsSync(p)) {
    writeFileAtomic(p, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  let user;
  try {
    user = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`config.json is not valid JSON (${p}): ${e.message}`);
  }
  return withTheme(user);
}

// Placeholders any text field may use — anything else is a typo worth warning
// about, because Discord would silently show an empty gap instead.
const KNOWN_PLACEHOLDERS = [
  'model', 'plan', 'project', 'branch', 'title', 'messages', 'tokens', 'sessions',
  'status', 'session', 'today', 'month', 'total', 'streak', 'idle',
  'usage5h', 'usage7d', 'time',
];

const TEXT_FIELDS = [
  'details', 'detailsIdle', 'stateActive', 'stateIdle',
  'largeText', 'smallTextActive', 'smallTextIdle',
];

const ACTIVITY_TYPES = [0, 2, 3, 5];
const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

/**
 * Sanity-checks a loaded config and returns human-readable problems. Nothing
 * here throws or mutates: the daemon logs the list and keeps running with the
 * (merged, therefore always complete) values it has.
 * @returns {string[]}
 */
function validate(cfg) {
  const problems = [];
  if (!cfg || typeof cfg !== 'object') return ['config.json is not an object.'];

  if (cfg.clientId && isClientIdPlaceholder(cfg.clientId)) {
    problems.push(`"clientId" is not a Discord Application ID (expected 15-25 digits): "${cfg.clientId}".`);
  }
  const poll = Number(cfg.pollIntervalSeconds);
  if (!Number.isFinite(poll) || poll < 5) {
    problems.push('"pollIntervalSeconds" must be a number >= 5 (values below that are clamped).');
  }
  if (!Array.isArray(cfg.claudeProcessNames) || cfg.claudeProcessNames.filter(Boolean).length === 0) {
    problems.push('"claudeProcessNames" is empty — Claude can never be detected as running.');
  }
  if (cfg.onClaudeClose !== 'clear' && cfg.onClaudeClose !== 'exit') {
    problems.push(`"onClaudeClose" must be "clear" or "exit" (found "${cfg.onClaudeClose}").`);
  }
  if (cfg.logLevel && !LOG_LEVELS.includes(cfg.logLevel)) {
    problems.push(`"logLevel" must be one of ${LOG_LEVELS.join(', ')} (found "${cfg.logLevel}").`);
  }
  if (cfg.theme && !themes.get(cfg.theme)) {
    problems.push(`Unknown "theme": "${cfg.theme}". Available: ${themes.names().join(', ')}.`);
  }

  const act = cfg.activity || {};
  if (act.idleAfterSeconds !== undefined && (!Number.isFinite(Number(act.idleAfterSeconds)) || Number(act.idleAfterSeconds) < 30)) {
    problems.push('"activity.idleAfterSeconds" must be a number >= 30 (values below that are clamped).');
  }

  const p = cfg.presence || {};
  if (p.activeType !== undefined && !ACTIVITY_TYPES.includes(Number(p.activeType))) {
    problems.push(`"presence.activeType" must be one of ${ACTIVITY_TYPES.join(', ')} (found ${p.activeType}).`);
  }
  for (const field of TEXT_FIELDS) {
    for (const name of template.placeholders(p[field])) {
      if (!KNOWN_PLACEHOLDERS.includes(name)) {
        problems.push(`"presence.${field}" uses an unknown placeholder {${name}}. Known: ${KNOWN_PLACEHOLDERS.map((k) => `{${k}}`).join(' ')}.`);
      }
    }
  }
  const buttons = Array.isArray(p.buttons) ? p.buttons : [];
  if (buttons.length > 2) problems.push('Discord shows at most 2 buttons; the extra ones are ignored.');
  buttons.forEach((b, i) => {
    if (!b || !b.label) problems.push(`"presence.buttons[${i}]" has no label and is ignored.`);
    else if (!/^https?:\/\//i.test(b.url || '')) {
      problems.push(`"presence.buttons[${i}]" (${b.label}) needs an http(s) URL and is ignored.`);
    }
  });

  return problems;
}

function save(cfg) {
  ensureDataDir();
  // Atomic write so a crash (or a concurrent reader) can't see a half-written
  // config.json, which load() would then reject as invalid JSON.
  writeFileAtomic(configPath(), JSON.stringify(cfg, null, 2));
}

/** True when the given value is not a usable Discord Application ID (digits only). */
function isClientIdPlaceholder(clientId) {
  return !clientId || !/^\d{15,25}$/.test(String(clientId));
}

/**
 * The Discord Application ID actually used at runtime: the user's config value
 * if valid; otherwise the baked-in DEFAULT_CLIENT_ID (for zero-setup forks);
 * otherwise null (presence stays disabled until one is provided).
 */
function resolveClientId(cfg) {
  const raw = cfg && cfg.clientId;
  if (!isClientIdPlaceholder(raw)) return String(raw);
  if (!isClientIdPlaceholder(DEFAULT_CLIENT_ID)) return String(DEFAULT_CLIENT_ID);
  return null;
}

/**
 * The user's config.json exactly as written — no defaults, no theme. Editing
 * commands work on this so they never freeze today's defaults into the file.
 */
function loadUserFile() {
  const p = configPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (e) {
    throw new Error(`config.json is not valid JSON (${p}): ${e.message}`);
  }
}

/** Deep-merges `patch` into the user's file and writes it back. */
function savePatch(patch) {
  ensureDataDir();
  const merged = deepMerge(loadUserFile(), patch || {});
  writeFileAtomic(configPath(), JSON.stringify(merged, null, 2));
  return merged;
}

/**
 * Sets one dotted key (`presence.details`) on the user's config FILE — not the
 * merged view — so `claude-presence config set` never bakes defaults into it.
 * Values are parsed as JSON when possible, else kept as a string.
 * @returns {{key: string, value: any}}
 */
function setKey(dottedKey, rawValue) {
  const parts = String(dottedKey || '').split('.').filter(Boolean);
  if (!parts.length) throw new Error('Expected a key like "presence.details".');

  ensureDataDir();
  const p = configPath();
  const user = loadUserFile();

  let value;
  try {
    value = JSON.parse(rawValue); // numbers, booleans, arrays, objects, null
  } catch (_) {
    value = rawValue; // a bare string like: presence.details Hello there
  }

  let node = user;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== 'object' || Array.isArray(node[part])) node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
  writeFileAtomic(p, JSON.stringify(user, null, 2));
  return { key: parts.join('.'), value };
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_CLIENT_ID,
  KNOWN_PLACEHOLDERS,
  load,
  save,
  setKey,
  validate,
  withTheme,
  deepMerge,
  isClientIdPlaceholder,
  resolveClientId,
  configPath,
};
