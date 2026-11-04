import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceAuth, createBootstrap, TRUST_SECONDS } from '../device-auth.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'herdr-device-unit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1700000000000;
  const auth = new DeviceAuth(directory, () => now);
  const bootstrap = createBootstrap(directory, 'Owner browser', now);
  const owner = auth.bootstrap(bootstrap, 'Synthetic browser');
  return { directory, auth, bootstrap, owner, advance: ms => { now += ms; } };
}
test('Trust persists as token hashes, bootstrap is single-use, and trust expires after 90 days', t => {
  const { directory, auth, bootstrap, owner, advance } = fixture(t);
  assert.equal(auth.fromToken(owner.token).id, owner.device.id);
  assert.throws(() => auth.bootstrap(bootstrap, 'again'), /配對碼/);
  const saved = readFileSync(join(directory, 'devices.json'), 'utf8');
  assert.equal(saved.includes(owner.token), false); assert.equal(saved.includes(bootstrap), false);
  assert.equal(JSON.stringify(auth.list()).includes('tokenHash'), false);
  assert.equal(statSync(join(directory, 'devices.json')).mode & 0o077, 0);
  assert.equal(statSync(directory).mode & 0o077, 0);
  const restarted = new DeviceAuth(directory, () => 1700000000000);
  assert.equal(restarted.fromToken(owner.token).id, owner.device.id);
  advance(TRUST_SECONDS * 1000);
  assert.equal(auth.fromToken(owner.token), null);
});
test('Approval requires a live trusted approver and the matching request code', t => {
  const { auth, owner, advance } = fixture(t);
  const pending = auth.request(null, 'Phone', 'Synthetic mobile');
  assert.equal(auth.status(pending.token).status, 'pending');
  assert.equal(auth.status(pending.request.id).status, 'expired');
  assert.throws(() => auth.decide(pending.request.id, pending.request.code, true, 'untrusted'));
  assert.throws(() => auth.decide(pending.request.id, 'wrong-code', true, owner.device.id));
  auth.decide(pending.request.id, pending.request.code, true, owner.device.id);
  assert.throws(() => auth.decide(pending.request.id, pending.request.code, true, owner.device.id));
  const approved = auth.status(pending.token);
  assert.equal(approved.status, 'approved');
  assert.equal(auth.status(pending.token).enrollment.token, approved.enrollment.token, 'Lost responses can retry without creating another device');
  assert.equal(auth.list().length, 2);
  auth.revoke(approved.enrollment.device.id);
  assert.equal(auth.status(pending.token).status, 'denied');
  const expiring = auth.request(null, 'Other browser', 'Synthetic');
  advance(300000);
  assert.equal(auth.status(expiring.token).status, 'expired');
  assert.throws(() => auth.decide(expiring.request.id, expiring.request.code, true, owner.device.id));
});
test('Cancellation, rejection and approver revocation cannot grant trust', t => {
  const { auth, owner } = fixture(t);
  for (const operation of ['cancel', 'reject', 'revoke']) {
    const p = auth.request(null, operation, 'Synthetic');
    if (operation === 'cancel') auth.cancel(p.token);
    else { auth.decide(p.request.id, p.request.code, operation === 'revoke', owner.device.id); if (operation === 'revoke') auth.revoke(owner.device.id); }
    assert.notEqual(auth.status(p.token).status, 'approved');
  }
});
test('Pending requests are bounded; corrupt persistent state fails closed', t => {
  const { auth, directory } = fixture(t);
  for (let i = 0; i < 128; i++) auth.request(null, 'Browser ' + i, 'Synthetic');
  assert.throws(() => auth.request(null, 'Overflow', 'Synthetic'), /過多/);
  writeFileSync(join(directory, 'devices.json'), '{"version":1,"devices":[{}]}');
  assert.throws(() => new DeviceAuth(directory), /Invalid/);
});
test('Local grants are private, expire, and never contain the raw pairing code', t => {
  const { directory, auth, advance } = fixture(t);
  const token = createBootstrap(directory, 'Recovery', 1700000000000);
  const path = join(directory, 'bootstrap', readdirSync(join(directory, 'bootstrap'))[0]);
  assert.equal(readFileSync(path, 'utf8').includes(token), false);
  assert.equal(statSync(path).mode & 0o077, 0);
  advance(600000);
  assert.throws(() => auth.bootstrap(token, 'Synthetic'), /配對碼/);
});
