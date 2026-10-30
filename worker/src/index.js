// ============================================================
// sb-plant-breakdown Worker — shared report store
//
// Routes and who may call them (see ROUTES below; every other path is 404):
//   GET  /v1/health                          anyone        {ok, service, time} only
//   POST /v1/ingest/product-report           collector, uploader, dashboard   (uploader/dashboard = manual)
//   POST /v1/ingest/collection-failure       collector
//   GET  /v1/ingest/coverage                 collector, dashboard   stored periods only (dates, revisions)
//   POST /v1/ingest/vendor-map               collector, dashboard   setting "vendor_map"
//   GET  /v1/reports[?source=&history=1]     viewer, dashboard
//   GET  /v1/reports/:id/rows                viewer, dashboard
//   GET  /v1/imports[?source=&limit=]        viewer, dashboard
//   GET  /v1/settings/:key                   viewer, dashboard      allowlisted keys only
//   PUT  /v1/settings/:key                   settings, dashboard    {value, baseVersion}
//   POST /v1/auth/attempt | /v1/auth/success auth                  sign-in attempt counters (atomic)
//
// Secrets (Cloudflare secrets, each >= 32 characters; a missing or short one
// simply grants nothing):
//   INGEST_SECRET     the Windows collector: adds reports, records failed
//                     collections, reads stored periods, uploads the vendor map.
//   VIEWER_SECRET     read-only: reports, rows, import history, settings. Held
//                     by the Netlify gateway (server side), never by a browser.
//                     Read-only is not harmless: it exposes revenue history.
//   UPLOAD_SECRET     manual report uploads only (Netlify gateway, editor sessions).
//   SETTINGS_SECRET   shared-settings writes only (Netlify gateway, editor sessions).
//   AUTH_SECRET       sign-in attempt counters only (Netlify gateway); reads nothing.
//   DASHBOARD_SECRET  administration (all of the above except collector-only
//                     failure records); for the operator's own tools, kept in
//                     Windows Credential Manager, never in a browser.
//
// CORS is a browser courtesy, not authentication: every route except health
// checks the bearer key. Product sales reports only: the ingest route refuses
// any payload carrying a customer-looking field, and no route stores or
// returns customer data.
// ============================================================
import { validateProductReport, contentHash } from "./validate.js";
import * as store from "./store.js";
import { validateVendorMap, suspiciousDrop } from "./vendormap.js";

const MAX_BODY = 8 * 1024 * 1024;

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, extraHeaders || {})
  });
}

// Constant-time comparison so a secret cannot be guessed byte by byte.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
function bearer(req) {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}
// Returns the role a request is authorised for, or null. A secret shorter
// than 32 characters is treated as not configured.
const ROLE_SECRETS = [["dashboard", "DASHBOARD_SECRET"], ["collector", "INGEST_SECRET"], ["viewer", "VIEWER_SECRET"],
                      ["uploader", "UPLOAD_SECRET"], ["settings", "SETTINGS_SECRET"], ["auth", "AUTH_SECRET"]];
function roleOf(req, env) {
  const t = bearer(req);
  if (t.length < 32) return null;
  for (const [role, name] of ROLE_SECRETS) {
    const s = env[name];
    if (typeof s === "string" && s.length >= 32 && safeEqual(t, s)) return role;
  }
  return null;
}
const REPORT_ID = /^(shopify|amazon|market):[^:/?#\\\x00-\x1f]{1,120}:\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}:r\d{1,6}$/;
const SOURCE_PARAM = new Set(["shopify", "amazon", "market"]);
const ALLOWED = {
  ingestReport: ["collector", "uploader", "dashboard"],
  failure: ["collector"],
  coverage: ["collector", "dashboard"],
  vendorMap: ["collector", "dashboard"],
  read: ["viewer", "dashboard"],
  settingsWrite: ["settings", "dashboard"],
  authAttempts: ["auth"]
};
const can = (role, what) => ALLOWED[what].indexOf(role) >= 0;

function corsHeaders(req, env) {
  const origin = req.headers.get("origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!origin || allowed.indexOf(origin) < 0) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-max-age": "600",
    "vary": "origin"
  };
}

async function readJson(req, max = MAX_BODY) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > max) throw Object.assign(new Error("Body too large."), { status: 413, code: "body_too_large" });
  const text = await req.text();
  if (text.length > max) throw Object.assign(new Error("Body too large."), { status: 413, code: "body_too_large" });
  try { return JSON.parse(text); }
  catch (e) { throw Object.assign(new Error("Body is not valid JSON."), { status: 400, code: "bad_json" }); }
}

