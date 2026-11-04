import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { DeviceAuth, REQUEST_SECONDS } from './device-auth.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicOrigin = process.env.PUBLIC_ORIGIN || '';
if (publicOrigin) {
  const parsed = new URL(publicOrigin);
  if (parsed.protocol !== 'https:' || parsed.origin !== publicOrigin) throw Error('PUBLIC_ORIGIN must be an exact HTTPS origin without a trailing slash');
}
const secureCookie = publicOrigin ? '; Secure' : '';
const approvalEnabled = process.env.DEVICE_APPROVAL === '1';
if (approvalEnabled && !publicOrigin) throw Error('Device approval requires HTTPS PUBLIC_ORIGIN');
const deviceAuth = approvalEnabled ? new DeviceAuth(process.env.DEVICE_AUTH_DIR || root + '.device-auth') : null;

const secretPath = process.env.CREDENTIALS_FILE || root + '.credentials.json';
if (!existsSync(secretPath)) writeFileSync(secretPath, JSON.stringify({
  browserPassword: randomBytes(24).toString('base64url'),
  clientToken: randomBytes(32).toString('base64url'),
}, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const secrets = JSON.parse(readFileSync(secretPath));
const clients = new Map(), sessions = new Map(), attempts = new Map();
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const online = c => Date.now() - c.seen < 45000;
const summary = () => [...clients.values()].map(c => ({ id: c.id, label: c.label, online: online(c), busy: !!c.viewer, mobile: c.mobile, mobileVersion: c.mobileVersion, target: c.target, terminal: c.terminal }));
function requestCookie(req, name) {
  return new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(req.headers.cookie || '')?.[1];
}
function setCookie(res, name, value, maxAge) {
  const previous = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : [previous]), `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie}`]);
}
function validSession(token) {
  const state = sessions.get(token);
  if (!state || state.expires <= Date.now()) { sessions.delete(token); return false; }
  if (deviceAuth) {
    try { if (!state.deviceId || !deviceAuth.get(state.deviceId)) { sessions.delete(token); return false; } }
    catch { return false; } // Fail closed if the authorization database is unavailable.
  }
  return true;
}
function issueSession(res, device) {
  for (const token of sessions.keys()) if (!validSession(token)) sessions.delete(token);
  if (device) {
    // Concurrent tabs may renew together; keep a small overlap without letting
    // one remembered browser exhaust the global login-session budget.
    const previous = [...sessions].filter(([, state]) => state.deviceId === device.id);
    while (previous.length >= 4) {
      const [expired] = previous.shift(); sessions.delete(expired);
      for (const ws of wss.clients) if (ws.sessionToken === expired) ws.close(1000, 'Session renewed');
    }
  }
  if (sessions.size >= 256) throw Error('登入數量已達上限，請稍後再試');
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, { expires: Date.now() + 12 * 3600000, deviceId: device?.id || null });
  setCookie(res, 'herdr_session', token, 43200);
  return token;
}
function session(req, res) {
  const token = requestCookie(req, 'herdr_session');
  if (validSession(token)) return token;
  if (deviceAuth && res) {
    const device = deviceAuth.fromToken(requestCookie(req, 'herdr_device'));
    if (device) return issueSession(res, device);
  }
  return null;
}
function enrollBrowser(res, enrollment) {
  setCookie(res, 'herdr_device', enrollment.token, Math.max(0, Math.floor((enrollment.device.expiresAt - Date.now()) / 1000)));
  setCookie(res, 'herdr_pending', '', 0);
  issueSession(res, enrollment.device);
}
function revokeDevice(id) {
  deviceAuth.revoke(id);
  for (const [token, state] of sessions) if (state.deviceId === id) {
    sessions.delete(token);
    for (const ws of wss.clients) if (ws.sessionToken === token) ws.close(1008, 'Browser authorization revoked');
  }
}
function sameOrigin(req) { return publicOrigin ? req.headers.origin === publicOrigin : req.headers.origin === `http://${req.headers.host}` || req.headers.origin === `https://${req.headers.host}`; }
function send(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) {
    if (ws.bufferedAmount > 1024 * 1024) return ws.close(1013, 'Slow connection; reconnect');
    ws.send(JSON.stringify(data));
  }
}
function wake(c) { c.waiter?.(); }
function queue(c, command) {
  if (c.commands.length >= 256) throw new Error('Input queue full; reconnect');
  c.commands.push({ ...command, seq: ++c.seq }); wake(c);
}
function detach(c) {
  c.viewer = null;
  c.attachId = null;
  // Drop stale keystrokes when the controlling browser leaves.
  c.commands = [];
  queue(c, { type: 'detach' });
}
async function body(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 128 * 1024) throw new Error('Request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
const files = new Map([
  ['/', ['public/mobile.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/mobile.js', 'text/javascript']],
  ['/text-layout.js', ['public/text-layout.js', 'text/javascript']],
  ['/controls.css', ['public/controls.css', 'text/css']],
  ['/style.css', ['public/mobile.css', 'text/css']],
  ['/vendor/xterm.js', ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript']],
  ['/vendor/xterm.css', ['node_modules/@xterm/xterm/css/xterm.css', 'text/css']],
  ['/vendor/fit.js', ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript']],
  ['/client.py', ['client.py', 'text/plain; charset=utf-8']],
]);
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'herdr-remote' });
    if (req.method === 'GET' && files.has(url.pathname)) {
      const [file, type] = files.get(url.pathname);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); return res.end(readFileSync(root + file));
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/config') return json(res, 200, { deviceApproval: approvalEnabled, trustDays: 90 });
    if (deviceAuth && url.pathname === '/api/auth/request') {
      if (req.method === 'POST') {
        if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid origin' });
        deviceAuth.cancel(requestCookie(req, 'herdr_pending')); setCookie(res, 'herdr_pending', '', 0);
        return json(res, 200, { status: 'cancelled' });
      }
      if (req.method === 'GET') {
        const state = deviceAuth.status(requestCookie(req, 'herdr_pending'));
        if (state.status === 'approved') enrollBrowser(res, state.enrollment);
        else if (state.status !== 'pending') setCookie(res, 'herdr_pending', '', 0);
        return json(res, 200, { status: state.status, code: state.code, name: state.name, expiresAt: state.expiresAt });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid origin' });
      const key = req.socket.remoteAddress;
      const attempt = attempts.get(key) || { count: 0, until: Date.now() + 60000 };
      if (attempt.until < Date.now()) { attempt.count = 0; attempt.until = Date.now() + 60000; }
      attempts.set(key, attempt);
      if (++attempt.count > 10) return json(res, 429, { error: 'Too many attempts; wait a minute' });
      const data = await body(req);
      if (!equal(data.password, secrets.browserPassword)) return json(res, 401, { error: '密碼不正確' });
      if (deviceAuth) {
        let enrollment;
        if (data.bootstrapCode) enrollment = deviceAuth.bootstrap(data.bootstrapCode, req.headers['user-agent']);
        else {
          const trusted = deviceAuth.fromToken(requestCookie(req, 'herdr_device'));
          if (trusted) {
            const old = session(req); if (old) sessions.delete(old);
            issueSession(res, trusted); return json(res, 200, { ok: true });
          }
        }
        if (enrollment) { enrollBrowser(res, enrollment); return json(res, 200, { ok: true }); }
        const pending = deviceAuth.request(requestCookie(req, 'herdr_pending'), data.deviceName, req.headers['user-agent']);
        setCookie(res, 'herdr_pending', pending.token, REQUEST_SECONDS);
        return json(res, 202, { status: 'pending', code: pending.request.code, name: pending.request.name, expiresAt: pending.request.expiresAt });
      }
      issueSession(res);
      return json(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/client/')) {
      if (!equal(req.headers.authorization, `Bearer ${secrets.clientToken}`)) return json(res, 401, { error: 'Invalid client token' });
      if (url.pathname === '/api/client/register' && req.method === 'POST') {
        const data = await body(req);
        if (!/^[a-zA-Z0-9_-]{1,48}$/.test(data.id || '')) return json(res, 400, { error: 'Invalid client id' });
        const old = clients.get(data.id);
        if (old && online(old)) return json(res, 409, { error: 'Client already connected; wait 45 seconds after stopping it' });
        old?.viewer?.close(1012, 'Client reconnecting');
        if (clients.size >= 32 && !old) return json(res, 429, { error: 'Client limit reached' });
        const c = { id: data.id, label: String(data.label || data.id).slice(0, 80), target: String(data.target || 'session: default').slice(0, 120), terminal: data.terminal !== false, mobile: Array.isArray(data.capabilities) && data.capabilities.includes('mobile-v1'), generation: randomBytes(16).toString('hex'), seen: Date.now(), commands: [], seq: 0, outputSeq: 0, viewer: null, attachId: null };
        c.mobileVersion = data.capabilities?.includes('mobile-v4') ? 4 : data.capabilities?.includes('mobile-v3') ? 3 : data.capabilities?.includes('mobile-v2') ? 2 : c.mobile ? 1 : 0;
        clients.set(c.id, c); return json(res, 200, { generation: c.generation });
      }
      const c = clients.get(url.searchParams.get('id'));
      if (!c || !equal(req.headers['x-client-generation'], c.generation)) return json(res, 409, { error: 'Register again' });
      c.seen = Date.now();
      if (url.pathname === '/api/client/poll' && req.method === 'GET') {
        const ack = Number(url.searchParams.get('ack'));
        if (!Number.isSafeInteger(ack) || ack < 0 || ack > c.seq) return json(res, 400, { error: 'Invalid acknowledgement' });
        c.commands = c.commands.filter(cmd => cmd.seq > ack);
        if (!c.commands.length) await new Promise(resolve => {
          const done = () => { clearTimeout(timer); if (c.waiter === done) c.waiter = null; res.off('close', done); resolve(); };
          const timer = setTimeout(done, 15000); c.waiter = done; res.on('close', done);
        });
        if (!res.destroyed) json(res, 200, { commands: c.commands });
        return;
      }
      if (url.pathname === '/api/client/output' && req.method === 'POST') {
        const data = await body(req);
        if (!Number.isSafeInteger(data.seq) || data.seq < 1) return json(res, 400, { error: 'Invalid output sequence' });
        if (data.seq > c.outputSeq + 1) return json(res, 409, { error: 'Output sequence gap' });
        if (data.seq > c.outputSeq) {
          c.outputSeq = data.seq;
          if (data.attachId === c.attachId && c.viewer) {
            if (data.type === 'output' && typeof data.data === 'string' && data.data.length <= 64000) {
              c.viewer.pendingOutput.set(data.seq, data.data.length);
              c.viewer.pendingBytes += data.data.length;
              if (c.viewer.pendingBytes > 1024 * 1024) c.viewer.close(1013, 'Display too slow; reconnect to redraw');
              else send(c.viewer, { type: 'output', data: data.data, seq: data.seq });
            }
            else if (data.type === 'mobile') send(c.viewer, { type: 'mobile', requestId: data.requestId, operation: data.operation, result: data.result, error: data.error });
            else if (data.type === 'exit') { send(c.viewer, { type: 'notice', message: data.message || 'herdr 已離開，請重新連線' }); c.viewer.close(1000, 'Terminal exited'); }
          }
        }
        return json(res, 200, { ack: c.outputSeq });
      }
      return json(res, 404, { error: 'Not found' });
    }
    const token = session(req, res);
    if (!token) return json(res, 401, { error: '請先登入' });
    if (req.method === 'GET' && url.pathname === '/api/clients') return json(res, 200, { clients: summary(), deviceApproval: approvalEnabled });
    if (deviceAuth && url.pathname === '/api/auth/devices' && req.method === 'GET') return json(res, 200, { devices: deviceAuth.list(), requests: deviceAuth.pending(), currentDeviceId: sessions.get(token).deviceId });
    if (deviceAuth && req.method === 'POST' && ['/api/auth/decide', '/api/auth/revoke'].includes(url.pathname)) {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid origin' });
      const data = await body(req);
      if (url.pathname === '/api/auth/decide') {
        if (typeof data.approve !== 'boolean') return json(res, 400, { error: 'Invalid decision' });
        deviceAuth.decide(data.requestId, data.code, data.approve, sessions.get(token).deviceId);
      } else {
        if (data.confirmed !== true) return json(res, 400, { error: '請確認要撤銷的瀏覽器' });
        const self = sessions.get(token).deviceId === data.deviceId;
        revokeDevice(data.deviceId);
        if (self) { setCookie(res, 'herdr_device', '', 0); setCookie(res, 'herdr_session', '', 0); }
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid origin' });
      if (deviceAuth) { revokeDevice(sessions.get(token).deviceId); setCookie(res, 'herdr_device', '', 0); setCookie(res, 'herdr_pending', '', 0); }
      sessions.delete(token);
      for (const ws of wss.clients) if (ws.sessionToken === token) ws.close(1000, 'Logged out');
      setCookie(res, 'herdr_session', '', 0);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'Not found' });
  } catch (error) { if (!res.headersSent) json(res, 400, { error: error.message }); else res.end(); }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const token = session(req);
  if (!token || !sameOrigin(req)) return socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  const url = new URL(req.url, 'http://localhost'), c = clients.get(url.searchParams.get('id'));
  const controllerId = url.searchParams.get('controller');
  const replacing = c?.viewer && /^[a-f0-9]{32}$/.test(controllerId || '') && c.viewer.controllerId === controllerId && c.viewer.sessionToken === token;
  if (url.pathname !== '/terminal' || !c || !online(c) || (c.viewer && !replacing)) return socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
  const mobile = url.searchParams.get('mode') === 'mobile';
  if (mobile && !c.mobile) return socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
  if (!mobile && !c.terminal) return socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
  if (replacing) { const previous = c.viewer; c.viewer = null; previous.close(1000, 'Browser reconnected'); }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.sessionToken = token; ws.controllerId = controllerId; ws.alive = true; ws.pendingOutput = new Map(); ws.pendingBytes = 0; c.viewer = ws;
    c.attachId = randomBytes(12).toString('hex');
    c.commands = [];
    queue(c, { type: mobile ? 'mobile_attach' : 'attach', attachId: c.attachId, cols: 120, rows: 30 });
    send(ws, { type: 'connected', label: c.label, mode: mobile ? 'mobile' : 'terminal' });
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    ws.on('message', raw => {
      try {
        if (c.viewer !== ws) return;
        if (!validSession(token)) return ws.close(1008, 'Login expired');
        const msg = JSON.parse(raw);
        if (mobile && msg.type === 'mobile') {
          const params = msg.params || {};
          if (typeof msg.requestId !== 'string' || msg.requestId.length > 64 || !['panes', 'read', 'prompt', 'key', 'create', 'close', 'context'].includes(msg.operation)) throw new Error('Invalid mobile request');
          if (msg.operation === 'context' && c.mobileVersion < 4) throw new Error('Client does not support context usage');
          if (!['panes', 'context'].includes(msg.operation) && (typeof params.paneId !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(params.paneId))) throw new Error('Invalid pane');
          if (msg.operation === 'prompt' && (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 12000)) throw new Error('Invalid prompt');
          if (msg.operation === 'create' && (c.mobileVersion < 2 || typeof params.label !== 'string' || !params.label.trim() || params.label.length > 80 || /[\x00-\x1f]/.test(params.label))) throw new Error('Invalid new window');
          if (msg.operation === 'create' && params.workspaceId !== undefined && (typeof params.workspaceId !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(params.workspaceId))) throw new Error('Invalid workspace');
          if (msg.operation === 'close' && (c.mobileVersion < 3 || params.confirmed !== true || typeof params.terminalId !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(params.terminalId))) throw new Error('Invalid pane close confirmation');
          if (msg.operation === 'key' && !['enter', 'esc', 'tab', 'ctrl+c', 'up', 'down', 'left', 'right'].includes(params.key)) throw new Error('Invalid key');
          queue(c, { type: 'mobile', attachId: c.attachId, requestId: msg.requestId, operation: msg.operation, params });
        }
        else if (!mobile && msg.type === 'ack' && Number.isSafeInteger(msg.seq)) {
          for (const [seq, bytes] of ws.pendingOutput) if (seq <= msg.seq) { ws.pendingBytes -= bytes; ws.pendingOutput.delete(seq); }
        }
        else if (!mobile && msg.type === 'input' && typeof msg.data === 'string' && msg.data.length <= 16000) queue(c, { type: 'input', attachId: c.attachId, data: msg.data, binary: msg.binary === true });
        else if (!mobile && msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) queue(c, { type: 'resize', attachId: c.attachId, cols: Math.max(20, Math.min(400, msg.cols)), rows: Math.max(5, Math.min(200, msg.rows)) });
      } catch (error) { send(ws, { type: 'notice', message: error.message }); ws.close(1008, 'Invalid or excessive input'); }
    });
    ws.on('close', () => { if (c.viewer === ws) detach(c); });
  });
});
const housekeeping = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive || !validSession(ws.sessionToken)) ws.terminate();
    else { ws.alive = false; ws.ping(); }
  }
  for (const c of clients.values()) if (!online(c) && c.viewer) { send(c.viewer, { type: 'notice', message: 'VDI 已離線，請稍後重連' }); c.viewer.close(1012, 'VDI offline'); }
  for (const token of sessions.keys()) validSession(token);
  deviceAuth?.prune();
  for (const [key, attempt] of attempts) if (attempt.until < Date.now()) attempts.delete(key);
}, 20000);
housekeeping.unref();
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(Number(process.env.PORT || 443), process.env.HOST || '0.0.0.0', () => console.log(`Herdr Remote listening on ${server.address().port}; credentials: ${secretPath}`));
