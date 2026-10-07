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
// into the one .tar the person named in the computer's own Save As
// window) and then, when the person has signed in as the other account in
// the same tab, pressed Import and opened an export in the computer's own
// Open window, the import job the command line would have queued, into
// whichever account that is. The export job has two phases of its own:
// 'choosing', in which the page lists the projects the signed-in account
// can see so that the one the tab shows is named the way the site names
// it, and 'placing', in which the Save As window the bridge opened is
// followed until it says where the export goes. An import in a window of
// its own, which an earlier version started from here, is only followed:
// this worker keeps what the bridge says of it.
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
import { createConfigStore, gateConfig } from './config.js';
import { createLogger, redact } from './log.js';
import {
  projectUrl, projectChoices, bootProject, chainTexts, withHostRecord, needsHostRecord,
  helloCan, importWay, drivenRecord, carryOnOnlyText, DUPLICATE_CAPABILITY, NO_DUPLICATE_TEXT, DRIVEN_CAPABILITY, NO_DRIVEN_TEXT,
  DRIVEN_RUNNING_TEXT, DEFAULT_IMPORT_WAY, listingSummary, DROP_CAPABILITY, NO_DROP_TEXT, DROP_HINT_TEXT,
  NOT_ON_A_PROJECT_TEXT, EXPORTED_NEXT_TEXT, isProjectUrl, samePath,
  DIALOGS_CAPABILITY, NO_DIALOGS_TEXT, DIALOG_POLL_MS, dialogState, SAVE_WINDOW_OPEN_TEXT, OPEN_WINDOW_OPEN_TEXT,
  SAVE_CANCELLED_TEXT, OPEN_CANCELLED_TEXT, SAVE_LOST_TEXT, OPEN_LOST_TEXT,
} from './duplicate.js';

