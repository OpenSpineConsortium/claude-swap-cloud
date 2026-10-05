"""Teleport: move a cloud session from one account to a new cloud session of another.

``cswap teleport --from A --to B SESSION_ID`` chains three steps that Claude
Code already provides, each run as the right account through session mode
(``SessionManager.launch_env``) so the default login never moves:

1. ``claude --teleport SESSION_ID`` as account A: pulls the cloud session,
   checks out its branch and loads the transcript locally. It is interactive;
   the user exits claude when done to continue.
2. Write the handoff note (``claude_swap.handoff``) from A's local transcript,
   commit it at ``.claude/handoff/<id>.md``, and ``git push -u origin
   BRANCH``: the new cloud session clones the GitHub remote at the current
   branch, so local work and the note have to be on it.
3. ``claude --cloud "Read <note> first, then: TASK"`` as account B: starts a
   *new* cloud session. Claude Code cannot carry a conversation across
   accounts, so the note is the only context B gets. ``--handoff-in-prompt``
   puts the note in the prompt instead of the repository.

Both cloud commands need claude.ai subscription auth, so API-key accounts are
rejected up front, before anything runs.
"""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TYPE_CHECKING

from claude_swap.exceptions import SessionError
from claude_swap.handoff import (
    DEFAULT_HANDOFF_BYTES,
    HANDOFF_DIR,
    PROMPT_HANDOFF_BYTES,
    SUMMARIZE_PROMPT,
    HandoffContext,
    clip,
    find_transcript,
    handoff_filename,
    render_handoff,
)
from claude_swap.printer import accent, dimmed, warning

if TYPE_CHECKING:
    from claude_swap.session import SessionManager

