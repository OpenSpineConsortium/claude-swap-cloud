// What package.mjs and stamp.mjs share: the manifest rules Chrome and the
// store apply, the version a build carries, the file names a release
// uses, and a zip that is the same bytes for the same files.
//
// Node's standard library only.

import crypto from 'node:crypto';
import zlib from 'node:zlib';

// Chrome's own limits: a name of at most 75 characters, a description of
// at most 132, and a version of one to four dot separated integers, each at
// most 65535 with no leading zero.
export const NAME_MAX = 75;
export const DESCRIPTION_MAX = 132;
export const VERSION_RE = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;

export function isVersion(version) {
  return typeof version === 'string' && VERSION_RE.test(version) && !version.split('.').some(n => Number(n) > 65535);
}

// The checks the store or a reviewer would otherwise make of any
// extension. Returns the problems, each one line; an empty list means the
// manifest can be packaged. A repository's own rules (which permissions,
// which host) belong in its own tests, not here.
export function checkManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') return ['manifest.json is not an object'];
  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > NAME_MAX) problems.push(`name must be 1 to ${NAME_MAX} characters`);
  if (typeof manifest.description !== 'string' || !manifest.description.trim() || manifest.description.length > DESCRIPTION_MAX) problems.push(`description must be 1 to ${DESCRIPTION_MAX} characters`);
  if (!isVersion(manifest.version)) problems.push(`version ${JSON.stringify(manifest.version)} is not one to four integers from 0 to 65535`);
  if ('update_url' in manifest) problems.push('update_url is the store\'s to set; take it out of the manifest');
  const csp = manifest.content_security_policy && manifest.content_security_policy.extension_pages;
  if (typeof csp === 'string' && /unsafe-eval|unsafe-inline|https?:/.test(csp)) problems.push('the extension pages CSP must not allow eval, inline or remote scripts');
  if (typeof manifest.homepage_url === 'string' && !manifest.homepage_url.startsWith('https://')) problems.push('homepage_url must be https');
  return problems;
}

// The version a build from a branch carries: the manifest's version with
// the build number as one more integer, so each build is above the last
// with no commit that only raises the manifest. Chrome allows four. A
// build that put the number there itself (from EXTENSION_BUILD) is left
// alone, whatever its count of integers, so it is never appended twice.
export function stampVersion(version, build) {
  const n = Number(build);
  if (!Number.isInteger(n) || n < 1 || n > 65535 || String(build) !== String(n)) {
    return { problem: `build ${JSON.stringify(build)} is not an integer from 1 to 65535` };
  }
  const parts = String(version).split('.');
  if (parts.length > 1 && parts[parts.length - 1] === String(n)) return { version: String(version) };
  if (parts.length > 3) {
    return { problem: `version ${JSON.stringify(version)} already has four integers, so build ${n} has no room: keep the manifest at three (the build number is the fourth), or release by tag` };
  }
  return { version: `${version}.${n}` };
}

// The manifest the store gets: the folder's without its `key` (the store
// refuses a package that carries one and gives the item its own id), at
// the build's version when one is given.
export function storeManifest(manifest, { build = null } = {}) {
  const problems = checkManifest(manifest);
  const store = { ...manifest };
  delete store.key;
  if (build !== null && build !== undefined && build !== '') {
    const stamped = stampVersion(manifest.version, build);
    if (stamped.problem) problems.push(stamped.problem);
    else store.version = stamped.version;
  }
  return { manifest: store, problems };
}

export function manifestBytes(manifest) {
  return Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

// A file name from the manifest's name: "My Extension (beta)" becomes
// my-extension-beta.
export function slug(name) {
  const out = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'extension';
}

// The name the store shows. A localized manifest names itself
// __MSG_key__ and keeps the words in _locales/<default_locale>/
// messages.json, which the package carries; null when that message is
// not among the files given.
export function displayName(manifest, files = new Map()) {
  const name = String(manifest.name || '');
  const m = /^__MSG_(\w+)__$/.exec(name);
  if (!m) return name;
  const bytes = files.get(`_locales/${String(manifest.default_locale || '')}/messages.json`);
  if (!bytes) return null;
  try {
    const entry = JSON.parse(bytes.toString('utf8'))[m[1]];
    return entry && typeof entry.message === 'string' && entry.message.trim() ? entry.message : null;
  } catch (e) {
    return null;
  }
}

export function zipName(name, version) {
  return `${name}-${version}-chrome.zip`;
}

export function fixedName(name) {
  return `${name}-chrome.zip`;
}

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// What sha256sum prints, so `sha256sum -c` checks the file.
export function sha256Line(bytes, fileName) {
  return `${sha256(bytes)}  ${fileName}\n`;
}

export function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

// ------------------------------------------------------------------ zip

// 1980-01-01 00:00, the earliest date a zip can hold: no build time in the bytes.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

// Entries as [name, bytes], written in the order given (sort them first
// for the same bytes every time): deflate level 9, or stored when that is
// smaller, one fixed date, no extra fields, no data descriptors.
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

// Reads any plain zip (stored or deflated entries, sizes from the central
// directory, so data descriptors do no harm; no zip64, no encryption):
// a Map of name to bytes, in the directory's order. Folder entries, which
// some zip tools write, are left out.
export function unzip(buf) {
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(endAt + 10);
  let at = buf.readUInt32LE(endAt + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('not a zip file (a central directory entry is missing)');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (method !== 0 && method !== 8) throw new Error(`${name} is compressed with method ${method}, which this reader does not know`);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const body = buf.subarray(dataAt, dataAt + size);
    out.set(name, method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
  }
  return out;
}

// The entries of a Map, sorted by name, as zip() takes them.
export function sortedEntries(files) {
  return [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
