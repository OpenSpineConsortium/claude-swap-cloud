// Tests of the extension's scaffold: protocol.js and the literal copies in
// the classic scripts, the page helper (alone and running the real
// project-import.js against the mock claude.ai), content.js, native.js,
// the service worker against a fake chrome, and the side panel's view model.
//
//   node --test tests/js/extension/scaffold.test.js        (Node 24)
//
// Nothing here opens a socket. The other owners' modules (gate, interrupt,
// config, log) are injected as fakes; when one of them is not on disk yet, a
// resolve hook gives background.js and sidepanel.js a stand-in to import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { register, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const EXT = path.join(ROOT, 'extension');
const SRC = path.join(EXT, 'src');
const BROWSER = path.join(ROOT, 'src', 'claude_swap', 'browser');
const IMPORTER = path.join(BROWSER, 'project-import.js');
const EXPORTER = path.join(BROWSER, 'project-export.js');
const require = createRequire(import.meta.url);
const { run: runScript, json, MemDir } = require('../harness');
const { makeServer, ORG_CHAT, CHANNEL } = require('../mock_claude_ai');

// ---------------------------------------------------------------- stand-ins
// Only used for a sibling module that does not exist on disk.
const STAND_INS = {
  './gate.js': 'export function createGate() { throw new Error("stand-in gate"); }',
  './interrupt.js': 'export function createInterrupts() { throw new Error("stand-in interrupts"); }\n' +
    'export function classifyResponse() { return { verdict: "pass" }; }\nexport function classifyPage() { return null; }\n' +
    'export function classifyIdentity() { return null; }\nexport function describe(kind) { return { what: kind, todo: "" }; }',
  './config.js': 'export const FIELDS = [];\nexport const LOG_LEVELS = ["debug","info","warn","error"];\nexport const DEFAULTS = {};\n' +
    'export function createConfigStore() { throw new Error("stand-in config"); }',
  './log.js': 'export function redact(v) { return v; }\nexport function createLogger() { throw new Error("stand-in logger"); }',
};
const hooks = `
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const STAND_INS = ${JSON.stringify(STAND_INS)};
export async function resolve(specifier, context, next) {
  if (STAND_INS[specifier] && context.parentURL && context.parentURL.startsWith('file:')) {
    const parent = fileURLToPath(context.parentURL);
    const target = path.join(path.dirname(parent), specifier);
    if (!fs.existsSync(target)) {
      return { url: 'data:text/javascript,' + encodeURIComponent(STAND_INS[specifier]), shortCircuit: true };
    }
  }
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

const protocol = await import(pathToFileURL(path.join(SRC, 'protocol.js')).href);
const nativeMod = await import(pathToFileURL(path.join(SRC, 'native.js')).href);
const backgroundMod = await import(pathToFileURL(path.join(SRC, 'background.js')).href);
const panelMod = await import(pathToFileURL(path.join(SRC, 'sidepanel.js')).href);

const PAGE_SRC = fs.readFileSync(path.join(SRC, 'page.js'), 'utf8').replace(/\r\n/g, '\n');
const CONTENT_SRC = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const IMPORTER_SRC = fs.readFileSync(IMPORTER, 'utf8').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------- small helpers

// A tick lets the timers phase run too: the sandbox turns the scripts' short
// waits into setTimeout(fn, 0), which a setImmediate round alone never reaches.
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function settle(rounds = 8) { for (let i = 0; i < rounds; i++) await tick(); }
async function until(fn, what = 'condition', rounds = 400) {
  for (let i = 0; i < rounds; i++) { if (fn()) return; await tick(); }
  throw new Error(`timed out waiting for ${what}`);
}

// A chrome.runtime.Port pair. Messages are JSON round-tripped and delivered
// on a microtask, as Chrome delivers them.
function makePortPair({ name = 'port', sender = null } = {}) {
  const ends = [];
  const make = peerIndex => {
    const end = { name, sender, connected: true, sent: [], listeners: { message: [], disconnect: [] } };
    end.onMessage = { addListener: fn => end.listeners.message.push(fn), removeListener: () => {} };
    end.onDisconnect = { addListener: fn => end.listeners.disconnect.push(fn), removeListener: () => {} };
    end.postMessage = msg => {
      if (!end.connected) throw new Error('Attempting to use a disconnected port object');
      const copy = JSON.parse(JSON.stringify(msg));
      end.sent.push(copy);
      const peer = ends[peerIndex];
      queueMicrotask(() => { if (peer.connected) for (const fn of [...peer.listeners.message]) fn(copy, peer); });
    };
    end.disconnect = () => {
      if (!end.connected) return;
      end.connected = false;
      const peer = ends[peerIndex];
      if (peer.connected) {
        peer.connected = false;
        queueMicrotask(() => { for (const fn of [...peer.listeners.disconnect]) fn(peer); });
      }
    };
    return end;
  };
  ends.push(make(1), make(0));
  return { client: ends[0], server: ends[1] };
}

// A clock with timers the test advances by hand.
function fakeTimers(start = 1_700_000_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    schedule: (fn, ms = 0) => { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms), fn, ms }); return id; },
    unschedule: id => { timers.delete(id); },
    pending: () => [...timers.values()].map(x => x.ms),
    async advance(ms) {
      const until = t + ms;
      for (let fired = 0; ; fired++) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= until).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        if (fired > 1000) throw new Error(`a timer keeps re-arming itself: ${JSON.stringify(due.slice(0, 3).map(([, x]) => x.ms))}`);
        const [id, x] = due[0];
        timers.delete(id);
        t = Math.max(t, x.at);
        try { x.fn(); } catch (e) { /* a timer's failure is its own */ }
        await settle(4);
      }
      t = until;
      await settle(4);
    },
    async runAll(limit = 50) { for (let i = 0; i < limit && timers.size; i++) await this.advance(Math.max(0, Math.min(...[...timers.values()].map(x => x.at)) - t)); },
  };
}

// The literal is evaluated in a throwaway context and brought back through
// JSON, so that it compares as a plain array of this realm.
const readSource = (src, name) => {
  const m = src.match(new RegExp(`var ${name} = (\\[[\\s\\S]*?\\]);`));
  assert.ok(m, `${name} not found`);
  return JSON.parse(JSON.stringify(vm.runInNewContext(m[1])));
};

// ================================================================ protocol and copies

test('protocol.js: the names and lists every module agrees on', () => {
  assert.equal(protocol.HOST_NAME, 'com.claude_swap.bridge');
  assert.equal(protocol.PROTOCOL, 1);
  assert.equal(protocol.WORLD, 'USER_SCRIPT');
  assert.equal(protocol.CHUNK_BYTES, 512 * 1024);
  assert.deepEqual(protocol.PORTS, { page: 'cswap-page', content: 'cswap-content', panel: 'cswap-panel' });
  assert.deepEqual(Object.values(protocol.KEYS).sort(), ['cswap.bridge', 'cswap.config', 'cswap.export', 'cswap.gate', 'cswap.instance', 'cswap.interrupt', 'cswap.job', 'cswap.log']);
  assert.deepEqual(protocol.HEADER_ALLOWLIST, ['retry-after', 'content-type', 'content-length', 'cf-mitigated', 'cf-ray', 'server', 'server-timing', 'location', 'date']);
  assert.equal(protocol.LOGIN_PATH_RE.source, '^\\/(login|magic-link|oauth|auth)(\\/|$)');
  assert.ok(protocol.LOGIN_PATH_RE.test('/login/'));
  assert.ok(!protocol.LOGIN_PATH_RE.test('/loginx'));
  assert.deepEqual(protocol.RECONNECT_BACKOFF_MS, [0, 1000, 2000, 5000, 5000]);
  for (const m of ['cf-chl-', 'cf_chl_opt', 'error code: 1020', 'error code: 1015', 'you are being rate limited', '<title>just a moment']) {
    assert.ok(protocol.BODY_MARKERS.includes(m), m);
  }
});

test('page.js and content.js carry literal copies equal to protocol.js', () => {
  assert.deepEqual(readSource(PAGE_SRC, 'BODY_MARKERS'), [...protocol.BODY_MARKERS]);
  assert.deepEqual(readSource(PAGE_SRC, 'HEADER_ALLOWLIST'), [...protocol.HEADER_ALLOWLIST]);
  assert.deepEqual(readSource(PAGE_SRC, 'ACCOUNT_ENDPOINTS'), [...protocol.ACCOUNT_ENDPOINTS]);
  assert.deepEqual(readSource(PAGE_SRC, 'RECONNECT_BACKOFF_MS'), [...protocol.RECONNECT_BACKOFF_MS]);
  assert.deepEqual(readSource(CONTENT_SRC, 'PAGE_MARKER_SELECTORS'), [...protocol.PAGE_MARKER_SELECTORS]);
  assert.deepEqual(readSource(CONTENT_SRC, 'RECONNECT_BACKOFF_MS'), [...protocol.RECONNECT_BACKOFF_MS]);
  assert.ok(PAGE_SRC.includes(`var PORT_NAME = '${protocol.PORTS.page}';`));
  assert.ok(CONTENT_SRC.includes(`var PORT_NAME = '${protocol.PORTS.content}';`));
  assert.ok(PAGE_SRC.includes(`var IMPORTER_ID = '${protocol.IMPORTER_ID}';`));
  assert.ok(CONTENT_SRC.includes(`var IMPORTER_ID = '${protocol.IMPORTER_ID}';`));
  assert.ok(PAGE_SRC.includes(`var ORGS_ENDPOINT = '${protocol.ORGS_ENDPOINT}';`));
  const creates = PAGE_SRC.match(/var CREATE_PATH_RES = \[(.*)\];/)[1].split(', ').map(s => vm.runInNewContext(s).source);
  assert.deepEqual(creates, [...protocol.CREATE_PATH_RE_SOURCES]);
  // The interrupt module, when present, must agree too.
  const interruptPath = path.join(SRC, 'interrupt.js');
  if (fs.existsSync(interruptPath)) {
    const text = fs.readFileSync(interruptPath, 'utf8');
    for (const m of protocol.BODY_MARKERS) assert.ok(text.includes(`'${m}'`), `interrupt.js lacks marker ${m}`);
  }
});

test('the classic scripts never touch the sign-in and never randomize', () => {
  assert.ok(!PAGE_SRC.includes('cookie'));
  assert.ok(!PAGE_SRC.includes('Math.random'));
  assert.ok(!CONTENT_SRC.includes('cookie'));
  assert.ok(!CONTENT_SRC.includes('fetch('));
  assert.ok(!/\bchrome\.cookies\b/.test(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8')));
  for (const f of fs.readdirSync(SRC)) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.ok(!/[^\x00-\x7f]/.test(text), `${f} is not plain ASCII`);
    assert.ok(!text.includes('\r'), `${f} has CRLF`);
  }
});

test('manifest: permissions, world, key and the pinned id', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['nativeMessaging', 'userScripts', 'storage', 'sidePanel', 'alarms', 'notifications']);
  assert.deepEqual(manifest.host_permissions, ['https://claude.ai/*']);
  assert.equal(manifest.background.service_worker, 'src/background.js');
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.content_scripts[0].js[0], 'src/content.js');
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert.ok(fs.existsSync(path.join(EXT, 'icons', '128.png')));
  const der = Buffer.from(manifest.key, 'base64');
  const id = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
  assert.match(id, /^[a-p]{32}$/);
  const readme = fs.readFileSync(path.join(EXT, 'README.md'), 'utf8');
  assert.ok(readme.includes(id), 'README names the pinned id');
  assert.equal(JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8')).type, 'module');
  const html = fs.readFileSync(path.join(EXT, 'sidepanel.html'), 'utf8');
  assert.ok(!/<script(?![^>]*src=)/.test(html), 'no inline script');
  assert.ok(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no external resource');
});

// ================================================================ the page helper harness

const COOKIE = `theme=dark; lastActiveOrg=${ORG_CHAT}; other=1`;

// A DOM just big enough for the import script and the helper's observer:
// every change of text, disabled, href or style tells the observers.
function makeDom() {
  const observers = new Set();
  let scheduled = false;
  const notify = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; for (const o of observers) o.cb([]); });
  };
  class MutationObserver {
    constructor(cb) { this.cb = cb; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const elements = [];
  function makeElement(tag) {
    let text = '';
    let disabled = false;
    let href = '';
    const el = {
      tagName: String(tag).toUpperCase(), children: [], listeners: {}, id: '', download: '', files: [], parent: null,
      style: new Proxy({}, { set(o, k, v) { o[k] = v; notify(); return true; } }),
      get textContent() { return text; }, set textContent(v) { text = String(v); notify(); },
      get disabled() { return disabled; }, set disabled(v) { disabled = !!v; notify(); },
      get href() { return href; }, set href(v) { href = String(v); notify(); },
      append(...kids) { for (const k of kids) { k.parent = el; el.children.push(k); } notify(); },
      appendChild(kid) { kid.parent = el; el.children.push(kid); notify(); return kid; },
      remove() { if (el.parent) { el.parent.children = el.parent.children.filter(k => k !== el); notify(); } },
      setAttribute(k, v) { el[k] = v; notify(); },
      addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
      dispatchEvent(event) { for (const fn of el.listeners[event.type] || []) fn(event); return true; },
      click() { el.clicks = (el.clicks || 0) + 1; for (const fn of el.listeners.click || []) fn({ type: 'click', preventDefault() {} }); },
    };
    elements.push(el);
    return el;
  }
  const body = makeElement('body');
  const find = (node, id) => {
    if (node.id === id) return node;
    for (const k of node.children) { const got = find(k, id); if (got) return got; }
    return null;
  };
  const document = {
    cookie: COOKIE, body, title: 'Claude',
    getElementById: id => find(body, id),
    createElement: tag => makeElement(tag),
  };
  return { document, MutationObserver, elements, body, makeElement };
}

// A sandbox like tests/js/harness.js's, plus the port and the boot the
// helper needs. `server` answers the fetches; `worker` is the fake service
// worker that answers the port.
function makePageSandbox({ server, worker, boot, withChrome = false, schedule, now } = {}) {
  const origin = 'https://claude.ai';
  const dom = makeDom();
  const logs = [];
  const requests = [];
  const sleeps = [];
  const record = level => (...args) => logs.push({ level, text: args.map(a => (typeof a === 'string' ? a : a && a.message ? `${a.name}: ${a.message}` : JSON.stringify(a))).join(' ') });
  const consoleMock = { log: record('log'), info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug'), table: v => logs.push({ level: 'table', text: JSON.stringify(v) }) };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input), origin);
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = String(v);
    requests.push({ method: (init.method || 'GET').toUpperCase(), path: url.pathname + url.search, headers, signal: init.signal, body: typeof init.body === 'string' ? init.body : init.body ? '(form data)' : undefined });
    if (init.signal && init.signal.aborted) throw new DOMException('aborted', 'AbortError');
    return server(url, headers, init);
  };
  const fastTimeout = (fn, ms = 0, ...args) => {
    if (ms >= 20000) return setTimeout(fn, ms, ...args);
    if (ms > 0) sleeps.push(ms);
    return setTimeout(fn, 0, ...args);
  };
  const windowMock = { location: { origin, pathname: '/new', href: `${origin}/new`, search: '' } };
  const sandbox = {
    console: consoleMock, fetch: fetchImpl, document: dom.document, window: windowMock,
    location: windowMock.location, performance: { getEntriesByType: () => [] },
    prompt: () => null, confirm: () => true, alert: () => {},
    setTimeout: fastTimeout, clearTimeout, Blob, File, FormData, URL, URLSearchParams, AbortController, AbortSignal,
    Headers, Response, Request, TextEncoder, TextDecoder, encodeURIComponent, decodeURIComponent, atob, btoa, DOMException,
    MutationObserver: dom.MutationObserver,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  Object.assign(windowMock, { document: dom.document, fetch: fetchImpl, confirm: sandbox.confirm, prompt: sandbox.prompt, console: consoleMock });
  const connections = [];
  const connect = () => {
    const pair = makePortPair({ name: 'cswap-page' });
    connections.push(pair);
    if (worker) worker.onConnect(pair.server);
    return pair.client;
  };
  if (withChrome) {
    sandbox.chrome = { runtime: { connect: () => connect() } };
    sandbox.__cswapBoot = boot;
  }
  vm.createContext(sandbox);
  vm.runInContext(PAGE_SRC, sandbox, { filename: 'page.js' });
  const env = {
    globals: sandbox, win: windowMock, doc: dom.document, boot, connect, now: now || Date.now,
    fetchImpl, schedule: schedule || fastTimeout, unschedule: clearTimeout, MutationObserver: dom.MutationObserver,
  };
  return {
    sandbox, dom, logs, requests, sleeps, env, connections, fetchImpl,
    create: () => sandbox.createPageHelper(env),
    runImporter: () => vm.runInContext(IMPORTER_SRC, sandbox, { filename: 'project-import.js' }),
    button: () => dom.elements.find(e => e.tagName === 'BUTTON'),
    statusText: () => { const d = dom.elements.filter(e => e.tagName === 'DIV'); return d[1] ? d[1].textContent : ''; },
  };
}

const BOOT = { jobId: 'job_20261005T141503_a1b2c3', nonce: 'n-1', name: '', expected: { email: 'b@example.com', orgUuid: ORG_CHAT },
  bodyMarkers: [...protocol.BODY_MARKERS], accountEndpoints: [...protocol.ACCOUNT_ENDPOINTS], requestTimeoutMs: 120000 };

// The fake service worker behind the page port: a serial gate that grants
// at once, scripted verdicts, a lazy folder served from `tree`, and the
// person's acts (resume, retry, giveUp, cancel) on a held request.
function makeScriptedWorker({ tree = {}, root = 'export', verdictFor = () => ({ action: 'pass' }), attachReply = null, chunk = 512 * 1024 } = {}) {
  const w = {
    ports: [], attaches: [], permits: [], reports: [], events: [], identities: [], fileReads: [], granted: 0,
    inFlight: false, queue: [], held: null, cancelled: false, phase: 'running', permitSeq: 0,
    done: null, resolveDone: null, port: null,
  };
  w.done = new Promise(resolve => { w.resolveDone = resolve; });
  const byRequestId = new Map();
  const grant = (port, msg) => {
    byRequestId.set(msg.requestId, true);
    w.inFlight = true;
    w.granted++;
    const permit = msg.retryOf ? msg.retryOf : `p${++w.permitSeq}`;
    const attempt = msg.retryOf ? (w.held ? w.held.attempt + 1 : 2) : 1;
    port.postMessage({ re: msg.id, ok: true, permit, attempt, seq: w.granted, waitedMs: 0 });
  };
  const next = () => {
    if (w.inFlight || w.cancelled) return;
    const entry = w.queue.shift();
    if (entry) grant(entry.port, entry.msg);
  };
  w.release = reply => {
    const held = w.held;
    w.held = null;
    if (!held) return;
    if (reply.ok) { w.inFlight = true; w.granted++; held.port.postMessage({ re: held.msg.id, ok: true, permit: held.msg.retryOf, attempt: held.attempt + 1, seq: w.granted, waitedMs: 0 }); }
    else { held.port.postMessage({ re: held.msg.id, ...reply }); next(); }
  };
  w.resume = () => w.release({ ok: true });
  w.retry = () => w.release({ ok: true });
  w.giveUp = () => w.release({ ok: false, reason: 'give-up' });
  w.cancel = () => { w.cancelled = true; if (w.held) w.release({ ok: false, reason: 'cancelled' }); for (const e of w.queue) e.port.postMessage({ re: e.msg.id, ok: false, reason: 'cancelled' }); w.queue = []; if (w.port) w.port.postMessage({ type: 'cancel' }); };
  w.push = msg => w.port.postMessage(msg);
  w.onConnect = port => {
    w.ports.push(port);
    w.port = port;
    port.onMessage.addListener(msg => {
      if (msg.type === 'page.attach') {
        w.attaches.push(msg);
        port.postMessage(attachReply || { re: msg.id, ok: true, phase: w.phase, cancelled: false });
        return;
      }
      if (msg.type === 'export.list') { port.postMessage({ re: msg.id, ok: true, root, files: Object.entries(tree).map(([p, b]) => ({ path: p, bytes: b.length })) }); return; }
      if (msg.type === 'file.read') {
        w.fileReads.push(msg.path);
        const bytes = tree[msg.path];
        if (bytes === undefined) { port.postMessage({ re: msg.id, ok: false, reason: 'not-found' }); return; }
        if (!bytes.length) { port.postMessage({ re: msg.id, part: 0, last: true, offset: 0, data: '' }); return; }
        for (let at = 0, n = 0; at < bytes.length; at += chunk, n++) {
          port.postMessage({ re: msg.id, part: n, last: at + chunk >= bytes.length, offset: at, data: Buffer.from(bytes.subarray(at, at + chunk)).toString('base64') });
        }
        return;
      }
      if (msg.type === 'gate.permit') {
        w.permits.push(msg);
        if (w.cancelled) { port.postMessage({ re: msg.id, ok: false, reason: 'cancelled' }); return; }
        if (msg.retryOf) { w.held = { port, msg, attempt: (w.held && w.held.attempt) || 1 }; w.inFlight = false; return; }
        w.queue.push({ port, msg });
        next();
        return;
      }
      if (msg.type === 'gate.report') {
        w.reports.push(msg);
        const verdict = verdictFor(msg, w) || { action: 'pass' };
        w.inFlight = false;
        if (verdict.action === 'hold') w.held = { port, msg: null, attempt: 1 };
        port.postMessage({ re: msg.id, ok: true, ...verdict });
        if (verdict.action !== 'hold') next();
        return;
      }
      if (msg.type === 'identity.result') { w.identities.push(msg.identity); port.postMessage({ re: msg.id, ok: true }); return; }
      if (msg.type === 'script.event') {
        w.events.push(msg);
        port.postMessage({ re: msg.id, ok: true });
        if (msg.kind === 'done' || msg.kind === 'failed') w.resolveDone(msg);
        return;
      }
      port.postMessage({ re: msg.id, ok: false, reason: 'unknown-type' });
    });
  };
  return w;
}

// ================================================================ the page helper

test('page helper: installs once, validates its boot, exposes only a frozen state()', async () => {
  const w = makeScriptedWorker();
  const sb = makePageSandbox({ server: makeServer().server, worker: w, boot: BOOT });
  const helper = sb.create();
  assert.ok(Object.isFrozen(helper));
  assert.deepEqual(Object.keys(helper).sort(), ['state', 'version']);
  assert.equal(sb.sandbox.__cswapImport, helper);
  assert.equal(sb.create(), helper, 'a second install returns the first');
  await settle();
  assert.equal(w.attaches.length, 1);
  assert.equal(w.attaches[0].nonce, 'n-1');
  assert.equal(w.attaches[0].jobId, BOOT.jobId);
  assert.deepEqual(w.attaches[0].pending, []);
  assert.equal(helper.state().attached, true);
  for (const bad of [{}, { jobId: 'j' }, { nonce: 'n' }, null]) {
    const other = makePageSandbox({ server: makeServer().server, worker: makeScriptedWorker(), boot: bad });
    assert.throws(() => other.create(), /cswap page helper/);
  }
});

test('page helper: the production wiring reads and deletes the boot object', async () => {
  const w = makeScriptedWorker();
  const sb = makePageSandbox({ server: makeServer().server, worker: w, boot: { ...BOOT }, withChrome: true });
  assert.equal(sb.sandbox.__cswapBoot, undefined, 'boot deleted');
  assert.ok(sb.sandbox.__cswapImport);
  await settle();
  assert.equal(w.attaches.length, 1);
  assert.equal(w.attaches[0].nonce, 'n-1');
  assert.equal(typeof sb.sandbox.fetch, 'function');
  assert.notEqual(sb.sandbox.fetch, sb.fetchImpl, 'fetch is wrapped');
});

test('page helper: a refused attach detaches the page for good', async () => {
  const w = makeScriptedWorker({ attachReply: null });
  w.onConnect = (orig => port => { orig(port); })(w.onConnect);
  const sb = makePageSandbox({ server: makeServer().server, boot: BOOT, worker: { onConnect: port => {
    port.onMessage.addListener(msg => { if (msg.type === 'page.attach') port.postMessage({ re: msg.id, ok: false, reason: 'bad-nonce' }); });
  } } });
  const helper = sb.create();
  await settle();
  assert.equal(helper.state().detached, true);
  assert.equal(helper.state().detachedBecause, 'bad-nonce');
  await assert.rejects(sb.sandbox.fetch('/api/organizations'), e => e.name === 'AbortError' && /no longer attached/.test(e.message));
  assert.equal(sb.requests.length, 0, 'nothing was sent');
});

test('page helper: the lazy folder reads a file from the worker only when the script asks', async () => {
  const big = Buffer.alloc(1300);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) & 0xff;
  const tree = { 'export.json': Buffer.from('{"format":"claude-project-export"}'), 'Files/a/b.bin': big, 'empty.txt': Buffer.alloc(0) };
  const w = makeScriptedWorker({ tree, root: 'beethoven', chunk: 500 });
  const sb = makePageSandbox({ server: makeServer().server, worker: w, boot: BOOT });
  const helper = sb.create();
  await settle();
  await assert.rejects(sb.sandbox.showDirectoryPicker(), e => e.name === 'AbortError', 'no folder before export.set');
  w.push({ type: 'export.set', root: 'beethoven', files: Object.entries(tree).map(([p, b]) => ({ path: p, bytes: b.length })) });
  await settle();
  const dir = await sb.sandbox.showDirectoryPicker({ mode: 'read' });
  assert.equal(dir.kind, 'directory');
  assert.equal(dir.name, 'beethoven');
  assert.equal(helper.state().pickerCalls, 2, 'the refused call counts too');
  assert.equal(w.fileReads.length, 0, 'nothing read yet');
  const manifest = await (await dir.getFileHandle('export.json')).getFile();
  assert.equal(await manifest.text(), '{"format":"claude-project-export"}');
  assert.equal(manifest.name, 'export.json');
  assert.equal(manifest.lastModified, 0);
  assert.deepEqual(w.fileReads, ['export.json']);
  const sub = await (await dir.getDirectoryHandle('Files')).getDirectoryHandle('a');
  const blob = await (await sub.getFileHandle('b.bin')).getFile();
  assert.equal(Buffer.compare(Buffer.from(await blob.arrayBuffer()), big), 0, 'three chunks reassembled byte for byte');
  assert.equal(blob.type, '');
  const empty = await (await dir.getFileHandle('empty.txt')).getFile();
  assert.equal(empty.size, 0);
  assert.deepEqual(w.fileReads, ['export.json', 'Files/a/b.bin', 'empty.txt'], 'one read per getFile, nothing cached');
  await (await dir.getFileHandle('export.json')).getFile();
  assert.equal(w.fileReads.length, 4);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b']) await assert.rejects(dir.getFileHandle(bad), e => e.name === 'TypeError', bad);
  await assert.rejects(dir.getFileHandle('nope'), e => e.name === 'NotFoundError');
  await assert.rejects(dir.getFileHandle('Files'), e => e.name === 'TypeMismatchError');
  await assert.rejects(dir.getDirectoryHandle('export.json'), e => e.name === 'TypeMismatchError');
  await assert.rejects((await dir.getFileHandle('export.json')).createWritable(), e => e.name === 'NotAllowedError');
  const names = [];
  for await (const h of dir.values()) names.push(`${h.kind}:${h.name}`);
  assert.deepEqual(names.sort(), ['directory:Files', 'file:empty.txt', 'file:export.json']);
  const keys = [];
  for await (const k of dir.keys()) keys.push(k);
  assert.deepEqual(keys.sort(), ['Files', 'empty.txt', 'export.json']);
});

test('page helper: a stream that restarts at offset 0 and a missing file', async () => {
  const bytes = Buffer.from('0123456789');
  let restarted = false;
  const worker = { onConnect: port => port.onMessage.addListener(msg => {
    if (msg.type === 'page.attach') { port.postMessage({ re: msg.id, ok: true, phase: 'running' }); return; }
    if (msg.type === 'file.read' && msg.path === 'f.txt') {
      port.postMessage({ re: msg.id, part: 0, last: false, offset: 0, data: Buffer.from('01234').toString('base64') });
      if (!restarted) { restarted = true; port.postMessage({ re: msg.id, part: 1, last: false, offset: 0, data: Buffer.from('01234').toString('base64') }); }
      port.postMessage({ re: msg.id, part: 2, last: true, offset: 5, data: Buffer.from('56789').toString('base64') });
      return;
    }
    if (msg.type === 'file.read') { port.postMessage({ re: msg.id, ok: false, reason: 'not-found' }); return; }
    port.postMessage({ re: msg.id, ok: true });
  }) };
  const sb = makePageSandbox({ server: makeServer().server, worker, boot: BOOT });
  sb.create();
  await settle();
  sb.connections[0].server.postMessage({ type: 'export.set', root: 'r', files: [{ path: 'f.txt', bytes: 10 }, { path: 'gone.txt', bytes: 1 }] });
  await settle();
  const dir = await sb.sandbox.showDirectoryPicker();
  const file = await (await dir.getFileHandle('f.txt')).getFile();
  assert.equal(await file.text(), bytes.toString());
  await assert.rejects((await dir.getFileHandle('gone.txt')).getFile(), e => e.name === 'NotFoundError');
});

test('page helper: prompt() answers the three questions and reports each', async () => {
  for (const [name, expectName] of [['', 'beethoven (imported)'], ['Given Name', 'Given Name']]) {
    const w = makeScriptedWorker();
    const sb = makePageSandbox({ server: makeServer().server, worker: w, boot: { ...BOOT, name } });
    sb.create();
    await settle();
    const p = sb.sandbox.prompt;
    assert.equal(p('Which organization should the new project be created in?\n\n1. Work\n2. Personal\n\nEnter a number:', '2'), '2');
    assert.equal(p('This folder holds 2 exports. Which one should be imported?\n\n1. a\n2. b\n\nEnter a number:', '1'), '1');
    assert.equal(p('Import \u201cbeethoven\u201d as a NEW Claude Code project?\n\nNote: the project this was exported from can be seen from this login. To copy it...\n\nName for the new project (Cancel stops here):', 'beethoven (imported)'), expectName);
    assert.equal(p('Something else?', 'x'), 'x');
    assert.equal(p('Something else?'), null);
    assert.equal(sb.sandbox.confirm('ok?'), true);
    assert.equal(sb.sandbox.alert('hi'), undefined);
    assert.equal(sb.sandbox.window.prompt, p, 'installed on window too');
    await settle();
    const prompts = w.events.filter(e => e.kind === 'prompt');
    assert.deepEqual(prompts.map(e => [e.promptKind, e.answer, e.sourceVisible]), [
      ['org', '2', false], ['which', '1', false], ['name', expectName, true], ['other', 'x', false], ['other', null, false],
    ]);
    assert.ok(prompts[2].question.startsWith('Import '));
  }
});

test('page helper: only same-origin /api/ and /v1/ requests are gated', async () => {
  const w = makeScriptedWorker();
  const hits = [];
  const sb = makePageSandbox({ server: async url => { hits.push(url.href); return json(200, { ok: 1 }); }, worker: w, boot: BOOT });
  sb.create();
  await settle();
  await sb.sandbox.fetch('/api/organizations');
  await sb.sandbox.fetch('https://claude.ai/v1/code/channels?scope=joined');
  await sb.sandbox.fetch('/static/app.js');
  await sb.sandbox.fetch('https://other.example/api/x');
  await sb.sandbox.fetch(new URL('https://claude.ai/api/y'));
  await settle();
  assert.deepEqual(w.permits.map(p => `${p.method} ${p.path} ${p.kind}`), ['GET /api/organizations script', 'GET /v1/code/channels script', 'GET /api/y script']);
  assert.equal(w.permits[1].stepKey, 'GET /v1/code/channels?scope=joined ');
  assert.equal(hits.length, 5, 'every request was performed by the page');
  assert.deepEqual(w.reports.map(r => r.status), [200, 200, 200]);
  assert.deepEqual(w.permits.map(p => p.requestId), ['r1', 'r2', 'r3']);
  assert.ok(!('retryOf' in w.permits[0]));
});

test('page helper: step keys and body sizes for JSON and form bodies', async () => {
  const w = makeScriptedWorker();
  const sb = makePageSandbox({ server: async () => json(200, {}), worker: w, boot: BOOT });
  sb.create();
  await settle();
  const body = JSON.stringify({ name: 'x' });
  await sb.sandbox.fetch('/api/a', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
  await sb.sandbox.fetch('/api/a', { method: 'POST', body });
  const form = new sb.sandbox.FormData();
  form.append('file', new sb.sandbox.File([Buffer.alloc(2048)], 'big.bin'), 'big.bin');
  await sb.sandbox.fetch('/api/up', { method: 'POST', body: form });
  await settle();
  assert.equal(w.permits[0].stepKey, w.permits[1].stepKey, 'the same body gives the same key');
  assert.match(w.permits[0].stepKey, /^POST \/api\/a json:[0-9a-f]{8}$/);
  assert.equal(w.permits[0].bodyBytes, body.length);
  assert.equal(w.permits[2].stepKey, 'POST /api/up form:big.bin:2048');
  assert.equal(w.permits[2].bodyBytes, 2048);
});

test('page helper: hold then Resume performs the request once more; Give up hands back the parked answer', async () => {
  let n = 0;
  const server = async () => (++n === 1 ? json(503, { error: { message: 'down' } }) : json(200, { fine: true }));
  const w = makeScriptedWorker({ verdictFor: rep => (rep.status === 503 ? { action: 'hold', reason: 'failed-step' } : { action: 'pass' }) });
  const sb = makePageSandbox({ server, worker: w, boot: BOOT });
  sb.create();
  await settle();
  const p = sb.sandbox.fetch('/api/thing', { method: 'PUT', body: '{"a":1}' });
  await until(() => w.held && w.held.msg, 'the re-ask');
  assert.equal(w.permits.length, 2);
  assert.equal(w.permits[1].retryOf, 'p1');
  assert.equal(w.permits[1].requestId, 'r2');
  assert.equal(w.permits[1].stepKey, w.permits[0].stepKey);
  assert.equal(sb.requests.length, 1, 'nothing re-sent on its own');
  w.resume();
  const r = await p;
  assert.equal(r.status, 200);
  assert.equal(sb.requests.length, 2);
  assert.equal(await r.json().then(j => j.fine), true);
  assert.equal(w.reports.length, 2);
  // Give up: the parked 503 is what the script gets.
  n = 0;
  const p2 = sb.sandbox.fetch('/api/thing', { method: 'PUT', body: '{"a":1}' });
  await until(() => w.held && w.held.msg, 'the second re-ask');
  w.giveUp();
  const r2 = await p2;
  assert.equal(r2.status, 503);
  assert.equal((await r2.json()).error.message, 'down', 'the parked body is intact');
});

test('page helper: a refused permit becomes a plain error the script can record', async () => {
  const worker = { onConnect: port => port.onMessage.addListener(msg => {
    if (msg.type === 'page.attach') { port.postMessage({ re: msg.id, ok: true, phase: 'running' }); return; }
    if (msg.type === 'gate.permit') { port.postMessage({ re: msg.id, ok: false, reason: msg.path === '/api/a' ? 'wrong-phase' : 'no-job' }); return; }
    port.postMessage({ re: msg.id, ok: true });
  }) };
  const sb = makePageSandbox({ server: async () => json(200, {}), worker, boot: BOOT });
  sb.create();
  await settle();
  await assert.rejects(sb.sandbox.fetch('/api/a', { method: 'POST' }), e => e.name === 'TypeError' && /second request to create/.test(e.message));
  await assert.rejects(sb.sandbox.fetch('/api/b'), /no import job/);
  assert.equal(sb.requests.length, 0);
});

test('page helper: cancel aborts what is in flight, refuses what follows, and the hold loop ends', async () => {
  let release;
  const server = (url, headers, init) => new Promise((resolve, reject) => {
    release = () => resolve(json(200, {}));
    init.signal.addEventListener('abort', () => reject(init.signal.reason || new DOMException('aborted', 'AbortError')));
  });
  const w = makeScriptedWorker();
  const sb = makePageSandbox({ server, worker: w, boot: BOOT });
  const helper = sb.create();
  await settle();
  const p = sb.sandbox.fetch('/api/slow');
  await until(() => sb.requests.length === 1, 'the request');
  w.cancel();
  await assert.rejects(p, e => e.name === 'AbortError' && /cancelled from the cswap panel/.test(e.message));
  assert.equal(helper.state().cancelled, true);
  await assert.rejects(sb.sandbox.fetch('/api/next'), e => e.name === 'AbortError');
  assert.equal(sb.requests.length, 1, 'nothing more was sent');
});

test('page helper: the script\'s own signal is never passed through; the wrapper has its own timeout', async () => {
  const timers = [];
  const schedule = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const seen = [];
  const server = (url, headers, init) => new Promise((resolve, reject) => {
    seen.push(init.signal);
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  const w = makeScriptedWorker();
  const sb = makePageSandbox({ server, worker: w, boot: BOOT, schedule });
  sb.create();
  await settle();
  const ctrl = new sb.sandbox.AbortController();
  const form = new sb.sandbox.FormData();
  form.append('file', new sb.sandbox.File([Buffer.alloc(3 * 1048576)], 'f.bin'), 'f.bin');
  const p = sb.sandbox.fetch('/api/up', { method: 'POST', body: form, signal: ctrl.signal });
  await until(() => seen.length === 1, 'the request');
  ctrl.abort();
  await settle();
  assert.equal(seen[0].aborted, false, 'the script\'s abort did not reach the request');
  const timeout = timers.find(t => t.ms >= 120000);
  assert.equal(timeout.ms, 120000 + 4000 * 3, '120 s plus 4 s per MiB');
  timeout.fn();
  await assert.rejects(p, e => e.name === 'AbortError' && /no reply within 132 seconds/.test(e.message));
  await settle();
  assert.equal(w.reports.length, 1);
  assert.equal(w.reports[0].status, 0);
  assert.equal(w.reports[0].error.name, 'AbortError');
  assert.match(w.reports[0].error.message, /no reply within/);
});

test('page helper: what a report says about a response', async () => {
  const w = makeScriptedWorker();
  const responses = {
    '/api/challenge': () => new Response('<html><head><title>Just a moment...</title></head><body>cf_chl_opt sk-ant-api03-SECRETSECRETSECRET and more text ' + 'x'.repeat(400) + '</body></html>',
      { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'cf-mitigated': 'challenge', 'cf-ray': 'abc-FRA', 'set-cookie': 'cf_clearance=zzz', authorization: 'Bearer nope', location: 'https://claude.ai/login?next=%2Fnew' } }),
    '/api/json403': () => json(403, { error: { type: 'permission_error', reason: 'nope', message: 'Permission denied ' + 'y'.repeat(300) } }),
    '/api/binary': () => new Response(Buffer.from([0xff, 0xfe, 0x00, 0x80]), { status: 500, headers: { 'content-type': 'text/html' } }),
    '/api/noheaders': () => new Response(null, { status: 204 }),
    '/api/ok': () => json(200, { secret: 'sk-ant-api03-SHOULDNOTBEREAD' }),
    '/v1/code/channels': () => json(200, { channel: { id: 'chan_01NEW', name: 'x' } }),
    [`/api/organizations/${ORG_CHAT}/projects`]: () => json(201, { uuid: 'aaaaaaaa-0000-4000-8000-00000000000a', name: 'y' }),
  };
  const sb = makePageSandbox({ server: async url => responses[url.pathname](), worker: w, boot: BOOT });
  sb.create();
  await settle();
  const r = await sb.sandbox.fetch('/api/challenge');
  assert.equal(r.status, 403);
  assert.equal(await r.text().then(t => t.includes('cf_chl_opt')), true, 'the original body is still readable');
  await sb.sandbox.fetch('/api/json403');
  await sb.sandbox.fetch('/api/binary');
  await sb.sandbox.fetch('/api/noheaders');
  const ok = await sb.sandbox.fetch('/api/ok');
  assert.equal(ok.bodyUsed, false, 'a 2xx body is not read');
  await sb.sandbox.fetch('/v1/code/channels', { method: 'POST', body: JSON.stringify({ name: 'New One', visibility: 'private' }) });
  await sb.sandbox.fetch(`/api/organizations/${ORG_CHAT}/projects`, { method: 'POST', body: JSON.stringify({ name: 'Std' }) });
  await sb.sandbox.fetch('/v1/code/channels', { method: 'GET' });
  await settle();
  const [chal, j403, bin, noh, fine, create, std, list] = w.reports;
  assert.equal(chal.status, 403);
  assert.deepEqual(Object.keys(chal.headers).sort(), ['cf-mitigated', 'cf-ray', 'content-type', 'location']);
  assert.equal(chal.headers['cf-mitigated'], 'challenge');
  assert.equal(chal.headers.location, '/login', 'location reduced to its path');
  assert.ok(chal.markers.includes('cf_chl_opt') && chal.markers.includes('<title>just a moment'));
  assert.ok(chal.bodyExcerpt.length <= 200);
  assert.ok(!chal.bodyExcerpt.includes('SECRETSECRET') && chal.bodyExcerpt.includes('[redacted]'));
  assert.ok(!JSON.stringify(chal).includes('cf_clearance=zzz'));
  assert.ok(!JSON.stringify(chal).includes('nope'));
  assert.equal(j403.bodyJson.error.type, 'permission_error');
  assert.equal(j403.bodyJson.error.reason, 'nope');
  assert.equal(j403.bodyJson.error.message.length, 200);
  assert.deepEqual(bin.markers, []);
  assert.equal(bin.status, 500);
  assert.equal(noh.status, 204);
  assert.deepEqual(noh.headers, {});
  assert.equal(fine.status, 200);
  assert.equal(fine.bodyExcerpt, undefined);
  assert.deepEqual(create.created, { id: 'chan_01NEW', url: 'https://claude.ai/code/project/chan_01NEW', name: 'New One' });
  assert.deepEqual(std.created, { id: 'aaaaaaaa-0000-4000-8000-00000000000a', url: 'https://claude.ai/project/aaaaaaaa-0000-4000-8000-00000000000a', name: 'Std' });
  assert.equal(list.created, undefined, 'a GET on the create path is not a create');
  assert.ok(!JSON.stringify(w.reports).includes('SHOULDNOTBEREAD'));
});

test('page helper: watches the script\'s UI and forwards its console', async () => {
  const w = makeScriptedWorker();
  const sb = makePageSandbox({ server: async () => json(200, {}), worker: w, boot: BOOT });
  const helper = sb.create();
  await settle();
  const { document } = sb.dom;
  const wrap = document.createElement('div');
  wrap.id = 'claude-simple-importer';
  const status = document.createElement('div');
  const link = document.createElement('a');
  link.style.display = 'none';
  const btn = document.createElement('button');
  btn.textContent = 'Import Claude Project';
  wrap.append(status, link, btn);
  document.body.appendChild(wrap);
  await settle();
  assert.deepEqual(w.events.map(e => e.kind), ['ready', 'status'], 'the first look is itself a status');
  assert.equal(w.events[1].button, 'Import Claude Project');
  assert.equal(helper.state().ready, true);
  status.textContent = 'Adding file 1/2: a';
  await settle();
  assert.equal(w.events.filter(e => e.kind === 'status').pop().text, 'Adding file 1/2: a');
  sb.sandbox.console.log('Claude importer:', 'Creating the project');
  sb.sandbox.console.warn('not ours');
  sb.sandbox.console.error('Claude importer failed:', new Error('boom sk-ant-api03-ABCDEFGHIJKLMNOP'));
  sb.sandbox.console.log('Claude importer: everything that was done:', [{ group: 'project', item: 'Project', result: 'created', detail: 'New' }, { group: 'file', item: 'a', result: 'added', detail: '', extra: 1 }, { group: 'setting', item: 'Pause', result: 'set', detail: '' }]);
  link.href = 'https://claude.ai/code/project/chan_01X';
  link.style.display = 'block';
  btn.disabled = true;
  btn.textContent = 'Import complete';
  status.textContent = 'Done - "New" was created.';
  await settle();
  const kinds = w.events.map(e => e.kind);
  assert.ok(kinds.includes('status') && kinds.includes('console') && kinds.includes('rows'));
  assert.equal(kinds[kinds.length - 1], 'done');
  const done = w.events[w.events.length - 1];
  assert.deepEqual(done.result.created, { id: 'chan_01X', url: 'https://claude.ai/code/project/chan_01X', name: 'New' });
  assert.equal(done.result.paused, true);
  assert.equal(done.result.rows.length, 3);
  assert.deepEqual(Object.keys(done.result.rows[1]), ['group', 'item', 'result', 'detail']);
  assert.deepEqual(done.result.counts, { created: 1, set: 1, added: 1, moved: 0, leftOut: 0, notSet: 0, notAdded: 0, toCheck: 0 });
  const consoleEvents = w.events.filter(e => e.kind === 'console');
  assert.ok(consoleEvents.some(e => e.level === 'log' && e.text === 'Claude importer: Creating the project'));
  const failed = consoleEvents.find(e => e.level === 'error');
  assert.ok(failed.text.startsWith('Claude importer failed: Error: boom [redacted]'));
  assert.ok(!consoleEvents.some(e => e.text === 'not ours'));
  assert.ok(sb.logs.some(l => l.text === 'not ours'), 'the original console still runs');
  assert.equal(w.events.filter(e => e.kind === 'done').length, 1);
  // A later failure text does not add a second terminal event.
  status.textContent = 'Import failed: nope';
  await settle();
  assert.equal(w.events.filter(e => e.kind === 'failed').length, 0);
  assert.equal(helper.state().finished, 'done');
});

test('page helper: a failure in the status box is reported once, with the link when there is one', async () => {
  for (const [text, link] of [['Import failed: The site refused', ''], ['The import stopped part-way (x). The new project exists', 'https://claude.ai/project/p1'], ['Nothing was imported.', '']]) {
    const w = makeScriptedWorker();
    const sb = makePageSandbox({ server: async () => json(200, {}), worker: w, boot: BOOT });
    sb.create();
    const { document } = sb.dom;
    const wrap = document.createElement('div');
    wrap.id = 'claude-simple-importer';
    const status = document.createElement('div');
    const a = document.createElement('a');
    a.style.display = 'none';
    const btn = document.createElement('button');
    wrap.append(status, a, btn);
    document.body.appendChild(wrap);
    await settle();
    if (link) { a.href = link; a.style.display = 'block'; }
    status.textContent = text;
    await settle();
    const failed = w.events.filter(e => e.kind === 'failed');
    assert.equal(failed.length, 1, text);
    assert.equal(failed[0].text, text);
    assert.equal(failed[0].link, link);
  }
});

test('page helper: press clicks the button once; probe.identity asks the two endpoints as probes', async () => {
  const w = makeScriptedWorker();
  const server = async url => {
    if (url.pathname === '/api/organizations') return json(200, [{ uuid: ORG_CHAT, name: 'Personal' }, { uuid: 'other-uuid' }]);
    if (url.pathname === '/api/account') return json(404, { error: { type: 'not_found_error' } });
    if (url.pathname === '/api/auth/current_account') return json(200, { account: { email_address: 'B@Example.com' } });
    return json(200, {});
  };
  const sb = makePageSandbox({ server, worker: w, boot: BOOT });
  sb.create();
  const { document } = sb.dom;
  const wrap = document.createElement('div');
  wrap.id = 'claude-simple-importer';
  const btn = document.createElement('button');
  wrap.append(document.createElement('div'), document.createElement('a'), btn);
  document.body.appendChild(wrap);
  await settle();
  w.push({ type: 'press' });
  w.push({ type: 'press' });
  await settle();
  assert.equal(btn.clicks, 1);
  w.push({ type: 'probe.identity', probeId: 'pr-1' });
  await until(() => w.identities.length === 1, 'the identity result');
  assert.deepEqual(w.identities[0], { status: 200, email: 'B@Example.com', orgs: [ORG_CHAT, 'other-uuid'], finalPath: '', redirected: false, error: null });
  assert.deepEqual(w.permits.map(p => `${p.kind} ${p.path}`), ['probe /api/organizations', 'probe /api/account', 'probe /api/auth/current_account']);
  // Signed out: 401 on the organizations, nothing else asked.
  const w2 = makeScriptedWorker();
  const sb2 = makePageSandbox({ server: async () => json(401, { error: { type: 'authentication_error' } }), worker: w2, boot: BOOT });
  sb2.create();
  await settle();
  w2.push({ type: 'probe.identity', probeId: 'pr-2' });
  await until(() => w2.identities.length === 1, 'the identity result');
  assert.equal(w2.identities[0].status, 401);
  assert.equal(w2.identities[0].orgs, null);
  assert.equal(w2.identities[0].email, null);
  assert.equal(w2.permits.length, 1);
});

test('page helper: reconnects with fixed backoff and re-sends what was unanswered, same id', async () => {
  const scheduled = [];
  const schedule = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };
  const servers = [];
  const answered = [];
  const worker = { onConnect: port => {
    servers.push(port);
    port.onMessage.addListener(msg => {
      if (msg.type === 'page.attach') { port.postMessage({ re: msg.id, ok: true, phase: 'running' }); return; }
      if (msg.type === 'gate.permit' && servers.length === 1) return; // the first worker dies before answering
      answered.push(msg);
      port.postMessage({ re: msg.id, ok: true, permit: 'p1', attempt: 1, seq: 1, waitedMs: 0 });
    });
  } };
  const sb = makePageSandbox({ server: async () => json(200, {}), worker, boot: BOOT, schedule });
  const helper = sb.create();
  await settle();
  const p = sb.sandbox.fetch('/api/x');
  await settle();
  const firstPermit = servers[0].listeners && sb.connections[0].client.sent.find(m => m.type === 'gate.permit');
  assert.ok(firstPermit);
  servers[0].disconnect();
  await settle();
  const reconnect = scheduled.filter(s => s.fn.name === 'connect');
  assert.deepEqual(reconnect.map(s => s.ms), [0]);
  reconnect[0].fn();
  await settle();
  assert.equal(servers.length, 2);
  const attach = sb.connections[1].client.sent.find(m => m.type === 'page.attach');
  assert.deepEqual(attach.pending, [firstPermit.id]);
  assert.equal(answered[0].id, firstPermit.id, 're-sent with the same id');
  assert.equal(answered[0].requestId, firstPermit.requestId);
  await settle();
  const r = await p;
  assert.equal(r.status, 200);
  assert.equal(helper.state().reconnects, 1);
  // The backoff grows and then stays at 5 s.
  for (let i = 0; i < 4; i++) { servers[servers.length - 1].disconnect(); await settle(); scheduled[scheduled.length - 1].fn(); await settle(); }
  const waits = scheduled.filter(s => s.fn.name === 'connect').map(s => s.ms);
  assert.deepEqual(waits, [0, 0, 0, 0, 0], 'a successful attach resets the backoff');
});

test('page helper: the backoff sequence when the worker stays away', async () => {
  const scheduled = [];
  const schedule = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };
  let connects = 0;
  const sb = makePageSandbox({ server: async () => json(200, {}), boot: BOOT, schedule });
  sb.env.connect = () => { connects++; throw new Error('no worker'); };
  sb.create();
  for (let i = 0; i < 6; i++) { const s = scheduled[scheduled.length - 1]; s.fn(); }
  assert.deepEqual(scheduled.filter(s => s.fn.name === 'connect').map(s => s.ms), [0, 1000, 2000, 5000, 5000, 5000, 5000]);
  assert.equal(connects, 7);
});

// ================================================================ the real import script through the helper

const SIZES = { roots: 12, replies: [2, 3], hiddenReplies: [1], events: [4, 0, 7] };
let exportedCode = null;
async function codeExport() {
  if (!exportedCode) {
    const r = await runScript({ script: EXPORTER, pathname: `/code/project/${CHANNEL}`, server: makeServer({}, SIZES).server });
    if (r.loadError) throw r.loadError;
    assert.match(r.statusText, /^Done/);
    exportedCode = r;
  }
  return exportedCode;
}
function treeOf(exported, folder) {
  const tree = {};
  for (const [p, bytes] of Object.entries(exported.bytes)) if (p.startsWith(`${folder}/`)) tree[p.slice(folder.length + 1)] = bytes;
  return tree;
}

// Runs the unchanged import script in the sandbox behind the helper and
// the scripted worker, presses the button, and waits for the script's end.
async function importThrough({ mock, verdictFor, name = '', act }) {
  const exported = await codeExport();
  const tree = treeOf(exported, 'beethoven');
  const w = makeScriptedWorker({ tree, root: 'beethoven', verdictFor });
  const sb = makePageSandbox({ server: mock.server, worker: w, boot: { ...BOOT, name } });
  sb.create();
  await settle();
  w.push({ type: 'export.set', root: 'beethoven', files: Object.entries(tree).map(([p, b]) => ({ path: p, bytes: b.length })) });
  await sb.runImporter();
  await until(() => w.events.some(e => e.kind === 'ready'), 'the script\'s button');
  w.push({ type: 'press' });
  if (act) await act(w, sb);
  const end = await Promise.race([w.done, new Promise((_, reject) => setTimeout(() => reject(new Error('the import did not end')), 60000).unref())]);
  return { w, sb, end, tree, exported };
}

test('end to end: the real import script completes behind the gate, every request permitted', async () => {
  const mock = makeServer({}, SIZES);
  const { w, sb, end, tree } = await importThrough({ mock });
  assert.equal(end.kind, 'done');
  assert.match(end.result.status, /^Done \u2014 \u201cbeethoven \(imported\)\u201d was created with 9 files and \d+ history files/);
  assert.equal(sb.button().textContent, 'Import complete');
  const made = [...mock.state.channels.values()].filter(c => c.created);
  assert.equal(made.length, 1);
  const manifest = JSON.parse(Buffer.from(tree['export.json']).toString('utf8'));
  assert.equal(made[0].files.size, manifest.files.length + manifest.history.length + 1, 'every file, every history file, the README');
  assert.ok(made[0].record.disabled_at, 'paused at the end');
  // Every request the page made went through a permit and a report.
  const gated = sb.requests.filter(q => q.path.startsWith('/api/') || q.path.startsWith('/v1/'));
  assert.equal(gated.length, sb.requests.length);
  assert.equal(w.granted, gated.length);
  assert.equal(w.reports.length, gated.length);
  assert.ok(w.reports.every(r => r.permit && r.requestId));
  const totalHits = [...mock.hits.byPath.values()].reduce((a, b) => a + b, 0);
  assert.equal(totalHits, gated.length);
  assert.ok(gated.every(q => q.headers.accept === 'application/json'), 'headers untouched');
  // The script's own account reached the worker, and the result is built from it.
  const rows = w.events.find(e => e.kind === 'rows').rows;
  assert.equal(rows[0].item, 'Project');
  assert.equal(end.result.rows.length, rows.length);
  assert.equal(end.result.created.id, made[0].record.id);
  assert.equal(end.result.created.name, 'beethoven (imported)');
  assert.equal(end.result.paused, true);
  assert.equal(end.result.counts.notAdded, 0);
  const creates = w.reports.filter(r => r.created);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].created.id, made[0].record.id);
  const statuses = w.events.filter(e => e.kind === 'status');
  assert.ok(statuses.length > 0);
  assert.match(statuses[statuses.length - 1].text, /^Done/);
  assert.equal(w.fileReads.filter(p => p === 'export.json').length, 1);
  assert.ok(w.fileReads.length >= 9);
  assert.deepEqual(w.events.filter(e => e.kind === 'prompt').map(e => e.promptKind), ['name']);
  assert.equal(sb.logs.filter(l => l.level === 'error').length, 0);
});

test('end to end: the name from the CLI is used', async () => {
  const mock = makeServer({}, SIZES);
  const { end } = await importThrough({ mock, name: 'Symphony no. 9' });
  assert.equal(end.kind, 'done');
  assert.match(end.result.status, /^Done \u2014 \u201cSymphony no\. 9\u201d/);
  assert.equal([...mock.state.channels.values()].filter(c => c.created)[0].record.name, 'Symphony no. 9');
});

test('end to end: a 429 with Retry-After is reported with its header and the script waits it out', async () => {
  let turnedAway = 0;
  const mock = makeServer({
    faultEverywhere: true,
    fault: (url, headers, nth, init) =>
      url.pathname.endsWith('/upload') && init.body.get('file').name === 'notes.md' && turnedAway++ < 1
        ? json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Too many uploads' } }, { 'retry-after': '9' })
        : null,
  }, SIZES);
  const { w, sb, end } = await importThrough({ mock });
  assert.equal(end.kind, 'done');
  const slow = w.reports.find(r => r.status === 429);
  assert.equal(slow.headers['retry-after'], '9');
  assert.equal(slow.bodyJson.error.type, 'rate_limit_error');
  assert.ok(sb.sleeps.includes(9000), 'the script slept its Retry-After');
  const key = w.permits.find(p => p.requestId === slow.requestId).stepKey;
  assert.equal(w.permits.filter(p => p.stepKey === key).length, 2, 'the same step asked again');
  assert.ok(end.result.rows.some(r => r.item === 'state/notes.md' && r.result === 'added'));
});

test('end to end: a challenged upload is held, Resume re-performs it once, the script never sees the 403', async () => {
  let challenged = 0;
  const mock = makeServer({
    faultEverywhere: true,
    fault: (url, headers, nth, init) =>
      url.pathname.endsWith('/upload') && init.body.get('file').name === 'notes.md' && challenged++ < 1
        ? new Response('<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>cf_chl_opt</body></html>',
          { status: 403, headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge', 'cf-ray': '8f1-FRA' } })
        : null,
  }, SIZES);
  let heldSeen = null;
  const { w, sb, end } = await importThrough({
    mock,
    verdictFor: rep => (rep.headers['cf-mitigated'] === 'challenge' ? { action: 'hold', reason: 'interrupted', interruption: { kind: 'challenge' } } : { action: 'pass' }),
    act: async (worker, sandbox) => {
      await until(() => worker.held && worker.held.msg, 'the hold');
      heldSeen = { permits: worker.permits.length, requests: sandbox.requests.length, msg: worker.held.msg };
      await settle(20);
      assert.equal(sandbox.requests.length, heldSeen.requests, 'nothing re-sent while held');
      worker.resume();
    },
  });
  assert.equal(end.kind, 'done');
  const chal = w.reports.find(r => r.status === 403);
  assert.ok(chal.markers.includes('cf_chl_opt') && chal.markers.includes('/cdn-cgi/challenge-platform/'));
  assert.equal(heldSeen.msg.retryOf, chal.permit);
  assert.ok(end.result.rows.some(r => r.item === 'state/notes.md' && r.result === 'added'));
  assert.ok(!sb.logs.some(l => /403/.test(l.text)), 'the script never saw the 403');
  assert.equal(w.reports.filter(r => r.status === 403).length, 1);
});

test('end to end: a 500 on the create is held; Retry succeeds and exactly one project exists', async () => {
  const mock = makeServer({
    fault: (url, headers, nth, init) =>
      url.pathname === '/v1/code/channels' && init.method === 'POST' && nth === 2 ? json(500, { error: { message: 'Internal server error' } }) : null,
  }, SIZES);
  const { w, sb, end } = await importThrough({
    mock,
    verdictFor: rep => (rep.status === 500 ? { action: 'hold', reason: 'failed-step' } : { action: 'pass' }),
    act: async worker => { await until(() => worker.held && worker.held.msg, 'the hold'); worker.retry(); },
  });
  assert.equal(end.kind, 'done');
  assert.equal([...mock.state.channels.values()].filter(c => c.created).length, 1);
  assert.equal(sb.requests.filter(q => q.method === 'POST' && q.path === '/v1/code/channels').length, 2);
  assert.ok(!sb.logs.some(l => /500/.test(l.text)), 'the script never saw the 500');
  assert.equal(w.permits.filter(p => p.retryOf).length, 1);
  assert.equal(w.permits.find(p => p.retryOf).attempt, undefined);
});

test('end to end: Give up on a refused upload yields a "not added" row and the import goes on', async () => {
  const mock = makeServer({
    faultEverywhere: true,
    fault: (url, headers, nth, init) =>
      url.pathname.endsWith('/upload') && init.body.get('file').name === 'data.json' ? json(404, { type: 'error', error: { type: 'not_found_error', message: 'Not found' } }) : null,
  }, SIZES);
  const { end } = await importThrough({
    mock,
    verdictFor: rep => (rep.status === 404 ? { action: 'hold', reason: 'failed-step' } : { action: 'pass' }),
    act: async worker => { await until(() => worker.held && worker.held.msg, 'the hold'); worker.giveUp(); },
  });
  assert.equal(end.kind, 'done');
  const row = end.result.rows.find(r => r.item === 'state/data.json');
  assert.equal(row.result, 'not added');
  assert.match(row.detail, /HTTP 404/);
  assert.equal(end.result.counts.notAdded, 1);
});

test('end to end: after Cancel nothing more is sent; the script sees only refusals until the tab reloads', async () => {
  // The worker reloads the tab right after a cancel. Without that reload
  // (none here), the unchanged script records every later request as a
  // network error and runs to its end: so what matters is that no request
  // reaches the site after the cancel.
  // One upload is held open by the mock until the cancel is in, so that the
  // cancel lands in the middle of the file step.
  let holding = null;
  const mock = makeServer({
    faultEverywhere: true,
    fault: (url, headers, nth, init) =>
      url.pathname.endsWith('/upload') && init.body.get('file').name === 'notes.md' && !holding
        ? (holding = new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason)); }))
        : null,
  }, SIZES);
  let sentAtCancel = -1;
  const { w, sb, end } = await importThrough({
    mock,
    act: async (worker, sandbox) => {
      await until(() => worker.reports.some(r => r.created), 'the create');
      await until(() => holding, 'the held upload');
      worker.cancel();
      sentAtCancel = sandbox.requests.length;
    },
  });
  assert.ok(sentAtCancel > 0);
  assert.equal(sb.requests.length, sentAtCancel, 'nothing was sent after the cancel');
  assert.ok(end.result.created && end.result.created.id, 'the created project is known');
  assert.ok(end.result.rows.some(r => /cancelled from the cswap panel/.test(r.detail)), JSON.stringify({ kind: end.kind, text: end.text, rows: end.result.rows.slice(0, 6) }));
  assert.equal(w.reports.filter(r => r.created).length, 1);
});

// ================================================================ content.js

function makeContentEnv({ present = [], hasImporter = false, title = 'Claude', url = 'https://claude.ai/new?x=1#h', online = true } = {}) {
  const schedule = [];
  const observers = [];
  const listeners = {};
  const state = { present: new Set(present), hasImporter, title };
  const doc = {
    get title() { return state.title; },
    documentElement: {},
    querySelector: sel => (state.present.has(sel) ? {} : null),
    getElementById: id => (id === 'claude-simple-importer' && state.hasImporter ? {} : null),
  };
  const u = new URL(url);
  const win = {
    location: { origin: u.origin, pathname: u.pathname, href: url, search: u.search },
    navigator: { onLine: online },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  };
  const ports = [];
  const connect = () => { const pair = makePortPair({ name: 'cswap-content' }); ports.push(pair); return pair.client; };
  class MutationObserver { constructor(cb) { this.cb = cb; } observe() { observers.push(this); } }
  const env = { win, doc, connect, schedule: (fn, ms) => { schedule.push({ fn, ms }); return schedule.length; }, MutationObserver };
  const sandbox = { chrome: undefined };
  vm.createContext(sandbox);
  vm.runInContext(CONTENT_SRC, sandbox, { filename: 'content.js' });
  return { env, state, ports, schedule, observers, listeners, create: () => sandbox.createContent(env) };
}

test('content.js: reports the page without its query, markers, the importer and the online flag', async () => {
  const c = makeContentEnv({ present: ['#challenge-form'], hasImporter: true, title: 'Just a moment...' });
  const api = c.create();
  await settle();
  const sent = c.ports[0].client.sent;
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { type: 'page.state', url: 'https://claude.ai/new', title: 'Just a moment...', markers: ['#challenge-form'], hints: [], hasImporter: true, online: true });
  assert.deepEqual(JSON.parse(JSON.stringify(api.probe())), { url: 'https://claude.ai/new', title: 'Just a moment...', markers: ['#challenge-form'], hints: [], hasImporter: true, online: true });
  const offline = makeContentEnv({ online: false, url: 'https://claude.ai/login?token=secret' });
  offline.create();
  await settle();
  assert.deepEqual(offline.ports[0].client.sent[0], { type: 'page.state', url: 'https://claude.ai/login', title: 'Claude', markers: [], hints: [], hasImporter: false, online: false });
});

test('content.js: the Cloudflare loader and a Turnstile widget on a normal page are hints, not markers', async () => {
  // Bot management puts its detection loader on ordinary pages and the app
  // may embed Turnstile: neither means a check is showing, so neither may
  // stop a job. The interstitial's own elements still do.
  const hints = readSource(CONTENT_SRC, 'PAGE_HINT_SELECTORS');
  assert.ok(hints.every(s => protocol.PAGE_MARKER_SELECTORS.includes(s)), 'every hint is one of the agreed selectors');
  assert.ok(hints.includes('script[src*="/cdn-cgi/challenge-platform/"]') && hints.includes('.cf-turnstile'));
  const stops = protocol.PAGE_MARKER_SELECTORS.filter(s => !hints.includes(s));
  assert.deepEqual(stops, ['#challenge-form', '#challenge-running', '#cf-challenge-running']);
  const normal = makeContentEnv({ present: ['script[src*="/cdn-cgi/challenge-platform/"]', '.cf-turnstile', 'iframe[src*="challenges.cloudflare.com"]'], hasImporter: true });
  normal.create();
  await settle();
  const report = normal.ports[0].client.sent[0];
  assert.deepEqual(report.markers, []);
  assert.deepEqual(report.hints, ['.cf-turnstile', 'iframe[src*="challenges.cloudflare.com"]', 'script[src*="/cdn-cgi/challenge-platform/"]']);
  const check = makeContentEnv({ present: ['script[src*="/cdn-cgi/challenge-platform/"]', '#challenge-running'] });
  check.create();
  await settle();
  assert.deepEqual(check.ports[0].client.sent[0].markers, ['#challenge-running']);
  assert.deepEqual(check.ports[0].client.sent[0].hints, ['script[src*="/cdn-cgi/challenge-platform/"]']);
});

test('content.js: debounces changes, sends only what changed, answers probe.dom, reconnects', async () => {
  const c = makeContentEnv();
  c.create();
  await settle();
  assert.equal(c.observers.length, 1);
  assert.deepEqual(Object.keys(c.listeners).sort(), ['hashchange', 'pageshow', 'popstate']);
  c.observers[0].cb([]);
  c.observers[0].cb([]);
  c.listeners.popstate[0]();
  assert.equal(c.schedule.length, 1, 'one debounce timer for three triggers');
  assert.equal(c.schedule[0].ms, 500);
  c.schedule[0].fn();
  await settle();
  assert.equal(c.ports[0].client.sent.length, 1, 'nothing changed: not re-sent');
  c.state.present.add('#challenge-running');
  c.state.present.add('.cf-turnstile');
  c.observers[0].cb([]);
  c.schedule[1].fn();
  await settle();
  assert.equal(c.ports[0].client.sent.length, 2);
  assert.deepEqual(c.ports[0].client.sent[1].markers, ['#challenge-running']);
  assert.deepEqual(c.ports[0].client.sent[1].hints, ['.cf-turnstile']);
  c.ports[0].server.postMessage({ id: 42, type: 'probe.dom' });
  await settle();
  const answer = c.ports[0].client.sent[2];
  assert.equal(answer.re, 42);
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.markers, ['#challenge-running']);
  assert.deepEqual(answer.hints, ['.cf-turnstile']);
  c.ports[0].server.disconnect();
  await settle();
  const reconnects = c.schedule.filter(s => s.fn.name === 'connect');
  assert.deepEqual(reconnects.map(s => s.ms), [0]);
  reconnects[0].fn();
  await settle();
  assert.equal(c.ports.length, 2);
  assert.equal(c.ports[1].client.sent[0].type, 'page.state', 'reported again on reconnect');
});

// ================================================================ native.js

function makeNativeHarness({ hostReplies } = {}) {
  const timers = fakeTimers();
  const pairs = [];
  const log = { records: [], debug: (...a) => log.records.push(['debug', ...a]), info: (...a) => log.records.push(['info', ...a]), warn: (...a) => log.records.push(['warn', ...a]) };
  let storeValue;
  const store = { get: async () => storeValue, set: async v => { storeValue = v; } };
  let lastError = null;
  const native = nativeMod.createNative({
    connect: () => { const pair = makePortPair({ name: 'native' }); pairs.push(pair); if (hostReplies) hostReplies(pair.server); return pair.client; },
    now: timers.now, log, store, timeoutMs: 30000, schedule: timers.schedule, unschedule: timers.unschedule, lastError: () => lastError,
  });
  return { native, timers, pairs, log, store: () => storeValue, setLastError: v => { lastError = v; } };
}

const goodHello = { type: 'hello', protocol: 1, product: 'claude-swap', cswap: '0.27.0b1', capabilities: ['job'], backup_dir: 'C:\\x' };

test('native.js: hello handshake, validation and the stored connection state', async () => {
  const h = makeNativeHarness({ hostReplies: port => port.onMessage.addListener(m => { if (m.type === 'hello') port.postMessage({ re: m.id, ...goodHello }); }) });
  const reply = await h.native.connect({ extension: { version: '0.1.0', instance: 'i' }, chrome: '140', userScripts: true });
  assert.equal(reply.cswap, '0.27.0b1');
  assert.equal(h.native.isConnected(), true);
  assert.deepEqual(h.pairs[0].client.sent[0], { id: 1, type: 'hello', protocol: 1, extension: { version: '0.1.0', instance: 'i' }, chrome: '140', userScripts: true });
  assert.equal(h.store().connected, true);
  assert.deepEqual(h.store().lastHello, { cswap: '0.27.0b1', backup_dir: 'C:\\x', protocol: 1, capabilities: ['job'] });
  assert.equal(await h.native.connect({}), reply, 'a second connect reuses the first');
  for (const bad of [{ ...goodHello, product: 'other' }, { ...goodHello, protocol: 2 }, { re: 0, type: 'job' }]) {
    const hb = makeNativeHarness({ hostReplies: port => port.onMessage.addListener(m => port.postMessage({ ...bad, re: m.id })) });
    await assert.rejects(hb.native.connect({}), e => e.code === 'protocol');
    assert.equal(hb.native.isConnected(), false);
    assert.equal(hb.store().connected, false);
  }
  const herr = makeNativeHarness({ hostReplies: port => port.onMessage.addListener(m => port.postMessage({ re: m.id, type: 'error', code: 'protocol' })) });
  await assert.rejects(herr.native.connect({}), e => e.code === 'protocol');
});

test('native.js: pairs replies out of order, reassembles streams, surfaces cancel_requested and errors', async () => {
  const h = makeNativeHarness({ hostReplies: port => port.onMessage.addListener(m => {
    if (m.type === 'hello') port.postMessage({ re: m.id, ...goodHello });
    if (m.type === 'slow') setTimeout(() => port.postMessage({ re: m.id, type: 'slow-reply' }), 5);
    if (m.type === 'fast') port.postMessage({ re: m.id, type: 'fast-reply' });
    if (m.type === 'file.read') {
      port.postMessage({ re: m.id, type: 'file.chunk', path: m.path, offset: 0, data: 'YWJj', last: false });
      port.postMessage({ re: m.id, type: 'file.chunk', path: m.path, offset: 3, data: 'ZGVm', last: true });
    }
    if (m.type === 'event') port.postMessage({ re: m.id, type: 'ack', cancel_requested: m.event === 'status' });
    if (m.type === 'bad') port.postMessage({ re: m.id, type: 'error', code: 'not-found', message: 'no such file' });
  }) });
  await h.native.connect({});
  const [slow, fast] = await Promise.all([h.native.request({ type: 'slow' }), h.native.request({ type: 'fast' })]);
  assert.equal(slow.type, 'slow-reply');
  assert.equal(fast.type, 'fast-reply');
  const parts = [];
  const last = await h.native.requestStream({ type: 'file.read', path: 'a' }, p => parts.push(p));
  assert.deepEqual(parts.map(p => [p.offset, p.data, p.last]), [[0, 'YWJj', false], [3, 'ZGVm', true]]);
  assert.equal(last.last, true);
  assert.deepEqual(await h.native.event({ event: 'phase', phase: 'ready' }).then(r => r.cancel_requested), false);
  assert.deepEqual(await h.native.event({ event: 'status', text: 'x' }).then(r => r.cancel_requested), true);
  await assert.rejects(h.native.request({ type: 'bad' }), e => e.code === 'not-found' && /no such file/.test(e.message));
  assert.equal(h.native.pendingCount(), 0);
  // Logged at debug with the chunk data compacted.
  const chunkLog = h.log.records.find(r => r[0] === 'debug' && r[3] && r[3].type === 'file.chunk');
  assert.equal(chunkLog[3].data, '<4 chars>');
});

test('native.js: a disconnect rejects what is pending; "host not found" becomes the install hint; timeouts', async () => {
  const h = makeNativeHarness({ hostReplies: port => port.onMessage.addListener(m => { if (m.type === 'hello') port.postMessage({ re: m.id, ...goodHello }); }) });
  await h.native.connect({});
  const seen = [];
  h.native.onDisconnect(e => seen.push(e.code));
  const p = h.native.request({ type: 'never' });
  h.setLastError('Specified native messaging host not found.');
  h.pairs[0].server.disconnect();
  await assert.rejects(p, e => e.code === 'no-host' && e.message === nativeMod.INSTALL_HINT);
  await settle();
  assert.deepEqual(seen, ['no-host']);
  assert.equal(h.native.isConnected(), false);
  assert.equal(h.store().connected, false);
  assert.equal(h.store().lastError, nativeMod.INSTALL_HINT);
  await assert.rejects(h.native.request({ type: 'x' }), e => e.code === 'disconnected');
  assert.deepEqual(nativeMod.describeDisconnect('Access to the specified native messaging host is forbidden.'), { code: 'no-host', message: nativeMod.FORBIDDEN_HINT });
  assert.equal(nativeMod.describeDisconnect('Native host has exited.').code, 'disconnected');
  // A host that never answers: the request times out through the injected timers.
  const quiet = makeNativeHarness({ hostReplies: () => {} });
  const expectation = assert.rejects(quiet.native.connect({}), e => e.code === 'timeout');
  await quiet.timers.advance(30001);
  await expectation;
});

// ================================================================ the service worker against a fake chrome

function fakeEvent() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), removeListener: fn => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }, fire: (...args) => listeners.map(fn => fn(...args)), count: () => listeners.length };
}

function fakeChrome({ data = new Map(), tabs = [{ id: 7, url: 'https://claude.ai/new', active: true }], userScripts = true } = {}) {
  const onChanged = fakeEvent();
  const storage = {
    data,
    get: async keys => {
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
      const out = {};
      for (const k of list) if (data.has(k)) out[k] = JSON.parse(data.get(k));
      return out;
    },
    set: async obj => {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) { const oldValue = data.has(k) ? JSON.parse(data.get(k)) : undefined; data.set(k, JSON.stringify(v)); changes[k] = { oldValue, newValue: v }; }
      onChanged.fire(changes, 'local');
    },
    remove: async key => { data.delete(key); },
  };
  const chrome = {
    storage: { local: storage, onChanged },
    runtime: {
      id: 'ext-id', lastError: null,
      getURL: p => `chrome-extension://ext-id/${p}`,
      getManifest: () => ({ version: '0.1.0' }),
      onInstalled: fakeEvent(), onStartup: fakeEvent(), onConnect: fakeEvent(), onUserScriptConnect: fakeEvent(),
      connectNative: () => { throw new Error('not used: native is injected'); },
    },
    userScripts: userScripts ? { configured: [], executed: [], configureWorld: async p => { chrome.userScripts.configured.push(p); }, execute: async inj => { chrome.userScripts.executed.push(inj); return []; } } : undefined,
    tabs: {
      list: tabs, reloaded: [], query: async () => tabs.slice(), reload: async id => { chrome.tabs.reloaded.push(id); }, onRemoved: fakeEvent(),
      get: async id => { const tab = tabs.find(t => t.id === id); if (!tab) throw new Error(`No tab with id: ${id}.`); return tab; },
    },
    alarms: { created: [], cleared: [], create: (name, info) => { chrome.alarms.created.push({ name, ...info }); }, clear: async name => { chrome.alarms.cleared.push(name); return true; }, onAlarm: fakeEvent() },
    notifications: { shown: [], create: async opts => { chrome.notifications.shown.push(opts); return 'n'; } },
    sidePanel: { behavior: null, setPanelBehavior: async b => { chrome.sidePanel.behavior = b; } },
  };
  return chrome;
}

