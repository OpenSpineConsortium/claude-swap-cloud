// What the extension needs on this computer before a job can run, as a
// checklist the side panel shows with the exact command that remedies each
// missing piece. Nothing here runs a command: the extension has no way to,
// and that is the point. It names the step, the person types it, then
// presses Check now. setupSteps() is pure, so the texts are tested without
// a DOM.
//
// The order is the order of the dependence: Chrome's own switch first,
// then cswap and its bridge, then a queued job. The first step that is not
// done is the one to do; the ones after it cannot be judged until it is.

// The cswap this extension needs (the bridge, project-move) is Claude Swap
// Cloud from this repository, not the claude-swap on PyPI (the upstream it
// was forked from, which has no bridge), so the installer lines
// name the repository: the extension's own manifest carries its address
// as homepage_url, and that is the one source of it here. One command
// works in PowerShell, Terminal and a shell alike, so the panel shows the
// same text on every platform. A private repository needs the person's
// own git sign-in, which git asks for.
export const SOURCE_REPO = 'https://github.com/OpenSpineConsortium/claude-swap-cloud';
export const INSTALL_LINES = Object.freeze([
  `uv tool install git+${SOURCE_REPO}`,
  `pipx install git+${SOURCE_REPO}`,
]);
// Both installers remember where a tool came from, so an upgrade follows
// the repository again rather than PyPI.
export const UPGRADE_LINES = Object.freeze([
  'uv tool upgrade claude-swap-cloud',
  'pipx upgrade claude-swap-cloud',
]);
// An upgrade follows whatever the installer remembers, which may be an
// older branch; a reinstall from the repository is the sure way to the
// current code.
export const REINSTALL_LINES = Object.freeze([
  `uv tool install --force --reinstall git+${SOURCE_REPO}`,
  `pipx install --force git+${SOURCE_REPO}`,
]);
// What the bridge must be able to do for the panel's three buttons: the
// Save As and Open windows. A bridge that answers without them is an
// older cswap, whatever version it says.
export const NEEDED_CAPABILITIES = Object.freeze(['dialogs']);

// What a hello that lacks one of those capabilities is missing, or '': a
// hello that lists what the bridge can do and leaves one out.
export function missingCapability(hello) {
  if (!hello || typeof hello !== 'object' || !Array.isArray(hello.capabilities)) return '';
  return NEEDED_CAPABILITIES.find(c => !hello.capabilities.includes(c)) || '';
}

// The store copy and the unpacked copy have different ids, and the native
// host's manifest names one. The register line carries this extension's
// own id so the bridge is registered for the copy that is asking, whichever
// it is (docs/store/SUBMISSION.md, section 2).
export function registerLine(extensionId) {
  const id = typeof extensionId === 'string' && /^[a-p]{32}$/.test(extensionId) ? extensionId : '';
  return `cswap bridge install --register${id ? ` --extension-id ${id}` : ''}`;
}

export const QUEUE_LINE = 'cswap project-move import --to NUM';

function step(key, title, state, detail, commands = [], after = '') {
  return { key, title, state, detail, commands, after };
}

