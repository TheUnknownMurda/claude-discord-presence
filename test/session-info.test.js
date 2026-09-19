'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sessionInfo = require('../src/session-info');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-test-'));
}

const userPrompt = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const userBlocks = (blocks) => JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } });
const toolResult = () => userBlocks([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]);
const assistant = (usage) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', usage } });

test('classifyLine counts only lines you actually typed', () => {
  assert.strictEqual(sessionInfo.classifyLine(userPrompt('hello')).prompt, 1);
  assert.strictEqual(sessionInfo.classifyLine(userPrompt('   ')).prompt, 0);
  assert.strictEqual(sessionInfo.classifyLine(userBlocks([{ type: 'text', text: 'hi' }])).prompt, 1);
  assert.strictEqual(sessionInfo.classifyLine(toolResult()).prompt, 0);
  // A prompt with an attached tool result is still a tool-result line.
  assert.strictEqual(sessionInfo.classifyLine(userBlocks([
    { type: 'tool_result', tool_use_id: 'x', content: 'ok' }, { type: 'text', text: 'and this' },
  ])).prompt, 0);
  // Sub-agent traffic isn't yours.
  const side = JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'x' } });
  assert.strictEqual(sessionInfo.classifyLine(side).prompt, 0);
  assert.strictEqual(sessionInfo.classifyLine('not json').prompt, 0);
  assert.strictEqual(sessionInfo.classifyLine('').prompt, 0);
});

test('classifyLine sums produced tokens but never cache reads', () => {
  const out = sessionInfo.classifyLine(assistant({
    input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000000, output_tokens: 5,
  }));
  assert.strictEqual(out.tokens, 115);
  assert.strictEqual(sessionInfo.classifyLine(assistant({})).tokens, 0);
});

test('countIncremental parses only what was appended', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'session.jsonl');
    fs.writeFileSync(f, [userPrompt('one'), toolResult(), assistant({ output_tokens: 7 }), ''].join('\n'));
    sessionInfo.resetCache();
    let c = sessionInfo.countIncremental(f, fs.statSync(f).size);
    assert.deepStrictEqual(c, { prompts: 1, tokens: 7 });

    // Append a half line, then finish it: the partial must not be miscounted.
    const line = userPrompt('two');
    fs.appendFileSync(f, line.slice(0, 10));
    c = sessionInfo.countIncremental(f, fs.statSync(f).size);
    assert.deepStrictEqual(c, { prompts: 1, tokens: 7 });
    fs.appendFileSync(f, line.slice(10) + '\n' + assistant({ input_tokens: 3 }) + '\n');
    c = sessionInfo.countIncremental(f, fs.statSync(f).size);
    assert.deepStrictEqual(c, { prompts: 2, tokens: 10 });

    // A rewritten (smaller) file is recounted from scratch.
    fs.writeFileSync(f, userPrompt('fresh') + '\n');
    c = sessionInfo.countIncremental(f, fs.statSync(f).size);
    assert.deepStrictEqual(c, { prompts: 1, tokens: null });
  } finally {
    sessionInfo.resetCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanBranch drops HEAD (detached / not a repo)', () => {
  assert.strictEqual(sessionInfo.cleanBranch('main'), 'main');
  assert.strictEqual(sessionInfo.cleanBranch('HEAD'), null);
  assert.strictEqual(sessionInfo.cleanBranch('  '), null);
  assert.strictEqual(sessionInfo.cleanBranch(null), null);
});

test('formatTokens renders compact figures', () => {
  assert.strictEqual(sessionInfo.formatTokens(0), '');
  assert.strictEqual(sessionInfo.formatTokens(950), '950');
  assert.strictEqual(sessionInfo.formatTokens(13247), '13.2k');
  assert.strictEqual(sessionInfo.formatTokens(2000000), '2M');
  assert.strictEqual(sessionInfo.formatTokens(2810000), '2.8M');
});

test('projectNameFromCwd and projectNameFromDir tolerate both separators', () => {
  assert.strictEqual(sessionInfo.projectNameFromCwd('C:\\dev\\my-app\\'), 'my-app');
  assert.strictEqual(sessionInfo.projectNameFromCwd('/home/me/dev/app'), 'app');
  assert.strictEqual(sessionInfo.projectNameFromDir('/x/projects/C--dev-my-app/s.jsonl'), 'dev-my-app');
});
