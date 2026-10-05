"""Move a claude.ai Project between accounts (`cswap project-move`).

A Project is carried across in one of two ways. Both run in three stages,
``export``, ``check`` and ``import``, and both leave the two actions inside
claude.ai to the person: nothing here signs in to claude.ai or talks to it.

**By browser script, with a folder as the carrier (the default).** A claude.ai
tab that is signed in can read a Project through the site's own API, and can
create one. The two scripts shipped in ``browser/`` do that when pasted into
the tab's DevTools console:

1. ``export``: in a tab signed in as the SOURCE account, ``project-export.js``
   saves the project into a folder on this computer: its description,
   instructions and settings, its files byte for byte, and its conversations
   as text. It only reads. A browser that opens no folder window saves the
   same export as one .tar file among the downloads instead.
2. ``check``: this machine reads the ``export.json`` the export ends with and
   confirms that every file it lists is on disk (or in the .tar).
3. ``import``: in a tab signed in as the DESTINATION account,
   ``project-import.js`` creates a NEW private project from that folder or
   .tar. It never changes or deletes anything that exists.

**By thread prompt, with a git branch as the carrier (when a repository is
named).** A Project's own Claude can read things no outside caller can, its
memory above all, so the older way is kept: two prompts, one pasted in each
Project's chat, with a branch of the project's repository in between.

1. ``export``: in the SOURCE project's chat (logged in as the source account)
   a thread writes the chat, threads, memory and shared files into
   ``.claude/project-export/`` on a new branch and pushes it.
2. ``check``: this machine polls GitHub until that branch (and its README)
   exists, and warns when the repository is public.
3. ``import``: in a NEW project under the DESTINATION account, pointed at the
   same repository, a thread restores memory and files from the branch.

What this module automates is everything around those pastes: it hands out
the exact script or prompt, puts it on the clipboard, writes it to a file as
a fallback, remembers the folder or repository between stages, checks the
exported folder or GitHub, and prints the remaining manual steps in order.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
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
CLAUDE_URL = "https://claude.ai"
CLAUDE_CODE_URL = "https://claude.ai/code"
STATE_FILE = "project-move.json"
PROMPT_DIR = "project-move"

# The two carriers. ``folder``: the browser scripts, with the export in a
# folder on this computer. ``branch``: the thread prompts, with the export on
# a branch of the project's repository.
CARRIER_FOLDER = "folder"
CARRIER_BRANCH = "branch"

# Where the browser scripts live inside the package, and where exports go
# unless ``--folder`` says otherwise. The folder is a plain one under the
# home directory on purpose: the browser's folder picker refuses the home
# directory itself and system folders, and an export does not belong among
# cswap's stored credentials, where ``cswap purge`` would take it along.
SCRIPT_DIR = "browser"
DEFAULT_EXPORTS_DIRNAME = "claude-project-exports"

# What project-export.js writes at the end of an export and project-import.js
# reads first. The three values are spelled out in both scripts too; the
# tests hold all three places to the same words.
MANIFEST_NAME = "export.json"
MANIFEST_FORMAT = "claude-project-export"
MANIFEST_VERSION = 1

# What the export script saves instead when the browser opens no folder
# window: the same export, folder and all, in one .tar file that lands among
# the downloads. ``check`` reads it in place, and the import script takes it
# as a file.
ARCHIVE_SUFFIX = ".tar"

_REPO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+$")
# What the step list prints before a repository is known. It is shaped like a
# real one, so pasting the step list back into a shell would otherwise run
# `export OWNER/NAME` for real and remember the placeholder as the repository.
PLACEHOLDER_REPO = "OWNER/NAME"
# People read the argument as the project's name (the Project and its
# repository are usually named alike), so every place that asks for it says
# which one it is.
REPO_HINT = "the GitHub repository the project is attached to, as owner/name (not the project's name)"
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
            f"{PLACEHOLDER_REPO} is the placeholder from the step list; put {REPO_HINT} there"
        )
    if not _REPO_RE.match(value):
        if _looks_like_a_folder(spec):
            hint = "To name the folder an export is saved in, use --folder DIR."
        else:
            # A project's name is the likely mistake, and the browser scripts
            # are the move that needs no name at all.
            hint = (
                "To move a project with the browser scripts, give no name: "
                "the project is chosen in the browser."
            )
        raise ValidationError(
            f"Not a GitHub repository: {spec!r}. Give {REPO_HINT}, or its github.com URL. {hint}"
        )
    return value


def _looks_like_a_folder(spec: str) -> bool:
    """Whether what was given as a repository reads as a path on this computer."""
    value = spec.strip()
    if not value or value.startswith(_GITHUB_PREFIXES):
        return False
    if value.startswith(("~", ".", "/", "\\")) or re.match(r"^[A-Za-z]:", value) or "\\" in value:
        return True
    try:
        return os.path.isdir(os.path.expanduser(value))
    except (OSError, ValueError):
        return False


_STATE_KEYS = (
    "carrier",
    "repo",
    "branch",
    "folder",
    "exported_at",
    "imported_at",
    "branch_seen_at",
    "export_seen_at",
    "export_path",
)


@dataclass
class MoveState:
    """What the stages remember between invocations (``project-move.json``)."""

    repo: str = ""
    branch: str = DEFAULT_BRANCH
    exported_at: str = ""  # when the move began: the first `export` of it
    imported_at: str = ""  # when the import script or prompt was handed out
    branch_seen_at: str = ""  # when `check` last found the export branch
    carrier: str = ""  # CARRIER_FOLDER or CARRIER_BRANCH; "" in older files
    folder: str = ""  # folder carrier: the folder exports are saved in
    export_seen_at: str = ""  # folder carrier: when `check` last found an export
    export_path: str = ""  # ... and the folder to choose when importing
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
        known = {k: raw[k] for k in _STATE_KEYS if isinstance(raw.get(k), str)}
        state = cls(**known)
        if state.repo == PLACEHOLDER_REPO:
            # Written by a version that accepted the placeholder: nothing in
            # that state is real, so start over rather than show it as done.
            return cls()
        if not state.branch:
            state.branch = DEFAULT_BRANCH
        if state.carrier not in (CARRIER_FOLDER, CARRIER_BRANCH):
            state.carrier = ""
        return state

    def save(self, root: Path) -> Path:
        root.mkdir(parents=True, exist_ok=True)
        path = root / STATE_FILE
        payload = {key: getattr(self, key) for key in _STATE_KEYS}
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
        f"No repository given and none remembered yet. Pass {REPO_HINT}: "
        "for example, cswap project-move export owner/name"
    )


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


def _epoch(local_iso: str) -> float:
    """Seconds since the epoch for a :func:`_now_iso` string; 0.0 if it is not one."""
    try:
        return time.mktime(time.strptime(local_iso, "%Y-%m-%dT%H:%M:%S"))
    except (ValueError, OverflowError):
        return 0.0


# ---------------------------------------------------------------------------
# Which carrier a stage uses
# ---------------------------------------------------------------------------


def effective_carrier(state: MoveState) -> str:
    """The carrier of the move in ``state``.

    A state file written before there were two carriers names none; it can
    only be a branch move if it remembers a repository.
    """
    if state.carrier:
        return state.carrier
    return CARRIER_BRANCH if state.repo else CARRIER_FOLDER


def resolve_carrier(
    state: MoveState,
    stage: str,
    repo: str | None = None,
    folder: str | None = None,
    *,
    branch_options: bool = False,
) -> str:
    """The carrier for this invocation.

    Naming a repository means the prompts and a branch, and so does an option
    that only they have (``branch_options``: ``--branch`` or ``--token``);
    ``--folder`` means the browser scripts. With none of these, ``export``
    begins a move the default way (the scripts), and every other stage
    carries on with the move in hand.
    """
    by_prompt = bool(repo) or branch_options
    if by_prompt and folder:
        raise ValidationError(
            "--folder goes with the browser scripts; a repository, --branch and "
            "--token go with the thread prompts. Use one or the other."
        )
    if by_prompt:
        return CARRIER_BRANCH
    if folder or stage == "export":
        return CARRIER_FOLDER
    return effective_carrier(state)


def begin_move(state: MoveState, carrier: str, *, changed: bool = False) -> None:
    """Called by ``export``: note the carrier, and start a new move if due.

    Running ``export`` again in the middle of a move only hands the script or
    prompt out again. A new move, with everything after ``export`` still to
    do, starts when the last one reached ``import``, used the other carrier,
    or (``changed``) was for another repository.
    """
    restart = (
        changed
        or bool(state.imported_at)
        or not state.exported_at
        or effective_carrier(state) != carrier
    )
    state.carrier = carrier
    if restart:
        state.exported_at = _now_iso()
        state.imported_at = ""
        state.branch_seen_at = ""
        state.export_seen_at = ""
        state.export_path = ""


# ---------------------------------------------------------------------------
# Prompts (branch carrier)
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
# Browser scripts (folder carrier)
# ---------------------------------------------------------------------------


def script_text(stage: str) -> str:
    """The export or import script exactly as it is to be pasted.

    The scripts are plain ASCII (they spell every other character as a
    ``\\uXXXX`` escape), so they survive any clipboard tool and any console
    code page. Line endings are made ``\\n`` here, so a checkout with Windows
    line endings hands out the same text as an installed wheel.
    """
    if stage not in ("export", "import"):
        raise ValueError(f"unknown stage: {stage}")
    source = resources.files("claude_swap") / SCRIPT_DIR / f"project-{stage}.js"
    return source.read_text(encoding="utf-8").replace("\r\n", "\n")


def write_script_file(root: Path, stage: str, text: str) -> Path:
    """Save the script next to the state file (the clipboard fallback)."""
    directory = root / PROMPT_DIR
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{stage}-script.js"
    # Bytes, so that the copy on disk is the text of the clipboard exactly.
    path.write_bytes(text.encode("utf-8"))
    return path


def default_exports_folder() -> Path:
    """Where exports are saved unless ``--folder`` says otherwise."""
    return Path.home() / DEFAULT_EXPORTS_DIRNAME


def resolve_folder(state: MoveState, spec: str | None) -> Path:
    """The exports folder for this stage: the argument, the remembered one, the default."""
    if spec and spec.strip():
        return Path(os.path.abspath(os.path.expanduser(spec.strip())))
    if state.folder:
        return Path(state.folder)
    return default_exports_folder()


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
    since the prompt or script is also written to a file.
    """
    for cmd in _clipboard_commands(platform):
        if shutil.which(cmd[0]) is None:
            continue
        try:
            # clip.exe reads the console code page; the prompts and scripts
            # are ASCII so UTF-8 bytes are safe everywhere. The tool's own
            # output is discarded rather than piped back: wl-copy and xclip
            # leave a process behind to serve the clipboard, and a pipe it
            # still held would keep this call waiting for the whole timeout.
            proc = subprocess.run(
                cmd,
                input=text.encode("utf-8"),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
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
# Checking an exported folder (folder carrier)
# ---------------------------------------------------------------------------

# Files an export writes long before its export.json. A folder that has one
# of these and no export.json is an export that did not finish, or one made
# by a script from before there was an export.json.
_UNFINISHED_MARKERS = ("Project Instructions.md", "Channel Info.md", "Timeline.md")

# How much earlier than the move a file's time may be and still count as
# part of it. Some file systems keep times only to the nearest two seconds,
# and the move's own start is kept to the second.
_CLOCK_SLACK = 2.0


@dataclass
class ExportCheck:
    """One exported project, read from its ``export.json`` and checked on disk.

    ``path`` is the export's folder, or the .tar it was saved as instead; the
    latter is also ``archive``, for the places that treat the two apart.
    """

    path: Path
    archive: Path | None = None  # the .tar, when the export is one
    name: str = ""
    kind: str = ""  # "code" (a Claude Code project) or "standard"
    finished_at: float = 0.0  # when export.json was written (its mtime), or the .tar's
    files: int = 0
    conversations: int = 0  # saved chats, threads and transcripts; the memory too
    bytes: int = 0
    missing: list[str] = field(default_factory=list)  # listed, not on disk
    wrong_size: list[str] = field(default_factory=list)  # on disk in another size
    problems: list[str] = field(default_factory=list)  # what the export could not get
    error: str = ""  # why export.json could not be used at all
    # Not an export at all, whatever else it is (a .tar of something else,
    # or no tar), as opposed to an export that went wrong.
    unrelated: bool = False

    @property
    def complete(self) -> bool:
        return not self.error and not self.missing and not self.wrong_size


@dataclass
class FolderCheck:
    """What ``check`` found in the exports folder."""

    folder: Path
    exists: bool = False
    direct: bool = False  # the folder is itself one export, named on purpose
    exports: list[ExportCheck] = field(default_factory=list)  # newest first
    unfinished: list[str] = field(default_factory=list)  # folders with no export.json
    since: float = 0.0  # when this move began; an older export is not its export
    error: str = ""

    @property
    def own(self) -> list[ExportCheck]:
        """The complete exports that belong to this move, newest first."""
        return [
            export
            for export in self.exports
            if export.complete and (self.direct or export.finished_at >= self.since - _CLOCK_SLACK)
        ]

    @property
    def ready(self) -> ExportCheck | None:
        """An export this move can import: the newest complete one that is its own."""
        own = self.own
        return own[0] if own else None

    @property
    def export_ready(self) -> bool:
        return self.ready is not None


def _file_size(path: Path) -> int | None:
    """Size of the regular file at ``path``; None when there is no such file."""
    candidates = [str(path)]
    if sys.platform == "win32":
        # An export nests folders, and Windows stops plain paths at 260
        # characters. The same path with this prefix has no such limit.
        full = os.path.abspath(str(path))
        if full.startswith("\\\\?\\"):
            pass
        elif full.startswith("\\\\"):
            candidates.append("\\\\?\\UNC\\" + full[2:])
        else:
            candidates.append("\\\\?\\" + full)
    for candidate in candidates:
        try:
            info = os.stat(candidate)
        except (OSError, ValueError):
            continue
        return info.st_size if stat.S_ISREG(info.st_mode) else None
    return None


def _plain_parts(relative: str) -> list[str] | None:
    """The parts of a path from ``export.json``; None if it could leave the export.

    The scripts only ever write plain names joined with ``/``. Anything else
    (an absolute path, ``..``, a backslash, a drive letter) is not followed.
    """
    parts = relative.split("/")
    for part in parts:
        if part in ("", ".", "..") or "\\" in part or ":" in part or "\0" in part:
            return None
    return parts


def _inside(root: Path, relative: str) -> Path | None:
    """``root`` joined with a path from ``export.json``; None if it could leave ``root``."""
    parts = _plain_parts(relative)
    return None if parts is None else root.joinpath(*parts)


def _check_row(result: ExportCheck, relative: object, expected: object, size_of, where: str) -> None:
    """Look for one file ``export.json`` lists, and add what is found to ``result``.

    ``size_of`` finds the file by the path listed: its size, or None when
    there is no such file. ``where`` says where that is, for the message.
    """
    if not isinstance(relative, str):
        return
    size = size_of(relative)
    if size is None:
        result.missing.append(relative)
        return
    result.bytes += size
    if isinstance(expected, int) and not isinstance(expected, bool) and expected >= 0 and size != expected:
        result.wrong_size.append(f"{relative} ({size} bytes {where}, {expected} in {MANIFEST_NAME})")


def _rows(raw: dict, key: str) -> list[dict]:
    """The entries of one list in ``export.json`` that name a file."""
    value = raw.get(key)
    if not isinstance(value, list):
        return []
    return [row for row in value if isinstance(row, dict) and isinstance(row.get("path"), str)]


def _take_manifest(result: ExportCheck, raw: object, size_of, where: str = "on disk") -> None:
    """Read a parsed ``export.json`` into ``result`` and check every file it lists.

    Whatever is wrong with it lands in ``error``. ``size_of`` and ``where``
    are how the listed files are looked for (see :func:`_check_row`).
    """
    if not isinstance(raw, dict) or raw.get("format") != MANIFEST_FORMAT:
        result.error = f"{MANIFEST_NAME} was not written by the project exporter"
        return
    version = raw.get("version")
    known = (
        isinstance(version, (int, float))
        and not isinstance(version, bool)
        and MANIFEST_VERSION <= version < MANIFEST_VERSION + 1
    )
    if not known:
        result.error = (
            f"its format (version {version!r}) is not one this cswap knows; "
            "upgrade cswap, or use the scripts that came with that export"
        )
        return
    if raw.get("kind") not in ("code", "standard"):
        result.error = f"{MANIFEST_NAME} does not say what kind of project this is"
        return

    result.kind = raw["kind"]
    if isinstance(raw.get("name"), str) and raw["name"].strip():
        result.name = raw["name"].strip()
    if isinstance(raw.get("problems"), list):
        result.problems = [p for p in raw["problems"] if isinstance(p, str)]

    for row in _rows(raw, "files"):
        result.files += 1
        _check_row(result, row["path"], row.get("bytes"), size_of, where)
    for row in _rows(raw, "history"):
        result.conversations += 1
        _check_row(result, row["path"], None, size_of, where)
    memory = raw.get("memory")
    if isinstance(memory, dict) and isinstance(memory.get("path"), str):
        result.conversations += 1
        _check_row(result, memory["path"], None, size_of, where)


def read_export(path: Path) -> ExportCheck:
    """Read the export in ``path`` and check every file it lists.

    Never raises: whatever is wrong with ``export.json`` lands in ``error``,
    and files that are missing or have another size than recorded are listed.
    """
    result = ExportCheck(path=path, name=path.name)
    manifest_path = path / MANIFEST_NAME
    try:
        result.finished_at = manifest_path.stat().st_mtime
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except OSError as e:
        result.error = f"{MANIFEST_NAME} could not be read ({e.strerror or e})"
        return result
    except ValueError:
        result.error = f"{MANIFEST_NAME} is damaged (not valid JSON); export the project again"
        return result

    def size_of(relative: str) -> int | None:
        target = _inside(path, relative)
        return _file_size(target) if target is not None else None

    _take_manifest(result, raw, size_of)
    return result


def _archive_files(members: list[tarfile.TarInfo]) -> dict[str, tarfile.TarInfo]:
    """The files among an archive's ``members`` by path, ``/``-joined and without a leading ``./``.

    tarfile has already put GNU long names, pax paths and the ustar prefix
    into each entry's name. Folders, links and the like are left out.
    """
    files: dict[str, tarfile.TarInfo] = {}
    for member in members:
        if not member.isfile():
            continue
        name = member.name
        while name.startswith("./"):
            name = name[2:]
        files[name] = member
    return files


def _archive_looks_unfinished(files: dict[str, tarfile.TarInfo]) -> bool:
    """Whether a .tar without ``export.json`` holds what an export writes first.

    The .tar's counterpart of :func:`_looks_unfinished`: the markers are
    looked for where ``export.json`` would be, at the top or one folder down.
    """
    return any(name.count("/") <= 1 and name.rsplit("/", 1)[-1] in _UNFINISHED_MARKERS for name in files)


def _archive_is_whole(path: Path, size: int) -> bool:
    """Whether the .tar at ``path`` ends the way a whole one does: two zero blocks.

    A download that stopped early is a shorter file, and tarfile takes a
    header cut short for the end of the archive rather than an error.
    """
    end = 2 * tarfile.BLOCKSIZE
    if size < end or size % tarfile.BLOCKSIZE:
        return False
    with path.open("rb") as f:
        f.seek(size - end)
        return f.read(end) == bytes(end)


def read_export_tar(path: Path) -> ExportCheck:
    """Read the export saved as the one file ``path`` (a .tar) and check every file it lists.

    Inside is what the export's folder would hold, nested in a folder named
    after the export (``export.json`` straight at the top is taken too).
    Only the archive's headers and its ``export.json`` are read: nothing is
    unpacked, and a listed file is matched by its path as written, so an
    entry whose path could leave the export (``..`` and the like) matches
    nothing. Like :func:`read_export`, this never raises.

    What is no tar, or a whole tar with nothing of an export inside, comes
    back ``unrelated``: some other file by that name, not an export that
    went wrong. One cut short (a download that did not finish) is an export
    that went wrong, with its ``export.json`` or, since an export writes
    that last, with only the files it writes first.
    """
    result = ExportCheck(path=path, archive=path, name=path.stem)
    cut_short = "the .tar is cut short (the download did not finish); export the project again"
    try:
        info = path.stat()
        result.finished_at = info.st_mtime
        whole = _archive_is_whole(path, info.st_size)
        try:
            archive = tarfile.open(path, "r:")
        except tarfile.ReadError:
            # Its first block is no tar header: whatever the file is, it
            # is not an archive, let alone one the exporter saved.
            result.unrelated = True
            result.error = "the .tar is not a tar archive; it was not saved by the project exporter"
            return result
        with archive:
            try:
                archive.getmembers()
            except (tarfile.TarError, EOFError, ValueError):
                if whole:
                    result.error = "the .tar is damaged (an entry inside cannot be read); export the project again"
                    return result
                # The file ends inside an entry, as a download that stopped
                # early does. The entries before that were read all the same.
            files = _archive_files(archive.members)
            # The export's folder inside: the one top-level folder with an
            # export.json, or none when export.json is at the top itself.
            tops = [
                name[: -len(MANIFEST_NAME) - 1]
                for name in files
                if name.count("/") == 1 and name.endswith("/" + MANIFEST_NAME)
            ]
            if MANIFEST_NAME in files:
                root = ""
            elif len(tops) == 1:
                root = tops[0] + "/"
            elif tops:
                result.error = f"the .tar holds {len(tops)} exports; save each project as a .tar of its own"
                return result
            elif whole:
                result.unrelated = True
                result.error = f"the .tar holds no {MANIFEST_NAME}; it was not saved by the project exporter"
                return result
            else:
                # Cut short before its export.json. One that got as far as
                # the files an export writes first was an export all the same.
                result.unrelated = not _archive_looks_unfinished(files)
                result.error = cut_short
                return result
            if not whole:
                result.error = cut_short
                return result
            data = archive.extractfile(files[root + MANIFEST_NAME]).read()
    except OSError as e:
        result.error = f"the .tar could not be read ({e.strerror or e})"
        return result
    except (tarfile.TarError, EOFError, ValueError):
        result.error = f"the .tar is damaged ({MANIFEST_NAME} inside cannot be read); export the project again"
        return result
    try:
        raw = json.loads(data.decode("utf-8"))
    except ValueError:
        result.error = f"{MANIFEST_NAME} is damaged (not valid JSON); export the project again"
        return result

    # The files under the export's folder, by the path export.json lists
    # them as, held to the same rules as a path from export.json: an entry
    # that could leave the export is not there to be matched.
    sizes: dict[str, int] = {}
    for name, member in files.items():
        relative = name[len(root):]
        if name.startswith(root) and _plain_parts(relative) is not None:
            sizes[relative] = member.size
    _take_manifest(result, raw, sizes.get, "in the .tar")
    return result


def _looks_unfinished(path: Path) -> bool:
    return any((path / marker).is_file() for marker in _UNFINISHED_MARKERS)


def is_archive(path: Path) -> bool:
    """Whether ``path`` names an export saved as one .tar file rather than a folder."""
    return path.suffix.lower() == ARCHIVE_SUFFIX


def check_folder(folder: Path, since: float = 0.0) -> FolderCheck:
    """Find and check the exports in ``folder``.

    ``folder`` is either the folder that was chosen in the browser (each
    export is a folder inside it, or a .tar saved there), one export itself,
    or the .tar one was saved as. ``since`` is when this move began: among
    several exports, only one finished after that is this move's. An export
    named directly is taken as meant, whatever its age.
    """
    result = FolderCheck(folder=folder, since=since)
    if is_archive(folder) and folder.is_file():
        result.exists = True
        result.direct = True
        result.exports = [read_export_tar(folder)]
        return result
    if not folder.is_dir():
        return result
    result.exists = True

    if (folder / MANIFEST_NAME).is_file():
        result.direct = True
        result.exports = [read_export(folder)]
        return result
    if _looks_unfinished(folder):
        result.unfinished.append(folder.name)
        return result

    try:
        entries = sorted(folder.iterdir(), key=lambda p: p.name.lower())
    except OSError as e:
        result.error = f"the folder could not be read ({e.strerror or e})"
        return result
    for entry in entries:
        if is_archive(entry) and entry.is_file():
            export = read_export_tar(entry)
            # A .tar with nothing of an export in it is some other file
            # that lies here, left alone like anything else in the folder.
            if not export.unrelated:
                result.exports.append(export)
        elif not entry.is_dir():
            continue
        elif (entry / MANIFEST_NAME).is_file():
            result.exports.append(read_export(entry))
        elif _looks_unfinished(entry):
            result.unfinished.append(entry.name)
    result.exports.sort(key=lambda export: export.finished_at, reverse=True)
    return result


def settle_export(result: FolderCheck, remembered: str = "") -> ExportCheck | None:
    """An export this move can import, given a fresh look at the folder.

    That is the one the look found ready, unless an earlier ``check`` settled
    on another (``remembered``, its path) that is still whole and at least as
    new. Without that, an export older than the move, chosen by naming it,
    would be dropped again by the very next stage.
    """
    ready = result.ready
    if remembered and not result.direct:
        path = Path(remembered)
        if is_archive(path) and path.is_file():
            kept = read_export_tar(path)
        elif (path / MANIFEST_NAME).is_file():
            kept = read_export(path)
        else:
            kept = None
        if kept is not None and kept.complete and (ready is None or kept.finished_at >= ready.finished_at):
            return kept
    return ready


def import_target(result: FolderCheck, chosen: ExportCheck | None) -> Path:
    """The folder (or .tar) to choose in the browser when importing.

    One export when there is one to point at: the only one this move made, or
    one settled on by name. With several from this move it is the folder that
    holds them, since the import script then asks which one is meant. An
    export saved as a .tar is always that file: the browser takes it as one,
    and cannot pick it out of the folder it lies in.
    """
    if result.direct or chosen is None:
        return result.folder
    if chosen.archive is not None:
        return chosen.archive
    own = result.own
    if len(own) <= 1 or all(chosen.path != export.path for export in own):
        return chosen.path
    return result.folder


def size_text(count: int) -> str:
    """``count`` bytes for people: ``812 bytes``, ``4.8 KB``, ``1.9 MB``."""
    if count < 1024:
        return f"{count} bytes"
    if count < 1024 * 1024:
        return f"{count / 1024:.1f} KB"
    if count < 1024 * 1024 * 1024:
        return f"{count / 1024 / 1024:.1f} MB"
    return f"{count / 1024 / 1024 / 1024:.1f} GB"


# ---------------------------------------------------------------------------
# GitHub checks (branch carrier)
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


def _mark(items: list[tuple[bool, str, str]]) -> list[tuple[str, str, str]]:
    """``done`` for what is done, ``next`` for the first thing that is not, ``todo`` after."""
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


def steps(state: MoveState, check: RepoCheck | FolderCheck | None = None) -> list[tuple[str, str, str]]:
    """The manual steps in order as ``(status, title, what to run or paste)``.

    ``status`` is ``done``, ``next`` or ``todo``. Done-ness is inferred from the
    state file and, when given, a fresh check of the folder or of GitHub; the
    pastes inside claude.ai cannot be observed, so handing out a script or a
    prompt counts as its step.
    """
    if effective_carrier(state) == CARRIER_BRANCH:
        return _branch_steps(state, check if isinstance(check, RepoCheck) else None)
    return _folder_steps(state, check if isinstance(check, FolderCheck) else None)


def _folder_steps(state: MoveState, check: FolderCheck | None) -> list[tuple[str, str, str]]:
    folder = state.folder or str(default_exports_folder())
    folder_flag = "" if Path(folder) == default_exports_folder() else f' --folder "{folder}"'
    export_done = bool(state.exported_at)
    saved = bool(check and check.export_ready) or (bool(state.export_seen_at) and check is None)
    import_done = bool(state.imported_at)
    if check and check.ready:
        target = str(import_target(check, check.ready))
    else:
        target = state.export_path or folder
    if is_archive(Path(target)):
        import_title = (
            'Paste it in the browser console on any claude.ai page, press "Import from a .tar file instead" '
            "and choose this file"
        )
    else:
        import_title = "Paste it in the browser console on any claude.ai page, then choose this folder"

    return _mark(
        [
            (
                export_done,
                "Copy the export script to the clipboard",
                f"cswap project-move export{folder_flag}",
            ),
            (
                export_done,
                "In Chrome or Edge, as the SOURCE account: paste it in the browser console "
                "on the project's page, then choose this folder",
                folder,
            ),
            (
                saved,
                "Check the exported folder",
                "cswap project-move check",
            ),
            (
                import_done,
                "Sign in to claude.ai as the DESTINATION account (another browser profile works too)",
                CLAUDE_URL,
            ),
            (
                import_done,
                "Copy the import script to the clipboard",
                "cswap project-move import",
            ),
            (
                import_done,
                import_title,
                target,
            ),
        ]
    )


def _branch_steps(state: MoveState, check: RepoCheck | None) -> list[tuple[str, str, str]]:
    repo = state.repo or PLACEHOLDER_REPO
    branch = state.branch or DEFAULT_BRANCH
    branch_flag = "" if branch == DEFAULT_BRANCH else f" --branch {branch}"
    export_done = bool(state.exported_at)
    branch_up = bool(check and check.export_ready) or (bool(state.branch_seen_at) and check is None)
    import_done = bool(state.imported_at)

    return _mark(
        [
            (
                export_done,
                "Generate the export prompt (copies it to the clipboard)",
                f"cswap project-move export {repo}{branch_flag}"
                + ("" if state.repo else f"\n  where {PLACEHOLDER_REPO} is {REPO_HINT}"),
            ),
            (
                export_done,
                "Logged in to claude.ai as the SOURCE account, open the old project's chat and paste (Ctrl+V), then send",
                "(paste)",
            ),
            (
                branch_up,
                "Wait for the export thread to push the branch",
                "cswap project-move check --wait",
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
    )
