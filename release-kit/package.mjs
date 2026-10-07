// Builds the zip a Chrome extension with no build step uploads to the
// Chrome Web Store, from the folder Chrome loads unpacked.
//
//   node release-kit/package.mjs                      (extension/ into extension/.output/)
//   node release-kit/package.mjs --dir DIR --out DIR
//   node release-kit/package.mjs --check              (checks, writes nothing)
//   node release-kit/package.mjs --plain              (the sources as they are)
//   node release-kit/package.mjs --build N            (version <manifest>.N)
//   node release-kit/package.mjs --extra PRIVACY.md   (a file from outside the folder)
//   node release-kit/package.mjs --exclude 'docs/**'  (one more pattern left out)
//   node release-kit/package.mjs --name my-extension  (the zip's name; default from the manifest)
//
// The zip holds the folder's files except what is never loaded (dot
// folders and files, node_modules, scripts/, store-assets/, test/, tests/,
// e2e/, README files, package.json and its lock, tsconfig files, *.test.js
// and *.map), with the manifest without its `key` (the store refuses a
// package that carries one and gives the item its own id), and the scripts
// minified: whitespace, comments and local names, which the store's code
// readability policy allows; nothing is obfuscated or encrypted, which it
// forbids and reviewers reject. The zip is the same bytes for the same
// files and the same esbuild: entries sorted, one fixed date, no extra
// fields, no source map. --build N stamps the zip's manifest with one more
// integer, the way a build from a branch is released, without touching the
// folder.
//
// Node's standard library, plus esbuild for the minifying, run as a tool
// (ESBUILD_VERSION, through npx or the RELEASE_KIT_ESBUILD variable) and
// never a dependency of the extension; --plain packages the sources as
// they are. An extension with a build step of its own (WXT, Vite) makes
// its zip with that; stamp.mjs then does the rest.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkManifest, manifestBytes, pngSize, sha256, slug, sortedEntries, storeManifest, zip, zipName } from './lib.mjs';

export { zip, unzip, stampVersion, checkManifest } from './lib.mjs';

// Left out of every package: what Chrome never loads from an unpacked
// folder kept in a repository, matched against the path inside the folder
// (the README lists these; --exclude adds to them, nothing takes away).
export const EXCLUDED_DIRS = ['node_modules', 'store-assets', 'test', 'tests', 'e2e'];
export const EXCLUDED_FILES = [/^README(\..*)?$/i, /^package(-lock)?\.json$/, /^tsconfig.*\.json$/, /\.test\.js$/, /\.map$/];

