#!/usr/bin/env python3
"""Start an isolated local herdr session and bridge."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from client import Bridge


def main():
    state = ROOT / '.local-test'
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', default='http://127.0.0.1:443', help='Local relay origin')
    parser.add_argument('--transcript-map', default=str(state / 'transcript-map.json'),
                        help='Local pane-to-transcript JSON map (defaults to .local-test/transcript-map.json)')
    options = parser.parse_args()
    transcript_map = Path(options.transcript_map)
    if not transcript_map.exists() and '--transcript-map' in sys.argv:
        parser.error('transcript-map file does not exist')
    state.mkdir(mode=0o700, exist_ok=True)
    lock = (state / 'bridge.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('iMac test bridge is already running.')
    binary = shutil.which('herdr') or str(Path.home() / '.local/bin/herdr')
    config = state / 'config' / 'herdr'
    config.mkdir(parents=True, exist_ok=True)
    config_file = config / 'config.toml'
    if not config_file.exists():
        with config_file.open('x') as output:
            output.write('onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n')
    for key in ('HERDR_SOCKET_PATH', 'HERDR_SESSION', 'HERDR_CONFIG_PATH', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID'):
        os.environ.pop(key, None)
    os.environ['XDG_CONFIG_HOME'] = str(config.parent)
    os.environ['NO_PROXY'] = os.environ['no_proxy'] = '127.0.0.1,localhost'
    argv = [binary, '--session', 'imac-test']
    def cli(*arguments):
        result = subprocess.run(argv + list(arguments), capture_output=True, text=True, timeout=10)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or 'herdr command failed')
        if arguments[:2] == ('pane', 'run'):
            return result.stdout
        value = json.loads(result.stdout)
        return value.get('result', value)
    try:
        cli('pane', 'list')
    except RuntimeError:
        with (state / 'server.log').open('ab') as log:
            server = subprocess.Popen(argv + ['server'], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, cwd=state)
        for _ in range(100):
            if server.poll() is not None:
                raise RuntimeError('Test server exited; inspect .local-test/server.log')
            try:
                cli('pane', 'list')
                break
            except RuntimeError:
                time.sleep(.1)
        else:
            raise RuntimeError('Test server did not become ready')
    panes = Bridge.records(cli('pane', 'list'), 'panes')
    if not panes:
        cli('workspace', 'create', '--cwd', str(state), '--label', 'iMac 本機測試')
        panes = Bridge.records(cli('pane', 'list'), 'panes')
        pane = panes[0]['pane_id']
        cli('pane', 'rename', pane, '本機 shell／合成對話')
        cli('pane', 'run', pane, "printf '\\nIMAC_TEST_READY — local test shell; synthetic demo.\\n'")
    pane = panes[0]['pane_id']
    # The mapping stays in memory; neither credentials nor user transcripts
    # are written into source-controlled files.
    with (ROOT / '.credentials.json').open() as file:
        token = json.load(file)['clientToken']
    args = argparse.Namespace(server=options.server, id='imac-test', label='iMac 本機測試',
                              herdr=binary, session='imac-test', machine=None, remote=None,
                              transcript_map=str(transcript_map) if transcript_map.exists() else None)
    print(f'Test pane: {pane}; synthetic conversation: imac-synthetic-demo', flush=True)
    print('Ctrl+C stops only this bridge. The isolated herdr test session stays alive.', flush=True)
    while True:
        bridge = Bridge(args, token)
        bridge.transcripts.setdefault(pane, {'agent': 'codex', 'sessionId': 'imac-synthetic-demo',
                                            'path': str(ROOT / 'test/fixtures/conversation-demo.ndjson')})
        try:
            bridge.run()
        except (urllib.error.URLError, OSError, ValueError) as error:
            print(f'Test bridge disconnected: {type(error).__name__}; retrying in 5 seconds.', flush=True)
            time.sleep(5)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nTest bridge stopped; existing herdr sessions were not stopped.')
