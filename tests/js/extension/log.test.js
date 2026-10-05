// Tests of extension/src/log.js: the redaction rules, one positive and one
// negative example each, and the logger's ring, debounce, restart and edge
// cases. Run alone with `node --test tests/js/extension/log.test.js`
// (Node 24). The clock, the timer and the store are fakes; nothing here
// touches chrome.* or waits on real time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEVELS, EVENTS, REDACTED, MAX_DEPTH, MAX_STRING, MAX_BYTES, MIN_BYTES, SECRET_KEY_SET, SECRET_KEY_SUFFIXES,
  SECRET_VALUE_RES, SECRET_QUERY_PARAMS, isSecretKey, redact, redactText, pathOnly, createLogger,
} from '../../../extension/src/log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, '..', '..', '..', 'extension', 'src', 'log.js'), 'utf8');
const CODE = SOURCE.replace(/^\s*\/\/.*$/gm, '');

const T0 = Date.UTC(2026, 9, 5, 14, 15, 3);

// A store like the worker's binding of chrome.storage.local to 'cswap.log'.
function fakeStore(initial) {
  let value = initial;
  const writes = [];
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    writes,
    get: async () => clone(value),
    set: async v => {
      value = clone(v);
      writes.push(clone(v));
    },
    stored: () => clone(value),
  };
}

