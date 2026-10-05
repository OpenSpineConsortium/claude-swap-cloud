"""Teleport: move a cloud session from one account to a new cloud session of another.

``cswap teleport --from A --to B SESSION_ID`` chains three steps that Claude
Code already provides, each run as the right account through session mode
(``SessionManager.launch_env``) so the default login never moves:

1. ``claude --teleport SESSION_ID`` as account A: pulls the cloud session,
   checks out its branch and loads the transcript locally. It is interactive;
   the user exits claude when done to continue.
2. ``git push -u origin BRANCH``: the new cloud session clones the GitHub
   remote at the current branch, so local work has to be on it.
3. ``claude --cloud "TASK + handoff note"`` as account B: starts a *new* cloud
   session. Claude Code cannot carry a conversation across accounts, so the
   handoff note (built from A's local transcript) is the only context B gets.

Both cloud commands need claude.ai subscription auth, so API-key accounts are
rejected up front, before anything runs.
"""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from claude_swap.exceptions import SessionError
from claude_swap.handoff import (
    DEFAULT_HANDOFF_CHARS,
    build_handoff_note,
    clip,
    find_transcript,
    read_transcript,
    redact,
)
from claude_swap.printer import accent, dimmed, warning

if TYPE_CHECKING:
    from claude_swap.session import SessionManager

DEFAULT_TASK = (
    "Continue the work from the handoff note below. The repository is already "
    "on the branch it was left on."
)


class TeleportError(SessionError):
    """A teleport step failed; the message says which and how to resume."""


@dataclass
class TeleportPlan:
    source: str
    target: str
    session_id: str | None
    task: str
    push: bool = True
    handoff: bool = True
    handoff_chars: int = DEFAULT_HANDOFF_CHARS
    skip_teleport: bool = False
    share: bool = True
    dry_run: bool = False


# -- git -----------------------------------------------------------------


def _git(args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True
    )


def git_toplevel(cwd: Path) -> Path:
    result = _git(["rev-parse", "--show-toplevel"], cwd)
    if result.returncode != 0:
        raise TeleportError(
            "Not inside a git repository. Run cswap teleport from a local "
            "clone of the cloud session's repository."
        )
    return Path(result.stdout.strip())


def git_is_clean(cwd: Path) -> bool:
    result = _git(["status", "--porcelain"], cwd)
    return result.returncode == 0 and not result.stdout.strip()


def git_branch(cwd: Path) -> str:
    result = _git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
    branch = result.stdout.strip()
    if result.returncode != 0 or not branch or branch == "HEAD":
        raise TeleportError(
            "HEAD is detached, so there is no branch to push. Check out a "
            "branch, then rerun with --skip-teleport."
        )
    return branch


def git_has_origin(cwd: Path) -> bool:
    return _git(["remote", "get-url", "origin"], cwd).returncode == 0


# -- orchestration -------------------------------------------------------


