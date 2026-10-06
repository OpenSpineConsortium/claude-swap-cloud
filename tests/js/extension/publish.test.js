// publish.mjs: the requests to the Chrome Web Store API, the words for
// its answers, and the rule that no credential ever reaches the log.
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
const ENV = {
  CWS_ITEM_ID: ITEM,
  CWS_CLIENT_ID: '1234567890-clientid.apps.googleusercontent.com',
  CWS_CLIENT_SECRET: 'GOCSPX-secret-secret-secret',
  CWS_REFRESH_TOKEN: '1//0refresh-token-refresh-token',
};
const TOKEN = 'ya29.access-token-access-token';
const ZIP = Buffer.from('PK\x03\x04 not really a zip but it starts like one');

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

const tokenOk = { match: u => u === pub.TOKEN_URL, body: { access_token: TOKEN, expires_in: 3599, token_type: 'Bearer' } };

function harness(answers, env = ENV) {
  const lines = [];
  const { fetch, calls } = fakeFetch(answers);
  const log = line => lines.push(String(line));
  const readFile = () => ZIP;
  return { run: argv => pub.run({ argv, env, fetch, log, readFile }), lines, calls };
}

function noSecretLeaks(lines) {
  const joined = lines.join('\n');
  for (const secret of [ENV.CWS_CLIENT_SECRET, ENV.CWS_REFRESH_TOKEN, TOKEN]) assert.ok(!joined.includes(secret), `log carries ${secret}`);
}

test('the requests are the ones the Chrome Web Store API documents', () => {
  const t = pub.tokenRequest(ENV);
  assert.equal(t.url, 'https://oauth2.googleapis.com/token');
  assert.equal(t.init.method, 'POST');
  const form = new URLSearchParams(t.init.body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('client_id'), ENV.CWS_CLIENT_ID);
  assert.equal(form.get('client_secret'), ENV.CWS_CLIENT_SECRET);
  assert.equal(form.get('refresh_token'), ENV.CWS_REFRESH_TOKEN);

  const u = pub.uploadRequest(ITEM, TOKEN, ZIP);
  assert.equal(u.url, `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${ITEM}`);
  assert.equal(u.init.method, 'PUT');
  assert.equal(u.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(u.init.headers['x-goog-api-version'], '2');
  assert.equal(u.init.headers['content-type'], 'application/zip');
  assert.equal(u.init.body, ZIP);

  const p = pub.publishRequest(ITEM, TOKEN, 'trusted-testers');
  assert.equal(p.url, `https://www.googleapis.com/chromewebstore/v1.1/items/${ITEM}/publish?publishTarget=trustedTesters`);
  assert.equal(p.init.method, 'POST');
  assert.equal(p.init.headers['content-length'], '0');
  assert.equal(pub.publishRequest(ITEM, TOKEN, 'everyone').url.split('publishTarget=')[1], 'default');
  assert.throws(() => pub.publishRequest(ITEM, TOKEN, 'public'), /trusted-testers or everyone/);

  const s = pub.statusRequest(ITEM, TOKEN);
  assert.equal(s.url, `https://www.googleapis.com/chromewebstore/v1.1/items/${ITEM}?projection=DRAFT`);
  assert.equal(s.init.method, 'GET');
});

test('the store\'s answers become sentences that say what to do', () => {
  assert.equal(pub.describeUpload({ uploadState: 'SUCCESS' }).ok, true);
  const inProgress = pub.describeUpload({ uploadState: 'IN_PROGRESS' });
  assert.equal(inProgress.ok, false);
  assert.match(inProgress.text, /--status/);
  const refused = pub.describeUpload({ uploadState: 'FAILURE', itemError: [{ error_code: 'PKG_INVALID_VERSION_NUMBER', error_detail: 'Invalid version number in manifest' }] });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /Invalid version number in manifest/);
  assert.match(refused.text, /extension\/manifest\.json/);
  assert.match(pub.describeUpload({ uploadState: 'NOT_FOUND' }).text, /CWS_ITEM_ID/);
  assert.match(pub.describeUpload({}).text, /refused/);

  assert.equal(pub.describePublish({ status: ['OK'], statusDetail: ['OK'] }).ok, true);
  assert.equal(pub.describePublish({ status: ['ITEM_PENDING_REVIEW'], statusDetail: ['The item is pending review.'] }).ok, true);
  const bad = pub.describePublish({ status: ['NOT_AUTHORIZED'], statusDetail: ['You are not authorized to publish this item.'] });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /not authorized/);
  assert.equal(pub.describePublish({}).ok, false);
});

test('missing variables: a plain line, exit 1, or exit 0 with --if-configured', async () => {
  const none = harness([], {});
  assert.equal(await none.run(['--upload']), 1);
  assert.match(none.lines[0], /CWS_ITEM_ID, CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN are not set/);
  assert.equal(none.calls.length, 0, 'nothing was sent');
  const soft = harness([], { CWS_ITEM_ID: ITEM });
  assert.equal(await soft.run(['--upload', '--if-configured']), 0);
  assert.match(soft.lines[0], /Nothing was sent/);
  const badId = harness([], { ...ENV, CWS_ITEM_ID: 'nope' });
  assert.equal(await badId.run(['--status']), 1);
  assert.match(badId.lines[0], /32 letters/);
});

