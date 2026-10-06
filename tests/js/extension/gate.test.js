// Tests of the request gate, extension/src/gate.js, run alone with
//   node --test tests/js/extension/gate.test.js
// Everything the gate needs is injected: a clock the test moves, a wake
// scheduler the test fires, a store that records every write, a scripted
// classifier, a config the test changes and spies on onChange and the log.
// No timer runs and nothing touches the network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GATE_VERSION,
  READ_SPACING_DEFAULT_MS,
  WRITE_SPACING_DEFAULT_MS,
  HOLD_AFTER_SLOW_DOWNS,
  HOLD_AFTER_FAILURES,
  RETRY_STATUSES,
  CREATE_PATHS,
  UNREPEATABLE_PATHS,
  RECENT_MAX,
  STEPS_MAX,
  ANSWERS_MAX,
  classifyRequest,
  isRead,
  createMayHaveActed,
  parseRetryAfter,
  stepKeyOf,
  pathOnly,
  scrubText,
  freshState,
  sanitizeState,
  fallbackClassify,
  createGate,
} from '../../../extension/src/gate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const GATE_SRC = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'gate.js'), 'utf8');
const IMPORTER_SRC = fs.readFileSync(path.join(ROOT, 'src', 'claude_swap', 'browser', 'project-import.js'), 'utf8');

// ------------------------------------------------------------------
// The harness
// ------------------------------------------------------------------

const flush = () => new Promise(resolve => setImmediate(resolve));

