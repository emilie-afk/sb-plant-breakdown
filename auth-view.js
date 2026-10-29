// ============================================================
// auth-view.js — sign-in, sign-out and the session boundary of the page.
//
// The page holds no key or password. Saved reports are reached only through
// the same-origin endpoints (/api/session, /api/v1/..., /api/stock-tracker),
// which check a server-signed, HttpOnly session cookie. This file:
//   - asks the server whether this browser is signed in (session restore);
//   - shows "Sign in with Google" when it is not (the server runs the OAuth
//     flow and checks the account against its allow-list; no password exists);
//   - keeps the per-session CSRF token in memory only and adds it to writes;
//   - is the ONLY way the page calls the API (SBAuth.fetchJson): every call
//     belongs to a session "epoch"; signing out or expiry aborts calls in
//     flight and discards any answer that still arrives, so nothing can
//     repopulate the page afterwards;
//   - sign-out is complete only when the SERVER confirms it revoked the
//     session. Until then the page stays locked (content hidden and cleared)
//     and offers a retry; it never claims to be signed out when it is not;
//   - on sign-out, failed sign-out or expiry, wipes everything that came from
//     shared storage: shared reports and period views, market and tracker
//     data, private settings (restricted items, market rules, vendor map,
//     shared classification corrections) and what was rendered from them.
//     Reports the person uploaded BY HAND in this browser are kept.
//   - enforces the session's expiry LOCALLY: at the known deadline the page
//     locks, aborts data requests and wipes shared data without waiting for
//     the server; after that only a new sign-in (or a reload with a valid
//     session) opens it again. "Session expired" and "server unavailable" are
//     separate states with separate messages;
//   - ignores any session-check answer that arrives after a sign-out, an
//     expiry or another session change (session epoch + check sequence);
//   - removes any Worker key an older version of the dashboard saved.
// ============================================================
(function () {
  "use strict";
  // Keys older versions stored in this browser; deleted on every load.
  var LEGACY_KEYS = ["sb-shared-store-v1", "sb-mcg-tracker-cache-v1", "sb-classification-overrides-shared-v1"];
  // Browser copies of SHARED data, removed at sign-out / expiry.
  var SHARED_KEYS = ["sb-classification-overrides-shared-v1", "sb-shared-settings-versions-v1"];
  var SHARED_SESSION_KEYS = ["sb-stock-tracker-cache-v1"];
  try { LEGACY_KEYS.forEach(function (k) { localStorage.removeItem(k); }); } catch (e) { /* storage blocked */ }

  // state: unknown | signed_out | signed_in | expired | signing_out | logout_failed | unavailable
  //   expired      the known session deadline passed (locked; sign in again)
  //   unavailable  no session confirmed because the server is down/unreachable
  var A = { state: "unknown", role: null, expiresAt: null, csrf: null, epoch: 0, listeners: [], wipers: [], inflight: [],
            serverDown: false, dirty: false };
  window.SBAuth = A;

  function emit() { A.listeners.forEach(function (f) { try { f(A); } catch (e) { console.warn(e); } }); }
  A.onChange = function (f) { A.listeners.push(f); };
  // Modules register how to forget what they hold from shared storage.
  A.onWipe = function (f) { A.wipers.push(f); };
  A.isSignedIn = function () { return A.state === "signed_in"; };
  A.isEditor = function () { return A.state === "signed_in" && A.role === "editor"; };
  A.headers = function (write) { return write && A.csrf ? { "x-sb-csrf": A.csrf } : {}; };
  A.reload = function () { location.reload(); };   // replaced in tests
  A.navigate = function (url) { location.assign(url); };   // replaced in tests
  // Outcome codes the server appends after a failed Google sign-in.
  var SIGNIN_MESSAGES = {
    denied: "This Google account is not allowed to open the dashboard. Ask the owner to add it, or choose another account.",
    cancelled: "Sign-in was cancelled.",
    expired: "The sign-in took too long or was started in another tab. Please try again.",
    failed: "Google sign-in could not be completed. Please try again.",
    too_many: "Too many sign-in attempts. Please wait 15 minutes and try again.",
    unavailable: "Sign-in is not available right now (server configuration)."
  };

  // ---- the only path to the API ----------------------------------------
  // -> {status, body}. Rejects when not signed in, when the session changed
  // while waiting, or on a network error.
  A.fetchJson = async function (url, init) {
    if (A.state === "signed_in" && deadlinePassed()) expireLocally();
    if (A.state !== "signed_in") throw new Error("Signed out.");
    var ep = A.epoch;
    var ac = new AbortController();
    A.inflight.push(ac);
    try {
      var res = await fetch(url, Object.assign({ credentials: "same-origin", cache: "no-store" }, init || {}, { signal: ac.signal }));
      var body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      if (ep !== A.epoch || A.state !== "signed_in") throw new Error("Signed out.");
      if (deadlinePassed()) { expireLocally(); throw new Error("Session expired."); }
      if (res.status === 401) { A.signedOut(); throw new Error("Signed out. Sign in again to load saved reports."); }
      return { status: res.status, body: body };
    } catch (e) {
      if (ep !== A.epoch) throw new Error("Signed out.");
      throw e;
    } finally {
      A.inflight = A.inflight.filter(function (x) { return x !== ac; });
    }
  };

  // ---- the session boundary ------------------------------------------
  function lock() { document.documentElement.classList.add("sb-locked"); }
  function unlock() { document.documentElement.classList.remove("sb-locked"); }
  // Forget everything that came from shared storage. Safe to run repeatedly.
  function wipe() {
    A.epoch++;
    A.dirty = true;     // rendered structure was emptied: a later sign-in reloads the page
    clearTimeout(expiryTimer);
    A.inflight.splice(0).forEach(function (ac) { try { ac.abort(); } catch (e) {} });
    A.wipers.forEach(function (f) { try { f(); } catch (e) { console.warn("wipe:", e); } });
    try { SHARED_KEYS.forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {}
    try { SHARED_SESSION_KEYS.forEach(function (k) { sessionStorage.removeItem(k); }); } catch (e) {}
    // What was rendered from shared data: emptied now (the page reloads, or
    // stays locked, afterwards). Static controls stay; tables, charts and
    // status text go.
    try {
      document.querySelectorAll(".tab-panel table, .tab-panel canvas, .tab-panel .cards, .tab-panel [id$='-cards'], " +
        ".tab-panel .banner, .tab-panel .period-bar, #sb-data-status, #di-root, #di-advanced").forEach(function (el) { el.replaceChildren(); });
    } catch (e) {}
    A.csrf = null;
  }
  A._wipe = wipe;

  function setSession(b) {
    A.epoch++;          // a session change: answers meant for the previous state are void
    if (b && b.authenticated) {
      A.state = "signed_in"; A.role = b.role; A.email = b.email || ""; A.expiresAt = b.expiresAt; A.csrf = b.csrf; A.serverDown = false; A.loginError = "";
      if (deadlinePassed()) { expireLocally(); return; }   // already past its deadline: never unlock
      unlock(); scheduleExpiry();
    } else { A.state = "signed_out"; A.role = null; A.expiresAt = null; A.csrf = null; }
    render(); emit();
  }
  function deadlinePassed() {
    var t = A.expiresAt ? new Date(A.expiresAt).getTime() : NaN;
    return isFinite(t) && Date.now() >= t;
  }
  // The session's own deadline passed: enforced here, with no server answer
  // needed. Lock, abort requests in flight, wipe shared data.
  function expireLocally() {
    if (A.state === "expired") return;
    lock(); wipe();
    A.state = "expired"; A.role = null; A.csrf = null;
    render(); emit();
    A.check();          // only to learn whether the server is reachable (message); it can never unlock
  }
  A._expireLocally = expireLocally;
  // The server said this browser is not signed in (401, expiry). Anything
  // shown came from a session that is over: lock, wipe, start clean.
  A.signedOut = function () {
    if (A.state === "signed_out") return;
    var was = A.state;
    lock(); wipe();
    A.state = "signed_out"; A.role = null; A.expiresAt = null;
    render(); emit();
    if (was === "signed_in" || was === "signing_out") A.reload();
  };

  var expiryTimer = null;
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    var t = A.expiresAt ? new Date(A.expiresAt).getTime() - Date.now() : NaN;
    if (!isFinite(t)) return;
    // fires AT the deadline (long waits are chained: timers cap near 24.8 days)
    expiryTimer = setTimeout(function () {
      if (A.state !== "signed_in") return;
      if (deadlinePassed()) expireLocally(); else scheduleExpiry();
    }, Math.max(0, Math.min(t, 2147000000)));
  }
  // A sleeping laptop or a throttled tab can fire timers late: re-check the
  // deadline whenever the page becomes visible or focused again.
  function deadlineGuard() { if (A.state === "signed_in" && deadlinePassed()) expireLocally(); }
  A._deadlineGuard = deadlineGuard;

  // Session check. Its answer is applied only if nothing changed meanwhile
  // (no sign-out, expiry, sign-in or newer check), and it can unlock the page
  // only from the start-up / signed-out states, never after an expiry or
  // during / after a sign-out.
  var checkSeq = 0;
  A.check = async function () {
    var seq = ++checkSeq, ep = A.epoch, from = A.state;
    var stale = function () { return seq !== checkSeq || ep !== A.epoch || A.state !== from; };
    var r, b;
    try {
      r = await fetch("/api/session", { credentials: "same-origin", headers: { accept: "application/json" }, cache: "no-store" });
      b = await r.json().catch(function () { return {}; });
    } catch (e) { r = null; }
    if (stale()) return;
    var down = !r || r.status === 503 || r.status >= 500;
    if (from === "expired") {              // stays locked whatever the answer; only the message changes
      A.serverDown = down; render(); emit(); return;
    }
    if (from === "logout_failed" || from === "signing_out") return;   // only a reload restores
    if (down) {
      if (from === "signed_in") return;    // keep working until the deadline; API calls decide
      A.state = "unavailable"; A.serverDown = true;
      A.error = r && r.status === 503 ? "Sign-in is not available right now (server configuration)." : "The server could not be reached. Try again shortly.";
      render(); emit(); return;
    }
    if (b && b.authenticated) {
      if (from === "signed_in") { A.expiresAt = b.expiresAt; scheduleExpiry(); render(); return; }
      setSession(b);
    } else if (from === "signed_in") A.signedOut();
    else setSession(null);
  };

  // Sign-in is a full-page trip to Google and back (server-side OAuth); the
  // new page then finds its session with A.check(). Any locked state —
  // signed out, expired, server unavailable, failed sign-out — can start it.
  A.startSignIn = function () {
    if (A.state === "signing_out") return;
    lock();
    A.navigate("/api/auth/google/start");
  };
  // ?signin=<code> after a failed Google sign-in: show it once, then drop it
  // from the address bar.
  A.readSignInOutcome = function (search) {
    var m = /[?&]signin=([a-z_]{1,20})/.exec(search || "");
    if (!m) return null;
    A.loginError = SIGNIN_MESSAGES[m[1]] || SIGNIN_MESSAGES.failed;
    try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
    return m[1];
  };

  // Sign-out completes only when the server confirms the session is revoked
  // (200). Shared data is wiped and the page locked BEFORE the request, so
  // nothing stays visible whatever the outcome.
  A.logout = async function () {
    var csrf = A.csrf;
    lock();
    A.state = "signing_out"; render(); emit();
    wipe();
    var confirmed = false;
    try {
      var r = await fetch("/api/session", { method: "DELETE", credentials: "same-origin", cache: "no-store",
        headers: Object.assign({ accept: "application/json" }, csrf ? { "x-sb-csrf": csrf } : {}) });
      var b = await r.json().catch(function () { return null; });
      confirmed = r.status === 200 && !!b && b.authenticated === false;
    } catch (e) { confirmed = false; }
    if (confirmed) {
      A.state = "signed_out"; A.role = null; A.expiresAt = null; A.logoutError = "";
      render(); emit();
      A.reload();
      return true;
    }
    // Not confirmed: the server session may still be valid. Stay locked and
    // say so; the person can retry. (A reload would restore the session.)
    A.state = "logout_failed";
    A.logoutError = "Sign-out did not complete: the server did not confirm it, so your session may still be active. " +
                    "The dashboard is hidden. Retry sign-out, or close this browser window.";
    A.csrf = csrf;   // kept in memory only, for the retry
    render(); emit();
    return false;
  };

  // ---- overlay ---------------------------------------------------------
  function el(id) { return document.getElementById(id); }
  function render() {
    var ov = el("sb-login");
    if (!ov) return;
    var show = A.state !== "signed_in" && A.state !== "unknown";
    ov.style.display = show ? "flex" : "none";
    var form = el("sb-login-form"), out = el("sb-logout-panel");
    var outPanel = A.state === "logout_failed" || A.state === "signing_out";
    if (form) form.style.display = outPanel ? "none" : "";
    if (out) out.style.display = outPanel ? "" : "none";
    var omsg = el("sb-logout-msg");
    if (omsg) omsg.textContent = A.state === "signing_out" ? "Signing out…" : (A.logoutError || "");
    var retry = el("sb-logout-retry");
    if (retry) retry.style.display = A.state === "logout_failed" ? "" : "none";
    var msg = el("sb-login-msg");
    if (msg) msg.textContent = A.loginError ? A.loginError
      : A.state === "expired" ? "Your session expired. Sign in again." + (A.serverDown ? " (The server is not reachable right now; sign-in will work once it is back.)" : "")
      : A.state === "unavailable" ? (A.error || "The server is not available.") : "";
    var ov2 = el("sb-login");
    if (ov2 && ov2.setAttribute) ov2.setAttribute("data-state", A.state);
    var who = el("sb-session-who");
    if (who) {
      who.textContent = A.isSignedIn() ? (A.role === "editor" ? "Editor" : "Viewer") : "";
      who.title = A.isSignedIn() ? (A.email || "") + (A.expiresAt ? " · session ends " + new Date(A.expiresAt).toLocaleString() : "") : "";
    }
    var lo = el("sb-logout");
    if (lo) lo.style.display = A.isSignedIn() ? "" : "none";
  }
  A._render = render;

  // Until the server confirms a session, nothing behind the overlay shows
  // (index.html also starts with the class set).
  lock();
  document.addEventListener("DOMContentLoaded", function () {
    try { A.readSignInOutcome(location.search); } catch (e) {}
    var go = el("sb-login-submit");
    if (go) go.addEventListener("click", function () { A.startSignIn(); });
    var lo = el("sb-logout");
    if (lo) lo.addEventListener("click", function () { A.logout(); });
    var retry = el("sb-logout-retry");
    if (retry) retry.addEventListener("click", function () { A.logout(); });
    render();
    A.check();
  });
  document.addEventListener("visibilitychange", deadlineGuard);
  window.addEventListener("focus", deadlineGuard);
})();
