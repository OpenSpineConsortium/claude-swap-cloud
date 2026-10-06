// The side panel. It keeps no state of its own: everything it shows comes
// from chrome.storage.local (the keys in protocol.js) and it re-renders on
// every change; what the person presses goes to the worker as a `cmd`.
// viewModel() is pure, so the texts and the enabled buttons are tested
// without a DOM.

import { KEYS, MSG, PORTS, HOST_NAME, RECONNECT_BACKOFF_MS } from './protocol.js';
import { FIELDS, LOG_LEVELS } from './config.js';
import { setupSteps, setupSummary } from './setup.js';
import { duplicateView, drivenCapable, DRIVEN_POLL_MS, WAY_HELP } from './duplicate.js';

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
      text = 'Held: a step is waiting for your Retry or Give up.';
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
  return job.chainError ? 'Exported, but the import could not start.' : 'Export done.';
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
    ? 'No import. Run `cswap project-move import --to NUM`, then open claude.ai; or press Duplicate above.'
    : job.phase === 'done' ? (exporting ? exportDoneLine(job) : 'Done.')
      : job.phase === 'failed' ? `Failed: ${job.error || 'see the log'}`
        : job.phase === 'cancelled' ? 'Cancelled.'
          : job.phase === 'held' ? 'Stopped: waiting for you.'
            : job.phase === 'claimed' ? 'Waiting for a claude.ai tab.'
              : job.phase === 'preflight' ? 'Checking the page and the account.'
                : job.phase === 'choosing' ? 'Choose the project and the account above.'
                  : job.phase === 'loading' ? (exporting ? 'Loading the export script.' : 'Loading the export and the script.')
                    : job.phase === 'ready' ? (exporting ? 'Pressing the export button.' : 'Pressing the import button.')
                      : exporting ? 'Exporting.' : 'Importing.';

  const hint = bridge.userScripts === false
    ? (bridge.userScriptsError || 'Turn on "Allow User Scripts" on the extension\'s card, then reload the extension.')
    : bridge.lastError || (bridge.jobElsewhere ? `Job ${bridge.jobElsewhere.id} is claimed by another browser profile.` : '');

  const setup = setupSteps({ bridge, job, extensionId: state.extensionId || '' });
  const duplicate = duplicateView(job, { drivenCapable: drivenCapable(bridge) });

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
    buttons: {
      pause: active && !held && !paused && ['ready', 'running'].includes(job.phase),
      resume: resumable || (active && paused),
      cancel: active,
      retry: held && heldReason === 'failed-step',
      giveUp: held && heldReason === 'failed-step',
      confirm: !!(current && current.kind === 'identity-unknown'),
      refresh: true,
      retryImport: duplicate.canRetryImport,
    },
    bridge: { connected: !!bridge.connected, hint, cswap: bridge.lastHello ? bridge.lastHello.cswap : '', userScripts: bridge.userScripts !== false },
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
    for (const [id, enabled] of [['btn-pause', vm.buttons.pause], ['btn-resume', vm.buttons.resume], ['btn-cancel', vm.buttons.cancel],
      ['btn-retry', vm.buttons.retry], ['btn-giveup', vm.buttons.giveUp], ['btn-resume2', vm.buttons.resume], ['btn-confirm', vm.buttons.confirm]]) {
      const el = $(id);
      if (el) el.disabled = !enabled;
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
    renderDuplicate(vm.duplicate);
    renderSetup(vm.setup);
    renderLog();
    renderSettings();
    renderAbout(vm);
  }

  // The Duplicate section: one button while nothing runs, the form while
  // an export job waits for its choice. The selects are rebuilt only when
  // their options change, so a choice being made survives the re-render
  // the storage fires every second.
  let dupProjectsKey = '';
  let dupAccountsKey = '';
  let dupWaysKey = '';
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
    const form = $('dup-form');
    if (form) form.hidden = !dup.choosing;
    if (dup.choosing) {
      dupProjectsKey = fillSelect($('dup-project'), dup.projects.map(p => ({ value: p.id, label: p.label, selected: p.selected })),
        JSON.stringify(dup.projects), dupProjectsKey);
      dupAccountsKey = fillSelect($('dup-account'), dup.accounts.map(a => ({ value: a.slot, label: a.label, disabled: a.disabled, selected: a.selected })),
        JSON.stringify(dup.accounts), dupAccountsKey);
      dupWaysKey = fillSelect($('dup-way'), dup.ways, JSON.stringify(dup.ways), dupWaysKey);
      const chosen = $('dup-way') ? $('dup-way').value : '';
      setText('dup-way-hint', dup.wayHint || WAY_HELP[chosen] || dup.wayHelp);
      const go = $('btn-dup-start');
      if (go) go.disabled = !dup.projects.length || !!dup.noAccounts;
    } else {
      dupProjectsKey = '';
      dupAccountsKey = '';
      dupWaysKey = '';
    }
    setText('dup-project-hint', dup.hint);
    setText('dup-account-hint', dup.noAccounts);
    // An export whose import could not start: why, the line that imports it
    // by hand with Copy, and Try the import again.
    const box = $('dup-chain-box');
    if (box) box.hidden = !dup.chainError;
    setText('dup-chain', dup.chainError ? `The import could not start: ${dup.chainError}` : '');
    setText('dup-chain-cmd', dup.chainCommand);
    // A line to type is offered only when there is one: no Copy that
    // copies nothing.
    showLine(['dup-chain-hand', 'dup-chain-cmd', 'btn-dup-copy'], !!dup.chainCommand);
    const again = $('btn-dup-import');
    if (again) { again.hidden = !dup.canRetryImport; again.disabled = !dup.canRetryImport; }
    // The import in a window of its own: offered, running, or how it ended,
    // its last lines, the new project's link and the line to type.
    const driven = dup.driven;
    const block = $('dup-driven');
    if (block) block.hidden = !driven.show;
    setText('dup-driven-line', driven.line);
    const link = $('dup-driven-link');
    if (link) {
      const ok = typeof driven.link === 'string' && driven.link.startsWith('https://claude.ai/');
      link.href = ok ? driven.link : '';
      link.textContent = ok ? 'Open the new project' : '';
      link.hidden = !ok;
    }
    const tail = $('dup-driven-tail');
    if (tail) { tail.textContent = driven.tail.join('\n'); tail.hidden = !driven.tail.length; }
    setText('dup-driven-cmd', driven.command);
    showLine(['dup-driven-hand', 'dup-driven-cmd', 'btn-dup-driven-copy'], !!driven.command);
    const go = $('btn-dup-driven');
    if (go) { go.hidden = !driven.button.show; go.disabled = !driven.button.enabled; go.textContent = driven.button.label || 'Import in its own window'; }
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
    on('btn-pause', () => run('pause'));
    on('btn-resume', () => run('resume'));
    on('btn-resume2', () => run('resume'));
    on('btn-confirm', () => run('identity.confirm'));
    on('btn-retry', () => run('retry'));
    on('btn-giveup', () => run('giveUp'));
    on('btn-cancel', async () => {
      const exporting = state.job && state.job.kind === 'export';
      const question = exporting
        ? 'Stop the export now? The tab is reloaded so nothing more is written. The files saved so far stay in the exports folder.'
        : 'Stop the import now? The tab is reloaded so nothing more is sent. The project created so far stays.';
      const ok = typeof doc.defaultView?.confirm === 'function' ? doc.defaultView.confirm(question) : true;
      if (ok) await run('cancel');
    });
    on('btn-duplicate', async () => {
      const ok = typeof doc.defaultView?.confirm === 'function'
        ? doc.defaultView.confirm('Duplicate a project? The claude.ai tab in front is reloaded, then the projects its account can see are listed here for you to choose from.')
        : true;
      if (ok) await run('duplicate.start');
    });
    on('btn-dup-start', async () => {
      const project = $('dup-project');
      const account = $('dup-account');
      const name = $('dup-name');
      const way = $('dup-way');
      await run('duplicate.choose', {
        projectId: project ? project.value : '',
        destination: account ? account.value : '',
        name: name ? name.value : '',
        way: way ? way.value : '',
      });
    });
    const way = $('dup-way');
    if (way) way.addEventListener('change', () => { const dup = viewModel(state, now()).duplicate; setText('dup-way-hint', dup.wayHint || WAY_HELP[way.value] || dup.wayHelp); });
    on('btn-dup-again', () => run('duplicate.choices'));
    on('btn-dup-import', async () => { const r = await run('duplicate.import'); if (r && r.ok && r.text) showError(r.text); });
    on('btn-dup-copy', async () => {
      const line = duplicateView(state.job).chainCommand;
      if (line) await copyLines($('btn-dup-copy'), [line], 'Copy this line');
    });
    on('btn-dup-driven', async () => {
      const dest = state.job && state.job.duplicate && state.job.duplicate.destination ? state.job.duplicate.destination : {};
      const question = `Import the copy in a window of its own? cswap opens a Chrome window for ${dest.email || 'the account you chose'} ` +
        '(on Windows with a console window that shows how it goes): sign in there if it asks.';
      const ok = typeof doc.defaultView?.confirm === 'function' ? doc.defaultView.confirm(question) : true;
      if (!ok) return;
      const r = await run('duplicate.driven');
      if (r && r.ok && r.text) showError(r.text);
    });
    on('btn-dup-driven-copy', async () => {
      const line = viewModel(state, now()).duplicate.driven.command;
      if (line) await copyLines($('btn-dup-driven-copy'), [line], 'Copy this line');
    });
    on('btn-log-clear', () => run('log.clear'));
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
