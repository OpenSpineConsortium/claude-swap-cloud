# Store listing: cswap project import on the Chrome Web Store

Every field of the Chrome Web Store developer dashboard, in the order it
asks for them, with the text to paste (each block: copy all of it) or the
file to upload. `SUBMISSION.md` beside this file says what to do around the
paste and in what order; `TEST_BEFORE_UPLOAD.md` is the hand test before an
upload. Written 2026-10-05 for extension 0.1.0, revised 2026-10-06 for 0.2.0. Dashboards move their
fields around; the names below are the ones in use at the time of writing,
and the texts are what matter.

The texts describe the extension as it is built: keep them true. When the
extension changes what it touches, change the matching block here, the
privacy policy (`PRIVACY.md`, with its version) and the package together.

## Package tab

Upload `extension/.output/cswap-import-<version>-chrome.zip`, made by
`node extension/scripts/package.mjs` (or downloaded from the CI run's
`cswap-import-chrome` artifact of the commit being released). The name and
the summary come from the package's manifest and are not typed:

- Name: `cswap project import`
- Summary (the manifest `description`, 126 characters; Chrome allows 132):
  `Imports a claude.ai Project that the cswap command line exported into the account you are signed in to, one request at a time.`

## Store listing tab

### Description

```
cswap project import is the browser half of cswap's project-move: it copies a claude.ai Project from one of your own accounts into another, with nothing to paste.

You start it from the cswap command line on your computer (cswap project-move import --to NUM). The extension picks the job up in the claude.ai tab you are signed in to, checks that the tab is signed in as the account you named, and runs cswap's import script there. The script reads the export from your disk file by file, through cswap's own program on your computer, and makes the new project in your account.

What it shows you, in a side panel:
- the job, the account it imports into, and the script's status line;
- the gate: one request at a time, a fixed spacing between requests, and a countdown for every wait;
- Pause, Resume, Retry, Give up and Cancel, each only when it applies;
- a log you can filter, save and clear.

What it does when the site pushes back:
- When claude.ai asks the browser to pass a check, signs you out, or the tab is signed in as another account, the import stops and the panel says what happened and what to do. Nothing is retried on its own; you press Resume.
- When the site asks it to slow down, the full wait is honoured, never shortened.

What it never does: it does not read or write cookies, handle passwords or tokens, add or remove request headers, run on any site but claude.ai, or send anything to the developer. There are no analytics. The log never keeps request bodies or query strings.

Requires the cswap command line (Python; pipx install git+https://github.com/Gregory-Schwing-MD-PhD/claude-swap) and a one-time `cswap bridge install --register`, which lets Chrome talk to cswap on your computer; the side panel's Setup section shows each line to type. In Chrome 138 and newer, turn on "Allow User Scripts" on the extension's details page.

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
- Homepage URL: `https://github.com/Gregory-Schwing-MD-PhD/claude-swap-privacy`
- Support URL: `https://github.com/Gregory-Schwing-MD-PhD/claude-swap-privacy/issues`

The source repository is private, so the three links (these two and the
privacy policy below) point at its public companion, which holds the
policy and takes questions (`SUBMISSION.md`, section 0).

### Mature content

No.

## Privacy practices tab

### Single purpose

```
Import a claude.ai Project that the user exported with the cswap command line into the claude.ai account the user is signed in to, from the user's own claude.ai tab, under the user's control.
```

### Permission justification

**nativeMessaging**

```
Talks to cswap's own program on the user's computer (the native host com.claude_swap.bridge, registered by the user with "cswap bridge install --register"). It hands the extension the import job the user queued, the import script and the export's files one at a time, and receives the import's progress for the command line. It connects to no other native host.
```

**userScripts**

```
Runs cswap's import script, unchanged, in the user's claude.ai tab, in a separate user-script world, after the extension's own page helper. The script is the one the user's installed cswap ships; it reaches the extension through the native host, and its SHA-256 is checked against the job the user queued before it runs. The user turns on "Allow User Scripts" to permit this.
```

**storage**

```
Keeps the current job's state, the settings, and a bounded log (at most 20,000 records, dropped after 72 hours by default) in chrome.storage.local, so the side panel can show them and an import survives a service worker restart. No credentials or request bodies are stored.
```

**sidePanel**

```
The side panel is the extension's only page: it shows the import's progress and waits, and holds the Pause, Resume, Retry, Give up and Cancel controls.
```

**alarms**

```
Wakes the service worker to continue a scheduled wait (a fixed spacing between requests, or a Retry-After the site asked for) and to check for a queued job, because a Manifest V3 worker cannot keep a timer alive across its own restarts.
```

**notifications**

```
Shows one desktop notification when an import stops and needs the user (a check to pass, a sign-in, a step to retry), and when it is done or has failed. Can be turned off in the side panel's settings.
```

**Host permission (https://claude.ai/*)**

```
The import happens on claude.ai and nowhere else: a content script reports whether the tab shows a check or the sign-in page, and the import script runs in the claude.ai tab the user is signed in to. The extension requests no other site.
```

### Are you using remote code?

Answer **Yes**, with this justification. Remote code is any script not in
the package, and the import script is not in it: it comes from the cswap
the user installed on their computer, through the native host. It is never
fetched from the network. Read "The import script is not in the package"
in `SUBMISSION.md` before submitting: it is the part of this listing most
likely to draw a question from review.

```
Yes, one script, and never from the network. The extension runs cswap's import script (project-import.js in the open source claude-swap Python package) with chrome.userScripts.execute in the user's claude.ai tab. The script comes from the cswap command line the user installed on their own computer, through the native messaging host the user registered; the extension checks its SHA-256 against the job the user queued, and the user enables "Allow User Scripts" for it. It is the same script cswap offers to paste into the console by hand; the extension saves the paste. No code is downloaded from any server, and no eval or new Function is used.
```

### Data usage

Tick these, and nothing else:

- **Personally identifiable information**: the email address of the
  claude.ai account the tab is signed in to, read from claude.ai to check
  it is the account the user named, and reported to cswap on the user's
  computer.
- **Website content**: the project being imported (its files, text and
  conversations), sent to claude.ai under the user's account because that
  is the import the user started.

Leave unticked: health, financial and payment, authentication information
(no password, token or cookie is handled), personal communications, location,
web history, user activity.

### Certifications

Tick all three:

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL

`https://github.com/Gregory-Schwing-MD-PhD/claude-swap-privacy/blob/main/PRIVACY.md`

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
Needs the cswap command line: pipx install git+https://github.com/Gregory-Schwing-MD-PhD/claude-swap (ask for access if refused). Open the side panel: its Setup section lists each missing piece with the line to type (the bridge line carries the extension's id). Turn on Allow User Scripts on the details page. Sign in to claude.ai, export a small Project with cswap project-move export, run cswap project-move import --to NUM, and watch the panel. The package is the full source.
```
