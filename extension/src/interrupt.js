// Stop and tell. This module decides when the import must stop and what the
// person has to do before it may go on: a Cloudflare challenge or block in a
// reply, a sign-out, the import tab itself showing a challenge or the sign-in
// page, the page having gone away, or claude.ai being signed in as somebody
// other than the account the CLI named. It also keeps the current interruption
// and a short history for the side panel, with every piece of evidence
// reduced to an allowlist of fields and redacted.
//
// It never acts. Nothing here retries a request, navigates, reads a cookie,
// solves a challenge or switches an account: classifying is pure, and raising
// an interruption only records it. The gate holds the request, the person
// presses Resume. Decisions that are not spelled out in the design are
// explained where they are made.
//
// Plain ES module. Everything with a side effect (the clock, the store, the
// logger, the redactor) is injected through createInterrupts(); the pure
// functions take only data. No browser API, no timer, no randomness.

export const KINDS = [
  'challenge', 'blocked', 'signed-out', 'wrong-account', 'identity-unknown',
  'challenge-page', 'page-reloaded', 'tab-closed',
];

// Markers page.js looks for in the first 64 KiB of an HTML error body,
// lowercased. Three groups, because the rules below tell them apart: a
// challenge interstitial, Cloudflare's "you have been blocked" page (error
// 1020) and its "rate limited" page (error 1015). BODY_MARKERS is their union
// and is what page.js carries a literal copy of.
export const CHALLENGE_MARKERS = [
  'cf-chl-', '__cf_chl', 'cf_chl_opt', 'challenge-platform',
  '/cdn-cgi/challenge-platform/', 'challenges.cloudflare.com', 'cf-turnstile',
  'turnstile', '<title>just a moment', 'checking your browser',
  'verify you are human', 'attention required! | cloudflare',
];
export const BLOCKED_MARKERS = ['error code: 1020', 'sorry, you have been blocked', 'access denied'];
export const RATE_LIMIT_MARKERS = ['error code: 1015', 'you are being rate limited'];
export const BODY_MARKERS = [...CHALLENGE_MARKERS, ...BLOCKED_MARKERS, ...RATE_LIMIT_MARKERS];

// What content.js looks for in the import tab's DOM.
export const PAGE_MARKER_SELECTORS = [
  '#challenge-form', '#challenge-running', '#cf-challenge-running', '.cf-turnstile',
  'iframe[src*="challenges.cloudflare.com"]',
  'script[src*="challenges.cloudflare.com/turnstile"]',
  'script[src*="/cdn-cgi/challenge-platform/"]',
];

export const LOGIN_PATH_RE = /^\/(login|magic-link|oauth|auth)(\/|$)/;

// The only response headers that ever appear in a report, an event, a log
// record or an interruption's evidence. Everything else, cookies above all,
// is dropped before it is looked at.
export const HEADER_ALLOWLIST = [
  'retry-after', 'content-type', 'content-length', 'cf-mitigated', 'cf-ray',
  'server', 'server-timing', 'location', 'date',
];

export const ACCOUNT_ENDPOINTS = ['/api/account', '/api/auth/current_account'];

// The fields an interruption's evidence may hold. The first thirteen are the
// design's; the rest carry what a page probe or an identity probe knows
// (title, hasImporter, online, phase, orgs, expectedOrg), the fetch error of a
// network failure, how long the request took, and which rule fired (signal).
// Nothing outside this list survives reduceEvidence().
export const EVIDENCE_KEYS = [
  'status', 'headers', 'markers', 'finalPath', 'redirected', 'bodyExcerpt',
  'expected', 'actual', 'method', 'path', 'requestId', 'stepKey', 'attempt',
  'error', 'url', 'title', 'hasImporter', 'online', 'phase', 'orgs',
  'expectedOrg', 'signal', 'elapsedMs',
];

export const REDACTED = '[redacted]';

const SCAN_CHARS = 64 * 1024;
const EXCERPT_CHARS = 200;
const ACTIVE_PHASES = new Set(['ready', 'running', 'held']);
const GATED_PATH_RE = /^\/(api|v1)\//;
const AUTH_MESSAGE_RE = /not (logged|signed) in|session (has )?expired|invalid session|login required/i;
const AUTH_TYPES = new Set(['authentication_error', 'unauthenticated']);
const AUTH_REASONS = new Set(['not_authenticated', 'unauthorized']);
// Who or what resolved an interruption: the person pressed Resume, the job
// was cancelled, or something newer took its place (raise() does this on
// its own; the worker may also clear('superseded') a card that belongs to a
// job that has ended).
const RESOLVERS = new Set(['person', 'cancel', 'superseded']);
const RATE_LIMIT_PAGE_WAIT_MS = 60000;

// ---------------------------------------------------------------- redaction
// The rules of the design's section 2.7, kept here as well as in log.js so
// that an interruption is clean before anything else sees it. The injected
// redact() of createInterrupts() runs on top of these, never instead.

const SECRET_KEY_SET = new Set([
  'cookie', 'setcookie', 'cookies', 'authorization', 'proxyauthorization',
  'xapikey', 'apikey', 'anthropicapikey', 'sessionkey', 'sessionid', 'session',
  'secret', 'password', 'passwd', 'token', 'accesstoken', 'refreshtoken',
  'idtoken', 'bearer', 'csrftoken', 'xcsrftoken', 'xsrftoken', 'authtoken',
  'cfclearance', 'cfbm',
]);
const SECRET_KEY_SUFFIXES = ['token', 'secret', 'password', 'apikey'];

