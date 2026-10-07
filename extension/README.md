# cswap project import (Chrome extension)

The browser side of `cswap project-move`, with nothing to paste. The
extension runs the unchanged import script (`src/claude_swap/browser/
project-import.js`) in the claude.ai tab you are signed in to, one request
at a time, shows the gate and every wait in a side panel, stops and tells
you when the site asks this browser to pass a check or to sign in, and
reports back to the `cswap` command line through a native-messaging bridge
(`cswap bridge`). Its Duplicate button runs the unchanged export script
(`project-export.js`) the same way first, so a project is copied from one
of your accounts into another from the side panel alone. The export never
leaves your computer except file by file, as the import script asks for
it, and an export is written to your computer piece by piece as the export
script produces it.

Extension id: `jhplijnbeejmlgmephlhckpggocpmefp`

The id is pinned by the public key in `manifest.json`: it is the first 32
hex digits of `sha256(DER of the key)` with `0-9a-f` mapped to `a-p`.
Regenerating the key changes the id, every registered host manifest, and
this line; `cswap bridge status` says when the registered id differs from
the packaged one.

## Installing

From the Chrome Web Store, once the listing is published, or unpacked from
this folder as below. A copy from the store has the id the store gave it,
not the pinned one above (the store does not accept a manifest with a
`key`), so register the bridge for that id:
`cswap bridge install --register --extension-id <id>`, with the id
`chrome://extensions` shows on the extension's card. You do not have to
look it up: the side panel's Setup section lists what this computer still
needs (the "Allow User Scripts" switch, cswap and its bridge, a queued
import) and shows that register line with the id already filled in, with
a Copy button. Type the line, reload the extension, press Check now.

## One-time setup

1. Load the extension unpacked. In Chrome (135 or newer), open
   `chrome://extensions`, turn on Developer mode, press "Load unpacked" and
   choose this `extension/` folder. `cswap bridge --help` prints where it
   is for an installed cswap.
2. On the extension's card, turn on "Allow User Scripts" (Chrome 138 and
   newer; before that, Developer mode is enough). Without it the extension
   cannot run the import script, and the side panel says so.
3. Run `cswap bridge install --register` once. It writes the native
   messaging host manifest and a launcher into `<backup dir>/bridge/` and
   registers them with Chrome (an `HKCU` registry key on Windows, a copy of
   the manifest in Chrome's `NativeMessagingHosts` folder on macOS and
   Linux). `cswap bridge install` without `--register` writes the files and
   prints the exact registration command instead; `--browser edge` (or
   `chromium`, `brave`, repeatable) registers with another Chromium browser;
   `--extension-id` names the id when you load a copy with another key.

`cswap bridge status` checks every piece (manifest, launcher, the Python
the launcher names, each browser's registration, the current job) and says
what to rerun. `cswap bridge uninstall --register` removes it all. The
launcher embeds the Python that ran `install`; after a Python upgrade or a
moved install, run `cswap bridge install --register` again.

## Starting an import from the command line

```bash
cswap project-move export          # as before: the export script, run on the project's page
cswap project-move check           # the export is complete
cswap project-move import --to 2   # into Account-2, through the extension
```

`import --to NUM|EMAIL` queues a job (the export's folder or `.tar`, the
destination account's email and organization from cswap's own registry, the
name from `--name` if given) and opens claude.ai. The extension picks the
job up when a claude.ai page loads or when you open the side panel, checks
that the tab is signed in as that account (`GET /api/organizations` and the
account endpoint; nothing reads cookies), injects the helper and the script,
hands the script a folder that reads the export file by file through the
bridge, answers the script's questions (the organization it found itself,
the one export, the name) and presses its button once. The command line
follows the job: each phase, the script's status line, every wait with its
reason and length, every stop, the created project's link, and the script's
own closing account. Ctrl-C leaves the import running in the browser;
`cswap project-move import --watch` reattaches, `--cancel` stops it,
`--no-wait` queues and returns. `--clipboard` takes the paste route even
with the extension installed; `--bridge` makes a missing piece an error
instead of a quiet fallback.

One import at a time: the command line holds `bridge/import.lock` for its
run, a queued or running job refuses a second, the host hands a job to one
browser profile, and the extension refuses a second job while one is
active.

## Duplicate: the whole move from the side panel

With claude.ai open in the account that has the project, press "Duplicate
a project" in the side panel. What follows, step by step:

1. The bridge starts an export job (`export.new`) and lists the accounts
   cswap knows (`accounts.list`: slot, email, organization and whether an
   import can go into it; the registry is read for nothing else, never a
   credential). The claude.ai tab in front is reloaded, so the page helper
   starts on a fresh document.
