# Store listing: Claude Swap Cloud on the Chrome Web Store

Every field of the Chrome Web Store developer dashboard, in the order it
asks for them, with the text to paste (each block: copy all of it) or the
file to upload. `SUBMISSION.md` beside this file says what to do around the
paste and in what order; `TEST_BEFORE_UPLOAD.md` is the hand test before an
upload. Written 2026-10-05 for extension 0.1.0, revised 2026-10-06 for 0.2.0
and again for the import in a window of its own, 2026-10-07 for the side
panel's three buttons (Export this project, Sign out and reload, Import),
and again on 2026-10-07 for the name Claude Swap Cloud and the listing's
place beside cswap: what cswap does for Claude Code on your computer, this
extension does for the Projects that live in the cloud. Dashboards move
their fields around; the names below are the ones in use at the time of
writing, and the texts are what matter.

The texts describe the extension as it is built: keep them true. When the
extension changes what it touches, change the matching block here, the
privacy policy (`PRIVACY.md`, with its version) and the package together.

## Package tab

Upload the zip from the GitHub release: the newest build from `main` at
https://github.com/OpenSpineConsortium/claude-swap-cloud/releases/latest/download/claude-swap-cloud-chrome.zip
(signed in to GitHub), or a tag's release. `node extension/scripts/package.mjs
--build N` on that commit, with the pinned esbuild, builds the same bytes
by hand. Its scripts are minified: whitespace, comments and
local names, which the store's Code Readability Requirements allow; it is
not obfuscated or encrypted, which they forbid. The name and the summary
come from the package's manifest and are not typed:

- Name: `Claude Swap Cloud`
- Summary (the manifest `description`, 128 characters; Chrome allows 132):
  `Moves your claude.ai Projects between your own Claude accounts: export from one, sign in as the other, import. Works with cswap.`

## Store listing tab

### Description

```
Claude Swap Cloud moves your claude.ai Projects between your own Claude accounts.

cswap, the command line this extension belongs to, switches Claude Code between your accounts on your computer without logging out, and lets you run them side by side. Claude Swap Cloud does the same for what lives in the cloud: your Projects. That includes the redesigned Projects, one ongoing conversation where Claude coordinates threads that run as cloud sessions and share the project's repositories, instructions and memory, as well as the regular Projects with their knowledge files and chats. A Project belongs to the account that made it, and claude.ai has no way to move it to another. Claude Swap Cloud copies it: export it from one account, sign in as the other, import it.

Three buttons in the side panel, always in the same place. Open the project on claude.ai, signed in as the account that has it, and press Export this project: your computer's own Save As window opens for where the export goes (one .tar file), and the extension runs cswap's export script on the project's page and saves the project there through cswap. Press Sign out and reload: the tab makes claude.ai's own sign-out request and goes to the sign-in page, where you sign in as the other account yourself. Give the copy a name if you want one and press Import: your computer's own Open window appears; open the export to copy (the .tar just saved, or any export cswap made), and cswap queues the import and the extension runs it in the same tab, into whichever account you signed in as. Any export on your computer can be imported this way at any time, so a move can be picked up at any step. The command line works too: cswap project-move import --to NUM queues an import that the extension picks up in the claude.ai tab signed in as that account, after checking that it is.

What comes across. From a Claude Code project: its name, icon and colour, description, instructions, files, model and effort settings, and its repositories and linked folders where the new account may use them; its conversation, threads and session transcripts, as files the new project's Claude can read, since claude.ai cannot create those live; and, for each of its running sessions, the cswap teleport line that carries that session on under the new account. Its memory, what its Auto memory panel shows, comes across as files the new project's Claude can read, in a folder of their own; the new project's own memory starts empty. From a regular project: its name, description, instructions, knowledge files and documents, with every chat and the project memory added as documents. The import always makes a new, private project, and a copied Claude Code project arrives paused until you press Resume on its page; nothing in either account is changed or deleted.

What it shows you, in the side panel:
- the three buttons, always in place (a press at the wrong moment is answered with why), a name for the copy, and the line to type when an import could not be queued;
- the job, the account it imports into or exports from, and the script's status line;
- the gate: one request at a time, a fixed spacing before each write (none by default before a read), and a countdown for every wait;
- Resume, Skip this step, Cancel and Confirm, each only when it applies;
- a log you can filter and save.

