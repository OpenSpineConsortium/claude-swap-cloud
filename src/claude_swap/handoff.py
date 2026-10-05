"""Handoff notes for ``cswap teleport``.

``claude --cloud`` starts a brand-new conversation, so when a session moves
from account A to account B its context has to travel as text. This module
turns the teleported session's transcript (a JSONL file in A's profile) into a
short Markdown note that B's cloud session reads first.

The note is built deterministically — no model call — so the same transcript
always yields the same note and tests need no Claude install. The transcript
format is undocumented and changes between Claude Code versions, so every
reader here ignores unknown entry types and fields, and a missing or unreadable
transcript produces a note without a conversation rather than an error.
"""

from __future__ import annotations

import glob
import html
import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Hard cap for a committed note (roughly 3k tokens).
DEFAULT_HANDOFF_BYTES = 12 * 1024
# Tighter cap when the note rides on the --cloud command line.
PROMPT_HANDOFF_BYTES = 8 * 1024
HANDOFF_DIR = Path(".claude") / "handoff"
# Subject prefix of cswap's own note commits (see teleport._commit_note).
NOTE_COMMIT_PREFIX = "Add cswap handoff note"
# Prompt for the opt-in --summarize step, run as the source account.
SUMMARIZE_PROMPT = (
    "Write a handoff summary of this session for another engineer who will "
    "continue it in a fresh session: the goal, what was done, what is in "
    "progress, and the next steps. Plain Markdown, at most 3000 characters."
)
SUMMARY_CHARS = 3000

ORIGINAL_REQUEST_CHARS = 1500
EARLIER_CONTEXT_CHARS = 2000
WHERE_STOPPED_CHARS = 2000
TURN_CHARS = 800
TASK_CHARS = 2000
MAX_FILES = 40
MAX_COMMANDS = 10
COMMAND_CHARS = 200
MAX_COMMITS = 20

_FILE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}

# Harness-injected blocks that are not the person's words.
_HARNESS_TAGS = (
    "system-reminder",
    "session-context",
    "command-name",
    "command-message",
    "command-args",
    "local-command-stdout",
    "local-command-stderr",
    "local-command-caveat",
    "user-prompt-submit-hook",
    "coordinator-context",
)
_HARNESS_RE = re.compile(
    r"<(" + "|".join(_HARNESS_TAGS) + r")\b[^>]*>.*?</\1\b[^>]*>",
    re.DOTALL,
)

_REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
            re.DOTALL,
        ),
        "[redacted private key]",
    ),
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]{8,}"), "[redacted]"),
    (re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"), "[redacted]"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), "[redacted]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[redacted]"),
    (re.compile(r"(?i)\b(Bearer\s+)[A-Za-z0-9._~+/\-]{16,}=*"), r"\1[redacted]"),
    (
        re.compile(
            r"(?i)\b([A-Z0-9_]*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD)"
            r"[A-Z0-9_]*\s*[=:]\s*)(?!\[redacted)(['\"]?)[^\s'\"]{4,}\2"
        ),
        r"\1[redacted]",
    ),
)


@dataclass
class Turn:
    """One user prompt and the last thing Claude said in reply."""

    user: str
    claude: str = ""


@dataclass
class Extract:
    """What the note needs from a transcript, before rendering."""

    title: str | None = None
    last_activity: str | None = None
    branch: str | None = None
    earlier_context: str | None = None
    turns: list[Turn] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    commands: list[str] = field(default_factory=list)


@dataclass
class HandoffContext:
    """Everything ``render_handoff`` may use; built by ``cswap teleport``."""

    transcript: Path | None
    branch: str | None
    session_id: str | None
    task: str | None
    max_bytes: int = DEFAULT_HANDOFF_BYTES
    summary: str | None = None
    # Where to read git state from; None skips the commit list.
    repo_dir: Path | None = None
    source_email: str | None = None
    # False when the note rides in the prompt: no file wording, no `git rm` line.
    in_repo: bool = True


