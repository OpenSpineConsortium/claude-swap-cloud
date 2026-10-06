# Privacy policy: cswap project import (Chrome extension)

Version 4, 2026-10-06. Applies to the Chrome extension "cswap project import"
and to the `cswap bridge` program it talks to on your own computer. The
package on the Chrome Web Store carries the extension's own code, minified
(whitespace, comments and local names removed, as the store allows;
nothing in it is obfuscated or encrypted), and a copy of this text as
`PRIVACY.md`; the public copy is at
https://github.com/OpenSpineConsortium/claude-swap-privacy.

## In one paragraph

The extension imports a claude.ai Project that the `cswap` command line on
your computer exported, into the claude.ai account you are signed in to in
Chrome. It sends the project to claude.ai, from your own claude.ai tab, and
to nowhere else. It has no server of its own, no analytics, no advertising
and no error reporting. Nothing it handles is sent to the developer.

## What it handles, and where it goes

- **The project you import** (its name, instructions, files and
  conversations as the export holds them). Read from the export folder on
  your disk, file by file, through `cswap bridge`, and uploaded to claude.ai
  by the claude.ai tab itself, as the import script asks for each file. It
  is not kept by the extension once uploaded.
- **Which claude.ai account the tab is signed in to** (the email address and
  the organization). The tab asks claude.ai (`GET /api/organizations` and the
  account endpoint) so the extension can refuse to import into the wrong
  account. The answer is compared with the account you named to `cswap`, and
  the result is reported to `cswap` on your computer. It is not sent
  anywhere else.
- **The import's progress**: the job's phase, the import script's status
  line, the gate's counters and waits, and a log. Kept in Chrome's
  `chrome.storage.local` on your computer and in files under cswap's backup
  folder (`bridge/job.json`, `bridge/events-<job>.jsonl`, `bridge/bridge.log`),
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

## Who receives data

- **claude.ai (Anthropic)** receives the project you import, because that is
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
when the extension connects to it. It reads only regular files inside the
export you named and writes only under cswap's backup folder. It does not
read cswap's account registry or any credential.

## Your choices

You start every import yourself from the command line, and you can pause,
cancel or give it up in the side panel at any time. Removing the extension
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
