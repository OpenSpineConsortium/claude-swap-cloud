// The side panel. It keeps no state of its own: everything it shows comes
// from chrome.storage.local (the keys in protocol.js) and it re-renders on
// every change; what the person presses goes to the worker as a `cmd`.
// viewModel() is pure, so the texts and the enabled buttons are tested
// without a DOM.

import { KEYS, MSG, PORTS, HOST_NAME, RECONNECT_BACKOFF_MS } from './protocol.js';
import { FIELDS, LOG_LEVELS } from './config.js';

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

  const statusLine = !job
    ? 'No import. Run `cswap project-move import --to NUM`, then open claude.ai.'
    : job.phase === 'done' ? 'Done.'
      : job.phase === 'failed' ? `Failed: ${job.error || 'see the log'}`
        : job.phase === 'cancelled' ? 'Cancelled.'
          : job.phase === 'held' ? 'Stopped: waiting for you.'
            : job.phase === 'claimed' ? 'Waiting for a claude.ai tab.'
              : job.phase === 'preflight' ? 'Checking the page and the account.'
                : job.phase === 'loading' ? 'Loading the export and the script.'
                  : job.phase === 'ready' ? 'Pressing the import button.'
                    : 'Importing.';

  const hint = bridge.userScripts === false
    ? (bridge.userScriptsError || 'Turn on "Allow User Scripts" on the extension\'s card, then reload the extension.')
    : bridge.lastError || (bridge.jobElsewhere ? `Job ${bridge.jobElsewhere.id} is claimed by another browser profile.` : '');

  return {
    statusLine,
    phaseBadge: phaseBadgeOf(job, gate),
    exportLine: exportInfo ? `${exportInfo.name || exportInfo.path || 'export'} (${exportInfo.kind || '?'}, ${exportInfo.files || 0} files, ${exportInfo.conversations || 0} conversations)` : '',
    accountLine: account ? `into Account-${account.slot || '?'} (${account.email || '?'})` : '',
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
  const state = { problems: [] };
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
    renderLog();
    renderSettings();
    renderAbout(vm);
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
      const ok = typeof doc.defaultView?.confirm === 'function'
        ? doc.defaultView.confirm('Stop the import now? The tab is reloaded so nothing more is sent. The project created so far stays.')
        : true;
      if (ok) await run('cancel');
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
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      let touched = false;
      for (const [name, key] of Object.entries(KEYS)) {
        if (changes[key]) { state[name] = changes[key].newValue; touched = true; }
      }
      if (touched) render();
    });
    const tick = () => { if (state.gate && state.gate.wait) render(); schedule(tick, 1000); };
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
