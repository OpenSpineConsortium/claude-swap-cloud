// The request gate of the Claude Swap Cloud extension.
//
// Every request the unchanged import script makes in the claude.ai tab asks
// this gate for a permit first and reports its outcome afterwards. The gate
// lets one request run at a time, keeps a fixed minimum spacing (one before a
// read, one before a write) between the end of one and the start of the
// next, waits out the site's Retry-After in full, and stops ("holds") a step
// where the script would otherwise give up, where a create failed, or where
// the response was a challenge, a block or a sign-out, so that the person
// can press Retry, Give up or Resume in the side panel. Nothing here retries
// a request by itself; the only automatic traffic is the script's own
// back-off for 5xx and 429, which the gate lets through unchanged.
//
// Every wait is a timestamp in the state, never a live timer: `wake` only
// asks the caller to run reevaluate() no earlier than a point in time, and a
// late or lost wake changes nothing, because the next permit or report
// re-evaluates. Every transition is persisted through the injected store
// before any promise resolves or onChange fires, so a service-worker restart
// loses nothing: the page re-sends what was unanswered, and `answers` give
// the same reply again.
//
// This module is pure: no timers, no randomness, no browser APIs, no fetch.
// The clock, the wake scheduler, the store, the config reader, the response
// classifier and the logger are all injected, which is what makes it
// testable with a fake clock in milliseconds.

export const GATE_VERSION = 1;
// The defaults when the worker hands over no usable spacing; config.js has
// the same two numbers and says why they differ.
export const READ_SPACING_DEFAULT_MS = 0;
export const WRITE_SPACING_DEFAULT_MS = 500;

// The script gives up on a step after SLOW_DOWN_WAITS.length (8) retries of a
// 429 and, for a request it may send again, after RETRY_WAITS.length (3)
// retries of a 5xx or a lost reply, so the 9th consecutive 429 and the 4th
// consecutive failure of one step are held for the person instead of being
// handed back to the script. The tests read both arrays out of
// project-import.js and check these numbers.
export const HOLD_AFTER_SLOW_DOWNS = 9;
export const HOLD_AFTER_FAILURES = 4;

// The statuses the script retries by itself (its RETRY_STATUS). Any other 5xx
// makes the script give up at once, so the gate holds those on the first
// attempt: the file would otherwise be recorded as "not added" without the
// person ever being asked.
export const RETRY_STATUSES = new Set([500, 502, 503, 504, 529]);

// The requests the script sends only once (its `repeatable: false`): a
// create, and the document and file POSTs of a standard project, where a
// second send could leave a duplicate behind. On their first 5xx or lost
// reply the script gives up at once, so the gate holds that first failure
// for the person, who can see whether the site acted. The code project's
// uploads and files:write, and every PUT and PATCH, are repeatable and the
// script retries them by itself up to the thresholds above. The tests read
// the script's call sites and check these lists against them.
export const CREATE_PATHS = [/^\/api\/organizations\/[^/]+\/projects$/, /^\/v1\/code\/channels$/];
export const UNREPEATABLE_PATHS = [/^\/api\/organizations\/[^/]+\/projects\/[^/]+\/(docs|upload)$/];

export const PHASES = ['idle', 'ready', 'waiting', 'in-flight', 'held', 'paused', 'cancelled', 'done', 'failed'];
export const TERMINAL_PHASES = ['cancelled', 'done', 'failed'];
export const WAIT_REASONS = ['spacing', 'retry-after', 'script-backoff', 'paused', 'held', 'interrupted'];
export const HOLD_REASONS = ['interrupted', 'failed-step', 'long-wait'];
export const OUTCOMES = ['ok', 'slow-down', 'server-error', 'network', 'interrupted', 'refused', 'held'];

export const RECENT_MAX = 50;
export const STEPS_MAX = 200;
export const ANSWERS_MAX = 20;

export const DEFAULT_RETRY_AFTER_CAP_MS = 900000;
const SPACING_MAX_MS = 60000;
const RETRY_AFTER_CAP_MIN_MS = 60000;
const RETRY_AFTER_CAP_MAX_MS = 86400000;

// The only response headers that may appear in the state or the log. A copy
// of protocol.js's HEADER_ALLOWLIST: this module imports nothing so that it
// runs alone under node --test.
const HEADER_ALLOWLIST = ['retry-after', 'content-type', 'content-length', 'cf-mitigated', 'cf-ray', 'server', 'server-timing', 'location', 'date'];

const TEXT_MAX = 200;

