# Testing cswap project import by hand before a store upload

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
3. In `chrome://extensions`, remove any unpacked cswap import, turn on
   Developer mode, **Load unpacked** the unzipped folder, and note the id
   Chrome gives it (it differs from the pinned one, as the store's will).
   Turn on **Allow User Scripts** on its details page.
4. `cswap bridge install --register --extension-id <that id>`, then
   `cswap bridge status`: everything ok.
5. Check the toolbar icon at 16 px and the details page icon look right, and
   open the side panel: "Bridge not connected" until the next step is fine.
   Before step 4, the Setup section must show the register line with this
   copy's id and a working Copy button; after it, Check now turns that step
   to done and the next one says to queue an import.
6. `cswap project-move export` on the small project, `cswap project-move
   check`, then `cswap project-move import --to <the account>`. Watch the
   panel: the job, the gate's spacing countdown before each write, the
   status line, Done, and the link to the new project. The terminal prints
   the same.
7. Open the new project on claude.ai: its files and instruction are there.
8. Press **Duplicate a project** on the small project, choose another
   account and **In its own window, like the command line**. A console
   window opens, then a Chrome window for that account (sign in there the
   first time); the panel shows the window's last lines and, at the end,
   the new project's link. Close the console part-way through once: the
   panel says the window closed without a word, and Carry on (or Try
   again) starts it once more. Quit Chrome part-way through once and note
   whether the console window outlives it (it should, when Chrome lets the
   bridge start it outside its own job). `cswap bridge status` shows the
   import in its own window.
9. Press **Save log** in the panel and read the `.jsonl`, and read
   `bridge/driven-<job>.log`: no cookie, token, Authorization header,
   request body or query string.
10. Delete the test projects on claude.ai, remove the unpacked copy, and
   `cswap bridge install --register` again to return to the pinned id.

Upload the zip whose SHA-256 you noted in step 1, not one built later.