// A setTimeout the test fires by hand.
function fakeSchedule() {
  const timers = [];
  const schedule = (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  schedule.timers = timers;
  schedule.fire = async () => {
    const due = timers.splice(0, timers.length);
    for (const t of due) t.fn();
    await settle();
  };
  return schedule;
}

// Lets every pending promise in the logger run.
const settle = () => new Promise(r => setImmediate(r));

function makeLogger(opts = {}) {
  const store = fakeStore(opts.stored);
  const schedule = fakeSchedule();
  const clock = { t: T0 };
  const forwarded = [];
  const logger = createLogger({
    now: () => clock.t,
    store,
    schedule,
    forward: r => forwarded.push(r),
    ...opts.logger,
  });
  return { logger, store, schedule, clock, forwarded };
}

// ------------------------------------------------------------ the rules

test('constants and source hygiene', () => {
  assert.deepEqual(LEVELS, ['debug', 'info', 'warn', 'error']);
  assert.equal(REDACTED, '[redacted]');
  assert.ok(EVENTS.includes('request') && EVENTS.includes('interruption') && EVENTS.includes('held') && EVENTS.includes('log'));
  assert.equal(MAX_DEPTH, 20);
  assert.ok(MAX_STRING >= 1000);
  // 20000 records of ~600 chars at 'debug' would be 12 MB, over the 10 MB
  // of chrome.storage.local; the byte bound keeps the ring well under it.
  assert.ok(MAX_BYTES >= 1024 * 1024 && MAX_BYTES <= 4 * 1024 * 1024, 'a byte bound of a few MB');
  assert.ok(MIN_BYTES >= 16 * 1024 && MIN_BYTES < MAX_BYTES);
  for (const k of ['cookie', 'setcookie', 'authorization', 'xapikey', 'sessionkey', 'cfclearance', 'cfbm', 'csrftoken', 'bearer']) {
    assert.ok(SECRET_KEY_SET.has(k), k);
  }
  assert.deepEqual(SECRET_KEY_SUFFIXES, ['token', 'secret', 'password', 'apikey']);
  for (const p of ['token', 'key', 'api_key', 'apikey', 'session', 'sessionKey', 'code', 'state', 'auth', 'access_token', 'refresh_token']) {
    assert.ok(SECRET_QUERY_PARAMS.includes(p), p);
  }
  assert.ok(SECRET_VALUE_RES.length >= 9);
  for (const [re, repl] of SECRET_VALUE_RES) {
    assert.ok(re instanceof RegExp && re.global, `${re} is a global regex`);
    assert.equal(typeof repl, 'string');
  }
  assert.doesNotMatch(SOURCE, /Math\.random/);
  assert.doesNotMatch(CODE, /chrome\./);
  assert.doesNotMatch(CODE, /setTimeout\s*\(/, 'the timer is injected');
  assert.ok(/^[\x00-\x7f]*$/.test(SOURCE), 'log.js is plain ASCII');
  assert.ok(!SOURCE.includes('\r'), 'log.js has LF endings');
});

test('isSecretKey: spelled any way, and the suffixes', () => {
  for (const k of [
    'cookie', 'Cookie', 'Set-Cookie', 'set_cookie', 'setCookie', 'cookies', 'Authorization', 'proxy-authorization',
    'x-api-key', 'X-Api-Key', 'apiKey', 'anthropic-api-key', 'ANTHROPIC_API_KEY', 'sessionKey', 'session_id',
    'session', 'secret', 'password', 'passwd', 'token', 'access_token', 'refreshToken', 'id_token', 'bearer',
    'csrftoken', 'x-csrf-token', 'x-xsrf-token', 'auth-token', 'cf_clearance', '__cf_bm',
    'myToken', 'client_secret', 'db-password', 'OPENAI_APIKEY', 'ROOT_PASSWORD',
  ]) {
    assert.ok(isSecretKey(k), `${k} is a secret key`);
  }
  for (const k of [
    'stepKey', 'cf-ray', 'retry-after', 'content-type', 'content-length', 'status', 'path', 'method',
    'tokens', 'maxTokens', 'email', 'org', 'location', 'server-timing', 'attempt', 'requestId', 'permit',
    'date', 'server', 'elapsedMs', 'markers', 'passthrough', 'secretary',
  ]) {
    assert.ok(!isSecretKey(k), `${k} is not a secret key`);
  }
  assert.ok(!isSecretKey(''));
  assert.ok(isSecretKey(Symbol('token').description));
});

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

test('redactText: every rule, a positive and a negative example', () => {
  const cases = [
    // private key
    [`key:\n${PEM}\nend`, 'key:\n[redacted private key]\nend'],
    ['-----BEGIN PRIVATE KEY-----\nMIIEowABC and then it was cut', '[redacted private key]'],
    ['-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----', '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----'],
    // Anthropic keys and session keys
    ['sk-ant-api03-abcdefgh12345678-xyz_AB', REDACTED],
    ['sessionKey=sk-ant-sid01-ABCDEFGHIJKLMNOP; next', `sessionKey=${REDACTED}; next`],
    ['sk-ant-ab short', 'sk-ant-ab short'],
    // GitHub
    [`token ghp_${'a'.repeat(36)} end`, `token ${REDACTED} end`],
    [`github_pat_${'A'.repeat(22)}_${'b'.repeat(59)}`, REDACTED],
    ['ghp_short and github_pat_short', 'ghp_short and github_pat_short'],
    // AWS
    ['AKIAIOSFODNN7EXAMPLE used', `${REDACTED} used`],
    ['AKIA1234 is too short', 'AKIA1234 is too short'],
    // Bearer
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789==', `Authorization: Bearer ${REDACTED}`],
    ['bearer AbCdEfGhIjKlMnOpQr', `bearer ${REDACTED}`],
    ['Bearer short', 'Bearer short'],
    ['the bearer of bad news', 'the bearer of bad news'],
    // JWT
    [`jwt ${JWT}.`, `jwt ${REDACTED}.`],
    ['eyJabc.def.ghi is not one', 'eyJabc.def.ghi is not one'],
    // cookie-style pairs
    ['theme=dark; sessionKey=abc.def-ghi; lastActiveOrg=1234', `theme=dark; sessionKey=${REDACTED}; lastActiveOrg=1234`],
    ['__cf_bm=abc123; cf_clearance=xyz.1-2.3; csrftoken=qq; __Secure-foo=bar; __Host-x=y; intercom-session-abc=zz',
      `__cf_bm=${REDACTED}; cf_clearance=${REDACTED}; csrftoken=${REDACTED}; __Secure-foo=${REDACTED}; __Host-x=${REDACTED}; intercom-session-abc=${REDACTED}`],
    ['session_key=abcd&x=1', `session_key=${REDACTED}&x=1`],
    ['__Secure-next-auth.session-token=t1; __Host-a.b=c2; end', `__Secure-next-auth.session-token=${REDACTED}; __Host-a.b=${REDACTED}; end`],
    ['theme=dark; lastActiveOrg=dddddddd-1111-2222-3333-444444444444', 'theme=dark; lastActiveOrg=dddddddd-1111-2222-3333-444444444444'],
    // NAME=value and name: value
    ['ANTHROPIC_API_KEY=abcd1234efgh', `ANTHROPIC_API_KEY=${REDACTED}`],
    ['export MY_SECRET="s3cr3t-value"', `export MY_SECRET=${REDACTED}`],
    ["password: 'hunter22'", `password: ${REDACTED}`],
    ['x-api-key: abcdef123456', `x-api-key: ${REDACTED}`],
    ['{"token":"abcd1234","a":1}', `{"token":${REDACTED},"a":1}`],
    ['session-key: abcdef', `session-key: ${REDACTED}`],
    ['API_KEY=[redacted] stays', 'API_KEY=[redacted] stays'],
    ['TOKEN=abc is too short', 'TOKEN=abc is too short'],
    ['stepKey POST /api/organizations/x/projects json:1a2b3c4d', 'stepKey POST /api/organizations/x/projects json:1a2b3c4d'],
    // whole cookie lines in text
    ['cookie: theme=dark; a=b', `cookie: ${REDACTED}`],
    ['Set-Cookie: sessionKey=abc; Path=/; HttpOnly\nnext line kept', `Set-Cookie: ${REDACTED}\nnext line kept`],
    ['page.js contains no cookie substring', 'page.js contains no cookie substring'],
    // URL query and fragment parameters
    ['https://claude.ai/login?returnTo=%2Fnew&token=abc123&x=1', `https://claude.ai/login?returnTo=%2Fnew&token=${REDACTED}&x=1`],
    ['see https://claude.ai/api/x?sessionKey=abc&key=def&api_key=ghi&apikey=jkl&session=mno&code=pqr&state=stu&auth=vwx&access_token=yz&refresh_token=12.',
      `see https://claude.ai/api/x?sessionKey=${REDACTED}&key=${REDACTED}&api_key=${REDACTED}&apikey=${REDACTED}&session=${REDACTED}&code=${REDACTED}&state=${REDACTED}&auth=${REDACTED}&access_token=${REDACTED}&refresh_token=${REDACTED}.`],
    ['https://claude.ai/callback#access_token=abc&type=bearer', `https://claude.ai/callback#access_token=${REDACTED}&type=bearer`],
    ['https://claude.ai/api/x?limit=10&TOKEN=abcd', `https://claude.ai/api/x?limit=10&TOKEN=${REDACTED}`],
    ['https://claude.ai/api/organizations?limit=10&offset=20', 'https://claude.ai/api/organizations?limit=10&offset=20'],
    ['GET /api/x?token=abc123 failed', `GET /api/x?token=${REDACTED} failed`],
    ['/login?returnTo=%2Fproject%2F1&Token=abc', `/login?returnTo=%2Fproject%2F1&Token=${REDACTED}`],
    ['/api/x?limit=5', '/api/x?limit=5'],
    ['chrome-extension://abcdefgh/sidepanel.html?key=abc', `chrome-extension://abcdefgh/sidepanel.html?key=${REDACTED}`],
    ['(https://a.b/c?code=xyz)', `(https://a.b/c?code=${REDACTED})`],
    // untouched diagnostics
    ['cf-ray 8a1b2c3d4e5f6789-IAD status 429 retry-after 120 /api/organizations/dddddddd-1111-2222-3333-444444444444/projects b@example.com',
      'cf-ray 8a1b2c3d4e5f6789-IAD status 429 retry-after 120 /api/organizations/dddddddd-1111-2222-3333-444444444444/projects b@example.com'],
    ['', ''],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactText(input), expected, `redactText(${JSON.stringify(input)})`);
  }
});

test('redactText is idempotent and coerces non-strings', () => {
  const once = redactText(`Bearer abcdefghijklmnopqrstuvwxyz sk-ant-api03-abcdefgh ${JWT} sessionKey=abc API_KEY=abcdef https://x.y/?token=abc`);
  assert.equal(redactText(once), once);
  assert.ok(!once.includes('abcdefgh'));
  assert.equal(redactText(42), '42');
  assert.equal(redactText(null), 'null');
  assert.equal(redactText(undefined), 'undefined');
});

test('redact: header keys and every secret key, whatever the value', () => {
  const out = redact({
    cookie: 'theme=dark',
    'set-cookie': ['a=b', 'c=d'],
    Authorization: 'Bearer x',
    'x-api-key': 'k',
    sessionKey: { nested: 'deep' },
    token: null,
    cookies: 3,
    'cf-ray': '8a1b2c3d4e5f6789-IAD',
    'retry-after': '120',
    'content-type': 'text/html',
    status: 429,
    path: '/api/organizations/dddddddd-1111-2222-3333-444444444444/projects',
    stepKey: 'POST /api/organizations/x/projects json:1a2b3c4d',
    email: 'b@example.com',
  });
  assert.deepEqual(out, {
    cookie: REDACTED,
    'set-cookie': REDACTED,
    Authorization: REDACTED,
    'x-api-key': REDACTED,
    sessionKey: REDACTED,
    token: REDACTED,
    cookies: REDACTED,
    'cf-ray': '8a1b2c3d4e5f6789-IAD',
    'retry-after': '120',
    'content-type': 'text/html',
    status: 429,
    path: '/api/organizations/dddddddd-1111-2222-3333-444444444444/projects',
    stepKey: 'POST /api/organizations/x/projects json:1a2b3c4d',
    email: 'b@example.com',
  });
});

test('redact: strings inside nested arrays and objects', () => {
  const out = redact({
    list: [{ note: 'sk-ant-api03-abcdefgh12345678' }, ['Bearer abcdefghijklmnopqrstuvwxyz', 1, true, null]],
    deeper: { a: { b: { c: `${JWT}` } } },
  });
  assert.deepEqual(out, {
    list: [{ note: REDACTED }, [`Bearer ${REDACTED}`, 1, true, null]],
    deeper: { a: { b: { c: REDACTED } } },
  });
});

test('redact: a cycle, a shared branch, and a value too deep', () => {
  const a = { name: 'a' };
  a.self = a;
  a.list = [a, { back: a }];
  const r = redact(a);
  assert.deepEqual(r, { name: 'a', self: '[cycle]', list: ['[cycle]', { back: '[cycle]' }] });

  const shared = { x: 1 };
  assert.deepEqual(redact({ p: shared, q: shared }), { p: { x: 1 }, q: { x: 1 } }, 'sharing is not a cycle');

  let deep = 'bottom';
  for (let i = 0; i < 30; i++) deep = { d: deep };
  const text = JSON.stringify(redact(deep));
  assert.ok(text.includes('[too deep]'));
  assert.ok(!text.includes('bottom'));

  let ok = 'bottom';
  for (let i = 0; i < MAX_DEPTH - 1; i++) ok = { d: ok };
  assert.ok(JSON.stringify(redact(ok)).includes('bottom'));
});

test('redact: bytes, blobs and bodies that are not text become a size', () => {
  const out = redact({
    body: new Uint8Array([1, 2, 3]),
    buffer: new ArrayBuffer(10),
    view: new DataView(new ArrayBuffer(4)),
    blob: new Blob(['hello']),
    file: new File(['abc'], 'a.txt'),
  });
  assert.deepEqual(out, { body: '<3 bytes>', buffer: '<10 bytes>', view: '<4 bytes>', blob: '<5 bytes>', file: '<3 bytes>' });
});

test('redact: Map, Set, Headers, Error, Date, bigint, function, symbol, undefined', () => {
  const headers = new Headers({ 'Content-Type': 'text/html', Cookie: 'a=b', 'cf-ray': 'ray' });
  const err = new TypeError('Failed to fetch https://claude.ai/?token=abc');
  err.code = 'E1';
  const out = redact({
    map: new Map([['token', 'abc'], ['count', 2]]),
    set: new Set([1, 'sk-ant-api03-abcdefgh12345678']),
    headers,
    err,
    dom: Object.assign(new DOMException('cancelled from the cswap panel', 'AbortError')),
    when: new Date(T0),
    badDate: new Date(NaN),
    big: 10n,
    fn: () => 1,
    sym: Symbol('s'),
    nothing: undefined,
    nul: null,
    re: /x/g,
    arr: [undefined, () => 1],
  });
  assert.deepEqual(out, {
    map: { token: REDACTED, count: 2 },
    set: [1, REDACTED],
    headers: { 'content-type': 'text/html', cookie: REDACTED, 'cf-ray': 'ray' },
    err: { name: 'TypeError', message: `Failed to fetch https://claude.ai/?token=${REDACTED}`, code: 'E1' },
    dom: { name: 'AbortError', message: 'cancelled from the cswap panel', code: 20 },
    when: '2026-10-05T14:15:03.000Z',
    badDate: null,
    big: '10',
    fn: '[function]',
    sym: 'Symbol(s)',
    nul: null,
    re: '/x/g',
    arr: [null, '[function]'],
  });
  assert.ok(!('nothing' in out));
});

test('redact: primitives, nothing, a getter that throws, and no mutation', () => {
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(5), 5);
  assert.equal(redact(true), true);
  assert.equal(redact('sk-ant-api03-abcdefgh12345678'), REDACTED);
  const hostile = { fine: 1, get boom() { throw new Error('no'); } };
  assert.deepEqual(redact(hostile), { fine: 1, boom: '[unreadable]' });
  const input = { cookie: 'a', list: ['sk-ant-api03-abcdefgh12345678'] };
  const frozen = Object.freeze(input);
  const out = redact(frozen);
  assert.equal(input.cookie, 'a');
  assert.equal(input.list[0], 'sk-ant-api03-abcdefgh12345678');
  assert.notEqual(out.list, input.list);
  assert.doesNotThrow(() => JSON.stringify(out));
  assert.deepEqual(redact({ headers: undefined, body: null }), { body: null }, 'a response with no headers');
});

