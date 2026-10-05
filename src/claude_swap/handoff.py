"""Handoff notes: carry a session's context into a new cloud session as text.

``claude --cloud`` starts a fresh conversation, and Claude Code cannot move a
transcript between accounts, so ``cswap teleport`` writes what the next
session needs to know into its prompt. Everything here is pure (no Claude
install, no network) and works from the JSONL transcript Claude Code keeps
under ``<config dir>/projects/<cwd slug>/<session id>.jsonl``.

That transcript format is undocumented and changes between Claude Code
versions, so the parser ignores anything it does not recognize and an
unreadable transcript yields an empty note, never a failed teleport.
"""

from __future__ import annotations

import glob
import json
import re
from pathlib import Path

# Bounds the note so the --cloud prompt stays a reasonable size.
DEFAULT_HANDOFF_CHARS = 6000
# Per-message cap inside the note, so one long reply can't crowd out the rest.
_MESSAGE_CHARS = 600

# Harness text Claude Code injects into user turns; not what the user said.
_HARNESS_TAGS = re.compile(
    r"<(system-reminder|session-context|command-[\w-]+|local-command-[\w-]+)"
    r"\b[^>]*>.*?</\1>",
    re.DOTALL,
)

_SECRET_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_-]{8,}"),
    re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{16,}"),
    re.compile(
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
        re.DOTALL,
    ),
]
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))(\s*[=:]\s*)(?!\[redacted\])(\S+)"
)


# -- transcript ----------------------------------------------------------


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


def _message_text(content) -> str:
    """Visible text of a transcript message; tool calls and results are dropped."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = [
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        return "\n".join(p for p in parts if p).strip()
    return ""


def read_transcript(path: Path) -> list[tuple[str, str]]:
    """(role, text) pairs from a Claude Code JSONL transcript, oldest first."""
    messages: list[tuple[str, str]] = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return messages
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if (
            not isinstance(entry, dict)
            or entry.get("isMeta")
            or entry.get("isSidechain")  # subagent turns, not the conversation
        ):
            continue
        role = entry.get("type")
        if role not in ("user", "assistant"):
            continue
        message = entry.get("message")
        if not isinstance(message, dict):
            continue
        text = _message_text(message.get("content"))
        if role == "user":
            text = _HARNESS_TAGS.sub("", text).strip()
        if text:
            messages.append((role, text))
    return messages


def redact(text: str) -> tuple[str, int]:
    """Replace credential-shaped strings with ``[redacted]``; returns (text, count)."""
    count = 0
    for pattern in _SECRET_PATTERNS:
        text, n = pattern.subn("[redacted]", text)
        count += n
    text, n = _SECRET_ASSIGNMENT.subn(
        lambda m: f"{m.group(1)}{m.group(2)}[redacted]", text
    )
    return text, count + n


def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def build_handoff_note(
    messages: list[tuple[str, str]],
    *,
    branch: str | None,
    session_id: str | None,
    max_chars: int = DEFAULT_HANDOFF_CHARS,
) -> str:
    """A bounded handoff note: where the work is plus the latest conversation.

    The newest messages are kept when the budget runs out, since they say
    what was in progress; the first user message is kept too, since it
    usually states the goal.
    """
    header = ["## Handoff from a previous Claude Code session"]
    if session_id:
        header.append(f"Original cloud session: {session_id}")
    if branch:
        header.append(f"Branch: {branch}")
    head = "\n".join(header)
    if not messages:
        return head + "\n\n(No transcript was found to summarize.)"

    def render(role: str, text: str) -> str:
        label = "User" if role == "user" else "Claude"
        return f"**{label}:** {clip(text, _MESSAGE_CHARS)}"

    goal = render(*messages[0]) if messages[0][0] == "user" else None
    rest = messages[1:] if goal else messages
    budget = max_chars - len(head) - (len(goal) + 40 if goal else 0)
    kept: list[str] = []
    for role, text in reversed(rest):
        block = render(role, text)
        if budget - len(block) - 2 < 0:
            break
        kept.append(block)
        budget -= len(block) + 2
    kept.reverse()
    omitted = len(rest) - len(kept)

    sections = [head]
    if goal:
        sections.append("### Original request\n" + goal)
    recent = "### Conversation"
    if omitted:
        recent += f" (latest messages; {omitted} earlier omitted)"
    if kept:
        sections.append(recent + "\n" + "\n\n".join(kept))
    return "\n\n".join(sections)


