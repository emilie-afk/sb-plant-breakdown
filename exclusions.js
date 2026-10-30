// Restricted items: products the store may not sell. The list itself is
// private business configuration and is NOT in this file: it is the shared
// setting "restricted_items" ({items:[{sku, name}]}), loaded after sign-in
// (data-imports-view.js -> setRestrictedItems). Until it loads, nothing is
// marked restricted and the dashboard says the list is not loaded.
// Import or update it with: node tools/private-settings.mjs push restricted_items <file>
var RESTRICTED_ITEMS = [];
var RESTRICTED_SKUS = new Set();
// Also index by the first 8 characters of a SKU (variants like -6, -12 differ)
var RESTRICTED_SKU_PREFIXES = new Set();
var RESTRICTED_LOADED = false;
function setRestrictedItems(items) {
  RESTRICTED_ITEMS = (Array.isArray(items) ? items : []).filter(function (x) { return x && (x.sku || x.name); })
    .map(function (x) { return { sku: String(x.sku || ""), name: String(x.name || "") }; });
  RESTRICTED_SKUS = new Set(RESTRICTED_ITEMS.filter(function (x) { return x.sku; }).map(function (x) { return x.sku.toUpperCase(); }));
  RESTRICTED_SKU_PREFIXES = new Set(RESTRICTED_ITEMS.filter(function (x) { return x.sku.length >= 8; }).map(function (x) { return x.sku.toUpperCase().slice(0, 8); }));
  RESTRICTED_LOADED = Array.isArray(items);
}
function restrictedListLoaded() { return RESTRICTED_LOADED; }
function isRestricted(sku, title) {
  if (!sku && !title) return false;
  var s = String(sku || "").toUpperCase().trim();
  if (s && RESTRICTED_SKUS.has(s)) return true;
  if (s && s.length >= 8 && RESTRICTED_SKU_PREFIXES.has(s.slice(0, 8))) return true;
  // Title fallback: match if a restricted item name is a substring
  if (title) {
    var t = String(title).toLowerCase();
    for (var i = 0; i < RESTRICTED_ITEMS.length; i++) {
      var r = RESTRICTED_ITEMS[i].name.toLowerCase();
      // strip bracketed suffixes like [extra large] and compare the first 40 chars
      var rBase = r.replace(/[.*?]/g, "").trim().slice(0, 40);
      if (rBase.length > 12 && t.indexOf(rBase) >= 0) return true;
    }
  }
  return false;
}