test('pathOnly keeps the path and drops the query', () => {
  assert.equal(pathOnly('https://claude.ai/api/organizations?limit=1#x'), '/api/organizations');
  assert.equal(pathOnly('/api/x?token=abc'), '/api/x');
  assert.equal(pathOnly('api/relative'), '/api/relative');
  assert.equal(pathOnly('https://claude.ai'), '/');
  assert.equal(pathOnly(''), '');
  assert.equal(pathOnly(null), '');
  assert.equal(pathOnly(42), '');
  assert.equal(pathOnly('http://[bad'), '');
});

// ------------------------------------------------------------ the logger

test('log: a record has the shape of the design and is frozen', () => {
  const { logger, clock } = makeLogger();
  clock.t = T0;
  const r = logger.info('gate', 'granted', { permit: 'p1', path: '/api/x' }, 'job_1');
  assert.deepEqual(r, {
    seq: 1, ts: '2026-10-05T14:15:03.000Z', level: 'info', event: 'gate', job: 'job_1',
    msg: 'granted', data: { permit: 'p1', path: '/api/x' },
  });
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.data));
  assert.deepEqual(logger.records(), [r]);
  assert.equal(logger.records()[0], r, 'the same object comes back');
});

test('log: the level filter, and a level set later', async () => {
  const { logger, store } = makeLogger();
  assert.equal(logger.debug('request', 'r'), null);
  assert.equal(logger.log('debug', 'request', 'r'), null);
  assert.ok(logger.info('gate', 'i'));
  assert.ok(logger.warn('gate', 'w'));
  assert.ok(logger.error('gate', 'e'));
  assert.equal(logger.records().length, 3);
  assert.equal(logger.setLevel('debug'), 'debug');
  assert.ok(logger.debug('request', 'kept now'));
  assert.equal(logger.setLevel('nonsense'), 'debug', 'an unknown level changes nothing');
  assert.equal(logger.setLevel('WARN'), 'warn');
  assert.equal(logger.info('gate', 'dropped'), null);
  assert.ok(logger.log('ERROR', 'gate', 'kept'));
  assert.equal(logger.log('bogus', 'gate', 'treated as info'), null);
  logger.setLevel('info');
  assert.equal(logger.log('bogus', 'gate', 'treated as info').level, 'info');
  assert.equal(logger.records().length, 6);
  await settle();
  assert.equal(store.writes.length, 1, 'the three forced writes fold into one snapshot, since all six records were there before the first ran');
  assert.equal(store.writes[0].records.length, 6);
  await logger.flush();
  assert.equal(store.writes.length, 1, 'a flush with nothing new writes nothing');
  logger.info('gate', 'one more');
  await logger.flush();
  assert.equal(store.writes.length, 2);
  assert.equal(store.writes[1].records.length, 7);
  const lvl = createLogger({ level: 'nope' });
  assert.ok(lvl.info('x', 'kept at the default level'));
  assert.equal(lvl.debug('x', 'dropped'), null);
});

