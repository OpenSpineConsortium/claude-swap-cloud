# Privacy policy: Claude Swap Cloud (Chrome extension)

Version 15, 2026-10-08. Applies to the Chrome extension "Claude Swap Cloud"
(named "cswap project import" until version 9 of this text) and to the
`cswap bridge` program it talks to on your own computer, part of the
`claude-swap-cloud` package. The package on the Chrome Web Store carries the
extension's own code, minified (whitespace, comments and local names
removed, as the store allows; nothing in it is obfuscated or encrypted), and
a copy of this text as `PRIVACY.md`; the public copy is at
https://github.com/OpenSpineConsortium/claude-swap-privacy.

## In one paragraph

The extension copies a claude.ai Project between your own accounts. It
imports a project that the `cswap` command line on your computer exported,
into the claude.ai account you are signed in to in Chrome; or, when you
press Export this project in its side panel, it exports the project the
tab shows, from the account the tab is signed in to, into one .tar file
on your computer, where you say in your computer's own Save As window,
and then, once you have pressed Sign out and reload, signed in as the
other account in the same tab, pressed Import and opened the export in
your computer's own Open window, imports it into that account the same
way. It reads from and sends to claude.ai, from your
own claude.ai tab, and to nowhere else. It has no server of its own, no
analytics, no advertising and no error reporting. Nothing it handles is
sent to the developer.

## What it handles, and where it goes

- **The project you import** (its name, instructions, files and
  conversations as the export holds them, and a Claude Code project's
  memory). Read from the export folder on your disk, file by file, through
  `cswap bridge`, and uploaded to claude.ai by the claude.ai tab itself, as
  the import script asks for each file. The memory is written into the
  new project's own memory, each memory at the path it had. The new
  project's memory list is read before and after, and a memory already at
  one of those paths may be read to compare it. Each memory is sent with
  the precondition claude.ai asks a browser to send with a write, which
  says only that no memory is at that path yet and carries nothing of
  yours. The first memory is sent each way the site may expect until one
  is taken (each form of that precondition, then none, with and without
  the memory beta and, for an export that did not record the exact paths,
  with and without the leading slash; at most twelve times for any one
  memory), and once a way is taken every other memory with one request,
  that way. Any memory the new project's memory does not take, or does
  not then list, goes up as an ordinary file in the new project's
  `carried-memory/` folder (`carried-memory-2/` when the project's files
  already hold one). The log keeps those requests' paths, which name the
  new project and a memory by id, and never a memory's text. It is not
  kept by the extension once uploaded.
- **The project you export** (the same things, as claude.ai holds them),
  when you press Export this project. Read from claude.ai by the claude.ai
  tab itself, as the export script asks for each part, and written piece
  by piece through `cswap bridge` into one .tar file on your disk, the
  one you named in the Save As window. For a Claude Code project this
  includes its memory, what its Auto memory panel shows (`MEMORY.md` and
  one file per fact), read from claude.ai with the requests that panel
  makes (asked again naming the memory beta when the first is refused),
  or, where those do not give the memory's list, from the project's
  memory store with the requests Claude Code makes for it; its text goes
  only into that file. The log keeps those requests' paths, which name
  the project or the store and each memory by id, and the script's status
  line, which counts the files; never what they say. The extension keeps
  no copy of what was written; the import you start afterwards reads that
  file as above.
