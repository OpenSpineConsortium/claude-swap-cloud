"""Tests for session checkpoints (claude_swap.checkpoint)."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from datetime import date
from pathlib import Path

import pytest

from claude_swap import checkpoint
from claude_swap.checkpoint import (
    CHECKPOINT_COMMIT_PREFIX,
    CHECKPOINT_PATH,
    CLAUDE_MD,
    DEFAULT_TASK,
    MARK_BEGIN,
    MARK_END,
    MAX_COMPLETED,
    START_PROMPT,
    Checkpoint,
    CheckpointError,
    CheckpointPlan,
    Checkpointer,
    checkpoint_files,
    commit_checkpoint,
    config_dir_for,
    extract_checkpoint,
    git_state,
    last_todos,
    locate_transcript,
    main,
    render_checkpoint,
    render_claude_md_section,
    repo_root,
    sentences,
    start_prompt,
    tagged_lines,
    transcript_sha256,
    update_claude_md,
    upsert_marked_section,
    working_tree_summary,
    write_checkpoint,
)
from claude_swap.exceptions import AccountNotFoundError, ValidationError
from claude_swap.handoff import GitState, load_transcript, project_slug

SID = "11111111-2222-3333-4444-555555555555"
FAKE_CLAUDE = "fake-claude"
SECTION = f"{MARK_BEGIN}\nA\n{MARK_END}"
SECTION2 = f"{MARK_BEGIN}\nB\nC\n{MARK_END}"


class T:
    """Builds a transcript the way Claude Code writes one: a parentUuid chain.

    Timestamps are in 2024 on purpose, so a test can tell a transcript
    timestamp from today's date.
    """

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
        n = self.n
        entry.setdefault("timestamp", f"2024-03-01T{10 + n // 3600:02d}:{(n // 60) % 60:02d}:{n % 60:02d}Z")
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

    def todo(self, items: list) -> str:
        return self.claude("", [{"name": "TodoWrite", "input": {"todos": items}}])

    def raw(self, entry: dict) -> None:
        self.entries.append(entry)

    def write(self, path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(json.dumps(e) for e in self.entries) + "\n", encoding="utf-8")
        return path


def _cp(t: T, **kw) -> Checkpoint:
    return extract_checkpoint(
        t.entries,
        session_id=kw.pop("session_id", SID),
        git=kw.pop("git", GitState()),
        transcript_sha=kw.pop("sha", "f" * 64),
        tree=kw.pop("tree", "clean"),
    )


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    r = tmp_path / "repo"
    r.mkdir()
    _git(r, "init", "-q", "-b", "main")
    _git(r, "config", "user.email", "t@example.com")
    _git(r, "config", "user.name", "T")
    _git(r, "config", "commit.gpgsign", "false")
    (r / "README").write_text("hi\n")
    _git(r, "add", "README")
    _git(r, "commit", "-q", "-m", "base")
    _git(r, "checkout", "-q", "-b", "feature/x")
    (r / "parse.py").write_text("def parse(): pass\n")
    _git(r, "add", "parse.py")
    _git(r, "commit", "-q", "-m", "add parser")
    return r


# Session profile directory names (slot number, then the slugified email) that
# session_dir_for derives for the fake accounts. The emails are short on
# purpose: the project slug repeats the whole repo path, and under xdist on
# Windows a transcript path can otherwise pass MAX_PATH.
PROFILES = {"1": "1-a_x.io", "2": "2-b_x.io"}


class FakeSwitcher:
    ACCOUNTS = {"1": ("a@x.io", "org-a"), "2": ("b@x.io", "org-b")}

    def __init__(self, backup_dir: Path):
        self.backup_dir = backup_dir
        # (email, org) of the active default login, as .claude.json would say.
        self.current: tuple[str, str] | None = None

    def resolve_account(self, identifier):
        for num, (email, org) in self.ACCOUNTS.items():
            if identifier in (num, email):
                return num, email, org
        raise AccountNotFoundError(identifier)

    def _get_current_account(self):
        return self.current


class FakeManager:
    def __init__(self, root: Path):
        self.switcher = FakeSwitcher(root)
        self.root = root
        self.launches: list[str] = []

    def profile(self, num: str) -> Path:
        return self.root / "sessions" / PROFILES[num]

    def launch_env(self, identifier, share=True, share_history=False, require_session=False):
        num, _, _ = self.switcher.resolve_account(identifier)
        self.launches.append(num)
        return FAKE_CLAUDE, {"CLAUDE_CONFIG_DIR": str(self.profile(num))}


class NoLaunchManager(FakeManager):
    """A manager whose launch_env must not run: a transcript lookup is read-only."""

    def launch_env(self, *args, **kwargs):
        raise AssertionError("launch_env ran for a read-only lookup")


def _fake_symlink(monkeypatch, link: Path, target: Path) -> None:
    """Make ``link`` look like a symlink to ``target`` to pathlib, so the
    symlink branches run where os.symlink needs a privilege (Windows without
    Developer Mode). Nothing exists at ``link`` itself."""
    real_is_symlink, real_resolve = Path.is_symlink, Path.resolve
    monkeypatch.setattr(Path, "is_symlink", lambda self: self == link or real_is_symlink(self))
    monkeypatch.setattr(
        Path,
        "resolve",
        lambda self, strict=False: real_resolve(target, strict) if self == link else real_resolve(self, strict),
    )


@pytest.fixture
def fake_claude(monkeypatch):
    """Intercept claude launches; everything else (git) runs for real."""
    calls: list[tuple[list[str], dict]] = []
    real_run = subprocess.run
    state = {"rc": 0, "raise": None}

    def fake_run(argv, *args, **kwargs):
        if argv[0] not in (FAKE_CLAUDE, "/usr/bin/claude"):
            return real_run(argv, *args, **kwargs)
        calls.append((argv, kwargs))
        if state["raise"]:
            raise state["raise"]
        return subprocess.CompletedProcess(argv, state["rc"])

    monkeypatch.setattr(checkpoint.subprocess, "run", fake_run)
    return calls, state


# ---------------------------------------------------------------------------
# reading
# ---------------------------------------------------------------------------


class TestSentences:
    def test_splits_strips_markers_and_clips(self):
        text = (
            "- [x] Added tests.  Then **bold** text!\n\n1. Fixed it? ## Heading\n"
            "> quoted line\n" + "x" * 300
        )
        out = sentences(text)
        assert out[:5] == ["Added tests.", "Then **bold** text!", "Fixed it?", "Heading", "quoted line"]
        assert out[5].startswith("x" * 100) and len(out[5]) <= 240
        assert len(out) == 6

    def test_drops_harness_tags_and_fenced_code(self):
        text = (
            "<system-reminder>ignore this</system-reminder>Real.\n"
            "```python\n# keep this secret\n```\nAfter.\n~~~\nmust not appear\n~~~\nEnd"
        )
        assert sentences(text) == ["Real.", "After.", "End"]

    def test_empty_inputs(self):
        assert sentences("") == []
        assert sentences(None) == []  # type: ignore[arg-type]
        assert sentences("   \n\n  ") == []


class TestTaggedLines:
    def test_every_tag_spelling_and_prefix(self):
        text = (
            "- Decision: use sqlite\n"
            "1. Constraint: never touch cookies\n"
            "> Blocker: CI is down\n"
            "TODO: write docs\n"
            "Next: run tests\n"
            "remaining : polish\n"
            "**Completed:** parser\n"
            "Done: tests\n"
            "Decision without colon\n"
            "Decision:\n"
            "We made a Decision: mid-line is not a tag\n"
        )
        assert tagged_lines(text) == {
            "decision": ["use sqlite"],
            "constraint": ["never touch cookies"],
            "blocker": ["CI is down"],
            "next": ["write docs", "run tests", "polish"],
            "done": ["parser", "tests"],
        }

    def test_harness_text_is_not_scanned(self):
        text = "<system-reminder>Decision: injected</system-reminder>\nDecision: real"
        assert tagged_lines(text)["decision"] == ["real"]

    def test_fenced_code_is_not_scanned(self):
        # A YAML key or a code comment is not a tag: the `#` would be stripped
        # as a heading marker and "done: true" would count as completed work.
        text = (
            "Decision: real\n"
            "```yaml\ndone: true\n# TODO: rotate the key\n# Decision: from a comment\n```\n"
            "~~~\nConstraint: in a tilde fence\n~~~\n"
            "Next: after the code"
        )
        found = tagged_lines(text)
        assert found["decision"] == ["real"] and found["next"] == ["after the code"]
        assert found["done"] == [] and found["constraint"] == [] and found["blocker"] == []


class TestLastTodos:
    def test_last_on_active_branch_with_validation(self):
        t = T()
        t.user("go")
        keep = t.last
        t.todo([{"content": "abandoned", "status": "pending"}])
        t.last = keep  # the person rewound; the next list is the live one
        t.todo(
            [
                {"content": " first  task ", "status": "COMPLETED"},
                {"content": "second", "status": "in_progress"},
                {"content": "", "status": "pending"},
                "garbage",
                {"status": "pending"},
                {"content": "no status"},
                {"content": "odd status", "status": 7},
            ]
        )
        assert last_todos(t.entries) == [
            {"content": "first task", "status": "completed"},
            {"content": "second", "status": "in_progress"},
            {"content": "no status", "status": "pending"},
            {"content": "odd status", "status": "pending"},
        ]

    def test_todos_that_are_not_a_list_are_ignored(self):
        t = T()
        t.user("go")
        t.claude("", [{"name": "TodoWrite", "input": {"todos": "nope"}}])
        t.claude("", [{"name": "TodoWrite", "input": "nope"}])
        assert last_todos(t.entries) == []
        assert last_todos([]) == []


class TestExtractSections:
    def test_completed_tagged_first_then_assistant_sentences_only(self):
        t = T()
        t.user("Please add the parser.\nAdded by me yesterday: nothing.")
        t.claude(
            "Added the parser in parse.py. I will add docs later. Fixed the off-by-one.\n"
            "- Done: wrote the migration"
        )
        cp = _cp(t)
        assert cp.completed == [
            "wrote the migration",
            "Added the parser in parse.py.",
            "Fixed the off-by-one.",
        ]

    def test_decisions_tagged_from_any_role_sentences_from_assistant(self):
        t = T()
        t.user("Decision: keep the CLI in one file\nI decided to ask you instead of guessing.")
        t.claude("We chose sqlite instead of postgres. Tests pass.")
        cp = _cp(t)
        assert cp.decisions == ["keep the CLI in one file", "We chose sqlite instead of postgres."]

    def test_remaining_todos_then_tags_then_sentences_either_role(self):
        t = T()
        t.user("Build it. There is still need for docs.")
        t.claude(
            "- [ ] checkbox item (ignored while the list has open items)\n"
            "Next: ship it\nThe docs are not yet written."
        )
        t.todo(
            [
                {"content": "write tests", "status": "completed"},
                {"content": "write docs", "status": "pending"},
                {"content": "polish", "status": "in_progress"},
            ]
        )
        cp = _cp(t)
        assert cp.tasks_done == ["write tests"]
        assert cp.remaining == [
            "write docs",
            "polish",
            "ship it",
            "There is still need for docs.",
            "The docs are not yet written.",
        ]

    def test_remaining_checkboxes_of_newest_message_when_no_open_todos(self):
        t = T()
        t.user("go")
        t.claude("Plan:\n- [ ] first\n- [x] done one\n* [ ] second")
        t.claude("Later message without boxes.")
        cp = _cp(t)
        assert cp.remaining[:2] == ["first", "second"]
        assert "done one" in cp.completed
        t.todo([{"content": "all done", "status": "completed"}])
        cp = _cp(t)
        assert cp.tasks_done == ["all done"] and cp.remaining[:2] == ["first", "second"]

    def test_blockers_from_the_last_ten_turns_tags_from_anywhere(self):
        t = T()
        t.user("Blocker: no staging access\nThe old build fails here.")
        t.claude("ok")
        for i in range(10):
            t.user(f"turn {i}")
            t.claude(f"reply {i}")
        t.user("CI is broken again.")
        t.claude("I cannot reach the registry.")
        cp = _cp(t)
        assert cp.blockers == ["no staging access", "CI is broken again.", "I cannot reach the registry."]

    def test_constraints_tagged_then_user_sentences_clipped(self):
        t = T()
        t.user("Never touch cookies. Only edit parse.py.\nAlways " + "k" * 300)
        t.claude("Constraint: ASCII only in browser files\nWe must never retry a challenged request.")
        cp = _cp(t)
        assert cp.constraints[:3] == ["ASCII only in browser files", "Never touch cookies.", "Only edit parse.py."]
        assert cp.constraints[3].startswith("Always kkk") and len(cp.constraints[3]) <= 200
        assert len(cp.constraints) == 4

    def test_dedupe_is_case_and_whitespace_insensitive(self):
        t = T()
        t.user("go")
        t.claude("Done: Added   the parser\nAdded the parser. ADDED THE PARSER.  Added the parser")
        assert _cp(t).completed == ["Added   the parser", "Added the parser."]

    def test_caps_never_cut_tagged_lines(self):
        tags = "\n".join(f"Done: tagged {i}" for i in range(25))
        sents = " ".join(f"Added thing {i}." for i in range(30))
        t = T()
        t.user("go")
        t.claude(tags + "\n" + sents)
        cp = _cp(t)
        assert len(cp.completed) == 25 and all(c.startswith("tagged") for c in cp.completed)
        t2 = T()
        t2.user("go")
        t2.claude(sents)
        assert len(_cp(t2).completed) == MAX_COMPLETED

    def test_header_fields_files_commits_and_quotes(self, repo):
        _git(repo, "commit", "-q", "--allow-empty", "-m", "second step")
        t = T()
        t.raw({"type": "ai-title", "aiTitle": "Fix the parser", "sessionId": SID})
        t.user("<system-reminder>x</system-reminder>Fix the JSON parser")
        t.claude("Looking.", [{"name": "Edit", "input": {"file_path": "/r/a.py"}}])
        t.tool_result("SECRET_STUFF_IN_OUTPUT")
        t.claude("", [{"name": "Write", "input": {"file_path": "/r/b.py", "content": "x"}}])
        t.claude("", [{"name": "Edit", "input": {"file_path": "/r/a.py"}}])
        t.user("meta", isMeta=True)
        t.claude("Final answer.")
        cp = _cp(t, git=git_state(repo), tree=working_tree_summary(repo))
        assert cp.title == "Fix the parser"
        assert cp.last_activity == "2024-03-01T10:00:07Z"
        assert cp.branch == "feature/x"
        assert cp.files == ["/r/a.py", "/r/b.py"]
        assert [c.split(" ", 1)[1] for c in cp.commits] == ["add parser", "second step"]
        assert cp.original_request == "Fix the JSON parser"
        assert cp.last_claude == "Final answer."
        assert cp.tree == "clean"
        text = render_checkpoint(cp)
        assert text.startswith("# Session checkpoint: Fix the parser\n")
        assert (
            f"Session `{SID}` | branch `feature/x` | last activity 2024-03-01T10:00:07Z | "
            "transcript sha256 ffffffffffff" in text
        )
        assert "- commit: " in text and "add parser" in text
        assert "- files touched: `/r/a.py`, `/r/b.py`" in text
        assert "Branch `feature/x`; working tree clean.\n> Final answer." in text
        assert "## Original request\n> Fix the JSON parser" in text
        assert "SECRET_STUFF_IN_OUTPUT" not in text and "private thoughts" not in text

    def test_sidechain_and_abandoned_branch_ignored(self):
        t = T()
        root = t.user("Start")
        t.claude("Decision: abandoned", isSidechain=True)
        t.last = root
        t.claude("Decision: abandoned too")
        t.last = root
        t.claude("Decision: kept")
        assert _cp(t).decisions == ["kept"]

    def test_garbage_unknown_and_non_text_entries(self, tmp_path):
        bad = tmp_path / "bad.jsonl"
        bad.write_text(
            'not json\n[1,2]\n{"type":"unknown-future-thing"}\n'
            '{"type":"user","message":{"content":[{"type":"image","source":{}}]}}\n'
            '{"type":"assistant","message":{"content":42}}\n'
            '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"only"}]}}\n'
            '{"type":"user","message":"not a dict"}\n\n',
            encoding="utf-8",
        )
        cp = extract_checkpoint(load_transcript(bad), session_id="s", git=GitState(), transcript_sha="", tree="unknown")
        assert cp.original_request == "" and cp.last_claude == "" and cp.completed == []
        text = render_checkpoint(cp)
        assert "(no transcript)" in text and "transcript sha256 unknown" in text
        assert extract_checkpoint([], session_id="s", git=GitState(), transcript_sha="", tree="") .tree == "unknown"

    def test_fenced_code_feeds_no_section_but_stays_in_the_quotes(self):
        t = T()
        t.user('Set it up.\n```json\n{"done": "true", "must": "never"}\n```')
        t.claude(
            "Here is the config:\n"
            "```yaml\ndone: true\n# TODO: rotate the key\n- [ ] boxed in code\n"
            "# Decision: use yaml\n# Constraint: keep this\n```\n"
            "Added the loader."
        )
        cp = _cp(t)
        assert cp.completed == ["Added the loader."]
        assert cp.remaining == [] and cp.decisions == [] and cp.constraints == [] and cp.blockers == []
        # The quotes keep the code; only the scans leave it out.
        assert "rotate the key" in cp.last_claude and '"done": "true"' in cp.original_request

    def test_compaction_summary_and_tool_results_are_not_the_request(self):
        t = T()
        t.user("This session is being continued. Decision: from the summary", isCompactSummary=True)
        t.tool_result("tool output Decision: nope")
        t.user("Real request")
        t.claude("ok")
        cp = _cp(t)
        assert cp.original_request == "Real request" and cp.decisions == []


# ---------------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------------


class TestRender:
    def test_every_section_present_when_empty(self):
        text = render_checkpoint(Checkpoint())
        for heading in (
            "## Completed work",
            "## Current implementation state",
            "## Architectural decisions",
            "## Remaining tasks",
            "## Known blockers",
            "## Important constraints",
            "## Original request",
        ):
            assert heading in text
        assert text.count("- (none recorded)") == 5
        assert "(no transcript)" in text and "> (none recorded)" in text
        assert text.endswith("tells claude to read this file first.\n")
        assert "Branch unknown; working tree unknown." in text

    def test_lists_render_in_their_shapes(self):
        cp = Checkpoint(
            session_id="s",
            commits=["abc base", "def next"],
            tasks_done=["t1"],
            completed=["Added x."],
            files=["a.py", "b`c.py"],
            decisions=["d1"],
            remaining=["r1"],
            blockers=["b1"],
            constraints=["c1"],
            tree="1 modified, 2 untracked",
            branch="feat",
        )
        text = render_checkpoint(cp)
        assert "## Completed work\n- commit: abc base\n- commit: def next\n- task done: t1\n- Added x.\n- files touched: `a.py`, `` b`c.py ``\n" in text
        assert "Branch `feat`; working tree 1 modified, 2 untracked." in text
        assert "## Architectural decisions\n- d1\n" in text
        assert "## Remaining tasks\n- [ ] r1\n" in text
        assert "## Known blockers\n- b1\n" in text
        assert "## Important constraints\n- c1\n" in text

    def test_size_cap_trim_order(self):
        # Every item is longer than the "- (none recorded)" placeholder that
        # replaces an emptied list, so each trim step makes the text smaller
        # and the order of steps shows in what survives at each cap.
        cp = Checkpoint(
            session_id="s",
            files=[f"f{i}.py" for i in range(40)],
            completed=[f"Added item number {i} of the work" for i in range(20)],
            remaining=[f"remaining item number {i} of the plan" for i in range(20)],
            blockers=[f"blocker item number {i} of the run" for i in range(10)],
            decisions=[f"decision item number {i} of the design" for i in range(15)],
            constraints=[f"constraint item number {i} of the brief" for i in range(20)],
            # Z and Q occur nowhere in the fixed text, so counting them
            # measures the two quotes exactly.
            last_claude="Z" * 1500,
            original_request="Q" * 1500,
        )
        size = lambda c: len(render_checkpoint(c, max_bytes=10**6).encode())
        n = lambda text, prefix: text.count(prefix)

        text = render_checkpoint(cp, max_bytes=size(cp) - 1)
        assert n(text, ".py`") < 40 and n(text, "- Added item") == 20

        no_files = Checkpoint(**{**cp.__dict__, "files": []})
        text = render_checkpoint(cp, max_bytes=size(no_files) - 1)
        assert n(text, ".py`") == 0 and n(text, "- Added item") < 20 and n(text, "- [ ] remaining item") == 20
        assert n(text, "Z") == 1500

        no_completed = Checkpoint(**{**no_files.__dict__, "completed": []})
        text = render_checkpoint(cp, max_bytes=size(no_completed) - 1)
        assert n(text, "- Added item") == 0 and n(text, "Z") == 499 and n(text, "Q") == 1500

        short_state = Checkpoint(**{**no_completed.__dict__, "last_claude": "Z" * 499})
        text = render_checkpoint(cp, max_bytes=size(short_state) - 1)
        assert n(text, "Q") == 499 and n(text, "- [ ] remaining item") == 20

        short_both = Checkpoint(**{**short_state.__dict__, "original_request": "Q" * 499})
        text = render_checkpoint(cp, max_bytes=size(short_both) - 1)
        assert n(text, "- [ ] remaining item") < 20 and n(text, "- blocker item") == 10

        no_remaining = Checkpoint(**{**short_both.__dict__, "remaining": []})
        text = render_checkpoint(cp, max_bytes=size(no_remaining) - 1)
        assert n(text, "- blocker item") < 10 and n(text, "- decision item") == 15

        no_blockers = Checkpoint(**{**no_remaining.__dict__, "blockers": []})
        text = render_checkpoint(cp, max_bytes=size(no_blockers) - 1)
        assert n(text, "- decision item") < 15 and n(text, "- constraint item") == 20

        no_decisions = Checkpoint(**{**no_blockers.__dict__, "decisions": []})
        text = render_checkpoint(cp, max_bytes=size(no_decisions) - 1)
        assert n(text, "- constraint item") < 20

        for cap in (size(cp) - 1, 4096, 2048, 900):
            assert len(render_checkpoint(cp, max_bytes=cap).encode()) <= cap
        hard = render_checkpoint(Checkpoint(commits=["c" * 500] * 50), max_bytes=900)
        assert len(hard.encode()) <= 900 and hard.endswith("\n...\n")
        with pytest.raises(ValidationError):
            render_checkpoint(cp, max_bytes=0)

    def test_two_runs_identical_and_no_wall_clock(self):
        t = T()
        t.user("go")
        t.claude("Added x.")
        a = render_checkpoint(_cp(t))
        b = render_checkpoint(_cp(t))
        assert a == b
        assert re.findall(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", a) == ["2024-03-01T10:00:02Z"]
        assert date.today().isoformat() not in a
        assert render_claude_md_section(_cp(t)) == render_claude_md_section(_cp(t))

    def test_secrets_redacted_and_counted(self):
        t = T()
        t.user(
            "use key sk-ant-api03-zzzzzzzzzzzzzzzz please\n"
            "Constraint: send Authorization: Bearer abcdefghijklmnopqrstuvwxyz always"
        )
        t.claude("Done: stored GITHUB_TOKEN=hunter2hunter2 in env")
        cp = _cp(t)
        text = render_checkpoint(cp)
        section = render_claude_md_section(cp)
        assert cp.redactions >= 3
        for secret in ("zzzzzzzz", "abcdefghijklmnopqrstuvwxyz", "hunter2"):
            assert secret not in text and secret not in section
        assert "[redacted]" in text and "[redacted]" in section

    def test_render_redacts_a_hand_built_checkpoint(self):
        cp = Checkpoint(
            session_id="sk-ant-abcdefghijklmnop",
            title="PASSWORD: hunter2hunter2",
            decisions=["key sk-ant-abcdefghijklmnop"],
            constraints=["token ghp_" + "a" * 36],
            original_request="-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
            last_claude="AKIAABCDEFGHIJKLMNOP",
        )
        text = render_checkpoint(cp)
        section = render_claude_md_section(cp)
        for secret in ("abcdefghijklmnop", "hunter2", "a" * 36, "MIIabc", "AKIAABCDEFGHIJKLMNOP"):
            assert secret not in text and secret not in section

    def test_claude_md_section_shape_and_marker_safety(self):
        cp = Checkpoint(decisions=[f"evil {MARK_END} more"], constraints=["c1"])
        section = render_claude_md_section(cp)
        assert section.startswith(MARK_BEGIN + "\n## Session checkpoint (kept by cswap)\n\n")
        assert section.endswith("\n### Durable decisions\n- evil [marker] more\n### Constraints\n- c1\n" + MARK_END)
        assert section.count(MARK_END) == 1 and section.count(MARK_BEGIN) == 1
        once = upsert_marked_section("x\n", section)
        assert upsert_marked_section(once, section) == once
        assert "- (none recorded)" in render_claude_md_section(Checkpoint())


class TestUpsert:
    def test_missing_or_empty_file(self):
        assert upsert_marked_section(None, SECTION) == SECTION + "\n"
        assert upsert_marked_section("", SECTION) == SECTION + "\n"

    @pytest.mark.parametrize("existing", ["# Title\nbody\n", "# Title\nbody", "# Title\nbody\n\n"])
    def test_appends_after_exactly_one_blank_line(self, existing):
        assert upsert_marked_section(existing, SECTION) == "# Title\nbody\n\n" + SECTION + "\n"

    def test_replaces_first_pair_in_place_and_leaves_the_rest(self):
        existing = "before\n" + SECTION + "\nafter\n" + SECTION + "\n"
        assert upsert_marked_section(existing, SECTION2) == "before\n" + SECTION2 + "\nafter\n" + SECTION + "\n"

    def test_markers_at_end_without_trailing_newline(self):
        assert upsert_marked_section("before\n" + SECTION, SECTION2) == "before\n" + SECTION2

    def test_crlf_is_preserved(self):
        out = upsert_marked_section("# T\r\nbody\r\n", SECTION)
        assert out == "# T\r\nbody\r\n\r\n" + SECTION.replace("\n", "\r\n") + "\r\n"
        assert "\n" not in out.replace("\r\n", "")
        again = upsert_marked_section(out, SECTION2)
        assert again == "# T\r\nbody\r\n\r\n" + SECTION2.replace("\n", "\r\n") + "\r\n"

    @pytest.mark.parametrize(
        "bad",
        [
            "x\n" + MARK_BEGIN + "\n",
            "x\n" + MARK_END + "\n",
            MARK_END + "\nx\n" + MARK_BEGIN + "\n",
        ],
    )
    def test_unpaired_markers_are_refused(self, bad):
        with pytest.raises(ValidationError, match="unpaired"):
            upsert_marked_section(bad, SECTION)

    def test_idempotent(self):
        once = upsert_marked_section("a\n", SECTION)
        assert upsert_marked_section(once, SECTION) == once


class TestFiles:
    def test_write_checkpoint_is_atomic_and_idempotent(self, tmp_path):
        path, changed = write_checkpoint(tmp_path, "hello")
        assert changed and path == tmp_path / CHECKPOINT_PATH
        assert path.read_bytes() == b"hello\n"
        os.utime(path, (1000, 1000))
        assert write_checkpoint(tmp_path, "hello\n") == (path, False)
        assert path.stat().st_mtime == 1000
        assert write_checkpoint(tmp_path, "other\n") == (path, True)
        assert not list(path.parent.glob("*.tmp"))

    def test_update_claude_md_creates_preserves_bytes_and_is_idempotent(self, tmp_path):
        path, changed = update_claude_md(tmp_path, SECTION)
        assert changed and path == tmp_path / CLAUDE_MD and path.read_bytes() == (SECTION + "\n").encode()
        path.write_bytes(b"# Mine\r\n\xff\xfe raw bytes\r\n")
        assert update_claude_md(tmp_path, SECTION)[1] is True
        data = path.read_bytes()
        assert data.startswith(b"# Mine\r\n\xff\xfe raw bytes\r\n\r\n" + MARK_BEGIN.encode() + b"\r\n")
        assert data.endswith(MARK_END.encode() + b"\r\n")
        os.utime(path, (1000, 1000))
        assert update_claude_md(tmp_path, SECTION)[1] is False
        assert path.stat().st_mtime == 1000

    def test_update_claude_md_follows_a_symlink(self, tmp_path, needs_symlinks):
        # CLAUDE.md -> AGENTS.md: the section lands in AGENTS.md and the link
        # stays a link (a rename onto it would make it a regular file).
        target = tmp_path / "AGENTS.md"
        target.write_text("# Agents\n", encoding="utf-8")
        link = tmp_path / CLAUDE_MD
        link.symlink_to(target)
        path, changed = update_claude_md(tmp_path, SECTION)
        assert changed and path == link
        assert link.is_symlink()
        assert target.read_text(encoding="utf-8") == "# Agents\n\n" + SECTION + "\n"
        assert update_claude_md(tmp_path, SECTION)[1] is False

    def test_update_claude_md_follows_an_emulated_symlink(self, tmp_path, monkeypatch):
        """The same with the link faked on pathlib, so the branch runs here too."""
        target = tmp_path / "AGENTS.md"
        target.write_text("# Agents\n", encoding="utf-8")
        _fake_symlink(monkeypatch, tmp_path / CLAUDE_MD, target)
        path, changed = update_claude_md(tmp_path, SECTION)
        assert changed and path == tmp_path / CLAUDE_MD
        assert not (tmp_path / CLAUDE_MD).exists()  # nothing was written at the link's own path
        assert target.read_text(encoding="utf-8") == "# Agents\n\n" + SECTION + "\n"
        assert update_claude_md(tmp_path, SECTION)[1] is False

    def test_update_claude_md_refuses_an_unpaired_marker(self, tmp_path):
        (tmp_path / CLAUDE_MD).write_text("x\n" + MARK_BEGIN + "\n")
        with pytest.raises(ValidationError, match="unpaired"):
            update_claude_md(tmp_path, SECTION)

    def test_write_errors_are_plain(self, tmp_path):
        (tmp_path / CHECKPOINT_PATH).mkdir(parents=True)
        with pytest.raises(CheckpointError, match="Could not write"):
            write_checkpoint(tmp_path, "x")
        (tmp_path / CLAUDE_MD).mkdir()
        with pytest.raises(CheckpointError, match="Could not read"):
            update_claude_md(tmp_path, SECTION)

    def test_checkpoint_files_and_prompt(self):
        assert checkpoint_files() == [Path(".claude") / "session.md", Path("CLAUDE.md")]
        assert start_prompt(None) == START_PROMPT + DEFAULT_TASK
        assert start_prompt("  ") == START_PROMPT + DEFAULT_TASK
        assert start_prompt("finish the tests") == START_PROMPT + "finish the tests"

    def test_transcript_sha256(self, tmp_path):
        assert transcript_sha256(None) == ""
        assert transcript_sha256(tmp_path / "missing.jsonl") == ""
        p = tmp_path / "t.jsonl"
        p.write_bytes(b"abc" * 70000)
        assert transcript_sha256(p) == hashlib.sha256(b"abc" * 70000).hexdigest()


# ---------------------------------------------------------------------------
# git
# ---------------------------------------------------------------------------


class TestGit:
    def test_working_tree_summary(self, repo, tmp_path):
        assert working_tree_summary(repo) == "clean"
        (repo / "README").write_text("changed\n")
        (repo / "new.txt").write_text("n\n")
        (repo / ".claude").mkdir()
        (repo / ".claude" / "session.md").write_text("x")
        (repo / CLAUDE_MD).write_text("y")
        assert working_tree_summary(repo) == "1 modified, 1 untracked"
        assert working_tree_summary(None) == "unknown"
        plain = tmp_path / "plain"
        plain.mkdir()
        assert working_tree_summary(plain) == "unknown"

    def test_git_state_filters_cswap_commits_and_repo_root(self, repo, tmp_path):
        _git(repo, "commit", "-q", "--allow-empty", "-m", f"{CHECKPOINT_COMMIT_PREFIX} abc")
        _git(repo, "commit", "-q", "--allow-empty", "-m", "Add cswap handoff note x.md")
        _git(repo, "commit", "-q", "--allow-empty", "-m", "real work")
        st = git_state(repo)
        assert st.branch == "feature/x"
        assert [c.split(" ", 1)[1] for c in st.commits] == ["real work", "add parser"]
        assert git_state(None).commits == []
        sub = repo / "sub"
        sub.mkdir()
        assert repo_root(sub).resolve() == repo.resolve()
        plain = tmp_path / "plain"
        plain.mkdir()
        assert repo_root(plain) == plain

    def test_commit_checkpoint(self, repo):
        assert commit_checkpoint(repo, "s") is False
        write_checkpoint(repo, "cp")
        update_claude_md(repo, SECTION)
        (repo / ".gitignore").write_text(".claude/\n")
        assert commit_checkpoint(repo, "  my   session ") is True
        assert _git(repo, "log", "-1", "--format=%s") == f"{CHECKPOINT_COMMIT_PREFIX} my session"
        shown = _git(repo, "show", "--name-only", "--format=", "HEAD")
        assert ".claude/session.md" in shown and "CLAUDE.md" in shown
        assert _git(repo, "status", "--porcelain") == "?? .gitignore"
        assert commit_checkpoint(repo, "s") is False
        assert not any(CHECKPOINT_COMMIT_PREFIX in c for c in git_state(repo).commits)
        write_checkpoint(repo, "cp2")
        assert commit_checkpoint(repo, "") is True
        assert _git(repo, "log", "-1", "--format=%s") == f"{CHECKPOINT_COMMIT_PREFIX} session"

    def test_commit_checkpoint_outside_git(self, tmp_path):
        write_checkpoint(tmp_path, "cp")
        with pytest.raises(CheckpointError, match="git add failed"):
            commit_checkpoint(tmp_path, "s")

    def _agents_md_repo(self, repo: Path) -> None:
        (repo / "AGENTS.md").write_text("# Agents\n", encoding="utf-8")
        _git(repo, "add", "AGENTS.md")
        _git(repo, "commit", "-q", "-m", "agents")

    def _assert_target_is_tracked(self, repo: Path) -> None:
        # The write landed on AGENTS.md, so the tree summary must not count
        # it (a rerun would otherwise see "1 modified") and the checkpoint
        # commit must carry it.
        write_checkpoint(repo, "cp")
        update_claude_md(repo, SECTION)
        assert (repo / "AGENTS.md").read_text(encoding="utf-8").endswith(SECTION + "\n")
        assert working_tree_summary(repo) == "clean"
        assert commit_checkpoint(repo, "s") is True
        shown = _git(repo, "show", "--name-only", "--format=", "HEAD").splitlines()
        assert ".claude/session.md" in shown and "AGENTS.md" in shown
        assert _git(repo, "status", "--porcelain") == ""
        assert commit_checkpoint(repo, "s") is False

    def test_symlinked_claude_md_is_tracked_at_its_target(self, repo, needs_symlinks):
        self._agents_md_repo(repo)
        (repo / CLAUDE_MD).symlink_to(Path("AGENTS.md"))
        _git(repo, "add", CLAUDE_MD)
        _git(repo, "commit", "-q", "-m", "link")
        self._assert_target_is_tracked(repo)
        assert (repo / CLAUDE_MD).is_symlink()

    def test_emulated_symlinked_claude_md_is_tracked_at_its_target(self, repo, monkeypatch):
        self._agents_md_repo(repo)
        _fake_symlink(monkeypatch, repo / CLAUDE_MD, repo / "AGENTS.md")
        self._assert_target_is_tracked(repo)
        assert not (repo / CLAUDE_MD).exists()

    def test_symlink_target_outside_the_repo_is_left_to_git(self, repo, tmp_path, monkeypatch):
        outside = tmp_path / "elsewhere" / "AGENTS.md"
        outside.parent.mkdir()
        outside.write_text("# Agents\n", encoding="utf-8")
        _fake_symlink(monkeypatch, repo / CLAUDE_MD, outside)
        update_claude_md(repo, SECTION)
        assert outside.read_text(encoding="utf-8").endswith(SECTION + "\n")
        assert checkpoint._tracked_checkpoint_paths(repo) == [".claude/session.md", "CLAUDE.md"]
        assert working_tree_summary(repo) == "clean"


# ---------------------------------------------------------------------------
# locating the transcript
# ---------------------------------------------------------------------------


class TestLocate:
    def test_config_dir_for(self, tmp_path, monkeypatch):
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cfg"))
        assert config_dir_for(None, None) == tmp_path / "cfg"
        monkeypatch.delenv("CLAUDE_CONFIG_DIR")
        assert config_dir_for(None, "") == Path.home() / ".claude"
        with pytest.raises(CheckpointError, match="no account registry"):
            config_dir_for(None, "2")

    def test_config_dir_for_is_read_only(self, tmp_path, monkeypatch):
        # The session profile is worked out without launch_env: no profile is
        # bootstrapped, no credential refreshed, nothing printed, and an
        # API-key account (which launch_env refuses) can still be read.
        monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
        manager = NoLaunchManager(tmp_path)
        assert config_dir_for(manager, "2") == tmp_path / "sessions" / "2-b_x.io"
        assert config_dir_for(manager, "b@x.io", share=False) == tmp_path / "sessions" / "2-b_x.io"
        assert manager.launches == [] and not (tmp_path / "sessions").exists()
        with pytest.raises(AccountNotFoundError):
            config_dir_for(manager, "9")
        # The active default login runs plain claude, so its transcripts are
        # in the default profile; a preset CLAUDE_CONFIG_DIR disables that
        # fast path exactly as launch_env does.
        manager.switcher.current = ("b@x.io", "org-b")
        assert config_dir_for(manager, "2") == Path.home() / ".claude"
        assert config_dir_for(manager, "1") == tmp_path / "sessions" / "1-a_x.io"
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cfg"))
        assert config_dir_for(manager, "2") == tmp_path / "sessions" / "2-b_x.io"

    def test_locate_tries_root(self, tmp_path, repo):
        cfg = tmp_path / "cfg"
        t = T()
        t.user("hi")
        path = t.write(cfg / "projects" / project_slug(repo.resolve()) / "abc.jsonl")
        sub = repo / "sub"
        sub.mkdir()
        assert locate_transcript(cfg, sub, None) == path
        assert locate_transcript(cfg, sub, "abc") == path
        assert locate_transcript(cfg, tmp_path, None) is None
        assert locate_transcript(tmp_path / "nowhere", repo, None) is None

    def test_a_named_session_is_never_another_transcript(self, tmp_path, repo):
        cfg = tmp_path / "cfg"
        t = T()
        t.user("Other session's request")
        other = t.write(cfg / "projects" / project_slug(repo.resolve()) / "other.jsonl")
        assert locate_transcript(cfg, repo, "other") == other
        # find_transcript falls back to the newest transcript for the
        # directory; a typo or another account's id must not become this one.
        assert locate_transcript(cfg, repo, "does-not-exist") is None
        assert locate_transcript(cfg, repo / "sub", "does-not-exist") is None


# ---------------------------------------------------------------------------
# orchestration
# ---------------------------------------------------------------------------


def _profile_transcript(root: Path, repo: Path, t: T, name: str = "s1", num: str = "2") -> Path:
    return t.write(FakeManager(root).profile(num) / "projects" / project_slug(repo.resolve()) / f"{name}.jsonl")


class TestCheckpointer:
    def test_write_end_to_end(self, tmp_path, repo, capsys):
        manager = FakeManager(tmp_path)
        t = T()
        t.raw({"type": "ai-title", "aiTitle": "Fix the parser", "sessionId": SID})
        t.user("Fix the parser. Never touch cookies.")
        t.claude("Added the parser.\nDecision: keep one file", [{"name": "Edit", "input": {"file_path": "/r/parse.py"}}])
        t.todo([{"content": "write docs", "status": "pending"}])
        path = _profile_transcript(tmp_path, repo, t)
        (repo / CLAUDE_MD).write_text("# Project rules\n\nBe kind.\n")

        result = Checkpointer(manager, cwd=repo).write(CheckpointPlan(account="2", session_id="s1"))
        assert result.changed and result.transcript == path and result.redactions == 0
        assert result.checkpoint == repo / CHECKPOINT_PATH and result.claude_md == repo / CLAUDE_MD
        text = (repo / CHECKPOINT_PATH).read_text(encoding="utf-8")
        assert text.startswith("# Session checkpoint: Fix the parser\n")
        assert "branch `feature/x`" in text and "working tree clean" in text
        assert "- [ ] write docs" in text and "- Added the parser." in text
        md = (repo / CLAUDE_MD).read_text(encoding="utf-8")
        assert md.startswith("# Project rules\n\nBe kind.\n\n" + MARK_BEGIN)
        assert "- keep one file" in md and "- Never touch cookies." in md
        out = capsys.readouterr().out
        assert "Wrote .claude/session.md" in out and "Updated the cswap section of CLAUDE.md" in out
        assert f"Checkpoint built from {path}" in out

        again = Checkpointer(manager, cwd=repo).write(CheckpointPlan(account="2", session_id="s1"))
        assert not again.changed
        out = capsys.readouterr().out
        assert ".claude/session.md is unchanged." in out and "CLAUDE.md is unchanged." in out

    def test_write_without_transcript_warns_and_still_writes(self, tmp_path, repo, capsys):
        result = Checkpointer(FakeManager(tmp_path), cwd=repo).write(CheckpointPlan(account="2"))
        assert result.transcript is None and result.changed
        assert "No local transcript" in capsys.readouterr().out
        text = (repo / CHECKPOINT_PATH).read_text(encoding="utf-8")
        assert "(no transcript)" in text and "Session `unknown`" in text and "branch `feature/x`" in text

    def test_a_missing_session_id_is_not_another_transcript(self, tmp_path, repo, capsys):
        t = T()
        t.user("Other session's request")
        _profile_transcript(tmp_path, repo, t, name="other")
        result = Checkpointer(FakeManager(tmp_path), cwd=repo).write(
            CheckpointPlan(account="2", session_id="does-not-exist")
        )
        assert result.transcript is None
        assert "No local transcript named 'does-not-exist'" in capsys.readouterr().out
        text = (repo / CHECKPOINT_PATH).read_text(encoding="utf-8")
        assert "Session `unknown`" in text and "does-not-exist" not in text
        assert "Other session's request" not in text and "(no transcript)" in text

    def test_no_claude_md_and_explicit_transcript(self, tmp_path, repo):
        t = T()
        t.user("Original")
        t.claude("Done: it")
        path = t.write(tmp_path / "elsewhere" / "abc-123.jsonl")
        manager = FakeManager(tmp_path)
        result = Checkpointer(manager, cwd=repo).write(
            CheckpointPlan(account="2", claude_md=False, transcript=path)
        )
        assert manager.launches == []  # the transcript was given, so no profile lookup
        assert result.claude_md is None and not (repo / CLAUDE_MD).exists()
        text = (repo / CHECKPOINT_PATH).read_text(encoding="utf-8")
        assert "Session `abc-123`" in text and "- it\n" in text
        assert result.redactions == 0
        # A caller that hands the transcript in keeps its own id for it: the
        # teleported session's local file is not named after the cloud session.
        _, text, _ = Checkpointer(manager, cwd=repo).build(CheckpointPlan(transcript=path, session_id="cloud-id"))
        assert "Session `cloud-id`" in text and "- it\n" in text

    def test_build_is_dry(self, tmp_path, repo, capsys):
        t = T()
        t.user("key sk-ant-api03-zzzzzzzzzzzzzzzz")
        t.claude("ok")
        _profile_transcript(tmp_path, repo, t)
        checkpointer = Checkpointer(FakeManager(tmp_path), cwd=repo)
        cp, text, section = checkpointer.build(CheckpointPlan(account="2", session_id="s1"))
        assert cp.redactions == 1 and "zzzzzzzz" not in text and section.startswith(MARK_BEGIN)
        assert not (repo / ".claude").exists()
        checkpointer.write(CheckpointPlan(account="2", session_id="s1"))
        assert "Redacted 1 credential-like string(s)." in capsys.readouterr().out

    def test_write_respects_cwd_in_plan_and_subdirectory(self, tmp_path, repo):
        sub = repo / "sub"
        sub.mkdir()
        result = Checkpointer(None, cwd=tmp_path).write(CheckpointPlan(cwd=sub))
        assert result.checkpoint == repo / CHECKPOINT_PATH  # the repository root, not the subdirectory
        assert result.claude_md == repo / CLAUDE_MD

    def test_bad_cwd_and_bad_cap(self, tmp_path):
        with pytest.raises(CheckpointError, match="is not a directory"):
            Checkpointer(None, cwd=tmp_path / "nope").write(CheckpointPlan())
        with pytest.raises(ValidationError, match="at least 1"):
            Checkpointer(None, cwd=tmp_path).write(CheckpointPlan(max_bytes=0))

    def test_start_writes_then_runs_claude_as_the_account(self, tmp_path, repo, fake_claude):
        calls, state = fake_claude
        state["rc"] = 7
        manager = FakeManager(tmp_path)
        rc = Checkpointer(manager, cwd=repo).start(
            CheckpointPlan(account="2", task="finish tests", claude_args=["--model", "opus"])
        )
        assert rc == 7
        argv, kwargs = calls[0]
        assert argv == [FAKE_CLAUDE, "--model", "opus", START_PROMPT + "finish tests"]
        assert kwargs["env"]["CLAUDE_CONFIG_DIR"].endswith("2-b_x.io")
        assert Path(kwargs["cwd"]) == repo
        assert (repo / CHECKPOINT_PATH).exists()
        assert manager.launches == ["2"]  # once, for the launch; the write looked the profile up read-only

    def test_start_without_account_uses_claude_from_path(self, tmp_path, repo, fake_claude, monkeypatch):
        calls, _ = fake_claude
        monkeypatch.setattr(checkpoint.shutil, "which", lambda name: "/usr/bin/claude")
        monkeypatch.setenv("MARKER_VAR", "yes")
        rc = Checkpointer(None, cwd=repo).start(CheckpointPlan(write=False))
        assert rc == 0
        argv, kwargs = calls[0]
        assert argv == ["/usr/bin/claude", START_PROMPT + DEFAULT_TASK]
        assert kwargs["env"]["MARKER_VAR"] == "yes"
        assert not (repo / CHECKPOINT_PATH).exists()

    def test_start_errors(self, tmp_path, repo, fake_claude, monkeypatch):
        calls, state = fake_claude
        monkeypatch.setattr(checkpoint.shutil, "which", lambda name: None)
        with pytest.raises(CheckpointError, match="not found on PATH"):
            Checkpointer(None, cwd=repo).start(CheckpointPlan(write=False))
        with pytest.raises(CheckpointError, match="no account registry"):
            Checkpointer(None, cwd=repo).start(CheckpointPlan(account="2", write=False))
        assert calls == []
        state["raise"] = KeyboardInterrupt()
        assert Checkpointer(FakeManager(tmp_path), cwd=repo).start(CheckpointPlan(account="2", write=False)) == 130

    def test_show(self, tmp_path, repo):
        checkpointer = Checkpointer(None, cwd=repo)
        with pytest.raises(CheckpointError, match="cswap checkpoint write"):
            checkpointer.show()
        write_checkpoint(repo, "# Session checkpoint: x\n")
        assert checkpointer.show() == "# Session checkpoint: x\n"
        (repo / "sub").mkdir()
        # A subdirectory resolves to the repository root, like write does.
        assert Checkpointer(None, cwd=tmp_path).show(CheckpointPlan(cwd=repo / "sub")) == "# Session checkpoint: x\n"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


class TestMain:
    def test_write_print_writes_nothing(self, repo, capsys):
        assert main(["write", "--print", "--cwd", str(repo)]) == 0
        out = capsys.readouterr().out
        assert out.startswith("# Session checkpoint: ") and "branch `feature/x`" in out
        assert not (repo / ".claude").exists() and not (repo / CLAUDE_MD).exists()

    def test_write_then_show(self, repo, capsys):
        assert main(["write", "--cwd", str(repo), "--no-claude-md", "--max-kb", "4"]) == 0
        assert (repo / CHECKPOINT_PATH).exists() and not (repo / CLAUDE_MD).exists()
        capsys.readouterr()
        assert main(["show", "--cwd", str(repo)]) == 0
        assert capsys.readouterr().out.startswith("# Session checkpoint: ")
        assert main(["write", "--cwd", str(repo)]) == 0
        assert (repo / CLAUDE_MD).read_text(encoding="utf-8").startswith(MARK_BEGIN)

    def test_show_missing_is_an_error(self, repo, capsys):
        assert main(["show", "--cwd", str(repo)]) == 1
        assert "cswap checkpoint write" in capsys.readouterr().err

    def test_usage_errors(self, repo, capsys):
        with pytest.raises(SystemExit) as exc:
            main(["write", "--cwd", str(repo), "--max-kb", "0"])
        assert exc.value.code == 2
        with pytest.raises(SystemExit) as exc:
            main(["bogus"])
        assert exc.value.code == 2
        assert main([]) == 2
        assert "write|start|show" in capsys.readouterr().out

    def test_start_uses_the_manager_factory_and_forwards_claude_args(self, tmp_path, repo, fake_claude):
        calls, _ = fake_claude
        seen: list[bool] = []

        def factory(debug: bool):
            seen.append(debug)
            return FakeManager(tmp_path)

        rc = main(
            ["start", "--account", "2", "--cwd", str(repo), "-m", "go", "--debug", "--", "--model", "opus"],
            manager_factory=factory,
        )
        assert rc == 0 and seen == [True]
        argv, kwargs = calls[0]
        assert argv == [FAKE_CLAUDE, "--model", "opus", START_PROMPT + "go"]
        assert kwargs["env"]["CLAUDE_CONFIG_DIR"].endswith("2-b_x.io")
        assert (repo / CHECKPOINT_PATH).exists() and (repo / CLAUDE_MD).exists()

    def test_write_account_print_is_only_the_checkpoint(self, tmp_path, repo, capsys):
        # `--print > session.md` must not get a "Launching ..." first line:
        # the profile is looked up without launch_env.
        t = T()
        t.user("Print me")
        t.claude("ok")
        _profile_transcript(tmp_path, repo, t)
        rc = main(
            ["write", "--account", "2", "--session", "s1", "--cwd", str(repo), "--print"],
            manager_factory=lambda debug: NoLaunchManager(tmp_path),
        )
        assert rc == 0
        out = capsys.readouterr().out
        assert out.startswith("# Session checkpoint: ") and "> Print me" in out

    def test_claude_args_are_a_usage_error_outside_start(self, repo, capsys):
        for argv in (["write", "--cwd", str(repo), "--", "--model", "opus"], ["show", "--cwd", str(repo), "--", "x"]):
            with pytest.raises(SystemExit) as exc:
                main(argv)
            assert exc.value.code == 2
        assert "only `start`" in capsys.readouterr().err
        assert not (repo / ".claude").exists()

    def test_start_no_write_leaves_files_alone(self, tmp_path, repo, fake_claude):
        calls, _ = fake_claude
        assert main(["start", "--account", "2", "--cwd", str(repo), "--no-write"], manager_factory=lambda d: FakeManager(tmp_path)) == 0
        assert calls[0][0] == [FAKE_CLAUDE, START_PROMPT + DEFAULT_TASK]
        assert not (repo / ".claude").exists()

    def test_unpaired_marker_is_exit_1_with_a_plain_message(self, repo, capsys):
        (repo / CLAUDE_MD).write_text("x\n" + MARK_BEGIN + "\n")
        assert main(["write", "--cwd", str(repo)]) == 1
        assert "unpaired checkpoint marker" in capsys.readouterr().err
        assert (repo / CHECKPOINT_PATH).exists()  # session.md was written before CLAUDE.md was refused

    def test_bad_cwd_is_exit_1(self, tmp_path, capsys):
        assert main(["write", "--cwd", str(tmp_path / "nope")]) == 1
        assert "is not a directory" in capsys.readouterr().err

    def test_keyboard_interrupt_is_130(self, repo, monkeypatch, capsys):
        def boom(self, plan):
            raise KeyboardInterrupt

        monkeypatch.setattr(Checkpointer, "write", boom)
        assert main(["write", "--cwd", str(repo)]) == 130
        assert "cancelled" in capsys.readouterr().out
