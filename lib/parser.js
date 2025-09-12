
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');
const { normalizeToUtcString } = require('./date');

const TAIL_BYTES = 1_000_000;
const ENTERED_RE = /^\[(?<ts>.+?)\]\s+You have entered\s+(?<zone>.+?)(?:\.)?\s*$/i;
const PLAIN_RE   = /You have entered\s+(?<zone>.+?)(?:\.)?\s*$/i;
const LOG_NAME_RE = /^eqlog_.+?_/i;

async function tailLines(filePath, maxBytes = TAIL_BYTES) {
  try {
    const fh = await fsp.open(filePath, 'r');
    const stat = await fh.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    await fh.close();
    return buf.toString('utf8').split(/\r?\n/);
  } catch { return []; }
}
async function fullScanLastZone(filePath) {
  return new Promise((resolve) => {
    let last = { zone: null, ts: null };
    const s = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: s, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const l = (line || '').trim();
      let m = l.match(ENTERED_RE);
      if (m && m.groups) { last = { zone: m.groups.zone.trim(), ts: m.groups.ts.trim() }; return; }
      m = l.match(PLAIN_RE);
      if (m && m.groups) { last = { zone: m.groups.zone.trim(), ts: '' }; }
    });
    rl.on('close', () => resolve(last));
    rl.on('error', () => resolve({ zone: null, ts: null }));
  });
}
async function extractLastZone(filePath) {
  const lines = await tailLines(filePath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] || '').trim();
    let m = line.match(ENTERED_RE);
    if (m && m.groups) {
      return { zone: m.groups.zone.trim(), ts: normalizeToUtcString(m.groups.ts.trim()) || '' };
    }
    m = line.match(PLAIN_RE);
    if (m && m.groups) {
      return { zone: m.groups.zone.trim(), ts: '' };
    }
  }
  const fallback = await fullScanLastZone(filePath);
  return {
    zone: fallback.zone,
    ts: fallback.ts ? (normalizeToUtcString(fallback.ts) || '') : ''
  };
}
function characterFromLogFile(fileName) {
  const m = fileName.match(/^eqlog_(.+?)_/i);
  return m ? m[1] : '';
}

module.exports = { extractLastZone, characterFromLogFile, LOG_NAME_RE };
