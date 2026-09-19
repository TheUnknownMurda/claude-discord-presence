'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');

test('deepMerge fills missing keys and replaces arrays wholesale', () => {
  const base = { a: 1, nested: { x: 1, y: 2 }, arr: [1, 2, 3] };
  const out = config.deepMerge(base, { nested: { y: 9 }, arr: [7] });
  assert.deepStrictEqual(out, { a: 1, nested: { x: 1, y: 9 }, arr: [7] });
});

test('deepMerge returns base when override is undefined', () => {
  assert.deepStrictEqual(config.deepMerge({ a: 1 }, undefined), { a: 1 });
});

test('isClientIdPlaceholder accepts only 15-25 digit ids', () => {
  assert.strictEqual(config.isClientIdPlaceholder(''), true);
  assert.strictEqual(config.isClientIdPlaceholder('abc'), true);
  assert.strictEqual(config.isClientIdPlaceholder('123'), true);
  assert.strictEqual(config.isClientIdPlaceholder('123456789012345678'), false);
});

test('resolveClientId prefers a valid user-supplied id', () => {
  assert.strictEqual(config.resolveClientId({ clientId: '123456789012345678' }), '123456789012345678');
});

test('resolveClientId falls back to the built-in default (or null)', () => {
  // A blank user id resolves to the baked-in DEFAULT_CLIENT_ID when one is set
  // (the zero-setup path); forks that blank it out get null instead.
  const expected = config.isClientIdPlaceholder(config.DEFAULT_CLIENT_ID)
    ? null
    : config.DEFAULT_CLIENT_ID;
  assert.strictEqual(config.resolveClientId({ clientId: '' }), expected);
});

test('migrateLegacy repoints and renames the old default button, leaving everything else alone', () => {
  const user = { presence: { buttons: [
    { label: 'Try Claude', url: 'https://claude.ai' },
    { label: 'Get this plugin', url: 'https://github.com/HeavenDCS/claude-discord-presence' },
  ] } };
  const out = config.migrateLegacy(user);
  assert.deepStrictEqual(out.presence.buttons[0], { label: 'Try Claude', url: 'https://claude.ai' });
  assert.deepStrictEqual(out.presence.buttons[1], {
    label: 'Get this presence', url: 'https://github.com/TheUnknownMurda/claude-discord-presence',
  });
  assert.strictEqual(user.presence.buttons[1].url, 'https://github.com/HeavenDCS/claude-discord-presence'); // input untouched

  // Old label on the new URL → renamed; a custom label on the old URL → only the URL moves.
  const mixed = { presence: { buttons: [
    { label: 'Get this plugin', url: 'https://github.com/TheUnknownMurda/claude-discord-presence' },
    { label: 'My fork', url: 'https://github.com/HeavenDCS/claude-discord-presence/tree/x' },
  ] } };
  const m = config.migrateLegacy(mixed);
  assert.strictEqual(m.presence.buttons[0].label, 'Get this presence');
  assert.deepStrictEqual(m.presence.buttons[1], {
    label: 'My fork', url: 'https://github.com/TheUnknownMurda/claude-discord-presence/tree/x',
  });

  const clean = { presence: { buttons: [{ label: 'x', url: 'https://example.com' }] } };
  assert.strictEqual(config.migrateLegacy(clean), clean); // nothing to do → same object
  assert.strictEqual(config.withTheme(user).presence.buttons[1].label, 'Get this presence');
});
