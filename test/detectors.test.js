'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { norm, parseEtime } = require('../src/claude-detector');
const { friendlyModel } = require('../src/model-detector');
const { ipcCandidates } = require('../src/discord-rpc');
const claudeData = require('../src/claude-data');
const activity = require('../src/activity-detector');
const claudeSessions = require('../src/claude-sessions');
const discordApp = require('../src/discord-app');

test('norm lowercases, trims and strips a trailing .exe', () => {
  assert.strictEqual(norm('  Claude.exe '), 'claude');
  assert.strictEqual(norm('Claude'), 'claude');
  assert.strictEqual(norm('CLAUDE.EXE'), 'claude');
  assert.strictEqual(norm(null), '');
});

test('friendlyModel turns model ids into display names', () => {
  assert.strictEqual(friendlyModel('claude-opus-4-8'), 'Opus 4.8');
  assert.strictEqual(friendlyModel('claude-sonnet-4-6'), 'Sonnet 4.6');
  assert.strictEqual(friendlyModel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.strictEqual(friendlyModel('claude-fable-5'), 'Fable 5');
});

test('friendlyModel handles a family with no version', () => {
  assert.strictEqual(friendlyModel('claude-opus-5'), 'Opus 5');
});

test('friendlyModel prefers the app catalogue name when one is given', () => {
  const catalog = { 'claude-fable-5-1': 'Fable 5.1', 'claude-opus-5': 'Opus 5 (custom)' };
  assert.strictEqual(friendlyModel('claude-fable-5-1', catalog), 'Fable 5.1');
  assert.strictEqual(friendlyModel('CLAUDE-OPUS-5', catalog), 'Opus 5 (custom)');
  assert.strictEqual(friendlyModel('claude-sonnet-4-6', catalog), 'Sonnet 4.6'); // not in catalogue
});

test('parseEtime understands every ps elapsed-time shape', () => {
  assert.strictEqual(parseEtime('03:04'), 184);
  assert.strictEqual(parseEtime('02:03:04'), 7384);
  assert.strictEqual(parseEtime('1-02:03:04'), 93784);
  assert.strictEqual(parseEtime('nonsense'), null);
});

test('encodeCwd mirrors the project folder naming Claude Code uses', () => {
  assert.strictEqual(claudeData.encodeCwd('C:\\Users\\me\\Desktop\\My App'), 'C--Users-me-Desktop-My-App');
  assert.strictEqual(claudeData.encodeCwd('/home/me/dev/my.app'), '-home-me-dev-my-app');
});

test('ipcCandidates returns non-empty, platform-appropriate socket paths', () => {
  const list = ipcCandidates();
  assert.ok(Array.isArray(list) && list.length > 0);
  assert.ok(list.every((p) => p.includes('discord-ipc-')));
});

test('candidateRoots always includes the Claude Code directory', () => {
  const roots = claudeData.candidateRoots();
  assert.ok(roots.length >= 2);
  assert.ok(roots.some((r) => /[\\/]\.claude$/.test(r)));
});

// The detector reads real mtimes and Claude Code's registry, so stub both
// sources to test the logic hermetically.
function stubSessions(t, list) {
  const origLive = claudeSessions.liveSessions;
  const origBusy = claudeSessions.anyBusy;
  claudeSessions.liveSessions = () => list;
  claudeSessions.anyBusy = () => list.some((x) => x.status === 'busy');
  t.after(() => {
    claudeSessions.liveSessions = origLive;
    claudeSessions.anyBusy = origBusy;
  });
}

test('isActive compares the last write against the window', (t) => {
  const original = claudeData.lastWriteMs;
  stubSessions(t, []);
  t.after(() => {
    claudeData.lastWriteMs = original;
    activity.resetCache();
  });

  claudeData.lastWriteMs = () => Date.now() - 10 * 1000;
  activity.resetCache();
  assert.strictEqual(activity.isActive(300), true);

  claudeData.lastWriteMs = () => Date.now() - 20 * 60 * 1000;
  activity.resetCache();
  assert.strictEqual(activity.isActive(300), false);
  assert.ok(activity.secondsSinceActivity() >= 1190);

  // Undetectable must stay null so callers can fall back, not read as idle.
  claudeData.lastWriteMs = () => null;
  activity.resetCache();
  assert.strictEqual(activity.isActive(300), null);
  assert.strictEqual(activity.secondsSinceActivity(), null);
});

test('a busy Claude Code session counts as active regardless of file mtimes', (t) => {
  const original = claudeData.lastWriteMs;
  stubSessions(t, [{ pid: 1, status: 'busy', lastActivity: Date.now() - 3600 * 1000 }]);
  t.after(() => {
    claudeData.lastWriteMs = original;
    activity.resetCache();
  });
  claudeData.lastWriteMs = () => Date.now() - 2 * 3600 * 1000;
  activity.resetCache();
  assert.strictEqual(activity.isActive(300), true);
  assert.ok(activity.secondsSinceActivity() <= 1);
});

test('an idle session that changed status recently counts as that recent', (t) => {
  const original = claudeData.lastWriteMs;
  stubSessions(t, [{ pid: 1, status: 'idle', lastActivity: Date.now() - 60 * 1000 }]);
  t.after(() => {
    claudeData.lastWriteMs = original;
    activity.resetCache();
  });
  claudeData.lastWriteMs = () => Date.now() - 2 * 3600 * 1000;
  activity.resetCache();
  assert.strictEqual(activity.isActive(300), true);
  assert.strictEqual(activity.isActive(30), false);
});

test('isActive clamps an absurdly small window to 30s', (t) => {
  const original = claudeData.lastWriteMs;
  stubSessions(t, []);
  t.after(() => {
    claudeData.lastWriteMs = original;
    activity.resetCache();
  });
  claudeData.lastWriteMs = () => Date.now() - 20 * 1000;
  activity.resetCache();
  assert.strictEqual(activity.isActive(1), true);
});

test('looksLikeUrl spots URLs and media-proxy paths, not asset keys', () => {
  assert.strictEqual(discordApp.looksLikeUrl('https://example.com/a.png'), true);
  assert.strictEqual(discordApp.looksLikeUrl('mp:external/abc/def'), true);
  assert.strictEqual(discordApp.looksLikeUrl('claude'), false);
  assert.strictEqual(discordApp.looksLikeUrl(''), false);
});
