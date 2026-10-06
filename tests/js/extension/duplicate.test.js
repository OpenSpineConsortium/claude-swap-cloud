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
  // The panel's label stands in for a missing name; the name stays the
  // site's own, '' when it gave none, which is what the bridge is sent.
  assert.deepEqual(choices.projects.map(p => p.label), ['beethoven', '(unnamed project)', 'Recipes']);
  assert.deepEqual(choices.projects.map(p => p.name), ['beethoven', '', 'Recipes']);
  assert.equal(choices.projects[1].archived, true);
  assert.deepEqual(choices.here, { id: CODE.id, kind: 'code' });
  assert.deepEqual(choices.orgs.map(o => [o.uuid, o.apiOnly, o.error]), [[ORG, false, null], ['api-org', true, 'HTTP 403']]);
  assert.equal(choices.error, null);
  // A Claude Code workspace open in the tab that no listing returned is
  // still offered, as the export script would export it: by its id, with
  // no name to send, so its label is never recorded as one.
  const unlisted = dup.projectChoices({ projects: [RECIPES], orgs: [], here: { id: 'chan_01UNLISTED000000000000000', kind: 'code' } });
  assert.equal(unlisted.projects[0].id, 'chan_01UNLISTED000000000000000');
  assert.match(unlisted.projects[0].label, /^This tab's workspace \(chan_01UNLISTED000000000000000\)$/);
  assert.equal(unlisted.projects[0].name, '');
  assert.equal(unlisted.projects[0].kind, 'code');
  assert.equal(unlisted.projects[1].name, 'Recipes');
  // The channel list named the tab's workspace: no stand-in, and it comes
  // first under its own name though it belongs to no organization.
  const listedHere = dup.projectChoices({ projects: [RECIPES, { ...CODE, orgUuid: '', orgName: '' }], orgs: [], here: { id: CODE.id, kind: 'code' } });
  assert.deepEqual(listedHere.projects.map(p => [p.id, p.name, p.label]), [[CODE.id, 'beethoven', 'beethoven'], [RECIPES.id, 'Recipes', 'Recipes']]);
  assert.ok(!listedHere.projects.some(p => /This tab's workspace/.test(p.label)));
  // A Claude Code project that an organization's list and the channel list
  // both return is one row; a regular one in two organizations is two.
  const twice = dup.projectChoices({ projects: [CODE, { ...CODE, orgUuid: '', orgName: '' }, RECIPES, { ...RECIPES, orgUuid: 'other' }], here: null });
  assert.deepEqual(twice.projects.map(p => [p.id, p.orgUuid]), [[CODE.id, ORG], [RECIPES.id, ORG], [RECIPES.id, 'other']]);
  // A blank name is no name.
  assert.deepEqual(dup.projectChoices({ projects: [{ ...RECIPES, name: '   ' }] }).projects.map(p => [p.name, p.label]), [['', '(unnamed project)']]);
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
  assert.equal(texts.command, 'cswap project-move import --to 2 --folder "C:\\Users\\greg\\exports\\beethoven"');
  assert.equal(texts.notImported, 'The export of "beethoven" is saved at C:\\Users\\greg\\exports\\beethoven, but its import into Account-2 (b@example.com) could not start.' +
    ' Import it by hand with: cswap project-move import --to 2 --folder "C:\\Users\\greg\\exports\\beethoven".' +
    ' Or, in a window of its own: cswap project-move auto --export "C:\\Users\\greg\\exports\\beethoven" --to 2.');
  assert.equal(texts.drivenStarted, 'Exported "beethoven" (9 files). Importing it into Account-2 (b@example.com) in a window of its own.');
  assert.equal(texts.drivenCommand, 'cswap project-move auto --export "C:\\Users\\greg\\exports\\beethoven" --to 2');
  const one = dup.chainTexts({ duplicate: { destination: { slot: '1', email: 'a@example.com' } }, export: { files: 1, name: 'Recipes' } });
  assert.equal(one.importing, 'Exported "Recipes" (1 file). Importing it into Account-1 (a@example.com).');
  assert.match(one.notImported, /cswap project-move import --to 1\.$/);
  assert.equal(one.drivenCommand, '', 'no folder known: no line for a window of its own');
  assert.match(dup.chainTexts(null).notImported, /The export of "the project" is saved, but its import into Account-\? \(\?\) could not start/);
  assert.equal(dup.chainTexts(null).command, 'cswap project-move import --to NUM');
});

test('chainTexts: the project keeps its own name; only a stand-in gives way, and the copy\'s name goes on the line', () => {
  const base = { duplicate: { project: { id: CODE.id, name: 'beethoven', kind: 'code' }, destination: { slot: '2', email: 'b@example.com' } }, export: { files: 2, path: 'C:\\x\\beethoven' } };
  // A name typed for the copy: the export is still of "beethoven", and the
  // import by hand names the copy as the chain would have.
  const copy = dup.chainTexts({ ...base, duplicate: { ...base.duplicate, name: 'beethoven copy' } });
  assert.equal(copy.importing, 'Exported "beethoven" (2 files). Importing it into Account-2 (b@example.com).');
  assert.equal(copy.command, 'cswap project-move import --to 2 --folder "C:\\x\\beethoven" --name "beethoven copy"');
  // The panel's stand-in, or the id the bridge records for a project sent
  // with no name, gives way to the copy's name, then the export's.
  for (const standIn of [`This tab's workspace (${CODE.id})`, CODE.id, '(unnamed project)', '']) {
    const greg = dup.chainTexts({ ...base, duplicate: { ...base.duplicate, project: { id: CODE.id, name: standIn }, name: 'beethoven' } });
    assert.match(greg.importing, /^Exported "beethoven" /, standIn);
    const own = dup.chainTexts({ ...base, duplicate: { ...base.duplicate, project: { id: CODE.id, name: standIn } }, export: { ...base.export, name: 'Beethoven' } });
    assert.match(own.importing, /^Exported "Beethoven" /, standIn);
    const nothing = dup.chainTexts({ ...base, duplicate: { ...base.duplicate, project: { id: CODE.id, name: standIn } }, export: { ...base.export, name: CODE.id } });
    assert.match(nothing.importing, /^Exported "the project" /, standIn);
  }
  // PowerShell expands $ and a backtick inside double quotes: a value with
  // one of them, or a double quote, is left off the line.
  for (const bad of ['a "quoted" name', 'cost $5', 'tick`s']) {
    const line = dup.chainTexts({ ...base, duplicate: { ...base.duplicate, name: bad } }).command;
    assert.equal(line, 'cswap project-move import --to 2 --folder "C:\\x\\beethoven"', bad);
  }
  assert.equal(dup.chainTexts({ ...base, export: { path: 'C:\\$x\\b' } }).command, 'cswap project-move import --to 2');
});

test('standInName, needsHostRecord and withHostRecord: what only the bridge knows fills a finished export\'s record', () => {
  for (const n of ['', '  ', null, CODE.id, '(unnamed project)', `This tab's workspace (${CODE.id})`, "This tab's workspace (other)"]) assert.equal(dup.standInName(n, CODE.id), true, String(n));
  for (const n of ['beethoven', 'This tab', CODE.id + 'x']) assert.equal(dup.standInName(n, CODE.id), false, n);
  const mine = {
    id: 'job_e', kind: 'export', phase: 'done',
    duplicate: { project: { id: CODE.id, name: `This tab's workspace (${CODE.id})`, kind: 'code' }, destination: { slot: '3', email: 'go@example.com' }, name: 'beethoven' },
    export: { name: `This tab's workspace (${CODE.id})`, kind: 'code', path: '', files: 143 },
  };
  assert.equal(dup.needsHostRecord(mine), true);
  assert.equal(dup.needsHostRecord({ ...mine, export: { ...mine.export, path: 'C:\\x' }, duplicate: { ...mine.duplicate, project: { id: CODE.id, name: 'beethoven' } } }), false);
  assert.equal(dup.needsHostRecord({ ...mine, export: { ...mine.export, path: 'C:\\x' } }), true, 'a stand-in name');
  // The bridge's record of the same job: its folder, and the name it took
  // from the export.json.
  const host = { id: 'job_e', kind: 'export', status: 'done', export: { path: 'C:\\Users\\greg\\Desktop\\beethoven (2)', name: 'beethoven' }, duplicate: { project: { id: CODE.id, name: 'beethoven' } } };
  const filled = dup.withHostRecord(mine, host);
  assert.equal(filled.export.path, 'C:\\Users\\greg\\Desktop\\beethoven (2)');
  assert.equal(filled.export.name, 'beethoven');
  assert.equal(filled.export.files, 143, 'the rest kept');
  assert.equal(filled.duplicate.project.name, 'beethoven');
  assert.equal(filled.duplicate.name, 'beethoven');
  assert.equal(mine.export.path, '', 'the record given is not changed');
  // The import queued from it says the same.
  const imp = { id: 'job_i', kind: 'import', export: { path: 'C:\\y', name: 'Beethoven' }, duplicate: { export_job: 'job_e', source: { project: { id: CODE.id, name: 'Beethoven' } } } };
  assert.equal(dup.withHostRecord(mine, imp).export.path, 'C:\\y');
  assert.equal(dup.withHostRecord(mine, imp).duplicate.project.name, 'Beethoven');
  // A record of another job adds nothing; a path and a name already known are kept.
  assert.deepEqual(dup.withHostRecord(mine, { ...host, id: 'job_other' }), { export: mine.export, duplicate: mine.duplicate });
  const known = { ...mine, export: { ...mine.export, path: 'C:\\mine', name: 'Mine' }, duplicate: { ...mine.duplicate, project: { id: CODE.id, name: 'Mine' } } };
  assert.equal(dup.withHostRecord(known, host).export.path, 'C:\\mine');
  assert.equal(dup.withHostRecord(known, host).duplicate.project.name, 'Mine');
  // A host that knows no better name leaves the stand-in.
  assert.equal(dup.withHostRecord(mine, { ...host, export: { path: 'C:\\z', name: CODE.id }, duplicate: { project: { id: CODE.id, name: CODE.id } } }).duplicate.project.name, mine.duplicate.project.name);
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
  // A workspace offered by its id alone shows the stand-in label.
  const byId = dup.projectChoices({ projects: [], here: { id: 'chan_01UNLISTED000000000000000', kind: 'code' } });
  const byIdView = dup.duplicateView({ kind: 'export', phase: 'choosing', choices: byId, accounts: dup.accountChoices(ACCOUNTS) });
  assert.deepEqual(byIdView.projects, [{ id: 'chan_01UNLISTED000000000000000', label: 'This tab\'s workspace (chan_01UNLISTED000000000000000)  [code]', selected: true }]);
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
  assert.equal(stuck.canRetryImport, true);
  assert.equal(stuck.chainCommand, 'cswap project-move import --to 2');
  assert.equal(dup.duplicateView({ kind: 'export', phase: 'done', chainError: 7 }).chainError, '');
  assert.equal(dup.duplicateView({ kind: 'export', phase: 'done', chainError: 7 }).canRetryImport, false);
  assert.equal(dup.duplicateView({ kind: 'export', phase: 'done' }).canRetryImport, false, 'a hand-off on its way');
  assert.equal(dup.duplicateView({ kind: 'export', phase: 'done' }).chainCommand, '');
  assert.equal(dup.duplicateView({ kind: 'import', phase: 'failed', chainError: 'x' }).canRetryImport, false, 'an import never offers it');
});

test('the way the copy is imported: in its own window when the bridge can, in this tab otherwise', () => {
  assert.equal(dup.DRIVEN_CAPABILITY, 'driven');
  assert.equal(dup.DEFAULT_IMPORT_WAY, 'driven');
  assert.deepEqual(dup.IMPORT_WAYS.map(w => w.value), ['driven', 'tab']);
  for (const [value, capable, way] of [['driven', true, 'driven'], ['', true, 'driven'], [undefined, true, 'driven'], ['nonsense', true, 'driven'],
    ['tab', true, 'tab'], ['driven', false, 'tab'], ['', false, 'tab'], ['tab', false, 'tab']]) {
    assert.equal(dup.importWay(value, capable), way, `${value} ${capable}`);
  }
  assert.equal(dup.drivenCapable({ lastHello: { capabilities: ['job', 'driven'] } }), true);
  for (const bridge of [null, {}, { lastHello: null }, { lastHello: { capabilities: 'driven' } }, { lastHello: { capabilities: ['duplicate'] } }]) {
    assert.equal(dup.drivenCapable(bridge), false, JSON.stringify(bridge));
  }
  assert.equal(dup.helloCan({ capabilities: ['duplicate'] }, 'duplicate'), true);
  assert.equal(dup.helloCan(null, 'duplicate'), false);
});

test('drivenRecord: what the bridge says of an import in its own window, checked and cut', () => {
  const r = dup.drivenRecord({
    running: true, lost: 'yes', pid: 4242, attempt: 2, started_at: '2026-10-06T19:30:00Z', ended_at: null, exit_code: 1.5,
    url: 'https://claude.ai/code/project/chan_01NEW', carry_on: 'https://evil.example/x', made: 'https://claude.ai/x?token=1',
    message: 'm'.repeat(900), command: 'c'.repeat(3000), log: 'C:\\x\\driven.log', extra: 'dropped',
    tail: [...Array.from({ length: 20 }, (_, i) => `line ${i}`), 7, 'z'.repeat(1000)],
  });
  assert.equal(r.running, true);
  assert.equal(r.lost, false, 'only true is true');
  assert.equal(r.pid, 4242);
  assert.equal(r.attempt, 2);
  assert.equal(r.exit_code, null, 'an exit code is a whole number');
  assert.equal(r.url, 'https://claude.ai/code/project/chan_01NEW');
  assert.equal(r.carry_on, '', 'only claude.ai');
  assert.equal(r.made, '', 'no query string');
  assert.equal(r.message.length, 500);
  assert.equal(r.command.length, 2000);
  assert.equal(r.ended_at, '');
  assert.equal(r.tail.length, 12);
  assert.ok(r.tail.every(l => typeof l === 'string' && l.length <= 300));
  assert.equal(r.tail[r.tail.length - 1], 'z'.repeat(300));
  assert.ok(!('extra' in r));
  assert.deepEqual(dup.drivenRecord(null).tail, []);
  assert.equal(dup.drivenRecord(undefined).running, false);
});

test('drivenView: offered after a failed hand-off, then running, done, stopped with Carry on, stopped, and lost', () => {
  // greg's stored export: the hand-off failed, the project offered by its id
  // alone, a name typed for the copy.
  const greg = {
    kind: 'export', phase: 'done', chainError: 'the bridge has not heard that the export finished',
    duplicate: { project: { id: CODE.id, name: `This tab's workspace (${CODE.id})` }, destination: { slot: '3', email: 'go2432@example.com' }, name: 'beethoven' },
    export: { path: 'C:\\Users\\greg\\Desktop\\beethoven (2)', files: 143, name: `This tab's workspace (${CODE.id})` },
  };
  const offer = dup.drivenView(greg, { capable: true });
  assert.equal(offer.show, true);
  assert.equal(offer.running, false);
  assert.match(offer.line, /^Or import "beethoven" into Account-3 \(go2432@example\.com\) in a window of its own/);
  assert.deepEqual(offer.button, { show: true, label: 'Import in its own window', enabled: true });
  assert.equal(offer.command, 'cswap project-move auto --export "C:\\Users\\greg\\Desktop\\beethoven (2)" --to 3 --name "beethoven"');
  // A bridge that cannot: nothing offered. A finished export whose hand-off
  // has not failed: nothing either. An import, or an export still running: nothing.
  assert.equal(dup.drivenView(greg, { capable: false }).show, false);
  assert.equal(dup.drivenView({ ...greg, chainError: null }, { capable: true }).show, false);
  assert.equal(dup.drivenView({ ...greg, kind: 'import' }, { capable: true }).show, false);
  assert.equal(dup.drivenView({ ...greg, phase: 'running' }, { capable: true }).show, false);
  assert.equal(dup.drivenView({ ...greg, duplicate: { ...greg.duplicate, destination: null } }, { capable: true }).show, false);
  const record = { running: true, pid: 4242, command: 'cswap project-move auto --export "C:\\x" --to 3', tail: ['a', 'b'] };
  const running = dup.drivenView({ ...greg, chainError: null, driven: record }, { capable: true });
  assert.equal(running.running, true);
  assert.equal(running.line, 'Importing "beethoven" into Account-3 (go2432@example.com) in its own window (process 4242). Sign in there if it asks; this panel follows what it says.');
  assert.equal(running.button.show, false);
  assert.deepEqual(running.tail, ['a', 'b']);
  assert.equal(running.command, record.command, 'the bridge\'s own line once there is one');
  const done = dup.drivenView({ ...greg, driven: { ...record, running: false, exit_code: 0, url: 'https://claude.ai/code/project/chan_01NEW' } }, { capable: true });
  assert.equal(done.line, 'Done: the copy is at https://claude.ai/code/project/chan_01NEW.');
  assert.equal(done.link, 'https://claude.ai/code/project/chan_01NEW');
  assert.equal(done.button.show, false);
  const unsaid = dup.drivenView({ ...greg, driven: { ...record, running: false, exit_code: 0 } }, { capable: true });
  assert.equal(unsaid.line, 'Done, but the window did not say where; look for "beethoven" among go2432@example.com\'s projects.');
  const carry = dup.drivenView({ ...greg, driven: { ...record, running: false, exit_code: 1, carry_on: 'https://claude.ai/code/project/chan_01CARRY', message: 'The import stopped part-way' } }, { capable: true });
  assert.equal(carry.line, 'Stopped: The import stopped part-way. https://claude.ai/code/project/chan_01CARRY holds what was added; Carry on goes on in it, and nothing is made twice.');
  assert.deepEqual(carry.button, { show: true, label: 'Carry on in its own window', enabled: true });
  const stopped = dup.drivenView({ ...greg, driven: { ...record, running: false, exit_code: 1 } }, { capable: true });
  assert.equal(stopped.line, 'Stopped: see its last lines below.');
  assert.equal(stopped.button.label, 'Try again in its own window');
  const lost = dup.drivenView({ ...greg, driven: { ...record, running: false, lost: true } }, { capable: false });
  assert.match(lost.line, /^The import's window closed before it said how it ended\. Check go2432@example\.com's projects/);
  assert.deepEqual(lost.button, { show: true, label: 'Try again in its own window', enabled: false }, 'a bridge that cannot start it again');
  const lostInProject = dup.drivenView({ ...greg, driven: { ...record, running: false, lost: true, carry_on: 'https://claude.ai/code/project/chan_01CARRY' } }, { capable: true });
  assert.match(lostInProject.line, /^Stopped: the window closed before it said how it ended\./);
  assert.equal(lostInProject.button.label, 'Carry on in its own window');
});

test('duplicateView: the ways to import the copy, and the import in its own window', () => {
  const found = dup.projectChoices({ projects: [CODE], here: null });
  const choosing = { kind: 'export', phase: 'choosing', choices: found, accounts: dup.accountChoices(ACCOUNTS) };
  const can = dup.duplicateView(choosing, { drivenCapable: true });
  assert.deepEqual(can.ways, [
    { value: 'driven', label: 'In its own window, like the command line', selected: true, disabled: false },
    { value: 'tab', label: 'In this tab', selected: false, disabled: false },
  ]);
  assert.equal(can.wayHelp, dup.WAY_HELP.driven);
  assert.equal(can.wayHint, '');
  const cannot = dup.duplicateView(choosing);
  assert.deepEqual(cannot.ways.map(w => [w.value, w.selected, w.disabled]), [['driven', false, true], ['tab', true, false]]);
  assert.equal(cannot.wayHelp, dup.WAY_HELP.tab);
  assert.equal(cannot.wayHint, dup.NO_DRIVEN_WAY_HINT);
  const exporting = { kind: 'export', phase: 'running', account: { email: 'a@example.com' }, importWay: 'driven',
    duplicate: { project: { id: CODE.id, name: 'beethoven' }, destination: { slot: '2', email: 'b@example.com' } } };
  assert.equal(dup.duplicateView(exporting).line, 'Duplicate: exporting "beethoven" from a@example.com for Account-2 (b@example.com). The copy is then imported in its own window.');
  assert.match(dup.duplicateView({ ...exporting, importWay: 'tab' }).line, /The copy is then imported in this tab\.$/);
  assert.equal(dup.duplicateView(exporting).driven.show, false);
  const done = dup.duplicateView({ ...exporting, phase: 'done', driven: { running: true, pid: 9 } }, { drivenCapable: true });
  assert.equal(done.driven.running, true);
});