// state is 'ok', 'todo' or 'unknown'. `detail` says what was seen, the
// `commands` are typed as they are, `after` says what to do once they ran.
export function setupSteps({ bridge = {}, job = null, extensionId = '' } = {}) {
  const out = [];
  const reloadThenCheck = 'Then reload the extension on chrome://extensions and press Check now.';

  // 1. Chrome's "Allow User Scripts" switch. Without it the import script
  // cannot be injected, and the worker never tries the bridge.
  if (bridge.userScripts === false) {
    out.push(step('user-scripts', 'Allow User Scripts in Chrome', 'todo',
      bridge.userScriptsError || 'chrome.userScripts is not available.',
      [],
      'Open chrome://extensions, open this extension\'s card (Details) and turn on "Allow User Scripts" (Chrome 138 and newer; Developer mode on older ones). ' + reloadThenCheck));
    out.push(step('cswap', 'cswap and its bridge', 'unknown', 'Checked after the step above.'));
    out.push(step('job', 'An import to run', 'unknown', 'Checked after the steps above.'));
    return out;
  }
  out.push(step('user-scripts', 'Allow User Scripts in Chrome', 'ok', 'Turned on.'));

  // 2. cswap on this computer, with its bridge registered for this copy of
  // the extension. The last connection attempt's code says which part is
  // missing; a code that was never set means nothing has been tried yet.
  const code = bridge.lastErrorCode || '';
  const cswapVersion = bridge.lastHello && bridge.lastHello.cswap ? String(bridge.lastHello.cswap) : '';
  const source = bridge.lastHello && typeof bridge.lastHello.source === 'string' ? bridge.lastHello.source : '';
  if (cswapVersion && missingCapability(bridge.lastHello)) {
    out.push(step('cswap', 'Reinstall cswap: this one is older than the extension', 'todo',
      `cswap ${cswapVersion}${source ? ` (from ${source})` : ''} answered, but it cannot open the Save As and Open windows: it was installed before they existed. ` +
      'Reinstall it from the repository with one of the first two lines (whichever tool you have), then register the bridge with the third.',
      [...REINSTALL_LINES, registerLine(extensionId)], 'Then press Check now.'));
  } else if (bridge.connected) {
    out.push(step('cswap', 'cswap and its bridge', 'ok', `Connected to cswap ${cswapVersion || '?'}.`));
  } else if (code === 'no-host' && /another extension id|forbidden/i.test(bridge.lastError || '')) {
    out.push(step('cswap', 'Register the bridge for this copy of the extension', 'todo',
      'cswap is installed, but its bridge is registered for a different extension id.',
      [registerLine(extensionId)], reloadThenCheck));
  } else if (code === 'no-host') {
    out.push(step('cswap', 'Install cswap and register its bridge', 'todo',
      'Chrome found no native host named for this extension. Install cswap with one of the first two lines (whichever tool you have), then register the bridge with the third.',
      [...INSTALL_LINES, registerLine(extensionId)], reloadThenCheck));
  } else if (code === 'protocol') {
    out.push(step('cswap', 'Update cswap or the extension', 'todo',
      bridge.lastError || 'The bridge speaks another protocol version.',
      [...UPGRADE_LINES], 'Whichever installer you used. If cswap is already current, update the extension instead. ' + reloadThenCheck));
  } else if (cswapVersion) {
    // The bridge has answered before, so cswap is installed and registered;
    // a port that dropped since (the worker idles, the host exits with it)
    // is not a missing piece, only a reconnect away.
    out.push(step('cswap', 'cswap and its bridge', 'ok',
      `Last seen: cswap ${cswapVersion}${bridge.lastError ? ` (${bridge.lastError})` : ''}. Press Check now to reconnect.`));
  } else if (code === 'timeout' || code === 'disconnected') {
    out.push(step('cswap', 'The bridge stopped before answering', 'todo',
      bridge.lastError || 'The bridge disconnected.',
      ['cswap bridge status'], 'Fix what it reports, then press Check now. The log below has the bridge\'s last words.'));
  } else {
    out.push(step('cswap', 'cswap and its bridge', 'unknown',
      'Not checked yet. Press Check now; if cswap is not installed, these are the lines.',
      [...INSTALL_LINES, registerLine(extensionId)], reloadThenCheck));
  }

  // 3. A job to run. Export this project above starts an export of the
  // project the tab shows, and Import after it; or the command line queues
  // an import, which the extension picks up when a claude.ai tab is open in
  // the destination account. A job that has ended stays in storage as the
  // result, not as something to run.
  const active = !!job && !['done', 'failed', 'cancelled'].includes(job.phase);
  const exported = !!job && job.kind === 'export' && job.phase === 'done';
  if (active) {
    const what = job.kind === 'export' ? 'Export job' : 'Job';
    out.push(step('job', 'An import to run', 'ok', `${what} ${job.id || ''} is ${job.phase || 'queued'}.`));
  } else if (exported) {
    // A finished export waits for the person's next two presses.
    out.push(step('job', 'Import the finished export', 'todo',
      'Press Sign out and reload above, sign in as the other account on the page that opens, and press Import: the copy goes into the account you signed in as.'));
  } else {
    out.push(step('job', 'Export a project, or queue an import', out[1].state === 'ok' ? 'todo' : 'unknown',
      'Nothing is running. Open the project to copy on claude.ai in this tab and press Export this project above, ' +
      'with no command at all; an export already on disk is imported with Import above, which opens it. Or queue an import from the command line; ' +
      'NUM is the account slot to import into (`cswap list` shows them).',
      [QUEUE_LINE], 'Then open claude.ai signed in to that account and press Check now.'));
  }
  return out;
}

// One line for the panel's header: the first step still to do, or that
// everything is in place.
export function setupSummary(steps) {
  const next = steps.find(s => s.state !== 'ok');
  if (!next) return 'Everything is in place.';
  return next.state === 'unknown' ? `Next: ${next.title.toLowerCase()} (not checked yet).` : `Next: ${next.title.toLowerCase()}.`;
}