// Fakes of the other owners' modules, with just enough behaviour to drive
// the worker. Each is a factory, as the worker takes them.
function fakeModules({ hostJob, listing, scriptText = '(async () => {})();', verdictFor = () => null, identityOf = () => null, pageOf = () => null, cancelRequested = () => false } = {}) {
  const made = { events: [], requests: [], hello: null, logs: [], raised: [], notifications: [], gateCalls: [] };
  const createLogger = () => ({
    load: async () => {}, clear: async () => { made.logs.length = 0; }, exportText: () => made.logs.map(r => JSON.stringify(r)).join('\n'),
    setLevel: () => {}, setLimits: () => {}, records: () => made.logs,
    debug: (event, msg, data, job) => made.logs.push({ level: 'debug', event, msg, data, job }),
    info: (event, msg, data, job) => made.logs.push({ level: 'info', event, msg, data, job }),
    warn: (event, msg, data, job) => made.logs.push({ level: 'warn', event, msg, data, job }),
    error: (event, msg, data, job) => made.logs.push({ level: 'error', event, msg, data, job }),
  });
  let cfg = { version: 1, minSpacingMs: 500, retryAfterCapMs: 900000, requestTimeoutMs: 120000, notifications: true, logLevel: 'info', logMaxRecords: 2000, logRetentionHours: 72 };
  const createConfigStore = ({ onChange }) => ({ load: async () => cfg, get: () => cfg, set: async patch => { cfg = { ...cfg, ...patch }; onChange(cfg); return { config: cfg, problems: [] }; }, reset: async () => cfg });
  const createInterrupts = ({ store }) => {
    let current = null;
    const history = [];
    return {
      load: async () => {}, current: () => current, history: () => history, snapshot: () => ({ current, history }),
      raise: async partial => {
        const entry = { id: `i${history.length + 1}`, kind: partial.kind, at: 0, what: `what:${partial.kind}`, todo: `todo:${partial.kind}`, evidence: partial.evidence || {}, resolvedAt: null, resolvedBy: null, replace: !!partial.replace };
        made.raised.push(entry);
        history.push(entry);
        if (!current || partial.replace) current = entry;
        await store.set({ version: 1, current, history });
        return entry;
      },
      clear: async by => { const was = current; if (current) { current.resolvedAt = 1; current.resolvedBy = by; } current = null; await store.set({ version: 1, current, history }); return was; },
    };
  };
  // The gate fake keeps to the real gate's answers where the worker reads
  // them: resume() names what it still holds and leaves a failed step for
  // Retry or Give up; a create's permit is persisted as pending until its
  // report; a report while already held passes with an interrupt verdict;
  // the held record counts the step's attempts.
  const createGate = ({ store, onChange, classify }) => {
    const st = { phase: 'idle', jobId: null, held: null, created: null, pausedBy: null, counters: { requests: 0 }, wait: null, attempts: {} };
    let holdResolve = null;
    const persist = () => store.set(JSON.parse(JSON.stringify(st)));
    const isCreate = req => req.kind === 'script' && req.method === 'POST' && protocol.CREATE_PATH_RE_SOURCES.some(s => new RegExp(s).test(req.path));
    const gate = {
      load: async () => { const s = await store.get(); if (s) Object.assign(st, s); },
      start: async jobId => { Object.assign(st, { phase: 'ready', jobId, held: null, created: null, pausedBy: null, counters: { requests: 0 }, attempts: {} }); await persist(); },
      permit: async req => {
        made.gateCalls.push(['permit', req]);
        if (st.phase === 'cancelled') return { ok: false, reason: 'cancelled' };
        if (req.retryOf) {
          return new Promise(resolve => { holdResolve = resolve; });
        }
        st.counters.requests++;
        st.attempts[req.stepKey] = (st.attempts[req.stepKey] || 0) + 1;
        const permit = `p${st.counters.requests}`;
        if (isCreate(req)) st.created = { permit, at: 1, pending: true, status: null, id: null, url: null };
        await persist();
        return { ok: true, permit, attempt: st.attempts[req.stepKey], seq: st.counters.requests, waitedMs: 0 };
      },
      report: async rep => {
        made.gateCalls.push(['report', rep]);
        if (st.created && st.created.permit === rep.permit) Object.assign(st.created, { pending: false, status: rep.status, id: rep.created ? rep.created.id : null, url: rep.created ? rep.created.url : null });
        else if (rep.created) st.created = { permit: rep.permit, at: 1, pending: false, status: rep.status, id: rep.created.id, url: rep.created.url, name: rep.created.name };
        let verdict = { action: 'pass' };
        try { const c = classify(rep); if (c && c.verdict === 'interrupt') verdict = { action: 'hold', reason: 'interrupted', interruption: c.interruption, kind: c.kind }; } catch (e) { /* nothing */ }
        const scripted = verdictFor(rep);
        if (scripted) verdict = scripted;
        if (verdict.action === 'hold' && st.held) verdict = { action: 'pass', verdict: 'interrupt', kind: verdict.kind || 'challenge', interruption: verdict.interruption || { kind: 'challenge' } };
        if (verdict.action === 'hold') {
          const stepKey = (made.gateCalls.find(c => c[0] === 'permit' && c[1].requestId === rep.requestId) || [null, {}])[1].stepKey || '';
          st.phase = 'held';
          st.held = { permit: rep.permit, requestId: rep.requestId, stepKey, reason: verdict.reason, status: rep.status, attempt: st.attempts[stepKey] || 1 };
        }
        await persist();
        onChange(gate.snapshot(), { type: 'report' });
        return verdict;
      },
      pause: async () => { st.pausedBy = 'person'; st.wait = { reason: 'paused', since: 0, until: null }; await persist(); onChange(gate.snapshot(), { type: 'wait', state: 'start', reason: 'paused', until: null }); },
      resume: async () => {
        made.gateCalls.push(['resume']);
        let did = false;
        if (st.pausedBy) { st.pausedBy = null; st.wait = null; did = true; }
        if (st.held && st.held.reason !== 'failed-step') {
          st.held = null; st.phase = 'ready'; did = true;
          if (holdResolve) { holdResolve({ ok: true, permit: 'p-held', attempt: 2, seq: 99, waitedMs: 5 }); holdResolve = null; }
        }
        if (!did) return { ok: true, already: true, held: st.held ? st.held.reason : null };
        await persist();
        onChange(gate.snapshot(), { type: 'wait', state: 'end', reason: 'paused', until: null });
        return { ok: true, held: st.held ? st.held.reason : null };
      },
      retry: async () => { made.gateCalls.push(['retry']); if (st.held) st.attempts[st.held.stepKey] = (st.attempts[st.held.stepKey] || 0) + 1; st.held = null; st.phase = 'ready'; if (holdResolve) { holdResolve({ ok: true, permit: 'p-held', attempt: 2, seq: 99, waitedMs: 5 }); holdResolve = null; } await persist(); },
      giveUp: async () => { made.gateCalls.push(['giveUp']); st.held = null; st.phase = 'ready'; if (holdResolve) { holdResolve({ ok: false, reason: 'give-up' }); holdResolve = null; } await persist(); },
      cancel: async () => { made.gateCalls.push(['cancel']); st.phase = 'cancelled'; if (holdResolve) { holdResolve({ ok: false, reason: 'cancelled' }); holdResolve = null; } await persist(); },
      finish: async outcome => { made.gateCalls.push(['finish', outcome]); st.phase = outcome; await persist(); },
      snapshot: () => JSON.parse(JSON.stringify(st)),
      reevaluate: async () => { made.gateCalls.push(['reevaluate']); },
    };
    return gate;
  };
  let connected = false;
  const disconnectListeners = new Set();
  const createNative = () => ({
    connect: async hello => { made.hello = hello; connected = true; return { type: 'hello', protocol: 1, product: 'claude-swap', cswap: '0.27.0b1', backup_dir: 'x' }; },
    isConnected: () => connected,
    disconnect: () => { connected = false; },
    onDisconnect: fn => { disconnectListeners.add(fn); return () => disconnectListeners.delete(fn); },
    request: async msg => {
      made.requests.push(msg);
      if (!connected) { const e = new Error('not connected'); e.code = 'disconnected'; throw e; }
      if (msg.type === 'job.get') return { type: 'job', job: hostJob() };
      if (msg.type === 'job.claim') { const job = hostJob(); if (!job) { const e = new Error('not queued'); e.code = 'not-queued'; throw e; } job.status = 'claimed'; job.claimed_by = { instance: msg.instance, at: 'now', extension_version: msg.extension_version }; return { type: 'job', job: JSON.parse(JSON.stringify(job)) }; }
      if (msg.type === 'export.list') return { type: 'export', ...listing };
      if (msg.type === 'script.get') return { type: 'script', text: scriptText, sha256: crypto.createHash('sha256').update(scriptText).digest('hex'), bytes: scriptText.length, cswap_version: '0.27.0b1' };
      const e = new Error('unknown'); e.code = 'unknown-type'; throw e;
    },
    requestStream: async (msg, onPart) => {
      made.requests.push(msg);
      const bytes = listing.tree[msg.path];
      if (bytes === undefined) { const e = new Error('not found'); e.code = 'not-found'; throw e; }
      onPart({ type: 'file.chunk', path: msg.path, offset: 0, data: Buffer.from(bytes).toString('base64'), last: true });
      return { last: true };
    },
    event: async body => { made.events.push(body); return { cancel_requested: cancelRequested(body), ack: {} }; },
  });
  const classify = {
    response: rep => (rep.headers && rep.headers['cf-mitigated'] === 'challenge' ? { verdict: 'interrupt', kind: 'challenge', interruption: { kind: 'challenge', evidence: { status: rep.status } } } : { verdict: 'pass' }),
    page: (probe, js) => {
      if (/^just a moment/i.test(probe.title || '')) return { kind: 'challenge-page', what: 'w', todo: 't', evidence: {} };
      if (protocol.LOGIN_PATH_RE.test(new URL(probe.url).pathname)) return { kind: 'signed-out', what: 'w', todo: 't', evidence: {} };
      if (['ready', 'running', 'held'].includes(js.phase) && probe.hasImporter === false) return { kind: 'page-reloaded', what: 'w', todo: 't', evidence: {} };
      return pageOf(probe, js);
    },
    identity: (identity, expected) => {
      if (identity.status === 401) return { kind: 'signed-out', what: 'w', todo: 't', evidence: {} };
      if (identity.email && identity.email.trim().toLowerCase() !== expected.email.trim().toLowerCase()) return { kind: 'wrong-account', what: `signed in as ${identity.email}`, todo: 't', evidence: {} };
      if (!identity.email && !(identity.orgs && identity.orgs.includes(expected.orgUuid))) return { kind: 'identity-unknown', what: 'w', todo: 't', evidence: {} };
      return identityOf(identity, expected);
    },
    describe: kind => ({ what: `what:${kind}`, todo: `todo:${kind}` }),
  };
  return { made, createLogger, createConfigStore, createInterrupts, createGate, createNative, classify, config: () => cfg };
}

