"""Session checkpoints: ``.claude/session.md`` and a section of ``CLAUDE.md``.

``cswap checkpoint write`` renders a checkpoint of the current Claude Code
session from its local JSONL transcript, using the readers in ``handoff.py``
and no model call, so the same transcript always gives the same bytes and a
rerun changes nothing. ``cswap checkpoint start`` begins a new claude session
told to read the checkpoint first, and ``cswap teleport --checkpoint`` commits
it on the branch instead of a handoff note (``commit_checkpoint``).

What the checkpoint says is inferred from the conversation with plain regular
expressions, except three reliable sources: lines the person or Claude tagged
``Decision:``, ``Constraint:``, ``Blocker:``, ``Next:`` or ``Done:`` are kept
verbatim; the last TodoWrite list gives the done and remaining tasks; git
gives the commits and the working tree. Tool output never reaches the file,
and likely secrets are redacted exactly as ``handoff.py`` redacts them.

This module edits only ``.claude/session.md`` and the marker-delimited section
of the root ``CLAUDE.md``; everything outside the markers is kept byte for
byte. The CLI wiring (``cswap checkpoint ...``) is ``main(argv)``.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from claude_swap import handoff, paths
from claude_swap.exceptions import ClaudeSwitchError, ValidationError
from claude_swap.fsutil import replace_with_retry
from claude_swap.handoff import (
    GitState,
    _blocks,
    _text_of,
    active_branch,
    clip,
    extract,
    find_transcript,
    load_transcript,
    redact,
    strip_harness,
)
from claude_swap.printer import accent, dimmed, error, warning

if TYPE_CHECKING:
    from claude_swap.session import SessionManager

CHECKPOINT_PATH = Path(".claude") / "session.md"
CLAUDE_MD = "CLAUDE.md"
MARK_BEGIN = "<!-- cswap:checkpoint:begin -->"
MARK_END = "<!-- cswap:checkpoint:end -->"
# Subject prefix of cswap's own checkpoint commits; git_state leaves them out
# of the commit list so a rerun renders the same checkpoint.
CHECKPOINT_COMMIT_PREFIX = "Add cswap checkpoint"
DEFAULT_CHECKPOINT_BYTES = 16 * 1024
DEFAULT_TASK = "continue the work it describes."
START_PROMPT = (
    "Read .claude/session.md first; it is the checkpoint of the previous "
    "session. Keep lines you want the next checkpoint to carry tagged "
    "Decision:, Constraint:, Blocker: or Next:. Then: "
)

# Section heuristics. Anchored or word-bounded so a word inside another word
# ("undone", "keeper") does not count. Case-insensitive throughout.
COMPLETED_RE = re.compile(
    r"^(done|completed|added|fixed|implemented|wrote|created|updated|removed|"
    r"refactored|renamed|moved|replaced|extracted|finished|tested|verified)\b",
    re.IGNORECASE,
)
DECISION_RE = re.compile(
    r"\b(decided|decision|we chose|chose to|going with|instead of|rather than|"
    r"will use|we'll use|settled on|convention|approach)\b",
    re.IGNORECASE,
)
REMAINING_RE = re.compile(
    r"\b(todo|to do|next step|remaining|still need|not yet|follow-up|pending|"
    r"left to do)\b",
    re.IGNORECASE,
)
BLOCKER_RE = re.compile(
    r"\b(blocked|blocker|cannot|can't|unable to|fails?|failing|broken|"
    r"does not work|doesn't work|waiting on|needs? (access|permission|credentials))\b",
    re.IGNORECASE,
)
CONSTRAINT_RE = re.compile(
    r"\b(must not|must|never|always|do not|don't|only|should not|require[sd]?|"
    r"constraint|rule|keep)\b",
    re.IGNORECASE,
)

MAX_COMPLETED, MAX_DECISIONS, MAX_REMAINING = 20, 15, 20
MAX_BLOCKERS, MAX_CONSTRAINTS, MAX_FILES = 10, 20, 40
SENTENCE_CHARS = 240
DECISION_CHARS = 300
CONSTRAINT_CHARS = 200
QUOTE_CHARS = 1500
QUOTE_CHARS_TRIMMED = 500
# Blockers are looked for in the newest turns only: an early "tests fail"
# that was fixed long ago is not a blocker any more.
BLOCKER_TURNS = 10
NONE_RECORDED = "- (none recorded)"

# A tag at the start of a line (after list markers) routes the line, verbatim,
# to one section. `todo`/`remaining` are spellings of `next`, `completed` of
# `done`.
TAG_SECTIONS = {
    "decision": "decision",
    "constraint": "constraint",
    "blocker": "blocker",
    "next": "next",
    "todo": "next",
    "remaining": "next",
    "done": "done",
    "completed": "done",
}
_TAG_RE = re.compile(
    r"^(decision|constraint|blocker|next|todo|remaining|done|completed)\s*:\**\s*(.*?)\s*$",
    re.IGNORECASE,
)
# List markers, block quotes, headings, bold openers and checkboxes in front of
# a line. Each alternative consumes at least one character, so the loop ends.
_LEAD_RE = re.compile(r"^(?:[-*+]\s+|\d+[.)]\s+|>\s*|#{1,6}\s+|\*\*|\[[ xX]\]\s*)+")
_CHECKBOX_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s*\[ \]\s*(.+?)\s*$", re.MULTILINE)
# Fenced code is dropped before any scan (tags, checkboxes, sentences): code
# comments and YAML keys read like constraints ("# keep this") or tasks
# ("done: true"), and blocks are where pasted secrets tend to sit.
_FENCE_RE = re.compile(r"^[ \t]*(```|~~~).*?^[ \t]*\1[ \t]*$", re.MULTILINE | re.DOTALL)
_SENTENCE_END_RE = re.compile(r"(?<=[.!?])\s+")

INTRO = (
    "Written by `cswap checkpoint write` from the local Claude Code transcript, "
    "without a model call. Tool output was left out and likely secrets were "
    "redacted. Lines tagged `Decision:`, `Constraint:`, `Blocker:`, `Next:` or "
    "`Done:` in the conversation are kept verbatim; the rest is inferred. "
    "Rewritten on every `cswap checkpoint write`; do not edit by hand."
)
FOOTER = (
    "Next session: `cswap checkpoint start [--account A]` tells claude to read "
    "this file first."
)
CLAUDE_MD_INTRO = (
    "Read `.claude/session.md` at the start of a session: it holds the completed "
    "work, the current state and the remaining tasks. Tag durable facts in "
    "conversation as `Decision:` or `Constraint:` so the next "
    "`cswap checkpoint write` keeps them."
)


class CheckpointError(ClaudeSwitchError):
    """A checkpoint could not be built, written or started; the message says why."""


@dataclass
class Checkpoint:
    """Everything the two renderers need, already redacted and deduplicated."""

    session_id: str = ""
    title: str | None = None
    last_activity: str | None = None
    branch: str | None = None
    transcript_sha: str = ""
    original_request: str = ""
    last_claude: str = ""
    commits: list[str] = field(default_factory=list)
    completed: list[str] = field(default_factory=list)
    tasks_done: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    tree: str = "unknown"
    decisions: list[str] = field(default_factory=list)
    remaining: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)
    constraints: list[str] = field(default_factory=list)
    redactions: int = 0


# --- reading the transcript ---------------------------------------------------


def _strip_lead(line: str) -> str:
    return _LEAD_RE.sub("", line.strip()).strip()


def sentences(text: str) -> list[str]:
    """Sentences of a message, ready for the section regexes.

    Harness tags and fenced code are dropped, list markers, quotes, headings
    and checkboxes are stripped from the front, the text is split at sentence
    ends and line breaks, and every piece is clipped to ``SENTENCE_CHARS``.
    """
    text = _FENCE_RE.sub("", strip_harness(text or ""))
    out: list[str] = []
    # Lines first, markers stripped, then sentence ends: a numbered list's
    # "1." would otherwise count as the end of a sentence.
    for line in text.split("\n"):
        line = _strip_lead(line)
        if not line:
            continue
        for raw in _SENTENCE_END_RE.split(line):
            piece = _strip_lead(raw)
            if piece:
                out.append(clip(piece, SENTENCE_CHARS))
    return out


def tagged_lines(text: str) -> dict[str, list[str]]:
    """Lines tagged ``Decision:``, ``Constraint:``, ``Blocker:``, ``Next:``
    (or ``TODO:``/``Remaining:``) and ``Done:`` (or ``Completed:``), keyed by
    section, verbatim minus the tag and any list marker in front of it. Fenced
    code is not scanned: a ``# TODO:`` comment is not a task."""
    found: dict[str, list[str]] = {k: [] for k in ("decision", "constraint", "blocker", "next", "done")}
    for line in _FENCE_RE.sub("", strip_harness(text or "")).splitlines():
        m = _TAG_RE.match(_strip_lead(line))
        if m and m.group(2):
            found[TAG_SECTIONS[m.group(1).lower()]].append(m.group(2))
    return found


