
// main.js — EQ Zone Watcher (modular + diagnostics + rotation + robust send)
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const dotenv = require('dotenv');
const chokidar = require('chokidar');
const {
  app, Tray, Menu, nativeImage, nativeTheme, shell, dialog, BrowserWindow, ipcMain
} = require('electron');

const { normalizeToUtcString, nowUtcStamp } = require('./lib/date');
const { extractLastZone, characterFromLogFile, LOG_NAME_RE } = require('./lib/parser');
const { listInventoryFiles, readInventoryTSV, fileDates } = require('./lib/inventory');
const { postBlobToAppsScript } = require('./lib/sheets');

// ---- ENV ----
(function loadEnv() {
  const fs = require('fs');
  const path = require('path');
  const prodEnv = app.isPackaged ? path.join(process.resourcesPath, '.env.production') : null;
  const devEnv  = path.join(__dirname, '.env');
  const pick = (prodEnv && fs.existsSync(prodEnv)) ? prodEnv : (fs.existsSync(devEnv) ? devEnv : null);
  if (pick) dotenv.config({ path: pick });
})();

// ---------- Config ----------
const DEFAULTS = {
  sheetId: (process.env.EQ_SHEET_ID || '').trim(),
  appsScriptUrl: (process.env.APPS_SCRIPT_URL || '').trim(),
  appsScriptSecret: (process.env.APPS_SCRIPT_SECRET || '').trim(),
  eqBaseDir: (process.env.EQ_BASE_DIR || '').trim(),
  eqLogDir: (process.env.EQ_LOG_DIR || '').trim(),
  zoneTabTitle: (process.env.EQ_SHEET_TAB || 'Zone Tracker').trim(),
  enablePeriodicScan: true,
  scanIntervalSecs: Number(process.env.SCAN_INTERVAL_SECS || 120)
};

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const STATE_PATH  = path.join(app.getPath('userData'), 'latest.json');
const LOG_PATH    = path.join(app.getPath('userData'), 'app.log');

let CONFIG = { ...DEFAULTS, ...safeLoadConfig() };

function safeLoadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (_) {}
  return {};
}
function saveConfig(patch = {}) {
  CONFIG = { ...CONFIG, ...patch };
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2));
  } catch (e) { console.warn('Failed to save config:', e?.message || e); }
}

// Optional: let env override saved config (non-empty wins)
(function applyEnvOverrides(){
  function s(v){ return (v||'').trim(); }
  const env = {
    sheetId: s(process.env.EQ_SHEET_ID),
    appsScriptUrl: s(process.env.APPS_SCRIPT_URL),
    appsScriptSecret: s(process.env.APPS_SCRIPT_SECRET),
    eqBaseDir: s(process.env.EQ_BASE_DIR),
    eqLogDir: s(process.env.EQ_LOG_DIR),
    zoneTabTitle: s(process.env.EQ_SHEET_TAB),
    scanIntervalSecs: process.env.SCAN_INTERVAL_SECS ? Number(process.env.SCAN_INTERVAL_SECS) : undefined
  };
  for (const [k,v] of Object.entries(env)) {
    if (v !== undefined && v !== '') CONFIG[k] = v;
  }
})();

const SHEET_ID = () => CONFIG.sheetId.trim();
const APPS_SCRIPT_URL = () => CONFIG.appsScriptUrl.trim();
const SECRET = () => CONFIG.appsScriptSecret.trim();
const EQ_BASE_DIR = () => CONFIG.eqBaseDir.trim();
const EQ_LOG_DIR = () => CONFIG.eqLogDir.trim();
const ZONE_TAB = () => CONFIG.zoneTabTitle.trim();

// ---------- Logger + rotation ----------
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 5 * 1024 * 1024);
const LOG_MAX_FILES = Number(process.env.LOG_MAX_FILES || 3);
const LOG_COMPRESS   = String(process.env.LOG_COMPRESS || '0') === '1';

