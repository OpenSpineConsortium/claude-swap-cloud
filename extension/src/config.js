// The settings of the Claude Swap Cloud extension: what each one means, its
// bounds and its default, a validator that turns anything into a clean
// config without ever throwing, and a small store over chrome.storage.local
// that keeps the one copy the service worker and the side panel share.
//
// Nothing here is random and nothing here knows about accounts: the only
// pacing settings are two fixed gaps, one before a request that reads and
// one before a request that writes, and the only limit on a Retry-After is
// how long a wait is shown as a hold (the full wait is still honoured). The
// module takes its storage as an argument so tests run with a Map; the real
// binding to the 'cswap.config' key is the caller's.

export const CONFIG_VERSION = 2;

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

// A request that only reads goes out as soon as the previous one has ended,
// still one at a time: an export of a few hundred reads spent half its run
// in a 500 ms spacing while the site never once said slow down. A write
// keeps half a second. The import script counts a 429 as the likeliest
// answer to many uploads in a row, each one costs it at least two seconds
// of its own back-off and the ninth in a row holds the step; and a create,
// a document or a standard project's file goes out only once, so its first
// failure stops the import for the person. Both are settable down to 0.
export const DEFAULTS = Object.freeze({
  version: CONFIG_VERSION,
  readSpacingMs: 0,
  writeSpacingMs: 500,
  retryAfterCapMs: 900000,
  requestTimeoutMs: 120000,
  notifications: true,
  logLevel: 'info',
  logMaxRecords: 2000,
  logRetentionHours: 72,
});

// One entry per editable key, in the order the side panel shows them. The
// help texts are the panel's; they say what a setting does and what it
// never does.
export const FIELDS = Object.freeze([
  {
    key: 'readSpacingMs',
    label: 'Spacing before a read (ms)',
    kind: 'int',
    min: 0,
    max: 60000,
    help: 'Gap in milliseconds from the end of one request to the start of the next when the next only reads: a GET or HEAD, and every request of an export. 0 sends it as soon as the previous one has ended, still one request at a time. Fixed, never randomized. The site\'s own Retry-After and the script\'s own back-off are waited out on top of it.',
  },
  {
    key: 'writeSpacingMs',
    label: 'Spacing before a write (ms)',
    kind: 'int',
    min: 0,
    max: 60000,
    help: 'Gap in milliseconds from the end of one request to the start of the next when the next writes: an import\'s creates, uploads and settings. Fixed, never randomized. The site\'s own Retry-After and the script\'s own back-off are waited out on top of it.',
  },
  {
    key: 'retryAfterCapMs',
    label: 'Retry-After shown as a hold above (ms)',
    kind: 'int',
    min: 60000,
    max: 86400000,
    help: 'A Retry-After longer than this is shown as a hold that waits for you to press Resume instead of a silent countdown. The full Retry-After is still waited out after Resume.',
  },
  {
    key: 'requestTimeoutMs',
    label: 'Request timeout (ms)',
    kind: 'int',
    min: 30000,
    max: 3600000,
    help: 'How long one request may take before it counts as no reply, plus 4000 ms per MiB of upload. The script then treats it as a failed attempt.',
  },
  {
    key: 'notifications',
    label: 'Desktop notifications',
    kind: 'bool',
    help: 'Show a desktop notification when the import is interrupted, held, done or failed.',
  },
  {
    key: 'logLevel',
    label: 'Log level',
    kind: 'choice',
    choices: LOG_LEVELS,
    help: 'The least important record kept. "debug" also keeps one record per request (method, path, status, timing; never headers or bodies).',
  },
  {
    key: 'logMaxRecords',
    label: 'Log records kept',
    kind: 'int',
    min: 100,
    max: 20000,
    help: 'The oldest records are dropped beyond this many.',
  },
  {
    key: 'logRetentionHours',
    label: 'Log retention (hours)',
    kind: 'int',
    min: 1,
    max: 720,
    help: 'Records older than this are dropped.',
  },
].map(Object.freeze));

const FIELD_BY_KEY = new Map(FIELDS.map(f => [f.key, f]));

// How a value is shown inside a problem message: short, and never thrown
// off by something JSON cannot print.
function describe(value) {
  let text;
  try {
    text = typeof value === 'string' ? JSON.stringify(value) : String(JSON.stringify(value));
  } catch {
    text = String(value);
  }
  if (text === 'undefined') text = String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A number, or a string that is nothing but a number: the panel's number
// inputs hand over strings, and "750" means 750 without any doubt.
function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return NaN;
}

