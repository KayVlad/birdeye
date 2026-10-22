#!/usr/bin/env python3
"""Generate local credentials without displaying them or overwriting existing secrets."""
from pathlib import Path
import json
import os
import secrets
import argparse

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:8080')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1] / '.secrets'
root.mkdir(mode=0o700, exist_ok=True)
os.chmod(root, 0o700)
os.umask(0o077)
for name in ('admin-token', 'worker-token'):
    file = root / name
    if not file.exists():
        file.write_text(secrets.token_hex(32) + '\n')
    # Compose bind-mounted secrets retain file permissions. The 0700 parent
    # protects host access; the non-root container must be able to read the mount.
    os.chmod(file, 0o644)
config = root / 'worker.json'
if not config.exists():
    config.write_text(json.dumps({'url': args.url, 'token': (root / 'worker-token').read_text().strip(),
                                 'log_files': ['syslog', 'auth.log', 'kern.log', 'nginx/access.log', 'nginx/error.log', 'apt/history.log', 'dpkg.log']}, indent=2) + '\n')
print('Credentials are in .secrets/. Use admin-token to sign in; worker.json is for the host service.')
