#!/usr/bin/env node
'use strict';

/**
 * `claude-presence` — command-line entry point.
 *
 *   start [-f|--foreground] [--force]   start the background helper
 *   stop                                stop the running helper
 *   restart                             stop then start
 *   status                              show whether it's running + summary
 *   doctor                              full diagnostics with fixes
 *   install                             enable run-at-login (and start now)
 *   uninstall                           disable run-at-login
 *   config [--path]                     show config location / values
 *   help | --help | -h                  this help
 *   version | --version | -v            print the version
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const config = require('../src/config');
const single = require('../src/single-instance');
const autostart = require('../src/autostart');
const detector = require('../src/claude-detector');
const modelDetector = require('../src/model-detector');
const activityDetector = require('../src/activity-detector');
const sessionInfo = require('../src/session-info');
const claudeSessions = require('../src/claude-sessions');
const planUsage = require('../src/plan-usage');
const claudeData = require('../src/claude-data');
const discordApp = require('../src/discord-app');
const stats = require('../src/stats');
const paths = require('../src/paths');
const pause = require('../src/pause');
const themes = require('../src/themes');
const presence = require('../src/presence-builder');
const { isDiscordAvailable } = require('../src/discord-rpc');

const DAEMON = path.join(__dirname, '..', 'src', 'daemon.js');
const NODE = process.execPath;
const PKG = require('../package.json');

const OK = '✓';
const NO = '✗';
const DOT = '•';

function print(...a) { console.log(...a); }
// `claude-presence status | head` closes our stdout early; that's not an error.
process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); });
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Reads `--flag value` (or `--flag=value`) from argv as a string. */
function strFlag(args, name, def) {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return def;
  const raw = args[i].includes('=') ? args[i].slice(args[i].indexOf('=') + 1) : args[i + 1];
  return raw === undefined ? def : raw;
}

/** Reads `--flag value` (or `--flag=value`) from argv as a number. */
function numFlag(args, name, def) {
  const n = parseInt(strFlag(args, name, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * The daemon's last snapshot (state.json), or null when it isn't running. A
 * snapshot left behind by a hard kill (taskkill, a crash) names a PID that is
 * no longer the running helper, so it is ignored rather than shown as live.
 */
function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(paths.statePath(), 'utf8'));
    const pid = single.getRunningPid();
    if (!state || !pid || state.pid !== pid) return null;
    return state;
  } catch (_) {
    return null;
  }
}

async function waitUntil(fn, timeoutMs, intervalMs = 150) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(intervalMs);
  }
  return false;
}

