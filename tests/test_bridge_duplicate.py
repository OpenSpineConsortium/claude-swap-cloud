"""The bridge's Duplicate side: an export job driven from the side panel, its
files written through the host, and the import queued from it.

Same ground rules as test_bridge.py: a tmp_path backup root, stdio as
BytesIO, the clock injected, no socket and no real registry.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from claude_swap import bridge
from claude_swap import project_move as pm

T0 = 1_700_000_000
INSTANCE = "11111111-2222-4333-8444-555555555555"
OTHER_INSTANCE = "99999999-2222-4333-8444-555555555555"
EXT_ID = "a" * 32
ORIGIN = f"chrome-extension://{EXT_ID}/"
PROJECT = {"id": "chan_01BEETHOVENBEETHOVEN0000", "name": "Beethoven", "kind": "code",
           "org_uuid": "dddddddd-0000-4000-8000-000000000001", "org_name": "Personal"}
SOURCE = {"email": "a@example.com", "org_uuid": "dddddddd-0000-4000-8000-000000000001"}

_FILES = {"Files/notes.md": b"# notes\n", "Files/data/table.csv": b"a,b\n1,2\n"}
_HISTORY = {"Threads/001 Kick-off.md": b"thread\n"}


def _registry(root: Path, accounts: dict | None = None, sequence: list | None = None) -> Path:
    """A sequence.json like cswap writes one: slots, emails, organizations, no credential."""
    root.mkdir(parents=True, exist_ok=True)
    if accounts is None:
        accounts = {
            "1": {"email": "a@example.com", "uuid": "u1", "organizationUuid": "dddddddd-0000-4000-8000-000000000001",
                  "organizationName": "Personal", "added": "2026-10-01T00:00:00"},
            "2": {"email": "b@example.com", "uuid": "u2", "organizationUuid": "dddddddd-0000-4000-8000-000000000000",
                  "organizationName": "Beethoven Org", "added": "2026-10-01T00:00:00", "alias": "work"},
            "3": {"email": "", "uuid": "", "organizationUuid": "", "organizationName": "", "added": "2026-10-01T00:00:00",
                  "kind": "api_key"},
            "4": {"email": "b@example.com", "uuid": "u4", "organizationUuid": "", "organizationName": "", "added": "2026-10-01T00:00:00"},
        }
    if sequence is None:
        sequence = [2, 1, 3, 4]
    path = root / bridge.SEQUENCE_FILE
    path.write_text(json.dumps({"sequence": sequence, "accounts": accounts, "activeAccountNumber": 1}), encoding="utf-8")
    return path


def _export_tree(name: str = "Demo") -> dict[str, bytes]:
    """The files of a small finished Claude Code export, under its top folder, as the script writes them."""
    files = dict(_FILES)
    manifest = {
        "format": pm.MANIFEST_FORMAT,
        "version": pm.MANIFEST_VERSION,
        "kind": "code",
        "name": name,
        "files": [
            {"path": path, "name": path.rsplit("/", 1)[-1], "type": "project_file", "bytes": len(data)}
            for path, data in files.items()
        ],
        "history": [{"path": path, "title": "Kick-off", "type": "thread"} for path in _HISTORY],
        "problems": [],
    }
    tree = {f"{name}/{path}": data for path, data in {**files, **_HISTORY}.items()}
    tree[f"{name}/{pm.MANIFEST_NAME}"] = json.dumps(manifest).encode("utf-8")
    return tree


class _ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines: list[str] = []

    def emit(self, record):
        self.lines.append(self.format(record))


def _test_logger(name: str = "test-bridge-duplicate") -> tuple[logging.Logger, _ListHandler]:
    logger = logging.getLogger(name)
    logger.handlers.clear()
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    handler = _ListHandler()
    handler.addFilter(bridge._RedactingFilter())
    logger.addHandler(handler)
    return logger, handler


def _host(root: Path, *, now=None, log=None, instance: str = INSTANCE) -> bridge.BridgeHost:
    host = bridge.BridgeHost(root, io.BytesIO(b""), io.BytesIO(), origin=ORIGIN, now=now or (lambda: T0), log=log)
    reply = _one(host, {"id": 1, "type": "hello", "protocol": 1, "extension": {"version": "0.2.0", "instance": instance},
                        "chrome": "140", "userScripts": True})
    assert reply["type"] == "hello" and "duplicate" in reply["capabilities"]
    return host


_ids = iter(range(10, 100000))


def _one(host: bridge.BridgeHost, msg: dict) -> dict:
    msg = {"id": next(_ids), **msg}
    replies = list(host.handle(msg))
    assert len(replies) == 1, replies
    return replies[0]


def _write(host: bridge.BridgeHost, job_id: str, path: str, data: bytes, offset: int = 0, last: bool = True) -> dict:
    return _one(host, {"type": "file.write", "job": job_id, "path": path, "offset": offset,
                       "data": base64.b64encode(data).decode("ascii"), "last": last})


def _write_tree(host: bridge.BridgeHost, job_id: str, tree: dict[str, bytes]) -> None:
    for path, data in tree.items():
        reply = _write(host, job_id, path, data)
        assert reply["type"] == "written", reply


def _started(host: bridge.BridgeHost, folder: Path | None = None) -> bridge.Job:
    """An export job started by the host, chosen and told the source, as the worker does it."""
    reply = _one(host, {"type": "export.new", "extension_version": "0.2.0"})
    assert reply["type"] == "job", reply
    job = bridge.Job.from_dict(reply["job"])
    if folder is not None:
        job.export["folder"] = str(folder)
        bridge.save_job(host.root, job)
    chosen = _one(host, {"type": "export.choose", "job": job.id, "project": PROJECT, "destination": "2",
                         "name": "Beethoven copy", "source": SOURCE})
    assert chosen["type"] == "job", chosen
    return bridge.Job.from_dict(chosen["job"])


@pytest.fixture
def root(tmp_path: Path) -> Path:
    path = tmp_path / "backup"
    _registry(path)
    state = pm.MoveState()
    state.folder = str(tmp_path / "exports")
    state.save(path)
    return path


@pytest.fixture(autouse=True)
def _close_host_log():
    yield
    logger = logging.getLogger("claude-swap.bridge")
    for handler in list(logger.handlers):
        handler.close()
        logger.removeHandler(handler)


# ---------------------------------------------------------------------------
# The registry, read-only
# ---------------------------------------------------------------------------


class TestAccounts:
    def test_lists_slots_in_the_registry_order_with_what_the_panel_shows(self, root):
        accounts = bridge.list_accounts(root)
        assert [a["slot"] for a in accounts] == ["2", "1", "3", "4"]
        assert accounts[0] == {
            "slot": "2", "email": "b@example.com", "organization": "Beethoven Org",
            "org_uuid": "dddddddd-0000-4000-8000-000000000000", "alias": "work", "kind": "oauth", "usable": True, "why": "",
        }
        api = accounts[2]
        assert api["kind"] == "api_key" and api["usable"] is False and "API-key" in api["why"]
        assert all(set(a) == set(accounts[0]) for a in accounts)
        assert not any("uuid" in a and a["uuid"] for a in accounts), "nothing but what the panel shows"

    def test_slots_missing_from_the_sequence_come_after_it_in_numeric_order(self, tmp_path):
        root = tmp_path / "b"
        _registry(root, accounts={"10": {"email": "j@x"}, "2": {"email": "b@x"}, "1": {"email": "a@x"}}, sequence=[2])
        assert [a["slot"] for a in bridge.list_accounts(root)] == ["2", "1", "10"]

    def test_no_registry_is_no_accounts_and_a_broken_one_is_refused(self, tmp_path):
        assert bridge.list_accounts(tmp_path / "none") == []
        broken = tmp_path / "broken"
        broken.mkdir()
        (broken / bridge.SEQUENCE_FILE).write_text("{not json", encoding="utf-8")
        with pytest.raises(bridge.BridgeError) as e:
            bridge.list_accounts(broken)
        assert e.value.code == "registry"
        (broken / bridge.SEQUENCE_FILE).write_text("[]", encoding="utf-8")
        assert bridge.list_accounts(broken) == []

    def test_an_account_without_email_is_listed_but_not_usable(self, root):
        no_email = next(a for a in bridge.list_accounts(root) if a["slot"] == "3")
        assert no_email["usable"] is False

    def test_resolve_by_slot_alias_or_unique_email(self, root):
        assert bridge.resolve_destination(root, "1")["email"] == "a@example.com"
        assert bridge.resolve_destination(root, "WORK")["slot"] == "2"
        assert bridge.resolve_destination(root, "a@example.com")["slot"] == "1"
        with pytest.raises(bridge.BridgeError) as e:
            bridge.resolve_destination(root, "b@example.com")
        assert e.value.code == "no-account" and "2, 4" in str(e.value)
        with pytest.raises(bridge.BridgeError) as e:
            bridge.resolve_destination(root, "9")
        assert e.value.code == "no-account"
        with pytest.raises(bridge.BridgeError) as e:
            bridge.resolve_destination(root, "3")
        assert e.value.code == "account-unusable" and "API-key" in str(e.value)
        for bad in (None, "", "  ", 2):
            with pytest.raises(bridge.BridgeError) as e:
                bridge.resolve_destination(root, bad)
            assert e.value.code == "no-account"


# ---------------------------------------------------------------------------
# The export job
# ---------------------------------------------------------------------------


class TestExportJob:
    def test_new_export_job_is_born_claimed_in_the_move_folder(self, root, tmp_path):
        job = bridge.new_export_job(root, instance=INSTANCE, extension_version="0.2.0", now=T0)
        assert job.kind == "export" and job.status == "claimed" and job.phase == ""
        assert job.owned_by(INSTANCE) and job.claimed_by["extension_version"] == "0.2.0"
        assert job.export["folder"] == str(tmp_path / "exports") and job.export["path"] == "" and job.export["top"] == ""
        assert job.account == {"slot": "", "email": "", "org_uuid": ""}
        assert job.duplicate == {"project": None, "destination": None, "name": None, "import_job": None}
        assert job.script["sha256"] == bridge.script_sha256(pm.script_text("export"))
        assert bridge.load_job(root).to_dict() == job.to_dict()
        assert bridge.events_path(root, job.id).exists()

    def test_round_trip_keeps_kind_and_duplicate_and_old_files_are_imports(self, root):
        job = bridge.new_export_job(root, instance=INSTANCE, now=T0)
        back = bridge.Job.from_dict(json.loads(json.dumps(job.to_dict())))
        assert back.kind == "export" and back.duplicate == job.duplicate
        raw = job.to_dict()
        del raw["kind"]
        del raw["duplicate"]
        old = bridge.Job.from_dict(raw)
        assert old.kind == "import" and old.duplicate is None
        assert bridge.Job.from_dict({**raw, "kind": "sideways"}).kind == "import"

    def test_refused_while_another_job_is_unfinished(self, root):
        first = bridge.new_export_job(root, instance=INSTANCE, now=T0)
        with pytest.raises(bridge.JobActiveError) as e:
            bridge.new_export_job(root, instance=OTHER_INSTANCE, now=T0 + 1)
        assert first.id in str(e.value)
        for bad in ("", None, 3):
            with pytest.raises(bridge.BridgeError):
                bridge.new_export_job(root, instance=bad, now=T0)

    def test_choosing_phase_keeps_the_job_claimed(self, root):
        job = bridge.new_export_job(root, instance=INSTANCE, now=T0)
        out = bridge.update_from_event(job, {"event": "phase", "phase": "choosing"}, now=T0 + 5)
        assert out.status == "claimed" and out.phase == "choosing"

    def test_choose_records_project_destination_name_and_source(self, root):
        host = _host(root)
        job = _started(host)
        assert job.duplicate["project"] == {**PROJECT}
        assert job.duplicate["destination"] == {"slot": "2", "email": "b@example.com",
                                                "org_uuid": "dddddddd-0000-4000-8000-000000000000", "organization": "Beethoven Org"}
        assert job.duplicate["name"] == "Beethoven copy" and job.duplicate["import_job"] is None
        assert job.export["name"] == "Beethoven" and job.export["kind"] == "code"
        assert job.account == {"slot": "", "email": "a@example.com", "org_uuid": "dddddddd-0000-4000-8000-000000000001"}
        # Chosen again before anything was written: the new choice wins.
        again = _one(host, {"type": "export.choose", "job": job.id, "project": {**PROJECT, "kind": "standard", "name": " Other "},
                            "destination": "work", "name": "   "})
        assert again["job"]["duplicate"]["project"]["name"] == "Other"
        assert again["job"]["duplicate"]["project"]["kind"] == "standard"
        assert again["job"]["duplicate"]["name"] is None

    def test_choose_refusals(self, root):
        host = _host(root)
        job = bridge.Job.from_dict(_one(host, {"type": "export.new"})["job"])
        bad = _one(host, {"type": "export.choose", "job": job.id, "project": {"id": "x"}, "destination": "2"})
        assert bad["type"] == "error" and bad["code"] == "bad-project"
        bad = _one(host, {"type": "export.choose", "job": job.id, "project": PROJECT, "destination": "3"})
        assert bad["code"] == "account-unusable"
        bad = _one(host, {"type": "export.choose", "job": job.id, "project": PROJECT, "destination": "2", "name": 5})
        assert bad["code"] == "bad-name"
        bad = _one(host, {"type": "export.choose", "job": "job_20200101T000000_000000", "project": PROJECT, "destination": "2"})
        assert bad["code"] == "not-claimed"
        other = _host(root, instance=OTHER_INSTANCE)
        bad = _one(other, {"type": "export.choose", "job": job.id, "project": PROJECT, "destination": "2"})
        assert bad["code"] == "not-claimed"
        # An import job is not an export job.
        bridge.request_cancel(root, job.id, now=T0, force=True)
        export_dir = root.parent / "src-export"
        for path, data in _export_tree("Src").items():
            target = export_dir.joinpath(*path.split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        imp = bridge.new_job(root, export=pm.read_export(export_dir / "Src"), account=("2", "b@example.com", ""), name=None,
                             script_text=pm.script_text("import"), now=T0 + 10)
        _one(host, {"type": "job.claim", "job": imp.id, "instance": INSTANCE, "extension_version": "0.2.0"})
        bad = _one(host, {"type": "export.choose", "job": imp.id, "project": PROJECT, "destination": "2"})
        assert bad["code"] == "not-export"

    def test_script_get_serves_the_script_of_the_kind(self, root):
        host = _host(root)
        job = _started(host)
        reply = _one(host, {"type": "script.get", "job": job.id})
        assert reply["type"] == "script" and reply["text"] == pm.script_text("export")
        assert reply["sha256"] == job.script["sha256"]
        job.script["sha256"] = "0" * 64
        bridge.save_job(root, job)
        reply = _one(host, {"type": "script.get", "job": job.id})
        assert reply["code"] == "script-changed" and "export script" in reply["message"] and "Duplicate" in reply["message"]


# ---------------------------------------------------------------------------
# Writing the export's files
# ---------------------------------------------------------------------------


class TestFileWrite:
    def test_pieces_land_under_the_top_folder_and_counts_grow_on_the_last_piece(self, root, tmp_path):
        host = _host(root)
        job = _started(host)
        data = bytes(range(256)) * 3
        first = _write(host, job.id, "Demo/Files/big.bin", data[:300], 0, False)
        assert first == {"re": first["re"], "type": "written", "path": "Demo/Files/big.bin", "size": 300, "files": 0, "bytes": 0,
                         "cancel_requested": False, "export_path": str(tmp_path / "exports" / "Demo")}
        second = _write(host, job.id, "Demo/Files/big.bin", data[300:], 300, True)
        assert second["size"] == len(data) and second["files"] == 1 and second["bytes"] == len(data)
        empty = _write(host, job.id, "Demo/empty.txt", b"", 0, True)
        assert empty["size"] == 0 and empty["files"] == 2 and empty["bytes"] == len(data)
        folder = tmp_path / "exports"
        assert (folder / "Demo" / "Files" / "big.bin").read_bytes() == data
        assert (folder / "Demo" / "empty.txt").read_bytes() == b""
        job = bridge.load_job(root)
        assert job.export["top"] == "Demo" and job.export["script_top"] == "Demo"
        assert job.export["path"] == str(folder / "Demo") and job.export["files"] == 2 and job.export["bytes"] == len(data)

    def test_the_top_folder_gets_its_own_name_when_one_exists(self, root, tmp_path):
        folder = tmp_path / "exports"
        (folder / "Demo").mkdir(parents=True)
        (folder / "Demo (2)").mkdir()
        host = _host(root)
        job = _started(host)
        _write(host, job.id, "Demo/a.txt", b"a")
        _write(host, job.id, "Demo/Files/b.txt", b"b")
        assert (folder / "Demo (3)" / "a.txt").read_bytes() == b"a"
        assert (folder / "Demo (3)" / "Files" / "b.txt").read_bytes() == b"b"
        assert not (folder / "Demo" / "a.txt").exists()
        assert bridge.load_job(root).export["path"] == str(folder / "Demo (3)")

    def test_a_piece_out_of_order_is_refused_and_an_identical_resend_is_taken(self, root, tmp_path):
        host = _host(root)
        job = _started(host)
        _write(host, job.id, "Demo/x.bin", b"abc", 0, False)
        gap = _write(host, job.id, "Demo/x.bin", b"ghi", 6, False)
        assert gap["type"] == "error" and gap["code"] == "out-of-order" and gap["size"] == 3
        # The worker re-sends what it got no answer for: the same bytes at
        # the same place are already on disk, and count as written.
        again = _write(host, job.id, "Demo/x.bin", b"abc", 0, False)
        assert again["type"] == "written" and again["size"] == 3
        more = _write(host, job.id, "Demo/x.bin", b"def", 3, True)
        assert more["size"] == 6 and more["files"] == 1
        resent = _write(host, job.id, "Demo/x.bin", b"def", 3, True)
        assert resent["type"] == "written" and resent["size"] == 6 and resent["files"] == 1, "counted once"
        assert resent["export_path"] == more["export_path"] == str(tmp_path / "exports" / "Demo")
        other = _write(host, job.id, "Demo/x.bin", b"DEF", 3, True)
        assert other["type"] == "error" and other["code"] == "out-of-order"
        # The first piece starts the file afresh, whatever is there.
        fresh = _write(host, job.id, "Demo/x.bin", b"z", 0, True)
        assert fresh["size"] == 1

    def test_an_empty_closing_piece_after_the_bytes_counts_the_file_once(self, root, tmp_path):
        # The page sends a file's bytes in full pieces and then closes it
        # with an empty last piece at the end of what is on disk.
        host = _host(root)
        job = _started(host)
        assert _write(host, job.id, "Demo/x.bin", b"abc", 0, False)["files"] == 0
        assert _write(host, job.id, "Demo/x.bin", b"def", 3, False)["files"] == 0
        closed = _write(host, job.id, "Demo/x.bin", b"", 6, True)
        assert closed["type"] == "written" and closed["size"] == 6 and closed["files"] == 1 and closed["bytes"] == 6
        # Its answer was lost and it comes again: answered, not counted again.
        again = _write(host, job.id, "Demo/x.bin", b"", 6, True)
        assert again["type"] == "written" and again["files"] == 1 and again["bytes"] == 6
        assert (tmp_path / "exports" / "Demo" / "x.bin").read_bytes() == b"abcdef"
        # An empty piece that is not the last stays a resend, counted nowhere.
        _write(host, job.id, "Demo/y.bin", b"gh", 0, False)
        assert _write(host, job.id, "Demo/y.bin", b"", 2, False)["files"] == 1
        # The next file closes the same way and counts once as well.
        assert _write(host, job.id, "Demo/y.bin", b"", 2, True)["files"] == 2
        assert _write(host, job.id, "Demo/y.bin", b"", 2, True)["files"] == 2
        # An empty file is still counted by its only piece, and once.
        assert _write(host, job.id, "Demo/z.txt", b"", 0, True)["files"] == 3
        assert _write(host, job.id, "Demo/z.txt", b"", 0, True)["files"] == 3
        export = bridge.load_job(root).export
        assert export["files"] == 3 and export["bytes"] == 8
        assert export["closed"] == {"path": "Demo/z.txt", "size": 0}

    def test_paths_that_leave_the_folder_or_the_top_are_refused(self, root, tmp_path):
        host = _host(root)
        job = _started(host)
        _write(host, job.id, "Demo/ok.txt", b"ok")
        for bad in ("../x", "Demo/../x", "/abs", "Demo//x", "Demo/a\\b", "C:/x", "Demo/.", "onlytop", "", "Demo/a\0b"):
            reply = _write(host, job.id, bad, b"x")
            assert reply["type"] == "error" and reply["code"] == "bad-path", bad
        reply = _write(host, job.id, "Other/x.txt", b"x")
        assert reply["code"] == "bad-path" and "'Demo'" in reply["message"]
        assert not (tmp_path / "x").exists() and not (tmp_path / "exports" / "x").exists()
        for bad_offset in (-1, "0", True, None):
            reply = _one(host, {"type": "file.write", "job": job.id, "path": "Demo/y", "offset": bad_offset, "data": "", "last": True})
            assert reply["code"] == "bad-offset"
        for bad_data in (None, 5, "not base64!"):
            reply = _one(host, {"type": "file.write", "job": job.id, "path": "Demo/y", "offset": 0, "data": bad_data, "last": True})
            assert reply["code"] == "bad-data"

    def test_nothing_is_written_before_the_project_is_chosen_or_by_another_browser(self, root, tmp_path):
        host = _host(root)
        job = bridge.Job.from_dict(_one(host, {"type": "export.new"})["job"])
        reply = _write(host, job.id, "Demo/a.txt", b"a")
        assert reply["code"] == "not-chosen"
        assert not (tmp_path / "exports").exists()
        _one(host, {"type": "export.choose", "job": job.id, "project": PROJECT, "destination": "2", "source": SOURCE})
        other = _host(root, instance=OTHER_INSTANCE)
        assert _write(other, job.id, "Demo/a.txt", b"a")["code"] == "not-claimed"
        _write(host, job.id, "Demo/a.txt", b"a")
        changed = _one(host, {"type": "export.choose", "job": job.id, "project": PROJECT, "destination": "1"})
        assert changed["code"] == "already-chosen"

    def test_the_log_shows_sizes_never_the_bytes(self, root):
        log, handler = _test_logger()
        host = _host(root, log=log)
        job = _started(host)
        secret = b"sk-ant-api03-SECRETSECRETSECRETSECRET"
        _write(host, job.id, "Demo/keys.txt", secret)
        text = "\n".join(handler.lines)
        assert base64.b64encode(secret).decode("ascii") not in text
        assert f"<{len(secret)} bytes>" in text
        assert bridge.redact_for_log({"type": "file.write", "data": "QUJD"}) == {"type": "file.write", "data": "<3 bytes>"}


# ---------------------------------------------------------------------------
# The import queued from the export
# ---------------------------------------------------------------------------


def _finish_export(host: bridge.BridgeHost, job: bridge.Job, tree: dict[str, bytes] | None = None) -> None:
    _write_tree(host, job.id, tree or _export_tree())
    for event in ({"event": "phase", "phase": "running"}, {"event": "done", "result": {"status": "Done.", "written": {"files": 4}}},
                  {"event": "phase", "phase": "done"}):
        ack = _one(host, {"type": "event", "job": job.id, **event})
        assert ack["type"] == "ack", ack


class TestImportQueue:
    def test_the_import_is_queued_from_the_finished_export_like_the_command_line_does_it(self, root, tmp_path):
        host = _host(root)
        export_job = _started(host)
        _finish_export(host, export_job)
        assert bridge.load_job(root).status == "done"
        reply = _one(host, {"type": "import.queue", "job": export_job.id})
        assert reply["type"] == "job", reply
        job = bridge.Job.from_dict(reply["job"])
        assert job.kind == "import" and job.status == "queued" and job.id != export_job.id
        assert job.account == {"slot": "2", "email": "b@example.com", "org_uuid": "dddddddd-0000-4000-8000-000000000000"}
        assert job.name == "Beethoven copy"
        assert job.export["path"] == str(tmp_path / "exports" / "Demo") and job.export["kind"] == "code"
        assert job.export["files"] == 2 and job.export["archive"] is False
        assert job.duplicate == {"export_job": export_job.id,
                                 "source": {"email": "a@example.com", "org_uuid": "dddddddd-0000-4000-8000-000000000001", "project": PROJECT}}
        assert job.script["sha256"] == bridge.script_sha256(pm.script_text("import"))
        state = pm.MoveState.load(root)
        assert state.carrier == pm.CARRIER_FOLDER and state.folder == str(tmp_path / "exports")
        assert state.export_path == str(tmp_path / "exports" / "Demo") and state.export_seen_at and state.exported_at
        assert state.imported_at == ""
        # The worker claims it as any job, is served the import script, and
        # its end marks the move's import stage done.
        claimed = _one(host, {"type": "job.claim", "job": job.id, "instance": INSTANCE, "extension_version": "0.2.0"})
        assert claimed["job"]["status"] == "claimed"
        script = _one(host, {"type": "script.get", "job": job.id})
        assert script["text"] == pm.script_text("import")
        listing = _one(host, {"type": "export.list", "job": job.id})
        assert listing["type"] == "export" and listing["root"] == "Demo" and len(listing["files"]) == 4
        _one(host, {"type": "event", "job": job.id, "event": "done", "result": {"status": "Done."}})
        assert pm.MoveState.load(root).imported_at

    def test_import_queue_refusals(self, root, tmp_path):
        host = _host(root)
        export_job = _started(host)
        running = _one(host, {"type": "import.queue", "job": export_job.id})
        assert running["code"] == "not-done"
        _write_tree(host, export_job.id, {k: v for k, v in _export_tree().items() if not k.endswith("table.csv")})
        for event in ({"event": "done", "result": {}}, {"event": "phase", "phase": "done"}):
            _one(host, {"type": "event", "job": export_job.id, **event})
        short = _one(host, {"type": "import.queue", "job": export_job.id})
        assert short["code"] == "export-incomplete" and "missing" in short["message"]
        assert bridge.load_job(root).id == export_job.id, "the export job stays current"
        other = _host(root, instance=OTHER_INSTANCE)
        assert _one(other, {"type": "import.queue", "job": export_job.id})["code"] == "not-claimed"
        assert _one(host, {"type": "import.queue", "job": "nope"})["code"] == "not-claimed"

    def test_asking_again_returns_the_import_already_queued_from_this_export(self, root):
        host = _host(root)
        export_job = _started(host)
        _finish_export(host, export_job)
        first = _one(host, {"type": "import.queue", "job": export_job.id})
        assert first["type"] == "job", first
        seen_at = pm.MoveState.load(root).export_seen_at
        # The answer was lost: asked again, the same import, not a second.
        again = _one(host, {"type": "import.queue", "job": export_job.id})
        assert again["type"] == "job" and again["job"]["id"] == first["job"]["id"]
        assert again["job"]["status"] == "queued"
        assert pm.MoveState.load(root).export_seen_at == seen_at, "the move is not begun twice"
        # The claim went through and its answer was lost: still the same one.
        _one(host, {"type": "job.claim", "job": first["job"]["id"], "instance": INSTANCE, "extension_version": "0.2.0"})
        claimed = _one(host, {"type": "import.queue", "job": export_job.id})
        assert claimed["job"]["id"] == first["job"]["id"] and claimed["job"]["status"] == "claimed"
        # Another browser is not handed this one's import.
        other = _host(root, instance=OTHER_INSTANCE)
        assert _one(other, {"type": "import.queue", "job": export_job.id})["code"] == "not-claimed"
        # Once the import has ended, the export is not this browser's current job.
        for event in ({"event": "done", "result": {}}, {"event": "phase", "phase": "done"}):
            _one(host, {"type": "event", "job": first["job"]["id"], **event})
        assert _one(host, {"type": "import.queue", "job": export_job.id})["code"] == "not-claimed"

    def test_an_export_that_wrote_nothing_or_chose_nothing_cannot_be_imported(self, root):
        host = _host(root)
        job = bridge.Job.from_dict(_one(host, {"type": "export.new"})["job"])
        for event in ({"event": "done", "result": {}}, {"event": "phase", "phase": "done"}):
            _one(host, {"type": "event", "job": job.id, **event})
        reply = _one(host, {"type": "import.queue", "job": job.id})
        assert reply["code"] == "not-chosen"

    def test_an_import_job_is_refused_as_an_export_to_queue_from(self, root, tmp_path):
        host = _host(root)
        export_job = _started(host)
        _finish_export(host, export_job)
        job = bridge.Job.from_dict(_one(host, {"type": "import.queue", "job": export_job.id})["job"])
        _one(host, {"type": "job.claim", "job": job.id, "instance": INSTANCE, "extension_version": "0.2.0"})
        for event in ({"event": "done", "result": {}}, {"event": "phase", "phase": "done"}):
            _one(host, {"type": "event", "job": job.id, **event})
        assert _one(host, {"type": "import.queue", "job": job.id})["code"] == "not-export"


# ---------------------------------------------------------------------------
# The name of a project the panel could only offer by its id
# ---------------------------------------------------------------------------


def _chosen(host: bridge.BridgeHost, project: dict) -> bridge.Job:
    """An export job chosen with ``project`` as the panel sends it, no name for the copy."""
    job = bridge.Job.from_dict(_one(host, {"type": "export.new", "extension_version": "0.2.0"})["job"])
    chosen = _one(host, {"type": "export.choose", "job": job.id, "project": project, "destination": "2", "source": SOURCE})
    assert chosen["type"] == "job", chosen
    return bridge.Job.from_dict(chosen["job"])


def _with_manifest(tree: dict[str, bytes], **changes) -> dict[str, bytes]:
    """``tree`` with its export.json changed: a value of None removes the key."""
    out = dict(tree)
    key = next(k for k in out if k.endswith("/" + pm.MANIFEST_NAME))
    manifest = json.loads(out[key])
    for name, value in changes.items():
        if value is None:
            manifest.pop(name, None)
        else:
            manifest[name] = value
    out[key] = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
    return out


UNNAMED = {**PROJECT, "name": "", "org_uuid": "", "org_name": ""}


class TestExportName:
    def test_an_unnamed_choice_takes_the_name_its_export_json_gives(self, root):
        host = _host(root)
        job = _chosen(host, UNNAMED)
        # No name sent: the id stands in for it until the export names it.
        assert job.duplicate["project"]["name"] == PROJECT["id"]
        assert job.export["name"] == PROJECT["id"]
        _finish_export(host, job, _export_tree("beethoven"))
        done = bridge.load_job(root)
        assert done.status == "done"
        assert done.duplicate["project"]["name"] == "beethoven"
        assert done.export["name"] == "beethoven"
        # The import queued from it carries the name, not the id.
        queued = bridge.Job.from_dict(_one(host, {"type": "import.queue", "job": job.id})["job"])
        assert queued.duplicate["source"]["project"]["name"] == "beethoven"
        assert queued.name is None

    def test_the_label_an_older_extension_sent_is_replaced_too(self, root):
        host = _host(root)
        job = _chosen(host, {**UNNAMED, "name": f"This tab's workspace ({PROJECT['id']})"})
        assert job.duplicate["project"]["name"] == f"This tab's workspace ({PROJECT['id']})"
        _finish_export(host, job, _export_tree("beethoven"))
        assert bridge.load_job(root).duplicate["project"]["name"] == "beethoven"
        assert bridge.load_job(root).export["name"] == "beethoven"

    def test_a_name_the_listing_gave_is_kept(self, root):
        host = _host(root)
        job = _started(host)
        _finish_export(host, job, _export_tree("Demo"))
        done = bridge.load_job(root)
        assert done.duplicate["project"]["name"] == "Beethoven"
        assert done.export["name"] == "Beethoven"

    def test_a_name_that_is_not_ascii_is_read_as_utf8(self, root):
        host = _host(root)
        job = _chosen(host, UNNAMED)
        _finish_export(host, job, _with_manifest(_export_tree("beethoven"), name="Beethoven été ♫"))
        assert bridge.load_job(root).duplicate["project"]["name"] == "Beethoven été ♫"

    @pytest.mark.parametrize(
        "changes",
        [
            {"name": ""},
            {"name": "   "},
            {"name": None},
            {"name": 7},
            {"source": {"id": "chan_01SOMETHINGELSE0000000"}},
        ],
        ids=["empty", "blank", "missing", "not-text", "another-project"],
    )
    def test_an_export_json_that_names_nothing_or_another_project_keeps_the_id(self, root, changes):
        host = _host(root)
        job = _chosen(host, UNNAMED)
        _finish_export(host, job, _with_manifest(_export_tree("beethoven"), **changes))
        done = bridge.load_job(root)
        assert done.status == "done"
        assert done.duplicate["project"]["name"] == PROJECT["id"]
        assert done.export["name"] == PROJECT["id"]

    def test_the_export_json_of_this_project_is_taken(self, root):
        host = _host(root)
        job = _chosen(host, UNNAMED)
        _finish_export(host, job, _with_manifest(_export_tree("beethoven"), source={"id": PROJECT["id"]}))
        assert bridge.load_job(root).duplicate["project"]["name"] == "beethoven"

    def test_a_missing_or_damaged_export_json_changes_nothing_and_never_fails_the_ack(self, root):
        # Nothing written at all: the job names no folder, and no
        # export.json in the host's working directory is ever read.
        host = _host(root)
        job = _chosen(host, UNNAMED)
        for event in ({"event": "done", "result": {}}, {"event": "phase", "phase": "done"}):
            ack = _one(host, {"type": "event", "job": job.id, **event})
            assert ack["type"] == "ack", ack
        done = bridge.load_job(root)
        assert done.status == "done" and done.export["path"] == ""
        assert done.duplicate["project"]["name"] == PROJECT["id"]
        # A damaged export.json.
        job = _chosen(host, UNNAMED)
        tree = _export_tree("beethoven")
        tree["beethoven/" + pm.MANIFEST_NAME] = b"{not json"
        _finish_export(host, job, tree)
        done = bridge.load_job(root)
        assert done.id == job.id and done.status == "done"
        assert done.duplicate["project"]["name"] == PROJECT["id"]
        # One that is not UTF-8.
        job = _chosen(host, UNNAMED)
        tree = _export_tree("beethoven")
        tree["beethoven/" + pm.MANIFEST_NAME] = b'{"name": "\xff\xfe"}'
        _finish_export(host, job, tree)
        assert bridge.load_job(root).duplicate["project"]["name"] == PROJECT["id"]

    def test_a_job_settled_from_its_events_is_named_as_well(self, root):
        host = _host(root)
        job = _chosen(host, UNNAMED)
        _write_tree(host, job.id, _export_tree("beethoven"))
        ack = _one(host, {"type": "event", "job": job.id, "event": "phase", "phase": "running"})
        assert ack["type"] == "ack"
        # The host appended the done event and died before it saved the job file.
        bridge.append_event(root, job.id, {"event": "done", "result": {"status": "Done."}}, now=T0 + 5)
        assert bridge.load_job(root).status == "running"
        assert bridge.request_cancel(root, now=T0 + 6) is False
        settled = bridge.load_job(root)
        assert settled.status == "done"
        assert settled.duplicate["project"]["name"] == "beethoven"
        assert settled.export["name"] == "beethoven"


# ---------------------------------------------------------------------------
# What the command line says
# ---------------------------------------------------------------------------


class TestWording:
    def test_phase_lines_by_kind(self):
        assert bridge._phase_line("running", "export") == "Exporting..."
        assert bridge._phase_line("running", "import") == "Importing..."
        assert "side panel" in bridge._phase_line("choosing", "export")
        assert bridge._phase_line("choosing", "import") is None

    def test_outcome_names_the_flow(self):
        done = bridge._outcome_from("done", {"event": "done", "result": {}}, "job_x", flow="export")
        assert done.message == "The export finished."
        cancelled = bridge._outcome_from("cancelled", {"event": "cancelled"}, "job_x", flow="export")
        assert cancelled.message == "The export was cancelled."
        assert bridge._outcome_from("failed", {"event": "failed"}, "job_x").message == "The import failed."

    def test_run_import_follows_an_export_job(self, root):
        job = bridge.new_export_job(root, instance=INSTANCE, now=T0)
        for event in ({"event": "claimed", "instance": INSTANCE}, {"event": "phase", "phase": "choosing"},
                      {"event": "phase", "phase": "running"}, {"event": "done", "result": {"status": "Done. 4 files."}}):
            bridge.append_event(root, job.id, event)
        lines: list[str] = []
        outcome = bridge.run_import(root, job, say=lines.append, sleep=lambda s: None, clock=lambda: 0.0)
        assert outcome.status == "done"
        assert any("side panel" in line for line in lines) and "Exporting..." in lines
        assert "Done. 4 files." in lines

    def test_status_line_names_an_export_job(self, root, capsys):
        from claude_swap import cli

        job = bridge.new_export_job(root, instance=INSTANCE, now=T0)
        job.phase = "choosing"

        class St:
            installed = True
            manifest_ok = True
            launcher_ok = True
            python_ok = True
            code_ok = True
            extension_id = EXT_ID
            extension_dir = None
            registrations = []
            problems = []

        St.job = job
        cli._print_bridge_status(bridge, St, False)
        out = capsys.readouterr().out
        assert f"Export job {job.id}: claimed (choosing)" in out


# ---------------------------------------------------------------------------
# The import in a window of its own
# ---------------------------------------------------------------------------


CARRY = "https://claude.ai/code/project/chan_01CARRYON0000000000000"


class _Driven:
    """What the host would start, recorded; the processes it started stay alive until a test ends them."""

    def __init__(self):
        self.started: list[dict] = []
        self.alive: set[int] = set()
        self.created: dict[int, float] = {}

    def spawn(self, argv, *, cwd, env, log_path, platform=None):
        pid = 4242 + len(self.started)
        self.started.append({"argv": list(argv), "cwd": cwd, "env": env, "log_path": log_path})
        self.alive.add(pid)
        self.created[pid] = 1_000.0 + pid
        return pid


@pytest.fixture
def driven(monkeypatch, root):
    fake = _Driven()
    # The child finds the backup folder the host serves: the test's.
    monkeypatch.setattr(bridge.paths, "get_backup_root", lambda: root)
    monkeypatch.setattr(bridge, "_spawn_detached", fake.spawn)
    monkeypatch.setattr(bridge, "_pid_alive", lambda pid: pid in fake.alive)
    monkeypatch.setattr(bridge, "_process_created", lambda pid: fake.created.get(pid))
    return fake


def _done_export(host: bridge.BridgeHost, *, tree: dict[str, bytes] | None = None, name: object = "Beethoven copy",
                 project: dict | None = None) -> bridge.Job:
    """A Duplicate export chosen, written and finished, as the worker drives it."""
    job = bridge.Job.from_dict(_one(host, {"type": "export.new", "extension_version": "0.2.0"})["job"])
    chosen = _one(host, {"type": "export.choose", "job": job.id, "project": project or PROJECT, "destination": "2",
                         "name": name, "source": SOURCE})
    assert chosen["type"] == "job", chosen
    _finish_export(host, job, tree)
    return bridge.load_job(host.root)


class TestDrivenImport:
    def test_the_command_is_built_from_the_job_alone(self, root, driven, tmp_path):
        host = _host(root)
        job = _done_export(host, project={**PROJECT, "name": "PROJECT-NAME-ONLY"})
        path = tmp_path / "exports" / "Demo"
        argv, line = bridge.driven_command(root, job, python="py", platform="win32")
        assert argv == ["py", "-m", "claude_swap", "project-move", "auto", f"--export={path}", "--to=2",
                        "--name=Beethoven copy", f"--bridge-job={job.id}"]
        assert line == f'cswap project-move auto --export={bridge.typed_value(str(path), "win32")} --to 2 --name="Beethoven copy"'
        _, posix = bridge.driven_command(root, job, python="py", platform="linux")
        assert posix == f"cswap project-move auto --export={bridge.typed_value(str(path), 'linux')} --to 2 --name='Beethoven copy'"
        # The project's own name is never the copy's; the default interpreter is the host's.
        assert not any("PROJECT-NAME-ONLY" in a for a in argv) and "PROJECT-NAME-ONLY" not in line
        assert bridge.driven_command(root, job)[0][0] == sys.executable
        # No name typed: the export's own name, so no --name at all.
        job.duplicate["name"] = None
        argv, line = bridge.driven_command(root, job, python="py", platform="win32")
        assert not any(a.startswith("--name") for a in argv) and "--name" not in line
        # The line to type keeps every value after --option=, as the command
        # does, so a name that starts with a dash is not read as an option.
        job.duplicate["name"] = "-draft"
        for platform in ("win32", "linux"):
            argv, line = bridge.driven_command(root, job, python="py", platform=platform)
            assert "--name=-draft" in argv and line.endswith(" --name=-draft"), platform
        # A name PowerShell would change in double quotes goes in single ones,
        # with a quote in it doubled; the command itself keeps it whole.
        job.duplicate["name"] = "-cost $5"
        argv, line = bridge.driven_command(root, job, python="py", platform="win32")
        assert "--name=-cost $5" in argv and line.endswith("--name='-cost $5'")
        job.duplicate["name"] = "it's $5"
        argv, line = bridge.driven_command(root, job, python="py", platform="win32")
        assert "--name=it's $5" in argv and line.endswith("--name='it''s $5'")
        # A double quote no quoting carries into both PowerShells: the name is
        # left off, and the line says so instead of copying under another name.
        job.duplicate["name"] = 'Bob\'s "plan"'
        argv, line = bridge.driven_command(root, job, python="py", platform="win32")
        assert '--name=Bob\'s "plan"' in argv
        assert "--name=" not in line and line.endswith(f"--to 2  {bridge.UNTYPED_NAME_NOTE}")
        _, posix = bridge.driven_command(root, job, python="py", platform="linux")
        assert posix.endswith("""--name='Bob'"'"'s "plan"'""")
        # The project an earlier try stopped in is carried on in, and only a Claude Code one.
        job.duplicate["name"] = None
        job.duplicate["driven"] = {"carry_on": CARRY}
        argv, line = bridge.driven_command(root, job, python="py", platform="linux")
        assert argv[-2:] == [f"--into={CARRY}", f"--bridge-job={job.id}"] and line.endswith(f"--into {CARRY}")
        for other in ("https://claude.ai/project/aaaaaaaa-0000-4000-8000-000000000001", "https://evil.example/code/project/chan_01X",
                      f"{CARRY} --to 1", 7):
            job.duplicate["driven"] = {"carry_on": other}
            assert not any(a.startswith("--into") for a in bridge.driven_command(root, job, python="py")[0]), other

    def test_import_driven_starts_one_process_and_records_it(self, root, driven):
        host = _host(root)
        job = _done_export(host)
        reply = _one(host, {"type": "import.driven", "job": job.id})
        assert reply["type"] == "driven", reply
        state = reply["driven"]
        log = bridge.bridge_dir(root) / f"driven-{job.id}.log"
        assert state["running"] is True and state["lost"] is False and state["pid"] == 4242 and state["attempt"] == 1
        assert state["log"] == str(log) and state["exit_code"] is None and state["url"] == ""
        record = bridge.load_job(root).duplicate["driven"]
        assert record["pid"] == 4242 and record["created"] == 1000.0 + 4242
        assert record["started_at"] == bridge._iso(T0) and record["log"] == str(log) and record["attempt"] == 1
        assert record["command"] == state["command"] and record["command"].startswith("cswap project-move auto --export=")
        assert log.read_text(encoding="utf-8").startswith(f"--- {bridge._iso(T0)} started by the cswap side panel ---\n")
        (started,) = driven.started
        assert started["argv"][0] == sys.executable and started["argv"][-1] == f"--bridge-job={job.id}"
        assert started["cwd"] == root and started["log_path"] == log
        assert started["env"]["PYTHONPATH"].split(os.pathsep)[0] == bridge.code_dir()
        # Asked again while it runs: the same one, nothing started twice.
        again = _one(host, {"type": "import.driven", "job": job.id})
        assert again["driven"]["pid"] == 4242 and len(driven.started) == 1
        assert _one(host, {"type": "import.driven.state", "job": job.id})["driven"]["running"] is True

    def test_extra_keys_in_the_message_change_nothing(self, root, driven):
        host = _host(root)
        job = _done_export(host)
        expected, _ = bridge.driven_command(root, bridge.load_job(root))
        reply = _one(host, {"type": "import.driven", "job": job.id, "argv": ["calc.exe"], "path": "C:\\evil", "to": "1",
                            "name": "--evil", "python": "evil.exe", "command": "rm -rf /", "into": CARRY, "export": "x"})
        assert reply["type"] == "driven", reply
        assert driven.started[0]["argv"] == expected
        state = _one(host, {"type": "import.driven.state", "job": job.id, "log": "C:\\Windows\\win.ini"})
        assert state["driven"]["log"] == str(bridge.driven_log_path(root, job.id))

    def test_refusals(self, root, driven, monkeypatch):
        host = _host(root)
        assert _one(host, {"type": "import.driven", "job": "nope"})["code"] == "not-claimed"
        assert _one(host, {"type": "import.driven.state", "job": "nope"})["code"] == "not-claimed"
        # An export still running.
        running = bridge.Job.from_dict(_one(host, {"type": "export.new"})["job"])
        _one(host, {"type": "export.choose", "job": running.id, "project": PROJECT, "destination": "2", "source": SOURCE})
        assert _one(host, {"type": "import.driven", "job": running.id})["code"] == "not-done"
        bridge.request_cancel(root, running.id, now=T0, force=True)
        # Another browser's.
        job = _done_export(host)
        other = _host(root, instance=OTHER_INSTANCE)
        assert _one(other, {"type": "import.driven", "job": job.id})["code"] == "not-claimed"
        assert _one(host, {"type": "import.driven.state", "job": job.id})["code"] == "not-driven"
        # Nothing chosen to copy into.
        unchosen = bridge.Job.from_dict(_one(host, {"type": "export.new"})["job"])
        for event in ({"event": "done", "result": {}}, {"event": "phase", "phase": "done"}):
            _one(host, {"type": "event", "job": unchosen.id, **event})
        assert _one(host, {"type": "import.driven", "job": unchosen.id})["code"] == "not-chosen"
        # An export with a file missing.
        short = _done_export(host, tree={k: v for k, v in _export_tree().items() if not k.endswith("table.csv")})
        reply = _one(host, {"type": "import.driven", "job": short.id})
        assert reply["code"] == "export-incomplete" and "missing" in reply["message"]
        # A name with a line break in it.
        broken = _done_export(host, name="two\nlines")
        assert _one(host, {"type": "import.driven", "job": broken.id})["code"] == "bad-name"
        # The slot names another account now.
        changed = _done_export(host)
        registry = json.loads((root / bridge.SEQUENCE_FILE).read_text(encoding="utf-8"))
        registry["accounts"]["2"]["email"] = "c@example.com"
        (root / bridge.SEQUENCE_FILE).write_text(json.dumps(registry), encoding="utf-8")
        reply = _one(host, {"type": "import.driven", "job": changed.id})
        assert reply["code"] == "account-changed" and "c@example.com" in reply["message"]
        _registry(root)
        # The import job that follows the tab's route is not an export.
        queued = _one(host, {"type": "import.queue", "job": changed.id})["job"]
        _one(host, {"type": "job.claim", "job": queued["id"], "instance": INSTANCE, "extension_version": "0.2.0"})
        assert _one(host, {"type": "import.driven", "job": queued["id"]})["code"] == "not-export"
        bridge.request_cancel(root, queued["id"], now=T0, force=True)
        # Nothing could be started: said so, and nothing recorded.
        real = TestDrivenImport._real_spawn

        def refused(argv, **kwargs):
            raise OSError("no such file")

        monkeypatch.setattr(bridge, "_spawn_detached", lambda argv, **kw: real(argv, popen=refused, startupinfo=object(), **kw))
        failed = _done_export(host)
        reply = _one(host, {"type": "import.driven", "job": failed.id})
        assert reply["code"] == "spawn-failed" and "no such file" in reply["message"]
        assert "driven" not in bridge.load_job(root).duplicate
        assert driven.started == []

    _real_spawn = staticmethod(bridge._spawn_detached)

    def test_the_child_gets_the_hosts_code_and_backup_dir(self, root, tmp_path):
        given = {"PATH": "p", "PYTHONPATH": "old", "HOME": "h"}
        env = bridge._child_env(root, given, backup_root=root)
        assert env["PYTHONPATH"] == bridge.code_dir() + os.pathsep + "old"
        assert env["PYTHONIOENCODING"] == "utf-8"
        assert set(env) == {"PATH", "PYTHONPATH", "HOME", "PYTHONIOENCODING"}, "nothing else added or taken away"
        assert given == {"PATH": "p", "PYTHONPATH": "old", "HOME": "h"}, "the host's own environment is not changed"
        assert bridge._child_env(root, {}, backup_root=root)["PYTHONPATH"] == bridge.code_dir()
        # Chrome's environment finds another backup folder: on Linux the
        # child is pointed at the host's; anywhere else the host refuses.
        served = tmp_path / "data" / "claude-swap"
        env = bridge._child_env(served, {}, platform="linux", backup_root=tmp_path / "elsewhere" / "claude-swap")
        assert env["XDG_DATA_HOME"] == str(tmp_path / "data")
        for platform, where in (("win32", served), ("darwin", served), ("linux", tmp_path / "not-named-so")):
            with pytest.raises(bridge.BridgeError) as e:
                bridge._child_env(where, {}, platform=platform, backup_root=tmp_path / "other")
            assert e.value.code == "root-mismatch"

    def test_windows_spawn_never_passes_the_protocol_pipe(self, tmp_path):
        # Runs on every system: the Windows branch is taken by name, and the
        # window's STARTUPINFO is handed in.
        calls: list[dict] = []

        class Proc:
            pid = 77

        def popen(argv, **kwargs):
            calls.append(kwargs)
            return Proc()

        info = object()
        pid = bridge._spawn_detached(["py", "-m", "claude_swap"], cwd=tmp_path, env={"A": "1"}, log_path=tmp_path / "d.log",
                                     platform="win32", popen=popen, startupinfo=info)
        assert pid == 77
        (kw,) = calls
        assert kw["stdin"] is None and kw["stdout"] is None and kw["stderr"] is None
        assert kw["creationflags"] == 0x10 | 0x01000000 and kw["startupinfo"] is info
        assert kw["close_fds"] is True and kw["env"] == {"A": "1"} and kw["cwd"] == str(tmp_path)
        assert not (tmp_path / "d.log").exists(), "the child keeps its own log on Windows"
        # A job object that cannot be left: once more, inside it.
        calls.clear()

        def no_breakaway(argv, **kwargs):
            calls.append(kwargs)
            if kwargs["creationflags"] & 0x01000000:
                raise OSError("access is denied")
            return Proc()

        assert bridge._spawn_detached(["py"], cwd=tmp_path, env={}, log_path=tmp_path / "d.log", platform="win32",
                                      popen=no_breakaway, startupinfo=info) == 77
        assert [c["creationflags"] for c in calls] == [0x10 | 0x01000000, 0x10]
        assert all(c["stdout"] is None and c["stdin"] is None and c["stderr"] is None for c in calls)

        def never(argv, **kwargs):
            raise OSError("not found")

        with pytest.raises(bridge.BridgeError) as e:
            bridge._spawn_detached(["py"], cwd=tmp_path, env={}, log_path=tmp_path / "d.log", platform="win32",
                                   popen=never, startupinfo=info)
        assert e.value.code == "spawn-failed"
        # Elsewhere: no window, the output into the log, a session of its own.
        calls.clear()
        log = tmp_path / "posix.log"
        assert bridge._spawn_detached(["py"], cwd=tmp_path, env={}, log_path=log, platform="linux", popen=popen) == 77
        (kw,) = calls
        assert kw["stdin"] is subprocess.DEVNULL and kw["stderr"] is subprocess.STDOUT and kw["start_new_session"] is True
        assert kw["stdout"].name == str(log) and kw["stdout"].closed, "the host keeps no handle on the log"

    @pytest.mark.skipif(sys.platform != "win32", reason="STARTUPINFO is Windows only")
    def test_the_window_is_shown(self):
        info = bridge._shown_window()
        assert info.dwFlags & 0x1 and info.wShowWindow == 1

    def test_state_running_done_stopped_lost(self, root, driven):
        host = _host(root)
        job = _done_export(host)
        _one(host, {"type": "import.driven", "job": job.id})
        bridge.note_driven_end(root, job.id, exit_code=0, url="https://claude.ai/code/project/chan_01NEW", now=T0 + 60)
        state = bridge.driven_state(root, job.id, INSTANCE, now=T0 + 61)
        assert state["running"] is False and state["lost"] is False and state["exit_code"] == 0
        assert state["url"] == "https://claude.ai/code/project/chan_01NEW" and state["ended_at"] == bridge._iso(T0 + 60)
        # A stop names the project to carry on in; an address not claude.ai's is dropped.
        current = bridge.load_job(root)
        current.duplicate["driven"].update(ended_at=None, exit_code=None, url="")
        bridge.save_job(root, current)
        bridge.note_driven_end(root, job.id, exit_code=1, carry_on=CARRY, made=CARRY, url="https://evil.example/x",
                               message="The import stopped part-way: sessionKey=sk-ant-sid01-abcdefghijklmnopqrstuvwxyz")
        state = bridge.driven_state(root, job.id, INSTANCE)
        assert state["exit_code"] == 1 and state["carry_on"] == CARRY and state["made"] == CARRY and state["url"] == ""
        assert "abcdefghij" not in state["message"] and state["message"].startswith("The import stopped part-way")
        # Its process gone without a word: lost.
        current = bridge.load_job(root)
        current.duplicate["driven"].update(ended_at=None, exit_code=None)
        bridge.save_job(root, current)
        assert bridge.driven_state(root, job.id, INSTANCE, now=T0 + 120)["running"] is True
        driven.alive.clear()
        state = bridge.driven_state(root, job.id, INSTANCE, now=T0 + 120)
        assert state["running"] is False and state["lost"] is True
        # Alive, but older than any import can be: not running either.
        driven.alive.add(4242)
        state = bridge.driven_state(root, job.id, INSTANCE, now=T0 + bridge.DRIVEN_MAX_SECONDS + 1)
        assert state["running"] is False and state["lost"] is True
        # Done with no address recorded: the window's own last line says it.
        bridge.driven_log_path(root, job.id).write_text(
            "Imported: the new project is at https://claude.ai/code/project/chan_01TAIL\n", encoding="utf-8")
        bridge.note_driven_end(root, job.id, exit_code=0)
        assert bridge.driven_state(root, job.id, INSTANCE)["url"] == "https://claude.ai/code/project/chan_01TAIL"

    def test_the_tail_is_short_and_redacted(self, root, driven):
        host = _host(root)
        job = _done_export(host)
        _one(host, {"type": "import.driven", "job": job.id})
        secret = "sk-ant-api03-" + "A" * 40
        lines = [f"line {i}" for i in range(30)] + [
            "\x1b[31mred\x1b[0m and \x1b[2mdim\x1b[0m",
            "cookie: sessionKey=sk-ant-sid01-SESSIONSESSIONSESSION",
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
            f"key {secret}",
            "signed in at https://claude.ai/login?returnTo=%2Fnew&foo=bar#frag then on",
            "x" * 1000,
        ]
        with open(bridge.driven_log_path(root, job.id), "a", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
        tail = _one(host, {"type": "import.driven.state", "job": job.id})["driven"]["tail"]
        assert len(tail) == bridge.DRIVEN_TAIL_LINES
        assert all(len(line) <= bridge.DRIVEN_LINE_CHARS for line in tail)
        text = "\n".join(tail)
        assert "\x1b" not in text and "red and dim" in text
        for leaked in ("SESSIONSESSION", "abcdefghijklmnop", secret, "returnTo", "foo=bar", "#frag"):
            assert leaked not in text, leaked
        assert "signed in at https://claude.ai/login then on" in text
        assert tail[-1] == "x" * bridge.DRIVEN_LINE_CHARS
        # A log longer than what is read: its first, cut line is left out.
        with open(bridge.driven_log_path(root, job.id), "a", encoding="utf-8") as handle:
            handle.write(("y" * 100 + "\n") * 2000)
        assert set(bridge._log_tail(bridge.driven_log_path(root, job.id))) == {"y" * 100}

    def test_a_running_driven_import_blocks_a_new_job_and_there_is_a_way_past(self, root, driven, monkeypatch):
        host = _host(root)
        job = _done_export(host)
        _one(host, {"type": "import.driven", "job": job.id})
        with pytest.raises(bridge.JobActiveError) as e:
            bridge.new_export_job(root, instance=INSTANCE, now=T0 + 5)
        assert "process 4242" in str(e.value) and "--cancel" in str(e.value)
        assert _one(host, {"type": "export.new"})["code"] == "job-active"
        assert _one(host, {"type": "import.queue", "job": job.id})["code"] == "job-active"
        # The number now names another process, started later: not blocked.
        driven.created[4242] += 3600
        assert bridge.load_job(root).duplicate["driven"]["ended_at"] is None
        assert bridge._driven_running(bridge.load_job(root).duplicate["driven"], T0 + 5) is False
        # Its start cannot be read: still believed, and --cancel lets go of it.
        driven.created.pop(4242)
        with pytest.raises(bridge.JobActiveError):
            bridge.new_export_job(root, instance=INSTANCE, now=T0 + 5)
        assert bridge.drop_driven(root, job.id, now=T0 + 6) == "dropped"
        record = bridge.load_job(root).duplicate["driven"]
        assert record["ended_at"] == bridge._iso(T0 + 6) and record["message"] == "dropped from the command line"
        assert bridge.drop_driven(root, job.id) == "none"
        # One that is verifiably the import's own is not let go: its window is the way.
        job = _done_export(host)
        _one(host, {"type": "import.driven", "job": job.id})
        assert bridge.drop_driven(root, job.id, now=T0 + 7) == "running"
        with pytest.raises(bridge.JobActiveError):
            bridge.new_export_job(root, instance=INSTANCE, now=T0 + 8)
        # Once it said how it ended, new jobs start.
        bridge.note_driven_end(root, job.id, exit_code=1, now=T0 + 9)
        assert bridge.new_export_job(root, instance=INSTANCE, now=T0 + 10).kind == "export"

    def test_a_second_start_after_a_stop_carries_on_and_after_success_is_refused(self, root, driven):
        host = _host(root)
        job = _done_export(host)
        _one(host, {"type": "import.driven", "job": job.id})
        bridge.note_driven_end(root, job.id, exit_code=1, carry_on=CARRY, made=CARRY, message="stopped")
        again = _one(host, {"type": "import.driven", "job": job.id})["driven"]
        assert again["pid"] == 4243 and again["attempt"] == 2 and again["running"] is True and again["carry_on"] == CARRY
        assert driven.started[1]["argv"][-2:] == [f"--into={CARRY}", f"--bridge-job={job.id}"]
        assert again["command"].endswith(f"--into {CARRY}")
        assert bridge.driven_log_path(root, job.id).read_text(encoding="utf-8").count("started by the cswap side panel") == 2
        # A try that ends without naming a project keeps the one to carry on in.
        bridge.note_driven_end(root, job.id, exit_code=1, message="Chrome or Edge was not found.")
        assert bridge.load_job(root).duplicate["driven"]["carry_on"] == CARRY
        _one(host, {"type": "import.driven", "job": job.id})
        bridge.note_driven_end(root, job.id, exit_code=0, url="https://claude.ai/code/project/chan_01NEW")
        assert bridge.load_job(root).duplicate["driven"]["carry_on"] == ""
        done = _one(host, {"type": "import.driven", "job": job.id})
        assert done["code"] == "driven-done" and "chan_01NEW" in done["message"]
        assert len(driven.started) == 3

    def test_the_project_is_recorded_the_moment_the_page_names_it_so_a_killed_run_still_carries_on(self, root, driven):
        host = _host(root)
        job = _done_export(host)
        _one(host, {"type": "import.driven", "job": job.id})
        # The page names the project while the run goes on.
        bridge.note_driven_link(root, job.id, CARRY)
        record = bridge.load_job(root).duplicate["driven"]
        assert record["carry_on"] == CARRY and record["made"] == CARRY and record["ended_at"] is None
        # Then the run is killed (its console window closed) and says nothing:
        # lost, but with the project to carry on in, so Carry on is offered and
        # the next start goes on in it.
        driven.alive.clear()
        state = _one(host, {"type": "import.driven.state", "job": job.id})["driven"]
        assert state["lost"] is True and state["carry_on"] == CARRY
        again = _one(host, {"type": "import.driven", "job": job.id})["driven"]
        assert again["attempt"] == 2 and driven.started[1]["argv"][-2:] == [f"--into={CARRY}", f"--bridge-job={job.id}"]
        # A regular project is named, not carried on in; an address not
        # claude.ai's, a record that ended, another job: nothing written.
        regular = "https://claude.ai/project/aaaaaaaa-0000-4000-8000-000000000001"
        current = bridge.load_job(root)
        current.duplicate["driven"]["carry_on"] = ""
        bridge.save_job(root, current)
        bridge.note_driven_link(root, job.id, regular)
        record = bridge.load_job(root).duplicate["driven"]
        assert record["made"] == regular and record["carry_on"] == ""
        for url, job_id in (("https://evil.example/x", job.id), (f"{regular}?x=1", job.id), (CARRY, "job_20200101T000000_000000"), (CARRY, "nope")):
            bridge.note_driven_link(root, job_id, url)
            assert bridge.load_job(root).duplicate["driven"]["made"] == regular, url
        # Its end keeps what the page named when the end itself names nothing.
        bridge.note_driven_end(root, job.id, exit_code=130, message="stopped: Ctrl+C, or the window was closed")
        record = bridge.load_job(root).duplicate["driven"]
        assert record["made"] == regular and record["exit_code"] == 130
        bridge.note_driven_link(root, job.id, CARRY)
        assert bridge.load_job(root).duplicate["driven"]["made"] == regular, "an ended record is not changed"

    def test_a_project_to_carry_on_in_that_is_gone_is_let_go(self, root, driven):
        host = _host(root)
        job = _done_export(host)
        _one(host, {"type": "import.driven", "job": job.id})
        bridge.note_driven_end(root, job.id, exit_code=1, carry_on=CARRY, made=CARRY, message="stopped")
        _one(host, {"type": "import.driven", "job": job.id})
        # The project was deleted: the try refuses before making anything, and
        # says so. The next start makes a new project instead of the same refusal.
        bridge.note_driven_end(root, job.id, exit_code=1, forget_carry_on=True, message=f"{CARRY} is not in view from b@example.com")
        assert bridge.load_job(root).duplicate["driven"]["carry_on"] == ""
        _one(host, {"type": "import.driven", "job": job.id})
        assert not any(a.startswith("--into") for a in driven.started[2]["argv"])

    def test_how_to_stop_it_is_said_for_the_system_it_runs_on(self, root, driven):
        assert bridge.driven_stop_hint(4242, "win32") == "close its console window"
        assert bridge.driven_stop_hint(4242, "darwin") == "end its process with kill 4242"
        assert bridge.driven_stop_hint(None, "linux") == "end its process with kill"
        host = _host(root)
        job = _done_export(host)
        _one(host, {"type": "import.driven", "job": job.id})
        with pytest.raises(bridge.JobActiveError) as e:
            bridge.new_export_job(root, instance=INSTANCE, now=T0 + 5)
        assert f"or stop it ({bridge.driven_stop_hint(4242)})" in str(e.value)
        assert "close that window" not in str(e.value)

    @pytest.mark.parametrize(
        ("text", "win", "posix"),
        [
            ("Beethoven", "Beethoven", "Beethoven"),
            ("-draft", "-draft", "-draft"),
            ("@notes", "@notes", "@notes"),
            ("C:\\Users\\greg\\Desktop\\beethoven", "C:\\Users\\greg\\Desktop\\beethoven", "'C:\\Users\\greg\\Desktop\\beethoven'"),
            ("beethoven (2)", '"beethoven (2)"', "'beethoven (2)'"),
            ("notes,v2", '"notes,v2"', "notes,v2"),
            ("Q3 $budget", "'Q3 $budget'", "'Q3 $budget'"),
            ("tick`s", "'tick`s'", "'tick`s'"),
            ("it's $5", "'it''s $5'", """'it'"'"'s $5'"""),
            ('Bob\'s "plan"', None, """'Bob'"'"'s "plan"'"""),
            ("a b\\", None, "'a b\\'"),
            ("two\nlines", None, None),
            ("", None, None),
        ],
    )
    def test_a_value_on_a_line_to_type(self, text, win, posix):
        assert bridge.typed_value(text, "win32") == win
        assert bridge.typed_value(text, "linux") == posix

    def test_note_driven_end_never_raises(self, root, driven, monkeypatch):
        host = _host(root)
        job = _done_export(host)
        # No record yet, a job id that is not one, another job: nothing written.
        bridge.note_driven_end(root, job.id, exit_code=0)
        bridge.note_driven_end(root, "nope", exit_code=0)
        bridge.note_driven_end(root, "job_20200101T000000_000000", exit_code=0)
        assert "driven" not in bridge.load_job(root).duplicate
        _one(host, {"type": "import.driven", "job": job.id})
        before = bridge._job_path(root).read_bytes()

        class Busy:
            def __init__(self, root, timeout=5.0):
                pass

            def __enter__(self):
                raise bridge.BridgeBusy("busy")

            def __exit__(self, *exc):
                return False

        monkeypatch.setattr(bridge, "_Locked", Busy)
        bridge.note_driven_end(root, job.id, exit_code=0)
        monkeypatch.undo()
        assert bridge._job_path(root).read_bytes() == before
        bridge._job_path(root).write_text("{damaged", encoding="utf-8")
        bridge.note_driven_end(root, job.id, exit_code=0)
        assert bridge._job_path(root).read_text(encoding="utf-8") == "{damaged"

    def test_bridge_status_says_where_it_stands(self, root, driven):
        assert bridge.driven_summary(None) == ""
        host = _host(root)
        job = _done_export(host)
        _one(host, {"type": "import.driven", "job": job.id})
        record = bridge.load_job(root).duplicate["driven"]
        log = bridge.driven_log_path(root, job.id)
        assert bridge.driven_summary(record, T0 + 1) == f"Import in its own window: running (process 4242) since {bridge._iso(T0)}; log: {log}"
        bridge.note_driven_end(root, job.id, exit_code=1, carry_on=CARRY)
        record = bridge.load_job(root).duplicate["driven"]
        assert bridge.driven_summary(record) == f"Import in its own window: stopped (exit 1); carries on in {CARRY}; log: {log}"
        record.update(exit_code=0, url="https://claude.ai/code/project/chan_01NEW")
        assert bridge.driven_summary(record).startswith("Import in its own window: done https://claude.ai/code/project/chan_01NEW")
        record.update(ended_at=None)
        driven.alive.clear()
        assert "ended without a word" in bridge.driven_summary(record, T0 + 1)

    def test_cancel_on_the_command_line_lets_go_of_one_whose_window_is_gone(self, root, driven, capsys):
        from types import SimpleNamespace

        from claude_swap import cli

        # The command line reads the wall clock, so the host does too here.
        host = _host(root, now=time.time)
        job = _done_export(host)
        _one(host, {"type": "import.driven", "job": job.id})
        args = SimpleNamespace(cancel=True, watch=False)
        cli._project_move_job_command(pm, args, root)
        said = capsys.readouterr().out
        assert f"The import of job {job.id} is running in its own window (process 4242); to stop it, {bridge.driven_stop_hint(4242)}." in said
        driven.created.pop(4242)  # its start can no longer be told
        cli._project_move_job_command(pm, args, root)
        assert "a new job can start" in capsys.readouterr().out
        cli._project_move_job_command(pm, args, root)
        assert "No import is queued or running." in capsys.readouterr().out

        class St:
            installed = True
            manifest_ok = launcher_ok = python_ok = code_ok = True
            extension_id = EXT_ID
            extension_dir = None
            registrations = []
            problems = []
            job = bridge.load_job(root)

        cli._print_bridge_status(bridge, St, False)
        assert "Import in its own window: stopped (exit ?)" in capsys.readouterr().out
