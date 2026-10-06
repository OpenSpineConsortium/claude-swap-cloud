// The service worker: it picks a job up from the cswap bridge, puts the page
// helper and then the unchanged import script into the claude.ai tab, lets
// the gate decide when each of the script's requests may go, stops and tells
// the person when the site asks this browser to pass a check or to sign in,
// and reports every step back to the bridge. Everything it knows is in
// chrome.storage.local, because Chrome may end a service worker at any
// moment: a transition is persisted before anything acts on it, and a
// restart picks up from what was persisted.
//
// A Duplicate started from the side panel runs the same loop twice: first
// an export job (the unchanged export script, writing through the bridge
// into cswap's exports folder) and then, from its finished export, the
// import job the command line would have queued. The export job has one
// phase of its own, 'choosing', in which the panel offers the projects the
// signed-in account can see and the accounts cswap knows.
//
// Everything is injected (the chrome object, the clock, the timers and the
// factories of the other modules), so the tests run it against fakes. The
// production wiring is the last lines of this file.

import {
  HOST_NAME, WORLD, PORTS, KEYS, MSG, PANEL_COMMANDS, TERMINAL_PHASES, CLAUDE_URL_PREFIX,
  ALARM_POLL, ALARM_WAKE, PAGE_GONE_MS, BODY_MARKERS, ACCOUNT_ENDPOINTS, CHUNK_BYTES,
} from './protocol.js';
import { createNative, INSTALL_HINT } from './native.js';
import { createGate } from './gate.js';
import { createInterrupts, classifyResponse, classifyPage, classifyIdentity, describe } from './interrupt.js';
import { createConfigStore } from './config.js';
import { createLogger, redact } from './log.js';
import { projectUrl, projectChoices, accountChoices, bootProject, chainTexts, DUPLICATE_CAPABILITY, NO_DUPLICATE_TEXT } from './duplicate.js';

export const ATTACH_TIMEOUT_MS = 20000;
export const READY_TIMEOUT_MS = 90000;
export const PROBE_TIMEOUT_MS = 90000;
export const DOM_PROBE_TIMEOUT_MS = 5000;
export const PICKUP_MIN_GAP_MS = 30000;
export const STATUS_EVENT_GAP_MS = 1000;
export const MAX_RERUNS = 3;
export const EVENT_QUEUE_MAX = 200;
export const ALARM_WAKE_MIN_MS = 25000;
// After the tab was sent to a page, how long the job waits for that page's
// report before going on with whatever the tab shows.
export const NAVIGATE_WAIT_MS = 20000;

const ACTIVE_HOST_STATUSES = new Set(['queued', 'claimed', 'running', 'held']);
const PAGE_KINDS = new Set(['challenge-page', 'signed-out', 'page-reloaded', 'tab-closed']);

// How a job ends when its page is gone and a create went out: with the
// link when the answer came back, with a warning when it never did.
export const AFTER_CREATE_TEXT = 'The page went away after the project was created.';
export const UNSURE_CREATE_TEXT = 'The page went away while the project was being created, and the answer never came: ' +
  'the project may exist. Check claude.ai before importing again.';
export const STILL_HELD_TEXT = 'A failed step is still held: press Retry or Give up.';

export function isTerminal(phase) {
  return TERMINAL_PHASES.includes(phase);
}

// The host's status for a worker phase.
export function statusForPhase(phase) {
  if (phase === 'held') return 'held';
  if (isTerminal(phase)) return phase;
  if (phase === 'claimed') return 'claimed';
  return 'running';
}

// A job read back from storage has to look like one we wrote.
export function validJob(value) {
  return !!value && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.phase === 'string' && value.phase.length > 0;
}

