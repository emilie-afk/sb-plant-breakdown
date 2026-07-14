# Succulents Box — Sales Breakdown Analyzer (Web)

A password-protected, browser-based analyzer for Amazon and Shopify sales exports. Public GitHub repo OK; free Netlify account.

- Upload files in the browser; processing is 100% client-side. Nothing is uploaded to any server.
- Saved snapshots persist in your browser between visits (localStorage).
- Encrypted via StatiCrypt; the only thing published to Netlify is one encrypted HTML file.

---

## What's in this folder

| File | Purpose |
|---|---|
| `index.html` | The analyzer UI (tabs: Amazon, Shopify, Cross-channel). |
| `genus-data.js` | Plant genus dictionary used by the analyzer. |
| `app.js` | All UI logic: file parsing, aggregation, charts, snapshot storage. |
| `build.sh` | Netlify build step: inlines the JS into the HTML, then encrypts with StatiCrypt. |
| `netlify.toml` | Build + publish settings for Netlify. |
| `package.json` | Declares StatiCrypt as a build-time dependency. |
| `.gitignore` | Excludes `node_modules/`, `dist/`, etc. |

---

## How to deploy (one-time, ~10 minutes)

### 1. Push to GitHub

- Create a new GitHub repo (it can be **Public**).
- Upload **everything in this folder** (drag-and-drop on github.com works).

### 2. Connect Netlify

- Sign in at **app.netlify.com** (free plan is fine).
- **Add new site → Import an existing project → GitHub** → pick the repo.
- Leave defaults — Netlify reads `netlify.toml`. Click **Deploy**.

### 3. Set the password

This is the most important step.

- In Netlify → **Site settings → Environment variables → Add a variable**.
- **Key:** `APP_PASSWORD`  **Value:** your password.
- Save, then go to **Deploys → Trigger deploy → Deploy site**.
- After the build turns green (~1 minute), open the site URL.
- You'll see a StatiCrypt password prompt. Enter your password to unlock.

---

## How it stays secure with a public GitHub repo

| Threat | What stops it |
|---|---|
| Someone clones the GitHub repo | They get the analyzer code + plant dictionary — no business data, since data is uploaded by users. |
| Someone visits the Netlify URL | StatiCrypt password prompt blocks them. Wrong password = encrypted gibberish. |
| Someone scrapes the deployed page | All code is inlined and encrypted at build time. There are no separate JS files to scrape, no API endpoints. |
| A visitor's uploaded data leaks | Impossible — it's parsed in their browser. Nothing is transmitted. There's no server storing it. |
| Brute-force the password | StatiCrypt uses PBKDF2 — slow by design. Pick a 4+ word passphrase. |

---

## Using the site

1. Visit the Netlify URL, enter the password.
2. **Amazon tab** — drop your Amazon metric-data .xlsx export.
3. **Shopify tab** — drop your Shopify "Total sales by product" .csv export.
4. **Cross-channel tab** — once both are uploaded, see side-by-side comparison.

### Features per tab

- **Snapshot dropdown** — every upload is auto-saved, labeled by the date range in the filename.
- **vs Compare** — pick a second snapshot to do YoY / MoM / period-over-period.
- **Download clean data** — exports the active snapshot as .xlsx with a `Genus` column added.
- **Top 25 chart** — horizontal bars by revenue.
- **Genus summary** — sortable table, click a row to drill into that genus's plants.
- **Drill-down** — toggle between **All plants** and **≥ $100 only**.
- **Amazon alerts** — out-of-stock with traffic / high-traffic-low-conversion.
- **Cross-channel** — channel-split chart + per-genus preference table (Amazon vs Shopify).

### Manage snapshots

Click **⚙ Manage snapshots** in the top right to see what's saved or delete old snapshots.

---

## To change the password later

Update `APP_PASSWORD` in Netlify env vars → click **Trigger deploy → Deploy site**.

---

## Local development (optional)

If you want to preview the site without encryption before pushing:

```
python -m http.server 8000
```

Then open `http://localhost:8000`. You'll see the analyzer with no password gate (StatiCrypt is only applied during Netlify build).
