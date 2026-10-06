// The Duplicate's own small pieces, pure so the panel's choices and the
// worker's texts are tested without a DOM or a worker: how the choices the
// page found and the accounts the bridge listed are shaped for the panel,
// which account to offer first, the project's page, what the page helper is
// told about the chosen project, what the person reads when the export
// hands over to the import, and how an import in a window of its own is
// shown.

import { CLAUDE_URL_PREFIX } from './protocol.js';

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
const DRIVEN_TAIL_LINES = 12;

// How the copy is imported once the export is done. In its own window is
// the route `cswap project-move auto` already runs: a Chrome window of its
// own for the account the copy goes into, so this tab stays signed in as it
// is. In this tab is the import job the command line queues.
export const DEFAULT_IMPORT_WAY = 'driven';
export const IMPORT_WAYS = Object.freeze([
  Object.freeze({ value: 'driven', label: 'In its own window, like the command line' }),
  Object.freeze({ value: 'tab', label: 'In this tab' }),
]);
export const WAY_HELP = Object.freeze({
  driven: 'cswap opens a Chrome window of its own for the account you copy into, and imports there, as cswap project-move auto does ' +
    '(on Windows with a console window that shows how it goes); the first time, sign in there once. This tab stays as it is.',
  tab: 'The import runs in this tab: when it asks, sign in here as the account you copy into, then press Resume.',
});
export const NO_DRIVEN_WAY_HINT = 'This cswap cannot import in a window of its own yet; update it (uv tool upgrade claude-swap) to choose that.';

const MAX_PROJECTS = 500;
const MAX_ACCOUNTS = 100;

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
  return { projects, orgs, here, error: typeof f.error === 'string' ? text(f.error, 300) : null };
}

// The accounts the bridge listed, checked, with the line the panel shows.
export function accountChoices(list) {
  const out = [];
  for (const row of Array.isArray(list) ? list : []) {
    if (!row || typeof row !== 'object' || typeof row.slot !== 'string' || !row.slot) continue;
    const email = text(row.email, 200);
    const organization = text(row.organization, 200);
    const alias = text(row.alias, 100);
    const usable = row.usable !== false;
    out.push({
      slot: row.slot,
      email,
      organization,
      alias,
      kind: row.kind === 'api_key' ? 'api_key' : 'oauth',
      usable,
      why: usable ? '' : text(row.why, 200),
      label: `Account-${row.slot}${alias ? ` (${alias})` : ''}: ${email || 'no email'}${organization ? `, ${organization}` : ''}${usable ? '' : ` (${text(row.why, 200) || 'not usable'})`}`,
    });
    if (out.length >= MAX_ACCOUNTS) break;
  }
  return out;
}

// The account to offer first: the first usable one that is not the
// account the project is in, else the first usable one, else none.
export function defaultDestination(accounts, sourceEmail) {
  const source = text(sourceEmail, 200).trim().toLowerCase();
  const usable = (Array.isArray(accounts) ? accounts : []).filter(a => a && a.usable !== false);
  const other = usable.find(a => !source || text(a.email).trim().toLowerCase() !== source);
  return (other || usable[0] || { slot: '' }).slot;
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

// What the person reads when the export hands over to the import, and
// when it cannot, with the line that imports it by hand. The project is
// named by its own name; a stand-in for one (see standInName) gives way to
// the name typed for the copy, then the export's.
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
  const into = `Account-${slot || '?'} (${text(dest.email, 200) || '?'})`;
  const folder = typedValue(where);
  const typedName = typedValue(copyName);
  const named = typedName ? ` --name=${typedName}` : '';
  const note = copyName && !typedName ? `  ${UNTYPED_NAME_NOTE}` : '';
  const command = `cswap project-move import --to ${slot || 'NUM'}${folder ? ` --folder=${folder}` : ''}${named}${note}`;
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
    'Carry on in its own window goes on in it. An import in this tab would make a second project beside it.';
}

