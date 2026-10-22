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
  // Canonical taxonomy
  // ----------------------------------------------------------
  // Every source (Shopify, Amazon, ShipStation market) is classified by the
  // SAME rules into the SAME names. Each record gets two separate fields:
  //   category  what the product is: "Plants" for a single live plant, or a
  //             product category (Gifts, Subscriptions, Mixed variety pack,
  //             Heat Packs, Fertilizer, Pots & Planters, ...)
  //   genus     the botanical genus when one is identifiable, else "".
  //             A gift box or subscription can carry a genus; a mixed pack
  //             never does; "Bundle" and "Subscription" are never genera.
  // The PRIMARY group (one per product, used by every breakdown) is the genus
  // for plants ("Unidentified plant" when unknown) and the category otherwise.
  // Imported product types are evidence, not truth: an explicit title
  // (heat pack, gift card, subscription, plant food, gift box) can overrule a
  // stale type. Marketing phrases ("great gift for mom", "party favors",
  // "gift ideas"), cultivar names in quotes ('Party Favor', 'Ruby Glow') and
  // pot-size descriptors ("(2" Pots)", "in a 4" grower pot") are ignored.
  var CATEGORY_PLANTS = "Plants";
  var C = {
    GIFTS: "Gifts", GIFT_CARDS: "Gift Cards", SUBS: "Subscriptions", HEAT: "Heat Packs",
    FERT: "Fertilizer", SOIL: "Soil", POTS: "Pots & Planters", TOOLS: "Tools", ACC: "Accessories",
    KITS: "Kits", STAT: "Stationery & Cards", MERCH: "Merchandise", DECOR: "Decor",
    APPAREL: "Apparel", SHIP_PROT: "Shipping Protection", SHIP: "Shipping & Fees", SERVICES: "Services"
  };
  // Categories that can contain plants and so keep an identifiable genus.
  var GENUS_BEARING = { "Gifts": 1, "Subscriptions": 1 };

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
    "gift": C.GIFTS, "gifts": C.GIFTS, "gift box": C.GIFTS, "gift boxes": C.GIFTS, "gift set": C.GIFTS,
    "corporate gift": C.GIFTS, "corporate gifts": C.GIFTS,
    "gift card": C.GIFT_CARDS, "gift cards": C.GIFT_CARDS,
    "subscription": C.SUBS, "subscriptions": C.SUBS, "subscription box": C.SUBS,
    "heat pack": C.HEAT, "heat packs": C.HEAT,
    "pots & planters": C.POTS, "pots and planters": C.POTS,
    "pot": C.POTS, "pots": C.POTS, "planter": C.POTS, "planters": C.POTS,
    "soil": C.SOIL, "soils": C.SOIL, "potting mix": C.SOIL, "substrate": C.SOIL,
    "fertilizer": C.FERT, "fertilizers": C.FERT, "plant food": C.FERT,
    "tool": C.TOOLS, "tools": C.TOOLS, "gardening tool": C.TOOLS, "gardening tools": C.TOOLS,
    "accessory": C.ACC, "accessories": C.ACC,
    "garden supplies/accessories": C.ACC, "garden supplies": C.ACC, "accessories/tools": C.ACC,
    "greeting card": C.STAT, "greeting cards": C.STAT, "care card": C.STAT, "care cards": C.STAT,
    "id card": C.STAT, "id cards": C.STAT,
    "notepad": C.STAT, "notepads": C.STAT, "bookmark": C.STAT, "bookmarks": C.STAT,
    "calendars, organizers & planners": C.STAT,
    "calendar": C.STAT, "calendars": C.STAT,
    "sticker": C.STAT, "stickers": C.STAT,
    "coloring book": C.STAT, "custom coloring book": C.STAT,
    "insurance": C.SHIP_PROT, "shipping protection": C.SHIP_PROT,
    "shipping": C.SHIP, "service": C.SERVICES, "services": C.SERVICES,
    "apparel": C.APPAREL, "merchandise": C.MERCH, "merch": C.MERCH,
    "kit": C.KITS, "kits": C.KITS, "terrarium": C.KITS,
    "decor": C.DECOR
  };
  // Values that carry no product information (a fulfilment label, a blank).
  var NON_INFORMATIVE_TYPES = { "": 1, "(none)": 1, "none": 1, "unclassified": 1, "dropship": 1, "n/a": 1 };

  // One display label per product type, so "Air Plant", "Air Plants",
  // "Air PLants" and "AirPlant" show as one entry. The raw value is kept on
  // the record (ptype) and is what exports show as "Imported product type".
  var TYPE_LABELS = {
    "succulent": "Succulents", "houseplant": "Houseplants", "indoorplant": "Houseplants",   // decided: one label
    "outdoorplant": "Outdoor Plants", "airplant": "Air Plants", "cactu": "Cactus", "cacti": "Cactus",
    "tree": "Trees", "liveplant": "Live Plants", "plant": "Plants",
    "gift": "Gift", "giftbox": "Gift Box", "corporategift": "Corporate Gifts", "giftcard": "Gift Card",
    "subscription": "Subscription", "fertilizer": "Fertilizers", "potsplanter": "Pots & Planters",
    "potsandplanter": "Pots & Planters", "accessorie": "Accessories", "accessory": "Accessories",
    "gardeningtool": "Gardening Tools", "greetingcard": "Greeting Card", "carecard": "Care Card",
    "idcard": "ID Card", "notepad": "Notepad", "bookmark": "Bookmark", "insurance": "Insurance",
    "unclassified": "Unclassified"
  };
  function typeKey(ptype) {
    return String(ptype == null ? "" : ptype).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "")
      .replace(/and(?=planter)/, "").replace(/s$/, "");
  }
  function canonicalProductType(ptype) {
    var raw = String(ptype == null ? "" : ptype).trim().replace(/\s+/g, " ");
    if (!raw) return "";
    var k = typeKey(raw);
    return TYPE_LABELS[k] || raw;
  }

  // All category names this module can produce, for override pickers.
  function knownCategories() {
    var set = {};
    Object.keys(C).forEach(function (k) { set[C[k]] = 1; });
    set[MIXED_PACK] = 1;
    set[UNCLASSIFIED] = 1;
    return Object.keys(set).sort(function (a, b) { return a.localeCompare(b); });
  }

  function norm(s) {
    return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
  }

  function classifyProductType(ptype) {
    var n = norm(ptype);
    if (NON_INFORMATIVE_TYPES[n]) return { kind: "unknown", category: null };
    if (PLANT_TYPES[n] || PLANT_TYPES[n.replace(/\s+/g, "")]) return { kind: "plant", category: null };
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
      allGenera: opts.detectAllGenera || (root && root.detectAllGenera) || null,
      nonPlant: opts.detectNonPlantType || (root && root.detectNonPlantType) || function () { return ""; }
    };
  }

  // ---- title cleaning ---------------------------------------
  var BRAND_RE = /\bsucculents?\s*box\b(?!\s*club)/gi;
  // a quoted cultivar or trade name: 'Party Favor', ‘Ruby Glow’
  var QUOTED_RE = /(^|[\s(\-–])['‘][^'‘’"]{1,40}['’](?=$|[\s),.;:|\-–])/g;
  var MARKETING_RES = [
    /\b(great|perfect|ideal|best|unique|cute|thoughtful)\s+gifts?\b/gi,
    /\bgifts?\s+ideas?\b/gi,
    /\bgift[\s-]*(worthy|able|ready)\b/gi,
    /\bas\s+(an?\s+)?gifts?\b/gi,
    /\bfor\s+[^,|()\-–—:;]*/gi,                      // "for Mom", "for Succulents & Air Plants"
    /\b(wedding|party|baby\s+shower|bridal\s+shower|birthday)?\s*favou?rs?\b/gi,
    /\b(mother'?s|father'?s|valentine'?s?|teacher|christmas|holiday|housewarming)\s+day\b/gi,
    /\bno\s+soil(\s+(needed|required))?\b|\bsoil[\s-]*(free|less)\b|\bsoilless\b/gi,
    /\b(with\s+(a\s+)?)?(free\s+)?(succulents?\s+|plant\s+)?care\s+(guide|card|instructions)s?\b(?=.*\S)/gi
  ];
  // keepQuoted: quoted names are kept for genus detection ('Christmas Cactus',
  // 'Sprengeri' name the plant) and dropped for category words ('Party Favor',
  // 'Irish Bouquet' are cultivars, not product types).
  function stripMarketing(t, keepQuoted) {
    var s = String(t == null ? "" : t).replace(/[®™]|Â®|â„¢/g, "").replace(BRAND_RE, " ");
    if (!keepQuoted) s = s.replace(QUOTED_RE, "$1 ");
    MARKETING_RES.forEach(function (re) { s = s.replace(re, " "); });
    return s.replace(/\s+/g, " ").trim();
  }
  var SIZE = "\\d+(?:\\.\\d+)?\\s*(?:[\"”'′]{1,2}|-?\\s*inch(?:es)?\\b|in\\b|cm\\b)";
  var POT_WORD = "(?:pots?|planters?|containers?|vases?)";
  var POT_DESCRIPTOR_RES = [
    new RegExp("\\([^()]*\\b" + POT_WORD + "\\b[^()]*\\)", "gi"),                       // (2" Pots), (4" Grower Pot)
    new RegExp("\\b(?:in|with|w\\/|plus)\\s+(?:an?\\s+)?(?:" + SIZE + "\\s*)?(?:[\\w-]+\\s+){0,4}?" + POT_WORD + "\\b", "gi"),
    new RegExp("\\+\\s*(?:" + SIZE + "\\s*)?(?:[\\w-]+\\s+){0,3}?" + POT_WORD + "\\b", "gi"),
    new RegExp("\\b" + SIZE + "\\s*(?:[\\w/-]+\\s+){0,3}?" + POT_WORD + "\\b", "gi"),      // 2 Inch Hexagon Ceramic Pot
    new RegExp("\\b(?:nursery|grower|plastic|clay|terra\\s*cotta|eco\\s+bamboo)\\s+pots?\\b", "gi")
  ];
  function stripPotDescriptors(t) {
    var s = t;
    POT_DESCRIPTOR_RES.forEach(function (re) { s = s.replace(re, " "); });
    return s.replace(/\s+/g, " ").trim();
  }
  // Words that mean "this is a live plant" even when no genus is recognised.
  var LIVE_PLANT_RE = /\b(succulents?|cactus|cacti|air ?plants?|houseplants?|house plants?|live plants?|plants|seedlings?|cuttings?|ferns?|orchids?|carnivorous)\b/i;

  // ---- title category rules ----------------------------------
  // STRONG rules name what the product is, whatever plant it mentions.
  var SUBSCRIPTION_TITLE_RE = /\b(subscriptions?|subscribe|auto[\s-]*renew(al)?|month(ly)?\s+(plan|box|club|shipment)|(\d+\s*)?month\s+plan)\b|\/\s*month\b|\bper\s+month\b|\b(succulents?\s*box|succulent|plant|air\s*plant)\s+club\b/i;
  var STRONG_RULES = [
    [/\b(heat|warm(ing)?)\s*packs?\b/i, C.HEAT],
    [/\b(shipping|package|order|delivery)\s+(protection|insurance)\b|\bwinter\s+(plant\s+)?shipping\b/i, C.SHIP_PROT],
    [/\b(e-?)?gift\s*cards?\b|\begift\b|\bdiscount\s+card\b/i, C.GIFT_CARDS],
    [SUBSCRIPTION_TITLE_RE, C.SUBS],
    [/\b(fertili[sz]ers?|plant\s+food|nutrients?|plant\s+tonic|bloom\s+booster)\b/i, C.FERT],
    [/\b(printables?|greeting\s+cards?|post\s*cards?|bookmarks?|calendars?|planners?|notepads?|stickers?|colou?ring\s+(books?|sheets?|pages?)|id\s+cards?|snaps?\s+sets?)\b/i, C.STAT],
    [/\bgift\s*(box|boxes|set|sets|basket|baskets|bag|bags|crate|bundle)\b|\bgift[\s-]*wrapped\b|\barrangements?\b|\b(succulents|plants|cacti)\b[^|,]*\bin\b[^|,]*\bplanters?\b|\bcenter\s*pieces?\b|\bmemorial\b|\bsympathy\b|\bbouquets?\b/i, C.GIFTS],
    [/\((book|paperback|hardcover)\)|\bbooks?\b/i, C.MERCH],
    [/\bkits?\b/i, C.KITS],
    [/\b(potting\s+soil|soil|potting\s+mix|coco\s+coir|pumice|perlite|lava\s+rock|top\s+dressing|substrate|mulch)\b/i, C.SOIL],
    [/\b(tool\s*sets?|tools?|tweezers?|scissors?|shears|trowels?|repotting\s+mat|dust\s+blower|plant\s+waterer|watering\s+(can|bulb|globe)s?)\b/i, C.TOOLS]
  ];
  // WEAK rules apply only when no genus is named (a plant in a pot is a plant).
  var WEAK_RULES = [
    [new RegExp("\\b(" + POT_WORD + "|terracotta|terra\\s+cotta|hanging\\s+planter|drainage\\s+(screens?|mesh))\\b", "i"), C.POTS],
    [/\b(accessor(y|ies)|macrame|hangers?|plant\s+stands?|shelf|shelves|saucers?|coasters?|moisture\s+meter|humidifier|grow\s+lights?|plant\s+holders?)\b/i, C.ACC],
    [/\b(care\s+(card|guide)s?|posters?|canvas\s+prints?|art\s+prints?|wall\s+art)\b/i, C.STAT],
    [/\b(reindeer\s+moss|sheet\s+moss|preserved\s+moss|mood\s+moss|moss|ghost\s+wood|drift\s*wood|grape\s*wood|spider\s+wood|pebbles|rocks|sand|figurines?)\b/i, C.DECOR],
    [/\b(t-?shirts?|tees?|hoodies?|totes?|mugs?|plush|stuffed|crochet|candles?)\b/i, C.MERCH]
  ];
  var BUNDLE_TITLE_RE = /\b(variety\s+(pack|bundle|mix|box)|packs?|bundles?|samplers?|assorted|assortment|collection\s+of|bulk|wholesale|flats?|trio|duo|\d+\s*[- ]?\s*(pack|pk|pcs?|pieces?|count|ct|plants|types)\b|pack\s+of\s+\d+|\d+\s*-\s*\d+\s+plants|best\s+value\s+pack|mystery\s+(box|pack)|dish\s+garden|fairy\s+garden)\b/i;
  var SINGLE_VARIETY_RE = /\bsingle\s+(variety|type|types)\b/i;

  function firstRule(rules, text) {
    for (var i = 0; i < rules.length; i++) if (rules[i][0].test(text)) return rules[i][1];
    return null;
  }
  function spanishMoss(t) { return /\bspanish\s+moss\b/i.test(t); }

  var ADD_ON_RE = /\bsubscription\s+add[\s-]?ons?\b|\badd[\s-]?ons?\b[^|]*\bsubscription\b|\(\s*subscription\s*\)/i;
  var ADD_ON_STRIP_RE = /\bsubscription\s+add[\s-]?ons?\b|\(\s*subscription\s*\)|\bsubscription\b|\badd[\s-]?ons?\b/gi;

  // Decided display names, the same in every source:
  //  - snake plants are shown as Sansevieria (other Dracaena stay Dracaena)
  //  - verified Epipremnum products are shown as Pothos; Scindapsus sold as
  //    "satin pothos" stays Scindapsus
  var SPECIFIC_NAMES = [
    [/\bscindapsus\b|\b(silver\s+)?satin\s+pothos\b/i, "Scindapsus"],
    [/\bsnake\s+plants?\b|\bmother[\s-]+in[\s-]+law'?s?\s+tongue\b|\bsansevieria\b/i, "Sansevieria"],
    [/\bdracaena\s+(trifasciata|angolensis|cylindrica|masoniana|hahnii|zeylanica|kirkii|ehrenbergii|bacularis)\b/i, "Sansevieria"]
  ];
  var GENUS_DISPLAY = { "Epipremnum": "Pothos" };
  function specificGenus(t) {
    for (var i = 0; i < SPECIFIC_NAMES.length; i++) if (SPECIFIC_NAMES[i][0].test(t)) return SPECIFIC_NAMES[i][1];
    return "";
  }
  function displayGenus(g) { return (g && GENUS_DISPLAY[g]) || g || ""; }

  // Everything the title says, computed once.
  function readTitle(title, opts) {
    var d = detectors(opts);
    var raw = String(title == null ? "" : title);
    // A subscription add-on is classified by the item itself (a heat pack, a
    // plant, an accessory); "subscription add-on" is kept as an attribute.
    var addOn = ADD_ON_RE.test(raw);
    var base = addOn ? raw.replace(ADD_ON_STRIP_RE, " ") : raw;
    var clean = stripMarketing(base);
    var named = stripMarketing(base, true);
    var plantWord = LIVE_PLANT_RE.test(named);
    var gRaw = specificGenus(named) || d.genus(named) || "";
    var genus = displayGenus(gRaw === "Bundle" || gRaw === "Subscription" ? "" : gRaw);
    var genera = (d.allGenera ? d.allGenera(named) : (genus ? [genus] : [])).map(displayGenus)
      .filter(function (x, i, a) { return x && a.indexOf(x) === i; });
    if (genus && genera.indexOf(genus) < 0) genera = [genus].concat(genera);
    var plantSignal = !!genus || plantWord;
    // Pot sizes describe the plants in a plant title or a plant bundle
    // ("Air Purifying Variety Bundle - 4" Pots").
    var forWeak = plantSignal || /\b(variety|assorted|bundle|mystery)\b/i.test(clean) ? stripPotDescriptors(clean) : clean;
    var strong = firstRule(STRONG_RULES, clean);
    // "subscription" said only inside brackets of a non-subscription product
    // (e.g. "Heat Pack (Subscription)") is handled by rule order: heat first.
    // With a plant in the title, only a pot left after removing pot-size
    // descriptors counts ("Houseplant Pattern Pot"); a saucer, tray or stand
    // sold with a plant does not make it an accessory.
    var weak = strong ? null : firstRule(plantSignal ? WEAK_RULES.slice(0, 1) : WEAK_RULES, forWeak);
    if (weak === C.DECOR && spanishMoss(clean)) weak = null;
    var bundle = BUNDLE_TITLE_RE.test(forWeak) && !SINGLE_VARIETY_RE.test(clean);
    return { raw: raw, clean: clean, genus: genus, genera: genera, plantWord: plantWord,
             plantSignal: plantSignal, strong: strong, weak: weak, bundle: bundle, addOn: addOn };
  }

  // A genus a category record may carry: one named genus, never a mix.
  function bearingGenus(t) { return t.genera.length > 1 ? "" : t.genus; }

  // The category the TITLE alone suggests, independent of product type.
  // Used both as a fallback and to flag disagreements for review.
  function categoryFromTitle(title, opts) {
    var t = readTitle(title, opts);
    if (t.strong) return t.strong;
    if (t.genus) return null;                 // the title names a real genus
    if (t.weak) return t.weak;
    return null;
  }

  function result(category, genus, basis, ptype) {
    var isPlantCat = category === CATEGORY_PLANTS;
    var group = isPlantCat ? (genus || UNIDENTIFIED_PLANT) : category;
    return {
      group: group,
      groupType: isPlantCat ? GROUP_TYPE_GENUS : GROUP_TYPE_CATEGORY,
      isPlant: isPlantCat || category === MIXED_PACK,
      category: category,
      genus: category === MIXED_PACK ? "" : (isPlantCat || GENUS_BEARING[category] ? (genus || "") : ""),
      basis: basis,
      ptypeCanonical: canonicalProductType(ptype)
    };
  }
  function plantOrPack(t, basis, ptype) {
    if (t.bundle && t.genera.length > 1) return result(MIXED_PACK, "", basis + "+mixed_genera", ptype);
    if (t.genus) return result(CATEGORY_PLANTS, t.genus, basis + "+genus", ptype);
    if (t.bundle) return result(MIXED_PACK, "", basis + "+pack", ptype);
    return null;
  }

  // ----------------------------------------------------------
  // Classification
  // ----------------------------------------------------------
  // The classification the data itself implies, before any override.
  function naturalClassification(rec, opts) {
    var t = readTitle(rec && rec.title ? rec.title : "", opts);
    var out = naturalCore(rec, opts, t);
    // Attributes recorded beside the group, never instead of it: several
    // plants of one genus stay under that genus and are marked as a pack;
    // an add-on bought with a subscription is grouped by the item itself.
    out.pack = !!t.bundle && (out.category === CATEGORY_PLANTS || out.category === MIXED_PACK);
    out.subscriptionAddOn = !!t.addOn;
    return out;
  }
  function naturalCore(rec, opts, t) {
    var d = detectors(opts);
    var ptype = rec && rec.ptype;
    var pt = classifyProductType(ptype);
    if (t.addOn && pt.kind === "category" && pt.category === C.SUBS) pt = { kind: "unknown", category: null };

    if (pt.kind === "category") {
      // A heat pack, gift card, explicit subscription, plant food or printable
      // named in the title is what the product is, whatever its stored type
      // ("Heat Pack" typed Fertilizers; a gift card typed Greeting Card).
      var definitive = t.strong === C.HEAT || t.strong === C.GIFT_CARDS ||
        (t.strong === C.STAT && /\bprintables?\b/i.test(t.clean)) ||
        (!GENUS_BEARING[pt.category] && pt.category !== C.KITS && (t.strong === C.SUBS || t.strong === C.FERT));
      if (definitive && t.strong !== pt.category) return result(t.strong, bearingGenus(t), "title_overrides_type", ptype);
      // A gift holding a succulent is a Gift, and keeps its genus.
      return result(pt.category, bearingGenus(t), "product_type", ptype);
    }

    if (pt.kind === "plant") {
      // Typed as a plant, but the title plainly names something else:
      // "Succulent Gift Box", "Air Plant Food", "Heat Pack".
      if (t.strong) return result(t.strong, bearingGenus(t), "title_overrides_type", ptype);
      return plantOrPack(t, "product_type", ptype) ||
             result(CATEGORY_PLANTS, "", "product_type", ptype);
    }

    // No usable product type: the title decides, in this order.
    //  1. what the title says the product is (heat pack, gift box, ...)
    //  2. a real genus (or a pack naming several genera)
    //  3. a weaker category word (pots, accessories, decor) with no genus
    //  4. a pack of plants
    //  5. a plant we cannot name
    //  6. only then Unclassified
    if (t.strong) return result(t.strong, bearingGenus(t), "title_category", ptype);
    if (t.genus) return plantOrPack(t, "title", ptype);
    if (t.weak) return result(t.weak, "", "title_category", ptype);
    if (t.bundle && (t.plantWord || /\b(mystery|variety|assorted)\b/i.test(t.clean))) return result(MIXED_PACK, "", "title+pack", ptype);
    if (t.plantWord) return result(CATEGORY_PLANTS, "", "title_plant_word", ptype);
    if (t.bundle) return result(MIXED_PACK, "", "title+pack", ptype);
    // Last resort: genus-data.js's loose keyword labels, for titles with no
    // plant in them at all (never "mystery" or "bundle", which are plants).
    var label = d.nonPlant(t.clean) || "";
    var fallback = Object.prototype.hasOwnProperty.call(TITLE_TYPE_TO_CATEGORY, label) ? TITLE_TYPE_TO_CATEGORY[label] : null;
    if (fallback) return result(fallback, "", "title_keyword", ptype);

    // Genuinely unknown. Visible as Unclassified; never hidden, never merged
    // into "no genus" alongside pots and gift cards.
    return result(UNCLASSIFIED, "", "none", ptype);
  }

  // detectNonPlantType() (genus-data.js) labels -> canonical names, used only
  // as the last resort above.
  var TITLE_TYPE_TO_CATEGORY = {
    "Gift Card": C.GIFT_CARDS, "Subscription": C.SUBS, "Fertilizer": C.FERT, "Soil": C.SOIL,
    "Cutting": null, "Mystery Box": null, "Pot/Planter": C.POTS, "Tool": C.TOOLS,
    "Accessories": C.ACC, "Kit/Equipment": C.KITS, "Bundle": null, "Merchandise": C.MERCH, "Other": null
  };

  // opts.override(record) -> {group, groupType?, isPlant?, genus?, note?} | null
  // An override changes only the analytics grouping. The imported product
  // type on the record is left exactly as the source stated it, and the
  // classification it would have received is kept as `natural`.
  function classifyRecord(rec, opts) {
    opts = opts || {};
    var natural = naturalClassification(rec, opts);
    if (!opts.override) return Object.assign({}, natural, { overridden: false, natural: natural });
    var ov = opts.override(rec);
    if (!ov || !ov.group) return Object.assign({}, natural, { overridden: false, natural: natural });
    var asGenus = ov.groupType === GROUP_TYPE_GENUS || (ov.groupType == null && ov.isPlant && ov.group !== MIXED_PACK);
    var out;
    if (asGenus) {
      out = result(CATEGORY_PLANTS, ov.group === UNIDENTIFIED_PLANT ? "" : ov.group, "override", rec && rec.ptype);
    } else {
      out = result(ov.group, ov.genus != null ? ov.genus : natural.genus, "override", rec && rec.ptype);
    }
    out.overridden = true;
    out.overrideNote = ov.note || "";
    out.overrideSource = ov.source || "";
    out.pack = natural.pack; out.subscriptionAddOn = natural.subscriptionAddOn;
    out.natural = natural;
    return out;
  }

  // The value the older tabs (Cross-channel, Opportunity Map, Owned vs
  // Market, External Stores) aggregate on as "genus": the canonical primary
  // group for plant genera and for the plant-bearing categories every source
  // shares (Mixed variety pack, Gifts, Subscriptions), "(no genus)" for the
  // rest, exactly as those tabs have always treated non-plants.
  var LEGACY_GROUPS = { "Mixed variety pack": 1, "Gifts": 1, "Subscriptions": 1 };
  function legacyGenusOf(c) {
    if (!c) return "(no genus)";
    if (c.groupType === GROUP_TYPE_GENUS && c.group && c.group !== UNIDENTIFIED_PLANT) return c.group;
    if (LEGACY_GROUPS[c.group]) return c.group;
    return "(no genus)";
  }
  // Classifies a legacy product row with the shared rules and any saved
  // override. rec: {title, ptype?, vendor?, channel?, asin?, productId?, sku?}
  function legacyGenus(rec) {
    var ov = null;
    try { if (root && root.SBOverrides) ov = makeOverrideLookup(root.SBOverrides.load()); } catch (e) { ov = null; }
    return legacyGenusOf(classifyRecord(rec || {}, { override: ov }));
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
    var nat = naturalClassification(rec || {}, opts);

    // The title already overruled a stale type (a heat pack typed
    // Fertilizers, a gift card typed Greeting Card). The grouping follows the
    // title; this note records the disagreement without asking again.
    if (nat.basis === "title_overrides_type") {
      return {
        kind: "type_overruled_by_title", severity: "info",
        importedType: rec.ptype, fromType: pt.category || "a plant genus", fromTitle: nat.category, suggested: null,
        message: 'Imported product type "' + rec.ptype + '" disagrees with the title; grouped as ' + nat.group +
                 " from the title. Set an override if the type was right."
      };
    }

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
  // Overrides are keyed on the most stable identifier the source gives, so a
  // confirmed correction survives renamed titles, refreshes and historical
  // reports, and never reaches an unrelated product:
  //   Shopify   shopify␟pid:<Product ID>
  //   Amazon    amazon␟<ASIN>
  //   Market    market␟<store>␟sku:<SKU>
  // Records without an identifier fall back to channel + title + vendor +
  // type (the original key), and overrides saved under that original key are
  // still honoured for records that now have an identifier.
  function legacyOverrideKeyFor(rec) {
    return (rec && rec.channel ? rec.channel : "shopify") + OVERRIDE_SEP +
           [rec && rec.title, (rec && (rec.vendorImported != null ? rec.vendorImported : rec.vendor)) || "", (rec && rec.ptype) || ""].join(OVERRIDE_SEP);
  }
  function overrideKeyFor(rec) {
    if (rec && rec.overrideKey) return rec.overrideKey;
    var ch = (rec && rec.channel) || "shopify";
    if (ch === "amazon" && rec.asin) return "amazon" + OVERRIDE_SEP + rec.asin;
    if (ch === "shopify" && rec && rec.productId) return "shopify" + OVERRIDE_SEP + "pid:" + rec.productId;
    if (ch === "market" && rec.sku && rec.vendor) return "market" + OVERRIDE_SEP + rec.vendor + OVERRIDE_SEP + "sku:" + rec.sku;
    return legacyOverrideKeyFor(rec);
  }
  function makeOverrideLookup(map) {
    var m = map || {};
    return function (rec) { return m[overrideKeyFor(rec)] || m[legacyOverrideKeyFor(rec)] || null; };
  }
  function setOverride(map, rec, value) {
    var out = Object.assign({}, map || {});
    var key = overrideKeyFor(rec), old = legacyOverrideKeyFor(rec);
    if (old !== key) delete out[old];
    if (!value || !value.group) delete out[key];
    else out[key] = { group: value.group, groupType: value.groupType || null, isPlant: !!value.isPlant,
                      genus: value.genus != null ? value.genus : undefined,
                      title: (rec && rec.title) || "", note: value.note || "", setAt: value.setAt || new Date().toISOString() };
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
      // The type filter works on the canonical label ("Air Plants" covers
      // "Air Plant", "AirPlant", ...); a raw imported value still matches.
      if (ptype && r.ptype !== ptype && canonicalProductType(r.ptype) !== ptype) return false;
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
    return groupBy(records, function (r) { return canonicalProductType(r.ptype) || r.ptype; }, function (b, r) {
      b.ptype = canonicalProductType(r.ptype) || r.ptype;
    });
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
    CATEGORY_PLANTS: CATEGORY_PLANTS,
    knownCategories: knownCategories,
    canonicalProductType: canonicalProductType,
    legacyGenusOf: legacyGenusOf,
    legacyGenus: legacyGenus,
    legacyOverrideKeyFor: legacyOverrideKeyFor,
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
