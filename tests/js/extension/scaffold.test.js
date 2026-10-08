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
const { makeServer, ORG_CHAT, ORG_API, CHANNEL, OTHER_CHANNEL } = require('../mock_claude_ai');

// ---------------------------------------------------------------- stand-ins
// Only used for a sibling module that does not exist on disk.
const STAND_INS = {
  './gate.js': 'export function createGate() { throw new Error("stand-in gate"); }',
  './interrupt.js': 'export function createInterrupts() { throw new Error("stand-in interrupts"); }\n' +
    'export function classifyResponse() { return { verdict: "pass" }; }\nexport function classifyPage() { return null; }\n' +
    'export function classifyIdentity() { return null; }\nexport function describe(kind) { return { what: kind, todo: "" }; }',
  './config.js': 'export const FIELDS = [];\nexport const LOG_LEVELS = ["debug","info","warn","error"];\nexport const DEFAULTS = {};\n' +
    'export function gateConfig(c) { return c || {}; }\nexport function createConfigStore() { throw new Error("stand-in config"); }',
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
const dupMod = await import(pathToFileURL(path.join(SRC, 'duplicate.js')).href);

const PAGE_SRC = fs.readFileSync(path.join(SRC, 'page.js'), 'utf8').replace(/\r\n/g, '\n');
const CONTENT_SRC = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const IMPORTER_SRC = fs.readFileSync(IMPORTER, 'utf8').replace(/\r\n/g, '\n');
const EXPORTER_SRC = fs.readFileSync(EXPORTER, 'utf8').replace(/\r\n/g, '\n');

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
  assert.equal(protocol.EXPORTER_ID, 'claude-simple-exporter');
  assert.deepEqual([...protocol.JOB_KINDS], ['import', 'export']);
  assert.ok(protocol.PHASES.includes('choosing') && protocol.PHASES.includes('placing'));
  for (const c of ['duplicate.start', 'duplicate.choose', 'duplicate.choices', 'duplicate.import', 'duplicate.driven', 'duplicate.driven.refresh', 'job.drop']) assert.ok(protocol.PANEL_COMMANDS.includes(c), c);
  assert.ok(!protocol.PANEL_COMMANDS.includes('exports.list') && !('exports' in protocol.KEYS), 'nothing is listed: the Open window is where an export is chosen');
  assert.deepEqual([protocol.MSG.fileWrite, protocol.MSG.probeProjects, protocol.MSG.projectsResult], ['file.write', 'probe.projects', 'projects.result']);
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
  assert.ok(PAGE_SRC.includes(`var EXPORTER_ID = '${protocol.EXPORTER_ID}';`));
  assert.ok(CONTENT_SRC.includes(`var EXPORTER_ID = '${protocol.EXPORTER_ID}';`));
  assert.ok(PAGE_SRC.includes(`var CHUNK_BYTES = ${protocol.CHUNK_BYTES / 1024} * 1024;`));
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
function makePageSandbox({ server, worker, boot, withChrome = false, schedule, now, pathname = '/new' } = {}) {
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
  const windowMock = { location: { origin, pathname, href: `${origin}${pathname}`, search: '' } };
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
    runExporter: () => vm.runInContext(EXPORTER_SRC, sandbox, { filename: 'project-export.js' }),
    button: () => dom.elements.find(e => e.tagName === 'BUTTON'),
    statusText: () => { const d = dom.elements.filter(e => e.tagName === 'DIV'); return d[1] ? d[1].textContent : ''; },
  };
}

const BOOT = { jobId: 'job_20261005T141503_a1b2c3', nonce: 'n-1', name: '', expected: { email: 'b@example.com', orgUuid: ORG_CHAT },
  bodyMarkers: [...protocol.BODY_MARKERS], accountEndpoints: [...protocol.ACCOUNT_ENDPOINTS], requestTimeoutMs: 120000 };