# --- reading -----------------------------------------------------------------


def project_slug(cwd: Path) -> str:
    """Claude Code's projects/ directory name for a working directory."""
    return re.sub(r"[^a-zA-Z0-9]", "-", str(cwd))


def find_transcript(
    config_dir: Path, cwd: Path, session_id: str | None, since: float | None
) -> Path | None:
    """Locate the teleported session's transcript in an account's profile.

    Prefers a file named after the session id anywhere under ``projects/``,
    then the newest transcript for ``cwd`` (written after ``since`` when
    given, so an older conversation in the same directory is not picked up).
    """
    projects = config_dir / "projects"
    if not projects.is_dir():
        return None
    if session_id:
        named = sorted(projects.glob(f"*/{glob.escape(session_id)}.jsonl"))
        if named:
            return named[0]
    project_dir = projects / project_slug(cwd)
    if not project_dir.is_dir():
        return None
    candidates = [
        p
        for p in project_dir.glob("*.jsonl")
        if since is None or p.stat().st_mtime >= since
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def load_transcript(path: Path) -> list[dict[str, Any]]:
    """Parse JSONL, skipping blank, malformed and non-object lines."""
    entries: list[dict[str, Any]] = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict):
                    entries.append(obj)
    except OSError:
        return []
    return entries


def read_transcript(path: Path) -> list[tuple[str, str]]:
    """(role, text) pairs on the transcript's active branch, oldest first."""
    pairs: list[tuple[str, str]] = []
    for t in extract(load_transcript(path)).turns:
        if t.user:
            pairs.append(("user", t.user))
        if t.claude:
            pairs.append(("assistant", t.claude))
    return pairs


def _is_message(e: dict[str, Any]) -> bool:
    return e.get("type") in ("user", "assistant") and isinstance(e.get("message"), dict)


