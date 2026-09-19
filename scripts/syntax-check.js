#!/usr/bin/env node
'use strict';

/**
 * Cross-platform `node --check` over every tracked .js file. Catches syntax
 * errors in files that the test suite doesn't import (daemon, cli, autostart,
 * logger, …) so CI fails fast on a typo. No dependencies, no shell globs.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.codegraph', '.claude', 'github-upload']);

function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = collect(ROOT, []);
let failed = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    process.stderr.write(`✗ ${path.relative(ROOT, file)}\n${(e.stderr || e.message || '').toString()}\n`);
  }
}

if (failed) {
  process.stderr.write(`\nSyntax check failed: ${failed} file(s) with errors.\n`);
  process.exit(1);
}
process.stdout.write(`✓ Syntax OK: ${files.length} files checked.\n`);
