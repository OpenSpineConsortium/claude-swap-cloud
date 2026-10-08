"""`cswap project-move import` through the extension bridge: the CLI's side.

The host, the job files and the event tail are tested in tests/test_bridge.py;
here the import stage is held to its routing (bridge or paste), what it
queues, what it records, and how it ends. The registry, the browser and the
extension are stood in for.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from claude_swap import bridge, cli, paths
from claude_swap import project_move as pm
from claude_swap.switcher import ClaudeAccountSwitcher

ACCOUNTS = {
    "1": ("a@example.com", "org-a", "oauth"),
    "2": ("b@example.com", "org-b", "oauth"),
    "3": ("key@example.com", "org-c", "api_key"),
}

LINK = "https://claude.ai/code/project/chan_01NEWNEWNEWNEWNEWNEWNEW00"


def _resolve(self, identifier: str) -> tuple[str, str, str]:
    for num, (email, org, _kind) in ACCOUNTS.items():
        if identifier in (num, email):
            return num, email, org
    from claude_swap.exceptions import AccountNotFoundError

    raise AccountNotFoundError(identifier)


def _kind(self, num: str) -> str:
    return ACCOUNTS[num][2]


def _make_export(parent: Path, name: str = "Demo") -> Path:
    """A small finished Claude Code export, laid out as project-export.js lays one out."""
    root = parent / name
    files = {"Files/notes.md": b"# notes\n", "Files/data/table.csv": b"a,b\n1,2\n"}
    history = {"Timeline.md": b"timeline\n", "Threads/001 Kick-off.md": b"thread\n"}
    for relative, data in {**files, **history, "Channel Info.md": b"About.\n"}.items():
        target = root.joinpath(*relative.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    manifest = {
        "format": pm.MANIFEST_FORMAT,
        "version": pm.MANIFEST_VERSION,
        "kind": "code",
        "name": name,
        "files": [
            {"path": path, "name": path.removeprefix("Files/"), "type": "project_file", "bytes": len(data)}
            for path, data in files.items()
        ],
        "history": [{"path": path, "title": Path(path).stem, "type": "thread"} for path in history],
        "problems": [],
    }
    (root / pm.MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    return root


@pytest.fixture
def exports(temp_home: Path) -> Path:
    folder = temp_home / pm.DEFAULT_EXPORTS_DIRNAME
    folder.mkdir()
    return folder


@pytest.fixture
def root(temp_home: Path) -> Path:
    return paths.get_backup_root()


def _outcome(status: str, **extra) -> bridge.ImportOutcome:
    values = dict(status=status, link=LINK, name="Demo", summary="Done", message="Done", job_id="")
    values.update(extra)
    return bridge.ImportOutcome(**values)


def _run(argv: list[str], capsys, *, installed: bool = True, outcomes: list | None = None):
    """Run `cswap project-move <argv>` with the registry, browser, clipboard and extension stood in for.

    Returns (exit code, stdout, stderr, the run_import calls, the open_url mock, the clipboard mock).
    """
    calls: list[tuple[bridge.Job, dict]] = []
    queue = list(outcomes or [])

    def run_import(root, job, **kwargs):
        calls.append((job, kwargs))
        return queue.pop(0) if queue else _outcome("done", job_id=job.id)

    with patch("os.geteuid", return_value=1000, create=True), \
         patch.object(sys, "argv", ["cswap", "project-move", *argv]), \
         patch.object(pm, "open_url", return_value=True) as opened, \
         patch.object(pm, "copy_to_clipboard", return_value=None) as copied, \
         patch.object(bridge, "is_installed", return_value=installed), \
         patch.object(bridge, "run_import", side_effect=run_import), \
         patch.object(ClaudeAccountSwitcher, "resolve_account", _resolve), \
         patch.object(ClaudeAccountSwitcher, "_account_kind", _kind):
        code = 0
        try:
            cli.main()
        except SystemExit as e:
            code = e.code or 0
    captured = capsys.readouterr()
    return code, captured.out, captured.err, calls, opened, copied


class TestRouting:
    def test_installed_and_to_goes_through_the_bridge(self, exports, root, capsys):
        export = _make_export(exports)
        code, out, err, calls, opened, copied = _run(["import", "--to", "2"], capsys)
        assert code == 0, err
        assert "Import job job_" in out
        assert "Demo (Claude Code project;" in out
        assert "into Account-2 (b@example.com) is queued." in out
        assert "Chrome picks it up when a claude.ai page loads" in out
        # The script is not handed out: the extension fetches it from the host.
        assert copied.call_count == 0
        assert "Saved the import script" not in out
        assert opened.call_args.args[0] == pm.CLAUDE_URL

        job = bridge.load_job(root)
        assert job is not None and job.status == "queued"
        assert job.account == {"slot": "2", "email": "b@example.com", "org_uuid": "org-b"}
        assert job.export["name"] == "Demo" and job.export["kind"] == "code"
        assert Path(job.export["path"]) == export
        assert job.script["sha256"] == bridge.script_sha256(pm.script_text("import"))
        assert job.name is None
        [(followed, kwargs)] = calls
        assert followed.id == job.id and kwargs == {"wait": True}

        state = pm.MoveState.load(root)
        assert state.carrier == pm.CARRIER_FOLDER
        assert state.export_path == str(export)
        assert state.export_seen_at and state.imported_at

    def test_the_name_goes_into_the_job(self, exports, root, capsys):
        _make_export(exports)
        code, *_ = _run(["import", "--to", "2", "--name", "Symphony no. 9", "--no-open"], capsys)
        assert code == 0
        assert bridge.load_job(root).name == "Symphony no. 9"

    def test_to_by_email(self, exports, root, capsys):
        _make_export(exports)
        code, out, *_ = _run(["import", "--to", "b@example.com", "--no-open"], capsys)
        assert code == 0
        assert "Account-2 (b@example.com)" in out

    def test_without_to_the_paste_route_hints_at_it(self, exports, root, capsys):
        _make_export(exports)
        code, out, err, calls, opened, copied = _run(["import", "--no-open"], capsys)
        assert code == 0
        assert "Saved the import script to" in out
        assert "pass --to NUM|EMAIL" in out
        assert calls == [] and bridge.load_job(root) is None

    def test_not_installed_hints_at_the_setup(self, exports, root, capsys):
        _make_export(exports)
        code, out, err, calls, *_ = _run(["import", "--to", "2", "--no-open"], capsys, installed=False)
        assert code == 0
        assert "Saved the import script to" in out
        assert "cswap bridge install --register" in out
        assert "Allow User Scripts" not in out
        assert calls == [] and bridge.load_job(root) is None

    def test_clipboard_forces_the_paste_route(self, exports, root, capsys):
        _make_export(exports)
        code, out, err, calls, *_ = _run(["import", "--to", "2", "--clipboard", "--no-open"], capsys)
        assert code == 0
        assert "Saved the import script to" in out
        assert "pass --to" not in out and "bridge install" not in out
        assert calls == [] and bridge.load_job(root) is None

    def test_bridge_without_the_install_errors(self, exports, root, capsys):
        _make_export(exports)
        code, out, err, calls, *_ = _run(["import", "--bridge", "--to", "2"], capsys, installed=False)
        assert code == 1
        assert "not installed" in err and "cswap bridge install --register" in err
        assert calls == []

    def test_bridge_without_to_errors(self, exports, root, capsys):
        _make_export(exports)
        code, out, err, *_ = _run(["import", "--bridge"], capsys)
        assert code == 1
        assert "--bridge needs --to" in err

    def test_bridge_and_clipboard_together_are_a_usage_error(self, exports, capsys):
        code, *_ = _run(["import", "--bridge", "--clipboard"], capsys)
        assert code == 2

    def test_watch_and_cancel_belong_to_import(self, exports, capsys):
        assert _run(["check", "--watch"], capsys)[0] == 2
        assert _run(["export", "--cancel"], capsys)[0] == 2

    def test_other_stages_are_untouched_by_the_bridge(self, exports, root, capsys):
        code, out, err, calls, *_ = _run(["export", "--no-open"], capsys)
        assert code == 0 and "Saved the export script to" in out
        assert calls == []


class TestWhatIsRefused:
    def test_api_key_account(self, exports, root, capsys):
        _make_export(exports)
        code, out, err, calls, *_ = _run(["import", "--to", "3"], capsys)
        assert code == 1
        assert "API-key account" in err
        assert calls == [] and bridge.load_job(root) is None

    def test_unknown_account(self, exports, root, capsys):
        _make_export(exports)
        code, out, err, *_ = _run(["import", "--to", "9"], capsys)
        assert code == 1
        assert bridge.load_job(root) is None

    def test_no_finished_export(self, exports, root, capsys):
        code, out, err, calls, *_ = _run(["import", "--to", "2"], capsys)
        assert code == 1
        assert "No finished export" in err and "project-move check" in err
        assert bridge.load_job(root) is None

    def test_several_exports_need_a_folder(self, exports, root, capsys):
        _make_export(exports, "One")
        _make_export(exports, "Two")
        code, out, err, *_ = _run(["import", "--to", "2"], capsys)
        assert code == 1
        assert "name one with --folder" in err.lower() or "Name it with --folder" in err
        assert bridge.load_job(root) is None

    def test_one_of_several_named_with_folder(self, exports, root, capsys):
        _make_export(exports, "One")
        two = _make_export(exports, "Two")
        code, out, err, *_ = _run(["import", "--to", "2", "--folder", str(two), "--no-open"], capsys)
        assert code == 0, err
        assert bridge.load_job(root).export["name"] == "Two"

    def test_a_queued_job_refuses_a_second(self, exports, root, capsys):
        export = _make_export(exports)
        first = bridge.new_job(
            root,
            export=pm.read_export(export),
            account=("2", "b@example.com", "org-b"),
            name=None,
            script_text=pm.script_text("import"),
        )
        code, out, err, calls, *_ = _run(["import", "--to", "2"], capsys)
        assert code == 1
        assert "already queued or running" in err and first.id in err
        assert bridge.load_job(root).id == first.id

    def test_a_running_cli_refuses_a_second(self, exports, root, capsys):
        _make_export(exports)
        with bridge.ImportLock(root):
            code, out, err, calls, *_ = _run(["import", "--to", "2"], capsys)
        assert code == 1
        assert "already running" in err
        assert calls == []


class TestHowItEnds:
    def test_failed_exits_1_and_leaves_the_move_unfinished(self, exports, root, capsys):
        _make_export(exports)
        code, out, err, *_ = _run(
            ["import", "--to", "2", "--no-open"], capsys,
            outcomes=[_outcome("failed", message="The page went away")],
        )
        assert code == 1
        assert pm.MoveState.load(root).imported_at == ""

    def test_cancelled_exits_130(self, exports, root, capsys):
        _make_export(exports)
        code, *_ = _run(["import", "--to", "2", "--no-open"], capsys, outcomes=[_outcome("cancelled")])
        assert code == 130
        assert pm.MoveState.load(root).imported_at == ""

    def test_done_paused_says_so(self, exports, root, capsys):
        _make_export(exports)
        code, out, *_ = _run(["import", "--to", "2", "--no-open"], capsys, outcomes=[_outcome("done", paused=True)])
        assert code == 0
        assert "arrived paused" in out
        assert pm.MoveState.load(root).imported_at

    def test_no_wait_queues_and_returns(self, exports, root, capsys):
        _make_export(exports)
        code, out, err, calls, *_ = _run(
            ["import", "--to", "2", "--no-wait", "--no-open"], capsys, outcomes=[_outcome("queued", link="")],
        )
        assert code == 0
        assert calls[0][1] == {"wait": False}
        assert "project-move import --watch" in out
        assert pm.MoveState.load(root).imported_at == ""

    def test_detached_exits_0_without_marking_the_import_done(self, exports, root, capsys):
        _make_export(exports)
        code, *_ = _run(["import", "--to", "2", "--no-open"], capsys, outcomes=[_outcome("detached", link="")])
        assert code == 0
        assert pm.MoveState.load(root).imported_at == ""


class TestWatchAndCancel:
    def _queue(self, exports: Path, root: Path) -> bridge.Job:
        export = _make_export(exports)
        return bridge.new_job(
            root,
            export=pm.read_export(export),
            account=("2", "b@example.com", "org-b"),
            name=None,
            script_text=pm.script_text("import"),
        )

    def test_cancel_asks_the_extension(self, exports, root, capsys):
        job = self._queue(exports, root)
        code, out, err, calls, *_ = _run(["import", "--cancel"], capsys)
        assert code == 0
        assert f"stop job {job.id}" in out
        assert bridge.load_job(root).cancel_requested is True
        assert calls == []
        # Asking twice is harmless.
        code, out, *_ = _run(["import", "--cancel"], capsys)
        assert code == 0 and "already stopping" in out

    def test_cancel_with_nothing_queued(self, exports, root, capsys):
        code, out, *_ = _run(["import", "--cancel"], capsys)
        assert code == 0
        assert "No import is queued or running" in out

    def test_watch_reattaches_to_the_job(self, exports, root, capsys):
        job = self._queue(exports, root)
        code, out, err, calls, *_ = _run(["import", "--watch"], capsys, outcomes=[_outcome("done")])
        assert code == 0
        assert f"Following job {job.id}" in out
        assert [followed.id for followed, _ in calls] == [job.id]
        assert pm.MoveState.load(root).imported_at

    def test_watch_without_a_job(self, exports, root, capsys):
        code, out, err, *_ = _run(["import", "--watch"], capsys)
        assert code == 1
        assert "No import job here" in err

    def test_watch_of_a_finished_job_reports_it(self, exports, root, capsys):
        job = self._queue(exports, root)
        job.status = "done"
        job.created_project = {"id": "chan_x", "name": "Demo", "url": LINK, "at": ""}
        bridge.save_job(root, job)
        code, out, err, calls, *_ = _run(["import", "--watch"], capsys)
        assert code == 0
        assert f"Job {job.id} is done." in out and LINK in out
        assert calls == []
