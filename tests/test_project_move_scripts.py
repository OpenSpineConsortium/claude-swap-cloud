"""The browser scripts behind `cswap project-move`, run under Node.

project-export.js and project-import.js run in a claude.ai tab, so their own
tests are JavaScript: tests/js/ loads each script into a sandbox that stands
in for the tab (its button, its folder picker, its fetch) and for claude.ai
itself. Nothing in them reaches the network, and they need Node 20 or newer
and nothing else.

The tests here run those suites, and then hold the two languages to one idea
of what an export looks like on disk: the export script writes a folder, and
`cswap project-move check` reads it.

All of it is skipped where Node is not installed.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from claude_swap import cli
from claude_swap import project_move as pm

JS = Path(__file__).parent / "js"
MIN_NODE = 20


def _node() -> str | None:
    """A Node new enough for tests/js, or None."""
    exe = shutil.which("node")
    if exe is None:
        return None
    try:
        said = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=60).stdout
        major = int(said.strip().lstrip("v").split(".")[0])
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    return exe if major >= MIN_NODE else None


NODE = _node()
pytestmark = pytest.mark.skipif(NODE is None, reason=f"needs Node {MIN_NODE} or newer on the PATH")


def _run_node(*args: str | Path) -> subprocess.CompletedProcess:
    # UTF-8 whatever the console's code page: the suites print the names of
    # their tests, and those are not all ASCII.
    return subprocess.run(
        [NODE, *(str(arg) for arg in args)],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=900,
    )


def _said(result: subprocess.CompletedProcess) -> str:
    return f"exit code {result.returncode}\n{result.stdout[-6000:]}\n{result.stderr[-6000:]}"


@pytest.mark.parametrize("suite", ["export.test.js", "import.test.js"])
def test_the_scripts_own_tests_pass(suite):
    result = _run_node(JS / suite)
    assert result.returncode == 0, _said(result)
    assert " passed, 0 failed" in result.stdout, _said(result)


@pytest.fixture(scope="module")
def exported(tmp_path_factory) -> tuple[Path, dict[str, dict]]:
    """A folder the export script wrote: a Claude Code project and a regular one.

    Returned with what the script's own manifests say is in each, by folder name.
    """
    folder = tmp_path_factory.mktemp("exports")
    result = _run_node(JS / "export_to_disk.js", folder)
    assert result.returncode == 0, _said(result)
    summary = json.loads(result.stdout.strip().splitlines()[-1])
    return folder, {row["folder"]: row for row in summary}


def test_check_reads_what_the_export_script_wrote(exported):
    folder, summary = exported
    assert {row["kind"] for row in summary.values()} == {"code", "standard"}

    result = pm.check_folder(folder)
    assert result.exists and not result.direct
    assert result.unfinished == []
    assert {export.path.name for export in result.exports} == set(summary)
    for export in result.exports:
        row = summary[export.path.name]
        assert export.error == ""
        assert export.missing == [] and export.wrong_size == []
        assert export.complete
        assert (export.name, export.kind) == (row["name"], row["kind"])
        assert (export.files, export.conversations, export.bytes) == (
            row["files"],
            row["conversations"],
            row["bytes"],
        )
        assert export.files > 0 and export.conversations > 0
    assert len(result.own) == 2


def test_an_export_named_directly_is_read_the_same(exported):
    folder, summary = exported
    for name, row in summary.items():
        result = pm.check_folder(folder / name)
        assert result.direct
        assert result.ready is not None
        assert (result.ready.name, result.ready.files) == (row["name"], row["files"])


def test_check_notices_what_has_gone_from_an_export(exported, tmp_path):
    folder, summary = exported
    copy = tmp_path / "exports"
    shutil.copytree(folder, copy)
    code = next(name for name, row in summary.items() if row["kind"] == "code")
    manifest = json.loads((copy / code / pm.MANIFEST_NAME).read_text(encoding="utf-8"))

    # One of its own files cut short, and one saved conversation deleted.
    cut = next(row for row in manifest["files"] if row["bytes"] > 1)
    cut_path = copy.joinpath(code, *cut["path"].split("/"))
    cut_path.write_bytes(cut_path.read_bytes()[:-1])
    gone = manifest["history"][-1]["path"]
    copy.joinpath(code, *gone.split("/")).unlink()

    export = pm.read_export(copy / code)
    assert export.missing == [gone]
    assert len(export.wrong_size) == 1 and cut["path"] in export.wrong_size[0]
    assert not export.complete

    # The other export in the folder is untouched, and is the one that is ready.
    result = pm.check_folder(copy)
    assert [ready.kind for ready in result.own] == ["standard"]


def test_an_export_without_its_manifest_is_unfinished(exported, tmp_path):
    folder, summary = exported
    copy = tmp_path / "exports"
    shutil.copytree(folder, copy)
    for name in summary:
        (copy / name / pm.MANIFEST_NAME).unlink()
    result = pm.check_folder(copy)
    # Both kinds leave something behind that says "an export was started here".
    assert sorted(result.unfinished) == sorted(summary)
    assert result.exports == [] and result.ready is None


def test_the_cli_takes_it_from_check_to_import(exported, temp_home, capsys):
    folder, summary = exported

    def run(*argv: str) -> tuple[int, str]:
        with patch("os.geteuid", return_value=1000, create=True), \
             patch.object(sys, "argv", ["cswap", "project-move", *argv]), \
             patch.object(pm, "open_url", return_value=True), \
             patch.object(pm, "copy_to_clipboard", return_value=None):
            code = 0
            try:
                cli.main()
            except SystemExit as e:
                code = e.code or 0
        return code, capsys.readouterr().out

    code, out = run("check", "--folder", str(folder))
    assert code == 0
    for row in summary.values():
        assert f"  {row['name']}  (" in out
        assert f"{row['files']} file(s), {row['conversations']} saved conversation(s)" in out
    assert "2 exports are ready here" in out

    code, out = run("import", "--no-open")
    assert code == 0
    assert f"       {folder}\n" in out
    assert "the script asks which one to import" in out
