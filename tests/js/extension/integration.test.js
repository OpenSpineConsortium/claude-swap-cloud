// Smoke test of the import side as one piece: the real page helper
// (extension/src/page.js) runs the real, unchanged import script the
// extension carries (extension/src/project-import.js) against the mock claude.ai of
// tests/js/mock_claude_ai.js, with a fake permit grantor standing in for the
// service worker and the real interrupt.js classifying every report.
//
// Three things are checked: every fetch the import makes asked for a permit
// first, a Cloudflare 403 stops the run and leaves an interruption event, and
// pressing Resume lets it finish. The fakes are the ones tests/js/harness.js
// uses, copied here so this file runs alone:
//   node --test tests/js/extension/integration.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const SRC = path.join(ROOT, 'extension', 'src');
const BROWSER = path.join(ROOT, 'src', 'claude_swap', 'browser');
const require = createRequire(import.meta.url);
const { run: runScript } = require('../harness');
const { makeServer, ORG_CHAT, CHANNEL } = require('../mock_claude_ai');
const interrupt = await import(pathToFileURL(path.join(SRC, 'interrupt.js')).href);

const PAGE_SRC = fs.readFileSync(path.join(SRC, 'page.js'), 'utf8').replace(/\r\n/g, '\n');
const IMPORTER_SRC = fs.readFileSync(path.join(SRC, 'project-import.js'), 'utf8').replace(/\r\n/g, '\n');
const EXPORTER = path.join(BROWSER, 'project-export.js');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function settle(rounds = 8) { for (let i = 0; i < rounds; i++) await tick(); }
async function until(fn, what = 'condition', rounds = 400) {
  for (let i = 0; i < rounds; i++) { if (fn()) return; await tick(); }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------- the fakes

// A chrome.runtime.Port pair: JSON round-tripped, delivered on a microtask.
function makePortPair(name = 'cswap-page') {
  const ends = [];
  const make = peer => {
    const end = { name, connected: true, listeners: { message: [], disconnect: [] } };
    end.onMessage = { addListener: fn => end.listeners.message.push(fn), removeListener: () => {} };
    end.onDisconnect = { addListener: fn => end.listeners.disconnect.push(fn), removeListener: () => {} };
    end.postMessage = msg => {
      if (!end.connected) throw new Error('Attempting to use a disconnected port object');
      const copy = JSON.parse(JSON.stringify(msg));
      queueMicrotask(() => { const other = ends[peer]; if (other.connected) for (const fn of [...other.listeners.message]) fn(copy, other); });
    };
    end.disconnect = () => { end.connected = false; ends[peer].connected = false; };
    return end;
  };
  ends.push(make(1), make(0));
  return { client: ends[0], server: ends[1] };
}

// A DOM just big enough for the import script's box and the helper's
// observer: every change of text, disabled, href or style tells the observers.
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
      click() { for (const fn of el.listeners.click || []) fn({ type: 'click', preventDefault() {} }); },
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
    cookie: `theme=dark; lastActiveOrg=${ORG_CHAT}; other=1`, body, title: 'Claude',
    getElementById: id => find(body, id),
    createElement: tag => makeElement(tag),
  };
  return { document, MutationObserver, elements };
}

