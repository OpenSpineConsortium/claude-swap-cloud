'use strict';
// A stand-in for the parts of claude.ai that the project export and import
// scripts (src/claude_swap/browser/) talk to.
//
// The /v1/code/ half mirrors what the live API was observed to do on
// 2026-10-04 (checked from a signed-in claude.ai tab):
//
//   * any /v1/ request without an anthropic-version header is refused with
//       400 {"error":{"message":"anthropic-version: header is required",
//                     "reason":"","type":"invalid_request_error"},...}
//   * nothing else is required: no organization header, no beta header
//   * lists are {"data":[...]} plus "next_cursor" while more rows exist; the
//     cursor goes back as ?cursor=
//   * limit above 200 (channel routes) or 500 (events) is refused with 400
//     "Request validation failed" and the rule in "reason"
//   * unknown query parameters are ignored
//   * timeline rows are thread roots, newest first; bound_only and
//     thread_roots_only filter a page after it is cut, so a page can be
//     short or empty and still carry a next_cursor, and they include roots
//     the plain view leaves out
//   * /threads/<id> returns the root and every reply, oldest first, for the
//     id of the root or of any reply in it; server notices are rows too and
//     are not counted in reply_count
//   * a server notice's body is a JSON object such as
//     {"kind":"status","text":"..."}; the kinds seen were status, activity,
//     error, thread_started, message_routed, onboarding and widget, and
//     every one of them had a "text"
//   * sessions are referred to as cse_<ULID> in channel data; the page asks
//     for session_<ULID>; both spellings work and the object comes back as
//     {"response_shape":{...}}
//   * a session's transcript is at /events: rows carry event_type,
//     sequence_num and payload; next_cursor is the last sequence number
//   * a project's own files: POST files:list {recursive, limit<=500, cursor}
//     answers {entries:[{path, is_directory, size_bytes, created_at}],
//     cursor} with folders listed as entries too and size_bytes a string;
//     POST files:open {path} answers {type:"text", content} for text and
//     {type:"download", data:<base64>} otherwise; with range_offset and
//     range_length it always answers "download" with exactly those bytes
//     and a content_revision; a range that starts at the end is empty; a
//     missing file is 404 not_found_error
//
// The half that CHANGES things (creating a project, its settings, uploads,
// files:write, project docs) is modelled on the requests claude.ai's own
// front-end code makes, and is deliberately strict: unknown fields, wrong
// content types and bad ids are refused. What it answers was then checked
// against one live import of each kind into throwaway projects (2026-10-05):
//
//   * POST /v1/code/channels answers 200 {"channel":{...}}; the new project
//     has a session for its own Claude and one onboarding card at once, and
//     that Claude takes no turn
//   * every setting that really changes (PATCH …/config, PATCH {topic}) wakes
//     the project's Claude with a "settings-changed" note; a PATCH that
//     changes nothing does not, and neither does files:write
//   * PATCH {disabled:true} sets disabled_at and interrupts that Claude;
//     while paused, settings can still be changed (waking nobody), files can
//     still be listed and read, and files:write is refused with 400
//     "this project is paused" / reason channel_disabled
//   * POST /api/{org}/upload?store_as_is=true answers 200 with file_kind
//     "blob" ("image" for a picture) and a tidied file_name; files:write
//     then answers {"results":[{"path","entry":{...}}]} with no error_reason
//     on success, at exactly the path asked for
//   * files/usage counts folders as well as files
//   * regular projects: create is 201, PUT is 202, a doc is 201, an upload
//     is 200 with the whole file record
//   * an uploaded file's record points at copies Claude made of it, under
//     /api/{org}/files/{id}/preview|thumbnail|document_pdf (no
//     "organizations" in that path); the upload itself is served at
//     /api/organizations/{org}/files/{id}/contents, with a content
//     disposition and no content type
//
// A project's memory (its Auto memory) is read on claude.ai by its Auto
// memory panel with GET /v1/code/memory/channel/{channel}/memories?limit=100
// and /memories/{mem_id}: those addresses were seen (2026-10-07), what
// they answer was not. Here the list leaves the text out and pages by
// next_cursor, and each memory is read on its own; `noChannelMemory`
// refuses the route with 404 and `channelMemoryBeta` asks it for the beta
// header. Where it is refused, the export looks for the project's memory
// store. That was NOT seen on claude.ai either (the one store an export
// found answered 404 there). It is
// modelled on the requests the Claude Code program makes: a memory store
// whose id starts with cagt_, named by the path /v1/code/memory/cagt_<id>,
// read with GET /v1/memory_stores/{store}/memories?beta=true and
// /memories/{id}?beta=true, each with the header anthropic-beta:
// agent-memory-2026-07-22. Which field of a project names its store is not
// known; here the channel record carries the path in a field the export
// does not look for by name, so the export has to find it the way it finds
// sessions. The list leaves the text out, so each memory is read as well,
// and it pages with next_page. A new project gets a store of its own, empty.
//
// The content is synthetic. Sizes are chosen to cross every page boundary.

const crypto = require('crypto');
const { json } = require('./harness');

const ORG_CHAT = 'dddddddd-0000-4000-8000-000000000001';
const ORG_API = 'eeeeeeee-0000-4000-8000-000000000001';
const CHANNEL = 'chan_01BEETHOVENBEETHOVEN0000';
const OTHER_CHANNEL = 'chan_01ZZZZZZZZZZZZZZZZZZZZZZ';
const ME = 'user_01MEMEMEMEMEMEMEMEMEMEME';
const SOMEONE = 'user_01SOMEONEELSE0000004242';
const AGENT = 'cagt_01AGENTAGENTAGENTAGENT00';
const MEMORY_STORE = 'cagt_01MEMORYMEMORYMEMORYMEMORY';
const MEMORY_BETA = 'agent-memory-2026-07-22';
// claude.ai's answer to a memory written from a browser without a
// precondition (seen 2026-10-08).
const MEMORY_PRECONDITION_REQUIRED = 'browser session writes require an optimistic-concurrency precondition: ' +
  '`precondition` in the POST body, `expected_content_sha256` on DELETE';
const REQUEST_ID = 'req_011AAAAAAAAAAAAAAAAAAAAA';

const ulid = (tag, n) => `01${tag}${String(n).padStart(22 - tag.length, '0')}`;
const stamp = minutes => new Date(Date.UTC(2026, 8, 1, 9, 0, 0) + minutes * 60000).toISOString();

// Error bodies in the two shapes the real site uses.
const v1Error = (status, message, reason = '') =>
  json(status, {
    error: {
      message,
      reason,
      type: status === 404 ? 'not_found_error' : 'invalid_request_error',
    },
    request_id: REQUEST_ID,
    type: 'error',
  });

const apiError = (status, type, message, extra = {}) =>
  json(status, { type: 'error', error: { type, message, ...extra }, request_id: REQUEST_ID });

// Uploaded files in the fixture. None of them is valid UTF-8, so a copy that
// had been through text would show.
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MENU_PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x00, 0xff]), Buffer.from('\nfake menu\n')]);
const KITCHEN_PNG = Buffer.concat([PNG_HEAD, Buffer.from([0x00, 0xff, 0xfe]), Buffer.from('the kitchen photo, full size')]);
const PHOTO_PNG = Buffer.concat([PNG_HEAD, Buffer.from([0x00, 0xfd]), Buffer.from('the photo attached to a chat')]);

// Claude's own small copy of a picture: another format, and far fewer bytes.
const previewOf = name =>
  Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from(`WEBPVP8 small copy of ${name}`)]);

