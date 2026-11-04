#!/usr/bin/env python3
"""Outbound-only herdr terminal bridge. Python 3.9+, Linux/macOS/WSL."""
import argparse
import base64
import getpass
import hashlib
import json
import os
import queue
import re
import select
import shlex
import shutil
import signal
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor


def claude_placeholder(prompt, ansi):
    # Claude renders the cursor over the first T of its dynamic Try "…" hint.
    # A plain text draft that happens to start with Try must not be submitted.
    if not re.fullmatch(r'Try "[^"\n]+"', prompt) or not isinstance(ansi, str):
        return False
    lines = [line for line in ansi.splitlines() if '❯' in line]
    if not lines:
        return False
    line = lines[-1]
    plain = re.sub(r'\x1b\[[0-9;]*m', '', line).strip()
    if plain.lstrip('❯').strip() != prompt:
        return False
    return bool(re.search(r'\x1b\[(?:[0-9;]*;)?7mT(?:\x1b\[[0-9;]*m)*ry "', line))


def model_prompt_ready(text, agent, ansi=None):
    """Only open slash menus at an empty input, preserving native terminal drafts."""
    marker = {'codex': '›', 'claude': '❯', 'devin': '❭'}.get(agent)
    if not marker:
        return False
    matches = list(re.finditer(r'^[ \t]*' + marker + r'[ \t]?([^\n]*)$', text, re.MULTILINE))
    if not matches:
        return False
    prompt = matches[-1].group(1).strip()
    placeholders = {
        'Ask Codex to do anything', 'Find and fix a bug in @filename',
        'Implement {feature}', 'Explain this codebase', 'Write tests for @filename',
        'Summarize recent commits', 'Improve documentation in @filename',
    }
    empty = (not prompt or (agent == 'codex' and prompt in placeholders)
             or (agent == 'devin' and prompt == 'Ask Devin to build features, fix bugs, or work on your code')
             or (agent == 'claude' and claude_placeholder(prompt, ansi)))
    if not empty:
        return False
    # A multiline draft can start with an empty first line. Only permit the
    # input border or known Codex status footer after the prompt.
    for line in text[matches[-1].end():].splitlines():
        line = line.strip()
        if not line:
            continue
        if re.match(r'^[─━▔]{3,}', line):
            return True
        if agent == 'codex' and (re.match(r'^(?:GPT-|gpt-|[0-9]+% context|← for agents|\? for shortcuts)', line)):
            return True
        return False
    return True


def read_devin_conversation(binding):
    """Read the active message chain in Devin CLI 3000.11.92's SQLite schema.

    This is a local, explicit session mapping, never a browser-supplied path.
    Do not read rendered HTML, alternate branches, or model reasoning fields.
    """
    path, session = binding.get('path'), binding.get('sessionId')
    if not isinstance(path, str) or not os.path.isabs(path) or not isinstance(session, str) or not session:
        raise ValueError('Devin 對話設定須指定絕對路徑及 sessionId')
    if not stat.S_ISREG(os.lstat(path).st_mode):
        raise ValueError('Devin 對話來源必須是一般 SQLite 檔案，不接受符號連結')
    entries, nodes, seen = [], [], set()
    clipped = False
    connection = None
    try:
        uri = 'file:' + urllib.parse.quote(path, safe='/') + '?mode=ro'
        connection = sqlite3.connect(uri, uri=True, timeout=1)
        connection.execute('PRAGMA query_only=ON')
        connection.execute('PRAGMA trusted_schema=OFF')
        deadline = time.monotonic() + 2
        connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        connection.execute('BEGIN')
        row = connection.execute('SELECT main_chain_id, working_directory FROM sessions WHERE id=?', (session,)).fetchone()
        if row is None:
            raise ValueError('Devin session ID 不存在；不會改讀其他對話')
        if binding.get('cwd') and binding['cwd'] != row[1]:
            raise ValueError('Devin session 工作目錄不符')
        node = row[0]
        read_bytes = 0
        while node is not None and len(seen) < 100:
            if node in seen:
                raise ValueError('Devin 對話鏈包含循環')
            seen.add(node)
            row = connection.execute(
                'SELECT parent_node_id, length(CAST(chat_message AS BLOB)), '
                'CASE WHEN length(CAST(chat_message AS BLOB)) <= 1048576 THEN chat_message END '
                'FROM message_nodes WHERE session_id=? AND node_id=?', (session, node)).fetchone()
            if row is None:
                raise ValueError('Devin 對話鏈不完整')
            if row[2] is None:
                clipped = True
            else:
                read_bytes += row[1]
                if read_bytes > 2 * 1024 * 1024:
                    clipped = True
                    break
                nodes.append((node, json.loads(row[2])))
            node = row[0]
        clipped = clipped or node is not None
    except (sqlite3.Error, json.JSONDecodeError) as error:
        raise ValueError('Devin 對話資料暫時無法讀取或格式不支援') from error
    finally:
        if connection is not None:
            connection.close()
    def add(node_id, kind, text):
        nonlocal clipped
        if not isinstance(text, str) or not text:
            return
        clipped = clipped or len(text) > 6000
        entries.append({'kind': kind, 'text': text[:6000],
                        'id': hashlib.sha256((session + ':' + str(node_id) + ':' + kind + ':' + text).encode()).hexdigest()[:20]})
    for node_id, message in reversed(nodes):
        if not isinstance(message, dict):
            continue
        role = message.get('role')
        if role not in ('user', 'assistant', 'tool'):
            continue
        calls = message.get('tool_calls')
        calls = calls if isinstance(calls, list) else []
        kind = 'progress' if role == 'assistant' and calls else role
        add(node_id, kind, message.get('content'))
        for call in calls[:128]:
            if isinstance(call, dict):
                add(node_id, 'tool', str(call.get('name', '工具')) + '\n' + json.dumps(call.get('arguments', {}), ensure_ascii=False))
    kept, budget = [], 0
    for entry in reversed(entries[-100:]):
        cost = len(json.dumps(entry, ensure_ascii=False).encode())
        if budget + cost > 60000:
            break
        kept.append(entry)
        budget += cost
    return {'sessionId': session, 'agent': 'devin', 'readOnly': True,
            'truncated': bool(clipped or len(kept) < len(entries)), 'entries': list(reversed(kept))}