// The tab: a sandbox like tests/js/harness.js's, with page.js evaluated in
// it. `server` answers the fetches the helper lets through; every one of
// them is written to `sends` with how many permits had been granted by then.
function makeTab({ server, grantor, boot }) {
  const origin = 'https://claude.ai';
  const dom = makeDom();
  const logs = [];
  const sends = [];
  const record = level => (...args) => logs.push({ level, text: args.map(a => (typeof a === 'string' ? a : a && a.message ? `${a.name}: ${a.message}` : JSON.stringify(a))).join(' ') });
  const consoleMock = { log: record('log'), info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug'), table: v => logs.push({ level: 'table', text: JSON.stringify(v) }) };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input), origin);
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = String(v);
    sends.push({ method: (init.method || 'GET').toUpperCase(), path: url.pathname + url.search, headers, grantedBefore: grantor.granted.length });
    if (init.signal && init.signal.aborted) throw new DOMException('aborted', 'AbortError');
    return server(url, headers, init);
  };
  // The script's own pauses are skipped; its long request timers keep their
  // length and are always cleared by it.
  const fastTimeout = (fn, ms = 0, ...args) => setTimeout(fn, ms >= 20000 ? ms : 0, ...args);
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
  const connect = () => {
    const pair = makePortPair();
    grantor.onConnect(pair.server);
    return pair.client;
  };
  vm.createContext(sandbox);
  vm.runInContext(PAGE_SRC, sandbox, { filename: 'page.js' });
  const env = {
    globals: sandbox, win: windowMock, doc: dom.document, boot, connect, now: Date.now,
    fetchImpl, schedule: fastTimeout, unschedule: clearTimeout, MutationObserver: dom.MutationObserver,
  };
  return {
    sandbox, dom, logs, sends,
    create: () => sandbox.createPageHelper(env),
    runImporter: () => vm.runInContext(IMPORTER_SRC, sandbox, { filename: 'project-import.js' }),
    button: () => dom.elements.find(e => e.tagName === 'BUTTON'),
    statusText: () => { const d = dom.elements.filter(e => e.tagName === 'DIV'); return d[1] ? d[1].textContent : ''; },
  };
}

// The fake service worker: a serial permit grantor that grants at once, a
// lazy folder served from `tree`, and the real interrupt.js deciding what
// each report means. An interrupt verdict holds the request (its re-ask stays
// unanswered) and records an interruption event, as the worker would send to
// the host; resume() answers the re-ask. Nothing is ever re-sent by the
// grantor itself.
function makeGrantor({ tree, root, expected }) {
  const g = {
    granted: [], permits: [], reports: [], events: [], scriptEvents: [], fileReads: [],
    inFlight: false, queue: [], held: null, port: null, permitSeq: 0,
    done: null, resolveDone: null,
  };
  g.done = new Promise(resolve => { g.resolveDone = resolve; });
  const grant = (port, msg, attempt) => {
    g.inFlight = true;
    const permit = msg.retryOf || `p${++g.permitSeq}`;
    g.granted.push({ requestId: msg.requestId, permit, attempt });
    port.postMessage({ re: msg.id, ok: true, permit, attempt, seq: g.granted.length, waitedMs: 0 });
  };
  const next = () => {
    if (g.inFlight) return;
    const entry = g.queue.shift();
    if (entry) grant(entry.port, entry.msg, 1);
  };
  g.resume = () => {
    const held = g.held;
    g.held = null;
    if (!held || !held.reask) throw new Error('nothing is held');
    g.events.push({ event: 'resumed', by: 'person' });
    grant(held.port, held.reask, held.attempt + 1);
  };
  g.push = msg => g.port.postMessage(msg);
  g.onConnect = port => {
    g.port = port;
    port.onMessage.addListener(msg => {
      if (msg.type === 'page.attach') { port.postMessage({ re: msg.id, ok: true, phase: 'running', cancelled: false }); return; }
      if (msg.type === 'export.list') { port.postMessage({ re: msg.id, ok: true, root, files: Object.entries(tree).map(([p, b]) => ({ path: p, bytes: b.length })) }); return; }
      if (msg.type === 'file.read') {
        g.fileReads.push(msg.path);
        const bytes = tree[msg.path];
        if (bytes === undefined) { port.postMessage({ re: msg.id, ok: false, reason: 'not-found' }); return; }
        port.postMessage({ re: msg.id, part: 0, last: true, offset: 0, data: Buffer.from(bytes).toString('base64') });
        return;
      }
      if (msg.type === 'gate.permit') {
        g.permits.push(msg);
        if (msg.retryOf) {
          // The re-ask of a held request waits for the person.
          if (!g.held || g.held.permit !== msg.retryOf) { port.postMessage({ re: msg.id, ok: false, reason: 'wrong-phase' }); return; }
          g.held.reask = msg;
          g.held.port = port;
          return;
        }
        g.queue.push({ port, msg });
        next();
        return;
      }
      if (msg.type === 'gate.report') {
        g.reports.push(msg);
        g.inFlight = false;
        const verdict = interrupt.classifyResponse({ ...msg, expected });
        if (verdict.verdict === 'interrupt') {
          const { what, todo } = interrupt.describe(verdict.kind, { expected: expected.email, status: msg.status });
          g.events.push({ event: 'interruption', kind: verdict.kind, what, todo, evidence: verdict.evidence });
          g.held = { permit: msg.permit, attempt: 1, reask: null, port: null };
          port.postMessage({ re: msg.id, ok: true, action: 'hold', reason: 'interrupted', interruption: { kind: verdict.kind, what, todo } });
          return;
        }
        port.postMessage({ re: msg.id, ok: true, action: 'pass', verdict: verdict.verdict });
        next();
        return;
      }
      if (msg.type === 'identity.result') { port.postMessage({ re: msg.id, ok: true }); return; }
      if (msg.type === 'script.event') {
        g.scriptEvents.push(msg);
        port.postMessage({ re: msg.id, ok: true });
        if (msg.kind === 'done' || msg.kind === 'failed') g.resolveDone(msg);
        return;
      }
      port.postMessage({ re: msg.id, ok: false, reason: 'unknown-type' });
    });
  };
  return g;
}

