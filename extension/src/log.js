// The structured log of the cswap import extension: one JSON record per
// request, wait, interruption, hold, job step or error, kept as a ring in
// chrome.storage.local and exported as JSONL from the side panel. Every
// record's data goes through redact() first, so a cookie, a token, an
// Authorization header, a session key or an API key never reaches storage,
// the host or a file, whatever a caller passes in.
//
// The same redact() is what interrupt.js uses for its evidence and what
// page.js copies for what it emits; the rules are the design's section 2.7.
// The module takes its clock, store and timer as arguments and has no
// randomness, so tests run on a fake clock in milliseconds.

export const LEVELS = ['debug', 'info', 'warn', 'error'];

// The kinds of record the worker writes. Any other string is kept as given;
// the list is documentation and the panel's filter choices. 'log' is the
// logger's own: the one warn it writes when storage refused the log.
export const EVENTS = ['request', 'gate', 'wait', 'interruption', 'held', 'job', 'native', 'page', 'config', 'panel', 'error', 'log'];

export const REDACTED = '[redacted]';

// The ring is bounded by its size in storage as well as by count and age:
// chrome.storage.local holds 10 MB for the whole extension, and 20000
// records of the shape the worker writes at 'debug' would not fit. The
// bound is on the records' JSON, in UTF-16 units, which is what the quota
// is measured in, near enough.
export const MAX_BYTES = 2 * 1024 * 1024;

// After storage refused a write the byte bound comes down to what was kept,
// but never below this, so a small log still has room to grow.
export const MIN_BYTES = 64 * 1024;

// A value nested deeper than this is replaced by a marker: nothing the
// worker logs is that deep, and a runaway structure must not stall redaction.
export const MAX_DEPTH = 20;

// A string longer than this in a record's data is clipped. Bodies are never
// logged by design (an excerpt is 200 chars); this guards the storage quota
// against a caller who logs something big by mistake.
export const MAX_STRING = 4000;

// Keys whose value is always replaced whole, compared after lowercasing and
// dropping everything that is not a letter or a digit, so 'Set-Cookie',
// 'set_cookie' and 'setCookie' are one key.
export const SECRET_KEY_SET = new Set([
  'cookie', 'setcookie', 'cookies', 'authorization', 'proxyauthorization',
  'xapikey', 'apikey', 'anthropicapikey', 'sessionkey', 'sessionid', 'session',
  'secret', 'password', 'passwd', 'token', 'accesstoken', 'refreshtoken',
  'idtoken', 'bearer', 'csrftoken', 'xcsrftoken', 'xsrftoken', 'authtoken',
  'cfclearance', 'cfbm',
]);

export const SECRET_KEY_SUFFIXES = ['token', 'secret', 'password', 'apikey'];

// Query parameters (and fragment parameters) whose value is blanked in any
// URL found in a string, compared lowercased.
export const SECRET_QUERY_PARAMS = [
  'token', 'key', 'api_key', 'apikey', 'session', 'sessionKey', 'code', 'state',
  'auth', 'access_token', 'refresh_token',
];

