# Birdeye frontend

The authored files in `dist/` are the dependency-free frontend source. There is no generated build step. The frontend uses the authenticated API in `../backend` for configuration, runs, cancellation, and logs.

See the [deployment and architecture guide](../README.md) for Docker setup, the Linux host worker, credentials, scheduling semantics, and operations.

## Interface

- Overview shows real task totals, current-day run results, upcoming dispatches, and service heartbeats.
- Tasks supports Python, JavaScript, and shell scripts; one-off, repeating, cron, startup, and HTTP request triggers; pause/resume; and an execution timeout.
- Tasks can belong to one named color-coded group. Names must be unique ignoring case, nonblank, and at most 32 characters. Removing a group moves its tasks to Ungrouped. Group filters combine with runtime, status, and search.
- Run history shows queued, running, terminal, and interrupted runs. Details display separately styled stdout/stderr, exit status, cancellation, and links to System logs.
- System logs supports selected real host log snapshots and recent task output, search highlighting, inferred severity, process/task/run filters, readable/raw views, expandable original records, and matching-line export.

`api.js` handles administrator authentication and HTTP requests. The token is held in session storage. Configuration writes carry a revision to prevent stale edits overwriting another session. The app starts empty and does not load old local demo state. Failed requests report errors; they do not fall back to simulation.

`scheduling.js` is shared with the backend so validation and previews use the same UTC rules. `log-parser.js` handles host text formats. `system-logs.js` owns the viewer, supplied with real records through the API. Optional `document.modelContext` tools list task configurations and open the task editor when supported.

## Development

Run the API server as described in the root guide; it serves `dist/` directly. A plain static server cannot provide live task operations.

From the repository root:

```sh
node --test backend/tests/*.test.cjs site/tests/*.test.cjs
```
