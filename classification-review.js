// ============================================================
// classification-review.js
// Shared "classifications to review" panel for both channels.
//
// It lists rows where the source's own product type disagrees with what the
// title plainly says, and lets a human set an explicit override.
//
// An override changes ONLY the analytics group. The imported product type,
// the imported title and every imported figure stay exactly as the source
// stated them, and the classification the data would have produced on its own
// is kept beside the override so it can always be undone or audited.
// ============================================================
(function () {
  "use strict";
  var PG = window;
  var OVERRIDE_KEY = "sb-classification-overrides-v1";

  // Hand-set analytics groups, shared by both channels. Imported values are
  // never touched; this store only ever holds the replacement grouping.
  window.SBOverrides = {
    STORAGE_KEY: OVERRIDE_KEY,
    load: function () {
      try { return JSON.parse(localStorage.getItem(OVERRIDE_KEY) || "{}") || {}; } catch (e) { return {}; }
    },
    save: function (map) {
      try { localStorage.setItem(OVERRIDE_KEY, JSON.stringify(map)); }
      catch (e) { console.warn("override save failed", e); }
    }
  };

  function esc(s) { return window.BUI.esc(s); }

  function optionsFor(selected) {
    return PG.knownCategories().map(function (c) {
      return '<option value="cat:' + esc(c) + '"' + (selected === c ? " selected" : "") + ">" + esc(c) + "</option>";
    }).join("");
  }

  function render(flagged, prefix) {
    var rows = flagged.slice(0, 100).map(function (r, i) {
      var key = PG.overrideKeyFor(r);
      return "<tr>" +
        "<td>" + esc(r.title) + "</td>" +
        '<td class="small">' + esc(r.ptype) + "</td>" +
        "<td>" + esc(r.group) + " " + window.BUI.groupTypeBadge(r.groupType) + "</td>" +
        '<td class="small">' + esc(r.suspicion.message) + "</td>" +
        '<td><select data-' + prefix + 'ov="' + esc(key) + '" style="font-size:12px;padding:4px;max-width:190px">' +
          '<option value="">— keep as imported —</option>' +
          (r.suspicion.suggested ? '<option value="cat:' + esc(r.suspicion.suggested) + '">Use suggestion: ' + esc(r.suspicion.suggested) + "</option>" : "") +
          '<option value="genus:' + esc(PG.GROUP_UNIDENTIFIED_PLANT) + '">Treat as a plant (unidentified genus)</option>' +
          optionsFor(null) +
        "</select></td>" +
        '<td><button class="tab" data-' + prefix + 'apply="' + esc(key) + '">Apply</button></td>' +
        "</tr>";
    }).join("");
    return '<div class="small" style="margin-bottom:8px">' +
      "These are not errors in the import. The figures are exactly as the source stated them; only the " +
      "<b>analytics group</b> is in question, and applying an override leaves the imported product type untouched." +
      "</div>" +
      '<div class="scroll" style="max-height:340px"><table><thead><tr>' +
      "<th>Product</th><th>Imported product type</th><th>Current analytics group</th><th>Why it is flagged</th>" +
      "<th>Override</th><th></th></tr></thead><tbody>" + rows + "</tbody></table></div>" +
      (flagged.length > 100 ? '<div class="small">Showing the first 100 of ' + flagged.length + ".</div>" : "");
  }

  function wire(panel, prefix, redraw) {
    panel.querySelectorAll("[data-" + prefix + "apply]").forEach(function (btn) {
      btn.onclick = function () {
        var key = btn.getAttribute("data-" + prefix + "apply");
        var sel = panel.querySelector('[data-' + prefix + 'ov="' + CSS.escape(key) + '"]');
        if (!sel) return;
        var v = sel.value;
        var map = window.SBOverrides.load();
        if (!v) {
          delete map[key];
        } else {
          var isGenus = v.indexOf("genus:") === 0;
          map[key] = {
            group: v.slice(v.indexOf(":") + 1),
            groupType: isGenus ? PG.GROUP_TYPE_GENUS : PG.GROUP_TYPE_CATEGORY,
            isPlant: isGenus,
            note: "set by hand in classification review",
            setAt: new Date().toISOString()
          };
        }
        window.SBOverrides.save(map);
        redraw();
      };
    });
  }

  // Everything a human has overridden, for the audit line and for undo.
  function activeOverrides() {
    var map = window.SBOverrides.load();
    return Object.keys(map).map(function (k) { return Object.assign({ key: k }, map[k]); });
  }
  function clearAll() { window.SBOverrides.save({}); }

  window.SBFlagUI = { render: render, wire: wire, activeOverrides: activeOverrides, clearAll: clearAll };
})();
