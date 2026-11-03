import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelMenu } from '../public/text-layout.js';

test('Model pickers recognize live Devin, Codex and Claude options without historical prose', () => {
  const devin = modelMenu('/ Type to search\n────\n  Claude Opus       ◼◼ Medium\n❭ Grok             ◼◼ Medium\n  Adaptive\n  ↓ more below\n↑↓ select · ←→ reasoning effort · ↵ confirm · esc cancel', 'devin');
  assert.equal(devin.options.length, 3); assert.equal(devin.selected, 1); assert.equal(devin.active, true);
  const codex = modelMenu('Select Model and Effort\n  1. Model A\n› 2. Model B (current)\nenter select · esc back', 'codex');
  assert.equal(codex.selected, 1); assert.equal(codex.options[0].label, 'Model A');
  const effort = modelMenu('Select Reasoning Effort\n› 1. Low\n  2. High\nenter select · esc back', 'codex');
  assert.equal(effort.active, true);
  const claude = modelMenu('Select model\n  1. Default\n❯ 2. Opus ✔\n↓ 3. Sonnet\nEnter to set as default · Esc to cancel', 'claude');
  assert.equal(claude.selected, 1); assert.equal(claude.options.length, 3);
  for (const text of ['We discussed Model A and Model B.', 'Model set to Grok', 'Select model\n1. A\n2. B']) assert.equal(modelMenu(text, 'codex').active, false);
});

test('Devin option identity survives focus arrows added around the effort control', () => {
  const before = modelMenu('/ Type to search\n❭ Adaptive\n  Grok    ◼◼ Medium\n↑↓ select · esc cancel', 'devin');
  const after = modelMenu('/ Type to search\n  Adaptive\n❭ Grok ← ◼◼ → Medium\n↑↓ select · esc cancel', 'devin');
  assert.equal(before.options[1].id, after.options[1].id);
});