export const ATTACH_TIMEOUT_MS = 20000;
export const READY_TIMEOUT_MS = 90000;
export const PROBE_TIMEOUT_MS = 90000;
export const DOM_PROBE_TIMEOUT_MS = 5000;
export const PICKUP_MIN_GAP_MS = 30000;
export const STATUS_EVENT_GAP_MS = 1000;
export const MAX_RERUNS = 3;
export const EVENT_QUEUE_MAX = 200;
// The host refuses an event for a job it no longer holds for this browser
// (the next job took its place, as the import does after a Duplicate's
// export): it would refuse it every time, so the event is dropped rather
// than left to block the ones behind it. Any other failure (the host busy
// or failing, a dropped port, no answer) keeps the event for the next
// flush, as before.
export const FINAL_REFUSALS = Object.freeze(['not-claimed']);
// A full queue never drops a job's end.
const ENDING_EVENTS = new Set(['done', 'failed', 'cancelled']);
export const ALARM_WAKE_MIN_MS = 25000;
// A notification's text is cut here: enough for why a Duplicate's import
// did not start and the lines that start it by hand.
export const NOTIFY_MAX = 600;
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
export const STILL_HELD_TEXT = 'A failed step is still held: press Resume to send it again, or Skip this step.';

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
    // Read on every evaluation, so the job's kind is the current one: the
    // export half of a Duplicate goes at the read spacing throughout, and
    // the import that follows spaces its writes.
    config: () => gateConfig(config.get(), jobKind()),
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
  let flushing = false;           // a run of sendQueued() is under way
  let flushIdle = [];             // callers that came during a run, told when it ends
  let delivered = 0;              // events the host acknowledged, ever
  const receipts = new Map();     // queued event -> resolvers waiting for its ack
  const acked = new WeakSet();    // events the host acknowledged
  let lastFlushError = '';        // why the last run stopped short, said to the person
  let handingOver = null;         // the export job whose import is being queued ('file' for one opened in the Open window)
  let dialogOpen = null;          // the file window open for a press of the panel's ({ id, purpose }), while it is
  let dialogWake = null;          // ends followDialog's wait early: the job it waited for ended meanwhile
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

  // Why a press cannot start anything now, or null. The three buttons are
  // always in place, so a press at the wrong moment is answered with this.
  function busyText() {
    if (dialogOpen || (jobActive() && job.phase === 'placing')) {
      return (dialogOpen ? dialogOpen.purpose : 'save') === 'save' ? SAVE_WINDOW_OPEN_TEXT : OPEN_WINDOW_OPEN_TEXT;
    }
    if (jobActive()) return `A job is already running (${job.id}); wait for it or cancel it first.`;
    if (drivenRunning()) return DRIVEN_RUNNING_TEXT;
    return null;
  }

  // Which script the job runs: 'import' (queued from the command line, or
  // the second half of a Duplicate) or 'export' (the first half).
  function jobKind() {
    return job && job.kind === 'export' ? 'export' : 'import';
  }

  // A finished export whose import runs in a window of its own, as the
  // bridge last said: the worker is not idle while it does (the port stays
  // open for the panel's questions, and no new job starts).
  function drivenRunning() {
    return !!job && !jobActive() && job.kind === 'export' && !!job.driven && typeof job.driven === 'object' && job.driven.running === true;
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
      const made = chrome.notifications.create({ type: 'basic', iconUrl: 'icons/128.png', title: String(title), message: String(message).slice(0, NOTIFY_MAX) });
      if (made && typeof made.catch === 'function') made.catch(() => {});
    } catch (e) { /* a notification is a courtesy */ }
  }

  function pagePost(msg) {
    if (!pagePort) return false;
    try { pagePort.postMessage(msg); return true; } catch (e) { return false; }
  }

  // What the page's signed-in account is compared with: the job's account.
  // An import queued for whoever is signed in names none until the page
  // does (`signedIn`); noteSignedInAccount() records the one it finds.
  function expectedIdentity() {
    const account = (job && job.account) || {};
    const expected = { email: text(account.email, 200), orgUuid: text(account.org_uuid, 100), flow: jobKind() };
    if (account.signed_in === true) expected.signedIn = true;
    return expected;
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

  // The queued event, so a caller can wait for the host's answer to it.
  function emit(type, body) {
    const event = { event: type, job: job ? job.id : undefined, ...body };
    if (type !== 'log') info('job', type, body);
    eventQueue.push(event);
    trimQueue();
    flushEvents();
    return event;
  }

  function forwardLog(record) {
    if (!record || (record.level !== 'warn' && record.level !== 'error')) return;
    if (record.event === 'native') return; // the bridge does not need to hear about itself
    // Stamped now: a line belongs to the job it was written under, even
    // when it reaches the host after the next job took that one's place.
    eventQueue.push({ event: 'log', job: job ? job.id : undefined, level: record.level, msg: record.msg, data: record.data || {} });
    trimQueue();
    flushEvents();
  }

  function settleReceipt(event, ok) {
    if (ok) acked.add(event);
    const list = receipts.get(event);
    if (!list) return;
    receipts.delete(event);
    for (const resolve of list) resolve(ok);
  }

  function dropQueued(at) {
    const [gone] = eventQueue.splice(at, 1);
    if (gone) settleReceipt(gone, false);
  }

  // Over the cap: status lines go first (the next one says more anyway),
  // then log lines, then anything but a job's end. The event on its way to
  // the host is never dropped: the run takes it out by identity once the
  // host acknowledged it.
  function trimQueue() {
    const from = flushing ? 1 : 0;
    while (eventQueue.length > EVENT_QUEUE_MAX) {
      const pick = wanted => eventQueue.findIndex((e, i) => i >= from && wanted(e));
      let at = pick(e => e.event === 'status');
      if (at < 0) at = pick(e => e.event === 'log');
      if (at < 0) at = pick(e => !ENDING_EVENTS.has(e.event));
      if (at < 0) return;
      dropQueued(at);
    }
  }

  // True once the host acknowledged `event`; false once it left the queue
  // without an acknowledgement, or a run ended with it still queued (the
  // bridge went away, refused it for now, or did not answer). Only an
  // acknowledgement and the end of a run settle it: there is no timer.
  function whenAcked(event) {
    if (!event) return Promise.resolve(false);
    if (acked.has(event)) return Promise.resolve(true);
    if (!eventQueue.includes(event)) return Promise.resolve(false);
    const answer = new Promise(resolve => {
      const list = receipts.get(event) || [];
      list.push(resolve);
      receipts.set(event, list);
    });
    flushEvents();
    return answer;
  }

  // One run at a time. A caller that comes while one is under way waits
  // for it to end instead of returning at once beside it: returning at once
  // is what made a finished export look unheard, since the hand-off then
  // looked at the queue while the first run still waited for the host. The
  // answer is true when the run stopped short with events still queued (a
  // failure, or a cancel the host asked for), false when it emptied the
  // queue or the port was down.
  function flushEvents() {
    if (flushing) return new Promise(resolve => flushIdle.push(resolve));
    return sendQueued();
  }

  async function sendQueued() {
    flushing = true;
    lastFlushError = '';
    let short = false;
    try {
      while (eventQueue.length && native.isConnected()) {
        const event = eventQueue[0];
        let ack;
        try {
          ack = await native.event({ job: job ? job.id : undefined, ...event });
        } catch (e) {
          const code = e && e.code;
          lastFlushError = String(e && e.message || e);
          if (FINAL_REFUSALS.includes(code)) {
            warn('native', 'the bridge refused an event; dropped', { event: event.event, job: event.job, code });
            const at = eventQueue.indexOf(event);
            if (at >= 0) dropQueued(at);
            continue;
          }
          debug('native', 'event not delivered, kept', { event: event.event, code });
          short = native.isConnected();
          break;
        }
        lastFlushError = '';
        const at = eventQueue.indexOf(event);
        if (at >= 0) eventQueue.splice(at, 1);
        delivered++;
        settleReceipt(event, true);
        if (ack && ack.cancel_requested && jobActive()) {
          info('job', 'cancel requested from the command line');
          cancelJob('cli').catch(e => error('error', 'cancel failed', { message: String(e && e.message || e) }));
          short = eventQueue.length > 0;
          break;
        }
      }
    } finally {
      // Cleared here, in the same step as the loop's last look at the
      // queue: an event queued from now on starts a run of its own.
      flushing = false;
      if (eventQueue.length && !native.isConnected() && !lastFlushError) lastFlushError = 'the cswap bridge is not connected';
      // What this run left queued was not delivered by it: whoever waits
      // for one of those hears so now.
      for (const event of [...receipts.keys()]) if (eventQueue.includes(event)) settleReceipt(event, false);
      const waiting = flushIdle;
      flushIdle = [];
      for (const resolve of waiting) resolve(short);
    }
    return short;
  }

  // Every queued event acknowledged by the host, or the reason it cannot
  // be: the port is down, or a delivery failed (the event stays queued for
  // a later flush, and nothing is sent twice here). A run already under
  // way is waited for first. With a host that stalls this waits for the
  // native client's own answer timeout (30 s) per event, and no longer.
  async function drainEvents() {
    for (;;) {
      const stoppedShort = await flushEvents();
      if (stoppedShort || !eventQueue.length || !native.isConnected()) return;
    }
  }

  function emitStatus(statusText, link) {
    // After the job's end nothing more is said about it: the host would
    // file a status line behind the end.
    if (!jobActive() || statusText === statusSent) return;
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
        if (!jobActive()) return;
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

  // A status the one-a-second rhythm held back goes out before the job's
  // end, never after it.
  function sendHeldStatus() {
    if (statusTimer) { unschedule(statusTimer); statusTimer = null; }
    const p = statusPending;
    statusPending = null;
    if (p && p.text !== statusSent) {
      statusSent = p.text;
      statusSentAt = now();
      emit('status', p);
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
    // A finished export handing over to its import is not idle: its import
    // is about to be the job, and the port is in use for it.
    if (jobActive() || handingOver) return null;
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
        // A job or a hand-off that began while the host answered (a
        // Duplicate started, Import) is the one that takes
        // the job up: this pickup adopts nothing beside it.
        if (jobActive() || handingOver) return null;
        found = reply && reply.job ? reply.job : null;
        if (!found || !ACTIVE_HOST_STATUSES.has(found.status)) {
          debug('job', 'no job queued', { reason });
          await forgetJobElsewhere();
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
        await forgetJobElsewhere();
        const claimed = await native.request({ type: 'job.claim', job: found.id, instance: instance.id, extension_version: extensionVersion });
        if (jobActive() || handingOver) return null;
        return await adoptJob(claimed.job);
      } catch (e) {
        warn('job', 'pickup failed', { reason, code: e && e.code, message: String(e && e.message || e) });
        return null;
      } finally {
        if (!jobActive() && !handingOver && !drivenRunning() && !dialogOpen) native.disconnect();
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
      navigateTo: null, navigatedAt: null, choices: null, chainError: null, dialog: null,
      importWay: null, driven: null, drivenNotified: false, ...extra };
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

  // The Connection section's line about a job another browser profile
  // holds is taken down once the host holds no such job (it ended, or was
  // dropped from the command line), without a write when there is none.
  async function forgetJobElsewhere() {
    let stored = null;
    try { stored = await sget(KEYS.bridge); } catch (e) { return; }
    if (stored && stored.jobElsewhere) await noteBridge({ jobElsewhere: null });
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
        if (job.phase === 'placing') { if (!(await stepPlace())) break; continue; }
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
    await noteSignedInAccount(identity);
    await saveJob({ phase: 'loading' });
    emit('phase', { phase: 'loading', detail: '' });
    return true;
  }

  // A Duplicate before its project is chosen: whoever is signed in is the
  // account the project is copied from, so there is nothing to compare
  // the identity with, only a signed-out page to stop on. The project is
  // the one the tab shows, which the person opened on purpose: the
  // projects the account can see are listed, so that it is named the way
  // the site names it, and it is chosen without a question. The copy goes
  // into whichever account the person signs in as once the export is
  // done, so no account is chosen here. True once chosen: the job goes
  // on from 'claimed' on the project's own page. A tab that shows no
  // project ends the job with what to open.
  async function stepChoices(identity) {
    const bad = safeClassifyIdentity(identity);
    if (bad && bad.kind !== 'identity-unknown') {
      await holdJob({ kind: bad.kind, found: bad, evidence: { ...identity, expected: '' }, actual: identity.email, reason: 'interrupted' });
      return false;
    }
    const email = typeof identity.email === 'string' ? identity.email.trim() : '';
    await saveJob({ account: { slot: '', email, org_uuid: '' }, identityConfirmed: !email });
    const choices = await probeProjects();
    // A listing request the site interrupted held the job already (its
    // report went through gate.report): the hold stays until the person
    // acts, and Resume lists the projects again.
    if (!jobActive() || job.phase === 'held') return false;
    await saveJob({ choices, phase: 'choosing' });
    noteListing(choices);
    const here = choices.here && typeof choices.here.id === 'string' ? choices.projects.find(p => p.id === choices.here.id) : null;
    if (!here) { await failJob(NOT_ON_A_PROJECT_TEXT); return false; }
    const chosen = await chooseDuplicate({ projectId: here.id, name: '' }, { drive: false });
    if (!chosen.ok) { await failJob(chosen.error || 'the project could not be chosen'); return false; }
    return jobActive() && job.phase === 'placing';
  }

  // Where the export goes: the computer's own Save As window, which the
  // bridge opens with `<project>.tar` suggested in the folder the last one
  // used, and this worker follows (dialog.state every DIALOG_POLL_MS)
  // until it ends. A choice places the export (the bridge put the .tar on
  // its job; the worker keeps the path for its lines) and the job goes on
  // from 'claimed' on the project's page; the window closed without one
  // ends the job cancelled, since nothing was written; a window that
  // failed ends it failed with the bridge's words. The window's id is on
  // the job, so a worker restarted meanwhile follows the same window.
  async function stepPlace() {
    await ensureHost();
    if (!helloCan(native.lastHello ? native.lastHello() : null, DIALOGS_CAPABILITY)) { await failJob(NO_DIALOGS_TEXT); return false; }
    let dialog = job.dialog && typeof job.dialog === 'object' && text(job.dialog.id, 40) ? { id: text(job.dialog.id, 40), purpose: 'save' } : null;
    if (!dialog) {
      const opened = dialogState(await native.request({ type: 'dialog.open', purpose: 'save', job: job.id }));
      if (!opened.id) throw new Error('The bridge opened no Save As window.');
      dialog = { id: opened.id, purpose: 'save' };
      await saveJob({ dialog });
      emit('phase', { phase: 'placing', detail: '' });
      info('job', 'the Save As window is open', { dialog: dialog.id });
    }
    const placing = job;
    dialogOpen = dialog;
    let ended;
    try {
      ended = await followDialog(dialog.id, () => job === placing && jobActive() && job.phase === 'placing');
    } finally {
      dialogOpen = null;
    }
    if (!ended) return false;
    if (ended.chosen) {
      await saveJob({ export: { ...(job.export || {}), path: ended.path, archive: true }, dialog: null, phase: 'claimed' });
      info('job', 'the export is placed', { path: ended.path });
      return true;
    }
    await saveJob({ dialog: null });
    if (ended.cancelled) { await finishJob('cancelled', { errorText: SAVE_CANCELLED_TEXT }); return false; }
    await failJob(ended.error || SAVE_LOST_TEXT);
    return false;
  }

  // Asks the bridge how the file window stands until it has ended, or
  // `wanted` says the answer is no longer needed (the job ended meanwhile):
  // then null. Every wait is a timer of the worker's, which a job's end
  // cuts short (dialogWake); the host is asked again on each, so a port
  // that dropped is opened again.
  async function followDialog(dialogId, wanted) {
    for (;;) {
      if (!wanted()) return null;
      await ensureHost();
      const state = dialogState(await native.request({ type: 'dialog.state', dialog: dialogId }));
      if (!state.open) return state;
      await new Promise(resolve => { dialogWake = resolve; schedule(resolve, DIALOG_POLL_MS); });
      dialogWake = null;
    }
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

  // What the log keeps of a listing, so a project that is missing from
  // the panel can be traced: the counts by kind and how the Claude Code
  // list went, and what could not be listed.
  function noteListing(choices) {
    const summary = listingSummary(choices);
    if (summary.error) warn('job', 'the projects could not all be listed', summary);
    else info('job', 'the projects were listed', summary);
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

  // An import queued for whoever is signed in takes the account the page
  // named as its own from here on: the panel and the log name it, the
  // bridge records it (the `account` event), and every later check
  // compares with it, since the copy is made there. Nothing is recorded
  // when the page named none (the person confirmed instead).
  async function noteSignedInAccount(identity) {
    const account = job && job.account && typeof job.account === 'object' ? job.account : null;
    if (!account || account.signed_in !== true || text(account.email, 200)) return;
    const email = identity && typeof identity.email === 'string' ? identity.email.trim().slice(0, 200) : '';
    if (!email) return;
    await saveJob({ account: { ...account, email } });
    emit('account', { email });
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
      await noteSignedInAccount(identity);
    }
    if (typeof interrupts.current === 'function' && interrupts.current()) await interrupts.clear('person');
    const answer = await gate.resume();
    const stillHeld = heldReasonAfter(answer);
    if (stillHeld) {
      // The gate holds a failed step, which only Resume (the retry) or Skip this step decide:
      // the job stays held (the interruption, if there was one, is cleared).
      info('gate', 'resume left a held step for Resume or Skip this step', { reason: stillHeld });
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
    // One waiting for its Save As window needs no page: once the window
    // says where the export goes, the job goes to the project's page anew.
    if (job.phase === 'placing') return;
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

  // A finished export is not handed over to its import on its own: the
  // person signs out, signs in as the other account in the same tab and
  // presses Import, which queues it (retryHandOver). `chaining` stays for
  // the shape of what follows, and is never true.
  async function finishJob(outcome, { result = null, errorText = '' } = {}) {
    if (!job || isTerminal(job.phase) || stopped) return;
    const flow = jobKind();
    const chaining = false;
    // From here until its import is queued (or could not be), a finished
    // export is not an idle worker: nothing else may take the job's place
    // or close the port (see pickup and startDuplicate).
    if (chaining) handingOver = job.id;
    try {
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
      sendHeldStatus();
      const ended = outcome === 'done' ? emit('done', { result: final })
        : outcome === 'failed' ? emit('failed', { error: errorText, result: final })
          : emit('cancelled', { result: final });
      const last = emit('phase', { phase: outcome, detail: errorText || '' });
      if (!chaining) {
        const exported = outcome === 'done' && flow === 'export';
        notify(outcome === 'done' ? `cswap ${flow} finished` : outcome === 'failed' ? `cswap ${flow} failed` : `cswap ${flow} cancelled`,
          exported ? EXPORTED_NEXT_TEXT : outcome === 'done' ? (final && final.status) || 'Done.' : errorText || 'Stopped.');
      }
      clearAlarm();
      for (const [key, entry] of [...waiters]) { waiters.delete(key); if (entry.timer) unschedule(entry.timer); entry.reject(new Error(`job ended: ${outcome}`)); }
      // A Save As window still open for this job is closed: nothing will
      // read its answer now, and the wait for it ends.
      if (dialogWake) dialogWake();
      if (job.dialog && typeof job.dialog === 'object' && text(job.dialog.id, 40)) {
        const dialogId = text(job.dialog.id, 40);
        await saveJob({ dialog: null });
        try { await ensureHost(); await native.request({ type: 'dialog.close', dialog: dialogId }); } catch (e) { debug('native', 'the Save As window was not closed', { message: String(e && e.message || e) }); }
      }
      if (chaining) {
        if (job.importWay === 'driven') await startDrivenImport(job, { done: ended, last });
        else await chainImport(job, { done: ended, last });
        return;
      }
      // The host hears the last events, then the connection may close.
      // This waits for the host's answers: with a host that stalls, up to
      // the native client's 30 s per event (a Cancel waits as long).
      await drainEvents();
      if (!eventQueue.length && !handingOver && !drivenRunning() && !dialogOpen) native.disconnect();
    } finally {
      if (chaining) handingOver = null;
    }
  }

  // The bridge heard the export's end: `done` acknowledged, then the phase
  // line after it (the queue goes in order, so its answer follows). One
  // reconnect when the run stopped with the end still queued; there is no
  // timer anywhere, only the host's answers and the end of a run.
  async function heardTheEnd({ done, last }) {
    if (!(await whenAcked(done))) {
      try { await ensureHost(); } catch (e) { return false; }
      if (!(await whenAcked(done))) return false;
    }
    await whenAcked(last); // its fate does not matter to the bridge
    return true;
  }

  // The worker's record of the export lacks what only the bridge knows (an
  // older bridge names no folder on file.write, and a project offered by
  // its id alone is named from its export.json when the export is done):
  // the bridge's record of the same job fills it in. Never throws.
  async function learnFromHost(exported, hostJob = null) {
    if (job !== exported || !needsHostRecord(exported)) return;
    let host = hostJob;
    try {
      if (!host) {
        const reply = await native.request({ type: 'job.get' });
        host = reply && reply.job;
      }
    } catch (e) { return; /* the line goes without what is missing */ }
    if (job !== exported || !host || host.id !== exported.id) return;
    try { await saveJob(withHostRecord(exported, host)); } catch (e) { /* nothing */ }
  }

  // The second half of a Duplicate: the bridge queues the import of the
  // export just finished, into whichever account is signed in, and this
  // worker takes it up in the same tab, which goes to claude.ai first so the import
  // script starts on a fresh page. It is asked only once the bridge has
  // acknowledged the export's end (`ending`, from finishJob), or, when the
  // person tries again, once every queued event was offered to it. When
  // the import cannot be queued (the export is not whole, another job got
  // in first, the bridge is gone) the export stays on disk, the panel says
  // why and shows the line that imports it; nothing is tried again on its
  // own: Import in the panel is the person's act.
  // `exported` is the finished export, as the caller checked it: the hand-off
  // acts for it alone, and stops when another job took its place meanwhile.
  async function chainImport(exported, ending = null, chosen = null) {
    try {
      await ensureHost();
      if (ending) {
        if (!(await heardTheEnd(ending))) {
          throw new Error(`the bridge did not confirm that the export finished${lastFlushError ? ` (${lastFlushError})` : ''}`);
        }
      } else {
        await drainEvents();
      }
      await learnFromHost(exported);
      if (job !== exported) return supersededHandOver(exported);
      // No account is named: the bridge queues the import for whoever is
      // signed in, and the page's own check names the account
      // (noteSignedInAccount), which the bridge then records.
      const ask = { type: 'import.queue', job: exported.id, signed_in: true };
      if (chosen && typeof chosen.name === 'string') ask.name = chosen.name;
      const queued = await native.request(ask);
      if (!queued || !queued.job || typeof queued.job.id !== 'string') throw new Error('the bridge queued no import');
      const claimed = await native.request({ type: 'job.claim', job: queued.job.id, instance: instance.id, extension_version: extensionVersion });
      if (job !== exported) return supersededHandOver(exported);
      info('job', 'the export is done; its import is queued', { from: exported.id, job: claimed.job.id });
      notify('cswap duplicate: export finished', chainTexts({ ...exported, ...withHostRecord(exported, queued.job) }).importing);
      await adoptJob(claimed.job, { tabId: exported.tabId, navigateTo: CLAUDE_URL_PREFIX });
      return { ok: true, text: `The import ${claimed.job.id} is queued.` };
    } catch (e) {
      const message = String(e && e.message || e);
      warn('job', 'the import of the duplicate could not start', { message, from: exported.id });
      if (job === exported) {
        await learnFromHost(exported);
        await saveJob({ chainError: message });
      }
      notify('cswap duplicate stopped', `The import could not start: ${message.replace(/\.$/, '')}. ${chainTexts(exported).notImported}`);
      if (!eventQueue.length && !jobActive() && !drivenRunning()) native.disconnect();
      return { ok: false, error: message };
    }
  }

  // The second half of a Duplicate in a window of its own. Once the bridge
  // has heard the export's end, it is asked, with the job id and nothing
  // else, to start cswap's own `project-move auto --export` for it; the
  // bridge builds that command from its job record and starts it detached
  // (on Windows in a console window of its own), and it opens a browser
  // window of its own for the account chosen. This worker drives nothing
  // there: it keeps what the bridge says of the run, keeps the port open
  // while it runs, and the panel follows it. When it cannot start, the
  // export stays on disk and the panel says why, as for the import in this
  // tab. `exported` is as for chainImport.
  async function startDrivenImport(exported, ending = null) {
    try {
      await ensureHost();
      if (ending) {
        if (!(await heardTheEnd(ending))) {
          throw new Error(`the bridge did not confirm that the export finished${lastFlushError ? ` (${lastFlushError})` : ''}`);
        }
      } else {
        await drainEvents();
      }
      if (!helloCan(native.lastHello ? native.lastHello() : null, DRIVEN_CAPABILITY)) throw new Error(NO_DRIVEN_TEXT);
      await learnFromHost(exported);
      if (job !== exported) return supersededHandOver(exported);
      const reply = await native.request({ type: 'import.driven', job: exported.id });
      if (!reply || !reply.driven || !Number.isInteger(reply.driven.pid)) throw new Error('the bridge started no import');
      const driven = drivenRecord(redactValue(reply.driven));
      if (job === exported) await saveJob({ driven, drivenNotified: false, chainError: null });
      info('job', 'the import of the duplicate runs in its own window', { from: exported.id, pid: driven.pid, attempt: driven.attempt });
      notify('cswap duplicate: export finished', chainTexts(exported).drivenStarted);
      armAlarm();
      return { ok: true, text: `The import runs in its own window (process ${driven.pid}).` };
    } catch (e) {
      const message = String(e && e.message || e);
      warn('job', 'the import of the duplicate could not start', { message, from: exported.id, way: 'driven' });
      if (job === exported) {
        await learnFromHost(exported);
        await saveJob({ chainError: message });
      }
      notify('cswap duplicate stopped', `The import could not start: ${message.replace(/\.$/, '')}. ${chainTexts(exported).notImported}`);
      if (!eventQueue.length && !jobActive() && !drivenRunning()) native.disconnect();
      return { ok: false, error: message };
    }
  }

  // A hand-off whose export is no longer the job (another job took its
  // place while the bridge answered): nothing more is started for it, and
  // nothing is said of it as a failure.
  function supersededHandOver(exported) {
    info('job', 'another job took the finished export\'s place; its hand-off stops', { from: exported.id, job: job ? job.id : null });
    return { ok: false, error: 'Another job took the place of this export; nothing more was started for it.' };
  }

  // How the import in its own window stands, from the bridge: asked by the
  // open panel every few seconds and by the poll alarm, while it runs. Its
  // end is said once, in a notification. A bridge that no longer holds the
  // job, or a cswap that cannot answer for such an import at all (one put
  // back to an older version), cannot say, and the run counts as lost: the
  // record would otherwise keep every new Duplicate out for good.
  async function refreshDriven() {
    if (!drivenRunning()) return { ok: true };
    const exported = job;
    const lost = message => ({ ...drivenRecord(exported.driven), running: false, lost: true, message });
    const cannotSay = 'This cswap can no longer say how the import in its own window stands; look at that window before starting again.';
    try {
      await ensureHost();
      let driven;
      if (!helloCan(native.lastHello ? native.lastHello() : null, DRIVEN_CAPABILITY)) {
        driven = lost(cannotSay);
      } else {
        try {
          const reply = await native.request({ type: 'import.driven.state', job: exported.id });
          driven = drivenRecord(redactValue(reply && reply.driven));
        } catch (e) {
          const code = e && e.code;
          if (code === 'unknown-type') driven = lost(cannotSay);
          else if (['not-claimed', 'not-driven', 'job-file'].includes(code)) driven = lost(`The bridge no longer holds this job: ${String(e.message || code)}`);
          else throw e;
        }
      }
      if (job !== exported) return { ok: true };
      await saveJob({ driven });
      if (!driven.running && !job.drivenNotified) {
        await saveJob({ drivenNotified: true });
        clearAlarm();
        if (driven.exit_code === 0) notify('cswap duplicate finished', driven.url ? `The copy is at ${driven.url}` : 'Done.');
        else notify('cswap duplicate: import stopped', driven.message || (driven.lost ? 'Its window closed before it said how it ended.' : 'See the side panel.'));
      }
      return { ok: true };
    } catch (e) {
      debug('native', 'the import in its own window was not asked about', { code: e && e.code, message: String(e && e.message || e) });
      return { ok: false, error: String(e && e.message || e) };
    } finally {
      if (!jobActive() && !handingOver && !drivenRunning() && !eventQueue.length) native.disconnect();
    }
  }

  // Import: the person's answer to an export that ended
  // without its import, in this tab or in a window of its own (`way`).
  // When the bridge still shows the export unfinished (the worker went away
  // before its end was delivered), the end is sent again from the stored
  // result first; the bridge takes a late end of a finished job as nothing
  // new.
  async function retryHandOver(way = 'tab', chosen = null) {
    // A pickup under way (a page that loaded, the poll alarm) may be taking
    // the import up already, and a catch-up for the panel may be asking the
    // bridge about this export: each is waited for, and what it left decides.
    while (pickupInFlight || catchingUp) await (pickupInFlight || catchingUp).catch(() => null);
    if (handingOver) return { ok: false, error: 'The import is already being started.' };
    const busy = busyText();
    if (busy) return { ok: false, error: busy };
    if (!job || jobKind() !== 'export' || job.phase !== 'done') return { ok: false, error: 'No finished export is waiting for its import.' };
    if (job.driven && job.driven.exit_code === 0) {
      return { ok: false, error: `The copy is already made${job.driven.url ? `: ${job.driven.url}` : ''}.` };
    }
    const carryOn = job.driven && typeof job.driven.carry_on === 'string' ? job.driven.carry_on : '';
    if (way !== 'driven' && carryOn) return { ok: false, error: carryOnOnlyText(carryOn) };
    const exported = job;
    handingOver = exported.id;
    try {
      await saveJob({ chainError: null });
      const ending = await resendExportEnd(exported);
      return way === 'driven' ? await startDrivenImport(exported, ending) : await chainImport(exported, ending, chosen);
    } finally {
      handingOver = null;
    }
  }

  // The bridge's record of a finished export may still show it unfinished
  // (the worker went away before its end was delivered): asked for the
  // job it holds, and when that is this export, the end is sent again
  // from the stored result. The sending is returned for the import's
  // start to wait on; nothing to send again, or a bridge out of reach,
  // is null (the import's start connects again and says why).
  async function resendExportEnd(exported) {
    try {
      await ensureHost();
      const reply = await native.request({ type: 'job.get' });
      const current = reply && reply.job;
      if (current && current.id === exported.id) {
        await learnFromHost(exported, current);
        if (!isTerminal(current.status)) {
          info('job', 'the bridge never heard the export finish; its end is sent again', { job: exported.id });
          return { done: emit('done', { result: exported.result || null }), last: emit('phase', { phase: 'done', detail: 'sent again' }) };
        }
      }
    } catch (e) { /* the import's start connects again and says why */ }
    return null;
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
      // The bridge names the export's folder on every answer (it is fixed at
      // the first write), so the line to type after a failed hand-off has it.
      const sofar = job.export && typeof job.export === 'object' ? job.export : {};
      const where = text(written.export_path, 1000);
      if (msg.last === true || (where && where !== sofar.path)) {
        await saveJob({ export: { ...sofar, ...(where ? { path: where } : {}),
          ...(msg.last === true ? { files: Number(written.files) || 0, bytes: Number(written.bytes) || 0 } : {}) } });
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
      codeList: msg.codeList && typeof msg.codeList === 'object' ? msg.codeList : null,
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
      if (!jobActive()) return;
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
      if (msg.re !== undefined) {
        if (msg.kind === 'signout') signal(`signout:${msg.re}`, { ok: msg.ok === true, status: Number.isInteger(msg.status) ? msg.status : 0 });
        else signal(`dom:${msg.re}`, stateOf(msg));
        return;
      }
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

  // A finished export the panel is about to show, whose import has not
  // started: what the stored record lacks is asked of the bridge, once per
  // panel opened, so that the panel offers what this cswap can do (a hello
  // stored before cswap was updated lacks the import in its own window)
  // and the line to type names the export's folder (an older worker kept
  // none). Nothing is started; the port is let go after when idle.
  let catchingUp = null;
  async function catchUpDoneExport() {
    if (catchingUp) return catchingUp;
    const exported = job;
    const waiting = () => job === exported && !jobActive() && !handingOver && !pickupInFlight && !drivenRunning();
    if (!exported || !waiting()) return null;
    if (exported.kind !== 'export' || exported.phase !== 'done' || !exported.chainError || exported.driven) return null;
    catchingUp = (async () => {
      const stored = (await sget(KEYS.bridge)) || {};
      if (helloCan(stored.lastHello, DRIVEN_CAPABILITY) && !needsHostRecord(exported)) return;
      if (!waiting()) return;
      try {
        await ensureHost();
        await learnFromHost(exported);
      } catch (e) {
        debug('native', 'the bridge was not asked about the finished export', { code: e && e.code, message: String(e && e.message || e) });
      } finally {
        if (!jobActive() && !handingOver && !drivenRunning() && !pickupInFlight && !eventQueue.length && !dialogOpen) native.disconnect();
      }
    })();
    try { return await catchingUp; } finally { catchingUp = null; }
  }

  // Import: the computer's own Open window, which the bridge opens in the
  // folder the last window used and this worker follows until it ends
  // (followDialog). The export opened there is imported into whichever
  // account the tab is signed in as, under the name typed: the export this
  // browser just made goes the hand-over's way (retryHandOver, which also
  // tells the bridge an end it never heard), any other by the window's
  // choice, which the bridge read itself (import.queue with the window's
  // id; no path travels from here). The job runs in the claude.ai tab in
  // front, or in the next claude.ai page that loads. The window closed
  // without a choice imports nothing and says so; nothing is retried on
  // its own, and no pickup takes the port while the window is open.
  async function importChosenExport(name) {
    while (pickupInFlight || catchingUp) await (pickupInFlight || catchingUp).catch(() => null);
    if (handingOver) return { ok: false, error: 'The import is already being started.' };
    const busy = busyText();
    if (busy) return { ok: false, error: busy };
    if (!userScriptsOk) return { ok: false, error: userScriptsError };
    handingOver = 'file';
    try {
      await ensureHost();
      if (!helloCan(native.lastHello ? native.lastHello() : null, DIALOGS_CAPABILITY)) return { ok: false, error: NO_DIALOGS_TEXT };
      // What the bridge has not heard yet reaches it first: the events
      // still on their way, then, for a finished export of this browser's
      // the bridge still shows unfinished (its end was lost), the end
      // again; until then the export holds the bridge's one place, where
      // the Open window would be refused.
      await drainEvents();
      const finished = job && jobKind() === 'export' && job.phase === 'done' ? job : null;
      const ending = finished ? await resendExportEnd(finished) : null;
      if (ending && !(await heardTheEnd(ending))) {
        return { ok: false, error: `the bridge did not confirm that the export finished${lastFlushError ? ` (${lastFlushError})` : ''}` };
      }
      const opened = dialogState(await native.request({ type: 'dialog.open', purpose: 'open' }));
      if (!opened.id) throw new Error('The bridge opened no Open window.');
      info('job', 'the Open window is open', { dialog: opened.id });
      dialogOpen = { id: opened.id, purpose: 'open' };
      let ended;
      try {
        ended = await followDialog(opened.id, () => !stopped);
      } finally {
        dialogOpen = null;
      }
      if (!ended) return { ok: false, error: OPEN_LOST_TEXT };
      if (ended.cancelled) return { ok: true, text: OPEN_CANCELLED_TEXT };
      if (!ended.chosen) return { ok: false, error: ended.error || OPEN_LOST_TEXT };
      const own = job && jobKind() === 'export' && job.phase === 'done' && job.export && typeof job.export === 'object' ? text(job.export.path, 1000) : '';
      const made = !!own && job.driven && typeof job.driven === 'object' && job.driven.exit_code === 0;
      if (own && samePath(ended.path, own) && !made) {
        // The hand-over guards itself (handingOver is the export's id
        // while it runs), and this press is answered when it is done.
        handingOver = null;
        return await retryHandOver('tab', { name });
      }
      const tabId = await chooseTab();
      const queued = await native.request({ type: 'import.queue', dialog: opened.id, signed_in: true, name });
      if (!queued || !queued.job || typeof queued.job.id !== 'string') throw new Error('the bridge queued no import');
      const claimed = await native.request({ type: 'job.claim', job: queued.job.id, instance: instance.id, extension_version: extensionVersion });
      info('job', 'the export opened in the Open window is queued for import', { job: claimed.job.id, tab: tabId });
      await adoptJob(claimed.job, tabId != null ? { tabId, navigateTo: CLAUDE_URL_PREFIX } : {});
      return { ok: true, text: `The import ${claimed.job.id} is queued.` };
    } catch (e) {
      const message = String(e && e.message || e);
      warn('job', 'the import of the opened export could not start', { message });
      return { ok: false, error: message };
    } finally {
      handingOver = null;
      if (!jobActive() && !drivenRunning() && !eventQueue.length && !dialogOpen) native.disconnect();
    }
  }

  function onPanelConnect(port) {
    const sender = port.sender || {};
    const own = typeof chrome.runtime.getURL === 'function' ? chrome.runtime.getURL('sidepanel.html') : null;
    const admitted = admit(port, 'panel', () => (!own || sender.url !== own ? 'not the extension\'s own page' : null));
    admitted.then(ok => (ok ? catchUpDoneExport() : null)).catch(e => debug('panel', 'catching up failed', { message: String(e && e.message || e) }));
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
          if (drivenRunning()) await refreshDriven();
          const found = await pickup('panel', true);
          return { ok: true, text: found ? `Picked up ${found.id}.` : 'No import is queued. Run `cswap project-move import --to NUM` first, or press Export this project.' };
        }
        case 'duplicate.start':
          return startDuplicate();
        case 'job.drop':
          return dropJobElsewhere(args);
        case 'duplicate.choose':
          return chooseDuplicate(args);
        case 'duplicate.import':
          // The Open window appears; what is opened there is imported.
          return importChosenExport(text(args.name, 300).trim());
        case 'signout':
          return signOutTab();
        case 'duplicate.driven':
          return retryHandOver('driven');
        case 'duplicate.driven.refresh':
          return refreshDriven();
        case 'duplicate.choices': {
          if (!jobActive() || jobKind() !== 'export' || job.phase !== 'choosing') return { ok: false, error: 'No Duplicate is waiting for a choice.' };
          const choices = await probeProjects();
          await saveJob({ choices });
          noteListing(choices);
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
  // starts on a fresh document. The project is chosen once the page says
  // who is signed in and what they can see (stepChoices). The registry is
  // not read: the copy goes into whichever account is signed in at Import.
  async function startDuplicate() {
    if (dialogOpen) return { ok: false, error: busyText() };
    if (jobActive()) return { ok: false, error: `A job is already running (${job.id}); wait for it or cancel it first.` };
    if (handingOver) return { ok: false, error: 'The last export is handing over to its import; wait for it, or press Import if it stops.' };
    if (drivenRunning()) return { ok: false, error: DRIVEN_RUNNING_TEXT };
    if (startingDuplicate) return { ok: false, error: 'A Duplicate is already starting.' };
    if (!userScriptsOk) return { ok: false, error: userScriptsError };
    startingDuplicate = true;
    try {
      const tabId = await chooseTab();
      if (tabId == null) return { ok: false, error: 'Open the project you want to copy on claude.ai, signed in as the account that has it, then press Export this project.' };
      const shown = pageStates.get(tabId);
      if (!isProjectUrl(shown && shown.state ? shown.state.url : '')) return { ok: false, error: NOT_ON_A_PROJECT_TEXT };
      await ensureHost();
      const hello = native.lastHello ? native.lastHello() : null;
      const capabilities = hello && Array.isArray(hello.capabilities) ? hello.capabilities : [];
      if (!capabilities.includes(DUPLICATE_CAPABILITY)) return { ok: false, error: NO_DUPLICATE_TEXT };
      // Said now, not after a reload and a listing: an older cswap would
      // take the export job and fail it at the Save As window.
      if (!capabilities.includes(DIALOGS_CAPABILITY)) return { ok: false, error: NO_DIALOGS_TEXT };
      const made = await native.request({ type: 'export.new', extension_version: extensionVersion });
      if (!made || !made.job || typeof made.job.id !== 'string') throw new Error('The bridge started no export job.');
      const known = pageStates.get(tabId);
      const here = known && known.state && typeof known.state.url === 'string' && known.state.url.startsWith(CLAUDE_URL_PREFIX) ? known.state.url : CLAUDE_URL_PREFIX;
      await adoptJob(made.job, { tabId, navigateTo: here });
      return { ok: true, text: `Started ${job.id}.` };
    } catch (e) {
      // The hello is read before the port is let go: disconnecting forgets it.
      const hello = native.lastHello ? native.lastHello() : null;
      if (!jobActive()) native.disconnect();
      let message = String(e && e.message || e);
      if (e && e.code === 'job-active') {
        // The host's job may be another browser's: a pickup finds out and
        // notes it, so the Connection section names it, with Drop that job
        // when the bridge can. A job of this browser's own, or an import
        // running in its own window, is refused in the host's own words.
        await pickup('refused', true).catch(() => null);
        let stored = null;
        try { stored = await sget(KEYS.bridge); } catch (e2) { stored = null; }
        if (stored && stored.jobElsewhere && helloCan(hello, DROP_CAPABILITY)) message = `${message} ${DROP_HINT_TEXT}`;
      }
      return { ok: false, error: message };
    } finally {
      startingDuplicate = false;
    }
  }

  // The person drops a job another browser profile holds and will never
  // answer for (an earlier copy of this extension, say, which a reinstall
  // made a new instance of): the host ends it as cancelled, as the
  // command line ends a job no browser claimed, and the next job can
  // start. The job is read from the host first, so only a job that is
  // not this browser's goes this way; this browser's own has Cancel, and
  // one it lost track of is picked up again by Check now. `args.job` is
  // the id the person confirmed: a job that took its place meanwhile is
  // named, not dropped.
  async function dropJobElsewhere(args) {
    const asked = text(args && args.job, 100);
    if (dialogOpen) return { ok: false, error: busyText() };
    if (jobActive()) return { ok: false, error: `This browser's own job (${job.id}) is running; stop it with Cancel.` };
    if (handingOver || startingDuplicate) return { ok: false, error: 'A job is starting here; wait for it.' };
    try {
      await ensureHost();
      if (!helloCan(native.lastHello ? native.lastHello() : null, DROP_CAPABILITY)) return { ok: false, error: NO_DROP_TEXT };
      const reply = await native.request({ type: 'job.get' });
      const found = reply && reply.job ? reply.job : null;
      if (!found || !ACTIVE_HOST_STATUSES.has(found.status)) {
        await noteBridge({ jobElsewhere: null });
        return { ok: true, text: 'The bridge holds no unfinished job; nothing to drop.' };
      }
      if (found.claimed_by && instance && found.claimed_by.instance === instance.id) {
        await noteBridge({ jobElsewhere: null });
        return { ok: false, error: `Job ${found.id} is this browser's own; press Check now to pick it up again.` };
      }
      if (found.id !== asked) {
        await noteBridge({ jobElsewhere: { id: found.id, claimed_by: found.claimed_by, at: now() } });
        return { ok: false, error: `The bridge now holds job ${found.id}${asked ? `, not ${asked}` : ''}; read the Connection line again before dropping it.` };
      }
      const dropped = await native.request({ type: 'job.drop', job: found.id });
      const done = !!(dropped && dropped.dropped);
      await noteBridge({ jobElsewhere: null });
      warn('job', 'dropped a job another browser profile held', { job: found.id, claimed_by: found.claimed_by || null, dropped: done });
      return { ok: true, text: done ? `Dropped job ${found.id}; a new job can start.` : `Job ${found.id} had already ended.` };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    } finally {
      if (!jobActive() && !handingOver && !drivenRunning()) native.disconnect();
    }
  }

  // The project the tab shows, chosen on its own (stepChoices), or by an
  // earlier panel's list, with an account to copy into and a name. The
  // bridge records the choice on the job; the tab goes to the project's
  // own page, where the export script finds it without a question, and
  // the job runs on from 'claimed'.
  async function chooseDuplicate(args, { drive = true } = {}) {
    if (!jobActive() || jobKind() !== 'export' || job.phase !== 'choosing') return { ok: false, error: 'No Duplicate is waiting for a choice.' };
    const projectId = text(args.projectId, 200);
    const choices = job.choices && Array.isArray(job.choices.projects) ? job.choices.projects : [];
    const project = choices.find(p => p && p.id === projectId);
    if (!project) return { ok: false, error: 'Choose a project from the list.' };
    // An account to copy into is an earlier panel's choice: the copy goes
    // into whichever account is signed in when Import is pressed.
    const destination = text(args.destination, 200).trim();
    const name = text(args.name, 300).trim();
    await ensureHost();
    // How the copy is imported once the export is done: in its own window
    // when asked for (the default) and this cswap can, in this tab otherwise.
    const way = importWay(text(args.way, 20) || DEFAULT_IMPORT_WAY, helloCan(native.lastHello ? native.lastHello() : null, DRIVEN_CAPABILITY));
    const reply = await native.request({
      type: 'export.choose', job: job.id,
      project: { id: project.id, name: project.name, kind: project.kind, org_uuid: project.orgUuid, org_name: project.orgName },
      destination: destination || null, name: name || null,
      source: { email: expectedIdentity().email, org_uuid: project.orgUuid },
    });
    const recorded = reply && reply.job ? reply.job : {};
    // Next, where the export goes (stepPlace); then the job goes on from
    // 'claimed' on the project's page.
    await saveJob({
      duplicate: recorded.duplicate || null, export: recorded.export || job.export, account: recorded.account || job.account,
      phase: 'placing', dialog: null, navigateTo: projectUrl(project), navigatedAt: null, nonce: null, injectedAt: null, importWay: way,
    });
    info('job', 'project chosen', { project: project.id, kind: project.kind, way });
    if (drive) runJob();
    return { ok: true };
  }

  // Sign out and reload: the person's act between the export and the
  // import. The claude.ai tab is asked to make the site's own sign-out
  // request (content.js makes it, in the tab's signed-in profile), then it
  // is sent to the sign-in page for the person to sign in as the other
  // account. Never while a job runs in it. When the site refuses, the
  // answer says so, with the way by hand.
  async function signOutTab() {
    if (dialogOpen || (jobActive() && job.phase === 'placing')) return { ok: false, error: busyText() };
    if (jobActive()) return { ok: false, error: 'A job is running in the tab; wait for it, or press Cancel first.' };
    if (handingOver || startingDuplicate) return { ok: false, error: 'A job is starting in the tab; wait for it, then press Sign out and reload.' };
    const tabId = await chooseTab();
    if (tabId == null) return { ok: false, error: 'Open a claude.ai tab first.' };
    const port = contentPorts.get(tabId);
    if (!port) return { ok: false, error: 'The claude.ai tab has not reported in; reload it, then press Sign out and reload again.' };
    const id = uuid();
    let answer = null;
    try {
      port.postMessage({ id, type: MSG.signOut });
      answer = await waitFor(`signout:${id}`, DOM_PROBE_TIMEOUT_MS);
    } catch (e) {
      return { ok: false, error: `The tab did not answer the sign-out: ${String(e && e.message || e)}. Sign out from the page's menu (your initials at the bottom left, Log out), then sign in as the other account.` };
    }
    const status = answer && Number.isInteger(answer.status) ? answer.status : 0;
    info('job', 'the person signed the tab out', { status, ok: !!(answer && answer.ok) });
    await navigateTab(tabId, `${CLAUDE_URL_PREFIX}login`);
    if (answer && answer.ok) return { ok: true, text: 'Signed out. Sign in as the other account on the page, then press Import.' };
    return {
      ok: false,
      error: `claude.ai did not sign the tab out${status ? ` (HTTP ${status})` : ''}. Sign out from the page's menu (your initials at the bottom left, Log out), sign in as the other account, then press Import.`,
    };
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
    if (job.phase === 'claimed' || job.phase === 'placing') { runJob(); return; }
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
        } else if (drivenRunning()) {
          await refreshDriven();
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
        if (!jobActive() || tabId !== job.tabId) return;
        // A tab that closes while the job waits for its fresh page lost
        // nothing: the next claude.ai tab is sent to that page first, as
        // this one was (navigateFirst), instead of taken as it is.
        if (job.phase === 'claimed') await saveJob({ tabId: null, navigatedAt: null });
        else await handlePageGone('tab-closed');
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
      // A finished export waits for Import across a restart as it was: the
      // panel offers Import, and nothing was being queued that a restart
      // could have cut short.
      // An import in its own window outlives this worker: the poll alarm
      // follows it while the panel is closed.
      if (drivenRunning()) armAlarm();
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
      eventQueue: eventQueue.length, delivered, handingOver, driving, dialogOpen, drivenRunning: drivenRunning(), contentTabs: [...contentPorts.keys()], lastRows: lastRows.length,
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