def _untagged(text: str) -> str:
    """The message without its tagged lines, so a tagged line is kept once, in
    its own section, and never re-matched by another section's regex."""
    kept = [ln for ln in text.splitlines() if not _TAG_RE.match(_strip_lead(ln))]
    return "\n".join(kept)


def last_todos(entries: list[dict[str, Any]]) -> list[dict[str, str]]:
    """``[{content, status}]`` of the last TodoWrite on the active branch.

    Items that are not objects with a text ``content`` are skipped; a missing
    status counts as pending, so a half-written list still shows its tasks.
    """
    todos: list[Any] | None = None
    for e in active_branch(entries):
        if e.get("type") != "assistant":
            continue
        for b in _blocks(e["message"]):
            if b.get("type") != "tool_use" or b.get("name") != "TodoWrite":
                continue
            inp = b.get("input")
            if isinstance(inp, dict) and isinstance(inp.get("todos"), list):
                todos = inp["todos"]
    out: list[dict[str, str]] = []
    for t in todos or []:
        if not isinstance(t, dict):
            continue
        content = t.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        status = t.get("status")
        out.append(
            {
                "content": " ".join(content.split()),
                "status": status.strip().lower() if isinstance(status, str) else "pending",
            }
        )
    return out


def transcript_sha256(path: Path | None) -> str:
    """Hex digest of the transcript file; empty when there is none to read."""
    if path is None:
        return ""
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 16), b""):
                digest.update(chunk)
    except OSError:
        return ""
    return digest.hexdigest()


