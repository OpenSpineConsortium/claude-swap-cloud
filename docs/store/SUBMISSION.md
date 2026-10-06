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
   `Gregory-Schwing-MD-PhD/claude-swap-privacy`: its `PRIVACY.md` is a
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
   `src/*.js`, `icons/` and `PRIVACY.md`; it is the same bytes for the same
   files. CI builds the same zip on every push and keeps it as the
   `cswap-import-chrome` artifact of the run, and a tag `extension-v<version>`
   makes the release (section 5).
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

1. Raise `version` in `extension/manifest.json` (and nowhere else: the
   extension reads it from the manifest), commit, push, let CI pass, merge
   to `main`. Change the listing texts and `PRIVACY.md` (with its version)
   in the same commit as any change to what the extension touches, and copy
   the new `PRIVACY.md` to the public home (section 0, step 2).
2. Tag the merge commit and push the tag:

   ```
   git tag extension-v<version>
   git push origin extension-v<version>
   ```

   `.github/workflows/release.yml` runs the extension's tests, builds the
   zip, refuses a tag that does not match the manifest's version, makes a
   GitHub release named after the tag with the zip and its `.sha256`
   attached, and, when the four `CWS_` secrets exist (section 6), uploads
   the zip to the store item as its draft. Without them it says
   "Not configured" and stays green.
3. The hand test, `TEST_BEFORE_UPLOAD.md`, on the zip from the release.
4. Submit the draft for review: in the dashboard, the item, **Submit for
   review**; or in Actions, "Release the extension", **Run workflow** with
   `publish` set to `trusted-testers` (the testers group of a private
   listing) or `everyone`. The workflow never submits on its own: a tag
   only uploads the draft. A refused upload (the usual reason: a version
   not above the published one) fails the run with the store's own words
   and nothing is retried; fix it and tag again.
5. Note the version, the date and the zip's SHA-256 (in the release) in the
   PR that shipped it.

Without CI, the dashboard still works as before: upload the zip from the
release (or from `node extension/scripts/package.mjs`) by hand.

## 6. Releasing from CI: the one-time setup

The upload and the submit go through the Chrome Web Store API with an
OAuth client and a refresh token of the developer account, kept as
repository secrets (Settings, Secrets and variables, Actions). Nothing
else sees them: `extension/scripts/publish.mjs` reads them from the
environment, never prints them, and the workflow passes them to that one
step. Until all four exist, the store step does nothing.

1. **The item id**: the first upload is by hand (section 1); the id the
   dashboard shows for the item (32 letters a to p) is `CWS_ITEM_ID`.
2. **An OAuth client**: in the Google Cloud console
   (https://console.cloud.google.com), with the Google account that owns
   the store item, make a project (any name), enable the **Chrome Web
   Store API** under APIs and services, Library, and set up the OAuth
   consent screen (External; add the same Google account as a test user).
   Then APIs and services, Credentials, **Create credentials, OAuth client
   ID**, type **Desktop app**. Its client id and client secret are
   `CWS_CLIENT_ID` and `CWS_CLIENT_SECRET`.
3. **A refresh token**, once, from the same account. Open in a browser,
   with the client id filled in:

   ```
   https://accounts.google.com/o/oauth2/v2/auth?client_id=<CLIENT_ID>&redirect_uri=http://localhost&response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&access_type=offline&prompt=consent
   ```

   Allow, and copy the `code=` value from the address bar of the page it
   lands on (a localhost page that does not load is expected). Then:

   ```
   curl -s -X POST https://oauth2.googleapis.com/token -d client_id=<CLIENT_ID> -d client_secret=<CLIENT_SECRET> -d code=<CODE> -d grant_type=authorization_code -d redirect_uri=http://localhost
   ```

   The answer's `refresh_token` is `CWS_REFRESH_TOKEN`. The code is good
   for minutes and once; the refresh token lasts until revoked, except that
   a consent screen left in "Testing" status expires its refresh tokens
   after seven days: publish the consent screen (it needs no verification
   for this one scope used by its own owner) or expect to repeat this step.
4. **Check without sending**: with the four variables in a shell,
   `node extension/scripts/publish.mjs --status` reads the item's draft
   state; `--upload --dry-run` prints the requests it would make.

Revoke the client or the token from the same console and the step goes
back to "Not configured".

## What stays out of the repository

The developer account's sign-in, the registration receipt, the OAuth
client's secret and the refresh token (repository secrets, never files),
and the store item id in any file (it is a secret too, to keep the
address of the private listing out of the repository). CI uploads to the
store only with those secrets, and submits for review only when a person
runs the workflow and says so.
