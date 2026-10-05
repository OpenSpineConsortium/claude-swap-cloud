(async () => {
  'use strict';

  // ============================================================
  // Claude project importer
  // ============================================================
  //
  // The other half of project-export.js. `cswap project-move import` copies
  // this script to the clipboard. Paste it into the DevTools console (F12,
  // then Console) of a claude.ai tab while signed in as the account that
  // should get the project. A button appears at the bottom left. Press it
  // and choose a folder the exporter made: the one with export.json in it,
  // or the folder that holds it. You are shown what is about to be created
  // and asked for a name; Cancel stops there. Then a NEW project is created
  // from the export:
  //
  //   A regular project (claude.ai/project/...) gets its description, its
  //   instructions and its knowledge files. The saved chats and the project
  //   memory are added as extra knowledge files.
  //
  //   A Claude Code project (claude.ai/code/project/...) gets its description,
  //   its instructions, its settings and its own files under the same
  //   paths. The saved timeline, threads and session transcripts are added
  //   as files in the folder named by HISTORY_FOLDER.
  //
  // Old conversations cannot be put back as live chats or threads, because
  // the site has no way to do that. They come back as files Claude can read.
  //
  // Nothing that already exists is changed, overwritten or deleted, and
  // this script never deletes anything. The new project is always private,
  // whatever the original was.
  //
  // Keep this file plain ASCII, writing any other character as a \uXXXX
  // escape: it travels through the clipboard, and on Windows that garbles
  // anything else. tests/test_project_move.py holds it to that.

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ============================================================
  // Settings
  // ============================================================

  // Bring the saved conversations along as reference files. With false,
  // only the project itself is imported.
  const IMPORT_HISTORY = true;

  // The folder those files go in, in a Claude Code project.
  const HISTORY_FOLDER = 'imported-history';

  // Where one of a Claude Code project's own files goes when it cannot be
  // put back at its own path, because the site keeps that path for itself
  // or something is already there.
  const DISPLACED_FOLDER = 'imported-not-placed';

  // A Claude Code project comes with its own Claude, which can work in the
  // project's repositories and folders by itself. It is there from the
  // moment the project exists, and it is told about every setting as the
  // import makes it. With true, the new project is paused as the last step
  // of the import, which stops that Claude there and then; it stays stopped
  // until you have looked the project over and pressed Resume, which is at
  // the bottom of the project's page. With false, it is left running.
  const PAUSE_WHEN_DONE = true;

  // Files larger than this are left out. The site takes those through a
  // different, several-step upload that this script does not do.
  const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

  // ============================================================
  // Endpoints
  // ============================================================
  //
  // Placeholders ({org}, {project}, {channel}) are filled in at runtime.
  // These are the requests claude.ai's own pages make when a project is
  // created and filled by hand. If Anthropic changes them, an import stops
  // with the server's own reason in the status box and the console; compare
  // these lines with DevTools -> Network while doing the same thing by hand.

  const ENDPOINTS = {
    orgs: '/api/organizations',

    // claude.ai/project/<uuid>
    standard: {
      list: '/api/organizations/{org}/projects?include_harmony_projects=true&limit=100',
      // POST { name, description, is_private, is_starred } makes a project.
      create: '/api/organizations/{org}/projects',
      // PUT with only the fields to change: { prompt_template } is the
      // project's instructions.
      project: '/api/organizations/{org}/projects/{project}',
      // POST { file_name, content } adds a text document to the knowledge.
      docs: '/api/organizations/{org}/projects/{project}/docs',
      files: '/api/organizations/{org}/projects/{project}/files',
      // POST multipart "file" adds a file (an image, a PDF) to the knowledge.
      upload: '/api/organizations/{org}/projects/{project}/upload',
      page: '/project/{project}',
    },

    // claude.ai/code/project/chan_..., which the /v1/code/ API calls channels.
    code: {
      list: '/v1/code/channels?scope=joined&include_archived=true&limit=200',
      // POST { name, visibility } makes a project.
      create: '/v1/code/channels',
      // PATCH { topic } sets the description, { context_sources } the
      // linked folders, { disabled: true } pauses the project.
      channel: '/v1/code/channels/{channel}',
      // PATCH with one setting at a time; system_prompt_addendum is the
      // instructions.
      config: '/v1/code/channels/{channel}/config',
      // A project file goes up in two steps. The bytes are uploaded to the
      // organization (POST multipart "file"), which answers with an id; then
      // files:write puts up to ten such uploads at their paths.
      upload: '/api/{org}/upload?store_as_is=true',
      filesWrite: '/v1/code/channels/{channel}/files:write',
      filesList: '/v1/code/channels/{channel}/files:list',
      page: '/code/project/{channel}',
    },
  };

  // files:write takes this many files, and this many bytes, in one request.
  const WRITE_BATCH = 10;
  const WRITE_BATCH_BYTES = 100 * 1024 * 1024;

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

  function firstString(...values) {
    for (const v of values) {
      if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
  }

  function idOf(obj) {
    for (const v of [obj?.uuid, obj?.id]) {
      if (typeof v === 'string' && v) return v;
    }
    return null;
  }

  // Fills the {name} placeholders found in `vars`.
  function fill(template, vars) {
    return template.replace(/\{(\w+)\}/g, (whole, key) =>
      Object.hasOwn(vars, key) ? encodeURIComponent(vars[key]) : whole
    );
  }

  // Single objects come back inside a one-key envelope such as
  // {"channel":{...}} or {"config":{...}}. This returns the object inside.
  function unwrap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

    const keys = Object.keys(value);
    if (keys.length !== 1) return value;

    const inner = value[keys[0]];
    return inner && typeof inner === 'object' && !Array.isArray(inner)
      ? inner
      : value;
  }

  // Collapses text to a single line of at most `max` characters.
  function excerpt(text, max = 200) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max)}\u2026` : s;
  }

  // The same rule the exporter uses to make a name a disk can hold.
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

  function sizeText(bytes) {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

  // ============================================================
  // Requests
  // ============================================================

  // Failures worth waiting out and trying again, and how long to wait
  // before each retry when the server doesn't say. Being told to slow down
  // (429) is waited out for longer: it is the likeliest thing to happen to
  // many uploads in a row, and it always means "not yet", never "no".
  const RETRY_STATUS = new Set([500, 502, 503, 504, 529]);
  const RETRY_WAITS = [2000, 5000, 15000];
  const SLOW_DOWN_WAITS = [2000, 5000, 10000, 15000, 15000, 15000, 15000, 15000];

  // The server's own explanation for refusing a request: `why` is a line
  // for people, `reason` the short code it gave, if any. Error bodies look
  // like {"error":{"message":"...","reason":"..."}}; uploads put their code in
  // error.error_code or error.details.error_code.
  function refusal(status, bodyText) {
    let message = '';
    let reason = '';

    try {
      const err = JSON.parse(bodyText)?.error;
      message = firstString(err?.message);
      reason = firstString(err?.reason, err?.error_code, err?.details?.error_code);
    } catch {}

    if (!message && !reason) message = excerpt(bodyText, 200);

    const detail = [message, reason].filter(Boolean).join(' \u2014 ');
    return { why: `HTTP ${status}${detail ? `: ${detail}` : ''}`, reason };
  }

  // Sends one request and never throws. Resolves to
  //   { ok: true, status, data, attempts }
  //   { ok: false, status, why, reason, unsure, attempts }
  //
  // `repeatable` says whether sending the same request twice is harmless.
  // Reading is; so is setting something to a value. Creating something is
  // not, so those requests are only sent again when the server answers 429,
  // which means it turned the request away without acting on it.
  //
  // `unsure` is true when a request failed in a way that leaves open
  // whether the server acted on it: no reply at all, or a server error.
  async function send(url, {
    method = 'GET', headers = {}, json, form, repeatable = true, timeoutMs = 60000,
  } = {}) {
    let failures = 0; // retries spent on errors
    let slowDowns = 0; // retries spent on 429s

    for (let attempts = 1; ; attempts++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let failure;
      let wait;

      try {
        const r = await fetch(url, {
          method,
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            ...headers,
            ...(json !== undefined && { 'Content-Type': 'application/json' }),
          },
          ...(json !== undefined && { body: JSON.stringify(json) }),
          // No Content-Type here: the browser writes it, with the boundary.
          ...(form !== undefined && { body: form }),
          signal: ctrl.signal,
        });

        const text = await r.text();

        if (r.ok) {
          let data = null;

          if (text.trim()) {
            try {
              data = JSON.parse(text);
            } catch {
              return {
                ok: false,
                status: r.status,
                why: `HTTP ${r.status}, but the reply was not JSON`,
                reason: '',
                unsure: true,
                attempts,
              };
            }
          }

          return { ok: true, status: r.status, data, attempts };
        }

        failure = {
          ok: false,
          status: r.status,
          ...refusal(r.status, text),
          unsure: r.status >= 500,
          attempts,
        };

        if (r.status === 429) {
          if (slowDowns >= SLOW_DOWN_WAITS.length) return failure;
          wait = SLOW_DOWN_WAITS[slowDowns++];
        } else {
          if (!repeatable || !RETRY_STATUS.has(r.status) || failures >= RETRY_WAITS.length) return failure;
          wait = RETRY_WAITS[failures++];
        }

        const retryAfter = Number(r.headers.get('retry-after'));
        if (retryAfter > 0) wait = Math.min(retryAfter, 60) * 1000;
      } catch (e) {
        failure = {
          ok: false,
          status: 0,
          why: ctrl.signal.aborted
            ? `no reply within ${Math.round(timeoutMs / 1000)} seconds`
            : `network error (${e?.message || e})`,
          reason: '',
          unsure: true,
          attempts,
        };

        if (!repeatable || failures >= RETRY_WAITS.length) return failure;
        wait = RETRY_WAITS[failures++];
      } finally {
        clearTimeout(timer);
      }

      console.warn(
        `Claude importer: ${failure.why}. Trying again in ${Math.round(wait / 1000)} s: ${url}`
      );
      await sleep(wait);
    }
  }

  // Requests to /api/: the signed-in cookie is all they need.
  const api = (url, options) => send(url, options);

  // Requests to /v1/ carry the headers claude.ai's own pages send there.
  // anthropic-version is required: without it every /v1/ path answers
  // 400 "anthropic-version: header is required". x-organization-uuid names
  // the organization the request is for.
  const v1 = (org, url, options = {}) =>
    send(url, {
      ...options,
      headers: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'ccr-byoc-2025-07-29',
        'anthropic-client-feature': 'ccr',
        'x-organization-uuid': org.uuid,
        ...options.headers,
      },
    });

  // How long to give an upload: the site allows itself the same.
  const uploadTimeout = bytes => 30000 + Math.ceil(bytes * 4000 / 1048576);

  // A copy of `file` under another name, as one part of an upload.
  function uploadForm(file, name, type = file.type || '') {
    const form = new FormData();
    form.append('file', new File([file], name, { type }), name);
    return form;
  }

  // ============================================================
  // The export folder
  // ============================================================

  const MANIFEST = 'export.json';

  // The file at `path` ("Files/state/notes.md") under the folder `root`,
  // or null when there is no such file.
  async function fileAt(root, path) {
    const parts = String(path ?? '').split('/');
    if (parts.some(p => p === '' || p === '.' || p === '..')) return null;

    try {
      let dir = root;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);

      const handle = await dir.getFileHandle(parts[parts.length - 1]);
      return await handle.getFile();
    } catch (e) {
      if (e?.name === 'NotFoundError' || e?.name === 'TypeMismatchError') return null;
      throw e;
    }
  }

  // The manifest in `dir`, or null when it has none.
  async function readManifest(dir) {
    const file = await fileAt(dir, MANIFEST);
    if (!file) return null;

    let manifest;
    try {
      manifest = JSON.parse(await file.text());
    } catch {
      throw new Error(`${dir.name}/${MANIFEST} is damaged (it is not valid JSON). Export the project again.`);
    }

    if (!manifest || typeof manifest !== 'object' || manifest.format !== 'claude-project-export') {
      throw new Error(`${dir.name}/${MANIFEST} was not written by the Claude project exporter.`);
    }

    if (!(manifest.version >= 1) || manifest.version >= 2) {
      throw new Error(
        `${dir.name} was exported in a format this importer does not know ` +
        `(version ${manifest.version}). Use the importer that came with that exporter.`
      );
    }

    if (manifest.kind !== 'code' && manifest.kind !== 'standard') {
      throw new Error(`${dir.name}/${MANIFEST} does not say what kind of project this is.`);
    }

    return manifest;
  }

  // True when `dir` holds what every export has held, with or without a
  // manifest: it was made by an exporter from before there was one.
  async function looksLikeOldExport(dir) {
    for (const name of ['Project Instructions.md', 'Channel Info.md', 'Timeline.md']) {
      if (await fileAt(dir, name).catch(() => null)) return true;
    }

    return false;
  }

  // Every export in the folder that was picked: the folder itself when it
  // is one, otherwise the folders directly inside it that are.
  async function findExports(picked) {
    const here = await readManifest(picked);
    if (here) return [{ dir: picked, manifest: here }];

    const found = [];
    let old = (await looksLikeOldExport(picked)) ? picked.name : '';

    for await (const entry of picked.values()) {
      if (entry.kind !== 'directory') continue;

      try {
        const manifest = await readManifest(entry);

        if (manifest) found.push({ dir: entry, manifest });
        else if (!old && await looksLikeOldExport(entry)) old = entry.name;
      } catch (e) {
        console.warn(`Claude importer: skipping the folder "${entry.name}"`, e);
      }
    }

    if (!found.length) {
      throw new Error(
        old
          ? `"${old}" looks like an export, but it has no ${MANIFEST}: it was made with an ` +
            'older exporter, or the export did not finish. Export the project again ' +
            '(cswap project-move export) and import that folder.'
          : `There is no export in "${picked.name}". Choose the folder the exporter made: ` +
            `the one that holds ${MANIFEST}.`
      );
    }

    return found;
  }

  function chooseExport(found) {
    if (found.length === 1) return found[0];

    const list = found
      .map((f, i) =>
        `${i + 1}. ${firstString(f.manifest.name) || f.dir.name}` +
        (f.manifest.kind === 'code' ? '  [code]' : ''))
      .join('\n');

    const answer = prompt(
      `This folder holds ${found.length} exports. Which one should be imported?\n\n${list}\n\nEnter a number:`,
      '1'
    );

    if (answer == null) return null;

    const pick = found[Number(answer) - 1];
    if (!pick) throw new Error('Invalid export number.');
    return pick;
  }

  // ============================================================
  // Where the project goes, and what it is called
  // ============================================================

  // An account that also uses the developer API has a second, API-only
  // organization. It holds no claude.ai projects.
  const apiOnly = org =>
    Array.isArray(org?.capabilities) &&
    org.capabilities.includes('api') &&
    !org.capabilities.includes('chat');

  // The organization claude.ai is showing in this browser.
  function activeOrgId() {
    const m = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);

    try {
      return m ? decodeURIComponent(m[1]) : '';
    } catch {
      return '';
    }
  }

  function chooseOrg(orgs) {
    const usable = orgs.filter(org => org?.uuid && !apiOnly(org));

    if (!usable.length) {
      throw new Error('This login has no Claude organization that can hold projects.');
    }
    if (usable.length === 1) return usable[0];

    const active = usable.findIndex(org => org.uuid === activeOrgId());
    const list = usable.map((o, i) => `${i + 1}. ${o.name || o.uuid}`).join('\n');
    const answer = prompt(
      `Which organization should the new project be created in?\n\n${list}\n\nEnter a number:`,
      String(active >= 0 ? active + 1 : 1)
    );

    if (answer == null) return null;

    const org = usable[Number(answer) - 1];
    if (!org) throw new Error('Invalid organization number.');
    return org;
  }

  // The projects of this kind that this login can see: their names in
  // lower case, so the new one can be offered a name that is not taken, and
  // their ids, so it can be said when the original is among them. If the
  // list cannot be read, both are empty.
  async function projectsInView(kind, org) {
    const res = kind === 'code'
      ? await v1(org, ENDPOINTS.code.list)
      : await api(fill(ENDPOINTS.standard.list, { org: org.uuid }));

    const names = new Set();
    const ids = new Set();

    if (res.ok) {
      for (const p of asArray(res.data)) {
        if (typeof p?.name === 'string') names.add(p.name.trim().toLocaleLowerCase());
        if (idOf(p)) ids.add(idOf(p));
      }
    }

    return { names, ids };
  }

  function freeName(name, taken) {
    if (!taken.has(name.trim().toLocaleLowerCase())) return name;

    for (let n = 1; ; n++) {
      const candidate = `${name} (imported${n > 1 ? ` ${n}` : ''})`;
      if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
    }
  }

  // Says what is about to be created and asks what to call it. Resolves to
  // the name, or null if the person pressed Cancel.
  async function askName({ dir, manifest }, org, severalOrgs) {
    const isCode = manifest.kind === 'code';
    const original = firstString(manifest.name) || dir.name;
    const files = asArray(manifest.files);
    const history = IMPORT_HISTORY
      ? asArray(manifest.history).length + (manifest.memory?.path ? 1 : 0)
      : 0;

    const gets = [];
    if (firstString(manifest.description)) gets.push('its description');
    if (firstString(manifest.instructions)) gets.push('its instructions');
    if (isCode) gets.push('its settings');
    if (files.length) gets.push(plural(files.length, 'file'));
    if (history) gets.push(`${plural(history, 'saved conversation')} as reference files`);

    const inView = await projectsInView(manifest.kind, org);
    const suggested = freeName(original, inView.names);

    // A project is usually imported to move it to another account. When the
    // one it was exported from is in view, this browser is most likely
    // still signed in as the account it came from.
    const sourceId = firstString(manifest.source?.id);
    const originalInView = Boolean(sourceId) && inView.ids.has(sourceId);

    const answer = prompt(
      [
        `Import \u201c${original}\u201d as a NEW ${isCode ? 'Claude Code project' : 'project'}` +
          `${severalOrgs ? ` in \u201c${org.name || org.uuid}\u201d` : ''}?`,
        ...(originalInView
          ? [
              '',
              'Note: the project this was exported from can be seen from this login. To copy it ' +
                'to another account, press Cancel and sign in to claude.ai as that account first.',
            ]
          : []),
        '',
        `It will get ${gets.length ? gets.join(', ') : 'only its name'}.`,
        'It will be private. Nothing that exists now is changed.',
        ...(isCode
          ? [
              '',
              PAUSE_WHEN_DONE
                ? 'A Claude Code project has its own Claude. The project is paused when the import ' +
                  'ends, so that Claude starts nothing until you open the project and press Resume.'
                : 'A Claude Code project has its own Claude, which starts with the project.',
            ]
          : []),
        '',
        'Name for the new project (Cancel stops here):',
      ].join('\n'),
      suggested
    );

    if (answer == null) return null;
    return answer.trim() || suggested;
  }

  // ============================================================
  // What was done
  // ============================================================

  // One row per thing the import did or could not do. `result` is one of
  //   created, set, added     done as asked
  //   moved                   added, but not where it was
  //   left out                skipped on purpose
  //   not set, not added      failed
  //   to check                the site took it but does not list it
  function makeReport() {
    const rows = [];

    return {
      rows,
      created: null, // { id, url, name } once the project exists
      add(group, item, result, detail = '', extra = {}) {
        const row = { group, item, result, detail, ...extra };
        rows.push(row);
        return row;
      },
      count(group, ...results) {
        return rows.filter(r => r.group === group && results.includes(r.result)).length;
      },
      problems() {
        return rows.filter(r => r.result === 'not set' || r.result === 'not added');
      },
    };
  }

  // Why a project could not be created, as an Error to show the person.
  function creationError(res) {
    return new Error(
      res.unsure
        ? `The request to create the project got no clear answer (${res.why}). It may have ` +
          'been created all the same: look in your projects before trying again.'
        : `The site refused to create the project: ${res.why}.`
    );
  }

  // Stops a long run of the same failure: after `limit` failures in a row
  // the rest are not tried.
  function makeBreaker(limit) {
    let inARow = 0;

    return {
      get open() { return inARow >= limit; },
      note(ok) { inARow = ok ? 0 : inARow + 1; },
    };
  }

  // ============================================================
  // Import a regular project
  // ============================================================

  // File extensions by type, for a copy whose type is not its name's.
  const EXTENSION = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf',
  };

  // The name to upload a copy under. A copy Claude made of a file can be
  // of another type than the file (a WebP preview of a HEIC photo), and
  // then the name has to say what the bytes are.
  function nameForCopy(name, mime) {
    const ext = EXTENSION[String(mime || '').toLowerCase().split(';')[0].trim()];
    if (!ext) return name;

    const dot = name.lastIndexOf('.');
    const current = dot > 0 ? name.slice(dot).toLowerCase() : '';

    if (current === ext || (current === '.jpeg' && ext === '.jpg')) return name;
    return `${dot > 0 ? name.slice(0, dot) : name}${ext}`;
  }

  async function importStandardProject({ dir, manifest }, org, name, report) {
    const E = ENDPOINTS.standard;
    const description = firstString(manifest.description);
    const instructions = firstString(manifest.instructions);

    // 1. The project itself. Always private.
    setStatus('Creating the project\u2026');

    const base = {
      name,
      is_private: true,
      is_starred: manifest.settings?.is_starred === true,
    };
    const create = body =>
      api(fill(E.create, { org: org.uuid }), { method: 'POST', json: body, repeatable: false });

    let created = await create({ ...base, description });
    let describeLater = false;

    // The description may be what was refused: create without, add it after.
    if (!created.ok && created.status === 400 && description) {
      const plain = await create({ ...base, description: '' });

      if (plain.ok || plain.unsure) {
        created = plain;
        describeLater = true;
      }
    }

    if (!created.ok) throw creationError(created);

    const projectId = idOf(created.data);
    if (!projectId) {
      throw new Error(
        'The site says the project was created, but not which one it is. Look for it in your projects.'
      );
    }

    const vars = { org: org.uuid, project: projectId };
    report.created = { id: projectId, name, url: new URL(fill(E.page, vars), location.origin).href };
    report.add('project', 'Project', 'created', name);

    // 2. Its description, if that had to wait, and its instructions.
    for (const [field, label, value] of [
      ['description', 'Description', describeLater ? description : ''],
      ['prompt_template', 'Instructions', instructions],
    ]) {
      if (!value) continue;

      const res = await api(fill(E.project, vars), { method: 'PUT', json: { [field]: value } });
      report.add('setting', label, res.ok ? 'set' : 'not set', res.ok ? '' : res.why);
    }

    // 3. Its knowledge: text documents and files, then the saved
    //    conversations as more documents.
    const todo = [];

    for (const row of asArray(manifest.files)) {
      if (typeof row?.path !== 'string' || typeof row?.name !== 'string') continue;

      todo.push(
        row.type === 'doc'
          ? { group: 'file', label: row.name, from: row.path, doc: row.name }
          : { group: 'file', label: row.name, from: row.path, copy: row.copy, mime: row.mime }
      );
    }

    if (IMPORT_HISTORY) {
      if (typeof manifest.memory?.path === 'string') {
        todo.push({
          group: 'history',
          label: 'Project memory',
          from: manifest.memory.path,
          doc: 'Project memory (from the original project).md',
        });
      }

      const used = new Set();

      for (const row of asArray(manifest.history)) {
        if (typeof row?.path !== 'string') continue;

        // Named after the chat's folder, which is its title made safe for a
        // disk; kept short, and kept apart from any other of the same name.
        const parts = row.path.split('/');
        const title = excerpt(parts.length > 2 ? parts[parts.length - 2] : firstString(row.title) || 'chat', 100);
        let doc = `Chat history \u2013 ${title}.md`;

        for (let n = 2; used.has(doc.toLocaleLowerCase()); n++) {
          doc = `Chat history \u2013 ${title} (${n}).md`;
        }
        used.add(doc.toLocaleLowerCase());

        todo.push({
          group: 'history',
          label: `Chat \u201c${firstString(row.title) || title}\u201d`,
          from: row.path,
          doc,
        });
      }
    }

    const breaker = makeBreaker(5);

    for (let i = 0; i < todo.length; i++) {
      const item = todo[i];
      showProgress(`Adding ${i + 1}/${todo.length}: ${excerpt(item.label, 60)}`);

      if (breaker.open) {
        report.add(item.group, item.label, 'not added', 'not tried: the five before it all failed');
        continue;
      }

      if (item.copy === 'thumbnail') {
        report.add(item.group, item.label, 'left out',
          'the export holds only a thumbnail of this file, not the file');
        continue;
      }

      let file;
      try {
        file = await fileAt(dir, item.from);
      } catch (e) {
        report.add(item.group, item.label, 'not added', `could not be read (${e?.message || e})`);
        continue;
      }

      if (!file) {
        report.add(item.group, item.label, 'not added', `it is not in the export folder (${item.from})`);
        continue;
      }

      let res;
      let uploadedAs = item.doc;

      if (item.doc) {
        let content;
        try {
          content = await file.text();
        } catch (e) {
          report.add(item.group, item.label, 'not added', `could not be read (${e?.message || e})`);
          continue;
        }

        res = await api(fill(E.docs, vars), {
          method: 'POST',
          json: { file_name: item.doc, content },
          repeatable: false,
          timeoutMs: uploadTimeout(file.size),
        });
      } else if (file.size > MAX_UPLOAD_BYTES) {
        report.add(item.group, item.label, 'left out',
          `larger than ${sizeText(MAX_UPLOAD_BYTES)} (${sizeText(file.size)}); add it by hand`);
        continue;
      } else {
        const original = !item.copy || item.copy === 'original';
        uploadedAs = original ? item.label : nameForCopy(item.label, item.mime);

        res = await api(fill(E.upload, vars), {
          method: 'POST',
          form: uploadForm(file, uploadedAs, original ? undefined : firstString(item.mime) || undefined),
          repeatable: false,
          timeoutMs: uploadTimeout(file.size),
        });
      }

      breaker.note(res.ok);

      const note = item.doc || !item.copy || item.copy === 'original'
        ? ''
        : `the export holds Claude\u2019s ${item.copy} copy of this file, not the file itself; ` +
          `that copy was added${uploadedAs === item.label ? '' : ` as ${uploadedAs}`}`;

      report.add(
        item.group,
        item.label,
        res.ok ? 'added' : 'not added',
        res.ok ? note : `${res.why}${res.unsure ? ' (it may have been added all the same)' : ''}`,
        {
          kind: item.doc ? 'doc' : 'file',
          sentAs: uploadedAs,
          id: res.ok ? firstString(res.data?.uuid, res.data?.file_uuid) : '',
          unsure: !res.ok && res.unsure,
        }
      );
    }

    // 4. Look at what the project now holds, and square the list with it.
    setStatus('Checking the new project\u2026');

    const [docs, files] = await Promise.all([
      api(`${fill(E.docs, vars)}?compact=true`),
      api(fill(E.files, vars)),
    ]);

    if (!docs.ok || !files.ok) {
      report.add('check', 'Check of the new project', 'not set',
        `its contents could not be listed (${(docs.ok ? files : docs).why})`);
      return;
    }

    const listed = [
      ...asArray(docs.data).map(d => ({ kind: 'doc', id: d?.uuid, name: d?.file_name })),
      ...asArray(files.data).map(f => ({ kind: 'file', id: f?.file_uuid, name: f?.file_name })),
    ];
    const take = match => {
      const at = listed.findIndex(match);
      return at >= 0 ? listed.splice(at, 1)[0] : null;
    };

    for (const row of report.rows) {
      if (!row.kind) continue;

      if (row.result === 'added') {
        const there = row.id
          ? take(x => x.kind === row.kind && x.id === row.id)
          : take(x => x.kind === row.kind && x.name === row.sentAs);

        if (!there) {
          row.result = 'to check';
          row.detail = 'the site accepted it, but the project does not list it (yet)';
        }
      } else if (row.unsure && take(x => x.kind === row.kind && x.name === row.sentAs)) {
        row.result = 'added';
        row.detail = 'the reply was lost, but the project lists it';
      }
    }
  }

  // ============================================================
  // Import a Claude Code project
  // ============================================================

  // The id files:write wants for an upload. The upload answers with a
  // UUID; the id is "file_", then whatever sits between the project id's
  // "chan_" and its last part, then "01" and the UUID written as a
  // 22-digit number in base 58.
  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  function taggedFileId(uuid, channelId) {
    const hex = String(uuid ?? '').replace(/-/g, '');
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) return '';

    const parts = String(channelId ?? '').split('_');
    if (parts.length < 2 || parts[parts.length - 1].length !== 24) return '';

    let number = BigInt(`0x${hex}`);
    let digits = '';

    for (let i = 0; i < 22; i++) {
      digits = BASE58[Number(number % 58n)] + digits;
      number /= 58n;
    }

    const middle = parts.slice(1, -1).join('_');
    return `file_${middle ? `${middle}_` : ''}01${digits}`;
  }

  // What files:write says about one file, in plain words.
  const WRITE_REASONS = {
    project_file_write_rejected: 'something is already at that path',
    invalid_path: 'the site does not accept that path',
    project_file_path_reserved: 'the site keeps that path for itself',
    source_file_unavailable: 'the site could not find the upload again',
    source_file_no_name: 'the site could not find the upload again',
    source_file_too_large: 'the file is too large',
    upload_too_large: 'the file is too large',
    project_files_storage_limit: 'the project\u2019s file storage is full',
    duplicate_destination: 'two files were sent to the same path',
    result_missing: 'the site gave no result for it',
  };

  const reasonText = reason =>
    WRITE_REASONS[reason] ? `${WRITE_REASONS[reason]} (${reason})` : `refused: ${reason}`;

  // Reasons that are worth one more try: the same again, with a fresh
  // upload, or at another path.
  const TRY_AGAIN = new Set(['write_failed', 'not_attempted', 'source_fetch_failed']);
  const UPLOAD_AGAIN = new Set(['source_file_unavailable', 'source_file_no_name']);
  const PUT_ELSEWHERE = new Set(['project_file_write_rejected', 'invalid_path', 'project_file_path_reserved']);

  // Reasons for refusing a whole files:write request that will be the same
  // for every other file: the project is not taking files at all.
  const NO_FILES_AT_ALL = new Set([
    'project_files_write_disabled', 'project_files_write_confined', 'channel_disabled',
  ]);

  const stripSlashes = path => String(path ?? '').replace(/^\/+/, '');

  // Puts files into a Claude Code project. Each of `wanted` is
  //   { group, label, to, from }   a file in the export folder, or
  //   { group, label, to, file }   a File made here,
  // where `to` is the path it should have in the project.
  async function putFiles({ org, channelId, dir, report }, wanted) {
    const E = ENDPOINTS.code;
    const writeUrl = fill(E.filesWrite, { channel: channelId });
    let stopped = ''; // why the project takes no more files, once it doesn't
    let failedCalls = 0;

    // Step one for one file: upload its bytes. Resolves to { fileId, bytes }
    // or to { why } (with leftOut when it was skipped on purpose).
    const stage = async item => {
      let file = item.file;

      if (!file) {
        try {
          file = await fileAt(dir, item.from);
        } catch (e) {
          return { why: `could not be read (${e?.message || e})` };
        }

        if (!file) return { why: `it is not in the export folder (${item.from})` };
      }

      if (file.size > MAX_UPLOAD_BYTES) {
        return {
          leftOut: true,
          why: `larger than ${sizeText(MAX_UPLOAD_BYTES)} (${sizeText(file.size)}); add it by hand`,
        };
      }

      // Uploading twice only leaves a spare upload behind, so it can repeat.
      const res = await api(fill(E.upload, { org: org.uuid }), {
        method: 'POST',
        form: uploadForm(file, item.to.slice(item.to.lastIndexOf('/') + 1)),
        timeoutMs: uploadTimeout(file.size),
      });

      if (!res.ok) return { why: `the upload was refused: ${res.why}` };

      if (res.data?.text_extracted === true) {
        return { why: 'the site kept only the text of this file, not the file itself' };
      }

      const fileId = taggedFileId(res.data?.file_uuid, channelId);
      if (!fileId) return { why: 'the site\u2019s reply to the upload could not be used' };

      return { fileId, bytes: file.size };
    };

    const failed = (items, why, unsure = false) => {
      for (const s of items) {
        report.add(s.group, s.label, 'not added', why, { path: s.path, bytes: s.bytes, unsure });
      }
    };

    // Step two: one files:write request that puts `items`, each an upload
    // with the path it should get, in place. Resolves to the ones that are
    // worth another try (none when `lastTry` is set).
    const writeOnce = async (items, lastTry) => {
      const res = await v1(org, writeUrl, {
        method: 'POST',
        json: { files: items.map(s => ({ path: s.path, source_file_id: s.fileId })) },
        timeoutMs: 150000,
      });

      if (!res.ok) {
        // The project takes no files at all: the rest need not be tried.
        if (NO_FILES_AT_ALL.has(res.reason) || [401, 403, 404].includes(res.status)) {
          stopped = `not tried: the project is not taking files (${res.why})`;
          failed(items, res.why);
          return [];
        }

        // Something in this request was refused. Sending its files one at
        // a time shows which, and lets the others through.
        if (!res.unsure && res.status !== 429 && items.length > 1) {
          const again = [];

          for (const s of items) {
            if (stopped) failed([s], stopped);
            else again.push(...await writeOnce([s], lastTry));
          }

          return again;
        }

        failed(items, res.why, res.unsure);

        if (++failedCalls >= 5) {
          stopped = `not tried: the five requests before it all failed (${res.why})`;
        }
        return [];
      }

      failedCalls = 0;

      const results = asArray(res.data?.results);
      const again = [];

      for (const [i, s] of items.entries()) {
        const r = results[i];
        const reason = !r || (r.path && stripSlashes(r.path) !== stripSlashes(s.path))
          ? 'result_missing'
          : firstString(r.error_reason);

        // "Already there" in answer to a request that had to be sent twice
        // means the first sending put it there.
        if (!reason || (reason === 'project_file_write_rejected' && res.attempts > 1)) {
          report.add(
            s.group,
            s.label,
            s.path === s.to ? 'added' : 'moved',
            s.path === s.to ? '' : `put at ${s.path}, because at its own path ${reasonText(s.displacedBy)}`,
            { path: s.path, bytes: s.bytes }
          );
          continue;
        }

        if (!lastTry) {
          if (TRY_AGAIN.has(reason)) {
            again.push(s);
            continue;
          }

          if (UPLOAD_AGAIN.has(reason)) {
            const fresh = await stage(s);

            if (!fresh.why) {
              again.push({ ...s, ...fresh });
              continue;
            }
          }

          if (PUT_ELSEWHERE.has(reason)) {
            const elsewhere =
              `${DISPLACED_FOLDER}/${s.to.split('/').map(part => safeName(part, '\u2013')).join('/')}`;

            if (elsewhere !== s.path) {
              again.push({ ...s, path: elsewhere, displacedBy: reason });
              continue;
            }
          }
        }

        if (reason === 'project_files_storage_limit') {
          stopped = 'not tried: the project\u2019s file storage is full';
        }

        failed([s], reasonText(reason));
      }

      return again;
    };

    const write = async staged => {
      const again = await writeOnce(staged.map(s => ({ ...s, path: s.to })), false);

      if (!again.length) return;

      if (stopped) failed(again, stopped);
      else await writeOnce(again, true);
    };

    let staged = [];
    let stagedBytes = 0;

    for (let i = 0; i < wanted.length; i++) {
      const item = wanted[i];

      if (stopped) {
        report.add(item.group, item.label, 'not added', stopped);
        continue;
      }

      showProgress(`Adding file ${i + 1}/${wanted.length}: ${excerpt(item.to, 60)}`);

      const got = await stage(item);

      if (got.why) {
        report.add(item.group, item.label, got.leftOut ? 'left out' : 'not added', got.why);
      } else {
        staged.push({ ...item, ...got });
        stagedBytes += got.bytes;
      }

      const last = i === wanted.length - 1;

      if (staged.length && (last || staged.length >= WRITE_BATCH || stagedBytes >= WRITE_BATCH_BYTES)) {
        await write(staged);
        staged = [];
        stagedBytes = 0;
      }
    }
  }

  // Every file in a Claude Code project, as a Map of path -> size in bytes,
  // or null if the list could not be read to its end.
  async function listProjectFiles(org, channelId) {
    const url = fill(ENDPOINTS.code.filesList, { channel: channelId });
    const sizes = new Map();
    const seen = new Set();
    let cursor = '';

    for (;;) {
      // A POST, but one that only reads.
      const res = await v1(org, url, {
        method: 'POST',
        json: { recursive: true, limit: 500, ...(cursor && { cursor }) },
      });

      if (!res.ok) return null;

      for (const entry of asArray(res.data?.entries)) {
        if (typeof entry?.path !== 'string' || entry.is_directory === true) continue;
        sizes.set(stripSlashes(entry.path), Number(entry.size_bytes));
      }

      const next = firstString(res.data?.cursor);
      if (!next) return sizes;
      if (seen.has(next)) return null;

      seen.add(next);
      cursor = next;
    }
  }

  // The settings that are carried over, each sent by itself so that one
  // the new account cannot have does not hold back the others.
  const CONFIG_KEYS = [
    ['system_prompt_addendum', 'Instructions'],
    ['default_source_urls', 'Repositories'],
    ['default_model', 'Model for sessions'],
    ['channel_session_model', 'Model for the project\u2019s Claude'],
    ['default_effort_level', 'Effort level for sessions'],
    ['channel_session_effort_level', 'Effort level for the project\u2019s Claude'],
    ['limit_auto_continue', 'Limit on continuing automatically'],
  ];

  // Settings that are deliberately not carried over, and why. They are
  // grants or belong to one account, so they are yours to make again.
  const CONFIG_LEFT = [
    ['default_environment_id', 'Environment', v => typeof v === 'string' && v !== '',
      'the environment sessions run in belongs to the original account; choose one in the new project'],
    ['allow_worker_chrome', 'Browser access', v => v === true,
      'browser access for the project\u2019s Claude is a permission; grant it again in the new project if you want it'],
  ];

  const isSet = v =>
    v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);

  async function importCodeProject({ dir, manifest }, org, name, report) {
    const E = ENDPOINTS.code;
    const settings = manifest.settings && typeof manifest.settings === 'object' ? manifest.settings : {};
    const config = settings.config && typeof settings.config === 'object' ? settings.config : {};
    const description = firstString(manifest.description);
    const instructions = firstString(manifest.instructions, config.system_prompt_addendum);

    // 1. The project itself: private, and with nothing in it yet for its
    //    Claude to act on. (Created like this, that Claude starts up but
    //    takes no turn.) The description, instructions and repositories are
    //    added at the end, once the files are in place.
    setStatus('Creating the project\u2026');

    const look = {
      ...(firstString(settings.icon) && { icon: settings.icon }),
      ...(firstString(settings.color) && { color: settings.color }),
    };
    const create = body => v1(org, E.create, { method: 'POST', json: body, repeatable: false });

    let created = await create({ name, visibility: 'private', ...look });

    // Its icon or colour may be what was refused: create without them.
    if (!created.ok && created.status === 400 && Object.keys(look).length) {
      const refused = created;
      const plain = await create({ name, visibility: 'private' });

      if (plain.ok || plain.unsure) {
        created = plain;
        if (plain.ok) report.add('setting', 'Icon and colour', 'not set', refused.why);
      }
    }

    if (!created.ok) throw creationError(created);

    const channelId = idOf(unwrap(created.data));
    if (!channelId) {
      throw new Error(
        'The site says the project was created, but not which one it is. Look for it in your projects.'
      );
    }

    const cvars = { channel: channelId };
    report.created = { id: channelId, name, url: new URL(fill(E.page, cvars), location.origin).href };
    report.add('project', 'Project', 'created', name);

    if (firstString(settings.visibility) && settings.visibility !== 'private') {
      report.add('setting', 'Sharing', 'left out',
        `the original was shared (${settings.visibility}); the new project is private until you share it`);
    }

    // 2. Its own files, back at their own paths, then the saved
    //    conversations in a folder of their own.
    const wanted = [];
    const paths = new Set();

    const want = item => {
      if (paths.has(item.to)) {
        report.add(item.group, item.label, 'not added', `the export has two files for the path ${item.to}`);
        return;
      }

      paths.add(item.to);
      wanted.push(item);
    };

    for (const row of asArray(manifest.files)) {
      if (typeof row?.path !== 'string' || typeof row?.name !== 'string') continue;

      const to = stripSlashes(row.name);
      if (to) want({ group: 'file', label: to, from: row.path, to });
    }

    const history = IMPORT_HISTORY
      ? asArray(manifest.history).filter(row => typeof row?.path === 'string')
      : [];

    if (history.length) {
      // A folder of that name may already be among the project's files (an
      // export of a project that was itself imported): then use the next.
      const top = new Set([...paths].map(p => p.split('/')[0].toLocaleLowerCase()));
      let folder = HISTORY_FOLDER;

      for (let n = 2; top.has(folder.toLocaleLowerCase()); n++) {
        folder = `${HISTORY_FOLDER}-${n}`;
      }

      const original = firstString(manifest.name) || dir.name;
      const when = firstString(manifest.exported_at).slice(0, 10);

      want({
        group: 'history',
        label: 'Note explaining the saved conversations',
        to: `${folder}/README.md`,
        file: new File(
          [
            [
              '# Imported history',
              '',
              `These files are the saved conversations of \u201c${original}\u201d, the project this one was`,
              `imported from${when ? ` (exported ${when})` : ''}. They are a record to read: the threads and sessions`,
              'they describe are not live in this project.',
              '',
              '- Timeline.md: every top-level message, oldest first.',
              '- Threads/: one file per message that had replies, with all of them.',
              '- Sessions/: what was said and done in each Claude Code session.',
              '',
            ].join('\n'),
          ],
          'README.md',
          { type: 'text/markdown' }
        ),
      });

      for (const row of history) {
        want({
          group: 'history',
          label: `Saved conversation ${row.path}`,
          from: row.path,
          to: `${folder}/${row.path}`,
        });
      }
    }

    if (wanted.length) {
      setStatus(`Adding ${plural(wanted.length, 'file')}\u2026`);
      await putFiles({ org, channelId, dir, report }, wanted);
    }

    // 3. Its settings. The site passes each change on to the project's
    //    Claude as it is made, with a note that no reply is needed. That is
    //    how that Claude comes to know its instructions, and it only happens
    //    while the project is running: so the settings go in before the
    //    pause, not after it.
    setStatus('Applying the project\u2019s settings\u2026');

    for (const [key, label] of CONFIG_KEYS) {
      const value = key === 'system_prompt_addendum' ? instructions : config[key];
      if (!isSet(value)) continue;

      const res = await v1(org, fill(E.config, cvars), { method: 'PATCH', json: { [key]: value } });
      report.add('setting', label, res.ok ? 'set' : 'not set', res.ok ? '' : res.why);
    }

    for (const [key, label, present, why] of CONFIG_LEFT) {
      if (present(config[key])) report.add('setting', label, 'left out', why);
    }

    // 4. Its description and the folders linked to it. These come last
    //    because they are what the project's Claude goes by.
    const sources = asArray(settings.context_sources).filter(s => s && typeof s === 'object');

    for (const [label, body] of [
      ['Description', description && { topic: description }],
      [`Linked sources (${sources.length})`, sources.length && { context_sources: sources }],
    ]) {
      if (!body) continue;

      const res = await v1(org, fill(E.channel, cvars), { method: 'PATCH', json: body });
      report.add('setting', label, res.ok ? 'set' : 'not set', res.ok ? '' : res.why);
    }

    // 5. Pause it, so nothing happens in it until its owner says so. This
    //    has to follow the files (a paused project refuses them) and the
    //    settings (a paused project's Claude is not told of them). Pausing
    //    also stops that Claude in whatever the settings had it reading.
    if (PAUSE_WHEN_DONE) {
      const res = await v1(org, fill(E.channel, cvars), { method: 'PATCH', json: { disabled: true } });

      // Paused is what the answer shows, not what was asked for.
      const shown = res.ok ? res.data?.channel ?? unwrap(res.data) : null;
      report.paused = Boolean(shown?.disabled_at);
      report.add('setting', 'Pause', report.paused ? 'set' : 'not set',
        report.paused
          ? 'the project is paused until you open it and press Resume'
          : res.ok
            ? 'the site accepted the request, but its answer does not show the project as paused'
            : res.why);
    }

    // 6. Look at what the project now holds, and square the list with it.
    setStatus('Checking the new project\u2026');

    const sizes = await listProjectFiles(org, channelId);

    if (!sizes) {
      report.add('check', 'Check of the new project', 'not set', 'its files could not be listed');
      return;
    }

    for (const row of report.rows) {
      if (!row.path) continue;

      const size = sizes.get(row.path);

      if (row.result === 'added' || row.result === 'moved') {
        if (size === undefined) {
          row.result = 'to check';
          row.detail = 'the site accepted it, but the project does not list it (yet)';
        } else if (size !== row.bytes) {
          row.result = 'to check';
          row.detail = `it is ${sizeText(row.bytes)} in the export and ${sizeText(size)} in the project`;
        }
      } else if (row.unsure && size === row.bytes) {
        row.result = 'added';
        row.detail = 'the reply was lost, but the project lists it';
      }
    }
  }

  // ============================================================
  // UI
  // ============================================================

  let statusNode = null;
  let linkNode = null;

  function setStatus(text) {
    console.log('Claude importer:', text);
    if (statusNode) statusNode.textContent = text;
  }

  // Updates the status box without adding a line to the console, for
  // progress that changes many times a minute.
  function showProgress(text) {
    if (statusNode) statusNode.textContent = text;
  }

  function showLink(url) {
    if (!linkNode) return;

    linkNode.href = url;
    linkNode.textContent = 'Open the new project';
    linkNode.style.display = 'block';
  }

  function buildButton() {
    document.getElementById('claude-simple-importer')?.remove();

    const wrap = document.createElement('div');
    wrap.id = 'claude-simple-importer';

    // Bottom left, so it does not sit on the exporter's button.
    Object.assign(wrap.style, {
      position: 'fixed',
      left: '18px',
      bottom: '18px',
      zIndex: '2147483647',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: '8px',
      fontFamily: 'system-ui, sans-serif',
    });

    statusNode = document.createElement('div');

    Object.assign(statusNode.style, {
      display: 'none',
      maxWidth: '460px',
      padding: '8px 10px',
      borderRadius: '8px',
      background: 'rgba(20,20,20,.92)',
      color: '#fff',
      fontSize: '12px',
    });

    linkNode = document.createElement('a');
    linkNode.target = '_blank';
    linkNode.rel = 'noopener';

    Object.assign(linkNode.style, {
      display: 'none',
      padding: '8px 10px',
      borderRadius: '8px',
      background: 'rgba(20,20,20,.92)',
      color: '#9cc7ff',
      fontSize: '12px',
    });

    const btn = document.createElement('button');
    btn.textContent = 'Import Claude Project';

    Object.assign(btn.style, {
      padding: '10px 14px',
      borderRadius: '10px',
      cursor: 'pointer',
      border: '1px solid rgba(127,127,127,.35)',
      background: '#f0eee6',
      color: '#222',
      fontWeight: '650',
    });

    wrap.append(statusNode, linkNode, btn);
    document.body.appendChild(wrap);

    return btn;
  }

  // The closing line, and the full account in the console.
  function finish(report) {
    const { name, url } = report.created;
    const done = (group, word, words) => {
      const all = report.rows.filter(r => r.group === group).length;
      if (!all) return '';

      const ok = report.count(group, 'added', 'moved');
      return ok === all ? plural(ok, word, words) : `${ok} of ${plural(all, word, words)}`;
    };

    const parts = [done('file', 'file'), done('history', 'history file')].filter(Boolean);
    const problems = report.problems().length;
    const toCheck = report.rows.filter(r => r.result === 'to check').length;
    const notes = report.rows.filter(r => r.result === 'left out' || r.result === 'moved').length;

    const sentences = [
      `Done \u2014 \u201c${name}\u201d was created${parts.length ? ` with ${parts.join(' and ')}` : ''}.`,
    ];

    if (problems) {
      sentences.push(`${plural(problems, 'item')} could not be imported; the console lists ${problems === 1 ? 'it' : 'them'}.`);
    }
    if (toCheck) {
      sentences.push(`${plural(toCheck, 'item')} should be checked in the project; the console lists ${toCheck === 1 ? 'it' : 'them'}.`);
    }
    if (notes && !problems && !toCheck) {
      sentences.push(`${plural(notes, 'item')} ${notes === 1 ? 'was' : 'were'} left out or moved on purpose; the console says why.`);
    }
    if (report.paused) {
      sentences.push('It is paused: open it and press Resume when you want its Claude to start.');
    }

    setStatus(sentences.join(' '));
    showLink(url);

    console.log(`Claude importer: the new project is at ${url}`);

    const worthShowing = report.rows.filter(r => !['created', 'set', 'added'].includes(r.result));

    if (worthShowing.length) {
      console.log('Claude importer: what was not simply added, and why:');
      console.table(worthShowing.map(({ item, result, detail }) => ({ item, result, detail })));
    }

    console.log(
      'Claude importer: everything that was done:',
      report.rows.map(({ group, item, result, detail }) => ({ group, item, result, detail }))
    );
  }

  // ============================================================
  // Run
  // ============================================================

  let orgs;

  try {
    const res = await api(ENDPOINTS.orgs);
    if (!res.ok) throw new Error(res.why);

    orgs = asArray(res.data).filter(org => org?.uuid);
    if (!orgs.length) throw new Error('no organizations were returned');
  } catch (e) {
    console.error(
      'Claude importer could not start. Run it in a claude.ai tab while signed in. ' +
      `(${e?.message || e})`
    );
    return;
  }

  const btn = buildButton();

  console.log(
    'Claude importer ready. Press \u201cImport Claude Project\u201d (bottom left) and choose a ' +
    'folder made by the exporter.'
  );

  let busy = false;

  btn.addEventListener('click', async () => {
    // One import at a time, however often the button is pressed.
    if (busy) return;
    busy = true;

    const report = makeReport();

    try {
      if (!window.showDirectoryPicker) {
        throw new Error('Use Chrome or Edge: this browser cannot open a folder.');
      }

      // This has to be the first thing the click does: the folder picker
      // only opens while the click still counts as a user gesture.
      let picked;
      try {
        picked = await window.showDirectoryPicker({ mode: 'read' });
      } catch (e) {
        if (e?.name === 'AbortError') return; // the picker was closed
        throw e;
      }

      linkNode.style.display = 'none';
      statusNode.style.display = 'block';
      setStatus('Reading the export\u2026');

      const found = chooseExport(await findExports(picked));
      const usable = orgs.filter(org => !apiOnly(org));
      const org = found && chooseOrg(orgs);
      const name = org && await askName(found, org, usable.length > 1);

      if (name == null) {
        setStatus('Nothing was imported.');
        return;
      }

      btn.disabled = true;

      const gaps = asArray(found.manifest.problems);

      if (gaps.length) {
        console.warn(
          'Claude importer: this export was itself incomplete. Its README lists what it could not get:\n' +
          gaps.map(gap => `  ${gap}`).join('\n')
        );
      }

      await (found.manifest.kind === 'code' ? importCodeProject : importStandardProject)(
        found, org, name, report
      );

      finish(report);
      btn.textContent = 'Import complete';
    } catch (e) {
      console.error('Claude importer failed:', e);
      statusNode.style.display = 'block';

      if (report.created) {
        // The project exists, so pressing the button again would make a
        // second one: the button stays off.
        statusNode.textContent =
          `The import stopped part-way (${e.message || e}). The new project \u201c${report.created.name}\u201d ` +
          'exists and holds whatever was added before that; the console lists it. ' +
          'To start over, delete that project first, then paste this script again.';
        showLink(report.created.url);
        console.log('Claude importer: what was done before it stopped:', report.rows);
      } else {
        statusNode.textContent = `Import failed: ${e.message || e}`;
        btn.disabled = false;
      }
    } finally {
      busy = false;
    }
  });
})();