- **Where the export goes, and which export to import.** When you press
  Export this project, `cswap bridge` opens your computer's own Save As
  window (with the project's name and `.tar` suggested); when you press
  Import, its Open window. The windows are the computer's own programs
  (on Windows, PowerShell's; on macOS, the system's; on Linux, zenity,
  kdialog or Python's), started by `cswap bridge`, told only a title, a
  folder to open in, a suggested name and a file filter, and they answer
  with the path you chose and nothing else. The extension learns of the
  path only as the export's own place; the file you open at Import is
  read by `cswap bridge` on your computer, only as far as checking that
  it is a whole export, and never by the extension. The one thing kept
  is the folder the last window used (`bridge/dialog.json` under cswap's
  backup folder), so the next window opens there; it leaves your
  computer nowhere. Nothing on your disk is listed.
- **The projects the signed-in account can see** (their names, ids and
  organizations), when you press Export this project. The tab asks
  claude.ai for the list, the way the export script does, so that the
  project the tab shows is named the way the site names it. The list of
  Claude Code projects that claude.ai sends also names each one's members;
  the tab passes on only each project's id, name, kind and whether it is
  archived. The list is kept with the job in `chrome.storage.local` until
  the job ends and is shown nowhere.
- **Which claude.ai account the tab is signed in to** (the email address and
  the organization). The tab asks claude.ai (`GET /api/organizations` and the
  account endpoint) so the extension can refuse to import into the wrong
  account. For an import you queued from the command line, the answer is
  compared with the account you named to `cswap`, and the result is
  reported to `cswap` on your computer. For a Duplicate no account is
  named in advance: the account the tab is signed in to when you press
  Import is the one the copy goes into, and its email address is recorded
  with the job and reported to `cswap`, as an export records the account
  the project came from. It is not sent anywhere else.
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
folder. For a copy made from the side panel it also writes the export's
files into the one .tar you named in the Save As window, reads the export
you opened in the Open window only to check that it is whole, and keeps
the folder the last window used; it lists nothing on your disk (version
8 of this text had it list the exports folder for the panel) and reads
nothing from cswap's registry for it (version 7 had it read the list of
accounts, to offer one to copy into). The bridge itself never reads a
credential, a cookie or a token. The programs it starts for the extension
are your computer's own file windows, described above, and nothing else.

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
the side panel's three buttons, where the copy goes into whichever account
you signed in as, under the name you give it; the sign-out happens only when you press Sign out and
reload, and neither the extension nor cswap signs in to an account for
you. You can cancel a job, or skip a step that failed, in the side panel
at any time, and an export that was cancelled or could not be imported
stays as files on your disk for you to keep or delete. Removing the
extension from `chrome://extensions` deletes its `chrome.storage.local`.
`cswap bridge uninstall --register` removes the bridge and its files.

## Changes

A change to this text gets a new version number and date at the top, and
the extension's next release carries the new copy.

Version 15 (2026-10-08): the bound on the requests for the new project's
memory is per memory, and the one request for each other memory holds
once a way of sending has been taken. What is sent, where it goes and who
receives it did not change.

Version 14 (2026-10-08): says how many requests the import makes to the
new project's memory, that each carries the precondition claude.ai asks a
browser for (nothing of yours), and that it reads that memory's list, and
a memory already there, to check what it wrote. What is sent, where it
goes and who receives it did not change.

Version 13 (2026-10-08): the import writes a Claude Code project's memory
into the new project's own memory, at the paths it had, and adds as files
under `carried-memory/` only the memories that memory does not take. Where
it goes and who receives it did not change: claude.ai under your own
account.

Version 12 (2026-10-07): the export reads a Claude Code project's memory
with the requests its Auto memory panel makes on claude.ai, and only where
those do not give the memory's list with the ones Claude Code makes. What
is read, where it goes and who receives it did not change.

Version 11 (2026-10-07): the export also reads a Claude Code project's
memory (what its Auto memory panel shows) from claude.ai, into the export
on your computer, and the import adds it to the new project as files under
`carried-memory/` (or `carried-memory-2/` and so on, when that folder is
already there); the new project's own memory is not written. Where it
goes and who receives it did not change: your computer, and claude.ai
under your own account.

Version 10 (2026-10-07): the extension is named Claude Swap Cloud, and
the command line's package claude-swap-cloud (the command stays cswap).
What the extension handles, where it goes and who receives it did not
change.

Version 9 (2026-10-07): the side panel no longer lists the exports on
your disk, and the bridge no longer lists the exports folder. Where an
export goes is said in your computer's own Save As window, as one .tar
file, and the export to import is opened in its Open window; both are
opened by the bridge, which keeps only the folder the last one used.

Version 8 (2026-10-07): the side panel no longer offers the accounts
cswap knows to copy into, and the bridge no longer reads them from
cswap's registry for a Duplicate. The copy goes into whichever claude.ai
account the tab is signed in to when you press Import, and that account's
email address is recorded with the job. The panel's one list is which
export on your disk to import, listed by the bridge from the exports
folder (names and counts only).

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

Claude Swap Cloud is not an Anthropic product. "Claude" and "claude.ai" are
Anthropic's marks, used here only to say which site the extension works with.