// The string rules, applied in this order. Each is [pattern, replacement].
// They are the design's, widened in four places so that each catches
// strictly more: a private key whose END line was cut off is blanked to
// the end of the string; a '__Secure-' or '__Host-' cookie name may hold a
// dot, as '__Secure-next-auth.session-token' does; the API-key rule takes an
// optional closing quote before the separator, so '"token":"..."' in
// JSON-looking text is caught, and the 'api-key' and 'session-key'
// spellings, so a header line such as 'x-api-key: ...' is caught in text as
// it is as a key. The cookie-line rule is an addition: a whole
// 'cookie: a=b; c=d' line in text is blanked, since the key rule only sees
// keys.
export const SECRET_VALUE_RES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g, '[redacted private key]'],
  [/sk-ant-[A-Za-z0-9_\-]{8,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/(\bBearer\s+)[A-Za-z0-9._~+\/\-]{16,}=*/gi, `$1${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED],
  [/\b(sessionKey|session_key|cf_clearance|__cf_bm|__Secure-[\w.-]+|__Host-[\w.-]+|csrftoken|intercom-session-[\w-]+)=[^;&\s]+/gi, `$1=${REDACTED}`],
  [/\b([A-Z0-9_]*(?:API[_-]?KEY|SESSION[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*['"]?\s*[=:]\s*)(?!\[redacted)(['"]?)[^\s'"]{4,}\2/gi, `$1${REDACTED}`],
  [/\b((?:set-)?cookies?\s*[:=]\s*)(?!\[redacted)[^\r\n]+/gi, `$1${REDACTED}`],
];

const SECRET_PARAM_SET = new Set(SECRET_QUERY_PARAMS.map(p => p.toLowerCase()));

// A URL with a scheme, up to whitespace or a quote; and a bare path with a
// query, standing alone or after a space or a bracket. Both are where a
// query string can carry a secret.
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`\\]+/gi;
const PATH_RE = /(^|[\s"'(\[])(\/[^\s"'<>`\\]*\?[^\s"'<>`\\]*)/g;
const PARAM_RE = /([?#&])([^=&#]*)(=)([^&#]*)/g;
const LEVEL_INDEX = new Map(LEVELS.map((name, i) => [name, i]));
const WARN = LEVEL_INDEX.get('warn');

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSecretKey(key) {
  const norm = normalizeKey(key);
  if (SECRET_KEY_SET.has(norm)) return true;
  return SECRET_KEY_SUFFIXES.some(suffix => norm.endsWith(suffix));
}

function isSecretParam(name) {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // Not valid percent-encoding; the raw name is compared.
  }
  return SECRET_PARAM_SET.has(decoded.trim().toLowerCase());
}

function redactParams(url) {
  return url.replace(PARAM_RE, (all, sep, name, eq, value) => (
    isSecretParam(name) ? `${sep}${name}=${REDACTED}` : all
  ));
}

function redactUrls(text) {
  if (text.indexOf('=') < 0) return text;
  let out = text.replace(URL_RE, match => {
    // Trailing punctuation belongs to the sentence around the URL. A ']'
    // is not in the set, so a '[redacted]' already at the end stays whole.
    const tail = (/[).,;:!?]+$/.exec(match) || [''])[0];
    const url = tail ? match.slice(0, -tail.length) : match;
    return redactParams(url) + tail;
  });
  out = out.replace(PATH_RE, (all, lead, path) => lead + redactParams(path));
  return out;
}

// Blanks every secret the rules know in one string. Anything that is not a
// string is turned into one first. URLs go first: their rule blanks one
// parameter at a time, while the NAME=value rule would take the rest of a
// query string along with the secret; what it blanks, the later rules skip
// by the '[redacted' guard, and anything it misses they still catch.
export function redactText(text) {
  let out = redactUrls(typeof text === 'string' ? text : String(text));
  for (const [re, repl] of SECRET_VALUE_RES) out = out.replace(re, repl);
  return out;
}

// The pathname of a URL, relative ones resolved against claude.ai; '' when
// it is not a URL at all. Query strings never reach a record this way.
export function pathOnly(url) {
  if (typeof url !== 'string' || url === '') return '';
  try {
    return new URL(url, 'https://claude.ai').pathname;
  } catch {
    return '';
  }
}

const tagOf = value => Object.prototype.toString.call(value);

function isBytes(value) {
  const tag = tagOf(value);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]'
    || tag === '[object Blob]' || tag === '[object File]' || ArrayBuffer.isView(value);
}

function byteCount(value) {
  if (typeof value.byteLength === 'number') return value.byteLength;
  if (typeof value.size === 'number') return value.size;
  return 0;
}

function isErrorLike(value) {
  const tag = tagOf(value);
  if (tag === '[object Error]' || tag === '[object DOMException]') return true;
  return typeof value.message === 'string' && typeof value.name === 'string' && 'stack' in value;
}

function isHeadersLike(value) {
  if (tagOf(value) === '[object Headers]') return true;
  return typeof value.forEach === 'function' && typeof value.get === 'function' && typeof value.append === 'function';
}

function clipString(text, maxString) {
  if (!maxString || text.length <= maxString) return text;
  return `${text.slice(0, maxString)}...[clipped ${text.length - maxString} chars]`;
}

// The one walk behind redact() and the logger: a deep copy made of plain
// JSON, with secret keys blanked, strings scrubbed, bytes summarized, cycles
// and depth guarded. `seen` holds the objects on the path down, not every
// object visited, so a value shared by two branches is copied twice rather
// than reported as a cycle.
function scrub(value, depth, seen, maxString) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string') return clipString(redactText(value), maxString);
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'undefined') return undefined;
  if (type === 'bigint') return value.toString();
  if (type === 'function') return '[function]';
  if (type === 'symbol') return String(value);
  if (depth >= MAX_DEPTH) return '[too deep]';
  if (seen.has(value)) return '[cycle]';
  const tag = tagOf(value);
  if (tag === '[object Date]') return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (tag === '[object RegExp]') return String(value);
  if (isBytes(value)) return `<${byteCount(value)} bytes>`;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map(item => {
        const copy = scrub(item, depth + 1, seen, maxString);
        return copy === undefined ? null : copy;
      });
    }
    if (isErrorLike(value)) {
      const out = { name: String(value.name), message: clipString(redactText(String(value.message)), maxString) };
      if (value.code !== undefined) out.code = scrub(value.code, depth + 1, seen, maxString);
      return out;
    }
    let entries;
    if (tag === '[object Map]') {
      entries = [];
      for (const [k, v] of value) entries.push([String(k), v]);
    } else if (tag === '[object Set]') {
      return [...value].map(item => {
        const copy = scrub(item, depth + 1, seen, maxString);
        return copy === undefined ? null : copy;
      });
    } else if (isHeadersLike(value)) {
      entries = [];
      value.forEach((v, k) => entries.push([String(k), v]));
    } else {
      entries = Object.keys(value).map(k => {
        try {
          return [k, value[k]];
        } catch {
          return [k, '[unreadable]'];
        }
      });
    }
    const out = {};
    for (const [key, item] of entries) {
      if (isSecretKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      const copy = scrub(item, depth + 1, seen, maxString);
      if (copy !== undefined) out[key] = copy;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

// A deep copy of `value` made of plain JSON with every secret the rules
// know blanked. Never throws; a getter that throws becomes '[unreadable]'.
export function redact(value) {
  try {
    return scrub(value, 0, new Set(), 0);
  } catch (error) {
    return { redactError: String(error && error.message ? error.message : error) };
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function levelIndex(level) {
  if (typeof level !== 'string') return -1;
  const index = LEVEL_INDEX.get(level.toLowerCase());
  return index === undefined ? -1 : index;
}

function eventName(event) {
  if (typeof event === 'string' && event !== '') return event.slice(0, 40);
  return 'unknown';
}

function jobName(job) {
  return typeof job === 'string' && job !== '' ? redactText(job).slice(0, 80) : null;
}

function isoOf(ms) {
  if (Number.isFinite(ms)) {
    try {
      return new Date(ms).toISOString();
    } catch {
      // Out of the range a Date can hold; fall through to the real clock.
    }
  }
  return new Date().toISOString();
}

function positiveInt(value, fallback) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 1) return Math.floor(n);
  return fallback;
}

function positiveNumber(value, fallback) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n;
  return fallback;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The record's data: whatever was passed, redacted and clipped. Something
// that is not an object is kept under `value`, so a caller can log a
// string, an array or an Error without thinking about the shape.
function dataOf(data) {
  if (data === undefined || data === null) return deepFreeze({});
  let copy;
  try {
    copy = scrub(data, 0, new Set(), MAX_STRING);
  } catch (error) {
    copy = { redactError: String(error && error.message ? error.message : error) };
  }
  if (!isPlainObject(copy)) copy = { value: copy === undefined ? null : copy };
  return deepFreeze(copy);
}

// Only records that look like ours come back from storage; a corrupt entry
// is dropped rather than carried along. Their data is redacted once more,
// which is idempotent, in case an older version stored something looser.
function sanitize(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.records)) return [];
  const out = [];
  const seen = new Set();
  for (const r of raw.records) {
    if (!isPlainObject(r)) continue;
    if (!Number.isInteger(r.seq) || r.seq < 1 || seen.has(r.seq)) continue;
    if (typeof r.ts !== 'string' || !Number.isFinite(Date.parse(r.ts))) continue;
    const li = levelIndex(r.level);
    if (li < 0) continue;
    seen.add(r.seq);
    out.push(Object.freeze({
      seq: r.seq,
      ts: r.ts,
      level: LEVELS[li],
      event: eventName(r.event),
      job: jobName(r.job),
      msg: clipString(redactText(typeof r.msg === 'string' ? r.msg : String(r.msg ?? '')), MAX_STRING),
      data: dataOf(isPlainObject(r.data) ? r.data : {}),
    }));
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

// Logger = {
//   log(level, event, msg, data = {}, job = null): LogRecord | null,
//   debug(), info(), warn(), error(),       (event, msg, data?, job?)
//   records({ level?, event?, limit = 200, sinceSeq = 0 } = {}): LogRecord[],
//   exportText(): string,                   JSONL, oldest first, every kept record
//   clear(), load(), flush(): Promise<void>,
//   setLevel(level), setLimits({ maxRecords, maxAgeMs, maxBytes })
// }
//
//   now:      () => epoch ms
//   store:    { get(): Promise<any>, set(value): Promise<void> } bound to
//             'cswap.log' by the caller; null keeps the log in memory only
//   level:    the least level kept
//   maxBytes: the ring's size in storage, see MAX_BYTES
//   flushMs:  how long writes are gathered before one store.set; a warn or
//             an error is written at once, since those are what someone
//             reads after a crash
//   schedule: (fn, ms) => any, setTimeout in production
//   forward:  (record) => void, called synchronously for warn and error
//             (the worker sends them to the host as `event: log`)
//
// Storage is never written over blind: until one read has succeeded, or a
// write of ours has put a known snapshot there, what is stored is unknown
// and a flush waits (a read that failed is tried again by the next load()).
// A write the store refuses costs the oldest half of the ring, so the next
// one is smaller; nothing newer is lost, and a warn in the ring says so.
export function createLogger({
  now = Date.now,
  store = null,
  level = 'info',
  maxRecords = 2000,
  maxAgeMs = 72 * 3600000,
  maxBytes = MAX_BYTES,
  flushMs = 500,
  schedule = setTimeout,
  forward = null,
} = {}) {
  const storeOk = !!store && typeof store.get === 'function' && typeof store.set === 'function';
  const clock = typeof now === 'function' ? now : Date.now;
  let records = [];
  let nextSeq = 1;
  let minLevel = levelIndex(level);
  if (minLevel < 0) minLevel = LEVEL_INDEX.get('info');
  let maxCount = positiveInt(maxRecords, 2000);
  let maxAge = positiveNumber(maxAgeMs, 72 * 3600000);
  let maxSize = positiveNumber(maxBytes, MAX_BYTES);
  // The size of every record in the ring together, kept up to date where
  // the ring changes, so a write does not stringify the whole ring.
  let bytes = 0;
  let droppedTotal = 0;
  let lastNotice = null;
  let dirty = false;
  let scheduled = false;
  let loading = null;
  // Whether what is stored is known: read once, or written by us. A logger
  // without a store has nothing to learn.
  let known = !storeOk;
  let writing = Promise.resolve();
  const sizes = new WeakMap();

  function timeNow() {
    try {
      const t = clock();
      return Number.isFinite(t) ? t : Date.now();
    } catch {
      return Date.now();
    }
  }

  // A record's share of the stored JSON (its own text and the comma),
  // counted once per record object.
  function sizeOf(record) {
    let n = sizes.get(record);
    if (n === undefined) {
      try {
        n = JSON.stringify(record).length + 1;
      } catch {
        n = 0;
      }
      sizes.set(record, n);
    }
    return n;
  }

  function recount() {
    bytes = 0;
    for (const r of records) bytes += sizeOf(r);
  }

  // Oldest first by position, so the age check stops at the first record
  // young enough; a record stamped by a clock that went backwards is kept
  // with its neighbours rather than hunted down. The byte bound keeps the
  // newest record even when it alone is over it: a write the store then
  // refuses is dealt with where it fails.
  function trim(nowMs) {
    let drop = 0;
    let left = bytes;
    while (drop < records.length && nowMs - Date.parse(records[drop].ts) > maxAge) drop++;
    if (records.length - drop > maxCount) drop = records.length - maxCount;
    for (let i = 0; i < drop; i++) left -= sizeOf(records[i]);
    while (drop < records.length - 1 && left > maxSize) {
      left -= sizeOf(records[drop]);
      drop++;
    }
    if (drop > 0) {
      records = records.slice(drop);
      bytes = left;
      return true;
    }
    return false;
  }

  async function doLoad() {
    let raw;
    if (storeOk) {
      try {
        raw = await store.get();
      } catch {
        // What is stored is unknown, so nothing is written over it; memory
        // keeps everything logged so far, and load() lets the next call
        // read again.
        return false;
      }
    }
    known = true;
    const stored = sanitize(raw);
    if (stored.length) {
      // What was logged before the stored records were read comes after
      // them, renumbered, so seq stays one rising line across restarts.
      // The copies handed out before keep their old numbers.
      let seq = stored[stored.length - 1].seq + 1;
      const own = records.map(r => Object.freeze({ ...r, seq: seq++ }));
      records = stored.concat(own);
      nextSeq = seq;
      recount();
    }
    const trimmed = trim(timeNow());
    // What was stored is rewritten once when part of it was unusable or too
    // old, so storage holds a clean log again. Nothing stored means nothing
    // to rewrite, and records logged before this read are dirty already.
    const storedCount = isPlainObject(raw) && Array.isArray(raw.records) ? raw.records.length : -1;
    if (raw !== undefined && (trimmed || stored.length !== storedCount)) scheduleFlush();
    return true;
  }

  // One read at a time, shared by whoever asks while it runs; a read that
  // failed is forgotten once it is over, so the next load() tries again.
  function load() {
    if (!loading) {
      const attempt = doLoad().then(ok => {
        if (!ok && loading === attempt) loading = null;
      }, () => {
        if (!known && loading === attempt) loading = null;
      });
      loading = attempt;
    }
    return loading;
  }

  // Storage holds exactly what memory holds from here on, or memory is the
  // whole truth (after a clear): what is stored is known and no read is
  // owed any more, so a later load() must not merge it in a second time.
  function settled() {
    known = true;
    if (!loading) loading = Promise.resolve();
  }

  // The store refused the snapshot, and would refuse the same one again. The
  // oldest half goes, the byte bound comes down to what is left, and the
  // next flush is scheduled with the smaller ring. One warn says so; it is
  // put in the ring directly, since a log call would flush again, and it
  // replaces the previous one when that is still in the ring, so the ring
  // gets smaller with every refusal and the retries end. Nothing logged
  // after the refusal is lost. A snapshot at or under MIN_BYTES was not
  // refused for its size (the other keys of this extension are small): the
  // store is broken or closing, the ring stays whole in memory, and the
  // next record tries again.
  function shrink(error) {
    if (records.length <= 1 || bytes <= MIN_BYTES) return;
    const dropped = Math.ceil(records.length / 2);
    records = records.slice(dropped);
    if (lastNotice) {
      const at = records.indexOf(lastNotice);
      if (at >= 0) records.splice(at, 1);
    }
    recount();
    droppedTotal += dropped;
    maxSize = Math.max(MIN_BYTES, bytes);
    const notice = Object.freeze({
      seq: nextSeq++,
      ts: isoOf(timeNow()),
      level: 'warn',
      event: 'log',
      job: null,
      msg: `storage refused the log; the oldest ${dropped} records were dropped so the next write is smaller`,
      data: dataOf({ dropped, droppedTotal, kept: records.length, bytes, maxBytes: maxSize, error }),
    });
    records.push(notice);
    bytes += sizeOf(notice);
    lastNotice = notice;
    forwardRecord(notice);
    scheduleFlush();
  }

  // Writes what changed since the last successful write; a flush with
  // nothing new is free. Writes go one after another, so a snapshot can
  // never be overtaken by an older one. While what is stored is unknown
  // the write waits for a flush after a read that worked, except when the
  // caller says the ring is the whole truth (a clear).
  function persist(whole) {
    if (!storeOk) return Promise.resolve();
    const run = async () => {
      await load();
      if (!dirty) return;
      if (!known && !whole) return;
      dirty = false;
      const snapshot = { version: 1, records: records.slice() };
      try {
        await store.set(snapshot);
        settled();
      } catch (error) {
        dirty = true;
        shrink(error);
      }
    };
    writing = writing.then(run, run);
    return writing;
  }

  function flush() {
    return persist(false);
  }

  function scheduleFlush() {
    dirty = true;
    if (!storeOk || scheduled) return;
    scheduled = true;
    try {
      schedule(() => {
        scheduled = false;
        if (dirty) flush();
      }, flushMs);
    } catch {
      scheduled = false;
    }
  }

  function forwardRecord(record) {
    if (typeof forward !== 'function') return;
    try {
      forward(record);
    } catch {
      // The forwarder's error must not lose the record.
    }
  }

  function write(levelName, event, msg, data, job) {
    let li = levelIndex(levelName);
    if (li < 0) li = LEVEL_INDEX.get('info');
    if (li < minLevel) return null;
    const nowMs = timeNow();
    const record = Object.freeze({
      seq: nextSeq++,
      ts: isoOf(nowMs),
      level: LEVELS[li],
      event: eventName(event),
      job: jobName(job),
      msg: clipString(redactText(typeof msg === 'string' ? msg : String(msg)), MAX_STRING),
      data: dataOf(data),
    });
    records.push(record);
    bytes += sizeOf(record);
    trim(nowMs);
    dirty = true;
    if (li >= WARN) {
      forwardRecord(record);
      flush();
    } else {
      scheduleFlush();
    }
    return record;
  }

  // Never throws: a log call sits inside event handlers that must go on.
  function log(levelName, event, msg, data = {}, job = null) {
    try {
      return write(levelName, event, msg, data, job);
    } catch {
      return null;
    }
  }

  function list({ level: atLeast, event, limit = 200, sinceSeq = 0 } = {}) {
    const li = Math.max(0, levelIndex(atLeast));
    const events = event == null ? null : new Set(Array.isArray(event) ? event : [event]);
    const since = Number.isFinite(sinceSeq) ? sinceSeq : 0;
    let out = records.filter(r => (
      LEVEL_INDEX.get(r.level) >= li && (!events || events.has(r.event)) && r.seq > since
    ));
    const cap = positiveInt(limit, 0);
    if (cap > 0 && out.length > cap) out = out.slice(out.length - cap);
    return out;
  }

  // Every kept record as JSONL, oldest first: the panel's "Save log".
  function exportText() {
    const lines = list({ limit: 0 }).map(r => JSON.stringify(r));
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  // An empty log is the point, whatever is stored: the ring is the whole
  // truth without a read, and the write goes out even after a failed one.
  async function clear() {
    await load();
    records = [];
    bytes = 0;
    lastNotice = null;
    dirty = true;
    settled();
    await persist(true);
  }

  function setLevel(name) {
    const li = levelIndex(name);
    if (li >= 0) minLevel = li;
    return LEVELS[minLevel];
  }

  function setLimits({ maxRecords: count, maxAgeMs: age, maxBytes: size } = {}) {
    if (count !== undefined) maxCount = positiveInt(count, maxCount);
    if (age !== undefined) maxAge = positiveNumber(age, maxAge);
    if (size !== undefined) maxSize = positiveNumber(size, maxSize);
    if (trim(timeNow())) scheduleFlush();
    return { maxRecords: maxCount, maxAgeMs: maxAge, maxBytes: maxSize };
  }

  return {
    log,
    debug: (event, msg, data, job) => log('debug', event, msg, data, job),
    info: (event, msg, data, job) => log('info', event, msg, data, job),
    warn: (event, msg, data, job) => log('warn', event, msg, data, job),
    error: (event, msg, data, job) => log('error', event, msg, data, job),
    records: list,
    exportText,
    clear,
    load,
    flush,
    setLevel,
    setLimits,
  };
}
