// duplicate.js: the Duplicate's pure pieces, which the panel and the worker
// share: the project's page, what the page helper is told, how the page's
// listing and the bridge's account list are shaped for the panel, which
// account is offered first, the hand-over texts, the panel's view and what
// came after a finished export.
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
  assert.deepEqual(dup.projectChoices(null), { projects: [], orgs: [], here: null, error: null, codeList: null });
  assert.equal(dup.projectChoices({ error: 'HTTP 500 from /api/organizations' }).error, 'HTTP 500 from /api/organizations');
});

test('elsewhereView: what the Connection section says of a job another browser profile holds', () => {
  assert.equal(dup.DROP_CAPABILITY, 'drop');
  assert.match(dup.NO_DROP_TEXT, /import --cancel/);
  assert.match(dup.DROP_HINT_TEXT, /Drop that job/);
  for (const none of [null, undefined, {}, { id: '' }, { id: 7 }]) assert.deepEqual(dup.elsewhereView(none, true), { line: '', canDrop: false, id: '' });
  const held = { id: 'job_20261007T002214_bfa636', claimed_by: { instance: 'other', at: '2026-10-07T00:35:12Z', extension_version: '0.2.0' } };
  const can = dup.elsewhereView(held, true);
  assert.equal(can.canDrop, true);
  assert.equal(can.id, held.id);
  assert.match(can.line, /^Job job_20261007T002214_bfa636 is claimed by another browser profile since 2026-10-07T00:35:12Z\. /);
  assert.match(can.line, /press Drop that job/);
  assert.ok(!can.line.includes('--cancel'));
  assert.match(can.line, /press Drop that job: the bridge ends it as cancelled, a browser still running it stops the next time it reports, and a new job can start here\.$/);
  const cannot = dup.elsewhereView(held, false);
  assert.equal(cannot.canDrop, false);
  assert.match(cannot.line, /cancel it with `cswap project-move import --cancel`/);
  assert.ok(!cannot.line.includes('Drop that job'));
  // No claim time: none shown.
  assert.match(dup.elsewhereView({ id: 'job_x' }, true).line, /^Job job_x is claimed by another browser profile\. /);
});

