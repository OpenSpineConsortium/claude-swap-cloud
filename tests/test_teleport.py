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
    build_handoff_note,
    find_transcript,
    project_slug,
    read_transcript,
    redact,
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
            ("assistant", "Looking now."),
            ("assistant", "Done."),
        ]

    def test_missing_file_is_empty(self, tmp_path):
        assert read_transcript(tmp_path / "nope.jsonl") == []


class TestBuildHandoffNote:
    def test_includes_branch_goal_and_conversation(self):
        note = build_handoff_note(
            [("user", "Add a flag"), ("assistant", "Added it."), ("user", "Thanks")],
            branch="feat/x",
            session_id="session_1",
        )
        assert "Branch: feat/x" in note
        assert "Original cloud session: session_1" in note
        assert "### Original request\n**User:** Add a flag" in note
        assert "**Claude:** Added it." in note
        assert "omitted" not in note

    def test_budget_keeps_goal_and_newest_messages(self):
        messages = [("user", "THE GOAL")] + [
            ("assistant" if i % 2 else "user", f"message {i} " + "x" * 300)
            for i in range(1, 40)
        ]
        note = build_handoff_note(messages, branch="b", session_id=None, max_chars=3000)
        assert len(note) <= 3000
        assert "THE GOAL" in note
        assert "message 39" in note
        assert "message 1 " not in note
        assert "earlier omitted" in note

    def test_no_messages(self):
        note = build_handoff_note([], branch="b", session_id=None)
        assert "No transcript was found" in note


class TestRedact:
    def test_redacts_known_shapes_once(self):
        text, count = redact(
            "API_KEY=sk-ant-abcdefghijkl then ghp_" + "a" * 36 + " PASSWORD: hunter2"
        )
        assert "sk-ant" not in text and "ghp_" not in text and "hunter2" not in text
        assert count == 3

    def test_plain_text_untouched(self):
        assert redact("nothing to see") == ("nothing to see", 0)


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
    def resolve_account(self, identifier):
        for num, (email, org, _kind) in ACCOUNTS.items():
            if identifier in (num, email):
                return num, email, org
        raise AccountNotFoundError(identifier)

    def _account_kind(self, num):
        return ACCOUNTS[num][2]


class FakeManager:
    def __init__(self, root: Path):
        self.switcher = FakeSwitcher()
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
    state = {"teleport_rc": 0, "cloud_rc": 0, "dirty": False}

    def fake_run(argv, *args, **kwargs):
        if argv[0] != FAKE_CLAUDE:
            return real_run(argv, *args, **kwargs)
        env = kwargs.get("env") or {}
        calls.append((argv[1:], env))
        if argv[1] == "--teleport":
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
        return subprocess.CompletedProcess(argv, state["cloud_rc"])

    monkeypatch.setattr(teleport_mod.subprocess, "run", fake_run)
    return calls, state


def _plan(**overrides) -> TeleportPlan:
    values = dict(source="1", target="2", session_id="session_abc", task="Keep going")
    values.update(overrides)
    return TeleportPlan(**values)


class TestTeleporter:
    def test_full_chain(self, tmp_path, repo, fake_claude):
        calls, _ = fake_claude
        manager = FakeManager(tmp_path)
        assert Teleporter(manager, cwd=repo).run(_plan()) == 0

        assert manager.launches == ["1", "2"]
        (teleport_args, teleport_env), (cloud_args, cloud_env) = calls
        assert teleport_args == ["--teleport", "session_abc"]
        assert teleport_env["CLAUDE_CONFIG_DIR"].endswith("profile-1")
        assert cloud_env["CLAUDE_CONFIG_DIR"].endswith("profile-2")

        assert cloud_args[0] == "--cloud"
        prompt = cloud_args[1]
        assert prompt.startswith("Keep going\n\n## Handoff")
        assert "Branch: claude/feature" in prompt
        assert "Build the widget" in prompt
        assert "sk-ant-supersecret" not in prompt and "[redacted]" in prompt

        # The branch reached origin.
        assert _git(repo, "ls-remote", "origin", "claude/feature")

    def test_no_session_id_lets_claude_prompt(self, tmp_path, repo, fake_claude):
        calls, _ = fake_claude
        Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan(session_id=None))
        assert calls[0][0] == ["--teleport"]
        assert "Build the widget" in calls[1][0][1]

    def test_no_handoff(self, tmp_path, repo, fake_claude):
        calls, _ = fake_claude
        Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan(handoff=False))
        assert calls[1][0] == ["--cloud", "Keep going"]

    def test_no_push(self, tmp_path, repo, fake_claude):
        Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan(push=False))
        assert _git(repo, "ls-remote", "origin", "claude/feature") == ""

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
        assert "Earlier goal" in calls[0][0][1]
        assert _git(repo, "ls-remote", "origin", "claude/pulled")

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
        assert not plan.skip_teleport and not plan.dry_run
        assert plan.task == teleport_mod.DEFAULT_TASK

    def test_flags(self):
        plan = self._dispatch([
            "teleport", "--from", "1", "--to", "2", "-m", "do it",
            "--skip-teleport", "--no-push", "--no-handoff", "--no-share",
            "--dry-run", "--handoff-chars", "1000",
        ])
        assert plan.session_id is None
        assert plan.task == "do it"
        assert plan.skip_teleport and plan.dry_run
        assert not plan.push and not plan.handoff and not plan.share
        assert plan.handoff_chars == 1000

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
