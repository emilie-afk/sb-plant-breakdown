// ============================================================
// product-grouping.js
// Classification, overrides, exclusion, scope and aggregation shared by the
// Shopify and Amazon Product breakdown, Vendor analytics and Product
// performance views. No DOM, so every function here is directly testable.
//
// Rules this file enforces:
//   - Every sales record belongs to EXACTLY ONE primary group, so group
//     totals always reconcile to the included source totals.
//   - A plant's primary group is its genus. A non-plant's primary group is
//     its product category. "Unclassified" means "we do not know", and is
//     kept visible rather than folded into either side.
//   - An unidentified plant genus is NOT the same thing as a non-plant
//     product. They are different groups with different group types.
//   - A gift that happens to contain a succulent is a Gift. Product type
//     beats title-sniffing, and an explicit override beats product type.
//   - Nothing is dropped because genus detection failed.
//   - The IMPORTED product type is never rewritten. Overrides and normalized
//     categories live in their own fields beside it.
// ============================================================
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) for (var k in api) if (Object.prototype.hasOwnProperty.call(api, k)) root[k] = api[k];
})(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";

  var UNCLASSIFIED = "Unclassified";
  var UNIDENTIFIED_PLANT = "Unidentified plant";
  var MIXED_PACK = "Mixed variety pack";

  var GROUP_TYPE_GENUS = "Genus";
  var GROUP_TYPE_CATEGORY = "Product category";

  // ----------------------------------------------------------
  // Product type -> canonical classification
  // ----------------------------------------------------------
  var PLANT_TYPES = {
    "succulent": 1, "succulents": 1,
    "houseplant": 1, "houseplants": 1, "house plant": 1, "house plants": 1,
    "indoor plant": 1, "indoor plants": 1,
    "outdoor plant": 1, "outdoor plants": 1,
    "air plant": 1, "air plants": 1, "airplant": 1, "airplants": 1,
    "cactus": 1, "cacti": 1,
    "tree": 1, "trees": 1,
    "live plant": 1, "live plants": 1,
    "plant": 1, "plants": 1
  };
  var CATEGORY_TYPES = {
    "gift": "Gifts", "gifts": "Gifts", "gift box": "Gifts", "gift boxes": "Gifts", "gift set": "Gifts",
    "gift card": "Gift Cards", "gift cards": "Gift Cards",
    "subscription": "Subscriptions", "subscriptions": "Subscriptions", "subscription box": "Subscriptions",
    "pots & planters": "Pots & Planters", "pots and planters": "Pots & Planters",
    "pot": "Pots & Planters", "pots": "Pots & Planters", "planter": "Pots & Planters", "planters": "Pots & Planters",
    "soil": "Soil", "soils": "Soil", "potting mix": "Soil", "substrate": "Soil",
    "fertilizer": "Fertilizer", "fertilizers": "Fertilizer", "plant food": "Fertilizer",
    "tool": "Tools", "tools": "Tools",
    "accessory": "Accessories", "accessories": "Accessories",
    "garden supplies/accessories": "Accessories", "garden supplies": "Accessories",
    "greeting card": "Stationery & Cards", "greeting cards": "Stationery & Cards",
    "id card": "Stationery & Cards", "id cards": "Stationery & Cards",
    "notepad": "Stationery & Cards", "notepads": "Stationery & Cards",
    "calendars, organizers & planners": "Stationery & Cards",
    "calendar": "Stationery & Cards", "calendars": "Stationery & Cards",
    "sticker": "Stationery & Cards", "stickers": "Stationery & Cards",
    "insurance": "Shipping Protection", "shipping protection": "Shipping Protection",
    "shipping": "Shipping & Fees", "service": "Services", "services": "Services",
    "apparel": "Apparel", "merchandise": "Merchandise", "merch": "Merchandise",
    "kit": "Kits", "kits": "Kits", "terrarium": "Kits",
    "accessories/tools": "Accessories"
  };

  // detectNonPlantType() (genus-data.js) labels -> the canonical category names
  // used above, so the title fallback and the product-type path agree.
  var TITLE_TYPE_TO_CATEGORY = {
    "Gift Card": "Gift Cards",
    "Subscription": "Subscriptions",
    "Fertilizer": "Fertilizer",
    "Soil": "Soil",
    "Cutting": null,                  // a cutting is a plant, handled on the plant side
    "Mystery Box": "Gifts",
    "Pot/Planter": "Pots & Planters",
    "Tool": "Tools",
    "Accessories": "Accessories",
    "Kit/Equipment": "Kits",
    "Bundle": null,                   // ambiguous: resolved on the plant side
    "Merchandise": "Merchandise",
    "Other": null
  };

  // All category names this module can produce, for override pickers.
  function knownCategories() {
    var set = {};
    Object.keys(CATEGORY_TYPES).forEach(function (k) { set[CATEGORY_TYPES[k]] = 1; });
    Object.keys(TITLE_TYPE_TO_CATEGORY).forEach(function (k) {
      if (TITLE_TYPE_TO_CATEGORY[k]) set[TITLE_TYPE_TO_CATEGORY[k]] = 1;
    });
    set[UNCLASSIFIED] = 1;
    return Object.keys(set).sort(function (a, b) { return a.localeCompare(b); });
  }

  function norm(s) {
    return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
  }

  function classifyProductType(ptype) {
    var n = norm(ptype);
    if (!n || n === norm(UNCLASSIFIED)) return { kind: "unknown", category: null };
    if (PLANT_TYPES[n]) return { kind: "plant", category: null };
    if (CATEGORY_TYPES[n]) return { kind: "category", category: CATEGORY_TYPES[n] };
    // Tolerate "Succulents - Rare", "Houseplants / Large" etc.
    var head = n.split(/[\/|,\-–—]/)[0].trim();
    if (head && head !== n) {
      if (PLANT_TYPES[head]) return { kind: "plant", category: null };
      if (CATEGORY_TYPES[head]) return { kind: "category", category: CATEGORY_TYPES[head] };
    }
    return { kind: "unmapped", category: null };
  }

  function detectors(opts) {
    opts = opts || {};
    return {
      genus: opts.detectGenus || (root && root.detectGenus) || function () { return ""; },
      nonPlant: opts.detectNonPlantType || (root && root.detectNonPlantType) || function () { return ""; }
    };
  }

  // Title rules applied BEFORE genus-data.js's detectNonPlantType().
  //
  // Two reasons they exist:
  //   1. detectGenus() returns the pseudo-genus "Bundle" for anything whose
  //      title contains pack / set / box / assortment. On Shopify that rarely
  //      shows, because the product type decides first. On Amazon there is no
  //      product type at all, so without these rules a gift box, a pot
  //      multipack and a card pack would all land in "Mixed variety pack".
  //   2. detectNonPlantType() checks /pack|bundle|variety/ before /card/, so
  //      "Greeting Card 10 Pack" comes back as a bundle rather than a card.
  //
  // Nothing here overrules a real genus or an imported product type.
  var TITLE_CATEGORY_RULES = [
    [/\bgift\s*cards?\b|\be-?gift\b/i, "Gift Cards"],
    [/\b(subscription|subscribe|monthly plan|month plan)\b/i, "Subscriptions"],
    [/\bgift\s*(box|set|basket|bag|boxes|sets)\b|\bgift\b.*\b(box|set|basket|bag)\b|\bfavou?rs?\b|\bmemorial\b/i, "Gifts"],
    [/\b(greeting card|care guide|bookmark|calendars?|planners?|notepads?|stickers?|postcards?|print(able)?s?)\b/i, "Stationery & Cards"],
    [/\b(potting soil|soil mix|potting mix|coco coir|pumice|perlite|lava rock|top dressing|substrate)\b/i, "Soil"],
    [/\b(fertilizer|fertiliser|plant food|nutrients?)\b/i, "Fertilizer"],
    [/\b(planters?|pots?|terracotta|ceramic pot|hanging planter|vase)\b/i, "Pots & Planters"],
    [/\b(tool ?set|tools|tweezers?|scissors?|shears|trowel|repotting mat|dust blower)\b/i, "Tools"],
    [/\b(starter kit|terrarium kit|propagation kit)\b/i, "Kits"],
    [/\b(macrame|hangers?|plant stand|shelf|saucers?|coasters?|moisture meter|humidifier|grow light|heat pack)\b/i, "Accessories"]
  ];
  // Words that mean "this is a live plant" even when no genus is recognised.
  var LIVE_PLANT_RE = /\b(succulent|succulents|cactus|cacti|air ?plant|houseplant|house plant|live plants?|seedlings?|cuttings?)\b/i;

  function ruleCategory(title) {
    var t = String(title == null ? "" : title);
    for (var i = 0; i < TITLE_CATEGORY_RULES.length; i++) {
      if (TITLE_CATEGORY_RULES[i][0].test(t)) return TITLE_CATEGORY_RULES[i][1];
    }
    return null;
  }

  // The category the TITLE alone suggests, independent of product type.
  // Used both as a fallback and to flag disagreements for review.
  function categoryFromTitle(title, opts) {
    var d = detectors(opts);
    var raw = d.genus(title) || "";
    if (raw === "Subscription") return "Subscriptions";
    if (raw && raw !== "Bundle") return null;      // the title names a real genus
    var byRule = ruleCategory(title);
    if (byRule) return byRule;
    var label = d.nonPlant(title) || "";
    return Object.prototype.hasOwnProperty.call(TITLE_TYPE_TO_CATEGORY, label) ? TITLE_TYPE_TO_CATEGORY[label] : null;
  }

  // ----------------------------------------------------------
  // Classification
  // ----------------------------------------------------------
  // The classification the data itself implies, before any override.
  function naturalClassification(rec, opts) {
    var d = detectors(opts);
    var title = rec && rec.title ? rec.title : "";
    var pt = classifyProductType(rec && rec.ptype);
    var raw = d.genus(title) || "";

    // A non-plant product type is decisive: a gift holding a succulent is a Gift.
    if (pt.kind === "category") {
      return { group: pt.category, groupType: GROUP_TYPE_CATEGORY, isPlant: false, genus: "", basis: "product_type" };
    }

    if (pt.kind === "plant") {
      if (raw === "Subscription") {
        // Title says subscription explicitly; that beats a stale product type.
        return { group: "Subscriptions", groupType: GROUP_TYPE_CATEGORY, isPlant: false, genus: "", basis: "title_overrides_type" };
      }
      if (raw === "Bundle") {
        return { group: MIXED_PACK, groupType: GROUP_TYPE_GENUS, isPlant: true, genus: "", basis: "product_type+title" };
      }
      if (raw) return { group: raw, groupType: GROUP_TYPE_GENUS, isPlant: true, genus: raw, basis: "product_type+genus" };
      return { group: UNIDENTIFIED_PLANT, groupType: GROUP_TYPE_GENUS, isPlant: true, genus: "", basis: "product_type" };
    }

    // No usable product type: fall back to the title, in this order.
    //  1. a real genus wins outright
    //  2. then an explicit category in the title
    //  3. then "a pack of something plant-like"
    //  4. then "a plant we cannot name"
    //  5. and only then Unclassified
    if (raw && raw !== "Bundle" && raw !== "Subscription") {
      return { group: raw, groupType: GROUP_TYPE_GENUS, isPlant: true, genus: raw, basis: "title_genus" };
    }
    var cat = categoryFromTitle(title, opts);
    if (cat) return { group: cat, groupType: GROUP_TYPE_CATEGORY, isPlant: false, genus: "", basis: "title_category" };
    if (raw === "Bundle") {
      return { group: MIXED_PACK, groupType: GROUP_TYPE_GENUS, isPlant: true, genus: "", basis: "title" };
    }
    if (LIVE_PLANT_RE.test(String(title || ""))) {
      return { group: UNIDENTIFIED_PLANT, groupType: GROUP_TYPE_GENUS, isPlant: true, genus: "", basis: "title_plant_word" };
    }

    // Genuinely unknown. Visible as Unclassified; never hidden, never merged
    // into "no genus" alongside pots and gift cards.
    return { group: UNCLASSIFIED, groupType: GROUP_TYPE_CATEGORY, isPlant: false, genus: "", basis: "none" };
  }

  // opts.override(record) -> {group, groupType?, isPlant?, note?} | null
  // An override changes only the analytics grouping. The imported product
  // type on the record is left exactly as the source stated it, and the
  // classification it would have received is kept as `natural`.
  function classifyRecord(rec, opts) {
    opts = opts || {};
    var natural = naturalClassification(rec, opts);
    if (!opts.override) return Object.assign({}, natural, { overridden: false, natural: natural });
    var ov = opts.override(rec);
    if (!ov || !ov.group) return Object.assign({}, natural, { overridden: false, natural: natural });
    var isPlant = ov.isPlant != null ? !!ov.isPlant : (ov.groupType === GROUP_TYPE_GENUS);
    return {
      group: ov.group,
      groupType: ov.groupType || (isPlant ? GROUP_TYPE_GENUS : GROUP_TYPE_CATEGORY),
      isPlant: isPlant,
      genus: isPlant ? ov.group : "",
      basis: "override",
      overridden: true,
      overrideNote: ov.note || "",
      natural: natural
    };
  }

  // ----------------------------------------------------------
  // Suspicious classifications
  // ----------------------------------------------------------
  // Surfaces rows where the store's own product type disagrees with what the
  // title plainly says, so a human can decide. Nothing is auto-corrected.
  //   kind: "type_vs_title"  the product type and the title name different
  //                          categories (e.g. "Warming Pack (Subscription)"
  //                          typed Fertilizers; a gift card typed Greeting Card)
  //         "plant_type_nonplant_title"  typed as a plant, titled as a non-plant
  //         "missing_type"   no product type in the export at all
  //         "unmapped_type"  a product type this module does not recognise
  var COMPOSITE_CATEGORIES = { "Gifts": 1, "Kits": 1, "Subscriptions": 1 };
  var COMPONENT_CATEGORIES = {
    "Pots & Planters": 1, "Soil": 1, "Tools": 1, "Accessories": 1,
    "Fertilizer": 1, "Kits": 1, "Stationery & Cards": 1
  };

  function classifySuspicion(rec, opts) {
    var pt = classifyProductType(rec && rec.ptype);
    var fromTitle = categoryFromTitle(rec && rec.title, opts);

    // A gift box, a kit or a subscription legitimately CONTAINS pots, soil,
    // tools and plants. Flagging every such row would bury the real
    // mislabels, so a composite type over a component title is not a
    // disagreement — the product type is doing its job.
    if (pt.kind === "category" && fromTitle && fromTitle !== pt.category &&
        COMPOSITE_CATEGORIES[pt.category] && COMPONENT_CATEGORIES[fromTitle]) {
      return null;
    }
    if (pt.kind === "category" && fromTitle && fromTitle !== pt.category) {
      return {
        kind: "type_vs_title",
        severity: "review",
        importedType: rec.ptype,
        fromType: pt.category,
        fromTitle: fromTitle,
        suggested: fromTitle,
        message: 'Imported product type "' + rec.ptype + '" groups this as ' + pt.category +
                 ", but the title reads as " + fromTitle + "."
      };
    }
    if (pt.kind === "plant" && fromTitle && fromTitle !== "Subscriptions") {
      return {
        kind: "plant_type_nonplant_title",
        severity: "review",
        importedType: rec.ptype,
        fromType: "a plant genus",
        fromTitle: fromTitle,
        suggested: fromTitle,
        message: 'Imported product type "' + rec.ptype + '" says this is a plant, but the title reads as ' + fromTitle + "."
      };
    }
    if (pt.kind === "unknown") {
      return {
        kind: "missing_type", severity: "info",
        importedType: "", fromType: null, fromTitle: fromTitle, suggested: null,
        message: "No product type in the export; grouped from the title alone."
      };
    }
    if (pt.kind === "unmapped") {
      return {
        kind: "unmapped_type", severity: "info",
        importedType: rec.ptype, fromType: null, fromTitle: fromTitle, suggested: fromTitle,
        message: 'Product type "' + rec.ptype + '" is not in the category map; grouped from the title.'
      };
    }
    return null;
  }

  function flaggedRecords(records, severity) {
    return records.filter(function (r) {
      if (!r.suspicion) return false;
      if (r.overridden) return false;          // a human has already ruled on it
      return severity ? r.suspicion.severity === severity : true;
    });
  }

  // ----------------------------------------------------------
  // Override store (pure; persistence is the caller's job)
  // ----------------------------------------------------------
  var OVERRIDE_SEP = "␟";
  function overrideKeyFor(rec) {
    if (rec && rec.overrideKey) return rec.overrideKey;
    if (rec && rec.channel === "amazon" && rec.asin) return "amazon" + OVERRIDE_SEP + rec.asin;
    return (rec && rec.channel ? rec.channel : "shopify") + OVERRIDE_SEP +
           [rec && rec.title, (rec && rec.vendor) || "", (rec && rec.ptype) || ""].join(OVERRIDE_SEP);
  }
  function makeOverrideLookup(map) {
    var m = map || {};
    return function (rec) { return m[overrideKeyFor(rec)] || null; };
  }
  function setOverride(map, rec, value) {
    var out = Object.assign({}, map || {});
    var key = overrideKeyFor(rec);
    if (!value || !value.group) delete out[key];
    else out[key] = { group: value.group, groupType: value.groupType || null, isPlant: !!value.isPlant,
                      note: value.note || "", setAt: value.setAt || new Date().toISOString() };
    return out;
  }

  // ----------------------------------------------------------
  // Exclusions
  // ----------------------------------------------------------
  var DEFAULT_EXCLUSIONS = [
    { id: "route", label: "Route (shipping protection)", match: function (r) { return norm(r.vendor) === "route"; } }
  ];

  function splitExclusions(records, rules) {
    rules = rules || DEFAULT_EXCLUSIONS;
    var included = [], excluded = [];
    for (var i = 0; i < records.length; i++) {
      var hit = null;
      for (var j = 0; j < rules.length; j++) {
        if (rules[j].enabled === false) continue;
        if (rules[j].match(records[i])) { hit = rules[j]; break; }
      }
      if (hit) {
        var copy = records[i];
        copy.excluded = true;
        copy.exclusionId = hit.id;
        copy.exclusionLabel = hit.label;
        excluded.push(copy);
      } else {
        records[i].excluded = false;
        included.push(records[i]);
      }
    }
    return { included: included, excluded: excluded, rules: rules };
  }

  // ----------------------------------------------------------
  // Scope / filtering
  // ----------------------------------------------------------
  //   { vendor:"All"|name, ptype:"All"|name, group:"All"|name,
  //     plantScope:"all"|"plants"|"nonplants", search:"", flagged:false }
  function applyScope(records, scope) {
    scope = scope || {};
    var vendor = scope.vendor && scope.vendor !== "All" ? scope.vendor : null;
    var ptype = scope.ptype && scope.ptype !== "All" ? scope.ptype : null;
    var group = scope.group && scope.group !== "All" ? scope.group : null;
    var plantScope = scope.plantScope || "all";
    var q = norm(scope.search || "");
    return records.filter(function (r) {
      if (vendor && r.vendor !== vendor) return false;
      if (ptype && r.ptype !== ptype) return false;
      if (group && r.group !== group) return false;
      if (plantScope === "plants" && !r.isPlant) return false;
      if (plantScope === "nonplants" && r.isPlant) return false;
      if (scope.flagged && !(r.suspicion && r.suspicion.severity === "review" && !r.overridden)) return false;
      if (q && norm(r.title).indexOf(q) < 0 && norm(r.vendor).indexOf(q) < 0 &&
          norm(r.group).indexOf(q) < 0 && norm(r.ptype).indexOf(q) < 0 &&
          norm(r.asin || "").indexOf(q) < 0) return false;
      return true;
    });
  }

  // ----------------------------------------------------------
  // Sales channels
  // ----------------------------------------------------------
  // A report with a Sales channel column holds one row per product per
  // channel. `channel` picks which rows count:
  //   "own"    everything except Amazon orders that came through Sellbrite
  //   "amazon" only those Sellbrite rows
  //   "all"    every channel
  // Rows of the same product are then merged. Channel slices of one product
  // in one period are disjoint, so adding them is a true total, not a double
  // count. Records without channel data pass through untouched. The input
  // records are never modified; merged rows are new objects.
  var CHANNEL_SUM_KEYS = ["units", "gross", "disc", "ret", "net", "tax", "total", "glance", "inv"];
  function filterChannel(records, channel) {
    channel = channel || "all";
    var hasChannel = records.some(function (r) { return !!r.salesChannel; });
    if (!hasChannel) return records.slice();
    var keep = records.filter(function (r) {
      if (channel === "all") return true;
      var g = r.channelGroup || (r.salesChannel ? "own" : "");
      return channel === "amazon" ? g === "amazon" : g !== "amazon";
    });
    return mergeChannels(keep);
  }

  function mergeChannels(records) {
    var by = Object.create(null), order = [];
    records.forEach(function (r) {
      var k = r.productKey || (r.productId ? "pid:" + r.productId : [r.title, r.vendor, r.ptype].join("␟"));
      var m = by[k];
      if (!m) {
        m = by[k] = Object.assign({}, r, {
          key: k, cur: Object.assign({}, r.cur), prior: Object.assign({}, r.prior || {}),
          salesChannels: r.salesChannel ? [r.salesChannel] : [], sourceRows: r.sourceRows || 1
        });
        delete m.salesChannel;
        order.push(k);
        return;
      }
      CHANNEL_SUM_KEYS.forEach(function (f) {
        if (r.cur && r.cur[f] != null) m.cur[f] = (m.cur[f] || 0) + r.cur[f];
        if (r.prior && r.prior[f] != null) m.prior[f] = (m.prior[f] || 0) + r.prior[f];
      });
      m.priorKnown = !!(m.priorKnown && r.priorKnown);
      m.sourceRows += r.sourceRows || 1;
      if (r.salesChannel && m.salesChannels.indexOf(r.salesChannel) < 0) m.salesChannels.push(r.salesChannel);
    });
    return order.map(function (k) {
      var m = by[k];
      CHANNEL_SUM_KEYS.forEach(function (f) {
        if (m.cur[f] != null) m.cur[f] = f === "units" || f === "glance" || f === "inv" ? Math.round(m.cur[f]) : r2(m.cur[f]);
        if (m.prior[f] != null) m.prior[f] = f === "units" ? Math.round(m.prior[f]) : r2(m.prior[f]);
      });
      m.channelGroup = m.salesChannels.length && m.salesChannels.every(function (c) { return /\b(sellbrite|amazon)\b/i.test(c); })
        ? "amazon" : (m.salesChannels.length ? "own" : "");
      // keep the legacy flat fields the older tabs read in step with `cur`
      if (m.cur) {
        m.units = m.cur.units; m.gross = m.cur.gross; m.disc = m.cur.disc; m.ret = m.cur.ret;
        m.net = m.cur.net; m.tax = m.cur.tax; m.rev = m.cur.total;
        m.avg = m.cur.units ? r2(m.cur.net / m.cur.units) : 0;
      }
      return m;
    });
  }

  // ----------------------------------------------------------
  // Aggregation
  // ----------------------------------------------------------
  // `glance` (Amazon traffic) and `inv` (Amazon inventory) are summed where a
  // source supplies them and stay 0 where it does not. Conversion is derived,
  // never summed.
  var MKEYS = ["units", "gross", "disc", "ret", "net", "tax", "total", "glance", "inv"];
  var INT_KEYS = { units: 1, glance: 1, inv: 1 };

  function zero() { var o = {}; MKEYS.forEach(function (k) { o[k] = 0; }); return o; }
  function add(dst, src) { MKEYS.forEach(function (k) { dst[k] += (src && src[k]) || 0; }); return dst; }
  function r2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }
  function finish(o) {
    MKEYS.forEach(function (k) { o[k] = INT_KEYS[k] ? Math.round(o[k] || 0) : r2(o[k] || 0); });
    return o;
  }

  function totalsOf(records) {
    var cur = zero(), prior = zero(), priorKnown = false;
    records.forEach(function (r) {
      add(cur, r.cur);
      if (r.priorKnown) { add(prior, r.prior); priorKnown = true; }
    });
    return { cur: finish(cur), prior: finish(prior), priorKnown: priorKnown, products: records.length };
  }

  function groupBy(records, keyOf, decorate) {
    var map = Object.create(null), order = [];
    records.forEach(function (r) {
      var k = keyOf(r);
      if (k == null) return;
      var b = map[k];
      if (!b) {
        b = map[k] = { key: k, cur: zero(), prior: zero(), priorKnown: false, products: 0, withSales: 0, records: [] };
        if (decorate) decorate(b, r);
        order.push(k);
      }
      add(b.cur, r.cur);
      if (r.priorKnown) { add(b.prior, r.prior); b.priorKnown = true; }
      b.products++;
      if ((r.cur.units || 0) !== 0 || (r.cur.net || 0) !== 0) b.withSales++;
      b.records.push(r);
    });
    return order.map(function (k) { var b = map[k]; finish(b.cur); finish(b.prior); return b; });
  }

  function aggregateByGroup(records) {
    return groupBy(records, function (r) { return r.group || UNCLASSIFIED; }, function (b, r) {
      b.group = r.group || UNCLASSIFIED;
      b.groupType = r.groupType || GROUP_TYPE_CATEGORY;
      b.isPlant = !!r.isPlant;
    });
  }
  function aggregateByVendor(records) {
    return groupBy(records, function (r) { return r.vendor; }, function (b, r) { b.vendor = r.vendor; });
  }
  function aggregateByProductType(records) {
    return groupBy(records, function (r) { return r.ptype; }, function (b, r) { b.ptype = r.ptype; });
  }

  function withShare(buckets, measure, scopeTotal) {
    var denom = scopeTotal;
    if (denom == null) denom = buckets.reduce(function (s, b) { return s + (b.cur[measure] || 0); }, 0);
    buckets.forEach(function (b) { b.share = denom ? (b.cur[measure] || 0) / denom : 0; });
    return buckets;
  }

  function avgPerUnit(t) { return t && t.units ? r2(t.net / t.units) : 0; }
  // Amazon conversion is units / glance views, derived at every level.
  function conversionOf(t) { return t && t.glance ? t.units / t.glance : 0; }

  // ----------------------------------------------------------
  // Pagination
  // ----------------------------------------------------------
  // Search and sorting run over the WHOLE filtered set; this only chooses the
  // slice to paint. Exports never go through it.
  function paginate(records, page, pageSize) {
    var total = records.length;
    if (!pageSize || pageSize === "all" || pageSize >= total) {
      return { rows: records, page: 1, pages: 1, pageSize: total, total: total, from: total ? 1 : 0, to: total };
    }
    var size = Math.max(1, pageSize | 0);
    var pages = Math.max(1, Math.ceil(total / size));
    var p = Math.min(Math.max(1, page | 0 || 1), pages);
    var from = (p - 1) * size;
    return {
      rows: records.slice(from, from + size),
      page: p, pages: pages, pageSize: size, total: total,
      from: total ? from + 1 : 0, to: Math.min(from + size, total)
    };
  }

  return {
    GROUP_TYPE_GENUS: GROUP_TYPE_GENUS,
    GROUP_TYPE_CATEGORY: GROUP_TYPE_CATEGORY,
    GROUP_UNCLASSIFIED: UNCLASSIFIED,
    GROUP_UNIDENTIFIED_PLANT: UNIDENTIFIED_PLANT,
    GROUP_MIXED_PACK: MIXED_PACK,
    GROUP_MEASURE_KEYS: MKEYS,
    DEFAULT_EXCLUSIONS: DEFAULT_EXCLUSIONS,
    knownCategories: knownCategories,
    classifyProductType: classifyProductType,
    categoryFromTitle: categoryFromTitle,
    naturalClassification: naturalClassification,
    classifyRecord: classifyRecord,
    classifySuspicion: classifySuspicion,
    flaggedRecords: flaggedRecords,
    overrideKeyFor: overrideKeyFor,
    makeOverrideLookup: makeOverrideLookup,
    setOverride: setOverride,
    splitExclusions: splitExclusions,
    applyScope: applyScope,
    filterChannel: filterChannel,
    mergeChannels: mergeChannels,
    groupTotals: totalsOf,
    aggregateByGroup: aggregateByGroup,
    aggregateByVendor: aggregateByVendor,
    aggregateByProductType: aggregateByProductType,
    withShare: withShare,
    avgPerUnit: avgPerUnit,
    conversionOf: conversionOf,
    paginate: paginate
  };
});