const HOST_JOB = () => ({
  version: 1, id: 'job_20261005T141503_a1b2c3', created_at: 'now', updated_at: 'now', status: 'queued', phase: '',
  export: { path: 'C:\\x\\beethoven', archive: false, name: 'beethoven', kind: 'code', files: 9, conversations: 3, bytes: 1000 },
  account: { slot: '2', email: 'b@example.com', org_uuid: ORG_CHAT }, name: null,
  script: { sha256: crypto.createHash('sha256').update('(async () => {})();').digest('hex'), bytes: 20, cswap_version: '0.27.0b1' },
  claimed_by: null, cancel_requested: false, created_project: null, result: null, error: null,
});

let uuidSeq = 0; // across harnesses, so a restarted worker never repeats an id

// Builds a worker on a fake chrome, starts it, and gives the test the knobs:
// a content port for the tab, a page port that attaches with the nonce the
// boot code carries, and a panel port.
async function workerHarness({ chrome: given, modules: givenModules, hostJob = HOST_JOB, timers: givenTimers, start = true, ...modOpts } = {}) {
  const timers = givenTimers || fakeTimers();
  const chrome = given || fakeChrome();
  let job = null;
  const mods = givenModules || fakeModules({ hostJob: () => job || (job = hostJob()), listing: { root: 'beethoven', files: [{ path: 'export.json', bytes: 2 }], tree: { 'export.json': Buffer.from('{}') } }, ...modOpts });
  const bg = backgroundMod.createBackground({
    chrome, now: timers.now, schedule: timers.schedule, unschedule: timers.unschedule, uuid: () => `uuid-${++uuidSeq}`,
    createGate: mods.createGate, createInterrupts: mods.createInterrupts, createConfigStore: mods.createConfigStore,
    createLogger: mods.createLogger, createNative: mods.createNative, classify: mods.classify, redactValue: v => v,
    extensionVersion: '0.1.0', chromeVersion: '140',
  });
  // start: false leaves start() to the test, for what happens before it.
  if (start) await bg.start();
  const h = {
    chrome, bg, mods, timers, made: mods.made,
    start: () => bg.start(),
    stored: key => (chrome.storage.local.data.has(key) ? JSON.parse(chrome.storage.local.data.get(key)) : undefined),
    job: () => h.stored('cswap.job'),
    content: null, page: null, panel: null,
    connectContent(tabId = 7, url = 'https://claude.ai/new') {
      const pair = makePortPair({ name: 'cswap-content', sender: { tab: { id: tabId }, url } });
      chrome.runtime.onConnect.fire(pair.server);
      h.content = pair;
      pair.client.onMessage.addListener(m => { if (m.type === 'probe.dom') pair.client.postMessage({ re: m.id, ok: true, ...h.pageState }); });
      return pair;
    },
    pageState: { url: 'https://claude.ai/new', title: 'Claude', markers: [], hasImporter: false, online: true },
    async sendPageState(patch = {}) { Object.assign(h.pageState, patch); h.content.client.postMessage({ type: 'page.state', ...h.pageState }); await settle(); },
    // The boot object of the latest page.js injection (a rerun makes a new one).
    bootOf() {
      const exec = chrome.userScripts.executed.filter(e => e.js.some(j => j.file === 'src/page.js')).pop();
      const code = exec.js[0].code;
      return JSON.parse(code.slice(code.indexOf('=') + 1).replace(/;$/, ''));
    },
    pageIdentity: { status: 200, email: 'b@example.com', orgs: [ORG_CHAT], finalPath: '', error: null },
    async attachPage({ tabId = 7, nonce, jobId, pending = [], state = {}, auto = true } = {}) {
      const boot = h.bootOf();
      const pair = makePortPair({ name: 'cswap-page', sender: { tab: { id: tabId }, url: 'https://claude.ai/new' } });
      let mid = 0;
      pair.client.replies = [];
      pair.client.pushes = [];
      pair.client.onMessage.addListener(m => {
        if (m.re !== undefined) { pair.client.replies.push(m); return; }
        pair.client.pushes.push(m);
        if (!auto) return;
        if (m.type === 'probe.identity') pair.client.postMessage({ id: ++mid + 1000, type: 'identity.result', probeId: m.probeId, identity: h.pageIdentity });
        if (m.type === 'export.set') { h.pageState.hasImporter = false; }
      });
      pair.client.send = msg => { const id = ++mid; pair.client.postMessage({ id, ...msg }); return id; };
      chrome.runtime.onUserScriptConnect.fire(pair.server);
      pair.client.send({ type: 'page.attach', jobId: jobId || boot.jobId, nonce: nonce || boot.nonce, pending, state });
      await settle();
      h.page = pair;
      return pair;
    },
    connectPanel(url = 'chrome-extension://ext-id/sidepanel.html') {
      const pair = makePortPair({ name: 'cswap-panel', sender: { url } });
      let id = 0;
      pair.client.replies = [];
      pair.client.onMessage.addListener(m => pair.client.replies.push(m));
      pair.cmd = (name, args = {}) => new Promise(resolve => { const myId = ++id; const l = m => { if (m.re === myId) resolve(m); }; pair.client.onMessage.addListener(l); pair.client.postMessage({ id: myId, type: 'cmd', name, args }); });
      chrome.runtime.onConnect.fire(pair.server);
      h.panel = pair;
      return pair;
    },
    events: () => mods.made.events.map(e => e.event),
    async runToReady() {
      h.connectContent();
      await h.sendPageState();
      await until(() => chrome.userScripts.executed.length === 1, 'page.js injected');
      await h.attachPage();
      await until(() => chrome.userScripts.executed.length === 2, 'the script injected');
      h.page.client.send({ type: 'script.event', kind: 'ready' });
      await until(() => h.job() && h.job().phase === 'running', 'running');
    },
  };
  return h;
}

