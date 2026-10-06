// Tests of extension/src/config.js: the schema, the validator and the
// store. Run alone with `node --test tests/js/extension/config.test.js`
// (Node 24). Storage is a Map that records every write; nothing here
// touches chrome.* or the clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_VERSION, DEFAULTS, FIELDS, LOG_LEVELS, validate, gateConfig, createConfigStore,
} from '../../../extension/src/config.js';
import { READ_SPACING_DEFAULT_MS, WRITE_SPACING_DEFAULT_MS } from '../../../extension/src/gate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, '..', '..', '..', 'extension', 'src', 'config.js'), 'utf8');
// The source without its comments, for checks on what the code does.
const CODE = SOURCE.replace(/^\s*\/\/.*$/gm, '');

// A store like the worker's binding of chrome.storage.local to one key:
// get() hands back a copy of what is stored, set() records every write,
// external() plays a change made by another context.
function fakeStore(initial) {
  let value = initial;
  let listener = null;
  const writes = [];
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    writes,
    get: async () => clone(value),
    set: async v => {
      value = clone(v);
      writes.push(clone(v));
    },
    onChanged: fn => { listener = fn; },
    external(v) {
      value = clone(v);
      if (listener) listener(clone(v));
    },
    stored: () => clone(value),
  };
}

const keysOf = problems => problems.map(p => p.key);

// ------------------------------------------------------------ the schema

test('the defaults are complete, in bounds and valid as they are', () => {
  assert.equal(DEFAULTS.version, CONFIG_VERSION);
  assert.deepEqual(Object.keys(DEFAULTS).filter(k => k !== 'version').sort(), FIELDS.map(f => f.key).sort());
  for (const f of FIELDS) {
    const d = DEFAULTS[f.key];
    if (f.kind === 'int') {
      assert.ok(Number.isInteger(d) && d >= f.min && d <= f.max, `${f.key} default in bounds`);
      assert.ok(f.min < f.max, `${f.key} has a range`);
    } else if (f.kind === 'bool') {
      assert.equal(typeof d, 'boolean');
    } else {
      assert.equal(f.kind, 'choice');
      assert.ok(f.choices.includes(d));
    }
    assert.equal(typeof f.help, 'string');
    assert.ok(f.help.length > 10, `${f.key} has help`);
    assert.equal(typeof f.label, 'string');
  }
  const { config, problems } = validate(DEFAULTS);
  assert.deepEqual(config, { ...DEFAULTS });
  assert.deepEqual(problems, []);
});

test('the design\'s values: defaults, bounds and help phrases', () => {
  const byKey = Object.fromEntries(FIELDS.map(f => [f.key, f]));
  assert.deepEqual(DEFAULTS, {
    version: 2, readSpacingMs: 0, writeSpacingMs: 500, retryAfterCapMs: 900000, requestTimeoutMs: 120000,
    notifications: true, logLevel: 'info', logMaxRecords: 2000, logRetentionHours: 72,
  });
  assert.deepEqual([byKey.readSpacingMs.min, byKey.readSpacingMs.max], [0, 60000]);
  assert.deepEqual([byKey.writeSpacingMs.min, byKey.writeSpacingMs.max], [0, 60000]);
  assert.deepEqual([byKey.retryAfterCapMs.min, byKey.retryAfterCapMs.max], [60000, 86400000]);
  assert.deepEqual([byKey.requestTimeoutMs.min, byKey.requestTimeoutMs.max], [30000, 3600000]);
  assert.deepEqual([byKey.logMaxRecords.min, byKey.logMaxRecords.max], [100, 20000]);
  assert.deepEqual([byKey.logRetentionHours.min, byKey.logRetentionHours.max], [1, 720]);
  assert.deepEqual(byKey.logLevel.choices, ['debug', 'info', 'warn', 'error']);
  assert.deepEqual(LOG_LEVELS, ['debug', 'info', 'warn', 'error']);
  assert.match(byKey.readSpacingMs.help, /Fixed, never randomized/);
  assert.match(byKey.readSpacingMs.help, /every request of an export/);
  assert.match(byKey.readSpacingMs.help, /still one request at a time/);
  assert.match(byKey.writeSpacingMs.help, /Fixed, never randomized/);
  assert.match(byKey.retryAfterCapMs.help, /The full Retry-After is still waited out after Resume/);
  assert.deepEqual(FIELDS.map(f => f.key), [
    'readSpacingMs', 'writeSpacingMs', 'retryAfterCapMs', 'requestTimeoutMs', 'notifications', 'logLevel', 'logMaxRecords', 'logRetentionHours',
  ]);
});

