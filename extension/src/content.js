'use strict';
// ============================================================
// cswap content script
// ============================================================
//
// Runs in the isolated world of every claude.ai tab and tells the service
// worker what the page looks like (its path, its title, whether a
// Cloudflare check is showing, whether the import or the export script's
// buttons are there, whether the browser is online). It sends that when it
// connects, when the page is shown or its history changes, and whenever the
// title or a marker element changes, debounced; and it answers probe.dom
// with the same shape. It changes nothing on the page and reads no sign-in.
// The one request it ever makes is the site's own sign-out (sign.out),
// when the person presses Sign out and reload in the side panel: a POST to
// claude.ai's sign-out endpoint with no body, after which the worker sends
// the tab to the sign-in page for the person to sign in as the other
// account. Nothing of the answer but its status leaves the page.
//
// Classic script, plain ASCII, no imports: the constants it shares with
// protocol.js are copied here and a test holds the copies equal.

function createContent(env) {
  var PORT_NAME = 'cswap-content';
  var SIGN_OUT_PATH = '/api/auth/logout';
  var IMPORTER_ID = 'claude-simple-importer';
  var EXPORTER_ID = 'claude-simple-exporter';
  var RECONNECT_BACKOFF_MS = [0, 1000, 2000, 5000, 5000];
  var PAGE_MARKER_SELECTORS = ['#challenge-form', '#challenge-running', '#cf-challenge-running', '.cf-turnstile',
    'iframe[src*="challenges.cloudflare.com"]',
    'script[src*="challenges.cloudflare.com/turnstile"]',
    'script[src*="/cdn-cgi/challenge-platform/"]'];
  // Of those, the ones a signed-in claude.ai page may carry while no check
  // is showing: Cloudflare's own detection loader, which bot management
  // puts on ordinary pages, and a Turnstile widget the app embeds. They
  // are reported apart, as hints, so the worker never stops on them; what
  // stops it is the interstitial's own form and title. (A real-tab check
  // on a signed-in page is what settles this list.)
  var PAGE_HINT_SELECTORS = ['.cf-turnstile',
    'iframe[src*="challenges.cloudflare.com"]',
    'script[src*="challenges.cloudflare.com/turnstile"]',
    'script[src*="/cdn-cgi/challenge-platform/"]'];
  var DEBOUNCE_MS = 500;

  var win = env.win;
  var doc = env.doc;
  if (!win || !doc) throw new Error('cswap content script: no window or document');
  if (typeof env.connect !== 'function') throw new Error('cswap content script: nothing to connect with');
  var schedule = typeof env.schedule === 'function' ? env.schedule : win.setTimeout;
  var Observer = env.MutationObserver;
  var fetchImpl = typeof env.fetchImpl === 'function' ? env.fetchImpl : null;

  var port = null;
  var alive = false;
  var reconnects = 0;
  var timer = null;
  var lastSent = '';
  var sent = 0;

  function isHint(selector) {
    for (var i = 0; i < PAGE_HINT_SELECTORS.length; i++) if (PAGE_HINT_SELECTORS[i] === selector) return true;
    return false;
  }

  // The selectors present on the page, split into the markers of a check
  // and the hints a normal page may carry.
  function markers() {
    var found = { markers: [], hints: [] };
    for (var i = 0; i < PAGE_MARKER_SELECTORS.length; i++) {
      var selector = PAGE_MARKER_SELECTORS[i];
      var hit = null;
      try { hit = doc.querySelector(selector); } catch (e) { hit = null; }
      if (!hit) continue;
      if (isHint(selector)) found.hints.push(selector);
      else found.markers.push(selector);
    }
    return found;
  }

  // The URL is sent without its query or fragment: a sign-in link carries
  // its secret there, and the worker only looks at the path anyway.
  function pageUrl() {
    var loc = win.location;
    if (!loc) return '';
    var origin = loc.origin || '';
    var path = loc.pathname || '/';
    return origin + path;
  }

  function probe() {
    var hasImporter = false;
    var hasExporter = false;
    try { hasImporter = !!doc.getElementById(IMPORTER_ID); } catch (e) { hasImporter = false; }
    try { hasExporter = !!doc.getElementById(EXPORTER_ID); } catch (e) { hasExporter = false; }
    var seen = markers();
    return {
      url: pageUrl(),
      title: String(doc.title || '').slice(0, 200),
      markers: seen.markers,
      hints: seen.hints,
      hasImporter: hasImporter,
      hasExporter: hasExporter,
      online: !(win.navigator && win.navigator.onLine === false),
    };
  }

  function send(msg) {
    if (!port || !alive) return false;
    try { port.postMessage(msg); sent++; return true; } catch (e) { return false; }
  }

  function report(force) {
    var p = probe();
    var key = JSON.stringify(p);
    if (!force && key === lastSent) return false;
    lastSent = key;
    return send(Object.assign({ type: 'page.state' }, p));
  }

  function later() {
    if (timer) return;
    timer = schedule(function () {
      timer = null;
      try { report(false); } catch (e) { /* never in the page's way */ }
    }, DEBOUNCE_MS);
  }

  // The site's own sign-out, asked for by the person: one POST, made by
  // this tab in its signed-in profile, answered with its status alone.
  function signOut(id) {
    if (!fetchImpl) { send({ re: id, kind: 'signout', ok: false, status: 0, error: 'no fetch' }); return; }
    var done = false;
    var answer = function (ok, status, error) {
      if (done) return;
      done = true;
      var reply = { re: id, kind: 'signout', ok: ok, status: status };
      if (error) reply.error = String(error).slice(0, 200);
      send(reply);
    };
    try {
      fetchImpl(SIGN_OUT_PATH, { method: 'POST', credentials: 'include', headers: { Accept: 'application/json' } })
        .then(function (r) { answer(!!r.ok, r.status, null); }, function (e) { answer(false, 0, e && e.message ? e.message : e); });
    } catch (e) { answer(false, 0, e && e.message ? e.message : e); }
  }

  function onMessage(m) {
    try {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'probe.dom') send(Object.assign({ re: m.id, ok: true }, probe()));
      else if (m.type === 'sign.out') signOut(m.id);
    } catch (e) { /* nothing */ }
  }

  function connect() {
    var p;
    try { p = env.connect(); } catch (e) { p = null; }
    if (!p || !p.onMessage || !p.onDisconnect) { reconnectLater(); return; }
    port = p;
    alive = true;
    reconnects = 0;
    p.onMessage.addListener(onMessage);
    p.onDisconnect.addListener(function () {
      if (port !== p) return;
      alive = false;
      port = null;
      reconnectLater();
    });
    lastSent = '';
    report(true);
  }

  function reconnectLater() {
    var wait = RECONNECT_BACKOFF_MS[Math.min(reconnects, RECONNECT_BACKOFF_MS.length - 1)];
    reconnects++;
    schedule(connect, wait);
  }

  function listen() {
    var events = ['pageshow', 'popstate', 'hashchange'];
    for (var i = 0; i < events.length; i++) {
      try { win.addEventListener(events[i], later); } catch (e) { /* nothing */ }
    }
    if (typeof Observer !== 'function') return;
    try {
      var observer = new Observer(later);
      observer.observe(doc.documentElement || doc, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'id', 'class'],
      });
    } catch (e) { /* no observer: the events above still report */ }
  }

  listen();
  connect();

  return {
    probe: probe,
    report: report,
    connected: function () { return alive; },
    sent: function () { return sent; },
  };
}

if (typeof chrome !== 'undefined' && chrome && chrome.runtime && typeof chrome.runtime.connect === 'function' &&
    typeof document !== 'undefined' && typeof window !== 'undefined') {
  createContent({
    win: window,
    doc: document,
    connect: function () { return chrome.runtime.connect({ name: 'cswap-content' }); },
    schedule: setTimeout.bind(globalThis),
    MutationObserver: typeof MutationObserver === 'function' ? MutationObserver : null,
    // Taken now, before any job's page.js puts its gated fetch in this same
    // world: the sign-out is the person's own request and never waits on
    // the gate of a job that has ended.
    fetchImpl: typeof fetch === 'function' ? fetch.bind(globalThis) : null,
  });
}
