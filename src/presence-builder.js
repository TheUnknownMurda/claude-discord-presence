'use strict';

/**
 * Turns the current detection state + user config into a Discord "activity"
 * object (or null to clear).
 *
 * Every text field supports {placeholders} (see template.js). They resolve
 * lazily, so a config that never mentions {today} never touches stats.json —
 * which keeps this function cheap and keeps the tests hermetic.
 *
 * Supported placeholders:
 *   {model}    the model in use, e.g. "Opus 4.8"
 *   {plan}     usage.planLabel, e.g. "Claude Max"
 *   {project}  folder name of the current Claude Code session
 *   {branch}   its git branch
 *   {messages} number of prompts you have sent in that session
 *   {title}    the session's title (as shown in Claude Code / the Code tab)
 *   {tokens}   tokens that session has produced or added to context ("165k")
 *   {sessions} how many Claude Code sessions are open right now
 *   {status}   the active/idle status line, already resolved
 *   {session}  how long the current session has been open ("1h 20m")
 *   {idle}     how long since Claude last did anything ("4m")
 *   {today} {month} {total}  locally-measured usage
 *   {streak}   consecutive days of use
 *   {usage5h} {usage7d}  real plan usage, % of the 5-hour / 7-day window
 *   {time}     local clock time, HH:MM
 */

const stats = require('./stats');
const template = require('./template');
const planUsage = require('./plan-usage');
const { formatTokens } = require('./session-info');

/**
 * Clamp a string to Discord's limits (min 2 chars, configurable max). An empty
 * string means "nothing to show" and becomes undefined so the field is omitted.
 */
function clampStr(value, max) {
  if (value == null) return undefined;
  let s = String(value);
  if (!s.trim()) return undefined;
  if (s.length < 2) s = (s + '  ').slice(0, 2); // Discord rejects <2 chars
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}

/** The project name to show: an explicit label wins over detection. */
function resolveProject(state, cfg) {
  const project = cfg.project || {};
  if (project.show === false) return null;
  return project.label || state.project || null;
}

/**
 * Builds the lazy placeholder resolver. Each key is a thunk so nothing is
 * computed (or read from disk) unless a template actually asks for it.
 */
function makeResolver(state, cfg, extra) {
  const usage = cfg.usage || {};
  const model = cfg.model || {};
  const values = {
    model: () => state.model || (model.show ? model.label : '') || '',
    plan: () => (usage.show === false ? '' : usage.planLabel || ''),
    project: () => resolveProject(state, cfg) || '',
    branch: () => ((cfg.project || {}).show === false ? '' : state.branch || ''),
    messages: () => (state.messages > 0 ? state.messages : ''),
    title: () => ((cfg.project || {}).show === false ? '' : state.title || ''),
    tokens: () => formatTokens(state.tokens),
    sessions: () => (state.sessions > 0 ? state.sessions : ''),
    status: () => extra.status || '',
    // Coarse durations on purpose: a seconds-resolution value would change the
    // activity on every poll and burn through Discord's rate limit.
    session: () => (state.sessionStart ? stats.formatDurationCoarse((Date.now() - state.sessionStart) / 1000) : ''),
    idle: () => (state.idleSeconds != null ? stats.formatDurationCoarse(state.idleSeconds) : ''),
    today: () => stats.formatDurationCoarse(stats.getTodaySeconds()),
    month: () => stats.formatDurationCoarse(stats.getMonthSeconds()),
    total: () => stats.formatDurationCoarse(stats.getTotalSeconds()),
    streak: () => stats.getStreakDays() || '',
    usage5h: () => planUsage.formatPct(currentPlanUsage(state, cfg).fiveHourPct),
    usage7d: () => planUsage.formatPct(currentPlanUsage(state, cfg).sevenDayPct),
    time: () => new Date().toTimeString().slice(0, 5),
  };
  return (name) => (values[name] ? values[name]() : '');
}

/**
 * The plan-usage sample to render: the one the daemon put in `state` (so a
 * build is reproducible and tests stay hermetic), else the live one — unless
 * the feature is switched off, in which case nothing is ever read.
 */
function currentPlanUsage(state, cfg) {
  const usage = cfg.usage || {};
  if (usage.show === false || usage.showLimits === false) return {};
  if (state.planUsage !== undefined) return state.planUsage || {};
  return planUsage.current() || {};
}

/**
 * @param {object} state  { running, active, sessionStart, rotationIndex, model,
 *                          project, branch, title, messages, tokens, sessions,
 *                          idleSeconds, planUsage }
 * @param {object} cfg    full config object
 * @returns {object|null} a Discord activity payload, or null to clear
 */
