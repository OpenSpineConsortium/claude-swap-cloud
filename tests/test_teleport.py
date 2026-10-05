"""Tests for `cswap teleport` (claude_swap.teleport + claude_swap.handoff)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from claude_swap import cli
from claude_swap import teleport as teleport_mod
from claude_swap.exceptions import AccountNotFoundError
from claude_swap.handoff import (
    HandoffContext,
    find_transcript,
    handoff_filename,
    project_slug,
    read_transcript,
    redact,
    render_handoff,
)
from claude_swap.teleport import TeleportError, TeleportPlan, Teleporter

FAKE_CLAUDE = "fake-claude"

ACCOUNTS = {
    "1": ("a@example.com", "org-a", "oauth"),
    "2": ("b@example.com", "org-b", "oauth"),
    "3": ("key@example.com", "org-c", "api_key"),
}


def _line(entry: dict) -> str:
    return json.dumps(entry) + "\n"


def _user(text, **extra) -> dict:
    return {"type": "user", "message": {"role": "user", "content": text}, **extra}


def _assistant(text, **extra) -> dict:
    return {
        "type": "assistant",
        "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
        **extra,
    }


# ---------------------------------------------------------------------------
# handoff (pure)
# ---------------------------------------------------------------------------


class TestReadTranscript:
    def test_keeps_text_and_drops_tools_sidechains_and_harness(self, tmp_path):
        path = tmp_path / "t.jsonl"
        path.write_text(
            _line(_user("<system-reminder>ignore me</system-reminder>Fix the bug"))
            + _line(
                {
                    "type": "assistant",
                    "message": {
                        "content": [
                            {"type": "thinking", "thinking": "hmm"},
                            {"type": "tool_use", "name": "Bash", "input": {}},
                            {"type": "text", "text": "Looking now."},
                        ]
                    },
                }
            )
            + _line(
                {
                    "type": "user",
                    "message": {
                        "content": [{"type": "tool_result", "content": "secret output"}]
                    },
                }
            )
            + _line(_assistant("subagent chatter", isSidechain=True))
            + _line({"type": "attachment", "foo": 1})
            + _line(_user("meta", isMeta=True))
            + "not json\n"
            + _line(_assistant("Done."))
        )
        assert read_transcript(path) == [
            ("user", "Fix the bug"),
            # One turn: the last thing Claude said in it.
            ("assistant", "Done."),
        ]

    def test_missing_file_is_empty(self, tmp_path):
        assert read_transcript(tmp_path / "nope.jsonl") == []


class TestRedact:
    def test_redacts_known_shapes_once(self):
        text, count = redact(
            "API_KEY=sk-ant-abcdefghijkl then ghp_" + "a" * 36 + " PASSWORD: hunter2"
        )
        assert "sk-ant" not in text and "ghp_" not in text and "hunter2" not in text
        assert count == 3

    def test_plain_text_untouched(self):
        assert redact("nothing to see") == ("nothing to see", 0)


class TestRenderHandoff:
    def test_summary_goes_after_header_and_everything_is_redacted(self, tmp_path):
        path = tmp_path / "t.jsonl"
        path.write_text(_line(_user("Goal with TOKEN=abc123")))
        note, count = render_handoff(
            HandoffContext(
                transcript=path, branch="b", session_id="s", task="t",
                summary="Summary with sk-ant-abcdefghijkl",
            )
        )
        assert note.startswith("# Handoff")
        assert note.index("Summary by the previous session") < note.index(
            "## Original request"
        )
        assert "abc123" not in note and "sk-ant" not in note
        assert count == 2

    def test_byte_cap(self, tmp_path):
        path = tmp_path / "t.jsonl"
        path.write_text("".join(_line(_user("é" * 500)) for _ in range(50)))
        note, _ = render_handoff(
            HandoffContext(transcript=path, branch="b", session_id="s", task="t",
                           max_bytes=2048)
        )
        assert len(note.encode()) <= 2048

    def test_no_transcript(self):
        note, count = render_handoff(
            HandoffContext(transcript=None, branch="b", session_id=None, task="t")
        )
        assert "No transcript" in note and count == 0

    @pytest.mark.parametrize(
        ("session_id", "transcript", "expected"),
        [
            ("session_01Ab", None, "session_01Ab.md"),
            (None, Path("x/uuid-1.jsonl"), "uuid-1.md"),
            ("../evil/id", None, "evil-id.md"),
            (None, None, "handoff.md"),
        ],
    )
    def test_filename(self, session_id, transcript, expected):
        assert handoff_filename(session_id, transcript) == expected


class TestFindTranscript:
    def test_prefers_session_id_then_newest_for_cwd(self, tmp_path):
        cwd = tmp_path / "repo"
        proj = tmp_path / "cfg" / "projects" / project_slug(cwd)
        proj.mkdir(parents=True)
        old = proj / "old.jsonl"
        new = proj / "new.jsonl"
        old.write_text("")
        new.write_text("")
        os.utime(old, (1000, 1000))
        os.utime(new, (2000, 2000))
        assert find_transcript(tmp_path / "cfg", cwd, None, None) == new
        assert find_transcript(tmp_path / "cfg", cwd, "old", None) == old
        # `since` excludes transcripts that predate the teleport.
        assert find_transcript(tmp_path / "cfg", cwd, None, 3000) is None

    def test_no_projects_dir(self, tmp_path):
        assert find_transcript(tmp_path, tmp_path, "x", None) is None


# ---------------------------------------------------------------------------
# orchestration
# ---------------------------------------------------------------------------


class FakeSwitcher:
    def __init__(self, backup_dir: Path | None = None):
        # The real switcher exposes both of these; checkpoint.config_dir_for
        # reads them to find a profile without launching it.
        self.backup_dir = backup_dir

    def resolve_account(self, identifier):
        for num, (email, org, _kind) in ACCOUNTS.items():
            if identifier in (num, email):
                return num, email, org
        raise AccountNotFoundError(identifier)

    def _account_kind(self, num):
        return ACCOUNTS[num][2]

    def _get_current_account(self):
        # No account is the active default login in the tests, so a profile
        # is always resolved under backup_dir rather than the home config.
        return None


class FakeManager:
    def __init__(self, root: Path):
        self.switcher = FakeSwitcher(backup_dir=root)
        self.root = root
        self.launches: list[str] = []

    def launch_env(self, identifier, share=True, share_history=False, require_session=False):
        num, _, _ = self.switcher.resolve_account(identifier)
        self.launches.append(num)
        return FAKE_CLAUDE, {"CLAUDE_CONFIG_DIR": str(self.root / f"profile-{num}")}


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def repo(tmp_path) -> Path:
    origin = tmp_path / "origin.git"
    _git(tmp_path, "init", "--bare", "-q", str(origin))
    work = tmp_path / "work"
    work.mkdir()
    _git(work, "init", "-q", "-b", "main")
    _git(work, "config", "user.email", "t@example.com")
    _git(work, "config", "user.name", "T")
    _git(work, "config", "commit.gpgsign", "false")
    (work / "README").write_text("hi\n")
    _git(work, "add", "README")
    _git(work, "commit", "-q", "-m", "init")
    _git(work, "remote", "add", "origin", str(origin))
    return work


@pytest.fixture
def fake_claude(monkeypatch, repo):
    """Intercept claude launches; `--teleport` checks out a branch and writes a
    transcript into the launching profile, like the real command."""
    calls: list[tuple[list[str], dict]] = []
    real_run = subprocess.run
    state = {
        "teleport_rc": 0,
        "cloud_rc": 0,
        "dirty": False,
        "summary_rc": 0,
        "summary": "SUMMARY: widget built, tests next",
    }

    def fake_run(argv, *args, **kwargs):
        if argv[0] != FAKE_CLAUDE:
            return real_run(argv, *args, **kwargs)
        env = kwargs.get("env") or {}
        calls.append((argv[1:], env))
        if "--teleport" in argv:
            _git(repo, "checkout", "-q", "-b", "claude/feature")
            (repo / "work.txt").write_text("done\n")
            _git(repo, "add", "work.txt")
            _git(repo, "commit", "-q", "-m", "work")
            if state["dirty"]:
                (repo / "work.txt").write_text("uncommitted\n")
            proj = Path(env["CLAUDE_CONFIG_DIR"]) / "projects" / project_slug(repo.resolve())
            proj.mkdir(parents=True, exist_ok=True)
            (proj / "local-uuid.jsonl").write_text(
                _line(_user("Build the widget"))
                + _line(_assistant("Built it; token sk-ant-supersecretvalue left in env."))
            )
            return subprocess.CompletedProcess(argv, state["teleport_rc"])
        if "--resume" in argv:
            return subprocess.CompletedProcess(
                argv, state["summary_rc"], stdout=state["summary"], stderr=""
            )
        return subprocess.CompletedProcess(argv, state["cloud_rc"])

    monkeypatch.setattr(teleport_mod.subprocess, "run", fake_run)
    return calls, state


def _plan(**overrides) -> TeleportPlan:
    values = dict(source="1", target="2", session_id="session_abc", task="Keep going")
    values.update(overrides)
    return TeleportPlan(**values)


class TestTeleporter:
    def test_full_chain_commits_note(self, tmp_path, repo, fake_claude):
        calls, _ = fake_claude
        manager = FakeManager(tmp_path)
        assert Teleporter(manager, cwd=repo).run(_plan()) == 0

        assert manager.launches == ["1", "2"]
        (teleport_args, teleport_env), (cloud_args, cloud_env) = calls
        assert teleport_args == ["--teleport", "session_abc"]
        assert teleport_env["CLAUDE_CONFIG_DIR"].endswith("profile-1")
        assert cloud_env["CLAUDE_CONFIG_DIR"].endswith("profile-2")
        assert cloud_args == [
            "--cloud",
            "Read .claude/handoff/session_abc.md first, then: Keep going",
        ]

        # The note is committed on the branch and that commit reached origin.
        note = (repo / ".claude" / "handoff" / "session_abc.md").read_text()
        assert "branch `claude/feature`" in note
        assert "account a@example.com" in note
        assert "Build the widget" in note
        assert "sk-ant-supersecret" not in note and "[redacted]" in note
        assert _git(repo, "status", "--porcelain") == ""
        assert _git(repo, "rev-parse", "HEAD") == _git(
            repo, "ls-remote", "origin", "claude/feature"
        ).split()[0]
        assert "handoff" in _git(repo, "log", "-1", "--format=%s")

    def test_rerun_reuses_committed_note(self, tmp_path, repo, fake_claude):
        manager = FakeManager(tmp_path)
        Teleporter(manager, cwd=repo).run(_plan())
        head = _git(repo, "rev-parse", "HEAD")
        # Same transcript and branch: the note renders identically (its own
        # commit is left out of the commit list), so nothing new is committed.
        Teleporter(manager, cwd=repo).run(_plan(skip_teleport=True))
        assert _git(repo, "rev-parse", "HEAD") == head

    def test_note_committed_even_when_claude_dir_ignored(
        self, tmp_path, repo, fake_claude
    ):
        (repo / ".gitignore").write_text(".claude/\n")
        _git(repo, "add", ".gitignore")
        _git(repo, "commit", "-q", "-m", "ignore")
        Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan())
        assert ".claude/handoff/session_abc.md" in _git(
            repo, "show", "--name-only", "--format=", "HEAD"
        )

    def test_handoff_in_prompt_commits_nothing(self, tmp_path, repo, fake_claude):
        calls, _ = fake_claude
        Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan(handoff_in_prompt=True))
        prompt = calls[1][0][1]
        assert prompt.startswith("Keep going\n\n# Handoff")
        assert "git rm" not in prompt
        assert "Build the widget" in prompt
        assert "[redacted]" in prompt
        assert not (repo / ".claude").exists()

    def test_in_prompt_note_is_capped_at_8kb(self, tmp_path, repo, fake_claude):
        calls, _ = fake_claude
        Teleporter(FakeManager(tmp_path), cwd=repo).run(
            _plan(handoff_in_prompt=True, handoff_max_bytes=64 * 1024)
        )
        note = calls[1][0][1].split("\n\n", 1)[1]
        assert len(note.encode()) <= 8 * 1024

    def test_summarize_runs_source_account_and_adds_summary(
        self, tmp_path, repo, fake_claude
    ):
        calls, _ = fake_claude
        manager = FakeManager(tmp_path)
        Teleporter(manager, cwd=repo).run(_plan(summarize=True))
        assert [c[0][0] for c in calls] == ["--teleport", "--resume", "--cloud"]
        resume_args, resume_env = calls[1]
        assert resume_args[:2] == ["--resume", "local-uuid"]
        assert resume_args[2] == "-p"
        assert resume_env["CLAUDE_CONFIG_DIR"].endswith("profile-1")
        note = (repo / ".claude" / "handoff" / "session_abc.md").read_text()
        assert "Summary by the previous session" in note
        assert "SUMMARY: widget built" in note

    def test_failed_summary_still_hands_off(self, tmp_path, repo, fake_claude):
        calls, state = fake_claude
        state["summary_rc"] = 1
        Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan(summarize=True))
        note = (repo / ".claude" / "handoff" / "session_abc.md").read_text()
        assert "Summary by the previous session" not in note
        assert calls[-1][0][0] == "--cloud"

    def test_no_session_id_names_note_after_transcript(
        self, tmp_path, repo, fake_claude
    ):
        calls, _ = fake_claude
        Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan(session_id=None))
        assert calls[0][0] == ["--teleport"]
        assert calls[1][0][1].startswith("Read .claude/handoff/local-uuid.md first")

    def test_claude_args_forwarded_to_every_launch(self, tmp_path, repo, fake_claude):
        calls, _ = fake_claude
        Teleporter(FakeManager(tmp_path), cwd=repo).run(
            _plan(summarize=True, claude_args=["--dangerously-skip-permissions"])
        )
        assert [c[0][:2] for c in calls] == [
            ["--dangerously-skip-permissions", "--teleport"],
            ["--dangerously-skip-permissions", "--resume"],
            ["--dangerously-skip-permissions", "--cloud"],
        ]

    def test_no_handoff(self, tmp_path, repo, fake_claude):
        calls, _ = fake_claude
        Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan(handoff=False))
        assert calls[1][0] == ["--cloud", "Keep going"]
        assert not (repo / ".claude").exists()

    def test_no_push(self, tmp_path, repo, fake_claude):
        Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan(push=False))
        assert _git(repo, "ls-remote", "origin", "claude/feature") == ""
        # The note is still committed locally.
        assert (repo / ".claude" / "handoff" / "session_abc.md").exists()
        assert _git(repo, "status", "--porcelain") == ""

    def test_skip_teleport_reads_existing_transcript(self, tmp_path, repo, fake_claude):
        calls, _ = fake_claude
        manager = FakeManager(tmp_path)
        # A previous run pulled the session already.
        proj = tmp_path / "profile-1" / "projects" / project_slug(repo.resolve())
        proj.mkdir(parents=True)
        (proj / "x.jsonl").write_text(_line(_user("Earlier goal")))
        _git(repo, "checkout", "-q", "-b", "claude/pulled")

        Teleporter(manager, cwd=repo).run(_plan(skip_teleport=True, session_id=None))
        assert [c[0][0] for c in calls] == ["--cloud"]
        assert "Earlier goal" in (repo / ".claude" / "handoff" / "x.md").read_text()
        assert _git(repo, "ls-remote", "origin", "claude/pulled")

    def test_dry_run_previews_note_when_already_pulled(
        self, tmp_path, repo, fake_claude, capsys
    ):
        calls, _ = fake_claude
        proj = tmp_path / "profile-1" / "projects" / project_slug(repo.resolve())
        proj.mkdir(parents=True)
        (proj / "x.jsonl").write_text(_line(_user("Earlier goal")))
        Teleporter(FakeManager(tmp_path), cwd=repo).run(
            _plan(skip_teleport=True, dry_run=True)
        )
        assert calls == []
        assert "Earlier goal" in capsys.readouterr().out
        assert not (repo / ".claude").exists()

    def test_dry_run_launches_nothing(self, tmp_path, repo, fake_claude, capsys):
        calls, _ = fake_claude
        manager = FakeManager(tmp_path)
        Teleporter(manager, cwd=repo).run(_plan(dry_run=True))
        assert calls == [] and manager.launches == []
        out = capsys.readouterr().out
        assert "claude --teleport session_abc" in out
        assert "claude --cloud" in out

    @pytest.mark.parametrize("field", ["source", "target"])
    def test_rejects_api_key_accounts_before_launch(
        self, tmp_path, repo, fake_claude, field
    ):
        calls, _ = fake_claude
        with pytest.raises(TeleportError, match="API-key account"):
            Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan(**{field: "3"}))
        assert calls == []

    def test_rejects_same_account(self, tmp_path, repo, fake_claude):
        with pytest.raises(TeleportError, match="same account"):
            Teleporter(FakeManager(tmp_path), cwd=repo).run(
                _plan(source="1", target="a@example.com")
            )

    def test_rejects_dirty_tree_before_teleport(self, tmp_path, repo, fake_claude):
        calls, _ = fake_claude
        (repo / "README").write_text("changed\n")
        with pytest.raises(TeleportError, match="uncommitted"):
            Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan())
        assert calls == []

    def test_outside_git_repo(self, tmp_path, fake_claude):
        outside = tmp_path / "plain"
        outside.mkdir()
        with pytest.raises(TeleportError, match="Not inside a git repository"):
            Teleporter(FakeManager(tmp_path), cwd=outside).run(_plan())

    def test_teleport_failure_stops_before_push(self, tmp_path, repo, fake_claude):
        calls, state = fake_claude
        state["teleport_rc"] = 1
        with pytest.raises(TeleportError, match="stopping before anything is pushed"):
            Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan())
        assert len(calls) == 1
        assert _git(repo, "ls-remote", "origin", "claude/feature") == ""

    def test_dirty_after_teleport_stops_before_cloud(self, tmp_path, repo, fake_claude):
        calls, state = fake_claude
        state["dirty"] = True
        with pytest.raises(TeleportError, match="--skip-teleport"):
            Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan())
        assert len(calls) == 1

    def test_cloud_failure_reports_resume_hint(self, tmp_path, repo, fake_claude):
        _, state = fake_claude
        state["cloud_rc"] = 2
        with pytest.raises(TeleportError, match="rerun with --skip-teleport"):
            Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan())


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


class TestTeleportCli:
    def _dispatch(self, argv):
        captured = {}

        class FakeTeleporter:
            def __init__(self, manager):
                pass

            def run(self, plan):
                captured["plan"] = plan
                return 0

        with patch("claude_swap.teleport.Teleporter", FakeTeleporter), \
             patch("claude_swap.session.SessionManager"), \
             patch("claude_swap.cli.ClaudeAccountSwitcher"), \
             patch("claude_swap.cli._guard_root"), \
             patch.object(sys, "argv", ["claude-swap", *argv]):
            with pytest.raises(SystemExit) as exc:
                cli.main()
        assert exc.value.code == 0
        return captured["plan"]

    def test_defaults(self):
        plan = self._dispatch(["teleport", "--from", "1", "--to", "b@x.com", "sess"])
        assert (plan.source, plan.target, plan.session_id) == ("1", "b@x.com", "sess")
        assert plan.push and plan.handoff and plan.share
        assert not plan.handoff_in_prompt and not plan.summarize
        assert plan.handoff_max_bytes == 12 * 1024
        assert not plan.skip_teleport and not plan.dry_run
        assert plan.task == teleport_mod.DEFAULT_TASK
        assert plan.claude_args == []

    def test_args_after_double_dash_go_to_claude(self):
        plan = self._dispatch([
            "teleport", "--from", "1", "--to", "2", "sess", "--",
            "--permission-mode", "bypassPermissions", "--no-push",
        ])
        assert plan.claude_args == ["--permission-mode", "bypassPermissions", "--no-push"]
        assert plan.push  # --no-push after -- belongs to claude, not cswap

    def test_flags(self):
        plan = self._dispatch([
            "teleport", "--from", "1", "--to", "2", "-m", "do it",
            "--skip-teleport", "--no-push", "--no-handoff", "--no-share",
            "--dry-run", "--handoff-max-kb", "4", "--handoff-in-prompt",
            "--summarize",
        ])
        assert plan.session_id is None
        assert plan.task == "do it"
        assert plan.skip_teleport and plan.dry_run
        assert not plan.push and not plan.handoff and not plan.share
        assert plan.handoff_max_bytes == 4096
        assert plan.handoff_in_prompt and plan.summarize

    def test_rejects_zero_handoff_size(self):
        with patch.object(
            sys, "argv",
            ["claude-swap", "teleport", "--from", "1", "--to", "2",
             "--handoff-max-kb", "0"],
        ):
            with pytest.raises(SystemExit) as exc:
                cli.main()
        assert exc.value.code == 2

    def test_requires_both_accounts(self):
        with patch.object(sys, "argv", ["claude-swap", "teleport", "--from", "1"]):
            with pytest.raises(SystemExit) as exc:
                cli.main()
        assert exc.value.code == 2

    def test_error_exits_1(self, capsys):
        class Boom:
            def __init__(self, manager):
                pass

            def run(self, plan):
                raise TeleportError("nope")

        with patch("claude_swap.teleport.Teleporter", Boom), \
             patch("claude_swap.session.SessionManager"), \
             patch("claude_swap.cli.ClaudeAccountSwitcher"), \
             patch("claude_swap.cli._guard_root"), \
             patch.object(
                 sys, "argv", ["claude-swap", "teleport", "--from", "1", "--to", "2"]
             ):
            with pytest.raises(SystemExit) as exc:
                cli.main()
        assert exc.value.code == 1
        assert "nope" in capsys.readouterr().err
