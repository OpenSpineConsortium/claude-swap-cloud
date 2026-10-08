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
extension does for the Projects that live in the cloud; and on 2026-10-08
for the scripts carried in the package (no remote code, no Allow User
Scripts switch) and cswap on PyPI. Dashboards move
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

Three buttons in the side panel, always in the same place. Open the project on claude.ai, signed in as the account that has it, and press Export this project: your computer's own Save As window opens for where the export goes (one .tar file), and the extension runs its export script on the project's page and saves the project there through cswap. Press Sign out and reload: the tab makes claude.ai's own sign-out request and goes to the sign-in page, where you sign in as the other account yourself. Give the copy a name if you want one and press Import: your computer's own Open window appears; open the export to copy (the .tar just saved, or any export cswap made), and cswap queues the import and the extension runs it in the same tab, into whichever account you signed in as. Any export on your computer can be imported this way at any time, so a move can be picked up at any step. The command line works too: cswap project-move import --to NUM queues an import that the extension picks up in the claude.ai tab signed in as that account, after checking that it is.

What comes across. From a Claude Code project: its name, icon and colour, description, instructions, files, model and effort settings, and its repositories and linked folders where the new account may use them; its conversation, threads and session transcripts, as files the new project's Claude can read, since claude.ai cannot create those live; and, for each of its running sessions, the cswap teleport line that carries that session on under the new account. Its memory, what its Auto memory panel shows, comes across when claude.ai lets the export read it: written into the new project's own memory at the same paths where claude.ai takes it there, and otherwise as a file the new project's Claude can read, in a folder of its own; the import's last line names any memory that went to that folder. From a regular project: its name, description, instructions, knowledge files and documents, with every chat and the project memory added as documents. The import always makes a new, private project, and a copied Claude Code project arrives paused until you press Resume on its page; nothing in either account is changed or deleted.

What it shows you, in the side panel:
- the three buttons, always in place (a press at the wrong moment is answered with why), a name for the copy, and the line to type when an import could not be queued;
- the job, the account it imports into or exports from, and the script's status line;
- the gate: one request at a time, a fixed spacing before each write (none by default before a read), and a countdown for every wait;
- Resume, Skip this step, Cancel and Confirm, each only when it applies;
- a log you can filter and save.

What it does when the site pushes back:
- When claude.ai asks the browser to pass a check, signs you out, or the tab is signed in as another account, the import stops and the panel says what happened and what to do. Nothing is retried on its own; you press Resume.
- When the site asks it to slow down, the full wait is honoured, never shortened.

What it never does: it does not handle passwords, tokens or your sign-in, add or remove request headers, switch accounts, run on any site but claude.ai, or send anything to the developer. The only cookie it looks at is claude.ai's lastActiveOrg, which names the organization the site is showing, read by the import when your account belongs to more than one so the copy goes there. Beside the scripts' own requests it asks claude.ai only which account the tab is signed in to (and, for an export, the account's list of projects, to name the one the tab shows), and makes claude.ai's sign-out request when you press Sign out and reload, reading nothing of that answer but whether it worked. There are no analytics. The log never keeps request bodies or cookies, and names each request by its path. Every script it runs is in its package; nothing is downloaded. cswap's registry is read only for an account named on the command line, never for a credential; the Save As and Open windows are your computer's own, opened by cswap, which keeps only the folder the last one used.

Requires the cswap command line from Claude Swap Cloud (Python 3.12 or newer; uv tool install claude-swap-cloud, or pipx install claude-swap-cloud) and a one-time cswap bridge install --register, which lets Chrome talk to cswap on your computer; the side panel's Setup section shows each line to type, with this extension's id filled in.

Claude Swap Cloud is an independent tool. It is not made, endorsed or sponsored by Anthropic, and it is not an Anthropic product. "Claude", "Claude Code" and "claude.ai" are Anthropic's marks, used here only to say which site and which product the extension works with.
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
Talks to cswap's own program on the user's computer (the native host com.claude_swap.bridge, registered by the user with "cswap bridge install --register"). It hands the extension the import job the user queued and the export's files one at a time, and receives the import's progress for the command line. For a copy made from the side panel it also opens the computer's own Save As window for where the export goes and takes the export's files piece by piece as the script writes them, saving them in that one .tar on the user's computer; and it opens the computer's own Open window for the export to import, reads the export the user opened and queues its import into the account the user is signed in as. The extension never learns what was chosen in those windows beyond the export's own path. At the user's request it ends a job that another browser profile left behind, so a new one can start. No code passes through it, and nothing is downloaded. It connects to no other native host.
```

**scripting**

```
Runs the extension's own page helper and then its import script, or for a copy made from the side panel its export script, in the user's claude.ai tab, in the extension's isolated world, with chrome.scripting.executeScript and files from the package: only when the user has queued an import or pressed Export this project or Import. The scripts are the same ones the cswap command line offers to paste into the console by hand; the extension saves the paste. Nothing is fetched or evaluated.
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

Answer **No, I am not using remote code**. Every script the extension runs
is a file in its package (`src/page.js`, `src/project-import.js`,
`src/project-export.js`, injected with `chrome.scripting.executeScript({
files })`); nothing is fetched from the network or handed over by the
native host to be run, and there is no `eval` or `new Function`
(`SUBMISSION.md`, section 3). If a reviewer asks, this is the answer:

```
No remote code. The page helper and the import and export scripts are files in the package (src/page.js, src/project-import.js, src/project-export.js), injected with chrome.scripting.executeScript({ files }) in the extension's isolated world. The native host passes data only (the job, the export's files, the progress), never code. There is no eval or new Function.
```

### Data usage

Tick these, and nothing else:

- **Personal communications**: the conversations of the project being
  copied (its chats, or a Claude Code project's conversation and
  threads), read from claude.ai into the export on the user's computer,
  or uploaded from it to claude.ai as files of the new project.
- **Web history**: the address (without its query) and the title of the
  claude.ai pages the extension runs on, to know which project the tab
  shows and whether a check or the sign-in page is showing; kept on the
  user's computer.
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
(no password, token or sign-in cookie is handled), location, user activity.

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
Needs Python 3.12+ and the cswap command line: uv tool install claude-swap-cloud (or pipx install claude-swap-cloud). Open the side panel: Setup shows the register line with this item's id. Open a small Project on claude.ai, press Export this project and save the .tar; then press Import and open it. One account is enough: the copy goes into the account signed in. Scripts are minified, not obfuscated.
```
