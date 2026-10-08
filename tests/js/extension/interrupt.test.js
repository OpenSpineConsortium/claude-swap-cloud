// Tests for extension/src/interrupt.js: the response, page and identity
// classifiers (one case per rule of the design's section 2.9, plus the near
// misses), the texts shown to the person, and the interruption record with
// its persistence, its history cap and its redaction. One test drives the
// real gate.js on a fake clock, because what classifyResponse hands back
// for a rate-limit page only matters through what the gate does with it.
// Everything is deterministic: the clock, the store and the logger are
// fakes made here.
// Run with: node --test tests/js/extension/interrupt.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KINDS, BODY_MARKERS, CHALLENGE_MARKERS, BLOCKED_MARKERS, RATE_LIMIT_MARKERS,
  PAGE_MARKER_SELECTORS, LOGIN_PATH_RE, HEADER_ALLOWLIST, ACCOUNT_ENDPOINTS,
  EVIDENCE_KEYS, REDACTED,
  scanBody, pickHeaders, emailOf, pathOnly, parseRetryAfter, redact, redactText,
  reduceEvidence, classifyResponse, classifyPage, classifyIdentity, describe,
  createInterrupts,
} from '../../../extension/src/interrupt.js';
import { createGate } from '../../../extension/src/gate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.resolve(HERE, '..', '..', '..', 'extension', 'src', 'interrupt.js');

const EXPECTED = { email: 'dest@example.com', orgUuid: 'org-dest-uuid' };
const T0 = 1_760_000_000_000;

// ---------------------------------------------------------------- fakes

function fakeStore(initial) {
  const store = {
    writes: [],
    value: initial,
    failGet: false,
    failSet: false,
    async get() {
      if (store.failGet) throw new Error('storage is unavailable');
      return store.value === undefined ? undefined : JSON.parse(JSON.stringify(store.value));
    },
    async set(v) {
      if (store.failSet) throw new Error('quota exceeded');
      const c = JSON.parse(JSON.stringify(v));
      store.writes.push(c);
      store.value = c;
    },
  };
  return store;
}