test('upload then publish: token, PUT, POST, and the log keeps no secret', async () => {
  const h = harness([
    tokenOk,
    { match: (u, i) => i.method === 'PUT', body: { kind: 'chromewebstore#item', id: ITEM, uploadState: 'SUCCESS' } },
    { match: (u, i) => i.method === 'POST' && u.includes('/publish'), body: { kind: 'chromewebstore#item', item_id: ITEM, status: ['ITEM_PENDING_REVIEW'], statusDetail: ['The item is pending review.'] } },
  ]);
  assert.equal(await h.run(['--upload', '--zip', 'x.zip', '--publish', 'trusted-testers']), 0);
  assert.deepEqual(h.calls.map(c => c.init.method), ['POST', 'PUT', 'POST']);
  assert.equal(h.calls[1].init.body, ZIP);
  assert.match(h.lines.join('\n'), /accepted the package/);
  assert.match(h.lines.join('\n'), /Submitted: The item is pending review/);
  noSecretLeaks(h.lines);
});

test('a refused upload stops before any publish, with the store\'s reason', async () => {
  const h = harness([
    tokenOk,
    { match: (u, i) => i.method === 'PUT', body: { uploadState: 'FAILURE', itemError: [{ error_code: 'PKG_INVALID_VERSION_NUMBER', error_detail: 'Version must be greater than 0.2.0' }] } },
  ]);
  assert.equal(await h.run(['--upload', '--zip', 'x.zip', '--publish', 'everyone']), 1);
  assert.deepEqual(h.calls.map(c => c.init.method), ['POST', 'PUT'], 'no publish after a refused upload');
  assert.match(h.lines.join('\n'), /Version must be greater than 0\.2\.0/);
  noSecretLeaks(h.lines);
});

test('a token the store refuses is reported without echoing anything', async () => {
  const h = harness([{ match: u => u === pub.TOKEN_URL, status: 400, body: { error: 'invalid_grant', error_description: `Bad token ${ENV.CWS_REFRESH_TOKEN}` } }]);
  assert.equal(await h.run(['--status']), 1);
  assert.match(h.lines.join('\n'), /Could not get an access token \(HTTP 400: invalid_grant\)/);
  noSecretLeaks(h.lines);
  // An error body that echoes a secret is redacted even when the message is used.
  const echo = harness([tokenOk, { match: (u, i) => i.method === 'GET', status: 403, body: { error: { message: `forbidden for ${ENV.CWS_CLIENT_SECRET}` } } }]);
  assert.equal(await echo.run(['--status']), 1);
  assert.match(echo.lines.join('\n'), /forbidden for <CWS_CLIENT_SECRET>/);
  noSecretLeaks(echo.lines);
});

test('--dry-run names the requests and sends nothing; --status reads the draft', async () => {
  const dry = harness([]);
  assert.equal(await dry.run(['--upload', '--zip', 'x.zip', '--publish', 'everyone', '--dry-run']), 0);
  assert.equal(dry.calls.length, 0);
  assert.match(dry.lines.join('\n'), /PUT https:\/\/www\.googleapis\.com\/upload\/chromewebstore\/v1\.1\/items\//);
  assert.match(dry.lines.join('\n'), /publishTarget=default/);
  const st = harness([tokenOk, { match: (u, i) => i.method === 'GET', body: { uploadState: 'SUCCESS', crxVersion: '0.2.0' } }]);
  assert.equal(await st.run(['--status']), 0);
  assert.match(st.lines.join('\n'), /uploadState SUCCESS, draft version 0\.2\.0/);
});

test('arguments: no verb, an unknown flag and a bad target are refused with the usage', async () => {
  for (const argv of [[], ['--bogus'], ['--publish', 'public']]) {
    const h = harness([]);
    assert.equal(await h.run(argv), 2, argv.join(' '));
    assert.match(h.lines.join('\n'), /usage:/);
  }
  const help = harness([]);
  assert.equal(await help.run(['--help']), 0);
});

test('the release workflow runs this script with exactly its variables', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.ok(yml.includes('extension/scripts/publish.mjs'), 'the workflow calls publish.mjs');
  for (const name of [pub.ITEM_NAME, ...pub.SECRET_NAMES]) {
    assert.ok(yml.includes(`${name}: \${{ secrets.${name} }}`), `${name} comes from a repository secret`);
  }
  assert.ok(yml.includes('--if-configured'), 'a repository without the secrets stays green');
  assert.ok(!/secrets\.[A-Z_]+ *\}\}[^\n]*\n[^\n]*echo/.test(yml), 'no secret is echoed');
  assert.ok(yml.includes("extension-v*"), 'a tag starts a release');
});
