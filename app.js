// ============================================================
// STATE
// ============================================================
const STORAGE_KEY = "sb-analyzer-snapshots-v1";
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
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch(e){ console.warn("Failed to load snapshots:", e); return []; }
}
function saveSnapshots(){
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));
  } catch(e){
    alert("Couldn't save — browser storage is full. Delete an old snapshot and try again.");
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
  return snapshots.filter(s => s.source === source).sort((a,b) => b.endDate.localeCompare(a.endDate));
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
  const m = name.match(/(\d{4}-\d{2}-\d{2})/g);
  if (!m) return [null, null];
  if (m.length >= 2) return [m[0], m[m.length-1]];
  return [m[0], m[0]];
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
  function asinFromCell(cellRef){
    const c = ws[cellRef];
    if (!c) return "";
    // HYPERLINK formula: look at f for ASIN
    if (c.f){
      const m = c.f.match(/[A-Z0-9]{10}/g);
      if (m && m.length) return m[m.length - 1];
    }
    // Or the cell's raw value / display might contain it
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
    const s = String(x).replace(/[,$\s%]/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }
  for (let i = 1; i < rows.length; i++){
    const r = rows[i]; if (!r) continue;
    // Skip the Shopify-style 'Total' summary row Amazon also has at row index 1
    if (String(r[0] || '').trim() === "Total") continue;
    const title = String(r[1] || "").trim();
    if (!title || title === "Item name") continue;
    const cellRef = XLSX.utils.encode_cell({c: 0, r: i});
    const raw = String(r[0] || '').trim();
    // ASIN can be plain text (CSV) or a HYPERLINK formula (xlsx)
    const asinFromCellRef = asinFromCell(cellRef);
    let asin = asinFromCellRef;
    if (!asin) {
      const m = raw.match(/[A-Z0-9]{10}/);
      asin = m ? m[0] : raw;
    }
    let glance = num(r[2]);
    let conv   = num(r[3]);
    if (conv > 1) conv = conv / 100; // if stored as 2.98 instead of 0.0298
    const units = num(r[4]), avg = num(r[5]), rev = num(r[6]), inv = num(r[7]);
    products.push({asin, title, glance, conv, units, avg, rev, inv, genus: detectGenus(title) || "(no genus)"});
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

async function handleFile(source, file){
  if (!file) return;
  const dz = document.getElementById(`${source}-dropzone`);
  dz.classList.add("loading"); dz.querySelector(".dz-msg").textContent = "Processing…";
  try {
    const wb = await readFile(file);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, {header: 1, raw: true, defval: ""});
    const products = source === "amazon" ? parseAmazon(rows, ws) : parseShopify(rows);
    if (!products.length) { alert("No data rows found in file."); return; }
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
    const today = new Date().toISOString().slice(0,10);
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
      const today = t.toISOString().slice(0,10);
      const y = t.getFullYear();
      const m = t.getMonth();
      let s, e;
      if (a.dataset.preset === 'ytd') { s = `${y}-01-01`; e = today; }
      else if (a.dataset.preset === 'month') {
        s = `${y}-${String(m+1).padStart(2,'0')}-01`; e = today;
      } else if (a.dataset.preset === 'lastmonth') {
        const lm = new Date(y, m-1, 1);
        const lme = new Date(y, m, 0);
        s = lm.toISOString().slice(0,10); e = lme.toISOString().slice(0,10);
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
  for (const src of ['amazon','shopify']) {
    if (state[src].snapshotId === id) state[src].snapshotId = newSnap.id;
    if (state[src].compareId === id) state[src].compareId = newSnap.id;
  }
  if (state.cross.amazonId === id) state.cross.amazonId = newSnap.id;
  if (state.cross.shopifyId === id) state.cross.shopifyId = newSnap.id;
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
  if (!snapshots.length){
    body.innerHTML = '<p class="empty">No saved snapshots yet.</p>';
  } else {
    body.innerHTML = `<table><thead><tr><th>Source</th><th>Period</th><th>SKUs</th><th>Uploaded</th><th></th></tr></thead><tbody>${
      snapshots.slice().sort((a,b) => b.uploadedAt.localeCompare(a.uploadedAt)).map(s =>
        `<tr><td><span class="badge ${s.source}">${s.source}</span></td><td>${s.label}</td><td>${s.products.length}</td><td>${new Date(s.uploadedAt).toLocaleDateString()}</td><td><button class="tab" data-edit="${s.id}">Edit period</button> <button class="tab danger" data-del="${s.id}">Delete</button></td></tr>`
      ).join('')}</tbody></table>`;
    body.querySelectorAll('[data-edit]').forEach(btn =>
      btn.addEventListener('click', () => editSnapshotPeriod(btn.dataset.edit)));
    body.querySelectorAll('[data-del]').forEach(btn =>
      btn.addEventListener('click', () => {
        if (confirm('Delete this snapshot? This cannot be undone.')) {
          deleteSnapshot(btn.dataset.del);
          // Reset any active snapshot pointers that referenced it
          for (const src of ['amazon','shopify']) {
            if (state[src].snapshotId === btn.dataset.del) state[src].snapshotId = null;
            if (state[src].compareId === btn.dataset.del) state[src].compareId = null;
          }
          if (state.cross.amazonId === btn.dataset.del) state.cross.amazonId = null;
          if (state.cross.shopifyId === btn.dataset.del) state.cross.shopifyId = null;
          openManage(); renderTab(activeTab);
        }
      }));
  }
  modal.style.display = 'flex';
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
  setupDropzone('amazon'); setupDropzone('shopify');
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
    if (amazonLatest) state.amazon.snapshotId = amazonLatest.id;
    if (shopifyLatest) state.shopify.snapshotId = shopifyLatest.id;
    if (amazonLatest) state.cross.amazonId = amazonLatest.id;
    if (shopifyLatest) state.cross.shopifyId = shopifyLatest.id;
  }
  switchTab('amazon');
});
