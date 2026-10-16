// ============================================================
// sb-plant-breakdown Worker — shared report store
//
// Routes
//   GET  /v1/health                         no auth
//   POST /v1/ingest/product-report          INGEST_SECRET (collector) or DASHBOARD_SECRET (manual upload)
//   POST /v1/ingest/collection-failure      INGEST_SECRET  {source, reportScope, period, errorCode, message}
//   GET  /v1/ingest/coverage?source=&scope= INGEST_SECRET  stored periods only (dates, revisions), no rows
//   GET  /v1/reports?source=shopify         DASHBOARD_SECRET or VIEWER_SECRET   (&history=1: every revision)
//   GET  /v1/reports/:id/rows               DASHBOARD_SECRET or VIEWER_SECRET
//   GET  /v1/imports?source=&limit=         DASHBOARD_SECRET or VIEWER_SECRET
//   GET  /v1/settings/:key                  DASHBOARD_SECRET or VIEWER_SECRET
//   PUT  /v1/settings/:key                  DASHBOARD_SECRET  {value, baseVersion}
//
// Secrets, set as Cloudflare secrets, never in code or wrangler.toml:
//   INGEST_SECRET     held by the Windows collector. Can only ADD reports and
//                     record a failed collection.
//   DASHBOARD_SECRET  reads, shared settings, and manual uploads.
//   VIEWER_SECRET     optional, READ-ONLY. Meant to be built into the
//                     password-protected dashboard so a browser can load the
//                     saved reports without anyone typing a key.
//
// Product sales reports only. The ingest route refuses any payload carrying a
// customer-looking field, and no route stores or returns customer data.
// ============================================================
import { validateProductReport, contentHash } from "./validate.js";
import * as store from "./store.js";

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
// Returns the role a request is authorised for, or null.
function roleOf(req, env) {
  const t = bearer(req);
  if (env.DASHBOARD_SECRET && safeEqual(t, env.DASHBOARD_SECRET)) return "dashboard";
  if (env.INGEST_SECRET && safeEqual(t, env.INGEST_SECRET)) return "collector";
  if (env.VIEWER_SECRET && safeEqual(t, env.VIEWER_SECRET)) return "viewer";
  return null;
}

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

async function readJson(req) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) throw Object.assign(new Error("Body too large."), { status: 413, code: "body_too_large" });
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error("Body too large."), { status: 413, code: "body_too_large" });
  try { return JSON.parse(text); }
  catch (e) { throw Object.assign(new Error("Body is not valid JSON."), { status: 400, code: "bad_json" }); }
}

async function ingest(req, env, role) {
  let payload;
  try { payload = await readJson(req); }
  catch (e) { return json({ ok: false, error: e.code, message: e.message }, e.status || 400); }

  // A manual upload from the dashboard is always recorded as manual, and a
  // collector upload as collector, whatever the payload claims.
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
    source: b.source === "amazon" ? "amazon" : "shopify", reportScope: typeof b.reportScope === "string" ? b.reportScope.slice(0, 80) : null,
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

    try {
      if (req.method === "POST" && url.pathname === "/v1/ingest/product-report") {
        if (role === "viewer") return reply({ ok: false, error: "forbidden" }, 403);
        const res = await ingest(req, env, role);
        Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
        return res;
      }

      // The collector reports a run that failed BEFORE it had a file to upload
      // (Shopify sign-in needed, export page failed, file refused by its own
      // checks), so the dashboard can say so. Nothing else is written.
      if (req.method === "POST" && url.pathname === "/v1/ingest/collection-failure") {
        if (role !== "collector") return reply({ ok: false, error: "forbidden" }, 403);
        return reply(await recordCollectionFailure(req, env));
      }

      // Which periods are already stored, so the collector can backfill gaps
      // and refresh recent months. Dates and revision numbers only.
      if (req.method === "GET" && url.pathname === "/v1/ingest/coverage") {
        if (role !== "collector" && role !== "dashboard") return reply({ ok: false, error: "forbidden" }, 403);
        return reply({ ok: true, coverage: await store.coverage(env.DB, {
          source: url.searchParams.get("source") || "shopify",
          scope: url.searchParams.get("scope") || "total_sales_by_product"
        }) });
      }

      // Everything below reads data, or (PUT settings) is dashboard-only. The
      // collector key can add reports and nothing else.
      if (role === "collector") return reply({ ok: false, error: "forbidden" }, 403);
      const readOnly = req.method === "GET";
      if (!readOnly && role !== "dashboard") return reply({ ok: false, error: "forbidden" }, 403);

      if (req.method === "GET" && url.pathname === "/v1/reports") {
        return reply({ ok: true, reports: await store.listReports(env.DB, {
          source: url.searchParams.get("source") || null, history: url.searchParams.get("history") === "1"
        }) });
      }
      let m = /^\/v1\/reports\/([^/]+)\/rows$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const r = await store.reportRows(env.DB, decodeURIComponent(m[1]), {
          offset: url.searchParams.get("offset"), limit: url.searchParams.get("limit")
        });
        if (!r) return reply({ ok: false, error: "not_found" }, 404);
        return reply({ ok: true, status: r.status, rows: r.rows });
      }
      if (req.method === "GET" && url.pathname === "/v1/imports") {
        return reply({ ok: true, imports: await store.listRuns(env.DB, {
          source: url.searchParams.get("source") || null, limit: url.searchParams.get("limit")
        }) });
      }
      m = /^\/v1\/settings\/([a-z_]+)$/.exec(url.pathname);
      if (m && store.SETTING_KEYS.has(m[1])) {
        if (req.method === "GET") {
          return reply({ ok: true, setting: await store.getSetting(env.DB, m[1]) });
        }
        if (req.method === "PUT") {
          const body = await readJson(req);
          if (!body || typeof body !== "object" || !("value" in body)) return reply({ ok: false, error: "bad_body" }, 400);
          const r = await store.putSetting(env.DB, m[1], body.value, body.baseVersion, body.updatedBy || "dashboard");
          return reply(r, r.ok ? 200 : 409);
        }
      }
      return reply({ ok: false, error: "not_found" }, 404);
    } catch (e) {
      return reply({ ok: false, error: e.code || "server_error", message: e.status ? e.message : undefined }, e.status || 500);
    }
  }
};
