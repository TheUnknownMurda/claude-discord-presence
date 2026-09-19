'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const stats = require('../src/stats');

test('formatDuration formats hours, minutes and seconds', () => {
  assert.strictEqual(stats.formatDuration(0), '0s');
  assert.strictEqual(stats.formatDuration(12), '12s');
  assert.strictEqual(stats.formatDuration(60), '1m');
  assert.strictEqual(stats.formatDuration(83 * 60), '1h 23m');
  assert.strictEqual(stats.formatDuration(3600), '1h 0m');
});

test('formatDuration clamps negatives and floors fractions', () => {
  assert.strictEqual(stats.formatDuration(-5), '0s');
  assert.strictEqual(stats.formatDuration(59.9), '59s');
});

test('today returns a YYYY-MM-DD key', () => {
  assert.match(stats.today(), /^\d{4}-\d{2}-\d{2}$/);
});

test('dayKey formats an arbitrary date in local time, zero-padded', () => {
  assert.strictEqual(stats.dayKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.strictEqual(stats.dayKey(new Date(2026, 11, 31)), '2026-12-31');
});

// Read-only: these never write to the real data directory.
test('getLastDays returns a contiguous window ending today, oldest first', () => {
  const days = stats.getLastDays(5);
  assert.strictEqual(days.length, 5);
  assert.strictEqual(days[days.length - 1].date, stats.today());
  for (const day of days) {
    assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isFinite(day.seconds) && day.seconds >= 0);
  }
  const keys = days.map((d) => d.date);
  assert.deepStrictEqual(keys, [...keys].sort());
});

test('getLastDays clamps a bogus window to at least one day', () => {
  assert.strictEqual(stats.getLastDays(0).length, 7);
  assert.strictEqual(stats.getLastDays(-3).length, 1);
});