def read_conversation(binding):
    """Bounded, read-only JSONL projection. Paths are local config, never RPC input.

    Inspired by herdr-acp's explicit-log mirror, not its attach protocol.
    This is history, not an approval UI or proof of a live process identity.
    """
    if binding.get('agent') == 'devin':
        return read_devin_conversation(binding)
    agent, path, session = binding['agent'], binding['path'], binding['sessionId']
    if agent not in ('codex', 'claude') or not isinstance(path, str) or not os.path.isabs(path) or not isinstance(session, str) or not session:
        raise ValueError('對話設定須指定 codex/claude、絕對路徑及 sessionId')
    flags = os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('對話來源必須是一般檔案')
        # Validate a bounded header, then read a bounded tail, never whole logs.
        header = source.read(min(info.st_size, 1024 * 1024))
        start = max(0, info.st_size - 2 * 1024 * 1024)
        source.seek(start)
        tail = source.read(info.st_size - start)
        if start:
            tail = tail.partition(b'\n')[2]
        if os.fstat(source.fileno()).st_size < info.st_size:
            raise ValueError('對話檔案正在重寫，請稍後再試')
    def records(data):
        for line in data.splitlines(keepends=True):
            if not line.endswith(b'\n') or len(line) > 1024 * 1024:
                continue
            try:
                item = json.loads(line)
                if isinstance(item, dict):
                    yield item
            except (ValueError, UnicodeError):
                continue
    def record_session(record):
        if agent == 'claude':
            return record.get('sessionId')
        if record.get('type') == 'session_meta' and isinstance(record.get('payload'), dict):
            return record['payload'].get('id') or record['payload'].get('session_id')
    if not any(record_session(r) == session for r in records(header)):
        raise ValueError('對話 session ID 不符或無法驗證；不會改讀其他檔案')
    entries, seen = [], set()
    clipped = False
    def words(content):
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return '\n'.join(b.get('text', '') for b in content if isinstance(b, dict)
                             and b.get('type') in ('text', 'input_text', 'output_text', 'summary_text')
                             and isinstance(b.get('text'), str))
        return ''
    def add(kind, text):
        nonlocal clipped
        if not isinstance(text, str):
            text = json.dumps(text, ensure_ascii=False)
        if text:
            clipped = clipped or len(text) > 6000
            entries.append({'kind': kind, 'text': text[:6000],
                            'id': hashlib.sha256((str(index) + kind + text).encode()).hexdigest()[:20]})
    for index, record in enumerate(records(tail)):
        claimed = record_session(record)
        if claimed and claimed != session:
            raise ValueError('對話紀錄含不同 session，已停止顯示')
        if agent == 'codex':
            if record.get('type') != 'response_item':
                continue  # event_msg duplicates response_item; never replay it.
            payload = record.get('payload')
            if not isinstance(payload, dict):
                continue
            kind = payload.get('type')
            if kind == 'message' and payload.get('role') in ('user', 'assistant'):
                role = payload['role']
                if role == 'assistant' and payload.get('phase') == 'commentary':
                    role = 'progress'
                add(role, words(payload.get('content')))
            elif kind == 'reasoning':
                add('thinking', words(payload.get('summary')) or '此紀錄沒有可顯示的思考摘要')
            elif kind in ('function_call', 'custom_tool_call'):
                add('tool', str(payload.get('name', '工具')) + '\n' + str(payload.get('arguments', payload.get('input', ''))))
            elif kind in ('function_call_output', 'custom_tool_call_output'):
                add('tool', words(payload.get('output')))
        else:
            if record.get('isSidechain') or claimed != session:
                continue
            uuid = record.get('uuid') if isinstance(record.get('uuid'), str) else None
            if uuid and uuid in seen:
                continue
            if uuid:
                seen.add(uuid)
            role = record.get('type')
            message = record.get('message')
            if role not in ('user', 'assistant') or not isinstance(message, dict):
                continue
            content = message.get('content')
            if isinstance(content, str):
                add(role, content)
            elif isinstance(content, list):
                for block in content[:128]:
                    if not isinstance(block, dict):
                        continue
                    kind = block.get('type')
                    if kind == 'text':
                        add(role, block.get('text', ''))
                    elif kind == 'thinking':
                        add('thinking', block.get('thinking', ''))
                    elif kind == 'tool_use':
                        add('tool', str(block.get('name', '工具')) + '\n' + json.dumps(block.get('input', {}), ensure_ascii=False))
                    elif kind == 'tool_result':
                        add('tool', words(block.get('content')))
    # Stay below the relay's 128 KiB body limit, including multibyte text.
    kept, budget = [], 0
    for entry in reversed(entries[-100:]):
        cost = len(json.dumps(entry, ensure_ascii=False).encode('utf-8'))
        if budget + cost > 60000:
            break
        kept.append(entry); budget += cost
    return {'sessionId': session, 'agent': agent, 'readOnly': True,
            'truncated': bool(clipped or start or len(kept) < len(entries)), 'entries': list(reversed(kept))}


