// Uploads the store zip to the extension's Chrome Web Store item and, when
// asked, submits it for review, through the Chrome Web Store API.
//
//   node extension/scripts/publish.mjs --upload [--zip PATH]
//   node extension/scripts/publish.mjs --publish trusted-testers|everyone
//   node extension/scripts/publish.mjs --status
//   node extension/scripts/publish.mjs --upload --if-configured
//
// The item and the credentials come from the environment, never from a
// file in the repository (docs/store/SUBMISSION.md, "Releasing from CI"):
// CWS_ITEM_ID (the store item's id), CWS_CLIENT_ID, CWS_CLIENT_SECRET and
// CWS_REFRESH_TOKEN (the OAuth client and the refresh token the maintainer
// made once). With --if-configured a run without them does nothing and
// exits 0, which is how a repository without the secrets stays green.
//
// Nothing here loops or retries: an upload the store refuses, or one it is
// still processing, ends the run with the store's own words and what to
// do next, and the person decides. No credential is ever printed: every
// line that reaches the log passes through redact() first, and the access
// token lives only in a request header. Node's standard library only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.resolve(HERE, '..', '.output');

export const SECRET_NAMES = Object.freeze(['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN']);
export const ITEM_NAME = 'CWS_ITEM_ID';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const API_BASE = 'https://www.googleapis.com';
export const API_VERSION_HEADER = '2';
export const TARGETS = Object.freeze({ 'trusted-testers': 'trustedTesters', everyone: 'default' });

const ITEM_ID_RE = /^[a-p]{32}$/;

// Which of the four variables the environment lacks.
export function missing(env) {
  return [ITEM_NAME, ...SECRET_NAMES].filter(name => !(typeof env[name] === 'string' && env[name].trim()));
}

// Every secret's value replaced before a line is logged. The values are
// long and random, so a plain replace is enough; an empty value is skipped
// so it cannot match everywhere.
export function redact(text, env) {
  let out = String(text);
  for (const name of SECRET_NAMES) {
    const value = env[name];
    if (typeof value === 'string' && value.length >= 8) out = out.split(value).join(`<${name}>`);
  }
  return out;
}

