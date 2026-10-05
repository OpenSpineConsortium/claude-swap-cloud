"""`cswap teleport --checkpoint`: the checkpoint in place of the handoff note.

The checkpoint itself is tested in tests/test_checkpoint.py; here teleport is
held to committing it once, telling the cloud session to read it, and
writing no note. The fixtures are tests/test_teleport.py's.
"""

from __future__ import annotations

import sys
from unittest.mock import patch

import pytest

from claude_swap import checkpoint as cp
from claude_swap import cli
from claude_swap import teleport as teleport_mod
from claude_swap.teleport import Teleporter
from tests.test_teleport import (  # noqa: F401  (repo and fake_claude are fixtures)
    FakeManager,
    _git,
    _line,
    _plan,
    _user,
    fake_claude,
    project_slug,
    repo,
)


class TestCheckpointRun:
    def test_commits_the_checkpoint_once_and_points_the_cloud_session_at_it(self, tmp_path, repo, fake_claude):
        calls, _ = fake_claude
        manager = FakeManager(tmp_path)
        assert Teleporter(manager, cwd=repo).run(_plan(checkpoint=True)) == 0

        # The transcript was found through the teleport's own profile, so the
        # checkpointer looked nothing up: two launches, as for a note.
        assert manager.launches == ["1", "2"]
        (teleport_args, _), (cloud_args, cloud_env) = calls
        assert teleport_args == ["--teleport", "session_abc"]
        assert cloud_env["CLAUDE_CONFIG_DIR"].endswith("profile-2")
        assert cloud_args == ["--cloud", cp.start_prompt("Keep going")]
        assert cloud_args[1].startswith("Read .claude/session.md first")
        assert cloud_args[1].endswith("Then: Keep going")

        session = (repo / cp.CHECKPOINT_PATH).read_text(encoding="utf-8")
        assert session.startswith("# Session checkpoint: ")
        assert "Session `session_abc`" in session
        assert "branch `claude/feature`" in session
        assert "Build the widget" in session
        assert "sk-ant-supersecret" not in session and "[redacted]" in session
        claude_md = (repo / cp.CLAUDE_MD).read_text(encoding="utf-8")
        assert cp.MARK_BEGIN in claude_md and cp.MARK_END in claude_md
        assert not (repo / ".claude" / "handoff").exists()

        # One commit with the prefix, both files in it, pushed to origin.
        assert _git(repo, "status", "--porcelain") == ""
        assert _git(repo, "log", "-1", "--format=%s") == f"{cp.CHECKPOINT_COMMIT_PREFIX} session_abc"
        shown = _git(repo, "show", "--name-only", "--format=", "HEAD").splitlines()
        assert sorted(shown) == [".claude/session.md", "CLAUDE.md"]
        assert _git(repo, "rev-parse", "HEAD") == _git(repo, "ls-remote", "origin", "claude/feature").split()[0]

    def test_rerun_commits_nothing_new(self, tmp_path, repo, fake_claude):
        manager = FakeManager(tmp_path)
        Teleporter(manager, cwd=repo).run(_plan(checkpoint=True))
        head = _git(repo, "rev-parse", "HEAD")
        # The checkpoint's own commit is left out of its commit list, so the
        # same transcript renders the same bytes and nothing is committed.
        Teleporter(manager, cwd=repo).run(_plan(checkpoint=True, skip_teleport=True))
        assert _git(repo, "rev-parse", "HEAD") == head

    def test_the_default_task_is_the_checkpoints_own(self, tmp_path, repo, fake_claude):
        calls, _ = fake_claude
        Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan(checkpoint=True, task=teleport_mod.DEFAULT_TASK))
        assert calls[1][0] == ["--cloud", cp.start_prompt(None)]
        assert "handoff note" not in calls[1][0][1]

    def test_committed_even_when_claude_dir_is_ignored(self, tmp_path, repo, fake_claude):
        (repo / ".gitignore").write_text(".claude/\n")
        _git(repo, "add", ".gitignore")
        _git(repo, "commit", "-q", "-m", "ignore")
        Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan(checkpoint=True))
        assert ".claude/session.md" in _git(repo, "show", "--name-only", "--format=", "HEAD")

    def test_without_a_transcript_the_checkpoint_names_the_branch(self, tmp_path, repo, fake_claude, capsys):
        calls, _ = fake_claude
        manager = FakeManager(tmp_path)
        # --skip-teleport with no transcript anywhere: the checkpointer looks
        # in the source profile itself (one more launch_env) and finds none.
        _git(repo, "checkout", "-q", "-b", "claude/feature")
        assert Teleporter(manager, cwd=repo).run(_plan(checkpoint=True, skip_teleport=True)) == 0
        session = (repo / cp.CHECKPOINT_PATH).read_text(encoding="utf-8")
        assert "branch `claude/feature`" in session
        assert "(no transcript)" in session
        assert "No local transcript" in capsys.readouterr().out
        assert calls[0][0] == ["--cloud", cp.start_prompt("Keep going")]

    def test_dry_run_previews_the_checkpoint_and_the_prompt(self, tmp_path, repo, fake_claude, capsys):
        calls, _ = fake_claude
        proj = tmp_path / "profile-1" / "projects" / project_slug(repo.resolve())
        proj.mkdir(parents=True)
        (proj / "x.jsonl").write_text(_line(_user("Earlier goal")))
        Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan(checkpoint=True, skip_teleport=True, dry_run=True))
        assert calls == []
        out = capsys.readouterr().out
        assert "Commit the checkpoint at .claude/session.md and the CLAUDE.md section" in out
        assert "(told to read the checkpoint first)" in out
        assert "# Session checkpoint: " in out and "Earlier goal" in out
        assert f"Cloud prompt: {cp.start_prompt('Keep going')}" in out
        assert not (repo / ".claude").exists()
        assert not (repo / "CLAUDE.md").exists()

    def test_dry_run_without_the_session_local_launches_nothing(self, tmp_path, repo, fake_claude, capsys):
        calls, _ = fake_claude
        manager = FakeManager(tmp_path)
        Teleporter(manager, cwd=repo).run(_plan(checkpoint=True, dry_run=True))
        assert calls == [] and manager.launches == []
        out = capsys.readouterr().out
        assert "Commit the checkpoint" in out and "Handoff note" not in out

    def test_no_push_warns_that_the_cloud_will_not_see_it(self, tmp_path, repo, fake_claude, capsys):
        Teleporter(FakeManager(tmp_path), cwd=repo).run(_plan(checkpoint=True, push=False))
        assert "will not see the checkpoint until you push" in capsys.readouterr().out


class TestCheckpointCli:
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
             patch("os.geteuid", return_value=1000, create=True), \
             patch.object(sys, "argv", ["cswap", "teleport", *argv]):
            with pytest.raises(SystemExit) as exc:
                cli.main()
        return exc.value.code, captured.get("plan")

    def test_flag_sets_the_plan(self):
        code, plan = self._dispatch(["--from", "1", "--to", "2", "s1", "--checkpoint"])
        assert code == 0
        assert plan.checkpoint is True
        assert plan.handoff is True and not plan.handoff_in_prompt

    def test_off_by_default(self):
        code, plan = self._dispatch(["--from", "1", "--to", "2", "s1"])
        assert code == 0 and plan.checkpoint is False

    def test_in_prompt_and_checkpoint_are_a_usage_error(self, capsys):
        code, plan = self._dispatch(["--from", "1", "--to", "2", "s1", "--checkpoint", "--handoff-in-prompt"])
        assert code == 2 and plan is None
        assert "--checkpoint" in capsys.readouterr().err

    def test_summarize_and_checkpoint_are_a_usage_error(self, capsys):
        code, plan = self._dispatch(["--from", "1", "--to", "2", "s1", "--checkpoint", "--summarize"])
        assert code == 2 and plan is None