async function ingest(req, env, role) {
  let payload;
  try { payload = await readJson(req); }
  catch (e) { return json({ ok: false, error: e.code, message: e.message }, e.status || 400); }

  // A manual upload from the dashboard is always recorded as manual, and a
  // collector upload as collector, whatever the payload claims.
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({ ok: false, error: "bad_body" }, 400);
  payload.importedBy = role === "collector" ? "collector" : "manual";

  const runId = await store.startRun(env.DB, {
    source: payload && payload.source, reportScope: payload && payload.reportScope,
    periodStart: payload && payload.period && payload.period.start,
    periodEnd: payload && payload.period && payload.period.end,
    importedBy: payload.importedBy, client: payload && payload.client
  });

  const v = validateProductReport(payload);
  if (!v.ok) {
    await store.finishRun(env.DB, runId, {
      outcome: "rejected",
      errorCode: v.errors.map(e => e.code).join(","),
      errorMessage: v.errors.map(e => e.message).join(" | ")
    });
    // The last successful report is untouched: nothing was written.
    return json({ ok: false, runId, outcome: "rejected", errors: v.errors, warnings: v.warnings }, 422);
  }

  const hash = await contentHash(v.normalized);
  try {
    const r = await store.storeReport(env.DB, v.normalized, hash);
    await store.finishRun(env.DB, runId, {
      outcome: r.outcome, rowCount: v.normalized.rowCount, contentHash: hash,
      reportId: r.reportId, revision: r.revision,
      errorMessage: r.overlaps.length ? "Overlaps " + r.overlaps.map(o => o.id).join(", ") + " (never summed)" : null
    });
    return json({ ok: true, runId, outcome: r.outcome, reportId: r.reportId, revision: r.revision,
                  completeness: v.normalized.completeness, markedComplete: !!r.markedComplete,
                  overlaps: r.overlaps, warnings: v.warnings });
  } catch (e) {
    await store.finishRun(env.DB, runId, {
      outcome: "failed", errorCode: e.code || "storage_error",
      errorMessage: "Storage failed; the previous report is unchanged. " + (e.message || "")
    });
    return json({ ok: false, runId, outcome: "failed", error: e.code || "storage_error" }, 500);
  }
}

