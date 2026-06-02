// ============================================================
// STATE
// ============================================================
const STORAGE_KEY = "sb-analyzer-snapshots-v1";
let snapshots = loadSnapshots();
let activeTab = "amazon";
let state = {
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
    const asin = asinFromCell(cellRef) || String(r[0] || '').trim();
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
    const [start, end] = parseDates(file.name);
    const startDate = start || new Date().toISOString().slice(0,10);
    const endDate = end || startDate;
    const label = labelFromDates(startDate, endDate);
    const snap = {
      id: `${source}_${startDate}_${endDate}`,
      source, label, startDate, endDate,
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
      scales:{x:{ticks:{callback:v=>'$'+(v/1000).toFixed(0)+'k'}}}}
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
      scales:{x:{ticks:{callback:v=>'$'+(v/1000).toFixed(0)+'k'}}}}
  });
}

function renderGenusTable(source, genera, isCompare){
  const isAmazon = source === "amazon";
  const tbody = document.getElementById(`${source}-genus-tbody`);
  const thead = document.getElementById(`${source}-genus-thead`);
  let cols;
  if (isCompare){
    cols = ['Genus','SKUs','Units (cur)','Units (prior)','Revenue (cur)','Revenue (prior)','Δ $','Δ %'];
  } else if (isAmazon){
    cols = ['Genus','SKUs','Glance','Units','Conv','Revenue','Inventory'];
  } else {
    cols = ['Genus','SKUs','Units','Revenue','Avg price'];
  }
  thead.innerHTML = cols.map((c,i) => `<th class="${i===0?'':'num'}">${c}</th>`).join('');
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
    render = (p,i) => [i+1, p.asin, p.title, fmtN(p.glance), pctFmt(p.conv), fmtN(p.units), fmt$(p.avg), fmt$(p.rev)];
  } else {
    cols = ['Rank','Title','Units','Avg','Revenue'];
    render = (p,i) => [i+1, p.title, fmtN(p.units), fmt$(p.avg), fmt$(p.rev)];
  }
  thead.innerHTML = cols.map((c,i)=> {
    const isText = isAmazon ? (i===1||i===2) : (i===1);
    return `<th class="${i===0||isText?'':'num'}">${c}</th>`;
  }).join('');
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
}
function renderDrillCompare(source, genus, genera){
  const g = genera.find(x => x.genus === genus);
  if (!g) { closeDrill(source); return; }
  const filter = state[source].drillFilter;
  const q = (document.getElementById(`${source}-prod-search`).value || '').trim().toLowerCase();
  let items = g.items.slice().sort((a,b) => b.ct - a.ct);
  if (filter === 'ge100') items = items.filter(p => p.ct >= 100 || p.pt >= 100);
  if (q) items = items.filter(p => p.t.toLowerCase().includes(q));
  document.getElementById(`${source}-drill-count`).textContent = items.length + ' plants';
  const thead = document.getElementById(`${source}-prod-thead`);
  const tbody = document.getElementById(`${source}-prod-tbody`);
  const cols = ['Rank','Title','Cur units','Prior units','Cur $','Prior $','Δ $','Δ %'];
  thead.innerHTML = cols.map((c,i)=>`<th class="${i===0||i===1?'':'num'}">${c}</th>`).join('');
  tbody.innerHTML = items.map((p,i) =>
    `<tr><td>${i+1}</td><td>${p.t}</td><td class="num">${fmtN(p.ci)}</td><td class="num">${fmtN(p.pi)}</td><td class="num">${fmt$(p.ct)}</td><td class="num">${fmt$(p.pt)}</td><td class="num ${deltaClass(p.d)}">${p.d>=0?'+':'-'}${fmt$(Math.abs(p.d))}</td><td class="num ${deltaClass(p.d)}">${arrow(p.pct)} ${pctFmt(p.pct)}</td></tr>`).join('');
  if (!items.length) tbody.innerHTML = `<tr><td colspan="${cols.length}" class="empty">No plants match this filter.</td></tr>`;
}

