import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';
import { chromium } from 'playwright-core';
import { createBootstrap } from '../device-auth.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, browserTest = false) {
  const directory = mkdtempSync(join(tmpdir(), 'herdr-device-api-'));
  const credentials = join(directory, 'credentials.json'), authDirectory = join(directory, 'authorization');
  writeFileSync(credentials, JSON.stringify({ browserPassword: 'synthetic-password', clientToken: 'synthetic-client' }), { mode: 0o600 });
  let server, proxy, origin = 'https://relay.example.com', base, port;
  if (browserTest) {
    const cert = join(directory, 'cert.pem'), key = join(directory, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    proxy = https.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
      const upstream = http.request({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
      upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
    });
    proxy.on('upgrade', (req, socket, head) => {
      const upstream = net.connect(port, '127.0.0.1', () => {
        upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${Object.entries(req.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
      });
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    origin = `https://127.0.0.1:${proxy.address().port}`;
  }
  async function stop() {
    if (server && server.exitCode === null) { server.kill(); await Promise.race([once(server, 'exit'), delay(1000)]); }
  }
  async function start() {
    await stop();
    server = spawn(process.execPath, ['relay.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', PUBLIC_ORIGIN: origin, DEVICE_APPROVAL: '1', DEVICE_AUTH_DIR: authDirectory, CREDENTIALS_FILE: credentials } });
    let logs = ''; server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs += b);
    for (let i = 0; i < 100 && !/listening on (\d+)/.test(logs); i++) await delay(20);
    assert.match(logs, /listening on (\d+)/); port = Number(/listening on (\d+)/.exec(logs)[1]); base = `http://127.0.0.1:${port}`;
  }
  t.after(async () => { await stop(); proxy?.closeAllConnections(); proxy?.close(); rmSync(directory, { recursive: true, force: true }); });
  await start();
  const cookie = jar => Object.entries(jar).map(([key,value]) => `${key}=${value}`).join('; ');
  async function api(jar, path, body, overrides = {}) {
    const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, Cookie: cookie(jar), ...overrides }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const line of res.headers.getSetCookie()) { const [key,value] = line.split(';')[0].split('='); if (value) jar[key] = value; else delete jar[key]; }
    return { status: res.status, data: await res.json() };
  }
  const login = (jar, extra = {}) => api(jar, '/api/login', { password: 'synthetic-password', deviceName: 'Browser', ...extra });
  const register = async () => {
    const res = await api({}, '/api/client/register', { id: 'fixture', capabilities: ['mobile-v1'] }, { Authorization: 'Bearer synthetic-client' }); assert.equal(res.status, 200);
    return res.data.generation;
  };
  const socket = jar => new WebSocket(base.replace('http:', 'ws:') + '/terminal?id=fixture&mode=mobile', { headers: { Origin: origin, Cookie: cookie(jar) } });
  return { directory, authDirectory, origin, api, login, register, socket, restart: start };
}

