# cswap project import (Chrome extension)

The browser side of `cswap project-move`, with nothing to paste. The
extension runs the unchanged import script (`src/claude_swap/browser/
project-import.js`) in the claude.ai tab you are signed in to, one request
at a time, shows the gate and every wait in a side panel, stops and tells
you when the site asks this browser to pass a check or to sign in, and
reports back to the `cswap` command line through a native-messaging bridge
(`cswap bridge`). Its Export this project button runs the unchanged
export script (`project-export.js`) the same way first, so a project is
copied from one of your accounts into another from the side panel alone,
with three buttons: Export this project, Sign out and reload, and Import.
The export never leaves your computer except file by file, as the import
script asks for it, and an export is written to your computer piece by
piece as the export script produces it.

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

With the project open on claude.ai in the tab (`claude.ai/project/...` or
`claude.ai/code/project/...`), signed in as the account that has it, press
"Export this project" in the side panel. What follows, step by step:

1. A tab that is not on a project is refused with a sentence saying what
   to open (the content script's last report names the tab's path). Then
   the bridge starts an export job (`export.new`); cswap's registry is not
   read, since the copy goes into whichever account is signed in when
   Import is pressed. The tab is reloaded, so the page helper starts on a
   fresh document.
2. The helper asks claude.ai who is signed in and which projects that
   account can see, with the same requests the export script makes, as
   probes through the gate: `GET /api/organizations`, each organization's
   project list, and the Claude Code projects from the script's
   `GET /v1/code/channels?scope=joined...`, every page of it (the site
   names the next page's cursor while there is one; at most ten pages),
   with the tab's own Claude Code project asked for by itself
   (`GET /v1/code/channels/<id>`) when that list leaves it out. Only each
   project's id, name, kind and archived leave the page, and the log keeps
   the counts by kind. The project the tab shows is chosen on its own,
   under the name the site gives it; there is no form and no list to pick
   from, and when the list does not name the tab's project the job fails
   with the same sentence. A Claude Code project the site names nowhere is
   sent without a name and takes the name its own `export.json` gives once
   the export is written. No account to copy into is recorded
   (`export.choose` names none; one an older panel sends is kept as
   before, for the line to type). Only a signed-out page stops the
   job here, since whoever is signed in is the account the project is
   copied from; a listing request the site interrupts (a challenge, a
   sign-out) holds the job like any other, no further listing request is
   made, and Resume lists the projects again.
3. Where the export goes is said in the computer's own Save As window
   (phase `placing`): the bridge opens it (`dialog.open` with the job id;
   capability `dialogs`), with `<the project's name>.tar` suggested in
   the folder the last window used (the exports folder the first time),
   and the worker asks how it stands (`dialog.state`) every 700 ms until
   it ends. A choice places the export: the bridge puts the .tar on the
   job and remembers the folder, and the job goes on; the window closed
   without a choice ends the job cancelled, since nothing was written; a
   window that could not open (no program on the computer can show one)
   fails it with the bridge's words. Every press of the panel's meanwhile
   is answered with the window, Cancel closes it through the bridge
   (`dialog.close`), and a worker restarted meanwhile follows the same
   window, whose id is on the job. What was chosen never travels from
   the extension to the bridge: the bridge read its own window's answer.
   A cswap without the `dialogs` capability fails the job with the
   update to make.
4. The helper is injected again with the project named, the signed-in
   account is checked against the one seen before, and the export script
   runs on the project's page, where it asks nothing.
5. The folder the script writes into is the helper's: every file goes to
   the bridge in pieces of at most 512 KiB (`file.write`), in order, each
   waited for, into the one .tar the Save As window named, where the
   bridge appends each file as a member as its pieces arrive and seals the
   archive at the end. A piece the bridge refuses fails that file the way
   a full disk would, which the script reports as a failed export; nothing
   is re-sent on its own, and an identical piece that arrives twice (the
   port dropped between the write and its answer) is taken once. Every
   answer names the .tar, so the worker knows it for the line to type.
6. When the script says "Export complete", the job ends done: the bridge
   hears `done` and the phase line after it, and the notification says
   what to press next. The export is not handed over to its import on its
   own.
7. "Sign out and reload" is the person's act between the two halves, and
   is refused while a job runs in the tab, or is starting. The worker asks the tab's
   content script (`sign.out`) to make claude.ai's own sign-out request, a
   POST to the site's sign-out endpoint with no body, in the tab's
   signed-in profile; nothing of the answer but its status leaves the
   page. Then the tab is sent to claude.ai's sign-in page, where the person
   signs in as the other account. When the site refuses the sign-out, or
   the tab does not answer, the panel says so, with the way by hand: sign
   out from the page's menu, then sign in.
8. "Import" (`duplicate.import`, with the name typed, if any) opens the
   computer's own Open window for the export to copy. The button is in
   place at every moment: pressed while a job runs, or while a window is
   open, it is answered with why, and nothing starts. Otherwise the
   events still on their way reach the bridge first, and, for a finished
   export of this browser's the bridge still shows unfinished (the worker
   went away before its end was delivered), the end is sent once more;
   then the bridge opens the window (`dialog.open`, purpose `open`) in
   the folder the last window used, showing `.tar` files and `export.json`,
   and the worker follows it (`dialog.state`) until it ends. The window
   closed without a choice imports nothing, and the press is answered
   with that. What was opened is the bridge's to read: the export just
   made (the worker knows its .tar) goes the hand-over's way, by the
   export job: `import.queue` with the job id, `signed_in` and the name,
   where the bridge records the name on the export job, checks the export
   the way `cswap project-move check` does, and queues the same import job
   the command line would have made, with no account named, taking from
   the bridge's record what the worker's own lacks (the project's own
   name). Any other export goes by the window: `import.queue` with the
   window's id (`dialog`, `signed_in`, the name), and the bridge takes the
   export the window's choice names (a .tar, a folder, or the `export.json`
   inside one), checks it the same way and queues the same job; a file
   that is no export, a window still open, one closed without a choice,
   or a choice imported already is refused in the bridge's words. No path
   travels from the extension to the bridge. The worker claims
   it (`job.claim`), sends the same tab to claude.ai, and the import runs
   as described above, with the same checks, holds and controls, but for
   the account: the page's own check takes whichever account is signed
   in, the worker records it on the job and tells the bridge (an `account`
   event, applied to the job record), and from then on it is checked like
   an account named on the command line; the panel's Progress line and
   `cswap project-move import --watch` say which. A page that cannot say
   who is signed in asks for Confirm, and nothing is recorded. A second
   `import.queue` for the same export answers with the
   import already queued, so nothing is queued twice. The export's events
   and the import's each carry their own job id; a late line of the
   export's that reaches the bridge after the import took its place is
   refused there and dropped.

