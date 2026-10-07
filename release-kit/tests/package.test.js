// package.mjs: the zip holds what Chrome loads and nothing else, the
// manifest loses its key, the checks catch what the store would, and the
// minifying goes through an injected esbuild (no process is opened).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pkg = await import(pathToFileURL(path.join(HERE, '..', 'package.mjs')).href);

// A PNG as far as the size check reads it: the signature, then the IHDR
// chunk's width and height at offsets 16 and 20.
function png(width, height) {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const MANIFEST = {
  manifest_version: 3,
  name: 'Kit Test',
  version: '1.2.3',
  description: 'An extension the tests build.',
  minimum_chrome_version: '130',
  key: 'MIIBIjANBgkq',
  icons: { 16: 'icons/16.png', 128: 'icons/128.png' },
  action: { default_popup: 'popup.html', default_icon: { 16: 'icons/16.png' } },
  background: { service_worker: 'src/background.js', type: 'module' },
  content_scripts: [{ matches: ['https://example.com/*'], js: ['src/content.js'], css: ['style.css'] }],
  options_ui: { page: 'options.html' },
  web_accessible_resources: [{ resources: ['assets/*.png'], matches: ['https://example.com/*'] }],
  default_locale: 'en',
};

// A folder like one kept in a repository: what Chrome loads, plus the
// things beside it that must stay out.
function fixture(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-kit-fixture-'));
  const write = (name, content) => {
    const file = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write('manifest.json', JSON.stringify({ ...MANIFEST, ...over }, null, 2) + '\n');
  write('icons/16.png', png(16, 16));
  write('icons/128.png', png(128, 128));
  write('popup.html', '<!doctype html><script type="module" src="src/popup.js"></script>');
  write('options.html', '<!doctype html>');
  write('style.css', 'body{}');
  write('src/background.js', "import { x } from './lib.js';\nexport const y = x + 1;\n");
  write('src/lib.js', 'export const x = 1;\n');
  write('src/content.js', 'const a = 1;\n');
  write('src/popup.js', "import './lib.js';\n");
  write('_locales/en/messages.json', '{}');
  write('assets/one.png', png(1, 1));
  write('docs/notes.md', 'notes');
  write('README.md', 'readme');
  write('package.json', '{}');
  write('package-lock.json', '{}');
  write('tsconfig.json', '{}');
  write('e2e/run.mjs', '');
  write('store-assets/tile.png', png(440, 280));
  write('tests/a.test.js', '');
  write('src/lib.test.js', '');
  write('src/lib.js.map', '{}');
  write('.output/old.zip', 'PK');
  write('.eslintrc', '{}');
  write('node_modules/x/index.js', '');
  return dir;
}

test('the zip holds what Chrome loads, without the key, and nothing else', () => {
  const dir = fixture();
  try {
    const { files, manifest, problems } = pkg.collect({ dir });
    assert.deepEqual(problems, []);
    assert.deepEqual(files.map(([n]) => n), [
      '_locales/en/messages.json', 'assets/one.png', 'docs/notes.md', 'icons/128.png', 'icons/16.png', 'manifest.json',
      'options.html', 'popup.html', 'src/background.js', 'src/content.js', 'src/lib.js', 'src/popup.js', 'style.css',
    ]);
    assert.equal('key' in manifest, false);
    const { key, ...rest } = MANIFEST;
    assert.deepEqual(manifest, rest);
    const inZip = JSON.parse(pkg.unzip(pkg.zip(files)).get('manifest.json').toString('utf8'));
    assert.deepEqual(inZip, rest);
    assert.ok(pkg.zip(files).equals(pkg.zip(pkg.collect({ dir }).files)), 'the same bytes twice');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--extra brings a file from outside, --exclude leaves more out, --build stamps the version', () => {
  const dir = fixture();
  const outside = path.join(dir, '..', `release-kit-extra-${path.basename(dir)}.md`);
  fs.writeFileSync(outside, 'policy');
  try {
    const { files, manifest, problems } = pkg.collect({ dir, build: '42', extra: [outside, `${outside}:docs/POLICY.md`], exclude: ['docs/**', 'assets/*'] });
    assert.deepEqual(problems, []);
    const names = files.map(([n]) => n);
    assert.ok(names.includes(path.basename(outside)), 'at its own name');
    assert.ok(names.includes('docs/POLICY.md'), 'at the name given');
    assert.ok(!names.includes('docs/notes.md'), 'docs/** is out');
    assert.ok(!names.includes('assets/one.png'), 'assets/* is out');
    assert.match(pkg.collect({ dir, exclude: ['*.css'] }).problems.join('\n'), /style\.css, which is not in the package/, 'a file the manifest names cannot be left out');
    assert.equal(manifest.version, '1.2.3.42');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version, '1.2.3', 'the folder is not touched');
    assert.match(pkg.collect({ dir, extra: ['/nowhere/missing.md'] }).problems.join('\n'), /missing\.md \(--extra\) is missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('the checks catch what the store would refuse', () => {
  const dir = fixture();
  try {
    const problems = over => pkg.collect({ dir: fixture(over) }).problems;
    assert.match(problems({ side_panel: { default_path: 'panel-missing.html' } }).join('\n'), /panel-missing\.html, which is not in the package/);
    assert.match(problems({ icons: { 16: 'icons/16.png', 48: 'icons/128.png' } }).join('\n'), /icons\/128\.png is not a 48x48 PNG/);
    assert.match(problems({ version: '1.2.3.4', name: '' }).join('\n'), /name must be/);
    assert.match(problems({ default_locale: 'fr' }).join('\n'), /_locales\/fr\/messages\.json/);
    fs.writeFileSync(path.join(dir, 'src', 'background.js'), "import { z } from './gone.js';\n");
    assert.match(pkg.collect({ dir }).problems.join('\n'), /src\/background\.js imports \.\/gone\.js, which is not in the package/);
    fs.writeFileSync(path.join(dir, 'src', 'background.js'), "export const EXT = '.js';\nexport function f(s) {\n  return s.replace(/x/, '..');\n}\nimport './side.js';\nexport { a as b } from './named.js';\nimport {\n  c,\n} from './multi.js';\nexport * as ns from './star.js';\n");
    const imports = pkg.collect({ dir }).problems.join('\n');
    assert.ok(!/imports \.js|imports \.\.,/.test(imports), `a quoted string is no import: ${imports}`);
    for (const name of ['side', 'named', 'multi', 'star']) assert.match(imports, new RegExp(`imports \\./${name}\\.js, which is not in the package`));
    assert.deepEqual(problems({ action: { default_icon: 'icons/16.png' } }).filter(p => /names/.test(p)), [], 'one icon for every size is a string');
    assert.match(problems({ action: { default_icon: 'icons/none.png' } }).join('\n'), /names icons\/none\.png, which is not in the package/);
    assert.match(problems({ action: { default_icon: 'style.css' } }).join('\n'), /style\.css is not a PNG/);
    assert.ok(pkg.referenced({ ...MANIFEST, action: { default_icon: 'one.png' } }).includes('one.png'));
    // A page's own files: a runtime folder named scripts/ stays in, and a
    // file a page loads that the package lacks is named.
    fs.writeFileSync(path.join(dir, 'popup.html'), '<!doctype html><link rel="stylesheet" href="missing.css"><script src="scripts/popup.js"></script><img src="https://example.com/x.png">');
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'popup.js'), 'document.title = 1;\n');
    const page = pkg.collect({ dir });
    assert.ok(page.files.some(([n]) => n === 'scripts/popup.js'), 'scripts/ is a folder Chrome may load');
    assert.match(page.problems.join('\n'), /popup\.html loads missing\.css, which is not in the package/);
    assert.ok(!/popup\.html loads scripts\/popup\.js/.test(page.problems.join('\n')));
    assert.deepEqual(pkg.pageReferences('<script src="../a.js"></script><link href="/b.css"><img src=\'c.png?v=2\'><a href="d.html"><script src="data:text/javascript,1"></script><script src="//cdn/x.js"></script>', 'pages/one.html'), ['a.js', 'b.css', 'pages/c.png']);
    assert.deepEqual(pkg.collect({ dir: path.join(dir, 'nowhere') }).problems.length, 1);
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{not json');
    assert.match(pkg.collect({ dir }).problems.join('\n'), /is not JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('what the manifest names is read from every place Chrome looks', () => {
  const names = pkg.referenced({
    ...MANIFEST,
    side_panel: { default_path: 'panel.html' },
    options_page: 'old-options.html',
    devtools_page: 'devtools.html',
    chrome_url_overrides: { newtab: 'tab.html' },
    sandbox: { pages: ['sandbox.html'] },
    declarative_net_request: { rule_resources: [{ id: 'r', enabled: true, path: 'rules.json' }] },
    web_accessible_resources: [{ resources: ['assets/*.png', 'exact.png'] }],
  });
  for (const expected of ['icons/16.png', 'icons/128.png', 'popup.html', 'src/background.js', 'src/content.js', 'style.css', 'options.html', 'panel.html', 'old-options.html', 'devtools.html', 'tab.html', 'sandbox.html', 'rules.json', 'exact.png', '_locales/en/messages.json']) {
    assert.ok(names.includes(expected), expected);
  }
  assert.ok(!names.some(n => n.includes('*')), 'patterns are skipped');
});

test('the exclude patterns: dot files, the known folders, * and **', () => {
  for (const name of ['.hidden', 'src/.keep', '.output/x.zip', 'node_modules/a/b.js', 'src/node_modules/a.js', 'store-assets/a.png', 'test/a.js', 'tests/a.js', 'e2e/a.js', 'README.md', 'readme.txt', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'src/a.test.js', 'src/a.js.map']) {
    assert.equal(pkg.excluded(name), true, name);
  }
  for (const name of ['scripts/x.mjs', 'src/scripts.js', 'src/store-assets.js', 'docs/README-like.md', 'package.js', 'tests.js', 'src/test.js']) {
    assert.equal(pkg.excluded(name), false, name);
  }
  const re = pkg.globToRegExp;
  assert.ok(re('docs/**').test('docs/a/b.md'));
  assert.ok(re('docs/**').test('docs/a.md'));
  assert.ok(!re('docs/**').test('src/docs/a.md'));
  assert.ok(re('*.css').test('a.css'));
  assert.ok(!re('*.css').test('src/a.css'));
  assert.ok(re('**/*.css').test('src/a.css'));
  assert.ok(re('src/?.js').test('src/a.js'));
  assert.ok(!re('src/?.js').test('src/ab.js'));
  assert.ok(!re('a.b').test('aXb'), 'a dot is a dot');
});

test('minify replaces the scripts and nothing else, through the injected esbuild, keeping folders', () => {
  const dir = fixture();
  try {
    const { files } = pkg.collect({ dir });
    const seen = [];
    const run = (inputs, inDir, outDir, target) => {
      seen.push({ inputs: inputs.map(f => path.relative(inDir, f).split(path.sep).join('/')).sort(), target });
      for (const f of inputs) {
        const out = path.join(outDir, path.relative(inDir, f));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, `/*m*/${fs.readFileSync(f, 'utf8').length}`);
      }
    };
    const { files: out, problems } = pkg.minify(files, { run, target: pkg.minifyTarget(MANIFEST) });
    assert.deepEqual(problems, []);
    assert.deepEqual(seen, [{ inputs: ['src/background.js', 'src/content.js', 'src/lib.js', 'src/popup.js'], target: 'chrome130' }], 'one run, every script, the manifest\'s Chrome');
    assert.deepEqual(out.map(([n]) => n), files.map(([n]) => n), 'same names, same order');
    for (const [name, bytes] of out) {
      const original = files.find(([n]) => n === name)[1];
      if (/\.js$/.test(name)) assert.equal(bytes.toString('utf8'), `/*m*/${original.length}`, name);
      else assert.ok(bytes.equals(original), `${name} untouched`);
    }
    const none = pkg.minify(files, { run: () => {} });
    assert.equal(none.problems.length, 4);
    assert.ok(none.problems.every(p => /wrote no/.test(p)));
    const broken = pkg.minify(files, { run: () => { throw new Error('spawn npx ENOENT\nmore'); } });
    assert.deepEqual(broken.problems, [`esbuild did not run (spawn npx ENOENT); install esbuild ${pkg.ESBUILD_VERSION} and set RELEASE_KIT_ESBUILD, let npx fetch it, or pass --plain`]);
    assert.deepEqual(broken.files, files);
    assert.equal(pkg.minifyTarget({}), 'es2022');
    assert.equal(pkg.minifyTarget({ minimum_chrome_version: '135.0' }), 'chrome135');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the esbuild command is the installed one when named, else npx with the pinned version', () => {
  assert.deepEqual(pkg.esbuildCommand({ RELEASE_KIT_ESBUILD: '/opt/esbuild' }), { command: '/opt/esbuild', args: [] });
  const npx = pkg.esbuildCommand({});
  assert.match(npx.command, /^npx(\.cmd)?$/);
  assert.deepEqual(npx.args, ['-y', `esbuild@${pkg.ESBUILD_VERSION}`]);
  assert.match(pkg.ESBUILD_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(pkg.MINIFY_ARGS.includes('--minify'));
  assert.ok(!pkg.MINIFY_ARGS.some(a => /sourcemap|bundle/.test(a)), 'no source map, no bundling');
});

test('the command: --check writes nothing, a build writes the zip and its checksum, --plain says so', () => {
  const dir = fixture();
  const out = path.join(dir, '..', `release-kit-out-${path.basename(dir)}`);
  const lines = [];
  const errors = [];
  const io = { log: l => lines.push(String(l)), error: l => errors.push(String(l)) };
  try {
    assert.equal(pkg.main(['--dir', dir, '--out', out, '--plain', '--check'], io), 0);
    assert.match(lines[0], /^ok: 13 files, \d+ bytes, version 1\.2\.3, plain$/);
    assert.equal(fs.existsSync(out), false);
    assert.equal(pkg.main(['--dir', dir, '--out', out, '--plain', '--name', 'kit-test', '--build', '9'], io), 0);
    const zip = path.join(out, 'kit-test-1.2.3.9-chrome.zip');
    assert.ok(fs.existsSync(zip));
    const sha = fs.readFileSync(`${zip}.sha256`, 'utf8');
    assert.match(sha, /^[0-9a-f]{64}  kit-test-1\.2\.3\.9-chrome\.zip\n$/);
    assert.equal(JSON.parse(pkg.unzip(fs.readFileSync(zip)).get('manifest.json').toString()).version, '1.2.3.9');
    assert.equal(pkg.main(['--dir', dir, '--out', out, '--plain', '--build', 'x'], io), 1);
    assert.match(errors.join('\n'), /problem: build "x"/);
    assert.equal(pkg.main(['--bogus'], io), 2);
    assert.match(errors.join('\n'), /usage:/);
    assert.equal(pkg.main(['--dir'], io), 2);
    assert.equal(pkg.main(['--help'], io), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// With a real esbuild (CI sets RELEASE_KIT_ESBUILD to the pinned one) the
// minified scripts must still parse, and a module keeps its exports.
// Skipped elsewhere: the suite opens no process it did not make.
test('with a real esbuild the minified scripts parse and the modules keep their exports', { skip: !process.env.RELEASE_KIT_ESBUILD && 'RELEASE_KIT_ESBUILD is not set' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = fixture();
  try {
    const { files } = pkg.collect({ dir });
    const { files: out, problems } = pkg.minify(files, { target: 'chrome130' });
    assert.deepEqual(problems, []);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'release-kit-minified-'));
    try {
      fs.writeFileSync(path.join(work, 'package.json'), '{"type":"module"}\n');
      for (const [name, bytes] of out) {
        if (!/\.js$/.test(name)) continue;
        const file = path.join(work, ...name.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      }
      const mod = await import(pathToFileURL(path.join(work, 'src', 'background.js')).href);
      assert.equal(mod.y, 2, 'the import between modules still works');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an argument with a space stays whole through cmd.exe', () => {
  const args = ['C:\\Users\\Some User\\npx.cmd', '--outbase=C:\\Users\\Some User\\Temp\\in', '--minify', 'C:\\Users\\Some User\\Temp\\in\\bg.js'];
  assert.deepEqual(pkg.shellArgs(args, true), ['"C:\\Users\\Some User\\npx.cmd"', '"--outbase=C:\\Users\\Some User\\Temp\\in"', '--minify', '"C:\\Users\\Some User\\Temp\\in\\bg.js"']);
  assert.deepEqual(pkg.shellArgs(args, false), args, 'without a shell the arguments reach the process as they are');
});