2. The helper asks claude.ai who is signed in and which projects that
   account can see, with the same requests the export script makes, as
   probes through the gate: `GET /api/organizations`, each organization's
   project list, and the Claude Code projects from the script's
   `GET /v1/code/channels?scope=joined...`, every page of it (the site
   names the next page's cursor while there is one; at most ten pages),
   with the tab's own Claude Code project asked for by itself
   (`GET /v1/code/channels/<id>`) when that list leaves it out. Each is
   listed under the name the site gives it, whether or not the tab is on
   it. A Claude Code project the site names nowhere is offered by its id
   and sent to the bridge without a name; its name comes from the export's
   own `export.json` once the export is written. The page also tallies how
   the Claude Code list went (the first answer's status, the rows over how
   many pages, whether it ended), so the panel can say when claude.ai
   answered that list with nothing, and the log keeps the counts by kind.
   The job waits in the `choosing` phase while the panel shows the projects
   and the accounts; "List again" asks the page once more. Only a
   signed-out page stops it here: there is no account to compare with
   yet, whoever is signed in is the account the project is copied from. A
   listing request the site interrupts (a challenge, a sign-out) holds the
   job like any other, no further listing request is made, and Resume
   lists the projects again.
3. You choose the project, the account to copy it into and, if you want,
   a name for the copy, and press Start. The bridge records the choice on
   the job (`export.choose`); the tab goes to the project's own page, the
   helper is injected again with the project named, the signed-in account
   is checked against the one seen before, and the export script runs
   there. On the project's page it asks nothing; off it, the helper answers
   its "which project" question with the chosen one by name, and stops the
   job with a plain sentence when the script does not list it.
4. The folder the script writes into is the helper's: every file goes to
   the bridge in pieces of at most 512 KiB (`file.write`), in order, each
   waited for, into the exports folder `cswap project-move` uses, under a
   folder of its own when one of that name exists. A piece the bridge
   refuses fails that file the way a full disk would, which the script
   reports as a failed export; nothing is re-sent on its own, and an
   identical piece that arrives twice (the port dropped between the write
   and its answer) is taken once. Every answer names the export's folder,
   so the worker knows it for the line to type should the import not
   start.
5. When the script says "Export complete", the worker waits for the
   bridge to acknowledge the export's end (`done`, then the phase line
   after it); that is the only wait, with no timer of its own. Then the
   bridge checks the export the way `cswap project-move check` does and
   queues its import for the chosen account (`import.queue`), with the
   same job the command line would have made. The worker claims it, sends
   the same tab to claude.ai, and the import runs as described above,
   with the same checks, holds and controls. The export's events and the
   import's each carry their own job id; a late line of the export's that
   reaches the bridge after the import took its place is refused there
   and dropped, so it never holds up the import's events.
6. Or, when "Import the copy" was "In its own window, like the command
   line" (the default when the bridge's hello lists `driven`): the worker
   asks the bridge to start the import (`import.driven`, carrying the job
   id and nothing else). The host builds `cswap project-move auto
   --export=<the export's folder> --to <slot> [--name=<name>]
   [--into=<project>]` from job.json alone, with the name as one argument
   of its own and no shell, and starts it detached: on Windows in a console
   window of its own with none of the host's handles, so the protocol pipe
   never reaches it; elsewhere with no window, its output going to its log.
   The run opens its own browser window for the account and keeps its
   output in `bridge/driven-<job>.log`, cleaned. It records the project it
   makes on the export job the moment the page names it, so a run that is
   killed still leaves it, and how it ended once it ends: Ctrl+C,
   Ctrl+Break and, off Windows, a plain `kill` end it as the person's stop,
   with the project kept. The panel asks how it stands
   (`import.driven.state`, the job id again) every few seconds while it is
   open, and the poll alarm while it is not, over the one port the worker
   keeps open while the import runs; the answer is whether it runs, its
   process, how it ended, the new project's address, the project to carry
   on in, and its last lines. A bridge that can no longer answer for it
   (a cswap put back to a version without it) makes it count as lost
   rather than running for good. Nothing is started again on its own:
   Carry on (or Try again) in the panel starts it once more, and goes on in
   the Claude Code project the stopped run made (`--into`); a regular
   project, which cannot be carried on in, is linked with a warning that
   Try again makes a new one, and a window that goes away after one was
   made ends the run instead of importing again beside it. A project to
   carry on in that is not in view any more is let go, so the next try
   makes a new one. Next to a copy to carry on in, the import in this tab
   (Try the import again, and its line) is not offered. While it runs, no
   new job starts (the host refuses one), a record whose process is not the
   one it started (another process with the same id) does not count, and
   `cswap project-move import --cancel` lets go of a record whose run is
   gone. Opening the panel on a finished export whose import never started
   asks the bridge once for what the stored record lacks: the export's
   folder (an older worker kept none) and a fresh hello, so the panel
   offers the import in its own window once cswap was updated.

