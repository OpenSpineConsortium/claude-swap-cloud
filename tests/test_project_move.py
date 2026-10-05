"""Tests for `cswap project-move` (claude_swap.project_move + the CLI stage)."""

from __future__ import annotations

import io
import json
import subprocess
import sys
import urllib.error
from pathlib import Path
from unittest.mock import patch

import pytest

from claude_swap import cli
from claude_swap import project_move as pm
from claude_swap.exceptions import ValidationError


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _run(argv: list[str], capsys) -> tuple[int, str, str]:
    """Run `cswap project-move <argv>` with the browser and clipboard stubbed out."""
    with patch("os.geteuid", return_value=1000, create=True), \
         patch.object(sys, "argv", ["cswap", "project-move", *argv]), \
         patch.object(pm, "open_url", return_value=True), \
         patch.object(pm, "copy_to_clipboard", return_value=None):
        code = 0
        try:
            cli.main()
        except SystemExit as e:
            code = e.code or 0
    captured = capsys.readouterr()
    return code, captured.out, captured.err


class _FakeResponse:
    def __init__(self, status: int, payload: dict | None):
        self.status = status
        self._body = json.dumps(payload or {}).encode()

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _fake_github(routes: dict[str, tuple[int, dict | None]]):
    """A urlopen stand-in: ``routes`` maps API paths to (status, json body)."""
    calls: list[tuple[str, dict]] = []

    def urlopen(req, timeout=None):
        path = req.full_url.removeprefix("https://api.github.com")
        calls.append((path, dict(req.header_items())))
        status, payload = routes.get(path, (404, None))
        if status != 200:
            raise urllib.error.HTTPError(req.full_url, status, "nope", {}, io.BytesIO(b""))
        return _FakeResponse(status, payload)

    urlopen.calls = calls  # type: ignore[attr-defined]
    return urlopen


REPO = "owner/name"
_REPO_PRIVATE = {"private": True, "default_branch": "main"}
_REPO_PUBLIC = {"private": False, "default_branch": "main"}


def _state_root(temp_home: Path) -> Path:
    from claude_swap.paths import get_backup_root

    return get_backup_root()


# ---------------------------------------------------------------------------
# normalize_repo / state
# ---------------------------------------------------------------------------


class TestNormalizeRepo:
    @pytest.mark.parametrize(
        "spec",
        [
            "owner/name",
            "https://github.com/owner/name",
            "https://github.com/owner/name.git",
            "https://github.com/owner/name/",
            "git@github.com:owner/name.git",
            "  owner/name  ",
        ],
    )
    def test_accepts_github_spellings(self, spec):
        assert pm.normalize_repo(spec) == "owner/name"

    @pytest.mark.parametrize("spec", ["name", "owner/", "/name", "owner/name/extra", "", "owner name"])
    def test_rejects_other_shapes(self, spec):
        with pytest.raises(ValidationError):
            pm.normalize_repo(spec)

    @pytest.mark.parametrize("spec", ["OWNER/NAME", " OWNER/NAME ", "https://github.com/OWNER/NAME.git"])
    def test_rejects_the_step_list_placeholder(self, spec):
        # The step list prints `export OWNER/NAME`; pasting it back into a
        # shell must not run the stage with the placeholder.
        with pytest.raises(ValidationError, match="placeholder"):
            pm.normalize_repo(spec)


class TestMoveState:
    def test_round_trip(self, tmp_path):
        state = pm.MoveState(repo=REPO, branch="b", exported_at="t1")
        state.save(tmp_path)
        loaded = pm.MoveState.load(tmp_path)
        assert (loaded.repo, loaded.branch, loaded.exported_at) == (REPO, "b", "t1")
        assert loaded.imported_at == ""

    def test_missing_or_corrupt_file_is_fresh_state(self, tmp_path):
        assert pm.MoveState.load(tmp_path).repo == ""
        (tmp_path / pm.STATE_FILE).write_text("{not json", encoding="utf-8")
        state = pm.MoveState.load(tmp_path)
        assert state.repo == ""
        assert state.branch == pm.DEFAULT_BRANCH

    def test_placeholder_saved_by_an_older_version_is_dropped(self, tmp_path):
        pm.MoveState(repo="OWNER/NAME", exported_at="t", branch="other").save(tmp_path)
        state = pm.MoveState.load(tmp_path)
        assert state.repo == ""
        assert state.exported_at == ""
        assert state.branch == pm.DEFAULT_BRANCH

    def test_resolve_repo_prefers_argument_then_memory(self):
        state = pm.MoveState(repo="remembered/one")
        assert pm.resolve_repo(state, "https://github.com/given/two") == "given/two"
        assert pm.resolve_repo(state, None) == "remembered/one"
        with pytest.raises(ValidationError, match="No repository"):
            pm.resolve_repo(pm.MoveState(), None)


