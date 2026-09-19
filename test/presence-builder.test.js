'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const presence = require('../src/presence-builder');

// usage.show=false keeps build() pure (it never reads stats.json from disk).
const baseCfg = {
  showTimer: true,
  model: { show: false },
  usage: { show: false },
  presence: {
    activeType: 0,
    largeImage: 'claude_logo',
    largeText: 'Claude',
    smallImageActive: 'active',
    smallImageIdle: 'idle',
    smallTextActive: 'Active',
    smallTextIdle: 'Idle',
    details: 'Top line',
    stateActive: 'Active state',
    stateIdle: 'Idle state',
    rotateMessages: [],
    buttons: [],
  },
};

test('build returns null when Claude is not running', () => {
  assert.strictEqual(presence.build({ running: false }, baseCfg), null);
});

test('build sets details, state, type and the timer', () => {
  const a = presence.build({ running: true, active: true, sessionStart: 1700000000000 }, baseCfg);
  assert.strictEqual(a.details, 'Top line');
  assert.strictEqual(a.state, 'Active state');
  assert.strictEqual(a.type, 0);
  assert.strictEqual(a.timestamps.start, Math.floor(1700000000000 / 1000));
});

test('build uses the idle state line when inactive', () => {
  const a = presence.build({ running: true, active: false, sessionStart: 0 }, baseCfg);
  assert.strictEqual(a.state, 'Idle state');
});

test('build prefixes the model when model.show and a model is given', () => {
  const cfg = { ...baseCfg, model: { show: true, label: 'Opus 4.8' } };
  const a = presence.build({ running: true, active: true, model: 'Opus 4.8' }, cfg);
  assert.strictEqual(a.state, 'Opus 4.8 · Active state');
});

test('build puts the plan on the 2nd line when usage.showOnCard is set', () => {
  const cfg = {
    ...baseCfg,
    model: { show: true, label: 'Opus 4.8' },
    usage: { show: true, showOnCard: true, planLabel: 'Claude Max' },
  };
  const a = presence.build({ running: true, active: true, model: 'Opus 4.8' }, cfg);
  assert.strictEqual(a.state, 'Opus 4.8 · Claude Max');
});

test('build keeps the status line when showOnCard is off', () => {
  const cfg = {
    ...baseCfg,
    model: { show: false },
    usage: { show: true, showOnCard: false, planLabel: 'Claude Max' },
  };
  const a = presence.build({ running: true, active: true }, cfg);
  assert.strictEqual(a.state, 'Active state');
});

test('build rotates the top line through rotateMessages', () => {
  const cfg = { ...baseCfg, presence: { ...baseCfg.presence, rotateMessages: ['Alpha', 'Bravo', 'Charlie'] } };
  assert.strictEqual(presence.build({ running: true, rotationIndex: 0 }, cfg).details, 'Alpha');
  assert.strictEqual(presence.build({ running: true, rotationIndex: 4 }, cfg).details, 'Bravo');
});

test('build keeps only valid http(s) buttons, capped at two', () => {
  const cfg = {
    ...baseCfg,
    presence: {
      ...baseCfg.presence,
      buttons: [
        { label: 'ok', url: 'https://a.com' },
        { label: 'bad', url: 'ftp://x' },
        { label: 'ok2', url: 'http://b.com' },
        { label: 'third', url: 'https://c.com' },
      ],
    },
  };
  const a = presence.build({ running: true, active: true }, cfg);
  assert.strictEqual(a.buttons.length, 2);
  assert.strictEqual(a.buttons[0].label, 'ok');
  assert.strictEqual(a.buttons[1].url, 'http://b.com');
});

test('clampStr pads short strings and truncates long ones with an ellipsis', () => {
  assert.strictEqual(presence.clampStr('x', 128), 'x ');
  assert.strictEqual(presence.clampStr(undefined, 128), undefined);
  assert.strictEqual(presence.clampStr('', 128), undefined);
  assert.strictEqual(presence.clampStr('   ', 128), undefined);
  const out = presence.clampStr('a'.repeat(200), 10);
  assert.strictEqual(out.length, 10);
  assert.ok(out.endsWith('…'));
});