class Teleporter:
    """Runs the teleport → push → cloud chain for one ``TeleportPlan``."""

    def __init__(self, manager: SessionManager, cwd: Path | None = None):
        self.manager = manager
        self.switcher = manager.switcher
        self.cwd = Path(cwd or os.getcwd())

    def _check_account(self, identifier: str, role: str) -> tuple[str, str, str]:
        account_num, email, org_uuid = self.switcher.resolve_account(identifier)
        if self.switcher._account_kind(account_num) == "api_key":
            raise TeleportError(
                f"Account-{account_num} ({email}) is an API-key account. "
                f"Teleport needs a claude.ai subscription login for the {role} "
                "account, since cloud sessions are tied to claude.ai."
            )
        return account_num, email, org_uuid

    def _launch(self, identifier: str, args: list[str], share: bool) -> tuple[int, dict]:
        claude_bin, env = self.manager.launch_env(identifier, share=share)
        try:
            rc = subprocess.run([claude_bin, *args], env=env, cwd=self.cwd).returncode
        except KeyboardInterrupt:
            rc = 130
        return rc, env

    def run(self, plan: TeleportPlan) -> int:
        src = self._check_account(plan.source, "source")
        dst = self._check_account(plan.target, "target")
        if src[0] == dst[0]:
            raise TeleportError(
                "--from and --to name the same account. Use `cswap run "
                f"{plan.source} -- --teleport` to pull a session into one account."
            )
        repo = git_toplevel(self.cwd)
        if not plan.skip_teleport and not git_is_clean(repo):
            raise TeleportError(
                "The working tree has uncommitted changes; claude --teleport "
                "needs a clean tree. Commit or stash them first."
            )

        teleport_args = ["--teleport", *([plan.session_id] if plan.session_id else [])]
        if plan.dry_run:
            self._print_plan(plan, src, dst, teleport_args)
            return 0

        source_env: dict[str, str] | None = None
        started = time.time()
        if plan.skip_teleport:
            print(dimmed("Skipping claude --teleport (--skip-teleport)."))
        else:
            print(
                f"{accent('Step 1/3')} Pulling the cloud session as "
                f"Account-{src[0]} ({src[1]}). Exit claude to continue."
            )
            rc, source_env = self._launch(plan.source, teleport_args, plan.share)
            if rc != 0:
                raise TeleportError(
                    f"claude --teleport exited with code {rc}; stopping before "
                    "anything is pushed."
                )

        branch = self._push(plan, repo)
        task = plan.task
        if plan.handoff:
            note = self._handoff(plan, repo, branch, source_env, started)
            task = f"{task}\n\n{note}"

        print(
            f"{accent('Step 3/3')} Starting a cloud session as "
            f"Account-{dst[0]} ({dst[1]})."
        )
        rc, _ = self._launch(plan.target, ["--cloud", task], plan.share)
        if rc != 0:
            raise TeleportError(
                f"claude --cloud exited with code {rc}. The branch is pushed; "
                "rerun with --skip-teleport to retry this step."
            )
        return 0

    def _push(self, plan: TeleportPlan, repo: Path) -> str | None:
        if not plan.push:
            print(dimmed("Step 2/3 skipped (--no-push)."))
            return _safe_branch(repo)
        branch = git_branch(repo)
        if not git_is_clean(repo):
            raise TeleportError(
                f"Branch {branch} has uncommitted changes. Commit them, then "
                "rerun with --skip-teleport so the cloud session gets them."
            )
        if not git_has_origin(repo):
            warning(
                "No 'origin' remote; skipping the push. claude --cloud will "
                "upload the repository as a bundle instead."
            )
            return branch
        print(f"{accent('Step 2/3')} Pushing {branch} to origin.")
        result = subprocess.run(
            ["git", "push", "-u", "origin", branch], cwd=repo
        )
        if result.returncode != 0:
            raise TeleportError(
                f"git push failed for {branch}. Fix the push, then rerun with "
                "--skip-teleport."
            )
        return branch

    def _handoff(
        self,
        plan: TeleportPlan,
        repo: Path,
        branch: str | None,
        source_env: dict[str, str] | None,
        started: float,
    ) -> str:
        if source_env is None:
            # --skip-teleport: look where the source account's claude would.
            _, source_env = self.manager.launch_env(plan.source, share=plan.share)
            started_after = None
        else:
            # Slack for filesystems whose mtimes lag the wall clock.
            started_after = started - 2
        config_dir = Path(
            source_env.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude"
        )
        transcript = find_transcript(
            config_dir, self.cwd.resolve(), plan.session_id, started_after
        ) or (
            find_transcript(config_dir, repo, plan.session_id, started_after)
            if repo != self.cwd.resolve()
            else None
        )
        if transcript is None:
            warning(
                "No local transcript found for the teleported session; the "
                "handoff note will only name the branch."
            )
            messages = []
        else:
            print(dimmed(f"Handoff note built from {transcript}"))
            messages = read_transcript(transcript)
        note, redacted = redact(
            build_handoff_note(
                messages,
                branch=branch,
                session_id=plan.session_id,
                max_chars=plan.handoff_chars,
            )
        )
        if redacted:
            print(dimmed(f"Redacted {redacted} credential-like string(s) from the note."))
        return note

    def _print_plan(self, plan, src, dst, teleport_args) -> None:
        steps = []
        if not plan.skip_teleport:
            steps.append(
                f"As Account-{src[0]} ({src[1]}): claude {' '.join(teleport_args)}"
            )
        steps.append(
            "git push -u origin <branch>" if plan.push else "(no push)"
        )
        steps.append(
            f"As Account-{dst[0]} ({dst[1]}): claude --cloud "
            f"\"{clip(plan.task, 60)}\""
            + (" + handoff note" if plan.handoff else "")
        )
        print(accent("Dry run; nothing will be launched or pushed:"))
        for i, step in enumerate(steps, 1):
            print(f"  {i}. {step}")


def _safe_branch(repo: Path) -> str | None:
    try:
        return git_branch(repo)
    except TeleportError:
        return None