function checkInt(field, value, problems) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) {
    problems.push({
      key: field.key,
      message: `${field.key} must be a whole number between ${field.min} and ${field.max}; ${describe(value)} was replaced by ${DEFAULTS[field.key]}`,
    });
    return DEFAULTS[field.key];
  }
  // The + 0 turns the -0 that Math.round(-0.2) gives into a plain 0.
  const rounded = Math.round(n) + 0;
  if (rounded < field.min) {
    problems.push({ key: field.key, message: `${field.key} ${describe(value)} is below the minimum ${field.min}; ${field.min} was used` });
    return field.min;
  }
  if (rounded > field.max) {
    problems.push({ key: field.key, message: `${field.key} ${describe(value)} is above the maximum ${field.max}; ${field.max} was used` });
    return field.max;
  }
  return rounded;
}

function checkBool(field, value, problems) {
  if (typeof value === 'boolean') return value;
  problems.push({
    key: field.key,
    message: `${field.key} must be true or false; ${describe(value)} was replaced by ${DEFAULTS[field.key]}`,
  });
  return DEFAULTS[field.key];
}

function checkChoice(field, value, problems) {
  if (typeof value === 'string') {
    const wanted = value.trim().toLowerCase();
    const hit = field.choices.find(c => c === wanted);
    if (hit !== undefined) return hit;
  }
  problems.push({
    key: field.key,
    message: `${field.key} must be one of ${field.choices.join(', ')}; ${describe(value)} was replaced by ${describe(DEFAULTS[field.key])}`,
  });
  return DEFAULTS[field.key];
}

// Version 1 had one spacing for every request, minSpacingMs, whose default
// was 500. It carries over as the spacing before a write, which keeps that
// default. Before a read it carries over only when the person had changed
// it: the first load of version 1 wrote its default into storage, so an
// untouched 500 cannot be told from a chosen one and becomes the new
// default of 0. Only what was stored is migrated; a patch from set() is
// merged into a version-2 config, where minSpacingMs is an unknown setting.
const V1_SPACING_DEFAULT_MS = 500;

function fromVersion1(source) {
  if (!('minSpacingMs' in source)) return source;
  const { minSpacingMs, ...rest } = source;
  if (!('writeSpacingMs' in rest)) rest.writeSpacingMs = minSpacingMs;
  if (!('readSpacingMs' in rest) && toNumber(minSpacingMs) !== V1_SPACING_DEFAULT_MS) rest.readSpacingMs = minSpacingMs;
  return rest;
}

// Turns whatever was stored, patched or pasted into a complete, in-bounds
// config, and says what had to be changed. Never throws: a corrupt store
// yields the defaults and a problem, not a broken extension. A missing key
// is filled from the defaults silently, because that is how a config from
// an older version looks, and a problem with an empty key is about the
// object as a whole. A version-1 config is carried over without a problem.
export function validate(input) {
  const problems = [];
  let source = input;
  if (source === undefined || source === null) {
    source = {};
  } else if (!isPlainObject(source)) {
    problems.push({ key: '', message: `the stored settings are ${describe(source)}, not an object; the defaults were used` });
    source = {};
  }
  if (!('version' in source) || source.version === 1) source = fromVersion1(source);
  const config = { version: CONFIG_VERSION };
  if ('version' in source && source.version !== CONFIG_VERSION && source.version !== 1) {
    problems.push({ key: 'version', message: `settings version ${describe(source.version)} is not ${CONFIG_VERSION}; the values were checked against version ${CONFIG_VERSION}` });
  }
  for (const field of FIELDS) {
    if (!(field.key in source) || source[field.key] === undefined) {
      config[field.key] = DEFAULTS[field.key];
      continue;
    }
    const value = source[field.key];
    if (field.kind === 'int') config[field.key] = checkInt(field, value, problems);
    else if (field.kind === 'bool') config[field.key] = checkBool(field, value, problems);
    else config[field.key] = checkChoice(field, value, problems);
  }
  for (const key of Object.keys(source)) {
    if (key !== 'version' && !FIELD_BY_KEY.has(key)) {
      problems.push({ key, message: `unknown setting ${describe(key)} was dropped` });
    }
  }
  return { config, problems };
}

// What the gate is handed for the job at hand. An export only reads (its
// only POSTs, files:list and files:open, read too), so every one of its
// requests is spaced as a read; an import spaces its writes as writes.
export function gateConfig(config, kind) {
  const c = isPlainObject(config) ? config : DEFAULTS;
  return {
    readSpacingMs: c.readSpacingMs,
    writeSpacingMs: kind === 'export' ? c.readSpacingMs : c.writeSpacingMs,
    retryAfterCapMs: c.retryAfterCapMs,
  };
}

