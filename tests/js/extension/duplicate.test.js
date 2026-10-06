// duplicate.js: the Duplicate's pure pieces, which the panel and the worker
// share: the project's page, what the page helper is told, how the page's
// listing and the bridge's account list are shaped for the panel, which
// account is offered first, the hand-over texts and the panel's view.
//
//   node --test tests/js/extension/duplicate.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', '..', 'extension', 'src');
const dup = await import(pathToFileURL(path.join(SRC, 'duplicate.js')).href);
const protocol = await import(pathToFileURL(path.join(SRC, 'protocol.js')).href);

const ORG = 'dddddddd-0000-4000-8000-000000000001';
const CODE = { id: 'chan_01BEETHOVENBEETHOVEN0000', name: 'beethoven', kind: 'code', orgUuid: ORG, orgName: 'Personal', archived: false };
const RECIPES = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Recipes', kind: 'standard', orgUuid: ORG, orgName: 'Personal', archived: false };
const ACCOUNTS = [
  { slot: '1', email: 'a@example.com', organization: 'Personal', alias: '', kind: 'oauth', usable: true },
  { slot: '2', email: 'b@example.com', organization: 'Beethoven Org', alias: 'work', kind: 'oauth', usable: true },
  { slot: '3', email: '', organization: '', alias: '', kind: 'api_key', usable: false, why: 'an API key, not a claude.ai sign-in' },
];

test('the capability and the text for a cswap without it', () => {
  assert.equal(dup.DUPLICATE_CAPABILITY, 'duplicate');
  assert.match(dup.NO_DUPLICATE_TEXT, /uv tool upgrade claude-swap/);
  assert.match(dup.NO_DUPLICATE_TEXT, /pipx upgrade claude-swap/);
});

test('projectUrl: the project page by kind, the front page for anything else', () => {
  assert.equal(dup.projectUrl(CODE), `${protocol.CLAUDE_URL_PREFIX}code/project/${CODE.id}`);
  assert.equal(dup.projectUrl(RECIPES), `${protocol.CLAUDE_URL_PREFIX}project/${RECIPES.id}`);
  assert.equal(dup.projectUrl({ id: 'a b/c', kind: 'standard' }), `${protocol.CLAUDE_URL_PREFIX}project/a%20b%2Fc`);
  for (const bad of [null, {}, { id: '' }, { id: 7 }, 'x']) assert.equal(dup.projectUrl(bad), protocol.CLAUDE_URL_PREFIX);
});

test('bootProject: what the page helper is told, from either spelling of the organization', () => {
  assert.deepEqual(dup.bootProject(CODE), { id: CODE.id, name: 'beethoven', kind: 'code', orgUuid: ORG, orgName: 'Personal' });
  assert.deepEqual(dup.bootProject({ id: 'p', name: 'n', kind: 'standard', org_uuid: 'o', org_name: 'Org' }), { id: 'p', name: 'n', kind: 'standard', orgUuid: 'o', orgName: 'Org' });
  assert.equal(dup.bootProject({ id: 'p', kind: 'other' }).kind, 'standard');
  assert.equal(dup.bootProject({ id: 'p' }).name, '');
  for (const bad of [null, {}, { id: '' }, { name: 'x' }]) assert.equal(dup.bootProject(bad), null);
});

