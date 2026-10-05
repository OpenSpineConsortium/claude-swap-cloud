"""Command-line interface for Claude Swap."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time

from claude_swap import __version__, paths, printer
from claude_swap.exceptions import ClaudeSwitchError, ValidationError
from claude_swap.json_output import error_envelope
from claude_swap.printer import (
    accent,
    bolded,
    dimmed,
    error,
    force_utf8_output,
    muted,
    warning,
)
from claude_swap.settings import load_ui_settings
from claude_swap.switcher import ClaudeAccountSwitcher


def _prog_name() -> str:
    """The command name to show in usage/help.

    argparse otherwise defaults to ``os.path.basename(sys.argv[0])``, which for
    an installed entry-point shim renders as an ugly absolute path (e.g.
    ``python.exe C:\\Users\\me\\.local\\bin\\cswap``). We strip that down to the
    bare command the user typed (``cswap`` / ``claude-swap``), falling back to
    ``cswap`` for ``python -m claude_swap`` and odd launchers.
    """
    name = os.path.basename(sys.argv[0] or "")
    for ext in (".exe", ".pyw", ".py"):
        if name.lower().endswith(ext):
            name = name[: -len(ext)]
            break
    if not name or name in {"__main__", "python", "python3", "py"}:
        return "cswap"
    return name


# Memorable subcommand aliases → the long-standing flags they expand to. Lets
# users type `cswap list`, `cswap status`, `cswap add`, etc. instead of `--list`
# / `--status` / `--add-account`, which all still work. `switch` is special-cased
# below (a bare `switch` rotates; `switch <target>` jumps to one account) and
# `run`/`auto` keep their own pre-dispatch parsers, so none of those are listed here.
_SUBCOMMAND_FLAGS = {
    "help": "--help",
    "list": "--list",
    "ls": "--list",
    "status": "--status",
    "add": "--add-account",
    "add-token": "--add-token",
    "remove": "--remove-account",
    "rm": "--remove-account",
    "disable": "--disable-account",
    "enable": "--enable-account",
    "export": "--export",
    "import": "--import",
    "import-usage": "--import-usage",
    "purge": "--purge",
    "upgrade": "--upgrade",
    "update": "--upgrade",
    "tui": "--tui",
    "watch": "--watch",
    "menubar": "--menubar",
}


def _translate_subcommand(argv: list[str]) -> list[str]:
    """Rewrite a leading memorable subcommand into the equivalent flag argv.

    ``argv`` is the args after the program name. The rewrite only fires when the
    first token is a recognized verb (which never starts with '-'), so the
    established ``--flag`` interface — and every existing test that drives it —
    is left untouched. Tokens after the verb pass through verbatim, so flags
    like ``--json``, ``--strategy``, ``--slot``, and ``--force`` keep combining
    exactly as before (e.g. ``cswap switch --strategy best``, ``cswap list --json``).
    """
    if not argv:
        return argv

    verb, rest = argv[0], argv[1:]

    if verb == "switch":
        # Bare `switch` rotates; `switch <num|email>` jumps to that account.
        if rest and not rest[0].startswith("-"):
            return ["--switch-to", *rest]
        return ["--switch", *rest]

    flag = _SUBCOMMAND_FLAGS.get(verb)
    if flag is not None:
        return [flag, *rest]

    return argv


def _run_command(argv: list[str]) -> None:
    """Handle `cswap run NUM|EMAIL [--no-share] [-- <claude args>]`.

    Pre-dispatched before the main parser is built: a positional subcommand
    can't coexist with main()'s mutually-exclusive flag group, and this keeps
    the existing parser untouched. Limitation: `run` must be the
    first argument (`cswap --debug run 2` is not supported; use
    `cswap run 2 --debug`).

    On POSIX this execs claude and never returns; on Windows it exits with
    claude's return code. Either way the post-dispatch update check in
    main() is unreachable, which is intended.
    """
    # Everything after the first `--` is forwarded to claude verbatim.
    if "--" in argv:
        split = argv.index("--")
        head, tail = argv[:split], argv[split + 1 :]
    else:
        head, tail = argv, []

    parser = argparse.ArgumentParser(
        prog=f"{_prog_name()} run",
        description=(
            "[EXPERIMENTAL] Launch Claude Code as a stored account in this "
            "terminal only (the default login and other terminals are "
            "unaffected)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  cswap run 2
  cswap run user@example.com
  cswap run 2 --no-share
  cswap run 2 --share-history
  cswap run 2 --require-session
  cswap run 2 -- --resume
        """,
    )
    parser.add_argument(
        "account",
        nargs="?",
        metavar="NUM|EMAIL",
        help="Account to run (number or email). Omit to use the current "
        "directory's mapping (see `cswap map`).",
    )
    parser.add_argument(
        "--no-share",
        action="store_true",
        help=(
            "Don't share settings/keybindings/CLAUDE.md/skills/commands/agents "
            "from ~/.claude into the session profile (and remove previously "
            "shared items)"
        ),
    )
    parser.add_argument(
        "--share-history",
        action=argparse.BooleanOptionalAction,
        default=False,
        help=(
            "Share conversation history (projects/ and history.jsonl) from "
            "~/.claude into the session profile, so every account sees one "
            "unified history. History the profile already accumulated is "
            "merged into ~/.claude first. --no-share-history restores "
            "per-account history (the default). Not supported on Windows."
        ),
    )
    parser.add_argument(
        "--require-session",
        action="store_true",
        help=(
            "Refuse to launch when the account is already the active default "
            "login, instead of running plain claude on that login (which a "
            "later switch could pull out from under the session)"
        ),
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging",
    )
    args = parser.parse_args(head)

    try:
        switcher = ClaudeAccountSwitcher(debug=args.debug)
        _guard_root(switcher)

        from claude_swap.session import SessionManager

        manager = SessionManager(switcher)

        if args.account is not None:
            manager.run(
                args.account,
                tail,
                share=not args.no_share,
                share_history=args.share_history,
                require_session=args.require_session,
            )
            return  # only reachable in tests where exec/exit is mocked

        # No account given: resolve from the current directory's mapping.
        slot, email = switcher.slot_for_directory(os.getcwd())
        if slot is not None:
            manager.run(
                slot,
                tail,
                share=not args.no_share,
                share_history=args.share_history,
                require_session=args.require_session,
            )
            return  # only reachable in tests
        if email is not None:
            warning(
                f"Mapped account {email} no longer exists — "
                "launching the default account."
            )
        else:
            print(
                dimmed(
                    f"No account mapped for {os.getcwd()} — "
                    "launching the default account."
                )
            )
        manager.exec_default(tail)
    except ClaudeSwitchError as e:
        error(f"Error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print(f"\n{dimmed('Operation cancelled')}")
        sys.exit(130)


def _teleport_command(argv: list[str]) -> None:
    """Handle `cswap teleport --from A --to B [SESSION_ID] [-m TASK]`.

    Pre-dispatched like `run`. Pulls a cloud session as account A, pushes
    its branch, and starts a new cloud session as account B with a handoff
    note (see claude_swap.teleport).
    """
    from claude_swap.handoff import DEFAULT_HANDOFF_BYTES
    from claude_swap.teleport import DEFAULT_TASK, TeleportPlan

    # Everything after the first `--` is forwarded to every claude launch.
    if "--" in argv:
        split = argv.index("--")
        argv, claude_args = argv[:split], argv[split + 1 :]
    else:
        claude_args = []

    parser = argparse.ArgumentParser(
        prog=f"{_prog_name()} teleport",
        description=(
            "[EXPERIMENTAL] Move a cloud session to another account: pull it "
            "locally as --from (claude --teleport), push its branch, then "
            "start a new cloud session as --to (claude --cloud) told to read "
            "a handoff note built from the transcript and committed at "
            ".claude/handoff/<id>.md. Run it inside a clone "
            "of the session's repository. Both accounts must be claude.ai "
            "logins; the conversation itself does not move, only the "
            "branch and the note."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  cswap teleport --from 1 --to 2 session_01AbC...
  cswap teleport --from me@work.com --to me@home.com session_01AbC... -m "finish the tests"
  cswap teleport --from 1 --to 2 --skip-teleport   # already pulled; push and hand off
  cswap teleport --from 1 --to 2 session_01AbC... --handoff-in-prompt  # don't commit the note
  cswap teleport --from 1 --to 2 --skip-teleport --dry-run  # preview the note
  cswap teleport --from 1 --to 2 session_01AbC... -- --model opus  # args after -- go to claude

In PowerShell, quote the separator ('--') when cswap is a PowerShell function
or alias; an unquoted -- is consumed before cswap sees it.
        """,
    )
    parser.add_argument(
        "session_id",
        nargs="?",
        metavar="SESSION_ID",
        help="Cloud session to pull. Omit to pick one interactively.",
    )
    parser.add_argument(
        "--from", dest="source", required=True, metavar="NUM|EMAIL",
        help="Account that owns the cloud session",
    )
    parser.add_argument(
        "--to", dest="target", required=True, metavar="NUM|EMAIL",
        help="Account that gets the new cloud session",
    )
    parser.add_argument(
        "-m", "--task", default=DEFAULT_TASK,
        help="Task for the new cloud session",
    )
    parser.add_argument(
        "--skip-teleport", action="store_true",
        help="Don't run claude --teleport (the session is already local)",
    )
    parser.add_argument(
        "--no-push", action="store_true",
        help="Don't push the branch before starting the cloud session",
    )
    parser.add_argument(
        "--no-handoff", action="store_true",
        help="Don't write a handoff note",
    )
    parser.add_argument(
        "--handoff-in-prompt", action="store_true",
        help="Put the handoff note in the cloud prompt (capped at 8 KB) "
        "instead of committing it to .claude/handoff/ on the branch",
    )
    parser.add_argument(
        "--summarize", action="store_true",
        help="Also ask the previous session (as --from, spending its quota) "
        "for a written summary to put at the top of the note",
    )
    parser.add_argument(
        "--handoff-max-kb", type=int, default=DEFAULT_HANDOFF_BYTES // 1024,
        metavar="KB",
        help=f"Handoff note size cap (default {DEFAULT_HANDOFF_BYTES // 1024})",
    )
    parser.add_argument(
        "--no-share", action="store_true",
        help="Run both accounts' session profiles without shared settings",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print the steps without launching or pushing anything",
    )
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args(argv)
    if args.handoff_max_kb < 1:
        parser.error("--handoff-max-kb must be at least 1")
    if args.skip_teleport and args.session_id is None and not args.no_handoff:
        print(
            dimmed(
                "No SESSION_ID: the handoff note uses the newest transcript "
                "for this directory."
            )
        )

    plan = TeleportPlan(
        source=args.source,
        target=args.target,
        session_id=args.session_id,
        task=args.task,
        push=not args.no_push,
        handoff=not args.no_handoff,
        handoff_in_prompt=args.handoff_in_prompt,
        summarize=args.summarize,
        handoff_max_bytes=args.handoff_max_kb * 1024,
        skip_teleport=args.skip_teleport,
        share=not args.no_share,
        dry_run=args.dry_run,
        claude_args=claude_args,
    )
    try:
        switcher = ClaudeAccountSwitcher(debug=args.debug)
        _guard_root(switcher)

        from claude_swap.session import SessionManager
        from claude_swap.teleport import Teleporter

        sys.exit(Teleporter(SessionManager(switcher)).run(plan))
    except ClaudeSwitchError as e:
        error(f"Error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print(f"\n{dimmed('Operation cancelled')}")
        sys.exit(130)


def _guard_root(switcher: ClaudeAccountSwitcher) -> None:
    """Refuse to run as root outside a container (shared by run/map/unmap)."""
    if sys.platform != "win32":
        if os.geteuid() == 0 and not switcher._is_running_in_container():
            error("Error: Do not run this script as root (unless running in a container)")
            sys.exit(1)


def _map_command(argv: list[str]) -> None:
    """Handle `cswap map [NUM|EMAIL] [PATH]`.

    With no NUM|EMAIL, lists all mappings. Otherwise maps PATH (default: the
    current directory) to the given account. Pre-dispatched before the main
    parser for the same reason as `run` (the main parser's required
    mutually-exclusive group can't hold a positional subcommand).
    """
    parser = argparse.ArgumentParser(
        prog="cswap map",
        description=(
            "Map a stored account to a directory so `cswap run` (with no "
            "account) auto-launches it there. With no arguments, lists all "
            "mappings."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  cswap map 2 ~/work/client-app
  cswap map user@example.com          # map the current directory
  cswap map                           # list all mappings
        """,
    )
    parser.add_argument(
        "account",
        nargs="?",
        metavar="NUM|EMAIL",
        help="Account to map (number or email). Omit to list mappings.",
    )
    parser.add_argument(
        "path",
        nargs="?",
        metavar="PATH",
        help="Directory to map (default: current directory)",
    )
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args(argv)

    try:
        switcher = ClaudeAccountSwitcher(debug=args.debug)
        _guard_root(switcher)

        if args.account is None:
            switcher.list_mappings()
            return

        from claude_swap.mappings import MappingStore, normalize_path

        store = MappingStore(switcher.backup_dir)
        account_num, email, org_uuid = switcher.resolve_account(args.account)
        target = args.path or os.getcwd()
        if not os.path.isdir(target):
            warning(f"Warning: {target} is not an existing directory (mapping it anyway)")
        previous = store.get(target)
        store.set(target, email, org_uuid)

        shown = normalize_path(target)
        if previous and previous.get("email") != email:
            prev_email = previous.get("email")
            print(
                f"{accent('Mapped')} {shown} → Account-{account_num} ({email}) "
                f"{muted(f'(was {prev_email})')}"
            )
        else:
            print(f"{accent('Mapped')} {shown} → Account-{account_num} ({email})")
    except ClaudeSwitchError as e:
        error(f"Error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print(f"\n{dimmed('Operation cancelled')}")
        sys.exit(130)


def _unmap_command(argv: list[str]) -> None:
    """Handle `cswap unmap [PATH]` — remove a directory→account mapping."""
    parser = argparse.ArgumentParser(
        prog="cswap unmap",
        description="Remove a directory → account mapping (default: current directory).",
    )
    parser.add_argument(
        "path",
        nargs="?",
        metavar="PATH",
        help="Directory to unmap (default: current directory)",
    )
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args(argv)

    try:
        switcher = ClaudeAccountSwitcher(debug=args.debug)
        _guard_root(switcher)

        from claude_swap.mappings import MappingStore, normalize_path

        store = MappingStore(switcher.backup_dir)
        target = args.path or os.getcwd()
        shown = normalize_path(target)
        if store.remove(target):
            print(f"{accent('Unmapped')} {shown}")
        else:
            print(dimmed(f"No mapping for {shown}"))
    except ClaudeSwitchError as e:
        error(f"Error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print(f"\n{dimmed('Operation cancelled')}")
        sys.exit(130)


def _unclaimed_command(argv: list[str]) -> None:
    """Handle `cswap unclaimed [--purge ID]` — inspect or drop a stash row.

    The stash holds credential bytes a switch or a consume gate could not
    attribute to a slot. Rows normally clear themselves (the next gate pass
    adopts or retires them), but two states need a human: a row whose bytes
    are unreadable until a keychain is unlocked or a mode is fixed, and one
    whose metadata was lost, which no pass can ever adopt. ``--json`` lists
    only bare ids, so without this there is nothing to look at and nothing to
    drop short of hand-editing the manifest.
    """
    parser = argparse.ArgumentParser(
        prog=f"{_prog_name()} unclaimed",
        description=(
            "List stashed credential entries, or purge one by id. "
            "Purging deletes the bytes — recovery is /login + `cswap add`."
        ),
    )
    parser.add_argument(
        "--purge",
        metavar="ID",
        help="Delete this entry's bytes and manifest row",
    )
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args(argv)

    try:
        switcher = ClaudeAccountSwitcher(debug=args.debug)
        _guard_root(switcher)
        entries = switcher.list_unclaimed_credentials()

        if args.purge:
            if args.purge not in entries:
                error(f"Error: no unclaimed entry {args.purge}")
                sys.exit(1)
            switcher._store._remove_unclaimed_credential(args.purge)
            print(f"{accent('Purged')} {args.purge}")
            return

        if not entries:
            print(dimmed("No unclaimed credential entries"))
            return
        for entry_id, meta in sorted(entries.items()):
            slot = meta.get("configSlot") or "?"
            reason = meta.get("reason") or "orphaned (no manifest row)"
            print(f"{entry_id}  slot {slot}  {reason}")
    except ClaudeSwitchError as e:
        error(f"Error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print(f"\n{dimmed('Operation cancelled')}")
        sys.exit(130)


def _swap_command(argv: list[str]) -> None:
    """Handle `cswap swap NUM|EMAIL|ALIAS NUM|EMAIL|ALIAS`.

    Exchanges the two accounts' slot numbers (list order and numeric
    targets). Pre-dispatched before the main parser for the same reason as
    `alias` (the main parser's required mutually-exclusive group can't hold
    a positional subcommand).
    """
    parser = argparse.ArgumentParser(
        prog=f"{_prog_name()} swap",
        description=(
            "Exchange two accounts' slot numbers, so they trade places in "
            "`cswap list` and as numeric targets. Aliases, backups, and "
            "session history move with their account."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  cswap swap 1 2
  cswap swap dev user@example.com
        """,
    )
    parser.add_argument("first", metavar="NUM|EMAIL|ALIAS", help="One account")
    parser.add_argument("second", metavar="NUM|EMAIL|ALIAS", help="The other account")
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args(argv)

    try:
        switcher = ClaudeAccountSwitcher(debug=args.debug)
        _guard_root(switcher)
        num_a, num_b = switcher.swap_accounts(args.first, args.second)
        print(f"{accent('Swapped')} Account {num_a} and Account {num_b}:")
        data = switcher._get_sequence_data() or {}
        accounts = data.get("accounts", {})
        for num in sorted((num_a, num_b), key=int):
            email = accounts.get(num, {}).get("email", "")
            print(f"  {num}: {email}")
    except ClaudeSwitchError as e:
        error(f"Error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print(f"\n{dimmed('Operation cancelled')}")
        sys.exit(130)


def _move_command(argv: list[str]) -> None:
    """Handle `cswap move NUM|EMAIL|ALIAS SLOT`.

    Assigns an account to a specific slot number. If the slot is empty the
    account is relocated there (its old slot is freed); if it is occupied the
    two accounts trade places. `swap a b` is exactly `move a <b's slot>`.
    Pre-dispatched before the main parser for the same reason as `alias`.
    """
    parser = argparse.ArgumentParser(
        prog=f"{_prog_name()} move",
        description=(
            "Assign an account to a slot number. An empty slot relocates the "
            "account there and frees its old slot; an occupied slot swaps the "
            "two. Aliases, backups, and session history move with the account."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  cswap move user@example.com 1   move an account onto shortcut 1
  cswap move dev 1                by alias
  cswap move 2 1                  by number (swaps if slot 1 is taken)
        """,
    )
    parser.add_argument("account", metavar="NUM|EMAIL|ALIAS", help="Account to move")
    parser.add_argument("slot", metavar="SLOT", help="Destination slot number")
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args(argv)

    try:
        switcher = ClaudeAccountSwitcher(debug=args.debug)
        _guard_root(switcher)
        num_src, num_target, swapped = switcher.move_account(args.account, args.slot)
        data = switcher._get_sequence_data() or {}
        accounts = data.get("accounts", {})
        if num_src == num_target:
            email = accounts.get(num_target, {}).get("email", "")
            print(f"{dimmed('Already in')} slot {num_target}: {email}")
        elif swapped:
            print(f"{accent('Swapped')} Account {num_src} and Account {num_target}:")
            for num in sorted((num_src, num_target), key=int):
                email = accounts.get(num, {}).get("email", "")
                print(f"  {num}: {email}")
        else:
            email = accounts.get(num_target, {}).get("email", "")
            print(f"{accent('Moved')} {email} to slot {num_target}")
    except ClaudeSwitchError as e:
        error(f"Error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print(f"\n{dimmed('Operation cancelled')}")
        sys.exit(130)


def _alias_command(argv: list[str]) -> None:
    """Handle `cswap alias [NUM|EMAIL] [NAME] [--unset]`.

    With no arguments, lists all aliases. Otherwise sets (or, with --unset,
    removes) the alias for the given account. Pre-dispatched before the main
    parser for the same reason as `map` (the main parser's required
    mutually-exclusive group can't hold a positional subcommand).
    """
    parser = argparse.ArgumentParser(
        prog="cswap alias",
        description=(
            "Set, remove, or list a short display alias for an account. "
            "Once set, the alias can be used anywhere an account number or "
            "email is accepted (switch, remove, run, map)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  cswap alias 2 dev
  cswap alias user@example.com dev
  cswap alias 2 --unset
  cswap alias                         # list all aliases
        """,
    )
    parser.add_argument(
        "account",
        nargs="?",
        metavar="NUM|EMAIL",
        help="Account to alias (number or email). Omit to list aliases.",
    )
    parser.add_argument(
        "alias_name",
        nargs="?",
        metavar="NAME",
        help="Alias to set (letters, digits, ., -, _; not purely numeric).",
    )
    parser.add_argument("--unset", action="store_true", help="Remove the account's alias")
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args(argv)

    if args.unset and args.alias_name:
        parser.error("--unset does not take a NAME argument")
    if args.unset and args.account is None:
        parser.error("NUM|EMAIL is required with --unset")
    if args.account is not None and not args.unset and not args.alias_name:
        parser.error("NAME is required (or pass --unset to remove the alias)")

    try:
        switcher = ClaudeAccountSwitcher(debug=args.debug)
        _guard_root(switcher)

        if args.account is None:
            rows = switcher.list_aliases()
            if not rows:
                print(dimmed("No aliases set"))
                return
            print(bolded("Aliases:"))
            for num, alias_name, email in rows:
                print(f"  {num}: {alias_name} {muted(f'({email})')}")
            return

        if args.unset:
            account_num = switcher.unset_alias(args.account)
            print(f"{accent('Removed alias')} for Account {account_num}")
        else:
            account_num, normalized = switcher.set_alias(args.account, args.alias_name)
            print(f"{accent('Set alias')} '{normalized}' for Account {account_num}")
    except ClaudeSwitchError as e:
        error(f"Error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print(f"\n{dimmed('Operation cancelled')}")
        sys.exit(130)


def _auto_command(argv: list[str]) -> None:
    """Handle `cswap auto [--once] [--json] [...]`.

    Pre-dispatched before the main parser is built, like `run` (and with the
    same limitation: `auto` must be the first argument). Runs the auto-switch
    engine — a foreground loop by default, or a single evaluate-and-maybe-
    switch tick with --once whose exit code reports the outcome (for cron/
    systemd timers): 0 switched, 1 error, 2 no action needed, 3 blocked
    (no viable target / all accounts exhausted).
    """
    import signal
    import time as _time

    parser = argparse.ArgumentParser(
        prog="cswap auto",
        description=(
            "Automatically switch accounts when the active one nears its "
            "5h/7d rate limit. Runs a foreground polling loop; use --once "
            "for a single tick (cron-friendly)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Exit codes with --once:
  0  switched to another account
  1  error (network trouble, lock contention, ...)
  2  no action needed
  3  blocked: wanted to switch but no viable target / all exhausted

Examples:
  cswap auto                       # foreground loop, switch at 90%% used
  cswap auto --threshold 80        # switch earlier
  cswap auto --model Fable         # also switch when the Fable weekly limit is hit
  cswap auto --json                # one JSON event per line (for scripts)
  cswap auto --once; echo $?       # single tick, outcome in exit code
  cswap auto --dry-run             # log decisions, never actually switch

Defaults live in settings.json in the backup root; flags override them.
        """,
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Evaluate once, maybe switch, and exit (exit code = outcome)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit one machine-readable JSON event per line on stdout",
    )
    parser.add_argument(
        "--interval",
        type=float,
        metavar="SECONDS",
        help="Poll interval in loop mode (min 15; default 60)",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        metavar="PCT",
        help=(
            "Switch when the active account's binding 5h/7d window reaches "
            "this utilization (50-99.9; default 90)"
        ),
    )
    parser.add_argument(
        "--cooldown",
        type=float,
        metavar="SECONDS",
        help="Minimum time between proactive switches (default 300)",
    )
    parser.add_argument(
        "--model",
        metavar="NAMES",
        help=(
            "Also switch when a per-model weekly limit is hit, not just the "
            "account-wide 5h/7d windows. One name or a comma-separated list "
            "(e.g. Fable, Opus, Sonnet, Haiku, or 'Fable,Opus'), or 'all' "
            "for every per-model window an account reports"
        ),
    )
    parser.add_argument(
        "--include-api-key-accounts",
        action=argparse.BooleanOptionalAction,
        default=None,
        help=(
            "Allow switching onto managed API-key accounts as a last resort "
            "(they bill per token; default: excluded)"
        ),
    )
    parser.add_argument(
        "--strategy",
        choices=("best", "consume-first"),
        default=None,
        help=(
            "Target selection: 'best' (most quota left; default) or "
            "'consume-first' (proactively use the account whose weekly window "
            "resets soonest)"
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Evaluate and report, but never switch or write state",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging",
    )
    args = parser.parse_args(argv)

    from claude_swap.autoswitch import AutoSwitchEngine, AutoSwitchEvent
    from claude_swap.printer import accent, yellowed
    from claude_swap.settings import load_settings, merged_with_cli

    def jsonl_emit(event: AutoSwitchEvent) -> None:
        print(json.dumps(event.to_json()), flush=True)

    def human_emit(event: AutoSwitchEvent) -> None:
        stamp = _time.strftime("%H:%M:%S")
        line = event.human()
        if event.kind == "switch":
            line = accent(line)
        elif event.kind in ("error", "account-quarantined"):
            line = yellowed(line)
        elif event.kind in ("poll", "no-switch", "sleep"):
            line = dimmed(line)
        print(f"{stamp}  {line}", flush=True)

    try:
        switcher = ClaudeAccountSwitcher(debug=args.debug)
        if sys.platform != "win32":
            if os.geteuid() == 0 and not switcher._is_running_in_container():
                error("Error: Do not run this script as root (unless running in a container)")
                sys.exit(1)

        settings = merged_with_cli(load_settings(switcher.backup_dir), args)
        engine = AutoSwitchEngine(
            switcher,
            settings,
            jsonl_emit if args.json else human_emit,
            dry_run=args.dry_run,
        )

        if args.once:
            sys.exit(engine.tick().value)

        # Loop mode: SIGTERM (systemd stop) exits the loop cleanly.
        signal.signal(signal.SIGTERM, lambda *_: engine.stop())
        if not args.json:
            print(
                dimmed(
                    f"Auto-switch running: threshold {settings.threshold:.0f}%, "
                    f"every {settings.interval_seconds:.0f}s"
                    f"{' (dry-run)' if args.dry_run else ''} — Ctrl-C to stop"
                )
            )
        sys.exit(engine.run_loop())
    except ClaudeSwitchError as e:
        if args.json:
            print(json.dumps(error_envelope(e)))
        else:
            error(f"Error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print(
            f"\n{dimmed('Auto-switch stopped')}",
            file=sys.stderr if args.json else sys.stdout,
        )
        sys.exit(130)


def _config_command(argv: list[str]) -> None:
    """Handle `cswap config [list|get KEY|set KEY VALUE|unset KEY|path]`.

    Pre-dispatched before the main parser is built, like `run` and `auto`
    (same limitation: `config` must be the first argument). Edits
    settings.json in the backup root with strict validation — unlike loading,
    which forgivingly clamps — so a typo'd key or out-of-range value errors
    loudly here instead of silently degrading at `cswap auto` time.
    """
    from claude_swap.settings import (
        SETTING_SPECS,
        effective_settings,
        format_setting_value,
        set_setting,
        setting_spec,
        settings_path,
        unset_setting,
    )

    key_lines = "\n".join(
        f"  {spec.dotted:<34}{spec.help} (default {format_setting_value(spec.default)})"
        for spec in SETTING_SPECS.values()
    )
    parser = argparse.ArgumentParser(
        prog="cswap config",
        description=(
            "Read and edit claude-swap settings (settings.json in the "
            "backup root)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""
Keys:
{key_lines}

Examples:
  cswap config                              # list effective settings
  cswap config get autoswitch.threshold
  cswap config set autoswitch.threshold 80
  cswap config unset autoswitch.threshold   # back to the default
  cswap config path                         # where settings.json lives
        """,
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON to stdout (with list or get)",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging",
    )
    sub = parser.add_subparsers(dest="action", metavar="{list,get,set,unset,path}")

    p_list = sub.add_parser("list", help="Show all effective settings (the default)")
    p_get = sub.add_parser("get", help="Print one setting's effective value")
    p_get.add_argument("key", metavar="KEY", help="Dotted key, e.g. autoswitch.threshold")
    for p in (p_list, p_get):
        # SUPPRESS: without it the subparser's False default would clobber a
        # pre-verb `cswap config --json` in the shared namespace.
        p.add_argument(
            "--json",
            action="store_true",
            default=argparse.SUPPRESS,
            help="Emit machine-readable JSON to stdout",
        )
    p_set = sub.add_parser("set", help="Validate and persist one setting")
    p_set.add_argument("key", metavar="KEY")
    p_set.add_argument("value", metavar="VALUE")
    p_unset = sub.add_parser("unset", help="Remove one setting (revert to the default)")
    p_unset.add_argument("key", metavar="KEY")
    sub.add_parser("path", help="Print the settings.json location")

    args = parser.parse_args(argv)
    json_mode = bool(getattr(args, "json", False))
    action = args.action or "list"
    if json_mode and action not in ("list", "get"):
        parser.error("--json can only be used with list or get")

    try:
        switcher = ClaudeAccountSwitcher(debug=args.debug)
        if sys.platform != "win32":
            if os.geteuid() == 0 and not switcher._is_running_in_container():
                error("Error: Do not run this script as root (unless running in a container)")
                sys.exit(1)
        root = switcher.backup_dir

        if action == "path":
            print(settings_path(root))
        elif action == "list":
            rows = effective_settings(root)
            if json_mode:
                payload = {
                    "schemaVersion": 1,
                    "path": str(settings_path(root)),
                    "settings": [
                        {"key": spec.dotted, "value": value, "isSet": is_set}
                        for spec, value, is_set in rows
                    ],
                }
                print(json.dumps(payload, indent=2))
            else:
                key_w = max(len(spec.dotted) for spec, _, _ in rows)
                val_w = max(len(format_setting_value(v)) for _, v, _ in rows)
                for spec, value, is_set in rows:
                    line = f"{spec.dotted:<{key_w}}  {format_setting_value(value):<{val_w}}"
                    print(line if is_set else f"{line}  {dimmed('(default)')}")
        elif action == "get":
            spec = setting_spec(args.key)
            value, is_set = next(
                (v, s) for sp, v, s in effective_settings(root) if sp is spec
            )
            if json_mode:
                payload = {
                    "schemaVersion": 1,
                    "key": spec.dotted,
                    "value": value,
                    "isSet": is_set,
                }
                print(json.dumps(payload, indent=2))
            else:
                print(format_setting_value(value))
        elif action == "set":
            value = set_setting(root, args.key, args.value)
            print(f"{args.key} = {format_setting_value(value)}")
        elif action == "unset":
            if unset_setting(root, args.key):
                default = setting_spec(args.key).default
                print(f"{args.key} unset (default: {format_setting_value(default)})")
            else:
                print(muted(f"{args.key} is not set; nothing to do"), file=sys.stderr)
    except ClaudeSwitchError as e:
        if json_mode:
            print(json.dumps(error_envelope(e), indent=2))
        else:
            error(f"Error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print(
            f"\n{dimmed('Operation cancelled')}",
            file=sys.stderr if json_mode else sys.stdout,
        )
        sys.exit(130)


def _project_move_command(argv: list[str]) -> None:
    """Handle `cswap project-move [export|check|import] [OWNER/NAME] ...`.

    Moves a claude.ai Project from one account to another. By default the
    export and the import are done by two scripts shipped in the package and
    pasted into the browser's DevTools console, with a folder on this
    computer in between. With a repository named, they are done by two
    prompts pasted in the projects' chats, with a git branch in between.
    Either way the pastes into claude.ai stay manual; this command hands out
    the script or prompt, copies it to the clipboard, remembers the folder or
    repository between stages, checks the exported folder or GitHub, and
    prints the remaining steps. Pre-dispatched like `run`/`move`.
    """
    from claude_swap import project_move as pm

    if argv and argv[0] in ("auto", "login"):
        _project_move_auto(argv)
        return

    parser = argparse.ArgumentParser(
        prog=f"{_prog_name()} project-move",
        description=(
            "Move a claude.ai Project between accounts. With no stage, prints "
            "the steps and where you are."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Stages (in order):
  export                copy the export script, open claude.ai
                        -> in Chrome or Edge, signed in as the SOURCE account, paste
                           it in the console (F12) of the project's page and choose
                           a folder: the project is saved there
  check [--wait]        check that the saved export is complete
  import                copy the import script, open claude.ai
                        -> signed in as the DESTINATION account, paste it in the
                           console and choose the exported folder: a NEW private
                           project is made from it, and nothing else is changed

With a repository, the same stages use prompts and a git branch instead of
scripts and a folder (the project's own Claude does the work, so its memory
comes along, and both accounts must be able to reach the repository):
  export OWNER/NAME     copy the export prompt
                        -> paste it in the OLD project's chat as the source account
  check [--wait]        ask GitHub whether the export branch has been pushed
  import [OWNER/NAME]   copy the import prompt
                        -> paste it in the NEW project's chat as the destination account

OWNER/NAME is the GitHub repository the project is attached to (for example
acme/widgets), not the project's name. It is remembered after the first stage.

Or all of it with no clicks, in browser windows cswap drives itself (the
first run asks you to sign in once in each window; see project-move auto -h):
  auto [PROJECT] --from A --to B   export as A and import as B, unattended
  login --from A --to B            only the one-time sign-ins

Examples:
  cswap project-move export
  cswap project-move check
  cswap project-move import
  cswap project-move export owner/name   # by prompt and branch instead
  cswap project-move auto beethoven --from 2 --to 1
  cswap project-move                     # the step list, with what is done
        """,
    )
    parser.add_argument(
        "stage",
        nargs="?",
        choices=["export", "check", "import", "steps"],
        help="Which stage to run (default: show the steps)",
    )
    parser.add_argument(
        "repo",
        nargs="?",
        metavar="OWNER/NAME",
        help=(
            "Move by prompt instead: the GitHub repository the project is attached "
            "to, as owner/name (not the project's name); remembered after the first stage"
        ),
    )
    parser.add_argument(
        "--folder",
        default=None,
        metavar="DIR",
        help=(
            "Folder the export script saves into and the import script reads from "
            f"(default: ~/{pm.DEFAULT_EXPORTS_DIRNAME}; remembered)"
        ),
    )
    parser.add_argument(
        "--branch",
        default=None,
        help=f"With a repository: branch the export is pushed to (default: {pm.DEFAULT_BRANCH})",
    )
    parser.add_argument(
        "--token",
        default=None,
        help="With a repository: GitHub token for a private one (else GITHUB_TOKEN / GH_TOKEN)",
    )
    parser.add_argument(
        "--wait",
        nargs="?",
        type=int,
        const=0,
        default=None,
        metavar="SECONDS",
        help=(
            "check: look again every SECONDS until the export is there "
            "(default: 5 for a folder, 30 for GitHub)"
        ),
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=7200,
        metavar="SECONDS",
        help="check --wait: give up after this long (default 7200)",
    )
    parser.add_argument(
        "--url",
        default=None,
        help=(
            f"Page to open after copying (default: {pm.CLAUDE_URL} for a script, "
            f"{pm.CLAUDE_CODE_URL} for a prompt)"
        ),
    )
    parser.add_argument("--no-open", action="store_true", help="Do not open the browser")
    parser.add_argument("--no-clip", action="store_true", help="Do not touch the clipboard")
    parser.add_argument(
        "--print",
        dest="print_prompt",
        action="store_true",
        help="Print the script or prompt to stdout too",
    )
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args(argv)
    stage = args.stage or "steps"

    try:
        switcher = ClaudeAccountSwitcher(debug=args.debug)
        _guard_root(switcher)
        root = switcher.backup_dir
        state = pm.MoveState.load(root)
        carrier = pm.resolve_carrier(
            state,
            stage,
            args.repo,
            args.folder,
            branch_options=bool(args.branch or args.token),
        )
        if carrier == pm.CARRIER_FOLDER:
            _project_move_by_script(pm, args, stage, state, root)
        else:
            _project_move_by_prompt(pm, args, stage, state, root)
    except ClaudeSwitchError as e:
        error(f"Error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print(f"\n{dimmed('Operation cancelled')}")
        sys.exit(130)


def _project_move_auto(argv: list[str]) -> None:
    """Handle `cswap project-move auto|login`: the move with no clicks.

    cswap opens one browser window per account (Chrome or Edge, each on a
    profile folder of its own that keeps its sign-in), runs the export
    script in the source window and the import script in the destination
    window, and carries the export between them itself.
    """
    from claude_swap import project_move as pm
    from claude_swap import project_move_auto as pma

    stage, rest = argv[0], argv[1:]
    prog = _prog_name()
    parser = argparse.ArgumentParser(
        prog=f"{prog} project-move {stage}",
        description=(
            "Move a claude.ai Project to another account with no clicks: cswap opens a "
            "browser window for each account and runs the export and the import itself."
            if stage == "auto"
            else "Open a browser window for each account and wait until both are signed in "
            "to claude.ai (the one-time step of project-move auto)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""
The first time, a browser window opens for each account in turn, and the
terminal says whose it is: sign in to claude.ai there, then close that
window. That is all; the sign-ins are kept, and later runs need nothing
from you. (The sign-in window has no automation attached, so Google allows
it; claude.ai's "Continue with email" works there too.) The accounts and
the project are remembered as well, so the next move of the same project
is just:
  {prog} project-move auto

If a window was signed in as the wrong account, start over with --fresh:
the sign-ins are forgotten and each window asks again.

claude.ai sometimes runs a security check ("Performing security
verification") that does not pass in a window cswap drives. That window
is then closed and a normal one opened in its place, saying so in blue:
pass the check there (tick its box if it shows one), and cswap carries on
once claude.ai shows. If the check comes straight back, cswap stops.

An import that stops part-way (the check, a closed window) leaves the new
project with what was added by then. The next run carries on in it, with
the export already made, and nothing is made twice; --into names such a
project yourself, --new makes a new project instead.

Examples:
  {prog} project-move login --from 2 --to 1
  {prog} project-move login --fresh
  {prog} project-move auto beethoven --from 2 --to 1
  {prog} project-move auto https://claude.ai/code/project/chan_... --from 2 --to 1
  {prog} project-move auto --into https://claude.ai/code/project/chan_...
""",
    )
    if stage == "auto":
        parser.add_argument(
            "project",
            nargs="?",
            help=(
                "The project to move: its name, its claude.ai address, or its id "
                "(default: the one moved last; none needed when the account has one project)"
            ),
        )
    parser.add_argument("--from", dest="source", metavar="ACCOUNT", help="Source account: slot number, email or alias")
    parser.add_argument("--to", dest="destination", metavar="ACCOUNT", help="Destination account: slot number, email or alias")
    if stage == "auto":
        parser.add_argument("--name", default="", help="Name for the new project (default: the old one's)")
        parser.add_argument(
            "--folder",
            default=None,
            metavar="DIR",
            help=f"Folder the export is saved in (default: ~/{pm.DEFAULT_EXPORTS_DIRNAME}; remembered)",
        )
        parser.add_argument(
            "--into",
            default="",
            metavar="PROJECT",
            help="Carry on in the project an import that stopped part-way made: its claude.ai address or id",
        )
        parser.add_argument(
            "--new",
            action="store_true",
            help="Make a new project, although the last import stopped part-way in one",
        )
    parser.add_argument("--browser", default=None, metavar="PATH", help="Chrome or Edge to use (default: found)")
    parser.add_argument(
        "--login-timeout",
        type=int,
        default=1800,
        metavar="SECONDS",
        help="How long to wait for a sign-in (default 1800)",
    )
    parser.add_argument("--keep-open", action="store_true", help="Leave the destination window open when done")
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="Forget both accounts' sign-ins first, so each window asks for its sign-in again",
    )
    parser.add_argument("--site", default=pm.CLAUDE_URL, help=argparse.SUPPRESS)
    parser.add_argument("--headless", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--browser-arg", action="append", default=[], help=argparse.SUPPRESS)
    parser.add_argument("--label-seconds", type=float, default=None, help=argparse.SUPPRESS)
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args(rest)

    try:
        switcher = ClaudeAccountSwitcher(debug=args.debug)
        _guard_root(switcher)
        root = switcher.backup_dir
        settings = pma.AutoSettings.load(root)
        source_spec = args.source or settings.source
        dest_spec = args.destination or settings.destination
        if not source_spec or not dest_spec:
            raise ValidationError(
                f"Name both accounts, for example: {prog} project-move {stage} --from 2 --to 1"
            )
        source = _auto_account(switcher, "source", source_spec)
        destination = _auto_account(switcher, "destination", dest_spec)
        if args.fresh:
            pma.forget([source, destination], root, say=print)
        common = dict(
            site=args.site,
            browser=args.browser,
            login_timeout=args.login_timeout,
            keep_open=args.keep_open,
            headless=args.headless,
            extra_args=args.browser_arg,
            label_seconds=args.label_seconds,
            say=print,
        )

        if stage == "login":
            who = pma.login([source, destination], root, **common)
            settings.source, settings.destination = source_spec, dest_spec
            settings.save(root)
            print(f"{accent('Signed in')}: {who[0]} (source) and {who[1]} (destination).")
            print(dimmed(f"From now on, {prog} project-move auto needs no sign-in."))
            return

        project = args.project if args.project is not None else settings.project
        state = pm.MoveState.load(root)
        folder = pm.resolve_folder(state, args.folder)
        into = args.into or ("" if args.new else settings.into)
        export = None
        if into:
            # Carrying on in a project: with the export that import was
            # given, when it is still whole, so nothing is exported again.
            export = pma.matching_export(folder, project or "", state.export_path)
            if export is None:
                print(dimmed(f"No finished export of the project is in {folder}, so it is exported again first."))
            else:
                print(f"Carrying on in {into}, with the export in {export.path}; nothing is exported again.")

        settings.source, settings.destination, settings.project = source_spec, dest_spec, project or ""
        try:
            result = pma.move(
                source, destination, root, folder, project=project or "", name=args.name, into=into, export=export, **common
            )
        except pma.Interrupted as e:
            # What there is to carry on from is kept, for the next run.
            if e.url:
                settings.into = e.url
            settings.save(root)
            if e.export is not None:
                _note_export(pm, state, folder, e.export)
                state.save(root)
            error(f"Error: {e}")
            if e.url:
                print(f"The project {e.url} exists and holds what was added before the stop.")
                print(f"To carry on in it (nothing is exported again): {prog} project-move auto")
            sys.exit(1)

        settings.into = ""
        settings.save(root)
        if result.export is not None:
            _note_export(pm, state, folder, result.export)
        state.imported_at = pm._now_iso()
        state.save(root)

        print(f"{accent('Moved')}: the new project is at {result.url or '(its address was not shown)'}")
        if result.export is not None:
            print(dimmed(f"The export is kept in {result.export.path}"))
    except ClaudeSwitchError as e:
        error(f"Error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print(f"\n{dimmed('Operation cancelled')}")
        sys.exit(130)


def _note_export(pm, state, folder, export) -> None:
    """Record in the move's state the export `project-move auto` made or used."""
    if state.export_path != str(export.path) or state.imported_at:
        pm.begin_move(state, pm.CARRIER_FOLDER, changed=True)
    state.folder = str(folder)
    state.export_seen_at = pm._now_iso()
    state.export_path = str(export.path)


def _auto_account(switcher, role: str, spec: str):
    """An account of `project-move auto`, from a slot number, email or alias."""
    from claude_swap.exceptions import AccountNotFoundError
    from claude_swap.project_move_auto import Account

    try:
        _num, email, org = switcher.resolve_account(spec)
    except AccountNotFoundError:
        if "@" not in spec:
            raise
        # An account cswap does not hold yet still has a window of its own.
        email, org = spec.strip(), ""
    return Account(role=role, label=spec, email=email, org=org)


_STEP_MARKS = {"done": "[done]", "next": "[next]", "todo": "[    ]"}


def _print_steps(rows: list[tuple[str, str, str]], again: str) -> None:
    """The numbered step list of `project-move`, with what is done marked.

    ``again`` is the command that begins another move, shown once every step
    of this one is done.
    """
    style = {"done": accent, "next": bolded, "todo": dimmed}
    for i, (status, title, how) in enumerate(rows, 1):
        print(f"{style[status](_STEP_MARKS[status])} {i}. {title}")
        if how != "(paste)":
            for line in how.splitlines():
                print(f"           {line}")
    if all(status == "done" for status, _, _ in rows):
        print(dimmed(f"All steps are done. To move another project: {again}"))


def _hand_out(pm, args, what: str, text: str, path) -> None:
    """Put a script or prompt on the clipboard and say where it went."""
    tool = None if args.no_clip else pm.copy_to_clipboard(text)
    if args.print_prompt:
        print(text)
    if tool:
        print(f"{accent('Copied')} the {what} to the clipboard ({tool}).")
    else:
        print(f"{accent('Saved')} the {what} to: {path}")
        if not args.no_clip:
            print(dimmed("No clipboard tool found; open the file and copy its contents."))


def _open_page(pm, args, default_url: str) -> None:
    if args.no_open:
        return
    url = args.url or default_url
    if pm.open_url(url):
        print(dimmed(f"Opened {url}"))
    else:
        print(dimmed(f"Could not open a browser; go to {url}"))


def _project_move_by_script(pm, args, stage: str, state, root) -> None:
    """The stages of `project-move` done with the browser scripts and a folder."""
    prog = _prog_name()
    folder = pm.resolve_folder(state, args.folder)
    paste = "Cmd+V" if sys.platform == "darwin" else "Ctrl+V"
    console = "Cmd+Option+J" if sys.platform == "darwin" else "F12"

    if stage == "steps":
        # Looking at the steps of one carrier does not switch a move that is
        # under way with the other: they are shown from the start, and
        # nothing is saved unless the move is this one's.
        current = pm.effective_carrier(state) == pm.CARRIER_FOLDER
        if not current:
            state = pm.MoveState()
        state.carrier = pm.CARRIER_FOLDER
        state.folder = str(folder)
        check = None
        if state.exported_at and not state.export_seen_at:
            check = pm.check_folder(folder, pm._epoch(state.exported_at))
            if check.ready and current:
                state.export_seen_at = pm._now_iso()
                state.export_path = str(pm.import_target(check, check.ready))
                state.save(root)
        print(f"Project move by browser script (folder {folder})")
        _print_steps(pm.steps(state, check), f"{prog} project-move export")
        return

    if stage == "export":
        state.folder = str(folder)
        pm.begin_move(state, pm.CARRIER_FOLDER)
        text = pm.script_text("export")
        path = pm.write_script_file(root, "export", text)
        try:
            # So that it is there to choose when the browser asks for a folder.
            folder.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            warning(f"Could not create {folder} ({e.strerror or e}); choose another folder with --folder.")
        state.save(root)

        _hand_out(pm, args, "export script", text, path)
        print("Now, in Chrome or Edge, signed in to claude.ai as the SOURCE account:")
        print("  1. Open the project you want to move.")
        print(f"  2. Press {console}, open the Console tab, paste ({paste}) and press Enter.")
        print('  3. Press "Export Claude Project" (bottom right) and choose this folder:')
        print(f"       {folder}")
        print('The page shows its progress and says "Done" when the project is saved.')
        print(dimmed('The first time, the browser asks you to type "allow pasting" before it takes a paste.'))
        print(dimmed(
            "A Claude Code project's memory is only in the export if its Claude "
            "has saved it into the project's files."
        ))
        print(dimmed(f"Then run: {prog} project-move check"))
        _open_page(pm, args, pm.CLAUDE_URL)
        return

    # `check` and `import` look at what has been exported. A folder named on
    # the command line may be one export itself; the folder remembered for
    # the next export is then the one it sits in.
    result = pm.check_folder(folder, pm._epoch(state.exported_at))
    ready = pm.settle_export(result, "" if args.folder else state.export_path)
    target = pm.import_target(result, ready)
    state.folder = str(folder.parent if result.direct else folder)

    if stage == "import":
        text = pm.script_text("import")
        path = pm.write_script_file(root, "import", text)
        state.carrier = pm.CARRIER_FOLDER
        state.export_path = str(target) if ready else ""
        if ready:
            # Handing the script out counts as the import step only when
            # there is an export for it to import.
            state.export_seen_at = state.export_seen_at or pm._now_iso()
            state.imported_at = pm._now_iso()
        state.save(root)

        several = target == result.folder and len(result.own) > 1
        _hand_out(pm, args, "import script", text, path)
        if not ready:
            warning(
                f"No finished export of this move was found in {folder}. "
                f"`{prog} project-move check` shows what is there."
            )
        elif several:
            print(f"{len(result.own)} exports are ready in {result.folder}.")
        else:
            kind = "Claude Code project" if ready.kind == "code" else "project"
            print(f"Export to import: {ready.name} ({kind}; {_export_totals(pm, ready)}).")
        print("Now, in Chrome or Edge, signed in to claude.ai as the DESTINATION account:")
        print("  1. Open any claude.ai page.")
        print(f"  2. Press {console}, open the Console tab, paste ({paste}) and press Enter.")
        print('  3. Press "Import Claude Project" (bottom left) and choose this folder:')
        print(f"       {target}")
        if several:
            print(dimmed("     (it holds several exports; the script asks which one to import)"))
        print("It shows what it will create and asks for a name, then makes a NEW private project.")
        print("Nothing that already exists is changed, and nothing is deleted.")
        if not ready or several or ready.kind == "code":
            print(dimmed(
                "A Claude Code project arrives paused: open it and press Resume "
                "when you want its Claude to start."
            ))
        _open_page(pm, args, pm.CLAUDE_URL)
        return

    # check
    state.carrier = pm.CARRIER_FOLDER
    state.save(root)
    interval = args.wait if args.wait and args.wait > 0 else 5
    deadline = time.monotonic() + args.timeout
    shown: list[str] | None = None
    while True:
        report = _folder_check_lines(pm, result, ready, target, prog)
        # Said again only when something changed: a folder is looked at every
        # few seconds, and the same lines over and over say nothing.
        changed = report != shown
        if changed:
            for line in report:
                print(line)
            shown = report
        if ready:
            state.export_seen_at = pm._now_iso()
            state.export_path = str(target)
            state.save(root)
            print("Next: sign in to claude.ai as the destination account,")
            print(f"      then run: {prog} project-move import")
            return
        if args.wait is None:
            if result.exists and not result.error and not result.direct:
                if state.exported_at:
                    print(dimmed(
                        'If the export is still running in the browser, wait for the page to say "Done" '
                        f"(or have this wait for it: {prog} project-move check --wait)."
                    ))
                print(dimmed(f"To export a project into this folder: {prog} project-move export"))
            sys.exit(2)
        if time.monotonic() >= deadline:
            error(f"Gave up after {args.timeout}s; no finished export has appeared in {folder}.")
            sys.exit(2)
        if changed:
            print(dimmed(f"Looking again every {interval}s until an export is ready (Ctrl+C to stop)..."))
        time.sleep(interval)
        result = pm.check_folder(folder, pm._epoch(state.exported_at))
        ready = pm.settle_export(result, "" if args.folder else state.export_path)
        target = pm.import_target(result, ready)


def _export_totals(pm, export) -> str:
    """How much one export holds, in the words `check` and `import` both use."""
    return (
        f"{export.files} file(s), {export.conversations} saved conversation(s), "
        f"{pm.size_text(export.bytes)}"
    )


def _folder_check_lines(pm, result, chosen, target, prog: str) -> list[str]:
    """What a `project-move check` of a folder found, as lines to print.

    ``chosen`` is an export this move can import, when there is one, and
    ``target`` the folder the import will be pointed at.
    """
    lines = [f"{result.folder}"]
    if not result.exists:
        lines.append(f"  The folder does not exist yet. Run: {prog} project-move export")
        return lines
    if result.error:
        lines.append(f"  {result.error}")
        return lines

    exports = list(result.exports)
    if chosen is not None and all(export.path != chosen.path for export in exports):
        # Settled on by an earlier `check`, and not among the ones just found.
        exports.insert(0, chosen)

    for export in exports:
        kind = "Claude Code project" if export.kind == "code" else "project"
        saved = time.strftime("%Y-%m-%d %H:%M", time.localtime(export.finished_at))
        # Where it is, when that is not simply "in the folder above".
        where = "" if result.direct or export.path.parent == result.folder else f"  [{export.path}]"
        lines.append(
            f"  {export.name}  ({kind}, saved {saved}){where}" if export.kind else f"  {export.path.name}{where}"
        )
        if export.error:
            lines.append(f"    Not usable: {export.error}")
            continue
        totals = _export_totals(pm, export)
        if export.complete:
            lines.append(f"    {accent('Export is complete')}: {totals}")
        else:
            lines.append(f"    Export is NOT complete: {totals} found")
            for label, names in (
                (f"listed in {pm.MANIFEST_NAME} but not in the folder", export.missing),
                ("in the folder with another size than recorded", export.wrong_size),
            ):
                if names:
                    more = f" (and {len(names) - 5} more)" if len(names) > 5 else ""
                    lines.append(f"    {len(names)} file(s) {label}: {', '.join(names[:5])}{more}")
            lines.append("    Export the project again.")
        if export.problems:
            lines.append(
                f"    {len(export.problems)} thing(s) could not be exported from claude.ai; "
                "the README in that folder lists them."
            )
        if chosen is not None and export.path == target:
            if len(exports) > 1:
                lines.append("    This is the one the import will be pointed at.")
        elif export.complete and all(export.path != mine.path for mine in result.own):
            lines.append(
                "    Saved before this move began. To move this one anyway: "
                f'{prog} project-move check --folder "{export.path}"'
            )
    for name in result.unfinished:
        lines.append(
            f'  "{name}" has no {pm.MANIFEST_NAME}: its export has not finished, or an older script made it.'
        )
    if not exports and not result.unfinished:
        lines.append("  No export in this folder yet.")
    if chosen is not None and target == result.folder and len(result.own) > 1:
        lines.append(f"  {len(result.own)} exports are ready here; the import script asks which one to import.")
    return lines


def _project_move_by_prompt(pm, args, stage: str, state, root) -> None:
    """The stages of `project-move` done with thread prompts and a git branch."""
    prog = _prog_name()
    if args.branch:
        state.branch = args.branch

    if stage in ("export", "import"):
        repo = pm.resolve_repo(state, args.repo)
        if stage == "export":
            pm.begin_move(state, pm.CARRIER_BRANCH, changed=repo != state.repo)
        else:
            state.carrier = pm.CARRIER_BRANCH
            state.imported_at = pm._now_iso()
        state.repo = repo
        text = pm.render_prompt(stage, state.repo, state.branch)
        path = pm.write_prompt_file(root, stage, text)
        state.save(root)

        _hand_out(pm, args, f"{stage} prompt", text, path)
        if stage == "export":
            # The export puts the project's chat, memory and files on a
            # branch; say so loudly when the repository is public.
            probe = pm.check_repo(state.repo, state.branch, pm.github_token(args.token))
            if probe.private is False:
                warning(
                    f"{state.repo} is PUBLIC: the exported chat, memory and files "
                    "will be public too. Use a private repository if that matters."
                )
        where = (
            "the OLD project's chat, logged in as the SOURCE account"
            if stage == "export"
            else "the NEW project's chat, logged in as the DESTINATION account"
        )
        print(f"Now paste it (Ctrl+V) in {where}, and send.")
        if stage == "export":
            print(dimmed(f"Then run: {prog} project-move check --wait"))
        _open_page(pm, args, pm.CLAUDE_CODE_URL)
        return

    if stage == "check":
        state.repo = pm.resolve_repo(state, args.repo)
        state.carrier = pm.CARRIER_BRANCH
        state.save(root)
        token = pm.github_token(args.token)
        interval = args.wait if args.wait and args.wait > 0 else 30
        deadline = time.monotonic() + args.timeout
        while True:
            result = pm.check_repo(state.repo, state.branch, token)
            _print_repo_check(result)
            if result.export_ready:
                state.branch_seen_at = pm._now_iso()
                state.save(root)
                print(f"Next: create the new project on {state.repo} as the destination account,")
                print(f"      then run: {prog} project-move import")
                return
            if result.exists is False or args.wait is None:
                sys.exit(2)
            if time.monotonic() >= deadline:
                error(f"Gave up after {args.timeout}s; the export branch is still not there.")
                sys.exit(2)
            print(dimmed(f"Checking again in {interval}s (Ctrl+C to stop)..."))
            time.sleep(interval)

    # steps. Looking at the steps of one carrier does not switch a move that
    # is under way with the other: they are shown from the start, and nothing
    # is saved unless the move is this one's.
    current = pm.effective_carrier(state) == pm.CARRIER_BRANCH
    if not current:
        state = pm.MoveState(repo=state.repo, branch=state.branch)
    state.carrier = pm.CARRIER_BRANCH
    if args.repo:
        state.repo = pm.resolve_repo(state, args.repo)
    check = None
    if state.repo and state.exported_at and not state.branch_seen_at:
        check = pm.check_repo(state.repo, state.branch, pm.github_token(args.token))
        if check.export_ready and current:
            state.branch_seen_at = pm._now_iso()
            state.save(root)
    print(
        f"Project move via GitHub repository {state.repo or pm.PLACEHOLDER_REPO} "
        f"(branch {state.branch})"
    )
    _print_steps(pm.steps(state, check), f"{prog} project-move export [OWNER/NAME]")


def _print_repo_check(result) -> None:
    """One line per fact from a `project-move check` run."""
    from claude_swap.project_move import EXPORT_DIR

    if result.error and result.exists is None:
        print(f"{result.repo}: {result.error}")
        return
    if result.exists is False:
        error(f"{result.repo}: {result.error}")
        return
    visibility = "PRIVATE" if result.private else "PUBLIC"
    print(f"{result.repo}: {visibility}" + ("" if result.private else "  (the export is public too)"))
    if result.error:
        print(f"  {result.error}")
        return
    if result.export_ready:
        print(f"  {accent('Export is up')}: branch {result.branch} has {EXPORT_DIR}/README.md")
    elif result.branch_exists:
        print(f"  Branch {result.branch} exists but has no {EXPORT_DIR}/README.md yet.")
    else:
        print(f"  Branch {result.branch} not pushed yet.")


def _use_native_tls() -> None:
    """Route TLS trust decisions through the OS-native verifier.

    Claude's token endpoint (``platform.claude.com``) serves a Let's Encrypt
    chain. Python's stdlib ``ssl`` uses OpenSSL, which on Windows loads the
    system cert store as a flat set and matches CA certs by *subject name*, so a
    stale, expired duplicate of an intermediate (e.g. an old ``ISRG Root X2``
    left in the user's store) can shadow the valid path and fail verification
    with "certificate has expired" even though the served chain is valid — which
    silently breaks inactive-account token refresh. The OS-native verifiers
    (SChannel on Windows, SecureTransport on macOS) build the chain correctly
    and don't trip on the expired duplicate — the same reason Claude Code (Node,
    with its own bundled roots) is unaffected. ``truststore`` delegates to them.

    Best-effort: on any failure fall back to stdlib ``ssl`` rather than block
    the CLI over a TLS-trust nicety.
    """
    try:
        import truststore

        truststore.inject_into_ssl()
    except Exception:
        pass


def _menubar_service(args) -> int:
    """Handle ``menubar --install-service|--uninstall-service|--service-status``.

    Split out of the dispatch chain because these three share one import and
    one output shape, and because the menu bar branch below them is a
    non-returning call — folding the service paths inline would leave the
    reader tracing which branches fall through to launching the app.
    """
    from claude_swap import launch_agent

    if args.install_service:
        # Installing a service for a menu bar that this interpreter cannot draw
        # is the worst version of the bug: it survives reboots and shows
        # nothing. Say so here too, not only when the menu bar is launched.
        from claude_swap.menubar import framework_build_warning

        unsupported = framework_build_warning()
        result = launch_agent.install()
        print(f"Menu bar service installed ({result['label']}).")
        print(f"  plist: {result['plist']}")
        print(f"  logs:  {result['stderr_log']}")
        print(
            dimmed(
                "It starts at login from now on. Re-run this after a cswap "
                "upgrade to point launchd at the new build."
            )
        )
        if unsupported:
            # The hint printed above is about upgrades. A reinstall does not
            # restart the service that is already running, so say that here.
            warning(
                unsupported + "\n  Then run: cswap menubar --install-service",
                file=sys.stderr,
            )
        return 0

    if args.uninstall_service:
        result = launch_agent.uninstall()
        if result["was_loaded"] or result["removed_plist"]:
            print("Menu bar service removed.")
        else:
            print("Menu bar service was not installed.")
        return 0

    result = launch_agent.status()
    if not result["installed"] and not result["loaded"]:
        print("Menu bar service is not installed.")
        print(dimmed("Install it with: cswap menubar --install-service"))
        return 0
    state = result["state"] or ("loaded" if result["loaded"] else "stopped")
    pid = f" (pid {result['pid']})" if result["pid"] else ""
    print(f"Menu bar service: {state}{pid}")
    print(f"  plist: {result['plist']}")
    if not result["installed"]:
        print(dimmed("launchd still has it loaded, but the plist is gone."))
    return 0


def main() -> None:
    """Main entry point for the CLI."""
    force_utf8_output()
    _use_native_tls()
    argv = sys.argv[1:]
    try:
        from claude_swap.appearance import cli_should_probe, cli_theme
        # `run` execs a child that takes over the terminal, and `--json`
        # must stay machine-readable — never probe (and emit the OSC query)
        # in either case.
        probe = cli_should_probe(argv, colors_enabled=printer.colors_enabled())
        name = cli_theme(load_ui_settings(paths.get_backup_root()).theme, colors=probe)
        printer.set_theme(name)
    except Exception:
        pass  # theme is cosmetic; never block the CLI on it

    # `run` and `auto` keep their dedicated pre-dispatch parsers.
    if argv and argv[0] == "run":
        _run_command(argv[1:])
        return  # only reachable in tests where exec/exit is mocked
    if argv and argv[0] == "teleport":
        _teleport_command(argv[1:])
        return  # only reachable in tests where sys.exit is mocked
    if argv and argv[0] == "auto":
        _auto_command(argv[1:])
        return  # only reachable in tests where sys.exit is mocked
    if len(sys.argv) > 1 and sys.argv[1] == "config":
        _config_command(sys.argv[2:])
        return
    if argv and argv[0] == "map":
        _map_command(argv[1:])
        return
    if argv and argv[0] == "unmap":
        _unmap_command(argv[1:])
        return
    if argv and argv[0] == "unclaimed":
        _unclaimed_command(argv[1:])
        return
    if argv and argv[0] == "alias":
        _alias_command(argv[1:])
        return
    if argv and argv[0] == "swap":
        _swap_command(argv[1:])
        return
    if argv and argv[0] == "move":
        _move_command(argv[1:])
        return
    if argv and argv[0] == "project-move":
        _project_move_command(argv[1:])
        return

    # Bare `cswap` in an interactive terminal opens the TUI dashboard (like
    # lazygit/k9s). TTY-gated on both ends so scripts and pipes keep getting
    # the usage error, and `cswap tui` stays the explicit spelling.
    if not argv and sys.stdout.isatty() and sys.stdin.isatty():
        argv = ["--tui"]

    # Memorable subcommands (`cswap switch <email>`, `cswap list`, `cswap help`, ...)
    # are rewritten to the equivalent flags so the original `--flag` interface
    # keeps working unchanged.
    argv = _translate_subcommand(argv)

    parser = argparse.ArgumentParser(
        prog=_prog_name(),
        usage="%(prog)s <command> [args] [options]",
        description="""Multi-Account Switcher for Claude Code

Commands:
  %(prog)s help                       show this help
  %(prog)s list                       list managed accounts
  %(prog)s status                     show current account
  %(prog)s switch                     rotate to the next account
  %(prog)s switch <num|email>         switch to a specific account
  %(prog)s add                        add the current account
  %(prog)s add-token [TOKEN|-]        register a setup-token or API key
  %(prog)s remove <num|email>         remove an account
  %(prog)s disable <num|email>        hold an account out of auto-rotation
  %(prog)s enable <num|email>         return a disabled account to rotation
  %(prog)s run <num|email> [-- ...]   run as an account, this terminal only
  %(prog)s run                        run the current dir's mapped account
  %(prog)s teleport --from A --to B    move a cloud session to another account
  %(prog)s map <num|email> [path]     map a directory to an account
  %(prog)s map                        list directory mappings
  %(prog)s unmap [path]               remove a directory mapping
  %(prog)s alias <num|email> <name>   set a short alias for an account
  %(prog)s alias <num|email> --unset  remove an account's alias
  %(prog)s alias                      list all aliases
  %(prog)s swap <a> <b>               exchange two accounts' slot numbers
  %(prog)s move <a> <slot>            assign an account to a slot (swaps if taken)
  %(prog)s project-move [stage]       move a claude.ai Project to another account
  %(prog)s project-move auto ...      the same, with no clicks (two sign-ins, once)
  %(prog)s auto                       auto-switch when nearing rate limits
  %(prog)s config [set KEY VALUE]     show or change settings (settings.json)
  %(prog)s unclaimed [--purge ID]     list or drop stashed credential entries
  %(prog)s export <path>              export accounts
  %(prog)s import <path>              import accounts
  %(prog)s import-usage <path>        adopt usage another machine read (list --json)
  %(prog)s tui                        interactive dashboard (also: bare %(prog)s)
  %(prog)s watch                      dashboard, opened on the live watch page
  %(prog)s menubar                    macOS menu bar app
  %(prog)s menubar --install-service  keep the menu bar running via launchd
  %(prog)s upgrade                    self-upgrade to latest
  %(prog)s purge                      remove all claude-swap data

Aliases: ls=list  rm=remove  update=upgrade""",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Flags combine with subcommands:
  %(prog)s switch --strategy best           # pick the account with most quota left
  %(prog)s switch --strategy next-available # rotate, skipping rate-limited accounts
  %(prog)s switch user@example.com
  %(prog)s list --token-status
  %(prog)s list --json
  %(prog)s import-usage usage.json --hold 600  # adopt another machine's list --json
  %(prog)s add --slot 3                      # add to a specific slot
  %(prog)s add-token sk-ant-oat01-... --email me@example.com
  %(prog)s run 2 -- --resume                 # forward args after '--' to claude
  %(prog)s auto --once                       # single auto-switch tick (cron-friendly)
  %(prog)s config set autoswitch.threshold 80

The original flag spellings (%(prog)s --switch, %(prog)s --list, ...) keep working.
        """,
    )

    # Version and debug flags (outside mutually exclusive group)
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging",
    )
    parser.add_argument(
        "--token-status",
        action="store_true",
        help="Show source-labelled OAuth token diagnostics (use with 'list')",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help=(
            "Emit machine-readable JSON to stdout (use with 'list', 'status', "
            "or 'switch'). See README 'JSON output for scripting'."
        ),
    )
    parser.add_argument(
        "--strategy",
        choices=["best", "next-available"],
        metavar="{best,next-available}",
        help=(
            "With bare 'switch': pick the target by remaining 5h/7d quota. "
            "'best' jumps to the account with the most headroom; "
            "'next-available' rotates to the next account, skipping any at their limit"
        ),
    )
    parser.add_argument(
        "--model",
        metavar="NAMES",
        help=(
            "With 'switch --strategy': also count these models' per-model "
            "weekly limits when comparing accounts (comma-separated display "
            "names, or 'all'). Defaults to the autoswitch.model setting"
        ),
    )
    parser.add_argument(
        "--slot",
        type=int,
        metavar="NUM",
        help="Specify slot number when adding account (use with 'add' or 'add-token')",
    )
    parser.add_argument(
        "--email",
        metavar="EMAIL",
        help=(
            "Email address for the account. Optional with 'add-token'; "
            "defaults to setup-token-{slot}@token.local (or "
            "api-key-{slot}@token.local for API keys) since these tokens "
            "carry no real email metadata."
        ),
    )
    parser.add_argument(
        "--account",
        metavar="NUM|EMAIL",
        help="Limit export to one account (use with 'export')",
    )
    parser.add_argument(
        "--alias",
        metavar="NAME",
        help="Set a short display alias for the account (use with 'add')",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help=(
            "Overwrite existing accounts during import; with 'switch <num|email>', "
            "activate the stored credentials without backing up the current "
            "login first"
        ),
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Include full ~/.claude.json in export (default: oauthAccount only)",
    )
    parser.add_argument(
        "--hold",
        type=float,
        metavar="SECONDS",
        help=(
            "With 'import-usage': keep this machine from fetching the "
            "imported accounts for this many seconds (0 lifts an earlier hold)"
        ),
    )
    parser.add_argument(
        "--install-service",
        action="store_true",
        help=(
            "With 'menubar': install a launchd LaunchAgent so the menu bar "
            "starts at login and restarts on crash (macOS)"
        ),
    )
    parser.add_argument(
        "--uninstall-service",
        action="store_true",
        help="With 'menubar': stop the LaunchAgent and remove its plist (macOS)",
    )
    parser.add_argument(
        "--service-status",
        action="store_true",
        help=(
            "With 'menubar': report whether the LaunchAgent is installed "
            "and running"
        ),
    )

    # Legacy `--flag` interface. Still fully supported (bare subcommands rewrite
    # into these, see _translate_subcommand), but hidden from --help so the
    # subcommands shown in the description are the one documented interface.
    # The group is not `required` because the "no command" case is handled
    # explicitly below (a required group with every member suppressed prints a
    # broken empty-list error).
    group = parser.add_mutually_exclusive_group(required=False)
    group.add_argument(
        "--add-account",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--remove-account",
        metavar="NUM|EMAIL",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--disable-account",
        metavar="NUM|EMAIL",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--enable-account",
        metavar="NUM|EMAIL",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--list",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--switch",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--switch-to",
        metavar="NUM|EMAIL",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--status",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--purge",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--export",
        metavar="PATH",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--import",
        dest="import_",
        metavar="PATH",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--import-usage",
        metavar="PATH",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--tui",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--watch",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--menubar",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--upgrade",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    group.add_argument(
        "--add-token",
        metavar="TOKEN|-",
        nargs="?",
        const="",
        help=argparse.SUPPRESS,
    )

    args = parser.parse_args(argv)

    # No action selected: emit a clean, subcommand-oriented message rather than
    # the raw argparse "one of the arguments ... is required" (which would list
    # the now-hidden legacy flags). Value actions can be falsy-but-set
    # (--add-token uses const=""), so test those with `is not None`.
    if not (
        args.add_account
        or args.list
        or args.switch
        or args.status
        or args.purge
        or args.tui
        or args.watch
        or args.menubar
        or args.upgrade
        or args.remove_account is not None
        or args.disable_account is not None
        or args.enable_account is not None
        or args.switch_to is not None
        or args.export is not None
        or args.import_ is not None
        or args.import_usage is not None
        or args.add_token is not None
    ):
        parser.error("no command given — try '%(prog)s help'" % {"prog": _prog_name()})

    if args.token_status and not args.list:
        parser.error("--token-status can only be used with 'list'")

    if args.json and not (args.list or args.status or args.switch or args.switch_to):
        parser.error("--json can only be used with 'list', 'status', or 'switch'")

    if args.json and args.token_status:
        # Token status is not part of the JSON v1 schema; reject rather than
        # silently ignore it (a future additive field can add it).
        parser.error("--token-status cannot be combined with --json")

    if args.strategy is not None and not args.switch:
        parser.error("--strategy can only be used with bare 'switch'")

    if args.model is not None and args.strategy is None:
        # Meaningless on a direct-target switch or plain rotation — nothing
        # usage-aware reads it there, so reject loudly rather than ignore.
        parser.error(
            "--model can only be used with 'switch --strategy best' or "
            "'switch --strategy next-available'"
        )

    if args.slot is not None and not (args.add_account or args.add_token is not None):
        parser.error("--slot can only be used with 'add' or 'add-token'")

    if args.email is not None and args.add_token is None:
        parser.error("--email can only be used with 'add-token'")

    if args.account is not None and not args.export:
        parser.error("--account can only be used with 'export'")

    if args.alias is not None and not args.add_account:
        parser.error("--alias can only be used with 'add'")

    if args.force and not (args.import_ or args.switch_to):
        parser.error("--force can only be used with 'import' or 'switch <num|email>'")

    if args.full and not args.export:
        parser.error("--full can only be used with 'export'")

    if args.hold is not None and args.import_usage is None:
        parser.error("--hold can only be used with 'import-usage'")

    if args.hold is not None and not (math.isfinite(args.hold) and args.hold >= 0):
        parser.error("--hold must be a non-negative number of seconds")

    if (
        args.install_service or args.uninstall_service or args.service_status
    ) and not args.menubar:
        parser.error(
            "--install-service, --uninstall-service and --service-status "
            "can only be used with 'menubar'"
        )

    # Self-upgrade runs before switcher init so we don't touch config/keychain
    # just to upgrade the tool itself.
    if args.upgrade:
        from claude_swap.update_check import run_self_upgrade

        try:
            sys.exit(run_self_upgrade())
        except KeyboardInterrupt:
            print(f"\n{dimmed('Upgrade cancelled')}")
            sys.exit(130)

    # Initialize switcher and dispatch under a single error handler so
    # init-time failures (e.g. MigrationError on a backup-dir collision)
    # are presented like every other ClaudeSwitchError: clean stderr line,
    # exit 1, no traceback.
    # JSON-capable commands return a payload; the CLI is the single point that
    # serializes it (so no command writes JSON to stdout itself).
    payload: dict | None = None
    try:
        switcher = ClaudeAccountSwitcher(debug=args.debug)

        # Check for root (unless in container) - POSIX only
        if sys.platform != "win32":
            if os.geteuid() == 0 and not switcher._is_running_in_container():
                error("Error: Do not run this script as root (unless running in a container)")
                sys.exit(1)

        if args.add_account:
            switcher.add_account(slot=args.slot, alias=args.alias)
        elif args.add_token is not None:
            switcher.add_account_from_token(
                token=args.add_token,
                email=args.email,
                slot=args.slot,
            )
        elif args.remove_account:
            switcher.remove_account(args.remove_account)
        elif args.disable_account is not None:
            switcher.set_account_disabled(args.disable_account, True)
        elif args.enable_account is not None:
            switcher.set_account_disabled(args.enable_account, False)
        elif args.list:
            payload = switcher.list_accounts(
                show_token_status=args.token_status,
                json_output=args.json,
            )
        elif args.switch:
            from claude_swap.settings import load_settings, parse_model_names

            # Only the usage-aware strategies read model limits: --model wins;
            # otherwise the persistent autoswitch.model setting applies
            # (announced by switch(), never silently).
            if args.strategy is None:
                models, model_source = (), None
            elif args.model is not None:
                models, model_source = parse_model_names(args.model), "cli"
            else:
                models = parse_model_names(load_settings(switcher.backup_dir).model)
                model_source = "autoswitch.model" if models else None
            payload = switcher.switch(
                strategy=args.strategy,
                json_output=args.json,
                models=models,
                model_source=model_source,
            )
            if payload is not None and models:
                payload["models"] = list(models)
                payload["modelSource"] = model_source
        elif args.switch_to:
            payload = switcher.switch_to(
                args.switch_to, json_output=args.json, force=args.force
            )
        elif args.status:
            payload = switcher.status(json_output=args.json)
        elif args.purge:
            switcher.purge()
        elif args.export:
            from claude_swap.transfer import export_accounts

            export_accounts(switcher, args.export, account=args.account, full=args.full)
        elif args.import_:
            from claude_swap.transfer import import_accounts

            import_accounts(switcher, args.import_, force=args.force)
        elif args.import_usage:
            from claude_swap.transfer import import_usage

            import_usage(switcher, args.import_usage, hold_s=args.hold)
        elif args.tui:
            from claude_swap.tui import run as tui_run

            sys.exit(tui_run(switcher))
        elif args.watch:
            from claude_swap.tui import run as tui_run

            sys.exit(tui_run(switcher, start="watch"))
        elif args.menubar:
            if sys.platform != "darwin":
                error("The menu bar is only available on macOS.")
                sys.exit(1)
            if args.install_service or args.uninstall_service or args.service_status:
                sys.exit(_menubar_service(args))
            # menubar is import-safe without the extra; a missing rumps
            # surfaces from run() as a ClaudeSwitchError with the install hint.
            from claude_swap.menubar import run as menubar_run

            sys.exit(menubar_run(switcher))
    except ClaudeSwitchError as e:
        # In JSON mode keep stdout pure JSON: emit the structured error envelope
        # there (exit 1) instead of a red stderr line.
        if args.json:
            print(json.dumps(error_envelope(e), indent=2))
        else:
            error(f"Error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        # Route the cancellation note to stderr in JSON mode so stdout stays
        # parseable (the guarantee covers completion / handled errors, not Ctrl-C).
        print(
            f"\n{dimmed('Operation cancelled')}",
            file=sys.stderr if args.json else sys.stdout,
        )
        sys.exit(130)

    if args.json and payload is not None:
        print(json.dumps(payload, indent=2))

    # Passive update notification (never fails). Skipped after --purge so we
    # don't immediately recreate <backup_root>/cache/update_check.json inside
    # the directory we just deleted. Skipped after --upgrade as a safety guard
    # in case the dispatch is later refactored to fall through.
    if not args.purge and not args.upgrade and not args.json:
        from claude_swap.update_check import check_for_update

        msg = check_for_update(__version__)
        if msg:
            print(f"\n{muted(msg)}", file=sys.stderr)


if __name__ == "__main__":
    main()
