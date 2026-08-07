// ============================================================
// STATE
// ============================================================
const STORAGE_KEY = "sb-analyzer-snapshots-v1";
const STORAGE_KEY_LZ = STORAGE_KEY + "-lz";
let snapshots = loadSnapshots();
let activeTab = "amazon";
let state = {
  topPlants: {amazon: {threshold: 500, sortCol: null, sortDir: "desc"}, shopify: {threshold: 500, sortCol: null, sortDir: "desc"}},
  crossSort: {col: 3, dir: 'desc'},   // column index, direction
  genusSort: {amazon: {col: 5, dir: 'desc'}, shopify: {col: 3, dir: 'desc'}},
  drillSort: {amazon: {col: 7, dir: 'desc'}, shopify: {col: 4, dir: 'desc'}},
  amazon: { snapshotId: null, mode: "single", compareId: null, drillGenus: null, drillFilter: "ge100", alertTab: "oos", chart: null },
  shopify: { snapshotId: null, mode: "single", compareId: null, drillGenus: null, drillFilter: "ge100", chart: null },
  cross:   { amazonId: null, shopifyId: null, chart: null }
};
let showNonPlant = false;

// ============================================================
// SNAPSHOT STORAGE
// ============================================================
function loadSnapshots(){
  // Try LZ compressed first; on any failure, fall back to legacy raw key.
  try {
    const lz = localStorage.getItem(STORAGE_KEY_LZ);
    if (lz && typeof LZString !== "undefined") {
      try {
        const raw = LZString.decompressFromUTF16(lz);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length) return parsed;
        }
      } catch(inner) { console.warn("LZ decompression failed, trying legacy:", inner); }
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch(e){ console.warn("Failed to load snapshots:", e); return []; }
}
function _snapshotSize(s) {
  try { return LZString.compressToUTF16(JSON.stringify(s)).length * 2; }
  catch(e) { return JSON.stringify(s).length * 2; }
}
function saveSnapshots(){
  const json = JSON.stringify(snapshots);
  const lzOk = (typeof LZString !== "undefined");
  const packed = lzOk ? LZString.compressToUTF16(json) : null;
  try {
    if (packed) {
      localStorage.setItem(STORAGE_KEY_LZ, packed);
      // VERIFY the round-trip actually restores the same data before wiping legacy.
      // Only remove legacy if we can confirm the LZ blob is decodable.
      let verified = false;
      try {
        const check = LZString.decompressFromUTF16(localStorage.getItem(STORAGE_KEY_LZ));
        if (check === json) verified = true;
      } catch(_){}
      if (verified) {
        try { localStorage.removeItem(STORAGE_KEY); } catch(_) {}
      } else {
        // LZ round-trip failed — keep legacy raw as authoritative backup
        try { localStorage.setItem(STORAGE_KEY, json); } catch(_) {}
      }
    } else {
      localStorage.setItem(STORAGE_KEY, json);
    }
  } catch(e){
    // Diagnose: find biggest snapshot(s)
    const sizes = snapshots.map(s => ({
      id: s.id, source: s.source, label: s.label,
      skus: (s.products || []).length,
      kb: Math.round(_snapshotSize(s) / 1024)
    })).sort((a, b) => b.kb - a.kb);
    const biggest = sizes.slice(0, 3).map(s =>
      `- ${s.source} ${s.label} (${s.skus} SKUs, ~${s.kb} KB)`).join("\n");
    alert(
      "Browser storage is full — this snapshot couldn't be saved.\n\n" +
      "Your 3 biggest snapshots are:\n" + biggest + "\n\n" +
      "Delete one of the large ones (usually the External Stores line-item file) to make room."
    );
  }
}
function addSnapshot(snap){
  // Remove any existing with same source + label (replace)
  snapshots = snapshots.filter(s => !(s.source === snap.source && s.label === snap.label));
  snapshots.push(snap);
  saveSnapshots();
}
function deleteSnapshot(id){
  snapshots = snapshots.filter(s => s.id !== id);
  saveSnapshots();
}
function snapshotsFor(source){
  // Catalog snapshots are excluded from period pickers (they're always-on lookups, not periods).
  return snapshots.filter(s => s.source === source && !s.isCatalog).sort((a,b) => b.endDate.localeCompare(a.endDate));
}
function catalogSnapshots(){
  return snapshots.filter(s => s.isCatalog);
}

// ============================================================
// FILE PARSING
// ============================================================
async function readFile(file){
  const buf = await file.arrayBuffer();
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv")) {
    const text = new TextDecoder("utf-8").decode(buf);
    return XLSX.read(text, {type: "string"});
  }
  return XLSX.read(buf);
}
function parseDates(name){
  // ISO format first: YYYY-MM-DD
  const iso = name.match(/(\d{4}-\d{2}-\d{2})/g);
  if (iso) {
    if (iso.length >= 2) return [iso[0], iso[iso.length-1]];
    return [iso[0], iso[0]];
  }
  // Month-name format: "Jun 1-30", "Jun 1 -30", "Jun 1 - 30", "Jun 1-Jun 30", "Jun 1-Jul 15"
  // Also handles "May 1-31 2026" or "Jun 1-30 2026"
  const monthMap = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const pad = n => String(n).padStart(2, '0');
  // Try: MonthName D[-|to] [MonthName] D [YYYY]
  const m2 = name.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*(\d{1,2})\s*(?:-|to|–|—)\s*(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*)?(\d{1,2})(?:[,\s]+(\d{4}))?/i);
  if (m2) {
    const sMonth = monthMap[m2[1].toLowerCase().slice(0,3)];
    const sDay = parseInt(m2[2], 10);
    const eMonth = m2[3] ? monthMap[m2[3].toLowerCase().slice(0,3)] : sMonth;
    const eDay = parseInt(m2[4], 10);
    const year = m2[5] ? parseInt(m2[5], 10) : new Date().getFullYear();
    return [`${year}-${pad(sMonth)}-${pad(sDay)}`, `${year}-${pad(eMonth)}-${pad(eDay)}`];
  }
  return [null, null];
}
// Format a JS Date as local YYYY-MM-DD (never UTC — avoids the "last month starts May 31" bug)
function toLocalYMD(d){
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function labelFromDates(start, end){
  if (!start) return "unknown period";
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  if (sy === ey && sm === em) return `${months[sm-1]} ${sy}`;
  if (sy === ey) return `${months[sm-1]}–${months[em-1]} ${sy}`;
  return `${start} to ${end}`;
}
function parseAmazon(rows, ws){
  const products = [];
  const header = (rows[0] || []).map(x => String(x || '').toLowerCase().trim());
  // Detect format
  const isBusinessReport = header.some(h => h.includes('sessions - total')) ||
                            header.some(h => h.includes('(child) asin'));
  const isMetricData = header.some(h => h.includes('glance views')) &&
                        header.some(h => h.includes('available inventory'));

  function asinFromCell(cellRef){
    if (!ws) return "";
    const c = ws[cellRef];
    if (!c) return "";
    if (c.f){
      const m = c.f.match(/[A-Z0-9]{10}/g);
      if (m && m.length) return m[m.length - 1];
    }
    for (const k of ['v','w','h']){
      if (c[k] && typeof c[k] === 'string'){
        const m = c[k].match(/\b[A-Z0-9]{10}\b/);
        if (m) return m[0];
      }
    }
    return "";
  }
  function num(x){
    if (typeof x === 'number') return x;
    if (x == null || x === '') return 0;
    const s = String(x).replace(/[,$\s]/g, '').replace(/%$/, '');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  // ============ Format 1: Business Report (22 cols, from Seller Central) ============
  if (isBusinessReport){
    // Columns: (Parent) ASIN | (Child) ASIN | Title | SKU | Sessions - Total | ...
    // Units Ordered = col 14, Unit Session % = col 16, Ordered Product Sales = col 18
    for (let i = 1; i < rows.length; i++){
      const r = rows[i]; if (!r) continue;
      // Skip empty/total rows
      const childAsin = String(r[1] || '').trim();
      const parentAsin = String(r[0] || '').trim();
      const title = String(r[2] || '').trim();
      if (!title && !childAsin) continue;
      if (title.toLowerCase() === 'total') continue;
      const asin = childAsin || parentAsin;
      const sessions = num(r[4]);          // Sessions - Total
      const pageViews = num(r[8]);         // Page Views - Total
      const glance = pageViews || sessions;  // Use page views if available, else sessions
      const units = num(r[14]);            // Units Ordered
      let conv = num(r[16]);               // Unit Session Percentage
      if (conv > 1) conv = conv / 100;     // Normalize percent → decimal
      const rev = num(r[18]);              // Ordered Product Sales
      const avg = units > 0 ? rev / units : 0;
      products.push({asin, title, glance, conv, units, avg, rev, inv: 0,
                     genus: detectGenus(title) || "(no genus)"});
    }
    return products;
  }

  // ============ Format 2: Original metric-data (8 cols) ============
  for (let i = 1; i < rows.length; i++){
    const r = rows[i]; if (!r) continue;
    if (String(r[0] || '').trim() === "Total") continue;
    const title = String(r[1] || "").trim();
    if (!title || title === "Item name") continue;
    const cellRef = XLSX.utils.encode_cell({c: 0, r: i});
    const raw = String(r[0] || '').trim();
    const asinFromCellRef = asinFromCell(cellRef);
    let asin = asinFromCellRef;
    if (!asin) {
      const m = raw.match(/[A-Z0-9]{10}/);
      asin = m ? m[0] : raw;
    }
    let glance = num(r[2]);
    let conv = num(r[3]);
    if (conv > 1) conv = conv / 100;
    const units = num(r[4]), avg = num(r[5]), rev = num(r[6]), inv = num(r[7]);
    products.push({asin, title, glance, conv, units, avg, rev, inv,
                   genus: detectGenus(title) || "(no genus)"});
  }
  return products;
}

function parseShopify(rows){
  function num(x){
    if (typeof x === 'number') return x;
    if (x == null || x === '') return 0;
    const s = String(x).replace(/[,$\s%]/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }
  const products = [];
  for (let i = 1; i < rows.length; i++){
    const r = rows[i]; if (!r) continue;
    const title = String(r[0] || '').trim();
    if (!title || title === "Total" || title === "Product title") continue;
    const units = num(r[3]), gross = num(r[4]), disc = num(r[5]);
    const ret = num(r[6]), net = num(r[7]), rev = num(r[9]);
    products.push({asin: "", title, units, gross, disc, ret, net, rev, avg: units ? rev/units : 0, glance: 0, conv: 0, inv: 0, genus: detectGenus(title) || "(no genus)"});
  }
  return products;
}

// Detect if the rows look like a Shopify products.csv catalog export (not a sales report).
// Catalog format has "Handle", "Title", "Variant SKU", "Variant Inventory Qty" columns.
function isShopifyCatalog(rows){
  if (!rows || !rows.length) return false;
  const header = rows[0].map(x => String(x || '').toLowerCase().trim());
  return header.includes('handle') && header.includes('title') &&
         (header.includes('variant sku') || header.includes('variant inventory qty'));
}

// Parse Shopify products.csv (catalog). One row per variant.
// Emits one product per unique (title, sku) pair with units=0 and rev=0
// (this is inventory, not sales). Marks each product with catalogOnly:true and inventory qty.
function parseShopifyCatalog(rows){
  const header = rows[0].map(x => String(x || '').trim());
  const idx = {}; header.forEach((h,i) => { idx[h.toLowerCase()] = i; });
  const col = names => { for (const n of names) if (n.toLowerCase() in idx) return idx[n.toLowerCase()]; return -1; };
  const iTitle = col(['Title']);
  const iSKU = col(['Variant SKU', 'SKU']);
  const iInv = col(['Variant Inventory Qty', 'Inventory Qty']);
  const iPub = col(['Published']);
  const iStatus = col(['Status']);
  const iHandle = col(['Handle']);
  const num = x => { const n = parseFloat(String(x||'').replace(/[,\s]/g,'')); return isNaN(n) ? 0 : n; };
  const seen = new Set();
  const products = [];
  let lastTitle = '';
  for (let i = 1; i < rows.length; i++){
    const r = rows[i]; if (!r) continue;
    // Shopify products.csv repeats blank title on variant rows — carry it forward
    let title = String(r[iTitle] || '').trim();
    if (!title) title = lastTitle;
    else lastTitle = title;
    if (!title) continue;
    const sku = iSKU >= 0 ? String(r[iSKU] || '').trim() : '';
    const inv = iInv >= 0 ? num(r[iInv]) : 0;
    const key = title + '||' + sku;
    if (seen.has(key)) continue;
    seen.add(key);
    // Skip unpublished / draft products
    if (iPub >= 0) {
      const p = String(r[iPub]||'').trim().toLowerCase();
      if (p === 'false' || p === 'no' || p === '0') continue;
    }
    if (iStatus >= 0) {
      const st = String(r[iStatus]||'').trim().toLowerCase();
      if (st === 'draft' || st === 'archived') continue;
    }
    products.push({
      asin: sku, sku: sku, title,
      units: 0, rev: 0, avg: 0, glance: 0, conv: 0,
      inv: inv,
      catalogOnly: true,
      genus: detectGenus(title) || "(no genus)"
    });
  }
  return products;
}

async function handleFile(source, file){
  if (!file) return;
  const dz = document.getElementById(`${source}-dropzone`);
  dz.classList.add("loading"); dz.querySelector(".dz-msg").textContent = "Processing…";
  try {
    const wb = await readFile(file);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, {header: 1, raw: true, defval: ""});
    let products;
    let isCatalog = false;
    if (source === "amazon") products = parseAmazon(rows, ws);
    else if (source === "shopify") {
      // Auto-detect Shopify catalog (products.csv) vs sales export
      if (isShopifyCatalog(rows)) {
        products = parseShopifyCatalog(rows);
        isCatalog = true;
      } else {
        products = parseShopify(rows);
      }
    }
    else if (source === "external") {
      // Detect the "with-stores" companion file (has StoreName + OrderNumber, no Item Name)
      if (isShipStationStoresCompanion(rows)) {
        const lookup = parseShipStationStoresCompanion(rows);
        const nOrders = Object.keys(lookup).length;
        const storeCounts = {};
        Object.values(lookup).forEach(v => { storeCounts[v.store] = (storeCounts[v.store]||0) + 1; });
        const summary = Object.entries(storeCounts).sort((a,b)=>b[1]-a[1])
          .map(([s,c]) => "  • " + s + ": " + c + " orders").join("\n");
        saveStoresCompanion(lookup);
        alert("Stores companion loaded: " + nOrders + " orders across:\n" + summary +
              "\n\nNow upload the matching Shipments export (with Item Name column) and rows will be auto-tagged with the correct store.");
        return;
      }
      products = parseShipStation(rows, file.name);
    }
    else throw new Error("Unknown source: " + source);
    if (!products.length) { alert("No data rows found in file."); return; }

    // Catalog is a permanent lookup — allow multiple files (each gets a unique id from filename)
    if (isCatalog) {
      const slug = String(file.name || "unnamed").toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 40);
      const snap = {
        id: "catalog_" + source + "_" + slug,
        source: source, label: "Catalog (" + source + ": " + file.name + ")",
        startDate: "0000-00-00", endDate: "9999-12-31",
        fileName: file.name,
        uploadedAt: new Date().toISOString(),
        isCatalog: true,
        products
      };
      addSnapshot(snap);
      const totalCatalogProducts = catalogSnapshots().reduce((n, s) => n + (s.products || []).length, 0);
      alert("Catalog loaded: " + products.length + " listings from " + file.name + ". Total across all catalog files: " + totalCatalogProducts + ".");
      renderTab(activeTab);
      return;
    }

    let [start, end] = parseDates(file.name);
    if (!start) {
      // Filename doesn't include a date range — prompt the user
      const period = await promptForPeriod(source, file.name);
      if (!period) return;  // user cancelled
      start = period.start; end = period.end;
    }
    const label = labelFromDates(start, end);
    const snap = {
      id: `${source}_${start}_${end}`,
      source, label, startDate: start, endDate: end,
      fileName: file.name,
      uploadedAt: new Date().toISOString(),
      products
    };
    addSnapshot(snap);
    state[source].snapshotId = snap.id;
    state[source].mode = "single";
    state[source].drillGenus = null;
    renderTab(source);
  } catch(e){
    console.error(e); alert("Couldn't parse file: " + (e.message || e));
  } finally {
    dz.classList.remove("loading"); dz.querySelector(".dz-msg").textContent = "📂 Drop file here, or click to browse";
  }
}

function promptForPeriod(source, filename, defaults){
  // Modal-style prompt for start/end dates. Returns {start, end} or null.
  return new Promise(resolve => {
    const today = toLocalYMD(new Date());
    const yearStart = today.slice(0,4) + '-01-01';
    const defStart = (defaults && defaults.start) || yearStart;
    const defEnd   = (defaults && defaults.end)   || today;
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:480px">
        <h2>Set the period for this ${source} file</h2>
        <p class="small">The filename <code>${filename || ''}</code> doesn't include a date range, so please pick the period this file covers.</p>
        <div style="margin:14px 0">
          <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px">Start date</label>
          <input type="date" id="prompt-start" value="${defStart}" style="padding:8px;border:1px solid var(--border);border-radius:6px;font-size:14px;width:100%">
        </div>
        <div style="margin:14px 0">
          <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px">End date</label>
          <input type="date" id="prompt-end" value="${defEnd}" style="padding:8px;border:1px solid var(--border);border-radius:6px;font-size:14px;width:100%">
        </div>
        <div class="small" style="margin-top:8px">
          Quick presets:
          <a href="#" data-preset="ytd" style="margin-left:6px">YTD</a>
          · <a href="#" data-preset="month">This month</a>
          · <a href="#" data-preset="lastmonth">Last month</a>
          · <a href="#" data-preset="lastyear">Last year (full)</a>
        </div>
        <div class="right" style="margin-top:18px">
          <button class="tab" id="prompt-cancel">Cancel</button>
          <button id="prompt-ok" style="margin-left:6px">Save period</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const cleanup = (val) => { modal.remove(); resolve(val); };
    modal.querySelector('#prompt-cancel').onclick = () => cleanup(null);
    modal.querySelector('#prompt-ok').onclick = () => {
      const s = modal.querySelector('#prompt-start').value;
      const e = modal.querySelector('#prompt-end').value;
      if (!s || !e) { alert('Please pick both a start and end date.'); return; }
      if (s > e) { alert('Start date must be before end date.'); return; }
      cleanup({start: s, end: e});
    };
    modal.addEventListener('click', e => { if (e.target === modal) cleanup(null); });
    modal.querySelectorAll('[data-preset]').forEach(a => a.onclick = ev => {
      ev.preventDefault();
      const t = new Date();
      const today = toLocalYMD(t);
      const y = t.getFullYear();
      const m = t.getMonth();
      let s, e;
      if (a.dataset.preset === 'ytd') { s = `${y}-01-01`; e = today; }
      else if (a.dataset.preset === 'month') {
        s = `${y}-${String(m+1).padStart(2,'0')}-01`; e = today;
      } else if (a.dataset.preset === 'lastmonth') {
        // Use local Date arithmetic then format as local YMD to avoid UTC offset shifting the day
        const lm = new Date(y, m-1, 1);
        const lme = new Date(y, m, 0);
        s = toLocalYMD(lm); e = toLocalYMD(lme);
      } else if (a.dataset.preset === 'lastyear') {
        s = `${y-1}-01-01`; e = `${y-1}-12-31`;
      }
      modal.querySelector('#prompt-start').value = s;
      modal.querySelector('#prompt-end').value = e;
    });
  });
}

async function editSnapshotPeriod(id){
  const snap = snapshots.find(s => s.id === id);
  if (!snap) return;
  const period = await promptForPeriod(snap.source, snap.fileName, {start: snap.startDate, end: snap.endDate});
  if (!period) return;
  // Delete the old, save with updated id/label/dates (keep the same products)
  snapshots = snapshots.filter(s => s.id !== id);
  const newSnap = {
    ...snap,
    id: `${snap.source}_${period.start}_${period.end}`,
    startDate: period.start, endDate: period.end,
    label: labelFromDates(period.start, period.end)
  };
  snapshots.push(newSnap);
  saveSnapshots();
  // Update any active state pointers
  for (const src of ['amazon','shopify','external']) {
    if (state[src] && state[src].snapshotId === id) state[src].snapshotId = newSnap.id;
    if (state[src] && state[src].compareId === id) state[src].compareId = newSnap.id;
  }
  if (state.cross.amazonId === id) state.cross.amazonId = newSnap.id;
  if (state.cross.shopifyId === id) state.cross.shopifyId = newSnap.id;
  if (state.oppmap && state.oppmap.amazonId === id) state.oppmap.amazonId = newSnap.id;
  if (state.oppmap && state.oppmap.shopifyId === id) state.oppmap.shopifyId = newSnap.id;
  if (state.oppmap && state.oppmap.externalId === id) state.oppmap.externalId = newSnap.id;
  openManage();
  renderTab(activeTab);
}

// ============================================================
// AGGREGATION
// ============================================================
function aggregateByGenus(products){
  const map = {};
  for (const p of products){
    const g = p.genus || "(no genus)";
    const a = map[g] || {genus: g, skus: 0, glance: 0, units: 0, rev: 0, inv: 0, items: []};
    a.skus++; a.glance += p.glance; a.units += p.units; a.rev += p.rev; a.inv += p.inv;
    a.items.push(p);
    map[g] = a;
  }
  for (const g of Object.values(map)){
    g.conv = g.glance > 0 ? g.units / g.glance : 0;
    g.avgPrice = g.units > 0 ? g.rev / g.units : 0;
  }
  return Object.values(map).sort((a,b) => b.rev - a.rev);
}

function buildComparison(curProds, priProds){
  // Join by title; produce per-genus and per-product comparisons
  const titles = new Set([...curProds.map(p=>p.title), ...priProds.map(p=>p.title)]);
  const curByTitle = Object.fromEntries(curProds.map(p => [p.title, p]));
  const priByTitle = Object.fromEntries(priProds.map(p => [p.title, p]));
  const products = [];
  for (const t of titles){
    const c = curByTitle[t] || {rev:0,units:0,glance:0};
    const p = priByTitle[t] || {rev:0,units:0,glance:0};
    const tpl = curByTitle[t] || priByTitle[t];
    products.push({
      t, asin: tpl.asin || "", g: tpl.genus || "(no genus)",
      ct: c.rev, pt: p.rev, ci: c.units, pi: p.units,
      d: c.rev - p.rev, pct: p.rev > 0 ? c.rev/p.rev - 1 : (c.rev > 0 ? 1 : 0)
    });
  }
  const gmap = {};
  for (const p of products){
    const a = gmap[p.g] || {genus: p.g, skus:0, ct:0, pt:0, ci:0, pi:0, items:[]};
    a.skus++; a.ct += p.ct; a.pt += p.pt; a.ci += p.ci; a.pi += p.pi;
    a.items.push(p);
    gmap[p.g] = a;
  }
  const genera = Object.values(gmap).map(g => ({
    ...g,
    d: g.ct - g.pt,
    pct: g.pt > 0 ? g.ct/g.pt - 1 : (g.ct > 0 ? 1 : 0)
  })).sort((a,b) => b.ct - a.ct);
  return {products, genera};
}

// ============================================================
// FORMATTERS
// ============================================================
const fmt$ = v => '$' + (Math.abs(v||0)).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmt$signed = v => (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtN = v => (v||0).toLocaleString('en-US');
const pctFmt = v => (v*100).toFixed(2) + '%';
function fmtAxis(v){
  if (v >= 1000) return '$' + (v/1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
  return '$' + Math.round(v);
}
function arrow(pct){
  if (pct > 0.005) return '<span class="up">▲</span>';
  if (pct < -0.005) return '<span class="down">▼</span>';
  return '<span class="flat">→</span>';
}
const deltaClass = v => v > 0 ? 'up' : v < 0 ? 'down' : 'flat';

// ============================================================
// RENDER (per-tab dispatch)
// ============================================================
function renderTab(source){
  if (source === "cross") return renderCross();
  if (source === "external") return renderExternal();
  if (source === "oppmap") return renderOppMap();
  if (source === "ovm") return renderOwnedVsMarket();
  const tabState = state[source];
  const snaps = snapshotsFor(source);
  // Render the snapshot picker
  renderSnapshotPicker(source, snaps);
  if (!tabState.snapshotId) {
    document.getElementById(`${source}-content`).style.display = 'none';
    document.getElementById(`${source}-empty`).style.display = 'block';
    return;
  }
  document.getElementById(`${source}-content`).style.display = 'block';
  document.getElementById(`${source}-empty`).style.display = 'none';
  const snap = snapshots.find(s => s.id === tabState.snapshotId);
  if (!snap) { tabState.snapshotId = null; renderTab(source); return; }

  if (tabState.mode === "compare" && tabState.compareId) {
    renderCompareView(source, snap);
  } else {
    renderSingleView(source, snap);
  }
}

function renderSnapshotPicker(source, snaps){
  const sel = document.getElementById(`${source}-snap-select`);
  sel.innerHTML = '<option value="">— Pick a snapshot —</option>' +
    snaps.map(s => `<option value="${s.id}" ${s.id === state[source].snapshotId ? 'selected' : ''}>${s.label} (${s.products.length} SKUs)</option>`).join('');
  const cmpSel = document.getElementById(`${source}-compare-select`);
  cmpSel.innerHTML = '<option value="">— None —</option>' +
    snaps.filter(s => s.id !== state[source].snapshotId).map(s => `<option value="${s.id}" ${s.id === state[source].compareId ? 'selected' : ''}>${s.label}</option>`).join('');
}

function renderSingleView(source, snap){
  document.getElementById(`${source}-mode-banner`).innerHTML =
    `<strong>${snap.label}</strong> · ${snap.products.length} SKUs · uploaded ${new Date(snap.uploadedAt).toLocaleDateString()}`;
  const genera = aggregateByGenus(snap.products);
  const totals = computeTotals(snap.products);
  renderCards(source, totals, false);
  renderChart(source, genera);
  renderGenusTable(source, genera, false);
  renderTopPlants(source, snap.products, snap, null);
  renderInsights(source, snap, null);
  if (source === "amazon") renderAlerts(source, snap.products);
  if (state[source].drillGenus) renderDrill(source, state[source].drillGenus, genera);
}

function renderCompareView(source, curSnap){
  const priSnap = snapshots.find(s => s.id === state[source].compareId);
  if (!priSnap) { state[source].mode = "single"; renderTab(source); return; }
  document.getElementById(`${source}-mode-banner`).innerHTML =
    `Comparing <strong>${curSnap.label}</strong> vs <strong>${priSnap.label}</strong>`;
  const cmp = buildComparison(curSnap.products, priSnap.products);
  const cur = computeTotals(curSnap.products);
  const pri = computeTotals(priSnap.products);
  renderCards(source, cur, true, pri);
  renderChartCompare(source, cmp.genera);
  renderGenusTable(source, cmp.genera, true);
  renderTopPlants(source, curSnap.products, curSnap, priSnap);
  renderInsights(source, curSnap, priSnap);
  if (source === "amazon") renderAlerts(source, curSnap.products);
  if (state[source].drillGenus) renderDrillCompare(source, state[source].drillGenus, cmp.genera);
}

function computeTotals(products){
  return {
    rev: products.reduce((s,p)=>s+p.rev, 0),
    units: products.reduce((s,p)=>s+p.units, 0),
    glance: products.reduce((s,p)=>s+p.glance, 0),
    skus: products.length,
    genera: new Set(products.map(p => p.genus).filter(g => g && g !== "(no genus)")).size
  };
}

function renderCards(source, t, isCompare, priT){
  const isAmazon = source === "amazon";
  let cards;
  if (isCompare){
    const dRev = t.rev - priT.rev;
    const pctRev = priT.rev > 0 ? dRev/priT.rev : 0;
    cards = [
      {label:'Current revenue', value: fmt$(t.rev), sub: arrow(pctRev) + ' ' + pctFmt(pctRev) + ' vs prior'},
      {label:'Prior revenue', value: fmt$(priT.rev), sub: ''},
      {label:'Δ revenue', value: fmt$signed(dRev), sub: '', cls: deltaClass(dRev)},
      {label:'SKUs (cur)', value: fmtN(t.skus), sub: ''}
    ];
  } else {
    cards = [
      {label:'Total revenue', value: fmt$(t.rev)},
      {label:'Total units', value: fmtN(t.units)},
      {label:'SKUs', value: fmtN(t.skus)},
      {label:'Plant genera', value: fmtN(t.genera)}
    ];
    if (isAmazon){
      cards.splice(2, 0, {label:'Glance views', value: fmtN(t.glance)});
      cards.splice(3, 0, {label:'Avg conversion', value: pctFmt(t.glance ? t.units/t.glance : 0)});
    }
  }
  document.getElementById(`${source}-cards`).innerHTML = cards.map(c =>
    `<div class="card"><div class="label">${c.label}</div><div class="value ${c.cls||''}">${c.value}</div>${c.sub?`<div class="sub">${c.sub}</div>`:''}</div>`).join('');
}

function renderChart(source, genera){
  const items = genera.filter(g => showNonPlant || g.genus !== '(no genus)').slice(0, 25);
  const ctx = document.getElementById(`${source}-chart`).getContext('2d');
  if (state[source].chart) state[source].chart.destroy();
  state[source].chart = new Chart(ctx, {
    type:'bar',
    data:{labels: items.map(g=>g.genus), datasets:[{data: items.map(g=>g.rev), backgroundColor:'#2e7d32'}]},
    options:{indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>fmt$(c.parsed.x)}}},
      scales:{x:{ticks:{callback:fmtAxis}}}}
  });
}
function renderChartCompare(source, genera){
  const items = genera.filter(g => showNonPlant || g.genus !== '(no genus)').slice(0, 25);
  const ctx = document.getElementById(`${source}-chart`).getContext('2d');
  if (state[source].chart) state[source].chart.destroy();
  state[source].chart = new Chart(ctx, {
    type:'bar',
    data:{labels: items.map(g=>g.genus), datasets:[
      {label:'Current', data: items.map(g=>g.ct), backgroundColor:'#2e7d32'},
      {label:'Prior',   data: items.map(g=>g.pt), backgroundColor:'#a5d6a7'}
    ]},
    options:{indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:true, position:'bottom'}, tooltip:{callbacks:{label:c=>c.dataset.label+': '+fmt$(c.parsed.x)}}},
      scales:{x:{ticks:{callback:fmtAxis}}}}
  });
}

