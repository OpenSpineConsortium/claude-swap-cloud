// Uploads a store zip to a Chrome Web Store item and, when asked, submits
// it for review, through the Chrome Web Store API (V2; V1 ends on 15
// October 2026).
//
//   node release-kit/store/publish.mjs --upload --zip PATH
//   node release-kit/store/publish.mjs --publish
//   node release-kit/store/publish.mjs --status
//   node release-kit/store/publish.mjs --upload --zip PATH --if-configured
//
// The item and the credentials come from the environment, never from a
// file in the repository (release-kit/README.md, "The secrets"):
// CWS_PUBLISHER_ID and CWS_ITEM_ID (the dashboard's publisher id and the
// item's id), CWS_CLIENT_ID, CWS_CLIENT_SECRET and CWS_REFRESH_TOKEN (the
// OAuth client and the refresh token the maintainer made once). With
// --if-configured a run without them does nothing and exits 0, which is
// how a repository without the secrets stays green.
//
// Nothing here retries: an upload the store refuses ends the run with the
// store's own words and what to do next, and the person decides. The one
// wait is bounded and says each step: an upload the store is still
// processing is given UPLOAD_WAITS to settle before a publish that was
// asked for, and the run ends with the way on if it does not. No
// credential is ever printed: every line that reaches the log passes
// through redact() first, with the access token among the values it hides.
// Node's standard library only.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECRET_NAMES = Object.freeze(['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN']);
export const ID_NAMES = Object.freeze(['CWS_PUBLISHER_ID', 'CWS_ITEM_ID']);
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const API_BASE = 'https://chromewebstore.googleapis.com';

const ITEM_ID_RE = /^[a-p]{32}$/;
const PUBLISHER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// The zip's SHA-256, printed with every upload so the store step's log
// names the same bytes as the GitHub release's .sha256 file.
export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Which of the five variables the environment lacks.
export function missing(env) {
  return [...ID_NAMES, ...SECRET_NAMES].filter(name => !(typeof env[name] === 'string' && env[name].trim()));
}

// Every secret's value replaced before a line is logged, plus any other
// values handed in (the access token, once there is one). The values are
// long and random, so a plain replace is enough; a short value is skipped
// so it cannot match everywhere. A value pasted with a newline at its end
// is sent trimmed, so both forms are replaced.
export function redact(text, env, extra = []) {
  let out = String(text);
  const hide = (value, mark) => {
    for (const form of new Set([value, String(value).trim()])) {
      if (typeof form === 'string' && form.length >= 8) out = out.split(form).join(mark);
    }
  };
  for (const name of SECRET_NAMES) {
    if (typeof env[name] === 'string') hide(env[name], `<${name}>`);
  }
  for (const value of extra) {
    if (typeof value === 'string') hide(value, '<token>');
  }
  return out;
}

// What a run has learned that must never be printed: the access token,
// once there is one. Module-wide so the last-resort catch below hides it
// too.
const hidden = [];

// The item's resource name, the path every V2 call takes.
export function itemName(env) {
  return `publishers/${env.CWS_PUBLISHER_ID.trim()}/items/${env.CWS_ITEM_ID.trim()}`;
}

export function tokenRequest(env) {
  const body = new URLSearchParams({
    client_id: String(env.CWS_CLIENT_ID).trim(),
    client_secret: String(env.CWS_CLIENT_SECRET).trim(),
    refresh_token: String(env.CWS_REFRESH_TOKEN).trim(),
    grant_type: 'refresh_token',
  }).toString();
  return { url: TOKEN_URL, init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body } };
}

// The zip travels as the body with only the bearer header, as Google's
// own curl example sends it; the upload accepts any content type.
export function uploadRequest(name, token, bytes) {
  return {
    url: `${API_BASE}/upload/v2/${name}:upload`,
    init: { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: bytes },
  };
}