function fakeLog() {
  const calls = [];
  const rec = level => (event, msg, data, job) => calls.push({ level, event, msg, data, job });
  return { calls, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function clock(start = T0) {
  let t = start;
  const now = () => t;
  now.advance = ms => { t += ms; };
  now.set = ms => { t = ms; };
  return now;
}

function rep(over = {}) {
  return {
    requestId: 'r7', permit: 'p7', status: 200, ok: true, redirected: false,
    finalPath: '/api/organizations/org-dest-uuid/projects', headers: { 'content-type': 'application/json' },
    elapsedMs: 120, markers: [], method: 'POST', path: '/api/organizations/org-dest-uuid/projects',
    stepKey: 'POST /api/organizations/org-dest-uuid/projects json:abcd1234', attempt: 1,
    ...over,
  };
}

// A Cloudflare-looking HTML error reply; a header given as undefined is removed.
function html(status, over = {}) {
  const { headers: extra = {}, ...rest } = over;
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cf-ray': '8f1a2b3c4d5e6f70-IAD', ...extra };
  for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
  return rep({ status, ok: false, ...rest, headers });
}

// ---------------------------------------------------------------- constants and hygiene

test('constants: the design lists, byte for byte', () => {
  assert.deepEqual(KINDS, ['challenge', 'blocked', 'signed-out', 'wrong-account', 'identity-unknown', 'challenge-page', 'page-reloaded', 'tab-closed']);
  assert.deepEqual(HEADER_ALLOWLIST, ['retry-after', 'content-type', 'content-length', 'cf-mitigated', 'cf-ray', 'server', 'server-timing', 'location', 'date']);
  assert.deepEqual(PAGE_MARKER_SELECTORS, ['#challenge-form', '#challenge-running', '#cf-challenge-running', '.cf-turnstile', 'iframe[src*="challenges.cloudflare.com"]', 'script[src*="challenges.cloudflare.com/turnstile"]', 'script[src*="/cdn-cgi/challenge-platform/"]']);
  assert.deepEqual(ACCOUNT_ENDPOINTS, ['/api/account', '/api/auth/current_account']);
  assert.equal(LOGIN_PATH_RE.source, '^\\/(login|magic-link|oauth|auth)(\\/|$)');
  assert.equal(REDACTED, '[redacted]');
});

test('constants: BODY_MARKERS holds every marker the rules rely on, lowercased', () => {
  const challenge = ['cf-chl-', '__cf_chl', 'cf_chl_opt', 'challenge-platform', '/cdn-cgi/challenge-platform/', 'challenges.cloudflare.com', 'cf-turnstile', 'turnstile', '<title>just a moment', 'checking your browser', 'verify you are human', 'attention required! | cloudflare'];
  assert.deepEqual(CHALLENGE_MARKERS, challenge);
  assert.deepEqual(BLOCKED_MARKERS, ['error code: 1020', 'sorry, you have been blocked', 'access denied']);
  assert.deepEqual(RATE_LIMIT_MARKERS, ['error code: 1015', 'you are being rate limited']);
  assert.deepEqual(BODY_MARKERS, [...challenge, ...BLOCKED_MARKERS, ...RATE_LIMIT_MARKERS]);
  for (const m of BODY_MARKERS) assert.equal(m, m.toLowerCase(), `marker not lowercase: ${m}`);
  assert.equal(new Set(BODY_MARKERS).size, BODY_MARKERS.length, 'no duplicate markers');
});

test('constants: EVIDENCE_KEYS starts with the thirteen design fields', () => {
  const design = ['status', 'headers', 'markers', 'finalPath', 'redirected', 'bodyExcerpt', 'expected', 'actual', 'method', 'path', 'requestId', 'stepKey', 'attempt'];
  assert.deepEqual(EVIDENCE_KEYS.slice(0, design.length), design);
});

test('LOGIN_PATH_RE: the sign-in paths and nothing near them', () => {
  for (const p of ['/login', '/login/', '/login/x', '/magic-link', '/magic-link/abc', '/oauth/authorize', '/auth', '/auth/callback']) {
    assert.ok(LOGIN_PATH_RE.test(p), `should match ${p}`);
  }
  for (const p of ['/loginx', '/api/auth/current_account', '/authors', '/', '/code/project/chan_1', 'login', '/v1/login']) {
    assert.ok(!LOGIN_PATH_RE.test(p), `should not match ${p}`);
  }
});

test('source hygiene: ASCII, LF, and nothing that acts', () => {
  const src = fs.readFileSync(MODULE, 'latin1');
  assert.ok(!/[^\x00-\x7f]/.test(src), 'the module must be plain ASCII');
  assert.ok(!src.includes('\r'), 'the module must use LF endings');
  for (const forbidden of ['document.cookie', 'chrome.', 'fetch(', 'Math.random', 'setTimeout', 'setInterval', 'location.href', 'location.assign', 'location.replace', 'XMLHttpRequest', 'navigator.', 'window.']) {
    assert.ok(!src.includes(forbidden), `the module must not contain ${forbidden}`);
  }
});

// ---------------------------------------------------------------- small tools

test('pathOnly: pathname only, query and fragment removed, relative resolved, junk empty', () => {
  assert.equal(pathOnly('https://claude.ai/login?next=%2Fx#frag'), '/login');
  assert.equal(pathOnly('/magic-link?token=abc'), '/magic-link');
  assert.equal(pathOnly('login'), '/login');
  assert.equal(pathOnly('  /api/organizations  '), '/api/organizations');
  assert.equal(pathOnly('https://other.example/x/y?z'), '/x/y');
  assert.equal(pathOnly(''), '');
  assert.equal(pathOnly('   '), '');
  assert.equal(pathOnly(null), '');
  assert.equal(pathOnly(42), '');
  assert.equal(pathOnly({}), '');
  assert.equal(pathOnly('http://[bad'), '');
});

test('parseRetryAfter: seconds, HTTP-date from a clock, past dates give 0, junk gives null', () => {
  assert.equal(parseRetryAfter('120', T0), 120000);
  assert.equal(parseRetryAfter(' 120 ', T0), 120000);
  assert.equal(parseRetryAfter('0', T0), 0);
  assert.equal(parseRetryAfter('1.5', T0), 1500);
  assert.equal(parseRetryAfter(7, T0), 7000);
  const future = new Date(T0 + 90_000).toUTCString();
  assert.equal(parseRetryAfter(future, T0), 90_000);
  assert.equal(parseRetryAfter(new Date(T0 - 90_000).toUTCString(), T0), 0, 'a date already past: no wait');
  assert.equal(parseRetryAfter(future, undefined), null, 'a date without a clock cannot be measured');
  assert.equal(parseRetryAfter(future, NaN), null);
  assert.equal(parseRetryAfter('-5', T0), null);
  assert.equal(parseRetryAfter('soon', T0), null);
  assert.equal(parseRetryAfter('', T0), null);
  assert.equal(parseRetryAfter(null, T0), null);
  assert.equal(parseRetryAfter(undefined, T0), null);
  assert.equal(parseRetryAfter('86400', T0), 86_400_000, 'never capped here');
});

test('scanBody: markers in order, first 64 KiB only, bytes decoded, non-text empty', () => {
  assert.deepEqual(scanBody('<html><title>Just a Moment...</title><script src="/cdn-cgi/challenge-platform/h/b"></script>'),
    ['challenge-platform', '/cdn-cgi/challenge-platform/', '<title>just a moment']);
  assert.deepEqual(scanBody('Error code: 1020 Sorry, you have been blocked'), ['error code: 1020', 'sorry, you have been blocked']);
  assert.deepEqual(scanBody('nothing here'), []);
  assert.deepEqual(scanBody(''), []);
  const late = 'x'.repeat(64 * 1024 + 40) + 'cf-turnstile';
  assert.deepEqual(scanBody(late), [], 'a marker after 64 KiB is not seen');
  assert.deepEqual(scanBody('x'.repeat(64 * 1024 - 5) + 'cf-turnstile'), ['cf-turnstile', 'turnstile'], 'a marker straddling the limit is seen when it starts inside');
  assert.deepEqual(scanBody(new TextEncoder().encode('<div class="cf-turnstile">')), ['cf-turnstile', 'turnstile']);
  assert.deepEqual(scanBody(new TextEncoder().encode('verify you are human').buffer), ['verify you are human']);
  assert.deepEqual(scanBody(Buffer.from('Access Denied')), ['access denied']);
  assert.deepEqual(scanBody(new Uint8Array([0xff, 0xfe, 0x00, 0x80])), [], 'bytes that are not text have no markers');
  assert.deepEqual(scanBody(null), []);
  assert.deepEqual(scanBody(42), []);
  assert.deepEqual(scanBody({ body: 'turnstile' }), []);
  assert.deepEqual(scanBody(['turnstile']), []);
});

test('pickHeaders: allowlist only, lowercased, location reduced, every input shape', () => {
  const mixed = { 'Content-Type': 'text/html', 'CF-Ray': 'abc', Cookie: 'a=b', 'Set-Cookie': 'x=y', Authorization: 'Bearer zzzzzzzzzzzzzzzzzzzz', 'X-Api-Key': 'k', Location: 'https://claude.ai/login?next=%2F', 'Retry-After': 30 };
  const picked = pickHeaders(mixed);
  assert.deepEqual(picked, { 'content-type': 'text/html', 'cf-ray': 'abc', location: '/login', 'retry-after': '30' });
  assert.deepEqual(pickHeaders(new Headers(mixed)), { 'content-type': 'text/html', 'cf-ray': 'abc', location: '/login', 'retry-after': '30' });
  assert.deepEqual(pickHeaders(new Map([['SERVER', 'cloudflare'], ['cookie', 'no']])), { server: 'cloudflare' });
  assert.deepEqual(pickHeaders([['Date', ' Mon, 05 Oct 2026 14:15:03 GMT '], ['authorization', 'x']]), { date: 'Mon, 05 Oct 2026 14:15:03 GMT' });
  assert.deepEqual(pickHeaders({ get: name => (name === 'cf-mitigated' ? 'challenge' : null) }), { 'cf-mitigated': 'challenge' });
  assert.deepEqual(pickHeaders({ 'content-length': ['12', '34'] }), { 'content-length': '12, 34' });
  assert.deepEqual(pickHeaders({ 'content-length': null, server: undefined }), { 'content-length': '', server: '' });
  assert.deepEqual(pickHeaders({ server: 'x'.repeat(500) }).server.length, 200);
  assert.deepEqual(pickHeaders(null), {});
  assert.deepEqual(pickHeaders(undefined), {});
  assert.deepEqual(pickHeaders('cookie: a=b'), {});
  assert.deepEqual(pickHeaders(42), {});
  assert.deepEqual(pickHeaders({ get: () => { throw new Error('boom'); } }), {}, 'a headers object that throws is treated as empty');
  for (const k of Object.keys(picked)) assert.ok(HEADER_ALLOWLIST.includes(k));
});

test('emailOf: the four field paths, a JSON string, no @ means unknown', () => {
  assert.equal(emailOf({ email_address: ' a@x.io ' }), 'a@x.io');
  assert.equal(emailOf({ email: 'b@x.io' }), 'b@x.io');
  assert.equal(emailOf({ account: { email_address: 'c@x.io' } }), 'c@x.io');
  assert.equal(emailOf({ account: { email: 'd@x.io' } }), 'd@x.io');
  assert.equal(emailOf({ email_address: 'a@x.io', email: 'b@x.io' }), 'a@x.io', 'first path wins');
  assert.equal(emailOf({ email_address: '', account: { email: 'e@x.io' } }), 'e@x.io');
  assert.equal(emailOf('{"email":"f@x.io"}'), 'f@x.io');
  assert.equal(emailOf({ email: 'not an email' }), null);
  assert.equal(emailOf({ email: 42 }), null);
  assert.equal(emailOf({ account: null }), null);
  assert.equal(emailOf({ account: 'g@x.io' }), null);
  assert.equal(emailOf('{bad json'), null);
  assert.equal(emailOf(null), null);
  assert.equal(emailOf([]), null);
  assert.equal(emailOf(undefined), null);
});

// ---------------------------------------------------------------- redaction

test('redactText: every value rule, with a positive and a negative example', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nABC\n-----END RSA PRIVATE KEY-----';
  assert.equal(redactText(`key: ${pem} end`), 'key: [redacted private key] end');
  assert.equal(redactText('-----BEGIN PRIVATE KEY-----\nMIIEowABC and then it was cut'), '[redacted private key]', 'an unpaired BEGIN is cut to the end');
  assert.equal(redactText('key sk-ant-api03-abcdefghij1234 here'), 'key [redacted] here');
  assert.equal(redactText('sk-ant-short'), 'sk-ant-short', 'too short to be a key');
  assert.equal(redactText('ghp_abcdefghijklmnopqrstuvwxyz0123'), REDACTED);
  assert.equal(redactText('github_pat_abcdefghijklmnopqrstuvwxyz'), REDACTED);
  assert.equal(redactText('AKIAABCDEFGHIJKLMNOP'), REDACTED);
  assert.equal(redactText('AKIAabc'), 'AKIAabc');
  assert.equal(redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz=='), 'Authorization: Bearer [redacted]');
  assert.equal(redactText('bearer short'), 'bearer short');
  assert.equal(redactText('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop end'), 'jwt [redacted] end');
  assert.equal(redactText('theme=dark; sessionKey=sk-123abc; lastActiveOrg=org-1'), 'theme=dark; sessionKey=[redacted]; lastActiveOrg=org-1');
  assert.equal(redactText('cf_clearance=abc.def-ghi; __cf_bm=xyz; __Secure-next-auth.session-token=t1; __Host-x=y; csrftoken=q; intercom-session-abc=v'),
    'cf_clearance=[redacted]; __cf_bm=[redacted]; __Secure-next-auth.session-token=[redacted]; __Host-x=[redacted]; csrftoken=[redacted]; intercom-session-abc=[redacted]');
  assert.equal(redactText('ANTHROPIC_API_KEY=sk-ant-x'), 'ANTHROPIC_API_KEY=[redacted]');
  assert.equal(redactText('API_KEY="abcd"'), 'API_KEY=[redacted]');
  assert.equal(redactText('password: hunter2'), 'password: [redacted]');
  assert.equal(redactText('my_token: abc'), 'my_token: abc', 'a value under four characters is not a secret');
  assert.equal(redactText('token limit exceeded'), 'token limit exceeded', 'the word token in prose stays');
  assert.equal(redactText('https://claude.ai/x?key=abc&foo=1&sessionKey=zz&code=q'), 'https://claude.ai/x?key=[redacted]&foo=1&sessionKey=[redacted]&code=[redacted]');
  // The TOKEN= rule runs first and takes the value up to the next whitespace,
  // which in an unbroken URL is the rest of it: over-redaction, never a leak.
  assert.equal(redactText('https://claude.ai/x?token=abc&foo=1'), 'https://claude.ai/x?token=[redacted]');
  assert.equal(redactText('POST /api/x?key=abc json:1234'), 'POST /api/x?key=[redacted] json:1234', 'a stepKey is not a URL and is still cleaned');
  assert.equal(redactText('cf-ray 8f1a2b3c-IAD status 403 /api/organizations/org-1/projects'), 'cf-ray 8f1a2b3c-IAD status 403 /api/organizations/org-1/projects');
  assert.equal(redactText('already API_KEY=[redacted] stays'), 'already API_KEY=[redacted] stays', 'idempotent');
  assert.equal(redactText(redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')), 'Authorization: Bearer [redacted]', 'idempotent');
});

test('redact: secret keys by name and suffix, deep copy, nested arrays, cycles, depth, functions dropped', () => {
  const input = {
    cookie: 'a=b', 'Set-Cookie': 'x', Authorization: 'Bearer x', 'x-api-key': 'k', ANTHROPIC_API_KEY: 'k', sessionKey: 's', session: 's',
    my_token: 't', clientSecret: 's', user_password: 'p', 'cf-ray': 'ray', status: 403, path: '/api/x', stepKey: 'POST /api/x json:1',
    nested: [{ refresh_token: 'r', ok: 'fine sk-ant-abcdefghijkl' }, 'Bearer abcdefghijklmnopqrstuvwxyz', 1, null, () => 1],
    fn: () => 1,
  };
  const out = redact(input);
  assert.equal(out.cookie, REDACTED);
  assert.equal(out['Set-Cookie'], REDACTED);
  assert.equal(out.Authorization, REDACTED);
  assert.equal(out['x-api-key'], REDACTED);
  assert.equal(out.ANTHROPIC_API_KEY, REDACTED);
  assert.equal(out.sessionKey, REDACTED);
  assert.equal(out.session, REDACTED);
  assert.equal(out.my_token, REDACTED);
  assert.equal(out.clientSecret, REDACTED);
  assert.equal(out.user_password, REDACTED);
  assert.equal(out['cf-ray'], 'ray');
  assert.equal(out.status, 403);
  assert.equal(out.path, '/api/x');
  assert.equal(out.stepKey, 'POST /api/x json:1');
  assert.deepEqual(out.nested, [{ refresh_token: REDACTED, ok: 'fine [redacted]' }, 'Bearer [redacted]', 1, null, null]);
  assert.ok(!('fn' in out));
  assert.equal(input.cookie, 'a=b', 'the input is untouched');

  const cyc = { a: 1 };
  cyc.self = cyc;
  assert.deepEqual(redact(cyc), { a: 1, self: '[cycle]' });
  let deep = { v: 'leaf' };
  for (let i = 0; i < 25; i++) deep = { d: deep };
  assert.ok(JSON.stringify(redact(deep)).includes('[deep]'));
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact('sk-ant-abcdefghijkl'), REDACTED);
  assert.equal(redact(5), 5);
  assert.equal(JSON.stringify(redact({ a: undefined, b: 1 })), '{"b":1}');
});

test('reduceEvidence: allowlisted keys only, coerced and clipped, redacted after clipping', () => {
  const ev = reduceEvidence({
    status: '503', headers: { Cookie: 'a=b', 'CF-Mitigated': 'Challenge', 'Content-Type': 'text/html' }, markers: ['turnstile', 7, '', 'x'.repeat(300)],
    finalPath: 'https://claude.ai/login?next=1', redirected: 'yes', bodyExcerpt: 'Bearer abcdefghijklmnopqrstuvwxyz ' + 'y'.repeat(400),
    expected: { email: ' Dest@Example.com ' }, actual: 'other@example.com', method: 'post', path: '/api/x?token=abc', requestId: 12, stepKey: 'POST /api/x?token=abc json:1', attempt: '3',
    error: { name: 'TypeError', message: 'Failed to fetch' }, url: 'https://claude.ai/code/project/c?x=1', title: ' Just a moment... ', hasImporter: false, online: 0,
    phase: 'running', orgs: ['o1', 2, 'o2'], expectedOrg: 'o9', signal: 'markers', elapsedMs: 12.9,
    cookie: 'leak', authorization: 'leak', bodyText: '<html>leak</html>', bodyJson: { error: { message: 'leak' } }, created: { id: 'leak' },
  });
  for (const k of Object.keys(ev)) assert.ok(EVIDENCE_KEYS.includes(k), `unexpected evidence key ${k}`);
  assert.equal(ev.status, 503);
  assert.deepEqual(ev.headers, { 'cf-mitigated': 'Challenge', 'content-type': 'text/html' });
  assert.equal(ev.markers.length, 2);
  assert.equal(ev.markers[0], 'turnstile');
  assert.equal(ev.markers[1].length, 120);
  assert.equal(ev.finalPath, '/login');
  assert.ok(!('redirected' in ev), 'a non-boolean redirected is unknown');
  assert.ok(ev.bodyExcerpt.startsWith('Bearer [redacted] '));
  assert.equal(ev.bodyExcerpt.length, 200);
  assert.equal(ev.expected, 'Dest@Example.com');
  assert.equal(ev.actual, 'other@example.com');
  assert.equal(ev.method, 'POST');
  assert.equal(ev.path, '/api/x');
  assert.equal(ev.requestId, '12');
  assert.equal(ev.stepKey, 'POST /api/x?token=[redacted] json:1');
  assert.equal(ev.attempt, 3);
  assert.deepEqual(ev.error, { name: 'TypeError', message: 'Failed to fetch' });
  assert.equal(ev.url, '/code/project/c');
  assert.equal(ev.title, 'Just a moment...');
  assert.equal(ev.hasImporter, false);
  assert.ok(!('online' in ev));
  assert.equal(ev.phase, 'running');
  assert.deepEqual(ev.orgs, ['o1', 'o2']);
  assert.equal(ev.expectedOrg, 'o9');
  assert.equal(ev.signal, 'markers');
  assert.equal(ev.elapsedMs, 12);
  const flat = JSON.stringify(ev);
  assert.ok(!flat.includes('leak'), `nothing outside the allowlist survives: ${flat}`);
  assert.ok(!flat.includes('a=b'));
});

test('reduceEvidence: empty, junk and null inputs give the minimal shape', () => {
  for (const input of [undefined, null, 42, 'text', [], {}]) {
    assert.deepEqual(reduceEvidence(input), { status: null, headers: {}, markers: [] });
  }
  assert.deepEqual(reduceEvidence({ status: null, attempt: null, elapsedMs: '', redirected: null }), { status: null, headers: {}, markers: [] });
  assert.equal(reduceEvidence({ status: 0 }).status, 0, 'a real status 0 is kept');
  assert.equal(reduceEvidence({ error: 'offline' }).error.message, 'offline');
  const pem = '-----BEGIN EC PRIVATE KEY-----\n' + 'A'.repeat(400) + '\n-----END EC PRIVATE KEY-----';
  assert.equal(reduceEvidence({ bodyExcerpt: pem }).bodyExcerpt, '[redacted private key]', 'a long key is redacted whole, not clipped in half');
});

// ---------------------------------------------------------------- classifyResponse

function kindOf(c) {
  assert.equal(c.verdict, 'interrupt');
  assert.equal(c.interruption.kind, c.kind);
  return c.kind;
}

test('classifyResponse: cf-mitigated: challenge on any status, case-insensitively', () => {
  assert.equal(kindOf(classifyResponse(rep({ status: 403, headers: { 'cf-mitigated': 'challenge' } }))), 'challenge');
  assert.equal(kindOf(classifyResponse(rep({ status: 200, headers: { 'CF-Mitigated': 'Challenge' } }))), 'challenge');
  assert.equal(kindOf(classifyResponse(rep({ status: 503, headers: new Headers({ 'cf-mitigated': ' CHALLENGE ' }) }))), 'challenge');
  const c = classifyResponse(rep({ status: 403, headers: { 'cf-mitigated': 'challenge', 'cf-ray': 'ray1' } }));
  assert.equal(c.evidence.signal, 'cf-mitigated');
  assert.equal(c.evidence.headers['cf-ray'], 'ray1');
  assert.equal(c.interruption.what, 'claude.ai asked this browser to pass a Cloudflare check (HTTP 403, cf-mitigated: challenge).');
  assert.ok(c.interruption.todo.includes('NEW tab'));
  assert.ok(c.interruption.todo.includes('Do not reload the import tab'));
  assert.equal(c.interruption.resumable, true);
  assert.equal(classifyResponse(rep({ status: 403, headers: { 'cf-mitigated': 'managed' } })).verdict, 'pass', 'another cf-mitigated value is not a challenge by itself');
});

test('classifyResponse: 403 or 503 HTML with a challenge marker; same markers on other statuses pass', () => {
  for (const status of [403, 503]) {
    for (const marker of CHALLENGE_MARKERS) {
      const c = classifyResponse(html(status, { markers: [marker] }));
      assert.equal(kindOf(c), 'challenge', `${status} with ${marker}`);
      assert.equal(c.evidence.signal, 'markers');
      assert.deepEqual(c.evidence.markers, [marker]);
    }
  }
  assert.equal(classifyResponse(html(403, { markers: ['turnstile'], headers: { 'cf-ray': undefined } })).kind, 'challenge', 'no cf-ray needed for a challenge');
  assert.equal(classifyResponse(html(500, { markers: ['turnstile'] })).verdict, 'pass');
  assert.equal(classifyResponse(html(403, { markers: ['turnstile'], headers: { 'content-type': 'application/json' } })).verdict, 'pass', 'needs an HTML body');
  assert.equal(classifyResponse(html(403, { markers: [] })).verdict, 'pass', 'a bare 403 HTML page is not a challenge');
  assert.equal(classifyResponse(html(403, { markers: undefined, bodyText: '<title>Just a moment...</title>' })).kind, 'challenge', 'markers are scanned from bodyText when the page did not');
  assert.equal(classifyResponse(html(403, { markers: ['error code: 1020'], headers: { 'cf-ray': undefined } })).verdict, 'pass', 'a block marker alone is not a challenge');
  assert.equal(classifyResponse(rep({ status: 403, headers: { 'content-type': 'TEXT/HTML' }, markers: ['cf-chl-'] })).kind, 'challenge', 'content-type compared case-insensitively');
});

test('classifyResponse: 403 or 503 with server-timing chlray; other statuses pass', () => {
  assert.equal(kindOf(classifyResponse(rep({ status: 403, headers: { 'server-timing': 'chlray;desc="8f1a2b3c"' } }))), 'challenge');
  const c = classifyResponse(rep({ status: 503, headers: { 'Server-Timing': 'cfL4;dur=1, ChlRay;desc=x' } }));
  assert.equal(kindOf(c), 'challenge');
  assert.equal(c.evidence.signal, 'server-timing');
  assert.equal(c.interruption.what, 'claude.ai asked this browser to pass a Cloudflare check (HTTP 503, server-timing: chlray).');
  assert.equal(classifyResponse(rep({ status: 200, headers: { 'server-timing': 'chlray' } })).verdict, 'pass');
  assert.equal(classifyResponse(rep({ status: 403, headers: { 'server-timing': 'cfL4;dur=1' } })).verdict, 'pass');
});

test('classifyResponse: blocked needs 403, HTML, cf-ray and a block marker', () => {
  for (const marker of BLOCKED_MARKERS) {
    const c = classifyResponse(html(403, { markers: [marker] }));
    assert.equal(kindOf(c), 'blocked', marker);
    assert.ok(c.interruption.todo.startsWith('Nothing is retried on its own.'));
  }
  assert.equal(classifyResponse(html(403, { markers: ['error code: 1020'] })).interruption.what, 'Cloudflare refused the request outright (HTTP 403, error 1020).');
  assert.equal(classifyResponse(html(403, { markers: ['access denied'] })).interruption.what, 'Cloudflare refused the request outright (HTTP 403, blocked by Cloudflare).');
  assert.equal(classifyResponse(html(503, { markers: ['error code: 1020'] })).verdict, 'pass', 'only 403');
  assert.equal(classifyResponse(html(403, { markers: ['error code: 1020'], headers: { 'cf-ray': undefined } })).verdict, 'pass', 'needs cf-ray');
  assert.equal(classifyResponse(html(403, { markers: ['error code: 1020'], headers: { 'content-type': 'application/json' } })).verdict, 'pass', 'needs HTML');
  assert.equal(classifyResponse(html(403, { markers: ['error code: 1020', 'cf-chl-'] })).kind, 'challenge', 'a challenge marker on the same page wins, as the design orders');
});

test('classifyResponse: 429 is a slow-down, never an interruption', () => {
  const page = classifyResponse(html(429, { markers: ['error code: 1015'] }));
  assert.equal(page.verdict, 'slow-down');
  assert.equal(page.retryAfterMs, 60000, 'the rate-limit page without Retry-After waits a minute');
  assert.equal(page.evidence.signal, 'rate-limit-page');
  assert.equal(classifyResponse(html(429, { markers: ['you are being rate limited'], headers: { 'retry-after': '120' } })).retryAfterMs, 120000);
  const plain = classifyResponse(rep({ status: 429, ok: false, headers: { 'content-type': 'application/json', 'retry-after': '30' } }));
  assert.equal(plain.verdict, 'slow-down');
  assert.equal(plain.retryAfterMs, 30000);
  assert.equal(plain.evidence.signal, 'status-429');
  assert.equal(classifyResponse(rep({ status: 429, ok: false, headers: { 'content-type': 'application/json' } })).retryAfterMs, null, 'no header: the gate falls back to spacing');
  assert.equal(classifyResponse(rep({ status: 429, ok: false, headers: {} })).retryAfterMs, null);
  assert.equal(classifyResponse(html(429, { markers: ['error code: 1015'], headers: { 'cf-ray': undefined } })).retryAfterMs, null, 'no cf-ray: an ordinary 429');
  const date = new Date(T0 + 45_000).toUTCString();
  assert.equal(classifyResponse(rep({ status: 429, headers: { 'retry-after': date } }), { now: T0 }).retryAfterMs, 45_000, 'an HTTP-date measured from opts.now');
  assert.equal(classifyResponse(rep({ status: 429, headers: { 'retry-after': date }, endedAt: T0 + 5_000 })).retryAfterMs, 40_000, 'or from rep.endedAt');
  assert.equal(classifyResponse(rep({ status: 429, headers: { 'retry-after': date } })).retryAfterMs, null, 'a date with no clock is left to the gate');
  assert.equal(classifyResponse(rep({ status: 429, headers: { 'retry-after': date } }), { now: T0 + 999_999 }).retryAfterMs, 0, 'clock skew: a past date is no wait, never negative');
  assert.ok(!('interruption' in plain));
});

test('classifyResponse: the rate-limit page with an HTTP-date is left to the gate, never cut to a minute', () => {
  // The gate calls classify with neither opts nor endedAt. A 1015 page whose
  // Retry-After is an HTTP-date must then come back null, so that the gate
  // measures the header with its own clock and honours the full wait; the
  // one-minute stand-in is for a page that gives no wait at all.
  const later = new Date(T0 + 10 * 60_000).toUTCString();
  const page = () => html(429, { markers: ['error code: 1015'], headers: { 'retry-after': later } });
  const unmeasured = classifyResponse(page());
  assert.equal(unmeasured.verdict, 'slow-down');
  assert.equal(unmeasured.retryAfterMs, null, 'a date with no clock here: the gate reads the header');
  assert.equal(unmeasured.evidence.signal, 'rate-limit-page');
  assert.equal(unmeasured.evidence.headers['retry-after'], later, 'and the header is in the evidence to read');
  assert.equal(classifyResponse(page(), { now: T0 }).retryAfterMs, 600_000, 'measured when a clock is given');
  assert.equal(classifyResponse({ ...page(), endedAt: T0 + 60_000 }).retryAfterMs, 540_000, 'or from rep.endedAt');
  assert.equal(classifyResponse(page(), { now: T0 + 2 * 600_000 }).retryAfterMs, 0, 'a date already past is no wait');
  assert.equal(classifyResponse(html(429, { markers: ['error code: 1015'], headers: { 'retry-after': '90' } })).retryAfterMs, 90_000, 'delta-seconds need no clock');
  assert.equal(classifyResponse(html(429, { markers: ['error code: 1015'], headers: { 'retry-after': '0' } })).retryAfterMs, 0, 'zero is a wait of zero, not a missing header');
  for (const junk of ['soon', '', '-5', 'Mon']) {
    assert.equal(classifyResponse(html(429, { markers: ['error code: 1015'], headers: { 'retry-after': junk } })).retryAfterMs, 60000, `a header that gives no wait the gate could read either (${JSON.stringify(junk)}): the minute`);
  }
  assert.equal(classifyResponse(html(429, { markers: ['error code: 1015'] })).retryAfterMs, 60000, 'no header: the minute');
  assert.equal(classifyResponse(html(429, { markers: [], headers: { 'retry-after': later } })).retryAfterMs, null, 'an ordinary 429 with a date was always left to the gate');
});

// The real gate on a fake clock, given the module's own classifier.
async function gateFor(now, retryAfterCapMs) {
  const data = { value: undefined };
  const store = { get: async () => data.value, set: async s => { data.value = JSON.parse(JSON.stringify(s)); } };
  const gate = createGate({
    now, wake: () => () => {}, store, config: () => ({ readSpacingMs: 0, writeSpacingMs: 500, retryAfterCapMs }),
    classify: r => classifyResponse(r), log: null, onChange: () => {},
  });
  await gate.load();
  await gate.start('job_1');
  return gate;
}

// One upload through the gate answered by Cloudflare's 1015 page with the
// given Retry-After; what the gate answered and its state afterwards.
async function rateLimitedThroughGate(now, retryAfterCapMs, retryAfter) {
  const gate = await gateFor(now, retryAfterCapMs);
  const path = '/api/organizations/org-dest-uuid/upload';
  const grant = await gate.permit({ requestId: 'r1', stepKey: `POST ${path} form:a:1`, method: 'POST', path, kind: 'script', bodyBytes: 1 });
  assert.equal(grant.ok, true, JSON.stringify(grant));
  now.advance(10);
  const report = html(429, { requestId: 'r1', permit: grant.permit, markers: ['error code: 1015'], headers: { 'retry-after': retryAfter }, finalPath: path, path });
  const answer = await gate.report(report);
  return { answer, snap: gate.snapshot() };
}

test('classifyResponse: a refused sign-in on a memory route passes to the script; every other path still holds', () => {
  const j = { 'content-type': 'application/json' };
  const memory = '/v1/memory_stores/cagt_01MEMORYMEMORYMEMORYMEMORY/memories';
  const channel = '/v1/code/memory/channel/chan_1/memories';
  const auth = { error: { type: 'authentication_error', message: 'invalid x-api-key' } };
  const cases = [
    ['GET', memory], ['GET', `${memory}/mem_01`],
    // The project's own memory route: the export reads it, the import writes it.
    ['GET', channel], ['GET', `${channel}/mem_01`], ['POST', channel],
  ];
  for (const [method, path] of cases) {
    assert.equal(classifyResponse(rep({ status: 401, method, path, headers: j, bodyJson: auth })).verdict, 'pass', path);
    assert.equal(classifyResponse(rep({ status: 403, method, path, headers: j, bodyJson: auth })).verdict, 'pass', path);
    assert.equal(classifyResponse(rep({ status: 403, method, path, headers: j, bodyJson: { error: { reason: 'unauthorized' } } })).verdict, 'pass', path);
  }
  // Only that route: the same answers elsewhere on /v1/ still hold.
  assert.equal(kindOf(classifyResponse(rep({ status: 401, method: 'GET', path: '/v1/code/channels/chan_1/config' }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 403, method: 'GET', path: '/v1/code/channels', headers: j, bodyJson: auth }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 401, method: 'GET', path: '/v1/memory_stores' }))), 'signed-out', 'not the route itself');
  // A challenge or a sign-in redirect on the memory route still stops.
  assert.equal(kindOf(classifyResponse(html(403, { path: memory, headers: { 'cf-mitigated': 'challenge' } }))), 'challenge');
  assert.equal(kindOf(classifyResponse(rep({ status: 200, path: memory, finalPath: '/login', redirected: true }))), 'signed-out');
});

test('through the real gate: a 401 on a memory route is handed back, not held, and the next one is permitted', async () => {
  for (const [method, path] of [
    ['GET', '/v1/memory_stores/cagt_01MEMORYMEMORYMEMORYMEMORY/memories'],
    ['POST', '/v1/code/memory/channel/chan_1/memories'],
  ]) {
    const now = clock();
    const gate = await gateFor(now, 15 * 60_000);
    const grant = await gate.permit({ requestId: 'r1', stepKey: `${method} ${path}`, method, path, kind: 'script', bodyBytes: 0 });
    assert.equal(grant.ok, true, JSON.stringify(grant));
    now.advance(10);
    const answer = await gate.report(rep({
      requestId: 'r1', permit: grant.permit, status: 401, ok: false, method, path, finalPath: path,
      bodyJson: { error: { type: 'authentication_error' } },
    }));
    assert.equal(answer.action, 'pass', path);
    assert.equal(answer.verdict, 'pass', path);
    assert.equal(gate.snapshot().held, null, path);
    const next = await gate.permit({ requestId: 'r2', stepKey: 'GET /v1/code/channels/chan_1/files:list', method: 'GET', path: '/v1/code/channels/chan_1/files:list', kind: 'script', bodyBytes: 0 });
    assert.equal(next.ok, true, JSON.stringify(next));
  }
});

test('through the real gate: a rate-limit page with an HTTP-date sets notBefore to the date, and a long one holds', async () => {
  const now = clock();
  const tenMinutes = new Date(T0 + 10 * 60_000).toUTCString();
  const { answer, snap } = await rateLimitedThroughGate(now, 15 * 60_000, tenMinutes);
  assert.equal(answer.action, 'pass');
  assert.equal(answer.verdict, 'slow-down');
  assert.equal(answer.retryAfterMs, 600_000 - 10, 'the gate measured the date with its own clock');
  assert.equal(snap.notBefore - now(), 600_000 - 10, 'the next request waits for the full ten minutes, not one');
  assert.equal(snap.held, null);

  // A wait beyond the cap is a visible hold, never a re-send after a minute.
  const later = clock();
  const twentyMinutes = new Date(T0 + 20 * 60_000).toUTCString();
  const long = await rateLimitedThroughGate(later, 15 * 60_000, twentyMinutes);
  assert.equal(long.answer.action, 'hold');
  assert.equal(long.answer.reason, 'long-wait');
  assert.equal(long.snap.held.reason, 'long-wait');
  assert.equal(long.snap.notBefore - later(), 20 * 60_000 - 10);

  // Delta-seconds behave the same way through the gate.
  const secs = clock();
  const seconds = await rateLimitedThroughGate(secs, 15 * 60_000, '120');
  assert.equal(seconds.answer.retryAfterMs, 120_000);
  assert.equal(seconds.snap.notBefore - secs(), 120_000);
});

test('classifyResponse: 401 on a gated path is signed-out; elsewhere it passes', () => {
  assert.equal(kindOf(classifyResponse(rep({ status: 401, path: '/api/organizations' }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 401, path: '/v1/code/channels' }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 401, path: undefined, url: 'https://claude.ai/api/account?x=1' }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 401, path: undefined, url: undefined }))), 'signed-out', 'a report without a path is still a gated request');
  assert.equal(classifyResponse(rep({ status: 401, path: '/other' })).verdict, 'pass');
  assert.equal(classifyResponse(rep({ status: 401, path: '/apix/y' })).verdict, 'pass');
  const c = classifyResponse(rep({ status: 401, path: '/api/organizations' }), { expected: EXPECTED });
  assert.equal(c.evidence.signal, 'status-401');
  assert.equal(c.interruption.what, 'This browser is no longer signed in to claude.ai (HTTP 401 or a redirect to the sign-in page).');
  assert.equal(c.interruption.todo, 'Sign in as dest@example.com in a NEW tab of this profile, then press Resume. Do not reload the import tab.');
  assert.ok(classifyResponse(rep({ status: 401, path: '/api/x' })).interruption.todo.includes('Sign in as the destination account'), 'no expected: a plain stand-in');
});