// The fake service worker behind the page port: a serial gate that grants
// at once, scripted verdicts, a lazy folder served from `tree`, and the
// person's acts (resume, retry, giveUp, cancel) on a held request.
function makeScriptedWorker({ tree = {}, root = 'export', verdictFor = () => ({ action: 'pass' }), attachReply = null, chunk = 512 * 1024, refuseWrite = () => null } = {}) {
  const w = {
    ports: [], attaches: [], permits: [], reports: [], events: [], identities: [], fileReads: [], granted: 0,
    writes: [], written: {}, projects: [],
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
      if (msg.type === 'projects.result') { w.projects.push(msg); port.postMessage({ re: msg.id, ok: true }); return; }
      // A piece of a file the export writes: kept in order, as cswap would.
      if (msg.type === 'file.write') {
        const piece = Buffer.from(msg.data, 'base64');
        w.writes.push({ path: msg.path, offset: msg.offset, bytes: piece.length, last: msg.last === true, size: msg.size });
        const refusal = refuseWrite(msg, w);
        if (refusal) { port.postMessage({ re: msg.id, ok: false, reason: refusal }); return; }
        const sofar = w.written[msg.path] || Buffer.alloc(0);
        if (sofar.length !== msg.offset) { port.postMessage({ re: msg.id, ok: false, reason: 'out-of-order' }); return; }
        w.written[msg.path] = Buffer.concat([sofar, piece]);
        port.postMessage({ re: msg.id, ok: true, size: w.written[msg.path].length });
        return;
      }
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
  const memories = manifest.files.filter(f => f.type === 'project_memory');
  assert.ok(memories.length > 0);
  assert.equal(made[0].files.size, manifest.files.length - memories.length + manifest.history.length + 1, 'every file, every history file, the README');
  // The memory went into the new project's memory, through the gate too.
  assert.deepEqual(made[0].memory.memories.map(m => m.path), memories.map(m => m.memory_path));
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

// ================================================================ the real export script through the helper

// The boot of a Duplicate's export: the chosen project, the account the
// page is signed in as, and no folder to import from.
const EXPORT_BOOT = { ...BOOT, kind: 'export', expected: { email: 'a@example.com', orgUuid: ORG_CHAT, flow: 'export' },
  project: { id: CHANNEL, name: 'beethoven', kind: 'code', orgUuid: ORG_CHAT, orgName: 'Personal' } };
const RECIPES_PROJECT = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Recipes', kind: 'standard', orgUuid: ORG_CHAT, orgName: 'Personal' };

test('page helper (export): the folder streams each file to the worker in pieces and keeps no copy', async () => {
  const N = 512 * 1024;
  const w = makeScriptedWorker({ refuseWrite: msg => (msg.path.endsWith('refused.txt') ? 'bad-path' : null) });
  const sb = makePageSandbox({ server: makeServer().server, worker: w, boot: EXPORT_BOOT });
  const helper = sb.create();
  await settle();
  assert.equal(helper.state().flow, 'export');
  const root = await sb.sandbox.showDirectoryPicker();
  assert.equal(await sb.sandbox.window.showDirectoryPicker(), root, 'one folder for the whole export');
  assert.equal(helper.state().pickerCalls, 2);
  const top = await root.getDirectoryHandle('beethoven', { create: true });
  const state = await top.getDirectoryHandle('state', { create: true });
  assert.equal(await top.getDirectoryHandle('state'), state, 'the same folder again');
  await assert.rejects(top.getDirectoryHandle('missing'), { name: 'NotFoundError' });
  await assert.rejects(top.getFileHandle('state', { create: true }), { name: 'TypeMismatchError' });
  await assert.rejects(top.getFileHandle('../x', { create: true }), { name: 'TypeError', message: /Name is not allowed/ });
  // A file larger than a piece goes out as it is written, in order, each
  // piece waited for; the last piece says so.
  const big = await state.getFileHandle('big.bin', { create: true });
  const bytes = new Uint8Array(2 * N + 10);
  for (let i = 0; i < bytes.length; i += 4099) bytes[i] = i & 255;
  const out = await big.createWritable();
  await out.write(bytes);
  await out.close();
  await assert.rejects(out.close(), { name: 'TypeError', message: /closed twice/ });
  assert.deepEqual(w.writes.map(x => [x.path, x.offset, x.bytes, x.last, x.size]), [
    ['beethoven/state/big.bin', 0, N, false, N],
    ['beethoven/state/big.bin', N, N, false, 2 * N],
    ['beethoven/state/big.bin', 2 * N, 10, false, 2 * N + 10],
    ['beethoven/state/big.bin', 2 * N + 10, 0, true, 2 * N + 10],
  ]);
  assert.ok(w.written['beethoven/state/big.bin'].equals(Buffer.from(bytes)));
  // Small writes are gathered into one piece; an empty file is one empty piece.
  const small = await top.getFileHandle('notes.md', { create: true });
  const sw = await small.createWritable();
  await sw.write('hello ');
  await sw.write(new Blob(['world']));
  await sw.close();
  const empty = await top.getFileHandle('empty.txt', { create: true });
  const ew = await empty.createWritable();
  await ew.close();
  assert.deepEqual(w.writes.slice(4).map(x => [x.path, x.offset, x.bytes, x.last]), [['beethoven/notes.md', 0, 11, true], ['beethoven/empty.txt', 0, 0, true]]);
  assert.equal(w.written['beethoven/notes.md'].toString(), 'hello world');
  assert.equal(helper.state().filesWritten, 3);
  assert.equal(helper.state().bytesWritten, 2 * N + 10 + 11);
  // Nothing written is kept in the page: a read back is refused; the
  // listing names what exists.
  await assert.rejects(small.getFile(), { name: 'NotAllowedError' });
  const names = [];
  for await (const entry of top.values()) names.push(`${entry.kind}:${entry.name}`);
  assert.deepEqual(names.sort(), ['directory:state', 'file:empty.txt', 'file:notes.md']);
  // A piece cswap refuses fails the file the way a full disk would, with a
  // plain error for the script, and nothing is counted for it or re-sent.
  const bad = await top.getFileHandle('refused.txt', { create: true });
  const bw = await bad.createWritable();
  await bw.write('x');
  await assert.rejects(bw.close(), { name: 'NotAllowedError', message: /bad-path/ });
  assert.equal(helper.state().filesWritten, 3);
  assert.equal(w.writes.filter(x => x.path === 'beethoven/refused.txt').length, 1);
  await assert.rejects(bw.write('y'), { name: 'TypeError', message: /write after close/ });
  await bw.abort();
});

// Runs the unchanged export script in the sandbox behind the helper and the
// scripted worker, on the page `pathname` names, presses the button, and
// waits for the script's end.
async function exportThrough({ mock, boot = EXPORT_BOOT, pathname = `/code/project/${CHANNEL}`, refuseWrite, act }) {
  const w = makeScriptedWorker({ refuseWrite });
  const sb = makePageSandbox({ server: mock.server, worker: w, boot, pathname });
  sb.create();
  await settle();
  await sb.runExporter();
  await until(() => w.events.some(e => e.kind === 'ready'), 'the script\'s button');
  w.push({ type: 'press' });
  if (act) await act(w, sb);
  const end = await Promise.race([w.done, new Promise((_, reject) => setTimeout(() => reject(new Error('the export did not end')), 60000).unref())]);
  return { w, sb, end };
}

test('end to end (export): the real export script writes the project through the worker, every request permitted', async () => {
  const exported = await codeExport();
  const mock = makeServer({}, SIZES);
  const { w, sb, end } = await exportThrough({ mock });
  assert.equal(end.kind, 'done');
  assert.equal(sb.button().textContent, 'Export complete');
  assert.match(end.result.status, /^Done/);
  assert.equal(end.result.created, null);
  // The same files, byte for byte, as the script writes into a real folder;
  // the manifest carries the time of the export and is compared without it.
  const paths = Object.keys(exported.bytes).filter(p => p.startsWith('beethoven/')).sort();
  assert.ok(paths.length >= 9);
  assert.deepEqual(Object.keys(w.written).sort(), paths);
  for (const p of paths) {
    if (p.endsWith('/export.json')) {
      const strip = text => { const m = JSON.parse(text); delete m.exported_at; return m; };
      assert.deepEqual(strip(w.written[p].toString('utf8')), strip(Buffer.from(exported.bytes[p]).toString('utf8')), p);
    } else {
      assert.ok(Buffer.from(exported.bytes[p]).equals(w.written[p]), p);
    }
  }
  assert.equal(end.result.written.files, paths.length);
  assert.equal(end.result.written.bytes, paths.reduce((n, p) => n + w.written[p].length, 0));
  // In order and waited for: every file's pieces start at 0 and follow on,
  // and each file ends with its last piece.
  const next = new Map();
  for (const x of w.writes) { assert.equal(x.offset, next.get(x.path) || 0, x.path); next.set(x.path, x.offset + x.bytes); }
  assert.equal(w.writes.filter(x => x.last).length, paths.length);
  // One file at a time, as the .tar cswap writes them into takes them:
  // once another file's pieces begin, an earlier file's never come back.
  const left = new Set();
  let writing = null;
  for (const x of w.writes) {
    if (x.path === writing) continue;
    assert.ok(!left.has(x.path), `${x.path} came back after another file began`);
    if (writing) left.add(writing);
    writing = x.path;
  }
  // Every request the page made went through a permit and a report, as the
  // script's own; the headers reached the site untouched.
  const gated = sb.requests.filter(q => q.path.startsWith('/api/') || q.path.startsWith('/v1/'));
  assert.equal(gated.length, sb.requests.length);
  assert.equal(w.granted, gated.length);
  assert.equal(w.reports.length, gated.length);
  assert.ok(w.permits.every(p => p.kind === 'script'));
  const totalHits = [...mock.hits.byPath.values()].reduce((a, b) => a + b, 0);
  assert.equal(totalHits, gated.length);
  assert.ok(gated.every(q => q.headers.accept === 'application/json'), 'headers untouched');
  // The project's memory came through the same gate, by the route its Auto
  // memory panel uses, and was written with the rest.
  const memory = gated.filter(q => q.path.startsWith('/v1/code/memory/channel/'));
  assert.ok(memory.length >= 2);
  assert.ok(memory.every(q => q.method === 'GET' && !('anthropic-beta' in q.headers)));
  assert.ok(paths.includes('beethoven/Memory/MEMORY.md'));
  // On the project's own page the script asks nothing; the folder was
  // asked for once; nothing was created on the site.
  assert.deepEqual(w.events.filter(e => e.kind === 'prompt'), []);
  assert.equal(sb.sandbox.__cswapImport.state().pickerCalls, 1);
  assert.equal(w.reports.filter(r => r.created).length, 0);
  assert.equal(sb.logs.filter(l => l.level === 'error').length, 0);
});

test('end to end (export): a piece cswap refuses ends the export as failed, said in the script\'s own words, nothing re-sent', async () => {
  const mock = makeServer({}, SIZES);
  let refused = 0;
  const { w, sb, end } = await exportThrough({ mock, refuseWrite: msg => (msg.path.endsWith('/export.json') ? (refused++, 'export-missing') : null) });
  assert.equal(end.kind, 'failed');
  assert.match(end.result.status, /^Export failed: cswap could not save "beethoven\/export\.json" \(export-missing\)/);
  assert.equal(refused, 1, 'refused once, never re-sent');
  assert.equal(sb.statusText(), end.result.status);
  assert.notEqual(sb.button().textContent, 'Export complete');
  assert.ok(end.result.written.files < Object.keys(w.written).length + 1);
  assert.ok(sb.logs.some(l => l.level === 'error' && /Claude exporter failed/.test(l.text)));
});

test('page helper (export): probe.projects lists what the account can see, as the script would, through the gate as probes', async () => {
  const mock = makeServer({}, SIZES);
  const w = makeScriptedWorker();
  const sb = makePageSandbox({ server: mock.server, worker: w, boot: EXPORT_BOOT, pathname: `/code/project/${CHANNEL}` });
  sb.create();
  await settle();
  w.push({ type: 'probe.projects', probeId: 'pp1' });
  await until(() => w.projects.length === 1, 'the listing');
  const got = w.projects[0];
  assert.equal(got.probeId, 'pp1');
  assert.deepEqual(got.here, { id: CHANNEL, kind: 'code' });
  // The organization's projects, then the Claude Code projects by their
  // own names from the script's channel list, in the order the site gave.
  assert.deepEqual(got.projects.map(p => [p.name, p.kind, p.orgUuid, p.orgName, p.archived]),
    [['Recipes', 'standard', ORG_CHAT, 'Personal', false], ['Tax notes', 'standard', ORG_CHAT, 'Personal', false],
      ['some-other-channel', 'code', '', '', false], ['beethoven', 'code', '', '', false]]);
  assert.deepEqual(got.projects.slice(2).map(p => p.id), [OTHER_CHANNEL, CHANNEL]);
  // Only what the panel needs leaves the page: never a channel's members.
  for (const p of got.projects) assert.deepEqual(Object.keys(p).sort(), ['archived', 'id', 'kind', 'name', 'orgName', 'orgUuid']);
  assert.deepEqual(got.orgs, [{ uuid: ORG_CHAT, name: 'Personal', apiOnly: false, error: null }, { uuid: ORG_API, name: 'Individual Org', apiOnly: true, error: null }]);
  assert.equal(got.error, null);
  assert.deepEqual(w.permits.map(p => [p.kind, p.method, p.path]),
    [['probe', 'GET', '/api/organizations'], ['probe', 'GET', `/api/organizations/${ORG_CHAT}/projects`], ['probe', 'GET', '/v1/code/channels']],
    'permits never carry a query string');
  // The tab's channel was in the list: it is not asked for by itself.
  assert.deepEqual(sb.requests.map(q => q.path), ['/api/organizations', `/api/organizations/${ORG_CHAT}/projects?include_harmony_projects=true&limit=100`,
    '/v1/code/channels?scope=joined&include_members=true&include_archived=true&limit=200']);
  // The script's own headers: the /v1/ request carries the version it
  // needs, the /api/ ones go without it.
  assert.ok(sb.requests.every(q => q.headers.accept === 'application/json'));
  assert.equal(sb.requests[2].headers['anthropic-version'], '2023-06-01');
  assert.ok(sb.requests.slice(0, 2).every(q => !('anthropic-version' in q.headers)));
  assert.equal(sb.sandbox.__cswapImport.state().probes, 1);
  // The panel lists the tab's project first, under its own name.
  const choices = dupMod.projectChoices(got);
  assert.equal(choices.projects[0].id, CHANNEL);
  assert.deepEqual(choices.projects.map(p => p.name), ['beethoven', 'Recipes', 'some-other-channel', 'Tax notes']);
  assert.ok(!choices.projects.some(p => /This tab's workspace/.test(p.label)));
  // A failed list of organizations is the error; one organization's
  // refusal is noted on it and the rest still count.
  const down = makeServer({ faultEverywhere: true, fault: url => (url.pathname === '/api/organizations' ? new Response('down', { status: 503, headers: { 'content-type': 'text/plain' } }) : null) }, SIZES);
  const w2 = makeScriptedWorker();
  const sb2 = makePageSandbox({ server: down.server, worker: w2, boot: EXPORT_BOOT });
  sb2.create();
  await settle();
  w2.push({ type: 'probe.projects', probeId: 'pp2' });
  await until(() => w2.projects.length === 1, 'the failed listing');
  assert.match(w2.projects[0].error, /HTTP 503/);
  assert.deepEqual(w2.projects[0].projects, []);
  assert.equal(w2.projects[0].here, null);
  assert.deepEqual(sb2.requests.map(q => q.path), ['/api/organizations'], 'nothing more is asked');
  const refusing = makeServer({ faultEverywhere: true, fault: url => (url.pathname.endsWith('/projects') ? new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } }) : null) }, SIZES);
  const w3 = makeScriptedWorker();
  const sb3 = makePageSandbox({ server: refusing.server, worker: w3, boot: EXPORT_BOOT });
  sb3.create();
  await settle();
  w3.push({ type: 'probe.projects', probeId: 'pp3' });
  await until(() => w3.projects.length === 1, 'the refused listing');
  assert.deepEqual(w3.projects[0].orgs[0], { uuid: ORG_CHAT, name: 'Personal', apiOnly: false, error: 'HTTP 403' });
  assert.deepEqual(w3.projects[0].projects.map(p => [p.id, p.name, p.kind]), [[OTHER_CHANNEL, 'some-other-channel', 'code'], [CHANNEL, 'beethoven', 'code']]);
  assert.equal(w3.projects[0].error, null);
});

// Answers one /v1/ or /api/ path (exactly, without its query) with `make`,
// and leaves everything else to the mock.
function answering(routes) {
  return (url, headers, nth) => {
    const make = routes[url.pathname];
    return make ? make(url, headers, nth) : null;
  };
}
const jsonReply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function probeProjectsOn(mockRules, { pathname = `/code/project/${CHANNEL}`, verdictFor } = {}) {
  const mock = makeServer({ faultEverywhere: true, ...mockRules }, SIZES);
  const w = makeScriptedWorker(verdictFor ? { verdictFor } : {});
  const sb = makePageSandbox({ server: mock.server, worker: w, boot: EXPORT_BOOT, pathname });
  sb.create();
  await settle();
  w.push({ type: 'probe.projects', probeId: 'pp' });
  await until(() => w.projects.length === 1, 'the listing');
  return { w, sb, mock, found: w.projects[0] };
}

test('page helper (export): probe.projects asks for the tab\'s own channel by itself when the list leaves it out', async () => {
  const { sb, found } = await probeProjectsOn({
    fault: answering({ '/v1/code/channels': () => jsonReply(200, { data: [{ id: OTHER_CHANNEL, name: 'some-other-channel' }] }) }),
  });
  const v1 = sb.requests.filter(q => q.path.startsWith('/v1/'));
  assert.deepEqual(v1.map(q => q.path), ['/v1/code/channels?scope=joined&include_members=true&include_archived=true&limit=200', `/v1/code/channels/${CHANNEL}`]);
  assert.ok(v1.every(q => q.headers['anthropic-version'] === '2023-06-01'));
  assert.equal(found.error, null);
  const here = found.projects.find(p => p.id === CHANNEL);
  assert.deepEqual(here, { id: CHANNEL, name: 'beethoven', kind: 'code', orgUuid: '', orgName: '', archived: false });
  const choices = dupMod.projectChoices(found);
  assert.equal(choices.projects[0].id, CHANNEL);
  assert.equal(choices.projects[0].name, 'beethoven');
  assert.equal(choices.projects[0].label, 'beethoven');
  // Off a Claude Code project's page nothing is asked by itself.
  const off = await probeProjectsOn({
    fault: answering({ '/v1/code/channels': () => jsonReply(200, { data: [{ id: OTHER_CHANNEL, name: 'some-other-channel' }] }) }),
  }, { pathname: '/new' });
  assert.deepEqual(off.sb.requests.filter(q => q.path.startsWith('/v1/')).length, 1);
});

test('page helper (export): the stand-in for the tab\'s workspace stays only when the site names nothing', async () => {
  // Neither the list nor the channel's own record answers: the first error
  // is kept, by its path alone, and the panel offers the workspace by id.
  const missing = await probeProjectsOn({
    fault: answering({
      '/v1/code/channels': () => jsonReply(404, { error: { message: 'Not found' } }),
      [`/v1/code/channels/${CHANNEL}`]: () => jsonReply(404, { error: { message: 'Channel not found' } }),
    }),
  });
  assert.equal(missing.found.error, 'HTTP 404 from /v1/code/channels');
  assert.ok(!missing.found.error.includes('?'));
  assert.deepEqual(missing.sb.requests.filter(q => q.path.startsWith('/v1/')).map(q => q.path.split('?')[0]), ['/v1/code/channels', `/v1/code/channels/${CHANNEL}`]);
  const standIn = dupMod.projectChoices(missing.found).projects[0];
  assert.equal(standIn.id, CHANNEL);
  assert.equal(standIn.name, '');
  assert.match(standIn.label, /^This tab's workspace \(chan_/);
  // A list that is refused is not followed by the channel by itself.
  const refused = await probeProjectsOn({ fault: answering({ '/v1/code/channels': () => jsonReply(403, { error: { message: 'Permission denied.' } }) }) });
  assert.equal(refused.found.error, 'HTTP 403 from /v1/code/channels');
  assert.equal(refused.sb.requests.filter(q => q.path.startsWith('/v1/')).length, 1);
  assert.equal(dupMod.projectChoices(refused.found).projects[0].name, '');
  // The site has the channel but gives it no name, title or topic: it is
  // listed as it is, an unnamed project, with no name to send.
  const unnamed = await probeProjectsOn({
    fault: answering({
      '/v1/code/channels': () => jsonReply(200, { data: [{ id: CHANNEL, name: '' }] }),
      [`/v1/code/channels/${CHANNEL}`]: () => jsonReply(200, { channel: { id: CHANNEL, name: '  ' } }),
    }),
  });
  assert.equal(unnamed.found.error, null);
  const row = dupMod.projectChoices(unnamed.found).projects[0];
  assert.deepEqual([row.id, row.name, row.label], [CHANNEL, '', '(unnamed project)']);
  // A record with only a topic is named by it, as the script names the
  // project's folder.
  const topic = await probeProjectsOn({ fault: answering({ '/v1/code/channels': () => jsonReply(200, { data: [{ id: CHANNEL, topic: 'Scores\nand parts' }] }) }) });
  assert.equal(topic.found.projects.find(p => p.id === CHANNEL).name, 'Scores and parts');
});

test('page helper (export): a list longer than 64 KiB is still read, and one that is not a list says so', async () => {
  const many = [];
  for (let i = 0; i < 300; i++) many.push({ id: `chan_01FILLER${String(i).padStart(16, '0')}`, name: `filler ${i}`, topic: 'x'.repeat(400), members: [{ account_id: 'someone' }] });
  many.push({ id: CHANNEL, name: 'beethoven', members: [{ account_id: 'me' }] });
  const body = { data: many };
  assert.ok(JSON.stringify(body).length > 2 * 65536);
  const long = await probeProjectsOn({ fault: answering({ '/v1/code/channels': () => jsonReply(200, body) }) });
  assert.equal(long.found.error, null);
  assert.equal(long.found.projects.filter(p => p.kind === 'code').length, 301);
  assert.equal(long.found.projects.find(p => p.id === CHANNEL).name, 'beethoven');
  assert.equal(long.sb.requests.filter(q => q.path.startsWith('/v1/')).length, 1, 'found in the list, not asked for by itself');
  // A list that answers with something other than a list is said, not
  // taken for an empty one; the tab's channel is still asked for by itself.
  const garbled = await probeProjectsOn({
    fault: answering({
      '/v1/code/channels': () => new Response('<html>not a list</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      [`/api/organizations/${ORG_CHAT}/projects`]: () => jsonReply(200, { unexpected: true }),
    }),
  });
  assert.equal(garbled.found.error, 'the list could not be read from /v1/code/channels');
  assert.equal(garbled.found.orgs[0].error, 'the list could not be read');
  assert.deepEqual(garbled.found.projects.map(p => [p.id, p.name]), [[CHANNEL, 'beethoven']]);
});

test('page helper (export): the channel list is read page by page, with the cursor the site names, and the tally says how it went', async () => {
  const FIRST = 'chan_01PAGEONE000000000000000';
  const SECOND = 'chan_01PAGETWO000000000000000';
  const LIST = '/v1/code/channels?scope=joined&include_members=true&include_archived=true&limit=200';
  const byCursor = pages => answering({ '/v1/code/channels': url => jsonReply(200, pages[url.searchParams.get('cursor') || '']) });
  const v1Paths = sb => sb.requests.filter(q => q.path.startsWith('/v1/')).map(q => q.path);
  const code = found => found.projects.filter(p => p.kind === 'code').map(p => [p.id, p.name]);
  // Three pages: the cursor goes on the same request, and the rows of
  // every page count; the tab's channel, named on the second, is not
  // asked for by itself.
  const paged = await probeProjectsOn({ fault: byCursor({
    '': { data: [{ id: FIRST, name: 'first page', members: [{ account_id: 'me' }] }], next_cursor: 'cur-2' },
    'cur-2': { data: [{ id: SECOND, name: 'second page' }, { id: CHANNEL, name: 'beethoven' }], next_cursor: 'cur-3' },
    'cur-3': { data: [] },
  }) });
  assert.deepEqual(v1Paths(paged.sb), [LIST, `${LIST}&cursor=cur-2`, `${LIST}&cursor=cur-3`]);
  assert.deepEqual(code(paged.found), [[FIRST, 'first page'], [SECOND, 'second page'], [CHANNEL, 'beethoven']]);
  assert.equal(paged.found.error, null);
  assert.deepEqual(paged.found.codeList, { status: 200, rows: 3, pages: 3, complete: true });
  assert.equal(paged.w.permits.filter(p => p.path === '/v1/code/channels').length, 3, 'each page is permitted, by the path alone');
  for (const p of paged.found.projects) assert.deepEqual(Object.keys(p).sort(), ['archived', 'id', 'kind', 'name', 'orgName', 'orgUuid']);
  assert.equal(dupMod.codeListEmpty(dupMod.projectChoices(paged.found)), false);
  assert.equal(dupMod.listingSummary(dupMod.projectChoices(paged.found)).error, null);
  // A cursor given as an address counts for the token in its query, and
  // one under `next` or `cursor.next` is read too.
  const addressed = await probeProjectsOn({ fault: byCursor({
    '': { data: [{ id: FIRST, name: 'first page' }], next_cursor: `https://claude.ai${LIST}&cursor=cur%202` },
    'cur 2': { data: [{ id: CHANNEL, name: 'beethoven' }], cursor: { next: 'cur-3' } },
    'cur-3': { data: [{ id: SECOND, name: 'second page' }], next: 'cur-4' },
    'cur-4': { data: [], next: null },
  }) });
  assert.deepEqual(v1Paths(addressed.sb), [LIST, `${LIST}&cursor=cur%202`, `${LIST}&cursor=cur-3`, `${LIST}&cursor=cur-4`]);
  assert.deepEqual(addressed.found.codeList, { status: 200, rows: 3, pages: 4, complete: true });
  assert.equal(addressed.found.error, null);
  // The same cursor twice means the site ignored it: the listing stops,
  // says so, and keeps what it read.
  const looping = await probeProjectsOn({ fault: byCursor({
    '': { data: [{ id: FIRST, name: 'first page' }], next_cursor: 'cur-2' },
    'cur-2': { data: [{ id: CHANNEL, name: 'beethoven' }], next_cursor: 'cur-2' },
  }) });
  assert.deepEqual(v1Paths(looping.sb), [LIST, `${LIST}&cursor=cur-2`]);
  assert.equal(looping.found.error, 'the list did not end after 2 pages from /v1/code/channels');
  assert.deepEqual(code(looping.found), [[FIRST, 'first page'], [CHANNEL, 'beethoven']]);
  assert.deepEqual(looping.found.codeList, { status: 200, rows: 2, pages: 2, complete: false });
  // A list that never ends is left after ten pages.
  let served = 0;
  const endless = await probeProjectsOn({ fault: answering({ '/v1/code/channels': url => {
    served++;
    const n = Number(url.searchParams.get('cursor') || 0);
    return jsonReply(200, { data: [{ id: `chan_01ENDLESS${String(n).padStart(15, '0')}`, name: `page ${n}` }], next_cursor: String(n + 1) });
  } }) });
  assert.equal(served, 10);
  assert.equal(endless.found.error, 'the list did not end after 10 pages from /v1/code/channels');
  assert.equal(code(endless.found).filter(([id]) => id.startsWith('chan_01ENDLESS')).length, 10);
  assert.equal(v1Paths(endless.sb).pop(), `/v1/code/channels/${CHANNEL}`, 'the tab\'s channel is still asked for by itself');
  assert.deepEqual(endless.found.codeList, { status: 200, rows: 10, pages: 10, complete: false });
  // A later page that fails is noted; the first page's rows still count,
  // and the tab's channel, missing so far, is asked for by itself since
  // the list did answer.
  const cut = await probeProjectsOn({ fault: answering({ '/v1/code/channels': url => (url.searchParams.get('cursor')
    ? new Response('<html>not a list</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    : jsonReply(200, { data: [{ id: FIRST, name: 'first page' }], next_cursor: 'cur-2' })) }) });
  assert.deepEqual(v1Paths(cut.sb), [LIST, `${LIST}&cursor=cur-2`, `/v1/code/channels/${CHANNEL}`]);
  assert.equal(cut.found.error, 'the list could not be read from /v1/code/channels');
  assert.deepEqual(code(cut.found), [[FIRST, 'first page'], [CHANNEL, 'beethoven']]);
  assert.deepEqual(cut.found.codeList, { status: 200, rows: 1, pages: 1, complete: false });
  const failing = await probeProjectsOn({ fault: answering({ '/v1/code/channels': url => (url.searchParams.get('cursor') ? jsonReply(500, { error: { message: 'Internal server error' } }) : jsonReply(200, { data: [{ id: FIRST, name: 'first page' }], next_cursor: 'cur-2' })) }) });
  assert.deepEqual(v1Paths(failing.sb), [LIST, `${LIST}&cursor=cur-2`, `/v1/code/channels/${CHANNEL}`]);
  assert.equal(failing.found.error, 'HTTP 500 from /v1/code/channels');
  assert.deepEqual(code(failing.found), [[FIRST, 'first page'], [CHANNEL, 'beethoven']]);
  assert.deepEqual(failing.found.codeList, { status: 200, rows: 1, pages: 1, complete: false });
  // A later page the worker holds on ends the listing there.
  const pathOf = (msg, w) => (w.permits.find(p => p.requestId === msg.requestId) || {}).path;
  let permits = 0;
  const held = await probeProjectsOn({ fault: byCursor({
    '': { data: [{ id: FIRST, name: 'first page' }], next_cursor: 'cur-2' },
    'cur-2': { data: [{ id: SECOND, name: 'second page' }], next_cursor: 'cur-3' },
  }) }, { verdictFor: (msg, w) => (pathOf(msg, w) === '/v1/code/channels' && ++permits === 2 ? { action: 'hold', reason: 'interrupted', verdict: 'interrupt', kind: 'challenge' } : null) });
  assert.deepEqual(v1Paths(held.sb), [LIST, `${LIST}&cursor=cur-2`]);
  assert.equal(held.found.error, 'interrupted from /v1/code/channels');
  assert.deepEqual(code(held.found), [[FIRST, 'first page']]);
  assert.deepEqual(held.found.codeList, { status: 200, rows: 1, pages: 1, complete: false });
});

test('page helper (export): an empty channel list is told from one that could not be read, and a few more shapes are read', async () => {
  // Empty: the tally says so, nothing is wrong, and the tab's channel is
  // asked for by itself; the panel says the list came back empty next to
  // the one project it could name, or on its own.
  const empty = await probeProjectsOn({ fault: answering({ '/v1/code/channels': () => jsonReply(200, { data: [] }) }) });
  assert.equal(empty.found.error, null);
  assert.deepEqual(empty.found.codeList, { status: 200, rows: 0, pages: 1, complete: true });
  assert.deepEqual(empty.sb.requests.filter(q => q.path.startsWith('/v1/')).map(q => q.path.split('?')[0]), ['/v1/code/channels', `/v1/code/channels/${CHANNEL}`]);
  assert.deepEqual(empty.found.projects.filter(p => p.kind === 'code').map(p => [p.id, p.name]), [[CHANNEL, 'beethoven']]);
  const emptyList = found => dupMod.codeListEmpty(dupMod.projectChoices(found));
  const problem = found => dupMod.listingSummary(dupMod.projectChoices(found)).error;
  assert.equal(emptyList(empty.found), true);
  assert.equal(problem(empty.found), null);
  const emptyOff = await probeProjectsOn({ fault: answering({ '/v1/code/channels': () => jsonReply(200, { data: [] }) }) }, { pathname: '/new' });
  assert.equal(emptyOff.found.projects.filter(p => p.kind === 'code').length, 0);
  assert.equal(emptyList(emptyOff.found), true);
  // Rows that name no channel are said: not an empty list.
  const unread = await probeProjectsOn({ fault: answering({ '/v1/code/channels': () => jsonReply(200, { data: [{ foo: 1 }, { channel_id: OTHER_CHANNEL }] }) }) });
  assert.equal(unread.found.error, 'no project in the list could be read from /v1/code/channels');
  assert.deepEqual(unread.found.codeList, { status: 200, rows: 2, pages: 1, complete: true });
  assert.deepEqual(unread.found.projects.filter(p => p.kind === 'code').map(p => p.id), [CHANNEL], 'the tab\'s channel, asked for by itself');
  assert.equal(emptyList(unread.found), false);
  assert.match(problem(unread.found), /^no project in the list/);
  // A row that pairs the channel's record with the membership, and one
  // that names the channel by its channel_id and a name, are read; so is
  // the channel's own answer in that pairing.
  const nested = await probeProjectsOn({ fault: answering({
    '/v1/code/channels': () => jsonReply(200, { data: [
      { channel: { id: OTHER_CHANNEL, name: 'paired', members: [{ account_id: 'me' }] }, membership: { account_id: 'me' } },
      { channel_id: 'chan_01BYCHANNELID00000000000', name: 'by channel_id', account_id: 'me', archived_at: '2026-10-01T00:00:00Z' },
    ] }),
    [`/v1/code/channels/${CHANNEL}`]: () => jsonReply(200, { channel: { id: CHANNEL, name: 'beethoven' }, membership: { account_id: 'me' } }),
  }) });
  assert.equal(nested.found.error, null);
  assert.deepEqual(nested.found.projects.filter(p => p.kind === 'code').map(p => [p.id, p.name, p.archived]),
    [[OTHER_CHANNEL, 'paired', false], ['chan_01BYCHANNELID00000000000', 'by channel_id', true], [CHANNEL, 'beethoven', false]]);
  for (const p of nested.found.projects) assert.deepEqual(Object.keys(p).sort(), ['archived', 'id', 'kind', 'name', 'orgName', 'orgUuid']);
  assert.deepEqual(nested.found.codeList, { status: 200, rows: 2, pages: 1, complete: true });
  // A list that is refused has its status in the tally and no page.
  const refused = await probeProjectsOn({ fault: answering({ '/v1/code/channels': () => jsonReply(403, { error: { message: 'Permission denied.' } }) }) });
  assert.deepEqual(refused.found.codeList, { status: 403, rows: 0, pages: 0, complete: false });
  assert.equal(emptyList(refused.found), false);
  assert.equal(problem(refused.found), 'HTTP 403 from /v1/code/channels');
});

test('page helper (export): a listing answer the worker holds on ends the listing, nothing more is asked', async () => {
  const pathOf = (msg, w) => (w.permits.find(p => p.requestId === msg.requestId) || {}).path;
  const holdOn = wanted => (msg, w) => (pathOf(msg, w) === wanted ? { action: 'hold', reason: 'interrupted', verdict: 'interrupt', kind: 'challenge' } : null);
  // The organization's list is interrupted: no channel is asked for.
  const atOrg = await probeProjectsOn({}, { verdictFor: holdOn(`/api/organizations/${ORG_CHAT}/projects`) });
  assert.equal(atOrg.sb.requests.filter(q => q.path.startsWith('/v1/')).length, 0);
  assert.equal(atOrg.found.error, `interrupted from /api/organizations/${ORG_CHAT}/projects`);
  assert.equal(atOrg.found.orgs[0].error, 'interrupted');
  // The channel list is interrupted although it leaves the tab's channel
  // out: the channel is not asked for by itself.
  const atList = await probeProjectsOn({
    fault: answering({ '/v1/code/channels': () => jsonReply(200, { data: [{ id: OTHER_CHANNEL, name: 'some-other-channel' }] }) }),
  }, { verdictFor: holdOn('/v1/code/channels') });
  assert.deepEqual(atList.sb.requests.filter(q => q.path.startsWith('/v1/')).map(q => q.path.split('?')[0]), ['/v1/code/channels']);
  assert.equal(atList.found.error, 'interrupted from /v1/code/channels');
  // A pass with an interrupt verdict (the gate already held) stops it too.
  const already = await probeProjectsOn({}, { verdictFor: (msg, w) => (pathOf(msg, w) === `/api/organizations/${ORG_CHAT}/projects` ? { action: 'pass', verdict: 'interrupt', kind: 'challenge' } : null) });
  assert.equal(already.sb.requests.filter(q => q.path.startsWith('/v1/')).length, 0);
});

test('page.js lists with the export script\'s own requests, copied word for word', () => {
  const api = EXPORTER_SRC.match(/const API = '([^']+)';/)[1];
  const list = EXPORTER_SRC.match(/list: `\$\{API\}([^`]+)`/)[1];
  const channels = EXPORTER_SRC.match(/\n\s+channels: '([^']+)'/)[1];
  const channel = EXPORTER_SRC.match(/\n\s+channel: '([^']+)'/)[1];
  const version = EXPORTER_SRC.match(/'anthropic-version': '([^']+)'/)[1];
  assert.ok(PAGE_SRC.includes(`var PROJECTS_PATH = '${api}${list}';`));
  assert.ok(PAGE_SRC.includes(`var CHANNELS_PATH = '${channels}';`));
  assert.ok(PAGE_SRC.includes(`var CHANNEL_PATH = '${channel}';`));
  assert.ok(PAGE_SRC.includes(`var V1_VERSION = '${version}';`));
});

test('page helper (export): off the project\'s page the script\'s question is answered with the chosen project, or not at all', async () => {
  const mock = makeServer({}, SIZES);
  const { w, end } = await exportThrough({ mock, boot: { ...EXPORT_BOOT, project: RECIPES_PROJECT }, pathname: '/new' });
  assert.equal(end.kind, 'done');
  const prompts = w.events.filter(e => e.kind === 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].promptKind, 'project');
  assert.match(prompts[0].question, /^Which project should be exported\?/);
  assert.match(prompts[0].answer, /^[0-9]+$/);
  assert.ok(Object.keys(w.written).length > 0);
  assert.ok(Object.keys(w.written).every(p => p.startsWith('Recipes/')), JSON.stringify(Object.keys(w.written)));
  // A project the script does not list gets no answer: the script stops
  // and says nothing, the worker hears the null answer, nothing is written.
  const w2 = makeScriptedWorker();
  const sb2 = makePageSandbox({ server: makeServer({}, SIZES).server, worker: w2, boot: { ...EXPORT_BOOT, project: { ...RECIPES_PROJECT, name: 'Nothing like it' } } });
  sb2.create();
  await settle();
  await sb2.runExporter();
  await until(() => w2.events.some(e => e.kind === 'ready'), 'the button');
  w2.push({ type: 'press' });
  await until(() => w2.events.some(e => e.kind === 'prompt'), 'the question');
  await settle(20);
  assert.deepEqual(w2.events.filter(e => e.kind === 'prompt').map(e => [e.promptKind, e.answer]), [['project', null]]);
  assert.deepEqual(w2.writes, []);
  assert.ok(!w2.events.some(e => e.kind === 'done' || e.kind === 'failed'));
  assert.equal(sb2.sandbox.__cswapImport.state().pickerCalls, 0);
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
  assert.deepEqual(sent[0], { type: 'page.state', url: 'https://claude.ai/new', title: 'Just a moment...', markers: ['#challenge-form'], hints: [], hasImporter: true, hasExporter: false, online: true });
  assert.deepEqual(JSON.parse(JSON.stringify(api.probe())), { url: 'https://claude.ai/new', title: 'Just a moment...', markers: ['#challenge-form'], hints: [], hasImporter: true, hasExporter: false, online: true });
  const offline = makeContentEnv({ online: false, url: 'https://claude.ai/login?token=secret' });
  offline.create();
  await settle();
  assert.deepEqual(offline.ports[0].client.sent[0], { type: 'page.state', url: 'https://claude.ai/login', title: 'Claude', markers: [], hints: [], hasImporter: false, hasExporter: false, online: false });
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
  // A hello that says where cswap was installed from keeps it with the
  // rest, so the panel can tell a checkout from an older branch with the
  // same version number; the hello above, which says nothing, stores
  // nothing for it.
  const source = 'duplicate-fixes@3612c92 of https://github.com/OpenSpineConsortium/claude-swap-cloud';
  const hs = makeNativeHarness({ hostReplies: port => port.onMessage.addListener(m => { if (m.type === 'hello') port.postMessage({ re: m.id, ...goodHello, source }); }) });
  await hs.native.connect({});
  assert.equal(hs.store().lastHello.source, source, 'where that cswap came from is kept with its hello');
  for (const bad of [{ ...goodHello, product: 'other' }, { ...goodHello, protocol: 2 }, { re: 0, type: 'job' }]) {
    const hb = makeNativeHarness({ hostReplies: port => port.onMessage.addListener(m => port.postMessage({ ...bad, re: m.id })) });
    await assert.rejects(hb.native.connect({}), e => e.code === 'protocol');
    assert.equal(hb.native.isConnected(), false);
    assert.equal(hb.store().connected, false);
    assert.equal(hb.store().lastErrorCode, 'protocol');
  }
  assert.equal(h.store().lastErrorCode, null, 'a good hello clears the code');
  const herr = makeNativeHarness({ hostReplies: port => port.onMessage.addListener(m => port.postMessage({ re: m.id, type: 'error', code: 'protocol' })) });
  await assert.rejects(herr.native.connect({}), e => e.code === 'protocol');
  // Closing the port from this side is told to the store too (Chrome fires
  // no onDisconnect for the side that closed), with the hello kept.
  h.native.disconnect();
  await settle();
  assert.equal(h.store().connected, false);
  assert.equal(h.store().lastHello.cswap, '0.27.0b1');
  assert.equal(h.store().lastErrorCode, null);
  assert.equal(h.store().disconnectedAt, h.timers.now());
});

test('native.js: a host that answered before but exits before the next hello forgets the hello; one that exits after keeps it', async () => {
  let ports = 0;
  const h = makeNativeHarness({ hostReplies: port => port.onMessage.addListener(m => {
    if (m.type !== 'hello') return;
    ports += 1;
    if (ports === 1) port.postMessage({ re: m.id, ...goodHello });
    else port.disconnect();
  }) });
  await h.native.connect({});
  assert.equal(h.store().lastHello.cswap, '0.27.0b1');
  h.native.disconnect();
  await settle();
  // cswap was removed since: the host Chrome starts exits before answering.
  h.setLastError('Native host has exited.');
  await assert.rejects(h.native.connect({}), e => e.code === 'disconnected');
  await settle();
  assert.equal(h.store().connected, false);
  assert.equal(h.store().lastHello, null, 'the panel must not say "last seen" for a host that no longer answers');
  assert.equal(h.store().lastErrorCode, 'disconnected');
  // A host that answered and then left with the idle worker is only a reconnect away.
  const idle = makeNativeHarness({ hostReplies: port => port.onMessage.addListener(m => { if (m.type === 'hello') port.postMessage({ re: m.id, ...goodHello }); }) });
  await idle.native.connect({});
  idle.setLastError('Native host has exited.');
  idle.pairs[0].server.disconnect();
  await settle();
  assert.equal(idle.store().connected, false);
  assert.equal(idle.store().lastHello.cswap, '0.27.0b1');
  assert.equal(idle.store().lastErrorCode, 'disconnected');
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
  assert.equal(h.store().lastErrorCode, 'no-host', 'the panel\'s setup list reads the code');
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
      // One window, focused; a query keeps the tabs its filters name.
      list: tabs, reloaded: [], updated: [], reload: async id => { chrome.tabs.reloaded.push(id); }, onRemoved: fakeEvent(),
      query: async (q = {}) => tabs.filter(t => (q.active === undefined || !!t.active === q.active) && (!q.url || String(t.url || '').startsWith('https://claude.ai/'))),
      update: async (id, info) => { chrome.tabs.updated.push({ tabId: id, ...info }); const tab = tabs.find(t => t.id === id); if (tab && info && info.url) tab.url = info.url; return tab; },
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
const ENDING_EVENTS = new Set(['done', 'failed', 'cancelled']);

function fakeModules({ hostJob, listing, scriptText = '(async () => {})();', verdictFor = () => null, identityOf = () => null, pageOf = () => null, cancelRequested = () => false, duplicate = null, forwardLogs = false, dropCapable = false } = {}) {
  // `duplicate` turns on the bridge's Duplicate side: the account list,
  // an export job, the choice recorded on it, the pieces written, and the
  // import queued from the finished export. `capable: false` is an older
  // cswap; `refuseWrite` and `queueError` script the refusals;
  // `serveJobGet` answers job.get with the host's current job.
  // `drivenCapable` lists the capability of the import in a window of its
  // own; `drivenState` is what the host says of that import, and
  // `drivenError` refuses its start, `drivenStateError` every question about it.
  // `newError` refuses export.new with that code and message. `dropCapable`
  // (beside `duplicate`) lists the capability of dropping a job, and
  // job.drop then ends the host's job of that id as cancelled, recorded in
  // `drops`. `onDisk` is what is on the computer for the Open window to
  // find beside the export this browser made: each entry an export (a
  // folder or a .tar) by its path, which the window's choice names as it
  // is or by the export.json inside its folder (`dialogsCapable: false`
  // is a cswap that cannot open the file windows), and import.queue with
  // the window's id takes the export chosen in it, as bridge.py does.
  const dupl = duplicate ? { accounts: DUP_ACCOUNTS(), capable: true, refuseWrite: null, queueError: null, serveJobGet: false, drivenCapable: false, drivenError: null, drivenStateError: null, newError: null, onDisk: [], dialogsCapable: true, ...duplicate, chooses: [], written: {}, files: 0, bytes: 0, exportJob: null, importJob: null, drivenState: null, drivenStarts: 0 } : null;
  const made = { events: [], requests: [], hello: null, helloReply: null, logs: [], raised: [], notifications: [], gateCalls: [], duplicate: dupl, drops: [], windows: [] };
  // The file windows the fake host opened, each as bridge.py records it,
  // the open one (at most one) last. The test plays the person at it:
  // chooseInWindow(path) is a choice, closeWindow() the window closed
  // without one, failWindow(why) a window that could not open. A choice
  // in the Save As window places the export job's .tar, as the host's
  // _apply_save_choice does when the worker next asks.
  made.openWindow = () => made.windows.find(w => w.open) || null;
  const endWindow = fields => {
    const w = made.openWindow();
    if (!w) throw new Error('no file window is open');
    Object.assign(w, { open: false }, fields);
    if (dupl && w.purpose === 'save' && w.chosen) {
      w.path = /\.tar$/i.test(w.path) ? w.path : `${w.path}.tar`;
      const j = dupl.exportJob;
      if (j && j.id === w.job && !ENDING_EVENTS.has(j.status)) j.export = { ...j.export, path: w.path, archive: true, folder: w.path.replace(/[\\/][^\\/]*$/, ''), top: '' };
    }
    return w;
  };
  made.chooseInWindow = path => endWindow({ chosen: true, path });
  made.closeWindow = () => endWindow({ cancelled: true });
  made.failWindow = why => endWindow({ error: why });
  // The fake host answers in the order it is asked, as bridge.py's serve
  // loop does, and applies an event when it receives it, before its answer
  // goes back. `wire` is everything sent, in order. With `holdAcks` the
  // answers to events wait until the test releases them with ackNext(code):
  // no code acknowledges the oldest, a code refuses it, and 'disconnected'
  // drops the port as native.js does (every held answer fails, the
  // disconnect listeners are told). `holdRequests` names request types
  // whose answers wait for releaseRequest(). `refuseEvents` refuses the next
  // events with the codes listed, one each. With `duplicate` the host holds
  // one current job: export.new makes the export current, import.queue the
  // import, and an event for any other job is refused 'not-claimed'.
  Object.assign(made, { wire: [], holdAcks: false, heldAcks: [], holdRequests: new Set(), heldRequests: [], refuseEvents: [], connects: 0, refuseConnect: false, current: null, forward: null });
  const createLogger = ({ forward } = {}) => {
    // The worker hands the logger its forwarder; the test may call it, and
    // with `forwardLogs` every warning and error goes through it as the
    // real logger's do.
    made.forward = forward || null;
    const record = (level, event, msg, data, job) => {
      const r = { level, event, msg, data, job };
      made.logs.push(r);
      if (forwardLogs && forward && (level === 'warn' || level === 'error')) forward(r);
    };
    return {
      load: async () => {}, clear: async () => { made.logs.length = 0; }, exportText: () => made.logs.map(r => JSON.stringify(r)).join('\n'),
      setLevel: () => {}, setLimits: () => {}, records: () => made.logs,
      debug: (event, msg, data, job) => record('debug', event, msg, data, job),
      info: (event, msg, data, job) => record('info', event, msg, data, job),
      warn: (event, msg, data, job) => record('warn', event, msg, data, job),
      error: (event, msg, data, job) => record('error', event, msg, data, job),
    };
  };
  let cfg = { version: 2, readSpacingMs: 0, writeSpacingMs: 500, retryAfterCapMs: 900000, requestTimeoutMs: 120000, notifications: true, logLevel: 'info', logMaxRecords: 2000, logRetentionHours: 72 };
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
  const createGate = ({ store, onChange, classify, config }) => {
    // The worker's config reader, kept so a test can ask what the gate would
    // be handed right now.
    made.gateConfig = config;
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
  const failure = (code, message = `fake ${code}`) => { const e = new Error(message); e.code = code; return e; };
  // The port drops: what waits for an answer fails, as native.js does it.
  made.dropPort = () => {
    connected = false;
    for (const held of made.heldAcks.splice(0)) held.reject(failure('disconnected'));
    for (const held of made.heldRequests.splice(0)) held.reject(failure('disconnected'));
    for (const fn of [...disconnectListeners]) fn(failure('disconnected'));
  };
  // The port is back without the worker asking (for a test of the queue alone).
  made.restorePort = () => { connected = true; };
  made.isConnected = () => connected;
  made.ackNext = code => {
    if (!made.heldAcks.length) throw new Error('no answer is held');
    if (code === 'disconnected') { made.dropPort(); return; }
    const held = made.heldAcks.shift();
    if (code) held.reject(failure(code)); else held.resolve();
  };
  made.releaseRequest = () => {
    const held = made.heldRequests.shift();
    if (!held) throw new Error('no request is held');
    held.settle();
  };
  const createNative = () => ({
    connect: async hello => {
      made.connects++;
      if (made.refuseConnect) throw failure('no-host', 'the cswap bridge is not registered');
      made.hello = hello;
      connected = true;
      const capabilities = ['job', 'export', 'script', 'events', 'account'];
      if (dupl && dupl.capable !== false) capabilities.push('duplicate');
      if (dupl && dupl.capable !== false && dupl.dialogsCapable !== false) capabilities.push('dialogs');
      if (dupl && dupl.drivenCapable) capabilities.push('driven');
      if (dropCapable) capabilities.push('drop');
      made.helloReply = {
        type: 'hello', protocol: 1, product: 'claude-swap', cswap: '0.27.0b1', backup_dir: 'x', capabilities,
        // The older cswap of the tests says where it came from, as a real one does.
        ...(dupl && dupl.dialogsCapable === false ? { source: 'duplicate-fixes@3612c92 of https://github.com/OpenSpineConsortium/claude-swap-cloud' } : {}),
      };
      return made.helloReply;
    },
    lastHello: () => made.helloReply,
    isConnected: () => connected,
    disconnect: () => { connected = false; },
    onDisconnect: fn => { disconnectListeners.add(fn); return () => disconnectListeners.delete(fn); },
    request: async msg => {
      made.requests.push(msg);
      made.wire.push(`request:${msg.type}`);
      if (!connected) throw failure('disconnected', 'not connected');
      // Received now (an import.queue makes the import current now), answered
      // now or, for a held type, when the test says so.
      let outcome;
      try { outcome = { value: answer(msg) }; } catch (e) { outcome = { error: e }; }
      if (made.holdRequests.has(msg.type)) {
        return new Promise((resolve, reject) => made.heldRequests.push({ msg, reject, settle: () => (outcome.error ? reject(outcome.error) : resolve(outcome.value)) }));
      }
      if (outcome.error) throw outcome.error;
      return outcome.value;
    },
    requestStream: async (msg, onPart) => {
      made.requests.push(msg);
      const bytes = listing.tree[msg.path];
      if (bytes === undefined) { const e = new Error('not found'); e.code = 'not-found'; throw e; }
      onPart({ type: 'file.chunk', path: msg.path, offset: 0, data: Buffer.from(bytes).toString('base64'), last: true });
      return { last: true };
    },
    event: body => {
      made.wire.push(`event:${body.event}`);
      if (!connected) return Promise.reject(failure('disconnected'));
      const refusal = made.refuseEvents.length ? made.refuseEvents.shift()
        : dupl && made.current && body.job && body.job !== made.current ? 'not-claimed' : null;
      if (refusal) return Promise.reject(failure(refusal));
      made.events.push(body);
      // Applied on receipt, as bridge.py's _event does under its lock.
      const held = dupl ? [dupl.exportJob, dupl.importJob].find(j => j && j.id === body.job) : (hostJob && hostJob());
      if (held && held.id === body.job && ENDING_EVENTS.has(body.event)) held.status = body.event;
      if (held && held.id === body.job && body.event === 'account' && held.account && held.account.signed_in === true && !held.account.email && body.email) held.account = { ...held.account, email: body.email };
      const ack = { cancel_requested: cancelRequested(body), ack: {} };
      if (!made.holdAcks) return Promise.resolve(ack);
      return new Promise((resolve, reject) => made.heldAcks.push({ body, resolve: () => resolve(ack), reject }));
    },
  });
  function answer(msg) {
    {
      if (dupl) {
        const copy = v => JSON.parse(JSON.stringify(v));
        if (msg.type === 'accounts.list') return { type: 'accounts', accounts: copy(dupl.accounts) };
        if (msg.type === 'export.new') {
          if (dupl.newError) throw failure(dupl.newError.code, dupl.newError.message);
          dupl.exportJob = EXPORT_JOB();
          dupl.exportJob.claimed_by = { instance: msg.instance || 'i', at: 'now', extension_version: msg.extension_version };
          made.current = dupl.exportJob.id;
          return { type: 'job', job: copy(dupl.exportJob) };
        }
        if (msg.type === 'export.choose') {
          dupl.chooses.push(copy(msg));
          const j = dupl.exportJob;
          // An account to copy into is an older panel's; the worker sends none.
          const dest = msg.destination ? dupl.accounts.find(a => a.slot === msg.destination) || null : null;
          j.duplicate = { project: copy(msg.project), destination: dest ? { slot: dest.slot, email: dest.email, org_uuid: dest.org_uuid || '', organization: dest.organization } : null, name: msg.name, import_job: null };
          j.export = { ...j.export, name: msg.project.name, kind: msg.project.kind };
          j.account = { slot: '', email: msg.source.email, org_uuid: msg.source.org_uuid };
          return { type: 'job', job: copy(j) };
        }
        if (msg.type === 'file.write') {
          const refusal = dupl.refuseWrite ? dupl.refuseWrite(msg) : null;
          if (refusal) { const e = new Error(`refused: ${refusal}`); e.code = refusal; throw e; }
          const piece = Buffer.from(msg.data, 'base64');
          dupl.written[msg.path] = Buffer.concat([dupl.written[msg.path] || Buffer.alloc(0), piece]);
          if (msg.last) { dupl.files++; dupl.bytes += dupl.written[msg.path].length; }
          return { type: 'written', path: msg.path, size: dupl.written[msg.path].length, files: dupl.files, bytes: dupl.bytes, cancel_requested: false, export_path: dupl.exportJob ? dupl.exportJob.export.path : '' };
        }
        // The export this browser made is on the computer too, where the
        // Save As window put it.
        const ownOnDisk = () => (dupl.exportJob && dupl.exportJob.status === 'done' && dupl.exportJob.export.path
          ? [{ path: dupl.exportJob.export.path, name: dupl.exportJob.export.name, kind: dupl.exportJob.export.kind, files: dupl.files, conversations: 0, bytes: dupl.bytes, finished_at: '2026-10-07T09:25:06Z', archive: dupl.exportJob.export.archive === true }]
          : []);
        // The file windows, as bridge.py's open_dialog, dialog_state and
        // close_dialog: one at a time; the Save As for the export job that
        // has its project and no place yet, the Open while no job is
        // unfinished; asked for the same window again, its state.
        const windowState = w => ({ id: w.id, purpose: w.purpose, job: w.job, open: w.open, chosen: w.chosen && !!w.path && !w.error, cancelled: w.cancelled, error: w.error, path: w.chosen && !w.error ? w.path : '', tool: 'fake' });
        if (msg.type === 'dialog.open' && dupl.dialogsCapable !== false) {
          const open = made.openWindow();
          if (open && open.purpose === msg.purpose && (open.job || null) === (msg.job || null)) return { type: 'dialog', dialog: windowState(open) };
          if (open) throw failure('dialog-open', `the ${open.purpose === 'save' ? 'Save As' : 'Open'} window is open already; choose in it or close it first`);
          const current = [dupl.exportJob, dupl.importJob].find(j => j && j.id === made.current) || null;
          if (msg.purpose === 'save') {
            const ex = dupl.exportJob;
            if (!ex || ex.id !== msg.job || made.current !== ex.id) throw failure('not-claimed', `job ${msg.job} is not this browser's current job`);
            if (!ex.duplicate || !ex.duplicate.project) throw failure('not-chosen', 'the export job has no project chosen yet');
            if (ex.export.path) throw failure('placed', `the export goes to ${ex.export.path} already`);
          } else if (msg.purpose === 'open') {
            if (current && !ENDING_EVENTS.has(current.status)) throw failure('job-active', `An import is already queued or running (job ${current.id})`);
          } else throw failure('bad-purpose', 'a file window is for a save or an open');
          const w = { id: `dlg_${String(made.windows.length + 1).padStart(12, '0')}`, purpose: msg.purpose, job: msg.purpose === 'save' ? msg.job : null, open: true, chosen: false, cancelled: false, error: '', path: '', consumed: false };
          made.windows.push(w);
          return { type: 'dialog', dialog: windowState(w) };
        }
        if ((msg.type === 'dialog.state' || msg.type === 'dialog.close') && dupl.dialogsCapable !== false) {
          const w = made.windows.find(x => x.id === msg.dialog) || null;
          if (!w) throw failure('not-dialog', `no file window ${msg.dialog}`);
          if (msg.type === 'dialog.close' && w.open) Object.assign(w, { open: false, cancelled: true });
          return { type: 'dialog', dialog: windowState(w) };
        }
        if (msg.type === 'import.queue' && msg.job === undefined && msg.dialog !== undefined) {
          // As bridge.py's queue_import_of_dialog: the export the Open
          // window's choice names (a .tar, a folder, or the export.json
          // inside one), into whoever is signed in, refused while a job is
          // unfinished; the choice is taken once, and asked again for the
          // same export, the import already queued.
          const w = made.windows.find(x => x.id === msg.dialog && x.purpose === 'open') || null;
          if (!w) throw failure('not-dialog', `no Open window ${msg.dialog}`);
          if (w.open) throw failure('dialog-open', 'the Open window is still open; choose the export in it first');
          if (w.error) throw failure('not-an-export', w.error);
          if (!w.chosen) throw failure('dialog-cancelled', 'the Open window was closed without a choice; press Import to open it again');
          if (w.consumed) throw failure('dialog-used', 'that choice was imported already; press Import to choose again');
          const inside = w.path.replace(/[\\/]export\.json$/i, '');
          const found = [...ownOnDisk(), ...dupl.onDisk].find(e => e.path === w.path || e.path === inside) || null;
          if (!found) throw failure('not-an-export', `${w.path} is not a project export: choose its .tar, or the export.json inside its folder`);
          if (dupl.queueError) { const e = new Error(dupl.queueError.message); e.code = dupl.queueError.code; throw e; }
          const already = dupl.importJob;
          if (already && already.export.path === found.path && !ENDING_EVENTS.has(already.status)) { w.consumed = true; return { type: 'job', job: copy(already) }; }
          const current = [dupl.exportJob, dupl.importJob].find(j => j && j.id === made.current) || null;
          if (current && !ENDING_EVENTS.has(current.status)) throw failure('job-active', `An import is already queued or running (job ${current.id})`);
          dupl.importJob = {
            ...HOST_JOB(), id: 'job_20261005T150200_d4e5f6', status: 'queued', kind: 'import',
            export: { path: found.path, archive: found.archive === true, name: found.name, kind: found.kind, files: found.files || 0, conversations: 0, bytes: 0 },
            account: { slot: '', email: '', org_uuid: '', signed_in: true }, name: typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim() : null,
            duplicate: null,
          };
          w.consumed = true;
          made.current = dupl.importJob.id;
          return { type: 'job', job: copy(dupl.importJob) };
        }
        if (msg.type === 'import.queue') {
          if (dupl.queueError) { const e = new Error(dupl.queueError.message); e.code = dupl.queueError.code; throw e; }
          const ex = dupl.exportJob;
          // Asked again for the same export: the import already queued from it.
          const already = dupl.importJob;
          if (already && already.duplicate.export_job === msg.job && !ENDING_EVENTS.has(already.status)) return { type: 'job', job: copy(already) };
          if (!ex || ex.id !== msg.job) throw failure('not-claimed', `job ${msg.job} is not this browser's current job`);
          // As bridge.py: only an export the host has heard finish; the name
          // given now is recorded on the export job, and so is an account
          // an older panel gives. With `signed_in` the import names no
          // account until the worker's account event names the one found.
          if (ex.status !== 'done') throw failure('not-done', `the export job ${ex.id} is ${ex.status}, not done`);
          if (msg.destination !== undefined && msg.signed_in !== true) {
            const dest = dupl.accounts.find(a => a.slot === msg.destination || (a.alias && a.alias === msg.destination) || (a.email && a.email === msg.destination)) || null;
            if (!dest) throw failure('no-account', `No account found with identifier: ${msg.destination}`);
            if (!dest.usable) throw failure('account-unusable', `Account-${dest.slot} cannot take an import: ${dest.why}`);
            ex.duplicate.destination = { slot: dest.slot, email: dest.email, org_uuid: dest.org_uuid || '', organization: dest.organization };
          }
          if (msg.name !== undefined) ex.duplicate.name = typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim() : null;
          const dest = ex.duplicate.destination;
          if (msg.signed_in !== true && !(dest && dest.email)) throw failure('not-chosen', 'the export job names no destination account');
          dupl.importJob = {
            ...HOST_JOB(), id: 'job_20261005T150100_c3d4e5', status: 'queued',
            export: { path: ex.export.path, archive: ex.export.archive === true, name: ex.export.name, kind: ex.export.kind, files: dupl.files, conversations: 0, bytes: dupl.bytes },
            account: msg.signed_in === true ? { slot: '', email: '', org_uuid: '', signed_in: true } : { slot: dest.slot, email: dest.email, org_uuid: ORG_CHAT }, name: ex.duplicate.name,
            duplicate: { export_job: ex.id, source: { email: ex.account.email, org_uuid: ex.account.org_uuid, project: copy(ex.duplicate.project) } },
          };
          made.current = dupl.importJob.id;
          return { type: 'job', job: copy(dupl.importJob) };
        }
        if (msg.type === 'import.driven' && dupl.drivenCapable) {
          // The host builds the command itself; the fake records only that it was asked.
          if (dupl.drivenError) throw failure(dupl.drivenError.code, dupl.drivenError.message);
          const ex = dupl.exportJob;
          if (!ex || ex.id !== msg.job || made.current !== ex.id) throw failure('not-claimed', `job ${msg.job} is not this browser's current job`);
          if (ex.status !== 'done') throw failure('not-done', `the export job ${ex.id} is ${ex.status}, not done`);
          if (dupl.drivenState && dupl.drivenState.running) return { type: 'driven', driven: copy(dupl.drivenState) };
          dupl.drivenStarts++;
          dupl.drivenState = {
            running: true, lost: false, pid: 4241 + dupl.drivenStarts, attempt: dupl.drivenStarts, started_at: '2026-10-06T19:30:00Z', ended_at: '',
            exit_code: null, url: '', carry_on: (dupl.drivenState && dupl.drivenState.carry_on) || '', made: '', message: '',
            command: 'cswap project-move auto --export="C:\\x\\beethoven.tar" --to 2', log: 'C:\\x\\bridge\\driven.log',
            tail: ['cswap: importing the copy the side panel\'s Duplicate exported.'],
          };
          return { type: 'driven', driven: copy(dupl.drivenState) };
        }
        if (msg.type === 'import.driven.state' && dupl.drivenCapable) {
          if (dupl.drivenStateError) throw failure(dupl.drivenStateError.code, dupl.drivenStateError.message);
          if (!dupl.drivenState || !dupl.exportJob || dupl.exportJob.id !== msg.job) throw failure('not-driven', 'no import in a window of its own');
          return { type: 'driven', driven: copy(dupl.drivenState) };
        }
        if (msg.type === 'job.get' && dupl.serveJobGet) {
          const current = [dupl.exportJob, dupl.importJob].find(j => j && j.id === made.current) || null;
          return { type: 'job', job: current ? copy(current) : null };
        }
        if (msg.type === 'job.claim') {
          const found = [dupl.exportJob, dupl.importJob].find(j => j && j.id === msg.job);
          if (found) { found.status = 'claimed'; found.claimed_by = { instance: msg.instance, at: 'now', extension_version: msg.extension_version }; return { type: 'job', job: copy(found) }; }
        }
      }
      if (msg.type === 'job.drop' && dropCapable) {
        made.drops.push(msg.job);
        const held = dupl ? [dupl.exportJob, dupl.importJob].find(j => j && j.id === msg.job) || null : (hostJob && hostJob()) || null;
        const active = !!held && held.id === msg.job && !ENDING_EVENTS.has(held.status);
        if (active) { held.status = 'cancelled'; held.phase = 'cancelled'; }
        return { type: 'job', job: held ? JSON.parse(JSON.stringify(held)) : null, dropped: active };
      }
      if (msg.type === 'job.get') return { type: 'job', job: hostJob() };
      if (msg.type === 'job.claim') { const job = hostJob(); if (!job) { const e = new Error('not queued'); e.code = 'not-queued'; throw e; } job.status = 'claimed'; job.claimed_by = { instance: msg.instance, at: 'now', extension_version: msg.extension_version }; return { type: 'job', job: JSON.parse(JSON.stringify(job)) }; }
      if (msg.type === 'export.list') return { type: 'export', ...listing };
      if (msg.type === 'script.get') return { type: 'script', text: scriptText, sha256: crypto.createHash('sha256').update(scriptText).digest('hex'), bytes: scriptText.length, cswap_version: '0.27.0b1' };
      const e = new Error('unknown'); e.code = 'unknown-type'; throw e;
    }
  }
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
      // As the real classifier: an import for whoever is signed in takes
      // any account the page names; with no account expected otherwise (a
      // Duplicate before its choice) there is nothing to compare, only an
      // unknown identity.
      if (expected.signedIn && !expected.email && !expected.orgUuid) return identity.email ? null : { kind: 'identity-unknown', what: 'w', todo: 't', evidence: {} };
      if (!expected.email && !expected.orgUuid) return { kind: 'identity-unknown', what: 'w', todo: 't', evidence: {} };
      if (identity.email && expected.email && identity.email.trim().toLowerCase() !== expected.email.trim().toLowerCase()) return { kind: 'wrong-account', what: `signed in as ${identity.email}`, todo: 't', evidence: {} };
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

// The export job the bridge makes for a Duplicate: claimed from birth,
// nothing chosen yet, the same script check as an import's.
const EXPORT_JOB = () => ({
  version: 1, id: 'job_20261005T150000_b2c3d4', created_at: 'now', updated_at: 'now', status: 'claimed', phase: 'claimed', kind: 'export',
  export: { path: '', archive: false, name: '', kind: '', files: 0, conversations: 0, bytes: 0, folder: 'C:\\x\\exports', top: '' },
  account: { slot: '', email: '', org_uuid: '' }, name: null,
  script: { sha256: crypto.createHash('sha256').update('(async () => {})();').digest('hex'), bytes: 20, cswap_version: '0.27.0b1' },
  claimed_by: null, cancel_requested: false, created_project: null, result: null, error: null,
  duplicate: { project: null, destination: null, name: null, import_job: null },
});
const DUP_ACCOUNTS = () => ([
  { slot: '1', email: 'a@example.com', organization: 'Personal', org_uuid: ORG_CHAT, alias: '', kind: 'oauth', usable: true, why: '' },
  { slot: '2', email: 'b@example.com', organization: 'Beethoven Org', org_uuid: ORG_CHAT, alias: 'work', kind: 'oauth', usable: true, why: '' },
  { slot: '3', email: '', organization: '', org_uuid: '', alias: '', kind: 'api_key', usable: false, why: 'an API key, not a claude.ai sign-in' },
]);
// What the page lists for the signed-in account, as the worker hears it.
const DUP_PROJECTS = () => ({
  projects: [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Recipes', kind: 'standard', orgUuid: ORG_CHAT, orgName: 'Personal', archived: false },
    { id: CHANNEL, name: 'beethoven', kind: 'code', orgUuid: ORG_CHAT, orgName: 'Personal', archived: false },
  ],
  orgs: [{ uuid: ORG_CHAT, name: 'Personal', apiOnly: false, error: null }, { uuid: ORG_API, name: 'Individual Org', apiOnly: true, error: null }],
  here: { id: CHANNEL, kind: 'code' }, error: null,
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
      h.contentTab = tabId;
      chrome.runtime.onConnect.fire(pair.server);
      h.content = pair;
      pair.client.onMessage.addListener(m => {
        if (m.type === 'probe.dom') pair.client.postMessage({ re: m.id, ok: true, ...h.pageState });
        // The site's sign-out, as content.js answers it: the status alone.
        if (m.type === 'sign.out') { h.signOuts.push(m); pair.client.postMessage({ re: m.id, kind: 'signout', ...h.signOut }); }
      });
      return pair;
    },
    pageState: { url: 'https://claude.ai/new', title: 'Claude', markers: [], hasImporter: false, online: true },
    signOut: { ok: true, status: 200 },
    signOuts: [],
    // Chrome's record of the tab follows the page, as the report does.
    async sendPageState(patch = {}) {
      Object.assign(h.pageState, patch);
      const tab = (chrome.tabs.list || []).find(t => t.id === h.contentTab);
      if (tab && typeof h.pageState.url === 'string') tab.url = h.pageState.url;
      h.content.client.postMessage({ type: 'page.state', ...h.pageState });
      await settle();
    },
    // The boot object of the latest page.js injection (a rerun makes a new one).
    bootOf() {
      const exec = chrome.userScripts.executed.filter(e => e.js.some(j => j.file === 'src/page.js')).pop();
      const code = exec.js[0].code;
      return JSON.parse(code.slice(code.indexOf('=') + 1).replace(/;$/, ''));
    },
    pageIdentity: { status: 200, email: 'b@example.com', orgs: [ORG_CHAT], finalPath: '', error: null },
    pageProjects: DUP_PROJECTS(),
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
        if (m.type === 'probe.projects') pair.client.postMessage({ id: ++mid + 1000, type: 'projects.result', probeId: m.probeId, ...h.pageProjects });
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
  assert.deepEqual(boot.expected, { email: 'b@example.com', orgUuid: ORG_CHAT, flow: 'import' });
  assert.equal(boot.kind, 'import');
  assert.equal(boot.project, null);
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
  assert.ok(h.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: import finished'));
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
  assert.ok(h.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: import stopped'));
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

test('worker: Resume during a failed-step hold leaves the step held; the retry (Resume on the held step) is the way out', async () => {
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
  assert.match(no.error, /press Resume to send it again, or Skip this step/);
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
  assert.match(cleared.error, /press Resume to send it again, or Skip this step/);
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
  assert.equal(h.chrome.notifications.shown.filter(n => n.title === 'Claude Swap Cloud: import stopped').length, 1);
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

test('worker: Drop that job ends a job another browser profile holds, when the bridge can', async () => {
  const elsewhere = { ...HOST_JOB(), status: 'claimed', claimed_by: { instance: 'other-profile', at: '2026-10-07T00:35:12Z', extension_version: '0.1.0' } };
  const h = await workerHarness({ hostJob: () => elsewhere, dropCapable: true });
  h.connectContent();
  await h.sendPageState();
  await settle(10);
  assert.equal(h.stored('cswap.bridge').jobElsewhere.id, elsewhere.id);
  const panel = h.connectPanel();
  // Another job's id than the one the bridge holds now: named, not dropped.
  const other = await panel.cmd('job.drop', { job: 'job_20261007T002214_bfa636' });
  assert.equal(other.ok, false);
  assert.equal(other.error, `The bridge now holds job ${elsewhere.id}, not job_20261007T002214_bfa636; read the Connection line again before dropping it.`);
  assert.deepEqual(h.made.drops, []);
  assert.equal(h.stored('cswap.bridge').jobElsewhere.id, elsewhere.id, 'named again for the panel');
  const r = await panel.cmd('job.drop', { job: elsewhere.id });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, `Dropped job ${elsewhere.id}; a new job can start.`);
  // The host's job is read first, then dropped by its id; nothing is adopted.
  assert.deepEqual(h.made.requests.map(x => x.type).slice(-2), ['job.get', 'job.drop']);
  assert.deepEqual(h.made.drops, [elsewhere.id]);
  assert.equal(elsewhere.status, 'cancelled');
  assert.equal(h.stored('cswap.bridge').jobElsewhere, null);
  assert.ok(h.made.logs.some(l => l.level === 'warn' && /dropped a job another browser profile held/.test(l.msg)));
  assert.equal(h.mods.createNative().isConnected(), false, 'the host was let go');
  assert.equal(h.job(), undefined);
  // Nothing left to drop is said, not refused.
  const again = await panel.cmd('job.drop', { job: elsewhere.id });
  assert.equal(again.ok, true);
  assert.match(again.text, /nothing to drop/);
  assert.equal(h.made.drops.length, 1);
  // An older cswap cannot drop: the line to type instead, and no request.
  const old = await workerHarness({ hostJob: () => ({ ...HOST_JOB(), status: 'claimed', claimed_by: { instance: 'other-profile', at: 'now', extension_version: '0.1.0' } }) });
  const refused = await old.connectPanel().cmd('job.drop', { job: 'job_20261005T141503_a1b2c3' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, dupMod.NO_DROP_TEXT);
  assert.ok(!old.made.requests.some(x => x.type === 'job.drop'));
  // This browser's own job is never dropped this way: Cancel is for it.
  const mine = await workerHarness({ dropCapable: true });
  mine.connectContent();
  await mine.sendPageState();
  await settle(10);
  assert.ok(mine.job(), 'claimed by this browser');
  const own = await mine.connectPanel().cmd('job.drop', { job: mine.job().id });
  assert.equal(own.ok, false);
  assert.match(own.error, /own job/);
  assert.ok(!mine.made.requests.some(x => x.type === 'job.drop'));
  // A pickup that finds the bridge free of that job takes the line down.
  const gone = await workerHarness({ hostJob: () => elsewhere, dropCapable: true });
  gone.connectContent();
  await gone.sendPageState();
  await settle(10);
  assert.ok(!gone.stored('cswap.bridge').jobElsewhere, 'the job was dropped above: nothing to name');
});

test('worker: a Duplicate the bridge refuses for a job another browser holds names it, with Drop that job when the bridge can', async () => {
  const elsewhere = { ...HOST_JOB(), id: 'job_20261007T002214_bfa636', status: 'claimed', claimed_by: { instance: 'other-profile', at: '2026-10-07T00:35:12Z', extension_version: '0.1.0' } };
  const refusal = { code: 'job-active', message: 'An import is already queued or running (job job_20261007T002214_bfa636, claimed since 2026-10-07T00:35:12Z). Wait for it, or cancel it with `cswap project-move import --cancel`.' };
  const h = await workerHarness({ hostJob: () => elsewhere, duplicate: { newError: refusal }, dropCapable: true });
  h.connectContent(7, PROJECT_PAGE);
  await h.sendPageState({ url: PROJECT_PAGE });
  await settle(10);
  const panel = h.connectPanel();
  const r = await panel.cmd('duplicate.start');
  assert.equal(r.ok, false);
  assert.equal(r.error, `${refusal.message} ${dupMod.DROP_HINT_TEXT}`);
  await settle(10);
  assert.equal(h.job(), undefined);
  // The refusal is followed by a pickup, so the Connection section names the job.
  assert.equal(h.stored('cswap.bridge').jobElsewhere.id, elsewhere.id);
  assert.equal(h.made.requests.filter(x => x.type === 'job.get').length >= 2, true);
  assert.equal(h.mods.createNative().isConnected(), false, 'the host was let go');
  // An older cswap: the host's own words, nothing added.
  const old = await workerHarness({ hostJob: () => elsewhere, duplicate: { newError: refusal } });
  old.connectContent(7, PROJECT_PAGE);
  await old.sendPageState({ url: PROJECT_PAGE });
  await settle(10);
  const plain = await old.connectPanel().cmd('duplicate.start');
  assert.equal(plain.ok, false);
  assert.equal(plain.error, refusal.message);
  // This browser's own job, which the bridge holds: it is taken up, Cancel
  // is for it, and the refusal hints at no button that would refuse it too.
  const chrome2 = fakeChrome({ data: new Map([['cswap.instance', JSON.stringify({ id: 'inst-1', createdAt: 0 })]]) });
  const mine = await workerHarness({ chrome: chrome2, hostJob: () => ({ ...HOST_JOB(), status: 'claimed', claimed_by: { instance: 'inst-1', at: 'now', extension_version: '0.1.0' } }), duplicate: { newError: refusal }, dropCapable: true });
  mine.connectContent(7, PROJECT_PAGE);
  await mine.sendPageState({ url: PROJECT_PAGE });
  await settle(10);
  assert.ok(mine.job(), 'this browser took its own job up');
  const own = await mine.connectPanel().cmd('duplicate.start');
  assert.equal(own.ok, false);
  assert.match(own.error, /already running/);
  assert.ok(!own.error.includes(dupMod.DROP_HINT_TEXT), own.error);
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
  assert.equal(r.text, 'Reached cswap 0.27.0b1. Nothing can start until Allow User Scripts is on: see Setup below.');
  assert.ok(h.made.logs.some(l => l.level === 'warn' && /userScripts/.test(l.msg)));
});

test('worker: Check now names the cswap that answered and what to press next, says a bridge that did not answer, and lets the host go again', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: {} });
  const panel = h.connectPanel();
  const r = await panel.cmd('job.refresh');
  assert.deepEqual([r.ok, r.text], [true, 'Reached cswap 0.27.0b1. Nothing is queued for this browser: open the project on claude.ai and press Export this project, or press Import for an export on disk.']);
  assert.ok(h.made.requests.some(q => q.type === 'job.get'), 'the job was asked for');
  assert.equal(h.mods.createNative().isConnected(), false, 'let go until the next job');
  // The bridge that does not answer is said as such, not as "nothing
  // queued" (greg's PC on 2026-10-07 read a let-go bridge as not
  // connected and the no-job answer as an error).
  h.made.refuseConnect = true;
  const refused = await panel.cmd('job.refresh');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'The bridge did not answer: the cswap bridge is not registered. See Setup below for the line to type.');
  // Where that cswap came from, when its hello says.
  const old = await workerHarness({ hostJob: () => null, duplicate: { dialogsCapable: false } });
  const from = await old.connectPanel().cmd('job.refresh');
  assert.match(from.text, /^Reached cswap 0\.27\.0b1 \(from duplicate-fixes@3612c92 of https:\/\/github\.com\/OpenSpineConsortium\/claude-swap-cloud\)\. Nothing is queued/);
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
  const set = await panel.cmd('config.set', { config: { writeSpacingMs: 900 } });
  assert.deepEqual(set, { re: 1, ok: true, problems: [] });
  assert.equal(h.mods.config().writeSpacingMs, 900);
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

// ---------------------------------------------------------------- Duplicate

const PROJECT_PAGE = `https://claude.ai/code/project/${CHANNEL}`;
const SIGNED_IN_AS_A = { status: 200, email: 'a@example.com', orgs: [ORG_CHAT], finalPath: '', error: null };

// Where the person puts the export in the Save As window, unless a test
// says otherwise: one .tar.
const OWN_TAR = 'C:\\x\\beethoven.tar';

// Presses Export this project in a worker with nothing queued, on a tab
// that shows the project: the reloaded tab reports, the page helper
// attaches and answers the probes, the job chooses the tab's project on
// its own and the Save As window opens; the person says where the export
// goes (`saveAs`), and the job sends the tab to the project's page, a
// reload since the tab is there already. The job then waits, claimed,
// for that page.
async function duplicateToChosen(h, panel, { url = PROJECT_PAGE, saveAs = OWN_TAR } = {}) {
  h.connectContent(7, url);
  await h.sendPageState({ url });
  assert.equal(h.job(), undefined, 'nothing queued, nothing picked up');
  const started = await panel.cmd('duplicate.start');
  assert.equal(started.ok, true, started.error);
  await until(() => h.chrome.tabs.reloaded.length === 1, 'the tab reloaded');
  assert.equal(h.chrome.userScripts.executed.length, 0, 'nothing injected before the fresh page reports');
  await h.timers.advance(1);
  await h.sendPageState({ url });
  await until(() => h.chrome.userScripts.executed.length === 1, 'page.js injected');
  await h.attachPage();
  await atSaveWindow(h, saveAs);
  await until(() => h.chrome.tabs.reloaded.length === 2, 'the export placed, the tab sent to the project\'s page');
  assert.equal(h.job().phase, 'claimed');
}

// The person at the Save As window the export opened: `choose` is where
// the export goes (null closes the window without a choice; a function is
// the test's own act on `h.made`), and the worker hears of it when it
// next asks, DIALOG_POLL_MS after its last ask.
async function atSaveWindow(h, choose = OWN_TAR) {
  await until(() => !!h.made.openWindow() && h.made.openWindow().purpose === 'save', 'the Save As window open');
  assert.equal(h.job().phase, 'placing');
  if (typeof choose === 'function') choose(h.made);
  else if (choose === null) h.made.closeWindow();
  else h.made.chooseInWindow(choose);
  await h.timers.advance(dupMod.DIALOG_POLL_MS);
  await until(() => h.job().phase !== 'placing', 'the Save As window answered');
}

// The person at the Open window an Import press opened: `choose` is the
// export opened in it (null closes the window without a choice; a
// function is the test's own act on `h.made`), and the press is answered
// once the worker has heard of it. Called after `panel.cmd('duplicate.import')`
// is under way, before its answer is awaited.
async function atOpenWindow(h, choose = OWN_TAR) {
  await until(() => !!h.made.openWindow() && h.made.openWindow().purpose === 'open', 'the Open window open');
  if (typeof choose === 'function') choose(h.made);
  else if (choose === null) h.made.closeWindow();
  else h.made.chooseInWindow(choose);
  await h.timers.advance(dupMod.DIALOG_POLL_MS);
}

// What the export script hands over at its end.
const EXPORT_DONE = () => ({ created: null, status: 'Done. 1 file.', link: '', paused: false, rows: [], counts: { created: 0, added: 0, moved: 0, leftOut: 0, notAdded: 0, notSet: 0, toCheck: 0 }, written: { files: 1, bytes: 34 } });

// The person presses Sign out and reload: the tab is asked for the site's
// sign-out and goes to the sign-in page.
async function signOutInPanel(h, panel) {
  const r = await panel.cmd('signout');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, 'Signed out. Sign in as the other account on the page, then press Import.');
  assert.deepEqual(h.chrome.tabs.updated.slice(-1), [{ tabId: 7, url: 'https://claude.ai/login' }]);
}

// The export script writes one whole file, as the page helper sends it.
async function writeOneFile(h) {
  const data = Buffer.from('{"format":"claude-project-export"}').toString('base64');
  const id = h.page.client.send({ type: 'file.write', path: 'beethoven/export.json', offset: 0, data, last: true, size: 34 });
  await until(() => h.page.client.replies.some(r => r.re === id), 'the write answered');
}

// Lets the tab report from the project's page and runs the export up to
// 'running'.
async function duplicateToRunning(h) {
  await h.timers.advance(1);
  await h.sendPageState({ url: PROJECT_PAGE });
  await until(() => h.chrome.userScripts.executed.length === 2, 'page.js injected on the project page');
  await h.attachPage();
  await until(() => h.chrome.userScripts.executed.length === 3, 'the export script injected');
  h.page.client.send({ type: 'script.event', kind: 'ready' });
  await until(() => h.job().phase === 'running', 'exporting');
}

test('worker: Export this project reloads the tab, names the project the tab shows, exports on its page and stops; Sign out and reload and Import are the person\'s presses; the import goes into whoever signs in', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: {} });
  h.pageIdentity = SIGNED_IN_AS_A;
  const panel = h.connectPanel();
  await duplicateToChosen(h, panel);
  // What was asked of the bridge, and what the job looks like once the
  // tab's project is chosen: the listing named it, and no account was
  // chosen to copy into (the registry is not read: the copy goes into
  // whichever account is signed in when Import is pressed).
  assert.deepEqual(h.made.requests.map(r => r.type).filter(t => t !== 'job.get'), ['export.new', 'export.choose', 'dialog.open', 'dialog.state', 'dialog.state']);
  const chosen = h.job();
  assert.equal(chosen.kind, 'export');
  assert.equal(chosen.id, 'job_20261005T150000_b2c3d4');
  // The Save As window was the bridge's, opened for this job once the
  // project was chosen, and its answer placed the export: one .tar.
  assert.deepEqual(h.made.requests.find(r => r.type === 'dialog.open'), { type: 'dialog.open', purpose: 'save', job: chosen.id });
  assert.deepEqual(h.made.windows.map(w => [w.purpose, w.job, w.open, w.path]), [['save', chosen.id, false, OWN_TAR]]);
  assert.deepEqual([chosen.export.path, chosen.export.archive, chosen.dialog], [OWN_TAR, true, null]);
  assert.equal(chosen.tabId, 7);
  assert.deepEqual(chosen.account, { slot: '', email: 'a@example.com', org_uuid: ORG_CHAT });
  assert.deepEqual(chosen.choices.projects.map(p => p.name), ['beethoven', 'Recipes']);
  assert.ok(!('accounts' in chosen), 'no account list on the job');
  assert.equal(chosen.importWay, 'tab');
  assert.deepEqual(h.made.duplicate.chooses, [{
    type: 'export.choose', job: chosen.id,
    project: { id: CHANNEL, name: 'beethoven', kind: 'code', org_uuid: ORG_CHAT, org_name: 'Personal' },
    destination: null, name: null, source: { email: 'a@example.com', org_uuid: ORG_CHAT },
  }]);
  assert.equal(chosen.duplicate.project.id, CHANNEL);
  assert.equal(chosen.duplicate.destination, null);
  assert.equal(chosen.navigateTo, PROJECT_PAGE);
  const boot = h.bootOf();
  assert.equal(boot.kind, 'export');
  assert.equal(boot.project, null);
  assert.deepEqual(boot.expected, { email: '', orgUuid: '', flow: 'export' });
  assert.deepEqual(h.page.client.pushes.map(p => p.type), ['probe.identity', 'probe.projects']);
  assert.deepEqual(h.made.events.filter(e => e.event === 'phase').map(e => e.phase), ['preflight', 'placing']);
  assert.ok(h.made.events.every(e => e.job === chosen.id));
  // No list to choose from: the old choice is refused.
  const late = await panel.cmd('duplicate.choose', { projectId: CHANNEL, destination: '1' });
  assert.deepEqual([late.ok, late.error], [false, 'No Duplicate is waiting for a choice.']);
  // The tab is on the project's page already, so it is reloaded rather
  // than sent; the export script runs there and asks nothing.
  assert.deepEqual(h.chrome.tabs.reloaded, [7, 7]);
  assert.deepEqual(h.chrome.tabs.updated, []);
  await duplicateToRunning(h);
  const boot2 = h.bootOf();
  assert.deepEqual(boot2.project, { id: CHANNEL, name: 'beethoven', kind: 'code', orgUuid: ORG_CHAT, orgName: 'Personal' });
  assert.deepEqual(boot2.expected, { email: 'a@example.com', orgUuid: ORG_CHAT, flow: 'export' });
  assert.notEqual(boot2.nonce, boot.nonce);
  assert.ok(!h.page.client.pushes.some(p => p.type === 'export.set'), 'an export loads no folder');
  assert.equal(h.made.requests.filter(r => r.type === 'export.list').length, 0);
  assert.equal(h.chrome.userScripts.executed[2].js[0].code, '(async () => {})();');
  assert.equal(h.page.client.pushes.filter(p => p.type === 'press').length, 1);
  // The script writes: each piece goes to the bridge as it is, the answer
  // comes back, the counts follow the last piece of each file.
  const data = Buffer.from('{"format":"claude-project-export"}').toString('base64');
  h.page.client.send({ type: 'file.write', path: 'beethoven/export.json', offset: 0, data, last: true, size: 34 });
  await until(() => h.page.client.replies.some(r => r.ok === true && r.size === 34), 'the write answered');
  const write = h.made.requests.find(r => r.type === 'file.write');
  assert.deepEqual(write, { type: 'file.write', job: chosen.id, path: 'beethoven/export.json', offset: 0, data, last: true });
  assert.equal(h.job().export.files, 1);
  assert.equal(h.job().export.bytes, 34);
  // The bridge's answer names the .tar, for the line to type.
  assert.equal(h.job().export.path, OWN_TAR);
  // Done: the export ends and nothing follows on its own. The notification
  // and the panel say what to press next.
  h.page.client.send({ type: 'script.event', kind: 'done', result: EXPORT_DONE() });
  await until(() => h.job().phase === 'done', 'the export done');
  await settle(30);
  assert.equal(h.job().id, chosen.id);
  assert.equal(h.job().chainError, null);
  assert.ok(!h.made.requests.some(r => r.type === 'import.queue' || r.type === 'job.claim'), 'no hand-off on its own');
  assert.equal(h.bg.state().handingOver, null);
  const done = h.made.events.find(e => e.event === 'done');
  assert.equal(done.job, chosen.id);
  assert.deepEqual(done.result.written, { files: 1, bytes: 34 });
  assert.deepEqual(h.chrome.notifications.shown.filter(n => n.title === 'Claude Swap Cloud: export finished').map(n => n.message), [dupMod.EXPORTED_NEXT_TEXT]);
  assert.ok(!h.chrome.notifications.shown.some(n => /^Claude Swap Cloud: import/.test(n.title)));
  const after = dupMod.afterExportView(h.job());
  assert.equal(after.line, `Exported "beethoven" (1 file) to ${OWN_TAR}. ${dupMod.NEXT_STEPS_TEXT}`);
  assert.equal(after.command, `cswap project-move import --to NUM --folder="${OWN_TAR}"`, 'the line to type leaves the account for the person');
  assert.equal(h.made.isConnected(), false, 'the host is let go until the next press');
  // Sign out and reload: the tab makes the site's sign-out, then goes to
  // the sign-in page, where the person signs in as the other account.
  await signOutInPanel(h, panel);
  assert.equal(h.signOuts.length, 1);
  assert.ok(h.made.logs.some(l => l.event === 'job' && l.msg === 'the person signed the tab out' && l.data.status === 200));
  await h.timers.advance(1);
  await h.sendPageState({ url: 'https://claude.ai/login' });
  assert.equal(h.job().phase, 'done', 'the finished export is not touched by the page going to the sign-in page');
  // Import, with a name typed and before the person has signed in: the
  // bridge is told the name and that the import goes into whoever is
  // signed in, the import it queues is claimed, and the same tab is sent
  // to claude.ai for it.
  h.pageIdentity = { status: 401, email: null, orgs: null, finalPath: '/login', error: null };
  const pressing = panel.cmd('duplicate.import', { name: '  beethoven copy ' });
  // The Open window first, in the bridge's hands; the .tar just saved is
  // opened in it, so the import goes the hand-over's way, by the export job.
  await atOpenWindow(h, OWN_TAR);
  assert.deepEqual(h.made.windows.slice(1).map(w => [w.purpose, w.job, w.open, w.path]), [['open', null, false, OWN_TAR]]);
  const pressed = await pressing;
  assert.equal(pressed.ok, true, pressed.error);
  assert.match(pressed.text, /The import job_20261005T150100_c3d4e5 is queued/);
  const types = h.made.requests.map(r => r.type);
  const queued = types.indexOf('import.queue');
  assert.deepEqual(h.made.requests[queued], { type: 'import.queue', job: chosen.id, signed_in: true, name: 'beethoven copy' });
  assert.equal(types[queued + 1], 'job.claim');
  assert.equal(h.made.requests[queued + 1].job, 'job_20261005T150100_c3d4e5');
  assert.ok(h.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: export finished' && /^Exported "beethoven" \(1 file\)\. Importing it into the account signed in on the page\.$/.test(n.message)));
  const importing = h.job();
  assert.equal(importing.id, 'job_20261005T150100_c3d4e5');
  assert.equal(importing.phase, 'claimed');
  assert.equal(importing.tabId, 7);
  assert.equal(importing.name, 'beethoven copy');
  assert.deepEqual(importing.account, { slot: '', email: '', org_uuid: '', signed_in: true });
  assert.equal(importing.navigateTo, 'https://claude.ai/');
  assert.equal(importing.duplicate.source.project.id, CHANNEL);
  await until(() => h.chrome.tabs.updated.length === 2, 'sent to claude.ai');
  assert.deepEqual(h.chrome.tabs.updated[1], { tabId: 7, url: 'https://claude.ai/' });
  await h.timers.advance(1);
  await h.sendPageState({ url: 'https://claude.ai/' });
  await until(() => h.chrome.userScripts.executed.length === 4, 'page.js injected for the import');
  const boot3 = h.bootOf();
  assert.equal(boot3.kind, 'import');
  assert.equal(boot3.jobId, importing.id);
  assert.deepEqual(boot3.expected, { email: '', orgUuid: '', flow: 'import', signedIn: true });
  // Not signed in yet: the import holds; the person signs in as the other
  // account and presses Resume, and that account is the import's from then
  // on: the job, the bridge (an account event) and the panel name it.
  await h.attachPage();
  await until(() => h.job().phase === 'held', 'held while signed out');
  assert.ok(h.made.raised.some(r => r.kind === 'signed-out'));
  assert.ok(h.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: import stopped'));
  assert.equal(h.chrome.userScripts.executed.length, 4, 'the import script is not loaded while signed out');
  assert.ok(!h.made.events.some(e => e.event === 'account'), 'no account named yet');
  h.pageIdentity = { status: 200, email: 'b@example.com', orgs: [ORG_CHAT], finalPath: '', error: null };
  const resumed = await panel.cmd('resume');
  assert.equal(resumed.ok, true, resumed.error);
  await until(() => h.chrome.userScripts.executed.length === 5, 'the import script injected');
  assert.deepEqual(h.job().account, { slot: '', email: 'b@example.com', org_uuid: '', signed_in: true });
  const named = h.made.events.filter(e => e.event === 'account');
  assert.deepEqual(named, [{ event: 'account', job: importing.id, email: 'b@example.com' }]);
  assert.equal(h.made.duplicate.importJob.account.email, 'b@example.com', 'the bridge records the account found');
  assert.equal(panelMod.viewModel({ job: h.job() }, 0).accountLine, 'into b@example.com');
  assert.ok(h.page.client.pushes.some(p => p.type === 'export.set'));
  h.page.client.send({ type: 'script.event', kind: 'ready' });
  await until(() => h.job().phase === 'running', 'importing');
  assert.equal(h.job().id, importing.id);
  assert.equal(h.job().reruns, 0);
  // Each job's events carry its own id.
  assert.ok(h.made.events.filter(e => e.job === importing.id).some(e => e.event === 'claimed'));
  assert.ok(h.made.events.filter(e => e.job === chosen.id).every(e => e.event !== 'claimed' || e.instance));
});

// The export of the tab's project, done, with the person signed in again
// as `identity` and Import pressed: the Open window appears and the person
// opens `choose` in it (the .tar just saved, unless said otherwise), the
// import is claimed, the tab sent to claude.ai, the page helper injected
// and attached.
async function importAfterExport(h, panel, identity, { name = '', choose = OWN_TAR } = {}) {
  await duplicateToChosen(h, panel);
  await duplicateToRunning(h);
  await writeOneFile(h);
  h.page.client.send({ type: 'script.event', kind: 'done', result: EXPORT_DONE() });
  await until(() => h.job().phase === 'done', 'the export done');
  await signOutInPanel(h, panel);
  await h.timers.advance(1);
  await h.sendPageState({ url: 'https://claude.ai/login' });
  h.pageIdentity = identity;
  const pressing = panel.cmd('duplicate.import', { name });
  await atOpenWindow(h, choose);
  const pressed = await pressing;
  assert.equal(pressed.ok, true, pressed.error);
  await until(() => h.chrome.tabs.updated.length === 2, 'sent to claude.ai');
  await h.timers.advance(1);
  await h.sendPageState({ url: 'https://claude.ai/' });
  await until(() => h.chrome.userScripts.executed.length === 4, 'page.js injected for the import');
  await h.attachPage();
}

test('worker: Import goes straight into the account the tab is signed in as, whichever it is, and says which; one the page cannot name is confirmed', async () => {
  // Signed in as the other account before Import: no hold, the account is
  // the import's at once, and the bridge hears it before the script loads.
  const h = await workerHarness({ hostJob: () => null, duplicate: {} });
  h.pageIdentity = SIGNED_IN_AS_A;
  const panel = h.connectPanel();
  await importAfterExport(h, panel, { status: 200, email: 'B@Example.com ', orgs: [ORG_CHAT], finalPath: '', error: null });
  await until(() => h.chrome.userScripts.executed.length === 5, 'the import script injected without a hold');
  assert.ok(!h.made.raised.length, 'nothing to hold on');
  assert.deepEqual(h.job().account, { slot: '', email: 'B@Example.com', org_uuid: '', signed_in: true });
  const wire = h.made.wire.slice(h.made.wire.lastIndexOf('request:job.claim')).filter(w => w === 'event:account' || w === 'request:script.get');
  assert.deepEqual(wire, ['event:account', 'request:script.get'], 'the account is sent before the import script is asked for');
  assert.equal(h.made.duplicate.importJob.account.email, 'B@Example.com');
  assert.deepEqual(h.bootOf().expected, { email: '', orgUuid: '', flow: 'import', signedIn: true });
  // From here the account is checked like any other: Resume after a hold
  // with another account signed in is a wrong account.
  h.page.client.send({ type: 'script.event', kind: 'ready' });
  await until(() => h.job().phase === 'running', 'importing');
  // Still signed in as the account the project came from (Sign out and
  // reload skipped): the copy goes there, and the panel says so.
  const same = await workerHarness({ hostJob: () => null, duplicate: {} });
  same.pageIdentity = SIGNED_IN_AS_A;
  await importAfterExport(same, same.connectPanel(), SIGNED_IN_AS_A);
  await until(() => same.chrome.userScripts.executed.length === 5, 'the import script injected');
  assert.equal(same.job().account.email, 'a@example.com');
  assert.equal(panelMod.viewModel({ job: same.job() }, 0).accountLine, 'into a@example.com');
  assert.equal(same.made.events.filter(e => e.event === 'account').length, 1);
  // A page that names no account: the person confirms, nothing is
  // recorded, and the panel says the copy goes into the account signed in.
  const unknown = await workerHarness({ hostJob: () => null, duplicate: {} });
  unknown.pageIdentity = SIGNED_IN_AS_A;
  const panel3 = unknown.connectPanel();
  await importAfterExport(unknown, panel3, { status: 200, email: null, orgs: null, finalPath: '', error: null });
  await until(() => unknown.job().phase === 'held', 'held');
  assert.equal(unknown.made.raised[0].kind, 'identity-unknown');
  assert.equal(panelMod.viewModel({ job: unknown.job() }, 0).accountLine, 'into the account signed in on the page');
  const confirmed = await panel3.cmd('identity.confirm');
  assert.equal(confirmed.ok, true);
  await until(() => unknown.chrome.userScripts.executed.length === 5, 'the import script injected after Confirm');
  assert.deepEqual(unknown.job().account, { slot: '', email: '', org_uuid: '', signed_in: true });
  assert.ok(!unknown.made.events.some(e => e.event === 'account'));
});

// What is on the computer for the Open window to find beside the export
// this browser made: an export in a folder of an earlier version's, and
// one of a standard project.
const ON_DISK = () => ([
  { path: 'C:\\x\\exports\\beethoven (3)', name: 'beethoven', kind: 'code', files: 143, conversations: 2, bytes: 90000, finished_at: '2026-10-07T09:25:06Z', archive: false },
  { path: 'C:\\x\\exports\\Recipes', name: 'Recipes', kind: 'standard', files: 3, conversations: 0, bytes: 400, finished_at: '2026-10-06T19:41:00Z', archive: false },
]);

// Export this project up to its Save As window: the tab reloaded, the
// page helper attached, the project chosen, the window open.
async function duplicateToSaveWindow(h, panel) {
  h.connectContent(7, PROJECT_PAGE);
  await h.sendPageState({ url: PROJECT_PAGE });
  const started = await panel.cmd('duplicate.start');
  assert.equal(started.ok, true, started.error);
  await until(() => h.chrome.tabs.reloaded.length === 1, 'the tab reloaded');
  await h.timers.advance(1);
  await h.sendPageState({ url: PROJECT_PAGE });
  await until(() => h.chrome.userScripts.executed.length === 1, 'page.js injected');
  await h.attachPage();
  await until(() => !!h.made.openWindow() && h.made.openWindow().purpose === 'save', 'the Save As window open');
  assert.equal(h.job().phase, 'placing');
}

test('worker: Export this project waits in the Save As window: a press meanwhile is answered with the window, closed without a choice it ends with nothing written, Cancel closes it, and a worker restarted meanwhile follows the same window', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: {} });
  h.pageIdentity = SIGNED_IN_AS_A;
  const panel = h.connectPanel();
  await duplicateToSaveWindow(h, panel);
  const exportId = h.job().id;
  const window1 = h.made.openWindow();
  assert.equal(h.job().dialog.id, window1.id, 'the window is on the job');
  assert.equal(h.made.requests.filter(r => r.type === 'dialog.open').length, 1);
  assert.equal(panelMod.viewModel({ job: h.job() }, 0).statusLine, 'Waiting for the Save As window.');
  assert.equal(dupMod.duplicateView(h.job()).line, 'Say where the export of "beethoven" goes in the Save As window that opened.');
  // Meanwhile every press is answered with the window; no second one.
  { const r = await panel.cmd('duplicate.import', { name: '' }); assert.deepEqual([r.ok, r.error], [false, dupMod.SAVE_WINDOW_OPEN_TEXT]); }
  { const r = await panel.cmd('duplicate.start'); assert.deepEqual([r.ok, r.error], [false, dupMod.SAVE_WINDOW_OPEN_TEXT]); }
  { const r = await panel.cmd('signout'); assert.deepEqual([r.ok, r.error], [false, dupMod.SAVE_WINDOW_OPEN_TEXT]); }
  assert.equal(h.signOuts.length, 0);
  assert.equal(h.made.windows.length, 1);
  // The bridge is asked how the window stands every DIALOG_POLL_MS.
  const asked = () => h.made.requests.filter(r => r.type === 'dialog.state').length;
  const before = asked();
  await h.timers.advance(dupMod.DIALOG_POLL_MS - 1);
  assert.equal(asked(), before);
  await h.timers.advance(1);
  await until(() => asked() === before + 1, 'asked again');
  // Closed without a choice: the job ends cancelled, nothing was written,
  // the tab stays where it is, and the host is let go.
  h.made.closeWindow();
  await h.timers.advance(dupMod.DIALOG_POLL_MS);
  await until(() => h.job().phase === 'cancelled', 'the export ended');
  assert.equal(h.job().error, dupMod.SAVE_CANCELLED_TEXT);
  assert.equal(h.job().dialog, null);
  assert.equal(h.chrome.tabs.reloaded.length, 1, 'the tab was not sent anywhere');
  assert.ok(!h.made.requests.some(r => r.type === 'file.write' || r.type === 'dialog.close'));
  assert.ok(h.made.events.some(e => e.event === 'cancelled' && e.job === exportId));
  assert.ok(h.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: export cancelled' && n.message === dupMod.SAVE_CANCELLED_TEXT));
  assert.equal(h.bg.state().handingOver, null);
  await settle(20);
  assert.equal(h.made.isConnected(), false);
  // Export this project again: a new job, a new window; Cancel while it
  // is open closes the window through the bridge and ends the job.
  h.made.duplicate.exportJob = null;
  h.made.current = null;
  await h.sendPageState({ url: PROJECT_PAGE });
  const again = await panel.cmd('duplicate.start');
  assert.equal(again.ok, true, again.error);
  await until(() => h.chrome.tabs.reloaded.length === 2, 'the tab reloaded again');
  await h.timers.advance(1);
  await h.sendPageState({ url: PROJECT_PAGE });
  await until(() => h.chrome.userScripts.executed.length === 2, 'page.js injected again');
  await h.attachPage();
  await until(() => h.made.windows.length === 2 && h.made.windows[1].open, 'a second Save As window');
  const cancelled = await panel.cmd('cancel');
  assert.equal(cancelled.ok, true, cancelled.error);
  await until(() => h.job().phase === 'cancelled', 'cancelled');
  assert.deepEqual(h.made.requests.filter(r => r.type === 'dialog.close'), [{ type: 'dialog.close', dialog: h.made.windows[1].id }]);
  assert.equal(h.made.windows[1].open, false);
  assert.equal(h.job().dialog, null);
  await settle(20);
  assert.equal(h.bg.state().driving, false, 'the wait for the window ended with the job');
  // A worker restarted while the window is open follows the same window:
  // nothing is opened twice, and the choice places the export.
  const third = await workerHarness({ hostJob: () => null, duplicate: {} });
  third.pageIdentity = SIGNED_IN_AS_A;
  await duplicateToSaveWindow(third, third.connectPanel());
  third.bg.stop();
  const chrome2 = fakeChrome({ data: third.chrome.storage.local.data });
  const h2 = await workerHarness({ chrome: chrome2, modules: third.mods });
  await settle(20);
  assert.equal(h2.job().phase, 'placing');
  assert.equal(h2.made.requests.filter(r => r.type === 'dialog.open').length, 1, 'the window on the job is followed, not opened again');
  h2.made.chooseInWindow('C:\\x\\again\\beethoven');
  await h2.timers.advance(dupMod.DIALOG_POLL_MS);
  await until(() => h2.job().phase === 'claimed', 'placed');
  assert.deepEqual([h2.job().export.path, h2.job().export.archive, h2.job().dialog], ['C:\\x\\again\\beethoven.tar', true, null], 'the bridge made it a .tar');
});

test('worker: a Save As window that could not open fails the export with the bridge\'s words, and an older bridge without the windows refuses Export and Import at once with the reinstall to make', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: {} });
  h.pageIdentity = SIGNED_IN_AS_A;
  await duplicateToSaveWindow(h, h.connectPanel());
  h.made.failWindow('the file window failed: powershell left with code 3');
  await h.timers.advance(dupMod.DIALOG_POLL_MS);
  await until(() => h.job().phase === 'failed', 'failed');
  assert.equal(h.job().error, 'the file window failed: powershell left with code 3');
  assert.ok(h.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: export failed' && /powershell left with code 3/.test(n.message)));
  assert.ok(!h.made.requests.some(r => r.type === 'file.write'));
  // An older cswap: no window to open, said so at the press, before any
  // job is made (greg's PC on 2026-10-07 ran a cswap twenty commits
  // behind the extension, with the same version number: the export job
  // was taken and failed halfway, and nothing said why).
  const old = await workerHarness({ hostJob: () => null, duplicate: { dialogsCapable: false } });
  old.pageIdentity = SIGNED_IN_AS_A;
  const panel = old.connectPanel();
  old.connectContent(7, PROJECT_PAGE);
  await old.sendPageState({ url: PROJECT_PAGE });
  { const r = await panel.cmd('duplicate.start'); assert.deepEqual([r.ok, r.error], [false, dupMod.NO_DIALOGS_TEXT]); }
  assert.equal(old.chrome.tabs.reloaded.length, 0, 'no reload for an export that cannot be placed');
  assert.ok(!old.job(), 'no job made');
  assert.ok(!old.made.requests.some(r => r.type === 'export.new' || r.type === 'dialog.open'));
  assert.equal(old.made.windows.length, 0);
  // Import under it is refused the same way, before any window.
  { const r = await panel.cmd('duplicate.import', { name: '' }); assert.deepEqual([r.ok, r.error], [false, dupMod.NO_DIALOGS_TEXT]); }
  assert.ok(!old.made.requests.some(r => r.type === 'dialog.open' || r.type === 'import.queue'));
});

test('worker: Import opens the Open window; the export opened there is queued by the window, into whoever is signed in, and runs in the claude.ai tab; meanwhile every press is answered with the window', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: { onDisk: ON_DISK() } });
  const panel = h.connectPanel();
  const pressing = panel.cmd('duplicate.import', { name: 'My recipes' });
  await until(() => !!h.made.openWindow(), 'the Open window open');
  assert.deepEqual(h.made.requests.find(r => r.type === 'dialog.open'), { type: 'dialog.open', purpose: 'open' });
  assert.equal(h.bg.state().handingOver, 'file');
  // Meanwhile: answered with the window, and no second one.
  { const r = await panel.cmd('duplicate.import', { name: '' }); assert.deepEqual([r.ok, r.error], [false, 'The import is already being started.']); }
  { const r = await panel.cmd('duplicate.start'); assert.deepEqual([r.ok, r.error], [false, dupMod.OPEN_WINDOW_OPEN_TEXT]); }
  { const r = await panel.cmd('signout'); assert.deepEqual([r.ok, r.error], [false, dupMod.OPEN_WINDOW_OPEN_TEXT]); }
  { const r = await panel.cmd('job.refresh'); assert.deepEqual([r.ok, r.text], [true, dupMod.OPEN_WINDOW_OPEN_TEXT], 'Check now names the window too'); }
  assert.equal(h.signOuts.length, 0);
  assert.equal(h.made.windows.length, 1);
  assert.equal(h.job(), undefined, 'nothing queued while the window is open');
  // The export.json inside an export's folder is that export.
  h.made.chooseInWindow('C:\\x\\exports\\Recipes\\export.json');
  await h.timers.advance(dupMod.DIALOG_POLL_MS);
  const pressed = await pressing;
  assert.equal(pressed.ok, true, pressed.error);
  assert.match(pressed.text, /The import job_20261005T150200_d4e5f6 is queued/);
  assert.equal(h.made.logs.filter(l => l.level === 'warn' || l.level === 'error').map(l => `${l.msg} ${JSON.stringify(l.data)}`).join('; '), '');
  // No path travels from the worker: the import is queued by the window's id.
  assert.deepEqual(h.made.requests.find(r => r.type === 'import.queue'), { type: 'import.queue', dialog: h.made.windows[0].id, signed_in: true, name: 'My recipes' });
  const types = h.made.requests.map(r => r.type);
  assert.equal(types[types.indexOf('import.queue') + 1], 'job.claim');
  await until(() => !!h.job(), 'the import adopted');
  const job = h.job();
  assert.equal(job.kind, 'import');
  assert.equal(job.id, 'job_20261005T150200_d4e5f6');
  assert.equal(job.export.path, 'C:\\x\\exports\\Recipes');
  assert.deepEqual(job.account, { slot: '', email: '', org_uuid: '', signed_in: true });
  assert.equal(job.name, 'My recipes');
  assert.equal(job.tabId, 7);
  assert.equal(job.navigateTo, 'https://claude.ai/');
  assert.equal(h.bg.state().handingOver, null);
  // It runs as any import: the tab goes to claude.ai first, and the page
  // helper expects whoever is signed in, who is then the job's account.
  await until(() => h.chrome.tabs.updated.length === 1, 'sent to claude.ai');
  assert.deepEqual(h.chrome.tabs.updated, [{ tabId: 7, url: 'https://claude.ai/' }]);
  await h.timers.advance(1);
  h.connectContent();
  await h.sendPageState({ url: 'https://claude.ai/' });
  await until(() => h.chrome.userScripts.executed.length === 1, 'page.js injected');
  await h.attachPage();
  assert.deepEqual(h.bootOf().expected, { email: '', orgUuid: '', flow: 'import', signedIn: true });
  await until(() => h.chrome.userScripts.executed.length === 2, 'the import script injected');
  assert.equal(h.job().account.email, 'b@example.com');
  assert.equal(h.made.events.find(e => e.event === 'account').email, 'b@example.com');
  // While it runs, Import is refused before any window.
  const busy = await panel.cmd('duplicate.import', { name: '' });
  assert.equal(busy.ok, false);
  assert.match(busy.error, /already running/);
  assert.equal(h.made.windows.length, 1);
  assert.equal(h.made.requests.filter(r => r.type === 'import.queue').length, 1);
});

