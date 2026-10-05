(function (config) {
  'use strict';

  // ============================================================
  // cswap automation helper
  // ============================================================
  //
  // `cswap project-move auto` runs project-export.js and project-import.js
  // in a browser window it drives itself, through the Chrome DevTools
  // Protocol. This helper goes into the page first and takes the place of
  // the three things in those scripts that wait for a person:
  //
  //   * the folder window (showDirectoryPicker). For an export it hands back
  //     a folder that sends every file it is given straight to cswap, which
  //     writes it to disk; for an import it hands back the exported folder,
  //     which cswap has loaded into the page beforehand.
  //   * prompt(). Each question is answered the way cswap was told to (the
  //     project to export, the new project's name) or with the script's own
  //     suggestion, and every question and answer is kept for cswap to show.
  //   * the button. cswap presses it with click() once the script is ready.
  //
  // The scripts themselves are run unchanged, so pasting them by hand still
  // works exactly as before.
  //
  // Keep this file plain ASCII, like the scripts: tests/test_project_move.py
  // holds it to that.

  const cfg = config || {};

  const CHUNK = 1024 * 1024; // bytes per message to cswap
  const log = { prompts: [], errors: [], cancelled: '' };

  // ---------------------------------------------------------- helpers

  function domError(name, message) {
    try {
      return new DOMException(message, name);
    } catch (e) {
      const err = new Error(message);
      err.name = name;
      return err;
    }
  }

  function checkName(name) {
    if (name === '' || name === '.' || name === '..' || /[\/\\]/.test(String(name))) {
      throw new TypeError('Name is not allowed.');
    }
  }

  function toBase64(bytes) {
    let out = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(out);
  }

  function fromBase64(text) {
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  async function asBytes(chunk) {
    if (chunk && typeof chunk === 'object' && chunk.type === 'write' && 'data' in chunk) {
      chunk = chunk.data;
    }
    if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk)) {
      return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    if (chunk && typeof chunk.arrayBuffer === 'function') {
      return new Uint8Array(await chunk.arrayBuffer());
    }
    throw new TypeError('cswap: unsupported data written to a file');
  }

  // ---------------------------------------------------------- export: a folder that sends to cswap

  const send = typeof window[cfg.binding] === 'function' ? window[cfg.binding] : null;
  let serial = 0;

  function sendFile(path, bytes) {
    if (!send) throw new Error('cswap: the page lost its connection to cswap');
    const id = ++serial;
    const total = Math.max(1, Math.ceil(bytes.length / CHUNK));
    for (let seq = 0; seq < total; seq++) {
      send(JSON.stringify({
        op: 'file',
        id,
        path,
        seq,
        last: seq === total - 1,
        size: bytes.length,
        data: toBase64(bytes.subarray(seq * CHUNK, (seq + 1) * CHUNK)),
      }));
    }
  }

  class OutDir {
    constructor(name, path) {
      this.kind = 'directory';
      this.name = name;
      this.path = path;
      this.dirs = new Map();
      this.files = new Map();
    }

    async getDirectoryHandle(name, opts) {
      checkName(name);
      if (this.files.has(name)) throw domError('TypeMismatchError', `${name} is a file`);
      if (!this.dirs.has(name)) {
        if (!(opts && opts.create)) throw domError('NotFoundError', `${name} was not found`);
        this.dirs.set(name, new OutDir(name, this.path ? `${this.path}/${name}` : name));
      }
      return this.dirs.get(name);
    }

    async getFileHandle(name, opts) {
      checkName(name);
      if (this.dirs.has(name)) throw domError('TypeMismatchError', `${name} is a folder`);
      if (!this.files.has(name)) {
        if (!(opts && opts.create)) throw domError('NotFoundError', `${name} was not found`);
        this.files.set(name, { size: 0 });
      }
      const path = this.path ? `${this.path}/${name}` : name;
      const record = this.files.get(name);
      return {
        kind: 'file',
        name,
        getFile: async () => {
          throw domError('NotAllowedError', 'cswap keeps no copy of what was written');
        },
        createWritable: async () => {
          let parts = [];
          let open = true;
          return {
            write: async chunk => {
              if (!open) throw new TypeError(`write after close: ${name}`);
              parts.push((await asBytes(chunk)).slice());
            },
            close: async () => {
              if (!open) throw new TypeError(`closed twice: ${name}`);
              open = false;
              let size = 0;
              for (const p of parts) size += p.length;
              const bytes = new Uint8Array(size);
              let at = 0;
              for (const p of parts) {
                bytes.set(p, at);
                at += p.length;
              }
              parts = [];
              record.size = size;
              sendFile(path, bytes);
            },
            abort: async () => {
              open = false;
              parts = [];
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
  }

  // ---------------------------------------------------------- import: the exported folder, loaded by cswap

  class InDir {
    constructor(name) {
      this.kind = 'directory';
      this.name = name;
      this.dirs = new Map();
      this.files = new Map();
    }

    dirAt(parts, create) {
      let dir = this;
      for (const part of parts) {
        if (!dir.dirs.has(part)) {
          if (!create) return null;
          dir.dirs.set(part, new InDir(part));
        }
        dir = dir.dirs.get(part);
      }
      return dir;
    }

    async getDirectoryHandle(name) {
      checkName(name);
      if (this.dirs.has(name)) return this.dirs.get(name);
      if (this.files.has(name)) throw domError('TypeMismatchError', `${name} is a file`);
      throw domError('NotFoundError', `${name} was not found`);
    }

    async getFileHandle(name) {
      checkName(name);
      if (this.dirs.has(name)) throw domError('TypeMismatchError', `${name} is a folder`);
      if (!this.files.has(name)) throw domError('NotFoundError', `${name} was not found`);
      const parts = this.files.get(name);
      return {
        kind: 'file',
        name,
        getFile: async () => new File(parts, name),
        createWritable: async () => {
          throw domError('NotAllowedError', 'the exported folder is read-only');
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
  }

  const exportRoot = new OutDir(cfg.rootName || 'cswap', '');
  const importRoot = new InDir(cfg.rootName || 'export');
  let pickerCalls = 0;

  function addFile(path, data, append) {
    const parts = String(path).split('/');
    for (const part of parts) checkName(part);
    const dir = importRoot.dirAt(parts.slice(0, -1), true);
    const name = parts[parts.length - 1];
    if (!append || !dir.files.has(name)) dir.files.set(name, []);
    dir.files.get(name).push(fromBase64(data));
    return true;
  }

  window.showDirectoryPicker = async () => {
    pickerCalls++;
    return cfg.mode === 'import' ? importRoot : exportRoot;
  };

  // ---------------------------------------------------------- prompt()

  // "1. name" lines of a numbered question, with "  [code]" taken off.
  function options(message) {
    const out = [];
    for (const line of String(message).split('\n')) {
      const m = line.match(/^(\d+)\. (.*)$/);
      if (m) out.push({ n: m[1], name: m[2].replace(/ {2}\[code\]$/, '').trim() });
    }
    return out;
  }

  function byName(list, wanted) {
    const want = String(wanted || '').trim().toLocaleLowerCase();
    if (!want) return null;
    const exact = list.filter(o => o.name.toLocaleLowerCase() === want);
    if (exact.length === 1) return exact[0];
    const partial = list.filter(o => o.name.toLocaleLowerCase().includes(want));
    return partial.length === 1 ? partial[0] : null;
  }

  function activeOrgName() {
    const m = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
    let id = '';
    try {
      id = m ? decodeURIComponent(m[1]) : '';
    } catch (e) {
      id = '';
    }
    const org = (cfg.orgs || []).find(o => o && o.uuid === id);
    return org ? org.name || org.uuid : '';
  }

  function answer(message, suggested) {
    const text = String(message);

    if (/^Which project should be exported\?/.test(text)) {
      const pick = byName(options(text), cfg.project);
      if (pick) return pick.n;
      log.cancelled = cfg.project
        ? `No single project here is called "${cfg.project}".`
        : 'There is more than one project; name the one to move.';
      log.choices = options(text).map(o => o.name);
      return null;
    }

    if (/^Which organization/.test(text)) {
      const pick = byName(options(text), activeOrgName());
      return pick ? pick.n : suggested == null ? null : String(suggested);
    }

    if (/^Import /.test(text) && /Name for the new project/.test(text)) {
      if (/can be seen from this login/.test(text)) log.sourceVisible = true;
      return cfg.name ? String(cfg.name) : suggested == null ? null : String(suggested);
    }

    return suggested == null ? null : String(suggested);
  }

  window.prompt = (message, suggested) => {
    const given = answer(message, suggested);
    log.prompts.push({ message: String(message), answer: given });
    return given;
  };
  // Neither script asks these, but a dialog left open would stop the page.
  window.confirm = message => {
    log.prompts.push({ message: String(message), answer: 'OK' });
    return true;
  };
  window.alert = message => {
    log.prompts.push({ message: String(message), answer: '' });
  };

  // Installed again on the same page, it wraps the original, not itself.
  if (!window.__cswapConsoleError) window.__cswapConsoleError = console.error.bind(console);
  const consoleError = window.__cswapConsoleError;
  console.error = (...args) => {
    log.errors.push(args.map(a => (a && a.message) || String(a)).join(' '));
    consoleError(...args);
  };

  // ---------------------------------------------------------- what cswap reads

  const LABELS = {
    export: { start: 'Export Claude Project', done: 'Export complete' },
    import: { start: 'Import Claude Project', done: 'Import complete' },
  };

  function button() {
    const want = LABELS[cfg.mode];
    for (const b of document.querySelectorAll('button')) {
      const t = (b.textContent || '').trim();
      if (t === want.start || t === want.done) return b;
    }
    return null;
  }

  function state() {
    const b = button();
    const wrap = b && b.parentElement;
    const status = wrap ? wrap.firstElementChild : null;
    const link = wrap ? wrap.querySelector('a') : null;
    const statusText = status && status !== b ? (status.textContent || '').trim() : '';
    return {
      ready: Boolean(b),
      button: b ? (b.textContent || '').trim() : '',
      disabled: Boolean(b && b.disabled),
      done: Boolean(b && (b.textContent || '').trim() === LABELS[cfg.mode].done),
      status: statusText,
      link: link && link.href && link.style.display !== 'none' ? link.href : '',
      pickerCalls,
      sent: serial,
      prompts: log.prompts,
      errors: log.errors.slice(-5),
      cancelled: log.cancelled,
      choices: log.choices || [],
      sourceVisible: Boolean(log.sourceVisible),
    };
  }

  function press() {
    const b = button();
    if (!b) return false;
    b.click();
    return true;
  }

  window.__cswap = { mode: cfg.mode, addFile, state, press };
  return 'installed';
})
