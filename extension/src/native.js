// The client of the native-messaging host (`cswap bridge`). Every message
// out carries an integer id and the host answers with `re`; a stream (a
// file's chunks) answers with several messages, the last marked `last`.
// Everything here is injected: the port factory, the clock, the timers, the
// logger and the store, so the tests drive it with a fake port pair.

import { HOST_NAME, PROTOCOL } from './protocol.js';

export const PRODUCT = 'claude-swap';

export const INSTALL_HINT =
  'The cswap bridge is not registered for this browser. Run `cswap bridge install --register` ' +
  'on the command line, then reload the extension.';

export const FORBIDDEN_HINT =
  'The cswap bridge is registered for another extension id. Run `cswap bridge install --register` ' +
  'again so that it allows this one.';

// What Chrome puts in runtime.lastError when a native port drops, mapped to
// a code and a sentence the panel can show.
export function describeDisconnect(message) {
  const text = String(message || '');
  if (/not found/i.test(text)) return { code: 'no-host', message: INSTALL_HINT };
  if (/forbidden/i.test(text)) return { code: 'no-host', message: FORBIDDEN_HINT };
  if (/exited/i.test(text)) return { code: 'disconnected', message: 'The cswap bridge exited: ' + text };
  if (text) return { code: 'disconnected', message: 'The cswap bridge disconnected: ' + text };
  return { code: 'disconnected', message: 'The cswap bridge disconnected.' };
}

// A chunk's bytes and a script's text are replaced by their size before a
// message is logged; the logger redacts the rest.
export function compactForLog(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  const out = { ...msg };
  if (typeof out.data === 'string') out.data = `<${out.data.length} chars>`;
  if (typeof out.text === 'string' && out.type === 'script') out.text = `<${out.text.length} chars>`;
  return out;
}

