"""Tests for carrying a session's exact state (claude_swap.state)."""

from __future__ import annotations

import io
import json
import subprocess
import tarfile
from pathlib import Path

import pytest

from claude_swap import state
from claude_swap.handoff import project_slug
from claude_swap.state import (
    HOOK_COMMANDS,
    STATE_PATH,
    StateError,
    apply_worktree,
    export_state,
    import_state,
    main,
    read_bundle,
    render_context,
    set_hooks,
    state_vectors,
)

SID = "11111111-2222-3333-4444-555555555555"


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    r = tmp_path / "repo"
    r.mkdir()
    _git(r, "init", "-q", "-b", "main")
    _git(r, "config", "user.email", "t@example.com")
    _git(r, "config", "user.name", "T")
    _git(r, "config", "commit.gpgsign", "false")
    (r / "README").write_text("hi\n")
    (r / ".gitignore").write_text("*.log\n")
    _git(r, "add", ".")
    _git(r, "commit", "-q", "-m", "base")
    return r


def _entries() -> list[dict]:
    def msg(uid, parent, role, content, **extra):
        return {"type": role, "uuid": uid, "parentUuid": parent, "sessionId": SID,
                "gitBranch": "main", "message": {"role": role, "content": content}, **extra}

    return [
        msg("u1", None, "user", "Fix the parser please"),
        msg("a1", "u1", "assistant", [
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "pytest"}},
        ]),
        msg("u2", "a1", "user", [
            {"type": "tool_result", "tool_use_id": "t1", "is_error": True,
             "content": [{"type": "text", "text": "FAILED test_parse api_key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"}]},
        ]),
        msg("a2", "u2", "assistant", [
            {"type": "tool_use", "id": "t2", "name": "Edit", "input": {"file_path": "/w/parse.py"}},
            {"type": "tool_use", "id": "t3", "name": "Task",
             "input": {"subagent_type": "Explore", "description": "find callers"}},
            {"type": "tool_use", "id": "t4", "name": "TodoWrite",
             "input": {"todos": [{"content": "fix parser", "status": "in_progress"}]}},
            {"type": "text", "text": "Working on it."},
        ]),
        # An abandoned branch the walk must leave out.
        msg("x1", "u1", "assistant", [
            {"type": "tool_use", "id": "t9", "name": "Write", "input": {"file_path": "/w/abandoned.py"}},
        ]),
        msg("a3", "a2", "assistant", [{"type": "text", "text": "Done."}]),
    ]


def _write_transcript(config: Path, cwd: Path, entries=None) -> Path:
    folder = config / "projects" / project_slug(cwd)
    folder.mkdir(parents=True)
    path = folder / f"{SID}.jsonl"
    path.write_text("".join(json.dumps(e) + "\n" for e in (entries or _entries())), encoding="utf-8")
    sub = folder / SID / "subagents"
    sub.mkdir(parents=True)
    (sub / "agent-a.jsonl").write_text('{"type":"user"}\n')
    return path


@pytest.fixture
def home(tmp_path, monkeypatch) -> Path:
    config = tmp_path / "config"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(config))
    return config


class TestVectors:
    def test_reads_the_active_branch(self):
        v = state_vectors(_entries())
        assert v["branch"] == "main"
        assert v["current_request"] == "Fix the parser please"
        assert v["touched_files"] == ["/w/parse.py"]
        assert v["subagents"] == [{"type": "Explore", "description": "find callers"}]
        assert v["todos"] == [{"content": "fix parser", "status": "in_progress"}]
        assert [e["tool"] for e in v["pending_errors"]] == ["Bash"]

    def test_errors_are_redacted(self):
        text = state_vectors(_entries())["pending_errors"][0]["text"]
        assert "FAILED test_parse" in text and "sk-ant-api03" not in text

    def test_context_names_the_state_and_defers_to_the_conversation(self):
        ctx = render_context({"session_id": SID, "trigger": "export", "git": {"head": "abc"},
                              "vectors": state_vectors(_entries())})
        assert SID in ctx and "the conversation is right" in ctx
        assert "- [in_progress] fix parser" in ctx and "Commit: abc" in ctx
        assert "system_override" not in ctx


