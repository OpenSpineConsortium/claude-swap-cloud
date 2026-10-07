# Claude Swap Cloud (claude-swap-cloud)

`cswap`: a multi-account switcher for Claude Code, with the cloud added
(claude.ai Projects and cloud sessions move between accounts). The
distribution is `claude-swap-cloud`, the module `claude_swap` and the
command `cswap`; it is a fork of realiti4/claude-swap, which stays on PyPI
as `claude-swap`. Python 3.12+, hatchling,
standard library only (plus what pyproject lists). The package is
`src/claude_swap`; tests are under `tests/` (pytest, `pythonpath=src`,
parallel by default) with the browser-side JavaScript under `tests/js`
(Node 24, `node:test`). The Chrome extension that imports a claude.ai
Project without a paste is under `extension/`, plain ES modules with no
build step.

## Layout

- `cli.py`: every subcommand; `run`, `teleport`, `auto`, `project-move`,
  `bridge` and `checkpoint` are pre-dispatched before the flag parser.
- `switcher.py` (slots, `resolve_account`), `session.py` (`launch_env`),
  `settings.py`, `locking.py`, `paths.py`: the account registry and its
  surroundings. Nothing outside them reads credentials.
- `project_move.py` + `browser/project-export.js`, `browser/project-import.js`:
  moving a claude.ai Project between accounts with two console scripts and a
  folder (or a `.tar`) in between.
