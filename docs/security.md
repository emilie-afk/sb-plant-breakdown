# Security: sessions, gateway, private configuration

The repository stays public. The page is a public shell with **no key, password,
storage address or business data** in it. Data is reached only after a
server-checked sign-in, through same-origin Netlify Functions that hold the
Worker keys.

```
browser ──(cookie + CSRF)──> Netlify Functions ──(server-held bearer key)──> Cloudflare Worker ──> D1
                             /api/session                                    role per key
                             /api/v1/*  (allowlist)
                             /api/stock-tracker
Windows collector ──(INGEST key from Credential Manager)──────────────────> Worker (unchanged)
```

## 1. Sessions (`server/session.mjs`)

- **Sign in with Google** — there are no dashboard passwords. Server-side
  OAuth 2.0 / OpenID Connect authorization-code flow with PKCE
  (`server/google.mjs`): `/api/auth/google/start` redirects to Google with
  `state`, `nonce` and an S256 code challenge, whose secrets travel in an
  AES-256-GCM-sealed, 10-minute, `HttpOnly; Secure; SameSite=Lax` cookie;
  `/api/auth/google/callback` checks `state` (login CSRF), exchanges the code
  with the client secret and the PKCE verifier, verifies the ID token's RS256
  signature against Google's published keys and its `iss`, `aud`, `exp`,
  `nonce` and `email_verified`, then checks the email against the allow-list.
  The browser never sees the client secret, the verifier or any Google token.
- **Allow-list** (`GOOGLE_ALLOWED_EMAILS`) and **editor list**
  (`GOOGLE_EDITOR_EMAILS`; editors are always allowed): only listed Google
  accounts get a session; everyone else sees "This Google account is not
  allowed". Both lists are checked on **every request**, so removing an email
  (and redeploying) ends that person's access at once, and moving an email
  on/off the editor list changes their rights at once.
- The redirect URI is built only from origins in `GOOGLE_REDIRECT_ORIGINS`;
  each must also be registered as an authorized redirect URI in Google Cloud
  (`<origin>/api/auth/google/callback`).
- Cookie `__Host-sbpb_session`: HMAC-SHA256-signed, `HttpOnly; Secure;
  SameSite=Strict; Path=/`, no Domain. Expiry (default 12 h, max 24 h) is
  checked on every request.
- `SESSION_SECRET` signs sessions and seals the OAuth state; it is separate
  from the Google client secret.
- Session restore: `GET /api/session`. Logout: `DELETE /api/session` revokes
  the session id in Netlify Blobs; if that write fails the function answers
  500 and the session stays valid. **End every session at once**: change
  `SESSION_GENERATION` (or `SESSION_SECRET`) and redeploy.
- Writes need the `x-sb-csrf` header (HMAC of the session id, kept in page
  memory only) **and** a same-origin `Origin`.
- Sign-in limits are **concurrency-safe**: every Google callback is counted
  *before* the code is exchanged and the account checked, with one atomic SQL statement per bucket
  (`INSERT … ON CONFLICT DO UPDATE … RETURNING`) in the Worker's D1 database
  (`POST /v1/auth/attempt`, key `AUTH_SECRET`, migration 0006). N simultaneous
  attempts get counts 1…N, so at most the limit (5 per client, 30 in total
  per 15 minutes, configurable) are checked; the rest are refused
  (`?signin=too_many`). A successful sign-in clears its client count and
  returns its global slot. Tested with 40 simultaneous refused sign-ins
  (exactly 5 checked, 35 refused; counter = 40; only 5 code exchanges).
  Client addresses are stored only as an HMAC. If the counter cannot be
  reached, sign-in is refused (503).
- Missing or weak configuration means 503 for everything (fail closed).

### Sign-out and the page's session boundary (`auth-view.js`)

- The page starts locked (only the sign-in overlay is visible) until the
  server confirms a session.
- **Sign-out is complete only when the server confirms it** (200,
  `authenticated:false`). Before the request the page is locked and shared
  data is wiped. If the server answers 500 / 403, or the network fails, the
  page stays locked, says the sign-out did not complete and offers *Retry
  sign-out*; it never shows "signed out" and makes no API calls. A reload then
  honestly restores the still-valid session.
