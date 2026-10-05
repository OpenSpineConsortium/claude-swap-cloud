'use strict';
// Runs one of the browser-console scripts that `cswap project-move` hands out
// (src/claude_swap/browser/project-export.js and project-import.js) under
// Node, against a mock claude.ai. Nothing here talks to the network: fetch(),
// the DOM, the folder picker and the Resource Timing buffer are all
// stand-ins. Needs Node 20 or newer and nothing else.

const fs = require('fs');
const vm = require('vm');

// ---------------------------------------------------------------- mock disk
// Mirrors the File System Access API closely enough for both scripts.
// Writing: createWritable() starts from an empty file, each write() appends,
// nothing is visible until close(), and abort() discards it all.
// Reading: getFile(), and values()/entries() to walk a folder.
// Contents are kept as bytes, so binary files survive a round trip.
function notFound(name) {
  const e = new Error(`A requested file or directory could not be found: ${name}`);
  e.name = 'NotFoundError';
  return e;
}

// As in the browser, a name is one path segment: "", "." and ".." and
// anything with a separator in it are refused outright with a TypeError.
function checkName(name) {
  if (name === '' || name === '.' || name === '..' || /[\/\\]/.test(name)) {
    throw new TypeError('Name is not allowed.');
  }
}

class MemDir {
  constructor(name) {
    this.kind = 'directory';
    this.name = name;
    this.dirs = new Map();
    this.files = new Map();
  }
  async getDirectoryHandle(name, { create } = {}) {
    checkName(name);
    if (!this.dirs.has(name)) {
      if (!create) throw notFound(name);
      this.dirs.set(name, new MemDir(name));
    }
    return this.dirs.get(name);
  }
  async getFileHandle(name, { create } = {}) {
    checkName(name);
    if (!this.files.has(name)) {
      if (!create) throw notFound(name);
      this.files.set(name, { bytes: Buffer.alloc(0), writes: 0, opens: 0, closed: true });
    }
    const file = this.files.get(name);
    return {
      kind: 'file',
      name,
      getFile: async () => new File([file.bytes], name),
      createWritable: async () => {
        const parts = [];
        let open = true;
        file.opens++;
        file.closed = false;
        return {
          write: async chunk => {
            if (!open) throw new Error(`write after close: ${name}`);
            if (typeof chunk === 'string') parts.push(Buffer.from(chunk, 'utf8'));
            else if (chunk instanceof Uint8Array) parts.push(Buffer.from(chunk));
            else if (chunk && typeof chunk.arrayBuffer === 'function') parts.push(Buffer.from(await chunk.arrayBuffer()));
            // A typed array made inside the vm context is not `instanceof` out here.
            else if (chunk && chunk.buffer && typeof chunk.byteLength === 'number') {
              parts.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            } else throw new Error(`unsupported chunk written to ${name}`);
            file.writes++;
          },
          close: async () => {
            if (!open) throw new Error(`closed twice: ${name}`);
            open = false;
            file.bytes = Buffer.concat(parts);
            file.closed = true;
          },
          abort: async () => {
            open = false;
            file.closed = true;
            file.aborted = true;
            if (file.opens === 1) this.files.delete(name);
          },
        };
      },
    };
  }
  async *values() {
    for (const d of this.dirs.values()) yield d;
    for (const name of this.files.keys()) yield await this.getFileHandle(name);
  }
  async *entries() {
    for await (const h of this.values()) yield [h.name, h];
  }
  async *keys() {
    for await (const h of this.values()) yield h.name;
  }
  // Flat { 'a/b/c.txt': text } view, for assertions and diffs.
  flatten(prefix = '') {
    const out = {};
    for (const [name, f] of this.files) out[prefix + name] = f.bytes.toString('utf8');
    for (const [name, d] of this.dirs) Object.assign(out, d.flatten(`${prefix}${name}/`));
    return out;
  }
  // The same, as raw bytes.
  flattenBytes(prefix = '') {
    const out = {};
    for (const [name, f] of this.files) out[prefix + name] = f.bytes;
    for (const [name, d] of this.dirs) Object.assign(out, d.flattenBytes(`${prefix}${name}/`));
    return out;
  }
  // Same shape, but the bookkeeping of each file instead of its content.
  stats(prefix = '') {
    const out = {};
    for (const [name, f] of this.files) {
      out[prefix + name] = { writes: f.writes, opens: f.opens, closed: f.closed };
    }
    for (const [name, d] of this.dirs) Object.assign(out, d.stats(`${prefix}${name}/`));
    return out;
  }
  // Builds a folder from { 'a/b/c.txt': string | Buffer }.
  static from(name, tree) {
    const root = new MemDir(name);
    for (const [path, content] of Object.entries(tree)) {
      const segs = path.split('/');
      let dir = root;
      for (const seg of segs.slice(0, -1)) {
        if (!dir.dirs.has(seg)) dir.dirs.set(seg, new MemDir(seg));
        dir = dir.dirs.get(seg);
      }
      dir.files.set(segs[segs.length - 1], {
        bytes: Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'),
        writes: 0, opens: 0, closed: true,
      });
    }
    return root;
  }
}

