import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import client_routing_test as routing

module = routing.module


class ContextUsageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='herdr-context-')
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'session.jsonl'

    def write(self, records):
        self.path.write_text(''.join(json.dumps(r) + '\n' for r in records))
        return str(self.path)

    def test_codex_uses_latest_token_count_and_window(self):
        path = self.write([
            {'type': 'session_meta', 'payload': {'id': 's'}},
            {'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {'last_token_usage': {'total_tokens': 1000}, 'model_context_window': 258400}}},
            {'type': 'event_msg', 'payload': {'type': 'token_count', 'info': None}},
            {'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {'last_token_usage': {'total_tokens': 129200}, 'model_context_window': 258400}}},
        ])
        usage = module.context_from_transcript({'agent': 'codex', 'path': path, 'sessionId': 's'})
        self.assertEqual((usage['used'], usage['window'], usage['percent'], usage['source']), (129200, 258400, 50.0, 'transcript'))

    def test_claude_sums_cached_input_and_skips_synthetic_and_sidechain(self):
        def assistant(usage, **extra):
            return {'type': 'assistant', 'sessionId': 's', 'message': {'model': extra.pop('model', 'claude-x'), 'usage': usage}, **extra}
        path = self.write([
            assistant({'input_tokens': 10, 'cache_creation_input_tokens': 40000, 'cache_read_input_tokens': 9990, 'output_tokens': 500}),
            assistant({'input_tokens': 0}, model='<synthetic>'),
            assistant({'input_tokens': 190000}, isSidechain=True),
        ])
        usage = module.context_from_transcript({'agent': 'claude', 'path': path, 'sessionId': 's'})
        self.assertEqual((usage['used'], usage['window'], usage['percent']), (50000, 200000, 25.0))
        path = self.write([assistant({'input_tokens': 50000}, model='claude-opus-5-5')])
        usage = module.context_from_transcript({'agent': 'claude', 'path': path, 'sessionId': 's'})
        self.assertEqual((usage['window'], usage['percent']), (1000000, 5.0))
        usage = module.context_from_transcript({'agent': 'claude', 'path': path, 'sessionId': 's', 'contextWindow': 1000000})
        self.assertEqual(usage['window'], 1000000)
        for model, window in [('claude-opus-5-5', 1000000), ('claude-fable-5-1', 1000000), ('claude-sonnet-4-6', 1000000),
                              ('claude-haiku-5-5', 1000000), ('claude-haiku-4-5', 200000), ('claude-sonnet-4-5-20250929', 200000),
                              ('claude-sonnet-4-20250514', 200000), ('claude-opus-4-1', 200000), ('claude-sonnet-4-5[1m]', 1000000)]:
            self.assertEqual(module.claude_context_window(model, 50000), window, model)
        path = self.write([assistant({'input_tokens': 300000})])
        self.assertEqual(module.context_from_transcript({'agent': 'claude', 'path': path, 'sessionId': 's'})['window'], 1000000)

    def test_wrong_session_fails_closed(self):
        path = self.write([{'type': 'assistant', 'sessionId': 'other', 'message': {'usage': {'input_tokens': 5}}}])
        with self.assertRaises(ValueError):
            module.context_from_transcript({'agent': 'claude', 'path': path, 'sessionId': 's'})

    def test_screen_only_reads_agent_rendered_percentages(self):
        self.assertEqual(module.context_from_screen('› \n  gpt-5 high · 72% context left', 'codex')['percent'], 28)
        claude = module.context_from_screen('Context left until auto-compact: 9%', 'claude')
        self.assertEqual((claude['percent'], claude['basis']), (91, 'auto-compact'))
        self.assertIsNone(module.context_from_screen('we discussed 72% context left yesterday', 'devin'))
        self.assertIsNone(module.context_from_screen('nothing here', 'claude'))

    def test_bridge_context_operation_prefers_mapping_and_falls_back_to_screen(self):
        bridge = routing.RoutingTests.bridge(None)
        path = self.write([{'type': 'session_meta', 'payload': {'id': 's'}},
                           {'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {'last_token_usage': {'total_tokens': 10}, 'model_context_window': 100}}}])
        bridge.transcripts = {'p1': {'agent': 'codex', 'path': path, 'sessionId': 's'}}
        bridge.tracked_agents = {'p1': 'codex', 'p2': 'claude', 'p3': 'devin'}
        screens = {'p2': 'Context left until auto-compact: 40%', 'p3': 'no data'}
        with patch.object(bridge, 'cli', side_effect=lambda *a: screens[a[2]]), patch.object(bridge, 'output') as output:
            bridge.mobile({'operation': 'context', 'params': {}, 'requestId': 'c'})
        usage = output.call_args.kwargs['result']['usage']
        self.assertEqual(usage['p1']['source'], 'transcript')
        self.assertEqual((usage['p2']['source'], usage['p2']['percent']), ('screen', 60))
        self.assertEqual(usage['p3']['source'], 'unknown')

    def test_clear_requires_idle_agent_and_empty_input(self):
        bridge = routing.RoutingTests.bridge(None)
        for text in ('/clear', '/new'):
            with patch.object(bridge, 'json_cli', return_value={'pane': {'agent': 'claude', 'agent_status': 'working'}}) as cli, patch.object(bridge, 'output') as output:
                bridge.mobile({'operation': 'prompt', 'params': {'paneId': 'p1', 'text': text}, 'requestId': 'x'})
                self.assertEqual(cli.call_count, 1)
                self.assertIn('error', output.call_args.kwargs)
            with patch.object(bridge, 'json_cli', return_value={'pane': {'agent': 'codex', 'agent_status': 'idle'}}) as cli, patch.object(bridge, 'cli', return_value='› draft'), patch.object(bridge, 'output') as output:
                bridge.mobile({'operation': 'prompt', 'params': {'paneId': 'p1', 'text': text}, 'requestId': 'x'})
                self.assertEqual(cli.call_count, 1)
                self.assertIn(text, output.call_args.kwargs['error'])
        with patch.object(bridge, 'json_cli', return_value={'pane': {'agent': 'codex', 'agent_status': 'idle'}}) as cli, patch.object(bridge, 'cli', return_value='› \n'), patch.object(bridge, 'output') as output:
            bridge.mobile({'operation': 'prompt', 'params': {'paneId': 'p1', 'text': '/new'}, 'requestId': 'x'})
            self.assertEqual(cli.call_args.args, ('agent', 'prompt', 'p1', '/new'))
            self.assertNotIn('error', output.call_args.kwargs)


if __name__ == '__main__':
    unittest.main()