test('log: seq rises across clear and across a restart on the same store', async () => {
  const { logger, store } = makeLogger();
  logger.info('a', '1');
  logger.info('a', '2');
  await logger.clear();
  assert.deepEqual(logger.records(), []);
  assert.deepEqual(store.stored(), { version: 1, records: [] });
  const r3 = logger.info('a', '3');
  assert.equal(r3.seq, 3);
  await logger.flush();

  const again = createLogger({ now: () => T0, store, schedule: () => {} });
  await again.load();
  assert.deepEqual(again.records().map(r => r.seq), [3]);
  assert.equal(again.info('a', '4').seq, 4);
  const third = createLogger({ now: () => T0, store, schedule: () => {} });
  await third.load();
  await again.flush();
  assert.deepEqual(third.records().map(r => r.seq), [3], 'a reader that loaded earlier sees what was stored then');
});

test('log: ring by count keeps the newest', () => {
  const { logger } = makeLogger({ logger: { maxRecords: 5 } });
  for (let i = 1; i <= 8; i++) logger.info('a', `m${i}`);
  assert.deepEqual(logger.records().map(r => r.seq), [4, 5, 6, 7, 8]);
  assert.deepEqual(logger.setLimits({ maxRecords: 2 }), { maxRecords: 2, maxAgeMs: 72 * 3600000, maxBytes: MAX_BYTES });
  assert.deepEqual(logger.records().map(r => r.seq), [7, 8]);
  assert.deepEqual(logger.setLimits({ maxRecords: 'nonsense', maxAgeMs: -1, maxBytes: 0 }), { maxRecords: 2, maxAgeMs: 72 * 3600000, maxBytes: MAX_BYTES }, 'bad limits are ignored');
  assert.deepEqual(logger.setLimits({ maxRecords: '3', maxAgeMs: '1000' }), { maxRecords: 3, maxAgeMs: 1000, maxBytes: MAX_BYTES }, 'numeric strings are taken');
  assert.deepEqual(logger.setLimits(), { maxRecords: 3, maxAgeMs: 1000, maxBytes: MAX_BYTES });
});

test('log: ring by bytes keeps the newest, and the newest even when it alone is over', () => {
  const { logger } = makeLogger({ logger: { maxRecords: 20000, maxBytes: 1000 } });
  // Each record is ~120 chars of JSON; a thousand chars holds about eight.
  for (let i = 1; i <= 50; i++) logger.info('a', `m${i}`, { i });
  const kept = logger.records({ limit: 0 });
  const size = JSON.stringify(kept).length;
  assert.ok(size <= 1000, `the ring is ${size} chars`);
  assert.ok(kept.length >= 5 && kept.length < 50, `${kept.length} records fit`);
  assert.equal(kept[kept.length - 1].msg, 'm50');
  assert.equal(kept[0].seq, 51 - kept.length, 'the oldest went, in order');
  const big = logger.info('a', 'x'.repeat(3000));
  assert.deepEqual(logger.records().map(r => r.seq), [big.seq], 'one record over the bound stays, alone');
  assert.deepEqual(logger.setLimits({ maxBytes: 20000 }), { maxRecords: 20000, maxAgeMs: 72 * 3600000, maxBytes: 20000 });
  for (let i = 1; i <= 50; i++) logger.info('a', `n${i}`, { i });
  assert.equal(logger.records({ limit: 0 }).length, 51, 'room again after the bound was raised');
});

test('log: ring by age drops what is older than the retention', () => {
  const { logger, clock } = makeLogger({ logger: { maxAgeMs: 1000 } });
  logger.info('a', 'old');
  clock.t += 600;
  logger.info('a', 'middle');
  clock.t += 600;
  logger.info('a', 'new');
  assert.deepEqual(logger.records().map(r => r.msg), ['middle', 'new'], 'old is 1200 ms old now');
  clock.t += 2000;
  assert.equal(logger.records().length, 2, 'nothing is trimmed until something happens');
  logger.setLimits({});
  assert.deepEqual(logger.records().map(r => r.msg), [], 'setLimits trims at once');
  logger.info('a', 'again');
  assert.equal(logger.records().length, 1);
});

