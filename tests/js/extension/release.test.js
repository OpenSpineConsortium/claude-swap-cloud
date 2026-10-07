// How this repository releases its extension: release.yml calls the
// release kit's workflow with this repository's own packager, the five
// CWS_ secrets reach the kit's store step and no further, and the
// README's link resolves to what the release attaches. The kit's own
// behaviour is tested under release-kit/tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('release.yml is one call of the kit\'s workflow, with this repository\'s packager', () => {
  const yml = read('.github', 'workflows', 'release.yml');
  assert.ok(yml.includes('uses: ./.github/workflows/release-kit.yml'), 'the kit\'s workflow, from this commit');
  for (const name of ['CWS_PUBLISHER_ID', 'CWS_ITEM_ID', 'CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN']) {
    assert.equal(yml.split(`      ${name}: \${{ secrets.${name} }}`).length, 2, `${name} reaches the kit by name, once`);
  }
  assert.ok(!yml.includes('secrets: inherit'), 'the kit gets the five store secrets and nothing else');
  assert.ok(yml.includes('on-push: ${{ vars.CWS_ON_PUSH }}'), 'the repository variable decides what a push does');
  assert.ok(yml.includes('build: CSWAP_ESBUILD=esbuild node extension/scripts/package.mjs'), 'the zip is this repository\'s packager\'s');
  assert.ok(yml.includes('zip: extension/.output/claude-swap-cloud-*-chrome.zip'), 'the zip is named, not guessed');
  assert.ok(yml.includes('name: claude-swap-cloud'), 'the release files keep their names');
  assert.ok(yml.includes('test: CSWAP_ESBUILD=esbuild node --test "tests/js/extension/*.test.js"'), 'the extension is tested first');
  assert.ok(yml.includes("tags: ['extension-v*']"), 'a tag starts a release');
  assert.ok(yml.includes('branches: [main]'), 'a push to main starts one');
  assert.ok(/permissions:\n  contents: write/.test(yml), 'the release needs to write');
  assert.ok(/concurrency:\n  group: chrome-web-store\n  cancel-in-progress: false/.test(yml), 'store calls never overlap');
  for (const part of ["- 'release-kit/*.mjs'", "- 'release-kit/action.yml'", "- 'release-kit/store/**'", "- '.github/workflows/release-kit.yml'"]) assert.ok(yml.includes(part), `a change to ${part} is released too`);
  assert.ok(!yml.includes("- 'release-kit/**'"), 'the kit\'s README, template and tests release nothing');
  assert.ok(yml.includes('upload: ${{ inputs.upload == true }}') && yml.includes('publish: ${{ inputs.publish == true }}'));
  assert.ok(!yml.includes('run:'), 'nothing runs here but the kit');
  const readme = read('README.md');
  assert.ok(readme.includes('https://github.com/OpenSpineConsortium/claude-swap-cloud/releases/latest/download/claude-swap-cloud-chrome.zip'), 'the README links the newest build');
  assert.ok(!yml.includes('trusted-testers'), 'V2 has no publish target; visibility is the item\'s own setting');
  // PyPI is reached from a tag v<version> alone, never from a release, so
  // the extension's releases (extension-v<version>) never go there.
  const pypi = read('.github', 'workflows', 'publish.yml');
  assert.ok(/^on:\n  push:\n    tags: \['v\*'\]\n  workflow_dispatch:\n/m.test(pypi), 'a tag v<version>, or Run workflow for a look');
  assert.ok(!/^\s*release:/m.test(pypi) && !pypi.includes('github.event.release'), 'an extension release never goes to PyPI');
  assert.ok(pypi.includes("if: startsWith(github.ref, 'refs/tags/v')"), 'the publish job runs for a tag alone');
  assert.ok(pypi.includes('environment:\n      name: pypi') && pypi.includes('id-token: write'), 'trusted publishing through the pypi environment, no token');
  assert.ok(!pypi.includes('--sdist') && !pypi.includes('python -m build'), 'no source distribution is built');
});

test('ci.yml builds the same zip through the kit\'s actions on every pull request', () => {
  const yml = read('.github', 'workflows', 'ci.yml');
  const job = yml.slice(yml.indexOf('\n  extension-package:'), yml.indexOf('\n  test-windows:'));
  assert.ok(job.includes('uses: ./release-kit\n') && job.includes('uses: ./release-kit/store\n'), 'both actions, from this commit');
  assert.ok(job.includes('fetch-depth: 0'), 'the kit numbers the build by the commit count');
  assert.ok(job.includes('build: node extension/scripts/package.mjs') && job.includes('zip: extension/.output/claude-swap-cloud-*-chrome.zip'));
  assert.ok(job.includes('"release-kit/tests/*.test.js"'), 'the kit\'s suites run here too');
  assert.ok(!job.includes('secrets.'), 'the store step runs without secrets and says Not configured');
});