// A pattern as --exclude takes it: * within a name, ** across folders, ?
// one character; anchored to the whole path inside the folder.
export function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { out += '.*'; i += 1; if (pattern[i + 1] === '/') i += 1; }
    else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function excluded(name, patterns = []) {
  const parts = name.split('/');
  if (parts.some(p => p.startsWith('.'))) return true;
  if (parts.length > 1 && EXCLUDED_DIRS.includes(parts[0])) return true;
  if (parts.includes('node_modules')) return true;
  if (EXCLUDED_FILES.some(re => re.test(parts[parts.length - 1]))) return true;
  return patterns.some(re => re.test(name));
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// The relative specifier of an import line, or of an export ... from
// line. A quoted string elsewhere in the code (`export const EXT =
// '.js'`) is no import, and the scan stops at a quote or a semicolon, so
// it never reaches one on a later line; an import that spans lines is
// still read.
export const IMPORT_RE = /^\s*(?:import\s*(?:[^'";]*?\bfrom\s*)?|export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}'"]*\})\s*from\s*)['"](\.[^'"]+)['"]/gm;

// The files a page loads: a script's src, a link's href, an image's src,
// each resolved from the page's folder (a leading slash is the package's
// root); what another site serves is not the package's.
export const PAGE_RE = /<(?:script|link|img)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"']+)["']/gi;

export function pageReferences(html, page) {
  const out = [];
  for (const m of String(html).matchAll(PAGE_RE)) {
    const ref = m[1].split('?')[0].split('#')[0];
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) continue;
    out.push(ref.startsWith('/') ? ref.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(page), ref)));
  }
  return out;
}

// Every file the manifest names, so a typo there is caught here rather
// than by the store's upload. Patterns (web_accessible_resources may hold
// globs) are skipped.
export function referenced(manifest) {
  const out = [];
  const add = value => { if (typeof value === 'string' && value && !/[*?]/.test(value)) out.push(value.replace(/^\//, '').split('?')[0].split('#')[0]); };
  for (const file of Object.values(manifest.icons || {})) add(file);
  const action = manifest.action || {};
  // One icon for every size is a string, not a map of sizes.
  for (const file of typeof action.default_icon === 'string' ? [action.default_icon] : Object.values(action.default_icon || {})) add(file);
  add(action.default_popup);
  add(manifest.background && manifest.background.service_worker);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) add(file);
    for (const file of script.css || []) add(file);
  }
  add(manifest.side_panel && manifest.side_panel.default_path);
  add(manifest.options_page);
  add(manifest.options_ui && manifest.options_ui.page);
  add(manifest.devtools_page);
  for (const file of Object.values(manifest.chrome_url_overrides || {})) add(file);
  for (const page of manifest.sandbox && manifest.sandbox.pages || []) add(page);
  for (const rules of manifest.declarative_net_request && manifest.declarative_net_request.rule_resources || []) add(rules.path);
  for (const entry of manifest.web_accessible_resources || []) for (const file of entry.resources || []) add(file);
  if (manifest.default_locale) out.push(`_locales/${manifest.default_locale}/messages.json`);
  return out;
}

// The package's files as a sorted [name, bytes] list, with the store
// manifest, and every problem found; an empty list means it can be built.
export function collect({ dir, build = null, extra = [], exclude = [] } = {}) {
  const problems = [];
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { files: [], manifest: null, problems: [`${manifestPath} is missing`] };
  let source;
  try { source = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { return { files: [], manifest: null, problems: [`${manifestPath} is not JSON (${e.message})`] }; }
  const patterns = exclude.map(globToRegExp);
  const files = new Map();
  for (const name of walk(dir)) {
    if (name === 'manifest.json' || excluded(name, patterns)) continue;
    files.set(name, fs.readFileSync(path.join(dir, name)));
  }
  for (const spec of extra) {
    const at = spec.lastIndexOf(':');
    const from = at > 1 ? spec.slice(0, at) : spec;
    const name = at > 1 ? spec.slice(at + 1) : path.basename(from);
    if (fs.existsSync(from)) files.set(name, fs.readFileSync(from));
    else problems.push(`${from} (--extra) is missing`);
  }
  const store = storeManifest(source, { build });
  problems.push(...store.problems);
  files.set('manifest.json', manifestBytes(store.manifest));
  for (const file of referenced(source)) {
    if (!files.has(file)) problems.push(`the manifest names ${file}, which is not in the package`);
  }
  // A file a page loads must be in the package too, like one the manifest
  // names; a folder left out above would otherwise vanish in silence.
  for (const [name, bytes] of files) {
    if (!/\.html?$/.test(name)) continue;
    for (const file of pageReferences(bytes.toString('utf8'), name)) {
      if (!files.has(file)) problems.push(`${name} loads ${file}, which is not in the package`);
    }
  }
  const icon = (source.action || {}).default_icon;
  for (const [key, file] of [...Object.entries(source.icons || {}), ...(typeof icon === 'string' ? [] : Object.entries(icon || {}))]) {
    const bytes = typeof file === 'string' && files.get(file.replace(/^\//, ''));
    const dims = bytes && pngSize(bytes);
    if (bytes && (!dims || dims[0] !== Number(key) || dims[1] !== Number(key))) problems.push(`${file} is not a ${key}x${key} PNG`);
  }
  if (typeof icon === 'string' && files.has(icon.replace(/^\//, '')) && !pngSize(files.get(icon.replace(/^\//, '')))) problems.push(`${icon} is not a PNG`);
  // A module the package imports must be in the package too.
  for (const [name, bytes] of files) {
    if (!/\.m?js$/.test(name)) continue;
    for (const m of bytes.toString('utf8').matchAll(IMPORT_RE)) {
      const target = path.posix.join(path.posix.dirname(name), m[1]);
      if (!files.has(target)) problems.push(`${name} imports ${m[1]}, which is not in the package`);
    }
  }
  return { files: sortedEntries(files), manifest: store.manifest, problems };
}

// ------------------------------------------------------------------ minify

// One esbuild, pinned, so the same sources give the same bytes on every
// machine. RELEASE_KIT_ESBUILD names an installed binary; otherwise npx
// fetches this version.
export const ESBUILD_VERSION = '0.25.11';
export const MINIFY_ARGS = ['--minify', '--charset=ascii', '--legal-comments=none', '--log-level=warning'];

export function esbuildCommand(env = process.env) {
  if (env.RELEASE_KIT_ESBUILD) return { command: env.RELEASE_KIT_ESBUILD, args: [] };
  return { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['-y', `esbuild@${ESBUILD_VERSION}`] };
}

// The syntax esbuild may emit: what the manifest's minimum Chrome runs,
// else a conservative year.
export function minifyTarget(manifest) {
  const min = manifest && String(manifest.minimum_chrome_version || '').split('.')[0];
  return /^\d+$/.test(min) ? `chrome${min}` : 'es2022';
}

// Minifies each script on its own, no bundling: file names, imports
// between modules and the top-level names of classic scripts all stay.
// On Windows the command goes through cmd.exe (npx is npx.cmd), which
// splits at spaces and gets no quotes from Node, so a path with one (a
// temp folder under a user name with a space) is quoted here.
export function shellArgs(args, shell) {
  return shell ? args.map(a => (/\s/.test(a) ? `"${a}"` : a)) : args;
}

export function runEsbuild(inputs, inDir, outDir, target, env = process.env) {
  const { command, args } = esbuildCommand(env);
  const shell = process.platform === 'win32';
  const [cmd, ...rest] = shellArgs([command, ...args, ...MINIFY_ARGS, `--target=${target}`, `--outbase=${inDir}`, `--outdir=${outDir}`, ...inputs], shell);
  execFileSync(cmd, rest, { stdio: ['ignore', 'inherit', 'inherit'], shell, env });
}

// Replaces the .js entries of a collected file list with their minified
// bytes; everything else passes through untouched. `run` is injected so
// the tests use a stand-in and open no process.
export function minify(files, { run = runEsbuild, target = 'es2022' } = {}) {
  const problems = [];
  const scripts = files.filter(([name]) => /\.js$/.test(name));
  if (!scripts.length) return { files, problems };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'release-kit-minify-'));
  try {
    const inDir = path.join(work, 'in');
    const outDir = path.join(work, 'out');
    for (const [name, bytes] of scripts) {
      const file = path.join(inDir, ...name.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    fs.mkdirSync(outDir, { recursive: true });
    try {
      run(scripts.map(([name]) => path.join(inDir, ...name.split('/'))), inDir, outDir, target);
    } catch (e) {
      problems.push(`esbuild did not run (${e && e.message ? e.message.split('\n')[0] : e}); install esbuild ${ESBUILD_VERSION} and set RELEASE_KIT_ESBUILD, let npx fetch it, or pass --plain`);
      return { files, problems };
    }
    const out = [];
    for (const [name, bytes] of files) {
      if (!scripts.some(([s]) => s === name)) { out.push([name, bytes]); continue; }
      const file = path.join(outDir, ...name.split('/'));
      if (!fs.existsSync(file)) { problems.push(`esbuild wrote no ${name}`); out.push([name, bytes]); continue; }
      const minified = fs.readFileSync(file);
      if (!minified.length) problems.push(`esbuild wrote an empty ${name}`);
      out.push([name, minified]);
    }
    return { files: out, problems };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ the command

export function parseArgs(argv) {
  const opts = { dir: 'extension', out: null, name: null, build: null, extra: [], exclude: [], plain: false, check: false, help: false };
  const value = i => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') opts.dir = value(i++);
    else if (a === '--out') opts.out = value(i++);
    else if (a === '--name') opts.name = value(i++);
    else if (a === '--build') opts.build = value(i++);
    else if (a === '--extra') opts.extra.push(value(i++));
    else if (a === '--exclude') opts.exclude.push(value(i++));
    else if (a === '--plain') opts.plain = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

export const USAGE = [
  'usage: node release-kit/package.mjs [--dir DIR] [--out DIR] [--name NAME] [--build N] [--extra FILE[:NAME]]... [--exclude PATTERN]... [--plain] [--check]',
  '',
  '  --dir DIR         the folder Chrome loads unpacked (default extension)',
  '  --out DIR         where the zip and its .sha256 go (default <dir>/.output)',
  '  --name NAME       the zip is NAME-<version>-chrome.zip (default: the manifest\'s name, lower case, dashes)',
  '  --build N         stamp the zip\'s manifest with version <manifest>.N; the folder is not touched',
  '  --extra FILE      a file from outside the folder, at its own name or FILE:NAME',
  '  --exclude PATTERN one more pattern left out (* within a name, ** across folders)',
  '  --plain           the sources as they are, not minified',
  '  --check           check and say what would be built; write nothing',
].join('\n');

export function main(argv, { log = console.log, error = console.error, env = process.env } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { error(e.message); error(USAGE); return 2; }
  if (opts.help) { log(USAGE); return 0; }
  const dir = path.resolve(opts.dir);
  const outDir = path.resolve(opts.out || path.join(dir, '.output'));
  const collected = collect({ dir, build: opts.build, extra: opts.extra, exclude: opts.exclude });
  const manifest = collected.manifest;
  const problems = [...collected.problems];
  let files = collected.files;
  if (!problems.length && !opts.plain) {
    const result = minify(files, { target: minifyTarget(manifest), run: (inputs, inDir, out, target) => runEsbuild(inputs, inDir, out, target, env) });
    files = result.files;
    problems.push(...result.problems);
  }
  if (problems.length) {
    for (const p of problems) error(`problem: ${p}`);
    return 1;
  }
  const bytes = zip(files);
  const sha = sha256(bytes);
  const name = opts.name || slug(manifest.name);
  const how = opts.plain ? 'plain' : `minified with esbuild ${ESBUILD_VERSION}`;
  if (opts.check) {
    log(`ok: ${files.length} files, ${bytes.length} bytes, version ${manifest.version}, ${how}`);
    for (const [entry, data] of files) log(`  ${String(data.length).padStart(7)}  ${entry}`);
    return 0;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, zipName(name, manifest.version));
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(`${file}.sha256`, `${sha}  ${path.basename(file)}\n`);
  log(`${path.relative(process.cwd(), file) || file}`);
  log(`  ${files.length} files, ${bytes.length} bytes, version ${manifest.version}, ${how}`);
  log(`  sha256 ${sha}`);
  for (const [entry, data] of files) log(`  ${String(data.length).padStart(7)}  ${entry}`);
  return 0;
}

// The tests import this module, so main() runs only when node was given
// this file; argv[1] is compared by its real path, since Node resolves the
// main module's symlinks for import.meta.url but keeps argv[1] as typed.
function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch (e) { return false; }
}

if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
