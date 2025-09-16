
// EQ Zone Watcher (packaged default URL via .env.production)
const path=require('path'); const fs=require('fs'); const fsp=fs.promises;
const dotenv=require('dotenv'); const chokidar=require('chokidar');
const { app, Tray, Menu, nativeImage, nativeTheme, shell, dialog, BrowserWindow, ipcMain } = require('electron');
const { normalizeToUtcString, nowUtcStamp } = require('./lib/date');
const { extractLastZone, characterFromLogFile, LOG_NAME_RE } = require('./lib/parser');
const { listInventoryFiles, readInventoryTSV, fileDates } = require('./lib/inventory');
const { postBlobToAppsScript } = require('./lib/sheets');

(function loadEnv() {
  const prodEnv = app.isPackaged ? path.join(process.resourcesPath, '.env.production') : null;
  const devEnv  = path.join(__dirname, '.env');
  const pick = (prodEnv && fs.existsSync(prodEnv)) ? prodEnv : (fs.existsSync(devEnv) ? devEnv : null);
  if (pick) dotenv.config({ path: pick });
})();

const DEFAULTS = {
  sheetId: (process.env.EQ_SHEET_ID || '').trim(),
  appsScriptUrl: (process.env.APPS_SCRIPT_URL || '').trim(),
  appsScriptSecret: (process.env.APPS_SCRIPT_SECRET || '').trim(),
  eqBaseDir: (process.env.EQ_BASE_DIR || '').trim(),
  eqLogDir: (process.env.EQ_LOG_DIR || '').trim(),
  zoneTabTitle: (process.env.EQ_SHEET_TAB || 'Zone Tracker').trim(),
  enablePeriodicScan: true,
  scanIntervalSecs: Number(process.env.SCAN_INTERVAL_SECS || 60)
};
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
let CONFIG = { ...DEFAULTS, ...safeLoadConfig() };
function safeLoadConfig(){ try{ if(fs.existsSync(CONFIG_PATH)) return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH,'utf8')) }; }catch(_){} return {}; }
function saveConfig(patch={}){ CONFIG={...CONFIG,...patch}; try{ fs.mkdirSync(path.dirname(CONFIG_PATH),{recursive:true}); fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG,null,2)); }catch(e){ console.warn('save config failed:', e?.message||e); } }
const SHEET_ID=()=>CONFIG.sheetId.trim(), APPS_SCRIPT_URL=()=>CONFIG.appsScriptUrl.trim(), SECRET=()=>CONFIG.appsScriptSecret.trim(), EQ_BASE_DIR=()=>CONFIG.eqBaseDir.trim(), EQ_LOG_DIR=()=>CONFIG.eqLogDir.trim(), ZONE_TAB=()=>CONFIG.zoneTabTitle.trim();

let tray=null, watcher=null, rescanTimer=null, cycleInFlight=false;
const debounceMap=new Map(); const pendingLatest=new Map(); const latestByFile=new Map();

function pathExists(p){ try{ return fs.existsSync(p); }catch{ return false; } }
function resolveAsset(rel){ const p1=path.join(__dirname, rel), p2=path.join(process.resourcesPath, rel); return pathExists(p1)?p1:(pathExists(p2)?p2:p1); }
function loadTrayIcon(){ const name=nativeTheme.shouldUseDarkColors?'tray-light.png':'tray-dark.png'; return nativeImage.createFromPath(resolveAsset(path.join('assets', name))); }
async function promptInput({ title, label, defaultValue='' }){
  return new Promise((resolve)=>{
    const win=new BrowserWindow({ width:520,height:220, useContentSize:true, title, webPreferences:{ nodeIntegration:true, contextIsolation:false } });
    const html=`<!doctype html><html><body style="font-family:system-ui;padding:16px;display:flex;gap:12px;flex-direction:column">
      <label style="font-weight:600">${label.replace(/</g,'&lt;')}</label>
      <input id="val" style="padding:10px" value="${(defaultValue||'').replace(/"/g,'&quot;')}" autofocus />
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:auto">
        <button id="cancel">Cancel</button><button id="ok">Save</button></div>
      <script>const {ipcRenderer}=require('electron');const $=id=>document.getElementById(id);
        $('ok').onclick=()=>ipcRenderer.send('prompt:submit',$('val').value);
        $('cancel').onclick=()=>ipcRenderer.send('prompt:submit',null);
        document.addEventListener('keydown',e=>{if(e.key==='Enter')$('ok').click();if(e.key==='Escape')$('cancel').click();});</script>
    </body></html>`;
    win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
    const handler=(_evt,value)=>{ ipcMain.removeListener('prompt:submit',handler); try{ win.close(); }catch{} resolve(value); };
    ipcMain.on('prompt:submit', handler);
  });
}
async function promptDirectory({ title, message }){ const res=await dialog.showOpenDialog({ title, message, properties:['openDirectory'] }); if(res.canceled||!res.filePaths?.[0]) return null; return res.filePaths[0]; }

