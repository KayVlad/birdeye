const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, parseFile } = require('../dist/log-parser.js');

test('syslog extracts timestamp, host, process, PID, and failure severity', () => {
  const entry = parseLine('Sep 22 10:22:40 homelab-01 systemd[1]: analytics.service: Failed with result exit-code.', 18, '/var/log/syslog');
  assert.equal(entry.process, 'systemd');
  assert.equal(entry.pid, '1');
  assert.equal(entry.host, 'homelab-01');
  assert.equal(entry.level, 'ERROR');
  assert.equal(entry.line, 18);
});
test('ISO syslog and kernel entries without PID retain their metadata', () => {
  const entry = parseLine('2026-09-22T10:20:00.000+00:00 homelab kernel: USB disconnect', 1, '/var/log/kern.log');
  assert.equal(entry.process, 'kernel');
  assert.equal(entry.pid, '');
  assert.equal(entry.time, '2026-09-22T10:20:00.000+00:00');
});
test('nginx HTTP severity comes from response code, not request path', () => {
  const raw = '192.0.2.1 - - [22/Sep/2026:10:20:01 +0000] "GET /error HTTP/1.1" 200 4821 "-" "Mozilla/5.0"';
  assert.equal(parseLine(raw, 1, '/var/log/nginx/access.log').level, 'INFO');
  assert.equal(parseLine(raw.replace(' 200 ', ' 404 '), 1, '').level, 'WARN');
  assert.equal(parseLine(raw.replace(' 200 ', ' 502 '), 1, '').level, 'ERROR');
});
test('nginx error log uses the explicit severity', () => {
  const entry = parseLine('2026/09/22 10:22:41 [warn] 904#904: upstream server temporarily disabled', 1, 'nginx/error.log');
  assert.equal(entry.level, 'WARN');
  assert.equal(entry.pid, '904');
});
test('unrecognized and continuation lines preserve original content and line numbers', () => {
  const raw = '  traceback <script>alert(1)</script> & details';
  const entries = parseFile(`first\r\n\r\n${raw}\r\n`, '/var/log/custom.log');
  assert.equal(entries.length, 3);
  assert.equal(entries[1].raw, '');
  assert.equal(entries[2].raw, raw);
  assert.equal(entries[2].line, 3);
  assert.equal(entries[2].level, 'UNKNOWN');
});
test('package log formats stay readable without discarding apt blocks', () => {
  const dpkg = parseLine('2026-09-22 09:00:04 status installed nginx:amd64 1.24.0-2ubuntu7', 1, '/var/log/dpkg.log');
  assert.equal(dpkg.process, 'dpkg');
  assert.equal(dpkg.time, '2026-09-22 09:00:04');
  const apt = parseFile('Start-Date: 2026-09-22 09:00:00\nInstall: nginx\nEnd-Date: 2026-09-22 09:00:04', '/var/log/apt/history.log');
  assert.equal(apt.length, 3);
  assert.equal(apt[1].process, 'apt');
});