# ---------------------------------------------------------------------------
# prompts
# ---------------------------------------------------------------------------


class TestPrompts:
    @pytest.mark.parametrize("stage", ["export", "import"])
    def test_prompt_mentions_repo_branch_and_dir(self, stage):
        text = pm.render_prompt(stage, "acme/widgets", "my-branch")
        assert "acme/widgets" in text
        assert "my-branch" in text
        assert pm.EXPORT_DIR in text
        # Every placeholder got filled.
        assert "{" not in text and "}" not in text
        assert text.endswith("\n")

    def test_export_prompt_is_pushed_without_a_pr_and_skips_secrets(self):
        text = pm.render_prompt("export", REPO)
        assert "do not open a pull request" in text
        assert "secret" in text
        assert "memory/" in text and "files/" in text and "timeline.md" in text

    def test_import_prompt_restores_memory_and_files_and_keeps_history(self):
        text = pm.render_prompt("import", REPO)
        assert "memory" in text
        assert "shared files" in text
        assert pm.HISTORY_DIR in text
        assert f"Do not push anything to {REPO}" in text

    def test_prompts_are_ascii(self):
        # clip.exe on Windows reads the console code page; keep the prompts
        # plain ASCII so a paste never arrives garbled.
        for stage in ("export", "import"):
            pm.render_prompt(stage, REPO).encode("ascii")

    def test_unknown_stage(self):
        with pytest.raises(ValueError):
            pm.render_prompt("delete", REPO)

    def test_write_prompt_file(self, tmp_path):
        path = pm.write_prompt_file(tmp_path, "export", "hello\n")
        assert path == tmp_path / pm.PROMPT_DIR / "export-prompt.md"
        assert path.read_text(encoding="utf-8") == "hello\n"


# ---------------------------------------------------------------------------
# clipboard / browser
# ---------------------------------------------------------------------------


class TestClipboard:
    def test_windows_uses_clip(self):
        with patch.object(pm.shutil, "which", return_value="C:/Windows/clip.exe"), \
             patch.object(pm.subprocess, "run", return_value=subprocess.CompletedProcess(["clip"], 0)) as run:
            assert pm.copy_to_clipboard("text", platform="win32") == "clip"
        assert run.call_args.args[0] == ["clip"]
        assert run.call_args.kwargs["input"] == b"text"

    def test_macos_uses_pbcopy(self):
        with patch.object(pm.shutil, "which", return_value="/usr/bin/pbcopy"), \
             patch.object(pm.subprocess, "run", return_value=subprocess.CompletedProcess(["pbcopy"], 0)):
            assert pm.copy_to_clipboard("text", platform="darwin") == "pbcopy"

    def test_linux_falls_through_to_the_first_installed_tool(self):
        def which(name):
            return "/usr/bin/xclip" if name == "xclip" else None

        with patch.object(pm.shutil, "which", side_effect=which), \
             patch.object(pm.subprocess, "run", return_value=subprocess.CompletedProcess(["xclip"], 0)) as run:
            assert pm.copy_to_clipboard("text", platform="linux") == "xclip"
        assert run.call_args.args[0][0] == "xclip"

    def test_no_tool_or_failing_tool_returns_none(self):
        with patch.object(pm.shutil, "which", return_value=None):
            assert pm.copy_to_clipboard("text", platform="linux") is None
        with patch.object(pm.shutil, "which", return_value="/usr/bin/pbcopy"), \
             patch.object(pm.subprocess, "run", return_value=subprocess.CompletedProcess(["pbcopy"], 1)):
            assert pm.copy_to_clipboard("text", platform="darwin") is None
        with patch.object(pm.shutil, "which", return_value="/usr/bin/pbcopy"), \
             patch.object(pm.subprocess, "run", side_effect=OSError("boom")):
            assert pm.copy_to_clipboard("text", platform="darwin") is None

    def test_open_url_swallows_browser_errors(self):
        with patch.object(pm.webbrowser, "open", side_effect=RuntimeError("no display")):
            assert pm.open_url("https://example.invalid") is False
        with patch.object(pm.webbrowser, "open", return_value=True) as opened:
            assert pm.open_url("https://example.invalid") is True
        assert opened.call_args.args[0] == "https://example.invalid"


