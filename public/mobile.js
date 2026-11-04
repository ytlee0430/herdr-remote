import { paneDisplayText, sortPanes, modelMenu, agentPrompt } from './text-layout.js';
const $ = id => document.getElementById(id);
const term = new Terminal({ cursorBlink: true, fontSize: 12, scrollback: 5000, theme: { background: '#101513', foreground: '#e4e9e4' }, allowProposedApi: false });
const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
let ws, opened = false, loggedIn = false, devices = [], mode = 'mobile', paneId = null, panes = [], readBusy = false, listBusy = false, sending = false;
let requestSequence = 0, selectionEpoch = 0, lastDimensions = '', selectionScope = '';
let rawOutput = '', creating = false, closing = false, workspaceRows = [], closeTarget = null, closeAttempted = false;
let conversation = null, conversationError = '', conversationSignature = '';
let inputBuffer = '', inputSocket = null, inputTimer = null, lastDisconnect = '';
let readerExpanded = false;
let promptState = null, promptBusy = false, promptPolling = false;
let contextUsage = {}, contextBusy = false, contextRunning = false, contextAction = null;
let approvalEnabled = false, waitingApproval = false, approvalBusy = false, deviceAuthBusy = false;
// Preserve following the latest reply when the viewport, keyboard or composer
// changes the reader's height, even if the transcript itself is unchanged.
let followLatest = true;
const readerScroll = $('outputScroll');
const nearLatest = () => readerScroll.scrollHeight - readerScroll.scrollTop - readerScroll.clientHeight < 80;
readerScroll.addEventListener('scroll', () => { followLatest = nearLatest(); }, { passive: true });
new ResizeObserver(() => {
  if (followLatest && readerScroll.clientHeight) readerScroll.scrollTop = readerScroll.scrollHeight;
}).observe(readerScroll);