- On sign-out, failed sign-out or expiry (any 401, or the expiry timer) the page
  wipes: shared reports and period views, market data, report history lists,
  vendor map, restricted items, market rules, shared classification
  corrections, stock-tracker data, browser-storage copies, links from hand
  uploads to shared reports, and rendered tables / charts / status. After a
  confirmed sign-out or expiry it reloads clean.
- **Expiry is enforced locally.** At the session's known `expiresAt` the page
  locks, aborts pending data requests and wipes shared data on its own — no
  server answer is needed (a timer at the deadline, re-checked on focus /
  visibility and before every API call, so a sleeping laptop is caught too).
  State `expired` ("Your session expired. Sign in again.") is distinct from
  `unavailable` ("the server is not available / could not be reached"); while
  expired, a 503, a network failure or even an "authenticated" answer keeps the
  page locked — only a new sign-in (or a reload with a valid session) opens
  it, and the emptied views are rebuilt by a reload.
- A session-check answer is applied only if nothing changed since it was sent
  (session epoch + check sequence + state): a late answer after a sign-out, an
  expiry or a new sign-in is ignored.
- Every API call goes through `SBAuth.fetchJson`, bound to a session epoch:
  sign-out aborts calls in flight and discards any answer that still arrives,
  so nothing can repopulate the page.
- Shared data is never written to browser storage (memory only; the tracker
  cache is per-tab `sessionStorage`). **Reports uploaded by hand stay**, kept
  separately.

### Untrusted text

- HTML: every value from imported files or shared storage (titles, ASINs, SKUs,
  vendors, product types, store names, labels, file names, messages) is escaped
  before it enters `innerHTML` (`H()` / `BUI.esc` / `sbHtml`), including
  drill-downs, cross-channel, market, Owned-vs-Market and Opportunity views.
  The CSP (no inline handlers, no `javascript:`) stays as a second layer.
- CSV: one encoder (`export-safety.js` `sbCsvCell` / `sbCsv` /
  `sbDownloadCsv`) for every export: formula neutralisation (`= + - @`, also
  after leading whitespace/line breaks; real numbers untouched) **and** RFC 4180
  quoting of comma, quote, CR and LF. A test fails the build if any file builds
  CSV by hand. XLSX exports write text cells (never formulas) through the same
  neutralisation, and figures as numeric cells (they were partly written as
  "12.30" text before; fixed). Verified by reopening 8 representative
  workbooks with hostile text: no `<f>` formula element, no text cell that
  can start a formula, every figure a plain number.

## 2. Route / permission matrix

| Browser route (session) | Session role | Worker route | Netlify key used | Worker roles allowed |
|---|---|---|---|---|
| `GET /api/v1/reports?source=&history=1` | viewer, editor | `GET /v1/reports` | `WORKER_VIEWER_SECRET` | viewer, dashboard |
| `GET /api/v1/reports/:id/rows?offset=&limit≤5000` | viewer, editor | `GET /v1/reports/:id/rows` | viewer | viewer, dashboard |
| `GET /api/v1/imports?source=&limit≤200` | viewer, editor | `GET /v1/imports` | viewer | viewer, dashboard |
| `GET /api/v1/settings/:key` (6 allowlisted keys) | viewer, editor | `GET /v1/settings/:key` | viewer | viewer, dashboard |
| `PUT /api/v1/settings/:key` (classification_overrides, amazon_column_mappings, catalog_mappings; ≤2 MB) | editor + CSRF | `PUT /v1/settings/:key` | `WORKER_SETTINGS_SECRET` | settings, dashboard |
| `POST /api/v1/ingest/product-report` (≤5 MB) | editor + CSRF | `POST /v1/ingest/product-report` | `WORKER_UPLOAD_SECRET` | collector, uploader, dashboard |
| `GET /api/stock-tracker?refresh=1` | viewer, editor | tracker app (fixed paths) | `STOCK_TRACKER_PASSWORD` | — |
| `POST /api/session` (sign-in) | — | `POST /v1/auth/attempt`, `/v1/auth/success` | `WORKER_AUTH_SECRET` | auth |
| — (not reachable from the browser) | | `POST /v1/ingest/collection-failure` | | collector |
| — | | `GET /v1/ingest/coverage` | | collector, dashboard |
| — | | `POST /v1/ingest/vendor-map` | | collector, dashboard |
| — | | `GET /v1/health` | | public: `{ok, service, time}` only |

