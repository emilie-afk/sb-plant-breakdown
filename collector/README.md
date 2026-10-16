# sb-plant-breakdown collector (Windows)

Exports a saved Shopify report (a copy of **"Total sales by product"** grouped by product id and sales channel; its id goes in `reportId`) and uploads it to the sb-plant-breakdown Worker, so the dashboard's shared storage stays current without anyone dropping files in.

It follows the sb-gross-profit collector's conventions:
- **Own browser profile.** It uses its own Playwright profile in `%LOCALAPPDATA%\sb-plant-breakdown-collector\profile`, never anyone's everyday Chrome.
- **Visible window by default.** Headless runs got Shopify's "Just a moment…" check.
- **Secrets in Windows Credential Manager.** Nothing secret goes in the config file.
- **A JSON record per run.** Records hold no product rows.
- **Exit codes** match where they overlap.
- **Manual scheduling.** The Windows task is created only when someone runs `install-task.ps1 -Apply`.

No Shopify API, no custom app and no Make.com: it uses the same report screen a person uses.

## What a run does

1. **Choose the periods.** It works out which periods to collect from the **America/Los_Angeles** calendar, whatever the PC's own time zone:
   - **every run:** month-to-date (the 1st through yesterday), labelled partial in the dashboard;
   - **closed months** (`periods.closedMonths`): on the listed days of the month, the last `lookback` full months are collected again, so refunds and corrections made after month end are kept. An unchanged month writes nothing; a changed one becomes a new revision and the earlier revision stays in the history;
   - **backfill** (`periods.backfill`): up to `maxPerRun` full months missing from shared storage, newest first, back to `earliest`. When Shopify returns no data for a month, backfill stops there and remembers it (`backfill-state.json`), so it never keeps asking for history that does not exist.

   All of this is configurable; the values in `config.example.json` are a proposal. Older configs with `monthlyOnDay` keep working (the previous month, on that day).
2. **Open the saved report.** It loads the report with that period's dates and *compare to previous period*. It never clicks **Save**, so the saved report is unchanged.
3. **Read the page totals.** It reads the **Summary** row off the page (units and net sales).
4. **Export.** It exports **CSV, All results** (more than 1,000 product × channel rows is normal).
5. **Check the file before uploading.** It uses the dashboard's own parser and requires:
   - Product ID, Sales channel and previous-period columns;
   - no customer-looking columns;
   - totals equal to the page's Summary.

   If anything fails, nothing is uploaded (exit 34).
6. **Upload.** It uploads to `POST /v1/ingest/product-report` with the ingest key.
   - Re-uploading an unchanged report writes nothing.
   - A refused or failed upload keeps the CSV in `quarantine\` for 14 days, for a retry with `--from-file`.
   - The payload carries the collection time and the included / excluded totals, so the dashboard can show when the data was fetched separately from the sales period.
7. **Report failures.** When a period cannot be stored (sign-in needed, export failed, file refused by the checks), the collector sends a short failure record to `POST /v1/ingest/collection-failure`. The dashboard shows it above the analysis; the last successful report stays on screen.

## One-time setup (on the PC that will run it)

```powershell
cd collector
npm install
npx playwright install chromium        # or set "browserChannel": "chrome" to use installed Chrome
copy config.example.json config.local.json   # then fill in workerUrl
Install-Module CredentialManager -Scope CurrentUser
New-StoredCredential -Target sb-pb-ingest -UserName worker -Password '<INGEST_SECRET>' -Persist LocalMachine
npm run login        # a normal Chrome window opens on the collector's profile:
                     # sign in to Shopify (and 2FA) by hand, wait for the admin home page, close the window
```

The sign-in happens in an **ordinary, non-automated** window because Shopify's login page reloads in a loop for an automated browser. The collector does not try to hide its automation.

- **Keeping the sign-in between runs.** Shopify's sign-in cookies are session-only, so the collector switches on Chrome's standard **"On startup: Continue where you left off"** setting in its own profile. Without it the sign-in is lost whenever the collector's browser closes; with it, consecutive runs reuse it.
- **If Shopify signs the collector out anyway.** A scheduled run closes its automated window and opens a **normal window** at the Shopify admin. A person signs in, or just closes the window if it already shows the admin home. The run then continues. If nobody does so within `signInWaitMinutes`, it stops with exit 20 and the dashboard shows the failed import.


## Try it without uploading

```powershell
npm run dry-run                                            # today's periods
node src/collect.mjs --config config.local.json --start 2026-09-01 --end 2026-09-30 --dry-run
```

A good dry run prints one line per period, for example:
`<rows> rows, <products> products, <units> units, net <net> (own store <net>, Amazon via Sellbrite <net>)`
and the net figure must equal the report page's Summary row (the collector checks this itself).

## Upload for real

```powershell
npm run collect
```

## Schedule (off until you install it)

```powershell
.\windows\install-task.ps1                  # shows the proposed task, changes nothing
.\windows\install-task.ps1 -At 16:00 -Apply # installs it: daily at 16:00 local PC time
.\windows\install-task.ps1 -Uninstall
.\windows\check-task.ps1                  # read-only: state, next run, last result, scheduled or manual
```

`check-task.ps1` reports a **verified scheduled run** only when, for one Task Scheduler instance, the history shows the time trigger (event 107, not the hand-started 110), the start (100), the action finishing with result 0 (201) and completion (102), and `run-task.ps1`'s collector log for that instance ends `done (exit 0)` with every period uploaded or unchanged. Start time alone is never enough. If Task Scheduler history is off, it reports **not verified**; an administrator turns it on with Task Scheduler → Action → **Enable All Tasks History**. A collector run started by hand (`npm run collect`) never goes through the task at all.

- **Choosing the time.** Pick a local time at least an hour after midnight in Los Angeles: for example 16:00 or later at UTC+7, or 07:15 Pacific time.
- **What runs.** The task runs `windows\run-task.ps1` as the signed-in user. Logs go to `%LOCALAPPDATA%\sb-plant-breakdown-collector\logs` and are kept for 90 days.
- **If Shopify asks for a sign-in.** If the session expires or Shopify asks for 2FA, the run waits up to `signInWaitMinutes` (default 30) in the open window for a person, and otherwise stops with exit 20. The dashboard shows the failed collection above the analysis, and the last good report stays in place.

## Exit codes

| code | meaning |
|---|---|
| 0 | done (uploaded, unchanged, or dry run validated) |
| 5 | another run holds the lock |
| 10 | config problem (or missing credential) |
| 20 | Shopify sign-in / 2FA not completed in time |
| 21 | Shopify human check (captcha) not completed |
| 22 | an unexpected page |
| 30 | the report page or download failed |
| 31 | upload failed or refused; file kept in quarantine |
| 34 | the file failed the checks; nothing uploaded |

## Files

- `src/lib.mjs`: periods, query, CSV, validation, payload. Pure functions, tested in `tests/collector.test.mjs`.
- `src/browser.mjs`: the only browser code.
- `src/collect.mjs`: one run.
- `src/login.mjs`: one-time manual sign-in.
- `src/upload.mjs`, `src/credentials.mjs`, `src/redact.mjs`: the upload call, the Credential Manager read, and keeping secrets out of logs.
- `windows/run-task.ps1`, `windows/install-task.ps1`: what the scheduled task runs, and how the task is created or removed.
