// The kit's files agree with each other: the README's workflow is
// caller.yml, the reusable workflow passes what the actions take, the
// secrets reach one step and no further, and no expression sits inside a
// run block (a tag name or an input reaches the shell through env and
// quotes, never as shell source).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, '..');
const ROOT = path.resolve(KIT, '..');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const README = read(KIT, 'README.md');
const CALLER = read(KIT, 'caller.yml');
const WORKFLOW = read(ROOT, '.github', 'workflows', 'release-kit.yml');
const ACTION = read(KIT, 'action.yml');
const STORE = read(KIT, 'store', 'action.yml');
const SECRETS = ['CWS_PUBLISHER_ID', 'CWS_ITEM_ID', 'CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN'];

// The repository the kit lives in, read from the one line a caller
// names it on; the workflow's own lines are held to it, so moving the
// kit means changing them all together.
const HOME = (/^    uses: ([\w.-]+\/[\w.-]+)\/\.github\/workflows\/release-kit\.yml@main$/m.exec(CALLER) || [])[1];

// The run blocks of a workflow or action file, each as its text.
function runBlocks(yml) {
  return yml.split(/\n\s+run: \|\n/).slice(1).map(block => block.split(/\n\s+- (?:name|uses|id):/)[0].split(/\n\s{0,4}[a-z-]+:\n/)[0]);
}

// The inputs a YAML `inputs:` block declares, by their keys at one indent.
function declaredInputs(yml, indent) {
  const at = yml.indexOf('\ninputs:');
  const start = at >= 0 ? at : yml.indexOf('    inputs:\n');
  const block = yml.slice(start);
  const re = new RegExp(`^${' '.repeat(indent)}([a-z-]+):\\s*$`, 'gm');
  const out = [];
  let m;
  for (const line of block.split('\n')) {
    if (/^\S/.test(line) && out.length) break;
    if (indent === 6 && /^    [a-z]+:\s*$/.test(line) && !/^    inputs:/.test(line) && out.length) break;
    m = re.exec(line + '\n');
    re.lastIndex = 0;
    if (m) out.push(m[1]);
  }
  return out;
}

test('the README\'s workflow is caller.yml, word for word', () => {
  const start = README.indexOf('```yaml\n', README.indexOf('### 1. The workflow file'));
  const end = README.indexOf('\n```\n', start);
  assert.ok(start > 0 && end > start);
  assert.equal(README.slice(start + '```yaml\n'.length, end + 1), CALLER);
});

test('caller.yml calls the reusable workflow with inputs it declares, and passes the five secrets by name', () => {
  assert.ok(HOME, 'caller.yml names the kit\'s repository on its uses: line');
  assert.ok(!CALLER.includes('secrets: inherit'), 'the kit gets the store secrets and nothing else of the caller\'s');
  for (const name of SECRETS) assert.equal(CALLER.split(`      ${name}: \${{ secrets.${name} }}`).length, 2, `${name} is passed once`);
  assert.ok(CALLER.includes('on-push: ${{ vars.CWS_ON_PUSH }}'), 'the variable is passed in, since the called workflow cannot be sure of the caller\'s vars');
  assert.ok(CALLER.includes('upload: ${{ inputs.upload == true }}') && CALLER.includes('publish: ${{ inputs.publish == true }}'), 'a push, with no dispatch inputs, still passes a boolean');
  assert.ok(/permissions:\n  contents: write/.test(CALLER), 'the release needs to write');
  assert.ok(/concurrency:\n  group: chrome-web-store\n  cancel-in-progress: false/.test(CALLER), 'store calls never overlap');
  assert.ok(CALLER.includes("tags: ['extension-v*']") && CALLER.includes('branches: [main]'));
  const workflowInputs = declaredInputs(WORKFLOW, 6);
  for (const name of ['name', 'dir', 'build', 'zip', 'setup', 'test', 'extra', 'node-version', 'tag-prefix', 'release', 'on-push', 'upload', 'publish']) {
    assert.ok(workflowInputs.includes(name), `the workflow declares ${name}`);
  }
  const passed = [...CALLER.slice(CALLER.indexOf('    with:')).matchAll(/^      ([a-z-]+):/gm)].map(m => m[1]);
  for (const name of passed) assert.ok(workflowInputs.includes(name), `caller.yml passes ${name}, which the workflow declares`);
});