// ------------------------------------------------------------------ world
function buildWorld(sizes = {}) {
  const cfg = {
    roots: 450, // top-level messages in the main feed
    replies: [2, 7, 198, 449, 20, 37, 53, 47, 30], // rows under each threaded root
    hiddenReplies: [3, 2, 1], // threads that are not in the main feed
    events: [1304, 0, 3, 499, 500, 501, 1234, 95, 2600, 46, 7, 1000, 12, 60, 5],
    ...sizes,
  };

  const sessions = new Map(); // ULID → { id, title, events }
  let sessionSeq = 0;

  const addSession = title => {
    const n = sessionSeq++;
    const id = `cse_${ulid('SESS', n)}`;
    sessions.set(id.slice(4), {
      id,
      title,
      created_at: stamp(n * 3),
      events: cfg.events[n % cfg.events.length],
    });
    return id;
  };

  const channelSession = addSession('beethoven overview');
  const roots = []; // oldest first
  const threads = new Map(); // root id → rows (root first, oldest first)
  const owner = new Map(); // any message id → its root id
  let messageSeq = 0;

  const message = (fields, minutes) => ({
    id: `cmsg_${ulid('MSG', messageSeq++)}`,
    channel_id: CHANNEL,
    created_at: stamp(minutes),
    attached_outputs: [],
    attachments: [],
    bound_sessions: [],
    has_attachments: false,
    in_timeline: true,
    links: [],
    mentioned_account_ids: [],
    mentioned_groups: [],
    participant_account_ids: [],
    participant_count: '0',
    reactions: [],
    reply_count: '0',
    seq: '0',
    ...fields,
  });

  const addThread = (root, rowCount, minutes, title) => {
    const bound = addSession(title);
    root.bound_sessions = [{ id: bound, status: 'active', status_bucket: 'working', title }];
    root.thread_status = 'working';

    const rows = [root];
    let replies = 0;

    for (let r = 1; r <= rowCount; r++) {
      const notice = r % 5 !== 0 && r % 5 !== 3; // 3 in 5 rows are notices
      const byUser = !notice && r % 10 === 0;

      // Notices carry JSON. Two odd ones check the fallbacks: a body that is
      // not JSON at all, and JSON without a "text".
      const noticeBody =
        r === 6
          ? 'plain words, not JSON'
          : r === 7
            ? JSON.stringify({ kind: 'mystery', detail: 42 })
            : r % 2
              ? JSON.stringify({ kind: 'status', text: `Claude is working (step ${r})\n\n✱ Reading files\n✓ Wrote the plan` })
              : JSON.stringify({ kind: 'activity', tool: 'Bash', text: `Running a command (step ${r})` });

      const row = message(
        {
          body: notice ? noticeBody : `Reply ${r} in "${title}"\nwith a second line.`,
          thread_root_id: root.id,
          in_timeline: false,
          ...(notice ? { server_notice: true } : {}),
          ...(byUser
            ? { author_account_id: ME, client_message_id: 'c0ffee00-0000-4000-8000-000000000000' }
            : { author_agent_id: AGENT, author_session_id: bound }),
        },
        minutes + r / 100
      );

      if (!notice) replies++;
      rows.push(row);
    }

    root.reply_count = String(replies);
    root.last_reply_at = rows[rows.length - 1].created_at;
    threads.set(root.id, rows);
    for (const row of rows) owner.set(row.id, root.id);
    return rows;
  };

  let threadSeq = 0;

  for (let i = 0; i < cfg.roots; i++) {
    const byUser = i % 5 === 0;
    const notice = !byUser && i % 7 === 0;

    const root = message(
      {
        body: notice
          ? JSON.stringify({ kind: 'thread_started', session_id: channelSession, text: `Session started (${i})` })
          : `Top-level message ${i}: what about item ${i}?`,
        ...(notice ? { server_notice: true } : {}),
        ...(byUser
          ? { author_account_id: i % 25 === 0 ? SOMEONE : ME }
          : { author_agent_id: AGENT, author_session_id: channelSession }),
      },
      i * 10
    );
    root.thread_root_id = root.id;
    roots.push(root);
    owner.set(root.id, root.id);

    if (i % 50 === 10 && threadSeq < cfg.replies.length) {
      // Two threads share a title on purpose, to exercise file-name clashes.
      const title = threadSeq === 4 ? 'Thread work 3' : `Thread work ${threadSeq}`;
      addThread(root, cfg.replies[threadSeq], i * 10, title);
      root.body = `Kick-off for ${title}: please look at [item ${i}](#cmsg_01LINK) / "quoted" <tag>?`;
      threadSeq++;
    }

    if (i === 20) {
      // A message that started a session but has no replies.
      const lone = addSession('One-shot session');
      root.bound_sessions = [{ id: lone, status: 'archived', status_bucket: 'done', title: 'One-shot session' }];
      root.attached_outputs = [
        { id: 'out_1', kind: 'file', filename: 'notes.md', path: 'state/notes.md', href: '', size_bytes: '120' },
        { id: 'out_2', kind: 'link', filename: 'PR 12', href: 'https://github.com/example/repo/pull/12', href_host: 'github.com' },
      ];
    }
  }

  // Threads that exist but are not shown in the main feed.
  const hidden = cfg.hiddenReplies.map((count, h) => {
    const root = message(
      {
        body: `Background thread ${h}`,
        author_agent_id: AGENT,
        author_session_id: channelSession,
        in_timeline: false,
      },
      (cfg.roots + h) * 10
    );
    root.thread_root_id = root.id;
    owner.set(root.id, root.id);
    addThread(root, count * 2, (cfg.roots + h) * 10, `Background work ${h}`);
    return root;
  });

  // A session that only a reply inside a thread refers to.
  const deep = addSession('Helper session');
  const anyThread = [...threads.values()].find(rows => rows.length > 3);
  if (anyThread) {
    anyThread[2].author_session_id = deep;
    delete anyThread[2].server_notice;
    anyThread[2].author_agent_id = AGENT;
  }

  const everyRoot = [...roots, ...hidden]; // oldest first

  // The project's own files. Between them they cover text, binary, empty,
  // deep folders, names a disk cannot hold, names that collide once made
  // safe, and one file big enough to be read in several pieces.
  const noise = Buffer.alloc(70000);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 31 + (i >> 8) * 7 + 13) & 0xff;

  const files = new Map([
    ['state/notes.md', Buffer.from('# Notes\n\nRemember the milk.\n')],
    ['state/data.json', Buffer.from('{"a":1}\n')],
    ['plan/deep/nested/outline.md', Buffer.from('1. Start\n2. Finish\n')],
    ['bundles/repo.bundle', Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a, 0x50, 0x4b, 0x03, 0x04, 0xc3, 0x28])],
    ['empty.txt', Buffer.alloc(0)],
    ['ünïcode name – café.md', Buffer.from('Crème brûlée ☕\n')],
    ['weird/a:b?.md', Buffer.from('colon and question mark\n')],
    ['weird/a–b–.md', Buffer.from('already a safe name\n')],
    ['big/blob.bin', noise],
    ...(cfg.files || []),
  ]);

  // What the project's Claude remembered: an index and one file per fact,
  // one of them in a folder of its own. `sizes.memories` puts others in
  // their place.
  const memories = (cfg.memories || [
    ['/MEMORY.md', '# Memory\n\n- [Who I work with](user_role.md)\n- [Testing](feedback/testing.md)\n- [The score](project_beethoven.md)\n'],
    ['/user_role.md', '---\nname: user role\ntype: user\n---\nWorks on the beethoven project; likes short answers.\n'],
    ['/feedback/testing.md', '---\nname: testing\ntype: feedback\n---\nRun the tests before every commit \u2713\n'],
    ['/project_beethoven.md', '---\nname: the score\ntype: project\n---\nThe score is in Scores on Google Drive.\n'],
  ]).map(([path, content], n) => ({
    id: `mem_${ulid('MEM', n)}`,
    path,
    content,
    created_at: stamp(100 + n),
    updated_at: stamp(200 + n),
  }));

  const channel = {
    id: CHANNEL,
    name: 'beethoven',
    topic: 'Everything about the beethoven project.\nSecond paragraph of the topic.',
    agent_id: AGENT,
    channel_session_id: channelSession,
    overview_session_id: channelSession,
    created_by_account_id: ME,
    visibility: 'private',
    icon: 'MusicNotes',
    color: 'purple',
    template: '',
    created_at: stamp(-5),
    archived_at: null,
    disabled_at: null,
    memory_enabled: true,
    memory: { kind: 'silo', store_path: `/v1/code/memory/${MEMORY_STORE}` },
    context_sources: [
      { kind: 'google_drive_folder', name: 'Scores', path: '', url: 'https://drive.google.com/drive/folders/abc123' },
    ],
    thread_count: '0',
    members: [{ account_id: ME, role: 'owner', notify_level: 'all' }],
    membership: { account_id: ME, role: 'owner', notify_level: 'all' },
  };

  return { cfg, sessions, roots, hidden, everyRoot, threads, owner, channel, channelSession, files, memories };
}

