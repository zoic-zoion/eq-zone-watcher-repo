
async function postBlobToAppsScript({ url, secret, sheetId, blob, mode='directImport' }){
  if(!url || !/\/exec(?:\?|$)/.test(url)) throw new Error('Apps Script URL missing or not /exec');
  const headers={'Content-Type':'application/json'}; if(secret) headers['X-Auth']=secret;
  const body={ mode, sheetId: sheetId||null, blob, autoProcess: mode==='storeJson'?false:undefined };
  const res=await fetch(url,{ method:'POST', headers, body: JSON.stringify(body) });
  const text=await res.text().catch(()=>'');
  let payload=null; try{ payload=JSON.parse(text); }catch{}
  if(!res.ok || (payload && payload.ok===false)) throw new Error(`Apps Script POST failed: ${res.status} ${res.statusText} ${text.slice(0,200)}`);
  return { status: res.status, payload, text };
}
module.exports={ postBlobToAppsScript };