function failure(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function createNative({
  connect,
  hostName = HOST_NAME,
  now = Date.now,
  log = null,
  store = null,
  timeoutMs = 30000,
  schedule = setTimeout,
  unschedule = clearTimeout,
  lastError = () => null,
  redact = compactForLog,
} = {}) {
  if (typeof connect !== 'function') throw new TypeError('createNative needs a connect() that opens the native port');

  let port = null;
  let connected = false;
  let hello = null;
  let nextId = 1;
  const pending = new Map(); // id -> { msg, resolve, reject, onPart, timer }
  const listeners = new Set();

  function debug(direction, msg) {
    if (log && typeof log.debug === 'function') {
      try { log.debug('native', direction, redact(msg)); } catch (e) { /* logging never breaks the port */ }
    }
  }

  async function remember(patch) {
    if (!store) return;
    try {
      const current = (await store.get()) || {};
      await store.set({ ...current, ...patch });
    } catch (e) { /* the panel shows a stale line at worst */ }
  }

  function armTimer(id, entry) {
    if (entry.timer && unschedule) unschedule(entry.timer);
    entry.timer = schedule(() => {
      if (pending.get(id) !== entry) return;
      pending.delete(id);
      entry.reject(failure('timeout', `The cswap bridge did not answer ${entry.msg.type} within ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
  }

  function settle(id, entry) {
    pending.delete(id);
    if (entry.timer && unschedule) unschedule(entry.timer);
  }

  function rejectAll(err) {
    for (const [id, entry] of [...pending]) {
      settle(id, entry);
      entry.reject(err);
    }
  }

  function onMessage(m) {
    debug('in', m);
    if (!m || typeof m !== 'object' || typeof m.re !== 'number') return;
    const entry = pending.get(m.re);
    if (!entry) return;
    if (m.type === 'error') {
      settle(m.re, entry);
      entry.reject(failure(String(m.code || 'error'), String(m.message || `The cswap bridge refused ${entry.msg.type} (${m.code || 'error'}).`)));
      return;
    }
    if (entry.onPart && (m.last !== undefined || m.part !== undefined)) {
      try { entry.onPart(m); } catch (e) { settle(m.re, entry); entry.reject(e); return; }
      if (!m.last) { armTimer(m.re, entry); return; }
    }
    settle(m.re, entry);
    entry.resolve(m);
  }

  function onDisconnect() {
    const why = describeDisconnect(lastError());
    const wasConnected = connected;
    connected = false;
    port = null;
    hello = null;
    const err = failure(why.code, why.message);
    rejectAll(err);
    remember({ connected: false, lastError: why.message, lastErrorCode: why.code, disconnectedAt: now() });
    if (log && typeof log.info === 'function' && wasConnected) {
      try { log.info('native', 'disconnected', { code: why.code, message: why.message }); } catch (e) { /* nothing */ }
    }
    for (const fn of listeners) {
      try { fn(err); } catch (e) { /* a listener's failure is its own */ }
    }
  }

  function send(msg, onPart) {
    return new Promise((resolve, reject) => {
      if (!connected || !port) {
        reject(failure('disconnected', 'Not connected to the cswap bridge.'));
        return;
      }
      const id = nextId++;
      // The transport id goes last so a body with its own `id` (the created
      // event names the project by one) never overwrites it: the host pairs
      // the ack by this id, and reads the project from the url.
      const full = { ...msg, id };
      const entry = { msg: full, resolve, reject, onPart: onPart || null, timer: null };
      pending.set(id, entry);
      armTimer(id, entry);
      debug('out', full);
      try {
        port.postMessage(full);
      } catch (e) {
        settle(id, entry);
        reject(failure('disconnected', `The cswap bridge port is closed (${e && e.message ? e.message : e}).`));
      }
    });
  }

  async function connectHost(helloBody = {}) {
    if (connected && hello) return hello;
    let p;
    try {
      p = connect(hostName);
    } catch (e) {
      const why = describeDisconnect(e && e.message);
      await remember({ connected: false, lastError: why.message, lastErrorCode: 'no-host' });
      throw failure('no-host', why.message);
    }
    if (!p || !p.onMessage || !p.onDisconnect) throw failure('no-host', INSTALL_HINT);
    port = p;
    connected = true;
    p.onMessage.addListener(onMessage);
    p.onDisconnect.addListener(() => { if (port === p) onDisconnect(); });
    const reply = await send({ type: 'hello', protocol: PROTOCOL, ...helloBody });
    if (!reply || reply.type !== 'hello' || reply.product !== PRODUCT || reply.protocol !== PROTOCOL) {
      const message = reply && reply.type === 'hello'
        ? `The cswap bridge speaks protocol ${reply.protocol} as ${reply.product}; this extension needs ${PROTOCOL} from ${PRODUCT}. Update cswap or the extension.`
        : 'The cswap bridge gave no proper hello.';
      disconnect();
      await remember({ connected: false, lastError: message, lastErrorCode: 'protocol' });
      throw failure('protocol', message);
    }
    hello = reply;
    await remember({
      connected: true,
      lastHello: { cswap: reply.cswap, backup_dir: reply.backup_dir, protocol: reply.protocol, capabilities: reply.capabilities },
      lastError: null,
      lastErrorCode: null,
      connectedAt: now(),
    });
    if (log && typeof log.info === 'function') {
      try { log.info('native', 'connected', { cswap: reply.cswap, protocol: reply.protocol }); } catch (e) { /* nothing */ }
    }
    return reply;
  }

  function disconnect() {
    const p = port;
    port = null;
    connected = false;
    hello = null;
    rejectAll(failure('disconnected', 'The cswap bridge connection was closed.'));
    if (p) { try { p.disconnect(); } catch (e) { /* nothing */ } }
  }

  return {
    connect: connectHost,
    request: msg => send(msg),
    requestStream: (msg, onPart) => send(msg, typeof onPart === 'function' ? onPart : () => {}),
    event: body => send({ type: 'event', ...body }).then(ack => ({ cancel_requested: !!(ack && ack.cancel_requested), ack })),
    disconnect,
    onDisconnect: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    isConnected: () => connected,
    lastHello: () => hello,
    pendingCount: () => pending.size,
  };
}