// ---------------------------------------------------------------- mock DOM
// `downloads` collects the <a download> links that get clicked, so a test
// can get at what the script offered as a file.
function makeElement(tag, downloads = []) {
  return {
    tagName: String(tag).toUpperCase(),
    style: {},
    children: [],
    listeners: {},
    textContent: '',
    disabled: false,
    id: '',
    href: '',
    download: '',
    files: [],
    append(...kids) { this.children.push(...kids); },
    appendChild(kid) { this.children.push(kid); return kid; },
    remove() {},
    setAttribute(k, v) { this[k] = v; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    dispatchEvent(event) {
      for (const fn of this.listeners[event.type] || []) fn(event);
      return true;
    },
    click() {
      if (this.tagName === 'A' && this.download) downloads.push({ name: this.download, href: this.href });
      for (const fn of this.listeners.click || []) fn({ type: 'click', preventDefault() {} });
    },
  };
}

function show(a) {
  if (typeof a === 'string') return a;
  // Errors thrown inside the vm context are not `instanceof Error` out here.
  if (a && typeof a === 'object' && typeof a.message === 'string' && 'stack' in a) {
    return `${a.name || 'Error'}: ${a.message}`;
  }
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

// ---------------------------------------------------------------- runner
// opts:
//   script      path to the script to run
//   pathname    location.pathname of the tab
//   server      async (url: URL, headers: Record<string,string>, init) => Response
//   cookie      document.cookie string
//   resources   entries for performance.getEntriesByType('resource')
//   prompts     answers handed out by prompt(), in order
//   confirms    answers handed out by confirm(), in order (default: true)
//   click       press the script's button after it loads (default true)
//   patch       (source) => source, applied before the script runs
//   pick        the folder showDirectoryPicker() hands back (default: a new,
//               empty one, which the run's result exposes as `root`)
async function run(opts) {
  // Line endings are made the same everywhere first, so that a Windows
  // checkout and a Unix one run, and patch, the same text.
  let code = fs.readFileSync(opts.script, 'utf8').replace(/\r\n/g, '\n');
  if (opts.patch) code = opts.patch(code);
  const origin = 'https://claude.ai';

  const logs = [];
  const requests = [];
  const sleeps = [];
  const record = level => (...args) => {
    logs.push({ level, text: args.map(show).join(' ') });
  };

  const tables = [];
  const consoleMock = {
    log: record('log'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    table: value => {
      tables.push(JSON.parse(JSON.stringify(value)));
      logs.push({ level: 'table', text: JSON.stringify(value) });
    },
    group: record('log'),
    groupCollapsed: record('log'),
    groupEnd: () => {},
  };

  const fetchMock = async (input, init = {}) => {
    const url = new URL(String(input), origin);
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = String(v);
    requests.push({
      method: (init.method || 'GET').toUpperCase(),
      path: url.pathname + url.search,
      headers,
      credentials: init.credentials,
      // JSON bodies are kept for assertions; uploads are summarised.
      body: typeof init.body === 'string' ? init.body : init.body ? '(form data)' : undefined,
    });
    if (init.signal?.aborted) throw new Error('AbortError');
    return opts.server(url, headers, init);
  };

  const elements = [];
  const downloads = [];
  const body = makeElement('body');
  const documentMock = {
    cookie: opts.cookie || '',
    body,
    getElementById: () => null,
    createElement: tag => {
      const el = makeElement(tag, downloads);
      elements.push(el);
      return el;
    },
  };

  // Blob URLs: what URL.createObjectURL was given is kept, so a download
  // (an <a download> pointing at it) can be read back.
  const blobs = new Map();
  class URLMock extends URL {
    static createObjectURL(blob) {
      const key = `blob:${origin}/${blobs.size + 1}`;
      blobs.set(key, blob);
      return key;
    }
    static revokeObjectURL() {}
  }

  const root = opts.pick || new MemDir('picked-folder');
  const promptAnswers = [...(opts.prompts || [])];
  const confirmAnswers = [...(opts.confirms || [])];
  const promptsShown = [];
  const confirmsShown = [];
  const pickerCalls = [];

  const windowMock = {
    showDirectoryPicker: async options => {
      pickerCalls.push(options || {});
      return root;
    },
  };

  // Pauses (sleep(), retry back-off) are recorded and skipped so the suite
  // runs in seconds. Long timers are request time-outs: those keep their
  // real length and are always cleared by the script.
  const fastTimeout = (fn, ms = 0, ...args) => {
    if (ms >= 20000) return setTimeout(fn, ms, ...args);
    if (ms > 0) sleeps.push(ms);
    return setTimeout(fn, 0, ...args);
  };

  const sandbox = {
    console: consoleMock,
    fetch: fetchMock,
    document: documentMock,
    window: windowMock,
    location: { origin, pathname: opts.pathname, href: origin + opts.pathname, search: '' },
    performance: { getEntriesByType: type => (type === 'resource' ? opts.resources || [] : []) },
    prompt: message => {
      promptsShown.push(message);
      return promptAnswers.length ? promptAnswers.shift() : null;
    },
    confirm: message => {
      confirmsShown.push(message);
      return confirmAnswers.length ? confirmAnswers.shift() : true;
    },
    setTimeout: fastTimeout,
    clearTimeout, Blob, File, FormData, URL: URLMock, URLSearchParams, AbortController, AbortSignal,
    Headers, Response, TextEncoder, TextDecoder, encodeURIComponent, decodeURIComponent,
    atob, btoa,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  Object.assign(windowMock, {
    document: documentMock, location: sandbox.location, fetch: fetchMock,
    confirm: sandbox.confirm, prompt: sandbox.prompt,
  });

  vm.createContext(sandbox);

  let loadError = null;
  try {
    await vm.runInContext(code, sandbox, { filename: opts.script });
  } catch (e) {
    loadError = e;
  }

  const button = elements.find(e => e.tagName === 'BUTTON');
  const status = elements.find(e => e.tagName === 'DIV' && e !== elements[0]) || null;

  if (!loadError && button && opts.click !== false) {
    for (const fn of button.listeners.click || []) await fn({});
  }

  return {
    loadError,
    logs,
    tables,
    requests,
    sleeps,
    root,
    files: root.flatten(),
    bytes: root.flattenBytes(),
    fileStats: root.stats(),
    button,
    elements,
    statusText: status ? status.textContent : '',
    pickerCalls: pickerCalls.length,
    pickerOptions: pickerCalls,
    promptsShown,
    confirmsShown,
    // Files the script offered for download: [{ name, blob }].
    downloads: downloads.map(d => ({ name: d.name, blob: blobs.get(d.href) || null })),
  };
}

// JSON response helper that looks like claude.ai's (HTTP/2: empty statusText).
function json(status, value, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    statusText: '',
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

module.exports = { run, json, MemDir };