// An empty body publishes on approval with the visibility the item has in
// the dashboard (V2 has no publish target: Private, Unlisted or Public is
// the item's own setting). --staged holds the approved package instead.
export function publishRequest(name, token, { staged = false } = {}) {
  const init = { method: 'POST', headers: { authorization: `Bearer ${token}` } };
  if (staged) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify({ publishType: 'STAGED_PUBLISH' });
  } else {
    init.headers['content-length'] = '0';
  }
  return { url: `${API_BASE}/v2/${name}:publish`, init };
}

export function statusRequest(name, token) {
  return { url: `${API_BASE}/v2/${name}:fetchStatus`, init: { method: 'GET', headers: { authorization: `Bearer ${token}` } } };
}

// What a refused upload usually means, and the two ways past it.
const VERSION_ADVICE = 'The usual cause is a version not above the published one: raise the version in the manifest, or push to the default branch again for a new build number, and release again.';

// The store's answer to an upload, in a sentence. uploadState is SUCCEEDED,
// IN_PROGRESS (the upload page's prose also says UPLOAD_IN_PROGRESS) or
// FAILED; a refusal with a reason, or a wrong publisher or item id, comes
// as an HTTP error. A package still being processed is taken (pending),
// and fetchStatus says when it has become the draft.
export function describeUpload(body) {
  const state = body && typeof body.uploadState === 'string' ? body.uploadState : '';
  const version = body && body.crxVersion ? ` (version ${body.crxVersion})` : '';
  if (state === 'SUCCEEDED') return { ok: true, text: `The store accepted the package as the item's new draft${version}.` };
  if (state === 'IN_PROGRESS' || state === 'UPLOAD_IN_PROGRESS') return { ok: true, pending: true, text: 'The store took the package and is still processing it; --status says when it is the draft.' };
  return { ok: false, text: `The store did not accept the package (uploadState ${state || 'missing'}). ${VERSION_ADVICE}` };
}

// How long a package the store is still processing is given to become the
// draft before a publish that was asked for: ten looks, half a minute
// apart, each one said. Then the run ends and names the way on.
export const UPLOAD_WAITS = Object.freeze({ tries: 10, ms: 30000 });

// The store's answer to a publish, in a sentence. state is PENDING_REVIEW,
// STAGED, PUBLISHED, PUBLISHED_TO_TESTERS, REJECTED or CANCELLED;
// warningInfo lists what review may still object to.
export function describePublish(body) {
  const state = body && typeof body.state === 'string' ? body.state : '';
  const warnings = body && body.warningInfo && Array.isArray(body.warningInfo.warnings)
    ? body.warningInfo.warnings.map(w => w.description || w.reason).filter(Boolean) : [];
  const warned = warnings.length ? ` Warnings: ${warnings.join('; ')}` : '';
  const good = { PENDING_REVIEW: 'submitted for review', STAGED: 'approved and held, waiting for the publish', PUBLISHED: 'published', PUBLISHED_TO_TESTERS: 'published to the trusted testers' };
  if (good[state]) return { ok: true, text: `The item is ${good[state]}.${warned}` };
  return { ok: false, text: `The store did not take the submission (state ${state || 'missing'}).${warned} Nothing to retry from here; read the dashboard and decide.` };
}

// The fetchStatus answer, in a line: what is published, what is under
// review, and the last upload's state.
export function describeStatus(body) {
  const rev = r => r && r.state ? `${r.state}${Array.isArray(r.distributionChannels) && r.distributionChannels.length && r.distributionChannels[0].crxVersion ? ` (version ${r.distributionChannels[0].crxVersion})` : ''}` : 'none';
  const parts = [
    `published ${rev(body && body.publishedItemRevisionStatus)}`,
    `submitted ${rev(body && body.submittedItemRevisionStatus)}`,
    `last upload ${body && body.lastAsyncUploadState ? body.lastAsyncUploadState : 'none'}`,
  ];
  if (body && body.takenDown) parts.push('TAKEN DOWN');
  if (body && body.warned) parts.push('warned');
  return parts.join(', ');
}