test('worker: the Open window closed without a choice imports nothing and says so; a file that is no export, a window that could not open, and a bridge out of reach are each said in their words; nothing is retried on its own', async () => {
  // Closed without a choice: nothing queued, the port let go, Import again
  // is the person's act.
  const h = await workerHarness({ hostJob: () => null, duplicate: { onDisk: ON_DISK() } });
  const panel = h.connectPanel();
  const closing = panel.cmd('duplicate.import', { name: '' });
  await atOpenWindow(h, null);
  { const r = await closing; assert.deepEqual([r.ok, r.text], [true, dupMod.OPEN_CANCELLED_TEXT]); }
  assert.ok(!h.made.requests.some(r => r.type === 'import.queue'));
  assert.equal(h.job(), undefined);
  assert.equal(h.bg.state().handingOver, null);
  assert.equal(h.made.isConnected(), false);
  const pending = h.timers.pending();
  await h.timers.advance(10 * 60 * 1000);
  assert.deepEqual(h.timers.pending(), pending, 'no timer of its own');
  assert.equal(h.made.windows.length, 1);
  // A file that is no export: the bridge refuses the import, in its words.
  const other = panel.cmd('duplicate.import', { name: '' });
  await atOpenWindow(h, 'C:\\elsewhere\\notes.txt');
  const refused = await other;
  assert.equal(refused.ok, false);
  assert.match(refused.error, /is not a project export/);
  assert.equal(h.made.requests.filter(r => r.type === 'import.queue').length, 1);
  assert.equal(h.job(), undefined);
  // A window that could not open: the bridge's words, nothing queued.
  const broken = panel.cmd('duplicate.import', { name: '' });
  await atOpenWindow(h, made => made.failWindow('the file window failed: powershell left with code 3'));
  { const r = await broken; assert.deepEqual([r.ok, r.error], [false, 'the file window failed: powershell left with code 3']); }
  assert.equal(h.made.requests.filter(r => r.type === 'import.queue').length, 1);
  // The bridge out of reach: said so, no window.
  h.made.refuseConnect = true;
  const gone = await panel.cmd('duplicate.import', { name: '' });
  assert.equal(gone.ok, false);
  assert.match(gone.error, /not registered/);
  assert.equal(h.made.windows.length, 3);
  assert.equal(h.bg.state().handingOver, null);
});

