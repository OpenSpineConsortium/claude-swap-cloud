"""Session state: carry one Claude Code session, exactly, to another account
or folder, and keep its state across a compaction.

``cswap state export`` packs a session into one ``.tar``: the transcript's
exact bytes (what ``claude --resume`` reads), the session's own folder beside
it (its subagents' transcripts), the uncommitted work of the repository
(``git diff --binary HEAD`` and the untracked files git does not ignore) and
``state.json``, a manifest with the state of the work read from the
transcript. ``cswap state import`` puts the transcript under the target
account's ``projects/`` for the target folder, checks it against the
manifest's digest, optionally applies the uncommitted work, and can start
``claude --resume`` there, so the other account or folder continues the same
conversation rather than a summary of it. ``cswap state move --from A --to
B SESSION`` does the whole hand-over for a cloud thread: ``claude --teleport``
as A pulls the thread and its branch down, its exact transcript is placed in
B's profile for the same folder, and ``claude --resume`` continues it as B.

The state read from the transcript (``state_vectors``) is what the Binary
State Approximation Protocol asked for, built on handoff.py's readers: the
branch, the last request, the todo list, the files edited, the tool errors
and the subagents started. Two Claude Code hooks keep it across compactions
(``cswap state hooks install``): before a compaction ``cswap state hook
pre-compact`` writes it to ``.claude/checkpoints/state.json``, and at session
start ``cswap state hook session-start`` puts it into the new context.
That file and the hook's text are redacted as handoff.py redacts; the bundle
is not, because it carries the transcript unchanged, so it holds whatever the
conversation held.

Everything is deterministic: the same session and working tree give the same
bytes, with no wall-clock time in the bundle or in ``state.json``.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any, Callable, TextIO

from claude_swap.checkpoint import config_dir_for, last_todos, locate_transcript, repo_root
from claude_swap.exceptions import ClaudeSwitchError
from claude_swap import paths
from claude_swap.handoff import _blocks, active_branch, clip, extract, find_transcript, project_slug, redact
from claude_swap.printer import accent, dimmed, error, warning

if TYPE_CHECKING:
    from claude_swap.session import SessionManager

FORMAT = "cswap-state"
VERSION = 1
MANIFEST = "state.json"
TRANSCRIPT = "transcript.jsonl"
SESSION_DIR = "session"
PATCH = "worktree.patch"
UNTRACKED_DIR = "untracked"
STATE_PATH = Path(".claude") / "checkpoints" / "state.json"
SETTINGS_PATH = Path(".claude") / "settings.json"
HOOK_COMMANDS = {
    "PreCompact": ("manual|auto", "cswap state hook pre-compact", 30),
    "SessionStart": ("startup|resume|clear|compact", "cswap state hook session-start", 15),
}
# Untracked files past these sizes stay behind (named in the manifest), so a
# stray build output or dataset does not turn a session into a huge bundle.
MAX_UNTRACKED_FILE = 10 * 1024 * 1024
MAX_UNTRACKED_TOTAL = 100 * 1024 * 1024
REQUEST_CHARS = 1500
ERROR_CHARS = 1500
MAX_ERRORS = 3
MAX_FILES = 20
MAX_SUBAGENTS = 5
_SUBAGENT_TOOLS = {"Task", "Agent"}


class StateError(ClaudeSwitchError):
    """A session state could not be exported, imported or loaded; the message says why."""


# --- the state read from a transcript ------------------------------------------------


def _scrub(text: str, limit: int) -> str:
    return clip(redact(text)[0], limit)


def _result_text(block: dict[str, Any]) -> str:
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(p for p in parts if isinstance(p, str))
    return ""


def _errors_and_subagents(entries: list[dict[str, Any]]) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """Tool results marked ``is_error`` (with the tool's name) and the
    subagents started, on the active branch, oldest first."""
    tool_names: dict[str, str] = {}
    errors: list[dict[str, str]] = []
    subagents: list[dict[str, str]] = []
    for e in active_branch(entries):
        for b in _blocks(e["message"]):
            kind = b.get("type")
            if kind == "tool_use":
                name = b.get("name") if isinstance(b.get("name"), str) else ""
                if isinstance(b.get("id"), str):
                    tool_names[b["id"]] = name
                inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                if name in _SUBAGENT_TOOLS:
                    subagents.append(
                        {
                            "type": str(inp.get("subagent_type") or "general-purpose"),
                            "description": _scrub(str(inp.get("description") or ""), 200),
                        }
                    )
            elif kind == "tool_result" and b.get("is_error") is True:
                text = _result_text(b).strip()
                if text:
                    errors.append(
                        {
                            "tool": tool_names.get(str(b.get("tool_use_id")), ""),
                            "text": _scrub(text, ERROR_CHARS),
                        }
                    )
    return errors, subagents


def state_vectors(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Where the work stood, read from the transcript; redacted, no clock."""
    ex = extract(entries)
    request = next((t.user for t in reversed(ex.turns) if t.user), "")
    errors, subagents = _errors_and_subagents(entries)
    return {
        "title": _scrub(ex.title, 200) if ex.title else "",
        "branch": ex.branch or "",
        "current_request": _scrub(request, REQUEST_CHARS) if request else "",
        "todos": [{"content": _scrub(t["content"], 300), "status": t["status"]} for t in last_todos(entries)],
        "touched_files": ex.files[:MAX_FILES],
        "pending_errors": errors[-MAX_ERRORS:],
        "subagents": subagents[-MAX_SUBAGENTS:],
    }


def render_context(state: dict[str, Any]) -> str:
    """The text the session-start hook gives Claude: plain facts, framed as a
    saved summary that the conversation itself overrides."""
    v = state.get("vectors") if isinstance(state.get("vectors"), dict) else {}
    lines = [
        f"cswap saved the state of Claude Code session {state.get('session_id') or 'unknown'} "
        f"({state.get('trigger') or 'export'}). It is a summary of where that work stood; "
        "where it and the conversation differ, the conversation is right.",
        "",
        "<cswap_state>",
    ]
    git = state.get("git") if isinstance(state.get("git"), dict) else {}
    branch = v.get("branch") or git.get("branch")
    if branch:
        lines.append(f"Branch: {branch}")
    if git.get("head"):
        lines.append(f"Commit: {git['head']}")
    if v.get("title"):
        lines.append(f"Session title: {v['title']}")
    if v.get("current_request"):
        lines += ["", "Last request:", v["current_request"]]
    if v.get("todos"):
        lines += ["", "Todo list:"] + [f"- [{t['status']}] {t['content']}" for t in v["todos"]]
    if v.get("touched_files"):
        lines += ["", "Files edited (newest first):"] + [f"- {f}" for f in v["touched_files"]]
    if v.get("pending_errors"):
        lines += ["", "Recent tool errors:"]
        for err in v["pending_errors"]:
            lines.append(f"- {err['tool'] or 'tool'}: {err['text']}")
    if v.get("subagents"):
        lines += ["", "Subagents started:"] + [f"- {s['type']}: {s['description']}" for s in v["subagents"]]
    lines.append("</cswap_state>")
    return "\n".join(lines) + "\n"


# --- git ----------------------------------------------------------------------------------


def _git_bytes(repo: Path, *args: str) -> bytes | None:
    try:
        r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, timeout=60, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 else None


def _git_text(repo: Path, *args: str) -> str:
    out = _git_bytes(repo, *args)
    return out.decode("utf-8", "replace").strip() if out is not None else ""


def git_head(repo: Path) -> dict[str, str]:
    branch = _git_text(repo, "rev-parse", "--abbrev-ref", "HEAD")
    return {
        "branch": "" if branch == "HEAD" else branch,
        "head": _git_text(repo, "rev-parse", "--verify", "--quiet", "HEAD"),
    }


@dataclass
class Worktree:
    patch: bytes = b""
    untracked: dict[str, bytes] = field(default_factory=dict)
    skipped: list[str] = field(default_factory=list)


def read_worktree(repo: Path, leave_out: set[Path] | None = None) -> Worktree:
    """The repository's uncommitted work: one binary patch against HEAD (staged
    and unstaged together) and the untracked files git does not ignore."""
    tree = Worktree()
    if not _git_text(repo, "rev-parse", "--is-inside-work-tree"):
        return tree
    if _git_text(repo, "rev-parse", "--verify", "--quiet", "HEAD"):
        tree.patch = _git_bytes(repo, "diff", "--binary", "HEAD") or b""
    listed = _git_bytes(repo, "ls-files", "--others", "--exclude-standard", "-z") or b""
    leave_out = {p.resolve() for p in (leave_out or set())}
    total = 0
    for raw in sorted(n for n in listed.split(b"\0") if n):
        rel = raw.decode("utf-8", "surrogateescape")
        path = repo / rel
        if path.resolve() in leave_out:
            continue
        if path.is_symlink() or not path.is_file():
            tree.skipped.append(rel)
            continue
        size = path.stat().st_size
        if size > MAX_UNTRACKED_FILE or total + size > MAX_UNTRACKED_TOTAL:
            tree.skipped.append(rel)
            continue
        tree.untracked[rel] = path.read_bytes()
        total += size
    return tree


# --- the bundle ----------------------------------------------------------------------------


def _add(tar: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = 0o644
    info.mtime = 0
    tar.addfile(info, io.BytesIO(data))


def _session_files(transcript: Path) -> dict[str, bytes]:
    """The session's own folder beside its transcript (subagent transcripts
    and the like), as posix paths relative to it."""
    folder = transcript.parent / transcript.stem
    out: dict[str, bytes] = {}
    if folder.is_dir():
        for p in sorted(folder.rglob("*")):
            if p.is_file() and not p.is_symlink():
                out[p.relative_to(folder).as_posix()] = p.read_bytes()
    return out


def build_manifest(
    session_id: str, transcript_bytes: bytes, entries: list[dict[str, Any]], git: dict[str, str],
    session_files: list[str], tree: Worktree,
) -> dict[str, Any]:
    return {
        "format": FORMAT,
        "version": VERSION,
        "session_id": session_id,
        "trigger": "export",
        "git": git,
        "transcript": {
            "sha256": hashlib.sha256(transcript_bytes).hexdigest(),
            "bytes": len(transcript_bytes),
        },
        "session_files": session_files,
        "worktree": {
            "patch": bool(tree.patch),
            "untracked": sorted(tree.untracked),
            "skipped": tree.skipped,
        },
        "vectors": state_vectors(entries),
    }


def write_bundle(
    out: Path, manifest: dict[str, Any], transcript_bytes: bytes, session_files: dict[str, bytes], tree: Worktree
) -> None:
    """One plain .tar, members in a fixed order with no times or owners."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tar:
        _add(tar, MANIFEST, (json.dumps(manifest, indent=2) + "\n").encode("utf-8"))
        _add(tar, TRANSCRIPT, transcript_bytes)
        for rel in sorted(session_files):
            _add(tar, f"{SESSION_DIR}/{rel}", session_files[rel])
        if tree.patch:
            _add(tar, PATCH, tree.patch)
        for rel in sorted(tree.untracked):
            _add(tar, f"{UNTRACKED_DIR}/{rel}", tree.untracked[rel])
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".partial")
    tmp.write_bytes(buf.getvalue())
    os.replace(tmp, out)


def _safe_member(name: str) -> PurePosixPath:
    p = PurePosixPath(name)
    if not name or p.is_absolute() or ".." in p.parts or "\\" in name or ":" in p.parts[0]:
        raise StateError(f"The bundle holds a file with an unsafe name: {name!r}.")
    return p


@dataclass
class Bundle:
    manifest: dict[str, Any]
    transcript: bytes
    session_files: dict[str, bytes]
    tree: Worktree


def read_bundle(path: Path) -> Bundle:
    """Read and check a bundle: its format, safe member names, and the
    transcript's digest against the manifest."""
    files: dict[str, bytes] = {}
    try:
        with tarfile.open(path, mode="r:*") as tar:
            for m in tar.getmembers():
                if m.isdir():
                    continue
                if not m.isfile():
                    raise StateError(f"The bundle holds {m.name!r}, which is not a plain file.")
                name = _safe_member(m.name).as_posix()
                fh = tar.extractfile(m)
                files[name] = fh.read() if fh else b""
    except (OSError, tarfile.TarError) as e:
        raise StateError(f"Could not read {path}: {e}") from e
    try:
        manifest = json.loads(files.pop(MANIFEST).decode("utf-8"))
    except (KeyError, ValueError) as e:
        raise StateError(f"{path} is not a cswap state export (no readable {MANIFEST}).") from e
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise StateError(f"{path} is not a cswap state export.")
    if manifest.get("version") != VERSION:
        raise StateError(f"{path} is a version {manifest.get('version')} export; this cswap reads version {VERSION}.")
    sid = manifest.get("session_id")
    if not isinstance(sid, str) or not sid or "/" in sid or "\\" in sid or sid in (".", ".."):
        raise StateError(f"{path} names no usable session id.")
    transcript = files.pop(TRANSCRIPT, None)
    if transcript is None:
        raise StateError(f"{path} holds no transcript.")
    if hashlib.sha256(transcript).hexdigest() != manifest.get("transcript", {}).get("sha256"):
        raise StateError(f"The transcript in {path} does not match its manifest; the file was changed or cut short.")
    session_files: dict[str, bytes] = {}
    tree = Worktree(patch=files.pop(PATCH, b""))
    for name, data in files.items():
        if name.startswith(SESSION_DIR + "/"):
            session_files[name[len(SESSION_DIR) + 1 :]] = data
        elif name.startswith(UNTRACKED_DIR + "/"):
            tree.untracked[name[len(UNTRACKED_DIR) + 1 :]] = data
    tree.skipped = list(manifest.get("worktree", {}).get("skipped", []))
    return Bundle(manifest, transcript, session_files, tree)


# --- placing a bundle ----------------------------------------------------------------------


def _same_or_absent(path: Path, data: bytes) -> bool:
    """True when nothing is at ``path`` or it already holds ``data``."""
    try:
        return path.read_bytes() == data
    except FileNotFoundError:
        return True
    except OSError:
        return False


def _write(path: Path, data: bytes) -> bool:
    """Write unless it already holds ``data``; True when it changed."""
    try:
        if path.read_bytes() == data:
            return False
    except OSError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".cswap-partial")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return True


def place_transcript(bundle: Bundle, config_dir: Path, cwd: Path, force: bool = False) -> Path:
    """The transcript and the session's folder under the account's
    ``projects/`` for ``cwd``, where ``claude --resume`` finds them."""
    sid = bundle.manifest["session_id"]
    project = Path(config_dir) / "projects" / project_slug(cwd)
    target = project / f"{sid}.jsonl"
    folder = project / sid
    if not force:
        clashes = [target] if not _same_or_absent(target, bundle.transcript) else []
        clashes += [
            folder / rel for rel, data in bundle.session_files.items() if not _same_or_absent(folder / rel, data)
        ]
        if clashes:
            raise StateError(
                f"Session {sid} is already there with other contents ({clashes[0]}). "
                "Pass --force to replace it with the export."
            )
    for rel, data in bundle.session_files.items():
        _write(folder / _safe_member(rel), data)
    _write(target, bundle.transcript)
    return target


def apply_worktree(bundle: Bundle, repo: Path, force: bool = False) -> list[str]:
    """Apply the export's uncommitted work to ``repo``; returns what was done.

    Checked whole before anything is written: the patch with ``git apply
    --check``, and every untracked file against what is on disk, so a refusal
    leaves the repository as it was.
    """
    done: list[str] = []
    want = bundle.manifest.get("git", {}).get("head") or ""
    have = _git_text(repo, "rev-parse", "--verify", "--quiet", "HEAD")
    if want and have != want and not force:
        raise StateError(
            f"The export was taken at commit {want[:12]}, but {repo} is at {have[:12] or 'no commit'}. "
            f"Check out {want[:12]} first (git checkout {want}), or pass --force to try the patch anyway."
        )
    clashes = [rel for rel, data in bundle.tree.untracked.items() if not _same_or_absent(repo / rel, data)]
    if clashes:
        raise StateError(f"{clashes[0]} already exists in {repo} with other contents; nothing was changed.")
    if bundle.tree.patch:
        for check in (["--check"], []):
            try:
                r = subprocess.run(
                    ["git", "-C", str(repo), "apply", "--binary", *check, "-"],
                    input=bundle.tree.patch, capture_output=True, timeout=60, check=False,
                )
            except (OSError, subprocess.SubprocessError) as e:
                raise StateError(f"Could not run git apply: {e}") from e
            if r.returncode != 0:
                why = r.stderr.decode("utf-8", "replace").strip()
                raise StateError(f"The uncommitted changes do not apply to {repo}: {why}")
        done.append("applied the uncommitted changes")
    written = sum(_write(repo / _safe_member(rel), data) for rel, data in bundle.tree.untracked.items())
    if written:
        done.append(f"wrote {written} untracked file(s)")
    return done


def write_state(repo: Path, state: dict[str, Any]) -> Path:
    path = repo / STATE_PATH
    _write(path, (json.dumps(state, indent=2) + "\n").encode("utf-8"))
    return path


def _state_of(manifest: dict[str, Any]) -> dict[str, Any]:
    keep = ("format", "version", "session_id", "trigger", "git", "vectors")
    return {k: manifest[k] for k in keep if k in manifest}


# --- the hooks ----------------------------------------------------------------------------------


def _our_entry(event: str) -> dict[str, Any]:
    matcher, command, timeout = HOOK_COMMANDS[event]
    return {"matcher": matcher, "hooks": [{"type": "command", "command": command, "timeout": timeout}]}


def _is_ours(entry: Any, event: str) -> bool:
    command = HOOK_COMMANDS[event][1]
    hooks = entry.get("hooks") if isinstance(entry, dict) else None
    return isinstance(hooks, list) and any(isinstance(h, dict) and h.get("command") == command for h in hooks)


def _read_settings(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise StateError(f"Could not read {path}: {e}") from e
    if not isinstance(data, dict):
        raise StateError(f"{path} does not hold a JSON object.")
    return data


def set_hooks(repo: Path, install: bool) -> tuple[Path, bool]:
    """Add or remove cswap's two hooks in the project's .claude/settings.json,
    leaving every other key and hook as it was."""
    path = repo / SETTINGS_PATH
    data = _read_settings(path)
    hooks = data.get("hooks")
    if hooks is None:
        hooks = {}
    if not isinstance(hooks, dict):
        raise StateError(f"The hooks in {path} are not a JSON object.")
    for event in HOOK_COMMANDS:
        entries = hooks.get(event, [])
        if not isinstance(entries, list):
            raise StateError(f"The {event} hooks in {path} are not a list.")
        kept = [e for e in entries if not _is_ours(e, event)]
        if install:
            kept.append(_our_entry(event))
        if kept:
            hooks[event] = kept
        else:
            hooks.pop(event, None)
    if hooks:
        data["hooks"] = hooks
    else:
        data.pop("hooks", None)
    changed = _write(path, (json.dumps(data, indent=2) + "\n").encode("utf-8"))
    return path, changed


def _hook_input(stdin: TextIO) -> dict[str, Any]:
    try:
        data = json.load(stdin)
    except (ValueError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def hook_pre_compact(stdin: TextIO, stderr: TextIO) -> int:
    """Save the state before Claude Code compacts. Never blocks compaction."""
    data = _hook_input(stdin)
    cwd = Path(data.get("cwd") or os.getcwd())
    transcript = data.get("transcript_path")
    if not transcript or not Path(transcript).is_file():
        stderr.write("cswap: no transcript to save the state from.\n")
        return 0
    from claude_swap.handoff import load_transcript

    repo = repo_root(cwd)
    state = {
        "format": FORMAT,
        "version": VERSION,
        "session_id": str(data.get("session_id") or Path(transcript).stem),
        "trigger": f"before a {data.get('trigger') or 'auto'} compaction",
        "git": git_head(repo),
        "vectors": state_vectors(load_transcript(Path(transcript))),
    }
    try:
        path = write_state(repo, state)
    except OSError as e:
        stderr.write(f"cswap: could not save the state: {e}\n")
        return 0
    stderr.write(f"cswap: saved the session state to {path}\n")
    return 0


def hook_session_start(stdin: TextIO, stdout: TextIO) -> int:
    """Give a starting session the saved state, when there is one."""
    data = _hook_input(stdin)
    path = repo_root(Path(data.get("cwd") or os.getcwd())) / STATE_PATH
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0
    if not isinstance(state, dict) or state.get("format") != FORMAT:
        return 0
    out = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": render_context(state)}}
    stdout.write(json.dumps(out) + "\n")
    return 0


# --- orchestration ------------------------------------------------------------------------------


@dataclass
class ExportResult:
    path: Path
    session_id: str
    manifest: dict[str, Any]


def export_state(
    manager: SessionManager | None, account: str | None, session_id: str | None, cwd: Path,
    out: Path | None, worktree: bool = True,
) -> ExportResult:
    transcript = locate_transcript(config_dir_for(manager, account), cwd, session_id)
    if transcript is None:
        named = f" named {session_id!r}" if session_id else ""
        raise StateError(f"No local transcript{named} was found for {cwd}.")
    from claude_swap.handoff import load_transcript

    data = transcript.read_bytes()
    sid = transcript.stem
    out = Path(out) if out else cwd / f"cswap-state-{sid}.tar"
    repo = repo_root(cwd)
    tree = read_worktree(repo, leave_out={out}) if worktree else Worktree()
    files = _session_files(transcript)
    manifest = build_manifest(sid, data, load_transcript(transcript), git_head(repo), sorted(files), tree)
    write_bundle(out, manifest, data, files, tree)
    return ExportResult(out, sid, manifest)


@dataclass
class ImportResult:
    transcript: Path
    state: Path
    session_id: str
    done: list[str]


def import_state(
    manager: SessionManager | None, account: str | None, bundle_path: Path, cwd: Path,
    apply_changes: bool = False, force: bool = False,
) -> ImportResult:
    bundle = read_bundle(bundle_path)
    repo = repo_root(cwd)
    done: list[str] = []
    # The work first: a refusal there leaves the account untouched too.
    if apply_changes:
        done += apply_worktree(bundle, repo, force)
    target = place_transcript(bundle, config_dir_for(manager, account), cwd, force)
    state = write_state(repo, _state_of(bundle.manifest))
    return ImportResult(target, state, bundle.manifest["session_id"], done)


def resume(manager: SessionManager | None, account: str | None, session_id: str, cwd: Path, claude_args: list[str]) -> int:
    if account:
        if manager is None:
            raise StateError(f"Account {account!r} was named, but no account registry is available here.")
        claude_bin, env = manager.launch_env(account)
    else:
        found = shutil.which("claude")
        if not found:
            raise StateError("'claude' was not found on PATH. Install Claude Code first.")
        claude_bin, env = found, dict(os.environ)
    try:
        return subprocess.run([claude_bin, "--resume", session_id, *claude_args], env=env, cwd=cwd).returncode
    except KeyboardInterrupt:
        return 130


# --- move: teleport, place, resume -------------------------------------------------------------


@dataclass
class MovePlan:
    source: str
    target: str
    session_id: str | None = None
    skip_teleport: bool = False
    force: bool = False
    # Forwarded to both claude invocations (teleport and resume).
    claude_args: list[str] = field(default_factory=list)


def _config_dir_of(env: dict[str, str]) -> Path:
    """The profile a claude started with ``env`` keeps its transcripts in."""
    configured = env.get("CLAUDE_CONFIG_DIR")
    return Path(configured) if configured else paths.get_claude_config_home()


def _git_is_clean(repo: Path) -> bool:
    try:
        r = subprocess.run(["git", "-C", str(repo), "status", "--porcelain"], capture_output=True, text=True, check=False)
    except OSError:
        return False
    return r.returncode == 0 and not r.stdout.strip()


class Mover:
    """Carries one thread, exactly, from one account to another on this computer."""

    def __init__(self, manager: SessionManager, cwd: Path | None = None, say: Callable[[str], None] = print):
        self.manager = manager
        self.cwd = Path(cwd or os.getcwd())
        self.say = say

    def _account(self, identifier: str, role: str) -> tuple[str, str]:
        switcher = self.manager.switcher
        num, email, _ = switcher.resolve_account(identifier)
        if role == "source" and switcher._account_kind(num) == "api_key":
            raise StateError(
                f"Account-{num} ({email}) is an API-key account; claude --teleport needs "
                "a claude.ai login, since cloud threads belong to claude.ai."
            )
        return num, email

    def _launch(self, identifier: str, args: list[str]) -> tuple[int, dict[str, str]]:
        claude_bin, env = self.manager.launch_env(identifier)
        try:
            rc = subprocess.run([claude_bin, *args], env=env, cwd=self.cwd).returncode
        except KeyboardInterrupt:
            rc = 130
        return rc, env

    def _locate(self, config_dir: Path, plan: MovePlan, since: float | None) -> Path | None:
        repo = repo_root(self.cwd)
        for where in dict.fromkeys([self.cwd.resolve(), repo.resolve(), self.cwd, repo]):
            found = find_transcript(config_dir, where, plan.session_id, since)
            if found is not None:
                return found
        return None

    def run(self, plan: MovePlan) -> int:
        src = self._account(plan.source, "source")
        dst = self._account(plan.target, "target")
        if src[0] == dst[0]:
            raise StateError("--from and --to name the same account; there is nothing to move.")
        repo = repo_root(self.cwd)
        started = time.time()
        if plan.skip_teleport:
            self.say(dimmed("Skipping claude --teleport (--skip-teleport): using the transcript already here."))
            _, source_env = self.manager.launch_env(plan.source)
            since = None
        else:
            if not _git_is_clean(repo):
                raise StateError(
                    "The working tree has uncommitted changes; claude --teleport needs a clean "
                    "tree. Commit or stash them first."
                )
            self.say(
                f"{accent('Step 1/3')} Pulling the thread down as Account-{src[0]} ({src[1]}). "
                "Exit claude when it has loaded to continue."
            )
            args = [*plan.claude_args, "--teleport", *([plan.session_id] if plan.session_id else [])]
            rc, source_env = self._launch(plan.source, args)
            if rc != 0:
                raise StateError(f"claude --teleport exited with code {rc}; nothing was moved.")
            since = started - 2  # slack for mtimes that lag the wall clock
        transcript = self._locate(_config_dir_of(source_env), plan, since)
        if transcript is None:
            raise StateError(
                f"No transcript for the thread was found in Account-{src[0]}'s profile for {self.cwd}. "
                "Run this from the clone claude --teleport used."
            )
        data = transcript.read_bytes()
        sid = transcript.stem
        bundle = Bundle(
            manifest={"session_id": sid},
            transcript=data,
            session_files=_session_files(transcript),
            tree=Worktree(),
        )
        self.say(f"{accent('Step 2/3')} Placing session {sid} ({len(data)} bytes) in Account-{dst[0]}'s profile.")
        _, target_env = self.manager.launch_env(plan.target)
        target_dir = _config_dir_of(target_env)
        for where in dict.fromkeys([self.cwd.resolve(), self.cwd]):
            place_transcript(bundle, target_dir, where, plan.force)
        self.say(f"{accent('Step 3/3')} Resuming it as Account-{dst[0]} ({dst[1]}).")
        rc, _ = self._launch(plan.target, [*plan.claude_args, "--resume", sid])
        if rc not in (0, 130):
            raise StateError(
                f"claude --resume exited with code {rc}. The session is in place; "
                f"`cswap run {plan.target} -- --resume {sid}` tries again."
            )
        return rc


# --- CLI ------------------------------------------------------------------------------------------


def _default_manager(debug: bool) -> SessionManager:
    from claude_swap.session import SessionManager
    from claude_swap.switcher import ClaudeAccountSwitcher

    return SessionManager(ClaudeAccountSwitcher(debug=debug))


def _parser(prog: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=prog,
        description=(
            "Carry one Claude Code session, exactly, to another account or folder: "
            "the transcript claude --resume reads, its subagents, the uncommitted "
            "work and the state of the task, in one .tar."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  cswap state export                          # the newest session for this folder
  cswap state export --account 1 -o move.tar
  cswap state import move.tar --account 2 --resume
  cswap state import move.tar --apply-changes # also the uncommitted work
  cswap state move --from 1 --to 2 session_01AbC...   # a cloud thread, continued exactly as 2
  cswap state show move.tar
  cswap state hooks install                   # keep the state across compactions
        """,
    )
    sub = parser.add_subparsers(dest="command", metavar="export|import|move|show|hooks")

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--account", metavar="NUM|EMAIL", help="Account whose profile to use (default: the current profile)")
        p.add_argument("--cwd", metavar="DIR", help="Project directory (default: the current one)")
        p.add_argument("--debug", action="store_true", help="Enable debug logging")

    e = sub.add_parser("export", help="Pack a session into one .tar")
    common(e)
    e.add_argument("--session", dest="session_id", metavar="ID", help="Session id (default: the newest for the folder)")
    e.add_argument("-o", "--output", metavar="FILE", help="Where to write it (default: cswap-state-<session>.tar here)")
    e.add_argument("--no-worktree", action="store_true", help="Leave the uncommitted work out")

    i = sub.add_parser("import", help="Place an exported session where claude --resume finds it")
    common(i)
    i.add_argument("bundle", metavar="FILE", help="The .tar `cswap state export` wrote")
    i.add_argument("--apply-changes", action="store_true", help="Also apply the export's uncommitted work to the repository")
    i.add_argument("--force", action="store_true", help="Replace a session of the same id, or apply at another commit")
    i.add_argument("--resume", action="store_true", help="Then start claude --resume on it (args after -- go to claude)")

    s = sub.add_parser("show", help="Print an export's manifest")
    s.add_argument("bundle", metavar="FILE")

    h = sub.add_parser("hooks", help="Add or remove the compaction hooks in .claude/settings.json")
    h.add_argument("action", choices=("install", "remove"))
    h.add_argument("--cwd", metavar="DIR", help="Project directory (default: the current one)")

    m = sub.add_parser("move", help="Continue a cloud thread exactly as another account, on this computer")
    m.add_argument("session_id", nargs="?", metavar="SESSION", help="The thread's session id (default: claude --teleport's picker)")
    m.add_argument("--from", dest="source", required=True, metavar="NUM|EMAIL", help="Account that has the thread")
    m.add_argument("--to", dest="target", required=True, metavar="NUM|EMAIL", help="Account to continue it as")
    m.add_argument("--cwd", metavar="DIR", help="The clone to work in (default: the current folder)")
    m.add_argument("--skip-teleport", action="store_true", help="The thread is already pulled down as --from; just move and resume")
    m.add_argument("--force", action="store_true", help="Replace a session of the same id in --to's profile")
    m.add_argument("--debug", action="store_true", help="Enable debug logging")

    hook = sub.add_parser("hook")  # what the installed hooks run
    hook.add_argument("event", choices=("pre-compact", "session-start"))
    return parser


def main(
    argv: list[str],
    *,
    prog: str = "cswap state",
    manager_factory: Callable[[bool], SessionManager] | None = None,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    """``cswap state ...``; returns the exit code."""
    stdin, stdout, stderr = stdin or sys.stdin, stdout or sys.stdout, stderr or sys.stderr
    argv = list(argv)
    claude_args: list[str] = []
    if "--" in argv:
        split = argv.index("--")
        argv, claude_args = argv[:split], argv[split + 1 :]
    parser = _parser(prog)
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 2
    if claude_args and not (getattr(args, "resume", False) or args.command == "move"):
        parser.error("arguments after -- go to claude, which only `import --resume` and `move` run")
    if args.command == "hook":
        if args.event == "pre-compact":
            return hook_pre_compact(stdin, stderr)
        return hook_session_start(stdin, stdout)
    cwd = Path(getattr(args, "cwd", None) or os.getcwd())
    try:
        if args.command == "show":
            stdout.write(json.dumps(read_bundle(Path(args.bundle)).manifest, indent=2) + "\n")
            return 0
        if not cwd.is_dir():
            raise StateError(f"{cwd} is not a directory.")
        if args.command == "hooks":
            path, changed = set_hooks(repo_root(cwd), args.action == "install")
            verb = "Added the cswap state hooks to" if args.action == "install" else "Removed the cswap state hooks from"
            print(f"{accent(verb)} {path}" if changed else dimmed(f"{path} is unchanged."))
            return 0
        if args.command == "move":
            mover = Mover((manager_factory or _default_manager)(bool(args.debug)), cwd)
            plan = MovePlan(args.source, args.target, args.session_id, args.skip_teleport, args.force, claude_args)
            return mover.run(plan)
        manager = None
        if args.account:
            manager = (manager_factory or _default_manager)(bool(args.debug))
        if args.command == "export":
            out = Path(args.output) if args.output else None
            res = export_state(manager, args.account, args.session_id, cwd, out, worktree=not args.no_worktree)
            wt = res.manifest["worktree"]
            print(f"{accent('Exported')} session {res.session_id} to {res.path}")
            print(dimmed(
                f"  transcript {res.manifest['transcript']['bytes']} bytes, "
                f"{len(res.manifest['session_files'])} session file(s), "
                f"{'a patch' if wt['patch'] else 'no patch'}, {len(wt['untracked'])} untracked file(s)"
            ))
            for rel in wt["skipped"]:
                warning(f"Left out {rel} (a link, or too large).")
            print(dimmed("  It carries the conversation unchanged; keep it as private as the conversation."))
            return 0
        res = import_state(manager, args.account, Path(args.bundle), cwd, args.apply_changes, args.force)
        print(f"{accent('Imported')} session {res.session_id} to {res.transcript}")
        for line in res.done:
            print(dimmed(f"  {line}"))
        print(dimmed(f"  state written to {res.state}"))
        if args.resume:
            return resume(manager, args.account, res.session_id, cwd, claude_args)
        run = f"cswap run {args.account} -- --resume {res.session_id}" if args.account else f"claude --resume {res.session_id}"
        print(f"Continue it with: {run}")
        return 0
    except ClaudeSwitchError as e:
        error(f"Error: {e}")
        return 1