test('worker: claim, preflight, load, press once, run, done', async () => {
  const h = await workerHarness();
  assert.equal(h.job(), undefined);
  assert.ok(h.stored('cswap.instance').id);
  assert.equal(h.stored('cswap.bridge').userScripts, true);
  h.connectContent();
  await h.sendPageState();
  await until(() => h.chrome.userScripts.executed.length === 1, 'page.js injected');
  assert.equal(h.made.hello.userScripts, true);
  assert.deepEqual(h.made.requests.map(r => r.type), ['job.get', 'job.claim']);
  assert.equal(h.job().phase, 'preflight');
  assert.equal(h.job().tabId, 7);
  const inj = h.chrome.userScripts.executed[0];
  assert.equal(inj.world, 'USER_SCRIPT');
  assert.deepEqual(inj.target, { tabId: 7 });
  assert.equal(inj.js.length, 2);
  assert.ok(inj.js[0].code.startsWith('globalThis.__cswapBoot = '));
  assert.equal(inj.js[1].file, 'src/page.js');
  const boot = h.bootOf();
  assert.equal(boot.jobId, 'job_20261005T141503_a1b2c3');
  assert.equal(boot.nonce, h.job().nonce);
  assert.deepEqual(boot.expected, { email: 'b@example.com', orgUuid: ORG_CHAT });
  assert.deepEqual(boot.accountEndpoints, [...protocol.ACCOUNT_ENDPOINTS]);
  assert.equal(boot.requestTimeoutMs, 120000);
  assert.deepEqual(h.chrome.alarms.created.map(a => a.name), ['cswap-poll']);
  await h.attachPage();
  assert.deepEqual(h.page.client.replies[0], { re: 1, ok: true, phase: 'preflight', cancelled: false });
  await until(() => h.chrome.userScripts.executed.length === 2, 'the script injected');
  assert.deepEqual(h.page.client.pushes.map(p => p.type), ['probe.identity', 'export.set']);
  assert.deepEqual(h.page.client.pushes[1], { type: 'export.set', root: 'beethoven', files: [{ path: 'export.json', bytes: 2 }] });
  assert.equal(h.chrome.userScripts.executed[1].js[0].code, '(async () => {})();');
  assert.equal(h.job().phase, 'loading');
  assert.equal(h.stored('cswap.export').root, 'beethoven');
  h.page.client.send({ type: 'script.event', kind: 'ready' });
  await until(() => h.job().phase === 'running', 'running');
  assert.equal(h.page.client.pushes.filter(p => p.type === 'press').length, 1);
  assert.ok(h.job().pressedAt);
  // A permit and a report flow through the gate; status is forwarded.
  h.page.client.send({ type: 'gate.permit', requestId: 'r1', stepKey: 'GET /api/organizations ', method: 'GET', path: '/api/organizations', kind: 'script', bodyBytes: 0 });
  await until(() => h.page.client.replies.some(r => r.permit === 'p1'), 'the permit');
  h.page.client.send({ type: 'gate.report', requestId: 'r1', permit: 'p1', status: 200, ok: true, redirected: false, finalPath: '', headers: { 'content-type': 'application/json', 'set-cookie': 'x' }, elapsedMs: 5, markers: [] });
  await until(() => h.page.client.replies.some(r => r.action === 'pass'), 'the verdict');
  const report = h.made.gateCalls.find(c => c[0] === 'report')[1];
  assert.deepEqual(Object.keys(report.headers), ['content-type'], 'only allowlisted headers reach the gate');
  h.page.client.send({ type: 'script.event', kind: 'status', text: 'Adding 1/2', link: '' });
  h.page.client.send({ type: 'gate.report', requestId: 'r2', permit: 'p2', status: 200, ok: true, redirected: false, finalPath: '', headers: {}, elapsedMs: 5, markers: [], created: { id: 'chan_01NEW', url: 'https://claude.ai/code/project/chan_01NEW', name: 'beethoven (imported)' } });
  await until(() => h.job().created_project, 'created');
  assert.equal(h.job().created_project.id, 'chan_01NEW');
  const result = { created: { id: 'chan_01NEW', url: 'https://claude.ai/code/project/chan_01NEW', name: 'beethoven (imported)' }, status: 'Done', link: 'https://claude.ai/code/project/chan_01NEW', paused: true, rows: [{ group: 'project', item: 'Project', result: 'created', detail: 'x' }], counts: { created: 1 } };
  h.page.client.send({ type: 'script.event', kind: 'done', result });
  await until(() => h.job().phase === 'done', 'done');
  assert.equal(h.job().status, 'done');
  assert.equal(h.job().result.script_sha256, HOST_JOB().script.sha256);
  assert.deepEqual(h.events().filter(e => e !== 'status'), ['claimed', 'phase', 'phase', 'phase', 'phase', 'created', 'done', 'phase']);
  assert.deepEqual(h.made.events.filter(e => e.event === 'phase').map(e => e.phase), ['preflight', 'loading', 'ready', 'running', 'done']);
  assert.ok(h.made.events.some(e => e.event === 'status' && e.text === 'Adding 1/2'));
  assert.deepEqual(h.chrome.alarms.cleared, ['cswap-poll']);
  assert.ok(h.chrome.notifications.shown.some(n => n.title === 'cswap import finished'));
  assert.ok(h.made.gateCalls.some(c => c[0] === 'finish' && c[1] === 'done'));
  // Nothing more is claimed once the job is terminal and a page loads again.
  await h.sendPageState();
  await settle(20);
  assert.equal(h.made.requests.filter(r => r.type === 'job.claim').length, 1);
});