test('log: clock skew keeps seq rising and loses nothing', () => {
  const { logger, clock } = makeLogger({ logger: { maxAgeMs: 10000 } });
  logger.info('a', 'first');
  clock.t -= 5000;
  const back = logger.info('a', 'clock went back');
  clock.t += 60000;
  const ahead = logger.info('a', 'clock jumped ahead');
  assert.deepEqual(logger.records().map(r => [r.seq, r.msg]), [[3, 'clock jumped ahead']], 'the old ones aged out, the new one is kept');
  assert.ok(back.seq < ahead.seq);
  assert.ok(Date.parse(back.ts) < Date.parse(ahead.ts));
  clock.t = NaN;
  const nan = logger.info('a', 'clock says NaN');
  assert.ok(Number.isFinite(Date.parse(nan.ts)), 'the stamp is still a date');
  const broken = createLogger({ now: () => { throw new Error('no clock'); } });
  assert.ok(broken.info('a', 'still logs'));
  const far = createLogger({ now: () => 1e300 });
  assert.ok(Number.isFinite(Date.parse(far.info('a', 'out of range').ts)));
});

test('log: writes are gathered, one store.set for several records', async () => {
  const { logger, store, schedule } = makeLogger({ logger: { flushMs: 500 } });
  logger.info('a', '1');
  logger.info('a', '2');
  logger.info('a', '3');
  assert.equal(schedule.timers.length, 1, 'one timer for three records');
  assert.equal(schedule.timers[0].ms, 500);
  assert.deepEqual(store.writes, []);
  await schedule.fire();
  assert.equal(store.writes.length, 1);
  assert.deepEqual(store.writes[0].records.map(r => r.msg), ['1', '2', '3']);
  assert.equal(store.writes[0].version, 1);
  assert.equal(schedule.timers.length, 0);
  await schedule.fire();
  assert.equal(store.writes.length, 1, 'nothing to write, nothing written');
  logger.info('a', '4');
  assert.equal(schedule.timers.length, 1, 'a new timer after the last one fired');
});

test('log: a warn or an error is written at once and forwarded in order', async () => {
  const { logger, store, schedule, forwarded } = makeLogger();
  logger.info('a', 'quiet');
  const w = logger.warn('interruption', 'challenge', { status: 403 });
  const e = logger.error('gate', 'second create refused');
  assert.deepEqual(forwarded, [w, e]);
  await logger.flush();
  assert.ok(store.writes.length >= 1);
  const last = store.writes[store.writes.length - 1];
  assert.deepEqual(last.records.map(r => r.msg), ['quiet', 'challenge', 'second create refused']);
  await schedule.fire();
  assert.deepEqual(store.stored().records.map(r => r.msg), ['quiet', 'challenge', 'second create refused']);
});

test('log: the forwarder, the timer and the store may fail without a record being lost', async () => {
  // A small snapshot the store refuses was not refused for its size, so
  // the ring is left whole in memory and the next record tries again.
  const store = fakeStore(undefined);
  let fails = 2;
  const good = store.set;
  store.set = async v => {
    if (fails-- > 0) throw new Error('QUOTA_BYTES');
    return good(v);
  };
  const logger = createLogger({
    now: () => T0,
    store,
    schedule: () => { throw new Error('no timers here'); },
    forward: () => { throw new Error('forwarder bug'); },
  });
  assert.ok(logger.info('a', 'timer broke, still logged'));
  assert.ok(logger.warn('a', 'write fails, still logged'));
  await settle();
  assert.deepEqual(store.writes, []);
  assert.ok(logger.error('a', 'write fails again'));
  await settle();
  assert.deepEqual(store.writes, []);
  assert.ok(logger.warn('a', 'write works now'));
  await settle();
  assert.equal(store.writes.length, 1);
  assert.deepEqual(store.writes[0].records.map(r => r.msg), [
    'timer broke, still logged', 'write fails, still logged', 'write fails again', 'write works now',
  ]);
  assert.equal(logger.records().length, 4);
  assert.deepEqual(logger.records({ event: 'log' }), [], 'nothing was dropped, so nothing says so');
  await logger.flush();
  assert.equal(store.writes.length, 1, 'nothing new since, nothing written');
});

// A debug 'request' record of the shape background.js writes, ~250 chars
// of JSON: a thousand of them are over MIN_BYTES several times.
function requestRecord(logger, i) {
  return logger.debug('request', 'POST /api/organizations/dddddddd-1111-2222-3333-444444444444/projects/eeeeeeee-5555-6666-7777-888888888888/docs', {
    status: 200, elapsedMs: 120 + i, attempt: 1, permit: `p${i}`, stepKey: `json:${i}`,
  }, 'job_20261005T141503_a1b2c3');
}

test('log: a store that refuses a big snapshot gets a smaller one, a warn says what was dropped, and a later warn lands', async () => {
  const { logger, store, schedule, forwarded } = makeLogger({ logger: { level: 'debug', maxRecords: 20000 } });
  const LIMIT = 80 * 1024;
  const good = store.set;
  let refused = 0;
  store.set = async v => {
    if (JSON.stringify(v).length > LIMIT) {
      refused++;
      throw new Error('QUOTA_BYTES quota exceeded');
    }
    return good(v);
  };
  for (let i = 1; i <= 1000; i++) requestRecord(logger, i);
  const before = JSON.stringify(logger.records({ limit: 0 })).length;
  assert.ok(before > 2 * LIMIT, `the ring is ${before} chars, well over the store's limit`);

  await schedule.fire();
  assert.equal(refused, 1);
  assert.deepEqual(store.writes, []);
  let kept = logger.records({ limit: 0 });
  assert.equal(kept.length, 501, 'the oldest half went, and one warn was added');
  assert.equal(kept[0].seq, 501, 'the newest half survived in order');
  const notice = kept[kept.length - 1];
  assert.equal(notice.level, 'warn');
  assert.equal(notice.event, 'log');
  assert.equal(notice.seq, 1001);
  assert.match(notice.msg, /storage refused the log; the oldest 500 records were dropped/);
  assert.equal(notice.data.dropped, 500);
  assert.equal(notice.data.droppedTotal, 500);
  assert.equal(notice.data.kept, 500);
  assert.deepEqual(notice.data.error, { name: 'Error', message: 'QUOTA_BYTES quota exceeded' });
  assert.deepEqual(forwarded, [notice], 'the notice is forwarded like any warn');
  assert.equal(schedule.timers.length, 1, 'the next flush is scheduled with the smaller ring');

  let rounds = 0;
  while (store.writes.length === 0 && rounds < 10) {
    await schedule.fire();
    rounds++;
  }
  assert.equal(store.writes.length, 1, `a snapshot fit after ${rounds} more rounds`);
  assert.ok(refused >= 2 && refused <= 4, `${refused} refusals in all`);
  const written = store.writes[0].records;
  assert.ok(JSON.stringify(store.writes[0]).length <= LIMIT);
  assert.equal(written.filter(r => r.event === 'log').length, 1, 'one notice, the latest, not one per refusal');
  const last = written[written.length - 1];
  assert.equal(last.event, 'log');
  assert.equal(last.data.droppedTotal, 1000 - last.data.kept, 'the notice counts every record dropped so far');
  assert.equal(written[written.length - 2].seq, 1000, 'the newest request record is there');
  assert.equal(schedule.timers.length, 0, 'the retries ended');
  const limits = logger.setLimits();
  assert.ok(limits.maxBytes >= MIN_BYTES && limits.maxBytes < MAX_BYTES, 'the byte bound came down to what the store took');

  const w = logger.warn('interruption', 'challenge', { status: 403, 'cf-ray': 'ray-9' });
  await settle();
  assert.equal(store.writes.length, 2);
  const stored = store.stored().records;
  assert.deepEqual(stored[stored.length - 1], w, 'the later warn is persisted');
  assert.equal(w.seq, 1002 + (refused - 1), 'seq kept rising through the notices');
  assert.equal(logger.records({ limit: 0 }).length, stored.length);
});