// ---------------------------------------------------------------- the export

// The real export script saves the fixture project once; every import below
// reads that folder through the lazy file reads.
const SIZES = { roots: 12, replies: [2, 3], hiddenReplies: [1], events: [4, 0, 7] };
let exported = null;
async function exportTree() {
  if (!exported) {
    const r = await runScript({ script: EXPORTER, pathname: `/code/project/${CHANNEL}`, server: makeServer({}, SIZES).server });
    if (r.loadError) throw r.loadError;
    assert.match(r.statusText, /^Done/);
    const tree = {};
    for (const [p, bytes] of Object.entries(r.bytes)) if (p.startsWith('beethoven/')) tree[p.slice('beethoven/'.length)] = bytes;
    exported = tree;
  }
  return exported;
}

const EXPECTED = { email: 'b@example.com', orgUuid: ORG_CHAT };
const BOOT = { jobId: 'job_20261005T141503_a1b2c3', nonce: 'n-1', name: '', expected: EXPECTED,
  bodyMarkers: [...interrupt.BODY_MARKERS], accountEndpoints: [...interrupt.ACCOUNT_ENDPOINTS], requestTimeoutMs: 120000 };

async function importThrough({ mock, act }) {
  const tree = await exportTree();
  const grantor = makeGrantor({ tree, root: 'beethoven', expected: EXPECTED });
  const tab = makeTab({ server: mock.server, grantor, boot: { ...BOOT } });
  tab.create();
  await settle();
  grantor.push({ type: 'export.set', root: 'beethoven', files: Object.entries(tree).map(([p, b]) => ({ path: p, bytes: b.length })) });
  await tab.runImporter();
  await until(() => grantor.scriptEvents.some(e => e.kind === 'ready'), 'the script\'s button');
  grantor.push({ type: 'press' });
  if (act) await act(grantor, tab);
  const end = await Promise.race([grantor.done, new Promise((_, reject) => setTimeout(() => reject(new Error('the import did not end')), 60000).unref())]);
  return { grantor, tab, end };
}

// ---------------------------------------------------------------- the checks