test('worker: a wrong account stops before anything is loaded; the person fixes it and Resume goes on', async () => {
  const h = await workerHarness();
  h.pageIdentity = { status: 200, email: 'someone@else.com', orgs: ['zzz'], finalPath: '', error: null };
  h.connectContent();
  await h.sendPageState();
  await until(() => h.chrome.userScripts.executed.length === 1, 'page.js injected');
  await h.attachPage();
  await until(() => h.job().phase === 'held', 'held');
  assert.equal(h.job().heldFrom, 'preflight');
  assert.equal(h.made.raised[0].kind, 'wrong-account');
  assert.equal(h.made.requests.filter(r => r.type === 'export.list').length, 0, 'nothing loaded');
  assert.equal(h.chrome.userScripts.executed.length, 1, 'the script was not injected');
  assert.ok(h.made.events.some(e => e.event === 'interruption' && e.kind === 'wrong-account'));
  assert.ok(h.chrome.notifications.shown.some(n => n.title === 'cswap import stopped'));
  assert.ok(h.made.gateCalls.some(c => c[0] === 'permit') === false);
  const panel = h.connectPanel();
  const still = await panel.cmd('resume');
  assert.equal(still.ok, false);
  assert.equal(h.job().phase, 'held');
  assert.equal(h.made.raised.length, 2, 'the interruption was replaced');
  assert.equal(h.made.raised[1].replace, true);
  h.pageIdentity = { status: 200, email: 'B@example.com ', orgs: [ORG_CHAT], finalPath: '', error: null };
  const ok = await panel.cmd('resume');
  assert.equal(ok.ok, true);
  await until(() => h.chrome.userScripts.executed.length === 2, 'the script injected after Resume');
  assert.ok(h.made.events.some(e => e.event === 'resumed'));
  assert.equal(h.stored('cswap.interrupt').current, null);
  assert.equal(h.job().phase, 'loading');
});

test('worker: identity-unknown waits for Confirm; a signed-out page is told to sign in', async () => {
  const h = await workerHarness();
  h.pageIdentity = { status: 200, email: null, orgs: null, finalPath: '', error: null };
  h.connectContent();
  await h.sendPageState();
  await until(() => h.chrome.userScripts.executed.length === 1, 'page.js injected');
  await h.attachPage();
  await until(() => h.job().phase === 'held', 'held');
  assert.equal(h.made.raised[0].kind, 'identity-unknown');
  const panel = h.connectPanel();
  const r = await panel.cmd('identity.confirm');
  assert.equal(r.ok, true);
  await until(() => h.job().phase === 'loading', 'loading after Confirm');
  assert.equal(h.job().identityConfirmed, true);
  const h2 = await workerHarness();
  h2.pageIdentity = { status: 401, email: null, orgs: null, finalPath: '', error: null };
  h2.connectContent();
  await h2.sendPageState();
  await until(() => h2.chrome.userScripts.executed.length === 1, 'page.js injected');
  await h2.attachPage();
  await until(() => h2.job().phase === 'held', 'held');
  assert.equal(h2.made.raised[0].kind, 'signed-out');
});

