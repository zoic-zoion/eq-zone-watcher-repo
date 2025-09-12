
/**
 * EQ Zone Tray – Apps Script (robust JSON replies + diagnostics)
 */
function doGet(e) {
  try {
    var env = getEnv_();
    var mode = (e && e.parameter && e.parameter.mode) ? String(e.parameter.mode) : 'ping';
    if (mode === 'ping') {
      return respond_(200, { ok: true, message: 'pong', deployTag: env.deployTag || null });
    }
    if (mode === 'testSheet') {
      var sheetId = (e.parameter && e.parameter.sheetId) ? String(e.parameter.sheetId) : (env.sheetId || '');
      if (!sheetId) return respond_(400, { ok:false, error:'missing sheetId' });
      try {
        var ss = SpreadsheetApp.openById(sheetId);
        var name = ss.getName();
        return respond_(200, { ok:true, sheetId: sheetId, name: name });
      } catch (errOpen) {
        return respond_(403, { ok:false, error:'cannot open spreadsheet: ' + String(errOpen) });
      }
    }
    return respond_(200, { ok: true, message: 'POST { mode: \"directImport\" | \"storeJson\" | \"importRaw\" }', deployTag: env.deployTag || null });
  } catch (err) {
    return respond_(500, { ok:false, error:String(err), stack:(err&&err.stack)||null });
  }
}

function doPost(e) {
  try {
    var env = getEnv_();
    var hdr = (e && e.headers) ? (e.headers['x-auth'] || e.headers['X-Auth'] || '') : '';
    if (env.secret && hdr !== env.secret) {
      return respond_(403, { ok:false, error:'unauthorized' });
    }
    var body = {};
    try {
      var contents = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
      body = JSON.parse(contents);
    } catch (errJson) {
      return respond_(400, { ok:false, error:'invalid JSON: ' + String(errJson) });
    }
    var sheetId = (env.sheetId || '').trim() || (body.sheetId || '').trim();
    if (!sheetId) return respond_(400, { ok:false, error:'missing sheetId' });

    var ss;
    try { ss = SpreadsheetApp.openById(sheetId); }
    catch (errOpen) { return respond_(403, { ok:false, error:'cannot open spreadsheet: ' + String(errOpen) }); }

    var mode = (body.mode || 'directImport').trim();

    if (mode === 'directImport') {
      var blob = body.blob || {};
      var r1 = processStoredJson_(ss, blob);
      return respond_(200, { ok:true, mode:'directImport', result:r1 });
    }
    if (mode === 'storeJson') {
      var raw = ensureSheet_(ss, 'RAW');
      raw.clearContents();
      raw.getRange(1,1).setValue(JSON.stringify(body.blob || {}));
      raw.getRange(1,2).setValue(new Date());
      return respond_(200, { ok:true, mode:'storeJson' });
    }
    if (mode === 'importRaw') {
      var rawSheet = ensureSheet_(ss, 'RAW');
      var s = rawSheet.getRange(1,1).getValue();
      if (!s) return respond_(400, { ok:false, error:'RAW!A1 empty' });
      var blob3 = (typeof s === 'string') ? JSON.parse(s) : s;
      var r3 = processStoredJson_(ss, blob3);
      return respond_(200, { ok:true, mode:'importRaw', result:r3 });
    }
    if (body.latest || body.inventories) {
      var r4 = processStoredJson_(ss, body);
      return respond_(200, { ok:true, mode:'directImport(compat)', result:r4 });
    }
    return respond_(400, { ok:false, error:'unknown mode' });
  } catch (err) {
    return respond_(500, { ok:false, error:String(err), stack:(err&&err.stack)||null });
  }
}

