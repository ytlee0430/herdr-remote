import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Shift+Enter submits, context usage renders, Clear and Migration run in order', { timeout: 60000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-context-controls-'));
  const creds = join(dir, 'credentials.json'); writeFileSync(creds, JSON.stringify({ browserPassword: 'test', clientToken: 'test' }), { mode: 0o600 });
  const server = spawn(process.execPath, ['relay.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', CREDENTIALS_FILE: creds } });
  let logs = '', browser; server.stdout.on('data', b => logs += b);
  t.after(async () => { await browser?.close(); server.kill(); await Promise.race([once(server, 'exit'), delay(1000)]); rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 100 && !/listening on (\d+)/.test(logs); i++) await delay(50);
  const base = `http://127.0.0.1:${/listening on (\d+)/.exec(logs)[1]}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const prompts = [], panes = [{ id: 'p1', title: 'Claude', agent: 'claude', status: 'idle' }, { id: 'p2', title: 'Codex', agent: 'codex', status: 'idle' }];
  let statusQueue = [], busyPane = null;
  await page.route('**/api/**', route => route.fulfill({ json: { clients: [{ id: 'test', label: 'Test', online: true, mobile: true, mobileVersion: 4 }] } }));
  await page.routeWebSocket('**/terminal?*', ws => ws.onMessage(raw => {
    const m = JSON.parse(raw); if (m.type !== 'mobile') return;
    let result = {};
    if (m.operation === 'panes') { if (statusQueue.length) panes.find(p => p.id === busyPane).status = statusQueue.shift(); result = { panes }; }
    if (m.operation === 'context') result = { usage: { p1: { used: 50000, window: 200000, percent: 25, source: 'transcript' }, p2: { used: null, window: null, percent: 83, source: 'screen' } } };
    if (m.operation === 'prompt') { prompts.push(m.params); if (m.params.text.startsWith('Write a handover')) { busyPane = m.params.paneId; statusQueue = ['working', 'working', 'idle']; } }
    if (m.operation === 'read') result = { text: 'Ready' };
    ws.send(JSON.stringify({ type: 'mobile', requestId: m.requestId, result }));
  }));
  await page.goto(base); await page.locator('#connect').click(); await page.locator('.pane-card').first().waitFor();
  await page.waitForFunction(() => document.querySelector('#paneContext').textContent.includes('50k / 200k · 25%'));
  assert.match(await page.locator('.pane-card').nth(1).locator('.pane-context').textContent(), /已用 83%/);
  assert.equal(await page.locator('.pane-card').nth(1).locator('.pane-context.high').count(), 1);

  await page.locator('#prompt').fill('line one');
  await page.locator('#prompt').press('Enter');
  assert.equal(await page.locator('#prompt').inputValue(), 'line one\n', 'Enter keeps inserting a newline');
  assert.equal(prompts.length, 0);
  await page.locator('#prompt').press('Shift+Enter');
  await page.waitForFunction(() => document.querySelector('#prompt').value === '');
  assert.deepEqual(prompts.at(-1), { paneId: 'p1', text: 'line one\n' });

  await page.locator('#clearContext').click();
  assert.match(await page.locator('#contextExplain').textContent(), /\/clear/);
  await page.locator('#cancelContext').click();
  assert.equal(prompts.length, 1, 'cancel sends nothing');
  await page.locator('#clearContext').click(); await page.locator('#confirmContext').click();
  await page.waitForFunction(() => !document.querySelector('#contextDialog').open);
  assert.deepEqual(prompts.at(-1), { paneId: 'p1', text: '/clear' });

  await page.locator('.pane-card').nth(1).click();
  await page.locator('#migrateContext').click(); await page.locator('#confirmContext').click();
  await page.waitForFunction(() => !document.querySelector('#contextDialog').open, null, { timeout: 30000 });
  // p2 is Codex: the handover is written before /new, then read back.
  const sequence = prompts.slice(2).map(p => [p.paneId, p.text.split(' ').slice(0, 2).join(' ')]);
  assert.deepEqual(sequence, [['p2', 'Write a'], ['p2', '/new'], ['p2', 'Read .herdr/handover.md']]);
  assert.match(await page.locator('#sendStatus').textContent(), /Migration 完成/);

  panes[0].status = 'working'; await page.locator('.pane-card').first().click();
  await page.locator('#refreshPanes').click(); await delay(300);
  await page.locator('#clearContext').click(); await page.locator('#confirmContext').click();
  await page.waitForFunction(() => document.querySelector('#contextStatus').textContent.includes('正在工作'));
  assert.equal(prompts.length, 5, 'working agents are never cleared');
  assert.deepEqual(errors, []);
});