async function ensureRequiredConfigFlow(){
  if(!APPS_SCRIPT_URL()){ const url=await promptInput({ title:'Apps Script Web App URL', label:'Paste your Worker URL (or /exec):' }); if(!url) throw new Error('Apps Script Web App URL is required.'); saveConfig({ appsScriptUrl: url.trim() }); }
  if(!SHEET_ID()){ const sid=await promptInput({ title:'Google Sheet ID (optional)', label:'Enter the Spreadsheet ID (leave blank if your script knows it):' }); if(sid!==null) saveConfig({ sheetId:(sid||'').trim() }); }
  if(!EQ_LOG_DIR()){ const dir=await promptDirectory({ title:'Select EQ Logs Folder', message:'Pick the folder with eqlog_*.txt files.' }); if(!dir) throw new Error('EQ Logs folder is required.'); saveConfig({ eqLogDir:dir }); }
  if(!EQ_BASE_DIR()){ const dir=await promptDirectory({ title:'Select EQ Base Folder (optional)', message:'Folder with *-Inventory.txt files.' }); if(dir) saveConfig({ eqBaseDir:dir }); }
}

function buildPendingBlobZones(){ return { zoneTab: ZONE_TAB(), latest: Object.fromEntries(pendingLatest.entries()) }; }
function buildExportBlobAll(){ return { zoneTab: ZONE_TAB(), latest: Object.fromEntries(latestByFile.entries()) }; }
async function postBlob(blob,{mode='directImport'}={}){
  const url=APPS_SCRIPT_URL(); const headers={'Content-Type':'application/json'}; if(SECRET()) headers['X-Auth']=SECRET();
  const body={ mode, sheetId: SHEET_ID()||null, blob, autoProcess: mode==='storeJson'?false:undefined };
  const res=await fetch(url,{ method:'POST', headers, body: JSON.stringify(body) });
  const text=await res.text().catch(()=>'');
  let payload=null; try{ payload=JSON.parse(text); }catch{}
  if(!res.ok || (payload && payload.ok===false)) throw new Error(`Apps Script POST failed: ${res.status} ${res.statusText} ${text.slice(0,200)}`);
  return { status: res.status, payload, text };
}

async function upsertLatestFor(fileName, zone, detectedTsNormalized){
  const char=characterFromLogFile(fileName)||'';
  const rec={ fileName, character:char, zone, detectedTs:detectedTsNormalized||'', updatedUtc: nowUtcStamp() };
  const prev=latestByFile.get(fileName);
  const changed=!prev || prev.zone!==rec.zone || prev.detectedTs!==rec.detectedTs;
  latestByFile.set(fileName, rec);
  if(changed){ pendingLatest.set(fileName, rec); }
}
async function processLogFile(fullPath, fileName){ const { zone, ts } = await extractLastZone(fullPath); if(!zone) return; await upsertLatestFor(fileName, zone, ts||''); }
async function onLogChange(filePath){
  if(!/\.txt$/i.test(filePath)) return; const base=path.basename(filePath); if(!LOG_NAME_RE.test(base)) return;
  const prev=debounceMap.get(base); if(prev) clearTimeout(prev);
  const t=setTimeout(()=>{ processLogFile(filePath, base).catch(()=>{}); debounceMap.delete(base); }, 250); debounceMap.set(base, t);
}
async function scanAllOnce(){
  const dir=EQ_LOG_DIR(); if(!dir) return; let entries; try{ entries=await fsp.readdir(dir,{ withFileTypes:true }); }catch{ return; }
  const txt=entries.filter(de=>de.isFile() && LOG_NAME_RE.test(de.name) && /\.txt$/i.test(de.name)).map(de=>de.name).sort((a,b)=>a.localeCompare(b));
  for(const name of txt){ await processLogFile(path.join(dir,name), name); }
}
async function flushZonesNow(){
  const blob=buildPendingBlobZones(); const n=Object.keys(blob.latest).length; if(!n) return;
  await postBlob(blob,{mode:'directImport'});
  Object.keys(blob.latest).forEach(k=>pendingLatest.delete(k));
}
async function initialScanAndSend(){
  if(cycleInFlight) return; cycleInFlight=true;
  try{ await scanAllOnce(); if(pendingLatest.size===0 && latestByFile.size>0){ await postBlob(buildExportBlobAll(),{mode:'directImport'}); } else { await flushZonesNow(); } }
  catch(e){ dialog.showErrorBox('Initial Scan Error', String(e?.message||e)); }
  finally{ cycleInFlight=false; }
}
async function periodicCycle(){
  if(cycleInFlight) return; cycleInFlight=true;
  try{ await scanAllOnce(); await flushZonesNow(); } finally { cycleInFlight=false; }
}