function processStoredJson_(ss, blob) {
  var env = getEnv_();
  var zoneTab = (blob.zoneTab || env.defaultZoneTab || 'Zone Tracker');
  var latest = (blob.latest && typeof blob.latest === 'object') ? blob.latest : {};
  var inventories = (blob.inventories && typeof blob.inventories === 'object') ? blob.inventories : {};
  var inventoryMeta = (blob.inventoryMeta && typeof blob.inventoryMeta === 'object') ? blob.inventoryMeta : {};

  var header = ['Character Name','Log File','Zone Name','Detected Timestamp','Last Updated (UTC)'];
  var sh = ensureSheetWithHeader_(ss, zoneTab, header);
  var idx = buildKeyIndex_(sh, header, 'Log File');
  var updates = [], inserts = [];

  var fileKeys = Object.keys(latest);
  for (var i = 0; i < fileKeys.length; i++) {
    var k = fileKeys[i];
    var rec = latest[k] || {};
    var char = rec.character || charFromFileName_(rec.fileName || k);
    var rowVals = [char, rec.fileName || k, safe_(rec.zone), safe_(rec.detectedTs), safe_(rec.updatedUtc)];
    var rowNum = idx[rec.fileName || k];
    if (rowNum) updates.push({ row: rowNum, values: rowVals });
    else inserts.push(rowVals);
  }

  if (updates.length) {
    updates.sort(function(a,b){ return a.row - b.row; });
    for (var u = 0; u < updates.length; u++) {
      var up = updates[u];
      sh.getRange(up.row, 1, 1, up.values.length).setValues([up.values]);
    }
  }
  if (inserts.length) {
    var start = sh.getLastRow() + 1;
    sh.getRange(start, 1, inserts.length, inserts[0].length).setValues(inserts);
  }

  var invChars = Object.keys(inventories);
  for (var j = 0; j < invChars.length; j++) {
    var ch = invChars[j];
    var t = ensureSheet_(ss, ('Inventory - ' + ch).substring(0,90));
    t.clearContents();

    t.getRange(1,1,1,4).setValues([['Inventory for', 'File', 'Created On', 'Modified On']]);
    var meta = inventoryMeta[ch] || {};
    var values = [[ ch, (meta.fileName || ''), (meta.createdIso || ''), (meta.modifiedIso || '') ]];
    t.getRange(2,1,1,4).setValues(values);
    t.getRange(3,1).setValue('');

    var rows = inventories[ch];
    if (rows && rows.length && Array.isArray(rows[0])) {
      t.getRange(4, 1, rows.length, rows[0].length).setValues(rows);
    }
  }

  SpreadsheetApp.flush();
  return { upserts: updates.length + inserts.length, inventories: invChars.length };
}

/* ---------- helpers ---------- */
function getEnv_() {
  var props = PropertiesService.getScriptProperties();
  return {
    sheetId: props.getProperty('SHEET_ID') || '',
    secret: props.getProperty('SHARED_SECRET') || '',
    defaultZoneTab: props.getProperty('DEFAULT_ZONE_TAB') || 'Zone Tracker',
    deployTag: props.getProperty('DEPLOY_TAG') || ''
  };
}
function ensureSheet_(ss, title) {
  var sh = ss.getSheetByName(title);
  return sh || ss.insertSheet(title);
}
function ensureSheetWithHeader_(ss, title, header) {
  var sh = ensureSheet_(ss, title);
  var range = sh.getRange(1,1,1,header.length);
  var current = range.getValues()[0] || [];
  if (!arraysEqual_(current, header)) range.setValues([header]);
  return sh;
}
function arraysEqual_(a,b){ if(!a||!b||a.length!==b.length) return false; for(var i=0;i<a.length;i++){ if(String(a[i])!==String(b[i])) return false; } return true; }
function safe_(v){ return v==null ? '' : v; }
function charFromFileName_(fileName) {
  var m = (fileName||'').match(/^eqlog_(.+?)_/i);
  return m ? m[1] : '';
}
function buildKeyIndex_(sh, header, keyHeader) {
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  var idx = {};
  if (lastRow < 2) return idx;
  var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var keyCol = 1;
  for (var i = 0; i < hdr.length; i++) { if (String(hdr[i]) === keyHeader) { keyCol = i + 1; break; } }
  var vals = sh.getRange(2, keyCol, lastRow - 1, 1).getValues();
  for (var r = 0; r < vals.length; r++) {
    var v = (vals[r][0] || '').toString();
    if (v) idx[v] = r + 2;
  }
  return idx;
}
function respond_(status, obj) {
  return ContentService
    .createTextOutput(JSON.stringify({
      status: status, ok: !!obj.ok, error: obj.error, mode: obj.mode, result: obj.result,
      message: obj.message, stack: obj.stack, deployTag: obj.deployTag
    }))
    .setMimeType(ContentService.MimeType.JSON);
}