test('the extension README\'s settings table names every setting with its default and range', () => {
  // The table is what a person reads; it went stale once when the spacing
  // changed, so it is held to the schema here.
  const readme = fs.readFileSync(path.join(HERE, '..', '..', '..', 'extension', 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('\n## Settings\n'), readme.indexOf('\n## ', readme.indexOf('\n## Settings\n') + 1));
  const rows = [...section.matchAll(/^\| `(\w+)` \|([^|]*)\|([^|]*)\|/gm)].map(m => ({ key: m[1], def: m[2].trim(), range: m[3].trim() }));
  assert.deepEqual(rows.map(r => r.key), FIELDS.map(f => f.key));
  for (const f of FIELDS) {
    const row = rows.find(r => r.key === f.key);
    assert.equal(row.def, String(DEFAULTS[f.key]), `${f.key} default`);
    if (f.kind === 'int') assert.equal(row.range, `${f.min} to ${f.max}`, `${f.key} range`);
    if (f.kind === 'choice') assert.equal(row.range, f.choices.join(', '), `${f.key} choices`);
  }
});

test('the gate\'s fallback spacings are the defaults here', () => {
  // gate.js imports nothing, so it keeps its own copy of the two numbers
  // for a config it cannot use; the two copies must not drift apart.
  assert.equal(DEFAULTS.readSpacingMs, READ_SPACING_DEFAULT_MS);
  assert.equal(DEFAULTS.writeSpacingMs, WRITE_SPACING_DEFAULT_MS);
});

test('nothing in the schema or the source is random or per account', () => {
  assert.doesNotMatch(SOURCE, /Math\.random|jitter|perAccount|per_account|cooldown|rotate/i);
  assert.doesNotMatch(CODE, /chrome\./);
  assert.doesNotMatch(SOURCE, /cookie/i);
  for (const f of FIELDS) assert.doesNotMatch(f.key, /jitter|random|account/i);
  assert.ok(/^[\x00-\x7f]*$/.test(SOURCE), 'config.js is plain ASCII');
  assert.ok(!SOURCE.includes('\r'), 'config.js has LF endings');
  assert.ok(Object.isFrozen(DEFAULTS) && Object.isFrozen(FIELDS) && Object.isFrozen(FIELDS[0]));
});

// ------------------------------------------------------------ validate

test('validate: each int key, missing, wrong type, below, above, float and ok', () => {
  for (const f of FIELDS.filter(x => x.kind === 'int')) {
    let r = validate({});
    assert.equal(r.config[f.key], DEFAULTS[f.key], `${f.key} missing -> default`);
    assert.deepEqual(r.problems, [], `${f.key} missing is not a problem`);

    r = validate({ [f.key]: 'abc' });
    assert.equal(r.config[f.key], DEFAULTS[f.key]);
    assert.deepEqual(keysOf(r.problems), [f.key]);
    assert.match(r.problems[0].message, /whole number/);

    for (const bad of [null, true, {}, [], NaN, Infinity, -Infinity, '12abc', '']) {
      r = validate({ [f.key]: bad });
      assert.equal(r.config[f.key], DEFAULTS[f.key], `${f.key} ${String(bad)} -> default`);
      assert.deepEqual(keysOf(r.problems), [f.key]);
    }

    r = validate({ [f.key]: f.min - 1 });
    assert.equal(r.config[f.key], f.min);
    assert.deepEqual(keysOf(r.problems), [f.key]);
    assert.match(r.problems[0].message, /below the minimum/);

    r = validate({ [f.key]: f.max + 1 });
    assert.equal(r.config[f.key], f.max);
    assert.match(r.problems[0].message, /above the maximum/);

    r = validate({ [f.key]: -1e12 });
    assert.equal(r.config[f.key], f.min);
    r = validate({ [f.key]: 1e12 });
    assert.equal(r.config[f.key], f.max);

    r = validate({ [f.key]: f.min });
    assert.equal(r.config[f.key], f.min);
    assert.deepEqual(r.problems, []);
    r = validate({ [f.key]: f.max });
    assert.equal(r.config[f.key], f.max);
    assert.deepEqual(r.problems, []);

    const mid = Math.floor((f.min + f.max) / 2);
    r = validate({ [f.key]: mid + 0.4 });
    assert.equal(r.config[f.key], mid, 'floats are rounded');
    assert.deepEqual(r.problems, []);

    r = validate({ [f.key]: String(mid) });
    assert.equal(r.config[f.key], mid, 'a numeric string from a form input is a number');
    assert.deepEqual(r.problems, []);
    r = validate({ [f.key]: ` ${mid} ` });
    assert.equal(r.config[f.key], mid);
  }
});

test('validate: zero spacing is allowed and stays zero, before a read and before a write', () => {
  for (const key of ['readSpacingMs', 'writeSpacingMs']) {
    const r = validate({ [key]: 0 });
    assert.equal(r.config[key], 0);
    assert.deepEqual(r.problems, []);
    assert.equal(validate({ [key]: '0' }).config[key], 0);
    assert.equal(validate({ [key]: -0.2 }).config[key], 0);
  }
});

test('validate: booleans must be booleans', () => {
  assert.equal(validate({ notifications: false }).config.notifications, false);
  assert.deepEqual(validate({ notifications: false }).problems, []);
  for (const bad of ['true', 'false', 1, 0, null, 'yes', {}]) {
    const r = validate({ notifications: bad });
    assert.equal(r.config.notifications, true, `${String(bad)} -> default`);
    assert.deepEqual(keysOf(r.problems), ['notifications']);
    assert.match(r.problems[0].message, /true or false/);
  }
});

test('validate: the log level is one of the four, case and spaces forgiven', () => {
  for (const level of LOG_LEVELS) {
    assert.equal(validate({ logLevel: level }).config.logLevel, level);
    assert.deepEqual(validate({ logLevel: level }).problems, []);
  }
  assert.equal(validate({ logLevel: ' WARN ' }).config.logLevel, 'warn');
  for (const bad of ['verbose', '', 3, null, true, ['info']]) {
    const r = validate({ logLevel: bad });
    assert.equal(r.config.logLevel, 'info');
    assert.deepEqual(keysOf(r.problems), ['logLevel']);
    assert.match(r.problems[0].message, /one of debug, info, warn, error/);
  }
});

test('validate: unknown keys are dropped with a problem each', () => {
  const r = validate({ ...DEFAULTS, jitterMs: 100, accounts: ['a'], 'minSpacingMs ': 1 });
  assert.deepEqual(r.config, { ...DEFAULTS });
  assert.deepEqual(keysOf(r.problems).sort(), ['accounts', 'jitterMs', 'minSpacingMs '].sort());
  for (const p of r.problems) assert.match(p.message, /unknown setting .* was dropped/);
  assert.ok(!('jitterMs' in r.config));
});

test('validate: a wrong version is noted and set right; a missing one is fine', () => {
  let r = validate({ version: 3, writeSpacingMs: 100 });
  assert.equal(r.config.version, CONFIG_VERSION);
  assert.equal(r.config.writeSpacingMs, 100);
  assert.deepEqual(keysOf(r.problems), ['version']);
  r = validate({ writeSpacingMs: 100 });
  assert.equal(r.config.version, CONFIG_VERSION);
  assert.deepEqual(r.problems, []);
  r = validate({ version: '1' });
  assert.deepEqual(keysOf(r.problems), ['version']);
  r = validate({ version: 1 });
  assert.deepEqual(r.problems, [], 'version 1 is carried over, not a problem');
  assert.equal(r.config.version, CONFIG_VERSION);
});

test('validate: a version-1 config is carried over without a problem', () => {
  const v1Defaults = {
    version: 1, minSpacingMs: 500, retryAfterCapMs: 900000, requestTimeoutMs: 120000,
    notifications: true, logLevel: 'info', logMaxRecords: 2000, logRetentionHours: 72,
  };
  // The old default, which the first load wrote into storage, becomes the
  // new defaults: nothing before a read, half a second before a write.
  let r = validate(v1Defaults);
  assert.deepEqual(r.config, { ...DEFAULTS });
  assert.deepEqual(r.problems, []);
  assert.ok(!('minSpacingMs' in r.config));
  // A spacing the person had chosen is kept before both.
  r = validate({ ...v1Defaults, minSpacingMs: 2000, logLevel: 'debug' });
  assert.equal(r.config.readSpacingMs, 2000);
  assert.equal(r.config.writeSpacingMs, 2000);
  assert.equal(r.config.logLevel, 'debug');
  assert.deepEqual(r.problems, []);
  r = validate({ version: 1, minSpacingMs: 0 });
  assert.deepEqual([r.config.readSpacingMs, r.config.writeSpacingMs], [0, 0]);
  r = validate({ version: 1, minSpacingMs: '750' });
  assert.deepEqual([r.config.readSpacingMs, r.config.writeSpacingMs], [750, 750]);
  // Without a version it is read as version 1 too.
  r = validate({ minSpacingMs: 100 });
  assert.deepEqual([r.config.readSpacingMs, r.config.writeSpacingMs], [100, 100]);
  assert.deepEqual(r.problems, []);
  // A version-1 value out of bounds is clamped under its new names.
  r = validate({ version: 1, minSpacingMs: 99999 });
  assert.deepEqual([r.config.readSpacingMs, r.config.writeSpacingMs], [60000, 60000]);
  assert.deepEqual(keysOf(r.problems).sort(), ['readSpacingMs', 'writeSpacingMs']);
  // A frozen version-1 object is read, never changed.
  const frozen = Object.freeze({ ...v1Defaults, minSpacingMs: 1200 });
  r = validate(frozen);
  assert.equal(r.config.writeSpacingMs, 1200);
  assert.deepEqual(frozen, { ...v1Defaults, minSpacingMs: 1200 });
  // A version-2 config that still names minSpacingMs is not migrated: the
  // key is unknown and dropped.
  r = validate({ ...DEFAULTS, minSpacingMs: 2000 });
  assert.deepEqual(r.config, { ...DEFAULTS });
  assert.deepEqual(keysOf(r.problems), ['minSpacingMs']);
});

test('validate: nothing stored is the defaults; garbage is the defaults with a problem', () => {
  for (const empty of [undefined, null]) {
    const r = validate(empty);
    assert.deepEqual(r.config, { ...DEFAULTS });
    assert.deepEqual(r.problems, []);
  }
  for (const bad of ['{"a":1}', 42, true, [1, 2], () => {}, Symbol('x')]) {
    const r = validate(bad);
    assert.deepEqual(r.config, { ...DEFAULTS });
    assert.equal(r.problems.length, 1);
    assert.equal(r.problems[0].key, '');
    assert.match(r.problems[0].message, /not an object/);
  }
});

test('validate: never throws and never mutates its input', () => {
  const frozen = Object.freeze({ writeSpacingMs: 99999, logLevel: 'x', extra: 1 });
  const r = validate(frozen);
  assert.equal(r.config.writeSpacingMs, 60000);
  assert.deepEqual(frozen, { writeSpacingMs: 99999, logLevel: 'x', extra: 1 });
  const hostile = { get writeSpacingMs() { throw new Error('boom'); } };
  assert.throws(() => hostile.writeSpacingMs);
  // A getter that throws is beyond what a plain object from storage can
  // do; the validator is not asked to survive it, only never to throw on
  // JSON. JSON-shaped oddities it must take in its stride:
  const weird = { writeSpacingMs: { toString: () => '5' }, notifications: 'true', logMaxRecords: '1e3' };
  const w = validate(weird);
  assert.equal(w.config.writeSpacingMs, DEFAULTS.writeSpacingMs);
  assert.equal(w.config.notifications, true);
  assert.equal(w.config.logMaxRecords, DEFAULTS.logMaxRecords, '1e3 is not a plain number');
  assert.equal(w.problems.length, 3);
  for (const p of w.problems) assert.ok(p.message.length < 200, 'messages stay short');
});

test('validate: a problem message shows the value briefly', () => {
  const r = validate({ writeSpacingMs: 'x'.repeat(500) });
  assert.ok(r.problems[0].message.length < 160);
  assert.match(r.problems[0].message, /\.\.\./);
  const c = validate({ logLevel: { a: 1 } });
  assert.match(c.problems[0].message, /\{"a":1\}/);
});

// ------------------------------------------------------------ the store

test('createConfigStore needs a store', () => {
  assert.throws(() => createConfigStore({}), /store/);
  assert.throws(() => createConfigStore({ store: { get() {} } }), /store/);
  assert.throws(() => createConfigStore(), /store/);
});

test('load: nothing stored writes the defaults once and notifies', async () => {
  const store = fakeStore(undefined);
  const seen = [];
  const cfg = createConfigStore({ store, onChange: c => seen.push(c) });
  assert.deepEqual(cfg.get(), { ...DEFAULTS }, 'the defaults apply before load');
  const loaded = await cfg.load();
  assert.deepEqual(loaded, { ...DEFAULTS });
  assert.deepEqual(store.writes, [{ ...DEFAULTS }]);
  assert.deepEqual(seen, [{ ...DEFAULTS }]);
  await cfg.load();
  await cfg.load();
  assert.equal(store.writes.length, 1, 'load is idempotent');
});

test('load: a clean stored config is used as is, with no write, and notifies once', async () => {
  // The worker applies logLevel and the log limits only from onChange, so
  // after a service-worker restart this one call is what brings the saved
  // level back; without it the logger would run at its defaults for good.
  const stored = { ...DEFAULTS, writeSpacingMs: 750, notifications: false, logLevel: 'debug', logMaxRecords: 100 };
  const store = fakeStore(stored);
  const seen = [];
  const cfg = createConfigStore({ store, onChange: c => seen.push(c) });
  const loaded = await cfg.load();
  assert.deepEqual(loaded, stored);
  assert.deepEqual(cfg.get(), stored);
  assert.deepEqual(store.writes, []);
  assert.deepEqual(seen, [stored]);
  assert.equal(seen[0], cfg.get(), 'the listener gets the very object get() hands out');
  await cfg.load();
  await cfg.load();
  assert.equal(seen.length, 1, 'load again does not notify again');
  const same = await cfg.set({ logLevel: 'debug' });
  assert.deepEqual(same.problems, []);
  assert.equal(seen.length, 1, 'saving the same values is not a change');
});

test('load: the worker\'s wiring gets the saved level after a restart', async () => {
  // The listener is background.js's, line for line, against a logger that
  // records what it is told.
  const store = fakeStore({ ...DEFAULTS, logLevel: 'debug', logMaxRecords: 100, logRetentionHours: 1 });
  const told = { level: null, limits: null };
  const log = {
    setLevel: level => { told.level = level; },
    setLimits: limits => { told.limits = limits; },
  };
  const cfg = createConfigStore({
    store,
    onChange: c => {
      log.setLevel(c.logLevel);
      log.setLimits({ maxRecords: c.logMaxRecords, maxAgeMs: c.logRetentionHours * 3600000 });
    },
  });
  await cfg.load();
  assert.equal(told.level, 'debug');
  assert.deepEqual(told.limits, { maxRecords: 100, maxAgeMs: 3600000 });
});

test('load: a corrupt or old stored config is healed and written back', async () => {
  for (const corrupt of ['nonsense', 7, [], { minSpacingMs: 'abc', jitter: 5 }, { version: 0, logLevel: 'trace', retryAfterCapMs: 1 }]) {
    const store = fakeStore(corrupt);
    const cfg = createConfigStore({ store });
    const loaded = await cfg.load();
    assert.equal(loaded.version, CONFIG_VERSION);
    assert.deepEqual(Object.keys(loaded).sort(), Object.keys(DEFAULTS).sort());
    assert.equal(store.writes.length, 1, `${JSON.stringify(corrupt)} is rewritten once`);
    assert.deepEqual(store.stored(), loaded);
    assert.deepEqual(validate(store.stored()).problems, [], 'what is stored now is clean');
  }
  const partial = fakeStore({ version: CONFIG_VERSION, writeSpacingMs: 100 });
  const cfg = createConfigStore({ store: partial });
  const loaded = await cfg.load();
  assert.equal(loaded.writeSpacingMs, 100);
  assert.equal(loaded.readSpacingMs, 0);
  assert.equal(loaded.logLevel, 'info', 'a key from a newer version is filled in');
  assert.equal(partial.writes.length, 1, 'the completed object is stored');
});

test('load: a stored version-1 config is written back once as version 2', async () => {
  // What an install of the earlier version holds: its first load wrote the
  // version-1 defaults, 500 ms before every request.
  const store = fakeStore({
    version: 1, minSpacingMs: 500, retryAfterCapMs: 900000, requestTimeoutMs: 120000,
    notifications: false, logLevel: 'info', logMaxRecords: 2000, logRetentionHours: 72,
  });
  const seen = [];
  const cfg = createConfigStore({ store, onChange: c => seen.push(c) });
  const loaded = await cfg.load();
  assert.deepEqual(loaded, { ...DEFAULTS, notifications: false });
  assert.deepEqual(store.writes, [{ ...DEFAULTS, notifications: false }]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].readSpacingMs, 0);
  assert.equal(seen[0].writeSpacingMs, 500);
  await cfg.load();
  assert.equal(store.writes.length, 1, 'carried over once');
});

