import { randomBytes, randomInt, createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, constants, fsyncSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DAY = 86400000;
const MAX_DEVICES = 32;
export const TRUST_SECONDS = 90 * 86400;
export const REQUEST_SECONDS = 300;
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const validSecret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.mode & 0o077) throw Error('Device authorization directory must be private (chmod 700)');
}
function readPrivate(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.mode & 0o077 || info.size > 262144) throw Error('Invalid device authorization file or permissions');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function writePrivate(path, data) {
  const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(data) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function deviceName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60 || /[\x00-\x1f\x7f]/.test(value)) throw Error('請輸入 1–60 字的瀏覽器名稱');
  return value.trim();
}
export function createBootstrap(directory, name, now = Date.now()) {
  directory = resolve(directory); privateDirectory(directory);
  const grants = join(directory, 'bootstrap'); privateDirectory(grants);
  const token = secret();
  writePrivate(join(grants, digest(token) + '.json'), { name: deviceName(name), expiresAt: now + 600000 });
  return token;
}
export class DeviceAuth {
  constructor(directory, now = Date.now) {
    this.directory = resolve(directory); this.now = now; this.requests = new Map();
    privateDirectory(this.directory); privateDirectory(join(this.directory, 'bootstrap'));
    this.file = join(this.directory, 'devices.json'); this.load();
  }
  load() {
    const state = readPrivate(this.file) || { version: 1, devices: [] };
    if (state.version !== 1 || !Array.isArray(state.devices) || state.devices.length > MAX_DEVICES || state.devices.some(d => !d || typeof d.id !== 'string' || !/^[a-f0-9]{64}$/.test(d.tokenHash) || typeof d.name !== 'string' || !Number.isFinite(d.expiresAt) || !Number.isFinite(d.createdAt))) throw Error('Invalid device authorization database');
    this.devices = state.devices.filter(d => d.expiresAt > this.now());
  }
  save() { writePrivate(this.file, { version: 1, devices: this.devices }); }
  get(id) { this.load(); return this.devices.find(d => d.id === id) || null; }
  fromToken(token) { if (!validSecret(token)) return null; this.load(); const hash = digest(token); return this.devices.find(d => d.tokenHash === hash) || null; }
  list() { this.load(); return this.devices.map(({ id, name, createdAt, expiresAt, userAgent }) => ({ id, name, createdAt, expiresAt, userAgent })); }
  enroll(name, userAgent, approvedBy) {
    this.load();
    if (this.devices.length >= MAX_DEVICES) throw Error('已達 32 個受信任瀏覽器，請先撤銷不使用的裝置');
    const token = secret();
    const device = { id: randomBytes(16).toString('hex'), tokenHash: digest(token), name: deviceName(name), userAgent: String(userAgent || '').slice(0, 180), createdAt: this.now(), expiresAt: this.now() + 90 * DAY, approvedBy };
    this.devices.push(device); this.save();
    return { device, token };
  }
  bootstrap(token, userAgent) {
    if (!validSecret(token)) throw Error('配對碼無效、已使用或已過期');
    const path = join(this.directory, 'bootstrap', digest(token) + '.json');
    const grant = readPrivate(path);
    if (!grant || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= this.now()) throw Error('配對碼無效、已使用或已過期');
    // Consume before enrollment: a failed request cannot replay a local grant.
    unlinkSync(path);
    return this.enroll(grant.name, userAgent, 'local-bootstrap');
  }
  prune() { for (const [key, req] of this.requests) if (req.expiresAt <= this.now()) this.requests.delete(key); }
  request(token, name, userAgent) {
    this.prune();
    const existing = validSecret(token) && this.requests.get(digest(token));
    if (existing?.state === 'pending') return { request: existing, token };
    if (this.requests.size >= 128) throw Error('等待核准的申請過多，請稍後再試');
    token = secret();
    const request = { id: randomBytes(16).toString('hex'), name: deviceName(name), userAgent: String(userAgent || '').slice(0, 180), code: String(randomInt(100000, 1000000)), createdAt: this.now(), expiresAt: this.now() + REQUEST_SECONDS * 1000, state: 'pending' };
    this.requests.set(digest(token), request); return { request, token };
  }
  pending() {
    this.prune();
    return [...this.requests.values()].filter(r => r.state === 'pending').map(({ id, name, userAgent, code, createdAt, expiresAt }) => ({ id, name, userAgent, code, createdAt, expiresAt }));
  }
  decide(id, code, approve, approverId) {
    this.prune();
    if (!this.get(approverId)) throw Error('核准者已失效，請重新登入');
    const request = [...this.requests.values()].find(r => r.id === id);
    if (!request || request.state !== 'pending' || request.code !== code) throw Error('申請已失效或配對碼不符，請重新整理');
    request.state = approve ? 'approved' : 'denied'; request.approvedBy = approverId;
  }
  status(token) {
    this.prune();
    const request = validSecret(token) && this.requests.get(digest(token));
    if (!request) return { status: 'expired' };
    if (request.state === 'pending') return { status: 'pending', name: request.name, code: request.code, expiresAt: request.expiresAt };
    if (request.state === 'denied') return { status: 'denied' };
    // Revocation of an approver invalidates its unclaimed requests too.
    if (!this.get(request.approvedBy)) return { status: 'denied' };
    if (!request.enrollment) request.enrollment = this.enroll(request.name, request.userAgent, request.approvedBy);
    if (!this.get(request.enrollment.device.id)) return { status: 'denied' };
    return { status: 'approved', enrollment: request.enrollment };
  }
  cancel(token) { if (validSecret(token)) this.requests.delete(digest(token)); }
  revoke(id) {
    this.load();
    if (!this.devices.some(d => d.id === id)) throw Error('找不到此瀏覽器');
    this.devices = this.devices.filter(d => d.id !== id); this.save();
  }
}
