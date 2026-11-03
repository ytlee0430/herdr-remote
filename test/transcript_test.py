import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import client_routing_test as routing

module = routing.module


class TranscriptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='herdr-transcript-')
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'session.jsonl'

    def read(self, records, agent='codex', suffix=''):
        self.path.write_text(''.join(json.dumps(r) + '\n' for r in records) + suffix)
        return module.read_conversation({'agent': agent, 'path': str(self.path), 'sessionId': 'test-session'})

    def test_codex_structured_entries_and_no_duplicate_event(self):
        records = [{'type': 'session_meta', 'payload': {'id': 'test-session'}}]
        for payload in [
            {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'Question'}]},
            {'type': 'reasoning', 'summary': [{'type': 'summary_text', 'text': 'Thinking summary'}]},
            {'type': 'message', 'role': 'assistant', 'phase': 'commentary', 'content': [{'type': 'output_text', 'text': 'Checking'}]},
            {'type': 'function_call', 'name': 'shell', 'arguments': 'do not execute'},
            {'type': 'function_call_output', 'output': 'Result'},
            {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': '<script>inert</script>Answer'}]},
        ]:
            records.append({'type': 'response_item', 'payload': payload})
        records.append({'type': 'event_msg', 'payload': {'type': 'agent_message', 'message': 'duplicate'}})
        result = self.read(records, suffix='{"unfinished":')
        self.assertEqual([e['kind'] for e in result['entries']], ['user', 'thinking', 'progress', 'tool', 'tool', 'assistant'])
        self.assertTrue(result['readOnly'])
        self.assertNotIn('duplicate', str(result))

    def test_claude_dedup_sidechain_and_blocks(self):
        row = {'type': 'assistant', 'sessionId': 'test-session', 'uuid': 'one', 'message': {'content': [
            {'type': 'thinking', 'thinking': 'Reason summary'}, {'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'inert'}},
            {'type': 'text', 'text': 'Reply'}]}}
        result = self.read([row, row, {**row, 'uuid': 'child', 'isSidechain': True}], 'claude')
        self.assertEqual([e['kind'] for e in result['entries']], ['thinking', 'tool', 'assistant'])

    def test_wrong_and_mixed_sessions_fail_closed(self):
        with self.assertRaises(ValueError):
            self.read([{'type': 'session_meta', 'payload': {'id': 'other'}}])
        with self.assertRaises(ValueError):
            self.read([{'type': 'session_meta', 'payload': {'id': 'test-session'}}, {'type': 'session_meta', 'payload': {'id': 'other'}}])

    def test_bounded_payload(self):
        records = [{'type': 'session_meta', 'payload': {'id': 'test-session'}}]
        records += [{'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': '繁體文字' * 3000}]}}] * 200
        result = self.read(records)
        self.assertTrue(result['truncated'])
        self.assertLess(len(json.dumps(result, ensure_ascii=False).encode()), 65000)

    def test_symlink_refused(self):
        target = Path(self.directory.name) / 'other'
        target.write_text('')
        self.path.symlink_to(target)
        with self.assertRaises(OSError):
            module.read_conversation({'agent': 'codex', 'path': str(self.path), 'sessionId': 'test-session'})

    def test_missing_mapping_and_remote_do_not_read_files(self):
        for args in ({}, {'remote': 'lab-host'}):
            bridge = routing.RoutingTests().bridge(**args)
            with patch.object(module, 'read_conversation') as reader, patch.object(bridge, 'output') as output:
                bridge.mobile({'operation': 'read', 'params': {'paneId': 'p1', 'view': 'conversation', 'path': '/arbitrary'}, 'requestId': 'x'})
                reader.assert_not_called()
                self.assertIn('error', output.call_args.kwargs)

    def test_bridge_reads_mapped_file_and_tracks_appends(self):
        self.read([{'type': 'session_meta', 'payload': {'id': 'test-session'}}])
        bridge = routing.RoutingTests().bridge()
        bridge.transcripts = {'p1': {'agent': 'codex', 'path': str(self.path), 'sessionId': 'test-session'}}
        command = {'operation': 'read', 'params': {'paneId': 'p1', 'view': 'conversation', 'path': '/untrusted-browser-path'}, 'requestId': 'test'}
        with patch.object(bridge, 'json_cli', return_value={'pane': {'pane_id': 'p1'}}) as cli, patch.object(bridge, 'output') as output:
            bridge.mobile(command)
            self.assertEqual(output.call_args.kwargs['result']['conversation']['entries'], [])
            with self.path.open('a') as log:
                log.write(json.dumps({'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'New reply'}]}}) + '\n')
            bridge.mobile(command)
            self.assertEqual(output.call_args.kwargs['result']['conversation']['entries'][0]['text'], 'New reply')
            self.assertTrue(all(call.args == ('pane', 'get', 'p1') for call in cli.call_args_list))


class DevinTranscriptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'sessions.db'
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT, main_chain_id INTEGER);
            CREATE TABLE message_nodes (session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, UNIQUE(session_id,node_id));
            INSERT INTO sessions VALUES ('active', '/work', 4);
        """)
        for node, parent, role, text in [(1,None,'system','SECRET SYSTEM'), (2,1,'user','Question'), (3,2,'assistant','Wrong branch'), (4,2,'assistant','Answer')]:
            self.db.execute('INSERT INTO message_nodes VALUES (?,?,?,?)', ('active',node,parent,json.dumps({'role':role,'content':text,'thinking':{'thinking':'PRIVATE REASONING'}})))
        self.db.commit()
        self.binding = {'agent':'devin','sessionId':'active','path':str(self.path),'cwd':'/work'}

    def test_reads_only_main_chain_and_observes_updates(self):
        before = self.path.read_bytes()
        result = module.read_conversation(self.binding)
        self.assertEqual([e['text'] for e in result['entries']], ['Question','Answer'])
        self.assertEqual(self.path.read_bytes(), before)
        self.db.execute('INSERT INTO message_nodes VALUES (?,?,?,?)', ('active',5,4,json.dumps({'role':'assistant','content':'Working','tool_calls':[{'name':'shell','arguments':{'cmd':'inert'}}]})))
        self.db.execute("UPDATE sessions SET main_chain_id=5 WHERE id='active'")
        self.db.commit()
        self.assertEqual([e['kind'] for e in module.read_conversation(self.binding)['entries']], ['user','assistant','progress','tool'])

    def test_wrong_identity_and_broken_chain(self):
        for changes in ({'sessionId':'missing'}, {'cwd':'/wrong'}):
            with self.assertRaises(ValueError): module.read_conversation({**self.binding, **changes})
        self.db.execute("UPDATE message_nodes SET parent_node_id=4 WHERE node_id=2")
        self.db.commit()
        with self.assertRaises(ValueError): module.read_conversation(self.binding)

    def test_bounded_text_and_symlink(self):
        self.db.execute('UPDATE message_nodes SET chat_message=? WHERE node_id=4', (json.dumps({'role':'assistant','content':'繁體文字'*100000}),))
        self.db.commit()
        result = module.read_conversation(self.binding)
        self.assertTrue(result['truncated'])
        self.assertLess(len(json.dumps(result,ensure_ascii=False).encode()),65000)
        link = self.path.parent/'link.db'
        link.symlink_to(self.path)
        with self.assertRaises(ValueError): module.read_conversation({**self.binding,'path':str(link)})
