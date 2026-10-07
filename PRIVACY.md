# Privacy policy: cswap project import (Chrome extension)

Version 7, 2026-10-07. Applies to the Chrome extension "cswap project import"
and to the `cswap bridge` program it talks to on your own computer. The
package on the Chrome Web Store carries the extension's own code, minified
(whitespace, comments and local names removed, as the store allows;
nothing in it is obfuscated or encrypted), and a copy of this text as
`PRIVACY.md`; the public copy is at
https://github.com/OpenSpineConsortium/claude-swap-privacy.

## In one paragraph

The extension copies a claude.ai Project between your own accounts. It
imports a project that the `cswap` command line on your computer exported,
into the claude.ai account you are signed in to in Chrome; or, when you
press Export this project in its side panel, it exports the project the
tab shows, from the account the tab is signed in to, into a folder on your
computer, and then, once you have pressed Sign out and reload, signed in
as the other account in the same tab and pressed Import, imports it into
that account the same way. It reads from and sends to claude.ai, from your
own claude.ai tab, and to nowhere else. It has no server of its own, no
analytics, no advertising and no error reporting. Nothing it handles is
sent to the developer.

## What it handles, and where it goes

- **The project you import** (its name, instructions, files and
  conversations as the export holds them). Read from the export folder on
  your disk, file by file, through `cswap bridge`, and uploaded to claude.ai
  by the claude.ai tab itself, as the import script asks for each file. It
  is not kept by the extension once uploaded.
- **The project you export** (the same things, as claude.ai holds them),
  when you press Export this project. Read from claude.ai by the claude.ai
  tab itself, as the export script asks for each part, and written piece
  by piece through `cswap bridge` into the exports folder on your disk
  (`~/claude-project-exports` unless you chose another), where `cswap
  project-move` would have saved it. The extension keeps no copy of what
  was written; the import you start afterwards reads that folder as above.
- **The projects the signed-in account can see** (their names, ids and
  organizations), when you press Export this project. The tab asks
  claude.ai for the list, the way the export script does, so that the
  project the tab shows is named the way the site names it. The list of
  Claude Code projects that claude.ai sends also names each one's members;
  the tab passes on only each project's id, name, kind and whether it is
  archived. The list is kept with the job in `chrome.storage.local` until
  the job ends and is shown nowhere.
- **The accounts cswap knows** (each one's slot number, email address,
  organization name and whether an import can go into it), when you press
  Export this project. `cswap bridge` reads them from cswap's own registry
  on your computer, never a credential, so the side panel can offer the
  account to copy into when you press Import. They are kept with the job
  and sent nowhere else.
- **Which claude.ai account the tab is signed in to** (the email address and
  the organization). The tab asks claude.ai (`GET /api/organizations` and the
  account endpoint) so the extension can refuse to import into the wrong
  account. The answer is compared with the account you named to `cswap` or
  chose in the side panel, and the result is reported to `cswap` on your
  computer; for an export it is recorded as the account the project came
  from. It is not sent anywhere else.
- **The sign-out you ask for.** When you press Sign out and reload, the tab
  makes claude.ai's own sign-out request, in your signed-in browser
  profile: one request to the site's sign-out endpoint, carrying nothing
  but the request itself (no password, no token, no form). The extension
  reads nothing of the answer but its status, whether the site signed the
  tab out, and then sends the tab to claude.ai's sign-in page, where you
  sign in yourself. It never makes that request on its own.
- **A record of an import in a window of its own**, if an earlier version
  of the extension started one for you (this version starts none; see
  below). Such a record holds whether it ran, its process number, how it
  ended, the new project's claude.ai address and its last lines of output,
  with every address's query string cut off and anything that looks like a
  secret replaced by `[redacted]`. It is kept with the job in
  `chrome.storage.local` and shown in the side panel as it stands.
