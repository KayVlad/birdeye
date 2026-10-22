"""Real HTTP API + scheduler + Python worker integration. Run on Linux with NODE_BIN."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('worker', ROOT / 'worker' / 'worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
ADMIN = 'integration-admin-token-000000000000000000000'
WORKER = 'integration-worker-token-00000000000000000000'


@unittest.skipUnless(os.environ.get('NODE_BIN') or shutil.which('node'), 'Node runtime required')
class IntegrationTests(unittest.TestCase):
    def test_scripts_requests_boots_logs_and_restart(self):
        with tempfile.TemporaryDirectory(prefix='birdeye-integration-') as directory:
            directory = Path(directory)
            node = os.environ.get('NODE_BIN') or shutil.which('node')
            api = subprocess.Popen([node, str(ROOT / 'backend/tests/start-integration-server.cjs'), str(directory / 'app.db')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            runner = None
            try:
                port = api.stdout.readline().strip()
                self.assertTrue(port.isdigit(), 'API did not start')
                base = 'http://127.0.0.1:' + port
                def request(route, method='GET', body=None, token=ADMIN):
                    req = urllib.request.Request(base + '/api' + route, data=json.dumps(body).encode() if body is not None else None,
                                                 method=method, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                    with urllib.request.urlopen(req, timeout=10) as response:
                        return json.load(response)

                marker = directory / 'host-marker'
                tasks = [
                    {'id': 'python', 'name': 'Python execution', 'language': 'Python', 'script': 'import pathlib,sys\npathlib.Path(' + repr(str(marker)) + ').write_text("real host")\nprint("python-output")\nprint("stderr-output",file=sys.stderr)', 'timing': {'type': 'request'}},
                    {'id': 'javascript', 'name': 'JS execution', 'language': 'JavaScript', 'script': 'await Promise.resolve();console.log("javascript-output")', 'timing': {'type': 'request'}},
                    {'id': 'shell', 'name': 'Shell execution', 'language': 'Shell', 'script': 'printf "shell-output\\n"', 'timing': {'type': 'startup', 'delay': 0}},
                    {'id': 'hook', 'name': 'Webhook execution', 'language': 'Python', 'script': 'import os,json\nprint(json.load(open(os.environ["BIRDEYE_EVENT_FILE"]))["message"])', 'timing': {'type': 'request'}},
                ]
                for task in tasks:
                    task.update(enabled=True, groupId='health', timeout=10)
                request('/config', 'PUT', {'revision': 0, 'tasks': tasks, 'groups': [{'id': 'health', 'name': 'Healthchecks', 'color': 'blue'}]})
                config = directory / 'worker.json'
                config.write_text(json.dumps({'url': base, 'token': WORKER, 'state_dir': str(directory / 'state'), 'task_log': str(directory / 'tasks.log'), 'log_files': ['dpkg.log'], 'runtimes': {'JavaScript': node}}))
                def start_worker():
                    return subprocess.Popen(['python3', str(ROOT / 'worker/worker.py'), '--config', str(config)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                runner = start_worker()
                ids = [request('/tasks/python/run', 'POST', {})['id'], request('/tasks/javascript/run', 'POST', {})['id']]
                hook = next(t for t in request('/state')['tasks'] if t['id'] == 'hook')['hookToken']
                ids.append(request('/hooks/hook', 'POST', {'message': 'request-payload-ok'}, hook)['id'])
                deadline = time.monotonic() + 35
                while time.monotonic() < deadline:
                    state = request('/state')
                    if len(state['runs']) == 4 and all(r['status'] == 'Success' for r in state['runs']):
                        break
                    time.sleep(0.2)
                self.assertEqual(len(state['runs']), 4)
                self.assertTrue(all(r['status'] == 'Success' for r in state['runs']), [(r['name'], r['status'], r['detail']) for r in state['runs']])
                self.assertEqual(marker.read_text(), 'real host')
                outputs = {r['taskId']: request('/runs/' + r['id'] + '/output')['entries'] for r in state['runs']}
                self.assertIn('stderr', [e['stream'] for e in outputs['python']])
                self.assertIn('javascript-output', ''.join(e['message'] for e in outputs['javascript']))
                self.assertIn('request-payload-ok', ''.join(e['message'] for e in outputs['hook']))
                self.assertTrue(request('/task-logs')['entries'])
                self.assertEqual(request('/logs')['files'][0]['path'], 'dpkg.log')
                records = [json.loads(line) for line in (directory / 'tasks.log').read_text().splitlines()]
                self.assertEqual({r['taskId'] for r in records}, {'python', 'javascript', 'shell', 'hook'})
                runner.terminate();runner.wait(timeout=15)
                runner.stdout.close();runner.stderr.close()
                runner = start_worker()
                time.sleep(3)
                self.assertEqual(len(request('/state')['runs']), 4, 'Restart dispatched startup twice')
            finally:
                if runner:
                    runner.terminate()
                    runner.wait(timeout=15)
                    runner.stdout.close();runner.stderr.close()
                api.terminate();api.wait(timeout=10)
                api.stdout.close();api.stderr.close()


if __name__ == '__main__':
    unittest.main()
