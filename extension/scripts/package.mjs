// Builds the zip uploaded to the Chrome Web Store.
//
//   node extension/scripts/package.mjs            (writes extension/.output/)
//   node extension/scripts/package.mjs --check    (checks, writes nothing)
//   node extension/scripts/package.mjs --out DIR
//
// The loadable extension is the extension/ folder itself, with no build
// step; this only checks it and copies what Chrome runs into a zip. Two
// things differ from the folder: the manifest loses its `key` (the store
// refuses a package that carries one and gives the item its own id), and
// the repository's PRIVACY.md travels inside it. The zip is the same bytes
// for the same files: entries sorted, one fixed date, no extra fields.
//
// Node's standard library only, like the rest of the extension.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXT = path.resolve(HERE, '..');
export const ROOT = path.resolve(EXT, '..');

// CLAUDE.md, Constraints: exactly these, in this order, and nothing else.
export const PERMISSIONS = ['nativeMessaging', 'userScripts', 'storage', 'sidePanel', 'alarms', 'notifications'];
export const HOST_PERMISSIONS = ['https://claude.ai/*'];
export const ICON_SIZES = ['16', '32', '48', '128'];

// What Chrome runs, relative to extension/. Everything else in the folder
// (README, package.json, scripts/, store-assets/, .output/) stays out.
const INCLUDE = [/^manifest\.json$/, /^sidepanel\.html$/, /^src\/[a-z]+\.js$/, /^icons\/(16|32|48|128)\.png$/];
const EXTRA = [['PRIVACY.md', 'PRIVACY.md']];

// Chrome's own limits: a name of at most 75 characters, a description of
// at most 132, and a version of one to four dot separated integers, each at
// most 65535 with no leading zero.
const NAME_MAX = 75;
const DESCRIPTION_MAX = 132;
const VERSION_RE = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

function isTextFile(name) {
  return /\.(js|html|json|md)$/.test(name);
}

