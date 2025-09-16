
function doGet(e){ return ContentService.createTextOutput(JSON.stringify({ ok:true, message:'POST { mode }' })).setMimeType(ContentService.MimeType.JSON); }
function doPost(e){
  var body={}; try{ body=JSON.parse(e.postData.contents||'{}'); }catch(err){ return respond_(400,{ ok:false, error:'invalid JSON' }); }
  var sheetId=(body.sheetId||'').trim(); if(!sheetId) return respond_(400,{ ok:false, error:'missing sheetId' });
  var ss=SpreadsheetApp.openById(sheetId); var mode=(body.mode||'directImport').trim();
  if(mode==='storeJson'){ var raw=ensureSheet_(ss,'RAW'); raw.clear(); raw.getRange(1,1).setValue(JSON.stringify(body.blob||{})); return respond_(200,{ ok:true, mode:'storeJson' }); }
  var r=processStoredJson_(ss, body.blob||body); return respond_(200,{ ok:true, mode:'directImport', result:r });
}
function processStoredJson_(ss, blob){
  var zoneTab=(blob.zoneTab||'Zone Tracker'); var latest=(blob.latest&&typeof blob.latest==='object')?blob.latest:{};
  var header=['Character Name','Log File','Zone Name','Detected Timestamp','Last Updated (UTC)'];
  var sh=ensureSheetWithHeader_(ss, zoneTab, header); var idx=buildKeyIndex_(sh, header, 'Log File'); var updates=[], inserts=[];
  var keys=Object.keys(latest);
  for(var i=0;i<keys.length;i++){ var k=keys[i]; var rec=latest[k]||{}; var char=rec.character||charFromFileName_(rec.fileName||k);
    var row=[char, rec.fileName||k, (rec.zone||''), (rec.detectedTs||''), (rec.updatedUtc||'')];
    var rowNum=idx[rec.fileName||k]; if(rowNum) updates.push({row:rowNum,values:row}); else inserts.push(row);
  }
  if(updates.length){ updates.sort(function(a,b){return a.row-b.row;}); for(var u=0;u<updates.length;u++){ var up=updates[u]; sh.getRange(up.row,1,1,up.values.length).setValues([up.values]); } }
  if(inserts.length){ var start=sh.getLastRow()+1; sh.getRange(start,1,inserts.length,inserts[0].length).setValues(inserts); }
  SpreadsheetApp.flush(); return { upserts: updates.length+inserts.length };
}
function ensureSheet_(ss,title){ return ss.getSheetByName(title) || ss.insertSheet(title); }
function ensureSheetWithHeader_(ss,title,h){ var sh=ensureSheet_(ss,title); var r=sh.getRange(1,1,1,h.length); var cur=r.getValues()[0]||[]; if(String(cur.join('|'))!==String(h.join('|'))) r.setValues([h]); return sh; }
function buildKeyIndex_(sh, header, keyHeader){
  var lastRow=sh.getLastRow(); var lastCol=sh.getLastColumn(); var idx={}; if(lastRow<2) return idx;
  var hdr=sh.getRange(1,1,1,lastCol).getValues()[0]; var keyCol=1; for(var i=0;i<hdr.length;i++){ if(String(hdr[i])===keyHeader){ keyCol=i+1; break; } }
  var vals=sh.getRange(2, keyCol, lastRow-1, 1).getValues(); for(var r=0;r<vals.length;r++){ var v=(vals[r][0]||'').toString(); if(v) idx[v]=r+2; } return idx;
}
function charFromFileName_(fileName){ var m=(fileName||'').match(/^eqlog_(.+?)_/i); return m?m[1]:''; }
function respond_(status,obj){ return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
