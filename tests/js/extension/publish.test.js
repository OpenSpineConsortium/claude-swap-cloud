// publish.mjs: the requests to the Chrome Web Store API (V2), the words
// for its answers, and the rule that no credential ever reaches the log.
// Everything runs against a fake fetch; no socket is opened.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const pub = await import(pathToFileURL(path.join(ROOT, 'extension', 'scripts', 'publish.mjs')).href);

const ITEM = 'abcdefghijklmnopabcdefghijklmnop';
const PUBLISHER = 'a1b2c3d4-publisher';
const NAME = `publishers/${PUBLISHER}/items/${ITEM}`;
const ENV = {
  CWS_PUBLISHER_ID: PUBLISHER,
  CWS_ITEM_ID: ITEM,
  CWS_CLIENT_ID: '1234567890-clientid.apps.googleusercontent.com',
  CWS_CLIENT_SECRET: 'GOCSPX-secret-secret-secret',
  CWS_REFRESH_TOKEN: '1//0refresh-token-refresh-token',
};
const TOKEN = 'ya29.access-token-access-token';
const ZIP = Buffer.from('PK\x03\x04 not really a zip but it starts like one');
// What sha256sum prints for ZIP, so the test does not trust the function under test.
const ZIP_SHA256 = '7cc8f9bb1bdfe888be8ef5abdec5d98ecd18f9f6e404a7372f4efa123a1659d6';

// A fetch that answers each URL from a script and records what was sent.
function fakeFetch(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const answer = answers.find(a => a.match(url, init));
    if (!answer) throw new Error(`unexpected request ${url}`);
    const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return { status: answer.status || 200, text: async () => body };
  };
  return { fetch, calls };
}

const tokenOk = { match: u => u === pub.TOKEN_URL, body: { access_token: TOKEN, expires_in: 3600, token_type: 'Bearer' } };
const isUpload = (u, i) => i.method === 'POST' && u.endsWith(':upload');
const isPublish = (u, i) => i.method === 'POST' && u.endsWith(':publish');
const isStatus = (u, i) => i.method === 'GET' && u.endsWith(':fetchStatus');

function harness(answers, env = ENV) {
  const lines = [];
  const sleeps = [];
  const { fetch, calls } = fakeFetch(answers);
  const log = line => lines.push(String(line));
  const readFile = () => ZIP;
  const sleep = async ms => { sleeps.push(ms); };
  return { run: argv => pub.run({ argv, env, fetch, log, readFile, sleep }), lines, calls, sleeps };
}

function noSecretLeaks(lines) {
  const joined = lines.join('\n');
  for (const secret of [ENV.CWS_CLIENT_SECRET, ENV.CWS_REFRESH_TOKEN, TOKEN]) assert.ok(!joined.includes(secret), `log carries ${secret}`);
}

test('the requests are the ones the Chrome Web Store API V2 documents', () => {
  const t = pub.tokenRequest(ENV);
  assert.equal(t.url, 'https://oauth2.googleapis.com/token');
  assert.equal(t.init.method, 'POST');
  const form = new URLSearchParams(t.init.body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('client_id'), ENV.CWS_CLIENT_ID);
  assert.equal(form.get('client_secret'), ENV.CWS_CLIENT_SECRET);
  assert.equal(form.get('refresh_token'), ENV.CWS_REFRESH_TOKEN);

  assert.equal(pub.itemName(ENV), NAME);
  const u = pub.uploadRequest(NAME, TOKEN, ZIP);
  assert.equal(u.url, `https://chromewebstore.googleapis.com/upload/v2/${NAME}:upload`);
  assert.equal(u.init.method, 'POST');
  assert.deepEqual(u.init.headers, { authorization: `Bearer ${TOKEN}` }, 'only the bearer header, as the documented curl sends');
  assert.equal(u.init.body, ZIP);

  const p = pub.publishRequest(NAME, TOKEN);
  assert.equal(p.url, `https://chromewebstore.googleapis.com/v2/${NAME}:publish`);
  assert.equal(p.init.method, 'POST');
  assert.equal(p.init.body, undefined, 'no body: publish on approval with the item\'s own visibility');
  const staged = pub.publishRequest(NAME, TOKEN, { staged: true });
  assert.deepEqual(JSON.parse(staged.init.body), { publishType: 'STAGED_PUBLISH' });
  assert.equal(staged.init.headers['content-type'], 'application/json');

  const s = pub.statusRequest(NAME, TOKEN);
  assert.equal(s.url, `https://chromewebstore.googleapis.com/v2/${NAME}:fetchStatus`);
  assert.equal(s.init.method, 'GET');
  for (const req of [u, p, staged, s]) assert.ok(!req.url.includes('v1.1'), 'never the V1 API, which ends on 15 October 2026');
});