DEFAULT_TASK = "Continue the work described in the handoff note."


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
    handoff_in_prompt: bool = False
    summarize: bool = False
    handoff_max_bytes: int = DEFAULT_HANDOFF_BYTES
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
            self._print_plan(plan, src, dst, teleport_args, repo)
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

        branch = git_branch(repo) if plan.push else _safe_branch(repo)
        if not git_is_clean(repo):
            raise TeleportError(
                f"{branch or 'The checkout'} has uncommitted changes. Commit "
                "them, then rerun with --skip-teleport so the cloud session "
                "gets them."
            )

        prompt = plan.task
        if plan.handoff:
            if source_env is None:
                # --skip-teleport: look where the source account's claude would.
                _, source_env = self.manager.launch_env(plan.source, share=plan.share)
                since = None
            else:
                since = started - 2  # slack for mtimes that lag the wall clock
            note, transcript = self._build_note(plan, repo, branch, source_env, since)
            if plan.handoff_in_prompt:
                prompt = f"{plan.task}\n\n{note}"
            else:
                rel = self._commit_note(plan, repo, note, transcript)
                prompt = f"Read {rel.as_posix()} first, then: {plan.task}"

        self._push(plan, repo, branch)

        print(
            f"{accent('Step 3/3')} Starting a cloud session as "
            f"Account-{dst[0]} ({dst[1]})."
        )
        rc, _ = self._launch(plan.target, ["--cloud", prompt], plan.share)
        if rc != 0:
            raise TeleportError(
                f"claude --cloud exited with code {rc}. The branch is pushed; "
                "rerun with --skip-teleport to retry this step."
            )
        return 0

    def _push(self, plan: TeleportPlan, repo: Path, branch: str | None) -> None:
        if not plan.push:
            print(dimmed("Step 2/3 skipped (--no-push)."))
            return
        if not git_has_origin(repo):
            warning(
                "No 'origin' remote; skipping the push. claude --cloud will "
                "upload the repository as a bundle instead."
            )
            return
        print(f"{accent('Step 2/3')} Pushing {branch} to origin.")
        result = subprocess.run(["git", "push", "-u", "origin", branch], cwd=repo)
        if result.returncode != 0:
            raise TeleportError(
                f"git push failed for {branch}. Fix the push, then rerun with "
                "--skip-teleport."
            )

    def _locate_transcript(
        self, plan: TeleportPlan, repo: Path, source_env: dict, since: float | None
    ) -> Path | None:
        config_dir = Path(
            source_env.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude"
        )
        for cwd in dict.fromkeys([self.cwd.resolve(), repo]):
            found = find_transcript(config_dir, cwd, plan.session_id, since)
            if found:
                return found
        return None

    def _summarize(self, plan: TeleportPlan, transcript: Path) -> str | None:
        """Ask the source session for a summary (``--summarize``); None on failure."""
        print(dimmed("Asking the previous session for a handoff summary..."))
        claude_bin, env = self.manager.launch_env(plan.source, share=plan.share)
        result = subprocess.run(
            [claude_bin, "--resume", transcript.stem, "-p", SUMMARIZE_PROMPT],
            env=env, cwd=self.cwd, capture_output=True, text=True,
        )
        if result.returncode != 0 or not (result.stdout or "").strip():
            warning("The summary step failed; the note is built without it.")
            return None
        return result.stdout

    def _build_note(
        self,
        plan: TeleportPlan,
        repo: Path,
        branch: str | None,
        source_env: dict,
        since: float | None,
    ) -> tuple[str, Path | None]:
        transcript = self._locate_transcript(plan, repo, source_env, since)
        if transcript is None:
            warning(
                "No local transcript found for the teleported session; the "
                "handoff note will only name the branch."
            )
        else:
            print(dimmed(f"Handoff note built from {transcript}"))
        summary = (
            self._summarize(plan, transcript)
            if plan.summarize and transcript is not None
            else None
        )
        max_bytes = plan.handoff_max_bytes
        if plan.handoff_in_prompt:
            max_bytes = min(max_bytes, PROMPT_HANDOFF_BYTES)
        note, redacted = render_handoff(
            HandoffContext(
                transcript=transcript,
                branch=branch,
                session_id=plan.session_id,
                task=plan.task,
                max_bytes=max_bytes,
                summary=summary,
            )
        )
        if redacted:
            print(dimmed(f"Redacted {redacted} credential-like string(s) from the note."))
        return note, transcript

    def _commit_note(
        self, plan: TeleportPlan, repo: Path, note: str, transcript: Path | None
    ) -> Path:
        rel = HANDOFF_DIR / handoff_filename(plan.session_id, transcript)
        path = repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(note + "\n", encoding="utf-8")
        # -f: a .gitignore'd .claude/ must not silently drop the note.
        added = subprocess.run(
            ["git", "add", "-f", "--", rel.as_posix()], cwd=repo,
            capture_output=True, text=True,
        )
        committed = added.returncode == 0 and subprocess.run(
            ["git", "commit", "-q", "-m", f"Add cswap handoff note {rel.name}",
             "--", rel.as_posix()],
            cwd=repo, capture_output=True, text=True,
        ).returncode == 0
        if not committed:
            raise TeleportError(
                f"Could not commit the handoff note at {rel.as_posix()}. Commit "
                "it yourself and rerun with --skip-teleport, or use "
                "--handoff-in-prompt."
            )
        print(dimmed(f"Committed the handoff note at {rel.as_posix()}."))
        if not plan.push and git_has_origin(repo):
            warning(
                "--no-push: the cloud session clones origin, so it will not "
                "see the handoff note until you push."
            )
        return rel

    def _print_plan(self, plan, src, dst, teleport_args, repo) -> None:
        steps = []
        if not plan.skip_teleport:
            steps.append(
                f"As Account-{src[0]} ({src[1]}): claude {' '.join(teleport_args)}"
            )
        if plan.handoff and not plan.handoff_in_prompt:
            steps.append(f"Commit the handoff note under {HANDOFF_DIR.as_posix()}/")
        steps.append(
            "git push -u origin <branch>" if plan.push else "(no push)"
        )
        steps.append(
            f"As Account-{dst[0]} ({dst[1]}): claude --cloud "
            f"\"{clip(plan.task, 60)}\""
            + (
                ""
                if not plan.handoff
                else " + handoff note" if plan.handoff_in_prompt
                else " (told to read the note first)"
            )
        )
        print(accent("Dry run; nothing will be launched, committed or pushed:"))
        for i, step in enumerate(steps, 1):
            print(f"  {i}. {step}")
        if plan.handoff and plan.skip_teleport:
            # The session is already local, so the note can be previewed.
            _, source_env = self.manager.launch_env(plan.source, share=plan.share)
            branch = _safe_branch(repo)
            note, _ = self._build_note(
                replace(plan, summarize=False), repo, branch, source_env, None
            )
            print(f"\n{accent('Handoff note:')}\n{note}")


def _safe_branch(repo: Path) -> str | None:
    try:
        return git_branch(repo)
    except TeleportError:
        return None
