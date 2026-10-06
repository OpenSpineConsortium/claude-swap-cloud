// The Duplicate's own small pieces, pure so the panel's choices and the
// worker's texts are tested without a DOM or a worker: how the choices the
// page found and the accounts the bridge listed are shaped for the panel,
// which account to offer first, the project's page, what the page helper is
// told about the chosen project, and what the person reads when the export
// hands over to the import.

import { CLAUDE_URL_PREFIX } from './protocol.js';

// The bridge capability a Duplicate needs: a cswap without it has no
// export.new, file.write or import.queue, and the panel says to update it.
export const DUPLICATE_CAPABILITY = 'duplicate';
export const NO_DUPLICATE_TEXT = 'This cswap has no Duplicate yet. Update it (uv tool upgrade claude-swap, or pipx upgrade claude-swap), ' +
  'reload the extension and press Check now.';

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

// A value the line to type can carry in double quotes. The line is pasted
// into PowerShell on Windows, which expands `$` and a backtick inside them,
// so a value with one of those (or a double quote) is left off the line
// rather than run with a changed meaning.
function typeable(value) {
  return !!value && !/["$`\x00-\x1f]/.test(value);
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
  const command = `cswap project-move import --to ${slot || 'NUM'}` +
    `${typeable(where) ? ` --folder "${where}"` : ''}${typeable(copyName) ? ` --name "${copyName}"` : ''}`;
  return {
    importing: `Exported "${name}" (${files} file${files === 1 ? '' : 's'}). Importing it into ${into}.`,
    notImported: `The export of "${name}" is saved${where ? ` at ${where}` : ''}, but its import into ${into} could not start.` +
      ` Import it by hand with: ${command}.`,
    command,
  };
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

// The side panel's view of a Duplicate, from the job record alone.
export function duplicateView(job) {
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
  else if (kind === 'export' && project) line = `Duplicate: exporting "${text(project.name, 200)}" from ${sourceEmail || 'this account'} for Account-${dest ? dest.slot : '?'} (${dest ? dest.email : '?'}).`;
  else if (kind === 'import' && dup) line = `Duplicate of "${source && source.project ? text(source.project.name, 200) : 'a project'}" from ${source ? source.email : '?'}, now importing.`;
  const chainError = j && typeof j.chainError === 'string' && j.chainError ? j.chainError : '';
  // An export that ended without its import: Try the import again is
  // offered, with the line that does it by hand.
  const canRetryImport = !!j && kind === 'export' && j.phase === 'done' && !!chainError;

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
    chainCommand: chainError ? chainTexts(j).command : '',
    canRetryImport,
  };
}