What it does when the site pushes back:
- When claude.ai asks the browser to pass a check, signs you out, or the tab is signed in as another account, the import stops and the panel says what happened and what to do. Nothing is retried on its own; you press Resume.
- When the site asks it to slow down, the full wait is honoured, never shortened.

What it never does: it does not read or write cookies, handle passwords or tokens, add or remove request headers, switch accounts, run on any site but claude.ai, or send anything to the developer. The one request it makes of its own, beside the scripts' own, is claude.ai's sign-out when you press Sign out and reload, and it reads nothing of the answer but whether it worked. There are no analytics. The log never keeps request bodies or query strings. cswap's registry is read only for an account named on the command line, never for a credential; the Save As and Open windows are your computer's own, opened by cswap, which keeps only the folder the last one used.

Requires the cswap command line from Claude Swap Cloud (Python; uv tool install git+https://github.com/OpenSpineConsortium/claude-swap-cloud, or pipx install with the same address) and a one-time cswap bridge install --register, which lets Chrome talk to cswap on your computer; the side panel's Setup section shows each line to type. In Chrome 138 and newer, turn on "Allow User Scripts" on the extension's details page.

Claude Swap Cloud is not an Anthropic product. "Claude", "Claude Code" and "claude.ai" are Anthropic's marks, used here only to say which site and which product the extension works with.
```

### Category

`Productivity` (the "Developer Tools" category is the other fit; the
listing is for people moving their own work between accounts).

### Language

`English`

### Graphic assets

| Field | File (under `extension/store-assets/`) |
|---|---|
| Store icon (128x128) | `store-icon-128.png` |
| Screenshots (1280x800, in this order) | `screenshot-01-importing.png`, `screenshot-02-stops-and-tells.png`, `screenshot-03-done.png` |
| Small promo tile (440x280) | `promo-tile-440x280.png` |
| Marquee promo tile (1400x560, optional) | `marquee-1400x560.png` |
| Global promo video | leave empty |

`extension/store-assets/manifest.txt` says how each image was made and how
to make them again.

### URLs

- Official URL: leave as "None" (it needs a verified site in Search Console).
- Homepage URL: `https://github.com/OpenSpineConsortium/claude-swap-privacy`
- Support URL: `https://github.com/OpenSpineConsortium/claude-swap-privacy/issues`

The source repository is private, so the three links (these two and the
privacy policy below) point at its public companion, which holds the
policy and takes questions (`SUBMISSION.md`, section 0).

### Mature content

No.

## Privacy practices tab

### Single purpose

```
Copy a claude.ai Project between the user's own Claude accounts, from the user's own claude.ai tab and under the user's control: export the signed-in account's project to the user's computer through cswap and import it into another of the user's accounts, or import a project the user exported with the cswap command line into the signed-in account.
```

### Permission justification

**nativeMessaging**

```
Talks to cswap's own program on the user's computer (the native host com.claude_swap.bridge, registered by the user with "cswap bridge install --register"). It hands the extension the import job the user queued, the import script and the export's files one at a time, and receives the import's progress for the command line. For a copy made from the side panel it also hands over the export script, opens the computer's own Save As window for where the export goes and takes the export's files piece by piece as the script writes them, saving them in that one .tar on the user's computer; and it opens the computer's own Open window for the export to import, reads the export the user opened and queues its import into the account the user is signed in as. The extension never learns what was chosen in those windows beyond the export's own path. At the user's request it ends a job that another browser profile left behind (an earlier copy of this extension, say), so a new one can start. Nothing is downloaded. It connects to no other native host.
```

**userScripts**

```
Runs cswap's import script, or for a copy made from the side panel its export script, unchanged, in the user's claude.ai tab, in a separate user-script world, after the extension's own page helper. Each script is the one the user's installed cswap ships; it reaches the extension through the native host, and its SHA-256 is checked against the job before it runs. The user turns on "Allow User Scripts" to permit this.
```

**storage**

```
Keeps the current job's state (for a copy made from the side panel, also the project list the page read to name the tab's project, and the id of the file window the job waits on), the settings, and a bounded log (at most 20,000 records, dropped after 72 hours by default) in chrome.storage.local, so the side panel can show them and a job survives a service worker restart. No credentials or request bodies are stored.
```

**sidePanel**

```
The side panel is the extension's only page: it shows the job's progress and waits, holds the Resume, Skip this step, Cancel and Confirm controls, and the three buttons of a copy: Export this project, Sign out and reload, and Import, with a name for the copy; where the export goes and which export to import are chosen in the computer's own Save As and Open windows.
```

**alarms**

```
Wakes the service worker to continue a scheduled wait (a fixed spacing before a write, or a Retry-After the site asked for) and to check for a queued job, because a Manifest V3 worker cannot keep a timer alive across its own restarts.
```

**notifications**

```
Shows one desktop notification when a job stops and needs the user (a check to pass, a sign-in, a step to send again or skip), when it is done or has failed, when an export made from the side panel is done (saying what to press next), and when its import could not be queued. Can be turned off in the side panel's settings.
```

**Host permission (https://claude.ai/*)**

```
The import, and an export made from the side panel, happen on claude.ai and nowhere else: a content script reports whether the tab shows a check or the sign-in page and, when the user presses Sign out and reload, makes claude.ai's own sign-out request in that tab (it reads nothing of the answer but its status, and then the tab goes to the sign-in page for the user to sign in); the import or export script runs in the claude.ai tab the user is signed in to. The extension requests no other site.
```

### Are you using remote code?

Answer **Yes**, with this justification. Remote code is any script not in
the package, and the import and export scripts are not in it: they come
from the cswap the user installed on their computer, through the native
host. They are never fetched from the network. Read "The import script is not in the package"
in `SUBMISSION.md` before submitting: it is the part of this listing most
likely to draw a question from review.

```
Yes, two scripts, and never from the network. The extension runs cswap's import script, and for a copy made from the side panel its export script (project-import.js and project-export.js in the claude-swap-cloud Python package), with chrome.userScripts.execute in the user's claude.ai tab. Each script comes from the cswap command line the user installed on their own computer, through the native messaging host the user registered; the extension checks its SHA-256 against the job before it runs, and the user enables "Allow User Scripts" for it. They are the same scripts cswap offers to paste into the console by hand; the extension saves the paste. No code is downloaded from any server, and no eval or new Function is used.
```

### Data usage

Tick these, and nothing else:

- **Personally identifiable information**: the email address of the
  claude.ai account the tab is signed in to, read from claude.ai to check
  it is the account the user named (or, for a copy made from the side
  panel, to record the account the project came from and the one it goes
  into), and reported to cswap on the user's computer.
- **Website content**: the project being copied (its files, text,
  conversations and memory), sent to claude.ai under the user's account,
  or read from it and saved on the user's computer, because that is the
  copy the user started; and, for a copy made from the side panel, the
  names of the projects the signed-in account can see, read to name the
  project the tab shows the way the site names it.

Leave unticked: health, financial and payment, authentication information
(no password, token or cookie is handled), personal communications, location,
web history, user activity.

### Certifications

Tick all three:

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL

`https://github.com/OpenSpineConsortium/claude-swap-privacy/blob/main/PRIVACY.md`

The public copy of `PRIVACY.md`, byte-equal to the one in this repository
and in the package; copy it there with every change (`SUBMISSION.md`,
section 5).

## Distribution tab

- Payments: free.
- Visibility: **Unlisted** to start (anyone with the link can install; it is
  not shown in search), then Public if wanted. Private works too, with a
  Google Group of testers.
- Regions: all.

## Test instructions tab

Username and password: leave empty (the extension has no account of its
own).

Additional instructions (500 characters at most):

```
Needs the cswap command line: uv tool install git+https://github.com/OpenSpineConsortium/claude-swap-cloud (ask for access if refused). Open the side panel: its Setup section lists each missing piece with the line to type. Turn on Allow User Scripts on the details page. Open a small Project on claude.ai and press Export this project; then Sign out and reload, sign in as another account and press Import. The scripts are minified, not obfuscated.
```