test('worker: the export just made, opened in the Open window, goes the hand-over\'s way by its job; another export opened after it is queued by the window and takes the finished export\'s place', async () => {
  const own = await workerHarness({ hostJob: () => null, duplicate: { onDisk: ON_DISK() } });
  own.pageIdentity = SIGNED_IN_AS_A;
  await importAfterExport(own, own.connectPanel(), SIGNED_IN_AS_A, { choose: 'c:\\X\\BEETHOVEN.tar' });
  assert.deepEqual(own.made.requests.find(r => r.type === 'import.queue'), { type: 'import.queue', job: 'job_20261005T150000_b2c3d4', signed_in: true, name: '' });
  assert.equal(own.job().id, 'job_20261005T150100_c3d4e5');
  const swap = await workerHarness({ hostJob: () => null, duplicate: { onDisk: ON_DISK() } });
  swap.pageIdentity = SIGNED_IN_AS_A;
  await importAfterExport(swap, swap.connectPanel(), SIGNED_IN_AS_A, { choose: 'C:\\x\\exports\\Recipes' });
  assert.deepEqual(swap.made.requests.find(r => r.type === 'import.queue'), { type: 'import.queue', dialog: swap.made.windows[1].id, signed_in: true, name: '' });
  assert.equal(swap.job().export.path, 'C:\\x\\exports\\Recipes');
  assert.equal(swap.job().kind, 'import');
});