The extension never switches accounts. When the tab is still signed in as
the first account, the import holds on "wrong account": sign in as the
other account in a new tab of the same profile and press Resume. When the
import cannot be queued (the bridge did not acknowledge the export's end,
the export is not whole, another job got in first, the bridge is gone),
the export stays on disk and the panel says why, with "Try the import
again" and the `cswap project-move import --to NUM --folder "<the export's
folder>"` line that imports it by hand (with `--name` when a name was
typed for the copy), and a Copy button; nothing is tried again on its own.
Try the import again (`duplicate.import`) is the person's act: it sends
the export's end once more when the bridge never heard it (the worker went
away first), and the bridge answers a second `import.queue` for the same
export with the import it already queued, so nothing is queued twice. A
worker that restarts in the middle of a hand-off shows the same choice.
Cancel during an export
reloads the tab and leaves the files written so far. An export whose page
goes away before the project was chosen starts again on a fresh page with
the panel's form back; after the choice, it starts again on the project's
page, at most three times, since nothing was created. A cswap without the
`duplicate` capability in its hello (an older one) gets a message to
upgrade instead of a job.

## The side panel

Open it from the extension's toolbar button. Everything it shows comes from
`chrome.storage.local`; it keeps no state of its own.

- Connection: whether the bridge host is connected, the cswap version it
  reported, a "Check now" button that connects and asks for a job, and the
  install hint when Chrome cannot start the host. When the bridge's job is
  another browser profile's (an earlier copy of this extension, say, which
  a reinstall made a new instance of), the line names it, with when it was
  claimed, and offers "Drop that job" when the bridge can (`job.drop`):
  the bridge ends that job as cancelled, the way the command line ends a
  job no browser claimed, nothing more is imported or exported by it, and
  a new job can start; a browser still running it stops with an error. A
  "Duplicate a project" the bridge refuses because such a job sits there
  says so and points at that button. An older cswap cannot drop a job:
  the line says to cancel it with `cswap project-move import --cancel`
  (a job whose browser is gone is dropped fifteen minutes after that).
- Duplicate: the button while nothing runs; while an export waits for its
  choice, the project list, the account list, a name for the copy, how
  the copy is imported ("In its own window, like the command line" or "In
  this tab"), Start and "List again"; when the import after an export
  could not start, why, "Try the import again", and the line to type with
  a Copy button; and the import in its own window: offered, running, done
  with the new project's link, or stopped with Carry on, its last lines,
  and its own line to type with Copy.
- Job: the export and the destination account (for an export job, the
  project and the account it comes from, and the files written so far),
  the phase, the script's status line and link, and the result summary at
  the end.
- Gate: the current step (method, path, attempt), the counters (requests,
  slow-downs, server errors, holds, interruptions), and a countdown for
  every wait: "Waiting 27 s: the site asked to slow down (HTTP 429,
  Retry-After 120)" or, before a write, "Waiting 0.4 s: minimum spacing".
- Controls, each enabled only in the phase it belongs to:
  - Pause: no new script request is granted; the one in flight finishes.
    Resume continues.
  - Resume: after an interruption, the extension first checks the tab and
    the signed-in account again; if the problem is gone, the held request
    is sent once more and the import goes on. Also the way out of a hold
    for a Retry-After longer than the cap: the full wait is still honoured.
  - Retry: for a step the script would have given up on (a create that
    failed, the fourth failure in a row, the ninth 429 in a row), send it
    once more. The panel says when the site may already have acted on the
    request, so that a retry can create a duplicate.
  - Give up: hand the failed response to the script, which records the
    file as "not added" and goes on to the next one.
  - Cancel: after a confirmation, the gate is closed, the created project's
    link is captured, and the tab is reloaded, because the unchanged script
    cannot be stopped any other way. The project created so far stays.
  - Confirm: when claude.ai did not say which account is signed in, you
    confirm it is the right one after checking the page's menu.
- Interruption: what happened, what to do, and a details toggle with the
  redacted evidence (status, allowlisted headers, markers, path).
- Log: the last records, newest first, with a level filter, "Save" as a
  `.jsonl` file, and "Clear".
