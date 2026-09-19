'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('../src/fs-utils');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-test-'));
}

test('writeFileAtomic writes the given contents', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'data.json');
    writeFileAtomic(f, '{"a":1}');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":1}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic overwrites an existing file', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'data.json');
    writeFileAtomic(f, 'old');
    writeFileAtomic(f, 'new');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'new');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic leaves no temp files behind', () => {
  const dir = tmpDir();
  try {
    writeFileAtomic(path.join(dir, 'data.json'), 'x');
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
    assert.deepStrictEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