function sameJson(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function messageOf(error) {
  if (error && typeof error.message === 'string') return error.message;
  return String(error);
}

// The one config the worker uses, kept in the injected store. get() is
// synchronous and cheap on purpose: the gate reads the spacing on every
// permit. Writes go one after another, so the last set() is what ends up
// stored, and every write happens after the stored value was read once, so
// a set() early in the worker's life cannot wipe out settings it never saw.
// A read that fails is tried again by the next load(), and until a read or
// a write of ours has succeeded a patch is refused rather than merged into
// the defaults and written over settings nobody has seen.
//
//   store:    { get(): Promise<any>, set(value): Promise<void>, onChanged?(fn) }
//             bound to the 'cswap.config' key by the caller
//   onChange: (config) => void, once per load() that read or wrote, after
//             every write of ours and on a change made elsewhere; its errors
//             are swallowed. The call at load is what hands the logger its
//             level and limits again after a service-worker restart.
export function createConfigStore({ store, onChange } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('createConfigStore needs a store with get() and set()');
  }
  let current = Object.freeze({ ...DEFAULTS });
  let loading = null;
  // True from a read that failed until a read or a write of ours succeeds:
  // while it holds, what is stored is unknown.
  let unknown = false;
  let queue = Promise.resolve();

  function notify(config) {
    if (typeof onChange !== 'function') return;
    try {
      onChange(config);
    } catch {
      // A listener's error is the listener's problem; the config is saved.
    }
  }

  async function doLoad() {
    let raw;
    try {
      raw = await store.get();
    } catch {
      // What is there is unknown, so nothing is written and nothing in
      // memory changes; load() lets the next call read again.
      unknown = true;
      return current;
    }
    unknown = false;
    const { config } = validate(raw);
    current = Object.freeze(config);
    // The clean shape is written back once when it differs from what was
    // stored: a fresh install, a corrupt object or an older version then
    // leaves a complete object behind, which is what the side panel renders
    // from.
    if (!sameJson(raw, config)) {
      try {
        await store.set(config);
      } catch {
        // Storage refused; the clean config still applies in memory.
      }
    }
    // Whoever listens learns what applies now, whether it was stored clean,
    // healed or filled in from the defaults: nothing else tells the logger
    // the saved level and limits after a service-worker restart.
    notify(current);
    return current;
  }

  // One read at a time, shared by whoever asks while it runs. A read that
  // failed is forgotten once it is over, so the next load() tries again
  // instead of handing out the defaults for the rest of the worker's life.
  function load() {
    if (!loading) {
      const attempt = doLoad().then(config => {
        if (unknown && loading === attempt) loading = null;
        return config;
      });
      loading = attempt;
    }
    return loading;
  }

  // The one write path. A patch is merged into what is stored, so it needs
  // a base; the defaults of reset() do not, and may go out while the store
  // cannot be read.
  function save(patch, needsBase) {
    const run = async () => {
      await load();
      if (!isPlainObject(patch)) {
        return { config: current, problems: [{ key: '', message: `the settings to save must be an object, not ${describe(patch)}` }] };
      }
      if (unknown && needsBase) {
        return { config: current, problems: [{ key: '', message: 'the settings could not be saved: the stored settings could not be read, and a change merged into the defaults would have replaced them' }] };
      }
      const { config, problems } = validate({ ...current, ...patch });
      if (!unknown && sameJson(config, current)) return { config: current, problems };
      const previous = current;
      const next = Object.freeze(config);
      // The new value is current before the write, so the storage change
      // event for our own write (which arrives in this context too) finds
      // nothing new and does not notify twice.
      current = next;
      try {
        await store.set(next);
      } catch (error) {
        current = previous;
        problems.push({ key: '', message: `the settings could not be saved: ${messageOf(error)}` });
        return { config: current, problems };
      }
      // Storage now holds exactly this object, so what is stored is known
      // again even when the last read failed, and no read is owed.
      unknown = false;
      if (!loading) loading = Promise.resolve(current);
      notify(current);
      return { config: current, problems };
    };
    queue = queue.then(run, run);
    return queue;
  }

  function set(patch) {
    return save(patch, true);
  }

  async function reset() {
    const result = await save({ ...DEFAULTS }, false);
    return result.config;
  }

  if (typeof store.onChanged === 'function') {
    try {
      store.onChanged(raw => {
        try {
          const { config } = validate(raw);
          if (sameJson(config, current)) return;
          current = Object.freeze(config);
          notify(current);
        } catch {
          // Never let a storage event take the worker down.
        }
      });
    } catch {
      // A store without working change events still works for reads and writes.
    }
  }

  return {
    load,
    get: () => current,
    set,
    reset,
  };
}
