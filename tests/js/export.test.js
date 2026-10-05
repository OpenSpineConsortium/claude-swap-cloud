'use strict';
// End-to-end checks of the project export script, run under Node against the
// mock claude.ai in mock_claude_ai.js. `cswap project-move export` hands that
// script to the user; tests/test_project_move_scripts.py runs this file as
// part of the Python suite when Node is installed.
// Usage: node tests/js/export.test.js [path/to/project-export.js]

const path = require('path');
const assert = require('assert');
const { run, json } = require('./harness');
const { unpack } = require('./tar');
const {
  makeServer, makeEvent, v1Error,
  ORG_CHAT, ORG_API, CHANNEL, OTHER_CHANNEL,
} = require('./mock_claude_ai');

const SCRIPT = path.resolve(
  process.argv[2] || path.join(__dirname, '..', '..', 'src', 'claude_swap', 'browser', 'project-export.js')
);
const CODE_TAB = `/code/project/${CHANNEL}`;

// What the Resource Timing buffer of a /code/ tab holds: URLs, no headers.
const PAGE_REQUESTS = [
  'https://claude.ai/v1/code/channels?scope=joined&include_members=true&include_archived=true&limit=200',
  `https://claude.ai/v1/code/channels/${CHANNEL}/timeline?limit=200&bound_only=true`,
  `https://claude.ai/v1/code/channels/${CHANNEL}/timeline?limit=200`,
].map(name => ({ initiatorType: 'fetch', name }));

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${String(e && e.message).split('\n').join('\n        ')}`);
  }
}

const v1Requests = r => r.requests.filter(q => q.path.startsWith('/v1/'));
const lines = (r, level) => r.logs.filter(l => !level || l.level === level).map(l => l.text);
const parse = text => JSON.parse(text);
const rowsOf = saved => (Array.isArray(saved) ? saved.flatMap(p => p.data) : saved.data);

// The text of one exported file, with the one thing that differs from run
// to run taken out: the time in export.json.
const settled = (name, text) =>
  name.endsWith('/export.json') ? JSON.stringify({ ...parse(text), exported_at: '' }) : text;

// Asserts that two exports hold the same files with the same content.
// `except` names files that are allowed to differ.
function sameExport(got, want, except = n => n.endsWith('routes used.json')) {
  for (const n of Object.keys(want)) {
    if (except(n)) continue;
    assert.ok(n in got, `missing ${n}`);
    assert.strictEqual(settled(n, got[n]), settled(n, want[n]), n);
  }
  assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(want).sort());
}

// Makes the exporter read files in small pieces, so a modest file takes several.
const smallPieces = src => {
  const out = src.replace('const FILE_PIECE = 24 * 1024 * 1024;', 'const FILE_PIECE = 4096;');
  assert.notStrictEqual(out, src);
  return out;
};

// What the mock holds, counted independently of the script under test.
function expectations(world) {
  const threads = [...world.threads.entries()].filter(([, rows]) => rows.length > 1);
  return {
    messages: world.everyRoot.length,
    feed: world.roots.length,
    threads: threads.length,
    threadRows: Object.fromEntries(threads.map(([id, rows]) => [id, rows.length])),
    belowRoots: threads.reduce((n, [, rows]) => n + rows.length - 1, 0),
    sessions: world.sessions.size,
    events: [...world.sessions.values()].reduce((n, s) => n + s.events, 0),
    files: world.files.size,
    fileBytes: [...world.files.values()].reduce((n, b) => n + b.length, 0),
  };
}

(async () => {
  console.log(`script under test: ${path.relative(process.cwd(), SCRIPT)}\n`);

  // ------------------------------------------------------------------
  console.log('1. A Claude Code project');

  const main = makeServer();
  const want = expectations(main.world);
  const exported = await run({ script: SCRIPT, pathname: CODE_TAB, server: main.server, resources: PAGE_REQUESTS });
  const files = exported.files;
  const names = Object.keys(files);

  await test('it loads, exports and reports success', async () => {
    assert.strictEqual(exported.loadError, null);
    assert.strictEqual(exported.pickerCalls, 1);
    assert.deepStrictEqual(lines(exported, 'error'), []);
    assert.deepStrictEqual(lines(exported, 'warn'), []);
    assert.strictEqual(
      exported.statusText,
      `Done — ${want.files} file(s), ${want.messages} message(s), ${want.threads} thread(s), ${want.sessions} session(s). See the folder’s README.`
    );
    assert.strictEqual(exported.button.textContent, 'Export complete');
  });

  await test('every /v1/ request carries anthropic-version and none is refused', async () => {
    const v1 = v1Requests(exported);
    assert.ok(v1.length > 50);
    assert.ok(v1.every(q => q.headers['anthropic-version'] === '2023-06-01'));
    assert.ok(v1.every(q => q.credentials === 'include'));
    assert.strictEqual(main.hits.v1Refused, 0);
  });

  await test('/api/ requests are untouched, and the API-only org is not asked', async () => {
    const api = exported.requests.filter(q => q.path.startsWith('/api/'));
    assert.deepStrictEqual(api.map(q => q.path), [
      '/api/organizations',
      `/api/organizations/${ORG_CHAT}/projects?include_harmony_projects=true&limit=100`,
    ]);
    assert.ok(api.every(q => JSON.stringify(q.headers) === '{"accept":"application/json"}'));
    assert.ok(lines(exported, 'log').some(t => t.includes('skipping "Individual Org"')));
  });

  await test('the folder holds every expected file, and nothing was left open', async () => {
    for (const name of [
      'beethoven/README.md',
      'beethoven/export.json',
      'beethoven/Files/state/notes.md',
      'beethoven/Channel Info.md',
      'beethoven/Channel Instructions.md',
      'beethoven/Timeline.md',
      'beethoven/Raw JSON/routes used.json',
      'beethoven/Raw JSON/channel.json',
      'beethoven/Raw JSON/config.json',
      'beethoven/Raw JSON/timeline.json',
      'beethoven/Raw JSON/timeline (bound_only=true).json',
      'beethoven/Raw JSON/timeline (thread_roots_only=true).json',
    ]) {
      assert.ok(name in files, `missing ${name}`);
    }
    assert.ok(Object.values(exported.fileStats).every(s => s.closed));
    assert.ok(names.every(n => n.startsWith('beethoven/')));
  });

  await test('channel info and instructions are the real ones', async () => {
    assert.strictEqual(files['beethoven/Channel Info.md'], main.world.channel.topic);
    assert.strictEqual(
      files['beethoven/Channel Instructions.md'],
      'You are the beethoven channel agent.\nAlways answer in threads.'
    );
    assert.strictEqual(parse(files['beethoven/Raw JSON/channel.json']).id, CHANNEL);
    assert.ok(parse(files['beethoven/Raw JSON/config.json']).config.system_prompt_addendum);
  });

  await test('the whole timeline is saved, across pages and views', async () => {
    const pages = parse(files['beethoven/Raw JSON/timeline.json']);
    assert.strictEqual(pages.length, 3); // 200 + 200 + 50
    const ids = rowsOf(pages).map(r => r.id);
    assert.deepStrictEqual(ids, main.world.roots.slice().reverse().map(r => r.id));

    // The hidden threads only exist in the filtered views.
    const bound = rowsOf(parse(files['beethoven/Raw JSON/timeline (bound_only=true).json'])).map(r => r.id);
    for (const h of main.world.hidden) {
      assert.ok(!ids.includes(h.id));
      assert.ok(bound.includes(h.id));
    }

    const md = files['beethoven/Timeline.md'];
    assert.strictEqual((md.match(/^## /gm) || []).length + (md.match(/^> _[^_\n]*, \w+:_ /gm) || []).length, want.messages);
    // A notice shows its text and kind, not the JSON it travels in.
    assert.ok(md.includes('> _2026-09-01T10:10:00.000Z, thread_started:_ Session started (7)\n'));
    assert.ok(!md.includes('{"kind"'));
    assert.ok(md.startsWith('# beethoven: timeline\n\n453 top-level message(s), oldest first.'));
    // Oldest first: message 0 comes before message 449, hidden threads last.
    assert.ok(md.indexOf('Top-level message 0:') < md.indexOf('Top-level message 449:'));
    assert.ok(md.indexOf('Top-level message 449:') < md.indexOf('Background thread 0'));
    assert.ok(md.includes('## You — 2026-09-01T09:50:00.000Z'));
    assert.ok(md.includes('## Member 004242 — 2026-09-01T09:00:00.000Z'));
    assert.ok(md.includes('> Output: state/notes.md'));
    assert.ok(md.includes('> Output: [PR 12](https://github.com/example/repo/pull/12)'));
    assert.ok(md.includes('> Session: One-shot session (archived)'));
  });

  await test('each thread is fetched once, by its root, with all of its pages', async () => {
    const asked = v1Requests(exported)
      .map(q => q.path.match(/\/threads\/(cmsg_\w+)/)?.[1])
      .filter(Boolean);
    const distinct = [...new Set(asked)];

    // Only root messages are ever asked for.
    assert.ok(distinct.every(id => main.world.owner.get(id) === id));

    for (const [rootId, count] of Object.entries(want.threadRows)) {
      const saved = parse(files[`beethoven/Raw JSON/thread ${rootId}.json`]);
      const rows = rowsOf(saved);
      assert.strictEqual(rows.length, count, `thread ${rootId}`);
      assert.deepStrictEqual(rows.map(r => r.id), main.world.threads.get(rootId).map(r => r.id));
      assert.strictEqual(asked.filter(id => id === rootId).length, Math.ceil(count / 200));
    }

    const threadFiles = names.filter(n => n.startsWith('beethoven/Threads/'));
    assert.strictEqual(threadFiles.length, want.threads);
    assert.strictEqual(names.filter(n => /Raw JSON\/thread /.test(n)).length, want.threads);

    // The 450-row thread arrives in three pages and reads top to bottom.
    const big = Object.entries(want.threadRows).find(([, n]) => n === 450)[0];
    assert.strictEqual(parse(files[`beethoven/Raw JSON/thread ${big}.json`]).length, 3);
    const bigMd = files[threadFiles.find(n => files[n].includes(`Thread: ${big}`))];
    assert.ok(bigMd.indexOf('Reply 3 in') < bigMd.indexOf('Reply 445 in'));
    // Notices: readable text, one quoted line per line of the notice.
    assert.ok(bigMd.includes('status:_ Claude is working (step 1)\n> ✱ Reading files\n> ✓ Wrote the plan\n\n'));
    assert.ok(bigMd.includes('activity:_ Running a command (step 2)\n'));
    // ...and the two that are not {"kind","text"} objects come through whole.
    assert.ok(bigMd.includes('notice:_ plain words, not JSON\n'));
    assert.ok(bigMd.includes('notice:_ {"kind":"mystery","detail":42}\n'));
    assert.ok(!bigMd.includes('{"kind":"status"'));
    assert.ok(bigMd.includes('## You — '));
    assert.ok(bigMd.includes('## Claude — '));
  });

  await test('thread files have safe, distinct names and the timeline links to them', async () => {
    const threadFiles = names.filter(n => n.startsWith('beethoven/Threads/')).map(n => n.split('/').pop());
    assert.strictEqual(new Set(threadFiles).size, threadFiles.length);
    assert.ok(threadFiles.every(n => !/[\/\\:*?"<>|]/.test(n) && n.endsWith('.md')));
    // Titles keep a link's label and drop its target.
    assert.ok(threadFiles.includes('001 Kick-off for Thread work 0– please look at item 10 – –quoted….md'));
    // Numbered in order, with no gaps.
    assert.deepStrictEqual(threadFiles.map(n => n.slice(0, 3)).sort(), threadFiles.map((_, i) => String(i + 1).padStart(3, '0')));
    assert.ok(threadFiles.every(n => !n.includes('cmsg_01LINK')));

    const md = files['beethoven/Timeline.md'];
    for (const n of threadFiles) assert.ok(md.includes(`: Threads/${n}`), n);
  });

  await test('all sessions are found once each, under either spelling of their id', async () => {
    const asked = v1Requests(exported)
      .map(q => q.path.match(/^\/v1\/code\/sessions\/((?:cse|session)_\w+)$/)?.[1])
      .filter(Boolean);
    assert.strictEqual(asked.length, want.sessions);
    assert.strictEqual(new Set(asked.map(id => id.replace(/^[a-z]+_/, ''))).size, want.sessions);
  });

  await test('every session log is complete and identical to what the server sent', async () => {
    let total = 0;

    for (const s of main.world.sessions.values()) {
      const card = names.find(n => n.startsWith('beethoven/Sessions/') && n.endsWith('.json') &&
        !n.endsWith('.events.json') && parse(files[n]).response_shape.id === s.id);
      assert.ok(card, `no summary for ${s.id}`);

      const stem = card.slice(0, -'.json'.length);
      const events = parse(files[`${stem}.events.json`]);
      assert.strictEqual(events.length, s.events, s.title);
      total += events.length;

      for (const i of [0, 1, 498, 499, 500, 501, events.length - 1]) {
        if (i >= 0 && i < events.length) assert.deepStrictEqual(events[i], makeEvent(s.id, i + 1));
      }
      assert.ok(events.every((e, i) => e.sequence_num === String(i + 1)));
      assert.ok(`${stem}.md` in files);
    }

    assert.strictEqual(total, want.events);
  });

  await test('long logs are written a page at a time, not held in memory', async () => {
    const big = names.find(n => n.endsWith('.events.json') && parse(files[n]).length === 2600);
    // "[" + six pages of 500/100 + "]"
    assert.strictEqual(exported.fileStats[big].writes, 1 + 6 + 1);
    assert.strictEqual(exported.fileStats[big].opens, 1);

    const perSession = v1Requests(exported).filter(q => q.path.includes('/events'));
    assert.ok(perSession.every(q => q.path.includes('limit=500&sort_order=asc')));
  });

  await test('session transcripts read as a conversation', async () => {
    const stem = names.find(n => n.endsWith('.events.json') && parse(files[n]).length === 1234).slice(0, -'.events.json'.length);
    const events = parse(files[`${stem}.events.json`]);
    const md = files[`${stem}.md`];

    const prompts = events.filter(e => e.event_type === 'user' && typeof e.payload.message.content === 'string' && !e.payload.parent_tool_use_id);
    const answers = events.filter(e => e.event_type === 'assistant' && !e.payload.parent_tool_use_id && e.payload.message.content.some(b => b.type === 'text'));
    const calls = events.flatMap(e => e.event_type === 'assistant' ? e.payload.message.content.filter(b => b.type === 'tool_use') : []);
    const results = events.flatMap(e => e.event_type === 'user' && Array.isArray(e.payload.message.content) ? e.payload.message.content : []);

    assert.ok(md.startsWith('# Thread work'));
    assert.match(md, /^Session: cse_01SESS/m);
    assert.strictEqual((md.match(/^## User — /gm) || []).length, prompts.length);
    assert.strictEqual((md.match(/^Answer \d+: done/gm) || []).length, answers.length);
    assert.strictEqual((md.match(/^- Tool(?: \(subagent\))?: `/gm) || []).length, calls.length);
    assert.strictEqual((md.match(/^  - (?:Result|Error): /gm) || []).length, results.length);
    assert.ok((md.match(/^  - Error: /gm) || []).length > 0);

    // A prompt is printed in full, on its own lines.
    assert.ok(md.includes('Prompt 42: please handle item 42.\nIt has a second line.\n'));
    // Tool calls are one line each; private reasoning is not printed.
    assert.ok(md.includes('- Tool: `Bash` {"command":"echo 43","description":"Print a number"}'));
    // A result is cut to one line whether it came as blocks (44) or as text (54).
    assert.ok(md.includes('  - Result: output 44\n'));
    assert.ok(md.includes('  - Result: output 54 line two\n'));
    assert.ok(md.includes('- Subagent said: subagent note 46'));
    assert.ok(md.includes('- Task given to a subagent: subtask 47'));
    assert.ok(!md.includes('private reasoning'));
    // No runs of blank lines, and headings are set off by one.
    assert.ok(!/\n{3,}/.test(md));
    assert.ok(!/[^\n]\n## /.test(md));
  });

  await test('sessions that share a title get separate files', async () => {
    const stems = names.filter(n => n.endsWith('.events.json')).map(n => n.split('/').pop());
    assert.ok(stems.includes('Thread work 3.events.json'));
    assert.ok(stems.includes('Thread work 3 (2).events.json'));
    assert.ok('beethoven/Sessions/Thread work 3 (2).md' in files);
    assert.ok('beethoven/Sessions/Thread work 3 (2).json' in files);
    assert.strictEqual(names.filter(n => n.startsWith('beethoven/Sessions/')).length, want.sessions * 3);
  });

  await test('a session with no events still gets valid, honest files', async () => {
    const empty = names.find(n => n.endsWith('.events.json') && parse(files[n]).length === 0);
    assert.strictEqual(files[empty], '[\n]\n');
    assert.ok(files[empty.replace('.events.json', '.md')].includes('_(No log was returned for this session.)_'));
  });

  await test('the README states what was exported', async () => {
    const readme = files['beethoven/README.md'];
    assert.ok(readme.includes(`- Channel: ${CHANNEL}`));
    assert.ok(readme.includes(`- Project files copied: ${want.files} (${want.fileBytes.toLocaleString('en-US')} bytes), in Files/`));
    assert.ok(readme.includes('- export.json: what the importer reads to re-create this project.'));
    assert.ok(readme.includes(`- Timeline: ${want.messages} top-level message(s), in Timeline.md`));
    assert.ok(readme.includes(`- Threads saved: ${want.threads}, holding ${want.belowRoots.toLocaleString('en-US')} replies and notices`));
    assert.ok(readme.includes(`- Sessions exported: ${want.sessions}, with ${want.events.toLocaleString('en-US')} logged events`));
    assert.ok(!readme.includes('Could not be exported'));
  });

  // ------------------------------------------------------------------
  console.log('\n2. Pagination and settings');

  await test('a server that sends a cursor on every full page gives the same export', async () => {
    const alt = makeServer({ cursorOnFullPage: true });
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: alt.server });
    assert.match(r.statusText, /^Done — 9 file\(s\), 453 message\(s\), 12 thread\(s\), 15 session\(s\)\. See/);

    // Same content apart from the list of routes (no page requests here).
    sameExport(r.files, files);
  });

  await test('a server that ignores the cursor cannot make it loop', async () => {
    // Every timeline request answers with the same first page and cursor.
    const stuck = makeServer({
      fault: url =>
        url.pathname.endsWith('/timeline') && !url.search.includes('only')
          ? json(200, { data: [{ id: 'cmsg_01STUCK0000000000000000A', body: 'x', created_at: '2026-01-01T00:00:00Z' }], next_cursor: 'same-every-time' })
          : null,
    });
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: stuck.server });
    assert.match(r.statusText, /^Done/);
    const asked = r.requests.filter(q => /\/timeline\?limit=200(&cursor=[^&]+)?$/.test(q.path));
    assert.strictEqual(asked.length, 3); // probe, first page, one retry of the cursor
    assert.ok(r.files['beethoven/README.md'].includes('Part of timeline.json: paging stopped early.'));
  });

  const withLogs = level => src => {
    const out = src.replace("const SESSION_LOGS = 'full';", `const SESSION_LOGS = '${level}';`);
    assert.notStrictEqual(out, src);
    return out;
  };

  await test("SESSION_LOGS = 'readable' keeps the transcripts and drops the raw logs", async () => {
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: makeServer().server, patch: withLogs('readable') });

    assert.match(r.statusText, /^Done — 9 file\(s\), 453 message\(s\), 12 thread\(s\), 15 session\(s\)\. See/);
    const n = Object.keys(r.files);
    assert.strictEqual(n.filter(x => x.endsWith('.events.json')).length, 0);
    assert.strictEqual(n.filter(x => x.startsWith('beethoven/Sessions/')).length, 30);

    // Every transcript is the same as in a full export.
    const transcripts = names.filter(x => x.startsWith('beethoven/Sessions/') && x.endsWith('.md'));
    assert.strictEqual(transcripts.length, 15);
    for (const x of transcripts) assert.strictEqual(r.files[x], files[x], x);

    const readme = r.files['beethoven/README.md'];
    assert.ok(readme.includes('Sessions exported: 15, with 7,866 logged events'));
    assert.ok(readme.includes('"<title>.md" is what was said and done'));
    assert.ok(!readme.includes('.events.json'));
    assert.ok(Object.values(r.fileStats).every(f => f.closed));
  });

  await test("SESSION_LOGS = 'none' skips the logs entirely and says so", async () => {
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: makeServer().server, patch: withLogs('none') });

    assert.match(r.statusText, /^Done — 9 file\(s\), 453 message\(s\), 12 thread\(s\), 15 session\(s\)\. See/);
    assert.ok(!r.requests.some(q => q.path.includes('/events')));
    const n = Object.keys(r.files).filter(x => x.startsWith('beethoven/Sessions/'));
    assert.strictEqual(n.length, 15);
    assert.ok(n.every(x => x.endsWith('.json') && !x.endsWith('.events.json')));

    const readme = r.files['beethoven/README.md'];
    assert.ok(readme.includes('Sessions exported: 15, without their logs'));
    assert.ok(readme.includes('Session logs were switched off for this export (SESSION_LOGS).'));
    assert.ok(!readme.includes('.events.json') && !readme.includes('"<title>.md"'));
    // With no transcripts, the manifest offers the importer none.
    assert.ok(!parse(r.files['beethoven/export.json']).history.some(h => h.type === 'session'));
  });

  await test('an empty workspace exports cleanly', async () => {
    const bare = makeServer({}, { roots: 0, replies: [], hiddenReplies: [], events: [0] });
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: bare.server });
    // Only the channel's own session is left to find.
    assert.strictEqual(r.statusText, 'Done — 9 file(s), 0 message(s), 0 thread(s), 1 session(s). See the folder’s README.');
    assert.strictEqual(Object.keys(r.files).filter(n => n.startsWith('beethoven/Sessions/')).length, 3);
    assert.ok(!('beethoven/Timeline.md' in r.files));
    assert.ok(!Object.keys(r.files).some(n => n.includes('/Threads/')));
    assert.deepStrictEqual(lines(r, 'warn'), []);
  });

  // ------------------------------------------------------------------
  console.log('\n3. When the server says no');

  await test('a refusal is reported in the server’s own words', async () => {
    const strict = makeServer({ extraHeader: 'x-new-requirement' });
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: strict.server, resources: PAGE_REQUESTS });

    assert.match(
      r.statusText,
      new RegExp(`^Export failed: Could not read workspace ${CHANNEL}: HTTP 400: x-new-requirement: header is required\\.`)
    );
    const warned = lines(r, 'warn').join('\n');
    assert.ok(warned.includes('the server refused these requests'));
    assert.ok(warned.includes('HTTP 400: x-new-requirement: header is required  ←  /v1/code/channels?scope=joined'));
    assert.ok(warned.includes(`/v1/code/channels/${CHANNEL}/timeline?limit=200`));
    assert.strictEqual(Object.keys(r.files).length, 0);
    assert.strictEqual(r.button.disabled, false); // can be pressed again
  });

  await test('a 404 on the routes says so as well', async () => {
    const moved = makeServer({ fault: () => v1Error(404, 'Not found') });
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: moved.server });
    assert.match(r.statusText, /Could not read workspace .*: HTTP 404: Not found\./);
  });

  await test('rate limits and server hiccups are waited out', async () => {
    const flaky = makeServer({
      fault: (url, headers, nth) => {
        // Second page of one session's events: told to slow down once.
        if (url.pathname.endsWith('/events') && url.searchParams.get('cursor') === '500' && nth === 2) {
          return json(429, { error: { message: 'Rate limited', reason: '', type: 'rate_limit_error' }, type: 'error' }, { 'retry-after': '7' });
        }
        // The first two requests for any thread fail with 503.
        if (url.pathname.includes('/threads/') && nth <= 2) return v1Error(503, 'Service unavailable');
        return null;
      },
    });
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: flaky.server });

    assert.match(r.statusText, /^Done — 9 file\(s\), 453 message\(s\), 12 thread\(s\), 15 session\(s\)\. See/);
    sameExport(r.files, files);
    assert.ok(r.sleeps.includes(7000));
    assert.ok(r.sleeps.includes(2000) && r.sleeps.includes(5000));
    const warned = lines(r, 'warn');
    assert.ok(warned.some(t => t.includes('HTTP 429: Rate limited. Trying again in 7 s')));
    assert.ok(warned.some(t => t.includes('HTTP 503: Service unavailable. Trying again in 2 s')));
  });

  await test('a log that cannot be finished is saved as far as it got, and flagged', async () => {
    const broken = makeServer({
      fault: url =>
        /SESS0+8\/events$/.test(url.pathname) && url.searchParams.get('cursor') === '1000'
          ? v1Error(500, 'Internal server error')
          : null,
    });
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: broken.server });

    assert.match(r.statusText, /^Done — .*15 session\(s\)\. 1 item\(s\) could not be exported; the folder’s README lists them\.$/);
    const partial = Object.keys(r.files).find(n => n.endsWith('.events.json') && parse(r.files[n]).length === 1000 &&
      parse(r.files[n.replace('.events.json', '.json')]).response_shape.id.endsWith('8'));
    assert.ok(partial, 'partial log not found');
    assert.ok(r.files[partial.replace('.events.json', '.md')].includes('_(The log stops early here: the rest could not be fetched.)_'));
    assert.ok(r.files['beethoven/README.md'].includes('Could not be exported this time:'));
    assert.ok(r.files['beethoven/README.md'].includes('- Part of the log of session cse_01SESS000000000000000008'));
    // It was retried three times before giving up.
    assert.deepStrictEqual(r.sleeps.filter(ms => ms >= 2000), [2000, 5000, 15000]);
    assert.ok(Object.values(r.fileStats).every(s => s.closed));
  });

  await test('a session that cannot be opened is counted as failed, the rest export', async () => {
    const gone = makeServer({
      fault: url => (/\/sessions\/cse_01SESS0+5$/.test(url.pathname) ? v1Error(404, 'Session not found') : null),
    });
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: gone.server });
    assert.match(r.statusText, /14 session\(s\), 1 session\(s\) failed\. 1 item\(s\) could not be exported/);
    assert.ok(r.files['beethoven/README.md'].includes('Sessions exported: 14 (1 failed — see console)'));
    assert.strictEqual(Object.keys(r.files).filter(n => n.endsWith('.events.json')).length, 14);
  });

  // ------------------------------------------------------------------
  console.log('\n4. Finding the channel');

  await test('a channel missing from the list is fetched by itself', async () => {
    const hiddenFromList = makeServer({
      fault: url =>
        url.pathname === '/v1/code/channels'
          ? json(200, { data: [{ id: OTHER_CHANNEL, name: 'some-other-channel' }] })
          : null,
    });
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: hiddenFromList.server });
    assert.match(r.statusText, /^Done — 9 file\(s\), 453 message/);
    assert.ok('beethoven/Channel Info.md' in r.files);
    assert.strictEqual(r.tables[0].channel, `/v1/code/channels/${CHANNEL}  (ENDPOINTS.code.channel)`);
  });

  await test('a route seen on the page is used when the built-in one is refused', async () => {
    // The built-in channels URL is refused; the one the page used has an extra parameter.
    const pageUrl = '/v1/code/channels?scope=joined&include_members=true&include_archived=true&limit=200&v=2';
    const changed = makeServer({
      fault: url =>
        url.pathname === '/v1/code/channels' && !url.searchParams.has('v')
          ? v1Error(400, 'Request validation failed', 'v: field required')
          : null,
    });
    const r = await run({
      script: SCRIPT,
      pathname: CODE_TAB,
      server: changed.server,
      resources: [{ initiatorType: 'fetch', name: `https://claude.ai${pageUrl}` }],
    });
    assert.match(r.statusText, /^Done — 9 file\(s\), 453 message/);
    assert.strictEqual(r.tables[0].channels, `${pageUrl}  (seen on this page)`);
    assert.ok(lines(r, 'warn').join('\n').includes('HTTP 400: Request validation failed — v: field required'));
  });

  await test('sessions the page merely requested are not pulled into the export', async () => {
    // Left over in the buffer from another view: a session of some other workspace.
    const r = await run({
      script: SCRIPT,
      pathname: CODE_TAB,
      server: makeServer().server,
      resources: [
        ...PAGE_REQUESTS,
        { initiatorType: 'fetch', name: 'https://claude.ai/v1/code/sessions/session_01UNRELATED0000000000000' },
      ],
    });
    assert.match(r.statusText, /15 session\(s\)\. See/);
    assert.ok(!r.requests.some(q => q.path.includes('UNRELATED')));
  });

  // ------------------------------------------------------------------
  console.log('\n5. The project’s own files');

  const manifest = parse(files['beethoven/export.json']);

  await test('every project file is copied, byte for byte', async () => {
    assert.strictEqual(manifest.files.length, want.files);

    for (const [name, bytes] of main.world.files) {
      const row = manifest.files.find(f => f.name === name);
      assert.ok(row, `not in the manifest: ${name}`);
      assert.deepStrictEqual(row, { path: row.path, name, type: 'project_file', bytes: bytes.length });

      const copy = exported.bytes[`beethoven/${row.path}`];
      assert.ok(copy, `not on disk: ${row.path}`);
      assert.strictEqual(Buffer.compare(copy, bytes), 0, name);
    }

    // Nothing else is in Files/, and each file has a row of its own.
    const onDisk = names.filter(n => n.startsWith('beethoven/Files/'));
    assert.strictEqual(onDisk.length, want.files);
    assert.strictEqual(new Set(manifest.files.map(f => f.path)).size, want.files);
  });

  await test('binary, empty and oddly named files all survive', async () => {
    const at = name => `beethoven/${manifest.files.find(f => f.name === name).path}`;

    // Bytes that are not text come through untouched.
    assert.deepStrictEqual([...exported.bytes[at('bundles/repo.bundle')]], [0x00, 0xff, 0xfe, 0x80, 0x0a, 0x50, 0x4b, 0x03, 0x04, 0xc3, 0x28]);
    assert.strictEqual(exported.bytes[at('empty.txt')].length, 0);
    assert.strictEqual(files[at('ünïcode name – café.md')], 'Crème brûlée ☕\n');

    // Folders are kept. A name a disk cannot hold is changed on disk only,
    // and two names that then collide stay two files.
    assert.strictEqual(at('plan/deep/nested/outline.md'), 'beethoven/Files/plan/deep/nested/outline.md');
    assert.strictEqual(at('weird/a:b?.md'), 'beethoven/Files/weird/a–b–.md');
    assert.strictEqual(at('weird/a–b–.md'), 'beethoven/Files/weird/a–b– (2).md');
    assert.strictEqual(files[at('weird/a:b?.md')], 'colon and question mark\n');
    assert.strictEqual(files[at('weird/a–b–.md')], 'already a safe name\n');
  });

  await test('files are read through files:list and files:open, which only read', async () => {
    const posts = exported.requests.filter(q => q.method !== 'GET');
    assert.ok(posts.length > 0);
    assert.ok(posts.every(q => /\/files:(list|open)$/.test(q.path)));
    assert.ok(posts.every(q => q.headers['anthropic-version'] === '2023-06-01' && q.headers['content-type'] === 'application/json'));

    const listed = posts.filter(q => q.path.endsWith(':list')).map(q => parse(q.body));
    assert.deepStrictEqual(listed, [{ recursive: true, limit: 500 }]);

    // One request per file: each asks for a range, so text and binary files
    // are handled alike.
    const opened = posts.filter(q => q.path.endsWith(':open')).map(q => parse(q.body));
    assert.strictEqual(opened.length, want.files);
    assert.ok(opened.every(b => b.range_offset === 0 && b.range_length === 24 * 1024 * 1024));
  });

  await test('a large file is read in pieces and put together exactly', async () => {
    const m = makeServer();
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: m.server, patch: smallPieces });
    assert.match(r.statusText, /^Done — 9 file\(s\)/);
    sameExport(r.files, files);
    assert.strictEqual(Buffer.compare(r.bytes['beethoven/Files/big/blob.bin'], m.world.files.get('big/blob.bin')), 0);

    const pieces = r.requests.filter(q => q.path.endsWith(':open')).map(q => parse(q.body)).filter(b => b.path === 'big/blob.bin');
    assert.strictEqual(pieces.length, Math.ceil(70000 / 4096));
    assert.deepStrictEqual(pieces.map(b => b.range_offset), pieces.map((_, i) => i * 4096));
    // Written a piece at a time, not held in memory.
    assert.strictEqual(r.fileStats['beethoven/Files/big/blob.bin'].writes, pieces.length);
  });

  await test('a long file list is followed to its last page', async () => {
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: makeServer({ filesPageSize: 4 }).server });
    assert.match(r.statusText, /^Done — 9 file\(s\)/);
    sameExport(r.files, files);
    // 9 files and 6 folders are 15 entries: four pages of four.
    const listed = r.requests.filter(q => q.path.endsWith(':list')).map(q => parse(q.body));
    assert.deepStrictEqual(listed.map(b => b.cursor), [undefined, '4', '8', '12']);
  });

  await test('folders whose names differ only in case do not overwrite each other', async () => {
    const extra = [
      ['Docs/a.md', Buffer.from('upper a\n')],
      ['docs/a.md', Buffer.from('lower a\n')],
      ['docs/b.md', Buffer.from('lower b\n')],
    ];
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: makeServer({}, { files: extra }).server });
    assert.match(r.statusText, /^Done — 12 file\(s\)/);

    const rows = parse(r.files['beethoven/export.json']).files;
    const at = name => rows.find(f => f.name === name).path;
    // One folder on disk, three files in it.
    assert.deepStrictEqual([at('Docs/a.md'), at('docs/a.md'), at('docs/b.md')], ['Files/Docs/a.md', 'Files/Docs/a (2).md', 'Files/Docs/b.md']);
    assert.strictEqual(r.files['beethoven/Files/Docs/a.md'], 'upper a\n');
    assert.strictEqual(r.files['beethoven/Files/Docs/a (2).md'], 'lower a\n');
    assert.ok(!Object.keys(r.files).some(n => n.startsWith('beethoven/Files/docs/')));
  });

  await test('a file that changes while it is copied is dropped, not saved half-right', async () => {
    const m = makeServer({ revisionOf: (path, offset) => (path === 'big/blob.bin' && offset > 0 ? 'rev-2' : 'rev-1') });
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: m.server, patch: smallPieces });

    assert.match(r.statusText, /^Done — 8 file\(s\), .* 1 item\(s\) could not be exported/);
    assert.ok(!('beethoven/Files/big/blob.bin' in r.files));
    const man = parse(r.files['beethoven/export.json']);
    assert.ok(!man.files.some(f => f.name === 'big/blob.bin'));
    assert.deepStrictEqual(man.problems, ['Project file big/blob.bin (the file changed while it was being copied).']);
    assert.ok(r.files['beethoven/README.md'].includes('- Project file big/blob.bin (the file changed while it was being copied).'));
    assert.ok(Object.values(r.fileStats).every(f => f.closed));
  });

  await test('a file that cannot be read is flagged and the rest are copied', async () => {
    const m = makeServer({
      fault: (url, headers, nth, init) =>
        url.pathname.endsWith('/files:open') && JSON.parse(init.body).path === 'state/data.json'
          ? v1Error(500, 'Internal server error')
          : null,
    });
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: m.server });

    assert.match(r.statusText, /^Done — 8 file\(s\), .* 1 item\(s\) could not be exported/);
    assert.ok(!('beethoven/Files/state/data.json' in r.files));
    assert.ok('beethoven/Files/state/notes.md' in r.files);
    assert.ok(r.files['beethoven/README.md'].includes('- Project file state/data.json (HTTP 500: Internal server error'));
    // Tried four times in all before giving up.
    assert.deepStrictEqual(r.sleeps.filter(ms => ms >= 2000), [2000, 5000, 15000]);
  });

  await test('if the file list is refused, everything else is still exported', async () => {
    const m = makeServer({
      fault: url => (url.pathname.endsWith('/files:list') ? v1Error(400, 'Project files are not available', 'project_files_read_disabled') : null),
    });
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: m.server });

    assert.match(r.statusText, /^Done — 0 file\(s\), 453 message\(s\), 12 thread\(s\), 15 session\(s\)\. 1 item\(s\) could not be exported/);
    assert.ok(!Object.keys(r.files).some(n => n.startsWith('beethoven/Files/')));
    assert.ok(r.files['beethoven/README.md'].includes('- The project files (HTTP 400: Project files are not available — project_files_read_disabled'));
    assert.deepStrictEqual(parse(r.files['beethoven/export.json']).files, []);
  });

  await test('a project with no files exports cleanly', async () => {
    const m = makeServer();
    m.world.files.clear();
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: m.server });
    assert.match(r.statusText, /^Done — 0 file\(s\), 453 message\(s\), 12 thread\(s\), 15 session\(s\)\. See/);
    assert.ok(!Object.keys(r.files).some(n => n.startsWith('beethoven/Files/')));
    assert.ok(r.files['beethoven/README.md'].includes('- Project files copied: 0 (0 bytes), in Files/'));
  });

  // ------------------------------------------------------------------
  console.log('\n6. What an import needs: export.json');

  await test('a code project’s manifest has its name, text, settings and file list', async () => {
    assert.deepStrictEqual(Object.keys(manifest), [
      'format', 'version', 'kind', 'exported_at', 'source',
      'name', 'description', 'instructions', 'settings', 'files', 'history', 'problems',
    ]);
    assert.strictEqual(manifest.format, 'claude-project-export');
    assert.strictEqual(manifest.version, 1);
    assert.strictEqual(manifest.kind, 'code');
    assert.ok(!Number.isNaN(Date.parse(manifest.exported_at)));
    assert.deepStrictEqual(manifest.source, { id: CHANNEL });
    assert.strictEqual(manifest.name, 'beethoven');
    assert.strictEqual(manifest.description, main.world.channel.topic);
    assert.strictEqual(manifest.instructions, 'You are the beethoven channel agent.\nAlways answer in threads.');
    assert.deepStrictEqual(manifest.problems, []);

    const { config, ...rest } = manifest.settings;
    assert.deepStrictEqual(rest, {
      visibility: 'private',
      icon: 'MusicNotes',
      color: 'purple',
      context_sources: main.world.channel.context_sources,
    });
    // The settings exactly as the server holds them.
    assert.deepStrictEqual(config, parse(files['beethoven/Raw JSON/config.json']).config);
    assert.strictEqual(config.default_effort_level, 'ultracode');
    assert.deepStrictEqual(config.default_source_urls, ['https://github.com/example/web-app', 'https://github.com/example/api']);
  });

  await test('its history list points at every readable conversation file', async () => {
    const byType = type => manifest.history.filter(h => h.type === type);

    assert.deepStrictEqual(manifest.history[0], { path: 'Timeline.md', title: 'Timeline', type: 'timeline' });
    assert.strictEqual(byType('thread').length, want.threads);
    assert.strictEqual(byType('session').length, want.sessions);
    assert.strictEqual(manifest.history.length, 1 + want.threads + want.sessions);

    // Every entry is a file that exists, is Markdown, and is listed once.
    for (const h of manifest.history) {
      assert.ok(`beethoven/${h.path}` in files, h.path);
      assert.ok(h.path.endsWith('.md') && h.title);
    }
    assert.strictEqual(new Set(manifest.history.map(h => h.path)).size, manifest.history.length);
    // The raw logs are not offered: they are far too large to be reference files.
    assert.ok(!manifest.history.some(h => h.path.endsWith('.json')));
  });

  await test('settings that could not be read are named in the manifest, not guessed', async () => {
    const m = makeServer({ fault: url => (url.pathname.endsWith('/config') ? v1Error(500, 'Internal server error') : null) });
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: m.server });
    const man = parse(r.files['beethoven/export.json']);

    assert.strictEqual(man.instructions, '');
    assert.deepStrictEqual(man.settings.config, {});
    assert.strictEqual(man.problems.length, 1);
    assert.match(man.problems[0], /^The channel's settings and instructions \(HTTP 500/);
    assert.strictEqual(man.name, 'beethoven');
  });

  // ------------------------------------------------------------------
  console.log('\n7. Regular projects');

  const STD_TAB = '/project/aaaaaaaa-0000-4000-8000-000000000001';
  const STD_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
  const STD_API = `/api/organizations/${ORG_CHAT}`;
  const CHAT_IDS = ['bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'];
  const CHAT_DIRS = ['Recipes/Chats/Pasta– basics–', 'Recipes/Chats/Pasta– basics– (2)'];
  const isContents = q => /\/files\/[^/]+\/contents$/.test(q.path);

  const stdMock = makeServer();
  const std = await run({ script: SCRIPT, pathname: STD_TAB, server: stdMock.server });
  // The same, on a site that will not hand out the files themselves.
  const stdWithout = await run({ script: SCRIPT, pathname: STD_TAB, server: makeServer({ noContents: true }).server });

  // Where each uploaded file goes: under its own name when the file itself
  // can be had, and under a name that says so when only Claude's copy can.
  const uploads = [
    ['Recipes/Files/menu.pdf', 'Recipes/Files/menu [Claude representation].pdf', stdMock.MENU_PDF, stdMock.MENU_PDF],
    ['Recipes/Files/kitchen.png', 'Recipes/Files/kitchen [Claude preview].png', stdMock.KITCHEN_PNG, stdMock.previewOf('kitchen.png')],
    ...CHAT_DIRS.map(dir => [
      `${dir}/Attachments/photo.png`, `${dir}/Attachments/photo [Claude preview].png`,
      stdMock.PHOTO_PNG, stdMock.previewOf('photo.png'),
    ]),
  ];

  await test('it exports and reports success', async () => {
    assert.strictEqual(std.loadError, null);
    assert.strictEqual(std.statusText, 'Done — 2 chats exported.');
    assert.strictEqual(std.button.textContent, 'Export complete');
    assert.deepStrictEqual(lines(std, 'error'), []);
    assert.deepStrictEqual(lines(std, 'warn'), []);
    assert.ok(Object.values(std.fileStats).every(f => f.closed));
  });

  await test('the folder holds the instructions, the knowledge and every chat', async () => {
    assert.deepStrictEqual(Object.keys(std.files).sort(), [
      'Recipes/Project Instructions.md',
      'Recipes/Project Memory.md',
      'Recipes/Project Description.md',
      'Recipes/export.json',
      'Recipes/Files/menu.pdf',
      'Recipes/Files/kitchen.png',
      'Recipes/Files/notes.md',
      'Recipes/Files/grandma-letter.docx.extracted.md',
      ...CHAT_DIRS.flatMap(dir => [
        `${dir}/Pasta– basics–.md`,
        `${dir}/Attachments/in.csv`,
        `${dir}/Attachments/pantry.txt`,
        `${dir}/Attachments/photo.png`,
        `${dir}/Outputs/report.md`,
        `${dir}/Outputs/Recipe.md`,
        `${dir}/Outputs/shopping.txt`,
      ]),
    ].sort());

    assert.strictEqual(std.files['Recipes/Project Instructions.md'], 'Be a patient cook.');
    assert.strictEqual(std.files['Recipes/Project Description.md'], 'Family recipes');
    assert.strictEqual(std.files['Recipes/Project Memory.md'], 'Prefers metric units.');
    assert.strictEqual(std.files['Recipes/Files/notes.md'], '# Notes\n\nSalt the water.');
    // Text Claude took from a file that is not itself text says so in its name.
    assert.strictEqual(std.files['Recipes/Files/grandma-letter.docx.extracted.md'], 'Dear all,\nuse more butter.');
    // Two chats with one title get a folder each.
    assert.ok(std.files[`${CHAT_DIRS[0]}/Pasta– basics–.md`].includes('How do I cook pasta? (1)'));
    assert.ok(std.files[`${CHAT_DIRS[1]}/Pasta– basics–.md`].includes('How do I cook pasta? (2)'));
    // The abandoned branch of the chat is left out; the artifact is rebuilt.
    assert.ok(!std.files[`${CHAT_DIRS[0]}/Pasta– basics–.md`].includes('An abandoned branch.'));
    assert.strictEqual(std.files[`${CHAT_DIRS[0]}/Outputs/Recipe.md`], '# Pasta\n\nBoil 9 minutes.');
    assert.strictEqual(std.files[`${CHAT_DIRS[0]}/Outputs/shopping.txt`], 'pasta\nsalt');
    assert.strictEqual(std.files[`${CHAT_DIRS[0]}/Attachments/pantry.txt`], 'flour\neggs');
  });

  await test('pictures and PDFs are saved as the files themselves, not as Claude’s copies of them', async () => {
    for (const [own, labelled, bytes] of uploads) {
      assert.ok(own in std.files && !(labelled in std.files), own);
      assert.strictEqual(Buffer.compare(std.bytes[own], bytes), 0, own);
    }
  });

  await test('if the site will not hand out the files themselves, Claude’s copies are saved and named as such', async () => {
    assert.strictEqual(stdWithout.statusText, 'Done — 2 chats exported.');

    for (const [own, labelled, , copy] of uploads) {
      assert.ok(labelled in stdWithout.files && !(own in stdWithout.files), labelled);
      assert.strictEqual(Buffer.compare(stdWithout.bytes[labelled], copy), 0, labelled);
    }
    // For a picture, the copy is not the picture: a few bytes of WebP.
    assert.notStrictEqual(Buffer.compare(stdMock.previewOf('kitchen.png'), stdMock.KITCHEN_PNG), 0);

    // The manifest says which copy each file is.
    assert.deepStrictEqual(parse(stdWithout.files['Recipes/export.json']).files.filter(f => f.type === 'file'), [
      { path: 'Files/menu [Claude representation].pdf', name: 'menu.pdf', type: 'file', copy: 'representation', mime: 'application/pdf' },
      { path: 'Files/kitchen [Claude preview].png', name: 'kitchen.png', type: 'file', copy: 'preview', mime: 'image/webp' },
    ]);

    // Everything else is the same export, byte for byte.
    const moved = new Set(uploads.flatMap(([own, labelled]) => [own, labelled]));
    const rest = files => Object.keys(files).filter(n => !moved.has(n) && n !== 'Recipes/export.json').sort();
    assert.deepStrictEqual(rest(stdWithout.files), rest(std.files));
    for (const n of rest(std.files)) assert.strictEqual(Buffer.compare(stdWithout.bytes[n], std.bytes[n]), 0, n);
  });

  await test('its manifest lists the knowledge files, the chats and the memory', async () => {
    const man = parse(std.files['Recipes/export.json']);
    const { exported_at: when, ...settledPart } = man;

    assert.ok(!Number.isNaN(Date.parse(when)));
    assert.deepStrictEqual(settledPart, {
      format: 'claude-project-export',
      version: 1,
      kind: 'standard',
      source: { id: STD_ID },
      name: 'Recipes',
      description: 'Family recipes',
      instructions: 'Be a patient cook.',
      settings: { is_private: true, is_starred: false },
      files: [
        // The files themselves. (The site sends them without saying what
        // type they are, so none is recorded.)
        { path: 'Files/menu.pdf', name: 'menu.pdf', type: 'file', copy: 'original', mime: '' },
        { path: 'Files/kitchen.png', name: 'kitchen.png', type: 'file', copy: 'original', mime: '' },
        { path: 'Files/notes.md', name: 'notes.md', type: 'doc' },
        // Text Claude took from a file keeps that file's name.
        { path: 'Files/grandma-letter.docx.extracted.md', name: 'grandma-letter.docx', type: 'doc' },
      ],
      history: [
        { path: 'Chats/Pasta– basics–/Pasta– basics–.md', title: 'Pasta: basics?', type: 'chat' },
        { path: 'Chats/Pasta– basics– (2)/Pasta– basics–.md', title: 'Pasta: basics?', type: 'chat' },
      ],
      memory: { path: 'Project Memory.md' },
    });

    for (const row of [...man.files, ...man.history, man.memory]) assert.ok(`Recipes/${row.path}` in std.files, row.path);
  });

  await test('the manifest never passes a placeholder off as the project’s own text', async () => {
    const m = makeServer({
      faultEverywhere: true,
      fault: url => {
        if (url.pathname.endsWith(`/projects/${STD_ID}`)) return json(200, { uuid: STD_ID, name: 'Recipes' });
        if (url.pathname.endsWith('/memory')) return json(200, {});
        return null;
      },
    });
    const r = await run({ script: SCRIPT, pathname: STD_TAB, server: m.server });
    const man = parse(r.files['Recipes/export.json']);

    // The readable files say that nothing was returned...
    assert.match(r.files['Recipes/Project Instructions.md'], /^\(No project instructions/);
    // ...and the manifest holds nothing, rather than that sentence.
    assert.strictEqual(man.instructions, '');
    assert.strictEqual(man.description, '');
    assert.strictEqual(man.memory, null);
  });

  // What one chat costs: the chat, its sandbox's file list and files, and
  // the one picture attached to it.
  const chatRequests = (chat, picture) => [
    `${STD_API}/chat_conversations/${chat}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=eventual`,
    `${STD_API}/conversations/${chat}/wiggle/list-files?prefix=`,
    `${STD_API}/conversations/${chat}/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Fuploads%2Fin.csv`,
    `${STD_API}/conversations/${chat}/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Freport.md`,
    ...picture,
  ];

  await test('each file is asked for once, at the address of the file itself, and nothing is written to the site', async () => {
    assert.deepStrictEqual(std.requests.map(q => q.path), [
      '/api/organizations',
      `${STD_API}/projects?include_harmony_projects=true&limit=100`,
      `${STD_API}/projects/${STD_ID}`,
      `${STD_API}/memory?project_uuid=${STD_ID}`,
      `${STD_API}/projects/${STD_ID}/docs`,
      `${STD_API}/projects/${STD_ID}/files`,
      `${STD_API}/files/f9/contents`,
      `${STD_API}/files/f8/contents`,
      `${STD_API}/projects/${STD_ID}/conversations`,
      ...CHAT_IDS.flatMap(chat => chatRequests(chat, [`${STD_API}/files/f1/contents`])),
    ]);

    // An export only reads.
    assert.ok(std.requests.every(q => q.method === 'GET'));
    // The organization that only has API access is never asked for projects.
    assert.ok(!std.requests.some(q => q.path.includes(ORG_API)));
    assert.ok(std.requests.every(q => !q.path.startsWith('/v1/')));
    assert.ok(std.requests.every(q => !('anthropic-version' in q.headers)));
    assert.ok(!lines(std).some(t => t.includes('Could not list')));
  });

  await test('and where that address is refused, each file costs one more request: for Claude’s copy', async () => {
    assert.deepStrictEqual(stdWithout.requests.map(q => q.path), [
      '/api/organizations',
      `${STD_API}/projects?include_harmony_projects=true&limit=100`,
      `${STD_API}/projects/${STD_ID}`,
      `${STD_API}/memory?project_uuid=${STD_ID}`,
      `${STD_API}/projects/${STD_ID}/docs`,
      `${STD_API}/projects/${STD_ID}/files`,
      `${STD_API}/files/f9/contents`,
      `/api/${ORG_CHAT}/files/f9/document_pdf`,
      `${STD_API}/files/f8/contents`,
      `/api/${ORG_CHAT}/files/f8/preview`,
      `${STD_API}/projects/${STD_ID}/conversations`,
      ...CHAT_IDS.flatMap(chat => chatRequests(chat, [`${STD_API}/files/f1/contents`, `/api/${ORG_CHAT}/files/f1/preview`])),
    ]);
    assert.strictEqual(stdWithout.requests.filter(isContents).length, 4);
  });

  await test('an empty reply for a file that is not empty is not kept as that file', async () => {
    const m = makeServer({
      faultEverywhere: true,
      fault: url => (url.pathname.endsWith('/files/f8/contents') ? new Response(Buffer.alloc(0), { status: 200 }) : null),
    });
    const r = await run({ script: SCRIPT, pathname: STD_TAB, server: m.server });

    assert.match(r.statusText, /^Done/);
    assert.ok(!('Recipes/Files/kitchen.png' in r.files));
    // Claude's copy is kept instead, and is called what it is.
    assert.strictEqual(Buffer.compare(r.bytes['Recipes/Files/kitchen [Claude preview].png'], m.previewOf('kitchen.png')), 0);
    assert.deepStrictEqual(parse(r.files['Recipes/export.json']).files[1], {
      path: 'Files/kitchen [Claude preview].png', name: 'kitchen.png', type: 'file', copy: 'preview', mime: 'image/webp',
    });
    assert.deepStrictEqual(lines(r, 'warn'), [`"kitchen.png" is ${m.KITCHEN_PNG.length} bytes according to Claude, but 0 bytes were downloaded.`]);
    // The other file is untouched by this.
    assert.strictEqual(Buffer.compare(r.bytes['Recipes/Files/menu.pdf'], m.MENU_PDF), 0);
  });

  await test('a file that arrives in another size is kept, with a note in the console', async () => {
    const other = Buffer.from('not the size the record gives');
    const m = makeServer({
      faultEverywhere: true,
      fault: url => (url.pathname.endsWith('/files/f9/contents') ? new Response(other, { status: 200 }) : null),
    });
    const r = await run({ script: SCRIPT, pathname: STD_TAB, server: m.server });

    assert.strictEqual(Buffer.compare(r.bytes['Recipes/Files/menu.pdf'], other), 0);
    assert.deepStrictEqual(lines(r, 'warn'), [`"menu.pdf" is ${m.MENU_PDF.length} bytes according to Claude, but ${other.length} bytes were downloaded.`]);
  });

  await test('a failing download of the file itself falls back to Claude’s copy', async () => {
    const m = makeServer({
      faultEverywhere: true,
      fault: url => (url.pathname.endsWith('/files/f8/contents') ? json(500, { type: 'error', error: { type: 'api_error', message: 'Internal server error' } }) : null),
    });
    const r = await run({ script: SCRIPT, pathname: STD_TAB, server: m.server });

    assert.match(r.statusText, /^Done/);
    assert.ok(!('Recipes/Files/kitchen.png' in r.files));
    assert.ok('Recipes/Files/kitchen [Claude preview].png' in r.files);
    assert.ok(lines(r, 'warn').some(t => t.startsWith('Could not download project file: kitchen.png')));
  });

  await test('a text document with the same name as a file is exported as well', async () => {
    const m = makeServer({
      faultEverywhere: true,
      fault: url =>
        url.pathname.endsWith(`/projects/${STD_ID}/docs`)
          ? json(200, [
              { uuid: 'd1', file_name: 'notes.md', content: '# Notes\n\nSalt the water.' },
              { uuid: 'd3', file_name: 'menu.pdf', content: 'Typed by hand, under the same name as the PDF.' },
              { uuid: 'd4', file_name: 'kitchen.png', content: 'A description of the photo.' },
            ])
          : null,
    });
    const r = await run({ script: SCRIPT, pathname: STD_TAB, server: m.server });

    assert.deepStrictEqual(parse(r.files['Recipes/export.json']).files, [
      { path: 'Files/menu.pdf', name: 'menu.pdf', type: 'file', copy: 'original', mime: '' },
      { path: 'Files/kitchen.png', name: 'kitchen.png', type: 'file', copy: 'original', mime: '' },
      { path: 'Files/notes.md', name: 'notes.md', type: 'doc' },
      { path: 'Files/menu.pdf.extracted.md', name: 'menu.pdf', type: 'doc' },
      { path: 'Files/kitchen.png.extracted.md', name: 'kitchen.png', type: 'doc' },
    ]);
    assert.strictEqual(r.files['Recipes/Files/menu.pdf.extracted.md'], 'Typed by hand, under the same name as the PDF.');
    assert.strictEqual(Buffer.compare(r.bytes['Recipes/Files/menu.pdf'], m.MENU_PDF), 0);
  });

  // ------------------------------------------------------------------
  console.log('\n8. Saving as a .tar');

  // The address of a download is let go a minute after the click. Here that
  // minute would be waited out for real (see setTimeout in harness.js), so
  // it is cut to nothing.
  const noWait = src => {
    const out = src.replace('const DOWNLOAD_URL_LIFETIME = 60000;', 'const DOWNLOAD_URL_LIFETIME = 0;');
    assert.notStrictEqual(out, src);
    return out;
  };
  // A browser with no folder window at all, as Firefox and Safari are.
  const noPicker = src => {
    const pieces = src.split('window.showDirectoryPicker');
    assert.strictEqual(pieces.length, 3); // looked for once, called once
    return noWait(pieces.join('window.noSuchPicker'));
  };
  // A folder window that fails with `error` the moment it is asked for.
  const brokenPicker = (message, name) => src => {
    const out = src.replace(
      "destination = await window.showDirectoryPicker({ mode: 'readwrite' });",
      `throw Object.assign(new Error(${JSON.stringify(message)}), { name: ${JSON.stringify(name)} });`
    );
    assert.notStrictEqual(out, src);
    return noWait(out);
  };
  // ...as some Chrome setups do, reporting it closed without showing it.
  const closedPicker = brokenPicker('The user aborted a request.', 'AbortError');

  // What the status box says now. (r.statusText is what it said when the
  // run returned, before anything a button pressed afterwards did.)
  const statusOf = r => r.elements.find(e => e.tagName === 'DIV' && e !== r.elements[0]).textContent;
  const buttonsOf = r => r.elements.filter(e => e.tagName === 'BUTTON');
  const done = files => `Done — ${files} file(s), ${want.messages} message(s), ${want.threads} thread(s), ${want.sessions} session(s).`;

  // A project file whose path is over 100 bytes, which a plain ustar name
  // cannot hold. (Nothing in the mock is: its thread files come to 94.)
  const LONG_FILE = [
    'reports/2026 – third quarter – engineering/retrospective – what went well, what did not, and what we change next time.md',
    Buffer.from('Keep the retro short.\n'),
  ];
  const withLongPath = () => makeServer({}, { files: [LONG_FILE] });

  await test('the second button saves the export as one .tar download instead of a folder', async () => {
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: makeServer().server, resources: PAGE_REQUESTS, click: false, patch: noWait });
    assert.strictEqual(r.loadError, null);
    const [main, tar] = buttonsOf(r);
    assert.strictEqual(main.textContent, 'Export Claude Project');
    assert.strictEqual(tar.textContent, 'Save as .tar instead (no folder window)');

    for (const fn of tar.listeners.click) await fn({});

    assert.deepStrictEqual(r.pickerOptions, []);
    assert.deepStrictEqual(lines(r, 'error'), []);
    assert.deepStrictEqual(lines(r, 'warn'), []);
    assert.strictEqual(statusOf(r), `${done(want.files)} Saved as beethoven.tar in your downloads.`);
    assert.strictEqual(main.textContent, 'Export complete');
    assert.ok(main.disabled && tar.disabled);
    // Nothing went to a folder; the one file offered is the archive.
    assert.deepStrictEqual(Object.keys(r.root.flatten()), []);
    const links = r.elements.filter(e => e.tagName === 'A');
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].download, 'beethoven.tar');
    assert.ok(links[0].href.startsWith('blob:'));
  });

  // The main button in a browser without a folder window: the same export,
  // as a .tar. (Pressed during the run, so its download can be read back.)
  // Beside it, the folder export of the same project to compare it with.
  const tarred = await run({ script: SCRIPT, pathname: CODE_TAB, server: withLongPath().server, resources: PAGE_REQUESTS, patch: noPicker });
  const folderToo = await run({ script: SCRIPT, pathname: CODE_TAB, server: withLongPath().server, resources: PAGE_REQUESTS });
  const archive = tarred.downloads[0]?.blob ? Buffer.from(await tarred.downloads[0].blob.arrayBuffer()) : Buffer.alloc(0);
  const entries = unpack(archive);
  const inTar = Object.fromEntries(entries.map(e => [e.path, e.bytes]));

  await test('a browser with no folder window gets the .tar from the main button, and is told so', async () => {
    assert.strictEqual(tarred.loadError, null);
    assert.strictEqual(tarred.pickerCalls, 0);
    assert.deepStrictEqual(lines(tarred, 'error'), []);
    assert.deepStrictEqual(lines(tarred, 'warn'), []);
    assert.ok(lines(tarred, 'log').includes(
      'Claude exporter: This browser has no folder window, so the export will be saved as a .tar file in your downloads instead.'
    ));
    assert.strictEqual(tarred.statusText, `${done(want.files + 1)} Saved as beethoven.tar in your downloads.`);
    assert.strictEqual(tarred.button.textContent, 'Export complete');
    assert.deepStrictEqual(Object.keys(tarred.files), []);
    assert.strictEqual(tarred.downloads.length, 1);
    assert.strictEqual(tarred.downloads[0].name, 'beethoven.tar');
    assert.strictEqual(tarred.downloads[0].blob.type, 'application/x-tar');
  });

  await test('the archive holds exactly the files of a folder export, byte for byte', async () => {
    assert.match(folderToo.statusText, /^Done — 10 file\(s\)/);
    assert.deepStrictEqual(Object.keys(inTar).sort(), Object.keys(folderToo.bytes).sort());
    for (const [name, bytes] of Object.entries(folderToo.bytes)) {
      if (name.endsWith('routes used.json')) continue;
      if (name.endsWith('/export.json')) {
        assert.strictEqual(settled(name, inTar[name].toString('utf8')), settled(name, bytes.toString('utf8')));
      } else {
        assert.strictEqual(Buffer.compare(inTar[name], bytes), 0, name);
      }
    }
    // Plain files under the project's folder, and nothing else: no folder entries.
    assert.ok(entries.every(e => e.type === '0' && e.path.startsWith('beethoven/')));
    assert.strictEqual(unpack(archive, true).length, entries.length);
  });

  await test('it is ustar in 512-byte blocks, with a long-name entry ahead of each path over 100 bytes', async () => {
    const long = entries.filter(e => Buffer.byteLength(e.path, 'utf8') > 100);
    assert.deepStrictEqual(long.map(e => e.path), [`beethoven/Files/${LONG_FILE[0]}`]);
    assert.strictEqual(Buffer.compare(long[0].bytes, LONG_FILE[1]), 0);

    assert.strictEqual(archive.length % 512, 0);
    assert.ok(archive.subarray(-1024).every(b => b === 0));
    assert.ok(!archive.subarray(-1536, -1024).every(b => b === 0)); // exactly two zero blocks end it

    // Every header: ustar magic, mode 0000644, the export's time, and a
    // checksum that adds up; 'L' only ever as "././@LongLink", once per
    // long path.
    const field = (h, from, len) => h.subarray(from, from + len).toString('latin1').replace(/\0[^]*$/, '');
    let at = 0;
    let longNames = 0;
    while (at < archive.length - 1024) {
      const h = archive.subarray(at, at + 512);
      assert.strictEqual(field(h, 257, 6), 'ustar');
      assert.strictEqual(h.subarray(263, 265).toString(), '00');
      assert.strictEqual(field(h, 100, 8), '0000644');
      assert.ok(Math.abs(parseInt(field(h, 136, 12), 8) - Date.now() / 1000) < 600);
      const sum = [...h].reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
      assert.strictEqual(field(h, 148, 8), sum.toString(8).padStart(6, '0'));
      assert.strictEqual(h[155], 32);
      const size = parseInt(field(h, 124, 12), 8);
      const type = String.fromCharCode(h[156]);
      if (type === 'L') {
        assert.strictEqual(field(h, 0, 100), '././@LongLink');
        const carried = archive.subarray(at + 512, at + 512 + size);
        assert.strictEqual(carried[size - 1], 0);
        assert.strictEqual(Buffer.byteLength(carried.subarray(0, -1).toString('utf8'), 'utf8') + 1, size);
        longNames++;
      } else {
        assert.strictEqual(type, '0');
      }
      at += 512 + Math.ceil(size / 512) * 512;
    }
    assert.strictEqual(at, archive.length - 1024);
    assert.strictEqual(longNames, long.length);
  });

  await test('what could not be exported is still counted, ahead of where the file went', async () => {
    const m = makeServer({ fault: url => (url.pathname.endsWith('/config') ? v1Error(500, 'Internal server error') : null) });
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: m.server, patch: noPicker });
    assert.strictEqual(
      r.statusText,
      `${done(want.files)} 1 item(s) could not be exported; the folder’s README lists them. Saved as beethoven.tar in your downloads.`
    );
    assert.strictEqual(r.downloads.length, 1);
  });

  // A project file whose path climbs out of its folder. A real folder
  // refuses '..' as a name, so the file is a gap there; the archive must
  // refuse it the same way, or `cswap project-move check` refuses the
  // whole .tar over that one entry.
  await test('a file whose path has a ".." segment is the same gap in a .tar as in a folder', async () => {
    const climbing = [['notes/../escape.md', Buffer.from('out of bounds\n')]];
    const inFolder = await run({ script: SCRIPT, pathname: CODE_TAB, server: makeServer({}, { files: climbing }).server });
    const asTar = await run({ script: SCRIPT, pathname: CODE_TAB, server: makeServer({}, { files: climbing }).server, patch: noPicker });

    const problem = 'Project file notes/../escape.md (Name is not allowed.).';
    const rest = ' 1 item(s) could not be exported; the folder’s README lists them.';
    assert.strictEqual(inFolder.statusText, `${done(want.files)}${rest}`);
    assert.ok(inFolder.files['beethoven/README.md'].includes(`- ${problem}`));
    assert.deepStrictEqual(parse(inFolder.files['beethoven/export.json']).problems, [problem]);
    assert.ok(!Object.keys(inFolder.files).some(p => p.split('/').includes('..')));

    assert.strictEqual(asTar.statusText, `${done(want.files)}${rest} Saved as beethoven.tar in your downloads.`);
    assert.deepStrictEqual(lines(asTar, 'error'), []);
    assert.strictEqual(asTar.downloads.length, 1);
    const got = Object.fromEntries(unpack(Buffer.from(await asTar.downloads[0].blob.arrayBuffer())).map(e => [e.path, e.bytes]));
    assert.ok(!Object.keys(got).some(p => p.split('/').includes('..')));
    assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(inFolder.bytes).sort());
    assert.ok(got['beethoven/README.md'].toString('utf8').includes(`- ${problem}`));
    assert.deepStrictEqual(parse(got['beethoven/export.json'].toString('utf8')).problems, [problem]);
    // The same one warning on both paths, from the copy site.
    assert.deepStrictEqual(lines(asTar, 'warn'), lines(inFolder, 'warn'));
    assert.strictEqual(lines(asTar, 'warn').length, 1);
  });

  await test('a regular project is saved as a .tar the same way', async () => {
    const r = await run({ script: SCRIPT, pathname: STD_TAB, server: makeServer().server, patch: noPicker });
    assert.strictEqual(r.statusText, 'Done — 2 chats exported. Saved as Recipes.tar in your downloads.');
    assert.deepStrictEqual(lines(r, 'error'), []);
    assert.deepStrictEqual(Object.keys(r.files), []);
    assert.strictEqual(r.downloads.length, 1);
    assert.strictEqual(r.downloads[0].name, 'Recipes.tar');

    const got = Object.fromEntries(unpack(Buffer.from(await r.downloads[0].blob.arrayBuffer())).map(e => [e.path, e.bytes]));
    assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(std.bytes).sort());
    for (const [name, bytes] of Object.entries(std.bytes)) {
      if (name.endsWith('/export.json')) continue;
      assert.strictEqual(Buffer.compare(got[name], bytes), 0, name);
    }
    assert.strictEqual(settled('x/export.json', got['Recipes/export.json'].toString('utf8')), settled('x/export.json', std.files['Recipes/export.json']));
  });

  await test('a folder window that does not open leaves a hint, not an error', async () => {
    const r = await run({ script: SCRIPT, pathname: CODE_TAB, server: makeServer().server, patch: closedPicker });
    assert.strictEqual(
      r.statusText,
      'The folder window was closed or did not open. Press the button again, or press “Save as .tar instead” below.'
    );
    assert.deepStrictEqual(lines(r, 'error'), []);
    assert.strictEqual(r.button.disabled, false);
    assert.strictEqual(r.button.textContent, 'Export Claude Project');
    assert.ok(buttonsOf(r).every(b => !b.disabled));
    // Nothing was exported and nothing offered.
    assert.deepStrictEqual(v1Requests(r), []);
    assert.deepStrictEqual(Object.keys(r.files), []);
    assert.deepStrictEqual(r.downloads, []);
  });

  await test('any other failure of the folder window is still a failure', async () => {
    const r = await run({
      script: SCRIPT, pathname: CODE_TAB, server: makeServer().server,
      patch: brokenPicker('Must be handling a user gesture to show a file picker.', 'SecurityError'),
    });
    assert.strictEqual(r.statusText, 'Export failed: Must be handling a user gesture to show a file picker.');
    assert.strictEqual(lines(r, 'error').length, 1);
    assert.strictEqual(r.button.disabled, false);
    assert.deepStrictEqual(r.downloads, []);
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
