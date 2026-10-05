(async () => {
  'use strict';

  // ============================================================
  // Claude project exporter
  // ============================================================
  //
  // `cswap project-move export` copies this script to the clipboard. Paste
  // it into the DevTools console (F12, then Console) of a claude.ai tab while
  // signed in, with the project to export open in that tab (from any other
  // claude.ai page it asks which project). A button appears at the bottom
  // right. Press it and choose a folder: the project is saved in a folder
  // of its own inside the one you choose.
  //
  //   A regular project (claude.ai/project/...) is saved with its
  //   instructions, description, memory, knowledge files and every chat.
  //
  //   A Claude Code project (claude.ai/code/project/...) is saved with its
  //   description, instructions, settings and its own files, and with its
  //   timeline, threads and session transcripts.
  //
  // An export ends with export.json, written once everything it lists is on
  // disk. That file is what the importer (project-import.js, copied by
  // `cswap project-move import`) and `cswap project-move check` read.
  //
  // This script only reads from claude.ai. It changes nothing there.
  //
  // Keep this file plain ASCII, writing any other character as a \uXXXX
  // escape: it travels through the clipboard, and on Windows that garbles
  // anything else. tests/test_project_move.py holds it to that.

  const API = '/api';
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ============================================================
  // Helpers
  // ============================================================

  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.data)) return v.data;
    if (v && Array.isArray(v.items)) return v.items;
    if (v && Array.isArray(v.results)) return v.results;
    return [];
  }

  async function fetchJSON(url, optional = false) {
    const r = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });

    if (!r.ok) {
      if (optional && (r.status === 403 || r.status === 404)) return null;
      const body = await r.text().catch(() => '');
      throw new Error(
        `${r.status} ${r.statusText}: ${url}` +
        (body ? `\n${body.slice(0, 500)}` : '')
      );
    }

    return r.json();
  }

  async function fetchBlob(url, optional = false) {
    const r = await fetch(url, { credentials: 'include' });

    if (!r.ok) {
      if (optional && (r.status === 403 || r.status === 404)) return null;
      throw new Error(`${r.status} ${r.statusText}: ${url}`);
    }

    return r.blob();
  }

  function absUrl(url) {
    if (!url) return null;
    try {
      return new URL(url, location.origin).href;
    } catch {
      return url;
    }
  }

  function safeName(value, fallback = 'Untitled', max = 180) {
    let s = String(value || fallback)
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\/\\:*?"<>|]/g, '\u2013')
      .trim();

    if (!s) s = fallback;
    if (s.length > max) s = s.slice(0, max).trim();

    return s;
  }

  function makeUniqueNamer() {
    const used = new Map();

    return name => {
      const clean = safeName(name);
      const key = clean.toLocaleLowerCase();

      if (!used.has(key)) {
        used.set(key, 1);
        return clean;
      }

      const n = used.get(key) + 1;
      used.set(key, n);

      const dot = clean.lastIndexOf('.');
      return dot > 0
        ? `${clean.slice(0, dot)} (${n})${clean.slice(dot)}`
        : `${clean} (${n})`;
    };
  }

  async function getDir(parent, name) {
    return parent.getDirectoryHandle(safeName(name), { create: true });
  }

  async function writeBlob(dir, name, blob) {
    const handle = await dir.getFileHandle(safeName(name), { create: true });
    const writer = await handle.createWritable();
    await writer.write(blob);
    await writer.close();
  }

  async function writeText(dir, name, text) {
    await writeBlob(
      dir,
      name,
      new Blob([text ?? ''], { type: 'text/plain;charset=utf-8' })
    );
  }

  async function writeJSON(dir, name, value) {
    await writeText(dir, name, JSON.stringify(value ?? null, null, 2) + '\n');
  }

  function iso(value) {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.valueOf()) ? String(value) : d.toISOString();
  }

  function firstString(...values) {
    for (const v of values) {
      if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
  }

  function memoryText(memory) {
    if (!memory) return '';
    if (typeof memory === 'string') return memory;

    return firstString(
      memory.memory,
      memory.content,
      memory.text,
      memory.value,
      memory.summary
    );
  }

  function longestBacktickRun(text) {
    return (String(text || '').match(/`+/g) || [])
      .reduce((m, run) => Math.max(m, run.length), 0);
  }

  function fencedText(text) {
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
    return `${fence}text\n${text}\n${fence}`;
  }

  function extensionFromMime(type) {
    const t = String(type || '').toLowerCase().split(';')[0].trim();

    const map = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/svg+xml': '.svg',
      'application/pdf': '.pdf',
      'application/json': '.json',
      'text/plain': '.txt',
      'text/markdown': '.md',
      'text/html': '.html',
      'text/csv': '.csv',
    };

    return map[t] || '';
  }

  function inferArtifactExtension(input, content) {
    const kind = String(
      input?.type ||
      input?.language ||
      input?.mime_type ||
      ''
    ).toLowerCase();

    const map = {
      'text/markdown': '.md',
      markdown: '.md',
      md: '.md',

      'text/plain': '.txt',
      text: '.txt',
      txt: '.txt',

      'text/html': '.html',
      html: '.html',

      'image/svg+xml': '.svg',
      svg: '.svg',

      'application/json': '.json',
      json: '.json',

      javascript: '.js',
      js: '.js',

      typescript: '.ts',
      ts: '.ts',

      jsx: '.jsx',
      tsx: '.tsx',

      python: '.py',
      py: '.py',

      css: '.css',
      csv: '.csv',
      xml: '.xml',
      sql: '.sql',
      bash: '.sh',
      shell: '.sh',
    };

    if (map[kind]) return map[kind];

    const s = String(content || '').trimStart().toLowerCase();
    if (s.startsWith('<svg')) return '.svg';
    if (s.startsWith('<!doctype html') || s.startsWith('<html')) return '.html';

    return '.md';
  }

  // ============================================================
  // Endpoints
  // ============================================================
  //
  // Placeholders ({org}, {project}, {channel}, {session}, {thread}, {chat})
  // are filled in at runtime.
  //
  // `standard` = claude.ai/project/<uuid> projects. These are exactly the
  // routes this script always used, so those exports are unchanged.
  //
  // `code` = claude.ai/code/project/chan_... workspaces, which Claude Code calls
  // "channels". They live on a completely separate /v1/code/ API, so they get
  // their own routes (below) rather than the /api/organizations/ ones. These
  // paths were taken from the requests claude.ai's own /code/ page makes.
  // At export time the channel list and timeline are tried first as written,
  // then as the same request seen in this tab's network log (in case the
  // query string differs); the console prints a table of which was used and,
  // for any that failed, the reason the server gave. If the whole /code/
  // export stops working, read that reason first. A 404 means Anthropic has
  // changed a path: open a /code/ workspace, DevTools -> Network, reload, and
  // update the lines below to match, putting {channel}/{session}/{thread}
  // where the IDs appear. A 400 means the path is fine and the request is
  // missing something (see V1_HEADERS).

  const ENDPOINTS = {
    standard: {
      list: `${API}/organizations/{org}/projects?include_harmony_projects=true&limit=100`,
      project: `${API}/organizations/{org}/projects/{project}`,
      memory: `${API}/organizations/{org}/memory?project_uuid={project}`,
      docs: `${API}/organizations/{org}/projects/{project}/docs`,
      files: `${API}/organizations/{org}/projects/{project}/files`,
      conversations: `${API}/organizations/{org}/projects/{project}/conversations`,
      chat:
        `${API}/organizations/{org}/chat_conversations/{chat}` +
        '?tree=True&rendering_mode=messages&render_all_tools=true&consistency=eventual',
      // Base for the per-chat /list-files and /download-file routes.
      chatFiles: `${API}/organizations/{org}/conversations/{chat}/wiggle`,
      // One uploaded file (a picture or PDF in the project's knowledge, or
      // one attached to a chat message), exactly as it was uploaded. The
      // addresses inside a file's own record lead only to copies Claude made
      // of it: a small preview picture, a PDF rendering, a thumbnail.
      fileContents: `${API}/organizations/{org}/files/{file}/contents`,
    },

    // /code/ workspaces are "channels" on a separate /v1/code/ API that has
    // nothing to do with /api/organizations/. These routes were read from the
    // requests claude.ai's own /code/ page makes (DevTools -> Network). They
    // need no {org}, but they do need the header in V1_HEADERS. If Anthropic
    // changes them, update these lines; the format is the request path after
    // "claude.ai", with IDs swapped for {channel}, {session} or {thread}.
    // Lists page with ?cursor=<next_cursor>; `limit` may not exceed 200 on
    // channel routes or 500 on events.
    code: {
      // Lists the channels the user is in; the one whose id is {channel} is
      // this workspace, with its members.
      channels: '/v1/code/channels?scope=joined&include_members=true&include_archived=true&limit=200',
      // This one channel, for when the list above doesn't include it.
      channel: '/v1/code/channels/{channel}',
      // The channel's settings, including its instructions.
      config: '/v1/code/channels/{channel}/config',
      // Every top-level message in the channel, newest first.
      timeline: '/v1/code/channels/{channel}/timeline?limit=200',
      // Filtered views of the same timeline. They are fetched as well because
      // they return threads the plain view leaves out (ones not shown in the
      // channel's main feed). On its own, bound_only=true returns only the
      // few messages that started a session.
      timelineViews: ['bound_only=true', 'thread_roots_only=true'],
      // One message and all of its replies, oldest first.
      thread: '/v1/code/channels/{channel}/threads/{thread}?limit=200',
      // A single Claude Code session (one run): its summary card only.
      session: '/v1/code/sessions/{session}',
      // What happened in that session, step by step: its transcript.
      events: '/v1/code/sessions/{session}/events?limit=500&sort_order=asc',
      // The project's own files. Both are POSTs that only read: the first
      // lists every file, the second returns one file's bytes.
      filesList: '/v1/code/channels/{channel}/files:list',
      filesOpen: '/v1/code/channels/{channel}/files:open',
    },
  };

  // How much of each Claude Code session's step-by-step log a /code/ export
  // saves. The logs are by far the largest and slowest part of such an
  // export; everything else is saved whichever is chosen.
  //   'full'      a readable transcript (.md) and the complete raw log
  //               (.events.json), which can run to hundreds of megabytes
  //   'readable'  the readable transcript only: as slow, far smaller
  //   'none'      neither, just each session's summary card: much the fastest
  const SESSION_LOGS = 'full';

  // Every export writes this file at the top of its folder, once everything
  // it lists has been saved. It holds what an import needs in one
  // machine-readable place (name, description, instructions, settings, and
  // where each file and saved conversation is), so the importer never has to
  // guess from folder and file names.
  const MANIFEST = 'export.json';

  function manifestFor(kind, id) {
    return {
      format: 'claude-project-export',
      version: 1,
      kind,
      exported_at: new Date().toISOString(),
      source: { id },
    };
  }

  // Fills the {name} placeholders found in `vars`; leaves the rest for later.
  function fill(template, vars) {
    if (!template) return null;

    return template.replace(/\{(\w+)\}/g, (whole, key) =>
      Object.hasOwn(vars, key) ? encodeURIComponent(vars[key]) : whole
    );
  }

  // ============================================================
  // Workspace IDs and URLs
  // ============================================================

  // claude.ai/project/<uuid>               standard project
  // claude.ai/code/project/chan_<base62>   /code/ workspace
  // Either ID style is accepted on either path, and the optional "s"
  // (/projects/) from the old pattern still works.
  const WORKSPACE_PATH =
    /\/(?:(code)\/)?projects?\/([0-9a-f-]{20,}|[a-z]+_[0-9a-z]{8,})(?=\/|$)/i;

  const CODE_ID = /^chan_/i;

  function workspaceFromUrl(pathname = location.pathname) {
    const m = pathname.match(WORKSPACE_PATH);
    if (!m) return null;

    const id = m[2];
    return { id, kind: (m[1] || CODE_ID.test(id)) ? 'code' : 'standard' };
  }

  // Standard projects and chats carry `uuid`; /code/ ones may only carry
  // `id`. The old `project?.uuid` check silently dropped anything without it.
  function idOf(obj) {
    for (const v of [obj?.uuid, obj?.id]) {
      if (typeof v === 'string' && v) return v;
    }
    return null;
  }

  // List responses may be a bare array or wrapped in an object.
  function findList(v) {
    if (Array.isArray(v)) return v;

    for (const key of [
      'data', 'items', 'results',
      'conversations', 'chats', 'sessions',
      'channels', 'threads', 'timeline', 'events', 'messages',
    ]) {
      if (Array.isArray(v?.[key])) return v[key];
    }

    return null;
  }

  // ============================================================
  // Requests the claude.ai page already made
  // ============================================================

  // fetch()/XHR calls are recorded in the browser's Resource Timing buffer
  // with their full URL. This returns the same-origin ones (path + query)
  // that mention `id`. The buffer has a size limit, so reloading the
  // workspace page right before running the script gives the best view.
  function pageRequestsMentioning(id) {
    const found = new Set();

    for (const entry of performance.getEntriesByType('resource')) {
      if (!['fetch', 'xmlhttprequest'].includes(entry.initiatorType)) continue;
      if (!entry.name.includes(id)) continue;

      let url;
      try {
        url = new URL(entry.name);
      } catch {
        continue;
      }

      if (url.origin === location.origin) found.add(url.pathname + url.search);
    }

    return [...found];
  }

  const SLOT_HINTS = {
    conversations: /conversation|chat|session|thread|timeline/i,
    docs: /^docs?$/i,
    files: /^files?$/i,
    memory: /^memor(y|ies)$/i,
  };

  // Which standard ENDPOINTS entry does an observed request fill? Only
  // collection-level URLs count: .../<id> is the workspace itself, and
  // .../<id>/<collection> or .../<collection>?...=<id> is one of its lists.
  // Used only for uuid-style projects reached off their own page.
  function slotForRequest(path, id) {
    const url = new URL(path, location.origin);
    const segs = url.pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] || '';

    if (last === id) return 'project';

    const owned =
      segs[segs.length - 2] === id ||
      (!segs.includes(id) && url.search.includes(id));

    if (!owned) return null;

    return Object.keys(SLOT_HINTS).find(slot => SLOT_HINTS[slot].test(last)) || null;
  }

  // ============================================================
  // Requests to the /v1/ API
  // ============================================================

  // Every /v1/ request has to carry an anthropic-version header. Without it
  // the API refuses any path at all with
  //   400 {"error":{"message":"anthropic-version: header is required"}}
  // which is why the /code/ routes used to come back "Bad Request" even
  // though the paths were right. (The /api/organizations/ routes don't need
  // it, so fetchJSON above is unchanged.)
  const V1_HEADERS = {
    Accept: 'application/json',
    'anthropic-version': '2023-06-01',
  };

  // Failures worth waiting out and trying again, and how long to wait
  // before each retry when the server doesn't say.
  const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
  const RETRY_WAITS = [2000, 5000, 15000];

  // The server's own explanation for refusing a request, on one line.
  // Error bodies look like {"error":{"message":"...","reason":"..."}}.
  function refusalReason(status, bodyText) {
    let detail = '';

    try {
      const err = JSON.parse(bodyText)?.error;
      detail = [err?.message, err?.reason]
        .filter(s => typeof s === 'string' && s)
        .join(' \u2014 ');
    } catch {}

    if (!detail) detail = String(bodyText || '').trim().slice(0, 200);

    return `HTTP ${status}${detail ? `: ${detail}` : ''}`;
  }

  // Requests a /v1/ URL as JSON without ever throwing. Resolves to
  //   { ok: true, data }   or   { ok: false, status, why }
  // where `why` is the server's reason. Rate limits, server hiccups and
  // dropped connections are retried a few times first.
  //
  // With `post`, that object is sent as the body of a POST. The only POSTs
  // this script makes are ones that read (files:list and files:open), so
  // repeating one is as safe as repeating a GET.
  async function v1Request(url, { post, timeoutMs = 60000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const canRetry = attempt < RETRY_WAITS.length;
      let wait = RETRY_WAITS[attempt];
      let why;

      try {
        const r = await fetch(url, {
          credentials: 'include',
          headers: V1_HEADERS,
          ...(post !== undefined && {
            method: 'POST',
            headers: { ...V1_HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify(post),
          }),
          signal: ctrl.signal,
        });

        if (r.ok) {
          if (!/json/i.test(r.headers.get('content-type') || '')) {
            return {
              ok: false,
              status: r.status,
              why: `HTTP ${r.status}, but the reply was not JSON`,
            };
          }

          return { ok: true, status: r.status, data: await r.json() };
        }

        why = refusalReason(r.status, await r.text().catch(() => ''));

        if (!RETRY_STATUS.has(r.status) || !canRetry) {
          return { ok: false, status: r.status, why };
        }

        const retryAfter = Number(r.headers.get('retry-after'));
        if (retryAfter > 0) wait = Math.min(retryAfter, 60) * 1000;
      } catch (e) {
        why = ctrl.signal.aborted
          ? `no reply within ${Math.round(timeoutMs / 1000)} seconds`
          : `network error (${e?.message || e})`;

        if (!canRetry) return { ok: false, status: 0, why };
      } finally {
        clearTimeout(timer);
      }

      console.warn(
        `Claude exporter: ${why}. Trying again in ${Math.round(wait / 1000)} s: ${url}`
      );
      await sleep(wait);
    }
  }

  // The same request for callers that want an exception on failure.
  async function v1JSON(url, options) {
    const res = await v1Request(url, options);
    if (!res.ok) throw new Error(`${res.why}\n${url}`);
    return res.data;
  }

  // { url, source, data } for the first candidate whose JSON passes `accept`.
  // Every candidate that fails adds a line to `problems` saying why.
  async function firstWorking(candidates, accept, problems = []) {
    const tried = new Set();

    for (const c of candidates) {
      if (!c.url || tried.has(c.url)) continue;
      tried.add(c.url);

      const res = await v1Request(c.url);
      if (res.ok && accept(res.data)) return { ...c, data: res.data };

      problems.push(
        `${res.ok ? 'unexpected reply (not the list that was asked for)' : res.why}  \u2190  ${c.url}`
      );
    }

    return null;
  }

  // ============================================================
  // Walking /code/ channel data
  // ============================================================

  // The /v1/code/ responses are undocumented, so instead of assuming field
  // names, this walks whatever JSON comes back and pulls out every id with a
  // known prefix. That's how the export finds the sessions and threads to
  // fetch, wherever in the structure they live.
  //
  // The token after the prefix must be ULID-length (20+ alphanumerics) so
  // enum values that share a prefix - "session_started", "thread_ref" - are
  // not mistaken for IDs. The captured IDs are all 24+ chars starting "01".
  //
  // Sessions go by two prefixes. Channel data refers to them as cse_<ULID>
  // (bound_sessions, author_session_id, channel_session_id); the page's own
  // requests ask for the same session as session_<ULID>. /v1/code/sessions/
  // answers to either spelling.
  const ID_PREFIX = /^(session|cse|cmsg|trig|chan)_[0-9A-Za-z]{20,}$/;
  const SESSION_PREFIXES = ['cse', 'session'];

  // Adds every session id found anywhere in `value` to `into`, a Map keyed
  // by the ULID so cse_X and session_X count as the one session they are.
  function noteSessions(value, into) {
    for (const id of collectIds(value, SESSION_PREFIXES)) {
      const ulid = id.slice(id.indexOf('_') + 1);
      if (!into.has(ulid)) into.set(ulid, id);
    }

    return into;
  }

  // Single objects come back inside a one-key envelope, and the key varies
  // by route: {"channel":{...}}, {"config":{...}}, and for a session
  // {"response_shape":{...}}. This returns the object inside.
  function unwrap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

    const keys = Object.keys(value);
    if (keys.length !== 1) return value;

    const inner = value[keys[0]];
    return inner && typeof inner === 'object' && !Array.isArray(inner)
      ? inner
      : value;
  }

  function collectIds(value, wanted, out = new Set(), seen = new Set()) {
    if (value == null || typeof value !== 'object') {
      if (typeof value === 'string') {
        const m = value.match(ID_PREFIX);
        if (m && wanted.includes(m[1])) out.add(value);
      }
      return out;
    }

    if (seen.has(value)) return out;
    seen.add(value);

    for (const v of Array.isArray(value) ? value : Object.values(value)) {
      collectIds(v, wanted, out, seen);
    }

    return out;
  }

  // Finds this workspace's own record inside the channels-list response,
  // matching on the channel id wherever it sits.
  function channelRecord(channelsData, channelId) {
    const list = findList(channelsData) || [];

    const direct = list.find(c => idOf(c) === channelId);
    if (direct) return direct;

    // Fall back to any list element that mentions the id anywhere.
    return list.find(c => collectIds(c, ['chan']).has(channelId)) || null;
  }

  // Where a list response says its next page starts, or '' on the last page.
  // The /v1/code/ lists send a top-level `next_cursor` while more rows
  // exist and simply leave it out at the end.
  function nextCursorOf(data) {
    for (const v of [
      data?.next_cursor,
      data?.cursor?.next,
      data?.pagination?.next_cursor,
      data?.next,
    ]) {
      if (typeof v === 'number') return String(v);
      if (typeof v === 'string' && v && v !== 'null') return v;
    }

    return '';
  }

  // Walks a paginated /v1/ list from `firstUrl`, handing each page to
  // `onPage` as it arrives so a long list never has to sit in memory.
  // Resolves to { pages, complete }; `complete` is false if it had to stop
  // early. A page can be empty and still have a successor (the filtered
  // timeline views do this), so only the cursor decides when to stop.
  async function eachPage(firstUrl, label, onPage, maxPages = 5000) {
    const seen = new Set();
    let url = firstUrl;
    let pages = 0;

    while (url) {
      let data;
      try {
        data = await v1JSON(absUrl(url));
      } catch (e) {
        if (!pages) throw e;
        console.warn(`Stopped paging ${label} after an error`, e);
        return { pages, complete: false };
      }

      pages++;
      await onPage(data);

      const cursor = nextCursorOf(data);
      if (!cursor) return { pages, complete: true };

      // The same cursor twice means the server ignored it: stop, don't loop.
      if (seen.has(cursor) || pages >= maxPages) {
        console.warn(`Stopped paging ${label} after ${pages} page(s)`);
        return { pages, complete: false };
      }
      seen.add(cursor);

      // A cursor may come back as a full URL or as a token to add.
      url = /^https?:|^\//.test(cursor)
        ? cursor
        : `${firstUrl}${firstUrl.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`;
    }

    return { pages, complete: true };
  }

  // The whole of a paginated list, for lists small enough to hold at once.
  // Resolves to { pages, rows, complete }.
  async function fetchAllPages(firstUrl, label) {
    const pages = [];
    const { complete } = await eachPage(firstUrl, label, data => {
      pages.push(data);
    });

    return {
      pages,
      rows: pages.flatMap(page => findList(page) || []),
      complete,
    };
  }

  // ============================================================
  // Endpoint resolution
  // ============================================================

  async function resolveEndpoints(sel) {
    const std = ENDPOINTS.standard;

    // Standard uuid projects: the same requests this script always made.
    if (sel.kind !== 'code') {
      const vars = { org: sel.org.uuid, project: sel.id };

      const seen = {};
      for (const path of pageRequestsMentioning(sel.id)) {
        const slot = slotForRequest(path, sel.id);
        if (slot) (seen[slot] ||= []).push(path);
      }

      // `seen` is computed for parity with the previous version and to keep
      // the standard-project fallbacks available, even though the standard
      // routes below are used directly, exactly as the original script did.
      void seen;

      return {
        mode: 'standard',
        project: fill(std.project, vars),
        memory: fill(std.memory, vars),
        docs: fill(std.docs, vars),
        files: fill(std.files, vars),
        conversations: fill(std.conversations, vars),
        chat: [fill(std.chat, vars)],
        chatFiles: fill(std.chatFiles, vars),
        fileContents: fill(std.fileContents, vars),
      };
    }

    // /code/ channel workspaces use the dedicated /v1/code/ API.
    const cfg = ENDPOINTS.code;
    const cvars = { channel: sel.id };
    const used = {};
    const problems = []; // why each failed request was refused

    // Channel metadata comes from the channels list, which also carries the
    // members. The page may have already fetched it.
    const channelsHit = await firstWorking(
      [
        { url: fill(cfg.channels, cvars), source: 'ENDPOINTS.code.channels' },
        ...pageRequestsMentioning('/v1/code/channels')
          .filter(p => !p.includes('/channels/'))
          .map(url => ({ url, source: 'seen on this page' })),
      ],
      v => findList(v) !== null,
      problems
    );

    const channelsData = channelsHit?.data ?? null;
    let record = channelsData ? channelRecord(channelsData, sel.id) : null;
    used.channels = channelsHit
      ? `${channelsHit.url}  (${channelsHit.source})`
      : 'not found';

    // The list stops at 200 joined channels, so a channel missing from it
    // is asked for by itself.
    if (!record) {
      const url = fill(cfg.channel, cvars);
      const res = await v1Request(url);
      const channel = res.ok ? unwrap(res.data) : null;

      if (channel && idOf(channel) === sel.id) {
        record = channel;
        used.channel = `${url}  (ENDPOINTS.code.channel)`;
      } else {
        used.channel = 'not found';
        problems.push(`${res.ok ? 'unexpected reply' : res.why}  \u2190  ${url}`);
      }
    }

    // Timeline: the ordered activity for this channel.
    const timelineUrl = fill(cfg.timeline, cvars);
    const timelineHit = await firstWorking(
      [
        { url: timelineUrl, source: 'ENDPOINTS.code.timeline' },
        ...pageRequestsMentioning(sel.id)
          .filter(p => /\/timeline(\?|$)/.test(p))
          .map(url => ({ url, source: 'seen on this page' })),
      ],
      v => v != null,
      problems
    );

    used.timeline = timelineHit
      ? `${timelineHit.url}  (${timelineHit.source})`
      : 'not found';

    const sessionTemplate = cfg.session; // /v1/code/sessions/{session}
    const threadTemplate = fill(cfg.thread, cvars); // .../threads/{thread}
    used.session = sessionTemplate;
    used.thread = threadTemplate;
    used.events = cfg.events;

    console.log(`Claude exporter: routes used for ${sel.id}`);
    console.table(used);

    if (problems.length) {
      console.warn(
        'Claude exporter: the server refused these requests:\n' +
        problems.map(p => `  ${p}`).join('\n')
      );
    }

    return {
      mode: 'code',
      channelId: sel.id,
      used,
      problems,
      channelsData,
      record,
      timelineFirstUrl: timelineHit ? timelineHit.url : timelineUrl,
      timelineReachable: !!timelineHit,
      sessionTemplate,
      threadTemplate,
    };
  }

  // Tries each chat route in turn (standard projects only). The first one
  // that works moves to the front, so the rest of the export goes straight
  // to it.
  async function fetchChat(routes, chatId) {
    let lastError = null;

    for (const route of [...routes]) {
      try {
        const raw = await fetchJSON(fill(route, { chat: chatId }));
        routes.splice(routes.indexOf(route), 1);
        routes.unshift(route);
        return raw;
      } catch (e) {
        lastError = e;
      }
    }

    throw lastError || new Error(`No chat route for ${chatId}`);
  }

  // ============================================================
  // Project discovery
  // ============================================================

  async function discoverProjects() {
    const orgs = asArray(await fetchJSON(`${API}/organizations`))
      .filter(org => org?.uuid);

    const found = [];

    // An account that also uses the developer API has a second, API-only
    // organization (capabilities: api, no chat). It has no claude.ai
    // projects, and asking for them is always refused with
    // 403 "Invalid authorization for organization", so it isn't asked.
    const apiOnly = org =>
      Array.isArray(org.capabilities) &&
      org.capabilities.includes('api') &&
      !org.capabilities.includes('chat');

    for (const org of orgs) {
      if (apiOnly(org)) {
        console.log(
          `Claude exporter: skipping "${org.name || org.uuid}", an API-only ` +
          'organization with no claude.ai projects.'
        );
        continue;
      }

      for (const [listKind, template] of [
        ['standard', ENDPOINTS.standard.list],
        ['code', ENDPOINTS.code.list],
      ]) {
        if (!template) continue;

        try {
          const data = await fetchJSON(fill(template, { org: org.uuid }));

          for (const project of findList(data) || []) {
            const id = idOf(project);
            if (!id || found.some(x => x.id === id && x.org === org)) continue;

            const kind = listKind === 'code' || CODE_ID.test(id) ? 'code' : 'standard';
            found.push({ org, project, id, kind });
          }
        } catch (e) {
          console.warn(`Could not list ${listKind} projects for org`, org.uuid, e);
        }
      }
    }

    return { orgs, projects: found };
  }

  // A workspace taken from the URL has no org yet. The API calls claude.ai
  // made for it contain /organizations/<org>/, so that's used when present;
  // otherwise the only org, or ask. Kept synchronous so the folder picker
  // still opens inside the click's user gesture.
  function orgForWorkspace(id, orgs) {
    if (!orgs.length) throw new Error('No Claude organizations found.');

    for (const path of pageRequestsMentioning(id)) {
      const orgId = path.match(/\/organizations\/([^/?#]+)/)?.[1];
      const org = orgs.find(o => o.uuid === orgId);
      if (org) return org;
    }

    if (orgs.length === 1) return orgs[0];

    const list = orgs.map((o, i) => `${i + 1}. ${o.name || o.uuid}`).join('\n');
    const answer = prompt(`Which organization is ${id} in?\n\n${list}\n\nEnter a number:`, '1');
    if (answer == null) return null;

    const org = orgs[Number(answer) - 1];
    if (!org) throw new Error('Invalid organization number.');
    return org;
  }

  function chooseProject(projects) {
    const here = workspaceFromUrl();
    if (here) {
      const match = projects.find(x => x.id === here.id);
      if (match) return match;

      // A /code/ workspace open in this tab is exported even when no listing
      // returned it. Its org is filled in after this returns.
      if (here.kind === 'code') {
        return { org: null, project: { id: here.id }, id: here.id, kind: here.kind };
      }
    }

    if (!projects.length) throw new Error('No Claude projects found.');
    if (projects.length === 1) return projects[0];

    const list = projects
      .map((x, i) => {
        const name = x.project.name || '(unnamed project)';
        return `${i + 1}. ${name}${x.kind === 'code' ? '  [code]' : ''}`;
      })
      .join('\n');

    const answer = prompt(
      `Which project should be exported?\n\n${list}\n\nEnter a number:`,
      '1'
    );

    if (answer == null) return null;

    const idx = Number(answer) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= projects.length) {
      throw new Error('Invalid project number.');
    }

    return projects[idx];
  }

  // ============================================================
  // Conversation tree
  // ============================================================

  function activeBranch(messages, leafUuid) {
    if (!leafUuid || !Array.isArray(messages)) return messages || [];

    const byId = new Map(
      messages
        .filter(m => m?.uuid)
        .map(m => [m.uuid, m])
    );

    const branch = [];
    const seen = new Set();
    let id = leafUuid;

    while (id && byId.has(id) && !seen.has(id)) {
      seen.add(id);
      const m = byId.get(id);
      branch.push(m);
      id = m.parent_message_uuid;
    }

    return branch.length ? branch.reverse() : messages;
  }

  function extractedTextItems(message) {
    const out = [];

    for (const obj of [
      ...asArray(message?.attachments),
      ...asArray(message?.files),
    ]) {
      if (
        typeof obj?.extracted_content === 'string' &&
        obj.extracted_content.length
      ) {
        out.push({
          name: obj.file_name || obj.name || 'Attached text',
          text: obj.extracted_content,
        });
      }
    }

    return out;
  }

  // ============================================================
  // Citations / sources
  // ============================================================

  function citationLinesFromCitation(c) {
    const lines = [];
    if (!c || typeof c !== 'object') return lines;

    if (c.url) {
      const title = firstString(c.title, c.name, c.url);
      const via = c.origin_tool_name ? ` \u2014 via ${c.origin_tool_name}` : '';
      lines.push(`- [${title}](${c.url})${via}`);
    }

    for (const src of asArray(c.sources)) {
      if (typeof src === 'string') {
        lines.push(`- ${src}`);
      } else if (src && typeof src === 'object') {
        if (src.url) {
          const title = firstString(src.title, src.name, src.url);
          lines.push(`- [${title}](${src.url})`);
        }
      }
    }

    if (!c.url) {
      const docTitle = firstString(
        c.document_title,
        c.title,
        c.file_name,
        c.document_id,
        c.file_id
      );

      if (docTitle) {
        let loc = '';

        if (Number.isFinite(c.page_number)) {
          loc = ` \u2014 page ${c.page_number}`;
        } else if (
          Number.isFinite(c.start_page_number) ||
          Number.isFinite(c.end_page_number)
        ) {
          const a = c.start_page_number ?? c.end_page_number;
          const b = c.end_page_number ?? c.start_page_number;
          loc = a === b ? ` \u2014 page ${a}` : ` \u2014 pages ${a}\u2013${b}`;
        } else if (
          Number.isFinite(c.start_index) ||
          Number.isFinite(c.end_index)
        ) {
          const a = c.start_index ?? '?';
          const b = c.end_index ?? '?';
          loc = ` \u2014 characters ${a}\u2013${b}`;
        } else if (
          Number.isFinite(c.start_char_index) ||
          Number.isFinite(c.end_char_index)
        ) {
          const a = c.start_char_index ?? '?';
          const b = c.end_char_index ?? '?';
          loc = ` \u2014 characters ${a}\u2013${b}`;
        }

        lines.push(`- ${docTitle}${loc}`);
      }
    }

    return lines;
  }

  function collectMessageSourceLines(message) {
    const lines = [];

    for (const b of asArray(message?.content)) {
      if (b?.type !== 'text') continue;

      for (const c of asArray(b.citations)) {
        lines.push(...citationLinesFromCitation(c));
      }
    }

    return [...new Set(lines)];
  }

  // ============================================================
  // Markdown chat
  // ============================================================

  function renderChatMarkdown(conversation, messages, projectName) {
    const title =
      conversation.name ||
      conversation.title ||
      'Untitled chat';

    const created =
      conversation.created_at ||
      messages[0]?.created_at ||
      '';

    const md = [
      `# ${title}`,
      '',
      `Project: ${projectName}`,
      '',
    ];

    if (created) md.push(`Created: ${iso(created)}`, '');

    for (const m of messages) {
      const who = m.sender === 'human' ? 'User' : 'Claude';
      const ts = iso(m.created_at);

      md.push(`## ${who}${ts ? ` \u2014 ${ts}` : ''}`, '');

      const blocks = Array.isArray(m.content) ? m.content : [];
      let wroteText = false;

      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;

        if (
          b.type === 'text' &&
          typeof b.text === 'string' &&
          b.text.length
        ) {
          md.push(b.text, '');
          wroteText = true;
        }
      }

      if (
        !wroteText &&
        typeof m.text === 'string' &&
        m.text.length
      ) {
        md.push(m.text, '');
      }

      const extracted = extractedTextItems(m);
      const extractedNames = new Set(extracted.map(x => x.name));

      for (const item of extracted) {
        md.push(
          `### Attached text \u2014 ${item.name}`,
          '',
          fencedText(item.text),
          ''
        );
      }

      const names = new Set();

      for (const a of asArray(m.attachments)) {
        if (a?.file_name) names.add(a.file_name);
      }

      for (const f of asArray(m.files)) {
        if (f?.file_name) names.add(f.file_name);
      }

      for (const name of names) {
        if (!extractedNames.has(name)) {
          md.push(`> Attachment: ${name}`, '');
        }
      }

      if (m.sender !== 'human') {
        const sources = collectMessageSourceLines(m);

        if (sources.length) {
          md.push(
            '### Sources',
            '',
            ...sources,
            ''
          );
        }
      }

      if (m.compaction_summary) {
        const summary =
          typeof m.compaction_summary === 'string'
            ? m.compaction_summary
            : firstString(
                m.compaction_summary.summary,
                m.compaction_summary.text,
                m.compaction_summary.content
              );

        if (summary) {
          md.push(
            '### Claude compaction summary',
            '',
            summary,
            ''
          );
        }
      }
    }

    return md
      .join('\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim() + '\n';
  }

  // ============================================================
  // Reconstruct final Claude artifacts
  // ============================================================

  function replaceExactlyOnce(text, oldStr, newStr) {
    const first = text.indexOf(oldStr);
    if (first < 0) return { ok: false, text, reason: 'old_str not found' };

    const second = text.indexOf(oldStr, first + oldStr.length);

    if (second >= 0) {
      return {
        ok: false,
        text,
        reason: 'old_str appears more than once',
      };
    }

    return {
      ok: true,
      text:
        text.slice(0, first) +
        newStr +
        text.slice(first + oldStr.length),
    };
  }

  function replayArtifacts(messages) {
    const artifacts = new Map();
    let anonymousCounter = 0;

    for (const m of messages) {
      for (const block of asArray(m?.content)) {
        if (
          block?.type !== 'tool_use' ||
          block?.name !== 'artifacts' ||
          !block.input ||
          typeof block.input !== 'object'
        ) {
          continue;
        }

        const input = block.input;
        const command = String(input.command || 'create').toLowerCase();

        let id = firstString(
          input.id,
          input.artifact_id,
          input.uuid,
          input.version_uuid
        );

        if (!id) {
          id = `anonymous-artifact-${++anonymousCounter}`;
        }

        let state = artifacts.get(id);

        if (!state) {
          state = {
            id,
            title: firstString(input.title, id),
            type: firstString(input.type, input.mime_type),
            language: firstString(input.language),
            content: '',
            warnings: [],
          };

          artifacts.set(id, state);
        }

        if (input.title) state.title = input.title;
        if (input.type) state.type = input.type;
        if (input.mime_type) state.type = input.mime_type;
        if (input.language) state.language = input.language;

        if (command === 'create') {
          if (typeof input.content === 'string') {
            state.content = input.content;
          } else if (typeof input.new_str === 'string') {
            state.content = input.new_str;
          }

          continue;
        }

        if (command === 'rewrite') {
          if (typeof input.content === 'string') {
            state.content = input.content;
          } else if (typeof input.new_str === 'string') {
            state.content = input.new_str;
          } else {
            state.warnings.push(
              'rewrite command had no content/new_str'
            );
          }

          continue;
        }

        if (command === 'update') {
          if (
            typeof input.old_str === 'string' &&
            typeof input.new_str === 'string'
          ) {
            const replaced = replaceExactlyOnce(
              state.content,
              input.old_str,
              input.new_str
            );

            if (replaced.ok) {
              state.content = replaced.text;
            } else if (typeof input.content === 'string') {
              state.content = input.content;

              state.warnings.push(
                `update patch could not be applied (${replaced.reason}); used full content fallback`
              );
            } else {
              state.warnings.push(
                `update patch could not be applied: ${replaced.reason}`
              );
            }
          } else if (typeof input.content === 'string') {
            state.content = input.content;
          } else {
            state.warnings.push(
              'update command had no usable patch/content'
            );
          }

          continue;
        }

        if (typeof input.content === 'string') {
          state.content = input.content;

          state.warnings.push(
            `unknown command "${command}"; used supplied content`
          );
        } else {
          state.warnings.push(
            `unknown command "${command}"`
          );
        }
      }
    }

    return [...artifacts.values()]
      .filter(a => a.content.length);
  }

  async function saveReconstructedArtifacts(
    messages,
    outputsDir,
    outputUnique
  ) {
    const artifacts = replayArtifacts(messages);

    for (const artifact of artifacts) {
      const stem = safeName(
        artifact.title ||
        artifact.id ||
        'artifact'
      );

      const ext = inferArtifactExtension(
        {
          type: artifact.type,
          language: artifact.language,
        },
        artifact.content
      );

      const filename =
        /\.[A-Za-z0-9]{1,10}$/.test(stem)
          ? stem
          : `${stem}${ext}`;

      await writeText(
        outputsDir,
        outputUnique(filename),
        artifact.content
      );

      if (artifact.warnings.length) {
        console.warn(
          `Artifact "${artifact.title}" reconstructed with warnings:`,
          artifact.warnings
        );
      }
    }
  }

  // ============================================================
  // Project-level context and files
  // ============================================================

  // The size a file's record gives for it, or null when it gives none.
  function knownSize(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) && value >= 0 ? value : null;
    }

    return typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : null;
  }

  // Where to download an uploaded file itself, as the first place to try
  // (see ENDPOINTS.standard.fileContents). `bytes` is the size the file's
  // record gives, so the download can be checked against it.
  function originalFile(endpoints, record) {
    const id = firstString(record?.file_uuid, record?.uuid);

    return {
      url: id ? fill(endpoints.fileContents, { file: id }) : null,
      label: '',
      original: true,
      bytes: knownSize(record?.size_bytes),
    };
  }

  // Whether a download can be the file it was asked for. Nothing at all,
  // for a file whose record says it is not empty, is not that file; the
  // next address is tried instead. Any other difference in size is kept,
  // and mentioned in the console.
  function looksWhole(blob, candidate, name) {
    if (candidate.bytes == null || blob.size === candidate.bytes) return true;

    console.warn(
      `"${name}" is ${candidate.bytes} bytes according to Claude, but ` +
      `${blob.size} bytes were downloaded.`
    );

    return blob.size > 0;
  }

  async function exportProjectContextAndFiles(
    endpoints,
    projectRoot,
    filesDir
  ) {
    // Standard projects make the same four requests as the original script.
    // (/code/ channels never reach here; they go through exportCodeChannel.)
    const [
      project,
      memory,
      docsRaw,
      filesRaw,
    ] = await Promise.all([
      fetchJSON(endpoints.project),
      fetchJSON(endpoints.memory, true),
      fetchJSON(endpoints.docs, true),
      fetchJSON(endpoints.files, true),
    ]);

    const instructions = firstString(
      project?.prompt_template,
      project?.instructions,
      project?.project_instructions
    );

    const description = firstString(
      project?.description,
      project?.summary,
      project?.project_description
    );

    await writeText(
      projectRoot,
      'Project Instructions.md',
      instructions ||
      '(No project instructions were returned by Claude.)\n'
    );

    await writeText(
      projectRoot,
      'Project Memory.md',
      memoryText(memory) ||
      '(No project memory was returned by Claude.)\n'
    );

    await writeText(
      projectRoot,
      'Project Description.md',
      description ||
      '(No project description was returned by Claude.)\n'
    );

    const docs = asArray(docsRaw);
    const files = asArray(filesRaw);

    const unique = makeUniqueNamer();
    const saved = []; // every file written to Files/, for the manifest

    for (const f of files) {
      const sourceName =
        f.file_name ||
        f.name ||
        `file-${f.file_uuid || f.uuid || 'unknown'}`;

      // Best first: the file itself, then the copies Claude made of it.
      const candidates = [
        originalFile(endpoints, f),
        {
          url: f.download_url,
          label: '',
          original: true,
        },
        {
          url: f.original_url,
          label: '',
          original: true,
        },
        {
          url: f.original_asset?.url,
          label: '',
          original: true,
        },
        {
          url: f.document_asset?.url,
          label: ' [Claude representation]',
          original: false,
        },
        {
          url: f.preview_asset?.url,
          label: ' [Claude preview]',
          original: false,
        },
        {
          url: f.preview_url,
          label: ' [Claude preview]',
          original: false,
        },
        {
          url: f.thumbnail_asset?.url,
          label: ' [Claude thumbnail]',
          original: false,
        },
      ].filter(x => x.url);

      for (const candidate of candidates) {
        try {
          const blob = await fetchBlob(
            absUrl(candidate.url),
            true
          );

          if (!blob || !looksWhole(blob, candidate, sourceName)) continue;

          let target = sourceName;

          if (candidate.label) {
            const dot = target.lastIndexOf('.');

            target =
              dot > 0
                ? `${target.slice(0, dot)}${candidate.label}${target.slice(dot)}`
                : `${target}${candidate.label}${extensionFromMime(blob.type)}`;
          }

          const savedAs = unique(target);

          await writeBlob(
            filesDir,
            savedAs,
            blob
          );

          saved.push({
            path: `Files/${savedAs}`,
            name: sourceName,
            type: 'file',
            // Which copy this is: the file itself, or one Claude made of it.
            copy: candidate.original
              ? 'original'
              : candidate.label.replace(/^ \[Claude (.*)\]$/, '$1'),
            mime: blob.type || '',
          });

          break;
        } catch (e) {
          console.warn(
            `Could not download project file: ${sourceName}`,
            e
          );
        }
      }
    }

    // The project's text items. Each one is saved, including one that has
    // the same name as a file above: in the project they are two things.
    for (const doc of docs) {
      const sourceName =
        doc.file_name ||
        doc.name ||
        `project-doc-${doc.uuid || doc.id || 'unknown'}`;

      const content =
        typeof doc.content === 'string'
          ? doc.content
          : JSON.stringify(
              doc.content ?? '',
              null,
              2
            );

      if (!content) continue;

      const textLike =
        /\.(md|markdown|txt|csv|json|html|xml|yaml|yml)$/i
          .test(sourceName);

      const target =
        textLike
          ? sourceName
          : `${sourceName}.extracted.md`;

      const savedAs = unique(target);

      await writeText(
        filesDir,
        savedAs,
        content
      );

      saved.push({
        path: `Files/${savedAs}`,
        name: sourceName,
        type: 'doc',
      });
    }

    return {
      project,
      instructions,
      description,
      memory: memoryText(memory),
      files: saved,
    };
  }

  // ============================================================
  // Per-chat inputs / attachments / outputs
  // ============================================================

  async function exportChatFiles(
    endpoints,
    chatId,
    allMessages,
    activeMessages,
    attachmentsDir,
    outputsDir
  ) {
    const base =
      fill(endpoints.chatFiles, { chat: chatId });

    const attachmentUnique = makeUniqueNamer();
    const outputUnique = makeUniqueNamer();

    const rawUploads = new Set();
    const rawOutputs = new Set();

    try {
      const listing = await fetchJSON(
        `${base}/list-files?prefix=`,
        true
      );

      const metadata =
        asArray(listing?.files_metadata);

      let paths = metadata
        .map(x => x?.path)
        .filter(Boolean);

      if (!paths.length) {
        paths = asArray(
          listing?.files ||
          listing
        );
      }

      for (const path of paths) {
        if (typeof path !== 'string') continue;

        const isUpload =
          path.startsWith(
            '/mnt/user-data/uploads/'
          );

        const isOutput =
          path.startsWith(
            '/mnt/user-data/outputs/'
          );

        if (!isUpload && !isOutput) continue;

        const name =
          path.split('/').pop() ||
          'file';

        try {
          const blob = await fetchBlob(
            `${base}/download-file?path=${encodeURIComponent(path)}`,
            true
          );

          if (!blob) continue;

          if (isUpload) {
            await writeBlob(
              attachmentsDir,
              attachmentUnique(name),
              blob
            );

            rawUploads.add(
              name.toLocaleLowerCase()
            );
          } else {
            await writeBlob(
              outputsDir,
              outputUnique(name),
              blob
            );

            rawOutputs.add(
              name.toLocaleLowerCase()
            );
          }
        } catch (e) {
          console.warn(
            `Could not download workspace file: ${path}`,
            e
          );
        }
      }
    } catch (e) {
      console.warn(
        `Could not list conversation workspace files for ${chatId}`,
        e
      );
    }

    let pasteCounter = 0;

    for (const m of allMessages) {
      for (const obj of [
        ...asArray(m?.attachments),
        ...asArray(m?.files),
      ]) {
        const text =
          typeof obj?.extracted_content === 'string'
            ? obj.extracted_content
            : '';

        if (!text) continue;

        const sourceName =
          obj.file_name ||
          obj.name ||
          `Pasted text ${++pasteCounter}.txt`;

        if (
          rawUploads.has(
            sourceName.toLocaleLowerCase()
          )
        ) {
          continue;
        }

        const saveName =
          /\.[A-Za-z0-9]{1,10}$/.test(sourceName)
            ? sourceName
            : `${sourceName}.txt`;

        await writeText(
          attachmentsDir,
          attachmentUnique(saveName),
          text
        );

        rawUploads.add(
          sourceName.toLocaleLowerCase()
        );
      }
    }

    const recovered =
      new Set(rawUploads);

    for (const m of allMessages) {
      for (const obj of [
        ...asArray(m?.files),
        ...asArray(m?.attachments),
      ]) {
        const sourceName =
          obj?.file_name ||
          obj?.name ||
          '';

        const key =
          sourceName.toLocaleLowerCase();

        if (
          key &&
          recovered.has(key)
        ) {
          continue;
        }

        // Best first: the file itself, then the copies Claude made of it.
        const candidates = [
          originalFile(endpoints, obj),
          {
            url: obj?.download_url,
            label: '',
          },
          {
            url: obj?.original_url,
            label: '',
          },
          {
            url: obj?.original_asset?.url,
            label: '',
          },
          {
            url: obj?.document_asset?.url,
            label: ' [Claude representation]',
          },
          {
            url: obj?.preview_asset?.url,
            label: ' [Claude preview]',
          },
          {
            url: obj?.preview_url,
            label: ' [Claude preview]',
          },
          {
            url: obj?.thumbnail_asset?.url,
            label: ' [Claude thumbnail]',
          },
          {
            url: obj?.thumbnail_url,
            label: ' [Claude thumbnail]',
          },
        ].filter(x => x.url);

        if (!candidates.length) continue;

        for (const candidate of candidates) {
          try {
            const blob = await fetchBlob(
              absUrl(candidate.url),
              true
            );

            if (
              !blob ||
              !looksWhole(blob, candidate, sourceName || 'An attachment')
            ) {
              continue;
            }

            let name =
              sourceName ||
              `attachment-${obj?.file_uuid || obj?.id || 'unknown'}`;

            if (candidate.label) {
              const dot =
                name.lastIndexOf('.');

              name =
                dot > 0
                  ? `${name.slice(0, dot)}${candidate.label}${name.slice(dot)}`
                  : `${name}${candidate.label}`;
            }

            if (
              !/\.[A-Za-z0-9]{1,10}$/.test(name)
            ) {
              name +=
                extensionFromMime(blob.type);
            }

            await writeBlob(
              attachmentsDir,
              attachmentUnique(name),
              blob
            );

            if (key) {
              recovered.add(key);
            }

            break;
          } catch (e) {
            console.warn(
              `Could not recover message attachment: ${sourceName || '(unnamed)'}`,
              e
            );
          }
        }
      }
    }

    await saveReconstructedArtifacts(
      activeMessages,
      outputsDir,
      outputUnique
    );

    for (const m of activeMessages) {
      for (const block of asArray(m?.content)) {
        if (
          block?.type !== 'tool_use' ||
          block?.name !== 'create_file' ||
          !block.input
        ) {
          continue;
        }

        const input = block.input;

        const path = firstString(
          input.path,
          input.file_path,
          input.filename,
          input.name
        );

        const content = firstString(
          input.content,
          input.text,
          input.file_content
        );

        if (!path || !content) continue;

        const filename =
          path.split('/').pop() ||
          'generated-file.txt';

        if (
          rawOutputs.has(
            filename.toLocaleLowerCase()
          )
        ) {
          continue;
        }

        await writeText(
          outputsDir,
          outputUnique(filename),
          content
        );

        rawOutputs.add(
          filename.toLocaleLowerCase()
        );
      }
    }
  }


  // ============================================================
  // Export a /code/ channel workspace
  // ============================================================

  // Collapses text to a single line of at most `max` characters.
  function excerpt(text, max = 200) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max)}\u2026` : s;
  }

  function byCreatedAt(a, b) {
    return (Date.parse(a?.created_at) || 0) - (Date.parse(b?.created_at) || 0);
  }

  // A file that is written a piece at a time: .write(text) as often as
  // needed, then .close(). Nothing is kept in memory in between.
  async function openWriter(dir, name) {
    const handle = await dir.getFileHandle(safeName(name), { create: true });
    return handle.createWritable();
  }

  // Updates the status box without adding a line to the console, for
  // progress that changes many times a minute.
  function showProgress(text) {
    if (statusNode) statusNode.textContent = text;
  }

  // ---- channel messages as Markdown ----

  // Who wrote a channel message. `me` is the exporting member's account id.
  function authorOf(row, me) {
    if (row?.author_account_id) {
      return row.author_account_id === me
        ? 'You'
        : `Member ${String(row.author_account_id).slice(-6)}`;
    }

    if (row?.author_agent_id || row?.author_session_id) return 'Claude';
    return 'Unknown';
  }

  // The lines under a channel message that say what is attached to it.
  function messageExtras(row) {
    const lines = [];

    for (const a of asArray(row?.attachments)) {
      const name = firstString(a?.filename, a?.file_name, a?.name);
      if (name) lines.push(`> Attachment: ${name}`);
    }

    for (const o of asArray(row?.attached_outputs)) {
      const name = firstString(o?.filename, o?.path, o?.href);
      if (!name) continue;

      lines.push(
        o?.href
          ? `> Output: [${name}](${o.href})`
          : `> Output: ${firstString(o?.path, name)}`
      );
    }

    for (const s of asArray(row?.bound_sessions)) {
      const title = firstString(s?.title, s?.id);
      if (title) lines.push(`> Session: ${title}${s?.status ? ` (${s.status})` : ''}`);
    }

    return lines;
  }

  // An automatic notice carries a JSON object as its body, for example
  // {"kind":"status","text":"Reading the repository..."}. This returns its kind
  // and the text meant for people; a body in any other form comes back whole.
  function noticeParts(body) {
    try {
      const notice = JSON.parse(body);

      if (notice && typeof notice === 'object' && typeof notice.text === 'string') {
        return { kind: firstString(notice.kind) || 'notice', text: notice.text };
      }
    } catch {}

    return { kind: 'notice', text: body };
  }

  // A one-line title for a message: its opening words, with Markdown links
  // reduced to their label.
  function titleOf(body, max = 60) {
    return excerpt(String(body ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'), max);
  }

  // Readable Markdown for a run of channel messages, in the order given.
  // `ctx.me` is the exporting member's account id; `ctx.threadFiles`, when
  // present, maps a message id to the file that holds its replies.
  function renderChannelMessages(title, intro, rows, ctx = {}) {
    const md = [`# ${title}`, '', ...intro, ''];

    for (const row of rows) {
      const when = iso(row?.created_at);
      const body = typeof row?.body === 'string' ? row.body.trim() : '';

      // Automatic status lines the server adds between real messages. They
      // are set as a quote so the conversation around them stays easy to
      // follow.
      if (row?.server_notice) {
        const { kind, text } = noticeParts(body);
        const lines = text.split('\n').map(line => line.trim()).filter(Boolean);

        md.push(
          `> _${when ? `${when}, ` : ''}${kind}:_ ${lines[0] || ''}`,
          ...lines.slice(1).map(line => `> ${line}`),
          ''
        );
        continue;
      }

      md.push(
        `## ${authorOf(row, ctx.me)}${when ? ` \u2014 ${when}` : ''}`,
        '',
        body || '_(no text)_',
        ''
      );

      const extras = messageExtras(row);
      const replies = Number(row?.reply_count) || 0;
      const file = ctx.threadFiles?.get(idOf(row));

      if (file) {
        const count = replies === 1 ? '1 reply' : `${replies} replies`;
        extras.push(`> Thread${replies ? ` (${count})` : ''}: Threads/${file}`);
      } else if (replies && ctx.threadFiles) {
        extras.push(`> Replies: ${replies}`);
      }

      if (extras.length) md.push(...extras, '');
    }

    return md.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
  }

  // ---- session logs as Markdown ----

  function toolResultText(content) {
    if (typeof content === 'string') return content;

    return asArray(content)
      .map(c =>
        typeof c?.text === 'string'
          ? c.text
          : c?.type
            ? `[${c.type}]`
            : ''
      )
      .filter(Boolean)
      .join(' ');
  }

  // The top of a session's Markdown file.
  function sessionHeader(session, label) {
    const md = [`# ${label}`, ''];

    const id = idOf(session);
    if (id) md.push(`Session: ${id}`, '');

    const when = firstString(
      session?.created_at,
      session?.started_at,
      session?.inserted_at
    );
    if (when) md.push(`Created: ${iso(when)}`, '');

    return md.join('\n') + '\n';
  }

  // Readable Markdown for a batch of session events, in order. A session's
  // log is a list of events; the conversation is the ones whose event_type
  // is "user" or "assistant", each carrying a message in payload.message.
  // Those are rendered: what was said in full, and every tool call and tool
  // result cut to one line. The rest of the log (system events, hooks,
  // retries, full tool output) is left to the raw file.
  // `state` carries the open heading from one batch to the next.
  function renderSessionEvents(events, state) {
    const out = [];

    const heading = (who, when) => {
      if (state.last === 'bullet') out.push('');
      out.push(`## ${who}${when ? ` \u2014 ${when}` : ''}`, '');
      state.who = who;
      state.last = 'heading';
    };

    const paragraph = text => {
      if (state.last === 'bullet') out.push('');
      out.push(text.trim(), '');
      state.last = 'text';
    };

    const bullet = line => {
      out.push(line);
      state.last = 'bullet';
    };

    const claude = when => {
      if (state.who !== 'Claude') heading('Claude', when);
    };

    for (const ev of events) {
      const type = ev?.event_type;
      const payload = ev?.payload;
      const message = payload?.message;

      if (!message || (type !== 'user' && type !== 'assistant')) continue;

      const when = iso(ev.created_at);
      // Set on everything said inside a subagent Claude started.
      const sub = payload.parent_tool_use_id ? ' (subagent)' : '';

      const blocks =
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : asArray(message.content);

      for (const b of blocks) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          if (type === 'user' && !sub) {
            heading('User', when);
            paragraph(b.text);
          } else if (type === 'user') {
            claude(when);
            bullet(`- Task given to a subagent: ${excerpt(b.text, 300)}`);
          } else if (sub) {
            claude(when);
            bullet(`- Subagent said: ${excerpt(b.text, 300)}`);
          } else {
            claude(when);
            paragraph(b.text);
          }
        } else if (b?.type === 'tool_use') {
          claude(when);

          const input =
            typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {});

          bullet(`- Tool${sub}: \`${b.name || 'unknown'}\` ${excerpt(input, 200)}`);
        } else if (b?.type === 'tool_result') {
          claude(when);

          bullet(
            `  - ${b.is_error ? 'Error' : 'Result'}: ` +
            (excerpt(toolResultText(b.content), 200) || '(empty)')
          );
        }
      }
    }

    return out.length ? out.join('\n') + '\n' : '';
  }

  // Streams one session's log to disk a page at a time: the readable version
  // to "<stem>.md" and, when SESSION_LOGS is 'full', every event as the
  // server sent it to "<stem>.events.json" (a JSON array with one event per
  // line). A long session has tens of thousands of events, so they are
  // written as they arrive rather than collected first.
  // Resolves to { events, complete }.
  async function exportSessionLog(dir, stem, session, label, sessionId, progress) {
    const rawOut =
      SESSION_LOGS === 'full' ? await openWriter(dir, `${stem}.events.json`) : null;
    const mdOut = await openWriter(dir, `${stem}.md`);
    const state = {};
    let events = 0;
    let complete = false;

    try {
      if (rawOut) await rawOut.write('[');
      await mdOut.write(sessionHeader(session, label));

      ({ complete } = await eachPage(
        fill(ENDPOINTS.code.events, { session: sessionId }),
        `the log of ${sessionId}`,
        async page => {
          const rows = findList(page) || [];
          if (!rows.length) return;

          if (rawOut) {
            await rawOut.write(
              (events ? ',\n' : '\n') +
              rows.map(row => JSON.stringify(row)).join(',\n')
            );
          }

          const text = renderSessionEvents(rows, state);
          if (text) await mdOut.write(text);

          events += rows.length;
          showProgress(
            `Fetching ${progress}: ${events.toLocaleString('en-US')} events so far\u2026`
          );
        }
      ));
    } catch (e) {
      console.warn(`Could not fetch the log of session ${sessionId}`, e);
    } finally {
      if (!state.last) {
        await mdOut.write(
          events
            ? '_(Nothing was said in this session; its log holds only system events.)_\n'
            : '_(No log was returned for this session.)_\n'
        );
      } else if (!complete) {
        await mdOut.write('\n_(The log stops early here: the rest could not be fetched.)_\n');
      }

      if (rawOut) {
        await rawOut.write('\n]\n');
        await rawOut.close();
      }
      await mdOut.close();
    }

    return { events, complete };
  }

  // ---- project files ----

  // How much of a file to ask for at a time. The site reads in pieces of
  // this size as well.
  const FILE_PIECE = 24 * 1024 * 1024;

  function base64ToBytes(data) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    return bytes;
  }

  // Every file in the project's own file system, at any depth. Resolves to
  // { files: [{ path, bytes }], complete }.
  async function listProjectFiles(channelId) {
    const url = fill(ENDPOINTS.code.filesList, { channel: channelId });
    const files = [];
    const seen = new Set();
    let cursor = '';

    for (;;) {
      let data;
      try {
        data = await v1JSON(url, {
          post: { recursive: true, limit: 500, ...(cursor && { cursor }) },
        });
      } catch (e) {
        if (!files.length) throw e;
        console.warn('Stopped listing the project files after an error', e);
        return { files, complete: false };
      }

      for (const entry of asArray(data?.entries)) {
        if (typeof entry?.path !== 'string' || !entry.path) continue;
        if (entry.is_directory === true) continue;

        files.push({ path: entry.path, bytes: Number(entry.size_bytes) || 0 });
      }

      // The reply names the next page for as long as there is one.
      const next = firstString(data?.cursor);
      if (!next) return { files, complete: true };
      if (seen.has(next)) return { files, complete: false };

      seen.add(next);
      cursor = next;
    }
  }

  // Copies one project file into `dir` as `name`, byte for byte, reading it
  // a piece at a time. Asked for a range, the API answers with exactly
  // those bytes (base64-encoded) whatever the file holds, so text and
  // binary files take the same path. Resolves to the number of bytes
  // written. If anything goes wrong the partial copy is dropped, so no
  // file is ever left behind that only looks whole.
  async function copyProjectFile(channelId, path, dir, name) {
    const url = fill(ENDPOINTS.code.filesOpen, { channel: channelId });
    const out = await openWriter(dir, name);
    let offset = 0;
    let total;
    let revision;

    try {
      for (;;) {
        const piece = await v1JSON(url, {
          post: { path, range_offset: offset, range_length: FILE_PIECE },
          timeoutMs: 180000,
        });

        if (typeof piece?.data !== 'string') {
          throw new Error(`unexpected reply (${piece?.reason || piece?.type || 'no data'})`);
        }

        const size = Number(piece.size_bytes);

        if (total === undefined) {
          total = size;
          revision = piece.content_revision;
        } else if (size !== total || piece.content_revision !== revision) {
          throw new Error('the file changed while it was being copied');
        }

        const bytes = base64ToBytes(piece.data);
        if (bytes.length) await out.write(bytes);
        offset += bytes.length;

        if (!bytes.length || (Number.isFinite(total) && offset >= total)) break;
      }

      if (Number.isFinite(total) && offset !== total) {
        throw new Error(`received ${offset} of ${total} bytes`);
      }

      await out.close();
      return offset;
    } catch (e) {
      await out.abort().catch(() => {});
      throw e;
    }
  }

  // ---- the export itself ----

  async function exportCodeChannel(endpoints, projectRoot) {
    const cfg = ENDPOINTS.code;
    const cvars = { channel: endpoints.channelId };
    const record = endpoints.record;
    const me = record?.membership?.account_id || null;
    const rawDir = await getDir(projectRoot, 'Raw JSON');
    const gaps = []; // whatever could not be exported, for the README

    await writeJSON(rawDir, 'routes used.json', endpoints.used);

    // 1. Channel metadata (from the channels list).
    if (record) {
      await writeJSON(rawDir, 'channel.json', record);

      const instructions = firstString(
        record.instructions,
        record.prompt_template,
        record.description,
        record.topic,
        record.purpose
      );

      await writeText(
        projectRoot,
        'Channel Info.md',
        instructions || '(No description was returned for this channel.)\n'
      );
    } else if (endpoints.channelsData) {
      // Couldn't single out this channel; save the whole list so nothing's lost.
      await writeJSON(rawDir, 'channels (full list).json', endpoints.channelsData);
    }

    // The channel's settings. Its instructions are kept here, not on the
    // channel record, as system_prompt_addendum.
    const settings = await v1Request(fill(cfg.config, cvars));

    const config = settings.ok ? unwrap(settings.data) : null;

    if (settings.ok) {
      await writeJSON(rawDir, 'config.json', settings.data);

      const instructions = firstString(config?.system_prompt_addendum);
      if (instructions) {
        await writeText(projectRoot, 'Channel Instructions.md', instructions);
      }
    } else {
      console.warn(`Could not fetch the channel settings: ${settings.why}`);
      gaps.push(`The channel's settings and instructions (${settings.why}).`);
    }

    // 2. The project's own files, copied into Files/ under the same paths.
    //    A path is made safe for a disk one folder at a time, so the
    //    manifest records both where a file was and where its copy is.
    setStatus('Listing the project files\u2026');

    const fileRows = [];
    let fileBytes = 0;

    try {
      const { files: listed, complete } = await listProjectFiles(endpoints.channelId);
      if (!complete) gaps.push('Part of the project files: the list stopped early.');

      if (listed.length) {
        setStatus(`Copying ${listed.length} project file(s)\u2026`);

        // Each folder made on disk, under its path in lower case. Two
        // project folders whose names differ only in case are one folder
        // on most disks, so they share one entry here, and one set of file
        // names, instead of overwriting each other's files.
        const filesDir = await getDir(projectRoot, 'Files');
        const folders = new Map([
          ['files', { dir: filesDir, path: 'Files', nameFor: makeUniqueNamer() }],
        ]);

        for (let i = 0; i < listed.length; i++) {
          const { path } = listed[i];
          showProgress(`Copying project file ${i + 1}/${listed.length}\u2026`);

          try {
            const parts = path.split('/').filter(Boolean);
            let key = 'files';
            let folder = folders.get(key);

            for (const part of parts.slice(0, -1)) {
              const safe = safeName(part);
              key += `/${safe.toLocaleLowerCase()}`;

              if (!folders.has(key)) {
                folders.set(key, {
                  dir: await getDir(folder.dir, safe),
                  path: `${folder.path}/${safe}`,
                  nameFor: makeUniqueNamer(),
                });
              }

              folder = folders.get(key);
            }

            const name = folder.nameFor(parts[parts.length - 1] || 'file');
            const bytes = await copyProjectFile(endpoints.channelId, path, folder.dir, name);

            fileRows.push({ path: `${folder.path}/${name}`, name: path, type: 'project_file', bytes });
            fileBytes += bytes;
          } catch (e) {
            console.warn(`Could not copy project file ${path}`, e);
            gaps.push(`Project file ${path} (${excerpt(e?.message || e, 160)}).`);
          }
        }
      }
    } catch (e) {
      console.warn('Could not list the project files', e);
      gaps.push(`The project files (${excerpt(e?.message || e, 160)}).`);
    }

    // 3. Timeline: every top-level message, following pagination. Each view
    //    is saved as the server sent it, and their rows are merged by id.
    setStatus('Fetching the channel timeline\u2026');

    const history = []; // the readable conversation files, for the manifest

    const sessions = new Map(); // ULID -> session id, as first seen
    const roots = new Map(); // message id -> message
    let hadTimeline = false;

    const views = [
      { file: 'timeline.json', url: endpoints.timelineFirstUrl },
      ...cfg.timelineViews.map(query => ({
        file: `timeline (${query}).json`,
        url: `${fill(cfg.timeline, cvars)}&${query}`,
      })),
    ];

    for (const view of views) {
      try {
        const { pages, rows, complete } = await fetchAllPages(view.url, view.file);

        await writeJSON(rawDir, view.file, pages.length === 1 ? pages[0] : pages);
        noteSessions(pages, sessions);

        for (const row of rows) {
          const id = idOf(row);
          if (id && !roots.has(id)) roots.set(id, row);
        }

        if (view === views[0]) hadTimeline = true;
        if (!complete) gaps.push(`Part of ${view.file}: paging stopped early.`);
      } catch (e) {
        console.warn(`Could not fetch ${view.file}`, e);
        gaps.push(`${view.file} (${excerpt(e?.message || e, 160)}).`);
      }
    }

    // Timeline pages arrive newest first; everything below reads oldest first.
    const messages = [...roots.values()].reverse().sort(byCreatedAt);

    // 4. Threads: each message that has something under it, with all of it.
    //    A thread is asked for by its root message, once. reply_count leaves
    //    out the automatic notices, so a message with a session bound to it
    //    or a last_reply_at counts as having a thread too.
    const threaded = messages.filter(
      row =>
        Number(row?.reply_count) > 0 ||
        asArray(row?.bound_sessions).length > 0 ||
        !!row?.last_reply_at
    );
    const threadsDir = threaded.length ? await getDir(projectRoot, 'Threads') : null;
    const threadFiles = new Map(); // root message id -> its file in Threads/
    const threadName = makeUniqueNamer();
    let threadCount = 0;
    let replyCount = 0;

    for (let i = 0; i < threaded.length; i++) {
      const root = threaded[i];
      const rootId = idOf(root);
      setStatus(`Fetching thread ${i + 1}/${threaded.length}\u2026`);

      try {
        const { pages, rows, complete } = await fetchAllPages(
          fill(endpoints.threadTemplate, { thread: rootId }),
          `thread ${rootId}`
        );

        // Threads can also point at sessions.
        noteSessions(pages, sessions);

        // Only the message itself came back: nothing is under it after all.
        if (rows.length <= 1) continue;

        await writeJSON(rawDir, `thread ${rootId}.json`, pages.length === 1 ? pages[0] : pages);

        const title = titleOf(root.body) || rootId;
        const file = `${threadName(`${String(threadCount + 1).padStart(3, '0')} ${title}`)}.md`;

        await writeText(
          threadsDir,
          file,
          renderChannelMessages(
            title,
            [`Thread: ${rootId}`],
            rows.slice().sort(byCreatedAt),
            { me }
          )
        );

        threadFiles.set(rootId, file);
        history.push({ path: `Threads/${file}`, title, type: 'thread' });
        threadCount++;
        replyCount += rows.filter(row => idOf(row) !== rootId).length;

        if (!complete) gaps.push(`Part of thread ${rootId}: paging stopped early.`);
      } catch (e) {
        console.warn(`Could not export thread ${rootId}`, e);
        gaps.push(`Thread ${rootId} (${excerpt(e?.message || e, 160)}).`);
      }

      await sleep(60);
    }

    if (messages.length) {
      await writeText(
        projectRoot,
        'Timeline.md',
        renderChannelMessages(
          `${firstString(record?.name, record?.title) || endpoints.channelId}: timeline`,
          [
            `${messages.length} top-level message(s), oldest first.` +
            (threadCount ? ' Replies are in the Threads folder.' : ''),
          ],
          messages,
          { me, threadFiles }
        )
      );

      history.unshift({ path: 'Timeline.md', title: 'Timeline', type: 'timeline' });
    }

    // 5. Sessions: every session the channel, its timeline or its threads
    //    refer to. Each gets its summary card and as much of its log as
    //    SESSION_LOGS asks for.
    noteSessions(record, sessions);

    const sessionsDir = await getDir(projectRoot, 'Sessions');
    const ids = [...sessions.values()];
    const nameFor = makeUniqueNamer();
    let sessionCount = 0;
    let eventCount = 0;
    let failed = 0;

    for (let i = 0; i < ids.length; i++) {
      const sessionId = ids[i];
      const progress = `session ${i + 1}/${ids.length}`;
      setStatus(`Fetching ${progress}\u2026`);

      let raw;
      try {
        raw = await v1JSON(fill(endpoints.sessionTemplate, { session: sessionId }));
      } catch (e) {
        failed++;
        console.warn(`Could not fetch session ${sessionId}`, e);
        gaps.push(`Session ${sessionId} (${excerpt(e?.message || e, 160)}).`);
        await sleep(60);
        continue;
      }

      const session = unwrap(raw);

      const title = firstString(
        session?.title,
        session?.name,
        session?.summary
      ) || sessionId;

      // Capped so the extensions added below always survive safeName().
      const stem = nameFor(excerpt(title, 120));

      await writeJSON(sessionsDir, `${stem}.json`, raw);

      if (SESSION_LOGS !== 'none') {
        const log = await exportSessionLog(
          sessionsDir, stem, session, title, sessionId, progress
        );

        eventCount += log.events;
        if (!log.complete) gaps.push(`Part of the log of session ${sessionId} ("${title}").`);

        history.push({ path: `Sessions/${stem}.md`, title, type: 'session' });
      }

      sessionCount++;
      await sleep(60);
    }

    // 6. The manifest an import reads.
    await writeJSON(projectRoot, MANIFEST, {
      ...manifestFor('code', endpoints.channelId),
      name: firstString(record?.name),
      description: firstString(record?.topic),
      instructions: firstString(config?.system_prompt_addendum),
      settings: {
        visibility: firstString(record?.visibility) || 'private',
        icon: firstString(record?.icon),
        color: firstString(record?.color),
        context_sources: asArray(record?.context_sources),
        config: config || {},
      },
      files: fileRows,
      history,
      // Whatever this export could not get; the README lists the same.
      problems: gaps,
    });

    // 7. A top-level README so the folder explains itself.
    const count = n => n.toLocaleString('en-US');

    const readme = [
      `# ${projectRoot.name}`,
      '',
      'Exported from a Claude Code workspace (a /code/ channel).',
      '',
      `- Channel: ${endpoints.channelId}`,
      `- Project files copied: ${count(fileRows.length)} (${count(fileBytes)} bytes), in Files/`,
      `- Timeline: ${hadTimeline ? `${count(messages.length)} top-level message(s), in Timeline.md` : 'not reachable'}`,
      `- Threads saved: ${count(threadCount)}, holding ${count(replyCount)} replies and notices, in Threads/`,
      `- Sessions exported: ${count(sessionCount)}${failed ? ` (${failed} failed \u2014 see console)` : ''}` +
        (SESSION_LOGS === 'none' ? ', without their logs' : `, with ${count(eventCount)} logged events`),
      '',
      'What is in this folder:',
      '',
      '- Channel Info.md: the channel\u2019s topic.',
      '- Channel Instructions.md: the instructions set for the channel, if any.',
      '- Files/: the project\u2019s own files, under the same paths.',
      '- Timeline.md: every top-level message, oldest first.',
      '- Threads/: one file per message that has replies, with all of them.',
      '- Sessions/: one set of files per Claude Code session. "<title>.json" is',
      '  its summary card.',
      ...(SESSION_LOGS === 'none'
        ? ['  Session logs were switched off for this export (SESSION_LOGS).']
        : [
            '  "<title>.md" is what was said and done, with each tool call and its',
            '  result cut to one line.',
          ]),
      ...(SESSION_LOGS === 'full'
        ? ['  "<title>.events.json" is the complete step-by-step log.']
        : []),
      '- Raw JSON/: the channel, its settings, its timeline and its threads',
      '  exactly as the server sent them.',
      `- ${MANIFEST}: what the importer reads to re-create this project.`,
      '',
      'Because this API is undocumented, the Markdown files are a best-effort',
      'rendering; trust the .json where they differ.',
      '',
      'Not exported: files that people attached to individual messages. They are',
      'listed by name in the raw JSON. (Files Claude attached to its messages are',
      'normally project files, so those are in Files/.)',
      '',
      ...(gaps.length
        ? ['Could not be exported this time:', '', ...gaps.map(g => `- ${g}`), '']
        : []),
    ].join('\n');

    await writeText(projectRoot, 'README.md', readme);

    return {
      fileCount: fileRows.length,
      messageCount: messages.length,
      threadCount,
      sessionCount,
      eventCount,
      failed,
      gaps: gaps.length,
      hadTimeline,
    };
  }

  // ============================================================
  // UI
  // ============================================================

  let statusNode = null;

  function setStatus(text) {
    console.log(
      'Claude exporter:',
      text
    );

    if (statusNode) {
      statusNode.textContent =
        text;
    }
  }

  function buildButton() {
    document
      .getElementById(
        'claude-simple-exporter'
      )
      ?.remove();

    const wrap =
      document.createElement('div');

    wrap.id =
      'claude-simple-exporter';

    Object.assign(
      wrap.style,
      {
        position: 'fixed',
        right: '18px',
        bottom: '18px',
        zIndex: '2147483647',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: '8px',
        fontFamily:
          'system-ui, sans-serif',
      }
    );

    statusNode =
      document.createElement('div');

    Object.assign(
      statusNode.style,
      {
        display: 'none',
        maxWidth: '460px',
        padding: '8px 10px',
        borderRadius: '8px',
        background:
          'rgba(20,20,20,.92)',
        color: '#fff',
        fontSize: '12px',
      }
    );

    const btn =
      document.createElement('button');

    btn.textContent =
      'Export Claude Project';

    Object.assign(
      btn.style,
      {
        padding: '10px 14px',
        borderRadius: '10px',
        cursor: 'pointer',
        border:
          '1px solid rgba(127,127,127,.35)',
        background: '#f0eee6',
        color: '#222',
        fontWeight: '650',
      }
    );

    wrap.append(
      statusNode,
      btn
    );

    document.body.appendChild(
      wrap
    );

    return btn;
  }

  // ============================================================
  // Run
  // ============================================================

  const { orgs, projects } =
    await discoverProjects();

  const btn =
    buildButton();

  console.log(
    `Claude exporter ready. Found ${projects.length} project(s).`
  );

  const tabWorkspace = workspaceFromUrl();

  if (
    tabWorkspace?.kind === 'code' &&
    !projects.some(x => x.id === tabWorkspace.id)
  ) {
    console.log(
      `Claude exporter: this tab is showing ${tabWorkspace.id}; ` +
      'the button will export it.'
    );
  }

  btn.addEventListener(
    'click',
    async () => {
      try {
        const selected =
          chooseProject(projects);

        if (!selected) return;

        // Standard projects taken from the URL need their org resolved here.
        // (Code channels use the /v1/code/ API, which takes the org from the
        // signed-in session rather than from the address.) This is
        // synchronous because the folder picker below only opens while the
        // click still counts as a user gesture.
        if (selected.kind !== 'code' && !selected.org) {
          selected.org = orgForWorkspace(selected.id, orgs);
          if (!selected.org) return;
        }

        if (
          !window.showDirectoryPicker
        ) {
          throw new Error(
            'Use Chrome or Edge: this browser cannot choose an export folder.'
          );
        }

        const destination =
          await window.showDirectoryPicker({
            mode: 'readwrite',
          });

        btn.disabled = true;
        statusNode.style.display =
          'block';

        const isCode =
          selected.kind === 'code';

        setStatus(
          isCode
            ? `Finding the /code/ API routes for ${selected.id}\u2026`
            : 'Starting\u2026'
        );

        const endpoints =
          await resolveEndpoints(selected);

        // ---- /code/ channel workspace ----
        if (isCode) {
          const channelName =
            firstString(
              endpoints.record?.name,
              endpoints.record?.title,
              endpoints.record?.topic
            ) || selected.id;

          if (!endpoints.record && !endpoints.timelineReachable) {
            // Lead with what the server itself said; it names the cause.
            const reason = endpoints.problems.length
              ? endpoints.problems[0].split('  \u2190  ')[0]
              : 'no reply';

            throw new Error(
              `Could not read workspace ${selected.id}: ${reason}. ` +
              'The console lists every refused request with its reason. A 404 ' +
              'means a path in ENDPOINTS.code has changed; a 400 means the paths ' +
              'are right and the requests lack something the API requires.'
            );
          }

          const projectRoot =
            await getDir(destination, channelName);

          const result =
            await exportCodeChannel(endpoints, projectRoot);

          const bits = [
            `${result.fileCount} file(s)`,
            `${result.messageCount} message(s)`,
            `${result.threadCount} thread(s)`,
            `${result.sessionCount} session(s)`,
          ];
          if (result.failed) bits.push(`${result.failed} session(s) failed`);
          if (!result.hadTimeline) bits.push('timeline unavailable');

          setStatus(
            `Done \u2014 ${bits.join(', ')}. ` +
            (result.gaps
              ? `${result.gaps} item(s) could not be exported; the folder\u2019s README lists them.`
              : 'See the folder\u2019s README.')
          );
          btn.textContent = 'Export complete';
          return;
        }

        // ---- standard uuid project (unchanged) ----
        const projectName =
          selected.project.name ||
          'Untitled Claude Project';

        const projectRoot =
          await getDir(
            destination,
            projectName
          );

        const filesDir =
          await getDir(
            projectRoot,
            'Files'
          );

        const chatsRoot =
          await getDir(
            projectRoot,
            'Chats'
          );

        setStatus(
          'Exporting project instructions, memory, description and files\u2026'
        );

        const context =
          await exportProjectContextAndFiles(
            endpoints,
            projectRoot,
            filesDir
          );

        const chats = []; // where each chat's transcript went, for the manifest

        const conversations =
          asArray(
            await fetchJSON(endpoints.conversations)
          );

        const uniqueChatFolder =
          makeUniqueNamer();

        for (
          let i = 0;
          i < conversations.length;
          i++
        ) {
          const c =
            conversations[i];

          const chatId =
            idOf(c);

          const title =
            c.name ||
            c.title ||
            'Untitled chat';

          setStatus(
            `Exporting ${i + 1}/${conversations.length}: ${title}`
          );

          const raw =
            await fetchChat(
              endpoints.chat,
              chatId
            );

          const allMessages =
            asArray(
              raw.chat_messages
            );

          const activeMessages =
            activeBranch(
              allMessages,
              raw.current_leaf_message_uuid
            );

          const chatFolderName =
            uniqueChatFolder(title);

          const chatDir =
            await getDir(
              chatsRoot,
              chatFolderName
            );

          const attachmentsDir =
            await getDir(
              chatDir,
              'Attachments'
            );

          const outputsDir =
            await getDir(
              chatDir,
              'Outputs'
            );

          // The name writeText() gives this file, worked out once so the
          // manifest can point at it.
          const chatFile =
            safeName(`${safeName(title)}.md`);

          await writeText(
            chatDir,
            chatFile,
            renderChatMarkdown(
              { ...c, ...raw },
              activeMessages,
              projectName
            )
          );

          chats.push({
            path: `Chats/${chatFolderName}/${chatFile}`,
            title,
            type: 'chat',
          });

          await exportChatFiles(
            endpoints,
            chatId,
            allMessages,
            activeMessages,
            attachmentsDir,
            outputsDir
          );

          await sleep(100);
        }

        await writeJSON(projectRoot, MANIFEST, {
          ...manifestFor('standard', selected.id),
          name: firstString(context.project?.name, selected.project.name),
          description: context.description,
          instructions: context.instructions,
          settings: {
            is_private: context.project?.is_private !== false,
            is_starred: context.project?.is_starred === true,
          },
          files: context.files,
          history: chats,
          memory: context.memory ? { path: 'Project Memory.md' } : null,
        });

        setStatus(
          `Done \u2014 ${conversations.length} chats exported.`
        );

        btn.textContent =
          'Export complete';
      } catch (e) {
        console.error(
          'Claude exporter failed:',
          e
        );

        statusNode.style.display =
          'block';

        statusNode.textContent =
          `Export failed: ${e.message || e}`;

        btn.disabled = false;
      }
    }
  );
})();
