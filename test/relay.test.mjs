import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { chromium } from 'playwright-core';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await delay(50); } throw new Error('Timed out waiting for condition'); }

test('Terminal palette replies are batched and disconnect reasons persist', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-palette-test-'));
  const credentials = join(dir, 'credentials.json');
  writeFileSync(credentials, JSON.stringify({ browserPassword: 'palette-browser', clientToken: 'palette-client' }), { mode: 0o600 });
  const server = spawn(process.execPath, ['relay.mjs'], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', CREDENTIALS_FILE: credentials } });
  let logs = '', browser;
  server.stdout.on('data', b => logs += b);
  server.stderr.on('data', b => logs += b);
  t.after(async () => { await browser?.close(); server.kill(); await Promise.race([once(server, 'exit'), delay(1000)]); rmSync(dir, { recursive: true, force: true }); });
  await until(() => /listening on (\d+)/.test(logs));
  const base = `http://127.0.0.1:${/listening on (\d+)/.exec(logs)[1]}`;
  const headers = { Authorization: 'Bearer palette-client', 'Content-Type': 'application/json' };
  const register = await fetch(base + '/api/client/register', { method: 'POST', headers, body: JSON.stringify({ id: 'palette' }) });
  headers['X-Client-Generation'] = (await register.json()).generation;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const inputs = [], notices = [];
  page.on('websocket', socket => {
    socket.on('framesent', frame => { const msg = JSON.parse(frame.payload); if (msg.type === 'input') inputs.push(msg.data); });
    socket.on('framereceived', frame => { const msg = JSON.parse(frame.payload); if (msg.type === 'notice') notices.push(msg.message); });
  });
  await page.goto(base);
  await page.locator('#password').fill('palette-browser');
  await page.locator('#loginForm button').click();
  await page.locator('#workspace').waitFor();
  await page.locator('#terminalMode').click();
  await page.locator('#connect').click();
  await until(() => page.locator('#statusDot').evaluate(el => el.classList.contains('online')));
  const polled = await (await fetch(base + '/api/client/poll?id=palette&ack=0', { headers })).json();
  const attach = polled.commands.find(c => c.type === 'attach');
  assert.ok(attach);
  // Deliberately do not acknowledge input commands: a slow VDI must still
  // survive the full 256-colour startup query without filling its queue.
  const query = Array.from({ length: 256 }, (_, i) => `\x1b]4;${i};?\x1b\\`).join('');
  const output = async data => {
    const res = await fetch(base + '/api/client/output?id=palette', { method: 'POST', headers, body: JSON.stringify({ attachId: attach.attachId, ...data }) });
    assert.equal(res.status, 200);
  };
  await output({ seq: 1, type: 'output', data: Buffer.from(query).toString('base64') });
  await until(() => inputs.join('').includes('\x1b]4;255;rgb:'));
  assert.equal((inputs.join('').match(/\x1b\]4;\d+;rgb:/g) || []).length, 256);
  assert.ok(inputs.length < 20, `Expected batching, received ${inputs.length} messages`);
  assert.deepEqual(notices, []);
  assert.equal(await page.locator('#statusDot').evaluate(el => el.classList.contains('online')), true);
  // Verify ordinary keystrokes still pass through after negotiation.
  await page.locator('[data-key="enter"]').click();
  await until(() => inputs.at(-1) === '\r');
  await output({ seq: 2, type: 'exit', message: 'Diagnostic disconnect reason' });
  await until(async () => (await page.locator('#connectionStatus').textContent()).includes('Diagnostic disconnect reason'));
  await delay(5500);
  assert.match(await page.locator('#connectionStatus').textContent(), /Diagnostic disconnect reason/);
});

