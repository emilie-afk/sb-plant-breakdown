# Sales analytics: Shopify, Amazon, vendors, shared imports

This is how the product breakdown, vendor analytics, shared storage and the Windows collector fit together, and the conventions they follow.

## Run it locally

```
node --test tests/*.test.mjs          # no dependencies; uses synthetic fixtures only
node tools/devserver.mjs 8778         # then open http://127.0.0.1:8778
node tools/make-sample-fixtures.mjs   # regenerate the synthetic fixtures
```

`tools/devserver.mjs` and `tools/local-worker.mjs` are development conveniences. They are not part of the Netlify build.

## Architecture

`app.js` is unchanged. New files load after it and replace a few globals (`parseShopify`, `handleFile`, `renderTab`, `parseAmazon`, `addSnapshot`). External Stores, Cross-channel, Owned vs Market and Opportunity Map keep running against the code they were written for.

| File | Role |
|---|---|
| `shopify-report.js` | Header-based parser for "Total sales by product" (optionally with Product ID and Sales channel); the change formula; snapshot shape; legacy lifting; re-import and overlap rules; channel totals. No DOM. |
| `amazon-parse.js` | Header-based parser for Amazon metric-data exports (known layouts plus a confirmed column mapping for new ones). No DOM. |
| `amazon-report.js` | Amazon snapshots in the shared record shape; comparison matched on ASIN, then title. No DOM. |
| `product-grouping.js` | Classification, overrides, suspicion flags, exclusions, scope, channel filtering and merging, aggregation, pagination. No DOM. |
| `catalog-join.js` | Conservative join of sales rows to a storefront catalog snapshot. No DOM. |
| `shared-sync.js` | Conversion between browser snapshots and shared reports; import status; which report opens by default; collection health. No DOM. |
| `period-engine.js` | Months, quarters and years from one non-overlapping set of monthly reports; coverage, gaps, comparisons, aggregation. No DOM. |
| `breakdown-ui.js` | Formatting, the percentage convention, data-driven tables, pagination controls, CSV. |
| `classification-review.js` | The "classifications to review" panel and the override store. |
| `shopify-views.js`, `amazon-views.js` | Shopify, Vendors and Amazon tabs. |
| `data-imports-view.js` | Automatic loading of the latest saved report, the status strip above the analysis, and the ⚙ Data settings panel (connection, report history and downloads, import history, uploads, snapshots, shared settings, troubleshooting). |
| `period-view.js` | The Month / Quarter / Year selector and comparison choice above the Shopify, Vendors and Amazon analysis. |
| `channel-guard.js` | Keeps the older cross-channel tabs from counting marketplace orders twice. |
| `worker/` | Cloudflare Worker + D1: ingest, report history, settings. |
| `collector/` | Windows collector that exports the saved Shopify report and uploads it. |

Both channels run through `product-grouping.js`: charts, group tables, drill-downs, comparisons, rankings, product tables and exports.

## The percentage-change convention

```
percentage change = (current − prior) ÷ |prior| × 100
```

The absolute value in the denominator is deliberate. It is what Shopify's own export does, and it only differs from `current / prior − 1` when the prior figure is negative. That happens whenever a period's only activity on a product was a refund.

| prior | current | this formula | `current/prior − 1` | shown as |
|---|---|---|---|---|
| 100.00 | 150.00 | **+50.0%** | +50.0% | +$50.00 (+50.0%) |
| 100.00 | 0.00 | **−100.0%** | −100.0% | −$100.00 (−100.0%) |
| −20.00 | 0.00 | **+100.0%** | −100.0% | +$20.00 (+100.0%) |
| −100.00 | −200.00 | **−100.0%** | +100.0% | −$100.00 (−100.0%) |
| 0.00 | 25.00 | no percentage | ÷0 | "New / no prior sales", +$25.00 |
| 0.00 | 0.00 | no percentage | ÷0 | — |
| not captured | 25.00 | no percentage | — | "no prior period" |

A dollar (or unit) change is shown beside every percentage, in every card, table and CSV.

## Classification

Every record lands in exactly one primary group, so group totals reconcile to the included source total:

1. An explicit **override** wins.
2. A non-plant **imported product type** is decisive. A gift containing a succulent is a Gift, counted once.
3. A plant product type uses genus detection. Where that fails, the record is `Unidentified plant` (group type *Genus*), which is a different group from `Unclassified` (*Product category*).
4. With no usable product type (every Amazon row, and any blank Shopify type), the title decides, in this order: genus, then category rules, then "pack of something", then "a plant we cannot name", then Unclassified.

Product tables and exports show the **imported product type** (never rewritten) and the **analytics group** (which an override may change) side by side.