Gateway rules: every other path, method or parameter is refused (authentication
is checked first, so the table is not revealed); the destination is fixed by
`WORKER_URL`; a fresh header set is sent (no caller cookie, authorization,
host or forwarded headers); redirects are refused; replies are
`no-store, private`; an upstream 401 becomes 502 `upstream_auth_failed`.

Worker roles (each secret ≥ 32 characters; a missing or short one grants
nothing): `INGEST_SECRET` collector · `VIEWER_SECRET` read-only (**not
harmless**: it reads all revenue history) · `UPLOAD_SECRET` manual uploads only ·
`SETTINGS_SECRET` shared-settings writes only · `AUTH_SECRET` sign-in
attempt counters only (reads nothing) · `DASHBOARD_SECRET`
administration, operator tools only. CORS is not authentication. Errors are
returned as codes only.

## 3. Private configuration

Not in the repository; stored as Worker settings, read only through a signed-in session.

| Setting | Contents | Used by | If missing |
|---|---|---|---|
| `restricted_items` | `{items:[{sku,name}]}` | "can't sell" flags | nothing flagged; filter shows nothing |
| `market_config` | store-group regexes, focus stores, marketplace store names, filename → store rules | External Stores, Owned vs Market, Opportunity Map | each store shown under its own name; "No focus stores configured" |
| `vendor_map` | product → vendor (collector, from the Products Master) | vendor views | Shopify vendor, listed as unresolved |
| collector `config.local.json` | sheet id and tab gids, `shipstation.storeGroups` | collector only | vendor map skipped; stores not grouped (warning printed) |

Sheet locations stay in the collector's local config; nothing in the page or
the Worker names a sheet. Sheet permissions are unchanged.

**Import procedure** (operator PC, Credential Manager keys, never printed):

```
node tools/private-settings.mjs check restricted_items --url <WORKER_URL> --file <private>/restricted_items.json
node tools/private-settings.mjs push  restricted_items --url <WORKER_URL> --file <private>/restricted_items.json          # dry run
node tools/private-settings.mjs push  restricted_items --url <WORKER_URL> --file <private>/restricted_items.json --apply
# same for market_config; "pull" saves the current shared copy for review
```

The value is validated with the Worker's own rules before sending, and a newer
shared copy is never overwritten.

## 4. Settings (placeholders only)

**Netlify → Site configuration → Environment variables, scope: Functions only (not Builds):**

| Variable | Value |
|---|---|
| `SESSION_SECRET` | `<64 random hex>` (`node tools/make-session-secret.mjs`) |
| `GOOGLE_CLIENT_ID` | `<…>.apps.googleusercontent.com` (Google Cloud → APIs & Services → Credentials → OAuth client ID, type *Web application*) |
| `GOOGLE_CLIENT_SECRET` | `<client secret of that OAuth client>` |
| `GOOGLE_ALLOWED_EMAILS` | `name1@succulentsbox.com, name2@gmail.com` (viewers; comma separated) |
| `GOOGLE_EDITOR_EMAILS` | `owner@succulentsbox.com` (can upload and change settings; always allowed) |
| `GOOGLE_REDIRECT_ORIGINS` | `https://sb-plant-breakdown.netlify.app` plus the deploy-preview origin while testing |
| `SESSION_GENERATION` | `1` (change to end all sessions) |
| `SESSION_TTL_HOURS` | `12` (optional) |
| `WORKER_URL` | `https://<worker>.<account>.workers.dev` |
| `WORKER_VIEWER_SECRET` | `<sb-pb-viewer>` |
| `WORKER_UPLOAD_SECRET` | `<sb-pb-upload>` |
| `WORKER_SETTINGS_SECRET` | `<sb-pb-settings>` |
| `WORKER_AUTH_SECRET` | `<sb-pb-auth>` |
| `STOCK_TRACKER_URL` | `https://<tracker-site>` |
| `STOCK_TRACKER_PASSWORD` | `<new tracker password>` |

Remove after rollout: `SB_SHARED_URL`, `SB_SHARED_KEY`, `SB_MCG_PASSWORD`, `APP_PASSWORD`.