function renderGenusTable(source, genera, isCompare){
  const isAmazon = source === "amazon";
  const tbody = document.getElementById(`${source}-genus-tbody`);
  const thead = document.getElementById(`${source}-genus-thead`);
  let cols, keys;
  if (isCompare){
    cols = ['Genus','SKUs','Units (cur)','Units (prior)','Revenue (cur)','Revenue (prior)','Δ $','Δ %'];
    keys = ['genus','skus','ci','pi','ct','pt','d','pct'];
  } else if (isAmazon){
    cols = ['Genus','SKUs','Glance','Units','Conv','Revenue','Inventory'];
    keys = ['genus','skus','glance','units','conv','rev','inv'];
  } else {
    cols = ['Genus','SKUs','Units','Revenue','Avg price'];
    keys = ['genus','skus','units','rev','avgPrice'];
  }
  if (!state.genusSort[source]) state.genusSort[source] = {col: cols.length - 1, dir: 'desc'};
  const sortRef = state.genusSort[source];
  thead.innerHTML = cols.map((c,i) => {
    const a = sortRef.col === i ? (sortRef.dir === 'desc' ? ' ▼' : ' ▲') : '';
    return `<th data-gs="${i}" class="${i===0?'':'num'}" style="cursor:pointer">${c}${a}</th>`;
  }).join('');
  // Sort genera by chosen key before rendering
  const key = keys[sortRef.col] || keys[cols.length - 1];
  genera = genera.slice().sort((a,b) => {
    let av = a[key], bv = b[key];
    if (typeof av === 'string'){ av=av.toLowerCase(); bv=(bv||'').toLowerCase(); }
    if (av < bv) return sortRef.dir === 'desc' ? 1 : -1;
    if (av > bv) return sortRef.dir === 'desc' ? -1 : 1;
    return 0;
  });
  const q = (document.getElementById(`${source}-genus-search`).value || '').trim().toLowerCase();
  let list = genera.slice();
  if (q) list = list.filter(g => g.genus.toLowerCase().includes(q));
  document.getElementById(`${source}-genus-count`).textContent = list.length + ' genera';
  tbody.innerHTML = list.map(g => {
    let cells;
    if (isCompare){
      cells = [g.genus, fmtN(g.skus), fmtN(g.ci), fmtN(g.pi), fmt$(g.ct), fmt$(g.pt),
        `<span class="${deltaClass(g.d)}">${g.d>=0?'+':'-'}${fmt$(Math.abs(g.d)).replace('$','$')}</span>`,
        `<span class="${deltaClass(g.d)}">${arrow(g.pct)} ${pctFmt(g.pct)}</span>`];
    } else if (isAmazon){
      cells = [g.genus, fmtN(g.skus), fmtN(g.glance), fmtN(g.units), pctFmt(g.conv), fmt$(g.rev),
        (g.inv === 0 && g.units > 0 ? '<span class="badge alert">0</span>' : fmtN(g.inv))];
    } else {
      cells = [g.genus, fmtN(g.skus), fmtN(g.units), fmt$(g.rev), fmt$(g.avgPrice)];
    }
    return `<tr class="clickable" data-genus="${g.genus.replace(/"/g,'&quot;')}">${
      cells.map((c,i)=>`<td class="${i===0?'':'num'}">${c}</td>`).join('')}</tr>`;
  }).join('');
  tbody.querySelectorAll('tr').forEach(tr =>
    tr.addEventListener('click', () => openDrill(source, tr.dataset.genus)));
  thead.querySelectorAll('[data-gs]').forEach(th => th.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const col = +th.dataset.gs;
    if (sortRef.col === col) sortRef.dir = sortRef.dir === 'desc' ? 'asc' : 'desc';
    else { sortRef.col = col; sortRef.dir = (col === 0 ? 'asc' : 'desc'); }
    renderTab(source);
  }));
}

function openDrill(source, genus){
  state[source].drillGenus = genus;
  document.getElementById(`${source}-drill`).style.display = 'block';
  document.getElementById(`${source}-drill-title`).textContent = `${genus} — plants in this genus`;
  renderTab(source);
  document.getElementById(`${source}-drill`).scrollIntoView({behavior:'smooth', block:'start'});
}
function closeDrill(source){
  state[source].drillGenus = null;
  document.getElementById(`${source}-drill`).style.display = 'none';
}

function renderDrill(source, genus, genera){
  const isAmazon = source === "amazon";
  const g = genera.find(x => x.genus === genus);
  if (!g) { closeDrill(source); return; }
  const filter = state[source].drillFilter;
  const q = (document.getElementById(`${source}-prod-search`).value || '').trim().toLowerCase();
  let items = g.items.slice().sort((a,b) => b.rev - a.rev);
  if (filter === 'ge100') items = items.filter(p => p.rev >= 100);
  if (q) items = items.filter(p => p.title.toLowerCase().includes(q));
  document.getElementById(`${source}-drill-count`).textContent = items.length + ' plants';
  const thead = document.getElementById(`${source}-prod-thead`);
  const tbody = document.getElementById(`${source}-prod-tbody`);
  let cols, render;
  if (isAmazon){
    cols = ['Rank','ASIN','Item','Glance','Conv','Units','Avg','Revenue'];
    const dKeys = [null, 'asin', 'title', 'glance', 'conv', 'units', 'avg', 'rev'];
    render = (p,i) => [i+1, p.asin, p.title, fmtN(p.glance), pctFmt(p.conv), fmtN(p.units), fmt$(p.avg), fmt$(p.rev)];
    var __drillKeys = dKeys;
  } else {
    cols = ['Rank','Title','Units','Avg','Revenue'];
    const dKeys = [null, 'title', 'units', 'avg', 'rev'];
    render = (p,i) => [i+1, p.title, fmtN(p.units), fmt$(p.avg), fmt$(p.rev)];
    var __drillKeys = dKeys;
  }
  if (!state.drillSort[source]) state.drillSort[source] = {col: cols.length - 1, dir: 'desc'};
  const dSort = state.drillSort[source];
  thead.innerHTML = cols.map((c,i)=> {
    const isText = isAmazon ? (i===1||i===2) : (i===1);
    const arrow = dSort.col === i ? (dSort.dir === 'desc' ? ' ▼' : ' ▲') : '';
    const clickable = __drillKeys[i] ? ' style="cursor:pointer"' : '';
    return `<th data-ds="${i}" class="${i===0||isText?'':'num'}"${clickable}>${c}${arrow}</th>`;
  }).join('');
  // Sort items by the chosen key (unless sorting by rank, which is meaningless)
  const dKey = __drillKeys[dSort.col];
  if (dKey){
    items.sort((a,b) => {
      let av = a[dKey], bv = b[dKey];
      if (typeof av === 'string'){ av=av.toLowerCase(); bv=(bv||'').toLowerCase(); }
      if (av < bv) return dSort.dir === 'desc' ? 1 : -1;
      if (av > bv) return dSort.dir === 'desc' ? -1 : 1;
      return 0;
    });
  }
  if (!items.length){
    tbody.innerHTML = `<tr><td colspan="${cols.length}" class="empty">No plants match this filter.</td></tr>`;
    return;
  }
  tbody.innerHTML = items.map((p,i) => {
    const cells = render(p,i);
    return `<tr>${cells.map((c,j) => {
      const isText = isAmazon ? (j===1||j===2) : (j===1);
      return `<td class="${j===0||isText?'':'num'}">${c}</td>`;
    }).join('')}</tr>`;
  }).join('');
  thead.querySelectorAll('[data-ds]').forEach(th => th.addEventListener('click', () => {
    const col = +th.dataset.ds;
    if (!__drillKeys[col]) return;
    if (dSort.col === col) dSort.dir = dSort.dir === 'desc' ? 'asc' : 'desc';
    else { dSort.col = col; dSort.dir = (col === 1 ? 'asc' : 'desc'); }
    renderTab(source);
  }));
}
function renderDrillCompare(source, genus, genera){
  const g = genera.find(x => x.genus === genus);
  if (!g) { closeDrill(source); return; }
  const filter = state[source].drillFilter;
  const q = (document.getElementById(`${source}-prod-search`).value || '').trim().toLowerCase();
  let items = g.items.slice();
  if (filter === 'ge100') items = items.filter(p => p.ct >= 100 || p.pt >= 100);
  if (q) items = items.filter(p => p.t.toLowerCase().includes(q));
  document.getElementById(`${source}-drill-count`).textContent = items.length + ' plants';
  const thead = document.getElementById(`${source}-prod-thead`);
  const tbody = document.getElementById(`${source}-prod-tbody`);
  const cols = ['Rank','Title','Cur units','Prior units','Cur $','Prior $','Δ $','Δ %'];
  const keys = [null, 't', 'ci', 'pi', 'ct', 'pt', 'd', 'pct'];
  if (!state.drillSort[source]) state.drillSort[source] = {col: 4, dir: 'desc'};
  const dSort = state.drillSort[source];
  if (dSort.col >= cols.length) dSort.col = 4; // clamp if user came from non-compare mode
  const sortKey = keys[dSort.col] || 'ct';
  items.sort((a,b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string'){ av = av.toLowerCase(); bv = (bv||'').toLowerCase(); }
    if (av < bv) return dSort.dir === 'desc' ? 1 : -1;
    if (av > bv) return dSort.dir === 'desc' ? -1 : 1;
    return 0;
  });
  thead.innerHTML = cols.map((c,i) => {
    const arrow = dSort.col === i ? (dSort.dir === 'desc' ? ' ▼' : ' ▲') : '';
    const clickable = keys[i] ? ' style="cursor:pointer"' : '';
    return `<th data-dsc="${i}" class="${i===0||i===1?'':'num'}"${clickable}>${c}${arrow}</th>`;
  }).join('');
  if (!items.length){
    tbody.innerHTML = `<tr><td colspan="${cols.length}" class="empty">No plants match this filter.</td></tr>`;
  } else {
    tbody.innerHTML = items.map((p,i) =>
      `<tr><td>${i+1}</td><td>${p.t}</td><td class="num">${fmtN(p.ci)}</td><td class="num">${fmtN(p.pi)}</td><td class="num">${fmt$(p.ct)}</td><td class="num">${fmt$(p.pt)}</td><td class="num ${deltaClass(p.d)}">${p.d>=0?'+':'-'}${fmt$(Math.abs(p.d))}</td><td class="num ${deltaClass(p.d)}">${arrow(p.pct)} ${pctFmt(p.pct)}</td></tr>`).join('');
  }
  thead.querySelectorAll('[data-dsc]').forEach(th => th.addEventListener('click', () => {
    const col = +th.dataset.dsc;
    if (!keys[col]) return;
    if (dSort.col === col) dSort.dir = dSort.dir === 'desc' ? 'asc' : 'desc';
    else { dSort.col = col; dSort.dir = (col === 1 ? 'asc' : 'desc'); }
    renderTab(source);
  }));
}

// ============================================================
// AMAZON ALERTS
// ============================================================
function renderTopPlants(source, products, curSnap, priSnap){
  const tp = state.topPlants[source];
  const isAmazon = source === "amazon";
  const sec = document.getElementById(`${source}-top-plants`);
  if (!sec) return;

  // Build a "Prior revenue by title" map when in compare mode
  const priorByTitle = {};
  if (priSnap){
    for (const pp of priSnap.products) priorByTitle[pp.title] = pp;
  }
  const isCompare = !!priSnap;

  // Show which snapshot the panel is reflecting, at the top of the panel
  const label = curSnap ? curSnap.label : '';
  const compareLabel = isCompare ? ` vs ${priSnap.label}` : '';
  const hdr = document.getElementById(`${source}-tp-heading`);
  if (hdr) hdr.textContent = `High-revenue plants — ${label}${compareLabel}`;

  // Highlight the active threshold button
  document.querySelectorAll(`#${source}-top-plants [data-threshold]`).forEach(b =>
    b.classList.toggle('active', +b.dataset.threshold === tp.threshold));
  document.getElementById(`${source}-tp-custom`).value = tp.threshold;

  // Filter by CURRENT snapshot's revenue meeting the threshold
  let items = products.filter(p => p.rev >= tp.threshold).slice();
  // Attach prior + delta if we're comparing
  if (isCompare){
    for (const p of items){
      const pp = priorByTitle[p.title];
      p._priorRev = pp ? pp.rev : 0;
      p._priorUnits = pp ? pp.units : 0;
      p._delta = p.rev - p._priorRev;
      p._deltaPct = p._priorRev > 0 ? (p.rev - p._priorRev) / p._priorRev : (p.rev > 0 ? 1 : 0);
    }
  }

  // Sort
  const sortKey = tp.sortCol || 'rev';
  items.sort((a,b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string'){ av = av.toLowerCase(); bv = (bv||'').toLowerCase(); }
    if (av < bv) return tp.sortDir === 'desc' ? 1 : -1;
    if (av > bv) return tp.sortDir === 'desc' ? -1 : 1;
    return 0;
  });

  document.getElementById(`${source}-tp-count`).textContent = items.length + ' plants ≥ $' + tp.threshold;

  // Columns depend on channel + compare mode
  let cols;
  if (isCompare){
    cols = isAmazon
      ? [['ASIN','asin'],['Item name','title'],['Genus','genus'],['Type','type'],['Units','units'],['Cur $','rev'],['Prior $','_priorRev'],['Δ $','_delta'],['Δ %','_deltaPct']]
      : [['Plant title','title'],['Genus','genus'],['Type','type'],['Units','units'],['Cur $','rev'],['Prior $','_priorRev'],['Δ $','_delta'],['Δ %','_deltaPct']];
  } else {
    cols = isAmazon
      ? [['ASIN','asin'],['Item name','title'],['Genus','genus'],['Type','type'],['Glance','glance'],['Conv','conv'],['Units','units'],['Avg','avg'],['Revenue','rev']]
      : [['Plant title','title'],['Genus','genus'],['Type','type'],['Units','units'],['Avg','avg'],['Revenue','rev']];
  }

  const isTextIdx = (i) => {
    if (isCompare){
      return isAmazon ? (i===0||i===1||i===2||i===3) : (i===0||i===1||i===2);
    }
    return isAmazon ? (i===0||i===1||i===2||i===3) : (i===0||i===1||i===2);
  };

  const thead = document.getElementById(`${source}-tp-thead`);
  thead.innerHTML = cols.map(([c, k], i) => {
    const active = (tp.sortCol || 'rev') === k;
    const a = active ? (tp.sortDir === 'desc' ? ' ▼' : ' ▲') : '';
    return `<th data-tpk="${k}" class="${isTextIdx(i)?'':'num'}" style="cursor:pointer">${c}${a}</th>`;
  }).join('');

  const tbody = document.getElementById(`${source}-tp-tbody`);
  if (!items.length){
    tbody.innerHTML = `<tr><td colspan="${cols.length}" class="empty">No plants ≥ $${tp.threshold}. Lower the threshold to see more.</td></tr>`;
  } else {
    tbody.innerHTML = items.map(p => {
      const t = getType(p.genus);
      const tBadge = t ? `<span class="badge ${t === 'Succulent' ? 'shopify' : (t === 'Air Plant' ? 'airplant' : 'amazon')}">${t}</span>` : '';
      let cells;
      if (isCompare){
        const dClass = p._delta > 0 ? 'up' : p._delta < 0 ? 'down' : 'flat';
        cells = isAmazon
          ? [p.asin, p.title, p.genus, tBadge, fmtN(p.units), fmt$(p.rev), fmt$(p._priorRev),
             `<span class="${dClass}">${(p._delta>=0?'+':'-')}${fmt$(Math.abs(p._delta))}</span>`,
             `<span class="${dClass}">${arrow(p._deltaPct)} ${pctFmt(p._deltaPct)}</span>`]
          : [p.title, p.genus, tBadge, fmtN(p.units), fmt$(p.rev), fmt$(p._priorRev),
             `<span class="${dClass}">${(p._delta>=0?'+':'-')}${fmt$(Math.abs(p._delta))}</span>`,
             `<span class="${dClass}">${arrow(p._deltaPct)} ${pctFmt(p._deltaPct)}</span>`];
      } else {
        cells = isAmazon
          ? [p.asin, p.title, p.genus, tBadge, fmtN(p.glance), pctFmt(p.conv), fmtN(p.units), fmt$(p.avg), fmt$(p.rev)]
          : [p.title, p.genus, tBadge, fmtN(p.units), fmt$(p.avg), fmt$(p.rev)];
      }
      return `<tr>${cells.map((c,j) => {
        return `<td class="${isTextIdx(j)?'':'num'}">${c}</td>`;
      }).join('')}</tr>`;
    }).join('');
  }

  thead.querySelectorAll('[data-tpk]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.tpk;
    if (tp.sortCol === k) tp.sortDir = tp.sortDir === 'desc' ? 'asc' : 'desc';
    else { tp.sortCol = k; tp.sortDir = (k === 'title' || k === 'asin' || k === 'genus' || k === 'type') ? 'asc' : 'desc'; }
    renderTab(source);
  }));
}


