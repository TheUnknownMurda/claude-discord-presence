'use strict';

/**
 * The long-lived background helper. Acquires the single-instance lock, then
 * polls for Claude and drives the Discord presence. Designed to run detached
 * and windowless; everything interesting goes to the log file.
 *
 * Run directly (`node src/daemon.js`) or via the CLI (`claude-presence start`).
 */

const fs = require('fs');
const config = require('./config');
const logger = require('./logger');
const paths = require('./paths');
const single = require('./single-instance');
const stats = require('./stats');
const detector = require('./claude-detector');
const modelDetector = require('./model-detector');
const activityDetector = require('./activity-detector');
const sessionInfo = require('./session-info');
const claudeSessions = require('./claude-sessions');
const planUsage = require('./plan-usage');
const pause = require('./pause');
const presence = require('./presence-builder');
const { writeFileAtomic } = require('./fs-utils');
const { DiscordRPC } = require('./discord-rpc');

// Discord tolerates roughly one activity update every few seconds; staying at
// or above 15s keeps us comfortably inside the limit even with a fast poll.
const MIN_PUSH_MS = 15 * 1000;

/** mtime of the config file, or 0 — used to notice edits without a restart. */
function configMtime() {
  try { return fs.statSync(paths.configPath()).mtimeMs; } catch (_) { return 0; }
}

/** Logs any config problems once per (re)load so mistakes aren't silent. */
function reportConfigProblems(cfg) {
  let problems = [];
  try { problems = config.validate(cfg); } catch (_) { return; }
  for (const problem of problems) logger.warn('Config: ' + problem);
}