test('worker: the gate spaces every request of an export as a read, and an import\'s writes as writes', async () => {
  // An import job keeps both spacings as they are set.
  const imp = await workerHarness();
  await imp.runToReady();
  assert.equal(imp.job().kind === 'export', false);
  assert.deepEqual(imp.made.gateConfig(), { readSpacingMs: 0, writeSpacingMs: 500, retryAfterCapMs: 900000 });
  // An export job, from its listing to its run, is handed the read spacing
  // for its POSTs too, which only read.
  const dup = await workerHarness({ hostJob: () => null, duplicate: {} });
  dup.pageIdentity = SIGNED_IN_AS_A;
  const panel = dup.connectPanel();
  await duplicateToChosen(dup, panel);
  assert.deepEqual(dup.made.gateConfig(), { readSpacingMs: 0, writeSpacingMs: 0, retryAfterCapMs: 900000 });
  await duplicateToRunning(dup);
  assert.equal(dup.job().kind, 'export');
  assert.deepEqual(dup.made.gateConfig(), { readSpacingMs: 0, writeSpacingMs: 0, retryAfterCapMs: 900000 });
  // A setting changed in the panel reaches the very next evaluation.
  await panel.cmd('config.set', { config: { readSpacingMs: 250 } });
  assert.deepEqual(dup.made.gateConfig(), { readSpacingMs: 250, writeSpacingMs: 250, retryAfterCapMs: 900000 });
});

test('worker: Export this project is refused without a claude.ai tab, on a tab that is not on a project, with a cswap that has none, and while a job runs; the registry is never read', async () => {
  const noTab = await workerHarness({ chrome: fakeChrome({ tabs: [] }), hostJob: () => null, duplicate: {} });
  const r1 = await noTab.connectPanel().cmd('duplicate.start');
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'Open the project you want to copy on claude.ai, signed in as the account that has it, then press Export this project.');
  assert.equal(noTab.job(), undefined);
  assert.ok(!noTab.made.requests.some(r => r.type === 'export.new'));
  // A claude.ai tab that shows no project: nothing is asked of the bridge.
  const off = await workerHarness({ hostJob: () => null, duplicate: {} });
  off.connectContent(7, 'https://claude.ai/new');
  await off.sendPageState({ url: 'https://claude.ai/new' });
  await settle(10);
  const connectsBefore = off.made.connects;
  const r2 = await off.connectPanel().cmd('duplicate.start');
  assert.deepEqual([r2.ok, r2.error], [false, dupMod.NOT_ON_A_PROJECT_TEXT]);
  assert.equal(off.made.connects, connectsBefore, 'the bridge was not asked');
  assert.equal(off.chrome.tabs.reloaded.length, 0);
  const old = await workerHarness({ hostJob: () => null, duplicate: { capable: false } });
  old.connectContent(7, PROJECT_PAGE);
  await old.sendPageState({ url: PROJECT_PAGE });
  const r3 = await old.connectPanel().cmd('duplicate.start');
  assert.equal(r3.ok, false);
  assert.equal(r3.error, dupMod.NO_DUPLICATE_TEXT);
  assert.ok(!old.made.requests.some(r => r.type === 'export.new'));
  assert.equal(old.job(), undefined);
  // A registry with no account a copy could go into keeps nothing from
  // starting: the copy goes into whoever signs in, and the list is not asked for.
  const none = await workerHarness({ hostJob: () => null, duplicate: { accounts: [DUP_ACCOUNTS()[2]] } });
  none.pageIdentity = SIGNED_IN_AS_A;
  const panel = none.connectPanel();
  await duplicateToChosen(none, panel);
  assert.ok(!none.made.requests.some(r => r.type === 'accounts.list'), 'the registry is never read');
  assert.equal(none.made.duplicate.chooses[0].destination, null);
  const busy = await workerHarness();
  await busy.runToReady();
  const r5 = await busy.connectPanel().cmd('duplicate.start');
  assert.equal(r5.ok, false);
  assert.match(r5.error, /already running/);
  const r6 = await busy.panel.cmd('duplicate.choose', { projectId: CHANNEL, destination: '2' });
  assert.equal(r6.ok, false);
  assert.match(r6.error, /No Duplicate is waiting/);
  // A page that cannot say which project the tab shows ends the job with
  // what to open, after the listing; nothing is chosen.
  const lost = await workerHarness({ hostJob: () => null, duplicate: {} });
  lost.pageIdentity = SIGNED_IN_AS_A;
  lost.pageProjects = { ...DUP_PROJECTS(), here: null };
  lost.connectContent(7, PROJECT_PAGE);
  await lost.sendPageState({ url: PROJECT_PAGE });
  const started = await lost.connectPanel().cmd('duplicate.start');
  assert.equal(started.ok, true, started.error);
  await until(() => lost.chrome.tabs.reloaded.length === 1, 'the tab reloaded');
  await lost.timers.advance(1);
  await lost.sendPageState({ url: PROJECT_PAGE });
  await until(() => lost.chrome.userScripts.executed.length === 1, 'page.js injected');
  await lost.attachPage();
  await until(() => lost.job().phase === 'failed', 'failed');
  assert.equal(lost.job().error, dupMod.NOT_ON_A_PROJECT_TEXT);
  assert.deepEqual(lost.job().choices.projects.map(p => p.name), ['beethoven', 'Recipes'], 'the listing is kept for the log');
  assert.equal(lost.made.duplicate.chooses.length, 0);
  assert.ok(lost.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: export failed' && n.message === dupMod.NOT_ON_A_PROJECT_TEXT));
});

test('worker: Export this project takes the claude.ai tab in front, whichever tab reported last, and Chrome\'s address for it when it has not reported', async () => {
  // The project in front, another claude.ai tab behind it that reported
  // after it: the one in front is exported.
  const two = await workerHarness({
    chrome: fakeChrome({ tabs: [{ id: 7, url: PROJECT_PAGE, active: true }, { id: 8, url: 'https://claude.ai/new', active: false }] }),
    hostJob: () => null, duplicate: {},
  });
  two.connectContent(7, PROJECT_PAGE);
  await two.sendPageState({ url: PROJECT_PAGE });
  two.connectContent(8, 'https://claude.ai/new');
  await two.sendPageState({ url: 'https://claude.ai/new' });
  const r1 = await two.connectPanel().cmd('duplicate.start');
  assert.equal(r1.ok, true, r1.error);
  await until(() => two.chrome.tabs.reloaded.length === 1, 'the tab reloaded');
  assert.deepEqual(two.chrome.tabs.reloaded, [7]);
  assert.equal(two.job().tabId, 7);
  // A worker that just woke, before the tab reported to it: Chrome's own
  // address for the tab says it shows the project.
  const woke = await workerHarness({ chrome: fakeChrome({ tabs: [{ id: 7, url: `${PROJECT_PAGE}?q=1#top`, active: true }] }), hostJob: () => null, duplicate: {} });
  const r2 = await woke.connectPanel().cmd('duplicate.start');
  assert.equal(r2.ok, true, r2.error);
  await until(() => woke.chrome.tabs.updated.length === 1, 'the tab sent to the project');
  assert.deepEqual(woke.chrome.tabs.updated[0], { tabId: 7, url: PROJECT_PAGE }, 'without its query or fragment');
  // The page moved off the project inside the site since its last report:
  // Chrome's address is the one that counts.
  const moved = await workerHarness({ hostJob: () => null, duplicate: {} });
  moved.connectContent(7, PROJECT_PAGE);
  await moved.sendPageState({ url: PROJECT_PAGE });
  moved.chrome.tabs.list[0].url = 'https://claude.ai/new';
  const r3 = await moved.connectPanel().cmd('duplicate.start');
  assert.deepEqual([r3.ok, r3.error], [false, dupMod.NOT_ON_A_PROJECT_TEXT]);
});

test('worker: the export script\'s unanswered question ends the Duplicate with why; no import follows a failed export', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: {} });
  h.pageIdentity = SIGNED_IN_AS_A;
  const panel = h.connectPanel();
  await duplicateToChosen(h, panel);
  await duplicateToRunning(h);
  h.page.client.send({ type: 'script.event', kind: 'prompt', question: 'Which project should be exported?\n\n1. Recipes', answer: null, promptKind: 'project', sourceVisible: false });
  await until(() => h.job().phase === 'failed', 'failed');
  assert.match(h.job().error, /did not list "beethoven"/);
  assert.match(h.job().error, /start the Duplicate again/);
  assert.equal(h.job().kind, 'export');
  assert.ok(h.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: export failed'));
  assert.ok(!h.made.requests.some(r => r.type === 'import.queue'), 'no import after a failed export');
  assert.ok(h.made.events.some(e => e.event === 'failed' && e.job === 'job_20261005T150000_b2c3d4'));
});

test('worker: when the import cannot be queued the export stays on disk and the panel gets the line to type; Import is pressed again, never retried on its own', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: { queueError: { code: 'export-incomplete', message: 'the export wrote 0 files' } } });
  h.pageIdentity = SIGNED_IN_AS_A;
  const panel = h.connectPanel();
  await duplicateToChosen(h, panel);
  await duplicateToRunning(h);
  await writeOneFile(h);
  h.page.client.send({ type: 'script.event', kind: 'done', result: { created: null, status: 'Done.', link: '', paused: false, rows: [], counts: { created: 0, added: 0, moved: 0, leftOut: 0, notAdded: 0, notSet: 0, toCheck: 0 }, written: { files: 0, bytes: 0 } } });
  await until(() => h.job().phase === 'done', 'done');
  await settle(20);
  assert.equal(h.job().chainError, null, 'nothing was asked yet');
  await signOutInPanel(h, panel);
  const pressing = panel.cmd('duplicate.import', { name: '' });
  await atOpenWindow(h, OWN_TAR);
  const pressed = await pressing;
  assert.deepEqual([pressed.ok, pressed.error], [false, 'the export wrote 0 files']);
  assert.equal(h.job().kind, 'export');
  assert.equal(h.job().chainError, 'the export wrote 0 files');
  assert.equal(h.made.requests.filter(r => r.type === 'import.queue').length, 1, 'asked once, never again on its own');
  assert.ok(!h.made.requests.some(r => r.type === 'job.claim'));
  const stopped = h.chrome.notifications.shown.find(n => n.title === 'Claude Swap Cloud: import not started');
  assert.ok(stopped);
  assert.match(stopped.message, /The export of "beethoven" is saved/);
  assert.match(stopped.message, /cswap project-move import --to NUM --folder="C:\\x\\beethoven\.tar"/);
  assert.match(stopped.message, /the export wrote 0 files/);
  // The panel shows the same line, and Import again.
  const after = dupMod.afterExportView(h.job());
  assert.equal(after.line, 'The import could not start: the export wrote 0 files');
  assert.equal(after.command, `cswap project-move import --to NUM --folder="${OWN_TAR}"`);
  assert.deepEqual(h.chrome.tabs.updated, [{ tabId: 7, url: 'https://claude.ai/login' }], 'the tab stays on the sign-in page');
  // Time passes: nothing is tried again.
  await h.timers.advance(10 * 60 * 1000);
  assert.equal(h.made.requests.filter(r => r.type === 'import.queue').length, 1);
  // Export this project can be pressed again, on a tab that shows a project.
  await h.sendPageState({ url: PROJECT_PAGE });
  const again = await panel.cmd('duplicate.start');
  assert.equal(again.ok, true, again.error);
});

test('worker: an export whose tab goes away before the script ran goes on in the next claude.ai tab, sent to the project\'s page first, and Cancel ends it', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: {} });
  h.pageIdentity = SIGNED_IN_AS_A;
  const panel = h.connectPanel();
  await duplicateToChosen(h, panel);
  // The tab closes while the job waits for its fresh page: nothing starts
  // again (the project is chosen already) and nothing is said; the job
  // waits for a claude.ai tab, which is sent to the project's page first.
  h.chrome.tabs.list.length = 0;
  h.chrome.tabs.onRemoved.fire(7);
  await settle(20);
  assert.equal(h.job().phase, 'claimed');
  assert.equal(h.job().tabId, null);
  assert.equal(h.job().navigatedAt, null);
  assert.equal(h.job().reruns, 0);
  assert.equal(h.job().navigateTo, PROJECT_PAGE);
  assert.equal(h.job().duplicate.project.id, CHANNEL);
  assert.ok(!h.chrome.notifications.shown.some(n => /stopped/.test(n.title)));
  // A new tab reports from elsewhere on claude.ai: it is sent to the
  // project's page; from there the helper and the export script go in.
  h.chrome.tabs.list.push({ id: 8, url: 'https://claude.ai/new', active: true });
  h.connectContent(8, 'https://claude.ai/new');
  await h.sendPageState({ url: 'https://claude.ai/new' });
  await until(() => h.chrome.tabs.updated.length === 1, 'the new tab sent to the project page');
  assert.deepEqual(h.chrome.tabs.updated[0], { tabId: 8, url: PROJECT_PAGE });
  assert.equal(h.chrome.userScripts.executed.length, 1, 'nothing injected before the project page reports');
  await h.timers.advance(1);
  await h.sendPageState({ url: PROJECT_PAGE });
  await until(() => h.chrome.userScripts.executed.length === 2, 'page.js injected in the new tab');
  assert.deepEqual(h.chrome.userScripts.executed[1].target, { tabId: 8 });
  await h.attachPage({ tabId: 8 });
  await until(() => h.chrome.userScripts.executed.length === 3 && h.job().tabId === 8, 'the export script injected in the new tab');
  assert.equal(h.made.duplicate.chooses.length, 1, 'chosen once');
  // Cancel ends it and reloads the tab so the helper is gone.
  const r = await panel.cmd('cancel');
  assert.equal(r.ok, true);
  await until(() => h.job().phase === 'cancelled', 'cancelled');
  assert.deepEqual(h.chrome.tabs.reloaded, [7, 7, 8]);
  assert.ok(h.made.events.some(e => e.event === 'cancelled' && e.job === 'job_20261005T150000_b2c3d4'));
  assert.ok(h.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: export cancelled'));
});

test('worker: a Claude Code project goes to the bridge under the name the site gave, and one offered by its id alone with none', async () => {
  // The channel list named the tab's project: the bridge is sent that name.
  const named = await workerHarness({ hostJob: () => null, duplicate: {} });
  named.pageIdentity = SIGNED_IN_AS_A;
  named.pageProjects = { ...DUP_PROJECTS(), projects: [DUP_PROJECTS().projects[0], { id: CHANNEL, name: 'beethoven', kind: 'code', orgUuid: '', orgName: '', archived: false }] };
  await duplicateToChosen(named, named.connectPanel());
  assert.deepEqual(named.job().choices.projects.map(p => p.name), ['beethoven', 'Recipes']);
  assert.deepEqual(named.made.duplicate.chooses[0].project, { id: CHANNEL, name: 'beethoven', kind: 'code', org_uuid: '', org_name: '' });
  assert.equal(named.job().export.name, 'beethoven');
  // Nothing named it: the tab's workspace is offered by its id, and the
  // bridge is sent no name (it records the id until the export's own
  // export.json names the project).
  const unnamed = await workerHarness({ hostJob: () => null, duplicate: {} });
  unnamed.pageIdentity = SIGNED_IN_AS_A;
  unnamed.pageProjects = { ...DUP_PROJECTS(), projects: [DUP_PROJECTS().projects[0]], error: 'HTTP 404 from /v1/code/channels' };
  await duplicateToChosen(unnamed, unnamed.connectPanel());
  assert.deepEqual(unnamed.job().choices.projects.map(p => [p.name, p.label]), [['', `This tab's workspace (${CHANNEL})`], ['Recipes', 'Recipes']]);
  assert.equal(unnamed.job().choices.error, 'HTTP 404 from /v1/code/channels');
  assert.deepEqual(unnamed.made.duplicate.chooses[0].project, { id: CHANNEL, name: '', kind: 'code', org_uuid: '', org_name: '' });
  assert.equal(unnamed.made.duplicate.chooses[0].source.org_uuid, '');
});

test('worker: a listing request the site interrupts leaves the export held, not chosen; Resume lists the projects again and chooses', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: {} });
  const panel = h.connectPanel();
  h.connectContent(7, PROJECT_PAGE);
  await h.sendPageState({ url: PROJECT_PAGE });
  const started = await panel.cmd('duplicate.start');
  assert.equal(started.ok, true, started.error);
  await until(() => h.chrome.tabs.reloaded.length === 1, 'the tab reloaded');
  await h.timers.advance(1);
  await h.sendPageState({ url: PROJECT_PAGE });
  await until(() => h.chrome.userScripts.executed.length === 1, 'page.js injected');
  await h.attachPage({ auto: false });
  const answerIdentity = async n => {
    await until(() => h.page.client.pushes.filter(p => p.type === 'probe.identity').length === n, `identity asked (${n})`);
    const probe = h.page.client.pushes.filter(p => p.type === 'probe.identity')[n - 1];
    h.page.client.send({ type: 'identity.result', probeId: probe.probeId, identity: SIGNED_IN_AS_A });
  };
  await answerIdentity(1);
  await until(() => h.page.client.pushes.some(p => p.type === 'probe.projects'), 'the projects asked');
  const listing = h.page.client.pushes.find(p => p.type === 'probe.projects');
  // The channel list is challenged: its report holds the job.
  h.page.client.send({ type: 'gate.permit', requestId: 'q1', stepKey: 'GET /v1/code/channels?scope=joined ', method: 'GET', path: '/v1/code/channels', kind: 'probe', bodyBytes: 0 });
  await until(() => h.page.client.replies.some(r => r.permit === 'p1'), 'the probe permitted');
  h.page.client.send({ type: 'gate.report', requestId: 'q1', permit: 'p1', status: 403, ok: false, redirected: false, finalPath: '', headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' }, elapsedMs: 5, markers: ['cf_chl_opt'] });
  await until(() => h.job().phase === 'held', 'held');
  // Then the listing's own result arrives: the hold stays.
  h.page.client.send({ type: 'projects.result', probeId: listing.probeId, ...DUP_PROJECTS(), error: 'HTTP 403 from /v1/code/channels' });
  await settle(20);
  assert.equal(h.job().phase, 'held');
  assert.equal(h.job().heldFrom, 'preflight');
  assert.equal(h.job().choices, null);
  assert.ok(!h.made.events.some(e => e.event === 'phase' && e.phase === 'choosing'));
  assert.equal(h.made.raised.length, 1);
  assert.equal(h.made.raised[0].kind, 'challenge');
  assert.equal(h.made.duplicate.chooses.length, 0, 'nothing chosen from a listing that was held');
  // Resume: the identity is checked, then the projects are listed again,
  // the tab's project is chosen and the tab is sent to its page.
  const resumed = panel.cmd('resume');
  await answerIdentity(2);
  await answerIdentity(3);
  await until(() => h.page.client.pushes.filter(p => p.type === 'probe.projects').length === 2, 'listed again');
  const again = h.page.client.pushes.filter(p => p.type === 'probe.projects')[1];
  h.page.client.send({ type: 'projects.result', probeId: again.probeId, ...DUP_PROJECTS() });
  assert.equal((await resumed).ok, true);
  await atSaveWindow(h, OWN_TAR);
  await until(() => h.chrome.tabs.reloaded.length === 2, 'the project chosen and placed, the tab sent to its page');
  assert.equal(h.job().phase, 'claimed');
  assert.deepEqual(h.job().choices.projects.map(p => p.name), ['beethoven', 'Recipes']);
  assert.equal(h.job().duplicate.project.id, CHANNEL);
  assert.equal(h.made.duplicate.chooses.length, 1);
});

test('worker: Import queues the import only after the bridge heard the export\'s end, however slow the answers', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: {} });
  h.pageIdentity = SIGNED_IN_AS_A;
  const panel = h.connectPanel();
  await duplicateToChosen(h, panel);
  await duplicateToRunning(h);
  await writeOneFile(h);
  const exportId = h.job().id;
  // The host answers only when the test says so, as a real port answers
  // milliseconds later, not within the same few steps.
  h.made.holdAcks = true;
  h.page.client.send({ type: 'script.event', kind: 'status', text: 'Exporting 1/1' });
  await until(() => h.made.heldAcks.length === 1, 'the status sent');
  h.page.client.send({ type: 'script.event', kind: 'done', result: EXPORT_DONE() });
  await until(() => h.job().phase === 'done', 'the export done');
  await settle(30);
  assert.ok(!h.made.requests.some(r => r.type === 'import.queue'), 'nothing is queued on its own');
  assert.equal(h.job().chainError, null);
  assert.equal(h.bg.state().handingOver, null);
  // Import is pressed while the end is still on its way: the import is
  // asked for only once the bridge answered the end and the line after it.
  const pressed = panel.cmd('duplicate.import', { name: '' });
  await settle(30);
  assert.ok(!h.made.requests.some(r => r.type === 'import.queue'), 'not while the host has not answered');
  assert.ok(!h.made.windows.some(w => w.purpose === 'open'), 'the Open window waits behind the end');
  assert.equal(h.bg.state().handingOver, 'file');
  const again = await panel.cmd('duplicate.start');
  assert.deepEqual([again.ok, again.error], [false, 'The last export is handing over to its import; wait for it, or press Import if it stops.']);
  h.made.ackNext(); // the status
  await settle(30);
  assert.ok(!h.made.requests.some(r => r.type === 'import.queue'), 'not before done is acknowledged');
  h.made.ackNext(); // done
  await settle(30);
  assert.ok(!h.made.requests.some(r => r.type === 'import.queue'), 'nor before the phase line after it');
  h.made.ackNext(); // phase
  await atOpenWindow(h, OWN_TAR);
  await until(() => h.job().id === 'job_20261005T150100_c3d4e5', 'the import claimed');
  const answer = await pressed;
  assert.equal(answer.ok, true, answer.error);
  const types = h.made.requests.map(r => r.type);
  assert.equal(types[types.indexOf('import.queue') + 1], 'job.claim');
  assert.equal(h.job().tabId, 7);
  assert.equal(h.job().navigateTo, 'https://claude.ai/');
  assert.equal(h.bg.state().handingOver, null);
  assert.ok(h.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: export finished' && /\. Importing it into /.test(n.message)));
  assert.ok(!h.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: import not started'));
  h.made.holdAcks = false;
  while (h.made.heldAcks.length) { h.made.ackNext(); await settle(); }
});

test('worker: events queued after the export\'s end neither hold up the import nor block its events when the bridge refuses them', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: {}, forwardLogs: true });
  h.pageIdentity = SIGNED_IN_AS_A;
  const panel = h.connectPanel();
  await duplicateToChosen(h, panel);
  await duplicateToRunning(h);
  await writeOneFile(h);
  const exportId = h.job().id;
  h.made.holdAcks = true;
  h.made.holdRequests.add('import.queue');
  h.page.client.send({ type: 'script.event', kind: 'done', result: EXPORT_DONE() });
  await until(() => h.made.heldAcks.length === 1, 'done sent');
  h.made.ackNext();
  await until(() => h.made.heldAcks.length === 1, 'the phase line sent');
  h.made.ackNext();
  const pressed = panel.cmd('duplicate.import', { name: '' });
  await atOpenWindow(h, OWN_TAR);
  await until(() => h.made.heldRequests.length === 1, 'the import asked for');
  // The page says something late: a line of the export's, which reaches the
  // host after the import took the export's place there.
  const logsBefore = h.made.wire.filter(w => w === 'event:log').length;
  h.page.client.send({ type: 'script.event', kind: 'console', level: 'warn', text: 'a late line' });
  await until(() => h.made.wire.filter(w => w === 'event:log').length === logsBefore + 1, 'the late line sent');
  await settle(20);
  assert.ok(!h.made.events.some(e => e.event === 'log' && e.msg === 'a late line'), 'the host refused it');
  const dropped = h.made.logs.find(r => r.msg === 'the bridge refused an event; dropped');
  assert.ok(dropped);
  assert.deepEqual([dropped.data.job, dropped.data.code], [exportId, 'not-claimed']);
  assert.equal(h.bg.state().eventQueue, 0, 'dropped, not left to block the rest');
  h.made.holdAcks = false;
  h.made.holdRequests.clear();
  h.made.releaseRequest();
  const answer = await pressed;
  assert.equal(answer.ok, true, answer.error);
  await until(() => h.job().id === 'job_20261005T150100_c3d4e5', 'the import claimed');
  await until(() => h.made.events.some(e => e.event === 'claimed' && e.job === 'job_20261005T150100_c3d4e5'), 'the import\'s claimed event delivered');
  assert.equal(h.bg.state().eventQueue, 0);
});

test('worker: an Import the bridge cannot be reached for says why before any window; nothing is tried again on its own, and the next press sends the end again', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: {} });
  h.pageIdentity = SIGNED_IN_AS_A;
  const panel = h.connectPanel();
  await duplicateToChosen(h, panel);
  await duplicateToRunning(h);
  await writeOneFile(h);
  h.made.holdAcks = true;
  h.page.client.send({ type: 'script.event', kind: 'done', result: EXPORT_DONE() });
  await until(() => h.made.heldAcks.length === 1, 'done sent');
  await settle(20);
  // The port drops before done is answered, and the bridge cannot be
  // reached again; the person presses Import.
  h.made.refuseConnect = true;
  h.made.ackNext('disconnected');
  await settle(20);
  const pending = h.timers.pending();
  const answer = await panel.cmd('duplicate.import', { name: '' });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /not registered/);
  assert.equal(h.made.windows.length, 1, 'no Open window without the bridge');
  assert.ok(!h.made.requests.some(r => r.type === 'import.queue'));
  assert.equal(h.job().chainError, null, 'the press was answered; the export waits as it was');
  assert.match(dupMod.afterExportView(h.job()).command, /cswap project-move import --to NUM --folder="C:\\x\\beethoven\.tar"/);
  assert.deepEqual(h.timers.pending(), pending, 'no timer of its own');
  // Time passes: nothing is tried again.
  const tried = h.made.connects;
  await h.timers.advance(10 * 60 * 1000);
  assert.equal(h.made.connects, tried);
  assert.ok(!h.made.requests.some(r => r.type === 'import.queue'));
  assert.equal(h.job().kind, 'export');
  assert.match(dupMod.afterExportView(h.job()).command, /^cswap project-move import /, 'the export still waits for Import');
  // The bridge is back: the next press gets the end through and queues the import.
  h.made.refuseConnect = false;
  h.made.holdAcks = false;
  const pressing = panel.cmd('duplicate.import', { name: '' });
  await atOpenWindow(h, OWN_TAR);
  const again = await pressing;
  assert.equal(again.ok, true, again.error);
  await until(() => h.job().id === 'job_20261005T150100_c3d4e5', 'the import claimed');
  assert.equal(h.job().chainError, null);
});