test('set: a patch that names minSpacingMs is an unknown setting, never migrated', async () => {
  const store = fakeStore({ ...DEFAULTS });
  const cfg = createConfigStore({ store });
  await cfg.load();
  const r = await cfg.set({ minSpacingMs: 2000 });
  assert.deepEqual(keysOf(r.problems), ['minSpacingMs']);
  assert.match(r.problems[0].message, /unknown setting/);
  assert.deepEqual(r.config, { ...DEFAULTS });
  assert.deepEqual(store.writes, []);
});

test('gateConfig: an export is spaced as reads throughout; an import keeps each spacing', () => {
  const config = { ...DEFAULTS, readSpacingMs: 0, writeSpacingMs: 500, retryAfterCapMs: 120000 };
  assert.deepEqual(gateConfig(config, 'export'), { readSpacingMs: 0, writeSpacingMs: 0, retryAfterCapMs: 120000 });
  assert.deepEqual(gateConfig(config, 'import'), { readSpacingMs: 0, writeSpacingMs: 500, retryAfterCapMs: 120000 });
  assert.deepEqual(gateConfig({ ...config, readSpacingMs: 250 }, 'export'), { readSpacingMs: 250, writeSpacingMs: 250, retryAfterCapMs: 120000 });
  assert.deepEqual(gateConfig(null, 'import'), { readSpacingMs: DEFAULTS.readSpacingMs, writeSpacingMs: DEFAULTS.writeSpacingMs, retryAfterCapMs: DEFAULTS.retryAfterCapMs });
  assert.deepEqual(gateConfig(undefined, 'export'), { readSpacingMs: DEFAULTS.readSpacingMs, writeSpacingMs: DEFAULTS.readSpacingMs, retryAfterCapMs: DEFAULTS.retryAfterCapMs });
});

