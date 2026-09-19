'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claudeData = require('../src/claude-data');
const claudeSessions = require('../src/claude-sessions');
const planUsage = require('../src/plan-usage');
const modelDetector = require('../src/model-detector');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-test-'));
}

/** Points the registry at a temp ~/.claude for the duration of one test. */
function fakeClaudeDir(t) {
  const dir = tmpDir();
  const original = claudeData.claudeCodeDir;
  claudeData.claudeCodeDir = () => dir;
  claudeSessions.resetCache();
  t.after(() => {
    claudeData.claudeCodeDir = original;
    claudeSessions.resetCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const DEAD_PID = 2147483000; // no such process, on any OS

function writeEntry(dir, entry) {
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', `${entry.pid}.json`), JSON.stringify(entry));
}

test('liveSessions keeps only entries whose process is alive', (t) => {
  const dir = fakeClaudeDir(t);
  writeEntry(dir, { pid: process.pid, sessionId: 'abc', cwd: '/x/app', startedAt: 1000, status: 'idle', name: 'Mine' });
  writeEntry(dir, { pid: DEAD_PID, sessionId: 'dead', cwd: '/x/old', startedAt: 500, status: 'busy' });
  fs.writeFileSync(path.join(dir, 'sessions', 'junk.json'), '{}');
  fs.writeFileSync(path.join(dir, 'sessions', '12.json'), 'not json');

  const live = claudeSessions.liveSessions();
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0].pid, process.pid);
  assert.strictEqual(live[0].title, 'Mine');
  assert.strictEqual(live[0].status, 'idle');
  assert.strictEqual(claudeSessions.anyBusy(), false);
  assert.strictEqual(claudeSessions.earliestStart(), 1000);
});

test('liveSessions trusts the caller\'s PID list and orders busy first', (t) => {
  const dir = fakeClaudeDir(t);
  writeEntry(dir, { pid: process.pid, sessionId: 'a', startedAt: 3000, status: 'idle', updatedAt: 9 });
  writeEntry(dir, { pid: DEAD_PID, sessionId: 'b', startedAt: 2000, status: 'busy', updatedAt: 1 });

  // Listed → trusted even though kill(0) would say it's dead.
  const live = claudeSessions.liveSessions(new Set([process.pid, DEAD_PID]));
  assert.deepStrictEqual(live.map((s) => s.pid), [DEAD_PID, process.pid]);
  assert.strictEqual(claudeSessions.primary(new Set([process.pid, DEAD_PID])).status, 'busy');
  assert.strictEqual(claudeSessions.earliestStart(new Set([process.pid, DEAD_PID])), 2000);

  // Not listed but alive and recent → still accepted.
  claudeSessions.resetCache();
  assert.deepStrictEqual(claudeSessions.liveSessions(new Set([424242])).map((s) => s.pid), [process.pid]);
});

test('liveSessions returns nothing when there is no registry', (t) => {
  fakeClaudeDir(t);
  assert.deepStrictEqual(claudeSessions.liveSessions(), []);
  assert.strictEqual(claudeSessions.primary(), null);
  assert.strictEqual(claudeSessions.earliestStart(), null);
});

test('transcriptFor jumps straight to the live session file', (t) => {
  const dir = fakeClaudeDir(t);
  const proj = path.join(dir, 'projects', 'C--dev-my-app');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'sess-1.jsonl'), '{}\n');
  assert.strictEqual(claudeData.transcriptFor('C:\\dev\\my app', 'sess-1'), path.join(proj, 'sess-1.jsonl'));
  assert.strictEqual(claudeData.transcriptFor('C:\\dev\\my app', 'nope'), null);
  assert.strictEqual(claudeData.transcriptFor(null, '../etc/passwd'), null);
});

test('plan-usage parses the newest usable sample', () => {
  const text = JSON.stringify({ version: 2, samples: [
    { t: 1, org: 'o', u: { fh: 10, sd: 5 } },
    { t: 2, org: 'o', u: { fh: 61.4, sd: 38 } },
    { t: 3, org: 'o', u: {} }, // no numbers → skipped
    { t: 4, org: 'o' }, // malformed → skipped
  ] });
  assert.deepStrictEqual(planUsage.parse(text), { at: 2, fiveHourPct: 61, sevenDayPct: 38 });
  assert.strictEqual(planUsage.parse('{"samples":[]}'), null);
  assert.strictEqual(planUsage.parse('garbage'), null);
  assert.strictEqual(planUsage.formatPct(60), '60%');
  assert.strictEqual(planUsage.formatPct(null), '');
});

test('plan-usage.current reads the desktop file and ignores stale samples', (t) => {
  const dir = tmpDir();
  const original = claudeData.desktopRoots;
  claudeData.desktopRoots = () => [dir];
  planUsage.resetCache();
  t.after(() => {
    claudeData.desktopRoots = original;
    planUsage.resetCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'plan-usage-history.json');

  fs.writeFileSync(file, JSON.stringify({ samples: [{ t: Date.now() - 60000, u: { fh: 42, sd: 7 } }] }));
  const fresh = planUsage.current();
  assert.strictEqual(fresh.fiveHourPct, 42);
  assert.strictEqual(fresh.sevenDayPct, 7);
  assert.ok(fresh.ageMs >= 60000 && fresh.ageMs < 120000);

  planUsage.resetCache();
  fs.writeFileSync(file, JSON.stringify({ samples: [{ t: Date.now() - 3 * 3600 * 1000, u: { fh: 42, sd: 7 } }] }));
  assert.strictEqual(planUsage.current(), null);
  assert.strictEqual(planUsage.latestAnyAge().fiveHourPct, 42);
});

test('readModelIdFrom trusts the "model" field over mentions in text', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [] } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', content: [] } }),
    // A tool result that merely mentions other model ids, written last.
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'use claude-haiku-4-5-20251001 or claude-fable-5-1' }] } }),
    '',
  ].join('\n'));
  assert.strictEqual(modelDetector.readModelIdFrom(f), 'claude-opus-5');

  // No field at all → the loose match still helps.
  fs.writeFileSync(f, 'model=claude-haiku-4-5\n');
  assert.strictEqual(modelDetector.readModelIdFrom(f), 'claude-haiku-4-5');
  fs.writeFileSync(f, '');
  assert.strictEqual(modelDetector.readModelIdFrom(f), null);
});