test('projectChoices: checked, deduplicated, the tab\'s project first, then by name', () => {
  const found = {
    projects: [RECIPES, { ...RECIPES }, CODE, { id: 'x', name: '', kind: 'standard', orgUuid: ORG, orgName: 'Personal', archived: true }, null, { id: 7 }],
    orgs: [{ uuid: ORG, name: 'Personal', apiOnly: false, error: null }, { uuid: 'api-org', name: 'API', apiOnly: true, error: 'HTTP 403' }, { name: 'no uuid' }],
    here: { id: CODE.id, kind: 'code' },
    error: null,
  };
  const choices = dup.projectChoices(found);
  assert.deepEqual(choices.projects.map(p => p.name), ['beethoven', '(unnamed project)', 'Recipes']);
  assert.equal(choices.projects[1].archived, true);
  assert.deepEqual(choices.here, { id: CODE.id, kind: 'code' });
  assert.deepEqual(choices.orgs.map(o => [o.uuid, o.apiOnly, o.error]), [[ORG, false, null], ['api-org', true, 'HTTP 403']]);
  assert.equal(choices.error, null);
  // A Claude Code workspace open in the tab that no listing returned is
  // still offered, as the export script would export it.
  const unlisted = dup.projectChoices({ projects: [RECIPES], orgs: [], here: { id: 'chan_01UNLISTED000000000000000', kind: 'code' } });
  assert.equal(unlisted.projects[0].id, 'chan_01UNLISTED000000000000000');
  assert.match(unlisted.projects[0].name, /^This tab's workspace/);
  assert.equal(unlisted.projects[1].name, 'Recipes');
  // A regular project page that is not listed is not invented.
  assert.deepEqual(dup.projectChoices({ projects: [], here: { id: 'p', kind: 'standard' } }).projects, []);
  // Nothing found, or nothing usable, is an empty list and the error kept.
  assert.deepEqual(dup.projectChoices(null), { projects: [], orgs: [], here: null, error: null });
  assert.equal(dup.projectChoices({ error: 'HTTP 500 from /api/organizations' }).error, 'HTTP 500 from /api/organizations');
});

test('accountChoices: the bridge\'s list with the line the panel shows', () => {
  const out = dup.accountChoices([...ACCOUNTS, { email: 'no-slot@example.com' }, null]);
  assert.deepEqual(out.map(a => a.slot), ['1', '2', '3']);
  assert.equal(out[0].label, 'Account-1: a@example.com, Personal');
  assert.equal(out[1].label, 'Account-2 (work): b@example.com, Beethoven Org');
  assert.equal(out[2].label, 'Account-3: no email (an API key, not a claude.ai sign-in)');
  assert.equal(out[2].usable, false);
  assert.equal(out[2].kind, 'api_key');
  assert.equal(out[0].kind, 'oauth');
  assert.deepEqual(dup.accountChoices(undefined), []);
});

test('defaultDestination: the first usable account that is not the one the project is in', () => {
  const accounts = dup.accountChoices(ACCOUNTS);
  assert.equal(dup.defaultDestination(accounts, 'a@example.com'), '2');
  assert.equal(dup.defaultDestination(accounts, 'A@Example.com '), '2');
  assert.equal(dup.defaultDestination(accounts, 'b@example.com'), '1');
  assert.equal(dup.defaultDestination(accounts, ''), '1');
  assert.equal(dup.defaultDestination(accounts.filter(a => a.slot === '1'), 'a@example.com'), '1', 'the same account when it is the only one');
  assert.equal(dup.defaultDestination(accounts.filter(a => a.slot === '3'), 'a@example.com'), '');
  assert.equal(dup.defaultDestination([], 'a@example.com'), '');
});

test('chainTexts: what the person reads when the export hands over, and the line when it cannot', () => {
  const job = {
    duplicate: { project: { id: CODE.id, name: 'beethoven', kind: 'code' }, destination: { slot: '2', email: 'b@example.com' } },
    export: { files: 9, path: 'C:\\Users\\greg\\exports\\beethoven' },
  };
  const texts = dup.chainTexts(job);
  assert.equal(texts.importing, 'Exported "beethoven" (9 files). Importing it into Account-2 (b@example.com).');
  assert.equal(texts.notImported, 'The export of "beethoven" is saved at C:\\Users\\greg\\exports\\beethoven, but its import into Account-2 (b@example.com) could not start.' +
    ' Import it by hand with: cswap project-move import --to 2 --folder "C:\\Users\\greg\\exports\\beethoven".');
  const one = dup.chainTexts({ duplicate: { destination: { slot: '1', email: 'a@example.com' } }, export: { files: 1, name: 'Recipes' } });
  assert.equal(one.importing, 'Exported "Recipes" (1 file). Importing it into Account-1 (a@example.com).');
  assert.match(one.notImported, /cswap project-move import --to 1\.$/);
  assert.match(dup.chainTexts(null).notImported, /The export of "the project" is saved, but its import into Account-\? \(\?\) could not start/);
});

test('duplicateView: nothing running offers the button; a choosing export shows the form', () => {
  const idle = dup.duplicateView(null);
  assert.equal(idle.canStart, true);
  assert.equal(idle.choosing, false);
  assert.match(idle.line, /^Copy a project from the signed-in account/);
  assert.deepEqual(idle.projects, []);
  assert.deepEqual(idle.accounts, []);
  assert.equal(idle.noAccounts, '');
  const ended = dup.duplicateView({ kind: 'import', phase: 'done' });
  assert.equal(ended.canStart, true);
  assert.equal(dup.duplicateView({ kind: 'import', phase: 'running' }).canStart, false);
  assert.equal(dup.duplicateView({ kind: 'import', phase: 'running' }).line, '');

  const found = dup.projectChoices({ projects: [RECIPES, CODE], orgs: [{ uuid: ORG, name: 'Personal' }], here: { id: CODE.id, kind: 'code' } });
  const choosing = dup.duplicateView({ kind: 'export', phase: 'choosing', account: { email: 'a@example.com' }, choices: found, accounts: dup.accountChoices(ACCOUNTS) });
  assert.equal(choosing.canStart, false);
  assert.equal(choosing.choosing, true);
  assert.equal(choosing.line, 'Duplicate: finding the projects a@example.com can see.');
  assert.deepEqual(choosing.projects, [
    { id: CODE.id, label: 'beethoven  [code]', selected: true },
    { id: RECIPES.id, label: 'Recipes', selected: false },
  ]);
  assert.deepEqual(choosing.accounts.map(a => [a.slot, a.disabled, a.selected]), [['1', false, false], ['2', false, true], ['3', true, false]]);
  assert.equal(choosing.hint, '');
  assert.equal(choosing.noAccounts, '');
  // With several organizations the project's own is shown; the first
  // project is selected when the tab shows none of them.
  const two = dup.projectChoices({ projects: [RECIPES, { ...CODE, orgUuid: 'other', orgName: 'Work' }], orgs: [{ uuid: ORG, name: 'Personal' }, { uuid: 'other', name: 'Work' }], here: null });
  const twoView = dup.duplicateView({ kind: 'export', phase: 'choosing', choices: two, accounts: dup.accountChoices(ACCOUNTS) });
  assert.deepEqual(twoView.projects.map(p => p.label), ['beethoven  [code]  (Work)', 'Recipes  (Personal)']);
  assert.deepEqual(twoView.projects.map(p => p.selected), [true, false]);
  // A listing that failed in part says so; one with nothing says that.
  const partial = dup.duplicateView({ kind: 'export', phase: 'choosing', choices: { ...found, error: 'HTTP 403' }, accounts: [] });
  assert.equal(partial.hint, 'Some projects could not be listed: HTTP 403');
  assert.match(partial.noAccounts, /cswap add/);
  const empty = dup.duplicateView({ kind: 'export', phase: 'choosing', choices: dup.projectChoices({}), accounts: dup.accountChoices(ACCOUNTS) });
  assert.equal(empty.hint, 'No project was found for this account.');
  assert.deepEqual(empty.projects, []);
});

test('duplicateView: the running export, the import after it, and an import that could not start', () => {
  const exporting = dup.duplicateView({
    kind: 'export', phase: 'running', account: { email: 'a@example.com' },
    duplicate: { project: { id: CODE.id, name: 'beethoven' }, destination: { slot: '2', email: 'b@example.com' } },
  });
  assert.equal(exporting.choosing, false);
  assert.equal(exporting.canStart, false);
  assert.equal(exporting.line, 'Duplicate: exporting "beethoven" from a@example.com for Account-2 (b@example.com).');
  const importing = dup.duplicateView({ kind: 'import', phase: 'running', duplicate: { export_job: 'job_x', source: { email: 'a@example.com', project: { id: CODE.id, name: 'beethoven' } } } });
  assert.equal(importing.line, 'Duplicate of "beethoven" from a@example.com, now importing.');
  const stuck = dup.duplicateView({ kind: 'export', phase: 'done', chainError: 'the export is not whole', duplicate: { project: { id: CODE.id, name: 'beethoven' }, destination: { slot: '2', email: 'b@example.com' } } });
  assert.equal(stuck.canStart, true);
  assert.equal(stuck.chainError, 'the export is not whole');
  assert.equal(dup.duplicateView({ kind: 'export', phase: 'done', chainError: 7 }).chainError, '');
});
