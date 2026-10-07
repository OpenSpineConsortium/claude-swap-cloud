// The side panel. It keeps no state of its own: everything it shows comes
// from chrome.storage.local (the keys in protocol.js) and it re-renders on
// every change; what the person presses goes to the worker as a `cmd`.
// viewModel() is pure, so the texts and the buttons shown are tested
// without a DOM. The panel shows as few buttons as it can. The copy of a
// project is three: Export this project (the one the tab shows), Sign out
// and reload (then the person signs in as the other account in the same
// tab), and Import, with the account and a name for the copy. A button is
// shown only while it applies, and the controls of a job are Resume (which
// also sends a failed step again), Skip this step, Cancel and, when the
// signed-in account could not be read, Confirm.

import { KEYS, MSG, PORTS, HOST_NAME, RECONNECT_BACKOFF_MS, TERMINAL_PHASES } from './protocol.js';
import { FIELDS, LOG_LEVELS } from './config.js';
import { setupSteps, setupSummary } from './setup.js';
import { duplicateView, elsewhereView, helloCan, DROP_CAPABILITY, DRIVEN_POLL_MS } from './duplicate.js';

const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

function seconds(ms) {
  if (ms < 10000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

export function waitText(wait, nowMs) {
  if (!wait || !wait.reason) return null;
  const until = typeof wait.until === 'number' ? wait.until : null;
  const remainingMs = until == null ? 0 : Math.max(0, until - nowMs);
  const fullMs = until != null && typeof wait.since === 'number' ? Math.max(0, until - wait.since) : null;
  let text;
  switch (wait.reason) {
    case 'spacing':
      text = `Waiting ${seconds(remainingMs)}: minimum spacing`;
      break;
    case 'retry-after':
      text = `Waiting ${seconds(remainingMs)}: the site asked to slow down (HTTP 429` +
        `${fullMs != null ? `, Retry-After ${Math.round(fullMs / 1000)}` : ''})`;
      break;
    case 'script-backoff':
      text = 'The script is waiting before it tries that request again (a server error or no reply)';
      break;
    case 'paused':
      text = 'Paused by you. Press Resume to go on.';
      break;
    case 'held':
      text = 'Held: a step failed. Press Resume to send it again, or Skip this step.';
      break;
    case 'interrupted':
      text = 'Stopped: see below for what to do, then press Resume.';
      break;
    default:
      text = `Waiting ${seconds(remainingMs)} (${wait.reason})`;
  }
  return { reason: wait.reason, remainingMs, text };
}

// An export that is done: whether its import is on its way, in its own
// window or in this tab, and how that went.
function exportDoneLine(job) {
  const d = job.driven && typeof job.driven === 'object' ? job.driven : null;
  if (d && d.running) return 'Exported; importing in its own window.';
  if (d && d.exit_code === 0) return 'Done: the copy is made.';
  if (d) return 'Exported; the import in its own window stopped.';
  return job.chainError ? 'Exported, but the import could not start.' : 'Export done. Next: Sign out and reload, then Import.';
}

function phaseBadgeOf(job, gate) {
  if (!job) return 'idle';
  if (job.phase === 'held') return 'held';
  if (gate && gate.pausedBy) return 'paused';
  if (gate && gate.phase === 'waiting') return 'waiting';
  return job.phase || 'idle';
}

export function viewModel(state = {}, nowMs = 0) {
  const job = state.job || null;
  const gate = state.gate || null;
  const interrupt = state.interrupt || null;
  const bridge = state.bridge || {};
  const exportInfo = job && job.export ? job.export : null;
  const account = job && job.account ? job.account : null;
  const active = !!job && !['done', 'failed', 'cancelled'].includes(job.phase);
  const held = active && job.phase === 'held';
  const gateHeld = gate && gate.held ? gate.held : null;
  const heldReason = gateHeld ? gateHeld.reason : job ? job.heldReason : null;
  const current = interrupt && interrupt.current && !interrupt.current.resolvedAt ? interrupt.current : null;
  const paused = !!(gate && gate.pausedBy);
  const created = job && job.created_project ? job.created_project : null;

  // A job stopped by an interruption says so, whatever the gate's own wait
  // is (the worker pauses the gate to hold it, which is not "paused by you").
  const stopped = held && (heldReason === 'interrupted' || !!current);
  const wait = stopped
    ? waitText({ reason: 'interrupted', since: gate && gate.wait ? gate.wait.since : undefined, until: null }, nowMs)
    : gate && gate.wait ? waitText(gate.wait, nowMs) : null;
  // Resume is the way out of an interruption, a long wait or a pause; a
  // failed step is for Retry or Give up, and Resume would do nothing to it.
  const resumable = held && !(current && current.kind === 'identity-unknown') &&
    (heldReason === 'interrupted' || heldReason === 'long-wait' || !!current);

  let heldView = null;
  if (held && gateHeld && heldReason !== 'interrupted') {
    const method = (gateHeld.method || (gate.inFlight && gate.inFlight.method) || '').toUpperCase();
    const path = gateHeld.path || gateHeld.stepKey || '';
    const status = gateHeld.status || 0;
    const unsure = method && method !== 'GET' && (status >= 500 || status === 0);
    heldView = {
      text: `${method ? `${method} ` : ''}${path}${status ? `, last answer HTTP ${status}` : ', no answer'}` +
        `${gateHeld.attempt ? `, attempt ${gateHeld.attempt}` : ''}` +
        `${heldReason === 'long-wait' ? ' (the site asked for a wait longer than your cap; Resume honours it in full)' : ''}`,
      retryNote: unsure ? 'The site may already have acted on this request; retrying can create a duplicate.' : '',
    };
  }

  const counters = gate && gate.counters ? gate.counters : { requests: 0, ok: 0, slowDowns: 0, serverErrors: 0, networkErrors: 0, interruptions: 0, held: 0, probes: 0, waitedMs: 0 };
  const inFlight = gate && gate.inFlight ? gate.inFlight : null;
  const stepText = inFlight
    ? `${inFlight.method} ${inFlight.path}${inFlight.attempt > 1 ? ` (attempt ${inFlight.attempt})` : ''}`
    : gateHeld ? `held: ${gateHeld.stepKey || ''}` : active ? 'between requests' : '';

  const exporting = !!job && job.kind === 'export';
  const statusLine = !job
    ? 'Nothing running. Press Export this project above; or run `cswap project-move import --to NUM`, then open claude.ai.'
    : job.phase === 'done' ? (exporting ? exportDoneLine(job) : 'Done.')
      : job.phase === 'failed' ? `Failed: ${job.error || 'see the log'}`
        : job.phase === 'cancelled' ? 'Cancelled.'
          : job.phase === 'held' ? 'Stopped: waiting for you.'
            : job.phase === 'claimed' ? 'Waiting for a claude.ai tab.'
              : job.phase === 'preflight' ? 'Checking the page and the account.'
                : job.phase === 'choosing' ? 'Finding the project this tab shows.'
                  : job.phase === 'loading' ? (exporting ? 'Loading the export script.' : 'Loading the export and the script.')
                    : job.phase === 'ready' ? (exporting ? 'Pressing the export button.' : 'Pressing the import button.')
                      : exporting ? 'Exporting.' : 'Importing.';

  const elsewhere = elsewhereView(bridge.jobElsewhere, helloCan(bridge.lastHello, DROP_CAPABILITY));
  const hint = bridge.userScripts === false
    ? (bridge.userScriptsError || 'Turn on "Allow User Scripts" on the extension\'s card, then reload the extension.')
    : bridge.lastError || elsewhere.line;

  const setup = setupSteps({ bridge, job, extensionId: state.extensionId || '' });
  const duplicate = duplicateView(job);

  return {
    statusLine,
    setup: { steps: setup, summary: setupSummary(setup), allOk: setup.every(s => s.state === 'ok') },
    phaseBadge: phaseBadgeOf(job, gate),
    exportLine: exporting
      ? (exportInfo && exportInfo.name ? `${exportInfo.name} (${exportInfo.kind || '?'}, ${exportInfo.files || 0} files written)` : '')
      : exportInfo ? `${exportInfo.name || exportInfo.path || 'export'} (${exportInfo.kind || '?'}, ${exportInfo.files || 0} files, ${exportInfo.conversations || 0} conversations)` : '',
    accountLine: exporting
      ? (account && account.email ? `from ${account.email}` : '')
      : account ? `into Account-${account.slot || '?'} (${account.email || '?'})` : '',
    duplicate,
    statusText: job ? job.lastStatusText || '' : '',
    link: created && created.url ? created.url : (job && job.result && job.result.link) || '',
    resultSummary: job && job.result && job.result.counts
      ? `${job.result.counts.added} added, ${job.result.counts.moved} moved, ${job.result.counts.leftOut} left out, ${job.result.counts.notAdded + job.result.counts.notSet} failed, ${job.result.counts.toCheck} to check`
      : '',
    stepText,
    counters,
    wait,
    held: heldView,
    interruption: current ? { kind: current.kind, what: current.what || '', todo: current.todo || '', evidence: current.evidence || {} } : null,
    // The controls are shown only while a job runs, each only while it
    // applies. `resume` is Resume's own case (an interruption, a long wait,
    // a pause); `retry` and `giveUp` are a failed step, which Resume sends
    // again and Skip this step hands to the script as failed.
    controls: active,
    buttons: {
      resume: resumable || (active && paused),
      cancel: active,
      retry: held && heldReason === 'failed-step',
      giveUp: held && heldReason === 'failed-step',
      confirm: !!(current && current.kind === 'identity-unknown'),
      refresh: true,
    },
    bridge: {
      connected: !!bridge.connected, hint, cswap: bridge.lastHello ? bridge.lastHello.cswap : '', userScripts: bridge.userScripts !== false,
      // Drop that job: for a job another browser profile holds, when this
      // cswap can drop one and nothing of this browser's is running.
      canDrop: elsewhere.canDrop && bridge.userScripts !== false && !(job && !TERMINAL_PHASES.includes(job.phase)),
      elsewhereId: elsewhere.id,
    },
    problems: Array.isArray(state.problems) ? state.problems : [],
    job,
  };
}

export function logLines(log, level = 'info', limit = 50) {
  const records = log && Array.isArray(log.records) ? log.records : [];
  const min = LEVEL_RANK[level] == null ? 1 : LEVEL_RANK[level];
  return records.filter(r => r && LEVEL_RANK[r.level] >= min).slice(-limit).reverse();
}

// ---------------------------------------------------------- the panel itself

export function createPanel({ chrome, doc, now = Date.now, schedule = setTimeout }) {
  const state = { problems: [], extensionId: chrome.runtime && chrome.runtime.id ? chrome.runtime.id : '' };
  let port = null;
  let nextId = 1;
  let reconnects = 0;
  const pending = new Map();
  const $ = id => doc.getElementById(id);
  let logLevel = 'info';

  function cmd(name, args = {}) {
    return new Promise(resolve => {
      const id = nextId++;
      pending.set(id, resolve);
      if (!port) { pending.delete(id); resolve({ ok: false, error: 'Not connected to the extension; reopen the panel.' }); return; }
      try { port.postMessage({ id, type: MSG.cmd, name, args }); } catch (e) { pending.delete(id); resolve({ ok: false, error: String(e && e.message || e) }); }
    });
  }

  function connect() {
    try { port = chrome.runtime.connect({ name: PORTS.panel }); } catch (e) { port = null; }
    if (!port) { reconnectLater(); return; }
    const p = port;
    p.onMessage.addListener(m => {
      if (!m || typeof m !== 'object' || typeof m.re !== 'number') return;
      const resolve = pending.get(m.re);
      if (!resolve) return;
      pending.delete(m.re);
      resolve(m);
    });
    p.onDisconnect.addListener(() => {
      if (port !== p) return;
      port = null;
      for (const resolve of pending.values()) resolve({ ok: false, error: 'The extension restarted; try again.' });
      pending.clear();
      reconnectLater();
    });
    reconnects = 0;
  }

  function reconnectLater() {
    const wait = RECONNECT_BACKOFF_MS[Math.min(reconnects, RECONNECT_BACKOFF_MS.length - 1)];
    reconnects++;
    schedule(connect, wait);
  }

  async function load() {
    const got = await chrome.storage.local.get(Object.values(KEYS));
    for (const [name, key] of Object.entries(KEYS)) state[name] = got[key];
    render();
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function showError(message) {
    setText('cmd-error', message || '');
  }

  async function run(name, args) {
    showError('');
    const result = await cmd(name, args);
    if (!result || result.ok === false) showError(result && result.error ? result.error : `${name} failed`);
    return result;
  }

  function render() {
    const vm = viewModel(state, now());
    const badge = $('phase-badge');
    if (badge) { badge.textContent = vm.phaseBadge; badge.className = `badge ${vm.phaseBadge}`; }
    setText('status-line', vm.statusLine);
    setText('export-line', vm.exportLine);
    setText('account-line', vm.accountLine);
    setText('status-text', vm.statusText);
    const link = $('link');
    if (link) { link.href = vm.link || ''; link.textContent = vm.link ? 'Open the new project' : ''; link.hidden = !vm.link; }
    setText('result-summary', vm.resultSummary);
    setText('gate-step', vm.stepText);
    setText('wait-line', vm.wait ? vm.wait.text : '');
    const c = vm.counters;
    setText('counters', `requests ${c.requests || 0} | ok ${c.ok || 0} | slow-downs ${c.slowDowns || 0} | server errors ${c.serverErrors || 0} | network ${c.networkErrors || 0} | holds ${c.held || 0} | waited ${Math.round((c.waitedMs || 0) / 1000)} s`);
    const controls = $('controls');
    if (controls) controls.hidden = !vm.controls;
    // Resume stands for a failed step's Retry as well: the one button to
    // go on with.
    for (const [id, shown] of [['btn-resume', vm.buttons.resume || vm.buttons.retry], ['btn-cancel', vm.buttons.cancel],
      ['btn-giveup', vm.buttons.giveUp], ['btn-confirm', vm.buttons.confirm]]) {
      const el = $(id);
      if (el) { el.hidden = !shown; el.disabled = !shown; }
    }
    setText('held-text', vm.held ? vm.held.text : '');
    setText('retry-note', vm.held ? vm.held.retryNote : '');
    const section = $('interruption');
    if (section) section.hidden = !vm.interruption;
    setText('int-what', vm.interruption ? vm.interruption.what : '');
    setText('int-todo', vm.interruption ? vm.interruption.todo : '');
    setText('int-evidence', vm.interruption ? JSON.stringify(vm.interruption.evidence, null, 2) : '');
    setText('bridge-line', vm.bridge.connected ? `Bridge connected (cswap ${vm.bridge.cswap || '?'})` : 'Bridge not connected');
    setText('bridge-hint', vm.bridge.hint);
    const drop = $('btn-drop-job');
    if (drop) drop.hidden = !vm.bridge.canDrop;
    renderDuplicate(vm.duplicate);
    renderSetup(vm.setup);
    renderLog();
    renderSettings();
    renderAbout(vm);
  }

  // The Duplicate section: the numbered steps and Export this project
  // while nothing runs, the line while the export runs, and, once the
  // export is done, what came after it: Sign out and reload, the account
  // and the name for the copy with Import, and the line to type (a Copy
  // only when there is a line: no Copy that copies nothing). The account
  // select is rebuilt only when its options change, so a choice being
  // made survives the re-render the storage fires every second.
  let dupAccountsKey = '';
  function fillSelect(select, options, key, lastKey) {
    if (!select) return lastKey;
    if (key === lastKey) return lastKey;
    while (select.firstChild) select.removeChild(select.firstChild);
    for (const o of options) {
      const option = doc.createElement('option');
      option.value = o.value;
      option.textContent = o.label;
      if (o.disabled) option.disabled = true;
      if (o.selected) option.selected = true;
      select.appendChild(option);
    }
    return key;
  }

  function showLine(ids, shown) {
    for (const id of ids) { const el = $(id); if (el) el.hidden = !shown; }
  }

  function renderDuplicate(dup) {
    setText('dup-line', dup.line);
    const start = $('btn-duplicate');
    if (start) start.disabled = !dup.canStart;
    const steps = $('dup-steps');
    if (steps) steps.hidden = !dup.canStart;
    const after = dup.after;
    const block = $('dup-after');
    if (block) block.hidden = !after.show;
    setText('dup-after-line', after.line);
    const link = $('dup-after-link');
    if (link) {
      const ok = typeof after.link === 'string' && after.link.startsWith('https://claude.ai/');
      link.href = ok ? after.link : '';
      link.textContent = ok ? 'Open the new project' : '';
      link.hidden = !ok;
    }
    const tail = $('dup-after-tail');
    if (tail) { tail.textContent = after.tail.join('\n'); tail.hidden = !after.tail.length; }
    const form = $('dup-form');
    if (form) form.hidden = !after.button.show;
    if (after.button.show) {
      dupAccountsKey = fillSelect($('dup-account'), dup.accounts.map(a => ({ value: a.slot, label: a.label, disabled: a.disabled, selected: a.selected })),
        JSON.stringify(dup.accounts), dupAccountsKey);
    } else {
      dupAccountsKey = '';
    }
    setText('dup-account-hint', dup.noAccounts);
    const go = $('btn-dup-import');
    if (go) { go.hidden = !after.button.show; go.disabled = !after.button.enabled || !!dup.noAccounts; go.textContent = after.button.label || 'Import'; }
    setText('dup-after-cmd', after.command);
    showLine(['dup-after-hand', 'dup-after-cmd', 'btn-dup-copy'], !!after.command);
  }

  // Copies `lines` (and a last newline) to the clipboard; the button says
  // Copied for a moment, then `label` again.
  function copyLines(button, lines, label) {
    const value = lines.join('\n') + '\n';
    const clip = doc.defaultView && doc.defaultView.navigator && doc.defaultView.navigator.clipboard;
    if (!clip || typeof clip.writeText !== 'function') { showError('Copy is not available here; select the text instead.'); return Promise.resolve(); }
    return clip.writeText(value).then(() => {
      if (button) { button.textContent = 'Copied'; schedule(() => { button.textContent = label; }, 1500); }
    }, e => showError(`Copy failed: ${String(e && e.message || e)}`));
  }

  // The checklist of what this computer still needs, each step with the
  // command to type and a Copy button. The section folds away once every
  // step is done and an import is on its way; the summary line stays.
  // A fold or unfold by the person is kept from then on; the panel's own
  // changes to `open` fire the same toggle event, so the last value it
  // set is remembered to tell the two apart.
  let setupOpen = null;
  function renderSetup(setup) {
    const list = $('setup-list');
    if (!list) return;
    setText('setup-summary', setup.summary);
    const details = $('setup-details');
    if (details && !details.dataset.touched) { setupOpen = !setup.allOk; details.open = setupOpen; }
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const s of setup.steps) {
      const li = doc.createElement('li');
      li.className = `step ${s.state}`;
      const mark = doc.createElement('span');
      mark.className = 'mark';
      mark.textContent = s.state === 'ok' ? 'done' : s.state === 'todo' ? 'to do' : 'later';
      const title = doc.createElement('strong');
      title.textContent = s.title;
      li.appendChild(mark);
      li.appendChild(title);
      const detail = doc.createElement('div');
      detail.className = 'hint';
      detail.textContent = s.detail || '';
      li.appendChild(detail);
      if (s.commands.length) {
        const pre = doc.createElement('pre');
        pre.className = 'cmd';
        pre.textContent = s.commands.join('\n');
        li.appendChild(pre);
        const copy = doc.createElement('button');
        copy.type = 'button';
        const label = s.commands.length > 1 ? 'Copy these lines' : 'Copy this line';
        copy.textContent = label;
        copy.addEventListener('click', () => { copyLines(copy, s.commands, label); });
        li.appendChild(copy);
      }
      if (s.after) {
        const after = doc.createElement('div');
        after.className = 'hint';
        after.textContent = s.after;
        li.appendChild(after);
      }
      list.appendChild(li);
    }
  }

  function renderLog() {
    const list = $('log-list');
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const r of logLines(state.log, logLevel, 50)) {
      const li = doc.createElement('li');
      li.className = r.level;
      const lvl = doc.createElement('span');
      lvl.className = 'lvl';
      lvl.textContent = r.level;
      li.appendChild(lvl);
      li.appendChild(doc.createTextNode(`${String(r.ts || '').slice(11, 19)} ${r.event}: ${r.msg}${r.data && Object.keys(r.data).length ? ` ${JSON.stringify(r.data)}` : ''}`));
      list.appendChild(li);
    }
  }

  // The form is written from the stored settings only where they changed,
  // and never over a field the person is editing (it has focus, or was
  // changed since the last Save or Reset): the panel re-renders on every
  // storage change, which during an import is at least once a second.
  let settingsBuilt = false;
  const shown = {};          // field -> the stored value last written into it
  const edited = new Set();  // fields changed by the person, pending a Save or Reset
  function renderSettings() {
    const form = $('settings-form');
    if (!form) return;
    const cfg = state.config || {};
    if (!settingsBuilt) {
      settingsBuilt = true;
      for (const field of FIELDS) {
        const label = doc.createElement('label');
        label.className = 'field';
        const name = doc.createElement('span');
        name.textContent = field.key;
        let input;
        if (field.kind === 'bool') { input = doc.createElement('input'); input.type = 'checkbox'; }
        else if (field.kind === 'choice') {
          input = doc.createElement('select');
          for (const choice of field.choices || LOG_LEVELS) { const o = doc.createElement('option'); o.value = choice; o.textContent = choice; input.appendChild(o); }
        } else { input = doc.createElement('input'); input.type = 'number'; if (field.min != null) input.min = String(field.min); if (field.max != null) input.max = String(field.max); input.step = '1'; }
        input.name = field.key;
        input.dataset.kind = field.kind;
        const touched = () => edited.add(field.key);
        input.addEventListener('input', touched);
        input.addEventListener('change', touched);
        const help = doc.createElement('small');
        help.textContent = field.help || '';
        label.appendChild(name);
        label.appendChild(input);
        label.appendChild(help);
        form.appendChild(label);
      }
    }
    for (const input of form.querySelectorAll('[name]')) {
      const value = cfg[input.name];
      if (value === undefined || shown[input.name] === value) continue;
      if (edited.has(input.name) || doc.activeElement === input) continue;
      shown[input.name] = value;
      if (input.dataset.kind === 'bool') input.checked = !!value;
      else input.value = String(value);
    }
    setText('settings-problems', (state.problems || []).map(p => `${p.key}: ${p.message}`).join('\n'));
  }

  // After a Save or Reset the form follows the stored settings again.
  function settingsFollowStore() {
    edited.clear();
    for (const key of Object.keys(shown)) delete shown[key];
  }

  function readSettings() {
    const form = $('settings-form');
    const out = {};
    if (!form) return out;
    for (const input of form.querySelectorAll('[name]')) {
      if (input.dataset.kind === 'bool') out[input.name] = !!input.checked;
      else if (input.dataset.kind === 'choice') out[input.name] = input.value;
      else out[input.name] = Number(input.value);
    }
    return out;
  }

  function renderAbout(vm) {
    const dl = $('about-list');
    if (!dl) return;
    while (dl.firstChild) dl.removeChild(dl.firstChild);
    const bridge = state.bridge || {};
    const rows = [
      ['Extension id', chrome.runtime.id || ''],
      ['Extension version', bridge.extensionVersion || ''],
      ['Host name', HOST_NAME],
      ['Chrome', bridge.chromeVersion || ''],
      ['userScripts', vm.bridge.userScripts ? 'available' : 'not available'],
      ['Last host hello', bridge.lastHello ? `cswap ${bridge.lastHello.cswap}, protocol ${bridge.lastHello.protocol}, ${bridge.lastHello.backup_dir || ''}` : 'none'],
      ['Instance', state.instance ? state.instance.id : ''],
    ];
    for (const [k, v] of rows) {
      const dt = doc.createElement('dt'); dt.textContent = k;
      const dd = doc.createElement('dd'); dd.textContent = v;
      dl.appendChild(dt); dl.appendChild(dd);
    }
  }

  function wire() {
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', () => { fn().catch(e => showError(String(e && e.message || e))); }); };
    on('btn-refresh', async () => { const r = await run('job.refresh'); if (r && r.ok && r.text) showError(r.text); });
    on('btn-drop-job', async () => {
      const id = viewModel(state, now()).bridge.elsewhereId;
      if (!id) return;
      const question = `Drop job ${id}? The bridge ends it as cancelled: nothing more is imported or exported by it, ` +
        'the project it may have created stays, and a browser still running it stops the next time it reports. Then a new job can start here.';
      const ok = typeof doc.defaultView?.confirm === 'function' ? doc.defaultView.confirm(question) : true;
      if (!ok) return;
      // The job named is the one confirmed: the worker refuses to drop
      // another that took its place meanwhile.
      const r = await run('job.drop', { job: id });
      if (r && r.ok && r.text) showError(r.text);
    });
    // Resume goes on after an interruption, a long wait or a pause; on a
    // failed step it sends that step again (the worker's retry).
    on('btn-resume', () => { const b = viewModel(state, now()).buttons; return run(b.resume ? 'resume' : 'retry'); });
    on('btn-confirm', () => run('identity.confirm'));
    on('btn-giveup', () => run('giveUp'));
    on('btn-cancel', async () => {
      const exporting = state.job && state.job.kind === 'export';
      const question = exporting
        ? 'Stop the export now? The tab is reloaded so nothing more is written. The files saved so far stay in the exports folder.'
        : 'Stop the import now? The tab is reloaded so nothing more is sent. The project created so far stays.';
      const ok = typeof doc.defaultView?.confirm === 'function' ? doc.defaultView.confirm(question) : true;
      if (ok) await run('cancel');
    });
    // Export this project: the tab is reloaded and the project it shows
    // is exported; the worker says what to open when it shows none.
    on('btn-duplicate', () => run('duplicate.start'));
    // Sign out and reload: the tab makes the site's own sign-out request
    // and goes to the sign-in page; what the worker answers is shown.
    on('btn-signout', async () => { const r = await run('signout'); if (r && r.ok && r.text) showError(r.text); });
    // Import: the export just made, into the account chosen, under the
    // name typed, in this tab.
    on('btn-dup-import', async () => {
      const after = viewModel(state, now()).duplicate.after;
      if (!after.button.show || !after.button.enabled) return;
      const account = $('dup-account');
      const name = $('dup-name');
      const r = await run('duplicate.import', { destination: account ? account.value : '', name: name ? name.value : '' });
      if (r && r.ok && r.text) showError(r.text);
    });
    on('btn-dup-copy', async () => {
      const line = viewModel(state, now()).duplicate.after.command;
      if (line) await copyLines($('btn-dup-copy'), [line], 'Copy this line');
    });
    on('btn-log-save', async () => {
      const r = await run('log.export');
      if (!r || r.ok === false || typeof r.text !== 'string') return;
      const blob = new Blob([r.text], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = url;
      a.download = `cswap-import-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.jsonl`;
      doc.body.appendChild(a);
      a.click();
      a.remove();
      schedule(() => URL.revokeObjectURL(url), 1000);
    });
    on('btn-settings-save', async () => {
      const r = await run('config.set', { config: readSettings() });
      state.problems = r && Array.isArray(r.problems) ? r.problems : [];
      // A value the store corrected comes back through storage; a refused
      // one stays as typed, next to its problem, for the person to fix.
      if (!state.problems.length) settingsFollowStore();
      render();
    });
    on('btn-settings-reset', async () => {
      await run('config.reset');
      state.problems = [];
      settingsFollowStore();
      render();
    });
    const level = $('log-level');
    if (level) level.addEventListener('change', () => { logLevel = level.value; renderLog(); });
    const details = $('setup-details');
    if (details) details.addEventListener('toggle', () => { if (details.open !== setupOpen) details.dataset.touched = '1'; });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      let touched = false;
      for (const [name, key] of Object.entries(KEYS)) {
        if (changes[key]) { state[name] = changes[key].newValue; touched = true; }
      }
      if (touched) render();
    });
    // While an import runs in a window of its own, the panel asks how it
    // stands every DRIVEN_POLL_MS, one question at a time.
    let drivenPolling = false;
    let drivenAskedAt = -Infinity;
    const tick = () => {
      if (state.gate && state.gate.wait) render();
      const job = state.job;
      if (job && job.kind === 'export' && job.driven && job.driven.running === true && !drivenPolling && now() - drivenAskedAt >= DRIVEN_POLL_MS) {
        drivenPolling = true;
        drivenAskedAt = now();
        cmd('duplicate.driven.refresh').then(() => { drivenPolling = false; });
      }
      schedule(tick, 1000);
    };
    schedule(tick, 1000);
  }

  connect();
  wire();
  load().catch(e => showError(String(e && e.message || e)));

  return { cmd, render, state, viewModel: () => viewModel(state, now()) };
}

if (typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.id && typeof document !== 'undefined') {
  createPanel({ chrome, doc: document });
}