test('log: a store that refuses everything leaves a small ring whole in memory and stops asking', async () => {
  const { logger, store, schedule } = makeLogger({ logger: { level: 'debug', maxRecords: 20000 } });
  let refused = 0;
  store.set = async () => {
    refused++;
    throw new Error('QUOTA_BYTES quota exceeded');
  };
  for (let i = 1; i <= 1000; i++) requestRecord(logger, i);
  let rounds = 0;
  while (schedule.timers.length && rounds < 20) {
    await schedule.fire();
    rounds++;
  }
  assert.ok(rounds < 20, `the retries ended after ${rounds} rounds`);
  const kept = logger.records({ limit: 0 });
  const size = JSON.stringify(kept).length;
  assert.ok(size <= MIN_BYTES, `the ring is ${size} chars, at most MIN_BYTES`);
  assert.ok(kept.length > 100, `${kept.length} records are still in memory`);
  assert.equal(kept[kept.length - 2].seq, 1000, 'the newest request record is still there');
  assert.equal(kept[kept.length - 1].event, 'log');
  const refusedSoFar = refused;
  const w = logger.warn('interruption', 'challenge', { status: 403 });
  await settle();
  assert.equal(refused, refusedSoFar + 1, 'a warn tries once more');
  assert.equal(logger.records({ limit: 0 }).length, kept.length + 1, 'and nothing is dropped for a refusal that is not about size');
  assert.equal(logger.records().slice(-1)[0], w);
  assert.deepEqual(store.writes, []);
});

test('log: without a store everything stays in memory and nothing throws', async () => {
  const logger = createLogger({ now: () => T0 });
  assert.ok(logger.warn('a', 'w'));
  await logger.flush();
  await logger.load();
  await logger.clear();
  assert.deepEqual(logger.records(), []);
  const odd = createLogger({ store: { get: 'no' } });
  assert.ok(odd.info('a', 'a store without functions is no store'));
});

