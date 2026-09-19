'use strict';

/**
 * Tiny leveled logger. Writes to the console AND to a size-rotated log file
 * in the data directory so a background (windowless) daemon still leaves a
 * trail you can inspect with `claude-presence doctor` or by opening the file.
 */

const fs = require('fs');
const { logPath, ensureDataDir } = require('./paths');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const MAX_LOG_BYTES = 1024 * 1024; // rotate at ~1 MB

let currentLevel = LEVELS.info;
let fileLogging = true;

function setLevel(name) {
  if (name && Object.prototype.hasOwnProperty.call(LEVELS, name)) {
    currentLevel = LEVELS[name];
  }
}

function setFileLogging(enabled) {
  fileLogging = !!enabled;
}

function rotateIfNeeded() {
  try {
    const p = logPath();
    const stat = fs.statSync(p);
    if (stat.size > MAX_LOG_BYTES) {
      fs.renameSync(p, p + '.1'); // keep a single previous log
    }
  } catch (_) {
    /* file may not exist yet — that's fine */
  }
}

function format(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try {
    return JSON.stringify(arg);
  } catch (_) {
    return String(arg);
  }
}

function write(level, args) {
  if (LEVELS[level] > currentLevel) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ` + args.map(format).join(' ');

  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line + '\n');

  if (fileLogging) {
    try {
      ensureDataDir();
      rotateIfNeeded();
      fs.appendFileSync(logPath(), line + '\n');
    } catch (_) {
      /* never let logging crash the daemon */
    }
  }
}

module.exports = {
  setLevel,
  setFileLogging,
  error: (...a) => write('error', a),
  warn: (...a) => write('warn', a),
  info: (...a) => write('info', a),
  debug: (...a) => write('debug', a),
};
