# EQ Zone Watcher

Electron tray app that watches EverQuest log files and updates a Google Sheet via a tiny backend.
Works great across **multiple PCs / time zones**: log timestamps are normalized to **UTC**; Google Sheets renders dates in the **sheet’s time zone**.

▶️ **Demo video:** [EQ Zone Watcher in action](https://www.youtube.com/watch?v=RXnYiDdamkg)

---

## Features

* 🖥️ **Windows tray** app (Electron)
* 🔎 Scans `eqlog_*.txt` and finds the **latest** “You have entered …” per log file
* 📤 Upserts **latest per character** to a “Zone Tracker” tab in your Google Sheet
* 📦 Optionally sends `*-Inventory.txt` into an “Inventory - <Char>” tab
* 🔁 **Initial Scan** + optional **Periodic scan** (scan + send)
* 🗂️ JSON tools: export local state; import a saved JSON (direct or RAW staging)
* 🧩 Tiny backend:

  * **Option A (recommended):** Cloudflare Worker **proxy →** Apps Script
  * **Option B:** Direct **Apps Script /exec** (no proxy)

---

## Folder Layout

```
repo/
├─ main.js                     # Electron app entry (tray, watcher, sender)
├─ Code.gs                     # Apps Script backend (sheet importer)
├─ package.json
├─ .env.example                # sample dev env
├─ .env                        # (dev only) local overrides
├─ .env.production             # packaged build defaults
├─ defaults/
│  └─ config.json              # safe seed config (scan interval, tab name)
├─ lib/
│  ├─ date.js                  # UTC formatting & helpers
│  ├─ parser.js                # log tail + zone extraction
│  ├─ inventory.js             # inventory TSV reader + file dates
│  └─ sheets.js                # POST helper (client-side)
├─ assets/
│  ├─ app-icon.ico             # ≥256x256 for Windows builds
│  ├─ tray-dark.png
│  └─ tray-light.png
└─ eq-zone-worker/             # (optional) Cloudflare Worker proxy
   ├─ wrangler.toml
   ├─ package.json
   ├─ README.md
   └─ src/index.js
```

---

## Requirements

* Windows 10+ (macOS/Linux should work with minor tweaks)
* Node.js 18+ (recommended 20+)
* A Google account with access to the target Sheet

---

## Pick your backend

You can run **either** through a **Cloudflare Worker** proxy (recommended) **or** directly to **Apps Script /exec**.

### Option A (recommended): Cloudflare Worker → Apps Script

**Why:** stable URL for distribution, hide your Apps Script secret, edge queue/retry on 429/5xx.

1. Go to `eq-zone-worker/` and follow its README:

   * `wrangler kv namespace create ZONEQ` and `CFG`
   * `wrangler secret put APPS_SCRIPT_URL` (your Apps Script `/exec`)
   * (Optional) `wrangler secret put SCRIPT_SECRET`, `CLIENT_SECRET`, `ADMIN_TOKEN`
   * `wrangler deploy`
2. You’ll get a URL like:

   ```
   https://eq-zone-proxy.<your-subdomain>.workers.dev
   ```
3. Use **that Worker URL** in the Electron app (see “Configure the app” below).

> You can check Worker status at `GET /diag`. If you enabled the admin token, toggle logs with `POST /diag?on=1|off=1` + `X-Admin`.

---

### Option B: Direct Apps Script

1. **Create your Sheet** (or open an existing one), then in that Sheet go to
   **Extensions → Apps Script** (this auto-binds the script to your Sheet).
2. Replace the default script with the contents of **`Code.gs`** (from this repo).
3. Click **Deploy → Manage deployments → New deployment → Web app**:

   * **Execute as:** *Me*
   * **Who has access:** *Anyone with the link* (or your account if only you post)
   * **Deploy** and copy the **Web app URL** (`…/exec`).
4. (Optional) **Script properties** (Project settings → Script properties):

   * `SHEET_ID` – spreadsheet ID (if you want the script to know it)
   * `SHARED_SECRET` – a token your app (or Worker) will send in `X-Auth`
   * `DEFAULT_ZONE_TAB` – default tab name (default: `Zone Tracker`)
5. In the **Google Sheet**: File → **Settings** → set the Sheet **Time zone**.

> The script writes **Date cells**; Sheets handles display in the Sheet’s time zone.

---

## Configure the Electron app

1. Install deps:

   ```bash
   npm install
   ```
2. Dev settings: copy `.env.example` → `.env`, then set at least:

   ```ini
   # Use the Worker URL (Option A), or your Apps Script /exec (Option B)
   APPS_SCRIPT_URL=https://eq-zone-proxy.<subdomain>.workers.dev
   # If your Worker requires X-Auth:
   APPS_SCRIPT_SECRET=your-worker-client-secret
   # If calling Apps Script directly and you set SHARED_SECRET there:
   # APPS_SCRIPT_SECRET=the-same-secret

   EQ_LOG_DIR=C:\Path\To\EverQuest\Logs   # folder with eqlog_*.txt
   EQ_BASE_DIR=C:\Path\To\EverQuest       # (optional) for *-Inventory.txt
   EQ_SHEET_ID=                           # optional if stored as a Script property
   EQ_SHEET_TAB=Zone Tracker
   SCAN_INTERVAL_SECS=60
   ```

   *Tip:* In production builds, `.env.production` provides packaged defaults (users can still change these via **Settings**).
3. Run:

   ```bash
   npm run dev
   ```

> The app persists user overrides in `%APPDATA%/EQ Zone Watcher/config.json`.
> You can also edit everything later from the tray **Settings** menu.

---

## Using the Tray Menu

* **Initial Scan** – Full scan of `eqlog_*.txt` and send once.
* **Periodic scan (scan + send)** – Toggle on/off; pick 30/60/120/300s.
* **Create JSON (save locally)…** – Export current “latest per log”.
* **Send JSON to Google Sheet…**

  * **Store & Import** – Import immediately.
  * **Store RAW only** – Save to `RAW!A1`; import later from the Sheet menu.
* **Inventories → Send Inventory: <Char>** – Push a character’s `*-Inventory.txt`.
* **Settings**

  * Set Apps Script URL / Shared Secret / Sheet ID
  * Set EQ Base Folder… / Set EQ Logs Folder…
* **Open Sheet** – Opens spreadsheet if `EQ_SHEET_ID` is set.
* **Quit**

---

## Sheet schema

**Zone Tracker** (default tab “Zone Tracker”):

| A              | B        | C         | D (Date)           | E (Date)           |
| -------------- | -------- | --------- | ------------------ | ------------------ |
| Character Name | Log File | Zone Name | Detected Timestamp | Last Updated (UTC) |

* **Key:** `Log File` (one row per log file).
* **Upsert rule:** updates when the incoming timestamp is **newer** (UTC) or blank.
* Dates are stored as **real Date cells**.

**Inventory - *Character*** tabs:

* Row1: `Inventory for | File | Created On | Modified On`
* Row2: values (plus filename)
* Row4+: TSV rows from `*-Inventory.txt`

---

## Time & Time-zones

* Log timestamps are normalized to **UTC** before sending.
* Apps Script writes **Date** values; Sheets renders them in the **Sheet’s** time zone (File → Settings).
* Multiple PCs/time zones won’t conflict—the **newest absolute timestamp wins**.

---

## Build (Windows)

```bash
npm run dist
```

Creates an NSIS installer in `dist/`.
Make sure `assets/app-icon.ico` is ≥256×256 (already included).

---

## Troubleshooting

* **Needs URL** – Set the URL in `.env` or from **Settings → Set Apps Script URL**.
  With Worker: use the **Worker URL**. With direct Apps Script: use the `/exec` URL.
* **403 unauthorized**

  * Worker path: set `CLIENT_SECRET` in the Worker; put the same value into the app (**Shared Secret**).
  * Direct Apps Script: if you set `SHARED_SECRET` in Script Properties, the app must send it.
* **429 Too Many Requests**

  * If using direct Apps Script, increase interval (e.g., 120–300s).
  * With Worker, spikes are **queued** and retried on a cron.
* **Nothing updates**

  * Verify `EQ_LOG_DIR` path and that files match `eqlog_*.txt`.
  * Try **Initial Scan** to seed rows.
  * Check the app console (dev) or your Worker logs: `wrangler tail`.
* **Worker `/diag` shows missing vars**

  * Production deploys don’t read `.env`. Set secrets with:

    ```
    wrangler secret put APPS_SCRIPT_URL
    wrangler deploy
    ```
* **Times look off**

  * Change the **Sheet’s time zone** (File → Settings). Stored values are true Date cells.

---

## Environment variables (Electron)

| Name                 | Purpose                                  |
| -------------------- | ---------------------------------------- |
| `APPS_SCRIPT_URL`    | Worker URL (Option A) or `/exec` URL (B) |
| `APPS_SCRIPT_SECRET` | Optional `X-Auth` the app sends          |
| `EQ_SHEET_ID`        | Target spreadsheet ID (optional)         |
| `EQ_SHEET_TAB`       | Zone tab name (default: `Zone Tracker`)  |
| `EQ_LOG_DIR`         | Folder containing `eqlog_*.txt`          |
| `EQ_BASE_DIR`        | Folder with `*-Inventory.txt` (optional) |
| `SCAN_INTERVAL_SECS` | Periodic scan interval (0 disables)      |

---

## Data & Privacy

The app reads local text files and sends:

* The **latest zone per log file** (and timestamps), and
* Optional **inventory TSV** for selected characters
  to your configured backend (Worker or Apps Script).
  No analytics, no third-party logging.

---

## License

MIT — enjoy!

---

## FAQ

**Do I need Google Cloud APIs?**
No. The backend is **Apps Script** (or a Worker proxy to it). The script writes to Sheets directly.

**Multiple computers—who wins?**
The one with the **newer** UTC timestamp. Time zone doesn’t matter.

**Can I omit `EQ_SHEET_ID`?**
Yes. Store it as a Script Property (`SHEET_ID`) and the app can leave it blank.

**What URL do I paste into the app?**

* With **Worker**: paste the **Worker URL** (the Worker forwards to Apps Script).
* With **direct** setup: paste the **Apps Script `/exec`** URL.