class TestExportImport:
    def test_round_trip_is_exact_and_deterministic(self, tmp_path, home, repo, monkeypatch):
        original = _write_transcript(home, repo)
        (repo / "README").write_text("changed\n")
        (repo / "new.txt").write_text("new\n")
        (repo / "debug.log").write_text("ignored\n")
        a = export_state(None, None, None, repo, tmp_path / "a.tar")
        b = export_state(None, None, None, repo, tmp_path / "b.tar")
        assert a.path.read_bytes() == b.path.read_bytes()
        bundle = read_bundle(a.path)
        assert bundle.transcript == original.read_bytes()
        assert bundle.session_files == {"subagents/agent-a.jsonl": b'{"type":"user"}\n'}
        assert set(bundle.tree.untracked) == {"new.txt"}
        assert bundle.tree.patch

        # Into another account's profile and a clean clone of the repository.
        other = tmp_path / "other-config"
        clone = tmp_path / "clone"
        subprocess.run(["git", "clone", "-q", str(repo), str(clone)], check=True)
        monkeypatch.setattr(state, "config_dir_for", lambda manager, account, share=True: other)
        res = import_state(None, "2", a.path, clone, apply_changes=True)
        placed = other / "projects" / project_slug(clone) / f"{SID}.jsonl"
        assert res.transcript == placed and placed.read_bytes() == original.read_bytes()
        assert (placed.parent / SID / "subagents" / "agent-a.jsonl").exists()
        assert (clone / "README").read_text() == "changed\n"
        assert (clone / "new.txt").read_text() == "new\n"
        saved = json.loads((clone / STATE_PATH).read_text())
        assert saved["session_id"] == SID and saved["vectors"]["branch"] == "main"

    def test_the_output_file_is_not_packed_into_itself(self, home, repo):
        _write_transcript(home, repo)
        res = export_state(None, None, None, repo, None)
        assert res.path == repo / f"cswap-state-{SID}.tar"
        again = export_state(None, None, None, repo, None)
        assert again.manifest["worktree"]["untracked"] == []

    def test_no_transcript_is_an_error(self, home, repo):
        with pytest.raises(StateError, match="No local transcript"):
            export_state(None, None, None, repo, None)

    def test_a_different_session_of_the_same_id_needs_force(self, tmp_path, home, repo):
        _write_transcript(home, repo)
        bundle = export_state(None, None, None, repo, tmp_path / "s.tar").path
        target = home / "projects" / project_slug(repo) / f"{SID}.jsonl"
        target.write_text("something else\n")
        with pytest.raises(StateError, match="--force"):
            import_state(None, None, bundle, repo)
        assert target.read_text() == "something else\n"
        import_state(None, None, bundle, repo, force=True)
        assert target.read_bytes() == read_bundle(bundle).transcript

    def test_refuses_another_commit_and_leaves_the_tree(self, tmp_path, home, repo):
        _write_transcript(home, repo)
        (repo / "README").write_text("changed\n")
        bundle = read_bundle(export_state(None, None, None, repo, tmp_path / "s.tar").path)
        _git(repo, "checkout", "-q", "README")
        (repo / "other").write_text("x\n")
        _git(repo, "add", "other")
        _git(repo, "commit", "-q", "-m", "moved on")
        with pytest.raises(StateError, match="Check out"):
            apply_worktree(bundle, repo)
        assert (repo / "README").read_text() == "hi\n"

    def test_an_untracked_clash_changes_nothing(self, tmp_path, home, repo):
        _write_transcript(home, repo)
        (repo / "new.txt").write_text("new\n")
        bundle = read_bundle(export_state(None, None, None, repo, tmp_path / "s.tar").path)
        (repo / "new.txt").write_text("mine\n")
        with pytest.raises(StateError, match="new.txt"):
            apply_worktree(bundle, repo)
        assert (repo / "new.txt").read_text() == "mine\n"


def _tar(tmp_path: Path, members: dict[str, bytes]) -> Path:
    path = tmp_path / "x.tar"
    with tarfile.open(path, "w") as tar:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return path


class TestReadBundle:
    def _manifest(self, transcript: bytes, **over) -> bytes:
        import hashlib

        m = {"format": "cswap-state", "version": 1, "session_id": SID,
             "transcript": {"sha256": hashlib.sha256(transcript).hexdigest()}}
        m.update(over)
        return json.dumps(m).encode()

    def test_unsafe_names_are_refused(self, tmp_path):
        t = b"{}\n"
        path = _tar(tmp_path, {"state.json": self._manifest(t), "transcript.jsonl": t, "../evil": b"x"})
        with pytest.raises(StateError, match="unsafe"):
            read_bundle(path)

    def test_a_changed_transcript_is_refused(self, tmp_path):
        path = _tar(tmp_path, {"state.json": self._manifest(b"a"), "transcript.jsonl": b"b"})
        with pytest.raises(StateError, match="does not match"):
            read_bundle(path)

    def test_a_session_id_with_a_path_is_refused(self, tmp_path):
        t = b"a"
        path = _tar(tmp_path, {"state.json": self._manifest(t, session_id="../x"), "transcript.jsonl": t})
        with pytest.raises(StateError, match="session id"):
            read_bundle(path)

    def test_not_an_export(self, tmp_path):
        with pytest.raises(StateError, match="not a cswap state export"):
            read_bundle(_tar(tmp_path, {"other.txt": b"x"}))