The "classifications to review" panel lists rows where the imported type disagrees with the title. A composite type (gift, kit, subscription) over a component title is not flagged.

## Sales channels and marketplace orders

When marketplace orders are synced into Shopify (here through Sellbrite), Shopify reports already contain them:

- **Splitting by channel.** If the saved report also groups by **Sales channel**, the Shopify and Vendors tabs offer a channel filter: own store (default), marketplace via Sellbrite, or all channels. A product's channel rows are merged only when a scope spans several channels, so totals never change.
- **Cross-channel tabs.** These read Shopify as own store only, so marketplace orders are counted once, from the Amazon report.
- **Reports without the channel column.** When the period reaches the configured sync start date (`SHOPIFY_AMAZON_VIA_SHOPIFY_SINCE` in `shopify-report.js`), the dashboard says the report includes marketplace orders and cannot separate them.
- **The Amazon tab.** It shows the Sellbrite rows of a Shopify report for the same period beside the Seller Central figures, as a cross-check that is never summed.

## Opening the dashboard

- **No file needed.** After the site password, the dashboard connects to shared storage (with the read-only key built into the encrypted page, or a key entered once under Data settings), opens the newest saved Shopify report and shows it.
- **Status strip.** Above the Shopify and Vendors analysis: the sales period (store dates, month to date marked partial), the report's revision and when it was collected and imported, the last successful collection ("Last updated"), and any collection or refresh failure. A failure never replaces the last successful analysis.
- **Data settings** (button, not a tab): connection, report history, import history, manual upload (Amazon's normal route, Shopify's fallback), snapshots and backup, catalog notes and troubleshooting.

## Periods: month, quarter, year

| Rule | How |
|---|---|
| One report per month | the active (latest successful) revision of the full-month report, otherwise the newest month-to-date report. Older month-to-date copies, superseded revisions, quarter or custom-range reports are kept but never combined. |
| Quarters and years | Q1 Jan–Mar, Q2 Apr–Jun, Q3 Jul–Sep, Q4 Oct–Dec; built from those monthly reports. The revisions used are listed. |
| Missing months | missing, never zero: the period is labelled partial and the months are named. |
| Running periods | month to date, quarter to date, year to date, with the actual coverage dates. |
| Sums | units, gross sales, discounts, returns, net, taxes, total and glance views are summed. |
| Derived figures | average per unit = combined net ÷ combined units; conversion = combined units ÷ combined glance views; percentage change from the combined totals. |
| Products | counted once across the whole period (by product id, otherwise title + vendor + type). |
| Inventory | point in time: the latest report's figure, with its date; never summed. |
| Comparison | previous equivalent period, or the same period last year, from stored reports covering the same days. A month-to-date part needs a stored report for exactly the shifted dates. For a single month with no such report, Shopify's own previous-period columns inside that one report are shown, with their dates. Embedded previous-period columns are never added across months. |
| Filters | vendor, product type, group (genus / category), channel and plant scope apply to the combined period exactly as to one report. |

## The key built into the page

`build.sh` refuses to build unless `SB_SHARED_KEY` is the Worker's **read-only viewer key**. Before inlining, `tools/check-viewer-key.mjs` asks the Worker (without writing anything): a settings write with an empty body must be refused with 403 and a report listing must succeed. The collector key fails the listing; the dashboard key gets 400 instead of 403. After StatiCrypt, the build checks that the output is encrypted and that neither the key nor app code appears in plain text. The unencrypted intermediate file lives only in a temp folder that is always deleted, and `dist/` and `_work/` are git-ignored.

Anyone who knows the site password can unlock the page and extract the viewer key. With it they can read report history, nothing more.

## Report history

Each stored report keeps: source and scope, sales period, timezone and currency, collection time, successful-import time, revision, partial / complete, totals and (when the importer computed them) the included and excluded totals. Re-collecting a period with different figures adds a revision and keeps the earlier one; identical figures write nothing (they only update "last confirmed", and mark the report complete if its period has since ended). Failed imports leave the active revision in place. Every revision can be opened or downloaded as CSV from Data settings → Report history.

## Known limits of the data sources

**Shopify "Total sales by product":**

- **Identity.** It has no SKU, no variant id and no daily dates. Without the optional Product ID column, the identity is `title + vendor + product type`, recorded per record as `identityBasis`. A rename breaks the link to prior periods, so a missing prior reads "New / no prior sales", never "confirmed new".
- **Rows.** Rows are products, not variants.
- **Periods.** Only periods covered by a saved report can be selected. Comparison dates are stated at import.

**Amazon metric data:**