test('load: a store that cannot be read leaves the defaults in memory, writes nothing and reads again next time', async () => {
  const store = fakeStore({ ...DEFAULTS, writeSpacingMs: 750 });
  const good = store.get;
  let reads = 0;
  store.get = async () => { reads++; throw new Error('storage unavailable'); };
  const seen = [];
  const cfg = createConfigStore({ store, onChange: c => seen.push(c) });
  const loaded = await cfg.load();
  assert.deepEqual(loaded, { ...DEFAULTS });
  assert.deepEqual(store.writes, []);
  assert.equal(reads, 1);
  await cfg.load();
  assert.equal(reads, 2, 'a failed read is tried again');
  store.get = good;
  const again = await cfg.load();
  assert.equal(again.writeSpacingMs, 750, 'the stored settings arrive once the store answers');
  assert.deepEqual(seen, [again], 'nothing was notified while nothing was known');
  await cfg.load();
  assert.equal(seen.length, 1, 'and the read is not repeated after it worked');
});

test('set after a read that failed reads again and merges into what is stored', async () => {
  const store = fakeStore({ ...DEFAULTS, notifications: false, logLevel: 'error', retryAfterCapMs: 120000 });
  const good = store.get;
  store.get = async () => { throw new Error('storage busy'); };
  const cfg = createConfigStore({ store });
  await cfg.load();
  assert.deepEqual(cfg.get(), { ...DEFAULTS });
  store.get = good;
  const r = await cfg.set({ writeSpacingMs: 900 });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.config, { ...DEFAULTS, notifications: false, logLevel: 'error', retryAfterCapMs: 120000, writeSpacingMs: 900 });
  assert.deepEqual(store.writes, [r.config], 'the other settings were not reset to their defaults');
});

