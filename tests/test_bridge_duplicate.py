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
                         "cancel_requested": False}
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

    def test_a_piece_out_of_order_is_refused_and_an_identical_resend_is_taken(self, root):
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
        other = _write(host, job.id, "Demo/x.bin", b"DEF", 3, True)
        assert other["type"] == "error" and other["code"] == "out-of-order"
        # The first piece starts the file afresh, whatever is there.
        fresh = _write(host, job.id, "Demo/x.bin", b"z", 0, True)
        assert fresh["size"] == 1

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
