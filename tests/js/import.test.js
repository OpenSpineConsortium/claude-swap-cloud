'use strict';
// End-to-end checks of the project import script, run under Node against the
// mock claude.ai in mock_claude_ai.js: a project is exported with the export
// script, imported with the import script into the same (stateful) mock, and
// what the mock then holds is compared with what it held to begin with.
// `cswap project-move import` hands the import script to the user;
// tests/test_project_move_scripts.py runs this file as part of the Python
// suite when Node is installed.
// Usage: node tests/js/import.test.js [path/to/project-import.js] [path/to/project-export.js]

const path = require('path');
const assert = require('assert');
const { run, json, MemDir } = require('./harness');
const { pack, unpack } = require('./tar');
const {
  makeServer, v1Error, apiError, uuidFromTaggedId,
  ORG_CHAT, ORG_API, CHANNEL,
} = require('./mock_claude_ai');

const BROWSER = path.join(__dirname, '..', '..', 'src', 'claude_swap', 'browser');
const IMPORTER = path.resolve(process.argv[2] || path.join(BROWSER, 'project-import.js'));
const EXPORTER = path.resolve(process.argv[3] || path.join(BROWSER, 'project-export.js'));

const CODE_TAB = `/code/project/${CHANNEL}`;
const STD_TAB = '/project/aaaaaaaa-0000-4000-8000-000000000001';
const COOKIE = `theme=dark; lastActiveOrg=${ORG_CHAT}; other=1`;

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${String(e && (e.stack || e.message)).split('\n').slice(0, 14).join('\n        ')}`);
  }
}

const parse = text => JSON.parse(text);
const lines = (r, level) => r.logs.filter(l => !level || l.level === level).map(l => l.text);
const writes = r => r.requests.filter(q => q.method !== 'GET');
const bodyOf = q => parse(q.body);

// The channels and projects an import made in the mock.
const madeChannels = m => [...m.state.channels.values()].filter(c => c.created);
const madeProjects = m => [...m.state.projects.values()];

// The importer's own account of what it did: [{ group, item, result, detail }].
function account(r) {
  const tag = 'Claude importer: everything that was done: ';
  const line = lines(r, 'log').find(t => t.startsWith(tag));
  assert.ok(line, `no account in the console; status was: ${r.statusText}`);
  return parse(line.slice(tag.length));
}
const rowFor = (r, item) => account(r).find(row => row.item === item);

const exportOf = (m, tab, opts = {}) => run({ script: EXPORTER, pathname: tab, server: m.server, ...opts });

// Runs the importer. `pick` is the folder the person chooses; by default
// they accept the suggested name.
const importInto = (m, pick, opts = {}) =>
  run({ script: IMPORTER, pathname: '/new', server: m.server, pick, prompts: [''], cookie: COOKIE, ...opts });

// A fresh copy of one exported folder, optionally edited first. `edit`
// gets the folder as { 'relative/path': Buffer } and may change it.
function folder(exported, name, edit) {
  const tree = {};
  for (const [p, bytes] of Object.entries(exported.bytes)) {
    if (p.startsWith(`${name}/`)) tree[p.slice(name.length + 1)] = bytes;
  }
  if (edit) edit(tree);
  return MemDir.from(name, tree);
}

// Changes one of the importer's settings before it runs.
const setting = (name, value) => src => {
  const re = new RegExp(`const ${name} = [^;]+;`);
  assert.ok(re.test(src), `no setting ${name}`);
  return src.replace(re, `const ${name} = ${value};`);
};

// The site's own function for tagging an upload's id, copied from its
// front-end code as it was served (only the names are spelled out). The
// importer's ids have to equal what this produces.
function siteTaggedId(prefix, uuid, reference) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const r = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(r)) return;
  const i = reference.split('_');
  if (i.length < 2 || i[i.length - 1].length !== 24) return;
  const a = i.slice(1, -1).join('_');
  let o = BigInt('0x' + r);
  const s = [];
  for (let e = 0; e < 22; e++) { s.push(alphabet[Number(o % BigInt(58))]); o /= BigInt(58); }
  const c = `01${s.reverse().join('')}`;
  return a === '' ? `${prefix}_${c}` : `${prefix}_${a}_${c}`;
}

const V1_HEADERS = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'ccr-byoc-2025-07-29',
  'anthropic-client-feature': 'ccr',
  'x-organization-uuid': ORG_CHAT,
};

(async () => {
  console.log(`importer under test: ${path.relative(process.cwd(), IMPORTER)}`);
  console.log(`exports made with:   ${path.relative(process.cwd(), EXPORTER)}\n`);

  // One export of each kind, reused as the thing to import. Each test
  // imports it into a mock of its own.
  const source = makeServer();
  const exported = await exportOf(source, CODE_TAB);
  const exportedStd = await exportOf(makeServer(), STD_TAB);
  assert.match(exported.statusText, /^Done — 9 file/);
  assert.match(exportedStd.statusText, /^Done — 2 chats/);

  const codeFolder = edit => folder(exported, 'beethoven', edit);
  const stdFolder = edit => folder(exportedStd, 'Recipes', edit);
  const manifest = parse(exported.files['beethoven/export.json']);

  // ------------------------------------------------------------------
  console.log('1. A Claude Code project, there and back');

  const main = makeServer();
  const imp = await importInto(main, codeFolder());
  const [made] = madeChannels(main);
  const NEW = made ? made.record.id : '';

  await test('it loads, imports and reports success', async () => {
    assert.strictEqual(imp.loadError, null);
    assert.deepStrictEqual(lines(imp, 'error'), []);
    assert.deepStrictEqual(lines(imp, 'warn'), []);
    assert.strictEqual(imp.pickerCalls, 1);
    assert.strictEqual(JSON.stringify(imp.pickerOptions), '[{"mode":"read"}]'); // read-only access to the folder
    assert.strictEqual(
      imp.statusText,
      'Done — “beethoven (imported)” was created with 9 files and 29 history files. ' +
      '2 items were left out or moved on purpose; the console says why. ' +
      'The original project’s memory is in the new project’s memory (4 files). ' +
      'It is paused: open it and press Resume when you want its Claude to start.'
    );
    assert.strictEqual(imp.button.textContent, 'Import complete');
    assert.strictEqual(imp.button.disabled, true); // a second press would make a second project
  });

  await test('it says what it will do and asks for a name first', async () => {
    assert.strictEqual(imp.promptsShown.length, 1);
    assert.strictEqual(
      imp.promptsShown[0],
      [
        'Import “beethoven” as a NEW Claude Code project?',
        '',
        // The mock holds the project the export was made from, as the
        // account it came from would.
        'Note: the project this was exported from can be seen from this login. To copy it ' +
          'to another account, press Cancel and sign in to claude.ai as that account first.',
        '',
        'It will get its description, its instructions, its settings, 9 files, its memory (4 files), 28 saved conversations as reference files.',
        'It will be private. Nothing that exists now is changed.',
        '',
        'A Claude Code project has its own Claude. The project is paused when the import ends, ' +
          'so that Claude starts nothing until you open the project and press Resume.',
        '',
        'To carry on an import of this export that stopped part-way, give that project’s address instead.',
        '',
        'Name for the new project (Cancel stops here):',
      ].join('\n')
    );
    // Nothing is created before the answer: the only requests up to the
    // first write are reads.
    const firstWrite = imp.requests.findIndex(q => q.method !== 'GET');
    assert.deepStrictEqual(imp.requests.slice(0, firstWrite).map(q => q.path), [
      '/api/organizations',
      '/v1/code/channels?scope=joined&include_archived=true&limit=200',
    ]);
  });

  await test('exactly one project is made: private, named, with the same look', async () => {
    assert.strictEqual(madeChannels(main).length, 1);
    assert.strictEqual(madeProjects(main).length, 0);

    const creates = writes(imp).filter(q => q.method === 'POST' && q.path === '/v1/code/channels');
    assert.strictEqual(creates.length, 1);
    // Nothing in the request for the project's Claude to act on.
    assert.deepStrictEqual(bodyOf(creates[0]), {
      name: 'beethoven (imported)', visibility: 'private', icon: 'MusicNotes', color: 'purple',
    });

    assert.strictEqual(made.record.name, 'beethoven (imported)');
    assert.strictEqual(made.record.visibility, 'private');
    assert.strictEqual(made.record.icon, 'MusicNotes');
    assert.strictEqual(made.record.color, 'purple');
  });

  await test('creating it does not set its Claude to work', async () => {
    // The mock starts the agent on any project created with a description.
    assert.strictEqual(made.rows.length, 1);
    assert.ok(made.rows[0].body.includes('onboarding'));
    assert.ok(![...main.world.sessions.values()].some(s => s.title === 'Getting started on your goal'));

    // The same export, created the way the site's own dialog would, does.
    const eager = makeServer();
    await importInto(eager, codeFolder(), {
      patch: src => {
        const out = src.replace(
          "await create({ name, visibility: 'private', ...look });",
          "await create({ name, visibility: 'private', ...look, topic: 'Moved' });"
        );
        assert.notStrictEqual(out, src);
        return out;
      },
    });
    assert.strictEqual(madeChannels(eager)[0].rows.length, 2);
  });

  await test('every project file is back at its own path, byte for byte', async () => {
    for (const [name, bytes] of source.world.files) {
      const got = made.files.get(name);
      assert.ok(got, `missing ${name}`);
      assert.strictEqual(Buffer.compare(got, bytes), 0, name);
    }
    // Including the ones whose names had to change on disk.
    assert.strictEqual(made.files.get('weird/a:b?.md').toString(), 'colon and question mark\n');
    assert.strictEqual(made.files.get('weird/a–b–.md').toString(), 'already a safe name\n');
    assert.strictEqual(made.files.get('empty.txt').length, 0);
    assert.strictEqual(made.files.get('big/blob.bin').length, 70000);
  });

  await test('the saved conversations are added as files in a folder of their own', async () => {
    const history = [...made.files.keys()].filter(p => p.startsWith('imported-history/'));
    assert.strictEqual(history.length, 1 + manifest.history.length);
    // The project's memory goes into its memory, not among the files.
    assert.strictEqual([...made.files.keys()].length, source.world.files.size + history.length);

    for (const h of manifest.history) {
      const got = made.files.get(`imported-history/${h.path}`);
      assert.ok(got, h.path);
      assert.strictEqual(Buffer.compare(got, exported.bytes[`beethoven/${h.path}`]), 0, h.path);
    }

    const note = made.files.get('imported-history/README.md').toString();
    assert.ok(note.startsWith('# Imported history\n\nThese files are the saved conversations of “beethoven”'));
    assert.ok(note.includes(`(exported ${manifest.exported_at.slice(0, 10)})`));
    assert.ok(note.includes('are not live in this project'));
    // The raw logs stay on disk: only the readable files go up.
    assert.ok(!history.some(p => p.endsWith('.json')));

    // Each session is listed with the command that carries it on under
    // another account, in the spelling `claude --teleport` takes.
    const sessions = manifest.history.filter(h => h.type === 'session');
    assert.ok(sessions.length);
    for (const h of sessions) {
      const id = h.id.replace(/^cse_/, 'session_');
      assert.ok(note.includes(`- ${h.title}: \`cswap teleport --from <old> --to <new> ${id}\``), h.id);
    }
    assert.ok(!/cse_/.test(note));
  });

  await test('the project’s memory goes into the new project’s memory at its own paths, byte for byte', async () => {
    const memories = source.world.memories;
    assert.ok(memories.length >= 4 && memories.some(x => x.path.split('/').length > 2));

    const got = madeChannels(main)[0].memory.memories;
    assert.deepStrictEqual(got.map(x => [x.path, x.content]), memories.map(x => [x.path, x.content]));
    for (const memory of memories) {
      const row = rowFor(imp, `Project memory ${memory.path}`);
      assert.deepStrictEqual([row.group, row.result, row.detail], ['memory', 'added', ''], memory.path);
    }
    // None of it is among the files, or counted with them.
    assert.ok(![...made.files.keys()].some(p => p.startsWith('carried-memory')));
    assert.strictEqual(account(imp).filter(r => r.group === 'file' && r.result === 'added').length, 9);

    // One request per memory, in the memory API's shape, with the headers
    // the export's read of it had; the memory is listed before and after.
    const route = `/v1/code/memory/channel/${NEW}/memories`;
    const sent = writes(imp).filter(q => q.path === route);
    assert.deepStrictEqual(sent.map(bodyOf), memories.map(x => ({ path: x.path, content: x.content })));
    assert.ok(sent.every(q => q.headers['anthropic-beta'] === V1_HEADERS['anthropic-beta']));
    assert.deepStrictEqual(imp.requests.filter(q => q.method === 'GET' && q.path.startsWith(route)).map(q => q.path),
      [`${route}?limit=100`, `${route}?limit=100`, `${route}?limit=100&cursor=mcur_3`]);
    // Before the project's Claude is told anything, and before any file.
    const order = writes(imp).map(q => q.path);
    assert.ok(order.lastIndexOf(route) < order.findIndex(p => p.endsWith('/upload?store_as_is=true')));
    assert.ok(order.lastIndexOf(route) < order.findIndex(p => p.endsWith('/config')));
    assert.ok(!imp.requests.some(q => q.path.startsWith('/v1/memory_stores/')));

    // The history note and the closing line say where it is; the closing
    // line once.
    const note = made.files.get('imported-history/README.md').toString();
    assert.ok(note.includes('The original project’s memory (MEMORY.md and one file per fact) was written into\nthis project’s memory, at the same paths.\n\n'), note);
    assert.ok(!note.includes('carried-memory'));
    assert.strictEqual(imp.statusText.split('memory (4 files)').length, 2);
    // Its text is never in the console.
    const all = imp.logs.map(l => l.text).join('\n');
    for (const memory of memories) assert.ok(!all.includes(memory.content.trim().split('\n').pop()), memory.path);
  });

  await test('each linked folder is reported with what the new account needs to read it', async () => {
    const r = imp;
    assert.deepStrictEqual(rowFor(r, 'Linked Google Drive folder Scores'), {
      group: 'setting', item: 'Linked Google Drive folder Scores', result: 'set',
      detail: 'its Claude reads it only with Google Drive connected in this account, with access to that folder',
    });
    assert.match(rowFor(r, 'Repositories').detail, /GitHub connected in this account/);
  });

  await test('instructions and settings are restored, one request each', async () => {
    // Everything the import sets is as it was in the original; the rest is
    // what a new project starts with.
    assert.deepStrictEqual(made.config, {
      agent_id: made.config.agent_id,
      allow_worker_chrome: false,
      channel_session_effort_level: 'max',
      channel_session_model: 'claude-other-model',
      default_effort_level: 'ultracode',
      default_environment_id: '',
      default_model: 'claude-test-model',
      default_plugin_ids: [],
      default_skill_ids: [],
      default_source_urls: ['https://github.com/example/web-app', 'https://github.com/example/api'],
      limit_auto_continue: true,
      mcp_servers: [],
      member_config_disabled: false,
      member_plugin_ids: [],
      memory_enabled: true,
      owner_device_disabled: false,
      system_prompt_addendum: 'You are the beethoven channel agent.\nAlways answer in threads.',
      tasks_enabled: false,
    });

    const patches = writes(imp).filter(q => q.method === 'PATCH' && q.path.endsWith('/config')).map(bodyOf);
    assert.strictEqual(patches.length, 7);
    assert.ok(patches.every(b => Object.keys(b).length === 1));
  });

  await test('permissions and things tied to the old account are not carried over, and it says so', async () => {
    // Both are as a new project has them, not as the original had them.
    assert.strictEqual(made.config.allow_worker_chrome, false);
    assert.strictEqual(made.config.default_environment_id, '');
    assert.strictEqual(source.state.channels.get(CHANNEL).config.allow_worker_chrome, true);
    assert.ok(source.state.channels.get(CHANNEL).config.default_environment_id);
    assert.ok(!writes(imp).some(q => /allow_worker_chrome|default_environment_id|mcp_servers|plugin|skill/.test(q.body || '')));

    assert.deepStrictEqual(imp.tables[0], [
      { item: 'Environment', result: 'left out', detail: 'the environment sessions run in belongs to the original account; choose one in the new project' },
      { item: 'Browser access', result: 'left out', detail: 'browser access for the project’s Claude is a permission; grant it again in the new project if you want it' },
    ]);
  });

  await test('each setting reaches the project’s Claude while it runs; then the pause stops it', async () => {
    // The site relays a setting to the project's Claude only while the
    // project is running. Every one the import really changes got there
    // (the model for sessions and the auto-continue limit were already
    // what a new project has), and nothing else woke it: no file did.
    assert.deepStrictEqual(made.wakes, [
      'system_prompt_addendum', 'default_source_urls', 'channel_session_model',
      'default_effort_level', 'channel_session_effort_level', 'topic',
    ]);
    assert.strictEqual(made.interrupted, 1);

    // Paused first, the same settings would be made and that Claude never told.
    const early = makeServer();
    await importInto(early, codeFolder(), {
      patch: src => {
        const pause = src.match(/    if \(PAUSE_WHEN_DONE\) \{\n(?:.*\n)*?    \}\n/)[0];
        // (The script is plain ASCII: it spells these characters as escapes.)
        const out = src.replace(pause, '').replace("    setStatus('Applying the project\\u2019s settings\\u2026');", m => `${pause}${m}`);
        assert.ok(out !== src && out.length === src.length);
        return out;
      },
    });
    const [paused] = madeChannels(early);
    assert.ok(paused.record.disabled_at);
    assert.strictEqual(paused.config.system_prompt_addendum, made.config.system_prompt_addendum);
    assert.deepStrictEqual(paused.wakes, []);
  });

  await test('the description and linked folders are set after the files, and then it is paused', async () => {
    assert.strictEqual(made.record.topic, source.world.channel.topic);
    assert.deepStrictEqual(made.record.context_sources, source.world.channel.context_sources);
    assert.ok(made.record.disabled_at);

    const order = writes(imp).map(q =>
      q.path.endsWith('/upload?store_as_is=true') ? 'upload'
        : q.path.endsWith('files:write') ? 'write'
        : q.path.endsWith('files:list') ? 'check'
        : q.path.endsWith('/config') ? 'config'
        : q.path.endsWith('/memories') ? 'memory'
        : q.method === 'POST' ? 'create'
        : Object.keys(bodyOf(q))[0]);
    const compact = order.filter((step, i) => step !== order[i - 1]);

    assert.deepStrictEqual(compact, [
      'create', 'memory',
      'upload', 'write', 'upload', 'write', 'upload', 'write', 'upload', 'write',
      'config', 'topic', 'context_sources', 'disabled', 'check',
    ]);
  });

  await test('files go up ten at a time, each as an upload and then a write', async () => {
    const uploads = writes(imp).filter(q => q.path === `/api/${ORG_CHAT}/upload?store_as_is=true`);
    const fileWrites = writes(imp).filter(q => q.path === `/v1/code/channels/${NEW}/files:write`).map(bodyOf);

    // 9 files and 29 history files.
    assert.strictEqual(uploads.length, 38);
    assert.deepStrictEqual(fileWrites.map(b => b.files.length), [10, 10, 10, 8]);
    assert.ok(fileWrites.every(b => b.files.every(f => Object.keys(f).join() === 'path,source_file_id')));
    // Never an overwrite.
    assert.ok(!writes(imp).some(q => /overwrite/.test(q.body || '')));

    // Every upload was stored as the file itself and used exactly once.
    assert.strictEqual(main.state.uploads.size, 38);
    assert.ok([...main.state.uploads.values()].every(u => u.asIs));
    const used = fileWrites.flatMap(b => b.files.map(f => uuidFromTaggedId('file', f.source_file_id)));
    assert.deepStrictEqual(used.slice().sort(), [...main.state.uploads.keys()].sort());

    // Uploaded under the file's own name, not the name it has on disk.
    const names = [...main.state.uploads.values()].map(u => u.name);
    assert.ok(names.includes('a:b?.md') && names.includes('a–b–.md') && names.includes('blob.bin'));
  });

  await test('upload ids are tagged exactly as the site’s own code tags them', async () => {
    const sent = writes(imp).filter(q => q.path.endsWith('files:write')).flatMap(q => bodyOf(q).files.map(f => f.source_file_id));
    const expected = [...main.state.uploads.keys()].map(uuid => siteTaggedId('file', uuid, NEW));

    assert.strictEqual(sent.length, 38);
    assert.deepStrictEqual(sent.slice().sort(), expected.slice().sort());
    assert.ok(sent.every(id => /^file_01[1-9A-HJ-NP-Za-km-z]{22}$/.test(id)));
  });

  await test('every /v1/ request carries the headers the site sends; /api/ ones carry none of them', async () => {
    const v1 = imp.requests.filter(q => q.path.startsWith('/v1/'));
    const api = imp.requests.filter(q => q.path.startsWith('/api/'));
    assert.ok(v1.length >= 15 && api.length >= 39);

    for (const q of v1) {
      for (const [k, v] of Object.entries(V1_HEADERS)) assert.strictEqual(q.headers[k], v, `${k} on ${q.method} ${q.path}`);
      assert.strictEqual(q.headers['content-type'], q.method === 'GET' ? undefined : 'application/json');
    }
    for (const q of api) {
      assert.deepStrictEqual(Object.keys(q.headers), ['accept'], q.path);
    }
    assert.ok(imp.requests.every(q => q.credentials === 'include'));
    assert.strictEqual(main.hits.v1Refused, 0);
  });

  await test('nothing that existed is touched', async () => {
    // No request deletes, and none changes anything outside the new project.
    assert.ok(!imp.requests.some(q => q.method === 'DELETE' || q.method === 'PUT'));
    for (const q of writes(imp)) {
      assert.ok(
        q.path === '/v1/code/channels' ||
        q.path.startsWith(`/v1/code/channels/${NEW}`) ||
        q.path === `/v1/code/memory/channel/${NEW}/memories` ||
        q.path === `/api/${ORG_CHAT}/upload?store_as_is=true`,
        `${q.method} ${q.path}`
      );
    }

    // The original project is as it was.
    const original = main.state.channels.get(CHANNEL);
    assert.strictEqual(original.record.name, 'beethoven');
    assert.strictEqual(original.record.disabled_at, null);
    assert.strictEqual(original.files.size, source.world.files.size);
    assert.deepStrictEqual(original.memory.memories, source.world.memories);
    assert.strictEqual(original.config.allow_worker_chrome, true);
  });

  await test('it ends by checking the new project’s files against what it sent', async () => {
    const checks = writes(imp).filter(q => q.path === `/v1/code/channels/${NEW}/files:list`).map(bodyOf);
    assert.deepStrictEqual(checks, [{ recursive: true, limit: 500 }]);

    const rows = account(imp);
    assert.strictEqual(rows.filter(r => r.group === 'file' && r.result === 'added').length, 9);
    assert.strictEqual(rows.filter(r => r.group === 'history' && r.result === 'added').length, 29);
    assert.strictEqual(rows.filter(r => r.group === 'memory' && r.result === 'added').length, 4);
    assert.ok(!rows.some(r => ['not added', 'not set', 'to check'].includes(r.result)));
    assert.deepStrictEqual(rows[0], { group: 'project', item: 'Project', result: 'created', detail: 'beethoven (imported)' });
  });

  await test('the link to the new project is shown and printed', async () => {
    const link = imp.elements.find(e => e.tagName === 'A');
    assert.strictEqual(link.href, `https://claude.ai/code/project/${NEW}`);
    assert.strictEqual(link.textContent, 'Open the new project');
    assert.strictEqual(link.style.display, 'block');
    assert.ok(lines(imp, 'log').includes(`Claude importer: the new project is at https://claude.ai/code/project/${NEW}`));
  });

  await test('exporting the new project gives back what was exported from the old one', async () => {
    const again = await exportOf(main, `/code/project/${NEW}`);
    // 9 of its own files + 29 history files; its memory is the original's;
    // its timeline is one notice.
    assert.match(again.statusText, /^Done — 38 file\(s\), 4 memory file\(s\), 1 message\(s\), 0 thread\(s\), 1 session\(s\)\. See/);

    const m2 = parse(again.files['beethoven (imported)/export.json']);
    assert.strictEqual(m2.name, 'beethoven (imported)');
    assert.strictEqual(m2.description, manifest.description);
    assert.strictEqual(m2.instructions, manifest.instructions);
    assert.strictEqual(m2.settings.visibility, 'private');
    assert.strictEqual(m2.settings.icon, manifest.settings.icon);
    assert.strictEqual(m2.settings.color, manifest.settings.color);
    assert.deepStrictEqual(m2.settings.context_sources, manifest.settings.context_sources);
    for (const key of ['system_prompt_addendum', 'default_source_urls', 'default_model', 'channel_session_model',
      'default_effort_level', 'channel_session_effort_level', 'limit_auto_continue']) {
      assert.deepStrictEqual(m2.settings.config[key], manifest.settings.config[key], key);
    }

    // File for file, the same bytes under the same project paths.
    for (const row of manifest.files) {
      const twin = m2.files.find(f => f.name === row.name);
      assert.ok(twin, row.name);
      assert.strictEqual(twin.bytes, row.bytes);
      assert.strictEqual(
        Buffer.compare(again.bytes[`beethoven (imported)/${twin.path}`], exported.bytes[`beethoven/${row.path}`]), 0, row.name);
    }
    assert.strictEqual(m2.files.length, manifest.files.length + 29);
  });

  await test('an import of that export keeps the two histories apart', async () => {
    const again = await exportOf(main, `/code/project/${NEW}`);
    const second = await importInto(main, folder(again, 'beethoven (imported)'));
    assert.match(second.statusText, /^Done — “beethoven \(imported\) \(imported\)” was created with 38 files and 3 history files\./);

    const copy = madeChannels(main)[1];
    // The first import's history came along as ordinary files...
    assert.ok(copy.files.has('imported-history/Timeline.md'));
    // ...and this import's own history went to a folder of its own.
    assert.ok(copy.files.has('imported-history-2/README.md'));
    assert.ok(copy.files.has('imported-history-2/Timeline.md'));
    assert.strictEqual(Buffer.compare(copy.files.get('imported-history/Timeline.md'), made.files.get('imported-history/Timeline.md')), 0);
    assert.strictEqual(copy.files.size, 38 + 3);
    assert.deepStrictEqual(copy.memory.memories.map(x => x.path), source.world.memories.map(x => x.path));
  });

  // ------------------------------------------------------------------
  console.log('\n2. Choosing the folder, the name and the organization');

  await test('the folder that holds the export folder works too', async () => {
    const m = makeServer();
    const r = await importInto(m, MemDir.from('My exports', exported.bytes));
    assert.match(r.statusText, /^Done — “beethoven \(imported\)” was created with 9 files and 29 history files\./);
    assert.strictEqual(madeChannels(m)[0].files.size, 38);
  });

  await test('with several exports in the folder it asks which', async () => {
    const both = { ...exported.bytes, ...exportedStd.bytes, 'notes.txt': Buffer.from('not an export') };
    const m = makeServer();
    const r = await importInto(m, MemDir.from('My exports', both), { prompts: ['2', ''] });

    assert.match(r.promptsShown[0], /^This folder holds 2 exports\. Which one should be imported\?\n\n1\. beethoven {2}\[code\]\n2\. Recipes\n\nEnter a number:$/);
    assert.match(r.statusText, /^Done — “Recipes \(imported\)” was created/);
    assert.strictEqual(madeProjects(m).length, 1);
    assert.strictEqual(madeChannels(m).length, 0);
  });

  await test('Cancel at any question imports nothing', async () => {
    for (const [pick, prompts] of [
      [codeFolder(), []], // the name
      [MemDir.from('My exports', { ...exported.bytes, ...exportedStd.bytes }), []], // which export
      [MemDir.from('My exports', { ...exported.bytes, ...exportedStd.bytes }), ['1']], // then the name
    ]) {
      const m = makeServer();
      const r = await importInto(m, pick, { prompts });
      assert.strictEqual(r.statusText, 'Nothing was imported.');
      assert.deepStrictEqual(writes(r), []);
      assert.strictEqual(madeChannels(m).length + madeProjects(m).length, 0);
      assert.strictEqual(r.button.disabled, false);
    }
  });

  await test('closing the folder picker, or a picker that never opens, leaves a hint and nothing else', async () => {
    // The picker is opened and then rejects as Chrome does when the window
    // is closed, and as some Chrome set-ups do without showing one.
    const m = makeServer();
    const r = await importInto(m, codeFolder(), {
      patch: src => {
        const out = src.replace(
          "runImport(() => window.showDirectoryPicker({ mode: 'read' }));",
          "runImport(() => window.showDirectoryPicker({ mode: 'read' }).then(() => {" +
          " throw Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }); }));"
        );
        assert.notStrictEqual(out, src);
        return out;
      },
    });
    assert.strictEqual(
      r.statusText,
      'The folder window was closed or did not open. Press the button again, or press ' +
      '“Import from a .tar file instead” and choose the .tar the exporter saved, or drop that file ' +
      '(or the export folder itself) on these buttons.'
    );
    assert.strictEqual(r.pickerCalls, 1);
    assert.deepStrictEqual(r.promptsShown, []);
    assert.deepStrictEqual(lines(r, 'error'), []);
    assert.deepStrictEqual(writes(r), []);
    assert.deepStrictEqual(r.requests.map(q => q.path), ['/api/organizations']);
    assert.strictEqual(madeChannels(m).length + madeProjects(m).length, 0);
    assert.strictEqual(r.button.disabled, false);
  });

  await test('pressing the button twice still makes one project', async () => {
    const m = makeServer();
    const r = await importInto(m, codeFolder(), { click: false, prompts: ['', ''] });
    const press = r.button.listeners.click[0];

    await Promise.all([press({}), press({}), press({})]);

    assert.strictEqual(madeChannels(m).length, 1);
    assert.strictEqual(r.pickerOptions.length, 1);
    assert.strictEqual(r.button.textContent, 'Import complete');
  });

  await test('the name that is typed is the name that is used', async () => {
    const m = makeServer();
    const r = await importInto(m, codeFolder(), { prompts: ['  Symphony no. 9  '] });
    assert.match(r.statusText, /^Done — “Symphony no\. 9” was created/);
    assert.strictEqual(madeChannels(m)[0].record.name, 'Symphony no. 9');
  });

  await test('a free name is suggested, however many copies exist', async () => {
    const m = makeServer();
    const first = await importInto(m, codeFolder());
    const second = await importInto(m, codeFolder());
    const third = await importInto(m, codeFolder(), { prompts: ['beethoven'] });

    assert.deepStrictEqual(madeChannels(m).map(c => c.record.name), ['beethoven (imported)', 'beethoven (imported 2)', 'beethoven']);
    assert.match(second.statusText, /^Done — “beethoven \(imported 2\)”/);
    assert.match(third.statusText, /^Done — “beethoven” was created/); // the person's choice stands
    assert.match(first.statusText, /^Done/);
  });

  await test('the name is the original one when nothing has it', async () => {
    const m = makeServer();
    m.state.channels.get(CHANNEL).record.name = 'renamed since';
    const r = await importInto(m, codeFolder());
    assert.match(r.statusText, /^Done — “beethoven” was created/);
  });

  // The usual slip when moving a project to another account: the browser
  // is still signed in as the account it was exported from.
  const NOTE = 'Note: the project this was exported from can be seen from this login.';
  const withManifest = change => tree => {
    const m = parse(tree['export.json'].toString());
    change(m);
    tree['export.json'] = Buffer.from(JSON.stringify(m));
  };

  await test('it says so when the original is in the account it is about to import into', async () => {
    for (const [pick, made] of [[codeFolder(), madeChannels], [stdFolder(), madeProjects]]) {
      // Every mock holds the two projects the exports were made from.
      const m = makeServer();
      const r = await importInto(m, pick, { prompts: [] }); // Cancel, having read it
      assert.strictEqual(r.promptsShown.length, 1);
      assert.ok(r.promptsShown[0].includes(`?\n\n${NOTE} To copy it to another account, press Cancel`), r.promptsShown[0]);
      assert.strictEqual(r.statusText, 'Nothing was imported.');
      assert.deepStrictEqual(writes(r), []);
      assert.strictEqual(made(m).length, 0);

      // It is a note, not a refusal: a copy in the same account is allowed.
      const again = await importInto(m, pick);
      assert.match(again.statusText, /^Done/);
      assert.strictEqual(made(m).length, 1);
    }
  });

  await test('an export from another account gets no such note', async () => {
    const elsewhere = [
      codeFolder(withManifest(m => { m.source.id = 'chan_01SOMEWHEREELSE0000000000'; })),
      stdFolder(withManifest(m => { m.source.id = 'cccccccc-0000-4000-8000-00000000000c'; })),
      // An export that does not say where it came from.
      codeFolder(withManifest(m => { delete m.source; })),
      stdFolder(withManifest(m => { m.source = { id: 7 }; })),
    ];

    for (const pick of elsewhere) {
      const r = await importInto(makeServer(), pick);
      assert.strictEqual(r.promptsShown.length, 1);
      assert.ok(!r.promptsShown[0].includes('Note:'), r.promptsShown[0]);
      assert.match(r.statusText, /^Done/);
    }
  });

  await test('when the list of projects cannot be read, it imports without the note', async () => {
    const m = makeServer({
      fault: (url, headers, nth, init) =>
        url.pathname === '/v1/code/channels' && init.method !== 'POST'
          ? v1Error(500, 'Internal server error')
          : null,
    });
    const r = await importInto(m, codeFolder());
    assert.ok(!r.promptsShown[0].includes('Note:'), r.promptsShown[0]);
    // Nor can it tell that the name is taken: the original one is offered.
    assert.match(r.statusText, /^Done — “beethoven” was created/);
  });

  await test('with two organizations it asks which, offering the one in use', async () => {
    const SECOND = '11111111-2222-4333-8444-555555555555';
    const m = makeServer({
      faultEverywhere: true,
      fault: url =>
        url.pathname === '/api/organizations'
          ? json(200, [
              { uuid: SECOND, name: 'Work', capabilities: ['chat', 'claude_team'] },
              { uuid: ORG_CHAT, name: 'Personal', capabilities: ['claude_max', 'chat'] },
              { uuid: ORG_API, name: 'Individual Org', capabilities: ['api', 'api_individual'] },
            ])
          : null,
    });

    // The cookie says "Personal" is the one in use: that is the default.
    const r = await importInto(m, codeFolder(), { prompts: ['2', ''] });
    assert.strictEqual(r.promptsShown[0], 'Which organization should the new project be created in?\n\n1. Work\n2. Personal\n\nEnter a number:');
    assert.ok(r.promptsShown[1].startsWith('Import “beethoven” as a NEW Claude Code project in “Personal”?'));
    assert.match(r.statusText, /^Done/);

    // Choosing the other one sends everything there (the mock has no such
    // organization, so its refusal shows where the request went).
    const other = await importInto(makeServer(m.need), codeFolder(), { prompts: ['1', ''] });
    const create = writes(other).find(q => q.path === '/v1/code/channels');
    assert.strictEqual(create.headers['x-organization-uuid'], SECOND);
    assert.strictEqual(other.statusText, 'Import failed: The site refused to create the project: HTTP 403: Permission denied..');
  });

  // ------------------------------------------------------------------
  console.log('\n3. Folders that are not a usable export');

  await test('an export that never finished, or an old one, is recognised and explained', async () => {
    // export.json is written last, so a folder without it is one or the other.
    const unfinished = Object.fromEntries(
      Object.entries(exported.bytes).filter(([name]) => name !== 'beethoven/export.json')
    );
    assert.ok('beethoven/Timeline.md' in unfinished);

    for (const pick of [folder({ bytes: unfinished }, 'beethoven'), MemDir.from('My exports', unfinished)]) {
      const m = makeServer();
      const r = await importInto(m, pick);
      assert.strictEqual(
        r.statusText,
        'Import failed: "beethoven" looks like an export, but it has no export.json: it was made with an older exporter, ' +
        'or the export did not finish. Export the project again (cswap project-move export) and import that folder.'
      );
      assert.deepStrictEqual(writes(r), []);
      assert.strictEqual(r.button.disabled, false);
    }
  });

  await test('some other folder is refused with a plain explanation', async () => {
    const r = await importInto(makeServer(), MemDir.from('Holiday photos', { 'beach.jpg': Buffer.from([1, 2, 3]), 'sub/readme.txt': 'hi' }));
    assert.strictEqual(
      r.statusText,
      'Import failed: There is no export in "Holiday photos". Choose the folder the exporter made: the one that holds export.json.'
    );
    assert.deepStrictEqual(r.promptsShown, []);
  });

  await test('a damaged or foreign export.json is refused before anything is created', async () => {
    const cases = [
      [tree => { tree['export.json'] = Buffer.from('{"format": "claude-project-export", "vers'); },
        'Import failed: beethoven/export.json is damaged (it is not valid JSON). Export the project again.'],
      [tree => { tree['export.json'] = Buffer.from('{"name":"something else"}'); },
        'Import failed: beethoven/export.json was not written by the Claude project exporter.'],
      [tree => { tree['export.json'] = Buffer.from(JSON.stringify({ ...manifest, version: 2 })); },
        'Import failed: beethoven was exported in a format this importer does not know (version 2). Use the importer that came with that exporter.'],
      [tree => { tree['export.json'] = Buffer.from(JSON.stringify({ ...manifest, kind: 'workspace' })); },
        'Import failed: beethoven/export.json does not say what kind of project this is.'],
    ];

    for (const [edit, message] of cases) {
      const m = makeServer();
      const r = await importInto(m, codeFolder(edit));
      assert.strictEqual(r.statusText, message);
      assert.deepStrictEqual(writes(r), []);
    }
  });

  await test('files missing from the folder are reported; the rest are imported', async () => {
    const m = makeServer();
    const r = await importInto(m, codeFolder(tree => {
      delete tree['Files/state/data.json'];
      delete tree['Timeline.md'];
    }));

    assert.match(r.statusText, /^Done — “beethoven \(imported\)” was created with 8 of 9 files and 28 of 29 history files\. 2 items could not be imported; the console lists them\./);
    assert.deepStrictEqual(rowFor(r, 'state/data.json'), {
      group: 'file', item: 'state/data.json', result: 'not added', detail: 'it is not in the export folder (Files/state/data.json)',
    });
    assert.strictEqual(rowFor(r, 'Saved conversation Timeline.md').result, 'not added');
    assert.strictEqual(madeChannels(m)[0].files.size, 36);
    assert.ok(r.tables[0].some(row => row.item === 'state/data.json' && row.result === 'not added'));
  });

  await test('a manifest cannot make it read outside the chosen folder', async () => {
    const m = makeServer();
    const outside = MemDir.from('Documents', { 'secret.txt': 'private', ...Object.fromEntries(Object.entries(exported.bytes)) });
    const inner = outside.dirs.get('beethoven');
    const edited = { ...manifest, files: [{ path: '../secret.txt', name: 'stolen.txt', type: 'project_file', bytes: 7 }, { path: 'Files/../../secret.txt', name: 'stolen2.txt', type: 'project_file', bytes: 7 }], history: [] };
    inner.files.get('export.json').bytes = Buffer.from(JSON.stringify(edited));

    const r = await importInto(m, inner);
    assert.match(r.statusText, /0 of 2 files/);
    assert.strictEqual(madeChannels(m)[0].files.size, 0);
    assert.strictEqual(m.state.uploads.size, 0);
    // Such a path is not even looked up: it is simply not part of the export.
    assert.strictEqual(rowFor(r, 'stolen.txt').detail, 'it is not in the export folder (../secret.txt)');
    assert.strictEqual(rowFor(r, 'stolen2.txt').detail, 'it is not in the export folder (Files/../../secret.txt)');
  });

  await test('an export that was itself incomplete says so when imported', async () => {
    const r = await importInto(makeServer(), codeFolder(tree => {
      tree['export.json'] = Buffer.from(JSON.stringify({ ...manifest, problems: ['Thread cmsg_01X (HTTP 500).'] }));
    }));
    assert.match(r.statusText, /^Done/);
    assert.deepStrictEqual(lines(r, 'warn'), [
      'Claude importer: this export was itself incomplete. Its README lists what it could not get:\n  Thread cmsg_01X (HTTP 500).',
    ]);
  });

  // ------------------------------------------------------------------
  console.log('\n4. When the site refuses to create the project');

  await test('a refusal is shown in the server’s own words and nothing else is tried', async () => {
    const m = makeServer({
      fault: (url, headers, nth, init) =>
        url.pathname === '/v1/code/channels' && init.method === 'POST'
          ? json(403, { error: { message: 'Projects are not available on your plan', reason: 'channel_disabled_by_plan', type: 'permission_error' }, type: 'error' })
          : null,
    });
    const r = await importInto(m, codeFolder());

    assert.strictEqual(
      r.statusText,
      'Import failed: The site refused to create the project: HTTP 403: Projects are not available on your plan — channel_disabled_by_plan.'
    );
    assert.strictEqual(writes(r).length, 1);
    assert.strictEqual(r.button.disabled, false); // can be tried again
    assert.strictEqual(r.elements.find(e => e.tagName === 'A').style.display, 'none');
  });

  await test('an unclear answer is never followed by a second attempt', async () => {
    for (const fail of [
      () => v1Error(500, 'Internal server error'),
      () => { throw new TypeError('Failed to fetch'); },
    ]) {
      const m = makeServer({
        fault: (url, headers, nth, init) => (url.pathname === '/v1/code/channels' && init.method === 'POST' ? fail() : null),
      });
      const r = await importInto(m, codeFolder());

      assert.match(r.statusText, /^Import failed: The request to create the project got no clear answer \((HTTP 500: Internal server error|network error \(Failed to fetch\))\)\. It may have been created all the same: look in your projects before trying again\.$/);
      assert.strictEqual(writes(r).filter(q => q.path === '/v1/code/channels').length, 1);
      assert.strictEqual(writes(r).length, 1);
    }
  });

  await test('being told to slow down is waited out, and still makes one project', async () => {
    const m = makeServer({
      fault: (url, headers, nth, init) =>
        url.pathname === '/v1/code/channels' && init.method === 'POST' && nth <= 3 // the list was request 1
          ? json(429, { error: { message: 'Rate limited', reason: '', type: 'rate_limit_error' }, type: 'error' }, { 'retry-after': '4' })
          : null,
    });
    const r = await importInto(m, codeFolder());

    assert.match(r.statusText, /^Done — “beethoven \(imported\)” was created with 9 files/);
    assert.strictEqual(madeChannels(m).length, 1);
    assert.deepStrictEqual(r.sleeps.filter(ms => ms >= 1000), [4000, 4000]);
    assert.ok(lines(r, 'warn').some(t => t.includes('HTTP 429: Rate limited. Trying again in 4 s')));
  });

  await test('if the icon is refused the project is made without it, and that is noted', async () => {
    const m = makeServer({ knownIcons: new Set(['Globe', 'Sparkle']) });
    const r = await importInto(m, codeFolder());

    assert.match(r.statusText, /^Done — “beethoven \(imported\)” was created with 9 files and 29 history files\. 1 item could not be imported; the console lists it\./);
    assert.deepStrictEqual(writes(r).filter(q => q.path === '/v1/code/channels').map(bodyOf), [
      { name: 'beethoven (imported)', visibility: 'private', icon: 'MusicNotes', color: 'purple' },
      { name: 'beethoven (imported)', visibility: 'private' },
    ]);
    assert.strictEqual(madeChannels(m).length, 1);
    assert.deepStrictEqual(rowFor(r, 'Icon and colour'), {
      group: 'setting', item: 'Icon and colour', result: 'not set', detail: 'HTTP 400: Request validation failed — icon: unknown icon',
    });
  });

  await test('a refusal that is not about the icon is reported as it was first given', async () => {
    const m = makeServer({
      fault: (url, headers, nth, init) =>
        url.pathname === '/v1/code/channels' && init.method === 'POST'
          ? v1Error(400, 'Request validation failed', 'name: already taken')
          : null,
    });
    const r = await importInto(m, codeFolder());
    assert.strictEqual(r.statusText, 'Import failed: The site refused to create the project: HTTP 400: Request validation failed — name: already taken.');
    assert.strictEqual(writes(r).length, 2); // with the look, then without
  });

  // ------------------------------------------------------------------
  console.log('\n5. When single files or settings are refused');

  // Refuses the upload of one file, by the name it is uploaded under.
  const failUpload = (name, respond) => (url, headers, nth, init) =>
    url.pathname.endsWith('/upload') && init.body.get('file').name === name ? respond(nth) : null;

  await test('a memory that will not take goes among the files, in carried-memory/, and says why', async () => {
    const m = makeServer({ noMemoryWrites: true });
    const r = await importInto(m, codeFolder());
    const made = madeChannels(m)[0];
    const why = 'the new project’s memory took none (HTTP 404: Not Found)';

    assert.deepStrictEqual(made.memory.memories, []);
    for (const memory of source.world.memories) {
      const to = `carried-memory${memory.path}`;
      assert.strictEqual(made.files.get(to)?.toString(), memory.content, to);
      assert.deepStrictEqual(rowFor(r, `Project memory ${memory.path}`), {
        group: 'memory', item: `Project memory ${memory.path}`, result: 'moved', detail: `put among the files at ${to}, because ${why}`,
      });
    }
    // The first memory was sent each way that could be meant; the rest
    // were not sent at all.
    const sent = writes(r).filter(q => q.path.endsWith('/memories'));
    assert.deepStrictEqual(sent.map(q => [bodyOf(q).path, q.headers['anthropic-beta']]),
      [['/MEMORY.md', 'ccr-byoc-2025-07-29'], ['/MEMORY.md', 'agent-memory-2026-07-22']]);
    assert.ok(made.files.get('imported-history/README.md').toString().includes(
      'The original project’s memory (MEMORY.md and one file per fact) is in\ncarried-memory/, among this project’s files: this project’s memory did not\ntake it.\n'));
    assert.match(r.statusText, /created with 9 files and 29 history files\. 2 items were left out or moved on purpose; the console says why\. The original project’s memory \(4 files\) is among its files in carried-memory\/, because the new project’s memory did not take them; the console says why\./);
    assert.ok(r.tables[0].some(row => row.item === 'Project memory /MEMORY.md' && row.result === 'moved'));
  });

  await test('a project that already holds carried-memory/ keeps it, and memory that will not take goes in carried-memory-2/', async () => {
    // An export of a project that was itself imported may hold an earlier
    // project's memory as ordinary files. Its own memory is another
    // project's, so neither copy is dropped.
    const m = makeServer({ noMemoryWrites: true });
    const r = await importInto(m, codeFolder(tree => {
      const edited = parse(tree['export.json'].toString());
      const row = edited.files.find(f => f.type === 'project_file' && f.name === 'state/notes.md');
      assert.ok(row);
      row.name = 'carried-memory/MEMORY.md';
      tree['export.json'] = Buffer.from(JSON.stringify(edited));
    }));

    const made = madeChannels(m)[0];
    assert.strictEqual(rowFor(r, 'carried-memory/MEMORY.md').result, 'added');
    assert.strictEqual(made.files.get('carried-memory/MEMORY.md').toString(), source.world.files.get('state/notes.md').toString());
    for (const memory of source.world.memories) {
      const to = `carried-memory-2${memory.path}`;
      assert.strictEqual(rowFor(r, `Project memory ${memory.path}`).result, 'moved', to);
      assert.strictEqual(made.files.get(to).toString(), memory.content, to);
    }
    assert.ok(made.files.get('imported-history/README.md').toString().includes('memory (MEMORY.md and one file per fact) is in\ncarried-memory-2/, among'));
    assert.match(r.statusText, /The original project’s memory \(4 files\) is among its files in carried-memory-2\/, because/);
  });

  await test('an export that did not record the memory’s exact paths writes them with a leading slash', async () => {
    const m = makeServer();
    const r = await importInto(m, codeFolder(withManifest(edited => {
      for (const row of edited.files) delete row.memory_path;
      delete edited.memory.beta;
    })));
    assert.deepStrictEqual(madeChannels(m)[0].memory.memories.map(x => [x.path, x.content]),
      source.world.memories.map(x => [x.path, x.content]));
    assert.match(r.statusText, /The original project’s memory is in the new project’s memory \(4 files\)\./);

    // Where nothing takes it, the first memory is sent every way that could
    // be meant before the rest go among the files.
    const refused = makeServer({ noMemoryWrites: true });
    const r2 = await importInto(refused, codeFolder(withManifest(edited => {
      for (const row of edited.files) delete row.memory_path;
    })));
    assert.deepStrictEqual(writes(r2).filter(q => q.path.endsWith('/memories')).map(q => [bodyOf(q).path, q.headers['anthropic-beta']]), [
      ['/MEMORY.md', 'ccr-byoc-2025-07-29'], ['MEMORY.md', 'ccr-byoc-2025-07-29'],
      ['/MEMORY.md', 'agent-memory-2026-07-22'], ['MEMORY.md', 'agent-memory-2026-07-22'],
    ]);
    assert.strictEqual([...madeChannels(refused)[0].files.keys()].filter(p => p.startsWith('carried-memory/')).length, 4);
  });

  await test('a memory route that asks for the beta gets it, first when the export needed it too', async () => {
    const strict = makeServer({ channelMemoryBeta: true });
    const fromStrict = await exportOf(strict, CODE_TAB);
    const sent = parse(fromStrict.files['beethoven/export.json']);
    assert.strictEqual(sent.memory.beta, true);

    const m = makeServer({ channelMemoryBeta: true });
    const r = await importInto(m, folder(fromStrict, 'beethoven'));
    assert.strictEqual(madeChannels(m)[0].memory.memories.length, 4);
    const asked = r.requests.filter(q => q.path.includes('/v1/code/memory/'));
    assert.ok(asked.length >= 6 && asked.every(q => q.headers['anthropic-beta'] === 'agent-memory-2026-07-22'));
    assert.strictEqual(m.hits.v1Refused, 0);

    // An export that does not say so is asked the other way first, once:
    // the list shows which way works before any memory is sent.
    const m2 = makeServer({ channelMemoryBeta: true });
    const r2 = await importInto(m2, codeFolder(withManifest(edited => { delete edited.memory.beta; })));
    assert.strictEqual(madeChannels(m2)[0].memory.memories.length, 4);
    assert.strictEqual(m2.hits.v1Refused, 1);
    assert.ok(writes(r2).filter(q => q.path.endsWith('/memories')).every(q => q.headers['anthropic-beta'] === 'agent-memory-2026-07-22'));
  });

  await test('a memory the new project already holds is never changed: the same is there, another goes among the files', async () => {
    // Something writes the first two memories into the new project just
    // before the import sends them: one as the export has it, one not.
    // With a list that gives no sizes, what they hold is read to compare.
    const [same, other] = source.world.memories;

    for (const noMemorySizes of [false, true]) {
      let planted = false;
      const m = makeServer({
        noMemorySizes,
        fault: (url, headers, nth, init) => {
          if (planted || init?.method !== 'POST' || !url.pathname.endsWith('/memories')) return null;
          planted = true;
          const { memories } = madeChannels(m)[0].memory;
          memories.push({ id: 'mem_PLANTED1', path: same.path, content: same.content });
          // As long as the export's, so that only its text tells them apart.
          memories.push({ id: 'mem_PLANTED2', path: other.path, content: other.content.replace(/[a-z]/g, 'x') });
          return null;
        },
      });
      const r = await importInto(m, codeFolder());
      const got = madeChannels(m)[0];
      const how = `noMemorySizes: ${noMemorySizes}`;

      assert.deepStrictEqual(rowFor(r, `Project memory ${same.path}`),
        { group: 'memory', item: `Project memory ${same.path}`, result: 'added', detail: 'already in the new project’s memory' }, how);
      assert.deepStrictEqual(rowFor(r, `Project memory ${other.path}`), {
        group: 'memory', item: `Project memory ${other.path}`, result: 'moved',
        detail: `put among the files at carried-memory${other.path}, because the new project’s memory already holds another memory at that path`,
      }, how);
      assert.strictEqual(got.memory.memories.find(x => x.path === other.path).content, other.content.replace(/[a-z]/g, 'x'), how);
      assert.strictEqual(got.files.get(`carried-memory${other.path}`).toString(), other.content, how);
      assert.strictEqual(got.memory.memories.length, source.world.memories.length, how);
      // The two taken ones were read to compare, and nothing was changed.
      assert.deepStrictEqual(r.requests.filter(q => /\/memories\/mem_PLANTED/.test(q.path)).map(q => q.method).sort(), ['GET', 'GET'], how);
      assert.match(r.statusText, /The original project’s memory is in the new project’s memory \(3 files\)\. The rest \(1 file\) is among its files in carried-memory\/, because the new project’s memory did not take it; the console says why\./, how);
      const note = got.files.get('imported-history/README.md').toString();
      assert.ok(note.includes('this project’s memory, at the same paths.\nThe memory files it did not take are in carried-memory/, among this project’s files.\n'), note);
    }
  });

  await test('a memory the site says it took but its memory does not list goes among the files too', async () => {
    // The write is answered as done, and nothing is kept.
    const m = makeServer({
      fault: (url, headers, nth, init) =>
        init?.method === 'POST' && url.pathname.endsWith('/memories') ? json(200, { data: [], has_more: false }) : null,
    });
    const r = await importInto(m, codeFolder());
    const got = madeChannels(m)[0];

    assert.deepStrictEqual(got.memory.memories, []);
    for (const memory of source.world.memories) {
      assert.strictEqual(got.files.get(`carried-memory${memory.path}`)?.toString(), memory.content, memory.path);
      assert.strictEqual(rowFor(r, `Project memory ${memory.path}`).detail,
        `put among the files at carried-memory${memory.path}, because the site accepted it, but the new project’s memory does not list it`);
    }
    assert.ok(!r.statusText.includes('in the new project’s memory'), r.statusText);
    assert.match(r.statusText, /The original project’s memory \(4 files\) is among its files in carried-memory\//);
    assert.ok(!got.files.get('imported-history/README.md').toString().includes('was written into'));
  });

  await test('a server error on the first memory sends no more; the rest go among the files', async () => {
    const m = makeServer({
      fault: (url, headers, nth, init) =>
        init?.method === 'POST' && url.pathname.endsWith('/memories') ? apiError(500, 'api_error', 'Internal server error') : null,
    });
    const r = await importInto(m, codeFolder());
    const got = madeChannels(m)[0];
    const [first, ...rest] = source.world.memories;

    // The first, sent once and tried again three times, as any request.
    assert.strictEqual(writes(r).filter(q => q.path.endsWith('/memories')).length, 4);
    assert.match(rowFor(r, `Project memory ${first.path}`).detail, /because the new project’s memory gave no clear answer \(HTTP 500: Internal server error\) and does not list it$/);
    for (const memory of rest) {
      assert.match(rowFor(r, `Project memory ${memory.path}`).detail, /because not tried: the memory before it got no clear answer \(HTTP 500: Internal server error\)$/);
    }
    assert.strictEqual([...got.files.keys()].filter(p => p.startsWith('carried-memory/')).length, 4);
  });

  await test('a memory too large for the new project\'s memory costs only itself', async () => {
    const big = makeServer({}, { memories: [
      ['/MEMORY.md', `# Memory\n\n${'- a long line of notes\n'.repeat(6000)}`],
      ['/user_role.md', '---\nname: user role\ntype: user\n---\nShort.\n'],
      ['/feedback/testing.md', '---\nname: testing\ntype: feedback\n---\nShort too.\n'],
    ] });
    const fromBig = await exportOf(big, CODE_TAB);
    // An export that did not record the exact paths: the first memory is
    // sent four ways, two of them refused as too large.
    const m = makeServer();
    const r = await importInto(m, folder(fromBig, 'beethoven', withManifest(edited => {
      for (const row of edited.files) delete row.memory_path;
    })));
    const got = madeChannels(m)[0];

    assert.deepStrictEqual(got.memory.memories.map(x => x.path), ['/user_role.md', '/feedback/testing.md']);
    assert.deepStrictEqual([...got.files.keys()].filter(p => p.startsWith('carried-memory')), ['carried-memory/MEMORY.md']);
    assert.match(rowFor(r, 'Project memory /MEMORY.md').detail, /did not take it \(HTTP 413: Memory content is too large — memory_too_large \/ HTTP 400/);
  });

  await test('one memory refused costs only itself; a lost reply is not mistaken for a refusal', async () => {
    const [, refused, lostOne] = source.world.memories;
    let lost = false;
    const m = makeServer({
      fault: (url, headers, nth, init) => {
        if (init?.method !== 'POST' || !url.pathname.endsWith('/memories')) return null;
        const { path } = JSON.parse(init.body);
        if (path === refused.path) return v1Error(400, 'Request validation failed', 'content: not allowed');
        if (path !== lostOne.path || lost) return null;
        lost = true;
        // The server keeps the memory; the reply never arrives.
        return m.server(url, headers, init).then(() => { throw new TypeError('Failed to fetch'); });
      },
    });
    const r = await importInto(m, codeFolder());
    const got = madeChannels(m)[0];

    assert.ok(lost);
    assert.strictEqual(rowFor(r, `Project memory ${refused.path}`).detail,
      `put among the files at carried-memory${refused.path}, because the new project’s memory did not take it ` +
      '(HTTP 400: Request validation failed — content: not allowed)');
    assert.strictEqual(rowFor(r, `Project memory ${lostOne.path}`).result, 'added');
    assert.deepStrictEqual(got.memory.memories.map(x => x.path).sort(),
      source.world.memories.filter(x => x !== refused).map(x => x.path).sort());
    assert.deepStrictEqual([...got.files.keys()].filter(p => p.startsWith('carried-memory')), [`carried-memory${refused.path}`]);
    assert.match(r.statusText, /memory \(3 files\)\. The rest \(1 file\) is among its files in carried-memory\//);
  });

  await test('an export without the project’s memory says nothing about it', async () => {
    const m = makeServer();
    const r = await importInto(m, codeFolder(tree => {
      const manifest = parse(tree['export.json'].toString());
      manifest.files = manifest.files.filter(f => f.type !== 'project_memory');
      manifest.memory = null;
      tree['export.json'] = Buffer.from(JSON.stringify(manifest));
    }));

    const got = madeChannels(m)[0];
    assert.strictEqual(got.files.size, 38);
    assert.ok(![...got.files.keys()].some(p => p.startsWith('carried-memory/')));
    assert.ok(!r.promptsShown[0].includes('memory'));
    assert.ok(!r.statusText.includes('memory'), r.statusText);
    assert.ok(!got.files.get('imported-history/README.md').toString().includes('memory'));
    assert.ok(!account(r).some(row => row.group === 'memory'));
  });

  await test('a file whose upload fails is reported; every other file is imported', async () => {
    const m = makeServer({
      faultEverywhere: true,
      fault: failUpload('data.json', () => apiError(500, 'api_error', 'Internal server error')),
    });
    const r = await importInto(m, codeFolder());

    assert.match(r.statusText, /^Done — “beethoven \(imported\)” was created with 8 of 9 files and 29 history files\. 1 item could not be imported; the console lists it\./);
    assert.deepStrictEqual(rowFor(r, 'state/data.json'), {
      group: 'file', item: 'state/data.json', result: 'not added', detail: 'the upload was refused: HTTP 500: Internal server error',
    });
    const got = madeChannels(m)[0];
    assert.ok(!got.files.has('state/data.json'));
    assert.strictEqual(got.files.size, 37);
    // Tried four times, since uploading twice does no harm.
    assert.deepStrictEqual(r.sleeps.filter(ms => ms >= 2000), [2000, 5000, 15000]);
    // It is still paused and checked at the end.
    assert.ok(got.record.disabled_at);
  });

  await test('an upload that is told to slow down is sent again', async () => {
    let turnedAway = 0;
    const m = makeServer({
      faultEverywhere: true,
      fault: failUpload('notes.md', () =>
        turnedAway++ < 1 ? json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Too many uploads' } }, { 'retry-after': '9' }) : null),
    });
    const r = await importInto(m, codeFolder());
    assert.match(r.statusText, /^Done — “beethoven \(imported\)” was created with 9 files and 29 history files\. 2 items were left out/);
    assert.ok(r.sleeps.includes(9000));
    assert.strictEqual(madeChannels(m)[0].files.get('state/notes.md').toString(), '# Notes\n\nRemember the milk.\n');
  });

  await test('uploads that keep being told to slow down are waited out for a good while', async () => {
    let turnedAway = 0;
    const m = makeServer({
      faultEverywhere: true,
      fault: failUpload('notes.md', () =>
        turnedAway++ < 6 ? json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Too many uploads' } }) : null),
    });
    const r = await importInto(m, codeFolder());

    assert.match(r.statusText, /created with 9 files and 29 history files/);
    assert.deepStrictEqual(r.sleeps.filter(ms => ms >= 1000), [2000, 5000, 10000, 15000, 15000, 15000]);
    assert.ok(madeChannels(m)[0].files.has('state/notes.md'));
  });

  await test('but not for ever: after that the file is reported and the import goes on', async () => {
    const m = makeServer({
      faultEverywhere: true,
      fault: failUpload('notes.md', () => json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Too many uploads' } })),
    });
    const r = await importInto(m, codeFolder());

    assert.match(r.statusText, /created with 8 of 9 files and 29 history files\. 1 item could not be imported/);
    assert.strictEqual(rowFor(r, 'state/notes.md').detail, 'the upload was refused: HTTP 429: Too many uploads');
    assert.strictEqual(r.sleeps.filter(ms => ms >= 1000).length, 8);
  });

  await test('an upload the site only kept the text of is not used as the file', async () => {
    const m = makeServer({
      faultEverywhere: true,
      fault: failUpload('repo.bundle', () => json(200, { file_uuid: '00000000-0000-4000-8000-00000000abcd', file_name: 'repo.bundle', text_extracted: true })),
    });
    const r = await importInto(m, codeFolder());
    assert.strictEqual(rowFor(r, 'bundles/repo.bundle').detail, 'the site kept only the text of this file, not the file itself');
    assert.ok(!madeChannels(m)[0].files.has('bundles/repo.bundle'));
  });

  await test('a write the site asks to have repeated is repeated once', async () => {
    const m = makeServer({ writeReason: (p, nth) => (p === 'state/notes.md' && nth === 1 ? 'write_failed' : '') });
    const r = await importInto(m, codeFolder());

    assert.match(r.statusText, /created with 9 files and 29 history files/);
    const forNotes = writes(r).filter(q => q.path.endsWith('files:write')).map(bodyOf).filter(b => b.files.some(f => f.path === 'state/notes.md'));
    assert.deepStrictEqual(forNotes.map(b => b.files.length), [10, 1]);
    // The same upload both times.
    assert.strictEqual(forNotes[0].files.find(f => f.path === 'state/notes.md').source_file_id, forNotes[1].files[0].source_file_id);
    assert.strictEqual(m.state.uploads.size, 38);
  });

  await test('a write that keeps failing is given up on after the second try', async () => {
    const m = makeServer({ writeReason: p => (p === 'state/notes.md' ? 'write_failed' : '') });
    const r = await importInto(m, codeFolder());
    assert.match(r.statusText, /created with 8 of 9 files/);
    assert.strictEqual(rowFor(r, 'state/notes.md').detail, 'refused: write_failed');
    assert.strictEqual(writes(r).filter(q => q.path.endsWith('files:write')).map(bodyOf).filter(b => b.files.some(f => f.path === 'state/notes.md')).length, 2);
  });

  await test('an upload the site lost is uploaded again', async () => {
    const m = makeServer({ writeReason: (p, nth) => (p === 'big/blob.bin' && nth === 1 ? 'source_file_unavailable' : '') });
    const r = await importInto(m, codeFolder());

    assert.match(r.statusText, /created with 9 files and 29 history files/);
    assert.strictEqual(m.state.uploads.size, 39); // one more than the files
    assert.strictEqual(madeChannels(m)[0].files.get('big/blob.bin').length, 70000);
  });

  await test('a file whose path the site keeps for itself is put in a folder of its own', async () => {
    const src = makeServer({}, { files: [['uploads/hearth/pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])]] });
    const exp = await exportOf(src, CODE_TAB);
    const m = makeServer();
    const r = await importInto(m, folder(exp, 'beethoven'));

    assert.match(r.statusText, /^Done — “beethoven \(imported\)” was created with 10 files and 29 history files\. 3 items were left out or moved on purpose; the console says why\./);
    assert.deepStrictEqual(rowFor(r, 'uploads/hearth/pic.png'), {
      group: 'file',
      item: 'uploads/hearth/pic.png',
      result: 'moved',
      detail: 'put at imported-not-placed/uploads/hearth/pic.png, because at its own path the site keeps that path for itself (project_file_path_reserved)',
    });
    const got = madeChannels(m)[0];
    assert.ok(!got.files.has('uploads/hearth/pic.png'));
    assert.deepStrictEqual([...got.files.get('imported-not-placed/uploads/hearth/pic.png')], [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  });

  await test('a file that is already there is never overwritten: the copy goes beside it', async () => {
    const m = makeServer({ seedFiles: [['state/notes.md', Buffer.from('written by the new project itself')]] });
    const r = await importInto(m, codeFolder());
    const got = madeChannels(m)[0];

    assert.strictEqual(got.files.get('state/notes.md').toString(), 'written by the new project itself');
    assert.strictEqual(got.files.get('imported-not-placed/state/notes.md').toString(), '# Notes\n\nRemember the milk.\n');
    assert.strictEqual(rowFor(r, 'state/notes.md').result, 'moved');
    assert.match(rowFor(r, 'state/notes.md').detail, /something is already at that path \(project_file_write_rejected\)$/);
    assert.match(r.statusText, /created with 9 files and 29 history files\. 3 items were left out or moved/);
    assert.ok(!writes(r).some(q => /overwrite/.test(q.body || '')));
  });

  await test('a path the site will not take is tidied and put in that folder too', async () => {
    const src = makeServer({}, { files: [['odd\\name.txt', Buffer.from('backslash in the name\n')]] });
    const exp = await exportOf(src, CODE_TAB);
    const m = makeServer();
    const r = await importInto(m, folder(exp, 'beethoven'));

    assert.strictEqual(rowFor(r, 'odd\\name.txt').result, 'moved');
    assert.strictEqual(madeChannels(m)[0].files.get('imported-not-placed/odd–name.txt').toString(), 'backslash in the name\n');
  });

  await test('when the project’s storage is full the rest are not tried, and it says why', async () => {
    const m = makeServer({ storageFiles: 12 });
    const r = await importInto(m, codeFolder());
    const rows = account(r);

    assert.strictEqual(madeChannels(m)[0].files.size, 12);
    assert.strictEqual(rows.filter(x => x.group !== 'memory' && x.result === 'added').length, 12);
    assert.strictEqual(rows.filter(x => x.detail === 'the project’s file storage is full (project_files_storage_limit)').length, 8);
    assert.strictEqual(rows.filter(x => x.detail === 'not tried: the project’s file storage is full').length, 18);
    // The project's own files go up first, then the history: with room for
    // twelve files, all but three history files are left without a place.
    // The memory takes none of that room.
    assert.match(r.statusText, /created with 9 files and 3 of 29 history files\. 26 items could not be imported; the console lists them\. The original project’s memory is in the new project’s memory \(4 files\)\./);
    assert.strictEqual(account(r).filter(x => x.group === 'memory' && x.result === 'added').length, 4);
    // No upload was made after the batch that hit the limit.
    assert.strictEqual(m.state.uploads.size, 20);
  });

  await test('a project that takes no files at all stops the file step at once', async () => {
    const m = makeServer({
      fault: url => (url.pathname.endsWith('/files:write') ? v1Error(400, 'Project files are read-only here', 'project_files_write_disabled') : null),
    });
    const r = await importInto(m, codeFolder());
    const rows = account(r);

    assert.strictEqual(m.state.uploads.size, 10); // one batch, no more
    assert.strictEqual(writes(r).filter(q => q.path.endsWith('files:write')).length, 1);
    assert.strictEqual(rows.filter(x => x.result === 'not added').length, 38);
    assert.ok(rows.some(x => x.detail === 'not tried: the project is not taking files (HTTP 400: Project files are read-only here — project_files_write_disabled)'));
    // The rest of the import still happens.
    const got = madeChannels(m)[0];
    assert.strictEqual(got.config.system_prompt_addendum, manifest.instructions);
    assert.strictEqual(got.record.topic, manifest.description);
    assert.match(r.statusText, /^Done — “beethoven \(imported\)” was created with 0 of 9 files and 0 of 29 history files\. 38 items could not be imported/);
  });

  await test('one bad file in a request does not sink the nine sent with it', async () => {
    const m = makeServer({
      fault: (url, headers, nth, init) =>
        url.pathname.endsWith('/files:write') && JSON.parse(init.body).files.some(f => f.path === 'state/data.json')
          ? v1Error(400, 'Request validation failed', 'files[4].path: not allowed')
          : null,
    });
    const r = await importInto(m, codeFolder());

    assert.match(r.statusText, /created with 8 of 9 files and 29 history files\. 1 item could not be imported/);
    assert.strictEqual(rowFor(r, 'state/data.json').detail, 'HTTP 400: Request validation failed — files[4].path: not allowed');
    assert.strictEqual(madeChannels(m)[0].files.size, 37);
    // The batch of ten, then its ten files one by one.
    assert.deepStrictEqual(writes(r).filter(q => q.path.endsWith('files:write')).map(q => bodyOf(q).files.length).slice(0, 11), [10, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  await test('a write whose answer was lost is not mistaken for a failure', async () => {
    let lost = false;
    const m = makeServer({
      fault: (url, headers, nth, init) => {
        if (!url.pathname.endsWith('/files:write') || lost) return null;
        lost = true;
        // The server does the write; the reply never arrives.
        return m.server(url, headers, init).then(() => { throw new TypeError('Failed to fetch'); });
      },
    });
    const r = await importInto(m, codeFolder());

    assert.ok(lost);
    assert.ok(lines(r, 'warn').some(t => t.includes('network error (Failed to fetch). Trying again in 2 s')));
    assert.match(r.statusText, /^Done — “beethoven \(imported\)” was created with 9 files and 29 history files\. 2 items were left out/);
    assert.strictEqual(madeChannels(m)[0].files.size, 38);
    assert.ok(!account(r).some(x => x.result === 'moved'));
    assert.ok(!madeChannels(m)[0].files.has('imported-not-placed/state/notes.md'));
  });

  await test('a file the site accepted but does not list is flagged for checking', async () => {
    let inside = false;
    const m = makeServer({
      fault: (url, headers, nth, init) => {
        if (!url.pathname.endsWith('/files:write') || inside) return null;
        inside = true;
        return m.server(url, headers, init).then(res => {
          inside = false;
          for (const c of madeChannels(m)) {
            c.files.delete('state/data.json'); // gone
            if (c.files.has('state/notes.md')) c.files.set('state/notes.md', Buffer.from('cut short')); // changed
          }
          return res;
        });
      },
    });
    const r = await importInto(m, codeFolder());

    assert.match(r.statusText, /created with 7 of 9 files and 29 history files\. 2 items should be checked in the project; the console lists them\./);
    assert.deepStrictEqual(rowFor(r, 'state/data.json'), {
      group: 'file', item: 'state/data.json', result: 'to check', detail: 'the site accepted it, but the project does not list it (yet)',
    });
    assert.deepStrictEqual(rowFor(r, 'state/notes.md'), {
      group: 'file', item: 'state/notes.md', result: 'to check', detail: 'it is 28 bytes in the export and 9 bytes in the project',
    });
  });

  await test('a setting the new account cannot have is reported; the others are applied', async () => {
    const m = makeServer({ models: new Set(['claude-other-model']) });
    const r = await importInto(m, codeFolder());
    const got = madeChannels(m)[0];

    assert.deepStrictEqual(rowFor(r, 'Model for sessions'), {
      group: 'setting', item: 'Model for sessions', result: 'not set', detail: 'HTTP 400: Request validation failed — default_model: unknown model',
    });
    // It keeps the model a new project starts with.
    assert.strictEqual(got.config.default_model, 'claude-other-model');
    assert.strictEqual(got.config.channel_session_model, 'claude-other-model');
    assert.strictEqual(got.config.default_effort_level, 'ultracode');
    assert.strictEqual(got.config.limit_auto_continue, true);
    assert.match(r.statusText, /created with 9 files and 29 history files\. 1 item could not be imported; the console lists it\. The original project’s memory is in the new project’s memory \(4 files\)\. It is paused/);
  });

  await test('repositories the new account cannot reach are reported, not fatal', async () => {
    const r = await importInto(makeServer(), codeFolder(tree => {
      const edited = JSON.parse(JSON.stringify(manifest));
      edited.settings.config.default_source_urls = ['git@github.com:example/private.git'];
      tree['export.json'] = Buffer.from(JSON.stringify(edited));
    }));
    assert.strictEqual(rowFor(r, 'Repositories').detail, 'HTTP 400: Repository is not reachable — project_repo_unreachable');
    assert.match(r.statusText, /^Done/);
  });

  await test('a linked folder the site refuses costs only itself: the others are linked one at a time', async () => {
    const m = makeServer({
      fault: (url, headers, nth, init) => {
        if (!(init.method === 'PATCH' && /"context_sources"/.test(init.body))) return null;
        const names = JSON.parse(init.body).context_sources.map(c => c.name);
        return names.includes('Private') ? v1Error(400, 'Folder is not reachable') : null;
      },
    });
    const r = await importInto(m, codeFolder(tree => {
      const edited = JSON.parse(JSON.stringify(manifest));
      edited.settings.context_sources = [
        { kind: 'google_drive_folder', name: 'Scores', path: '', url: 'https://drive.google.com/drive/folders/abc123' },
        { kind: 'google_drive_folder', name: 'Private', path: '', url: 'https://drive.google.com/drive/folders/zzz' },
        { kind: 'github_repository', name: 'example/web-app', path: '', url: 'https://github.com/example/web-app' },
      ];
      tree['export.json'] = Buffer.from(JSON.stringify(edited));
    }));

    assert.deepStrictEqual(madeChannels(m)[0].record.context_sources.map(c => c.name), ['Scores', 'example/web-app']);
    assert.strictEqual(rowFor(r, 'Linked Google Drive folder Scores').result, 'set');
    assert.strictEqual(rowFor(r, 'Linked repository example/web-app').result, 'set');
    assert.deepStrictEqual(rowFor(r, 'Linked Google Drive folder Private'), {
      group: 'setting', item: 'Linked Google Drive folder Private', result: 'not set',
      detail: 'HTTP 400: Folder is not reachable; add it again once this account has Google Drive connected in this account, with access to that folder',
    });
    assert.match(r.statusText, /1 item could not be imported/);
  });

  await test('members of the original and memory that was off are named, not dropped in silence', async () => {
    const r = await importInto(makeServer(), codeFolder(tree => {
      const edited = JSON.parse(JSON.stringify(manifest));
      edited.settings.other_members = 2;
      edited.settings.memory_enabled = false;
      tree['export.json'] = Buffer.from(JSON.stringify(edited));
    }));

    assert.deepStrictEqual(rowFor(r, 'Members'), {
      group: 'setting', item: 'Members', result: 'left out',
      detail: '2 other people were members of the original; an import cannot add people, so invite them again in the new project',
    });
    assert.strictEqual(rowFor(r, 'Memory').result, 'left out');
  });

  await test('if pausing fails it says the project is running', async () => {
    const m = makeServer({
      fault: (url, headers, nth, init) =>
        init.method === 'PATCH' && /"disabled"/.test(init.body) ? v1Error(403, 'Only the owner can pause') : null,
    });
    const r = await importInto(m, codeFolder());
    assert.ok(!r.statusText.includes('It is paused'));
    assert.deepStrictEqual(rowFor(r, 'Pause'), { group: 'setting', item: 'Pause', result: 'not set', detail: 'HTTP 403: Only the owner can pause' });
    assert.match(r.statusText, /1 item could not be imported/);
  });

  await test('it only says the project is paused when the site’s answer shows it', async () => {
    const m = makeServer({
      fault: (url, headers, nth, init) => {
        if (!(init.method === 'PATCH' && /"disabled"/.test(init.body))) return null;
        // Accepted, and nothing changed.
        const st = [...m.state.channels.values()].find(c => url.pathname.endsWith(c.record.id));
        return json(200, { channel: { ...st.record, disabled_at: null } });
      },
    });
    const r = await importInto(m, codeFolder());

    assert.strictEqual(madeChannels(m)[0].record.disabled_at, null);
    assert.ok(!r.statusText.includes('It is paused'));
    assert.deepStrictEqual(rowFor(r, 'Pause'), {
      group: 'setting', item: 'Pause', result: 'not set',
      detail: 'the site accepted the request, but its answer does not show the project as paused',
    });
    assert.match(r.statusText, /1 item could not be imported/);
  });

  // ------------------------------------------------------------------
  console.log('\n6. The importer’s settings');

  await test('PAUSE_WHEN_DONE = false leaves the project running and says so up front', async () => {
    const m = makeServer();
    const r = await importInto(m, codeFolder(), { patch: setting('PAUSE_WHEN_DONE', 'false') });

    assert.strictEqual(madeChannels(m)[0].record.disabled_at, null);
    assert.ok(!writes(r).some(q => /"disabled"/.test(q.body || '')));
    assert.ok(r.promptsShown[0].includes('A Claude Code project has its own Claude, which starts with the project.'));
    assert.ok(!r.statusText.includes('paused'));
  });

  await test('IMPORT_HISTORY = false imports the project without its conversations', async () => {
    const m = makeServer();
    const r = await importInto(m, codeFolder(), { patch: setting('IMPORT_HISTORY', 'false') });

    assert.match(r.statusText, /^Done — “beethoven \(imported\)” was created with 9 files\. 2 items were left out/);
    // Its own files; its memory, which is not a conversation, is in its memory.
    assert.strictEqual(madeChannels(m)[0].files.size, 9);
    assert.strictEqual(madeChannels(m)[0].memory.memories.length, 4);
    assert.ok(!r.promptsShown[0].includes('saved conversation'));
  });

  await test('HISTORY_FOLDER names the folder the conversations go in', async () => {
    const m = makeServer();
    await importInto(m, codeFolder(), { patch: setting('HISTORY_FOLDER', "'archive/from-export'") });
    assert.ok(madeChannels(m)[0].files.has('archive/from-export/Timeline.md'));
  });

  await test('files over the size limit are left out with a reason, not attempted', async () => {
    const m = makeServer();
    const r = await importInto(m, codeFolder(), { patch: setting('MAX_UPLOAD_BYTES', '50000') });

    assert.deepStrictEqual(rowFor(r, 'big/blob.bin'), {
      group: 'file', item: 'big/blob.bin', result: 'left out', detail: 'larger than 49 KB (68 KB); add it by hand',
    });
    assert.ok(!madeChannels(m)[0].files.has('big/blob.bin'));
    assert.ok(![...m.state.uploads.values()].some(u => u.name === 'blob.bin'));

    // The same rule holds for the saved conversations.
    const tooBig = manifest.history.filter(h => exported.bytes[`beethoven/${h.path}`].length > 50000);
    assert.strictEqual(tooBig.length, 1);
    assert.strictEqual(rowFor(r, `Saved conversation ${tooBig[0].path}`).result, 'left out');
    assert.strictEqual(m.state.uploads.size, 38 - 2);
    assert.match(r.statusText, /created with 8 of 9 files and 28 of 29 history files\. 4 items were left out or moved on purpose/);
  });

  await test('ids outside production, with a middle part, are tagged to match', async () => {
    const m = makeServer({ idInfix: 'stg' });
    const r = await importInto(m, codeFolder());
    const id = madeChannels(m)[0].record.id;

    assert.match(id, /^chan_stg_01/);
    assert.match(r.statusText, /created with 9 files and 29 history files/);
    const sent = writes(r).filter(q => q.path.endsWith('files:write')).flatMap(q => bodyOf(q).files.map(f => f.source_file_id));
    assert.ok(sent.every(x => /^file_stg_01[1-9A-HJ-NP-Za-km-z]{22}$/.test(x)));
    assert.deepStrictEqual(sent.slice().sort(), [...m.state.uploads.keys()].map(u => siteTaggedId('file', u, id)).sort());
  });

  // ------------------------------------------------------------------
  console.log('\n7. A regular project, there and back');

  const stdMain = makeServer();
  const stdImp = await importInto(stdMain, stdFolder());
  const [stdMade] = madeProjects(stdMain);
  const stdManifest = parse(exportedStd.files['Recipes/export.json']);

  await test('it imports and reports success', async () => {
    assert.strictEqual(stdImp.loadError, null);
    assert.deepStrictEqual(lines(stdImp, 'error'), []);
    assert.strictEqual(
      stdImp.statusText,
      'Done — “Recipes (imported)” was created with 4 files and 3 history files.'
    );
    assert.strictEqual(
      stdImp.promptsShown[0],
      [
        'Import “Recipes” as a NEW project?',
        '',
        'Note: the project this was exported from can be seen from this login. To copy it ' +
          'to another account, press Cancel and sign in to claude.ai as that account first.',
        '',
        'It will get its description, its instructions, 4 files, 3 saved conversations as reference files.',
        'It will be private. Nothing that exists now is changed.',
        '',
        'Name for the new project (Cancel stops here):',
      ].join('\n')
    );
    const link = stdImp.elements.find(e => e.tagName === 'A');
    assert.strictEqual(link.href, `https://claude.ai/project/${stdMade.project.uuid}`);
  });

  await test('one private project is made, with its description and instructions', async () => {
    assert.strictEqual(madeProjects(stdMain).length, 1);
    assert.strictEqual(madeChannels(stdMain).length, 0);

    const creates = writes(stdImp).filter(q => q.method === 'POST' && q.path === `/api/organizations/${ORG_CHAT}/projects`);
    assert.deepStrictEqual(creates.map(bodyOf), [
      { name: 'Recipes (imported)', is_private: true, is_starred: false, description: 'Family recipes' },
    ]);
    const puts = writes(stdImp).filter(q => q.method === 'PUT');
    assert.deepStrictEqual(puts.map(q => [q.path, bodyOf(q)]), [
      [`/api/organizations/${ORG_CHAT}/projects/${stdMade.project.uuid}`, { prompt_template: 'Be a patient cook.' }],
    ]);

    assert.strictEqual(stdMade.project.name, 'Recipes (imported)');
    assert.strictEqual(stdMade.project.description, 'Family recipes');
    assert.strictEqual(stdMade.project.prompt_template, 'Be a patient cook.');
    assert.strictEqual(stdMade.project.is_private, true);
  });

  await test('its documents come back under their names with their text', async () => {
    const docs = Object.fromEntries(stdMade.docs.map(d => [d.file_name, d.content]));
    assert.strictEqual(docs['notes.md'], '# Notes\n\nSalt the water.');
    // Text that Claude had taken from a file keeps the file's name.
    assert.strictEqual(docs['grandma-letter.docx'], 'Dear all,\nuse more butter.');
  });

  await test('its pictures and PDFs come back as the files themselves, byte for byte', async () => {
    const byName = Object.fromEntries(stdMade.files.map(f => [f.file_name, stdMade.blobs.get(f.file_uuid)]));
    assert.deepStrictEqual(Object.keys(byName).sort(), ['kitchen.png', 'menu.pdf']);
    assert.strictEqual(Buffer.compare(byName['menu.pdf'].bytes, stdMain.MENU_PDF), 0);
    assert.strictEqual(Buffer.compare(byName['kitchen.png'].bytes, stdMain.KITCHEN_PNG), 0);

    // Added plainly: there is nothing to explain about either.
    assert.deepStrictEqual(rowFor(stdImp, 'menu.pdf'), { group: 'file', item: 'menu.pdf', result: 'added', detail: '' });
    assert.deepStrictEqual(rowFor(stdImp, 'kitchen.png'), { group: 'file', item: 'kitchen.png', result: 'added', detail: '' });
  });

  await test('where an export only got Claude’s copy of a file, that copy goes up and it says so', async () => {
    // An export made while the files themselves could not be had.
    const lesser = await exportOf(makeServer({ noContents: true }), STD_TAB);
    const m = makeServer();
    const r = await importInto(m, folder(lesser, 'Recipes'));
    const [p] = madeProjects(m);
    const byName = Object.fromEntries(p.files.map(f => [f.file_name, p.blobs.get(f.file_uuid)]));

    // The copy of the picture is a WebP, whatever the picture was: it is
    // named for what it is.
    assert.deepStrictEqual(Object.keys(byName).sort(), ['kitchen.webp', 'menu.pdf']);
    assert.strictEqual(Buffer.compare(byName['kitchen.webp'].bytes, m.previewOf('kitchen.png')), 0);
    assert.strictEqual(byName['kitchen.webp'].type, 'image/webp');
    assert.deepStrictEqual(rowFor(r, 'kitchen.png'), {
      group: 'file',
      item: 'kitchen.png',
      result: 'added',
      detail: 'the export holds Claude’s preview copy of this file, not the file itself; that copy was added as kitchen.webp',
    });
    assert.deepStrictEqual(rowFor(r, 'menu.pdf'), {
      group: 'file',
      item: 'menu.pdf',
      result: 'added',
      detail: 'the export holds Claude’s representation copy of this file, not the file itself; that copy was added',
    });
    assert.strictEqual(r.statusText, 'Done — “Recipes (imported)” was created with 4 files and 3 history files.');
  });

  await test('the chats and the project memory are added as documents', async () => {
    const docs = Object.fromEntries(stdMade.docs.map(d => [d.file_name, d.content]));
    assert.deepStrictEqual(Object.keys(docs).sort(), [
      'Chat history – Pasta– basics– (2).md',
      'Chat history – Pasta– basics–.md',
      'Project memory (from the original project).md',
      'grandma-letter.docx',
      'notes.md',
    ]);
    assert.strictEqual(docs['Project memory (from the original project).md'], 'Prefers metric units.');
    assert.strictEqual(docs['Chat history – Pasta– basics–.md'], exportedStd.files['Recipes/Chats/Pasta– basics–/Pasta– basics–.md']);
    assert.strictEqual(docs['Chat history – Pasta– basics– (2).md'], exportedStd.files['Recipes/Chats/Pasta– basics– (2)/Pasta– basics–.md']);
    assert.ok(docs['Chat history – Pasta– basics–.md'].includes('How do I cook pasta? (1)'));
  });

  await test('only /api/ is used, with no /v1/ headers, and nothing existing is touched', async () => {
    assert.ok(stdImp.requests.every(q => q.path.startsWith('/api/')));
    assert.ok(stdImp.requests.every(q => !('anthropic-version' in q.headers) && !('x-organization-uuid' in q.headers)));
    assert.ok(!stdImp.requests.some(q => q.method === 'DELETE'));

    const id = stdMade.project.uuid;
    for (const q of writes(stdImp)) {
      assert.ok(
        q.path === `/api/organizations/${ORG_CHAT}/projects` || q.path.startsWith(`/api/organizations/${ORG_CHAT}/projects/${id}`),
        `${q.method} ${q.path}`
      );
    }
    // Each thing is added once.
    assert.strictEqual(writes(stdImp).filter(q => q.path.endsWith('/docs')).length, 5);
    assert.strictEqual(writes(stdImp).filter(q => q.path.endsWith('/upload')).length, 2);
  });

  await test('exporting the new project gives back the same knowledge', async () => {
    const again = await exportOf(stdMain, `/project/${stdMade.project.uuid}`);
    assert.match(again.statusText, /^Done — 0 chats exported\.$/);

    const m2 = parse(again.files['Recipes (imported)/export.json']);
    assert.strictEqual(m2.description, stdManifest.description);
    assert.strictEqual(m2.instructions, stdManifest.instructions);
    assert.deepStrictEqual(m2.settings, { is_private: true, is_starred: false });

    const at = name => `Recipes (imported)/${m2.files.find(f => f.name === name).path}`;
    assert.strictEqual(Buffer.compare(again.bytes[at('menu.pdf')], exportedStd.bytes['Recipes/Files/menu.pdf']), 0);
    assert.strictEqual(Buffer.compare(again.bytes[at('kitchen.png')], stdMain.KITCHEN_PNG), 0);
    assert.deepStrictEqual(m2.files.filter(f => f.type === 'file').map(f => [f.name, f.copy]), [['menu.pdf', 'original'], ['kitchen.png', 'original']]);
    assert.strictEqual(again.files[at('notes.md')], exportedStd.files['Recipes/Files/notes.md']);
    assert.strictEqual(again.files[at('grandma-letter.docx')], exportedStd.files['Recipes/Files/grandma-letter.docx.extracted.md']);
    assert.strictEqual(again.files[at('Chat history – Pasta– basics–.md')], exportedStd.files['Recipes/Chats/Pasta– basics–/Pasta– basics–.md']);
  });

  await test('chats with long or matching titles each get a short name of their own', async () => {
    const long = 'A very long conversation title that goes on and on, well past the point where a file name is still comfortable to read';
    const m = makeServer();
    const r = await importInto(m, stdFolder(tree => {
      const edited = JSON.parse(JSON.stringify(stdManifest));
      edited.files = [];
      edited.memory = null;
      edited.history = [];
      for (const [i, dir] of [`${long} one`, `${long} two`, 'Same', 'same'].entries()) {
        tree[`Chats/${dir}/chat.md`] = Buffer.from(`chat ${i}`);
        edited.history.push({ path: `Chats/${dir}/chat.md`, title: dir, type: 'chat' });
      }
      tree['export.json'] = Buffer.from(JSON.stringify(edited));
    }));

    const names = madeProjects(m)[0].docs.map(d => d.file_name);
    assert.strictEqual(r.statusText, 'Done — “Recipes (imported)” was created with 4 history files.');
    assert.deepStrictEqual(names, [
      `Chat history – ${long.slice(0, 100)}….md`,
      `Chat history – ${long.slice(0, 100)}… (2).md`,
      'Chat history – Same.md',
      'Chat history – same (2).md',
    ]);
    assert.deepStrictEqual(madeProjects(m)[0].docs.map(d => d.content), ['chat 0', 'chat 1', 'chat 2', 'chat 3']);
  });

  await test('a starred project comes back starred', async () => {
    const m = makeServer();
    await importInto(m, stdFolder(tree => {
      tree['export.json'] = Buffer.from(JSON.stringify({ ...stdManifest, settings: { is_private: false, is_starred: true } }));
    }));
    const [p] = madeProjects(m);
    assert.strictEqual(p.project.is_starred, true);
    assert.strictEqual(p.project.is_private, true); // private all the same
  });

  // ------------------------------------------------------------------
  console.log('\n8. A regular project, when things are refused');

  const projectsUrl = `/api/organizations/${ORG_CHAT}/projects`;

  await test('if the description is refused the project is made without it and described after', async () => {
    const m = makeServer({
      faultEverywhere: true,
      fault: (url, headers, nth, init) =>
        url.pathname === projectsUrl && init.method === 'POST' && JSON.parse(init.body).description
          ? apiError(400, 'invalid_request_error', 'description: too long')
          : null,
    });
    const r = await importInto(m, stdFolder());
    const [p] = madeProjects(m);

    assert.match(r.statusText, /^Done — “Recipes \(imported\)” was created with 4 files and 3 history files\.$/);
    assert.strictEqual(madeProjects(m).length, 1);
    assert.deepStrictEqual(writes(r).filter(q => q.method === 'PUT').map(bodyOf), [
      { description: 'Family recipes' }, { prompt_template: 'Be a patient cook.' },
    ]);
    assert.strictEqual(p.project.description, 'Family recipes');
  });

  await test('a refusal to create it is shown, and nothing else is tried', async () => {
    const m = makeServer({
      faultEverywhere: true,
      fault: (url, headers, nth, init) =>
        url.pathname === projectsUrl && init.method === 'POST'
          ? apiError(403, 'permission_error', 'You have reached the project limit for your plan', { details: { error_code: 'free_user_project_limit' } })
          : null,
    });
    const r = await importInto(m, stdFolder(tree => {
      tree['export.json'] = Buffer.from(JSON.stringify({ ...stdManifest, description: '' }));
    }));
    assert.strictEqual(
      r.statusText,
      'Import failed: The site refused to create the project: HTTP 403: You have reached the project limit for your plan — free_user_project_limit.'
    );
    assert.strictEqual(writes(r).length, 1);
  });

  await test('an unclear answer to creating it is not followed by another attempt', async () => {
    const m = makeServer({
      faultEverywhere: true,
      fault: (url, headers, nth, init) => {
        if (url.pathname === projectsUrl && init.method === 'POST') throw new TypeError('Failed to fetch');
        return null;
      },
    });
    const r = await importInto(m, stdFolder());
    assert.match(r.statusText, /^Import failed: The request to create the project got no clear answer \(network error \(Failed to fetch\)\)\./);
    assert.strictEqual(writes(r).length, 1);
  });

  await test('a document that is refused is reported; the rest are added', async () => {
    const m = makeServer({
      faultEverywhere: true,
      fault: (url, headers, nth, init) =>
        url.pathname.endsWith('/docs') && init.method === 'POST' && JSON.parse(init.body).file_name === 'notes.md'
          ? apiError(413, 'invalid_request_error', 'This project’s knowledge is full')
          : null,
    });
    const r = await importInto(m, stdFolder());

    assert.match(r.statusText, /^Done — “Recipes \(imported\)” was created with 3 of 4 files and 3 history files\. 1 item could not be imported; the console lists it\.$/);
    assert.deepStrictEqual(rowFor(r, 'notes.md'), {
      group: 'file', item: 'notes.md', result: 'not added', detail: 'HTTP 413: This project’s knowledge is full',
    });
    assert.strictEqual(madeProjects(m)[0].docs.length, 4);
  });

  await test('after five refusals in a row it stops asking', async () => {
    const m = makeServer({
      faultEverywhere: true,
      fault: (url, headers, nth, init) =>
        (url.pathname.endsWith('/docs') || url.pathname.endsWith('/upload')) && init.method === 'POST'
          ? apiError(413, 'invalid_request_error', 'This project’s knowledge is full')
          : null,
    });
    const r = await importInto(m, stdFolder());
    const rows = account(r).filter(x => x.result === 'not added');

    assert.strictEqual(rows.length, 7);
    assert.deepStrictEqual(rows.slice(5).map(x => x.detail), Array(2).fill('not tried: the five before it all failed'));
    assert.strictEqual(writes(r).filter(q => /\/(docs|upload)$/.test(q.path)).length, 5);
  });

  await test('a document whose answer was lost is found by the closing check', async () => {
    let lost = false;
    const m = makeServer({
      faultEverywhere: true,
      fault: (url, headers, nth, init) => {
        if (!url.pathname.endsWith('/docs') || init.method !== 'POST' || lost) return null;
        lost = true;
        return m.server(url, headers, init).then(() => { throw new TypeError('Failed to fetch'); });
      },
    });
    const r = await importInto(m, stdFolder());

    // Not sent twice: that could have made two of it.
    assert.strictEqual(madeProjects(m)[0].docs.filter(d => d.file_name === 'notes.md').length, 1);
    assert.deepStrictEqual(rowFor(r, 'notes.md'), {
      group: 'file', item: 'notes.md', result: 'added', detail: 'the reply was lost, but the project lists it',
    });
    assert.match(r.statusText, /^Done — “Recipes \(imported\)” was created with 4 files and 3 history files\.$/);
  });

  await test('something the site accepted but does not list is flagged for checking', async () => {
    let inside = false;
    const m = makeServer({
      faultEverywhere: true,
      fault: (url, headers, nth, init) => {
        if (!url.pathname.endsWith('/upload') || inside) return null;
        inside = true;
        return m.server(url, headers, init).then(res => {
          inside = false;
          const p = madeProjects(m)[0];
          p.files = p.files.filter(f => f.file_name !== 'menu.pdf');
          return res;
        });
      },
    });
    const r = await importInto(m, stdFolder());
    assert.deepStrictEqual(rowFor(r, 'menu.pdf'), {
      group: 'file', item: 'menu.pdf', result: 'to check', detail: 'the site accepted it, but the project does not list it (yet)',
    });
    assert.match(r.statusText, /created with 3 of 4 files and 3 history files\. 1 item should be checked in the project; the console lists it\.$/);
  });

  await test('a file the export only has a thumbnail of is left out, and it says why', async () => {
    const m = makeServer();
    const r = await importInto(m, stdFolder(tree => {
      const edited = JSON.parse(JSON.stringify(stdManifest));
      assert.strictEqual(edited.files[1].name, 'kitchen.png');
      edited.files[1] = { path: 'Files/kitchen [Claude thumbnail].png', name: 'kitchen.png', type: 'file', copy: 'thumbnail', mime: 'image/webp' };
      tree['export.json'] = Buffer.from(JSON.stringify(edited));
    }));
    assert.deepStrictEqual(rowFor(r, 'kitchen.png'), {
      group: 'file', item: 'kitchen.png', result: 'left out', detail: 'the export holds only a thumbnail of this file, not the file',
    });
    assert.deepStrictEqual(madeProjects(m)[0].files.map(f => f.file_name), ['menu.pdf']);
    assert.match(r.statusText, /created with 3 of 4 files and 3 history files\. 1 item was left out or moved on purpose; the console says why\.$/);
  });

  await test('IMPORT_HISTORY = false leaves the chats and the memory on disk', async () => {
    const m = makeServer();
    const r = await importInto(m, stdFolder(), { patch: setting('IMPORT_HISTORY', 'false') });
    assert.strictEqual(r.statusText, 'Done — “Recipes (imported)” was created with 4 files.');
    assert.deepStrictEqual(madeProjects(m)[0].docs.map(d => d.file_name).sort(), ['grandma-letter.docx', 'notes.md']);
  });

  await test('if the folder can no longer be read, each file is reported and the import carries on', async () => {
    const m = makeServer();
    // Access to the folder is withdrawn once the project exists.
    const pick = stdFolder();
    const real = pick.getDirectoryHandle.bind(pick);
    let calls = 0;
    pick.getDirectoryHandle = async (...args) => {
      if (++calls > 1) throw Object.assign(new Error('The request is not allowed'), { name: 'NotAllowedError' });
      return real(...args);
    };
    const r = await importInto(m, pick);

    assert.strictEqual(madeProjects(m).length, 1);
    assert.match(r.statusText, /^Done — “Recipes \(imported\)” was created with 1 of 4 files and 1 of 3 history files\. 5 items could not be imported/);
    assert.strictEqual(account(r).filter(x => x.detail === 'could not be read (The request is not allowed)').length, 5);
    // The instructions were still set.
    assert.strictEqual(madeProjects(m)[0].project.prompt_template, 'Be a patient cook.');
  });

  await test('if it does stop part-way, the project is named and linked, and cannot be made twice', async () => {
    for (const [pick, tab] of [[stdFolder(), 'project'], [codeFolder(), 'code/project']]) {
      const m = makeServer();
      const r = await importInto(m, pick, {
        // Something unforeseen goes wrong once the project exists.
        patch: src => {
          const out = src.split("setStatus('Checking the new project\\u2026');").join("throw new Error('something unforeseen');");
          assert.notStrictEqual(out, src);
          return out;
        },
      });

      const id = tab === 'project' ? madeProjects(m)[0].project.uuid : madeChannels(m)[0].record.id;
      const name = tab === 'project' ? 'Recipes (imported)' : 'beethoven (imported)';
      assert.strictEqual(
        r.statusText,
        `The import stopped part-way (something unforeseen). The new project “${name}” exists and holds whatever ` +
        'was added before that; the console lists it. To carry on in it, paste this script again and give that ' +
        'project’s address as the name; to start over, delete that project first.'
      );
      const link = r.elements.find(e => e.tagName === 'A');
      assert.strictEqual(link.href, `https://claude.ai/${tab}/${id}`);
      assert.strictEqual(link.style.display, 'block');
      assert.strictEqual(r.button.disabled, true);
      assert.ok(lines(r, 'error').some(t => t.includes('something unforeseen')));
    }
  });

  await test('an import that stopped part-way is carried on in the same project', async () => {
    const m = makeServer();
    // The first import stops once the project and its first files exist.
    const first = await importInto(m, codeFolder(), {
      patch: src => {
        const out = src.split("setStatus('Applying the project\\u2019s settings\\u2026');").join("throw new Error('the window went away');");
        assert.notStrictEqual(out, src);
        return out;
      },
    });
    assert.ok(first.statusText.startsWith('The import stopped part-way (the window went away).'), first.statusText);
    const [made] = madeChannels(m);
    const before = [...made.files.keys()];
    assert.strictEqual(before.length, 38);
    // A few of them are taken away again, as if the stop had come sooner.
    for (const path of before.slice(0, 3)) made.files.delete(path);
    assert.ok(!made.config.system_prompt_addendum);

    // The second import is given the project's address instead of a name.
    const again = await importInto(m, codeFolder(), { prompts: [`https://claude.ai/code/project/${made.record.id}`] });
    assert.strictEqual(again.loadError, null);
    assert.deepStrictEqual(lines(again, 'error'), []);
    assert.strictEqual(madeChannels(m).length, 1); // no second project
    assert.strictEqual(
      again.statusText,
      'Done — the import into “beethoven (imported)” was completed with 9 files and 29 history files. ' +
      '2 items were left out or moved on purpose; the console says why. ' +
      'The original project’s memory is in the new project’s memory (4 files). ' +
      'It is paused: open it and press Resume when you want its Claude to start.'
    );
    assert.strictEqual(made.files.size, 38);
    assert.strictEqual(made.config.system_prompt_addendum, 'You are the beethoven channel agent.\nAlways answer in threads.');
    assert.ok(made.record.disabled_at);
    // What was there already was left alone, and said so; the rest was added.
    const rows = account(again);
    assert.strictEqual(rows.find(r => r.group === 'project').result, 'continued');
    const kept = rows.filter(r => r.detail === 'already in the project');
    assert.strictEqual(kept.length, before.length - 3);
    // The memory the first import wrote is found there and not sent again.
    assert.strictEqual(rows.filter(r => r.detail === 'already in the new project’s memory').length, 4);
    assert.ok(!writes(again).some(q => q.path.endsWith('/memories')));
    assert.strictEqual(made.memory.memories.length, 4);
    assert.strictEqual(writes(again).filter(q => q.method === 'POST' && q.path === '/v1/code/channels').length, 0);
    const written = writes(again).filter(q => q.path.endsWith('files:write')).flatMap(q => bodyOf(q).files.map(f => f.path));
    assert.strictEqual(written.length, 38 - kept.length);
    assert.ok(!written.some(p => kept.some(k => k.path === p)));
    const link = again.elements.find(e => e.tagName === 'A');
    assert.strictEqual(link.href, `https://claude.ai/code/project/${made.record.id}`);
  });

  await test('a paused project is set going for the files and paused again', async () => {
    const m = makeServer();
    await importInto(m, codeFolder());
    const [made] = madeChannels(m);
    assert.ok(made.record.disabled_at);
    const [one] = [...made.files.keys()].filter(p => !/^(imported-history|carried-memory)\//.test(p));
    made.files.delete(one);
    const again = await importInto(m, codeFolder(), { prompts: [made.record.id] });
    assert.deepStrictEqual(lines(again, 'error'), []);
    assert.ok(made.files.has(one), one);
    assert.ok(made.record.disabled_at);
    assert.strictEqual(madeChannels(m).length, 1);
  });

  await test('a file already there in another size is left alone and pointed out', async () => {
    const m = makeServer();
    await importInto(m, codeFolder());
    const [made] = madeChannels(m);
    const [one] = [...made.files.keys()].filter(p => !/^(imported-history|carried-memory)\//.test(p));
    made.files.set(one, Buffer.from('edited since'));
    const again = await importInto(m, codeFolder(), { prompts: [made.record.id] });
    assert.deepStrictEqual(lines(again, 'error'), []);
    assert.strictEqual(made.files.get(one).toString(), 'edited since');
    const row = rowFor(again, one);
    assert.strictEqual(row.result, 'to check');
    assert.match(row.detail, /^already in the project, as 12 bytes where the export has .*; left as it is$/);
    assert.ok(again.statusText.includes('1 item should be checked in the project'), again.statusText);
  });

  await test('a project that is not in view cannot be carried on in', async () => {
    const m = makeServer();
    const r = await importInto(m, codeFolder(), { prompts: ['chan_01NOSUCHPROJECT0000000000'] });
    assert.strictEqual(
      r.statusText,
      'Import failed: No Claude Code project with the id chan_01NOSUCHPROJECT0000000000 is in view from this login. ' +
      'If it was deleted, import the export as a new project.'
    );
    assert.strictEqual(madeChannels(m).length, 0);
    assert.strictEqual(r.button.disabled, false);
  });

  await test('a regular project cannot be carried on in', async () => {
    const m = makeServer();
    const r = await importInto(m, stdFolder(), { prompts: ['https://claude.ai/code/project/chan_01BEETHOVENBEETHOVEN0000'] });
    assert.strictEqual(r.statusText, 'Import failed: Carrying on in an existing project is only done for Claude Code projects.');
    assert.strictEqual(madeProjects(m).length, 0);
  });

  await test('a project with no name in its manifest takes the folder’s name', async () => {
    const m = makeServer();
    const r = await importInto(m, stdFolder(tree => {
      tree['export.json'] = Buffer.from(JSON.stringify({ ...stdManifest, name: '' }));
    }));
    // "Recipes" is taken in the mock, so the folder's name gets the usual suffix.
    assert.match(r.statusText, /^Done — “Recipes \(imported\)” was created/);
    assert.ok(r.promptsShown[0].startsWith('Import “Recipes” as a NEW project?'));
  });

  // ------------------------------------------------------------------
  console.log('\n9. Starting up');

  await test('signed out, it says so and adds no button', async () => {
    const m = makeServer({
      faultEverywhere: true,
      fault: url => (url.pathname === '/api/organizations' ? apiError(401, 'authentication_error', 'Not signed in') : null),
    });
    const r = await importInto(m, codeFolder());
    assert.strictEqual(r.button, undefined);
    assert.deepStrictEqual(lines(r, 'error'), [
      'Claude importer could not start. Run it in a claude.ai tab while signed in. (HTTP 401: Not signed in)',
    ]);
  });

  await test('a browser without a folder picker is pointed at the .tar button, and nothing fails', async () => {
    const m = makeServer();
    const r = await importInto(m, codeFolder(), {
      patch: src => {
        const out = src.replace('if (!window.showDirectoryPicker) {', 'if (true) {');
        assert.notStrictEqual(out, src);
        return out;
      },
    });
    assert.strictEqual(
      r.statusText,
      'This browser cannot open a folder. Press “Import from a .tar file instead” and choose the .tar file ' +
      'the exporter saved, or drop that file on these buttons.'
    );
    assert.deepStrictEqual(lines(r, 'error'), []);
    assert.deepStrictEqual(r.promptsShown, []);
    assert.deepStrictEqual(r.requests.map(q => q.path), ['/api/organizations']);
    assert.strictEqual(r.pickerCalls, 0);
    assert.strictEqual(r.button.disabled, false);
    assert.strictEqual(madeChannels(m).length, 0);
  });

  await test('an account with only an API organization is told it cannot hold projects', async () => {
    const m = makeServer({
      faultEverywhere: true,
      fault: url => (url.pathname === '/api/organizations' ? json(200, [{ uuid: ORG_API, name: 'Individual Org', capabilities: ['api'] }]) : null),
    });
    const r = await importInto(m, codeFolder());
    assert.strictEqual(r.statusText, 'Import failed: This login has no Claude organization that can hold projects.');
    assert.deepStrictEqual(writes(r), []);
  });

  // ------------------------------------------------------------------
  console.log('\n10. Importing from a .tar');

  // The export packed as the exporter's .tar would be: every file under
  // the export folder's name. `rename` changes each path first.
  const tarOf = (bytes, rename = p => p) =>
    pack(Object.entries(bytes).map(([p, b]) => ({ path: rename(p), bytes: b })));
  const tarFile = (buffer, name = 'beethoven.tar') => new File([buffer], name);

  // What section 1 saw, which a .tar import has to equal.
  const DONE_FROM_TAR =
    'Done — “beethoven (imported)” was created with 9 files and 29 history files. ' +
    '2 items were left out or moved on purpose; the console says why. ' +
    'The original project’s memory is in the new project’s memory (4 files). ' +
    'It is paused: open it and press Resume when you want its Claude to start.';

  // The importer's live state after run() returned: its status box, its
  // two buttons and the hidden file input. (run()'s statusText is a
  // snapshot taken before the .tar was handed in.)
  const statusOf = r => r.elements.find(e => e.tagName === 'DIV' && e !== r.elements[0]).textContent;
  const buttonsOf = r => r.elements.filter(e => e.tagName === 'BUTTON');
  const inputOf = r => r.elements.find(e => e.tagName === 'INPUT');

  // A drop event as a browser without the File System Access API sends
  // it: the file alone. `items` is what Chrome adds.
  const dropEvent = (file, items) => ({
    preventDefault() {},
    stopPropagation() {},
    dataTransfer: { files: file ? [file] : [], ...(items ? { items } : {}) },
  });
  const drop = (r, event) => r.elements.find(e => e.listeners.drop).listeners.drop[0](event);

  // Loads the importer without pressing anything, then hands `file` in
  // the way `how` says: chosen in the file window the .tar button opens,
  // or dropped on the buttons.
  async function importTar(m, file, how, opts = {}) {
    // No folder: the picker is never opened.
    const r = await importInto(m, null, { click: false, prompts: [''], ...opts });

    if (how === 'drop') {
      await drop(r, dropEvent(file));
    } else {
      buttonsOf(r)[1].click();
      const input = inputOf(r);
      input.files = [file];
      await input.listeners.change[0]({ target: input });
    }

    return r;
  }

  await test('a .tar chosen with the second button imports exactly as the folder does', async () => {
    const m = makeServer();
    const r = await importTar(m, tarFile(tarOf(exported.bytes)), 'input');

    assert.strictEqual(r.loadError, null);
    assert.deepStrictEqual(lines(r, 'error'), []);
    assert.deepStrictEqual(lines(r, 'warn'), []);
    assert.strictEqual(statusOf(r), DONE_FROM_TAR);
    assert.strictEqual(r.pickerCalls, 0);
    assert.strictEqual(r.pickerOptions.length, 0);
    assert.ok(r.promptsShown[0].startsWith('Import “beethoven” as a NEW Claude Code project?'));

    assert.strictEqual(madeChannels(m).length, 1);
    assert.strictEqual(madeProjects(m).length, 0);
    const [got] = madeChannels(m);
    for (const [name, bytes] of source.world.files) {
      assert.ok(got.files.has(name), `missing ${name}`);
      assert.strictEqual(Buffer.compare(got.files.get(name), bytes), 0, name);
    }
    assert.strictEqual(got.files.size, 38);
    assert.ok(got.record.disabled_at);

    // The buttons are as after a folder import: both off, the main one
    // saying so.
    const [btn, tarBtn] = buttonsOf(r);
    assert.strictEqual(btn.textContent, 'Import complete');
    assert.strictEqual(btn.disabled, true);
    assert.strictEqual(tarBtn.textContent, 'Import from a .tar file instead');
    assert.strictEqual(tarBtn.disabled, true);
    assert.strictEqual(inputOf(r).type, 'file');
    assert.strictEqual(inputOf(r).accept, '.tar');
    // The same file can be chosen again: the input forgets it.
    assert.strictEqual(inputOf(r).value, '');
    // The input lives in the importer's own box, after the buttons, so
    // that pasting the script again takes it away with the rest instead
    // of leaving one more behind on the page.
    assert.strictEqual(r.elements[0].id, 'claude-simple-importer');
    assert.deepStrictEqual(r.elements[0].children.map(e => e.tagName), ['DIV', 'A', 'BUTTON', 'BUTTON', 'INPUT']);
    assert.strictEqual(r.elements[0].children[4], inputOf(r));
  });

  await test('a .tar dropped on the buttons imports the same way, and a second drop makes nothing', async () => {
    const m = makeServer();
    const file = tarFile(tarOf(exported.bytes));
    const r = await importTar(m, file, 'drop');

    assert.deepStrictEqual(lines(r, 'error'), []);
    assert.strictEqual(statusOf(r), DONE_FROM_TAR);
    assert.strictEqual(r.pickerOptions.length, 0);
    assert.strictEqual(madeChannels(m).length, 1);
    const [got] = madeChannels(m);
    for (const [name, bytes] of source.world.files) {
      assert.strictEqual(Buffer.compare(got.files.get(name), bytes), 0, name);
    }

    // Dragging over is accepted (the browser would otherwise open the
    // file) and kept from the page, whose chat box takes drops of its
    // own; and a project once created is not made twice.
    const target = r.elements.find(e => e.listeners.drop);
    let prevented = 0;
    let stopped = 0;
    const counted = { preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
    target.listeners.dragover[0](counted);
    await target.listeners.drop[0]({ ...counted, dataTransfer: { files: [file] } });
    assert.strictEqual(prevented, 2);
    assert.strictEqual(stopped, 2);
    assert.strictEqual(madeChannels(m).length, 1);
    assert.strictEqual(statusOf(r), DONE_FROM_TAR);
  });

  await test('the export folder itself, dropped on the buttons, is imported like a picked one', async () => {
    // Chrome hands a dropped folder over as the handle the picker would
    // have given; the item says it is a file, as it does for folders too.
    const m = makeServer();
    const r = await importInto(m, null, { click: false, prompts: [''] });
    await drop(r, dropEvent(null, [{ kind: 'file', getAsFileSystemHandle: async () => codeFolder() }]));

    assert.deepStrictEqual(lines(r, 'error'), []);
    assert.deepStrictEqual(lines(r, 'warn'), []);
    assert.strictEqual(statusOf(r), DONE_FROM_TAR);
    assert.strictEqual(r.pickerCalls, 0);
    assert.ok(r.promptsShown[0].startsWith('Import “beethoven” as a NEW Claude Code project?'));
    assert.strictEqual(madeChannels(m).length, 1);
    const [got] = madeChannels(m);
    for (const [name, bytes] of source.world.files) {
      assert.strictEqual(Buffer.compare(got.files.get(name), bytes), 0, name);
    }
    assert.strictEqual(got.files.size, 38);
    assert.ok(buttonsOf(r).every(b => b.disabled));
  });

  await test('a .tar dropped in Chrome comes as a file handle, and is read as a .tar', async () => {
    const file = tarFile(tarOf(exported.bytes));
    const asHandle = { kind: 'file', name: file.name, getFile: async () => file };

    for (const [items, files] of [
      // The handle wraps the .tar; `files` has it too, as in a browser.
      [[{ kind: 'file', getAsFileSystemHandle: async () => asHandle }], file],
      // No handle could be made: the file is used as elsewhere.
      [[{ kind: 'file', getAsFileSystemHandle: async () => null }], file],
    ]) {
      const m = makeServer();
      const r = await importInto(m, null, { click: false, prompts: [''] });
      await drop(r, dropEvent(files, items));

      assert.deepStrictEqual(lines(r, 'error'), []);
      assert.strictEqual(statusOf(r), DONE_FROM_TAR);
      assert.strictEqual(r.pickerCalls, 0);
      assert.strictEqual(madeChannels(m).length, 1);
      assert.strictEqual(madeChannels(m)[0].files.size, 38);
    }

    // Dropped text is not a file: nothing happens, and nothing is said.
    const m = makeServer();
    const r = await importInto(m, null, { click: false, prompts: [''] });
    await drop(r, dropEvent(null, [{ kind: 'string', getAsFileSystemHandle: async () => null }]));
    assert.strictEqual(statusOf(r), '');
    assert.deepStrictEqual(lines(r, 'error'), []);
    assert.deepStrictEqual(writes(r), []);
    assert.strictEqual(madeChannels(m).length, 0);
    assert.ok(buttonsOf(r).every(b => !b.disabled));
  });

  await test('a .tar that holds files but no export is refused in words that fit a file', async () => {
    const m = makeServer();
    const buffer = tarOf({ 'Holiday photos/beach.jpg': Buffer.from([1, 2, 3]), 'Holiday photos/sub/readme.txt': Buffer.from('hi') });

    for (const how of ['input', 'drop']) {
      const r = await importTar(m, tarFile(buffer, 'Holiday photos.tar'), how);
      assert.strictEqual(
        statusOf(r),
        'Import failed: There is no export in "Holiday photos". Choose the .tar file the exporter saved: the one that holds export.json.',
        how
      );
      assert.deepStrictEqual(r.promptsShown, []);
      assert.deepStrictEqual(writes(r), []);
      assert.ok(buttonsOf(r).every(b => !b.disabled));
    }
    assert.strictEqual(madeChannels(m).length + madeProjects(m).length, 0);
  });

  await test('a .tar whose files sit at the top level is the export itself', async () => {
    const m = makeServer();
    const r = await importTar(m, tarFile(tarOf(exported.bytes, p => p.slice('beethoven/'.length))), 'input');

    assert.deepStrictEqual(lines(r, 'error'), []);
    assert.strictEqual(statusOf(r), DONE_FROM_TAR);
    assert.strictEqual(madeChannels(m)[0].files.size, 38);
    // The root is named after the file, which the name prompt would
    // otherwise show; the manifest's name wins.
    assert.ok(r.promptsShown[0].startsWith('Import “beethoven” as a NEW Claude Code project?'));
  });

  await test('paths over 100 bytes, in GNU long-name entries, round-trip', async () => {
    // Under a folder name that is itself over the limit, every entry needs
    // one; the thread files, with their en dashes, go well past it.
    const long = 'beethoven – exported for moving to another account, under a folder name long enough to pass the ustar limit';
    assert.ok(Buffer.byteLength(long, 'utf8') > 100);
    const buffer = tarOf(exported.bytes, p => `${long}/${p.slice('beethoven/'.length)}`);

    const packed = unpack(buffer).map(e => e.path);
    assert.strictEqual(packed.length, Object.keys(exported.bytes).length);
    assert.ok(packed.every(p => Buffer.byteLength(p, 'utf8') > 100));
    const dashed = packed.filter(p => p.includes('–') && p.includes('/Threads/'));
    assert.ok(dashed.length >= 9, `only ${dashed.length} thread paths with an en dash`);

    const m = makeServer();
    const r = await importTar(m, tarFile(buffer, 'beethoven export.tar'), 'input');

    assert.deepStrictEqual(lines(r, 'error'), []);
    assert.deepStrictEqual(lines(r, 'warn'), []);
    assert.strictEqual(statusOf(r), DONE_FROM_TAR);
    const [got] = madeChannels(m);
    assert.strictEqual(got.files.size, 38);
    for (const p of dashed) {
      const inProject = `imported-history/${p.slice(long.length + 1)}`;
      assert.ok(got.files.has(inProject), inProject);
      assert.strictEqual(Buffer.compare(got.files.get(inProject), exported.bytes[`beethoven/${p.slice(long.length + 1)}`]), 0, p);
    }
  });

  await test('a file that is not a .tar is refused in plain words, and no project is made', async () => {
    for (const [file, how] of [
      [new File([Buffer.from('hello')], 'notes.txt'), 'input'],
      [new File([Buffer.from('hello')], 'notes.txt'), 'drop'],
      // Named .tar, long enough to hold a header, and nothing like one.
      [new File([Buffer.alloc(2048, 65)], 'junk.tar'), 'input'],
      // Nothing but the two closing blocks.
      [new File([Buffer.alloc(1024)], 'empty.tar'), 'drop'],
    ]) {
      const m = makeServer();
      const r = await importTar(m, file, how);

      assert.strictEqual(statusOf(r), `Import failed: ${file.name} is not a .tar file made by the exporter.`, how);
      assert.deepStrictEqual(r.promptsShown, []);
      assert.deepStrictEqual(writes(r), []);
      assert.strictEqual(madeChannels(m).length + madeProjects(m).length, 0);
      // It can be tried again with the right file.
      assert.ok(buttonsOf(r).every(b => !b.disabled));
      assert.ok(lines(r, 'error').some(t => t.includes('is not a .tar file made by the exporter.')));
    }
  });

  await test('a regular project from a .tar: its files get the types a folder would have given them', async () => {
    const m = makeServer();
    const r = await importTar(m, tarFile(tarOf(exportedStd.bytes), 'Recipes.tar'), 'drop');

    assert.deepStrictEqual(lines(r, 'error'), []);
    assert.strictEqual(statusOf(r), 'Done — “Recipes (imported)” was created with 4 files and 3 history files.');
    assert.strictEqual(madeChannels(m).length, 0);
    const [p] = madeProjects(m);
    const byName = Object.fromEntries(p.files.map(f => [f.file_name, p.blobs.get(f.file_uuid)]));
    assert.deepStrictEqual(Object.keys(byName).sort(), ['kitchen.png', 'menu.pdf']);
    assert.strictEqual(Buffer.compare(byName['menu.pdf'].bytes, m.MENU_PDF), 0);
    assert.strictEqual(Buffer.compare(byName['kitchen.png'].bytes, m.KITCHEN_PNG), 0);
    // A file sliced out of a .tar has no type of its own, as one read from
    // a folder has: it is given the one its name says.
    assert.strictEqual(byName['kitchen.png'].type, 'image/png');
    assert.strictEqual(byName['menu.pdf'].type, 'application/pdf');

    const docs = Object.fromEntries(p.docs.map(d => [d.file_name, d.content]));
    assert.strictEqual(docs['notes.md'], '# Notes\n\nSalt the water.');
    assert.strictEqual(docs['Project memory (from the original project).md'], 'Prefers metric units.');
    assert.strictEqual(p.docs.length, 5);
  });

  await test('what other tools write is read too: directories, pax paths, the prefix field, old headers', async () => {
    // A header block written by hand, in the shapes tar.js does not write.
    const block = (name, size, type, { prefix = '', magic = 'ustar\0' } = {}) => {
      const h = Buffer.alloc(512);
      h.write(name, 0, 100, 'utf8');
      h.write('0000644\0', 100);
      h.write('0000000\0', 108);
      h.write('0000000\0', 116);
      h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
      h.write('00000000000\0', 136);
      h.write('        ', 148);
      if (type !== '\0') h.write(type, 156);
      h.write(magic, 257);
      h.write('00', 263);
      h.write(prefix, 345, 155, 'utf8');
      let sum = 0;
      for (const b of h) sum += b;
      h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
      return h;
    };
    const padded = bytes => {
      const b = Buffer.from(bytes);
      return b.length % 512 ? Buffer.concat([b, Buffer.alloc(512 - (b.length % 512))]) : b;
    };
    const entry = (name, bytes, type = '0', opts) => [block(name, Buffer.byteLength(bytes), type, opts), padded(bytes)];

    const longPath = `beethoven/Files/${'– long – '.repeat(12)}notes.md`;
    assert.ok(Buffer.byteLength(longPath, 'utf8') > 100);
    const record = `path=${longPath}\n`;
    // The record's length counts itself, in bytes.
    let length = Buffer.byteLength(record, 'utf8') + 3;
    length += String(length).length - 2;
    const pax = `${length} ${record}`;
    assert.strictEqual(Buffer.byteLength(pax, 'utf8'), length);

    const edited = {
      ...manifest,
      files: [
        { path: longPath.slice('beethoven/'.length), name: 'long.md', type: 'project_file', bytes: 4 },
        { path: 'Files/deep/old.md', name: 'deep/old.md', type: 'project_file', bytes: 3 },
        { path: 'Files/plain.md', name: 'plain.md', type: 'project_file', bytes: 5 },
      ],
      history: [],
      memory: null,
    };

    const buffer = Buffer.concat([
      ...entry('beethoven/', '', '5'), // a directory entry, as tar(1) writes
      ...entry('beethoven/Files/', '', '5'),
      ...entry('beethoven/export.json', JSON.stringify(edited)),
      // A pax header carrying the path, then the entry with its name cut.
      ...entry('./PaxHeaders/notes.md', pax, 'x'),
      ...entry(Buffer.from(longPath, 'utf8').subarray(0, 100).toString('utf8'), 'long'),
      // A global pax header, which says nothing this reader uses.
      ...entry('./PaxHeaders/global', '20 comment=ignored\n', 'g'),
      // The name split over the prefix field, with the old NUL type flag.
      ...entry('deep/old.md', 'old', '\0', { prefix: 'beethoven/Files' }),
      // A symbolic link, which is skipped.
      ...entry('beethoven/Files/link.md', '', '2'),
      ...entry('beethoven/Files/plain.md', 'plain'),
      Buffer.alloc(1024),
    ]);

    const m = makeServer();
    const r = await importTar(m, tarFile(buffer), 'input');

    assert.deepStrictEqual(lines(r, 'error'), []);
    assert.deepStrictEqual(lines(r, 'warn'), []);
    assert.match(statusOf(r), /^Done — “beethoven \(imported\)” was created with 3 files\. 2 items were left out/);
    const [got] = madeChannels(m);
    assert.strictEqual(got.files.get('long.md').toString(), 'long');
    assert.strictEqual(got.files.get('deep/old.md').toString(), 'old');
    assert.strictEqual(got.files.get('plain.md').toString(), 'plain');
    assert.strictEqual(got.files.size, 3);
  });

  await test('a .tar cut short, or with a path that leads out of it, is read as far as it goes', async () => {
    // The export, then one more file whose bytes the archive ends in the
    // middle of (the closing blocks are gone too).
    const whole = pack([
      ...Object.entries(exported.bytes).map(([p, b]) => ({ path: p, bytes: b })),
      { path: 'beethoven/Files/tail.bin', bytes: Buffer.alloc(5000, 1) },
    ]);
    const cut = whole.subarray(0, whole.length - 1024 - 2000);
    const m = makeServer();
    const r = await importTar(m, tarFile(cut, 'cut.tar'), 'input');

    assert.deepStrictEqual(lines(r, 'warn'), [
      'Claude importer: cut.tar ends before "beethoven/Files/tail.bin" does; it and anything after it is not read.',
    ]);
    // Everything before it is whole, and that is all the manifest lists.
    assert.strictEqual(statusOf(r), DONE_FROM_TAR);
    assert.strictEqual(madeChannels(m).length, 1);
    assert.strictEqual(madeChannels(m)[0].files.size, 38);

    // A path with ".." in it is not placed anywhere.
    const escaping = pack([
      ...Object.entries(exported.bytes).map(([p, b]) => ({ path: p, bytes: b })),
      { path: 'beethoven/../../etc/passwd', bytes: Buffer.from('nope') },
    ]);
    const m2 = makeServer();
    const r2 = await importTar(m2, tarFile(escaping), 'drop');
    assert.deepStrictEqual(lines(r2, 'warn'), [
      'Claude importer: skipping "beethoven/../../etc/passwd" in beethoven.tar: its path leads out of the folder.',
    ]);
    assert.strictEqual(statusOf(r2), DONE_FROM_TAR);
  });

  // ------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map(f => `  - ${f}`).join('\n'));
    process.exit(1);
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