function startWatcher(){
  stopWatcher(); const dir=EQ_LOG_DIR(); if(!dir) return;
  watcher=chokidar.watch(dir,{ ignoreInitial:false, depth:0, awaitWriteFinish:{ stabilityThreshold:400, pollInterval:100 } });
  watcher.on('add', onLogChange).on('change', onLogChange).on('error', err=>console.error('Watcher error:', err));
  if(CONFIG.enablePeriodicScan && CONFIG.scanIntervalSecs>0){
    rescanTimer=setInterval(()=>{ periodicCycle().catch(()=>{}); }, CONFIG.scanIntervalSecs*1000);
  }
}
function stopWatcher(){ if(rescanTimer) clearInterval(rescanTimer); rescanTimer=null; if(watcher){ try{ watcher.close(); }catch{} watcher=null; } }

async function setAppsScriptUrlFlow(){ const v=await promptInput({ title:'Set Apps Script Web App URL', label:'Paste the Worker URL (or /exec):', defaultValue: APPS_SCRIPT_URL() }); if(v===null) return; saveConfig({ appsScriptUrl: v.trim() }); }
async function setAppsScriptSecretFlow(){ const v=await promptInput({ title:'Set Shared Secret (optional)', label:'Enter a shared secret for X-Auth header:', defaultValue: SECRET() }); if(v===null) return; saveConfig({ appsScriptSecret: v.trim() }); }
async function setSheetIdFlow(){ const v=await promptInput({ title:'Set Google Sheet ID (optional)', label:'Enter the Spreadsheet ID:', defaultValue: SHEET_ID() }); if(v===null) return; saveConfig({ sheetId: (v||'').trim() }); }
async function setEqBaseDirFlow(){ const dir=await promptDirectory({ title:'Select EQ Base Folder', message:'Used to find *-Inventory.txt files.' }); if(!dir) return; saveConfig({ eqBaseDir: dir }); createTray(); }
async function setEqLogsDirFlow(){ const dir=await promptDirectory({ title:'Select EQ Logs Folder', message:'Contains eqlog_*.txt files.' }); if(!dir) return; saveConfig({ eqLogDir: dir }); startWatcher(); }
function togglePeriodicScan(){ saveConfig({ enablePeriodicScan: !CONFIG.enablePeriodicScan }); startWatcher(); }
function setScanInterval(v){ saveConfig({ scanIntervalSecs: Number(v) }); startWatcher(); }