function build(state, cfg) {
  if (!state.running) return null;

  const p = cfg.presence || {};
  const active = state.active !== false; // null/undefined → treat as active

  // {status} must be resolvable from other fields without recursing into
  // itself, so it is rendered first with an empty {status}.
  const bare = makeResolver(state, cfg, { status: '' });
  const status = template.render(active ? p.stateActive : p.stateIdle, bare) || '';
  const resolve = makeResolver(state, cfg, { status });
  const render = (text) => template.render(text, resolve);

  // Top line: an idle-specific line if one is set, else `details`, else the
  // rotating list when it is non-empty.
  let details = (!active && p.detailsIdle) || p.details;
  const msgs = Array.isArray(p.rotateMessages) ? p.rotateMessages.filter(Boolean) : [];
  if (msgs.length > 0 && (active || !p.detailsIdle)) {
    const i = ((state.rotationIndex % msgs.length) + msgs.length) % msgs.length;
    details = msgs[i];
  }

  // Second line: the model, then either the live status or — when usage.showOnCard
  // is enabled — your plan label, so the plan is visible without hovering the icon.
  const usage = cfg.usage || {};
  let statusText = status;
  if (usage.show && usage.showOnCard && usage.planLabel) {
    statusText = usage.planLabel;
  }
  const model = cfg.model || {};
  if (model.show) {
    const modelName = state.model || model.label;
    // Skip the prefix when the line already names the model itself (e.g. a
    // template of "{model} · idle"), which would otherwise read twice.
    if (modelName && !String(statusText).includes(modelName)) {
      statusText = statusText ? `${modelName} · ${statusText}` : modelName;
    }
  }
  const project = resolveProject(state, cfg);
  if (project && !String(statusText).includes(project) && !String(details).includes(project)) {
    statusText = statusText ? `${statusText} · ${project}` : project;
  }

  // Logo tooltip: plan name + locally-measured usage time + the real plan
  // meters when the desktop app has cached them (never a $ figure).
  let largeText = render(p.largeText) || 'Claude';
  if (usage.show) {
    const parts = [];
    if (usage.planLabel) parts.push(usage.planLabel);
    if (usage.showToday) parts.push(`${stats.formatDurationCoarse(stats.getTodaySeconds())} today`);
    if (usage.showMonth) parts.push(`${stats.formatDurationCoarse(stats.getMonthSeconds())} this month`);
    if (usage.showLimits !== false) {
      const pu = currentPlanUsage(state, cfg);
      if (pu.fiveHourPct != null) parts.push(`5h ${pu.fiveHourPct}%`);
      if (pu.sevenDayPct != null) parts.push(`week ${pu.sevenDayPct}%`);
    }
    if (parts.length) largeText = parts.join(' · ');
  }

  const activity = {
    details: clampStr(render(details), 128),
    state: clampStr(statusText, 128),
    assets: {
      large_image: p.largeImage || undefined,
      large_text: clampStr(largeText, 128),
      small_image: (active ? p.smallImageActive : p.smallImageIdle) || undefined,
      small_text: clampStr(render(active ? p.smallTextActive : p.smallTextIdle), 128),
    },
  };

  if (typeof p.activeType === 'number') activity.type = p.activeType;

  if (cfg.showTimer && state.sessionStart) {
    activity.timestamps = { start: Math.floor(state.sessionStart / 1000) };
  }

  // Discord's "party" counter, repurposed to show conversation turns.
  if (p.showMessageCount && state.messages > 0) {
    const size = Math.floor(state.messages);
    activity.party = { id: 'claude-session', size: [size, Math.max(size, 100)] };
  }

  const buttons = (Array.isArray(p.buttons) ? p.buttons : [])
    .filter((b) => b && b.label && /^https?:\/\//i.test(b.url))
    .slice(0, 2)
    .map((b) => ({ label: clampStr(b.label, 31), url: b.url }));
  if (buttons.length) activity.buttons = buttons;

  return activity;
}

/**
 * A stable, timestamp-independent fingerprint of an activity. The daemon only
 * pushes an update to Discord when this changes, keeping us well under the
 * rate limit (the elapsed timer keeps ticking on Discord's side regardless).
 */
function signature(activity) {
  if (!activity) return 'null';
  const copy = JSON.parse(JSON.stringify(activity));
  delete copy.timestamps;
  return JSON.stringify(copy);
}

module.exports = { build, signature, clampStr };