// The panel's view of the import in a window of its own, for a finished
// export: offered when its hand-off failed and the bridge can, then running,
// done, stopped (with Carry on when it made a Claude Code project, with the
// link when it made a regular one) or lost.
export function drivenView(job, { capable = false } = {}) {
  const j = obj(job);
  const off = { show: false, running: false, line: '', link: '', tail: [], command: '', button: { show: false, label: '', enabled: false } };
  if (j.kind !== 'export' || j.phase !== 'done') return off;
  const dest = obj(obj(j.duplicate).destination);
  const slot = text(dest.slot, 20);
  const email = text(dest.email, 200);
  if (!slot && !email) return off;
  const d = j.driven && typeof j.driven === 'object' ? drivenRecord(j.driven) : null;
  const chainError = typeof j.chainError === 'string' && j.chainError;
  if (!d && !(capable && chainError)) return off;
  const name = copyName(j);
  const into = `Account-${slot || '?'} (${email || '?'})`;
  const command = (d && d.command) || chainTexts(j).drivenCommand;
  const button = (label, show = true) => ({ show, label, enabled: show && capable });
  const view = { show: true, running: false, line: '', link: '', tail: d ? d.tail : [], command, button: button('', false) };
  if (!d) {
    view.line = `Or import "${name}" into ${into} in a window of its own, as cswap project-move auto does: cswap opens Chrome for that account; sign in there the first time.`;
    view.button = button('Import in its own window');
  } else if (d.running) {
    view.running = true;
    view.line = `Importing "${name}" into ${into} in its own window${d.pid ? ` (process ${d.pid})` : ''}. Sign in there if it asks; this panel follows what it says.`;
  } else if (d.exit_code === 0) {
    view.line = d.url ? `Done: the copy is at ${d.url}.` : `Done, but the window did not say where; look for "${name}" among ${email || 'that account'}'s projects.`;
    view.link = d.url;
  } else if (d.carry_on) {
    const why = d.lost ? 'the window closed before it said how it ended' : d.message || 'see its last lines below';
    view.line = `Stopped: ${why}. ${d.carry_on} holds what was added; Carry on goes on in it, and nothing is made twice.`;
    view.button = button('Carry on in its own window');
  } else if (d.made) {
    // A regular project, which the import script cannot carry on in.
    const why = d.lost ? 'the window closed before it said how it ended' : d.message || 'see its last lines below';
    view.line = `Stopped: ${why}. ${d.made} holds what was added before the stop. cswap cannot carry on in a regular project, ` +
      'so Try again makes a new one beside it; delete that one first if you do not want it.';
    view.link = d.made;
    view.button = button('Try again in its own window');
  } else if (d.lost) {
    view.line = `The import's window closed before it said how it ended. Check ${email || 'that account'}'s projects for a part-made copy before trying again.`;
    view.button = button('Try again in its own window');
  } else {
    // Stopped by the person (130: Ctrl+C, or its window closed) with no
    // project named: one may still have been made a moment before.
    const check = d.exit_code === 130 ? ` Check ${email || 'that account'}'s projects for a part-made copy before trying again.` : '';
    view.line = `Stopped: ${d.message || 'see its last lines below'}.${check}`;
    view.button = button('Try again in its own window');
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

// The side panel's view of a Duplicate, from the job record alone, and
// whether the bridge can import in a window of its own.
export function duplicateView(job, { drivenCapable: capable = false } = {}) {
  const j = job && typeof job === 'object' ? job : null;
  const terminal = !j || ['done', 'failed', 'cancelled'].includes(j.phase);
  const kind = j && j.kind === 'export' ? 'export' : 'import';
  const dup = j && j.duplicate && typeof j.duplicate === 'object' ? j.duplicate : null;
  const project = dup && dup.project && typeof dup.project === 'object' ? dup.project : null;
  const dest = dup && dup.destination && typeof dup.destination === 'object' ? dup.destination : null;
  const source = dup && dup.source && typeof dup.source === 'object' ? dup.source : null;
  const choosing = !!j && kind === 'export' && j.phase === 'choosing';
  const choices = choosing && j.choices && typeof j.choices === 'object' ? j.choices : null;
  const sourceEmail = j && j.account ? text(j.account.email, 200) : '';
  const accounts = j && Array.isArray(j.accounts) ? j.accounts : [];
  const defaultSlot = choosing ? defaultDestination(accounts, sourceEmail) : '';
  const hereId = choices && choices.here ? choices.here.id : '';
  const projects = choices ? choices.projects.map((p, i) => ({
    id: p.id,
    label: `${p.label || p.name || p.id}${p.kind === 'code' ? '  [code]' : ''}${p.orgName && choices.orgs.length > 1 ? `  (${p.orgName})` : ''}${p.archived ? '  (archived)' : ''}`,
    selected: hereId ? p.id === hereId : i === 0,
  })) : [];

  let line = '';
  if (!j) line = 'Copy a project from the signed-in account into another account cswap knows: the export and the import run here, one after the other.';
  else if (kind === 'export' && !terminal && !project) line = `Duplicate: finding the projects ${sourceEmail ? `${sourceEmail} ` : ''}can see.`;
  else if (kind === 'export' && project) {
    line = `Duplicate: exporting "${text(project.name, 200)}" from ${sourceEmail || 'this account'} for Account-${dest ? dest.slot : '?'} (${dest ? dest.email : '?'}).` +
      (j.importWay === 'driven' ? ' The copy is then imported in its own window.' : j.importWay === 'tab' ? ' The copy is then imported in this tab.' : '');
  }
  else if (kind === 'import' && dup) line = `Duplicate of "${source && source.project ? text(source.project.name, 200) : 'a project'}" from ${source ? source.email : '?'}, now importing.`;
  const chainError = j && typeof j.chainError === 'string' && j.chainError ? j.chainError : '';
  // A part-made copy the import in its own window left: only that import
  // goes on in it, so neither Try the import again nor the in-tab line is
  // offered next to it (each would make a second project).
  const carryOn = j && j.driven && typeof j.driven === 'object' && typeof j.driven.carry_on === 'string' ? j.driven.carry_on : '';
  // An export that ended without its import: Try the import again is
  // offered, with the line that does it by hand.
  const canRetryImport = !!j && kind === 'export' && j.phase === 'done' && !!chainError && !carryOn;
  const way = importWay(j && j.importWay ? j.importWay : DEFAULT_IMPORT_WAY, capable);

  return {
    canStart: terminal,
    choosing,
    line,
    projects,
    accounts: accounts.map(a => ({ slot: a.slot, label: a.label, disabled: a.usable === false, selected: a.slot === defaultSlot })),
    hint: choices
      ? (choices.error ? `Some projects could not be listed: ${choices.error}` : projects.length ? '' : 'No project was found for this account.')
      : '',
    noAccounts: choosing && !accounts.some(a => a.usable !== false)
      ? 'cswap knows no account an import can go into. Add one with `cswap add`, then start the Duplicate again.'
      : '',
    chainError,
    chainCommand: chainError && !carryOn ? chainTexts(j).command : '',
    canRetryImport,
    ways: IMPORT_WAYS.map(w => ({ value: w.value, label: w.label, selected: w.value === way, disabled: w.value === 'driven' && !capable })),
    wayHelp: WAY_HELP[way],
    wayHint: capable ? '' : NO_DRIVEN_WAY_HINT,
    driven: drivenView(j, { capable }),
  };
}