def active_branch(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The main-thread messages on the branch that ends at the newest message.

    Rewinds and edits leave abandoned branches in the file; walking
    ``parentUuid`` back from the last appended message keeps only the live one.
    A compaction boundary has no parent, so the walk stops there and earlier
    turns are represented by the compaction summary instead.
    """
    by_uuid: dict[str, dict[str, Any]] = {}
    leaf: dict[str, Any] | None = None
    for e in entries:
        uid = e.get("uuid")
        if isinstance(uid, str):
            by_uuid[uid] = e
        if _is_message(e) and not e.get("isSidechain"):
            leaf = e
    if leaf is None:
        return []
    main = [e for e in entries if _is_message(e) and not e.get("isSidechain")]
    if not isinstance(leaf.get("uuid"), str):
        # No uuid chain to follow (hand-written or very old transcript).
        return main
    chain: list[dict[str, Any]] = []
    seen: set[str] = set()
    cur: dict[str, Any] | None = leaf
    while cur is not None:
        uid = cur.get("uuid")
        if isinstance(uid, str):
            if uid in seen:
                break
            seen.add(uid)
        chain.append(cur)
        parent = cur.get("parentUuid")
        cur = by_uuid.get(parent) if isinstance(parent, str) else None
    chain.reverse()
    return [e for e in chain if _is_message(e) and not e.get("isSidechain")]


# Sessions in claude.ai Projects wrap each person's message in a <wake>
# envelope of routing metadata; only the <message> bodies are their words.
_WAKE_RE = re.compile(r"<wake\b[^>]*>(.*?)</wake>", re.DOTALL)
_WAKE_MESSAGE_RE = re.compile(r"<message\b[^>]*>(.*?)</message>", re.DOTALL)


def _unwrap_wake(match: re.Match[str]) -> str:
    bodies = [html.unescape(b).strip() for b in _WAKE_MESSAGE_RE.findall(match.group(1))]
    return "\n\n".join(b for b in bodies if b)


def strip_harness(text: str) -> str:
    text = _WAKE_RE.sub(_unwrap_wake, text)
    return _HARNESS_RE.sub("", text).strip()


def _blocks(message: dict[str, Any]) -> list[dict[str, Any]]:
    content = message.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def _text_of(blocks: list[dict[str, Any]]) -> str:
    parts = [b.get("text", "") for b in blocks if b.get("type") == "text"]
    return "\n".join(p for p in parts if isinstance(p, str)).strip()


def extract(entries: list[dict[str, Any]]) -> Extract:
    out = Extract()
    for e in entries:
        if e.get("type") == "ai-title" and isinstance(e.get("aiTitle"), str):
            out.title = e["aiTitle"]
        elif e.get("type") == "summary" and isinstance(e.get("summary"), str):
            # Older Claude Code versions wrote compaction/title summaries here.
            out.earlier_context = e["summary"]

    files: list[str] = []
    commands: list[str] = []
    for e in active_branch(entries):
        msg = e["message"]
        blocks = _blocks(msg)
        if isinstance(e.get("timestamp"), str):
            out.last_activity = e["timestamp"]
        if isinstance(e.get("gitBranch"), str) and e["gitBranch"] not in ("", "HEAD"):
            out.branch = e["gitBranch"]

        if e["type"] == "user":
            text = strip_harness(_text_of(blocks))
            if e.get("isCompactSummary"):
                if text:
                    out.earlier_context = text
                continue
            if e.get("isMeta") or not text:
                continue  # tool results, harness-only messages, meta notes
            out.turns.append(Turn(user=text))
            continue

        # assistant
        text = _text_of(blocks)
        if text and out.turns:
            out.turns[-1].claude = text
        elif text:
            out.turns.append(Turn(user="", claude=text))
        for b in blocks:
            if b.get("type") != "tool_use":
                continue
            inp = b.get("input") if isinstance(b.get("input"), dict) else {}
            name = b.get("name")
            if name in _FILE_TOOLS:
                fp = inp.get("file_path") or inp.get("notebook_path")
                if isinstance(fp, str) and fp:
                    files.append(_relative(fp, e.get("cwd")))
            elif name == "Bash" and isinstance(inp.get("command"), str):
                commands.append(inp["command"])

    out.files = _dedupe_newest_first(files)[:MAX_FILES]
    out.commands = [_one_line(c) for c in commands[-MAX_COMMANDS:]]
    return out


def _relative(path: str, cwd: Any) -> str:
    """Show paths inside the session's cwd relative to it; the cloud clone lives elsewhere."""
    if isinstance(cwd, str) and cwd and path.startswith(cwd.rstrip("/") + "/"):
        return path[len(cwd.rstrip("/")) + 1 :]
    return path


def _one_line(command: str) -> str:
    """First line of a command, so heredocs and scripts don't flood the note."""
    lines = [ln for ln in command.strip().splitlines() if ln.strip()]
    first = " ".join(lines[0].split()) if lines else ""
    return clip(first + (" …" if len(lines) > 1 else ""), COMMAND_CHARS)


def _code(text: str) -> str:
    return f"`` {text} ``" if "`" in text else f"`{text}`"


def _dedupe_newest_first(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in reversed(items):
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


# --- git -----------------------------------------------------------------------


@dataclass
class GitState:
    branch: str | None = None
    base: str | None = None
    commits: list[str] = field(default_factory=list)


def _git(repo_dir: Path, *args: str) -> str | None:
    try:
        r = subprocess.run(
            ["git", "-C", str(repo_dir), *args],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def git_state(repo_dir: Path | None) -> GitState:
    state = GitState()
    if repo_dir is None:
        return state
    branch = _git(repo_dir, "rev-parse", "--abbrev-ref", "HEAD")
    if branch and branch != "HEAD":
        state.branch = branch
    for ref in ("origin/HEAD", "origin/main", "origin/master", "main", "master"):
        if _git(repo_dir, "rev-parse", "--verify", "--quiet", ref) is None:
            continue
        base = _git(repo_dir, "merge-base", "HEAD", ref)
        if base:
            state.base = ref
            log = _git(repo_dir, "log", "--oneline", f"-{MAX_COMMITS}", f"{base}..HEAD")
            # Leave out cswap's own note commits so a rerun renders the same note.
            state.commits = [
                c for c in (log.splitlines() if log else []) if NOTE_COMMIT_PREFIX not in c
            ]
            break
    return state


# --- rendering -----------------------------------------------------------------


def clip(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _quote(text: str) -> str:
    """Indent so headings inside a message can't break the note's structure."""
    return "\n".join("> " + line if line else ">" for line in text.splitlines())


def redact(text: str) -> tuple[str, int]:
    total = 0
    for pattern, repl in _REDACTIONS:
        text, n = pattern.subn(repl, text)
        total += n
    return text, total


def _size(text: str) -> int:
    return len(text.encode("utf-8"))


def render(
    ex: Extract,
    git: GitState,
    *,
    session_id: str,
    task: str | None = None,
    source_email: str | None = None,
    max_bytes: int = DEFAULT_HANDOFF_BYTES,
    in_repo: bool = True,
    summary: str | None = None,
    branch: str | None = None,
) -> str:
    """Lay the note out, fitting the conversation into what the budget leaves."""
    rel_path = (HANDOFF_DIR / handoff_filename(session_id, None)).as_posix()
    branch = branch or git.branch or ex.branch
    title = ex.title or session_id

    meta = [f"Teleported from cloud session `{session_id}`"]
    if source_email:
        meta.append(f"account {source_email}")
    if branch:
        meta.append(f"branch `{branch}`")
    if ex.last_activity:
        meta.append(f"last activity {ex.last_activity}")

    head = [
        f"# Handoff from cloud session: {title}",
        "",
        " · ".join(meta),
        "",
        ("This file" if in_repo else "This note")
        + " was written by cswap from the previous session's transcript. "
        "Tool output was left out and likely secrets were redacted.",
        "",
    ]
    if summary and summary.strip():
        head += [
            "## Summary by the previous session",
            "",
            clip(summary, SUMMARY_CHARS),
            "",
        ]
    head += [
        "## Task for this session",
        "",
        clip(task, TASK_CHARS) if task and task.strip() else "Continue the work described below.",
        "",
    ]

    first = ex.turns[0] if ex.turns and ex.turns[0].user else None
    last_claude = next((t.claude for t in reversed(ex.turns) if t.claude), "")

    def tail_sections(orig_chars: int, earlier_chars: int, stopped_chars: int) -> tuple[list[str], list[str]]:
        before: list[str] = []
        if first:
            before += ["## Original request", "", _quote(clip(first.user, orig_chars)), ""]
        if ex.earlier_context and earlier_chars > 0:
            before += [
                "## Earlier context",
                "",
                _quote(clip(ex.earlier_context, earlier_chars)),
                "",
            ]
        after: list[str] = []
        if last_claude:
            after += ["## Where it stopped", "", _quote(clip(last_claude, stopped_chars)), ""]
        if ex.files:
            after += ["## Files touched", ""] + [f"- {_code(f)}" for f in ex.files] + [""]
        if ex.commands:
            after += ["## Recent commands", ""] + [f"- {_code(c)}" for c in ex.commands] + [""]
        after += ["## Git", ""]
        if branch:
            after.append(f"Branch `{branch}`" + (f", commits since `{git.base}`:" if git.commits else "."))
        if git.commits:
            after += [f"- {c}" for c in git.commits]
        elif not branch:
            after.append("No git information was available.")
        if in_repo:
            after += [
                "",
                "---",
                f"After reading, remove this file (`git rm {rel_path}`) in your first commit.",
            ]
        after.append("")
        return before, after

    # Shrink the fixed sections in this order until they fit with room to spare:
    # earlier context, then the original request, then where it stopped.
    attempts = [
        (ORIGINAL_REQUEST_CHARS, EARLIER_CONTEXT_CHARS, WHERE_STOPPED_CHARS),
        (ORIGINAL_REQUEST_CHARS, 600, WHERE_STOPPED_CHARS),
        (500, 0, WHERE_STOPPED_CHARS),
        (300, 0, 800),
        (200, 0, 300),
    ]
    for orig, earlier, stopped in attempts:
        before, after = tail_sections(orig, earlier, stopped)
        fixed = "\n".join(head + before + after)
        if _size(fixed) <= max_bytes:
            break

    # Conversation: the turns between the first and the last-reply, newest kept.
    convo_turns = [
        t
        for t in (ex.turns[1:] if first else ex.turns)
        if t.user or (t.claude and t is not ex.turns[-1])
    ]
    budget = max_bytes - _size(fixed) - 200  # header + omission line headroom
    kept: list[str] = []
    used = 0
    for t in reversed(convo_turns):
        chunk_lines = []
        if t.user:
            chunk_lines.append("**User:**\n" + _quote(clip(t.user, TURN_CHARS)))
        if t.claude and t is not ex.turns[-1]:
            chunk_lines.append("**Claude:**\n" + _quote(clip(t.claude, TURN_CHARS)))
        if not chunk_lines:
            continue
        chunk = "\n\n".join(chunk_lines) + "\n"
        if used + _size(chunk) + 1 > budget:
            break
        kept.append(chunk)
        used += _size(chunk) + 1
    kept.reverse()

    convo: list[str] = []
    if not ex.turns and not ex.earlier_context:
        convo = ["No transcript of the previous session was found.", ""]
    if convo_turns:
        convo = ["## Conversation, most recent last", ""]
        omitted = len(convo_turns) - len(kept)
        if omitted > 0:
            convo += [f"_{omitted} earlier turn(s) omitted to fit the size limit._", ""]
        convo += kept

    text = "\n".join(head + before + convo + after)
    if _size(text) > max_bytes:
        # Pathological input (e.g. an enormous task or file list): hard cut.
        text = text.encode("utf-8")[: max_bytes - len("\n…\n".encode())].decode("utf-8", "ignore") + "\n…\n"
    return text


# --- entry point used by `cswap teleport` -----------------------------------


def handoff_filename(session_id: str | None, transcript: Path | None) -> str:
    """File name under ``.claude/handoff/`` for a session's note."""
    stem = session_id or (transcript.stem if transcript else None) or "handoff"
    return re.sub(r"[^A-Za-z0-9_.-]", "-", stem).strip(".-") + ".md"


def render_handoff(ctx: HandoffContext) -> tuple[str, int]:
    """The redacted Markdown note and how many strings were redacted."""
    ex = extract(load_transcript(ctx.transcript) if ctx.transcript else [])
    # Redact the inputs before rendering so the size budget is spent on what
    # actually ships; then redact the rendered text once more as a backstop.
    count = 0

    def scrub(s: str | None) -> str | None:
        nonlocal count
        if not s:
            return s
        s, n = redact(s)
        count += n
        return s

    ex.turns = [Turn(scrub(t.user) or "", scrub(t.claude) or "") for t in ex.turns]
    ex.earlier_context = scrub(ex.earlier_context)
    ex.commands = [scrub(c) or "" for c in ex.commands]
    session_id = Path(
        handoff_filename(ctx.session_id, ctx.transcript)
    ).stem
    text = render(
        ex,
        git_state(ctx.repo_dir),
        session_id=session_id,
        task=scrub(ctx.task),
        source_email=ctx.source_email,
        max_bytes=ctx.max_bytes,
        in_repo=ctx.in_repo,
        summary=scrub(ctx.summary),
        branch=ctx.branch,
    )
    text, n = redact(text)
    return text, count + n
