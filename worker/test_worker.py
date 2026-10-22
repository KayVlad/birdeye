import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location('worker', Path(__file__).with_name('worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='birdeye-worker-test-')
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, language, script, timeout=5, progress=None):
        run = {'id': 'run-test', 'task': {'id': 'task-test', 'language': language, 'script': script, 'timeout': timeout}, 'event': {'test': True}}
        runtimes = {'JavaScript': os.environ['NODE_BIN']} if os.environ.get('NODE_BIN') else None
        return worker.execute(run, self.root, progress or (lambda _: {'cancel': False}), stop=threading.Event(), runtimes=runtimes)

    def test_python_streams_exit_status_event_and_clean_environment(self):
        os.environ['BIRDEYE_WORKER_TOKEN'] = 'must-not-leak'
        result, output = self.run_script('Python', 'import sys,os,json\nprint(json.load(open(os.environ["BIRDEYE_EVENT_FILE"])))\nprint(os.getenv("BIRDEYE_WORKER_TOKEN","absent"))\nprint("bad",file=sys.stderr)\nsys.exit(7)')
        self.assertEqual(result['status'], 'Failed')
        self.assertEqual(result['exitCode'], 7)
        self.assertIn('stderr', [e['stream'] for e in output])
        text = ''.join(e['message'] for e in output)
        self.assertIn('absent', text)
        self.assertIn("'test': True", text)
        self.assertNotIn('must-not-leak', text)

    def test_shell_executes_on_host(self):
        result, output = self.run_script('Shell', 'printf "host:%s\\n" "$(uname -s)"')
        self.assertEqual(result['status'], 'Success')
        self.assertIn('host:Linux', ''.join(e['message'] for e in output))

    @unittest.skipUnless(shutil.which('node') or os.environ.get('NODE_BIN'), 'Node runtime not installed on this test host')
    def test_javascript_esm_and_output(self):
        result, output = self.run_script('JavaScript', 'await Promise.resolve(); console.log("javascript-ok")')
        self.assertEqual(result['status'], 'Success')
        self.assertIn('javascript-ok', ''.join(e['message'] for e in output))

    def test_timeout_kills_child_process_group(self):
        marker = self.root / 'child-survived'
        script = 'import subprocess,time\nsubprocess.Popen(["bash","-c",' + repr('sleep 2; touch ' + str(marker)) + '])\ntime.sleep(30)'
        result, _ = self.run_script('Python', script, timeout=1)
        self.assertEqual(result['status'], 'Timed out')
        time.sleep(2)
        self.assertFalse(marker.exists())

    def test_cancel_and_output_cap(self):
        result, _ = self.run_script('Python', 'import time;time.sleep(30)', progress=lambda _: {'cancel': True})
        self.assertEqual(result['status'], 'Cancelled')
        result, entries = self.run_script('Python', 'print("x"*2000000)')
        self.assertEqual(result['status'], 'Success')
        self.assertLess(sum(len(e['message'].encode()) for e in entries), worker.MAX_OUTPUT+200)
        self.assertTrue(any('Output limit reached' in e['message'] for e in entries))

    def test_blocked_upload_does_not_postpone_script_timeout(self):
        marker = self.root / 'survived-upload'
        script = 'import time,pathlib\ntime.sleep(2)\npathlib.Path(' + repr(str(marker)) + ').touch()\ntime.sleep(30)'
        def stalled_upload(_):
            time.sleep(3)
            return {'cancel': False}
        result, _ = self.run_script('Python', script, timeout=1, progress=stalled_upload)
        self.assertEqual(result['status'], 'Timed out')
        self.assertFalse(marker.exists())

    def test_log_reader_refuses_traversal_symlinks_and_pipes(self):
        (self.root / 'syslog').write_text('one\ntwo\n')
        self.assertEqual(worker.read_log(self.root, 'syslog'), 'one\ntwo\n')
        (self.root / 'link').symlink_to(self.root / 'syslog')
        os.mkfifo(self.root / 'pipe')
        for path in ('../secret', '/etc/passwd', 'link', 'pipe'):
            with self.assertRaises((OSError, ValueError)):
                worker.read_log(self.root, path)
        self.assertEqual(worker.read_log(self.root, 'syslog', 5), 'two\n')

    def test_recovery_reports_interruption_without_executing_again(self):
        instance = object.__new__(worker.Worker)
        instance.pending_file = self.root / 'pending.json'
        worker.atomic_json(instance.pending_file, {'claimKey': 'lost', 'run': {'id': 'run-test'}, 'entries': []})
        instance.hello = lambda: None
        instance.logs = lambda: None
        completions = []
        instance.complete = lambda pending: completions.append(pending)
        instance.cycle()
        self.assertEqual(completions[0]['result']['status'], 'Interrupted')

    def test_logs_upload_immediately_after_worker_start(self):
        instance = object.__new__(worker.Worker)
        instance.last_logs = float('-inf')
        instance.files = ['syslog']
        instance.log_root = self.root
        (self.root / 'syslog').write_text('real-log-line\n')
        uploaded = []
        instance.post = lambda route, body: uploaded.append((route, body))
        instance.logs()
        self.assertEqual(uploaded[0][1]['files'][0]['content'], 'real-log-line\n')
        instance.logs()
        self.assertEqual(len(uploaded), 1)


if __name__ == '__main__':
    unittest.main()
