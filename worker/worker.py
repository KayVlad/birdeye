#!/usr/bin/env python3
"""Single-host Birdeye worker. Requires Python 3.10+ and a Linux host."""
import argparse
import codecs
import datetime
import fcntl
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import tempfile
import threading
import time
import urllib.request
import urllib.parse
import uuid

MAX_OUTPUT = 1024 * 1024
STOP = threading.Event()


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def atomic_json(filename, data):
    temporary = filename.with_suffix('.tmp')
    with open(temporary, 'w', encoding='utf-8') as output:
        os.chmod(temporary, 0o600)
        json.dump(data, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, filename)
    fd = os.open(filename.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_log(root, relative, limit=256 * 1024):
    """Open each component without following symlinks, including rotations."""
    parts = Path(relative).parts
    if not parts or Path(relative).is_absolute() or any(p in ('.', '..') for p in parts):
        raise ValueError('Invalid log path')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    finally:
        os.close(fd)
    with os.fdopen(file_fd, 'rb') as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError('Not a regular file')
        start = max(0, metadata.st_size - limit)
        source.seek(start)
        data = source.read(limit)
        if start and b'\n' in data:
            data = data.split(b'\n', 1)[1]
        # Invalid bytes can expand to three-byte replacements; bound the UTF-8 snapshot too.
        return data.decode('utf-8', errors='replace').encode('utf-8')[-limit:].decode('utf-8', errors='ignore')


def kill_group(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def execute(run, work_root, on_progress, log_entry=lambda entry: None, stop=STOP, runtimes=None):
    """Execute a snapshot, with a clean environment and bounded output/time."""
    task = run['task']
    entries = []
    lock = threading.Lock()
    output_bytes = 0
    truncated = False

    def append(stream, message):
        nonlocal output_bytes, truncated
        with lock:
            if output_bytes >= MAX_OUTPUT:
                if truncated:
                    return
                truncated = True
                stream, message = 'system', '\n[Output limit reached; further output discarded]\n'
            else:
                message = message.encode('utf-8')[:MAX_OUTPUT-output_bytes].decode('utf-8', errors='ignore')
                output_bytes += len(message.encode('utf-8'))
            entry = {'seq': len(entries), 'stream': stream, 'time': timestamp(), 'message': message}
            entries.append(entry)
            log_entry(entry)

    def drain(pipe, stream):
        decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
        try:
            while True:
                chunk = os.read(pipe.fileno(), 2048)
                if not chunk:
                    break
                append(stream, decoder.decode(chunk))
            tail = decoder.decode(b'', final=True)
            if tail:
                append(stream, tail)
        finally:
            pipe.close()

    def snapshot():
        with lock:
            return list(entries)

    started = time.monotonic()
    last_ack = started
    next_update = started
    result = {'status': 'Failed', 'exitCode': None, 'detail': ''}
    process = None
    readers = []
    watchdog_done = threading.Event()
    watchdog_reason = {}
    with tempfile.TemporaryDirectory(prefix='run-', dir=work_root) as directory:
        extension, command = {'Python': ('py', ['python3', '-u']), 'JavaScript': ('mjs', ['node']), 'Shell': ('sh', ['bash'])}[task['language']]
        if runtimes and task['language'] in runtimes:
            command[0] = runtimes[task['language']]
        script = Path(directory) / ('script.' + extension)
        script.write_text(task['script'], encoding='utf-8')
        event = Path(directory) / 'event.json'
        event.write_text(json.dumps(run.get('event', {})), encoding='utf-8')
        environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(work_root), 'LANG': 'C.UTF-8',
                       'PYTHONUNBUFFERED': '1', 'BIRDEYE_RUN_ID': run['id'], 'BIRDEYE_TASK_ID': task['id'],
                       'BIRDEYE_EVENT_FILE': str(event)}
        try:
            process = subprocess.Popen(command + [str(script)], cwd=directory, env=environment,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       start_new_session=True)

            def watch_deadlines():
                # Network uploads must not postpone timeouts or process cleanup.
                while not watchdog_done.wait(0.1):
                    if process.poll() is not None:
                        return
                    if stop.is_set():
                        watchdog_reason.update(status='Interrupted', detail='Worker stopping')
                    elif time.monotonic() - started >= task['timeout']:
                        watchdog_reason.update(status='Timed out', detail='Execution timeout reached')
                    elif time.monotonic() - last_ack > 30:
                        watchdog_reason.update(status='Interrupted', detail='API unavailable; worker stopped the script')
                    if watchdog_reason:
                        kill_group(process)
                        return

            watchdog = threading.Thread(target=watch_deadlines, daemon=True)
            watchdog.start()
            for pipe, stream in ((process.stdout, 'stdout'), (process.stderr, 'stderr')):
                thread = threading.Thread(target=drain, args=(pipe, stream), daemon=True)
                thread.start()
                readers.append(thread)
            while True:
                now = time.monotonic()
                if now >= next_update:
                    try:
                        response = on_progress(snapshot())
                        last_ack = time.monotonic()
                        if watchdog_reason:
                            result.update(watchdog_reason)
                            break
                        if response.get('cancel'):
                            result.update(status='Cancelled', detail='Cancellation requested')
                            break
                    except Exception:
                        pass  # Local journal is retained; retry until the lease safety deadline.
                    next_update = time.monotonic() + 2
                if stop.is_set():
                    result.update(status='Interrupted', detail='Worker stopping')
                    break
                if time.monotonic() - last_ack > 30:
                    result.update(status='Interrupted', detail='API unavailable; worker stopped the script')
                    break
                if time.monotonic() - started >= task['timeout']:
                    result.update(status='Timed out', detail='Execution timeout reached')
                    break
                code = process.poll()
                if code is not None:
                    result.update(status='Success' if code == 0 else 'Failed', exitCode=code)
                    if watchdog_reason:
                        result.update(watchdog_reason)
                    break
                time.sleep(0.1)
        except Exception as error:
            result['detail'] = str(error)
            append('system', str(error) + '\n')
        finally:
            watchdog_done.set()
            if process is not None:
                kill_group(process)
                if result['exitCode'] is None:
                    result['exitCode'] = process.returncode
            for reader in readers:
                reader.join(timeout=3)
    return result, snapshot()


class Worker:
    def __init__(self, config):
        self.url = config['url'].rstrip('/')
        url = urllib.parse.urlparse(self.url)
        if url.scheme not in ('http', 'https') or not url.hostname:
            raise ValueError('Invalid API URL')
        if url.scheme == 'http' and url.hostname not in ('127.0.0.1', 'localhost', '::1'):
            raise ValueError('Use HTTPS when connecting beyond loopback')
        self.token = config['token']
        self.runtimes = config.get('runtimes', {})
        for language, executable in self.runtimes.items():
            if language not in ('Python', 'JavaScript', 'Shell') or not Path(executable).is_absolute():
                raise ValueError('Runtime overrides must be absolute executable paths')
        self.state = Path(config.get('state_dir', '/var/lib/birdeye-worker')).resolve()
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = open(self.state / 'worker.lock', 'w')
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.pending_file = self.state / 'pending.json'
        self.files = config.get('log_files', ['syslog', 'auth.log', 'kern.log', 'apt/history.log', 'dpkg.log'])
        if len(self.files) > 20:
            raise ValueError('At most 20 log sources are supported')
        self.log_root = '/var/log'
        log_path = Path(config.get('task_log', '/var/log/birdeye/tasks.log'))
        log_path.parent.mkdir(parents=True, exist_ok=True)
        self.logger = logging.getLogger('birdeye.output')
        self.logger.setLevel(logging.INFO)
        handler = RotatingFileHandler(log_path, maxBytes=10*1024*1024, backupCount=3, encoding='utf-8')
        handler.setFormatter(logging.Formatter('%(message)s'))
        self.logger.addHandler(handler)
        self.last_logs = float('-inf')
        self.boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        boot_seconds = next(line.split()[1] for line in Path('/proc/stat').read_text().splitlines() if line.startswith('btime '))
        self.boot_at = int(boot_seconds) * 1000

    def post(self, route, data):
        request = urllib.request.Request(self.url + '/api/worker/' + route, data=json.dumps(data, ensure_ascii=False).encode('utf-8'),
                                         headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def hello(self):
        self.post('hello', {'boot': self.boot, 'bootAt': self.boot_at, 'hostname': socket.gethostname()})

    def logs(self):
        if time.monotonic() - self.last_logs < 30:
            return
        files = []
        for relative in self.files:
            try:
                content = read_log(self.log_root, relative)
                # Bound wire size too: escaped control characters can expand JSON.
                while len(json.dumps(content, ensure_ascii=False).encode('utf-8')) > 270000:
                    content = content[len(content)//4:]
                files.append({'path': relative, 'content': content, 'error': ''})
            except (OSError, ValueError) as error:
                files.append({'path': relative, 'content': '', 'error': str(error)})
        self.post('logs', {'files': files})
        self.last_logs = time.monotonic()

    def sync(self, pending):
        entries = pending.get('entries', [])
        offset = pending.get('acked', 0)
        response = {'cancel': False}
        while True:
            batch = entries[offset:offset+256]
            response = self.post('runs/' + pending['run']['id'] + '/progress', {'claimKey': pending['claimKey'], 'entries': batch})
            offset += len(batch)
            pending['acked'] = offset
            atomic_json(self.pending_file, pending)
            if offset >= len(entries):
                return response

    def complete(self, pending):
        self.sync(pending)
        self.post('runs/' + pending['run']['id'] + '/finish', {'claimKey': pending['claimKey'], **pending['result']})
        self.pending_file.unlink()

    def cycle(self):
        self.hello()
        self.logs()
        if self.pending_file.exists():
            pending = json.loads(self.pending_file.read_text())
            if 'run' in pending:
                if 'result' not in pending:
                    pending['result'] = {'status': 'Interrupted', 'exitCode': None, 'detail': 'Worker restarted; outcome uncertain. Not retried.'}
                    atomic_json(self.pending_file, pending)
                self.complete(pending)
                return
        else:
            pending = {'claimKey': str(uuid.uuid4())}
            atomic_json(self.pending_file, pending)
        run = self.post('claim', {'claimKey': pending['claimKey']})['run']
        if run is None:
            self.pending_file.unlink()
            return
        if run['status'] != 'Running':
            self.pending_file.unlink()
            return
        pending['run'] = run
        pending['entries'] = []
        # Persist before Popen. A restart with this record never launches the script again.
        atomic_json(self.pending_file, pending)

        def progress(entries):
            pending['entries'] = entries
            atomic_json(self.pending_file, pending)
            response = self.sync(pending)
            self.hello()
            try:
                self.logs()
            except Exception:
                pass  # Log snapshots must not prevent run heartbeats.
            return response

        def log_entry(entry):
            self.logger.info(json.dumps({'runId': run['id'], 'taskId': run['task']['id'], 'task': run['task']['name'], **entry}))

        result, entries = execute(run, self.state, progress, log_entry, runtimes=self.runtimes)
        pending.update(result=result, entries=entries)
        atomic_json(self.pending_file, pending)
        self.complete(pending)

    def run(self):
        while not STOP.is_set():
            try:
                self.cycle()
            except Exception as error:
                # Never print requests or config, which contain the worker credential.
                print('Worker cycle failed:', type(error).__name__, flush=True)
            STOP.wait(2)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='/etc/birdeye/worker.json')
    args = parser.parse_args()
    os.umask(0o077)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: STOP.set())
    Worker(json.loads(Path(args.config).read_text())).run()
