# cswap project import (Chrome extension)

The import side of `cswap project-move`, with nothing to paste. The
extension runs the unchanged import script (`src/claude_swap/browser/
project-import.js`) in the claude.ai tab you are signed in to, one request
at a time, shows the gate and every wait in a side panel, stops and tells
you when the site asks this browser to pass a check or to sign in, and
reports back to the `cswap` command line through a native-messaging bridge
(`cswap bridge`). The export never leaves your computer except file by
file, as the script asks for it.

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

## The side panel

Open it from the extension's toolbar button. Everything it shows comes from
`chrome.storage.local`; it keeps no state of its own.

- Connection: whether the bridge host is connected, the cswap version it
  reported, a "Check now" button that connects and asks for a job, and the
  install hint when Chrome cannot start the host.
- Job: the export and the destination account, the phase, the script's
  status line and link, and the result summary at the end.
- Gate: the current step (method, path, attempt), the counters (requests,
  slow-downs, server errors, holds, interruptions), and a countdown for
  every wait: "Waiting 27 s: the site asked to slow down (HTTP 429,
  Retry-After 120)" or "Waiting 0.4 s: minimum spacing".
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
| `minSpacingMs` | 500 | 0 to 60000 | Fixed gap from the end of one request to the start of the next. Fixed, never randomized. |
| `retryAfterCapMs` | 900000 | 60000 to 86400000 | A Retry-After longer than this becomes a visible hold instead of a silent wait. The full Retry-After is still waited out after Resume. |
| `requestTimeoutMs` | 120000 | 30000 to 3600000 | The gated request's own timeout, plus 4000 ms per MiB of upload body. |
| `notifications` | true | | A desktop notification on an interruption, a hold, done and failed. |
| `logLevel` | info | debug, info, warn, error | What the log keeps; `debug` adds one record per request. |
| `logMaxRecords` | 2000 | 100 to 20000 | The log is a ring of this many records. |
| `logRetentionHours` | 72 | 1 to 720 | Records older than this are dropped. |

A changed spacing applies to the very next request. There is no jitter, no
per-account setting and no automatic account switching, by decision.

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
reads only regular files under the export and never the credential
registry; the destination email and organization come from the command
line through `job.json`.

Manifest permissions are exactly `nativeMessaging`, `userScripts`,
`storage`, `sidePanel`, `alarms`, `notifications`, with host permission
for `https://claude.ai/*` only.

## Files

- `src/protocol.js`: the names everything agrees on.
- `src/background.js`: the service worker that runs a job end to end.
- `src/native.js`: the client of the native-messaging host.
- `src/page.js`: the page helper, injected before the import script.
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
its `key`. `--check` checks without writing. CI builds the same zip on every
push (the `cswap-import-chrome` artifact). The store images are in
`store-assets/` (`store-assets/manifest.txt` says which field each goes in
and how to draw them again); the listing texts, the permission
justifications and the privacy answers are in `docs/store/LISTING.md`, the
steps in `docs/store/SUBMISSION.md`, and the hand test before an upload in
`docs/store/TEST_BEFORE_UPLOAD.md`. The privacy policy is `PRIVACY.md` at the
repository root.

A release is a tag: `git tag extension-v<version>` on the merge commit and
`git push origin <that tag>`. `.github/workflows/release.yml` tests,
builds the zip, refuses a tag that does not match the manifest's version,
makes a GitHub release with the zip and its SHA-256, and uploads the zip to
the store item as a draft when the repository has the four `CWS_` secrets
(`docs/store/SUBMISSION.md`, section 6). Submitting the draft for review
is a person's act: "Run workflow" with `publish` set, or the dashboard.
`extension/scripts/publish.mjs` is the script behind that step; it reads
the secrets from the environment, prints none of them, and never retries.

Tests (Node 24): `node --test "tests/js/extension/*.test.js"` from the
repository root, or one file at a time; `tests/js/extension/
integration.test.js` runs the real page helper and the real import script
together. pytest runs them all through `tests/test_extension_scripts.py`.
