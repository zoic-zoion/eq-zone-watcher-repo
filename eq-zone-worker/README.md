# EQ Zone Proxy (Cloudflare Worker)

A tiny Cloudflare Worker that forwards your Electron app's JSON to **Google Apps Script** (`/exec`). 
Everything is **optional**: set the target URL and secrets as Worker secrets, or pass the URL per-request.

Features:
- Optional client auth (`CLIENT_SECRET`) and forwarding auth (`SCRIPT_SECRET`)
- Optional default `APPS_SCRIPT_URL` or per-request `appsScriptUrl`/`targetUrl`
- KV queue + cron retry on 429/5xx
- Diagnostics toggle (OFF by default) via `/diag` and KV

## Quick Start

```bash
npm i -g wrangler
wrangler kv namespace create ZONEQ
wrangler kv namespace create CFG
# put the IDs into wrangler.toml

# optional secrets (press Enter to skip)
wrangler secret put APPS_SCRIPT_URL
wrangler secret put SCRIPT_SECRET
wrangler secret put CLIENT_SECRET
wrangler secret put ADMIN_TOKEN    # needed to toggle diagnostics

wrangler deploy
```

Ingest: `POST /` (or `/ingest`) with JSON body.  
Diagnostics: `GET /diag`, `POST /diag?on=1|off=1` with `X-Admin: <ADMIN_TOKEN>`.

## Request examples

Electron can keep sending the same JSON you send to Apps Script:
```json
{
  "mode": "directImport",
  "sheetId": "your_sheet_id",
  "blob": { "zoneTab": "Zone Tracker", "latest": { /* ... */ } }
}
```
Or include `appsScriptUrl` if you didn't set a secret:
```json
{ "appsScriptUrl": "https://script.google.com/macros/s/.../exec", "mode":"directImport", "sheetId":"...", "blob":{...} }
```

Headers:
```
Content-Type: application/json
X-Auth: <CLIENT_SECRET>    # optional; enforced only if set
```

## Environment & storage
- Secrets (optional): `APPS_SCRIPT_URL`, `SCRIPT_SECRET`, `CLIENT_SECRET`, `ADMIN_TOKEN`
- Vars: `DIAG_DEFAULT="0"` (set "1" to default diagnostics ON)
- KV: `ZONEQ` (queue), `CFG` (diag flag)