async function runDaemon() {
  let cfg = config.load();
  logger.setLevel(cfg.logLevel || 'info');
  reportConfigProblems(cfg);

  // ── Single-instance guard ───────────────────────────────────────────────
  const lock = single.acquire();
  if (!lock.acquired) {
    logger.warn(`Another instance is already running (PID ${lock.pid}). Exiting.`);
    process.exitCode = 0;
    return;
  }
  if (lock.replacedStale) logger.info('Replaced a stale lock from a previous crash.');
  logger.info(`Claude Discord Presence started (PID ${process.pid}).`);

  // ── State ────────────────────────────────────────────────────────────────
  let sessionStart = null; // when the current Claude session began (ms)
  let sessionStartSource = null; // 'code' | 'process' | 'detected'
  let lastSignature = null; // last activity we pushed (to avoid spam)
  let stopped = false;
  let lastTickAt = Date.now(); // for measuring REAL elapsed time between polls
  let lastPushAt = 0; // when we last sent SET_ACTIVITY (for rate limiting)
  let cfgMtime = configMtime();
  let wasPaused = false;
  let wasRunning = false; // whether Claude was running on the previous poll
  let inFlight = false; // a poll is in progress (they must never overlap)
  let tickAgain = false; // a poll was requested while one was in flight

  let pollMs = pollInterval();
  function pollInterval() {
    return Math.max(5, cfg.pollIntervalSeconds || 15) * 1000;
  }
  function rotateSeconds() {
    return Math.max(10, (cfg.presence && cfg.presence.rotateIntervalSeconds) || 30);
  }

  // ── Discord client ────────────────────────────────────────────────────────
  let clientId = config.resolveClientId(cfg);
  let rpc = null;

  function createRpc(id) {
    const client = new DiscordRPC(id, logger);
    client.on('connected', (user) => {
      logger.info('Connected to Discord' + (user && user.username ? ` as ${user.username}` : '') + '.');
      lastSignature = null; // force a fresh push now that we're connected
      tick();
    });
    client.on('disconnected', () => {
      logger.warn('Lost the Discord connection; will retry automatically.');
      lastSignature = null;
    });
    client.on('rpc-error', (e) => {
      logger.warn('Discord rejected the presence: ' + (e && e.message) +
        ' — check your clientId and that asset keys exist in the Developer Portal.');
    });
    client.start();
    return client;
  }

  if (clientId) {
    rpc = createRpc(clientId);
  } else {
    logger.warn('No valid Discord Application ID set — presence is disabled.');
    logger.warn(`Run "claude-presence setup", or set "clientId" in ${config.configPath()}.`);
  }

  /** Re-reads config.json when it changes on disk, so edits apply live. */
  function reloadConfigIfChanged() {
    const mtime = configMtime();
    if (!mtime || mtime === cfgMtime) return;
    cfgMtime = mtime;
    try {
      cfg = config.load();
    } catch (e) {
      logger.warn('Ignoring the edited config (invalid JSON): ' + e.message);
      return;
    }
    logger.setLevel(cfg.logLevel || 'info');
    reportConfigProblems(cfg);
    lastSignature = null; // the appearance may have changed — push a fresh frame
    const nextPoll = pollInterval();
    if (nextPoll !== pollMs) {
      pollMs = nextPoll;
      restartTimer();
    }
    // A changed Application ID needs a fresh handshake with Discord.
    const nextId = config.resolveClientId(cfg);
    if (nextId !== clientId) {
      clientId = nextId;
      if (rpc) { try { rpc.destroy(); } catch (_) {} rpc = null; }
      if (clientId) {
        logger.info('Discord Application ID changed — reconnecting.');
        rpc = createRpc(clientId);
      } else {
        logger.warn('No valid Discord Application ID set — presence is disabled.');
      }
    }
    logger.info('Config reloaded.');
  }

  /**
   * Real seconds since the previous poll, capped so a suspended machine (or a
   * throttled timer) can't inflate the usage total: if the gap is much larger
   * than the poll interval, the time in between wasn't observed and we only
   * credit one interval of it.
   */
  function elapsedSeconds() {
    const now = Date.now();
    const delta = now - lastTickAt;
    lastTickAt = now;
    if (delta <= 0) return 0; // clock went backwards
    return Math.round(Math.min(delta, pollMs * 2) / 1000);
  }

  /**
   * Writes the snapshot `status --json` / `watch` read. Best-effort: a failed
   * write is never worth interrupting the presence for.
   */
  function writeState(snapshot) {
    try {
      paths.ensureDataDir();
      writeFileAtomic(paths.statePath(), JSON.stringify({
        pid: process.pid,
        version: require('../package.json').version,
        updatedAt: new Date().toISOString(),
        discordConnected: !!(rpc && rpc.connected),
        ...snapshot,
      }, null, 2));
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Whether Claude is in use at all, and through what. The desktop app shows
   * up as a process; Claude Code registers each live session in its own
   * registry (and, on older builds, just appends to its session files).
   * @returns {Promise<{running: boolean, source: string, pids: Set<number>,
   *                    sessions: object[]}>}
   */
  async function resolveRunning() {
    const pids = await detector.getClaudePids(cfg.claudeProcessNames);
    const act = cfg.activity || {};
    const codeEnabled = act.detectClaudeCode !== false;
    const sessions = codeEnabled ? claudeSessions.liveSessions(pids) : [];

    if (sessions.length) {
      // Electron's desktop app is a crowd of processes; Claude Code is one
      // per session. Any clear surplus means the desktop app is open too.
      const desktopToo = pids.size > sessions.length + 1;
      return { running: true, source: desktopToo ? 'desktop+code' : 'code', pids, sessions };
    }
    if (pids.size > 0) return { running: true, source: 'desktop', pids, sessions };
    if (codeEnabled) {
      const fresh = activityDetector.isActive(act.claudeCodeWindowSeconds || 120, pids);
      if (fresh === true) return { running: true, source: 'code', pids, sessions };
    }
    return { running: false, source: 'none', pids, sessions };
  }

  /** Decides whether the user is actively using Claude. */
  async function resolveActive(pids) {
    // The focused-window check is the strongest signal, when enabled.
    if (cfg.detectActiveWindow) {
      const focused = await detector.isClaudeActive(cfg.claudeProcessNames);
      if (focused !== null) return focused;
    }
    const act = cfg.activity || {};
    if (act.detect !== false) {
      const recent = activityDetector.isActive(act.idleAfterSeconds, pids);
      if (recent !== null) return recent;
    }
    return true; // undetectable → assume active (the pre-existing behaviour)
  }

  /**
   * When the session we're about to show actually began: the earliest live
   * Claude Code session, else the Claude process itself, else right now.
   */
  async function resolveSessionStart(sessions) {
    const fromRegistry = claudeSessions.earliestStart(new Set(sessions.map((s) => s.pid)));
    if (fromRegistry && fromRegistry <= Date.now()) return { at: fromRegistry, source: 'code' };
    const fromProcess = await detector.getProcessStartMs(cfg.claudeProcessNames);
    if (fromProcess && fromProcess <= Date.now()) return { at: fromProcess, source: 'process' };
    return { at: Date.now(), source: 'detected' };
  }

  // ── Poll loop ──────────────────────────────────────────────────────────────
  async function tick() {
    if (stopped) return;
    if (inFlight) { tickAgain = true; return; } // never let two polls overlap
    inFlight = true;
    try {
      await poll();
    } catch (e) {
      logger.error('Poll error:', e);
    } finally {
      inFlight = false;
      if (tickAgain && !stopped) {
        tickAgain = false;
        setImmediate(tick);
      }
    }
  }

  async function poll() {
    reloadConfigIfChanged();
    const seconds = elapsedSeconds();

    const paused = pause.isPaused();
    if (paused !== wasPaused) {
      wasPaused = paused;
      logger.info(paused ? 'Paused — hiding the presence.' : 'Resumed.');
    }

    const { running, source, pids, sessions } = await resolveRunning();
    const active = running ? await resolveActive(pids) : false;
    const act = cfg.activity || {};

    if (running) {
      if (!sessionStart) {
        const start = await resolveSessionStart(sessions);
        sessionStart = start.at;
        sessionStartSource = start.source;
        const ago = stats.formatDuration((Date.now() - sessionStart) / 1000);
        logger.info(`Claude detected (${source}) — session started ${ago} ago (${start.source}).`);
      }
      // Only credit time that was actually observed with Claude running: the
      // first poll after it opens covers a gap during which it wasn't.
      if (wasRunning && (active || !act.pauseStatsWhenIdle)) stats.addSeconds(seconds);
    } else if (sessionStart) {
      sessionStart = null;
      sessionStartSource = null;
      stats.flush(); // bank the session before it's forgotten
      logger.info('Claude closed.');
    }
    wasRunning = running;

    const hide = !running || paused || (!active && act.hideWhenIdle);
    if (hide) {
      if (lastSignature !== 'null') {
        if (rpc) rpc.clearActivity();
        lastSignature = 'null';
      }
      writeState({ running, active, paused, source, hidden: true, sessionStart, sessionStartSource });
      if (!running && cfg.onClaudeClose === 'exit') {
        logger.info('onClaudeClose=exit — shutting the helper down.');
        shutdown(0);
      }
      return;
    }

    // Resolve which model to show: configured label, optionally overridden
    // by best-effort detection (falls back to the label if detection is blank).
    let modelText = null;
    if (cfg.model && cfg.model.show) {
      modelText = cfg.model.label || null;
      if (cfg.model.detect) {
        const detected = modelDetector.detect(pids);
        if (detected) modelText = detected;
      }
    }

    // Project / branch / title / prompt count of the live Claude Code session.
    const proj = cfg.project || {};
    const session = proj.show !== false && proj.detect !== false ? sessionInfo.detect(pids) : null;

    // Real plan meters, when the desktop app has a fresh sample cached.
    const usage = cfg.usage || {};
    const plan = usage.show !== false && usage.showLimits !== false ? planUsage.current() : null;

    // Claude running → build and (conditionally) push the activity.
    const rotationIndex = Math.floor(Date.now() / 1000 / rotateSeconds());
    const state = {
      running,
      active,
      sessionStart,
      rotationIndex,
      model: modelText,
      project: session && session.project,
      branch: session && session.branch,
      title: session && session.title,
      messages: session && session.messages,
      tokens: session && session.tokens,
      sessions: sessions.length,
      idleSeconds: activityDetector.secondsSinceActivity(pids),
      planUsage: plan,
    };
    const activity = presence.build(state, cfg);
    const sig = presence.signature(activity);
    writeState({
      running,
      active,
      paused,
      source,
      hidden: false,
      sessionStart,
      sessionStartSource,
      model: modelText,
      project: state.project || null,
      branch: state.branch || null,
      title: state.title || null,
      messages: state.messages || null,
      tokens: state.tokens || null,
      sessions: sessions.map((s) => ({ pid: s.pid, status: s.status, title: s.title, entrypoint: s.entrypoint })),
      sessionStatus: session && session.status ? session.status : null,
      idleSeconds: state.idleSeconds,
      planUsage: plan ? { fiveHourPct: plan.fiveHourPct, sevenDayPct: plan.sevenDayPct, at: plan.at } : null,
      todaySeconds: stats.getTodaySeconds(),
      monthSeconds: stats.getMonthSeconds(),
      streakDays: stats.getStreakDays(),
      details: activity && activity.details,
      state: activity && activity.state,
      largeText: activity && activity.assets && activity.assets.large_text,
    });
    if (rpc && rpc.connected && sig !== lastSignature) {
      // Discord rate-limits activity updates (a handful per 20s). Skipping a
      // too-soon update is harmless: lastSignature stays put, so the next
      // poll retries and nothing is permanently lost.
      if (Date.now() - lastPushAt < MIN_PUSH_MS) {
        logger.debug('Update deferred to respect Discord rate limits.');
      } else {
        rpc.setActivity(activity);
        lastPushAt = Date.now();
        lastSignature = sig;
        logger.debug(`Presence updated (${active ? 'active' : 'idle'}).`);
      }
    }
  }

  let interval = setInterval(tick, pollMs);
  function restartTimer() {
    clearInterval(interval);
    interval = setInterval(tick, pollMs);
    logger.debug(`Poll interval is now ${pollMs / 1000}s.`);
  }
  tick(); // run immediately so we don't wait a full interval at startup

  // ── Shutdown ───────────────────────────────────────────────────────────────
  function shutdown(code) {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    stats.flush(); // don't lose the seconds buffered since the last write
    try { fs.unlinkSync(paths.statePath()); } catch (_) {}
    try { if (rpc) rpc.clearActivity(); } catch (_) {}
    // Give the clear frame a moment to flush before we tear down the socket.
    setTimeout(() => {
      try { if (rpc) rpc.destroy(); } catch (_) {}
      single.release();
      logger.info('Stopped.');
      process.exit(code || 0);
    }, 300);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGHUP', () => shutdown(0));
  process.on('uncaughtException', (e) => {
    logger.error('Uncaught exception:', e);
    shutdown(1);
  });
  // Last-ditch cleanup if the process exits some other way (e.g. taskkill).
  process.on('exit', () => {
    stats.flush();
    single.release();
  });
}

if (require.main === module) {
  runDaemon().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}

module.exports = { runDaemon };