test('set while the store stays unreadable saves nothing and says so; reset still writes the defaults', async () => {
  const store = fakeStore({ ...DEFAULTS, notifications: false, logLevel: 'error' });
  const good = store.get;
  store.get = async () => { throw new Error('storage busy'); };
  const seen = [];
  const cfg = createConfigStore({ store, onChange: c => seen.push(c) });
  await cfg.load();
  const r = await cfg.set({ writeSpacingMs: 900 });
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].key, '');
  assert.match(r.problems[0].message, /could not be saved: the stored settings could not be read/);
  assert.deepEqual(r.config, { ...DEFAULTS });
  assert.deepEqual(store.writes, [], 'a patch merged into the defaults is never written over unknown settings');
  assert.deepEqual(store.stored(), { ...DEFAULTS, notifications: false, logLevel: 'error' });
  assert.deepEqual(seen, []);

  // The defaults need no base, so a reset goes out; after it the stored
  // value is known again and a patch merges into it without a read.
  const back = await cfg.reset();
  assert.deepEqual(back, { ...DEFAULTS });
  assert.deepEqual(store.writes, [{ ...DEFAULTS }]);
  assert.deepEqual(seen, [{ ...DEFAULTS }]);
  const r2 = await cfg.set({ writeSpacingMs: 900 });
  assert.deepEqual(r2.problems, []);
  assert.deepEqual(store.stored(), { ...DEFAULTS, writeSpacingMs: 900 });
  store.get = good;
  await cfg.load();
  assert.equal(cfg.get().writeSpacingMs, 900, 'no read was owed, so nothing was merged in a second time');
});