@dataclass
class _Message:
    role: str
    text: str
    tags: dict[str, list[str]]
    sentences: list[str]
    checkboxes: list[str]


def _messages(entries: list[dict[str, Any]]) -> tuple[list[_Message], int]:
    """The conversation on the active branch, harness-stripped and redacted.

    Returns the messages and how many strings were redacted. Tool results,
    meta messages and compaction summaries are left out as handoff.py does;
    a message whose content holds no text block (images, unknown shapes) is
    skipped rather than guessed at. Fenced code stays in ``text`` (the quoted
    request and last reply) and is left out of every scan.
    """
    out: list[_Message] = []
    redactions = 0
    for e in active_branch(entries):
        role = e["type"]
        if role == "user" and (e.get("isMeta") or e.get("isCompactSummary")):
            continue
        text = strip_harness(_text_of(_blocks(e["message"])))
        if not text:
            continue
        text, n = redact(text)
        redactions += n
        body = _FENCE_RE.sub("", text)
        prose = _untagged(body)
        out.append(
            _Message(
                role=role,
                text=text,
                tags=tagged_lines(body),
                sentences=sentences(prose),
                checkboxes=[clip(m, SENTENCE_CHARS) for m in _CHECKBOX_RE.findall(prose)],
            )
        )
    return out, redactions


def _last_turns(msgs: list[_Message], turns: int) -> list[_Message]:
    """The messages of the newest ``turns`` turns, a turn starting at each user message."""
    starts = [i for i, m in enumerate(msgs) if m.role == "user"]
    if len(starts) <= turns:
        return list(msgs)
    return msgs[starts[-turns] :]


def _norm(text: str) -> str:
    return " ".join(text.split()).lower()


def _fill(primary: list[str], secondary: list[str], cap: int) -> list[str]:
    """Deduplicated ``primary`` (tagged lines, task items: never cut), then
    ``secondary`` (inferred sentences) until the list holds ``cap`` entries."""
    out: list[str] = []
    seen: set[str] = set()
    for s in primary:
        key = _norm(s)
        if key and key not in seen:
            seen.add(key)
            out.append(s)
    for s in secondary:
        if len(out) >= cap:
            break
        key = _norm(s)
        if key and key not in seen:
            seen.add(key)
            out.append(s)
    return out


def working_tree_summary(repo: Path | None) -> str:
    """``clean``, ``N modified, M untracked`` or ``unknown`` without git.

    The checkpoint files themselves are not counted: writing them would
    otherwise turn a clean tree into "1 untracked" on the very next run.
    """
    if repo is None:
        return "unknown"
    out = _run_git(repo, "status", "--porcelain", "--untracked-files=all")
    if out is None:
        return "unknown"
    skip = set(_tracked_checkpoint_paths(repo))
    modified = untracked = 0
    for line in out.splitlines():
        if len(line) < 4:
            continue
        path = line[3:].split(" -> ")[-1].strip().strip('"')
        if path in skip:
            continue
        if line.startswith("??"):
            untracked += 1
        else:
            modified += 1
    if not modified and not untracked:
        return "clean"
    return f"{modified} modified, {untracked} untracked"


def git_state(repo: Path | None) -> GitState:
    """``handoff.git_state`` with cswap's own checkpoint commits left out too."""
    state = handoff.git_state(repo)
    state.commits = [c for c in state.commits if CHECKPOINT_COMMIT_PREFIX not in c]
    return state


