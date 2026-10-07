// lib.mjs: the zip is the same bytes for the same files and reads back,
// the manifest rules are Chrome's, and a build number has its place.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const lib = await import(pathToFileURL(path.join(HERE, '..', 'lib.mjs')).href);

const MANIFEST = { manifest_version: 3, name: 'Kit Test', version: '1.2.3', description: 'A test.', key: 'MIIB' };

test('a zip round-trips and is the same bytes every time', () => {
  const entries = lib.sortedEntries(new Map([['src/b.js', Buffer.from('b'.repeat(500))], ['a.txt', Buffer.from('hello')], ['manifest.json', Buffer.from('{}\n')]]));
  assert.deepEqual(entries.map(([n]) => n), ['a.txt', 'manifest.json', 'src/b.js'], 'sorted by name');
  const a = lib.zip(entries);
  const b = lib.zip(entries);
  assert.ok(a.equals(b));
  const back = lib.unzip(a);
  assert.deepEqual([...back.keys()], ['a.txt', 'manifest.json', 'src/b.js']);
  for (const [name, bytes] of entries) assert.ok(back.get(name).equals(bytes), name);
  // The 500 b's deflate; the short entries are stored. Both read back.
  assert.equal(a.readUInt16LE(a.indexOf(Buffer.from('src/b.js')) - 30 + 8), 8, 'deflated');
  assert.equal(a.readUInt16LE(a.indexOf(Buffer.from('a.txt')) - 30 + 8), 0, 'stored');
  assert.throws(() => lib.unzip(Buffer.from('not a zip at all')), /not a zip file/);
});

test('a zip with folder entries and data descriptors reads back too', () => {
  // A zip another tool made: a folder entry, and a local header whose
  // sizes are zero with bit 3 set (the sizes live in the central
  // directory, which is what unzip() reads).
  const data = Buffer.from('payload');
  const name = Buffer.from('dir/file.txt');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 6); local.writeUInt16LE(0, 8);
  local.writeUInt16LE(name.length, 26);
  const folderName = Buffer.from('dir/');
  const folderLocal = Buffer.alloc(30);
  folderLocal.writeUInt32LE(0x04034b50, 0); folderLocal.writeUInt16LE(20, 4); folderLocal.writeUInt16LE(folderName.length, 26);
  const central = (n, size, method, offset) => {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 6); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(size, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    return Buffer.concat([c, n]);
  };
  const body = Buffer.concat([folderLocal, folderName, local, name, data]);
  const dir = Buffer.concat([central(folderName, 0, 0, 0), central(name, data.length, 0, folderLocal.length + folderName.length)]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(body.length, 16);
  const back = lib.unzip(Buffer.concat([body, dir, end]));
  assert.deepEqual([...back.keys()], ['dir/file.txt'], 'the folder entry is left out');
  assert.equal(back.get('dir/file.txt').toString(), 'payload');
});