# ---------------------------------------------------------------------------
# GitHub checks
# ---------------------------------------------------------------------------


class TestCheckRepo:
    def test_export_ready_when_branch_and_readme_exist(self):
        urlopen = _fake_github({
            f"/repos/{REPO}": (200, _REPO_PRIVATE),
            f"/repos/{REPO}/branches/project-export": (200, {}),
            f"/repos/{REPO}/contents/{pm.EXPORT_DIR}/README.md?ref=project-export": (200, {}),
        })
        with patch.object(pm.urllib.request, "urlopen", urlopen):
            result = pm.check_repo(REPO, "project-export", token="tok")
        assert result.exists is True
        assert result.private is True
        assert result.branch_exists is True
        assert result.export_readme is True
        assert result.export_ready
        assert result.error == ""
        # The token rides along as a bearer header on every call.
        assert all(h.get("Authorization") == "Bearer tok" for _, h in urlopen.calls)

    def test_branch_without_readme_is_not_ready(self):
        urlopen = _fake_github({
            f"/repos/{REPO}": (200, _REPO_PUBLIC),
            f"/repos/{REPO}/branches/project-export": (200, {}),
        })
        with patch.object(pm.urllib.request, "urlopen", urlopen):
            result = pm.check_repo(REPO, "project-export")
        assert result.private is False
        assert result.branch_exists is True
        assert result.export_readme is False
        assert not result.export_ready
        assert not any("Authorization" in h for _, h in urlopen.calls)

    def test_missing_branch(self):
        urlopen = _fake_github({f"/repos/{REPO}": (200, _REPO_PUBLIC)})
        with patch.object(pm.urllib.request, "urlopen", urlopen):
            result = pm.check_repo(REPO, "project-export")
        assert result.branch_exists is False
        assert result.export_readme is False
        assert len(urlopen.calls) == 2  # no README lookup without a branch

    def test_404_without_token_is_ambiguous(self):
        with patch.object(pm.urllib.request, "urlopen", _fake_github({})):
            result = pm.check_repo(REPO, "project-export")
        assert result.exists is None
        assert "private" in result.error

    def test_404_with_token_means_missing(self):
        with patch.object(pm.urllib.request, "urlopen", _fake_github({})):
            result = pm.check_repo(REPO, "project-export", token="tok")
        assert result.exists is False
        assert result.error == "repository not found"

    def test_403_is_reported_not_raised(self):
        with patch.object(pm.urllib.request, "urlopen", _fake_github({f"/repos/{REPO}": (403, None)})):
            result = pm.check_repo(REPO, "project-export")
        assert result.exists is None
        assert "refused" in result.error

    def test_network_error_is_reported_not_raised(self):
        with patch.object(pm.urllib.request, "urlopen", side_effect=urllib.error.URLError("down")):
            result = pm.check_repo(REPO, "project-export")
        assert result.exists is None
        assert "unreachable" in result.error

    def test_github_token_order(self, monkeypatch):
        monkeypatch.setenv("GITHUB_TOKEN", "env-gh")
        monkeypatch.setenv("GH_TOKEN", "env-ghcli")
        assert pm.github_token("flag") == "flag"
        assert pm.github_token(None) == "env-gh"
        monkeypatch.delenv("GITHUB_TOKEN")
        assert pm.github_token("  ") == "env-ghcli"
        monkeypatch.delenv("GH_TOKEN")
        assert pm.github_token(None) is None


# ---------------------------------------------------------------------------
# steps
# ---------------------------------------------------------------------------


