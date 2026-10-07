# Store listing: cswap project import on the Chrome Web Store

Every field of the Chrome Web Store developer dashboard, in the order it
asks for them, with the text to paste (each block: copy all of it) or the
file to upload. `SUBMISSION.md` beside this file says what to do around the
paste and in what order; `TEST_BEFORE_UPLOAD.md` is the hand test before an
upload. Written 2026-10-05 for extension 0.1.0, revised 2026-10-06 for 0.2.0 and again for the import in a window of its own, and 2026-10-07 for the side panel's three buttons (Export this project, Sign out and reload, Import). Dashboards move their
fields around; the names below are the ones in use at the time of writing,
and the texts are what matter.

The texts describe the extension as it is built: keep them true. When the
extension changes what it touches, change the matching block here, the
privacy policy (`PRIVACY.md`, with its version) and the package together.

## Package tab

Upload the zip from the GitHub release: the newest build from `main` at
https://github.com/OpenSpineConsortium/claude-swap/releases/latest/download/cswap-import-chrome.zip
(signed in to GitHub), or a tag's release. `node extension/scripts/package.mjs
--build N` on that commit, with the pinned esbuild, builds the same bytes
by hand. Its scripts are minified: whitespace, comments and
local names, which the store's Code Readability Requirements allow; it is
not obfuscated or encrypted, which they forbid. The name and the summary
come from the package's manifest and are not typed:

- Name: `cswap project import`
- Summary (the manifest `description`, 126 characters; Chrome allows 132):
  `Copies a claude.ai Project between your own accounts, from a cswap export or with three buttons, one request at a time.`

## Store listing tab

### Description

```
cswap project import is the browser half of cswap's project-move: it copies a claude.ai Project from one of your own accounts into another, with nothing to paste.

Two ways to start. From the cswap command line on your computer (cswap project-move import --to NUM): the extension picks the job up in the claude.ai tab you are signed in to, checks that the tab is signed in as the account you named, and runs cswap's import script there. The script reads the export from your disk file by file, through cswap's own program on your computer, and makes the new project in your account.

Or from the side panel, with three buttons that are always in the same place. Open the project on claude.ai, signed in as the account that has it, and press Export this project: the extension runs cswap's export script on the project's page and saves the project into the exports folder on your computer through cswap. Press Sign out and reload: the tab makes claude.ai's own sign-out request and goes to the sign-in page, where you sign in as the other account yourself. Pick the export in the panel's one list if it is not the one just made (the exports on your computer, newest first), give the copy a name if you want one and press Import: cswap queues the import and the extension runs it in the same tab, into whichever account you signed in as, as from the command line. Any export on your computer can be imported this way at any time, so a move can be picked up at any step. When the tab is signed out, the import stops and asks you to sign in, then press Resume.

What it shows you, in a side panel:
- the three buttons, always in place (a press at the wrong moment is answered with why), the list of exports on your computer to import from, and the line to type when an import could not be queued;
- the job, the account it imports into or exports from, and the script's status line;
- the gate: one request at a time, a fixed spacing before each write (none by default before a read), and a countdown for every wait;
- Resume, Skip this step, Cancel and Confirm, each only when it applies;
- a log you can filter and save.

What it does when the site pushes back:
- When claude.ai asks the browser to pass a check, signs you out, or the tab is signed in as another account, the import stops and the panel says what happened and what to do. Nothing is retried on its own; you press Resume.
- When the site asks it to slow down, the full wait is honoured, never shortened.

What it never does: it does not read or write cookies, handle passwords or tokens, add or remove request headers, switch accounts, run on any site but claude.ai, or send anything to the developer. The one request it makes of its own, beside the scripts' own, is claude.ai's sign-out when you press Sign out and reload, and it reads nothing of the answer but whether it worked. There are no analytics. The log never keeps request bodies or query strings. cswap's registry is read only for an account named on the command line, never for a credential; the exports folder is listed for the panel's list, names and counts only.

