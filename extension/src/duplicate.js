// The Duplicate's own small pieces, pure so the panel's choices and the
// worker's texts are tested without a DOM or a worker: how the choices the
// page found are shaped for the panel, the project's page, what the page
// helper is told about the chosen project, what the person reads when the
// export hands over to the import, and how what came after a finished
// export is shown: its import running, done, stopped, or never started.
// The copy goes into whichever account is signed in when Import is
// pressed; the registry's accounts are not read, listed or offered. The
// one list a Duplicate has is which export on disk to import.

import { CLAUDE_URL_PREFIX } from './protocol.js';

// The page of a project on claude.ai, as the tab shows it: the project
// the person opened on purpose is the one exported.
export function isProjectUrl(url) {
  return typeof url === 'string' && /^https:\/\/claude\.ai\/(code\/)?project\/[^/?#]+/.test(url);
}
export const NOT_ON_A_PROJECT_TEXT = 'This tab is not on a project. Open the project you want to copy on claude.ai ' +
  '(its address is claude.ai/project/... or claude.ai/code/project/...), then press Export this project.';
// The notification when an export is done, and the panel's line under it.
export const EXPORTED_NEXT_TEXT = 'Exported. Next, in the side panel: press Sign out and reload, sign in as the other account, and press Import.';
export const NEXT_STEPS_TEXT = 'Next: press Sign out and reload, sign in as the other account on the page that opens, and press Import: the copy goes into the account you signed in as.';
// What the by-hand line and the texts say of the account the copy goes
// into when none is named: whichever one is signed in at Import.
export const SIGNED_IN_ACCOUNT_TEXT = 'the account signed in on the page';

// The bridge capability a Duplicate needs: a cswap without it has no
// export.new, file.write or import.queue, and the panel says to update it.
export const DUPLICATE_CAPABILITY = 'duplicate';
export const NO_DUPLICATE_TEXT = 'This cswap has no Duplicate yet. Update it (uv tool upgrade claude-swap, or pipx upgrade claude-swap), ' +
  'reload the extension and press Check now.';

// The bridge capability of the import in a window of its own: the host
// starts cswap's own `project-move auto --export` for a finished export,
// built from its job record, when asked with the job id alone.
export const DRIVEN_CAPABILITY = 'driven';
export const NO_DRIVEN_TEXT = 'This cswap cannot import in a window of its own yet. Update it (uv tool upgrade claude-swap, ' +
  'or pipx upgrade claude-swap), reload the extension and press Check now, or import in this tab.';
// The import in its own window has a console window only on Windows;
// elsewhere it runs with no window but its Chrome window, which it opens
// again once when that is closed, and `kill` ends it as Ctrl+C does.
export const DRIVEN_RUNNING_TEXT = 'The import of the last Duplicate is still running in its own window; wait for it to finish. ' +
  'To stop it: on Windows, close its console window; elsewhere, end its process with kill (the side panel shows its number).';
// How often the open panel asks how an import in its own window stands.
export const DRIVEN_POLL_MS = 5000;

// The bridge capability of dropping a job another browser profile holds
// (job.drop): an earlier copy of this extension, say, which a reinstall
// made a new instance of, leaving its job to block every job after it.
export const DROP_CAPABILITY = 'drop';
export const NO_DROP_TEXT = 'This cswap cannot drop a job from here yet. Cancel it with `cswap project-move import --cancel` ' +
  '(a job whose browser is gone is dropped fifteen minutes after that), or update cswap (uv tool upgrade claude-swap, or ' +
  'pipx upgrade claude-swap), reload the extension and press Check now.';
export const DROP_HINT_TEXT = 'If that job is an earlier copy of this extension\'s (before a reinstall, say), press Drop that job under Connection.';

// What the Connection section says of a job another browser profile holds,
// and whether Drop that job is offered: when this cswap can drop one.
export function elsewhereView(jobElsewhere, capable) {
  const e = obj(jobElsewhere);
  const id = text(e.id, 100);
  if (!id) return { line: '', canDrop: false, id: '' };
  const by = obj(e.claimed_by);
  const since = text(by.at, 40) ? ` since ${text(by.at, 40)}` : '';
  const head = `Job ${id} is claimed by another browser profile${since}.`;
  if (!capable) return { line: `${head} Wait for it, or cancel it with \`cswap project-move import --cancel\`.`, canDrop: false, id };
  return {
    line: `${head} If that browser is gone, or it was an earlier copy of this extension (before a reinstall, say), ` +
      'press Drop that job: the bridge ends it as cancelled, a browser still running it stops the next time it reports, and a new job can start here.',
    canDrop: true,
    id,
  };
}
const DRIVEN_TAIL_LINES = 12;

// How the copy is imported once the export is done: in this tab, as the
// import job the command line queues, once the person has signed out,
// signed in as the other account there and pressed Import. The import in
// a window of its own (`cswap project-move auto --export`) stays the
// command line's; the worker keeps its record of one started by an
// earlier version, and `importWay` keeps that record's meaning.
export const DEFAULT_IMPORT_WAY = 'tab';

const MAX_PROJECTS = 500;

// The panel's own labels for a project the site gave no name: shown in the
// list, never sent as a name (an older extension did send them).
export const WORKSPACE_LABEL = "This tab's workspace";
export const UNNAMED_LABEL = '(unnamed project)';

function text(value, max = 300) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// Whether a bridge's hello lists `capability`.
export function helloCan(hello, capability) {
  return !!(hello && typeof hello === 'object' && Array.isArray(hello.capabilities) && hello.capabilities.includes(capability));
}

// Whether the bridge, as the stored cswap.bridge record last heard it, can
// import in a window of its own.
export function drivenCapable(bridge) {
  return helloCan(obj(bridge).lastHello, DRIVEN_CAPABILITY);
}

// The way an import goes: in its own window when asked for (or by default)
// and the bridge can, in this tab otherwise.
export function importWay(value, capable) {
  return capable && value !== 'tab' ? 'driven' : 'tab';
}

// Whether `name` only stands in for a project's name: none at all, the
// project's id (which the bridge records when the panel sends no name), or
// one of the panel's own labels.
export function standInName(name, id) {
  const n = text(name, 500).trim();
  return !n || (typeof id === 'string' && n === id) || n === UNNAMED_LABEL || n.startsWith(`${WORKSPACE_LABEL} (`);
}

// The page of a project on claude.ai: /project/<uuid> for a regular one,
// /code/project/<id> for a Claude Code one.
export function projectUrl(project) {
  if (!project || typeof project !== 'object' || typeof project.id !== 'string' || !project.id) return CLAUDE_URL_PREFIX;
  const id = encodeURIComponent(project.id);
  return project.kind === 'code' ? `${CLAUDE_URL_PREFIX}code/project/${id}` : `${CLAUDE_URL_PREFIX}project/${id}`;
}

// What the page helper is told about the chosen project, so the export
// script's own question (which project, which organization) is answered.
export function bootProject(project) {
  if (!project || typeof project !== 'object' || typeof project.id !== 'string' || !project.id) return null;
  return {
    id: project.id,
    name: text(project.name, 500),
    kind: project.kind === 'code' ? 'code' : 'standard',
    orgUuid: text(project.org_uuid || project.orgUuid, 100),
    orgName: text(project.org_name || project.orgName, 200),
  };
}

// The projects the page listed, checked and in the order the panel shows
// them: the one the tab is showing first, then by name. `name` is what the
// site calls the project, '' when it gives no name, and is what the bridge
// is sent; `label` is only what the panel shows, so a stand-in for a
// missing name never ends up recorded as the project's name.
export function projectChoices(found) {
  const f = found && typeof found === 'object' ? found : {};
  const here = f.here && typeof f.here === 'object' && typeof f.here.id === 'string' ? { id: f.here.id, kind: f.here.kind === 'code' ? 'code' : 'standard' } : null;
  const seen = new Set();
  const projects = [];
  for (const row of Array.isArray(f.projects) ? f.projects : []) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id) continue;
    const kind = row.kind === 'code' ? 'code' : 'standard';
    // A Claude Code project belongs to no organization: one that an
    // organization's list and the channel list both return is one project.
    const key = kind === 'code' ? row.id : `${row.orgUuid || ''}/${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = text(row.name, 200).trim();
    projects.push({
      id: row.id,
      name,
      label: name || UNNAMED_LABEL,
      kind,
      orgUuid: text(row.orgUuid, 100),
      orgName: text(row.orgName, 200),
      archived: row.archived === true,
    });
    if (projects.length >= MAX_PROJECTS) break;
  }
  projects.sort((a, b) => {
    const ah = here && a.id === here.id ? 0 : 1;
    const bh = here && b.id === here.id ? 0 : 1;
    if (ah !== bh) return ah - bh;
    return a.label.localeCompare(b.label);
  });
  // A Claude Code workspace open in the tab is exported even when neither
  // the channel list nor the channel's own record named it, as the export
  // script does it. It is offered by its id and sent with no name: the
  // bridge records the id, and the export's own export.json names the
  // project once it is written.
  if (here && here.kind === 'code' && !projects.some(p => p.id === here.id)) {
    projects.unshift({ id: here.id, name: '', label: `${WORKSPACE_LABEL} (${here.id})`, kind: 'code', orgUuid: '', orgName: '', archived: false });
  }
  const orgs = (Array.isArray(f.orgs) ? f.orgs : []).filter(o => o && typeof o === 'object' && typeof o.uuid === 'string')
    .map(o => ({ uuid: text(o.uuid, 100), name: text(o.name, 200), apiOnly: o.apiOnly === true, error: typeof o.error === 'string' ? text(o.error, 200) : null }));
  return { projects, orgs, here, error: typeof f.error === 'string' ? text(f.error, 300) : null, codeList: codeListOf(f.codeList) };
}

// How the page's reading of claude.ai's Claude Code project list went,
// checked: the first answer's status, the rows it named over how many
// pages, and whether it reached its end. Null when the list was not asked
// for (an older page helper, or a listing that stopped before it).
export function codeListOf(value) {
  const c = obj(value);
  if (!Number.isInteger(c.status)) return null;
  const count = v => (Number.isInteger(v) && v >= 0 ? v : 0);
  return { status: c.status, rows: count(c.rows), pages: count(c.pages), complete: c.complete === true };
}

// What the panel says under the projects when claude.ai answered its
// Claude Code project list with nothing: on its own, or next to the one
// project the tab shows, which was asked for by itself.
export const EMPTY_CODE_LIST_TEXT = 'claude.ai listed no Claude Code project for this account.';
export const EMPTY_CODE_LIST_HERE_TEXT = "claude.ai's list of Claude Code projects came back empty; only the project this tab shows could be named.";

// Whether claude.ai answered the Claude Code project list and named no
// project in it: an empty list, not one that was never read.
export function codeListEmpty(choices) {
  const c = obj(obj(choices).codeList);
  return c.status >= 200 && c.status < 300 && c.pages > 0 && c.rows === 0 && c.complete === true;
}

// What the worker logs of a listing: how many projects of each kind (the
// panel's stand-in for the tab's unnamed project not counted), how many
// organizations, and how the Claude Code list went.
export function listingSummary(choices) {
  const c = obj(choices);
  const projects = Array.isArray(c.projects) ? c.projects : [];
  const standIn = p => typeof p.label === 'string' && p.label.startsWith(`${WORKSPACE_LABEL} (`);
  return {
    regular: projects.filter(p => p && p.kind !== 'code').length,
    code: projects.filter(p => p && p.kind === 'code' && !standIn(p)).length,
    orgs: Array.isArray(c.orgs) ? c.orgs.length : 0,
    codeList: codeListOf(c.codeList),
    error: typeof c.error === 'string' && c.error ? c.error : null,
  };
}

// What a line to type says in place of a name it cannot carry, as cswap's
// own lines do: a comment, so PowerShell and POSIX shells run the rest and
// the person sees why (cmd refuses the line instead).
export const UNTYPED_NAME_NOTE = "# add --name yourself: no quoting carries the copy's name whole on a line to copy";

// A value as it goes after `--option=` on a line to type, so a value that
// starts with `-` is never read as an option of its own; '' when no quoting
// keeps it whole. Double quotes when it holds no `$`, backtick or double
// quote, which PowerShell, cmd and POSIX shells all read alike; single
// quotes, which PowerShell and POSIX shells keep as they are, when it holds
// `$` or a backtick but no quote of either kind; nothing otherwise. A
// trailing backslash inside quotes reads as escaping the closing quote.
export function typedValue(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value) || /\\$/.test(value)) return '';
  if (!/["$`]/.test(value)) return `"${value}"`;
  if (!/["']/.test(value)) return `'${value}'`;
  return '';
}

// The line that imports an export by hand: `where` is its folder (or
// .tar), `slot` the account's number when one is known (else NUM, for the
// person to fill in), `copyName` the name typed for the copy, if any.
export function importLine({ where = '', slot = '', copyName = '' } = {}) {
  const folder = typedValue(text(where, 1000));
  const name = text(copyName, 300).trim();
  const typedName = typedValue(name);
  const named = typedName ? ` --name=${typedName}` : '';
  const note = name && !typedName ? `  ${UNTYPED_NAME_NOTE}` : '';
  return `cswap project-move import --to ${slot || 'NUM'}${folder ? ` --folder=${folder}` : ''}${named}${note}`;
}

// What the person reads when the export hands over to the import, and
// when it cannot, with the line that imports it by hand. The project is
// named by its own name; a stand-in for one (see standInName) gives way to
// the name typed for the copy, then the export's. The account is the one
// the record names, which only an earlier version's export does; else the
// copy goes into whichever account is signed in, and the line to type
// leaves the account's number (NUM) for the person to fill in.
export function chainTexts(exportJob) {
  const j = obj(exportJob);
  const dup = obj(j.duplicate);
  const project = obj(dup.project);
  const dest = obj(dup.destination);
  const exp = obj(j.export);
  const name = [project.name, dup.name, exp.name].map(n => text(n, 200).trim()).find(n => n && !standInName(n, project.id)) || 'the project';
  const files = Number(exp.files) || 0;
  const where = text(exp.path, 1000);
  const slot = text(dest.slot, 20);
  const copyName = text(dup.name, 300).trim();
  const into = slot || text(dest.email, 200) ? `Account-${slot || '?'} (${text(dest.email, 200) || '?'})` : SIGNED_IN_ACCOUNT_TEXT;
  const folder = typedValue(where);
  const typedName = typedValue(copyName);
  const named = typedName ? ` --name=${typedName}` : '';
  const note = copyName && !typedName ? `  ${UNTYPED_NAME_NOTE}` : '';
  const command = importLine({ where, slot, copyName });
  // The same import in a window of its own, as the bridge would start it.
  const drivenCommand = folder && slot ? `cswap project-move auto --export=${folder} --to ${slot}${named}${note}` : '';
  const exported = `Exported "${name}" (${files} file${files === 1 ? '' : 's'}).`;
  return {
    importing: `${exported} Importing it into ${into}.`,
    drivenStarted: `${exported} Importing it into ${into} in a window of its own.`,
    notImported: `The export of "${name}" is saved${where ? ` at ${where}` : ''}, but its import into ${into} could not start.` +
      ` Import it by hand with: ${command}.${drivenCommand ? ` Or, in a window of its own: ${drivenCommand}.` : ''}`,
    command,
    drivenCommand,
  };
}

// What the bridge says of an import in its own window, checked and cut to
// what the panel shows: only claude.ai addresses, a short tail.
export function drivenRecord(reply) {
  const r = obj(reply);
  const url = v => (typeof v === 'string' && v.startsWith(CLAUDE_URL_PREFIX) && !/[\s?#]/.test(v) ? v.slice(0, 500) : '');
  const int = v => (Number.isInteger(v) ? v : null);
  return {
    running: r.running === true,
    lost: r.lost === true,
    pid: int(r.pid),
    attempt: int(r.attempt) || 0,
    started_at: text(r.started_at, 40),
    ended_at: text(r.ended_at, 40),
    exit_code: int(r.exit_code),
    url: url(r.url),
    carry_on: url(r.carry_on),
    made: url(r.made),
    message: text(r.message, 500),
    command: text(r.command, 2000),
    log: text(r.log, 1000),
    tail: (Array.isArray(r.tail) ? r.tail : []).filter(l => typeof l === 'string').slice(-DRIVEN_TAIL_LINES).map(l => l.slice(0, 300)),
  };
}

// The name the copy gets: the one typed for it, else the project's own.
function copyName(j) {
  const dup = obj(j.duplicate);
  const project = obj(dup.project);
  return [dup.name, project.name, obj(j.export).name].map(n => text(n, 200).trim()).find(n => n && !standInName(n, project.id)) || 'the project';
}

// What the side panel says when the import in this tab is asked for while
// the import in its own window left a part-made copy to carry on in: the
// import in this tab always makes a new project.
export function carryOnOnlyText(carryOn) {
  return `The import in its own window stopped part-way in ${carryOn}, which holds what was added; ` +
    'Carry on goes on in it. An import in this tab would make a second project beside it.';
}

// What the panel says of what came after a finished export: the export,
// waiting for the person to sign out, sign in as the other account and
// press Import; the import that could not start, with why; or the record
// of an import in a window of its own that an earlier version started
// (running, done with the new project's link, stopped with the link or
// the part-made copy to carry on in, lost); with the line that imports
// the export by hand. The buttons are not here: they stay in place
// whatever came after (greg, 2026-10-07: no dynamic changes to the button
// layout), and the worker answers a press at the wrong moment with why.
// A part-made Claude Code copy is only ever carried on in its own window,
// so next to one the line to type is the command line's own, and the
// line says that an import in this tab makes a second project.
export function afterExportView(job) {
  const j = obj(job);
  const off = { show: false, running: false, line: '', link: '', tail: [], command: '' };
  if (j.kind !== 'export' || j.phase !== 'done') return off;
  const d = j.driven && typeof j.driven === 'object' ? drivenRecord(j.driven) : null;
  const chainError = typeof j.chainError === 'string' ? j.chainError : '';
  const name = copyName(j);
  const exp = obj(j.export);
  const files = Number(exp.files) || 0;
  const where = text(exp.path, 1000);
  const dest = obj(obj(j.duplicate).destination);
  const email = text(dest.email, 200);
  const into = text(dest.slot, 20) || email ? `Account-${text(dest.slot, 20) || '?'} (${email || '?'})` : SIGNED_IN_ACCOUNT_TEXT;
  const texts = chainTexts(j);
  const command = d && d.carry_on ? d.command || texts.drivenCommand : texts.command;
  // The run's own last word, without its full stop: the line adds one.
  const said = message => (message || 'see its last lines below').replace(/\.$/, '');
  const view = { ...off, show: true, tail: d ? d.tail : [], command };
  if (!d && !chainError) {
    view.line = `Exported "${name}" (${files} file${files === 1 ? '' : 's'})${where ? ` to ${where}` : ''}. ${NEXT_STEPS_TEXT}`;
  } else if (!d || (chainError && !d.running && !d.carry_on)) {
    // Import clears the error before it tries, so one on record is the
    // newest thing that happened, newer than a stopped run's record.
    view.line = `The import could not start: ${chainError}`;
  } else if (d.running) {
    view.running = true;
    view.line = `Importing "${name}" into ${into} in its own window${d.pid ? ` (process ${d.pid})` : ''}. Sign in there if it asks; this panel follows what it says.`;
  } else if (d.exit_code === 0) {
    view.line = d.url ? `Done: the copy is at ${d.url}.` : `Done, but the window did not say where; look for "${name}" among ${email || 'that account'}'s projects.`;
    view.link = d.url;
  } else if (d.carry_on) {
    const why = d.lost ? 'the window closed before it said how it ended' : said(d.message);
    view.line = `Stopped: ${why}. ${d.carry_on} holds what was added; the line below carries on in it from the command line, and nothing is made twice. ` +
      'An import in this tab would make a second project beside it.';
  } else if (d.made) {
    // A regular project, which the import script cannot carry on in.
    const why = d.lost ? 'the window closed before it said how it ended' : said(d.message);
    view.line = `Stopped: ${why}. ${d.made} holds what was added before the stop. cswap cannot carry on in a regular project, ` +
      'so Import makes a new one beside it; delete that one first if you do not want it.';
    view.link = d.made;
  } else if (d.lost) {
    view.line = `The import's window closed before it said how it ended. Check ${email || 'that account'}'s projects for a part-made copy before importing again.`;
  } else {
    // Stopped by the person (130: Ctrl+C, or its window closed) with no
    // project named: one may still have been made a moment before.
    const check = d.exit_code === 130 ? ` Check ${email || 'that account'}'s projects for a part-made copy before importing again.` : '';
    view.line = `Stopped: ${said(d.message)}.${check}`;
  }
  return view;
}

// Whether the worker's record of a finished export lacks what only the
// bridge knows: the folder it was written to, or the project's own name.
export function needsHostRecord(exportJob) {
  const j = obj(exportJob);
  const project = obj(obj(j.duplicate).project);
  return !text(obj(j.export).path, 1000) || (!!project.id && standInName(project.name, project.id));
}

// The worker's record of a finished export, with what the bridge's record
// of it adds: the folder, and the project's own name in place of a stand-in
// (the bridge names a project offered by its id alone from its export.json
// once the export is done). `hostJob` is the bridge's record of that export
// job, or of the import queued from it; anything else adds nothing. Gives
// the `export` and `duplicate` fields to save.
export function withHostRecord(exportJob, hostJob) {
  const j = obj(exportJob);
  const h = obj(hostJob);
  const exp = { ...obj(j.export) };
  const dup = { ...obj(j.duplicate) };
  const hostDup = obj(h.duplicate);
  const sameJob = typeof h.id === 'string' && h.id === j.id;
  const importOfIt = typeof hostDup.export_job === 'string' && hostDup.export_job === j.id;
  if (!sameJob && !importOfIt) return { export: exp, duplicate: dup };
  const hostExp = obj(h.export);
  if (!text(exp.path, 1000) && text(hostExp.path, 1000)) exp.path = text(hostExp.path, 1000);
  const project = obj(dup.project);
  const hostProject = sameJob ? obj(hostDup.project) : obj(obj(hostDup.source).project);
  const own = [hostProject.name, hostExp.name].map(n => text(n, 500).trim()).find(n => n && !standInName(n, project.id)) || '';
  if (own) {
    if (standInName(exp.name, project.id)) exp.name = own;
    if (dup.project && typeof dup.project === 'object' && standInName(project.name, project.id)) dup.project = { ...project, name: own };
  }
  return { export: exp, duplicate: dup };
}

// The exports on disk, as the bridge lists them (`exports.list`) and the
// panel offers them: which one to import is the one list a Duplicate has;
// the account is never chosen, only detected.
export const EXPORTS_CAPABILITY = 'exports';
export const EXPORTS_MAX = 100;
export const NO_EXPORTS_TEXT = 'This cswap cannot list the exports on disk yet. Update it (uv tool upgrade claude-swap, or ' +
  'pipx upgrade claude-swap), then press Check now; until then only the export just made can be imported from here.';

// The bridge's answer to exports.list, checked field by field and cut to
// what the panel shows, newest first as the bridge lists them; `at` is
// when it was asked. A row that names no path is not an export.
export function exportsListing(reply, at = 0) {
  const r = obj(reply);
  const rows = Array.isArray(r.exports) ? r.exports : [];
  const exports = [];
  for (const row of rows) {
    const e = obj(row);
    const path = text(e.path, 1000);
    if (!path) continue;
    exports.push({
      path,
      name: text(e.name, 300).trim(),
      kind: e.kind === 'code' ? 'code' : 'standard',
      files: Number.isInteger(e.files) && e.files >= 0 ? e.files : 0,
      conversations: Number.isInteger(e.conversations) && e.conversations >= 0 ? e.conversations : 0,
      finishedAt: text(e.finished_at, 40),
      archive: e.archive === true,
    });
    if (exports.length >= EXPORTS_MAX) break;
  }
  return { at, capable: true, folder: text(r.folder, 1000), exports, unfinished: Number.isInteger(r.unfinished) && r.unfinished > 0 ? r.unfinished : 0 };
}

// Two paths of the same export as the bridge names it twice (the export
// job's record and the list): the same text, whatever the case or a
// slash at the end.
export function samePath(a, b) {
  const norm = p => text(p, 1000).replace(/[\\/]+$/, '').toLowerCase();
  return !!norm(a) && norm(a) === norm(b);
}

function pathName(path) {
  const parts = text(path, 1000).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// One line of the list: the export's folder, the project's name when it
// differs, the kind, the size and the date.
export function exportLabel(entry) {
  const e = obj(entry);
  const folder = pathName(e.path);
  const name = text(e.name, 300).trim();
  const kind = e.kind === 'code' ? 'Claude Code project' : 'project';
  const files = Number(e.files) || 0;
  const when = text(e.finishedAt, 40).slice(0, 16).replace('T', ' ');
  return `${folder}${name && name !== folder ? ` (${name})` : ''}: ${kind}, ${files} file${files === 1 ? '' : 's'}${when ? `, ${when}` : ''}`;
}

// The list as the panel shows it: the exports on disk, with the export
// this browser just finished first and chosen, whether or not the list has
// it (an older bridge lists nothing). `wanted` is the value the person
// chose before, kept while it is still offered. `own` is that export's
// path, so Import knows when the choice is the export just made.
export function exportChoices(listing, exportJob, wanted = '') {
  const l = obj(listing);
  const rows = Array.isArray(l.exports) ? l.exports : [];
  const j = obj(exportJob);
  const own = j.kind === 'export' && j.phase === 'done' ? text(obj(j.export).path, 1000) : '';
  const options = [];
  const listed = rows.find(e => samePath(e.path, own));
  if (own) {
    const exp = obj(j.export);
    const entry = listed || { path: own, name: copyName(j), kind: exp.kind === 'code' ? 'code' : 'standard', files: Number(exp.files) || 0, finishedAt: '' };
    options.push({ value: own, label: `${exportLabel(entry)} (just made)` });
  }
  for (const e of rows) {
    if (own && samePath(e.path, own)) continue;
    options.push({ value: e.path, label: exportLabel(e) });
  }
  const offered = options.find(o => o.value === wanted);
  const chosen = offered ? offered.value : options.length ? options[0].value : '';
  return { options, chosen, own };
}

// What the list says when there is no export on this computer to choose:
// its one entry, which chooses nothing.
export const NO_EXPORT_YET_TEXT = 'No export on this computer yet';

// What the worker answers an Import pressed with nothing to import.
export const NO_EXPORT_CHOSEN_TEXT = 'No export to import yet. Press Export this project first; an export made with ' +
  '`cswap project-move export` is in the list once it is in the exports folder (press Check now to list again).';

// The side panel's view of a Duplicate: the line while the export or the
// import runs, the exports on disk to choose from (`choices`, the one
// list, which stands whatever runs), and what came after a finished
// export (`after`), with the line that imports the chosen export by hand
// once nothing runs. The three buttons are not here: they are always in
// place (greg, 2026-10-07: "the user should always be able to click
// export, or import, or logout"), and the worker answers a press at the
// wrong moment with why. No account to import into is offered: the copy
// goes into whichever one is signed in when Import is pressed. `wanted`
// is the export the person chose in the list.
export function duplicateView(job, listing = null, wanted = '') {
  const j = job && typeof job === 'object' ? job : null;
  const terminal = !j || ['done', 'failed', 'cancelled'].includes(j.phase);
  const kind = j && j.kind === 'export' ? 'export' : 'import';
  const dup = j && j.duplicate && typeof j.duplicate === 'object' ? j.duplicate : null;
  const project = dup && dup.project && typeof dup.project === 'object' ? dup.project : null;
  const source = dup && dup.source && typeof dup.source === 'object' ? dup.source : null;
  const sourceEmail = j && j.account ? text(j.account.email, 200) : '';
  const after = afterExportView(j);

  let line = '';
  if (!j) line = '';
  else if (kind === 'export' && !terminal && !project) line = `Finding this tab's project and who is signed in${sourceEmail ? ` (${sourceEmail})` : ''}.`;
  else if (kind === 'export' && !terminal && project) line = `Exporting "${copyName(j)}" from ${sourceEmail || 'this account'}.`;
  else if (kind === 'import' && dup) line = `Importing the copy of "${source && source.project ? text(source.project.name, 200) : 'a project'}" from ${source && text(source.email, 200) ? text(source.email, 200) : 'the other account'}.`;

  const choices = exportChoices(listing, j, wanted);
  if (!terminal) {
    // While a job runs, the text block is quiet; the list stays as it is.
    after.command = '';
  } else if (choices.chosen && !(after.command && samePath(choices.chosen, choices.own))) {
    // The line to type follows the choice; only the export just made keeps
    // the line its own record gives (its name, or the run to carry on).
    after.command = importLine({ where: choices.chosen });
  }
  after.show = !!(after.line || after.link || after.tail.length || after.command);
  return { line, after, choices };
}