function renderAlerts(source, products){
  const tab = state[source].alertTab || 'oos';
  let list, cols, cells;
  if (tab === 'oos'){
    list = products.filter(p => p.inv === 0 && p.glance >= 50).sort((a,b) => b.glance - a.glance);
    cols = ['ASIN','Item','Genus','Glance','Units','Revenue'];
    cells = p => [p.asin, p.title, p.genus, fmtN(p.glance), fmtN(p.units), fmt$(p.rev)];
  } else {
    list = products.filter(p => p.glance >= 200 && p.conv < 0.01).sort((a,b) => b.glance - a.glance);
    cols = ['ASIN','Item','Genus','Glance','Conv','Units','Avg'];
    cells = p => [p.asin, p.title, p.genus, fmtN(p.glance), pctFmt(p.conv), fmtN(p.units), fmt$(p.avg)];
  }
  document.getElementById(`${source}-alerts-count`).textContent = list.length + ' items';
  const thead = document.getElementById(`${source}-alerts-thead`);
  const tbody = document.getElementById(`${source}-alerts-tbody`);
  thead.innerHTML = cols.map((c,i) => `<th class="${i<=2?'':'num'}">${c}</th>`).join('');
  if (!list.length){
    tbody.innerHTML = `<tr><td colspan="${cols.length}" class="empty">No items match this alert.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(p => {
    const cs = cells(p);
    return `<tr>${cs.map((c,i) => `<td class="${i<=2?'':'num'}">${c}</td>`).join('')}</tr>`;
  }).join('');
}

// ============================================================
// DOWNLOAD CLEAN DATA
// ============================================================
function downloadTopPlants(source){
  const tabState = state[source];
  if (!tabState.snapshotId) return;
  const snap = snapshots.find(s => s.id === tabState.snapshotId);
  if (!snap) return;
  const tp = state.topPlants[source];
  const isAmazon = source === 'amazon';
  const items = snap.products.filter(p => p.rev >= tp.threshold)
    .slice().sort((a,b) => b.rev - a.rev);
  const rows = items.map(p => isAmazon
    ? {ASIN: p.asin, "Item name": p.title, Genus: p.genus, Type: getType(p.genus),
       "Glance views": p.glance, Conversion: p.conv,
       "Shipped units": p.units, "Avg price": +p.avg.toFixed(2),
       "Shipped revenue": +p.rev.toFixed(2), Inventory: p.inv}
    : {"Plant title": p.title, Genus: p.genus, Type: getType(p.genus),
       "Net items sold": p.units, "Avg price": +p.avg.toFixed(2),
       "Total sales": +p.rev.toFixed(2)});
  const ws = XLSX.utils.json_to_sheet(rows);
  const csv = XLSX.utils.sheet_to_csv(ws);
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${source}-top-plants-${tp.threshold}-${snap.startDate}-to-${snap.endDate}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadBreakdown(source){
  const tabState = state[source];
  if (!tabState.snapshotId) return;
  const snap = snapshots.find(s => s.id === tabState.snapshotId);
  if (!snap) return;
  const isAmazon = source === 'amazon';
  const genera = aggregateByGenus(snap.products);
  const wb = XLSX.utils.book_new();

  // Sheet 1: Genus summary
  const gRows = genera.map(g => isAmazon
    ? {Genus: g.genus, SKUs: g.skus, "Glance views": g.glance, "Shipped units": g.units,
       "Conversion rate": g.conv, "Shipped revenue": +g.rev.toFixed(2),
       "Avg price": +g.avgPrice.toFixed(2), "Available inventory": g.inv}
    : {Genus: g.genus, SKUs: g.skus, "Net items sold": g.units,
       "Total sales": +g.rev.toFixed(2), "Avg price": +g.avgPrice.toFixed(2)});
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(gRows), "Genus summary");

  // Sheet 2: All plants (every product, sorted by genus then revenue)
  const sortedProducts = snap.products.slice().sort((a,b) =>
    a.genus.localeCompare(b.genus) || b.rev - a.rev);
  const pRows = sortedProducts.map(p => isAmazon
    ? {ASIN: p.asin, "Item name": p.title, Genus: p.genus,
       "Glance views": p.glance, "Conversion": p.conv,
       "Shipped units": p.units, "Avg price": +p.avg.toFixed(2),
       "Shipped revenue": +p.rev.toFixed(2), "Inventory": p.inv}
    : {"Product title": p.title, Genus: p.genus,
       "Net items sold": p.units, "Gross sales": +(p.gross||0).toFixed(2),
       "Discounts": +(p.disc||0).toFixed(2), "Returns": +(p.ret||0).toFixed(2),
       "Net sales": +(p.net||0).toFixed(2), "Total sales": +p.rev.toFixed(2)});
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pRows), "All plants");

  // Per-genus sheets — top 25 plant genera (exclude "(no genus)")
  function safeName(n){ return String(n).replace(/[:\\/?*\[\]]/g, '_').slice(0, 31); }
  const top25 = genera.filter(g => g.genus !== '(no genus)').slice(0, 25);
  const usedNames = new Set();
  for (const g of top25){
    let name = safeName(g.genus);
    // Avoid duplicate sheet names (Excel disallows that)
    let n = 2;
    let base = name;
    while (usedNames.has(name.toLowerCase())){ name = (base + '_' + n).slice(0, 31); n++; }
    usedNames.add(name.toLowerCase());
    const items = g.items.slice().sort((a,b) => b.rev - a.rev);
    const rows = items.map((p, i) => isAmazon
      ? {Rank: i+1, ASIN: p.asin, "Item name": p.title,
         "Glance views": p.glance, Conversion: p.conv,
         "Shipped units": p.units, "Avg price": +p.avg.toFixed(2),
         "Shipped revenue": +p.rev.toFixed(2), Inventory: p.inv}
      : {Rank: i+1, "Product title": p.title,
         "Net items sold": p.units, "Gross sales": +(p.gross||0).toFixed(2),
         "Discounts": +(p.disc||0).toFixed(2), "Returns": +(p.ret||0).toFixed(2),
         "Net sales": +(p.net||0).toFixed(2), "Total sales": +p.rev.toFixed(2)});
    if (rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  }

  // Sheet 3+: Amazon alerts
  if (isAmazon){
    const oos = snap.products.filter(p => p.inv === 0 && p.glance >= 50)
      .sort((a,b) => b.glance - a.glance)
      .map(p => ({ASIN: p.asin, "Item name": p.title, Genus: p.genus,
                  "Glance views": p.glance, "Shipped units": p.units,
                  "Shipped revenue": +p.rev.toFixed(2)}));
    if (oos.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(oos), "OOS alerts");
    const lowConv = snap.products.filter(p => p.glance >= 200 && p.conv < 0.01)
      .sort((a,b) => b.glance - a.glance)
      .map(p => ({ASIN: p.asin, "Item name": p.title, Genus: p.genus,
                  "Glance views": p.glance, "Conversion": p.conv,
                  "Shipped units": p.units, "Avg price": +p.avg.toFixed(2)}));
    if (lowConv.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lowConv), "Low-conv alerts");
  }

  XLSX.writeFile(wb, `${source}-breakdown-${snap.startDate}-to-${snap.endDate}.xlsx`);
}

function downloadCross(){
  const aSnap = snapshots.find(s => s.id === state.cross.amazonId);
  const sSnap = snapshots.find(s => s.id === state.cross.shopifyId);
  if (!aSnap || !sSnap) return;
  const aG = aggregateByGenus(aSnap.products);
  const sG = aggregateByGenus(sSnap.products);
  const aMap = Object.fromEntries(aG.map(g => [g.genus, g]));
  const sMap = Object.fromEntries(sG.map(g => [g.genus, g]));
  const allG = new Set([...aG.map(g=>g.genus), ...sG.map(g=>g.genus)]);
  const rows = [];
  for (const g of allG){
    const a = aMap[g] || {rev:0, units:0};
    const s = sMap[g] || {rev:0, units:0};
    const combined = a.rev + s.rev;
    let dominant = '—';
    if (a.rev > 0 && s.rev === 0) dominant = 'Amazon only';
    else if (s.rev > 0 && a.rev === 0) dominant = 'Shopify only';
    else if (a.rev > s.rev * 1.1) dominant = `Amazon (${(a.rev/s.rev).toFixed(1)}x)`;
    else if (s.rev > a.rev * 1.1) dominant = `Shopify (${(s.rev/a.rev).toFixed(1)}x)`;
    else dominant = 'Balanced';
    rows.push({Genus: g, "Amazon $": +a.rev.toFixed(2), "Shopify $": +s.rev.toFixed(2),
               "Combined $": +combined.toFixed(2),
               "Amazon share": combined > 0 ? a.rev/combined : 0,
               "Amazon units": a.units, "Shopify units": s.units,
               "Dominant channel": dominant});
  }
  rows.sort((a,b) => b["Combined $"] - a["Combined $"]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Cross-channel");
  // Opportunities sheets
  const plant = rows.filter(r => r.Genus !== '(no genus)');
  const shopOnly = plant.filter(r => r["Amazon $"] === 0 && r["Shopify $"] > 0)
    .sort((a,b) => b["Shopify $"] - a["Shopify $"]);
  const amzOnly  = plant.filter(r => r["Shopify $"] === 0 && r["Amazon $"] > 0)
    .sort((a,b) => b["Amazon $"] - a["Amazon $"]);
  const strongAmz = plant.filter(r => r["Shopify $"] > 0 && r["Amazon $"] > 0 &&
                                       (r["Amazon $"] / r["Shopify $"]) > 0.20)
    .map(r => ({...r, "Amazon / Shopify": +(r["Amazon $"] / r["Shopify $"]).toFixed(4)}))
    .sort((a,b) => b["Amazon / Shopify"] - a["Amazon / Shopify"]);
  if (shopOnly.length) XLSX.utils.book_append_sheet(wb,
    XLSX.utils.json_to_sheet(shopOnly.map(r => ({Genus:r.Genus, "Shopify $":r["Shopify $"], "Shopify units":r["Shopify units"]}))),
    "Opportunity Launch on Amazon");
  if (amzOnly.length) XLSX.utils.book_append_sheet(wb,
    XLSX.utils.json_to_sheet(amzOnly.map(r => ({Genus:r.Genus, "Amazon $":r["Amazon $"], "Amazon units":r["Amazon units"]}))),
    "Amazon-only genera");
  if (strongAmz.length) XLSX.utils.book_append_sheet(wb,
    XLSX.utils.json_to_sheet(strongAmz),
    "Amazon strong (Amazon over 20pct)");
  XLSX.writeFile(wb, `cross-channel-${aSnap.label.replace(/\s+/g,'_')}-vs-${sSnap.label.replace(/\s+/g,'_')}.xlsx`);
}

function downloadClean(source){
  const tabState = state[source];
  if (!tabState.snapshotId) return;
  const snap = snapshots.find(s => s.id === tabState.snapshotId);
  if (!snap) return;
  const rows = source === 'amazon'
    ? snap.products.map(p => ({ASIN:p.asin, "Item name":p.title, Genus:p.genus, "Glance views":p.glance, "Conv rate":p.conv, "Shipped units":p.units, "Avg price":p.avg, "Shipped revenue":p.rev, "Inventory":p.inv}))
    : snap.products.map(p => ({"Product title":p.title, Genus:p.genus, "Net items sold":p.units, "Gross sales":p.gross, "Discounts":p.disc, "Returns":p.ret, "Net sales":p.net, "Total sales":p.rev}));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Clean data");
  XLSX.writeFile(wb, `${source}-clean-${snap.startDate}-to-${snap.endDate}.xlsx`);
}

// ============================================================
// CROSS-CHANNEL VIEW
// ============================================================
function renderCross(){
  const aSnaps = snapshotsFor("amazon");
  const sSnaps = snapshotsFor("shopify");
  const aSel = document.getElementById("cross-amazon-select");
  const sSel = document.getElementById("cross-shopify-select");
  aSel.innerHTML = '<option value="">— Pick Amazon snapshot —</option>' +
    aSnaps.map(s => `<option value="${s.id}" ${s.id === state.cross.amazonId ? 'selected' : ''}>${s.label}</option>`).join('');
  sSel.innerHTML = '<option value="">— Pick Shopify snapshot —</option>' +
    sSnaps.map(s => `<option value="${s.id}" ${s.id === state.cross.shopifyId ? 'selected' : ''}>${s.label}</option>`).join('');
  const aSnap = snapshots.find(s => s.id === state.cross.amazonId);
  const sSnap = snapshots.find(s => s.id === state.cross.shopifyId);
  const content = document.getElementById("cross-content");
  const empty = document.getElementById("cross-empty");
  if (!aSnap || !sSnap){
    content.style.display = "none"; empty.style.display = "block";
    if (!aSnaps.length || !sSnaps.length){
      empty.innerHTML = "Upload at least one Amazon and one Shopify snapshot to see the cross-channel comparison.";
    } else {
      empty.innerHTML = "Pick one Amazon snapshot and one Shopify snapshot above to compare.";
    }
    return;
  }
  empty.style.display = "none"; content.style.display = "block";

  // Auto-detect post-April overlap (Amazon counted inside Shopify since 2026-04)
  const OVERLAP_THRESHOLD = "2026-04-01";
  const periodOverlaps = aSnap.startDate >= OVERLAP_THRESHOLD || sSnap.startDate >= OVERLAP_THRESHOLD;
  // Read user override (persisted in localStorage)
  if (state.cross.overlap === undefined) {
    state.cross.overlap = (localStorage.getItem("sb-cross-overlap") || "") === "1" || periodOverlaps;
  }
  const overlap = state.cross.overlap;
  const overlapBox = document.getElementById("cross-overlap-box");
  overlapBox.style.display = "block";
  overlapBox.innerHTML = `
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;color:#e65100">
      <input type="checkbox" id="cross-overlap-chk" ${overlap ? 'checked' : ''}>
      <span><strong>⚠ Amazon revenue is included in Shopify totals</strong> — since April 2026, Amazon sales flow through Shopify. Check this so the combined figures don't double-count.</span>
    </label>`;
  document.getElementById("cross-overlap-chk").onchange = e => {
    state.cross.overlap = e.target.checked;
    localStorage.setItem("sb-cross-overlap", e.target.checked ? "1" : "0");
    renderCross();
  };

  const aGenera = aggregateByGenus(aSnap.products);
  const sGenera = aggregateByGenus(sSnap.products);
  const allG = new Set([...aGenera.map(g=>g.genus), ...sGenera.map(g=>g.genus)]);
  const aMap = Object.fromEntries(aGenera.map(g => [g.genus, g]));
  const sMap = Object.fromEntries(sGenera.map(g => [g.genus, g]));
  const cross = [];
  for (const g of allG){
    const a = aMap[g] || {rev:0, units:0, skus:0};
    const s = sMap[g] || {rev:0, units:0, skus:0};
    let combined, aShare, sNonAmazon;
    if (overlap){
      // Amazon is a subset of Shopify. Total = Shopify. "Other Shopify" = Shopify − Amazon (floored at 0)
      combined = s.rev;
      sNonAmazon = Math.max(0, s.rev - a.rev);
      aShare = s.rev > 0 ? Math.min(1, a.rev / s.rev) : 0;
    } else {
      combined = a.rev + s.rev;
      sNonAmazon = s.rev;
      aShare = combined > 0 ? a.rev / combined : 0;
    }
    cross.push({genus: g, aRev: a.rev, sRev: s.rev, sNonAmazon, aUnits: a.units, sUnits: s.units, combined, aShare});
  }
  cross.sort((a,b) => b.combined - a.combined);
  const plant = cross.filter(g => g.genus !== '(no genus)');
  const aTot = aSnap.products.reduce((s,p)=>s+p.rev, 0);
  const sTot = sSnap.products.reduce((s,p)=>s+p.rev, 0);
  const tot = overlap ? sTot : aTot + sTot;
  const sNonAmazonTot = overlap ? Math.max(0, sTot - aTot) : sTot;

  const cards = overlap
    ? [
      {label:'Total revenue (Shopify)', value: fmt$(tot)},
      {label:'Amazon (incl. in Shopify)', value: fmt$(aTot), sub: `${(sTot ? Math.min(100, aTot/sTot*100) : 0).toFixed(1)}% of Shopify`},
      {label:'Shopify ex-Amazon', value: fmt$(sNonAmazonTot), sub: `${(sTot ? sNonAmazonTot/sTot*100 : 0).toFixed(1)}% of Shopify`},
      {label:'Total units (Shopify)', value: fmtN(sSnap.products.reduce((s,p)=>s+p.units,0))},
    ]
    : [
      {label:'Combined revenue', value: fmt$(tot)},
      {label:'Amazon $', value: fmt$(aTot), sub: `${(tot ? aTot/tot*100 : 0).toFixed(1)}% of total`},
      {label:'Shopify $', value: fmt$(sTot), sub: `${(tot ? sTot/tot*100 : 0).toFixed(1)}% of total`},
      {label:'Total units', value: fmtN(aSnap.products.reduce((s,p)=>s+p.units,0) + sSnap.products.reduce((s,p)=>s+p.units,0))},
      {label:'Genera both channels', value: fmtN(cross.filter(g => g.aRev > 0 && g.sRev > 0 && g.genus !== '(no genus)').length)}
    ];
  document.getElementById("cross-cards").innerHTML = cards.map(c => `<div class="card"><div class="label">${c.label}</div><div class="value">${c.value}</div>${c.sub?`<div class="sub">${c.sub}</div>`:''}</div>`).join('');
  document.getElementById("cross-banner").innerHTML = `<strong>${aSnap.label}</strong> (Amazon) vs <strong>${sSnap.label}</strong> (Shopify)`;

  // Chart: top 25 by combined, stacked
  const top25 = plant.slice(0, 25);
  const ctx = document.getElementById("cross-chart").getContext('2d');
  if (state.cross.chart) state.cross.chart.destroy();
  state.cross.chart = new Chart(ctx, {
    type:'bar',
    data:{labels: top25.map(g=>g.genus), datasets: overlap
      ? [
          {label:'Amazon (in Shopify)', data: top25.map(g=>Math.min(g.aRev, g.sRev)), backgroundColor:'#ff9800'},
          {label:'Other Shopify', data: top25.map(g=>g.sNonAmazon), backgroundColor:'#2e7d32'}
        ]
      : [
          {label:'Amazon', data: top25.map(g=>g.aRev), backgroundColor:'#ff9800'},
          {label:'Shopify', data: top25.map(g=>g.sRev), backgroundColor:'#2e7d32'}
        ]
    },
    options:{indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:true, position:'bottom'}, tooltip:{callbacks:{label:c=>c.dataset.label+': '+fmt$(c.parsed.x)}}},
      scales:{x:{stacked:true, ticks:{callback:fmtAxis}}, y:{stacked:true}}}
  });

  // Table
  const tbody = document.getElementById("cross-tbody");
  const thead = document.getElementById("cross-thead");
  const overlapKeys = ['genus','aRev','sNonAmazon','sRev','aShare'];
  const splitKeys   = ['genus','aRev','sRev','combined','aShare','dominantSort'];
  const cols = overlap
    ? ['Genus','Amazon $','Other Shopify $','Shopify total $','Amazon share of Shopify']
    : ['Genus','Amazon $','Shopify $','Combined $','Amazon share','Dominant'];
  // Clamp the sort column if user previously sorted a column that doesn't exist in this mode
  if (state.crossSort.col >= cols.length) state.crossSort.col = 3;
  thead.innerHTML = cols.map((c,i) => {
    const isActive = state.crossSort.col === i;
    const arrow = isActive ? (state.crossSort.dir === 'desc' ? ' ▼' : ' ▲') : '';
    return `<th data-sort-col="${i}" class="${i===0?'':'num'}" style="cursor:pointer">${c}${arrow}</th>`;
  }).join('');
  const q = (document.getElementById("cross-search").value || '').trim().toLowerCase();
  let display = plant.slice();
  if (q) display = display.filter(g => g.genus.toLowerCase().includes(q));
  // Add a derived dominant-sort key so the Dominant column sorts intuitively (Amazon-heavy → Shopify-heavy)
  for (const r of display) {
    r.dominantSort = (r.aRev + r.sRev > 0) ? (r.aRev - r.sRev) / (r.aRev + r.sRev) : 0;
  }
  const keysList = overlap ? overlapKeys : splitKeys;
  const sortKey = keysList[state.crossSort.col] || 'combined';
  display.sort((a,b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string'){ av=av.toLowerCase(); bv=(bv||'').toLowerCase(); }
    if (av < bv) return state.crossSort.dir === 'desc' ? 1 : -1;
    if (av > bv) return state.crossSort.dir === 'desc' ? -1 : 1;
    return 0;
  });
  document.getElementById("cross-count").textContent = display.length + ' genera';
  tbody.innerHTML = display.map(g => {
    if (overlap){
      return `<tr class="clickable" data-genus="${g.genus.replace(/"/g,'&quot;')}"><td>${g.genus}</td><td class="num">${fmt$(g.aRev)}</td><td class="num">${fmt$(g.sNonAmazon)}</td><td class="num">${fmt$(g.sRev)}</td><td class="num">${pctFmt(g.aShare)}</td></tr>`;
    }
    let dom = '—';
    if (g.aRev > 0 && g.sRev === 0) dom = `<span class="badge amazon">Amazon only</span>`;
    else if (g.sRev > 0 && g.aRev === 0) dom = `<span class="badge shopify">Shopify only</span>`;
    else if (g.aRev > g.sRev * 1.1) dom = `<span class="badge amazon">Amazon (${(g.aRev/g.sRev).toFixed(1)}×)</span>`;
    else if (g.sRev > g.aRev * 1.1) dom = `<span class="badge shopify">Shopify (${(g.sRev/g.aRev).toFixed(1)}×)</span>`;
    else dom = `<span class="badge balanced">Balanced</span>`;
    return `<tr class="clickable" data-genus="${g.genus.replace(/"/g,'&quot;')}"><td>${g.genus}</td><td class="num">${fmt$(g.aRev)}</td><td class="num">${fmt$(g.sRev)}</td><td class="num">${fmt$(g.combined)}</td><td class="num">${pctFmt(g.aShare)}</td><td>${dom}</td></tr>`;
  }).join('');
  // Wire row-click → drill into plants for that genus
  tbody.querySelectorAll('tr.clickable').forEach(tr =>
    tr.addEventListener('click', () => openCrossDrill(tr.dataset.genus)));
  if (state.cross.drillGenus) renderCrossDrill(state.cross.drillGenus, aSnap, sSnap, overlap);
  // Wire sort handlers
  thead.querySelectorAll('[data-sort-col]').forEach(th => th.addEventListener('click', () => {
    const col = +th.dataset.sortCol;
    if (state.crossSort.col === col) state.crossSort.dir = state.crossSort.dir === 'desc' ? 'asc' : 'desc';
    else { state.crossSort.col = col; state.crossSort.dir = (col === 0 ? 'asc' : 'desc'); }
    renderCross();
  }));
  renderOpportunities(cross, overlap);
  renderCrossInsights(aSnap, sSnap, overlap);
  renderCrossPlantPanel();
}

