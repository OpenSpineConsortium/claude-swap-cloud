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
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

// ---------------------------------------------------------------- minify

const SCRIPT = /^src\/[a-z]+\.js$/;

test('--build stamps the zip\'s manifest with one more integer and leaves the folder alone', () => {
  assert.deepEqual(pkg.stampVersion('0.2.0', 236), { version: '0.2.0.236' });
  assert.deepEqual(pkg.stampVersion('0.2.0', '236'), { version: '0.2.0.236' });
  for (const bad of ['0', '-1', '65536', '12a', ' 7', '', 'x']) assert.match(pkg.stampVersion('0.2.0', bad).problem, /not an integer from 1 to 65535/, bad);
  assert.match(pkg.stampVersion('1.2.3.4', 5).problem, /already has four integers/);
  const { manifest, files, problems } = pkg.collect({ build: '236' });
  assert.deepEqual(problems, []);
  assert.equal(manifest.version, `${MANIFEST.version}.236`);
  assert.equal(pkg.zipName(manifest), `cswap-import-${MANIFEST.version}.236-chrome.zip`);
  assert.equal(JSON.parse(pkg.unzip(pkg.zip(files)).get('manifest.json').toString('utf8')).version, `${MANIFEST.version}.236`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version, MANIFEST.version, 'the folder manifest is not written');
  assert.deepEqual(pkg.collect().manifest.version, MANIFEST.version, 'without --build the version is the manifest\'s');
  assert.match(pkg.collect({ build: 'x' }).problems.join('\n'), /build "x" is not an integer/);
  assert.equal(MANIFEST.version.split('.').length <= 3, true, 'the manifest leaves room for the build number');
});

test('minify replaces the scripts and nothing else, through the injected esbuild', () => {
  const { files } = pkg.collect();
  const seen = [];
  const run = (inputs, outDir) => {
    seen.push(inputs.map(f => path.basename(f)).sort());
    for (const f of inputs) fs.writeFileSync(path.join(outDir, path.basename(f)), `/*m*/${fs.readFileSync(f, 'utf8').length}`);
  };
  const { files: out, problems } = pkg.minify(files, { run });
  assert.deepEqual(problems, []);
  assert.deepEqual(seen, [files.filter(([n]) => SCRIPT.test(n)).map(([n]) => path.posix.basename(n)).sort()], 'one run, every script');
  assert.deepEqual(out.map(([n]) => n), files.map(([n]) => n), 'same names, same order');
  for (const [name, bytes] of out) {
    const original = files.find(([n]) => n === name)[1];
    if (SCRIPT.test(name)) assert.equal(bytes.toString('utf8'), `/*m*/${original.length}`, name);
    else assert.ok(bytes.equals(original), `${name} untouched`);
  }
});

test('minify keeps the sources and says so when esbuild fails or misbehaves', () => {
  const { files } = pkg.collect();
  const scripts = files.filter(([n]) => SCRIPT.test(n)).length;
  const none = pkg.minify(files, { run: () => {} });
  assert.equal(none.problems.length, scripts);
  assert.ok(none.problems.every(p => /wrote no/.test(p)));
  const broken = pkg.minify(files, { run: () => { throw new Error('spawn npx ENOENT\nmore'); } });
  assert.deepEqual(broken.problems, [`esbuild did not run (spawn npx ENOENT); install esbuild ${pkg.ESBUILD_VERSION} and set CSWAP_ESBUILD, let npx fetch it, or pass --plain`]);
  assert.deepEqual(broken.files, files);
  const nonAscii = pkg.minify(files, { run: (inputs, outDir) => { for (const f of inputs) fs.writeFileSync(path.join(outDir, path.basename(f)), 'x\u00e9\r\n'); } });
  assert.equal(nonAscii.problems.length, scripts);
  assert.ok(nonAscii.problems.every(p => /plain ASCII with LF/.test(p)));
});

test('the esbuild command is the installed one when named, else npx with the pinned version', () => {
  assert.deepEqual(pkg.esbuildCommand({ CSWAP_ESBUILD: '/opt/esbuild' }), { command: '/opt/esbuild', args: [] });
  const npx = pkg.esbuildCommand({});
  assert.match(npx.command, /^npx(\.cmd)?$/);
  assert.deepEqual(npx.args, ['-y', `esbuild@${pkg.ESBUILD_VERSION}`]);
  assert.match(pkg.ESBUILD_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(pkg.MINIFY_ARGS.includes('--minify'));
  assert.ok(pkg.MINIFY_ARGS.includes('--charset=ascii'));
  assert.ok(!pkg.MINIFY_ARGS.some(a => /sourcemap|bundle/.test(a)), 'no source map, no bundling');
});

test('both workflows install the esbuild the packager pins, and the release kit pins the same', async () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(ci.includes(`esbuild@${pkg.ESBUILD_VERSION}`), `ci.yml pins esbuild ${pkg.ESBUILD_VERSION}`);
  assert.ok(ci.includes('CSWAP_ESBUILD: esbuild'), 'ci.yml names it for the packager');
  // release.yml hands its commands to the kit's workflow, so the name
  // travels inside them rather than as a job's env.
  const release = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.ok(release.includes(`setup: npm install -g esbuild@${pkg.ESBUILD_VERSION}`), `release.yml installs esbuild ${pkg.ESBUILD_VERSION}`);
  assert.equal(release.split('CSWAP_ESBUILD=esbuild node').length, 3, 'release.yml names it to the test and the build');
  const kit = await import(pathToFileURL(path.join(ROOT, 'release-kit', 'package.mjs')).href);
  assert.equal(kit.ESBUILD_VERSION, pkg.ESBUILD_VERSION, 'one esbuild for the kit and this packager, so both give the same bytes');
});

// With a real esbuild (CI sets CSWAP_ESBUILD to the pinned one) the
// minified scripts must still parse and the modules must export the same
// names. Skipped elsewhere: the suite opens no process it did not make.
test('with a real esbuild the minified scripts parse and export the same names', { skip: !process.env.CSWAP_ESBUILD && 'CSWAP_ESBUILD is not set' }, async () => {
  const { files } = pkg.collect();
  const { files: out, problems } = pkg.minify(files);
  assert.deepEqual(problems, []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cswap-minified-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
    for (const [name, bytes] of out) if (SCRIPT.test(name)) fs.writeFileSync(path.join(dir, path.posix.basename(name)), bytes);
    for (const [name, bytes] of out) {
      if (!SCRIPT.test(name)) continue;
      const file = path.join(dir, path.posix.basename(name));
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      const original = files.find(([n]) => n === name)[1];
      assert.ok(bytes.length < original.length, `${name} is smaller`);
      // The pure modules: same export names from the minified copy.
      if (/^(protocol|config|log|native|gate|interrupt|setup)\.js$/.test(path.posix.basename(name))) {
        const source = Object.keys(await import(pathToFileURL(path.join(EXT, name)).href)).sort();
        const minified = Object.keys(await import(pathToFileURL(file).href)).sort();
        assert.deepEqual(minified, source, `${name} exports`);
      }
    }
    // The classic scripts keep their top-level names and the literal protocol constants.
    const page = fs.readFileSync(path.join(dir, 'page.js'), 'utf8');
    assert.ok(page.includes('function createPageHelper('), 'page.js keeps its top-level function');
    assert.ok(page.includes('"cswap-page"'), 'page.js keeps the literal port name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
