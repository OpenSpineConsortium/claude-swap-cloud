// Draws the extension's icons and the Chrome Web Store images from
// frame.html, with the real side panel inside the screenshots.
//
//   node extension/store-assets/src/build_assets.mjs [--no-screenshots]
//
// --no-screenshots draws only the icons and the two tiles and leaves the
// screenshot files as they are.
//
// A maintainer's tool, not part of the extension and not run by the tests:
// it needs Playwright and its Chromium (`npm i -g playwright` and
// `npx playwright install chromium`, or any Playwright already on the
// machine; PLAYWRIGHT_MODULE names its folder when `npm root -g` does not
// hold it). The extension itself stays free of npm packages.
//
// Writes extension/icons/{16,32,48,128}.png and, under extension/
// store-assets/, store-icon-128.png, screenshot-0N-*.png (1280x800),
// promo-tile-440x280.png and marquee-1400x560.png. The screenshots and the
// tiles are re-encoded as 8-bit RGB with no alpha, as the store asks; the
// icons keep their transparent padding.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..', '..');
const ASSETS = path.join(EXT, 'store-assets');

const SHOTS = [
  ['importing', 'screenshot-01-importing.png'],
  ['stopped', 'screenshot-02-stops-and-tells.png'],
  ['done', 'screenshot-03-done.png'],
];
const ICON_SIZES = [16, 32, 48, 128];

// ------------------------------------------------------------------ PNG

function chunks(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const out = [];
  for (let at = 8; at < buf.length;) {
    const len = buf.readUInt32BE(at);
    out.push({ type: buf.toString('latin1', at + 4, at + 8), data: buf.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
  }
  return out;
}

export function pngInfo(buf) {
  const ihdr = chunks(buf)[0].data;
  return { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4), depth: ihdr[8], colorType: ihdr[9] };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

// Undoes the row filters of an 8-bit RGB or RGBA PNG and writes it again as
// RGB: what Chromium hands back may carry an alpha channel even when every
// pixel is opaque, and the store refuses alpha in screenshots and tiles.
export function toRgb(buf) {
  const all = chunks(buf);
  const { width, height, depth, colorType } = pngInfo(buf);
  if (depth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`unexpected PNG ${depth}-bit type ${colorType}`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(all.filter(c => c.type === 'IDAT').map(c => c.data)));
  const stride = width * bpp;
  const prev = Buffer.alloc(stride);
  const out = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[i] = (row[i] + add) & 0xff;
    }
    row.copy(prev);
    const o = y * (width * 3 + 1);
    out[o] = 0;
    for (let x = 0; x < width; x++) {
      if (bpp === 4 && row[x * 4 + 3] !== 255) throw new Error(`pixel ${x},${y} is not opaque`);
      out[o + 1 + x * 3] = row[x * bpp];
      out[o + 2 + x * 3] = row[x * bpp + 1];
      out[o + 3 + x * 3] = row[x * bpp + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([buf.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ serving

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function serve(root) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// The stand-in chrome for sidepanel.html: a runtime with the pinned id, a
// port that answers nothing, and storage holding the scene. Installed before
// any of the page's scripts run.
function standIn() {
  if (location.pathname !== '/sidepanel.html') return;
  const scene = new URLSearchParams(location.search).get('scene') || 'importing';
  const listeners = () => ({ addListener() {} });
  globalThis.chrome = {
    runtime: {
      id: 'jhplijnbeejmlgmephlhckpggocpmefp',
      connect: () => ({ onMessage: listeners(), onDisconnect: listeners(), postMessage() {} }),
      getURL: p => p,
    },
    storage: {
      local: {
        async get() {
          const { SCENES, storageFor, CONFIG } = await import('/store-assets/src/scenes.mjs');
          const { KEYS } = await import('/src/protocol.js');
          return storageFor(SCENES[scene], Date.now(), KEYS, CONFIG);
        },
      },
      onChanged: listeners(),
    },
  };
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const roots = [process.env.PLAYWRIGHT_MODULE && path.dirname(process.env.PLAYWRIGHT_MODULE), process.cwd()];
  try { roots.push(execSync('npm root -g', { encoding: 'utf8' }).trim()); } catch { /* no npm */ }
  for (const root of roots.filter(Boolean)) {
    try { return require(require.resolve('playwright', { paths: [root] })); } catch { /* next */ }
  }
  throw new Error('Playwright was not found: `npm i -g playwright`, or set PLAYWRIGHT_MODULE to its folder.');
}

async function main(argv = process.argv.slice(2)) {
  const screenshots = !argv.includes('--no-screenshots');
  const { chromium } = loadPlaywright();
  const server = await serve(EXT);
  const base = `http://127.0.0.1:${server.address().port}/store-assets/src/frame.html`;
  const browser = await chromium.launch();
  const written = [];
  try {
    const shoot = async (query, width, height, transparent = false) => {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'light' });
      await page.addInitScript(standIn);
      await page.goto(`${base}?${query}`);
      await page.waitForSelector('body[data-ready="1"]');
      if (query.startsWith('scene=') || query === 'tile=marquee') {
        // The panel draws once its storage read resolves; wait for its first line.
        await page.waitForFunction(() => {
          const frame = document.querySelector('iframe');
          const line = frame && frame.contentDocument && frame.contentDocument.getElementById('status-line');
          return !!(line && line.textContent.length);
        });
      }
      await page.evaluate(() => document.fonts.ready);
      const png = await page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
      await page.close();
      return png;
    };
    for (const size of ICON_SIZES) {
      const png = await shoot(`icon=${size}`, size, size, true);
      fs.writeFileSync(path.join(EXT, 'icons', `${size}.png`), png);
      written.push(`icons/${size}.png`);
      if (size === 128) { fs.writeFileSync(path.join(ASSETS, 'store-icon-128.png'), png); written.push('store-assets/store-icon-128.png'); }
    }
    for (const [scene, file] of screenshots ? SHOTS : []) {
      fs.writeFileSync(path.join(ASSETS, file), toRgb(await shoot(`scene=${scene}`, 1280, 800)));
      written.push(`store-assets/${file}`);
    }
    fs.writeFileSync(path.join(ASSETS, 'promo-tile-440x280.png'), toRgb(await shoot('tile=small', 440, 280)));
    fs.writeFileSync(path.join(ASSETS, 'marquee-1400x560.png'), toRgb(await shoot('tile=marquee', 1400, 560)));
    written.push('store-assets/promo-tile-440x280.png', 'store-assets/marquee-1400x560.png');
  } finally {
    await browser.close();
    server.close();
  }
  for (const file of written) {
    const info = pngInfo(fs.readFileSync(path.join(EXT, file)));
    console.log(`${file}  ${info.width}x${info.height}  ${info.colorType === 6 ? 'RGBA' : 'RGB'}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e && e.stack || e); process.exit(1); });
}