test('worker: Import is the person\'s act: it queues the import, is refused with why while a job runs, and is taken once while one is starting', async () => {
  // Import is always in place (greg, 2026-10-07: "the user should always
  // be able to click export, or import, or logout"), so a press while a
  // job runs is answered with why, before any window.
  const busy = await workerHarness();
  await busy.runToReady();
  const running = await busy.connectPanel().cmd('duplicate.import', { name: '' });
  assert.deepEqual([running.ok, running.error], [false, `A job is already running (${busy.job().id}); wait for it or cancel it first.`]);
  assert.equal(busy.made.windows.length, 0);
  assert.ok(!busy.made.requests.some(r => r.type === 'import.queue'));

  const h = await workerHarness({ hostJob: () => null, duplicate: { queueError: { code: 'export-incomplete', message: 'the export wrote 0 files' } } });
  h.pageIdentity = SIGNED_IN_AS_A;
  const panel = h.connectPanel();
  await duplicateToChosen(h, panel);
  await duplicateToRunning(h);
  await writeOneFile(h);
  h.page.client.send({ type: 'script.event', kind: 'done', result: EXPORT_DONE() });
  await until(() => h.job().phase === 'done', 'the export done');
  const refusing = panel.cmd('duplicate.import', { name: '' });
  await atOpenWindow(h, OWN_TAR);
  const refused = await refusing;
  assert.deepEqual([refused.ok, refused.error], [false, 'the export wrote 0 files']);
  assert.equal(h.job().chainError, 'the export wrote 0 files');
  assert.equal(h.made.requests.filter(r => r.type === 'import.queue').length, 1);
  // The person fixed what was wrong and presses Import again; a second
  // press while the first is under way (at its window, then at the
  // bridge) is not a second attempt.
  h.made.duplicate.queueError = null;
  h.made.holdRequests.add('import.queue');
  const first = panel.cmd('duplicate.import', { name: '' });
  await until(() => !!h.made.openWindow(), 'the Open window open');
  { const r = await panel.cmd('duplicate.import', { name: '' }); assert.deepEqual([r.ok, r.error], [false, 'The import is already being started.']); }
  await atOpenWindow(h, OWN_TAR);
  await until(() => h.made.heldRequests.length === 1, 'the import asked for');
  const second = await panel.cmd('duplicate.import', { name: '' });
  assert.deepEqual([second.ok, second.error], [false, 'The import is already being started.']);
  h.made.holdRequests.clear();
  h.made.releaseRequest();
  const answer = await first;
  assert.equal(answer.ok, true, answer.error);
  assert.match(answer.text, /The import job_20261005T150100_c3d4e5 is queued/);
  assert.equal(h.made.requests.filter(r => r.type === 'import.queue').length, 2);
  await until(() => h.job().id === 'job_20261005T150100_c3d4e5', 'the import claimed');
  assert.equal(h.job().tabId, 7);
  assert.equal(h.job().chainError, null);
  assert.ok(h.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: export finished' && /\. Importing it into /.test(n.message)));
});

test('worker: the buttons at the wrong moment: Sign out and reload during a job or while an import starts; a done export with no path on record, and one whose own-window copy is made, still import by the window', async () => {
  // Sign out and reload while a job runs in the tab: refused, no sign-out
  // request made, the tab left where it is.
  const busy = await workerHarness();
  await busy.runToReady();
  const moved = busy.chrome.tabs.updated.length;
  const out = await busy.connectPanel().cmd('signout');
  assert.deepEqual([out.ok, out.error], [false, 'A job is running in the tab; wait for it, or press Cancel first.']);
  assert.equal(busy.signOuts.length, 0);
  assert.equal(busy.chrome.tabs.updated.length, moved);
  // While an import is being started (the bridge has not answered yet):
  // refused too, so the tab is not logged out under the import.
  const starting = await workerHarness({ hostJob: () => null, duplicate: { onDisk: ON_DISK() } });
  starting.made.holdRequests.add('import.queue');
  const panel = starting.connectPanel();
  const pressed = panel.cmd('duplicate.import', { name: '' });
  await atOpenWindow(starting, 'C:\\x\\exports\\Recipes\\export.json');
  await until(() => starting.made.heldRequests.length === 1, 'the import asked for');
  const during = await panel.cmd('signout');
  assert.deepEqual([during.ok, during.error], [false, 'A job is starting in the tab; wait for it, then press Sign out and reload.']);
  assert.equal(starting.signOuts.length, 0);
  starting.made.holdRequests.clear();
  starting.made.releaseRequest();
  assert.equal((await pressed).ok, true);
  // A finished export whose record names no path (an older bridge's, or
  // an older worker's): the .tar opened in the window is not known as
  // its own, so the bridge reads it and the import is queued by the
  // window, like any other export's.
  const pathless = storedDoneExport({ chainError: null, export: { ...storedDoneExport().export, path: '' } });
  const onDisk = [{ ...ON_DISK()[0], path: OWN_TAR, name: 'beethoven', archive: true }];
  const h = await workerHarness({ chrome: fakeChrome({ data: new Map([['cswap.job', JSON.stringify(pathless)]]) }), hostJob: () => null, duplicate: { onDisk, serveJobGet: true } });
  h.made.duplicate.exportJob = { ...pathless, chainError: undefined };
  h.made.current = pathless.id;
  const handing = h.connectPanel().cmd('duplicate.import', { name: '' });
  await atOpenWindow(h, OWN_TAR);
  const handed = await handing;
  assert.equal(handed.ok, true, handed.error);
  assert.deepEqual(h.made.requests.find(r => r.type === 'import.queue'), { type: 'import.queue', dialog: h.made.windows[0].id, signed_in: true, name: '' });
  // The record of an import in its own window that made the copy (an
  // earlier version's): the export opened again is imported again, by
  // the window, where the hand-over's way says the copy is made.
  const driven = { running: false, lost: false, pid: 4242, attempt: 1, started_at: '2026-10-06T19:30:00Z', ended_at: '2026-10-06T19:41:00Z', exit_code: 0, url: 'https://claude.ai/code/project/chan_01NEW', carry_on: '', made: '', message: '', command: 'x', log: 'x', tail: [] };
  const made = storedDoneExport({ chainError: null, driven });
  const again = await workerHarness({ chrome: fakeChrome({ data: new Map([['cswap.job', JSON.stringify(made)]]) }), hostJob: () => null, duplicate: { onDisk, serveJobGet: true } });
  const copying = again.connectPanel().cmd('duplicate.import', { name: 'beethoven 2' });
  await atOpenWindow(again, made.export.path);
  const copied = await copying;
  assert.equal(copied.ok, true, copied.error);
  assert.deepEqual(again.made.requests.find(r => r.type === 'import.queue'), { type: 'import.queue', dialog: again.made.windows[0].id, signed_in: true, name: 'beethoven 2' });
});

test('worker: after a restart, Import sends the export\'s end again when the bridge never heard it', async () => {
  const exportId = 'job_20261005T150000_b2c3d4';
  const project = { id: CHANNEL, name: 'beethoven', kind: 'code', org_uuid: ORG_CHAT, org_name: 'Personal' };
  const destination = { slot: '2', email: 'b@example.com', org_uuid: ORG_CHAT, organization: 'Beethoven Org' };
  // What the worker had stored when it went away: the export done, its
  // import never asked for.
  const stored = {
    ...EXPORT_JOB(), status: 'done', phase: 'done', tabId: 7, chainError: null, result: EXPORT_DONE(),
    duplicate: { project, destination, name: null, import_job: null }, account: { slot: '', email: 'a@example.com', org_uuid: ORG_CHAT },
    export: { ...EXPORT_JOB().export, path: OWN_TAR, archive: true, name: 'beethoven', kind: 'code', files: 1, bytes: 34 },
  };
  const chrome = fakeChrome({ data: new Map([['cswap.job', JSON.stringify(stored)]]) });
  const h = await workerHarness({ chrome, hostJob: () => null, duplicate: { serveJobGet: true } });
  assert.equal(h.job().chainError, null, 'nothing was being queued: nothing to say');
  assert.match(dupMod.afterExportView(h.job()).command, /^cswap project-move import /);
  // The bridge never heard the end: it still lists the export as running.
  h.made.duplicate.exportJob = { ...stored, status: 'running', phase: 'running', chainError: undefined };
  h.made.current = exportId;
  const panel = h.connectPanel();
  const pressing = panel.cmd('duplicate.import', { name: '' });
  await atOpenWindow(h, OWN_TAR);
  const answer = await pressing;
  assert.equal(answer.ok, true, answer.error);
  const ends = h.made.events.filter(e => e.job === exportId && (e.event === 'done' || e.event === 'phase'));
  assert.deepEqual(ends.map(e => [e.event, e.detail || '']), [['done', ''], ['phase', 'sent again']]);
  assert.deepEqual(ends[0].result, stored.result);
  const wire = h.made.wire;
  assert.ok(wire.indexOf('request:job.get') < wire.indexOf('event:done'));
  assert.ok(wire.indexOf('event:phase') < wire.indexOf('request:import.queue'));
  await until(() => h.job().id === 'job_20261005T150100_c3d4e5', 'the import claimed');
  assert.equal(h.job().tabId, 7);
});

test('worker: a full event queue keeps a job\'s end and the event on its way, and takes a delivered event out by identity', async () => {
  const h = await workerHarness();
  await h.runToReady();
  const max = backgroundMod.EVENT_QUEUE_MAX;
  const warn = msg => h.made.forward({ level: 'warn', event: 'page', msg, data: {} });
  // The bridge goes away and stays away; statuses, the end and a flood of
  // warnings queue up behind it.
  h.made.refuseConnect = true;
  h.made.dropPort();
  for (let i = 0; i < 3; i++) {
    h.page.client.send({ type: 'script.event', kind: 'status', text: `status ${i}` });
    await settle();
    await h.timers.advance(1000);
  }
  h.page.client.send({ type: 'script.event', kind: 'done', result: { created: null, status: 'Done.', link: '', paused: false, rows: [], counts: {} } });
  await until(() => h.job().phase === 'done', 'done');
  for (let i = 0; i < max + 20; i++) warn(`w${i}`);
  assert.equal(h.bg.state().eventQueue, max);
  // The port is back: everything left is delivered in order, once.
  const from = h.made.events.length;
  h.made.restorePort();
  warn('w-last');
  await until(() => h.bg.state().eventQueue === 0, 'delivered');
  const got = h.made.events.slice(from);
  assert.equal(got.length, max);
  assert.deepEqual(got.slice(0, 2).map(e => e.event), ['done', 'phase'], 'the end kept, the statuses dropped first');
  assert.ok(!got.some(e => e.event === 'status'));
  const lines = got.slice(2).map(e => e.msg);
  assert.equal(lines[lines.length - 1], 'w-last');
  const numbers = lines.slice(0, -1).map(m => Number(m.slice(1)));
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), 'in queue order');
  assert.equal(new Set(lines).size, lines.length, 'none twice');
  assert.equal(numbers[numbers.length - 1], max + 19, 'the oldest lines went, not the newest');
  // An event on its way when the queue overflows is not the one dropped,
  // and its answer takes it out, not an event still waiting.
  h.made.holdAcks = true;
  warn('on its way');
  await until(() => h.made.heldAcks.length === 1, 'sent');
  for (let i = 0; i < max + 5; i++) warn(`x${i}`);
  assert.equal(h.bg.state().eventQueue, max);
  h.made.holdAcks = false;
  h.made.ackNext();
  await until(() => h.bg.state().eventQueue === 0, 'delivered');
  const after = h.made.events.slice(from + max).map(e => e.msg);
  assert.equal(after[0], 'on its way');
  assert.equal(after.filter(m => m === 'on its way').length, 1);
  assert.equal(new Set(after).size, after.length, 'none twice');
  assert.equal(after[after.length - 1], `x${max + 4}`);
  assert.equal(after.length, max, 'every queued line delivered');
});

test('worker: a status the one-a-second rhythm held back goes out before the end, and none after it', async () => {
  const h = await workerHarness();
  await h.runToReady();
  const from = h.made.events.length;
  h.page.client.send({ type: 'script.event', kind: 'status', text: 'Adding 1/2' });
  await settle();
  h.page.client.send({ type: 'script.event', kind: 'status', text: 'Adding 2/2' });
  await settle();
  h.page.client.send({ type: 'script.event', kind: 'done', result: { created: null, status: 'Done.', link: '', paused: false, rows: [], counts: {} } });
  await until(() => h.job().phase === 'done', 'done');
  await settle(20);
  assert.deepEqual(h.made.events.slice(from).map(e => [e.event, e.text || e.phase || '']), [['status', 'Adding 1/2'], ['status', 'Adding 2/2'], ['done', ''], ['phase', 'done']]);
  await h.timers.advance(2000);
  h.page.client.send({ type: 'script.event', kind: 'status', text: 'late' });
  await settle(20);
  assert.equal(h.made.events.length, from + 4, 'nothing after the end');
});

test('worker: an event the bridge refuses for now is kept and sent once later; one it refuses for good is dropped and the rest go on', async () => {
  const h = await workerHarness();
  await h.runToReady();
  const warn = msg => h.made.forward({ level: 'warn', event: 'page', msg, data: {} });
  // The host is busy (its lock), then fails: the end waits in the queue,
  // nothing is sent twice within one flush, and the port stays open for it.
  h.made.refuseEvents.push('busy');
  h.page.client.send({ type: 'script.event', kind: 'done', result: { created: null, status: 'Done.', link: '', paused: false, rows: [], counts: {} } });
  await until(() => h.job().phase === 'done', 'done');
  await settle(20);
  assert.equal(h.made.wire.filter(w => w === 'event:done').length, 1, 'tried once');
  assert.ok(!h.made.events.some(e => e.event === 'done'));
  assert.equal(h.bg.state().eventQueue, 2);
  assert.equal(h.made.isConnected(), true, 'kept open while the end waits');
  h.made.refuseEvents.push('internal');
  warn('nudge 1');
  await settle(20);
  assert.equal(h.made.wire.filter(w => w === 'event:done').length, 2);
  assert.ok(!h.made.events.some(e => e.event === 'done'));
  assert.equal(h.bg.state().eventQueue, 3);
  warn('nudge 2');
  await until(() => h.bg.state().eventQueue === 0, 'delivered');
  assert.equal(h.made.events.filter(e => e.event === 'done').length, 1, 'delivered once');
  assert.deepEqual(h.made.events.filter(e => e.event === 'log').map(e => e.msg), ['nudge 1', 'nudge 2']);
  // A refusal for good: that event goes, the next one is delivered.
  h.made.refuseEvents.push('not-claimed');
  warn('refused for good');
  warn('the next line');
  await until(() => h.bg.state().eventQueue === 0, 'delivered');
  const logs = h.made.events.filter(e => e.event === 'log').map(e => e.msg);
  assert.ok(!logs.includes('refused for good'));
  assert.ok(logs.includes('the next line'));
  assert.ok(h.made.logs.some(r => r.msg === 'the bridge refused an event; dropped' && r.data.code === 'not-claimed'));
});

test('worker: an event queued while a flush is ending is still sent, with nothing else to set it off', async () => {
  const h = await workerHarness();
  await h.runToReady();
  const warn = msg => h.made.forward({ level: 'warn', event: 'page', msg, data: {} });
  // The second line is queued a few steps after the first one's answer,
  // at each step of the window in which the run that sent the first one
  // is winding down.
  for (let depth = 0; depth < 10; depth++) {
    h.made.holdAcks = true;
    warn(`first ${depth}`);
    await until(() => h.made.heldAcks.length === 1, 'the first line sent');
    h.made.ackNext();
    let step = Promise.resolve();
    for (let i = 0; i < depth; i++) step = step.then(() => {});
    await step.then(() => warn(`second ${depth}`));
    h.made.holdAcks = false;
    for (let i = 0; i < 20 && h.made.heldAcks.length; i++) { h.made.ackNext(); await settle(); }
    await settle(20);
    assert.ok(h.made.events.some(e => e.msg === `second ${depth}`), `depth ${depth}: sent`);
    assert.equal(h.bg.state().eventQueue, 0, `depth ${depth}: nothing left`);
  }
});

test('worker: an import in its own window, asked for after the export, goes to the bridge with the job id only; the worker keeps what it says, follows it and says how it ended', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: { drivenCapable: true } });
  h.pageIdentity = SIGNED_IN_AS_A;
  const panel = h.connectPanel();
  await duplicateToChosen(h, panel);
  await duplicateToRunning(h);
  assert.equal(h.job().importWay, 'tab');
  await writeOneFile(h);
  const exportId = h.job().id;
  h.page.client.send({ type: 'script.event', kind: 'done', result: EXPORT_DONE() });
  await until(() => h.job().phase === 'done', 'the export done');
  await settle(20);
  assert.ok(!h.made.requests.some(r => r.type === 'import.driven'), 'nothing started on its own');
  const started = await panel.cmd('duplicate.driven');
  assert.equal(started.ok, true, started.error);
  const asked = h.made.requests.filter(r => r.type === 'import.driven');
  assert.deepEqual(asked, [{ type: 'import.driven', job: exportId }], 'the job id and nothing else');
  assert.ok(!h.made.requests.some(r => r.type === 'import.queue' || r.type === 'job.claim'));
  // The bridge heard the end before it was asked.
  assert.ok(h.made.wire.indexOf('event:done') < h.made.wire.indexOf('request:import.driven'));
  assert.deepEqual(h.chrome.tabs.updated, [], 'the tab stays where it is');
  const job = h.job();
  assert.equal(job.id, exportId);
  assert.equal(job.phase, 'done');
  assert.equal(job.chainError, null);
  assert.equal(job.driven.pid, 4242);
  assert.equal(job.driven.running, true);
  assert.equal(h.bg.state().drivenRunning, true);
  assert.equal(dupMod.afterExportView(job).running, true);
  assert.ok(h.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: export finished' && /in a window of its own\.$/.test(n.message)));
  assert.ok(h.chrome.alarms.created.some(a => a.name === 'cswap-poll'), 'the poll alarm follows it');
  // The port stays open while it runs: the panel's questions need no new host.
  assert.equal(h.made.isConnected(), true);
  const connects = h.made.connects;
  const r1 = await panel.cmd('duplicate.driven.refresh');
  assert.equal(r1.ok, true);
  assert.deepEqual(h.made.requests.filter(r => r.type === 'import.driven.state').pop(), { type: 'import.driven.state', job: exportId });
  await panel.cmd('duplicate.driven.refresh');
  assert.equal(h.made.connects, connects, 'no new host per question');
  // While it runs, a second start, Import and a new export are refused.
  const twice = await panel.cmd('duplicate.driven');
  assert.deepEqual([twice.ok, twice.error], [false, dupMod.DRIVEN_RUNNING_TEXT]);
  assert.equal((await panel.cmd('duplicate.import', { name: '' })).error, dupMod.DRIVEN_RUNNING_TEXT);
  assert.ok(!h.made.windows.some(w => w.purpose === 'open'), 'no Open window while it runs');
  const another = await panel.cmd('duplicate.start');
  assert.deepEqual([another.ok, another.error], [false, dupMod.DRIVEN_RUNNING_TEXT]);
  // It ends: said once, the alarm stops, the port is let go.
  Object.assign(h.made.duplicate.drivenState, { running: false, ended_at: '2026-10-06T19:41:00Z', exit_code: 0, url: 'https://claude.ai/code/project/chan_01NEW', tail: ['Imported: the new project is at https://claude.ai/code/project/chan_01NEW'] });
  await panel.cmd('duplicate.driven.refresh');
  assert.equal(h.job().driven.running, false);
  assert.equal(h.job().driven.url, 'https://claude.ai/code/project/chan_01NEW');
  const finished = h.chrome.notifications.shown.filter(n => n.title === 'Claude Swap Cloud: import finished');
  assert.deepEqual(finished.map(n => n.message), ['The copy is at https://claude.ai/code/project/chan_01NEW']);
  assert.ok(h.chrome.alarms.cleared.includes('cswap-poll'));
  assert.equal(h.made.isConnected(), false);
  await panel.cmd('duplicate.driven.refresh');
  assert.equal(h.chrome.notifications.shown.filter(n => n.title === 'Claude Swap Cloud: import finished').length, 1, 'said once');
  // The copy is made: neither way starts it again.
  const again = await panel.cmd('duplicate.driven');
  assert.equal(again.ok, false);
  assert.match(again.error, /already made: https:\/\/claude\.ai\/code\/project\/chan_01NEW/);
  // Import opens the window all the same (another export may be opened
  // in it); closed without a choice, nothing starts.
  const pressing = panel.cmd('duplicate.import', { name: '' });
  await atOpenWindow(h, null);
  { const r = await pressing; assert.deepEqual([r.ok, r.text], [true, dupMod.OPEN_CANCELLED_TEXT]); }
  assert.ok(!h.made.requests.some(r => r.type === 'import.queue'));
  assert.equal(h.made.duplicate.drivenStarts, 1);
  assert.equal(dupMod.afterExportView(h.job()).link, 'https://claude.ai/code/project/chan_01NEW');
});

test('worker: greg\'s stored export, done with its import never started, is imported in its own window on the worker\'s command', async () => {
  const exportId = 'job_20261006T192324_688078';
  const stored = {
    ...EXPORT_JOB(), id: exportId, status: 'done', phase: 'done', tabId: 7, result: EXPORT_DONE(),
    chainError: 'the bridge has not heard that the export finished',
    duplicate: { project: { id: CHANNEL, name: `This tab's workspace (${CHANNEL})`, kind: 'code', org_uuid: '', org_name: '' },
      destination: { slot: '3', email: 'go2432@example.com', org_uuid: '', organization: '' }, name: 'beethoven', import_job: null },
    account: { slot: '', email: 'a@example.com', org_uuid: '' },
    export: { ...EXPORT_JOB().export, path: 'C:\\Users\\greg\\Desktop\\beethoven (2)', name: `This tab's workspace (${CHANNEL})`, kind: 'code', files: 143, bytes: 287496608 },
  };
  // Stored by an earlier extension: no importWay, no driven, no capability noted.
  const chrome = fakeChrome({ data: new Map([['cswap.job', JSON.stringify(stored)]]) });
  const h = await workerHarness({ chrome, hostJob: () => null, duplicate: { drivenCapable: true, serveJobGet: true } });
  h.made.duplicate.exportJob = { ...stored, chainError: undefined };
  h.made.current = exportId;
  assert.equal(h.job().chainError, 'the bridge has not heard that the export finished', 'kept as it was');
  const view = dupMod.afterExportView(h.job());
  assert.equal(view.line, 'The import could not start: the bridge has not heard that the export finished');
  assert.equal(view.command, 'cswap project-move import --to 3 --folder="C:\\Users\\greg\\Desktop\\beethoven (2)" --name="beethoven"');
  assert.equal(dupMod.chainTexts(h.job()).drivenCommand, 'cswap project-move auto --export="C:\\Users\\greg\\Desktop\\beethoven (2)" --to 3 --name="beethoven"');
  const panel = h.connectPanel();
  const started = await panel.cmd('duplicate.driven');
  assert.equal(started.ok, true, started.error);
  assert.deepEqual(h.made.requests.filter(r => r.type === 'import.driven'), [{ type: 'import.driven', job: exportId }]);
  assert.ok(!h.made.events.some(e => e.event === 'done'), 'the bridge had heard the end: nothing sent again');
  assert.equal(h.job().chainError, null);
  assert.equal(h.job().driven.running, true);
  const twice = await panel.cmd('duplicate.driven');
  assert.deepEqual([twice.ok, twice.error], [false, dupMod.DRIVEN_RUNNING_TEXT]);
  assert.equal((await panel.cmd('duplicate.import', { destination: '3', name: '' })).error, dupMod.DRIVEN_RUNNING_TEXT);
  assert.equal(h.made.duplicate.drivenStarts, 1);
  assert.equal(dupMod.afterExportView(h.job()).running, true);
});

test('worker: the poll alarm follows an import in its own window, also after a restart, and stops when it ends', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: { drivenCapable: true } });
  h.pageIdentity = SIGNED_IN_AS_A;
  const panel = h.connectPanel();
  await duplicateToChosen(h, panel);
  await duplicateToRunning(h);
  await writeOneFile(h);
  h.page.client.send({ type: 'script.event', kind: 'done', result: EXPORT_DONE() });
  await until(() => h.job().phase === 'done', 'the export done');
  assert.equal((await panel.cmd('duplicate.driven')).ok, true);
  await until(() => h.job().driven, 'the import started');
  const fire = async () => { h.chrome.alarms.onAlarm.fire({ name: 'cswap-poll' }); await settle(20); };
  const before = h.made.requests.filter(r => r.type === 'import.driven.state').length;
  await fire();
  assert.equal(h.made.requests.filter(r => r.type === 'import.driven.state').length, before + 1);
  assert.ok(!h.made.requests.slice(-1).some(r => r.type === 'job.get'), 'no pickup while it runs');
  // A worker that restarts finds it running and arms the alarm again.
  const chrome2 = fakeChrome({ data: new Map(h.chrome.storage.local.data) });
  const h2 = await workerHarness({ chrome: chrome2, modules: h.mods });
  assert.ok(chrome2.alarms.created.some(a => a.name === 'cswap-poll'));
  assert.equal(h2.job().chainError, null, 'not taken for a hand-off cut short');
  Object.assign(h.made.duplicate.drivenState, { running: false, ended_at: '2026-10-06T19:41:00Z', exit_code: 1, carry_on: 'https://claude.ai/code/project/chan_01CARRY', message: 'The import stopped part-way: the window went away.' });
  chrome2.alarms.onAlarm.fire({ name: 'cswap-poll' });
  await until(() => h2.job().driven.running === false, 'the end heard');
  assert.ok(chrome2.alarms.cleared.includes('cswap-poll'));
  assert.ok(chrome2.notifications.shown.some(n => n.title === 'Claude Swap Cloud: import stopped' && /window went away/.test(n.message)));
  const view = dupMod.afterExportView(h2.job());
  assert.match(view.line, /^Stopped: The import stopped part-way: the window went away\. https:\/\/claude\.ai\/code\/project\/chan_01CARRY holds what was added/);
  assert.equal(view.command, 'cswap project-move auto --export="C:\\x\\beethoven.tar" --to 2');
});

test('worker: only the side panel can start an import in its own window: not a page, not a panel elsewhere', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: { drivenCapable: true, queueError: { code: 'export-incomplete', message: 'stopped' } } });
  h.pageIdentity = SIGNED_IN_AS_A;
  const panel = h.connectPanel();
  await duplicateToChosen(h, panel);
  await duplicateToRunning(h);
  // The page asks, under the job's own nonce and in the job's own tab.
  const id = h.page.client.send({ type: 'import.driven', job: h.job().id });
  await until(() => h.page.client.replies.some(r => r.re === id), 'answered');
  assert.equal(h.page.client.replies.find(r => r.re === id).reason, 'unknown-type');
  const fake = h.connectPanel('https://claude.ai/sidepanel.html');
  fake.client.postMessage({ id: 1, type: 'cmd', name: 'duplicate.driven', args: { job: h.job().id } });
  await settle(20);
  assert.ok(!fake.client.replies.some(r => r.re === 1), 'a panel that is not the extension\'s own is dropped');
  assert.ok(!h.made.requests.some(r => r.type === 'import.driven'));
});

