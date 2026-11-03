const $ = id => document.getElementById(id);
const term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000, theme: { background: '#101315', foreground: '#e4e9e4' }, allowProposedApi: false });
const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
let ws, opened = false, loggedIn = false;
if (location.protocol === 'https:') $('transport').hidden = true;
async function api(path, data) {
  const res = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await res.json(); if (!res.ok) throw new Error(result.error || '連線失敗'); return result;
}
function send(data) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function resize() { if (opened && !$('terminal').hidden) { fit.fit(); send({ type: 'resize', cols: term.cols, rows: term.rows }); } }
term.onData(data => send({ type: 'input', data }));
term.onBinary(data => send({ type: 'input', data: btoa(data), binary: true }));
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe($('terminal'));
async function refresh() {
  try {
    const data = await api('/api/clients');
    loggedIn = true; $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
    const selected = $('clients').value;
    $('clients').replaceChildren(...data.clients.map(c => {
      const option = document.createElement('option'); option.value = c.id; option.textContent = `${c.label} · ${c.online ? (c.busy ? '使用中' : '在線') : '離線'}`; option.disabled = !c.online; return option;
    }));
    if (data.clients.some(c => c.id === selected)) $('clients').value = selected;
    $('connect').disabled = !!ws || !data.clients.some(c => c.online);
    if (!ws) $('connectionStatus').textContent = data.clients.some(c => c.online) ? '選擇裝置並連線' : '等待 VDI client';
  } catch (error) {
    if (loggedIn) { $('connectionStatus').textContent = error.message; }
  }
}
$('loginForm').onsubmit = async event => { event.preventDefault(); try { await api('/api/login', { password: $('password').value }); $('password').value = ''; $('loginError').textContent = ''; await refresh(); } catch (error) { $('loginError').textContent = error.message; } };
$('logout').onclick = async () => { ws?.close(); await api('/api/logout', {}); location.reload(); };
$('connect').onclick = () => {
  if (ws || !$('clients').value) return;
  $('empty').hidden = true; $('terminal').hidden = false; $('controls').hidden = false;
  if (!opened) { term.open($('terminal')); opened = true; }
  term.reset(); fit.fit(); $('connectionStatus').textContent = '正在附加 herdr…';
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/terminal?id=${encodeURIComponent($('clients').value)}`);
  ws = socket; $('connect').disabled = true; $('disconnect').disabled = false;
  socket.onopen = () => { resize(); term.focus(); };
  socket.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'output') {
      const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
      term.write(bytes, () => send({ type: 'ack', seq: msg.seq }));
      $('connectionStatus').textContent = '已連線 · 操作目前的 herdr';
    } else if (msg.type === 'notice') $('connectionStatus').textContent = msg.message;
  };
  socket.onclose = event => { if (ws !== socket) return; ws = null; $('disconnect').disabled = true; $('connect').disabled = false; $('connectionStatus').textContent = `已中斷${event.reason ? '：' + event.reason : '，可重新連線'}`; };
  socket.onerror = () => { $('connectionStatus').textContent = '連線失敗：請確認 VDI 在線，且沒有其他視窗正在操作'; };
};
$('disconnect').onclick = () => ws?.close();
const keys = { prefix: '\x02', escape: '\x1b', tab: '\t', interrupt: '\x03', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C' };
document.querySelectorAll('[data-key]').forEach(button => button.onclick = () => { send({ type: 'input', data: keys[button.dataset.key] }); term.focus(); });
$('keyboard').onclick = () => term.focus();
$('promptForm').onsubmit = event => {
  event.preventDefault(); if (ws?.readyState !== WebSocket.OPEN || !$('prompt').value) return;
  const text = $('prompt').value;
  if (text.length > 12000) { $('connectionStatus').textContent = '請將 prompt 控制在 12,000 字元內'; return; }
  term.paste(text); send({ type: 'input', data: '\r' }); $('prompt').value = '';
};
refresh(); setInterval(refresh, 5000);
