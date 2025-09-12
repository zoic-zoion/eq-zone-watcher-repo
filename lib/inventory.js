
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { formatUtcYmdHms } = require('./date');

function listInventoryFiles(baseDir) {
  if (!baseDir) return [];
  const pat = /^(?<char>.+)-Inventory\.txt$/i;
  try {
    return fs.readdirSync(baseDir, { withFileTypes: true })
      .filter(de => de.isFile() && pat.test(de.name))
      .map(de => ({ character: de.name.match(pat).groups.char, filePath: path.join(baseDir, de.name), fileName: de.name }));
  } catch { return []; }
}
async function readInventoryTSV(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const split = s => s.split(/\t+/);
  const rows = [split(lines[0])];
  for (let i = 1; i < lines.length; i++) rows.push(split(lines[i]));
  return rows;
}
async function fileDates(filePath) {
  try {
    const st = await fsp.stat(filePath);
    const createdUtc = st.birthtime ? formatUtcYmdHms(new Date(st.birthtime)) : '';
    const modifiedUtc = st.mtime ? formatUtcYmdHms(new Date(st.mtime)) : '';
    return { createdUtc, modifiedUtc };
  } catch { return { createdUtc: '', modifiedUtc: '' }; }
}

module.exports = { listInventoryFiles, readInventoryTSV, fileDates };
