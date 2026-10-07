# Testing Claude Swap Cloud by hand before a store upload

The automated suites (`node --test "tests/js/extension/*.test.js"`, and
pytest) run the extension's modules against a mock claude.ai. This is the
check they cannot make: the zip that will be uploaded, loaded into a real
Chrome, importing into a real account. About twenty minutes.

## Once

- Chrome 138 or newer, with a profile signed in to claude.ai as an account
  cswap knows (`cswap list`).
- A small project to move: two files and a short instruction is enough.

## The pass

1. Download the zip and its `.sha256` from the GitHub release (the newest
   build from `main`, at the README's link); without CI, build it with
   `node extension/scripts/package.mjs --build N`. Note the SHA-256 the
   `.sha256` file gives.
2. Unzip it into an empty folder. `manifest.json` there must have no `key`,
   the version you mean to upload, and the six permissions and one host
   permission of `LISTING.md`; each `src/*.js` is one long minified line
   (a readable copy is `package.mjs --plain`, which is not what you upload).
3. In `chrome://extensions`, remove any unpacked Claude Swap Cloud, turn on
   Developer mode, **Load unpacked** the unzipped folder, and note the id
   Chrome gives it (it differs from the pinned one, as the store's will).
   Turn on **Allow User Scripts** on its details page.
4. `cswap bridge install --register --extension-id <that id>`, then
   `cswap bridge status`: everything ok.
5. Check the toolbar icon at 16 px and the details page icon look right, and
   open the side panel: "Bridge not checked yet", or "Bridge not connected"
   after a Check now, is fine until the next step.
   Before step 4, the Setup section must show the register line with this
   copy's id and a working Copy button; after it, Check now turns that step
   to done and the next one says to queue an import.
6. `cswap project-move export` on the small project, `cswap project-move
   check`, then `cswap project-move import --to <the account>`. Watch the
   panel: the job, the gate's spacing countdown before each write, the
   status line, Done, and the link to the new project. The terminal prints
   the same.
7. Open the new project on claude.ai: its files and instruction are there.
8. Open the small project in the tab and press **Export this project**.
   The tab reloads, the panel names the project and the account, and the
   computer's own Save As window opens with `<the project>.tar` suggested
   in the exports folder (the folder of the last export from then on):
   press Save. The export ends with "Export done" and a notification
   saying what to press next. Press **Sign out and reload**: the tab lands
   on the sign-in page; sign in there as the other account. Type a name
   for the copy and press **Import**: the Open window appears in the same
   folder; open the .tar just saved. The import runs in the tab as in
   step 6, the panel names the account the page is signed in as, and it
   ends with the new project's link. Then, with nothing running, press
   Import again and open the `export.json` inside the folder from step 6:
   it imports the same way. Once, close the Save As window without
   saving: the export ends cancelled with nothing written. Once, close the
   Open window without a choice: the panel says nothing was imported.
   Once, press Import while an export runs: the panel says a job is
   running and nothing starts; the three buttons stay where they are
   throughout. Once, press Export this project on a tab that is not on a
   project: the panel says what to open and nothing starts.
9. Press **Save log** in the panel and read the `.jsonl`, and read
   `bridge/driven-<job>.log`: no cookie, token, Authorization header,
   request body or query string.
10. Delete the test projects on claude.ai, remove the unpacked copy, and
   `cswap bridge install --register` again to return to the pinned id.

Upload the zip whose SHA-256 you noted in step 1, not one built later.
