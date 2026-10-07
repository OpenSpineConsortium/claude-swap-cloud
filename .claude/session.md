# Session checkpoint

Written by hand at the hand-over of 2026-10-07 (about 20:00 UTC), when greg
moved this work to another Claude account. The earlier session's project
memory and shared files stay behind on the old account, so everything the
next session needs is in this file. Branch: `claude/claude-swap-cloud-rename-1xp8ha`,
pull request #37 (https://github.com/OpenSpineConsortium/claude-swap-cloud/pull/37).

## Original request

- greg, 2026-10-07 16:40 UTC: rename the package and repository to "Claude
  Swap Cloud", make the store listing advertise what cswap does for the
  cloud-based Claude Projects, and say how the public can use the extension
  without access to the private repository. Done (PR #36, privacy PR #6).
- greg, 2026-10-07 19:50 UTC, the request still open: "i still think i need
  to make a pr to get the cswap code onto pypi? that still needs to happen
  even if its still exposing the code to the user, because i dont want to
  make the github public and i dont want to force users to enable user
  scripts".

## Completed work

- Done: PR #36 (merged): distribution `claude-swap-cloud`, every user-facing
  name "Claude Swap Cloud"; the `cswap` command, module `claude_swap`, native
  host `com.claude_swap.bridge`, extension id `jhplijnbeejmlgmephlhckpggocpmefp`
  and the data folders stayed. Privacy PR #6 (merged): PRIVACY.md version 10
  in OpenSpineConsortium/claude-swap-privacy, byte-equal to this repository's.
- Done: PR #37 on this branch, open, not merged, groundwork only:
  `scripts/build_public_wheel.py` (turns the plain wheel into one wheel per
  Python version, every module a hash-based `.pyc` in place, no `.py`, the
  extension's code taken minified from the store zip), `tests/test_public_wheel.py`,
  a tag-only `.github/workflows/publish.yml` (tag `v<version>` equal to
  pyproject's version; matrix 3.12, 3.13, 3.14; installs and runs the wheel;
  PyPI trusted publishing, environment `pypi`, no token), a proprietary
  `LICENSE` with upstream's MIT notice kept, and `tests/js/extension/release.test.js`
  holding publish.yml to a tag. At 19:52 UTC its CI had test, macos-keychain
  and extension-package green, test-windows still running.
- Done: a port of the export and import logic from the browser scripts into
  Python was started and dropped (greg stopped it at 19:39 UTC; at 19:50 he
  accepted that the scripts are exposed). None of it is in the repository.

## Current implementation state

- The builder still REFUSES any wheel carrying `claude_swap/browser/*.js`
  (`BROWSER_SCRIPT` in `scripts/build_public_wheel.py`, in `convert` and
  `check`; `test_a_wheel_with_the_browser_scripts_is_never_built`). So no tag
  can publish yet. The CLAUDE.md layout bullet for the builder says the same.
- The extension still needs Chrome's "Allow User Scripts" toggle: the worker
  injects with `chrome.userScripts.execute` into the `USER_SCRIPT` world.
- Version is `0.27.0b1`; the install lines still name the git repository,
  which the public cannot reach (private).

## Architectural decisions

- Decision: cswap is published on PyPI as `claude-swap-cloud`, bytecode-only
  wheels, and the browser scripts ship in the wheel even though they are then
  readable or merely minified (greg, 2026-10-07 19:50 UTC).
- Decision: the repository stays private (greg).
- Decision: the extension must work without the person turning on "Allow
  User Scripts" (greg, 2026-10-07 19:50 UTC). Planned design: the extension
  carries byte-equal copies of `src/claude_swap/browser/project-export.js`
  and `project-import.js`, and the worker injects `page.js` and the chosen
  script with `chrome.scripting.executeScript` (files from the package) into
  the ISOLATED content-script world; the manifest swaps the `userScripts`
  permission for `scripting`. This overrides the CLAUDE.md constraint that
  lists `userScripts` and forbids `scripting`; update that constraint and the
  "runs in the USER_SCRIPT world" decision in CLAUDE.md in the same PR.
- Decision: the Python port of the scripts is not wanted any more.

## Remaining tasks

All in PR #37 on this branch (check first that greg has not merged it; if he
has, restart the branch from main and open a new PR).

Next: A. The extension without "Allow User Scripts".
1. Copy the two scripts into `extension/src/` (for example
   `extension/src/project-export.js`, `project-import.js`), unchanged, and add
   a test that holds them byte-equal to `src/claude_swap/browser/`. The
   originals stay read-only (CLAUDE.md constraint). Check that
   `extension/scripts/package.mjs` puts them in the store zip and that
   minifying them is safe.
2. `extension/manifest.json` and `PERMISSIONS` in `extension/scripts/package.mjs`:
   `userScripts` becomes `scripting`; `tests/js/extension/package.test.js`.
3. `extension/src/background.js`: line 831 injects the boot code and
   `src/page.js` with `chrome.userScripts.execute({ js: [{ code }, { file }] })`;
   use `chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED',
   func: boot => { globalThis.__cswapBoot = boot; }, args: [boot] })`, then
   `files: ['src/page.js']`. Line 972 injects `script.text` from the bridge's
   `script.get`; use `files: [the packaged copy for job.kind]`. Decide whether
   the worker still calls `script.get` (it lets the bridge check the job's
   script sha; a mismatch would mean cswap and the extension carry different
   script versions) or drops it. Remove the `userScriptsOk` gating and
   `configureWorld` (lines about 206, 568, 584, 607-612, 2003, 2178,
   2350-2364, 2450, 2507, 2544). page.js connects with
   `chrome.runtime.connect({ name: 'cswap-page' })`; in the isolated world
   that reaches `runtime.onConnect`, not `runtime.onUserScriptConnect`
   (line 2454): route the port by name there and keep every sender, tab, url
   and nonce check. `WORLD` in `extension/src/protocol.js:16` is
   `'USER_SCRIPT'`. page.js shares the isolated world with content.js; their
   only top-level names are `createPageHelper` and `createContent`, so no
   clash. page.js defines `__cswapImport` with `configurable: false` under
   `'use strict'`, so a second injection into the same document would throw:
   confirm every job reloads the tab before injecting, as it does today.
4. `extension/src/setup.js` (lines 71-82, the "Allow User Scripts in Chrome"
   step) and `extension/src/sidepanel.js` (156-157, 199, 208, 535): drop the
   step and the gating. Tests: `tests/js/extension/setup.test.js` (20
   mentions), `scaffold.test.js` (93 mentions, the chrome.userScripts stubs),
   `integration.test.js`.
5. Python: `src/claude_swap/bridge.py` (3570 logs the hello's `userScripts`;
   4524 tells the person to turn the toggle on) and `src/claude_swap/cli.py`
   (428, 491, 2302, 2312 tell the person to turn it on): drop those texts,
   keep reading an older extension's hello. Tests: `tests/test_bridge.py`,
   `test_bridge_duplicate.py`, `test_project_move_bridge.py`,
   `test_extension_scripts.py`, `test_cli.py`.
6. Docs: README.md (415), extension/README.md (35, 45, 319, 422), CLAUDE.md,
   docs/store/LISTING.md (118-121 the userScripts justification becomes a
   scripting one; 164 the remote-code answer: the scripts now come from the
   extension's own package, not from cswap), docs/store/SUBMISSION.md (70,
   103-105, 122), docs/store/TEST_BEFORE_UPLOAD.md (27). The store images
   (`extension/store-assets/src/scenes.mjs:18` has `userScripts: true`) may
   show the Setup line that goes away; redraw them if so. PRIVACY.md does not
   name user scripts or the permission list (checked), so it needs no new
   version for this.
7. Hand test in Chrome with the toggle off: Export this project, Sign out
   and reload, Import.

Next: B. The real PyPI release.
1. `scripts/build_public_wheel.py`: stop refusing `browser/*.js`. Either ship
   them readable, or take `project-export.js` and `project-import.js`
   minified from the store zip (they will be in it after A). `automation.js`
   is evaluated over the DevTools protocol by `project_move_auto.py`; leave
   it readable unless a test proves a minified copy behaves the same. Widen
   `EXTENSION_CODE` (`^(src/[a-z]+\.js|sidepanel\.html)$` misses hyphenated
   names like `src/project-export.js`). Update `tests/test_public_wheel.py`,
   the publish.yml header comment and the CLAUDE.md bullet.
2. `pyproject.toml`: version `0.28.0`.
3. `src/claude_swap/update_check.py` docstring: it no longer expects a 404.
4. Install lines: `extension/src/setup.js` gets `PACKAGE = 'claude-swap-cloud'`,
   `INSTALL_LINES` `uv tool install claude-swap-cloud` and `pipx install
   claude-swap-cloud`, `UPGRADE_LINES` `uv tool upgrade claude-swap-cloud`
   and `pipx upgrade claude-swap-cloud`, `REINSTALL_LINES` `uv tool install
   --force --reinstall claude-swap-cloud` and `pipx install --force
   claude-swap-cloud`; `SOURCE_REPO` stays for the panel's links. Same lines
   in `tests/js/extension/setup.test.js`, README.md (install section),
   docs/store/LISTING.md (61, 219), docs/store/SUBMISSION.md, CLAUDE.md.
5. Run the checks below, push, mark PR #37 ready when CI is green.

Next: C. greg's own steps, to tell him when PR #37 is ready.
1. pypi.org: an account with two-factor authentication on.
2. pypi.org, Account settings, Publishing, Add a new pending publisher,
   GitHub: project `claude-swap-cloud`, owner `OpenSpineConsortium`,
   repository `claude-swap-cloud`, workflow `publish.yml`, environment `pypi`.
3. Merge PR #37, then on main: `git tag v0.28.0` and `git push origin v0.28.0`.
   The publish workflow builds and publishes; afterwards anyone can run
   `uv tool install claude-swap-cloud`.
4. On greg's PC (Windows, PowerShell, cswap is a uv tool):
   `uv tool uninstall claude-swap-cloud` (or `claude-swap`, whichever
   `uv tool list` shows), `uv tool install claude-swap-cloud`,
   `cswap bridge install --register --extension-id jhplijnbeejmlgmephlhckpggocpmefp`,
   then reload the unpacked extension.

## Known blockers

- Blocker: the Claude GitHub App had no access to the renamed repository, so
  pull-request events did not reach the session; CI was checked by hand. greg
  installs or extends it at https://github.com/apps/claude/installations/select_target
  (both repositories: claude-swap-cloud and claude-swap-privacy).
- Blocker: the Chrome Web Store item does not exist yet. greg uploads the
  newest release zip by hand, then sets the five `CWS_` secrets and the
  repository variable `CWS_ON_PUSH` for automatic uploads
  (`.github/workflows/release.yml`).
- Blocker: PRIVACY.md says the extension never reads cookies, but
  `project-import.js` reads `document.cookie` (`lastActiveOrg`, around lines
  704-712) for accounts with several organizations, and page.js takes it in
  the extension flow (around 1059-1062). Fix the wording (PRIVACY.md version
  11 in both repositories, byte-equal) before the store submission.
- Blocker: for the release kit to be callable from other repositories, greg
  sets Settings, Actions, General, Access, "Accessible from repositories in
  the 'OpenSpineConsortium' organization".

## Important constraints

- Constraint: no model name in commits, PR titles or bodies.
- Constraint: CI has four jobs (Ubuntu, Windows, macOS, store zip), about 9
  minutes. In a cloud container running as root, a few CLI and TUI tests
  fail locally with "Do not run this script as root"; CI passes them.
  `-m "not xdist_group"` leaves out the real-browser tests.
- Constraint: greg merges within minutes of green and wants short replies;
  re-check a PR's state before pushing more to it.
- Constraint: a bridge job left by an earlier press blocks new jobs ("An
  import is already queued or running"); greg deletes
  `%USERPROFILE%\.claude-swap-backup\bridge\job.json` or presses "Drop that job".