function createTray(){
  if(tray){ try{ tray.destroy(); }catch{} tray=null; }
  tray=new Tray(loadTrayIcon()); tray.setToolTip('EQ Zone Watcher');
  const invFiles=listInventoryFiles(EQ_BASE_DIR());
  const invMenu=invFiles.length ? invFiles.map(({character,filePath,fileName})=>({ label:`Send Inventory: ${character}`, click:()=>sendInventoryNow(character,filePath,fileName) })) : [{ label: EQ_BASE_DIR() ? 'No *-Inventory.txt found' : 'Set EQ Base Folder in Settings', enabled:false }];
  const scanOpts=[30,60,120,300];
  const menu=Menu.buildFromTemplate([
    { label:'Initial Scan', click:()=>initialScanAndSend() },
    { type:'separator' },
    { label:'Create JSON (save locally)…', click:()=>createJsonLocal().catch(()=>{}) },
    { label:'Send JSON to Google Sheet…', submenu:[
      { label:'Choose file… (Store & Import)', click:()=>sendJsonFromDisk('directImport').catch(()=>{}) },
      { label:'Choose file… (Store in RAW only)', click:()=>sendJsonFromDisk('storeJson').catch(()=>{}) }
    ]},
    { type:'separator' },
    { label:'Inventories', submenu: invMenu },
    { type:'separator' },
    { label:(CONFIG.enablePeriodicScan?'✓ ':'')+'Periodic scan (scan + send)', click:()=>togglePeriodicScan() },
    { label:'Scan interval', submenu: scanOpts.map(v=>({ label:`${v}s`, type:'radio', checked:CONFIG.scanIntervalSecs===v, click:()=>setScanInterval(v) })) },
    { type:'separator' },
    { label:'Settings', submenu:[
      { label:'Set Apps Script URL…', click:()=>setAppsScriptUrlFlow() },
      { label:'Set Shared Secret…',   click:()=>setAppsScriptSecretFlow() },
      { label:'Set Google Sheet ID…', click:()=>setSheetIdFlow() },
      { type:'separator' },
      { label:'Set EQ Base Folder…',  click:()=>setEqBaseDirFlow() },
      { label:'Set EQ Logs Folder…',  click:()=>setEqLogsDirFlow() }
    ]},
    { type:'separator' },
    { label:'Open Sheet', click:()=>SHEET_ID()?shell.openExternal(`https://docs.google.com/spreadsheets/d/${SHEET_ID()}/edit`):dialog.showErrorBox('Missing Sheet ID','Set Sheet ID or let Apps Script handle it.') },
    { label:'Quit', click:()=>{ stopWatcher(); app.quit(); } }
  ]);
  tray.setContextMenu(menu); tray.on('click',()=>tray.popUpContextMenu());
  nativeTheme.on('updated',()=>{ try{ tray.setImage(loadTrayIcon()); }catch{} });
}

async function sendInventoryNow(character,filePath,fileName){
  try{
    const rows=await readInventoryTSV(filePath);
    const dates=await fileDates(filePath);
    const blob={ zoneTab: ZONE_TAB(), latest:{}, inventories:{ [character]: rows }, inventoryMeta:{ [character]: { fileName, createdIso: dates.createdUtc, modifiedIso: dates.modifiedUtc } } };
    await postBlob(blob,{mode:'directImport'});
  }catch(err){ dialog.showErrorBox('Inventory Send Error', String(err?.message||err)); }
}
async function createJsonLocal(){
  const blob=buildExportBlobAll();
  const defaultName=`eq-zone-export-${new Date().toISOString().replace(/[-:]/g,'').slice(0,15)}.json`;
  const { filePath } = await dialog.showSaveDialog({ title:'Save JSON', defaultPath: path.join(app.getPath('desktop'), defaultName), filters:[{name:'JSON',extensions:['json']}] });
  if(!filePath) return; await fsp.writeFile(filePath, JSON.stringify(blob,null,2), 'utf8'); shell.showItemInFolder(filePath);
}
async function sendJsonFromDisk(mode){
  const sel=await dialog.showOpenDialog({ title:'Choose JSON blob to send', properties:['openFile'], filters:[{name:'JSON',extensions:['json']}] });
  if(sel.canceled || !sel.filePaths?.[0]) return; const file=sel.filePaths[0]; const raw=await fsp.readFile(file,'utf8'); const blob=JSON.parse(raw); await postBlob(blob,{mode});
}

const singleLock=app.requestSingleInstanceLock();
if(!singleLock){ app.quit(); } else {
  app.whenReady().then(async()=>{
    try{ await ensureRequiredConfigFlow(); createTray(); startWatcher(); }
    catch(err){ dialog.showErrorBox('Startup Error', String((err&&err.message)||err)); app.quit(); }
  });
  app.on('window-all-closed',(e)=>e.preventDefault());
}
