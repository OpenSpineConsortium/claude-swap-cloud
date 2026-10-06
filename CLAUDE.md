# claude-swap

`cswap`: a multi-account switcher for Claude Code. Python 3.12+, hatchling,
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
  `file.write`, `import.queue`).
- `extension/`: the Manifest V3 extension (`src/background.js` the worker,
  `src/page.js` the page helper that runs the unchanged import or export
  script and is the folder an export writes into, `src/duplicate.js` the
  Duplicate's pure pieces, `src/gate.js` the request gate, `src/interrupt.js`
  the stop-and-tell rules, `src/config.js`, `src/log.js`, `src/native.js`,
  `src/content.js`, `src/sidepanel.js`, `src/protocol.js` the shared names).
- `extension/scripts/package.mjs` (the Chrome Web Store zip, without the
  manifest's `key`), `extension/scripts/publish.mjs` (the upload and the
  submit through the store's API, from `CWS_` environment variables),
  `.github/workflows/release.yml` (a push to `main` that changes the zip,
  or a tag `extension-v<version>`, builds it and makes the GitHub release,
  the repository's latest, with the zip under its versioned name and as
  `cswap-import-chrome.zip`, which README.md links through
  `releases/latest/download/`; the store upload of that same zip waits on
  the repository variable `CWS_ON_PUSH`, except for a tag, which always
  uploads; a push is numbered `<manifest>.<commit count>`),
  `extension/store-assets/` (the store
  images, drawn from the real side panel), `docs/store/` (listing,
  submission, hand test) and `PRIVACY.md`: the store side. Not loaded by
  Chrome and not in the wheel. `extension/src/setup.js` is the panel's
  checklist of what a computer still needs, with the line to type for
  each; its install lines name this repository, not PyPI's claude-swap.
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
- Duplicate is the existing pieces in a row: an export job (`kind:
  "export"`) started from the side panel, which reloads the claude.ai tab,
  lists the signed-in account's projects with the export script's own
  requests (phase `choosing`), takes the choice (`duplicate.choose`), sends
  the tab to the project's page and runs the export script there. The
  folder the script writes into is the page helper's: every file goes to
  the bridge piece by piece (`file.write`, in order, each waited for, an
  identical re-send taken once), into project-move's exports folder under
  its unique-name rule. A finished export queues its import (`import.queue`)
  through `project_move`'s own checks and the same import job the command
  line makes, run in the same tab. The registry is read for the account
  list only (`accounts.list`); signing in as the other account is the
  person's act, answered by the import's wrong-account hold and Resume.
- Permit model: before every request the page asks the service worker for a
  permit, performs the fetch itself, then reports status, allowlisted
  headers, elapsed time and markers, and gets a verdict. The worker never
  fetches claude.ai. One request at a time, a fixed minimum spacing, never
  randomized; every wait is a timestamp, never a live timer.
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
  an account endpoint. Nothing reads cookies.
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
```

<!-- cswap:checkpoint:begin -->
## Session checkpoint (kept by cswap)

Read `.claude/session.md` at the start of a session: it holds the completed work, the current state and the remaining tasks. Tag durable facts in conversation as `Decision:` or `Constraint:` so the next `cswap checkpoint write` keeps them.

### Durable decisions
- (none recorded)
### Constraints
- (none recorded)
<!-- cswap:checkpoint:end -->