Requires the cswap command line (Python; pipx install git+https://github.com/OpenSpineConsortium/claude-swap) and a one-time `cswap bridge install --register`, which lets Chrome talk to cswap on your computer; the side panel's Setup section shows each line to type. In Chrome 138 and newer, turn on "Allow User Scripts" on the extension's details page.

cswap is not an Anthropic product. "Claude" and "claude.ai" are Anthropic's marks, used here only to say which site the extension works with.
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
Copy a claude.ai Project between the user's own accounts, from the user's own claude.ai tab and under the user's control: import a project the user exported with the cswap command line into the signed-in account, or export the signed-in account's project to the user's computer through cswap and import it into another of the user's accounts.
```

### Permission justification

**nativeMessaging**

```
Talks to cswap's own program on the user's computer (the native host com.claude_swap.bridge, registered by the user with "cswap bridge install --register"). It hands the extension the import job the user queued, the import script and the export's files one at a time, and receives the import's progress for the command line. For a Duplicate it also hands over the export script and the list of the user's own cswap accounts (slot, email, organization; no credential), takes the export's files piece by piece as the script writes them, saving them in a folder on the user's computer, and queues the import of that export into the account the user chose. At the user's request it ends a job that another browser profile left behind (an earlier copy of this extension, say), so a new one can start. Nothing is downloaded. It connects to no other native host.
```

**userScripts**

```
Runs cswap's import script, or for a Duplicate its export script, unchanged, in the user's claude.ai tab, in a separate user-script world, after the extension's own page helper. Each script is the one the user's installed cswap ships; it reaches the extension through the native host, and its SHA-256 is checked against the job before it runs. The user turns on "Allow User Scripts" to permit this.
```

**storage**

```
Keeps the current job's state (for a Duplicate, also the project list the page read to name the tab's project, and the accounts offered for the user's choice), the settings, and a bounded log (at most 20,000 records, dropped after 72 hours by default) in chrome.storage.local, so the side panel can show them and a job survives a service worker restart. No credentials or request bodies are stored.
```

**sidePanel**

```
The side panel is the extension's only page: it shows the job's progress and waits, holds the Resume, Skip this step, Cancel and Confirm controls, and the three buttons of a Duplicate: Export this project, Sign out and reload, and Import, with the list of exports on the computer and a name for the copy.
```

**alarms**

```
Wakes the service worker to continue a scheduled wait (a fixed spacing before a write, or a Retry-After the site asked for) and to check for a queued job, because a Manifest V3 worker cannot keep a timer alive across its own restarts.
```

**notifications**

```
Shows one desktop notification when a job stops and needs the user (a check to pass, a sign-in, a step to send again or skip), when it is done or has failed, when a Duplicate's export is done (saying what to press next), and when its import could not be queued. Can be turned off in the side panel's settings.
```

**Host permission (https://claude.ai/*)**

```
The import, and a Duplicate's export, happen on claude.ai and nowhere else: a content script reports whether the tab shows a check or the sign-in page and, when the user presses Sign out and reload, makes claude.ai's own sign-out request in that tab (it reads nothing of the answer but its status, and then the tab goes to the sign-in page for the user to sign in); the import or export script runs in the claude.ai tab the user is signed in to. The extension requests no other site.
```

### Are you using remote code?

Answer **Yes**, with this justification. Remote code is any script not in
the package, and the import and export scripts are not in it: they come
from the cswap the user installed on their computer, through the native
host. They are never fetched from the network. Read "The import script is not in the package"
in `SUBMISSION.md` before submitting: it is the part of this listing most
likely to draw a question from review.

```
Yes, two scripts, and never from the network. The extension runs cswap's import script, and for a Duplicate its export script (project-import.js and project-export.js in the claude-swap Python package), with chrome.userScripts.execute in the user's claude.ai tab. Each script comes from the cswap command line the user installed on their own computer, through the native messaging host the user registered; the extension checks its SHA-256 against the job before it runs, and the user enables "Allow User Scripts" for it. They are the same scripts cswap offers to paste into the console by hand; the extension saves the paste. No code is downloaded from any server, and no eval or new Function is used.
```

### Data usage

Tick these, and nothing else:

- **Personally identifiable information**: the email address of the
  claude.ai account the tab is signed in to, read from claude.ai to check
  it is the account the user named (or, for a Duplicate, to record the
  account the project came from), and reported to cswap on the user's
  computer; and, for a Duplicate, the email addresses of the user's own
  cswap accounts, read from cswap's registry on the user's computer to
  offer them in the side panel.
- **Website content**: the project being imported or duplicated (its
  files, text and conversations), sent to claude.ai under the user's
  account, or read from it and saved on the user's computer, because that
  is the copy the user started; and, for a Duplicate, the names of the
  projects the signed-in account can see, read to name the project the
  tab shows the way the site names it.

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
Needs the cswap command line: pipx install git+https://github.com/OpenSpineConsortium/claude-swap (ask for access if refused). Open the side panel: its Setup section lists each missing piece with the line to type. Turn on Allow User Scripts on the details page. Open a small Project on claude.ai and press Export this project; then Sign out and reload, sign in as another account and press Import. The scripts are minified, not obfuscated.
```