function fitReaderViewport() {
  if (!readerExpanded) return;
  const viewport = window.visualViewport;
  document.body.style.setProperty('--reader-height', `${viewport?.height || innerHeight}px`);
  document.body.style.setProperty('--reader-top', `${viewport?.offsetTop || 0}px`);
}
function expandReader(expanded, restoreFocus = false) {
  if (expanded && (mode !== 'mobile' || !paneId || ws?.readyState !== WebSocket.OPEN)) return;
  readerExpanded = expanded;
  document.body.classList.toggle('reader-expanded', expanded);
  $('readerExpand').textContent = expanded ? '← 返回 pane 清單' : '滿版閱讀 ↗';
  $('readerExpand').setAttribute('aria-expanded', String(expanded));
  fitReaderViewport();
  if (!expanded && restoreFocus) $('readerExpand').focus({ preventScroll: true });
}
window.visualViewport?.addEventListener('resize', fitReaderViewport);
window.visualViewport?.addEventListener('scroll', fitReaderViewport);
window.addEventListener('resize', fitReaderViewport);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && readerExpanded && !$('modelDialog').open && !$('contextDialog').open && !$('createDialog').open && !$('closePaneDialog').open) { event.preventDefault(); expandReader(false, true); }
});
const pending = new Map(), drafts = new Map();
function saved(key, fallback = '') { try { return sessionStorage.getItem(key) || fallback; } catch { return fallback; } }
function remember(key, value) { try { sessionStorage.setItem(key, value); } catch {} }
const controllerId = saved('herdr-controller', Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join(''));
remember('herdr-controller', controllerId);
mode = saved('herdr-mode', 'mobile') === 'terminal' ? 'terminal' : 'mobile';
let autoRestore = saved('herdr-connected') === 'yes';
$('paneSort').value = saved('herdr-sort', 'recent');
$('textLayout').value = saved('herdr-layout', 'conversation');
let readerFontSize = 13;
function setReaderFontSize(value) {
  const numeric = Number(value);
  readerFontSize = Number.isFinite(numeric) ? Math.max(8, Math.min(24, Math.round(numeric))) : 13;
  const output = $('outputScroll');
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 80;
  document.body.style.setProperty('--reader-font-size', `${readerFontSize}px`);
  $('fontSizeLabel').textContent = `${readerFontSize}px`;
  $('fontSmaller').disabled = readerFontSize <= 8;
  $('fontLarger').disabled = readerFontSize >= 24;
  try { localStorage.setItem('herdr-reader-font-size', String(readerFontSize)); } catch {}
  if (atBottom) output.scrollTop = output.scrollHeight;
}
try { readerFontSize = localStorage.getItem('herdr-reader-font-size') ?? 13; } catch {}
setReaderFontSize(readerFontSize);
$('fontSmaller').onclick = () => setReaderFontSize(readerFontSize - 1);
$('fontLarger').onclick = () => setReaderFontSize(readerFontSize + 1);
$('fontReset').onclick = () => setReaderFontSize(13);
function paneStorageKey() { const device = devices.find(d => d.id === $('clients').value); return 'herdr-pane:' + (device?.id || '') + ':' + (device?.target || ''); }
if (location.protocol === 'https:') $('transport').hidden = true;
async function api(path, data) {
  const res = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await res.json(); if (!res.ok) { const error = new Error(result.error || '連線失敗'); error.status = res.status; throw error; } return result;
}
function clearInput() {
  clearTimeout(inputTimer); inputTimer = null; inputBuffer = ''; inputSocket = null;
}
function flushInput() {
  const socket = inputSocket, data = inputBuffer;
  clearInput();
  if (data && socket === ws && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
}
function send(data) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  if (data.type === 'input' && !data.binary) {
    // xterm emits hundreds of individual replies to herdr's startup palette
    // queries. Preserve their byte order, but send them as bounded batches.
    if (inputSocket && inputSocket !== ws) clearInput();
    if (inputBuffer.length + data.data.length > 16000) flushInput();
    inputSocket = ws; inputBuffer += data.data;
    if (inputTimer === null) inputTimer = setTimeout(flushInput, 8);
  } else {
    if (data.type === 'input') flushInput();
    ws.send(JSON.stringify(data));
  }
}
function rpc(operation, params = {}) {
  return new Promise((resolve, reject) => {
    if (ws?.readyState !== WebSocket.OPEN || mode !== 'mobile') return reject(new Error('請先連接 VDI'));
    const requestId = String(++requestSequence);
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(['prompt', 'create', 'close'].includes(operation) ? '未收到確認，請先更新 pane 清單並查看輸出，避免重複操作' : 'VDI 回應逾時')); }, 30000);
    pending.set(requestId, { resolve, reject, timer });
    send({ type: 'mobile', requestId, operation, params });
  });
}
function resize() {
  if (!opened || $('terminalView').hidden || !ws) return;
  $('terminal').style.width = Math.max(880, $('terminalScroll').clientWidth) + 'px';
  fit.fit();
  if (term.cols < 120) term.resize(120, term.rows);
  const dimensions = `${term.cols}:${term.rows}`;
  if (lastDimensions !== dimensions && ws.readyState === WebSocket.OPEN) { lastDimensions = dimensions; send({ type: 'resize', cols: term.cols, rows: term.rows }); }
}
term.onData(data => { if (mode === 'terminal') send({ type: 'input', data }); });
term.onBinary(data => { if (mode === 'terminal') send({ type: 'input', data: btoa(data), binary: true }); });
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe($('terminalScroll'));
function setMode(next) {
  if (next !== 'mobile') expandReader(false);
  remember('herdr-mode', next);
  mode = next; document.body.classList.toggle('terminal-mode', next === 'terminal');
  for (const name of ['mobile', 'terminal']) { $(name + 'Mode').classList.toggle('active', name === mode); $(name + 'Mode').setAttribute('aria-pressed', String(name === mode)); }
  document.querySelectorAll('.terminal-only').forEach(el => el.hidden = mode !== 'terminal');
  $('mobileView').hidden = !ws || mode !== 'mobile'; $('terminalView').hidden = !ws || mode !== 'terminal';
  updateControls();
}
function updateControls() {
  const connected = ws?.readyState === WebSocket.OPEN;
  const ready = connected && (mode === 'terminal' || !!paneId);
  $('readerExpand').disabled = !connected || mode !== 'mobile' || !paneId;
  $('sendPrompt').disabled = !ready || sending || contextRunning;
  document.querySelectorAll('[data-key]').forEach(button => button.disabled = !ready || sending);
  $('mobileMode').disabled = sending; $('terminalMode').disabled = sending || devices.find(d => d.id === $('clients').value)?.terminal === false;
  $('closePane').disabled = !ready || sending || creating || closing || mode !== 'mobile' || !panes.find(p => p.id === paneId)?.terminalId || (devices.find(d => d.id === $('clients').value)?.mobileVersion || 0) < 3;
  $('modelButton').disabled = !ready || sending || mode !== 'mobile' || !['devin', 'codex', 'claude'].includes(panes.find(p => p.id === paneId)?.agent);
  const agentPane = panes.find(p => p.id === paneId), v4 = (devices.find(d => d.id === $('clients').value)?.mobileVersion || 0) >= 4;
  $('clearContext').disabled = $('migrateContext').disabled = !ready || sending || contextRunning || mode !== 'mobile' || !v4 || !Object.hasOwn(clearCommands, agentPane?.agent || '');
  $('launchAgent').disabled = !ready || sending || creating || mode !== 'mobile' || (devices.find(d => d.id === $('clients').value)?.mobileVersion || 0) < 2;
  $('newWindow').disabled = !ready || creating || (devices.find(d => d.id === $('clients').value)?.mobileVersion || 0) < 2;
  $('targetLabel').textContent = mode === 'terminal' ? '傳送到完整終端目前的 pane' : paneId ? `傳送到 ${panes.find(p => p.id === paneId)?.title || paneId} · ${paneId}` : '先選擇一個 pane';
}
async function refresh() {
  try {
    const data = await api('/api/clients');
    loggedIn = true; $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
    if (data.deviceApproval === true) configureApproval(true);
    if (waitingApproval) showApproval(null);
    devices = data.clients;
    const selected = $('clients').value || saved('herdr-device');
    $('clients').replaceChildren(...devices.map(c => {
      const option = document.createElement('option'); option.value = c.id; option.textContent = `${c.label} · ${c.online ? (c.busy ? '使用中' : '在線') : '離線'}`; option.disabled = !c.online; return option;
    }));
    if (devices.some(c => c.id === selected)) $('clients').value = selected;
    $('clients').disabled = !!ws;
    $('connect').disabled = !!ws || !devices.some(c => c.online);
    if (!ws) $('connectionStatus').textContent = lastDisconnect || (devices.some(c => c.online) ? 'VDI 已上線，點此連線' : '等待 VDI client');
    const old = devices.find(c => c.id === $('clients').value && (c.mobileVersion || 0) < 2);
    $('upgrade').hidden = !old;
    if (old) $('upgrade').textContent = '請更新所選裝置的 client，以啟用 agent 正確送出、新視窗和輸出時間排序。';
    updateControls();
    if (autoRestore && !ws && devices.some(c => c.id === $('clients').value && c.online)) { autoRestore = false; connect(); }
  } catch (error) { if (error.status === 401 && loggedIn) { loggedIn = false; ws?.close(); $('workspace').hidden = true; $('logout').hidden = true; $('manageDevices').hidden = true; $('login').hidden = false; $('deviceDialog').close(); $('loginError').textContent = error.message; } else if (loggedIn) $('connectionStatus').textContent = error.message; }
}
function workspaceLabel(w) { return `${w.label || w.id}${w.branch ? ' · ' + w.branch : ''}`; }
function workspaceOptions(select, rows) {
  for (const kind of ['workspace', 'worktree']) {
    const group = document.createElement('optgroup'); group.label = kind === 'worktree' ? 'Git Worktrees' : 'Workspaces';
    for (const w of rows.filter(w => (w.kind || 'workspace') === kind)) {
      const option = document.createElement('option'); option.value = w.id; option.textContent = workspaceLabel(w); group.append(option);
    }
    if (group.childElementCount) select.append(group);
  }
}
function renderWorkspaceFilter() {
  const select = $('workspaceFilter'), previous = select.value;
  select.replaceChildren(...[['', '全部 Workspace / Worktree'], ['kind:workspace', '僅 Workspace'], ['kind:worktree', '僅 Git Worktree']].map(([value, label]) => {
    const option = document.createElement('option'); option.value = value; option.textContent = label; return option;
  }));
  workspaceOptions(select, workspaceRows);
  select.value = [...select.options].some(o => o.value === previous) ? previous : '';
}
function updateCreateSources() {
  const workspace = $('createWorkspace').value, source = $('createSourcePane');
  const candidates = panes.filter(p => (p.workspaceId || '') === workspace);
  source.replaceChildren(...candidates.map(p => { const option = document.createElement('option'); option.value = p.id; option.textContent = `${p.title} · ${p.id} · ${p.cwd || ''}`; return option; }));
  if (candidates.some(p => p.id === paneId)) source.value = paneId;
  updateCreateContext();
}
function updateCreateContext() {
  const source = panes.find(p => p.id === $('createSourcePane').value);
  $('createContext').textContent = source ? `工作目錄：${source.cwd || '沿用 workspace 設定'}` : '此 workspace 沒有可用的來源 pane，請重新選擇。';
  $('submitCreate').disabled = creating || !source;
}
function renderPanes() {
  const statuses = { working: '工作中', blocked: '等待回覆', idle: '待命', done: '完成', unknown: '終端' };
  const scroll = $('paneList').scrollLeft;
  const query = $('paneSearch').value.trim().toLowerCase();
  const filter = $('workspaceFilter').value;
  const visible = sortPanes(panes, $('paneSort').value).filter(p => (!filter || (filter.startsWith('kind:') ? (p.workspaceKind || 'workspace') === filter.slice(5) : p.workspaceId === filter)) && [p.title, p.id, p.workspace, p.cwd, p.branch, p.worktreePath].join(' ').toLowerCase().includes(query));
  $('paneList').replaceChildren(...visible.map(pane => {
    const button = document.createElement('button'); button.className = 'pane-card'; button.classList.toggle('needs-reply', pane.status === 'blocked'); button.classList.toggle('selected', pane.id === paneId); button.setAttribute('aria-pressed', String(pane.id === paneId));
    const title = document.createElement('strong'); title.textContent = pane.title;
    const detail = document.createElement('small'); detail.textContent = `${pane.workspaceKind === 'worktree' ? 'Worktree' : 'Workspace'} · ${pane.workspace || pane.workspaceId || ''} · ${pane.id}`;
    const checkout = document.createElement('small'); checkout.className = 'pane-checkout'; checkout.textContent = [pane.branch, pane.worktreePath || pane.cwd].filter(Boolean).join(' · '); checkout.title = checkout.textContent;
    const state = document.createElement('span'); state.className = 'pane-state ' + (Object.hasOwn(statuses, pane.status) ? pane.status : 'unknown'); state.textContent = statuses[pane.status] || '終端';
    const age = document.createElement('small'); age.className = 'pane-age';
    const seconds = pane.lastOutputAt ? Math.max(0, Math.floor((Date.now() - pane.lastOutputAt) / 1000)) : null;
    age.textContent = seconds === null ? (pane.completionSeq ? '連線前完成' : '尚未觀測新輸出') : seconds < 10 ? '剛有輸出' : seconds < 60 ? `${seconds} 秒前有輸出` : `${Math.floor(seconds / 60)} 分鐘前有輸出`;
    age.title = pane.lastOutputAt ? new Date(pane.lastOutputAt).toLocaleString() : '尚未觀測到新輸出；歷史項目以 herdr 完成順序排列';
    const usage = contextUsage[pane.id], context = document.createElement('small');
    context.className = 'pane-context'; context.textContent = usage ? contextText(usage) : ''; context.hidden = !usage;
    context.classList.toggle('high', (usage?.percent ?? 0) >= 80);
    button.append(title, detail, checkout, state, age, context); button.disabled = sending || creating || closing; button.onclick = () => selectPane(pane.id); return button;
  }));
  const blocked = panes.filter(p => p.status === 'blocked').length;
  $('blockedCount').hidden = !blocked; $('blockedCount').textContent = `${blocked} 個等待回覆`;
  document.title = blocked ? `(${blocked}) Herdr Remote` : 'Herdr Remote';
  if (!visible.length) { const note = document.createElement('p'); note.className = 'no-matches'; note.textContent = panes.length ? '沒有符合的 pane' : '尚無 pane'; $('paneList').append(note); }
  $('paneList').scrollLeft = scroll;
}
function selectPane(id) {
  if (sending || closing || id === paneId) return;
  if (paneId) drafts.set(paneStorageKey() + ':' + paneId, $('prompt').value);
  paneId = id; selectionEpoch++; followLatest = true;
  remember(paneStorageKey(), id);
  $('prompt').value = drafts.get(paneStorageKey() + ':' + id) || ''; $('sendStatus').textContent = '';
  const pane = panes.find(p => p.id === id);
  $('paneTitle').textContent = pane?.title || id;
  $('paneMeta').textContent = [pane?.workspaceKind === 'worktree' ? 'Worktree' : 'Workspace', pane?.workspace, pane?.branch, pane?.cwd].filter(Boolean).join(' · ');
  renderContextLine();
  rawOutput = ''; $('paneOutput').textContent = '正在讀取內容…'; $('updated').textContent = '讀取中';
  conversation = null; conversationError = ''; conversationSignature = ''; renderOutput();
  renderPanes(); updateControls(); readPane();
}
async function refreshPanes() {
  if (listBusy || mode !== 'mobile' || ws?.readyState !== WebSocket.OPEN) return;
  listBusy = true; const activeSocket = ws;
  try {
    const result = await rpc('panes'); if (ws !== activeSocket) return;
    panes = result.panes || [];
    workspaceRows = result.workspaces || [...new Map(panes.map(p => [p.workspaceId || '', {id: p.workspaceId || '', label: p.workspace || '目前 Workspace', kind: p.workspaceKind || 'workspace', checkout: p.worktreePath || '', branch: p.branch || ''}])).values()];
    renderWorkspaceFilter();
    if (!panes.some(p => p.id === paneId)) {
      expandReader(false);
      paneId = null; selectionEpoch++;
      conversation = null; conversationError = '沒有可用的 pane'; conversationSignature = ''; renderOutput();
      if (panes.length) { const previous = saved(paneStorageKey()); selectPane(panes.some(p => p.id === previous) ? previous : sortPanes(panes, $('paneSort').value)[0].id); }
      else { $('paneOutput').textContent = '這個 session 沒有可用的 pane。請確認 client 使用的是你正在操作的 herdr session。'; $('paneTitle').textContent = '沒有 pane'; }
    }
    renderPanes(); updateControls();
    if (paneId) renderOutput();
  } catch (error) { if (ws === activeSocket) $('paneOutput').textContent = `無法取得 pane 清單：${error.message}\n\n可以切換「完整終端」繼續操作。`; }
  finally { listBusy = false; }
}
async function readPane() {
  if (readBusy || !paneId || mode !== 'mobile' || ws?.readyState !== WebSocket.OPEN || document.hidden) return;
  readBusy = true; const id = paneId, epoch = selectionEpoch, activeSocket = ws, layout = $('textLayout').value;
  try {
    const result = await rpc('read', { paneId: id, ...(layout === 'conversation' ? { view: 'conversation' } : {}) });
    if (id !== paneId || epoch !== selectionEpoch || ws !== activeSocket || layout !== $('textLayout').value) return;
    if (layout === 'conversation') {
      conversation = result.conversation || null;
      conversationError = conversation ? '' : '此 client 尚未支援對話模式。請更新 VDI client 並設定 --transcript-map；原本終端仍可使用。';
    } else rawOutput = result.text || '目前沒有輸出。你可以在下方傳送 prompt，或切換其他 pane。';
    renderOutput();
    $('updated').textContent = '更新於 ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (error) {
    if (id === paneId && epoch === selectionEpoch && ws === activeSocket && layout === $('textLayout').value) {
      $('updated').textContent = error.message;
      if (layout === 'conversation') { conversation = null; conversationError = error.message; renderOutput(); }
    }
  }
  finally { readBusy = false; }
}
function renderOutput() {
  const view = $('outputScroll'), bottom = view.scrollHeight - view.scrollTop - view.clientHeight < 80;
  const layout = $('textLayout').value;
  $('paneOutput').hidden = layout === 'conversation';
  $('conversationOutput').hidden = layout !== 'conversation';
  if (layout === 'conversation') {
    const status = panes.find(p => p.id === paneId)?.status;
    const signature = JSON.stringify([conversation, conversationError, status]);
    if (signature === conversationSignature) return;
    conversationSignature = signature;
    const host = $('conversationOutput');
    const expanded = new Set([...host.querySelectorAll('details[open]')].map(el => el.dataset.id));
    host.replaceChildren();
    const note = document.createElement('p'); note.className = 'conversation-notice';
    note.textContent = conversationError || (conversation ? `對話紀錄 · ${conversation.agent} · ${conversation.sessionId}。不代表目前 pane 的即時授權狀態。${conversation.truncated ? '僅顯示最近部分紀錄。' : ''}` : '正在讀取對話紀錄…'); host.append(note);
    if (status === 'working' || status === 'blocked') {
      const state = document.createElement('p'); state.textContent = status === 'working' ? 'Working…' : 'Pane 等待回覆；請在下方「Agent 等待回覆」作答，或切回「保留分行」查看即時畫面。'; host.append(state);
    }
    const labels = { user: '你', assistant: 'Agent 回覆', thinking: '思考摘要', progress: '過程訊息', tool: '工具紀錄（歷史）' };
    for (const entry of conversation?.entries || []) {
      const folded = ['thinking', 'progress', 'tool'].includes(entry.kind);
      const card = document.createElement(folded ? 'details' : 'article');
      card.dataset.id = entry.id; card.dataset.kind = entry.kind;
      if (folded) card.open = expanded.has(entry.id);
      const title = document.createElement(folded ? 'summary' : 'strong'); title.textContent = labels[entry.kind] || '紀錄';
      const content = document.createElement('pre'); content.textContent = entry.text;
      card.append(title, content); host.append(card);
    }
    if (conversation && !conversation.entries?.length) { const empty = document.createElement('p'); empty.textContent = '目前沒有支援的完整訊息紀錄。'; host.append(empty); }
    if (bottom) view.scrollTop = view.scrollHeight;
    return;
  }
  $('paneOutput').classList.toggle('no-wrap', layout === 'raw');
  const text = paneDisplayText(rawOutput || '正在讀取內容…', layout, panes.find(p => p.id === paneId)?.status);
  if ($('paneOutput').textContent !== text) { $('paneOutput').textContent = text; if (bottom) view.scrollTop = view.scrollHeight; }
}
function connect() {
  if (ws || !$('clients').value) return;
  clearInput(); lastDisconnect = '';
  const device = devices.find(d => d.id === $('clients').value);
  if (selectionScope !== paneStorageKey()) { selectionScope = paneStorageKey(); paneId = null; panes = []; selectionEpoch++; $('prompt').value = ''; }
  remember('herdr-device', $('clients').value);
  if (device?.terminal === false) setMode('mobile');
  if (!device?.mobile) setMode('terminal');
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/terminal?id=${encodeURIComponent($('clients').value)}&mode=${mode}&controller=${controllerId}`);
  ws = socket; setMode(mode); $('empty').hidden = true; $('controls').hidden = false;
  $('connectionStatus').textContent = '正在連接…'; $('connect').disabled = true; $('disconnect').disabled = false; $('clients').disabled = true;
  if (mode === 'terminal') { if (!opened) { term.open($('terminal')); opened = true; } term.reset(); lastDimensions = ''; resize(); }
  socket.onopen = () => { remember('herdr-connected', 'yes'); $('devicePanel').open = false; $('statusDot').classList.add('online'); $('connectionStatus').textContent = [device?.label, device?.target].filter(Boolean).join(' · '); $('connectionStatus').title = $('connectionStatus').textContent; updateControls(); if (mode === 'mobile') refreshPanes().then(refreshContext); else resize(); };
  socket.onmessage = event => {
    if (ws !== socket) return;
    const msg = JSON.parse(event.data);
    if (msg.type === 'output') term.write(Uint8Array.from(atob(msg.data), c => c.charCodeAt(0)), () => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack', seq: msg.seq })); });
    else if (msg.type === 'mobile') { const waiting = pending.get(msg.requestId); if (waiting) { clearTimeout(waiting.timer); pending.delete(msg.requestId); msg.error ? waiting.reject(new Error(msg.error)) : waiting.resolve(msg.result); } }
    else if (msg.type === 'notice') { socket.lastNotice = msg.message; $('connectionStatus').textContent = msg.message; }
  };
  socket.onclose = event => {
    if (ws !== socket) return;
    expandReader(false);
    clearInput();
    ws = null; selectionEpoch++; contextUsage = {}; renderContextLine(); $('disconnect').disabled = true; $('connect').disabled = false; $('clients').disabled = false; $('statusDot').classList.remove('online');
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('連線中斷；若剛傳送 prompt，請先確認輸出再重試')); } pending.clear();
    lastDisconnect = `已中斷${socket.lastNotice || event.reason ? '：' + (socket.lastNotice || event.reason) : '，點此重新連線'}`;
    $('connectionStatus').textContent = lastDisconnect; $('devicePanel').open = true; updateControls();
  };
  socket.onerror = () => { $('connectionStatus').textContent = '無法連線，請確認 VDI 在線且沒有其他視窗操作'; };
}
async function switchMode(next) {
  if (next === mode || sending) return;
  if (next === 'mobile' && !devices.find(c => c.id === $('clients').value)?.mobile) { $('upgrade').hidden = false; return; }
  const wasConnected = !!ws;
  if (ws) { const old = ws; await new Promise(resolve => { old.addEventListener('close', resolve, { once: true }); old.close(); }); }
  setMode(next); if (wasConnected) connect();
}
$('loginForm').onsubmit = async event => {
  event.preventDefault(); const button = $('loginForm').querySelector('button[type=submit]'); button.disabled = true;
  try {
    const result = await api('/api/login', { password: $('password').value, ...(approvalEnabled ? { deviceName: $('deviceName').value, bootstrapCode: $('bootstrapCode').value.trim() } : {}) });
    $('password').value = ''; $('bootstrapCode').value = ''; $('loginError').textContent = '';
    if (result.status === 'pending') showApproval(result); else { showApproval(null); await refresh(); }
  } catch (error) { $('loginError').textContent = error.message; }
  finally { button.disabled = false; }
};
$('logout').onclick = async () => { if (approvalEnabled && !confirm('登出並忘記這個瀏覽器？下次登入須重新核准或使用本機配對碼。')) return; remember('herdr-connected', 'no'); ws?.close(); await api('/api/logout', {}); location.reload(); };
$('connect').onclick = connect; $('disconnect').onclick = () => { remember('herdr-connected', 'no'); ws?.close(); };
$('mobileMode').onclick = () => switchMode('mobile'); $('terminalMode').onclick = () => switchMode('terminal');
$('refreshPanes').onclick = refreshPanes;
$('readerExpand').onclick = () => expandReader(!readerExpanded, readerExpanded);
$('outputScroll').onclick = () => {
  if (!window.getSelection()?.toString()) expandReader(true);
};
$('outputScroll').onkeydown = event => {
  if (event.key === 'Enter' && event.target === $('outputScroll')) { event.preventDefault(); expandReader(true); }
};
$('latest').onclick = () => { followLatest = true; readerScroll.scrollTop = readerScroll.scrollHeight; };
$('textLayout').onchange = () => { remember('herdr-layout', $('textLayout').value); conversationSignature = ''; renderOutput(); updateControls(); readPane(); };
$('paneSort').onchange = () => { remember('herdr-sort', $('paneSort').value); renderPanes(); };
$('paneSearch').oninput = renderPanes;
$('workspaceFilter').onchange = renderPanes;
$('createWorkspace').onchange = updateCreateSources;
$('createSourcePane').onchange = updateCreateContext;
$('newWindow').onclick = () => {
  $('agentCommand').value = 'shell'; $('createError').textContent = '';
  $('createWorkspace').replaceChildren(); workspaceOptions($('createWorkspace'), workspaceRows);
  $('createWorkspace').value = panes.find(p => p.id === paneId)?.workspaceId || '';
  updateCreateSources(); $('createDialog').showModal();
};
$('launchAgent').onclick = () => { $('newWindow').onclick(); $('agentCommand').value = 'devin'; $('windowName').value = 'Devin'; };
$('agentCommand').onchange = () => { $('windowName').value = $('agentCommand').selectedOptions[0].textContent; };
const launchCommands = { devin: 'devin', codex: 'codex --dangerously-bypass-approvals-and-sandbox', claude: 'claude --allow-dangerously-skip-permissions' };
$('cancelCreate').onclick = () => { if (!creating) $('createDialog').close(); };
$('createDialog').oncancel = event => { if (creating) event.preventDefault(); };
$('createForm').onsubmit = async event => {
  event.preventDefault(); if (creating || !paneId) return;
  creating = true; $('submitCreate').disabled = true; $('cancelCreate').disabled = true; $('createError').textContent = '建立中…'; updateControls(); renderPanes();
  try {
    const agent = $('agentCommand').value;
    const source = panes.find(p => p.id === $('createSourcePane').value);
    if (!source || (source.workspaceId || '') !== $('createWorkspace').value) throw new Error('來源 workspace 或 pane 已改變，請重新選擇');
    const result = await rpc('create', { paneId: source.id, ...(source.workspaceId ? {workspaceId: source.workspaceId} : {}), label: $('windowName').value.trim() });
    let launchStatus = '新視窗已開啟';
    if (launchCommands[agent]) {
      try {
        await rpc('prompt', { paneId: result.paneId, text: launchCommands[agent] });
        launchStatus = `${agent} 啟動命令已送出`;
      } catch (error) { launchStatus = `視窗已建立；啟動未確認，請查看畫面：${error.message}`; }
      $('textLayout').value = 'lines'; remember('herdr-layout', 'lines');
    }
    while (listBusy) await new Promise(resolve => setTimeout(resolve, 50));
    $('paneSearch').value = ''; $('workspaceFilter').value = ''; await refreshPanes();
    if (panes.some(p => p.id === result.paneId)) selectPane(result.paneId);
    else { remember(paneStorageKey(), result.paneId); paneId = null; await refreshPanes(); }
    $('createDialog').close(); $('sendStatus').textContent = launchStatus;
  } catch (error) { $('createError').textContent = error.message; }
  finally { creating = false; $('submitCreate').disabled = false; $('cancelCreate').disabled = false; updateControls(); renderPanes(); }
};
$('closePane').onclick = () => {
  const pane = panes.find(p => p.id === paneId); if (!pane?.terminalId) return;
  closeTarget = { paneId: pane.id, terminalId: pane.terminalId, socket: ws, draftKey: paneStorageKey() + ':' + pane.id };
  closeAttempted = false; $('confirmClosePane').disabled = false; $('closePaneError').textContent = '';
  $('closePaneContext').textContent = `${pane.title} · ${pane.id} · ${pane.workspace || ''}${pane.agent ? ' · ' + pane.agent : ''}`;
  $('closePaneDialog').showModal();
};
$('cancelClosePane').onclick = () => { if (!closing) { closeTarget = null; $('closePaneDialog').close(); } };
$('closePaneDialog').oncancel = event => { if (closing) event.preventDefault(); else closeTarget = null; };
$('closePaneForm').onsubmit = async event => {
  event.preventDefault(); const target = closeTarget;
  if (closing || closeAttempted || !target) return;
  if (target.socket !== ws || ws?.readyState !== WebSocket.OPEN) { $('closePaneError').textContent = '連線已變更，請取消後重新確認'; return; }
  closing = true; closeAttempted = true; $('confirmClosePane').disabled = true; $('cancelClosePane').disabled = true;
  $('closePaneError').textContent = '關閉中…'; updateControls(); renderPanes();
  try {
    await rpc('close', {paneId: target.paneId, terminalId: target.terminalId, confirmed: true});
    drafts.delete(target.draftKey); if (paneId === target.paneId) $('prompt').value = '';
    closeTarget = null; $('closePaneDialog').close();
    while (listBusy) await pause(25);
    closing = false; await refreshPanes(); $('sendStatus').textContent = `${target.paneId} 已關閉`;
  } catch (error) { $('closePaneError').textContent = `${error.message}；請取消並更新清單確認，勿重複關閉。`; }
  finally { closing = false; $('cancelClosePane').disabled = false; updateControls(); renderPanes(); }
};
const keys = { enter: ['\r', 'enter'], prefix: ['\x02', null], escape: ['\x1b', 'esc'], tab: ['\t', 'tab'], interrupt: ['\x03', 'ctrl+c'], up: ['\x1b[A', 'up'], down: ['\x1b[B', 'down'] };
document.querySelectorAll('[data-key]').forEach(button => button.onclick = async () => {
  const [data, key] = keys[button.dataset.key];
  if (mode === 'terminal') send({ type: 'input', data });
  else if (paneId && key) { try { await rpc('key', { paneId, key }); readPane(); } catch (error) { $('sendStatus').textContent = error.message; } }
});
$('keyboard').onclick = () => term.focus();
$('prompt').addEventListener('keydown', event => {
  // Enter keeps inserting newlines; Shift+Enter submits without adding one.
  if (event.key === 'Enter' && event.shiftKey && !event.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault(); $('promptForm').requestSubmit();
  }
});
$('promptForm').onsubmit = async event => {
  event.preventDefault(); if (ws?.readyState !== WebSocket.OPEN || !$('prompt').value.trim() || sending) return;
  const text = $('prompt').value, target = paneId;
  if (mode === 'mobile' && text.trim() === '/model' && ['devin', 'codex', 'claude'].includes(panes.find(p => p.id === target)?.agent)) {
    await $('modelButton').onclick();
    if (modelSession?.menu?.active && $('prompt').value === text) { $('prompt').value = ''; drafts.delete(paneStorageKey() + ':' + target); }
    return;
  }
  if (text.length > 12000) { $('sendStatus').textContent = '最多 12,000 字元'; return; }
  sending = true; $('sendStatus').textContent = '傳送中…'; updateControls(); renderPanes();
  try {
    if (mode === 'mobile') { if (!target) throw new Error('請選擇 pane'); await rpc('prompt', { paneId: target, text }); }
    else { const active = ws; term.paste(text); await new Promise(resolve => setTimeout(resolve, 350)); if (ws !== active || active.readyState !== WebSocket.OPEN) throw new Error('輸入後連線中斷，尚未送出 Enter'); send({ type: 'input', data: '\r' }); }
    if ($('prompt').value === text) $('prompt').value = ''; drafts.delete(paneStorageKey() + ':' + target);
    $('sendStatus').textContent = mode === 'mobile' ? '已送交 pane ✓' : '已傳送'; readPane();
  } catch (error) { $('sendStatus').textContent = error.message; }
  finally { sending = false; updateControls(); renderPanes(); }
};
let modelSession = null, modelBusy = false, modelPolling = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function modelConnected(state) { return state === modelSession && state.socket === ws && ws?.readyState === WebSocket.OPEN && state.paneId === paneId; }
function renderModelMenu() {
  const state = modelSession, menu = state?.menu;
  $('modelScreen').textContent = menu?.text || '';
  $('modelOptions').replaceChildren(...(menu?.options || []).map(option => {
    const button = document.createElement('button'); button.textContent = option.label;
    button.setAttribute('aria-pressed', String(option.index === menu.selected));
    button.disabled = modelBusy || !menu.active || !modelConnected(state);
    button.onclick = () => selectModelOption(option.id);
    return button;
  }));
  document.querySelectorAll('[data-model-key]').forEach(button => button.disabled = modelBusy || !menu?.active || !modelConnected(state));
  $('closeModel').disabled = modelBusy;
}
async function readModelMenu(state) {
  if (!modelConnected(state)) throw new Error('連線或 pane 已改變，請重新開啟 Model');
  const result = await rpc('read', { paneId: state.paneId, view: 'menu' });
  if (!modelConnected(state)) return;
  if (result.view !== 'menu') throw new Error('請更新此裝置的 bridge，才能讀取即時模型選單');
  state.menu = modelMenu(result.text, state.agent);
  renderModelMenu();
}
async function modelAction(action) {
  const state = modelSession;
  if (modelBusy || !state) return;
  modelBusy = true; renderModelMenu();
  try {
    while (modelPolling) await pause(25);
    await action(state);
  }
  catch (error) { $('modelStatus').textContent = error.message; }
  finally { modelBusy = false; renderModelMenu(); }
}
async function modelKey(state, key) {
  if (!modelConnected(state) || !state.menu?.active) throw new Error('目前沒有可操作的模型選單');
  await rpc('key', { paneId: state.paneId, key });
  await pause(250); await readModelMenu(state);
  $('modelStatus').textContent = state.menu?.active ? '點選項目，再按「確認」。可用方向鍵查看其他選項與 effort。' : '選單已結束；可關閉此視窗返回對話。';
}
function selectModelOption(id) {
  return modelAction(async state => {
    await readModelMenu(state);
    for (let i = 0; i < 30; i++) {
      const menu = state.menu, target = menu.options.findIndex(option => option.id === id);
      if (!menu.active || target < 0) throw new Error('選單已更新，請重新選取');
      if (menu.selected === target) return;
      await modelKey(state, menu.selected < target ? 'down' : 'up');
    }
    throw new Error('未能定位選項，請使用方向鍵');
  });
}
$('modelButton').onclick = async () => {
  if (modelSession || sending || !paneId) return;
  const state = { paneId, socket: ws, agent: panes.find(p => p.id === paneId)?.agent, menu: null };
  modelSession = state; $('modelTitle').textContent = `Model · ${state.agent}`;
  $('modelStatus').textContent = '正在開啟模型選單…'; $('modelDialog').showModal();
  await modelAction(async () => {
    const result = await rpc('panes');
    const target = result.panes?.find(p => p.id === state.paneId);
    if (!modelConnected(state) || target?.agent !== state.agent) throw new Error('Pane 或 agent 已改變，請重新開啟 Model');
    // Check bridge support before sending /model; never retry an uncertain prompt.
    await readModelMenu(state);
    if (!state.menu.active) await rpc('prompt', { paneId: state.paneId, text: '/model' });
    for (let i = 0; i < 8; i++) { await pause(250); await readModelMenu(state); if (state.menu.active) break; }
    $('modelStatus').textContent = state.menu.active ? '點選項目，再按「確認」。可用方向鍵查看其他選項與 effort。' : '未辨識到模型選單；請關閉後查看原始畫面。';
    $('modelDetails').open = !state.menu.active;
  });
};
document.querySelectorAll('[data-model-key]').forEach(button => button.onclick = () => modelAction(async state => { await readModelMenu(state); await modelKey(state, button.dataset.modelKey); }));
$('closeModel').onclick = () => modelAction(async state => {
  if (modelConnected(state) && state.menu?.active) {
    await readModelMenu(state);
    for (let i = 0; i < 3 && state.menu?.active; i++) await modelKey(state, 'esc');
    if (state.menu?.active) throw new Error('選單仍開啟，請使用返回按鈕');
  }
  modelSession = null; $('modelDialog').close();
});
$('modelDialog').oncancel = event => { event.preventDefault(); $('closeModel').click(); };
setInterval(async () => {
  const state = modelSession;
  if (!state || modelBusy || modelPolling) return;
  modelPolling = true;
  try { await readModelMenu(state); }
  catch (error) { $('modelStatus').textContent = error.message; }
  finally { modelPolling = false; renderModelMenu(); }
}, 1000);
function contextText(usage) {
  const k = n => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  if (usage.used != null && usage.window) return `Context ${k(usage.used)} / ${k(usage.window)} · ${Math.round(usage.percent)}%`;
  if (usage.used != null) return `Context ${k(usage.used)} tokens`;
  if (usage.percent != null) return `Context 已用 ${Math.round(usage.percent)}%${usage.basis === 'auto-compact' ? '（距 auto-compact）' : ''}`;
  return 'Context 未知';
}
function renderContextLine() {
  const usage = contextUsage[paneId], line = $('paneContext');
  line.hidden = !usage; line.textContent = usage ? contextText(usage) + (usage.source === 'screen' ? ' · 來自畫面' : usage.source === 'transcript' ? ' · 來自紀錄' : '') : '';
  line.classList.toggle('high', (usage?.percent ?? 0) >= 80);
}
async function refreshContext() {
  if (contextBusy || mode !== 'mobile' || ws?.readyState !== WebSocket.OPEN || document.hidden) return;
  if ((devices.find(d => d.id === $('clients').value)?.mobileVersion || 0) < 4) return;
  contextBusy = true; const activeSocket = ws;
  try {
    const result = await rpc('context');
    if (ws !== activeSocket) return;
    contextUsage = result.usage || {}; renderPanes(); renderContextLine();
  } catch {} finally { contextBusy = false; }
}
const clearCommands = { claude: '/clear', devin: '/clear', codex: '/new' };
const HANDOVER_PATH = '.herdr/handover.md';
const handoverPrompt = `Write a handover document for a fresh session to ${HANDOVER_PATH} (relative to your current working directory; create the directory if needed and overwrite any existing file). Include: the overall goal, current state, key decisions and why, files changed, commands/tests run and their results, open problems, user preferences or constraints, and exact next steps. Use absolute file paths. Do not include secrets or credentials. Do not start any other work. When the file is written, reply only: handover written.`;
const resumePrompt = `Read ${HANDOVER_PATH} in your current working directory. It is a handover from your previous context. Summarize your understanding in three short bullets, then continue with the next steps it lists.`;
async function paneStatus(target) {
  const result = await rpc('panes');
  return result.panes?.find(p => p.id === target.paneId);
}
function contextGuard(target) {
  if (target.socket !== ws || ws?.readyState !== WebSocket.OPEN) throw new Error('連線已變更，已停止');
}
async function waitForIdle(target, report) {
  let started = false; const begin = Date.now();
  while (Date.now() - begin < 10 * 60000) {
    await pause(2000); contextGuard(target);
    const pane = await paneStatus(target);
    if (!pane || pane.agent !== target.agent) throw new Error('Pane 或 agent 已改變，已停止');
    if (pane.status === 'blocked') throw new Error('Agent 正在等待回覆（可能需要授權），已停止；請查看原始畫面');
    if (pane.status === 'working') { started = true; report(`Agent 正在寫交接檔…（${Math.round((Date.now() - begin) / 1000)} 秒）`); continue; }
    if (started) return;
    if (Date.now() - begin > 30000) throw new Error('未觀測到 agent 開始工作，已停止；請查看原始畫面');
  }
  throw new Error('等待超過 10 分鐘，已停止；交接檔可能尚未完成');
}
function openContextDialog(action) {
  const pane = panes.find(p => p.id === paneId); if (!pane || !Object.hasOwn(clearCommands, pane.agent)) return;
  contextAction = { action, paneId: pane.id, agent: pane.agent, socket: ws };
  const command = clearCommands[pane.agent];
  $('contextTitle').textContent = action === 'clear' ? 'Clear context' : 'Migration context';
  $('contextTarget').textContent = `${pane.title} · ${pane.id} · ${pane.agent}`;
  $('contextExplain').textContent = action === 'clear'
    ? `送出 ${command}，清空目前 context。對話內容無法從網頁復原。`
    : `1. 請 agent 寫入 ${HANDOVER_PATH}　2. 完成後送出 ${command}　3. 請新 context 讀回交接檔並接續。任一步失敗即停止。`;
  $('contextStatus').textContent = ''; $('confirmContext').disabled = false; $('cancelContext').disabled = false;
  $('contextDialog').showModal();
}
$('clearContext').onclick = () => openContextDialog('clear');
$('migrateContext').onclick = () => openContextDialog('migrate');
$('cancelContext').onclick = () => { if (!contextRunning) { contextAction = null; $('contextDialog').close(); } };
$('contextDialog').oncancel = event => { if (contextRunning) event.preventDefault(); else contextAction = null; };
$('contextForm').onsubmit = async event => {
  event.preventDefault(); const target = contextAction;
  if (contextRunning || !target) return;
  const report = text => { $('contextStatus').textContent = text; $('sendStatus').textContent = text; };
  contextRunning = true; $('confirmContext').disabled = true; $('cancelContext').disabled = true; updateControls();
  try {
    contextGuard(target);
    const pane = await paneStatus(target);
    if (!pane || pane.agent !== target.agent) throw new Error('Pane 或 agent 已改變，請重新開啟');
    if (['working', 'blocked'].includes(pane.status)) throw new Error('Agent 正在工作或等待回覆，請等它待命後再試');
    const command = clearCommands[target.agent];
    if (target.action === 'migrate') {
      report('請 agent 寫入交接檔…');
      await rpc('prompt', { paneId: target.paneId, text: handoverPrompt });
      await waitForIdle(target, report);
    }
    contextGuard(target); report(`送出 ${command}…`);
    await rpc('prompt', { paneId: target.paneId, text: command });
    if (target.action === 'migrate') {
      await pause(3000); contextGuard(target); report('請新 context 讀回交接檔…');
      await rpc('prompt', { paneId: target.paneId, text: resumePrompt });
    }
    delete contextUsage[target.paneId]; renderContextLine(); renderPanes();
    contextAction = null; $('contextDialog').close();
    report(target.action === 'migrate' ? `Migration 完成；交接檔保留在 ${HANDOVER_PATH}` : `已送出 ${command}`);
    readPane();
  } catch (error) { report(`${error.message}。不會自動重試。`); }
  finally { contextRunning = false; $('cancelContext').disabled = false; updateControls(); }
};
function configureApproval(enabled) {
  approvalEnabled = enabled;
  $('deviceLoginFields').hidden = !enabled;
  // A local bootstrap code supplies the name from the host; normal requests
  // are validated by the server, including when JavaScript is bypassed.
  $('manageDevices').hidden = !enabled || !loggedIn;
  $('logout').textContent = enabled ? '登出並忘記此瀏覽器' : '登出';
}
function showApproval(request) {
  waitingApproval = !!request;
  $('approvalWaiting').hidden = !request;
  $('loginForm').hidden = !!request;
  $('approvalCode').textContent = request?.code || '';
  $('approvalExpires').textContent = request ? `申請 ${request.name} · 有效至 ${new Date(request.expiresAt).toLocaleTimeString()}（5 分鐘內）` : '';
}
async function pollApproval(initial = false) {
  if (!approvalEnabled || loggedIn || approvalBusy || (!initial && !waitingApproval)) return;
  approvalBusy = true;
  try {
    const result = await api('/api/auth/request');
    if (result.status === 'pending') showApproval(result);
    else if (result.status === 'approved') { showApproval(null); await refresh(); }
    else if (waitingApproval) { showApproval(null); $('loginError').textContent = result.status === 'denied' ? '申請已被拒絕，或核准裝置已撤銷。' : '申請已過期，請重新登入申請。'; }
  } catch (error) { $('loginError').textContent = error.message; }
  finally { approvalBusy = false; }
}
async function authAction(action) {
  if (deviceAuthBusy) return;
  deviceAuthBusy = true; $('deviceAuthError').textContent = '';
  try { await action(); }
  catch (error) { $('deviceAuthError').textContent = error.message; }
  finally { deviceAuthBusy = false; await refreshAuthorizations(); }
}
async function refreshAuthorizations() {
  if (!approvalEnabled || !loggedIn || deviceAuthBusy) return;
  deviceAuthBusy = true;
  try {
    const data = await api('/api/auth/devices');
    $('manageDevices').textContent = data.requests.length ? `裝置信任（${data.requests.length}）` : '裝置信任';
    $('approvalNotice').hidden = !data.requests.length;
    $('approvalNotice').textContent = `${data.requests.length} 個新瀏覽器等待核准，點此核對配對碼`;
    const requests = $('deviceRequests'), browsers = $('trustedBrowsers');
    requests.replaceChildren(); browsers.replaceChildren();
    if (!data.requests.length) requests.textContent = '目前沒有申請。';
    for (const request of data.requests) {
      const card = document.createElement('article'), name = document.createElement('strong'), info = document.createElement('p'), code = document.createElement('code'), actions = document.createElement('div');
      name.textContent = request.name; info.textContent = `${request.userAgent} · 申請於 ${new Date(request.createdAt).toLocaleString()}`; code.textContent = request.code; actions.className = 'device-actions';
      for (const [approve, label] of [[true, '同意此瀏覽器'], [false, '拒絕']]) {
        const button = document.createElement('button'); button.textContent = label;
        button.onclick = () => authAction(async () => {
          if (approve && !confirm(`確認新瀏覽器「${request.name}」顯示配對碼 ${request.code}？核准後可操作主機，並核准其他瀏覽器。`)) return;
          await api('/api/auth/decide', { requestId: request.id, code: request.code, approve });
        }); actions.append(button);
      }
      card.append(name, info, code, actions); requests.append(card);
    }
    for (const device of data.devices) {
      const card = document.createElement('article'), name = document.createElement('strong'), info = document.createElement('p'), button = document.createElement('button');
      const current = device.id === data.currentDeviceId;
      name.textContent = device.name + (current ? '（目前瀏覽器）' : '');
      info.textContent = `${device.userAgent} · 有效至 ${new Date(device.expiresAt).toLocaleDateString()}`;
      button.textContent = '撤銷信任';
      button.onclick = () => authAction(async () => {
        if (!confirm(`撤銷「${device.name}」並中斷它的連線？${data.devices.length === 1 ? '這是最後一個裝置，之後須用本機配對碼恢復。' : ''}`)) return;
        await api('/api/auth/revoke', { deviceId: device.id, confirmed: true });
        if (current) location.reload();
      });
      card.append(name, info, button); browsers.append(card);
    }
  } catch (error) { $('deviceAuthError').textContent = error.message; }
  finally { deviceAuthBusy = false; }
}
$('manageDevices').onclick = async () => { $('deviceDialog').showModal(); await refreshAuthorizations(); };
$('approvalNotice').onclick = () => $('manageDevices').click();
$('closeDeviceDialog').onclick = () => $('deviceDialog').close();
$('cancelApproval').onclick = async () => {
  try { await api('/api/auth/request', {}); showApproval(null); }
  catch (error) { $('loginError').textContent = error.message; }
};
api('/api/auth/config').then(async config => { configureApproval(config.deviceApproval === true); if (approvalEnabled) { await pollApproval(true); await refreshAuthorizations(); } }).catch(error => { $('loginError').textContent = error.message; });
setInterval(() => { if (!document.hidden) pollApproval(); }, 2000);
setInterval(() => { if (!document.hidden) refreshAuthorizations(); }, 5000);
function promptConnected(state) {
  return state && state === promptState && state.socket === ws && ws?.readyState === WebSocket.OPEN && state.paneId === paneId;
}
function renderAgentPrompt() {
  const state = promptState, menu = state?.menu;
  $('agentPrompt').hidden = !state;
  if (!state) return;
  $('agentQuestion').textContent = menu?.active ? menu.question || '(沒有辨識到問題文字，請看即時畫面)' : '未辨識到可選的項目；請查看即時畫面，或切到「保留分行」／完整終端。';
  $('agentQuestion').hidden = false;
  $('agentScreen').textContent = state.text.split('\n').slice(-60).join('\n');
  if (!menu?.active) $('agentScreenDetails').open = true;
  const disabled = promptBusy || !menu?.active || !promptConnected(state);
  $('agentOptions').replaceChildren(...(menu?.options || []).map(option => {
    const button = document.createElement('button'); button.type = 'button';
    button.setAttribute('aria-pressed', String(option.index === menu.selected));
    const label = document.createElement('span'); label.textContent = `${option.index + 1}. ${option.label}`; button.append(label);
    if (option.detail) { const detail = document.createElement('small'); detail.textContent = option.detail; button.append(detail); }
    button.disabled = disabled; button.onclick = () => choosePromptOption(option.id);
    return button;
  }));
  $('agentSubmit').disabled = disabled; $('agentCancel').disabled = promptBusy || !promptConnected(state);
}
async function readAgentPrompt(state) {
  if (!promptConnected(state)) throw new Error('連線或 pane 已改變，已停止');
  const result = await rpc('read', { paneId: state.paneId, view: 'menu' });
  if (!promptConnected(state)) return;
  if (result.view !== 'menu') throw new Error('請更新此裝置的 bridge，才能讀取即時畫面');
  state.text = result.text || ''; state.menu = agentPrompt(state.text);
  renderAgentPrompt();
}
async function pollAgentPrompt() {
  const pane = panes.find(p => p.id === paneId);
  const waiting = mode === 'mobile' && ws?.readyState === WebSocket.OPEN && pane?.status === 'blocked' && !modelSession && !document.hidden;
  if (!waiting) { if (promptState && !promptBusy) { promptState = null; renderAgentPrompt(); } return; }
  if (promptBusy || promptPolling) return;
  if (!promptState || promptState.paneId !== paneId || promptState.socket !== ws) promptState = { paneId, socket: ws, text: '', menu: null };
  const state = promptState; promptPolling = true;
  try { await readAgentPrompt(state); } catch (error) { if (state === promptState) $('agentPromptStatus').textContent = error.message; }
  finally { promptPolling = false; }
}
async function promptAction(action) {
  const state = promptState;
  if (promptBusy || !state) return;
  promptBusy = true; renderAgentPrompt();
  try { while (promptPolling) await pause(25); await action(state); }
  catch (error) { $('agentPromptStatus').textContent = error.message; }
  finally { promptBusy = false; renderAgentPrompt(); }
}
function choosePromptOption(id) {
  return promptAction(async state => {
    await readAgentPrompt(state);
    for (let i = 0; i < 30; i++) {
      const menu = state.menu, target = menu?.options.findIndex(option => option.id === id) ?? -1;
      if (!menu?.active || target < 0) throw new Error('選項已改變，請重新選取');
      if (menu.selected === target) { $('agentPromptStatus').textContent = '確認無誤後按「送出選擇」'; return; }
      await rpc('key', { paneId: state.paneId, key: menu.selected < target ? 'down' : 'up' });
      await pause(200); await readAgentPrompt(state);
    }
    throw new Error('未能定位選項，請改用原始畫面');
  });
}
$('agentSubmit').onclick = () => promptAction(async state => {
  const expected = state.menu?.options[state.menu.selected]?.id;
  await readAgentPrompt(state);
  if (!state.menu?.active || state.menu.options[state.menu.selected]?.id !== expected) throw new Error('畫面已改變，請確認後再送出');
  await rpc('key', { paneId: state.paneId, key: 'enter' });
  $('agentPromptStatus').textContent = `已送出：${expected}`; $('sendStatus').textContent = `已回覆 agent：${expected}`;
  await pause(500); refreshPanes(); readPane();
});
$('agentCancel').onclick = () => promptAction(async state => {
  await rpc('key', { paneId: state.paneId, key: 'esc' });
  $('agentPromptStatus').textContent = '已送出 Esc'; await pause(500); refreshPanes(); readPane();
});
setMode(mode); refresh(); setInterval(refresh, 5000); setInterval(pollAgentPrompt, 1500); setInterval(refreshContext, 30000); setInterval(readPane, 1500); setInterval(refreshPanes, 5000);