const FAILURE_CODES = new Set(["sign_in_needed", "captcha", "unknown_page", "export_failed", "validation_failed", "upload_failed", "other"]);
async function recordCollectionFailure(req, env) {
  let b;
  try { b = await readJson(req); } catch (e) { return { ok: false, error: e.code || "bad_body" }; }
  if (!b || typeof b !== "object") return { ok: false, error: "bad_body" };
  const ymd = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  const code = FAILURE_CODES.has(b.errorCode) ? b.errorCode : "other";
  // A short, plain message only: no payloads, no URLs, nothing customer-like.
  const message = String(b.message == null ? "" : b.message).replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>").slice(0, 300);
  const runId = await store.startRun(env.DB, {
    source: ["amazon", "market"].indexOf(b.source) >= 0 ? b.source : "shopify", reportScope: typeof b.reportScope === "string" ? b.reportScope.slice(0, 80) : null,
    periodStart: ymd(b.period && b.period.start), periodEnd: ymd(b.period && b.period.end),
    importedBy: "collector", client: typeof b.client === "string" ? b.client.slice(0, 80) : null
  });
  await store.finishRun(env.DB, runId, { outcome: "failed", errorCode: code, errorMessage: message || code });
  return { ok: true, runId, outcome: "failed" };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    const reply = (body, status) => json(body, status, cors);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/v1/health") return reply({ ok: true, service: "sb-plant-breakdown", time: store.nowIso() });

    const role = roleOf(req, env);
    if (!role) return reply({ ok: false, error: "unauthorized" }, 401);
    const forbidden = () => reply({ ok: false, error: "forbidden" }, 403);
    const badParam = () => reply({ ok: false, error: "bad_parameter" }, 400);
    const p = url.pathname, M = req.method;

    try {
      if (M === "POST" && p === "/v1/ingest/product-report") {
        if (!can(role, "ingestReport")) return forbidden();
        const res = await ingest(req, env, role);
        Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
        return res;
      }

      // The collector reports a run that failed BEFORE it had a file to upload
      // (Shopify sign-in needed, export page failed, file refused by its own
      // checks), so the dashboard can say so. Nothing else is written.
      if (M === "POST" && p === "/v1/ingest/collection-failure") {
        if (!can(role, "failure")) return forbidden();
        return reply(await recordCollectionFailure(req, env));
      }

      // The product -> vendor map built by the collector from the Products
      // Master vendor tabs. Replaces the stored map, unless far fewer products
      // resolve than before (a broken read), which is refused without force.
      if (M === "POST" && p === "/v1/ingest/vendor-map") {
        if (!can(role, "vendorMap")) return forbidden();
        const body = await readJson(req);
        const v = validateVendorMap(body && body.map);
        if (!v.ok) return reply({ ok: false, error: "invalid_vendor_map", errors: v.errors }, 400);
        const cur = await store.getSetting(env.DB, "vendor_map");
        const drop = body.force ? null : suspiciousDrop(v.value, cur && cur.value);
        if (drop) return reply({ ok: false, error: "suspicious_drop", message: drop }, 409);
        const r = await store.putSetting(env.DB, "vendor_map", v.value, cur ? cur.version : 0, role === "collector" ? "collector" : "dashboard");
        if (!r.ok) return reply({ ok: false, error: "conflict", currentVersion: r.currentVersion }, 409);
        return reply({ ok: true, version: r.version, entries: Object.keys(v.value.entries).length });
      }

      // Which periods are already stored, so the collector can backfill gaps
      // and refresh recent months. Dates and revision numbers only.
      if (M === "GET" && p === "/v1/ingest/coverage") {
        if (!can(role, "coverage")) return forbidden();
        const src = url.searchParams.get("source") || "shopify";
        const scope = url.searchParams.get("scope") || "total_sales_by_product";
        if (!SOURCE_PARAM.has(src) || !/^[a-z0-9_]{1,80}$/.test(scope)) return badParam();
        return reply({ ok: true, coverage: await store.coverage(env.DB, { source: src, scope }) });
      }

      // Sign-in attempt counters for the Netlify gateway (AUTH_SECRET only).
      if (M === "POST" && (p === "/v1/auth/attempt" || p === "/v1/auth/success")) {
        if (!can(role, "authAttempts")) return forbidden();
        const b = await readJson(req, 1024);
        const client = b && typeof b.client === "string" ? b.client : "";
        const windowSec = Number(b && b.windowSec);
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(client) || !Number.isInteger(windowSec) || windowSec < 60 || windowSec > 86400) return badParam();
        const fn = p === "/v1/auth/attempt" ? store.reserveAttempt : store.releaseAttempt;
        return reply(Object.assign({ ok: true }, await fn(env.DB, { client, windowSec, now: Date.now() })));
      }

      if (M === "GET" && p === "/v1/reports") {
        if (!can(role, "read")) return forbidden();
        const src = url.searchParams.get("source");
        if (src != null && !SOURCE_PARAM.has(src)) return badParam();
        return reply({ ok: true, reports: await store.listReports(env.DB, { source: src || null, history: url.searchParams.get("history") === "1" }) });
      }
      let m = /^\/v1\/reports\/([^/]+)\/rows$/.exec(p);
      if (M === "GET" && m) {
        if (!can(role, "read")) return forbidden();
        let id; try { id = decodeURIComponent(m[1]); } catch (e) { return badParam(); }
        if (!REPORT_ID.test(id)) return badParam();
        const r = await store.reportRows(env.DB, id, { offset: url.searchParams.get("offset"), limit: url.searchParams.get("limit") });
        if (!r) return reply({ ok: false, error: "not_found" }, 404);
        return reply({ ok: true, status: r.status, rows: r.rows });
      }
      if (M === "GET" && p === "/v1/imports") {
        if (!can(role, "read")) return forbidden();
        const src = url.searchParams.get("source");
        if (src != null && !SOURCE_PARAM.has(src)) return badParam();
        return reply({ ok: true, imports: await store.listRuns(env.DB, { source: src || null, limit: url.searchParams.get("limit") }) });
      }
      m = /^\/v1\/settings\/([a-z_]{1,40})$/.exec(p);
      if (m && store.SETTING_KEYS.has(m[1])) {
        if (M === "GET") {
          if (!can(role, "read")) return forbidden();
          return reply({ ok: true, setting: await store.getSetting(env.DB, m[1]) });
        }
        if (M === "PUT") {
          if (!can(role, "settingsWrite")) return forbidden();
          if (m[1] === "vendor_map") return reply({ ok: false, error: "use_vendor_map_route" }, 400);
          const body = await readJson(req, store.MAX_SETTING_BYTES + 4096);
          if (!body || typeof body !== "object" || !("value" in body)) return reply({ ok: false, error: "bad_body" }, 400);
          const problem = store.checkSettingValue(m[1], body.value);
          if (problem) return reply({ ok: false, error: "invalid_setting", message: problem }, 400);
          const by = role === "settings" ? "dashboard (editor)" : String(body.updatedBy || "dashboard").slice(0, 60);
          const r = await store.putSetting(env.DB, m[1], body.value, body.baseVersion, by);
          return reply(r, r.ok ? 200 : 409);
        }
      }
      return reply({ ok: false, error: "not_found" }, 404);
    } catch (e) {
      // Known request errors keep their short message; anything else is a bare
      // code, so no internal detail (SQL, stack, values) leaves the Worker.
      return reply({ ok: false, error: e.status ? (e.code || "bad_request") : "server_error", message: e.status ? e.message : undefined }, e.status || 500);
    }
  }
};