test('classifyResponse: a redirect to the sign-in page is signed-out', () => {
  assert.equal(kindOf(classifyResponse(rep({ status: 200, redirected: true, finalPath: '/login' }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 200, redirected: true, finalPath: 'https://claude.ai/magic-link?token=abc' }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 200, redirected: undefined, finalPath: '/oauth/x' }))), 'signed-out', 'the flag left out, the path differs: a redirect happened');
  assert.equal(classifyResponse(rep({ status: 200, redirected: false, finalPath: '/login' })).verdict, 'pass', 'explicitly not redirected');
  assert.equal(classifyResponse(rep({ status: 200, redirected: true, finalPath: '/api/organizations/org-dest-uuid/projects/' })).verdict, 'pass', 'a redirect elsewhere is nothing');
  assert.equal(classifyResponse(rep({ status: 200, redirected: true, finalPath: '/loginx' })).verdict, 'pass');
  const c = classifyResponse(rep({ status: 200, redirected: true, finalPath: '/magic-link?token=abc' }));
  assert.equal(c.evidence.signal, 'redirect');
  assert.equal(c.evidence.finalPath, '/magic-link', 'the query never reaches the evidence');
  assert.equal(c.evidence.redirected, true);
});

test('classifyResponse: 403 with an authentication error body is signed-out; a permission error passes', () => {
  const j = { 'content-type': 'application/json' };
  assert.equal(kindOf(classifyResponse(rep({ status: 403, headers: j, bodyJson: { error: { type: 'authentication_error', message: 'x' } } }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 403, headers: j, bodyJson: { error: { type: 'unauthenticated' } } }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 403, headers: j, bodyJson: { error: { reason: 'not_authenticated' } } }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 403, headers: j, bodyJson: { error: { reason: 'unauthorized' } } }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 403, headers: j, bodyJson: { error: { message: 'You are not logged in' } } }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 403, headers: j, bodyJson: { error: { message: 'Your session has expired' } } }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 403, headers: j, bodyJson: { error: { message: 'session expired' } } }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 403, headers: j, bodyJson: { error: { message: 'Invalid session.' } } }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 403, headers: j, bodyJson: { error: { message: 'Login required' } } }))), 'signed-out');
  assert.equal(kindOf(classifyResponse(rep({ status: 403, headers: j, bodyJson: { type: 'authentication_error' } }))), 'signed-out', 'the error object may be the body itself');
  assert.equal(classifyResponse(rep({ status: 403, headers: j, bodyJson: { error: { type: 'permission_error', message: 'You do not have permission' } } })).verdict, 'pass', 'a refusal the script records');
  assert.equal(classifyResponse(rep({ status: 403, headers: j, bodyJson: { error: { message: 'Tokens are limited' } } })).verdict, 'pass');
  assert.equal(classifyResponse(rep({ status: 401, path: '/other', headers: j, bodyJson: { error: { type: 'authentication_error' } } })).verdict, 'pass', 'only a 403 reads the body');
  assert.equal(classifyResponse(rep({ status: 403, headers: j, bodyJson: 'authentication_error' })).verdict, 'pass');
  assert.equal(classifyResponse(rep({ status: 403, headers: j, bodyJson: null })).verdict, 'pass');
});