// ── start ─────────────────────────────────────────────────────────────────────
async function cmdStart(args) {
  const foreground = args.includes('-f') || args.includes('--foreground');
  const force = args.includes('--force');

  if (foreground) {
    // Run the daemon in THIS process (blocks). Used by `npm start` / debugging.
    return require('../src/daemon').runDaemon();
  }

  const running = single.getRunningPid();
  if (running) {
    if (!force) {
      print(`${OK} Already running (PID ${running}). Nothing to do.`);
      print(`   Use "claude-presence restart" to restart, or "--force" to replace it.`);
      return;
    }
    print(`${DOT} Stopping existing instance (PID ${running})…`);
    await cmdStop([]);
  }

  // Launch the daemon detached and windowless, then return to the shell.
  const child = spawn(NODE, [DAEMON], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const ok = await waitUntil(() => single.getRunningPid() != null, 4000);
  const pid = single.getRunningPid();
  if (ok && pid) {
    print(`${OK} Started in the background (PID ${pid}).`);
  } else {
    print(`${NO} The helper did not report as running. Check the log:`);
    print(`   ${paths.logPath()}`);
    process.exitCode = 1;
  }

  warnIfUnconfigured();
}

// ── stop ──────────────────────────────────────────────────────────────────────
async function cmdStop() {
  const pid = single.getRunningPid();
  if (!pid) {
    print(`${DOT} Not running.`);
    return;
  }
  // On POSIX this lets the daemon run its SIGTERM handler (graceful clear).
  // On Windows there are no real signals — Node terminates the process
  // immediately, so the daemon's shutdown() never runs; that's fine because
  // Discord clears the presence on its own as soon as the IPC socket drops.
  try { process.kill(pid, 'SIGTERM'); } catch (_) {}

  const gone = await waitUntil(() => single.getRunningPid() == null, 3000);
  if (!gone) {
    // Forceful fallback.
    try { process.kill(pid, 'SIGKILL'); } catch (_) {}
    await waitUntil(() => single.getRunningPid() == null, 1500);
  }
  // Clean up a lock the killed process may have left behind.
  try {
    const lock = single.readLock();
    if (lock && lock.pid === pid) fs.unlinkSync(paths.lockPath());
  } catch (_) {}

  print(`${OK} Stopped (was PID ${pid}). Discord status cleared.`);
}

// ── restart ────────────────────────────────────────────────────────────────────
async function cmdRestart() {
  await cmdStop();
  await wait(400);
  await cmdStart([]);
}

// ── status ──────────────────────────────────────────────────────────────────────
/** Human-readable remaining pause time, e.g. "paused for another 25m". */
function pauseSummary() {
  const rec = pause.read();
  if (!rec) return null;
  const left = pause.remainingMs(rec);
  if (left === null) return 'paused (claude-presence resume)';
  if (left <= 0) return 'pause expired — resuming on the next poll';
  return `paused for another ${stats.formatDuration(left / 1000)}`;
}

async function cmdStatus(args) {
  const cfg = safeLoadConfig();
  const pid = single.getRunningPid();

  if ((args || []).includes('--json')) {
    const state = readState();
    print(JSON.stringify({
      running: !!pid,
      pid: pid || null,
      paused: pause.isPaused(),
      pauseUntil: (pause.read() || {}).until || null,
      autostart: autostart.isInstalled(),
      clientIdSet: !!(cfg && config.resolveClientId(cfg)),
      todaySeconds: stats.getTodaySeconds(),
      monthSeconds: stats.getMonthSeconds(),
      streakDays: stats.getStreakDays(),
      planUsage: planUsage.current(),
      sessions: claudeSessions.liveSessions().map((x) => ({
        pid: x.pid, status: x.status, title: x.title, cwd: x.cwd, startedAt: x.startedAt, entrypoint: x.entrypoint,
      })),
      configPath: paths.configPath(),
      daemon: state,
    }, null, 2));
    return;
  }

  print('Claude Discord Presence — status');
  print('────────────────────────────────');
  print(`  Helper running : ${pid ? `${OK} yes (PID ${pid})` : `${NO} no`}`);
  const paused = pauseSummary();
  if (paused) print(`  Presence       : ${DOT} ${paused}`);
  print(`  Autostart      : ${autostart.isInstalled() ? `${OK} enabled` : `${NO} disabled`}`);
  if (cfg) {
    const configured = !!config.resolveClientId(cfg);
    print(`  Discord App ID : ${configured ? `${OK} set` : `${NO} not set (run: claude-presence setup)`}`);
    if (cfg.model && cfg.model.show) {
      const m = (cfg.model.detect && modelDetector.detect()) || cfg.model.label;
      print(`  Model shown    : ${m || '(none)'}`);
    }
    if (cfg.usage && cfg.usage.show && cfg.usage.planLabel) {
      print(`  Plan           : ${cfg.usage.planLabel}`);
    }
    if (cfg.theme) print(`  Theme          : ${cfg.theme}`);
    const pids = await detector.getClaudePids(cfg.claudeProcessNames);
    print(`  Claude open    : ${pids.size ? `${OK} yes` : `${NO} no`}`);
    const live = claudeSessions.liveSessions(pids);
    if (live.length) {
      const busy = live.filter((x) => x.status === 'busy').length;
      print(`  Code sessions  : ${live.length} open${busy ? ` · ${busy} busy` : ' · all idle'}`);
    }
    const session = sessionInfo.detect(pids);
    if (session && session.project) {
      const branch = session.branch ? ` (${session.branch})` : '';
      const turns = session.messages ? ` · ${session.messages} prompt${session.messages === 1 ? '' : 's'}` : '';
      const tokens = session.tokens ? ` · ${sessionInfo.formatTokens(session.tokens)} tokens` : '';
      print(`  Project        : ${session.project}${branch}${turns}${tokens}`);
      if (session.title) print(`  Session title  : ${session.title}`);
    }
    if (!cfg.activity || cfg.activity.detect !== false) {
      const idle = activityDetector.secondsSinceActivity(pids);
      print(`  Last activity  : ${idle === null ? 'unknown' : idle < 5 ? 'right now' : `${stats.formatDuration(idle)} ago`}`);
    }
    const plan = planUsage.current();
    if (plan && cfg.usage && cfg.usage.show !== false && cfg.usage.showLimits !== false) {
      const bits = [];
      if (plan.fiveHourPct != null) bits.push(`5h window ${plan.fiveHourPct}%`);
      if (plan.sevenDayPct != null) bits.push(`7-day ${plan.sevenDayPct}%`);
      print(`  Plan usage     : ${bits.join(' · ')}  (${stats.formatDuration(plan.ageMs / 1000)} ago, from the desktop app)`);
    }
  }
  const daemonState = readState();
  if (daemonState && daemonState.details) {
    print(`  Showing        : ${daemonState.details} / ${daemonState.state || ''}`);
    if (daemonState.largeText) print(`  Tooltip        : ${daemonState.largeText}`);
    if (daemonState.sessionStart) {
      const how = { code: 'Claude Code session start', process: 'app launch', detected: 'first detection' }[daemonState.sessionStartSource] || '';
      print(`  Timer since    : ${new Date(daemonState.sessionStart).toLocaleTimeString()}${how ? ` (${how})` : ''}`);
    }
    print(`  Discord link   : ${daemonState.discordConnected ? `${OK} connected` : `${NO} not connected`}`);
  }
  print(`  Used today     : ${stats.formatDuration(stats.getTodaySeconds())}`);
  print(`  Used this month: ${stats.formatDuration(stats.getMonthSeconds())}`);
  const streak = stats.getStreakDays();
  if (streak > 0) print(`  Streak         : ${streak} day${streak === 1 ? '' : 's'}`);
  print(`  Config file    : ${paths.configPath()}`);
  if (!pid) print(`\n  Start it with: claude-presence start  (or "setup" for first-time setup)`);
  else print(`\n  Full history: claude-presence stats · live log: claude-presence logs -f`);
}

// ── stats ───────────────────────────────────────────────────────────────────────
const BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];

