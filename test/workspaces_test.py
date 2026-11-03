import unittest
from unittest.mock import patch
import client_routing_test as routing

class WorkspaceTests(unittest.TestCase):
    def test_worktree_identity_uses_checkout_not_name_or_first_tree(self):
        bridge = routing.RoutingTests().bridge()
        info = {'source':{'source_checkout_path':'/repo/main','repo_name':'repo'}, 'worktrees':[
            {'path':'/repo/main','branch':'main','is_linked_worktree':False},
            {'path':'/repo/feature','branch':'feature','is_linked_worktree':True,'open_workspace_id':'w2'}]}
        with patch.object(bridge,'json_cli',return_value=info) as cli:
            detail=bridge.workspace_details({'workspace_id':'w2','label':'custom label'})
            self.assertEqual((detail['kind'],detail['branch'],detail['checkout']),('worktree','feature','/repo/feature'))
            self.assertEqual(bridge.workspace_details({'workspace_id':'w2','label':'renamed'})['label'],'renamed')
            cli.assert_called_once_with('worktree','list','--workspace','w2')

    def test_create_uses_explicit_source_and_rejects_workspace_mismatch(self):
        bridge=routing.RoutingTests().bridge()
        source={'pane':{'workspace_id':'w2','cwd':'/repo/feature/subdir'}}
        with patch.object(bridge,'json_cli',side_effect=[source,{'root_pane':{'pane_id':'w2:p8'}}]) as cli, patch.object(bridge,'output') as out:
            bridge.mobile({'operation':'create','requestId':'c','params':{'paneId':'w2:p3','workspaceId':'w2','label':'New'}})
            self.assertEqual(cli.call_args.args,('tab','create','--workspace','w2','--label','New','--no-focus','--cwd','/repo/feature/subdir'))
            self.assertEqual(out.call_args.kwargs['result']['paneId'],'w2:p8')
        with patch.object(bridge,'json_cli',return_value=source) as cli,patch.object(bridge,'output') as out:
            bridge.mobile({'operation':'create','requestId':'c','params':{'paneId':'w2:p3','workspaceId':'w1','label':'New'}})
            self.assertEqual(cli.call_count,1)
            self.assertIn('error',out.call_args.kwargs)

    def test_close_requires_confirmation_and_same_terminal(self):
        bridge=routing.RoutingTests().bridge()
        params={'paneId':'w2:p3','terminalId':'term_new','confirmed':True}
        for invalid in ({**params,'confirmed':False},{**params,'terminalId':'term_old'}):
            with patch.object(bridge,'json_cli',return_value={'pane':{'terminal_id':'term_new'}}) as cli,patch.object(bridge,'output') as out:
                bridge.mobile({'operation':'close','requestId':'x','params':invalid})
                self.assertTrue(all(call.args[:2]!=('pane','close') for call in cli.call_args_list))
                self.assertIn('error',out.call_args.kwargs)
        bridge.transcripts={'w2:p3':{},'w1:p1':{}}
        with patch.object(bridge,'json_cli',side_effect=[{'pane':{'terminal_id':'term_new'}},{}]) as cli,patch.object(bridge,'output') as out:
            bridge.mobile({'operation':'close','requestId':'x','params':params})
            self.assertEqual(cli.call_args.args,('pane','close','w2:p3'))
            self.assertTrue(out.call_args.kwargs['result']['closed'])
            self.assertEqual(list(bridge.transcripts),['w1:p1'])