test('the store\'s answers become sentences that say what to do', () => {
  const ok = pub.describeUpload({ uploadState: 'SUCCEEDED', crxVersion: '0.2.0' });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /version 0\.2\.0/);
  for (const state of ['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']) {
    const inProgress = pub.describeUpload({ uploadState: state });
    assert.equal(inProgress.ok, true, 'the store took the package');
    assert.equal(inProgress.pending, true);
    assert.match(inProgress.text, /--status/);
  }
  assert.equal(pub.describeUpload({ uploadState: 'NOT_FOUND' }).ok, false);
  assert.match(pub.describeUpload({ uploadState: 'FAILED' }).text, /extension\/manifest\.json/);
  assert.match(pub.describeUpload({}).text, /uploadState missing/);

  assert.equal(pub.describePublish({ state: 'PENDING_REVIEW' }).ok, true);
  assert.match(pub.describePublish({ state: 'PENDING_REVIEW' }).text, /submitted for review/);
  assert.match(pub.describePublish({ state: 'PUBLISHED_TO_TESTERS' }).text, /trusted testers/);
  assert.equal(pub.describePublish({ state: 'STAGED' }).ok, true);
  const warned = pub.describePublish({ state: 'PENDING_REVIEW', warningInfo: { warnings: [{ reason: 'X', description: 'Something to look at.' }] } });
  assert.match(warned.text, /Warnings: Something to look at\./);
  const bad = pub.describePublish({ state: 'REJECTED' });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /state REJECTED/);
  assert.equal(pub.describePublish({}).ok, false);

  const status = pub.describeStatus({
    publishedItemRevisionStatus: { state: 'PUBLISHED_TO_TESTERS', distributionChannels: [{ crxVersion: '0.1.0', deployPercentage: 100 }] },
    submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '0.2.0' }] },
    lastAsyncUploadState: 'SUCCEEDED', takenDown: false, warned: true,
  });
  assert.equal(status, 'published PUBLISHED_TO_TESTERS (version 0.1.0), submitted PENDING_REVIEW (version 0.2.0), last upload SUCCEEDED, warned');
  assert.equal(pub.describeStatus({}), 'published none, submitted none, last upload none');
});

test('missing variables: a plain line, exit 1, or exit 0 with --if-configured', async () => {
  const none = harness([], {});
  assert.equal(await none.run(['--upload']), 1);
  assert.match(none.lines[0], /CWS_PUBLISHER_ID, CWS_ITEM_ID, CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN are not set/);
  assert.equal(none.calls.length, 0, 'nothing was sent');
  const soft = harness([], { CWS_ITEM_ID: ITEM });
  assert.equal(await soft.run(['--upload', '--if-configured']), 0);
  assert.match(soft.lines[0], /Nothing was sent/);
  const badId = harness([], { ...ENV, CWS_ITEM_ID: 'nope' });
  assert.equal(await badId.run(['--status']), 1);
  assert.match(badId.lines[0], /32 letters/);
  const badPublisher = harness([], { ...ENV, CWS_PUBLISHER_ID: 'a/b' });
  assert.equal(await badPublisher.run(['--status']), 1);
  assert.match(badPublisher.lines[0], /publisher id/);
});

