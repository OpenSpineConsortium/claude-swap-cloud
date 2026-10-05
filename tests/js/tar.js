'use strict';
// A small, independent tar reader and writer for the tests: what the export
// script downloads is unpacked here and compared with a folder export, and
// what the import script is handed is packed here. Plain ustar, with GNU
// long-name entries ('L') for paths over 100 bytes, which is what the
// scripts write and read, and what tar(1), 7-Zip and Python's tarfile take.

const BLOCK = 512;

function octal(value, width) {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name, size, type) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(0, 12), 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

function padded(bytes) {
  const rest = bytes.length % BLOCK;
  return rest ? Buffer.concat([bytes, Buffer.alloc(BLOCK - rest)]) : bytes;
}

// entries: [{ path, bytes }] -> Buffer
function pack(entries) {
  const parts = [];
  for (const { path, bytes } of entries) {
    const nameBytes = Buffer.from(path, 'utf8');
    if (nameBytes.length > 100) {
      const long = Buffer.concat([nameBytes, Buffer.alloc(1)]);
      parts.push(header('././@LongLink', long.length, 'L'), padded(long));
    }
    parts.push(header(nameBytes.length > 100 ? nameBytes.subarray(0, 100).toString('utf8') : path, bytes.length, '0'));
    parts.push(padded(Buffer.from(bytes)));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function field(h, at, len) {
  const raw = h.subarray(at, at + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? len : end).toString('utf8');
}

// Buffer -> [{ path, bytes, type }], files only unless `all` is set.
function unpack(buffer, all = false) {
  const out = [];
  let at = 0;
  let longName = null;
  while (at + BLOCK <= buffer.length) {
    const h = buffer.subarray(at, at + BLOCK);
    if (h.every(b => b === 0)) break;
    const size = parseInt(field(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156]) || '0';
    let name = field(h, 0, 100);
    const prefix = field(h, 345, 155);
    if (prefix && field(h, 257, 6) === 'ustar') name = `${prefix}/${name}`;
    const body = buffer.subarray(at + BLOCK, at + BLOCK + size);
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') {
      longName = body.subarray(0, body.indexOf(0) < 0 ? body.length : body.indexOf(0)).toString('utf8');
      continue;
    }
    if (longName) {
      name = longName;
      longName = null;
    }
    if (type === '0' || type === '\0' || all) out.push({ path: name, bytes: Buffer.from(body), type });
  }
  return out;
}

module.exports = { pack, unpack, BLOCK };
