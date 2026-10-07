# Claude Swap Cloud

Claude Swap Cloud is `cswap`, the multi-account switcher for Claude Code, with the cloud added. It switches between your Claude accounts without logging out (or switches for you before you hit a rate limit), tracks every account's usage in a live dashboard, runs accounts in parallel, and moves what lives in the cloud between your accounts: your claude.ai Projects, the redesigned Claude Code projects with their threads as well as regular projects, and your cloud sessions. Works with both the Claude Code CLI and the VS Code extension.

It is a fork of [realiti4/claude-swap](https://github.com/realiti4/claude-swap), which stays on PyPI as `claude-swap`; both install the same `cswap` command, so keep one of them.

## Installation

This fork is not on PyPI; install it from the repository. The repository is private for now, so a GitHub sign-in with access to it is needed, which git asks for.

### Using uv (recommended)

```bash
uv tool install git+https://github.com/OpenSpineConsortium/claude-swap-cloud
```

### Using pipx

```bash
pipx install git+https://github.com/OpenSpineConsortium/claude-swap-cloud
```

### From source

```bash
git clone https://github.com/OpenSpineConsortium/claude-swap-cloud.git
cd claude-swap-cloud
uv sync
uv run cswap help
```

### Updating

```bash
cswap upgrade          # uv/pipx installs on macOS/Linux: auto-detects and upgrades
# or run your installer directly:
uv tool upgrade claude-swap-cloud
pipx upgrade claude-swap-cloud
```

`cswap upgrade` runs the installer's own upgrade, which follows the branch the install remembered, so the sure way to the current code is a reinstall from the repository:

```bash
uv tool install --force --reinstall git+https://github.com/OpenSpineConsortium/claude-swap-cloud
# or
pipx install --force git+https://github.com/OpenSpineConsortium/claude-swap-cloud
```

If you use the Chrome extension, run `cswap bridge install --register` again after a reinstall: the bridge's launcher names the installed copy's Python.

## Usage

### Add your first account

Log into Claude Code with your first account, then:

```bash
cswap add
```

### Add more accounts

Log in with another account, then:

```bash
cswap add
```

Do not run `/logout` first: current Claude Code may revoke the refresh token stored for the account you are leaving.

### Switch accounts

Rotate to the next account:

```bash
cswap switch
```

Or switch to a specific account:

```bash
cswap switch 2
cswap switch user@example.com
cswap switch dev                # or by alias, once set with `cswap alias 2 dev`
```

Not sure which one? `cswap list` is the dashboard — every account's 5-hour and 7-day usage and reset times at a glance:

```bash
cswap list
```

Or let cswap auto-pick by remaining quota — `cswap switch --strategy best` (most quota left) or `--strategy next-available` (skip rate-limited accounts).

**Note:** You usually don't need to restart — on Linux/Windows the new account is picked up automatically, and on macOS after the Keychain cache expires. To apply it instantly, restart Claude Code or reopen the VS Code extension tab. See [Tips](#tips) for the per-platform details.

### Automatic switching

Let cswap watch your usage and switch for you. When the active account's 5-hour or 7-day window reaches the threshold (default 90%), it switches to the account with the most quota left — before you hit the limit, and safe to run while Claude Code is working:

```bash
cswap auto                     # foreground loop, polls every 60s
cswap auto --threshold 80      # switch earlier
cswap auto --model Fable       # also switch when the Fable weekly limit is hit
cswap auto --once              # single check-and-switch, for cron/scripts
cswap auto --dry-run           # log what it would do, never switch
cswap auto --strategy consume-first   # burn the soonest-resetting account first
```

<details>
<summary>How it behaves & advanced usage</summary>

- Runs safely alongside Claude Code: switches take the same credential locks Claude Code uses, so a swap never collides with a token refresh.
- A cooldown (default 5 min) and a hysteresis margin stop it flip-flopping near the threshold: a proactive switch only lands on an account that's below the threshold *and* better than the current one by the margin — a candidate that clears the margin is always taken, but two accounts hovering at the line never ping-pong. When every account is exhausted it keeps checking on a bounded slow cadence, waking sooner for an imminent reset.
- **Strategies** (`--strategy`, or `cswap config set autoswitch.strategy`): `best` (default) stays put until the active account nears its limit, then moves to the account with the most quota left. `consume-first` proactively keeps you on the account whose **weekly window resets soonest** — use-it-or-lose-it — switching to a sooner-resetting account (with room to spare) even below the threshold, so perishable weekly quota isn't wasted.
- Usage polling is adaptive — a couple of accounts per check, busy alternates watched more closely, and exhausted ones checked about every ten minutes (or slower after 429s) — so API traffic stays flat no matter how many accounts you manage.
- It fails safe: if a usage check errors it keeps trusting the last-known numbers while retries back off, and an expired token on an idle machine makes it hold rather than fail over (Claude Code refreshes the token on your next message).
- An account whose refresh token has died is quarantined and reported until you either log in with it and re-run `cswap add --slot N`, or replace its stored credentials from a known-good export — a plain `cswap import backup.cswap` replaces dead-token slots on its own (`--force` is still required to replace other existing accounts; note a stale export can carry an already-superseded token). API-key accounts are never rotated onto unless you pass `--include-api-key-accounts`.
- To hold an account out of rotation yourself — a work account you don't want touched, one you're resting — run `cswap disable <num|email>`; `cswap enable <num|email>` puts it back. Disabled accounts are skipped by auto-switch, bare `cswap switch`, and the `best` / `next-available` strategies, but stay fully managed and remain a valid explicit `cswap switch <num|email>` target. They show a `(disabled)` marker in `cswap list`, in the [TUI](#interactive-dashboard-tui), and in the [menu bar](#menu-bar-macos) — both of which also let you toggle the state in place (TUI: menu → *Disable / enable account…*; menu bar: *Disable / enable account*).
- By default only the account-wide 5h/7d windows drive switching. If you work on one model and hit its **weekly per-model limit** first (e.g. Fable), add `--model Fable` (or `cswap config set autoswitch.model Fable`) to fold that model's window into the decision, so it switches off an account whose model quota is spent even while its 5h/7d windows still have room.
  - **Model names** are Anthropic's own per-model `display_name`s, matched case-insensitively. The exact strings for your accounts are the per-model rows in `cswap list` (e.g. a line reading `Fable: 100%`).

For cron/systemd timers, `--once` reports the outcome in its exit code (`0` switched, `1` error, `2` nothing to do, `3` blocked — no viable target), and `--json` emits one JSON event per line:

```bash
*/5 * * * * cswap auto --once --json >> ~/.cswap-auto.log 2>&1
```

Defaults like the threshold and cooldown are configurable with `cswap config set autoswitch.threshold 80` — flags override them (see [Configuration](#configuration)).

</details>

### Run multiple accounts at the same time (session mode)

Launch Claude Code as a specific account in the current terminal only — every other terminal and the VS Code extension stay on your default account, so two accounts can work in parallel.

```bash
cswap run 2                     # launch Claude Code as account 2, here only
cswap run user@example.com      # by email
cswap run 2 -- --resume         # everything after '--' is forwarded to claude
cswap run 2 --share-history     # share your chat history with this account too
cswap run 2 --require-session   # refuse rather than run plain claude if 2 is the default login
```

Sessions use your normal `~/.claude` setup (settings, CLAUDE.md, skills, MCP servers, etc.), but each account keeps its own chat history — pass `--share-history` if you want your accounts to continue the same conversations.

Running the account that is already your default login launches plain `claude` on that login instead of a session (a second copy of the active credential would go stale). Scripts that need the isolation guaranteed can pass `--require-session`, which refuses in that case instead.
  
A session refreshes its own copy of the account's token, so once it exits, the credential it rotated is captured back into the account's stored backup before a switch or usage check uses that backup. While a session is still running, `cswap switch` refuses to move the default login onto its account if the stored backup has already fallen behind (activating it could only fail); exit the session first, or pick another account. While a session runs, its account's usage is read with the session's own credential and never refreshed by cswap; a read the server refuses shows as token expired, and is not requested again, until the session renews the credential on its next call.

<details>
<summary>Sharing details — MCP servers & chat history</summary>

- With `--share-history`, a session started under one account shows up in `--resume` under the others, and nothing already saved is lost.
- User-scope MCP servers (`claude mcp add -s user`) are mirrored from your default profile on every launch — manage them there; changes made inside a session don't persist. Definitions are copied as-is (including inline `env`/`headers` values), but MCP OAuth logins are not — HTTP servers may ask you to authenticate once per profile via `/mcp`.
- `--no-share` turns sharing off and removes the mirrored MCP config (profiles that never mirrored are left alone).

</details>

<details>
<summary>Map accounts to directories — auto-pick per repo</summary>

Bind a directory to an account, and a bare `cswap run` there launches that account in session mode — e.g. work account in work repos, personal elsewhere:

```bash
cswap map 2 ~/work/client-app   # map a directory to account 2
cswap map user@example.com      # map the current directory
cswap map                       # list mappings
cswap unmap ~/work/client-app   # remove one (defaults to current directory)

cd ~/work/client-app/src
cswap run                       # → account 2, session mode
```

Subfolders inherit the nearest mapped ancestor. In an unmapped directory, `cswap run` just launches plain `claude` with your default login. Mappings are per-machine (not part of `cswap export`) and are cleaned up when their account is removed.

</details>

### Move a cloud session to another account (experimental)

Cloud sessions belong to one claude.ai account. `cswap teleport` pulls one down as the owning account and starts a new cloud session as another, from inside a clone of the session's repository:

```bash
cswap teleport --from 1 --to 2 session_01AbC...              # pull, push the branch, hand off
cswap teleport --from 1 --to 2 session_01AbC... -m "finish the tests"
cswap teleport --from 1 --to 2 --skip-teleport               # already pulled; push and hand off
cswap teleport --from 1 --to 2 --skip-teleport --dry-run     # print the steps and preview the note
cswap teleport --from 1 --to 2 session_01AbC... -- --permission-mode bypassPermissions  # args after -- go to every claude launch
```

It runs `claude --teleport` as account 1 (exit claude to continue), commits a handoff note at `.claude/handoff/<session-id>.md`, pushes the branch with `git push -u origin`, then runs `claude --cloud` as account 2 with "Read that note first, then: <task>". Both run in session mode, so your default login never changes. The conversation itself cannot move between accounts, so the note is the only context the new session gets. It is built from account 1's local transcript without a model call (the original request, the newest turns, where the work stopped, files touched, recent commands and the branch's commits; tool output left out, credential-like strings redacted, capped at 12 KB), and anyone with access to the repository can read it. `--handoff-in-prompt` puts it in the prompt instead of the repository, `--summarize` also asks the old session for a written summary (spending account 1's quota), and `--no-handoff` skips it. `--checkpoint` commits the session checkpoint (`.claude/session.md` and the `CLAUDE.md` section, see below) instead of a note, and tells the new session to read that first. Both accounts must be claude.ai logins (API-key accounts are refused), and account 2 needs GitHub access to the repository for the cloud session to clone the branch.

In PowerShell, when `cswap` is a PowerShell function or alias (not a `.cmd`/`.exe` launcher), quote the separator (`'--'`), since PowerShell drops a bare `--` before cswap sees it. The same applies to `cswap run`.

### Interactive dashboard (TUI)

Run `cswap` on its own (or `cswap tui`) for the full-screen dashboard: live usage for every account, switching, and the auto-switcher, all keyboard-driven. `cswap watch` opens it straight to the live monitor. Works on macOS, Linux, and Windows.

<img src="assets/tui-watch.png" width="760" alt="cswap watch — live 5h/7d usage bars for every account, with reset times and the active account marked">

### Refresh expired tokens

If an account's token expires, log back into Claude Code with that account and re-run:

```bash
cswap add
```

This will update the stored credentials without creating a duplicate.

### Other commands

```bash
cswap run 2                     # Run an account in this terminal only (session mode)
cswap teleport --from 1 --to 2  # Move a cloud session to another account (see above)
cswap auto                      # Auto-switch when nearing rate limits (see above)
cswap config                    # Show or edit settings (see Configuration below)
cswap list                      # Show all accounts with 5h/7d usage and reset times
cswap list --token-status       # Add source-labelled OAuth token diagnostics
cswap status                    # Show current account
cswap add --slot 3              # Add account to a specific slot (prompts before overwrite)
cswap add --alias dev           # Add account and give it a short alias
cswap remove 2                  # Remove an account
cswap disable 2                 # Hold an account out of auto-rotation (keeps its login)
cswap enable 2                  # Return a disabled account to rotation
cswap alias 2 dev               # Give an account a short alias (usable anywhere NUM|EMAIL is)
cswap alias 2 --unset           # Remove an account's alias
cswap alias                     # List all aliases
cswap move 2 1                  # Assign an account to a slot (relocates to an empty slot, swaps if taken)
cswap project-move              # Move a claude.ai Project to another account (see Advanced below)
cswap project-move auto         # ... with no clicks: two sign-ins, once, and cswap does the rest
cswap bridge install --register # Set up the Chrome extension that moves a project without a paste
cswap checkpoint write          # Keep .claude/session.md from the local transcript (see Advanced below)
cswap unclaimed                 # List stashed credential entries (slot + why they were stashed)
cswap unclaimed --purge ID      # Drop one (deletes its bytes; recover with /login + `cswap add`)
cswap tui                       # Interactive dashboard (also: bare `cswap`)
cswap watch                     # Dashboard, opened on the live watch page
cswap upgrade                   # Upgrade cswap to the latest version
cswap purge                     # Remove all cswap data
```

The original flag spellings (`cswap --switch`, `cswap --list`, ...) keep working.

## Tips

- **Do you need to restart after switching?** Usually not. On **Linux and Windows**, credentials are stored in a file and Claude Code re-reads them whenever that file changes, so the new account takes effect on your next message — no restart needed. On **macOS**, credentials live in the Keychain, which Claude Code caches for about 30 seconds; a running session picks up the switch once that cache expires. Restart Claude Code (or close and reopen the VS Code extension tab) only if you want the change to apply instantly.
- **Continuing sessions after switching:** You can keep using the same Claude Code session after switching — run `cswap switch` in any terminal and carry on. If you'd prefer a clean start, close and reopen Claude Code (or the VS Code extension tab) and use `--resume` to pick your previous session. Either way, the first message on the new account may use extra usage as its conversation cache rebuilds.

## How it works

- Backs up OAuth tokens and config when you add an account
- Swaps only the account-specific Claude login when you switch accounts;
  live account-independent OAuth state (such as MCP server logins) is
  preserved instead of being overwritten by a slot's older snapshot
- Account credentials stored securely using platform-appropriate methods
- Switches (manual and automatic) hold Claude Code's own credential locks while writing, so a swap never interleaves with a token refresh
- Auto-switch freshens a target's token before activating it, and quarantines accounts whose refresh token has died (recover by re-adding it with `cswap add --slot N`, or by replacing its stored credentials from a known-good export — a plain `cswap import backup.cswap` replaces dead-token slots automatically)
- Usage numbers refresh every few minutes — faster for an account being used or close to switching, slower for idle ones — keeping cswap comfortably inside Anthropic's rate limits however many dashboards you keep open on a machine. An age note like `· 6m ago` just means the next scheduled check hasn't come yet, not that something is stuck.

## Data locations

| Platform | Credentials | Config backups |
|----------|-------------|----------------|
| Windows | File-based (inside the backup directory, under `credentials/`) | `~/.claude-swap-backup/` |
| macOS | macOS Keychain | `~/.claude-swap-backup/` |
| Linux / WSL | File-based (inside the backup directory, under `credentials/`) | `${XDG_DATA_HOME:-~/.local/share}/claude-swap/` |

Session-mode profiles (`cswap run`) live under the backup directory in `sessions/`. Tool preferences (`settings.json`) and auto-switch state (`autoswitch_state.json` — cooldown and quarantined accounts; delete it to reset) live in the backup directory root.

`cswap project-move` keeps its place in `project-move.json` and a copy of its scripts and prompts in `project-move/`, both in the backup directory; `project-move auto` keeps its accounts and project in `project-move-auto.json` and the browser profiles it signs in with (one per account, with that account's claude.ai sign-in) under `browser-profiles/`, so `cswap purge` takes those sign-ins away too. The Chrome extension's bridge keeps its host manifest, launcher, the current import job and its events under `bridge/` in the backup directory, and, for an export imported in a window of its own (`cswap project-move auto --export`), that import's output as `bridge/driven-<job>.log`. The projects it exports are saved outside it, in `~/claude-project-exports` unless you choose another folder, and `cswap purge` leaves them alone.

On Linux/WSL, set `XDG_DATA_HOME` to override the default location.

## Menu bar (macOS)

<details>
<summary>Optional macOS menu bar app — usage at a glance, click to switch</summary>

Needs the `menubar` extra (macOS only):

```bash
uv tool install 'claude-swap-cloud[menubar] @ git+https://github.com/OpenSpineConsortium/claude-swap-cloud'
# or: pipx install 'claude-swap-cloud[menubar] @ git+https://github.com/OpenSpineConsortium/claude-swap-cloud'
cswap menubar
```

Shows every account's 5h / 7d / spend usage and switches with a click (specific / rotate / best / next-available), plus the TUI's add / disable-enable / remove / refresh actions. Enable *Settings → Auto-switch accounts* to run the same engine as [`cswap auto`](#automatic-switching) in the background; it shares the `autoswitch.*` settings, so the menu bar and CLI stay in sync. Off until you turn it on.

**Keep it running without a terminal.** `cswap menubar` runs in the foreground, so the status item dies with the terminal that started it and does not come back after a reboot. `--install-service` hands it to launchd instead — starts at login, restarts on crash, no `.app` bundle:

```bash
cswap menubar --install-service     # start now, and at every login
cswap menubar --service-status      # installed? loaded? pid?
cswap menubar --uninstall-service   # stop it and remove the plist
```

The agent lives at `~/Library/LaunchAgents/com.cswap.menubar.plist` and logs to `~/Library/Logs/com.cswap.menubar.{log,err}`. It pins the `cswap` console script, whose path survives an upgrade — but the running process keeps the old build until it restarts, so after `cswap upgrade` either re-run `--install-service` or `launchctl kickstart -k gui/$(id -u)/com.cswap.menubar`.

</details>

## Advanced

### Configuration

Tool preferences live in `settings.json` in the backup root; `cswap config` reads and edits it with validation, so you never have to find the file or guess valid ranges.

<details>
<summary>Commands & usage</summary>

```bash
cswap config                              # list effective settings ("(default)" = not set)
cswap config get autoswitch.threshold
cswap config set autoswitch.threshold 80  # validated: rejects out-of-range values loudly
cswap config set autoswitch.model Fable   # per-model switching (see "auto"); Fable,Opus for several
cswap config unset autoswitch.threshold   # back to the default
cswap config path                         # where settings.json lives
```

`cswap config --help` lists every key with its valid range and default. Hand-editing the file still works — `cswap config` is just a safer front door. `list` and `get` take `--json` for scripting.

</details>

### Backup and migration

Move account data between machines or back it up:

```bash
cswap export backup.cswap                    # All accounts to a file
cswap export backup.cswap --account 2        # One account
cswap export backup.cswap --full             # Include full ~/.claude.json and credential object (same-PC backup)
cswap import backup.cswap                    # Skips accounts that already exist
cswap import backup.cswap --force            # Overwrite existing
```

The export file is plaintext JSON and, by default, carries only each account's own login — machine-shared MCP/plugin OAuth tokens and the device token stay on the source machine (`--full` keeps everything, for same-PC backups). If you need encryption, pipe through your tool of choice (e.g. `cswap export - | gpg -c > backup.gpg`).

If an imported account is the one you're currently logged in as, activate the imported credentials with `cswap switch N --force` (a plain `switch` to the current account is a safe no-op and won't touch the import).

### Move a claude.ai Project between accounts

`cswap project-move` copies a claude.ai Project to another account: a regular project (`claude.ai/project/...`) or a Claude Code project (`claude.ai/code/project/...`). claude.ai has no export or import of its own, so the copying is done in your browser, where you are already signed in, by two scripts that ship with cswap. One saves the project into a folder on your computer; the other makes a new project from that folder. cswap never signs in to claude.ai itself: it hands you the right script at each stage, checks the exported folder, and keeps track of where you are.

```bash
cswap project-move export   # 1. copy the export script; run it on the project's page (source account)
cswap project-move check    # 2. confirm that everything was saved
cswap project-move import   # 3. copy the import script; run it on claude.ai (destination account)
cswap project-move          #    the step list, with what is done
```

`export` and `import` each copy a script to the clipboard, open claude.ai, and print what to do there, with the folder to choose:

1. In **Chrome or Edge**, sign in to claude.ai with the right account: the one that has the project for `export`, the one that should get it for `import`. A second browser profile lets you stay signed in to both. (Other browsers cannot hand a folder to a web page.)
2. For `export`, open the project. Then press F12 (Cmd+Option+J on macOS), choose the **Console** tab, paste, and press Enter. The first time, the browser asks you to type `allow pasting` first.
3. Press the button that appears in the corner of the page, **Export Claude Project** or **Import Claude Project**, and choose the folder cswap printed. The page shows its progress and says "Done" at the end.

Exports are saved in `~/claude-project-exports`, one folder per project (`--folder DIR` to save somewhere else; it is remembered). The import shows what it is about to create and asks for a name first, and says so there if the original project is in the account you are signed in as (the usual sign of having pasted into the wrong account). It always makes a **new, private** project: nothing that already exists in either account is changed or deleted, so the original stays as it was until you delete it yourself.

<details>
<summary>What comes across, and what does not</summary>

| | Regular project | Claude Code project |
|---|---|---|
| Comes across | Name, description, instructions, knowledge files and documents | Name, icon and colour, description, instructions, the project's own files under the same paths, its memory (as files under `carried-memory/`), model and effort settings, and its repositories and linked folders where the new account may use them |
| Old conversations | Every chat and the project memory, added as knowledge documents (`Chat history – ...`, `Project memory (from the original project)`) | The timeline, threads and session transcripts, added as files under `imported-history/` |
| Left for you to set up | Sharing, and anything connected from another service | Sharing and members, the environment sessions run in, browser access, routines, and the GitHub and Google Drive connections its linked folders need |

- Old conversations cannot come back as live chats or threads, because claude.ai has no way to create those. They come back as text the new project's Claude can read.
- A Claude Code project's linked folders and repositories are links, not copies: the new account reads them through its own Google Drive and GitHub connections, which an import cannot make. Each one is linked on its own, so one the new account cannot reach is reported by name and costs only itself; connect the service in the new account and add it again.
- Sessions cannot move into the new project, but `imported-history/README.md` lists each one with the `cswap teleport --from <old> --to <new> session_...` line that carries it on, live, under the new account (see [Move a cloud session to another account](#move-a-cloud-session-to-another-account-experimental)). Members of the original are not added; the import says how many there were.
- A Claude Code project arrives **paused**, so that its Claude does nothing until you have looked the project over. Press **Resume** at the bottom of the project's page when you are ready.
- A Claude Code project's memory, what its Auto memory panel shows (`MEMORY.md` and one file per fact), is read by the export and saved under `Memory/` in the export folder. The import adds it to the new project as ordinary files under `carried-memory/` (`carried-memory-2/` when the project's own files already hold a `carried-memory/` from an earlier move), at the same paths, where the new project's Claude can read it; it does not write the new project's own memory, which starts empty. The export reads it with the requests the project's Auto memory panel makes (asked again naming the memory beta when the first is refused). Where those do not give the memory's list, it falls back to the memory store the requests Claude Code makes would read: the store the project's own data names, or, only when that names none, a store the page asked for after it showed the project, and its README then says so, for you to check. When the memory is still missing, the export's README says why, and the console lists the requests that were refused; opening the Auto memory panel first does not change that, since the export already makes the panel's requests. Moving the project by prompt (below) puts the memory back as memory instead.
- Files attached to single messages are not put into the new project. For a regular project they are saved in the export folder, next to their chat.
- Files over 30 MB are left out and listed when the import ends; add those by hand.
- The scripts make the same requests claude.ai's own pages make, which are not a published API. If the site changes, a script stops and shows the server's reason; the console (F12) has the details.

</details>

**With no clicks at all.** `cswap project-move auto` does the same move in browser windows it opens and drives itself (Chrome or Edge, through their DevTools port): one window per account, each on a browser profile of its own that keeps its sign-in. The first time, a plain browser window opens for each account in turn, on a page that says in blue which account it is for, with a button to claude.ai's sign-in page: sign in there as that account, and that is the last thing it ever asks (the window closes by itself a few seconds after the sign-in, about ten on Windows, or sooner if you close it; closing it without signing in ends the run). One window is open at a time: each sign-in window in turn, then the source window for the export, then the destination window for the import; leave the working window alone, and if it is closed anyway cswap opens it again and starts that step over. (That window is started without any automation attached, because Google refuses to sign in to a browser that has a DevTools port open; the driven windows come afterwards, on the sign-in the profile now holds.) That window always opens on the sign-in page: a profile found signed in as someone else, or as nobody claude.ai will name, is signed out first, and a sign-in made there as the wrong account is refused and signed out again, with the terminal saying which account the window was for. It then runs the export in the source window, saves the project into the exports folder as the page writes it (no folder window, no download), and runs the import in the destination window. claude.ai sometimes puts its security check ("Performing security verification") in front of a driven window, where it does not pass: cswap then closes that window and opens a plain one in its place, saying so in blue, for you to pass the check in as you would in any browser (tick its box if it shows one); once claude.ai shows one of its own pages there, past the check, the window closes and the driven one comes back. cswap does nothing to the check itself, and if it comes straight back, cswap stops and says so, naming the way on (the same scripts in your own browser, with `cswap project-move export` and `import`). An import that stops part-way (the check, a closed window, the script's own stop) leaves the new project with what was added by then, and the next `cswap project-move auto` carries on in that project with the export already made: what is there is left alone, the rest is added, and nothing is made twice (`--into` names such a project yourself, `--new` makes a new one instead; a regular project cannot be carried on in, so the next run makes a new one and says so).

```bash
cswap project-move login --from 2 --to 1          # optional: just the two one-time sign-ins
cswap project-move auto beethoven --from 2 --to 1 # export as account 2, import as account 1
cswap project-move auto                           # later: the same move again, nothing to pass
cswap project-move auto --export ~/claude-project-exports/beethoven --to 1  # import an export you have
```

The project is its name, its claude.ai address, or its id; with one project in the account it can be left out. `--name` names the new project, `--browser PATH` picks the browser, `--keep-open` leaves the destination window up afterwards. The accounts and the project are remembered, and `cswap project-move` shows the move among its steps. claude.ai's "Continue with email" works in the sign-in window too. The scripts the windows run are the ones above, unchanged, so a move by hand still works the same way.

An export you already have, one that `cswap project-move export` saved or the extension's Duplicate made, is imported on its own with `--export` and the export's folder (or the .tar it was saved as): only the destination window opens, nothing is exported, no `--from` is needed, and the new project takes the export's own name unless `--name` gives another. The export is checked first, as `check` checks it, and one that is not whole is refused with the reason. `--to` is the account to import into (the remembered destination when it is left out); the remembered accounts and project are not changed, since this is not a whole move. An import of it that stops part-way says the line that carries on in the project it made, which is the same `--export` line: it carries on there because the export is the same, and a project left part-way is never carried on in with another export (a plain `cswap project-move auto` of another export makes a new project instead, and says so).

`check` reads the `export.json` that each export ends with and confirms that every file it lists is in the folder. It exits 0 when an export is ready and 2 when none is; `check --wait` keeps looking until one is. An export saved before the current move began is listed but not used unless you name it: `cswap project-move check --folder "<its folder>"`. The scripts are also written under `project-move/` in the backup root, for when no clipboard tool is available; `--print` shows them, `--no-open` keeps the browser closed.

<details>
<summary>By prompt instead: let each project's own Claude do the move</summary>

The scripts bring a Claude Code project's memory across as files; the project's own Claude can put it back as memory. So there is a second way to move one, done from inside the projects: name the GitHub repository the project is attached to, as `owner/name` (not the project's name; both accounts must be able to reach it), and the same three stages hand out two prompts instead of two scripts, one pasted in each project's chat, with a branch of that repository as the carrier.

```bash
cswap project-move export owner/name   # 1. copy the export prompt; paste it in the OLD project's chat (source account)
cswap project-move check --wait        # 2. poll GitHub until the export branch is pushed
cswap project-move import              # 3. copy the import prompt; paste it in the NEW project's chat (destination account)
```

Between 2 and 3, create a new project under the destination account on the same repository. The export thread pushes `.claude/project-export/` (chat, threads, memory, files, instructions) to the `project-export` branch (`--branch` to change); the import thread restores memory and files and keeps the old chat under `notes/project-history/` for reference. Old threads come across as read-only text, and artifacts, routines, connectors and project settings must be set up again by hand.

If the repository is public, the export is public too; `export` warns when it is. `check` reads GitHub anonymously; pass `--token` (or set `GITHUB_TOKEN`) for a private repository. `export` with a repository begins a move by prompt and `export` without one a move by script; `check` and `import` carry on with whichever is under way.

</details>

#### Import without pasting (Chrome extension)

The move can run without the paste: Claude Swap Cloud's Chrome extension, a small extension that ships with cswap (the `extension/` folder), runs the same import script in the claude.ai tab you are signed in to, one request at a time, and reports back to the command line; its **Export this project** button runs the export too, so the whole move happens from the side panel, with three buttons. Three one-time steps:

1. In Chrome (135 or newer), open `chrome://extensions`, turn on Developer mode, press **Load unpacked** and choose the `extension/` folder (`cswap bridge --help` prints where it is).
2. On the extension's card, turn on **Allow User Scripts**.
3. Run `cswap bridge install --register`, which writes a native-messaging host manifest and a launcher into the backup directory's `bridge/` folder and registers them with Chrome.

The packaged extension, the one the Chrome Web Store gets, is built by CI: every merge to `main` that changes the extension tests it, builds the store zip and keeps it as a GitHub release, so the newest build is always at https://github.com/OpenSpineConsortium/claude-swap-cloud/releases/latest/download/claude-swap-cloud-chrome.zip, with its SHA-256 beside it as `claude-swap-cloud-chrome.zip.sha256`. The [releases page](https://github.com/OpenSpineConsortium/claude-swap-cloud/releases) lists every build by version, the manifest's version with the commit count as one more number. That zip is byte for byte what the release workflow uploads to the store (its upload step prints the same SHA-256). The links need a GitHub sign-in with access, since the repository is private. To build the same bytes by hand, run `node extension/scripts/package.mjs --build N` on that commit with the pinned esbuild named by `CSWAP_ESBUILD`, N being the commit count the version ends with.

Then name the destination account:

```bash
cswap project-move import --to 2            # into Account-2, through the extension
cswap project-move import --to 2 --name "Symphony"
cswap project-move import --watch           # reattach after Ctrl+C
cswap project-move import --cancel          # stop the import under way
cswap bridge status                         # what is installed, and the current job
```

cswap queues a job with the export and the account's email and organization from its own registry, opens claude.ai, and follows the import: each phase, the script's status line, every wait with its reason and length, every stop, the new project's link, and the script's own closing account. The extension first checks that the tab is signed in as that account (it never switches accounts for you, and nothing in it reads cookies), then injects the script, hands it the export file by file, answers its questions and presses its button once. The side panel (the extension's toolbar button) shows the same, with a countdown for every wait, and holds the controls, each shown only while it applies: Resume, Skip this step, Cancel and, when the signed-in account could not be read, Confirm.

When claude.ai asks the browser to pass a Cloudflare check, refuses a request outright, or turns out to be signed out or signed in as another account, the import stops where it is: the panel and the command line say what happened and what to do, and nothing is retried on its own. You complete the check or sign in in a **new tab** of the same Chrome profile, then press Resume in the panel; the held request is sent once more and the import goes on. Do not reload the import tab, because the script lives in it. A step the script would have given up on (a create that failed, the fourth failure in a row, the ninth slow-down in a row) is held the same way: Resume sends it once more, and **Skip this step** hands the failure to the script, which records the file as not added and goes on. When the site asks to slow down (a 429 with Retry-After), the wait is honoured in full and shown. Reads, and every request of an export, go back to back, still one at a time; an import's writes (its creates, uploads and settings) keep half a second between them. Both gaps are settings in the side panel. Cancel reloads the tab, since the unchanged script cannot be stopped any other way; the project created so far stays.

Without `--to`, or with `--clipboard`, the paste route is used as before; `--bridge` makes a missing piece an error instead of a quiet fallback. One import runs at a time per machine. The extension's own README (`extension/README.md`) describes the settings and each control.

##### Duplicate: the whole move from the side panel

With the three steps done, a move needs no command at all: three buttons in the side panel, always in the same place and always live, pressed in order for a whole move. Each can be pressed on its own, and a press at the wrong moment (Import while a job runs, Export this project with a job in the tab, Sign out and reload during a job, any of them while a Save As or Open window is open) is answered with why, and nothing starts.

1. **Export this project.** Open the project on claude.ai in the tab (`claude.ai/project/...` or `claude.ai/code/project/...`), signed in as the account that has it, and press the button. The tab is reloaded, the page lists that account's projects so the one in the tab is named the way the site names it, and your computer's own Save As window opens, with `<the project's name>.tar` suggested in the folder the last export went to (the exports folder the first time): say where the export goes. Then the export script runs on the project's page, the one `cswap project-move export` would have you paste, and every file it writes goes through the bridge into that one .tar as it is written. There is nothing else to choose: a tab that is not on a project is refused with a sentence saying what to open, and the Save As window closed without a choice ends the export with nothing written. When the export is done, a notification and the panel say what to press next.
2. **Sign out and reload.** The tab makes claude.ai's own sign-out request and goes to the site's sign-in page; sign in there as the other account. If the site refuses the sign-out, the panel says so: sign out from the page's menu instead, then sign in.
3. **Import.** Give the copy a name if you want one; without one it keeps the original's name. Press Import: your computer's own Open window appears, in the folder the last window used; open the export to copy, the .tar just saved, or any other export on your computer (a .tar, or the `export.json` inside the folder of an export made with `cswap project-move export`). cswap reads the export you opened, checks that it is whole, and queues its import into whichever account the tab is signed in as; the extension runs it in the same tab exactly as `cswap project-move import --to` does, with the same checks, holds and controls, except that no account is named in advance: the page's own answer names the signed-in account, the panel's Progress line and the log say which, and from then on the import is tied to it. The Open window closed without a choice imports nothing, and the panel says so. The new project's link appears under Progress when it is done.

The extension never switches accounts for you, and a Duplicate never reads cswap's registry: the copy goes into whichever account you signed in as, the first one included if you skipped Sign out and reload. If the tab is signed out when you press Import, the import stops and says so: sign in as the other account in a new tab of the same Chrome profile and press Resume. When the import cannot be queued (the export is not whole, what you opened is no export, the bridge is gone, another job got in first), the export stays on disk and the panel says why, keeps Import, and shows the `cswap project-move import --to NUM --folder="<the export's .tar>"` line that imports it by hand, NUM being the account's number in `cswap list`, with a Copy button; nothing is tried again on its own. The line puts every value after `--option=`, so a path or a name that starts with a dash is not read as an option; a name no quoting carries whole (one with a double quote in it) is left off with a note saying so. Cancel during an export reloads the tab and leaves what was written so far in the .tar you chose.

An export made earlier, by the panel or by `cswap project-move export`, is imported the same way: press Import and open it in the window, into the account the tab is signed in as. The panel never chooses the account or the export, and lists nothing; the one thing it remembers is the folder the last window used, so the next one opens there. So a move is picked up at any step: with the export on disk, sign in as the other account (Sign out and reload first when the tab is signed in as the first one), press Import and open the export. From the command line, `cswap project-move import --to N --folder="<the .tar, or the folder>"` runs it through the extension in the tab you are signed in to, and `cswap project-move auto --export="<the same>" --to N` runs it in a browser window of its own that cswap opens and drives (see above). The panel no longer starts that window; a record of one that an earlier version started is shown as it stands.

A job that an earlier copy of the extension left on the bridge (one you removed and loaded again, say) counts as another browser profile's: the panel's Connection section names it, and **Drop that job** ends that job as cancelled, so a new one can start here; a browser still running it stops the next time it reports. An older cswap says to cancel it from the command line instead (`cswap project-move import --cancel`), which drops it fifteen minutes after the request goes unanswered.

### Session checkpoint

`cswap checkpoint` keeps a checkpoint of the current Claude Code session at `.claude/session.md`, rendered from the local transcript without a model call, so the next session (or another account's) can pick the work up:

```bash
cswap checkpoint write                 # from the newest transcript for this directory
cswap checkpoint write --account 2     # from that account's session profile
cswap checkpoint start -m "finish the tests"   # write it, then start claude told to read it first
cswap checkpoint show
cswap teleport --from 1 --to 2 session_01AbC... --checkpoint   # commit it instead of a handoff note
```

The checkpoint holds the completed work (commits since the merge base, finished to-do items, files touched), the current state, the decisions, the remaining tasks, the blockers, the constraints and the original request. Lines you tag in conversation as `Decision:`, `Constraint:`, `Blocker:`, `Next:` or `Done:` are kept verbatim; the rest is inferred from the transcript. It also keeps a marker-delimited section of `CLAUDE.md` with the durable decisions and constraints, replaced in place on every write and leaving the rest of the file untouched. Tool output is left out, credential-like strings are redacted, the file is capped at 16 KB, and the same transcript always gives the same bytes, so a rerun changes nothing. `start` runs `claude` with "Read .claude/session.md first ... Then: <task>", as the named account when `--account` is given.

### Share usage readings between machines

Machines that hold the same accounts can end up spending one usage-endpoint budget: when they share a login (moved between them with `export`/`import`, so the same token is live on each), or when the account's usage requests are limited per account rather than per token. Their polling then adds up. `import-usage` lets one machine poll and hand its readings to the others:

```bash
cswap list --json | ssh laptop cswap import-usage - --hold 600
```

<details>
<summary>How it works — matching, holds & when a hold ends</summary>

The input is `cswap list --json` output. Each row with `usageStatus: "ok"` is matched to a local account by email and organization, and adopted when it is newer than the reading already stored. Its age comes from `usageAgeSeconds`, so the two machines' clocks never have to agree; a script that delays the hand-over should add the delay to that field. `--hold SECONDS` keeps every collector on the receiving machine (`list`, `status`, `auto`, the dashboard, the menu bar) from fetching those accounts for that long, and the held reading stays trusted for switch decisions meanwhile. A hold never runs past the reading's earliest window reset (per-model windows included), nor past an hour after the reading was taken. Renew it with each hand-over, or lift it early with `--hold 0`; when it lapses, the machine goes back to fetching for itself.

</details>

### JSON output for scripting

Add `--json` to `list`, `status`, or `switch` to emit a single machine-readable JSON object on stdout (human-readable notices go to stderr). Useful for scripting auto-swap and quota tracking.

```bash
cswap list --json                   # all accounts with usage/quota
cswap status --json                 # current active account
cswap switch --strategy best --json # switch, then report the result
cswap switch 2 --json
```

<details>
<summary>Example output & schema notes</summary>

```json
{
  "schemaVersion": 1,
  "activeAccountNumber": 2,
  "accounts": [
    { "number": 2, "email": "you@example.com", "active": true, "usageStatus": "ok",
      "usage": { "fiveHour": { "pct": 25.0, "resetsAt": "2026-06-22T23:29:59Z" },
                 "sevenDay": { "pct": 16.0, "resetsAt": "2026-06-26T17:59:59Z" } } }
  ]
}
```

Every payload carries a `schemaVersion` (currently `1`); on a handled error stdout is `{"schemaVersion":1,"error":{...}}` with a non-zero exit code. `--switch`/`--switch-to` report `{"switched": true|false, "from": …, "to": …, "reason": …}`.

Usage is served from a per-account cache: when the usage API is briefly unreachable, the last-known numbers are shown instead of nothing (the human view marks them with their age, e.g. `· 2m ago`). Rows with decision-trusted usage carry additive `usageFetchedAt`/`usageAgeSeconds` fields telling you how old the measurement is. Whenever `usage` is null but a last-known measurement exists — data too old to drive a decision (`usageStatus` stays `unavailable`), or a row in a non-`ok` state such as `token_expired` — additive `lastGoodUsage`/`lastGoodFetchedAt`/`lastGoodAgeSeconds` fields preserve the human display without making the account actionable. When `usage` is null and nothing else explains it (`usageStatus` is `unavailable`), an additive `usageError` names the last fetch failure by kind (e.g. `http-429`, `timeout`) and, while the cache is backing off from it, `usageRetryAt` gives the time of the next attempt. These fields apply to list rows and the managed active row from `status --json`. An account held out of rotation with `cswap disable` carries an additive `"disabled": true` on its row (absent otherwise).

A row carries an additive `loginExpiresAt` (ISO-8601 UTC) when the stored login records when its refresh token expires, which is the moment the slot will need a fresh `/login` and `cswap add --slot N`; a script can warn a few days ahead instead of discovering `relogin_required`. Absent when Claude Code recorded no such date for that login.

An account row also carries an additive `alias` field once one is set with `cswap alias` (e.g. `"alias": "dev"`); accounts without one simply omit the key.

Weekly windows (`sevenDay` and per-model `scoped` entries — never `fiveHour`) additively carry pace fields once the week is ~a day old: `expectedPct` (where usage would sit if spread evenly across the week) and `aheadOfPace` (`true` when meaningfully above that — the same signal the human views show as an `(ahead)`/`(ahead of pace)` marker). `projectedExhaustionAt`/`willLastToReset` extrapolate the current rate into an ETA to 100% and a yes/no "will it last to the reset"; they stay `--json`-only since a linear projection is too rough to present as fact in the UI.

</details>

`cswap auto --json` emits an event *stream* instead — one JSON object per line (`{"schemaVersion":1,"event":"switch","ts":…, …}` with kinds like `poll`, `switch`, `no-switch`, `account-quarantined`, `all-exhausted`, `error`). The contract is additive: new kinds and fields may appear, so scripts should ignore unknown ones.

### Add an account from a raw token or API key

If you only have a long-lived setup-token (e.g., produced by `claude setup-token`)
or a managed API key (`sk-ant-api...`) and you don't want to log in via the browser
flow first — useful on headless servers or when receiving a token from another
machine — register it directly. The token type is auto-detected:

```bash
cswap add-token sk-ant-oat01-...             # OAuth setup-token
cswap add-token sk-ant-api03-...             # managed API key
cswap add-token sk-ant-oat01-... --slot 3
cswap add-token - --slot 3                   # read token from stdin
cswap add-token --email user@example.com     # optional label override
```

`--email` is optional; omitted values use `setup-token-{slot}@token.local`
(or `api-key-{slot}@token.local` for API keys). No Anthropic API calls are made.

**API-key accounts.** An `sk-ant-api...` value registers a managed API-key account
(the kind Claude Code uses after `/login` with a key) rather than an OAuth
setup-token. It switches like any other account; since API keys have no subscription
quota, they show no usage and the usage-aware `switch` strategies never skip them as
rate-limited.

## Uninstall

Remove all data:

```bash
cswap purge
```

Then uninstall the tool:

```bash
uv tool uninstall claude-swap-cloud
# or
pipx uninstall claude-swap-cloud
```

## Requirements

- Python 3.12+
- Claude Code installed and logged in
- Chrome 135 or newer for the Chrome extension (optional)

## License

Proprietary, built on [claude-swap](https://github.com/realiti4/claude-swap) by Onur Cetinkol, whose code stays under the MIT License. See [LICENSE](LICENSE).
