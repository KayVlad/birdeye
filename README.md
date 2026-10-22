# Birdeye

A self-hosted automation dashboard for a Linux homelab. Create Python, JavaScript, and shell tasks, organize them into colored groups, schedule runs, and browse host and task logs.

## Architecture

```mermaid
flowchart LR
    Browser --> Frontend[Nginx / frontend]
    Frontend --> API
    API --> DB[(SQLite: configuration and queue)]
    Scheduler --> DB
    Worker[Linux host worker] --> API
    Worker --> Scripts[Host scripts]
    Worker --> Logs[/var/log]
```

Docker runs the frontend, authenticated API, and scheduler. The scheduler only enqueues jobs. A separate systemd worker on the Linux host claims and executes them, captures stdout/stderr and exit status, and uploads selected host log snapshots. One worker and one executing script at a time are supported. SQLite transactions coordinate the API and scheduler through a shared named volume.

The server starts empty. Previous browser demo tasks are not imported or activated. Task definitions, groups, run history, and output now persist on the server and are shared across browsers.

## Deploy on a Linux homelab

Requirements: Docker Engine with Compose, systemd, Python 3.10+, and Bash. Install Node.js on the host if you want JavaScript tasks; the Node.js in the API container is separate from the host runtime. Python packages used by your scripts must also be installed for the host interpreter.

From this repository's root on the Linux server:

```sh
python3 scripts/setup.py
docker compose up -d --build
sudo sh worker/install.sh
```

The setup script generates distinct administrator and worker credentials in `.secrets/` and preserves them on subsequent runs. The worker installer creates the `birdeye` account, installs the service, and starts it. On Debian/Ubuntu, it adds the account to `adm` for log reading. On other distributions, grant read permission to the specific log files you select.

Open `http://127.0.0.1:8080` on the server. From your workstation, use an SSH tunnel:

```sh
ssh -L 8080:127.0.0.1:8080 your-user@your-server
```

Then open `http://127.0.0.1:8080` on the workstation. Sign in with the value in `.secrets/admin-token`. The browser retains it in session storage until sign-out or the tab session ends. The worker token is only for the service.

The published port binds to loopback by default. For a trusted LAN/VPN, copy `.env.example` to `.env` and explicitly choose `BIRDEYE_BIND_ADDRESS=0.0.0.0`. For remote browser access, put an HTTPS reverse proxy in front of the app. A proxy on the host forwards to `127.0.0.1:8080`; a proxy container needs a shared network and forwards to `frontend:8080`. Serve the app at the domain root and preserve the Authorization header. Administrator access allows editing scripts that run on the host.

If you change `BIRDEYE_PORT`, set the same port in `/etc/birdeye/worker.json` and restart the worker. The worker accepts HTTP only for loopback connections; connections to a remote API require HTTPS with a valid certificate.

## Host permissions and runtime configuration

Scripts run as the service's `birdeye` account with a clean environment and a fresh temporary working directory for each run. They can access host paths allowed by that account and the systemd unit. `HOME` points to `/var/lib/birdeye-worker`. The unit blocks privilege escalation, protects `/etc` and `/usr` from writes, hides home directories, and limits the entire worker service to 512 MiB, 128 processes, and one CPU. Grant filesystem access to your task directories, such as `/srv/backups`, as needed. Systemd overrides can customize these settings for your host.

This is an administrator automation tool for trusted scripts. Scripts and the worker share a Unix account; it is not a sandbox for untrusted code. The Docker API has no host filesystem mount or Docker socket.

Optional executable overrides in `/etc/birdeye/worker.json` let you use a Python virtual environment or a Node installation outside the default PATH:

```json
"runtimes": {
  "Python": "/opt/birdeye-venv/bin/python3",
  "JavaScript": "/opt/node/bin/node",
  "Shell": "/usr/bin/bash"
}
```

Merge this field into the generated JSON, keeping its URL and token. Overrides must be absolute paths. Restart the worker after changing configuration:

```sh
sudo systemctl restart birdeye-worker
```

## Schedules and execution guarantees

- One-off dates, anchored intervals, daily/weekly schedules, and five-field numeric cron expressions use UTC. Cron supports wildcards, ranges, lists, and steps. It does not support seconds, named fields, or L/W/# extensions.
- The scheduler checks once per second. Occurrences more than 60 seconds late are skipped instead of replaying a backlog. A one-off occurrence is consumed once it is dispatched or skipped. Already queued jobs remain queued while the worker is offline.
- Startup schedules use the Linux host boot ID and boot timestamp. Restarting the worker does not dispatch them again. Enabling/creating a startup task after its delay has elapsed queues it once for the current boot. A new boot cancels startup jobs still waiting from an older boot.
- Only one queued or running job per task is allowed. A schedule occurring while that task has an outstanding job is skipped. Manual and request triggers return HTTP 409 in this case.
- Each run keeps the script and runtime configuration from when it was queued. Later task edits apply to future runs. Pausing a task cancels its queued jobs; it does not stop an executing job. Use Cancel run to stop that job.
- Timeouts are configurable from 1 to 3,600 seconds. The worker stops the process group on timeout, cancellation, shutdown, or loss of API contact for more than 30 seconds. A watchdog enforces the deadline even during a blocked network upload.
- Claims and output uploads tolerate request retries. The worker persists a recovery journal before starting a script. After a worker crash, an uncertain execution is marked Interrupted and is not automatically retried. An expired 60-second worker lease also becomes Interrupted. Exactly-once external side effects cannot be guaranteed; review uncertain runs before manually rerunning them.