// Every file the manifest names, so a typo there is caught here rather than
// by the store's upload.
function referenced(manifest) {
  const out = [];
  const add = value => { if (typeof value === 'string' && value) out.push(value.replace(/^\//, '')); };
  for (const file of Object.values(manifest.icons || {})) add(file);
  for (const file of Object.values((manifest.action && manifest.action.default_icon) || {})) add(file);
  add(manifest.background && manifest.background.service_worker);
  for (const script of manifest.content_scripts || []) for (const file of script.js || []) add(file);
  add(manifest.side_panel && manifest.side_panel.default_path);
  return out;
}

// The checks the store or a reviewer would otherwise make, and the ones
// this repository promises (CLAUDE.md, Constraints). Returns the problems,
// each one line; an empty list means the package can be built.
export function checkManifest(manifest) {
  const problems = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (typeof manifest.name !== 'string' || !manifest.name || manifest.name.length > NAME_MAX) problems.push(`name must be 1 to ${NAME_MAX} characters`);
  if (typeof manifest.description !== 'string' || !manifest.description || manifest.description.length > DESCRIPTION_MAX) problems.push(`description must be 1 to ${DESCRIPTION_MAX} characters`);
  if (!VERSION_RE.test(String(manifest.version || '')) || String(manifest.version).split('.').some(n => Number(n) > 65535)) problems.push(`version ${JSON.stringify(manifest.version)} is not one to four integers`);
  if (!same(manifest.permissions, PERMISSIONS)) problems.push(`permissions must be exactly ${PERMISSIONS.join(', ')}`);
  if (!same(manifest.host_permissions, HOST_PERMISSIONS)) problems.push(`host_permissions must be exactly ${HOST_PERMISSIONS.join(', ')}`);
  for (const key of ['optional_permissions', 'optional_host_permissions', 'externally_connectable', 'web_accessible_resources', 'update_url']) {
    if (key in manifest) problems.push(`${key} is not expected in this extension`);
  }
  for (const size of ICON_SIZES) {
    if (!manifest.icons || manifest.icons[size] !== `icons/${size}.png`) problems.push(`icons.${size} must be icons/${size}.png`);
  }
  const csp = manifest.content_security_policy && manifest.content_security_policy.extension_pages;
  if (typeof csp === 'string' && /unsafe-eval|unsafe-inline|https?:/.test(csp)) problems.push('the extension pages CSP must not allow eval, inline or remote scripts');
  if (typeof manifest.homepage_url === 'string' && !manifest.homepage_url.startsWith('https://')) problems.push('homepage_url must be https');
  return problems;
}

// The package's files as [name, bytes], sorted, with the store manifest.
export function collect({ ext = EXT, root = ROOT, manifest } = {}) {
  const problems = [];
  const source = manifest || JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  problems.push(...checkManifest(source));
  const files = new Map();
  for (const name of walk(ext)) {
    if (name === 'manifest.json' || !INCLUDE.some(re => re.test(name))) continue;
    files.set(name, fs.readFileSync(path.join(ext, name)));
  }
  for (const [name, from] of EXTRA) {
    const file = path.join(root, from);
    if (fs.existsSync(file)) files.set(name, fs.readFileSync(file));
    else problems.push(`${from} is missing at the repository root`);
  }
  const store = { ...source };
  delete store.key;
  files.set('manifest.json', Buffer.from(JSON.stringify(store, null, 2) + '\n', 'utf8'));

  for (const file of referenced(source)) {
    if (!files.has(file)) problems.push(`the manifest names ${file}, which is not in the package`);
  }
  for (const size of ICON_SIZES) {
    const bytes = files.get(`icons/${size}.png`);
    const dims = bytes && pngSize(bytes);
    if (bytes && (!dims || dims[0] !== Number(size) || dims[1] !== Number(size))) problems.push(`icons/${size}.png is not a ${size}x${size} PNG`);
  }
  // A module the package imports must be in the package too.
  for (const [name, bytes] of files) {
    if (!/\.js$/.test(name)) continue;
    for (const m of bytes.toString('utf8').matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
      const target = path.posix.join(path.posix.dirname(name), m[1]);
      if (!files.has(target)) problems.push(`${name} imports ${m[1]}, which is not in the package`);
    }
  }
  // CLAUDE.md, Conventions: plain ASCII with LF endings.
  for (const [name, bytes] of files) {
    if (!isTextFile(name)) continue;
    if (bytes.some(b => b > 0x7f || b === 0x0d)) problems.push(`${name} is not plain ASCII with LF endings`);
  }
  const sorted = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { files: sorted, manifest: store, problems };
}

// ------------------------------------------------------------------ zip

// 1980-01-01 00:00, the earliest date a zip can hold: no build time in the bytes.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);          // made by: Unix, zip 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// Reads back what zip() writes (and any plain zip without data descriptors).
export function unzip(buf) {
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('no end of central directory');
  const count = buf.readUInt16LE(endAt + 10);
  let at = buf.readUInt32LE(endAt + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const body = buf.subarray(dataAt, dataAt + size);
    out.set(name, method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function zipName(manifest) {
  return `cswap-import-${manifest.version}-chrome.zip`;
}

// ------------------------------------------------------------------ the command

function main(argv) {
  const check = argv.includes('--check');
  const outAt = argv.indexOf('--out');
  const outDir = outAt >= 0 ? path.resolve(argv[outAt + 1]) : path.join(EXT, '.output');
  const { files, manifest, problems } = collect();
  if (problems.length) {
    for (const p of problems) console.error(`problem: ${p}`);
    return 1;
  }
  const bytes = zip(files);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  if (check) {
    console.log(`ok: ${files.length} files, ${bytes.length} bytes, version ${manifest.version}`);
    return 0;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, zipName(manifest));
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(`${file}.sha256`, `${sha}  ${path.basename(file)}\n`);
  console.log(`${path.relative(process.cwd(), file) || file}`);
  console.log(`  ${files.length} files, ${bytes.length} bytes, version ${manifest.version}`);
  console.log(`  sha256 ${sha}`);
  for (const [name, data] of files) console.log(`  ${String(data.length).padStart(7)}  ${name}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
