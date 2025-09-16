/**
 * Cloudflare Worker: EQ Zone Proxy
 * Optional everything; diagnostics toggle is OFF by default.
 */

const JSONR = (obj, status=200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', ...cors() }
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors({ preflight: true }) });

    if (url.pathname === '/diag') {
      if (method === 'GET') return getDiag(env);
      if (method === 'POST') return setDiag(request, env);
      return JSONR({ ok: true, message: 'Use GET (status) or POST (?on=1|off=1)' });
    }

    if (url.pathname !== '/' && url.pathname !== '/ingest') {
      return JSONR({ ok: true, message: 'POST JSON to / (or /ingest); GET /diag for status' });
    }
    if (method !== 'POST') return JSONR({ ok: true, message: 'Send JSON via POST; see README' });

    const bodyText = await request.text();
    let bodyJson = {}; try { bodyJson = JSON.parse(bodyText || '{}'); } catch {}

    const target = (env.APPS_SCRIPT_URL && env.APPS_SCRIPT_URL.trim())
      || (typeof bodyJson.appsScriptUrl === 'string' && bodyJson.appsScriptUrl.trim())
      || (typeof bodyJson.targetUrl === 'string' && bodyJson.targetUrl.trim())
      || '';

    if (!target) return JSONR({ ok:false, error:'no target /exec URL; set APPS_SCRIPT_URL or include appsScriptUrl' }, 501);
    if (!/\/exec(?:\?|$)/.test(target)) return JSONR({ ok:false, error:'target is not an Apps Script /exec URL' }, 400);

    const clientSecret = request.headers.get('x-auth') || '';
    if (env.CLIENT_SECRET && clientSecret !== env.CLIENT_SECRET) return JSONR({ ok:false, error:'unauthorized' }, 403);

    const diag = await isDiagOn(env);
    const headers = { 'content-type': 'application/json' };
    if (env.SCRIPT_SECRET) headers['X-Auth'] = env.SCRIPT_SECRET;

    diag && console.log('[proxy] ->', target);
    const res = await fetch(target, { method:'POST', headers, body: bodyText });

    if (res.status === 429 || res.status >= 500) {
      diag && console.log('[proxy] queue', res.status);
      const key = `q:${Date.now()}:${crypto.randomUUID()}`;
      await env.ZONEQ.put(key, JSON.stringify({ target, body: bodyText }));
      return JSONR({ ok:true, queued:true }, 202);
    }

    const text = await res.text();
    diag && console.log('[proxy] <-', res.status, text.slice(0,120).replace(/\s+/g,' '));
    return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'application/json', ...cors() } });
  },

  async scheduled(event, env, ctx) {
    const diag = await isDiagOn(env);
    const list = await env.ZONEQ.list({ prefix: 'q:' });
    if (diag) console.log('[cron] retry', list.keys.length);

    for (const { name } of list.keys) {
      const rec = await env.ZONEQ.get(name);
      if (!rec) { await env.ZONEQ.delete(name); continue; }
      let obj = null; try { obj = JSON.parse(rec); } catch {}
      if (!obj || !obj.target || !obj.body) { await env.ZONEQ.delete(name); continue; }

      try {
        const headers = { 'content-type': 'application/json' };
        if (env.SCRIPT_SECRET) headers['X-Auth'] = env.SCRIPT_SECRET;
        const r = await fetch(obj.target, { method:'POST', headers, body: obj.body });
        if (r.ok) { await env.ZONEQ.delete(name); diag && console.log('[cron] delivered', name); }
        else { diag && console.log('[cron] still failing', name, r.status); }
      } catch (e) {
        diag && console.log('[cron] error', name, String(e?.message || e));
      }
    }
  }
};

function cors(opts={}) {
  const h = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-auth,x-admin',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  };
  if (opts.preflight) h['access-control-max-age'] = '600';
  return h;
}
async function isDiagOn(env) {
  try {
    const val = await env.CFG.get('diag:on');
    if (val === '1') return true;
    if (val === '0') return false;
  } catch {}
  return String(env.DIAG_DEFAULT || '0') === '1';
}
async function getDiag(env) {
  const queued = await env.ZONEQ.list({ prefix: 'q:' });
  const diag = await isDiagOn(env);
  return JSONR({
    ok:true,
    diagEnabled: diag,
    queued: queued.keys.length,
    vars: {
      has_APPS_SCRIPT_URL: !!(env.APPS_SCRIPT_URL && env.APPS_SCRIPT_URL.trim()),
      has_SCRIPT_SECRET: !!env.SCRIPT_SECRET,
      has_CLIENT_SECRET: !!env.CLIENT_SECRET,
      diag_default: String(env.DIAG_DEFAULT || '0')
    }
  });
}
async function setDiag(request, env) {
  const admin = request.headers.get('x-admin') || '';
  if (!env.ADMIN_TOKEN || admin !== env.ADMIN_TOKEN) return JSONR({ ok:false, error:'admin token required' }, 403);
  const u = new URL(request.url);
  if (u.searchParams.get('on') === '1') await env.CFG.put('diag:on', '1');
  else if (u.searchParams.get('off') === '1') await env.CFG.put('diag:on', '0');
  const diag = await isDiagOn(env);
  return JSONR({ ok:true, diagEnabled: diag });
}