The extension never switches accounts. The copy goes into whichever
account the tab is signed in as, the first one included when Sign out and
reload was skipped. When the tab is signed out at Import, the import holds
on "signed out": sign in as the other account in a new tab of the same
profile and press Resume. When the import cannot be queued (the export is
not whole, another job got in first, the bridge is gone), the export stays
on disk and the panel says why, keeps Import, and shows the `cswap
project-move import --to NUM --folder="<the export's .tar>"` line that
imports it by hand (with `--name=` when a name was typed for the copy;
NUM is the account's number in `cswap list`, which the hint over the line
says), with a Copy button; nothing is tried again on its own. Cancel during an export reloads the tab and
leaves what was written so far in the .tar. An export whose page goes away starts
again, on the project's page once the project was found, at most three
times, since nothing was created. A cswap without the `duplicate`
capability in its hello (an older one) gets a message to upgrade instead
of a job.

The import in a window of its own is the command line's: `cswap
project-move auto --export="<the export's folder>" --to NUM` opens a
browser window of its own for the account and imports there. The panel no
longer starts it, and never sends the bridge's `import.driven`. A record
of one that an earlier version of the extension started is shown as it
stands (running, done with the new project's link, or stopped with its
last lines), asked about (`import.driven.state`) while it says it runs;
while it runs no new job starts.

## The side panel

Open it from the extension's toolbar button. Everything it shows comes from
`chrome.storage.local`; it keeps no state of its own. The three buttons of
a copy are always in place and always live (greg, 2026-10-07: no dynamic
changes to the button layout); the controls of a running job are shown
only while they apply.

- Copy a project to another account: the three numbered steps, then the
  three buttons in one order whatever runs: "Export this project", "Sign
  out and reload", and the Import block, the name for the copy with
  "Import" (nothing to choose in the panel: where the export goes is
  said in the computer's own Save As window, the export to import is
  opened in its Open window, and the copy goes into the account signed
  in; so a move is picked up here at any step as long as the export
  exists). Under them the lines: the one while the export runs (the
  project and the account it comes from, or the Save As window it waits
  for); once the export is done, what came after it, with the line that
  imports its .tar by hand and a Copy button; and, when the import could
  not be queued, why. A press at the wrong moment (Import while a job
  runs, Export this project with a job in the tab, Sign out and reload
  during a job, any of them while a window is open) is answered with why,
  and nothing starts. A
  record of an import in a window of its own that an earlier version
  started (running, done with the new project's link, or stopped with its
  last lines) is shown here as it stands.
- Progress: the export and the account the copy goes into, once the page
  named it (for an export job,
  the project and the account it comes from, and the files written so
  far), the phase, the script's status line and link, the result summary
  at the end, the current step (method, path, attempt), the counters
  (requests, slow-downs, server errors, holds, time waited), and a
  countdown for every wait: "Waiting 27 s: the site asked to slow down
  (HTTP 429, Retry-After 120)" or, before a write, "Waiting 0.4 s:
  minimum spacing".
- Stopped: what happened, what to do, and a details toggle with the
  redacted evidence (status, allowlisted headers, markers, path).
- Controls, shown while a job runs, each only while it applies:
  - Resume: after an interruption, the extension first checks the tab and
    the signed-in account again; if the problem is gone, the held request
    is sent once more and the job goes on. Also the way out of a hold for
    a Retry-After longer than the cap (the full wait is still honoured),
    and of a step the script would have given up on (a create that
    failed, the fourth failure in a row, the ninth 429 in a row), which
    Resume sends once more; the panel says when the site may already have
    acted on that request, so that sending it again can create a
    duplicate.
  - Skip this step: hand the failed response to the script, which records
    the file as "not added" and goes on to the next one.
  - Cancel: after a confirmation, the gate is closed, the created project's
    link is captured, and the tab is reloaded, because the unchanged script
    cannot be stopped any other way. The project created so far stays.
  - Confirm: when claude.ai did not say which account is signed in, you
    confirm it is the right one after checking the page's menu.
- Connection: whether the bridge host is connected, the cswap version it
  reported, a "Check now" button that connects and asks for a job, and the
  install hint when Chrome cannot start the host. When the bridge's job is
  another browser profile's (an earlier copy of this extension, say, which
  a reinstall made a new instance of), the line names it, with when it was
  claimed, and offers "Drop that job" when the bridge can (`job.drop`):
  the bridge ends that job as cancelled, the way the command line ends a
  job no browser claimed, a browser still running it stops the next time
  it reports, and a new job can start here. Only the job named on the line
  is dropped: one that took its place meanwhile is named instead, for the
  line to be read again. An "Export this project" the bridge refuses
  because such a job sits there says so and points at that button. An
  older cswap cannot drop a job: the line says to cancel it with `cswap
  project-move import --cancel` (a job whose browser is gone is dropped
  fifteen minutes after that).
- Setup: the checklist of what this computer still needs, each step with
  the line to type and a Copy button; it folds away once every step is
  done.
- Log, settings and about, folded under one heading: the log's last
  records, newest first, with a level filter and "Save log" as a `.jsonl`
  file; the settings (every key below) with Save and Reset and problems
  shown inline; and About: the extension id and version, the host name,
  the Chrome version, whether `userScripts` is available, the last hello
  from the host, and this browser's instance id.

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
switches accounts. Every request of the import or the export is made by
the page itself in the signed-in profile; the service worker never fetches
claude.ai. The content script makes exactly one request, claude.ai's own
sign-out, and only when the person presses Sign out and reload: a POST
with no body, of which it reads the status alone; it reads no cookie and
changes nothing on the page. The export is never copied into the browser
up front. Logs, events and the side panel never hold a request body, a
cookie, a token, an Authorization header or a query string; only the
allowlisted response headers (`retry-after`, `content-type`,
`content-length`, `cf-mitigated`, `cf-ray`, `server`, `server-timing`,
`location` reduced to its path, `date`) ever appear, and anything that
looks like a secret is redacted before it is kept. The host reads only
regular files under the export, writes an export's files only into the
.tar the Save As window named, reads an export the Open window named
only to check it is one, lists nothing, and reads cswap's registry only
for an account named on the command line (`--to`), never a credential; a
Duplicate names no account, and the one the page is signed in as is
recorded on `job.json` once the page names it. The bridge's log records the sizes of the
pieces written, never their bytes, and each window by its id, never what
its program wrote. The programs the host starts for the extension are the
computer's own file windows (Windows PowerShell's Save As and Open
dialogs, macOS's `osascript`, zenity or kdialog, else Python's tkinter),
told the title, the folder, the suggested name and the filter, which
answer with the path chosen and nothing else; the folder of the last
answer is kept in `bridge/dialog.json`. The other program it can start is
cswap's own `project-move auto --export`, built from `job.json` on a
request (`import.driven`) that carries the job id alone; this extension
no longer sends that request, and that import is the command line's. To
see a sign-in, such a run reads in its own browser profiles only (never
the profile this extension runs in) the claude.ai sign-in cookie's row in
the cookie store and the pages the session-restore files and the history
list since its window opened.

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
  accounts offered, the lines to type, what the panel shows after an
  export).
- `src/setup.js`: the side panel's checklist of what the computer still
  needs.
- `src/content.js`: reports the page's state and makes the sign-out
  request when the person asks for it (nothing else).
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
`.github/workflows/release.yml` (one call of the release kit, `release-kit/`
at the repository root, which does the same for any Chrome extension
repository; its README says how) tests, builds the zip as version
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
`release-kit/store/publish.mjs` is the script behind the store step; it
reads the secrets from the environment, prints none of them, never
retries, and waits at most five minutes for a package the store is still
processing before a publish.

Tests (Node 24): `node --test "tests/js/extension/*.test.js"` from the
repository root, or one file at a time; `tests/js/extension/
integration.test.js` runs the real page helper and the real import script
together. pytest runs them all through `tests/test_extension_scripts.py`.
