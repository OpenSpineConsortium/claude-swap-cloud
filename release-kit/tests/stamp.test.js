// stamp.mjs: any zip's manifest gets the release's version and loses its
// key, a zip that needs no change keeps its bytes, and the files a
// release carries get their names.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const lib = await import(pathToFileURL(path.join(HERE, '..', 'lib.mjs')).href);
const stamp = await import(pathToFileURL(path.join(HERE, '..', 'stamp.mjs')).href);

function built(manifest, extra = {}) {
  const files = new Map([['manifest.json', Buffer.from(JSON.stringify(manifest))], ['bg.js', Buffer.from('export const a = 1;')], ...Object.entries(extra).map(([k, v]) => [k, Buffer.from(v)])]);
  return lib.zip(lib.sortedEntries(files));
}

const MANIFEST = { manifest_version: 3, name: 'My Ext', version: '0.2.0', description: 'x', key: 'MIIB' };

test('a build from a branch: the version gets the build number, the key goes, the zip is written again', () => {
  const made = stamp.plan(built(MANIFEST), { build: '701' });
  assert.deepEqual(made.problems, []);
  assert.equal(made.rewritten, true);
  assert.equal(made.version, '0.2.0.701');
  assert.equal(made.tag, 'extension-v0.2.0.701');
  assert.equal(made.title, 'My Ext');
  assert.equal(made.name, 'my-ext');
  assert.equal(made.zipName, 'my-ext-0.2.0.701-chrome.zip');
  assert.equal(made.fixedName, 'my-ext-chrome.zip');
  assert.equal(made.sha256, lib.sha256(made.bytes));
  const back = lib.unzip(made.bytes);
  assert.deepEqual([...back.keys()], ['bg.js', 'manifest.json']);
  const manifest = JSON.parse(back.get('manifest.json').toString());
  assert.deepEqual(manifest, { manifest_version: 3, name: 'My Ext', version: '0.2.0.701', description: 'x' });
  assert.equal(back.get('manifest.json').toString(), lib.manifestBytes(manifest).toString(), 'the manifest is written the way package.mjs writes it');
  // The same input gives the same bytes, and what the kit's packager
  // would have written with --build.
  assert.ok(stamp.plan(built(MANIFEST), { build: '701' }).bytes.equals(made.bytes));
  const { key, ...rest } = MANIFEST;
  const direct = lib.zip(lib.sortedEntries(new Map([['manifest.json', lib.manifestBytes({ ...rest, version: '0.2.0.701' })], ['bg.js', Buffer.from('export const a = 1;')]])));
  assert.ok(direct.equals(made.bytes));
});

test('a zip whose manifest needs no change is released byte for byte', () => {
  const { key, ...plain } = MANIFEST;
  const bytes = built(plain);
  const made = stamp.plan(bytes, {});
  assert.deepEqual(made.problems, []);
  assert.equal(made.rewritten, false);
  assert.ok(made.bytes.equals(bytes));
  assert.equal(made.version, '0.2.0');
  const stampedAlready = stamp.plan(built({ ...plain, version: '0.2.0.701' }), { build: '701' });
  assert.equal(stampedAlready.rewritten, false, 'the build stamped it already');
  assert.equal(stampedAlready.version, '0.2.0.701');
  const tagged = stamp.plan(bytes, { tag: 'extension-v0.2.0' });
  assert.equal(tagged.rewritten, false);
  assert.equal(tagged.tag, 'extension-v0.2.0');
  const prefixed = stamp.plan(bytes, { tag: 'v0.2.0', tagPrefix: 'v', name: 'ext' });
  assert.deepEqual(prefixed.problems, []);
  assert.equal(prefixed.zipName, 'ext-0.2.0-chrome.zip');
});

test('what stops a release: a wrong tag, a version with no room, no manifest, not a zip', () => {
  const bytes = built(MANIFEST);
  assert.match(stamp.plan(bytes, { tag: 'extension-v0.3.0' }).problems[0], /does not match the manifest's version 0\.2\.0: tag extension-v0\.2\.0 instead, or raise the manifest's version to 0\.3\.0/);
  assert.match(stamp.plan(bytes, { tag: 'v0.2.0' }).problems[0], /does not start with extension-v: tag the release extension-v0\.2\.0/);
  assert.match(stamp.plan(built({ ...MANIFEST, version: '1.2.3.4' }), { build: '5' }).problems[0], /already has four integers/);
  assert.match(stamp.plan(bytes, { build: 'x' }).problems[0], /build "x"/);
  assert.match(stamp.plan(built({ ...MANIFEST, version: 'abc' }), {}).problems[0], /no usable version/);
  assert.match(stamp.plan(lib.zip([['bg.js', Buffer.from('x')]]), {}).problems[0], /no manifest\.json/);
  assert.match(stamp.plan(lib.zip([['manifest.json', Buffer.from('{nope')]]), {}).problems[0], /not JSON/);
  assert.match(stamp.plan(Buffer.from('not a zip'), {}).problems[0], /not a zip/);
});