test('records(): level means at least, event one or several, sinceSeq, limit newest', () => {
  const { logger } = makeLogger({ logger: { level: 'debug' } });
  logger.debug('request', 'd1');
  logger.info('gate', 'i2');
  logger.warn('interruption', 'w3');
  logger.error('gate', 'e4');
  logger.info('wait', 'i5');
  assert.deepEqual(logger.records({ level: 'warn' }).map(r => r.seq), [3, 4]);
  assert.deepEqual(logger.records({ level: 'nope' }).map(r => r.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(logger.records({ event: 'gate' }).map(r => r.seq), [2, 4]);
  assert.deepEqual(logger.records({ event: ['gate', 'wait'] }).map(r => r.seq), [2, 4, 5]);
  assert.deepEqual(logger.records({ sinceSeq: 3 }).map(r => r.seq), [4, 5]);
  assert.deepEqual(logger.records({ limit: 2 }).map(r => r.seq), [4, 5]);
  assert.deepEqual(logger.records({ limit: 0 }).map(r => r.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(logger.records({ limit: -3 }).map(r => r.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(logger.records({ level: 'info', event: 'gate', sinceSeq: 2, limit: 5 }).map(r => r.seq), [4]);
  assert.deepEqual(logger.records({ sinceSeq: 'x' }).map(r => r.seq), [1, 2, 3, 4, 5]);
  const big = createLogger({ now: () => T0, maxRecords: 1000 });
  for (let i = 0; i < 300; i++) big.info('a', `m${i}`);
  assert.equal(big.records().length, 200, 'the default limit is 200');
  assert.equal(big.records()[0].seq, 101);
});

test('exportText(): JSONL, oldest first, every kept record, trailing newline', () => {
  const { logger } = makeLogger();
  assert.equal(logger.exportText(), '');
  for (let i = 0; i < 250; i++) logger.info('a', `m${i}`, { i });
  const text = logger.exportText();
  assert.ok(text.endsWith('\n'));
  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines.length, 250, 'more than the default records() limit');
  const parsed = lines.map(l => JSON.parse(l));
  assert.deepEqual(parsed, logger.records({ limit: 0 }));
  assert.deepEqual(parsed.map(r => r.seq), parsed.map((_, i) => i + 1));
  assert.ok(!text.includes('\n\n'));
});

test('load: stored records come back, seq continues, earlier ones are renumbered after them', async () => {
  const stored = {
    version: 1,
    records: [
      { seq: 7, ts: '2026-10-05T14:00:00.000Z', level: 'info', event: 'job', job: 'job_1', msg: 'claimed', data: { a: 1 } },
      { seq: 9, ts: '2026-10-05T14:01:00.000Z', level: 'warn', event: 'held', job: 'job_1', msg: 'held', data: {} },
    ],
  };
  const { logger, store, schedule } = makeLogger({ stored });
  const early = logger.info('native', 'logged before load');
  assert.equal(early.seq, 1);
  await logger.load();
  assert.deepEqual(logger.records().map(r => [r.seq, r.msg]), [[7, 'claimed'], [9, 'held'], [10, 'logged before load']]);
  assert.equal(early.seq, 1, 'the copy handed out earlier keeps its number');
  assert.equal(logger.info('a', 'after').seq, 11);
  await logger.load();
  assert.equal(logger.records().length, 4, 'load twice changes nothing');
  await schedule.fire();
  await logger.flush();
  assert.deepEqual(store.stored().records.map(r => r.seq), [7, 9, 10, 11]);
});

test('load: a flush before load merges with what is stored instead of wiping it', async () => {
  const stored = { version: 1, records: [{ seq: 3, ts: '2026-10-05T14:00:00.000Z', level: 'info', event: 'job', job: null, msg: 'old', data: {} }] };
  const { logger, store } = makeLogger({ stored });
  logger.warn('a', 'first thing after the worker woke');
  await logger.flush();
  assert.deepEqual(store.stored().records.map(r => [r.seq, r.msg]), [[3, 'old'], [4, 'first thing after the worker woke']]);
});

test('load: corrupt storage is dropped record by record and rewritten clean', async () => {
  const stored = {
    version: 1,
    records: [
      'nonsense',
      null,
      { seq: 'x', ts: '2026-10-05T14:00:00.000Z', level: 'info', event: 'a', msg: 'bad seq' },
      { seq: 2, ts: 'not a date', level: 'info', event: 'a', msg: 'bad ts' },
      { seq: 3, ts: '2026-10-05T14:00:00.000Z', level: 'loud', event: 'a', msg: 'bad level' },
      { seq: 4, ts: '2026-10-05T14:00:00.000Z', level: 'info', event: 'a', msg: 'good', data: { cookie: 'abc', note: 'sk-ant-api03-abcdefgh12345678' } },
      { seq: 4, ts: '2026-10-05T14:00:01.000Z', level: 'info', event: 'a', msg: 'duplicate seq' },
      { seq: 6, ts: '2026-10-05T14:00:02.000Z', level: 'INFO', event: 7, msg: 12, data: 'not an object', job: 5 },
      { seq: 5, ts: '2026-10-05T14:00:01.500Z', level: 'warn', event: 'a', msg: 'out of order' },
    ],
  };
  const { logger, store, schedule } = makeLogger({ stored });
  await logger.load();
  assert.deepEqual(logger.records().map(r => [r.seq, r.level, r.event, r.msg, r.job]), [
    [4, 'info', 'a', 'good', null],
    [5, 'warn', 'a', 'out of order', null],
    [6, 'info', 'unknown', '12', null],
  ]);
  assert.deepEqual(logger.records()[0].data, { cookie: REDACTED, note: REDACTED }, 'stored data is redacted once more');
  assert.deepEqual(logger.records()[2].data, {});
  assert.equal(schedule.timers.length, 1, 'a rewrite is scheduled');
  await schedule.fire();
  assert.equal(store.writes.length, 1);
  assert.equal(store.stored().records.length, 3);
  assert.equal(logger.info('a', 'next').seq, 7);

  for (const garbage of ['text', 5, [], { records: 'no' }, { version: 1 }]) {
    const other = makeLogger({ stored: garbage });
    await other.logger.load();
    assert.deepEqual(other.logger.records(), []);
    await other.schedule.fire();
    assert.deepEqual(other.store.stored(), { version: 1, records: [] }, `${JSON.stringify(garbage)} is replaced`);
  }
  const fresh = makeLogger({ stored: undefined });
  await fresh.logger.load();
  await fresh.schedule.fire();
  assert.deepEqual(fresh.store.writes, [], 'nothing stored means nothing to rewrite');
});

test('load: a store that cannot be read keeps what is in memory, writes nothing over the unknown, and reads again', async () => {
  const stored = { version: 1, records: [{ seq: 3, ts: '2026-10-05T14:00:00.000Z', level: 'warn', event: 'interruption', job: 'job_1', msg: 'earlier evidence', data: {} }] };
  const store = fakeStore(stored);
  const good = store.get;
  let reads = 0;
  store.get = async () => { reads++; throw new Error('storage gone'); };
  const logger = createLogger({ now: () => T0, store, schedule: () => {} });
  logger.info('a', 'kept');
  await logger.load();
  assert.equal(reads, 1);
  assert.deepEqual(logger.records().map(r => r.msg), ['kept']);
  logger.warn('a', 'the interruption that made the restart matter');
  await settle();
  await logger.flush();
  assert.equal(reads, 3, 'each flush reads again first');
  assert.deepEqual(store.writes, [], 'nothing is written while what is stored is unknown');
  assert.deepEqual(store.stored(), stored, 'the earlier evidence is still there');
  assert.deepEqual(logger.records().map(r => r.msg), ['kept', 'the interruption that made the restart matter'], 'memory keeps everything');

  store.get = good;
  logger.warn('a', 'the store answers again');
  await settle();
  assert.equal(reads, 3, 'the read that worked is not repeated');
  assert.equal(store.writes.length, 1);
  assert.deepEqual(store.stored().records.map(r => [r.seq, r.msg]), [
    [3, 'earlier evidence'], [4, 'kept'], [5, 'the interruption that made the restart matter'], [6, 'the store answers again'],
  ], 'the stored log and this context\'s records were merged, renumbered after what was stored');
  await logger.load();
  await logger.flush();
  assert.equal(store.writes.length, 1, 'nothing merged twice, nothing written twice');
});

test('load: a store that cannot be read can still be cleared, and the clear is not undone by a later read', async () => {
  const stored = { version: 1, records: [{ seq: 3, ts: '2026-10-05T14:00:00.000Z', level: 'info', event: 'a', job: null, msg: 'old', data: {} }] };
  const store = fakeStore(stored);
  const good = store.get;
  store.get = async () => { throw new Error('storage gone'); };
  const logger = createLogger({ now: () => T0, store, schedule: () => {} });
  logger.info('a', 'before');
  await logger.clear();
  assert.deepEqual(logger.records(), []);
  assert.deepEqual(store.stored(), { version: 1, records: [] }, 'an empty log is the point, whatever was there');
  store.get = good;
  const after = logger.info('a', 'after');
  await logger.flush();
  assert.deepEqual(store.stored().records.map(r => r.msg), ['after']);
  assert.equal(after.seq, 2, 'seq went on from this context, since what was stored was never read');
  await logger.load();
  assert.deepEqual(logger.records().map(r => r.msg), ['after'], 'no read was owed, so the old record did not come back');

  // The same store, but the clear's own write fails too: memory is empty,
  // and the next record is written once the store takes it.
  const stubborn = fakeStore(stored);
  stubborn.get = async () => { throw new Error('storage gone'); };
  const goodSet = stubborn.set;
  stubborn.set = async () => { throw new Error('storage gone'); };
  const other = createLogger({ now: () => T0, store: stubborn, schedule: () => {} });
  other.info('a', 'before');
  await other.clear();
  assert.deepEqual(other.records(), []);
  assert.deepEqual(stubborn.writes, []);
  stubborn.set = goodSet;
  other.warn('a', 'after');
  await settle();
  assert.deepEqual(stubborn.stored().records.map(r => r.msg), ['after']);
});

test('load: stored records older than the retention are dropped on the way in', async () => {
  const stored = {
    version: 1,
    records: [
      { seq: 1, ts: new Date(T0 - 100 * 3600000).toISOString(), level: 'info', event: 'a', msg: 'stale', data: {} },
      { seq: 2, ts: new Date(T0 - 1000).toISOString(), level: 'info', event: 'a', msg: 'fresh', data: {} },
    ],
  };
  const { logger, schedule, store } = makeLogger({ stored });
  await logger.load();
  assert.deepEqual(logger.records().map(r => r.msg), ['fresh']);
  await schedule.fire();
  assert.deepEqual(store.stored().records.map(r => r.msg), ['fresh']);
});

test('log: data of any shape, and strings clipped', () => {
  const { logger } = makeLogger();
  assert.deepEqual(logger.info('a', 'string data', 'just text').data, { value: 'just text' });
  assert.deepEqual(logger.info('a', 'array data', [1, 'sk-ant-api03-abcdefgh12345678']).data, { value: [1, REDACTED] });
  assert.deepEqual(logger.info('a', 'error data', new RangeError('too big')).data, { name: 'RangeError', message: 'too big' });
  assert.deepEqual(logger.info('a', 'nothing').data, {});
  assert.deepEqual(logger.info('a', 'null', null).data, {});
  assert.deepEqual(logger.info('a', 'number', 5).data, { value: 5 });
  assert.deepEqual(logger.info('a', 'bytes', { body: new Uint8Array(70000) }).data, { body: '<70000 bytes>' });
  const long = 'x'.repeat(MAX_STRING + 100);
  const r = logger.info('a', long, { text: long });
  assert.equal(r.msg.length, MAX_STRING + '...[clipped 100 chars]'.length);
  assert.ok(r.msg.endsWith('...[clipped 100 chars]'));
  assert.ok(r.data.text.endsWith('...[clipped 100 chars]'));
  assert.equal(logger.info(7, 8, 9).event, 'unknown');
  assert.equal(logger.info('', 'empty event').event, 'unknown');
  assert.equal(logger.info('a'.repeat(100), 'long event').event.length, 40);
  assert.equal(logger.info('a', 'job as number', {}, 42).job, null);
  assert.equal(logger.info('a', 'job as string', {}, 'job_20261005T141503_a1b2c3').job, 'job_20261005T141503_a1b2c3');
  assert.equal(logger.info('a', { toString: () => 'object message' }).msg, 'object message');
  assert.equal(logger.info('a', undefined).msg, 'undefined');
  assert.equal(logger.info('a', 'x', { get boom() { throw new Error('getter'); } }).data.boom, '[unreadable]');
});

test('log: a record is frozen all the way down and the data is a copy', () => {
  const { logger } = makeLogger();
  const input = { nested: { list: [1, 2] } };
  const r = logger.info('a', 'm', input);
  assert.ok(Object.isFrozen(r.data.nested) && Object.isFrozen(r.data.nested.list));
  assert.throws(() => { 'use strict'; r.data.nested.list.push(3); });
  input.nested.list.push(3);
  assert.deepEqual(r.data.nested.list, [1, 2]);
});

test('end to end: nothing secret reaches storage, the forwarder or the export', async () => {
  const { logger, store, schedule, forwarded } = makeLogger({ logger: { level: 'debug' } });
  const secrets = [
    'sk-ant-api03-abcdefgh12345678', 'hunter22secret', JWT, 'ghp_' + 'z'.repeat(36), 'AKIAIOSFODNN7EXAMPLE',
    'abcdefghijklmnopqrstuvwxyz0123', 'cookievalue1', 'cfbmvalue2', 'clearancevalue3',
  ];
  logger.debug('request', 'GET /api/organizations', {
    headers: { cookie: `sessionKey=${secrets[0]}; __cf_bm=${secrets[7]}; cf_clearance=${secrets[8]}`, 'cf-ray': 'ray-1', 'retry-after': '120' },
    request: { authorization: `Bearer ${secrets[5]}`, 'x-api-key': secrets[0] },
    url: `https://claude.ai/login?token=${secrets[1]}`,
    text: `password: ${secrets[1]} jwt ${JWT} gh ${secrets[3]} aws ${secrets[4]}`,
    body: new TextEncoder().encode('{"secret":"' + secrets[1] + '"}'),
    rows: [[{ password: secrets[1] }]],
    pem: PEM,
  }, 'job_1');
  logger.warn('interruption', `challenge with cookie: a=${secrets[6]}`, { evidence: { 'set-cookie': secrets[6] } });
  logger.error('error', `Bearer ${secrets[5]} leaked into a message`, { err: new Error(`sk-ant-api03-abcdefgh12345678 in an error`) });
  await schedule.fire();
  await logger.flush();
  const everything = [
    JSON.stringify(store.stored()),
    JSON.stringify(forwarded),
    logger.exportText(),
    JSON.stringify(logger.records()),
  ].join('\n');
  for (const s of secrets) assert.ok(!everything.includes(s), `${s} must not appear`);
  assert.ok(!everything.includes('MIIEowIBAAKCAQEA'));
  assert.ok(everything.includes('ray-1') && everything.includes('"retry-after":"120"'), 'diagnostics survive');
  assert.ok(everything.includes('<') && everything.includes(' bytes>'), 'the body is a size');
  assert.equal(forwarded.length, 2);
});