class TestHooks:
    def test_install_keeps_other_settings_and_is_idempotent(self, repo):
        settings = repo / ".claude" / "settings.json"
        settings.parent.mkdir()
        other = {"matcher": "startup", "hooks": [{"type": "command", "command": "echo hi"}]}
        settings.write_text(json.dumps({"model": "x", "hooks": {"SessionStart": [other]}}))
        assert set_hooks(repo, True)[1] is True
        assert set_hooks(repo, True)[1] is False
        data = json.loads(settings.read_text())
        assert data["model"] == "x"
        assert data["hooks"]["SessionStart"][0] == other
        commands = [h["command"] for e in data["hooks"]["PreCompact"] for h in e["hooks"]]
        assert commands == [HOOK_COMMANDS["PreCompact"][1]]
        set_hooks(repo, False)
        assert json.loads(settings.read_text()) == {"model": "x", "hooks": {"SessionStart": [other]}}

    def test_pre_compact_then_session_start(self, tmp_path, repo):
        transcript = tmp_path / f"{SID}.jsonl"
        transcript.write_text("".join(json.dumps(e) + "\n" for e in _entries()))
        hook_in = json.dumps({"session_id": SID, "transcript_path": str(transcript),
                              "cwd": str(repo), "trigger": "manual"})
        err = io.StringIO()
        assert main(["hook", "pre-compact"], stdin=io.StringIO(hook_in), stderr=err) == 0
        saved = json.loads((repo / STATE_PATH).read_text())
        assert saved["trigger"] == "before a manual compaction"
        out = io.StringIO()
        assert main(["hook", "session-start"], stdin=io.StringIO(json.dumps({"cwd": str(repo)})), stdout=out) == 0
        payload = json.loads(out.getvalue())["hookSpecificOutput"]
        assert payload["hookEventName"] == "SessionStart"
        assert "Fix the parser please" in payload["additionalContext"]

    def test_hooks_never_fail_without_input(self, repo):
        assert main(["hook", "pre-compact"], stdin=io.StringIO("not json"), stderr=io.StringIO()) == 0
        out = io.StringIO()
        assert main(["hook", "session-start"], stdin=io.StringIO(json.dumps({"cwd": str(repo)})), stdout=out) == 0
        assert out.getvalue() == ""


class TestCli:
    def test_export_show_import(self, tmp_path, home, repo, capsys):
        _write_transcript(home, repo)
        out = tmp_path / "s.tar"
        assert main(["export", "--cwd", str(repo), "-o", str(out)]) == 0
        shown = io.StringIO()
        assert main(["show", str(out)], stdout=shown) == 0
        assert json.loads(shown.getvalue())["session_id"] == SID
        assert main(["import", str(out), "--cwd", str(repo)]) == 0
        assert f"claude --resume {SID}" in capsys.readouterr().out

    def test_claude_args_need_resume(self, tmp_path):
        with pytest.raises(SystemExit):
            main(["import", "x.tar", "--", "--model", "opus"])

    def test_a_bad_bundle_exits_1(self, tmp_path):
        assert main(["show", str(tmp_path / "missing.tar")]) == 1


FAKE_CLAUDE = "fake-claude"


class MoveSwitcher:
    ACCOUNTS = {"1": ("a@x.io", "org-a"), "2": ("b@x.io", "org-b"), "3": ("k@x.io", "org-k")}

    def resolve_account(self, identifier):
        for num, (email, org) in self.ACCOUNTS.items():
            if identifier in (num, email):
                return num, email, org
        from claude_swap.exceptions import AccountNotFoundError

        raise AccountNotFoundError(identifier)

    def _account_kind(self, num):
        return "api_key" if num == "3" else "oauth"


class MoveManager:
    def __init__(self, root: Path):
        self.switcher = MoveSwitcher()
        self.root = root

    def profile(self, num: str) -> Path:
        return self.root / f"profile-{num}"

    def launch_env(self, identifier, share=True, share_history=False, require_session=False):
        num, _, _ = self.switcher.resolve_account(identifier)
        return FAKE_CLAUDE, {"CLAUDE_CONFIG_DIR": str(self.profile(num))}