test('Only approved browsers can access HTTP/WebSocket; trust survives restart and revocation closes access', { timeout: 20000 }, async t => {
  const f = await fixture(t), applicant = {}, owner = {};
  assert.equal((await f.api({}, '/api/auth/config')).data.deviceApproval, true);
  assert.equal((await f.api({}, '/api/clients')).status, 401);
  const waiting = await f.login(applicant, { deviceName: 'Phone' });
  assert.equal(waiting.status, 202); assert.match(waiting.data.code, /^\d{6}$/);
  assert.equal(applicant.herdr_session, undefined);
  assert.equal((await f.api(applicant, '/api/clients')).status, 401);
  assert.equal((await f.api(applicant, '/api/auth/devices')).status, 401);
  assert.equal((await f.api(applicant, '/api/auth/request')).data.status, 'pending');
  await f.register();
  const denied = f.socket(applicant); denied.on('error', () => {});
  assert.equal(await new Promise(resolve => denied.on('unexpected-response', (_, res) => { res.resume(); denied.terminate(); resolve(res.statusCode); })), 401);
  const code = createBootstrap(f.authDirectory, 'Owner');
  assert.equal((await f.login(owner, { password: 'wrong', bootstrapCode: code })).status, 401);
  assert.equal((await f.login(owner, { bootstrapCode: code })).status, 200);
  assert.equal((await f.login({}, { bootstrapCode: code })).status, 400);
  const listed = await f.api(owner, '/api/auth/devices');
  assert.equal(listed.data.devices.length, 1); assert.equal(listed.data.requests.length, 1);
  assert.equal(JSON.stringify(listed.data).includes('tokenHash'), false);
  const pending = listed.data.requests[0];
  const approval = { requestId: pending.id, code: pending.code, approve: true };
  assert.equal((await f.api(applicant, '/api/auth/decide', approval)).status, 401);
  assert.equal((await f.api(owner, '/api/auth/decide', approval, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.api(owner, '/api/auth/decide', approval)).status, 200);
  assert.equal((await f.api(applicant, '/api/auth/request')).data.status, 'approved');
  assert.ok(applicant.herdr_device); assert.ok(applicant.herdr_session);
  assert.equal((await f.api(applicant, '/api/clients')).status, 200);
  const rejected = {}; await f.login(rejected, { deviceName: 'Rejected' });
  const rejection = (await f.api(owner, '/api/auth/devices')).data.requests[0];
  await f.api(owner, '/api/auth/decide', { requestId: rejection.id, code: rejection.code, approve: false });
  assert.equal((await f.api(rejected, '/api/auth/request')).data.status, 'denied');
  assert.equal((await f.api(rejected, '/api/clients')).status, 401);
  await f.restart(); delete applicant.herdr_session; delete owner.herdr_session;
  assert.equal((await f.api(applicant, '/api/clients')).status, 200, 'Persistent device cookie creates a new short-lived login session');
  assert.equal((await f.api(owner, '/api/clients')).status, 200);
  await f.register();
  const ws = f.socket(applicant); t.after(() => ws.terminate()); await once(ws, 'open');
  const data = (await f.api(owner, '/api/auth/devices')).data;
  const phone = data.devices.find(d => d.name === 'Phone');
  const closed = once(ws, 'close');
  assert.equal((await f.api(owner, '/api/auth/revoke', { deviceId: phone.id, confirmed: true })).status, 200);
  assert.equal((await closed)[0], 1008);
  assert.equal((await f.api(applicant, '/api/clients')).status, 401);
  const staleOwner = { ...owner };
  assert.equal((await f.api(owner, '/api/logout', {})).status, 200);
  assert.equal(owner.herdr_device, undefined);
  assert.equal((await f.api(staleOwner, '/api/clients')).status, 401, 'Logout forgets this browser and prevents automatic relogin');
  const recovery = createBootstrap(f.authDirectory, 'Recovered owner');
  assert.equal((await f.login({}, { bootstrapCode: recovery })).status, 200);
});

test('Browser pairing, approval UI, automatic login and revocation work across separate browsers', { timeout: 30000 }, async t => {
  const f = await fixture(t, true);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  // Only this isolated test proxy uses a self-signed certificate.
  const ownerContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const phoneContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const owner = await ownerContext.newPage(), phone = await phoneContext.newPage();
  const errors = []; owner.on('pageerror', e => errors.push(e.message)); phone.on('pageerror', e => errors.push(e.message));
  owner.on('dialog', dialog => dialog.accept());
  await owner.goto(f.origin);
  await owner.locator('#deviceLoginFields').waitFor();
  await owner.locator('#password').fill('synthetic-password');
  await owner.locator('#deviceLoginFields summary').click();
  await owner.locator('#bootstrapCode').fill(createBootstrap(f.authDirectory, 'iMac'));
  await owner.locator('#loginForm button').click();
  await owner.locator('#workspace').waitFor();
  await phone.goto(f.origin);
  await phone.locator('#deviceLoginFields').waitFor();
  await phone.locator('#password').fill('synthetic-password');
  const phoneName = '<img src=x onerror=alert(1)> Phone';
  await phone.locator('#deviceName').fill(phoneName);
  await phone.locator('#loginForm button').click();
  await phone.locator('#approvalWaiting').waitFor();
  assert.equal(await phone.locator('#workspace').isVisible(), false);
  const pairing = await phone.locator('#approvalCode').textContent();
  await owner.locator('#approvalNotice').click();
  assert.equal(await owner.locator('#deviceRequests code').textContent(), pairing);
  assert.equal(await owner.locator('#deviceDialog img').count(), 0);
  await owner.getByRole('button', { name: '同意此瀏覽器' }).click();
  await phone.locator('#workspace').waitFor();
  assert.equal((await phoneContext.cookies()).filter(c => ['herdr_device','herdr_session'].includes(c.name)).every(c => c.secure && c.httpOnly), true);
  assert.equal(await phone.evaluate(() => document.cookie.includes('herdr_device')), false);
  await phone.reload(); await phone.locator('#workspace').waitFor();
  assert.equal(await phone.locator('#login').isVisible(), false);
  const thirdContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const third = await thirdContext.newPage(); await third.goto(f.origin);
  await third.locator('#deviceLoginFields').waitFor();
  assert.equal(await third.locator('#workspace').isVisible(), false, 'Same IP does not confer trust');
  const row = owner.locator('#trustedBrowsers article').filter({ hasText: phoneName });
  await row.getByRole('button', { name: '撤銷信任' }).click();
  await phone.locator('#login').waitFor();
  assert.equal(await phone.locator('#workspace').isVisible(), false);
  assert.deepEqual(errors, []);
});