test('signature is stable across timestamp changes and "null" for cleared', () => {
  const a = presence.build({ running: true, active: true, sessionStart: 1 }, baseCfg);
  const b = presence.build({ running: true, active: true, sessionStart: 999999 }, baseCfg);
  assert.strictEqual(presence.signature(a), presence.signature(b));
  assert.strictEqual(presence.signature(null), 'null');
});

test('build puts the real plan meters in the tooltip when given', () => {
  const cfg = {
    ...baseCfg,
    usage: { show: true, planLabel: 'Claude Max', showToday: false, showMonth: false, showLimits: true },
  };
  const state = { running: true, active: true, planUsage: { fiveHourPct: 60, sevenDayPct: 38 } };
  assert.strictEqual(presence.build(state, cfg).assets.large_text, 'Claude Max · 5h 60% · week 38%');
  // Switched off → never rendered, even when a sample is at hand.
  const off = { ...cfg, usage: { ...cfg.usage, showLimits: false } };
  assert.strictEqual(presence.build(state, off).assets.large_text, 'Claude Max');
  // No sample → nothing is invented.
  assert.strictEqual(presence.build({ running: true, active: true, planUsage: null }, cfg).assets.large_text, 'Claude Max');
});

test('build resolves the session placeholders', () => {
  const cfg = {
    ...baseCfg,
    usage: { show: true, showLimits: true },
    presence: {
      ...baseCfg.presence,
      details: '{title} · {messages} prompts · {tokens} tokens · {sessions} open',
      stateActive: '5h {usage5h} · week {usage7d} · {branch}',
    },
  };
  const a = presence.build({
    running: true, active: true, title: 'Fix the parser', messages: 3, tokens: 165000, sessions: 2,
    branch: 'main', planUsage: { fiveHourPct: 60, sevenDayPct: 38 },
  }, cfg);
  assert.strictEqual(a.details, 'Fix the parser · 3 prompts · 165k tokens · 2 open');
  assert.strictEqual(a.state, '5h 60% · week 38% · main');

  // Everything blank collapses cleanly: a segment whose placeholders are all
  // empty vanishes with its words, and an empty field is omitted altogether.
  const b = presence.build({ running: true, active: true, planUsage: null }, cfg);
  assert.strictEqual(b.details, undefined);
  assert.strictEqual(b.state, undefined);
  const c = presence.build({ running: true, active: true, messages: 1, branch: 'dev', planUsage: null }, cfg);
  assert.strictEqual(c.details, '1 prompts');
  assert.strictEqual(c.state, 'dev');
});

test('templates pluralise units and drop empty segments', () => {
  const cfg = {
    ...baseCfg,
    presence: { ...baseCfg.presence, details: '{model} · {messages:prompt|prompts} sent · on {branch}' },
  };
  const state = (extra) => ({ running: true, active: true, model: 'Opus 5', ...extra });
  assert.strictEqual(presence.build(state({ messages: 1, branch: 'main' }), { ...cfg, model: { show: true } }).details, 'Opus 5 · 1 prompt sent · on main');
  assert.strictEqual(presence.build(state({ messages: 12 }), { ...cfg, model: { show: true } }).details, 'Opus 5 · 12 prompts sent');
  assert.strictEqual(presence.build(state({}), { ...cfg, model: { show: true } }).details, 'Opus 5');
});

test('project.show=false hides the session title too', () => {
  const cfg = { ...baseCfg, project: { show: false }, presence: { ...baseCfg.presence, details: 'On {title}' } };
  const a = presence.build({ running: true, active: true, title: 'Secret work', project: 'secret' }, cfg);
  assert.strictEqual(a.details, undefined); // the whole segment goes, not just the name
});