test('set merges a patch, writes once, notifies once and reports problems', async () => {
  const store = fakeStore({ ...DEFAULTS });
  const seen = [];
  const cfg = createConfigStore({ store, onChange: c => seen.push(c) });
  await cfg.load();
  seen.length = 0; // the one notify at load is covered above
  const r = await cfg.set({ writeSpacingMs: 1200, logLevel: 'debug' });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.config, { ...DEFAULTS, writeSpacingMs: 1200, logLevel: 'debug' });
  assert.deepEqual(cfg.get(), r.config);
  assert.deepEqual(store.writes, [r.config]);
  assert.deepEqual(seen, [r.config]);

  const r2 = await cfg.set({ retryAfterCapMs: 10, bogus: 1 });
  assert.equal(r2.config.retryAfterCapMs, 60000, 'clamped');
  assert.equal(r2.config.writeSpacingMs, 1200, 'earlier values kept');
  assert.deepEqual(keysOf(r2.problems).sort(), ['bogus', 'retryAfterCapMs']);
  assert.ok(!('bogus' in r2.config));
  assert.equal(store.writes.length, 2);
  assert.equal(seen.length, 2);
});

test('set with nothing new writes nothing and notifies nobody', async () => {
  const store = fakeStore({ ...DEFAULTS });
  const seen = [];
  const cfg = createConfigStore({ store, onChange: c => seen.push(c) });
  await cfg.load();
  seen.length = 0;
  const r = await cfg.set({ writeSpacingMs: 500 });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(store.writes, []);
  assert.deepEqual(seen, []);
  const r2 = await cfg.set({});
  assert.deepEqual(r2.config, { ...DEFAULTS });
  assert.deepEqual(store.writes, []);
  const r3 = await cfg.set({ writeSpacingMs: 'nope' });
  assert.deepEqual(keysOf(r3.problems), ['writeSpacingMs'], 'a bad value is reported');
  assert.deepEqual(store.writes, [], 'and, being the default again, not written');
});