function renderOpportunities(cross, overlap){
  const plant = cross.filter(g => g.genus !== '(no genus)');
  // 1) Shopify-only: Shopify revenue > 0 but Amazon = 0 → launch on Amazon
  const shopOnly = plant.filter(g => g.aRev === 0 && g.sRev > 0)
    .sort((a,b) => b.sRev - a.sRev);
  // 2) Amazon-only: Amazon revenue > 0 but Shopify = 0 → add to Shopify catalog (rare in overlap mode)
  const amzOnly = plant.filter(g => g.sRev === 0 && g.aRev > 0)
    .sort((a,b) => b.aRev - a.aRev);
  // 3) Amazon strong: Amazon > 20% of Shopify (or 20%+ in non-overlap when Shopify exists)
  const strongAmz = plant.filter(g => g.sRev > 0 && g.aRev > 0 && (g.aRev / g.sRev) > 0.20)
    .sort((a,b) => (b.aRev / b.sRev) - (a.aRev / a.sRev));

  const box = document.getElementById("cross-opportunities");
  if (!shopOnly.length && !amzOnly.length && !strongAmz.length){
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  const sec = (title, color, items, cols, render, hint) => {
    if (!items.length) return '';
    const head = cols.map((c,i) => `<th class="${i===0?'':'num'}">${c}</th>`).join('');
    const rows = items.map(g => `<tr>${render(g).map((c,i)=>`<td class="${i===0?'':'num'}">${c}</td>`).join('')}</tr>`).join('');
    return `
      <div style="margin-top:14px">
        <h3 style="margin:0 0 4px 0;color:${color};font-size:14px">${title} <span class="pill" style="background:${color}22;color:${color}">${items.length}</span></h3>
        <p class="small" style="margin:0 0 8px 0">${hint}</p>
        <div class="scroll" style="max-height:280px"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      </div>`;
  };
  let html = `<div class="panel-h"><h2>🎯 Opportunities</h2></div>`;
  html += sec(
    '🚀 Genera selling on Shopify but NOT on Amazon',
    '#2e7d32', shopOnly,
    ['Genus','Shopify $','Shopify units','SKUs'],
    g => [g.genus, fmt$(g.sRev), fmtN(g.sUnits), fmtN((g.sRev > 0 ? Object.keys({}).length : 0))],
    'Opportunity to launch these on Amazon. Sorted by Shopify revenue (biggest opportunity first).'
  );
  html += sec(
    '🛒 Genera on Amazon but NOT on Shopify' + (overlap ? ' (after netting out)' : ''),
    '#e65100', amzOnly,
    ['Genus','Amazon $','Amazon units'],
    g => [g.genus, fmt$(g.aRev), fmtN(g.aUnits)],
    overlap
      ? 'These show Amazon revenue but no Shopify revenue — possibly listings only on Amazon, or data outside the Shopify sync window.'
      : 'Opportunity to add these to your Shopify catalog. Sorted by Amazon revenue.'
  );
  html += sec(
    '⭐ Genera where Amazon is strong (>20% of Shopify)',
    '#1565c0', strongAmz,
    ['Genus','Amazon $','Shopify $','Amazon / Shopify'],
    g => [g.genus, fmt$(g.aRev), fmt$(g.sRev), pctFmt(g.aRev / g.sRev)],
    'Amazon is performing meaningfully relative to Shopify for these. Worth doubling down on Amazon PPC, listing optimization, or expanded ASIN coverage.'
  );
  box.innerHTML = html;
}


function openCrossDrill(genus){
  state.cross.drillGenus = genus;
  state.cross.drillSortA = state.cross.drillSortA || {col: 3, dir: 'desc'};
  state.cross.drillSortS = state.cross.drillSortS || {col: 2, dir: 'desc'};
  document.getElementById("cross-drill").style.display = "block";
  renderTab('cross');
  document.getElementById("cross-drill").scrollIntoView({behavior:'smooth', block:'start'});
}
function closeCrossDrill(){
  state.cross.drillGenus = null;
  document.getElementById("cross-drill").style.display = "none";
}
function renderCrossDrill(genus, aSnap, sSnap, overlap){
  const aPlants = aSnap.products.filter(p => p.genus === genus).slice().sort((a,b) => b.rev - a.rev);
  const sPlants = sSnap.products.filter(p => p.genus === genus).slice().sort((a,b) => b.rev - a.rev);
  const aSum = aPlants.reduce((s,p) => s+p.rev, 0);
  const sSum = sPlants.reduce((s,p) => s+p.rev, 0);
  const share = overlap
    ? (sSum > 0 ? Math.min(1, aSum/sSum) : 0)
    : (aSum + sSum > 0 ? aSum/(aSum+sSum) : 0);
  const shareLabel = overlap ? 'Amazon share of Shopify' : 'Amazon share of combined';
  const headerHtml = `
    <div class="panel-h">
      <h2 id="cross-drill-title">${genus} — plants on each channel</h2>
      <div class="actions"><button class="tab" id="cross-drill-close">Close</button></div>
    </div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px">
      <div class="card" style="flex:1;min-width:170px"><div class="label">Amazon revenue</div><div class="value">${fmt$(aSum)}</div><div class="sub">${aPlants.length} ASINs</div></div>
      <div class="card" style="flex:1;min-width:170px"><div class="label">Shopify revenue</div><div class="value">${fmt$(sSum)}</div><div class="sub">${sPlants.length} SKUs</div></div>
      <div class="card" style="flex:1;min-width:170px"><div class="label">${shareLabel}</div><div class="value" style="color:#e65100">${pctFmt(share)}</div></div>
    </div>`;
  const sortRows = (rows, sortRef, keys) => {
    const k = keys[sortRef.col];
    if (!k) return rows;
    return rows.slice().sort((a,b) => {
      let av = a[k], bv = b[k];
      if (typeof av === 'string'){ av=av.toLowerCase(); bv=(bv||'').toLowerCase(); }
      if (av < bv) return sortRef.dir === 'desc' ? 1 : -1;
      if (av > bv) return sortRef.dir === 'desc' ? -1 : 1;
      return 0;
    });
  };
  const aKeys = [null, 'asin', 'title', 'units', 'rev'];
  const aCols = ['#','ASIN','Item name','Units','Revenue'];
  const aSortRef = state.cross.drillSortA;
  const aSorted = sortRows(aPlants, aSortRef, aKeys);
  const aHead = aCols.map((c,i) => {
    const arrow = aSortRef.col === i ? (aSortRef.dir === 'desc' ? ' ▼' : ' ▲') : '';
    const clickable = aKeys[i] ? ' style="cursor:pointer"' : '';
    return `<th data-ax="${i}" class="${i===0||i===1||i===2?'':'num'}"${clickable}>${c}${arrow}</th>`;
  }).join('');
  const aBody = aSorted.map((p,i) =>
    `<tr><td>${i+1}</td><td>${p.asin}</td><td>${p.title}</td><td class="num">${fmtN(p.units)}</td><td class="num">${fmt$(p.rev)}</td></tr>`).join('')
    || `<tr><td colspan="5" class="empty">No Amazon plants in this genus.</td></tr>`;

  const sKeys = [null, 'title', 'units', 'rev'];
  const sCols = ['#','Title','Units','Revenue'];
  const sSortRef = state.cross.drillSortS;
  const sSorted = sortRows(sPlants, sSortRef, sKeys);
  const sHead = sCols.map((c,i) => {
    const arrow = sSortRef.col === i ? (sSortRef.dir === 'desc' ? ' ▼' : ' ▲') : '';
    const clickable = sKeys[i] ? ' style="cursor:pointer"' : '';
    return `<th data-sx="${i}" class="${i===0||i===1?'':'num'}"${clickable}>${c}${arrow}</th>`;
  }).join('');
  const sBody = sSorted.map((p,i) =>
    `<tr><td>${i+1}</td><td>${p.title}</td><td class="num">${fmtN(p.units)}</td><td class="num">${fmt$(p.rev)}</td></tr>`).join('')
    || `<tr><td colspan="4" class="empty">No Shopify plants in this genus.</td></tr>`;

  document.getElementById("cross-drill").innerHTML = headerHtml + `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div>
        <h3 style="margin:0 0 6px 0;color:#e65100">📦 Amazon plants <span class="pill" style="background:#fff3e0;color:#e65100">${aPlants.length}</span></h3>
        <div class="scroll" style="max-height:520px"><table><thead><tr>${aHead}</tr></thead><tbody>${aBody}</tbody></table></div>
      </div>
      <div>
        <h3 style="margin:0 0 6px 0;color:#2e7d32">🛒 Shopify plants <span class="pill">${sPlants.length}</span></h3>
        <div class="scroll" style="max-height:520px"><table><thead><tr>${sHead}</tr></thead><tbody>${sBody}</tbody></table></div>
      </div>
    </div>`;
  // Wire close + sort handlers
  document.getElementById("cross-drill-close").addEventListener('click', closeCrossDrill);
  document.querySelectorAll('#cross-drill [data-ax]').forEach(th => th.addEventListener('click', () => {
    const col = +th.dataset.ax;
    if (!aKeys[col]) return;
    if (aSortRef.col === col) aSortRef.dir = aSortRef.dir === 'desc' ? 'asc' : 'desc';
    else { aSortRef.col = col; aSortRef.dir = (col===1||col===2 ? 'asc' : 'desc'); }
    renderTab('cross');
  }));
  document.querySelectorAll('#cross-drill [data-sx]').forEach(th => th.addEventListener('click', () => {
    const col = +th.dataset.sx;
    if (!sKeys[col]) return;
    if (sSortRef.col === col) sSortRef.dir = sSortRef.dir === 'desc' ? 'asc' : 'desc';
    else { sSortRef.col = col; sSortRef.dir = (col===1 ? 'asc' : 'desc'); }
    renderTab('cross');
  }));
}


// ============================================================
// AUTO-INSIGHTS (rules-based, no AI)
// ============================================================
function generateInsights(source, snap, priSnap){
  const isAmazon = source === "amazon";
  const products = snap.products;
  const totalRev = products.reduce((s,p) => s+p.rev, 0);
  const genera = aggregateByGenus(products).filter(g => g.genus !== "(no genus)");
  const insights = [];

  // — Concentration
  const top5Rev = genera.slice(0, 5).reduce((s,g) => s+g.rev, 0);
  if (totalRev > 0){
    const pct = top5Rev / totalRev;
    insights.push({icon:"📊", title:"Concentration", body:
      `Your top 5 genera drive <strong>${pctFmt(pct)}</strong> of revenue (${fmt$(top5Rev)} of ${fmt$(totalRev)}). ` +
      (pct > 0.5 ? "That's a concentrated business — a single genus stumble would sting." : "Fairly diversified.") });
  }
  // Single-plant concentration (top plant vs its genus)
  for (const g of genera.slice(0, 8)){
    const topP = g.items.slice().sort((a,b) => b.rev - a.rev)[0];
    if (topP && g.rev > 0 && topP.rev / g.rev > 0.5){
      insights.push({icon:"⚠", title:`${g.genus} concentration risk`, body:
        `<strong>${topP.title.slice(0,60)}${topP.title.length>60?'…':''}</strong> alone is <strong>${pctFmt(topP.rev/g.rev)}</strong> of ${g.genus} revenue (${fmt$(topP.rev)}). One product away from a hole.` });
      break;  // Only surface the biggest one
    }
  }

  // — Compare-mode insights
  if (priSnap){
    const cmp = buildComparison(snap.products, priSnap.products);
    const priorTotal = priSnap.products.reduce((s,p)=>s+p.rev, 0);
    const dTotal = totalRev - priorTotal;
    const pctTotal = priorTotal > 0 ? dTotal/priorTotal : 0;
    insights.push({icon: dTotal >= 0 ? "📈" : "📉", title:"Overall trend", body:
      `Revenue <strong class="${dTotal>=0?'up':'down'}">${dTotal>=0?'up':'down'} ${pctFmt(Math.abs(pctTotal))}</strong> vs prior (${fmt$(totalRev)} vs ${fmt$(priorTotal)}).`});

    // Top gainers/decliners (only those with meaningful volume, prior >= $100)
    const meaningful = cmp.genera.filter(g => g.genus !== "(no genus)" && (g.ct >= 100 || g.pt >= 100));
    const gainers = meaningful.filter(g => g.pct > 0.10 && g.pt >= 100).sort((a,b) => b.pct - a.pct).slice(0, 3);
    const decliners = meaningful.filter(g => g.pct < -0.10 && g.pt >= 100).sort((a,b) => a.pct - b.pct).slice(0, 3);
    if (gainers.length){
      insights.push({icon:"🚀", title:"Top gainers", body: gainers.map(g =>
        `<strong>${g.genus}</strong> ${arrow(g.pct)} ${pctFmt(g.pct)} (${fmt$(g.pt)} → ${fmt$(g.ct)})`).join("<br>")});
    }
    if (decliners.length){
      insights.push({icon:"📉", title:"Biggest decliners", body: decliners.map(g =>
        `<strong>${g.genus}</strong> ${arrow(g.pct)} ${pctFmt(g.pct)} (${fmt$(g.pt)} → ${fmt$(g.ct)})`).join("<br>")});
    }

    // New plants: no prior revenue, ≥ $100 current
    const newPlants = cmp.products.filter(p => p.pt === 0 && p.ct >= 100)
      .sort((a,b) => b.ct - a.ct).slice(0, 5);
    if (newPlants.length){
      insights.push({icon:"✨", title:`New wins (${newPlants.length}${newPlants.length===5?'+':''})`, body:
        "Plants that earned real revenue this period with zero prior:<br>" + newPlants.map(p =>
        `<strong>${p.t.slice(0,50)}${p.t.length>50?'…':''}</strong> — ${fmt$(p.ct)}`).join("<br>")});
    }

    // Lost plants: had ≥ $100 prior, $0 current
    const lostPlants = cmp.products.filter(p => p.ct === 0 && p.pt >= 100)
      .sort((a,b) => b.pt - a.pt).slice(0, 5);
    if (lostPlants.length){
      const lostRev = cmp.products.filter(p => p.ct === 0 && p.pt >= 100).reduce((s,p)=>s+p.pt, 0);
      insights.push({icon:"👻", title:`Vanished plants (${lostPlants.length}${lostPlants.length===5?'+':''})`, body:
        `Sold prior, $0 now. Total lost revenue: <strong>${fmt$(lostRev)}</strong>.<br>` +
        lostPlants.map(p =>
        `<strong>${p.t.slice(0,50)}${p.t.length>50?'…':''}</strong> — was ${fmt$(p.pt)}`).join("<br>")});
    }
  }

  // — Amazon-only insights
  if (isAmazon){
    const oos = products.filter(p => p.inv === 0 && p.glance >= 50);
    if (oos.length){
      const lostViews = oos.reduce((s,p) => s+p.glance, 0);
      const avgConv = products.filter(p => p.units > 0 && p.glance > 0).reduce((s,p,_,arr)=>s+p.conv/arr.length, 0);
      const estLostRev = oos.reduce((s,p) => {
        const priceGuess = p.avg || products.filter(x => x.avg>0).reduce((s,x,i,a)=>s+x.avg/a.length,0) || 15;
        return s + p.glance * avgConv * priceGuess;
      }, 0);
      insights.push({icon:"📦", title:"Out-of-stock impact", body:
        `<strong>${oos.length}</strong> Amazon ASINs are OOS with meaningful traffic — <strong>${fmtN(lostViews)}</strong> glance views wasted. Estimated lost revenue at your typical conversion: <strong>${fmt$(estLostRev)}</strong>.`});
    }
    const lowConv = products.filter(p => p.glance >= 200 && p.conv < 0.01);
    if (lowConv.length){
      insights.push({icon:"⚠", title:"High-traffic, low-conversion", body:
        `<strong>${lowConv.length}</strong> ASINs get 200+ views but convert under 1%. Listing quality, price, or reviews are dragging them down.`});
    }
    // Best conversion by genus (min 300 glance views to be significant)
    const bestConv = genera.filter(g => g.glance >= 300).sort((a,b) => b.conv - a.conv).slice(0, 3);
    if (bestConv.length){
      insights.push({icon:"🎯", title:"Highest-conversion genera", body:
        "Where PPC dollars work hardest:<br>" + bestConv.map(g =>
        `<strong>${g.genus}</strong> — ${pctFmt(g.conv)} conv on ${fmtN(g.glance)} views`).join("<br>")});
    }
  }

  return insights;
}

function renderInsights(source, snap, priSnap){
  const el = document.getElementById(`${source}-insights`);
  if (!el) return;
  if (!snap){ el.style.display = "none"; return; }
  const insights = generateInsights(source, snap, priSnap);
  if (!insights.length){ el.style.display = "none"; return; }
  el.style.display = "block";
  el.innerHTML = `
    <div class="panel-h"><h2>💡 Insights <span class="pill">${insights.length}</span></h2></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px">
      ${insights.map(i => `
        <div style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:#fbfefb">
          <div style="font-weight:600;color:var(--accent);margin-bottom:4px">${i.icon} ${i.title}</div>
          <div style="font-size:13px;line-height:1.5">${i.body}</div>
        </div>`).join('')}
    </div>`;
}

function generateCrossInsights(aSnap, sSnap, overlap){
  if (!aSnap || !sSnap) return [];
  const aG = aggregateByGenus(aSnap.products);
  const sG = aggregateByGenus(sSnap.products);
  const aMap = Object.fromEntries(aG.map(g => [g.genus, g]));
  const sMap = Object.fromEntries(sG.map(g => [g.genus, g]));
  const allG = new Set([...aG.map(g => g.genus), ...sG.map(g => g.genus)]);
  const aTot = aSnap.products.reduce((s,p)=>s+p.rev, 0);
  const sTot = sSnap.products.reduce((s,p)=>s+p.rev, 0);
  const combined = overlap ? sTot : aTot + sTot;
  const insights = [];

  // Channel split
  if (combined > 0){
    if (overlap){
      insights.push({icon:"🔗", title:"Channels merged (post-April)", body:
        `Amazon accounts for <strong>${pctFmt(sTot > 0 ? aTot/sTot : 0)}</strong> of Shopify total revenue (${fmt$(aTot)} of ${fmt$(sTot)}).`});
    } else {
      insights.push({icon:"⚖", title:"Channel split", body:
        `<strong>Amazon</strong> ${pctFmt(aTot/combined)} · <strong>Shopify</strong> ${pctFmt(sTot/combined)} of combined ${fmt$(combined)}.`});
    }
  }

  // Shopify-only opportunities (biggest ones)
  const shopOnly = [];
  for (const g of allG){
    const a = aMap[g] || {rev:0}; const s = sMap[g] || {rev:0};
    if (a.rev === 0 && s.rev >= 500 && g !== "(no genus)") shopOnly.push({g, sRev: s.rev});
  }
  shopOnly.sort((a,b) => b.sRev - a.sRev);
  if (shopOnly.length){
    const shopOnlyTotal = shopOnly.reduce((s,x) => s+x.sRev, 0);
    insights.push({icon:"🚀", title:`${shopOnly.length} genera not on Amazon`, body:
      `Total Shopify revenue in the gap: <strong>${fmt$(shopOnlyTotal)}</strong>. Biggest launches to consider:<br>` +
      shopOnly.slice(0, 5).map(x => `<strong>${x.g}</strong> — ${fmt$(x.sRev)} on Shopify`).join("<br>")});
  }

  // Amazon-strong genera
  const strong = [];
  for (const g of allG){
    const a = aMap[g] || {rev:0}; const s = sMap[g] || {rev:0};
    if (s.rev >= 500 && a.rev/s.rev > 0.20 && g !== "(no genus)") strong.push({g, ratio: a.rev/s.rev, a: a.rev, s: s.rev});
  }
  strong.sort((a,b) => b.ratio - a.ratio);
  if (strong.length){
    insights.push({icon:"⭐", title:`${strong.length} genera perform well on Amazon`, body:
      "Amazon revenue > 20% of Shopify — worth PPC investment:<br>" +
      strong.slice(0, 5).map(x =>
      `<strong>${x.g}</strong> — Amazon ${pctFmt(x.ratio)} of Shopify (${fmt$(x.a)} vs ${fmt$(x.s)})`).join("<br>")});
  }

  return insights;
}

function renderCrossInsights(aSnap, sSnap, overlap){
  const el = document.getElementById("cross-insights");
  if (!el) return;
  if (!aSnap || !sSnap){ el.style.display = "none"; return; }
  const insights = generateCrossInsights(aSnap, sSnap, overlap);
  if (!insights.length){ el.style.display = "none"; return; }
  el.style.display = "block";
  el.innerHTML = `
    <div class="panel-h"><h2>💡 Insights <span class="pill">${insights.length}</span></h2></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px">
      ${insights.map(i => `
        <div style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:#fbfefb">
          <div style="font-weight:600;color:var(--accent);margin-bottom:4px">${i.icon} ${i.title}</div>
          <div style="font-size:13px;line-height:1.5">${i.body}</div>
        </div>`).join('')}
    </div>`;
}

// ============================================================
// SNAPSHOT MANAGEMENT MODAL
// ============================================================
function openManage(){
  const modal = document.getElementById('manage-modal');
  const body = document.getElementById('manage-body');
  const backupControls = `<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:10px 0;background:#f9fbf9">
    <strong style="font-size:13px">Backup &amp; restore</strong>
    <div class="small" style="margin:4px 0 8px 0">Browsers can wipe local storage unexpectedly. Export your snapshots to a file for safekeeping, then re-import if you ever lose them or switch devices/browsers.</div>
    <button class="tab" id="mng-export">&#8595; Export all snapshots (JSON)</button>
    <button class="tab" id="mng-import-btn">&#8593; Import from JSON file</button>
    <input type="file" id="mng-import-file" accept=".json" style="display:none">
  </div>`;
  if (!snapshots.length){
    body.innerHTML = backupControls + '<p class="empty">No saved snapshots yet.</p>';
    wireManageBackup(body);
    modal.style.display = 'flex';
    return;
  } else {
    const rows = snapshots.slice().sort((a,b) => b.uploadedAt.localeCompare(a.uploadedAt));
    const sizes = rows.map(s => Math.round(_snapshotSize(s) / 1024));
    const totalKB = sizes.reduce((a,b) => a+b, 0);
    body.innerHTML = backupControls + `<p class="small">Compressed storage used: ~<strong>${totalKB.toLocaleString()} KB</strong> across ${rows.length} snapshots. Browsers typically allow 5,000&ndash;10,000 KB per site.</p>
      <table><thead><tr><th>Source</th><th>Period</th><th>SKUs</th><th class="num">Size</th><th>Uploaded</th><th></th></tr></thead><tbody>${
      rows.map((s, i) => {
        const kb = sizes[i];
        const isBig = kb > 500;
        return `<tr><td><span class="badge ${s.source}">${s.source}</span></td><td>${s.label}</td><td>${s.products.length}</td><td class="num" ${isBig?'style="color:#c62828;font-weight:600"':''}>${kb.toLocaleString()} KB</td><td>${new Date(s.uploadedAt).toLocaleDateString()}</td><td><button class="tab" data-edit="${s.id}">Edit period</button> <button class="tab danger" data-del="${s.id}">Delete</button></td></tr>`;
      }).join('')}</tbody></table>`;
    body.querySelectorAll('[data-edit]').forEach(btn =>
      btn.addEventListener('click', () => editSnapshotPeriod(btn.dataset.edit)));
    body.querySelectorAll('[data-del]').forEach(btn =>
      btn.addEventListener('click', () => {
        if (confirm('Delete this snapshot? This cannot be undone.')) {
          deleteSnapshot(btn.dataset.del);
          // Reset any active snapshot pointers that referenced it
          for (const src of ['amazon','shopify','external']) {
            if (state[src] && state[src].snapshotId === btn.dataset.del) state[src].snapshotId = null;
            if (state[src] && state[src].compareId === btn.dataset.del) state[src].compareId = null;
          }
          if (state.cross.amazonId === btn.dataset.del) state.cross.amazonId = null;
          if (state.cross.shopifyId === btn.dataset.del) state.cross.shopifyId = null;
          if (state.oppmap && state.oppmap.amazonId === btn.dataset.del) state.oppmap.amazonId = null;
          if (state.oppmap && state.oppmap.shopifyId === btn.dataset.del) state.oppmap.shopifyId = null;
          if (state.oppmap && state.oppmap.externalId === btn.dataset.del) state.oppmap.externalId = null;
          openManage(); renderTab(activeTab);
        }
      }));
    wireManageBackup(body);
  }
  modal.style.display = 'flex';
}

function wireManageBackup(body) {
  const exportBtn = body.querySelector('#mng-export');
  const importBtn = body.querySelector('#mng-import-btn');
  const importFile = body.querySelector('#mng-import-file');
  if (exportBtn) exportBtn.addEventListener('click', exportAllSnapshots);
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', e => {
      if (e.target.files[0]) importSnapshotsFromFile(e.target.files[0]);
    });
  }
}

function exportAllSnapshots() {
  if (!snapshots.length) { alert('No snapshots to export.'); return; }
  const payload = {
    exportedAt: new Date().toISOString(),
    version: 1,
    snapshots
  };
  const blob = new Blob([JSON.stringify(payload)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sb-analyzer-snapshots-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importSnapshotsFromFile(file) {
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const incoming = Array.isArray(payload) ? payload : (payload.snapshots || []);
    if (!Array.isArray(incoming) || !incoming.length) {
      alert('That file does not contain any snapshots.');
      return;
    }
    // Validate shape minimally
    for (const s of incoming) {
      if (!s.id || !s.source || !Array.isArray(s.products)) {
        alert('Import failed — file is not a valid snapshots export.');
        return;
      }
    }
    // Merge: existing IDs stay, new IDs get added; ask before overwriting duplicates
    const existingIds = new Set(snapshots.map(s => s.id));
    const dup = incoming.filter(s => existingIds.has(s.id));
    let overwrite = false;
    if (dup.length) {
      overwrite = confirm(`${dup.length} snapshot(s) in the import file already exist. Overwrite them?\n\nClick OK to overwrite, Cancel to skip duplicates.`);
    }
    if (overwrite) {
      const incomingIds = new Set(incoming.map(s => s.id));
      snapshots = snapshots.filter(s => !incomingIds.has(s.id)).concat(incoming);
    } else {
      snapshots = snapshots.concat(incoming.filter(s => !existingIds.has(s.id)));
    }
    saveSnapshots();
    alert(`Imported ${incoming.length} snapshot(s). Total now: ${snapshots.length}.`);
    openManage();
    renderTab(activeTab);
  } catch(e) {
    console.error(e);
    alert('Import failed: ' + (e.message || e));
  }
}

// ============================================================
// EVENT WIRING
// ============================================================
function switchTab(source){
  activeTab = source;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === source));
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = p.id === `tab-${source}` ? 'block' : 'none');
  renderTab(source);
}
function setupDropzone(source){
  const dz = document.getElementById(`${source}-dropzone`);
  const fi = document.getElementById(`${source}-file-input`);
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag');
    if (e.dataTransfer.files[0]) handleFile(source, e.dataTransfer.files[0]);
  });
  fi.addEventListener('change', e => { if (e.target.files[0]) handleFile(source, e.target.files[0]); });
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));
  setupDropzone('amazon'); setupDropzone('shopify'); setupDropzone('external');
  setupExternalHandlers(); setupOppMapHandlers(); setupOwnedVsMarketHandlers(); setupPlantOppHandlers(); setupExtraSkuHandlers();
  if (typeof setupMcgHandlers === "function") setupMcgHandlers();
  if (typeof mcgAutoLoad === "function") mcgAutoLoad();
  if (typeof sbCatalogAutoLoad === "function") sbCatalogAutoLoad();
  for (const src of ['amazon','shopify']) {
    document.getElementById(`${src}-snap-select`).addEventListener('change', e => {
      state[src].snapshotId = e.target.value || null;
      state[src].drillGenus = null; renderTab(src);
    });
    document.getElementById(`${src}-compare-select`).addEventListener('change', e => {
      state[src].compareId = e.target.value || null;
      state[src].mode = state[src].compareId ? 'compare' : 'single';
      renderTab(src);
    });
    document.getElementById(`${src}-genus-search`).addEventListener('input', () => renderTab(src));
    document.getElementById(`${src}-prod-search`).addEventListener('input', () => renderTab(src));
    document.getElementById(`${src}-close-drill`).addEventListener('click', () => closeDrill(src));
    document.getElementById(`${src}-download`).addEventListener('click', () => downloadClean(src));
    document.getElementById(`${src}-download-breakdown`).addEventListener('click', () => downloadBreakdown(src));
    document.getElementById(`${src}-tp-download`).addEventListener('click', () => downloadTopPlants(src));
    const addBtn = document.getElementById(`${src}-addfile-btn`);
    if (addBtn) addBtn.addEventListener('click', () => document.getElementById(`${src}-file-input`).click());
    document.querySelectorAll(`#tab-${src} [data-threshold]`).forEach(btn =>
      btn.addEventListener('click', () => {
        state.topPlants[src].threshold = +btn.dataset.threshold;
        renderTab(src);
      }));
    document.getElementById(`${src}-tp-custom`).addEventListener('change', e => {
      const v = parseFloat(e.target.value);
      if (!isNaN(v) && v >= 0) { state.topPlants[src].threshold = v; renderTab(src); }
    });
    document.querySelectorAll(`#tab-${src} [data-filter]`).forEach(btn =>
      btn.addEventListener('click', () => {
        state[src].drillFilter = btn.dataset.filter;
        document.querySelectorAll(`#tab-${src} [data-filter]`).forEach(b => b.classList.toggle('active', b === btn));
        renderTab(src);
      }));
  }
  document.querySelectorAll('#tab-amazon [data-alert]').forEach(btn =>
    btn.addEventListener('click', () => {
      state.amazon.alertTab = btn.dataset.alert;
      document.querySelectorAll('#tab-amazon [data-alert]').forEach(b => b.classList.toggle('active', b === btn));
      renderTab('amazon');
    }));
  document.getElementById('cross-amazon-select').addEventListener('change', e => { state.cross.amazonId = e.target.value || null; renderTab('cross'); });
  document.getElementById('cross-shopify-select').addEventListener('change', e => { state.cross.shopifyId = e.target.value || null; renderTab('cross'); });
  document.getElementById('cross-search').addEventListener('input', () => renderTab('cross'));
  document.getElementById('cross-download').addEventListener('click', downloadCross);
  document.getElementById('manage-btn').addEventListener('click', openManage);
  document.getElementById('manage-close').addEventListener('click', () => document.getElementById('manage-modal').style.display = 'none');
  document.getElementById('manage-modal').addEventListener('click', e => {
    if (e.target.id === 'manage-modal') document.getElementById('manage-modal').style.display = 'none';
  });
  // Default to amazon tab, restore last-selected snapshot if any
  if (snapshots.length){
    const amazonLatest = snapshotsFor('amazon')[0];
    const shopifyLatest = snapshotsFor('shopify')[0];
    const externalLatest = snapshotsFor('external')[0];
    if (amazonLatest) state.amazon.snapshotId = amazonLatest.id;
    if (shopifyLatest) state.shopify.snapshotId = shopifyLatest.id;
    if (externalLatest) state.external.snapshotId = externalLatest.id;
    if (amazonLatest) state.cross.amazonId = amazonLatest.id;
    if (shopifyLatest) state.cross.shopifyId = shopifyLatest.id;
    if (amazonLatest) state.oppmap.amazonId = amazonLatest.id;
    if (shopifyLatest) state.oppmap.shopifyId = shopifyLatest.id;
    if (externalLatest) state.oppmap.externalId = externalLatest.id;
    if (amazonLatest) state.ovm.amazonId = amazonLatest.id;
    if (shopifyLatest) state.ovm.shopifyId = shopifyLatest.id;
    if (externalLatest) state.ovm.externalId = externalLatest.id;
  }
  switchTab('amazon');
});

// ============================================================
// EXTERNAL STORES (ShipStation line-item exports)
// ============================================================

// Focus stores — shown prominently on External Stores tab
const EXTERNAL_FOCUS_STORES = ['Mountain Crest Gardens', 'Leaf & Clay'];

// Extend state
state.external = { snapshotId: null, mode: 'single', compareId: null,
                   groupByParent: true, drillGenus: null, storeFilter: 'all',
                   topThreshold: 10, chart: null };
state.oppmap   = { amazonId: null, shopifyId: null, externalId: null,
                   sigFilter: 'all', softThreshold: 25,
                   storeFilter: 'all', storeGroupByParent: true,
                   plantFilter: 'all', plantThreshold: 10,
                   plantSort: {col: 3, dir: 'desc'} };
state.ovm      = { plantFilter: 'all', plantThreshold: 10,
                   crossPlantFilter: 'all',
                   drillGenus: null,
                   plantSort: {col: 4, dir: 'desc'},
                   crossPlantSort: {col: 5, dir: 'desc'},
                   amazonId: null, shopifyId: null, externalId: null,
                   storeFilter: 'all', storeGroupByParent: true,
                   rowFilter: 'all', sort: {col: 4, dir: 'desc'}, chart: null };
state.topPlants.external = { threshold: 10, sortCol: null, sortDir: 'desc' };
state.genusSort.external = { col: 1, dir: 'desc' };  // 1 = units desc

// Normalize raw ShipStation store name into a parent brand grouping
function normalizeExternalStore(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Unknown';
  const low = s.toLowerCase();
  if (low.includes('mountain crest') || /\bmcg\b/i.test(low)) return 'Mountain Crest Gardens';
  if (low.includes('leaf & clay') || low.includes('leaf and clay')) return 'Leaf & Clay';
  return s;
}

// Detect the ShipStation "with-stores" companion format:
// StoreName, OrderDate, OrderID, OrderItemID, OrderNumber, OrderTotal,
// PackageCount, Package, Quantity, SKU, ProductID  (no Item Name — join by OrderNumber)
function isShipStationStoresCompanion(rows) {
  if (!rows || !rows.length) return false;
  const h = rows[0].map(x => String(x || '').trim().toLowerCase());
  return h.includes('storename') && h.includes('ordernumber') &&
         !h.includes('item name') && !h.includes('description');
}

// Extract a lookup {orderNumber: {store, orderTotal, orderDate}} from the companion file
function parseShipStationStoresCompanion(rows) {
  const h = rows[0].map(x => String(x || '').trim());
  const idx = {}; h.forEach((c, i) => { idx[c.toLowerCase()] = i; });
  const iOrd = idx['ordernumber'], iStore = idx['storename'],
        iTot = idx['ordertotal'], iDate = idx['orderdate'];
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const o = String(r[iOrd] || '').trim();
    const s = String(r[iStore] || '').trim();
    if (!o || !s) continue;
    if (!(o in map)) map[o] = { store: s,
      total: String(r[iTot] || '').trim(),
      date:  String(r[iDate] || '').trim() };
  }
  return map;
}

// Persist / retrieve the stores-companion lookup so the user can upload the two files in any order.
const STORES_COMPANION_KEY = 'sb_shipstation_stores_lookup';
function saveStoresCompanion(map) {
  try { localStorage.setItem(STORES_COMPANION_KEY, JSON.stringify(map)); return true; }
  catch (e) { console.warn('stores companion save failed', e); return false; }
}
function loadStoresCompanion() {
  try { return JSON.parse(localStorage.getItem(STORES_COMPANION_KEY) || '{}'); }
  catch { return {}; }
}
function clearStoresCompanion() { try { localStorage.removeItem(STORES_COMPANION_KEY); } catch {} }

// Parse a ShipStation Orders (line-item) export
function parseShipStation(rows, filename) {
  if (!rows || !rows.length) return [];
  const header = rows[0].map(x => String(x || '').trim());
  const idx = {}; header.forEach((h, i) => { idx[h.toLowerCase()] = i; });
  const col = names => {
    for (const n of names) if (n.toLowerCase() in idx) return idx[n.toLowerCase()];
    return -1;
  };
  const iOrder = col(['Order #', 'Order Number', 'OrderNumber']);
  const iDate  = col(['Order Date', 'OrderDate', 'Ship Date']);
  const iSKU   = col(['Item SKU', 'SKU', 'Product SKU']);
  const iName  = col(['Item Name', 'Product Name', 'Description', 'Item']);
  const iQty   = col(['Item Quantity', 'Quantity', 'Qty']);
  const iTotal = col(['Order Total', 'Amount Paid', 'OrderTotal']);
  const iStore = col(['Store', 'Store Name', 'Marketplace', 'Source']);
  if (iName < 0 || iOrder < 0) {
    throw new Error('Not a ShipStation export. Need columns: Item Name, Order #.');
  }
  // If Store column is missing (new "Shipments" template), try the cached stores-companion first,
  // then fall back to filename inference.
  const companion = iStore < 0 ? loadStoresCompanion() : null;
  const hasCompanion = companion && Object.keys(companion).length > 0;
  let defaultStore = "";
  if (iStore < 0) {
    const fn = String(filename || "").toLowerCase();
    if (/mcg|mountain\s*crest/i.test(fn)) defaultStore = "Mountain Crest Gardens (MCG)";
    else if (/leaf\s*&?\s*clay/i.test(fn)) defaultStore = "Leaf & Clay (Shopify)";
    else if (/faire/i.test(fn)) defaultStore = "Faire";
    else if (/etsy/i.test(fn)) defaultStore = "Etsy";
    else defaultStore = "External (unknown store)";
  }
  const num = x => {
    if (typeof x === 'number') return x;
    if (!x) return 0;
    const n = parseFloat(String(x).replace(/[,$\s%]/g, ''));
    return isNaN(n) ? 0 : n;
  };
  const raw = [], unitsPerOrder = {}, totalPerOrder = {};
  let joinedFromCompanion = 0, fellBackToDefault = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const orderId = String(r[iOrder] || '').trim();
    if (!orderId) continue;
    const title = String(r[iName] || '').trim();
    if (!title || title === 'Item Name') continue;
    let rawStore, orderTotal, orderDate;
    if (iStore >= 0) {
      rawStore = String(r[iStore] || '').trim();
      orderTotal = iTotal >= 0 ? num(r[iTotal]) : 0;
      orderDate  = iDate  >= 0 ? String(r[iDate] || '').trim() : '';
    } else if (hasCompanion && companion[orderId]) {
      const meta = companion[orderId];
      rawStore   = meta.store;
      orderTotal = num(meta.total);
      orderDate  = meta.date || '';
      joinedFromCompanion++;
    } else {
      // Amazon order numbers start with 3-digit prefix + dash
      rawStore = /^\d{3}-/.test(orderId) ? 'Amazon (MCG)' : defaultStore;
      orderTotal = 0;
      orderDate  = iDate >= 0 ? String(r[iDate] || '').trim() : '';
      fellBackToDefault++;
    }
    if (!rawStore) continue;
    const qty = Math.max(num(r[iQty]) || 1, 1);
    const sku = String(r[iSKU] || '').trim();
    raw.push({orderId, orderDate, rawStore, store: normalizeExternalStore(rawStore),
              sku, title, qty, orderTotal});
    unitsPerOrder[orderId] = (unitsPerOrder[orderId] || 0) + qty;
    if (!(orderId in totalPerOrder)) totalPerOrder[orderId] = orderTotal;
  }
  if (hasCompanion) {
    console.log('ShipStation join: ' + joinedFromCompanion + ' rows via companion, ' +
                fellBackToDefault + ' rows via fallback.');
  }
  return raw.map(line => {
    const tu = unitsPerOrder[line.orderId] || 1;
    const tot = totalPerOrder[line.orderId] || 0;
    const estRev = tu > 0 ? tot * (line.qty / tu) : 0;
    return {...line, units: line.qty, estRev,
            genus: detectGenus(line.title) || '(no genus)'};
  });
}