const SECRET_VALUE_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  // A key whose END line was cut off (a clipped excerpt) is cut to its BEGIN.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, '[redacted private key]'],
  [/sk-ant-[A-Za-z0-9_\-]{8,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/(\bBearer\s+)[A-Za-z0-9._~+\/\-]{16,}=*/gi, '$1' + REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED],
  // The design's rule with one widening: __Secure- and __Host- names may hold
  // a dot (NextAuth's __Secure-next-auth.session-token does), so '.' is part
  // of the name here.
  [/\b(sessionKey|session_key|cf_clearance|__cf_bm|__Secure-[\w.-]+|__Host-[\w.-]+|csrftoken|intercom-session-[\w-]+)=[^;&\s]+/gi, '$1=' + REDACTED],
  [/\b([A-Z0-9_]*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*[=:]\s*)(?!\[redacted)(['"]?)[^\s'"]{4,}\2/gi, '$1' + REDACTED],
  // The design strips these query parameters from strings that parse as a
  // URL. A stepKey ("POST /api/x?code=... json:...") does not parse as one,
  // so the rule is applied to every string here: a superset, equally
  // deterministic, and nothing of value is lost.
  [/([?&](?:token|key|api_key|apikey|session|sessionKey|code|state|auth|access_token|refresh_token)=)[^&#\s]*/gi, '$1' + REDACTED],
];

function isSecretKey(key) {
  const norm = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEY_SET.has(norm) || SECRET_KEY_SUFFIXES.some(s => norm.endsWith(s));
}

export function redactText(text) {
  let s = String(text);
  for (const [re, repl] of SECRET_VALUE_RULES) s = s.replace(re, repl);
  return s;
}

// Deep copy with secrets replaced. Cycles become '[cycle]', anything deeper
// than 20 levels '[deep]', functions and symbols are dropped: the result is
// always plain JSON.
export function redact(value) {
  const seen = new WeakSet();
  const walk = (v, depth) => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') return redactText(v);
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v !== 'object') return undefined;
    if (depth > 20) return '[deep]';
    if (seen.has(v)) return '[cycle]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(x => { const r = walk(x, depth + 1); return r === undefined ? null : r; });
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'function' || typeof x === 'symbol') continue;
      out[k] = isSecretKey(k) ? REDACTED : walk(x, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

// ---------------------------------------------------------------- small tools

function clip(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) : s;
}

function text(v) {
  return typeof v === 'string' ? v : '';
}

function lower(v) {
  return text(v).trim().toLowerCase();
}

// Numbers come as numbers or numeric strings; null, '', booleans and the
// rest are "unknown", never 0.
function numberOf(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

function statusOf(v) {
  const n = numberOf(v);
  return Number.isInteger(n) && n >= 0 && n < 1000 ? n : null;
}

function intOrNull(v) {
  const n = numberOf(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function boolOrNull(v) {
  return typeof v === 'boolean' ? v : null;
}

function stringList(v, maxItems, maxChars) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (typeof item !== 'string' || !item) continue;
    out.push(clip(item, maxChars));
    if (out.length >= maxItems) break;
  }
  return out;
}

function hasAny(markers, wanted) {
  return markers.some(m => wanted.includes(m));
}

function nameOf(v) {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object') return nameOf(v.email);
  return '';
}

function sameEmail(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// The pathname of a URL, query and fragment removed; '' when it cannot be
// parsed. Relative references resolve against claude.ai, which is the only
// origin the gate ever sees.
export function pathOnly(url) {
  if (typeof url !== 'string') return '';
  const s = url.trim();
  if (!s) return '';
  try {
    return new URL(s, 'https://claude.ai/').pathname;
  } catch {
    return '';
  }
}

// A Retry-After header as milliseconds to wait: delta-seconds, or an
// HTTP-date measured from nowMs. null when absent, unparsable, negative, or a
// date without a clock to measure it from. A date already past gives 0; the
// gate's minimum spacing still applies. Nothing is capped here: honouring
// the full wait is the gate's job, and a very long one becomes a visible hold.
export function parseRetryAfter(value, nowMs) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  // Date.parse() is generous ("-5" comes back as a date), so only something
  // shaped like an HTTP-date (a month name and a clock time) is given to it.
  if (!/[A-Za-z]{3}/.test(s) || !/\d{1,2}:\d{2}/.test(s)) return null;
  const at = Date.parse(s);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, at - nowMs);
}

// ---------------------------------------------------------------- evidence

// The markers found in a body, in BODY_MARKERS order. Only the first 64 KiB
// are looked at, as page.js does, plus one marker's length so that a marker
// which starts inside that window is still whole. Bytes are decoded as
// UTF-8 without complaint; anything that is neither text nor bytes has no
// markers.
const SCAN_WINDOW = SCAN_CHARS + Math.max(...BODY_MARKERS.map(m => m.length)) - 1;

export function scanBody(body) {
  let s = '';
  if (typeof body === 'string') s = body;
  else if (body instanceof ArrayBuffer) s = decodeBytes(new Uint8Array(body));
  else if (ArrayBuffer.isView(body)) s = decodeBytes(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  else return [];
  const hay = s.slice(0, SCAN_WINDOW).toLowerCase();
  return BODY_MARKERS.filter(m => hay.includes(m));
}

function decodeBytes(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, SCAN_WINDOW));
  } catch {
    return '';
  }
}

// The allowlisted headers of a Headers object, a Map, a list of pairs or a
// plain object, keys lowercased, values clipped, 'location' reduced to its
// path. Anything else, and anything that throws while being read, gives {}.
export function pickHeaders(headersLike) {
  const out = {};
  if (!headersLike || typeof headersLike !== 'object') return out;
  const put = (name, value) => {
    const key = lower(name);
    if (!HEADER_ALLOWLIST.includes(key)) return;
    let v = value === null || value === undefined ? '' : Array.isArray(value) ? value.join(', ') : String(value);
    v = v.trim();
    if (key === 'location') v = pathOnly(v);
    out[key] = clip(v, 200);
  };
  try {
    if (typeof headersLike[Symbol.iterator] === 'function') {
      for (const pair of headersLike) if (pair && pair.length >= 2) put(pair[0], pair[1]);
    } else if (typeof headersLike.get === 'function') {
      for (const name of HEADER_ALLOWLIST) {
        const v = headersLike.get(name);
        if (v !== null && v !== undefined) put(name, v);
      }
    } else {
      for (const [k, v] of Object.entries(headersLike)) put(k, v);
    }
  } catch {
    return {};
  }
  return out;
}

// The email in an account endpoint's JSON: the four field paths the design
// names, first one wins. A value without an '@' is not taken: it is better
// to ask the person to confirm than to compare a non-email with an email.
export function emailOf(body) {
  let obj = body;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const account = obj.account && typeof obj.account === 'object' ? obj.account : {};
  for (const v of [obj.email_address, obj.email, account.email_address, account.email]) {
    if (typeof v === 'string' && v.trim() && v.includes('@')) return v.trim();
  }
  return null;
}

// Reduces whatever a caller hands over to the allowlisted evidence shape:
// known keys only, each coerced to its type and clipped, headers through
// pickHeaders, paths through pathOnly, then redacted. status, headers and
// markers are always present; other fields only when known.
export function reduceEvidence(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {
    status: statusOf(src.status),
    headers: pickHeaders(src.headers),
    markers: stringList(src.markers, 20, 120),
  };
  const set = (k, v) => {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  };
  set('finalPath', pathOnly(src.finalPath));
  set('redirected', boolOrNull(src.redirected));
  // Redacted before it is clipped: a clip in the middle of a secret would
  // leave its first half readable.
  set('bodyExcerpt', typeof src.bodyExcerpt === 'string' ? clip(redactText(src.bodyExcerpt), EXCERPT_CHARS) : null);
  set('expected', nameOf(src.expected) ? clip(nameOf(src.expected), 200) : null);
  set('actual', nameOf(src.actual) ? clip(nameOf(src.actual), 200) : null);
  set('method', text(src.method) ? clip(src.method.trim().toUpperCase(), 10) : null);
  set('path', pathOnly(src.path));
  set('requestId', typeof src.requestId === 'string' || typeof src.requestId === 'number' ? clip(src.requestId, 40) : null);
  set('stepKey', typeof src.stepKey === 'string' ? clip(src.stepKey, 300) : null);
  set('attempt', intOrNull(src.attempt));
  if (src.error && typeof src.error === 'object') {
    set('error', { name: clip(text(src.error.name) || 'Error', 60), message: clip(text(src.error.message), 200) });
  } else if (typeof src.error === 'string' && src.error) {
    set('error', { name: 'Error', message: clip(src.error, 200) });
  }
  set('url', pathOnly(src.url));
  set('title', text(src.title) ? clip(src.title.trim(), 200) : null);
  set('hasImporter', boolOrNull(src.hasImporter));
  set('online', boolOrNull(src.online));
  set('phase', text(src.phase) ? clip(src.phase, 40) : null);
  if (Array.isArray(src.orgs)) out.orgs = stringList(src.orgs, 20, 64);
  set('expectedOrg', text(src.expectedOrg) ? clip(src.expectedOrg.trim(), 64) : null);
  set('signal', text(src.signal) ? clip(src.signal, 40) : null);
  set('elapsedMs', intOrNull(src.elapsedMs));
  return redact(out);
}

// ---------------------------------------------------------------- texts

// What happened and what to do, in the person's terms. {expected}, {actual},
// {status}, {link}, {expectedOrg}, {error} and {signal} come from ctx; a
// missing value gets a plain stand-in rather than a hole. The signal tells
// two cases of a kind apart where what to do differs: an identity probe
// that got no answer (press Resume, not Confirm) and the right account
// without the registry's organization (Cancel and fix cswap, not sign in
// again). The texts never promise an automatic retry or an account switch,
// because none exists.
export function describe(kind, ctx = {}) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  // Which job the texts are about: an import (the default, and every text
  // the tests hold) or the export half of a Duplicate.
  const flow = c.flow === 'export' ? 'export' : 'import';
  const expected = nameOf(c.expected) || (flow === 'export' ? 'the account the project is in' : 'the destination account');
  const actual = nameOf(c.actual) || 'another account';
  const status = statusOf(c.status);
  const link = text(c.link).trim();
  const markers = stringList(c.markers, 20, 120);
  const signal = text(c.signal);
  const org = text(c.expectedOrg).trim();
  const error = typeof c.error === 'string' ? c.error.trim() : c.error && typeof c.error === 'object' ? text(c.error.message).trim() : '';
  const http = status === null ? '' : `HTTP ${status}`;
  const join = (...parts) => parts.filter(Boolean).join(', ');

  switch (kind) {
    case 'challenge': {
      const how = signal === 'markers' ? 'a challenge page in the reply'
        : signal === 'server-timing' ? 'server-timing: chlray'
        : 'cf-mitigated: challenge';
      return {
        what: `claude.ai asked this browser to pass a Cloudflare check (${join(http, how)}).`,
        todo: `Open https://claude.ai in a NEW tab of this same Chrome profile, complete the check there, then come back here and press Resume. Do not reload the ${flow} tab: the ${flow} lives in it.`,
      };
    }
    case 'blocked': {
      const how = markers.includes('error code: 1020') ? 'error 1020' : 'blocked by Cloudflare';
      return {
        what: `Cloudflare refused the request outright (${join(http || 'HTTP 403', how)}).`,
        todo: 'Nothing is retried on its own. Wait a while, then press Resume to send it once more. If it is refused again, stop and look at the log.',
      };
    }
    case 'signed-out':
      return {
        what: 'This browser is no longer signed in to claude.ai (HTTP 401 or a redirect to the sign-in page).',
        todo: `Sign in as ${expected} in a NEW tab of this profile, then press Resume. Do not reload the ${flow} tab.`,
      };
    case 'wrong-account':
      if (signal === 'org-missing') {
        // The email is the right one; it is cswap's registry that names an
        // organization this account cannot see. Signing in again cannot
        // change that, so Resume would only find the same thing.
        const which = org ? `organization ${org}` : 'the organization cswap\'s registry names for it';
        return {
          what: `claude.ai is signed in as ${expected}, which is the right account, but it cannot see ${which}, the one cswap's registry holds for it.`,
          todo: 'Press Cancel, re-add the account with cswap (or correct its organization in cswap\'s registry), then run cswap project-move import again. Signing in again will not help: the account is the right one.',
        };
      }
      return {
        what: `claude.ai is signed in as ${actual}, not ${expected}.`,
        todo: `Sign out, sign in as ${expected} (a separate Chrome profile is the easiest way), then press Resume. cswap never switches accounts for you.`,
      };
    case 'identity-unknown':
      if (signal === 'probe-failed') {
        // Nothing was asked successfully, so there is nothing for the
        // person to confirm: the check has to be run again.
        const detail = join(status ? http : '', error) || 'no reply';
        return {
          what: `The account check got no answer from claude.ai (${detail}), so it is not known which account is signed in.`,
          todo: `Check that this browser is online and that https://claude.ai opens in a NEW tab of this profile, then press Resume to run the check again. Do not reload the ${flow} tab.`,
        };
      }
      if (!nameOf(c.expected) && nameOf(c.actual)) {
        // claude.ai did answer, but the job carries no account to compare
        // it with: the person decides.
        return {
          what: `claude.ai is signed in as ${actual}; cswap was not told which account the ${flow} is for.`,
          todo: 'If that is the account the project should go to, press Confirm; otherwise sign in as the right one first.',
        };
      }
      return {
        what: 'claude.ai did not say which account is signed in.',
        todo: `Check the account in the page's menu. If it is ${expected}, press Confirm; otherwise sign in as ${expected} first.`,
      };
    case 'challenge-page':
      return {
        what: `The ${flow} tab itself is showing a Cloudflare check.`,
        todo: 'Complete it in that tab. When the page is claude.ai again, press Resume.',
      };
    case 'page-reloaded':
    case 'tab-closed':
      if (link) {
        return {
          what: 'The page went away after the project was created.',
          todo: `The new project ${link} exists and holds what was added before that. To start over, delete it, then run cswap project-move import again.`,
        };
      }
      if (flow === 'export') {
        return {
          what: 'The export page went away before it finished.',
          todo: `Open claude.ai, signed in as ${expected}, and press Resume: the export starts again from the beginning.`,
        };
      }
      return {
        what: 'The import page went away before anything was created.',
        todo: `Open claude.ai, signed in as ${expected}, and press Resume: the import starts again from the beginning.`,
      };
    default:
      return {
        what: `The ${flow} stopped (${clip(text(kind) && kind !== 'unknown' ? kind : 'unknown reason', 40)}).`,
        todo: 'Look at the log in the cswap side panel, then press Resume to go on or Cancel to stop.',
      };
  }
}

// Whether pressing Resume can ever clear an interruption of this kind. Not
// after the page went away with a created project behind it (the job is
// over), and not when the right account lacks the registry's organization
// (only cswap's registry can change that).
function resumableByDefault(kind, c) {
  if ((kind === 'page-reloaded' || kind === 'tab-closed') && Boolean(c.link)) return false;
  if (kind === 'wrong-account' && c.signal === 'org-missing') return false;
  return true;
}

// An Interruption without id and at, which raise() adds. ctx is kept on it
// so that raise() can word it again with the job's own context (the
// expected email, the created project's link) without losing what the
// classifier knew, such as the description of the account actually seen.
function interruption(kind, evidence, ctx) {
  const c = {
    expected: nameOf(ctx.expected) || evidence.expected || '',
    actual: nameOf(ctx.actual) || evidence.actual || '',
    status: ctx.status ?? evidence.status ?? null,
    link: text(ctx.link),
    markers: evidence.markers,
    signal: evidence.signal || '',
    expectedOrg: evidence.expectedOrg || '',
    error: evidence.error && typeof evidence.error === 'object' ? text(evidence.error.message) : '',
    flow: ctx.flow === 'export' ? 'export' : 'import',
  };
  const { what, todo } = describe(kind, c);
  return { kind, what, todo, resumable: resumableByDefault(kind, c), evidence, ctx: c };
}

// ---------------------------------------------------------------- responses

function expectedOf(v) {
  if (typeof v === 'string') return { email: v.trim(), orgUuid: '', flow: 'import' };
  if (v && typeof v === 'object') return { email: nameOf(v.email), orgUuid: text(v.orgUuid || v.org_uuid).trim(), flow: v.flow === 'export' ? 'export' : 'import' };
  return { email: '', orgUuid: '', flow: 'import' };
}

function authErrorBody(bodyJson) {
  if (!bodyJson || typeof bodyJson !== 'object') return false;
  const err = bodyJson.error && typeof bodyJson.error === 'object' ? bodyJson.error : bodyJson;
  return AUTH_TYPES.has(lower(err.type)) || AUTH_REASONS.has(lower(err.reason)) || AUTH_MESSAGE_RE.test(text(err.message));
}

// Classifies one response report (section 2.9 of the design), first match
// wins. Pure. Throws only for a non-object argument: a report is produced by
// page.js, and anything else is a programming error worth hearing about.
//
//   { verdict: 'interrupt', kind, evidence, interruption }   stop and tell
//   { verdict: 'slow-down', retryAfterMs, evidence }         the gate waits
//   { verdict: 'network', evidence }                         the script's own retry
//   { verdict: 'pass', evidence }                            the script's business
//
// opts.now (ms) lets an HTTP-date Retry-After be measured; without it (or
// rep.endedAt) such a header gives retryAfterMs null and the gate reads the
// raw header with its own clock. opts.expected (email or {email, orgUuid})
// fills the texts; the worker can also pass ctx to raise() later.
export function classifyResponse(rep, opts = {}) {
  if (!rep || typeof rep !== 'object') throw new TypeError('classifyResponse: the report must be an object');
  const o = opts && typeof opts === 'object' ? opts : {};
  const status = statusOf(rep.status);
  const headers = pickHeaders(rep.headers);
  const markers = Array.isArray(rep.markers) ? stringList(rep.markers, 20, 120)
    : typeof rep.bodyText === 'string' ? scanBody(rep.bodyText) : [];
  // Only gated requests are reported, and the gate only sees /api/ and /v1/,
  // so a report that forgot its path is still one of them: a 401 on it means
  // signed out. Letting it pass would let the script record 401 after 401.
  const path = pathOnly(rep.path) || pathOnly(rep.url);
  const finalPath = pathOnly(rep.finalPath);
  const html = lower(headers['content-type']).startsWith('text/html');
  const cfRay = Boolean(headers['cf-ray']);
  const now = Number.isFinite(o.now) ? o.now : Number.isFinite(rep.endedAt) ? rep.endedAt : NaN;
  const retryAfter = headers['retry-after'];
  const retryAfterMs = parseRetryAfter(retryAfter, now);
  // An HTTP-date arrived and there is no clock here to measure it from. The
  // gate has one and reads the header itself when retryAfterMs is null, so
  // that the site's full wait is honoured and not a stand-in for it.
  // Measured from the epoch, any date parses; junk still does not.
  const dateWithoutClock = retryAfterMs === null && parseRetryAfter(retryAfter, 0) !== null;
  const expected = expectedOf(o.expected ?? rep.expected);
  const base = { ...rep, status, headers, markers, path, finalPath, expected: expected.email, actual: null };
  const stop = (kind, signal) => {
    const evidence = reduceEvidence({ ...base, signal });
    return { verdict: 'interrupt', kind, evidence, interruption: interruption(kind, evidence, { link: o.link }) };
  };

  if (lower(headers['cf-mitigated']) === 'challenge') return stop('challenge', 'cf-mitigated');
  if ((status === 403 || status === 503) && html && hasAny(markers, CHALLENGE_MARKERS)) return stop('challenge', 'markers');
  if ((status === 403 || status === 503) && lower(headers['server-timing']).includes('chlray')) return stop('challenge', 'server-timing');
  if (status === 403 && html && cfRay && hasAny(markers, BLOCKED_MARKERS)) return stop('blocked', 'markers');
  if (status === 429 && html && cfRay && hasAny(markers, RATE_LIMIT_MARKERS)) {
    // The page's own wait when it gives one; a minute when it gives none
    // the gate could read either (the site said slow down, and the script's
    // own waits are shorter); null for an HTTP-date that only the gate's
    // clock can measure, never a minute in place of it.
    const wait = retryAfterMs !== null ? retryAfterMs : dateWithoutClock ? null : RATE_LIMIT_PAGE_WAIT_MS;
    return { verdict: 'slow-down', retryAfterMs: wait, evidence: reduceEvidence({ ...base, signal: 'rate-limit-page' }) };
  }
  if (status === 429) return { verdict: 'slow-down', retryAfterMs, evidence: reduceEvidence({ ...base, signal: 'status-429' }) };
  if (status === 401 && (!path || GATED_PATH_RE.test(path))) return stop('signed-out', 'status-401');
  // A request to /api/ cannot end on /login without a redirect, so a
  // finalPath on the sign-in page counts even when the redirected flag was
  // left out, as long as it is not simply the path that was asked for.
  if (finalPath && LOGIN_PATH_RE.test(finalPath) && (rep.redirected === true || (rep.redirected !== false && finalPath !== path))) {
    return stop('signed-out', 'redirect');
  }
  if (status === 403 && authErrorBody(rep.bodyJson)) return stop('signed-out', 'auth-error');
  if (status === 0 && rep.error) return { verdict: 'network', evidence: reduceEvidence({ ...base, signal: 'fetch-error' }) };
  return { verdict: 'pass', evidence: reduceEvidence(base) };
}

// ---------------------------------------------------------------- the page

function jobStateOf(jobState) {
  if (typeof jobState === 'string') return { phase: jobState, expected: '', link: '', flow: 'import' };
  const j = jobState && typeof jobState === 'object' ? jobState : {};
  const created = j.created || j.createdProject || j.created_project;
  const link = text(j.link) || (created && typeof created === 'object' ? text(created.url) : '');
  const expected = nameOf(j.expected) || nameOf(j.account);
  return { phase: text(j.phase), expected, link, flow: j.flow === 'export' ? 'export' : 'import' };
}

// Classifies what content.js sees in the import tab. The order is a decision
// of this module: the interstitial's title is certain, so it goes first; the
// sign-in page's path goes before the DOM selectors because claude.ai's own
// sign-in page carries a Turnstile widget, and "sign in as X" is the right
// thing to tell the person there; then any selector; then a page that lost
// the importer while the job was live. The selector list is not filtered
// against PAGE_MARKER_SELECTORS: any marker content.js reports stops the
// import, which is the safe direction when the two copies drift.
export function classifyPage(probe, jobState = {}) {
  if (!probe || typeof probe !== 'object') throw new TypeError('classifyPage: the probe must be an object');
  const job = jobStateOf(jobState);
  const path = pathOnly(probe.url);
  const title = text(probe.title).trim();
  const markers = stringList(probe.markers, 20, 120);
  const evidence = reduceEvidence({
    url: probe.url, title, markers, hasImporter: probe.hasImporter, online: probe.online,
    phase: job.phase, expected: job.expected,
  });
  const stop = kind => interruption(kind, evidence, { expected: job.expected, link: job.link, flow: job.flow });

  if (/^just a moment/i.test(title)) return stop('challenge-page');
  if (path && LOGIN_PATH_RE.test(path)) return stop('signed-out');
  if (markers.length) return stop('challenge-page');
  if (ACTIVE_PHASES.has(job.phase) && probe.hasImporter === false) return stop('page-reloaded');
  return null;
}

// ---------------------------------------------------------------- identity

// Compares what the identity probe found with the account the CLI named.
// Tighter than the design's table in one place: an account is accepted only
// when something proves it (the email matches, or the expected organization
// is among the signed-in ones). When nothing can prove it, the person
// confirms, even if an email came back that there was nothing to compare
// with. Emails are compared trimmed and case-insensitively; org uuids too.
//
// Two cases carry a signal in their evidence because what to do differs
// from the rest of their kind. 'org-missing': the email is the expected one
// but the registry's organization is not among the account's, which no
// sign-in can fix (wrong-account, not resumable). 'probe-failed': the probe
// never got an account out of claude.ai (the fetch threw, or the site
// answered with an error and no email or organization list), so there is
// nothing to confirm and the check must be run again (identity-unknown,
// asking for Resume). A 200 that held nothing readable stays the design's
// identity-unknown: the site answered, the person confirms.
export function classifyIdentity(identity, expected = {}) {
  if (!identity || typeof identity !== 'object') throw new TypeError('classifyIdentity: the identity must be an object');
  const exp = expectedOf(expected);
  const status = statusOf(identity.status);
  const email = nameOf(identity.email) || null;
  const finalPath = pathOnly(identity.finalPath);
  // orgs: a list of uuids, or of objects with a uuid (the raw /api/organizations
  // rows). A list that holds nothing readable is "unknown", not "empty":
  // only a genuinely empty list means the account has no organization.
  const rawOrgs = Array.isArray(identity.orgs) ? identity.orgs : null;
  let orgs = rawOrgs
    ? stringList(rawOrgs.map(o => (typeof o === 'string' ? o.trim() : o && typeof o === 'object' ? text(o.uuid).trim() : '')), 50, 64)
    : null;
  if (rawOrgs && rawOrgs.length && orgs.length === 0) orgs = null;
  const source = {
    status, finalPath, path: identity.path, error: identity.error, orgs,
    expected: exp.email, actual: email, expectedOrg: exp.orgUuid,
  };
  const stop = (kind, actual, signal) => interruption(kind, reduceEvidence({ ...source, signal }), { expected: exp.email, actual, flow: exp.flow });

  if (status === 401 || (finalPath && LOGIN_PATH_RE.test(finalPath)) || (orgs && orgs.length === 0)) return stop('signed-out');
  const orgListed = orgs ? orgs.some(o => o.toLowerCase() === exp.orgUuid.toLowerCase()) : false;
  const emailProven = Boolean(email && exp.email && sameEmail(email, exp.email));
  if (email && exp.email && !emailProven) return stop('wrong-account', email);
  if (orgs && exp.orgUuid && !orgListed) {
    if (emailProven) return stop('wrong-account', email, 'org-missing');
    return stop('wrong-account', email ? `${email}, which has no organization ${exp.orgUuid}` : `an account without organization ${exp.orgUuid}`);
  }
  const orgProven = Boolean(orgs && exp.orgUuid && orgListed);
  if (emailProven || orgProven) return null;
  const answered = status !== null && status !== 0 && status < 400;
  const probeFailed = !email && !orgs && (!answered || Boolean(identity.error));
  return stop('identity-unknown', email, probeFailed ? 'probe-failed' : undefined);
}

// ---------------------------------------------------------------- the record

function freshState() {
  return { version: 1, current: null, history: [] };
}

function idNumber(id) {
  const m = /^i(\d+)$/.exec(text(id));
  return m ? Number(m[1]) : 0;
}

// A persisted interruption is kept when it has the shape this module writes;
// junk entries are dropped one by one rather than the whole state, so a
// damaged history never hides the current interruption.
function validEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  if (!/^i\d+$/.test(text(e.id)) || !text(e.kind)) return null;
  const out = {
    id: e.id,
    kind: clip(e.kind, 40),
    at: Number.isFinite(e.at) ? e.at : 0,
    what: clip(text(e.what), 500),
    todo: clip(text(e.todo), 1000),
    resumable: e.resumable !== false,
    evidence: reduceEvidence(e.evidence),
    resolvedAt: Number.isFinite(e.resolvedAt) ? e.resolvedAt : null,
    resolvedBy: ['person', 'cancel', 'superseded'].includes(e.resolvedBy) ? e.resolvedBy : null,
  };
  if (typeof e.permit === 'string') out.permit = clip(e.permit, 40);
  if (typeof e.requestId === 'string' || typeof e.requestId === 'number') out.requestId = clip(e.requestId, 40);
  if (typeof e.job === 'string' || typeof e.job === 'number') out.job = clip(e.job, 80);
  return out;
}

function normalizeState(raw, max) {
  const problems = [];
  if (raw === undefined || raw === null) return { state: freshState(), problems };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('stored interruption state is not an object');
    return { state: freshState(), problems };
  }
  if (raw.version !== 1) problems.push(`stored interruption state has version ${JSON.stringify(raw.version)}, expected 1`);
  const history = [];
  const list = Array.isArray(raw.history) ? raw.history : [];
  if (!Array.isArray(raw.history) && raw.history !== undefined) problems.push('stored history is not a list');
  for (const e of list) {
    const v = validEntry(e);
    if (v) history.push(v);
    else problems.push('a stored history entry was dropped');
  }
  let current = raw.current === null || raw.current === undefined ? null : validEntry(raw.current);
  if (raw.current && !current) problems.push('the stored current interruption was unreadable and dropped');
  if (current && current.resolvedAt !== null) {
    // A current interruption that is already resolved is a contradiction;
    // the resolution wins, because nothing can be waiting on it.
    problems.push('the stored current interruption was already resolved');
    current = null;
  }
  return { state: { version: 1, current, history: history.slice(-max) }, problems };
}