// One session event, decided entirely by its sequence number.
function makeEvent(sessionId, seq) {
  const base = {
    event_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    sequence_num: String(seq),
    created_at: stamp(seq),
    received_at: stamp(seq),
    source: 'worker',
    sent_by_account_id: null,
    device_attestation_status: 'DEVICE_ATTESTATION_STATUS_UNSPECIFIED',
  };
  const ids = { session_id: sessionId, uuid: base.event_id };
  const k = seq % 10;

  if (seq === 1) {
    return { ...base, event_type: 'system', payload: { type: 'system', subtype: 'init', ...ids } };
  }

  if (seq % 40 === 2) {
    return {
      ...base,
      source: 'client',
      event_type: 'user',
      payload: {
        type: 'user',
        isSynthetic: false,
        message: { role: 'user', content: `Prompt ${seq}: please handle item ${seq}.\nIt has a second line.` },
        ...ids,
      },
    };
  }

  if (k === 3) {
    return {
      ...base,
      event_type: 'assistant',
      payload: {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: `private reasoning ${seq}`, signature: 'sig' },
            { type: 'tool_use', id: `toolu_${seq}`, name: 'Bash', input: { command: `echo ${seq}`, description: 'Print a number' }, caller: { type: 'direct' } },
          ],
        },
        ...ids,
      },
    };
  }

  if (k === 4) {
    return {
      ...base,
      event_type: 'user',
      payload: {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: `toolu_${seq - 1}`,
              is_error: seq % 60 === 4,
              content: seq % 20 === 4 ? [{ type: 'text', text: `output ${seq}` }] : `output ${seq}\nline two`,
            },
          ],
        },
        ...ids,
      },
    };
  }

  if (k === 5) {
    return {
      ...base,
      event_type: 'assistant',
      payload: {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: `Answer ${seq}: done with item ${seq}.` }] },
        ...ids,
      },
    };
  }

  if (k === 6) {
    return {
      ...base,
      event_type: 'assistant',
      payload: {
        type: 'assistant',
        parent_tool_use_id: 'toolu_parent',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: `subagent note ${seq}` },
            { type: 'tool_use', id: `toolu_sub_${seq}`, name: 'Read', input: { file_path: `/tmp/${seq}.txt` } },
          ],
        },
        ...ids,
      },
    };
  }

  if (k === 7) {
    return {
      ...base,
      event_type: 'user',
      payload: {
        type: 'user',
        parent_tool_use_id: 'toolu_parent',
        message: { role: 'user', content: `subtask ${seq}` },
        ...ids,
      },
    };
  }

  if (k === 8) {
    return { ...base, event_type: 'system', payload: { type: 'system', subtype: 'api_retry', attempt: 1, ...ids } };
  }

  if (k === 9) {
    return { ...base, event_type: 'result', payload: { type: 'result', subtype: 'success', result: `Answer ${seq - 4}`, ...ids } };
  }

  return { ...base, event_type: 'system', payload: { type: 'system', subtype: 'hook_started', hook_name: 'PreToolUse', ...ids } };
}

// ------------------------------------------------------------- tagged ids
// The site refers to an uploaded file by a tagged id: "file_", then
// whatever sits between the channel id's prefix and its last part, then
// "01" and the upload's UUID as a 22-digit base-58 number. This decoder is
// written from the site's own (not from the importer's encoder), so the
// two check each other.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function uuidFromTaggedId(prefix, tagged) {
  if (typeof tagged !== 'string' || !tagged.startsWith(`${prefix}_`)) return null;

  const tail = tagged.slice(tagged.lastIndexOf('_') + 1);
  if (tail.length !== 24 || !tail.startsWith('01')) return null;

  let n = 0n;
  for (const ch of tail.slice(2)) {
    const digit = B58.indexOf(ch);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }
  if (n >= 1n << 128n) return null;

  const hex = n.toString(16).padStart(32, '0');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

