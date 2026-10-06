# Submitting cswap project import to the Chrome Web Store

For the maintainer. `LISTING.md` beside this file is the paste sheet: every
dashboard field with the text to paste or the file to upload. This file says
what to do around it, in order. `TEST_BEFORE_UPLOAD.md` is the hand test
that comes before every upload. Written 2026-10-05 for extension 0.1.0, revised 2026-10-06 for 0.2.0.

## 0. Before the first submission

1. **The developer account.** At
   https://chrome.google.com/webstore/devconsole, sign in with the Google
   account that will own the item, pay the one-time registration fee, verify
   the contact email, and turn on 2-Step Verification for that account (the
   store requires it to publish).
2. **The privacy policy is public.** The store reads the policy at the URL
   in the listing without signing in, and a reviewer who gets a 404 there
   rejects the item. This repository is private (greg, 2026-10-06), so the
   policy's public home is the public repository
   `OpenSpineConsortium/claude-swap-privacy`: its `PRIVACY.md` is a
   byte-equal copy of the one here, copied there in the same release as any
   change here (section 5), and the listing's homepage, support and privacy
   links all point at it (`LISTING.md`, "URLs"). Create that repository
   empty and public once; nothing else goes in it.
3. **The package.** With the version raised in `extension/manifest.json`
   (every upload needs a higher version than the last) and committed:

   ```
   node extension/scripts/package.mjs
   ```

   It checks the manifest (Manifest V3, the six permissions and the one host
   permission and nothing else, the name, description and version limits,
   the four icons, every file the manifest names, every module a script
   imports, plain ASCII with LF endings) and writes
   `extension/.output/cswap-import-<version>-chrome.zip` and its `.sha256`.
   The zip holds `manifest.json` without its `key`, `sidepanel.html`,
   `src/*.js` minified, `icons/` and `PRIVACY.md`; it is the same bytes for
   the same files and the same esbuild (pinned in `package.mjs`, fetched
   through npx or named by `CSWAP_ESBUILD`). Minifying is what the store's
   Code Readability Requirements allow (whitespace, comments, names);
   obfuscation and encryption are what they forbid, and a reviewer rejects
   them, so the zip has neither, and no source map. `--plain` packages the
   readable sources instead, for a look, not for upload. CI builds the same
   zip on every push and keeps it as the `cswap-import-chrome` artifact of
   the run, and a tag `extension-v<version>` makes the release (section 5).
4. **The images.** The ones in `extension/store-assets/` are drawn from the
   real side panel; draw them again after a change to the panel or the
   icon (`extension/store-assets/manifest.txt`). Look at each one before
   uploading it.
5. **The hand test**, `TEST_BEFORE_UPLOAD.md`, on the zip you are about to
   upload.

## 1. The item, the first time

1. In the dashboard, **Add new item** and upload the zip. The store gives
   the item its own id (32 letters a to p) and shows it in the dashboard and
   in the item's URL. Write it down: it is the store item id below.
2. Fill in the Store listing, Privacy practices, Distribution and Test
   instructions tabs from `LISTING.md`, field by field.
3. **Submit for review.** Choose "Publish automatically after review" or
   defer it; the first review of an item with `nativeMessaging` and
   `userScripts` can take days, and the reviewer may write back (section 3).

## 2. The store item's id and the bridge

The unpacked extension's id is pinned by the `key` in
`extension/manifest.json` (`jhplijnbeejmlgmephlhckpggocpmefp`, in
`extension/README.md`), and `cswap bridge install --register` writes that id
into the native host's `allowed_origins`. The store does not accept a
package with a `key`, so `package.mjs` leaves it out, and the store item has
a different id. Chrome refuses a native host whose `allowed_origins` does
not name the extension that connects, so a copy installed from the store
connects only after:

```
cswap bridge install --register --extension-id <the store item id>
```

