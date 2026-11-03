import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paneDisplayText, reflowText, sortPanes } from '../public/text-layout.js';

test('Smart reading hides working output without hiding approvals or changing raw views', () => {
  const raw = 'Intermediate tool output\nMore intermediate output';
  assert.match(paneDisplayText(raw, 'reflow', 'working'), /^Working…/);
  assert.ok(!paneDisplayText(raw, 'reflow', 'working').includes('Intermediate'));
  for (const layout of ['lines', 'raw']) assert.equal(paneDisplayText(raw, layout, 'working'), raw);
  for (const status of ['blocked', 'idle', 'done', 'unknown', undefined]) {
    assert.equal(paneDisplayText('Approve this operation?', 'reflow', status), 'Approve this operation?');
  }
  assert.equal(paneDisplayText('Final reply\ncontinued.', 'reflow', 'done'), 'Final reply continued.');
});

test('Reflows terminal-width prose while retaining paragraphs, lists and code', () => {
  assert.equal(reflowText('This sentence was split\nby an agent UI.\n\nAnother paragraph.'), 'This sentence was split by an agent UI.\n\nAnother paragraph.');
  assert.equal(reflowText('這段文字原本\n被終端切開。'), '這段文字原本被終端切開。');
  const structured = '```js\nconst x = 1;\n  use(x);\n```\n\n- first\n- second\n\n| a | b |\n| 1 | 2 |';
  assert.equal(reflowText(structured), structured);
  assert.equal(reflowText('    preserve_indent()\n    and_this()'), '    preserve_indent()\n    and_this()');
});

test('Sorting uses observed output timestamps, then historical completion order', () => {
  const panes = [
    { id: 'w1:p1', title: 'Alpha', status: 'idle', lastOutputAt: 0, completionSeq: 5 },
    { id: 'w1:p2', title: 'Beta', status: 'blocked', lastOutputAt: 100, completionSeq: 6 },
    { id: 'w1:p3', title: 'Gamma', status: 'working', lastOutputAt: 200, completionSeq: 0 },
  ];
  assert.deepEqual(sortPanes(panes).map(p => p.id), ['w1:p3', 'w1:p2', 'w1:p1']);
  assert.equal(sortPanes(panes, 'attention')[0].id, 'w1:p2');
  assert.equal(sortPanes(panes, 'name')[0].id, 'w1:p1');
  assert.equal(panes[0].id, 'w1:p1');
  assert.equal(sortPanes(panes.map(p => ({ ...p, lastOutputAt: 0 })))[0].id, 'w1:p2');
});