// A UUID that looks random but is the same on every run.
const fakeUuid = seed => {
  const hex = crypto.createHash('md5').update(String(seed)).digest('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
};

// The site's rule for one part of a project-file path.
const validPart = part =>
  part !== '' && part !== '.' && part !== '..' && !/[\p{Cc}\p{Cf}]/u.test(part) && !part.includes('\\');

const validPath = path =>
  typeof path === 'string' && path !== '' && !path.startsWith('/') && !path.includes('\\') &&
  path.split('/').every(validPart);

const isText = bytes => {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

// ----------------------------------------------------------------- server
// rules:
//   needVersion        (default true) refuse /v1/ without anthropic-version
//   extraHeader        name of one more header /v1/ insists on (to model a
//                      future requirement the scripts do not know about)
//   cursorOnFullPage   send next_cursor whenever a page is full, even if it
//                      was the last one (the other common pagination style)
//   filesPageSize      cap on entries per files:list page, to force paging
//   kickoffOnTopic     (default true) a channel created WITH a topic has its
//                      agent start work at once, as a new project's does
//   knownIcons         when set, creating a channel with any other icon is
//                      refused with 400
//   models             the model ids this account may use (a Set)
//   seedFiles          [[path, Buffer]] already in every NEW channel's files,
//                      as if its agent had written them on start-up
//   writeReason        (path, nth) => reason | '' forces what files:write
//                      says about one file; nth counts tries per path
//   storageFiles       how many files a channel's storage holds
//   idInfix            put between "chan_" and the rest of a NEW channel's
//                      id, as ids outside production have ("chan_stg_01…")
//   noContents         true, or (fileId) => true: the address of an uploaded
//                      file itself answers 404, so that only the copies
//                      Claude made of it can be had
//   fault              (url, headers, nth, init) => Response | null, tried
//                      first on every /v1/ request (on every request at all
//                      with faultEverywhere); nth counts requests per path
//   memoryPageSize     (default 3) memories per page of a store's list,
//                      and of the project route's (or its limit, if less)
//   refuseMemories     a store's list is refused with 403
//   noChannelMemory    the project's own memory route answers 404
//   channelMemoryBeta  the project's own memory route asks for the beta
//                      header (400 without it)
//   noMemoryWrites     a new memory sent to the project's own route is
//                      refused with 404 (its list still answers)
//   memoryPrecondition (precondition) => true | false | 'failed': whether
//                      a new memory's precondition is one the project's own
//                      route takes; 'failed' answers that it does not hold
//                      (409). claude.ai asks for one from a browser and
//                      refuses a write without it, in its own words; which
//                      it takes for a new memory was not seen, so by
//                      default this takes the import's first guess
//   memoryPreconditionKinds  kinds of precondition a refusal of one names
//   noMemoryPrecondition     the route asks for none and refuses one, as
//                      the memory API's create does
//   noMemorySizes      the project's own route lists its memories without
//                      their size
function makeServer(rules = {}, sizes = {}) {
  const need = {
    needVersion: true, extraHeader: null, cursorOnFullPage: false,
    filesPageSize: 500, kickoffOnTopic: true, fault: null,
    knownIcons: null, models: new Set(['claude-test-model', 'claude-other-model']),
    seedFiles: [], writeReason: null, storageFiles: 50000, idInfix: '',
    memoryPageSize: 3, refuseMemories: false, noChannelMemory: false, channelMemoryBeta: false,
    noMemoryWrites: false, noMemorySizes: false,
    memoryPrecondition: p => p?.type === 'content_sha256' && p.content_sha256 === null,
    memoryPreconditionKinds: null, noMemoryPrecondition: false,
    ...rules,
  };
  const world = buildWorld(sizes);
  const hits = { v1Ok: 0, v1Refused: 0, byPath: new Map() };
  let serial = 0;

  const PROJECT = 'aaaaaaaa-0000-4000-8000-000000000001';
  const CHATS = ['bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'];

  // Everything the server keeps, by id. The fixtures are in here from the
  // start; whatever an import creates is added next to them.
  const channels = new Map([
    [CHANNEL, {
      record: world.channel,
      config: {
        agent_id: AGENT,
        default_environment_id: 'env_01ENVENVENVENVENVENVENV0',
        default_model: 'claude-test-model',
        channel_session_model: 'claude-other-model',
        default_effort_level: 'ultracode',
        channel_session_effort_level: 'max',
        default_source_urls: ['https://github.com/example/web-app', 'https://github.com/example/api'],
        limit_auto_continue: true,
        allow_worker_chrome: true,
        memory_enabled: true,
        tasks_enabled: false,
        member_config_disabled: false,
        owner_device_disabled: false,
        default_plugin_ids: [],
        default_skill_ids: [],
        member_plugin_ids: [],
        mcp_servers: [],
        system_prompt_addendum: 'You are the beethoven channel agent.\nAlways answer in threads.',
      },
      files: world.files,
      rows: null, // the fixture's timeline and threads come from `world`
      memory: { store: MEMORY_STORE, memories: world.memories },
    }],
  ]);
  const uploads = new Map(); // upload UUID → { name, type, bytes, asIs }
  const projects = new Map(); // regular projects made by an import

  // Every uploaded picture and PDF, by file id: the fixture's three, and
  // whatever an import uploads.
  const stored = new Map([
    ['f9', { name: 'menu.pdf', kind: 'document', bytes: MENU_PDF }],
    ['f8', { name: 'kitchen.png', kind: 'image', bytes: KITCHEN_PNG }],
    ['f1', { name: 'photo.png', kind: 'image', bytes: PHOTO_PNG }],
  ]);
  const state = { channels, uploads, projects, stored };

  // A file's record as the site lists it. The addresses in it lead to the
  // copies Claude made, never to the upload itself.
  const fileRecord = (id, createdAt = stamp(70000)) => {
    const f = stored.get(id);
    const copy = variant => `/api/${ORG_CHAT}/files/${id}/${variant}`;
    const picture = variant => ({ url: copy(variant), file_variant: variant, primary_color: 'ffffff', image_width: 64, image_height: 64 });

    return {
      success: true,
      path: null,
      sanitized_name: null,
      file_kind: f.kind,
      file_uuid: id,
      file_name: f.name,
      created_at: createdAt,
      user_uuid: null,
      size_bytes: f.bytes.length,
      ...(f.kind === 'image'
        ? {
            thumbnail_url: copy('thumbnail'),
            preview_url: copy('preview'),
            thumbnail_asset: picture('thumbnail'),
            preview_asset: picture('preview'),
          }
        : f.kind === 'document'
          ? {
              thumbnail_asset: picture('thumbnail'),
              preview_asset: null,
              document_asset: { url: copy('document_pdf'), file_variant: 'original', page_count: 1, token_count: 12 },
            }
          : {}),
      uuid: id,
    };
  };

  // The same file as a chat message carries it: without its size.
  const chatFile = id => {
    const { success, path, sanitized_name, user_uuid, size_bytes, uuid, ...rest } = fileRecord(id);
    return rest;
  };

  const kindOf = file =>
    /^image\//.test(file.type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name) ? 'image' : 'document';

  const page = (rows, limit, start, moreAfter) => {
    const slice = rows.slice(start, start + limit);
    const end = start + slice.length;
    const more = need.cursorOnFullPage ? slice.length === limit && limit > 0 : moreAfter(end);
    return { slice, end, more };
  };

  const feedCursor = index => `${String(1700000000000000 + index).padStart(16, '0')}.${'0'.repeat(8)}-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const feedIndex = cursor => (cursor ? Number(String(cursor).split('.')[0]) - 1700000000000000 : 0);

  const limitOf = (q, max, fallback) => {
    if (!q.has('limit')) return { limit: fallback };
    const limit = Number(q.get('limit'));
    if (!Number.isInteger(limit) || limit < 1 || limit > max) {
      return {
        refused: v1Error(
          400,
          'Request validation failed',
          `limit: must be greater than or equal to 1 and less than or equal to ${max}`
        ),
      };
    }
    return { limit };
  };

  const jsonBody = init => {
    try {
      return typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    } catch {
      return null;
    }
  };

  const formFile = async init => {
    const form = init?.body;
    const file = form && typeof form.get === 'function' ? form.get('file') : null;
    if (!file || typeof file.arrayBuffer !== 'function') return null;
    return { name: file.name, type: file.type || '', bytes: Buffer.from(await file.arrayBuffer()) };
  };

  const notFoundFile = () =>
    json(404, {
      error: {
        message: "file not found on this channel's project filesystem",
        resource_id: '',
        resource_type: 'channel_file',
        type: 'not_found_error',
      },
      request_id: REQUEST_ID,
      type: 'error',
    });

  // Every folder that holds one of these paths, directly or not.
  const foldersOf = paths => {
    const folders = new Set();
    for (const path of paths) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    }
    return folders;
  };

  // A setting that really changed is relayed to the project's own Claude,
  // unless the project is paused. `wakes` is what that Claude was told.
  const wake = (st, field) => {
    if (st.created && !st.record.disabled_at) st.wakes.push(field);
  };

  const CONFIG_KEYS = new Set([
    'default_environment_id', 'default_model', 'channel_session_model', 'default_effort_level',
    'channel_session_effort_level', 'system_prompt_addendum', 'default_source_urls',
    'limit_auto_continue', 'thread_agent_team', 'thread_lifecycle', 'allow_worker_chrome',
    'memory_sensitive_filter',
  ]);
  const EFFORTS = new Set(['low', 'medium', 'high', 'max', 'ultracode']);
  const writeTries = new Map(); // path → how often files:write was asked for it

  async function v1(url, headers, init) {
    const p = url.pathname;
    const q = url.searchParams;
    const method = (init?.method || 'GET').toUpperCase();

    if (need.needVersion && !headers['anthropic-version']) {
      return v1Error(400, 'anthropic-version: header is required');
    }
    if (need.extraHeader && !headers[need.extraHeader]) {
      return v1Error(400, `${need.extraHeader}: header is required`);
    }
    // When an organization is named, it has to be one this login can use.
    if (headers['x-organization-uuid'] && headers['x-organization-uuid'] !== ORG_CHAT) {
      // Word for word what the live API answered to a made-up organization.
      return json(403, { type: 'error', error: { type: 'permission_error', message: 'Permission denied.' }, request_id: null });
    }
    if (method !== 'GET' && !/json/i.test(headers['content-type'] || '')) {
      return v1Error(400, 'Request validation failed', 'content-type: must be application/json');
    }

    // ---- channels
    if (p === '/v1/code/channels' && method === 'GET') {
      const { refused } = limitOf(q, 200, 50);
      if (refused) return refused;
      return json(200, {
        data: [
          { id: OTHER_CHANNEL, name: 'some-other-channel', topic: 'not this one' },
          ...[...channels.values()].map(c => c.record),
        ],
      });
    }

    if (p === '/v1/code/channels' && method === 'POST') {
      const b = jsonBody(init) || {};
      if (typeof b.name !== 'string' || !b.name.trim()) {
        return v1Error(400, 'Request validation failed', 'name: must not be empty');
      }
      if (!['private', 'public', 'space'].includes(b.visibility)) {
        return v1Error(400, 'Request validation failed', 'visibility: must be one of private, public, space');
      }
      if (need.knownIcons && b.icon !== undefined && !need.knownIcons.has(b.icon)) {
        return v1Error(400, 'Request validation failed', 'icon: unknown icon');
      }

      const n = ++serial;
      const id = `chan_${need.idInfix ? `${need.idInfix}_` : ''}${ulid('NEW', n)}`;
      const own = `cse_${ulid('NEWS', n)}`;
      world.sessions.set(own.slice(4), { id: own, title: `${b.name} overview`, created_at: stamp(90000 + n), events: 0 });

      const row = fields => ({
        id: `cmsg_${ulid('NEWM', ++serial)}`,
        channel_id: id,
        created_at: stamp(90000 + serial),
        attached_outputs: [], attachments: [], bound_sessions: [], links: [], reactions: [],
        in_timeline: true, reply_count: '0', seq: '0',
        author_agent_id: AGENT,
        ...fields,
      });

      const rows = [
        row({ server_notice: true, author_session_id: own, body: JSON.stringify({ kind: 'onboarding', text: 'Welcome to your new project.' }) }),
      ];

      // A project created with a goal has its agent start on that goal.
      if (need.kickoffOnTopic && typeof b.topic === 'string' && b.topic.trim()) {
        const kick = `cse_${ulid('KICK', n)}`;
        world.sessions.set(kick.slice(4), { id: kick, title: 'Getting started on your goal', created_at: stamp(90000 + n), events: 12 });
        rows.push(row({
          author_session_id: kick,
          body: 'I have read your goal and started on it.',
          bound_sessions: [{ id: kick, status: 'active', status_bucket: 'working', title: 'Getting started on your goal' }],
        }));
      }
      for (const r of rows) r.thread_root_id = r.id;

      const record = {
        id,
        name: b.name,
        topic: typeof b.topic === 'string' ? b.topic : '',
        visibility: b.visibility,
        icon: typeof b.icon === 'string' ? b.icon : 'Sparkle',
        color: typeof b.color === 'string' ? b.color : 'gray',
        template: typeof b.template === 'string' ? b.template : '',
        context_sources: Array.isArray(b.context_sources) ? b.context_sources : [],
        agent_id: AGENT,
        channel_session_id: own,
        overview_session_id: own,
        created_by_account_id: ME,
        created_at: stamp(90000 + n),
        disabled_at: null,
        thread_count: '0',
        members: [{ account_id: ME, role: 'owner', notify_level: 'all' }],
        membership: { account_id: ME, role: 'owner', notify_level: 'all' },
        // A new project's memory: a store of its own, empty.
        memory: { kind: 'silo', store_path: `/v1/code/memory/cagt_${ulid('NEWMEM', n)}` },
      };

      channels.set(id, {
        record,
        // The settings a new project was seen to start with.
        config: {
          agent_id: AGENT,
          allow_worker_chrome: false,
          channel_session_effort_level: '',
          channel_session_model: '',
          default_effort_level: '',
          default_environment_id: '',
          default_model: [...need.models][0] || '',
          default_plugin_ids: [],
          default_skill_ids: [],
          default_source_urls: Array.isArray(b.default_source_urls) ? b.default_source_urls : [],
          limit_auto_continue: true,
          mcp_servers: [],
          member_config_disabled: false,
          member_plugin_ids: [],
          memory_enabled: true,
          owner_device_disabled: false,
          system_prompt_addendum: typeof b.system_prompt_addendum === 'string' ? b.system_prompt_addendum : '',
          tasks_enabled: false,
        },
        files: new Map(need.seedFiles),
        rows,
        memory: { store: `cagt_${ulid('NEWMEM', n)}`, memories: [] },
        created: true,
        wakes: [], // settings changes its own Claude was woken with
        interrupted: 0, // times a pause cut that Claude short
      });

      return json(200, { channel: record });
    }

    let m = p.match(/^\/v1\/code\/channels\/([^/]+)$/);
    if (m) {
      const st = channels.get(m[1]);
      if (!st) return v1Error(404, 'Channel not found');

      if (method === 'GET') {
        return json(200, { channel: { ...st.record, members: [], read_state: {} } });
      }

      if (method === 'PATCH') {
        const b = jsonBody(init) || {};
        for (const key of Object.keys(b)) {
          if (!['name', 'topic', 'icon', 'color', 'context_sources', 'clear_context_sources', 'disabled'].includes(key)) {
            return v1Error(400, 'Request validation failed', `${key}: unknown field`);
          }
        }
        if (b.name !== undefined) st.record.name = b.name;
        if (b.topic !== undefined) {
          if (b.topic !== st.record.topic) wake(st, 'topic');
          st.record.topic = b.topic;
        }
        if (b.icon !== undefined) st.record.icon = b.icon;
        if (b.color !== undefined) st.record.color = b.color;
        if (b.context_sources !== undefined) {
          if (!Array.isArray(b.context_sources) || !b.context_sources.every(c => c && typeof c.url === 'string')) {
            return v1Error(400, 'Request validation failed', 'context_sources: invalid');
          }
          st.record.context_sources = b.context_sources;
        }
        if (b.clear_context_sources === true) st.record.context_sources = [];
        if (b.disabled !== undefined) {
          // Pausing stops the project's Claude in the middle of whatever
          // the settings changes had it doing.
          if (b.disabled && !st.record.disabled_at && st.created && st.wakes.length) st.interrupted++;
          st.record.disabled_at = b.disabled ? stamp(99999) : null;
        }
        return json(200, { channel: st.record });
      }

      return v1Error(405, 'Method not allowed');
    }

    m = p.match(/^\/v1\/code\/channels\/([^/]+)\/config$/);
    if (m) {
      const st = channels.get(m[1]);
      if (!st) return v1Error(404, 'Channel not found');

      if (method === 'GET') return json(200, { config: st.config });

      if (method === 'PATCH') {
        const b = jsonBody(init) || {};
        for (const [key, value] of Object.entries(b)) {
          const base = key.replace(/^clear_/, '');
          if (!CONFIG_KEYS.has(base)) return v1Error(400, 'Request validation failed', `${key}: unknown field`);
          if (key.startsWith('clear_')) continue;
          if (/model$/.test(key) && !need.models.has(value)) {
            return v1Error(400, 'Request validation failed', `${key}: unknown model`);
          }
          if (/effort_level$/.test(key) && !EFFORTS.has(value)) {
            return v1Error(400, 'Request validation failed', `${key}: unknown effort level`);
          }
          if (key === 'default_source_urls' && !(Array.isArray(value) && value.every(v => /^https:\/\//.test(v)))) {
            return v1Error(400, 'Repository is not reachable', 'project_repo_unreachable');
          }
          // Browser access for the agent is a grant, not a plain setting.
          if (key === 'allow_worker_chrome' && value === true) {
            return json(403, { error: { message: 'Browser access has not been granted', reason: '', type: 'permission_error' }, request_id: REQUEST_ID, type: 'error' });
          }
        }
        for (const [key, value] of Object.entries(b)) {
          if (key.startsWith('clear_')) {
            delete st.config[key.slice(6)];
          } else {
            if (JSON.stringify(st.config[key]) !== JSON.stringify(value)) wake(st, key);
            st.config[key] = value;
          }
        }
        return json(200, { config: st.config });
      }

      return v1Error(405, 'Method not allowed');
    }

    // ---- timeline
    m = p.match(/^\/v1\/code\/channels\/([^/]+)\/timeline$/);
    if (m && method === 'GET') {
      const st = channels.get(m[1]);
      if (!st) return v1Error(404, 'Channel not found');
      const { limit, refused } = limitOf(q, 200, 50);
      if (refused) return refused;

      const boundOnly = q.get('bound_only') === 'true';
      const rootsOnly = q.get('thread_roots_only') === 'true';
      const filtered = boundOnly || rootsOnly;

      // Newest first. The filtered views walk every root, hidden ones too.
      const every = st.rows || world.everyRoot;
      const shown = st.rows ? st.rows.filter(r => r.in_timeline !== false) : world.roots;
      const feed = (filtered ? every : shown).slice().reverse();
      const start = feedIndex(q.get('cursor'));
      const { slice, end, more } = page(feed, limit, start, e => e < feed.length);

      const data = filtered
        ? slice.filter(row =>
            boundOnly
              ? row.bound_sessions.length > 0
              : row.bound_sessions.length > 0 || Number(row.reply_count) > 0
          )
        : slice;

      return json(200, more ? { data, next_cursor: feedCursor(end) } : { data });
    }

    // ---- threads
    m = p.match(/^\/v1\/code\/channels\/([^/]+)\/threads\/([^/]+)$/);
    if (m && method === 'GET') {
      const st = channels.get(m[1]);
      if (!st) return v1Error(404, 'Channel not found');
      const { limit, refused } = limitOf(q, 200, 50);
      if (refused) return refused;

      let rows;
      if (st.rows) {
        const root = st.rows.find(r => r.id === m[2]);
        if (!root) return v1Error(404, 'Thread not found');
        rows = [root];
      } else {
        const rootId = world.owner.get(m[2]);
        if (!rootId) return v1Error(404, 'Thread not found');
        rows = world.threads.get(rootId) || [world.everyRoot.find(r => r.id === rootId)];
      }

      const start = feedIndex(q.get('cursor'));
      const { slice, end, more } = page(rows, limit, start, e => e < rows.length);

      return json(200, more ? { data: slice, next_cursor: feedCursor(end) } : { data: slice });
    }

    // ---- project files
    m = p.match(/^\/v1\/code\/channels\/([^/]+)\/files\/usage$/);
    if (m && method === 'GET') {
      const st = channels.get(m[1]);
      if (!st) return v1Error(404, 'Channel not found');
      return json(200, {
        enforced: true,
        limit_bytes: '10737418240',
        limit_file_bytes: '524288000',
        limit_files: '50000',
        used_bytes: String([...st.files.values()].reduce((n, b) => n + b.length, 0)),
        // Folders are counted too.
        used_files: String(st.files.size + foldersOf(st.files.keys()).size),
      });
    }

    m = p.match(/^\/v1\/code\/channels\/([^/]+)\/files:(list|open|write)$/);
    if (m && method === 'POST') {
      const st = channels.get(m[1]);
      if (!st) return v1Error(404, 'Channel not found');
      const b = jsonBody(init) || {};

      if (m[2] === 'list') {
        const limit = b.limit === undefined ? 100 : b.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
          return v1Error(400, 'Request validation failed', 'limit: must be greater than or equal to 1 and less than or equal to 500');
        }

        // Files and the folders that hold them, in path order.
        const entries = [];
        const folders = new Set();
        for (const path of [...st.files.keys()].sort()) {
          const parts = path.split('/');
          for (let i = 1; i < parts.length; i++) {
            const folder = parts.slice(0, i).join('/');
            if (folders.has(folder)) continue;
            folders.add(folder);
            entries.push({ path: folder, is_directory: true, created_at: stamp(1) });
          }
          entries.push({ path, is_directory: false, size_bytes: String(st.files.get(path).length), created_at: stamp(2) });
        }

        const visible = b.recursive === true ? entries : entries.filter(e => !e.path.includes('/'));
        const size = Math.min(limit, need.filesPageSize);
        const start = b.cursor ? Number(b.cursor) : 0;
        const slice = visible.slice(start, start + size);
        const end = start + slice.length;

        return json(200, { entries: slice, cursor: end < visible.length ? String(end) : '' });
      }

      if (m[2] === 'open') {
        const bytes = st.files.get(b.path);
        if (!bytes) return notFoundFile();

        const filename = String(b.path).split('/').pop();
        const common = { filename, kind: 'file', size_bytes: String(bytes.length) };

        if (b.range_offset !== undefined || b.range_length !== undefined) {
          const offset = Number(b.range_offset) || 0;
          const length = Number(b.range_length);
          if (!Number.isInteger(length) || length < 0 || length > 25165824) {
            return v1Error(400, 'Request validation failed', 'range_length: must be between 0 and 25165824');
          }
          return json(200, {
            ...common,
            type: 'download',
            mime_type: 'application/octet-stream',
            data: bytes.subarray(offset, offset + length).toString('base64'),
            content_revision: need.revisionOf ? need.revisionOf(b.path, offset) : `rev-${bytes.length}`,
          });
        }

        return isText(bytes)
          ? json(200, { ...common, type: 'text', format: 'plain', content: bytes.toString('utf8') })
          : json(200, { ...common, type: 'download', mime_type: 'application/octet-stream', data: bytes.toString('base64') });
      }

      // files:write
      if (!Array.isArray(b.files) || b.files.length === 0) {
        return v1Error(400, 'Request validation failed', 'files: must not be empty');
      }
      if (b.files.length > 10) {
        return v1Error(400, 'Request validation failed', 'files: must contain at most 10 items');
      }
      // Word for word what the live API answered for a paused project.
      if (st.record.disabled_at) return v1Error(400, 'this project is paused', 'channel_disabled');

      const taken = new Set();

      const results = b.files.map(f => {
        if (!validPath(f?.path)) return { path: f?.path, error_reason: 'invalid_path' };

        const nthTry = (writeTries.get(f.path) || 0) + 1;
        writeTries.set(f.path, nthTry);
        const forced = need.writeReason ? need.writeReason(f.path, nthTry) : '';
        if (forced) return { path: f.path, error_reason: forced };

        if (taken.has(f.path)) return { path: f.path, error_reason: 'duplicate_destination' };
        taken.add(f.path);
        if (f.path === 'uploads/hearth' || f.path.startsWith('uploads/hearth/')) {
          return { path: f.path, error_reason: 'project_file_path_reserved' };
        }

        // A file id is tagged like the channel it is for: same middle part.
        const middle = m[1].split('_').slice(1, -1).join('_');
        const wellTagged = typeof f.source_file_id === 'string' &&
          f.source_file_id.split('_').slice(1, -1).join('_') === middle;
        const upload = wellTagged ? uploads.get(uuidFromTaggedId('file', f.source_file_id)) : null;
        if (!upload) return { path: f.path, error_reason: 'source_file_unavailable' };
        // Stored as extracted text rather than as the file itself: not usable.
        if (!upload.asIs) return { path: f.path, error_reason: 'source_file_unavailable' };

        if (st.files.has(f.path) && f.overwrite !== true) {
          return { path: f.path, error_reason: 'project_file_write_rejected' };
        }
        if (!st.files.has(f.path) && st.files.size >= need.storageFiles) {
          return { path: f.path, error_reason: 'project_files_storage_limit' };
        }

        st.files.set(f.path, upload.bytes);
        return {
          entry: { created_at: stamp(3), is_directory: false, path: f.path, size_bytes: String(upload.bytes.length) },
          path: f.path,
        };
      });

      return json(200, { results });
    }

    // ---- a project's Auto memory, by the project's own route
    m = p.match(/^\/v1\/code\/memory\/channel\/([^/]+)\/memories(?:\/([^/]+))?$/);
    if (m && (method === 'GET' || (method === 'POST' && !m[2]))) {
      if (need.noChannelMemory) return v1Error(404, 'Not Found');
      const betas = String(headers['anthropic-beta'] || '').split(',').map(b => b.trim());
      if (need.channelMemoryBeta && !betas.includes(MEMORY_BETA)) {
        return v1Error(400, `anthropic-beta: ${MEMORY_BETA} is required`, 'beta_required');
      }

      const holder = channels.get(m[1]);
      if (!holder) return v1Error(404, 'Channel not found');
      const memories = holder.memory ? holder.memory.memories : [];

      // A new memory, in the memory API's documented shape: { path,
      // content }, the path starting with a slash, one memory per path,
      // with the precondition claude.ai asks a browser for.
      if (method === 'POST') {
        if (need.noMemoryWrites) return v1Error(404, 'Not Found');

        const body = jsonBody(init);
        const given = body && Object.prototype.hasOwnProperty.call(body, 'precondition');
        if (need.noMemoryPrecondition) {
          if (given) return v1Error(400, 'precondition: Extra inputs are not permitted');
        } else if (!given) {
          return v1Error(400, MEMORY_PRECONDITION_REQUIRED);
        } else {
          const takes = need.memoryPrecondition(body.precondition);
          if (takes === 'failed') {
            return json(409, {
              error: { message: 'The precondition does not hold', type: 'memory_precondition_failed_error' },
              request_id: REQUEST_ID,
              type: 'error',
            });
          }
          if (!takes) {
            const kinds = need.memoryPreconditionKinds;
            return v1Error(400, kinds
              ? `precondition.type: expected one of ${kinds.map(k => `'${k}'`).join(', ')}`
              : 'precondition: not a precondition this route takes');
          }
        }

        if (typeof body?.path !== 'string' || !body.path.startsWith('/') || typeof body.content !== 'string') {
          return v1Error(400, 'Request validation failed', 'path: must start with "/"');
        }
        if (Buffer.byteLength(body.content) > 100 * 1024) {
          return v1Error(413, 'Memory content is too large', 'memory_too_large');
        }

        const there = memories.find(x => x.path === body.path);
        if (there) {
          return json(409, {
            error: { message: `A memory already exists at ${body.path}`, type: 'memory_path_conflict_error', conflicting_memory_id: there.id },
            request_id: REQUEST_ID,
            type: 'error',
          });
        }

        const memory = {
          id: `mem_${ulid('NEWMEM', ++serial)}`,
          path: body.path,
          content: body.content,
          created_at: stamp(400 + serial),
          updated_at: stamp(400 + serial),
        };
        memories.push(memory);
        return json(200, { type: 'memory', ...memory, content_size_bytes: Buffer.byteLength(memory.content) });
      }

      if (m[2]) {
        const memory = memories.find(x => x.id === m[2]);
        if (!memory) return v1Error(404, 'Memory not found');
        return json(200, { ...memory, size_bytes: String(Buffer.byteLength(memory.content)) });
      }

      const limit = Number(q.get('limit') || 20);
      const cursor = q.get('cursor');
      const start = cursor === null ? 0 : Number(String(cursor).replace(/^mcur_/, ''));
      if (!Number.isInteger(start) || start < 0 || !Number.isInteger(limit) || limit < 1) {
        return v1Error(400, 'Request validation failed', 'cursor: invalid');
      }

      const slice = memories.slice(start, start + Math.min(limit, need.memoryPageSize));
      const end = start + slice.length;
      const more = end < memories.length;

      return json(200, {
        data: slice.map(({ content, ...rest }) =>
          (need.noMemorySizes ? rest : { ...rest, size_bytes: String(Buffer.byteLength(content)) })),
        has_more: more,
        next_cursor: more ? `mcur_${end}` : null,
      });
    }

    // ---- memory stores: a project's Auto memory, as Claude Code reads it
    m = p.match(/^\/v1\/memory_stores\/([^/]+)\/memories(?:\/([^/]+))?$/);
    if (m && method === 'GET') {
      const betas = String(headers['anthropic-beta'] || '').split(',').map(b => b.trim());
      if (q.get('beta') !== 'true' || !betas.includes(MEMORY_BETA)) {
        return v1Error(400, `anthropic-beta: ${MEMORY_BETA} is required`, 'beta_required');
      }

      const holder = [...channels.values()].find(c => c.memory && c.memory.store === m[1]);
      if (!holder) return v1Error(404, 'Memory store not found');
      const { memories } = holder.memory;

      if (m[2]) {
        const memory = memories.find(x => x.id === m[2]);
        if (!memory) return v1Error(404, 'Memory not found');
        return json(200, { type: 'memory', ...memory, size_bytes: String(Buffer.byteLength(memory.content)) });
      }

      if (need.refuseMemories) {
        return json(403, {
          error: { message: 'This memory store cannot be read here', reason: 'memory_store_forbidden', type: 'permission_error' },
          request_id: REQUEST_ID,
          type: 'error',
        });
      }

      // The list leaves each memory's text out; it pages by a token.
      const token = q.get('page');
      const start = token === null ? 0 : Number(String(token).replace(/^mpage_/, ''));
      if (!Number.isInteger(start) || start < 0) return v1Error(400, 'Request validation failed', 'page: invalid');

      const slice = memories.slice(start, start + need.memoryPageSize);
      const end = start + slice.length;
      const more = end < memories.length;

      return json(200, {
        data: slice.map(({ content, ...rest }) => ({ type: 'memory', ...rest, size_bytes: String(Buffer.byteLength(content)) })),
        has_more: more,
        next_page: more ? `mpage_${end}` : null,
      });
    }

    // ---- sessions
    m = p.match(/^\/v1\/code\/sessions\/((?:cse|session)_[0-9A-Za-z]+)(\/events)?$/);
    if (m && method === 'GET') {
      const session = world.sessions.get(m[1].slice(m[1].indexOf('_') + 1));
      if (!session) return v1Error(404, 'Session not found');

      if (!m[2]) {
        return json(200, {
          response_shape: {
            id: session.id,
            title: session.title,
            created_at: session.created_at,
            status: 'active',
            session_url: `https://claude.ai/code/${session.id.replace('cse_', 'session_')}`,
            config: { model: 'claude-test-model', sources: [] },
            tags: ['hearth-thread'],
          },
        });
      }

      const { limit, refused } = limitOf(q, 500, 100);
      if (refused) return refused;

      const desc = q.get('sort_order') === 'desc';
      const total = session.events;
      const cursor = q.has('cursor') ? Number(q.get('cursor')) : desc ? total + 1 : 0;

      const seqs = [];
      for (let i = 0; i < limit; i++) {
        const seq = desc ? cursor - 1 - i : cursor + 1 + i;
        if (seq < 1 || seq > total) break;
        seqs.push(seq);
      }

      const last = seqs[seqs.length - 1];
      const moreExists = seqs.length > 0 && (desc ? last > 1 : last < total);
      const more = need.cursorOnFullPage ? seqs.length === limit : moreExists;

      return json(200, {
        data: seqs.map(seq => makeEvent(session.id, seq)),
        ...(more ? { next_cursor: String(last) } : {}),
        resume_cursor: String(seqs.length ? Math.max(...seqs) : cursor),
      });
    }

    return v1Error(404, 'Not found');
  }

  // ---- /api/ (cookie only, organization in the path)
  function chat(id) {
    const n = CHATS.indexOf(id) + 1;
    return {
      uuid: id,
      name: 'Pasta: basics?', // the same title on both chats, on purpose
      created_at: '2026-08-01T10:00:00Z',
      current_leaf_message_uuid: `m${n}-3`,
      chat_messages: [
        {
          uuid: `m${n}-1`,
          sender: 'human',
          created_at: '2026-08-01T10:00:00Z',
          parent_message_uuid: null,
          content: [{ type: 'text', text: `How do I cook pasta? (${n})` }],
          attachments: [{ file_name: 'pantry.txt', extracted_content: 'flour\neggs' }],
          files: [chatFile('f1')],
        },
        {
          uuid: `m${n}-2`,
          sender: 'assistant',
          created_at: '2026-08-01T10:00:05Z',
          parent_message_uuid: `m${n}-1`,
          content: [{ type: 'text', text: 'An abandoned branch.' }],
        },
        {
          uuid: `m${n}-3`,
          sender: 'assistant',
          created_at: '2026-08-01T10:00:09Z',
          parent_message_uuid: `m${n}-1`,
          content: [
            {
              type: 'text',
              text: 'Boil water, add salt.',
              citations: [{ url: 'https://example.com/pasta', title: 'Pasta 101' }],
            },
            { type: 'tool_use', name: 'artifacts', input: { id: 'recipe', command: 'create', title: 'Recipe', type: 'text/markdown', content: '# Pasta\n\nBoil.' } },
            { type: 'tool_use', name: 'artifacts', input: { id: 'recipe', command: 'update', old_str: 'Boil.', new_str: 'Boil 9 minutes.' } },
            { type: 'tool_use', name: 'create_file', input: { path: '/mnt/user-data/outputs/shopping.txt', content: 'pasta\nsalt' } },
          ],
        },
      ],
    };
  }

  async function api(url, headers, init) {
    const p = url.pathname;
    const method = (init?.method || 'GET').toUpperCase();

    if (p === '/api/organizations' && method === 'GET') {
      return json(200, [
        { uuid: ORG_CHAT, name: 'Personal', capabilities: ['claude_max', 'chat'] },
        { uuid: ORG_API, name: 'Individual Org', capabilities: ['api', 'api_individual', 'customer_terms:standard'] },
      ]);
    }

    // The organization-wide upload the project-file writer goes through.
    let m = p.match(/^\/api\/([0-9a-f-]{36})\/upload$/);
    if (m && method === 'POST') {
      if (m[1] !== ORG_CHAT) {
        return apiError(403, 'permission_error', 'Invalid authorization for organization');
      }
      const file = await formFile(init);
      if (!file) return apiError(400, 'invalid_request_error', 'file: field required');

      const asIs = url.searchParams.get('store_as_is') === 'true';
      const uuid = fakeUuid(`upload-${++serial}`);
      const kind = kindOf(file) === 'image' ? 'image' : asIs ? 'blob' : 'document';
      uploads.set(uuid, { ...file, asIs });
      stored.set(uuid, { name: file.name, kind, bytes: file.bytes });

      return json(200, {
        ...fileRecord(uuid, stamp(80000 + serial)),
        // The name comes back tidied; where the file goes is said elsewhere.
        file_name: file.name.replace(/[():"<>|?*]/g, ''),
        // Without store_as_is the server keeps the text of a document, not the document.
        ...(!asIs && kind !== 'image' && { text_extracted: true }),
      });
    }

    // The copies Claude made of an uploaded file. Note the path: these have
    // no "organizations" in it, and the upload itself is not among them.
    m = p.match(/^\/api\/([0-9a-f-]{36})\/files\/([^/]+)\/(preview|thumbnail|document_pdf)$/);
    if (m && method === 'GET') {
      const file = m[1] === ORG_CHAT ? stored.get(m[2]) : null;
      if (file && file.kind === 'document' && m[3] === 'document_pdf') {
        return new Response(file.bytes, { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
      if (file && (m[3] === 'thumbnail' || (file.kind === 'image' && m[3] === 'preview'))) {
        return new Response(previewOf(file.name), { status: 200, headers: { 'content-type': 'image/webp' } });
      }
      return apiError(404, 'not_found_error', 'Not found');
    }

    m = p.match(/^\/api\/organizations\/([^/]+)(\/.*)$/);
    if (!m) return apiError(404, 'not_found_error', 'Not found');
    const [, org, rest] = m;

    if (org !== ORG_CHAT) {
      return apiError(403, 'permission_error', 'Invalid authorization for organization', {
        details: { error_visibility: 'user_facing' },
      });
    }

    const b = method === 'GET' ? null : jsonBody(init);

    // ---- projects: list and create
    if (rest === '/projects' && method === 'GET') {
      return json(200, [
        { uuid: PROJECT, name: 'Recipes' },
        { uuid: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Tax notes' },
        ...[...projects.values()].map(x => ({ uuid: x.project.uuid, name: x.project.name })),
      ]);
    }

    if (rest === '/projects' && method === 'POST') {
      if (!b || typeof b.name !== 'string' || !b.name.trim()) {
        return apiError(400, 'invalid_request_error', 'name: field required');
      }
      const uuid = fakeUuid(`project-${++serial}`);
      const project = {
        uuid,
        name: b.name,
        description: typeof b.description === 'string' ? b.description : '',
        prompt_template: typeof b.prompt_template === 'string' ? b.prompt_template : '',
        is_private: b.is_private !== false,
        is_starred: b.is_starred === true,
        created_at: stamp(80000 + serial),
        archived_at: null,
      };
      projects.set(uuid, { project, docs: [], files: [], blobs: new Map(), memory: '' });
      return json(201, project);
    }

    // ---- the fixture project
    if (rest === `/projects/${PROJECT}` && method === 'GET') {
      return json(200, { uuid: PROJECT, name: 'Recipes', prompt_template: 'Be a patient cook.', description: 'Family recipes', is_private: true });
    }
    if (rest === '/memory' && method === 'GET') {
      const made = projects.get(url.searchParams.get('project_uuid'));
      return json(200, { memory: made ? made.memory : 'Prefers metric units.' });
    }
    if (rest === `/projects/${PROJECT}/docs` && method === 'GET') {
      return json(200, [
        { uuid: 'd1', file_name: 'notes.md', content: '# Notes\n\nSalt the water.' },
        // Text taken from a file that is not itself text.
        { uuid: 'd2', file_name: 'grandma-letter.docx', content: 'Dear all,\nuse more butter.' },
      ]);
    }
    if (rest === `/projects/${PROJECT}/files` && method === 'GET') {
      return json(200, [fileRecord('f9'), fileRecord('f8')]);
    }

    // An uploaded file itself, exactly as it was uploaded. The reply names
    // the file and gives no content type.
    let c = rest.match(/^\/files\/([^/]+)\/contents$/);
    if (c && method === 'GET') {
      const file = stored.get(c[1]);
      const hidden = need.noContents === true || (typeof need.noContents === 'function' && need.noContents(c[1]));
      if (!file || hidden) return apiError(404, 'not_found_error', 'Not found');
      return new Response(file.bytes, {
        status: 200,
        headers: { 'content-disposition': `attachment; filename*=utf-8''${encodeURIComponent(file.name)}` },
      });
    }
    if (rest === `/projects/${PROJECT}/conversations` && method === 'GET') {
      return json(200, CHATS.map(uuid => ({ uuid, name: 'Pasta: basics?' })));
    }

    c = rest.match(/^\/chat_conversations\/([^/]+)$/);
    if (c && CHATS.includes(c[1]) && method === 'GET') return json(200, chat(c[1]));

    c = rest.match(/^\/conversations\/([^/]+)\/wiggle\/(list-files|download-file)$/);
    if (c && CHATS.includes(c[1]) && method === 'GET') {
      if (c[2] === 'list-files') {
        return json(200, {
          files_metadata: [
            { path: '/mnt/user-data/uploads/in.csv' },
            { path: '/mnt/user-data/outputs/report.md' },
          ],
        });
      }
      return new Response(`contents of ${url.searchParams.get('path')}`, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }

    // ---- projects made by an import
    c = rest.match(/^\/projects\/([^/]+)(\/docs|\/files|\/upload|\/conversations)?$/);
    const made = c && projects.get(c[1]);
    if (made) {
      if (!c[2] && method === 'GET') return json(200, made.project);

      if (!c[2] && method === 'PUT') {
        if (!b) return apiError(400, 'invalid_request_error', 'body: invalid JSON');
        for (const key of Object.keys(b)) {
          if (!['name', 'description', 'prompt_template', 'is_private', 'is_starred', 'archived_at'].includes(key)) {
            return apiError(400, 'invalid_request_error', `${key}: extra fields not permitted`);
          }
        }
        Object.assign(made.project, b);
        return json(202, made.project);
      }

      if (c[2] === '/docs' && method === 'GET') return json(200, made.docs);

      if (c[2] === '/docs' && method === 'POST') {
        if (!b || typeof b.file_name !== 'string' || !b.file_name.trim() || typeof b.content !== 'string') {
          return apiError(400, 'invalid_request_error', 'file_name and content: fields required');
        }
        const doc = { uuid: fakeUuid(`doc-${++serial}`), file_name: b.file_name, content: b.content, created_at: stamp(80000 + serial) };
        made.docs.push(doc);
        return json(201, doc);
      }

      if (c[2] === '/files' && method === 'GET') return json(200, made.files);

      if (c[2] === '/upload' && method === 'POST') {
        const file = await formFile(init);
        if (!file) return apiError(400, 'invalid_request_error', 'file: field required');
        const uuid = fakeUuid(`pfile-${++serial}`);
        made.blobs.set(uuid, file);
        stored.set(uuid, { name: file.name, kind: kindOf(file), bytes: file.bytes });
        const record = fileRecord(uuid, stamp(80000 + serial));
        made.files.push(record);
        return json(200, record);
      }

      if (c[2] === '/conversations' && method === 'GET') return json(200, []);
    }

    return apiError(404, 'not_found_error', 'Not found');
  }

  async function server(url, headers, init) {
    const isV1 = url.pathname.startsWith('/v1/');
    const nth = (hits.byPath.get(url.pathname) || 0) + 1;
    hits.byPath.set(url.pathname, nth);

    if (need.fault && (isV1 || need.faultEverywhere)) {
      const forced = need.fault(url, headers, nth, init);
      if (forced) {
        if (isV1) hits[forced.ok ? 'v1Ok' : 'v1Refused']++;
        return forced;
      }
    }

    if (isV1) {
      const res = await v1(url, headers, init);
      if (res.ok) hits.v1Ok++;
      else hits.v1Refused++;
      return res;
    }
    return api(url, headers, init);
  }

  return { server, hits, world, need, state, PROJECT, CHATS, MENU_PDF, KITCHEN_PNG, PHOTO_PNG, previewOf };
}

module.exports = {
  makeServer, makeEvent, v1Error, apiError, uuidFromTaggedId,
  ORG_CHAT, ORG_API, CHANNEL, OTHER_CHANNEL, ME, SOMEONE, AGENT, MEMORY_STORE, MEMORY_BETA,
  MEMORY_PRECONDITION_REQUIRED,
};