`cswap bridge status` then shows the store id as the registered one. One
host manifest names one id, so a profile with both the unpacked copy and the
store copy connects only the one registered last. The side panel's Setup
section (extension 0.2.0) prints that line with the copy's own id filled
in, so a person installing from the store copies it from there; the README
says the same. Until cswap knows the store id by itself (a follow-up once
the id exists: a constant in `bridge.py` beside the pinned one, and both in
`allowed_origins`), that is the install step for the store copy.

## 3. The import script is not in the package

The one part of this listing most likely to draw a question from review.
The extension runs cswap's `project-import.js`, which reaches it through
the native host from the cswap the person installed, not from the package
(`extension/README.md`; CLAUDE.md, "Decisions"). The store counts any
script that is not in the package as remote code, and Manifest V3's rules
allow it only where it is the user's own code run through the userScripts
API, which is the case argued in `LISTING.md`'s answer: the person
installed cswap, queued the job and turned on "Allow User Scripts", the
extension checks the script's SHA-256 against the job, and nothing is
fetched from a network.

If review refuses that, the way out is a change to the extension, not to
the texts: ship `project-import.js` inside the package (copied by
`package.mjs` from `src/claude_swap/browser/`), run that copy with
`{ file: ... }` instead of `{ code: ... }`, and have the bridge send only
the script's SHA-256 so the extension can refuse a cswap whose script
differs from the package's. That trades the remote-code question for a
version lock between the store copy and cswap, so it waits for a refusal.

## 4. When a reviewer writes back

Answer in the dashboard's thread, with the facts in `LISTING.md`. The usual
questions and where the answer is:

- "Why nativeMessaging / userScripts?": the permission justifications.
- "Remote code": section 3 above, and the answer under "Are you using remote
  code?".
- "We could not test it": the Test instructions; offer a short screen
  recording of an import of a two-file project, made on the build that was
  uploaded.

## 5. Every later release

Once the secrets exist (section 6) and the repository variable
`CWS_ON_PUSH` is set, a release is a merge to `main`:

1. Change the extension, the listing texts and `PRIVACY.md` (with its
   version) together, and copy the new `PRIVACY.md` to the public home
   (section 0, step 2). Raise `version` in `extension/manifest.json` when
   you mean a new version; it is not needed for every push (next step).
2. Merge to `main`. When the merge changes what the zip holds (the
   manifest, `sidepanel.html`, `src/`, `icons/`, `PRIVACY.md` or the
   packager), `.github/workflows/release.yml` runs the extension's tests,
   builds the zip as version `<manifest>.<commit count>` (the manifest's
   version with one more integer, so every build from `main` is above the
   last one without a commit that only raises the manifest), makes a
   GitHub release `extension-v<that version>` with the zip and its
   `.sha256` attached, and then does what `CWS_ON_PUSH` says:
   - `upload`: the zip becomes the store item's draft, and nothing is
     submitted. Submit it yourself after the hand test (step 3), in the
     dashboard or with **Run workflow** and `publish` ticked.
   - `publish`: the draft is submitted for review as well, and goes out
     once review passes, with the visibility the item has in the dashboard
     (Private to the testers group, Unlisted or Public; the API cannot
     change that).
   - unset or `off`: nothing is released; CI still tests the push.

   Runs never overlap: a second push while one is being released waits its
   turn, and a third replaces the waiting one, so the store always gets the
   newest.
3. The hand test, `TEST_BEFORE_UPLOAD.md`, on the zip from the release,
   before a draft is submitted (with `publish` it is submitted at once, so
   test on a branch or with the unpacked folder first).
4. What the run says, and what to do:
   - "Not configured": a secret is missing; the run stays green and the
     store was not called.
   - A refused upload (the usual reason: a version not above the published
     one, as when a tag repeats a version a push already released) fails
     the run with the store's own words and nothing is retried; raise the
     manifest's version or push to `main` again.
   - "still processing": the store took the package but had not made it
     the draft within five minutes, so nothing was submitted; run
     `--status` later, then **Run workflow** with `publish` ticked.
   - A store step that failed after the release was made: **Re-run failed
     jobs**, or **Run workflow** on `main` with `upload` ticked; a re-run
     of the whole workflow attaches the files to the release that exists.