test('upload then publish: token, upload, publish, and the log keeps no secret', async () => {
  const h = harness([
    tokenOk,
    { match: isUpload, body: { name: NAME, itemId: ITEM, crxVersion: '0.2.0', uploadState: 'SUCCEEDED' } },
    { match: isPublish, body: { name: NAME, itemId: ITEM, state: 'PENDING_REVIEW' } },
  ]);
  assert.equal(await h.run(['--upload', '--zip', 'x.zip', '--publish']), 0);
  assert.deepEqual(h.calls.map(c => c.url.split('/').pop()), ['token', `${ITEM}:upload`, `${ITEM}:publish`]);
  assert.equal(h.calls[1].init.body, ZIP);
  assert.match(h.lines.join('\n'), /accepted the package as the item's new draft \(version 0\.2\.0\)/);
  assert.match(h.lines.join('\n'), /submitted for review/);
  // The log names the bytes it sent, the way the release's .sha256 does.
  assert.match(h.lines.join('\n'), new RegExp(`Uploading x\\.zip \\(${ZIP.length} bytes, SHA-256 ${ZIP_SHA256}\\)`));
  noSecretLeaks(h.lines);
});

test('a refused upload stops before any publish, with the store\'s reason', async () => {
  const h = harness([
    tokenOk,
    { match: isUpload, status: 400, body: { error: { code: 400, message: 'Version number in manifest must be greater than 0.2.0', status: 'INVALID_ARGUMENT' } } },
  ]);
  assert.equal(await h.run(['--upload', '--zip', 'x.zip', '--publish']), 1);
  assert.equal(h.calls.length, 2, 'no publish after a refused upload');
  assert.match(h.lines.join('\n'), /HTTP 400: Version number in manifest must be greater than 0\.2\.0/);
  assert.match(h.lines.join('\n'), /extension\/manifest\.json/);
  noSecretLeaks(h.lines);
});

test('a package the store is still processing: done as an upload, waited for within bounds before a publish', async () => {
  const taken = { match: isUpload, body: { name: NAME, uploadState: 'IN_PROGRESS' } };
  const only = harness([tokenOk, taken]);
  assert.equal(await only.run(['--upload', '--zip', 'x.zip']), 0, 'the upload itself succeeded');
  assert.equal(only.calls.length, 2, 'nothing is polled when no publish follows');
  assert.deepEqual(only.sleeps, []);
  assert.match(only.lines.join('\n'), /--status says when it is the draft/);
  // The draft arrives on the third look; the publish follows.
  let looks = 0;
  const status = { match: (u, i) => { if (!isStatus(u, i)) return false; looks += 1; status.body = { lastAsyncUploadState: looks < 3 ? 'IN_PROGRESS' : 'SUCCEEDED' }; return true; }, body: null };
  const h = harness([tokenOk, taken, status, { match: isPublish, body: { name: NAME, state: 'PENDING_REVIEW' } }]);
  assert.equal(await h.run(['--upload', '--zip', 'x.zip', '--publish']), 0);
  assert.deepEqual(h.calls.map(c => c.url.split('/').pop().replace(/^.*:/, '')), ['token', 'upload', 'fetchStatus', 'fetchStatus', 'fetchStatus', 'publish']);
  assert.deepEqual(h.sleeps, [pub.UPLOAD_WAITS.ms, pub.UPLOAD_WAITS.ms, pub.UPLOAD_WAITS.ms], 'each look waits the fixed time first');
  assert.match(h.lines.join('\n'), /Waiting 30 s for the store to finish \(1 of 10\)/);
  assert.match(h.lines.join('\n'), /submitted for review/);
  // Never settles: the waits run out, nothing is submitted, the way on is said.
  const stuck = harness([tokenOk, taken, { match: isStatus, body: { lastAsyncUploadState: 'IN_PROGRESS' } }]);
  assert.equal(await stuck.run(['--upload', '--zip', 'x.zip', '--publish']), 1);
  assert.equal(stuck.sleeps.length, pub.UPLOAD_WAITS.tries, 'a bounded wait, not a loop');
  assert.equal(stuck.calls.filter(c => c.url.endsWith(':publish')).length, 0);
  assert.match(stuck.lines.join('\n'), /still processing the package after 5 minutes.*Run workflow/);
  // The store reports the upload failed while waiting.
  const failed = harness([tokenOk, taken, { match: isStatus, body: { lastAsyncUploadState: 'FAILED' } }]);
  assert.equal(await failed.run(['--upload', '--zip', 'x.zip', '--publish']), 1);
  assert.equal(failed.sleeps.length, 1);
  assert.match(failed.lines.join('\n'), /last upload FAILED/);
});

test('the zip picked without --zip is the highest version, not the last name', () => {
  const names = ['cswap-import-0.9.0-chrome.zip', 'cswap-import-0.10.0-chrome.zip', 'cswap-import-0.10.0.236-chrome.zip', 'other.zip', 'cswap-import-0.10.0-chrome.zip.sha256'];
  assert.equal(pub.pickZip(names), 'cswap-import-0.10.0.236-chrome.zip');
  assert.equal(pub.pickZip(['cswap-import-0.2.0-chrome.zip', 'cswap-import-0.2.0.5-chrome.zip']), 'cswap-import-0.2.0.5-chrome.zip', 'a build number is above its base');
  assert.equal(pub.pickZip(['a.zip']), null);
});

test('a token the store refuses is reported without echoing anything', async () => {
  const h = harness([{ match: u => u === pub.TOKEN_URL, status: 400, body: { error: 'invalid_grant', error_description: `Bad token ${ENV.CWS_REFRESH_TOKEN}` } }]);
  assert.equal(await h.run(['--status']), 1);
  assert.match(h.lines.join('\n'), /Could not get an access token \(HTTP 400: invalid_grant\)/);
  noSecretLeaks(h.lines);
  // An error body that echoes a secret is redacted even when the message is used.
  const echo = harness([tokenOk, { match: isStatus, status: 403, body: { error: { message: `forbidden for ${ENV.CWS_CLIENT_SECRET}`, details: [{ fieldViolations: [{ description: `and ${ENV.CWS_REFRESH_TOKEN}` }] }] } } }]);
  assert.equal(await echo.run(['--status']), 1);
  assert.match(echo.lines.join('\n'), /forbidden for <CWS_CLIENT_SECRET> \(and <CWS_REFRESH_TOKEN>\)/);
  noSecretLeaks(echo.lines);
  // The access token is not a repository secret, so Actions would not mask
  // it; an answer that echoes the bearer is redacted here.
  const bearer = harness([tokenOk, { match: isStatus, status: 401, body: { error: { message: `Invalid Credentials: Bearer ${TOKEN}` } } }]);
  assert.equal(await bearer.run(['--status']), 1);
  assert.match(bearer.lines.join('\n'), /Invalid Credentials: Bearer <token>/);
  noSecretLeaks(bearer.lines);
  // A secret typed where an argument goes is not echoed by the usage error either.
  const stray = harness([]);
  assert.equal(await stray.run(['--upload', ENV.CWS_CLIENT_SECRET]), 2);
  assert.match(stray.lines[0], /unknown argument <CWS_CLIENT_SECRET>/);
  noSecretLeaks(stray.lines);
});

test('--dry-run names the requests and sends nothing; --status reads the item', async () => {
  const dry = harness([]);
  assert.equal(await dry.run(['--upload', '--zip', 'x.zip', '--publish', '--staged', '--dry-run']), 0);
  assert.equal(dry.calls.length, 0);
  assert.match(dry.lines.join('\n'), new RegExp(`POST https://chromewebstore\\.googleapis\\.com/upload/v2/${NAME}:upload`));
  assert.match(dry.lines.join('\n'), /:publish \(STAGED_PUBLISH\)/);
  assert.match(dry.lines.join('\n'), new RegExp(`SHA-256 ${ZIP_SHA256}\\)`));
  const st = harness([tokenOk, { match: isStatus, body: { publishedItemRevisionStatus: { state: 'PUBLISHED' }, lastAsyncUploadState: 'SUCCEEDED' } }]);
  assert.equal(await st.run(['--status']), 0);
  assert.match(st.lines.join('\n'), /published PUBLISHED, submitted none, last upload SUCCEEDED/);
});

test('arguments: no verb, an unknown flag and a lone --staged are refused with the usage', async () => {
  for (const argv of [[], ['--bogus'], ['--staged']]) {
    const h = harness([]);
    assert.equal(await h.run(argv), 2, argv.join(' '));
    assert.match(h.lines.join('\n'), /usage:/);
  }
  const help = harness([]);
  assert.equal(await help.run(['--help']), 0);
});

test('the release workflow runs this script with exactly its variables, from one step', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.ok(yml.includes('extension/scripts/publish.mjs'), 'the workflow calls publish.mjs');
  // The secrets sit on the one step that runs the script, after its name
  // and before its run block, not on the job, so no other action sees them.
  const step = yml.indexOf('- name: Upload to the Chrome Web Store');
  const runAt = yml.indexOf('run: |', step);
  assert.ok(step > 0 && runAt > step);
  for (const name of [...pub.ID_NAMES, ...pub.SECRET_NAMES]) {
    const at = yml.indexOf(`${name}: \${{ secrets.${name} }}`);
    assert.ok(at > step && at < runAt, `${name} comes from a repository secret, on the upload step`);
    assert.equal(yml.split(`secrets.${name}`).length, 2, `${name} is read once`);
  }
  assert.ok(yml.includes('--if-configured'), 'a repository without the secrets stays green');
  assert.ok(!/echo[^\n]*secrets\./.test(yml), 'no secret is echoed');
  assert.ok(yml.includes('extension-v*'), 'a tag starts a release');
  assert.ok(yml.includes('branches: [main]'), 'a push to main starts one');
  assert.ok(yml.includes("vars.CWS_ON_PUSH == 'upload'") && yml.includes("vars.CWS_ON_PUSH == 'publish'"), 'the repository variable decides what a push does');
  assert.ok(yml.includes('--zip "extension/.output/cswap-import-$VERSION-chrome.zip"'), 'the zip is named, not guessed');
  assert.ok(/concurrency:\n\s+group: chrome-web-store\n\s+cancel-in-progress: false/.test(yml), 'store calls never overlap');
  // The package job has no gate: every push to main, tag and manual run
  // builds and releases; only the store job reads the variable.
  const packageJob = yml.slice(yml.indexOf('\n  package:'), yml.indexOf('\n  store:'));
  const storeJob = yml.slice(yml.indexOf('\n  store:'));
  assert.ok(!/\n    if:/.test(packageJob), 'the package job always runs');
  assert.ok(/\n    if: .*vars\.CWS_ON_PUSH == 'upload'/.test(storeJob), 'the store job is the one the variable gates');
  assert.ok(packageJob.includes('--latest="$LATEST" \\\n') && packageJob.includes("LATEST: ${{ github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/') }}"), 'a build from main or a tag is the latest release, so the README link resolves; a branch build is not');
  assert.ok(!packageJob.includes('gh release edit'), 'a re-run leaves which release is latest alone');
  assert.ok(packageJob.includes('extension/.output/cswap-import-chrome.zip'), 'the zip is kept under a fixed name too');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('https://github.com/OpenSpineConsortium/claude-swap/releases/latest/download/cswap-import-chrome.zip'), 'the README links the newest build');
  assert.ok(yml.includes('gh release view') && yml.includes('--clobber'), 'a re-run does not fail on the release that exists');
  assert.ok(!yml.includes('trusted-testers'), 'V2 has no publish target; visibility is the item\'s own setting');
  // No expression inside a run block: a tag name or an input reaches the
  // shell through env and quotes, never as shell source.
  for (const block of yml.split(/\n\s+run: \|\n/).slice(1)) {
    const body = block.split(/\n\s{6}- /)[0].split(/\n\s{2}[a-z]+:\n/)[0];
    assert.ok(!body.includes('${{'), `an expression inside a run block: ${body.slice(0, 80)}`);
  }
  const pypi = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8');
  assert.ok(pypi.includes("!startsWith(github.event.release.tag_name, 'extension-v')"), 'an extension release never goes to PyPI');
});
