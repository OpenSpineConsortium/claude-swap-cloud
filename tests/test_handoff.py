"""Tests for teleport handoff notes (claude_swap.handoff)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from claude_swap import handoff
from claude_swap.handoff import (
    HANDOFF_DIR,
    HandoffContext,
    find_transcript,
    redact,
    render_handoff,
)

SID = "11111111-2222-3333-4444-555555555555"
SID_DEFAULT = SID


class Note:
    def __init__(self, text: str, redactions: int) -> None:
        self.text, self.redactions = text, redactions


def build(transcript, *, repo_dir=None, session_id=SID_DEFAULT, task=None, **kw) -> Note:
    text, n = render_handoff(
        HandoffContext(
            transcript=transcript, branch=kw.pop("branch", None),
            session_id=session_id, task=task, repo_dir=repo_dir, **kw,
        )
    )
    return Note(text, n)


class T:
    """Builds a transcript the way Claude Code writes one: a parentUuid chain."""

    def __init__(self) -> None:
        self.entries: list[dict] = []
        self.last: str | None = None
        self.n = 0

    def _add(self, entry: dict, parent: str | None = "__last__") -> str:
        self.n += 1
        uid = f"u{self.n}"
        entry.setdefault("uuid", uid)
        entry["parentUuid"] = self.last if parent == "__last__" else parent
        entry.setdefault("sessionId", SID)
        entry.setdefault("timestamp", f"2026-10-05T00:00:{self.n:02d}Z")
        entry.setdefault("gitBranch", "feature/x")
        entry.setdefault("isSidechain", False)
        self.entries.append(entry)
        self.last = uid
        return uid

    def user(self, text: str, **kw) -> str:
        return self._add({"type": "user", "message": {"role": "user", "content": text}, **kw})

    def tool_result(self, body: str) -> str:
        return self._add(
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": "t", "content": body}],
                },
            }
        )

    def claude(self, text: str = "", tools: list[dict] | None = None, **kw) -> str:
        content: list[dict] = [{"type": "thinking", "thinking": "private thoughts"}]
        if text:
            content.append({"type": "text", "text": text})
        for t in tools or []:
            content.append({"type": "tool_use", "id": "t", **t})
        return self._add(
            {"type": "assistant", "message": {"role": "assistant", "content": content}, **kw}
        )

    def raw(self, entry: dict) -> None:
        self.entries.append(entry)

    def write(self, path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(json.dumps(e) for e in self.entries) + "\n")
        return path


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    r = tmp_path / "repo"
    r.mkdir()
    run = lambda *a: subprocess.run(["git", "-C", str(r), *a], check=True, capture_output=True)
    run("init", "-q", "-b", "main")
    run("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base")
    run("checkout", "-q", "-b", "feature/x")
    run("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "add teleport")
    return r


def _note(tmp_path: Path, t: T, repo: Path, **kw):
    path = t.write(tmp_path / "profile" / "projects" / "-home-me-repo" / f"{SID}.jsonl")
    return build(path, repo_dir=repo, session_id=SID, **kw)


def test_basic_note_sections(tmp_path, repo):
    t = T()
    t.raw({"type": "ai-title", "aiTitle": "Fix the parser", "sessionId": SID})
    t.user("Please fix the JSON parser in parse.py")
    t.claude("Looking at it.", [{"name": "Read", "input": {"file_path": "parse.py"}}])
    t.tool_result("def parse(): ... SECRET_STUFF_IN_OUTPUT")
    t.claude("", [{"name": "Edit", "input": {"file_path": "/r/parse.py", "old_string": "a", "new_string": "b"}}])
    t.claude("", [{"name": "Write", "input": {"file_path": "/home/me/repo/src/new.py", "content": "x"}}], cwd="/home/me/repo")
    t.tool_result("ok")
    t.claude("", [{"name": "Bash", "input": {"command": "pytest tests/test_parse.py"}}])
    t.tool_result("1 passed")
    t.claude("Fixed the off-by-one; tests pass.")
    t.user("Now also handle empty input")
    t.claude("Empty input now returns None. Still need to update the docs.")

    note = _note(tmp_path, t, repo, task="Update the docs", source_email="a@example.com")
    text = note.text

    assert text.startswith("# Handoff from cloud session: Fix the parser")
    assert "account a@example.com" in text
    assert "branch `feature/x`" in text
    assert "## Task for this session\n\nUpdate the docs" in text
    assert "## Original request\n\n> Please fix the JSON parser in parse.py" in text
    assert "> Now also handle empty input" in text
    assert "## Where it stopped\n\n> Empty input now returns None." in text
    assert "- `/r/parse.py`" in text
    assert "- `src/new.py`" in text
    assert "parse.py`" in text and "- `parse.py`" not in text  # Read is not a touched file
    assert "- `pytest tests/test_parse.py`" in text
    assert "add teleport" in text
    assert f"git rm {HANDOFF_DIR.as_posix()}/{SID}.md" in text
    # Tool output and thinking never reach the note.
    assert "SECRET_STUFF_IN_OUTPUT" not in text
    assert "private thoughts" not in text


def test_harness_text_is_stripped(tmp_path, repo):
    t = T()
    t.user("<system-reminder>internal stuff</system-reminder>")
    t.user(
        '<session-context nonce="x">ctx</session-context>\nReal question here'
        "\n<system-reminder>more</system-reminder>"
    )
    t.claude("Answer.")
    text = _note(tmp_path, t, repo).text
    assert "internal stuff" not in text and "ctx" not in text and "more" not in text
    assert "> Real question here" in text


def test_project_wake_envelope_is_unwrapped(tmp_path, repo):
    t = T()
    t.user(
        '<wake reason="mention"><project id="p"><thread ts="x">'
        '<message trigger="true" from="human" id="m1">Ship it &amp; tell me</message>'
        "</thread></project><system-note>routing stuff</system-note></wake>"
    )
    t.claude("Shipped.")
    text = _note(tmp_path, t, repo).text
    assert "> Ship it & tell me" in text
    assert "routing stuff" not in text and "<wake" not in text


def test_only_active_branch_after_rewind(tmp_path, repo):
    t = T()
    root = t.user("Start the work")
    t.claude("Trying approach A")
    t.user("abandoned follow-up")
    t.claude("abandoned answer")
    t.last = root  # user rewound to after the first prompt
    t.claude("Trying approach B instead")
    t.user("kept follow-up")
    t.claude("kept answer")
    text = _note(tmp_path, t, repo).text
    assert "abandoned" not in text
    assert "kept follow-up" in text and "kept answer" in text


def test_sidechain_is_ignored(tmp_path, repo):
    t = T()
    t.user("Main prompt")
    main = t.last
    t.claude("subagent chatter", isSidechain=True)
    t.last = main
    t.claude("Main answer")
    text = _note(tmp_path, t, repo).text
    assert "subagent chatter" not in text
    assert "Main answer" in text


def test_compaction_summary_becomes_earlier_context(tmp_path, repo):
    t = T()
    t.user("old prompt before compaction")
    t.claude("old answer")
    t._add({"type": "system", "subtype": "compact_boundary", "content": "Conversation compacted"}, parent=None)
    t.user("This session is being continued. Summary: we built X.", isCompactSummary=True)
    t.user("Next step please")
    t.claude("Done with next step")
    text = _note(tmp_path, t, repo).text
    assert "## Earlier context\n\n> This session is being continued. Summary: we built X." in text
    assert "old prompt before compaction" not in text
    assert "> Next step please" in text


def test_size_cap_keeps_newest_turns(tmp_path, repo):
    t = T()
    t.user("original")
    for i in range(200):
        t.user(f"turn {i} " + "x" * 700)
        t.claude(f"reply {i} " + "y" * 700)
    note = _note(tmp_path, t, repo)
    assert len(note.text.encode()) <= handoff.DEFAULT_HANDOFF_BYTES
    assert "turn 199" in note.text
    assert "turn 0 " not in note.text
    assert "earlier turn(s) omitted" in note.text
    small = _note(tmp_path, t, repo, max_bytes=handoff.PROMPT_HANDOFF_BYTES)
    assert len(small.text.encode()) <= handoff.PROMPT_HANDOFF_BYTES


def test_size_cap_with_huge_fixed_sections(tmp_path, repo):
    t = T()
    t.user("o" * 50_000)
    t.claude("s" * 50_000)
    note = _note(tmp_path, t, repo, task="t" * 20_000, max_bytes=4096)
    assert len(note.text.encode()) <= 4096


@pytest.mark.parametrize(
    "secret",
    [
        "sk-ant-oat01-abcdefghijklmnop",
        "ghp_" + "a" * 36,
        "github_pat_" + "b" * 30,
        "AKIAABCDEFGHIJKLMNOP",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        "GITHUB_TOKEN=hunter2hunter2",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
    ],
)
def test_redaction(secret):
    out, n = redact(f"before {secret} after")
    assert n >= 1
    assert "[redacted" in out
    assert "hunter2" not in out and "MIIabc" not in out and "abcdefghijklmnop" not in out


def test_redaction_counted_in_note(tmp_path, repo):
    t = T()
    t.user("use key sk-ant-api03-zzzzzzzzzzzzzzzz to call it")
    t.claude("ok", [{"name": "Bash", "input": {"command": "export API_KEY=abcd1234 && run"}}])
    note = _note(tmp_path, t, repo)
    assert "zzzzzzzz" not in note.text and "abcd1234" not in note.text
    assert note.redactions >= 2


def test_missing_or_garbage_transcript(tmp_path, repo):
    note = build(None, repo_dir=repo, session_id=SID, task="Do it")
    assert "Do it" in note.text and "## Git" in note.text
    bad = tmp_path / "bad.jsonl"
    bad.write_text('not json\n[1,2]\n{"type":"unknown-future-thing"}\n\n')
    note = build(bad, repo_dir=repo, session_id=SID)
    assert "Continue the work described below." in note.text


def test_no_git_repo(tmp_path):
    note = build(None, repo_dir=tmp_path, session_id=SID)
    assert "No git information was available." in note.text


def test_find_transcript_by_session_id(tmp_path):
    t = T()
    t.user("hi")
    path = t.write(tmp_path / "profile" / "projects" / "-some-slug" / f"{SID}.jsonl")
    assert find_transcript(tmp_path / "profile", tmp_path, SID, None) == path


def test_note_names_the_transcript_when_session_id_unknown(tmp_path, repo):
    t = T()
    t.user("hi")
    path = t.write(tmp_path / "abc-123.jsonl")
    text = build(path, repo_dir=repo, session_id=None).text
    assert "`abc-123`" in text and f"{HANDOFF_DIR.as_posix()}/abc-123.md" in text


def test_branch_from_context_wins(tmp_path, repo):
    assert "branch `given`" in build(None, repo_dir=repo, branch="given").text


def test_summary_is_placed_first_and_redacted(tmp_path, repo):
    t = T()
    t.user("goal")
    t.claude("done")
    text = _note(tmp_path, t, repo, summary="We built X with sk-ant-abcdefghijklmnop").text
    assert text.index("## Summary by the previous session") < text.index("## Task for this session")
    assert "We built X" in text and "abcdefghijklmnop" not in text


def test_transcript_without_uuid_chain_uses_file_order(tmp_path, repo):
    path = tmp_path / "flat.jsonl"
    path.write_text(
        json.dumps({"type": "user", "message": {"content": "First goal"}}) + "\n"
        + json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "Did a thing"}]}}) + "\n"
        + json.dumps({"type": "user", "message": {"content": "Second ask"}}) + "\n"
        + json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "Final answer"}]}}) + "\n"
    )
    text = build(path, repo_dir=repo, session_id=SID).text
    assert "> First goal" in text and "> Second ask" in text and "> Final answer" in text


def test_in_prompt_note_has_no_file_wording(tmp_path, repo):
    note = build(None, repo_dir=repo, session_id=SID, in_repo=False)
    assert "git rm" not in note.text and "This note was written" in note.text


def test_deterministic(tmp_path, repo):
    t = T()
    t.user("same")
    t.claude("same answer")
    assert _note(tmp_path, t, repo).text == _note(tmp_path, t, repo).text


def test_redaction_counts_each_secret_once():
    text, count = redact("API_KEY=sk-ant-abcdefghijkl then ghp_" + "a" * 36 + " PASSWORD: hunter2")
    assert "sk-ant" not in text and "ghp_" not in text and "hunter2" not in text
    assert count == 3
    assert redact("nothing to see") == ("nothing to see", 0)
