# Privacy policy: cswap project import (Chrome extension)

Version 6, 2026-10-06. Applies to the Chrome extension "cswap project import"
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
press Duplicate in its side panel, it exports a project from the account
the tab is signed in to into a folder on your computer and then imports it
into another of your accounts the same way, or, when you choose "In its own
window", asks the `cswap` program on your computer to import it with its
own `project-move auto`, in a browser window of its own. It reads from and sends to
claude.ai, from your own claude.ai tab, and to nowhere else. It has no
server of its own, no analytics, no advertising and no error reporting.
Nothing it handles is sent to the developer.

## What it handles, and where it goes

- **The project you import** (its name, instructions, files and
  conversations as the export holds them). Read from the export folder on
  your disk, file by file, through `cswap bridge`, and uploaded to claude.ai
  by the claude.ai tab itself, as the import script asks for each file. It
  is not kept by the extension once uploaded.
- **The project you duplicate** (the same things, as claude.ai holds them).
  Read from claude.ai by the claude.ai tab itself, as the export script
  asks for each part, and written piece by piece through `cswap bridge`
  into the exports folder on your disk (`~/claude-project-exports` unless
  you chose another), where `cswap project-move` would have saved it. The
  extension keeps no copy of what was written; the import that follows
  reads that folder as above.
- **The projects the signed-in account can see** (their names, ids and
  organizations), when you press Duplicate. The tab asks claude.ai for the
  list, the way the export script does, so the side panel can show it for
  you to choose from. The list of Claude Code projects that claude.ai
  sends also names each one's members; the tab passes on only each
  project's id, name, kind and whether it is archived. The list is kept
  with the job in `chrome.storage.local` until the job ends and shown
  nowhere else.
- **The accounts cswap knows** (each one's slot number, email address,
  organization name and whether an import can go into it), when you press
  Duplicate. `cswap bridge` reads them from cswap's own registry on your
  computer, never a credential, so the side panel can offer the account to
  copy into. They are kept with the job and sent nowhere else.
- **Which claude.ai account the tab is signed in to** (the email address and
  the organization). The tab asks claude.ai (`GET /api/organizations` and the
  account endpoint) so the extension can refuse to import into the wrong
  account. The answer is compared with the account you named to `cswap` or
  chose in the side panel, and the result is reported to `cswap` on your
  computer; for a Duplicate's export it is recorded as the account the
  project came from. It is not sent anywhere else.
- **The import in a window of its own**, when you choose it for a
  Duplicate. The extension asks `cswap bridge` to start it with the job's
  id and nothing else; what runs is cswap's own `project-move auto`, built
  by cswap from the job it recorded. The extension then receives how it
  stands: whether it runs, its process number, how it ended, the new
  project's claude.ai address, and its last lines of output, with every
  address's query string cut off and anything that looks like a secret
  replaced by `[redacted]`. These are kept with the job in
  `chrome.storage.local` and shown in the side panel.
- **The import's or export's progress**: the job's phase, the script's status
  line, the gate's counters and waits, and a log. Kept in Chrome's
  `chrome.storage.local` on your computer and in files under cswap's backup
  folder (`bridge/job.json`, `bridge/events-<job>.jsonl`, `bridge/bridge.log`,
  and `bridge/driven-<job>.log` for an import in a window of its own),
  also on your computer. The log is a ring of at most 20,000 records, and
  records older than its retention (72 hours by default, at most 30 days)
  are dropped. "Clear" in the side panel empties it.

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

The import in a window of its own is not the extension's: it is the
`cswap` program on your computer, described below.

## Who receives data

- **claude.ai (Anthropic)** receives the project you import, because that is
  what you asked the extension to do, under your own claude.ai account and
  Anthropic's own terms and privacy policy. The requests are the claude.ai
  tab's own, made in your signed-in browser profile; for an import "In its
  own window" they are made instead by the Chrome window `cswap project-move
  auto` opens, on its own browser profile for that account, where you
  signed in (see below).
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
token.

When you choose to import a Duplicate's copy "In its own window", the
bridge starts cswap's own `cswap project-move auto --export` on your
computer, from the job's own record: the export's folder, the account you
chose and the name you typed, with nothing from the extension but the
job's id. That program opens Chrome on browser profiles of its own under
cswap's backup folder, one per account, where you sign in to claude.ai
yourself the first time. To see that a sign-in happened it reads, in
those profiles only and never in your own Chrome profile: the claude.ai
sign-in cookie's row in the profile's cookie store (from a copy of the
file, compared before and after to see that it changed; the value is
encrypted and is kept nowhere), and the addresses of the pages that the
profile's session-restore files and its browsing history list since its
window opened (looked through for claude.ai's pages, kept nowhere). None
of it leaves your computer. What it prints is kept in
`bridge/driven-<job>.log`, cleaned the same way as above, with the
address of the project it makes recorded in `bridge/job.json` as soon as
the page names it.

## Your choices

You start every import yourself, from the command line or by pressing
Duplicate in the side panel, where you choose the project, the account
it is copied into and how the copy is imported (in this tab, or in a
window of its own); neither the extension nor cswap signs in to an account
for you.
You can pause, cancel or give a job up in the side panel at any time, and
an export that was cancelled or could not be imported stays as files on
your disk for you to keep or delete. Removing the extension
from `chrome://extensions` deletes its `chrome.storage.local`.
`cswap bridge uninstall --register` removes the bridge and its files.

## Changes

A change to this text gets a new version number and date at the top, and
the extension's next release carries the new copy.

## Contact

Questions: open an issue at
https://github.com/OpenSpineConsortium/claude-swap-privacy/issues.

cswap is not an Anthropic product. "Claude" and "claude.ai" are Anthropic's
marks, used here only to say which site the extension works with.