@pytest.fixture
def launches(monkeypatch):
    """Intercept claude; a --teleport launch writes the thread's transcript
    into the launching profile, as claude --teleport does."""
    calls: list[tuple[list[str], dict]] = []
    real_run = subprocess.run
    behaviour = {"rc": 0, "teleport_writes": True}

    def fake_run(argv, *args, **kwargs):
        if argv[0] != FAKE_CLAUDE:
            return real_run(argv, *args, **kwargs)
        calls.append((argv, kwargs))
        if "--teleport" in argv and behaviour["teleport_writes"]:
            _write_transcript(Path(kwargs["env"]["CLAUDE_CONFIG_DIR"]), Path(kwargs["cwd"]).resolve())
        return subprocess.CompletedProcess(argv, behaviour["rc"])

    monkeypatch.setattr(state.subprocess, "run", fake_run)
    return calls, behaviour


class TestMove:
    def test_teleports_places_and_resumes(self, tmp_path, repo, launches):
        calls, _ = launches
        manager = MoveManager(tmp_path)
        rc = main(["move", "--from", "1", "--to", "2", SID, "--cwd", str(repo), "--", "--model", "opus"],
                  manager_factory=lambda debug: manager)
        assert rc == 0
        (teleport, kw1), (resume_call, kw2) = calls
        assert teleport == [FAKE_CLAUDE, "--model", "opus", "--teleport", SID]
        assert kw1["env"]["CLAUDE_CONFIG_DIR"] == str(manager.profile("1"))
        assert resume_call == [FAKE_CLAUDE, "--model", "opus", "--resume", SID]
        assert kw2["env"]["CLAUDE_CONFIG_DIR"] == str(manager.profile("2"))
        source = manager.profile("1") / "projects" / project_slug(repo.resolve()) / f"{SID}.jsonl"
        placed = manager.profile("2") / "projects" / project_slug(repo.resolve()) / f"{SID}.jsonl"
        assert placed.read_bytes() == source.read_bytes()
        assert (placed.parent / SID / "subagents" / "agent-a.jsonl").exists()

    def test_skip_teleport_uses_the_transcript_already_there(self, tmp_path, repo, launches):
        calls, _ = launches
        manager = MoveManager(tmp_path)
        _write_transcript(manager.profile("1"), repo.resolve())
        assert main(["move", "--from", "1", "--to", "2", "--skip-teleport", "--cwd", str(repo)],
                    manager_factory=lambda debug: manager) == 0
        assert [c[0][-2:] for c in calls] == [["--resume", SID]]

    def test_a_dirty_tree_stops_before_teleport(self, tmp_path, repo, launches):
        calls, _ = launches
        (repo / "README").write_text("dirty\n")
        assert main(["move", "--from", "1", "--to", "2", "--cwd", str(repo)],
                    manager_factory=lambda debug: MoveManager(tmp_path)) == 1
        assert calls == []

    def test_a_failed_teleport_moves_nothing(self, tmp_path, repo, launches):
        calls, behaviour = launches
        behaviour["rc"] = 1
        manager = MoveManager(tmp_path)
        assert main(["move", "--from", "1", "--to", "2", "--cwd", str(repo)],
                    manager_factory=lambda debug: manager) == 1
        assert len(calls) == 1 and not manager.profile("2").exists()

    def test_no_transcript_after_teleport_is_an_error(self, tmp_path, repo, launches):
        calls, behaviour = launches
        behaviour["teleport_writes"] = False
        assert main(["move", "--from", "1", "--to", "2", "--cwd", str(repo)],
                    manager_factory=lambda debug: MoveManager(tmp_path)) == 1
        assert len(calls) == 1

    def test_refuses_the_same_account_and_an_api_key_source(self, tmp_path, repo, launches):
        calls, _ = launches
        factory = lambda debug: MoveManager(tmp_path)  # noqa: E731
        assert main(["move", "--from", "1", "--to", "1", "--cwd", str(repo)], manager_factory=factory) == 1
        assert main(["move", "--from", "3", "--to", "2", "--cwd", str(repo)], manager_factory=factory) == 1
        assert calls == []

    def test_a_different_session_in_the_target_needs_force(self, tmp_path, repo, launches):
        calls, _ = launches
        manager = MoveManager(tmp_path)
        _write_transcript(manager.profile("1"), repo.resolve())
        clash = manager.profile("2") / "projects" / project_slug(repo.resolve()) / f"{SID}.jsonl"
        clash.parent.mkdir(parents=True)
        clash.write_text("other\n")
        args = ["move", "--from", "1", "--to", "2", "--skip-teleport", "--cwd", str(repo)]
        assert main(args, manager_factory=lambda debug: manager) == 1
        assert calls == [] and clash.read_text() == "other\n"
        assert main([*args, "--force"], manager_factory=lambda debug: manager) == 0
        assert clash.read_bytes() != b"other\n"
