# EQ Zone Watcher (Tray App + Apps Script)

A tiny Electron tray app that watches your EverQuest log files and keeps a Google Sheet up to date with:

- your **current zone per character** (updated on change, with UTC timestamps)
- optional **inventory tables** (sent immediately on demand)

It talks to a small **Google Apps Script** that does the actual upsert into your sheet.

---

## Highlights

- **Initial Scan**: scan all `eqlog_*.txt` and push once.
- **Periodic scan** (default every 60–120s): picks up new zone changes and pushes deltas.
- **Inventory send**: one click per character (`*-Inventory.txt`) → Sheet tab `Inventory - <Character>`.
- **UTC timestamps** in `YYYY-MM-DD HH:mm:ss` format.
- **Resilient parser**: tail + fallback full read, matches `You have entered <Zone>.` and timestamps like `[Fri Sep 12 10:23:45 2025]`.
- **Diagnostics**: ping your Apps Script, run a cycle, view status, open the log folder.
- **Safe queueing**: new deltas aren’t dropped if they arrive during a send.
- **Log rotation**: cap file size and keep a few rotated copies.

---

## How it works (quick)

1. The tray app watches your EQ logs directory for files named like `eqlog_<Character>_*.txt`.
2. On a zone change, it enqueues a delta and POSTs a JSON blob to your Apps Script `/exec`.
3. The Apps Script writes/updates rows in your **Zone Tracker** tab keyed by **Log File**.
4. Inventory sends push `*-Inventory.txt` TSV content into `Inventory - <Character>` tabs.

---

## Requirements

- **Windows 10/11** (macOS/Linux builds possible with electron-builder)
- **Node 20+**
- **Google Account**
- A Google Sheet you own (or can edit)

---

## Setup — Apps Script (from Google Sheets)

1) **Create a new Google Sheet**  
   - Google Drive → **New → Google Sheets**.  
   - (Optional) Rename it (e.g., “EQ Zone Tracker”).  
   - Copy the **Sheet ID** (between `/d/` and `/edit` in the URL).

2) **Open Apps Script from the Sheet**  
   - Sheet menu → **Extensions → Apps Script**.  
   - Delete placeholder code and **paste** the contents of `Code.gs` from this repo.

3) **(Optional) Script Properties**  
   Apps Script → **Project Settings (gear) → Script properties → + Add script property**  
   - `SHEET_ID` → your Sheet ID (lets the script default to this Sheet)  
   - `SHARED_SECRET` → any string you’ll also enter in the tray app (blocks unauthorized posts)  
   - `DEFAULT_ZONE_TAB` → e.g., `Zone Tracker`

   > If you don’t set `SHEET_ID` here, you can provide it from the tray app’s **Settings** instead.

4) **Deploy the Web App**  
   - **Deploy → Manage deployments → New deployment**  
   - **Select type:** *Web app*  
   - **Execute as:** **Me**  
   - **Who has access:** **Anyone with the link**  
   - **Deploy**, then **copy the Web app URL** (must end with `/exec`).

   > To keep the same `/exec` URL in the future, **edit the existing deployment** (Manage deployments → select it → **Edit** → **New version** → **Deploy**). Creating a *new* deployment generates a *new* URL.

5) **Connect the Tray App**  
   - Open the app → **Settings**:  
     - **Apps Script URL:** paste the `/exec` URL you copied  
     - **Shared Secret:** paste the same string you used in `SHARED_SECRET` (if set)  
     - **Google Sheet ID:** paste the Sheet ID (skip if you set `SHEET_ID` in Script Properties)  
     - **EQ Logs Folder** (and optional **Base Folder** for inventories)
   - Use **Diagnostics → Ping Apps Script** to confirm a JSON `ok:true` response.

6) **First send**  
   - Click **Initial Scan** in the tray menu to seed the **Zone Tracker** tab.  
   - Periodic scans will send deltas whenever you zone in-game.

---

## Running

```bash
npm install
npm run dev   # runs the tray app
# npm run pack  # directory build
# npm run dist  # Windows installer
```

**Tray menu** (key items):

- **Initial Scan** – scan all logs and push once.
- **Inventories** – per-character send of inventory TSV.
- **Periodic scan (scan + send)** – toggle.
- **Scan interval** – 30 / 60 / 120 / 300 seconds.
- **Diagnostics**:
  - **Show status** – queue size, last runs, paths.
  - **Run periodic cycle now**
  - **Ping Apps Script**
  - **Open log file folder**
- **Settings** – set URLs/IDs/folders at any time.

> Note: “Send ALL zones now (force)” and “Reset zone state (local)” were removed by request.

---

## Packaging (Windows)

- **App icon**: `assets/app-icon.ico`  
- **Tray icons**: `assets/tray-dark.png`, `assets/tray-light.png`

If 7-Zip fails with a symlink privilege error during code-sign tool extraction:
- Enable **Developer Mode** (Windows → For developers → Developer Mode), or
- Build from an **elevated PowerShell** (Run as administrator), then
- Delete `C:\Users\<you>\AppData\Local\electron-builder\Cache\winCodeSign` and retry.

---

## Configuration

At startup, the app loads (highest to lowest precedence):
1. Saved **Settings** (`config.json` in Electron **userData**)
2. Packaged defaults (if you include `defaults/config.json`)
3. `.env` / `.env.production` (mainly for development)

Common environment variables:
```
APPS_SCRIPT_URL=...
APPS_SCRIPT_SECRET=...
EQ_SHEET_ID=...
EQ_LOG_DIR=C:\...\EverQuest\Logs
EQ_BASE_DIR=C:\...\EverQuest
EQ_SHEET_TAB=Zone Tracker
SCAN_INTERVAL_SECS=60
LOG_MAX_BYTES=5242880
LOG_MAX_FILES=3
LOG_COMPRESS=0
```

---

## Troubleshooting

**Ping returns HTML (not JSON)**  
- You’re hitting the wrong deployment or the script threw: ensure **/exec** URL, **Execute as: Me**, **Anyone with the link**, and that the script owner has **edit** access to the Sheet.

**No periodic updates**  
- Verify EQ logs folder path and that lines contain “You have entered …”
- Check Diagnostics → Show status
- Ensure Apps Script returns JSON `{ ok:true }`; if errors, they come back as JSON with `error`.

**429 rate limit**  
- Increase scan interval (120–300s recommended).

---

## License

MIT