- **The import's or export's progress**: the job's phase, the script's status
  line, the gate's counters and waits, and a log. Kept in Chrome's
  `chrome.storage.local` on your computer and in files under cswap's backup
  folder (`bridge/job.json`, `bridge/events-<job>.jsonl`, `bridge/bridge.log`),
  also on your computer. The log is a ring of at most 20,000 records, and
  records older than its retention (72 hours by default, at most 30 days)
  are dropped.

## What it never handles

The extension does not read or write cookies, and it never handles a
password, a session key, an access or refresh token, an API key or an
Authorization header. It does not read your browsing history and runs on no
site other than `https://claude.ai/`. Its log and its event files never hold
a request body, a query string or a cookie; only these response headers are
ever recorded: `retry-after`, `content-type`, `content-length`,
`cf-mitigated`, `cf-ray`, `server`, `server-timing`, `location` (reduced to
its path) and `date`. Anything else that looks like a secret is replaced by
`[redacted]` before it is kept.

The import in a window of its own (`cswap project-move auto`) is not the
extension's, and the extension no longer starts it: it is the `cswap`
program on your computer, run from the command line, described below.

## Who receives data

- **claude.ai (Anthropic)** receives the project you import, and the
  sign-out request when you press Sign out and reload, because that is
  what you asked the extension to do, under your own claude.ai account and
  Anthropic's own terms and privacy policy. The requests are the claude.ai
  tab's own, made in your signed-in browser profile.
- **Nobody else.** The developer receives nothing. No data is sold,
  transferred to a third party, used for advertising, used to decide
  creditworthiness or lending, or used for any purpose other than the
  import you started.

## The program on your computer

`cswap bridge` is part of the `cswap` command line, which you install and
register yourself (`cswap bridge install --register`). Chrome starts it
when the extension connects to it. For an import it reads only regular
files inside the export you named and writes only under cswap's backup
folder. For a Duplicate it also reads the list of accounts in cswap's
registry (slot, email and organization; the credentials are kept
elsewhere and are never read) and writes the export's files under the
exports folder. The bridge itself never reads a credential, a cookie or a
token, and starts no program for the extension.

The import in a window of its own is cswap's own `cswap project-move auto
--export`, which you run from the command line yourself; version 6 of this
text had the bridge start it for a Duplicate, and this version does not.
For the record, that program opens Chrome on browser profiles of its own
under cswap's backup folder, one per account, where you sign in to
claude.ai yourself the first time. To see that a sign-in happened it
reads, in those profiles only and never in your own Chrome profile: the
claude.ai sign-in cookie's row in the profile's cookie store (from a copy
of the file, compared before and after to see that it changed; the value
is encrypted and is kept nowhere), and the addresses of the pages that the
profile's session-restore files and its browsing history list since its
window opened (looked through for claude.ai's pages, kept nowhere). None
of it leaves your computer.

## Your choices

You start every export and import yourself, from the command line or with
the side panel's three buttons, where you choose the account the copy goes
into and its name; the sign-out happens only when you press Sign out and
reload, and neither the extension nor cswap signs in to an account for
you. You can cancel a job, or skip a step that failed, in the side panel
at any time, and an export that was cancelled or could not be imported
stays as files on your disk for you to keep or delete. Removing the
extension from `chrome://extensions` deletes its `chrome.storage.local`.
`cswap bridge uninstall --register` removes the bridge and its files.

## Changes

A change to this text gets a new version number and date at the top, and
the extension's next release carries the new copy.

Version 7 (2026-10-07): the side panel's Duplicate became three buttons,
Export this project, Sign out and reload, and Import. New: the sign-out
request the extension makes at your click, which carries nothing but the
request itself and of whose answer the extension reads the status alone.
Changed: a Duplicate's import runs in the same tab, after you sign in
there, and only when you press Import; the import in a window of its own
is no longer started from the extension, and the bridge starts no program
for it. The log's Clear button is gone.

## Contact

Questions: open an issue at
https://github.com/OpenSpineConsortium/claude-swap-privacy/issues.

cswap is not an Anthropic product. "Claude" and "claude.ai" are Anthropic's
marks, used here only to say which site the extension works with.