// The last line of defence for free text the gate keeps (a body excerpt, an
// error message, an interruption's evidence): the page and the interrupt
// module redact before the gate sees anything, but a secret must never
// survive a bug in either.
const SCRUB_RES = [
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

// ------------------------------------------------------------------
// Small pure helpers, exported where other modules or tests want them.
// ------------------------------------------------------------------

export function scrubText(text) {
  let out = String(text);
  for (const [re, to] of SCRUB_RES) out = out.replace(re, to);
  return out;
}

function clip(text, max = TEXT_MAX) {
  const s = scrubText(text);
  return s.length > max ? s.slice(0, max) : s;
}

// The pathname of a path or URL, without query or fragment; '' when there is
// nothing usable. Query strings never enter the state (except inside the
// stepKey the page computed, where the script's fixed queries tell steps
// apart).
export function pathOnly(value) {
  if (typeof value !== 'string') return '';
  let s = value.trim();
  if (/^https?:\/\//i.test(s)) {
    const m = /^https?:\/\/[^/?#]*([^?#]*)/i.exec(s);
    s = m ? m[1] || '/' : '';
  }
  const cut = s.search(/[?#]/);
  return cut >= 0 ? s.slice(0, cut) : s;
}

// A request that only reads: a GET or a HEAD. Anything else is spaced as a
// write; the worker hands an export job its read spacing for both, because
// an export's few POSTs only read.
export function isRead(method) {
  const m = String(method == null || method === '' ? 'GET' : method).toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

// 'create' for the one request a job may send once, 'unrepeatable' for the
// others the script never retries by itself, 'other' for the rest.
export function classifyRequest(method, path) {
  if (String(method == null ? '' : method).toUpperCase() !== 'POST') return 'other';
  const p = pathOnly(path);
  if (CREATE_PATHS.some(re => re.test(p))) return 'create';
  if (UNREPEATABLE_PATHS.some(re => re.test(p))) return 'unrepeatable';
  return 'other';
}

// Retry-After as milliseconds to wait from `nowMs`: delta-seconds or an
// HTTP-date. A date in the past is 0, not null: the site did answer. Nothing
// is capped here: a very long wait becomes a visible hold, and the full wait
// is still honoured after Resume.
export function parseRetryAfter(value, nowMs) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text === '') return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const ms = Math.round(Number(text) * 1000);
    return Number.isFinite(ms) ? ms : null;
  }
  // An HTTP-date always has letters in it (the month, GMT); an ISO date has
  // the year first. Anything else is not a date, whatever Date.parse makes
  // of it.
  if (!/[A-Za-z]/.test(text) && !/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  const base = Number.isFinite(nowMs) ? nowMs : 0;
  return Math.max(0, at - base);
}

export function stepKeyOf({ method, path, bodySig } = {}) {
  const m = String(method == null || method === '' ? 'GET' : method).toUpperCase();
  const p = typeof path === 'string' ? path : '';
  const b = bodySig == null ? '' : String(bodySig);
  return `${m} ${p} ${b}`;
}

export function isTerminal(phase) {
  return TERMINAL_PHASES.includes(phase);
}

function freshCounters() {
  return { requests: 0, ok: 0, slowDowns: 0, serverErrors: 0, networkErrors: 0, interruptions: 0, held: 0, probes: 0, waitedMs: 0 };
}

// The state of a gate that has no job. `lastPermit` numbers the permits
// (`p<n>`), `lastSeq` the grants (`seq`): a held permit keeps its id across
// re-asks but every grant is a new request. `release` remembers Retry or
// Give up pressed before the page's re-ask arrived, which happens when the
// page is slow or reconnecting.
export function freshState(jobId = null) {
  return {
    version: GATE_VERSION,
    jobId,
    phase: jobId == null ? 'idle' : 'ready',
    pausedBy: null,
    wait: null,
    notBefore: 0,
    lastEndedAt: null,
    lastSeq: 0,
    lastPermit: 0,
    inFlight: null,
    pending: [],
    held: null,
    release: null,
    created: null,
    steps: {},
    answers: {},
    counters: freshCounters(),
    recent: [],
  };
}

// ------------------------------------------------------------------
// Validation of what comes in: from the page (through the worker), from the
// store, from the config. Malformed input from code is a TypeError with a
// plain message; malformed data from storage is dropped with a warning.
// ------------------------------------------------------------------

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = v => Number.isInteger(v);
const str = (v, max = 300) => (typeof v === 'string' ? (v.length > max ? v.slice(0, max) : v) : null);

function needString(value, name, where) {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${where}: ${name} must be a non-empty string`);
  return value;
}

function toStatus(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 999 ? n : 0;
}

function pickHeaders(headersLike) {
  const out = {};
  if (!headersLike || typeof headersLike !== 'object') return out;
  let entries;
  try {
    entries = typeof headersLike.entries === 'function' && !Array.isArray(headersLike)
      ? Array.from(headersLike.entries())
      : Object.entries(headersLike);
  } catch {
    return out;
  }
  for (const pair of entries) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
    const key = pair[0].toLowerCase();
    if (!HEADER_ALLOWLIST.includes(key)) continue;
    const value = pair[1] == null ? '' : String(pair[1]);
    out[key] = key === 'location' ? pathOnly(value) : clip(value, 500);
  }
  return out;
}

function toStringList(value, maxItems = 50, maxLen = 100) {
  if (!Array.isArray(value)) return [];
  return value.filter(x => typeof x === 'string').slice(0, maxItems).map(x => clip(x, maxLen));
}

function reduceErrorJson(bodyJson) {
  if (!isObj(bodyJson) || !isObj(bodyJson.error)) return null;
  const e = bodyJson.error;
  const out = {};
  for (const k of ['type', 'message', 'reason']) if (typeof e[k] === 'string') out[k] = clip(e[k]);
  return { error: out };
}

function reduceError(error) {
  if (error == null) return null;
  if (typeof error === 'string') return { name: 'Error', message: clip(error) };
  if (!isObj(error) && !(error instanceof Error)) return { name: 'Error', message: clip(String(error)) };
  return { name: clip(error.name == null ? 'Error' : String(error.name), 60), message: clip(error.message == null ? '' : String(error.message)) };
}

function reduceCreated(created) {
  if (!isObj(created)) return null;
  const out = {};
  for (const k of ['id', 'url', 'name']) out[k] = typeof created[k] === 'string' ? clip(created[k], 500) : null;
  return out;
}

// What an interruption looks like inside the gate's state: the kind, the two
// texts and evidence limited to the allowlisted shape. Whatever the
// classifier put there besides that is dropped.
const EVIDENCE_KEYS = ['status', 'headers', 'markers', 'finalPath', 'redirected', 'bodyExcerpt', 'expected', 'actual', 'method', 'path', 'requestId', 'stepKey', 'attempt'];

function reduceEvidence(evidence) {
  const out = {};
  if (!isObj(evidence)) return out;
  for (const k of EVIDENCE_KEYS) {
    const v = evidence[k];
    if (v === undefined) continue;
    if (k === 'headers') out.headers = pickHeaders(v);
    else if (k === 'markers') out.markers = toStringList(v);
    else if (k === 'path' || k === 'finalPath') out[k] = pathOnly(v);
    else if (typeof v === 'string') out[k] = clip(v, k === 'bodyExcerpt' ? TEXT_MAX : 300);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (v === null) out[k] = null;
  }
  return out;
}

function reduceInterruption(x, fallbackKind) {
  if (!isObj(x)) return fallbackKind ? { kind: String(fallbackKind), what: '', todo: '', resumable: true, evidence: {} } : null;
  const out = {
    kind: typeof x.kind === 'string' ? clip(x.kind, 40) : String(fallbackKind || 'unknown'),
    what: typeof x.what === 'string' ? clip(x.what, 500) : '',
    todo: typeof x.todo === 'string' ? clip(x.todo, 500) : '',
    resumable: x.resumable !== false,
    evidence: reduceEvidence(x.evidence),
  };
  if (typeof x.id === 'string') out.id = clip(x.id, 40);
  if (typeof x.at === 'number' && Number.isFinite(x.at)) out.at = x.at;
  return out;
}

function validatePermit(req) {
  const where = 'gate.permit';
  if (!isObj(req)) throw new TypeError(`${where}: expected an object`);
  const requestId = needString(req.requestId, 'requestId', where);
  const stepKey = needString(req.stepKey, 'stepKey', where);
  const method = String(req.method == null || req.method === '' ? 'GET' : req.method).toUpperCase();
  const path = pathOnly(req.path);
  if (path === '') throw new TypeError(`${where}: path must be a non-empty string`);
  if (req.kind !== undefined && req.kind !== 'script' && req.kind !== 'probe') throw new TypeError(`${where}: kind must be 'script' or 'probe'`);
  const kind = req.kind === 'probe' ? 'probe' : 'script';
  const bytes = Number(req.bodyBytes);
  const bodyBytes = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  const retryOf = req.retryOf == null ? null : needString(req.retryOf, 'retryOf', where);
  return { requestId, stepKey, method, path, kind, bodyBytes, retryOf };
}

function validateReport(rep) {
  const where = 'gate.report';
  if (!isObj(rep)) throw new TypeError(`${where}: expected an object`);
  const requestId = needString(rep.requestId, 'requestId', where);
  const permit = needString(rep.permit, 'permit', where);
  const headers = pickHeaders(rep.headers);
  const status = toStatus(rep.status);
  const elapsed = Number(rep.elapsedMs);
  const bodyExcerpt = typeof rep.bodyExcerpt === 'string' ? clip(rep.bodyExcerpt) : null;
  return {
    requestId,
    permit,
    status,
    ok: rep.ok === undefined ? status >= 200 && status < 300 : Boolean(rep.ok),
    redirected: Boolean(rep.redirected),
    finalPath: pathOnly(rep.finalPath),
    headers,
    elapsedMs: Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : null,
    markers: toStringList(rep.markers),
    bodyJson: reduceErrorJson(rep.bodyJson),
    bodyExcerpt,
    error: reduceError(rep.error),
    created: reduceCreated(rep.created),
  };
}

// A spacing the worker handed over, clamped to its bounds; nothing usable
// (missing, null, empty or not a number) is the default, never 0.
function spacingValue(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(SPACING_MAX_MS, Math.max(0, Math.round(n))) : fallback;
}

function validateConfig(raw) {
  const out = { readSpacingMs: READ_SPACING_DEFAULT_MS, writeSpacingMs: WRITE_SPACING_DEFAULT_MS, retryAfterCapMs: DEFAULT_RETRY_AFTER_CAP_MS };
  if (!isObj(raw)) return out;
  out.readSpacingMs = spacingValue(raw.readSpacingMs, READ_SPACING_DEFAULT_MS);
  out.writeSpacingMs = spacingValue(raw.writeSpacingMs, WRITE_SPACING_DEFAULT_MS);
  const c = Number(raw.retryAfterCapMs);
  if (Number.isFinite(c)) out.retryAfterCapMs = Math.min(RETRY_AFTER_CAP_MAX_MS, Math.max(RETRY_AFTER_CAP_MIN_MS, Math.round(c)));
  return out;
}

const msOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nonNegInt = (v, d = 0) => (isInt(v) && v >= 0 ? v : d);

function sanitizePending(entry) {
  if (!isObj(entry)) return null;
  if (typeof entry.permit !== 'string' || typeof entry.requestId !== 'string' || typeof entry.stepKey !== 'string') return null;
  const path = pathOnly(entry.path);
  if (!entry.permit || !entry.requestId || !entry.stepKey || !path) return null;
  return {
    permit: entry.permit,
    requestId: entry.requestId,
    seq: msOrNull(entry.seq),
    stepKey: entry.stepKey,
    method: String(entry.method || 'GET').toUpperCase(),
    path,
    kind: entry.kind === 'probe' ? 'probe' : 'script',
    retryOf: typeof entry.retryOf === 'string' && entry.retryOf ? entry.retryOf : null,
    askedAt: nonNegInt(entry.askedAt),
  };
}

function sanitizeInFlight(x) {
  if (!isObj(x)) return null;
  const base = sanitizePending(x);
  if (!base) return null;
  return {
    permit: base.permit,
    requestId: base.requestId,
    seq: nonNegInt(x.seq),
    stepKey: base.stepKey,
    method: base.method,
    path: base.path,
    kind: base.kind,
    startedAt: nonNegInt(x.startedAt),
    attempt: nonNegInt(x.attempt, 1),
  };
}

// A hold names the request it parked (permit, requestId, stepKey, method,
// path), or names none when the worker held the gate for an interruption
// it saw outside a response; such a hold is always 'interrupted'.
function sanitizeHeld(x) {
  if (!isObj(x)) return null;
  if (!HOLD_REASONS.includes(x.reason)) return null;
  const named = typeof x.permit === 'string' && x.permit !== '';
  if (!named && (x.permit != null || x.reason !== 'interrupted')) return null;
  if (named && (typeof x.requestId !== 'string' || typeof x.stepKey !== 'string')) return null;
  return {
    permit: named ? x.permit : null,
    requestId: named ? x.requestId : null,
    stepKey: named ? x.stepKey : null,
    method: named ? String(x.method || 'GET').toUpperCase() : null,
    path: named ? pathOnly(x.path) : null,
    reason: x.reason,
    interruption: x.interruption == null ? null : reduceInterruption(x.interruption, null),
    status: toStatus(x.status),
    attempt: nonNegInt(x.attempt, named ? 1 : 0),
    heldAt: nonNegInt(x.heldAt),
  };
}

function sanitizeRelease(x) {
  if (!isObj(x) || typeof x.permit !== 'string' || !x.permit) return null;
  if (x.action !== 'retry' && x.action !== 'give-up' && x.action !== 'resume') return null;
  return { permit: x.permit, action: x.action, at: nonNegInt(x.at) };
}

// Whether the create a job permitted may have made a project: it has not
// answered yet, its answer never came back, or it answered with anything
// but a 4xx. Only a 4xx means the site turned it away without acting on
// it; a 2xx whose body gave no id still made one. The safeguard that one
// job creates one project rests on this, and the worker reads it as
// created.mayHaveActed in the snapshot rather than testing created.id.
export function createMayHaveActed(created) {
  if (!isObj(created)) return false;
  if (created.pending || created.status == null) return true;
  return !(created.status >= 400 && created.status < 500);
}

function sanitizeCreated(x) {
  if (!isObj(x) || typeof x.permit !== 'string' || !x.permit) return null;
  const out = {
    permit: x.permit,
    at: nonNegInt(x.at),
    pending: Boolean(x.pending),
    status: x.status == null ? null : toStatus(x.status),
    id: str(x.id, 200),
    url: str(x.url, 500),
  };
  out.mayHaveActed = createMayHaveActed(out);
  return out;
}

function sanitizeStep(x) {
  if (!isObj(x)) return null;
  const state = ['pending', 'running', 'waiting', 'failed', 'done', 'held'].includes(x.state) ? x.state : 'pending';
  return {
    attempts: nonNegInt(x.attempts),
    consecutive429: nonNegInt(x.consecutive429),
    consecutiveFailures: nonNegInt(x.consecutiveFailures),
    firstAt: nonNegInt(x.firstAt),
    lastAt: nonNegInt(x.lastAt),
    lastStatus: x.lastStatus == null ? null : toStatus(x.lastStatus),
    state,
  };
}

function sanitizeAnswer(x) {
  if (!isObj(x)) return null;
  const out = { at: nonNegInt(x.at) };
  if (isObj(x.permit) && typeof x.permit.ok === 'boolean') out.permit = JSON.parse(JSON.stringify(x.permit));
  if (isObj(x.report) && typeof x.report.action === 'string') out.report = JSON.parse(JSON.stringify(x.report));
  return out.permit || out.report ? out : null;
}

function sanitizeRecord(x) {
  if (!isObj(x) || typeof x.permit !== 'string' || typeof x.requestId !== 'string' || typeof x.stepKey !== 'string') return null;
  return {
    seq: nonNegInt(x.seq),
    permit: x.permit,
    requestId: x.requestId,
    stepKey: x.stepKey,
    method: String(x.method || 'GET').toUpperCase(),
    path: pathOnly(x.path),
    kind: x.kind === 'probe' ? 'probe' : 'script',
    attempt: nonNegInt(x.attempt, 1),
    status: toStatus(x.status),
    outcome: OUTCOMES.includes(x.outcome) ? x.outcome : 'ok',
    startedAt: nonNegInt(x.startedAt),
    endedAt: nonNegInt(x.endedAt),
    elapsedMs: msOrNull(x.elapsedMs),
    retryAfterMs: msOrNull(x.retryAfterMs),
  };
}

// A persisted state made safe to use, or null when it is not a gate state at
// all. Each nested item is checked on its own, so one bad entry does not
// throw the rest away; the derived fields (phase, wait) are recomputed by
// the gate after loading.
export function sanitizeState(raw) {
  if (!isObj(raw) || raw.version !== GATE_VERSION) return null;
  if (raw.jobId !== null && (typeof raw.jobId !== 'string' || raw.jobId === '')) return null;
  const s = freshState(raw.jobId);
  s.phase = PHASES.includes(raw.phase) ? raw.phase : s.phase;
  if (s.jobId == null) s.phase = 'idle';
  else if (s.phase === 'idle') s.phase = 'ready';
  s.pausedBy = raw.pausedBy === 'person' ? 'person' : null;
  if (isObj(raw.wait) && WAIT_REASONS.includes(raw.wait.reason)) {
    s.wait = { reason: raw.wait.reason, since: nonNegInt(raw.wait.since), until: msOrNull(raw.wait.until) };
  }
  s.notBefore = nonNegInt(raw.notBefore);
  s.lastEndedAt = msOrNull(raw.lastEndedAt);
  s.lastSeq = nonNegInt(raw.lastSeq);
  s.lastPermit = nonNegInt(raw.lastPermit);
  s.inFlight = sanitizeInFlight(raw.inFlight);
  s.pending = Array.isArray(raw.pending) ? raw.pending.map(sanitizePending).filter(Boolean) : [];
  s.held = sanitizeHeld(raw.held);
  s.release = sanitizeRelease(raw.release);
  s.created = sanitizeCreated(raw.created);
  if (isObj(raw.steps)) {
    for (const [key, value] of Object.entries(raw.steps)) {
      const step = sanitizeStep(value);
      if (step && typeof key === 'string' && key) s.steps[key] = step;
    }
  }
  if (isObj(raw.answers)) {
    for (const [key, value] of Object.entries(raw.answers)) {
      const answer = sanitizeAnswer(value);
      if (answer && key) s.answers[key] = answer;
    }
  }
  if (isObj(raw.counters)) {
    for (const key of Object.keys(s.counters)) s.counters[key] = nonNegInt(raw.counters[key]);
  }
  s.recent = Array.isArray(raw.recent) ? raw.recent.map(sanitizeRecord).filter(Boolean).slice(-RECENT_MAX) : [];
  // The permit and seq counters must stay ahead of every id in the state, or
  // a restart could hand out an id twice.
  const nums = [];
  for (const e of [...s.pending, s.inFlight, s.held, s.created, ...s.recent]) {
    if (e && typeof e.permit === 'string') {
      const m = /^p(\d+)$/.exec(e.permit);
      if (m) nums.push(Number(m[1]));
    }
  }
  s.lastPermit = Math.max(s.lastPermit, ...nums, 0);
  s.lastSeq = Math.max(s.lastSeq, ...s.recent.map(r => r.seq), s.inFlight ? s.inFlight.seq : 0, 0);
  return s;
}

// ------------------------------------------------------------------
// The gate.
// ------------------------------------------------------------------

function noop() {}

function safeLogger(log) {
  const call = level => (event, msg, data, job) => {
    try {
      if (log && typeof log[level] === 'function') log[level](event, msg, data, job);
    } catch {
      // A logger that throws must not stop the gate.
    }
  };
  return { debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error') };
}

// What the gate does with a response when no classifier is injected or the
// injected one throws: the two signals it must never get wrong on its own
// (the site saying slow down, and Cloudflare saying challenge) and pass for
// everything else, which hands the response to the script unchanged.
export function fallbackClassify(rep) {
  const headers = rep && isObj(rep.headers) ? rep.headers : {};
  if (String(headers['cf-mitigated'] || '').toLowerCase() === 'challenge') {
    return {
      verdict: 'interrupt',
      kind: 'challenge',
      interruption: { kind: 'challenge', what: 'claude.ai asked this browser to pass a Cloudflare check.', todo: 'Complete it in a new tab of this profile, then press Resume.', evidence: { status: rep.status, headers } },
      evidence: { status: rep.status, headers },
    };
  }
  if (rep && rep.status === 429) return { verdict: 'slow-down', evidence: { status: 429, headers } };
  if (rep && rep.status === 0 && rep.error) return { verdict: 'network', evidence: { error: rep.error } };
  return { verdict: 'pass', evidence: {} };
}

export function createGate({ now, wake, store, config, classify, log, onChange } = {}) {
  if (typeof now !== 'function') throw new TypeError('createGate: now must be a function returning milliseconds');
  if (typeof wake !== 'function') throw new TypeError('createGate: wake must be a function (atMs, fn) => cancel');
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') throw new TypeError('createGate: store must have get() and set(state)');
  const readConfig = typeof config === 'function' ? config : () => ({});
  const classifier = typeof classify === 'function' ? classify : fallbackClassify;
  const logger = safeLogger(log);
  const changed = typeof onChange === 'function' ? onChange : noop;

  let state = freshState();
  let loaded = false;
  let chain = Promise.resolve();
  let armed = null; // { at, cancel } of the one scheduled wake
  const waiters = new Map(); // 'permit:<requestId>' -> [resolve]
  let clockWarned = false;

  // --- plumbing -----------------------------------------------------

  // Public operations run one at a time: each one changes the state, awaits
  // the store, then resolves what it answered. Interleaving two of them
  // across that await would let a report see a half-made transition.
  function run(fn) {
    const next = chain.then(fn, fn);
    chain = next.then(noop, noop);
    return next;
  }

  const clock = () => {
    const t = Number(now());
    return Number.isFinite(t) ? t : 0;
  };

  const cfg = () => {
    try {
      return validateConfig(readConfig());
    } catch {
      return validateConfig(null);
    }
  };

  const snapshot = () => JSON.parse(JSON.stringify(state));
  const terminal = () => isTerminal(state.phase);
  const job = () => state.jobId;

  function newTx() {
    return { changes: [], resolves: [] };
  }

  async function commit(tx) {
    const snap = snapshot();
    try {
      await store.set(snap);
    } catch (e) {
      logger.error('gate', 'could not persist the gate state', { error: String((e && e.message) || e) }, job());
    }
    for (const resolve of tx.resolves) resolve();
    for (const change of tx.changes) {
      try {
        changed(snap, change);
      } catch (e) {
        logger.error('gate', 'onChange threw', { type: change.type, error: String((e && e.message) || e) }, job());
      }
    }
  }

  function stepOf(key, at) {
    let step = state.steps[key];
    if (!step) {
      step = { attempts: 0, consecutive429: 0, consecutiveFailures: 0, firstAt: at, lastAt: at, lastStatus: null, state: 'pending' };
      state.steps[key] = step;
      trimSteps();
    }
    return step;
  }

  function trimSteps() {
    const keys = Object.keys(state.steps);
    if (keys.length <= STEPS_MAX) return;
    const keep = new Set([...state.pending.map(p => p.stepKey), state.inFlight && state.inFlight.stepKey, state.held && state.held.stepKey].filter(Boolean));
    keys.filter(k => !keep.has(k)).sort((a, b) => state.steps[a].lastAt - state.steps[b].lastAt).slice(0, keys.length - STEPS_MAX).forEach(k => delete state.steps[k]);
  }

  function trimAnswers() {
    const keys = Object.keys(state.answers);
    if (keys.length <= ANSWERS_MAX) return;
    keys.sort((a, b) => state.answers[a].at - state.answers[b].at).slice(0, keys.length - ANSWERS_MAX).forEach(k => delete state.answers[k]);
  }

  function pushRecent(record) {
    state.recent.push(record);
    if (state.recent.length > RECENT_MAX) state.recent.splice(0, state.recent.length - RECENT_MAX);
  }

  function waiterKey(requestId) {
    return `permit:${requestId}`;
  }

  function addWaiter(requestId) {
    return new Promise(resolve => {
      const key = waiterKey(requestId);
      if (!waiters.has(key)) waiters.set(key, []);
      waiters.get(key).push(resolve);
    });
  }

  // Records an answer so that a repeated ask gets the same reply, and wakes
  // whoever waits for it, after the commit.
  function remember(requestId, which, result, tx) {
    const slot = state.answers[requestId] || { at: 0 };
    slot[which] = JSON.parse(JSON.stringify(result));
    slot.at = clock();
    state.answers[requestId] = slot;
    trimAnswers();
    if (which === 'permit') {
      const key = waiterKey(requestId);
      const list = waiters.get(key);
      if (list) {
        waiters.delete(key);
        for (const resolve of list) tx.resolves.push(() => resolve(JSON.parse(JSON.stringify(result))));
      }
    }
  }

  function refuse(entry, reason, tx) {
    state.pending = state.pending.filter(e => e !== entry);
    remember(entry.requestId, 'permit', { ok: false, reason }, tx);
    tx.changes.push({ type: 'refused', permit: entry.permit, requestId: entry.requestId, stepKey: entry.stepKey, reason });
    logger.info('gate', `permit refused: ${reason}`, { permit: entry.permit, requestId: entry.requestId, stepKey: entry.stepKey, reason }, job());
  }

  // --- the timing rules ---------------------------------------------

  // The spacing a request waits for: the one before a read for a GET or a
  // HEAD, the one before a write for anything else. The gate looks only at
  // the method; the worker has already picked the pair for the job's kind.
  function spacingFor(entry) {
    const c = cfg();
    return isRead(entry && entry.method) ? c.readSpacingMs : c.writeSpacingMs;
  }

  // The spacing is measured from the end of the previous request. When the
  // clock has gone backwards since then, that end is moved to now, once and
  // for good (the next commit persists it), so a clock change delays the
  // next request by at most one full spacing instead of chasing a moving
  // target.
  function spacingAt(entry) {
    const t = clock();
    if (state.lastEndedAt == null) return -Infinity;
    if (state.lastEndedAt > t) {
      if (!clockWarned) {
        clockWarned = true;
        logger.warn('gate', 'the clock went backwards; spacing is counted from now', { lastEndedAt: state.lastEndedAt, now: t }, job());
      }
      state.lastEndedAt = t;
    }
    return state.lastEndedAt + spacingFor(entry);
  }

  // t = max(lastEndedAt + the spacing for this request, notBefore): a fixed
  // spacing and the site's own Retry-After, whichever ends later. Never
  // randomized; a spacing of 0 is still a fixed one, and a grant it allows
  // at once needs no wake at all.
  function grantTime(entry) {
    return Math.max(spacingAt(entry), state.notBefore);
  }

  // A held re-ask waits for the person whatever its kind; probes are granted
  // while paused or held because they are part of Resume; everything else
  // waits while paused or held.
  function grantable(entry) {
    if (state.held && state.held.permit != null && entry.retryOf === state.held.permit) return false;
    if (entry.kind === 'probe') return true;
    return !state.held && !state.pausedBy;
  }

  function nextGrantable() {
    if (terminal() || state.inFlight) return null;
    return state.pending.find(grantable) || null;
  }

  const mayHaveActed = () => createMayHaveActed(state.created);

  // Keeps created.mayHaveActed true to the rest of `created`, for the
  // worker, which reads the snapshot.
  function noteCreated() {
    if (state.created) state.created.mayHaveActed = createMayHaveActed(state.created);
  }

  // --- transitions --------------------------------------------------

  function grant(entry, tx) {
    const t = clock();
    state.pending = state.pending.filter(e => e !== entry);
    const step = stepOf(entry.stepKey, t);
    step.attempts += 1;
    step.state = 'running';
    step.lastAt = t;
    const seq = ++state.lastSeq;
    const waitedMs = Math.max(0, t - entry.askedAt);
    state.counters.waitedMs += waitedMs;
    state.inFlight = {
      permit: entry.permit,
      requestId: entry.requestId,
      seq,
      stepKey: entry.stepKey,
      method: entry.method,
      path: entry.path,
      kind: entry.kind,
      startedAt: t,
      attempt: step.attempts,
    };
    if (entry.kind === 'script' && classifyRequest(entry.method, entry.path) === 'create') {
      // Persisted (by the commit that follows) before the permit resolves:
      // after a restart the gate knows a create may have gone out even when
      // its report never came back.
      if (state.created && state.created.permit === entry.permit) {
        state.created.pending = true;
        state.created.at = t;
      } else {
        state.created = { permit: entry.permit, at: t, pending: true, status: null, id: null, url: null };
      }
      noteCreated();
    }
    if (entry.retryOf) state.release = null;
    const result = { ok: true, permit: entry.permit, attempt: step.attempts, seq, waitedMs };
    remember(entry.requestId, 'permit', result, tx);
    tx.changes.push({ type: 'grant', permit: entry.permit, requestId: entry.requestId, seq, stepKey: entry.stepKey, method: entry.method, path: entry.path, kind: entry.kind, attempt: step.attempts, waitedMs });
    logger.debug('request', 'permit granted', { permit: entry.permit, requestId: entry.requestId, seq, method: entry.method, path: entry.path, kind: entry.kind, attempt: step.attempts, waitedMs }, job());
  }

  function tryGrant(tx) {
    const entry = nextGrantable();
    if (!entry) return;
    const t = grantTime(entry);
    if (clock() < t) {
      const step = state.steps[entry.stepKey];
      if (step && step.state === 'pending') step.state = 'waiting';
      return;
    }
    grant(entry, tx);
  }

  // Parks a request for the person. When the worker already holds the gate
  // for an interruption it saw outside a response (a hold that names no
  // request), the request joins that hold instead of replacing it: the
  // hold stays 'interrupted', so Resume, after the worker's probes, is the
  // way out, and the request is sent again only then.
  function setHold(tx, { reason, permit, requestId, stepKey, method, path, status, attempt, interruption }) {
    const t = clock();
    const joined = Boolean(state.held && state.held.permit == null && permit != null);
    if (joined) {
      reason = state.held.reason;
      interruption = interruption || state.held.interruption;
      Object.assign(state.held, { permit, requestId, stepKey, method, path, status, attempt, interruption });
    } else {
      state.held = { permit, requestId, stepKey, method, path, reason, interruption: interruption || null, status, attempt, heldAt: t };
      state.counters.held += 1;
    }
    state.release = null;
    const step = stepKey == null ? null : state.steps[stepKey];
    if (step) step.state = 'held';
    const change = { type: 'held', reason, permit, requestId, stepKey, method, path, status, attempt };
    if (interruption) change.kind = interruption.kind;
    if (joined) change.joined = true;
    tx.changes.push(change);
    logger.warn('held', joined ? `request joined the hold: ${reason}` : `step held: ${reason}`, { reason, permit, requestId, stepKey, method, path, status, attempt, kind: interruption ? interruption.kind : undefined }, job());
    const answer = { action: 'hold', reason };
    if (interruption) answer.interruption = interruption;
    return answer;
  }

  function releaseHold(action, tx) {
    const held = state.held;
    if (!held) return;
    state.held = null;
    const step = state.steps[held.stepKey];
    if (step) {
      if (action === 'give-up') {
        step.consecutive429 = 0;
        step.consecutiveFailures = 0;
        step.state = 'failed';
      } else {
        step.state = 'pending';
      }
    }
    // A hold that names no request has no re-ask to answer and nothing to
    // remember: releasing it only opens the gate again.
    const reask = held.permit == null ? null : state.pending.find(e => e.retryOf === held.permit);
    if (action === 'give-up') {
      if (reask) refuse(reask, 'give-up', tx);
      else if (held.permit != null) state.release = { permit: held.permit, action: 'give-up', at: clock() };
    } else if (!reask && held.permit != null) {
      state.release = { permit: held.permit, action, at: clock() };
    }
    tx.changes.push({ type: 'released', action, permit: held.permit, requestId: held.requestId, stepKey: held.stepKey, reason: held.reason });
    logger.info('held', `hold released: ${action}`, { action, permit: held.permit, requestId: held.requestId, stepKey: held.stepKey, reason: held.reason }, job());
  }

  function derivePhase() {
    if (terminal()) return state.phase;
    if (state.jobId == null) return 'idle';
    if (state.held) return 'held';
    if (state.pausedBy) return 'paused';
    if (state.inFlight) return 'in-flight';
    const entry = nextGrantable();
    if (entry && clock() < grantTime(entry)) return 'waiting';
    return 'ready';
  }

  function naturalWait() {
    if (terminal() || state.jobId == null) return null;
    if (state.held) return { reason: state.held.reason === 'interrupted' ? 'interrupted' : 'held', until: null };
    if (state.pausedBy) return { reason: 'paused', until: null };
    if (state.inFlight) return null;
    const entry = nextGrantable();
    if (entry) {
      const t = grantTime(entry);
      if (clock() < t) return { reason: t > spacingAt(entry) ? 'retry-after' : 'spacing', until: t };
      return null;
    }
    // The script's own back-off is informational: it ends when the script
    // asks for its next permit, or when anything else happens.
    if (state.wait && state.wait.reason === 'script-backoff') return state.wait;
    return null;
  }

  function setWait(next, tx) {
    const cur = state.wait;
    const same = cur && next && cur.reason === next.reason && (cur.until == null ? null : cur.until) === (next.until == null ? null : next.until);
    if (same) return;
    if (!cur && !next) return;
    const t = clock();
    if (cur) {
      tx.changes.push({ type: 'wait', state: 'end', reason: cur.reason, until: cur.until, since: cur.since, waitedMs: Math.max(0, t - cur.since) });
      logger[cur.reason === 'spacing' ? 'debug' : 'info']('wait', `wait ended: ${cur.reason}`, { reason: cur.reason, until: cur.until, waitedMs: Math.max(0, t - cur.since) }, job());
    }
    state.wait = next ? { reason: next.reason, since: next.since == null ? t : next.since, until: next.until == null ? null : next.until } : null;
    if (next) {
      tx.changes.push({ type: 'wait', state: 'start', reason: state.wait.reason, until: state.wait.until, since: state.wait.since });
      logger[next.reason === 'spacing' ? 'debug' : 'info']('wait', `wait started: ${next.reason}`, { reason: state.wait.reason, until: state.wait.until, seconds: state.wait.until == null ? null : Math.max(0, Math.round((state.wait.until - t) / 1000)) }, job());
    }
  }

  function refreshDerived(tx) {
    setWait(naturalWait(), tx);
    const phase = derivePhase();
    if (phase !== state.phase) {
      state.phase = phase;
      tx.changes.push({ type: 'phase', phase });
      logger.info('gate', `gate ${phase}`, { phase }, job());
    }
  }

  // Every public operation ends here: grant what can be granted, recompute
  // the wait and the phase, persist, answer, then arm the next wake.
  async function settle(tx) {
    tryGrant(tx);
    refreshDerived(tx);
    await commit(tx);
    arm();
  }

  function disarm() {
    if (!armed) return;
    const { cancel } = armed;
    armed = null;
    try {
      if (typeof cancel === 'function') cancel();
    } catch {
      // A cancel that throws leaves a wake that re-evaluates for nothing.
    }
  }

  function arm() {
    const entry = nextGrantable();
    const at = entry ? grantTime(entry) : null;
    if (at == null || at <= clock()) {
      disarm();
      return;
    }
    if (armed && armed.at === at) return;
    disarm();
    let cancel = null;
    try {
      cancel = wake(at, () => {
        if (armed && armed.at === at) armed = null;
        reevaluate();
      });
    } catch (e) {
      logger.error('gate', 'wake could not be scheduled; the next permit or report re-evaluates', { at, error: String((e && e.message) || e) }, job());
      return;
    }
    armed = { at, cancel };
  }

  function refuseAll(reason, tx) {
    for (const entry of [...state.pending]) refuse(entry, reason, tx);
  }

  // --- public operations (each runs under `run`) --------------------

  // The store is read once, before the first operation that needs the state,
  // whether the caller remembered to call load() or not: a worker that was
  // restarted must never answer from an empty gate.
  async function loadLocked() {
    if (loaded) return;
    loaded = true;
    let raw;
    try {
      raw = await store.get();
    } catch (e) {
      logger.error('gate', 'could not read the gate state; starting idle', { error: String((e && e.message) || e) });
      raw = undefined;
    }
    if (raw !== undefined && raw !== null) {
      const clean = sanitizeState(raw);
      if (clean) {
        state = clean;
        logger.info('gate', 'gate state restored', { jobId: state.jobId, phase: state.phase, pending: state.pending.length, inFlight: Boolean(state.inFlight), held: state.held ? state.held.reason : null }, job());
      } else {
        logger.warn('gate', 'stored gate state was unusable and was dropped', { version: isObj(raw) ? raw.version : typeof raw });
      }
    }
    const tx = newTx();
    await settle(tx);
  }

  async function load() {
    return run(async () => {
      await loadLocked();
      return snapshot();
    });
  }

  async function start(jobId) {
    if (typeof jobId !== 'string' || jobId === '') throw new TypeError('gate.start: jobId must be a non-empty string');
    return run(async () => {
      await loadLocked();
      if (state.jobId === jobId && mayHaveActed()) {
        // Safeguard: one job creates one project. Whatever phase the gate
        // is in, finished or cancelled included, a job whose create may
        // have made a project never runs again; only a new job id can.
        logger.error('gate', 'a job whose create may have acted cannot be started again', { jobId, phase: state.phase, created: state.created }, job());
        throw new Error(`gate.start: job ${jobId} already permitted a create (${state.created.permit}); it cannot be started again`);
      }
      if (state.jobId != null && !terminal() && state.phase !== 'idle') {
        if (state.jobId !== jobId) throw new Error(`gate.start: job ${state.jobId} is still active (${state.phase}); finish or cancel it first`);
        logger.warn('gate', 'job started again; its pending permits are refused', { jobId, phase: state.phase, pending: state.pending.length }, job());
      }
      const tx = newTx();
      refuseAll('cancelled', tx);
      waiters.clear();
      disarm();
      state = freshState(jobId);
      tx.changes.push({ type: 'phase', phase: 'ready' });
      logger.info('gate', 'gate started', { jobId }, jobId);
      await commit(tx);
      arm();
    });
  }

  async function permit(req) {
    const p = validatePermit(req);
    let waiter = null;
    const answered = await run(async () => {
      await loadLocked();
      const known = state.answers[p.requestId];
      if (known && known.permit) return known.permit;
      if (state.jobId == null || state.phase === 'idle') return { ok: false, reason: 'no-job' };
      const tx = newTx();
      if (terminal()) {
        const reason = state.phase === 'cancelled' ? 'cancelled' : 'wrong-phase';
        remember(p.requestId, 'permit', { ok: false, reason }, tx);
        await commit(tx);
        return { ok: false, reason };
      }
      const existing = state.pending.find(e => e.requestId === p.requestId);
      if (existing) {
        waiter = addWaiter(p.requestId);
        await settle(tx);
        return null;
      }
      const t = clock();
      let entry = null;
      if (p.retryOf) {
        entry = reask(p, t, tx);
        if (!entry) {
          await settle(tx);
          return state.answers[p.requestId].permit;
        }
      } else {
        if (p.kind === 'script' && classifyRequest(p.method, p.path) === 'create' && mayHaveActed()) {
          // Safeguard: one job creates one project. Only a 4xx answer means
          // the first create was turned away, so only then may another go out.
          logger.error('gate', 'a second create permit was refused', { requestId: p.requestId, stepKey: p.stepKey, created: state.created }, job());
          remember(p.requestId, 'permit', { ok: false, reason: 'wrong-phase' }, tx);
          await commit(tx);
          return { ok: false, reason: 'wrong-phase' };
        }
        entry = {
          permit: `p${++state.lastPermit}`,
          requestId: p.requestId,
          seq: null,
          stepKey: p.stepKey,
          method: p.method,
          path: p.path,
          kind: p.kind,
          retryOf: null,
          askedAt: t,
        };
        state.pending.push(entry);
        const step = stepOf(p.stepKey, t);
        if (step.state !== 'held') step.state = 'pending';
        step.lastAt = t;
      }
      waiter = addWaiter(p.requestId);
      tx.changes.push({ type: 'asked', permit: entry.permit, requestId: entry.requestId, stepKey: entry.stepKey, method: entry.method, path: entry.path, kind: entry.kind, retryOf: entry.retryOf, bodyBytes: p.bodyBytes });
      logger.debug('request', 'permit asked', { permit: entry.permit, requestId: entry.requestId, stepKey: entry.stepKey, method: entry.method, path: entry.path, kind: entry.kind, retryOf: entry.retryOf, bodyBytes: p.bodyBytes }, job());
      await settle(tx);
      return null;
    });
    return answered || waiter;
  }

  // The page re-asks for a held permit with retryOf. The answer is the same
  // permit id, once the person has acted. Returns the pending entry, or null
  // when the ask was answered (refused) on the spot.
  function reask(p, t, tx) {
    const held = state.held;
    const release = state.release;
    const twin = state.pending.find(e => e.retryOf === p.retryOf || e.permit === p.retryOf);
    if (twin) {
      logger.warn('gate', 'a second re-ask for one held permit was refused', { requestId: p.requestId, retryOf: p.retryOf, pendingRequestId: twin.requestId }, job());
      remember(p.requestId, 'permit', { ok: false, reason: 'wrong-phase' }, tx);
      return null;
    }
    if (release && release.permit === p.retryOf && release.action === 'give-up') {
      state.release = null;
      remember(p.requestId, 'permit', { ok: false, reason: 'give-up' }, tx);
      logger.info('gate', 'the re-ask met Give up', { requestId: p.requestId, retryOf: p.retryOf }, job());
      return null;
    }
    const known = (held && held.permit === p.retryOf) || (release && release.permit === p.retryOf);
    if (!known) {
      // Nothing is held or was released under that permit: without a hold
      // there is nothing the person has agreed to send again.
      logger.warn('gate', 'a re-ask named a permit that is not held; refused', { requestId: p.requestId, retryOf: p.retryOf }, job());
      remember(p.requestId, 'permit', { ok: false, reason: 'wrong-phase' }, tx);
      return null;
    }
    const stepKey = held && held.permit === p.retryOf ? held.stepKey : p.stepKey;
    if (stepKey !== p.stepKey) logger.warn('gate', 'the re-ask names another step than the hold; the held step is used', { requestId: p.requestId, retryOf: p.retryOf, stepKey: p.stepKey, heldStepKey: stepKey }, job());
    const entry = {
      permit: p.retryOf,
      requestId: p.requestId,
      seq: null,
      stepKey,
      method: p.method,
      path: p.path,
      kind: p.kind,
      retryOf: p.retryOf,
      askedAt: t,
    };
    state.pending.push(entry);
    if (release && release.permit === p.retryOf) state.release = null;
    return entry;
  }

  async function report(rep) {
    const r = validateReport(rep);
    return run(async () => {
      await loadLocked();
      const known = state.answers[r.requestId];
      if (known && known.report) return known.report;
      const tx = newTx();
      const flight = state.inFlight;
      if (flight && terminal()) {
        // The job ended while this request was out (Cancel reloads the tab
        // right after): nothing is counted, held or retried any more.
        state.inFlight = null;
        const answer = { action: 'pass', verdict: 'pass', terminal: state.phase };
        remember(r.requestId, 'report', answer, tx);
        await settle(tx);
        return answer;
      }
      if (!flight || flight.permit !== r.permit || flight.requestId !== r.requestId) {
        // A report the gate did not expect (state lost, or a page from before
        // a restart): the response goes to the script, nothing is retried.
        logger.warn('gate', 'a report arrived for a request that is not in flight; passed', { requestId: r.requestId, permit: r.permit, status: r.status, inFlight: flight ? flight.permit : null }, job());
        const answer = { action: 'pass', verdict: 'pass', stray: true };
        remember(r.requestId, 'report', answer, tx);
        await settle(tx);
        return answer;
      }
      const t = clock();
      const step = stepOf(flight.stepKey, t);
      const conf = cfg();
      const forClassify = { ...r, method: flight.method, path: flight.path, kind: flight.kind, stepKey: flight.stepKey, attempt: flight.attempt };
      let cls;
      try {
        cls = classifier(forClassify);
        if (!isObj(cls) || typeof cls.verdict !== 'string') throw new TypeError('classify returned no verdict');
      } catch (e) {
        logger.error('gate', 'classify failed; the built-in fallback was used', { error: String((e && e.message) || e), status: r.status, path: flight.path }, job());
        cls = fallbackClassify(forClassify);
      }

      const elapsedMs = r.elapsedMs == null ? Math.max(0, t - flight.startedAt) : r.elapsedMs;
      const retryAfterHeader = parseRetryAfter(r.headers['retry-after'], t);
      const retryAfterMs = typeof cls.retryAfterMs === 'number' && Number.isFinite(cls.retryAfterMs) && cls.retryAfterMs >= 0 ? Math.round(cls.retryAfterMs) : retryAfterHeader;
      const record = {
        seq: flight.seq,
        permit: flight.permit,
        requestId: flight.requestId,
        stepKey: flight.stepKey,
        method: flight.method,
        path: flight.path,
        kind: flight.kind,
        attempt: flight.attempt,
        status: r.status,
        outcome: 'ok',
        startedAt: flight.startedAt,
        endedAt: t,
        elapsedMs,
        retryAfterMs: null,
      };

      state.inFlight = null;
      state.lastEndedAt = t;
      state.counters.requests += 1;
      if (flight.kind === 'probe') state.counters.probes += 1;
      step.lastAt = t;
      step.lastStatus = r.status;
      const requestKind = flight.kind === 'script' ? classifyRequest(flight.method, flight.path) : 'other';
      const isCreate = requestKind === 'create';
      // A create, a document or a standard project's file goes out once:
      // the script never retries it, so its first failure is the person's.
      const sentOnce = requestKind !== 'other';
      if (isCreate && state.created && state.created.permit === flight.permit) {
        state.created.pending = false;
        state.created.status = r.status;
        if (r.ok && r.created) {
          state.created.id = r.created.id;
          state.created.url = r.created.url;
        }
        noteCreated();
      }
      // Probes are part of Resume and preflight: their failures are reported
      // to the worker through their own result, so only an interruption on a
      // probe holds the gate, and never while it is already held (the probe's
      // answer carries the verdict for the worker instead).
      const canHold = flight.kind !== 'probe';
      const heldBase = { permit: flight.permit, requestId: flight.requestId, stepKey: flight.stepKey, method: flight.method, path: flight.path, status: r.status, attempt: flight.attempt };
      let answer;

      if (cls.verdict === 'interrupt') {
        const interruption = reduceInterruption(cls.interruption, cls.kind || 'challenge');
        interruption.evidence = { ...reduceEvidence({ status: r.status, headers: r.headers, markers: r.markers, finalPath: r.finalPath, redirected: r.redirected, bodyExcerpt: r.bodyExcerpt, method: flight.method, path: flight.path, requestId: flight.requestId, stepKey: flight.stepKey, attempt: flight.attempt }), ...interruption.evidence };
        state.counters.interruptions += 1;
        record.outcome = 'interrupted';
        step.state = 'held';
        if (state.held && (!canHold || state.held.permit != null)) {
          // A probe's verdict, or a hold that already names a request: the
          // hold learns the newer interruption and the answer carries it.
          state.held.interruption = interruption;
          answer = { action: 'pass', verdict: 'interrupt', kind: interruption.kind, interruption };
          logger.warn('gate', 'an interruption was seen while the gate is already held', { kind: interruption.kind, permit: flight.permit, requestId: flight.requestId, status: r.status }, job());
        } else {
          answer = setHold(tx, { ...heldBase, reason: 'interrupted', interruption });
          answer.verdict = 'interrupt';
          answer.kind = interruption.kind;
        }
      } else if (cls.verdict === 'slow-down' || r.status === 429) {
        state.counters.slowDowns += 1;
        step.consecutive429 += 1;
        record.outcome = 'slow-down';
        record.retryAfterMs = retryAfterMs;
        // The site's wait is honoured in full from the end of this request.
        // Without a header the script sleeps its own SLOW_DOWN_WAITS, and
        // the gate adds only the spacing for the next request's method from
        // lastEndedAt: none before a read by default. An export's plain
        // reads are not retried by its script, so a 429 there leaves a gap
        // in the export or ends it; raising the spacing before a read is
        // the person's answer, never a retry of the gate's own.
        if (retryAfterMs != null) state.notBefore = Math.max(state.notBefore, t + retryAfterMs);
        if (canHold && retryAfterMs != null && retryAfterMs > conf.retryAfterCapMs) {
          record.outcome = 'held';
          answer = setHold(tx, { ...heldBase, reason: 'long-wait' });
        } else if (canHold && step.consecutive429 >= HOLD_AFTER_SLOW_DOWNS) {
          record.outcome = 'held';
          answer = setHold(tx, { ...heldBase, reason: 'failed-step' });
        } else {
          step.state = 'failed';
          answer = { action: 'pass', verdict: 'slow-down' };
        }
        if (retryAfterMs != null) answer.retryAfterMs = retryAfterMs;
      } else if (cls.verdict === 'network' || r.status === 0 || r.status >= 500) {
        const network = r.status === 0 || cls.verdict === 'network';
        if (network) state.counters.networkErrors += 1;
        else state.counters.serverErrors += 1;
        step.consecutiveFailures += 1;
        record.outcome = network ? 'network' : 'server-error';
        record.retryAfterMs = retryAfterMs;
        // A Retry-After on a 5xx (its usual home is a 503) is the site's
        // wait as much as on a 429: honoured in full from the end of this
        // request, whatever shorter sleep the script takes on its own.
        if (retryAfterMs != null) state.notBefore = Math.max(state.notBefore, t + retryAfterMs);
        // The script gives up at once on a request it sends only once and
        // on a status it does not retry; otherwise after its retries.
        const scriptGivesUp = sentOnce || (!network && !RETRY_STATUSES.has(r.status)) || step.consecutiveFailures >= HOLD_AFTER_FAILURES;
        if (canHold && scriptGivesUp) {
          record.outcome = 'held';
          answer = setHold(tx, { ...heldBase, reason: 'failed-step' });
        } else if (canHold && retryAfterMs != null && retryAfterMs > conf.retryAfterCapMs) {
          record.outcome = 'held';
          answer = setHold(tx, { ...heldBase, reason: 'long-wait' });
        } else {
          step.state = 'failed';
          answer = { action: 'pass', verdict: network ? 'network' : 'pass' };
        }
        if (retryAfterMs != null) answer.retryAfterMs = retryAfterMs;
      } else {
        if (r.status >= 200 && r.status < 400) {
          state.counters.ok += 1;
          step.consecutive429 = 0;
          step.consecutiveFailures = 0;
          step.state = 'done';
          record.outcome = 'ok';
        } else {
          // A refusal (4xx) is final for the script, which records it.
          step.consecutive429 = 0;
          step.consecutiveFailures = 0;
          step.state = 'failed';
          record.outcome = 'refused';
        }
        answer = { action: 'pass', verdict: 'pass' };
      }

      pushRecent(record);
      remember(r.requestId, 'report', answer, tx);
      tx.changes.push({ type: 'report', permit: flight.permit, requestId: flight.requestId, seq: flight.seq, stepKey: flight.stepKey, method: flight.method, path: flight.path, kind: flight.kind, attempt: flight.attempt, status: r.status, outcome: record.outcome, elapsedMs, retryAfterMs: record.retryAfterMs, action: answer.action });
      logger.debug('request', `request ${record.outcome}`, { permit: flight.permit, requestId: flight.requestId, seq: flight.seq, method: flight.method, path: flight.path, kind: flight.kind, attempt: flight.attempt, status: r.status, outcome: record.outcome, elapsedMs, retryAfterMs: record.retryAfterMs, action: answer.action }, job());
      if (answer.action === 'pass' && record.outcome !== 'ok' && record.outcome !== 'refused' && record.outcome !== 'interrupted') {
        // The script now sleeps and retries by itself: shown, not enforced.
        tryGrant(tx);
        if (!state.inFlight && !nextGrantable() && !state.held && !state.pausedBy) {
          setWait({ reason: 'script-backoff', until: null }, tx);
        }
      }
      await settle(tx);
      return answer;
    });
  }

  async function pause() {
    return run(async () => {
      await loadLocked();
      if (terminal() || state.jobId == null) return { ok: false, reason: state.jobId == null ? 'no-job' : 'wrong-phase' };
      if (state.pausedBy) return { ok: true, already: true };
      const tx = newTx();
      state.pausedBy = 'person';
      tx.changes.push({ type: 'paused', by: 'person' });
      logger.info('gate', 'paused by the person', {}, job());
      await settle(tx);
      return { ok: true };
    });
  }

  // Resume is the person's act after a pause or after an interruption or a
  // long wait that the caller has checked is over (its probes ran first).
  // A hold of reason failed-step is left for Retry or Give up.
  async function resume() {
    return run(async () => {
      await loadLocked();
      if (terminal() || state.jobId == null) return { ok: false, reason: state.jobId == null ? 'no-job' : 'wrong-phase' };
      const tx = newTx();
      let did = false;
      if (state.pausedBy) {
        state.pausedBy = null;
        tx.changes.push({ type: 'resumed', from: 'paused' });
        did = true;
      }
      if (state.held && (state.held.reason === 'interrupted' || state.held.reason === 'long-wait')) {
        releaseHold('resume', tx);
        did = true;
      }
      if (!did) {
        const reason = state.held ? state.held.reason : 'not-paused';
        logger.info('gate', 'resume had nothing to do', { reason }, job());
        return { ok: true, already: true, held: state.held ? state.held.reason : null };
      }
      logger.info('gate', 'resumed by the person', { held: state.held ? state.held.reason : null }, job());
      await settle(tx);
      return { ok: true, held: state.held ? state.held.reason : null };
    });
  }

  // Retry sends the held step once more, as the next attempt. Never from an
  // interruption: a challenged, blocked or signed-out request is re-sent
  // only through Resume, after the caller's probes said the way is clear.
  async function retry() {
    return run(async () => {
      await loadLocked();
      if (!state.held) return { ok: false, reason: terminal() ? 'wrong-phase' : 'not-held' };
      if (state.held.reason === 'interrupted') {
        logger.warn('gate', 'retry refused while interrupted; Resume is the way', { kind: state.held.interruption ? state.held.interruption.kind : null }, job());
        return { ok: false, reason: 'interrupted' };
      }
      const tx = newTx();
      releaseHold('retry', tx);
      await settle(tx);
      return { ok: true };
    });
  }

  // Give up hands the parked response to the script, which records the step
  // as failed and goes on. Not from an interruption: the script would retry
  // a 503 challenge by itself.
  async function giveUp() {
    return run(async () => {
      await loadLocked();
      if (!state.held) return { ok: false, reason: terminal() ? 'wrong-phase' : 'not-held' };
      if (state.held.reason === 'interrupted') {
        logger.warn('gate', 'give up refused while interrupted; Resume or Cancel are the ways', { kind: state.held.interruption ? state.held.interruption.kind : null }, job());
        return { ok: false, reason: 'interrupted' };
      }
      const tx = newTx();
      releaseHold('give-up', tx);
      await settle(tx);
      return { ok: true };
    });
  }

  // The worker's hold, for an interruption it saw outside a response: the
  // tab shows a challenge or a sign-in page, or the signed-in account is
  // not the destination. It names no request; Resume is the way out, as
  // for an interruption on a response, and the worker's probes come first.
  // A request already in flight finishes, and joins this hold if its own
  // answer would have held the gate. A step already held for Retry or Give
  // up keeps that choice: the interruption is noted on it, no more.
  async function hold({ reason = 'interrupted', interruption = null } = {}) {
    if (reason !== 'interrupted') throw new TypeError("gate.hold: reason must be 'interrupted'; the report() path holds failed steps");
    const made = interruption == null ? null : reduceInterruption(interruption, 'unknown');
    return run(async () => {
      await loadLocked();
      if (terminal() || state.jobId == null) return { ok: false, reason: state.jobId == null ? 'no-job' : 'wrong-phase' };
      const tx = newTx();
      if (state.held) {
        if (made) state.held.interruption = made;
        logger.warn('held', 'an interruption was raised while the gate is already held', { kind: made ? made.kind : null, reason: state.held.reason, permit: state.held.permit }, job());
        await settle(tx);
        return { ok: true, already: true, held: state.held.reason };
      }
      if (made) state.counters.interruptions += 1;
      setHold(tx, { reason: 'interrupted', permit: null, requestId: null, stepKey: null, method: null, path: null, status: 0, attempt: 0, interruption: made });
      await settle(tx);
      return { ok: true };
    });
  }

  async function cancel() {
    return run(async () => {
      await loadLocked();
      if (state.jobId == null) return { ok: false, reason: 'no-job' };
      if (terminal()) return { ok: true, already: true, phase: state.phase };
      const tx = newTx();
      const held = state.held;
      state.held = null;
      state.release = null;
      state.pausedBy = null;
      refuseAll('cancelled', tx);
      if (held) tx.changes.push({ type: 'released', action: 'cancel', permit: held.permit, requestId: held.requestId, stepKey: held.stepKey, reason: held.reason });
      state.phase = 'cancelled';
      disarm();
      tx.changes.push({ type: 'cancelled', inFlight: state.inFlight ? state.inFlight.permit : null, created: state.created });
      tx.changes.push({ type: 'phase', phase: 'cancelled' });
      logger.info('gate', 'cancelled', { inFlight: state.inFlight ? state.inFlight.permit : null, created: state.created ? state.created.permit : null }, job());
      await settle(tx);
      return { ok: true };
    });
  }

  async function finish(outcome) {
    if (!TERMINAL_PHASES.includes(outcome)) throw new TypeError("gate.finish: outcome must be 'done', 'failed' or 'cancelled'");
    return run(async () => {
      await loadLocked();
      if (state.jobId == null) return { ok: false, reason: 'no-job' };
      if (terminal()) return { ok: true, already: true, phase: state.phase };
      const tx = newTx();
      state.held = null;
      state.release = null;
      state.pausedBy = null;
      refuseAll(outcome === 'cancelled' ? 'cancelled' : 'wrong-phase', tx);
      state.phase = outcome;
      disarm();
      tx.changes.push({ type: 'finished', outcome });
      tx.changes.push({ type: 'phase', phase: outcome });
      logger.info('gate', `finished: ${outcome}`, { outcome, counters: state.counters }, job());
      await settle(tx);
      return { ok: true };
    });
  }

  async function reevaluate() {
    return run(async () => {
      const tx = newTx();
      try {
        await loadLocked();
        await settle(tx);
      } catch (e) {
        logger.error('gate', 'reevaluate failed', { error: String((e && e.message) || e) }, job());
      }
    });
  }

  return Object.freeze({
    load,
    start,
    permit,
    report,
    hold,
    pause,
    resume,
    retry,
    giveUp,
    cancel,
    finish,
    snapshot,
    createMayHaveActed: mayHaveActed,
    reevaluate,
  });
}
