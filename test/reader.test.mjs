import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('Reader expands output and composer without reconnecting or losing drafts', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-reader-test-'));
  const creds = join(dir, 'credentials.json');
  writeFileSync(creds, JSON.stringify({ browserPassword: 'reader-test', clientToken: 'reader-client-test' }), { mode: 0o600 });
  const server = spawn(process.execPath, ['relay.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', CREDENTIALS_FILE: creds } });
  let logs = '', browser;
  server.stdout.on('data', data => logs += data);
  t.after(async () => { await browser?.close(); server.kill(); await Promise.race([once(server, 'exit'), delay(1000)]); rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 100 && !/listening on (\d+)/.test(logs); i++) await delay(50);
  const base = `http://127.0.0.1:${/listening on (\d+)/.exec(logs)[1]}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let connections = 0, socket;
  const commands = [];
  await page.route('**/api/**', route => route.fulfill({ json: { clients: [{ id: 'reader', label: 'Reader test', mobile: true, mobileVersion: 2, online: true, terminal: true }] } }));
  await page.routeWebSocket('**/terminal?*', ws => {
    connections++; socket = ws;
    ws.onMessage(raw => {
      const m = JSON.parse(raw); if (m.type !== 'mobile') return;
      commands.push(m);
      const result = m.operation === 'panes' ? { panes: [{ id: 'p1', title: 'Example agent', status: 'idle' }] } : m.params?.view === 'conversation' ? { conversation: {
        agent: 'codex', sessionId: 'synthetic-test', readOnly: true, entries: [
          { id: '1', kind: 'user', text: '問題' }, { id: '2', kind: 'thinking', text: '思考摘要測試' },
          { id: '3', kind: 'tool', text: '<img src=x onerror=alert(1)>工具歷史' }, { id: '4', kind: 'assistant', text: '最後回答測試' },
        ],
      } } : { text: 'Example output\n'.repeat(100) };
      ws.send(JSON.stringify({ type: 'mobile', requestId: m.requestId, result }));
    });
  });
  await page.goto(base); await page.locator('#connect').click();
  await page.locator('.pane-card').waitFor();
  await page.locator('#conversationOutput article[data-kind="assistant"]').waitFor();
  const normalOutput = await page.locator('#outputScroll').boundingBox();
  const normalControls = await page.locator('#controls').boundingBox();
  assert.ok(normalOutput.y + normalOutput.height <= normalControls.y, 'Composer must not cover the bottom of the normal reader');
  await page.locator('#textLayout').selectOption('lines');
  await page.waitForFunction(() => document.getElementById('paneOutput').textContent.includes('Example output'));
  const outputFont = () => page.locator('#paneOutput').evaluate(el => getComputedStyle(el).fontSize);
  assert.equal(await outputFont(), '13px');
  await page.locator('#fontSmaller').click();
  assert.equal(await outputFont(), '12px');
  for (let i = 0; i < 4; i++) await page.locator('#fontSmaller').click();
  assert.equal(await outputFont(), '8px');
  assert.equal(await page.locator('#fontSmaller').isDisabled(), true);
  await page.locator('#fontReset').click();
  for (let i = 0; i < 11; i++) await page.locator('#fontLarger').click();
  assert.equal(await outputFont(), '24px');
  assert.equal(await page.locator('#fontLarger').isDisabled(), true);
  assert.equal(await page.locator('#prompt').evaluate(el => getComputedStyle(el).fontSize), '24px');
  await page.locator('#prompt').fill('Keep this unsent draft');
  await page.locator('#outputScroll').click({ position: { x: 20, y: 20 } });
  assert.equal(await page.locator('body').evaluate(e => e.classList.contains('reader-expanded')), true);
  assert.equal(await page.locator('#paneList').isVisible(), false);
  assert.equal(await page.locator('#fontLarger').isVisible(), true);
  await page.locator('#fontSmaller').click();
  assert.equal(await outputFont(), '23px');
  for (const size of [{ width: 390, height: 844 }, { width: 390, height: 440 }, { width: 1200, height: 900 }]) {
    await page.setViewportSize(size);
    await page.waitForFunction(() => Math.abs(document.getElementById('workspace').getBoundingClientRect().height - window.visualViewport.height) < 2);
    const output = await page.locator('#outputScroll').boundingBox(), controls = await page.locator('#controls').boundingBox();
    assert.ok(output.height > 40);
    assert.ok(output.y + output.height <= controls.y + 1);
    assert.ok(controls.y + controls.height <= size.height + 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.locator('#readerExpand').click();
  assert.equal(await page.locator('#paneList').isVisible(), true);
  assert.equal(await page.locator('#prompt').inputValue(), 'Keep this unsent draft');
  await page.locator('#textLayout').selectOption('conversation');
  await page.locator('#conversationOutput article[data-kind="assistant"]').waitFor();
  assert.equal(await page.locator('#conversationOutput details').count(), 2);
  assert.equal(await page.locator('#conversationOutput details[open]').count(), 0);
  assert.equal(await page.locator('#conversationOutput img').count(), 0);
  assert.equal(await page.locator('#sendPrompt').isDisabled(), false);
  assert.equal(await page.locator('#newWindow').isDisabled(), false);
  await page.locator('#sendPrompt').click();
  await page.waitForFunction(() => document.getElementById('prompt').value === '');
  assert.deepEqual(commands.filter(m => m.operation === 'prompt').map(m => m.params), [{ paneId: 'p1', text: 'Keep this unsent draft' }]);
  await page.locator('[data-key=enter]').click();
  assert.deepEqual(commands.filter(m => m.operation === 'key').map(m => m.params), [{ paneId: 'p1', key: 'enter' }]);
  await page.locator('#prompt').fill('Keep this unsent draft');
  await page.locator('#conversationOutput details summary').first().click();
  assert.equal(await page.locator('#conversationOutput details[open]').count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/herdr-conversation.png', fullPage: true });
  await page.locator('#textLayout').selectOption('lines');
  assert.equal(await page.locator('#sendPrompt').isDisabled(), false);
  assert.equal(await page.locator('#prompt').inputValue(), 'Keep this unsent draft');
  if (await page.locator('#readerExpand').getAttribute('aria-expanded') === 'true') await page.locator('#readerExpand').click();
  await page.locator('#outputScroll').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#readerExpand').getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#readerExpand').getAttribute('aria-expanded'), 'false');
  await page.locator('#readerExpand').click();
  socket.close({ code: 1000, reason: 'Test disconnection' });
  await page.waitForFunction(() => !document.body.classList.contains('reader-expanded'));
  assert.equal(await page.locator('#devicePanel').isVisible(), true);
  assert.equal(connections, 1);
  await page.reload();
  await page.locator('.pane-card').waitFor();
  assert.equal(await outputFont(), '23px');
  await page.locator('#fontReset').click();
  assert.equal(await outputFont(), '13px');
  assert.deepEqual(errors, []);
});
