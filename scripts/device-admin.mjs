#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createBootstrap } from '../device-auth.mjs';

const [command, name, ...extra] = process.argv.slice(2);
if (command !== 'bootstrap' || !name || extra.length) {
  console.error('Usage: node scripts/device-admin.mjs bootstrap "Browser name"');
  console.error('Run locally on the relay host. DEVICE_AUTH_DIR must match the relay.');
  process.exitCode = 1;
} else {
  const directory = process.env.DEVICE_AUTH_DIR || fileURLToPath(new URL('../.device-auth/', import.meta.url));
  const token = createBootstrap(resolve(directory), name);
  console.log('本機一次性配對碼（10 分鐘有效，僅在自己的 HTTPS 登入頁使用）：');
  console.log(token);
  console.log('請勿將配對碼、.device-auth/ 或憑證檔提交 Git 或貼到聊天。');
}
