'use strict';
// ============================================================
// cswap page helper
// ============================================================
//
// Injected by the extension's service worker into the user-script world of
// the claude.ai tab, just before the unchanged project-import.js. It stands
// in for the three things in that script that wait for a person, and puts
// a gate in front of the script's requests:
//
//   * showDirectoryPicker() hands back a folder that holds the export's
//     listing and fetches a file's bytes from cswap only when the script
//     asks for them (nothing is copied into the page up front);
//   * prompt() answers the script's questions: the project name the CLI
//     gave or the script's own suggestion, and the organization the script
//     itself worked out;
//   * the button is pressed once, when the worker says so;
//   * fetch() asks the worker for a permit before every request to /api/
//     or /v1/, performs the request itself, reports what came back, and
//     holds a request the worker wants held until the person decides.
//
// The request is always the page's own, in the signed-in profile: nothing
// here adds or removes a header, reads the sign-in, retries on its own, or
// changes the script.
//
// Classic script, plain ASCII, no imports: the constants it shares with
// protocol.js are copied here and a test holds the copies equal.

function createPageHelper(env) {
  // ---------------------------------------------------------- constants (copies of protocol.js)

  var PORT_NAME = 'cswap-page';
  var CLAUDE_ORIGIN = 'https://claude.ai';
  var IMPORTER_ID = 'claude-simple-importer';
  var RECONNECT_BACKOFF_MS = [0, 1000, 2000, 5000, 5000];
  var HEADER_ALLOWLIST = ['retry-after', 'content-type', 'content-length', 'cf-mitigated', 'cf-ray',
    'server', 'server-timing', 'location', 'date'];
  var BODY_MARKERS = ['cf-chl-', '__cf_chl', 'cf_chl_opt', 'challenge-platform',
    '/cdn-cgi/challenge-platform/', 'challenges.cloudflare.com', 'cf-turnstile',
    'turnstile', '<title>just a moment', 'checking your browser',
    'verify you are human', 'attention required! | cloudflare',
    'error code: 1020', 'sorry, you have been blocked', 'access denied',
    'error code: 1015', 'you are being rate limited'];
  var ACCOUNT_ENDPOINTS = ['/api/account', '/api/auth/current_account'];
  var ORGS_ENDPOINT = '/api/organizations';
  var CREATE_PATH_RES = [/^\/api\/organizations\/[^/]+\/projects$/, /^\/v1\/code\/channels$/];

  var BODY_LIMIT = 65536; // bytes of an error body looked at for markers
  var EXCERPT_CHARS = 200;
  var STATUS_THROTTLE_MS = 250;
  var DEFAULT_TIMEOUT_MS = 120000;
  var MS_PER_MIB = 4000;
  var VERSION = 1;

  // ---------------------------------------------------------- checks on what we were given

  var globals = env.globals;
  var win = env.win || globals;
  var doc = env.doc;
  var boot = env.boot;

  if (!globals || !doc) throw new Error('cswap page helper: no window or document to install on');
  if (globals.__cswapImport) return globals.__cswapImport; // once per injection
  if (!boot || typeof boot !== 'object') throw new Error('cswap page helper: no boot object');
  if (typeof boot.jobId !== 'string' || !boot.jobId) throw new Error('cswap page helper: the boot object names no job');
  if (typeof boot.nonce !== 'string' || !boot.nonce) throw new Error('cswap page helper: the boot object carries no nonce');
  if (typeof env.connect !== 'function') throw new Error('cswap page helper: nothing to connect with');
  if (typeof env.fetchImpl !== 'function') throw new Error('cswap page helper: no fetch to wrap');

  var now = typeof env.now === 'function' ? env.now : Date.now;
  var schedule = typeof env.schedule === 'function' ? env.schedule : globals.setTimeout;
  var unschedule = typeof env.unschedule === 'function' ? env.unschedule : globals.clearTimeout;
  var Observer = env.MutationObserver;
  var jobId = boot.jobId;
  var nonce = boot.nonce;
  var wantedName = typeof boot.name === 'string' ? boot.name.trim() : '';
  var bodyMarkers = Array.isArray(boot.bodyMarkers) && boot.bodyMarkers.length ? boot.bodyMarkers : BODY_MARKERS;
  var accountEndpoints = Array.isArray(boot.accountEndpoints) && boot.accountEndpoints.length
    ? boot.accountEndpoints : ACCOUNT_ENDPOINTS;
  var timeoutBase = Number(boot.requestTimeoutMs) > 0 ? Number(boot.requestTimeoutMs) : DEFAULT_TIMEOUT_MS;
  var origin = win.location && win.location.origin ? win.location.origin : CLAUDE_ORIGIN;
  var base = win.location && win.location.href ? win.location.href : CLAUDE_ORIGIN + '/';

  // ---------------------------------------------------------- small helpers

  function domError(name, message) {
    var E = globals.DOMException;
    if (typeof E === 'function') {
      try { return new E(message, name); } catch (e) { /* fall through */ }
    }
    var err = new Error(message);
    err.name = name;
    return err;
  }

  function checkName(name) {
    if (name === '' || name === '.' || name === '..' || /[\/\\]/.test(String(name))) {
      throw new TypeError('Name is not allowed.');
    }
  }

  function clip(text, max) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) : s;
  }

  function show(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof value.message === 'string') {
      return (value.name || 'Error') + ': ' + value.message;
    }
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }

  function pathOnly(url) {
    if (url == null || url === '') return '';
    try { return new URL(String(url), base).pathname; } catch (e) { return ''; }
  }

  // FNV-1a over the code units of a JSON body: the same body gives the same
  // step key, so repeated attempts of one request are counted together.
  function fnv1a32(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function fromBase64(text) {
    var raw = globals.atob(text);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function mimeFor(name) {
    var dot = String(name).lastIndexOf('.');
    var ext = dot > 0 ? String(name).slice(dot).toLowerCase() : '';
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.pdf') return 'application/pdf';
    return '';
  }

  // The string rules of log.js, for the little text this file emits (an
  // error body's excerpt, a console line, a question). Keys are not an
  // issue here: nothing structured is forwarded but what we build.
  var SECRET_RES = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
    [/sk-ant-[A-Za-z0-9_\-]{8,}/g, '[redacted]'],
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[redacted]'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]'],
    [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
    [/(\bBearer\s+)[A-Za-z0-9._~+\/\-]{16,}=*/gi, '$1[redacted]'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]'],
    [/\b(sessionKey|session_key|cf_clearance|__cf_bm|__Secure-[\w-]+|__Host-[\w-]+|csrftoken|intercom-session-[\w-]+)=[^;&\s]+/gi, '$1=[redacted]'],
    [/\b([A-Z0-9_]*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*[=:]\s*)(?!\[redacted)(['"]?)[^\s'"]{4,}\2/gi, '$1[redacted]'],
  ];
  var SECRET_QUERY = /([?&](?:token|key|api_key|apikey|session|sessionKey|code|state|auth|access_token|refresh_token)=)[^&#\s]*/gi;

  function redactText(text) {
    var out = String(text == null ? '' : text);
    for (var i = 0; i < SECRET_RES.length; i++) out = out.replace(SECRET_RES[i][0], SECRET_RES[i][1]);
    return out.replace(SECRET_QUERY, '$1[redacted]');
  }

  function pickHeaders(headers) {
    var out = {};
    if (!headers || typeof headers.get !== 'function') return out;
    for (var i = 0; i < HEADER_ALLOWLIST.length; i++) {
      var name = HEADER_ALLOWLIST[i];
      var value = null;
      try { value = headers.get(name); } catch (e) { value = null; }
      if (value == null || value === '') continue;
      out[name] = name === 'location' ? pathOnly(value) : clip(value, 200);
    }
    return out;
  }

  function scanBody(text) {
    var low = String(text == null ? '' : text).toLowerCase();
    var found = [];
    for (var i = 0; i < bodyMarkers.length; i++) {
      if (low.indexOf(bodyMarkers[i]) >= 0) found.push(bodyMarkers[i]);
    }
    return found;
  }

  function unwrap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    var keys = Object.keys(value);
    if (keys.length !== 1) return value;
    var inner = value[keys[0]];
    return inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : value;
  }

  function emailOf(body) {
    var candidates = [
      body && body.email_address,
      body && body.email,
      body && body.account && body.account.email_address,
      body && body.account && body.account.email,
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (typeof candidates[i] === 'string' && candidates[i].trim()) return candidates[i].trim();
    }
    return null;
  }

  // Up to `limit` bytes of a response body as text, never throwing.
  function readUpTo(response, limit) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (text) { if (!done) { done = true; resolve(String(text || '').slice(0, limit)); } };
      try {
        var body = response.body;
        if (body && typeof body.getReader === 'function') {
          var reader = body.getReader();
          var decoder = new TextDecoder();
          var got = 0;
          var out = '';
          var step = function () {
            reader.read().then(function (r) {
              if (r.done || got >= limit) {
                try { reader.cancel(); } catch (e) { /* nothing */ }
                finish(out);
                return;
              }
              got += r.value.byteLength;
              out += decoder.decode(r.value, { stream: true });
              step();
            }, function () { finish(out); });
          };
          step();
          return;
        }
        response.text().then(finish, function () { finish(''); });
      } catch (e) {
        finish('');
      }
    });
  }

  // ---------------------------------------------------------- the port to the worker

  // Requests are {id, type, ...}; replies {re, ok, ...}; a stream answers
  // with several {re, part, last}. Whatever is unanswered when the port
  // drops is sent again, with the same id, after the next attach: the
  // worker's handlers are idempotent.
  var port = null;
  var alive = false;
  var detached = false; // the worker said this page is not its page
  var reconnects = 0;
  var nextId = 1;
  var pending = new Map(); // id -> { msg, resolve, onPart }
  var pushHandlers = {};
  var counters = { requests: 0, prompts: 0, pickerCalls: 0, reconnects: 0, fileReads: 0, consoleLines: 0, probes: 0 };
  var lastAttach = null;

  function post(msg) {
    if (!port || !alive) return false;
    try { port.postMessage(msg); return true; } catch (e) { return false; }
  }

  function request(msg, onPart) {
    return new Promise(function (resolve, reject) {
      if (detached) { reject(detachedError()); return; }
      var id = nextId++;
      var entry = { msg: Object.assign({ id: id }, msg), resolve: resolve, reject: reject, onPart: onPart };
      pending.set(id, entry);
      if (alive && lastAttach) post(entry.msg);
    });
  }

  function push(type, body) {
    return request(Object.assign({ type: type }, body)).catch(function () { return null; });
  }

  function detachedError() {
    return domError('AbortError', 'cswap: this page is no longer attached to the import');
  }

  function onMessage(m) {
    try {
      if (!m || typeof m !== 'object') return;
      if (m.re !== undefined) {
        var entry = pending.get(m.re);
        if (!entry) return;
        if (m.part !== undefined || m.last !== undefined) {
          if (entry.onPart) entry.onPart(m);
          if (m.last || m.ok === false) { pending.delete(m.re); entry.resolve(m); }
          return;
        }
        pending.delete(m.re);
        entry.resolve(m);
        return;
      }
      if (typeof m.type === 'string' && pushHandlers[m.type]) pushHandlers[m.type](m);
    } catch (e) {
      // A handler must never take the port down with it.
    }
  }

  function connect() {
    if (detached) return;
    var p;
    try { p = env.connect(); } catch (e) { p = null; }
    if (!p || !p.onMessage || !p.onDisconnect) { reconnectLater(); return; }
    port = p;
    alive = true;
    p.onMessage.addListener(onMessage);
    p.onDisconnect.addListener(function () {
      if (port !== p) return;
      alive = false;
      port = null;
      lastAttach = null;
      reconnectLater();
    });
    attach();
  }

  function reconnectLater() {
    if (detached) return;
    var wait = RECONNECT_BACKOFF_MS[Math.min(reconnects, RECONNECT_BACKOFF_MS.length - 1)];
    reconnects++;
    counters.reconnects++;
    schedule(connect, wait);
  }

  // The first message on every (re)connect. The worker answers with its
  // phase, or says this page is not the job's page, after which nothing
  // more is sent and every gated request is refused.
  function attach() {
    var ids = [];
    pending.forEach(function (entry, id) { ids.push(id); });
    var id = nextId++;
    var msg = { id: id, type: 'page.attach', jobId: jobId, nonce: nonce, pending: ids, state: observation() };
    var p = port;
    pending.set(id, { msg: msg, onPart: null, resolve: function (reply) {
      if (port !== p) return;
      if (!reply || reply.ok === false) {
        detach(reply && reply.reason ? reply.reason : 'refused');
        return;
      }
      reconnects = 0;
      lastAttach = reply;
      if (reply.cancelled) cancelAll();
      pending.forEach(function (entry) { post(entry.msg); });
    }, reject: function () {} });
    post(msg);
  }

  function detach(reason) {
    detached = true;
    alive = false;
    var err = detachedError();
    pending.forEach(function (entry) { entry.reject(err); });
    pending.clear();
    var p = port;
    port = null;
    if (p) { try { p.disconnect(); } catch (e) { /* nothing */ } }
    state.detachedBecause = reason;
  }

  // ---------------------------------------------------------- the lazy folder

  // A folder like the one the picker hands out, built from the listing the
  // worker sends. A file's bytes are fetched when the script asks for them,
  // one file at a time, and not kept.
  var folder = null;
  var readChain = Promise.resolve();

  function LazyDir(name) {
    this.kind = 'directory';
    this.name = name;
    this.dirs = new Map();
    this.files = new Map(); // name -> path in the export
  }

  LazyDir.prototype.getDirectoryHandle = function (name) {
    var self = this;
    return new Promise(function (resolve) {
      checkName(name);
      if (self.dirs.has(name)) { resolve(self.dirs.get(name)); return; }
      if (self.files.has(name)) throw domError('TypeMismatchError', '"' + name + '" is a file, not a folder.');
      throw domError('NotFoundError', 'There is no "' + name + '" in the export.');
    });
  };

  LazyDir.prototype.getFileHandle = function (name) {
    var self = this;
    return new Promise(function (resolve) {
      checkName(name);
      if (self.files.has(name)) { resolve(fileHandle(name, self.files.get(name))); return; }
      if (self.dirs.has(name)) throw domError('TypeMismatchError', '"' + name + '" is a folder, not a file.');
      throw domError('NotFoundError', 'There is no "' + name + '" in the export.');
    });
  };

  LazyDir.prototype.values = function () {
    var self = this;
    var items = [];
    self.dirs.forEach(function (d) { items.push(d); });
    self.files.forEach(function (path, name) { items.push(fileHandle(name, path)); });
    var i = 0;
    var it = {};
    it.next = function () { return Promise.resolve(i < items.length ? { value: items[i++], done: false } : { value: undefined, done: true }); };
    it[Symbol.asyncIterator] = function () { return it; };
    return it;
  };

  LazyDir.prototype.entries = function () {
    var inner = this.values();
    var it = {};
    it.next = function () {
      return inner.next().then(function (r) { return r.done ? r : { value: [r.value.name, r.value], done: false }; });
    };
    it[Symbol.asyncIterator] = function () { return it; };
    return it;
  };

  LazyDir.prototype.keys = function () {
    var inner = this.values();
    var it = {};
    it.next = function () {
      return inner.next().then(function (r) { return r.done ? r : { value: r.value.name, done: false }; });
    };
    it[Symbol.asyncIterator] = function () { return it; };
    return it;
  };

  function fileHandle(name, path) {
    return {
      kind: 'file',
      name: name,
      getFile: function () { return readFile(path, name); },
      createWritable: function () {
        return Promise.reject(domError('NotAllowedError', 'The export is read-only.'));
      },
    };
  }

  // One read at a time: the stream for one file is reassembled whole before
  // the next starts, and a stream that restarts at offset 0 (after a worker
  // restart) throws away what it had.
  function readFile(path, name) {
    var run = function () {
      counters.fileReads++;
      var parts = [];
      var total = 0;
      return request({ type: 'file.read', path: path }, function (part) {
        if (part.ok === false) return;
        if (part.offset === 0 && parts.length) { parts = []; total = 0; }
        var bytes = fromBase64(typeof part.data === 'string' ? part.data : '');
        parts.push(bytes);
        total += bytes.length;
      }).then(function (reply) {
        if (!reply || reply.ok === false) {
          throw domError('NotFoundError', 'cswap could not read "' + path + '" (' + ((reply && reply.reason) || 'no reply') + ').');
        }
        var bytes = new Uint8Array(total);
        var at = 0;
        for (var i = 0; i < parts.length; i++) { bytes.set(parts[i], at); at += parts[i].length; }
        return new globals.File([bytes], name, { type: mimeFor(name), lastModified: 0 });
      });
    };
    var result = readChain.then(run, run);
    readChain = result.then(function () {}, function () {});
    return result;
  }

  function buildFolder(root, files) {
    var dir = new LazyDir(typeof root === 'string' && root ? root : 'export');
    var list = Array.isArray(files) ? files : [];
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (!row || typeof row.path !== 'string') continue;
      var parts = row.path.split('/');
      var ok = true;
      for (var j = 0; j < parts.length; j++) {
        try { checkName(parts[j]); } catch (e) { ok = false; }
      }
      if (!ok) continue;
      var here = dir;
      for (var k = 0; k < parts.length - 1; k++) {
        if (!here.dirs.has(parts[k])) here.dirs.set(parts[k], new LazyDir(parts[k]));
        here = here.dirs.get(parts[k]);
      }
      here.files.set(parts[parts.length - 1], row.path);
    }
    return dir;
  }

  // ---------------------------------------------------------- the gate in front of fetch

  var cancelled = false;
  var requestSeq = 0;
  var inFlight = new Set(); // AbortControllers of requests being performed

  function cancelAll() {
    cancelled = true;
    inFlight.forEach(function (ctrl) { try { ctrl.abort(); } catch (e) { /* nothing */ } });
    var err = cancelledError();
    pending.forEach(function (entry, id) {
      if (entry.msg.type === 'gate.permit' || entry.msg.type === 'gate.report' || entry.msg.type === 'file.read') {
        pending.delete(id);
        entry.reject(err);
      }
    });
  }

  function cancelledError() {
    return domError('AbortError', 'cancelled from the cswap panel');
  }

  function parseUrl(input) {
    var text = input && typeof input === 'object' && typeof input.url === 'string' ? input.url : String(input);
    try { return new URL(text, base); } catch (e) { return null; }
  }

  function isGated(url) {
    if (!url) return false;
    if (url.origin !== origin && url.origin !== CLAUDE_ORIGIN) return false;
    return url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/v1/') === 0;
  }

  function isCreate(method, pathname) {
    if (method !== 'POST') return false;
    for (var i = 0; i < CREATE_PATH_RES.length; i++) if (CREATE_PATH_RES[i].test(pathname)) return true;
    return false;
  }

  function isFormData(body) {
    return !!body && typeof body === 'object' && typeof body.entries === 'function' && typeof body.append === 'function';
  }

  function bodySigOf(body) {
    if (typeof body === 'string') return 'json:' + fnv1a32(body);
    if (isFormData(body)) {
      var it = body.entries();
      for (var r = it.next(); !r.done; r = it.next()) {
        var value = r.value[1];
        if (value && typeof value === 'object' && typeof value.size === 'number') {
          return 'form:' + (typeof value.name === 'string' ? value.name : r.value[0]) + ':' + value.size;
        }
      }
      return 'form:';
    }
    return '';
  }

  function bodyBytesOf(body) {
    if (typeof body === 'string') {
      try { return new TextEncoder().encode(body).length; } catch (e) { return body.length; }
    }
    if (isFormData(body)) {
      var sum = 0;
      var it = body.entries();
      for (var r = it.next(); !r.done; r = it.next()) {
        var value = r.value[1];
        sum += value && typeof value === 'object' && typeof value.size === 'number' ? value.size : String(value).length;
      }
      return sum;
    }
    if (body && typeof body === 'object' && typeof body.size === 'number') return body.size;
    if (body && typeof body === 'object' && typeof body.byteLength === 'number') return body.byteLength;
    return 0;
  }

  function nameInBody(body) {
    if (typeof body !== 'string') return '';
    try {
      var j = JSON.parse(body);
      return j && typeof j.name === 'string' ? j.name : '';
    } catch (e) { return ''; }
  }

  var created = null; // { id, url, name } once a create was answered

  function describeCreated(response, pathname, body) {
    return readUpTo(response, BODY_LIMIT).then(function (text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { return null; }
      var id = null;
      var url = null;
      if (pathname.indexOf('/v1/') === 0) {
        var inner = unwrap(data);
        if (inner && typeof inner.id === 'string') { id = inner.id; url = origin + '/code/project/' + encodeURIComponent(id); }
      } else if (data && typeof data.uuid === 'string') {
        id = data.uuid;
        url = origin + '/project/' + encodeURIComponent(id);
      }
      if (!id) return null;
      return { id: id, url: url, name: nameInBody(body) };
    });
  }

  // What the worker is told about a response: status, allowlisted headers,
  // the markers of a challenge page, a short redacted excerpt of an HTML
  // error, the error fields of a JSON error, and the id of a created
  // project. A 2xx body is otherwise never read.
  function describeResponse(response, method, pathname, body) {
    var contentType = '';
    try { contentType = String(response.headers.get('content-type') || '').toLowerCase(); } catch (e) { contentType = ''; }
    var rep = {
      status: response.status,
      ok: !!response.ok,
      redirected: !!response.redirected,
      finalPath: pathOnly(response.url || ''),
      headers: pickHeaders(response.headers),
      markers: [],
    };
    var work = Promise.resolve();
    if (response.status >= 400 && contentType.indexOf('text/html') === 0) {
      work = readUpTo(safeClone(response), BODY_LIMIT).then(function (text) {
        rep.markers = scanBody(text);
        rep.bodyExcerpt = clip(redactText(text), EXCERPT_CHARS);
      });
    } else if (response.status >= 400 && contentType.indexOf('json') >= 0) {
      work = readUpTo(safeClone(response), BODY_LIMIT).then(function (text) {
        try {
          var err = JSON.parse(text);
          err = err && err.error;
          if (err && typeof err === 'object') {
            rep.bodyJson = { error: {
              type: clip(err.type, 100),
              reason: clip(err.reason, 100),
              message: clip(redactText(err.message), EXCERPT_CHARS),
            } };
          }
        } catch (e) { /* not JSON after all */ }
      });
    } else if (response.ok && isCreate(method, pathname)) {
      work = describeCreated(safeClone(response), pathname, body).then(function (made) {
        if (made) { created = made; rep.created = made; }
      });
    }
    return work.then(function () { return rep; }, function () { return rep; });
  }

  function safeClone(response) {
    try { return response.clone(); } catch (e) { return response; }
  }

  function describeError(error) {
    return {
      status: 0,
      ok: false,
      redirected: false,
      finalPath: '',
      headers: {},
      markers: [],
      error: {
        name: error && error.name ? String(error.name) : 'Error',
        message: clip(redactText(error && error.message ? error.message : String(error)), EXCERPT_CHARS),
      },
    };
  }

  function performOnce(input, init, bodyBytes) {
    var ctrl = new globals.AbortController();
    var settled = false;
    var timeoutMs = timeoutBase + MS_PER_MIB * Math.ceil(bodyBytes / 1048576);
    var timer = schedule(function () {
      if (settled) return;
      settled = true;
      ctrl.abort(domError('AbortError', 'no reply within ' + Math.round(timeoutMs / 1000) + ' seconds'));
    }, timeoutMs);
    inFlight.add(ctrl);
    // The script's own signal is deliberately not passed through: a hold
    // can outlast its 60 s timer, and its finally clears that timer anyway.
    var own = Object.assign({}, init || {}, { signal: ctrl.signal });
    var started = now();
    return Promise.resolve().then(function () { return env.fetchImpl(input, own); }).then(function (response) {
      finish();
      return { response: response, error: null, elapsedMs: now() - started };
    }, function (error) {
      var e = error;
      if (ctrl.signal.aborted && settled && !(e && e.message && /cswap|cancelled/.test(e.message))) {
        e = domError('AbortError', 'no reply within ' + Math.round(timeoutMs / 1000) + ' seconds');
      }
      finish();
      return { response: null, error: e, elapsedMs: now() - started };
    });

    function finish() {
      inFlight.delete(ctrl);
      if (settled) return;
      settled = true;
      if (unschedule) { try { unschedule(timer); } catch (e) { /* nothing */ } }
    }
  }

  function refusal(reason) {
    if (reason === 'cancelled') return cancelledError();
    if (reason === 'wrong-phase') return new TypeError('cswap refused a second request to create the project');
    if (reason === 'no-job') return new TypeError('cswap: no import job is active for this page');
    return new TypeError('cswap refused this request (' + reason + ')');
  }

  // One request, end to end: permit, perform, report, and the hold loop.
  function gatedFetch(input, init, kind) {
    var url = parseUrl(input);
    if (!isGated(url)) return env.fetchImpl(input, init);
    if (cancelled) return Promise.reject(cancelledError());
    if (detached) return Promise.reject(detachedError());

    var method = String((init && init.method) || 'GET').toUpperCase();
    var body = init ? init.body : undefined;
    var pathname = url.pathname;
    var stepKey = method + ' ' + pathname + url.search + ' ' + bodySigOf(body);
    var bodyBytes = bodyBytesOf(body);
    var parked = null; // { response, error } of a held attempt
    var retryOf = null;

    var attempt = function () {
      var requestId = 'r' + (++requestSeq);
      counters.requests++;
      var ask = { type: 'gate.permit', requestId: requestId, stepKey: stepKey, method: method,
        path: pathname, kind: kind, bodyBytes: bodyBytes };
      if (retryOf) ask.retryOf = retryOf;
      return request(ask).then(function (permit) {
        if (!permit || permit.ok !== true) {
          var reason = permit && permit.reason ? permit.reason : 'no reply';
          if (reason === 'give-up' && parked) return unpark(parked);
          throw refusal(reason);
        }
        return performOnce(input, init, bodyBytes).then(function (got) {
          if (cancelled) throw cancelledError();
          var describe = got.response
            ? describeResponse(got.response, method, pathname, body)
            : Promise.resolve(describeError(got.error));
          return describe.then(function (rep) {
            rep.requestId = requestId;
            rep.permit = permit.permit;
            rep.elapsedMs = got.elapsedMs;
            return request(Object.assign({ type: 'gate.report' }, rep));
          }).then(function (verdict) {
            // A probe only looks: whatever the worker decides, its result
            // goes back to the worker, which is what the probe is for.
            if (!verdict || verdict.action !== 'hold' || kind === 'probe') return unpark(got);
            parked = got;
            retryOf = permit.permit;
            return attempt();
          });
        });
      });
    };

    return attempt();
  }

  function unpark(got) {
    if (got.error) throw got.error;
    return got.response;
  }

  // ---------------------------------------------------------- prompt(), confirm(), alert(), console

  function answerPrompt(message, suggested) {
    var text = String(message == null ? '' : message);
    var fallback = suggested == null ? null : String(suggested);
    var kind = 'other';
    var answer = fallback;
    var sourceVisible = false;
    if (/^Which organization/.test(text)) {
      // The script worked out the organization the page is showing and
      // offers it as the suggestion; that is the answer.
      kind = 'org';
    } else if (/^This folder holds/.test(text)) {
      kind = 'which';
      answer = '1';
    } else if (/Name for the new project/.test(text)) {
      kind = 'name';
      sourceVisible = /can be seen from this login/.test(text);
      answer = wantedName || fallback;
    }
    counters.prompts++;
    push('script.event', { kind: 'prompt', question: clip(redactText(text), 2000), answer: answer,
      promptKind: kind, sourceVisible: sourceVisible });
    return answer;
  }

  var ROWS_TAGS = ['Claude importer: everything that was done:', 'Claude importer: what was done before it stopped:'];
  var rows = null;

  function reduceRows(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i] || {};
      out.push({
        group: clip(r.group, 40), item: clip(r.item, 300), result: clip(r.result, 40),
        detail: clip(redactText(r.detail), 500),
      });
    }
    return out;
  }

  function observeConsole(level, args) {
    var first = args[0];
    if (typeof first !== 'string' || first.indexOf('Claude importer') !== 0) return;
    counters.consoleLines++;
    var text;
    var isRows = false;
    for (var i = 0; i < ROWS_TAGS.length; i++) if (first.indexOf(ROWS_TAGS[i]) === 0) isRows = true;
    if (isRows && Array.isArray(args[1])) {
      rows = reduceRows(args[1]);
      push('script.event', { kind: 'rows', rows: rows });
      text = first + ' [' + rows.length + ' rows]';
    } else {
      var shown = [];
      for (var j = 0; j < args.length; j++) shown.push(show(args[j]));
      text = shown.join(' ');
    }
    push('script.event', { kind: 'console', level: level, text: clip(redactText(text), 2000) });
  }

  function wrapConsole(con) {
    if (!con || typeof con !== 'object') return;
    var levels = ['log', 'warn', 'error', 'info', 'debug', 'table'];
    for (var i = 0; i < levels.length; i++) wrapLevel(con, levels[i]);
  }

  function wrapLevel(con, level) {
    var original = typeof con[level] === 'function' ? con[level] : null;
    con[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      try { observeConsole(level, args); } catch (e) { /* never in the script's way */ }
      if (original) return original.apply(con, args);
      return undefined;
    };
  }

  // ---------------------------------------------------------- watching the script's own UI

  var state = { ready: false, finished: '', pressed: false, statusText: '', link: '', button: '', disabled: false,
    detachedBecause: '' };
  var statusTimer = null;
  var statusDirty = false;

  function childrenOf(wrap) {
    var out = [];
    var kids = wrap && wrap.children;
    if (!kids) return out;
    for (var i = 0; i < kids.length; i++) out.push(kids[i]);
    return out;
  }

  function findImporter() {
    var wrap = null;
    try { wrap = doc.getElementById(IMPORTER_ID); } catch (e) { wrap = null; }
    if (!wrap) return null;
    var found = { wrap: wrap, status: null, link: null, button: null };
    var kids = childrenOf(wrap);
    for (var i = 0; i < kids.length; i++) {
      var tag = String(kids[i].tagName || '').toUpperCase();
      if (tag === 'DIV' && !found.status) found.status = kids[i];
      else if (tag === 'A' && !found.link) found.link = kids[i];
      else if (tag === 'BUTTON' && !found.button) found.button = kids[i];
    }
    return found.button ? found : null;
  }

  function observation() {
    return { ready: state.ready, finished: state.finished, pressed: state.pressed, statusText: state.statusText,
      link: state.link, button: state.button, disabled: state.disabled };
  }

  function snapshotOf(parts) {
    var link = '';
    if (parts.link) {
      var display = parts.link.style ? parts.link.style.display : '';
      if (parts.link.href && display !== 'none') link = String(parts.link.href);
    }
    return {
      text: parts.status ? String(parts.status.textContent || '') : '',
      link: link,
      button: String(parts.button.textContent || ''),
      disabled: !!parts.button.disabled,
    };
  }

  function countRows(list) {
    var counts = { created: 0, set: 0, added: 0, moved: 0, leftOut: 0, notSet: 0, notAdded: 0, toCheck: 0 };
    var names = { 'created': 'created', 'set': 'set', 'added': 'added', 'moved': 'moved', 'left out': 'leftOut',
      'not set': 'notSet', 'not added': 'notAdded', 'to check': 'toCheck' };
    for (var i = 0; i < list.length; i++) {
      var key = names[list[i].result];
      if (key) counts[key]++;
    }
    return counts;
  }

  function buildResult(snap) {
    var list = rows || [];
    var made = created ? { id: created.id, url: created.url, name: created.name } : null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].group === 'project' && list[i].result === 'created') {
        if (!made) made = { id: null, url: snap.link || null, name: list[i].detail };
        else if (!made.name) made.name = list[i].detail;
      }
    }
    if (made && !made.id && snap.link) {
      var tail = pathOnly(snap.link).split('/').pop();
      if (tail) made.id = decodeURIComponent(tail);
    }
    var paused = false;
    for (var j = 0; j < list.length; j++) {
      if (list[j].item === 'Pause' && list[j].result === 'set') paused = true;
    }
    return { created: made, status: snap.text, link: snap.link, paused: paused, rows: list, counts: countRows(list) };
  }

  function flushStatus() {
    statusTimer = null;
    if (!statusDirty) return;
    statusDirty = false;
    push('script.event', { kind: 'status', text: clip(redactText(state.statusText), 1000), link: state.link,
      button: state.button, disabled: state.disabled });
  }

  function check() {
    var parts = findImporter();
    if (!parts) return;
    if (!state.ready) {
      state.ready = true;
      push('script.event', { kind: 'ready' });
    }
    var snap = snapshotOf(parts);
    var changed = snap.text !== state.statusText || snap.link !== state.link || snap.button !== state.button ||
      snap.disabled !== state.disabled;
    state.statusText = snap.text;
    state.link = snap.link;
    state.button = snap.button;
    state.disabled = snap.disabled;
    if (changed) {
      statusDirty = true;
      if (!statusTimer) statusTimer = schedule(flushStatus, STATUS_THROTTLE_MS);
    }
    if (state.finished) return;
    if (snap.button === 'Import complete') {
      state.finished = 'done';
      flushNow();
      push('script.event', { kind: 'done', result: buildResult(snap) });
    } else if (/^(Import failed|The import stopped part-way|Nothing was imported)/.test(snap.text)) {
      state.finished = 'failed';
      flushNow();
      push('script.event', { kind: 'failed', text: clip(redactText(snap.text), 1000), link: snap.link,
        result: buildResult(snap) });
    }
  }

  // The last status goes out before a terminal event, without waiting for
  // the throttle timer.
  function flushNow() {
    if (statusTimer && unschedule) { try { unschedule(statusTimer); } catch (e) { /* nothing */ } }
    statusTimer = null;
    flushStatus();
  }

  function watch() {
    if (typeof Observer !== 'function' || !doc.body) return;
    try {
      var observer = new Observer(function () { try { check(); } catch (e) { /* nothing */ } });
      observer.observe(doc.body, { childList: true, subtree: true, characterData: true, attributes: true });
    } catch (e) { /* no observer: the worker still gets the fetch reports */ }
    try { check(); } catch (e) { /* nothing */ }
  }

  // ---------------------------------------------------------- pushes from the worker

  function press() {
    if (state.pressed) return false;
    var parts = findImporter();
    if (!parts) return false;
    state.pressed = true;
    try { parts.button.click(); } catch (e) { /* the script's own handler reports */ }
    return true;
  }

  function fetchJson(url) {
    return gatedFetch(url, { credentials: 'include', headers: { Accept: 'application/json' } }, 'probe')
      .then(function (r) {
        return readUpTo(safeClone(r), BODY_LIMIT).then(function (text) {
          var data = null;
          try { data = JSON.parse(text); } catch (e) { data = null; }
          return { status: r.status, ok: !!r.ok, finalPath: pathOnly(r.url || ''), redirected: !!r.redirected, data: data };
        });
      });
  }

  // Who is signed in: the organizations the page can see and the account's
  // email, asked through the gate as probes.
  function probeIdentity(probeId) {
    var identity = { status: 0, email: null, orgs: null, finalPath: '', redirected: false, error: null };
    return fetchJson(ORGS_ENDPOINT).then(function (r) {
      identity.status = r.status;
      identity.finalPath = r.finalPath;
      identity.redirected = r.redirected;
      if (r.ok) {
        var list = Array.isArray(r.data) ? r.data : r.data && Array.isArray(r.data.data) ? r.data.data : [];
        identity.orgs = [];
        for (var i = 0; i < list.length; i++) {
          if (list[i] && typeof list[i].uuid === 'string') identity.orgs.push(list[i].uuid);
        }
      }
      if (r.status === 401) return null;
      return accountEmail(0);
    }).then(function (email) {
      if (email) identity.email = email;
    }, function (e) {
      identity.error = clip(redactText(e && e.message ? e.message : String(e)), EXCERPT_CHARS);
    }).then(function () {
      counters.probes++;
      return push('identity.result', { probeId: probeId, identity: identity });
    });
  }

  function accountEmail(i) {
    if (i >= accountEndpoints.length) return Promise.resolve(null);
    return fetchJson(accountEndpoints[i]).then(function (r) {
      var email = r.status === 200 ? emailOf(r.data) : null;
      return email || accountEmail(i + 1);
    }, function () { return accountEmail(i + 1); });
  }

  pushHandlers['export.set'] = function (m) {
    folder = buildFolder(m.root, m.files);
  };
  pushHandlers['probe.identity'] = function (m) {
    probeIdentity(typeof m.probeId === 'string' ? m.probeId : '');
  };
  pushHandlers['press'] = function () {
    press();
  };
  pushHandlers['cancel'] = function () {
    cancelAll();
  };

  // ---------------------------------------------------------- install

  function install(target) {
    target.fetch = function (input, init) { return gatedFetch(input, init, 'script'); };
    target.showDirectoryPicker = function () {
      counters.pickerCalls++;
      if (!folder) return Promise.reject(domError('AbortError', 'cswap has not loaded the export into this page yet'));
      return Promise.resolve(folder);
    };
    target.prompt = answerPrompt;
    target.confirm = function () { return true; };
    target.alert = function () {};
  }

  install(globals);
  if (win !== globals) install(win);
  wrapConsole(globals.console);
  if (win !== globals && win.console && win.console !== globals.console) wrapConsole(win.console);

  function publicState() {
    return {
      jobId: jobId,
      attached: !!lastAttach,
      detached: detached,
      detachedBecause: state.detachedBecause,
      cancelled: cancelled,
      pickerCalls: counters.pickerCalls,
      prompts: counters.prompts,
      requests: counters.requests,
      fileReads: counters.fileReads,
      reconnects: counters.reconnects,
      probes: counters.probes,
      ready: state.ready,
      pressed: state.pressed,
      finished: state.finished,
      statusText: state.statusText,
      link: state.link,
      created: created ? created.id : null,
    };
  }

  var helper = Object.freeze({ version: VERSION, state: publicState });
  try {
    Object.defineProperty(globals, '__cswapImport', { value: helper, writable: false, configurable: false, enumerable: false });
  } catch (e) {
    globals.__cswapImport = helper;
  }

  watch();
  connect();
  return helper;
}

// Production wiring: the worker puts the boot object in place and runs this
// file right after it. Under test, the file is evaluated with no `chrome`
// and createPageHelper is called with stand-ins.
if (typeof chrome !== 'undefined' && chrome && chrome.runtime && typeof chrome.runtime.connect === 'function' &&
    typeof globalThis.__cswapBoot === 'object' && globalThis.__cswapBoot) {
  (function () {
    var bootObject = globalThis.__cswapBoot;
    try { delete globalThis.__cswapBoot; } catch (e) { globalThis.__cswapBoot = undefined; }
    createPageHelper({
      globals: globalThis,
      win: typeof window !== 'undefined' ? window : globalThis,
      doc: typeof document !== 'undefined' ? document : null,
      boot: bootObject,
      connect: function () { return chrome.runtime.connect({ name: 'cswap-page' }); },
      now: Date.now,
      fetchImpl: fetch.bind(globalThis),
      schedule: setTimeout.bind(globalThis),
      unschedule: clearTimeout.bind(globalThis),
      MutationObserver: typeof MutationObserver === 'function' ? MutationObserver : null,
    });
  })();
}
