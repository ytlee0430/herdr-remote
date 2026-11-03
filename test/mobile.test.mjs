import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';

const binary = process.env.TEST_HERDR_BINARY;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await delay(100); } throw new Error('Timed out'); }

test('Mobile pane reading, targeted prompt and switching against real herdr', { skip: !binary, timeout: 60000 }, async t => {
  const dir = mkdtempSync('/tmp/herdr-mobile-');
  const configDir = join(dir, 'config'); mkdirSync(join(configDir, 'herdr'), { recursive: true });
  writeFileSync(join(configDir, 'herdr/config.toml'), 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n');
  const env = { ...process.env, XDG_CONFIG_HOME: configDir, SHELL: '/bin/sh', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
  delete env.HERDR_SOCKET_PATH; delete env.HERDR_SESSION; delete env.HERDR_CONFIG_PATH;
  const creds = join(dir, 'creds.json'), token = join(dir, 'token');
  writeFileSync(creds, JSON.stringify({ browserPassword: 'mobile-browser', clientToken: 'mobile-client' }), { mode: 0o600 });
  writeFileSync(token, 'mobile-client', { mode: 0o600 });
  const herdr = spawn(binary, ['server'], { env, cwd: dir });
  let herdrLog = ''; herdr.stdout.on('data', b => herdrLog += b); herdr.stderr.on('data', b => herdrLog += b);
  let relay, client, browser;
  t.after(async () => {
    await browser?.close();
    if (client && client.exitCode === null) { client.kill('SIGINT'); await Promise.race([once(client, 'exit'), delay(2000)]); }
    relay?.kill();
    // This is only the isolated server created by this test, never a user session.
    try { execFileSync(binary, ['server', 'stop'], { env, timeout: 5000, stdio: 'pipe' }); } catch {}
    if (herdr.exitCode === null) { herdr.kill(); await Promise.race([once(herdr, 'exit'), delay(1000)]); }
    rmSync(dir, { recursive: true, force: true });
  });
  await until(() => existsSync(join(configDir, 'herdr/herdr.sock')));
  const cli = (...args) => execFileSync(binary, args, { env, cwd: dir, encoding: 'utf8', timeout: 10000 });
  const first = JSON.parse(cli('workspace', 'create', '--cwd', dir, '--label', '介面設計')).result;
  const second = JSON.parse(cli('workspace', 'create', '--cwd', dir, '--label', 'API 開發')).result;
  // Obtain real pane ids without assuming the workspace.create response shape.
  const snapshot = JSON.parse(cli('api', 'snapshot'));
  function collect(value) { if (Array.isArray(value)) return value.flatMap(collect); if (value && typeof value === 'object') { if (Array.isArray(value.panes)) return value.panes; return Object.values(value).flatMap(collect); } return []; }
  const allPanes = collect(snapshot);
  assert.ok(allPanes.length >= 2, JSON.stringify(snapshot).slice(0, 1000));
  const firstId = allPanes[0].pane_id, secondId = allPanes[1].pane_id;
  cli('pane', 'rename', firstId, '手機介面'); cli('pane', 'rename', secondId, 'API 驗證');
  cli('pane', 'run', firstId, "printf '第一個 pane 的內容\\n這裡可以直接閱讀 agent 的輸出，不需要縮小整個終端畫面。\\n' ");
  cli('pane', 'run', secondId, "printf 'SECOND_PANE_READY\\n'");
  relay = spawn(process.execPath, ['relay.mjs'], { env: { ...env, PORT: '0', HOST: '127.0.0.1', CREDENTIALS_FILE: creds } });
  let logs = ''; relay.stdout.on('data', b => logs += b); relay.stderr.on('data', b => logs += b);
  await until(() => /listening on (\d+)/.test(logs));
  const base = `http://127.0.0.1:${/listening on (\d+)/.exec(logs)[1]}`;
  client = spawn('python3', ['client.py', '--server', base, '--token-file', token, '--herdr', binary, '--id', 'mobile-test', '--label', 'Linux lab'], { env });
  let clientLog = ''; client.stdout.on('data', b => clientLog += b); client.stderr.on('data', b => clientLog += b);
  await until(() => clientLog.includes('Connected'));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.locator('#password').fill('mobile-browser'); await page.locator('#loginForm button').click(); await page.locator('#connect').click();
  await page.locator('.pane-card').first().waitFor();
  assert.ok(await page.locator('.pane-card').count() >= 2);
  // Shell panes have no transcript; explicitly select terminal text.
  await page.locator('#textLayout').selectOption('reflow');
  await until(async () => (await page.locator('#paneOutput').textContent()).includes('第一個 pane'));
  await page.locator('#prompt').fill("printf '\\115\\117\\102\\111\\114\\105\\137\\124\\101\\122\\107\\105\\124\\137\\117\\113\\n'");
  await page.locator('#sendPrompt').click();
  await until(async () => (await page.locator('#paneOutput').textContent()).includes('MOBILE_TARGET_OK'));
  assert.ok(!cli('pane', 'read', secondId, '--source', 'recent').includes('MOBILE_TARGET_OK'), 'Prompt must not reach another pane');
  // Drafts must follow the selected pane, and output must switch too.
  await page.locator('#prompt').fill('第一個 pane 尚未送出的草稿');
  await page.locator('.pane-card').nth(1).click();
  await until(async () => (await page.locator('#paneOutput').textContent()).includes('SECOND_PANE_READY'));
  assert.equal(await page.locator('#prompt').inputValue(), '');
  // Refresh must restore the selected pane and keep the same live session.
  await page.reload();
  await until(async () => (await page.locator('#paneOutput').textContent()).includes('SECOND_PANE_READY'));
  assert.match(await page.locator('.pane-card.selected').textContent(), new RegExp(secondId));
  const afterRefresh = collect(JSON.parse(cli('api', 'snapshot'))).map(p => p.pane_id).sort();
  assert.deepEqual(afterRefresh, allPanes.map(p => p.pane_id).sort());
  await page.locator('.pane-card').first().click();
  // Drafts are in-memory only; terminal content/session survive refresh.
  await until(async () => (await page.locator('#paneOutput').textContent()).includes('MOBILE_TARGET_OK'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/herdr-mobile-pane-ui.png', fullPage: true });
  await page.locator('#terminalMode').click();
  await page.locator('#terminalView').waitFor();
  await until(async () => (await page.locator('#terminal .xterm-screen').boundingBox())?.width > 800);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#mobileMode').click();
  await until(async () => (await page.locator('#paneOutput').textContent()).includes('MOBILE_TARGET_OK'));
  // Create a real tab in the selected workspace and select its new root pane.
  await page.locator('#newWindow').click();
  await page.locator('#windowName').fill('新的 agent 視窗');
  await page.locator('#submitCreate').click();
  await until(async () => (await page.locator('#paneTitle').textContent()).includes('新的 agent 視窗') || (await page.locator('#sendStatus').textContent()).includes('新視窗已開啟'));
  const expanded = collect(JSON.parse(cli('api', 'snapshot')));
  assert.equal(expanded.length, allPanes.length + 1);
  const newPane = expanded.find(p => !allPanes.some(old => old.pane_id === p.pane_id));
  assert.equal(newPane.workspace_id, allPanes[0].workspace_id);
  assert.match(await page.locator('#targetLabel').textContent(), new RegExp(newPane.pane_id));
  // Exercise the exact agent paste/Enter boundary using a synthetic terminal
  // agent in the real herdr server; no external LLM account is involved.
  const fixture = join(dir, 'codex');
  execFileSync('cc', [resolve('test/agent_fixture.c'), '-o', fixture]);
  cli('pane', 'run', newPane.pane_id, fixture);
  await until(() => cli('pane', 'read', newPane.pane_id, '--source', 'recent').includes('AGENT_READY'));
  cli('pane', 'report-agent', newPane.pane_id, '--source', 'custom:web-test', '--agent', 'codex', '--state', 'idle');
  assert.equal(JSON.parse(cli('pane', 'get', newPane.pane_id)).result.pane.agent, 'codex');
  await page.locator('#prompt').fill('FIRST_PROMPT_ONLY');
  await page.locator('#sendPrompt').click();
  await until(() => cli('pane', 'read', newPane.pane_id, '--source', 'recent-unwrapped').includes('SUBMITTED:FIRST_PROMPT_ONLY')).catch(async error => {
    throw new Error(error.message + '\nOUTPUT: ' + cli('pane', 'read', newPane.pane_id, '--source', 'recent-unwrapped') + '\nSTATUS: ' + await page.locator('#sendStatus').textContent() + '\nPANE: ' + cli('pane', 'get', newPane.pane_id));
  });
  assert.ok(!cli('pane', 'read', newPane.pane_id, '--source', 'recent').includes('EARLY_ENTER_IGNORED'));
  // Monitor all panes, including one that is not selected, and reorder by output.
  await delay(3500);
  cli('pane', 'run', secondId, "printf 'NEWEST_ACTIVITY_FROM_SECOND_PANE\\n'");
  await until(async () => { await page.locator('#refreshPanes').click(); return (await page.locator('.pane-card').first().textContent()).includes(secondId); }, 20000);
  assert.match(await page.locator('.pane-card').first().textContent(), /輸出/);
  await page.locator('#paneSearch').fill(secondId);
  assert.equal(await page.locator('.pane-card').count(), 1);
  await page.locator('#paneSearch').fill('');
  // Long prose is reflowed but the original line breaks remain recoverable.
  cli('pane', 'run', secondId, "printf 'A deliberately wrapped paragraph\\ncontinues on its next terminal line.\\n'");
  await page.locator('.pane-card').filter({ hasText: secondId }).click();
  await until(async () => (await page.locator('#paneOutput').textContent()).includes('A deliberately wrapped paragraph continues on its next terminal line.'));
  await page.locator('#textLayout').selectOption('lines');
  assert.ok((await page.locator('#paneOutput').textContent()).includes('A deliberately wrapped paragraph\ncontinues on its next terminal line.'));
  await page.locator('#textLayout').selectOption('reflow');
  await page.screenshot({ path: '/tmp/herdr-mobile-improved.png', fullPage: true });
  // Distinguish a real linked checkout, create in it from a different selected
  // workspace, then close only that new pane through the confirmation dialog.
  const repo = join(dir, 'repo'), checkout = join(dir, 'feature-checkout');
  mkdirSync(repo);
  execFileSync('git', ['init', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'ui-feature', checkout]);
  const tree = JSON.parse(cli('workspace', 'create', '--cwd', checkout, '--label', 'Feature worktree')).result;
  const treeWorkspace = tree.workspace.workspace_id, treePane = tree.root_pane.pane_id;
  await page.locator('#refreshPanes').click();
  await until(async () => await page.locator(`#workspaceFilter option[value="${treeWorkspace}"]`).count() === 1);
  await page.locator('#workspaceFilter').selectOption('kind:worktree');
  assert.equal(await page.locator('.pane-card').count(), 1, cli('worktree', 'list', '--workspace', treeWorkspace));
  assert.match(await page.locator('.pane-card').textContent(), /Worktree.*Feature worktree/);
  assert.match(await page.locator('.pane-card').textContent(), /ui-feature/);
  await page.locator('#workspaceFilter').selectOption('');
  await page.locator('#newWindow').click();
  await page.locator('#createWorkspace').selectOption(treeWorkspace);
  assert.equal(await page.locator('#createSourcePane').inputValue(), treePane);
  await page.locator('#windowName').fill('Close only this fixture');
  await page.locator('#submitCreate').click();
  await until(async () => !(await page.locator('#createDialog').evaluate(el => el.open)));
  const created = collect(JSON.parse(cli('api','snapshot'))).find(p => p.workspace_id === treeWorkspace && p.pane_id !== treePane);
  assert.ok(created);
  assert.equal(realpathSync(created.cwd), realpathSync(checkout));
  await page.locator('#closePane').click();
  assert.match(await page.locator('#closePaneContext').textContent(), new RegExp(created.pane_id));
  await page.locator('#cancelClosePane').click();
  assert.ok(collect(JSON.parse(cli('api','snapshot'))).some(p => p.pane_id === created.pane_id));
  await page.locator('#closePane').click();
  await page.locator('#confirmClosePane').click();
  await until(async () => !(await page.locator('#closePaneDialog').evaluate(el => el.open)));
  const remaining = collect(JSON.parse(cli('api','snapshot')));
  assert.ok(!remaining.some(p => p.pane_id === created.pane_id));
  assert.ok(remaining.some(p => p.pane_id === treePane));
  assert.ok(remaining.some(p => p.pane_id === firstId));
  assert.ok(existsSync(checkout), 'Closing a pane must preserve its worktree files');
  assert.deepEqual(errors, []);
  assert.equal(first.type === 'error' || second.type === 'error', false);
});