/** A unicode bar `width` cells wide representing `value` out of `max`. */
function bar(value, max, width) {
  if (max <= 0) return '';
  const eighths = Math.round((value / max) * width * 8);
  const full = Math.floor(eighths / 8);
  const rest = eighths % 8;
  return '█'.repeat(full) + (rest ? BLOCKS[rest] : '');
}

async function cmdStats(args) {
  const out = strFlag(args, 'out', null);

  if (args.includes('--json') || args.includes('--csv')) {
    const csv = args.includes('--csv');
    const text = csv ? stats.toCsv() : JSON.stringify(stats.toJson(), null, 2) + '\n';
    if (out) {
      fs.writeFileSync(out, text);
      print(`${OK} Wrote ${csv ? 'CSV' : 'JSON'} to ${path.resolve(out)}`);
    } else {
      process.stdout.write(text);
    }
    return;
  }

  const days = numFlag(args, 'days', 14);
  const history = stats.getLastDays(days);
  const max = history.reduce((m, d) => Math.max(m, d.seconds), 0);
  const week = stats.getLastDays(7).reduce((sum, d) => sum + d.seconds, 0);

  print('Claude usage — measured locally, never uploaded');
  print('═══════════════════════════════════════════════\n');
  print(`  Today        : ${stats.formatDuration(stats.getTodaySeconds())}`);
  print(`  Last 7 days  : ${stats.formatDuration(week)}`);
  print(`  This month   : ${stats.formatDuration(stats.getMonthSeconds())}`);
  print(`  On record    : ${stats.formatDuration(stats.getTotalSeconds())}`);
  print(`  Daily average: ${stats.formatDuration(stats.getAverageSeconds(14))}  (last 14 days)`);
  const streak = stats.getStreakDays();
  print(`  Streak       : ${streak} day${streak === 1 ? '' : 's'} in a row\n`);

  if (max === 0) {
    print(`  No usage recorded yet — start the helper and open Claude.`);
  } else {
    print(`  Last ${history.length} days`);
    const todayKey = stats.today();
    for (const day of history) {
      const label = day.date === todayKey ? `${day.date} *` : `${day.date}  `;
      const amount = day.seconds ? stats.formatDuration(day.seconds) : '–';
      print(`  ${label} ${bar(day.seconds, max, 32).padEnd(32)} ${amount}`);
    }
    const busiest = stats.getBusiestDay();
    print(`\n  * today (still counting)` +
      (busiest ? ` · busiest day: ${busiest.date} (${stats.formatDuration(busiest.seconds)})` : ''));
  }
  print(`\n  Data file: ${paths.statsPath()}`);
  print(`  Export: claude-presence stats --csv --out usage.csv  ·  or --json`);
}