test('worker: the import never starts on its own, whatever cswap can do; a cswap that cannot import in a window of its own says so, and Import in this tab is the way', async () => {
  const can = await workerHarness({ hostJob: () => null, duplicate: { drivenCapable: true } });
  can.pageIdentity = SIGNED_IN_AS_A;
  const panel = can.connectPanel();
  await duplicateToChosen(can, panel);
  await duplicateToRunning(can);
  assert.equal(can.job().importWay, 'tab');
  await writeOneFile(can);
  can.page.client.send({ type: 'script.event', kind: 'done', result: EXPORT_DONE() });
  await until(() => can.job().phase === 'done', 'the export done');
  await settle(30);
  assert.ok(!can.made.requests.some(r => r.type === 'import.driven' || r.type === 'import.queue'), 'nothing started on its own');
  assert.equal(can.job().driven, null);
  assert.ok(can.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: export finished' && n.message === dupMod.EXPORTED_NEXT_TEXT));
  // One that cannot: the own-window command is refused with why, and the
  // import in this tab still goes.
  const t = await workerHarness({ hostJob: () => null, duplicate: {} });
  t.pageIdentity = SIGNED_IN_AS_A;
  const panel2 = t.connectPanel();
  await duplicateToChosen(t, panel2);
  await duplicateToRunning(t);
  await writeOneFile(t);
  t.page.client.send({ type: 'script.event', kind: 'done', result: EXPORT_DONE() });
  await until(() => t.job().phase === 'done', 'the export done');
  const refused = await panel2.cmd('duplicate.driven');
  assert.deepEqual([refused.ok, refused.error], [false, dupMod.NO_DRIVEN_TEXT]);
  assert.ok(!t.made.requests.some(r => r.type === 'import.driven'));
  const importing = panel2.cmd('duplicate.import', { name: '' });
  await atOpenWindow(t, OWN_TAR);
  const imported = await importing;
  assert.equal(imported.ok, true, imported.error);
  await until(() => t.job().id === 'job_20261005T150100_c3d4e5', 'the import claimed in this tab');
  assert.equal(t.job().chainError, null);
});

test('worker: an import in its own window that cannot start says why, with both lines to type', async () => {
  const h = await workerHarness({ hostJob: () => null, duplicate: { drivenCapable: true, drivenError: { code: 'root-mismatch', message: 'cswap would look for its accounts in C:\\a, not in C:\\b; run the import by hand' } } });
  h.pageIdentity = SIGNED_IN_AS_A;
  const panel = h.connectPanel();
  await duplicateToChosen(h, panel);
  await duplicateToRunning(h);
  await writeOneFile(h);
  h.page.client.send({ type: 'script.event', kind: 'done', result: EXPORT_DONE() });
  await until(() => h.job().phase === 'done', 'the export done');
  const started = await panel.cmd('duplicate.driven');
  assert.equal(started.ok, false);
  await until(() => h.job().chainError, 'not started');
  assert.match(h.job().chainError, /run the import by hand/);
  assert.equal(h.job().driven, null);
  const stopped = h.chrome.notifications.shown.find(n => n.title === 'Claude Swap Cloud: import not started');
  assert.match(stopped.message, /^The import could not start: cswap would look for its accounts/);
  assert.match(stopped.message, /cswap project-move import --to NUM --folder="C:\\x\\beethoven\.tar"/);
  assert.ok(!/in a window of its own/.test(stopped.message), 'no account named: no line for a window of its own');
  const view = dupMod.afterExportView(h.job());
  assert.equal(view.line, `The import could not start: ${h.job().chainError}`);
  assert.equal(h.made.isConnected(), false, 'nothing runs: the port is let go');
});

// A finished Duplicate export as the worker stored it, its import not
// started: what a restart, an older worker or a failed hand-off leaves.
function storedDoneExport(extra = {}) {
  return {
    ...EXPORT_JOB(), status: 'done', phase: 'done', tabId: 7, result: EXPORT_DONE(),
    chainError: 'the bridge has not heard that the export finished',
    duplicate: { project: { id: CHANNEL, name: 'beethoven', kind: 'code', org_uuid: ORG_CHAT, org_name: 'Personal' },
      destination: { slot: '2', email: 'b@example.com', org_uuid: ORG_CHAT, organization: 'Beethoven Org' }, name: null, import_job: null },
    account: { slot: '', email: 'a@example.com', org_uuid: ORG_CHAT },
    export: { ...EXPORT_JOB().export, path: OWN_TAR, archive: true, name: 'beethoven', kind: 'code', files: 1, bytes: 34 },
    ...extra,
  };
}

test('worker: Try the import again waits for a pickup under way; the import it took up is not queued, claimed or adopted a second time', async () => {
  const stored = storedDoneExport();
  const chrome = fakeChrome({ data: new Map([['cswap.job', JSON.stringify(stored)]]) });
  const h = await workerHarness({ chrome, hostJob: () => null, duplicate: { serveJobGet: true } });
  // The bridge already holds the import queued from this export (its end
  // was heard and import.queue answered before the worker went away).
  h.made.duplicate.exportJob = { ...stored, chainError: undefined };
  const importId = 'job_20261005T150100_c3d4e5';
  h.made.duplicate.importJob = {
    ...HOST_JOB(), id: importId, status: 'queued',
    duplicate: { export_job: stored.id, source: { email: 'a@example.com', org_uuid: ORG_CHAT, project: stored.duplicate.project } },
  };
  h.made.current = importId;
  // A page load starts a pickup; the host is slow to answer it.
  h.made.holdRequests.add('job.get');
  const picking = h.bg.pickup('page.state', true);
  await until(() => h.made.heldRequests.length === 1, 'the pickup asked the host');
  // The person presses Try the import again meanwhile.
  const pressed = h.connectPanel().cmd('duplicate.import');
  await settle(20);
  assert.equal(h.made.heldRequests.length, 1, 'nothing more asked while the pickup is under way');
  h.made.holdRequests.clear();
  h.made.releaseRequest();
  await picking;
  const answer = await pressed;
  assert.equal(answer.ok, false);
  assert.equal(answer.error, `A job is already running (${importId}); wait for it or cancel it first.`, 'the pickup took the import up, and that job is the reason');
  assert.equal(h.job().id, importId);
  assert.equal(h.made.requests.filter(r => r.type === 'job.claim').length, 1, 'claimed once');
  assert.equal(h.made.events.filter(e => e.event === 'claimed').length, 1, 'adopted once');
  assert.ok(!h.made.requests.some(r => r.type === 'import.queue'), 'never asked to queue the import itself');
  assert.equal(h.job().chainError, null);
  assert.ok(!h.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: import not started'));
});

test('worker: a pickup that began before a Duplicate started adopts nothing once the Duplicate is the job', async () => {
  const h = await workerHarness({ duplicate: {} });
  h.made.holdRequests.add('job.get');
  const picking = h.bg.pickup('page.state', true);
  await until(() => h.made.heldRequests.length === 1, 'the pickup asked the host');
  // An export starts while the host has not answered the pickup yet.
  h.connectContent(7, PROJECT_PAGE);
  await h.sendPageState({ url: PROJECT_PAGE });
  h.made.holdRequests.clear();
  const started = await h.connectPanel().cmd('duplicate.start');
  assert.equal(started.ok, true, started.error);
  const exportId = h.job().id;
  h.made.releaseRequest();
  assert.equal(await picking, null);
  assert.equal(h.job().id, exportId, 'the Duplicate stays the job');
  assert.ok(!h.made.requests.some(r => r.type === 'job.claim'), 'the queued import was not claimed beside it');
});

test('worker: an import in its own window the bridge can no longer answer for counts as lost, so new Duplicates are not kept out for good', async () => {
  const running = { running: true, lost: false, pid: 4242, attempt: 1, started_at: '2026-10-06T19:30:00Z', ended_at: '', exit_code: null, url: '', carry_on: '', made: '', message: '', command: 'x', log: 'x', tail: [] };
  for (const [what, duplicate] of [
    ['a bridge that answers unknown-type', { drivenCapable: true, drivenStateError: { code: 'unknown-type', message: 'unknown message type: import.driven.state' } }],
    ['a cswap whose hello no longer lists driven', { drivenCapable: false }],
  ]) {
    const stored = storedDoneExport({ chainError: null, importWay: 'driven', driven: running, drivenNotified: false });
    const chrome = fakeChrome({ data: new Map([['cswap.job', JSON.stringify(stored)]]) });
    const h = await workerHarness({ chrome, hostJob: () => null, duplicate });
    assert.equal(h.bg.state().drivenRunning, true, what);
    const panel = h.connectPanel();
    assert.equal((await panel.cmd('duplicate.start')).error, dupMod.DRIVEN_RUNNING_TEXT, what);
    const asked = await panel.cmd('duplicate.driven.refresh');
    assert.equal(asked.ok, true, `${what}: ${asked.error}`);
    const driven = h.job().driven;
    assert.equal(driven.running, false, what);
    assert.equal(driven.lost, true, what);
    assert.match(driven.message, /can no longer say how the import in its own window stands/, what);
    assert.equal(h.bg.state().drivenRunning, false, what);
    assert.ok(h.chrome.notifications.shown.some(n => n.title === 'Claude Swap Cloud: import stopped'), what);
    assert.ok(h.chrome.alarms.cleared.includes('cswap-poll'), what);
    const view = dupMod.afterExportView(h.job());
    assert.match(view.line, /^The import's window closed before it said how it ended\. Check b@example\.com's projects/, what);
    assert.notEqual((await panel.cmd('duplicate.start')).error, dupMod.DRIVEN_RUNNING_TEXT, `${what}: a new Duplicate may start`);
  }
});

test('worker: with a part-made copy to carry on in, the import in this tab is refused; only Carry on goes on in it', async () => {
  const carryOn = 'https://claude.ai/code/project/chan_01CARRY';
  const stored = storedDoneExport({
    chainError: 'cswap would look for its accounts in C:\\a, not in C:\\b; run the import by hand',
    driven: { running: false, lost: false, pid: 4242, attempt: 1, started_at: '2026-10-06T19:30:00Z', ended_at: '2026-10-06T19:40:00Z', exit_code: 1, url: '', carry_on: carryOn, made: carryOn, message: 'stopped', command: 'x', log: 'x', tail: [] },
  });
  const chrome = fakeChrome({ data: new Map([['cswap.job', JSON.stringify(stored)]]) });
  const h = await workerHarness({ chrome, hostJob: () => null, duplicate: { drivenCapable: true, serveJobGet: true } });
  const pressing = h.connectPanel().cmd('duplicate.import');
  await atOpenWindow(h, stored.export.path);
  const answer = await pressing;
  assert.equal(answer.ok, false);
  assert.equal(answer.error, dupMod.carryOnOnlyText(carryOn));
  assert.ok(!h.made.requests.some(r => r.type === 'import.queue'), 'no second project queued');
  assert.equal(h.job().id, stored.id);
});

test('worker: opening the panel on a finished export whose import never started asks the bridge once, for the folder and what this cswap can do', async () => {
  // Stored by extension 0.2.0: no folder, and a hello from before cswap was
  // updated (no import in a window of its own).
  const stored = storedDoneExport({ export: { ...storedDoneExport().export, path: '' } });
  const oldHello = { connected: false, userScripts: true, lastHello: { cswap: '0.27.0', capabilities: ['job', 'duplicate'] } };
  const chrome = fakeChrome({ data: new Map([['cswap.job', JSON.stringify(stored)], ['cswap.bridge', JSON.stringify(oldHello)]]) });
  const h = await workerHarness({ chrome, hostJob: () => null, duplicate: { drivenCapable: true, serveJobGet: true } });
  h.made.duplicate.exportJob = { ...stored, export: { ...stored.export, path: 'C:\\Users\\greg\\Desktop\\beethoven (2)' }, chainError: undefined };
  h.made.current = stored.id;
  assert.equal(h.made.connects, 0, 'nothing asked before the panel opens');
  assert.equal(dupMod.chainTexts(h.job()).drivenCommand, '', 'no line without the folder');
  h.connectPanel();
  await until(() => h.job().export.path === 'C:\\Users\\greg\\Desktop\\beethoven (2)', 'the folder learned');
  assert.equal(h.made.connects, 1);
  assert.deepEqual(h.made.requests.map(r => r.type), ['job.get']);
  assert.ok(dupMod.helloCan(h.made.helloReply, dupMod.DRIVEN_CAPABILITY), 'the host said what it can now (native.js stores it)');
  assert.equal(h.made.isConnected(), false, 'let go after');
  assert.equal(h.job().chainError, stored.chainError, 'nothing started');
  assert.equal(dupMod.chainTexts(h.job()).drivenCommand, 'cswap project-move auto --export="C:\\Users\\greg\\Desktop\\beethoven (2)" --to 2');
  assert.match(dupMod.chainTexts(h.job()).command, /--folder="C:\\Users\\greg\\Desktop\\beethoven \(2\)"$/);
  // Nothing more to learn: the next panel asks nothing.
  await h.chrome.storage.local.set({ 'cswap.bridge': { ...oldHello, lastHello: { cswap: '0.28.0', capabilities: ['job', 'duplicate', 'driven'] } } });
  h.connectPanel();
  await settle(20);
  assert.equal(h.made.connects, 1);
});

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
  assert.deepEqual(Object.keys(stored('cswap.config')).sort(), ['logLevel', 'logMaxRecords', 'logRetentionHours', 'notifications', 'readSpacingMs', 'requestTimeoutMs', 'retryAfterCapMs', 'version', 'writeSpacingMs']);
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
  // A read right after it goes at once: no spacing before a read by default,
  // and no clock moved for it.
  page.client.postMessage({ id: ++mid, type: 'gate.permit', requestId: 'r1b', stepKey: 'GET /api/account ', method: 'GET', path: '/api/account', kind: 'script', bodyBytes: 0 });
  await until(() => replies.filter(r => typeof r.permit === 'string').length === 2, 'the read\'s permit at once');
  const read = replies.filter(r => typeof r.permit === 'string')[1];
  assert.equal(read.waitedMs, 0);
  assert.ok(!fakes.made.events.some(e => e.event === 'wait' && e.reason === 'spacing'), 'no spacing before a read');
  page.client.postMessage({ id: ++mid, type: 'gate.report', requestId: 'r1b', permit: read.permit, status: 200, ok: true, redirected: false, finalPath: '', headers: { 'content-type': 'application/json' }, elapsedMs: 5, markers: [] });
  await until(() => stored('cswap.gate').counters.ok === 2, 'the read reported');
  // A write waits the spacing before a write, from the end of the read; its
  // challenge is classified by the real interrupt.js and recorded by the real interrupts store.
  page.client.postMessage({ id: ++mid, type: 'gate.permit', requestId: 'r2', stepKey: 'POST /api/x ', method: 'POST', path: '/api/x', kind: 'script', bodyBytes: 2 });
  await settle();
  assert.equal(replies.filter(r => typeof r.permit === 'string').length, 2, 'the write waits for the spacing before a write');
  assert.equal(stored('cswap.gate').wait.reason, 'spacing');
  assert.ok(fakes.made.events.some(e => e.event === 'wait' && e.reason === 'spacing' && e.state === 'start'));
  await timers.advance(600);
  await until(() => replies.filter(r => typeof r.permit === 'string').length === 3, 'the write\'s permit after the spacing');
  const second = replies.filter(r => typeof r.permit === 'string')[2];
  assert.ok(second.waitedMs >= 500, `the write waited ${second.waitedMs} ms`);
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
  assert.deepEqual(idle.buttons, { resume: false, cancel: false, retry: false, giveUp: false, confirm: false, refresh: true });
  assert.equal(idle.controls, false);
  assert.match(idle.statusLine, /Press Export this project/);
  assert.equal(idle.phaseBadge, 'idle');
  const job = { id: 'j', phase: 'running', export: { name: 'beethoven', kind: 'code', files: 9, conversations: 3 }, account: { slot: '2', email: 'b@example.com' }, lastStatusText: 'Adding 3/9' };
  const running = viewModel({ job, gate: { phase: 'in-flight', inFlight: { method: 'POST', path: '/api/x', attempt: 2 }, counters: { requests: 3, ok: 2, slowDowns: 1, waitedMs: 4000 } } }, 0);
  assert.deepEqual(running.buttons, { resume: false, cancel: true, retry: false, giveUp: false, confirm: false, refresh: true });
  assert.equal(running.controls, true);
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
  assert.equal(paused.buttons.resume, true);
  assert.equal(paused.phaseBadge, 'paused');
  const heldJob = { ...job, phase: 'held', heldReason: 'failed-step' };
  const held = viewModel({ job: heldJob, gate: { phase: 'held', held: { reason: 'failed-step', stepKey: 'POST /api/up form:a:1', method: 'POST', path: '/api/up', status: 503, attempt: 4 } } }, 0);
  // A failed step is for Retry or Give up: Resume would do nothing to it.
  assert.deepEqual(held.buttons, { resume: false, cancel: true, retry: true, giveUp: true, confirm: false, refresh: true });
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
    body, activeElement: null, defaultView: { confirm: () => true, navigator: {} },
    getElementById: id => all.find(n => n.id === id) || null,
    createElement: tag => el(tag),
    createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
  };
  return { doc, all, byId: id => doc.getElementById(id), field: name => doc.getElementById('settings-form').querySelectorAll('[name]').find(i => i.name === name) };
}

// The panel's chrome: storage with onChanged, and a worker behind the panel
// port that answers config.set and config.reset by writing the storage.
function makePanelChrome({ data, defaults, hold = [] }) {
  const onChanged = fakeEvent();
  const storage = { get: async keys => { const out = {}; for (const k of keys) if (data.has(k)) out[k] = JSON.parse(data.get(k)); return out; } };
  const set = obj => {
    const changes = {};
    for (const [k, v] of Object.entries(obj)) { const oldValue = data.has(k) ? JSON.parse(data.get(k)) : undefined; data.set(k, JSON.stringify(v)); changes[k] = { oldValue, newValue: v }; }
    onChanged.fire(changes, 'local');
  };
  const cmds = [];
  const held = [];
  const connect = () => {
    const pair = makePortPair({ name: 'cswap-panel' });
    pair.server.onMessage.addListener(m => {
      cmds.push(m);
      if (hold.includes(m.name)) { held.push({ m, answer: (body = { ok: true }) => pair.server.postMessage({ re: m.id, ...body }) }); return; }
      if (m.name === 'config.set') { set({ 'cswap.config': { ...JSON.parse(data.get('cswap.config')), ...m.args.config } }); pair.server.postMessage({ re: m.id, ok: true, problems: [] }); return; }
      if (m.name === 'config.reset') { set({ 'cswap.config': defaults }); pair.server.postMessage({ re: m.id, ok: true }); return; }
      pair.server.postMessage({ re: m.id, ok: true });
    });
    return pair.client;
  };
  return { chrome: { runtime: { id: 'ext-id', connect }, storage: { local: storage, onChanged } }, set, cmds, held };
}