// { value } or { error } when the promise has settled after the microtasks
// and one macrotask ran; null while it is still pending.
async function settled(promise) {
  let result = null;
  promise.then(value => { result = { value }; }, error => { result = { error }; });
  await flush();
  await flush();
  return result;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// A stand-in for interrupt.classifyResponse with the rows the gate tests
// care about: a Cloudflare challenge header, a 401 on the API, a 429 and a
// lost reply. The real module is tested on its own.
function defaultClassify(rep) {
  const headers = rep.headers || {};
  if (String(headers['cf-mitigated'] || '').toLowerCase() === 'challenge') {
    return {
      verdict: 'interrupt',
      kind: 'challenge',
      interruption: { kind: 'challenge', what: 'Cloudflare check', todo: 'Solve it in a new tab, then Resume', evidence: { status: rep.status, headers, markers: rep.markers } },
      evidence: {},
    };
  }
  if (rep.status === 401 && /^\/(api|v1)\//.test(rep.path)) {
    return { verdict: 'interrupt', kind: 'signed-out', interruption: { kind: 'signed-out', what: 'signed out', todo: 'sign in', evidence: {} }, evidence: {} };
  }
  if (rep.status === 429) return { verdict: 'slow-down', evidence: {} };
  if (rep.status === 0 && rep.error) return { verdict: 'network', evidence: {} };
  return { verdict: 'pass', evidence: {} };
}

function harness(opts = {}) {
  const h = {
    t: 1_000_000_000,
    wakes: [],
    data: undefined,
    writes: [],
    changes: [],
    logs: [],
    // `spacing` sets both; `readSpacing` and `writeSpacing` set one each.
    cfg: {
      readSpacingMs: opts.readSpacing ?? opts.spacing ?? 0,
      writeSpacingMs: opts.writeSpacing ?? opts.spacing ?? 0,
      retryAfterCapMs: 900000,
    },
    classifyNext: [],
    classifyCalls: [],
    failSet: false,
    throwOnChange: false,
  };
  h.now = () => h.t;
  h.wake = (at, fn) => {
    const w = { at, fn, cancelled: false };
    h.wakes.push(w);
    return () => { w.cancelled = true; };
  };
  h.live = () => h.wakes.filter(w => !w.cancelled);
  // Fires every live wake whose time has come, in order, including wakes
  // scheduled while firing.
  h.fire = async () => {
    let fired = 0;
    for (;;) {
      const due = h.wakes.find(w => !w.cancelled && w.at <= h.t);
      if (!due) break;
      h.wakes.splice(h.wakes.indexOf(due), 1);
      await due.fn();
      fired += 1;
    }
    h.wakes = h.wakes.filter(w => !w.cancelled);
    await flush();
    return fired;
  };
  h.advance = async ms => {
    h.t += ms;
    return h.fire();
  };
  h.store = {
    get: async () => clone(h.data),
    set: async state => {
      if (h.failSet) throw new Error('quota exceeded');
      h.writes.push(clone(state));
      h.data = clone(state);
    },
  };
  h.classify = rep => {
    h.classifyCalls.push(rep);
    if (h.classifyNext.length) {
      const next = h.classifyNext.shift();
      return typeof next === 'function' ? next(rep) : next;
    }
    return defaultClassify(rep);
  };
  const logAt = level => (event, msg, data, job) => h.logs.push({ level, event, msg, data: clone(data), job });
  h.log = { debug: logAt('debug'), info: logAt('info'), warn: logAt('warn'), error: logAt('error') };
  h.onChange = (snap, change) => {
    if (h.throwOnChange) throw new Error('onChange boom');
    h.changes.push({ ...change, snapPhase: snap.phase });
  };
  h.gate = () => createGate({ now: h.now, wake: h.wake, store: h.store, config: () => h.cfg, classify: h.classify, log: h.log, onChange: h.onChange });
  h.waits = () => h.changes.filter(c => c.type === 'wait').map(c => `${c.state}:${c.reason}`);
  h.logged = level => h.logs.filter(l => l.level === level);
  return h;
}

async function started(opts = {}) {
  const h = harness(opts);
  const g = h.gate();
  await g.start(opts.jobId || 'job_1');
  return { h, g };
}

let ids = 0;
const rid = () => `r${++ids}`;

function reqOf(o = {}) {
  const method = o.method || 'GET';
  const path = o.path || '/api/organizations';
  const req = {
    requestId: o.requestId || rid(),
    stepKey: o.stepKey || stepKeyOf({ method, path, bodySig: o.bodySig || '' }),
    method,
    path,
    kind: o.kind || 'script',
    bodyBytes: o.bodyBytes || 0,
  };
  if (o.retryOf) req.retryOf = o.retryOf;
  return req;
}

async function granted(g, o = {}) {
  const req = reqOf(o);
  const res = await g.permit(req);
  assert.equal(res.ok, true, `expected a grant, got ${JSON.stringify(res)}; gate ${JSON.stringify(g.snapshot().wait)}`);
  return { req, res };
}

function repOf(grant, o = {}) {
  const status = o.status === undefined ? 200 : o.status;
  return {
    requestId: grant.req.requestId,
    permit: grant.res.permit,
    status,
    ok: o.ok === undefined ? status >= 200 && status < 300 : o.ok,
    redirected: Boolean(o.redirected),
    finalPath: o.finalPath || grant.req.path,
    headers: o.headers || {},
    elapsedMs: o.elapsedMs === undefined ? 10 : o.elapsedMs,
    markers: o.markers || [],
    ...(o.error ? { error: o.error } : {}),
    ...(o.created ? { created: o.created } : {}),
    ...(o.bodyExcerpt ? { bodyExcerpt: o.bodyExcerpt } : {}),
    ...(o.bodyJson ? { bodyJson: o.bodyJson } : {}),
  };
}

// Asks, waits out whatever the gate says to wait (moving the clock and
// firing the wake), reports, and returns what happened.
async function roundTrip(g, h, o = {}) {
  const req = reqOf(o);
  const promise = g.permit(req);
  let s = await settled(promise);
  if (!s) {
    const snap = g.snapshot();
    if (snap.wait && snap.wait.until != null) {
      h.t = Math.max(h.t, snap.wait.until);
      await h.fire();
      s = await settled(promise);
    }
  }
  assert.ok(s && s.value && s.value.ok, `expected a grant: ${JSON.stringify(s)}; wait ${JSON.stringify(g.snapshot().wait)}`);
  const grant = { req, res: s.value };
  const answer = await g.report(repOf(grant, o));
  return { req, res: s.value, answer };
}

const CHALLENGE = { 'cf-mitigated': 'challenge', 'content-type': 'text/html', 'cf-ray': '8abc-IAD' };

// ------------------------------------------------------------------
// The module itself
// ------------------------------------------------------------------

describe('the module', () => {
  test('is plain ASCII with LF endings and uses no timer, no randomness, no browser API', () => {
    assert.ok(!/[^\x00-\x7f]/.test(GATE_SRC), 'non-ASCII in gate.js');
    assert.ok(!GATE_SRC.includes('\r'), 'CR in gate.js');
    for (const banned of ['Math.random', 'setTimeout', 'setInterval', 'chrome.', 'document.cookie', 'fetch(']) {
      assert.ok(!GATE_SRC.includes(banned), `gate.js contains ${banned}`);
    }
  });

  test('its hold thresholds mirror the script\'s own retry tables', () => {
    const list = name => {
      const m = new RegExp(`const ${name} = \\[([^\\]]*)\\];`).exec(IMPORTER_SRC);
      assert.ok(m, `${name} not found in project-import.js`);
      return m[1].split(',').map(s => Number(s.trim()));
    };
    assert.equal(HOLD_AFTER_FAILURES, list('RETRY_WAITS').length + 1);
    assert.equal(HOLD_AFTER_SLOW_DOWNS, list('SLOW_DOWN_WAITS').length + 1);
    const statuses = /const RETRY_STATUS = new Set\(\[([^\]]*)\]\)/.exec(IMPORTER_SRC);
    assert.ok(statuses, 'RETRY_STATUS not found in project-import.js');
    assert.deepEqual([...RETRY_STATUSES].sort(), statuses[1].split(',').map(s => Number(s.trim())).sort());
    assert.equal(READ_SPACING_DEFAULT_MS, 0);
    assert.equal(WRITE_SPACING_DEFAULT_MS, 500);
    assert.equal(GATE_VERSION, 1);
  });

  test('the requests the script sends only once (repeatable: false) are exactly the ones the gate holds on their first failure', () => {
    // ENDPOINTS.standard and ENDPOINTS.code out of the script, name -> template.
    const block = kind => {
      const m = new RegExp(`\\n    ${kind}: \\{([\\s\\S]*?)\\n    \\},`).exec(IMPORTER_SRC);
      assert.ok(m, `ENDPOINTS.${kind} not found in project-import.js`);
      const out = {};
      for (const [, name, template] of m[1].matchAll(/^\s*(\w+): '([^']+)',$/gm)) out[name] = template;
      assert.ok(Object.keys(out).length >= 4, `ENDPOINTS.${kind} read wrongly: ${JSON.stringify(out)}`);
      return out;
    };
    const endpoints = { standard: block('standard'), code: block('code') };
    const standardAt = IMPORTER_SRC.indexOf('async function importStandardProject(');
    const codeAt = IMPORTER_SRC.indexOf('async function importCodeProject(');
    assert.ok(standardAt > 0 && codeAt > standardAt, 'the two import functions were not found in order');
    // Every `repeatable: false` is sent to the endpoint named just above it,
    // under whichever ENDPOINTS block is bound to E in that function: the
    // nearest `const E = ENDPOINTS.<kind>;` before it. Bucketing by position
    // relative to importCodeProject would misfile a code-side call that lives
    // in a helper defined above it, as takeProject's create does.
    const bindings = [...IMPORTER_SRC.matchAll(/const E = ENDPOINTS\.(standard|code);/g)]
      .map(b => ({ at: b.index, kind: b[1] }));
    assert.ok(bindings.length >= 2, 'the E = ENDPOINTS bindings were not found in project-import.js');
    const once = new Set();
    for (const m of IMPORTER_SRC.matchAll(/repeatable: false/g)) {
      assert.ok(m.index > standardAt, `repeatable: false outside the import functions at ${m.index}`);
      const binding = bindings.filter(b => b.at < m.index).at(-1);
      assert.ok(binding, `no E = ENDPOINTS binding before the repeatable: false at ${m.index}`);
      const before = IMPORTER_SRC.slice(Math.max(0, m.index - 400), m.index);
      const refs = [...before.matchAll(/\bE\.(\w+)\b/g)];
      assert.ok(refs.length, `no endpoint named near the repeatable: false at ${m.index}`);
      once.add(`${binding.kind}.${refs.at(-1)[1]}`);
    }
    assert.deepEqual([...once].sort(), ['code.create', 'standard.create', 'standard.docs', 'standard.upload']);
    const fill = template => pathOnly(template.replace(/\{\w+\}/g, 'x'));
    const oncePaths = new Set([...once].map(key => {
      const [kind, name] = key.split('.');
      return fill(endpoints[kind][name]);
    }));
    for (const kind of ['standard', 'code']) {
      for (const [name, template] of Object.entries(endpoints[kind])) {
        const p = fill(template);
        const verdict = classifyRequest('POST', p);
        if (oncePaths.has(p)) assert.notEqual(verdict, 'other', `${kind}.${name} (${p}) goes out once, so its first failure must be held`);
        else assert.equal(verdict, 'other', `${kind}.${name} (${p}) is retried by the script, so the gate must not hold its first failure`);
      }
    }
    assert.equal(classifyRequest('POST', fill(endpoints.standard.create)), 'create');
    assert.equal(classifyRequest('POST', fill(endpoints.code.create)), 'create');
    assert.equal(classifyRequest('POST', fill(endpoints.standard.docs)), 'unrepeatable');
    assert.equal(classifyRequest('POST', fill(endpoints.standard.upload)), 'unrepeatable');
  });

  test('parseRetryAfter reads seconds and HTTP-dates, never caps, and rejects the rest', () => {
    const now = Date.UTC(2026, 9, 5, 12, 0, 0);
    assert.equal(parseRetryAfter('120', now), 120000);
    assert.equal(parseRetryAfter(' 30 ', now), 30000);
    assert.equal(parseRetryAfter(30, now), 30000);
    assert.equal(parseRetryAfter('0', now), 0);
    assert.equal(parseRetryAfter('1.5', now), 1500);
    assert.equal(parseRetryAfter('100000', now), 100000000);
    assert.equal(parseRetryAfter(new Date(now + 90000).toUTCString(), now), 90000);
    assert.equal(parseRetryAfter(new Date(now - 90000).toUTCString(), now), 0);
    assert.equal(parseRetryAfter('2026-10-05T12:01:00Z', now), 60000);
    for (const bad of [null, undefined, '', '   ', 'soon', '-5', '1e3', 'NaN', '12abc', {}, []]) {
      assert.equal(parseRetryAfter(bad, now), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });

  test('classifyRequest knows the two create endpoints, the two POSTs the script sends once, and nothing else', () => {
    assert.equal(classifyRequest('POST', '/api/organizations/org-1/projects'), 'create');
    assert.equal(classifyRequest('post', '/v1/code/channels'), 'create');
    assert.equal(classifyRequest('POST', '/v1/code/channels?x=1'), 'create');
    assert.equal(classifyRequest('POST', 'https://claude.ai/v1/code/channels'), 'create');
    assert.equal(classifyRequest('GET', '/v1/code/channels'), 'other');
    assert.equal(classifyRequest('POST', '/v1/code/channels/chan_1'), 'other');
    assert.equal(classifyRequest('POST', '/api/organizations/org-1/projects/p/docs'), 'unrepeatable');
    assert.equal(classifyRequest('POST', '/api/organizations/org-1/projects/p/upload'), 'unrepeatable');
    assert.equal(classifyRequest('POST', 'https://claude.ai/api/organizations/org-1/projects/p/upload?x=1'), 'unrepeatable');
    assert.equal(classifyRequest('GET', '/api/organizations/org-1/projects/p/docs'), 'other');
    assert.equal(classifyRequest('POST', '/api/org-1/upload'), 'other', 'the code project\'s upload is repeatable');
    assert.equal(classifyRequest('POST', '/v1/code/channels/chan_1/files:write'), 'other');
    assert.equal(classifyRequest('PUT', '/api/organizations/org-1/projects/p'), 'other');
    assert.equal(classifyRequest('PATCH', '/v1/code/channels'), 'other');
    assert.equal(classifyRequest(undefined, undefined), 'other');
    assert.equal(classifyRequest('POST', 42), 'other');
    assert.equal(CREATE_PATHS.length, 2);
    assert.equal(UNREPEATABLE_PATHS.length, 1);
  });

  test('isRead: GET, HEAD and an empty method read; POST, PUT, PATCH and DELETE write', () => {
    for (const m of ['GET', 'get', 'HEAD', 'head', '', undefined, null]) assert.equal(isRead(m), true, String(m));
    for (const m of ['POST', 'post', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal(isRead(m), false, m);
  });

  test('createMayHaveActed: only a 4xx answer means the site turned the create away', () => {
    assert.equal(createMayHaveActed(null), false);
    assert.equal(createMayHaveActed({ permit: 'p1', pending: true, status: null }), true);
    assert.equal(createMayHaveActed({ permit: 'p1', pending: false, status: null }), true, 'no reply ever came back');
    assert.equal(createMayHaveActed({ permit: 'p1', pending: false, status: 200, id: null }), true, 'a 2xx without an id still made one');
    assert.equal(createMayHaveActed({ permit: 'p1', pending: false, status: 0 }), true);
    assert.equal(createMayHaveActed({ permit: 'p1', pending: false, status: 503 }), true);
    assert.equal(createMayHaveActed({ permit: 'p1', pending: false, status: 429 }), false);
    assert.equal(createMayHaveActed({ permit: 'p1', pending: false, status: 403 }), false);
  });

  test('stepKeyOf and pathOnly', () => {
    assert.equal(stepKeyOf({ method: 'post', path: '/api/x?y=1', bodySig: 'json:abcd' }), 'POST /api/x?y=1 json:abcd');
    assert.equal(stepKeyOf({ method: 'GET', path: '/api/x' }), 'GET /api/x ');
    assert.equal(stepKeyOf({}), 'GET  ');
    assert.equal(pathOnly('/api/x?token=1#f'), '/api/x');
    assert.equal(pathOnly('https://claude.ai/v1/code/channels?scope=joined'), '/v1/code/channels');
    assert.equal(pathOnly('https://claude.ai'), '/');
    assert.equal(pathOnly(null), '');
    assert.equal(pathOnly(12), '');
  });

  test('scrubText removes what must never be kept', () => {
    assert.equal(scrubText('key sk-ant-api03-abcdefghijkl end'), 'key [redacted] end');
    assert.equal(scrubText('Bearer abcdefghijklmnopqrstuvwxyz'), 'Bearer [redacted]');
    assert.equal(scrubText('sessionKey=sk-ant-sid01-xyz; other=1'), 'sessionKey=[redacted]; other=1');
    assert.equal(scrubText('ANTHROPIC_API_KEY=abcdefgh'), 'ANTHROPIC_API_KEY=[redacted]');
    assert.equal(scrubText('cf-ray 8abc status 429 /api/organizations'), 'cf-ray 8abc status 429 /api/organizations');
  });

  test('fallbackClassify covers the two signals the gate must not miss on its own', () => {
    assert.equal(fallbackClassify({ status: 200, headers: { 'cf-mitigated': 'Challenge' } }).verdict, 'interrupt');
    assert.equal(fallbackClassify({ status: 429, headers: {} }).verdict, 'slow-down');
    assert.equal(fallbackClassify({ status: 0, headers: {}, error: { name: 'TypeError', message: 'failed' } }).verdict, 'network');
    assert.equal(fallbackClassify({ status: 503, headers: {} }).verdict, 'pass');
    assert.equal(fallbackClassify(null).verdict, 'pass');
  });

  test('createGate checks its arguments', () => {
    assert.throws(() => createGate({}), /now must be a function/);
    assert.throws(() => createGate({ now: () => 0 }), /wake must be a function/);
    assert.throws(() => createGate({ now: () => 0, wake: () => {} }), /store must have/);
    const h = harness();
    assert.ok(createGate({ now: h.now, wake: h.wake, store: h.store }));
  });
});

// ------------------------------------------------------------------
// Starting, idle, input validation
// ------------------------------------------------------------------

describe('start and input', () => {
  test('a permit before any job is refused with no-job and nothing is stored', async () => {
    const h = harness();
    const g = h.gate();
    assert.deepEqual(await g.permit(reqOf()), { ok: false, reason: 'no-job' });
    assert.equal(g.snapshot().phase, 'idle');
  });

  test('start gives a fresh ready state and persists it', async () => {
    const { h, g } = await started();
    const s = g.snapshot();
    assert.equal(s.phase, 'ready');
    assert.equal(s.jobId, 'job_1');
    assert.deepEqual(s.pending, []);
    assert.equal(h.data.jobId, 'job_1');
    assert.deepEqual(h.changes.map(c => c.type), ['phase']);
  });

  test('start refuses another job while one is active, and the same job after a create', async () => {
    const { h, g } = await started();
    await granted(g, {});
    await assert.rejects(g.start('job_2'), /job job_1 is still active/);
    assert.equal(g.snapshot().jobId, 'job_1');
    await g.finish('done');
    await g.start('job_2');
    assert.equal(g.snapshot().jobId, 'job_2');
    assert.equal(g.snapshot().counters.requests, 0);
    const create = await granted(g, { method: 'POST', path: '/v1/code/channels', bodySig: 'json:1' });
    await g.report(repOf(create, { status: 200, created: { id: 'chan_1', url: '/code/project/chan_1', name: 'P' } }));
    await assert.rejects(g.start('job_2'), /already permitted a create/);
    assert.ok(h.logged('error').every(l => /cannot be started again/.test(l.msg)), 'the refusal is the only error logged');
  });

  test('starting the same job again while active refuses its pending permits and starts fresh', async () => {
    const { h, g } = await started();
    await granted(g, {});
    const pending = g.permit(reqOf({ path: '/api/b' }));
    assert.equal(await settled(pending), null);
    await g.start('job_1');
    assert.deepEqual(await pending, { ok: false, reason: 'cancelled' });
    assert.equal(g.snapshot().inFlight, null);
    assert.ok(h.logged('warn').some(l => /started again/.test(l.msg)));
  });

  test('malformed permits and reports throw a plain TypeError', async () => {
    const { g } = await started();
    await assert.rejects(g.permit(null), /expected an object/);
    await assert.rejects(g.permit({ stepKey: 'k', path: '/api/x' }), /requestId must be a non-empty string/);
    await assert.rejects(g.permit({ requestId: 'r', path: '/api/x' }), /stepKey must be/);
    await assert.rejects(g.permit({ requestId: 'r', stepKey: 'k', path: '' }), /path must be/);
    await assert.rejects(g.permit({ requestId: 'r', stepKey: 'k', path: '/api/x', kind: 'other' }), /kind must be/);
    await assert.rejects(g.report({ requestId: 'r' }), /permit must be/);
    await assert.rejects(g.start(''), /jobId must be/);
    await assert.rejects(g.finish('later'), /outcome must be/);
    assert.equal(g.snapshot().pending.length, 0);
  });
});

// ------------------------------------------------------------------
// Serial, spacing
// ------------------------------------------------------------------

describe('serial and spacing', () => {
  test('one request at a time: the second permit waits for the first report', async () => {
    const { h, g } = await started();
    const a = await granted(g, { path: '/api/a' });
    const pb = g.permit(reqOf({ path: '/api/b' }));
    assert.equal(await settled(pb), null);
    assert.equal(g.snapshot().phase, 'in-flight');
    assert.deepEqual(await g.report(repOf(a)), { action: 'pass', verdict: 'pass' });
    const b = await pb;
    assert.equal(b.ok, true);
    assert.equal(b.seq, 2);
    assert.notEqual(b.permit, a.res.permit);
    assert.equal(g.snapshot().inFlight.permit, b.permit);
    assert.equal(h.data.inFlight.permit, b.permit);
  });

  test('zero spacing grants the next permit at once', async () => {
    const { h, g } = await started({ spacing: 0 });
    const a = await granted(g);
    await g.report(repOf(a));
    const b = await granted(g);
    assert.equal(b.res.waitedMs, 0);
    assert.equal(h.live().length, 0);
  });

  test('the wait is exactly end + the spacing, measured from the report, and waits are timestamps', async () => {
    const { h, g } = await started({ spacing: 500 });
    const a = await granted(g);
    h.t += 100;
    await g.report(repOf(a));
    const ended = h.t;
    const pb = g.permit(reqOf({ path: '/api/b' }));
    assert.equal(await settled(pb), null);
    let s = g.snapshot();
    assert.equal(s.phase, 'waiting');
    assert.deepEqual(s.wait, { reason: 'spacing', since: ended, until: ended + 500 });
    assert.equal(s.steps[stepKeyOf({ method: 'GET', path: '/api/b' })].state, 'waiting');
    assert.deepEqual(h.live().map(w => w.at), [ended + 500]);
    // Early re-evaluation (a wake that fired early) changes nothing.
    h.t = ended + 499;
    await g.reevaluate();
    assert.equal(await settled(pb), null);
    h.t = ended + 500;
    await h.fire();
    const b = await pb;
    assert.equal(b.ok, true);
    assert.equal(b.waitedMs, 500);
    s = g.snapshot();
    assert.equal(s.phase, 'in-flight');
    assert.equal(s.wait, null);
    assert.equal(s.counters.waitedMs, 500);
    assert.deepEqual(h.waits(), ['start:spacing', 'end:spacing']);
  });

  test('a changed spacing applies to the very next grant', async () => {
    const { h, g } = await started({ spacing: 500 });
    const a = await granted(g);
    await g.report(repOf(a));
    h.cfg = { ...h.cfg, readSpacingMs: 0 };
    const b = await granted(g);
    assert.equal(b.res.waitedMs, 0);
    await g.report(repOf(b));
    h.cfg = { ...h.cfg, readSpacingMs: 2000 };
    const pc = g.permit(reqOf());
    assert.equal(await settled(pc), null);
    assert.equal(g.snapshot().wait.until, h.t + 2000);
    // Lowering it while a permit waits is picked up by the next re-evaluation.
    h.cfg = { ...h.cfg, readSpacingMs: 100 };
    h.t += 100;
    await g.reevaluate();
    assert.equal((await pc).ok, true);
  });

  test('a lost wake is harmless: time passes, the next re-evaluation grants', async () => {
    const { h, g } = await started({ spacing: 500 });
    const a = await granted(g);
    await g.report(repOf(a));
    const pb = g.permit(reqOf({ path: '/api/b' }));
    assert.equal(await settled(pb), null);
    h.wakes = []; // the alarm never came
    h.t += 5000;
    assert.equal(await settled(pb), null);
    await g.reevaluate();
    assert.equal((await pb).ok, true);
  });

  test('a lost wake is also covered by the next permit', async () => {
    const { h, g } = await started({ spacing: 500 });
    const a = await granted(g);
    await g.report(repOf(a));
    const pb = g.permit(reqOf({ path: '/api/b' }));
    h.wakes = [];
    h.t += 5000;
    const pc = g.permit(reqOf({ path: '/api/c' }));
    assert.equal((await pb).ok, true);
    assert.equal(await settled(pc), null, 'c waits for b, serially');
  });

  test('a clock that went backwards waits at most one spacing from now', async () => {
    const { h, g } = await started({ spacing: 500 });
    const a = await granted(g);
    await g.report(repOf(a));
    h.t -= 60000;
    const pb = g.permit(reqOf({ path: '/api/b' }));
    assert.equal(await settled(pb), null);
    assert.equal(g.snapshot().wait.until, h.t + 500);
    await h.advance(500);
    assert.equal((await pb).ok, true);
    assert.equal(h.logged('warn').filter(l => /clock went backwards/.test(l.msg)).length, 1);
  });

  test('a clock that went backwards waits at most the spacing of the request at hand', async () => {
    const { h, g } = await started({ readSpacing: 0, writeSpacing: 500 });
    const a = await granted(g);
    await g.report(repOf(a));
    h.t -= 60000;
    const b = await granted(g, { path: '/api/b' });
    assert.equal(b.res.waitedMs, 0, 'a read with no spacing waits for nothing');
    await g.report(repOf(b));
    h.t -= 60000;
    const pc = g.permit(reqOf({ method: 'POST', path: '/api/c' }));
    assert.equal(await settled(pc), null);
    assert.equal(g.snapshot().wait.until, h.t + 500, 'a write waits one spacing before a write from now');
    await h.advance(500);
    assert.equal((await pc).ok, true);
  });

  test('a read waits the spacing before a read and a write the one before a write, each from the end of the previous request', async () => {
    const { h, g } = await started({ readSpacing: 0, writeSpacing: 500 });
    const a = await granted(g, { path: '/api/a' });
    h.t += 100;
    await g.report(repOf(a));
    // A GET after a GET goes at once: no wait, no wake.
    const b = await granted(g, { path: '/api/b' });
    assert.equal(b.res.waitedMs, 0);
    assert.equal(h.live().length, 0);
    assert.deepEqual(h.waits(), []);
    h.t += 100;
    await g.report(repOf(b));
    const ended = h.t;
    // A POST after it waits the spacing before a write.
    const reqC = reqOf({ method: 'POST', path: '/api/c' });
    const pc = g.permit(reqC);
    assert.equal(await settled(pc), null);
    assert.equal(g.snapshot().phase, 'waiting');
    assert.deepEqual(g.snapshot().wait, { reason: 'spacing', since: ended, until: ended + 500 });
    assert.deepEqual(h.live().map(w => w.at), [ended + 500]);
    await h.advance(499);
    assert.equal(await settled(pc), null);
    await h.advance(1);
    const c = await pc;
    assert.equal(c.ok, true);
    assert.equal(c.waitedMs, 500);
    await g.report(repOf({ req: reqC, res: c }));
    // A GET or a HEAD after the write goes at once again.
    const d = await granted(g, { path: '/api/d' });
    assert.equal(d.res.waitedMs, 0);
    await g.report(repOf(d));
    const e = await granted(g, { method: 'HEAD', path: '/api/e' });
    assert.equal(e.res.waitedMs, 0);
    await g.report(repOf(e));
    // Every other method is a write: a PUT waits too.
    const reqF = reqOf({ method: 'PUT', path: '/api/f' });
    const pf = g.permit(reqF);
    assert.equal(await settled(pf), null);
    assert.equal(g.snapshot().wait.until, h.t + 500);
    await h.advance(500);
    assert.equal((await pf).waitedMs, 500);
    assert.deepEqual(h.waits(), ['start:spacing', 'end:spacing', 'start:spacing', 'end:spacing']);
    assert.equal(g.snapshot().counters.waitedMs, 1000);
  });

  test('a spacing of 0 still lets one request run at a time', async () => {
    const { h, g } = await started({ readSpacing: 0, writeSpacing: 0 });
    const a = await granted(g, { path: '/api/a' });
    const reqB = reqOf({ path: '/api/b' });
    const pb = g.permit(reqB);
    const pc = g.permit(reqOf({ method: 'POST', path: '/api/c' }));
    assert.equal(await settled(pb), null);
    assert.equal(await settled(pc), null);
    assert.equal(g.snapshot().phase, 'in-flight');
    assert.equal(h.live().length, 0, 'nothing to wait for but the report');
    await g.report(repOf(a));
    const b = await pb;
    assert.equal(b.ok, true);
    assert.equal(b.waitedMs, 0);
    assert.equal(await settled(pc), null, 'c waits for b, serially');
    assert.equal(g.snapshot().inFlight.permit, b.permit);
    await g.report(repOf({ req: reqB, res: b }));
    assert.equal((await pc).ok, true);
  });

  test('a probe is spaced by its method like any other request', async () => {
    const { h, g } = await started({ readSpacing: 0, writeSpacing: 500 });
    const a = await granted(g, { method: 'POST', path: '/api/a' });
    await g.report(repOf(a));
    const p = await granted(g, { kind: 'probe', path: '/api/organizations' });
    assert.equal(p.res.waitedMs, 0);
    assert.equal(h.live().length, 0);
  });

  test('a config that is not usable falls back to the defaults; nothing usable is the default, never 0', async () => {
    const h = harness();
    h.cfg = 'nonsense';
    const g = h.gate();
    await g.start('job_1');
    const a = await granted(g);
    await g.report(repOf(a));
    // The default before a read is 0: a GET goes at once, with no wake.
    const b = await granted(g);
    assert.equal(b.res.waitedMs, 0);
    assert.equal(h.live().length, 0);
    await g.report(repOf(b));
    // The default before a write is WRITE_SPACING_DEFAULT_MS.
    const pc = g.permit(reqOf({ method: 'POST', path: '/api/c' }));
    assert.equal(await settled(pc), null);
    assert.deepEqual(g.snapshot().wait, { reason: 'spacing', since: h.t, until: h.t + WRITE_SPACING_DEFAULT_MS });
    // Missing, null, empty or not a number is the default, not 0.
    for (const writeSpacingMs of [undefined, null, '', 'soon']) {
      h.cfg = { readSpacingMs: 0, writeSpacingMs, retryAfterCapMs: 900000 };
      await g.reevaluate();
      assert.equal(await settled(pc), null, `writeSpacingMs ${String(writeSpacingMs)}`);
      assert.equal(g.snapshot().wait.until, h.t + WRITE_SPACING_DEFAULT_MS);
    }
    h.cfg = { readSpacingMs: -5, writeSpacingMs: -5, retryAfterCapMs: 1 };
    await g.reevaluate();
    assert.equal((await pc).ok, true, 'a negative spacing is clamped to 0');
  });
});

// ------------------------------------------------------------------
// 429 and Retry-After
// ------------------------------------------------------------------

describe('slow down', () => {
  test('a 429 with Retry-After is passed to the script and the full wait is honoured by the next permit', async () => {
    const { h, g } = await started({ spacing: 500 });
    const a = await granted(g, { path: '/api/a' });
    const answer = await g.report(repOf(a, { status: 429, headers: { 'retry-after': '120' } }));
    assert.deepEqual(answer, { action: 'pass', verdict: 'slow-down', retryAfterMs: 120000 });
    const ended = h.t;
    let s = g.snapshot();
    assert.equal(s.notBefore, ended + 120000);
    assert.equal(s.counters.slowDowns, 1);
    assert.equal(s.recent.at(-1).outcome, 'slow-down');
    assert.equal(s.recent.at(-1).retryAfterMs, 120000);
    assert.deepEqual(s.wait, { reason: 'script-backoff', since: ended, until: null });
    assert.equal(s.phase, 'ready');
    // The script sleeps its own SLOW_DOWN_WAITS, then asks again.
    h.t += 2000;
    const pb = g.permit(reqOf({ path: '/api/a' }));
    assert.equal(await settled(pb), null);
    s = g.snapshot();
    assert.equal(s.phase, 'waiting');
    assert.deepEqual(s.wait, { reason: 'retry-after', since: h.t, until: ended + 120000 });
    assert.deepEqual(h.live().map(w => w.at), [ended + 120000]);
    h.t = ended + 119999;
    await g.reevaluate();
    assert.equal(await settled(pb), null);
    await h.advance(1);
    const b = await pb;
    assert.equal(b.ok, true);
    assert.equal(b.attempt, 2, 'the same step, its second attempt');
    assert.deepEqual(h.waits(), ['start:script-backoff', 'end:script-backoff', 'start:retry-after', 'end:retry-after']);
  });

  test('an HTTP-date Retry-After is honoured too', async () => {
    const { h, g } = await started();
    const a = await granted(g);
    await g.report(repOf(a, { status: 429, headers: { 'Retry-After': new Date(h.t + 30000).toUTCString() } }));
    assert.equal(g.snapshot().notBefore, h.t + 30000);
  });

  test('a 429 without Retry-After only keeps the spacing', async () => {
    const { h, g } = await started({ spacing: 500 });
    const a = await granted(g);
    const answer = await g.report(repOf(a, { status: 429 }));
    assert.deepEqual(answer, { action: 'pass', verdict: 'slow-down' });
    assert.equal(g.snapshot().notBefore, 0);
    const pb = g.permit(reqOf());
    assert.equal(await settled(pb), null);
    assert.deepEqual(g.snapshot().wait.reason, 'spacing');
    assert.equal(g.snapshot().wait.until, h.t + 500);
  });

  test('with no spacing before a read, a Retry-After on a 429 or a 503 is still honoured in full', async () => {
    for (const status of [429, 503]) {
      const { h, g } = await started({ readSpacing: 0, writeSpacing: 500 });
      const a = await granted(g, { path: '/api/a' });
      const answer = await g.report(repOf(a, { status, headers: { 'retry-after': '120' } }));
      assert.equal(answer.action, 'pass', `${status}`);
      assert.equal(answer.retryAfterMs, 120000);
      const ended = h.t;
      const pb = g.permit(reqOf({ path: '/api/a' }));
      assert.equal(await settled(pb), null);
      assert.deepEqual(g.snapshot().wait, { reason: 'retry-after', since: ended, until: ended + 120000 });
      assert.deepEqual(h.live().map(w => w.at), [ended + 120000]);
      h.t = ended + 119999;
      await g.reevaluate();
      assert.equal(await settled(pb), null, `${status}: not a millisecond early`);
      await h.advance(1);
      const b = await pb;
      assert.equal(b.ok, true);
      assert.equal(b.waitedMs, 120000);
    }
  });

  test('with no spacing before a read, a 429 without Retry-After adds no wait of the gate\'s own', async () => {
    // What the gate does today, pinned: the script's own back-off spaces its
    // retry, and the next read of an export that does not retry goes at
    // once. Raising the spacing before a read is the person's answer to a
    // run of 429s, never a retry or a wait the gate makes up.
    const { h, g } = await started({ readSpacing: 0, writeSpacing: 500 });
    const a = await granted(g, { path: '/api/a' });
    const answer = await g.report(repOf(a, { status: 429 }));
    assert.deepEqual(answer, { action: 'pass', verdict: 'slow-down' });
    assert.equal(g.snapshot().notBefore, 0);
    const b = await granted(g, { path: '/api/b' });
    assert.equal(b.res.waitedMs, 0);
    assert.equal(h.live().length, 0);
    await g.report(repOf(b, { status: 429 }));
    // A write after it still waits the spacing before a write.
    const pc = g.permit(reqOf({ method: 'POST', path: '/api/c' }));
    assert.equal(await settled(pc), null);
    assert.deepEqual(g.snapshot().wait, { reason: 'spacing', since: h.t, until: h.t + 500 });
  });

  test('the classifier may supply retryAfterMs itself', async () => {
    const { h, g } = await started();
    const a = await granted(g);
    h.classifyNext.push({ verdict: 'slow-down', retryAfterMs: 60000 });
    await g.report(repOf(a, { status: 429, headers: { 'retry-after': '5' } }));
    assert.equal(g.snapshot().notBefore, h.t + 60000);
  });

  test('a Retry-After beyond the cap becomes a visible hold, and the full wait is still honoured after Resume', async () => {
    const { h, g } = await started({ spacing: 500 });
    const a = await granted(g, { path: '/api/a' });
    const answer = await g.report(repOf(a, { status: 429, headers: { 'retry-after': '1000' } }));
    const ended = h.t;
    assert.deepEqual(answer, { action: 'hold', reason: 'long-wait', retryAfterMs: 1000000 });
    let s = g.snapshot();
    assert.equal(s.phase, 'held');
    assert.equal(s.held.reason, 'long-wait');
    assert.equal(s.held.permit, a.res.permit);
    assert.equal(s.notBefore, ended + 1000000);
    assert.deepEqual(s.wait, { reason: 'held', since: ended, until: null });
    assert.ok(h.changes.some(c => c.type === 'held' && c.reason === 'long-wait'));
    // The page parks the response and re-asks.
    const reask = g.permit(reqOf({ path: '/api/a', retryOf: a.res.permit }));
    assert.equal(await settled(reask), null);
    await h.advance(600000);
    assert.equal(await settled(reask), null, 'held across ten minutes');
    assert.equal(g.snapshot().phase, 'held');
    // Retry and Give up are not refused here, but Resume is the panel's button.
    assert.deepEqual(await g.resume(), { ok: true, held: null });
    s = g.snapshot();
    assert.equal(s.phase, 'waiting');
    assert.deepEqual(s.wait, { reason: 'retry-after', since: h.t, until: ended + 1000000 });
    assert.ok(h.changes.some(c => c.type === 'released' && c.action === 'resume'));
    h.t = ended + 1000000;
    await h.fire();
    const b = await reask;
    assert.equal(b.ok, true);
    assert.equal(b.permit, a.res.permit, 'the same permit id');
    assert.equal(b.attempt, 2);
    assert.equal(b.seq, 2);
    assert.equal(g.snapshot().held, null);
  });

  test('Give up on a long wait refuses the re-ask with give-up and the wait still stands', async () => {
    const { h, g } = await started();
    const a = await granted(g, { path: '/api/a' });
    await g.report(repOf(a, { status: 429, headers: { 'retry-after': '1000' } }));
    const reask = g.permit(reqOf({ path: '/api/a', retryOf: a.res.permit }));
    assert.deepEqual(await g.giveUp(), { ok: true });
    assert.deepEqual(await reask, { ok: false, reason: 'give-up' });
    assert.equal(g.snapshot().notBefore, h.t + 1000000);
    const pb = g.permit(reqOf({ path: '/api/b' }));
    assert.equal(await settled(pb), null);
    assert.equal(g.snapshot().wait.reason, 'retry-after');
  });

  test('the 9th consecutive 429 of one step is held; another step does not count; a success resets', async () => {
    const { h, g } = await started();
    const K = { path: '/api/k' };
    const L = { path: '/api/l' };
    for (let i = 1; i < HOLD_AFTER_SLOW_DOWNS; i++) {
      const r = await roundTrip(g, h, { ...K, status: 429 });
      assert.equal(r.answer.action, 'pass', `attempt ${i}`);
      h.t += 1000;
    }
    assert.equal(g.snapshot().steps[stepKeyOf({ method: 'GET', path: '/api/k' })].consecutive429, HOLD_AFTER_SLOW_DOWNS - 1);
    const other = await roundTrip(g, h, { ...L, status: 429 });
    assert.equal(other.answer.action, 'pass');
    const ninth = await roundTrip(g, h, { ...K, status: 429 });
    assert.deepEqual(ninth.answer, { action: 'hold', reason: 'failed-step' });
    assert.equal(g.snapshot().held.stepKey, stepKeyOf({ method: 'GET', path: '/api/k' }));
    assert.equal(g.snapshot().held.attempt, HOLD_AFTER_SLOW_DOWNS);
    await g.giveUp();
    // After Give up the counters start over: eight more 429s pass again.
    for (let i = 1; i < HOLD_AFTER_SLOW_DOWNS; i++) {
      const r = await roundTrip(g, h, { ...K, status: 429 });
      assert.equal(r.answer.action, 'pass', `second round, attempt ${i}`);
    }
    const ok = await roundTrip(g, h, { ...K, status: 200 });
    assert.equal(ok.answer.action, 'pass');
    assert.equal(g.snapshot().steps[stepKeyOf({ method: 'GET', path: '/api/k' })].consecutive429, 0);
    assert.equal(g.snapshot().steps[stepKeyOf({ method: 'GET', path: '/api/k' })].state, 'done');
  });

  test('with no spacing at all, the 9th 429 in a row and the 4th failure in a row of one step are still held', async () => {
    const { h, g } = await started({ readSpacing: 0, writeSpacing: 0 });
    const K = { path: '/api/k' };
    for (let i = 1; i < HOLD_AFTER_SLOW_DOWNS; i++) {
      const r = await roundTrip(g, h, { ...K, status: 429 });
      assert.equal(r.answer.action, 'pass', `attempt ${i}`);
      assert.equal(r.res.waitedMs, 0);
    }
    const ninth = await roundTrip(g, h, { ...K, status: 429 });
    assert.deepEqual(ninth.answer, { action: 'hold', reason: 'failed-step' });
    assert.equal(g.snapshot().held.attempt, HOLD_AFTER_SLOW_DOWNS);
    await g.giveUp();
    const P = { path: '/api/p', method: 'PUT', bodySig: 'json:ab' };
    for (let i = 1; i < HOLD_AFTER_FAILURES; i++) {
      const r = await roundTrip(g, h, { ...P, status: 503 });
      assert.deepEqual(r.answer, { action: 'pass', verdict: 'pass' }, `attempt ${i}`);
      assert.equal(r.res.waitedMs, 0);
    }
    const fourth = await roundTrip(g, h, { ...P, status: 503 });
    assert.deepEqual(fourth.answer, { action: 'hold', reason: 'failed-step' });
    assert.equal(g.snapshot().held.attempt, HOLD_AFTER_FAILURES);
  });
});

// ------------------------------------------------------------------
// 5xx, lost replies, Retry and Give up
// ------------------------------------------------------------------

describe('server errors', () => {
  test('three 503s pass with a visible script-backoff; the fourth is held', async () => {
    const { h, g } = await started();
    const K = { path: '/api/k', method: 'PUT', bodySig: 'json:ab' };
    for (let i = 1; i < HOLD_AFTER_FAILURES; i++) {
      const r = await roundTrip(g, h, { ...K, status: 503 });
      assert.deepEqual(r.answer, { action: 'pass', verdict: 'pass' }, `attempt ${i}`);
      assert.equal(g.snapshot().wait.reason, 'script-backoff');
      assert.equal(g.snapshot().phase, 'ready');
    }
    const fourth = await roundTrip(g, h, { ...K, status: 503 });
    assert.deepEqual(fourth.answer, { action: 'hold', reason: 'failed-step' });
    const s = g.snapshot();
    assert.equal(s.phase, 'held');
    assert.equal(s.held.status, 503);
    assert.equal(s.held.attempt, HOLD_AFTER_FAILURES);
    assert.equal(s.counters.serverErrors, HOLD_AFTER_FAILURES);
    assert.equal(s.recent.at(-1).outcome, 'held');
    assert.equal(s.recent.at(-2).outcome, 'server-error');
  });

  test('a lost reply (status 0 with an error) counts like a 5xx', async () => {
    const { h, g } = await started();
    const K = { path: '/api/k' };
    const err = { name: 'AbortError', message: 'no reply within 120 seconds' };
    for (let i = 1; i < HOLD_AFTER_FAILURES; i++) {
      const r = await roundTrip(g, h, { ...K, status: 0, ok: false, error: err });
      assert.deepEqual(r.answer, { action: 'pass', verdict: 'network' });
    }
    const fourth = await roundTrip(g, h, { ...K, status: 0, ok: false, error: err });
    assert.equal(fourth.answer.action, 'hold');
    assert.equal(g.snapshot().counters.networkErrors, HOLD_AFTER_FAILURES);
    assert.equal(g.snapshot().recent.at(-2).outcome, 'network');
  });

  test('a 5xx the script does not retry (520) is held on the first attempt', async () => {
    const { h, g } = await started();
    const r = await roundTrip(g, h, { path: '/api/k', status: 520 });
    assert.deepEqual(r.answer, { action: 'hold', reason: 'failed-step' });
    assert.equal(g.snapshot().held.attempt, 1);
  });

  test('a hold names the request\'s method and path: in the state, the store, the change and after a restart', async () => {
    const { h, g } = await started();
    const UP = { method: 'POST', path: '/api/organizations/org-1/projects/p-1/upload', bodySig: 'form:a.pdf:99' };
    const up = await roundTrip(g, h, { ...UP, status: 503 });
    assert.equal(up.answer.action, 'hold');
    const expected = { permit: up.res.permit, requestId: up.req.requestId, stepKey: up.req.stepKey, method: 'POST', path: UP.path, reason: 'failed-step', interruption: null, status: 503, attempt: 1, heldAt: h.t };
    assert.deepEqual(g.snapshot().held, expected);
    assert.deepEqual(h.data.held, expected);
    const change = h.changes.find(c => c.type === 'held');
    assert.equal(change.method, 'POST');
    assert.equal(change.path, UP.path);
    assert.equal(h.logged('warn').find(l => l.event === 'held').data.method, 'POST');
    h.wakes = [];
    const g2 = h.gate();
    await g2.load();
    assert.deepEqual(g2.snapshot().held, expected);
    assert.deepEqual(sanitizeState(g2.snapshot()), g2.snapshot());
  });

  test('a standard project\'s document or file POST is held on its first 5xx or lost reply, where the script would give up; Retry sends it again', async () => {
    const { h, g } = await started();
    const DOC = { method: 'POST', path: '/api/organizations/org-1/projects/p-1/docs', bodySig: 'json:d0c' };
    const doc = await roundTrip(g, h, { ...DOC, status: 503 });
    assert.deepEqual(doc.answer, { action: 'hold', reason: 'failed-step' });
    let s = g.snapshot();
    assert.equal(s.phase, 'held');
    assert.equal(s.held.attempt, 1);
    assert.equal(s.held.method, 'POST');
    assert.equal(s.held.path, DOC.path);
    assert.equal(s.held.status, 503);
    assert.equal(s.recent.at(-1).outcome, 'held');
    const reask = g.permit(reqOf({ ...DOC, retryOf: doc.res.permit }));
    assert.equal(await settled(reask), null);
    assert.deepEqual(await g.retry(), { ok: true });
    const again = await reask;
    assert.equal(again.permit, doc.res.permit);
    assert.equal(again.attempt, 2);
    const done = await g.report({ requestId: g.snapshot().inFlight.requestId, permit: again.permit, status: 201, headers: {} });
    assert.deepEqual(done, { action: 'pass', verdict: 'pass' });
    assert.equal(g.snapshot().steps[doc.req.stepKey].state, 'done');
    // A transient 502 from Cloudflare on an upload, attempt 1: held, never "not added" on its own.
    const UP = { method: 'POST', path: '/api/organizations/org-1/projects/p-1/upload', bodySig: 'form:notes.md:1200' };
    const up = await roundTrip(g, h, { ...UP, status: 502 });
    assert.deepEqual(up.answer, { action: 'hold', reason: 'failed-step' });
    assert.equal(g.snapshot().held.attempt, 1);
    assert.deepEqual(await g.giveUp(), { ok: true });
    // The wrapper's own timeout after a sleep (status 0): held on attempt 1 too.
    const lost = await roundTrip(g, h, { ...UP, status: 0, ok: false, error: { name: 'AbortError', message: 'no reply within 120 seconds' } });
    assert.deepEqual(lost.answer, { action: 'hold', reason: 'failed-step' });
    s = g.snapshot();
    assert.equal(s.held.attempt, 2, 'the step\'s second send');
    assert.equal(s.steps[up.req.stepKey].consecutiveFailures, 1, 'Give up started the count over: held on the first failure again');
    assert.equal(s.held.status, 0);
    assert.equal(s.counters.networkErrors, 1);
    assert.equal(s.counters.held, 3);
  });

  test('the requests the script retries by itself pass three times and are held on the fourth: the code project\'s upload and files:write, a PUT', async () => {
    const { h, g } = await started();
    for (const K of [
      { method: 'POST', path: '/api/org-1/upload', bodySig: 'form:a.png:10' },
      { method: 'POST', path: '/v1/code/channels/chan_1/files:write', bodySig: 'json:fw' },
      { method: 'PUT', path: '/api/organizations/org-1/projects/p-1', bodySig: 'json:pt' },
    ]) {
      for (let i = 1; i < HOLD_AFTER_FAILURES; i++) {
        const r = await roundTrip(g, h, { ...K, status: 502 });
        assert.deepEqual(r.answer, { action: 'pass', verdict: 'pass' }, `${K.path} attempt ${i}`);
      }
      const fourth = await roundTrip(g, h, { ...K, status: 502 });
      assert.deepEqual(fourth.answer, { action: 'hold', reason: 'failed-step' }, `${K.path} attempt ${HOLD_AFTER_FAILURES}`);
      assert.equal(g.snapshot().held.attempt, HOLD_AFTER_FAILURES);
      await g.giveUp();
    }
  });

  test('a 503 with Retry-After is passed to the script, but the site\'s wait is honoured in full by the next grant and shown', async () => {
    const { h, g } = await started({ spacing: 500 });
    const K = { method: 'PUT', path: '/api/organizations/org-1/projects/p-1', bodySig: 'json:pt' };
    const a = await granted(g, K);
    const answer = await g.report(repOf(a, { status: 503, headers: { 'Retry-After': '120' } }));
    const ended = h.t;
    assert.deepEqual(answer, { action: 'pass', verdict: 'pass', retryAfterMs: 120000 });
    let s = g.snapshot();
    assert.equal(s.notBefore, ended + 120000);
    assert.equal(s.phase, 'ready');
    assert.equal(s.recent.at(-1).outcome, 'server-error');
    assert.equal(s.recent.at(-1).retryAfterMs, 120000);
    assert.equal(h.changes.find(c => c.type === 'report').retryAfterMs, 120000);
    // The script sleeps its own 60 s cap and sends again; the gate waits out the rest, visibly.
    h.t += 60000;
    const pb = g.permit(reqOf(K));
    assert.equal(await settled(pb), null);
    s = g.snapshot();
    assert.equal(s.phase, 'waiting');
    assert.deepEqual(s.wait, { reason: 'retry-after', since: h.t, until: ended + 120000 });
    assert.deepEqual(h.live().map(w => w.at), [ended + 120000]);
    h.t = ended + 119999;
    await g.reevaluate();
    assert.equal(await settled(pb), null);
    await h.advance(1);
    const b = await pb;
    assert.equal(b.ok, true);
    assert.equal(b.attempt, 2);
    assert.deepEqual(h.waits(), ['start:script-backoff', 'end:script-backoff', 'start:retry-after', 'end:retry-after']);
  });

  test('an HTTP-date Retry-After on a 502 is honoured; a lost reply without one leaves the wait alone', async () => {
    const { h, g } = await started();
    const a = await granted(g, { path: '/api/a' });
    await g.report(repOf(a, { status: 502, headers: { 'retry-after': new Date(h.t + 45000).toUTCString() } }));
    const notBefore = g.snapshot().notBefore;
    assert.equal(notBefore, h.t + 45000);
    const b = await roundTrip(g, h, { path: '/api/b', status: 0, ok: false, error: { name: 'TypeError', message: 'Failed to fetch' } });
    assert.deepEqual(b.answer, { action: 'pass', verdict: 'network' });
    assert.equal(g.snapshot().notBefore, notBefore);
    assert.equal(g.snapshot().recent.at(-1).retryAfterMs, null);
  });

  test('a 503 whose Retry-After is beyond the cap is a visible hold, and the full wait is still honoured after Resume', async () => {
    const { h, g } = await started({ spacing: 500 });
    const a = await granted(g, { path: '/api/a' });
    const answer = await g.report(repOf(a, { status: 503, headers: { 'retry-after': '1000' } }));
    const ended = h.t;
    assert.deepEqual(answer, { action: 'hold', reason: 'long-wait', retryAfterMs: 1000000 });
    assert.equal(g.snapshot().held.reason, 'long-wait');
    assert.equal(g.snapshot().held.status, 503);
    assert.equal(g.snapshot().notBefore, ended + 1000000);
    const reask = g.permit(reqOf({ path: '/api/a', retryOf: a.res.permit }));
    assert.equal(await settled(reask), null);
    await h.advance(600000);
    assert.equal(await settled(reask), null, 'held across ten minutes');
    assert.deepEqual(await g.resume(), { ok: true, held: null });
    assert.deepEqual(g.snapshot().wait, { reason: 'retry-after', since: h.t, until: ended + 1000000 });
    h.t = ended + 1000000;
    await h.fire();
    assert.equal((await reask).attempt, 2);
  });

  test('a create\'s 503 with a long Retry-After is a failed step first; after Retry the re-ask still waits out the site\'s time', async () => {
    const { h, g } = await started();
    const C = { method: 'POST', path: '/api/organizations/org-1/projects', bodySig: 'json:cafe' };
    const a = await granted(g, C);
    const answer = await g.report(repOf(a, { status: 503, headers: { 'retry-after': '3600' } }));
    const ended = h.t;
    assert.deepEqual(answer, { action: 'hold', reason: 'failed-step', retryAfterMs: 3600000 });
    const reask = g.permit(reqOf({ ...C, retryOf: a.res.permit }));
    assert.equal(await settled(reask), null);
    await g.retry();
    assert.equal(await settled(reask), null, 'released, but the site\'s wait stands');
    assert.deepEqual(g.snapshot().wait, { reason: 'retry-after', since: ended, until: ended + 3600000 });
    h.t = ended + 3600000;
    await h.fire();
    const again = await reask;
    assert.equal(again.attempt, 2);
    assert.equal(g.snapshot().created.pending, true);
  });

  test('a create\'s first 500 is held; Retry grants the same permit as attempt 2', async () => {
    const { h, g } = await started();
    const C = { method: 'POST', path: '/api/organizations/org-1/projects', bodySig: 'json:cafe' };
    const create = await granted(g, C);
    assert.equal(g.snapshot().created.pending, true);
    const answer = await g.report(repOf(create, { status: 500 }));
    assert.deepEqual(answer, { action: 'hold', reason: 'failed-step' });
    const s = g.snapshot();
    assert.equal(s.created.pending, false);
    assert.equal(s.created.status, 500);
    const reask = g.permit(reqOf({ ...C, retryOf: create.res.permit }));
    assert.equal(await settled(reask), null);
    assert.deepEqual(await g.retry(), { ok: true });
    const again = await reask;
    assert.equal(again.ok, true);
    assert.equal(again.permit, create.res.permit);
    assert.equal(again.attempt, 2);
    assert.equal(g.snapshot().created.pending, true, 'the create is out again');
    assert.ok(h.changes.some(c => c.type === 'released' && c.action === 'retry'));
    const inFlight = g.snapshot().inFlight;
    const done = await g.report({ requestId: inFlight.requestId, permit: again.permit, status: 201, headers: {}, created: { id: 'u-1', url: '/project/u-1', name: 'P' } });
    assert.equal(done.action, 'pass');
    assert.equal(g.snapshot().created.id, 'u-1');
    assert.equal(g.snapshot().created.pending, false);
  });

  test('Give up refuses the re-ask with give-up and resets the step\'s counters', async () => {
    const { h, g } = await started();
    const K = { path: '/api/k' };
    for (let i = 1; i < HOLD_AFTER_FAILURES; i++) await roundTrip(g, h, { ...K, status: 502 });
    const held = await roundTrip(g, h, { ...K, status: 502 });
    assert.equal(held.answer.action, 'hold');
    const reask = g.permit(reqOf({ ...K, retryOf: held.res.permit }));
    assert.deepEqual(await g.giveUp(), { ok: true });
    assert.deepEqual(await reask, { ok: false, reason: 'give-up' });
    const s = g.snapshot();
    assert.equal(s.phase, 'ready');
    assert.equal(s.held, null);
    const step = s.steps[stepKeyOf({ method: 'GET', path: '/api/k' })];
    assert.equal(step.consecutiveFailures, 0);
    assert.equal(step.state, 'failed');
    assert.ok(h.changes.some(c => c.type === 'released' && c.action === 'give-up'));
    assert.ok(h.changes.some(c => c.type === 'refused' && c.reason === 'give-up'));
    // The script moves on; a later failure of the same step starts counting from one.
    const later = await roundTrip(g, h, { ...K, status: 502 });
    assert.equal(later.answer.action, 'pass');
  });

  test('Retry or Give up pressed before the re-ask arrives is remembered', async () => {
    const { h, g } = await started();
    const a = await roundTrip(g, h, { path: '/api/k', status: 520 });
    assert.equal(a.answer.action, 'hold');
    await g.retry();
    assert.equal(g.snapshot().release.action, 'retry');
    const reask = await g.permit(reqOf({ path: '/api/k', retryOf: a.res.permit }));
    assert.equal(reask.ok, true);
    assert.equal(reask.permit, a.res.permit);
    assert.equal(reask.attempt, 2);
    assert.equal(g.snapshot().release, null);
    await g.report({ requestId: g.snapshot().inFlight.requestId, permit: reask.permit, status: 520, headers: {} });
    assert.equal(g.snapshot().held.attempt, 2);
    await g.giveUp();
    assert.equal(g.snapshot().release.action, 'give-up');
    assert.deepEqual(await g.permit(reqOf({ path: '/api/k', retryOf: a.res.permit })), { ok: false, reason: 'give-up' });
    assert.equal(g.snapshot().release, null);
  });

  test('a re-ask for a permit that is not held is refused, as is a second re-ask for one hold', async () => {
    const { h, g } = await started();
    const a = await roundTrip(g, h, { path: '/api/k', status: 200 });
    assert.deepEqual(await g.permit(reqOf({ path: '/api/k', retryOf: a.res.permit })), { ok: false, reason: 'wrong-phase' });
    assert.deepEqual(await g.permit(reqOf({ path: '/api/k', retryOf: 'p999' })), { ok: false, reason: 'wrong-phase' });
    const held = await roundTrip(g, h, { path: '/api/k', status: 520 });
    const first = g.permit(reqOf({ path: '/api/k', retryOf: held.res.permit }));
    assert.equal(await settled(first), null);
    assert.deepEqual(await g.permit(reqOf({ path: '/api/k', retryOf: held.res.permit })), { ok: false, reason: 'wrong-phase' });
    assert.ok(h.logged('warn').some(l => /second re-ask/.test(l.msg)));
    await g.retry();
    assert.equal((await first).ok, true);
  });

  test('Retry and Give up without a hold say so without changing anything', async () => {
    const { g } = await started();
    assert.deepEqual(await g.retry(), { ok: false, reason: 'not-held' });
    assert.deepEqual(await g.giveUp(), { ok: false, reason: 'not-held' });
    assert.equal(g.snapshot().phase, 'ready');
  });
});

// ------------------------------------------------------------------
// Interruptions
// ------------------------------------------------------------------

describe('interruptions', () => {
  test('an interrupt verdict holds the step; only Resume releases it; the re-ask outlives an hour', async () => {
    const { h, g } = await started({ spacing: 500 });
    const a = await granted(g, { method: 'POST', path: '/api/organizations/org-1/projects/p/docs', bodySig: 'json:1' });
    const answer = await g.report(repOf(a, { status: 403, headers: { ...CHALLENGE, cookie: 'x=1' }, markers: ['cf_chl_opt', 'challenge-platform'] }));
    assert.equal(answer.action, 'hold');
    assert.equal(answer.reason, 'interrupted');
    assert.equal(answer.verdict, 'interrupt');
    assert.equal(answer.kind, 'challenge');
    assert.equal(answer.interruption.kind, 'challenge');
    assert.equal(answer.interruption.evidence.status, 403);
    assert.deepEqual(answer.interruption.evidence.markers, ['cf_chl_opt', 'challenge-platform']);
    assert.deepEqual(Object.keys(answer.interruption.evidence.headers).sort(), ['cf-mitigated', 'cf-ray', 'content-type']);
    let s = g.snapshot();
    assert.equal(s.phase, 'held');
    assert.equal(s.held.reason, 'interrupted');
    assert.equal(s.held.interruption.kind, 'challenge');
    assert.equal(s.held.interruption.evidence.path, '/api/organizations/org-1/projects/p/docs');
    assert.deepEqual(s.wait, { reason: 'interrupted', since: h.t, until: null });
    assert.equal(s.counters.interruptions, 1);
    assert.equal(s.recent.at(-1).outcome, 'interrupted');
    const reask = g.permit(reqOf({ method: 'POST', path: '/api/organizations/org-1/projects/p/docs', bodySig: 'json:1', retryOf: a.res.permit }));
    assert.equal(await settled(reask), null);
    await h.advance(3600000);
    assert.equal(await settled(reask), null);
    assert.deepEqual(await g.retry(), { ok: false, reason: 'interrupted' });
    assert.deepEqual(await g.giveUp(), { ok: false, reason: 'interrupted' });
    assert.equal(await settled(reask), null);
    assert.equal(g.snapshot().phase, 'held');
    assert.deepEqual(await g.resume(), { ok: true, held: null });
    const b = await reask;
    assert.equal(b.ok, true);
    assert.equal(b.permit, a.res.permit);
    assert.equal(b.attempt, 2);
    s = g.snapshot();
    assert.equal(s.phase, 'in-flight');
    assert.equal(s.held, null);
    assert.ok(h.changes.some(c => c.type === 'held' && c.reason === 'interrupted' && c.kind === 'challenge'));
    assert.ok(h.changes.some(c => c.type === 'released' && c.action === 'resume'));
    assert.ok(h.logged('warn').some(l => l.event === 'held'));
  });

  test('a 401 on the API is an interruption too, with the classifier\'s kind', async () => {
    const { h, g } = await started();
    const a = await roundTrip(g, h, { path: '/api/organizations', status: 401 });
    assert.equal(a.answer.action, 'hold');
    assert.equal(a.answer.kind, 'signed-out');
    assert.equal(g.snapshot().held.interruption.kind, 'signed-out');
  });

  test('a probe is granted while held, and its own interruption only updates the hold', async () => {
    const { h, g } = await started();
    const a = await roundTrip(g, h, { path: '/api/a', status: 403, headers: CHALLENGE });
    assert.equal(a.answer.action, 'hold');
    const reask = g.permit(reqOf({ path: '/api/a', retryOf: a.res.permit }));
    assert.equal(await settled(reask), null);
    const probe = await granted(g, { path: '/api/organizations', kind: 'probe' });
    assert.equal(g.snapshot().phase, 'held', 'a probe in flight does not change the phase');
    const again = await g.report(repOf(probe, { status: 503, headers: CHALLENGE }));
    assert.equal(again.action, 'pass', 'the probe gets its response back');
    assert.equal(again.verdict, 'interrupt');
    assert.equal(again.kind, 'challenge');
    assert.equal(g.snapshot().held.permit, a.res.permit, 'the script\'s hold stays');
    assert.equal(g.snapshot().held.interruption.evidence.status, 503);
    assert.equal(g.snapshot().counters.probes, 1);
    assert.equal(g.snapshot().counters.interruptions, 2);
    assert.equal(await settled(reask), null);
    const probe2 = await granted(g, { path: '/api/account', kind: 'probe' });
    assert.equal((await g.report(repOf(probe2, { status: 200 }))).action, 'pass');
    await g.resume();
    assert.equal((await reask).ok, true);
  });

  test('a probe\'s 429 or 5xx is never held, but a probe\'s interruption holds an open gate', async () => {
    const { h, g } = await started();
    const p1 = await roundTrip(g, h, { path: '/api/organizations', kind: 'probe', status: 503 });
    assert.deepEqual(p1.answer, { action: 'pass', verdict: 'pass' });
    const p2 = await roundTrip(g, h, { path: '/api/organizations', kind: 'probe', status: 429, headers: { 'retry-after': '100000' } });
    assert.equal(p2.answer.action, 'pass');
    assert.equal(g.snapshot().phase, 'ready');
    assert.equal(g.snapshot().notBefore, h.t + 100000000, 'the site\'s wait still counts');
    const p3 = await roundTrip(g, h, { path: '/api/organizations', kind: 'probe', status: 403, headers: CHALLENGE });
    assert.equal(p3.answer.action, 'hold');
    assert.equal(g.snapshot().phase, 'held');
  });

  test('a response whose classification fails falls back to the built-in rules', async () => {
    const { h, g } = await started();
    h.classifyNext.push(() => { throw new Error('classifier bug'); });
    const a = await roundTrip(g, h, { path: '/api/a', status: 429, headers: { 'retry-after': '7' } });
    assert.equal(a.answer.action, 'pass');
    assert.equal(g.snapshot().notBefore, h.t + 7000);
    h.classifyNext.push({ nonsense: true });
    const b = await roundTrip(g, h, { path: '/api/b', status: 403, headers: CHALLENGE });
    assert.equal(b.answer.action, 'hold');
    assert.equal(b.answer.reason, 'interrupted');
    assert.equal(h.logged('error').filter(l => /classify failed/.test(l.msg)).length, 2);
  });

  test('the classifier sees the request\'s method, path and attempt with the sanitized report', async () => {
    const { h, g } = await started();
    await roundTrip(g, h, { method: 'POST', path: '/v1/code/channels/c/files:write', bodySig: 'json:9', status: 200, headers: { cookie: 'a=b', 'Retry-After': '1', Server: 'cloudflare' } });
    const seen = h.classifyCalls.at(-1);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.path, '/v1/code/channels/c/files:write');
    assert.equal(seen.attempt, 1);
    assert.equal(seen.kind, 'script');
    assert.deepEqual(seen.headers, { 'retry-after': '1', server: 'cloudflare' });
  });
});

// ------------------------------------------------------------------
// Creates
// ------------------------------------------------------------------

describe('creates', () => {
  test('created.pending is in the store before the permit resolves; a second create is refused', async () => {
    const { h, g } = await started();
    const C = { method: 'POST', path: '/v1/code/channels', bodySig: 'json:abc' };
    const req = reqOf(C);
    let storedAtResolve = null;
    const p = g.permit(req).then(res => {
      storedAtResolve = clone(h.data.created);
      return res;
    });
    const res = await p;
    assert.equal(res.ok, true);
    assert.deepEqual(storedAtResolve, { permit: res.permit, at: h.t, pending: true, status: null, id: null, url: null, mayHaveActed: true });
    const second = await g.permit(reqOf({ ...C, requestId: 'r-second' }));
    assert.deepEqual(second, { ok: false, reason: 'wrong-phase' });
    assert.ok(h.logged('error').some(l => /second create/.test(l.msg)));
    await g.report(repOf({ req, res }, { status: 200, created: { id: 'chan_9', url: '/code/project/chan_9', name: 'N' } }));
    const s = g.snapshot();
    assert.deepEqual(s.created, { permit: res.permit, at: h.t, pending: false, status: 200, id: 'chan_9', url: '/code/project/chan_9', mayHaveActed: true });
    assert.deepEqual(sanitizeState(s), s, 'created round-trips through the store unchanged');
    assert.deepEqual(await g.permit(reqOf({ ...C, requestId: 'r-third' })), { ok: false, reason: 'wrong-phase' });
  });

  test('a job whose create may have acted is never started again, finished or cancelled included; a new job id is the only way on', async () => {
    const { h, g } = await started();
    const C = { method: 'POST', path: '/v1/code/channels', bodySig: 'json:abc' };
    await granted(g, C);
    // The tab was reloaded before the reply came back: no report, ever.
    assert.equal(g.snapshot().created.mayHaveActed, true);
    assert.equal(g.createMayHaveActed(), true);
    await g.finish('cancelled');
    await assert.rejects(g.start('job_1'), /already permitted a create/);
    assert.equal(g.snapshot().phase, 'cancelled');
    assert.equal(g.snapshot().created.mayHaveActed, true, 'nothing was wiped');
    assert.deepEqual(await g.permit(reqOf(C)), { ok: false, reason: 'cancelled' }, 'no second create goes out');
    assert.ok(h.logged('error').some(l => /cannot be started again/.test(l.msg)));
    // The same on a new gate over the same store: a restarted worker.
    h.wakes = [];
    const g2 = h.gate();
    await assert.rejects(g2.start('job_1'), /already permitted a create/);
    assert.equal(g2.createMayHaveActed(), true);
    assert.deepEqual(await g2.permit(reqOf(C)), { ok: false, reason: 'cancelled' });
    await g2.start('job_2');
    assert.equal(g2.snapshot().created, null);
    assert.equal(g2.createMayHaveActed(), false);
    assert.equal((await g2.permit(reqOf(C))).ok, true, 'a new job may create');
  });

  test('a 2xx whose body gave no id still counts as acted; a create the site turned away does not', async () => {
    const { h, g } = await started();
    const C = { method: 'POST', path: '/api/organizations/org-1/projects', bodySig: 'json:abc' };
    const a = await roundTrip(g, h, { ...C, status: 200 });
    assert.equal(a.answer.action, 'pass');
    const s = g.snapshot();
    assert.equal(s.created.id, null);
    assert.equal(s.created.status, 200);
    assert.equal(s.created.mayHaveActed, true);
    await g.finish('failed');
    await assert.rejects(g.start('job_1'), /already permitted a create/);
    const turnedAway = await started();
    const b = await roundTrip(turnedAway.g, turnedAway.h, { ...C, status: 403 });
    assert.equal(b.answer.action, 'pass');
    assert.equal(turnedAway.g.snapshot().created.mayHaveActed, false);
    assert.equal(turnedAway.g.createMayHaveActed(), false);
    await turnedAway.g.finish('cancelled');
    await turnedAway.g.start('job_1');
    assert.equal(turnedAway.g.snapshot().phase, 'ready');
    assert.equal(turnedAway.g.snapshot().created, null);
  });

  test('after a create was turned away (429 or another 4xx) the script may send it again', async () => {
    const { h, g } = await started();
    const C = { method: 'POST', path: '/api/organizations/org-1/projects', bodySig: 'json:abc' };
    const first = await roundTrip(g, h, { ...C, status: 429, headers: { 'retry-after': '1' } });
    assert.equal(first.answer.action, 'pass');
    assert.equal(g.snapshot().created.status, 429);
    const second = await roundTrip(g, h, { ...C, status: 403 });
    assert.equal(second.answer.action, 'pass');
    assert.notEqual(second.res.permit, first.res.permit);
    assert.equal(g.snapshot().created.permit, second.res.permit);
    const third = await roundTrip(g, h, { ...C, status: 201, created: { id: 'u', url: '/project/u', name: 'N' } });
    assert.equal(third.answer.action, 'pass');
    assert.deepEqual(await g.permit(reqOf(C)), { ok: false, reason: 'wrong-phase' });
  });

  test('a create whose reply was lost may not be sent again except through the hold', async () => {
    const { h, g } = await started();
    const C = { method: 'POST', path: '/v1/code/channels', bodySig: 'json:abc' };
    const first = await roundTrip(g, h, { ...C, status: 0, ok: false, error: { name: 'TypeError', message: 'Failed to fetch' } });
    assert.equal(first.answer.action, 'hold');
    assert.deepEqual(await g.permit(reqOf(C)), { ok: false, reason: 'wrong-phase' });
    const reask = g.permit(reqOf({ ...C, retryOf: first.res.permit }));
    await g.retry();
    assert.equal((await reask).permit, first.res.permit);
  });
});

// ------------------------------------------------------------------
// The worker's hold: an interruption seen outside a response
// ------------------------------------------------------------------

describe('the worker\'s hold', () => {
  const PAGE = { kind: 'challenge', what: 'The tab shows a Cloudflare check.', todo: 'Solve it in the tab, then press Resume.', evidence: { finalPath: '/cdn-cgi/challenge-platform/x?__cf_chl_tk=SECRET', markers: ['cf_chl_opt'] } };
  const REDUCED = { kind: 'challenge', what: PAGE.what, todo: PAGE.todo, resumable: true, evidence: { finalPath: '/cdn-cgi/challenge-platform/x', markers: ['cf_chl_opt'] } };

  test('hold() stops the gate for an interruption seen outside a response; probes pass, only Resume releases it', async () => {
    const { h, g } = await started();
    assert.deepEqual(await g.hold({ reason: 'interrupted', interruption: PAGE }), { ok: true });
    let s = g.snapshot();
    assert.equal(s.phase, 'held');
    assert.equal(s.pausedBy, null, 'not a pause by the person');
    assert.deepEqual(s.wait, { reason: 'interrupted', since: h.t, until: null });
    assert.deepEqual(s.held, { permit: null, requestId: null, stepKey: null, method: null, path: null, reason: 'interrupted', interruption: REDUCED, status: 0, attempt: 0, heldAt: h.t });
    assert.deepEqual(h.data.held, s.held);
    assert.equal(s.counters.held, 1);
    assert.equal(s.counters.interruptions, 1);
    assert.ok(h.changes.some(c => c.type === 'held' && c.reason === 'interrupted' && c.kind === 'challenge' && c.permit === null));
    assert.ok(!JSON.stringify([h.data, h.logs, h.changes]).includes('SECRET'), 'the evidence is reduced like any other');
    assert.deepEqual(await g.hold({ interruption: PAGE }), { ok: true, already: true, held: 'interrupted' });
    assert.equal(g.snapshot().counters.held, 1);
    const pb = g.permit(reqOf({ path: '/api/b' }));
    assert.equal(await settled(pb), null, 'no script request goes out while held');
    const probe = await granted(g, { path: '/api/organizations', kind: 'probe' });
    assert.equal((await g.report(repOf(probe))).action, 'pass');
    assert.equal(await settled(pb), null);
    assert.deepEqual(await g.retry(), { ok: false, reason: 'interrupted' });
    assert.deepEqual(await g.giveUp(), { ok: false, reason: 'interrupted' });
    assert.deepEqual(await g.resume(), { ok: true, held: null });
    assert.equal((await pb).ok, true);
    s = g.snapshot();
    assert.equal(s.held, null);
    assert.equal(s.release, null, 'nothing to remember for a hold that named no request');
    assert.equal(s.phase, 'in-flight');
    assert.ok(h.changes.some(c => c.type === 'released' && c.action === 'resume' && c.permit === null));
    assert.deepEqual(h.waits(), ['start:interrupted', 'end:interrupted']);
  });

  test('hold() while a step waits for Retry or Give up only notes the interruption on it; that choice stays', async () => {
    const { h, g } = await started();
    const a = await roundTrip(g, h, { path: '/api/a', status: 520 });
    assert.equal(a.answer.action, 'hold');
    assert.deepEqual(await g.hold({ reason: 'interrupted', interruption: PAGE }), { ok: true, already: true, held: 'failed-step' });
    const s = g.snapshot();
    assert.equal(s.held.reason, 'failed-step');
    assert.equal(s.held.permit, a.res.permit);
    assert.deepEqual(s.held.interruption, REDUCED);
    assert.deepEqual(h.data.held.interruption, REDUCED);
    assert.equal(s.counters.held, 1);
    assert.deepEqual(await g.resume(), { ok: true, already: true, held: 'failed-step' });
    const reask = g.permit(reqOf({ path: '/api/a', retryOf: a.res.permit }));
    await g.retry();
    assert.equal((await reask).attempt, 2);
  });

  test('a request in flight when the worker holds finishes; if its answer would hold the gate it joins the hold, and Resume sends it again', async () => {
    const { h, g } = await started();
    const DOC = { method: 'POST', path: '/api/organizations/org-1/projects/p-1/docs', bodySig: 'json:d' };
    const a = await granted(g, DOC);
    await g.hold({ reason: 'interrupted', interruption: PAGE });
    assert.equal(g.snapshot().inFlight.permit, a.res.permit, 'the request in flight is left to finish');
    const answer = await g.report(repOf(a, { status: 503 }));
    assert.equal(answer.action, 'hold');
    assert.equal(answer.reason, 'interrupted');
    assert.deepEqual(answer.interruption, REDUCED);
    const s = g.snapshot();
    assert.equal(s.held.permit, a.res.permit);
    assert.equal(s.held.requestId, a.req.requestId);
    assert.equal(s.held.reason, 'interrupted');
    assert.equal(s.held.method, 'POST');
    assert.equal(s.held.path, DOC.path);
    assert.equal(s.held.status, 503);
    assert.equal(s.held.attempt, 1);
    assert.equal(s.counters.held, 1, 'one hold, joined');
    assert.equal(s.recent.at(-1).outcome, 'held');
    assert.ok(h.changes.some(c => c.type === 'held' && c.joined === true && c.permit === a.res.permit));
    const reask = g.permit(reqOf({ ...DOC, retryOf: a.res.permit }));
    assert.equal(await settled(reask), null);
    assert.deepEqual(await g.retry(), { ok: false, reason: 'interrupted' });
    assert.deepEqual(await g.resume(), { ok: true, held: null });
    const again = await reask;
    assert.equal(again.permit, a.res.permit);
    assert.equal(again.attempt, 2);
  });

  test('a request in flight that succeeds while the worker holds passes; a challenge on one joins the hold with the response\'s own interruption', async () => {
    const { h, g } = await started();
    const a = await granted(g, { path: '/api/a' });
    await g.hold({ interruption: PAGE });
    assert.deepEqual(await g.report(repOf(a)), { action: 'pass', verdict: 'pass' });
    assert.equal(g.snapshot().held.permit, null);
    assert.equal(g.snapshot().counters.ok, 1);
    const reqB = reqOf({ path: '/api/b' });
    const pb = g.permit(reqB);
    assert.equal(await settled(pb), null);
    await g.resume();
    const b = await pb;
    assert.equal(b.ok, true);
    await g.hold({ interruption: { kind: 'wrong-account', what: 'signed in as someone else', todo: 'sign in as X' } });
    const answer = await g.report(repOf({ req: reqB, res: b }, { status: 403, headers: CHALLENGE, markers: ['cf_chl_opt'] }));
    assert.equal(answer.action, 'hold');
    assert.equal(answer.reason, 'interrupted');
    assert.equal(answer.verdict, 'interrupt');
    assert.equal(answer.kind, 'challenge');
    assert.equal(answer.interruption.kind, 'challenge', 'the response\'s interruption is the more specific');
    const s = g.snapshot();
    assert.equal(s.held.permit, b.permit);
    assert.equal(s.held.reason, 'interrupted');
    assert.equal(s.held.interruption.kind, 'challenge');
    assert.equal(s.held.interruption.evidence.status, 403);
    assert.equal(s.counters.held, 2);
    assert.equal(s.counters.interruptions, 3);
    const reask = g.permit(reqOf({ path: '/api/b', retryOf: b.permit }));
    await h.advance(3600000);
    assert.equal(await settled(reask), null, 'a challenged request is never re-sent on its own');
    await g.resume();
    assert.equal((await reask).attempt, 2);
  });

  test('a worker hold survives a restart and is released by Resume on the new gate', async () => {
    const { h, g } = await started();
    await g.hold({ interruption: PAGE });
    const req = reqOf({ path: '/api/b' });
    g.permit(req);
    await flush();
    h.wakes = [];
    const g2 = h.gate();
    const loaded = await g2.load();
    assert.equal(loaded.phase, 'held');
    assert.equal(loaded.held.permit, null);
    assert.deepEqual(loaded.held.interruption, REDUCED);
    assert.deepEqual(loaded.wait, { reason: 'interrupted', since: h.t, until: null });
    const resent = g2.permit(req);
    await h.advance(3600000);
    assert.equal(await settled(resent), null);
    assert.deepEqual(await g2.retry(), { ok: false, reason: 'interrupted' });
    await g2.resume();
    assert.equal((await resent).ok, true);
  });

  test('hold() with no job or after the end says so; a reason the worker may not use is a TypeError', async () => {
    const h = harness();
    const g = h.gate();
    assert.deepEqual(await g.hold({ interruption: PAGE }), { ok: false, reason: 'no-job' });
    await g.start('job_1');
    await assert.rejects(g.hold({ reason: 'failed-step' }), /reason must be 'interrupted'/);
    assert.deepEqual(await g.hold(), { ok: true }, 'an interruption is optional');
    assert.equal(g.snapshot().held.interruption, null);
    assert.equal(g.snapshot().counters.interruptions, 0);
    await g.cancel();
    assert.deepEqual(await g.hold({ interruption: PAGE }), { ok: false, reason: 'wrong-phase' });
    assert.equal(g.snapshot().held, null);
  });

  test('a stored hold that names no request is kept only when it is an interruption', () => {
    const base = freshState('job_1');
    const ok = sanitizeState({ ...base, held: { permit: null, reason: 'interrupted', interruption: { kind: 'challenge', what: 'w', todo: 't' }, heldAt: 5 } });
    assert.deepEqual(ok.held, { permit: null, requestId: null, stepKey: null, method: null, path: null, reason: 'interrupted', interruption: { kind: 'challenge', what: 'w', todo: 't', resumable: true, evidence: {} }, status: 0, attempt: 0, heldAt: 5 });
    assert.equal(sanitizeState({ ...base, held: { permit: null, reason: 'failed-step', heldAt: 5 } }).held, null);
    assert.equal(sanitizeState({ ...base, held: { permit: 42, reason: 'interrupted', heldAt: 5 } }).held, null);
    assert.equal(sanitizeState({ ...base, held: { permit: 'p1', reason: 'failed-step', heldAt: 5 } }).held, null, 'a named hold needs its request');
  });
});

// ------------------------------------------------------------------
// Pause, resume, cancel, finish
// ------------------------------------------------------------------

describe('pause, cancel, finish', () => {
  test('pause lets the in-flight request finish and holds the next script permit, probes pass', async () => {
    const { h, g } = await started();
    const a = await granted(g, { path: '/api/a' });
    assert.deepEqual(await g.pause(), { ok: true });
    assert.equal(g.snapshot().phase, 'paused');
    assert.deepEqual(await g.pause(), { ok: true, already: true });
    assert.equal((await g.report(repOf(a))).action, 'pass');
    const pb = g.permit(reqOf({ path: '/api/b' }));
    assert.equal(await settled(pb), null);
    assert.deepEqual(g.snapshot().wait, { reason: 'paused', since: h.t, until: null });
    const probe = await granted(g, { path: '/api/organizations', kind: 'probe' });
    await g.report(repOf(probe));
    assert.equal(await settled(pb), null);
    assert.deepEqual(await g.resume(), { ok: true, held: null });
    assert.equal((await pb).ok, true);
    assert.deepEqual(await g.resume(), { ok: true, already: true, held: null });
    assert.deepEqual(h.waits(), ['start:paused', 'end:paused']);
    assert.equal(h.changes.filter(c => c.type === 'resumed').length, 1);
  });

  test('a pause during a hold keeps the hold; releasing it lands in paused', async () => {
    const { h, g } = await started();
    const a = await roundTrip(g, h, { path: '/api/a', status: 520 });
    assert.equal(a.answer.action, 'hold');
    await g.pause();
    assert.equal(g.snapshot().phase, 'held');
    const reask = g.permit(reqOf({ path: '/api/a', retryOf: a.res.permit }));
    await g.retry();
    assert.equal(g.snapshot().phase, 'paused');
    assert.equal(await settled(reask), null);
    await g.resume();
    assert.equal((await reask).ok, true);
  });

  test('resume on a failed-step hold only clears the pause', async () => {
    const { h, g } = await started();
    const a = await roundTrip(g, h, { path: '/api/a', status: 520 });
    const reask = g.permit(reqOf({ path: '/api/a', retryOf: a.res.permit }));
    assert.deepEqual(await g.resume(), { ok: true, already: true, held: 'failed-step' });
    assert.equal(await settled(reask), null);
    assert.equal(g.snapshot().phase, 'held');
  });

  test('cancel during a wait refuses the pending permit, drops the wake and is terminal', async () => {
    const { h, g } = await started({ spacing: 500 });
    const a = await granted(g, { path: '/api/a' });
    await g.report(repOf(a));
    const pb = g.permit(reqOf({ path: '/api/b' }));
    assert.equal(await settled(pb), null);
    assert.equal(h.live().length, 1);
    assert.deepEqual(await g.cancel(), { ok: true });
    assert.deepEqual(await pb, { ok: false, reason: 'cancelled' });
    const s = g.snapshot();
    assert.equal(s.phase, 'cancelled');
    assert.equal(s.wait, null);
    assert.deepEqual(s.pending, []);
    assert.equal(h.live().length, 0);
    assert.equal(h.data.phase, 'cancelled');
    assert.deepEqual(await g.permit(reqOf({ path: '/api/c' })), { ok: false, reason: 'cancelled' });
    assert.deepEqual(await g.cancel(), { ok: true, already: true, phase: 'cancelled' });
    assert.deepEqual(h.waits(), ['start:spacing', 'end:spacing']);
    assert.ok(h.changes.some(c => c.type === 'phase' && c.phase === 'cancelled'));
    assert.deepEqual(await g.pause(), { ok: false, reason: 'wrong-phase' });
    assert.deepEqual(await g.resume(), { ok: false, reason: 'wrong-phase' });
    assert.deepEqual(await g.retry(), { ok: false, reason: 'wrong-phase' });
    // A wake that was already in a queue somewhere does no harm.
    h.t += 1000;
    await g.reevaluate();
    assert.equal(g.snapshot().phase, 'cancelled');
  });

  test('cancel during a hold refuses the held re-ask and keeps what was created', async () => {
    const { h, g } = await started();
    const C = { method: 'POST', path: '/v1/code/channels', bodySig: 'json:1' };
    const create = await roundTrip(g, h, { ...C, status: 200, created: { id: 'chan_1', url: '/code/project/chan_1', name: 'N' } });
    assert.equal(create.answer.action, 'pass');
    const held = await roundTrip(g, h, { path: '/api/k', status: 520 });
    const reask = g.permit(reqOf({ path: '/api/k', retryOf: held.res.permit }));
    await g.cancel();
    assert.deepEqual(await reask, { ok: false, reason: 'cancelled' });
    const s = g.snapshot();
    assert.equal(s.held, null);
    assert.equal(s.created.id, 'chan_1');
    const cancelled = h.changes.find(c => c.type === 'cancelled');
    assert.equal(cancelled.created.url, '/code/project/chan_1');
  });

  test('a report that arrives after cancel is passed and not counted', async () => {
    const { h, g } = await started();
    const a = await granted(g, { path: '/api/a' });
    await g.cancel();
    const answer = await g.report(repOf(a, { status: 503 }));
    assert.equal(answer.action, 'pass');
    assert.equal(g.snapshot().inFlight, null);
    assert.equal(g.snapshot().counters.serverErrors, 0);
    assert.equal(g.snapshot().held, null);
  });

  test('finish refuses pending permits with wrong-phase and is idempotent', async () => {
    const { h, g } = await started();
    const a = await granted(g);
    const pb = g.permit(reqOf({ path: '/api/b' }));
    assert.deepEqual(await g.finish('done'), { ok: true });
    assert.deepEqual(await pb, { ok: false, reason: 'wrong-phase' });
    assert.equal(g.snapshot().phase, 'done');
    assert.deepEqual(await g.permit(reqOf()), { ok: false, reason: 'wrong-phase' });
    assert.deepEqual(await g.finish('failed'), { ok: true, already: true, phase: 'done' });
    assert.equal((await g.report(repOf(a))).action, 'pass');
    assert.ok(h.changes.some(c => c.type === 'phase' && c.phase === 'done'));
  });

  test('finish(cancelled) refuses with cancelled', async () => {
    const { g } = await started();
    const pb = g.permit(reqOf());
    await g.report(repOf({ req: reqOf({ requestId: 'nope' }), res: { permit: 'p1' } })).catch(() => {});
    await g.finish('cancelled');
    const b = await pb;
    assert.equal(b.ok, true, 'it was granted before finish');
    assert.deepEqual(await g.permit(reqOf()), { ok: false, reason: 'cancelled' });
  });
});

// ------------------------------------------------------------------
// Restart: a new gate on the same store
// ------------------------------------------------------------------

describe('restart', () => {
  // The worker died: its wakes and promises are gone, the store is not.
  function restart(h) {
    h.wakes = [];
    return h.gate();
  }

  test('a wait survives: the re-sent permit is granted at the stored time, and asked again gets the same answer', async () => {
    const { h, g } = await started({ spacing: 500 });
    const a = await granted(g, { path: '/api/a' });
    await g.report(repOf(a));
    const until = h.t + 500;
    const req = reqOf({ path: '/api/b' });
    const pb = g.permit(req);
    assert.equal(await settled(pb), null);

    const g2 = restart(h);
    const loaded = await g2.load();
    assert.equal(loaded.phase, 'waiting');
    assert.deepEqual(loaded.pending.map(p => p.requestId), [req.requestId]);
    assert.deepEqual(h.live().map(w => w.at), [until], 'the wake is re-armed from the state');
    const resent = g2.permit(req);
    assert.equal(await settled(resent), null);
    h.t = until;
    await h.fire();
    const b = await resent;
    assert.equal(b.ok, true);
    assert.equal(b.waitedMs, 500);
    assert.equal(b.seq, 2);
    assert.deepEqual(await g2.permit(req), b, 'answered from the stored answers');
    assert.equal(g2.snapshot().inFlight.requestId, req.requestId);
    assert.equal(await settled(pb), null, 'the dead worker\'s promise stays unresolved; nothing depends on it');
  });

  test('an in-flight request survives: its report is processed by the new gate', async () => {
    const { h, g } = await started();
    const a = await granted(g, { path: '/api/a' });
    const g2 = restart(h);
    const answer = await g2.report(repOf(a, { status: 200 }));
    assert.deepEqual(answer, { action: 'pass', verdict: 'pass' });
    assert.equal(g2.snapshot().counters.ok, 1);
    assert.deepEqual(await g2.report(repOf(a, { status: 500 })), answer, 'a repeated report gets the stored answer');
  });

  test('a hold survives: Retry on the new gate grants the persisted re-ask', async () => {
    const { h, g } = await started();
    const held = await roundTrip(g, h, { path: '/api/k', status: 520 });
    const req = reqOf({ path: '/api/k', retryOf: held.res.permit });
    const reask = g.permit(req);
    assert.equal(await settled(reask), null);
    const g2 = restart(h);
    await g2.load();
    assert.equal(g2.snapshot().held.permit, held.res.permit);
    assert.equal(g2.snapshot().phase, 'held');
    await g2.retry();
    const answer = await g2.permit(req);
    assert.equal(answer.ok, true);
    assert.equal(answer.permit, held.res.permit);
    assert.equal(answer.attempt, 2);
  });

  test('an interruption survives and still needs Resume', async () => {
    const { h, g } = await started();
    const held = await roundTrip(g, h, { path: '/api/k', status: 403, headers: CHALLENGE });
    const req = reqOf({ path: '/api/k', retryOf: held.res.permit });
    g.permit(req);
    await flush();
    const g2 = restart(h);
    const resent = g2.permit(req);
    await h.advance(3600000);
    assert.equal(await settled(resent), null);
    assert.equal(g2.snapshot().held.interruption.kind, 'challenge');
    assert.deepEqual(await g2.retry(), { ok: false, reason: 'interrupted' });
    await g2.resume();
    assert.equal((await resent).attempt, 2);
  });

  test('every operation loads the store first, even without load()', async () => {
    const { h, g } = await started();
    await granted(g, { path: '/api/a' });
    const g2 = restart(h);
    assert.equal((await g2.pause()).ok, true);
    assert.equal(g2.snapshot().jobId, 'job_1');
    const g3 = restart(h);
    await assert.rejects(g3.start('job_2'), /still active/);
  });

  test('the permit counter stays ahead of the ids in a restored state', async () => {
    const h = harness();
    const s = freshState('job_1');
    s.pending.push({ permit: 'p7', requestId: 'r-old', seq: null, stepKey: 'GET /api/a ', method: 'GET', path: '/api/a', kind: 'script', retryOf: null, askedAt: 1 });
    s.lastPermit = 0;
    h.data = s;
    const g = h.gate();
    await g.load();
    const old = g.snapshot();
    assert.equal(old.inFlight.permit, 'p7', 'the restored pending permit was granted');
    await g.report({ requestId: 'r-old', permit: 'p7', status: 200, headers: {} });
    const next = await granted(g, { path: '/api/b' });
    assert.equal(next.res.permit, 'p8');
    assert.equal(next.res.seq, 2);
  });
});

// ------------------------------------------------------------------
// Corrupt or odd input
// ------------------------------------------------------------------

describe('corrupt state and odd reports', () => {
  test('garbage in the store starts idle with a warning', async () => {
    for (const garbage of ['nonsense', 42, [], { version: 2, jobId: 'x' }, { version: 1, jobId: 7 }, { version: 1 }]) {
      const h = harness();
      h.data = garbage;
      const g = h.gate();
      const s = await g.load();
      assert.equal(s.phase, 'idle', JSON.stringify(garbage));
      assert.equal(s.jobId, null);
      assert.ok(h.logged('warn').some(l => /unusable/.test(l.msg)), JSON.stringify(garbage));
    }
  });

  test('a store that cannot be read starts idle; a store that cannot be written does not stop the gate', async () => {
    const h = harness();
    h.store.get = async () => { throw new Error('disk'); };
    const g = h.gate();
    assert.equal((await g.load()).phase, 'idle');
    assert.ok(h.logged('error').some(l => /could not read/.test(l.msg)));
    await g.start('job_1');
    h.failSet = true;
    const a = await granted(g, { path: '/api/a' });
    assert.equal((await g.report(repOf(a))).action, 'pass');
    assert.ok(h.logged('error').some(l => /could not persist/.test(l.msg)));
  });

  test('a partly corrupt state keeps what is sound and drops the rest', async () => {
    const h = harness();
    const raw = freshState('job_1');
    raw.phase = 'bogus';
    raw.pending = 'nope';
    raw.steps = null;
    raw.answers = { r1: { permit: { ok: true, permit: 'p1', attempt: 1, seq: 1, waitedMs: 0 }, at: 5 }, r2: 'junk', r3: { at: 1 } };
    raw.recent = [{ permit: 'p1', requestId: 'r1', stepKey: 'k', status: 'abc', outcome: 'weird' }, null, 'x'];
    raw.held = { permit: 'p1', reason: 'not-a-reason' };
    raw.counters = { requests: 'many', ok: 3 };
    raw.wait = { reason: 'spacing', until: 'later' };
    raw.unknownField = { deep: true };
    raw.notBefore = -100;
    h.data = raw;
    const g = h.gate();
    const s = await g.load();
    assert.equal(s.phase, 'ready');
    assert.deepEqual(s.pending, []);
    assert.deepEqual(s.steps, {});
    assert.deepEqual(Object.keys(s.answers), ['r1']);
    assert.equal(s.recent.length, 1);
    assert.equal(s.recent[0].status, 0);
    assert.equal(s.recent[0].outcome, 'ok');
    assert.equal(s.held, null);
    assert.deepEqual(s.counters, { requests: 0, ok: 3, slowDowns: 0, serverErrors: 0, networkErrors: 0, interruptions: 0, held: 0, probes: 0, waitedMs: 0 });
    assert.equal(s.wait, null);
    assert.equal(s.unknownField, undefined);
    assert.equal(s.notBefore, 0);
    assert.equal(sanitizeState(undefined), null);
    assert.equal(sanitizeState({ version: 1, jobId: null }).phase, 'idle');
  });

  test('a report with no headers, a body that is not text and odd markers is taken in stride', async () => {
    const { g } = await started();
    const a = await granted(g, { path: '/api/a' });
    const answer = await g.report({ requestId: a.req.requestId, permit: a.res.permit, status: '404', headers: null, markers: 'not-a-list', bodyExcerpt: { binary: true }, bodyJson: 'text', error: 42, elapsedMs: 'slow' });
    assert.deepEqual(answer, { action: 'pass', verdict: 'pass' });
    const s = g.snapshot();
    assert.equal(s.recent.at(-1).status, 404);
    assert.equal(s.recent.at(-1).outcome, 'refused');
    assert.equal(s.recent.at(-1).elapsedMs, 0, 'an unusable elapsedMs is measured from the grant');
    const b = await granted(g, { path: '/api/b' });
    const lost = await g.report({ requestId: b.req.requestId, permit: b.res.permit, status: 'abc', headers: { entries: () => [['Retry-After', 3]] } });
    assert.equal(lost.verdict, 'network', 'no usable status is no reply');
    assert.equal(s.counters.requests, 1);
    assert.equal(g.snapshot().counters.networkErrors, 1);
  });

  test('a stray report is passed with a warning', async () => {
    const { h, g } = await started();
    const answer = await g.report({ requestId: 'r-ghost', permit: 'p-ghost', status: 503, headers: {} });
    assert.equal(answer.action, 'pass');
    assert.equal(answer.stray, true);
    assert.equal(g.snapshot().counters.requests, 0);
    assert.ok(h.logged('warn').some(l => /not in flight/.test(l.msg)));
    const a = await granted(g, { path: '/api/a' });
    const wrong = await g.report({ requestId: a.req.requestId, permit: 'p-other', status: 503, headers: {} });
    assert.equal(wrong.stray, true);
    assert.equal(g.snapshot().inFlight.permit, a.res.permit, 'the real request is still in flight');
  });

  test('onChange and the logger may throw without stopping the gate', async () => {
    const h = harness();
    h.throwOnChange = true;
    h.log.warn = () => { throw new Error('log boom'); };
    const g = h.gate();
    await g.start('job_1');
    const a = await roundTrip(g, h, { path: '/api/a', status: 520 });
    assert.equal(a.answer.action, 'hold');
    assert.ok(h.logged('error').some(l => /onChange threw/.test(l.msg)));
  });

  test('a wake scheduler that throws is logged and the next re-evaluation still grants', async () => {
    const { h, g } = await started({ spacing: 500 });
    const a = await granted(g);
    await g.report(repOf(a));
    h.wake = () => { throw new Error('alarms down'); };
    const g2 = h.gate();
    const pb = g2.permit(reqOf({ path: '/api/b' }));
    assert.equal(await settled(pb), null);
    assert.ok(h.logged('error').some(l => /wake could not be scheduled/.test(l.msg)));
    h.t += 500;
    await g2.reevaluate();
    assert.equal((await pb).ok, true);
  });
});

// ------------------------------------------------------------------
// Caps, snapshots, secrets
// ------------------------------------------------------------------

describe('caps, snapshots and secrets', () => {
  test('recent is capped at 50, steps at 200, answers at 20', async () => {
    const { h, g } = await started();
    for (let i = 0; i < STEPS_MAX + 10; i++) await roundTrip(g, h, { path: `/api/step/${i}` });
    const s = g.snapshot();
    assert.equal(s.recent.length, RECENT_MAX);
    assert.equal(s.recent[0].path, `/api/step/${STEPS_MAX + 10 - RECENT_MAX}`);
    assert.equal(Object.keys(s.steps).length, STEPS_MAX);
    assert.ok(!s.steps['GET /api/step/0 '], 'the oldest step was dropped');
    assert.ok(s.steps[`GET /api/step/${STEPS_MAX + 9} `]);
    assert.equal(Object.keys(s.answers).length, ANSWERS_MAX);
    assert.equal(s.counters.requests, STEPS_MAX + 10);
    assert.equal(s.lastSeq, STEPS_MAX + 10);
  });

  test('a step in use is never trimmed away', async () => {
    const { h, g } = await started();
    const held = await roundTrip(g, h, { path: '/api/held', status: 520 });
    g.permit(reqOf({ path: '/api/held', retryOf: held.res.permit }));
    await flush();
    for (let i = 0; i < STEPS_MAX + 10; i++) {
      const probe = await roundTrip(g, h, { path: `/api/probe/${i}`, kind: 'probe' });
      assert.equal(probe.answer.action, 'pass');
    }
    assert.ok(g.snapshot().steps['GET /api/held ']);
  });

  test('snapshot is plain JSON, a copy, and round-trips', async () => {
    const { h, g } = await started({ spacing: 500 });
    const a = await roundTrip(g, h, { path: '/api/a', status: 429, headers: { 'retry-after': '3' } });
    assert.equal(a.answer.action, 'pass');
    const s = g.snapshot();
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
    assert.deepEqual(sanitizeState(s), s, 'a snapshot survives sanitizing unchanged');
    s.counters.requests = 99;
    s.pending.push({ bogus: true });
    assert.equal(g.snapshot().counters.requests, 1);
    assert.deepEqual(g.snapshot().pending, []);
    assert.deepEqual(h.data, g.snapshot());
  });

  test('nothing secret reaches the state, the store or the log', async () => {
    const { h, g } = await started();
    const a = await granted(g, { path: '/api/organizations/org-1/projects/p/docs', method: 'POST', bodySig: 'json:1' });
    const answer = await g.report(repOf(a, {
      status: 403,
      headers: { ...CHALLENGE, cookie: 'sessionKey=sk-ant-sid01-SECRETCOOKIE', 'set-cookie': '__cf_bm=SECRETBM; path=/', authorization: 'Bearer SECRETBEARERTOKENVALUE', 'x-api-key': 'sk-ant-api03-SECRETAPIKEY', location: 'https://claude.ai/login?token=SECRETQUERY' },
      markers: ['cf_chl_opt', 'sk-ant-api03-SECRETMARKER'],
      bodyExcerpt: 'Bearer SECRETBEARERTOKENVALUE and sk-ant-api03-SECRETBODY and sessionKey=SECRETSESSION',
      bodyJson: { error: { type: 'x', message: 'key sk-ant-api03-SECRETJSON', reason: 'y', extra: 'SECRETEXTRA' } },
      error: { name: 'E', message: 'sk-ant-api03-SECRETERROR' },
    }));
    assert.equal(answer.action, 'hold');
    const everything = JSON.stringify([h.data, h.writes, h.logs, h.changes, answer, g.snapshot()]);
    for (const secret of ['SECRETCOOKIE', 'SECRETBM', 'SECRETBEARER', 'SECRETAPIKEY', 'SECRETQUERY', 'SECRETMARKER', 'SECRETBODY', 'SECRETSESSION', 'SECRETJSON', 'SECRETEXTRA', 'SECRETERROR', 'sk-ant-', 'cookie', 'authorization', 'x-api-key']) {
      assert.ok(!everything.includes(secret), `${secret} leaked`);
    }
    assert.ok(everything.includes('8abc-IAD'), 'cf-ray is kept');
    assert.equal(g.snapshot().held.interruption.evidence.headers.location, '/login');
  });

  test('the gate never fetches, never sets a timer and never asks for cookies: only what is injected is called', async () => {
    const seen = new Set();
    const h = harness();
    const spy = (name, fn) => (...args) => { seen.add(name); return fn(...args); };
    const g = createGate({ now: spy('now', h.now), wake: spy('wake', h.wake), store: { get: spy('store.get', h.store.get), set: spy('store.set', h.store.set) }, config: spy('config', () => h.cfg), classify: spy('classify', h.classify), log: h.log, onChange: spy('onChange', h.onChange) });
    await g.start('job_1');
    const a = await roundTrip(g, h, { path: '/api/a' });
    assert.equal(a.answer.action, 'pass');
    assert.deepEqual([...seen].sort(), ['classify', 'config', 'now', 'onChange', 'store.get', 'store.set']);
  });
});