test('the reusable workflow runs the kit from its repository at main, or the checkout\'s own copy there, and passes what the actions take', () => {
  assert.ok(WORKFLOW.includes(`uses: ${HOME}/release-kit@main`));
  assert.ok(WORKFLOW.includes(`uses: ${HOME}/release-kit/store@main`));
  const packageJob = WORKFLOW.slice(WORKFLOW.indexOf('\n  package:'), WORKFLOW.indexOf('\n  store:'));
  const storeJob = WORKFLOW.slice(WORKFLOW.indexOf('\n  store:'));
  // A called workflow reaches a relative path only in the caller's
  // checkout, so the checkout's copy runs in the kit's repository alone
  // and every other repository takes main's; the two steps are twins.
  const kitSteps = packageJob.split(/\n      - /).slice(1).filter(step => /uses: .*release-kit/.test(step));
  assert.equal(kitSteps.length, 2, 'one step for the kit\'s repository, one for every other');
  const [here, elsewhere] = kitSteps;
  assert.ok(here.includes('uses: ./release-kit\n') && here.includes(`if: github.repository == '${HOME}'`), 'the checkout\'s copy runs only in the kit\'s repository');
  assert.ok(elsewhere.includes(`uses: ${HOME}/release-kit@main`) && elsewhere.includes(`if: github.repository != '${HOME}'`), 'every other repository takes the kit from main');
  const withKeys = step => [...step.matchAll(/^          ([a-z-]+):/gm)].map(m => m[1]);
  assert.deepEqual(withKeys(here), withKeys(elsewhere), 'both steps pass the same inputs');
  const actionInputs = declaredInputs(ACTION, 2);
  for (const key of withKeys(here)) assert.ok(actionInputs.includes(key), `the package action takes ${key}`);
  const ids = kitSteps.map(step => /\bid: ([a-z]+)/.exec(step)[1]);
  for (const out of ['name', 'version', 'tag', 'zipname', 'sha256']) {
    assert.ok(packageJob.includes(`${out}: \${{ steps.${ids[0]}.outputs.${out} || steps.${ids[1]}.outputs.${out} }}`), `the job's ${out} comes from whichever step ran`);
  }
  assert.ok(!storeJob.includes('uses: ./'), 'the store job never runs on a pull request, so it has no local twin');
  const storeInputs = declaredInputs(STORE, 2);
  const storeStep = WORKFLOW.slice(WORKFLOW.indexOf('release-kit/store@main'));
  for (const m of storeStep.matchAll(/^          ([a-z-]+):/gm)) assert.ok(storeInputs.includes(m[1]), `the store action takes ${m[1]}`);
  // The package job has no gate; the store job is the one on-push gates.
  assert.ok(!/\n    if:/.test(packageJob));
  assert.ok(/\n    if: .*inputs\.on-push == 'upload'.*inputs\.on-push == 'publish'/.test(storeJob));
  assert.ok(/startsWith\(github\.ref, 'refs\/tags\/'\)/.test(storeJob), 'a tag always goes to the store');
  assert.ok(packageJob.includes('fetch-depth: 0'), 'the commit count needs the whole history');
  assert.ok(packageJob.includes("release: ${{ inputs.release && (github.event_name == 'push' || inputs.upload) }}"));
});

