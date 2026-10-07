(async () => {
  'use strict';

  // ============================================================
  // Claude project exporter
  // ============================================================
  //
  // `cswap project-move export` copies this script to the clipboard. Paste
  // it into the DevTools console (F12, then Console) of a claude.ai tab while
  // signed in, with the project to export open in that tab (from any other
  // claude.ai page it asks which project). Two buttons appear at the bottom
  // right. Press the first and choose a folder: the project is saved in a
  // folder of its own inside the one you choose. If no folder window opens
  // (some Chrome setups never show one, and Firefox and Safari have none),
  // press the second instead: the same folder is saved as one .tar file in
  // your downloads. The importer takes that file as it is, and tar(1),
  // 7-Zip and Windows Explorer can unpack it.
  //
  //   A regular project (claude.ai/project/...) is saved with its
  //   instructions, description, memory, knowledge files and every chat.
  //
  //   A Claude Code project (claude.ai/code/project/...) is saved with its
  //   description, instructions, settings, memory and its own files, and
  //   with its timeline, threads and session transcripts.
  //
  // An export ends with export.json, written once everything it lists has
  // been saved. That file is what the importer (project-import.js, copied
  // by `cswap project-move import`) and `cswap project-move check` read.
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
      // The project's memory (its Auto memory), as claude.ai's own Auto
      // memory panel asks for it: seen in the panel's requests on
      // 2026-10-07. The first lists the memories, the second reads one by
      // its id (mem_...). What the replies hold was not seen, so they are
      // read the way a memory store's are; see "The project's memory".
      channelMemories: '/v1/code/memory/channel/{channel}/memories?limit=100',
      channelMemory: '/v1/code/memory/channel/{channel}/memories/{memory}',
      // Where those are refused, the project's memory store, as the Claude
      // Code program reads it; see "The project's memory" below for how
      // its {store} id is found. These two were not seen on claude.ai's
      // pages, and on 2026-10-07 the site answered the list 404 for the
      // one store an export found. Both carry MEMORY_HEADERS as well.
      memories: '/v1/memory_stores/{store}/memories?beta=true',
      memory: '/v1/memory_stores/{store}/memories/{memory}?beta=true',
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
  //
  // `headers` adds to V1_HEADERS, for the few routes that ask for more;
  // without it a request carries V1_HEADERS and nothing else.
  async function v1Request(url, { post, timeoutMs = 60000, headers: extra } = {}) {
    const headers = extra ? { ...V1_HEADERS, ...extra } : V1_HEADERS;

    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const canRetry = attempt < RETRY_WAITS.length;
      let wait = RETRY_WAITS[attempt];
      let why;

      try {
        const r = await fetch(url, {
          credentials: 'include',
          headers,
          ...(post !== undefined && {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
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

  // Writes one session's log: when SESSION_LOGS is 'full', every event as
  // the server sent it to "<stem>.events.json" (a JSON array with one event
  // per line), and the readable version to "<stem>.md". A long session has
  // tens of thousands of events, so the full log is written a page at a
  // time as they arrive rather than collected first. The readable version,
  // a fraction of its size, is kept until the full log is closed and
  // written after it: cswap's side panel saves the export as one .tar,
  // which takes one file at a time, so two files written in turns break
  // it once both are large.
  // Resolves to { events, complete }.
  async function exportSessionLog(dir, stem, session, label, sessionId, progress) {
    const rawOut =
      SESSION_LOGS === 'full' ? await openWriter(dir, `${stem}.events.json`) : null;
    const md = [sessionHeader(session, label)];
    const state = {};
    let events = 0;
    let complete = false;

    try {
      if (rawOut) await rawOut.write('[');

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
          if (text) md.push(text);

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
        md.push(
          events
            ? '_(Nothing was said in this session; its log holds only system events.)_\n'
            : '_(No log was returned for this session.)_\n'
        );
      } else if (!complete) {
        md.push('\n_(The log stops early here: the rest could not be fetched.)_\n');
      }

      if (rawOut) {
        await rawOut.write('\n]\n');
        await rawOut.close();
      }
      const mdOut = await openWriter(dir, `${stem}.md`);
      await mdOut.write(md.join(''));
      await mdOut.close();
    }

    return { events, complete };
  }

  // ---- copies kept under their own paths ----

  // Makes the folder `top` in `parent` and resolves to a function that gives
  // a path ('a/b/c.md') its place in that folder: { dir, path, name }, the
  // folder to write the copy in, the copy's path from `parent` and its file
  // name. A path is made safe for a disk one folder at a time, so a
  // manifest can record both where a file was and where its copy is. Each
  // folder made is kept under its path in lower case: two folders whose
  // names differ only in case are one folder on most disks, so they share
  // one entry here, and one set of file names, instead of overwriting each
  // other's files. A '.' or '..' part is refused by the folder itself, so
  // nothing is ever written outside `top`.
  async function folderTree(parent, top) {
    const folders = new Map([
      ['', { dir: await getDir(parent, top), path: top, nameFor: makeUniqueNamer() }],
    ]);

    return async path => {
      const parts = path.split('/').filter(Boolean);
      let key = '';
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
      return { dir: folder.dir, path: `${folder.path}/${name}`, name };
    };
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

  // ---- the project's memory ----

  // A Claude Code project keeps what its Claude learns in a memory of its
  // own, which the project's Auto memory panel shows: MEMORY.md and one
  // file per fact. The panel reads it through the project's own route
  // (ENDPOINTS.code.channelMemories), and so does the export, first.
  // Where that is refused, the memory is looked for as the memory store
  // the Claude Code program reads. Claude Code names such a store by the path
  // /v1/code/memory/cagt_<id>, and its id is the cagt_ part. Which field of
  // the project's data names it is not known, so the store is looked for
  // the way the sessions are: anywhere in the channel's record and its
  // settings, and then among the requests this page already made (the
  // Auto memory panel's own requests name no store, so these come from
  // elsewhere). Group stores
  // (/v1/code/memory/grouping/<id>) are shared by several projects, and
  // other members have agents of their own, so ids under a key that names
  // a group or a member are not taken for this one's memory. How long a
  // cagt_ id is, and which characters it uses, is not known either.
  const MEMORY_STORE_ID = /^cagt_[0-9A-Za-z_-]{8,}$/;
  const MEMORY_STORE_PATH = /\/v1\/code\/memory\/(cagt_[0-9A-Za-z_-]{8,})/g;
  const MEMORY_REQUEST = /^\/v1\/memory_stores\/([^/?#]+)\/memories(\/[^?#]*)?(?:[?#]|$)/;
  const MEMORY_KEY = /memory/i;
  const NOT_THIS_PROJECT_KEY = /group|member/i;

  // The memory store routes are a beta, and every request to them names
  // it, as the Claude Code program's do. Whether the panel's own route
  // needs it was not seen, so that route is asked without it first, then
  // with it.
  const MEMORY_HEADERS = { 'anthropic-beta': 'agent-memory-2026-07-22' };

  // The paths a memory list may go on to its next page at.
  const MEMORY_LIST_PATH = /^\/v1\/(memory_stores|code\/memory)\//;

  // At most this many pages of one store's list are asked for.
  const MEMORY_PAGES = 50;

  // The export's folder for the memories, and the folder an import puts
  // them in among the new project's files.
  const MEMORY_DIR = 'Memory';
  const CARRIED_MEMORY = 'carried-memory';

  // The stores the channel's data points at, the most certain first: ids
  // in a /v1/code/memory/cagt_<id> path, then cagt_ ids under a key that
  // names memory, then any other cagt_ id (the project's own agent has one,
  // and its store may well be named after it).
  function memoryStoresIn(value) {
    const byPath = [];
    const byKey = [];
    const other = [];
    const seen = new Set();

    const walk = (v, underMemoryKey) => {
      if (typeof v === 'string') {
        for (const m of v.matchAll(MEMORY_STORE_PATH)) byPath.push(m[1]);
        if (MEMORY_STORE_ID.test(v)) (underMemoryKey ? byKey : other).push(v);
        return;
      }

      if (!v || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);

      for (const [key, inner] of Object.entries(v)) {
        if (NOT_THIS_PROJECT_KEY.test(key)) continue;
        walk(inner, underMemoryKey || MEMORY_KEY.test(key));
      }
    };

    walk(value, false);
    return [...new Set([...byPath, ...byKey, ...other])];
  }

  // The same-origin requests this page made whose URL holds `fragment`, in
  // the order they were made, as { path, start }: `start` is when each one
  // began, on the page's own clock.
  function pageRequestsAt(fragment) {
    const found = [];

    for (const entry of performance.getEntriesByType('resource')) {
      if (!['fetch', 'xmlhttprequest'].includes(entry.initiatorType)) continue;
      if (!entry.name.includes(fragment)) continue;

      let url;
      try {
        url = new URL(entry.name);
      } catch {
        continue;
      }

      if (url.origin === location.origin) {
        found.push({ path: url.pathname + url.search, start: Number(entry.startTime) });
      }
    }

    return found;
  }

  // The memory stores this page asked for, newest first, as { store, url }:
  // `url` is a list request, to be tried again as it is, or '' for one that
  // read a single memory or used Claude Code's own path for the store.
  // claude.ai keeps one page while it moves between projects, so a request
  // made before the page first asked about this project was another
  // project's: those are kept apart, in `before`, only to be named.
  function memoryRequestsSeen(channelId) {
    const shown = Math.min(...pageRequestsAt(channelId).map(r => r.start).filter(Number.isFinite));
    const after = [];
    const before = [];
    const note = (start, seen) => (start > shown ? after : before).push(seen);

    for (const { path, start } of pageRequestsAt('/v1/memory_stores/').reverse()) {
      const m = path.match(MEMORY_REQUEST);
      if (!m) continue;

      try {
        note(start, { store: decodeURIComponent(m[1]), url: m[2] ? '' : path });
      } catch {}
    }

    for (const { path, start } of pageRequestsAt('/v1/code/memory/').reverse()) {
      for (const m of path.matchAll(MEMORY_STORE_PATH)) note(start, { store: m[1], url: '' });
    }

    return { after, before };
  }

  // The list requests worth trying for one store: the route above first,
  // then any the page made for that same store, as it made them. Each is
  // { url, via, headers }.
  function memoryListsFor(store, seen) {
    return [
      { url: fill(ENDPOINTS.code.memories, { store }), via: 'ENDPOINTS.code.memories', headers: MEMORY_HEADERS },
      ...seen
        .filter(s => s.store === store && s.url)
        .map(s => ({ url: s.url, via: 'seen on this page', headers: MEMORY_HEADERS })),
    ];
  }

  // The project's own route, as the Auto memory panel asks it, and then
  // the same with the memory beta named.
  function channelMemoryLists(channelId) {
    const url = fill(ENDPOINTS.code.channelMemories, { channel: channelId });
    return [
      { url, via: 'ENDPOINTS.code.channelMemories', headers: undefined },
      { url, via: 'ENDPOINTS.code.channelMemories, with the memory beta', headers: MEMORY_HEADERS },
    ];
  }

  // The memories in one page of a list, wherever the reply keeps them, or
  // null when it holds no list at all.
  function memoryRowsOf(data) {
    if (Array.isArray(data)) return data;

    for (const v of [data, unwrap(data)]) {
      for (const key of ['data', 'memories', 'items', 'results']) {
        if (Array.isArray(v?.[key])) return v[key];
      }
    }

    return null;
  }

  function memoryIdOf(memory) {
    return idOf(memory) || firstString(memory?.memory_id) || '';
  }

  // A memory's path in its store ('MEMORY.md', 'notes/build.md'), with no
  // leading slash and no '.' parts: the path it gets under Memory/ and, in
  // the new project, under carried-memory/.
  function memoryPathOf(memory) {
    return firstString(memory?.path, memory?.name, memory?.key, memory?.filename, memory?.title)
      .split('/')
      .filter(part => part && part !== '.')
      .join('/');
  }

  // A memory's text, as a string or as text blocks; null when the reply
  // does not carry it.
  function memoryContentOf(memory) {
    for (const v of [memory?.content, memory?.text, memory?.body, memory?.value, memory?.memory]) {
      if (typeof v === 'string') return v;
      if (Array.isArray(v) && v.length && v.every(b => typeof b?.text === 'string')) {
        return v.map(b => b.text).join('');
      }
    }

    return null;
  }

  // How long a row says its memory's text is, in bytes, or NaN when it
  // does not say.
  function memorySizeOf(row) {
    for (const v of [row?.size_bytes, row?.bytes, row?.size, row?.content_length]) {
      const n = Number(v);
      if ((typeof v === 'number' || (typeof v === 'string' && v.trim())) && Number.isFinite(n)) return n;
    }

    return NaN;
  }

  // The text a list row carries, or null when the memory has to be read on
  // its own: a list may leave the text out, cut it short (with a flag, or
  // shorter than the size it gives), or send it empty where it means "not
  // here", so an empty one is read again as well.
  function listedContentOf(row) {
    const cut = [row?.truncated, row?.content_truncated, row?.is_truncated].includes(true);
    const text = cut ? null : memoryContentOf(row);
    if (!text) return null;

    const size = memorySizeOf(row);
    return Number.isFinite(size) && new Blob([text]).size < size ? null : text;
  }

  // Where a memory list says its next page is: { next } with the address to
  // ask for ('' on its last page), or { stop } saying why the list cannot be
  // followed further. The reply may say so by next_page (a page token, or
  // the address itself), by next_cursor, or by has_more with the id the
  // next page starts after. A token is an address only when it looks like
  // one (a page token may well begin with a slash), and an address is only
  // followed on this site, to a memory list: one on another site keeps its
  // path and query.
  function nextMemoryPage(url, data, rows) {
    if (data?.has_more === false) return { next: '' };

    const address = next => {
      let at;
      try {
        at = new URL(next, location.origin);
      } catch {
        return { stop: 'the next page\u2019s address could not be read' };
      }

      return MEMORY_LIST_PATH.test(at.pathname)
        ? { next: at.pathname + at.search }
        : { stop: 'the next page is not a memory list on this site' };
    };
    const withParam = (name, value) => {
      const at = new URL(url, location.origin);
      at.searchParams.set(name, value);
      return { next: at.pathname + at.search };
    };
    const isAddress = token => /^(https?:\/\/|\/v1\/)/.test(token);

    const page = data?.next_page;
    if (typeof page === 'number' || (typeof page === 'string' && page && page !== 'null')) {
      return isAddress(String(page)) ? address(page) : withParam('page', String(page));
    }

    const cursor = nextCursorOf(data);
    if (cursor) return isAddress(cursor) ? address(cursor) : withParam('cursor', cursor);

    if (data?.has_more === true) {
      const last = firstString(data.last_id) || memoryIdOf(rows[rows.length - 1]);
      return last
        ? withParam('after_id', last)
        : { stop: 'the list said there was more but not where it goes on' };
    }

    return { next: '' };
  }

  // The part of a list reply that says where it goes on: the reply itself,
  // or, when only the one object it wraps says so, that object (a reply
  // like {"data":{"memories":[...],"next_cursor":"c2"}}).
  function memoryPagingOf(data) {
    const says = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v) &&
      (['has_more', 'next_page', 'last_id'].some(key => v[key] != null) || Boolean(nextCursorOf(v)));

    const inner = unwrap(data);
    return !says(data) && says(inner) ? inner : data;
  }

  // The rest of a memory list, from the reply to its first page, each page
  // asked with the first one's `headers`. Resolves to { pages, rows,
  // complete, why }, `why` saying what stopped it early. A memory that two
  // pages both list is kept once.
  async function readMemoryList(url, first, headers) {
    const ids = new Set();
    const fresh = list => list.filter(row => {
      const id = memoryIdOf(row);
      if (!id) return true;
      if (ids.has(id)) return false;
      ids.add(id);
      return true;
    });

    const pages = [first];
    const rows = fresh(memoryRowsOf(first));
    const asked = new Set([url]);
    let at = url;
    let data = first;

    for (;;) {
      const { next, stop } = nextMemoryPage(at, memoryPagingOf(data), memoryRowsOf(data) || []);
      if (stop) {
        console.warn(`Claude exporter: stopped paging the project memory after ${pages.length} page(s): ${stop}`);
        return { pages, rows, complete: false, why: stop };
      }
      if (!next) return { pages, rows, complete: true, why: '' };

      // The same page twice means the server ignored where to go on from.
      if (asked.has(next) || pages.length >= MEMORY_PAGES) {
        console.warn(`Claude exporter: stopped paging the project memory after ${pages.length} page(s)`);
        return { pages, rows, complete: false, why: `paging stopped after ${pages.length} page(s)` };
      }
      asked.add(next);

      const res = await v1Request(next, { headers });
      const more = res.ok ? memoryRowsOf(res.data) : null;
      if (!more) {
        return { pages, rows, complete: false, why: res.ok ? 'a page was not a list of memories' : res.why };
      }

      pages.push(res.data);
      rows.push(...fresh(more));
      at = next;
      data = res.data;
    }
  }

  // Finds the project's memory and reads its whole list. The project's
  // own route goes first: it is the one its Auto memory panel uses, and
  // when it answers with a list, that is the memory, even an empty one (a
  // young project remembers nothing yet). Only when it is refused are
  // stores tried, ranked by how certain it is that they are this
  // project's, never by whether they hold anything: the first store the
  // project's own data names that answers with a list is the one. Only
  // when the data names none that answers is a store this page asked for
  // taken, and then only one asked for after the page first asked about
  // this project, and only when it is the only such store. Resolves to
  // { found, problems, unexpected, named, seen, before }: `found` is
  // { store, url, via, source, headers, readUrl, pages, rows, complete,
  // why } or null (`store` is the channel's id for the project's own
  // route), `problems` says why each request that failed was refused,
  // `unexpected` is the first reply that was not a list, kept so that its
  // shape can be looked at, `named` the stores the project's data names,
  // and `seen` and `before` name the stores this page asked for after and
  // before it showed this project.
  async function readMemoryStore(record, config, channelId) {
    const page = memoryRequestsSeen(channelId);
    const pageLists = [...page.after, ...page.before];
    const named = memoryStoresIn([record, config]);
    const seen = [...new Set(page.after.map(s => s.store))].filter(s => !named.includes(s));
    const before = [...new Set(page.before.map(s => s.store))].filter(s => !named.includes(s) && !seen.includes(s));
    const problems = [];
    let unexpected = null;

    const listOf = async (store, lists) => {
      const tried = new Set();

      for (const list of lists) {
        const key = `${list.headers ? 'beta ' : ''}${list.url}`;
        if (tried.has(key)) continue;
        tried.add(key);

        const res = await v1Request(list.url, { headers: list.headers });
        if (res.ok && memoryRowsOf(res.data)) return { ...list, data: res.data };

        if (res.ok && unexpected === null) unexpected = res.data;
        problems.push({ store, url: list.url, why: res.ok ? 'the reply was not a list of memories' : res.why });
      }

      return null;
    };

    const inStore = store => id => fill(ENDPOINTS.code.memory, { store, memory: id });
    const places = [
      ...(channelId
        ? [{
            store: channelId,
            source: 'project route',
            lists: channelMemoryLists(channelId),
            readUrl: id => fill(ENDPOINTS.code.channelMemory, { channel: channelId, memory: id }),
          }]
        : []),
      ...named.map(store => ({ store, source: 'channel data', lists: memoryListsFor(store, pageLists), readUrl: inStore(store) })),
      ...(seen.length === 1
        ? [{ store: seen[0], source: 'seen on this page', lists: memoryListsFor(seen[0], pageLists), readUrl: inStore(seen[0]) }]
        : []),
    ];

    for (const { store, source, lists, readUrl } of places) {
      const hit = await listOf(store, lists);
      if (!hit) continue;

      const found = {
        store, url: hit.url, via: hit.via, source, headers: hit.headers, readUrl,
        ...await readMemoryList(hit.url, hit.data, hit.headers),
      };
      return { found, problems, unexpected, named, seen, before };
    }

    return { found: null, problems, unexpected, named, seen, before };
  }

  // Why the memory could not be had, for the README and the console: what
  // the server said to the project's route and each store tried, that the
  // page asked for more than one store, or that nothing names one.
  function memoryMissing({ problems, named, seen, before }) {
    const why = [];

    if (problems.length) why.push(`no memory route answered (${excerpt(memoryRefusals(problems), 300)})`);
    if (seen.length > 1) {
      why.push(
        `this page asked for ${seen.length} memory stores (${seen.join(', ')}), ` +
        'so which one is this project\u2019s is not known'
      );
    }
    if (!named.length && !seen.length) {
      why.push(
        'no memory store is named in the project\u2019s data or in this page\u2019s requests' +
        (before.length
          ? ` (the page asked for ${before.join(', ')} before it showed this project, so ` +
            `${before.length === 1 ? 'that one was' : 'those were'} not taken)`
          : '')
      );
    }

    return why.join('; ');
  }

  // Why the memory could not be read, in one line for the README: the
  // project's route and each store tried, with what the server said.
  function memoryRefusals(problems) {
    const byStore = new Map();

    for (const { store, why } of problems) {
      if (!byStore.has(store)) byStore.set(store, []);
      if (!byStore.get(store).includes(why)) byStore.get(store).push(why);
    }

    return [...byStore].map(([store, whys]) => `${store}: ${whys.join(' / ')}`).join('; ');
  }

  // How the README names where a store was found.
  const MEMORY_SOURCES = {
    'project route': 'read the way its Auto memory panel reads it',
    'channel data': 'named in the project\u2019s data',
    'seen on this page': 'found only among this page\u2019s requests; check it is this project\u2019s',
  };

  // How the README names where the memory was read: the project's own
  // memory, or the store it was found in.
  function memoryNamed({ store, source }) {
    return source === 'project route' ? 'the project\u2019s memory' : `memory store ${store}`;
  }

  // What to do when the memory is missing. The export already asks the
  // Auto memory panel's own requests, so opening the panel adds nothing;
  // what helps is how the panel's requests differ from the export's.
  const MEMORY_ADVICE =
    'If the project\u2019s Auto memory panel shows memories and this still fails, open the ' +
    'panel with DevTools open (Network, Fetch/XHR, filter "memories") and report what its ' +
    'requests answer and which headers they send, beside the refused lines above.';

  // Copies the project's memory into Memory/, each memory under its own
  // path. Resolves to { rows, listed, memory, used }: the manifest's rows
  // for the copies, how many memories the store listed, the manifest's
  // record of the store (null when none was read) and the route for
  // "routes used.json". Whatever could not be had is added to `gaps`, and
  // a step this uncertain never stops the rest of the export: anything it
  // throws is one more gap. Only ids, paths and counts are ever printed; a
  // memory's text never goes to the console.
  async function exportProjectMemory(record, config, channelId, projectRoot, rawDir, gaps) {
    try {
      return await copyProjectMemory(record, config, channelId, projectRoot, rawDir, gaps);
    } catch (e) {
      const why = excerpt(e?.message || e, 160);
      console.warn(`Claude exporter: the project\u2019s memory was not exported: ${why}`);
      gaps.push(`The project\u2019s memory (${why}).`);
      return { rows: [], listed: 0, memory: null, used: `failed: ${why}` };
    }
  }

  async function copyProjectMemory(record, config, channelId, projectRoot, rawDir, gaps) {
    setStatus('Looking for the project\u2019s memory\u2026');

    const looked = await readMemoryStore(record, config, channelId);
    const { found, problems, unexpected } = looked;

    // The list as the server sent it, so that a shape this script does not
    // know can be looked at.
    if (found) {
      await writeJSON(rawDir, 'memory.json', found.pages.length === 1 ? found.pages[0] : found.pages);
    } else if (unexpected !== null) {
      await writeJSON(rawDir, 'memory.json', unexpected);
    }

    const refused = problems.map(p => `  ${p.why}  \u2190  ${p.url}`).join('\n');

    if (!found) {
      const why = memoryMissing(looked);

      gaps.push(`The project\u2019s memory: ${why}.`);
      console.warn(
        `Claude exporter: the project\u2019s memory was not exported: ${why}.` +
        (refused ? `\n${refused}` : '') +
        `\n${MEMORY_ADVICE}`
      );
      return { rows: [], listed: 0, memory: null, used: 'not found' };
    }

    if (refused) {
      console.log(`Claude exporter: memory requests that were refused before one answered:\n${refused}`);
    }
    console.log(
      `Claude exporter: project memory: ${found.source === 'project route' ? 'channel' : 'store'} ` +
      `${found.store}, ${found.rows.length} memory file(s) listed, from ${found.url} ` +
      `(${found.via}; ${found.source})`
    );
    if (found.source === 'seen on this page') {
      console.warn(
        `Claude exporter: the project\u2019s memory was taken from memory store ${found.store}, ` +
        'which only this page\u2019s own requests name, not the project\u2019s data. Check that it ' +
        'is this project\u2019s memory; the export\u2019s README says so too.'
      );
    }

    if (!found.complete) gaps.push(`Part of the project\u2019s memory: its list stopped early (${found.why}).`);

    const rows = [];
    const placeInMemory = found.rows.length ? await folderTree(projectRoot, MEMORY_DIR) : null;

    if (found.rows.length) setStatus(`Copying ${found.rows.length} memory file(s)\u2026`);

    for (let i = 0; i < found.rows.length; i++) {
      const listed = found.rows[i];
      const id = memoryIdOf(listed);
      let path = memoryPathOf(listed);
      showProgress(`Copying memory file ${i + 1}/${found.rows.length}\u2026`);

      try {
        let text = listedContentOf(listed);

        if (text === null) {
          if (!id) throw new Error('the list gives neither its text nor an id to read it by');

          const res = await v1Request(found.readUrl(id), { headers: found.headers });
          if (!res.ok) throw new Error(res.why);

          const memory = unwrap(res.data);
          text = memoryContentOf(memory);
          path ||= memoryPathOf(memory);

          if (text === null) {
            await writeJSON(rawDir, `memory ${id}.json`, res.data);
            throw new Error('the reply holds no text');
          }
        }

        path ||= id ? `${id}.md` : '';
        if (!path) throw new Error('it has neither a path nor an id');

        const copy = await placeInMemory(path);
        await writeText(copy.dir, copy.name, text);

        rows.push({
          path: copy.path,
          name: `${CARRIED_MEMORY}/${path}`,
          type: 'project_memory',
          bytes: new Blob([text]).size,
        });
      } catch (e) {
        const which = path || id || `number ${i + 1}`;
        console.warn(`Could not copy memory ${which}: ${excerpt(e?.message || e, 160)}`);
        gaps.push(`Memory ${which} (${excerpt(e?.message || e, 160)}).`);
      }
    }

    setStatus(
      found.rows.length
        ? `Saved ${rows.length} memory file(s) in ${MEMORY_DIR}/.`
        : 'The project\u2019s memory holds nothing yet.'
    );

    return {
      rows,
      listed: found.rows.length,
      memory: { store: found.store, files: rows.length, route: found.url, source: found.source },
      used: `${found.url}  (${found.via})`,
    };
  }

  // ---- the export itself ----

  async function exportCodeChannel(endpoints, projectRoot) {
    const cfg = ENDPOINTS.code;
    const cvars = { channel: endpoints.channelId };
    const record = endpoints.record;
    const me = record?.membership?.account_id || null;
    const rawDir = await getDir(projectRoot, 'Raw JSON');
    const gaps = []; // whatever could not be exported, for the README

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

    // 2. The project's memory, copied into Memory/ under the same paths.
    //    The routes used are written once that is known: a file is written
    //    only once, because the extension appends each one it is given to
    //    the .tar it makes.
    const memory = await exportProjectMemory(record, config, endpoints.channelId, projectRoot, rawDir, gaps);

    await writeJSON(rawDir, 'routes used.json', { ...endpoints.used, memory: memory.used });

    // 3. The project's own files, copied into Files/ under the same paths.
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

        const placeInFiles = await folderTree(projectRoot, 'Files');

        for (let i = 0; i < listed.length; i++) {
          const { path } = listed[i];
          showProgress(`Copying project file ${i + 1}/${listed.length}\u2026`);

          try {
            const copy = await placeInFiles(path);
            const bytes = await copyProjectFile(endpoints.channelId, path, copy.dir, copy.name);

            fileRows.push({ path: copy.path, name: path, type: 'project_file', bytes });
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

    // 4. Timeline: every top-level message, following pagination. Each view
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

    // 5. Threads: each message that has something under it, with all of it.
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

    // 6. Sessions: every session the channel, its timeline or its threads
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

        history.push({ path: `Sessions/${stem}.md`, title, type: 'session', id: sessionId });
      }

      sessionCount++;
      await sleep(60);
    }

    // 7. The manifest an import reads.
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
        // Whether memory was on, and how many other people were members:
        // an import cannot add people, and it only says so.
        ...(typeof record?.memory_enabled === 'boolean' && { memory_enabled: record.memory_enabled }),
        ...(record && { other_members: asArray(record.members).filter(m => m?.account_id !== me).length }),
      },
      // The memory comes first. An import puts it in a folder the project's
      // own files do not use (carried-memory/, or carried-memory-2/ when
      // they already hold a carried-memory/ of an earlier move), so neither
      // copy is lost.
      files: [...memory.rows, ...fileRows],
      history,
      // Which store the memory came from, and whether the project's data
      // named it or only this page's requests did, for the record; null
      // when none could be read (the problems say why).
      memory: memory.memory,
      // Whatever this export could not get; the README lists the same.
      problems: gaps,
    });

    // 8. A top-level README so the folder explains itself.
    const count = n => n.toLocaleString('en-US');

    const readme = [
      `# ${projectRoot.name}`,
      '',
      'Exported from a Claude Code workspace (a /code/ channel).',
      '',
      `- Channel: ${endpoints.channelId}`,
      `- Project files copied: ${count(fileRows.length)} (${count(fileBytes)} bytes), in Files/`,
      `- Project memory: ${!memory.memory
        ? 'not exported (see below)'
        : memory.listed
          ? `${count(memory.rows.length)} file(s) from ${memoryNamed(memory.memory)} ` +
            `(${MEMORY_SOURCES[memory.memory.source]}), in ${MEMORY_DIR}/`
          : `none yet (${memoryNamed(memory.memory)} is empty; ${MEMORY_SOURCES[memory.memory.source]})`}`,
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
      ...(memory.rows.length
        ? [
            `- ${MEMORY_DIR}/: what the project remembers (its Auto memory: MEMORY.md and`,
            `  one file per fact), under the same paths. An import puts these in`,
            `  ${CARRIED_MEMORY}/ among the new project\u2019s files.`,
          ]
        : []),
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
      '- Raw JSON/: the channel, its settings, its memory\u2019s list, its timeline',
      '  and its threads, exactly as the server sent them.',
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
      memory: memory.memory,
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
  // A .tar file instead of a folder
  // ============================================================
  //
  // The folder window (showDirectoryPicker) is not always there to use.
  // Firefox and Safari do not have it, and some Chrome setups never show
  // it: it reports itself closed the moment it is asked for. For those the
  // export is saved as one .tar file in the browser's downloads instead,
  // holding the same files under the same paths, with the project's folder
  // at the top. The importer takes such a file as it is; tar(1), 7-Zip,
  // Windows Explorer and Python's tarfile all open it.
  //
  // tarDestination() stands in for the picked folder: it answers the same
  // getDirectoryHandle / getFileHandle / createWritable calls the export
  // makes on a real folder, and keeps each closed file as one entry. The
  // archive is then one Blob made of the entries' headers and their
  // content in the pieces it was written in, so nothing is copied or
  // joined up: a /code/ export whose logs run to hundreds of megabytes
  // costs no more memory than it already did.
  //
  // The format is POSIX ustar in 512-byte blocks, with a GNU long-name
  // entry ('L') ahead of any file whose path is over 100 bytes, as the
  // thread files often are.

  const TAR_BLOCK = 512;

  // How long the download's address is kept after the click. The browser
  // has long since begun the save by then.
  const DOWNLOAD_URL_LIFETIME = 60000;

  // Zero bytes to round `size` up to whole blocks.
  function tarPadding(size) {
    const rest = size % TAR_BLOCK;
    return new Uint8Array(rest ? TAR_BLOCK - rest : 0);
  }

  // One header block. `name` is the entry's path as UTF-8 bytes, of which
  // the field holds the first 100; `type` is '0' for a file and 'L' for
  // the long-name entry that carries a path the field cannot.
  function tarHeader(name, size, type, mtime) {
    const h = new Uint8Array(TAR_BLOCK);
    const ascii = s => new TextEncoder().encode(s);
    // Numbers are octal, zero-padded to their field, ending in a NUL.
    const octal = (value, width) =>
      ascii(value.toString(8).padStart(width - 1, '0') + '\0');

    h.set(name.subarray(0, 100), 0);
    h.set(octal(0o644, 8), 100); // mode
    h.set(octal(0, 8), 108); // uid
    h.set(octal(0, 8), 116); // gid
    h.set(octal(size, 12), 124);
    h.set(octal(mtime, 12), 136);
    h.set(ascii('        '), 148); // the checksum counts as spaces
    h[156] = type.charCodeAt(0);
    h.set(ascii('ustar\0'), 257);
    h.set(ascii('00'), 263);

    let sum = 0;
    for (const b of h) sum += b;
    h.set(ascii(sum.toString(8).padStart(6, '0') + '\0 '), 148);

    return h;
  }

  // What a real folder handle refuses as a name, and how: '', '.', '..'
  // and anything holding a separator get a TypeError from
  // getDirectoryHandle / getFileHandle. The archive refuses the same names
  // the same way, so a project file whose path climbs out of its folder
  // is a gap (caught where it is copied, and listed in the README) on
  // both paths, rather than an entry `cswap project-move check` refuses
  // the whole .tar over.
  function checkTarName(name) {
    if (name === '' || name === '.' || name === '..' || /[\/\\]/.test(name)) {
      throw new TypeError('Name is not allowed.');
    }
  }

  // A stand-in for the picked folder that gathers what is written into it.
  // `root` is given to the export in place of the folder; once the export
  // is done, toBlob() is the archive.
  function tarDestination() {
    const entries = new Map(); // path -> { chunks, size }, in the order closed
    const mtime = Math.floor(Date.now() / 1000);

    // Each handle knows its path from the root as a list of names.
    const directory = segments => ({
      kind: 'directory',
      name: segments[segments.length - 1] || '',
      getDirectoryHandle: async name => {
        checkTarName(name);
        return directory([...segments, name]);
      },
      getFileHandle: async name => {
        checkTarName(name);
        return file([...segments, name]);
      },
    });

    const file = segments => ({
      kind: 'file',
      name: segments[segments.length - 1],
      // As on a disk: nothing counts until close(), and abort() drops it.
      createWritable: async () => {
        const chunks = [];
        let size = 0;

        return {
          // Whatever the export writes (a Blob, text, bytes) is kept as a
          // Blob, which knows its size; text is UTF-8, as on a disk.
          write: async chunk => {
            const blob = chunk instanceof Blob ? chunk : new Blob([chunk]);
            chunks.push(blob);
            size += blob.size;
          },
          close: async () => {
            entries.set(segments.join('/'), { chunks, size });
          },
          abort: async () => {},
        };
      },
    });

    // For each entry: its header (preceded, when the path is over 100
    // bytes, by the long-name entry carrying the whole path), its content
    // as written, and zero bytes up to the next block. Two zero blocks end
    // the archive.
    const toBlob = () => {
      const parts = [];

      for (const [path, { chunks, size }] of entries) {
        const name = new TextEncoder().encode(path);

        if (name.length > 100) {
          const whole = new Uint8Array(name.length + 1); // with a trailing NUL
          whole.set(name);

          parts.push(
            tarHeader(new TextEncoder().encode('././@LongLink'), whole.length, 'L', mtime),
            whole,
            tarPadding(whole.length)
          );
        }

        parts.push(tarHeader(name, size, '0', mtime), ...chunks, tarPadding(size));
      }

      parts.push(new Uint8Array(2 * TAR_BLOCK));

      return new Blob(parts, { type: 'application/x-tar' });
    };

    return { root: directory([]), toBlob };
  }

  // Hands `blob` to the browser to save as `name`, the way a download link
  // does. The address made for it is let go a minute later.
  function offerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME);
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

  // The status box, the main button and, under it, the smaller one that
  // saves a .tar file instead. (The test harness finds the main button as
  // the first <button> made and the status box as the second <div>, so
  // those are made first.)
  function buildButtons() {
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

    const tarBtn =
      document.createElement('button');

    tarBtn.textContent =
      'Save as .tar instead (no folder window)';

    Object.assign(
      tarBtn.style,
      {
        padding: '6px 10px',
        borderRadius: '8px',
        cursor: 'pointer',
        border:
          '1px solid rgba(127,127,127,.35)',
        background: '#f0eee6',
        color: '#222',
        fontSize: '12px',
      }
    );

    wrap.append(
      statusNode,
      btn,
      tarBtn
    );

    document.body.appendChild(
      wrap
    );

    return { btn, tarBtn };
  }

  // ============================================================
  // Run
  // ============================================================

  const { orgs, projects } =
    await discoverProjects();

  const { btn, tarBtn } =
    buildButtons();

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

  // The export itself, of `selected` into `destination`: the picked folder,
  // or the root of a .tar (see tarDestination). Resolves, once export.json
  // is written, to the Done line short of its last sentence, whether that
  // sentence should point at the folder's README (a /code/ export with
  // nothing missing), and the name of the folder made.
  async function exportInto(selected, destination) {
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
        ...(result.memory ? [`${result.memory.files} memory file(s)`] : []),
        `${result.messageCount} message(s)`,
        `${result.threadCount} thread(s)`,
        `${result.sessionCount} session(s)`,
      ];
      if (result.failed) bits.push(`${result.failed} session(s) failed`);
      if (!result.hadTimeline) bits.push('timeline unavailable');

      return {
        summary:
          `Done \u2014 ${bits.join(', ')}.` +
          (result.gaps
            ? ` ${result.gaps} item(s) could not be exported; the folder\u2019s README lists them.`
            : ''),
        // With nothing missing, the README is all that is left to point at.
        readme: !result.gaps,
        folder: projectRoot.name,
      };
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

    return {
      summary:
        `Done \u2014 ${conversations.length} chats exported.`,
      readme: false,
      folder: projectRoot.name,
    };
  }

  // One export, the way a button asks for it: into a folder the user
  // picks, or (`asTar`) into a .tar file. Nothing is awaited before the
  // folder window, because it only opens while the click still counts as
  // a user gesture.
  async function runExport(asTar) {
    try {
      const selected =
        chooseProject(projects);

      if (!selected) return;

      // Standard projects taken from the URL need their org resolved here.
      // (Code channels use the /v1/code/ API, which takes the org from the
      // signed-in session rather than from the address.)
      if (selected.kind !== 'code' && !selected.org) {
        selected.org = orgForWorkspace(selected.id, orgs);
        if (!selected.org) return;
      }

      // Where the files go: a .tar when asked for one, or when this browser
      // has no folder window to offer; the picked folder otherwise.
      let archive = null;
      let destination;

      if (asTar) {
        archive = tarDestination();
      } else if (!window.showDirectoryPicker) {
        archive = tarDestination();
        statusNode.style.display = 'block';
        setStatus(
          'This browser has no folder window, so the export will be saved ' +
          'as a .tar file in your downloads instead.'
        );
      } else {
        try {
          destination = await window.showDirectoryPicker({ mode: 'readwrite' });
        } catch (e) {
          if (e?.name !== 'AbortError') throw e;

          // Closed by the user, or, in some Chrome setups, never shown.
          statusNode.style.display = 'block';
          setStatus(
            'The folder window was closed or did not open. Press the button ' +
            'again, or press \u201cSave as .tar instead\u201d below.'
          );
          return;
        }
      }

      if (archive) destination = archive.root;

      btn.disabled = true;
      tarBtn.disabled = true;
      statusNode.style.display = 'block';

      const { summary, readme, folder } =
        await exportInto(selected, destination);

      let ending = readme ? 'See the folder\u2019s README.' : '';

      if (archive) {
        setStatus('Packing the .tar file\u2026');
        const fileName = `${safeName(folder)}.tar`;
        offerDownload(archive.toBlob(), fileName);
        ending = `Saved as ${fileName} in your downloads.`;
      }

      setStatus(ending ? `${summary} ${ending}` : summary);
      btn.textContent = 'Export complete';
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
      tarBtn.disabled = false;
    }
  }

  btn.addEventListener('click', () => runExport(false));
  tarBtn.addEventListener('click', () => runExport(true));
})();
