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
2. **The privacy policy is public.** `PRIVACY.md` must answer at
   `https://github.com/Gregory-Schwing-MD-PhD/claude-swap/blob/main/PRIVACY.md`
   without signing in: merge this branch into `main`, and keep the
   repository public. A reviewer who gets a 404 there rejects the item.
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
   `cswap-import-chrome` artifact of the run.
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
   extension reads it from the manifest), commit, push, let CI pass.
2. `node extension/scripts/package.mjs`, then `TEST_BEFORE_UPLOAD.md`.
3. Dashboard, the item, **Package**, **Upload new package**, then **Submit
   for review**. Change the listing texts and `PRIVACY.md` in the same
   commit as any change to what the extension touches.
4. Note the version, the date and the zip's SHA-256 (from its `.sha256`
   file) in the PR or the release that shipped it.

## What stays out of the repository

The developer account's sign-in, the registration receipt, and any
upload credentials. Nothing in CI uploads to the store; the upload is done
by hand in the dashboard.
