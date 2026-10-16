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