export function parseArgs(argv) {
  const opts = { upload: false, publish: false, staged: false, status: false, dryRun: false, ifConfigured: false, zip: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--upload') opts.upload = true;
    else if (a === '--publish') opts.publish = true;
    else if (a === '--staged') opts.staged = true;
    else if (a === '--status') opts.status = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--if-configured') opts.ifConfigured = true;
    else if (a === '--zip') { opts.zip = argv[++i] || ''; }
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (opts.staged && !opts.publish) throw new Error('--staged goes with --publish');
  if (opts.upload && !opts.zip) throw new Error('--upload needs --zip PATH');
  if (!opts.upload && !opts.publish && !opts.status && !opts.help) throw new Error('say what to do: --upload, --publish or --status');
  return opts;
}

export const USAGE = [
  'usage: node release-kit/store/publish.mjs [--upload --zip PATH] [--publish [--staged]] [--status] [--dry-run] [--if-configured]',
  '',
  '  --upload --zip PATH  send that zip to the store item as its draft',
  '  --publish            submit the draft for review; it goes out on approval with the visibility the item has',
  '  --staged             with --publish: hold the approved package until it is published by hand',
  '  --status             print what is published, what is under review and the last upload\'s state',
  '  --dry-run            print the requests that would be made, send nothing',
  '  --if-configured      with the five CWS_ variables absent, print so and exit 0 instead of failing',
  '',
  `  reads ${ID_NAMES.join(', ')}, ${SECRET_NAMES.join(', ')} from the environment; prints none of the secrets`,
].join('\n');

async function call(fetch, req) {
  const res = await fetch(req.url, req.init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = null; }
  return { status: res.status, body, text };
}

// An HTTP error in a line: the status and the API's own message, which is
// where V2 puts a refusal's reason (a version not above the published one,
// a package the store cannot read, a review in progress).
function errorLine(answer) {
  const err = answer.body && answer.body.error;
  const msg = err && (typeof err === 'string' ? err : err.message);
  const details = err && Array.isArray(err.details)
    ? err.details.flatMap(d => Array.isArray(d.fieldViolations) ? d.fieldViolations.map(v => v.description) : d.detail ? [d.detail] : []).filter(Boolean) : [];
  return `HTTP ${answer.status}${msg ? `: ${msg}` : ''}${details.length ? ` (${details.join('; ')})` : ''}`;
}

// Waits, within UPLOAD_WAITS, for a package the store took to become the
// draft. True when fetchStatus reports it; false, with the reason said,
// when the store reports a failure or the waits run out.
async function waitForUpload({ fetch, name, token, say, sleep }) {
  for (let i = 1; i <= UPLOAD_WAITS.tries; i++) {
    say(`Waiting ${Math.round(UPLOAD_WAITS.ms / 1000)} s for the store to finish (${i} of ${UPLOAD_WAITS.tries})...`);
    await sleep(UPLOAD_WAITS.ms);
    const answer = await call(fetch, statusRequest(name, token));
    if (answer.status !== 200 || !answer.body) { say(`Could not read the item (${errorLine(answer)}).`); return false; }
    const state = String(answer.body.lastAsyncUploadState || '');
    if (state === 'SUCCEEDED') { say('The package is the item\'s draft now.'); return true; }
    if (state !== 'IN_PROGRESS' && state !== 'UPLOAD_IN_PROGRESS') { say(`The store did not take the package (last upload ${state || 'unknown'}). Read the dashboard and decide.`); return false; }
  }
  say(`The store is still processing the package after ${Math.round(UPLOAD_WAITS.tries * UPLOAD_WAITS.ms / 60000)} minutes. Nothing was submitted: run --publish (in Actions, "Run workflow" with publish ticked) once --status reports the draft.`);
  return false;
}

// Returns the exit code. Everything it needs is passed in so the tests
// run it with a fake fetch, an environment and a clock of their own.
export async function run({ argv = [], env = {}, fetch = globalThis.fetch, log = console.log, readFile = fs.readFileSync, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  hidden.length = 0;
  const say = line => log(redact(line, env, hidden));
  let opts;
  try { opts = parseArgs(argv); } catch (e) { say(e.message); say(USAGE); return 2; }
  if (opts.help) { say(USAGE); return 0; }

  const absent = missing(env);
  if (absent.length) {
    say(`Not configured: ${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} not set. Nothing was sent to the store.`);
    return opts.ifConfigured ? 0 : 1;
  }
  if (!ITEM_ID_RE.test(env.CWS_ITEM_ID.trim())) { say('CWS_ITEM_ID is not a store item id (32 letters a to p).'); return 1; }
  if (!PUBLISHER_ID_RE.test(env.CWS_PUBLISHER_ID.trim())) { say('CWS_PUBLISHER_ID does not look like the dashboard\'s publisher id (letters, digits, - and _).'); return 1; }
  const name = itemName(env);

  let bytes = null;
  if (opts.upload) {
    try { bytes = readFile(opts.zip); } catch (e) { say(`Cannot read ${opts.zip}: ${e.message}`); return 1; }
    if (!bytes || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) { say(`${opts.zip} is not a zip file.`); return 1; }
  }

  if (opts.dryRun) {
    say(`Dry run for ${name}:`);
    say(`  POST ${TOKEN_URL} (grant_type=refresh_token)`);
    if (opts.upload) say(`  POST ${uploadRequest(name, '<token>', bytes).url} (${bytes.length} bytes from ${opts.zip}, SHA-256 ${sha256(bytes)})`);
    if (opts.publish) say(`  POST ${publishRequest(name, '<token>', { staged: opts.staged }).url}${opts.staged ? ' (STAGED_PUBLISH)' : ''}`);
    if (opts.status) say(`  GET ${statusRequest(name, '<token>').url}`);
    say('Nothing was sent.');
    return 0;
  }

  const tokenAnswer = await call(fetch, tokenRequest(env));
  const token = tokenAnswer.body && typeof tokenAnswer.body.access_token === 'string' ? tokenAnswer.body.access_token : '';
  if (token) hidden.push(token);
  if (tokenAnswer.status !== 200 || !token) {
    say(`Could not get an access token (${errorLine(tokenAnswer)}). The refresh token may have expired or been revoked, or the OAuth client changed: make a new one as release-kit/README.md says and update the repository secrets.`);
    return 1;
  }

  if (opts.upload) {
    say(`Uploading ${path.basename(opts.zip)} (${bytes.length} bytes, SHA-256 ${sha256(bytes)}) to ${name}...`);
    const answer = await call(fetch, uploadRequest(name, token, bytes));
    if (answer.status !== 200 || !answer.body) { say(`The store refused the upload (${errorLine(answer)}). ${VERSION_ADVICE}`); return 1; }
    const said = describeUpload(answer.body);
    say(said.text);
    if (!said.ok) return 1;
    // A publish right now would submit whatever draft the item holds, so
    // a package still being processed is waited for first, within bounds.
    if (said.pending && opts.publish && !(await waitForUpload({ fetch, name, token, say, sleep }))) return 1;
  }

  if (opts.publish) {
    say(`Submitting ${name} for review${opts.staged ? ', to be held on approval' : ''}...`);
    const answer = await call(fetch, publishRequest(name, token, { staged: opts.staged }));
    if (answer.status !== 200 || !answer.body) { say(`The store refused the submission (${errorLine(answer)}). Nothing to retry from here; read the dashboard and decide.`); return 1; }
    const said = describePublish(answer.body);
    say(said.text);
    if (!said.ok) return 1;
  }

  if (opts.status) {
    const answer = await call(fetch, statusRequest(name, token));
    if (answer.status !== 200 || !answer.body) { say(`Could not read the item (${errorLine(answer)}).`); return 1; }
    say(`${name}: ${describeStatus(answer.body)}`);
  }
  return 0;
}

// The tests import this module, so run() starts only when node was given
// this file; argv[1] is compared by its real path, since Node resolves the
// main module's symlinks for import.meta.url but keeps argv[1] as typed.
function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch (e) { return false; }
}

if (isMain()) {
  run({ argv: process.argv.slice(2), env: process.env }).then(code => { process.exitCode = code; }, e => { console.error(redact(String(e && e.stack || e), process.env, hidden)); process.exitCode = 1; });
}