def extract_checkpoint(
    entries: list[dict[str, Any]],
    *,
    session_id: str,
    git: GitState,
    transcript_sha: str,
    tree: str,
) -> Checkpoint:
    """Pure: the transcript entries, git facts and tree summary -> Checkpoint."""
    ex = extract(entries)
    msgs, redactions = _messages(entries)
    todos = last_todos(entries)

    tags: dict[str, list[str]] = {k: [] for k in ("decision", "constraint", "blocker", "next", "done")}
    for m in msgs:
        for key, lines in m.tags.items():
            tags[key].extend(lines)
    assistant = [s for m in msgs if m.role == "assistant" for s in m.sentences]
    user = [s for m in msgs if m.role == "user" for s in m.sentences]
    every = [s for m in msgs for s in m.sentences]
    recent = [s for m in _last_turns(msgs, BLOCKER_TURNS) for s in m.sentences]

    # Remaining tasks: the TodoWrite list when it has open items, else the
    # `- [ ]` items of the newest assistant message that has any. Both are
    # written by Claude on purpose, so they come before anything inferred.
    open_items = [t["content"] for t in todos if t["status"] != "completed"]
    if not open_items:
        open_items = next((m.checkboxes for m in reversed(msgs) if m.role == "assistant" and m.checkboxes), [])

    return Checkpoint(
        session_id=session_id,
        title=ex.title,
        last_activity=ex.last_activity,
        branch=git.branch or ex.branch,
        transcript_sha=transcript_sha,
        original_request=next((m.text for m in msgs if m.role == "user"), ""),
        last_claude=next((m.text for m in reversed(msgs) if m.role == "assistant"), ""),
        # git log is newest first; the checkpoint tells the story oldest first.
        commits=list(reversed(git.commits)),
        completed=_fill(tags["done"], [s for s in assistant if COMPLETED_RE.search(s)], MAX_COMPLETED),
        tasks_done=[t["content"] for t in todos if t["status"] == "completed"],
        files=list(ex.files[:MAX_FILES]),
        tree=tree or "unknown",
        decisions=_fill(
            tags["decision"],
            [clip(s, DECISION_CHARS) for s in assistant if DECISION_RE.search(s)],
            MAX_DECISIONS,
        ),
        remaining=_fill(open_items + tags["next"], [s for s in every if REMAINING_RE.search(s)], MAX_REMAINING),
        blockers=_fill(tags["blocker"], [s for s in recent if BLOCKER_RE.search(s)], MAX_BLOCKERS),
        constraints=_fill(
            tags["constraint"],
            [clip(s, CONSTRAINT_CHARS) for s in user if CONSTRAINT_RE.search(s)],
            MAX_CONSTRAINTS,
        ),
        redactions=redactions,
    )


# --- rendering -----------------------------------------------------------------


def _size(text: str) -> int:
    return len(text.encode("utf-8"))


def _code(text: str) -> str:
    return f"`` {text} ``" if "`" in text else f"`{text}`"


def _quote(text: str) -> str:
    return "\n".join("> " + line if line else ">" for line in text.splitlines())


def _no_markers(text: str) -> str:
    """A list item must not be able to close or open the CLAUDE.md section."""
    return text.replace(MARK_BEGIN, "[marker]").replace(MARK_END, "[marker]")


def _redacted_copy(cp: Checkpoint) -> Checkpoint:
    """Every string redacted again as a backstop, so a Checkpoint built by hand
    is as safe as one read from a transcript. Applied before the size budget
    is measured, since redaction can lengthen a string."""
    values: dict[str, Any] = {}
    for f in fields(cp):
        v = getattr(cp, f.name)
        if isinstance(v, str):
            values[f.name] = redact(v)[0]
        elif isinstance(v, list):
            values[f.name] = [redact(str(x))[0] for x in v]
        else:
            values[f.name] = v
    return Checkpoint(**values)


def _layout(cp: Checkpoint, b: dict[str, Any]) -> str:
    sha = cp.transcript_sha[:12] if cp.transcript_sha else "unknown"
    lines = [
        f"# Session checkpoint: {cp.title or cp.session_id or 'unknown'}",
        "",
        f"Session `{cp.session_id or 'unknown'}` | branch `{cp.branch or 'unknown'}` | "
        f"last activity {cp.last_activity or 'unknown'} | transcript sha256 {sha}",
        "",
        INTRO,
        "",
        "## Completed work",
    ]
    completed = [f"- commit: {c}" for c in cp.commits]
    completed += [f"- task done: {t}" for t in cp.tasks_done]
    completed += [f"- {s}" for s in b["completed"]]
    if b["files"]:
        completed.append("- files touched: " + ", ".join(_code(f) for f in b["files"]))
    lines += completed or [NONE_RECORDED]
    lines += [
        "",
        "## Current implementation state",
        f"Branch {_code(cp.branch) if cp.branch else 'unknown'}; working tree {cp.tree or 'unknown'}.",
        _quote(clip(cp.last_claude, b["state_chars"])) if cp.last_claude else "(no transcript)",
        "",
        "## Architectural decisions",
    ]
    lines += [f"- {d}" for d in b["decisions"]] or [NONE_RECORDED]
    lines += ["", "## Remaining tasks"]
    lines += [f"- [ ] {r}" for r in b["remaining"]] or [NONE_RECORDED]
    lines += ["", "## Known blockers"]
    lines += [f"- {x}" for x in b["blockers"]] or [NONE_RECORDED]
    lines += ["", "## Important constraints"]
    lines += [f"- {c}" for c in b["constraints"]] or [NONE_RECORDED]
    lines += [
        "",
        "## Original request",
        _quote(clip(cp.original_request, b["orig_chars"])) if cp.original_request else "> (none recorded)",
        "",
        "---",
        FOOTER,
        "",
    ]
    return "\n".join(lines)