test('every fetch the import makes asked for a permit first, and the import completes', async () => {
  const mock = makeServer({}, SIZES);
  const { grantor, tab, end } = await importThrough({ mock });
  assert.equal(end.kind, 'done');
  assert.match(end.result.status, /^Done/);
  assert.equal(tab.button().textContent, 'Import complete');

  assert.ok(tab.sends.length > 10, 'the import made its requests');
  // Serial and permitted: when the k-th request went out, exactly k permits
  // had been granted, and every permit was reported on.
  tab.sends.forEach((send, i) => assert.equal(send.grantedBefore, i + 1, `request ${i + 1} ${send.method} ${send.path}`));
  assert.equal(grantor.granted.length, tab.sends.length);
  assert.equal(grantor.reports.length, tab.sends.length);
  assert.ok(grantor.reports.every(r => grantor.granted.some(p => p.requestId === r.requestId && p.permit === r.permit)));
  // Only claude.ai's own API paths were gated, and the headers reached the site untouched.
  assert.ok(tab.sends.every(s => s.path.startsWith('/api/') || s.path.startsWith('/v1/')));
  assert.ok(tab.sends.every(s => s.headers.accept === 'application/json'));
  const totalHits = [...mock.hits.byPath.values()].reduce((a, b) => a + b, 0);
  assert.equal(totalHits, tab.sends.length);
  // The project exists once, and no interruption was recorded.
  assert.equal([...mock.state.channels.values()].filter(c => c.created).length, 1);
  assert.deepEqual(grantor.events, []);
  assert.equal(end.result.counts.notAdded, 0);
  assert.equal(tab.logs.filter(l => l.level === 'error').length, 0);
});

test('a Cloudflare 403 stops the run with an interruption event; Resume lets it finish', async () => {
  let challenged = 0;
  const mock = makeServer({
    faultEverywhere: true,
    fault: (url, headers, nth, init) =>
      url.pathname.endsWith('/upload') && init.body.get('file').name === 'notes.md' && challenged++ < 1
        ? new Response('<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>cf_chl_opt</body></html>',
          { status: 403, headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge', 'cf-ray': '8f1-FRA' } })
        : null,
  }, SIZES);
  let stopped = null;
  const { grantor, tab, end } = await importThrough({
    mock,
    act: async (g, t) => {
      await until(() => g.held && g.held.reask, 'the hold');
      stopped = { sends: t.sends.length, status: t.statusText(), events: g.events.length };
      // Nothing moves while the person has not acted: no request, no progress.
      await settle(30);
      assert.equal(t.sends.length, stopped.sends, 'nothing was sent while held');
      assert.equal(t.statusText(), stopped.status, 'the script is waiting on its upload');
      assert.notEqual(t.button().textContent, 'Import complete');
      g.resume();
    },
  });

  // The stop was recorded as an interruption the host and the panel would show.
  const interruption = grantor.events.find(e => e.event === 'interruption');
  assert.ok(interruption, 'an interruption event');
  assert.equal(interruption.kind, 'challenge');
  assert.match(interruption.what, /Cloudflare check/);
  assert.match(interruption.todo, /NEW tab/);
  assert.match(interruption.todo, /press Resume/);
  assert.equal(interruption.evidence.status, 403);
  assert.equal(interruption.evidence.headers['cf-mitigated'], 'challenge');
  assert.ok(interruption.evidence.markers.includes('cf_chl_opt'));
  assert.equal(stopped.events, 1);
  assert.deepEqual(grantor.events.map(e => e.event), ['interruption', 'resumed']);

  // After Resume the held request went out once more, and the import finished.
  assert.equal(end.kind, 'done');
  assert.match(end.result.status, /^Done/);
  const challenge = grantor.reports.find(r => r.status === 403);
  assert.ok(challenge, 'the 403 was reported');
  assert.equal(grantor.reports.filter(r => r.status === 403).length, 1);
  const reask = grantor.permits.find(p => p.retryOf);
  assert.equal(reask.retryOf, challenge.permit);
  assert.equal(reask.stepKey, grantor.permits.find(p => p.requestId === challenge.requestId).stepKey);
  assert.ok(end.result.rows.some(r => r.item === 'state/notes.md' && r.result === 'added'));
  assert.ok(!tab.logs.some(l => /403/.test(l.text)), 'the script never saw the 403');
  assert.equal([...mock.state.channels.values()].filter(c => c.created).length, 1);
  // The permit rule held across the stop as well.
  tab.sends.forEach((send, i) => assert.equal(send.grantedBefore, i + 1));
});