export function tokenRequest(env) {
  const body = new URLSearchParams({
    client_id: env.CWS_CLIENT_ID,
    client_secret: env.CWS_CLIENT_SECRET,
    refresh_token: env.CWS_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  }).toString();
  return { url: TOKEN_URL, init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body } };
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}`, 'x-goog-api-version': API_VERSION_HEADER };
}

export function uploadRequest(itemId, token, bytes) {
  return {
    url: `${API_BASE}/upload/chromewebstore/v1.1/items/${itemId}`,
    init: { method: 'PUT', headers: { ...authHeaders(token), 'content-type': 'application/zip' }, body: bytes },
  };
}

export function publishRequest(itemId, token, target) {
  const publishTarget = TARGETS[target];
  if (!publishTarget) throw new Error(`--publish takes ${Object.keys(TARGETS).join(' or ')}, not ${JSON.stringify(target)}`);
  return {
    url: `${API_BASE}/chromewebstore/v1.1/items/${itemId}/publish?publishTarget=${publishTarget}`,
    init: { method: 'POST', headers: { ...authHeaders(token), 'content-length': '0' } },
  };
}

export function statusRequest(itemId, token) {
  return { url: `${API_BASE}/chromewebstore/v1.1/items/${itemId}?projection=DRAFT`, init: { method: 'GET', headers: authHeaders(token) } };
}

// The store's answer to an upload, in a sentence. uploadState is SUCCESS,
// IN_PROGRESS, FAILURE or NOT_FOUND; itemError carries the reasons.
export function describeUpload(body) {
  const state = body && typeof body.uploadState === 'string' ? body.uploadState : '';
  const errors = Array.isArray(body && body.itemError) ? body.itemError.map(e => e.error_detail || e.error_code || JSON.stringify(e)) : [];
  if (state === 'SUCCESS') return { ok: true, text: 'The store accepted the package as the item\'s new draft.' };
  if (state === 'IN_PROGRESS') return { ok: false, text: 'The store is still processing the package. Run --status later, then --publish when it shows SUCCESS.' };
  if (state === 'NOT_FOUND') return { ok: false, text: `The store has no item with this id for this account. Check ${ITEM_NAME}: it is the id the dashboard shows for the item.` };
  return { ok: false, text: `The store refused the package${errors.length ? ': ' + errors.join('; ') : ''}. Fix what it names (a version not above the published one is the usual cause: raise "version" in extension/manifest.json) and release again.` };
}

// The store's answer to a publish, in a sentence. status lists codes such
// as OK, ITEM_PENDING_REVIEW, NOT_AUTHORIZED or INVALID_DEVELOPER;
// statusDetail says the same in words.
export function describePublish(body) {
  const status = Array.isArray(body && body.status) ? body.status.map(String) : [];
  const detail = Array.isArray(body && body.statusDetail) ? body.statusDetail.map(String) : [];
  const ok = status.length > 0 && status.every(s => s === 'OK' || s === 'ITEM_PENDING_REVIEW' || s === 'PUBLISHED_WITH_FRICTION_WARNING');
  const words = detail.length ? detail.join(' ') : status.join(', ') || 'no status in the answer';
  return { ok, text: ok ? `Submitted: ${words}` : `The store did not take the publish: ${words}. Nothing to retry from here; read the dashboard and decide.` };
}

function newestZip() {
  if (!fs.existsSync(OUTPUT)) return null;
  const zips = fs.readdirSync(OUTPUT).filter(n => /^cswap-import-.*-chrome\.zip$/.test(n)).sort();
  return zips.length ? path.join(OUTPUT, zips[zips.length - 1]) : null;
}

export function parseArgs(argv) {
  const opts = { upload: false, publish: null, status: false, dryRun: false, ifConfigured: false, zip: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--upload') opts.upload = true;
    else if (a === '--publish') { opts.publish = argv[++i] || ''; }
    else if (a === '--status') opts.status = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--if-configured') opts.ifConfigured = true;
    else if (a === '--zip') { opts.zip = argv[++i] || ''; }
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (opts.publish !== null && !TARGETS[opts.publish]) throw new Error(`--publish takes ${Object.keys(TARGETS).join(' or ')}`);
  if (!opts.upload && opts.publish === null && !opts.status && !opts.help) throw new Error('say what to do: --upload, --publish TARGET or --status');
  return opts;
}

export const USAGE = [
  'usage: node extension/scripts/publish.mjs [--upload] [--zip PATH] [--publish trusted-testers|everyone] [--status] [--dry-run] [--if-configured]',
  '',
  '  --upload         send the zip (the newest in extension/.output, or --zip) to the store item as its draft',
  '  --publish T      submit the draft for review, to the trusted testers or to everyone',
  '  --status         print the item\'s draft state',
  '  --dry-run        print the requests that would be made, send nothing',
  '  --if-configured  with the four CWS_ variables absent, print so and exit 0 instead of failing',
  '',
  `  reads ${ITEM_NAME}, ${SECRET_NAMES.join(', ')} from the environment; prints none of them`,
].join('\n');

async function call(fetch, req, env) {
  const res = await fetch(req.url, req.init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = null; }
  return { status: res.status, body, text };
}

function errorLine(answer, env) {
  const msg = answer.body && answer.body.error && (answer.body.error.message || answer.body.error);
  return redact(`HTTP ${answer.status}${msg ? `: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}` : ''}`, env);
}

// Returns the exit code. Everything it needs is passed in so the tests
// run it with a fake fetch and an environment of their own.
export async function run({ argv = [], env = {}, fetch = globalThis.fetch, log = console.log, readFile = fs.readFileSync } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { log(e.message); log(USAGE); return 2; }
  if (opts.help) { log(USAGE); return 0; }
  const say = line => log(redact(line, env));

  const absent = missing(env);
  if (absent.length) {
    say(`Not configured: ${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} not set. Nothing was sent to the store.`);
    return opts.ifConfigured ? 0 : 1;
  }
  const itemId = env[ITEM_NAME].trim();
  if (!ITEM_ID_RE.test(itemId)) { say(`${ITEM_NAME} is not a store item id (32 letters a to p).`); return 1; }

  let zipPath = null;
  let bytes = null;
  if (opts.upload) {
    zipPath = opts.zip || newestZip();
    if (!zipPath) { say('No zip to upload: run node extension/scripts/package.mjs first, or pass --zip PATH.'); return 1; }
    try { bytes = readFile(zipPath); } catch (e) { say(`Cannot read ${zipPath}: ${e.message}`); return 1; }
    if (!bytes || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) { say(`${zipPath} is not a zip file.`); return 1; }
  }

  if (opts.dryRun) {
    say(`Dry run for item ${itemId}:`);
    say(`  POST ${TOKEN_URL} (grant_type=refresh_token)`);
    if (opts.upload) say(`  PUT ${uploadRequest(itemId, '<token>', bytes).url} (${bytes.length} bytes from ${zipPath})`);
    if (opts.publish) say(`  POST ${publishRequest(itemId, '<token>', opts.publish).url}`);
    if (opts.status) say(`  GET ${statusRequest(itemId, '<token>').url}`);
    say('Nothing was sent.');
    return 0;
  }

  const tokenAnswer = await call(fetch, tokenRequest(env), env);
  const token = tokenAnswer.body && typeof tokenAnswer.body.access_token === 'string' ? tokenAnswer.body.access_token : '';
  if (tokenAnswer.status !== 200 || !token) {
    say(`Could not get an access token (${errorLine(tokenAnswer, env)}). The refresh token may have been revoked or the OAuth client changed: make a new one as docs/store/SUBMISSION.md says and update the repository secrets.`);
    return 1;
  }

  if (opts.upload) {
    say(`Uploading ${path.basename(zipPath)} (${bytes.length} bytes) to item ${itemId}...`);
    const answer = await call(fetch, uploadRequest(itemId, token, bytes), env);
    if (answer.status !== 200 || !answer.body) { say(`The upload failed (${errorLine(answer, env)}).`); return 1; }
    const said = describeUpload(answer.body);
    say(said.text);
    if (!said.ok) return 1;
  }

  if (opts.publish) {
    say(`Submitting item ${itemId} to ${opts.publish === 'everyone' ? 'everyone' : 'the trusted testers'}...`);
    const answer = await call(fetch, publishRequest(itemId, token, opts.publish), env);
    if (answer.status !== 200 || !answer.body) { say(`The publish failed (${errorLine(answer, env)}).`); return 1; }
    const said = describePublish(answer.body);
    say(said.text);
    if (!said.ok) return 1;
  }

  if (opts.status) {
    const answer = await call(fetch, statusRequest(itemId, token), env);
    if (answer.status !== 200 || !answer.body) { say(`Could not read the item (${errorLine(answer, env)}).`); return 1; }
    const b = answer.body;
    say(`Item ${itemId}: uploadState ${b.uploadState || '?'}${b.crxVersion ? `, draft version ${b.crxVersion}` : ''}${Array.isArray(b.itemError) && b.itemError.length ? `, errors: ${b.itemError.map(e => e.error_detail || e.error_code).join('; ')}` : ''}`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run({ argv: process.argv.slice(2), env: process.env }).then(code => { process.exitCode = code; }, e => { console.error(redact(String(e && e.stack || e), process.env)); process.exitCode = 1; });
}