**Google Cloud OAuth client** (done by the owner): consent screen *Internal*
if every user is in the succulentsbox.com Workspace, otherwise *External* in
*Testing* or *Production* with scopes `openid` and `email` only; authorized
redirect URIs: `https://sb-plant-breakdown.netlify.app/api/auth/google/callback`
and, for the preview, `https://deploy-preview-2--sb-plant-breakdown.netlify.app/api/auth/google/callback`
(remove the preview one after the rollout). No JavaScript origins are needed.
The build fails if any server variable's value appears in the page.

**Cloudflare Worker secrets:** existing `INGEST_SECRET`, `VIEWER_SECRET`,
`DASHBOARD_SECRET`; new `UPLOAD_SECRET`, `SETTINGS_SECRET`, `AUTH_SECRET`
(`worker/add-gateway-keys.ps1`). New migration `0006_auth_attempts.sql` (adds
one table; nothing existing changes).

## 5. Collector compatibility

- Same INGEST key, same routes, same Credential Manager entries, same payloads,
  validation, idempotency and ShipStation guard. Scheduled tasks unchanged.
- Only change: market store grouping moved from code to
  `shipstation.storeGroups` in `config.local.json`. **Add it before updating the
  collector code**, using the same rules as `market_config`, so saved
  `salesChannel` values stay identical (parity check: identical payloads).
- Old collector code keeps working with the new Worker (unchanged collector role).

## 6. Rollout (each step needs approval)

The old viewer key and the old tracker password are **public** (they are in
past public builds/deploys). The private settings are imported only **after**
the old viewer key is retired, so it can never read them.

0. **Backup**: `wrangler d1 export` of the database; note the current Netlify
   variables.
1. **Worker, additive**: apply migration 0006, deploy the Worker code, run
   `add-gateway-keys.ps1 -Apply` (UPLOAD/SETTINGS/AUTH), `verify-worker.ps1`.
   The live dashboard keeps working (the old viewer key is untouched).
2. **Google OAuth client + Netlify variables** (scope Functions): create the
   OAuth client (above); then `SESSION_SECRET`, `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_EMAILS`, `GOOGLE_EDITOR_EMAILS`,
   `GOOGLE_REDIRECT_ORIGINS` (production + preview origin), `WORKER_URL`, `WORKER_UPLOAD_SECRET`, `WORKER_SETTINGS_SECRET`,
   `WORKER_AUTH_SECRET`, the tracker URL; `WORKER_VIEWER_SECRET` = the *current*
   viewer key for the preview only (server side; no new exposure; it is retired
   in step 4).
3. **Deploy preview** of the new dashboard; check sign-in, sign-in limits,
   reports, history, month/quarter/year, vendors, market views, manual upload,
   settings push, sign-out (and a failed sign-out), `/api/v1/reports` without
   cookie → 401, response headers (CSP, no-store). Private settings are not
   imported yet: the market views show stores ungrouped and nothing restricted.
4. **Cut-over, back to back** (the old public page stops showing data — expected):
   a. `rotate-viewer-key.ps1 -Apply` (old key dead everywhere at once; not kept);
   b. set the new value as `WORKER_VIEWER_SECRET` in Netlify;
   c. publish the new deploy to production;
   d. check the old key now gets 401 and the new dashboard loads.
5. **Import private settings** (`tools/private-settings.mjs … --apply`) — only now.
6. **Tracker password**: change it on the tracker app, set
   `STOCK_TRACKER_PASSWORD`, redeploy. Remove `SB_SHARED_*`,
   `SB_MCG_PASSWORD`, `APP_PASSWORD`.
7. **Collector**: add `storeGroups` to its config, then update its code.
8. Production checks. Only then is the live app considered secured.

**Rollback — the exposed viewer key is never reactivated:**
- Before step 4: drop the preview; steps 1–2 are additive and harmless.
- After step 4: fix forward, or redeploy an earlier deploy **of this new code**.
  Never redeploy a page that embedded a key and never set the old key again
  (`rotate-viewer-key.ps1` keeps no copy of it). If the gateway key must
  change, rotate again to a *new* key and update Netlify.
- Worker code: roll back only to versions that include the AUTH role (an older
  Worker makes sign-in fail closed, 503). Migration 0006 only added a table;
  it can stay.

