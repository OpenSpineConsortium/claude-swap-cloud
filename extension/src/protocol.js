// The names everything in the extension agrees on: port names, storage keys,
// message types, the native host, and the markers and lists that interrupt.js
// also exports. page.js and content.js cannot import (they are classic scripts
// run in a tab), so they carry literal copies of what they need, and
// tests/js/extension/scaffold.test.js holds those copies equal to this file.
//
// Plain ASCII, LF endings, no build step: the extension is loaded unpacked.

export const HOST_NAME = 'com.claude_swap.bridge';
export const PROTOCOL = 1;

// Where the import script and page.js run. The user-script world is exempt
// from the page's CSP and touches nothing claude.ai's own code uses. If a
// same-origin fetch from it turns out not to carry the sign-in, this one
// constant becomes 'MAIN' and nothing else changes.
export const WORLD = 'USER_SCRIPT';

export const CLAUDE_ORIGIN = 'https://claude.ai';
export const CLAUDE_URL_PREFIX = 'https://claude.ai/';
export const IMPORTER_ID = 'claude-simple-importer';
export const EXPORTER_ID = 'claude-simple-exporter';

// The two jobs a tab can run: the import queued from the command line, and
// the export that a Duplicate starts from the side panel.
export const JOB_KINDS = Object.freeze(['import', 'export']);

// Native messaging: Chrome caps a host-to-extension frame at 1 MB, so a file
// travels in raw chunks of this size (about 700 KB once base64-encoded).
export const MAX_HOST_MESSAGE = 1024 * 1024;
export const CHUNK_BYTES = 512 * 1024;

export const PORTS = Object.freeze({
  page: 'cswap-page',
  content: 'cswap-content',
  panel: 'cswap-panel',
});

export const KEYS = Object.freeze({
  config: 'cswap.config',
  log: 'cswap.log',
  job: 'cswap.job',
  gate: 'cswap.gate',
  interrupt: 'cswap.interrupt',
  export: 'cswap.export',
  instance: 'cswap.instance',
  bridge: 'cswap.bridge',
});

// Message types. page.js -> worker, worker -> page.js, content.js -> worker,
// worker -> content.js, sidepanel.js -> worker.
export const MSG = Object.freeze({
  pageAttach: 'page.attach',
  exportList: 'export.list',
  fileRead: 'file.read',
  gatePermit: 'gate.permit',
  gateReport: 'gate.report',
  identityResult: 'identity.result',
  scriptEvent: 'script.event',
  exportSet: 'export.set',
  probeIdentity: 'probe.identity',
  fileWrite: 'file.write',
  probeProjects: 'probe.projects',
  projectsResult: 'projects.result',
  press: 'press',
  cancel: 'cancel',
  pageState: 'page.state',
  probeDom: 'probe.dom',
  cmd: 'cmd',
});

export const PANEL_COMMANDS = Object.freeze([
  'pause', 'resume', 'cancel', 'retry', 'giveUp', 'identity.confirm', 'job.refresh',
  'config.set', 'config.reset', 'log.clear', 'log.export', 'notify.test',
  'duplicate.start', 'duplicate.choose', 'duplicate.choices', 'duplicate.import',
  'duplicate.driven', 'duplicate.driven.refresh',
]);

// Phases of a job as the worker keeps them in cswap.job.phase. An export
// job waits in 'choosing' for the project and the destination.
export const PHASES = Object.freeze([
  'preflight', 'choosing', 'loading', 'ready', 'running', 'held', 'done', 'failed', 'cancelled',
]);
export const TERMINAL_PHASES = Object.freeze(['done', 'failed', 'cancelled']);

// Reconnect backoff of every port client, in milliseconds, fixed and never
// randomized: the fifth value repeats.
export const RECONNECT_BACKOFF_MS = Object.freeze([0, 1000, 2000, 5000, 5000]);

// Alarms the worker uses: the poll while a job is active, and the wake-up
// for a gate wait too long for a service-worker timer.
export const ALARM_POLL = 'cswap-poll';
export const ALARM_WAKE = 'cswap-wake';

// A page port that stays disconnected this long is a page that went away.
export const PAGE_GONE_MS = 10000;

// The only response headers that ever appear in a report, record, event or
// diagnostic. Lowercase; `location` is reduced to its path.
export const HEADER_ALLOWLIST = Object.freeze([
  'retry-after', 'content-type', 'content-length', 'cf-mitigated', 'cf-ray',
  'server', 'server-timing', 'location', 'date',
]);

// Markers of a Cloudflare challenge, block or rate-limit page, looked for in
// the first 64 KiB of an HTML error body, lowercased.
export const BODY_MARKERS = Object.freeze([
  'cf-chl-', '__cf_chl', 'cf_chl_opt', 'challenge-platform',
  '/cdn-cgi/challenge-platform/', 'challenges.cloudflare.com', 'cf-turnstile',
  'turnstile', '<title>just a moment', 'checking your browser',
  'verify you are human', 'attention required! | cloudflare',
  'error code: 1020', 'sorry, you have been blocked', 'access denied',
  'error code: 1015', 'you are being rate limited',
]);

// Elements whose presence means the tab itself is showing a challenge.
export const PAGE_MARKER_SELECTORS = Object.freeze([
  '#challenge-form', '#challenge-running', '#cf-challenge-running', '.cf-turnstile',
  'iframe[src*="challenges.cloudflare.com"]',
  'script[src*="challenges.cloudflare.com/turnstile"]',
  'script[src*="/cdn-cgi/challenge-platform/"]',
]);

// Paths the site sends a signed-out browser to. Kept as source text so the
// classic scripts can hold the same regex literally.
export const LOGIN_PATH_RE_SOURCE = '^\\/(login|magic-link|oauth|auth)(\\/|$)';
export const LOGIN_PATH_RE = new RegExp(LOGIN_PATH_RE_SOURCE);

// Where the signed-in account's email is asked for, in order; the first 200
// whose JSON carries one wins.
export const ACCOUNT_ENDPOINTS = Object.freeze(['/api/account', '/api/auth/current_account']);
export const ORGS_ENDPOINT = '/api/organizations';

// Requests that create the project: one per job, never twice.
export const CREATE_PATH_RE_SOURCES = Object.freeze([
  '^\\/api\\/organizations\\/[^/]+\\/projects$',
  '^\\/v1\\/code\\/channels$',
]);
