
async function postBlobToAppsScript({ url, secret, sheetId, blob, mode = 'directImport' }) {
  if (!url || !/\/exec(?:\?|$)/.test(url)) {
    const e = new Error('Apps Script URL missing or not /exec');
    e.status = 0;
    throw e;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['X-Auth'] = secret;

  const body = { mode, sheetId: sheetId || null, blob, autoProcess: mode === 'storeJson' ? false : undefined };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text().catch(() => '');
  let payload = null; try { payload = JSON.parse(text); } catch {}

  if (!res.ok || (payload && payload.ok === false)) {
    const err = new Error(`Apps Script POST failed: ${res.status} ${res.statusText} ${text.slice(0,200)}`);
    err.status = res.status;
    err.retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    err.payload = payload;
    throw err;
  }
  return { status: res.status, payload, text };
}

module.exports = { postBlobToAppsScript };