SLASH_COMMANDS = ('/model', '/clear', '/new')
CONTEXT_SCREEN_PATTERNS = {
    # Only percentages the agent itself renders; never estimate from text size.
    'codex': re.compile(r'(\d{1,3})% context left'),
    'claude': re.compile(r'Context left until auto-compact:\s*(\d{1,3})%'),
}


def context_from_screen(text, agent):
    pattern = CONTEXT_SCREEN_PATTERNS.get(agent)
    matches = pattern.findall(text) if pattern and isinstance(text, str) else []
    if not matches:
        return None
    left = min(100, int(matches[-1]))
    return {'used': None, 'window': None, 'percent': 100 - left, 'source': 'screen',
            'basis': 'auto-compact' if agent == 'claude' else 'window'}


def context_from_transcript(binding):
    """Latest token usage from an explicitly mapped JSONL; bounded tail read."""
    agent, path, session = binding.get('agent'), binding.get('path'), binding.get('sessionId')
    if agent not in ('codex', 'claude') or not isinstance(path, str) or not os.path.isabs(path) or not isinstance(session, str) or not session:
        return None
    flags = os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0)
    with os.fdopen(os.open(path, flags), 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('對話來源必須是一般檔案')
        header = source.read(min(info.st_size, 1024 * 1024))
        start = max(0, info.st_size - 1024 * 1024)
        source.seek(start)
        tail = source.read(info.st_size - start)
        if start:
            tail = tail.partition(b'\n')[2]
    def records(data):
        for line in data.splitlines(keepends=True):
            if not line.endswith(b'\n') or len(line) > 1024 * 1024:
                continue
            try:
                item = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if isinstance(item, dict):
                yield item
    def record_session(record):
        if agent == 'claude':
            return record.get('sessionId')
        if record.get('type') == 'session_meta' and isinstance(record.get('payload'), dict):
            return record['payload'].get('id') or record['payload'].get('session_id')
    if not any(record_session(r) == session for r in records(header)):
        raise ValueError('對話 session ID 不符或無法驗證')
    number = lambda value: value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0
    configured = binding.get('contextWindow')
    configured = configured if isinstance(configured, int) and not isinstance(configured, bool) and configured > 0 else None
    used = window = None
    for record in records(tail):
        if agent == 'codex':
            payload = record.get('payload')
            if record.get('type') != 'event_msg' or not isinstance(payload, dict) or payload.get('type') != 'token_count':
                continue
            data = payload.get('info')
            last = data.get('last_token_usage') if isinstance(data, dict) else None
            if not isinstance(last, dict):
                continue
            used = number(last.get('total_tokens')) or number(last.get('input_tokens')) + number(last.get('output_tokens'))
            window = number(data.get('model_context_window')) or None
        else:
            message = record.get('message')
            if record.get('type') != 'assistant' or record.get('isSidechain') or record.get('sessionId') != session or not isinstance(message, dict):
                continue
            usage = message.get('usage')
            if message.get('model') == '<synthetic>' or not isinstance(usage, dict):
                continue
            total = sum(number(usage.get(key)) for key in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'))
            if total:
                used = total
    if used is None:
        return None
    if configured:
        window = configured
    elif agent == 'claude':
        window = 200000 if used <= 200000 else 1000000
    return {'used': used, 'window': window, 'percent': round(min(100, used * 100 / window), 1) if window else None,
            'source': 'transcript', 'basis': 'window'}


class Bridge:
    def __init__(self, args, token):
        self.args, self.token = args, token
        self.generation = None
        self.commands = queue.Queue(maxsize=256)
        self.stop = threading.Event()
        self.ack = 0
        self.output_seq = 0
        self.pid = self.fd = self.attach_id = None
        self.activity = {}
        self.activity_lock = threading.Lock()
        self.tracked_panes = []
        self.tracked_agents = {}
        self.activity_cursor = 0
        self.workspace_cache = {}
        self.transcripts = {}
        if getattr(args, 'transcript_map', None):
            with open(args.transcript_map, encoding='utf-8') as source:
                self.transcripts = json.load(source)
            if not isinstance(self.transcripts, dict):
                raise ValueError('transcript-map 必須是 pane ID 對應設定的 JSON object')

    def sample_activity(self, pane):
        try:
            text = self.cli('pane', 'read', pane, '--source', 'recent', '--lines', '40')
            digest = hashlib.sha256(text.encode()).hexdigest()
            with self.activity_lock:
                previous = self.activity.get(pane)
                if previous and previous['digest'] != digest:
                    previous.update(digest=digest, at=int(time.time() * 1000))
                elif not previous:
                    self.activity[pane] = {'digest': digest, 'at': 0}
        except (ValueError, subprocess.TimeoutExpired, OSError):
            pass

    def monitor_activity(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            while not self.stop.is_set():
                # Rotating bounded batches keep large sessions responsive.
                ids = self.tracked_panes[:]
                if ids:
                    start = self.activity_cursor % len(ids)
                    batch = (ids[start:] + ids[:start])[:12]
                    list(pool.map(self.sample_activity, batch))
                    self.activity_cursor += len(batch)
                self.stop.wait(3)

    def cli(self, *arguments):
        argv = [self.args.herdr]
        if self.args.machine:
            argv += ['--machine', self.args.machine]
        elif self.args.session:
            argv += ['--session', self.args.session]
        argv += list(arguments)
        if self.args.remote:
            # The target is resolved by the VDI's existing SSH configuration.
            # Quote each remote argument: SSH passes its command through a shell.
            remote_args = shlex.join(argv[1:])
            remote_command = ('if command -v herdr >/dev/null 2>&1; then exec herdr ' + remote_args +
                              '; elif [ -x "$HOME/.local/bin/herdr" ]; then exec "$HOME/.local/bin/herdr" ' + remote_args +
                              '; else printf "herdr not found on remote host\\n" >&2; exit 127; fi')
            argv = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', self.args.remote, remote_command]
        result = subprocess.run(argv, capture_output=True, text=True,
                                encoding='utf-8', errors='replace', timeout=8)
        if result.returncode:
            raise ValueError((result.stderr or result.stdout or 'herdr command failed').strip()[:1200])
        return result.stdout

    def json_cli(self, *arguments):
        data = json.loads(self.cli(*arguments))
        if isinstance(data, dict) and data.get('error'):
            raise ValueError(str(data['error'])[:1200])
        return data.get('result', data) if isinstance(data, dict) else data

    @staticmethod
    def records(data, key):
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            if key in data:
                value = data[key]
                return list(value.values()) if isinstance(value, dict) else value
            for child in data.values():
                if isinstance(child, dict):
                    found = Bridge.records(child, key)
                    if found:
                        return found
        return []

    def workspace_details(self, workspace):
        wid = workspace.get('workspace_id', workspace.get('id'))
        cached = self.workspace_cache.get(wid)
        if cached and time.monotonic() - cached[0] < 30:
            return {**cached[1], 'label': str(workspace.get('label') or workspace.get('name') or wid)[:160]}
        detail = {'id': wid, 'label': str(workspace.get('label') or workspace.get('name') or wid)[:160],
                  'kind': 'workspace', 'checkout': '', 'branch': '', 'repository': '', 'gitKnown': False}
        try:
            info = self.json_cli('worktree', 'list', '--workspace', wid)
            source = info.get('source', {})
            checkout = source.get('source_checkout_path')
            trees = info.get('worktrees', [])
            tree = next((w for w in trees if w.get('open_workspace_id') == wid), None)
            if tree is None:
                tree = next((w for w in trees if w.get('path') == checkout), None)
            if tree:
                detail.update(kind='worktree' if tree.get('is_linked_worktree') else 'workspace',
                              checkout=str(tree.get('path') or '')[:160], branch=str(tree.get('branch') or 'detached HEAD')[:160],
                              repository=str(source.get('repo_name') or '')[:160], gitKnown=True)
        except (ValueError, OSError, subprocess.TimeoutExpired):
            pass  # Non-Git or untrusted directories still have normal workspaces.
        self.workspace_cache[wid] = (time.monotonic(), detail)
        return detail

    def mobile(self, command):
        operation, params = command['operation'], command.get('params', {})
        result = {}
        failure = None
        try:
            if operation == 'panes':
                try:
                    snapshot = self.json_cli('api', 'snapshot')
                    panes = self.records(snapshot, 'panes')
                except (ValueError, subprocess.TimeoutExpired):
                    snapshot, panes = {}, []
                if not panes:
                    panes = self.records(self.json_cli('pane', 'list'), 'panes')
                workspace_rows = [w for w in self.records(snapshot, 'workspaces') if isinstance(w, dict)]
                if not workspace_rows:
                    workspace_rows = self.records(self.json_cli('workspace', 'list'), 'workspaces')
                workspace_rows = [w for w in workspace_rows if w.get('workspace_id', w.get('id'))][:100]
                with ThreadPoolExecutor(max_workers=4) as pool:
                    details = list(pool.map(self.workspace_details, workspace_rows))
                workspaces = {w['id']: w for w in details}
                result['workspaces'] = details
                tabs = {tab.get('tab_id'): tab.get('label') for tab in self.records(snapshot, 'tabs') if isinstance(tab, dict)}
                agents = {a.get('pane_id'): a for a in self.records(snapshot, 'agents') if isinstance(a, dict)}
                result['panes'] = []
                for pane in panes:
                    if not isinstance(pane, dict) or not pane.get('pane_id'):
                        continue
                    workspace = pane.get('workspace_id', '')
                    result['panes'].append({
                        'id': pane['pane_id'],
                        'title': pane.get('title') or pane.get('label') or tabs.get(pane.get('tab_id')) or pane.get('terminal_title_stripped') or pane.get('agent_name') or pane['pane_id'],
                        'agent': pane.get('agent') or pane.get('agent_kind') or '',
                        'status': pane.get('agent_status') or 'unknown',
                        'workspace': workspaces.get(workspace, {}).get('label') or workspace,
                        'workspaceKind': workspaces.get(workspace, {}).get('kind', 'workspace'),
                        'worktreePath': workspaces.get(workspace, {}).get('checkout', ''),
                        'branch': workspaces.get(workspace, {}).get('branch', ''),
                        'terminalId': pane.get('terminal_id') or '',
                        'workspaceId': workspace,
                        'cwd': pane.get('foreground_cwd') or pane.get('cwd') or '',
                        'lastOutputAt': self.activity.get(pane['pane_id'], {}).get('at', 0),
                        'completionSeq': agents.get(pane['pane_id'], {}).get('completion_seq') or 0,
                    })
                result['panes'] = [{key: value if isinstance(value, (int, float)) else str(value)[:160] for key, value in pane.items()}
                                   for pane in result['panes'][:100]]
                self.tracked_panes = [pane['id'] for pane in result['panes']]
                self.tracked_agents = {pane['id']: pane['agent'] for pane in result['panes'] if pane['agent'] in ('codex', 'claude', 'devin')}
            elif operation == 'read':
                pane = params['paneId']
                if params.get('view') == 'conversation':
                    if self.args.machine or self.args.remote:
                        raise ValueError('對話模式請在 agent 所在主機執行 bridge，不讀取 SSH client 本機的紀錄')
                    binding = self.transcripts.get(pane)
                    if not isinstance(binding, dict):
                        raise ValueError('此 pane 尚未設定對話來源；請在 VDI client 指定 --transcript-map')
                    self.json_cli('pane', 'get', pane)  # Require an existing pane.
                    result = {'paneId': pane, 'conversation': read_conversation(binding)}
                elif params.get('view') == 'menu':
                    text = self.cli('pane', 'read', pane, '--source', 'visible', '--lines', '160')
                    result = {'paneId': pane, 'view': 'menu', 'text': text[-24000:]}
                else:
                    try:
                        text = self.cli('pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '300')
                    except ValueError:
                        text = self.cli('pane', 'read', pane, '--source', 'recent', '--lines', '300')
                    result = {'paneId': pane, 'text': text[-24000:]}
            elif operation == 'prompt':
                info = self.json_cli('pane', 'get', params['paneId'])
                pane = info.get('pane', info)
                command_text = params['text'].strip()
                if command_text in ('/clear', '/new') and pane.get('agent_status') in ('working', 'blocked'):
                    raise ValueError('Agent 正在工作或等待回覆，未送出清除命令。')
                if command_text in SLASH_COMMANDS and pane.get('agent') in ('devin', 'codex', 'claude'):
                    screen = self.cli('pane', 'read', params['paneId'], '--source', 'visible', '--lines', '160')
                    ansi = None
                    if pane['agent'] == 'claude' and not model_prompt_ready(screen, 'claude'):
                        ansi = self.cli('pane', 'read', params['paneId'], '--source', 'visible', '--lines', '160', '--format', 'ansi')
                    if not model_prompt_ready(screen, pane['agent'], ansi):
                        raise ValueError('終端輸入區可能有未送出的文字；請先在原始終端送出或清空，再執行 ' + command_text + '。草稿未變更。')
                if pane.get('agent'):
                    # Agent-specific API separates paste and submit (300ms in
                    # herdr 0.9.5), unlike pane.run's combined input burst.
                    self.json_cli('agent', 'prompt', params['paneId'], params['text'])
                else:
                    # pane run acknowledges with plain text (or no output),
                    # unlike agent prompt's JSON. Exit status confirms success.
                    self.cli('pane', 'run', params['paneId'], params['text'])
                result = {'paneId': params['paneId'], 'submitted': True}
            elif operation == 'context':
                agents = dict(list(self.tracked_agents.items())[:24])
                local = not (self.args.machine or self.args.remote)
                def usage(item):
                    pane, agent = item
                    binding = self.transcripts.get(pane) if local else None
                    if isinstance(binding, dict) and binding.get('agent') == agent:
                        try:
                            found = context_from_transcript(binding)
                            if found:
                                return pane, {**found, 'agent': agent}
                        except (ValueError, OSError):
                            pass
                    try:
                        found = context_from_screen(self.cli('pane', 'read', pane, '--source', 'visible', '--lines', '60'), agent)
                    except (ValueError, OSError, subprocess.TimeoutExpired):
                        found = None
                    return pane, {**(found or {'used': None, 'window': None, 'percent': None, 'source': 'unknown', 'basis': 'window'}), 'agent': agent}
                with ThreadPoolExecutor(max_workers=4) as pool:
                    result = {'usage': dict(pool.map(usage, agents.items())), 'at': int(time.time() * 1000)}
            elif operation == 'create':
                info = self.json_cli('pane', 'get', params['paneId'])
                source = info.get('pane', info)
                if params.get('workspaceId') and params['workspaceId'] != source['workspace_id']:
                    raise ValueError('來源 pane 已不在選定的 workspace，請重新選擇')
                arguments = ['tab', 'create', '--workspace', source['workspace_id'], '--label', params['label'], '--no-focus']
                if source.get('foreground_cwd') or source.get('cwd'):
                    arguments += ['--cwd', source.get('foreground_cwd') or source['cwd']]
                created = self.json_cli(*arguments)
                new_pane = created.get('root_pane', {}).get('pane_id')
                if not new_pane:
                    raise ValueError('視窗可能已建立，但未取得 pane ID；請重新整理清單，勿直接重試')
                # A new window starts a shell; the user explicitly chooses what
                # to run there. Do not copy or resume a different agent.
                result = {'paneId': new_pane, 'created': True}
            elif operation == 'close':
                if params.get('confirmed') is not True or not params.get('terminalId'):
                    raise ValueError('請先確認要關閉的 pane')
                info = self.json_cli('pane', 'get', params['paneId'])
                pane = info.get('pane', info)
                if pane.get('terminal_id') != params['terminalId']:
                    raise ValueError('Pane 已改變，請重新確認後再關閉')
                self.json_cli('pane', 'close', params['paneId'])
                self.transcripts.pop(params['paneId'], None)
                result = {'paneId': params['paneId'], 'closed': True}
            elif operation == 'key':
                if params['key'] not in ('enter', 'esc', 'tab', 'ctrl+c', 'up', 'down', 'left', 'right'):
                    raise ValueError('Unsupported key')
                self.cli('pane', 'send-keys', params['paneId'], params['key'])
                result = {'paneId': params['paneId'], 'submitted': True}
            else:
                raise ValueError('Unsupported operation')
        except (ValueError, KeyError, subprocess.TimeoutExpired, OSError) as error:
            # Do not retry prompts: a timeout can mean delivery is uncertain.
            failure = str(error)[:1200]
        if failure:
            self.output('mobile', requestId=command['requestId'], operation=operation, error=failure)
        else:
            self.output('mobile', requestId=command['requestId'], operation=operation, result=result)

    def request(self, route, data=None, query=None):
        url = self.args.server.rstrip('/') + '/api/client/' + route
        if query:
            url += '?' + urllib.parse.urlencode(query)
        headers = {'Authorization': 'Bearer ' + self.token}
        if self.generation:
            headers['X-Client-Generation'] = self.generation
        raw = None if data is None else json.dumps(data, ensure_ascii=False).encode()
        if raw is not None:
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(url, data=raw, headers=headers)
        with urllib.request.urlopen(req, timeout=25) as response:
            return json.load(response)

    def poll(self):
        try:
            while not self.stop.is_set():
                result = self.request('poll', query={'id': self.args.id, 'ack': self.ack})
                for command in result['commands']:
                    done = threading.Event()
                    self.commands.put((command, done))
                    while not done.wait(.2):
                        if self.stop.is_set():
                            return
        except Exception as error:
            if not self.stop.is_set():
                self.commands.put(({'type': 'connection_error', 'error': error}, None))

    def detach(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        if self.pid is not None:
            # Only terminate the foreground attach client we created, never the
            # herdr server or its process group. The server owns all agent panes.
            pid, self.pid = self.pid, None
            try:
                if os.waitpid(pid, os.WNOHANG)[0] == 0:
                    os.kill(pid, signal.SIGHUP)
                    deadline = time.monotonic() + 2
                    while time.monotonic() < deadline:
                        if os.waitpid(pid, os.WNOHANG)[0]:
                            break
                        time.sleep(.05)
                    else:
                        os.kill(pid, signal.SIGKILL)
                        os.waitpid(pid, 0)
            except (ChildProcessError, ProcessLookupError):
                pass
        self.attach_id = None

    def resize(self, cols, rows):
        import fcntl
        import termios
        if self.fd is not None:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    def attach(self, command):
        import pty
        self.detach()
        self.attach_id = command['attachId']
        if self.args.machine or self.args.remote:
            self.output('exit', message='遠端 machine 請使用 Pane 閱讀模式，避免誤連 Local session')
            return
        try:
            # API commands only query existing servers. Do not launch a default
            # session merely because a browser reloads after the server stopped.
            self.json_cli('pane', 'list')
        except (ValueError, subprocess.TimeoutExpired, OSError) as error:
            self.output('exit', message='找不到原本的 herdr session，請確認 --session：' + str(error)[:300])
            return
        argv = [self.args.herdr]
        if self.args.session:
            argv += ['--session', self.args.session]
        pid, fd = pty.fork()
        if pid == 0:
            env = os.environ.copy()
            env['TERM'] = 'xterm-256color'
            env['COLORTERM'] = 'truecolor'
            # Do not inherit pane identity when launched inside an existing pane.
            for key in ('HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID'):
                env.pop(key, None)
            try:
                os.execvpe(argv[0], argv, env)
            except Exception as error:
                os.write(2, ('Could not start herdr: ' + str(error) + '\r\n').encode())
                os._exit(1)
        self.pid, self.fd = pid, fd
        self.resize(command['cols'], command['rows'])

    def output(self, kind, **kwargs):
        self.output_seq += 1
        data = {'seq': self.output_seq, 'type': kind, 'attachId': self.attach_id, **kwargs}
        # Retry the same sequence number: the server deduplicates lost responses.
        for attempt in range(3):
            try:
                self.request('output', data=data, query={'id': self.args.id})
                return
            except urllib.error.HTTPError:
                raise
            except (urllib.error.URLError, TimeoutError, OSError):
                if attempt == 2:
                    raise
                time.sleep(1)

    def run(self):
        target = ('machine: ' + self.args.machine) if self.args.machine else ('SSH: ' + self.args.remote + ' / ' + (self.args.session or 'default')) if self.args.remote else ('session: ' + (self.args.session or os.environ.get('HERDR_SESSION') or 'default'))
        self.generation = self.request('register', {'id': self.args.id, 'label': self.args.label, 'target': target,
                                                   'capabilities': ['mobile-v1', 'mobile-v2', 'mobile-v3', 'mobile-v4'], 'terminal': not bool(self.args.machine or self.args.remote)})['generation']
        print('Connected. Waiting for a browser to attach.', flush=True)
        worker = threading.Thread(target=self.poll, daemon=True)
        worker.start()
        threading.Thread(target=self.monitor_activity, daemon=True).start()
        try:
            while True:
                while True:
                    try:
                        command, done = self.commands.get_nowait()
                    except queue.Empty:
                        break
                    try:
                        kind = command['type']
                        if kind == 'connection_error':
                            raise command['error']
                        if command['seq'] <= self.ack:
                            continue
                        if kind == 'attach':
                            self.attach(command)
                        elif kind == 'mobile_attach':
                            self.detach()
                            self.attach_id = command['attachId']
                        elif kind == 'detach':
                            self.detach()
                        elif kind == 'mobile' and command.get('attachId') == self.attach_id:
                            self.mobile(command)
                        elif command.get('attachId') == self.attach_id and self.fd is not None:
                            if kind == 'resize':
                                self.resize(command['cols'], command['rows'])
                            elif kind == 'input':
                                raw = base64.b64decode(command['data']) if command.get('binary') else command['data'].encode('utf-8')
                                while raw:
                                    raw = raw[os.write(self.fd, raw):]
                        self.ack = command['seq']
                    finally:
                        if done:
                            done.set()
                if self.fd is None:
                    time.sleep(.03)
                    continue
                ready, _, _ = select.select([self.fd], [], [], .03)
                if not ready:
                    continue
                try:
                    chunk = os.read(self.fd, 24000)
                except OSError:
                    chunk = b''
                if chunk:
                    self.output('output', data=base64.b64encode(chunk).decode('ascii'))
                else:
                    self.output('exit', message='herdr attach 已結束；原本的 server/session 不會被此 bridge 停止')
                    self.detach()
        finally:
            self.stop.set()
            self.detach()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', required=True, help='Example: http://127.0.0.1:3000 or https://relay.example.com')
    parser.add_argument('--id', default='vdi', help='Unique device id: letters, numbers, underscore, dash')
    parser.add_argument('--label', default=socket.gethostname())
    parser.add_argument('--session', help='Existing named herdr session; omit for the default session')
    parser.add_argument('--machine', help='Existing saved herdr machine name/id (mobile pane mode only)')
    parser.add_argument('--remote', help='Existing SSH target used by herdr --remote (Linux/macOS remote; mobile mode only)')
    parser.add_argument('--herdr', default='herdr', help='Path to the herdr executable')
    parser.add_argument('--token-file', help='Private file containing only the client token')
    parser.add_argument('--transcript-map', help='Conversation sources: JSON map of pane IDs to agent/path/sessionId')
    args = parser.parse_args()
    if args.session and args.machine:
        parser.error('Use either --session or --machine, not both')
    if args.machine and args.remote:
        parser.error('Use either --machine or --remote, not both')
    if args.remote and (args.remote.startswith('-') or any(c.isspace() for c in args.remote)):
        parser.error('--remote must be an SSH host alias, user@host, or ssh:// URI')
    if os.name != 'posix':
        parser.error('This client requires Linux, macOS, or WSL with herdr running in the same environment.')
    if not shutil.which(args.herdr):
        parser.error('herdr not found. Run as the same OS user and in the same environment as your existing herdr session.')
    parsed = urllib.parse.urlparse(args.server)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ('', '/'):
        parser.error('--server must be an HTTP(S) origin without credentials or path')
    if parsed.scheme == 'http':
        print('WARNING: HTTP is unencrypted; use only for a connectivity PoC until HTTPS is configured.', file=sys.stderr)
    if args.token_file:
        with open(args.token_file, encoding='utf-8') as file:
            token = file.read().strip()
    else:
        token = getpass.getpass('Client token (hidden): ').strip()
    if not token:
        parser.error('Client token is required')
    try:
        while True:
            try:
                Bridge(args, token).run()
            except urllib.error.HTTPError as error:
                if error.code in (401, 403, 407):
                    print('Authentication/proxy rejected the request (HTTP %s). Check the token or lab proxy.' % error.code, file=sys.stderr)
                    return 1
                print('Connection interrupted (HTTP %s). Retrying in 5 seconds.' % error.code, flush=True)
            except (urllib.error.URLError, OSError, ValueError) as error:
                print('Connection interrupted: %s. Retrying in 5 seconds.' % error, flush=True)
            time.sleep(5)
    except KeyboardInterrupt:
        print('\nBridge stopped; herdr server and agents are left running.')
        return 0


if __name__ == '__main__':
    sys.exit(main())