function rotateLogsIfNeeded(nextBytes = 0) {
  try {
    const curSize = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH).size : 0;
    if (curSize + nextBytes <= LOG_MAX_BYTES) return;
    for (let i = LOG_MAX_FILES; i >= 2; i--) {
      const p = `${LOG_PATH}.${i-1}`;
      const q = `${LOG_PATH}.${i}`;
      if (fs.existsSync(q)) { try { fs.unlinkSync(q); } catch {} }
      if (fs.existsSync(p)) { try { fs.renameSync(p, q); } catch {} }
    }
    if (fs.existsSync(LOG_PATH)) {
      try { fs.renameSync(LOG_PATH, `${LOG_PATH}.1`); } catch {}
      if (LOG_COMPRESS) {
        try {
          const zlib = require('zlib');
          const inp = fs.createReadStream(`${LOG_PATH}.1`);
          const out = fs.createWriteStream(`${LOG_PATH}.1.gz`);
          inp.pipe(zlib.createGzip()).pipe(out).on('finish', () => {
            try { fs.unlinkSync(`${LOG_PATH}.1`); } catch {}
          });
        } catch {}
      }
    }
  } catch {}
}
function log(...args){
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { rotateLogsIfNeeded(Buffer.byteLength(line)); fs.appendFileSync(LOG_PATH, line, 'utf8'); } catch {}
  try { console.log(line.trim()); } catch {}
}
rotateLogsIfNeeded(0);

// ---------- State ----------
let tray = null;
let watcher = null;
let rescanTimer = null;
let rateLimitUntil = 0;

const debounceMap = new Map();
const pendingLatest = new Map();   // queued send
const latestByFile = new Map();    // local snapshot

let lastPeriodicRun = 0;
let lastFlushAt = 0;
let cycleInFlight = false;

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const obj = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      if (obj && obj.latest && typeof obj.latest === 'object') {
        for (const [k, v] of Object.entries(obj.latest)) latestByFile.set(k, v);
      }
    }
  } catch (e) { log('Failed to load state:', e?.message || e); }
}
function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const blob = { latest: Object.fromEntries(latestByFile.entries()) };
    fs.writeFileSync(STATE_PATH, JSON.stringify(blob, null, 2), 'utf8');
  } catch (e) { log('Failed to save state:', e?.message || e); }
}

