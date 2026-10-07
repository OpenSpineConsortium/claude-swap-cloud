// Turns the zip an extension's build wrote into the files a release
// carries: the zip at the version this release has, under its versioned
// name and under a fixed name, each with its SHA-256.
//
//   node release-kit/stamp.mjs --zip PATH --out DIR --build N          (a build from a branch)
//   node release-kit/stamp.mjs --zip PATH --out DIR --tag extension-v1.2.0   (a tag)
//   node release-kit/stamp.mjs --zip PATH --out DIR                    (the version as built)
//
// The zip can come from any build (this kit's package.mjs, `wxt zip`, a
// hand-made one): only its manifest.json is read. With --build N the
// manifest's version gets N as one more integer, the way a push to the
// default branch is released, unless the build stamped it already; with
// --tag the tag must name the manifest's exact version, which is kept. The
// manifest's `key`, if any, is dropped, since the store refuses a package
// that carries one. A zip whose manifest needs no change is copied byte
// for byte; one that does is written again with the same files (entries
// sorted, one fixed date), so the same input gives the same bytes.
//
// Everything found goes to stdout as name=value lines, one per line and
// nothing else, so a workflow step can append the output to
// $GITHUB_OUTPUT; what is said to a person goes to stderr.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayName, fixedName, isVersion, manifestBytes, sha256, sha256Line, slug, sortedEntries, storeManifest, unzip, zip, zipName } from './lib.mjs';

export const DEFAULT_TAG_PREFIX = 'extension-v';

export function parseArgs(argv) {
  const opts = { zip: null, out: null, name: null, build: null, tag: null, tagPrefix: DEFAULT_TAG_PREFIX, help: false };
  const value = i => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--zip') opts.zip = value(i++);
    else if (a === '--out') opts.out = value(i++);
    else if (a === '--name') opts.name = value(i++);
    else if (a === '--build') opts.build = value(i++);
    else if (a === '--tag') opts.tag = value(i++);
    else if (a === '--tag-prefix') opts.tagPrefix = value(i++);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (opts.help) return opts;
  if (!opts.zip) throw new Error('--zip PATH is required');
  if (!opts.out) throw new Error('--out DIR is required');
  if (opts.build !== null && opts.tag !== null) throw new Error('--build and --tag do not go together: a tag names the version it releases');
  return opts;
}

export const USAGE = [
  'usage: node release-kit/stamp.mjs --zip PATH --out DIR [--name NAME] [--build N | --tag TAG [--tag-prefix PREFIX]]',
  '',
  '  --zip PATH          the zip the build wrote',
  '  --out DIR           where the release files go: NAME-<version>-chrome.zip, NAME-chrome.zip and their .sha256',
  '  --name NAME         the file name (default: the manifest\'s name, lower case, dashes)',
  '  --build N           release version <manifest>.N (kept as is when the build stamped it already)',
  '  --tag TAG           the tag being released; must be PREFIX plus the manifest\'s exact version',
  '  --tag-prefix PREFIX default extension-v',
].join('\n');

// The release: the files to write and what to report, or the problems
// that stop it. Pure, so the tests hand in bytes and read bytes back.
export function plan(bytes, { name = null, build = null, tag = null, tagPrefix = DEFAULT_TAG_PREFIX } = {}) {
  let entries;
  try { entries = unzip(bytes); } catch (e) { return { problems: [e.message] }; }
  const original = entries.get('manifest.json');
  if (!original) return { problems: ['the zip has no manifest.json at its root'] };
  let source;
  try { source = JSON.parse(original.toString('utf8')); } catch (e) { return { problems: [`the zip's manifest.json is not JSON (${e.message})`] }; }
  if (!source || typeof source !== 'object' || !isVersion(source.version)) return { problems: [`the zip's manifest has no usable version (${JSON.stringify(source && source.version)})`] };
  const problems = [];
  if (tag !== null) {
    if (!tag.startsWith(tagPrefix)) problems.push(`the tag ${tag} does not start with ${tagPrefix}: tag the release ${tagPrefix}${source.version} instead`);
    else if (tag.slice(tagPrefix.length) !== source.version) problems.push(`the tag ${tag} does not match the manifest's version ${source.version}: tag ${tagPrefix}${source.version} instead, or raise the manifest's version to ${tag.slice(tagPrefix.length)}`);
  }
  const store = storeManifest(source, { build });
  problems.push(...store.problems);
  // A localized name is a message; the release's title needs the words.
  const shown = displayName(source, entries);
  const title = shown !== null ? shown : name;
  if (title === null) problems.push(`the manifest's name ${source.name} is a message and the zip has no _locales/${source.default_locale || ''}/messages.json with it; pass --name for the title`);
  if (problems.length) return { problems };
  const same = JSON.stringify(store.manifest) === JSON.stringify(source);
  let out = bytes;
  if (!same) {
    entries.set('manifest.json', manifestBytes(store.manifest));
    out = zip(sortedEntries(entries));
  }
  const base = name || slug(title);
  const version = store.manifest.version;
  return {
    problems: [],
    bytes: out,
    rewritten: !same,
    name: base,
    version,
    tag: `${tagPrefix}${version}`,
    title: String(title).replace(/[\r\n]+/g, ' ').trim(),
    zipName: zipName(base, version),
    fixedName: fixedName(base),
    sha256: sha256(out),
  };
}

export function main(argv, { log = console.log, say = console.error } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { say(e.message); say(USAGE); return 2; }
  if (opts.help) { log(USAGE); return 0; }
  let bytes;
  try { bytes = fs.readFileSync(opts.zip); } catch (e) { say(`Cannot read ${opts.zip}: ${e.message}`); return 1; }
  const made = plan(bytes, { name: opts.name, build: opts.build, tag: opts.tag, tagPrefix: opts.tagPrefix });
  if (made.problems.length) {
    for (const p of made.problems) say(`problem: ${p}`);
    return 1;
  }
  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  const versioned = path.join(outDir, made.zipName);
  const fixed = path.join(outDir, made.fixedName);
  fs.writeFileSync(versioned, made.bytes);
  fs.writeFileSync(`${versioned}.sha256`, sha256Line(made.bytes, made.zipName));
  fs.writeFileSync(fixed, made.bytes);
  fs.writeFileSync(`${fixed}.sha256`, sha256Line(made.bytes, made.fixedName));
  say(`${made.title} ${made.version}: ${made.zipName} (${made.bytes.length} bytes, ${made.rewritten ? 'manifest written again' : 'the build\'s bytes'}), also as ${made.fixedName}`);
  say(`  sha256 ${made.sha256}`);
  for (const [key, value] of Object.entries({
    name: made.name, version: made.version, tag: made.tag, title: made.title, dir: outDir,
    zip: versioned, zipname: made.zipName, fixed, fixedname: made.fixedName, sha256: made.sha256,
  })) log(`${key}=${value}`);
  return 0;
}

function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch (e) { return false; }
}

if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