test('sidepanel: a setting being edited is not overwritten by a render; Save and Reset let the store lead again', async () => {
  const defaults = { version: 2, readSpacingMs: 0, writeSpacingMs: 500, retryAfterCapMs: 900000, requestTimeoutMs: 120000, notifications: true, logLevel: 'info', logMaxRecords: 2000, logRetentionHours: 72 };
  const data = new Map([['cswap.config', JSON.stringify(defaults)], ['cswap.job', JSON.stringify({ id: 'j', phase: 'running', lastStatusText: 'Adding 1/9' })]]);
  const { chrome, set, cmds } = makePanelChrome({ data, defaults });
  const { doc, byId, field } = makePanelDom();
  const timers = fakeTimers();
  panelMod.createPanel({ chrome, doc, now: timers.now, schedule: timers.schedule });
  await settle();
  const spacing = field('writeSpacingMs');
  assert.equal(spacing.value, '500');
  assert.equal(field('readSpacingMs').value, '0');
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
  set({ 'cswap.config': { ...defaults, writeSpacingMs: 700 } });
  assert.equal(spacing.value, '3000');
  // A field that merely has focus is left alone too; once it loses focus the store's value goes in.
  const cap = field('retryAfterCapMs');
  doc.activeElement = cap;
  set({ 'cswap.config': { ...defaults, writeSpacingMs: 700, retryAfterCapMs: 120000 } });
  assert.equal(cap.value, '900000');
  doc.activeElement = null;
  set({ 'cswap.job': { id: 'j', phase: 'running', lastStatusText: 'Adding 3/9' } });
  assert.equal(cap.value, '120000');
  // Save sends what was typed; afterwards the form follows the store again.
  byId('btn-settings-save').click();
  await until(() => JSON.parse(data.get('cswap.config')).writeSpacingMs === 3000, 'saved');
  await settle();
  assert.equal(cmds.find(c => c.name === 'config.set').args.config.writeSpacingMs, 3000);
  assert.equal(spacing.value, '3000');
  set({ 'cswap.config': { ...JSON.parse(data.get('cswap.config')), writeSpacingMs: 900 } });
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

test('sidepanel: the setup section folds on its own until the person opens or closes it', async () => {
  const defaults = { version: 2, readSpacingMs: 0, writeSpacingMs: 500, retryAfterCapMs: 900000, requestTimeoutMs: 120000, notifications: true, logLevel: 'info', logMaxRecords: 2000, logRetentionHours: 72 };
  const data = new Map([['cswap.config', JSON.stringify(defaults)], ['cswap.bridge', JSON.stringify({ userScripts: true, connected: false, lastErrorCode: 'no-host', lastError: 'not found' })]]);
  const { chrome, set } = makePanelChrome({ data, defaults });
  const { doc, byId } = makePanelDom();
  const timers = fakeTimers();
  panelMod.createPanel({ chrome, doc, now: timers.now, schedule: timers.schedule });
  await settle();
  const details = byId('setup-details');
  assert.equal(details.open, true, 'a step to do opens the section');
  // The browser fires toggle for the panel's own change too; that is not the person.
  details.fire('toggle');
  assert.equal(details.dataset.touched, undefined);
  set({ 'cswap.bridge': { userScripts: true, connected: true, lastHello: { cswap: '0.27.0' } } });
  set({ 'cswap.job': { id: 'j', phase: 'running' } });
  await settle();
  assert.equal(details.open, false, 'everything in place and an import running: folded');
  details.fire('toggle');
  assert.equal(details.dataset.touched, undefined);
  // The person opens it: from then on the panel leaves it alone.
  details.open = true;
  details.fire('toggle');
  assert.equal(details.dataset.touched, '1');
  set({ 'cswap.job': { id: 'j', phase: 'running', lastStatusText: 'Adding 1/9' } });
  await settle();
  assert.equal(details.open, true);
});

test('sidepanel viewModel: bridge hints, settings problems and log lines', () => {
  const { viewModel, logLines } = panelMod;
  const noScripts = viewModel({ bridge: { connected: false, userScripts: false, userScriptsError: 'turn it on' } }, 0);
  assert.equal(noScripts.bridge.hint, 'turn it on');
  assert.equal(noScripts.bridge.userScripts, false);
  const noHost = viewModel({ bridge: { connected: false, userScripts: true, lastError: nativeMod.INSTALL_HINT, lastErrorCode: 'no-host' }, extensionId: 'abcdefghijklmnopabcdefghijklmnop' }, 0);
  assert.equal(noHost.bridge.hint, nativeMod.INSTALL_HINT);
  assert.equal(noHost.setup.allOk, false);
  assert.equal(noHost.setup.steps[1].state, 'todo');
  assert.ok(noHost.setup.steps[1].commands.includes('cswap bridge install --register --extension-id abcdefghijklmnopabcdefghijklmnop'));
  assert.equal(noScripts.setup.steps[0].state, 'todo');
  const elsewhere = viewModel({ bridge: { connected: true, userScripts: true, lastHello: { cswap: '0.27' }, jobElsewhere: { id: 'job_x' } } }, 0);
  assert.match(elsewhere.bridge.hint, /job_x/);
  assert.match(elsewhere.bridge.hint, /import --cancel/);
  assert.equal(elsewhere.bridge.canDrop, false);
  assert.equal(elsewhere.bridge.cswap, '0.27');
  // A cswap that can drop a job: Drop that job is offered, unless a job
  // of this browser's is under way.
  const dropper = { connected: true, userScripts: true, lastHello: { cswap: '0.29', capabilities: ['job', 'drop'] }, jobElsewhere: { id: 'job_x', claimed_by: { instance: 'o', at: '2026-10-07T00:35:12Z' } } };
  const canDrop = viewModel({ bridge: dropper }, 0);
  assert.match(canDrop.bridge.hint, /since 2026-10-07T00:35:12Z/);
  assert.match(canDrop.bridge.hint, /Drop that job/);
  assert.equal(canDrop.bridge.canDrop, true);
  assert.equal(canDrop.bridge.elsewhereId, 'job_x');
  assert.equal(viewModel({ bridge: dropper, job: { id: 'j', kind: 'import', phase: 'running' } }, 0).bridge.canDrop, false);
  assert.equal(viewModel({ bridge: dropper, job: { id: 'j', kind: 'import', phase: 'done' } }, 0).bridge.canDrop, true);
  assert.equal(viewModel({ bridge: { ...dropper, userScripts: false } }, 0).bridge.canDrop, false);
  const problems = viewModel({ problems: [{ key: 'writeSpacingMs', message: 'too small' }] }, 0);
  assert.deepEqual(problems.problems, [{ key: 'writeSpacingMs', message: 'too small' }]);
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

test('sidepanel viewModel: the Duplicate section and the lines of an export job', () => {
  const { viewModel } = panelMod;
  const idle = viewModel({}, 0);
  assert.match(idle.statusLine, /Press Export this project/);
  assert.ok(!('canStart' in idle.duplicate), 'the buttons are always in place: no view says whether to offer one');
  assert.equal(idle.duplicate.line, '');
  assert.equal(idle.duplicate.after.show, false);
  const finding = viewModel({ job: { id: 'job_e', kind: 'export', phase: 'preflight', account: { slot: '', email: 'a@example.com', org_uuid: '' } } }, 0);
  assert.equal(finding.statusLine, 'Checking the page and the account.');
  assert.equal(finding.duplicate.line, "Finding this tab's project and who is signed in (a@example.com).");
  assert.equal(finding.duplicate.after.show, false);
  assert.equal(finding.buttons.cancel, true);
  assert.equal(finding.accountLine, 'from a@example.com');
  assert.equal(finding.exportLine, '');
  assert.equal(viewModel({ job: { id: 'job_e', kind: 'export', phase: 'choosing' } }, 0).statusLine, 'Finding the project this tab shows.');
  const exporting = viewModel({ job: { id: 'job_e', kind: 'export', phase: 'running', account: { email: 'a@example.com' }, export: { name: 'beethoven', kind: 'code', files: 3, bytes: 10 }, duplicate: { project: { id: CHANNEL, name: 'beethoven' }, destination: { slot: '2', email: 'b@example.com' } } } }, 0);
  assert.equal(exporting.statusLine, 'Exporting.');
  assert.equal(exporting.exportLine, 'beethoven (code, 3 files written)');
  assert.equal(exporting.accountLine, 'from a@example.com');
  assert.equal(exporting.duplicate.line, 'Exporting "beethoven" from a@example.com.');
  assert.equal(exporting.buttons.cancel, true);
  // Done: what came after it and the line to type, which names the
  // account only when the record does (an earlier version's).
  const doneJob = { id: 'job_e', kind: 'export', phase: 'done', chainError: null, account: { email: 'a@example.com' },
    export: { name: 'beethoven', kind: 'code', files: 3, path: 'C:\\x\\exports\\beethoven' },
    duplicate: { project: { id: CHANNEL, name: 'beethoven' }, destination: { slot: '2', email: 'b@example.com' }, name: null } };
  const done = viewModel({ job: doneJob }, 0);
  assert.equal(done.statusLine, 'Export done. Next: Sign out and reload, then Import.');
  assert.equal(done.duplicate.after.show, true);
  assert.equal(done.duplicate.after.line, `Exported "beethoven" (3 files) to C:\\x\\exports\\beethoven. ${dupMod.NEXT_STEPS_TEXT}`);
  assert.ok(!('button' in done.duplicate.after));
  assert.equal(done.duplicate.after.command, 'cswap project-move import --to 2 --folder="C:\\x\\exports\\beethoven"');
  assert.ok(!('accounts' in done.duplicate) && !('noAccounts' in done.duplicate), 'no account to choose');
  const unnamed = viewModel({ job: { ...doneJob, duplicate: { ...doneJob.duplicate, destination: null } } }, 0);
  assert.equal(unnamed.duplicate.after.command, 'cswap project-move import --to NUM --folder="C:\\x\\exports\\beethoven"');
  // The import queued for whoever is signed in: the account line names
  // the account once the page did, and says so until then.
  const whoever = { id: 'job_i', kind: 'import', phase: 'claimed', account: { slot: '', email: '', org_uuid: '', signed_in: true } };
  assert.equal(viewModel({ job: whoever }, 0).accountLine, 'into the account signed in on the page');
  assert.equal(viewModel({ job: { ...whoever, account: { ...whoever.account, email: 'b@example.com' } } }, 0).accountLine, 'into b@example.com');
  assert.equal(viewModel({ job: { ...whoever, account: { slot: '2', email: 'b@example.com', org_uuid: '' } } }, 0).accountLine, 'into Account-2 (b@example.com)');
  const stuck = viewModel({ job: { id: 'job_e', kind: 'export', phase: 'done', chainError: 'the bridge is gone', duplicate: { project: { id: CHANNEL, name: 'beethoven' }, destination: { slot: '2', email: 'b@example.com' } } } }, 0);
  assert.equal(stuck.statusLine, 'Exported, but the import could not start.');
  assert.equal(stuck.duplicate.after.line, 'The import could not start: the bridge is gone');
  assert.equal(stuck.duplicate.after.command, 'cswap project-move import --to 2');
  for (const job of [{ kind: 'export', phase: 'running', chainError: 'x' }, { kind: 'import', phase: 'done', chainError: 'x' }, { kind: 'export', phase: 'failed' }]) {
    assert.equal(viewModel({ job }, 0).duplicate.after.show, false, JSON.stringify(job));
  }
  assert.equal(viewModel({ job: { kind: 'export', phase: 'loading' } }, 0).statusLine, 'Loading the export script.');
  const importing = viewModel({ job: { id: 'job_i', kind: 'import', phase: 'loading', duplicate: { export_job: 'job_e', source: { email: 'a@example.com', project: { name: 'beethoven' } } } } }, 0);
  assert.equal(importing.statusLine, 'Loading the export and the script.');
  assert.equal(importing.duplicate.line, 'Importing the copy of "beethoven" from a@example.com.');
  assert.equal(importing.duplicate.after.show, false);
});

test('sidepanel: an export whose import could not start shows why and the line to type with Copy, and Import sends the name; no account is chosen', async () => {
  const defaults = { version: 2, readSpacingMs: 0, writeSpacingMs: 500, retryAfterCapMs: 900000, requestTimeoutMs: 120000, notifications: true, logLevel: 'info', logMaxRecords: 2000, logRetentionHours: 72 };
  // greg's stored record: the project offered by its id alone, a name typed
  // for the copy, the export's folder from the bridge.
  const stuck = {
    id: 'job_e', kind: 'export', phase: 'done', chainError: 'the bridge has not heard that the export finished',
    account: { slot: '', email: 'a@example.com', org_uuid: '' },
    export: { name: `This tab's workspace (${CHANNEL})`, kind: 'code', files: 143, path: 'C:\\Users\\greg\\Desktop\\beethoven (2)' },
    duplicate: { project: { id: CHANNEL, name: `This tab's workspace (${CHANNEL})`, kind: 'code' }, destination: { slot: '3', email: 'go@example.com' }, name: 'beethoven' },
  };
  const data = new Map([['cswap.config', JSON.stringify(defaults)], ['cswap.job', JSON.stringify(stuck)]]);
  const { chrome, set, cmds } = makePanelChrome({ data, defaults });
  const { doc, byId } = makePanelDom();
  const copied = [];
  doc.defaultView.navigator = { clipboard: { writeText: async value => { copied.push(value); } } };
  const timers = fakeTimers();
  panelMod.createPanel({ chrome, doc, now: timers.now, schedule: timers.schedule });
  await settle();
  const line = 'cswap project-move import --to 3 --folder="C:\\Users\\greg\\Desktop\\beethoven (2)" --name="beethoven"';
  assert.equal(byId('dup-after').hidden, false);
  assert.equal(byId('dup-after-line').textContent, 'The import could not start: the bridge has not heard that the export finished');
  assert.equal(byId('dup-after-cmd').textContent, line);
  assert.equal(byId('dup-form').hidden, false);
  assert.equal(byId('dup-account'), null, 'no account to choose');
  assert.equal(byId('dup-after-hand').textContent, panelMod.HAND_TEXT);
  assert.equal(byId('btn-dup-import').hidden, false);
  assert.equal(byId('btn-dup-import').disabled, false);
  assert.equal(byId('dup-export'), null, 'nothing to choose: the export is opened in the Open window');
  byId('dup-name').value = 'beethoven';
  byId('btn-dup-import').click();
  await until(() => cmds.some(c => c.name === 'duplicate.import'), 'Import sent');
  assert.deepEqual(cmds.find(c => c.name === 'duplicate.import').args, { name: 'beethoven' });
  byId('btn-dup-copy').click();
  await until(() => copied.length === 1, 'copied');
  assert.equal(copied[0], `${line}\n`);
  assert.equal(byId('btn-dup-copy').textContent, 'Copied');
  await timers.advance(1500);
  assert.equal(byId('btn-dup-copy').textContent, 'Copy this line');
  // A record that names no account (every export since the chooser went):
  // the line leaves the account's number, and the hint says what NUM is.
  set({ 'cswap.job': { ...stuck, duplicate: { ...stuck.duplicate, destination: null } } });
  await settle();
  assert.equal(byId('dup-after-cmd').textContent, 'cswap project-move import --to NUM --folder="C:\\Users\\greg\\Desktop\\beethoven (2)" --name="beethoven"');
  assert.equal(byId('dup-after-hand').textContent, panelMod.HAND_NUM_TEXT);
  assert.equal(byId('btn-dup-import').disabled, false);
  // The export running again: nothing after it yet, no line to type; the
  // form and Import stay in place (the worker answers a press with why).
  set({ 'cswap.job': { ...stuck, phase: 'running', chainError: null } });
  await settle();
  assert.equal(byId('dup-after').hidden, true);
  assert.equal(byId('dup-form').hidden, false);
  assert.equal(byId('btn-dup-import').hidden, false);
  assert.equal(byId('btn-dup-import').disabled, false);
  assert.equal(byId('dup-after-cmd').textContent, '');
});

test('sidepanel: the Import block is the name and Import alone, nothing to choose: a finished export shows its .tar and the line to type, Import sends the name only, nothing is ever listed, and the wait for the Save As window is said', async () => {
  const defaults = { version: 2, readSpacingMs: 0, writeSpacingMs: 500, retryAfterCapMs: 900000, requestTimeoutMs: 120000, notifications: true, logLevel: 'info', logMaxRecords: 2000, logRetentionHours: 72 };
  const made = {
    id: 'job_e', kind: 'export', phase: 'done', chainError: null, account: { slot: '', email: 'a@example.com', org_uuid: '' },
    export: { name: 'beethoven', kind: 'code', files: 143, path: 'C:\\Users\\greg\\Desktop\\beethoven.tar', archive: true },
    duplicate: { project: { id: CHANNEL, name: 'beethoven', kind: 'code' }, destination: null, name: null },
  };
  const data = new Map([['cswap.config', JSON.stringify(defaults)], ['cswap.job', JSON.stringify(made)]]);
  const { chrome, set, cmds } = makePanelChrome({ data, defaults });
  const { doc, byId } = makePanelDom();
  const timers = fakeTimers();
  panelMod.createPanel({ chrome, doc, now: timers.now, schedule: timers.schedule });
  await settle();
  // Nothing to choose from: the export to import is opened in the Open
  // window (greg, 2026-10-07: "dont try and do anything fancy with
  // automatically choosing the project for the user").
  assert.equal(byId('dup-export'), null, 'no list of exports');
  assert.equal(byId('dup-export-field'), null);
  assert.equal(byId('dup-account'), null, 'no account to choose');
  assert.ok(!cmds.some(c => c.name === 'exports.list'), 'nothing is listed');
  assert.equal(byId('dup-after').hidden, false);
  assert.equal(byId('dup-after-line').textContent, `Exported "beethoven" (143 files) to C:\\Users\\greg\\Desktop\\beethoven.tar. ${dupMod.NEXT_STEPS_TEXT}`);
  assert.equal(byId('dup-after-cmd').textContent, 'cswap project-move import --to NUM --folder="C:\\Users\\greg\\Desktop\\beethoven.tar"');
  assert.equal(byId('dup-after-hand').textContent, panelMod.HAND_NUM_TEXT);
  byId('dup-name').value = 'My copy';
  byId('btn-dup-import').click();
  await until(() => cmds.some(c => c.name === 'duplicate.import'), 'Import sent');
  assert.deepEqual(cmds.find(c => c.name === 'duplicate.import').args, { name: 'My copy' });
  // The export waiting in its Save As window: the status line and the
  // Duplicate line say so; the form and the buttons stay as they are.
  set({ 'cswap.job': { ...made, phase: 'placing', chainError: undefined, dialog: { id: 'dlg_000000000001' } } });
  await settle();
  assert.equal(byId('status-line').textContent, 'Waiting for the Save As window.');
  assert.equal(byId('dup-line').textContent, 'Say where the export of "beethoven" goes in the Save As window that opened.');
  assert.equal(byId('dup-after').hidden, true);
  assert.equal(byId('dup-form').hidden, false);
  assert.equal(byId('btn-dup-import').disabled, false);
  assert.equal(byId('btn-duplicate').disabled, false);
  // An import done, then one running: nothing after it and no line to
  // type; the form and Import stay for the next press (the worker answers
  // a press with why).
  set({ 'cswap.job': { id: 'job_i', kind: 'import', phase: 'done', export: { path: 'C:\\x\\exports\\Recipes', name: 'Recipes' }, account: { slot: '', email: 'b@example.com', signed_in: true } } });
  await settle();
  assert.equal(byId('dup-after').hidden, true);
  assert.equal(byId('dup-form').hidden, false);
  assert.equal(byId('dup-after-cmd').textContent, '');
  set({ 'cswap.job': { id: 'job_i', kind: 'import', phase: 'running' } });
  await settle();
  assert.equal(byId('dup-after').hidden, true);
  assert.equal(byId('dup-form').hidden, false);
  assert.equal(byId('btn-dup-import').hidden, false);
  assert.equal(byId('btn-dup-import').disabled, false);
  assert.equal(byId('dup-after-cmd').textContent, '');
  // Nothing ever ran in this browser: a move picked up at any step, the
  // status line says what to press, and Import sends the name.
  set({ 'cswap.job': null });
  await settle();
  assert.match(byId('status-line').textContent, /^Nothing running\. Press Export this project above/);
  assert.equal(byId('dup-after').hidden, true);
  for (const id of ['btn-duplicate', 'btn-signout', 'btn-dup-import']) { assert.equal(byId(id).hidden, false, id); assert.equal(byId(id).disabled, false, id); }
  const sent = cmds.filter(c => c.name === 'duplicate.import').length;
  byId('dup-name').value = '';
  byId('btn-dup-import').click();
  await until(() => cmds.filter(c => c.name === 'duplicate.import').length === sent + 1, 'Import sent');
  assert.deepEqual(cmds.filter(c => c.name === 'duplicate.import').pop().args, { name: '' });
  assert.ok(!cmds.some(c => c.name === 'exports.list'), 'still nothing listed');
});

test('sidepanel: a press the worker refuses shows its reason under the buttons, and the next press clears it', async () => {
  const defaults = { version: 2, readSpacingMs: 0, writeSpacingMs: 500, retryAfterCapMs: 900000, requestTimeoutMs: 120000, notifications: true, logLevel: 'info', logMaxRecords: 2000, logRetentionHours: 72 };
  const data = new Map([['cswap.config', JSON.stringify(defaults)]]);
  const { chrome, held } = makePanelChrome({ data, defaults, hold: ['duplicate.import', 'duplicate.start', 'signout'] });
  const { doc, byId } = makePanelDom();
  const timers = fakeTimers();
  panelMod.createPanel({ chrome, doc, now: timers.now, schedule: timers.schedule });
  await settle();
  byId('btn-dup-import').click();
  await until(() => held.length === 1, 'Import held');
  assert.deepEqual(held[0].m.args, { name: '' });
  held.shift().answer({ ok: false, error: dupMod.NO_DIALOGS_TEXT });
  // Under the buttons, where the eye is after the press; the top line
  // stays for the job's controls.
  await until(() => byId('dup-error').textContent === dupMod.NO_DIALOGS_TEXT, 'the reason shown');
  assert.equal(byId('cmd-error').textContent, '');
  byId('btn-signout').click();
  await until(() => held.length === 1, 'the sign-out held');
  assert.equal(byId('dup-error').textContent, '', 'cleared by the next press');
  held.shift().answer({ ok: false, error: 'A job is running in the tab; wait for it, or press Cancel first.' });
  await until(() => /^A job is running in the tab/.test(byId('dup-error').textContent), 'shown');
  byId('btn-duplicate').click();
  await until(() => held.length === 1, 'the export held');
  held.shift().answer({ ok: true });
  await settle();
  assert.equal(byId('dup-error').textContent, '');
  assert.equal(byId('cmd-error').textContent, '');
});

test('sidepanel: Check now answers under its own button, as a note unless the bridge did not answer, and the Connection line tells idle from failed', async () => {
  const defaults = { version: 2, readSpacingMs: 0, writeSpacingMs: 500, retryAfterCapMs: 900000, requestTimeoutMs: 120000, notifications: true, logLevel: 'info', logMaxRecords: 2000, logRetentionHours: 72 };
  const data = new Map([['cswap.config', JSON.stringify(defaults)]]);
  const { chrome, set, held } = makePanelChrome({ data, defaults, hold: ['job.refresh', 'signout'] });
  const { doc, byId } = makePanelDom();
  const timers = fakeTimers();
  panelMod.createPanel({ chrome, doc, now: timers.now, schedule: timers.schedule });
  await settle();
  assert.equal(byId('bridge-line').textContent, 'Bridge not checked yet: press Check now.');
  byId('btn-refresh').click();
  await until(() => held.length === 1, 'Check now held');
  const reached = 'Reached cswap 0.27.0b1 (from main@91f6435 of https://github.com/OpenSpineConsortium/claude-swap-cloud). Nothing is queued for this browser: open the project on claude.ai and press Export this project, or press Import for an export on disk.';
  held.shift().answer({ ok: true, text: reached });
  await until(() => byId('conn-answer').textContent === reached, 'the answer under Check now');
  assert.equal(byId('conn-answer').className, 'note', 'no failure, so not red');
  assert.equal(byId('cmd-error').textContent, '', 'not at the top of the panel');
  // The worker let the host go once it found nothing: idle, not failed.
  const hello = { cswap: '0.27.0b1', protocol: 1, backup_dir: 'C:\\x', capabilities: ['job', 'dialogs'], source: 'main@91f6435 of https://github.com/OpenSpineConsortium/claude-swap-cloud' };
  set({ 'cswap.bridge': { userScripts: true, connected: false, lastHello: hello, lastError: null, lastErrorCode: null } });
  await settle();
  assert.equal(byId('bridge-line').textContent, 'Bridge reached, idle until the next job (cswap 0.27.0b1, from main@91f6435 of https://github.com/OpenSpineConsortium/claude-swap-cloud)');
  assert.equal(byId('bridge-hint').textContent, '');
  set({ 'cswap.bridge': { userScripts: true, connected: true, lastHello: hello, lastError: null, lastErrorCode: null } });
  await settle();
  assert.equal(byId('bridge-line').textContent, 'Bridge connected (cswap 0.27.0b1, from main@91f6435 of https://github.com/OpenSpineConsortium/claude-swap-cloud)');
  // A try that failed since: not connected, with the hint saying why.
  set({ 'cswap.bridge': { userScripts: true, connected: false, lastHello: hello, lastError: 'The cswap bridge connection was closed.', lastErrorCode: 'disconnected' } });
  await settle();
  assert.equal(byId('bridge-line').textContent, 'Bridge not connected');
  assert.equal(byId('bridge-hint').textContent, 'The cswap bridge connection was closed.');
  byId('btn-refresh').click();
  await until(() => held.length === 1, 'Check now held again');
  assert.equal(byId('conn-answer').textContent, '', 'cleared by the press');
  held.shift().answer({ ok: false, error: 'The bridge did not answer: the cswap bridge is not registered. See Setup below for the line to type.' });
  await until(() => /^The bridge did not answer/.test(byId('conn-answer').textContent), 'the failure under Check now');
  assert.equal(byId('conn-answer').className, 'error');
  // An answer that is no failure under the three buttons is a note too.
  byId('btn-signout').click();
  await until(() => held.length === 1, 'the sign-out held');
  assert.equal(byId('conn-answer').textContent, '', 'every press clears every answer line');
  held.shift().answer({ ok: true, text: 'Signed out; sign in as the other account on the page that opened.' });
  await until(() => /^Signed out/.test(byId('dup-error').textContent), 'shown under the buttons');
  assert.equal(byId('dup-error').className, 'note');
});

test('sidepanel: an import in its own window, from a stored record, shows its lines, the link and the line to type, and is asked about only while it runs, one question at a time', async () => {
  const defaults = { version: 2, readSpacingMs: 0, writeSpacingMs: 500, retryAfterCapMs: 900000, requestTimeoutMs: 120000, notifications: true, logLevel: 'info', logMaxRecords: 2000, logRetentionHours: 72 };
  const command = 'cswap project-move auto --export="C:\\x\\exports\\beethoven" --to 2 --name="beethoven copy"';
  const byHand = 'cswap project-move import --to 2 --folder="C:\\x\\exports\\beethoven" --name="beethoven copy"';
  const running = {
    id: 'job_e', kind: 'export', phase: 'done', chainError: null, importWay: 'driven', account: { email: 'a@example.com' },
    export: { name: 'beethoven', kind: 'code', files: 3, path: 'C:\\x\\exports\\beethoven' },
    duplicate: { project: { id: CHANNEL, name: 'beethoven' }, destination: { slot: '2', email: 'b@example.com' }, name: 'beethoven copy' },
    driven: { running: true, lost: false, pid: 4242, attempt: 1, started_at: '2026-10-06T19:30:00Z', ended_at: '', exit_code: null, url: '', carry_on: '', made: '', message: '', command, log: 'x', tail: ['cswap: importing', 'Signing in...'] },
  };
  const bridge = { connected: true, userScripts: true, lastHello: { cswap: '0.28.0', capabilities: ['job', 'duplicate', 'driven'] } };
  const data = new Map([['cswap.config', JSON.stringify(defaults)], ['cswap.job', JSON.stringify(running)], ['cswap.bridge', JSON.stringify(bridge)]]);
  const { chrome, set, cmds, held } = makePanelChrome({ data, defaults, hold: ['duplicate.driven.refresh'] });
  const { doc, byId } = makePanelDom();
  const copied = [];
  doc.defaultView.navigator = { clipboard: { writeText: async value => { copied.push(value); } } };
  const timers = fakeTimers();
  panelMod.createPanel({ chrome, doc, now: timers.now, schedule: timers.schedule });
  await settle();
  assert.equal(byId('status-line').textContent, 'Exported; importing in its own window.');
  assert.equal(byId('dup-after').hidden, false);
  assert.match(byId('dup-after-line').textContent, /^Importing "beethoven copy" into Account-2 \(b@example\.com\) in its own window \(process 4242\)\./);
  assert.equal(byId('dup-after-tail').hidden, false);
  assert.equal(byId('dup-after-tail').textContent, 'cswap: importing\nSigning in...');
  assert.equal(byId('dup-after-cmd').textContent, byHand);
  assert.equal(byId('btn-dup-import').hidden, false, 'Import stays in place; the worker answers it while this runs');
  assert.equal(byId('dup-form').hidden, false);
  assert.equal(byId('dup-after-link').hidden, true);
  byId('btn-dup-copy').click();
  await until(() => copied.length === 1, 'copied');
  assert.equal(copied[0], `${byHand}\n`);
  // Asked about every DRIVEN_POLL_MS, never twice at once.
  const asked = () => cmds.filter(c => c.name === 'duplicate.driven.refresh').length;
  await timers.advance(1000);
  assert.equal(asked(), 1);
  await timers.advance(dupMod.DRIVEN_POLL_MS * 3);
  assert.equal(asked(), 1, 'the first question is not answered yet');
  held.shift().answer();
  await settle();
  await timers.advance(dupMod.DRIVEN_POLL_MS);
  assert.equal(asked(), 2);
  held.shift().answer();
  // It stopped part-way in a project of its own: the line that carries on
  // in it from the command line (an import in this tab beside it is what
  // the worker refuses, with why).
  set({ 'cswap.job': { ...running, driven: { ...running.driven, running: false, ended_at: '2026-10-06T19:40:00Z', exit_code: 1, carry_on: 'https://claude.ai/code/project/chan_01CARRY', message: 'The import stopped part-way' } } });
  await settle();
  await timers.advance(dupMod.DRIVEN_POLL_MS * 4);
  assert.equal(asked(), 2, 'not asked about once it ended');
  assert.equal(byId('status-line').textContent, 'Exported; the import in its own window stopped.');
  assert.match(byId('dup-after-line').textContent, /^Stopped: The import stopped part-way\. https:\/\/claude\.ai\/code\/project\/chan_01CARRY holds what was added/);
  assert.equal(byId('btn-dup-import').hidden, false);
  assert.equal(byId('dup-form').hidden, false);
  assert.equal(byId('dup-after-cmd').textContent, command);
  // Done: the link, which only ever opens claude.ai.
  set({ 'cswap.job': { ...running, driven: { ...running.driven, running: false, exit_code: 0, url: 'https://claude.ai/code/project/chan_01NEW' } } });
  await settle();
  assert.equal(byId('status-line').textContent, 'Done: the copy is made.');
  assert.equal(byId('dup-after-link').hidden, false);
  assert.equal(byId('dup-after-link').href, 'https://claude.ai/code/project/chan_01NEW');
  assert.equal(byId('btn-dup-import').hidden, false);
  set({ 'cswap.job': { ...running, driven: { ...running.driven, running: false, exit_code: 0, url: 'https://evil.example/x' } } });
  await settle();
  assert.equal(byId('dup-after-link').hidden, true);
  assert.equal(byId('dup-after-link').href, '');
  // Nothing of it for a running export.
  set({ 'cswap.job': { ...running, phase: 'running', driven: null } });
  await settle();
  assert.equal(byId('dup-after').hidden, true);
});

test('sidepanel: beside a copy to carry on in, only the line that carries on in it, with Import in place as ever; an older record with no folder keeps the shorter line', async () => {
  const defaults = { version: 2, readSpacingMs: 0, writeSpacingMs: 500, retryAfterCapMs: 900000, requestTimeoutMs: 120000, notifications: true, logLevel: 'info', logMaxRecords: 2000, logRetentionHours: 72 };
  const carryOn = 'https://claude.ai/code/project/chan_01CARRY';
  const command = `cswap project-move auto --export="C:\\x\\exports\\beethoven" --to 2 --into ${carryOn}`;
  const stopped = {
    id: 'job_e', kind: 'export', phase: 'done', chainError: 'the bridge refused: root-mismatch', account: { email: 'a@example.com' },
    accounts: [{ slot: '2', email: 'b@example.com', label: 'Account-2: b@example.com', usable: true }],
    export: { name: 'beethoven', kind: 'code', files: 3, path: 'C:\\x\\exports\\beethoven' },
    duplicate: { project: { id: CHANNEL, name: 'beethoven' }, destination: { slot: '2', email: 'b@example.com' }, name: null },
    driven: { running: false, lost: false, pid: 4242, attempt: 1, started_at: '', ended_at: 'x', exit_code: 1, url: '', carry_on: carryOn, made: carryOn, message: 'stopped', command, log: 'x', tail: [] },
  };
  const bridge = { connected: false, userScripts: true, lastHello: { cswap: '0.28.0', capabilities: ['job', 'duplicate', 'driven'] } };
  const data = new Map([['cswap.config', JSON.stringify(defaults)], ['cswap.job', JSON.stringify(stopped)], ['cswap.bridge', JSON.stringify(bridge)]]);
  const { chrome, set } = makePanelChrome({ data, defaults });
  const { doc, byId } = makePanelDom();
  const timers = fakeTimers();
  panelMod.createPanel({ chrome, doc, now: timers.now, schedule: timers.schedule });
  await settle();
  assert.equal(byId('dup-after').hidden, false, 'what happened is said');
  assert.match(byId('dup-after-line').textContent, /^Stopped: stopped\. https:\/\/claude\.ai\/code\/project\/chan_01CARRY holds what was added/);
  assert.equal(byId('btn-dup-import').hidden, false, 'Import stays in place; the worker refuses an import in this tab beside the copy, with why');
  assert.equal(byId('dup-form').hidden, false);
  assert.equal(byId('dup-after-cmd').textContent, command);
  for (const id of ['dup-after-hand', 'dup-after-cmd', 'btn-dup-copy']) assert.equal(byId(id).hidden, false, id);
  // An older worker's record with no folder and no run of its own: why the
  // import could not start, and the line to type without the folder.
  set({ 'cswap.job': { ...stopped, driven: null, export: { ...stopped.export, path: '' } } });
  await settle();
  assert.equal(byId('dup-after-line').textContent, 'The import could not start: the bridge refused: root-mismatch');
  assert.equal(byId('btn-dup-import').hidden, false);
  assert.equal(byId('btn-dup-import').disabled, false);
  assert.equal(byId('dup-form').hidden, false);
  for (const id of ['dup-after-hand', 'dup-after-cmd', 'btn-dup-copy']) assert.equal(byId(id).hidden, false, id);
  assert.equal(byId('dup-after-cmd').textContent, 'cswap project-move import --to 2');
});

test('sidepanel: the three buttons, Export this project, Sign out and reload and Import, are always in place and always live, whatever runs', async () => {
  // greg, 2026-10-07: "i dont want any dynamic changes to the button
  // layout, the user should always be able to click export, or import,
  // or logout". The page holds the three in that order, with the Import
  // block (the name) under the other two, and no rule that hides any of
  // them; the worker answers a press at the wrong moment.
  const html = fs.readFileSync(path.join(EXT, 'sidepanel.html'), 'utf8');
  const buttons = [...html.matchAll(/<button id="(btn-duplicate|btn-signout|btn-dup-import)" type="button">([^<]*)<\/button>/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(buttons, [['btn-duplicate', 'Export this project'], ['btn-signout', 'Sign out and reload'], ['btn-dup-import', 'Import']]);
  assert.ok(html.indexOf('id="dup-steps"') < html.indexOf('id="btn-duplicate"'), 'the steps above the buttons');
  assert.ok(html.indexOf('id="btn-signout"') < html.indexOf('id="dup-form"') && html.indexOf('id="dup-form"') < html.indexOf('id="btn-dup-import"'), 'the Import block below Sign out and reload');
  for (const id of ['dup-steps', 'dup-form', 'btn-duplicate', 'btn-signout', 'btn-dup-import']) {
    assert.ok(!new RegExp(`#${id}\\[hidden\\]|#${id}\\[disabled\\]`).test(html), `${id} has no hiding rule`);
    assert.ok(!new RegExp(`id="${id}"[^>]*\\b(hidden|disabled)\\b`).test(html), `${id} starts shown and live`);
  }
  const panelSrc = fs.readFileSync(path.join(EXT, 'src', 'sidepanel.js'), 'utf8');
  assert.ok(!/\$\('(dup-steps|dup-form|btn-duplicate|btn-signout|btn-dup-import)'\)/.test(panelSrc),
    'the panel looks none of them up, so nothing in it can hide or disable them');
  const defaults = { version: 2, readSpacingMs: 0, writeSpacingMs: 500, retryAfterCapMs: 900000, requestTimeoutMs: 120000, notifications: true, logLevel: 'info', logMaxRecords: 2000, logRetentionHours: 72 };
  const done = {
    id: 'job_e', kind: 'export', phase: 'done', chainError: null, account: { slot: '', email: 'a@example.com', org_uuid: '' },
    export: { name: 'beethoven', kind: 'code', files: 3, path: 'C:\\x\\exports\\beethoven' },
    duplicate: { project: { id: CHANNEL, name: 'beethoven', kind: 'code' }, destination: null, name: null },
  };
  const data = new Map([['cswap.config', JSON.stringify(defaults)], ['cswap.job', JSON.stringify(done)]]);
  const { chrome, set, cmds } = makePanelChrome({ data, defaults });
  const { doc, byId } = makePanelDom();
  const timers = fakeTimers();
  panelMod.createPanel({ chrome, doc, now: timers.now, schedule: timers.schedule });
  await settle();
  assert.equal(byId('status-line').textContent, 'Export done. Next: Sign out and reload, then Import.');
  assert.equal(byId('dup-steps').hidden, false);
  assert.equal(byId('btn-duplicate').disabled, false);
  assert.equal(byId('dup-after').hidden, false);
  assert.match(byId('dup-after-line').textContent, /^Exported "beethoven" \(3 files\) to C:\\x\\exports\\beethoven\. Next: press Sign out and reload/);
  assert.equal(byId('dup-form').hidden, false);
  assert.equal(byId('dup-account'), null, 'no account to choose: the copy goes into the account signed in');
  assert.equal(byId('btn-dup-import').disabled, false);
  assert.equal(byId('dup-after-cmd').textContent, 'cswap project-move import --to NUM --folder="C:\\x\\exports\\beethoven"');
  assert.equal(byId('dup-after-hand').textContent, panelMod.HAND_NUM_TEXT);
  // Sign out and reload asks the worker; Import sends the name.
  byId('btn-signout').click();
  await until(() => cmds.some(c => c.name === 'signout'), 'the sign-out sent');
  byId('dup-name').value = 'beethoven copy';
  byId('btn-dup-import').click();
  await until(() => cmds.some(c => c.name === 'duplicate.import'), 'the import sent');
  assert.deepEqual(cmds.find(c => c.name === 'duplicate.import').args, { name: 'beethoven copy' });
  // While a job runs: nothing after it yet, but the steps, the three
  // buttons and the form stay as they were, and every press is sent for
  // the worker to answer.
  set({ 'cswap.job': { ...done, phase: 'running' } });
  await settle();
  assert.equal(byId('dup-steps').hidden, false);
  assert.equal(byId('btn-duplicate').disabled, false);
  assert.equal(byId('dup-form').hidden, false);
  assert.equal(byId('btn-dup-import').disabled, false);
  assert.equal(byId('dup-after').hidden, true);
  assert.equal(byId('status-line').textContent, 'Exporting.');
  const sentSoFar = name => cmds.filter(c => c.name === name).length;
  const before = { start: sentSoFar('duplicate.start'), signout: sentSoFar('signout'), import: sentSoFar('duplicate.import') };
  byId('btn-duplicate').click();
  byId('btn-signout').click();
  byId('btn-dup-import').click();
  await until(() => sentSoFar('duplicate.start') === before.start + 1 && sentSoFar('signout') === before.signout + 1 && sentSoFar('duplicate.import') === before.import + 1, 'every press sent');
  // Nothing running: the same buttons, the same way.
  set({ 'cswap.job': { ...done, phase: 'cancelled' } });
  await settle();
  assert.equal(byId('dup-steps').hidden, false);
  assert.equal(byId('btn-duplicate').disabled, false);
  byId('btn-duplicate').click();
  await until(() => sentSoFar('duplicate.start') === before.start + 2, 'started');
  // An export that ended without its import says so, with why.
  set({ 'cswap.job': { ...done, chainError: 'the bridge is gone' } });
  await settle();
  assert.equal(byId('dup-after-line').textContent, 'The import could not start: the bridge is gone');
  assert.equal(byId('status-line').textContent, 'Exported, but the import could not start.');
  assert.equal(byId('btn-dup-import').hidden, false);
});