5. Note the version, the date and the zip's SHA-256 (in the release) in the
   PR that shipped it.

Two other ways run the same workflow: a tag (`git tag extension-v<version>`
on the commit, `git push origin extension-v<version>`) releases the
manifest's exact version, refusing a tag that does not match it; and
**Run workflow** in Actions, with `upload` and/or `publish` ticked, on any
branch or tag. `--staged` on the script holds an approved package until it
is published by hand. Without CI, the dashboard still works as before:
upload the zip from the release (or from
`node extension/scripts/package.mjs`) by hand.

## 6. Releasing from CI: the one-time setup

The upload and the submit go through the Chrome Web Store API, version 2
(version 1 ends on 15 October 2026), with an OAuth client and a refresh
token of the developer account, kept as repository secrets (Settings,
Secrets and variables, Actions). Nothing else sees them:
`extension/scripts/publish.mjs` reads them from the environment, never
prints them, and the workflow passes them to that one step. Until all
five exist, the store step does nothing. The steps follow Google's own
page, https://developer.chrome.com/docs/webstore/using-api, which has the
screenshots; read it beside this.

1. **The ids**: the first upload is by hand (section 1); the item's id
   (32 letters a to p, in the dashboard and the item's URL) is
   `CWS_ITEM_ID`, and the publisher id under **Publisher, Settings** in the
   dashboard is `CWS_PUBLISHER_ID`.
2. **An OAuth client**: in the Google Cloud console
   (https://console.cloud.google.com), with the Google account that owns
   the store item, make a project (any name) and enable the **Chrome Web
   Store API** (APIs and services, Library). Set up the OAuth consent
   screen: External, your email as the contact and as a test user. Then
   APIs and services, Credentials, **Create credentials, OAuth client ID**,
   type **Web application**, with
   `https://developers.google.com/oauthplayground` added to the authorized
   redirect URIs. Its client id and client secret are `CWS_CLIENT_ID` and
   `CWS_CLIENT_SECRET`.
3. **A refresh token**, once, from the same account, in the OAuth 2.0
   Playground (https://developers.google.com/oauthplayground): the gear
   icon, "Use your own OAuth credentials", the client id and secret; under
   "Input your own scopes" `https://www.googleapis.com/auth/chromewebstore`;
   **Authorize APIs**, allow; then **Exchange authorization code for
   tokens**. The `refresh_token` it shows is `CWS_REFRESH_TOKEN`. A consent
   screen left in "Testing" status gives refresh tokens that expire after
   seven days: publish the consent screen (Publishing status, Publish app)
   or expect to repeat this step every week. Google does not verify apps
   that hold the store's write scope, so **Authorize APIs** then shows
   "Google hasn't verified this app" for your own client: Advanced, then
   "Go to <name> (unsafe)", is the expected way through; nobody but you
   ever signs in to it.
4. **Check without sending**: with the five variables in a shell,
   `node extension/scripts/publish.mjs --status` reads the item's state
   (what is published, what is under review, the last upload); `--upload
   --dry-run` prints the requests it would make and sends nothing.
5. **The switch**: a repository variable (Settings, Secrets and variables,
   Actions, the **Variables** tab) named `CWS_ON_PUSH`, set to `upload` or
   `publish` (section 5). It is a variable, not a secret, so its value is
   readable in the workflow's conditions. Leave it unset until the first
   upload by hand (section 1) has given the item its id.

Revoke the client or the token from the same console and the step goes
back to "Not configured". If the item is ever opted in to Verified CRX
Uploads, the API wants a signed `.crx` instead of the zip, which this
script does not make; leave that opt-in off.

## What stays out of the repository

The developer account's sign-in, the registration receipt, the OAuth
client's secret and the refresh token (repository secrets, never files),
and the publisher and item ids in any file (secrets too, to keep the
address of the private listing out of the repository). CI uploads to the
store only with those secrets, and submits for review only when the
repository variable `CWS_ON_PUSH` says `publish` or a person runs the
workflow and ticks it.
