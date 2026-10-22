(function (root) {
  'use strict';
  function severity(message) {
    if (/\b(error|failed|failure|fatal|panic|crit|alert|emerg|segfault|denied)\b/i.test(message)) return 'ERROR';
    if (/\b(warn(?:ing)?|timeout|timed out|invalid|deprecated)\b/i.test(message)) return 'WARN';
    return 'INFO';
  }
  function parseLine(raw, line, path) {
    const entry = { raw, line, time: '—', host: '', process: 'unparsed', pid: '', level: 'UNKNOWN', message: raw };
    // Preserve every original line, including unrecognized formats and continuations.
    let match = raw.match(/^(\S+) - (\S+) \[([^\]]+)\] "([^"]*)" (\d{3}) (\S+)(.*)$/);
    if (match) {
      const status = Number(match[5]);
      return { ...entry, time: match[3], process: 'nginx', level: status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO', message: `${match[1]}  ${match[4]}  → ${status} · ${match[6]} bytes`, host: match[1] };
    }
    match = raw.match(/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] (\d+)#\d+: (.*)$/);
    if (match) return { ...entry, time: match[1], process: 'nginx', pid: match[3], level: severity(match[2]), message: match[4] };
    match = raw.match(/^((?:[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})|(?:\d{4}-\d{2}-\d{2}T\S+))\s+(\S+)\s+([^\s:[\]]+)(?:\[(\d+)\])?:\s?(.*)$/);
    if (match) return { ...entry, time: match[1], host: match[2], process: match[3], pid: match[4] || '', level: severity(match[5]), message: match[5] };
    match = raw.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.+)$/);
    if (match) return { ...entry, time: match[1], process: path.includes('dpkg') ? 'dpkg' : 'system', level: severity(match[2]), message: match[2] };
    if (path.includes('/apt/')) return { ...entry, process: 'apt', level: raw.trim() ? severity(raw) : 'UNKNOWN' };
    return entry;
  }
  function parseFile(text, path) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.map((raw, index) => parseLine(raw, index + 1, path));
  }
  const api = { parseLine, parseFile };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BirdeyeLogParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