test('codeListOf, codeListEmpty, listingSummary: how the Claude Code project list went, checked', () => {
  // The page's tally, as it is, with its counts checked.
  assert.deepEqual(dup.codeListOf({ status: 200, rows: 3, pages: 2, complete: true }), { status: 200, rows: 3, pages: 2, complete: true });
  assert.deepEqual(dup.codeListOf({ status: 403, rows: -1, pages: 'x', complete: 'yes' }), { status: 403, rows: 0, pages: 0, complete: false });
  // Nothing without a status: the list was not asked for.
  for (const none of [null, undefined, {}, { rows: 1 }, { status: '200' }, 'x', []]) assert.equal(dup.codeListOf(none), null);
  assert.deepEqual(dup.projectChoices({ projects: [], codeList: { status: 200, rows: 0, pages: 1, complete: true } }).codeList, { status: 200, rows: 0, pages: 1, complete: true });
  assert.equal(dup.projectChoices({ projects: [], codeList: 'garbage' }).codeList, null);
  // Empty means answered, read to its end, and nothing in it.
  assert.equal(dup.codeListEmpty({ codeList: { status: 200, rows: 0, pages: 1, complete: true } }), true);
  assert.equal(dup.codeListEmpty({ codeList: { status: 200, rows: 1, pages: 1, complete: true } }), false);
  assert.equal(dup.codeListEmpty({ codeList: { status: 200, rows: 0, pages: 1, complete: false } }), false);
  assert.equal(dup.codeListEmpty({ codeList: { status: 200, rows: 0, pages: 0, complete: true } }), false);
  assert.equal(dup.codeListEmpty({ codeList: { status: 403, rows: 0, pages: 0, complete: false } }), false);
  assert.equal(dup.codeListEmpty({ codeList: null }), false);
  assert.equal(dup.codeListEmpty(null), false);
  // What the worker logs: the counts and the tally, never a project.
  const summary = dup.listingSummary({ projects: [RECIPES, CODE, { ...CODE, id: 'chan_01OTHER' }], orgs: [{ uuid: ORG }], codeList: { status: 200, rows: 2, pages: 1, complete: true }, error: null });
  assert.deepEqual(summary, { regular: 1, code: 2, orgs: 1, codeList: { status: 200, rows: 2, pages: 1, complete: true }, error: null });
  // The panel's stand-in for the tab's unnamed workspace is no listed project.
  const byId = dup.projectChoices({ projects: [RECIPES], here: { id: 'chan_01UNLISTED000000000000000', kind: 'code' } });
  assert.deepEqual(dup.listingSummary(byId), { regular: 1, code: 0, orgs: 0, codeList: null, error: null });
  const listed = dup.projectChoices({ projects: [RECIPES, { ...CODE, orgUuid: '', orgName: '' }], here: { id: CODE.id, kind: 'code' } });
  assert.equal(dup.listingSummary(listed).code, 1, 'the tab\'s workspace under its own name counts');
  assert.deepEqual(dup.listingSummary({ error: 'HTTP 403 from /v1/code/channels' }), { regular: 0, code: 0, orgs: 0, codeList: null, error: 'HTTP 403 from /v1/code/channels' });
  assert.deepEqual(dup.listingSummary(null), { regular: 0, code: 0, orgs: 0, codeList: null, error: null });
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
  assert.equal(texts.command, 'cswap project-move import --to 2 --folder="C:\\Users\\greg\\exports\\beethoven"');
  assert.equal(texts.notImported, 'The export of "beethoven" is saved at C:\\Users\\greg\\exports\\beethoven, but its import into Account-2 (b@example.com) could not start.' +
    ' Import it by hand with: cswap project-move import --to 2 --folder="C:\\Users\\greg\\exports\\beethoven".' +
    ' Or, in a window of its own: cswap project-move auto --export="C:\\Users\\greg\\exports\\beethoven" --to 2.');
  assert.equal(texts.drivenStarted, 'Exported "beethoven" (9 files). Importing it into Account-2 (b@example.com) in a window of its own.');
  assert.equal(texts.drivenCommand, 'cswap project-move auto --export="C:\\Users\\greg\\exports\\beethoven" --to 2');
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
  assert.equal(copy.command, 'cswap project-move import --to 2 --folder="C:\\x\\beethoven" --name="beethoven copy"');
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
  // Every value goes after --option=, so a name that starts with a dash is
  // never read as an option of its own.
  assert.equal(dup.chainTexts({ ...base, duplicate: { ...base.duplicate, name: '-draft' } }).drivenCommand,
    'cswap project-move auto --export="C:\\x\\beethoven" --to 2 --name="-draft"');
  // PowerShell expands $ and a backtick inside double quotes: such a value
  // goes in single quotes, which PowerShell and POSIX shells keep as they
  // are. One that also holds a quote, or a double quote at all, cannot be
  // carried: the line says so instead of making the copy under another name
  // without a word.
  const singly = dup.chainTexts({ ...base, duplicate: { ...base.duplicate, name: 'cost $5' } });
  assert.equal(singly.command, "cswap project-move import --to 2 --folder=\"C:\\x\\beethoven\" --name='cost $5'");
  for (const bad of ['a "quoted" name', "tick`'s", "it's $5", 'trailing\\']) {
    const texts = dup.chainTexts({ ...base, duplicate: { ...base.duplicate, name: bad } });
    assert.equal(texts.command, `cswap project-move import --to 2 --folder="C:\\x\\beethoven"  ${dup.UNTYPED_NAME_NOTE}`, bad);
    assert.equal(texts.drivenCommand, `cswap project-move auto --export="C:\\x\\beethoven" --to 2  ${dup.UNTYPED_NAME_NOTE}`, bad);
  }
  assert.equal(dup.chainTexts({ ...base, export: { path: 'C:\\$x\\b' } }).command, "cswap project-move import --to 2 --folder='C:\\$x\\b'");
  assert.equal(dup.chainTexts({ ...base, export: { path: 'C:\\"x' } }).command, 'cswap project-move import --to 2');
  assert.equal(dup.typedValue('plain'), '"plain"');
  assert.equal(dup.typedValue(''), '');
  assert.equal(dup.typedValue('two\nlines'), '');
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

test('duplicateView: nothing running offers Export this project; an export finding its project says so, with the accounts shaped for the panel', () => {
  // No job: the button, nothing after it, and none of the form an earlier
  // version showed (the project list, the ways to import, the hint).
  const off = { show: false, running: false, line: '', link: '', tail: [], command: '', button: { show: false, label: '', enabled: false } };
  assert.deepEqual(dup.duplicateView(null), { canStart: true, line: '', accounts: [], noAccounts: '', after: off });
  assert.deepEqual(dup.duplicateView(undefined), dup.duplicateView(null));
  const ended = dup.duplicateView({ kind: 'import', phase: 'done' });
  assert.equal(ended.canStart, true);
  assert.deepEqual(ended.after, off, 'an import has nothing after it');
  for (const phase of ['failed', 'cancelled']) assert.equal(dup.duplicateView({ kind: 'export', phase }).canStart, true, phase);
  assert.equal(dup.duplicateView({ kind: 'import', phase: 'running' }).canStart, false);
  assert.equal(dup.duplicateView({ kind: 'import', phase: 'running' }).line, '', 'an import that is not a Duplicate\'s says nothing here');

  // An export before its project is chosen: the page is finding the tab's
  // project and who is signed in. The project is chosen on its own from
  // the listing, so the panel shows no list to choose from.
  const found = dup.projectChoices({ projects: [RECIPES, CODE], orgs: [{ uuid: ORG, name: 'Personal' }], here: { id: CODE.id, kind: 'code' } });
  const finding = dup.duplicateView({ kind: 'export', phase: 'choosing', account: { email: 'a@example.com' }, choices: found, accounts: dup.accountChoices(ACCOUNTS) });
  assert.equal(finding.canStart, false);
  assert.equal(finding.line, "Finding this tab's project and who is signed in (a@example.com).");
  assert.deepEqual(Object.keys(finding).sort(), ['accounts', 'after', 'canStart', 'line', 'noAccounts']);
  assert.deepEqual(finding.after, off);
  assert.equal(finding.noAccounts, '', 'said only once Import is offered');
  for (const phase of ['claimed', 'preflight', 'choosing']) {
    assert.equal(dup.duplicateView({ kind: 'export', phase }).line, "Finding this tab's project and who is signed in.", phase);
  }
  // The accounts, as the bridge listed them at the start of the export,
  // with the first usable one that is not the project's own selected.
  assert.deepEqual(finding.accounts.map(a => [a.slot, a.disabled, a.selected]), [['1', false, false], ['2', false, true], ['3', true, false]]);
  assert.equal(finding.accounts[1].label, 'Account-2 (work): b@example.com, Beethoven Org');
  // The account the job already names is selected when it is listed and
  // usable, even the project's own; otherwise the default again.
  const naming = slot => dup.duplicateView({
    kind: 'export', phase: 'done', account: { email: 'a@example.com' }, accounts: dup.accountChoices(ACCOUNTS),
    duplicate: { project: { id: CODE.id, name: 'beethoven' }, destination: { slot, email: '' } }, export: { path: 'C:\\x', files: 1 },
  }).accounts.filter(a => a.selected).map(a => a.slot);
  assert.deepEqual(naming('2'), ['2']);
  assert.deepEqual(naming('1'), ['1'], 'the project\'s own account, when the job names it');
  assert.deepEqual(naming('3'), ['2'], 'not usable');
  assert.deepEqual(naming('9'), ['2'], 'not listed');
  assert.deepEqual(naming(''), ['2']);
  assert.deepEqual(dup.duplicateView({ kind: 'export', phase: 'choosing', accounts: 'garbage' }).accounts, []);
});

test('duplicateView: the running export, the import after it, and the export whose import could not start', () => {
  const exporting = dup.duplicateView({
    kind: 'export', phase: 'running', account: { email: 'a@example.com' },
    duplicate: { project: { id: CODE.id, name: 'beethoven' }, destination: { slot: '2', email: 'b@example.com' } },
  });
  assert.equal(exporting.canStart, false);
  assert.equal(exporting.line, 'Exporting "beethoven" from a@example.com.');
  assert.equal(exporting.after.show, false);
  assert.equal(exporting.noAccounts, '');
  assert.equal(dup.duplicateView({ kind: 'export', phase: 'running', duplicate: { project: { id: CODE.id, name: 'beethoven' } } }).line,
    'Exporting "beethoven" from this account.');
  // A project offered by its id alone is named by its export's name, else
  // not at all, as the hand-over texts name it.
  const standIn = { id: CODE.id, name: `This tab's workspace (${CODE.id})` };
  const running = extra => dup.duplicateView({ kind: 'export', phase: 'running', account: { email: 'a@example.com' }, duplicate: { project: standIn }, ...extra }).line;
  assert.equal(running({ export: { name: 'Beethoven' } }), 'Exporting "Beethoven" from a@example.com.');
  assert.equal(running({}), 'Exporting "the project" from a@example.com.');
  // The import a Duplicate queued, in this tab.
  const importing = dup.duplicateView({ kind: 'import', phase: 'running', duplicate: { export_job: 'job_x', source: { email: 'a@example.com', project: { id: CODE.id, name: 'beethoven' } } } });
  assert.equal(importing.line, 'Importing the copy of "beethoven" from a@example.com.');
  assert.equal(importing.canStart, false);
  assert.equal(importing.after.show, false);
  assert.equal(dup.duplicateView({ kind: 'import', phase: 'running', duplicate: { export_job: 'job_x' } }).line, 'Importing the copy of "a project" from the other account.');
  // A finished export whose import could not start says why under the
  // line and offers Import again, with the line that does the same by hand.
  const stuck = dup.duplicateView({
    kind: 'export', phase: 'done', chainError: 'the export is not whole', accounts: dup.accountChoices(ACCOUNTS),
    duplicate: { project: { id: CODE.id, name: 'beethoven' }, destination: { slot: '2', email: 'b@example.com' } },
  });
  assert.equal(stuck.canStart, true);
  assert.equal(stuck.line, '', 'what came after the export is said in `after`');
  assert.equal(stuck.after.line, 'The import could not start: the export is not whole');
  assert.deepEqual(stuck.after.button, { show: true, label: 'Import', enabled: true });
  assert.equal(stuck.after.command, 'cswap project-move import --to 2');
  assert.equal(stuck.noAccounts, '');
  // A chainError that is no text is none: the export waits for Import.
  assert.match(dup.duplicateView({ kind: 'export', phase: 'done', chainError: 7 }).after.line, /^Exported "the project" \(0 files\)\. Next: /);
  assert.equal(dup.duplicateView({ kind: 'import', phase: 'failed', chainError: 'x' }).after.show, false, 'an import never offers it');
  // Import offered with no account to import into: the panel says so and
  // holds the button. While the export runs nothing is said yet.
  for (const accounts of [undefined, null, [], dup.accountChoices(ACCOUNTS.filter(a => !a.usable))]) {
    assert.equal(dup.duplicateView({ kind: 'export', phase: 'done', accounts }).noAccounts, dup.NO_ACCOUNTS_TEXT, JSON.stringify(accounts));
  }
  assert.equal(dup.duplicateView({ kind: 'export', phase: 'running', accounts: [] }).noAccounts, '');
  assert.equal(dup.duplicateView({ kind: 'export', phase: 'done', accounts: dup.accountChoices(ACCOUNTS) }).noAccounts, '');
});

test('the way the copy is imported: in this tab, which the panel no longer asks about; a stored way keeps its meaning', () => {
  assert.equal(dup.DRIVEN_CAPABILITY, 'driven');
  assert.equal(dup.DEFAULT_IMPORT_WAY, 'tab');
  // No list of ways, no help for one, no hint that a bridge cannot, no
  // view of its own: the import in a window of its own is the command
  // line's, and the panel keeps only the record of one an earlier version
  // started.
  for (const gone of ['IMPORT_WAYS', 'WAY_HELP', 'NO_DRIVEN_WAY_HINT', 'drivenView']) assert.equal(dup[gone], undefined, gone);
  for (const [value, capable, way] of [['driven', true, 'driven'], ['', true, 'driven'], [undefined, true, 'driven'], ['nonsense', true, 'driven'],
    ['tab', true, 'tab'], ['driven', false, 'tab'], ['', false, 'tab'], ['tab', false, 'tab']]) {
    assert.equal(dup.importWay(value, capable), way, `${value} ${capable}`);
  }
  assert.equal(dup.importWay(dup.DEFAULT_IMPORT_WAY, true), 'tab', 'the default, even with a bridge that could');
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

test('afterExportView: a finished export waits for Import; a failed hand-off says why; an earlier version\'s import in its own window: running, done, stopped with the copy to carry on in, stopped, lost', () => {
  // greg's stored export: the project offered by its id alone, a name typed
  // for the copy.
  const greg = {
    kind: 'export', phase: 'done', chainError: null,
    duplicate: { project: { id: CODE.id, name: `This tab's workspace (${CODE.id})` }, destination: { slot: '3', email: 'go2432@example.com' }, name: 'beethoven' },
    export: { path: 'C:\\Users\\greg\\Desktop\\beethoven (2)', files: 143, name: `This tab's workspace (${CODE.id})` },
  };
  const line = 'cswap project-move import --to 3 --folder="C:\\Users\\greg\\Desktop\\beethoven (2)" --name="beethoven"';
  const waiting = dup.afterExportView(greg);
  assert.deepEqual(waiting, {
    show: true, running: false, link: '', tail: [], command: line,
    line: `Exported "beethoven" (143 files) to C:\\Users\\greg\\Desktop\\beethoven (2). ${dup.NEXT_STEPS_TEXT}`,
    button: { show: true, label: 'Import', enabled: true },
  });
  assert.equal(dup.afterExportView({ ...greg, export: { files: 1 } }).line, `Exported "beethoven" (1 file). ${dup.NEXT_STEPS_TEXT}`, 'no folder known yet');
  // The hand-off failed: why, and Import again with the same line.
  const stuck = dup.afterExportView({ ...greg, chainError: 'the bridge has not heard that the export finished' });
  assert.equal(stuck.line, 'The import could not start: the bridge has not heard that the export finished');
  assert.deepEqual(stuck.button, { show: true, label: 'Import', enabled: true });
  assert.equal(stuck.command, line);
  assert.equal(stuck.running, false);
  // An import, an export not done, nothing at all: not shown.
  const off = { show: false, running: false, line: '', link: '', tail: [], command: '', button: { show: false, label: '', enabled: false } };
  for (const job of [null, undefined, 'x', { ...greg, kind: 'import' }, { ...greg, phase: 'running' }, { ...greg, phase: 'failed' }, { ...greg, phase: 'cancelled' }]) {
    assert.deepEqual(dup.afterExportView(job), off, JSON.stringify(job));
  }
  // The record of an import in its own window, which an earlier version
  // started: running, with no button.
  const record = { running: true, pid: 4242, command: 'cswap project-move auto --export "C:\\x" --to 3', tail: ['a', 'b'] };
  const running = dup.afterExportView({ ...greg, driven: record });
  assert.equal(running.show, true);
  assert.equal(running.running, true);
  assert.equal(running.line, 'Importing "beethoven" into Account-3 (go2432@example.com) in its own window (process 4242). Sign in there if it asks; this panel follows what it says.');
  assert.equal(running.button.show, false);
  assert.deepEqual(running.tail, ['a', 'b']);
  assert.equal(running.command, line, 'the line that imports in this tab, for later');
  assert.match(dup.afterExportView({ ...greg, driven: { ...record, pid: null } }).line, /in its own window\. Sign in there/);
  assert.match(dup.afterExportView({ ...greg, driven: record, duplicate: { ...greg.duplicate, destination: null } }).line, /^Importing "beethoven" into Account-\? \(\?\) in its own window/);
  // Done, with the new project's link.
  const done = dup.afterExportView({ ...greg, driven: { ...record, running: false, exit_code: 0, url: 'https://claude.ai/code/project/chan_01NEW' } });
  assert.equal(done.line, 'Done: the copy is at https://claude.ai/code/project/chan_01NEW.');
  assert.equal(done.link, 'https://claude.ai/code/project/chan_01NEW');
  assert.equal(done.running, false);
  assert.equal(done.button.show, false);
  const unsaid = dup.afterExportView({ ...greg, driven: { ...record, running: false, exit_code: 0 } });
  assert.equal(unsaid.line, 'Done, but the window did not say where; look for "beethoven" among go2432@example.com\'s projects.');
  assert.equal(unsaid.link, '');
  assert.match(dup.afterExportView({ ...greg, driven: { ...record, running: false, exit_code: 0 }, duplicate: { ...greg.duplicate, destination: null } }).line, /among that account's projects\.$/);
  // Stopped with a part-made Claude Code copy: the command line's own line
  // carries on in it; Import, which would make a second project, is not
  // offered.
  const carryOn = 'https://claude.ai/code/project/chan_01CARRY';
  const own = `cswap project-move auto --export="C:\\x" --to 3 --into ${carryOn}`;
  const carry = dup.afterExportView({ ...greg, driven: { ...record, running: false, exit_code: 1, carry_on: carryOn, message: 'The import stopped part-way', command: own } });
  assert.equal(carry.line, `Stopped: The import stopped part-way. ${carryOn} holds what was added; the line below carries on in it from the command line, ` +
    'and nothing is made twice. An import in this tab would make a second project beside it.');
  assert.equal(carry.button.show, false);
  assert.equal(carry.command, own, 'the bridge\'s own line');
  assert.equal(carry.link, '');
  const carryUnsaid = dup.afterExportView({ ...greg, driven: { ...record, running: false, exit_code: 1, carry_on: carryOn, command: '' } });
  assert.equal(carryUnsaid.command, 'cswap project-move auto --export="C:\\Users\\greg\\Desktop\\beethoven (2)" --to 3 --name="beethoven"', 'else the line as the bridge would start it');
  assert.match(carryUnsaid.line, /^Stopped: see its last lines below\. /);
  // Stopped with nothing named: Import again.
  const stopped = dup.afterExportView({ ...greg, driven: { ...record, running: false, exit_code: 1 } });
  assert.equal(stopped.line, 'Stopped: see its last lines below.');
  assert.deepEqual(stopped.button, { show: true, label: 'Import', enabled: true });
  assert.equal(stopped.command, line);
  // Lost: the window closed without a word.
  const lost = dup.afterExportView({ ...greg, driven: { ...record, running: false, lost: true } });
  assert.equal(lost.line, "The import's window closed before it said how it ended. Check go2432@example.com's projects for a part-made copy before importing again.");
  assert.deepEqual(lost.button, { show: true, label: 'Import', enabled: true });
  const lostInProject = dup.afterExportView({ ...greg, driven: { ...record, running: false, lost: true, carry_on: carryOn } });
  assert.match(lostInProject.line, /^Stopped: the window closed before it said how it ended\. https:\/\/claude\.ai\/code\/project\/chan_01CARRY holds/);
  assert.equal(lostInProject.button.show, false);
  // The record is read as drivenRecord reads it: a link that is not
  // claude.ai's dropped, the tail cut to its lines.
  const odd = dup.afterExportView({ ...greg, driven: { running: false, exit_code: 0, url: 'https://evil.example/x', tail: [1, 'ok'] } });
  assert.match(odd.line, /^Done, but the window did not say where/);
  assert.deepEqual(odd.tail, ['ok']);
});

test('afterExportView: a stop that made a regular project links it and warns that Import makes another; a stop by the person warns too', () => {
  const greg = {
    kind: 'export', phase: 'done', chainError: null,
    duplicate: { project: { id: RECIPES.id, name: 'Recipes' }, destination: { slot: '3', email: 'go2432@example.com' }, name: '' },
    export: { path: 'C:\\x\\Recipes', files: 4, name: 'Recipes' },
  };
  const made = 'https://claude.ai/project/aaaaaaaa-0000-4000-8000-000000000009';
  const record = { running: false, exit_code: 1, command: 'cswap project-move auto --export="C:\\x\\Recipes" --to 3', tail: [] };
  const regular = dup.afterExportView({ ...greg, driven: { ...record, made, message: 'The import stopped part-way: the window went away' } });
  assert.equal(regular.line, `Stopped: The import stopped part-way: the window went away. ${made} holds what was added before the stop. ` +
    'cswap cannot carry on in a regular project, so Import makes a new one beside it; delete that one first if you do not want it.');
  assert.equal(regular.link, made);
  assert.deepEqual(regular.button, { show: true, label: 'Import', enabled: true });
  assert.equal(regular.command, 'cswap project-move import --to 3 --folder="C:\\x\\Recipes"', 'the import in this tab, not the bridge\'s line');
  // The same when the window closed without a word, the project named while it ran.
  const lostRegular = dup.afterExportView({ ...greg, driven: { ...record, exit_code: null, lost: true, made } });
  assert.match(lostRegular.line, /^Stopped: the window closed before it said how it ended\. https:\/\/claude\.ai\/project\//);
  assert.equal(lostRegular.link, made);
  assert.equal(lostRegular.button.label, 'Import');
  // Ctrl+C, or the console window closed, with no project named: a part-made
  // copy may exist all the same.
  const byYou = dup.afterExportView({ ...greg, driven: { ...record, exit_code: 130, message: 'stopped: Ctrl+C, or the window was closed' } });
  assert.equal(byYou.line, "Stopped: stopped: Ctrl+C, or the window was closed. Check go2432@example.com's projects for a part-made copy before importing again.");
  assert.equal(byYou.link, '');
  assert.equal(byYou.button.label, 'Import');
  // A stop with nothing made and not by the person says only why.
  assert.equal(dup.afterExportView({ ...greg, driven: { ...record, message: 'Chrome or Edge was not found' } }).line, 'Stopped: Chrome or Edge was not found.');
});

test('duplicateView: a part-made copy to carry on in is never offered the import in this tab', () => {
  const carryOn = 'https://claude.ai/code/project/chan_01CARRY';
  const job = {
    kind: 'export', phase: 'done', chainError: 'the bridge refused: root-mismatch', accounts: dup.accountChoices(ACCOUNTS),
    duplicate: { project: { id: CODE.id, name: 'beethoven' }, destination: { slot: '2', email: 'b@example.com' } },
    export: { path: 'C:\\x\\beethoven', files: 2 },
    driven: { running: false, exit_code: 1, carry_on: carryOn, command: `cswap project-move auto --export="C:\\x\\beethoven" --to 2 --into ${carryOn}`, tail: [] },
  };
  const view = dup.duplicateView(job);
  assert.equal(view.canStart, true);
  assert.equal(view.after.show, true);
  assert.equal(view.after.button.show, false, 'no Import, which would make a second project');
  assert.match(view.after.command, /^cswap project-move auto .* --into https:\/\/claude\.ai\/code\/project\/chan_01CARRY$/, 'the command line\'s own line instead');
  assert.match(view.after.line, /the line below carries on in it from the command line/);
  assert.equal(view.noAccounts, '', 'no account to choose for an import that is not offered');
  assert.deepEqual(view.accounts.map(a => [a.slot, a.selected]), [['1', false], ['2', true], ['3', false]]);
  assert.match(dup.carryOnOnlyText(carryOn), /stopped part-way in https:\/\/claude\.ai\/code\/project\/chan_01CARRY.*a second project/);
  // Without one, Import is offered with the line that does the same.
  const fresh = dup.duplicateView({ ...job, driven: { ...job.driven, carry_on: '' } });
  assert.deepEqual(fresh.after.button, { show: true, label: 'Import', enabled: true });
  assert.equal(fresh.after.command, 'cswap project-move import --to 2 --folder="C:\\x\\beethoven"');
  assert.equal(fresh.after.line, 'The import could not start: the bridge refused: root-mismatch', 'a failed hand-off is newer than the stopped run it followed');
  assert.equal(dup.duplicateView({ ...job, chainError: '', driven: { ...job.driven, carry_on: '' } }).after.line, 'Stopped: see its last lines below.');
});

test('the texts about the import in its own window hold on every system: a console window only on Windows', () => {
  assert.match(dup.DRIVEN_RUNNING_TEXT, /on Windows, close its console window; elsewhere, end its process with kill/);
  assert.equal(dup.WAY_HELP, undefined, 'no way to choose it from the panel, so no help for one');
  assert.match(dup.NO_DRIVEN_TEXT, /or import in this tab\.$/);
});

test('duplicateView: no way to import is asked; a stored way changes no line; what came after a finished export is `after`', () => {
  const found = dup.projectChoices({ projects: [CODE], here: null });
  const finding = dup.duplicateView({ kind: 'export', phase: 'choosing', choices: found, accounts: dup.accountChoices(ACCOUNTS) });
  for (const gone of ['ways', 'wayHelp', 'wayHint', 'choosing', 'projects', 'hint', 'chainError', 'chainCommand', 'canRetryImport', 'driven']) {
    assert.ok(!(gone in finding), gone);
  }
  const exporting = { kind: 'export', phase: 'running', account: { email: 'a@example.com' }, importWay: 'driven',
    duplicate: { project: { id: CODE.id, name: 'beethoven' }, destination: { slot: '2', email: 'b@example.com' } } };
  assert.equal(dup.duplicateView(exporting).line, 'Exporting "beethoven" from a@example.com.');
  assert.equal(dup.duplicateView({ ...exporting, importWay: 'tab' }).line, dup.duplicateView(exporting).line);
  assert.equal(dup.duplicateView(exporting).after.show, false);
  const done = dup.duplicateView({ ...exporting, phase: 'done', driven: { running: true, pid: 9 } });
  assert.equal(done.line, '');
  assert.equal(done.after.running, true);
  assert.equal(done.after.line, 'Importing "beethoven" into Account-2 (b@example.com) in its own window (process 9). Sign in there if it asks; this panel follows what it says.');
  assert.equal(done.after.button.show, false);
  assert.equal(done.noAccounts, '');
});

test('isProjectUrl and the texts of the three buttons: a project page on claude.ai, of either kind', () => {
  for (const url of [`https://claude.ai/project/${RECIPES.id}`, `https://claude.ai/code/project/${CODE.id}`, `https://claude.ai/project/${RECIPES.id}?tab=files`,
    `https://claude.ai/project/${RECIPES.id}#top`, `https://claude.ai/code/project/${CODE.id}/`]) {
    assert.equal(dup.isProjectUrl(url), true, url);
  }
  for (const url of ['https://claude.ai/', 'https://claude.ai/projects', 'https://claude.ai/project/', 'https://claude.ai/project/?x', 'https://claude.ai/code',
    'https://claude.ai/code/project/', 'https://claude.ai/new', 'https://claude.ai/chat/x', 'http://claude.ai/project/x', 'https://www.claude.ai/project/x',
    'https://claude.ai.example/project/x', 'https://example.com/https://claude.ai/project/x', '', null, undefined, 7, { href: 'https://claude.ai/project/x' }]) {
    assert.equal(dup.isProjectUrl(url), false, String(url));
  }
  assert.match(dup.NOT_ON_A_PROJECT_TEXT, /claude\.ai\/project\/\.\.\. or claude\.ai\/code\/project\/\.\.\./);
  assert.match(dup.NOT_ON_A_PROJECT_TEXT, /press Export this project\.$/);
  assert.match(dup.NO_ACCOUNTS_TEXT, /`cswap add`.*press Export this project again\.$/);
  // The notification when an export is done, and the panel's line under
  // it, name the same next steps in the same order.
  for (const t of [dup.EXPORTED_NEXT_TEXT, dup.NEXT_STEPS_TEXT]) {
    assert.match(t, /press Sign out and reload, sign in as the other account.*choose it under Into account, and press Import\.$/);
  }
  assert.match(dup.EXPORTED_NEXT_TEXT, /^Exported\. Next, in the side panel: /);
  assert.match(dup.NEXT_STEPS_TEXT, /^Next: /);
});