- Settings: every key below, saved as you change it, with problems shown
  inline, and "Reset".
- About: the extension id, the host name, the Chrome version, whether
  `userScripts` is available, and the last hello from the host.

## Settings

| Key | Default | Range | What it does |
|---|---|---|---|
| `readSpacingMs` | 0 | 0 to 60000 | Fixed gap from the end of one request to the start of the next when the next only reads: a GET or HEAD, and every request of an export. 0 sends it as soon as the previous one has ended, still one at a time. Never randomized. |
| `writeSpacingMs` | 500 | 0 to 60000 | Fixed gap before an import's other requests: its creates, uploads and settings. Never randomized. |
| `retryAfterCapMs` | 900000 | 60000 to 86400000 | A Retry-After longer than this becomes a visible hold instead of a silent wait. The full Retry-After is still waited out after Resume. |
| `requestTimeoutMs` | 120000 | 30000 to 3600000 | The gated request's own timeout, plus 4000 ms per MiB of upload body. |
| `notifications` | true | | A desktop notification on an interruption, a hold, done and failed. |
| `logLevel` | info | debug, info, warn, error | What the log keeps; `debug` adds one record per request. |
| `logMaxRecords` | 2000 | 100 to 20000 | The log is a ring of this many records. |
| `logRetentionHours` | 72 | 1 to 720 | Records older than this are dropped. |

A changed spacing applies to the very next request. There is no jitter, no
per-account setting and no automatic account switching, by decision.

Downloads go back to back by default: an export, and the reads of an
import, wait for nothing but the end of the request before. A Retry-After
is still waited out in full, and the script's own back-off after a 429 or a
5xx is still its own. Writes keep half a second between them, because the
import script expects a 429 to be the likeliest answer to many uploads in a
row, each one costs it two seconds or more, the ninth in a row stops the
step until you act, and a create, a document or a standard project's file
is sent only once, so its first failure stops the import for you.

An export's plain reads are not retried by the script: if the export lists
files missing with HTTP 429, raise `readSpacingMs` (500 is what earlier
versions used) and run it again.

Settings saved by an earlier version are carried over: its single
`minSpacingMs` becomes `writeSpacingMs`, and `readSpacingMs` starts at 0
unless you had changed the spacing from its default of 500, in which case
your value is kept for both.

## What happens on an interruption

The extension classifies every response and the state of the tab. When the
site asks this browser to pass a Cloudflare check (the `cf-mitigated:
challenge` header, a challenge page in a 403 or 503 body, `chlray` in
`server-timing`), refuses the request outright (a 403 with error 1020),
answers 401 or sends the tab to the sign-in page, or the tab is signed in as
another account, the gate goes held: no script request is granted, the
failed response is parked in the page (the script never sees it), the panel
shows what happened and what to do, a notification is shown when enabled,
and the command line prints the same two lines.

Nothing is retried on its own after a challenge, a block, a 401 or a hold.
You act in a NEW tab of the same Chrome profile (complete the check, sign
in as the right account) and press Resume; the import tab must not be
reloaded, because the unchanged script has no checkpoints and the import
lives in it. Resume re-checks the tab and the account first, replaces the
interruption if the problem is still there, and otherwise re-sends the one
held request. A page that goes away before the project was created is
started again from the beginning on Resume; after the create, the job ends
failed with the new project's link, and starting over means deleting that
project first.

A 429 is passed to the script, which sleeps and retries by itself; the
gate waits out the Retry-After in full (seconds or an HTTP date, never
shortened) before the next request, and shows the countdown. A 5xx is
passed to the script too, with its own back-off; the gate only steps in
where the script would give up.

## What it never does

No code here reads or writes cookies, adds or removes a header, retries a
request the site challenged, blocked or answered 401, solves a check, or
switches accounts. Every request is made by the page itself in the
signed-in profile; the service worker never fetches claude.ai. The export is
never copied into the browser up front. Logs, events and the side panel
never hold a request body, a cookie, a token, an Authorization header or a
query string; only the allowlisted response headers (`retry-after`,
`content-type`, `content-length`, `cf-mitigated`, `cf-ray`, `server`,
`server-timing`, `location` reduced to its path, `date`) ever appear, and
anything that looks like a secret is redacted before it is kept. The host
reads only regular files under the export, writes an export's files only
under the exports folder, and reads cswap's registry only for the list of
accounts a Duplicate offers (slot, email, organization), never a
credential; the destination email and organization come from the command
line, or from that list, through `job.json`. The bridge's log records the
sizes of the pieces written, never their bytes. The only program the host
starts is cswap's own `project-move auto --export`, for a Duplicate's
import in a window of its own, built from `job.json` on a request that
carries the job id alone; to see a sign-in, that run reads in its own
browser profiles only (never the profile this extension runs in) the
claude.ai sign-in cookie's row in the cookie store and the pages the
session-restore files and the history list since its window opened.