// Aggregate ShipStation products by store (deduping orders for accurate rev)
function aggregateExternalByStore(products, groupByParent) {
  const map = {}, seen = {};
  for (const p of products) {
    const key = groupByParent ? p.store : p.rawStore;
    if (!(key in map)) {
      map[key] = {store: key, units: 0, rev: 0, orders: 0, products: []};
      seen[key] = new Set();
    }
    map[key].units += p.units;
    map[key].products.push(p);
    if (!seen[key].has(p.orderId)) {
      map[key].rev += (p.orderTotal || 0);
      map[key].orders += 1;
      seen[key].add(p.orderId);
    }
  }
  return Object.values(map)
    .map(s => ({...s, aov: s.orders ? s.rev/s.orders : 0}))
    .sort((a, b) => b.rev - a.rev);
}

// Aggregate ShipStation products by genus (units accurate, revenue estimated)
function aggregateExternalByGenus(products) {
  const map = {};
  for (const p of products) {
    const g = p.genus || '(no genus)';
    if (!(g in map)) map[g] = {genus: g, units: 0, estRev: 0, orderSet: new Set(), skuSet: new Set(), items: []};
    map[g].units += p.units;
    map[g].estRev += p.estRev;
    map[g].orderSet.add(p.orderId);
    if (p.sku) map[g].skuSet.add(p.sku);
    map[g].items.push(p);
  }
  return Object.values(map).map(g => ({
    genus: g.genus, units: g.units, estRev: g.estRev,
    orders: g.orderSet.size, skus: g.skuSet.size, items: g.items
  })).sort((a, b) => b.units - a.units);
}

// Aggregate ShipStation products by plant title (dedup across orders/stores)
function aggregateExternalByPlant(products) {
  const map = {};
  for (const p of products) {
    const t = p.title;
    if (!(t in map)) map[t] = {title: t, sku: p.sku, genus: p.genus,
                               units: 0, estRev: 0, orderSet: new Set(), storeSet: new Set()};
    map[t].units += p.units;
    map[t].estRev += p.estRev;
    map[t].orderSet.add(p.orderId);
    map[t].storeSet.add(p.store);
    if (!map[t].sku && p.sku) map[t].sku = p.sku;
  }
  return Object.values(map).map(p => ({
    title: p.title, sku: p.sku, genus: p.genus,
    units: p.units, estRev: p.estRev,
    orders: p.orderSet.size, storeCount: p.storeSet.size
  })).sort((a, b) => b.units - a.units);
}


// ============================================================
// EXTERNAL STORES — RENDER
// ============================================================
function renderExternal() {
  const s = state.external;
  const snaps = snapshotsFor('external');
  renderSnapshotPicker('external', snaps);
  if (!s.snapshotId) {
    document.getElementById('external-content').style.display = 'none';
    document.getElementById('external-empty').style.display = 'block';
    return;
  }
  document.getElementById('external-content').style.display = 'block';
  document.getElementById('external-empty').style.display = 'none';
  const snap = snapshots.find(x => x.id === s.snapshotId);
  if (!snap) { s.snapshotId = null; renderExternal(); return; }

  const products = snap.products;
  // Compare snapshot (optional)
  const cmpSnap = s.compareId ? snapshots.find(x => x.id === s.compareId) : null;
  const cmpProducts = cmpSnap ? cmpSnap.products : null;
  const cmpBanner = cmpSnap ? ` &nbsp;<span class="badge" style="background:#fff3e0;color:#e65100">vs ${cmpSnap.label}</span>` : '';
  document.getElementById('external-mode-banner').innerHTML =
    `<strong>${snap.label}</strong> · ${products.length.toLocaleString()} line items · uploaded ${new Date(snap.uploadedAt).toLocaleDateString()}${cmpBanner}
     &nbsp; <span class="small">Market signal — never summed with your Amazon/Shopify totals.</span>`;

  // Store aggregation
  const byStore = aggregateExternalByStore(products, s.groupByParent);
  const cmpByStore = cmpProducts ? aggregateExternalByStore(cmpProducts, s.groupByParent) : null;
  renderExternalSummaryCards(byStore, products, cmpByStore, cmpProducts);
  renderExternalFocusCards(byStore, cmpByStore);
  renderExternalOtherStores(byStore);
  renderExternalStoreFilter(byStore);

  // Filter products by chosen store
  let filteredProducts = products, cmpFilteredProducts = cmpProducts;
  if (s.storeFilter && s.storeFilter !== 'all') {
    filteredProducts = products.filter(p =>
      s.groupByParent ? p.store === s.storeFilter : p.rawStore === s.storeFilter);
    if (cmpProducts) cmpFilteredProducts = cmpProducts.filter(p =>
      s.groupByParent ? p.store === s.storeFilter : p.rawStore === s.storeFilter);
  }
  const genera = aggregateExternalByGenus(filteredProducts);
  const cmpGenera = cmpFilteredProducts ? aggregateExternalByGenus(cmpFilteredProducts) : null;
  renderExternalChart(genera);
  renderExternalGenusTable(genera, cmpGenera);
  renderExternalTopPlants(filteredProducts);
  renderExternalInsights(snap, byStore, genera);
  if (s.drillGenus) renderExternalDrill(s.drillGenus, genera);
}

// Small helper to render a colored Δ badge between current and prior values.
function fmtDelta(cur, prior, fmt) {
  if (prior == null) return '';
  const d = cur - prior;
  if (!prior && !cur) return '';
  const pct = prior ? (d / prior * 100) : (cur ? 100 : 0);
  const cls = d > 0 ? 'delta-up' : d < 0 ? 'delta-down' : 'delta-flat';
  const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '—';
  const sign = d > 0 ? '+' : '';
  const abs = fmt ? fmt(Math.abs(d)) : Math.abs(d).toLocaleString();
  const pctTxt = isFinite(pct) ? (sign + pct.toFixed(1) + '%') : '';
  return ` <span class="delta ${cls}" style="font-size:11px;font-weight:600;color:${d>0?'#2e7d32':d<0?'#c62828':'#666'}">${arrow} ${pctTxt} <span style="opacity:.7">(${sign}${abs})</span></span>`;
}

function renderExternalSummaryCards(byStore, products, cmpByStore, cmpProducts) {
  const totalRev = byStore.reduce((a, s) => a + s.rev, 0);
  const totalUnits = byStore.reduce((a, s) => a + s.units, 0);
  const totalOrders = byStore.reduce((a, s) => a + s.orders, 0);
  const genera = new Set(products.map(p => p.genus).filter(g => g && g !== '(no genus)')).size;
  let priorRev = null, priorUnits = null, priorOrders = null, priorStores = null, priorGenera = null;
  if (cmpByStore) {
    priorRev    = cmpByStore.reduce((a, s) => a + s.rev, 0);
    priorUnits  = cmpByStore.reduce((a, s) => a + s.units, 0);
    priorOrders = cmpByStore.reduce((a, s) => a + s.orders, 0);
    priorStores = cmpByStore.length;
    priorGenera = new Set(cmpProducts.map(p => p.genus).filter(g => g && g !== '(no genus)')).size;
  }
  const cards = [
    {label: 'Market revenue (est.)', value: fmt$(totalRev), delta: fmtDelta(totalRev, priorRev, fmt$),
       sub: '<span class="small">not your revenue</span>'},
    {label: 'Units observed',  value: fmtN(totalUnits),  delta: fmtDelta(totalUnits,  priorUnits,  fmtN)},
    {label: 'Orders observed', value: fmtN(totalOrders), delta: fmtDelta(totalOrders, priorOrders, fmtN)},
    {label: 'External stores', value: fmtN(byStore.length), delta: fmtDelta(byStore.length, priorStores, fmtN)},
    {label: 'Plant genera',    value: fmtN(genera),      delta: fmtDelta(genera, priorGenera, fmtN)}
  ];
  document.getElementById('external-summary-cards').innerHTML = cards.map(c =>
    `<div class="card"><div class="label">${c.label}</div><div class="value">${c.value}</div>${c.delta || ''}${c.sub ? `<div class="sub">${c.sub}</div>` : ''}</div>`).join('');
}

function renderExternalFocusCards(byStore, cmpByStore) {
  const focus = byStore.filter(s => EXTERNAL_FOCUS_STORES.some(f => s.store.includes(f) || f.includes(s.store)));
  const container = document.getElementById('external-focus-cards');
  if (!focus.length) {
    container.innerHTML = '<div class="small">No focus stores found in this file. All external stores shown below.</div>';
    return;
  }
  const cmpMap = {};
  if (cmpByStore) cmpByStore.forEach(s => { cmpMap[s.store] = s; });
  const snap = snapshots.find(x => x.id === state.external.snapshotId);
  let extraCards = '';
  if (snap && state.external.groupByParent) {
    const mcgAmazonProducts = snap.products.filter(p => p.rawStore === 'Amazon (MCG)');
    if (mcgAmazonProducts.length) {
      const mcgAmazon = aggregateExternalByStore(mcgAmazonProducts, false)[0];
      if (mcgAmazon) {
        mcgAmazon.store = 'MCG Amazon (breakdown)';
        extraCards = renderStoreCard(mcgAmazon, false);
      }
    }
  }
  container.innerHTML = focus.map(s => renderStoreCard(s, true, cmpMap[s.store])).join('') + extraCards;
}

function renderExternalOtherStores(byStore) {
  const other = byStore.filter(s => !EXTERNAL_FOCUS_STORES.some(f => s.store.includes(f) || f.includes(s.store)));
  const wrap = document.getElementById('external-other-wrap');
  if (!other.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  document.getElementById('external-other-count').textContent = other.length;
  document.getElementById('external-other-cards').innerHTML = other.map(s => renderStoreCard(s, false)).join('');
}

function renderStoreCard(s, isFocus, prior) {
  const genera = aggregateExternalByGenus(s.products);
  const topGenera = genera.filter(g => g.genus !== '(no genus)').slice(0, 3);
  const topGeneraTxt = topGenera.map(g => `${g.genus} (${g.units})`).join(', ') || '—';
  const dRev = prior ? fmtDelta(s.rev, prior.rev, fmt$) : '';
  const dOrd = prior ? fmtDelta(s.orders, prior.orders, fmtN) : '';
  const dUn  = prior ? fmtDelta(s.units, prior.units, fmtN) : '';
  const dAov = prior ? fmtDelta(s.aov, prior.aov, fmt$) : '';
  return `<div class="card store-card ${isFocus ? 'focus' : ''}">
    <div style="font-weight:600;font-size:14px;color:#e65100;margin-bottom:6px">${s.store}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
      <div><div class="small">Revenue</div><div style="font-weight:600">${fmt$(s.rev)}</div>${dRev}</div>
      <div><div class="small">Orders</div><div style="font-weight:600">${fmtN(s.orders)}</div>${dOrd}</div>
      <div><div class="small">Units</div><div style="font-weight:600">${fmtN(s.units)}</div>${dUn}</div>
      <div><div class="small">AOV</div><div style="font-weight:600">${fmt$(s.aov)}</div>${dAov}</div>
    </div>
    <div class="small" style="margin-top:8px"><strong>Top:</strong> ${topGeneraTxt}</div>
  </div>`;
}

function renderExternalStoreFilter(byStore) {
  const sel = document.getElementById('external-store-filter');
  const cur = state.external.storeFilter;
  sel.innerHTML = '<option value="all">All stores</option>' +
    byStore.map(s => `<option value="${s.store}" ${s.store === cur ? 'selected' : ''}>${s.store} (${fmt$(s.rev)})</option>`).join('');
}

function renderExternalChart(genera) {
  const items = genera.filter(g => showNonPlant || g.genus !== '(no genus)').slice(0, 25);
  const ctx = document.getElementById('external-chart').getContext('2d');
  if (state.external.chart) state.external.chart.destroy();
  state.external.chart = new Chart(ctx, {
    type: 'bar',
    data: {labels: items.map(g => g.genus), datasets: [{
      data: items.map(g => g.units), backgroundColor: '#ff9800', label: 'Units'
    }]},
    options: {indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {legend: {display: false}, tooltip: {callbacks: {
        label: c => `${fmtN(c.parsed.x)} units (est. ${fmt$(items[c.dataIndex].estRev)})`
      }}},
      scales: {x: {ticks: {callback: v => fmtN(v)}}}}
  });
}

function renderExternalGenusTable(genera, cmpGenera) {
  const search = (document.getElementById('external-genus-search').value || '').toLowerCase();
  const items = genera.filter(g =>
    (showNonPlant || g.genus !== '(no genus)') &&
    (!search || g.genus.toLowerCase().includes(search)));
  const cmpMap = {};
  if (cmpGenera) cmpGenera.forEach(g => { cmpMap[g.genus] = g; });
  const hasCmp = !!cmpGenera;
  const cols = [
    {key: 'genus', label: 'Genus'},
    {key: 'type', label: 'Type'},
    {key: 'units', label: 'Units', num: true, fmt: fmtN},
    {key: 'estRev', label: 'Est. revenue', num: true, fmt: fmt$},
    {key: 'orders', label: 'Orders', num: true, fmt: fmtN},
    {key: 'skus', label: 'SKUs', num: true, fmt: fmtN}
  ];
  if (hasCmp) {
    cols.splice(3, 0, {key: 'unitsDelta', label: 'Δ units', num: true});
    cols.push({key: 'revDelta', label: 'Δ revenue', num: true});
  }
  const ss = state.genusSort.external;
  if (ss.col >= cols.length) { ss.col = 0; ss.dir = 'desc'; }
  const sorted = [...items].sort((a, b) => {
    const kv = cols[ss.col].key, dir = ss.dir === 'asc' ? 1 : -1;
    if (kv === 'type') {
      const at = getType(a.genus) || '', bt = getType(b.genus) || '';
      return at.localeCompare(bt) * dir;
    }
    if (kv === 'unitsDelta') {
      const av = a.units - (cmpMap[a.genus]?.units || 0);
      const bv = b.units - (cmpMap[b.genus]?.units || 0);
      return (av > bv ? 1 : av < bv ? -1 : 0) * dir;
    }
    if (kv === 'revDelta') {
      const av = a.estRev - (cmpMap[a.genus]?.estRev || 0);
      const bv = b.estRev - (cmpMap[b.genus]?.estRev || 0);
      return (av > bv ? 1 : av < bv ? -1 : 0) * dir;
    }
    return (a[kv] > b[kv] ? 1 : a[kv] < b[kv] ? -1 : 0) * dir;
  });
  document.getElementById('external-genus-thead').innerHTML = cols.map((c, i) =>
    `<th class="${c.num ? 'num' : ''}" data-genus-sort="${i}">${c.label}${i === ss.col ? (ss.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`).join('');
  document.getElementById('external-genus-tbody').innerHTML = sorted.map(g => {
    const t = getType(g.genus);
    const typeCell = t ? `<span class="badge type-${t.toLowerCase().replace(/\s/g,'')}">${t}</span>` : '';
    const prior = cmpMap[g.genus];
    return `<tr class="clickable" data-drill-genus="${g.genus}">${cols.map(c => {
      if (c.key === 'type') return `<td>${typeCell}</td>`;
      if (c.key === 'unitsDelta') return `<td class="num">${fmtDelta(g.units, prior ? prior.units : 0, fmtN)}</td>`;
      if (c.key === 'revDelta')   return `<td class="num">${fmtDelta(g.estRev, prior ? prior.estRev : 0, fmt$)}</td>`;
      return `<td class="${c.num ? 'num' : ''}">${c.fmt ? c.fmt(g[c.key]) : g[c.key]}</td>`;
    }).join('')}</tr>`;
  }).join('');
  document.getElementById('external-genus-count').textContent = sorted.length + ' genera';
  document.getElementById('external-genus-thead').querySelectorAll('[data-genus-sort]').forEach(th =>
    th.addEventListener('click', () => {
      const idx = +th.dataset.genusSort;
      if (ss.col === idx) ss.dir = ss.dir === 'asc' ? 'desc' : 'asc';
      else { ss.col = idx; ss.dir = 'desc'; }
      renderExternal();
    }));
  document.getElementById('external-genus-tbody').querySelectorAll('[data-drill-genus]').forEach(tr =>
    tr.addEventListener('click', () => {
      state.external.drillGenus = tr.dataset.drillGenus;
      renderExternal();
    }));
}

function renderExternalTopPlants(products) {
  const thresh = state.external.topThreshold;
  const plants = aggregateExternalByPlant(products).filter(p => p.units >= thresh && (showNonPlant || p.genus !== '(no genus)'));
  const cols = [
    {key: 'title', label: 'Plant / item', num: false},
    {key: 'genus', label: 'Genus', num: false},
    {key: 'sku', label: 'SKU', num: false},
    {key: 'units', label: 'Units', num: true, fmt: fmtN},
    {key: 'estRev', label: 'Est. rev', num: true, fmt: fmt$},
    {key: 'orders', label: 'Orders', num: true, fmt: fmtN},
    {key: 'storeCount', label: 'Stores', num: true, fmt: fmtN}
  ];
  const tp = state.topPlants.external;
  if (tp.sortCol == null) { tp.sortCol = 3; tp.sortDir = 'desc'; }
  plants.sort((a, b) => {
    const kv = cols[tp.sortCol].key, dir = tp.sortDir === 'asc' ? 1 : -1;
    return (a[kv] > b[kv] ? 1 : a[kv] < b[kv] ? -1 : 0) * dir;
  });
  document.getElementById('external-tp-thead').innerHTML = cols.map((c, i) =>
    `<th class="${c.num ? 'num' : ''}" data-tp-sort="${i}">${c.label}${i === tp.sortCol ? (tp.sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`).join('');
  document.getElementById('external-tp-tbody').innerHTML = plants.slice(0, 500).map(p =>
    `<tr>${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.fmt ? c.fmt(p[c.key]) : (p[c.key] || '')}</td>`).join('')}</tr>`).join('');
  document.getElementById('external-tp-count').textContent = plants.length + ' plants';
  document.getElementById('external-tp-thead').querySelectorAll('[data-tp-sort]').forEach(th =>
    th.addEventListener('click', () => {
      const idx = +th.dataset.tpSort;
      if (tp.sortCol === idx) tp.sortDir = tp.sortDir === 'asc' ? 'desc' : 'asc';
      else { tp.sortCol = idx; tp.sortDir = 'desc'; }
      renderExternal();
    }));
}

function renderExternalDrill(genus, genera) {
  const g = genera.find(x => x.genus === genus);
  const panel = document.getElementById('external-drill');
  if (!g) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  document.getElementById('external-drill-title').innerHTML = `${genus} <span class="pill">${g.items.length} lines · ${fmtN(g.units)} units</span>`;
  const search = (document.getElementById('external-prod-search').value || '').toLowerCase();
  // Aggregate items in this genus by title
  const byTitle = aggregateExternalByPlant(g.items).filter(p => !search || p.title.toLowerCase().includes(search));
  const cols = [
    {key: 'title', label: 'Plant'}, {key: 'sku', label: 'SKU'},
    {key: 'units', label: 'Units', num: true, fmt: fmtN},
    {key: 'estRev', label: 'Est. rev', num: true, fmt: fmt$},
    {key: 'orders', label: 'Orders', num: true, fmt: fmtN},
    {key: 'storeCount', label: 'Stores', num: true, fmt: fmtN}
  ];
  // Sort per user selection (default col 2 = Units, desc)
  if (!state.external.drillSort) state.external.drillSort = {col: 2, dir: 'desc'};
  const ds = state.external.drillSort;
  byTitle.sort((a, b) => {
    const kv = cols[ds.col].key;
    const dir = ds.dir === 'asc' ? 1 : -1;
    const av = a[kv], bv = b[kv];
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av || '').localeCompare(String(bv || '')) * dir;
    }
    return ((av || 0) > (bv || 0) ? 1 : (av || 0) < (bv || 0) ? -1 : 0) * dir;
  });
  document.getElementById('external-prod-thead').innerHTML = cols.map((c, i) => {
    const arrow = i === ds.col ? (ds.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="${c.num ? 'num' : ''}" data-ext-drill-sort="${i}">${c.label}${arrow}</th>`;
  }).join('');
  document.getElementById('external-prod-tbody').innerHTML = byTitle.map(p =>
    `<tr>${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.fmt ? c.fmt(p[c.key]) : (p[c.key] || '')}</td>`).join('')}</tr>`).join('');
  document.getElementById('external-drill-count').textContent = byTitle.length + ' plants';
  document.getElementById('external-prod-thead').querySelectorAll('[data-ext-drill-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const idx = +th.dataset.extDrillSort;
      if (ds.col === idx) ds.dir = ds.dir === 'asc' ? 'desc' : 'asc';
      else { ds.col = idx; ds.dir = 'desc'; }
      renderExternal();
    });
  });
}

function renderExternalInsights(snap, byStore, genera) {
  const el = document.getElementById('external-insights');
  const cards = [];
  // Insight: top gainer store
  if (byStore.length) {
    const top = byStore[0];
    cards.push({icon: '🏪', title: 'Biggest external footprint',
      body: `<strong>${top.store}</strong> — ${fmt$(top.rev)} across ${fmtN(top.orders)} orders (${fmtN(top.units)} units). AOV ${fmt$(top.aov)}.`});
  }
  // Insight: top genus overall
  const topGenera = genera.filter(g => g.genus !== '(no genus)').slice(0, 3);
  if (topGenera.length) {
    cards.push({icon: '🌱', title: 'What the market is moving',
      body: `Top genera by units: ${topGenera.map(g => `<strong>${g.genus}</strong> (${fmtN(g.units)})`).join(', ')}. Strong external demand signal.`});
  }
  // Bundle blind-spot warning
  const noGenus = genera.find(g => g.genus === '(no genus)');
  if (noGenus) {
    const pct = ((noGenus.units / genera.reduce((a, g) => a + g.units, 0)) * 100).toFixed(0);
    cards.push({icon: '⚠️', title: 'Non-plant lines detected',
      body: `${fmtN(noGenus.units)} units (~${pct}%) are bundles / mystery boxes / supplies / cuttings — genus can't be determined from title. Consider these separately.`});
  }
  if (!cards.length) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = `<div class="panel-h"><h2>💡 Market insights <span class="pill">${cards.length}</span></h2></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px">
      ${cards.map(c => `<div style="border:1px solid #ffe0b2;border-radius:10px;padding:12px 14px;background:#fffaf3">
        <div style="font-weight:600;color:#e65100;margin-bottom:4px">${c.icon} ${c.title}</div>
        <div style="font-size:13px;line-height:1.5">${c.body}</div></div>`).join('')}
    </div>`;
}

function closeExternalDrill() {
  state.external.drillGenus = null;
  document.getElementById('external-drill').style.display = 'none';
}

// ============================================================
// OPPORTUNITY MAP
// ============================================================
function computeOpportunityMap() {
  const am = state.oppmap.amazonId ? snapshots.find(s => s.id === state.oppmap.amazonId) : null;
  const sh = state.oppmap.shopifyId ? snapshots.find(s => s.id === state.oppmap.shopifyId) : null;
  const ex = state.oppmap.externalId ? snapshots.find(s => s.id === state.oppmap.externalId) : null;
  if ((!am && !sh) || !ex) return null;

  // Owned genera: combine Amazon + Shopify by genus
  const ownedMap = {};
  const addOwned = (products, channel) => {
    for (const p of products) {
      const g = p.genus || '(no genus)';
      if (!(g in ownedMap)) ownedMap[g] = {genus: g, amazon: 0, shopify: 0, units: 0};
      ownedMap[g][channel] += p.rev;
      ownedMap[g].units += p.units;
    }
  };
  if (am) addOwned(am.products, 'amazon');
  if (sh) addOwned(sh.products, 'shopify');

  // External genera (units + est. rev, aggregated across all stores in that snapshot)
  // Apply store filter if user narrowed to a specific external store (e.g. "Amazon (MCG)")
  let extProducts = ex.products;
  const sf = state.oppmap.storeFilter;
  if (sf && sf !== 'all') {
    extProducts = extProducts.filter(p =>
      state.oppmap.storeGroupByParent ? p.store === sf : p.rawStore === sf);
  }
  const extAgg = aggregateExternalByGenus(extProducts);
  const extMap = Object.fromEntries(extAgg.map(g => [g.genus, g]));

  // Compute soft market threshold: 25th percentile of external genera revenue
  const extRevs = extAgg.filter(g => g.genus !== '(no genus)').map(g => g.estRev).sort((a, b) => a - b);
  const softCutoff = extRevs.length ? extRevs[Math.floor(extRevs.length * (state.oppmap.softThreshold / 100))] : 0;

  // Combine all genera universe
  const allGenera = new Set([...Object.keys(ownedMap), ...Object.keys(extMap)]);
  const rows = [];
  for (const g of allGenera) {
    if (g === '(no genus)') continue;
    const owned = ownedMap[g] || {amazon: 0, shopify: 0, units: 0};
    const ext = extMap[g] || {units: 0, estRev: 0};
    const yourRev = owned.amazon + owned.shopify;
    const mktRev = ext.estRev;
    const mktUnits = ext.units;
    // Signal assignment
    let signal, action;
    if (mktRev >= softCutoff && yourRev === 0) {
      signal = 'red'; action = 'List it — market sells this, you sell $0.';
    } else if (mktRev > 0 && yourRev > 0 && mktRev >= yourRev * 2) {
      signal = 'orange'; action = 'Investigate — market outsells you 2×+.';
    } else if (mktRev > 0 && mktRev < softCutoff && yourRev < mktRev * 1.5) {
      signal = 'blue'; action = 'Soft market — chance to become the leader.';
    } else if (yourRev > 0 && yourRev >= mktRev * 2) {
      signal = 'green'; action = 'You dominate — confirm the moat.';
    } else if (mktRev === 0 && yourRev === 0) {
      signal = 'gray'; action = 'Neither sells this — ignore.';
    } else {
      signal = 'yellow'; action = 'Both selling, watch for trend.';
    }
    rows.push({
      genus: g, amazon: owned.amazon, shopify: owned.shopify, yourRev,
      mktUnits, mktRev, signal, action,
      diffPct: yourRev > 0 ? (mktRev - yourRev) / yourRev : (mktRev > 0 ? Infinity : 0)
    });
  }
  const priority = {red: 0, orange: 1, blue: 2, yellow: 3, green: 4, gray: 5};
  rows.sort((a, b) => priority[a.signal] - priority[b.signal] || b.mktRev - a.mktRev);
  return {rows, softCutoff, am, sh, ex};
}