- **Missing fields.** It has no vendor and no product type ("(not in Amazon export)").
- **Revenue.** Revenue, when present, is **ordered** revenue paired with ordered units. Shipped revenue is kept separately.
- **Inventory.** An inventory column that is zero on every row is treated as not reported.
- **Format changes.** A changed layout is detected by its header signature and needs a person to confirm a column mapping. Nothing is guessed.

**Storefront catalog (`/products.json`):**

- **Scope.** Only products published to the Online Store appear.
- **SKUs.** SKUs are not unique, so they are never used as a key.
- **How matches are made.**
  - Sales rows match by product id, otherwise by a **unique** exact title + vendor.
  - Ambiguous rows stay visible and need an approved mapping.
  - Fuzzy similarity only produces suggestions.
  - Product-level sales are never split across variants.

## Shared storage (`worker/`)

- **Keys.**
  - The collector key may only add reports, record a failed collection and read which periods are stored (dates only).
  - The dashboard key reads, uploads manually and edits shared settings.
  - The optional viewer key only reads; it is the one built into the encrypted dashboard page.
- **Re-imports.**
  - A re-upload of identical content is recognised by its content hash and writes nothing.
  - A new upload for the same scope and period is staged, then activated atomically as the next revision.
  - If it fails, the previous active report stays in place and the failure is recorded in the import history.
- **Overlaps.** Overlapping periods are stored as separate reports and never summed.
- **Privacy.** Payloads with customer-looking fields are refused.
- **Browser data.** Browser snapshots stay in the browser until a person uploads them. Uploading never deletes them.

## Windows collector (`collector/`)

See `collector/README.md`. It exports the saved report through the normal report screen, checks the file against the page's Summary row and against the parser before uploading, and keeps refused uploads in a local quarantine for a retry.

### What changes what

| Command | Effect |
|---|---|
| `npx wrangler@3 d1 create sb-plant-breakdown` | **creates** the D1 database |
| `npx wrangler@3 d1 migrations apply sb-plant-breakdown --remote` | **creates/migrates** the tables |
| `worker/setup-cloudflare.ps1` | **deploys** the Worker, **generates and replaces** both Worker keys (Cloudflare secrets + Windows Credential Manager), points the local collector config at the Worker |
| `worker/update-worker.ps1 [-AddOrigin https://…]` | **applies** pending migrations, optionally **adds** a browser origin, **deploys** the Worker, and **creates** the read-only viewer key only if none exists (or re-sets the stored one if the Worker rejects it). Does not rotate the other keys. Ends with `verify-worker.ps1` and exits nonzero if any check fails. |
| `worker/verify-worker.ps1 -Url https://…` | changes nothing: health ok, `/v1/reports` without a key → 401, the stored viewer key → 200, report-history fields present, viewer writes → 403, collector coverage → 200 |
| `collector/windows/check-task.ps1` | changes nothing: task state, trigger, next run, last result, and whether the last run was a **verified scheduled run** (started by the trigger, result 0, collector exit 0) or one started by hand |
| `node tools/acceptance-live.mjs https://<site>` | changes nothing: a fresh visible Chrome, a person types the site password, then automatic checks of auto-load, history, CSV, quarter/year totals, missing months and reload |
| Netlify env `SB_SHARED_URL`, `SB_SHARED_KEY` | build the Worker address and the **read-only** viewer key into the encrypted page, so browsers load reports without a key |
| `collector/windows/install-task.ps1 -At HH:mm -Apply` | **installs** the daily scheduled task (without `-Apply` it only prints the proposal; `-Uninstall` removes it) |
| `collector/windows/run-task.ps1` | what the scheduled task runs: one collection, logged locally |
| `npm run login` (in `collector/`) | opens a normal browser window for a person to sign in to Shopify once |

None of these run as part of the tests or the Netlify build.

## Tests and fixtures

Every fixture in `tests/fixtures/` is **synthetic**, generated by `tools/make-sample-fixtures.mjs` (seeded and deterministic). Stores, vendors, products, figures, product ids and ASINs are all invented. They reproduce the layouts the parsers must handle:

- **Shopify built-in report:** the repeated `(previous_period)` headers, the trailing-space percentage block, blank types, duplicate titles across vendors, negative rows and a refund-only prior.
- **Shopify saved-report variants:** the ID and channel layouts.
- **Amazon metric data:** v1 and v2 layouts with Amazon's Total line.
- **Catalog:** a slimmed storefront catalog with duplicate title + vendor pairs and repeated SKUs.

`tests/fixtures/sample-facts.json` holds the expected figures, computed by the generator from its own model, not by the code under test.

Acceptance against real exports is done locally, outside the repository.