test('set refuses a patch that is not an object, without a write', async () => {
  const store = fakeStore({ ...DEFAULTS });
  const cfg = createConfigStore({ store });
  for (const bad of [undefined, null, 'minSpacingMs=1', 5, [1]]) {
    const r = await cfg.set(bad);
    assert.deepEqual(r.config, { ...DEFAULTS });
    assert.equal(r.problems.length, 1);
    assert.equal(r.problems[0].key, '');
    assert.match(r.problems[0].message, /must be an object/);
  }
  assert.deepEqual(store.writes, []);
});

test('set before load merges into what is stored, not into the defaults', async () => {
  const store = fakeStore({ ...DEFAULTS, notifications: false, logMaxRecords: 5000 });
  const cfg = createConfigStore({ store });
  const r = await cfg.set({ writeSpacingMs: 900 });
  assert.equal(r.config.notifications, false);
  assert.equal(r.config.logMaxRecords, 5000);
  assert.equal(r.config.writeSpacingMs, 900);
  assert.deepEqual(store.stored(), r.config);
});

test('overlapping sets land one after another; the last one wins', async () => {
  const store = fakeStore({ ...DEFAULTS });
  const order = [];
  const slowSet = store.set;
  store.set = async v => {
    await new Promise(r => setImmediate(r));
    order.push(v.writeSpacingMs);
    return slowSet(v);
  };
  const cfg = createConfigStore({ store });
  const [a, b, c] = await Promise.all([
    cfg.set({ writeSpacingMs: 100 }),
    cfg.set({ writeSpacingMs: 200 }),
    cfg.set({ logLevel: 'warn' }),
  ]);
  assert.equal(a.config.writeSpacingMs, 100);
  assert.equal(b.config.writeSpacingMs, 200);
  assert.equal(c.config.writeSpacingMs, 200);
  assert.equal(c.config.logLevel, 'warn');
  assert.deepEqual(order, [100, 200, 200]);
  assert.deepEqual(store.stored(), { ...DEFAULTS, writeSpacingMs: 200, logLevel: 'warn' });
});

test('a write that fails is reported and leaves memory as it was', async () => {
  const store = fakeStore({ ...DEFAULTS });
  const seen = [];
  const cfg = createConfigStore({ store, onChange: c => seen.push(c) });
  await cfg.load();
  seen.length = 0;
  const good = store.set;
  store.set = async () => { throw new Error('QUOTA_BYTES exceeded'); };
  const r = await cfg.set({ writeSpacingMs: 2000 });
  assert.equal(r.config.writeSpacingMs, 500);
  assert.deepEqual(cfg.get(), { ...DEFAULTS });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /could not be saved: QUOTA_BYTES exceeded/);
  assert.deepEqual(seen, []);
  store.set = good;
  const r2 = await cfg.set({ writeSpacingMs: 2000 });
  assert.deepEqual(r2.problems, []);
  assert.equal(cfg.get().writeSpacingMs, 2000, 'the store works again afterwards');
});