function renderOppMap() {
  const s = state.oppmap;
  // Populate selects
  const amSnaps = snapshotsFor('amazon'), shSnaps = snapshotsFor('shopify'), exSnaps = snapshotsFor('external');
  const fill = (id, snaps, cur) => {
    document.getElementById(id).innerHTML = '<option value="">— None —</option>' +
      snaps.map(s => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${s.label}</option>`).join('');
  };
  fill('oppmap-amazon-select', amSnaps, s.amazonId);
  fill('oppmap-shopify-select', shSnaps, s.shopifyId);
  fill('oppmap-external-select', exSnaps, s.externalId);

  // Populate store-filter dropdown from the chosen external snapshot
  const exSnap = s.externalId ? snapshots.find(x => x.id === s.externalId) : null;
  const storeFilterEl = document.getElementById('oppmap-store-filter');
  if (storeFilterEl) {
    if (exSnap) {
      const stores = aggregateExternalByStore(exSnap.products, s.storeGroupByParent);
      storeFilterEl.innerHTML = '<option value="all">All external stores</option>' +
        stores.map(st => `<option value="${st.store}" ${st.store === s.storeFilter ? 'selected' : ''}>${st.store} (${fmt$(st.rev)})</option>`).join('');
    } else {
      storeFilterEl.innerHTML = '<option value="all">All external stores</option>';
    }
  }

  const map = computeOpportunityMap();
  if (!map) {
    document.getElementById('oppmap-content').style.display = 'none';
    document.getElementById('oppmap-empty').style.display = 'block';
    document.getElementById('oppmap-banner').innerHTML = '';
    return;
  }
  document.getElementById('oppmap-content').style.display = 'block';
  document.getElementById('oppmap-empty').style.display = 'none';
  const parts = [];
  if (map.am) parts.push(`Amazon <strong>${map.am.label}</strong>`);
  if (map.sh) parts.push(`Shopify <strong>${map.sh.label}</strong>`);
  const mktLabel = (s.storeFilter && s.storeFilter !== 'all')
    ? `<strong>${s.storeFilter}</strong> (${map.ex.label})`
    : `Market <strong>${map.ex.label}</strong>`;
  parts.push('vs ' + mktLabel);
  document.getElementById('oppmap-banner').innerHTML = parts.join(' + ') +
    ` &nbsp; <span class="small">Soft-market cutoff: ${fmt$(map.softCutoff)}</span>`;

  // Signal count cards
  const counts = {};
  for (const r of map.rows) counts[r.signal] = (counts[r.signal] || 0) + 1;
  const sigInfo = {
    red: {icon: '🔴', label: 'Missing opportunity'},
    orange: {icon: '🟠', label: 'Losing category'},
    blue: {icon: '🔵', label: 'Soft market — cut in'},
    yellow: {icon: '🟡', label: 'Watch'},
    green: {icon: '🟢', label: 'You dominate'},
    gray: {icon: '⚪', label: 'Dead category'}
  };
  document.getElementById('oppmap-signal-cards').innerHTML =
    Object.entries(sigInfo).map(([k, v]) =>
      `<div class="card"><div class="label">${v.icon} ${v.label}</div><div class="value">${fmtN(counts[k] || 0)}</div></div>`).join('');

  // Filter by signal & search
  const search = (document.getElementById('oppmap-search').value || '').toLowerCase();
  let filtered = map.rows;
  if (s.sigFilter !== 'all') filtered = filtered.filter(r => r.signal === s.sigFilter);
  if (search) filtered = filtered.filter(r => r.genus.toLowerCase().includes(search));

  // Table
  const cols = [
    {label: 'Signal', k: 'signal'},
    {label: 'Genus', k: 'genus'},
    {label: 'Type', k: 'type'},
    {label: 'Your Amazon', k: 'amazon', num: true, fmt: fmt$},
    {label: 'Your Shopify', k: 'shopify', num: true, fmt: fmt$},
    {label: 'Your total', k: 'yourRev', num: true, fmt: fmt$},
    {label: 'Market units', k: 'mktUnits', num: true, fmt: fmtN},
    {label: 'Market rev (est.)', k: 'mktRev', num: true, fmt: fmt$},
    {label: 'Action', k: 'action'}
  ];
  document.getElementById('oppmap-thead').innerHTML = cols.map(c =>
    `<th class="${c.num ? 'num' : ''}">${c.label}</th>`).join('');
  document.getElementById('oppmap-tbody').innerHTML = filtered.map(r => {
    const t = getType(r.genus);
    const typeBadge = t ? `<span class="badge type-${t.toLowerCase().replace(/\s/g,'')}">${t}</span>` : '';
    return `<tr>${cols.map(c => {
      if (c.k === 'signal') return `<td><span class="badge sig-${r.signal}">${sigInfo[r.signal].icon}</span></td>`;
      if (c.k === 'type') return `<td>${typeBadge}</td>`;
      return `<td class="${c.num ? 'num' : ''}">${c.fmt ? c.fmt(r[c.k]) : (r[c.k] || '')}</td>`;
    }).join('')}</tr>`;
  }).join('');
  document.getElementById('oppmap-count').textContent = filtered.length + ' genera';
  // Also render the per-plant panel below
  renderPlantOpportunities();
}

// ============================================================
// EXTERNAL DOWNLOADS
// ============================================================
function downloadExternalClean() {
  const snap = snapshots.find(s => s.id === state.external.snapshotId);
  if (!snap) return;
  const rows = snap.products.map(p => ({
    'Order #': p.orderId, 'Order Date': p.orderDate, 'Raw Store': p.rawStore,
    'Parent Brand': p.store, 'SKU': p.sku, 'Item Name': p.title,
    'Genus': p.genus, 'Quantity': p.units,
    'Order Total ($)': (p.orderTotal || 0).toFixed(2),
    'Est. Line Rev ($)': (p.estRev || 0).toFixed(2)
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'External Line Items');
  XLSX.writeFile(wb, `external-clean-${snap.label.replace(/\s+/g, '')}.xlsx`);
}

function downloadExternalBreakdown() {
  const snap = snapshots.find(s => s.id === state.external.snapshotId);
  if (!snap) return;
  const wb = XLSX.utils.book_new();
  // Summary sheet
  const byStore = aggregateExternalByStore(snap.products, state.external.groupByParent);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byStore.map(s => ({
    Store: s.store, Orders: s.orders, Units: s.units,
    'Revenue ($)': s.rev.toFixed(2), 'AOV ($)': s.aov.toFixed(2)
  }))), 'Summary by Store');
  // Genus sheet (all stores combined)
  const genera = aggregateExternalByGenus(snap.products);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(genera.map(g => ({
    Genus: g.genus, Units: g.units, 'Est. Rev ($)': g.estRev.toFixed(2),
    Orders: g.orders, SKUs: g.skus
  }))), 'Genera - All Stores');
  // Per-store: one sheet per store with top plants
  for (const s of byStore) {
    const plants = aggregateExternalByPlant(s.products).slice(0, 200);
    const sheetName = (s.store.length > 30 ? s.store.slice(0, 30) : s.store).replace(/[\/\\\?\*\[\]:]/g, ' ');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(plants.map(p => ({
      Plant: p.title, SKU: p.sku, Genus: p.genus,
      Units: p.units, 'Est. Rev ($)': p.estRev.toFixed(2), Orders: p.orders
    }))), sheetName);
  }
  XLSX.writeFile(wb, `external-breakdown-${snap.label.replace(/\s+/g, '')}.xlsx`);
}

function downloadExternalTopPlants() {
  const snap = snapshots.find(s => s.id === state.external.snapshotId);
  if (!snap) return;
  const thresh = state.external.topThreshold;
  const plants = aggregateExternalByPlant(snap.products).filter(p => p.units >= thresh);
  const csv = 'Plant,SKU,Genus,Units,Est. Rev ($),Orders,Stores\n' +
    plants.map(p => [
      `"${(p.title || '').replace(/"/g, '""')}"`, p.sku || '', p.genus || '',
      p.units, p.estRev.toFixed(2), p.orders, p.storeCount
    ].join(',')).join('\n');
  const blob = new Blob([csv], {type: 'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `external-top-plants-${snap.label.replace(/\s+/g, '')}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

function downloadOppMap() {
  const map = computeOpportunityMap();
  if (!map) return;
  const sigLabels = {
    red: "MISSING - list it",
    orange: "LOSING - investigate",
    blue: "SOFT MARKET - cut in",
    yellow: "WATCH - both selling",
    green: "DOMINATE - confirm moat",
    gray: "DEAD - ignore"
  };
  const rows = map.rows.map(r => ({
    Signal: sigLabels[r.signal],
    Genus: r.genus,
    "Your Amazon ($)": r.amazon.toFixed(2),
    "Your Shopify ($)": r.shopify.toFixed(2),
    "Your Total ($)": r.yourRev.toFixed(2),
    "Market Units": r.mktUnits,
    "Market Rev (est. $)": r.mktRev.toFixed(2),
    Action: r.action
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Opportunity Map");
  const label = (map.ex.label || "").replace(/\s+/g, "");
  XLSX.writeFile(wb, "opportunity-map-" + label + ".xlsx");
}

// ============================================================
// EVENT HANDLERS — External Stores & Opportunity Map
// ============================================================
function setupExternalHandlers() {
  document.getElementById("external-snap-select").addEventListener("change", function(e) {
    state.external.snapshotId = e.target.value || null;
    state.external.drillGenus = null;
    state.external.storeFilter = "all";
    renderExternal();
  });
  document.getElementById("external-compare-select").addEventListener("change", function(e) {
    state.external.compareId = e.target.value || null;
    state.external.mode = state.external.compareId ? "compare" : "single";
    renderExternal();
  });
  document.getElementById("external-group-parent").addEventListener("change", function(e) {
    state.external.groupByParent = e.target.checked;
    state.external.storeFilter = "all";
    renderExternal();
  });
  document.getElementById("external-store-filter").addEventListener("change", function(e) {
    state.external.storeFilter = e.target.value;
    state.external.drillGenus = null;
    renderExternal();
  });
  document.getElementById("external-genus-search").addEventListener("input", renderExternal);
  document.getElementById("external-prod-search").addEventListener("input", renderExternal);
  document.getElementById("external-close-drill").addEventListener("click", closeExternalDrill);
  document.getElementById("external-download").addEventListener("click", downloadExternalClean);
  document.getElementById("external-download-breakdown").addEventListener("click", downloadExternalBreakdown);
  document.getElementById("external-tp-download").addEventListener("click", downloadExternalTopPlants);
  var addBtn = document.getElementById("external-addfile-btn");
  if (addBtn) addBtn.addEventListener("click", function() {
    document.getElementById("external-file-input").click();
  });
  var thBtns = document.querySelectorAll("#tab-external [data-ext-thresh]");
  for (var i = 0; i < thBtns.length; i++) {
    (function(btn) {
      btn.addEventListener("click", function() {
        state.external.topThreshold = +btn.dataset.extThresh;
        var all = document.querySelectorAll("#tab-external [data-ext-thresh]");
        for (var j = 0; j < all.length; j++) all[j].classList.toggle("active", all[j] === btn);
        renderExternal();
      });
    })(thBtns[i]);
  }
}

function setupOppMapHandlers() {
  document.getElementById("oppmap-amazon-select").addEventListener("change", function(e) {
    state.oppmap.amazonId = e.target.value || null; renderOppMap();
  });
  document.getElementById("oppmap-shopify-select").addEventListener("change", function(e) {
    state.oppmap.shopifyId = e.target.value || null; renderOppMap();
  });
  document.getElementById("oppmap-external-select").addEventListener("change", function(e) {
    state.oppmap.externalId = e.target.value || null;
    state.oppmap.storeFilter = "all";
    renderOppMap();
  });
  document.getElementById("oppmap-store-filter").addEventListener("change", function(e) {
    state.oppmap.storeFilter = e.target.value || "all";
    renderOppMap();
  });
  document.getElementById("oppmap-preset-amazon").addEventListener("click", function() {
    state.oppmap.storeGroupByParent = false;
    state.oppmap.storeFilter = "Amazon (MCG)";
    renderOppMap();
  });
  document.getElementById("oppmap-preset-all").addEventListener("click", function() {
    state.oppmap.storeGroupByParent = true;
    state.oppmap.storeFilter = "all";
    renderOppMap();
  });
  document.getElementById("oppmap-search").addEventListener("input", renderOppMap);
  document.getElementById("oppmap-download").addEventListener("click", downloadOppMap);
  var sigBtns = document.querySelectorAll("#tab-oppmap [data-sig]");
  for (var i = 0; i < sigBtns.length; i++) {
    (function(btn) {
      btn.addEventListener("click", function() {
        state.oppmap.sigFilter = btn.dataset.sig;
        var all = document.querySelectorAll("#tab-oppmap [data-sig]");
        for (var j = 0; j < all.length; j++) all[j].classList.toggle("active", all[j] === btn);
        renderOppMap();
      });
    })(sigBtns[i]);
  }
}

// ============================================================
// OWNED vs MARKET (side-by-side comparison tab)
// ============================================================
function computeOwnedVsMarket() {
  var s = state.ovm;
  var am = s.amazonId ? snapshots.find(function(x){return x.id===s.amazonId}) : null;
  var sh = s.shopifyId ? snapshots.find(function(x){return x.id===s.shopifyId}) : null;
  var ex = s.externalId ? snapshots.find(function(x){return x.id===s.externalId}) : null;
  if ((!am && !sh) || !ex) return null;

  // Owned by genus
  var owned = {};
  function addOwned(products, channel) {
    for (var i = 0; i < products.length; i++) {
      var p = products[i];
      var g = p.genus || "(no genus)";
      if (!(g in owned)) owned[g] = {genus: g, amazon: 0, shopify: 0, units: 0};
      owned[g][channel] += p.rev;
      owned[g].units += p.units;
    }
  }
  if (am) addOwned(am.products, "amazon");
  if (sh) addOwned(sh.products, "shopify");

  // Market by genus (respect store filter)
  var extProducts = ex.products;
  if (s.storeFilter && s.storeFilter !== "all") {
    extProducts = extProducts.filter(function(p){
      return s.storeGroupByParent ? p.store === s.storeFilter : p.rawStore === s.storeFilter;
    });
  }
  var extAgg = aggregateExternalByGenus(extProducts);
  var extMap = {};
  for (var i = 0; i < extAgg.length; i++) extMap[extAgg[i].genus] = extAgg[i];

  // Combine
  var seen = {};
  var rows = [];
  for (var g in owned) seen[g] = true;
  for (var g in extMap) seen[g] = true;
  for (var g in seen) {
    if (g === "(no genus)") continue;
    var o = owned[g] || {amazon: 0, shopify: 0, units: 0};
    var m = extMap[g] || {units: 0, estRev: 0, orders: 0};
    var yourRev = o.amazon + o.shopify;
    var mktRev = m.estRev;
    var totalRev = yourRev + mktRev;
    var marketShare = totalRev > 0 ? mktRev / totalRev : 0;
    rows.push({
      genus: g, type: getType(g) || "",
      amazon: o.amazon, shopify: o.shopify, yourRev: yourRev,
      mktUnits: m.units, mktRev: mktRev, mktOrders: m.orders,
      marketShare: marketShare,
      status: yourRev > 0 && mktRev > 0 ? "both" : (yourRev > 0 ? "owned-only" : "market-only")
    });
  }
  rows.sort(function(a, b){ return (b.yourRev + b.mktRev) - (a.yourRev + a.mktRev); });
  return {rows: rows, am: am, sh: sh, ex: ex, extProducts: extProducts};
}

function renderOwnedVsMarket() {
  var s = state.ovm;
  // Populate select dropdowns
  var amSnaps = snapshotsFor("amazon"), shSnaps = snapshotsFor("shopify"), exSnaps = snapshotsFor("external");
  function fill(id, snaps, cur) {
    document.getElementById(id).innerHTML = '<option value="">-- None --</option>' +
      snaps.map(function(sn){return '<option value="' + sn.id + '" ' + (sn.id === cur ? "selected" : "") + '>' + sn.label + '</option>';}).join("");
  }
  fill("ovm-amazon-select", amSnaps, s.amazonId);
  fill("ovm-shopify-select", shSnaps, s.shopifyId);
  fill("ovm-external-select", exSnaps, s.externalId);

  // Store filter dropdown
  var exSnap = s.externalId ? snapshots.find(function(x){return x.id===s.externalId}) : null;
  var storeSel = document.getElementById("ovm-store-filter");
  if (exSnap) {
    var stores = aggregateExternalByStore(exSnap.products, s.storeGroupByParent);
    storeSel.innerHTML = '<option value="all">All external stores</option>' +
      stores.map(function(st){return '<option value="' + st.store + '" ' + (st.store === s.storeFilter ? "selected" : "") + '>' + st.store + ' (' + fmt$(st.rev) + ')</option>';}).join("");
  } else {
    storeSel.innerHTML = '<option value="all">All external stores</option>';
  }

  var data = computeOwnedVsMarket();
  if (!data) {
    document.getElementById("ovm-content").style.display = "none";
    document.getElementById("ovm-empty").style.display = "block";
    document.getElementById("ovm-banner").innerHTML = "";
    return;
  }
  document.getElementById("ovm-content").style.display = "block";
  document.getElementById("ovm-empty").style.display = "none";

  var parts = [];
  if (data.am) parts.push('Amazon <strong>' + data.am.label + '</strong>');
  if (data.sh) parts.push('Shopify <strong>' + data.sh.label + '</strong>');
  var mkt = (s.storeFilter && s.storeFilter !== "all")
    ? '<strong>' + s.storeFilter + '</strong> (' + data.ex.label + ')'
    : 'Market <strong>' + data.ex.label + '</strong>';
  parts.push("vs " + mkt);
  document.getElementById("ovm-banner").innerHTML = parts.join(" + ");

  // Summary cards
  var totalOwned = data.rows.reduce(function(a, r){return a + r.yourRev;}, 0);
  var totalMkt = data.rows.reduce(function(a, r){return a + r.mktRev;}, 0);
  var overlap = data.rows.filter(function(r){return r.status === "both";}).length;
  var ownedOnly = data.rows.filter(function(r){return r.status === "owned-only";}).length;
  var mktOnly = data.rows.filter(function(r){return r.status === "market-only";}).length;
  document.getElementById("ovm-cards").innerHTML = [
    '<div class="card"><div class="label">Your revenue</div><div class="value" style="color:#2e7d32">' + fmt$(totalOwned) + '</div></div>',
    '<div class="card"><div class="label">Market revenue (est.)</div><div class="value" style="color:#e65100">' + fmt$(totalMkt) + '</div></div>',
    '<div class="card"><div class="label">Both selling</div><div class="value">' + fmtN(overlap) + '</div></div>',
    '<div class="card"><div class="label">You only</div><div class="value">' + fmtN(ownedOnly) + '</div></div>',
    '<div class="card"><div class="label">Market only</div><div class="value">' + fmtN(mktOnly) + '</div></div>'
  ].join("");

  // Grouped bar chart: top 25 by combined revenue
  var chartItems = data.rows.slice(0, 25);
  var ctx = document.getElementById("ovm-chart").getContext("2d");
  if (state.ovm.chart) state.ovm.chart.destroy();
  state.ovm.chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: chartItems.map(function(r){return r.genus;}),
      datasets: [
        {label: "Your revenue", data: chartItems.map(function(r){return r.yourRev;}), backgroundColor: "#2e7d32"},
        {label: "Market rev (est.)", data: chartItems.map(function(r){return r.mktRev;}), backgroundColor: "#ff9800"}
      ]
    },
    options: {indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: {legend: {display: true, position: "top"},
        tooltip: {callbacks: {label: function(c){return c.dataset.label + ": " + fmt$(c.parsed.x);}}}},
      scales: {x: {ticks: {callback: fmtAxis}}}}
  });

  // Table
  var search = (document.getElementById("ovm-search").value || "").toLowerCase();
  var filtered = data.rows;
  if (s.rowFilter !== "all") filtered = filtered.filter(function(r){return r.status === s.rowFilter;});
  if (search) filtered = filtered.filter(function(r){return r.genus.toLowerCase().indexOf(search) >= 0;});

  var cols = [
    {label: "Genus", k: "genus"},
    {label: "Type", k: "type"},
    {label: "Your Amazon", k: "amazon", num: true, fmt: fmt$},
    {label: "Your Shopify", k: "shopify", num: true, fmt: fmt$},
    {label: "Your total", k: "yourRev", num: true, fmt: fmt$},
    {label: "Market units", k: "mktUnits", num: true, fmt: fmtN},
    {label: "Market rev (est.)", k: "mktRev", num: true, fmt: fmt$},
    {label: "Market share", k: "marketShare", num: true, fmt: function(v){return (v*100).toFixed(1) + "%";}}
  ];
  var ss = state.ovm.sort;
  filtered.sort(function(a, b){
    var kv = cols[ss.col].k, dir = ss.dir === "asc" ? 1 : -1;
    if (kv === "genus" || kv === "type") return String(a[kv]).localeCompare(String(b[kv])) * dir;
    return ((a[kv] || 0) > (b[kv] || 0) ? 1 : (a[kv] || 0) < (b[kv] || 0) ? -1 : 0) * dir;
  });
  document.getElementById("ovm-thead").innerHTML = cols.map(function(c, i){
    return '<th class="' + (c.num ? "num" : "") + '" data-ovm-sort="' + i + '">' + c.label + (i === ss.col ? (ss.dir === "asc" ? " ▲" : " ▼") : "") + '</th>';
  }).join("");
  document.getElementById("ovm-tbody").innerHTML = filtered.map(function(r){
    var typeBadge = r.type ? '<span class="badge type-' + r.type.toLowerCase().replace(/\s/g, "") + '">' + r.type + '</span>' : "";
    var isSelected = state.ovm.drillGenus === r.genus;
    var rowStyle = isSelected ? ' style="background:#e8f5e9;font-weight:600"' : '';
    return '<tr class="clickable" data-drill-genus="' + r.genus.replace(/"/g,'&quot;') + '"' + rowStyle + '>' + cols.map(function(c){
      if (c.k === "type") return "<td>" + typeBadge + "</td>";
      return '<td class="' + (c.num ? "num" : "") + '">' + (c.fmt ? c.fmt(r[c.k] || 0) : (r[c.k] || "")) + '</td>';
    }).join("") + "</tr>";
  }).join("");
  document.getElementById("ovm-count").textContent = filtered.length + " genera";
  document.getElementById("ovm-thead").querySelectorAll("[data-ovm-sort]").forEach(function(th){
    th.addEventListener("click", function(){
      var idx = +th.dataset.ovmSort;
      if (ss.col === idx) ss.dir = ss.dir === "asc" ? "desc" : "asc";
      else { ss.col = idx; ss.dir = "desc"; }
      renderOwnedVsMarket();
    });
  });
  document.getElementById("ovm-tbody").querySelectorAll("[data-drill-genus]").forEach(function(tr){
    tr.addEventListener("click", function(){
      var g = tr.dataset.drillGenus;
      // Toggle: click again to clear
      state.ovm.drillGenus = (state.ovm.drillGenus === g) ? null : g;
      renderOwnedVsMarket();
      // Scroll to SKU panel so drill result is visible
      var skuPanel = document.getElementById("ovm-plant-tbody");
      if (skuPanel && skuPanel.parentElement) skuPanel.parentElement.parentElement.scrollIntoView({behavior: "smooth", block: "start"});
    });
  });
  // Also render the SKU / plant panel
  renderOvmPlantPanel();
}

function setupOwnedVsMarketHandlers() {
  document.getElementById("ovm-amazon-select").addEventListener("change", function(e){
    state.ovm.amazonId = e.target.value || null; renderOwnedVsMarket();
  });
  document.getElementById("ovm-shopify-select").addEventListener("change", function(e){
    state.ovm.shopifyId = e.target.value || null; renderOwnedVsMarket();
  });
  document.getElementById("ovm-external-select").addEventListener("change", function(e){
    state.ovm.externalId = e.target.value || null;
    state.ovm.storeFilter = "all";
    renderOwnedVsMarket();
  });
  document.getElementById("ovm-store-filter").addEventListener("change", function(e){
    state.ovm.storeFilter = e.target.value || "all"; renderOwnedVsMarket();
  });
  document.getElementById("ovm-preset-amazon").addEventListener("click", function(){
    state.ovm.storeGroupByParent = false;
    state.ovm.storeFilter = "Amazon (MCG)";
    renderOwnedVsMarket();
  });
  document.getElementById("ovm-preset-all").addEventListener("click", function(){
    state.ovm.storeGroupByParent = true;
    state.ovm.storeFilter = "all";
    renderOwnedVsMarket();
  });
  document.getElementById("ovm-search").addEventListener("input", renderOwnedVsMarket);
  document.getElementById("ovm-download").addEventListener("click", downloadOwnedVsMarket);
  var btns = document.querySelectorAll("#tab-ovm [data-ovm-filter]");
  for (var i = 0; i < btns.length; i++) {
    (function(btn){
      btn.addEventListener("click", function(){
        state.ovm.rowFilter = btn.dataset.ovmFilter;
        var all = document.querySelectorAll("#tab-ovm [data-ovm-filter]");
        for (var j = 0; j < all.length; j++) all[j].classList.toggle("active", all[j] === btn);
        renderOwnedVsMarket();
      });
    })(btns[i]);
  }
}

function downloadOwnedVsMarket() {
  var data = computeOwnedVsMarket();
  if (!data) return;
  var rows = data.rows.map(function(r){
    return {
      Genus: r.genus, Type: r.type,
      "Your Amazon": r.amazon.toFixed(2),
      "Your Shopify": r.shopify.toFixed(2),
      "Your Total": r.yourRev.toFixed(2),
      "Market Units": r.mktUnits,
      "Market Rev (est.)": r.mktRev.toFixed(2),
      "Market Share": (r.marketShare * 100).toFixed(1) + "%",
      Status: r.status
    };
  });
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Owned vs Market");
  var label = (data.ex.label || "").replace(/\s+/g, "");
  XLSX.writeFile(wb, "owned-vs-market-" + label + ".xlsx");
}

// ============================================================
// PLANT-LEVEL (SKU) OPPORTUNITIES for Opportunity Map
// ============================================================

// Normalize a plant title for cross-channel matching.
// Lowercase, strip punctuation, drop noise words, keep first meaningful terms.
function normPlantTitle(t) {
  if (!t) return "";
  var s = String(t).toLowerCase();
  // Strip content in parentheses/brackets
  s = s.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  // Drop common marketing/format noise
  s = s.replace(/\b(live plant|live plants|in \d+ inch pot|inch pot|inch pots|potted|starter|cutting|cuttings|variety pack|bulk pack|pack|plants|plant|bare root|large|small|mini|xl|succulent|succulents|cactus|cacti|houseplant|houseplants|air plant|airplant|extra large|premium|4 pot|2 pot|4 in|2 in|4\"|2\"|from|the)\b/g, " ");
  // Strip punctuation
  s = s.replace(/[^a-z0-9\s]/g, " ");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// Return every match-key a title should be indexed under so cross-channel titles
// with different formats can still be recognized as the same plant.
// e.g. "Senecio rowleyanus - String of Pearls" and "String of Pearls (2 Pot)" match.
function getMatchKeys(title) {
  var keys = [];
  if (!title) return keys;
  var full = normPlantTitle(title);
  if (full) keys.push(full);
  var low = String(title).toLowerCase();
  // Distinctive quoted variety: e.g. 'Perle Von Nurnberg'
  var mQuote = title.match(/[‘’'"`]([^‘’'"`]{3,50})[‘’'"`]/);
  if (mQuote) {
    var q = mQuote[1].toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    if (q.length >= 3) keys.push(q);
  }
  // Common names from COMMON_NAMES table (String of Pearls, Snake Plant, etc.)
  if (typeof COMMON_NAMES !== "undefined") {
    for (var i = 0; i < COMMON_NAMES.length; i++) {
      var phrase = COMMON_NAMES[i][0];
      if (phrase && phrase.length >= 4 && low.indexOf(phrase.toLowerCase()) >= 0) {
        keys.push(phrase.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim());
      }
    }
  }
  // Last dash-separated segment (often the marketable name): "Senecio rowleyanus - String of Pearls" -> "string of pearls"
  var parts = title.split(/\s*[-–—]\s*/);
  if (parts.length > 1) {
    var lastSeg = normPlantTitle(parts[parts.length - 1]);
    if (lastSeg && lastSeg.length >= 4 && keys.indexOf(lastSeg) < 0) keys.push(lastSeg);
  }
  return keys;
}

// Build an index of Owned plant titles for fast lookup
function buildOwnedTitleIndex() {
  var s = state.oppmap;
  var owned = new Map(); // any-match-key -> {sources, titles, rev, units, inCatalog, inv}
  function add(products, channel, isCat) {
    for (var i = 0; i < products.length; i++) {
      var p = products[i];
      var keys = getMatchKeys(p.title);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (!key || key.length < 3) continue;
        if (!owned.has(key)) owned.set(key, {sources:{}, titles:[], rev:0, units:0, inCatalog:false, inv:0});
        var rec = owned.get(key);
        if (isCat) {
          rec.inCatalog = true;
          rec.inv += (p.inv || 0);
        } else {
          rec.sources[channel] = true;
          if (rec.titles.indexOf(p.title) < 0 && rec.titles.length < 3) rec.titles.push(p.title);
          if (k === 0) { rec.rev += (p.rev || 0); rec.units += (p.units || 0); }
        }
      }
    }
  }
  var am = s.amazonId ? snapshots.find(function(x){return x.id===s.amazonId;}) : null;
  var sh = s.shopifyId ? snapshots.find(function(x){return x.id===s.shopifyId;}) : null;
  if (am) add(am.products, "amazon", false);
  if (sh) add(sh.products, "shopify", false);
  // Catalog snapshots (always applied, regardless of period)
  var cats = catalogSnapshots();
  for (var i = 0; i < cats.length; i++) add(cats[i].products, cats[i].source, true);
  return owned;
}

// Compute per-plant opportunities from Market side
function computePlantOpportunities() {
  var s = state.oppmap;
  var ex = s.externalId ? snapshots.find(function(x){return x.id===s.externalId;}) : null;
  if (!ex) return null;
  var extProducts = ex.products;
  if (s.storeFilter && s.storeFilter !== "all") {
    extProducts = extProducts.filter(function(p){
      return s.storeGroupByParent ? p.store === s.storeFilter : p.rawStore === s.storeFilter;
    });
  }
  var plants = aggregateExternalByPlant(extProducts);
  var ownedIdx = buildOwnedTitleIndex();
  var out = [];
  for (var i = 0; i < plants.length; i++) {
    var p = plants[i];
    var key = normPlantTitle(p.title);
    var match = ownedIdx.get(key);
    var yourSources = match ? Object.keys(match.sources).join("+") : "";
    var yourRev = match ? match.rev : 0;
    var yourUnits = match ? match.units : 0;
    var status = match ? "both" : "missing";
    var signal;
    if (!match) signal = "red";
    else if (p.units >= yourUnits * 3) signal = "orange";
    else if (yourUnits >= p.units * 2) signal = "green";
    else signal = "yellow";
    var type = getItemType(p.genus, p.title);
    var isPlant = p.genus && p.genus !== "(no genus)";
    out.push({
      title: p.title, sku: p.sku,
      genus: isPlant ? p.genus : "—",
      type: type,
      isPlant: isPlant,
      mktUnits: p.units, mktRev: p.estRev, mktOrders: p.orders, mktStores: p.storeCount,
      yourSources: yourSources, yourRev: yourRev, yourUnits: yourUnits,
      status: status, signal: signal
    });
  }
  return out;
}

function renderPlantOpportunities() {
  var rows = computePlantOpportunities();
  if (!rows) {
    document.getElementById("oppmap-plant-tbody").innerHTML = '<tr><td colspan="10" class="empty">Load an External snapshot to see plant-level opportunities.</td></tr>';
    document.getElementById("oppmap-plant-thead").innerHTML = "";
    document.getElementById("oppmap-plant-count").textContent = "";
    return;
  }
  var s = state.oppmap;
  var search = (document.getElementById("oppmap-plant-search").value || "").toLowerCase();
  var filtered = rows.filter(function(r){return r.mktUnits >= s.plantThreshold;});
  if (s.plantFilter === "missing") filtered = filtered.filter(function(r){return r.status === "missing";});
  else if (s.plantFilter === "both") filtered = filtered.filter(function(r){return r.status === "both";});
  if (search) filtered = filtered.filter(function(r){return (r.title || "").toLowerCase().indexOf(search) >= 0 || (r.sku || "").toLowerCase().indexOf(search) >= 0;});

  var cols = [
    {label: "Plant", k: "title"},
    {label: "SKU", k: "sku"},
    {label: "Genus", k: "genus"},
    {label: "Type", k: "type"},
    {label: "Mkt units", k: "mktUnits", num: true, fmt: fmtN},
    {label: "Mkt rev (est.)", k: "mktRev", num: true, fmt: fmt$},
    {label: "Mkt orders", k: "mktOrders", num: true, fmt: fmtN},
    {label: "Stores", k: "mktStores", num: true, fmt: fmtN},
    {label: "You sell it?", k: "status"},
    {label: "Your units", k: "yourUnits", num: true, fmt: fmtN}
  ];
  var ss = s.plantSort;
  filtered.sort(function(a, b){
    var kv = cols[ss.col].k, dir = ss.dir === "asc" ? 1 : -1;
    var av = a[kv], bv = b[kv];
    if (typeof av === "string") return String(av).localeCompare(String(bv)) * dir;
    return ((av || 0) > (bv || 0) ? 1 : (av || 0) < (bv || 0) ? -1 : 0) * dir;
  });
  document.getElementById("oppmap-plant-thead").innerHTML = cols.map(function(c, i){
    return '<th class="' + (c.num ? "num" : "") + '" data-plant-sort="' + i + '">' + c.label + (i === ss.col ? (ss.dir === "asc" ? " ▲" : " ▼") : "") + '</th>';
  }).join("");
  document.getElementById("oppmap-plant-tbody").innerHTML = filtered.slice(0, 500).map(function(r){
    var typeBadge = r.type ? '<span class="badge type-' + r.type.toLowerCase().replace(/\s/g, "") + '">' + r.type + '</span>' : "";
    var restricted = (typeof isRestricted === "function") && isRestricted(r.sku, r.title);
    var statusBadge;
    if (restricted) statusBadge = '<span class="badge restricted" title="On MCG exclusion list — you cannot sell this">🚫 can\'t sell</span>';
    else if (r.status === "missing") statusBadge = '<span class="badge sig-red">🔴 not found</span>';
    else statusBadge = '<span class="badge sig-green">🟢 ' + (r.yourSources || "yes") + '</span>';
    var rowCls = restricted ? "restricted-row" : "";
    return '<tr class="' + rowCls + '">' + cols.map(function(c){
      if (c.k === "type") return "<td>" + typeBadge + "</td>";
      if (c.k === "status") return "<td>" + statusBadge + "</td>";
      return '<td class="' + (c.num ? "num" : "") + '">' + (c.fmt ? c.fmt(r[c.k] || 0) : (r[c.k] || "")) + '</td>';
    }).join("") + "</tr>";
  }).join("");
  document.getElementById("oppmap-plant-count").textContent = filtered.length + " plants";
  document.getElementById("oppmap-plant-thead").querySelectorAll("[data-plant-sort]").forEach(function(th){
    th.addEventListener("click", function(){
      var idx = +th.dataset.plantSort;
      if (ss.col === idx) ss.dir = ss.dir === "asc" ? "desc" : "asc";
      else { ss.col = idx; ss.dir = "desc"; }
      renderPlantOpportunities();
    });
  });
}

function downloadPlantOpportunities() {
  var rows = computePlantOpportunities();
  if (!rows) return;
  var filtered = rows.filter(function(r){return r.mktUnits >= state.oppmap.plantThreshold;});
  var csv = "Plant,SKU,Genus,Type,Market Units,Market Rev (est.),Market Orders,Stores,You Sell It,Your Sources,Your Units,Your Rev,Status,Signal\n" +
    filtered.map(function(r){
      var esc = function(v){var s=String(v==null?"":v);return s.indexOf(",")>=0||s.indexOf('"')>=0 ? '"'+s.replace(/"/g,'""')+'"' : s;};
      return [esc(r.title), esc(r.sku), esc(r.genus), esc(r.type),
        r.mktUnits, r.mktRev.toFixed(2), r.mktOrders, r.mktStores,
        r.status === "both" ? "yes" : "no", esc(r.yourSources), r.yourUnits, r.yourRev.toFixed(2),
        r.status, r.signal].join(",");
    }).join("\n");
  var blob = new Blob([csv], {type: "text/csv"});
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = "plant-opportunities.csv"; a.click();
  URL.revokeObjectURL(url);
}

function setupPlantOppHandlers() {
  document.getElementById("oppmap-plant-search").addEventListener("input", renderPlantOpportunities);
  document.getElementById("oppmap-plant-download").addEventListener("click", downloadPlantOpportunities);
  var fBtns = document.querySelectorAll("#tab-oppmap [data-plant-filter]");
  for (var i = 0; i < fBtns.length; i++) {
    (function(btn){
      btn.addEventListener("click", function(){
        state.oppmap.plantFilter = btn.dataset.plantFilter;
        var all = document.querySelectorAll("#tab-oppmap [data-plant-filter]");
        for (var j = 0; j < all.length; j++) all[j].classList.toggle("active", all[j] === btn);
        renderPlantOpportunities();
      });
    })(fBtns[i]);
  }
  var tBtns = document.querySelectorAll("#tab-oppmap [data-plant-thresh]");
  for (var i = 0; i < tBtns.length; i++) {
    (function(btn){
      btn.addEventListener("click", function(){
        state.oppmap.plantThreshold = +btn.dataset.plantThresh;
        var all = document.querySelectorAll("#tab-oppmap [data-plant-thresh]");
        for (var j = 0; j < all.length; j++) all[j].classList.toggle("active", all[j] === btn);
        renderPlantOpportunities();
      });
    })(tBtns[i]);
  }
}

// ============================================================
// SHARED: SKU-level plant panel (used by Owned vs Market and Cross-channel)
// ============================================================

// Compute per-plant/SKU comparison of Owned combined vs Market
// (mirrors computePlantOpportunities but exposed for Owned vs Market tab)
// Extract meaningful words from a title for fuzzy overlap matching.
// Drops short words and stopwords like "plant", "cactus", "large", etc.
var _OVM_STOPS = new Set(["the","and","for","plant","succulent","cactus","live","large","small","extra","mini","xl","bare","root","plug","limited","exclusive","unrooted","landscape","quality","var","ssp","spp","from","with","type","form","cutting","cuttings","potted","pot","pots","inch","houseplant","houseplants","air","airplant","premium","enhanced","hardy","assorted","variety","pack","bundle","genus","specimen","rare"]);
// Variety modifiers — colors, shapes, culitvar hints that distinguish sub-variants.
// If BOTH titles have one, they must match (otherwise it's a different sub-variant).
var _OVM_VARIETY = new Set([
  "red","blue","pink","gold","silver","purple","green","yellow","orange",
  "black","white","mint","ruby","lime","cream","rose","tan","teal","cyan",
  "jade","wine","peach","aqua","gray","grey","brown","copper","bronze",
  "tricolor","bicolor","variegated","albino","monstrose","cristata","crested",
  "spiral","spiralis","variegata","aurea","alba","rubra","viridis",
  "dwarf","giant","frizzle","curly","fuzzy","hairy","spiky"
]);
function ovmKeyWords(title) {
  var s = String(title || "").toLowerCase();
  s = s.replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " ");
  s = s.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  var words = s.split(" ");
  var out = new Set();
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (w.length >= 4 && !_OVM_STOPS.has(w)) out.add(w);
  }
  return out;
}
// Extract variety-modifier words from a title (INCLUDING content in parens, since
// "Tillandsia ionantha (red, enhanced)" has "red" in parens — a variety marker).
function ovmVarietyWords(title) {
  var s = String(title || "").toLowerCase();
  // Keep paren/bracket contents for variety extraction
  s = s.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  var out = new Set();
  var words = s.split(" ");
  for (var i = 0; i < words.length; i++) {
    if (_OVM_VARIETY.has(words[i])) out.add(words[i]);
  }
  return out;
}
function ovmOverlapCount(a, b) {
  var n = 0; a.forEach(function(w){ if (b.has(w)) n++; });
  return n;
}
// Returns true if variety modifiers are compatible:
//   both empty → OK
//   one empty → OK (could be same plant, other just doesn't specify)
//   both non-empty → must share at least one variety word
function ovmVarietyCompatible(vA, vB) {
  if (vA.size === 0 || vB.size === 0) return true;
  var shared = 0;
  vA.forEach(function(w){ if (vB.has(w)) shared++; });
  return shared > 0;
}

function computeOvmPlantRows() {
  var s = state.ovm;
  var ex = s.externalId ? snapshots.find(function(x){return x.id===s.externalId;}) : null;
  var am = s.amazonId ? snapshots.find(function(x){return x.id===s.amazonId;}) : null;
  var sh = s.shopifyId ? snapshots.find(function(x){return x.id===s.shopifyId;}) : null;
  if (!ex) return null;
  var extProducts = ex.products;
  if (s.storeFilter && s.storeFilter !== "all") {
    extProducts = extProducts.filter(function(p){
      return s.storeGroupByParent ? p.store === s.storeFilter : p.rawStore === s.storeFilter;
    });
  }
  // Build owned index. Each owned plant is indexed under:
  //   (a) every match key from getMatchKeys (normalized full title + common names + variety + last dash-segment)
  //   (b) added to an ownedList for word-set fuzzy fallback lookup
  var owned = new Map();
  var ownedBySku = new Map();  // SKU -> rec (authoritative match key)
  var ownedList = [];
  function addOwned(products, channel) {
    for (var i = 0; i < products.length; i++) {
      var p = products[i];
      var keys = (typeof getMatchKeys === "function") ? getMatchKeys(p.title) : [normPlantTitle(p.title)];
      if (!keys.length) continue;
      var primaryKey = keys[0];
      if (!primaryKey || primaryKey.length < 3) continue;
      var rec;
      if (owned.has(primaryKey)) {
        rec = owned.get(primaryKey);
        rec.sources[channel] = true;
        rec.rev += (p.rev || 0);
        rec.units += (p.units || 0);
        if (rec.titles.indexOf(p.title) < 0 && rec.titles.length < 3) rec.titles.push(p.title);
      } else {
        rec = {sources: {}, titles: [p.title], rev: p.rev || 0, units: p.units || 0, skus: []};
        rec.sources[channel] = true;
        owned.set(primaryKey, rec);
      }
      // Track SKUs on the record
      var pSku = String(p.sku || p.asin || "").toUpperCase().trim();
      if (pSku) {
        if (!rec.skus) rec.skus = [];
        if (rec.skus.indexOf(pSku) < 0) rec.skus.push(pSku);
        // Store ALL SB products for this SKU (may be multiple with different titles)
        // so lookup can pick the best title match rather than first-wins.
        if (!ownedBySku.has(pSku)) ownedBySku.set(pSku, []);
        ownedBySku.get(pSku).push({rec: rec, title: p.title, words: ovmKeyWords(p.title)});
      }
      // Register secondary keys → this same rec (only if unclaimed)
      for (var k = 1; k < keys.length; k++) {
        var key = keys[k];
        if (!key || key.length < 3) continue;
        if (!owned.has(key)) owned.set(key, rec);
      }
      ownedList.push({
        title: p.title,
        sku: pSku,
        words: ovmKeyWords(p.title),
        variety: ovmVarietyWords(p.title),
        rec: rec
      });
    }
  }
  if (am) addOwned(am.products, "amazon");
  if (sh) addOwned(sh.products, "shopify");
  // Include uploaded catalog snapshots (Shopify products.csv exports) — optional
  if (typeof catalogSnapshots === "function") {
    var cats = catalogSnapshots();
    for (var ci = 0; ci < cats.length; ci++) addOwned(cats[ci].products, cats[ci].source || "shopify");
  }
  // Include LIVE SB catalog from succulentsbox.com/products.json (auto-fetched, no upload needed)
  if (typeof sbLiveCatalogProducts === "function") {
    var live = sbLiveCatalogProducts();
    if (live && live.length) addOwned(live, "shopify");
  }
  var plants = aggregateExternalByPlant(extProducts);
  var out = [];
  // Helper: SKU exact match first, then title exact, then fuzzy word-overlap.
  // Also detects when title matches but SKUs differ (potential wrong-SKU on listing).
  // Returns {rec, matchKind: 'sku'|'title'|'fuzzy', skuMismatch: bool}
  function findOwnedMatch(mktSku, title) {
    var mktSkuU = String(mktSku || "").toUpperCase().trim();
    // 1) SKU exact match. If multiple SB products share this SKU (different titles),
    //    pick the one whose title best matches the market title (word overlap).
    if (mktSkuU && ownedBySku.has(mktSkuU)) {
      var candidates = ownedBySku.get(mktSkuU);
      if (candidates.length === 1) {
        return {rec: candidates[0].rec, matchKind: 'sku', skuMismatch: false};
      }
      var mktWords = ovmKeyWords(title);
      var best = candidates[0], bestScore = -1;
      for (var c = 0; c < candidates.length; c++) {
        var score = ovmOverlapCount(mktWords, candidates[c].words);
        if (score > bestScore) { best = candidates[c]; bestScore = score; }
      }
      return {rec: best.rec, matchKind: 'sku', skuMismatch: false};
    }
    // 2) Title exact key match
    if (typeof getMatchKeys === "function") {
      var keys = getMatchKeys(title);
      for (var i = 0; i < keys.length; i++) {
        if (owned.has(keys[i])) {
          var rec = owned.get(keys[i]);
          var mismatch = mktSkuU && rec.skus && rec.skus.length && rec.skus.indexOf(mktSkuU) < 0;
          return {rec: rec, matchKind: 'title', skuMismatch: !!mismatch};
        }
      }
    }
    // 3) Fuzzy fallback with variety compatibility
    var mktWords = ovmKeyWords(title);
    var mktVar = ovmVarietyWords(title);
    if (mktWords.size < 2) return null;
    var best = null, bestScore = 1;
    for (var j = 0; j < ownedList.length; j++) {
      var o = ownedList[j];
      var score = ovmOverlapCount(mktWords, o.words);
      if (score >= 2 && score > bestScore) {
        if (ovmVarietyCompatible(mktVar, o.variety)) {
          best = o.rec; bestScore = score;
        }
      }
    }
    if (best) return {rec: best, matchKind: 'fuzzy', skuMismatch: false};
    return null;
  }
  for (var i = 0; i < plants.length; i++) {
    var p = plants[i];
    var found = findOwnedMatch(p.sku, p.title);
    var match = found ? found.rec : null;
    var matchKind = found ? found.matchKind : null;
    // "SKU mismatch worth flagging" = title matches but SKUs differ AND owned had 0 sales.
    // Reason: if owned sold >0, the vendor probably fulfilled it from another source (fine).
    // If owned sold 0, the SKU on the listing may be wrong — worth checking.
    var skuFlagWorthy = found && found.skuMismatch && match && (match.units || 0) === 0 && (match.rev || 0) === 0;
    var isPlant = p.genus && p.genus !== "(no genus)";
    var type = getItemType(p.genus, p.title);
    var soldMatch = match && (match.units > 0 || match.rev > 0);
    var status;
    if (soldMatch) status = "both";
    else status = "missing";
    out.push({
      title: p.title, sku: p.sku,
      genus: isPlant ? p.genus : "—",
      type: type, isPlant: isPlant,
      mktUnits: p.units, mktRev: p.estRev, mktOrders: p.orders, mktStores: p.storeCount,
      yourUnits: match ? match.units : 0,
      yourRev: match ? match.rev : 0,
      yourSources: match ? Object.keys(match.sources).join("+") : "",
      yourSkus: match && match.skus ? match.skus.slice() : [],
      matchKind: matchKind,
      skuMismatchFlag: !!skuFlagWorthy,
      status: status
    });
  }
  return out;
}

function renderOvmPlantPanel() {
  var rows = computeOvmPlantRows();
  var tbody = document.getElementById("ovm-plant-tbody");
  var thead = document.getElementById("ovm-plant-thead");
  var count = document.getElementById("ovm-plant-count");
  if (!tbody) return;
  if (!rows) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">Load an External snapshot to see plant-level comparison.</td></tr>';
    thead.innerHTML = ""; count.textContent = ""; return;
  }
  var s = state.ovm;
  var search = (document.getElementById("ovm-plant-search").value || "").toLowerCase();
  // If a genus was clicked in the per-genus table, filter to that genus only
  // (and relax the min-units threshold so all plants in that genus are visible).
  var drill = s.drillGenus;
  var filtered = rows;
  if (drill) {
    filtered = filtered.filter(function(r){return r.genus === drill;});
  } else {
    filtered = filtered.filter(function(r){return r.mktUnits >= (s.plantThreshold || 10);});
  }
  if (s.plantFilter === "missing") filtered = filtered.filter(function(r){return r.status === "missing";});
  else if (s.plantFilter === "both") filtered = filtered.filter(function(r){return r.status === "both";});
  else if (s.plantFilter === "nonplant") filtered = filtered.filter(function(r){return !r.isPlant;});
  else if (s.plantFilter === "restricted") filtered = filtered.filter(function(r){
    return typeof isRestricted === "function" && isRestricted(r.sku, r.title);
  });
  else if (s.plantFilter === "carried-nosales") {
    // Only rows where SB carries but had 0 sales this period.
    // Signal: r.status === "missing" AND MCG data says NOT sbOos and NOT mcgOnly.
    var mcgReady = (typeof MCG_STATE !== "undefined") && !!MCG_STATE.data;
    if (!mcgReady) filtered = [];
    else filtered = filtered.filter(function(r){
      if (r.status !== "missing") return false;
      if (typeof isRestricted === "function" && isRestricted(r.sku, r.title)) return false;
      var hit = (typeof mcgFindMatch === "function") ? mcgFindMatch(r.sku, r.title) : null;
      // "carried but 0 sales" = missing from sales AND not flagged by MCG tracker as OOS or not-in-SB
      return !hit;
    });
  }
  if (search) filtered = filtered.filter(function(r){return (r.title||"").toLowerCase().indexOf(search)>=0 || (r.sku||"").toLowerCase().indexOf(search)>=0;});
  // Sort per user selection (default col 4 = Mkt units, desc)
  var _ovmPS = s.plantSort || {col: 4, dir: 'desc'};
  var _ovmCols = [
    {k:"title"},{k:"sku"},{k:"genus"},{k:"type"},
    {k:"mktUnits"},{k:"mktRev"},{k:"status"},{k:"yourUnits"},{k:"yourRev"}
  ];
  var _ovmSortKey = _ovmCols[_ovmPS.col].k;
  filtered.sort(function(a, b){
    var av = a[_ovmSortKey], bv = b[_ovmSortKey];
    var dir = _ovmPS.dir === 'asc' ? 1 : -1;
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av||'').localeCompare(String(bv||'')) * dir;
    }
    return ((av||0) > (bv||0) ? 1 : (av||0) < (bv||0) ? -1 : 0) * dir;
  });
  // Reflect drill state in the count pill
  var pillEl = document.getElementById("ovm-plant-count");
  if (drill) {
    pillEl.innerHTML = filtered.length + ' items in <strong style="color:#2e7d32">' + drill + '</strong> <button class="tab danger" id="ovm-plant-clear-drill" style="margin-left:8px;padding:2px 8px">Clear</button>';
    setTimeout(function(){
      var btn = document.getElementById("ovm-plant-clear-drill");
      if (btn) btn.addEventListener("click", function(){
        state.ovm.drillGenus = null;
        renderOwnedVsMarket();
      });
    }, 0);
  }

  var cols = [
    {label: "Plant / Item", k: "title"},
    {label: "SKU", k: "sku"},
    {label: "Genus", k: "genus"},
    {label: "Type", k: "type"},
    {label: "Mkt units", k: "mktUnits", num: true, fmt: fmtN},
    {label: "Mkt rev (est.)", k: "mktRev", num: true, fmt: fmt$},
    {label: "You sell it?", k: "status"},
    {label: "Your units", k: "yourUnits", num: true, fmt: fmtN},
    {label: "Your rev", k: "yourRev", num: true, fmt: fmt$}
  ];
  thead.innerHTML = cols.map(function(c, i){
    var arrow = i === _ovmPS.col ? (_ovmPS.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return '<th class="' + (c.num?"num":"") + '" data-ovm-plant-sort="' + i + '">' + c.label + arrow + '</th>';
  }).join("");
  tbody.innerHTML = filtered.slice(0, 500).map(function(r){
    var typeBadge = r.type ? '<span class="badge type-' + r.type.toLowerCase().replace(/[\s\/]/g,"") + '">' + r.type + '</span>' : "";
    var restricted = (typeof isRestricted === "function") && isRestricted(r.sku, r.title);
    var mcgHit = (typeof mcgFindMatch === "function") ? mcgFindMatch(r.sku, r.title) : null;
    var statusBadge;
    var mismatchTag = (mcgHit && mcgHit.skuMismatch) ? ' <span class="badge sig-yellow" title="Title matches but SKUs differ (your ' + (mcgHit.yourSku || "?") + ' vs MCG ' + (mcgHit.theirSku || "?") + ') — possible duplicate SKU / variant confusion">⚠ SKU mismatch</span>' : '';
    var mcgLoaded = (typeof MCG_STATE !== "undefined") && !!MCG_STATE.data;
    // "SKU mismatch" tag: catalog title matches but SKUs differ AND owned had 0 sales →
    // suggests the SKU on your listing might be wrong / needs updating.
    var skuTag = r.skuMismatchFlag
      ? ' <span class="badge sig-yellow" title="Title matches SB catalog but SKU differs (yours: ' + (r.yourSkus||[]).join(", ") + ' vs market: ' + (r.sku||"?") + '). 0 sales suggests SKU may be wrong on the listing.">⚠ check SKU</span>'
      : '';
    if (restricted) {
      statusBadge = '<span class="badge restricted" title="On MCG exclusion list — you cannot sell this">🚫 can\'t sell</span>';
    } else if (r.status !== "missing") {
      statusBadge = '<span class="badge sig-green">🟢 sold on ' + (r.yourSources || "yes") + '</span>' + mismatchTag;
    } else if (r.skuMismatchFlag) {
      // Catalog match but 0 sales + SKU mismatch — actionable listing issue
      statusBadge = '<span class="badge sig-orange" title="Your catalog has this title (SKU ' + (r.yourSkus||[]).join(", ") + ') but the market SKU is ' + (r.sku||"?") + '. Check if listing SKU needs updating.">🟠 SKU mismatch — 0 sales</span>';
    } else if (mcgHit && mcgHit.status === "sbOos") {
      statusBadge = '<span class="badge sig-orange" title="You carry this but SB is out of stock — turn on!">🟠 SB OOS — turn on</span>' + mismatchTag;
    } else if (mcgHit && mcgHit.status === "mcgOnly") {
      statusBadge = '<span class="badge sig-red">🔴 not carried by SB</span>' + mismatchTag;
    } else if (mcgLoaded) {
      statusBadge = '<span class="badge sig-yellow" title="SB carries this and it is in stock — just no sales this period">🟡 carried, 0 sales</span>';
    } else {
      statusBadge = '<span class="badge sig-red">🔴 not found</span>';
    }
    // Append skuTag to green (sold) case only if not already handled by SKU-mismatch branch
    if (r.status !== "missing" && r.skuMismatchFlag) statusBadge += skuTag;
    var rowCls = restricted ? "restricted-row" : "";
    return '<tr class="' + rowCls + '">' + cols.map(function(c){
      if (c.k === "type") return "<td>" + typeBadge + "</td>";
      if (c.k === "status") return "<td>" + statusBadge + "</td>";
      return '<td class="' + (c.num?"num":"") + '">' + (c.fmt ? c.fmt(r[c.k] || 0) : (r[c.k] || "")) + '</td>';
    }).join("") + "</tr>";
  }).join("");
  // Wire header clicks for sort toggle
  thead.querySelectorAll("[data-ovm-plant-sort]").forEach(function(th){
    th.addEventListener("click", function(){
      var idx = +th.dataset.ovmPlantSort;
      if (_ovmPS.col === idx) _ovmPS.dir = _ovmPS.dir === 'asc' ? 'desc' : 'asc';
      else { _ovmPS.col = idx; _ovmPS.dir = 'desc'; }
      s.plantSort = _ovmPS;
      renderOvmPlantPanel();
    });
  });
  // Only set plain count text if drill isn't active (drill already renders its own pill with Clear button)
  if (!drill) count.textContent = filtered.length + " items";
}

// Cross-channel plant panel: Amazon vs Shopify per SKU
function computeCrossPlantRows() {
  var am = state.cross.amazonId ? snapshots.find(function(x){return x.id===state.cross.amazonId;}) : null;
  var sh = state.cross.shopifyId ? snapshots.find(function(x){return x.id===state.cross.shopifyId;}) : null;
  if (!am && !sh) return null;
  var byTitle = new Map();
  function add(products, channel) {
    for (var i = 0; i < products.length; i++) {
      var p = products[i];
      var key = normPlantTitle(p.title);
      if (!key || key.length < 3) continue;
      if (!byTitle.has(key)) byTitle.set(key, {title: p.title, sku: p.asin || "", genus: p.genus || "(no genus)",
                                                amazon: {rev:0, units:0}, shopify: {rev:0, units:0}});
      var rec = byTitle.get(key);
      rec[channel].rev += (p.rev || 0);
      rec[channel].units += (p.units || 0);
      if (!rec.sku && p.asin) rec.sku = p.asin;
      if (rec.genus === "(no genus)" && p.genus && p.genus !== "(no genus)") rec.genus = p.genus;
    }
  }
  if (am) add(am.products, "amazon");
  if (sh) add(sh.products, "shopify");
  var out = [];
  byTitle.forEach(function(r){
    var isPlant = r.genus && r.genus !== "(no genus)";
    var type = getItemType(r.genus, r.title);
    var status;
    if (r.amazon.units > 0 && r.shopify.units > 0) status = "both";
    else if (r.amazon.units > 0) status = "amazon-only";
    else status = "shopify-only";
    out.push({title: r.title, sku: r.sku,
              genus: isPlant ? r.genus : "—", type: type, isPlant: isPlant,
              amazonRev: r.amazon.rev, amazonUnits: r.amazon.units,
              shopifyRev: r.shopify.rev, shopifyUnits: r.shopify.units,
              status: status});
  });
  return out;
}

function renderCrossPlantPanel() {
  var rows = computeCrossPlantRows();
  var tbody = document.getElementById("cross-plant-tbody");
  var thead = document.getElementById("cross-plant-thead");
  var count = document.getElementById("cross-plant-count");
  if (!tbody) return;
  if (!rows) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">Pick Amazon and/or Shopify snapshots to see plant-level comparison.</td></tr>';
    thead.innerHTML = ""; count.textContent = ""; return;
  }
  var s = state.ovm;
  var search = (document.getElementById("cross-plant-search").value || "").toLowerCase();
  var filtered = rows;
  if (s.crossPlantFilter === "amazon-only") filtered = filtered.filter(function(r){return r.status === "amazon-only";});
  else if (s.crossPlantFilter === "shopify-only") filtered = filtered.filter(function(r){return r.status === "shopify-only";});
  else if (s.crossPlantFilter === "both") filtered = filtered.filter(function(r){return r.status === "both";});
  else if (s.crossPlantFilter === "nonplant") filtered = filtered.filter(function(r){return !r.isPlant;});
  if (search) filtered = filtered.filter(function(r){return (r.title||"").toLowerCase().indexOf(search)>=0 || (r.sku||"").toLowerCase().indexOf(search)>=0;});
  var cols = [
    {label: "Plant / Item", k: "title"},
    {label: "SKU / ASIN", k: "sku"},
    {label: "Genus", k: "genus"},
    {label: "Type", k: "type"},
    {label: "Amazon units", k: "amazonUnits", num: true, fmt: fmtN},
    {label: "Amazon rev", k: "amazonRev", num: true, fmt: fmt$},
    {label: "Shopify units", k: "shopifyUnits", num: true, fmt: fmtN},
    {label: "Shopify rev", k: "shopifyRev", num: true, fmt: fmt$},
    {label: "Preference", k: "status"}
  ];
  var _cPS = s.crossPlantSort || {col: 5, dir: 'desc'};
  var _cSortKey = cols[_cPS.col].k;
  filtered.sort(function(a, b){
    var av = a[_cSortKey], bv = b[_cSortKey];
    var dir = _cPS.dir === 'asc' ? 1 : -1;
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av||'').localeCompare(String(bv||'')) * dir;
    }
    return ((av||0) > (bv||0) ? 1 : (av||0) < (bv||0) ? -1 : 0) * dir;
  });
  thead.innerHTML = cols.map(function(c, i){
    var arrow = i === _cPS.col ? (_cPS.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return '<th class="' + (c.num?"num":"") + '" data-cross-plant-sort="' + i + '">' + c.label + arrow + '</th>';
  }).join("");
  tbody.innerHTML = filtered.slice(0, 500).map(function(r){
    var typeBadge = r.type ? '<span class="badge type-' + r.type.toLowerCase().replace(/[\s\/]/g,"") + '">' + r.type + '</span>' : "";
    var prefBadge;
    if (r.status === "amazon-only") prefBadge = '<span class="badge amazon">Amazon only</span>';
    else if (r.status === "shopify-only") prefBadge = '<span class="badge shopify">Shopify only</span>';
    else prefBadge = '<span class="badge balanced">Both</span>';
    return "<tr>" + cols.map(function(c){
      if (c.k === "type") return "<td>" + typeBadge + "</td>";
      if (c.k === "status") return "<td>" + prefBadge + "</td>";
      return '<td class="' + (c.num?"num":"") + '">' + (c.fmt ? c.fmt(r[c.k] || 0) : (r[c.k] || "")) + '</td>';
    }).join("") + "</tr>";
  }).join("");
  thead.querySelectorAll("[data-cross-plant-sort]").forEach(function(th){
    th.addEventListener("click", function(){
      var idx = +th.dataset.crossPlantSort;
      if (_cPS.col === idx) _cPS.dir = _cPS.dir === 'asc' ? 'desc' : 'asc';
      else { _cPS.col = idx; _cPS.dir = 'desc'; }
      s.crossPlantSort = _cPS;
      renderCrossPlantPanel();
    });
  });
  count.textContent = filtered.length + " items";
}

function setupExtraSkuHandlers() {
  var ovmSearch = document.getElementById("ovm-plant-search");
  if (ovmSearch) ovmSearch.addEventListener("input", renderOvmPlantPanel);
  var crossSearch = document.getElementById("cross-plant-search");
  if (crossSearch) crossSearch.addEventListener("input", renderCrossPlantPanel);
  var fBtns = document.querySelectorAll("#tab-ovm [data-ovm-plant-filter]");
  for (var i = 0; i < fBtns.length; i++) {
    (function(btn){
      btn.addEventListener("click", function(){
        state.ovm.plantFilter = btn.dataset.ovmPlantFilter;
        var all = document.querySelectorAll("#tab-ovm [data-ovm-plant-filter]");
        for (var j = 0; j < all.length; j++) all[j].classList.toggle("active", all[j] === btn);
        renderOvmPlantPanel();
      });
    })(fBtns[i]);
  }
  var tBtns = document.querySelectorAll("#tab-ovm [data-ovm-plant-thresh]");
  for (var i = 0; i < tBtns.length; i++) {
    (function(btn){
      btn.addEventListener("click", function(){
        state.ovm.plantThreshold = +btn.dataset.ovmPlantThresh;
        var all = document.querySelectorAll("#tab-ovm [data-ovm-plant-thresh]");
        for (var j = 0; j < all.length; j++) all[j].classList.toggle("active", all[j] === btn);
        renderOvmPlantPanel();
      });
    })(tBtns[i]);
  }
  var cBtns = document.querySelectorAll("#tab-cross [data-cross-plant-filter]");
  for (var i = 0; i < cBtns.length; i++) {
    (function(btn){
      btn.addEventListener("click", function(){
        state.ovm.crossPlantFilter = btn.dataset.crossPlantFilter;
        var all = document.querySelectorAll("#tab-cross [data-cross-plant-filter]");
        for (var j = 0; j < all.length; j++) all[j].classList.toggle("active", all[j] === btn);
        renderCrossPlantPanel();
      });
    })(cBtns[i]);
  }
}
// ============================================================
// MCG TRACKER INTEGRATION
// Fetches live "SB out of stock" + "Not in SB" data from sb-mcg-check.netlify.app
// ============================================================
var MCG_STATE = { token: null, tokenExpires: 0, data: null, fetchedAt: 0, error: null, loading: false };
var MCG_CACHE_KEY = "sb-mcg-tracker-cache-v1";
var MCG_CACHE_TTL_MS = 60 * 60 * 1000;  // 1 hour local cache

function mcgConfig() {
  var pwdMeta = document.querySelector('meta[name="sb-mcg-password"]');
  var urlMeta = document.querySelector('meta[name="sb-mcg-url"]');
  return {
    password: pwdMeta ? pwdMeta.content : "",
    baseUrl: urlMeta ? urlMeta.content : "https://sb-mcg-check.netlify.app"
  };
}

function mcgLoadCache() {
  try {
    var raw = localStorage.getItem(MCG_CACHE_KEY);
    if (!raw) return null;
    var d = JSON.parse(raw);
    if (Date.now() - d.fetchedAt > MCG_CACHE_TTL_MS) return null;
    return d;
  } catch(_) { return null; }
}
function mcgSaveCache(data) {
  try { localStorage.setItem(MCG_CACHE_KEY, JSON.stringify({data: data, fetchedAt: Date.now()})); } catch(_){}
}

// Build endpoint URL — supports both same-origin proxy path (/api/mcg) and full external URL
function mcgEndpoint(cfg, name) {
  var base = cfg.baseUrl || "";
  // If baseUrl is the external sb-mcg-check URL, keep the /.netlify/functions/ prefix.
  // If it's the same-origin edge-proxy path (/api/mcg), the redirect already handles the prefix.
  if (base.indexOf("netlify.app") >= 0) return base + "/.netlify/functions/" + name;
  return base + "/" + name;
}



// Build a lookup by SKU (normalized) into "sbOos" or "mcgOnly"
function mcgSkuLookup() {
  var lu = {};
  if (!MCG_STATE.data) return lu;
  var norm = function(s) { return String(s || "").toUpperCase().trim(); };
  (MCG_STATE.data.sbOos || []).forEach(function(x) {
    if (x.sku) lu[norm(x.sku)] = {status: "sbOos", name: x.name, url: x.url};
  });
  (MCG_STATE.data.mcgOnly || []).forEach(function(x) {
    if (x.sku) lu[norm(x.sku)] = {status: "mcgOnly", name: x.name, url: x.url};
  });
  return lu;
}

// Fallback lookup by normalized title (covers SKU-variant mismatches like
// "Frizzle Sizzle" S2KY2965 vs "Frizzle Sizzle [dormant]" S2KY5477).
// Uses the same normPlantTitle + getMatchKeys as the OVM matcher.
function mcgTitleLookup() {
  var lu = {};
  if (!MCG_STATE.data || typeof getMatchKeys !== "function") return lu;
  var add = function(x, status) {
    if (!x.name) return;
    var keys = getMatchKeys(x.name);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k && k.length >= 4 && !lu[k]) lu[k] = {status: status, name: x.name, url: x.url, sku: x.sku};
    }
  };
  (MCG_STATE.data.sbOos || []).forEach(function(x) { add(x, "sbOos"); });
  (MCG_STATE.data.mcgOnly || []).forEach(function(x) { add(x, "mcgOnly"); });
  return lu;
}


// Combined lookup: try SKU first, then title fallback.
// Adds skuMismatch:true when title matches but SKUs differ (variant mix-up flag).
function mcgFindMatch(sku, title) {
  if (!MCG_STATE.data) return null;
  var skuLU = mcgSkuLookup();
  var s = String(sku || "").toUpperCase().trim();
  if (s) {
    if (skuLU[s]) return skuLU[s];
    if (s.length >= 8) {
      for (var k in skuLU) if (k.slice(0,8) === s.slice(0,8)) return skuLU[k];
    }
  }
  if (title && typeof getMatchKeys === "function") {
    var titleLU = mcgTitleLookup();
    var keys = getMatchKeys(title);
    for (var i = 0; i < keys.length; i++) {
      var hit = titleLU[keys[i]];
      if (hit) {
        var hitSku = String(hit.sku || "").toUpperCase().trim();
        if (s && hitSku && s !== hitSku && s.slice(0,8) !== hitSku.slice(0,8)) {
          return Object.assign({}, hit, {skuMismatch: true, yourSku: sku, theirSku: hit.sku});
        }
        return hit;
      }
    }
  }
  return null;
}

async function mcgAuth() {
  var cfg = mcgConfig();
  if (!cfg.password) throw new Error("MCG password not configured");
  var res = await fetch(mcgEndpoint(cfg, "auth"), {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({password: cfg.password})
  });
  var j = await res.json();
  if (!res.ok || !j.token) throw new Error("MCG auth failed: " + (j.error || res.status));
  MCG_STATE.token = j.token;
  MCG_STATE.tokenExpires = Date.now() + 7 * 60 * 60 * 1000;
  return j.token;
}

async function mcgFetch(forceRefresh) {
  if (!forceRefresh) {
    var cached = mcgLoadCache();
    if (cached) { MCG_STATE.data = cached.data; MCG_STATE.fetchedAt = cached.fetchedAt; return cached.data; }
  }
  var cfg = mcgConfig();
  if (!cfg.password) { MCG_STATE.error = "not configured"; return null; }
  MCG_STATE.loading = true;
  MCG_STATE.error = null;
  try {
    if (!MCG_STATE.token || Date.now() > MCG_STATE.tokenExpires) await mcgAuth();
    var url = mcgEndpoint(cfg, "scrape") + (forceRefresh ? "?refresh=true" : "");
    var res = await fetch(url, {headers: {"Authorization": "Bearer " + MCG_STATE.token}});
    if (res.status === 401) {
      await mcgAuth();
      res = await fetch(url, {headers: {"Authorization": "Bearer " + MCG_STATE.token}});
    }
    if (!res.ok) throw new Error("MCG scrape failed: " + res.status);
    var j = await res.json();
    MCG_STATE.data = j;
    MCG_STATE.fetchedAt = Date.now();
    mcgSaveCache(j);
    return j;
  } catch(e) {
    MCG_STATE.error = e.message || String(e);
    console.warn("MCG tracker fetch error:", e);
    return null;
  } finally {
    MCG_STATE.loading = false;
  }
}

function mcgAutoLoad() {
  var cached = mcgLoadCache();
  if (cached) {
    MCG_STATE.data = cached.data;
    MCG_STATE.fetchedAt = cached.fetchedAt;
    if (Date.now() - cached.fetchedAt > 30 * 60 * 1000) {
      mcgFetch(false).then(function(){ if (typeof renderTab === "function") renderTab(activeTab); });
    }
    return;
  }
  var cfg = mcgConfig();
  if (cfg.password) {
    mcgFetch(false).then(function(){ if (typeof renderTab === "function") renderTab(activeTab); });
  }
}

function renderMcgStatus() {
  var el = document.getElementById("ovm-mcg-status");
  if (!el) return;
  var cfg = mcgConfig();
  if (!cfg.password) { el.innerHTML = "MCG Tracker: no password"; return; }
  if (MCG_STATE.loading) { el.innerHTML = "MCG Tracker: loading..."; return; }
  if (MCG_STATE.error) { el.innerHTML = "MCG Tracker error: " + MCG_STATE.error; return; }
  if (MCG_STATE.data) {
    var m = (MCG_STATE.data.mcgOnly || []).length;
    var o = (MCG_STATE.data.sbOos || []).length;
    var age = Math.round((Date.now() - MCG_STATE.fetchedAt) / 60000);
    el.innerHTML = "MCG Tracker: " + o + " SB OOS, " + m + " not in SB (" + age + "min ago)";
  } else {
    el.innerHTML = "MCG Tracker: click button to load";
  }
}

function setupMcgHandlers() {
  var btn = document.getElementById("ovm-mcg-refresh");
  if (!btn) return;
  btn.addEventListener("click", async function() {
    renderMcgStatus();
    await mcgFetch(true);
    renderMcgStatus();
    if (typeof renderTab === "function") renderTab(activeTab);
  });
  renderMcgStatus();
}

(function(){
  var orig = window.renderOwnedVsMarket;
  if (typeof orig === "function") {
    window.renderOwnedVsMarket = function() {
      var r = orig.apply(this, arguments);
      renderMcgStatus();
      return r;
    };
  }
})();

// ============================================================
// OVM Per-SKU CSV download
// ============================================================
function downloadOvmPlants() {
  var rows = computeOvmPlantRows();
  if (!rows || !rows.length) { alert("No SKU data — load Amazon/Shopify + External snapshots first."); return; }
  var s = state.ovm;
  var search = (document.getElementById("ovm-plant-search").value || "").toLowerCase();
  var drill = s.drillGenus;
  var filtered = rows;
  if (drill) filtered = filtered.filter(function(r){return r.genus === drill;});
  else filtered = filtered.filter(function(r){return r.mktUnits >= (s.plantThreshold || 10);});
  if (s.plantFilter === "missing") filtered = filtered.filter(function(r){return r.status === "missing";});
  else if (s.plantFilter === "both") filtered = filtered.filter(function(r){return r.status === "both";});
  else if (s.plantFilter === "nonplant") filtered = filtered.filter(function(r){return !r.isPlant;});
  else if (s.plantFilter === "restricted") filtered = filtered.filter(function(r){return typeof isRestricted === "function" && isRestricted(r.sku, r.title);});
  else if (s.plantFilter === "carried-nosales") {
    var mcgReady = (typeof MCG_STATE !== "undefined") && !!MCG_STATE.data;
    if (!mcgReady) filtered = [];
    else filtered = filtered.filter(function(r){
      if (r.status !== "missing") return false;
      if (typeof isRestricted === "function" && isRestricted(r.sku, r.title)) return false;
      var hit = (typeof mcgFindMatch === "function") ? mcgFindMatch(r.sku, r.title) : null;
      return !hit;
    });
  }
  if (search) filtered = filtered.filter(function(r){return (r.title||"").toLowerCase().indexOf(search)>=0 || (r.sku||"").toLowerCase().indexOf(search)>=0;});
  function statusLabel(r) {
    var restricted = (typeof isRestricted === "function") && isRestricted(r.sku, r.title);
    var mcgHit = (typeof mcgFindMatch === "function") ? mcgFindMatch(r.sku, r.title) : null;
    var mcgLoaded = (typeof MCG_STATE !== "undefined") && !!MCG_STATE.data;
    if (restricted) return "can't sell (exclusion)";
    if (r.status !== "missing") return "sold on " + (r.yourSources || "yes");
    if (mcgHit && mcgHit.status === "sbOos") return "SB out of stock - turn on";
    if (mcgHit && mcgHit.status === "mcgOnly") return "not carried by SB";
    if (mcgLoaded) return "carried, 0 sales";
    return "not found";
  }
  var esc = function(v){var s=String(v==null?"":v);return s.indexOf(",")>=0||s.indexOf('"')>=0||s.indexOf("\n")>=0 ? '"'+s.replace(/"/g,'""')+'"' : s;};
  var header = "Plant,SKU,Genus,Type,Market Units,Market Rev (est.),Market Orders,Market Stores,Status,Your Units,Your Rev,Your Sources\n";
  var body = filtered.map(function(r){
    return [
      esc(r.title), esc(r.sku), esc(r.genus), esc(r.type),
      r.mktUnits, r.mktRev.toFixed(2), r.mktOrders || 0, r.mktStores || 0,
      esc(statusLabel(r)),
      r.yourUnits || 0, (r.yourRev || 0).toFixed(2),
      esc(r.yourSources || "")
    ].join(",");
  }).join("\n");
  var csv = header + body;
  var blob = new Blob([csv], {type: "text/csv"});
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  var suffix = drill ? "-" + drill : "";
  var filterTag = s.plantFilter !== "all" ? "-" + s.plantFilter : "";
  a.href = url;
  a.download = "ovm-plants" + suffix + filterTag + ".csv";
  a.click();
  URL.revokeObjectURL(url);
}
(function(){
  var btn = document.getElementById("ovm-plant-download");
  if (btn) btn.addEventListener("click", downloadOvmPlants);
  else {
    document.addEventListener("DOMContentLoaded", function() {
      var b = document.getElementById("ovm-plant-download");
      if (b) b.addEventListener("click", downloadOvmPlants);
    });
  }
})();

// ============================================================
// SB LIVE CATALOG — fetches all products directly from succulentsbox.com/products.json
// (public Shopify endpoint, CORS-open). No upload needed.
// Cached 24h in localStorage.
// ============================================================
var SB_CATALOG_STATE = { data: null, fetchedAt: 0, loading: false, error: null };
var SB_CATALOG_CACHE_KEY = "sb-live-catalog-cache-v1";
var SB_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

function sbCatalogLoadCache() {
  try {
    var raw = localStorage.getItem(SB_CATALOG_CACHE_KEY);
    if (!raw) return null;
    var d = JSON.parse(raw);
    if (Date.now() - d.fetchedAt > SB_CATALOG_TTL_MS) return null;
    return d;
  } catch(_) { return null; }
}
function sbCatalogSaveCache(products) {
  try {
    var payload = JSON.stringify({products: products, fetchedAt: Date.now()});
    // Compress if lz-string available (catalog can be ~500KB uncompressed)
    if (typeof LZString !== "undefined") {
      localStorage.setItem(SB_CATALOG_CACHE_KEY, LZString.compressToUTF16(payload));
    } else {
      localStorage.setItem(SB_CATALOG_CACHE_KEY, payload);
    }
  } catch(_) {}
}
function sbCatalogLoadCacheDecompress() {
  try {
    var raw = localStorage.getItem(SB_CATALOG_CACHE_KEY);
    if (!raw) return null;
    var text;
    if (typeof LZString !== "undefined") {
      try { text = LZString.decompressFromUTF16(raw); } catch(_) { text = raw; }
    }
    if (!text) text = raw;
    var d = JSON.parse(text);
    if (Date.now() - d.fetchedAt > SB_CATALOG_TTL_MS) return null;
    return d;
  } catch(_) { return null; }
}

async function sbCatalogFetch(forceRefresh) {
  if (!forceRefresh) {
    var cached = sbCatalogLoadCacheDecompress();
    if (cached && cached.products) {
      SB_CATALOG_STATE.data = cached.products;
      SB_CATALOG_STATE.fetchedAt = cached.fetchedAt;
      return cached.products;
    }
  }
  SB_CATALOG_STATE.loading = true;
  SB_CATALOG_STATE.error = null;
  var products = [];
  try {
    // Shopify's /products.json returns 30 products per page by default, max 250.
    // Iterate until an empty page.
    for (var page = 1; page <= 40; page++) {
      var res = await fetch("https://succulentsbox.com/products.json?limit=250&page=" + page);
      if (!res.ok) break;
      var j = await res.json();
      if (!j.products || j.products.length === 0) break;
      for (var i = 0; i < j.products.length; i++) {
        var p = j.products[i];
        var title = p.title;
        if (!title) continue;
        // Skip drafts / unpublished
        if (p.published_at === null) continue;
        // Available if any variant is available
        var available = (p.variants || []).some(function(v){return v.available;});
        // Emit one row per variant (each has its own SKU)
        for (var v = 0; v < (p.variants || []).length; v++) {
          var vv = p.variants[v];
          products.push({
            asin: vv.sku, sku: vv.sku, title: title,
            handle: p.handle,
            units: 0, rev: 0, avg: 0, glance: 0, conv: 0,
            inv: 0,  // /products.json doesn't expose inventory qty on storefront
            available: available && vv.available,
            catalogOnly: true,
            genus: (typeof detectGenus === "function" ? detectGenus(title) : "") || "(no genus)"
          });
        }
      }
      if (j.products.length < 250) break;  // last page
    }
    if (!products.length) throw new Error("empty catalog");
    SB_CATALOG_STATE.data = products;
    SB_CATALOG_STATE.fetchedAt = Date.now();
    sbCatalogSaveCache(products);
    return products;
  } catch(e) {
    SB_CATALOG_STATE.error = e.message || String(e);
    console.warn("SB catalog fetch error:", e);
    return null;
  } finally {
    SB_CATALOG_STATE.loading = false;
  }
}

function sbCatalogAutoLoad() {
  var cached = sbCatalogLoadCacheDecompress();
  if (cached && cached.products) {
    SB_CATALOG_STATE.data = cached.products;
    SB_CATALOG_STATE.fetchedAt = cached.fetchedAt;
    // Refresh in background if >12h old
    if (Date.now() - cached.fetchedAt > 12 * 60 * 60 * 1000) {
      sbCatalogFetch(false).then(function(){ if (typeof renderTab === "function") renderTab(activeTab); });
    }
    return;
  }
  sbCatalogFetch(false).then(function(){ if (typeof renderTab === "function") renderTab(activeTab); });
}

// Return the live catalog as a "products" array compatible with addOwned
function sbLiveCatalogProducts() {
  return SB_CATALOG_STATE.data || [];
}

// ============================================================
// External Stores drill-down CSV download
// ============================================================
function downloadExternalDrill() {
  var s = state.external;
  if (!s.snapshotId || !s.drillGenus) { alert("Open a genus drill-down first."); return; }
  var snap = snapshots.find(function(x){return x.id === s.snapshotId;});
  if (!snap) return;
  var products = snap.products;
  if (s.storeFilter && s.storeFilter !== "all") {
    products = products.filter(function(p){
      return s.groupByParent ? p.store === s.storeFilter : p.rawStore === s.storeFilter;
    });
  }
  var genera = aggregateExternalByGenus(products);
  var g = genera.find(function(x){return x.genus === s.drillGenus;});
  if (!g) { alert("Genus not found in current snapshot."); return; }
  var search = (document.getElementById("external-prod-search").value || "").toLowerCase();
  var byTitle = aggregateExternalByPlant(g.items).filter(function(p){return !search || p.title.toLowerCase().indexOf(search) >= 0;});
  var esc = function(v){var s=String(v==null?"":v);return s.indexOf(",")>=0||s.indexOf('"')>=0||s.indexOf("\n")>=0 ? '"'+s.replace(/"/g,'""')+'"' : s;};
  var header = "Plant,SKU,Units,Est. Rev,Orders,Stores\n";
  var body = byTitle.map(function(p){
    return [
      esc(p.title), esc(p.sku),
      p.units, (p.estRev||0).toFixed(2),
      p.orders, p.storeCount
    ].join(",");
  }).join("\n");
  var csv = header + body;
  var blob = new Blob([csv], {type: "text/csv"});
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  var safe = s.drillGenus.replace(/[^a-zA-Z0-9]/g, "_");
  a.href = url;
  a.download = "external-" + safe + "-plants.csv";
  a.click();
  URL.revokeObjectURL(url);
}
(function(){
  function wire() {
    var btn = document.getElementById("external-drill-download");
    if (btn && !btn._wired) { btn._wired = true; btn.addEventListener("click", downloadExternalDrill); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