Manifest permissions are exactly `nativeMessaging`, `userScripts`,
`storage`, `sidePanel`, `alarms`, `notifications`, with host permission
for `https://claude.ai/*` only.

## Files

- `src/protocol.js`: the names everything agrees on.
- `src/background.js`: the service worker that runs a job end to end.
- `src/native.js`: the client of the native-messaging host.
- `src/page.js`: the page helper, injected before the import or the export
  script; for an export it is the folder the script writes into.
- `src/duplicate.js`: the Duplicate's pure pieces (the project's page, the
  panel's choices, the hand-over texts).
- `src/setup.js`: the side panel's checklist of what the computer still
  needs.
- `src/content.js`: reports the page's state (nothing else).
- `src/gate.js`, `src/interrupt.js`, `src/config.js`, `src/log.js`: the
  request gate, the stop-and-tell rules, the settings and the log.
- `sidepanel.html`, `src/sidepanel.js`: the side panel.
- `icons/`: the toolbar and store icons, drawn from `store-assets/src/icon.svg`.
- `scripts/package.mjs`: the store zip. `store-assets/`: the store images
  and the tool that draws them. Neither is part of the extension Chrome
  loads, and neither ships in the wheel.

Plain ES modules, plain ASCII, no build step, no npm packages. The job and
the events live in files under `<backup dir>/bridge/` (`job.json`,
`events-<job>.jsonl`, `bridge.log`), written by the command line and the
host; the extension's own state is in `chrome.storage.local`.

## Publishing to the Chrome Web Store

`node extension/scripts/package.mjs` checks the manifest and writes the zip
to upload, `extension/.output/cswap-import-<version>-chrome.zip`: the files
Chrome runs, `PRIVACY.md` from the repository root, and the manifest without
its `key`. The scripts in it are minified (whitespace, comments and local
names; the store allows that and forbids obfuscation, so nothing is hidden
or encrypted) with one pinned esbuild, fetched through npx or named by
`CSWAP_ESBUILD`; `--plain` packages the sources as they are, `--check`
checks without writing. CI builds the zip at the manifest's version on
every push (the `cswap-import-chrome` artifact of the run), and every
merge to `main` that changes it builds it again as
`<manifest>.<commit count>` and keeps that as a GitHub release, the newest
always at
https://github.com/OpenSpineConsortium/claude-swap/releases/latest/download/cswap-import-chrome.zip
(signed in to GitHub; the repository is private) with its `.sha256`
beside it. The store images are in
`store-assets/` (`store-assets/manifest.txt` says which field each goes in
and how to draw them again); the listing texts, the permission
justifications and the privacy answers are in `docs/store/LISTING.md`, the
steps in `docs/store/SUBMISSION.md`, and the hand test before an upload in
`docs/store/TEST_BEFORE_UPLOAD.md`. The privacy policy is `PRIVACY.md` at the
repository root.

A release is a push to `main` that changes what the zip holds:
`.github/workflows/release.yml` tests, builds the zip as version
`<manifest>.<commit count>` (the manifest's `version` with one more
integer, so every build is above the last; raise the manifest's own
version when you mean a new one) and makes the GitHub release
`extension-v<that version>`, the repository's latest, with the zip and its
SHA-256 under the versioned name and under the fixed name the link above
uses. Then, once the repository variable `CWS_ON_PUSH` is `upload`, that
zip becomes the store item's draft, or with `publish` the draft is
submitted for review as well, through the five `CWS_` secrets
(`docs/store/SUBMISSION.md`, section 6); unset, the release is made and
nothing goes to the store. A tag `extension-v<version>` releases the
manifest's exact version the same way and uploads it whatever the
variable says, and "Run workflow" with `upload` or `publish` ticked does
it by hand.
`extension/scripts/publish.mjs` is the script behind the store step; it
reads the secrets from the environment, prints none of them, never
retries, and waits at most five minutes for a package the store is still
processing before a publish.

Tests (Node 24): `node --test "tests/js/extension/*.test.js"` from the
repository root, or one file at a time; `tests/js/extension/
integration.test.js` runs the real page helper and the real import script
together. pytest runs them all through `tests/test_extension_scripts.py`.