test('Authenticated relay, real Python PTY, resize, reconnect and isolation', { timeout: 40000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-relay-test-'));
  const credentials = join(dir, 'credentials.json'), tokenFile = join(dir, 'token');
  writeFileSync(credentials, JSON.stringify({ browserPassword: 'test-browser-password', clientToken: 'test-client-token' }), { mode: 0o600 });
  writeFileSync(tokenFile, 'test-client-token', { mode: 0o600 });
  const fixture = join(dir, 'herdr-fixture');
  writeFileSync(fixture, '#!/bin/sh\nif [ "$1" = "pane" ] && [ "$2" = "list" ]; then\n  printf \'{"result":{"panes":[]}}\\n\'\nelse\n  exec /bin/sh\nfi\n', { mode: 0o700 });
  const server = spawn(process.execPath, ['relay.mjs'], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', CREDENTIALS_FILE: credentials } });
  let logs = ''; server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
  let client, ws, other, browser;
  t.after(async () => {
    await browser?.close();
    ws?.terminate(); other?.terminate();
    if (client && client.exitCode === null) { client.kill('SIGINT'); await Promise.race([once(client, 'exit'), delay(3000)]); if (client.exitCode === null) client.kill('SIGKILL'); }
    server.kill(); await Promise.race([once(server, 'exit'), delay(1000)]);
    rmSync(dir, { recursive: true, force: true });
  });
  await until(() => /listening on (\d+)/.test(logs));
  const base = `http://127.0.0.1:${/listening on (\d+)/.exec(logs)[1]}`;
  const req = (path, options) => fetch(base + path, options);
  assert.equal((await req('/health')).status, 200);
  assert.equal((await req('/api/clients')).status, 401);
  assert.equal((await req('/.credentials.json')).status, 401);
  assert.equal((await req('/client.py')).status, 200);
  assert.equal((await req('/api/client/register', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await req('/api/login', { method: 'POST', body: JSON.stringify({ password: 'test-browser-password' }) })).status, 403);
  const login = await req('/api/login', { method: 'POST', headers: { Origin: base }, body: JSON.stringify({ password: 'test-browser-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: base };
  let clientLog = '';
  client = spawn('python3', ['client.py', '--server', base, '--token-file', tokenFile, '--herdr', fixture, '--id', 'test-vdi'], { env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' } });
  client.stdout.on('data', b => { clientLog += b; }); client.stderr.on('data', b => { clientLog += b; });
  await until(async () => { const data = await (await req('/api/clients', { headers })).json(); return data.clients.some(c => c.online); });
  const unauthorized = new WebSocket(base.replace('http:', 'ws:') + '/terminal?id=test-vdi', { origin: base });
  const rejected = await new Promise(resolve => { unauthorized.on('unexpected-response', (_, response) => { response.resume(); unauthorized.terminate(); resolve(response.statusCode); }); unauthorized.on('error', () => {}); });
  assert.equal(rejected, 401);
  let output = '';
  function connect() {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/terminal?id=test-vdi', { headers });
    socket.on('error', () => {});
    socket.on('message', raw => { const msg = JSON.parse(raw); if (msg.type === 'output') { output += Buffer.from(msg.data, 'base64').toString(); socket.send(JSON.stringify({ type: 'ack', seq: msg.seq })); } });
    return socket;
  }
  ws = connect(); await once(ws, 'open');
  await until(() => output.length > 0);
  ws.send(JSON.stringify({ type: 'resize', cols: 110, rows: 37 }));
  ws.send(JSON.stringify({ type: 'input', data: "printf '\\110\\105\\122\\104\\122\\137\\117\\113\\n'; stty size\r" }));
  await until(() => output.includes('HERDR_OK') && /37 110/.test(output));
  other = new WebSocket(base.replace('http:', 'ws:') + '/terminal?id=test-vdi', { headers });
  const busy = await new Promise(resolve => { other.on('unexpected-response', (_, response) => { response.resume(); other.terminate(); resolve(response.statusCode); }); other.on('error', () => {}); });
  assert.equal(busy, 409);
  ws.close(); await once(ws, 'close');
  await until(async () => !(await (await req('/api/clients', { headers })).json()).clients[0].busy);
  output = ''; ws = connect(); await once(ws, 'open');
  await until(() => output.length > 0);
  ws.send(JSON.stringify({ type: 'input', data: "printf '\\122\\105\\103\\117\\116\\116\\105\\103\\124\\105\\104\\n'\r" }));
  await until(() => output.includes('RECONNECTED'));
  const closed = once(ws, 'close');
  assert.equal((await req('/api/logout', { method: 'POST', headers, body: '{}' })).status, 200);
  await closed;
  assert.equal((await req('/api/clients', { headers })).status, 401);
  assert.match(clientLog, /Connected/);
  // Use an installed browser; no download or external website is needed.
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let browserOutput = '', resizeSent = false;
  page.on('websocket', socket => {
    socket.on('framereceived', frame => {
      const msg = JSON.parse(frame.payload.toString());
      if (msg.type === 'output') browserOutput += Buffer.from(msg.data, 'base64').toString();
    });
    socket.on('framesent', frame => { if (JSON.parse(frame.payload.toString()).type === 'resize') resizeSent = true; });
  });
  await page.goto(base);
  await page.locator('#password').fill('test-browser-password');
  await page.locator('#loginForm button').click();
  await page.locator('#terminalMode').click();
  await page.locator('#connect').click();
  await until(() => browserOutput.length > 0);
  await page.locator('#prompt').fill("printf '\\115\\117\\102\\111\\114\\105\\137\\117\\113\\n'");
  await page.locator('#promptForm button').click();
  await until(() => browserOutput.includes('MOBILE_OK'));
  assert.equal(resizeSent, true);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/herdr-remote-mobile.png', fullPage: true });
  await page.locator('#devicePanel summary').click();
  await page.locator('#disconnect').click();
});