// ── logs ────────────────────────────────────────────────────────────────────────
async function cmdLogs(args) {
  const file = paths.logPath();
  const lines = numFlag(args, 'lines', 40);
  const follow = args.includes('-f') || args.includes('--follow');

  if (!fs.existsSync(file)) {
    print(`${DOT} No log file yet: ${file}`);
    print(`   It appears once the helper has run at least once.`);
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  const all = text.split(/\r?\n/).filter(Boolean);
  print(all.slice(-lines).join('\n'));
  if (!follow) return;

  // Follow mode: poll the file size and print whatever gets appended.
  print(`\n${DOT} Following ${file} — press Ctrl+C to stop.\n`);
  let offset = fs.statSync(file).size;
  fs.watchFile(file, { interval: 700 }, (curr) => {
    if (curr.size < offset) offset = 0; // the log was rotated
    if (curr.size === offset) return;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(curr.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = curr.size;
      process.stdout.write(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  });
  await new Promise(() => {}); // run until interrupted
}

// ── pause / resume ──────────────────────────────────────────────────────────────
async function cmdPause(args) {
  const forRaw = strFlag(args, 'for', null);
  let durationMs = null;
  if (forRaw !== null) {
    durationMs = pause.parseDuration(forRaw);
    if (!durationMs) {
      print(`${NO} "--for ${forRaw}" isn't a duration. Try 30m, 2h, 1d (a bare number means minutes).`);
      process.exitCode = 1;
      return;
    }
  }
  const record = pause.set(durationMs);
  print(`${OK} Paused. Your Discord status is hidden; the helper keeps running.`);
  if (record.until) {
    print(`   Auto-resumes at ${new Date(record.until).toLocaleTimeString()} (in ${stats.formatDuration(durationMs / 1000)}).`);
  }
  if (!single.getRunningPid()) print(`${DOT} (The helper isn't running right now — this applies when it starts.)`);
  print(`   Resume now with: claude-presence resume`);
}
async function cmdResume() {
  if (!pause.clear()) {
    print(`${DOT} Not paused — nothing to do.`);
    return;
  }
  print(`${OK} Resumed. The presence comes back within one poll interval.`);
}

// ── preview ─────────────────────────────────────────────────────────────
/** Renders the presence exactly as the daemon would, without touching Discord. */
function buildPreview(cfg, opts) {
  const session = sessionInfo.detect();
  const model = cfg.model && cfg.model.show
    ? ((cfg.model.detect && modelDetector.detect()) || cfg.model.label || null)
    : null;
  return presence.build({
    running: true,
    active: opts.active,
    sessionStart: opts.sessionStart || Date.now() - 42 * 60 * 1000,
    rotationIndex: opts.rotationIndex || 0,
    model,
    project: session && session.project,
    branch: session && session.branch,
    title: session && session.title,
    messages: session && session.messages,
    tokens: session && session.tokens,
    sessions: claudeSessions.liveSessions().length,
    idleSeconds: activityDetector.secondsSinceActivity(),
  }, cfg);
}

/** Prints one activity as a Discord-like card. */
function printCard(activity, title) {
  if (!activity) {
    print(`  (nothing — the presence would be hidden)`);
    return;
  }
  const assets = activity.assets || {};
  print(`  ${title}`);
  print(`    ┌─────────────────────────────────────────────────`);
  print(`    │ ${activity.details || ''}`);
  print(`    │ ${activity.state || ''}`);
  if (activity.party) print(`    │ party: ${activity.party.size[0]} of ${activity.party.size[1]}`);
  if (activity.timestamps) print(`    │ timer: running`);
  print(`    │ hover: ${assets.large_text || ''}${assets.small_text ? ` · ${assets.small_text}` : ''}`);
  if (activity.buttons) print(`    │ buttons: ${activity.buttons.map((b) => b.label).join(' | ')}`);
  print(`    └─────────────────────────────────────────────────`);
}

async function cmdPreview(args) {
  const cfg = safeLoadConfig();
  if (!cfg) return;

  if (args.includes('--json')) {
    print(JSON.stringify({
      active: buildPreview(cfg, { active: true }),
      idle: buildPreview(cfg, { active: false }),
    }, null, 2));
    return;
  }

  print('Presence preview — rendered from your config, nothing is sent to Discord');
  print('═════════════════════════════════════════════════════════════════════════\n');
  printCard(buildPreview(cfg, { active: true }), 'While you are active');
  print('');
  const idleHidden = cfg.activity && cfg.activity.hideWhenIdle;
  if (idleHidden) print('  While idle: hidden (activity.hideWhenIdle is on)');
  else printCard(buildPreview(cfg, { active: false }), 'While idle');

  const rotations = (cfg.presence && cfg.presence.rotateMessages) || [];
  if (rotations.length > 1) {
    print(`\n  Top line rotates every ${(cfg.presence.rotateIntervalSeconds || 30)}s through:`);
    rotations.forEach((_, i) => {
      const a = buildPreview(cfg, { active: true, rotationIndex: i });
      print(`    ${i + 1}. ${a.details}`);
    });
  }
  const problems = config.validate(cfg);
  if (problems.length) {
    print(`\n  ${NO} Config warnings:`);
    problems.forEach((p) => print(`    • ${p}`));
  }
}

// ── watch ───────────────────────────────────────────────────────────────
async function cmdWatch(args) {
  const everyMs = Math.max(1, numFlag(args, 'interval', 2)) * 1000;
  print(`Watching the helper — press Ctrl+C to stop.\n`);
  for (;;) {
    const state = readState();
    const pid = single.getRunningPid();
    const now = new Date().toLocaleTimeString();
    let line;
    if (!pid) {
      line = `${NO} helper stopped`;
    } else if (!state) {
      line = `${DOT} starting up…`;
    } else if (state.paused) {
      line = `${DOT} paused`;
    } else if (!state.running) {
      line = `${DOT} Claude not detected`;
    } else {
      const flags = [
        state.active ? 'active' : 'idle',
        { code: 'claude code', desktop: 'desktop', 'desktop+code': 'desktop + code' }[state.source] || state.source,
        state.sessionStatus === 'busy' ? 'generating' : null,
        state.discordConnected ? 'discord ok' : 'discord down',
      ].filter(Boolean);
      line = `${OK} ${state.details || ''} / ${state.state || ''}  [${flags.join(' · ')}]`;
    }
    // \r + clear-to-end keeps this to a single, continuously-updated line.
    process.stdout.write(`\r\x1b[2K[${now}] ${line}`);
    await wait(everyMs);
  }
}

// ── theme ───────────────────────────────────────────────────────────────
async function cmdTheme(args) {
  const name = args.find((a) => !a.startsWith('-'));
  const cfg = safeLoadConfig();

  if (!name || name === 'list') {
    print('Available themes (set one with: claude-presence theme <name>)\n');
    for (const theme of themes.names()) {
      const current = cfg && cfg.theme === theme ? ` ${OK} current` : '';
      print(`  ${theme}${current}`);
    }
    print(`\n  A theme only fills in what you haven't set yourself — your own`);
    print(`  config.json values always win.`);
    return;
  }
  if (!themes.get(name)) {
    print(`${NO} Unknown theme "${name}". Available: ${themes.names().join(', ')}.`);
    process.exitCode = 1;
    return;
  }
  config.setKey('theme', name);
  print(`${OK} Theme set to "${name}".`);
  print(`   Preview it with: claude-presence preview`);
  if (single.getRunningPid()) print(`   The running helper picks it up within one poll interval.`);
}

// ── doctor ──────────────────────────────────────────────────────────────────────
async function cmdDoctor() {
  print('Claude Discord Presence — doctor');
  print('════════════════════════════════\n');

  const problems = [];

  // Node
  const major = parseInt(process.versions.node.split('.')[0], 10);
  print(`${major >= 16 ? OK : NO} Node.js ${process.versions.node}` + (major >= 16 ? '' : '  (need >= 16)'));
  if (major < 16) problems.push('Upgrade Node.js to v16 or newer.');

  print(`${DOT} Platform: ${process.platform} (${process.arch})`);
  print(`${DOT} Data dir: ${paths.dataDir()}`);
  print(`${DOT} Log file: ${paths.logPath()}`);

  // Config
  let cfg = null;
  try {
    cfg = config.load();
    print(`${OK} Config loaded: ${paths.configPath()}`);
  } catch (e) {
    print(`${NO} Config error: ${e.message}`);
    problems.push('Fix or delete config.json so it can be regenerated.');
  }

  if (cfg) {
    const effectiveId = config.resolveClientId(cfg);
    if (!effectiveId) {
      print(`${NO} Discord Application ID is not set (presence is disabled).`);
      problems.push('Run "claude-presence setup", or set "clientId" in config.json (README → Discord setup).');
    } else if (config.isClientIdPlaceholder(cfg.clientId)) {
      print(`${OK} Discord Application ID: using the built-in default.`);
    } else {
      print(`${OK} Discord Application ID is set.`);
    }
    print(`${DOT} Poll interval: ${cfg.pollIntervalSeconds}s · onClaudeClose: ${cfg.onClaudeClose} · activeWindow: ${cfg.detectActiveWindow}`);
    print(`${DOT} Watching processes: ${(cfg.claudeProcessNames || []).join(', ')}`);
    print(`${DOT} Theme: ${cfg.theme || 'default'}`);

    // Every config problem is worth surfacing here — the daemon only logs them.
    const configProblems = config.validate(cfg);
    if (configProblems.length === 0) {
      print(`${OK} Config values look sane.`);
    } else {
      for (const problem of configProblems) print(`${NO} ${problem}`);
      problems.push(...configProblems.map((p) => `Config: ${p}`));
    }

    if (pause.isPaused()) {
      const left = pause.remainingMs();
      print(`${NO} Presence is PAUSED` +
        (left ? ` for another ${stats.formatDuration(left / 1000)}.` : ' — nothing will show until "claude-presence resume".'));
      if (!left) problems.push('Run "claude-presence resume" to un-pause the presence.');
    }
    problems.push(...(await checkPresenceImages(cfg)));
  }

  // Running / autostart
  print(`${single.getRunningPid() ? OK : DOT} Helper running: ${single.getRunningPid() ? `yes (PID ${single.getRunningPid()})` : 'no'}`);
  print(`${autostart.isInstalled() ? OK : DOT} Autostart: ${autostart.isInstalled() ? `enabled (${autostart.location()})` : 'disabled'}`);

  // Discord reachable?
  const discordUp = await isDiscordAvailable(2000);
  print(`${discordUp ? OK : NO} Discord desktop ${discordUp ? 'is reachable' : 'not detected'}.`);
  if (!discordUp) problems.push('Open the Discord DESKTOP app (the browser version cannot show Rich Presence).');

  // Claude running?
  const pids = cfg ? await detector.getClaudePids(cfg.claudeProcessNames) : new Set();
  const claudeUp = pids.size > 0;
  print(`${claudeUp ? OK : DOT} Claude ${claudeUp ? `is running (${pids.size} process${pids.size === 1 ? '' : 'es'})` : 'not detected right now'}.`);
  if (cfg && (!cfg.activity || cfg.activity.detectClaudeCode !== false)) {
    claudeSessions.resetCache();
    const live = claudeSessions.liveSessions(pids);
    if (live.length) {
      print(`${OK} Claude Code sessions (from ${claudeSessions.registryDir()}):`);
      for (const x of live) {
        const started = x.startedAt ? `since ${new Date(x.startedAt).toLocaleTimeString()}` : '';
        print(`   ${DOT} PID ${x.pid} · ${x.status}${x.entrypoint ? ` · ${x.entrypoint}` : ''} · ${sessionInfo.projectNameFromCwd(x.cwd) || '?'} ${started}`);
      }
    } else {
      const window = (cfg.activity && cfg.activity.claudeCodeWindowSeconds) || 120;
      const fresh = activityDetector.isActive(window, pids);
      print(`${DOT} No live Claude Code session registered${fresh === true
        ? ' — but recent session writes count as in use'
        : ` (fallback: no writes in the last ${stats.formatDuration(window)})`}.`);
    }
  }
  if (!claudeUp) {
    const all = await detector.getRunningProcessNames();
    const claudeLike = [...all].filter((n) => n.includes('claude'));
    if (claudeLike.length) {
      print(`   Processes containing "claude": ${claudeLike.join(', ')}`);
      print(`   → if one of these is the app, add it to "claudeProcessNames" in config.json.`);
    } else {
      print(`   (Open Claude, then run "claude-presence doctor" again to confirm detection.)`);
    }
  }

  // Foreground (only if enabled)
  if (cfg && cfg.detectActiveWindow) {
    const fg = await detector.getForegroundProcessName();
    print(`${DOT} Foreground window process: ${fg || 'unknown'}`);
  }

  // Claude's own data (used for model + activity detection)
  const roots = claudeData.roots();
  if (roots.length) {
    print(`${OK} Claude data found: ${roots.join(', ')}`);
  } else {
    print(`${DOT} No Claude data directory found — model/activity detection will stay off.`);
  }

  // Current session (project / branch / title / prompts / tokens)
  sessionInfo.resetCache();
  const session = sessionInfo.detect(pids);
  if (session) {
    const bits = [
      session.project ? `project ${session.project}` : null,
      session.branch ? `branch ${session.branch}` : null,
      session.title ? `title "${session.title}"` : null,
      session.messages ? `${session.messages} prompt${session.messages === 1 ? '' : 's'}` : null,
      session.tokens ? `${sessionInfo.formatTokens(session.tokens)} tokens` : null,
      session.live ? 'live' : 'most recent transcript',
    ].filter(Boolean);
    print(`${OK} Current session: ${bits.length ? bits.join(' · ') : 'found, but no details readable'}`);
  } else {
    print(`${DOT} No Claude Code session transcript found — {project}/{branch}/{title}/{messages}/{tokens} stay blank.`);
  }

  // Real plan usage (cached by the desktop app)
  if (cfg && cfg.usage && cfg.usage.show !== false && cfg.usage.showLimits !== false) {
    const plan = planUsage.latestAnyAge();
    if (!plan) {
      print(`${DOT} Plan usage: no sample found (the desktop app writes plan-usage-history.json while it runs) — {usage5h}/{usage7d} stay blank.`);
    } else {
      const fresh = plan.ageMs <= planUsage.MAX_AGE_MS;
      const bits = [];
      if (plan.fiveHourPct != null) bits.push(`5h window ${plan.fiveHourPct}%`);
      if (plan.sevenDayPct != null) bits.push(`7-day ${plan.sevenDayPct}%`);
      print(`${fresh ? OK : DOT} Plan usage: ${bits.join(' · ')} — sampled ${stats.formatDuration(plan.ageMs / 1000)} ago${fresh ? '' : ' (stale, so not shown until the desktop app refreshes it)'}.`);
    }
  }

  // Model display
  if (cfg && cfg.model && cfg.model.show) {
    modelDetector.resetCache();
    const detected = cfg.model.detect ? modelDetector.detect(pids) : null;
    const catalog = modelDetector.loadCatalog();
    const named = catalog && Object.keys(catalog).length ? ', named per the app catalogue' : '';
    const suffix = cfg.model.detect
      ? (detected ? ` (auto-detected${named})` : ' (label — auto-detect found nothing)')
      : ' (label)';
    print(`${DOT} Model shown: ${detected || cfg.model.label}${suffix}`);
  }

  // Activity detection
  if (cfg && (!cfg.activity || cfg.activity.detect !== false)) {
    activityDetector.resetCache();
    const idle = activityDetector.secondsSinceActivity(pids);
    const window = (cfg.activity && cfg.activity.idleAfterSeconds) || 300;
    if (idle === null) {
      print(`${DOT} Activity detection: no signal — the presence will always read as active.`);
    } else {
      const busy = claudeSessions.anyBusy(pids);
      print(`${DOT} Activity detection: ${busy ? 'a Claude Code session is generating right now' : `last Claude activity ${stats.formatDuration(idle)} ago`} ` +
        `→ ${idle <= window ? 'active' : 'idle'} (threshold ${stats.formatDuration(window)}).`);
    }
  }

  print('');
  if (problems.length === 0) {
    print(`${OK} Everything looks good. Run "claude-presence start" (or "install" for autostart).`);
  } else {
    print('Action items:');
    problems.forEach((p, i) => print(`  ${i + 1}. ${p}`));
  }
}

/**
 * Verifies that every configured image is an art-asset key that really exists
 * in the Discord application being used. A missing key is *the* reason Discord
 * falls back to its grey placeholder icon, and a raw https:// URL never renders
 * at all — neither shows up in the log, so we check it here.
 * @returns {Promise<string[]>} action items for the doctor summary
 */
async function checkPresenceImages(cfg) {
  const problems = [];
  const clientId = config.resolveClientId(cfg);
  if (!clientId) return problems;

  const p = cfg.presence || {};
  const wanted = [
    ['largeImage', p.largeImage],
    ['smallImageActive', p.smallImageActive],
    ['smallImageIdle', p.smallImageIdle],
  ].filter(([, value]) => value);

  for (const [field, value] of wanted) {
    if (discordApp.looksLikeUrl(value)) {
      print(`${NO} presence.${field} is a URL — Discord only renders art assets it hosts.`);
      problems.push(`Upload the image in the Developer Portal and set "presence.${field}" to its asset key.`);
    }
  }

  const keys = await discordApp.fetchAssetKeys(clientId);
  if (keys === null) {
    print(`${DOT} Couldn't list the app's art assets (offline?) — skipping the image check.`);
    return problems;
  }
  const name = await discordApp.fetchAppName(clientId);
  print(`${DOT} Discord app: ${name || clientId} · art assets: ${keys.length ? keys.join(', ') : '(none uploaded)'}`);

  for (const [field, value] of wanted) {
    if (discordApp.looksLikeUrl(value)) continue;
    if (keys.includes(value)) {
      print(`${OK} presence.${field} → "${value}" exists in the app.`);
    } else {
      print(`${NO} presence.${field} → "${value}" is NOT an art asset of this app.`);
      const hint = keys.length ? `Available keys: ${keys.join(', ')}.` : 'The app has no art assets yet.';
      problems.push(`Fix "presence.${field}" in config.json (or upload that image). ${hint}`);
    }
  }
  return problems;
}

// ── install / uninstall ──────────────────────────────────────────────────────────
async function cmdInstall() {
  const loc = await autostart.install();
  print(`${OK} Autostart enabled. The helper will launch automatically at login.`);
  print(`   ${loc}`);
  if (!single.getRunningPid()) {
    await cmdStart([]);
  } else {
    print(`${DOT} Helper already running (PID ${single.getRunningPid()}).`);
  }
}
async function cmdUninstall() {
  const loc = await autostart.uninstall();
  print(`${OK} Autostart disabled.`);
  print(`   Removed: ${loc}`);
  print(`   (The currently-running helper, if any, keeps running. Use "stop" to end it.)`);
}

// ── setup (interactive wizard) ────────────────────────────────────────────────
function ask(rl, question, def) {
  const suffix = def ? ` [${def}]` : '';
  return new Promise((resolve) =>
    rl.question(`${question}${suffix}: `, (a) => resolve((a || '').trim() || def || ''))
  );
}
async function askYesNo(rl, question, def) {
  const a = await ask(rl, `${question} (y/n)`, def ? 'y' : 'n');
  return /^y/i.test(a);
}

async function cmdSetup() {
  const cfg = config.load();
  cfg.model = cfg.model || {};
  cfg.usage = cfg.usage || {};

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  print('\nClaude Discord Presence — setup');
  print('───────────────────────────────\n');
  try {
    // 1) Discord Application ID
    if (!config.isClientIdPlaceholder(config.DEFAULT_CLIENT_ID)) {
      print('A built-in Discord Application ID is available — press Enter to use it.');
    } else {
      print('You need a Discord Application ID (free, ~2 min):');
      print('  1. Open https://discord.com/developers/applications → New Application');
      print('  2. Name it "Claude", then copy its Application ID (a long number).');
      print('  (The full walkthrough, including the logo, is in the README.)\n');
    }
    const currentId = config.isClientIdPlaceholder(cfg.clientId) ? '' : cfg.clientId;
    const id = await ask(rl, 'Discord Application ID', currentId);
    if (/^\d{15,25}$/.test(id)) cfg.clientId = id;
    else if (id) print(`  ("${id}" isn't a valid ID — leaving the current value unchanged.)`);

    // 2) Model line
    cfg.model.show = await askYesNo(rl, '\nShow which model you use?', cfg.model.show !== false);
    if (cfg.model.show) {
      cfg.model.label = await ask(rl, '  Model label', cfg.model.label || 'Opus 4.8');
      cfg.model.detect = await askYesNo(rl, '  Also try best-effort auto-detection?', cfg.model.detect !== false);
    }

    // 3) Honest active/idle status
    cfg.activity = cfg.activity || {};
    cfg.activity.detect = await askYesNo(
      rl,
      '\nOnly say "actively in a conversation" when you really are?',
      cfg.activity.detect !== false
    );
    if (cfg.activity.detect) {
      const mins = await ask(rl, '  Minutes of silence before it reads as idle', String(
        Math.max(1, Math.round((cfg.activity.idleAfterSeconds || 300) / 60))
      ));
      const parsed = parseInt(mins, 10);
      if (Number.isFinite(parsed) && parsed > 0) cfg.activity.idleAfterSeconds = parsed * 60;
      cfg.activity.hideWhenIdle = await askYesNo(rl, '  Hide the presence entirely while idle?', !!cfg.activity.hideWhenIdle);
    }

    // 4) Plan + usage
    cfg.usage.show = await askYesNo(rl, '\nShow your plan name + time used?', cfg.usage.show !== false);
    if (cfg.usage.show) {
      cfg.usage.planLabel = await ask(rl, '  Plan label (e.g. Claude Pro, Claude Max)', cfg.usage.planLabel || 'Claude');
      cfg.usage.showMonth = await askYesNo(rl, '  Include this-month total?', cfg.usage.showMonth !== false);
    }

    // 5) Project detection (Claude Code) + look
    cfg.project = cfg.project || {};
    cfg.project.show = await askYesNo(
      rl,
      '\nShow the project folder / git branch you are working in?',
      cfg.project.show !== false
    );

    print(`\nLooks available: ${themes.names().join(', ')}`);
    const theme = await ask(rl, '  Theme', cfg.theme || 'default');
    if (themes.get(theme)) cfg.theme = theme;
    else if (theme) print(`  (No theme called "${theme}" — keeping "${cfg.theme || 'default'}".)`);

    // 6) Autostart / start
    const autostartChoice = await askYesNo(rl, '\nLaunch automatically at login?', true);
    const startNow = autostartChoice ? true : await askYesNo(rl, 'Start the helper now?', true);

    config.save(cfg);
    print(`\n${OK} Saved ${paths.configPath()}`);
    rl.close();

    if (autostartChoice) await cmdInstall();
    else if (startNow) await cmdStart([]);
    else print(`\nWhen you're ready:  claude-presence start`);

    if (config.resolveClientId(cfg)) {
      print(`\n${OK} All set — open Claude and check your Discord profile! ("doctor" diagnoses issues.)`);
    } else {
      print(`\n${NO} No valid Application ID yet, so presence stays off until one is set.`);
    }
  } finally {
    try { rl.close(); } catch (_) {}
  }
}

// ── config ──────────────────────────────────────────────────────────────────────
/** Reads a dotted path (`presence.details`) out of the merged config. */
function getPath(obj, dotted) {
  return String(dotted).split('.').filter(Boolean).reduce(
    (node, key) => (node == null ? undefined : node[key]),
    obj
  );
}

async function cmdConfig(args) {
  if (args.includes('--path')) {
    print(paths.configPath());
    return;
  }

  const [sub, key, ...rest] = args;

  if (sub === 'set') {
    if (!key || rest.length === 0) {
      print(`Usage: claude-presence config set <key> <value>`);
      print(`   e.g. claude-presence config set presence.details "Building {project}"`);
      print(`        claude-presence config set activity.hideWhenIdle true`);
      process.exitCode = 1;
      return;
    }
    try {
      const { value } = config.setKey(key, rest.join(' '));
      print(`${OK} ${key} = ${JSON.stringify(value)}`);
    } catch (e) {
      print(`${NO} ${e.message}`);
      process.exitCode = 1;
      return;
    }
    const cfg = safeLoadConfig();
    if (cfg) {
      const problems = config.validate(cfg);
      problems.forEach((p) => print(`${NO} ${p}`));
    }
    if (single.getRunningPid()) print(`   The running helper applies it within one poll interval.`);
    return;
  }

  if (sub === 'get') {
    const cfg = safeLoadConfig();
    if (!cfg) return;
    if (!key) {
      print(`Usage: claude-presence config get <key>`);
      process.exitCode = 1;
      return;
    }
    const value = getPath(cfg, key);
    print(value === undefined ? `${NO} No such key: ${key}` : JSON.stringify(value, null, 2));
    return;
  }

  const cfg = safeLoadConfig();
  print(`Config file: ${paths.configPath()}\n`);
  if (cfg) print(JSON.stringify(cfg, null, 2));
  print(`\nEdit one value:  claude-presence config set presence.details "Building {project}"`);
}

// ── helpers ───────────────────────────────────────────────────────────────────
function safeLoadConfig() {
  try { return config.load(); }
  catch (e) { print(`${NO} ${e.message}`); return null; }
}
function warnIfUnconfigured() {
  const cfg = safeLoadConfig();
  if (cfg && !config.resolveClientId(cfg)) {
    print('');
    print(`${NO} Heads up: no Discord Application ID is set yet, so nothing will show.`);
    print(`   Easiest fix →  claude-presence setup`);
    print(`   Or create an app at https://discord.com/developers/applications and put`);
    print(`   its Application ID in: ${paths.configPath()}`);
  }
}

function help() {
  print(`claude-presence v${PKG.version} — Discord Rich Presence for the Claude Desktop App
Usage: claude-presence <command> [options]

Commands:
  setup                            Interactive first-time setup (recommended)
  start [--foreground] [--force]   Start the background helper
                                     --foreground (-f)  run in this terminal (don't detach)
                                     --force            replace an already-running instance
  stop                             Stop the running helper (clears your Discord status)
  restart                          Restart the helper
  status [--json]                  Show whether it's running, plus a quick summary
  watch [--interval N]             Live one-line view of what's on your profile
  preview [--json]                 Render your presence locally (active + idle)
  stats [--days N] [--json|--csv] [--out FILE]
                                   Usage history, chart, streaks and exports
  logs [--lines N] [-f]            Show the log, optionally following it live
  pause [--for 30m]                Hide the presence (optionally auto-resuming)
  resume                           Show it again
  theme [list|<name>]              List or switch the built-in looks
  doctor                           Run full diagnostics and suggest fixes
  install                          Enable run-at-login, then start the helper now
  uninstall                        Disable run-at-login
  config [--path]                  Print the config (or just its file path)
  config get <key>                 Print one value, e.g. presence.details
  config set <key> <value>         Change one value without editing JSON by hand
  help                             Show this help
  version                          Print the version

Text fields accept {placeholders}: {model} {plan} {project} {branch} {title}
{messages} {tokens} {sessions} {status} {session} {idle} {today} {month} {total}
{streak} {usage5h} {usage7d} {time}

First time? Run:  claude-presence setup`);
}

// ── dispatch ──────────────────────────────────────────────────────────────────
async function main() {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case 'setup': return cmdSetup(args);
    case 'start': return cmdStart(args);
    case 'stop': return cmdStop(args);
    case 'restart': return cmdRestart(args);
    case 'status': return cmdStatus(args);
    case 'stats': return cmdStats(args);
    case 'watch': return cmdWatch(args);
    case 'preview': return cmdPreview(args);
    case 'theme': case 'themes': return cmdTheme(args);
    case 'logs': case 'log': return cmdLogs(args);
    case 'pause': return cmdPause(args);
    case 'resume': return cmdResume(args);
    case 'doctor': return cmdDoctor(args);
    case 'install': return cmdInstall(args);
    case 'uninstall': return cmdUninstall(args);
    case 'config': return cmdConfig(args);
    case 'version': case '--version': case '-v': return print(PKG.version);
    case 'help': case '--help': case '-h': case undefined: return help();
    default:
      print(`Unknown command: ${cmd}\n`);
      help();
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