function memoryStore() {
  let value;
  return { get: async () => copy(value), set: async v => { value = copy(v); } };
}

// Keeps the current interruption and the last `max` of them. Every change is
// written to the store (bound to 'cswap.interrupt' by the caller) before the
// returned promise resolves, so a service-worker restart followed by load()
// shows the panel the same thing. No method throws: a broken store or logger
// is reported through the logger when it works and otherwise ignored, and the
// in-memory state stays authoritative for this run.
//
//   now:     () => ms
//   store:   { get(): Promise<any>, set(value): Promise<void> }
//   log:     { warn(event, msg, data, job), error(...), info(...) } or absent
//   redact:  (value) => value, applied on top of this module's own redaction
//   max:     history length, 1..200
//   context: () => ({ expected, link }) for the texts, when the caller has a job
export function createInterrupts({ now = Date.now, store, log, redact: extraRedact, max = 20, context } = {}) {
  const limit = Number.isInteger(max) && max >= 1 && max <= 200 ? max : 20;
  const backing = store && typeof store.get === 'function' && typeof store.set === 'function' ? store : memoryStore();
  let state = freshState();
  let writing = Promise.resolve();

  const say = (level, msg, data, job) => {
    try {
      if (log && typeof log[level] === 'function') log[level]('interruption', msg, data || {}, job === undefined ? null : job);
    } catch {
      // A logger that throws must not take the import down with it.
    }
  };

  const clock = () => {
    try {
      const t = Number(now());
      return Number.isFinite(t) ? t : 0;
    } catch {
      return 0;
    }
  };

  const cleaned = value => {
    const own = reduceEvidence(value);
    if (typeof extraRedact !== 'function') return own;
    try {
      const more = extraRedact(own);
      return more && typeof more === 'object' ? copy(more) : own;
    } catch (e) {
      say('error', 'the injected redact() threw; the built-in redaction was kept', { error: text(e && e.message) });
      return own;
    }
  };

  function persist() {
    const snap = { version: 1, current: copy(state.current), history: copy(state.history) };
    writing = writing
      .then(() => backing.set(snap))
      .catch(e => say('error', 'could not write the interruption state', { error: text(e && e.message) }));
    return writing;
  }

  function nextId() {
    let n = 0;
    for (const e of state.history) n = Math.max(n, idNumber(e.id));
    if (state.current) n = Math.max(n, idNumber(state.current.id));
    return `i${n + 1}`;
  }

  async function load() {
    let raw;
    try {
      raw = await backing.get();
    } catch (e) {
      say('warn', 'could not read the interruption state; starting empty', { error: text(e && e.message) });
      raw = undefined;
    }
    const { state: next, problems } = normalizeState(raw, limit);
    state = next;
    if (problems.length) say('warn', 'stored interruption state was repaired', { problems });
  }

  // Records an interruption. partial is what classifyResponse().interruption,
  // classifyPage() or classifyIdentity() returned, or a plain {kind, ...}
  // with the evidence fields at its top level. The wording of a known kind
  // is always describe()'s, filled in with the fullest context available
  // (the injected context() of the job, then partial.ctx, then the
  // evidence): the classifiers do not always know the destination email,
  // and this is where it gets added. A partial of an unknown kind keeps the
  // what and todo it brings. The evidence is reduced and redacted here
  // again, whatever the caller did. It becomes the current interruption
  // when there is none, or when the current one cannot be a live hold any
  // more (see stale()); otherwise only partial.replace (the worker's failed
  // Resume probe) replaces it. A replaced one is marked superseded.
  // Everything raised goes into the history. partial.job, when given, is
  // kept on the entry so that a later job's interruption is told apart.
  async function raise(partial) {
    const p = partial && typeof partial === 'object' ? partial : {};
    if (!partial || typeof partial !== 'object') say('warn', 'raise() was given something that is not an interruption', { got: typeof partial });
    const kind = text(p.kind) ? clip(p.kind, 40) : 'unknown';
    const known = KINDS.includes(kind);
    if (!known) say('warn', `interruption of unknown kind "${kind}"`, {});
    const base = typeof context === 'function' ? safeContext() : {};
    const given = p.ctx && typeof p.ctx === 'object' ? p.ctx : {};
    const expected = nameOf(p.expected) || nameOf(given.expected) || nameOf(base.expected) || '';
    const link = text(p.link) || text(given.link) || text(base.link) || '';
    const source = p.evidence && typeof p.evidence === 'object' ? p.evidence : p;
    const evidence = cleaned({ ...source, expected: nameOf(source.expected) || expected });
    const fresh = interruption(kind, evidence, { ...base, ...given, expected, link });
    const keepTexts = !known && text(p.what) && text(p.todo);
    const entry = {
      id: nextId(),
      kind,
      at: clock(),
      what: keepTexts ? clip(p.what, 500) : fresh.what,
      todo: keepTexts ? clip(p.todo, 1000) : fresh.todo,
      resumable: typeof p.resumable === 'boolean' ? p.resumable : fresh.resumable,
      evidence,
      resolvedAt: null,
      resolvedBy: null,
    };
    if (typeof p.permit === 'string') entry.permit = clip(p.permit, 40);
    if (typeof p.requestId === 'string' || typeof p.requestId === 'number') entry.requestId = clip(p.requestId, 40);
    if (typeof p.job === 'string' || typeof p.job === 'number') entry.job = clip(p.job, 80);

    if (state.current && (p.replace === true || stale(state.current, entry))) {
      if (p.replace !== true) say('info', `${state.current.kind} (${state.current.id}) belongs to no live hold; superseded by ${kind}`, { id: state.current.id, kind: state.current.kind, job: state.current.job === undefined ? null : state.current.job });
      settle(state.current.id, clock(), 'superseded');
      state.current = null;
    }
    state.history.push(copy(entry));
    if (state.history.length > limit) state.history.splice(0, state.history.length - limit);
    if (!state.current) state.current = copy(entry);
    say('warn', `${kind}: ${entry.what}`, { id: entry.id, kind, what: entry.what, todo: entry.todo, evidence }, p.job === undefined ? null : p.job);
    await persist();
    return copy(entry);
  }

  function safeContext() {
    try {
      const c = context();
      return c && typeof c === 'object' ? c : {};
    } catch {
      return {};
    }
  }

  // A current interruption that no Resume can clear is not a live hold:
  // one that is not resumable (the page went away after the project was
  // created and the job ended with it; the right account without the
  // registry's organization), or one raised for another job, which can
  // only mean that job is over. Left in place it would hide the next
  // job's interruption behind the old card and the old instructions, so
  // the next raise takes its place.
  function stale(current, next) {
    if (current.resumable === false) return true;
    return current.job !== undefined && next.job !== undefined && current.job !== next.job;
  }

  function settle(id, at, by) {
    for (const e of state.history) {
      if (e.id === id && e.resolvedAt === null) {
        e.resolvedAt = at;
        e.resolvedBy = by;
      }
    }
  }

  // Clears the current interruption, marking it resolved by the person, by
  // a cancel, or as superseded (the worker clearing a card left by a job
  // that ended). A second clear, or a clear while nothing is current,
  // changes and writes nothing.
  async function clear(by) {
    if (!RESOLVERS.has(by)) {
      say('warn', `clear() called with "${clip(String(by), 20)}"; recorded as "person"`, {});
      by = 'person';
    }
    if (!state.current) return null;
    const done = state.current;
    const at = clock();
    done.resolvedAt = at;
    done.resolvedBy = by;
    settle(done.id, at, by);
    state.current = null;
    say('info', `${done.kind} cleared by ${by}`, { id: done.id, kind: done.kind });
    await persist();
    return copy(done);
  }

  return {
    load,
    raise,
    clear,
    current: () => copy(state.current),
    history: () => copy(state.history),
    snapshot: () => ({ current: copy(state.current), history: copy(state.history) }),
  };
}
