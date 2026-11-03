import argparse
import importlib.util
import os
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bridge_client', Path(__file__).parents[1] / 'client.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RoutingTests(unittest.TestCase):
    def bridge(self, **overrides):
        values = dict(herdr='herdr', machine=None, remote=None, session=None)
        values.update(overrides)
        return module.Bridge(argparse.Namespace(**values), 'test-only')

    def test_saved_machine_never_queries_local(self):
        bridge = self.bridge(machine='Build machine')
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '{}', '')) as run:
            bridge.cli('pane', 'read', 'w2:p3')
            self.assertEqual(run.call_args.args[0], ['herdr', '--machine', 'Build machine', 'pane', 'read', 'w2:p3'])

    def test_ssh_preserves_session_and_literal_prompt(self):
        bridge = self.bridge(remote='lab-alias', session='working')
        prompt = "Please keep $(printf INJECTED), 'quotes', and\nnewlines literal"
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '{}', '')) as run:
            bridge.cli('pane', 'run', 'w2:p3', prompt)
            argv = run.call_args.args[0]
        self.assertEqual(argv[:9], ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', 'lab-alias', argv[8]])
        with tempfile.TemporaryDirectory(prefix='herdr-route-') as directory:
            executable = Path(directory) / 'herdr'
            executable.write_text('#!/bin/sh\nprintf "%s\\0" "$@"\n')
            executable.chmod(0o700)
            output = subprocess.check_output(['/bin/sh', '-c', argv[-1]], env={**os.environ, 'PATH': directory + ':' + os.environ.get('PATH', '')})
            arguments = output.decode().split('\0')[:-1]
            self.assertEqual(arguments, ['--session', 'working', 'pane', 'run', 'w2:p3', prompt])

    def test_remote_full_attach_is_rejected_without_launching_local(self):
        for options in ({'machine': 'Build machine'}, {'remote': 'lab-alias'}):
            bridge = self.bridge(**options)
            with patch.object(bridge, 'output') as output, patch.object(module.os, 'execvpe') as launch:
                bridge.attach({'attachId': 'test'})
                output.assert_called_once()
                launch.assert_not_called()

    def test_agent_submission_does_not_fall_back_and_duplicate_on_error(self):
        bridge = self.bridge()
        with patch.object(bridge, 'json_cli', side_effect=[{'pane': {'agent': 'codex'}}, ValueError('timeout: delivery uncertain')]) as cli, patch.object(bridge, 'output') as output:
            bridge.mobile({'operation': 'prompt', 'params': {'paneId': 'w1:p1', 'text': 'hello'}, 'requestId': 'test'})
            self.assertEqual(cli.call_args_list[1].args, ('agent', 'prompt', 'w1:p1', 'hello'))
            self.assertEqual(cli.call_count, 2)
            self.assertIn('error', output.call_args.kwargs)

    def test_activity_is_not_fabricated_on_first_observation(self):
        bridge = self.bridge()
        with patch.object(bridge, 'cli', side_effect=['old output', 'old output', 'new output']):
            bridge.sample_activity('w1:p1')
            self.assertEqual(bridge.activity['w1:p1']['at'], 0)
            bridge.sample_activity('w1:p1')
            self.assertEqual(bridge.activity['w1:p1']['at'], 0)
            bridge.sample_activity('w1:p1')
            self.assertGreater(bridge.activity['w1:p1']['at'], 0)

    def test_model_command_preserves_native_draft(self):
        bridge = self.bridge()
        for agent, screen in [('codex', '› unfinished draft'), ('claude', '❯ unfinished draft'), ('devin', '❭ unfinished draft')]:
            with patch.object(bridge, 'json_cli', return_value={'pane':{'agent':agent}}) as cli, patch.object(bridge, 'cli', return_value=screen), patch.object(bridge, 'output') as output:
                bridge.mobile({'operation':'prompt','params':{'paneId':'p1','text':'/model'},'requestId':'m'})
                self.assertEqual(cli.call_count,1)
                self.assertIn('error',output.call_args.kwargs)
        self.assertTrue(module.model_prompt_ready('› Ask Codex to do anything\n\nGPT-6-Astra medium', 'codex'))
        self.assertTrue(module.model_prompt_ready('❯ \n─────────\nstatus', 'claude'))
        self.assertTrue(module.model_prompt_ready('❭ \n', 'devin'))
        self.assertTrue(module.model_prompt_ready('❭ Ask Devin to build features, fix bugs, or work on your code', 'devin'))
        self.assertTrue(module.model_prompt_ready('❯\u00a0Try "edit <filepath> to..."\n──────────\n? for shortcuts', 'claude', '❯\u00a0\x1b[7mT\x1b[0m\x1b[2mry "edit <filepath> to..."'))
        self.assertFalse(module.model_prompt_ready('❯ Try changing the login page\n──────────', 'claude'))
        self.assertFalse(module.model_prompt_ready('No prompt found', 'codex'))
        self.assertFalse(module.model_prompt_ready('› \n  unfinished second line\nGPT-6-Astra medium', 'codex'))

    def test_claude_dynamic_hint_requires_placeholder_cursor_style(self):
        for hint in ['Try "write a test for client.py"', 'Try "fix the build"']:
            screen = '❯\u00a0' + hint + '\n──────────\nNot logged in'
            ansi = '❯\u00a0\x1b[0m\x1b[7mT\x1b[0m' + hint[1:]
            self.assertTrue(module.model_prompt_ready(screen, 'claude', ansi))
            self.assertFalse(module.model_prompt_ready(screen, 'claude'))
            self.assertFalse(module.model_prompt_ready(screen, 'claude', screen))
            self.assertFalse(module.model_prompt_ready(screen, 'claude', ansi+'\n❯ real draft'))
        self.assertFalse(module.model_prompt_ready('❯ unfinished draft', 'claude', '❯\x1b[7mu\x1b[0mnfinished draft'))

    def test_keys_accept_plain_ack_and_menu_reads_only_visible_screen(self):
        bridge = self.bridge()
        with patch.object(bridge, 'cli', return_value='Sent') as cli, patch.object(bridge, 'output') as output:
            bridge.mobile({'operation':'key','params':{'paneId':'p1','key':'down'},'requestId':'key'})
            cli.assert_called_with('pane','send-keys','p1','down')
            self.assertNotIn('error',output.call_args.kwargs)
            bridge.mobile({'operation':'read','params':{'paneId':'p1','view':'menu'},'requestId':'menu'})
            cli.assert_called_with('pane','read','p1','--source','visible','--lines','160')
            self.assertEqual(output.call_args.kwargs['result']['view'],'menu')

    def test_shell_submission_accepts_plain_ack(self):
        bridge = self.bridge()
        with patch.object(bridge, 'json_cli', return_value={'pane': {}}), patch.object(bridge, 'cli', return_value='Sent') as cli, patch.object(bridge, 'output') as output:
            bridge.mobile({'operation': 'prompt', 'params': {'paneId': 'w1:p1', 'text': 'printf test'}, 'requestId': 'test'})
            cli.assert_called_once_with('pane', 'run', 'w1:p1', 'printf test')
            self.assertTrue(output.call_args.kwargs['result']['submitted'])


if __name__ == '__main__':
    unittest.main()
