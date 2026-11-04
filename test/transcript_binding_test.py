import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import client_routing_test as routing

module = routing.module


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bridge = routing.RoutingTests.bridge(None, session='work')
        self.pane = {'agent': 'codex', 'agent_session': {
            'agent': 'codex', 'kind': 'id', 'source': 'herdr:codex', 'value': 'new'}}
        self.bridge.transcripts = {'p1': {'agent': 'codex', 'sessionId': 'old', 'path': '/old'}}

    def log(self, session):
        path = self.root / 'sessions' / '2026' / ('rollout-date-' + session + '.jsonl')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'type': 'session_meta', 'payload': {'id': session}}) + '\n')
        return path

    def test_codex_follows_reported_session_even_with_old_mapping(self):
        self.log('new')
        self.log('next')
        with patch.dict(os.environ, {'CODEX_HOME': str(self.root)}), patch.object(self.bridge, 'json_cli', return_value={'pane': self.pane}):
            self.assertEqual(self.bridge.transcript_binding('p1')['sessionId'], 'new')
            self.pane['agent_session']['value'] = 'next'
            self.assertEqual(self.bridge.transcript_binding('p1')['sessionId'], 'next')

    def test_missing_or_ambiguous_current_log_never_falls_back_to_old(self):
        with patch.dict(os.environ, {'CODEX_HOME': str(self.root)}), patch.object(self.bridge, 'json_cli', return_value=self.pane):
            with self.assertRaises(ValueError):
                self.bridge.transcript_binding('p1')
            path = self.log('new')
            path.with_name('rollout-other-new.jsonl').write_text(path.read_text())
            with self.assertRaises(ValueError):
                self.bridge.transcript_binding('p1')

    def test_manual_mapping_reloads_and_malformed_mapping_does_not_use_old(self):
        path = self.root / 'map.json'
        self.bridge.args.transcript_map = str(path)
        with patch.object(self.bridge, 'json_cli', return_value={'agent': 'codex'}):
            for session in ['first', 'second']:
                path.write_text(json.dumps({'p1': {'agent': 'codex', 'sessionId': session, 'path': '/manual'}}))
                binding = self.bridge.transcript_binding('p1')
                self.assertEqual(binding['sessionId'], session)
                self.assertEqual(binding['bindingSource'], 'manual')
            path.write_text('{')
            with self.assertRaises(ValueError):
                self.bridge.transcript_binding('p1')

    def test_agent_change_does_not_reuse_codex_map(self):
        with patch.object(self.bridge, 'json_cli', return_value={'agent': 'claude'}):
            with self.assertRaises(ValueError):
                self.bridge.transcript_binding('p1')

    def process(self, pid, session, pane='p1', socket='/expected.sock'):
        process = self.root / 'proc' / str(pid)
        (process / 'fd').mkdir(parents=True)
        (process / 'environ').write_bytes(('HERDR_PANE_ID=' + pane + '\0HERDR_SOCKET_PATH=' + socket + '\0').encode())
        database = self.root / 'devin' / 'sessions.db'
        lock = database.parent / 'session_locks' / (session + '.lock')
        (process / 'fd' / '1').symlink_to(database)
        (process / 'fd' / '2').symlink_to(lock)
        return process

    def test_devin_follows_live_lock_and_ignores_other_panes_and_servers(self):
        process = self.process(10, 'first')
        self.process(11, 'other-pane', pane='p2')
        self.process(12, 'other-server', socket='/other.sock')
        with patch.dict(os.environ, {'HERDR_SOCKET_PATH': '/expected.sock'}):
            binding = self.bridge.devin_binding('p1', {}, self.root / 'proc')
            self.assertEqual(binding['sessionId'], 'first')
            (process / 'fd' / '2').unlink()
            (process / 'fd' / '2').symlink_to(self.root / 'devin/session_locks/second.lock')
            self.assertEqual(self.bridge.devin_binding('p1', {}, self.root / 'proc')['sessionId'], 'second')
            (process / 'fd' / '2').unlink()
            with self.assertRaises(ValueError):
                self.bridge.devin_binding('p1', {}, self.root / 'proc')

    def test_devin_ambiguous_locks_and_no_database_fail_closed(self):
        process = self.process(10, 'first')
        with patch.dict(os.environ, {'HERDR_SOCKET_PATH': '/expected.sock'}):
            (process / 'fd' / '3').symlink_to(self.root / 'devin/session_locks/second.lock')
            with self.assertRaises(ValueError):
                self.bridge.devin_binding('p1', {}, self.root / 'proc')
            (process / 'fd' / '1').unlink()
            with self.assertRaises(ValueError):
                self.bridge.devin_binding('p1', {}, self.root / 'proc')

    def test_remote_does_not_read_local_mapping_or_processes(self):
        self.bridge.args.remote = 'other-host'
        with patch.object(self.bridge, 'json_cli') as cli:
            with self.assertRaises(ValueError):
                self.bridge.transcript_binding('p1')
            cli.assert_not_called()


if __name__ == '__main__':
    unittest.main()