test('the command writes the four files and prints only name=value lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-kit-stamp-'));
  const lines = [];
  const said = [];
  const io = { log: l => lines.push(String(l)), say: l => said.push(String(l)) };
  try {
    const zip = path.join(dir, 'built.zip');
    fs.writeFileSync(zip, built(MANIFEST));
    const out = path.join(dir, 'out');
    assert.equal(stamp.main(['--zip', zip, '--out', out, '--name', 'my-ext', '--build', '7'], io), 0);
    assert.deepEqual(fs.readdirSync(out).sort(), ['my-ext-0.2.0.7-chrome.zip', 'my-ext-0.2.0.7-chrome.zip.sha256', 'my-ext-chrome.zip', 'my-ext-chrome.zip.sha256']);
    const versioned = fs.readFileSync(path.join(out, 'my-ext-0.2.0.7-chrome.zip'));
    assert.ok(fs.readFileSync(path.join(out, 'my-ext-chrome.zip')).equals(versioned), 'the same bytes under both names');
    const sha = lib.sha256(versioned);
    assert.equal(fs.readFileSync(path.join(out, 'my-ext-0.2.0.7-chrome.zip.sha256'), 'utf8'), `${sha}  my-ext-0.2.0.7-chrome.zip\n`);
    assert.equal(fs.readFileSync(path.join(out, 'my-ext-chrome.zip.sha256'), 'utf8'), `${sha}  my-ext-chrome.zip\n`);
    assert.ok(lines.every(l => /^[a-z0-9]+=.+$/.test(l)), `only name=value lines reach stdout: ${lines.join(' | ')}`);
    const got = Object.fromEntries(lines.map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    assert.deepEqual(Object.keys(got), ['name', 'version', 'tag', 'title', 'dir', 'zip', 'zipname', 'fixed', 'fixedname', 'sha256']);
    assert.equal(got.version, '0.2.0.7');
    assert.equal(got.zip, path.join(out, 'my-ext-0.2.0.7-chrome.zip'));
    assert.equal(got.fixedname, 'my-ext-chrome.zip');
    assert.equal(got.sha256, sha);
    assert.match(said.join('\n'), /My Ext 0\.2\.0\.7: my-ext-0\.2\.0\.7-chrome\.zip \(\d+ bytes, manifest written again\), also as my-ext-chrome\.zip/);
    // Refusals: exit 1 with the problem said, nothing on stdout.
    lines.length = 0;
    assert.equal(stamp.main(['--zip', zip, '--out', out, '--tag', 'extension-v9.9.9'], io), 1);
    assert.deepEqual(lines, []);
    assert.match(said.join('\n'), /problem: the tag extension-v9\.9\.9/);
    assert.equal(stamp.main(['--zip', path.join(dir, 'missing.zip'), '--out', out], io), 1);
    assert.match(said.join('\n'), /Cannot read/);
    for (const argv of [[], ['--zip', zip], ['--zip', zip, '--out', out, '--build', '1', '--tag', 'extension-v0.2.0'], ['--zip', zip, '--out', out, '--bogus'], ['--zip']]) {
      assert.equal(stamp.main(argv, io), 2, argv.join(' '));
    }
    assert.match(said.join('\n'), /usage:/);
    assert.equal(stamp.main(['--help'], io), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a localized name: the title and the file name come from the default locale\'s messages', () => {
  const localized = { ...MANIFEST, name: '__MSG_extName__', default_locale: 'en' };
  const messages = JSON.stringify({ extName: { message: 'My Localized Ext' } });
  const made = stamp.plan(built(localized, { '_locales/en/messages.json': messages }), { build: '3' });
  assert.deepEqual(made.problems, []);
  assert.equal(made.title, 'My Localized Ext');
  assert.equal(made.name, 'my-localized-ext');
  assert.equal(JSON.parse(lib.unzip(made.bytes).get('manifest.json').toString()).name, '__MSG_extName__', 'the manifest keeps its message');
  assert.match(stamp.plan(built(localized), { build: '3' }).problems[0], /_locales\/en\/messages\.json/);
  const named = stamp.plan(built(localized), { build: '3', name: 'my-ext' });
  assert.deepEqual(named.problems, []);
  assert.equal(named.title, 'my-ext');
  assert.equal(named.name, 'my-ext');
});