// ============================================================
// AMAZON ALERTS
// ============================================================
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
  // Aggregate by genus from each side
  const aGenera = aggregateByGenus(aSnap.products);
  const sGenera = aggregateByGenus(sSnap.products);
  const allG = new Set([...aGenera.map(g=>g.genus), ...sGenera.map(g=>g.genus)]);
  const aMap = Object.fromEntries(aGenera.map(g => [g.genus, g]));
  const sMap = Object.fromEntries(sGenera.map(g => [g.genus, g]));
  const cross = [];
  for (const g of allG){
    const a = aMap[g] || {rev:0, units:0, skus:0};
    const s = sMap[g] || {rev:0, units:0, skus:0};
    const combined = a.rev + s.rev;
    cross.push({genus: g, aRev: a.rev, sRev: s.rev, aUnits: a.units, sUnits: s.units, combined, aShare: combined > 0 ? a.rev/combined : 0});
  }
  cross.sort((a,b) => b.combined - a.combined);
  const plant = cross.filter(g => g.genus !== '(no genus)');
  // Top-line
  const aTot = aSnap.products.reduce((s,p)=>s+p.rev, 0);
  const sTot = sSnap.products.reduce((s,p)=>s+p.rev, 0);
  const tot = aTot + sTot;
  document.getElementById("cross-cards").innerHTML = [
    {label:'Combined revenue', value: fmt$(tot)},
    {label:'Amazon $', value: fmt$(aTot), sub: `${(tot ? aTot/tot*100 : 0).toFixed(1)}% of total`},
    {label:'Shopify $', value: fmt$(sTot), sub: `${(tot ? sTot/tot*100 : 0).toFixed(1)}% of total`},
    {label:'Total units', value: fmtN(aSnap.products.reduce((s,p)=>s+p.units,0) + sSnap.products.reduce((s,p)=>s+p.units,0))},
    {label:'Genera both channels', value: fmtN(cross.filter(g => g.aRev > 0 && g.sRev > 0 && g.genus !== '(no genus)').length)}
  ].map(c => `<div class="card"><div class="label">${c.label}</div><div class="value">${c.value}</div>${c.sub?`<div class="sub">${c.sub}</div>`:''}</div>`).join('');
  document.getElementById("cross-banner").innerHTML = `<strong>${aSnap.label}</strong> (Amazon) vs <strong>${sSnap.label}</strong> (Shopify)`;
  // Chart: top 25 by combined revenue, stacked bar (Amazon + Shopify)
  const top25 = plant.slice(0, 25);
  const ctx = document.getElementById("cross-chart").getContext('2d');
  if (state.cross.chart) state.cross.chart.destroy();
  state.cross.chart = new Chart(ctx, {
    type:'bar',
    data:{labels: top25.map(g=>g.genus), datasets:[
      {label:'Amazon', data: top25.map(g=>g.aRev), backgroundColor:'#ff9800'},
      {label:'Shopify', data: top25.map(g=>g.sRev), backgroundColor:'#2e7d32'}
    ]},
    options:{indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:true, position:'bottom'}, tooltip:{callbacks:{label:c=>c.dataset.label+': '+fmt$(c.parsed.x)}}},
      scales:{x:{stacked:true, ticks:{callback:v=>'$'+(v/1000).toFixed(0)+'k'}}, y:{stacked:true}}}
  });
  // Table
  const tbody = document.getElementById("cross-tbody");
  const thead = document.getElementById("cross-thead");
  thead.innerHTML = ['Genus','Amazon $','Shopify $','Combined $','Amazon share','Dominant'].map((c,i) => `<th class="${i===0?'':'num'}">${c}</th>`).join('');
  const q = (document.getElementById("cross-search").value || '').trim().toLowerCase();
  let display = plant;
  if (q) display = display.filter(g => g.genus.toLowerCase().includes(q));
  document.getElementById("cross-count").textContent = display.length + ' genera';
  tbody.innerHTML = display.map(g => {
    let dom = '—';
    if (g.aRev > 0 && g.sRev === 0) dom = `<span class="badge amazon">Amazon only</span>`;
    else if (g.sRev > 0 && g.aRev === 0) dom = `<span class="badge shopify">Shopify only</span>`;
    else if (g.aRev > g.sRev * 1.1) dom = `<span class="badge amazon">Amazon (${(g.aRev/g.sRev).toFixed(1)}×)</span>`;
    else if (g.sRev > g.aRev * 1.1) dom = `<span class="badge shopify">Shopify (${(g.sRev/g.aRev).toFixed(1)}×)</span>`;
    else dom = `<span class="badge balanced">Balanced</span>`;
    return `<tr><td>${g.genus}</td><td class="num">${fmt$(g.aRev)}</td><td class="num">${fmt$(g.sRev)}</td><td class="num">${fmt$(g.combined)}</td><td class="num">${pctFmt(g.aShare)}</td><td>${dom}</td></tr>`;
  }).join('');
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
        `<tr><td><span class="badge ${s.source}">${s.source}</span></td><td>${s.label}</td><td>${s.products.length}</td><td>${new Date(s.uploadedAt).toLocaleDateString()}</td><td><button class="tab" data-del="${s.id}">Delete</button></td></tr>`
      ).join('')}</tbody></table>`;
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
