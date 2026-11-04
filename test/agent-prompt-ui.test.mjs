import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Blocked agent questions can be answered from the page with separate confirm', { timeout: 60000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-agent-prompt-'));
  const creds = join(dir, 'credentials.json'); writeFileSync(creds, JSON.stringify({ browserPassword: 'test', clientToken: 'test' }), { mode: 0o600 });
  const server = spawn(process.execPath, ['relay.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', CREDENTIALS_FILE: creds } });
  let logs = '', browser; server.stdout.on('data', b => logs += b);
  t.after(async () => { await browser?.close(); server.kill(); await Promise.race([once(server, 'exit'), delay(1000)]); rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 100 && !/listening on (\d+)/.test(logs); i++) await delay(50);
  const base = `http://127.0.0.1:${/listening on (\d+)/.exec(logs)[1]}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const keys = [], panes = [{ id: 'p1', title: 'Claude', agent: 'claude', status: 'blocked' }, { id: 'p2', title: 'Idle', agent: 'codex', status: 'idle' }];
  let selected = 0, answered = null;
  const screen = () => answered !== null ? '❯ ' : `Bash command\n  rm -rf build\nDo you want to proceed?\n${['Yes', "Yes, and don't ask again", 'No (esc)'].map((label, i) => `${i === selected ? '❯' : ' '} ${i + 1}. ${label}`).join('\n')}`;
  await page.route('**/api/**', route => route.fulfill({ json: { clients: [{ id: 'test', label: 'Test', online: true, mobile: true, mobileVersion: 4 }] } }));
  await page.routeWebSocket('**/terminal?*', ws => ws.onMessage(raw => {
    const m = JSON.parse(raw); if (m.type !== 'mobile') return;
    let result = {};
    if (m.operation === 'panes') result = { panes };
    if (m.operation === 'read') result = m.params.view === 'menu' ? { view: 'menu', text: m.params.paneId === 'p1' ? screen() : '› ' } : { text: 'Ready' };
    if (m.operation === 'key') {
      keys.push(m.params.key);
      if (m.params.key === 'down') selected = Math.min(2, selected + 1);
      if (m.params.key === 'up') selected = Math.max(0, selected - 1);
      if (m.params.key === 'enter') { answered = selected; panes[0].status = 'working'; }
    }
    ws.send(JSON.stringify({ type: 'mobile', requestId: m.requestId, result }));
  }));
  await page.goto(base); await page.locator('#connect').click(); await page.locator('.pane-card').first().waitFor();
  await page.locator('#agentPrompt').waitFor();
  assert.match(await page.locator('#blockedCount').textContent(), /1 個等待回覆/);
  assert.match(await page.title(), /^\(1\)/);
  assert.match(await page.locator('#agentQuestion').textContent(), /rm -rf build[\s\S]*Do you want to proceed/);
  assert.equal(await page.locator('#agentOptions button').count(), 3);
  await page.locator('#agentOptions button').nth(2).click();
  await page.waitForFunction(() => document.querySelector('#agentOptions button[aria-pressed=true]')?.textContent.startsWith('3.'));
  assert.deepEqual(keys, ['down', 'down'], 'choosing only moves the cursor');
  await page.locator('#agentSubmit').click();
  await page.waitForFunction(() => document.querySelector('#sendStatus').textContent.includes('已回覆 agent'));
  assert.deepEqual(keys, ['down', 'down', 'enter']); assert.equal(answered, 2);
  await page.locator('#refreshPanes').click();
  await page.waitForFunction(() => document.querySelector('#agentPrompt').hidden, null, { timeout: 5000 });
  assert.equal(await page.title(), 'Herdr Remote');
  assert.deepEqual(errors, []);
});
