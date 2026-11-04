import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentPrompt } from '../public/text-layout.js';

test('Agent prompts parse Claude and Codex live questions', () => {
  const claude = agentPrompt(`╭──────────────╮
│ Bash command │
│   rm -rf build │
│ Do you want to proceed? │
│ ❯ 1. Yes │
│   2. Yes, and don't ask again for rm commands │
│   3. No, and tell Claude what to do differently (esc) │
╰──────────────╯`);
  assert.equal(claude.active, true);
  assert.equal(claude.selected, 0);
  assert.deepEqual(claude.options.map(o => o.label), ['Yes', "Yes, and don't ask again for rm commands", 'No, and tell Claude what to do differently (esc)']);
  assert.match(claude.question, /Do you want to proceed\?/);
  assert.match(claude.question, /rm -rf build/);

  const ask = agentPrompt(`☐ Approach

Which database should we use?

  1. Postgres
     Relational, mature
❯ 2. SQLite
     Single file
  3. Type something.
────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`);
  assert.equal(ask.selected, 1);
  assert.equal(ask.options.length, 4);
  assert.equal(ask.options[0].detail, 'Relational, mature');
  assert.match(ask.question, /Which database/);

  const codex = agentPrompt(`Would you like to run the following command?
  $ npm test
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for this command (p)
  3. No, and tell Codex what to do differently (esc)
Press enter to confirm or esc to cancel`);
  assert.equal(codex.selected, 0); assert.equal(codex.options.length, 3);
  assert.match(codex.question, /npm test/);
});

test('Plain numbered prose or lists without one cursor are not prompts', () => {
  assert.equal(agentPrompt('Plan:\n1. Read files\n2. Write tests\n3. Ship').active, false);
  assert.equal(agentPrompt('❯ 1. Only one option').active, false);
  assert.equal(agentPrompt('').active, false);
  // The latest menu wins over an older answered one still on screen.
  const latest = agentPrompt('❯ 1. Old\n  2. Older\n\nanswer…\n\nNew question?\n  1. A\n❯ 2. B');
  assert.deepEqual([latest.selected, latest.options[1].label], [1, 'B']);
  assert.match(latest.question, /New question\?$/); assert.doesNotMatch(latest.question, /Old/);
});