def _trim_once(b: dict[str, Any]) -> bool:
    """One step of the size-cap order: files, completed, the state quote (to
    500 chars), the original request (to 500), remaining, blockers, decisions,
    constraints; each list loses its last entry. False when nothing is left."""
    for key in ("files", "completed"):
        if b[key]:
            b[key].pop()
            return True
    for key in ("state_chars", "orig_chars"):
        if b[key] > QUOTE_CHARS_TRIMMED:
            b[key] = QUOTE_CHARS_TRIMMED
            return True
    for key in ("remaining", "blockers", "decisions", "constraints"):
        if b[key]:
            b[key].pop()
            return True
    return False


def render_checkpoint(cp: Checkpoint, *, max_bytes: int = DEFAULT_CHECKPOINT_BYTES) -> str:
    """The ``.claude/session.md`` text. Deterministic: nothing here reads a clock."""
    if max_bytes < 1:
        raise ValidationError("max_bytes must be at least 1")
    cp = _redacted_copy(cp)
    b: dict[str, Any] = {
        "files": list(cp.files),
        "completed": list(cp.completed),
        "state_chars": QUOTE_CHARS,
        "orig_chars": QUOTE_CHARS,
        "remaining": list(cp.remaining),
        "blockers": list(cp.blockers),
        "decisions": list(cp.decisions),
        "constraints": list(cp.constraints),
    }
    text = _layout(cp, b)
    while _size(text) > max_bytes and _trim_once(b):
        text = _layout(cp, b)
    if _size(text) > max_bytes:
        # Pathological input (an enormous commit list or title): hard cut.
        tail = "\n...\n"
        text = text.encode("utf-8")[: max(0, max_bytes - len(tail))].decode("utf-8", "ignore") + tail
    return text


def render_claude_md_section(cp: Checkpoint) -> str:
    """The marker-delimited block for CLAUDE.md, without a trailing newline."""
    cp = _redacted_copy(cp)
    lines = [
        MARK_BEGIN,
        "## Session checkpoint (kept by cswap)",
        "",
        CLAUDE_MD_INTRO,
        "",
        "### Durable decisions",
    ]
    lines += [f"- {_no_markers(d)}" for d in cp.decisions] or [NONE_RECORDED]
    lines.append("### Constraints")
    lines += [f"- {_no_markers(c)}" for c in cp.constraints] or [NONE_RECORDED]
    lines.append(MARK_END)
    return "\n".join(lines)


def upsert_marked_section(existing: str | None, section: str) -> str:
    """``existing`` with ``section`` between the first marker pair.

    Replaced in place when the pair exists, appended after one blank line when
    it does not, the whole file when there is none. Everything outside the
    markers is kept byte for byte, and a CRLF file stays CRLF. An unpaired
    marker is a file someone edited by hand, which is refused rather than
    guessed at.
    """
    if not existing:
        return section + "\n"
    nl = "\r\n" if "\r\n" in existing else "\n"
    block = section.replace("\n", nl)
    begin = existing.find(MARK_BEGIN)
    end = existing.find(MARK_END, begin) if begin != -1 else existing.find(MARK_END)
    if begin == -1 and end == -1:
        if existing.endswith(nl + nl):
            sep = ""
        elif existing.endswith(nl):
            sep = nl
        else:
            sep = nl + nl
        return existing + sep + block + nl
    if begin == -1 or end == -1:
        raise ValidationError(
            f"{CLAUDE_MD} has an unpaired checkpoint marker ({MARK_BEGIN} / "
            f"{MARK_END}). Remove or pair the markers by hand, then rerun."
        )
    return existing[:begin] + block + existing[end + len(MARK_END) :]