test('the manifest rules are Chrome\'s limits, not a repository\'s', () => {
  assert.deepEqual(lib.checkManifest(MANIFEST), []);
  const bad = (over, pattern) => {
    const problems = lib.checkManifest({ ...MANIFEST, ...over });
    assert.ok(problems.some(p => pattern.test(p)), `${JSON.stringify(over)} -> ${problems.join('; ')}`);
  };
  bad({ manifest_version: 2 }, /manifest_version/);
  bad({ name: 'x'.repeat(76) }, /name/);
  bad({ name: '  ' }, /name/);
  bad({ description: 'x'.repeat(133) }, /description/);
  bad({ version: '1.02' }, /version/);
  bad({ version: '1.2.3.4.5' }, /version/);
  bad({ version: '70000' }, /version/);
  bad({ version: 7 }, /version/);
  bad({ update_url: 'https://x' }, /update_url/);
  bad({ content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" } }, /CSP/);
  bad({ homepage_url: 'http://x' }, /https/);
  assert.deepEqual(lib.checkManifest({ ...MANIFEST, permissions: ['cookies', 'tabs'], host_permissions: ['<all_urls>'] }), [], 'permissions are the repository\'s own rule');
  assert.deepEqual(lib.checkManifest(null), ['manifest.json is not an object']);
});

test('a build number is one more integer, kept when the build put it there already', () => {
  assert.deepEqual(lib.stampVersion('0.2.0', 236), { version: '0.2.0.236' });
  assert.deepEqual(lib.stampVersion('0.2.0', '236'), { version: '0.2.0.236' });
  assert.deepEqual(lib.stampVersion('0.2.0.236', 236), { version: '0.2.0.236' }, 'already stamped');
  assert.deepEqual(lib.stampVersion('1', 5), { version: '1.5' });
  assert.deepEqual(lib.stampVersion('1.0.731', 731), { version: '1.0.731' }, 'a build that stamped a two-integer version itself');
  assert.deepEqual(lib.stampVersion('1.2.3.5', 5), { version: '1.2.3.5' });
  assert.deepEqual(lib.stampVersion('731', 731), { version: '731.731' }, 'one integer is never taken for a stamp');
  for (const bad of ['0', '-1', '65536', '12a', ' 7', '', 'x']) assert.match(lib.stampVersion('0.2.0', bad).problem, /not an integer from 1 to 65535/, bad);
  assert.match(lib.stampVersion('1.2.3.4', 5).problem, /already has four integers/);
});

test('the store manifest drops the key and takes the build number', () => {
  const { manifest, problems } = lib.storeManifest(MANIFEST, { build: '7' });
  assert.deepEqual(problems, []);
  assert.equal('key' in manifest, false);
  assert.equal(manifest.version, '1.2.3.7');
  assert.equal(MANIFEST.version, '1.2.3', 'the input is not changed');
  assert.equal(lib.storeManifest(MANIFEST).manifest.version, '1.2.3', 'no build, no stamp');
  assert.equal(lib.storeManifest(MANIFEST, { build: '' }).manifest.version, '1.2.3', 'an empty build is no build');
  assert.match(lib.storeManifest(MANIFEST, { build: 'x' }).problems.join('\n'), /build "x"/);
  assert.equal(lib.manifestBytes({ a: 1 }).toString(), '{\n  "a": 1\n}\n');
});

test('names: the slug, the zip names, the checksum line', () => {
  assert.equal(lib.slug('Claude Swap Cloud'), 'claude-swap-cloud');
  assert.equal(lib.slug('  Beethoven!! (beta) '), 'beethoven-beta');
  assert.equal(lib.slug('***'), 'extension');
  assert.equal(lib.zipName('my-ext', '1.2.3.4'), 'my-ext-1.2.3.4-chrome.zip');
  assert.equal(lib.fixedName('my-ext'), 'my-ext-chrome.zip');
  const line = lib.sha256Line(Buffer.from('abc'), 'x.zip');
  assert.equal(line, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  x.zip\n', 'what sha256sum prints');
  assert.equal(lib.pngSize(Buffer.from('nope')), null);
});

test('a localized name is read from the default locale\'s messages', () => {
  const files = new Map([['_locales/en/messages.json', Buffer.from(JSON.stringify({ extName: { message: 'My Localized Ext' } }))]]);
  assert.equal(lib.displayName({ name: 'Plain' }, files), 'Plain');
  assert.equal(lib.displayName({ name: '__MSG_extName__', default_locale: 'en' }, files), 'My Localized Ext');
  assert.equal(lib.displayName({ name: '__MSG_other__', default_locale: 'en' }, files), null, 'no such message');
  assert.equal(lib.displayName({ name: '__MSG_extName__', default_locale: 'fr' }, files), null, 'no such locale');
  assert.equal(lib.displayName({ name: '__MSG_extName__', default_locale: 'en' }, new Map([['_locales/en/messages.json', Buffer.from('{nope')]])), null, 'not JSON');
  assert.equal(lib.displayName({ name: '__MSG_extName__' }), null, 'no files given');
});