class TestSteps:
    def test_fresh_state_marks_the_first_step_next(self):
        rows = pm.steps(pm.MoveState())
        assert [s for s, _, _ in rows] == ["next", "todo", "todo", "todo", "todo", "todo"]
        command, hint = rows[0][2].splitlines()
        assert command == "cswap project-move export OWNER/NAME"
        # Until a repository is known, say which name goes there.
        assert "not the project's name" in hint

    def test_remembered_repo_needs_no_hint(self):
        rows = pm.steps(pm.MoveState(repo=REPO))
        assert rows[0][2] == f"cswap project-move export {REPO}"

    def test_progress_moves_the_next_marker(self):
        state = pm.MoveState(repo=REPO, exported_at="t")
        assert [s for s, _, _ in pm.steps(state)] == ["done", "done", "next", "todo", "todo", "todo"]
        state.branch_seen_at = "t"
        assert [s for s, _, _ in pm.steps(state)][2:4] == ["done", "next"]
        state.imported_at = "t"
        assert all(s == "done" for s, _, _ in pm.steps(state))

    def test_live_check_overrides_remembered_branch(self):
        state = pm.MoveState(repo=REPO, exported_at="t", branch_seen_at="t")
        not_ready = pm.RepoCheck(repo=REPO, branch="project-export", branch_exists=False)
        assert [s for s, _, _ in pm.steps(state, not_ready)][2] == "next"

    def test_non_default_branch_is_spelled_out(self):
        rows = pm.steps(pm.MoveState(repo=REPO, branch="other"))
        assert rows[0][2] == f"cswap project-move export {REPO} --branch other"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