test('classifyResponse: network, pass and the near misses', () => {
  const net = classifyResponse(rep({ status: 0, ok: false, headers: {}, error: { name: 'TypeError', message: 'Failed to fetch' } }));
  assert.equal(net.verdict, 'network');
  assert.deepEqual(net.evidence.error, { name: 'TypeError', message: 'Failed to fetch' });
  assert.equal(net.evidence.signal, 'fetch-error');
  assert.equal(classifyResponse(rep({ status: 0, ok: false, headers: {}, error: { name: 'AbortError', message: 'no reply within 120 seconds' } })).verdict, 'network');
  assert.equal(classifyResponse(rep({ status: 0, ok: false, headers: {} })).verdict, 'pass', 'status 0 without an error is left to the gate, as the table says');
  assert.equal(classifyResponse(rep({ status: 500, ok: false, error: { name: 'x', message: 'y' } })).verdict, 'pass', 'an error with a status is not a network failure');
  assert.equal(classifyResponse(rep()).verdict, 'pass');
  assert.equal(classifyResponse(rep({ status: 503, ok: false, headers: { 'content-type': 'application/json' }, bodyJson: { error: { type: 'overloaded_error' } } })).verdict, 'pass', 'a 5xx JSON from the app is the script\'s business');
  assert.equal(classifyResponse(rep({ status: 500, ok: false, headers: { 'content-type': 'text/html' }, markers: [] })).verdict, 'pass');
  assert.equal(classifyResponse(rep({ status: 404, ok: false })).verdict, 'pass');
  assert.equal(classifyResponse(rep({ status: 403, ok: false, headers: { 'content-type': 'application/json' }, bodyJson: { error: { type: 'permission_error' } } })).verdict, 'pass');
});

test('classifyResponse: tolerant of a report with no headers, odd types and no body; strict about non-objects', () => {
  assert.equal(classifyResponse({}).verdict, 'pass');
  assert.equal(classifyResponse({ status: '401', path: '/api/x' }).kind, 'signed-out', 'a numeric string status');
  assert.equal(classifyResponse({ status: 'four hundred', headers: null, markers: 'turnstile' }).verdict, 'pass');
  assert.equal(classifyResponse({ status: 403, headers: 'cf-mitigated: challenge' }).verdict, 'pass', 'headers as a string are no headers');
  assert.equal(classifyResponse({ status: 403, headers: { 'cf-mitigated': 'challenge' }, markers: null }).kind, 'challenge');
  assert.equal(classifyResponse({ status: 503, headers: { 'content-type': 'text/html' }, markers: { 0: 'turnstile' } }).verdict, 'pass', 'markers must be a list');
  assert.equal(classifyResponse({ status: 403, headers: { 'content-type': 'text/html' }, bodyText: new Uint8Array([1, 2, 3]) }).verdict, 'pass', 'a body that is not text has no markers');
  for (const bad of [null, undefined, 'report', 42, true]) {
    assert.throws(() => classifyResponse(bad), { name: 'TypeError', message: /must be an object/ });
  }
  assert.equal(classifyResponse(rep(), null).verdict, 'pass', 'opts may be null');
  assert.equal(classifyResponse(rep(), 'x').verdict, 'pass');
});

