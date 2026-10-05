"""Move a claude.ai Project between accounts (`cswap project-move`).

A claude.ai Project (project chat, threads, memory, shared files) can only be
read from inside one of its own threads, so no CLI can export it directly.
The move is therefore two prompts, one pasted in each Project, with a git
branch of the project's repository as the carrier:

1. ``export``: in the SOURCE project's chat (logged in as the source account)
   a thread writes the chat, threads, memory and shared files into
   ``.claude/project-export/`` on a new branch and pushes it.
2. ``check``: this machine polls GitHub until that branch (and its README)
   exists, and warns when the repository is public.
3. ``import``: in a NEW project under the DESTINATION account, pointed at the
   same repository, a thread restores memory and files from the branch.

What this module automates is everything around those two pastes: it renders
the exact prompts, puts them on the clipboard, writes them to a file as a
fallback, remembers the repository between stages, checks GitHub, and prints
the remaining manual steps in order. It never talks to claude.ai itself.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path

from claude_swap.exceptions import ValidationError

DEFAULT_BRANCH = "project-export"
EXPORT_DIR = ".claude/project-export"
HISTORY_DIR = "project-history"
CLAUDE_CODE_URL = "https://claude.ai/code"
STATE_FILE = "project-move.json"
PROMPT_DIR = "project-move"

_REPO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+$")
# What the step list prints before a repository is known. It is shaped like a
# real one, so pasting the step list back into a shell would otherwise run
# `export OWNER/NAME` for real and remember the placeholder as the repository.
PLACEHOLDER_REPO = "OWNER/NAME"
_GITHUB_PREFIXES = ("https://github.com/", "http://github.com/", "git@github.com:")


# ---------------------------------------------------------------------------
# Repository spec and persisted state
# ---------------------------------------------------------------------------


def normalize_repo(spec: str) -> str:
    """Return ``owner/name`` from ``owner/name`` or a GitHub URL / SSH remote.

    Raises :class:`ValidationError` for anything else, so a typo never turns
    into a 404 from GitHub that reads like "the export has not run yet".
    """
    value = spec.strip()
    for prefix in _GITHUB_PREFIXES:
        if value.startswith(prefix):
            value = value[len(prefix) :]
            break
    value = value.rstrip("/")
    if value.endswith(".git"):
        value = value[: -len(".git")]
    if value == PLACEHOLDER_REPO:
        raise ValidationError(
            f"{PLACEHOLDER_REPO} is the placeholder from the step list; put the real "
            "GitHub repository there (for example: owner/name)"
        )
    if not _REPO_RE.match(value):
        raise ValidationError(
            f"Not a GitHub repository: {spec!r} (expected {PLACEHOLDER_REPO} or a github.com URL)"
        )
    return value


@dataclass
class MoveState:
    """What the stages remember between invocations (``project-move.json``)."""

    repo: str = ""
    branch: str = DEFAULT_BRANCH
    exported_at: str = ""  # when the export prompt was generated
    imported_at: str = ""  # when the import prompt was generated
    branch_seen_at: str = ""  # when `check` last found the export branch
    extra: dict = field(default_factory=dict)

    @classmethod
    def load(cls, root: Path) -> "MoveState":
        path = root / STATE_FILE
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return cls()
        if not isinstance(raw, dict):
            return cls()
        known = {k: raw[k] for k in ("repo", "branch", "exported_at", "imported_at", "branch_seen_at") if isinstance(raw.get(k), str)}
        state = cls(**known)
        if state.repo == PLACEHOLDER_REPO:
            # Written by a version that accepted the placeholder: nothing in
            # that state is real, so start over rather than show it as done.
            return cls()
        if not state.branch:
            state.branch = DEFAULT_BRANCH
        return state

    def save(self, root: Path) -> Path:
        root.mkdir(parents=True, exist_ok=True)
        path = root / STATE_FILE
        payload = {
            "repo": self.repo,
            "branch": self.branch,
            "exported_at": self.exported_at,
            "imported_at": self.imported_at,
            "branch_seen_at": self.branch_seen_at,
        }
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        return path


def resolve_repo(state: MoveState, spec: str | None) -> str:
    """The repository for this stage: the argument, else the remembered one."""
    if spec:
        return normalize_repo(spec)
    if state.repo:
        return state.repo
    raise ValidationError(
        "No repository given and none remembered yet. "
        "Pass OWNER/NAME (for example: cswap project-move export owner/name)."
    )


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------


def _template(name: str) -> str:
    return (resources.files("claude_swap") / "prompts" / name).read_text(encoding="utf-8")


def render_prompt(stage: str, repo: str, branch: str = DEFAULT_BRANCH) -> str:
    """Fill the export or import prompt template for ``repo``/``branch``."""
    if stage not in ("export", "import"):
        raise ValueError(f"unknown stage: {stage}")
    text = _template(f"project-{stage}.md")
    return text.format(
        repo=repo,
        branch=branch,
        export_dir=EXPORT_DIR,
        history_dir=HISTORY_DIR,
    ).strip() + "\n"


def write_prompt_file(root: Path, stage: str, text: str) -> Path:
    """Save the rendered prompt next to the state file (the clipboard fallback)."""
    directory = root / PROMPT_DIR
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{stage}-prompt.md"
    path.write_text(text, encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Clipboard and browser
# ---------------------------------------------------------------------------


def _clipboard_commands(platform: str | None = None) -> list[list[str]]:
    plat = platform or sys.platform
    if plat == "win32":
        return [["clip"]]
    if plat == "darwin":
        return [["pbcopy"]]
    return [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]


def copy_to_clipboard(text: str, platform: str | None = None) -> str | None:
    """Put ``text`` on the system clipboard; returns the tool used, or None.

    Tries the platform's native tool(s) in order and gives up quietly: a
    missing clipboard tool (headless Linux, SSH) must not fail the stage,
    since the prompt is also written to a file.
    """
    for cmd in _clipboard_commands(platform):
        if shutil.which(cmd[0]) is None:
            continue
        try:
            # clip.exe reads the console code page; the prompts are ASCII so
            # UTF-8 bytes are safe everywhere.
            proc = subprocess.run(cmd, input=text.encode("utf-8"), capture_output=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            continue
        if proc.returncode == 0:
            return cmd[0]
    return None


def open_url(url: str) -> bool:
    """Open ``url`` in the default browser; False when no browser could be found."""
    try:
        return bool(webbrowser.open(url, new=2))
    except Exception:
        return False


# ---------------------------------------------------------------------------
# GitHub checks
# ---------------------------------------------------------------------------


@dataclass
class RepoCheck:
    repo: str
    branch: str
    exists: bool | None = None  # None: could not tell (404 without a token)
    private: bool | None = None
    default_branch: str = ""
    branch_exists: bool | None = None
    export_readme: bool | None = None
    error: str = ""

    @property
    def export_ready(self) -> bool:
        return bool(self.branch_exists and self.export_readme)


def github_token(explicit: str | None = None) -> str | None:
    """A token from ``--token``, ``GITHUB_TOKEN`` or ``GH_TOKEN`` (in that order)."""
    for value in (explicit, os.environ.get("GITHUB_TOKEN"), os.environ.get("GH_TOKEN")):
        if value and value.strip():
            return value.strip()
    return None


def _github_get(path: str, token: str | None, timeout: float = 10.0) -> tuple[int, dict | None]:
    req = urllib.request.Request(
        "https://api.github.com" + path,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "claude-swap project-move",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            try:
                return resp.status, json.loads(body or b"{}")
            except ValueError:
                return resp.status, None
    except urllib.error.HTTPError as e:
        return e.code, None


def check_repo(repo: str, branch: str, token: str | None = None) -> RepoCheck:
    """Ask GitHub whether ``repo`` is private and whether the export branch is up.

    Three calls: the repository (visibility), the branch, and the export's
    README (so a branch pushed by hand without the export is not mistaken for
    a finished export). Network errors land in ``error`` rather than raising:
    ``check --wait`` keeps polling through them.
    """
    result = RepoCheck(repo=repo, branch=branch)
    try:
        status, data = _github_get(f"/repos/{repo}", token)
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        result.error = f"GitHub unreachable: {e}"
        return result
    if status == 200 and isinstance(data, dict):
        result.exists = True
        result.private = bool(data.get("private"))
        result.default_branch = str(data.get("default_branch") or "")
    elif status == 404:
        # A private repo looks like 404 to an anonymous caller.
        result.exists = False if token else None
        result.error = (
            "repository not found"
            if token
            else "repository not found, or private (pass --token / set GITHUB_TOKEN to see private repos)"
        )
        return result
    elif status in (401, 403):
        result.error = "GitHub refused the request (bad token or rate limit); try again with --token"
        return result
    else:
        result.error = f"unexpected GitHub response {status}"
        return result

    try:
        status, _ = _github_get(f"/repos/{repo}/branches/{branch}", token)
        result.branch_exists = status == 200
        if result.branch_exists:
            status, _ = _github_get(f"/repos/{repo}/contents/{EXPORT_DIR}/README.md?ref={branch}", token)
            result.export_readme = status == 200
        else:
            result.export_readme = False
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        result.error = f"GitHub unreachable: {e}"
    return result


# ---------------------------------------------------------------------------
# The step list
# ---------------------------------------------------------------------------


def steps(state: MoveState, check: RepoCheck | None = None) -> list[tuple[str, str, str]]:
    """The manual steps in order as ``(status, title, what to run or paste)``.

    ``status`` is ``done``, ``next`` or ``todo``. Done-ness is inferred from the
    state file and, when given, a fresh GitHub check; the two pastes inside
    claude.ai cannot be observed, so generating a prompt counts as its step.
    """
    repo = state.repo or PLACEHOLDER_REPO
    branch = state.branch or DEFAULT_BRANCH
    branch_flag = "" if branch == DEFAULT_BRANCH else f" --branch {branch}"
    export_done = bool(state.exported_at)
    branch_up = bool(check and check.export_ready) or (bool(state.branch_seen_at) and check is None)
    import_done = bool(state.imported_at)

    items: list[tuple[bool, str, str]] = [
        (
            export_done,
            "Generate the export prompt (copies it to the clipboard)",
            f"cswap project-move export {repo}{branch_flag}",
        ),
        (
            export_done,
            "Logged in to claude.ai as the SOURCE account, open the old project's chat and paste (Ctrl+V), then send",
            "(paste)",
        ),
        (
            branch_up,
            "Wait for the export thread to push the branch",
            f"cswap project-move check --wait",
        ),
        (
            import_done,
            "Logged in to claude.ai as the DESTINATION account, create a new project on the same repository",
            f"{CLAUDE_CODE_URL}  (New project -> repository {repo})",
        ),
        (
            import_done,
            "Generate the import prompt (copies it to the clipboard)",
            "cswap project-move import",
        ),
        (
            import_done,
            "In the new project's chat paste (Ctrl+V), then send",
            "(paste)",
        ),
    ]
    out: list[tuple[str, str, str]] = []
    next_marked = False
    for done, title, how in items:
        if done:
            status = "done"
        elif not next_marked:
            status = "next"
            next_marked = True
        else:
            status = "todo"
        out.append((status, title, how))
    return out