test('reset writes the defaults and returns them', async () => {
  const store = fakeStore({ ...DEFAULTS, writeSpacingMs: 3000, logLevel: 'error' });
  const seen = [];
  const cfg = createConfigStore({ store, onChange: c => seen.push(c) });
  await cfg.load();
  seen.length = 0;
  const back = await cfg.reset();
  assert.deepEqual(back, { ...DEFAULTS });
  assert.deepEqual(store.stored(), { ...DEFAULTS });
  assert.equal(seen.length, 1);
  const again = await cfg.reset();
  assert.deepEqual(again, { ...DEFAULTS });
  assert.equal(store.writes.length, 1, 'a second reset changes nothing');
});

test('get() hands out a frozen object that a caller cannot bend', async () => {
  const store = fakeStore({ ...DEFAULTS });
  const cfg = createConfigStore({ store });
  await cfg.load();
  const c = cfg.get();
  assert.ok(Object.isFrozen(c));
  assert.throws(() => { 'use strict'; c.writeSpacingMs = 0; });
  assert.equal(cfg.get().writeSpacingMs, 500);
  assert.equal(cfg.get(), c, 'the same object until something changes');
  await cfg.set({ writeSpacingMs: 600 });
  assert.notEqual(cfg.get(), c);
  assert.equal(c.writeSpacingMs, 500, 'an old snapshot stays what it was');
});

test('a change made elsewhere is taken over, validated, without a write back', async () => {
  const store = fakeStore({ ...DEFAULTS });
  const seen = [];
  const cfg = createConfigStore({ store, onChange: c => seen.push(c) });
  await cfg.load();
  seen.length = 0;
  store.external({ ...DEFAULTS, writeSpacingMs: 250, logLevel: 'bogus' });
  assert.equal(cfg.get().writeSpacingMs, 250);
  assert.equal(cfg.get().logLevel, 'info');
  assert.equal(seen.length, 1);
  assert.deepEqual(store.writes, []);
  store.external({ ...DEFAULTS, writeSpacingMs: 250, logLevel: 'bogus' });
  assert.equal(seen.length, 1, 'the same value again is not a change');
  store.external(undefined);
  assert.deepEqual(cfg.get(), { ...DEFAULTS }, 'the key removed means the defaults');
  assert.equal(seen.length, 2);
});

test('our own write echoed back as a storage change does not notify twice', async () => {
  const store = fakeStore({ ...DEFAULTS });
  const seen = [];
  const realSet = store.set;
  store.set = async v => {
    await realSet(v);
    store.external(v);
  };
  const cfg = createConfigStore({ store, onChange: c => seen.push(c) });
  await cfg.load();
  seen.length = 0;
  await cfg.set({ writeSpacingMs: 400 });
  assert.equal(seen.length, 1);
});

test('a listener that throws does not break the store', async () => {
  const store = fakeStore({ ...DEFAULTS });
  let calls = 0;
  const cfg = createConfigStore({ store, onChange: () => { calls++; throw new Error('listener bug'); } });
  await cfg.load();
  assert.equal(calls, 1, 'the listener threw at load and the store went on');
  calls = 0;
  const r = await cfg.set({ writeSpacingMs: 10 });
  assert.equal(r.config.writeSpacingMs, 10);
  assert.equal(calls, 1);
  store.external({ ...DEFAULTS, writeSpacingMs: 20 });
  assert.equal(calls, 2);
  assert.equal(cfg.get().writeSpacingMs, 20);
  await cfg.set({ writeSpacingMs: 30 });
  assert.equal(cfg.get().writeSpacingMs, 30);
});

test('a store without change events, and one whose onChanged throws, still work', async () => {
  const plain = fakeStore({ ...DEFAULTS });
  delete plain.onChanged;
  const cfg = createConfigStore({ store: plain });
  await cfg.load();
  await cfg.set({ writeSpacingMs: 1 });
  assert.equal(cfg.get().writeSpacingMs, 1);

  const broken = fakeStore({ ...DEFAULTS });
  broken.onChanged = () => { throw new Error('no events here'); };
  const cfg2 = createConfigStore({ store: broken });
  await cfg2.load();
  await cfg2.set({ writeSpacingMs: 2 });
  assert.equal(cfg2.get().writeSpacingMs, 2);
});

test('what the gate and the logger read is plain numbers and strings', async () => {
  const store = fakeStore({ ...DEFAULTS, writeSpacingMs: '0', retryAfterCapMs: '60000' });
  const cfg = createConfigStore({ store });
  await cfg.load();
  const c = cfg.get();
  assert.equal(typeof c.writeSpacingMs, 'number');
  assert.equal(c.writeSpacingMs, 0);
  assert.equal(c.retryAfterCapMs, 60000);
  assert.equal(typeof c.logMaxRecords, 'number');
  assert.equal(JSON.stringify(c), JSON.stringify({ ...DEFAULTS, writeSpacingMs: 0, retryAfterCapMs: 60000 }));
});