class TestCli:
    def test_export_renders_saves_and_remembers(self, temp_home, capsys):
        with patch.object(pm, "check_repo", return_value=pm.RepoCheck(repo=REPO, branch="x", private=True)):
            code, out, err = _run(["export", f"https://github.com/{REPO}", "--no-open", "--print"], capsys)
        assert code == 0
        assert "Export this project into the owner/name repository" in out
        assert "Saved the export prompt to" in out
        assert "OLD project" in out and "SOURCE account" in out
        assert "project-move check --wait" in out
        root = _state_root(temp_home)
        assert (root / pm.PROMPT_DIR / "export-prompt.md").read_text(encoding="utf-8").startswith("Export this project")
        state = pm.MoveState.load(root)
        assert state.repo == REPO
        assert state.exported_at
        assert state.imported_at == ""

    def test_export_warns_when_the_repo_is_public(self, temp_home, capsys):
        with patch.object(pm, "check_repo", return_value=pm.RepoCheck(repo=REPO, branch="x", exists=True, private=False)):
            code, out, _ = _run(["export", REPO, "--no-open"], capsys)
        assert code == 0
        assert "PUBLIC" in out

    def test_export_copies_to_clipboard_and_opens_browser(self, temp_home, capsys):
        with patch("os.geteuid", return_value=1000, create=True), \
             patch.object(sys, "argv", ["cswap", "project-move", "export", REPO, "--url", "https://claude.ai/code/x"]), \
             patch.object(pm, "check_repo", return_value=pm.RepoCheck(repo=REPO, branch="x")), \
             patch.object(pm, "open_url", return_value=True) as opened, \
             patch.object(pm, "copy_to_clipboard", return_value="clip") as copied:
            cli.main()
        out = capsys.readouterr().out
        assert "Copied the export prompt to the clipboard (clip)" in out
        assert copied.call_args.args[0].startswith("Export this project")
        assert opened.call_args.args[0] == "https://claude.ai/code/x"
        assert "Opened https://claude.ai/code/x" in out

    def test_export_without_repo_and_no_memory_errors(self, temp_home, capsys):
        code, out, err = _run(["export", "--no-open"], capsys)
        assert code == 1
        assert "No repository" in err

    def test_placeholder_repo_errors_and_remembers_nothing(self, temp_home, capsys):
        with patch.object(pm, "check_repo") as check:
            code, _, err = _run(["export", "OWNER/NAME"], capsys)
        assert code == 1
        assert "placeholder" in err
        assert check.call_count == 0
        assert not (_state_root(temp_home) / pm.STATE_FILE).exists()
        # The step list still starts from the top afterwards.
        code, out, _ = _run([], capsys)
        assert code == 0
        assert "[next] 1." in out

    def test_bad_repo_spec_errors(self, temp_home, capsys):
        # A project's name is the likely mistake; the error says what to give.
        code, _, err = _run(["export", "beethoven", "--no-open"], capsys)
        assert code == 1
        assert "Not a GitHub repository: 'beethoven'" in err
        assert "not the project's name" in err

    def test_import_uses_the_remembered_repo(self, temp_home, capsys):
        with patch.object(pm, "check_repo", return_value=pm.RepoCheck(repo=REPO, branch="x")):
            _run(["export", REPO, "--no-open", "--branch", "custom"], capsys)
        code, out, _ = _run(["import", "--no-open", "--print"], capsys)
        assert code == 0
        assert "from the `custom` branch of owner/name" in out
        assert "NEW project" in out and "DESTINATION account" in out
        state = pm.MoveState.load(_state_root(temp_home))
        assert state.branch == "custom"
        assert state.imported_at

    def test_check_not_ready_exits_2(self, temp_home, capsys):
        result = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=False, export_readme=False)
        with patch.object(pm, "check_repo", return_value=result):
            code, out, _ = _run(["check", REPO], capsys)
        assert code == 2
        assert "PRIVATE" in out
        assert "not pushed yet" in out

    def test_check_ready_records_and_points_at_import(self, temp_home, capsys):
        result = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=True, export_readme=True)
        with patch.object(pm, "check_repo", return_value=result):
            code, out, _ = _run(["check", REPO], capsys)
        assert code == 0
        assert "Export is up" in out
        assert "project-move import" in out
        assert pm.MoveState.load(_state_root(temp_home)).branch_seen_at

    def test_check_wait_polls_until_ready(self, temp_home, capsys):
        waiting = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=False, export_readme=False)
        ready = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=True, export_readme=True)
        with patch.object(pm, "check_repo", side_effect=[waiting, waiting, ready]) as check, \
             patch.object(cli.time, "sleep") as sleep:
            code, out, _ = _run(["check", REPO, "--wait", "5"], capsys)
        assert code == 0
        assert check.call_count == 3
        assert sleep.call_count == 2
        assert sleep.call_args.args == (5,)
        assert "Checking again in 5s" in out

    def test_check_wait_gives_up_at_timeout(self, temp_home, capsys):
        waiting = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=False)
        clock = iter([0.0, 0.0, 100.0])
        with patch.object(pm, "check_repo", return_value=waiting), \
             patch.object(cli.time, "sleep"), \
             patch.object(cli.time, "monotonic", side_effect=lambda: next(clock, 100.0)):
            code, _, err = _run(["check", REPO, "--wait", "--timeout", "10"], capsys)
        assert code == 2
        assert "Gave up after 10s" in err

    def test_check_missing_repo_does_not_wait(self, temp_home, capsys):
        missing = pm.RepoCheck(repo=REPO, branch="project-export", exists=False, error="repository not found")
        with patch.object(pm, "check_repo", return_value=missing) as check, \
             patch.object(cli.time, "sleep") as sleep:
            code, _, err = _run(["check", REPO, "--wait", "--token", "t"], capsys)
        assert code == 2
        assert "not found" in err
        assert check.call_count == 1
        assert sleep.call_count == 0

    def test_check_passes_the_token_through(self, temp_home, capsys):
        ready = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=True, export_readme=True)
        with patch.object(pm, "check_repo", return_value=ready) as check:
            _run(["check", REPO, "--token", "sekrit"], capsys)
        assert check.call_args.args == (REPO, "project-export", "sekrit")

    def test_steps_fresh(self, temp_home, capsys):
        code, out, _ = _run([], capsys)
        assert code == 0
        assert "Project move via GitHub repository OWNER/NAME" in out
        assert "[next] 1." in out
        assert "cswap project-move export OWNER/NAME" in out
        assert "not the project's name" in out
        assert out.count("[    ]") == 5

    def test_steps_after_export_consults_github_once(self, temp_home, capsys):
        with patch.object(pm, "check_repo", return_value=pm.RepoCheck(repo=REPO, branch="x")):
            _run(["export", REPO, "--no-open"], capsys)
        ready = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=True, export_readme=True)
        with patch.object(pm, "check_repo", return_value=ready) as check:
            code, out, _ = _run(["steps"], capsys)
        assert code == 0
        assert check.call_count == 1
        assert "[done] 3." in out
        assert "[next] 4." in out
        # Once seen, the branch is remembered; no further GitHub calls.
        with patch.object(pm, "check_repo") as check:
            _run([], capsys)
        assert check.call_count == 0

    def test_help_lists_the_stages(self, capsys):
        with patch.object(sys, "argv", ["cswap", "project-move", "--help"]):
            with pytest.raises(SystemExit) as e:
                cli.main()
        assert e.value.code == 0
        out = capsys.readouterr().out
        assert "export OWNER/NAME" in out
        assert "check [--wait]" in out
        assert "import [OWNER/NAME]" in out
        assert "not the project's name" in out

    def test_main_help_mentions_project_move(self, capsys):
        with patch.object(sys, "argv", ["cswap", "--help"]):
            with pytest.raises(SystemExit):
                cli.main()
        assert "project-move" in capsys.readouterr().out
