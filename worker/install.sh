#!/bin/sh
set -eu
if [ "$(id -u)" != 0 ]; then echo 'Run with sudo on the Linux host.' >&2; exit 1; fi
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONFIG=${1:-"$BASE/../.secrets/worker.json"}
test -f "$CONFIG" || { echo 'Generate configuration with python3 scripts/setup.py first.' >&2; exit 1; }
command -v python3 >/dev/null
python3 -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ is required"'
command -v systemctl >/dev/null
id birdeye >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/birdeye-worker --shell /usr/sbin/nologin birdeye
# Debian/Ubuntu log files are commonly readable by the adm group.
if getent group adm >/dev/null; then usermod -a -G adm birdeye; fi
install -d -m 0755 /opt/birdeye
install -d -m 0750 -o root -g birdeye /etc/birdeye
install -m 0644 "$BASE/worker.py" /opt/birdeye/worker.py
install -m 0640 -o root -g birdeye "$CONFIG" /etc/birdeye/worker.json
install -m 0644 "$BASE/birdeye-worker.service" /etc/systemd/system/birdeye-worker.service
systemctl daemon-reload
systemctl enable birdeye-worker
systemctl restart birdeye-worker
echo 'Worker installed. Inspect: journalctl -u birdeye-worker -f'