def _write_if_changed(path: Path, data: bytes) -> bool:
    """Atomic write (temp file beside the target, then rename), skipped when
    the bytes are already there so an unchanged file keeps its mtime."""
    try:
        if path.is_file() and path.read_bytes() == data:
            return False
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
            replace_with_retry(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError as e:
        raise CheckpointError(f"Could not write {path}: {e}") from e
    return True


def write_checkpoint(repo: Path, text: str) -> tuple[Path, bool]:
    """Write ``.claude/session.md``; the flag says whether anything changed."""
    path = Path(repo) / CHECKPOINT_PATH
    if not text.endswith("\n"):
        text += "\n"
    return path, _write_if_changed(path, text.encode("utf-8"))


def update_claude_md(repo: Path, section: str) -> tuple[Path, bool]:
    """Upsert the marker section of the root CLAUDE.md, creating the file if needed.

    A symlinked CLAUDE.md (``CLAUDE.md -> AGENTS.md`` is common) is updated at
    its target: the rename in ``_write_if_changed`` would otherwise replace
    the link itself with a regular file. The returned path is still CLAUDE.md.
    """
    path = Path(repo) / CLAUDE_MD
    target = path.resolve() if path.is_symlink() else path
    existing: str | None = None
    try:
        if target.exists():
            # surrogateescape round-trips bytes that are not UTF-8 unchanged.
            existing = target.read_bytes().decode("utf-8", "surrogateescape")
    except OSError as e:
        raise CheckpointError(f"Could not read {path}: {e}") from e
    text = upsert_marked_section(existing, section)
    return path, _write_if_changed(target, text.encode("utf-8", "surrogateescape"))


def checkpoint_files() -> list[Path]:
    return [CHECKPOINT_PATH, Path(CLAUDE_MD)]


def _tracked_checkpoint_paths(repo: Path) -> list[str]:
    """Repository-relative POSIX paths of the checkpoint files as git sees
    them: the two files, plus the target of a symlinked CLAUDE.md when it is
    inside the repository, since that is the file ``update_claude_md`` writes."""
    repo = Path(repo)
    rels = [p.as_posix() for p in checkpoint_files()]
    link = repo / CLAUDE_MD
    if link.is_symlink():
        try:
            rels.append(link.resolve().relative_to(repo.resolve()).as_posix())
        except (OSError, ValueError):
            pass  # the target is outside the repository: nothing for git to see
    return rels


def start_prompt(task: str | None) -> str:
    return START_PROMPT + ((task or "").strip() or DEFAULT_TASK)


# --- git helpers ----------------------------------------------------------------


def _run_git(repo: Path, *args: str) -> str | None:
    """stdout of a git command, unstripped (porcelain output starts with a
    space that matters); None when git is missing or the command fails."""
    try:
        r = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 else None


def repo_root(cwd: Path) -> Path:
    """The git top level of ``cwd``, or ``cwd`` itself outside a repository."""
    top = _run_git(cwd, "rev-parse", "--show-toplevel")
    return Path(top.strip()) if top and top.strip() else Path(cwd)


def commit_checkpoint(repo: Path, subject: str) -> bool:
    """Commit the checkpoint files on the current branch; False when nothing changed.

    What ``cswap teleport --checkpoint`` does instead of committing a handoff
    note. ``-f`` because a .gitignore'd ``.claude/`` must not drop the file
    silently; the commit names only the checkpoint files so nothing else that
    happens to be staged rides along.
    """
    repo = Path(repo)
    rels = [p for p in _tracked_checkpoint_paths(repo) if (repo / p).is_file()]
    if not rels:
        return False
    added = subprocess.run(
        ["git", "add", "-f", "--", *rels], cwd=repo, capture_output=True, text=True
    )
    if added.returncode != 0:
        raise CheckpointError(
            f"git add failed for the checkpoint files: {added.stderr.strip() or added.returncode}"
        )
    status = subprocess.run(
        ["git", "status", "--porcelain", "--", *rels], cwd=repo, capture_output=True, text=True
    )
    if status.returncode == 0 and not status.stdout.strip():
        return False
    subject = " ".join(subject.split()) or "session"
    committed = subprocess.run(
        ["git", "commit", "-q", "-m", f"{CHECKPOINT_COMMIT_PREFIX} {subject}", "--", *rels],
        cwd=repo, capture_output=True, text=True,
    )
    if committed.returncode != 0:
        raise CheckpointError(
            "Could not commit the checkpoint files: "
            + (committed.stderr.strip() or f"git exited {committed.returncode}")
        )
    return True


# --- locating the transcript ------------------------------------------------------


def config_dir_for(
    manager: SessionManager | None, identifier: str | None, share: bool = True
) -> Path:
    """Where the account's claude keeps its transcripts, without touching it.

    No account: the current profile (``CLAUDE_CONFIG_DIR`` or ``~/.claude``).
    With one: the profile ``launch_env`` would run it in, worked out the same
    way but read-only, because ``launch_env`` bootstraps the profile (and may
    refresh its credential over the network) on its way to the same answer:
    the default login when the account is the active one and no
    ``CLAUDE_CONFIG_DIR`` is set, else the account's session profile under the
    backup directory. ``share`` is accepted so a plan can be passed through;
    it does not move the profile.
    """
    if not identifier:
        return paths.get_claude_config_home()
    if manager is None:
        raise CheckpointError(
            f"Account {identifier!r} was named, but no account registry is available here."
        )
    from claude_swap.session import session_dir_for

    switcher = manager.switcher
    num, email, org = switcher.resolve_account(identifier)
    # The same reader launch_env's same-account fast path uses.
    if not os.environ.get("CLAUDE_CONFIG_DIR") and switcher._get_current_account() == (email, org):
        return paths.get_claude_config_home()
    return session_dir_for(Path(switcher.backup_dir), num, email)


def locate_transcript(config_dir: Path, cwd: Path, session_id: str | None) -> Path | None:
    """``handoff.find_transcript`` for ``cwd``, then for the repository root,
    since claude may have been started in either.

    A named session must be found by name: ``find_transcript`` otherwise falls
    back to the newest transcript for the directory, which would label one
    session's conversation with another session's id.
    """
    config_dir = Path(config_dir)
    cwd = Path(cwd)
    if session_id:
        # The name is looked for under every project, so one call settles it.
        found = find_transcript(config_dir, cwd, session_id, None)
        return found if found is not None and found.stem == session_id else None
    candidates: list[Path] = []
    for c in (cwd, cwd.resolve(), repo_root(cwd), repo_root(cwd).resolve()):
        if c not in candidates:
            candidates.append(c)
    for c in candidates:
        found = find_transcript(config_dir, c, None, None)
        if found is not None:
            return found
    return None


# --- orchestration ------------------------------------------------------------------


@dataclass
class CheckpointPlan:
    account: str | None = None
    session_id: str | None = None
    cwd: Path | None = None
    claude_md: bool = True
    max_bytes: int = DEFAULT_CHECKPOINT_BYTES
    task: str | None = None
    claude_args: list[str] = field(default_factory=list)
    share: bool = True
    # `start` writes first unless told not to (--no-write).
    write: bool = True
    # A transcript the caller already located (teleport has it in hand); when
    # set, nothing is looked up through the account.
    transcript: Path | None = None


@dataclass
class WriteResult:
    checkpoint: Path
    claude_md: Path | None
    changed: bool
    redactions: int
    transcript: Path | None


class Checkpointer:
    """Builds, writes, shows and starts from a checkpoint for one directory."""

    def __init__(
        self,
        manager: SessionManager | None,
        cwd: Path | None = None,
        say: Callable[[str], None] = print,
    ):
        self.manager = manager
        self.cwd = Path(cwd or os.getcwd())
        self.say = say

    def _where(self, plan: CheckpointPlan) -> tuple[Path, Path]:
        cwd = Path(plan.cwd) if plan.cwd else self.cwd
        if not cwd.is_dir():
            raise CheckpointError(f"{cwd} is not a directory.")
        return cwd, repo_root(cwd)

    def _build(self, plan: CheckpointPlan) -> tuple[Checkpoint, str, str, Path | None, Path]:
        if plan.max_bytes < 1:
            raise ValidationError("The checkpoint size cap must be at least 1 byte.")
        cwd, repo = self._where(plan)
        if plan.transcript is not None:
            transcript: Path | None = Path(plan.transcript)
        else:
            transcript = locate_transcript(
                config_dir_for(self.manager, plan.account, plan.share), cwd, plan.session_id
            )
        entries = load_transcript(transcript) if transcript is not None else []
        # A located transcript is named after the session (locate_transcript
        # insists on it); one handed in by the caller keeps the caller's id,
        # which teleport knows better than the local file name.
        session_id = "unknown" if transcript is None else (plan.session_id or transcript.stem)
        cp = extract_checkpoint(
            entries,
            session_id=session_id,
            git=git_state(repo),
            transcript_sha=transcript_sha256(transcript),
            tree=working_tree_summary(repo),
        )
        text = render_checkpoint(cp, max_bytes=plan.max_bytes)
        return cp, text, render_claude_md_section(cp), transcript, repo

    def build(self, plan: CheckpointPlan) -> tuple[Checkpoint, str, str]:
        """(checkpoint, session.md text, CLAUDE.md section); writes nothing."""
        cp, text, section, _, _ = self._build(plan)
        return cp, text, section

    def write(self, plan: CheckpointPlan) -> WriteResult:
        cp, text, section, transcript, repo = self._build(plan)
        if transcript is None:
            named = f" named {plan.session_id!r}" if plan.session_id else ""
            warning(
                f"No local transcript{named} was found for this directory; the "
                "checkpoint only names the branch and the working tree."
            )
        else:
            self.say(dimmed(f"Checkpoint built from {transcript}"))
        path, changed = write_checkpoint(repo, text)
        rel = CHECKPOINT_PATH.as_posix()
        self.say(
            f"{accent('Wrote')} {rel} ({_size(text)} bytes)" if changed else dimmed(f"{rel} is unchanged.")
        )
        md_path: Path | None = None
        md_changed = False
        if plan.claude_md:
            md_path, md_changed = update_claude_md(repo, section)
            self.say(
                f"{accent('Updated')} the cswap section of {CLAUDE_MD}"
                if md_changed
                else dimmed(f"The cswap section of {CLAUDE_MD} is unchanged.")
            )
        if cp.redactions:
            self.say(dimmed(f"Redacted {cp.redactions} credential-like string(s)."))
        return WriteResult(
            checkpoint=path,
            claude_md=md_path,
            changed=changed or md_changed,
            redactions=cp.redactions,
            transcript=transcript,
        )

    def start(self, plan: CheckpointPlan) -> int:
        """Write the checkpoint, then run claude told to read it first."""
        if plan.write:
            self.write(plan)
        cwd, _ = self._where(plan)
        prompt = start_prompt(plan.task)
        if plan.account:
            if self.manager is None:
                raise CheckpointError(
                    f"Account {plan.account!r} was named, but no account registry is available here."
                )
            claude_bin, env = self.manager.launch_env(plan.account, share=plan.share)
        else:
            claude_bin = shutil.which("claude")
            if not claude_bin:
                raise CheckpointError("'claude' was not found on PATH. Install Claude Code first.")
            env = dict(os.environ)
        try:
            return subprocess.run([claude_bin, *plan.claude_args, prompt], env=env, cwd=cwd).returncode
        except KeyboardInterrupt:
            return 130

    def show(self, plan: CheckpointPlan | None = None) -> str:
        _, repo = self._where(plan or CheckpointPlan())
        path = repo / CHECKPOINT_PATH
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            raise CheckpointError(
                f"No checkpoint at {CHECKPOINT_PATH.as_posix()} under {repo}. "
                "Run `cswap checkpoint write` first."
            ) from None
        except OSError as e:
            raise CheckpointError(f"Could not read {path}: {e}") from e


# --- CLI --------------------------------------------------------------------------------


def _default_manager(debug: bool) -> SessionManager:
    from claude_swap.session import SessionManager
    from claude_swap.switcher import ClaudeAccountSwitcher

    return SessionManager(ClaudeAccountSwitcher(debug=debug))


def _parser(prog: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=prog,
        description=(
            "Keep a checkpoint of the current Claude Code session at "
            ".claude/session.md, rendered from the local transcript without a "
            "model call, plus a marker-delimited section of CLAUDE.md with the "
            "durable decisions and constraints."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  cswap checkpoint write                    # from the newest transcript for this directory
  cswap checkpoint write --account 2 --print
  cswap checkpoint start -m "finish the tests"
  cswap checkpoint start --account 2 -- --model opus   # args after -- go to claude
  cswap checkpoint show
        """,
    )
    sub = parser.add_subparsers(dest="command", metavar="write|start|show")

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument(
            "--account", metavar="NUM|EMAIL",
            help="Account whose profile holds the transcript (default: the current profile)",
        )
        p.add_argument("--session", dest="session_id", metavar="ID", help="Session id of the transcript")
        p.add_argument("--cwd", metavar="DIR", help="Project directory (default: the current one)")
        p.add_argument("--no-share", action="store_true", help="Run the account's session profile without shared settings")
        p.add_argument("--debug", action="store_true", help="Enable debug logging")

    w = sub.add_parser("write", help="Write .claude/session.md and the CLAUDE.md section")
    common(w)
    w.add_argument("--no-claude-md", action="store_true", help="Leave CLAUDE.md alone")
    w.add_argument(
        "--max-kb", type=int, default=DEFAULT_CHECKPOINT_BYTES // 1024, metavar="KB",
        help=f"Checkpoint size cap (default {DEFAULT_CHECKPOINT_BYTES // 1024})",
    )
    w.add_argument("--print", dest="print_only", action="store_true", help="Print the checkpoint instead of writing it")

    s = sub.add_parser("start", help="Write the checkpoint, then start claude told to read it")
    common(s)
    s.add_argument("-m", "--task", metavar="TASK", help=f"What to do after reading it (default: {DEFAULT_TASK})")
    s.add_argument("--no-write", action="store_true", help="Start without rewriting the checkpoint")
    s.add_argument("--no-claude-md", action="store_true", help="Leave CLAUDE.md alone")

    sh = sub.add_parser("show", help="Print the current .claude/session.md")
    sh.add_argument("--cwd", metavar="DIR", help="Project directory (default: the current one)")
    return parser


def main(
    argv: list[str],
    *,
    prog: str = "cswap checkpoint",
    manager_factory: Callable[[bool], SessionManager] | None = None,
) -> int:
    """``cswap checkpoint write|start|show``; returns the exit code.

    ``manager_factory(debug)`` builds the SessionManager when an account is
    named; the default builds the real one, tests pass a fake.
    """
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
    if claude_args and args.command != "start":
        parser.error("arguments after -- go to claude, which only `start` runs")
    if getattr(args, "max_kb", 1) < 1:
        parser.error("--max-kb must be at least 1")
    try:
        manager = None
        account = getattr(args, "account", None)
        if account:
            manager = (manager_factory or _default_manager)(bool(getattr(args, "debug", False)))
        checkpointer = Checkpointer(manager, Path(args.cwd) if args.cwd else None)
        if args.command == "show":
            sys.stdout.write(checkpointer.show())
            return 0
        plan = CheckpointPlan(
            account=account,
            session_id=args.session_id,
            cwd=Path(args.cwd) if args.cwd else None,
            claude_md=not args.no_claude_md,
            share=not args.no_share,
        )
        if args.command == "write":
            plan.max_bytes = args.max_kb * 1024
            if args.print_only:
                _, text, _ = checkpointer.build(plan)
                sys.stdout.write(text)
                return 0
            checkpointer.write(plan)
            return 0
        plan.task = args.task
        plan.write = not args.no_write
        plan.claude_args = claude_args
        return checkpointer.start(plan)
    except ClaudeSwitchError as e:
        error(f"Error: {e}")
        return 1
    except KeyboardInterrupt:
        print(f"\n{dimmed('Operation cancelled')}")
        return 130