test('worker: a challenged request holds the job; Resume probes the page and the account first', async () => {
  const h = await workerHarness();
  await h.runToReady();
  h.page.client.send({ type: 'gate.permit', requestId: 'r1', stepKey: 'POST /api/x ', method: 'POST', path: '/api/x', kind: 'script', bodyBytes: 3 });
  await until(() => h.page.client.replies.some(r => r.permit === 'p1'), 'the permit');
  h.page.client.send({ type: 'gate.report', requestId: 'r1', permit: 'p1', status: 403, ok: false, redirected: false, finalPath: '', headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' }, elapsedMs: 5, markers: ['cf_chl_opt'], bodyExcerpt: 'just a moment' });
  await until(() => h.job().phase === 'held', 'held');
  const verdict = h.page.client.replies.find(r => r.action === 'hold');
  assert.equal(verdict.reason, 'interrupted');
  assert.equal(h.job().heldFrom, 'running');
  assert.equal(h.made.raised[0].kind, 'challenge');
  assert.ok(h.made.events.some(e => e.event === 'interruption' && e.kind === 'challenge'));
  assert.ok(h.made.gateCalls.some(c => c[0] === 'resume') === false);
  // The page re-asks and waits.
  h.page.client.send({ type: 'gate.permit', requestId: 'r2', stepKey: 'POST /api/x ', method: 'POST', path: '/api/x', kind: 'script', bodyBytes: 3, retryOf: 'p1' });
  await settle();
  assert.equal(h.page.client.replies.filter(r => r.permit === 'p-held').length, 0);
  // Resume while the tab still shows the challenge: refused, interruption replaced.
  const panel = h.connectPanel();
  h.pageState = { ...h.pageState, title: 'Just a moment...', hasImporter: true };
  const no = await panel.cmd('resume');
  assert.equal(no.ok, false);
  assert.equal(h.job().phase, 'held');
  assert.equal(h.made.raised[1].kind, 'challenge-page');
  assert.equal(h.made.raised[1].replace, true);
  // The page is fine again: the DOM probe and the identity probe pass, the gate resumes, the re-ask is granted.
  h.pageState = { ...h.pageState, title: 'Claude', hasImporter: true };
  const yes = await panel.cmd('resume');
  assert.equal(yes.ok, true);
  await until(() => h.job().phase === 'running', 'running again');
  assert.ok(h.made.gateCalls.some(c => c[0] === 'resume'));
  assert.ok(h.page.client.pushes.filter(p => p.type === 'probe.identity').length >= 2, 'identity probed on Resume');
  await until(() => h.page.client.replies.some(r => r.permit === 'p-held'), 'the held permit granted');
  assert.ok(h.made.events.some(e => e.event === 'resumed'));
  assert.equal(h.stored('cswap.interrupt').current, null);
  assert.equal(h.page.client.pushes.filter(p => p.type === 'press').length, 1, 'no second press');
});

test('worker: a failed step is held; Retry and Give up release it', async () => {
  const h = await workerHarness({ verdictFor: rep => (rep.status === 503 ? { action: 'hold', reason: 'failed-step' } : null) });
  await h.runToReady();
  const panel = h.connectPanel();
  for (const [cmd, expectReply] of [['retry', 'p-held'], ['giveUp', 'give-up']]) {
    h.page.client.send({ type: 'gate.permit', requestId: `a-${cmd}`, stepKey: 'PUT /api/x ', method: 'PUT', path: '/api/x', kind: 'script', bodyBytes: 3 });
    await settle();
    h.page.client.send({ type: 'gate.report', requestId: `a-${cmd}`, permit: 'p1', status: 503, ok: false, redirected: false, finalPath: '', headers: {}, elapsedMs: 5, markers: [] });
    await until(() => h.job().phase === 'held', 'held');
    assert.equal(h.job().heldReason, 'failed-step');
    assert.ok(h.made.events.some(e => e.event === 'held' && e.reason === 'failed-step' && e.status === 503));
    // The held event carries the gate's attempt count, not the page's (which sends none).
    const heldEvent = h.made.events.filter(e => e.event === 'held').pop();
    assert.equal(heldEvent.attempt, h.stored('cswap.gate').held.attempt);
    assert.ok(heldEvent.attempt >= 1);
    assert.equal(heldEvent.stepKey, 'PUT /api/x ');
    assert.equal(h.made.raised.length, 0, 'no interruption for a plain failure');
    h.page.client.send({ type: 'gate.permit', requestId: `b-${cmd}`, stepKey: 'PUT /api/x ', method: 'PUT', path: '/api/x', kind: 'script', bodyBytes: 3, retryOf: 'p1' });
    await settle();
    const r = await panel.cmd(cmd);
    assert.equal(r.ok, true);
    await until(() => h.job().phase === 'running', 'released');
    await until(() => h.page.client.replies.some(x => x.permit === expectReply || x.reason === expectReply), 'the re-ask answered');
    assert.ok(h.made.events.some(e => e.event === 'released' && e.action === (cmd === 'retry' ? 'retry' : 'give-up')));
  }
  const r = await panel.cmd('retry');
  assert.equal(r.ok, false, 'nothing held');
  assert.deepEqual(h.made.events.filter(e => e.event === 'held').map(e => e.attempt), [1, 3], 'the retry counted as an attempt of the same step');
});

test('worker: Resume during a failed-step hold leaves the step held; Retry is the way out', async () => {
  const h = await workerHarness({ verdictFor: rep => (rep.status === 503 ? { action: 'hold', reason: 'failed-step' } : null) });
  await h.runToReady();
  h.pageState.hasImporter = true; // the import box is on the page, as Resume's DOM probe will find
  h.page.client.send({ type: 'gate.permit', requestId: 'r1', stepKey: 'PUT /api/x ', method: 'PUT', path: '/api/x', kind: 'script', bodyBytes: 3 });
  await settle();
  h.page.client.send({ type: 'gate.report', requestId: 'r1', permit: 'p1', status: 503, ok: false, redirected: false, finalPath: '', headers: {}, elapsedMs: 5, markers: [] });
  await until(() => h.job().phase === 'held', 'held');
  h.page.client.send({ type: 'gate.permit', requestId: 'r2', stepKey: 'PUT /api/x ', method: 'PUT', path: '/api/x', kind: 'script', bodyBytes: 3, retryOf: 'p1' });
  await settle();
  const panel = h.connectPanel();
  // A Resume (a stale panel, or the command line) must not flip the job to
  // running while the gate still holds the step: the re-ask would wait
  // forever and Retry and Give up would answer "nothing is held".
  const no = await panel.cmd('resume');
  assert.equal(no.ok, false);
  assert.match(no.error, /Retry or Give up/);
  assert.equal(h.job().phase, 'held');
  assert.equal(h.job().heldReason, 'failed-step');
  assert.equal(h.stored('cswap.gate').held.reason, 'failed-step');
  assert.ok(!h.made.events.some(e => e.event === 'resumed'));
  assert.equal(h.page.client.replies.filter(x => x.permit === 'p-held').length, 0, 'the re-ask still waits');
  const vm = panelMod.viewModel({ job: h.job(), gate: h.stored('cswap.gate'), interrupt: h.stored('cswap.interrupt') }, 0);
  assert.deepEqual([vm.buttons.resume, vm.buttons.retry, vm.buttons.giveUp], [false, true, true]);
  // An interruption on top of the hold (the tab went to the sign-in page):
  // Resume is offered for that, clears it once the page is fine again, and
  // the step stays held for Retry or Give up.
  await h.sendPageState({ url: 'https://claude.ai/login', hasImporter: true });
  assert.equal(h.made.raised.length, 1);
  assert.equal(h.made.raised[0].kind, 'signed-out');
  const vm2 = panelMod.viewModel({ job: h.job(), gate: h.stored('cswap.gate'), interrupt: h.stored('cswap.interrupt') }, 0);
  assert.equal(vm2.buttons.resume, true);
  h.pageState = { ...h.pageState, url: 'https://claude.ai/new' };
  const cleared = await panel.cmd('resume');
  assert.equal(cleared.ok, false);
  assert.match(cleared.error, /Retry or Give up/);
  assert.equal(h.stored('cswap.interrupt').current, null, 'the interruption was cleared');
  assert.equal(h.job().phase, 'held');
  assert.equal(h.job().heldReason, 'failed-step');
  // Retry releases it.
  const ok = await panel.cmd('retry');
  assert.equal(ok.ok, true);
  await until(() => h.job().phase === 'running', 'running after Retry');
  await until(() => h.page.client.replies.some(x => x.permit === 'p-held'), 'the re-ask granted');
});

test('worker: a page that goes away while the create is in flight ends the job; never a second create', async () => {
  const create = id => ({ type: 'gate.permit', requestId: id, stepKey: 'POST /v1/code/channels json:0abc1234', method: 'POST', path: '/v1/code/channels', kind: 'script', bodyBytes: 20 });
  // The tab closes with the create unanswered: the server may still have made the project.
  const h = await workerHarness();
  await h.runToReady();
  h.page.client.send(create('r1'));
  await until(() => h.page.client.replies.some(r => r.permit === 'p1'), 'the create permitted');
  assert.equal(h.stored('cswap.gate').created.pending, true);
  h.chrome.tabs.onRemoved.fire(7);
  await until(() => h.job().phase === 'failed', 'failed');
  assert.equal(h.job().error, backgroundMod.UNSURE_CREATE_TEXT);
  assert.equal(h.job().reruns, 0);
  assert.equal(h.chrome.userScripts.executed.length, 2, 'nothing injected again');
  assert.ok(!h.made.gateCalls.some(c => c[0] === 'finish' && c[1] === 'cancelled'), 'the gate was not closed for a fresh start');
  const failed = h.made.events.find(e => e.event === 'failed');
  assert.equal(failed.result.create_unconfirmed, true);
  assert.equal(failed.result.created, null);
  assert.ok(h.made.raised.some(i => i.kind === 'tab-closed'));
  // A hold left by an older worker (held for a fresh start) with the create pending: Resume refuses to start again.
  const h2 = await workerHarness();
  await h2.runToReady();
  h2.page.client.send(create('r1'));
  await until(() => h2.page.client.replies.some(r => r.permit === 'p1'), 'the create permitted');
  h2.bg.stop();
  const stale = { ...h2.job(), phase: 'held', status: 'held', heldFrom: 'claimed', heldReason: 'interrupted' };
  h2.chrome.storage.local.data.set('cswap.job', JSON.stringify(stale));
  const chrome3 = fakeChrome({ data: h2.chrome.storage.local.data });
  const h3 = await workerHarness({ chrome: chrome3, hostJob: () => ({ ...HOST_JOB(), status: 'held', claimed_by: { instance: h2.stored('cswap.instance').id } }) });
  const panel = h3.connectPanel();
  const r = await panel.cmd('resume');
  assert.equal(r.ok, false);
  assert.match(r.error, /may already exist/);
  await until(() => h3.job().phase === 'failed', 'failed instead of a rerun');
  assert.equal(h3.job().error, backgroundMod.UNSURE_CREATE_TEXT);
  assert.equal(chrome3.userScripts.executed.length, 0, 'no fresh injection');
  // Cancel with the create pending: the result says so.
  const h4 = await workerHarness();
  await h4.runToReady();
  h4.page.client.send(create('r1'));
  await until(() => h4.page.client.replies.some(r => r.permit === 'p1'), 'the create permitted');
  const r4 = await h4.connectPanel().cmd('cancel');
  assert.equal(r4.ok, true);
  await until(() => h4.job().phase === 'cancelled', 'cancelled');
  const ev = h4.made.events.find(e => e.event === 'cancelled');
  assert.equal(ev.result.create_unconfirmed, true);
  assert.equal(ev.result.created, null);
  // A create the site turned away (4xx) is not a create: the page going away then holds for a fresh start, as before.
  const h5 = await workerHarness();
  await h5.runToReady();
  h5.page.client.send(create('r1'));
  await until(() => h5.page.client.replies.some(r => r.permit === 'p1'), 'the create permitted');
  h5.page.client.send({ type: 'gate.report', requestId: 'r1', permit: 'p1', status: 400, ok: false, redirected: false, finalPath: '', headers: {}, elapsedMs: 5, markers: [] });
  await until(() => h5.stored('cswap.gate').created.status === 400, 'the refusal recorded');
  h5.chrome.tabs.onRemoved.fire(7);
  await until(() => h5.job().phase === 'held', 'held for a fresh start');
  assert.equal(h5.job().heldFrom, 'claimed');
});

test('worker: every chrome listener exists before start(), and an event that beats start() is handled after it', async () => {
  const first = await workerHarness();
  await first.runToReady();
  first.bg.stop();
  const chrome2 = fakeChrome({ data: first.chrome.storage.local.data });
  const h = await workerHarness({ chrome: chrome2, start: false, hostJob: () => ({ ...HOST_JOB(), status: 'claimed', claimed_by: { instance: first.stored('cswap.instance').id } }) });
  for (const ev of [chrome2.runtime.onInstalled, chrome2.runtime.onStartup, chrome2.runtime.onUserScriptConnect, chrome2.runtime.onConnect, chrome2.alarms.onAlarm, chrome2.tabs.onRemoved]) {
    assert.equal(ev.count(), 1, 'registered at construction, not after the first await');
  }
  // The install event sets the toolbar behaviour at once, before any await.
  chrome2.runtime.onInstalled.fire({ reason: 'install' });
  assert.deepEqual(chrome2.sidePanel.behavior, { openPanelOnActionClick: true });
  // A page port that connects and attaches before start() has read the
  // job, and a wake alarm: neither is dropped, both are handled after.
  const boot = first.bootOf();
  const pair = makePortPair({ name: 'cswap-page', sender: { tab: { id: 7 }, url: 'https://claude.ai/new' } });
  pair.client.replies = [];
  pair.client.onMessage.addListener(m => { if (m.re !== undefined) pair.client.replies.push(m); });
  chrome2.runtime.onUserScriptConnect.fire(pair.server);
  pair.client.postMessage({ id: 1, type: 'page.attach', jobId: boot.jobId, nonce: boot.nonce, pending: [], state: {} });
  chrome2.alarms.onAlarm.fire({ name: 'cswap-wake' });
  await settle(10);
  assert.deepEqual(pair.client.replies, [], 'nothing answered before start()');
  assert.equal(pair.client.connected, true, 'and nothing dropped');
  assert.ok(!h.made.gateCalls.some(c => c[0] === 'reevaluate'));
  await h.start();
  await until(() => pair.client.replies.length === 1, 'the early attach answered');
  assert.deepEqual(pair.client.replies[0], { re: 1, ok: true, phase: 'running', cancelled: false });
  assert.ok(h.made.gateCalls.some(c => c[0] === 'reevaluate'), 'the early wake alarm reached the gate');
  assert.equal(h.job().phase, 'running');
});

test('worker: an attach that arrives before execute() resolves is not lost', async () => {
  const chrome = fakeChrome();
  let releaseExecute = null;
  chrome.userScripts.execute = inj => {
    chrome.userScripts.executed.push(inj);
    if (inj.js.some(j => j.file === 'src/page.js')) return new Promise(resolve => { releaseExecute = () => resolve([]); });
    return Promise.resolve([]);
  };
  const h = await workerHarness({ chrome });
  h.connectContent();
  await h.sendPageState();
  await until(() => chrome.userScripts.executed.length === 1, 'page.js injected');
  // The page connects and attaches while execute() is still pending.
  await h.attachPage();
  assert.deepEqual(h.page.client.replies[0], { re: 1, ok: true, phase: 'preflight', cancelled: false });
  releaseExecute();
  await until(() => chrome.userScripts.executed.length === 2, 'the script injected');
  await h.timers.advance(21000);
  assert.equal(h.job().phase, 'loading', 'the 20 s attach timeout did not fire on a page that was there');
});

test('worker: after a restart the import tab is looked up; a closed or silent tab ends the wait', async () => {
  const claimedBy = h => ({ ...HOST_JOB(), status: 'claimed', claimed_by: { instance: h.stored('cswap.instance').id } });
  // The tab is gone.
  const a = await workerHarness();
  await a.runToReady();
  a.bg.stop();
  const a2 = await workerHarness({ chrome: fakeChrome({ data: a.chrome.storage.local.data, tabs: [] }), hostJob: () => claimedBy(a) });
  await until(() => a2.job().phase === 'held', 'held: the tab is gone');
  assert.equal(a2.job().heldFrom, 'claimed');
  assert.equal(a2.made.raised[0].kind, 'tab-closed');
  // The tab is there but its page never reconnects.
  const b = await workerHarness();
  await b.runToReady();
  b.bg.stop();
  const timers = fakeTimers();
  const b2 = await workerHarness({ chrome: fakeChrome({ data: b.chrome.storage.local.data }), timers, hostJob: () => claimedBy(b) });
  await settle(10);
  assert.equal(b2.job().phase, 'running');
  await timers.advance(9000);
  assert.equal(b2.job().phase, 'running');
  await timers.advance(2000);
  await until(() => b2.job().phase === 'held', 'held: the page stayed silent');
  assert.equal(b2.made.raised[0].kind, 'tab-closed');
  // The page comes back in time: nothing happens.
  const c = await workerHarness();
  await c.runToReady();
  c.bg.stop();
  const timers3 = fakeTimers();
  const chrome3 = fakeChrome({ data: c.chrome.storage.local.data });
  const c2 = await workerHarness({ chrome: chrome3, timers: timers3, hostJob: () => claimedBy(c) });
  await timers3.advance(5000);
  const boot = c.bootOf();
  const pair = makePortPair({ name: 'cswap-page', sender: { tab: { id: 7 }, url: 'https://claude.ai/new' } });
  pair.client.replies = [];
  pair.client.onMessage.addListener(m => { if (m.re !== undefined) pair.client.replies.push(m); });
  chrome3.runtime.onUserScriptConnect.fire(pair.server);
  pair.client.postMessage({ id: 1, type: 'page.attach', jobId: boot.jobId, nonce: boot.nonce, pending: [], state: {} });
  await until(() => pair.client.replies.length === 1, 'attached');
  await timers3.advance(20000);
  assert.equal(c2.job().phase, 'running');
  assert.equal(c2.made.raised.length, 0);
  // A job restarted after its create, whose tab is gone: failed with the link.
  const d = await workerHarness();
  await d.runToReady();
  d.page.client.send({ type: 'gate.report', requestId: 'r9', permit: 'p9', status: 200, ok: true, redirected: false, finalPath: '', headers: {}, elapsedMs: 1, markers: [], created: { id: 'chan_01D', url: 'https://claude.ai/code/project/chan_01D', name: 'n' } });
  await until(() => d.job().created_project, 'created');
  d.bg.stop();
  const d2 = await workerHarness({ chrome: fakeChrome({ data: d.chrome.storage.local.data, tabs: [] }), hostJob: () => claimedBy(d) });
  await until(() => d2.job().phase === 'failed', 'failed: the tab is gone after the create');
  assert.equal(d2.job().result.link, 'https://claude.ai/code/project/chan_01D');
});

test('worker: the poll alarm notices a tab that went away while the worker slept', async () => {
  const a = await workerHarness();
  await a.runToReady();
  a.bg.stop();
  const timers = fakeTimers();
  const chrome2 = fakeChrome({ data: a.chrome.storage.local.data });
  const a2 = await workerHarness({ chrome: chrome2, timers, hostJob: () => ({ ...HOST_JOB(), status: 'claimed', claimed_by: { instance: a.stored('cswap.instance').id } }) });
  await settle(10);
  assert.equal(a2.job().phase, 'running');
  chrome2.tabs.list.length = 0; // closed while the restart's own window is still open
  chrome2.alarms.onAlarm.fire({ name: 'cswap-poll' });
  await until(() => a2.job().phase === 'held', 'held from the poll alarm');
  assert.equal(a2.made.raised[0].kind, 'tab-closed');
  await timers.advance(11000);
  assert.equal(a2.made.raised.length, 1, 'the restart\'s own wait ends without a second interruption');
});

test('worker: an identity probe that is itself challenged raises one interruption, not two', async () => {
  const h = await workerHarness();
  h.connectContent();
  await h.sendPageState();
  await until(() => h.chrome.userScripts.executed.length === 1, 'page.js injected');
  await h.attachPage({ auto: false });
  await until(() => h.page.client.pushes.some(p => p.type === 'probe.identity'), 'the probe asked');
  const probe = h.page.client.pushes.find(p => p.type === 'probe.identity');
  // The probe's first request is challenged: its report holds the job.
  h.page.client.send({ type: 'gate.permit', requestId: 'q1', stepKey: 'GET /api/organizations ', method: 'GET', path: '/api/organizations', kind: 'probe', bodyBytes: 0 });
  await until(() => h.page.client.replies.some(r => r.permit === 'p1'), 'the probe permitted');
  h.page.client.send({ type: 'gate.report', requestId: 'q1', permit: 'p1', status: 403, ok: false, redirected: false, finalPath: '', headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' }, elapsedMs: 5, markers: ['cf_chl_opt'] });
  await until(() => h.job().phase === 'held', 'held');
  // Then the probe's own result arrives, with no account in it.
  h.page.client.send({ type: 'identity.result', probeId: probe.probeId, identity: { status: 403, email: null, orgs: null, finalPath: '', error: null } });
  await settle(20);
  assert.equal(h.made.raised.length, 1);
  assert.equal(h.made.raised[0].kind, 'challenge');
  assert.equal(h.made.events.filter(e => e.event === 'interruption').length, 1);
  assert.equal(h.made.events.filter(e => e.event === 'phase' && e.phase === 'held').length, 1);
  assert.equal(h.chrome.notifications.shown.filter(n => n.title === 'cswap import stopped').length, 1);
  assert.equal(h.job().heldFrom, 'preflight');
  // Resume while the site still challenges the probe: the report handler
  // replaces the interruption once; the identity verdict adds no second one.
  const panel = h.connectPanel();
  const resume = panel.cmd('resume');
  await until(() => h.page.client.pushes.filter(p => p.type === 'probe.identity').length === 2, 'probed again');
  const probe2 = h.page.client.pushes.filter(p => p.type === 'probe.identity')[1];
  h.page.client.send({ type: 'gate.permit', requestId: 'q2', stepKey: 'GET /api/organizations ', method: 'GET', path: '/api/organizations', kind: 'probe', bodyBytes: 0 });
  await until(() => h.page.client.replies.some(r => r.permit === 'p2'), 'the second probe permitted');
  h.page.client.send({ type: 'gate.report', requestId: 'q2', permit: 'p2', status: 403, ok: false, redirected: false, finalPath: '', headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' }, elapsedMs: 5, markers: ['cf_chl_opt'] });
  await until(() => h.made.raised.length === 2, 'replaced once');
  assert.equal(h.made.raised[1].replace, true);
  h.page.client.send({ type: 'identity.result', probeId: probe2.probeId, identity: { status: 403, email: null, orgs: null, finalPath: '', error: null } });
  const r = await resume;
  assert.equal(r.ok, false);
  await settle(20);
  assert.equal(h.made.raised.length, 2, 'no third interruption for the same probe');
  assert.equal(h.job().phase, 'held');
});

test('worker: a job the host still lists as this browser\'s is not run again', async () => {
  // Its end never reached the host: the end is sent again, nothing is claimed.
  const hostState = HOST_JOB();
  const h = await workerHarness({ hostJob: () => hostState });
  await h.runToReady();
  h.page.client.send({ type: 'script.event', kind: 'done', result: { created: { id: 'chan_01Z', url: 'https://claude.ai/code/project/chan_01Z', name: 'n' }, status: 'Done', link: 'https://claude.ai/code/project/chan_01Z', paused: true, rows: [], counts: {} } });
  await until(() => h.job().phase === 'done', 'done');
  hostState.status = 'running';
  const panel = h.connectPanel();
  const r = await panel.cmd('job.refresh');
  assert.equal(r.ok, true);
  assert.equal(h.made.requests.filter(x => x.type === 'job.claim').length, 1, 'no second claim');
  const dones = h.made.events.filter(e => e.event === 'done');
  assert.equal(dones.length, 2, 'the done event went out again');
  assert.equal(dones[1].job, hostState.id);
  assert.equal(dones[1].result.created.id, 'chan_01Z');
  assert.equal(h.chrome.userScripts.executed.length, 2, 'nothing injected again');
  assert.equal(h.job().phase, 'done');
  // No local record at all, but the host says the job created a project:
  // failed with the link, never claimed.
  const chrome2 = fakeChrome();
  chrome2.storage.local.data.set('cswap.instance', JSON.stringify({ id: 'inst-1', createdAt: 0 }));
  const h2 = await workerHarness({ chrome: chrome2, hostJob: () => ({ ...HOST_JOB(), status: 'running', claimed_by: { instance: 'inst-1', at: 'now', extension_version: '0.1.0' }, created_project: { id: 'chan_01Y', url: 'https://claude.ai/code/project/chan_01Y', name: 'n', at: 'now' } }) });
  h2.connectContent();
  await h2.sendPageState();
  await settle(20);
  assert.equal(h2.job(), undefined);
  assert.deepEqual(h2.made.requests.map(x => x.type), ['job.get']);
  const failed = h2.made.events.find(e => e.event === 'failed');
  assert.equal(failed.job, 'job_20261005T141503_a1b2c3');
  assert.equal(failed.result.link, 'https://claude.ai/code/project/chan_01Y');
  assert.equal(failed.result.created.id, 'chan_01Y');
  assert.equal(chrome2.userScripts.executed.length, 0);
});

test('worker: the page going away before a create holds for a fresh start; after a create the job fails with the link', async () => {
  const h = await workerHarness();
  await h.runToReady();
  await h.sendPageState({ hasImporter: false });
  await until(() => h.job().phase === 'held', 'held');
  assert.equal(h.job().heldFrom, 'claimed');
  assert.equal(h.made.raised[0].kind, 'page-reloaded');
  const panel = h.connectPanel();
  h.pageState.hasImporter = false;
  const r = await panel.cmd('resume');
  assert.equal(r.ok, true);
  await until(() => h.chrome.userScripts.executed.length === 3, 'page.js injected again');
  assert.equal(h.job().reruns, 1);
  const firstCode = h.chrome.userScripts.executed[0].js[0].code;
  assert.notEqual(h.job().nonce, JSON.parse(firstCode.slice(firstCode.indexOf('=') + 1).replace(/;$/, '')).nonce, 'a new nonce');
  assert.equal(h.job().nonce, h.bootOf().nonce);
  assert.equal(h.job().pressedAt, null);
  assert.ok(h.made.gateCalls.some(c => c[0] === 'finish' && c[1] === 'cancelled') && h.made.gateCalls.some(c => c[0] === 'permit') === false);
  // The old page port is told it no longer belongs.
  const old = h.page;
  old.client.send({ type: 'page.attach', jobId: 'job_20261005T141503_a1b2c3', nonce: 'stale', pending: [] });
  await settle();
  assert.deepEqual(old.client.replies[old.client.replies.length - 1], { re: old.client.sent[old.client.sent.length - 1].id, ok: false, reason: 'bad-nonce' });
  // Second run: attach, create, then the tab closes.
  await h.attachPage();
  await until(() => h.chrome.userScripts.executed.length === 4, 'the script injected again');
  h.page.client.send({ type: 'script.event', kind: 'ready' });
  await until(() => h.job().phase === 'running', 'running');
  h.page.client.send({ type: 'gate.report', requestId: 'r9', permit: 'p9', status: 200, ok: true, redirected: false, finalPath: '', headers: {}, elapsedMs: 1, markers: [], created: { id: 'chan_01B', url: 'https://claude.ai/code/project/chan_01B', name: 'n' } });
  await until(() => h.job().created_project, 'created');
  h.chrome.tabs.onRemoved.fire(7);
  await until(() => h.job().phase === 'failed', 'failed');
  assert.equal(h.job().error, 'The page went away after the project was created.');
  assert.equal(h.job().result.link, 'https://claude.ai/code/project/chan_01B');
  assert.ok(h.made.events.some(e => e.event === 'failed' && e.result.created.id === 'chan_01B'));
});

test('worker: a page port silent for 10 s counts as a closed tab', async () => {
  const h = await workerHarness();
  await h.runToReady();
  h.page.client.disconnect();
  await settle();
  await h.timers.advance(9000);
  assert.equal(h.job().phase, 'running');
  await h.timers.advance(2000);
  await until(() => h.job().phase === 'held', 'held');
  assert.equal(h.made.raised[0].kind, 'tab-closed');
});

test('worker: a restart mid-import restores the job, answers the page\'s pending requests, presses nothing twice', async () => {
  const h = await workerHarness();
  await h.runToReady();
  h.page.client.send({ type: 'gate.permit', requestId: 'r1', stepKey: 'GET /api/a ', method: 'GET', path: '/api/a', kind: 'script', bodyBytes: 0 });
  await settle();
  h.bg.stop();
  // A new worker on the same storage, with fresh fakes of the modules.
  const chrome2 = fakeChrome({ data: h.chrome.storage.local.data });
  const h2 = await workerHarness({ chrome: chrome2, hostJob: () => ({ ...HOST_JOB(), status: 'claimed', claimed_by: { instance: h.stored('cswap.instance').id } }) });
  assert.equal(h2.job().phase, 'running');
  assert.equal(h2.job().pressedAt, h.job().pressedAt);
  assert.deepEqual(h2.made.requests.map(r => r.type), [], 'no second claim');
  assert.deepEqual(chrome2.alarms.created.map(a => a.name), ['cswap-poll']);
  assert.ok(h2.made.hello, 'reconnected to the host');
  h2.connectContent();
  const boot = h.bootOf();
  const pair = makePortPair({ name: 'cswap-page', sender: { tab: { id: 7 }, url: 'https://claude.ai/new' } });
  pair.client.replies = [];
  pair.client.pushes = [];
  pair.client.onMessage.addListener(m => (m.re !== undefined ? pair.client.replies : pair.client.pushes).push(m));
  chrome2.runtime.onUserScriptConnect.fire(pair.server);
  pair.client.postMessage({ id: 50, type: 'page.attach', jobId: boot.jobId, nonce: boot.nonce, pending: [3], state: { ready: true, pressed: true, statusText: 'Adding 3/9' } });
  await settle();
  assert.deepEqual(pair.client.replies[0], { re: 50, ok: true, phase: 'running', cancelled: false });
  pair.client.postMessage({ id: 3, type: 'gate.permit', requestId: 'r1', stepKey: 'GET /api/a ', method: 'GET', path: '/api/a', kind: 'script', bodyBytes: 0 });
  await until(() => pair.client.replies.length === 2, 'the pending permit answered');
  assert.equal(pair.client.replies[1].ok, true);
  assert.equal(chrome2.userScripts.executed.length, 0, 'nothing injected again');
  assert.equal(pair.client.pushes.filter(p => p.type === 'press').length, 0, 'no second press');
  await h2.sendPageState({ hasImporter: true });
  assert.equal(h2.job().phase, 'running');
});

test('worker: a restart during preflight waits for the page, then starts again when it never comes', async () => {
  const h = await workerHarness();
  h.connectContent();
  await h.sendPageState();
  await until(() => h.chrome.userScripts.executed.length === 1, 'page.js injected');
  h.bg.stop();
  const chrome2 = fakeChrome({ data: h.chrome.storage.local.data });
  const timers = fakeTimers();
  const h2 = await workerHarness({ chrome: chrome2, timers, hostJob: () => ({ ...HOST_JOB(), status: 'claimed', claimed_by: { instance: h.stored('cswap.instance').id } }) });
  assert.equal(h2.job().phase, 'preflight');
  await timers.advance(21000);
  await until(() => chrome2.userScripts.executed.length === 1, 'page.js injected by the second worker');
  assert.equal(h2.job().reruns, 1);
  // The storage is shared, so the old nonce is read from the first worker's injection.
  assert.notEqual(h2.job().nonce, h.bootOf().nonce);
  assert.equal(h2.job().nonce, h2.bootOf().nonce);
  assert.equal(h2.job().phase, 'preflight');
});

test('worker: a second job is not claimed while one is active; a corrupt job record is discarded', async () => {
  const h = await workerHarness();
  await h.runToReady();
  const panel = h.connectPanel();
  const r = await panel.cmd('job.refresh');
  assert.equal(r.ok, true);
  assert.match(r.text, /is running/);
  assert.equal(h.made.requests.filter(x => x.type === 'job.claim').length, 1);
  const chrome2 = fakeChrome();
  chrome2.storage.local.data.set('cswap.job', JSON.stringify('garbage'));
  const h2 = await workerHarness({ chrome: chrome2 });
  assert.equal(h2.job(), undefined);
  assert.ok(h2.made.logs.some(l => /unreadable job/.test(l.msg)));
  const chrome3 = fakeChrome();
  chrome3.storage.local.data.set('cswap.job', JSON.stringify({ id: 'job_x', phase: 'done' }));
  const h3 = await workerHarness({ chrome: chrome3 });
  assert.equal(h3.job().phase, 'done');
  assert.deepEqual(chrome3.alarms.created, [], 'a terminal job arms nothing');
});

test('worker: Cancel captures the link, tells the page, reloads the tab and ends the job', async () => {
  const h = await workerHarness();
  await h.runToReady();
  h.page.client.send({ type: 'gate.report', requestId: 'r1', permit: 'p1', status: 200, ok: true, redirected: false, finalPath: '', headers: {}, elapsedMs: 1, markers: [], created: { id: 'chan_01C', url: 'https://claude.ai/code/project/chan_01C', name: 'n' } });
  h.page.client.send({ type: 'script.event', kind: 'rows', rows: [{ group: 'project', item: 'Project', result: 'created', detail: 'n' }, { group: 'file', item: 'a', result: 'added', detail: '' }] });
  await until(() => h.job().created_project, 'created');
  const panel = h.connectPanel();
  const r = await panel.cmd('cancel');
  assert.equal(r.ok, true);
  await until(() => h.job().phase === 'cancelled', 'cancelled');
  assert.ok(h.made.gateCalls.some(c => c[0] === 'cancel'));
  assert.ok(h.page.client.pushes.some(p => p.type === 'cancel'));
  assert.deepEqual(h.chrome.tabs.reloaded, [7]);
  const ev = h.made.events.find(e => e.event === 'cancelled');
  assert.equal(ev.result.link, 'https://claude.ai/code/project/chan_01C');
  assert.equal(ev.result.counts.added, 1);
  assert.ok(h.made.gateCalls.some(c => c[0] === 'finish' && c[1] === 'cancelled'));
  const again = await panel.cmd('cancel');
  assert.equal(again.ok, false);
});

test('worker: --cancel from the command line arrives through an ack', async () => {
  let flag = false;
  const h = await workerHarness({ cancelRequested: () => flag });
  await h.runToReady();
  flag = true;
  h.page.client.send({ type: 'script.event', kind: 'status', text: 'Adding 2/9', link: '' });
  await until(() => h.job().phase === 'cancelled', 'cancelled from the CLI');
  assert.deepEqual(h.chrome.tabs.reloaded, [7]);
});

test('worker: foreign tabs, bad nonces and foreign panels are dropped', async () => {
  const h = await workerHarness();
  await h.runToReady();
  const foreign = makePortPair({ name: 'cswap-page', sender: { tab: { id: 9 }, url: 'https://claude.ai/new' } });
  h.chrome.runtime.onUserScriptConnect.fire(foreign.server);
  await settle();
  assert.equal(foreign.client.connected, false, 'wrong tab: disconnected');
  const elsewhere = makePortPair({ name: 'cswap-page', sender: { tab: { id: 7 }, url: 'https://evil.example/' } });
  h.chrome.runtime.onUserScriptConnect.fire(elsewhere.server);
  await settle();
  assert.equal(elsewhere.client.connected, false, 'wrong origin: disconnected');
  const bad = makePortPair({ name: 'cswap-page', sender: { tab: { id: 7 }, url: 'https://claude.ai/new' } });
  bad.client.replies = [];
  bad.client.onMessage.addListener(m => bad.client.replies.push(m));
  h.chrome.runtime.onUserScriptConnect.fire(bad.server);
  bad.client.postMessage({ id: 1, type: 'page.attach', jobId: 'job_20261005T141503_a1b2c3', nonce: 'wrong', pending: [] });
  bad.client.postMessage({ id: 2, type: 'gate.permit', requestId: 'rX', stepKey: 'GET /api/a ', method: 'GET', path: '/api/a', kind: 'script', bodyBytes: 0 });
  await settle();
  assert.deepEqual(bad.client.replies, [{ re: 1, ok: false, reason: 'bad-nonce' }], 'nothing after a bad nonce is answered');
  const panel = makePortPair({ name: 'cswap-panel', sender: { url: 'https://claude.ai/sidepanel.html' } });
  h.chrome.runtime.onConnect.fire(panel.server);
  await settle();
  assert.equal(panel.client.connected, false, 'a panel that is not ours: disconnected');
  const content = makePortPair({ name: 'cswap-content', sender: { tab: { id: 3 }, url: 'https://other.example/' } });
  h.chrome.runtime.onConnect.fire(content.server);
  await settle();
  assert.equal(content.client.connected, false);
  assert.ok(h.made.logs.filter(l => l.level === 'warn' && /dropped/.test(l.msg)).length >= 4);
  assert.equal(h.job().phase, 'running', 'the job is untouched');
});

test('worker: without chrome.userScripts nothing is claimed and the hello says so', async () => {
  const chrome = fakeChrome({ userScripts: false });
  const h = await workerHarness({ chrome });
  assert.equal(h.stored('cswap.bridge').userScripts, false);
  assert.match(h.stored('cswap.bridge').userScriptsError, /Allow User Scripts/);
  h.connectContent();
  await h.sendPageState();
  await settle(20);
  assert.equal(h.job(), undefined);
  // The bridge heard the hello (so the command line can say what to turn
  // on), and nothing was asked for or claimed; the host was let go.
  assert.ok(h.made.hello, 'the hello reached the bridge');
  assert.equal(h.made.hello.userScripts, false);
  assert.deepEqual(h.made.requests, []);
  assert.equal(h.mods.createNative().isConnected(), false);
  const panel = h.connectPanel();
  const r = await panel.cmd('job.refresh');
  assert.equal(r.ok, true);
  assert.match(r.text, /No import is queued/);
  assert.ok(h.made.logs.some(l => l.level === 'warn' && /userScripts/.test(l.msg)));
});

test('worker: pickup is rate limited, a job claimed elsewhere is noted, the host is let go when idle', async () => {
  const elsewhere = { ...HOST_JOB(), status: 'claimed', claimed_by: { instance: 'other-profile', at: 'now', extension_version: '0.1.0' } };
  const h = await workerHarness({ hostJob: () => elsewhere });
  h.connectContent();
  await h.sendPageState();
  await settle(10);
  assert.equal(h.job(), undefined);
  assert.deepEqual(h.made.requests.map(r => r.type), ['job.get']);
  assert.equal(h.stored('cswap.bridge').jobElsewhere.claimed_by.instance, 'other-profile');
  assert.equal(h.mods.createNative().isConnected(), false, 'the host was let go');
  await h.sendPageState();
  await settle(10);
  assert.equal(h.made.requests.length, 1, 'no second pickup within the gap');
  await h.timers.advance(31000);
  await h.sendPageState();
  await settle(10);
  assert.equal(h.made.requests.length, 2, 'picked up again after the gap');
});

test('worker: panel commands for settings, the log and notifications; unknown commands refused', async () => {
  const h = await workerHarness();
  const panel = h.connectPanel();
  const set = await panel.cmd('config.set', { config: { minSpacingMs: 900 } });
  assert.deepEqual(set, { re: 1, ok: true, problems: [] });
  assert.equal(h.mods.config().minSpacingMs, 900);
  assert.equal((await panel.cmd('config.reset')).ok, true);
  assert.equal((await panel.cmd('notify.test')).ok, true);
  assert.equal(h.chrome.notifications.shown[0].message, 'Notifications work.');
  const exported = await panel.cmd('log.export');
  assert.equal(exported.ok, true);
  assert.equal(typeof exported.text, 'string');
  assert.ok(exported.text.split('\n').filter(Boolean).every(line => JSON.parse(line).level));
  assert.equal((await panel.cmd('log.clear')).ok, true);
  assert.equal(h.made.logs.length, 0);
  assert.equal((await panel.cmd('pause')).ok, false, 'no job');
  const unknown = await panel.cmd('format.disk');
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unknown command/);
});

test('worker: pause and resume of a running job go to the gate; wait changes become events', async () => {
  const h = await workerHarness();
  await h.runToReady();
  const panel = h.connectPanel();
  assert.equal((await panel.cmd('pause')).ok, true);
  assert.equal(h.stored('cswap.gate').pausedBy, 'person');
  assert.ok(h.made.events.some(e => e.event === 'wait' && e.state === 'start' && e.reason === 'paused'));
  assert.equal((await panel.cmd('resume')).ok, true);
  assert.equal(h.stored('cswap.gate').pausedBy, null);
  assert.equal(h.job().phase, 'running');
});

test('worker: a bridge that refuses the export fails the job with a plain sentence', async () => {
  const h = await workerHarness();
  h.mods.createNative = () => { throw new Error('unused'); };
  const bad = h.bg.modules.native;
  const orig = bad.request;
  bad.request = async msg => { if (msg.type === 'export.list') { const e = new Error('The export folder is gone.'); e.code = 'not-found'; throw e; } return orig(msg); };
  h.connectContent();
  await h.sendPageState();
  await until(() => h.chrome.userScripts.executed.length === 1, 'page.js injected');
  await h.attachPage();
  await until(() => h.job().phase === 'failed', 'failed');
  assert.equal(h.job().error, 'The export folder is gone.');
  assert.ok(h.made.events.some(e => e.event === 'failed' && e.error === 'The export folder is gone.'));
});

// With the other owners' real modules on disk, the worker is wired to them
// as in production (only chrome and the native client are fakes).
const REAL_MODULES_PRESENT = ['gate.js', 'interrupt.js', 'config.js', 'log.js'].every(f => fs.existsSync(path.join(SRC, f)));

test('worker with the real gate, interrupts, config and log: claim to running, a permit and a report, pause', { skip: !REAL_MODULES_PRESENT && 'sibling modules not on disk' }, async () => {
  const timers = fakeTimers();
  const chrome = fakeChrome();
  const fakes = fakeModules({ hostJob: HOST_JOB, listing: { root: 'beethoven', files: [{ path: 'export.json', bytes: 2 }], tree: { 'export.json': Buffer.from('{}') } } });
  const bg = backgroundMod.createBackground({
    chrome, now: timers.now, schedule: timers.schedule, unschedule: timers.unschedule, uuid: () => `uuid-${++uuidSeq}`,
    createNative: fakes.createNative, extensionVersion: '0.1.0', chromeVersion: '140',
  });
  await bg.start();
  const stored = key => (chrome.storage.local.data.has(key) ? JSON.parse(chrome.storage.local.data.get(key)) : undefined);
  assert.deepEqual(Object.keys(stored('cswap.config')).sort(), ['logLevel', 'logMaxRecords', 'logRetentionHours', 'minSpacingMs', 'notifications', 'requestTimeoutMs', 'retryAfterCapMs', 'version']);
  const content = makePortPair({ name: 'cswap-content', sender: { tab: { id: 7 }, url: 'https://claude.ai/new' } });
  chrome.runtime.onConnect.fire(content.server);
  content.client.onMessage.addListener(m => { if (m.type === 'probe.dom') content.client.postMessage({ re: m.id, ok: true, url: 'https://claude.ai/new', title: 'Claude', markers: [], hasImporter: true, online: true }); });
  content.client.postMessage({ type: 'page.state', url: 'https://claude.ai/new', title: 'Claude', markers: [], hasImporter: false, online: true });
  await until(() => chrome.userScripts.executed.length === 1, 'page.js injected');
  const code = chrome.userScripts.executed[0].js[0].code;
  const boot = JSON.parse(code.slice(code.indexOf('=') + 1).replace(/;$/, ''));
  const page = makePortPair({ name: 'cswap-page', sender: { tab: { id: 7 }, url: 'https://claude.ai/new' } });
  const replies = [];
  const pushes = [];
  let mid = 0;
  page.client.onMessage.addListener(m => {
    if (m.re !== undefined) { replies.push(m); return; }
    pushes.push(m);
    if (m.type === 'probe.identity') page.client.postMessage({ id: ++mid, type: 'identity.result', probeId: m.probeId, identity: { status: 200, email: 'b@example.com', orgs: [ORG_CHAT], finalPath: '', error: null } });
  });
  chrome.runtime.onUserScriptConnect.fire(page.server);
  page.client.postMessage({ id: ++mid, type: 'page.attach', jobId: boot.jobId, nonce: boot.nonce, pending: [], state: {} });
  await until(() => chrome.userScripts.executed.length === 2, 'the script injected');
  page.client.postMessage({ id: ++mid, type: 'script.event', kind: 'ready' });
  await until(() => stored('cswap.job') && stored('cswap.job').phase === 'running', 'running');
  assert.equal(pushes.filter(p => p.type === 'press').length, 1);
  page.client.postMessage({ id: ++mid, type: 'gate.permit', requestId: 'r1', stepKey: 'GET /api/organizations ', method: 'GET', path: '/api/organizations', kind: 'script', bodyBytes: 0 });
  await until(() => replies.some(r => r.ok === true && typeof r.permit === 'string'), 'the real gate\'s permit');
  const permit = replies.find(r => typeof r.permit === 'string');
  page.client.postMessage({ id: ++mid, type: 'gate.report', requestId: 'r1', permit: permit.permit, status: 200, ok: true, redirected: false, finalPath: '', headers: { 'content-type': 'application/json' }, elapsedMs: 5, markers: [] });
  await until(() => replies.some(r => r.action === 'pass'), 'the real gate\'s verdict');
  assert.equal(stored('cswap.gate').counters.ok, 1);
  assert.equal(stored('cswap.gate').jobId, boot.jobId);
  // A challenge is classified by the real interrupt.js and recorded by the real interrupts store.
  page.client.postMessage({ id: ++mid, type: 'gate.permit', requestId: 'r2', stepKey: 'POST /api/x ', method: 'POST', path: '/api/x', kind: 'script', bodyBytes: 2 });
  await settle();
  assert.equal(replies.filter(r => typeof r.permit === 'string').length, 1, 'the second permit waits for the minimum spacing');
  assert.equal(stored('cswap.gate').wait.reason, 'spacing');
  assert.ok(fakes.made.events.some(e => e.event === 'wait' && e.reason === 'spacing' && e.state === 'start'));
  await timers.advance(600);
  await until(() => replies.filter(r => typeof r.permit === 'string').length === 2, 'the second permit after the spacing');
  const second = replies.filter(r => typeof r.permit === 'string')[1];
  page.client.postMessage({ id: ++mid, type: 'gate.report', requestId: 'r2', permit: second.permit, status: 403, ok: false, redirected: false, finalPath: '', headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html', 'set-cookie': 'nope' }, elapsedMs: 5, markers: ['cf_chl_opt'], bodyExcerpt: 'just a moment' });
  await until(() => stored('cswap.job').phase === 'held', 'held by the real modules');
  const current = stored('cswap.interrupt').current;
  assert.equal(current.kind, 'challenge');
  assert.match(current.todo, /NEW tab/);
  assert.ok(!JSON.stringify(stored('cswap.interrupt')).includes('nope'), 'no stray header in the evidence');
  assert.ok(!JSON.stringify(stored('cswap.log')).includes('nope'));
  assert.equal(stored('cswap.gate').held.reason, 'interrupted');
  assert.ok(fakes.made.events.some(e => e.event === 'interruption' && e.kind === 'challenge'));
  const panel = makePortPair({ name: 'cswap-panel', sender: { url: 'chrome-extension://ext-id/sidepanel.html' } });
  chrome.runtime.onConnect.fire(panel.server);
  const answers = [];
  panel.client.onMessage.addListener(m => answers.push(m));
  panel.client.postMessage({ id: 1, type: 'cmd', name: 'log.export', args: {} });
  await until(() => answers.length === 1, 'the log export');
  assert.ok(answers[0].text.split('\n').filter(Boolean).every(line => JSON.parse(line).ts));
  bg.stop();
});

// ================================================================ the side panel

test('sidepanel viewModel: buttons by phase and held reason, countdowns, interruption card', () => {
  const { viewModel, waitText } = panelMod;
  const idle = viewModel({}, 0);
  assert.deepEqual(idle.buttons, { pause: false, resume: false, cancel: false, retry: false, giveUp: false, confirm: false, refresh: true });
  assert.match(idle.statusLine, /No import/);
  assert.equal(idle.phaseBadge, 'idle');
  const job = { id: 'j', phase: 'running', export: { name: 'beethoven', kind: 'code', files: 9, conversations: 3 }, account: { slot: '2', email: 'b@example.com' }, lastStatusText: 'Adding 3/9' };
  const running = viewModel({ job, gate: { phase: 'in-flight', inFlight: { method: 'POST', path: '/api/x', attempt: 2 }, counters: { requests: 3, ok: 2, slowDowns: 1, waitedMs: 4000 } } }, 0);
  assert.deepEqual(running.buttons, { pause: true, resume: false, cancel: true, retry: false, giveUp: false, confirm: false, refresh: true });
  assert.equal(running.exportLine, 'beethoven (code, 9 files, 3 conversations)');
  assert.equal(running.accountLine, 'into Account-2 (b@example.com)');
  assert.equal(running.stepText, 'POST /api/x (attempt 2)');
  assert.equal(running.statusText, 'Adding 3/9');
  const waiting = viewModel({ job, gate: { phase: 'waiting', wait: { reason: 'retry-after', since: 1000, until: 121000 } } }, 94000);
  assert.equal(waiting.wait.text, 'Waiting 27 s: the site asked to slow down (HTTP 429, Retry-After 120)');
  assert.equal(waiting.phaseBadge, 'waiting');
  assert.equal(waitText({ reason: 'spacing', since: 0, until: 400 }, 0).text, 'Waiting 0.4 s: minimum spacing');
  assert.equal(waitText({ reason: 'spacing', since: 0, until: 400 }, 900).remainingMs, 0);
  assert.equal(waitText(null, 0), null);
  const paused = viewModel({ job, gate: { phase: 'paused', pausedBy: 'person', wait: { reason: 'paused', since: 0, until: null } } }, 0);
  assert.equal(paused.buttons.pause, false);
  assert.equal(paused.buttons.resume, true);
  assert.equal(paused.phaseBadge, 'paused');
  const heldJob = { ...job, phase: 'held', heldReason: 'failed-step' };
  const held = viewModel({ job: heldJob, gate: { phase: 'held', held: { reason: 'failed-step', stepKey: 'POST /api/up form:a:1', method: 'POST', path: '/api/up', status: 503, attempt: 4 } } }, 0);
  // A failed step is for Retry or Give up: Resume would do nothing to it.
  assert.deepEqual(held.buttons, { pause: false, resume: false, cancel: true, retry: true, giveUp: true, confirm: false, refresh: true });
  assert.equal(held.held.text, 'POST /api/up, last answer HTTP 503, attempt 4');
  assert.match(held.held.retryNote, /may already have acted/);
  // Unless an interruption arrived on top of it (the tab went to the
  // sign-in page while the step was held): Resume clears that first.
  const heldAndStopped = viewModel({ job: heldJob, gate: { phase: 'held', held: { reason: 'failed-step', method: 'POST', path: '/api/up', status: 503, attempt: 4 } },
    interrupt: { current: { kind: 'signed-out', what: 'W', todo: 'T' } } }, 0);
  assert.equal(heldAndStopped.buttons.resume, true);
  assert.equal(heldAndStopped.buttons.retry, true);
  assert.match(heldAndStopped.wait.text, /^Stopped/);
  // A pause the worker took to hold an interruption is not "paused by you".
  const heldByWorker = viewModel({ job: { ...job, phase: 'held', heldReason: 'interrupted' }, gate: { phase: 'paused', pausedBy: 'person', wait: { reason: 'paused', since: 0, until: null } },
    interrupt: { current: { kind: 'signed-out', what: 'W', todo: 'T' } } }, 0);
  assert.equal(heldByWorker.wait.text, 'Stopped: see below for what to do, then press Resume.');
  assert.equal(heldByWorker.phaseBadge, 'held');
  assert.equal(heldByWorker.buttons.resume, true);
  assert.equal(heldByWorker.buttons.pause, false);
  const heldGet = viewModel({ job: heldJob, gate: { phase: 'held', held: { reason: 'failed-step', method: 'GET', path: '/api/list', status: 503, attempt: 4 } } }, 0);
  assert.equal(heldGet.held.retryNote, '');
  const heldNoReply = viewModel({ job: heldJob, gate: { phase: 'held', held: { reason: 'failed-step', method: 'PUT', path: '/api/x', status: 0, attempt: 2 } } }, 0);
  assert.match(heldNoReply.held.text, /no answer/);
  assert.match(heldNoReply.held.retryNote, /duplicate/);
  const longWait = viewModel({ job: { ...job, phase: 'held', heldReason: 'long-wait' }, gate: { phase: 'held', held: { reason: 'long-wait', method: 'POST', path: '/api/up', status: 429, attempt: 1 } } }, 0);
  assert.equal(longWait.buttons.retry, false);
  assert.equal(longWait.buttons.resume, true);
  assert.match(longWait.held.text, /honours it in full/);
  const interrupted = viewModel({
    job: { ...job, phase: 'held', heldReason: 'interrupted' },
    gate: { phase: 'held', held: { reason: 'interrupted', method: 'POST', path: '/api/up', status: 403, attempt: 1 } },
    interrupt: { current: { kind: 'challenge', what: 'W', todo: 'T', evidence: { status: 403 } }, history: [] },
  }, 0);
  assert.deepEqual(interrupted.interruption, { kind: 'challenge', what: 'W', todo: 'T', evidence: { status: 403 } });
  assert.equal(interrupted.held, null);
  assert.equal(interrupted.buttons.resume, true);
  assert.equal(interrupted.buttons.confirm, false);
  const unknown = viewModel({ job: { ...job, phase: 'held', heldReason: 'interrupted' }, interrupt: { current: { kind: 'identity-unknown', what: 'W', todo: 'T' } } }, 0);
  assert.equal(unknown.buttons.confirm, true);
  assert.equal(unknown.buttons.resume, false);
  const resolved = viewModel({ job, interrupt: { current: { kind: 'challenge', what: 'W', todo: 'T', resolvedAt: 5 } } }, 0);
  assert.equal(resolved.interruption, null);
  const done = viewModel({ job: { ...job, phase: 'done', created_project: { url: 'https://claude.ai/code/project/c' }, result: { counts: { added: 38, moved: 1, leftOut: 2, notAdded: 0, notSet: 0, toCheck: 0 } } } }, 0);
  assert.deepEqual(done.buttons.cancel, false);
  assert.equal(done.link, 'https://claude.ai/code/project/c');
  assert.equal(done.resultSummary, '38 added, 1 moved, 2 left out, 0 failed, 0 to check');
  const failed = viewModel({ job: { ...job, phase: 'failed', error: 'boom' } }, 0);
  assert.equal(failed.statusLine, 'Failed: boom');
  assert.equal(failed.phaseBadge, 'failed');
});

// A DOM just big enough for sidepanel.js: the elements sidepanel.html
// declares (read from the file, so an id the script uses but the page lacks
// shows up here), text, values, focus, listeners and [name] lookups.
function makePanelDom() {
  const all = [];
  function el(tag) {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], listeners: {}, dataset: {}, parent: null, id: '',
      textContent: '', className: '', hidden: false, href: '', disabled: false, value: '', checked: false, name: '', type: '',
      get firstChild() { return node.children[0] || null; },
      appendChild(kid) { kid.parent = node; node.children.push(kid); return kid; },
      removeChild(kid) { node.children = node.children.filter(c => c !== kid); kid.parent = null; return kid; },
      remove() { if (node.parent) node.parent.removeChild(node); },
      addEventListener(type, fn) { (node.listeners[type] ||= []).push(fn); },
      fire(type) { for (const fn of node.listeners[type] || []) fn({ type, target: node }); },
      click() { node.fire('click'); },
      querySelectorAll(selector) {
        assert.equal(selector, '[name]', 'the only query the panel makes');
        const out = [];
        const walk = n => { for (const k of n.children) { if (k.name) out.push(k); walk(k); } };
        walk(node);
        return out;
      },
    };
    all.push(node);
    return node;
  }
  const body = el('body');
  const html = fs.readFileSync(path.join(EXT, 'sidepanel.html'), 'utf8');
  for (const [, id] of html.matchAll(/ id="([^"]+)"/g)) {
    const node = el(id.startsWith('btn-') ? 'button' : id === 'settings-form' ? 'form' : id === 'log-level' ? 'select' : 'div');
    node.id = id;
    body.appendChild(node);
  }
  const doc = {
    body, activeElement: null, defaultView: { confirm: () => true },
    getElementById: id => all.find(n => n.id === id) || null,
    createElement: tag => el(tag),
    createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
  };
  return { doc, all, byId: id => doc.getElementById(id), field: name => doc.getElementById('settings-form').querySelectorAll('[name]').find(i => i.name === name) };
}

// The panel's chrome: storage with onChanged, and a worker behind the panel
// port that answers config.set and config.reset by writing the storage.
function makePanelChrome({ data, defaults }) {
  const onChanged = fakeEvent();
  const storage = { get: async keys => { const out = {}; for (const k of keys) if (data.has(k)) out[k] = JSON.parse(data.get(k)); return out; } };
  const set = obj => {
    const changes = {};
    for (const [k, v] of Object.entries(obj)) { const oldValue = data.has(k) ? JSON.parse(data.get(k)) : undefined; data.set(k, JSON.stringify(v)); changes[k] = { oldValue, newValue: v }; }
    onChanged.fire(changes, 'local');
  };
  const cmds = [];
  const connect = () => {
    const pair = makePortPair({ name: 'cswap-panel' });
    pair.server.onMessage.addListener(m => {
      cmds.push(m);
      if (m.name === 'config.set') { set({ 'cswap.config': { ...JSON.parse(data.get('cswap.config')), ...m.args.config } }); pair.server.postMessage({ re: m.id, ok: true, problems: [] }); return; }
      if (m.name === 'config.reset') { set({ 'cswap.config': defaults }); pair.server.postMessage({ re: m.id, ok: true }); return; }
      pair.server.postMessage({ re: m.id, ok: true });
    });
    return pair.client;
  };
  return { chrome: { runtime: { id: 'ext-id', connect }, storage: { local: storage, onChanged } }, set, cmds };
}

test('sidepanel: a setting being edited is not overwritten by a render; Save and Reset let the store lead again', async () => {
  const defaults = { version: 1, minSpacingMs: 500, retryAfterCapMs: 900000, requestTimeoutMs: 120000, notifications: true, logLevel: 'info', logMaxRecords: 2000, logRetentionHours: 72 };
  const data = new Map([['cswap.config', JSON.stringify(defaults)], ['cswap.job', JSON.stringify({ id: 'j', phase: 'running', lastStatusText: 'Adding 1/9' })]]);
  const { chrome, set, cmds } = makePanelChrome({ data, defaults });
  const { doc, byId, field } = makePanelDom();
  const timers = fakeTimers();
  panelMod.createPanel({ chrome, doc, now: timers.now, schedule: timers.schedule });
  await settle();
  const spacing = field('minSpacingMs');
  assert.equal(spacing.value, '500');
  assert.equal(field('notifications').checked, true);
  assert.equal(field('logLevel').value, 'info');
  assert.equal(byId('status-text').textContent, 'Adding 1/9');
  // The person types while the import runs: the job record changes once a
  // second, the gate and the log write all the time, the tick re-renders.
  spacing.value = '3000';
  spacing.fire('input');
  set({ 'cswap.job': { id: 'j', phase: 'running', lastStatusText: 'Adding 2/9' } });
  set({ 'cswap.gate': { phase: 'waiting', wait: { reason: 'spacing', since: 0, until: timers.now() + 400 } } });
  await timers.advance(1000);
  assert.equal(byId('status-text').textContent, 'Adding 2/9', 'the rest of the panel moved on');
  assert.match(byId('wait-line').textContent, /minimum spacing/);
  assert.equal(spacing.value, '3000', 'the field keeps what was typed');
  // Even a change of that very setting in storage does not take the typed value away.
  set({ 'cswap.config': { ...defaults, minSpacingMs: 700 } });
  assert.equal(spacing.value, '3000');
  // A field that merely has focus is left alone too; once it loses focus the store's value goes in.
  const cap = field('retryAfterCapMs');
  doc.activeElement = cap;
  set({ 'cswap.config': { ...defaults, minSpacingMs: 700, retryAfterCapMs: 120000 } });
  assert.equal(cap.value, '900000');
  doc.activeElement = null;
  set({ 'cswap.job': { id: 'j', phase: 'running', lastStatusText: 'Adding 3/9' } });
  assert.equal(cap.value, '120000');
  // Save sends what was typed; afterwards the form follows the store again.
  byId('btn-settings-save').click();
  await until(() => JSON.parse(data.get('cswap.config')).minSpacingMs === 3000, 'saved');
  await settle();
  assert.equal(cmds.find(c => c.name === 'config.set').args.config.minSpacingMs, 3000);
  assert.equal(spacing.value, '3000');
  set({ 'cswap.config': { ...JSON.parse(data.get('cswap.config')), minSpacingMs: 900 } });
  assert.equal(spacing.value, '900', 'after Save the store leads again');
  // Reset drops a pending edit as well.
  spacing.value = '42';
  spacing.fire('input');
  byId('btn-settings-reset').click();
  await until(() => cmds.some(c => c.name === 'config.reset'), 'reset sent');
  await settle();
  assert.equal(spacing.value, '500');
  assert.equal(cap.value, '900000');
  // Every id the script asks for is on the page.
  const script = fs.readFileSync(path.join(SRC, 'sidepanel.js'), 'utf8');
  const html = fs.readFileSync(path.join(EXT, 'sidepanel.html'), 'utf8');
  for (const [, id] of script.matchAll(/\$\('([^']+)'\)|on\('([^']+)'/g)) if (id) assert.ok(html.includes(` id="${id}"`), id);
});

test('sidepanel viewModel: bridge hints, settings problems and log lines', () => {
  const { viewModel, logLines } = panelMod;
  const noScripts = viewModel({ bridge: { connected: false, userScripts: false, userScriptsError: 'turn it on' } }, 0);
  assert.equal(noScripts.bridge.hint, 'turn it on');
  assert.equal(noScripts.bridge.userScripts, false);
  const noHost = viewModel({ bridge: { connected: false, userScripts: true, lastError: nativeMod.INSTALL_HINT } }, 0);
  assert.equal(noHost.bridge.hint, nativeMod.INSTALL_HINT);
  const elsewhere = viewModel({ bridge: { connected: true, userScripts: true, lastHello: { cswap: '0.27' }, jobElsewhere: { id: 'job_x' } } }, 0);
  assert.match(elsewhere.bridge.hint, /job_x/);
  assert.equal(elsewhere.bridge.cswap, '0.27');
  const problems = viewModel({ problems: [{ key: 'minSpacingMs', message: 'too small' }] }, 0);
  assert.deepEqual(problems.problems, [{ key: 'minSpacingMs', message: 'too small' }]);
  const records = [];
  for (let i = 0; i < 60; i++) records.push({ seq: i, ts: '2026-10-05T14:15:03Z', level: i % 3 === 0 ? 'warn' : 'info', event: 'job', msg: `m${i}`, data: {} });
  const info = logLines({ records }, 'info', 50);
  assert.equal(info.length, 50);
  assert.equal(info[0].msg, 'm59', 'newest first');
  const warnOnly = logLines({ records }, 'warn', 50);
  assert.equal(warnOnly.length, 20);
  assert.ok(warnOnly.every(r => r.level === 'warn'));
  assert.deepEqual(logLines(undefined, 'debug'), []);
});