## Request triggers

Save a task with the HTTP request trigger, then reopen it to copy its URL and task-specific bearer token. POST a JSON object:

```sh
curl -X POST https://birdeye.example/api/hooks/TASK_ID \
  -H 'Authorization: Bearer TASK_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"message":"deploy requested"}'
```

The API returns HTTP 202 with a run ID. Payloads are limited to 64 KiB. The script reads the JSON file at `BIRDEYE_EVENT_FILE`; `BIRDEYE_TASK_ID` and `BIRDEYE_RUN_ID` are also supplied. Payloads are not interpolated into shell commands. Requests are separate trigger events; a caller retry after a previous run finishes can create another run.

## Logs and retention

The worker captures stdout/stderr separately, uploads output while the process runs, and writes JSON records to `/var/log/birdeye/tasks.log`. Each record has a timestamp, task ID/name, run ID, stream, sequence number, and message. Host task logs rotate at 10 MiB with three backups. Each run retains up to 1 MiB of output, with an explicit truncation record.

The System logs view combines recent task output with configured real `/var/log` files. The worker uploads the last 256 KiB per file every 30 seconds. Edit `log_files` in `/etc/birdeye/worker.json` to select up to 20 relative paths, including rotated files such as `syslog.1`. File components are opened without following symlinks; traversal, devices, and FIFOs are rejected. Missing or unreadable files show the actual error. Only configured sources are read; the browser cannot request arbitrary host paths.

The UI polls runs every three seconds and log snapshots every ten seconds. Run history shows the latest 150 runs; the combined task-log view shows the latest 300 output chunks. Each run detail provides its retained output. File line numbers refer to the displayed tail, not absolute line numbers in the full host file. Log severity is inferred for host text and labeled from streams for task output; stderr does not necessarily mean a failed run.

Completed runs are retained for 30 days or the newest 1,000 completed runs, whichever limit is reached first. Boot dispatch keys survive retention pruning. Active/queued runs are retained. SQLite reuses freed storage, so its on-disk file may not shrink immediately.

## Operations and backups

```sh
docker compose config --quiet
docker compose ps
docker compose logs -f --tail=100 api scheduler
sudo journalctl -u birdeye-worker -f
```

The overview shows actual worker and scheduler heartbeats. Container health checks cover the web server, API, and scheduler separately. Restart policies restart exited containers; an unhealthy status alone does not restart them. The worker is enabled on host startup.

After updating repository files, rebuild containers and reinstall the worker:

```sh
sudo systemctl stop birdeye-worker
docker compose build --pull
docker compose up -d
sudo sh worker/install.sh
```

Stop between jobs when possible. Stopping the worker during a run interrupts it. Keep the named `birdeye-data` volume, `.secrets/`, `/etc/birdeye/worker.json`, and `/var/lib/birdeye-worker` when moving the installation. `docker compose down` preserves the database volume; `docker compose down -v` deletes it.

For a consistent SQLite backup, stop the worker and database writers, archive the volume, then restart:

```sh
sudo systemctl stop birdeye-worker
docker compose stop api scheduler
docker compose run -T --rm --no-deps --entrypoint tar api -C /data -czf - . > birdeye-data-backup.tar.gz
docker compose up -d
sudo systemctl start birdeye-worker
```

Back up credentials and worker configuration/state separately with access restricted to your administrator account. Database and log backups may contain script code, request payloads, and output secrets.

Images use updateable `stable-alpine` and `24-alpine` tags. Pin reviewed digests in both Dockerfiles if you need reproducible base images. The frontend uses optional Google Fonts with fallback fonts. The API uses [Node's built-in SQLite module](https://nodejs.org/api/sqlite.html); the frontend proxy uses [Nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass).

## Development and checks

The API can also serve `site/dist` directly for local development. It needs Node.js 24+, two distinct tokens of at least 32 characters, and a writable database path. Use the `BIRDEYE_ADMIN_TOKEN_FILE` and `BIRDEYE_WORKER_TOKEN_FILE` variables to point at the generated secret files, then run `node backend/server.cjs` and `node backend/scheduler.cjs` against the same `BIRDEYE_DB`. The default API address is `http://127.0.0.1:8081`. A plain static Python web server no longer provides the API.

Checks from the repository root:

```sh
node --test backend/tests/*.test.cjs site/tests/*.test.cjs
python3 -m unittest discover -s worker -p 'test_*.py' -v
```

Worker tests require Linux. Set `NODE_BIN` to an absolute Node executable path if it is not on PATH. Integration tests run actual Python, JavaScript, and shell scripts in temporary directories, exercise HTTP webhooks and startup dispatch, and verify worker restart recovery and log capture. They do not install a host service.
