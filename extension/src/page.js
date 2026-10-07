'use strict';
// ============================================================
// cswap page helper
// ============================================================
//
// Injected by the extension's service worker into the user-script world of
// the claude.ai tab, just before the unchanged project-import.js (an import
// queued from the command line) or the unchanged project-export.js (the
// export half of a Duplicate started from the side panel). It stands in for
// the three things in those scripts that wait for a person, and puts a gate
// in front of the script's requests:
//
//   * showDirectoryPicker() hands back a folder. For an import it holds the
//     export's listing and fetches a file's bytes from cswap only when the
//     script asks for them (nothing is copied into the page up front); for
//     an export it sends every file the script writes to cswap, a piece at
//     a time, which saves it to disk;
//   * prompt() answers the script's questions: the project name the CLI
//     gave or the script's own suggestion, the organization the script
//     itself worked out, and for an export the project the side panel chose;
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
  var EXPORTER_ID = 'claude-simple-exporter';
  var CHUNK_BYTES = 512 * 1024;
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
  // The export script's own idea of a project page and of a /code/ id,
  // copied from project-export.js so the panel's choice and the script's
  // agree on what the tab is showing.
  var WORKSPACE_PATH = /\/(?:(code)\/)?projects?\/([0-9a-f-]{20,}|[a-z]+_[0-9a-z]{8,})(?=\/|$)/i;
  var CODE_ID = /^chan_/i;
  var PROJECTS_PATH = '/api/organizations/{org}/projects?include_harmony_projects=true&limit=100';
  // The export script's own /code/ requests (ENDPOINTS.code.channels and
  // ENDPOINTS.code.channel, sent with the anthropic-version header of its
  // V1_HEADERS). The script cannot list Claude Code projects: it takes the
  // tab's from the address and its name from this list, or from the
  // channel asked for by itself, so the side panel asks the same.
  var CHANNELS_PATH = '/v1/code/channels?scope=joined&include_members=true&include_archived=true&limit=200';
  var CHANNEL_PATH = '/v1/code/channels/{channel}';
  var V1_VERSION = '2023-06-01';

  var BODY_LIMIT = 65536; // bytes of an error body looked at for markers
  // Bytes of a list read for the side panel. A long channel list with its
  // members runs past BODY_LIMIT, and a list cut short parses as nothing.
  var LIST_BODY_LIMIT = 8 * 1048576;
  // Pages of the channel list read for the side panel, at most: the list
  // stops at 200 rows a page and names the next page while there is one.
  var LIST_PAGES = 10;
  var UNREADABLE = 'the list could not be read';
  var UNREADABLE_ROWS = 'no project in the list could be read';
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
  var flow = boot.kind === 'export' ? 'export' : 'import';
  var BOX_ID = flow === 'export' ? EXPORTER_ID : IMPORTER_ID;
  var CONSOLE_PREFIX = flow === 'export' ? 'Claude exporter' : 'Claude importer';
  var wantedName = typeof boot.name === 'string' ? boot.name.trim() : '';
  var wantedProject = boot.project && typeof boot.project === 'object' ? boot.project : null;
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

  function toBase64(bytes) {
    var out = '';
    var step = 0x8000;
    for (var i = 0; i < bytes.length; i += step) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return globals.btoa(out);
  }

  // Whatever the export script writes to a file (text, bytes, a Blob, or
  // the {type: 'write', data} form) as bytes; text is UTF-8, as on a disk.
  function asBytes(chunk) {
    if (chunk && typeof chunk === 'object' && chunk.type === 'write' && 'data' in chunk) chunk = chunk.data;
    if (typeof chunk === 'string') return Promise.resolve(new TextEncoder().encode(chunk));
    if (chunk instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(chunk));
    if (ArrayBuffer.isView(chunk)) {
      return Promise.resolve(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
    if (chunk && typeof chunk.arrayBuffer === 'function') {
      return Promise.resolve(chunk.arrayBuffer()).then(function (buffer) { return new Uint8Array(buffer); });
    }
    return Promise.reject(new TypeError('cswap: unsupported data written to a file'));
  }

  // The "1. name" lines of a numbered question, with "  [code]" taken off,
  // and the one of them that `wanted` names: an exact match, else the only
  // partial one. The same rules as project-move auto.
  function optionsOf(message) {
    var out = [];
    var lines = String(message).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^(\d+)\. (.*)$/);
      if (m) out.push({ n: m[1], name: m[2].replace(/ {2}\[code\]$/, '').trim() });
    }
    return out;
  }

  function byName(list, wanted) {
    var want = String(wanted == null ? '' : wanted).trim().toLowerCase();
    if (!want) return null;
    var exact = [];
    var partial = [];
    for (var i = 0; i < list.length; i++) {
      var name = list[i].name.toLowerCase();
      if (name === want) exact.push(list[i]);
      if (name.indexOf(want) >= 0) partial.push(list[i]);
    }
    if (exact.length === 1) return exact[0];
    return partial.length === 1 ? partial[0] : null;
  }

  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.data)) return v.data;
    if (v && Array.isArray(v.items)) return v.items;
    if (v && Array.isArray(v.results)) return v.results;
    return [];
  }

  function findList(v) {
    if (Array.isArray(v)) return v;
    var keys = ['data', 'items', 'results', 'conversations', 'chats', 'sessions', 'channels', 'threads', 'timeline',
      'events', 'messages'];
    for (var i = 0; i < keys.length; i++) if (v && Array.isArray(v[keys[i]])) return v[keys[i]];
    return null;
  }

  function idOf(obj) {
    if (obj && typeof obj.uuid === 'string' && obj.uuid) return obj.uuid;
    if (obj && typeof obj.id === 'string' && obj.id) return obj.id;
    return null;
  }

  // The project the tab is showing, by its address, as the export script sees it.
  function workspaceHere() {
    var pathname = win.location && typeof win.location.pathname === 'string' ? win.location.pathname : '';
    var m = pathname.match(WORKSPACE_PATH);
    if (!m) return null;
    return { id: m[2], kind: (m[1] || CODE_ID.test(m[2])) ? 'code' : 'standard' };
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
    return domError('AbortError', 'cswap: this page is no longer attached to the ' + flow);
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

  // The async iterators a folder handle offers, over a list made up front.
  function asyncList(items) {
    var i = 0;
    var it = {};
    it.next = function () { return Promise.resolve(i < items.length ? { value: items[i++], done: false } : { value: undefined, done: true }); };
    it[Symbol.asyncIterator] = function () { return it; };
    return it;
  }

  function asyncMapped(inner, map) {
    var it = {};
    it.next = function () {
      return inner.next().then(function (r) { return r.done ? r : { value: map(r.value), done: false }; });
    };
    it[Symbol.asyncIterator] = function () { return it; };
    return it;
  }

  LazyDir.prototype.values = function () {
    var items = [];
    this.dirs.forEach(function (d) { items.push(d); });
    this.files.forEach(function (path, name) { items.push(fileHandle(name, path)); });
    return asyncList(items);
  };

  LazyDir.prototype.entries = function () {
    return asyncMapped(this.values(), function (h) { return [h.name, h]; });
  };

  LazyDir.prototype.keys = function () {
    return asyncMapped(this.values(), function (h) { return h.name; });
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

  // ---------------------------------------------------------- the folder an export writes into

  // A folder like the one the picker hands out, for the export script to
  // write into. Each file goes to the worker, and through it to cswap, in
  // pieces of at most CHUNK_BYTES as it is written, one piece at a time and
  // each waited for: nothing is kept in the page, and a piece cswap will
  // not take fails the file the way a full disk would, which the script
  // reports as a failed export rather than trying again on its own.
  var outRoot = null;
  var writeChain = Promise.resolve();
  var written = { files: 0, bytes: 0 };

  function OutDir(name, path) {
    this.kind = 'directory';
    this.name = name;
    this.path = path; // '' for the picked folder itself
    this.dirs = new Map();
    this.files = new Map(); // name -> { size }
  }

  OutDir.prototype.getDirectoryHandle = function (name, opts) {
    var self = this;
    return new Promise(function (resolve) {
      checkName(name);
      if (self.files.has(name)) throw domError('TypeMismatchError', '"' + name + '" is a file, not a folder.');
      if (!self.dirs.has(name)) {
        if (!(opts && opts.create)) throw domError('NotFoundError', 'There is no "' + name + '" yet.');
        self.dirs.set(name, new OutDir(name, self.path ? self.path + '/' + name : name));
      }
      resolve(self.dirs.get(name));
    });
  };

  OutDir.prototype.getFileHandle = function (name, opts) {
    var self = this;
    return new Promise(function (resolve) {
      checkName(name);
      if (self.dirs.has(name)) throw domError('TypeMismatchError', '"' + name + '" is a folder, not a file.');
      if (!self.files.has(name)) {
        if (!(opts && opts.create)) throw domError('NotFoundError', 'There is no "' + name + '" yet.');
        self.files.set(name, { size: 0 });
      }
      resolve(outFile(name, self.path ? self.path + '/' + name : name, self.files.get(name)));
    });
  };

  OutDir.prototype.values = function () {
    var self = this;
    var items = [];
    self.dirs.forEach(function (d) { items.push(d); });
    self.files.forEach(function (record, name) { items.push(outFile(name, self.path ? self.path + '/' + name : name, record)); });
    return asyncList(items);
  };

  OutDir.prototype.entries = LazyDir.prototype.entries;
  OutDir.prototype.keys = LazyDir.prototype.keys;

  function outFile(name, path, record) {
    return {
      kind: 'file',
      name: name,
      getFile: function () { return Promise.reject(domError('NotAllowedError', 'cswap keeps no copy of what was written.')); },
      createWritable: function () { return Promise.resolve(outWritable(path, record)); },
    };
  }

  // One piece to the worker, after every piece before it; the worker's
  // answer says whether cswap saved it.
  function sendPiece(path, offset, bytes, last) {
    var run = function () {
      return request({ type: 'file.write', path: path, offset: offset, data: toBase64(bytes), last: last,
        size: offset + bytes.length }).then(function (reply) {
        if (!reply || reply.ok !== true) {
          throw domError('NotAllowedError', 'cswap could not save "' + path + '" (' + ((reply && reply.reason) || 'no reply') + ').');
        }
        return reply;
      });
    };
    var result = writeChain.then(run, run);
    writeChain = result.then(function () {}, function () {});
    return result;
  }

  function sendBytes(path, start, bytes, last) {
    var pieces = [];
    for (var i = 0; i < bytes.length; i += CHUNK_BYTES) pieces.push(bytes.subarray(i, i + CHUNK_BYTES));
    if (!pieces.length) pieces.push(bytes.subarray(0, 0));
    var k = 0;
    var at = start;
    var next = function (reply) {
      if (k >= pieces.length) return reply;
      var piece = pieces[k++];
      var here = at;
      at += piece.length;
      return sendPiece(path, here, piece, last && k === pieces.length).then(next);
    };
    return next(null);
  }

  function joinPieces(parts, total) {
    var bytes = new Uint8Array(total);
    var at = 0;
    for (var i = 0; i < parts.length; i++) { bytes.set(parts[i], at); at += parts[i].length; }
    return bytes;
  }

  function outWritable(path, record) {
    var parts = [];
    var buffered = 0;
    var offset = 0; // bytes handed to the worker so far
    var open = true;
    var failed = null;

    function flush(last) {
      var bytes = joinPieces(parts, buffered);
      parts = [];
      buffered = 0;
      var start = offset;
      offset += bytes.length;
      return sendBytes(path, start, bytes, last).then(null, function (e) { failed = e; throw e; });
    }

    return {
      write: function (chunk) {
        if (!open) return Promise.reject(new TypeError('write after close: ' + path));
        if (failed) return Promise.reject(failed);
        return asBytes(chunk).then(function (bytes) {
          parts.push(bytes.slice());
          buffered += bytes.length;
          if (buffered < CHUNK_BYTES) return undefined;
          return flush(false).then(function () { return undefined; });
        });
      },
      close: function () {
        if (!open) return Promise.reject(new TypeError('closed twice: ' + path));
        open = false;
        if (failed) return Promise.reject(failed);
        return flush(true).then(function () {
          record.size = offset;
          written.files++;
          written.bytes += offset;
          return undefined;
        });
      },
      abort: function () {
        open = false;
        parts = [];
        buffered = 0;
        return Promise.resolve();
      },
    };
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
      var t = entry.msg.type;
      if (t === 'gate.permit' || t === 'gate.report' || t === 'file.read' || t === 'file.write') {
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
    if (reason === 'no-job') return new TypeError('cswap: no ' + flow + ' job is active for this page');
    return new TypeError('cswap refused this request (' + reason + ')');
  }

  // One request, end to end: permit, perform, report, and the hold loop.
  // `seen`, when given, is told the worker's verdict on the answer.
  function gatedFetch(input, init, kind, seen) {
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
            // goes back to the worker, which is what the probe is for. The
            // verdict goes to the probe as well, so that it asks nothing
            // more of a site that has just stopped it.
            if (seen) seen.verdict = verdict || null;
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
    var pick;
    if (/^Which project should be exported\?/.test(text)) {
      // The export script lists what it found; the one the side panel
      // chose is picked by name, and no answer at all when none matches
      // (the script then stops, and the worker says why).
      kind = 'project';
      pick = byName(optionsOf(text), wantedProject ? wantedProject.name : '');
      answer = pick ? pick.n : null;
    } else if (/^Which organization/.test(text) && flow === 'export') {
      // Asked only for a project the listing did not place; the panel's
      // choice knows its organization.
      kind = 'org';
      pick = byName(optionsOf(text), wantedProject ? wantedProject.orgName || wantedProject.orgUuid : '');
      answer = pick ? pick.n : null;
    } else if (/^Which organization/.test(text)) {
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
    if (typeof first !== 'string' || first.indexOf(CONSOLE_PREFIX) !== 0) return;
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

  // The script's box: its status line, its link and its main button. The
  // importer and the exporter lay theirs out the same way.
  function findImporter() {
    var wrap = null;
    try { wrap = doc.getElementById(BOX_ID); } catch (e) { wrap = null; }
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

  function buildExportResult(snap) {
    return { created: null, status: snap.text, link: '', paused: false, rows: [], counts: countRows([]),
      written: { files: written.files, bytes: written.bytes } };
  }

  // How the script says it ended: 'done', 'failed', or '' while it runs.
  function endOf(snap) {
    if (flow === 'export') {
      if (snap.button === 'Export complete') return 'done';
      return /^Export failed/.test(snap.text) ? 'failed' : '';
    }
    if (snap.button === 'Import complete') return 'done';
    return /^(Import failed|The import stopped part-way|Nothing was imported)/.test(snap.text) ? 'failed' : '';
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
    var end = endOf(snap);
    if (!end) return;
    var result = flow === 'export' ? buildExportResult(snap) : buildResult(snap);
    state.finished = end;
    flushNow();
    if (end === 'done') {
      push('script.event', { kind: 'done', result: result });
    } else {
      push('script.event', { kind: 'failed', text: clip(redactText(snap.text), 1000), link: snap.link, result: result });
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

  // A probe's GET, sent as the export script sends it and read as JSON.
  // opts.v1 adds the header every /v1/ request needs (the /api/ ones go
  // without it, as the script's do); opts.limit reads a longer body than an
  // identity answer. `interrupted` says the worker held or stopped on this
  // answer (a challenge, a sign-out), after which a listing asks no more.
  function fetchJson(url, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json' };
    if (opts.v1) headers['anthropic-version'] = V1_VERSION;
    var seen = { verdict: null };
    return gatedFetch(url, { credentials: 'include', headers: headers }, 'probe', seen)
      .then(function (r) {
        return readUpTo(safeClone(r), opts.limit || BODY_LIMIT).then(function (text) {
          var data = null;
          try { data = JSON.parse(text); } catch (e) { data = null; }
          var v = seen.verdict;
          return { status: r.status, ok: !!r.ok, finalPath: pathOnly(r.url || ''), redirected: !!r.redirected, data: data,
            interrupted: !!v && (v.verdict === 'interrupt' || v.action === 'hold') };
        });
      });
  }

  function firstText() {
    for (var i = 0; i < arguments.length; i++) {
      if (typeof arguments[i] === 'string' && arguments[i].trim()) return arguments[i];
    }
    return '';
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

  // The projects the signed-in account can see, found with the export
  // script's own requests (through the gate as probes), so the side panel
  // can offer them before the script is in the page: each organization's
  // project list, then the Claude Code projects from the script's channel
  // list, every page of it, and the tab's own channel asked for by itself
  // when that list leaves it out, as the script does. An organization or
  // a list that refuses is noted and the rest still count. An answer the
  // worker held on ends the listing: nothing more is asked of the site
  // until the person has acted. `codeList` says how the channel list went
  // (its first answer's status, the rows it named over how many pages,
  // and whether it reached its end), so the panel can tell an empty list
  // from one that was never read.
  function probeProjects(probeId) {
    var out = { projects: [], orgs: [], here: workspaceHere(), error: null, codeList: null };
    var orgs = [];
    var stopped = false;
    return fetchJson(ORGS_ENDPOINT).then(function (r) {
      if (!r.ok || r.interrupted) throw new Error(failure(r) + ' from ' + ORGS_ENDPOINT);
      var list = asArray(r.data);
      for (var i = 0; i < list.length; i++) {
        if (list[i] && typeof list[i].uuid === 'string' && list[i].uuid) orgs.push(list[i]);
      }
      return orgInTurn(0).then(listChannels).then(lookUpHere);
    }).then(null, function (e) {
      out.error = clip(redactText(e && e.message ? e.message : String(e)), EXCERPT_CHARS);
    }).then(function () {
      counters.probes++;
      return push('projects.result', { probeId: probeId, projects: out.projects, orgs: out.orgs, here: out.here,
        error: out.error, codeList: out.codeList });
    });

    function orgInTurn(i) {
      if (stopped || i >= orgs.length) return Promise.resolve();
      var org = orgs[i];
      var caps = Array.isArray(org.capabilities) ? org.capabilities : [];
      var row = { uuid: org.uuid, name: typeof org.name === 'string' ? clip(org.name, 200) : '', apiOnly: false, error: null };
      out.orgs.push(row);
      // An API-only organization has no claude.ai projects and refuses the
      // question; the export script skips it the same way.
      if (caps.indexOf('api') >= 0 && caps.indexOf('chat') < 0) {
        row.apiOnly = true;
        return orgInTurn(i + 1);
      }
      var url = PROJECTS_PATH.replace('{org}', encodeURIComponent(org.uuid));
      return fetchJson(url, { limit: LIST_BODY_LIMIT }).then(function (r) {
        if (r.interrupted) stopHere(r, pathOnly(url));
        if (!r.ok || r.interrupted) { row.error = failure(r); return; }
        var list = findList(r.data);
        if (!list) { row.error = UNREADABLE; return; }
        for (var j = 0; j < list.length; j++) {
          var project = list[j];
          var id = idOf(project);
          if (!id || hasProject(id, org.uuid)) continue;
          out.projects.push({
            id: id,
            name: typeof project.name === 'string' ? clip(project.name, 200) : '',
            kind: CODE_ID.test(id) ? 'code' : 'standard',
            orgUuid: org.uuid,
            orgName: row.name,
            archived: project.is_archived === true || project.archived === true,
          });
        }
      }, function (e) {
        row.error = clip(redactText(e && e.message ? e.message : String(e)), EXCERPT_CHARS);
      }).then(function () { return orgInTurn(i + 1); });
    }

    // The Claude Code projects, from the export script's channel list,
    // page after page while an answer names the next page (its
    // next_cursor, added to the same request as the command line's own
    // listing adds it), each through the gate. It never fails the listing:
    // what went wrong is noted, and the rows read before it still count.
    // The first page's answer goes on to lookUpHere, which decides from it
    // whether to ask once more.
    function listChannels() {
      if (stopped) return null;
      var path = pathOnly(CHANNELS_PATH);
      var tally = { status: 0, rows: 0, pages: 0, complete: false };
      var first = null;
      var cursors = [];
      out.codeList = tally;
      return page(CHANNELS_PATH);

      function page(url) {
        return fetchJson(url, { v1: true, limit: LIST_BODY_LIMIT }).then(function (r) {
          if (!first) { first = r; tally.status = r.status; }
          if (r.interrupted) { stopHere(r, path); return first; }
          if (!r.ok) { noteError('HTTP ' + r.status, path); return first; }
          var list = findList(r.data);
          if (!list) { noteError(UNREADABLE, path); return first; }
          tally.pages++;
          var read = 0;
          for (var i = 0; i < list.length; i++) if (addChannel(list[i])) read++;
          tally.rows += list.length;
          if (list.length && !read) noteError(UNREADABLE_ROWS, path);
          var cursor = nextCursorOf(r.data);
          if (!cursor) { tally.complete = true; return first; }
          // The same cursor twice means the site ignored it: stop rather
          // than loop, as the export script does.
          if (cursors.indexOf(cursor) >= 0 || tally.pages >= LIST_PAGES) {
            noteError('the list did not end after ' + tally.pages + ' pages', path);
            return first;
          }
          cursors.push(cursor);
          return page(CHANNELS_PATH + '&cursor=' + encodeURIComponent(cursor));
        }, function (e) {
          noteError(clip(redactText(e && e.message ? e.message : String(e)), EXCERPT_CHARS), path);
          return first;
        });
      }
    }

    // The tab's own channel, asked for by itself when no list named it (the
    // channel list stops at 200), as the export script does. Only after a
    // list that answered, or whose route was wrong (400, 404): after a
    // refusal, a slow-down or a failure another request would fare no
    // better.
    function lookUpHere(listed) {
      var here = out.here;
      var known = here ? findById(here.id) : null;
      if (stopped || !listed || !here || here.kind !== 'code' || (known && known.name)) return null;
      if (!(listed.ok || listed.status === 400 || listed.status === 404)) return null;
      var url = CHANNEL_PATH.replace('{channel}', encodeURIComponent(here.id));
      var path = pathOnly(url);
      return fetchJson(url, { v1: true, limit: LIST_BODY_LIMIT }).then(function (r) {
        if (r.interrupted) { stopHere(r, path); return; }
        var channel = r.ok ? channelOf(unwrap(r.data)) : null;
        if (channel && idOf(channel) === here.id) addChannel(channel);
        else noteError(r.ok ? 'unexpected reply' : 'HTTP ' + r.status, path);
      }, function (e) {
        noteError(clip(redactText(e && e.message ? e.message : String(e)), EXCERPT_CHARS), path);
      });
    }

    // The channel's record in one row of the list, or in the answer for
    // one channel: the row itself when it carries the id; else the record
    // under `channel`, for a row that pairs it with the membership; else
    // a row that names the channel by its channel_id and a name. Null for
    // a row that is none of these.
    function channelOf(row) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      if (idOf(row)) return row;
      if (row.channel && typeof row.channel === 'object' && !Array.isArray(row.channel) && idOf(row.channel)) return row.channel;
      if (typeof row.channel_id === 'string' && row.channel_id && firstText(row.name, row.title, row.topic)) {
        return { id: row.channel_id, name: row.name, title: row.title, topic: row.topic,
          archived: row.archived, is_archived: row.is_archived, archived_at: row.archived_at };
      }
      return null;
    }

    // One channel as a row: its name as the script names the project's
    // folder (name, title, topic), no organization (channels have none),
    // and nothing else of the record, whose members stay in the page.
    // True when the row named a channel, listed now or already.
    function addChannel(row) {
      var c = channelOf(row);
      var id = c ? idOf(c) : null;
      if (!id) return false;
      var name = clip(firstText(c.name, c.title, c.topic), 200);
      var known = findById(id);
      if (known) {
        if (!known.name) known.name = name;
        return true;
      }
      out.projects.push({ id: id, name: name, kind: 'code', orgUuid: '', orgName: '',
        archived: c.archived === true || c.is_archived === true || !!c.archived_at });
      return true;
    }

    function findById(id) {
      for (var k = 0; k < out.projects.length; k++) if (out.projects[k].id === id) return out.projects[k];
      return null;
    }

    function hasProject(id, orgUuid) {
      for (var k = 0; k < out.projects.length; k++) {
        if (out.projects[k].id === id && out.projects[k].orgUuid === orgUuid) return true;
      }
      return false;
    }

    function stopHere(r, path) {
      stopped = true;
      noteError(failure(r), path);
    }

    // The first thing that went wrong, by the path it came from: never a
    // query string, which no log or event ever carries.
    function noteError(why, path) {
      if (!out.error) out.error = clip(why + ' from ' + path, EXCERPT_CHARS);
    }
  }

  function failure(r) {
    return r.interrupted && r.ok ? 'interrupted' : 'HTTP ' + r.status;
  }

  // Where a /v1/ list says its next page starts, as the export script reads
  // it: a top-level next_cursor while more rows exist, left out at the end.
  // The cursor is the token to add to the same request; one given as an
  // address counts only for the token in its query. '' on the last page,
  // or for a cursor too long to be one.
  function nextCursorOf(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
    var candidates = [data.next_cursor, data.cursor && data.cursor.next,
      data.pagination && data.pagination.next_cursor, data.next];
    for (var i = 0; i < candidates.length; i++) {
      var v = candidates[i];
      if (typeof v === 'number' && isFinite(v)) return String(v);
      if (typeof v !== 'string' || !v || v === 'null' || v.length > 2000) continue;
      if (!/^https?:|^\//.test(v)) return v;
      try { return new URL(v, 'https://claude.ai/').searchParams.get('cursor') || ''; } catch (e) { return ''; }
    }
    return '';
  }

  pushHandlers['export.set'] = function (m) {
    folder = buildFolder(m.root, m.files);
  };
  pushHandlers['probe.identity'] = function (m) {
    probeIdentity(typeof m.probeId === 'string' ? m.probeId : '');
  };
  pushHandlers['probe.projects'] = function (m) {
    probeProjects(typeof m.probeId === 'string' ? m.probeId : '');
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
      if (flow === 'export') {
        if (!outRoot) outRoot = new OutDir('exports', '');
        return Promise.resolve(outRoot);
      }
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
      flow: flow,
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
      filesWritten: written.files,
      bytesWritten: written.bytes,
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