test('the five secrets reach the store action\'s one step, once each, and are never echoed', () => {
  const declared = WORKFLOW.slice(WORKFLOW.indexOf('    secrets:\n'), WORKFLOW.indexOf('    outputs:\n'));
  for (const name of SECRETS) {
    assert.ok(declared.includes(`      ${name}:\n        required: false`), `${name} is declared, optional`);
    assert.equal(WORKFLOW.split(`secrets.${name}`).length, 2, `${name} is read once in the workflow`);
    assert.ok(WORKFLOW.indexOf(`secrets.${name}`) > WORKFLOW.indexOf('release-kit/store@main'), `${name} goes to the store step`);
  }
  const step = STORE.indexOf('- name: Upload to the Chrome Web Store');
  const runAt = STORE.indexOf('run: |', step);
  assert.ok(step > 0 && runAt > step);
  for (const [name, input] of [['CWS_PUBLISHER_ID', 'publisher-id'], ['CWS_ITEM_ID', 'item-id'], ['CWS_CLIENT_ID', 'client-id'], ['CWS_CLIENT_SECRET', 'client-secret'], ['CWS_REFRESH_TOKEN', 'refresh-token']]) {
    const at = STORE.indexOf(`${name}: \${{ inputs.${input} }}`);
    assert.ok(at > step && at < runAt, `${name} is set on the one step from the ${input} input`);
  }
  assert.ok(STORE.includes('--if-configured'), 'a repository without the secrets stays green');
  for (const yml of [WORKFLOW, ACTION, STORE, CALLER]) {
    assert.ok(!/echo[^\n]*(secrets\.|CWS_)/.test(yml), 'no secret is echoed');
  }
});

test('no expression inside a run block, in the actions or the workflow', () => {
  for (const [file, yml] of [['release-kit.yml', WORKFLOW], ['action.yml', ACTION], ['store/action.yml', STORE]]) {
    const blocks = runBlocks(yml);
    assert.ok(blocks.length > 0 || file === 'release-kit.yml', `${file} has run blocks`);
    for (const body of blocks) assert.ok(!body.includes('${{'), `${file}: an expression inside a run block: ${body.slice(0, 80)}`);
  }
  // The scripts are called from the action's own folder, so a caller's
  // checkout never has to hold them.
  assert.ok(ACTION.includes('"$GITHUB_ACTION_PATH/package.mjs"') && ACTION.includes('"$GITHUB_ACTION_PATH/stamp.mjs"'));
  assert.ok(STORE.includes('"$GITHUB_ACTION_PATH/publish.mjs"'));
  assert.ok(ACTION.includes('gh release view') && ACTION.includes('--clobber'), 'a re-run does not fail on the release that exists');
  assert.ok(!ACTION.includes('gh release edit'), 'a re-run leaves which release is latest alone');
  assert.ok(ACTION.includes('--latest="$LATEST"'));
  assert.ok(ACTION.includes('is-shallow-repository'), 'a shallow checkout is refused rather than miscounted');
});

test('the README names every input and the pinned esbuild', async () => {
  for (const name of declaredInputs(ACTION, 2)) assert.ok(README.includes(`\`${name}\``), `README names ${name}`);
  for (const name of declaredInputs(STORE, 2)) assert.ok(README.includes(`\`${name}\``) || SECRETS.some(s => README.includes(s)), `README names ${name}`);
  const pkg = await import(pathToFileURL(path.join(KIT, 'package.mjs')).href);
  assert.ok(README.includes(`esbuild ${pkg.ESBUILD_VERSION}`), 'the README names the esbuild the packager pins');
  for (const [file, text] of [['README.md', README], ['caller.yml', CALLER], ['action.yml', ACTION], ['store/action.yml', STORE], ['lib.mjs', read(KIT, 'lib.mjs')], ['package.mjs', read(KIT, 'package.mjs')], ['stamp.mjs', read(KIT, 'stamp.mjs')], ['store/publish.mjs', read(KIT, 'store', 'publish.mjs')]]) {
    assert.ok(!/[^\x00-\x7f]/.test(text) && !text.includes('\r'), `${file} is plain ASCII with LF endings`);
    assert.ok(!/cswap-import|cswap project import|(?<!OpenSpineConsortium\/)claude-swap-cloud|Claude Swap Cloud|claude\.ai/.test(text) || file === 'README.md', `${file} names nothing of this extension`);
  }
});
