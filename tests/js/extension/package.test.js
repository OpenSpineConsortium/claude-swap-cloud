// Tests of the store packager (extension/scripts/package.mjs): the zip it
// would upload holds what Chrome runs and nothing else, without the
// manifest's key, and the checks refuse what the store or CLAUDE.md would.
//
//   node --test tests/js/extension/package.test.js        (Node 24)
//
// Everything is built in memory from the real extension/ folder; nothing is
// written to disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const EXT = path.join(ROOT, 'extension');
const pkg = await import(pathToFileURL(path.join(EXT, 'scripts', 'package.mjs')).href);

const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

test('the extension as it is on disk packages with no problem', () => {
  const { problems } = pkg.collect();
  assert.deepEqual(problems, []);
});

test('the store manifest is the folder manifest without its key', () => {
  const { manifest, files } = pkg.collect();
  assert.ok(MANIFEST.key, 'the folder manifest pins the unpacked id');
  assert.equal('key' in manifest, false);
  const { key, ...rest } = MANIFEST;
  assert.deepEqual(manifest, rest);
  const inZip = JSON.parse(pkg.unzip(pkg.zip(files)).get('manifest.json').toString('utf8'));
  assert.deepEqual(inZip, rest);
});

test('the zip holds what Chrome runs, the privacy policy, and nothing else', () => {
  const { files } = pkg.collect();
  const names = files.map(([name]) => name);
  const sources = fs.readdirSync(path.join(EXT, 'src')).filter(n => n.endsWith('.js')).map(n => `src/${n}`);
  const expected = ['PRIVACY.md', 'icons/128.png', 'icons/16.png', 'icons/32.png', 'icons/48.png', 'manifest.json', 'sidepanel.html', ...sources].sort();
  assert.deepEqual(names, expected);
  for (const name of names) assert.ok(!/README|package\.json|store-assets|scripts\/|\.output/.test(name), name);
  const unzipped = pkg.unzip(pkg.zip(files));
  assert.deepEqual([...unzipped.keys()], names);
  for (const [name, bytes] of files) {
    if (name !== 'manifest.json') assert.ok(unzipped.get(name).equals(bytes), `${name} round-trips`);
  }
  assert.ok(unzipped.get('PRIVACY.md').equals(fs.readFileSync(path.join(ROOT, 'PRIVACY.md'))), 'the policy is the repository copy');
});

test('the zip is the same bytes for the same files', () => {
  const a = pkg.zip(pkg.collect().files);
  const b = pkg.zip(pkg.collect().files);
  assert.ok(a.equals(b));
  assert.equal(pkg.zipName(MANIFEST), `cswap-import-${MANIFEST.version}-chrome.zip`);
});

test('the store limits and the permission rules are checked', () => {
  assert.deepEqual(pkg.checkManifest(MANIFEST), []);
  const bad = (over, pattern) => {
    const problems = pkg.checkManifest({ ...MANIFEST, ...over });
    assert.ok(problems.some(p => pattern.test(p)), `${JSON.stringify(over)} -> ${problems.join('; ')}`);
  };
  bad({ manifest_version: 2 }, /manifest_version/);
  bad({ description: 'x'.repeat(133) }, /description/);
  bad({ name: 'x'.repeat(76) }, /name/);
  bad({ version: '1.02' }, /version/);
  bad({ version: '1.2.3.4.5' }, /version/);
  bad({ version: '70000' }, /version/);
  bad({ permissions: [...MANIFEST.permissions, 'cookies'] }, /permissions/);
  bad({ permissions: [...MANIFEST.permissions, 'tabs'] }, /permissions/);
  bad({ host_permissions: ['<all_urls>'] }, /host_permissions/);
  bad({ optional_host_permissions: ['https://*/*'] }, /optional_host_permissions/);
  bad({ icons: { 128: 'icons/128.png' } }, /icons\.16/);
  bad({ content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" } }, /CSP/);
});

test('a file the manifest names must be in the package', () => {
  const manifest = { ...MANIFEST, side_panel: { default_path: 'panel-missing.html' } };
  const { problems } = pkg.collect({ manifest });
  assert.ok(problems.some(p => /panel-missing\.html/.test(p)), problems.join('; '));
});

test('the package icons are square PNGs of their size', () => {
  const { files } = pkg.collect();
  for (const size of pkg.ICON_SIZES) {
    const png = files.find(([name]) => name === `icons/${size}.png`)[1];
    assert.equal(png.readUInt32BE(16), Number(size));
    assert.equal(png.readUInt32BE(20), Number(size));
  }
});
