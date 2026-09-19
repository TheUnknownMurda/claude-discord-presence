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