// ---------- UI helpers ----------
function pathExists(p) { try { return fs.existsSync(p); } catch { return false; } }
function resolveAsset(rel) {
  const p1 = path.join(__dirname, rel);
  const p2 = path.join(process.resourcesPath, rel);
  return pathExists(p1) ? p1 : (pathExists(p2) ? p2 : p1);
}
function loadTrayIcon() {
  const name = nativeTheme.shouldUseDarkColors ? 'tray-light.png' : 'tray-dark.png';
  return nativeImage.createFromPath(resolveAsset(path.join('assets', name)));
}
async function promptInput({ title, label, defaultValue = '' }) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 520, height: 220, minWidth: 420, minHeight: 180,
      resizable: true, maximizable: true, minimizable: false, alwaysOnTop: true,
      useContentSize: true, title,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    const html = `
      <!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
      <title>${title.replace(/</g,'&lt;')}</title>
      <style>body{margin:0;font-family:system-ui,sans-serif;padding:16px;display:flex;flex-direction:column;gap:12px}
      label{font-weight:600} #val{width:100%;padding:10px} .row{display:flex;gap:8px;justify-content:flex-end;margin-top:auto}
      button{padding:8px 14px}</style></head><body>
        <label>${label.replace(/</g,'&lt;')}</label>
        <input id="val" type="text" value="${(defaultValue||'').replace(/"/g,'&quot;')}" autofocus />
        <div class="row"><button id="cancel">Cancel</button><button id="ok">Save</button></div>
        <script>
          const {ipcRenderer}=require('electron');const $=id=>document.getElementById(id);
          $('ok').onclick=()=>ipcRenderer.send('prompt:submit',$('val').value);
          $('cancel').onclick=()=>ipcRenderer.send('prompt:submit',null);
          document.addEventListener('keydown',e=>{if(e.key==='Enter')$('ok').click();if(e.key==='Escape')$('cancel').click();});
        </script>
      </body></html>`;
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const handler = (_evt, value) => { ipcMain.removeListener('prompt:submit', handler); try { win.close(); } catch {}; resolve(value); };
    ipcMain.on('prompt:submit', handler);
  });
}
async function promptDirectory({ title, message }) {
  const res = await dialog.showOpenDialog({ title, message, properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths?.[0]) return null;
  return res.filePaths[0];
}

// ---------- Required config flow ----------
async function ensureRequiredConfigFlow() {
  if (!APPS_SCRIPT_URL()) {
    const url = await promptInput({ title: 'Apps Script Web App URL', label: 'Paste the Web App URL (ends with /exec):' });
    if (!url) throw new Error('Apps Script Web App URL is required.');
    saveConfig({ appsScriptUrl: url.trim() });
  }
  if (!SHEET_ID()) {
    const sid = await promptInput({ title: 'Google Sheet ID (optional)', label: 'Enter the Spreadsheet ID (leave blank if your script knows it):' });
    if (sid !== null) saveConfig({ sheetId: (sid || '').trim() });
  }
  if (!EQ_LOG_DIR()) {
    const dir = await promptDirectory({ title: 'Select EQ Logs Folder', message: 'Pick the folder with eqlog_*.txt files.' });
    if (!dir) throw new Error('EQ Logs folder is required.');
    saveConfig({ eqLogDir: dir });
  }
  if (!EQ_BASE_DIR()) {
    const dir = await promptDirectory({ title: 'Select EQ Base Folder (optional)', message: 'Folder with *-Inventory.txt files.' });
    if (dir) saveConfig({ eqBaseDir: dir });
  }
}

// ---------- Build blobs ----------
function buildPendingBlobZones() {
  return { zoneTab: ZONE_TAB(), latest: Object.fromEntries(pendingLatest.entries()) };
}
function buildExportBlobAll() {
  return { zoneTab: ZONE_TAB(), latest: Object.fromEntries(latestByFile.entries()) };
}

// ---------- Google POST wrapper ----------
async function postBlob(blob, { mode = 'directImport' } = {}) {
  return postBlobToAppsScript({
    url: APPS_SCRIPT_URL(),
    secret: SECRET(),
    sheetId: SHEET_ID(),
    blob,
    mode
  });
}

// ---------- Zone upsert ----------
async function upsertLatestFor(fileName, zone, detectedTsNormalized) {
  const char = characterFromLogFile(fileName) || '';
  const newRec = {
    fileName,
    character: char,
    zone,
    detectedTs: detectedTsNormalized || '',
    updatedUtc: nowUtcStamp()
  };
  const prev = latestByFile.get(fileName);
  const changed = !prev || prev.zone !== newRec.zone || prev.detectedTs !== newRec.detectedTs;

  latestByFile.set(fileName, newRec);
  if (changed) {
    log(`delta queued for ${fileName}: "${prev?.zone || '(none)'}" → "${newRec.zone}"`);
    pendingLatest.set(fileName, newRec);
    saveState();
  }
}

// ---------- Commands ----------
async function processLogFile(fullPath, fileName) {
  const { zone, ts } = await extractLastZone(fullPath);
  if (!zone) return;
  await upsertLatestFor(fileName, zone, ts || '');
}
async function onLogChange(filePath) {
  if (!/\.txt$/i.test(filePath)) return;
  const base = path.basename(filePath);
  if (!LOG_NAME_RE.test(base)) return;
  const prev = debounceMap.get(base);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    processLogFile(filePath, base).catch(e => log('Process log failed: ' + (e?.message || e)));
    debounceMap.delete(base);
  }, 250);
  debounceMap.set(base, t);
}
async function scanAllOnce() {
  const dir = EQ_LOG_DIR();
  if (!dir) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  const txtFiles = entries
    .filter(de => de.isFile() && LOG_NAME_RE.test(de.name) && /\.txt$/i.test(de.name))
    .map(de => de.name)
    .sort((a,b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  for (const name of txtFiles) {
    await processLogFile(path.join(dir, name), name);
  }
}

async function flushZonesNow() {
  const entries = Array.from(pendingLatest.entries());
  if (!entries.length) { log('flushZonesNow: nothing to send'); return; }
  const blob = { zoneTab: ZONE_TAB(), latest: Object.fromEntries(entries) };
  log(`flushZonesNow: sending ${entries.length} record(s)`);

  let status=0, payload=null, text='';
  try {
    const resp = await postBlob(blob, { mode: 'directImport' });
    status = resp.status; payload = resp.payload; text = resp.text;
  } catch (e) {
    log(`flushZonesNow: POST error ${e?.status||0} ${e?.message||e}`);
    return; // keep queue for retry
  }
  log(`flushZonesNow: http=${status} json=${!!payload} snippet=${String(text).slice(0,120).replace(/\s+/g,' ')}`);
  if (payload) log(`flushZonesNow: reply ok=${payload.ok} mode=${payload.mode} upserts=${payload?.result?.upserts}`);

  if (payload && payload.ok === true) {
    let cleared = 0, kept = 0;
    for (const [k, sentRec] of entries) {
      const cur = pendingLatest.get(k);
      if (!cur) continue;
      const same = cur.zone === sentRec.zone && cur.detectedTs === sentRec.detectedTs && cur.updatedUtc === sentRec.updatedUtc;
      if (same) { pendingLatest.delete(k); cleared++; } else { kept++; }
    }
    lastFlushAt = Date.now();
    log(`flushZonesNow: done (cleared=${cleared}, kept_newer=${kept})`);
  } else {
    log('flushZonesNow: server did not return ok=true JSON; keeping pending items for retry');
  }
}

// Initial Scan (scan + send immediately)
async function initialScanAndSend() {
  if (cycleInFlight) return;
  cycleInFlight = true;
  try {
    await scanAllOnce();
    if (pendingLatest.size === 0 && latestByFile.size > 0) {
      log('initialScanAndSend: forcing full snapshot push');
      const resp = await postBlob(buildExportBlobAll(), { mode: 'directImport' });
      log(`initialScanAndSend: http=${resp.status} json=${!!resp.payload}`);
      lastFlushAt = Date.now();
    } else {
      await flushZonesNow();
    }
  } catch (e) {
    log('Initial Scan failed: ' + (e?.message || e));
    dialog.showErrorBox('Initial Scan Error', String(e && e.message || e));
  } finally {
    cycleInFlight = false;
  }
}

// Periodic cycle: scan + send with simple backoff
async function periodicCycle() {
  if (cycleInFlight) return;
  if (Date.now() < rateLimitUntil) return;
  cycleInFlight = true;
  lastPeriodicRun = Date.now();
  log('periodicCycle: start');
  try {
    await scanAllOnce();
    log(`periodicCycle: pendingLatest=${pendingLatest.size}`);
    await flushZonesNow();
  } catch (e) {
    if (e && e.status === 429) {
      const waitSec = Math.max(30, e.retryAfter || 0);
      rateLimitUntil = Date.now() + waitSec * 1000;
      log(`periodicCycle: 429 backoff ${waitSec}s`);
    } else {
      log('periodicCycle: error ' + (e?.message || e));
    }
  } finally {
    cycleInFlight = false;
    log('periodicCycle: end');
  }
}

// Inventory: immediate send
async function sendInventoryNow(character, filePath, fileName) {
  try {
    const rows = await readInventoryTSV(filePath);
    const dates = await fileDates(filePath);
    const blob = {
      zoneTab: ZONE_TAB(),
      latest: {},
      inventories: { [character]: rows },
      inventoryMeta: { [character]: { fileName, createdIso: dates.createdUtc, modifiedIso: dates.modifiedUtc } }
    };
    await postBlob(blob, { mode: 'directImport' });
  } catch (err) {
    log('Inventory send failed: ' + (err?.message || err));
    dialog.showErrorBox('Inventory Send Error', String(err && err.message || err));
  }
}

// JSON helpers
async function createJsonLocal() {
  const blob = buildExportBlobAll();
  const defaultName = `eq-zone-export-${new Date().toISOString().replace(/[-:]/g,'').slice(0,15)}.json`;
  const { filePath } = await dialog.showSaveDialog({
    title: 'Save JSON',
    defaultPath: path.join(app.getPath('desktop'), defaultName),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (!filePath) return;
  await fsp.writeFile(filePath, JSON.stringify(blob, null, 2), 'utf8');
  shell.showItemInFolder(filePath);
}
async function sendJsonFromDisk(mode) {
  const sel = await dialog.showOpenDialog({
    title: 'Choose JSON blob to send',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (sel.canceled || !sel.filePaths?.[0]) return;
  const file = sel.filePaths[0];
  const raw = await fsp.readFile(file, 'utf8');
  const blob = JSON.parse(raw);
  await postBlob(blob, { mode });
}

// Watcher
function startWatcher() {
  stopWatcher();
  const dir = EQ_LOG_DIR();
  if (!dir) { log('startWatcher: no EQ_LOG_DIR set'); return; }

  log(`startWatcher: watching ${dir}`);
  watcher = chokidar.watch(dir, {
    ignoreInitial: false,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 }
  });
  watcher.on('add', onLogChange)
         .on('change', onLogChange)
         .on('error', err => log('Watcher error: ' + (err?.message || err)));

  if (CONFIG.enablePeriodicScan && CONFIG.scanIntervalSecs > 0) {
    log(`startWatcher: periodic ON every ${CONFIG.scanIntervalSecs}s`);
    rescanTimer = setInterval(() => { periodicCycle().catch(()=>{}); }, CONFIG.scanIntervalSecs * 1000);
  } else {
    log('startWatcher: periodic OFF');
  }
}
function stopWatcher() {
  if (rescanTimer) { clearInterval(rescanTimer); rescanTimer = null; }
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }
}

// Settings flows
async function setSheetIdFlow() {
  const v = await promptInput({ title: 'Set Google Sheet ID (optional)', label: 'Enter the Spreadsheet ID:', defaultValue: SHEET_ID() });
  if (v === null) return;
  saveConfig({ sheetId: (v || '').trim() });
}
async function setAppsScriptUrlFlow() {
  const v = await promptInput({ title: 'Set Apps Script Web App URL', label: 'Paste the Web App URL (ends with /exec):', defaultValue: APPS_SCRIPT_URL() });
  if (v === null) return;
  saveConfig({ appsScriptUrl: v.trim() });
}
async function setAppsScriptSecretFlow() {
  const v = await promptInput({ title: 'Set Shared Secret (optional)', label: 'Enter a shared secret for X-Auth header:', defaultValue: SECRET() });
  if (v === null) return;
  saveConfig({ appsScriptSecret: v.trim() });
}
async function setEqBaseDirFlow() {
  const dir = await promptDirectory({ title: 'Select EQ Base Folder', message: 'Used to find *-Inventory.txt files.' });
  if (!dir) return;
  saveConfig({ eqBaseDir: dir }); createTray();
}
async function setEqLogsDirFlow() {
  const dir = await promptDirectory({ title: 'Select EQ Logs Folder', message: 'Contains eqlog_*.txt files.' });
  if (!dir) return;
  saveConfig({ eqLogDir: dir }); startWatcher();
}
function togglePeriodicScan() {
  saveConfig({ enablePeriodicScan: !CONFIG.enablePeriodicScan });
  startWatcher();
}
function setScanInterval(v) { saveConfig({ scanIntervalSecs: Number(v) }); startWatcher(); }

// Ping Apps Script
async function pingAppsScript() {
  try {
    const { status, payload, text } = await postBlob(
      { zoneTab: ZONE_TAB(), latest: {} },
      { mode: 'directImport' }
    );
    const json = !!payload;
    const msg = json
      ? `HTTP ${status}\nJSON ok=${payload.ok} mode=${payload.mode}`
      : `HTTP ${status}\nNon-JSON reply: ${String(text).slice(0,160)}`;
    dialog.showMessageBox({ type: 'info', message: 'Ping result', detail: msg });
    log(`ping: http=${status} json=${json} snippet=${String(text).slice(0,120).replace(/\s+/g,' ')}`);
  } catch (e) {
    dialog.showErrorBox('Ping failed', String(e?.message || e));
    log('ping error: ' + (e?.message || e));
  }
}

// Tray
function createTray() {
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
  tray = new Tray(loadTrayIcon());
  tray.setToolTip('EQ Zone Watcher');

  const invFiles = listInventoryFiles(EQ_BASE_DIR());
  const invMenu = invFiles.length
    ? invFiles.map(({ character, filePath, fileName }) => ({
        label: `Send Inventory: ${character}`,
        click: () => sendInventoryNow(character, filePath, fileName)
      }))
    : [{ label: EQ_BASE_DIR() ? 'No *-Inventory.txt found' : 'Set EQ Base Folder in Settings', enabled: false }];

  const scanOpts = [30, 60, 120, 300];

  const menu = Menu.buildFromTemplate([
    { label: 'Initial Scan', click: () => initialScanAndSend() },
    { type: 'separator' },

    // JSON utilities
    { label: 'Create JSON (save locally)…', click: () => createJsonLocal().catch(err => log('Save JSON failed: ' + (err?.message || err))) },
    {
      label: 'Send JSON to Google Sheet…',
      submenu: [
        { label: 'Choose file… (Store & Import)',   click: () => sendJsonFromDisk('directImport').catch(err => log('Send JSON failed: ' + (err?.message || err))) },
        { label: 'Choose file… (Store in RAW only)', click: () => sendJsonFromDisk('storeJson').catch(err => log('Send JSON failed: ' + (err?.message || err))) }
      ]
    },
    { type: 'separator' },

    // Inventories (immediate)
    { label: 'Inventories', submenu: invMenu },
    { type: 'separator' },

    // Periodic scanning (scan + send)
    { label: (CONFIG.enablePeriodicScan ? '✓ ' : '') + 'Periodic scan (scan + send)', click: () => togglePeriodicScan() },
    {
      label: 'Scan interval',
      submenu: scanOpts.map(v => ({
        label: `${v}s`, type: 'radio',
        checked: CONFIG.scanIntervalSecs === v, click: () => setScanInterval(v)
      }))
    },
    { type: 'separator' },

    // Diagnostics & helpers
    {
      label: 'Diagnostics',
      submenu: [
        {
          label: 'Show status…',
          click: () => {
            const msg = JSON.stringify({
              enablePeriodicScan: CONFIG.enablePeriodicScan,
              scanIntervalSecs: CONFIG.scanIntervalSecs,
              pendingLatest: pendingLatest.size,
              latestByFile: latestByFile.size,
              lastPeriodicRunISO: lastPeriodicRun ? new Date(lastPeriodicRun).toISOString() : null,
              lastFlushISO: lastFlushAt ? new Date(lastFlushAt).toISOString() : null,
              rateLimitUntilISO: rateLimitUntil ? new Date(rateLimitUntil).toISOString() : null,
              eqLogDir: EQ_LOG_DIR(),
              zoneTab: ZONE_TAB(),
              logPath: LOG_PATH
            }, null, 2);
            dialog.showMessageBox({ type: 'info', message: 'Status', detail: msg });
          }
        },
        { label: 'Run periodic cycle now', click: () => periodicCycle().catch(e => dialog.showErrorBox('Periodic Error', String(e?.message || e))) },
        { label: 'Ping Apps Script', click: () => pingAppsScript() },
        { label: 'Open log file folder', click: () => shell.showItemInFolder(LOG_PATH) }
      ]
    },
    { type: 'separator' },

    // Settings
    {
      label: 'Settings',
      submenu: [
        { label: 'Set Apps Script URL…', click: () => setAppsScriptUrlFlow() },
        { label: 'Set Shared Secret…',   click: () => setAppsScriptSecretFlow() },
        { label: 'Set Google Sheet ID…', click: () => setSheetIdFlow() },
        { type: 'separator' },
        { label: 'Set EQ Base Folder…',  click: () => setEqBaseDirFlow() },
        { label: 'Set EQ Logs Folder…',  click: () => setEqLogsDirFlow() }
      ]
    },
    { type: 'separator' },
    { label: 'Open Sheet', click: () => SHEET_ID() ? shell.openExternal(`https://docs.google.com/spreadsheets/d/${SHEET_ID()}/edit`) : dialog.showErrorBox('Missing Sheet ID', 'Set Sheet ID or let Apps Script handle it.') },
    { label: 'Quit', click: () => { stopWatcher(); saveState(); app.quit(); } }
  ]);

  tray.setContextMenu(menu);
  tray.on('click', () => tray.popUpContextMenu());
  nativeTheme.on('updated', () => { try { tray.setImage(loadTrayIcon()); } catch {} });
}

// Lifecycle
const singleLock = app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    try {
      loadState();
      await ensureRequiredConfigFlow();
      createTray();
      startWatcher();
    } catch (err) {
      log('Startup Error: ' + (err?.message || err));
      dialog.showErrorBox('Startup Error', String((err && err.message) || err));
      app.quit();
    }
  });
  app.on('window-all-closed', (e) => e.preventDefault());
}