- `bridge.py`: the native-messaging host (`cswap bridge`), the job files
  under `<backup dir>/bridge/`, the export source, install and status, the
  command-line side of an import through the extension, and the export
  jobs a Duplicate runs (`accounts.list`, `export.new`, `export.choose`,
  `file.write`, whose `written` answer names the export's .tar as
  `export_path` and which, for an export the Save As window placed,
  appends each file as a member of that one .tar as its pieces arrive
  (`_write_archive_piece`, `_seal_archive` at the end), `import.queue`,
  with `signed_in` for an import into whoever is signed in, which answers
  a second ask for the same export with the import already queued, by the
  export job or, for an export opened in the Open window, by the window's
  id, `dialog`, `queue_import_of_dialog`, which takes the export the
  window's choice names, a .tar, a folder, or the `export.json` inside
  one; `export_path` and `exports.list` stay for older panels), the file
  windows (`dialog.open`, `dialog.state`, `dialog.close`: `open_dialog`,
  `dialog_state`, `close_dialog`, capability `dialogs`, and the hello's
  `source`, where this cswap was installed from as the installer's
  `direct_url.json` records it, which `cswap bridge status` prints too,
  since two installs can share a version number; the window is the
  computer's own, started by `file_dialogs.py` as a subprocess whose
  answer the bridge reads from its files, recorded in `bridge/dialog.json`
  with `last_dir`, the folder the last one used, the one thing
  remembered; Chrome's `--parent-window` owns the window to the browser),
  and the import of a Duplicate in a window of its own (`import.driven` and
  `import.driven.state`: `driven_command`, `start_driven_import`,
  `note_driven_end`, `driven_state`, `drop_driven`), and the side panel's
  end of a job another browser profile holds (`job.drop`, `drop_job`,
  capability `drop`).
- `extension/`: the Manifest V3 extension (`src/background.js` the worker,
  `src/page.js` the page helper that runs the unchanged import or export
  script and is the folder an export writes into, `src/duplicate.js` the
  Duplicate's pure pieces, `src/gate.js` the request gate, `src/interrupt.js`
  the stop-and-tell rules, `src/config.js`, `src/log.js`, `src/native.js`,
  `src/content.js`, `src/sidepanel.js`, `src/protocol.js` the shared names).
- `extension/scripts/package.mjs` (the Chrome Web Store zip, without the
  manifest's `key`), `.github/workflows/release.yml` (a push to `main`
  that changes the zip, or a tag `extension-v<version>`, builds it and
  makes the GitHub release, the repository's latest, with the zip under
  its versioned name and as `claude-swap-cloud-chrome.zip`, which README.md
  links through `releases/latest/download/`; the store upload of that
  same zip waits on the repository variable `CWS_ON_PUSH`, except for a
  tag, which always uploads; a push is numbered `<manifest>.<commit
  count>`), which is one call of the release kit, `release-kit/` with
  `.github/workflows/release-kit.yml` (the same machinery for any Chrome
  extension repository: the reusable workflow, the package action
  `release-kit/action.yml` with `lib.mjs`, the generic packager
  `package.mjs` and `stamp.mjs`, the store action `release-kit/store/`
  with `publish.mjs`, the upload and the submit through the store's API
  from `CWS_` environment variables; `caller.yml` is the workflow a new
  repository pastes, README.md there the instructions; nothing in the
  folder names this extension, so it can move to a repository of its own;
  its tests under `release-kit/tests/`, run by pytest too),
  `extension/store-assets/` (the store
  images, drawn from the real side panel), `docs/store/` (listing,
  submission, hand test) and `PRIVACY.md`: the store side. Not loaded by
  Chrome and not in the wheel. `extension/src/setup.js` is the panel's
  checklist of what a computer still needs, with the line to type for
  each; its install lines name this repository, not the upstream
  claude-swap on PyPI.
- `scripts/build_public_wheel.py` + `.github/workflows/publish.yml`: how
  the public will get cswap without the source. A tag `v<version>` (equal
  to pyproject's version) builds the plain wheel, turns it into one wheel
  per Python version with every module compiled to a hash-based `.pyc` in
  its place, the extension's code taken minified from the store zip, no
  `.py` and no sdist, checks that it installs and runs, and publishes
  through PyPI's trusted publishing (environment `pypi`, no token). It
  refuses a wheel that still carries the browser scripts
  (`claude_swap/browser/*.js`): greg decided on 2026-10-07 that the export
  and import logic moves into cswap before anything is published, so until
  then no publish can succeed. Tests in `tests/test_public_wheel.py`.
- `project_move_auto.py` (with `_project_move_auto` in `cli.py`): `cswap
  project-move auto`, the move in browser windows cswap drives on profiles
  of its own; `--export PATH` imports an export already made, and the
  hidden `--bridge-job ID` is the host starting that for a Duplicate,
  which keeps the run's output in `bridge/driven-<job>.log` and records
  how it ended on the export job.
- `handoff.py` + `teleport.py`: moving a cloud session to another account
  with a handoff note; `checkpoint.py`: `.claude/session.md` and the marker
  section of this file, rendered from the local transcript.

## Conventions

- Plain prose comments that say why; short functions; names that read as
  English. No emoji in code, output or docs.
- Files under `src/claude_swap/browser` and `extension/` are plain ASCII
  with LF endings; prefer ASCII elsewhere.
- Every JS module takes its clock, timers, storage, notifier and ports as
  arguments; production wiring lives only in the last lines of each file.
  `page.js` and `content.js` are classic scripts with literal copies of the
  protocol constants; tests hold the copies equal to `protocol.js`.
- Tests are deterministic and fast: inject clocks and timers, open no
  socket. Python tests under `tests/`, JS tests under `tests/js/extension/
  <module>.test.js`, runnable with `node --test <file>`. Node 24 takes files,
  not a bare folder: use `node --test "tests/js/extension/*.test.js"`.
- README.md is the user documentation; keep it in the project's voice.

## Decisions (the import side: extension, bridge, checkpoint)

- The import script runs unchanged, injected into Chrome's `USER_SCRIPT`
  world by `chrome.userScripts.execute()` after `page.js`, as text handed
  over by the bridge. The world is one constant (`WORLD` in `protocol.js`).
  The export script runs the same way for a Duplicate, also unchanged.
- Duplicate is the existing pieces in a row, behind three buttons in the
  side panel (greg, 2026-10-07: "export, logout&refresh, import & type
  name"; as few buttons as reasonably possible). The three stay in one
  place and are always live, under the numbered steps: Export this
  project, Sign out and reload, then the Import block (the name) with
  Import (greg, 2026-10-07: "i dont want any dynamic changes to the
  button layout, the user should always be able to click export, or
  import, or logout"); no view says whether to offer one, the worker
  answers a press at the wrong moment with why (`busyText`, which names
  an open Save As or Open window first), and Import takes any export on
  disk at any time, so a move is picked up at any step. Nothing is
  chosen for the person in the panel (greg, 2026-10-07: "when you click
  export this project, it automatically assumes you want to export the
  claude project currently open in your tab and opens the file explorer
  save as window / and when you click import it automatically assumes
  you want to import a project into the currently signed in account and
  also opens the file explorer "open" explorer / dont try and do anything
  fancy with automatically choosing the project for the user except for
  maybe trying to remember which directory the export last went into"):
  the windows are the computer's own, opened by the bridge, and the one
  memory is the folder the last window used. **Export this project**:
  the tab must show the project (`isProjectUrl`: `claude.ai/project/...`
  or `claude.ai/code/project/...`, else `NOT_ON_A_PROJECT_TEXT` and
  nothing starts), and the bridge's hello must list `dialogs` (else
  `NO_DIALOGS_TEXT` at the press, before any job: greg's PC on
  2026-10-07 ran a cswap twenty commits behind the extension with the
  same version number, and the export was taken and failed halfway; the
  panel's Setup lists such a cswap as a reinstall to make, `REINSTALL_LINES`
  in `setup.js`, and the three buttons answer under themselves,
  `dup-error`; Check now, `job.refresh`, reaches the bridge itself and
  answers under its button, `conn-answer`, with what answered and what to
  press next, `reachedText`, or why the bridge did not answer, and the
  Connection line tells idle from failed, `bridgeLine` in `sidepanel.js`,
  because the worker lets the host go whenever nothing is queued, which
  greg read as "not connected" on 2026-10-07); an export job (`kind:
  "export"`) reloads the tab, lists
  the signed-in account's projects with the export script's own requests
  (phase `choosing`, so the tab's project is named the way the site names
  it: its Claude Code projects with the script's `/v1/code/channels`
  request, every page of it by the `next_cursor` the answer names, at most
  `LIST_PAGES`, under one gate step key, the tab's own channel asked for by
  itself when the list leaves it out, only id, name, kind and archived
  leaving the page, with a tally `codeList`), chooses the tab's project on
  its own (`chooseDuplicate` with `drive: false`, no account to copy into:
  `export.choose` records none, and the registry is never read), waits in
  phase `placing` for the Save As window (`stepPlace`: `dialog.open` with
  the job, the window's id on `job.dialog` so a restarted worker follows
  the same one, `dialog.state` every `DIALOG_POLL_MS` through
  `followDialog`, whose wait a job's end cuts short; a choice puts the
  .tar on `job.export.path` with `archive: true`, the window closed
  without one ends the job cancelled with `SAVE_CANCELLED_TEXT`, a window
  that could not open fails it with the bridge's words, Cancel closes it
  with `dialog.close`, and a bridge without `dialogs` fails it with
  `NO_DIALOGS_TEXT`), then goes to the project's page and runs the export
  script there; every file goes to the bridge piece by piece
  (`file.write`, in order, each waited for) into that one .tar. A
  finished export is never handed over on its own (`finishJob`:
  `chaining` is always false); it notifies with `EXPORTED_NEXT_TEXT`.
  **Sign out and reload** (`signout`, `signOutTab`):
  content.js makes the site's own sign-out request (`POST
  /api/auth/logout`, the content script's one request ever, only at the
  click, its status alone read), then the tab goes to `claude.ai/login`
  for the person to sign in as the other account; when the site refuses,
  the answer names the page menu's Log out. **Import** (`duplicate.import`
  with an optional name; greg, 2026-10-07: no account chooser, "it should
  just import into whatever claude account i log into", and no list
  either, the Open window instead): `importChosenExport` drains the
  events on their way, sends a lost end of this browser's finished export
  again (`resendExportEnd`, so the export no longer holds the bridge's
  one place), opens the Open window (`dialog.open` with purpose `open`,
  `dialogOpen` while it is, `handingOver` `'file'`) and follows it; the
  window closed without a choice answers `OPEN_CANCELLED_TEXT` and
  nothing starts. The export just made (`samePath` with
  `job.export.path`) goes the hand-over's way, `retryHandOver('tab',
  { name })`, which queues the import through `import.queue` with the job
  id, `signed_in: true` and `name`; any other goes by the window,
  `import.queue` with `dialog`, and the bridge reads the export the
  window named (no path travels from the extension); the bridge queues
  the same import job the command line makes with no account named
  (`new_job(signed_in=True)`,
  `account.signed_in`), the page's identity check takes whichever account
  is signed in (`classifyIdentity` with `expected.signedIn`; a signed-out
  tab holds with Resume, a page that names no account asks for Confirm),
  the worker records the account found on the job and sends an `account`
  event the bridge applies (`noteSignedInAccount`, `update_from_event`),
  and from then on it is the job's account, checked like one named with
  `--to`; the panel's Progress line and `--watch` name it. The registry
  is read for nothing (`accounts.list` and a `destination` stay for older
  panels). Nothing is retried on its own; the panel keeps Import and the
  line to type (`--to NUM`) when the queue fails. The panel no longer offers the import in a
  window of its own, a project list to choose from, Pause, Retry, Give up
  (now Skip this step), List again, Carry on or Clear; the worker commands
  `duplicate.choose`, `duplicate.driven` and `duplicate.driven.refresh`
  stay, and a record an earlier version left is shown as it stands.
- The import in a window of its own is the command line's: `cswap
  project-move auto --export <folder> --to <slot> [--name=] [--into=]`,
  or the hidden `--bridge-job=<id>` the host starts detached on a request
  (`import.driven`, which the panel no longer sends) that carries only the
  job id: the host builds the argument list from `job.json`, with the name
  as one argument and no shell. The run writes how it ended into
  `job.json`; a record whose process is gone, too old, or another process
  with the same id does not count as running, and `project-move import
  --cancel` lets go of one whose window is gone. While one runs, no new
  job starts. A job another browser profile holds (an earlier copy of the
  extension, which a reinstall made a new instance of) blocks every job
  after it until a stop request has gone unanswered for fifteen minutes,
  so the panel's Connection section names it and offers Drop that job
  (`job.drop` with the id the person confirmed, capability `drop`;
  `elsewhereView`, `dropJobElsewhere`, which refuses a job that took its
  place meanwhile; a pickup that finds no such job clears the line,
  `forgetJobElsewhere`): the person's act, which ends it as cancelled by
  `extension`; it is never taken over, and this browser's own job has
  Cancel. The run records the project it made the moment the page names
  it (`note_driven_link`); Ctrl+C, Ctrl+Break and, off Windows, SIGTERM
  end it as a stop of the person's (exit 130) with the project kept. Every
  line to type puts a value after `--option=` (`bridge.typed_value`,
  `typedValue` in `duplicate.js`). Opening the panel on a finished export
  whose import never started asks the bridge once for the folder and a
  fresh hello (`catchUpDoneExport`).
- Events queued after an export's `done` never refuse it, and an event
  the host refuses for good (`FINAL_REFUSALS`, `not-claimed`) is dropped
  instead of blocking the queue (`whenAcked`, settled only by an answer
  or the end of a flush run, no timer). A flush caller that comes during
  a run waits for it (`flushIdle`, `drainEvents`). When the import cannot
  be queued the panel says why with the line to type, and Import again
  is the person's act; nothing is retried on its own.
- Permit model: before every request the page asks the service worker for a
  permit, performs the fetch itself, then reports status, allowlisted
  headers, elapsed time and markers, and gets a verdict. The worker never
  fetches claude.ai. One request at a time, a fixed minimum spacing before
  each request (`readSpacingMs`, default 0, before a GET or HEAD and before
  every request of an export; `writeSpacingMs`, default 500, before an
  import's other requests), chosen by the request's method and the job's
  kind, never randomized; every wait is a timestamp, never a live timer.
  Writes keep 500 ms because the import script expects 429s on many
  uploads in a row and sends a create, a document or a standard project's
  file only once. Settings stored as version 1 (`minSpacingMs`) are carried
  over by `config.js`.
- The export is never copied into the browser up front: the page's folder
  holds the listing and fetches a file's bytes lazily through the worker and
  the host when the script calls `getFile()`.
- The bridge host is stateless; the job lives in files under
  `<backup dir>/bridge/` (`job.json`, `events-<id>.jsonl`), written by the
  CLI and updated by the host from the extension's events. The host's stdout
  is the protocol; it logs to `bridge.log` through a redacting filter.
- Nothing is re-run from scratch after a create was permitted: the gate
  persists "create permitted" before granting that permit; a second create
  permit in one job is refused; a lost page after the create ends the job
  failed with the new project's link.
- Resume, Retry and Give up are the person's acts. A challenged, blocked or
  unauthenticated request is never re-sent by code; a Retry-After is honoured
  in full (a cap only turns a very long wait into a visible hold).
- Identity is checked against cswap's own registry, read-only: the
  destination email and organization come from `switcher.resolve_account()`
  through `job.json`; the page proves them with `GET /api/organizations` and
  an account endpoint. Nothing in the extension or the host reads cookies;
  the only reader is `project-move auto` itself (and so the import in a
  window of its own), which, to see that a sign-in happened, reads in its
  own browser profiles only: the claude.ai sign-in cookie's row in the
  cookie store, and the pages the session-restore files and the history
  list since its window opened. PRIVACY.md says so.
- Cancel reloads the tab after the gate is closed, because the unchanged
  script retries a thrown fetch and goes on; the created project's link is
  captured first.
- Extension state lives in `chrome.storage.local`, never secrets;
  `chrome.storage.session` is not used because it does not survive a
  browser restart.
- `--checkpoint` in teleport commits `.claude/session.md` and the CLAUDE.md
  marker section instead of a handoff note, and the cloud prompt is
  `checkpoint.start_prompt(task)`. The checkpoint is deterministic: the same
  transcript gives the same bytes, with no wall-clock time anywhere.

## Constraints

- No new runtime dependencies: Python uses the standard library (plus what
  pyproject lists); the extension is plain ES modules with no build step and
  no npm packages, loadable unpacked in Chrome. The store zip is those
  files minified by `package.mjs` with one pinned esbuild (a packaging
  tool run through npx or `CSWAP_ESBUILD`, never a dependency; `--plain`
  skips it): whitespace, comments and local names, which the store's code
  readability policy allows. Never obfuscation or encryption, which that
  policy forbids and review rejects; no source map in the zip.
- Browser-side code never touches cookies or tokens; every request is made
  by the page in the signed-in profile; no automated challenge solving; no
  automatic retry of a challenged or blocked request. No header is added to
  or removed from the script's requests.
- Logs, events and diagnostics never contain cookies, tokens, Authorization
  headers, session keys, API keys, request bodies or query strings; redact
  by default. Only the allowlisted response headers ever appear.
- Manifest permissions are exactly `nativeMessaging`, `userScripts`,
  `storage`, `sidePanel`, `alarms`, `notifications` with host permission
  `https://claude.ai/*`; no `cookies`, `webRequest`, `tabs`, `scripting` or
  `<all_urls>`.
- `src/claude_swap/browser/*`, `project_move.py`, `handoff.py`,
  `tests/js/harness.js` and `tests/js/mock_claude_ai.js` are reused
  read-only by the import side; the import script is not changed.
- The hold thresholds in `gate.js` (`HOLD_AFTER_SLOW_DOWNS = 9`,
  `HOLD_AFTER_FAILURES = 4`) mirror `SLOW_DOWN_WAITS` and `RETRY_WAITS` in
  `project-import.js`; `gate.test.js` reads both arrays out of the script.
- The host's origin check, the manifest key, the tab id, the nonce and the
  sender url checks are the trust boundaries; keep them.

## Out of scope, by decision

Randomized or jittered delays; anything per account inside the extension;
automatic account switching; a `holdOnRefusal` mode or "skip all refusals";
gate-level automatic network retries beyond the script's own three;
shortening a Retry-After; `chrome.storage.session`; the `DISABLE_AUTOUPDATER`,
`DISABLE_BUG_COMMAND`, `DISABLE_COST_WARNINGS` and `DO_NOT_TRACK` variables
in the privacy settings; anything touching authentication, `ANTHROPIC_*`,
proxies, certificates or security settings.

## Testing

```powershell
node --test "tests/js/extension/*.test.js"      # the extension (Node 24)
node tests/js/export.test.js; node tests/js/import.test.js   # the scripts
pytest tests/test_bridge.py tests/test_bridge_duplicate.py tests/test_checkpoint.py tests/test_project_move.py tests/test_project_move_scripts.py tests/test_project_move_bridge.py tests/test_extension_scripts.py tests/test_teleport_checkpoint.py tests/test_cli.py
pytest tests/test_project_move_auto.py   # its real-browser tests need Node 20+ and Chrome; -m "not xdist_group" leaves them out
```

<!-- cswap:checkpoint:begin -->
## Session checkpoint (kept by cswap)

Read `.claude/session.md` at the start of a session: it holds the completed work, the current state and the remaining tasks. Tag durable facts in conversation as `Decision:` or `Constraint:` so the next `cswap checkpoint write` keeps them.

### Durable decisions
- (none recorded)
### Constraints
- (none recorded)
<!-- cswap:checkpoint:end -->