test('classifyResponse: pure, and the evidence holds only allowlisted fields and no body', () => {
  const r = rep({ status: 403, headers: { 'cf-mitigated': 'challenge', cookie: 'a=b', authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' }, bodyExcerpt: 'sk-ant-abcdefghijkl was here', bodyText: '<html>whole body</html>', bodyJson: { error: { message: 'sessionKey=abc' } }, created: { id: 'chan_1' } });
  const before = JSON.stringify(r);
  const c = classifyResponse(r, { expected: EXPECTED });
  assert.equal(JSON.stringify(r), before, 'the report is not changed');
  for (const k of Object.keys(c.evidence)) assert.ok(EVIDENCE_KEYS.includes(k), k);
  for (const k of Object.keys(c.evidence.headers)) assert.ok(HEADER_ALLOWLIST.includes(k), k);
  const flat = JSON.stringify(c);
  assert.ok(!flat.includes('a=b'));
  assert.ok(!flat.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!flat.includes('sk-ant-abc'));
  assert.ok(!flat.includes('whole body'));
  assert.ok(!flat.includes('chan_1'));
  assert.equal(c.evidence.bodyExcerpt, '[redacted] was here');
  assert.equal(c.evidence.expected, 'dest@example.com');
  assert.equal(c.evidence.method, 'POST');
  assert.equal(c.evidence.requestId, 'r7');
  assert.equal(c.evidence.attempt, 1);
  assert.equal(c.evidence.elapsedMs, 120);
  assert.deepEqual(JSON.parse(JSON.stringify(c)), c, 'plain JSON');
});

// ---------------------------------------------------------------- classifyPage

const RUNNING = { phase: 'running', expected: EXPECTED, created: null };

test('classifyPage: the interstitial title, each selector, the sign-in path, and their order', () => {
  const ok = { url: 'https://claude.ai/code/project/chan_1', title: 'Claude', markers: [], hasImporter: true, online: true };
  assert.equal(classifyPage(ok, RUNNING), null);
  assert.equal(classifyPage({ ...ok, title: 'Just a moment...' }, RUNNING).kind, 'challenge-page');
  assert.equal(classifyPage({ ...ok, title: '  just A MOMENT' }, RUNNING).kind, 'challenge-page');
  assert.equal(classifyPage({ ...ok, title: 'Not just a moment' }, RUNNING), null);
  for (const sel of PAGE_MARKER_SELECTORS) {
    const i = classifyPage({ ...ok, markers: [sel] }, RUNNING);
    assert.equal(i.kind, 'challenge-page', sel);
    assert.deepEqual(i.evidence.markers, [sel]);
    assert.equal(i.what, 'The import tab itself is showing a Cloudflare check.');
    assert.equal(i.todo, 'Complete it in that tab. When the page is claude.ai again, press Resume.');
  }
  assert.equal(classifyPage({ ...ok, markers: ['#something-new'] }, RUNNING).kind, 'challenge-page', 'any marker content.js reports stops the import');
  assert.equal(classifyPage({ ...ok, url: 'https://claude.ai/login' }, RUNNING).kind, 'signed-out');
  assert.equal(classifyPage({ ...ok, url: 'https://claude.ai/login?returnTo=%2Fcode' }, RUNNING).kind, 'signed-out');
  assert.equal(classifyPage({ ...ok, url: 'https://claude.ai/magic-link/abc' }, RUNNING).kind, 'signed-out');
  assert.equal(classifyPage({ ...ok, url: '/oauth/authorize' }, RUNNING).kind, 'signed-out');
  assert.equal(classifyPage({ ...ok, url: 'https://claude.ai/loginx' }, RUNNING), null);
  assert.equal(classifyPage({ ...ok, url: 'https://claude.ai/login', markers: ['.cf-turnstile'] }, RUNNING).kind, 'signed-out', 'the sign-in page carries a Turnstile widget: the path wins');
  assert.equal(classifyPage({ ...ok, url: 'https://claude.ai/login', title: 'Just a moment...' }, RUNNING).kind, 'challenge-page', 'the interstitial title is certain and wins');
  const so = classifyPage({ ...ok, url: 'https://claude.ai/login' }, RUNNING);
  assert.equal(so.todo, 'Sign in as dest@example.com in a NEW tab of this profile, then press Resume. Do not reload the import tab.');
  assert.equal(so.evidence.url, '/login');
  assert.equal(so.evidence.phase, 'running');
  assert.equal(so.evidence.expected, 'dest@example.com');
});

test('classifyPage: page-reloaded only while the job is live and the importer is gone', () => {
  const gone = { url: 'https://claude.ai/code', title: 'Claude', markers: [], hasImporter: false, online: true };
  for (const phase of ['ready', 'running', 'held']) {
    const i = classifyPage(gone, { phase, expected: EXPECTED });
    assert.equal(i.kind, 'page-reloaded', phase);
    assert.equal(i.resumable, true);
    assert.equal(i.what, 'The import page went away before anything was created.');
    assert.equal(i.todo, 'Open claude.ai, signed in as dest@example.com, and press Resume: the import starts again from the beginning.');
  }
  for (const phase of ['', 'preflight', 'loading', 'done', 'failed', 'cancelled', 'queued', 'claimed']) {
    assert.equal(classifyPage(gone, { phase, expected: EXPECTED }), null, phase);
  }
  assert.equal(classifyPage({ ...gone, hasImporter: true }, RUNNING), null);
  assert.equal(classifyPage({ ...gone, hasImporter: undefined }, RUNNING), null, 'unknown is not gone');
  assert.equal(classifyPage({ ...gone, hasImporter: 0 }, RUNNING), null);
  assert.equal(classifyPage(gone, 'running').kind, 'page-reloaded', 'a bare phase string');
  assert.equal(classifyPage(gone, undefined), null);
  assert.equal(classifyPage(gone, null), null);
});

test('classifyPage: after a create the page going away is terminal and names the link', () => {
  const gone = { url: 'https://claude.ai/code', title: 'Claude', markers: [], hasImporter: false, online: true };
  for (const job of [
    { phase: 'running', expected: EXPECTED, created: { url: 'https://claude.ai/code/project/chan_9' } },
    { phase: 'held', expected: EXPECTED, createdProject: { url: 'https://claude.ai/code/project/chan_9' } },
    { phase: 'ready', expected: EXPECTED, created_project: { url: 'https://claude.ai/code/project/chan_9' } },
    { phase: 'running', expected: EXPECTED, link: 'https://claude.ai/code/project/chan_9' },
  ]) {
    const i = classifyPage(gone, job);
    assert.equal(i.kind, 'page-reloaded');
    assert.equal(i.resumable, false);
    assert.equal(i.what, 'The page went away after the project was created.');
    assert.equal(i.todo, 'The new project https://claude.ai/code/project/chan_9 exists and holds what was added before that. To start over, delete it, then run cswap project-move import again.');
  }
  assert.equal(classifyPage(gone, { phase: 'running', created: { pending: true } }).resumable, true, 'a create without a url yet is not a created project');
});

test('classifyPage: junk probes do not throw; non-objects do', () => {
  assert.equal(classifyPage({}, RUNNING), null);
  assert.equal(classifyPage({ url: 'http://[bad', title: 42, markers: 'x', hasImporter: 'no', online: null }, RUNNING), null);
  assert.equal(classifyPage({ url: 'https://claude.ai/login', markers: [7, null] }, RUNNING).kind, 'signed-out');
  assert.equal(classifyPage({ title: null, markers: [''] }, RUNNING), null, 'an empty marker string is nothing');
  for (const bad of [null, undefined, 'probe', 7]) assert.throws(() => classifyPage(bad, RUNNING), { name: 'TypeError' });
  const i = classifyPage({ url: 'https://claude.ai/login', title: 'Claude', markers: [], hasImporter: true, online: true, cookie: 'leak', token: 'leak' }, { ...RUNNING, token: 'leak' });
  assert.ok(!JSON.stringify(i).includes('leak'));
  for (const k of Object.keys(i.evidence)) assert.ok(EVIDENCE_KEYS.includes(k), k);
});

// ---------------------------------------------------------------- classifyIdentity

test('classifyIdentity: the right account, in every spelling, is accepted', () => {
  assert.equal(classifyIdentity({ status: 200, email: 'dest@example.com', orgs: ['org-dest-uuid'] }, EXPECTED), null);
  assert.equal(classifyIdentity({ status: 200, email: '  DEST@Example.COM ', orgs: ['org-dest-uuid'] }, EXPECTED), null, 'case and spaces do not matter');
  assert.equal(classifyIdentity({ status: 200, email: 'dest@example.com', orgs: null }, EXPECTED), null, 'the email alone proves it');
  assert.equal(classifyIdentity({ status: 200, email: null, orgs: ['other', 'ORG-DEST-UUID'] }, EXPECTED), null, 'the organization alone proves it, case-insensitively');
  assert.equal(classifyIdentity({ status: 200, email: null, orgs: [{ uuid: 'org-dest-uuid', name: 'x' }] }, EXPECTED), null, 'raw organization rows are read');
  assert.equal(classifyIdentity({ email: 'dest@example.com' }, { email: ' Dest@example.com ', org_uuid: '' }), null);
  assert.equal(classifyIdentity({ email: 'dest@example.com' }, 'dest@example.com'), null, 'expected as a bare email');
});

test('classifyIdentity: signed out on 401, a sign-in redirect, or no organization at all', () => {
  const so = classifyIdentity({ status: 401, email: null, orgs: null }, EXPECTED);
  assert.equal(so.kind, 'signed-out');
  assert.equal(so.todo, 'Sign in as dest@example.com in a NEW tab of this profile, then press Resume. Do not reload the import tab.');
  assert.equal(so.evidence.status, 401);
  assert.equal(classifyIdentity({ status: 200, email: null, orgs: null, finalPath: '/login' }, EXPECTED).kind, 'signed-out');
  assert.equal(classifyIdentity({ status: 200, email: null, orgs: null, finalPath: 'https://claude.ai/magic-link?x=1' }, EXPECTED).kind, 'signed-out');
  assert.equal(classifyIdentity({ status: 200, email: null, orgs: [] }, EXPECTED).kind, 'signed-out');
  assert.equal(classifyIdentity({ status: 401, email: 'dest@example.com', orgs: ['org-dest-uuid'] }, EXPECTED).kind, 'signed-out', 'a 401 wins over a stale email');
  assert.equal(classifyIdentity({ status: 200, email: null, orgs: [7, null, {}] }, EXPECTED).kind, 'identity-unknown', 'a list that holds nothing readable is unknown, not empty');
});

test('classifyIdentity: another account, by email or by the missing organization', () => {
  const i = classifyIdentity({ status: 200, email: 'other@example.com', orgs: ['org-dest-uuid'] }, EXPECTED);
  assert.equal(i.kind, 'wrong-account');
  assert.equal(i.what, 'claude.ai is signed in as other@example.com, not dest@example.com.');
  assert.equal(i.todo, 'Sign out, sign in as dest@example.com (a separate Chrome profile is the easiest way), then press Resume. cswap never switches accounts for you.');
  assert.equal(i.evidence.actual, 'other@example.com');
  assert.equal(i.evidence.expected, 'dest@example.com');
  assert.equal(i.resumable, true);
  const byOrg = classifyIdentity({ status: 200, email: null, orgs: ['org-a', 'org-b'] }, EXPECTED);
  assert.equal(byOrg.kind, 'wrong-account');
  assert.equal(byOrg.what, 'claude.ai is signed in as an account without organization org-dest-uuid, not dest@example.com.');
  assert.deepEqual(byOrg.evidence.orgs, ['org-a', 'org-b']);
  assert.equal(byOrg.evidence.expectedOrg, 'org-dest-uuid');
  assert.equal(byOrg.evidence.signal, undefined, 'no email to prove the account: the sign-in wording stands');
  assert.equal(byOrg.resumable, true);
  assert.ok(byOrg.todo.startsWith('Sign out, sign in as dest@example.com'));
  assert.equal(classifyIdentity({ status: 200, email: 'other@example.com', orgs: null }, { email: 'dest@example.com', orgUuid: '' }).kind, 'wrong-account');
});

test('classifyIdentity: the right email without the registry organization is told to fix cswap, not to sign in again', () => {
  // The design's table makes an org mismatch wrong-account; what differs
  // is what to do, because the person is already signed in as the account
  // the sign-in wording would name, so Resume could never pass.
  const i = classifyIdentity({ status: 200, email: 'dest@example.com', orgs: ['org-a'] }, EXPECTED);
  assert.equal(i.kind, 'wrong-account');
  assert.equal(i.evidence.signal, 'org-missing');
  assert.equal(i.resumable, false, 'no sign-in can change what the registry holds');
  assert.equal(i.what, 'claude.ai is signed in as dest@example.com, which is the right account, but it cannot see organization org-dest-uuid, the one cswap\'s registry holds for it.');
  assert.equal(i.todo, 'Press Cancel, re-add the account with cswap (or correct its organization in cswap\'s registry), then run cswap project-move import again. Signing in again will not help: the account is the right one.');
  assert.ok(!/sign out/i.test(i.todo) && !i.todo.includes('Resume'), 'never told to sign in as the account already signed in');
  assert.equal(i.evidence.actual, 'dest@example.com');
  assert.equal(i.evidence.expected, 'dest@example.com');
  assert.equal(i.evidence.expectedOrg, 'org-dest-uuid');
  assert.deepEqual(i.evidence.orgs, ['org-a']);
  assert.equal(classifyIdentity({ status: 200, email: ' DEST@example.com ', orgs: [{ uuid: 'org-b' }] }, EXPECTED).evidence.signal, 'org-missing', 'the email is compared the usual way');
  assert.equal(classifyIdentity({ status: 200, email: 'dest@example.com', orgs: ['org-a', 'ORG-DEST-UUID'] }, EXPECTED), null, 'listed: accepted');
  assert.equal(classifyIdentity({ status: 200, email: 'dest@example.com', orgs: ['org-a'] }, { email: 'dest@example.com', orgUuid: '' }), null, 'no organization expected: the email is enough');
  assert.equal(classifyIdentity({ status: 200, email: 'dest@example.com', orgs: [7] }, EXPECTED), null, 'an unreadable list proves nothing either way; the email does');
  assert.equal(classifyIdentity({ status: 200, email: 'dest@example.com', orgs: [] }, EXPECTED).kind, 'signed-out', 'an empty list is still signed out');
});

test('classifyIdentity: nothing to compare means the person confirms', () => {
  const u = classifyIdentity({ status: 200, email: null, orgs: null }, EXPECTED);
  assert.equal(u.kind, 'identity-unknown');
  assert.equal(u.what, 'claude.ai did not say which account is signed in.');
  assert.equal(u.todo, 'Check the account in the page\'s menu. If it is dest@example.com, press Confirm; otherwise sign in as dest@example.com first.');
  assert.equal(classifyIdentity({ status: 200, email: null, orgs: ['org-a'] }, { email: 'dest@example.com', orgUuid: '' }).kind, 'identity-unknown', 'organizations known but none expected');
  assert.equal(classifyIdentity({ status: 200, email: null, orgs: null }, { email: 'dest@example.com', orgUuid: 'org-dest-uuid' }).kind, 'identity-unknown', 'org expected but none seen');
  assert.equal(u.evidence.signal, undefined, 'the site answered: the person confirms');
  assert.equal(u.resumable, true);
  const told = classifyIdentity({ status: 200, email: 'who@example.com', orgs: null }, { email: '', orgUuid: '' });
  assert.equal(told.kind, 'identity-unknown', 'an email with nothing to compare it to: the person decides');
  assert.equal(told.what, 'claude.ai is signed in as who@example.com; cswap was not told which account the import is for.');
  assert.ok(told.todo.includes('press Confirm'));
  assert.equal(classifyIdentity({}, EXPECTED).kind, 'identity-unknown');
  assert.equal(classifyIdentity({}, undefined).kind, 'identity-unknown');
  assert.equal(classifyIdentity({ email: 'not-an-email' }, EXPECTED).kind, 'wrong-account', 'a string that is not an email still differs from the expected one');
  for (const bad of [null, undefined, 'me', 1]) assert.throws(() => classifyIdentity(bad, EXPECTED), { name: 'TypeError' });
  const ev = classifyIdentity({ status: 200, email: null, orgs: null, cookie: 'leak', sessionKey: 'leak' }, { ...EXPECTED, token: 'leak' }).evidence;
  for (const k of Object.keys(ev)) assert.ok(EVIDENCE_KEYS.includes(k), k);
  assert.ok(!JSON.stringify(ev).includes('leak'));
});

test('classifyIdentity: an import for whoever is signed in takes any account the page names, until one is recorded', () => {
  const whoever = { email: '', orgUuid: '', flow: 'import', signedIn: true };
  assert.equal(classifyIdentity({ status: 200, email: 'who@example.com', orgs: null }, whoever), null, 'any email is the account');
  assert.equal(classifyIdentity({ status: 200, email: 'who@example.com', orgs: ['org-a'] }, { email: '', org_uuid: '', signed_in: true }), null, 'the wire spelling too');
  const so = classifyIdentity({ status: 401, email: null, orgs: null }, whoever);
  assert.equal(so.kind, 'signed-out');
  assert.equal(so.todo, 'Sign in as the destination account in a NEW tab of this profile, then press Resume. Do not reload the import tab.');
  assert.equal(classifyIdentity({ status: 200, email: null, orgs: [] }, whoever).kind, 'signed-out', 'no organization at all');
  const u = classifyIdentity({ status: 200, email: null, orgs: ['org-a'] }, whoever);
  assert.equal(u.kind, 'identity-unknown', 'no email to take: the person confirms');
  assert.equal(u.what, 'claude.ai did not say which account is signed in.');
  assert.equal(classifyIdentity({ status: 0, email: null, orgs: null }, whoever).evidence.signal, 'probe-failed');
  // Once the account found is recorded as the expected one, it is compared
  // like any other: the copy is made there.
  const recorded = { ...whoever, email: 'who@example.com' };
  assert.equal(classifyIdentity({ status: 200, email: 'Who@Example.com', orgs: null }, recorded), null);
  assert.equal(classifyIdentity({ status: 200, email: 'other@example.com', orgs: null }, recorded).kind, 'wrong-account');
  assert.equal(classifyIdentity({ status: 200, email: null, orgs: null }, recorded).kind, 'identity-unknown');
  assert.equal(classifyIdentity({ status: 200, email: 'who@example.com', orgs: null }, { email: '', orgUuid: '', flow: 'import' }).kind, 'identity-unknown', 'without the flag nothing changes');
  assert.equal(classifyIdentity({ status: 200, email: 'who@example.com', orgs: null }, { ...whoever, orgUuid: 'org-x' }).kind, 'identity-unknown', 'an organization expected is compared as before');
});

test('classifyIdentity: a probe that got no answer asks for Resume, not Confirm', () => {
  // Nothing was asked successfully, so there is nothing to confirm: the
  // kind stays the design's identity-unknown, the evidence says
  // 'probe-failed', and the text asks for the check to be run again.
  const offline = classifyIdentity({ status: 0, email: null, orgs: null, error: { name: 'TypeError', message: 'Failed to fetch' } }, EXPECTED);
  assert.equal(offline.kind, 'identity-unknown');
  assert.equal(offline.evidence.signal, 'probe-failed');
  assert.equal(offline.resumable, true);
  assert.equal(offline.what, 'The account check got no answer from claude.ai (Failed to fetch), so it is not known which account is signed in.');
  assert.equal(offline.todo, 'Check that this browser is online and that https://claude.ai opens in a NEW tab of this profile, then press Resume to run the check again. Do not reload the import tab.');
  assert.ok(!offline.todo.includes('Confirm') && !offline.what.includes('Confirm'));
  assert.deepEqual(offline.evidence.error, { name: 'TypeError', message: 'Failed to fetch' });
  assert.equal(offline.evidence.status, 0);

  const refused = classifyIdentity({ status: 403, email: null, orgs: null }, EXPECTED);
  assert.equal(refused.kind, 'identity-unknown');
  assert.equal(refused.evidence.signal, 'probe-failed');
  assert.equal(refused.what, 'The account check got no answer from claude.ai (HTTP 403), so it is not known which account is signed in.');
  assert.ok(refused.todo.includes('press Resume'));
  const down = classifyIdentity({ status: 503, email: null, orgs: null, error: 'upstream connect error' }, EXPECTED);
  assert.equal(down.evidence.signal, 'probe-failed');
  assert.equal(down.what, 'The account check got no answer from claude.ai (HTTP 503, upstream connect error), so it is not known which account is signed in.');
  assert.equal(classifyIdentity({ status: 404, email: null, orgs: null }, EXPECTED).evidence.signal, 'probe-failed', 'any error status with nothing read');
  assert.equal(classifyIdentity({ status: 0, email: null, orgs: null, error: null }, EXPECTED).evidence.signal, 'probe-failed', 'status 0 is no answer even without an error text');
  const nothing = classifyIdentity({}, EXPECTED);
  assert.equal(nothing.evidence.signal, 'probe-failed', 'no status at all is no answer');
  assert.equal(nothing.what, 'The account check got no answer from claude.ai (no reply), so it is not known which account is signed in.');
  assert.equal(classifyIdentity({ status: 200, email: null, orgs: null, error: 'the account endpoint threw' }, EXPECTED).evidence.signal, 'probe-failed', 'a 200 but the chain threw before anything was read');

  // The near misses: the site did answer, so the design's wording and Confirm stand.
  assert.equal(classifyIdentity({ status: 200, email: null, orgs: null }, EXPECTED).evidence.signal, undefined);
  assert.equal(classifyIdentity({ status: 200, email: null, orgs: ['org-a'] }, { email: 'dest@example.com', orgUuid: '' }).evidence.signal, undefined, 'organizations were read');
  assert.equal(classifyIdentity({ status: 200, email: null, orgs: [7, null] }, EXPECTED).evidence.signal, undefined, 'an unreadable list came from an answer');
  assert.equal(classifyIdentity({ status: 503, email: 'who@example.com', orgs: null }, { email: '', orgUuid: '' }).evidence.signal, undefined, 'an email was read');
  assert.equal(classifyIdentity({ status: 401, email: null, orgs: null, error: 'x' }, EXPECTED).kind, 'signed-out', 'a 401 is signed out before anything else');
  assert.equal(classifyIdentity({ status: 0, email: null, orgs: null, finalPath: '/login' }, EXPECTED).kind, 'signed-out');
  assert.equal(classifyIdentity({ status: 403, email: 'other@example.com', orgs: null }, EXPECTED).kind, 'wrong-account');
});

// ---------------------------------------------------------------- describe

test('describe: every kind names what happened and what to do, with the expected account filled in', () => {
  const ctx = { expected: EXPECTED, actual: 'other@example.com', status: 403, link: '' };
  for (const kind of KINDS) {
    const { what, todo } = describe(kind, ctx);
    assert.ok(what.length > 10 && todo.length > 10, kind);
    assert.ok(what.endsWith('.'), `${kind}: what ends in a full stop`);
    assert.ok(/[.!]$/.test(todo), `${kind}: todo ends in a full stop`);
    assert.ok(!/\bswitch\b/i.test(what + todo), `${kind}: never offers to switch`);
    assert.ok(!/automatic|retry|retries|retried/i.test(todo) || todo.includes('Nothing is retried on its own'), `${kind}: never promises a retry`);
    assert.ok(!/cookie/i.test(what + todo), kind);
  }
  for (const kind of ['signed-out', 'wrong-account', 'identity-unknown', 'page-reloaded', 'tab-closed']) {
    assert.ok(describe(kind, ctx).todo.includes('dest@example.com'), `${kind} names the expected account`);
  }
  assert.ok(describe('wrong-account', ctx).what.includes('other@example.com'));
  assert.equal(describe('wrong-account', ctx).what, 'claude.ai is signed in as other@example.com, not dest@example.com.');
  for (const kind of ['challenge', 'blocked', 'signed-out', 'wrong-account', 'challenge-page', 'page-reloaded']) {
    assert.ok(describe(kind, ctx).todo.includes('Resume'), `${kind} tells the person to press Resume`);
  }
  assert.ok(describe('identity-unknown', ctx).todo.includes('Confirm'));
  assert.equal(describe('tab-closed', { ...ctx, link: 'https://claude.ai/project/p1' }).todo, 'The new project https://claude.ai/project/p1 exists and holds what was added before that. To start over, delete it, then run cswap project-move import again.');
  assert.equal(describe('tab-closed', ctx).what, describe('page-reloaded', ctx).what);
});

test('describe: stand-ins for missing values, the challenge signal, and unknown kinds', () => {
  assert.equal(describe('signed-out').todo, 'Sign in as the destination account in a NEW tab of this profile, then press Resume. Do not reload the import tab.');
  assert.equal(describe('wrong-account', {}).what, 'claude.ai is signed in as another account, not the destination account.');
  assert.equal(describe('challenge', { status: 503 }).what, 'claude.ai asked this browser to pass a Cloudflare check (HTTP 503, cf-mitigated: challenge).');
  assert.equal(describe('challenge', { status: 403, signal: 'markers' }).what, 'claude.ai asked this browser to pass a Cloudflare check (HTTP 403, a challenge page in the reply).');
  assert.equal(describe('challenge', {}).what, 'claude.ai asked this browser to pass a Cloudflare check (cf-mitigated: challenge).');
  assert.equal(describe('blocked', {}).what, 'Cloudflare refused the request outright (HTTP 403, blocked by Cloudflare).');
  assert.equal(describe('blocked', { status: 403, markers: ['error code: 1020'] }).what, 'Cloudflare refused the request outright (HTTP 403, error 1020).');
  assert.equal(describe('identity-unknown', { expected: EXPECTED, signal: 'probe-failed', status: 0, error: 'Failed to fetch' }).what, 'The account check got no answer from claude.ai (Failed to fetch), so it is not known which account is signed in.');
  assert.equal(describe('identity-unknown', { signal: 'probe-failed', status: 502, error: { name: 'Error', message: 'bad gateway' } }).what, 'The account check got no answer from claude.ai (HTTP 502, bad gateway), so it is not known which account is signed in.');
  assert.equal(describe('identity-unknown', { signal: 'probe-failed' }).what, 'The account check got no answer from claude.ai (no reply), so it is not known which account is signed in.');
  assert.ok(describe('identity-unknown', { signal: 'probe-failed' }).todo.includes('press Resume'));
  assert.ok(!describe('identity-unknown', { signal: 'probe-failed' }).todo.includes('Confirm'));
  assert.equal(describe('wrong-account', { expected: EXPECTED, signal: 'org-missing', expectedOrg: 'org-dest-uuid' }).what, 'claude.ai is signed in as dest@example.com, which is the right account, but it cannot see organization org-dest-uuid, the one cswap\'s registry holds for it.');
  assert.equal(describe('wrong-account', { signal: 'org-missing' }).what, 'claude.ai is signed in as the destination account, which is the right account, but it cannot see the organization cswap\'s registry names for it, the one cswap\'s registry holds for it.');
  assert.ok(describe('wrong-account', { signal: 'org-missing' }).todo.startsWith('Press Cancel'));
  assert.ok(!describe('wrong-account', { signal: 'org-missing' }).todo.includes('Resume'));
  assert.equal(describe('wrong-account', { expected: EXPECTED, actual: 'other@example.com', signal: 'something-else' }).what, 'claude.ai is signed in as other@example.com, not dest@example.com.', 'any other signal: the plain wording');
  assert.equal(describe('signed-out', { expected: 'a@b.c' }).todo, describe('signed-out', { expected: { email: 'a@b.c' } }).todo);
  assert.equal(describe('signed-out', null).todo, describe('signed-out').todo);
  assert.equal(describe('signed-out', 'junk').todo, describe('signed-out').todo);
  const odd = describe('something-else', ctxNone());
  assert.equal(odd.what, 'The import stopped (something-else).');
  assert.ok(odd.todo.includes('Resume') && odd.todo.includes('Cancel'));
  assert.equal(describe(undefined).what, 'The import stopped (unknown reason).');
  assert.equal(describe('x'.repeat(100)).what.length, 'The import stopped ().'.length + 40);
  function ctxNone() { return {}; }
});

// ---------------------------------------------------------------- createInterrupts

async function setup({ initial, log = fakeLog(), redact: extra, max, context } = {}) {
  const store = fakeStore(initial);
  const now = clock();
  const interrupts = createInterrupts({ now, store, log, redact: extra, max, context });
  await interrupts.load();
  return { store, now, log, interrupts };
}

test('interrupts: raise fills id, at, texts and evidence, writes before resolving, becomes current', async () => {
  const { store, now, log, interrupts } = await setup();
  assert.equal(interrupts.current(), null);
  assert.deepEqual(interrupts.history(), []);
  assert.deepEqual(store.writes, [], 'load() writes nothing');

  const c = classifyResponse(rep({ status: 403, headers: { 'cf-mitigated': 'challenge', 'cf-ray': 'ray-1' } }), { expected: EXPECTED });
  const i = await interrupts.raise({ ...c.interruption, permit: 'p7', requestId: 'r7', job: 'job_1' });
  assert.equal(i.id, 'i1');
  assert.equal(i.kind, 'challenge');
  assert.equal(i.at, T0);
  assert.equal(i.what, 'claude.ai asked this browser to pass a Cloudflare check (HTTP 403, cf-mitigated: challenge).');
  assert.ok(i.todo.includes('press Resume'));
  assert.equal(i.resumable, true);
  assert.equal(i.permit, 'p7');
  assert.equal(i.requestId, 'r7');
  assert.equal(i.resolvedAt, null);
  assert.equal(i.resolvedBy, null);
  assert.equal(i.evidence.headers['cf-ray'], 'ray-1');
  assert.equal(i.evidence.expected, 'dest@example.com');
  assert.ok(!('ctx' in i), 'the classifier\'s context is consumed, not stored');
  assert.deepEqual(interrupts.current(), i);
  assert.deepEqual(interrupts.history(), [i]);
  assert.deepEqual(interrupts.snapshot(), { current: i, history: [i] });
  assert.equal(store.writes.length, 1, 'persisted before the promise resolved');
  assert.deepEqual(store.value, { version: 1, current: i, history: [i] });
  const warned = log.calls.find(x => x.level === 'warn' && x.event === 'interruption');
  assert.ok(warned, 'logged at warn');
  assert.equal(warned.job, 'job_1');
  assert.equal(warned.data.id, 'i1');
  assert.ok(warned.msg.startsWith('challenge: '));

  now.advance(84_000);
  const cleared = await interrupts.clear('person');
  assert.equal(cleared.id, 'i1');
  assert.equal(cleared.resolvedAt, T0 + 84_000);
  assert.equal(cleared.resolvedBy, 'person');
  assert.equal(interrupts.current(), null);
  assert.equal(interrupts.history()[0].resolvedBy, 'person');
  assert.equal(interrupts.history()[0].resolvedAt, T0 + 84_000);
  assert.equal(store.writes.length, 2);
  assert.equal(store.value.current, null);
  assert.equal(store.value.history[0].resolvedBy, 'person');
});

test('interrupts: a duplicate Resume and a cancel during a wait', async () => {
  const { store, interrupts } = await setup();
  await interrupts.raise({ kind: 'signed-out', status: 401, path: '/api/x' });
  const writes = store.writes.length;
  const cleared = await interrupts.clear('cancel');
  assert.equal(cleared.id, 'i1');
  assert.equal(cleared.resolvedBy, 'cancel');
  assert.equal(interrupts.history()[0].resolvedBy, 'cancel');
  assert.equal(await interrupts.clear('person'), null, 'a second clear changes nothing');
  assert.equal(await interrupts.clear('cancel'), null);
  assert.equal(store.writes.length, writes + 1, 'and writes nothing');
  assert.equal(await interrupts.clear('person'), null, 'nothing current, nothing to clear');
});

test('interrupts: an invalid resolver is recorded as the person, with a warning', async () => {
  const { log, interrupts } = await setup();
  await interrupts.raise({ kind: 'blocked', status: 403 });
  const cleared = await interrupts.clear('robot');
  assert.equal(cleared.resolvedBy, 'person');
  assert.ok(log.calls.some(x => x.level === 'warn' && x.msg.includes('"robot"')));
  await interrupts.raise({ kind: 'blocked', status: 403 });
  assert.equal((await interrupts.clear(undefined)).resolvedBy, 'person');
});

test('interrupts: a second raise while one is current goes to the history only, unless it replaces', async () => {
  const { now, interrupts } = await setup();
  const first = await interrupts.raise({ kind: 'challenge', status: 403 });
  now.advance(1000);
  const second = await interrupts.raise({ kind: 'challenge-page', title: 'Just a moment...' });
  assert.equal(second.id, 'i2');
  assert.equal(interrupts.current().id, 'i1', 'the first stays current');
  assert.deepEqual(interrupts.history().map(e => e.id), ['i1', 'i2']);
  assert.equal(interrupts.history()[1].resolvedBy, null);

  now.advance(1000);
  const third = await interrupts.raise({ kind: 'signed-out', status: 401, replace: true });
  assert.equal(interrupts.current().id, 'i3', 'replace: the new one is current');
  assert.equal(interrupts.current().kind, 'signed-out');
  const old = interrupts.history().find(e => e.id === 'i1');
  assert.equal(old.resolvedBy, 'superseded');
  assert.equal(old.resolvedAt, T0 + 2000);
  assert.equal(interrupts.history().find(e => e.id === 'i2').resolvedBy, null, 'an entry that was never current is left alone');
  assert.equal(first.resolvedBy, null, 'what raise() returned earlier is a copy');
  assert.equal(third.resolvedBy, null);
  const cleared = await interrupts.clear('person');
  assert.equal(cleared.id, 'i3');
  assert.equal(interrupts.current(), null);
});

test('interrupts: a current that no Resume can clear is superseded by the next raise, even after a restart', async () => {
  const { store, now, interrupts } = await setup();
  // Job 1: the page went away after the project was created. The worker
  // raised it with replace and ended the job; nobody cleared the card.
  const gone = await interrupts.raise({ kind: 'tab-closed', link: 'https://claude.ai/code/project/chan_old', replace: true });
  assert.equal(gone.resumable, false);
  assert.equal(interrupts.current().id, gone.id);

  // The worker restarts over the same store; job 2 hits a challenge and
  // raises it the ordinary way, without replace.
  now.advance(60_000);
  const log = fakeLog();
  const next = createInterrupts({ now, store, log });
  await next.load();
  assert.equal(next.current().kind, 'tab-closed', 'the old card survived the restart');
  const challenge = await next.raise({ kind: 'challenge', status: 403, headers: { 'cf-mitigated': 'challenge' } });
  assert.equal(next.current().id, challenge.id, 'the new interruption is what the panel shows');
  assert.equal(next.current().kind, 'challenge');
  assert.ok(next.current().todo.includes('NEW tab'));
  assert.ok(!next.current().todo.includes('chan_old'));
  const old = next.history().find(e => e.id === gone.id);
  assert.equal(old.resolvedBy, 'superseded');
  assert.equal(old.resolvedAt, T0 + 60_000);
  assert.equal(store.value.current.id, challenge.id, 'and the store agrees');
  assert.ok(log.calls.some(x => x.level === 'info' && x.msg.includes('superseded by challenge')));

  // A resumable current is a live hold and is not pushed aside.
  const second = await next.raise({ kind: 'signed-out', status: 401 });
  assert.equal(next.current().id, challenge.id);
  assert.equal(next.history().find(e => e.id === second.id).resolvedBy, null);
  await next.clear('person');

  // The right account without the registry organization is not resumable
  // either, so the next job's card takes its place the same way.
  const mismatch = await next.raise(classifyIdentity({ status: 200, email: 'dest@example.com', orgs: ['org-a'] }, EXPECTED));
  assert.equal(mismatch.resumable, false);
  const fresh = await next.raise({ kind: 'challenge-page', title: 'Just a moment...' });
  assert.equal(next.current().id, fresh.id);
  assert.equal(next.history().find(e => e.id === mismatch.id).resolvedBy, 'superseded');
});

test('interrupts: an interruption of another job supersedes the current one; the same job queues behind it', async () => {
  const { store, now, interrupts } = await setup();
  const first = await interrupts.raise({ kind: 'challenge', status: 403, job: 'job_1' });
  assert.equal(first.job, 'job_1', 'the job is kept on the entry');
  const sameJob = await interrupts.raise({ kind: 'blocked', status: 403, job: 'job_1' });
  assert.equal(interrupts.current().id, first.id, 'the same job: history only');
  const noJob = await interrupts.raise({ kind: 'blocked', status: 403 });
  assert.equal(interrupts.current().id, first.id, 'no job named: nothing is assumed');
  now.advance(5);
  const other = await interrupts.raise({ kind: 'signed-out', status: 401, job: 'job_2' });
  assert.equal(interrupts.current().id, other.id, 'another job: the old card cannot be live');
  assert.equal(interrupts.current().job, 'job_2');
  assert.equal(interrupts.history().find(e => e.id === first.id).resolvedBy, 'superseded');
  assert.equal(interrupts.history().find(e => e.id === first.id).resolvedAt, T0 + 5);
  assert.equal(interrupts.history().find(e => e.id === sameJob.id).resolvedBy, null);
  assert.equal(interrupts.history().find(e => e.id === noJob.id).resolvedBy, null);
  assert.equal(store.value.current.job, 'job_2', 'the job is persisted');

  // The rule holds across a restart, because the job came back from the store.
  const again = createInterrupts({ now, store });
  await again.load();
  assert.equal(again.current().job, 'job_2');
  const third = await again.raise({ kind: 'challenge', status: 403, job: 'job_3' });
  assert.equal(again.current().id, third.id);
  assert.equal(again.history().find(e => e.id === other.id).resolvedBy, 'superseded');
  const sameAgain = await again.raise({ kind: 'blocked', job: 'job_3' });
  assert.equal(again.current().id, third.id);
  assert.equal(again.history().find(e => e.id === sameAgain.id).resolvedBy, null);
  assert.equal((await again.raise({ kind: 'blocked', job: 'x'.repeat(200) })).job.length, 80, 'a job id is clipped');
  assert.equal((await again.raise({ kind: 'blocked', job: 7 })).job, '7', 'a numeric job id is kept as text');
  assert.ok(!('job' in (await again.raise({ kind: 'blocked', job: { id: 'x' } }))), 'anything else is not a job id');
});

test('interrupts: the worker may clear a card as superseded', async () => {
  const { log, store, interrupts } = await setup();
  await interrupts.raise({ kind: 'tab-closed', link: 'https://claude.ai/code/project/chan_1' });
  const cleared = await interrupts.clear('superseded');
  assert.equal(cleared.resolvedBy, 'superseded');
  assert.equal(interrupts.current(), null);
  assert.equal(interrupts.history()[0].resolvedBy, 'superseded');
  assert.equal(store.value.current, null);
  assert.ok(!log.calls.some(x => x.level === 'warn' && x.msg.includes('clear()')), 'a known resolver draws no warning');
  assert.equal(await interrupts.clear('superseded'), null);
});

test('interrupts: the probe-failed and org-missing wording survives raise() and a restart', async () => {
  const context = () => ({ expected: EXPECTED.email, link: '' });
  const { store, now, interrupts } = await setup({ context });
  const offline = classifyIdentity({ status: 0, email: null, orgs: null, error: { name: 'TypeError', message: 'Failed to fetch' } }, EXPECTED);
  const raised = await interrupts.raise(offline);
  assert.equal(raised.kind, 'identity-unknown');
  assert.equal(raised.evidence.signal, 'probe-failed');
  assert.equal(raised.what, offline.what);
  assert.equal(raised.todo, offline.todo);
  assert.ok(raised.todo.includes('press Resume') && !raised.todo.includes('Confirm'));
  assert.equal(raised.resumable, true);
  await interrupts.clear('person');
  // The worker's own shape: a plain kind with the evidence at the top level.
  const plain = await interrupts.raise({ kind: 'identity-unknown', status: 503, signal: 'probe-failed' });
  assert.equal(plain.what, 'The account check got no answer from claude.ai (HTTP 503), so it is not known which account is signed in.');
  assert.ok(plain.todo.includes('press Resume'));
  await interrupts.clear('person');
  const asked = await interrupts.raise({ kind: 'identity-unknown', status: 200 });
  assert.equal(asked.what, 'claude.ai did not say which account is signed in.', 'without the signal, the design\'s wording');
  assert.ok(asked.todo.includes('press Confirm'));
  await interrupts.clear('person');

  const mismatch = classifyIdentity({ status: 200, email: 'dest@example.com', orgs: ['org-a'] }, EXPECTED);
  const held = await interrupts.raise(mismatch);
  assert.equal(held.kind, 'wrong-account');
  assert.equal(held.resumable, false);
  assert.equal(held.what, mismatch.what);
  assert.ok(held.todo.startsWith('Press Cancel'));
  assert.equal(held.evidence.expectedOrg, 'org-dest-uuid');
  assert.equal(held.evidence.signal, 'org-missing');
  const again = createInterrupts({ now, store, context });
  await again.load();
  assert.equal(again.current().resumable, false);
  assert.equal(again.current().todo, held.todo);
  assert.equal(again.current().evidence.signal, 'org-missing');
  await again.clear('cancel');
  const plainMismatch = await again.raise({ kind: 'wrong-account', signal: 'org-missing', expectedOrg: 'org-dest-uuid', actual: 'dest@example.com' });
  assert.equal(plainMismatch.resumable, false, 'the signal alone makes it not resumable');
  assert.equal(plainMismatch.what, held.what);
  assert.equal((await again.raise({ kind: 'wrong-account', signal: 'org-missing', resumable: true, replace: true })).resumable, true, 'an explicit resumable still wins');
});

test('interrupts: the history keeps the newest max entries and ids keep increasing', async () => {
  const { store, interrupts } = await setup({ max: 3 });
  for (let n = 0; n < 5; n++) await interrupts.raise({ kind: 'blocked', status: 403, attempt: n });
  assert.deepEqual(interrupts.history().map(e => e.id), ['i3', 'i4', 'i5']);
  assert.equal(interrupts.current().id, 'i1', 'the current one is kept even when its history entry is gone');
  const cleared = await interrupts.clear('person');
  assert.equal(cleared.resolvedBy, 'person');
  assert.equal(interrupts.current(), null);
  const next = await interrupts.raise({ kind: 'blocked', status: 403 });
  assert.equal(next.id, 'i6', 'ids never repeat');
  assert.deepEqual(store.value.history.map(e => e.id), ['i4', 'i5', 'i6']);
  const { interrupts: defaults } = await setup();
  for (let n = 0; n < 25; n++) await defaults.raise({ kind: 'blocked' });
  assert.equal(defaults.history().length, 20, 'the default cap is 20');
  const { interrupts: odd } = await setup({ max: 0 });
  for (let n = 0; n < 25; n++) await odd.raise({ kind: 'blocked' });
  assert.equal(odd.history().length, 20, 'an impossible max falls back to 20');
});

test('interrupts: a restart over the same store shows the same thing and continues the ids', async () => {
  const { store, now, interrupts } = await setup();
  await interrupts.raise({ kind: 'challenge', status: 403, headers: { 'cf-mitigated': 'challenge' }, permit: 'p9', requestId: 'r9' });
  await interrupts.raise({ kind: 'challenge-page', title: 'Just a moment...' });

  const log2 = fakeLog();
  const again = createInterrupts({ now, store, log: log2 });
  await again.load();
  assert.deepEqual(again.snapshot(), interrupts.snapshot());
  assert.equal(again.current().permit, 'p9');
  assert.ok(!log2.calls.some(x => x.level === 'warn'), 'a clean state is loaded without complaint');
  const third = await again.raise({ kind: 'blocked', status: 403 });
  assert.equal(third.id, 'i3');
  now.advance(5);
  const cleared = await again.clear('person');
  assert.equal(cleared.id, 'i1');

  const third2 = createInterrupts({ now, store });
  await third2.load();
  assert.equal(third2.current(), null);
  assert.equal(third2.history().length, 3);
  assert.equal(third2.history()[0].resolvedBy, 'person');
  assert.equal((await third2.raise({ kind: 'blocked' })).id, 'i4');
  await again.load();
  assert.equal(again.current().id, 'i4', 'load() is a re-read');
});

test('interrupts: corrupt persisted state is repaired, not fatal', async () => {
  const cases = [
    ['a string', 'garbage'],
    ['a number', 42],
    ['a list', [1, 2]],
    ['an object without version', { current: 'x', history: 'y' }],
    ['a wrong version', { version: 2, current: null, history: [] }],
    ['junk entries', { version: 1, current: { nope: true }, history: [null, 'x', 7, { id: 'bad', kind: 'challenge' }, { id: 'i2', kind: '' }] }],
  ];
  for (const [name, initial] of cases) {
    const { interrupts, log, store } = await setup({ initial });
    assert.equal(interrupts.current(), null, name);
    assert.deepEqual(interrupts.history(), [], name);
    assert.ok(log.calls.some(x => x.level === 'warn' && x.msg.includes('repaired')), `${name} is reported`);
    assert.deepEqual(store.writes, [], 'repair writes nothing until the next change');
    const i = await interrupts.raise({ kind: 'blocked', status: 403 });
    assert.equal(i.id, 'i1', name);
  }
  const salvage = await setup({
    initial: {
      version: 1,
      current: { id: 'i7', kind: 'challenge', at: 'yesterday', what: 7, evidence: { cookie: 'leak', status: 403, headers: { cookie: 'leak', 'cf-ray': 'r' } }, resolvedBy: 'robot' },
      history: [{ id: 'i6', kind: 'blocked', at: 5, resolvedAt: 6, resolvedBy: 'person' }, 'junk', { id: 'i7', kind: 'challenge', at: 'yesterday' }],
    },
  });
  const cur = salvage.interrupts.current();
  assert.equal(cur.id, 'i7');
  assert.equal(cur.at, 0, 'an unreadable time becomes 0, never NaN');
  assert.equal(cur.what, '');
  assert.equal(cur.resolvedBy, null);
  assert.deepEqual(cur.evidence, { status: 403, headers: { 'cf-ray': 'r' }, markers: [] });
  assert.ok(!JSON.stringify(salvage.interrupts.snapshot()).includes('leak'));
  assert.deepEqual(salvage.interrupts.history().map(e => e.id), ['i6', 'i7']);
  assert.equal((await salvage.interrupts.raise({ kind: 'blocked' })).id, 'i8');

  const resolved = await setup({ initial: { version: 1, current: { id: 'i1', kind: 'challenge', at: 1, resolvedAt: 2, resolvedBy: 'person' }, history: [] } });
  assert.equal(resolved.interrupts.current(), null, 'a resolved current is a contradiction; the resolution wins');
});

test('interrupts: a store that fails does not take the import down', async () => {
  const log = fakeLog();
  const store = fakeStore({ version: 1, current: null, history: [] });
  store.failGet = true;
  const interrupts = createInterrupts({ now: clock(), store, log });
  await interrupts.load();
  assert.equal(interrupts.current(), null);
  assert.ok(log.calls.some(x => x.level === 'warn' && x.msg.includes('starting empty')));

  store.failSet = true;
  const i = await interrupts.raise({ kind: 'challenge', status: 403 });
  assert.equal(i.id, 'i1');
  assert.equal(interrupts.current().id, 'i1', 'in-memory state stays authoritative');
  assert.ok(log.calls.some(x => x.level === 'error' && x.msg.includes('could not write')));
  const cleared = await interrupts.clear('person');
  assert.equal(cleared.id, 'i1');
  assert.equal(interrupts.current(), null);

  store.failSet = false;
  await interrupts.raise({ kind: 'blocked' });
  assert.equal(store.value.current.id, 'i2', 'the next write carries the whole state');
  assert.equal(store.value.history.length, 2);
});

test('interrupts: writes are serialized and ordered when raises overlap', async () => {
  const { store, interrupts } = await setup();
  const [a, b, c] = await Promise.all([
    interrupts.raise({ kind: 'challenge' }),
    interrupts.raise({ kind: 'blocked' }),
    interrupts.clear('person'),
  ]);
  assert.deepEqual([a.id, b.id], ['i1', 'i2']);
  assert.equal(c.id, 'i1', 'the clear saw the first as current');
  assert.equal(store.value.current, null);
  assert.deepEqual(store.value.history.map(e => [e.id, e.resolvedBy]), [['i1', 'person'], ['i2', null]]);
  assert.equal(store.writes.length, 3);
  assert.deepEqual(store.writes.map(w => w.history.length), [1, 2, 2], 'each write holds everything up to it, in order');
});

test('interrupts: the clock is trusted but never breaks anything', async () => {
  const now = clock();
  const store = fakeStore();
  const interrupts = createInterrupts({ now, store });
  await interrupts.load();
  now.set(NaN);
  assert.equal((await interrupts.raise({ kind: 'blocked' })).at, 0, 'NaN becomes 0');
  now.set(T0);
  await interrupts.clear('person');
  now.set(T0 - 100_000);
  const back = await interrupts.raise({ kind: 'blocked' });
  assert.equal(back.at, T0 - 100_000, 'a clock that went backwards is recorded as it is');
  const cleared = await interrupts.clear('cancel');
  assert.ok(cleared.resolvedAt <= cleared.at + 1);
  const broken = createInterrupts({ now: () => { throw new Error('no clock'); }, store: fakeStore() });
  await broken.load();
  assert.equal((await broken.raise({ kind: 'blocked' })).at, 0);
  const none = createInterrupts({});
  await none.load();
  assert.ok((await none.raise({ kind: 'blocked' })).at > 0, 'without a clock, Date.now');
  assert.equal(none.current().kind, 'blocked', 'without a store, memory');
  const bare = createInterrupts();
  await bare.load();
  assert.equal((await bare.raise({ kind: 'tab-closed' })).kind, 'tab-closed');
});

test('interrupts: the logger is optional and may throw', async () => {
  const store = fakeStore();
  const quiet = createInterrupts({ now: clock(), store });
  await quiet.load();
  assert.equal((await quiet.raise({ kind: 'blocked' })).id, 'i1');
  const loud = createInterrupts({ now: clock(), store: fakeStore(), log: { warn() { throw new Error('log is broken'); }, info() { throw new Error('x'); }, error() { throw new Error('x'); } } });
  await loud.load();
  assert.equal((await loud.raise({ kind: 'blocked' })).id, 'i1');
  assert.equal((await loud.clear('person')).id, 'i1');
  const partial = createInterrupts({ now: clock(), store: fakeStore(), log: { warn: () => {} } });
  await partial.load();
  await partial.raise({ kind: 'blocked' });
  assert.equal((await partial.clear('person')).id, 'i1', 'a logger without info() is fine');
});

test('interrupts: garbage raises still stop, with a warning, and never throw', async () => {
  const { log, interrupts } = await setup();
  for (const junk of [null, undefined, 'challenge', 42, [], {}]) {
    const i = await interrupts.raise(junk);
    assert.equal(i.kind, 'unknown', JSON.stringify(junk));
    assert.equal(i.what, 'The import stopped (unknown reason).');
    assert.equal(i.resumable, true);
    await interrupts.clear('person');
  }
  const custom = await interrupts.raise({ kind: 'power-cut', what: 'The lights went out.', todo: 'Turn them on, then press Resume.' });
  assert.equal(custom.kind, 'power-cut');
  assert.equal(custom.what, 'The lights went out.', 'an unknown kind keeps the texts it brings');
  assert.equal(custom.todo, 'Turn them on, then press Resume.');
  assert.ok(log.calls.some(x => x.level === 'warn' && x.msg.includes('unknown kind "power-cut"')));
  await interrupts.clear('person');
  const known = await interrupts.raise({ kind: 'blocked', what: 'custom', todo: 'custom', status: 403 });
  assert.equal(known.what, 'Cloudflare refused the request outright (HTTP 403, blocked by Cloudflare).', 'a known kind is always worded by describe()');
  const long = await interrupts.raise({ kind: 'x'.repeat(100), what: 'w'.repeat(1000), todo: 't'.repeat(2000) });
  assert.equal(long.kind.length, 40);
  assert.equal(long.what.length, 500);
  assert.equal(long.todo.length, 1000);
});

test('interrupts: the job context fills the texts the classifiers could not', async () => {
  let link = '';
  const context = () => ({ expected: EXPECTED.email, link });
  const { interrupts } = await setup({ context });
  const c = classifyResponse(rep({ status: 401, path: '/api/x' }));
  assert.ok(c.interruption.todo.includes('the destination account'), 'the classifier did not know');
  const i = await interrupts.raise(c.interruption);
  assert.equal(i.todo, 'Sign in as dest@example.com in a NEW tab of this profile, then press Resume. Do not reload the import tab.');
  assert.equal(i.evidence.expected, 'dest@example.com');
  await interrupts.clear('person');

  const gone = await interrupts.raise({ kind: 'tab-closed' });
  assert.equal(gone.resumable, true);
  assert.equal(gone.what, 'The import page went away before anything was created.');
  await interrupts.clear('cancel');
  link = 'https://claude.ai/code/project/chan_2';
  const after = await interrupts.raise({ kind: 'tab-closed' });
  assert.equal(after.resumable, false);
  assert.ok(after.todo.includes('https://claude.ai/code/project/chan_2'));
  await interrupts.clear('cancel');
  const explicit = await interrupts.raise({ kind: 'page-reloaded', link: 'https://claude.ai/project/p9', resumable: true });
  assert.ok(explicit.todo.includes('https://claude.ai/project/p9'), 'an explicit link wins');
  assert.equal(explicit.resumable, true, 'an explicit resumable wins');
  await interrupts.clear('cancel');

  const who = classifyIdentity({ status: 200, email: 'dest@example.com', orgs: ['org-a'] }, EXPECTED);
  const raised = await interrupts.raise(who);
  assert.equal(raised.what, who.what, 'the description of the account seen survives raise()');
  assert.equal(raised.evidence.actual, 'dest@example.com');
  await interrupts.clear('person');

  const throwing = createInterrupts({ now: clock(), store: fakeStore(), context: () => { throw new Error('no job'); } });
  await throwing.load();
  assert.equal((await throwing.raise({ kind: 'signed-out' })).todo, describe('signed-out').todo);
  const odd = createInterrupts({ now: clock(), store: fakeStore(), context: () => 'junk' });
  await odd.load();
  assert.equal((await odd.raise({ kind: 'signed-out' })).todo, describe('signed-out').todo);
});

test('interrupts: evidence never holds a key outside the allowlist, whatever is handed in', async () => {
  const { store, interrupts } = await setup();
  const dirty = {
    kind: 'challenge',
    evidence: {
      status: 403,
      headers: { cookie: 'session=abc', 'set-cookie': 'sessionKey=sk-ant-sid01-abcdefghijkl; Secure', authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', 'x-api-key': 'sk-ant-api03-abcdefghij', 'cf-mitigated': 'challenge', 'cf-ray': 'ray-2', 'CONTENT-TYPE': 'text/html' },
      markers: ['cf-chl-'],
      cookie: 'a=b', token: 't', sessionKey: 'sk', password: 'p', body: '<html>whole body</html>', request: { headers: { authorization: 'x' } },
      bodyExcerpt: 'cf_clearance=abc.def; token: abcdefgh; sk-ant-api03-zzzzzzzzzzzz; ' + 'x'.repeat(300),
      stepKey: 'POST /api/x?sessionKey=abc&token=zzzz json:1',
      finalPath: '/login?token=abc',
    },
  };
  const i = await interrupts.raise(dirty);
  for (const k of Object.keys(i.evidence)) assert.ok(EVIDENCE_KEYS.includes(k), `evidence key ${k}`);
  assert.deepEqual(Object.keys(i.evidence.headers).sort(), ['cf-mitigated', 'cf-ray', 'content-type']);
  assert.equal(i.evidence.stepKey, 'POST /api/x?sessionKey=[redacted]&token=[redacted] json:1');
  assert.equal(i.evidence.finalPath, '/login');
  // The design's TOKEN= rule takes the value up to whitespace, so the ';'
  // after it goes too; that is the rule log.js applies as well.
  assert.ok(i.evidence.bodyExcerpt.startsWith('cf_clearance=[redacted]; token: [redacted] [redacted]; '), i.evidence.bodyExcerpt);
  assert.equal(i.evidence.bodyExcerpt.length, 200);
  const flat = JSON.stringify(store.value);
  for (const secret of ['session=abc', 'sid01', 'abcdefghijklmnopqrstuvwxyz', 'api03', 'a=b', 'whole body', 'abc.def', 'abcdefgh', 'zzzz', '"token"', '"cookie"', 'password']) {
    assert.ok(!flat.includes(secret), `stored state must not contain ${secret}`);
  }
  assert.ok(flat.includes('ray-2'), 'cf-ray is not a secret');
});

test('interrupts: an injected redact() runs on top of the built-in one, and its failure is survived', async () => {
  const seen = [];
  const extra = v => { seen.push(JSON.parse(JSON.stringify(v))); return { ...v, markers: ['scrubbed'] }; };
  const { interrupts } = await setup({ redact: extra });
  const i = await interrupts.raise({ kind: 'challenge', status: 403, headers: { 'cf-mitigated': 'challenge', cookie: 'leak' }, bodyExcerpt: 'sk-ant-abcdefghijklmn' });
  assert.equal(seen.length, 1);
  assert.ok(!JSON.stringify(seen[0]).includes('leak'), 'the injected redact() already sees clean evidence');
  assert.equal(seen[0].bodyExcerpt, REDACTED);
  assert.deepEqual(i.evidence.markers, ['scrubbed'], 'and its result is what is kept');
  const log = fakeLog();
  const { interrupts: fragile } = await setup({ log, redact: () => { throw new Error('bad redact'); } });
  const j = await fragile.raise({ kind: 'challenge', status: 403, headers: { 'cf-mitigated': 'challenge' } });
  assert.equal(j.evidence.headers['cf-mitigated'], 'challenge');
  assert.ok(log.calls.some(x => x.level === 'error' && x.msg.includes('redact')));
  const { interrupts: odd } = await setup({ redact: () => 'not an object' });
  assert.equal((await odd.raise({ kind: 'challenge', status: 403 })).evidence.status, 403, 'a redact() that returns junk is ignored');
});

test('interrupts: what the getters return is a copy', async () => {
  const { interrupts } = await setup();
  const raised = await interrupts.raise({ kind: 'blocked', status: 403 });
  raised.kind = 'changed';
  raised.evidence.status = 1;
  const cur = interrupts.current();
  assert.equal(cur.kind, 'blocked');
  assert.equal(cur.evidence.status, 403);
  cur.kind = 'changed';
  interrupts.history()[0].kind = 'changed';
  interrupts.snapshot().current.kind = 'changed';
  assert.equal(interrupts.current().kind, 'blocked');
  assert.equal(interrupts.history()[0].kind, 'blocked');
  const snap = interrupts.snapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap, 'plain JSON, round-trips');
});

test('end to end: a challenge is raised from a report, survives a restart, and is cleared on Resume', async () => {
  const store = fakeStore();
  const now = clock();
  const context = () => ({ expected: EXPECTED.email, link: '' });
  const worker1 = createInterrupts({ now, store, context });
  await worker1.load();
  const report = html(403, { markers: scanBody('<html><head><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=abc"></script></head><body>window._cf_chl_opt={}</body></html>'), headers: { 'cf-mitigated': 'challenge', 'server-timing': 'chlray;desc="abc"' }, bodyExcerpt: '<html><head><title>Just a moment...</title>' });
  const verdict = classifyResponse(report, { now: now() });
  assert.equal(verdict.verdict, 'interrupt');
  assert.equal(verdict.kind, 'challenge');
  assert.equal(verdict.evidence.signal, 'cf-mitigated', 'the header is the first rule');
  assert.deepEqual(verdict.evidence.markers, ['cf_chl_opt', 'challenge-platform', '/cdn-cgi/challenge-platform/', '<title>just a moment']);
  const raised = await worker1.raise({ ...verdict.interruption, permit: 'p17', requestId: 'r17', job: 'job_1' });
  assert.equal(raised.permit, 'p17');

  // The service worker is ended during the wait and comes back.
  now.advance(10 * 60_000);
  const worker2 = createInterrupts({ now, store, context });
  await worker2.load();
  const current = worker2.current();
  assert.equal(current.id, raised.id);
  assert.equal(current.kind, 'challenge');
  assert.equal(current.permit, 'p17');
  assert.ok(current.todo.includes('NEW tab'));

  // Resume: the probe says the page is still a challenge, so it is replaced.
  const still = classifyPage({ url: 'https://claude.ai/code', title: 'Just a moment...', markers: ['#challenge-running'], hasImporter: true, online: true }, { phase: 'held', expected: EXPECTED });
  assert.equal(still.kind, 'challenge-page');
  const replaced = await worker2.raise({ ...still, replace: true });
  assert.equal(worker2.current().id, replaced.id);
  assert.equal(worker2.history().find(e => e.id === raised.id).resolvedBy, 'superseded');

  // Resume again: the page and the identity are fine, and the gate may go on.
  now.advance(30_000);
  assert.equal(classifyPage({ url: 'https://claude.ai/code', title: 'Claude', markers: [], hasImporter: true, online: true }, { phase: 'held', expected: EXPECTED }), null);
  assert.equal(classifyIdentity({ status: 200, email: emailOf({ account: { email_address: 'Dest@Example.com' } }), orgs: ['org-dest-uuid'] }, EXPECTED), null);
  const cleared = await worker2.clear('person');
  assert.equal(cleared.id, replaced.id);
  assert.equal(cleared.resolvedBy, 'person');
  assert.equal(worker2.current(), null);
  assert.equal(store.value.current, null);
  assert.deepEqual(store.value.history.map(e => e.resolvedBy), ['superseded', 'person']);
});