### Acceptance-check corrections (local parity run)
- *"sales period, revision, collection and import time shown separately"* —
  a real gap: in the month/quarter/year view the status line did not say which
  revision each month came from. Fixed in the page: it now lists, per month,
  the revision and its collected and imported times.
- *"Shopify analysis covers all product types by default"* — outdated
  expectation: it compared raw Shopify product types (22 spellings) with the
  filter, which lists canonical types (16) since the taxonomy change. The check
  now requires every included product's canonical type to be selectable.
- *"CSV download of a revision matches the stored row count"* — the check
  counted text lines; a quoted title containing a line break is one record.
  It now parses the CSV (RFC 4180).

## 7. History cleanup (separate, needs approval; rewrites history)

Public history contains: an encrypted old build (`dist/index.html`, commit
511fb79, removed in f75a7d0) holding the restricted-items list; `exclusions.js`
with that list; supplier/store names in comments and code. No Worker key,
sheet id or tracker password was ever committed. Plan: `git filter-repo
--path dist/index.html --invert-paths` plus `--replace-text` for the list and
names, force-push all branches and tags, ask GitHub support to purge cached
views and PR refs, re-clone everywhere. Past Netlify deploys are separate:
delete old deploys that embedded keys, or accept them once the keys are retired.

## 7b. Vendored SheetJS (spreadsheet import/export library)

| | |
|---|---|
| Version | 0.20.3 (official SheetJS Community Edition release; replaces 0.18.5 from a CDN, which has published advisories for reading crafted files) |
| Source | `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js` — the authoritative source per the SheetJS docs |
| SHA-256 | `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41` (identical to `package/dist/xlsx.full.min.js` in the official tarball, tarball SHA-256 `8dc73fc3…99fe8`) |
| SRI | `sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT` |
| Licence | Apache-2.0, `vendor/sheetjs/0.20.3/LICENSE`, shipped next to the script |
| Record | `vendor/sheetjs/0.20.3/VENDOR.json` |

- Served from the site itself (`/vendor/sheetjs/0.20.3/xlsx.full.min.js`) with
  an `integrity` attribute; the CSP allows `'self'` for it and no SheetJS CDN.
  Same-origin responses are either static files or JSON with `nosniff`.
- `build.sh` verifies the file against `VENDOR.json` (size, SHA-256, SRI)
  before copying it into `dist/`; `check-static-output.mjs` fails the build if
  the page loads SheetJS from anywhere else, if the integrity attribute or the
  copied file differ, if the licence is missing, or if the CSP still allows a
  SheetJS CDN. `.gitattributes` keeps `vendor/**` byte-exact (no line-ending
  conversion).
- To upgrade: download the new official release, replace the folder
  (`vendor/sheetjs/<version>/`), update `VENDOR.json` and the `<script>` tag;
  the build refuses any mismatch.
- Compatibility: every spreadsheet the dashboard can import (all fixtures and
  every private sample file) reads cell-for-cell the same with 0.18.5 and
  0.20.3 through the page's exact read call (`tools/sheetjs-parity.mjs`). The
  only difference seen is in a file the dashboard does not import (the
  Products Master workbook): line breaks inside multi-line cells come back as
  LF instead of CRLF.

## 8. Remaining risks

- Chart.js is still loaded from a pinned CDN URL without an SRI hash (it
  reads no data files); vendoring it the same way as SheetJS is a small
  follow-up.
- Views still build HTML strings with `innerHTML`; every untrusted field found is
  escaped and the hostile-data browser check covers all tabs and drill-downs,
  but a NEW view that forgets to escape would rely on the CSP alone.
- A browser closed without signing out keeps hand uploads in its storage (by
  design) and the session cookie until it expires (12 h by default).
- The global failure limit lets an attacker lock out sign-in for 15 minutes.
- Sign-in depends on the Worker being reachable (attempt counters); if not,
  sign-in is refused rather than unlimited.
- Revoked-session records are not pruned (small; expire logically).
- A signed-in viewer can read all revenue history: list only people who may
  see it. Sign-in depends on Google (an outage at Google means no new
  sign-ins; existing sessions keep working until they expire).
- Access follows the Google account: if a listed person's Google account is
  compromised, so is their dashboard access — encourage 2-step verification.
