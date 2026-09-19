'use strict';

/**
 * Detects whether the Claude desktop app is running, and (optionally) whether
 * it is the focused/foreground window. Uses only built-in OS tools so there
 * are no native dependencies to compile.
 *
 *   - Running check:  `tasklist` (Windows) / `ps` (macOS, Linux)
 *   - Start time (once per session, for an accurate elapsed timer):
 *     PowerShell `Get-Process` (Windows) / `ps -o etime` (macOS, Linux)
 *   - Foreground check (optional): a generated PowerShell script using the
 *     Win32 GetForegroundWindow API (Windows) / `osascript` (macOS).
 */

const fs = require('fs');
const { exec } = require('child_process');
const { ensureDataDir, foregroundScriptPath } = require('./paths');

/** Runs a shell command, resolving its stdout ('' on any error/timeout). */
function run(cmd, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const child = exec(
      cmd,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : stdout || '')
    );
    child.on('error', () => resolve(''));
  });
}

/** Normalises a process name for comparison: lowercase, no ".exe". */
function norm(name) {
  return String(name || '').trim().toLowerCase().replace(/\.exe$/, '');
}

/**
 * Every running process as { name, pid } (name normalised). One OS call per
 * poll; everything else below is derived from this list.
 * @returns {Promise<Array<{name: string, pid: number}>>}
 */
async function listProcesses() {
  const list = [];
  if (process.platform === 'win32') {
    const out = await run('tasklist /NH /FO CSV');
    for (const line of out.split(/\r?\n/)) {
      // "Image Name","PID","Session Name","Session#","Mem Usage"
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m) list.push({ name: norm(m[1]), pid: parseInt(m[2], 10) });
    }
  } else {
    const out = await run('ps -A -o pid=,comm=');
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      list.push({ name: norm(m[2].split('/').pop()), pid: parseInt(m[1], 10) });
    }
  }
  return list;
}

/** Returns a Set of normalised names of all currently-running processes. */
async function getRunningProcessNames() {
  return new Set((await listProcesses()).map((p) => p.name));
}

/**
 * PIDs of every running process whose name is one of `processNames`.
 * On Windows a filtered `tasklist` per name is ~3× faster than listing
 * everything (the poll loop runs this every few seconds).
 * @returns {Promise<Set<number>>}
 */
async function getClaudePids(processNames) {
  const targets = new Set((processNames || []).map(norm).filter(Boolean));
  const pids = new Set();
  if (!targets.size) return pids;
  if (process.platform === 'win32') {
    const outputs = await Promise.all([...targets].map((name) =>
      run(`tasklist /NH /FO CSV /FI "IMAGENAME eq ${name.replace(/"/g, '')}.exe"`)));
    for (const out of outputs) {
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)","(\d+)"/);
        if (m && targets.has(norm(m[1]))) pids.add(parseInt(m[2], 10));
      }
    }
    return pids;
  }
  for (const p of await listProcesses()) {
    if (targets.has(p.name)) pids.add(p.pid);
  }
  return pids;
}

/** True if any configured Claude process name is currently running. */
async function isClaudeRunning(processNames) {
  return (await getClaudePids(processNames)).size > 0;
}

/** Parses ps's etime ("[[dd-]hh:]mm:ss") into seconds, or null. */
function parseEtime(text) {
  const m = String(text || '').trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = parseInt(m[1] || '0', 10);
  const hours = parseInt(m[2] || '0', 10);
  return ((days * 24 + hours) * 60 + parseInt(m[3], 10)) * 60 + parseInt(m[4], 10);
}

/**
 * When the OLDEST matching process started, in epoch ms, or null when it
 * can't be determined. The desktop app is many processes (it's Electron); the
 * earliest one is the app itself. Costs one PowerShell/ps call, so the daemon
 * asks once per session rather than every poll.
 */
async function getProcessStartMs(processNames) {
  const targets = (processNames || []).map(norm).filter(Boolean);
  if (!targets.length) return null;
  try {
    if (process.platform === 'win32') {
      const names = targets.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
      const script =
        `$p = Get-Process -Name ${names} -ErrorAction SilentlyContinue | ` +
        `ForEach-Object { try { [DateTimeOffset]::new($_.StartTime).ToUnixTimeMilliseconds() } catch {} } | ` +
        'Sort-Object | Select-Object -First 1; if ($p) { [Console]::Out.Write($p) }';
      const out = await run(`powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`, 8000);
      const ms = parseInt(out.trim(), 10);
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    const out = await run('ps -A -o etime=,comm=', 6000);
    let oldest = null;
    const now = Date.now();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\S+)\s+(.+)$/);
      if (!m) continue;
      if (!targets.includes(norm(m[2].split('/').pop()))) continue;
      const secs = parseEtime(m[1]);
      if (secs === null) continue;
      const started = now - secs * 1000;
      if (oldest === null || started < oldest) oldest = started;
    }
    return oldest;
  } catch (_) {
    return null;
  }
}

const FOREGROUND_PS1 = `$ErrorActionPreference='SilentlyContinue'
$sig=@"
using System;
using System.Runtime.InteropServices;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
"@
Add-Type -TypeDefinition $sig
$h=[FgWin]::GetForegroundWindow()
$p=0
[void][FgWin]::GetWindowThreadProcessId($h,[ref]$p)
(Get-Process -Id $p).ProcessName
`;

/** Writes the foreground-detection PowerShell script once and returns its path. */
function ensureForegroundScript() {
  ensureDataDir();
  const p = foregroundScriptPath();
  try {
    if (!fs.existsSync(p)) fs.writeFileSync(p, FOREGROUND_PS1);
  } catch (_) {
    /* ignore */
  }
  return p;
}

/** Name of the current foreground-window process, or null if undetectable. */
async function getForegroundProcessName() {
  try {
    if (process.platform === 'win32') {
      const script = ensureForegroundScript();
      const out = await run(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`,
        6000
      );
      return out.trim() ? norm(out) : null;
    }
    if (process.platform === 'darwin') {
      const out = await run(
        `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
        6000
      );
      return out.trim() ? norm(out) : null;
    }
  } catch (_) {
    /* fall through */
  }
  return null; // unsupported platform or detection failed
}

/**
 * Whether Claude is the focused window.
 * @returns true / false, or null when it can't be determined.
 */
async function isClaudeActive(processNames) {
  const fg = await getForegroundProcessName();
  if (fg === null) return null;
  const targets = (processNames || []).map(norm).filter(Boolean);
  return targets.includes(fg);
}

module.exports = {
  listProcesses,
  getRunningProcessNames,
  getClaudePids,
  isClaudeRunning,
  getProcessStartMs,
  parseEtime,
  getForegroundProcessName,
  isClaudeActive,
  norm,
};