function text(value, max = 500) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function isoOf(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function countRows(rows) {
  const counts = { created: 0, set: 0, added: 0, moved: 0, leftOut: 0, notSet: 0, notAdded: 0, toCheck: 0 };
  const names = { created: 'created', set: 'set', added: 'added', moved: 'moved', 'left out': 'leftOut',
    'not set': 'notSet', 'not added': 'notAdded', 'to check': 'toCheck' };
  for (const row of rows) if (names[row.result]) counts[names[row.result]]++;
  return counts;
}

export function createBackground(deps) {
  const {
    chrome,
    now = Date.now,
    schedule = setTimeout,
    unschedule = clearTimeout,
    uuid = () => globalThis.crypto.randomUUID(),
    classify = { response: classifyResponse, page: classifyPage, identity: classifyIdentity, describe },
    redactValue = redact,
  } = deps;
  if (!chrome || !chrome.storage || !chrome.storage.local || !chrome.runtime) {
    throw new TypeError('createBackground needs a chrome object with storage.local and runtime');
  }
  const createGateFn = deps.createGate || createGate;
  const createInterruptsFn = deps.createInterrupts || createInterrupts;
  const createConfigStoreFn = deps.createConfigStore || createConfigStore;
  const createLoggerFn = deps.createLogger || createLogger;
  const createNativeFn = deps.createNative || createNative;

  const extensionVersion = deps.extensionVersion ||
    (typeof chrome.runtime.getManifest === 'function' ? chrome.runtime.getManifest().version : '0.0.0');
  const chromeVersion = deps.chromeVersion || (() => {
    const ua = typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent : '';
    const m = ua.match(/Chrome\/(\d+)/);
    return m ? m[1] : '';
  })();

  // ---------------------------------------------------------- storage

  const storage = chrome.storage.local;
  async function sget(key) {
    const got = await storage.get(key);
    return got ? got[key] : undefined;
  }
  async function sset(key, value) {
    await storage.set({ [key]: value });
  }
  const bound = key => ({ get: () => sget(key), set: value => sset(key, value) });

  // ---------------------------------------------------------- the modules

  let onGateChange = () => {};
  const log = createLoggerFn({ now, store: bound(KEYS.log), schedule, forward: record => forwardLog(record) });
  const config = createConfigStoreFn({
    store: bound(KEYS.config),
    onChange: cfg => {
      try {
        if (typeof log.setLevel === 'function') log.setLevel(cfg.logLevel);
        if (typeof log.setLimits === 'function') log.setLimits({ maxRecords: cfg.logMaxRecords, maxAgeMs: cfg.logRetentionHours * 3600000 });
      } catch (e) { /* the log keeps its old limits */ }
    },
  });
  const interrupts = createInterruptsFn({
    now, store: bound(KEYS.interrupt), log, redact: redactValue,
    context: () => ({ expected: expectedIdentity().email, link: job && job.created_project ? job.created_project.url : '', flow: jobKind() }),
  });
  const gate = createGateFn({
    now,
    wake: (atMs, fn) => {
      const delay = Math.max(0, atMs - now());
      const timer = schedule(fn, delay);
      // A service-worker timer dies with the worker: a long wait also gets
      // an alarm, which wakes the worker so the gate re-evaluates.
      if (delay >= ALARM_WAKE_MIN_MS && chrome.alarms && typeof chrome.alarms.create === 'function') {
        try { chrome.alarms.create(ALARM_WAKE, { when: atMs }); } catch (e) { /* the poll alarm still comes */ }
      }
      return () => { try { unschedule(timer); } catch (e) { /* nothing */ } };
    },
    store: bound(KEYS.gate),
    config: () => {
      const cfg = config.get() || {};
      return { minSpacingMs: cfg.minSpacingMs, retryAfterCapMs: cfg.retryAfterCapMs };
    },
    classify: rep => classify.response(rep),
    log,
    onChange: (snapshot, change) => onGateChange(snapshot, change),
  });
  const native = createNativeFn({
    connect: () => chrome.runtime.connectNative(HOST_NAME),
    now,
    log,
    store: bound(KEYS.bridge),
    schedule,
    unschedule,
    lastError: () => (chrome.runtime.lastError ? chrome.runtime.lastError.message : null),
  });

  // ---------------------------------------------------------- in-memory state

  let job = null;             // the persisted cswap.job, mirrored
  let instance = null;        // { id, createdAt }
  let userScriptsOk = false;
  let userScriptsError = '';
  let pagePort = null;        // the attached page port
  let pageNonce = null;
  let pageGoneTimer = null;
  const contentPorts = new Map(); // tabId -> port
  const pageStates = new Map();   // tabId -> { state, at }
  let lastClaudeTab = null;
  const waiters = new Map();      // key -> { resolve, reject, timer }
  const eventQueue = [];
  let flushing = false;
  let driving = false;
  let pickupAt = 0;
  let pickupInFlight = null;
  let startingDuplicate = false;
  let lastRows = [];
  let lastConsoleError = '';
  let statusSentAt = 0;
  let statusSent = '';
  let statusTimer = null;
  let statusPending = null;
  let started = false;
  let stopped = false;        // stop() was called: this worker is going away, nothing more is written
  const handlers = {};
  // The chrome listeners go on the moment this module is evaluated (Chrome
  // delivers the event that woke the worker only to listeners registered by
  // then), so every handler first waits here for start() to have read the
  // storage.
  let resolveReady = () => {};
  const ready = new Promise(resolve => { resolveReady = resolve; });

  // ---------------------------------------------------------- helpers

  function info(event, msg, data) { try { log.info(event, msg, data || {}, job ? job.id : null); } catch (e) { /* nothing */ } }
  function warn(event, msg, data) { try { log.warn(event, msg, data || {}, job ? job.id : null); } catch (e) { /* nothing */ } }
  function debug(event, msg, data) { try { log.debug(event, msg, data || {}, job ? job.id : null); } catch (e) { /* nothing */ } }
  function error(event, msg, data) { try { log.error(event, msg, data || {}, job ? job.id : null); } catch (e) { /* nothing */ } }

  // Every listener goes through this: nothing thrown reaches Chrome.
  const guarded = (name, fn) => (...args) => {
    try {
      const out = fn(...args);
      if (out && typeof out.then === 'function') {
        return out.catch(e => { error('error', `${name} failed`, { message: String(e && e.message || e) }); });
      }
      return out;
    } catch (e) {
      error('error', `${name} failed`, { message: String(e && e.message || e) });
      return undefined;
    }
  };

  function waitFor(key, timeoutMs, what) {
    const old = waiters.get(key);
    if (old) { waiters.delete(key); if (old.timer) unschedule(old.timer); old.reject(new Error(`superseded: ${key}`)); }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = schedule(() => {
        if (waiters.get(key) !== entry) return;
        waiters.delete(key);
        reject(new Error(what || `no ${key} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      waiters.set(key, entry);
    });
  }

  function signal(key, value) {
    const entry = waiters.get(key);
    if (!entry) return false;
    waiters.delete(key);
    if (entry.timer) unschedule(entry.timer);
    entry.resolve(value);
    return true;
  }

  function jobActive() {
    return !!job && !isTerminal(job.phase);
  }

  // Which script the job runs: 'import' (queued from the command line, or
  // the second half of a Duplicate) or 'export' (the first half).
  function jobKind() {
    return job && job.kind === 'export' ? 'export' : 'import';
  }

  function chosenProject() {
    return job && job.duplicate && job.duplicate.project && typeof job.duplicate.project === 'object' ? job.duplicate.project : null;
  }

  async function saveJob(patch) {
    if (!job || stopped) return;
    Object.assign(job, patch, { updated_at: isoOf(now()) });
    if (patch && patch.phase) job.status = statusForPhase(patch.phase);
    await sset(KEYS.job, job);
  }

  async function sha256Hex(value) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle || typeof TextEncoder === 'undefined') return null;
    try {
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
      return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { return null; }
  }

  function notify(title, message) {
    const cfg = config.get() || {};
    if (cfg.notifications === false) return;
    if (!chrome.notifications || typeof chrome.notifications.create !== 'function') return;
    try {
      const made = chrome.notifications.create({ type: 'basic', iconUrl: 'icons/128.png', title: String(title), message: String(message).slice(0, 300) });
      if (made && typeof made.catch === 'function') made.catch(() => {});
    } catch (e) { /* a notification is a courtesy */ }
  }

  function pagePost(msg) {
    if (!pagePort) return false;
    try { pagePort.postMessage(msg); return true; } catch (e) { return false; }
  }

  function expectedIdentity() {
    const account = (job && job.account) || {};
    return { email: text(account.email, 200), orgUuid: text(account.org_uuid, 100), flow: jobKind() };
  }

  // What the page classifiers are told about the job, for their texts.
  function jobStateForClassify(phase) {
    return { phase, expected: expectedIdentity().email, link: job && job.created_project ? job.created_project.url : '', flow: jobKind() };
  }

  // classifyPage() and classifyIdentity() answer with an Interruption object
  // (kind, what, todo, evidence) or null; the kind is what the worker acts on.
  function kindOf(found) {
    if (!found) return null;
    if (typeof found === 'string') return found;
    return typeof found.kind === 'string' ? found.kind : null;
  }

  // ---------------------------------------------------------- events to the host

  function emit(type, body) {
    const event = { event: type, job: job ? job.id : undefined, ...body };
    if (type !== 'log') info('job', type, body);
    eventQueue.push(event);
    if (eventQueue.length > EVENT_QUEUE_MAX) {
      // Status lines are the first to go: the next one says more anyway.
      const at = eventQueue.findIndex(e => e.event === 'status');
      eventQueue.splice(at >= 0 ? at : 0, 1);
    }
    flushEvents();
  }

  function forwardLog(record) {
    if (!record || (record.level !== 'warn' && record.level !== 'error')) return;
    if (record.event === 'native') return; // the bridge does not need to hear about itself
    eventQueue.push({ event: 'log', level: record.level, msg: record.msg, data: record.data || {} });
    if (eventQueue.length > EVENT_QUEUE_MAX) eventQueue.shift();
    flushEvents();
  }

  async function flushEvents() {
    if (flushing) return;
    flushing = true;
    try {
      while (eventQueue.length && native.isConnected()) {
        const event = eventQueue[0];
        let ack;
        try {
          ack = await native.event({ job: job ? job.id : undefined, ...event });
        } catch (e) {
          debug('native', 'event not delivered, kept', { event: event.event, code: e && e.code });
          break;
        }
        eventQueue.shift();
        if (ack && ack.cancel_requested && jobActive()) {
          info('job', 'cancel requested from the command line');
          cancelJob('cli').catch(e => error('error', 'cancel failed', { message: String(e && e.message || e) }));
          break;
        }
      }
    } finally {
      flushing = false;
    }
  }

  function emitStatus(statusText, link) {
    if (statusText === statusSent) return;
    const due = statusSentAt + STATUS_EVENT_GAP_MS;
    const t = now();
    // The same once-a-second rhythm writes the text to the job record, which
    // is what the panel shows.
    if (t >= due) {
      statusSent = statusText;
      statusSentAt = t;
      emit('status', { text: statusText, link: link || '' });
      saveJob({ lastStatusText: statusText }).catch(() => {});
      return;
    }
    statusPending = { text: statusText, link: link || '' };
    if (!statusTimer) {
      statusTimer = schedule(() => {
        statusTimer = null;
        const p = statusPending;
        statusPending = null;
        if (p && p.text !== statusSent) {
          statusSent = p.text;
          statusSentAt = now();
          emit('status', p);
          saveJob({ lastStatusText: p.text }).catch(() => {});
        }
      }, Math.max(0, due - t));
    }
  }

  // ---------------------------------------------------------- the host

  function helloBody() {
    return {
      extension: { version: extensionVersion, instance: instance ? instance.id : '' },
      chrome: chromeVersion,
      userScripts: userScriptsOk,
    };
  }

  async function ensureHost() {
    if (native.isConnected()) return;
    await native.connect(helloBody());
    flushEvents();
  }

  native.onDisconnect(() => {
    if (!jobActive()) return;
    // The poll alarm reconnects in a minute; one earlier try costs nothing.
    schedule(() => { ensureHost().catch(() => {}); }, 2000);
  });

  // Looks for a job the command line queued. Called when a claude.ai page
  // loads, when the panel asks, at startup and from the poll alarm; never
  // more often than every PICKUP_MIN_GAP_MS unless forced.
  async function pickup(reason, force = false) {
    if (pickupInFlight) return pickupInFlight;
    if (jobActive()) return null;
    if (!force && now() - pickupAt < PICKUP_MIN_GAP_MS) return null;
    pickupAt = now();
    pickupInFlight = (async () => {
      let found = null;
      try {
        // The hello says whether userScripts is available; without it the
        // bridge still hears so, and tells the command line, but nothing
        // is claimed.
        await ensureHost();
        if (!userScriptsOk) {
          warn('job', 'cannot claim a job: the userScripts API is not available', { reason: userScriptsError });
          return null;
        }
        const reply = await native.request({ type: 'job.get' });
        found = reply && reply.job ? reply.job : null;
        if (!found || !ACTIVE_HOST_STATUSES.has(found.status)) {
          debug('job', 'no job queued', { reason });
          return null;
        }
        const mine = found.claimed_by && instance && found.claimed_by.instance === instance.id;
        if (found.status !== 'queued') {
          if (!mine) {
            warn('job', 'a job is claimed by another browser profile', { job: found.id, claimed_by: found.claimed_by });
            await noteBridge({ jobElsewhere: { id: found.id, claimed_by: found.claimed_by, at: now() } });
            return null;
          }
          if (await settleStrayJob(found)) return null;
        }
        const claimed = await native.request({ type: 'job.claim', job: found.id, instance: instance.id, extension_version: extensionVersion });
        return await adoptJob(claimed.job);
      } catch (e) {
        warn('job', 'pickup failed', { reason, code: e && e.code, message: String(e && e.message || e) });
        return null;
      } finally {
        if (!jobActive()) native.disconnect();
      }
    })();
    try { return await pickupInFlight; } finally { pickupInFlight = null; }
  }

  // The host's job becomes this worker's current job, claimed, with the
  // worker's own fields on top: the tab and the nonce the page helper will
  // be given, what was pressed and loaded, how often it started again.
  // `extra` pins the tab a Duplicate runs in and the page it goes to first.
  async function adoptJob(hostJob, extra = {}) {
    job = { ...hostJob, phase: 'claimed', status: 'claimed', tabId: null, nonce: null, pressedAt: null,
      probeId: null, lastStatusText: '', injectedAt: null, scriptInjectedAt: null, exportLoaded: false,
      reruns: 0, heldFrom: null, heldReason: null, identityConfirmed: false, created_project: hostJob.created_project || null,
      navigateTo: null, navigatedAt: null, choices: null, accounts: null, chainError: null, ...extra };
    lastRows = [];
    lastConsoleError = '';
    await sset(KEYS.job, job);
    await startGate(job.id);
    await noteBridge({ jobElsewhere: null });
    emit('claimed', { instance: instance.id, extension_version: extensionVersion, chrome: chromeVersion });
    armAlarm();
    runJob();
    return job;
  }

  // A job the host still lists as this browser's while nothing is active
  // here: its end never reached the host (the port dropped and the worker
  // died inside the reconnect window), or this worker lost its record. The
  // host is told what is known instead of the import running again, which
  // could create a second project. True when the job was settled this way.
  async function settleStrayJob(found) {
    const local = job && job.id === found.id && isTerminal(job.phase) ? job : null;
    if (local) {
      info('job', 'the host still lists a job that ended here; its end is sent again', { job: found.id, phase: local.phase });
      const result = local.result || null;
      if (local.phase === 'done') await native.event({ event: 'done', job: local.id, result });
      else if (local.phase === 'failed') await native.event({ event: 'failed', job: local.id, error: local.error || '', result });
      else await native.event({ event: 'cancelled', job: local.id, result });
      await native.event({ event: 'phase', job: local.id, phase: local.phase, detail: '' });
      return true;
    }
    const made = found.created_project;
    if (made && typeof made === 'object') {
      warn('job', 'the host lists a job of this browser that created a project; it is not run again', { job: found.id });
      const result = {
        created: { id: text(made.id, 200), name: text(made.name, 300), url: text(made.url, 500) },
        status: '', link: text(made.url, 500), paused: false, rows: [], counts: countRows([]),
        script_sha256: found.script ? found.script.sha256 : null,
      };
      await native.event({ event: 'failed', job: found.id, error: 'This browser lost track of the import after the project was created.', result });
      await native.event({ event: 'phase', job: found.id, phase: 'failed', detail: '' });
      return true;
    }
    return false;
  }

  // A fresh gate for a job. A gate left non-terminal by an earlier job (the
  // worker died before finishing it) is closed first.
  async function startGate(jobId) {
    try {
      await gate.start(jobId);
    } catch (e) {
      warn('gate', 'closing a gate left open by an earlier job', { message: String(e && e.message || e) });
      try { await gate.finish('cancelled'); } catch (e2) { /* nothing */ }
      await gate.start(jobId);
    }
  }

  async function noteBridge(patch) {
    try {
      const current = (await sget(KEYS.bridge)) || {};
      await sset(KEYS.bridge, { ...current, ...patch });
    } catch (e) { /* the panel shows a stale line at worst */ }
  }

  function armAlarm() {
    if (!chrome.alarms || typeof chrome.alarms.create !== 'function') return;
    try { chrome.alarms.create(ALARM_POLL, { periodInMinutes: 1 }); } catch (e) { /* nothing */ }
  }

  function clearAlarm() {
    if (!chrome.alarms || typeof chrome.alarms.clear !== 'function') return;
    try {
      const r = chrome.alarms.clear(ALARM_POLL);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) { /* nothing */ }
  }

  // ---------------------------------------------------------- driving the job

  async function runJob() {
    if (driving || !job) return;
    driving = true;
    try {
      for (;;) {
        if (!jobActive() || job.phase === 'held' || job.phase === 'running' || job.phase === 'choosing') break;
        if (job.phase === 'claimed') { if (!(await stepInject())) break; continue; }
        if (job.phase === 'preflight') { if (!(await stepProbe())) break; continue; }
        if (job.phase === 'loading') { await stepLoad(); continue; }
        if (job.phase === 'ready') { await stepPress(); continue; }
        break;
      }
    } catch (e) {
      // A worker that is being torn down leaves the job for the next one.
      if (!stopped) await failJob(String(e && e.message || e));
    } finally {
      driving = false;
    }
  }

  async function chooseTab() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' }); } catch (e) { tabs = []; }
    if (!Array.isArray(tabs) || !tabs.length) return null;
    const preferred = tabs.find(t => t.id === lastClaudeTab);
    const active = tabs.find(t => t.active);
    return (preferred || active || tabs[0]).id;
  }

  // The page helper installs once per document, so a job that goes to a
  // page first (a Duplicate: the tab is reloaded at the start, sent to the
  // chosen project for the export, and to claude.ai for the import after
  // it) is sent there before anything is injected, and waits for that
  // page's own report. True once the tab was sent.
  async function navigateFirst(tabId) {
    if (!job.navigateTo) return false;
    if (!job.navigatedAt) {
      await saveJob({ tabId, navigatedAt: now() });
      info('job', 'sending the tab to a page first', { url: job.navigateTo });
      await navigateTab(tabId, job.navigateTo);
      return true;
    }
    const known = pageStates.get(tabId);
    const reported = !!(known && known.at > job.navigatedAt);
    if (!reported && now() - job.navigatedAt < NAVIGATE_WAIT_MS) return true;
    return false;
  }

  async function navigateTab(tabId, url) {
    if (!chrome.tabs) return;
    const known = pageStates.get(tabId);
    const here = known && known.state ? known.state.url : '';
    try {
      if (here === url && typeof chrome.tabs.reload === 'function') await chrome.tabs.reload(tabId);
      else if (typeof chrome.tabs.update === 'function') await chrome.tabs.update(tabId, { url });
    } catch (e) {
      warn('job', 'the tab could not be sent to the page', { url, message: String(e && e.message || e) });
    }
  }

  async function stepInject() {
    let tabId = job.tabId != null && (await tabExists(job.tabId)) ? job.tabId : null;
    if (tabId == null) tabId = await chooseTab();
    if (tabId == null) {
      info('job', 'waiting for a claude.ai tab to open');
      return false;
    }
    if (await navigateFirst(tabId)) return false;
    const nonce = uuid();
    pagePort = null;
    pageNonce = null;
    await saveJob({ tabId, nonce, injectedAt: now(), phase: 'preflight' });
    emit('phase', { phase: 'preflight', detail: '' });
    const cfg = config.get() || {};
    const boot = {
      jobId: job.id, nonce, name: text(job.name, 300), kind: jobKind(), project: bootProject(chosenProject()),
      expected: expectedIdentity(), bodyMarkers: BODY_MARKERS, accountEndpoints: ACCOUNT_ENDPOINTS,
      requestTimeoutMs: cfg.requestTimeoutMs,
    };
    const code = `globalThis.__cswapBoot = ${JSON.stringify(boot)};`;
    // The waiter goes on before the injection: page.js connects and attaches
    // while it evaluates, which can reach this worker before execute()
    // resolves. (When execute() throws, the job ends and settles the waiter.)
    const attach = waitFor('attach', ATTACH_TIMEOUT_MS,
      'The page helper did not connect within 20 s. Is "Allow User Scripts" turned on for the extension, and is the tab a claude.ai page?');
    attach.catch(() => {});
    await chrome.userScripts.execute({ target: { tabId }, world: WORLD, js: [{ code }, { file: 'src/page.js' }] });
    await attach;
    return true;
  }

  async function stepProbe() {
    if (!pagePort) {
      await waitFor('attach', ATTACH_TIMEOUT_MS, 'The page helper did not reconnect within 20 s.');
    }
    const dom = await probeDom();
    const page = dom ? safeClassifyPage(dom, 'preflight') : null;
    const pageKind = kindOf(page);
    if (pageKind && pageKind !== 'page-reloaded' && pageKind !== 'tab-closed') {
      await holdJob({ kind: pageKind, found: page, evidence: dom, reason: 'interrupted' });
      return false;
    }
    const identity = await probeIdentity();
    // The probe's own answer (a 401, a challenge) went through gate.report
    // and held the job already: the same event is not raised a second time.
    if (!jobActive() || job.phase === 'held') return false;
    if (jobKind() === 'export' && !chosenProject()) return stepChoices(identity);
    const bad = safeClassifyIdentity(identity);
    if (bad && !(bad.kind === 'identity-unknown' && job.identityConfirmed)) {
      await holdJob({ kind: bad.kind, found: bad, evidence: { ...identity, expected: expectedIdentity().email }, actual: identity.email, reason: 'interrupted' });
      return false;
    }
    await saveJob({ phase: 'loading' });
    emit('phase', { phase: 'loading', detail: '' });
    return true;
  }

  // A Duplicate before its project is chosen: whoever is signed in is the
  // account the project is copied from, so there is nothing to compare
  // the identity with, only a signed-out page to stop on. The projects
  // that account can see are listed and the job waits in 'choosing' for
  // the side panel. Always false: nothing drives on from here but the
  // person's choice.
  async function stepChoices(identity) {
    const bad = safeClassifyIdentity(identity);
    if (bad && bad.kind !== 'identity-unknown') {
      await holdJob({ kind: bad.kind, found: bad, evidence: { ...identity, expected: '' }, actual: identity.email, reason: 'interrupted' });
      return false;
    }
    const email = typeof identity.email === 'string' ? identity.email.trim() : '';
    await saveJob({ account: { slot: '', email, org_uuid: '' }, identityConfirmed: !email });
    const choices = await probeProjects();
    await saveJob({ choices, phase: 'choosing' });
    emit('phase', { phase: 'choosing', detail: '' });
    if (choices.error) warn('job', 'the projects could not all be listed', { error: choices.error });
    return false;
  }

  async function stepLoad() {
    await ensureHost();
    const flow = jobKind();
    if (flow === 'import') {
      let listing = await sget(KEYS.export);
      if (!job.exportLoaded || !listing || listing.jobId !== job.id) {
        const reply = await native.request({ type: 'export.list', job: job.id });
        listing = { jobId: job.id, root: text(reply.root, 300) || 'export', files: Array.isArray(reply.files) ? reply.files : [] };
        await sset(KEYS.export, listing);
        await saveJob({ exportLoaded: true });
      }
      pagePost({ type: MSG.exportSet, root: listing.root, files: listing.files });
    }
    if (!job.scriptInjectedAt) {
      const script = await native.request({ type: 'script.get', job: job.id });
      if (typeof script.text !== 'string' || !script.text) throw new Error(`The bridge sent no ${flow} script.`);
      const sha = await sha256Hex(script.text);
      const wanted = job.script && job.script.sha256;
      if (sha && wanted && sha !== wanted) throw new Error(`The ${flow} script the bridge sent is not the one the job was queued with.`);
      await saveJob({ scriptInjectedAt: now(), scriptSha256: script.sha256 || sha || null });
      await chrome.userScripts.execute({ target: { tabId: job.tabId }, world: WORLD, js: [{ code: script.text }] });
    }
    const known = pageStates.get(job.tabId);
    if (!(known && known.observation && known.observation.ready)) {
      try {
        await waitFor('ready', READY_TIMEOUT_MS);
      } catch (e) {
        throw new Error(lastConsoleError
          ? `The ${flow} script did not start: ${lastConsoleError}`
          : `The ${flow} script did not show its button within 90 s.`);
      }
    }
    await saveJob({ phase: 'ready' });
    emit('phase', { phase: 'ready', detail: '' });
  }

  async function stepPress() {
    if (!job.pressedAt) {
      // Persisted first: after a restart no second press ever happens.
      await saveJob({ pressedAt: now() });
      pagePost({ type: MSG.press });
    }
    await saveJob({ phase: 'running' });
    emit('phase', { phase: 'running', detail: '' });
  }

  async function probeIdentity() {
    const probeId = uuid();
    await saveJob({ probeId });
    if (!pagePost({ type: MSG.probeIdentity, probeId })) throw new Error('The page helper is not connected.');
    return waitFor(`identity:${probeId}`, PROBE_TIMEOUT_MS, 'The page did not answer the identity check within 90 s.');
  }

  // The projects the signed-in account can see, as the page helper lists
  // them with the export script's own requests, shaped for the panel.
  async function probeProjects() {
    const probeId = uuid();
    if (!pagePost({ type: MSG.probeProjects, probeId })) throw new Error('The page helper is not connected.');
    const found = await waitFor(`projects:${probeId}`, PROBE_TIMEOUT_MS, 'The page did not list its projects within 90 s.');
    return projectChoices(found);
  }

  async function probeDom() {
    const port = job ? contentPorts.get(job.tabId) : null;
    if (port) {
      const id = uuid();
      try {
        port.postMessage({ id, type: MSG.probeDom });
        return await waitFor(`dom:${id}`, DOM_PROBE_TIMEOUT_MS);
      } catch (e) { /* fall back to the last report */ }
    }
    const known = job ? pageStates.get(job.tabId) : null;
    return known ? known.state : null;
  }

  // ---------------------------------------------------------- holds, interruptions, resume

  async function holdGate(reason, interruption) {
    try {
      if (typeof gate.hold === 'function') { await gate.hold({ reason, interruption }); return; }
      // The gate has no hold of its own for an interruption the page or the
      // identity probe raised. When it already holds the step nothing more
      // is needed; otherwise a pause keeps every script request waiting.
      const snap = safeSnapshot();
      if (snap && snap.held) return;
      await gate.pause();
    } catch (e) { warn('gate', 'could not hold the gate', { message: String(e && e.message || e) }); }
  }

  function currentInterruptionId() {
    const current = typeof interrupts.current === 'function' ? interrupts.current() : null;
    return current && !current.resolvedAt ? current.id : null;
  }

  // What the gate says it still holds after resume(): its answer names the
  // reason, or its snapshot does.
  function heldReasonAfter(answer) {
    if (answer && typeof answer.held === 'string' && answer.held) return answer.held;
    const snap = safeSnapshot();
    return snap && snap.held && snap.held.reason ? snap.held.reason : null;
  }

  // The gate's own rule, read from its snapshot: a create it permitted may
  // have acted unless the site answered it with a 4xx. One that never got
  // its answer (the page went away in the meantime) counts as may-have.
  function createMayHaveActed() {
    if (job && job.created_project) return true;
    const snap = safeSnapshot();
    if (!snap || !snap.created || (snap.jobId && job && snap.jobId !== job.id)) return false;
    const c = snap.created;
    if (c.pending || c.status == null) return true;
    return !(c.status >= 400 && c.status < 500);
  }

  function knownCreated() {
    if (job && job.created_project) return job.created_project;
    const snap = safeSnapshot();
    if (!snap || !snap.created || !snap.created.id || (snap.jobId && job && snap.jobId !== job.id)) return null;
    return { id: snap.created.id, url: snap.created.url || '', name: snap.created.name || '' };
  }

  // For an export job the script's box is the exporter's, which content.js
  // reports apart; the classifier only knows "the script's box".
  function safeClassifyPage(probe, phase) {
    const seen = jobKind() === 'export' && probe && typeof probe === 'object' ? { ...probe, hasImporter: !!probe.hasExporter } : probe;
    try { return classify.page(seen, jobStateForClassify(phase)); } catch (e) { warn('page', 'classifyPage threw', { message: String(e && e.message || e) }); return null; }
  }

  function safeClassifyIdentity(identity) {
    try { return classify.identity(identity, expectedIdentity()); } catch (e) { warn('page', 'classifyIdentity threw', { message: String(e && e.message || e) }); return null; }
  }

  // Records an interruption. `found` is what a classifier returned (kept
  // whole, so its evidence and context travel); otherwise a plain kind with
  // evidence. The current one is replaced only when `replace` says so (a
  // Resume that found the page still interrupted); a repeat of the same kind
  // while it is current changes nothing.
  async function raiseInterruption({ kind, found, evidence, actual, status, requestId, replace = false }) {
    const current = typeof interrupts.current === 'function' ? interrupts.current() : null;
    if (current && !current.resolvedAt && current.kind === kind && !replace) return current;
    const ctx = { expected: expectedIdentity().email, actual: actual || '', status: status || (evidence && evidence.status) || '',
      link: (job && job.created_project && job.created_project.url) || '', flow: jobKind() };
    const partial = found && typeof found === 'object'
      ? { ...found, kind, ctx: { ...(found.ctx || {}), ...ctx }, requestId: requestId || found.requestId }
      : { kind, evidence: evidence || {}, ctx, requestId };
    if (replace && current) partial.replace = true;
    let made = null;
    try { made = await interrupts.raise(partial); } catch (e) { warn('page', 'raise threw', { message: String(e && e.message || e) }); }
    return made || { kind, ...safeDescribe(kind, ctx) };
  }

  function safeDescribe(kind, ctx) {
    try { return classify.describe(kind, ctx) || { what: kind, todo: '' }; } catch (e) { return { what: kind, todo: '' }; }
  }

  // The job stops here until the person acts. `reason` is the gate's hold
  // reason; `kind` names an interruption when there is one.
  async function holdJob({ kind, found, evidence, actual, reason, interruption, status, requestId, stepKey, attempt }) {
    const from = job.phase === 'held' ? job.heldFrom : job.phase;
    let made = interruption || null;
    if (kind) made = await raiseInterruption({ kind, found: found || interruption, evidence, actual, status, requestId });
    if (reason === 'interrupted' || kind) await holdGate('interrupted', made);
    await saveJob({ phase: 'held', heldFrom: from, heldReason: reason || 'interrupted', heldAt: now() });
    emit('phase', { phase: 'held', detail: kind || reason || '' });
    if (kind) {
      emit('interruption', { kind, what: made ? made.what : '', todo: made ? made.todo : '', evidence: redactValue(evidence || {}) });
      notify(`cswap ${jobKind()} stopped`, made && made.what ? made.what : kind);
    } else {
      emit('held', { requestId: requestId || '', stepKey: stepKey || '', reason: reason || '', status: status || 0, attempt: attempt || 0 });
      notify(`cswap ${jobKind()} is waiting for you`, `A step failed (HTTP ${status || 0}). Open the cswap panel to retry or give up.`);
    }
  }

  async function resumeJob(skipIdentity = false) {
    if (!jobActive() || job.phase !== 'held') return { ok: false, error: 'Nothing is held.' };
    const heldAt = job.heldAt || now();
    const heldFrom = job.heldFrom || 'running';
    // The page went away: start again from the beginning, unless a create
    // may have acted, which rerunFromClaimed() refuses.
    if (heldFrom === 'claimed' || !pagePort) return rerunFromClaimed();
    const dom = await probeDom();
    const page = dom ? safeClassifyPage(dom, heldFrom === 'running' ? 'running' : heldFrom) : null;
    const pageKind = kindOf(page);
    if (pageKind === 'page-reloaded' || pageKind === 'tab-closed') {
      await handlePageGone(pageKind);
      return { ok: false, error: `The ${jobKind()} page is gone.` };
    }
    if (pageKind) {
      const made = await raiseInterruption({ kind: pageKind, found: page, evidence: dom, replace: true });
      return { ok: false, error: made.what || pageKind };
    }
    if (!skipIdentity) {
      let identity;
      const before = currentInterruptionId();
      try {
        identity = await probeIdentity();
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
      if (!jobActive()) return { ok: false, error: 'The job has ended.' };
      if (currentInterruptionId() !== before) {
        // The probe's own answer was an interruption, which the report
        // handler has recorded in place of the old one: that is the answer.
        const current = interrupts.current();
        return { ok: false, error: (current && current.what) || 'The check was interrupted.' };
      }
      const bad = safeClassifyIdentity(identity);
      if (bad && !(bad.kind === 'identity-unknown' && job.identityConfirmed)) {
        const made = await raiseInterruption({ kind: bad.kind, found: bad, evidence: { ...identity, expected: expectedIdentity().email }, actual: identity.email, replace: true });
        return { ok: false, error: made.what || bad.kind };
      }
    }
    if (typeof interrupts.current === 'function' && interrupts.current()) await interrupts.clear('person');
    const answer = await gate.resume();
    const stillHeld = heldReasonAfter(answer);
    if (stillHeld) {
      // The gate holds a failed step, which only Retry or Give up decide:
      // the job stays held (the interruption, if there was one, is cleared).
      info('gate', 'resume left a held step for Retry or Give up', { reason: stillHeld });
      if (job.heldReason !== stillHeld) await saveJob({ heldReason: stillHeld });
      emit('phase', { phase: 'held', detail: stillHeld });
      return { ok: false, error: STILL_HELD_TEXT };
    }
    emit('resumed', { by: 'person', after_seconds: Math.round((now() - heldAt) / 1000) });
    const back = heldFrom === 'running' || heldFrom === 'ready' ? 'running' : heldFrom;
    await saveJob({ phase: back, heldFrom: null, heldReason: null });
    emit('phase', { phase: back, detail: 'resumed' });
    if (back !== 'running') runJob();
    return { ok: true };
  }

  async function rerunFromClaimed() {
    if (createMayHaveActed()) {
      // Never a second create: the gate says the first one may have acted.
      await failJob(knownCreated() ? AFTER_CREATE_TEXT : UNSURE_CREATE_TEXT, true);
      return { ok: false, error: 'The import cannot start again: the project may already exist.' };
    }
    if (job.reruns >= MAX_RERUNS) {
      await failJob(`The ${jobKind()} page went away three times before anything was created.`);
      return { ok: false, error: 'Given up after three attempts.' };
    }
    if (typeof interrupts.current === 'function' && interrupts.current()) await interrupts.clear('person');
    try { await gate.finish('cancelled'); } catch (e) { /* a fresh start follows */ }
    await startGate(job.id);
    // A Duplicate's export starts again on the project's page, which it may
    // already be on; its import, and an import queued from the command
    // line, start again wherever claude.ai is open.
    const again = jobKind() === 'export' && chosenProject() ? { navigateTo: projectUrl(chosenProject()), navigatedAt: null } : { navigateTo: null, navigatedAt: null };
    await saveJob({ phase: 'claimed', reruns: (job.reruns || 0) + 1, tabId: null, nonce: null, injectedAt: null,
      scriptInjectedAt: null, exportLoaded: false, pressedAt: null, heldFrom: null, heldReason: null, ...again });
    emit('phase', { phase: 'preflight', detail: 'starting again' });
    runJob();
    return { ok: true };
  }

  async function handlePageGone(kind) {
    if (!jobActive()) return;
    const created = knownCreated();
    if (created || createMayHaveActed()) {
      // After a create that acted, or may have, there is no starting again:
      // the job ends with what is known, so the person checks claude.ai.
      if (created && !job.created_project) await saveJob({ created_project: { id: created.id, url: created.url || '', name: created.name || '', at: isoOf(now()) } });
      await raiseInterruption({ kind, evidence: { phase: job.phase }, replace: true });
      await failJob(created ? AFTER_CREATE_TEXT : UNSURE_CREATE_TEXT, true);
      return;
    }
    if (job.phase === 'claimed') return;
    if (job.phase === 'held' && job.heldFrom === 'claimed') return;
    // A Duplicate still waiting for its choice lost nothing: the projects
    // are listed again on a fresh page, and the panel keeps its form.
    if (job.phase === 'choosing') { await rerunFromClaimed(); return; }
    const made = await raiseInterruption({ kind, evidence: { phase: job.phase }, replace: job.phase === 'held' });
    await holdGate('interrupted', made);
    await saveJob({ phase: 'held', heldFrom: 'claimed', heldReason: 'interrupted', heldAt: now() });
    emit('phase', { phase: 'held', detail: kind });
    emit('interruption', { kind, what: made.what || '', todo: made.todo || '', evidence: { phase: job.phase } });
    notify(`cswap ${jobKind()} stopped`, made.what || kind);
  }

  function safeSnapshot() {
    try { return gate.snapshot(); } catch (e) { return null; }
  }

  // ---------------------------------------------------------- ending a job

  function partialResult() {
    const made = job && job.created_project ? { id: job.created_project.id, name: job.created_project.name, url: job.created_project.url } : null;
    const result = {
      created: made,
      status: job ? text(job.lastStatusText, 1000) : '',
      link: made ? made.url : '',
      paused: false,
      rows: lastRows,
      counts: countRows(lastRows),
      script_sha256: job && job.script ? job.script.sha256 : null,
    };
    // A create that went out without an answer: the command line says so,
    // since nothing here can name the project.
    if (!made && createMayHaveActed()) result.create_unconfirmed = true;
    return result;
  }

  async function finishJob(outcome, { result = null, errorText = '' } = {}) {
    if (!job || isTerminal(job.phase) || stopped) return;
    const final = result ? { ...result, script_sha256: job.script ? job.script.sha256 : result.script_sha256 || null } : null;
    if (final && !final.created && job.created_project) {
      final.created = { id: job.created_project.id, name: job.created_project.name, url: job.created_project.url };
      if (!final.link) final.link = job.created_project.url;
    }
    await saveJob({ phase: outcome, result: final, error: errorText || null, heldFrom: null, heldReason: null });
    try { await gate.finish(outcome); } catch (e) { /* the gate may already be terminal */ }
    if (outcome === 'cancelled' && typeof interrupts.current === 'function' && interrupts.current()) {
      try { await interrupts.clear('cancel'); } catch (e) { /* nothing */ }
    }
    if (outcome === 'done') emit('done', { result: final });
    else if (outcome === 'failed') emit('failed', { error: errorText, result: final });
    else emit('cancelled', { result: final });
    emit('phase', { phase: outcome, detail: errorText || '' });
    const flow = jobKind();
    const chaining = outcome === 'done' && flow === 'export';
    if (!chaining) {
      notify(outcome === 'done' ? `cswap ${flow} finished` : outcome === 'failed' ? `cswap ${flow} failed` : `cswap ${flow} cancelled`,
        outcome === 'done' ? (final && final.status) || 'Done.' : errorText || 'Stopped.');
    }
    clearAlarm();
    for (const [key, entry] of [...waiters]) { waiters.delete(key); if (entry.timer) unschedule(entry.timer); entry.reject(new Error(`job ended: ${outcome}`)); }
    // The host hears the last events, then the connection may close.
    await flushEvents();
    if (chaining) { await chainImport(); return; }
    if (!eventQueue.length) native.disconnect();
  }

  // The second half of a Duplicate: the bridge queues the import of the
  // export just finished, into the account chosen, and this worker takes
  // it up in the same tab, which goes to claude.ai first so the import
  // script starts on a fresh page. When the import cannot be queued (the
  // export is not whole, another job got in first, the bridge is gone)
  // the export stays on disk and the person is told the line that imports
  // it; nothing is tried again on its own.
  async function chainImport() {
    const exported = job;
    const texts = chainTexts(exported);
    try {
      await ensureHost();
      await flushEvents();
      if (eventQueue.length) throw new Error('the bridge has not heard that the export finished');
      const queued = await native.request({ type: 'import.queue', job: exported.id });
      if (!queued || !queued.job || typeof queued.job.id !== 'string') throw new Error('the bridge queued no import');
      const claimed = await native.request({ type: 'job.claim', job: queued.job.id, instance: instance.id, extension_version: extensionVersion });
      info('job', 'the export is done; its import is queued', { from: exported.id, job: claimed.job.id });
      notify('cswap duplicate: export finished', texts.importing);
      await adoptJob(claimed.job, { tabId: exported.tabId, navigateTo: CLAUDE_URL_PREFIX });
    } catch (e) {
      const message = String(e && e.message || e);
      warn('job', 'the import of the duplicate could not start', { message, from: exported.id });
      if (job === exported) await saveJob({ chainError: message });
      notify('cswap duplicate stopped', `${texts.notImported} ${message}`);
      if (!eventQueue.length && !jobActive()) native.disconnect();
    }
  }

  async function failJob(message, afterCreate = false) {
    error('job', 'failed', { message });
    await finishJob('failed', { result: afterCreate || lastRows.length ? partialResult() : null, errorText: message });
  }

  async function cancelJob(by) {
    if (!jobActive()) return { ok: false, error: 'Nothing is running.' };
    const made = knownCreated();
    if (made && !job.created_project) {
      await saveJob({ created_project: { id: made.id, url: made.url || '', name: made.name || '', at: isoOf(now()) } });
    }
    info('job', 'cancelling', { by, create_unconfirmed: !made && createMayHaveActed() });
    try { await gate.cancel(); } catch (e) { warn('gate', 'cancel failed', { message: String(e && e.message || e) }); }
    pagePost({ type: MSG.cancel });
    if (job.tabId != null && chrome.tabs && typeof chrome.tabs.reload === 'function') {
      try { await chrome.tabs.reload(job.tabId); } catch (e) { /* the tab may be gone already */ }
    }
    await finishJob('cancelled', { result: partialResult() });
    return { ok: true };
  }

  // ---------------------------------------------------------- the page port

  function senderOk(port, wantTab) {
    const sender = port.sender || {};
    const url = typeof sender.url === 'string' ? sender.url : '';
    if (!url.startsWith(CLAUDE_URL_PREFIX)) return false;
    if (wantTab && (!sender.tab || sender.tab.id !== job.tabId)) return false;
    return true;
  }

  // A port's listeners go on at once (a message sent before them is lost)
  // and the port is admitted once the worker is ready: an attach that beats
  // start() waits here instead of being dropped.
  function admit(port, what, check) {
    return ready.then(() => {
      const reason = check();
      if (!reason) return true;
      warn(what === 'panel' ? 'panel' : 'page', `dropped a ${what} port`, { reason, url: pathOf(port) });
      try { port.disconnect(); } catch (e) { /* nothing */ }
      return false;
    });
  }

  function onPageConnect(port) {
    if (!port || port.name !== PORTS.page) return;
    const admitted = admit(port, 'page', () => (!jobActive() ? 'no job' : !senderOk(port, true) ? 'wrong tab or origin' : null));
    let attached = false;
    port.onMessage.addListener(guarded('page message', async msg => {
      if (!(await admitted)) return;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === MSG.pageAttach || !attached) {
        // Nothing but an attach is heard before one, and an attach is always
        // checked against the job's current nonce, even on an old port.
        if (msg.type !== MSG.pageAttach) return;
        const reason = !jobActive() || msg.jobId !== job.id ? 'no-job' : msg.nonce !== job.nonce ? 'bad-nonce' : null;
        if (reason) {
          warn('page', 'refused a page attach', { reason });
          attached = false;
          if (pagePort === port) pagePort = null;
          port.postMessage({ re: msg.id, ok: false, reason });
          return;
        }
        attached = true;
        pagePort = port;
        pageNonce = msg.nonce;
        if (pageGoneTimer) { unschedule(pageGoneTimer); pageGoneTimer = null; }
        if (msg.state && typeof msg.state === 'object') rememberObservation(msg.state);
        port.postMessage({ re: msg.id, ok: true, phase: job.phase, cancelled: job.phase === 'cancelled' });
        info('page', 'attached', { pending: Array.isArray(msg.pending) ? msg.pending.length : 0 });
        signal('attach', msg);
        signal('page-back', msg);
        return;
      }
      if (pagePort !== port) return;
      await handlePageMessage(port, msg);
    }));
    port.onDisconnect.addListener(guarded('page disconnect', async () => {
      if (!(await admitted)) return;
      if (pagePort !== port) return;
      pagePort = null;
      pageNonce = null;
      if (!jobActive()) return;
      debug('page', 'page port disconnected; waiting for it to come back');
      pageGoneTimer = schedule(() => {
        pageGoneTimer = null;
        if (!pagePort && jobActive()) handlePageGone('tab-closed').catch(() => {});
      }, PAGE_GONE_MS);
    }));
  }

  function pathOf(port) {
    try { return new URL(port.sender.url).pathname; } catch (e) { return ''; }
  }

  function rememberObservation(observation) {
    const known = pageStates.get(job.tabId) || { state: null, at: 0 };
    known.observation = observation;
    pageStates.set(job.tabId, known);
    if (observation.ready) signal('ready', observation);
    if (typeof observation.statusText === 'string' && observation.statusText) job.lastStatusText = observation.statusText;
  }

  function reply(port, msg, body) {
    try { port.postMessage({ re: msg.id, ok: true, ...body }); } catch (e) { /* the page re-asks */ }
  }

  function refuse(port, msg, reason, extra = {}) {
    try { port.postMessage({ re: msg.id, ok: false, reason, ...extra }); } catch (e) { /* nothing */ }
  }

  async function handlePageMessage(port, msg) {
    const handler = handlers[msg.type];
    if (!handler) { refuse(port, msg, 'unknown-type'); return; }
    await handler(port, msg);
  }

  handlers[MSG.exportList] = async (port, msg) => {
    const listing = await sget(KEYS.export);
    if (!listing || listing.jobId !== job.id) { refuse(port, msg, 'not-loaded'); return; }
    reply(port, msg, { root: listing.root, files: listing.files });
  };

  handlers[MSG.fileRead] = async (port, msg) => {
    const path = text(msg.path, 4096);
    const listing = await sget(KEYS.export);
    const known = listing && listing.jobId === job.id && Array.isArray(listing.files) && listing.files.some(f => f && f.path === path);
    if (!path || !known) { refuse(port, msg, 'not-found'); return; }
    let n = 0;
    try {
      await ensureHost();
      await native.requestStream({ type: 'file.read', job: job.id, path }, part => {
        try {
          port.postMessage({ re: msg.id, part: n++, last: !!part.last, offset: Number(part.offset) || 0, data: typeof part.data === 'string' ? part.data : '' });
        } catch (e) { /* the page re-asks after reconnecting */ }
      });
      debug('page', 'file streamed', { path, parts: n });
    } catch (e) {
      warn('page', 'file read failed', { path, code: e && e.code, message: String(e && e.message || e) });
      refuse(port, msg, e && e.code === 'not-found' ? 'not-found' : 'unavailable');
    }
  };

  handlers[MSG.gatePermit] = async (port, msg) => {
    const req = {
      requestId: text(msg.requestId, 40), stepKey: text(msg.stepKey, 2000), method: text(msg.method, 10).toUpperCase(),
      path: text(msg.path, 2000), kind: msg.kind === 'probe' ? 'probe' : 'script',
      bodyBytes: Number.isFinite(msg.bodyBytes) && msg.bodyBytes >= 0 ? Math.floor(msg.bodyBytes) : 0,
    };
    if (typeof msg.retryOf === 'string') req.retryOf = msg.retryOf;
    if (!req.requestId || !req.stepKey || !req.method || !req.path) { refuse(port, msg, 'bad-request'); return; }
    let result;
    try {
      result = await gate.permit(req);
    } catch (e) {
      warn('gate', 'permit failed', { message: String(e && e.message || e) });
      result = { ok: false, reason: 'no-job' };
    }
    try { port.postMessage({ re: msg.id, ...result }); } catch (e) { /* re-asked after reconnect; answered from the gate's memory */ }
  };

  handlers[MSG.gateReport] = async (port, msg) => {
    const rep = {
      requestId: text(msg.requestId, 40), permit: text(msg.permit, 40), status: Number(msg.status) || 0, ok: !!msg.ok,
      redirected: !!msg.redirected, finalPath: text(msg.finalPath, 2000), headers: pickAllowed(msg.headers),
      elapsedMs: Number(msg.elapsedMs) || 0, markers: Array.isArray(msg.markers) ? msg.markers.map(m => text(m, 100)) : [],
    };
    if (msg.bodyJson && typeof msg.bodyJson === 'object') rep.bodyJson = msg.bodyJson;
    if (typeof msg.bodyExcerpt === 'string') rep.bodyExcerpt = msg.bodyExcerpt.slice(0, 200);
    if (msg.error && typeof msg.error === 'object') rep.error = { name: text(msg.error.name, 100), message: text(msg.error.message, 200) };
    if (msg.created && typeof msg.created === 'object' && typeof msg.created.id === 'string') {
      rep.created = { id: text(msg.created.id, 200), url: text(msg.created.url, 500), name: text(msg.created.name, 300) };
      if (!job.created_project) {
        await saveJob({ created_project: { ...rep.created, at: isoOf(now()) } });
        emit('created', { id: rep.created.id, url: rep.created.url, name: rep.created.name });
      }
    }
    if (!rep.requestId) { refuse(port, msg, 'bad-request'); return; }
    let verdict;
    try {
      verdict = await gate.report(rep);
    } catch (e) {
      warn('gate', 'report failed', { message: String(e && e.message || e) });
      verdict = { action: 'pass' };
    }
    const evidence = { status: rep.status, headers: rep.headers, markers: rep.markers, finalPath: rep.finalPath, redirected: rep.redirected,
      bodyExcerpt: rep.bodyExcerpt, method: text(msg.method, 10), path: rep.finalPath, requestId: rep.requestId };
    if (verdict && verdict.action === 'hold' && jobActive() && job.phase !== 'cancelled') {
      let kind = null;
      if (verdict.reason === 'interrupted') {
        kind = (verdict.interruption && verdict.interruption.kind) || verdict.kind || null;
        if (!kind) {
          try { const c = classify.response(rep); kind = c && c.kind ? c.kind : 'challenge'; } catch (e) { kind = 'challenge'; }
        }
      }
      // The attempt count is the gate's: the page does not send one.
      const snap = safeSnapshot();
      const held = snap && snap.held && snap.held.permit === rep.permit ? snap.held : null;
      await holdJob({
        kind, reason: verdict.reason || 'failed-step', interruption: verdict.interruption || null, evidence,
        status: rep.status, requestId: rep.requestId, stepKey: (held && held.stepKey) || text(msg.stepKey, 2000),
        attempt: held && Number.isFinite(held.attempt) ? held.attempt : Number(msg.attempt) || 0,
      });
    } else if (verdict && verdict.verdict === 'interrupt' && jobActive() && job.phase === 'held') {
      // Seen while already held (a probe during Resume, or a second request
      // of the script): the current interruption is replaced, the hold stays.
      const kind = (verdict.interruption && verdict.interruption.kind) || verdict.kind || 'challenge';
      await raiseInterruption({ kind, found: verdict.interruption || null, evidence, status: rep.status, requestId: rep.requestId, replace: true });
    }
    try { port.postMessage({ re: msg.id, ok: true, ...verdict }); } catch (e) { /* re-asked after reconnect */ }
  };

  function pickAllowed(headers) {
    const out = {};
    if (!headers || typeof headers !== 'object') return out;
    for (const name of ['retry-after', 'content-type', 'content-length', 'cf-mitigated', 'cf-ray', 'server', 'server-timing', 'location', 'date']) {
      if (typeof headers[name] === 'string') out[name] = headers[name].slice(0, 200);
    }
    return out;
  }

  // A piece of a file the export script writes, handed to the bridge as it
  // is; the bridge's answer (saved, or why not) goes back to the page.
  handlers[MSG.fileWrite] = async (port, msg) => {
    if (jobKind() !== 'export') { refuse(port, msg, 'not-export'); return; }
    const path = text(msg.path, 4096);
    const offset = Number.isInteger(msg.offset) && msg.offset >= 0 ? msg.offset : -1;
    if (!path || offset < 0 || typeof msg.data !== 'string') { refuse(port, msg, 'bad-request'); return; }
    try {
      await ensureHost();
      const written = await native.request({ type: 'file.write', job: job.id, path, offset, data: msg.data, last: msg.last === true });
      if (msg.last === true) {
        const sofar = job.export && typeof job.export === 'object' ? job.export : {};
        await saveJob({ export: { ...sofar, files: Number(written.files) || 0, bytes: Number(written.bytes) || 0 } });
      }
      reply(port, msg, { size: Number(written.size) || 0 });
    } catch (e) {
      warn('page', 'file write failed', { path, offset, code: e && e.code, message: String(e && e.message || e) });
      refuse(port, msg, e && e.code ? e.code : 'unavailable');
    }
  };

  handlers[MSG.projectsResult] = async (port, msg) => {
    reply(port, msg, {});
    signal(`projects:${text(msg.probeId, 100)}`, {
      projects: Array.isArray(msg.projects) ? msg.projects : [],
      orgs: Array.isArray(msg.orgs) ? msg.orgs : [],
      here: msg.here && typeof msg.here === 'object' ? msg.here : null,
      error: typeof msg.error === 'string' ? msg.error : null,
    });
  };

  handlers[MSG.identityResult] = async (port, msg) => {
    reply(port, msg, {});
    const identity = msg.identity && typeof msg.identity === 'object' ? msg.identity : {};
    signal(`identity:${text(msg.probeId, 100)}`, {
      status: Number(identity.status) || 0,
      email: typeof identity.email === 'string' ? identity.email : null,
      orgs: Array.isArray(identity.orgs) ? identity.orgs.filter(o => typeof o === 'string') : null,
      finalPath: text(identity.finalPath, 2000),
      error: typeof identity.error === 'string' ? identity.error : null,
    });
  };

  handlers[MSG.scriptEvent] = async (port, msg) => {
    reply(port, msg, {});
    const kind = text(msg.kind, 20);
    if (kind === 'ready') {
      rememberObservation({ ready: true });
      signal('ready', msg);
    } else if (kind === 'status') {
      const statusText = text(msg.text, 1000);
      job.lastStatusText = statusText;
      emitStatus(statusText, text(msg.link, 500));
    } else if (kind === 'prompt') {
      const data = { promptKind: text(msg.promptKind, 20), answer: text(msg.answer, 300), sourceVisible: !!msg.sourceVisible };
      if (msg.sourceVisible) warn('page', 'the script says the original project is visible from this login', data);
      else info('page', 'question answered', data);
      // The export script asked which project (or organization) and the
      // helper found no single match for the one chosen: the script stops
      // on a null answer and says nothing, so the job ends here, with why.
      if (jobKind() === 'export' && msg.answer === null && (data.promptKind === 'project' || data.promptKind === 'org')) {
        const chosen = chosenProject();
        await failJob(data.promptKind === 'project'
          ? `The export script did not list "${chosen ? chosen.name : 'the chosen project'}" among the projects it found; open the project in the tab and start the Duplicate again.`
          : `The export script could not tell which organization "${chosen ? chosen.name : 'the chosen project'}" is in; open the project in the tab and start the Duplicate again.`);
      }
    } else if (kind === 'console') {
      const level = text(msg.level, 10);
      const line = text(msg.text, 2000);
      if (level === 'error') { lastConsoleError = line; warn('page', line); }
      else if (level === 'warn') warn('page', line);
      else debug('page', line);
    } else if (kind === 'rows') {
      lastRows = Array.isArray(msg.rows) ? msg.rows.slice(0, 5000).map(r => ({
        group: text(r && r.group, 40), item: text(r && r.item, 300), result: text(r && r.result, 40), detail: text(r && r.detail, 500),
      })) : [];
    } else if (kind === 'done') {
      const result = msg.result && typeof msg.result === 'object' ? msg.result : partialResult();
      if (Array.isArray(result.rows)) lastRows = result.rows;
      if (result.created && result.created.id && !job.created_project) {
        await saveJob({ created_project: { id: result.created.id, url: result.created.url || '', name: result.created.name || '', at: isoOf(now()) } });
      }
      job.lastStatusText = text(result.status, 1000);
      await finishJob('done', { result });
    } else if (kind === 'failed') {
      const result = msg.result && typeof msg.result === 'object' ? msg.result : null;
      if (result && Array.isArray(result.rows)) lastRows = result.rows;
      job.lastStatusText = text(msg.text, 1000);
      await finishJob('failed', { result: result || partialResult(), errorText: text(msg.text, 1000) || `The ${jobKind()} script stopped.` });
    }
  };

  // ---------------------------------------------------------- the content port

  function onContentConnect(port) {
    const sender = port.sender || {};
    const tabId = sender.tab ? sender.tab.id : null;
    const admitted = admit(port, 'content', () => (!senderOk(port, false) || tabId == null ? 'not a claude.ai tab' : null));
    admitted.then(ok => { if (ok) contentPorts.set(tabId, port); });
    port.onMessage.addListener(guarded('content message', async msg => {
      if (!(await admitted)) return;
      if (!msg || typeof msg !== 'object') return;
      if (msg.re !== undefined) { signal(`dom:${msg.re}`, stateOf(msg)); return; }
      if (msg.type !== MSG.pageState) return;
      const state = stateOf(msg);
      if (state.hints.length) debug('page', 'the page carries a Cloudflare loader; not a check', { hints: state.hints });
      lastClaudeTab = tabId;
      const known = pageStates.get(tabId) || {};
      pageStates.set(tabId, { ...known, state, at: now() });
      if (jobActive() && tabId === job.tabId) {
        await onJobPageState(state);
        // The tab was sent to a page first (see navigateFirst): its report
        // is what the job was waiting for.
        if (jobActive() && job.phase === 'claimed') runJob();
      } else if (!jobActive()) {
        pickup('page.state').catch(() => {});
      } else if (job.phase === 'claimed') {
        runJob();
      }
    }));
    port.onDisconnect.addListener(guarded('content disconnect', async () => {
      if (!(await admitted)) return;
      if (contentPorts.get(tabId) === port) contentPorts.delete(tabId);
    }));
  }

  // `hints` are the Cloudflare loader elements a normal signed-in page may
  // carry; content.js keeps them apart from the markers that mean a check
  // is showing, and nothing here acts on them.
  function stateOf(msg) {
    return {
      url: text(msg.url, 2000), title: text(msg.title, 200),
      markers: Array.isArray(msg.markers) ? msg.markers.map(m => text(m, 200)) : [],
      hints: Array.isArray(msg.hints) ? msg.hints.map(m => text(m, 200)) : [],
      hasImporter: !!msg.hasImporter, hasExporter: !!msg.hasExporter, online: msg.online !== false,
    };
  }

  async function onJobPageState(state) {
    const found = safeClassifyPage(state, job.phase);
    const kind = kindOf(found);
    if (!kind || !PAGE_KINDS.has(kind)) return;
    if (kind === 'page-reloaded' || kind === 'tab-closed') {
      // Only once the script's UI was seen: before that an absent importer
      // is just a page that has not got that far.
      if (!['ready', 'running', 'held'].includes(job.phase)) return;
      if (job.phase === 'held' && job.heldFrom === 'claimed') return;
      await handlePageGone(kind);
      return;
    }
    if (job.phase === 'held') {
      await raiseInterruption({ kind, found, evidence: state, replace: true });
      return;
    }
    await holdJob({ kind, found, evidence: state, reason: 'interrupted' });
  }

  // ---------------------------------------------------------- the panel port

  function onPanelConnect(port) {
    const sender = port.sender || {};
    const own = typeof chrome.runtime.getURL === 'function' ? chrome.runtime.getURL('sidepanel.html') : null;
    const admitted = admit(port, 'panel', () => (!own || sender.url !== own ? 'not the extension\'s own page' : null));
    port.onMessage.addListener(guarded('panel message', async msg => {
      if (!(await admitted)) return;
      if (!msg || typeof msg !== 'object' || msg.type !== MSG.cmd) return;
      const result = await command(text(msg.name, 40), msg.args && typeof msg.args === 'object' ? msg.args : {});
      try { port.postMessage({ re: msg.id, ...result }); } catch (e) { /* the panel re-renders from storage */ }
    }));
  }

  async function command(name, args) {
    if (!PANEL_COMMANDS.includes(name)) return { ok: false, error: `Unknown command: ${name || '(none)'}` };
    try {
      switch (name) {
        case 'pause':
          if (!jobActive()) return { ok: false, error: 'Nothing is running.' };
          await gate.pause();
          info('gate', 'paused by the person');
          return { ok: true };
        case 'resume':
          if (jobActive() && job.phase !== 'held') { await gate.resume(); info('gate', 'resumed by the person'); return { ok: true }; }
          return resumeJob(false);
        case 'cancel':
          return cancelJob('person');
        case 'retry':
          if (!jobActive() || job.phase !== 'held') return { ok: false, error: 'Nothing is held.' };
          await gate.retry();
          emit('released', { action: 'retry' });
          await saveJob({ phase: job.heldFrom === 'running' || !job.heldFrom ? 'running' : job.heldFrom, heldFrom: null, heldReason: null });
          emit('phase', { phase: job.phase, detail: 'retry' });
          return { ok: true };
        case 'giveUp':
          if (!jobActive() || job.phase !== 'held') return { ok: false, error: 'Nothing is held.' };
          await gate.giveUp();
          emit('released', { action: 'give-up' });
          await saveJob({ phase: job.heldFrom === 'running' || !job.heldFrom ? 'running' : job.heldFrom, heldFrom: null, heldReason: null });
          emit('phase', { phase: job.phase, detail: 'give-up' });
          return { ok: true };
        case 'identity.confirm':
          if (!jobActive()) return { ok: false, error: 'Nothing is running.' };
          await saveJob({ identityConfirmed: true });
          info('job', 'the person confirmed the signed-in account');
          return job.phase === 'held' ? resumeJob(true) : { ok: true };
        case 'job.refresh': {
          if (jobActive()) { await ensureHost().catch(() => {}); flushEvents(); return { ok: true, text: `Job ${job.id} is ${job.phase}.` }; }
          const found = await pickup('panel', true);
          return { ok: true, text: found ? `Picked up ${found.id}.` : 'No import is queued. Run `cswap project-move import --to NUM` first, or press Duplicate.' };
        }
        case 'duplicate.start':
          return startDuplicate();
        case 'duplicate.choose':
          return chooseDuplicate(args);
        case 'duplicate.choices': {
          if (!jobActive() || jobKind() !== 'export' || job.phase !== 'choosing') return { ok: false, error: 'No Duplicate is waiting for a choice.' };
          const choices = await probeProjects();
          await saveJob({ choices });
          return { ok: true, text: `${choices.projects.length} project(s) found.` };
        }
        case 'config.set': {
          const result = await config.set(args.config && typeof args.config === 'object' ? args.config : {});
          return { ok: true, problems: result && result.problems ? result.problems : [] };
        }
        case 'config.reset':
          await config.reset();
          return { ok: true };
        case 'log.clear':
          await log.clear();
          return { ok: true };
        case 'log.export':
          return { ok: true, text: log.exportText() };
        case 'notify.test':
          notify('cswap import', 'Notifications work.');
          return { ok: true };
        default:
          return { ok: false, error: `Unknown command: ${name}` };
      }
    } catch (e) {
      error('panel', `${name} failed`, { message: String(e && e.message || e) });
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  // ---------------------------------------------------------- Duplicate

  // The person pressed Duplicate: an export job is started with the bridge
  // in the claude.ai tab in front, which is reloaded so the page helper
  // starts on a fresh document, and the accounts cswap knows are fetched
  // for the panel's list. The project is chosen once the page says who is
  // signed in and what they can see (stepChoices).
  async function startDuplicate() {
    if (jobActive()) return { ok: false, error: `A job is already running (${job.id}); wait for it or cancel it first.` };
    if (startingDuplicate) return { ok: false, error: 'A Duplicate is already starting.' };
    if (!userScriptsOk) return { ok: false, error: userScriptsError };
    startingDuplicate = true;
    try {
      const tabId = await chooseTab();
      if (tabId == null) return { ok: false, error: 'Open a claude.ai tab, signed in as the account that has the project, then press Duplicate again.' };
      await ensureHost();
      const hello = native.lastHello ? native.lastHello() : null;
      const capabilities = hello && Array.isArray(hello.capabilities) ? hello.capabilities : [];
      if (!capabilities.includes(DUPLICATE_CAPABILITY)) return { ok: false, error: NO_DUPLICATE_TEXT };
      const listed = await native.request({ type: 'accounts.list' });
      const accounts = accountChoices(listed && Array.isArray(listed.accounts) ? listed.accounts : []);
      const made = await native.request({ type: 'export.new', extension_version: extensionVersion });
      if (!made || !made.job || typeof made.job.id !== 'string') throw new Error('The bridge started no export job.');
      const known = pageStates.get(tabId);
      const here = known && known.state && typeof known.state.url === 'string' && known.state.url.startsWith(CLAUDE_URL_PREFIX) ? known.state.url : CLAUDE_URL_PREFIX;
      await adoptJob(made.job, { tabId, navigateTo: here, accounts });
      return { ok: true, text: `Started ${job.id}.` };
    } catch (e) {
      if (!jobActive()) native.disconnect();
      return { ok: false, error: String(e && e.message || e) };
    } finally {
      startingDuplicate = false;
    }
  }

  // The person chose the project, the destination account and, perhaps, a
  // name for the copy. The bridge records the choice on the job; the tab
  // goes to the project's own page, where the export script finds it
  // without a question, and the job runs on from 'claimed'.
  async function chooseDuplicate(args) {
    if (!jobActive() || jobKind() !== 'export' || job.phase !== 'choosing') return { ok: false, error: 'No Duplicate is waiting for a choice.' };
    const projectId = text(args.projectId, 200);
    const choices = job.choices && Array.isArray(job.choices.projects) ? job.choices.projects : [];
    const project = choices.find(p => p && p.id === projectId);
    if (!project) return { ok: false, error: 'Choose a project from the list.' };
    const destination = text(args.destination, 200).trim();
    if (!destination) return { ok: false, error: 'Choose the account to copy the project into.' };
    const name = text(args.name, 300).trim();
    await ensureHost();
    const reply = await native.request({
      type: 'export.choose', job: job.id,
      project: { id: project.id, name: project.name, kind: project.kind, org_uuid: project.orgUuid, org_name: project.orgName },
      destination, name: name || null,
      source: { email: expectedIdentity().email, org_uuid: project.orgUuid },
    });
    const recorded = reply && reply.job ? reply.job : {};
    await saveJob({
      duplicate: recorded.duplicate || null, export: recorded.export || job.export, account: recorded.account || job.account,
      phase: 'claimed', navigateTo: projectUrl(project), navigatedAt: null, nonce: null, injectedAt: null,
    });
    info('job', 'project chosen', { project: project.id, kind: project.kind, destination });
    runJob();
    return { ok: true };
  }

  // ---------------------------------------------------------- the gate's changes

  onGateChange = (snapshot, change) => {
    try {
      if (!change || !jobActive()) return;
      if (change.type === 'wait') {
        const seconds = change.until ? Math.max(0, Math.round((change.until - now()) / 1000)) : 0;
        emit('wait', { state: change.state, reason: change.reason, until: isoOf(change.until), seconds });
        if (change.state === 'start' && change.reason === 'retry-after' && seconds >= 30) {
          notify('cswap import is waiting', `The site asked to slow down: waiting ${seconds} s before the next request.`);
        }
      } else if (change.type === 'phase' || change.type === 'grant' || change.type === 'report') {
        debug('gate', change.type, { phase: snapshot ? snapshot.phase : '' });
      }
    } catch (e) { /* nothing */ }
  };

  // ---------------------------------------------------------- start-up

  async function configureWorld() {
    if (!chrome.userScripts || typeof chrome.userScripts.configureWorld !== 'function' || typeof chrome.userScripts.execute !== 'function') {
      userScriptsOk = false;
      userScriptsError = 'chrome.userScripts is not available: turn on "Allow User Scripts" on the extension\'s card (Chrome 138+), or Developer mode.';
    } else {
      try {
        await chrome.userScripts.configureWorld({ messaging: true });
        userScriptsOk = true;
        userScriptsError = '';
      } catch (e) {
        userScriptsOk = false;
        userScriptsError = `chrome.userScripts refused: ${String(e && e.message || e)}`;
      }
    }
    await noteBridge({ userScripts: userScriptsOk, userScriptsError, extensionVersion, chromeVersion });
  }

  async function ensureInstance() {
    const stored = await sget(KEYS.instance);
    if (stored && typeof stored.id === 'string' && stored.id) { instance = stored; return instance; }
    instance = { id: uuid(), createdAt: now() };
    await sset(KEYS.instance, instance);
    return instance;
  }

  // After a restart, and from the poll alarm, nothing has told this worker
  // whether the import tab is still there: no port disconnect was seen,
  // and a closed or discarded tab sends no report. The tab is looked up,
  // then the page helper gets PAGE_GONE_MS to reconnect before the tab
  // counts as closed. True when the page is there (or nothing to check).
  async function checkPageAlive(why) {
    if (!jobActive() || pagePort || job.tabId == null) return true;
    if (!['ready', 'running', 'held'].includes(job.phase)) return true;
    if (job.phase === 'held' && job.heldFrom === 'claimed') return true;
    if (!(await tabExists(job.tabId))) {
      info('page', 'the job\'s tab is gone', { why, tabId: job.tabId });
      await handlePageGone('tab-closed');
      return false;
    }
    try {
      await waitFor('page-back', PAGE_GONE_MS);
      return true;
    } catch (e) {
      if (/^superseded/.test(String(e && e.message)) || !jobActive() || pagePort) return true;
      info('page', 'the page helper did not reconnect', { why, tabId: job.tabId });
      await handlePageGone('tab-closed');
      return false;
    }
  }

  async function tabExists(tabId) {
    if (!chrome.tabs || typeof chrome.tabs.get !== 'function') return true; // nothing to ask: the page's silence decides
    try {
      const tab = await chrome.tabs.get(tabId);
      return !!tab && !tab.discarded;
    } catch (e) {
      return false;
    }
  }

  async function resumeAfterRestart() {
    info('job', 'worker restarted with an active job', { phase: job.phase });
    armAlarm();
    ensureHost().catch(e => debug('native', 'host not reachable yet', { code: e && e.code }));
    if (job.phase === 'claimed') { runJob(); return; }
    // A Duplicate waiting for its choice needs the page helper back for the
    // choose that follows; a tab that went away in the meantime starts
    // the job again from the beginning, as every other phase does.
    if (job.phase === 'choosing') {
      try { await waitFor('attach', ATTACH_TIMEOUT_MS); } catch (e) { if (jobActive() && !pagePort) await rerunFromClaimed(); }
      return;
    }
    if (['preflight', 'loading', 'ready'].includes(job.phase)) {
      try {
        await waitFor('attach', ATTACH_TIMEOUT_MS);
        runJob();
      } catch (e) {
        if (jobActive() && !pagePort) await rerunFromClaimed();
      }
      return;
    }
    // running and held: the page re-sends what was unanswered when it
    // reconnects; when it does not, the tab is gone.
    await checkPageAlive('restart');
  }

  // Everything Chrome may call this worker for, registered the moment the
  // module is evaluated (see `ready`): the event that woke the worker is
  // delivered only to listeners that exist by then, and Chrome counts only
  // those as reasons to wake it again.
  function registerListeners() {
    const r = chrome.runtime;
    if (r.onInstalled && r.onInstalled.addListener) {
      r.onInstalled.addListener(guarded('onInstalled', async () => {
        // Before the first await: the toolbar button opens the panel even
        // when nothing else of this worker comes up.
        if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
          try { Promise.resolve(chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })).catch(() => {}); } catch (e) { /* nothing */ }
        }
        await ready;
        await configureWorld();
      }));
    }
    if (r.onStartup && r.onStartup.addListener) r.onStartup.addListener(guarded('onStartup', async () => { await ready; await pickup('startup', true); }));
    if (r.onUserScriptConnect && r.onUserScriptConnect.addListener) r.onUserScriptConnect.addListener(guarded('onUserScriptConnect', onPageConnect));
    if (r.onConnect && r.onConnect.addListener) {
      r.onConnect.addListener(guarded('onConnect', port => {
        if (!port) return;
        if (port.name === PORTS.content) onContentConnect(port);
        else if (port.name === PORTS.panel) onPanelConnect(port);
        else if (port.name === PORTS.page) onPageConnect(port); // a build that routes user-script ports here
        else { try { port.disconnect(); } catch (e) { /* nothing */ } }
      }));
    }
    if (chrome.alarms && chrome.alarms.onAlarm && chrome.alarms.onAlarm.addListener) {
      chrome.alarms.onAlarm.addListener(guarded('onAlarm', async alarm => {
        if (!alarm) return;
        await ready;
        if (alarm.name === ALARM_WAKE) { if (typeof gate.reevaluate === 'function') await gate.reevaluate(); return; }
        if (alarm.name !== ALARM_POLL) return;
        if (jobActive()) {
          await ensureHost().catch(() => {});
          flushEvents();
          if (job.phase === 'claimed') runJob();
          else await checkPageAlive('poll');
        } else {
          clearAlarm();
          await pickup('alarm');
        }
      }));
    }
    if (chrome.tabs && chrome.tabs.onRemoved && chrome.tabs.onRemoved.addListener) {
      chrome.tabs.onRemoved.addListener(guarded('onRemoved', async tabId => {
        await ready;
        contentPorts.delete(tabId);
        pageStates.delete(tabId);
        if (jobActive() && tabId === job.tabId && job.phase !== 'claimed') await handlePageGone('tab-closed');
      }));
    }
  }

  async function start() {
    if (started) return;
    started = true;
    try {
      try { if (typeof config.load === 'function') await config.load(); } catch (e) { /* defaults */ }
      try { if (typeof log.load === 'function') await log.load(); } catch (e) { /* empty log */ }
      try { if (typeof gate.load === 'function') await gate.load(); } catch (e) { warn('gate', 'could not restore the gate', { message: String(e && e.message || e) }); }
      try { if (typeof interrupts.load === 'function') await interrupts.load(); } catch (e) { /* nothing */ }
      await ensureInstance();
      await configureWorld();
      const stored = await sget(KEYS.job);
      if (validJob(stored)) job = stored;
      else if (stored !== undefined) { warn('job', 'discarded an unreadable job record'); await storage.remove(KEYS.job); }
    } finally {
      // The listeners wait on this whatever happened above: a worker that
      // cannot read its storage still answers, rather than hanging.
      resolveReady();
    }
    // Not awaited: picking the job up again can wait on the page for a
    // while, and start() should return once the storage is read.
    if (jobActive()) resumeAfterRestart().catch(e => error('error', 'resume after restart failed', { message: String(e && e.message || e) }));
  }

  function stop() {
    stopped = true;
    for (const [key, entry] of [...waiters]) { waiters.delete(key); if (entry.timer) unschedule(entry.timer); entry.reject(new Error('worker stopped')); }
    if (pageGoneTimer) { unschedule(pageGoneTimer); pageGoneTimer = null; }
    if (statusTimer) { unschedule(statusTimer); statusTimer = null; }
    native.disconnect();
  }

  registerListeners();

  return {
    start,
    stop,
    handle: handlePageMessage,
    command,
    pickup,
    state: () => ({
      job: job ? { ...job } : null, instance, userScriptsOk, userScriptsError, pageAttached: !!pagePort, pageNonce,
      eventQueue: eventQueue.length, contentTabs: [...contentPorts.keys()], lastRows: lastRows.length,
    }),
    modules: { gate, interrupts, config, log, native },
  };
}

// Production wiring.
if (typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.id && chrome.storage) {
  createBackground({ chrome }).start().catch(e => {
    // Nothing else can log this: the logger itself may not have come up.
    console.error('cswap background failed to start', e);
  });
}
