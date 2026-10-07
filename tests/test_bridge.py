"""Tests for the native-messaging bridge (``claude_swap.bridge``).

Everything runs against a ``tmp_path`` backup root with stdio as
``BytesIO``, the clock injected, the registry a dict, and the platform a
string: no test touches the real registry, the real home, or a socket.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import os
import shutil
import struct
import sys
import tarfile
import threading
import time
from pathlib import Path

import pytest

from claude_swap import bridge
from claude_swap import project_move as pm

T0 = 1_700_000_000  # 2023-11-14T22:13:20Z
ACCOUNT = ("2", "b@example.com", "dddddddd-0000-4000-8000-000000000000")
INSTANCE = "11111111-2222-4333-8444-555555555555"
OTHER_INSTANCE = "99999999-2222-4333-8444-555555555555"
EXT_ID = "a" * 32
ORIGIN = f"chrome-extension://{EXT_ID}/"
SCRIPT = pm.script_text("import")

_FILES = {"Files/notes.md": b"# notes\n", "Files/data/table.csv": b"a,b\n1,2\n"}
_HISTORY = {"Threads/001 Kick-off.md": b"thread\n"}
BIG = (bytes(range(256)) * 5079)[:1_300_000]


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------


def _make_export(parent: Path, name: str = "Demo", *, extra: dict[str, bytes] | None = None) -> Path:
    """A small finished Claude Code export, as project-export.js lays one out."""
    root = parent / name
    files = dict(_FILES)
    if extra:
        files.update(extra)
    for relative, data in {**files, **_HISTORY}.items():
        target = root.joinpath(*relative.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
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
    (root / pm.MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    return root


def _pack(root: Path, archive: Path, *, nested: bool = True) -> Path:
    """The export folder as the browser's .tar: files only, under the folder's name (or not)."""
    with tarfile.open(archive, "w", format=tarfile.GNU_FORMAT) as tar:
        for file in sorted(p for p in root.rglob("*") if p.is_file()):
            relative = file.relative_to(root).as_posix()
            tar.add(file, arcname=f"{root.name}/{relative}" if nested else relative)
    return archive


def _check(path: Path) -> pm.ExportCheck:
    return pm.read_export_tar(path) if pm.is_archive(path) else pm.read_export(path)


def _queue(root: Path, export: Path, name: str | None = None, now=T0) -> bridge.Job:
    check = _check(export)
    assert check.complete, check.error
    return bridge.new_job(root, export=check, account=ACCOUNT, name=name, script_text=SCRIPT, now=now)


class _ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines: list[str] = []

    def emit(self, record):
        self.lines.append(self.format(record))


def _test_logger(name: str = "test-bridge") -> tuple[logging.Logger, _ListHandler]:
    logger = logging.getLogger(name)
    logger.handlers.clear()
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    handler = _ListHandler()
    handler.addFilter(bridge._RedactingFilter())
    logger.addHandler(handler)
    return logger, handler


def _host(root: Path, *, now=None, log=None, stdin=b"", origin: str = ORIGIN) -> bridge.BridgeHost:
    return bridge.BridgeHost(root, io.BytesIO(stdin), io.BytesIO(), origin=origin, now=now, log=log)


def _one(host: bridge.BridgeHost, msg: dict) -> dict:
    replies = list(host.handle(msg))
    assert len(replies) == 1, replies
    return replies[0]


def _hello(host: bridge.BridgeHost, instance: str = INSTANCE, msg_id: int = 1, protocol: int = 1) -> dict:
    return _one(
        host,
        {
            "id": msg_id,
            "type": "hello",
            "protocol": protocol,
            "extension": {"version": "0.1.0", "instance": instance},
            "chrome": "140",
            "userScripts": True,
        },
    )


def _claim(host: bridge.BridgeHost, job_id: str, instance: str = INSTANCE, msg_id: int = 2) -> dict:
    return _one(
        host,
        {"id": msg_id, "type": "job.claim", "job": job_id, "instance": instance, "extension_version": "0.1.0"},
    )


def _ready_host(root: Path, job: bridge.Job, **kw) -> bridge.BridgeHost:
    """A host that said hello and claimed ``job``."""
    host = _host(root, **kw)
    _hello(host)
    reply = _claim(host, job.id)
    assert reply["type"] == "job", reply
    return host


def _frames(data: bytes) -> list[dict]:
    """Every frame in ``data``, which must hold nothing else."""
    stream = io.BytesIO(data)
    out = []
    while True:
        msg = bridge.read_message(stream)
        if msg is None:
            break
        out.append(msg)
    assert stream.tell() == len(data)
    return out


class FakeWinreg:
    """A dict standing in for HKCU: subkey -> default value."""

    HKEY_CURRENT_USER = "HKCU"
    REG_SZ = 1

    def __init__(self):
        self.keys: dict[str, str | None] = {}

    def CreateKey(self, root, sub):
        assert root == self.HKEY_CURRENT_USER
        self.keys.setdefault(sub, None)
        return sub

    def OpenKey(self, root, sub):
        if sub not in self.keys:
            raise OSError("not found")
        return sub

    def SetValueEx(self, key, name, reserved, kind, value):
        assert name == "" and kind == self.REG_SZ
        self.keys[key] = value

    def QueryValue(self, root, sub):
        if self.keys.get(sub) is None:
            raise OSError("not found")
        return self.keys[sub]

    def DeleteKey(self, root, sub):
        if sub not in self.keys:
            raise OSError("not found")
        del self.keys[sub]

    def CloseKey(self, key):
        pass


@pytest.fixture
def root(tmp_path: Path) -> Path:
    return tmp_path / "backup"


@pytest.fixture
def export(tmp_path: Path) -> Path:
    return _make_export(tmp_path / "exports")


@pytest.fixture
def big_export(tmp_path: Path) -> Path:
    return _make_export(tmp_path / "exports", "Big", extra={"Files/big.bin": BIG, "Files/empty.txt": b""})


@pytest.fixture(autouse=True)
def _close_host_log():
    """serve() wires the real bridge.log handler; close it so tmp dirs can go."""
    yield
    logger = logging.getLogger("claude-swap.bridge")
    for handler in list(logger.handlers):
        handler.close()
        logger.removeHandler(handler)


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------


class TestFraming:
    def test_encode_is_little_endian_length_then_compact_ascii_json(self):
        assert bridge.encode({"a": 1, "b": "x"}) == b"\x0f\x00\x00\x00" + b'{"a":1,"b":"x"}'
        assert bridge.encode({}) == b"\x02\x00\x00\x00{}"

    def test_length_bytes_are_little_endian_for_a_long_body(self):
        frame = bridge.encode({"k": "v" * 300})
        assert frame[:4] == struct.pack("<I", len(frame) - 4)
        assert frame[:4] == bytes([len(frame) - 4 & 0xFF, (len(frame) - 4) >> 8, 0, 0])

    def test_round_trip_and_clean_eof(self):
        stream = io.BytesIO()
        for msg in ({"id": 1}, {"id": 2, "nested": {"x": [1, 2]}}, {"id": 3}):
            bridge.write_message(stream, msg)
        stream.seek(0)
        assert bridge.read_message(stream) == {"id": 1}
        assert bridge.read_message(stream) == {"id": 2, "nested": {"x": [1, 2]}}
        assert bridge.read_message(stream) == {"id": 3}
        assert bridge.read_message(stream) is None
        assert bridge.read_message(stream) is None

    def test_eof_on_an_empty_stream_is_none(self):
        assert bridge.read_message(io.BytesIO(b"")) is None

    @pytest.mark.parametrize(
        "data, why",
        [
            (b"\x05\x00", "header"),
            (struct.pack("<I", 10) + b"abc", "body"),
            (struct.pack("<I", 3) + b"[1]", "object"),
            (struct.pack("<I", 4) + b"null", "object"),
            (struct.pack("<I", 0), "JSON"),
            (struct.pack("<I", 3) + b"\xff\xfe\xfd", "JSON"),
        ],
    )
    def test_broken_frames_are_protocol_errors(self, data, why):
        with pytest.raises(bridge.BridgeProtocolError) as e:
            bridge.read_message(io.BytesIO(data))
        assert why in str(e.value)

    def test_oversize_extension_frame_is_refused_before_its_body_is_read(self):
        stream = io.BytesIO(struct.pack("<I", bridge.MAX_EXTENSION_MESSAGE + 1) + b"x" * 16)
        with pytest.raises(bridge.BridgeProtocolError):
            bridge.read_message(stream)
        assert stream.tell() == 4

    def test_oversize_reply_is_refused_not_cut(self):
        with pytest.raises(bridge.BridgeProtocolError) as e:
            bridge.encode({"data": "x" * bridge.MAX_HOST_MESSAGE})
        assert e.value.code == "too-large"

    def test_non_ascii_is_escaped_so_the_frame_is_plain_bytes(self):
        frame = bridge.encode({"name": "Caf\u00e9 \u2014 \U0001f600"})
        body = frame[4:]
        body.decode("ascii")
        assert b"\\u00e9" in body
        assert json.loads(body) == {"name": "Caf\u00e9 \u2014 \U0001f600"}

    def test_partial_reads_are_assembled(self):
        class Trickle(io.BytesIO):
            def read(self, n=-1):
                return super().read(1 if n is None or n < 0 else min(1, n))

        frame = bridge.encode({"id": 7, "text": "a" * 50})
        assert bridge.read_message(Trickle(frame)) == {"id": 7, "text": "a" * 50}

    def test_write_message_flushes(self):
        class Counting(io.BytesIO):
            flushes = 0

            def flush(self):
                self.flushes += 1
                super().flush()

        stream = Counting()
        bridge.write_message(stream, {"re": 1})
        assert stream.flushes == 1

    def test_encode_refuses_what_is_not_an_object(self):
        with pytest.raises(bridge.BridgeProtocolError):
            bridge.encode([1, 2])  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------


class TestRedaction:
    def test_secret_keys_are_masked_whatever_they_hold(self):
        out = bridge.redact_for_log(
            {
                "Cookie": "a=b",
                "set-cookie": "x",
                "Authorization": "plain",
                "X-Api-Key": "k",
                "sessionKey": "s",
                "my_token": "t",
                "client_secret": "u",
                "proxy-authorization": "v",
                "__cf_bm": "w",
                "cf-ray": "8a1b2c3d4e5f-IAD",
                "status": 403,
                "path": "/api/organizations/x/projects",
                "stepKey": "POST /api/organizations/x/projects json:deadbeef",
            }
        )
        for key in ("Cookie", "set-cookie", "Authorization", "X-Api-Key", "sessionKey", "my_token",
                    "client_secret", "proxy-authorization", "__cf_bm"):
            assert out[key] == "[redacted]", key
        assert out["cf-ray"] == "8a1b2c3d4e5f-IAD"
        assert out["status"] == 403
        assert out["path"] == "/api/organizations/x/projects"
        assert out["stepKey"] == "POST /api/organizations/x/projects json:deadbeef"

    @pytest.mark.parametrize(
        "text, gone, kept",
        [
            ("key sk-ant-api03-abcdefghijklmnop here", "sk-ant-api03", "here"),
            ("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "abcdefghijklmnopqrstuvwxyz012345", "Bearer"),
            ("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl end", "eyJhbGci", "end"),
            ("sessionKey=sk-ant-sid01-zzzzzzzzzz; other=1", "zzzzzzzzzz", "other=1"),
            ("cf_clearance=abc123def456; __cf_bm=xyz789", "abc123def456", "cf_clearance="),
            ("https://claude.ai/login?token=abc123&x=1#frag", "abc123", "/login?token="),
            ("https://claude.ai/x?state=abc123&code=def456&page=2", "abc123", "page=2"),
            ("/api/auth?sessionKey=sk-ant-sid01-abcdefghij", "abcdefghij", "/api/auth?sessionKey="),
            ("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----", "MIIE", "redacted private key"),
            ("API_KEY=abcd1234efgh", "abcd1234efgh", "API_KEY="),
            ("ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdef", "[redacted]"),
            ("AKIAIOSFODNN7EXAMPLE", "IOSFODNN7", "[redacted]"),
        ],
    )
    def test_secret_values_are_masked_in_strings(self, text, gone, kept):
        out = bridge.redact_text(text)
        assert gone not in out, out
        assert kept in out, out

    @pytest.mark.parametrize(
        "text",
        [
            "cf-ray 8a1b2c3d4e5f-IAD status 429 path /api/organizations/x/upload",
            "Bearer short",
            "POST /api/organizations/x/projects json:deadbeef",
            "https://claude.ai/code/project/chan_abc?tab=files",
            "the token was refused",
        ],
    )
    def test_harmless_text_is_untouched(self, text):
        assert bridge.redact_text(text) == text

    def test_nested_lists_dicts_cycles_and_depth(self):
        inner = {"authorization": "x", "items": ["sk-ant-api03-abcdefghijklmnop", {"ok": 1}]}
        inner["self"] = inner
        out = bridge.redact_for_log({"a": [inner, (1, "Bearer abcdefghijklmnopqrstuvwxyz")]})
        assert out["a"][0]["authorization"] == "[redacted]"
        assert out["a"][0]["items"][0] == "[redacted]"
        assert out["a"][0]["items"][1] == {"ok": 1}
        assert out["a"][0]["self"] == "[cycle]"
        assert out["a"][1][1] == "Bearer [redacted]"
        deep: dict = {}
        cursor = deep
        for _ in range(40):
            cursor["d"] = {}
            cursor = cursor["d"]
        bridge.redact_for_log(deep)  # neither recursion error nor hang

    def test_chunk_data_and_script_text_become_their_size(self):
        chunk = {"re": 5, "type": "file.chunk", "data": base64.b64encode(b"x" * 1000).decode(), "last": False}
        assert bridge.redact_for_log(chunk)["data"] == "<1000 bytes>"
        script = {"re": 6, "type": "script", "text": "a" * 500}
        assert bridge.redact_for_log(script)["text"] == "<500 chars>"
        assert bridge.redact_for_log({"data": "plain", "type": "other"})["data"] == "plain"
        assert bridge.redact_for_log(b"\x00\x01\x02") == "<3 bytes>"

    def test_scalars_pass_through(self):
        assert bridge.redact_for_log(None) is None
        assert bridge.redact_for_log(True) is True
        assert bridge.redact_for_log(3.5) == 3.5
        assert bridge.redact_for_log({"n": 7, "f": False}) == {"n": 7, "f": False}

    def test_the_log_filter_masks_formatted_records(self):
        logger, handler = _test_logger()
        logger.info("token %s given", "sk-ant-api03-abcdefghijklmnop")
        assert handler.lines == ["token [redacted] given"]


# ---------------------------------------------------------------------------
# The packaged extension
# ---------------------------------------------------------------------------


class TestExtensionId:
    def test_id_from_key_matches_chromes_rule(self):
        der = b"not really a DER key but any bytes do for the rule"
        key = base64.b64encode(der).decode()
        digest = hashlib.sha256(der).hexdigest()[:32]
        expected = "".join("abcdefghijklmnop"[int(c, 16)] for c in digest)
        assert bridge.extension_id_from_key(key) == expected
        assert len(expected) == 32 and set(expected) <= set("abcdefghijklmnop")

    def test_bad_base64_is_refused(self):
        with pytest.raises(bridge.BridgeError):
            bridge.extension_id_from_key("not base64!!")

    def test_packaged_manifest_pins_the_id_the_readme_states(self):
        directory = bridge.extension_dir()
        assert directory is not None and (directory / "manifest.json").is_file()
        ext_id = bridge.default_extension_id()
        assert len(ext_id) == 32 and set(ext_id) <= set("abcdefghijklmnop")
        readme = (directory / "README.md").read_text(encoding="utf-8")
        assert f"`{ext_id}`" in readme

    def test_script_sha256(self):
        assert bridge.script_sha256("abc") == hashlib.sha256(b"abc").hexdigest()


# ---------------------------------------------------------------------------
# Job files
# ---------------------------------------------------------------------------


class TestJobFiles:
    def test_new_job_writes_job_json_and_an_empty_events_file(self, root, export):
        job = _queue(root, export, name="Moved")
        assert bridge._JOB_ID_RE.match(job.id)
        assert job.id.startswith("job_20231114T221320_")
        on_disk = json.loads((root / "bridge" / "job.json").read_text(encoding="utf-8"))
        assert on_disk["id"] == job.id
        assert on_disk["version"] == 1
        assert on_disk["status"] == "queued" and on_disk["phase"] == ""
        assert on_disk["created_at"] == "2023-11-14T22:13:20Z" == on_disk["updated_at"]
        assert on_disk["export"] == {
            "path": str(export), "archive": False, "name": "Demo", "kind": "code",
            "files": 2, "conversations": 1, "bytes": 23,  # the history file counts too, as check does
        }
        assert on_disk["account"] == {"slot": "2", "email": "b@example.com", "org_uuid": ACCOUNT[2]}
        assert on_disk["name"] == "Moved"
        assert on_disk["script"]["sha256"] == hashlib.sha256(SCRIPT.encode()).hexdigest()
        assert on_disk["script"]["bytes"] == len(SCRIPT.encode())
        assert on_disk["claimed_by"] is None and on_disk["cancel_requested"] is False
        assert on_disk["created_project"] is None and on_disk["result"] is None and on_disk["error"] is None
        events = bridge.events_path(root, job.id)
        assert events.is_file() and events.read_bytes() == b""
        assert not list((root / "bridge").glob("*.tmp"))
        if sys.platform != "win32":
            assert (root / "bridge").stat().st_mode & 0o777 == 0o700
            assert (root / "bridge" / "job.json").stat().st_mode & 0o777 == 0o600
            assert events.stat().st_mode & 0o777 == 0o600

    def test_new_job_takes_the_archive_and_a_blank_name_as_none(self, root, export, tmp_path):
        archive = _pack(export, tmp_path / "Demo.tar")
        job = _queue(root, archive, name="   ")
        assert job.export["archive"] is True and job.export["path"] == str(archive)
        assert job.name is None

    def test_new_job_refuses_while_the_current_job_is_active(self, root, export):
        first = _queue(root, export)
        with pytest.raises(bridge.JobActiveError) as e:
            _queue(root, export)
        assert first.id in str(e.value) and "--cancel" in str(e.value)
        for status in ("claimed", "running", "held"):
            first.status = status
            bridge.save_job(root, first)
            with pytest.raises(bridge.JobActiveError):
                _queue(root, export)
        first.status = "done"
        bridge.save_job(root, first)
        second = _queue(root, export)
        assert second.id != first.id
        assert bridge.load_job(root).id == second.id

    def test_new_job_keeps_five_events_files_and_the_current_one(self, root, export):
        ids = []
        for _ in range(7):
            job = _queue(root, export)
            ids.append(job.id)
            job.status = "cancelled"
            bridge.save_job(root, job)
        kept = sorted(p.name for p in (root / "bridge").glob("events-*.jsonl"))
        assert len(kept) == 5
        assert f"events-{ids[-1]}.jsonl" in kept

    def test_new_job_replaces_a_damaged_job_file(self, root, export):
        (root / "bridge").mkdir(parents=True)
        (root / "bridge" / "job.json").write_text("{not json", encoding="utf-8")
        job = _queue(root, export)
        assert bridge.load_job(root).id == job.id

    def test_new_job_validates_its_inputs(self, root, export):
        broken = pm.read_export(export)
        broken.missing.append("Files/gone.md")
        with pytest.raises(bridge.BridgeError, match="cannot be imported"):
            bridge.new_job(root, export=broken, account=ACCOUNT, name=None, script_text=SCRIPT)
        good = pm.read_export(export)
        with pytest.raises(bridge.BridgeError, match="slot, email"):
            bridge.new_job(root, export=good, account=("2", "b@example.com"), name=None, script_text=SCRIPT)  # type: ignore[arg-type]
        with pytest.raises(bridge.BridgeError, match="no email"):
            bridge.new_job(root, export=good, account=("2", " ", ""), name=None, script_text=SCRIPT)
        with pytest.raises(bridge.BridgeError, match="no email"):
            bridge.new_job(root, export=good, account=("", "", ""), name=None, script_text=SCRIPT, signed_in=False)
        with pytest.raises(bridge.BridgeError, match="script"):
            bridge.new_job(root, export=good, account=ACCOUNT, name=None, script_text="")
        with pytest.raises(bridge.BridgeError):
            bridge.new_job(root, export="not a check", account=ACCOUNT, name=None, script_text=SCRIPT)  # type: ignore[arg-type]
        assert bridge.load_job(root) is None

    def test_load_job_missing_and_damaged(self, root):
        assert bridge.load_job(root) is None
        (root / "bridge").mkdir(parents=True)
        path = root / "bridge" / "job.json"
        for text, why in (
            ("{not json", "not valid JSON"),
            ("[1]", "not a JSON object"),
            ('{"status": "queued"}', "no job id"),
            ('{"id": "job_20231114T221320_abcdef", "status": "flying"}', "unknown status"),
            ('{"id": "job_20231114T221320_abcdef", "status": "queued", "version": 2}', "another cswap"),
            ('{"id": "../../etc", "status": "queued"}', "no job id"),
        ):
            path.write_text(text, encoding="utf-8")
            with pytest.raises(bridge.JobFileDamaged, match=why):
                bridge.load_job(root)

    def test_job_round_trips_and_keeps_unknown_keys(self, root, export):
        job = _queue(root, export)
        raw = job.to_dict()
        raw["future"] = {"x": 1}
        raw["name"] = 7  # not text: dropped to None
        raw["cancel_requested"] = "yes"  # not a bool: False
        back = bridge.Job.from_dict(raw)
        assert back.extra == {"future": {"x": 1}}
        assert back.name is None and back.cancel_requested is False
        assert back.to_dict()["future"] == {"x": 1}
        assert list(back.to_dict())[:3] == ["version", "id", "created_at"]
        assert back.active and not back.terminal

    def test_claim_job(self, root, export):
        job = _queue(root, export)
        claimed = bridge.claim_job(root, job.id, INSTANCE, "0.1.0", now=T0 + 5)
        assert claimed.status == "claimed"
        assert claimed.claimed_by == {"instance": INSTANCE, "at": "2023-11-14T22:13:25Z", "extension_version": "0.1.0"}
        assert bridge.load_job(root).claimed_by == claimed.claimed_by
        again = bridge.claim_job(root, job.id, INSTANCE, "0.1.0", now=T0 + 60)
        assert again.claimed_by["at"] == "2023-11-14T22:13:25Z"
        with pytest.raises(bridge.JobClaimedElsewhere) as e:
            bridge.claim_job(root, job.id, OTHER_INSTANCE, "0.1.0")
        assert e.value.code == "claimed-elsewhere"
        assert e.value.details["claimed_by"]["instance"] == INSTANCE
        with pytest.raises(bridge.BridgeError) as e:
            bridge.claim_job(root, "job_20231114T221320_000000", INSTANCE, "0.1.0")
        assert e.value.code == "not-queued"
        with pytest.raises(bridge.BridgeError) as e:
            bridge.claim_job(root, job.id, "", "0.1.0")
        assert e.value.code == "bad-instance"
        with pytest.raises(bridge.BridgeError) as e:
            bridge.claim_job(root, "../x", INSTANCE, "0.1.0")
        assert e.value.code == "not-queued"
        claimed.status = "done"
        bridge.save_job(root, claimed)
        with pytest.raises(bridge.BridgeError) as e:
            bridge.claim_job(root, job.id, INSTANCE, "0.1.0")
        assert e.value.code == "not-queued"

    def test_request_cancel_ends_a_job_nobody_claimed_and_lets_the_next_through(self, root, export):
        assert bridge.request_cancel(root) is False
        job = _queue(root, export)
        assert bridge.request_cancel(root, "job_20231114T221320_000000") is False
        assert bridge.load_job(root).cancel_requested is False
        assert bridge.request_cancel(root, job.id, now=T0 + 5) is True
        ended = bridge.load_job(root)
        assert ended.status == "cancelled" and ended.phase == "cancelled" and ended.cancel_requested is True
        assert ended.updated_at == "2023-11-14T22:13:25Z" and not ended.active
        events, _ = bridge.read_events(root, job.id)
        assert [(e["event"], e["by"]) for e in events] == [("cancelled", "cswap")]
        assert "no browser ever picked the job up" in events[0]["reason"]
        assert bridge.request_cancel(root) is False  # nothing left to stop
        # A --watch on it ends, and the next import goes through.
        lines: list[str] = []
        outcome = bridge.run_import(root, job, say=lines.append, sleep=lambda s: None, clock=lambda: 0.0)
        assert outcome.status == "cancelled" and lines == ["The import was cancelled."]
        second = _queue(root, export, now=T0 + 10)
        assert second.id != job.id and bridge.load_job(root).id == second.id
        job = bridge.load_job(root)
        job.status = "done"
        bridge.save_job(root, job)
        assert bridge.request_cancel(root) is False

    def test_request_cancel_asks_a_claimed_job_and_waits_for_its_answer(self, root, export):
        job = _queue(root, export)
        bridge.claim_job(root, job.id, INSTANCE, "0.1.0", now=T0 + 5)
        assert bridge.request_cancel(root, job.id, now=T0 + 10) is True
        asked = bridge.load_job(root)
        assert asked.status == "claimed" and asked.cancel_requested is True
        assert asked.updated_at == "2023-11-14T22:13:30Z"
        assert bridge.read_events(root, job.id)[0] == []  # the extension does the stopping
        assert bridge.request_cancel(root, now=T0 + 20) is True
        assert bridge.load_job(root).status == "claimed"
        # Not stale yet: a new job is refused, and the message says when it would be dropped.
        with pytest.raises(bridge.JobActiveError) as e:
            _queue(root, export, now=T0 + 10 + 14 * 60)
        assert "has not answered yet" in str(e.value) and "run this again in 1 minute(s)" in str(e.value)
        assert "--cancel" not in str(e.value)
        assert bridge.load_job(root).status == "claimed"
        # An ack rewrites the job file, which restarts the clock.
        host = _host(root, now=lambda: T0 + 10 + 14 * 60 + 30)
        _hello(host)
        ack = _one(host, {"id": 3, "type": "event", "job": job.id, "event": "status", "text": "still here", "link": ""})
        assert ack["cancel_requested"] is True
        with pytest.raises(bridge.JobActiveError):
            _queue(root, export, now=T0 + 10 + 15 * 60 + 1)
        # Fifteen minutes of silence after that word: the next import drops it.
        second = _queue(root, export, now=T0 + 10 + 14 * 60 + 30 + 15 * 60)
        assert second.id != job.id
        old_events, _ = bridge.read_events(root, job.id)
        assert old_events[-1]["event"] == "cancelled" and "did not answer the stop request for 15 minutes" in old_events[-1]["reason"]

    def test_request_cancel_drops_a_claimed_job_after_the_silence_or_when_forced(self, root, export):
        job = _queue(root, export)
        bridge.claim_job(root, job.id, INSTANCE, "0.1.0", now=T0)
        assert bridge.request_cancel(root, now=T0 + 1, stale_after=60) is True
        assert bridge.load_job(root).status == "claimed"
        assert bridge.request_cancel(root, now=T0 + 30, stale_after=60) is True
        assert bridge.load_job(root).status == "claimed"
        assert bridge.request_cancel(root, now=T0 + 61, stale_after=60) is True
        assert bridge.load_job(root).status == "cancelled"
        assert bridge.request_cancel(root, now=T0 + 62, stale_after=60) is False
        events, _ = bridge.read_events(root, job.id)
        assert [e["event"] for e in events] == ["cancelled"] and "60" not in events[0]["reason"]
        forced = _queue(root, export, now=T0 + 70)
        bridge.claim_job(root, forced.id, INSTANCE, "0.1.0", now=T0 + 71)
        assert bridge.request_cancel(root, forced.id, now=T0 + 72, force=True) is True
        assert bridge.load_job(root).status == "cancelled"
        assert bridge.read_events(root, forced.id)[0][-1]["reason"] == "stopped from the command line"
        assert _queue(root, export, now=T0 + 80).id not in (job.id, forced.id)

    def test_drop_job_ends_a_job_another_browser_holds_from_the_side_panel(self, root, export):
        other = "99999999-8888-4777-8666-555555555555"
        assert bridge.drop_job(root, "job_20231114T221320_000000", other) is None
        job = _queue(root, export)
        bridge.claim_job(root, job.id, INSTANCE, "0.1.0", now=T0 + 5)
        # Another id drops nothing; a bad id, or no instance, is refused.
        assert bridge.drop_job(root, "job_20231114T221320_000000", other, now=T0 + 6) is None
        with pytest.raises(bridge.BridgeError) as e:
            bridge.drop_job(root, "nope", other)
        assert e.value.code == "not-found"
        with pytest.raises(bridge.BridgeError) as e:
            bridge.drop_job(root, job.id, "")
        assert e.value.code == "bad-instance"
        assert bridge.load_job(root).status == "claimed"
        # The other browser's panel drops it: ended now, with a cancelled
        # event that says so, and the next job goes through.
        dropped = bridge.drop_job(root, job.id, other, now=T0 + 7)
        assert dropped.status == "cancelled" and dropped.phase == "cancelled" and not dropped.active
        assert bridge.load_job(root).status == "cancelled"
        events, _ = bridge.read_events(root, job.id)
        assert [e["event"] for e in events] == ["cancelled"]
        assert events[0]["by"] == "extension" and events[0]["reason"] == "dropped from the side panel of another browser"
        assert bridge.drop_job(root, job.id, other, now=T0 + 8) is None
        second = _queue(root, export, now=T0 + 9)
        assert second.id != job.id
        # A job nobody claimed goes the same way, and a browser may drop its own.
        assert bridge.drop_job(root, second.id, INSTANCE, now=T0 + 10).status == "cancelled"
        assert bridge.read_events(root, second.id)[0][-1]["reason"] == "dropped from the side panel; no browser had picked the job up"
        third = _queue(root, export, now=T0 + 11)
        bridge.claim_job(root, third.id, INSTANCE, "0.1.0", now=T0 + 12)
        assert bridge.drop_job(root, third.id, INSTANCE, now=T0 + 13).status == "cancelled"
        assert bridge.read_events(root, third.id)[0][-1]["reason"] == "dropped from the side panel of the browser that held it"

    def test_a_job_whose_events_say_it_ended_is_settled_not_stuck(self, root, export):
        job = _queue(root, export)
        bridge.claim_job(root, job.id, INSTANCE, "0.1.0")
        running = bridge.load_job(root)
        running.status, running.phase = "running", "running"
        bridge.save_job(root, running)
        # The host appended the done event and died before it saved the job file.
        result = {"created": {"id": "c1", "name": "Demo", "url": "https://claude.ai/code/project/c1"}, "rows": []}
        bridge.append_event(root, job.id, {"event": "done", "result": result}, now=T0 + 5)
        assert bridge.request_cancel(root, now=T0 + 6) is False
        settled = bridge.load_job(root)
        assert settled.status == "done" and settled.phase == "done"
        assert settled.created_project["url"] == "https://claude.ai/code/project/c1"
        assert settled.updated_at == "2023-11-14T22:13:26Z"
        settled.status, settled.phase = "running", "running"
        bridge.save_job(root, settled)
        second = _queue(root, export, now=T0 + 7)
        assert second.id != job.id and bridge.load_job(root).id == second.id

    @pytest.mark.parametrize(
        "event, status, phase, check",
        [
            ({"event": "claimed", "instance": INSTANCE, "extension_version": "0.1.0", "chrome": "140"},
             "claimed", "", lambda j: j.claimed_by["instance"] == INSTANCE),
            ({"event": "phase", "phase": "preflight", "detail": ""}, "claimed", "preflight", None),
            ({"event": "phase", "phase": "loading"}, "claimed", "loading", None),
            ({"event": "phase", "phase": "ready"}, "claimed", "ready", None),
            ({"event": "phase", "phase": "running"}, "running", "running", None),
            ({"event": "phase", "phase": "held", "detail": "challenge"}, "held", "held", None),
            ({"event": "phase", "phase": "not-a-phase"}, "queued", "", None),
            ({"event": "status", "text": "Adding file 1/2", "link": ""}, "queued", "",
             lambda j: j.last_status["text"] == "Adding file 1/2"),
            ({"event": "wait", "state": "start", "reason": "retry-after", "until": None, "seconds": 120}, "queued", "", None),
            ({"event": "interruption", "kind": "challenge", "what": "w", "todo": "t", "evidence": {}}, "held", "held",
             lambda j: j.last_interruption["kind"] == "challenge"),
            ({"event": "held", "requestId": "r1", "stepKey": "k", "reason": "failed-step", "status": 503, "attempt": 4},
             "held", "held", None),
            ({"event": "released", "action": "retry"}, "queued", "", None),
            ({"event": "created", "id": "chan_1", "url": "https://claude.ai/code/project/chan_1", "name": "N"}, "queued", "",
             lambda j: j.created_project["id"] == "chan_1" and j.created_project["at"] == "2023-11-14T22:13:20Z"),
            ({"event": "done", "result": {"created": {"id": "chan_1", "name": "N", "url": "u"}, "rows": []}}, "done", "done",
             lambda j: j.result["rows"] == [] and j.created_project["name"] == "N"),
            ({"event": "failed", "error": "boom", "result": None}, "failed", "failed", lambda j: j.error == "boom"),
            ({"event": "failed"}, "failed", "failed", lambda j: j.error == "the import failed"),
            ({"event": "cancelled", "result": None}, "cancelled", "cancelled", lambda j: j.result is None),
            ({"event": "log", "level": "warn", "msg": "m", "data": {}}, "queued", "", None),
            ({"event": "request", "seq": 1}, "queued", "", None),
            ({"event": "something-new"}, "queued", "", None),
            ({"no": "event"}, "queued", "", None),
        ],
    )
    def test_update_from_event_mapping(self, event, status, phase, check):
        job = bridge.Job(id="job_20231114T221320_abcdef", created_at="x", status="queued")
        out = bridge.update_from_event(job, event, now=T0)
        assert out.status == status and out.phase == phase
        assert out.updated_at == "2023-11-14T22:13:20Z"
        if check:
            assert check(out)
        assert job.status == "queued" and job.updated_at == ""  # pure

    def test_update_from_event_resumed_and_terminal_stickiness(self):
        job = bridge.Job(id="job_20231114T221320_abcdef", status="queued")
        held = bridge.update_from_event(job, {"event": "interruption", "kind": "signed-out", "what": "w", "todo": "t"})
        assert held.status == "held" and held.last_interruption["kind"] == "signed-out"
        resumed = bridge.update_from_event(held, {"event": "resumed", "by": "person", "after_seconds": 3})
        assert resumed.status == "running" and resumed.phase == "running" and resumed.last_interruption is None
        done = bridge.update_from_event(resumed, {"event": "done", "result": {"rows": []}})
        late = bridge.update_from_event(done, {"event": "phase", "phase": "running"})
        assert late.status == "done" and late.phase == "done"
        later = bridge.update_from_event(late, {"event": "failed", "error": "no"})
        assert later.status == "done" and later.error is None
        assert bridge.update_from_event(job, "garbage").status == "queued"  # type: ignore[arg-type]

    def test_update_from_event_phase_failed_carries_the_detail(self):
        job = bridge.Job(id="job_20231114T221320_abcdef", status="running")
        out = bridge.update_from_event(job, {"event": "phase", "phase": "failed", "detail": "The page went away"})
        assert out.status == "failed" and out.error == "The page went away"

    def test_events_append_and_read_by_offset(self, root):
        job_id = "job_20231114T221320_abcdef"
        first = bridge.append_event(root, job_id, {"id": 7, "type": "event", "event": "phase", "phase": "ready"}, now=T0)
        assert first == {"ts": "2023-11-14T22:13:20Z", "job": job_id, "event": "phase", "phase": "ready"}
        bridge.append_event(root, job_id, {"event": "status", "text": "x", "ts": "2020-01-01T00:00:00Z", "job": ""}, now=T0)
        events, offset = bridge.read_events(root, job_id)
        assert [e["event"] for e in events] == ["phase", "status"]
        assert events[1]["ts"] == "2020-01-01T00:00:00Z" and events[1]["job"] == job_id
        assert offset == bridge.events_path(root, job_id).stat().st_size
        assert bridge.read_events(root, job_id, offset) == ([], offset)
        bridge.append_event(root, job_id, {"event": "done"})
        events, offset2 = bridge.read_events(root, job_id, offset)
        assert [e["event"] for e in events] == ["done"] and offset2 > offset
        path = bridge.events_path(root, job_id)
        with open(path, "ab") as f:
            f.write(b'{"event": "partial"')
        assert bridge.read_events(root, job_id, offset2) == ([], offset2)
        with open(path, "ab") as f:
            f.write(b"}\nnot json\n")
        events, offset3 = bridge.read_events(root, job_id, offset2)
        assert [e["event"] for e in events] == ["partial"]
        assert offset3 == path.stat().st_size
        assert bridge.read_events(root, job_id, offset3 + 1000) == (
            bridge.read_events(root, job_id, 0)
        )
        assert bridge.read_events(root, "job_20231114T221320_000000") == ([], 0)
        if sys.platform != "win32":
            assert path.stat().st_mode & 0o777 == 0o600

    @pytest.mark.parametrize("bad", ["../x", "job_x", "", "job_20231114T221320_abcdef/../../x", "job_20231114T221320_ABCDEF"])
    def test_events_path_rejects_what_is_not_a_job_id(self, root, bad):
        with pytest.raises(bridge.BridgeError):
            bridge.events_path(root, bad)
        with pytest.raises(bridge.BridgeError):
            bridge.append_event(root, bad, {"event": "x"})
        assert not (root / "bridge").exists()

    def test_import_lock_refuses_a_second_holder(self, root, export):
        job = _queue(root, export)
        with bridge.ImportLock(root):
            with pytest.raises(bridge.BridgeBusy) as e:
                with bridge.ImportLock(root):
                    pass
            assert job.id in str(e.value) and "started 2023-11-14T22:13:20Z" in str(e.value)
            assert "--cancel" in str(e.value) and "side panel" in str(e.value)
        with bridge.ImportLock(root):
            pass

    def test_import_lock_message_without_a_job(self, root):
        with bridge.ImportLock(root):
            with pytest.raises(bridge.BridgeBusy, match="another cswap"):
                with bridge.ImportLock(root):
                    pass

    def test_locked_helper_turns_a_timeout_into_busy(self, root, monkeypatch):
        (root / "bridge").mkdir(parents=True)
        monkeypatch.setattr(bridge.FileLock, "acquire", lambda self, timeout=None: False)
        with pytest.raises(bridge.BridgeBusy, match="busy"):
            bridge.save_job(root, bridge.Job(id="job_20231114T221320_abcdef"))

    def test_make_job_id_and_iso_are_utc(self):
        assert bridge.make_job_id(T0).startswith("job_20231114T221320_")
        assert bridge._iso(T0) == "2023-11-14T22:13:20Z"
        assert bridge._iso(bridge._at(lambda: T0 + 1)) == "2023-11-14T22:13:21Z"
        assert abs(bridge._at(None) - time.time()) < 5


# ---------------------------------------------------------------------------
# The export as the page reads it
# ---------------------------------------------------------------------------


class TestExportSource:
    def test_folder_listing_is_sorted_and_slash_joined(self, export):
        source = bridge.ExportSource(pm.read_export(export))
        assert source.root_name == "Demo"
        assert source.list() == [
            {"path": "Files/data/table.csv", "bytes": 8},
            {"path": "Files/notes.md", "bytes": 8},
            {"path": "Threads/001 Kick-off.md", "bytes": 7},
            {"path": "export.json", "bytes": (export / "export.json").stat().st_size},
        ]
        assert source.list() is not source.list()  # a copy each time

    def test_symlinks_are_skipped(self, export, needs_symlinks):
        (export / "Files" / "link.md").symlink_to(export / "Files" / "notes.md")
        (export / "Elsewhere").symlink_to(export / "Files", target_is_directory=True)
        paths = [row["path"] for row in bridge.ExportSource(pm.read_export(export)).list()]
        assert "Files/link.md" not in paths
        assert not any(p.startswith("Elsewhere/") for p in paths)
        assert "Files/notes.md" in paths

    def test_root_name_is_made_safe(self, export):
        check = pm.read_export(export)
        check.name = ' ../Bad: name/with "quotes"? '
        assert bridge.ExportSource(check).root_name == "Bad  name with  quotes"
        check.name = "///"
        assert bridge.ExportSource(check).root_name == "export"
        check.name = ""
        assert bridge.ExportSource(check).root_name == "Demo"

    @pytest.mark.parametrize("nested", [True, False])
    def test_tar_listing(self, export, tmp_path, nested):
        archive = _pack(export, tmp_path / "Demo.tar", nested=nested)
        check = pm.read_export_tar(archive)
        assert check.complete, check.error
        with bridge.ExportSource(check) as source:
            assert [row["path"] for row in source.list()] == [
                "Files/data/table.csv", "Files/notes.md", "Threads/001 Kick-off.md", "export.json",
            ]
            assert source.read("Files/notes.md", 2, 3) == b"not"
            assert b"".join(data for _, data, _ in source.chunks("Files/data/table.csv")) == b"a,b\n1,2\n"

    def test_tar_entries_that_escape_or_link_are_not_listed(self, export, tmp_path):
        archive = tmp_path / "Demo.tar"
        with tarfile.open(archive, "w", format=tarfile.GNU_FORMAT) as tar:
            for file in sorted(p for p in export.rglob("*") if p.is_file()):
                tar.add(file, arcname=f"Demo/{file.relative_to(export).as_posix()}")
            escape = tarfile.TarInfo("Demo/../escape.txt")
            escape.size = 4
            tar.addfile(escape, io.BytesIO(b"oops"))
            link = tarfile.TarInfo("Demo/Files/link.md")
            link.type = tarfile.SYMTYPE
            link.linkname = "notes.md"
            tar.addfile(link)
            folder = tarfile.TarInfo("Demo/Files/sub")
            folder.type = tarfile.DIRTYPE
            tar.addfile(folder)
            outside = tarfile.TarInfo("Other/file.txt")
            outside.size = 2
            tar.addfile(outside, io.BytesIO(b"no"))
        check = pm.read_export_tar(archive)
        assert check.complete, check.error
        with bridge.ExportSource(check) as source:
            paths = [row["path"] for row in source.list()]
            assert "Files/link.md" not in paths and "../escape.txt" not in paths
            assert "Files/sub" not in paths and not any("Other" in p for p in paths)
            with pytest.raises(ValueError):
                source.read("../escape.txt", 0, 4)

    def test_chunks_of_a_large_file_and_an_empty_one(self, big_export):
        source = bridge.ExportSource(pm.read_export(big_export))
        chunks = list(source.chunks("Files/big.bin"))
        assert [(o, len(d), last) for o, d, last in chunks] == [
            (0, 524288, False), (524288, 524288, False), (1048576, 251424, True),
        ]
        assert b"".join(d for _, d, _ in chunks) == BIG
        assert list(source.chunks("Files/empty.txt")) == [(0, b"", True)]
        assert source.read("Files/big.bin", 1_299_990, 100) == BIG[1_299_990:]

    def test_chunks_through_a_tar_match_the_folder(self, big_export, tmp_path):
        archive = _pack(big_export, tmp_path / "Big.tar")
        with bridge.ExportSource(pm.read_export_tar(archive)) as source:
            chunks = list(source.chunks("Files/big.bin"))
            assert [o for o, _, _ in chunks] == [0, 524288, 1048576]
            assert b"".join(d for _, d, _ in chunks) == BIG
            assert list(source.chunks("Files/empty.txt")) == [(0, b"", True)]

    def test_a_file_that_shrank_ends_early_and_one_that_grew_is_cut(self, big_export):
        source = bridge.ExportSource(pm.read_export(big_export))
        source.list()
        (big_export / "Files" / "big.bin").write_bytes(b"x" * 600_000)
        chunks = list(source.chunks("Files/big.bin"))
        assert [(o, len(d), last) for o, d, last in chunks] == [(0, 524288, False), (524288, 75712, False), (600000, 0, True)]
        (big_export / "Files" / "notes.md").write_bytes(b"# notes\n and more")
        assert b"".join(d for _, d, _ in source.chunks("Files/notes.md")) == b"# notes\n"

    def test_unlisted_paths_and_bad_offsets_are_value_errors(self, export):
        source = bridge.ExportSource(pm.read_export(export))
        for bad in ("Files/missing.md", "../export.json", "Files", "", "/etc/passwd"):
            with pytest.raises(ValueError):
                source.read(bad, 0, 1)
            with pytest.raises(ValueError):
                list(source.chunks(bad))
        with pytest.raises(ValueError):
            source.read("Files/notes.md", -1, 1)

    def test_an_export_with_an_error_is_refused(self, tmp_path):
        check = pm.read_export(tmp_path / "nowhere")
        with pytest.raises(bridge.BridgeError) as e:
            bridge.ExportSource(check)
        assert e.value.code == "export-missing"

    @pytest.mark.skipif(sys.platform != "win32", reason="the 260-character path limit is Windows' own")
    def test_a_file_past_the_windows_path_limit_is_listed_and_read(self, tmp_path, root):
        export = tmp_path / "Demo"
        deep = "Files/" + "/".join(f"a_very_long_folder_name_{i}" for i in range(12)) + "/leaf.txt"
        plain_full = str(export.joinpath(*deep.split("/")))
        assert len(plain_full) > 260
        long_full = "\\\\?\\" + plain_full
        os.makedirs(os.path.dirname(long_full), exist_ok=True)
        try:
            with open(long_full, "wb") as f:
                f.write(b"hello\n")
            (export / "Files" / "notes.md").write_bytes(b"# notes\n")
            manifest = {
                "format": pm.MANIFEST_FORMAT, "version": pm.MANIFEST_VERSION, "kind": "code", "name": "Demo",
                "files": [
                    {"path": "Files/notes.md", "name": "notes.md", "type": "project_file", "bytes": 8},
                    {"path": deep, "name": "leaf.txt", "type": "project_file", "bytes": 6},
                ],
                "history": [], "problems": [],
            }
            (export / pm.MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
            check = pm.read_export(export)
            assert check.complete, (check.missing, check.wrong_size, check.error)
            source = bridge.ExportSource(check)
            assert [row["path"] for row in source.list()] == [deep, "Files/notes.md", "export.json"]
            assert b"".join(d for _, d, _ in source.chunks(deep)) == b"hello\n"
            assert source.read(deep, 1, 3) == b"ell"
            job = _queue(root, export)
            host = _ready_host(root, job)
            reply = _one(host, {"id": 4, "type": "export.list", "job": job.id})
            assert reply["type"] == "export" and deep in [f["path"] for f in reply["files"]]
            chunks = list(host.handle({"id": 5, "type": "file.read", "job": job.id, "path": deep}))
            assert base64.b64decode(chunks[0]["data"]) == b"hello\n" and chunks[0]["last"] is True
        finally:
            # tmp_path's own cleanup stops at the limit too.
            shutil.rmtree("\\\\?\\" + str(export / "Files" / "a_very_long_folder_name_0"), ignore_errors=True)

    def test_a_listed_file_that_is_a_link_refuses_the_export(self, root, export, needs_symlinks):
        (export / "Files" / "notes.md").unlink()
        (export / "Files" / "real.md").write_bytes(b"# notes\n")
        (export / "Files" / "notes.md").symlink_to(export / "Files" / "real.md")
        check = pm.read_export(export)
        assert check.complete  # the check follows the link; the listing does not
        with pytest.raises(bridge.BridgeError, match="Files/notes.md") as e:
            bridge.ExportSource(check).list()
        assert e.value.code == "export-missing"
        with pytest.raises(bridge.BridgeError, match="Files/notes.md"):
            bridge.new_job(root, export=check, account=ACCOUNT, name=None, script_text=SCRIPT)
        assert bridge.load_job(root) is None

    def test_a_listing_short_of_what_export_json_names_is_refused_for_good(self, export, monkeypatch):
        real = bridge.ExportSource._list_folder
        monkeypatch.setattr(
            bridge.ExportSource, "_list_folder",
            lambda self: [row for row in real(self) if row["path"] not in ("Files/notes.md", "Threads/001 Kick-off.md")],
        )
        source = bridge.ExportSource(pm.read_export(export))
        with pytest.raises(bridge.BridgeError) as e:
            source.list()
        assert e.value.code == "export-missing"
        assert "lists 2 file(s)" in str(e.value) and "Files/notes.md, Threads/001 Kick-off.md" in str(e.value)
        with pytest.raises(bridge.BridgeError) as again:  # the refusal stands for every later call
            list(source.chunks("Files/data/table.csv"))
        assert again.value is e.value
        with pytest.raises(bridge.BridgeError):
            source.read("export.json", 0, 1)

    def test_a_folder_that_cannot_be_listed_refuses_the_export(self, export, monkeypatch):
        real_walk = os.walk

        def walk(top, topdown=True, onerror=None, followlinks=False):
            if onerror is not None:
                onerror(OSError(13, "Permission denied", os.path.join(top, "Files", "data")))
            return real_walk(top, topdown, onerror, followlinks)

        monkeypatch.setattr(bridge.os, "walk", walk)
        with pytest.raises(bridge.BridgeError) as e:
            bridge.ExportSource(pm.read_export(export)).list()
        assert e.value.code == "export-missing"
        assert "could not be listed" in str(e.value) and "Permission denied" in str(e.value)
        assert os.path.join("Files", "data") in str(e.value) and "\\\\?\\" not in str(e.value)

    def test_listing_bytes_is_the_frame_the_host_would_send(self, export):
        source = bridge.ExportSource(pm.read_export(export))
        reply = source.listing_reply(cancel_requested=True)
        assert reply["type"] == "export" and reply["root"] == "Demo" and reply["cancel_requested"] is True
        assert [f["path"] for f in reply["files"]] == [f["path"] for f in source.list()]
        assert source.listing_bytes() == len(bridge.encode({"re": 2**31 - 1, **source.listing_reply()})) - 4
        assert bridge._plain_path("\\\\?\\C:\\x\\y") == "C:\\x\\y"
        assert bridge._plain_path("\\\\?\\UNC\\server\\share\\y") == "\\\\server\\share\\y"
        assert bridge._plain_path("/plain/path") == "/plain/path"


# ---------------------------------------------------------------------------
# The host
# ---------------------------------------------------------------------------


class TestHost:
    def test_hello(self, root):
        host = _host(root)
        reply = _hello(host)
        assert reply == {
            "re": 1, "type": "hello", "protocol": 1, "product": "claude-swap",
            "cswap": reply["cswap"], "capabilities": ["job", "export", "script", "events", "account", "duplicate", "driven", "drop", "exports", "dialogs"],
            "backup_dir": str(root),
        }
        assert reply["cswap"] and reply["cswap"] != "unknown"
        assert host.instance == INSTANCE and host.stop is False

    def test_protocol_mismatch_is_refused_and_ends_the_host(self, root):
        host = _host(root)
        reply = _hello(host, protocol=2)
        assert reply["type"] == "error" and reply["code"] == "protocol" and reply["re"] == 1
        assert reply["product"] == "claude-swap" and reply["protocol"] == 1
        assert host.stop is True
        stdin = bridge.encode({"id": 1, "type": "hello", "protocol": 2}) + bridge.encode({"id": 2, "type": "job.get"})
        host = _host(root, stdin=stdin)
        assert host.serve() == 1
        frames = _frames(host.stdout.getvalue())
        assert [f["re"] for f in frames] == [1] and frames[0]["code"] == "protocol"

    def test_everything_but_hello_needs_a_hello_first(self, root):
        host = _host(root)
        for kind in ("job.get", "job.claim", "export.list", "file.read", "script.get", "event"):
            reply = _one(host, {"id": 3, "type": kind})
            assert reply == {"re": 3, "type": "error", "code": "no-hello", "message": "say hello first"}

    def test_unknown_type_and_bad_ids(self, root):
        host = _host(root)
        _hello(host)
        assert _one(host, {"id": 4, "type": "sing"})["code"] == "unknown-type"
        assert _one(host, {"id": 4})["code"] == "unknown-type"
        for bad in ({"type": "job.get"}, {"id": "1", "type": "job.get"}, {"id": True, "type": "job.get"}, {"id": 1.5, "type": "job.get"}):
            reply = _one(host, bad)
            assert reply["code"] == "bad-id" and reply["re"] is None
        assert _one(host, "not a dict")["code"] == "bad-id"  # type: ignore[arg-type]

    def test_job_get(self, root, export):
        host = _host(root)
        _hello(host)
        assert _one(host, {"id": 2, "type": "job.get"}) == {"re": 2, "type": "job", "job": None, "cancel_requested": False}
        job = _queue(root, export)
        reply = _one(host, {"id": 3, "type": "job.get"})
        assert reply["job"]["id"] == job.id and reply["job"]["status"] == "queued"
        assert reply["job"]["account"]["email"] == "b@example.com"
        (root / "bridge" / "job.json").write_text("garbage", encoding="utf-8")
        reply = _one(host, {"id": 4, "type": "job.get"})
        assert reply["type"] == "error" and reply["code"] == "job-file"

    def test_job_claim_through_the_host(self, root, export):
        job = _queue(root, export)
        host = _host(root, now=lambda: T0 + 9)
        _hello(host)
        reply = _claim(host, job.id)
        assert reply["type"] == "job" and reply["job"]["status"] == "claimed"
        assert reply["job"]["claimed_by"] == {"instance": INSTANCE, "at": "2023-11-14T22:13:29Z", "extension_version": "0.1.0"}
        assert _claim(host, job.id)["job"]["claimed_by"]["at"] == "2023-11-14T22:13:29Z"
        other = _host(root)
        _hello(other, OTHER_INSTANCE)
        refused = _claim(other, job.id, OTHER_INSTANCE)
        assert refused["type"] == "error" and refused["code"] == "claimed-elsewhere"
        assert refused["claimed_by"]["instance"] == INSTANCE
        assert _claim(host, "job_20231114T221320_000000")["code"] == "not-queued"
        assert _claim(host, job.id, OTHER_INSTANCE)["code"] == "bad-instance"
        assert _one(host, {"id": 5, "type": "job.claim", "job": job.id})["type"] == "job"  # the hello's instance

    @pytest.mark.parametrize("as_tar", [False, True])
    def test_export_list_serves_the_claimed_job_only(self, root, export, tmp_path, as_tar):
        target = _pack(export, tmp_path / "Demo.tar") if as_tar else export
        job = _queue(root, target)
        host = _host(root)
        _hello(host)
        refused = _one(host, {"id": 3, "type": "export.list", "job": job.id})
        assert refused["type"] == "error" and refused["code"] == "not-claimed"
        _claim(host, job.id)
        reply = _one(host, {"id": 4, "type": "export.list", "job": job.id})
        assert reply["type"] == "export" and reply["root"] == "Demo" and reply["cancel_requested"] is False
        assert [f["path"] for f in reply["files"]] == [
            "Files/data/table.csv", "Files/notes.md", "Threads/001 Kick-off.md", "export.json",
        ]
        other = _host(root)
        _hello(other, OTHER_INSTANCE)
        assert _one(other, {"id": 5, "type": "export.list", "job": job.id})["code"] == "not-claimed"
        assert _one(host, {"id": 6, "type": "export.list", "job": "../x"})["code"] == "not-claimed"
        assert _one(host, {"id": 7, "type": "export.list"})["code"] == "not-claimed"

    def test_export_list_after_the_export_went_away(self, root, export):
        job = _queue(root, export)
        host = _ready_host(root, job)
        (export / pm.MANIFEST_NAME).unlink()
        reply = _one(host, {"id": 4, "type": "export.list", "job": job.id})
        assert reply["type"] == "error" and reply["code"] == "export-missing"

    def test_export_list_refuses_a_listing_short_of_a_listed_file(self, root, export, monkeypatch):
        job = _queue(root, export)  # whole when queued
        host = _ready_host(root, job)
        real = bridge.ExportSource._list_folder
        monkeypatch.setattr(bridge.ExportSource, "_list_folder", lambda self: [r for r in real(self) if r["path"] != "Files/notes.md"])
        reply = _one(host, {"id": 4, "type": "export.list", "job": job.id})
        assert reply["type"] == "error" and reply["code"] == "export-missing" and "Files/notes.md" in reply["message"]
        replies = list(host.handle({"id": 5, "type": "file.read", "job": job.id, "path": "Files/data/table.csv"}))
        assert replies[0]["type"] == "error" and replies[0]["code"] == "export-missing"  # nothing is served from it

    def test_a_listing_that_does_not_fit_one_frame_is_refused_at_the_host_and_up_front(self, root, export, monkeypatch):
        job = _queue(root, export)
        host = _ready_host(root, job)
        size = bridge.ExportSource(pm.read_export(export)).listing_bytes()
        monkeypatch.setattr(bridge, "MAX_HOST_MESSAGE", size - 1)
        reply = _one(host, {"id": 4, "type": "export.list", "job": job.id})
        assert reply["type"] == "error" and reply["code"] == "too-large"
        assert f"lists 4 files; their listing is {size} bytes" in reply["message"]
        assert "import --clipboard" in reply["message"]
        monkeypatch.setattr(bridge, "MAX_HOST_MESSAGE", size)  # exactly fits
        assert _one(host, {"id": 5, "type": "export.list", "job": job.id})["type"] == "export"
        monkeypatch.setattr(bridge, "MAX_HOST_MESSAGE", size - 1)
        done = bridge.load_job(root)
        done.status = "done"
        bridge.save_job(root, done)
        with pytest.raises(bridge.BridgeError) as e:
            _queue(root, export)
        assert e.value.code == "too-large" and "import --clipboard" in str(e.value)
        assert bridge.load_job(root).id == job.id  # nothing was queued

    def test_file_read_streams_chunks_under_the_frame_limit(self, root, big_export):
        job = _queue(root, big_export)
        host = _ready_host(root, job)
        _one(host, {"id": 3, "type": "export.list", "job": job.id})
        replies = list(host.handle({"id": 9, "type": "file.read", "job": job.id, "path": "Files/big.bin"}))
        assert [(r["re"], r["type"], r["path"], r["offset"], r["last"]) for r in replies] == [
            (9, "file.chunk", "Files/big.bin", 0, False),
            (9, "file.chunk", "Files/big.bin", 524288, False),
            (9, "file.chunk", "Files/big.bin", 1048576, True),
        ]
        assert all(len(bridge.encode(r)) <= bridge.MAX_HOST_MESSAGE for r in replies)
        assert b"".join(base64.b64decode(r["data"]) for r in replies) == BIG
        assert all(r["cancel_requested"] is False for r in replies)
        empty = list(host.handle({"id": 10, "type": "file.read", "job": job.id, "path": "Files/empty.txt"}))
        assert empty == [{"re": 10, "type": "file.chunk", "path": "Files/empty.txt", "offset": 0, "data": "", "last": True, "cancel_requested": False}]

    def test_file_read_refusals(self, root, export):
        job = _queue(root, export)
        host = _ready_host(root, job)
        for path in ("Files/missing.md", "../export.json", "", 5, None):
            replies = list(host.handle({"id": 11, "type": "file.read", "job": job.id, "path": path}))
            assert replies[0]["type"] == "error" and replies[0]["code"] == "not-found" and replies[0]["re"] == 11, path
        other = _host(root)
        _hello(other, OTHER_INSTANCE)
        replies = list(other.handle({"id": 12, "type": "file.read", "job": job.id, "path": "Files/notes.md"}))
        assert replies[0]["code"] == "not-claimed"

    def test_script_get(self, root, export):
        job = _queue(root, export)
        host = _ready_host(root, job)
        reply = _one(host, {"id": 5, "type": "script.get", "job": job.id})
        assert reply["type"] == "script" and reply["text"] == pm.script_text("import")
        assert reply["sha256"] == hashlib.sha256(pm.script_text("import").encode()).hexdigest() == job.script["sha256"]
        assert reply["bytes"] == len(reply["text"].encode()) and reply["cswap_version"]
        reply["text"].encode("ascii")
        on_disk = bridge.load_job(root)  # the claimed copy, not the queued object in hand
        on_disk.script["sha256"] = "0" * 64
        bridge.save_job(root, on_disk)
        refused = _one(host, {"id": 6, "type": "script.get", "job": job.id})
        assert refused["type"] == "error" and refused["code"] == "script-changed"

    def test_events_are_appended_and_applied(self, root, export):
        job = _queue(root, export)
        host = _ready_host(root, job, now=lambda: T0 + 30)
        ack = _one(host, {"id": 7, "type": "event", "job": job.id, "event": "claimed", "instance": INSTANCE,
                          "extension_version": "0.1.0", "chrome": "140"})
        assert ack == {"re": 7, "type": "ack", "cancel_requested": False}
        _one(host, {"id": 8, "type": "event", "job": job.id, "event": "phase", "phase": "running", "detail": ""})
        # A created event's own `id` collides with the transport's, so the
        # project id has to be recoverable from the url alone.
        _one(host, {"id": 9, "type": "event", "event": "created", "url": "https://claude.ai/code/project/chan_1", "name": "Demo"})
        _one(host, {"id": 10, "type": "event", "job": job.id, "event": "status", "text": "Adding file 1/2: a", "link": ""})
        on_disk = bridge.load_job(root)
        assert on_disk.status == "running" and on_disk.phase == "running"
        assert on_disk.created_project["id"] == "chan_1" and on_disk.created_project["at"] == "2023-11-14T22:13:50Z"
        collided = _one(host, {"id": "chan_2", "type": "event", "job": job.id, "event": "created", "url": "u", "name": "n"})
        assert collided["type"] == "error" and collided["code"] == "bad-id" and collided["re"] is None
        assert on_disk.last_status["text"] == "Adding file 1/2: a"
        events, _ = bridge.read_events(root, job.id)
        assert [e["event"] for e in events] == ["claimed", "phase", "created", "status"]
        assert all(e["ts"] == "2023-11-14T22:13:50Z" and e["job"] == job.id for e in events)
        assert "id" not in events[0] and "type" not in events[0]
        assert bridge.request_cancel(root, job.id) is True
        ack = _one(host, {"id": 11, "type": "event", "job": job.id, "event": "wait", "state": "start", "reason": "spacing", "until": None, "seconds": 0.5})
        assert ack["cancel_requested"] is True
        _one(host, {"id": 12, "type": "event", "job": job.id, "event": "cancelled", "result": {"link": "u", "rows": []}})
        assert bridge.load_job(root).status == "cancelled"
        _one(host, {"id": 13, "type": "event", "job": job.id, "event": "phase", "phase": "running"})
        assert bridge.load_job(root).status == "cancelled"
        assert len(bridge.read_events(root, job.id)[0]) == 7

    def test_events_for_jobs_not_held_by_this_browser_are_refused(self, root, export):
        job = _queue(root, export)
        host = _host(root)
        _hello(host)
        assert _one(host, {"id": 7, "type": "event", "job": job.id, "event": "claimed"})["code"] == "not-claimed"
        _claim(host, job.id)
        assert _one(host, {"id": 8, "type": "event", "job": "job_20231114T221320_000000", "event": "phase", "phase": "running"})["code"] == "not-claimed"
        assert _one(host, {"id": 9, "type": "event", "job": "../x", "event": "phase"})["code"] == "not-claimed"
        assert _one(host, {"id": 10, "type": "event", "job": 5, "event": "phase"})["type"] == "ack"  # a non-text job means the current one
        other = _host(root)
        _hello(other, OTHER_INSTANCE)
        assert _one(other, {"id": 11, "type": "event", "job": job.id, "event": "phase", "phase": "running"})["code"] == "not-claimed"
        assert not (root / "bridge" / "events-job_20231114T221320_000000.jsonl").exists()
        assert bridge.load_job(root).status == "claimed"

    def test_event_with_no_job_queued(self, root):
        host = _host(root)
        _hello(host)
        reply = _one(host, {"id": 7, "type": "event", "event": "log", "level": "warn", "msg": "x"})
        assert reply["type"] == "error" and reply["code"] == "not-claimed"

    def test_the_host_never_raises(self, root, export):
        job = _queue(root, export)
        host = _ready_host(root, job)
        for weird in (
            {"id": 1, "type": "job.claim", "job": 5, "instance": None},
            {"id": 1, "type": "event", "job": job.id, "event": ["phase"]},
            {"id": 1, "type": "event", "job": job.id, "event": "done", "result": "not a dict"},
            {"id": 1, "type": "export.list", "job": None},
            {"id": 1, "type": "script.get", "job": {"x": 1}},
            {"id": 1, "type": "hello", "protocol": 1, "extension": "not a dict"},
            {"id": 1, "type": "hello", "protocol": "1"},
        ):
            replies = list(host.handle(weird))
            assert replies and all("re" in r and r["type"] for r in replies), weird

    def test_events_and_log_lines_carry_no_secrets(self, root, export):
        job = _queue(root, export)
        logger, handler = _test_logger()
        host = _ready_host(root, job, log=logger)
        _one(host, {
            "id": 7, "type": "event", "job": job.id, "event": "log", "level": "warn",
            "msg": "refused with token sk-ant-api03-abcdefghijklmnop",
            "data": {"cookie": "sessionKey=sk-ant-sid01-zzzzzzzzzz", "authorization": "Bearer abcdefghijklmnopqrstuvwxyz", "cf-ray": "8a1b-IAD"},
        })
        text = "\n".join(handler.lines) + bridge.events_path(root, job.id).read_text(encoding="utf-8")
        assert "sk-ant-api03" not in text and "sk-ant-sid01" not in text
        assert "abcdefghijklmnopqrstuvwxyz" not in text and "zzzzzzzzzz" not in text
        assert "8a1b-IAD" in text
        events, _ = bridge.read_events(root, job.id)
        assert events[0]["data"]["cookie"] == "[redacted]" and events[0]["data"]["authorization"] == "[redacted]"
        assert events[0]["msg"] == "refused with token [redacted]"


    def test_job_drop_message(self, root, export):
        job = _queue(root, export)
        bridge.claim_job(root, job.id, INSTANCE, "0.1.0", now=T0 + 1)
        other = _host(root, now=lambda: T0 + 2)
        _hello(other, instance="99999999-8888-4777-8666-555555555555")
        reply = _one(other, {"id": 5, "type": "job.drop", "job": job.id})
        assert reply["type"] == "job" and reply["dropped"] is True
        assert reply["job"]["id"] == job.id and reply["job"]["status"] == "cancelled"
        again = _one(other, {"id": 6, "type": "job.drop", "job": job.id})
        assert again["type"] == "job" and again["dropped"] is False and again["job"]["status"] == "cancelled"
        bad = _one(other, {"id": 7, "type": "job.drop", "job": "x"})
        assert bad["type"] == "error" and bad["code"] == "not-found"
        assert _queue(root, export, now=T0 + 3).id != job.id


class TestServe:
    def _installed(self, root: Path) -> None:
        bridge.install(root, register=False, extension_id=EXT_ID, python=sys.executable, platform="linux")

    def test_origin_is_checked_before_a_byte_is_read(self, root):
        class Untouchable(io.BytesIO):
            def read(self, n=-1):
                raise AssertionError("stdin was read")

        err = io.StringIO()
        out = io.BytesIO()
        assert bridge.serve([ORIGIN], root=root, stdin=Untouchable(), stdout=out, stderr=err) == 2
        assert "cswap bridge install --register" in err.getvalue() and out.getvalue() == b""
        self._installed(root)
        for argv in ([], ["chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/"], ["--parent-window=5"]):
            err = io.StringIO()
            assert bridge.serve(argv, root=root, stdin=Untouchable(), stdout=out, stderr=err) == 2
            assert "not one this host serves" in err.getvalue() and out.getvalue() == b""

    def test_serve_answers_frames_and_exits_zero_at_eof(self, root, export):
        self._installed(root)
        job = _queue(root, export)
        stdin = b"".join(
            bridge.encode(m)
            for m in (
                {"id": 1, "type": "hello", "protocol": 1, "extension": {"version": "0.1.0", "instance": INSTANCE}, "chrome": "140", "userScripts": True},
                {"id": 2, "type": "job.get"},
                {"id": 3, "type": "job.claim", "job": job.id, "instance": INSTANCE, "extension_version": "0.1.0"},
                {"id": 4, "type": "file.read", "job": job.id, "path": "Files/notes.md"},
                {"id": 5, "type": "event", "job": job.id, "event": "phase", "phase": "running"},
                {"id": 6, "type": "nothing"},
            )
        )
        out = io.BytesIO()
        err = io.StringIO()
        code = bridge.serve(["--parent-window=7", ORIGIN], root=root, stdin=io.BytesIO(stdin), stdout=out, stderr=err)
        assert code == 0 and err.getvalue() == ""
        frames = _frames(out.getvalue())
        assert [(f["re"], f["type"]) for f in frames] == [
            (1, "hello"), (2, "job"), (3, "job"), (4, "file.chunk"), (5, "ack"), (6, "error"),
        ]
        assert base64.b64decode(frames[3]["data"]) == b"# notes\n" and frames[3]["last"] is True
        assert bridge.load_job(root).status == "running"
        log = (root / "bridge" / "bridge.log").read_text(encoding="utf-8")
        assert "bridge started" in log and "exiting with 0" in log

    def test_a_broken_frame_stops_the_host_with_only_whole_replies_out(self, root):
        self._installed(root)
        stdin = bridge.encode({"id": 1, "type": "hello", "protocol": 1}) + b"\x09\x00\x00\x00abc"
        out = io.BytesIO()
        assert bridge.serve([ORIGIN], root=root, stdin=io.BytesIO(stdin), stdout=out, stderr=io.StringIO()) == 1
        assert [f["type"] for f in _frames(out.getvalue())] == ["hello"]
        assert "broken frame" in (root / "bridge" / "bridge.log").read_text(encoding="utf-8")

    def test_bridge_log_holds_no_secrets(self, root, export):
        self._installed(root)
        job = _queue(root, export)
        stdin = b"".join(
            bridge.encode(m)
            for m in (
                {"id": 1, "type": "hello", "protocol": 1, "extension": {"version": "0.1.0", "instance": INSTANCE}},
                {"id": 2, "type": "job.claim", "job": job.id, "instance": INSTANCE, "extension_version": "0.1.0"},
                {"id": 3, "type": "event", "job": job.id, "event": "log", "level": "error",
                 "msg": "Bearer abcdefghijklmnopqrstuvwxyz and sk-ant-api03-abcdefghijklmnop",
                 "data": {"set-cookie": "sessionKey=sk-ant-sid01-zzzzzzzzzz; Secure", "x-api-key": "KEY1234567890", "path": "/api/x"}},
                {"id": 4, "type": "file.read", "job": job.id, "path": "Files/notes.md"},
            )
        )
        assert bridge.serve([ORIGIN], root=root, stdin=io.BytesIO(stdin), stdout=io.BytesIO(), stderr=io.StringIO()) == 0
        log = (root / "bridge" / "bridge.log").read_text(encoding="utf-8")
        for secret in ("abcdefghijklmnopqrstuvwxyz", "sk-ant-api03", "sk-ant-sid01", "zzzzzzzzzz", "KEY1234567890"):
            assert secret not in log, secret
        assert "/api/x" in log and "<8 bytes>" in log

    def test_serve_uses_the_root_the_launcher_pins_not_the_environment(self, root, tmp_path, monkeypatch):
        self._installed(root)
        elsewhere = tmp_path / "elsewhere"
        # The shell's XDG_DATA_HOME is not Chrome's; whatever this process
        # would work out for itself must lose to the pinned root.
        monkeypatch.setenv("XDG_DATA_HOME", str(elsewhere))
        monkeypatch.setattr(bridge.paths, "get_backup_root", lambda: elsewhere / "claude-swap")
        hello = bridge.encode({"id": 1, "type": "hello", "protocol": 1})
        for argv in (["--root", str(root), ORIGIN], [f"--root={root}", "--parent-window=3", ORIGIN], [ORIGIN, "--root", str(root)]):
            out, err = io.BytesIO(), io.StringIO()
            assert bridge.serve(argv, stdin=io.BytesIO(hello), stdout=out, stderr=err) == 0, argv
            frames = _frames(out.getvalue())
            assert frames[0]["type"] == "hello" and frames[0]["backup_dir"] == str(root)
            assert err.getvalue() == ""
        # Without the pin (an older launcher) the environment decides, and finds nothing there.
        err = io.StringIO()
        assert bridge.serve([ORIGIN], stdin=io.BytesIO(hello), stdout=io.BytesIO(), stderr=err) == 2
        assert str(elsewhere / "claude-swap") in err.getvalue()
        # A bare --root with nothing after it pins nothing.
        err = io.StringIO()
        assert bridge.serve([ORIGIN, "--root"], stdin=io.BytesIO(hello), stdout=io.BytesIO(), stderr=err) == 2
        # An explicit root wins over both.
        assert bridge.serve(["--root", str(elsewhere), ORIGIN], root=root, stdin=io.BytesIO(hello), stdout=io.BytesIO(), stderr=io.StringIO()) == 0
        assert bridge._root_from_argv(["--root=", ORIGIN]) is None


# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------


class TestInstall:
    def test_launcher_text_and_file(self, root, tmp_path):
        python = str(tmp_path / "py.exe")
        pinned = os.path.abspath(str(root))
        assert bridge.launcher_text(python, "win32", root) == (
            f'@echo off\r\n"{python}" -m claude_swap bridge --root "{pinned}" %*\r\n'
        )
        assert bridge.launcher_text(python, "linux", root) == (
            f'#!/bin/sh\nexec "{python}" -m claude_swap bridge --root "{pinned}" "$@"\n'
        )
        # An older launcher's shape, without the pin.
        assert bridge.launcher_text(python, "win32") == f'@echo off\r\n"{python}" -m claude_swap bridge %*\r\n'
        # With cswap's code named, the host runs that code whatever Chrome's environment holds.
        code = tmp_path / "site"
        where = os.path.abspath(str(code))
        assert bridge.launcher_text(python, "win32", root, code) == (
            f'@echo off\r\nif defined PYTHONPATH (set "PYTHONPATH={where};%PYTHONPATH%") else (set "PYTHONPATH={where}")\r\n'
            f'"{python}" -m claude_swap bridge --root "{pinned}" %*\r\n'
        )
        assert bridge.launcher_text(python, "linux", root, code) == (
            f'#!/bin/sh\nPYTHONPATH="{where}${{PYTHONPATH:+:$PYTHONPATH}}"\nexport PYTHONPATH\n'
            f'exec "{python}" -m claude_swap bridge --root "{pinned}" "$@"\n'
        )
        for platform in ("win32", "linux"):
            bridge.write_launcher(root, python, platform, code)
            assert bridge.launcher_code(root, platform) == where
            assert bridge.launcher_python(root, platform) == python and bridge.launcher_root(root, platform) == pinned
        cmd = bridge.write_launcher(root, python, "win32")
        assert cmd == root / "bridge" / "cswap-bridge.cmd"
        assert cmd.read_bytes() == bridge.launcher_text(python, "win32", root).encode()
        assert bridge.launcher_python(root, "win32") == python
        assert bridge.launcher_root(root, "win32") == pinned
        sh = bridge.write_launcher(root, python, "darwin")
        assert sh.name == "cswap-bridge.sh" and sh.read_bytes().startswith(b"#!/bin/sh\n")
        if sys.platform != "win32":
            assert sh.stat().st_mode & 0o777 == 0o755
        assert bridge.launcher_python(root, "linux") == python
        assert bridge.launcher_root(root, "linux") == pinned
        assert bridge.launcher_python(tmp_path / "nowhere", "linux") is None
        assert bridge.launcher_root(tmp_path / "nowhere", "linux") is None
        sh.write_bytes(bridge.launcher_text(python, "linux").encode())
        assert bridge.launcher_python(root, "linux") == python and bridge.launcher_root(root, "linux") is None
        assert bridge.launcher_code(root, "linux") is None
        with pytest.raises(bridge.BridgeError):
            bridge.write_launcher(root, "", "linux")

    def test_install_names_this_cswaps_code_and_status_checks_it(self, root, tmp_path):
        # The case that showed on Windows: a cswap run from a checkout through a
        # PYTHONPATH launcher installed a host whose interpreter could not import
        # claude_swap, so Chrome's host died at once and the extension saw no bridge.
        home = tmp_path / "home"
        bridge.install(root, register=True, extension_id=bridge.default_extension_id(), python=sys.executable, platform="linux", home=home)
        assert bridge.launcher_code(root, "linux") == bridge.code_dir()
        assert (Path(bridge.code_dir()) / "claude_swap" / "__init__.py").is_file()
        state = bridge.status(root, platform="linux", home=home)
        assert state.code_ok and state.installed and state.problems == []
        launcher = bridge.launcher_path(root, "linux")
        launcher.write_bytes(bridge.launcher_text(sys.executable, "linux", root).encode())  # an older cswap's launcher
        state = bridge.status(root, platform="linux", home=home)
        assert state.launcher_ok and state.python_ok and state.root_ok and not state.code_ok and not state.installed
        assert any("does not name where cswap's code is" in p and "older cswap" in p for p in state.problems)
        launcher.write_bytes(bridge.launcher_text(sys.executable, "linux", root, tmp_path / "empty").encode())
        state = bridge.status(root, platform="linux", home=home)
        assert not state.code_ok and any("holds no claude_swap" in p for p in state.problems)
        bridge.install(root, register=True, extension_id=bridge.default_extension_id(), python=sys.executable, platform="linux", home=home, code=tmp_path / "empty")
        assert not bridge.status(root, platform="linux", home=home).code_ok

    def test_host_manifest_shape(self, root):
        launcher = root / "bridge" / "cswap-bridge.sh"
        manifest = bridge.host_manifest(root, launcher, EXT_ID)
        assert manifest == {
            "name": "com.claude_swap.bridge",
            "description": manifest["description"],
            "path": str(launcher),
            "type": "stdio",
            "allowed_origins": [ORIGIN],
        }
        for bad in ("", "short", "A" * 32, "z" * 32, "a" * 31):
            with pytest.raises(bridge.BridgeError):
                bridge.host_manifest(root, launcher, bad)

    @pytest.mark.parametrize("platform", ["win32", "darwin", "linux"])
    def test_install_without_register_writes_files_and_returns_the_plan(self, root, tmp_path, platform):
        home = tmp_path / "home"
        regs = bridge.install(root, register=False, extension_id=EXT_ID, python=sys.executable, platform=platform, home=home)
        manifest = json.loads(bridge.host_manifest_path(root).read_text(encoding="utf-8"))
        assert manifest["allowed_origins"] == [ORIGIN]
        assert manifest["path"] == str(bridge.launcher_path(root, platform))
        assert bridge.launcher_path(root, platform).is_file()
        assert [r.browser for r in regs] == ["chrome"]
        reg = regs[0]
        assert not reg.done and not reg.present and reg.value == str(bridge.host_manifest_path(root))
        if platform == "win32":
            assert reg.kind == "registry"
            assert reg.location == r"HKCU\Software\Google\Chrome\NativeMessagingHosts\com.claude_swap.bridge"
            assert reg.command == f'reg add "{reg.location}" /ve /t REG_SZ /d "{reg.value}" /f'
        else:
            folder = "Library/Application Support/Google/Chrome" if platform == "darwin" else ".config/google-chrome"
            assert reg.kind == "file"
            assert Path(reg.location) == home / folder / "NativeMessagingHosts" / "com.claude_swap.bridge.json"
            assert reg.command.startswith("mkdir -p ") and " && cp " in reg.command
            assert not Path(reg.location).exists()
        assert not (home / "Library").exists() and not (home / ".config").exists()

    def test_plan_touches_nothing(self, root, tmp_path):
        regs = bridge.plan(root, browsers=("chrome", "edge", "brave", "chromium"), platform="linux", home=tmp_path / "h")
        assert [r.browser for r in regs] == ["chrome", "edge", "brave", "chromium"]
        assert {Path(r.location).parts[-3] for r in regs} == {"google-chrome", "microsoft-edge", "Brave-Browser", "chromium"}
        assert not root.exists() and not (tmp_path / "h").exists()
        with pytest.raises(bridge.BridgeError, match="unknown browser"):
            bridge.plan(root, browsers=("firefox",), platform="linux")
        with pytest.raises(bridge.BridgeError):
            bridge.plan(root, extension_id="nope", platform="linux")
        win = bridge.plan(root, browsers=("edge", "brave", "chromium"), platform="win32")
        assert [r.location for r in win] == [
            r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.claude_swap.bridge",
            r"HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.claude_swap.bridge",
            r"HKCU\Software\Chromium\NativeMessagingHosts\com.claude_swap.bridge",
        ]
        assert all(r.kind == "registry" and not r.present for r in win)

    def test_register_on_windows_through_winreg(self, root):
        reg_api = FakeWinreg()
        regs = bridge.install(root, register=True, extension_id=EXT_ID, python=sys.executable, platform="win32", winreg=reg_api)
        subkey = r"Software\Google\Chrome\NativeMessagingHosts\com.claude_swap.bridge"
        assert reg_api.keys == {subkey: str(bridge.host_manifest_path(root))}
        assert regs[0].done and regs[0].present and regs[0].points_here
        state = bridge.status(root, platform="win32", winreg=reg_api)
        assert state.manifest_ok and state.launcher_ok and state.python_ok and state.installed
        assert state.registrations[0].present and state.registrations[0].detail == "points at this manifest"
        assert state.extension_id and state.extension_dir is not None
        assert bridge.is_installed(root, platform="win32", winreg=reg_api) is True
        regs = bridge.uninstall(root, register=True, platform="win32", winreg=reg_api)
        assert regs[0].done and reg_api.keys == {}
        assert not bridge.host_manifest_path(root).exists() and not bridge.launcher_path(root, "win32").exists()
        assert bridge.is_installed(root, platform="win32", winreg=reg_api) is False
        again = bridge.uninstall(root, register=True, platform="win32", winreg=reg_api)
        assert not again[0].done and again[0].detail == "was not registered"

    def test_register_elsewhere_points_at_another_manifest(self, root):
        reg_api = FakeWinreg()
        reg_api.keys[r"Software\Google\Chrome\NativeMessagingHosts\com.claude_swap.bridge"] = r"C:\elsewhere\host.json"
        bridge.install(root, register=False, extension_id=EXT_ID, python=sys.executable, platform="win32")
        state = bridge.status(root, platform="win32", winreg=reg_api)
        assert state.registrations[0].present and state.registrations[0].detail == r"points at C:\elsewhere\host.json"
        assert not state.installed and any("no browser is registered" in p for p in state.problems)

    def test_registry_not_reachable(self, root):
        class NoWinreg:
            pass

        bridge.install(root, register=False, extension_id=EXT_ID, python=sys.executable, platform="win32")
        state = bridge.status(root, platform="win32", winreg=NoWinreg())
        assert state.registrations[0].present is False
        assert state.registrations[0].detail == "the registry is not reachable from here"
        assert not state.installed
        regs = bridge.install(root, register=True, extension_id=EXT_ID, python=sys.executable, platform="win32", winreg=NoWinreg())
        assert not regs[0].done and "by hand" in regs[0].detail
        regs = bridge.uninstall(root, register=True, platform="win32", winreg=NoWinreg())
        assert not regs[0].done

    @pytest.mark.parametrize("platform, folder", [("linux", ".config/google-chrome"), ("darwin", "Library/Application Support/Google/Chrome")])
    def test_register_on_posix_copies_the_manifest(self, root, tmp_path, platform, folder):
        home = tmp_path / "home"
        packaged = bridge.default_extension_id()  # any other id is reported as a problem, rightly
        regs = bridge.install(root, register=True, extension_id=packaged, python=sys.executable, platform=platform, home=home)
        copy = home / folder / "NativeMessagingHosts" / "com.claude_swap.bridge.json"
        assert copy.is_file() and regs[0].done and regs[0].points_here
        assert json.loads(copy.read_text(encoding="utf-8")) == json.loads(bridge.host_manifest_path(root).read_text(encoding="utf-8"))
        state = bridge.status(root, platform=platform, home=home)
        assert state.installed and state.problems == []
        assert bridge.is_installed(root, platform=platform, home=home)
        copy.write_text(json.dumps({"name": "com.claude_swap.bridge", "path": "/other", "allowed_origins": [ORIGIN]}), encoding="utf-8")
        state = bridge.status(root, platform=platform, home=home)
        assert state.registrations[0].present and state.registrations[0].detail.startswith("holds another manifest")
        assert not state.installed
        bridge.uninstall(root, register=True, platform=platform, home=home)
        assert not copy.exists()

    def test_status_reports_each_missing_piece(self, root, tmp_path):
        home = tmp_path / "home"
        state = bridge.status(root, platform="linux", home=home)
        assert not state.manifest_ok and not state.launcher_ok and not state.python_ok and not state.installed
        assert any("no host manifest" in p for p in state.problems) and any("no launcher" in p for p in state.problems)
        assert state.job is None
        gone = str(tmp_path / "gone" / "python")
        bridge.install(root, register=True, extension_id=EXT_ID, python=gone, platform="linux", home=home)
        state = bridge.status(root, platform="linux", home=home)
        assert state.manifest_ok and state.launcher_ok and not state.python_ok and not state.installed
        assert any("Python that is not there" in p for p in state.problems)
        assert bridge.is_installed(root, platform="linux", home=home) is False

    def test_status_notes_a_manifest_for_another_extension_id(self, root, tmp_path):
        home = tmp_path / "home"
        bridge.install(root, register=True, extension_id="b" * 32, python=sys.executable, platform="linux", home=home)
        state = bridge.status(root, platform="linux", home=home)
        assert state.manifest_ok
        assert any("not the packaged extension" in p and state.extension_id in p for p in state.problems)

    def test_status_with_a_damaged_job_file_and_a_job(self, root, tmp_path, export):
        (root / "bridge").mkdir(parents=True)
        (root / "bridge" / "job.json").write_text("nope", encoding="utf-8")
        state = bridge.status(root, platform="linux", home=tmp_path / "home")
        assert state.job is None and any("not valid JSON" in p for p in state.problems)
        job = _queue(root, export)
        assert bridge.status(root, platform="linux", home=tmp_path / "home").job.id == job.id

    def test_install_uses_the_packaged_id_by_default(self, root, tmp_path):
        bridge.install(root, register=False, python=sys.executable, platform="linux", home=tmp_path / "home")
        manifest = json.loads(bridge.host_manifest_path(root).read_text(encoding="utf-8"))
        assert manifest["allowed_origins"] == [f"chrome-extension://{bridge.default_extension_id()}/"]

    def test_is_installed_never_raises(self, root, monkeypatch):
        monkeypatch.setattr(bridge, "status", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))
        assert bridge.is_installed(root) is False

    def test_status_flags_a_launcher_that_does_not_pin_this_root(self, root, tmp_path):
        home = tmp_path / "home"
        bridge.install(root, register=True, extension_id=bridge.default_extension_id(), python=sys.executable, platform="linux", home=home)
        state = bridge.status(root, platform="linux", home=home)
        assert state.root_ok and state.installed and state.problems == []
        launcher = bridge.launcher_path(root, "linux")
        launcher.write_bytes(bridge.launcher_text(sys.executable, "linux").encode())  # an older cswap's launcher
        state = bridge.status(root, platform="linux", home=home)
        assert state.launcher_ok and state.python_ok and not state.root_ok and not state.installed
        assert any("older cswap" in p and "install --register" in p for p in state.problems)
        launcher.write_bytes(bridge.launcher_text(sys.executable, "linux", tmp_path / "other").encode())
        state = bridge.status(root, platform="linux", home=home)
        assert not state.root_ok and any(f"it names {os.path.abspath(str(tmp_path / 'other'))}" in p for p in state.problems)
        assert bridge.is_installed(root, platform="linux", home=home) is False
        bridge.install(root, register=True, extension_id=bridge.default_extension_id(), python=sys.executable, platform="linux", home=home)
        assert bridge.status(root, platform="linux", home=home).installed

    def test_status_notes_a_stop_request_the_browser_has_not_answered(self, root, tmp_path, export):
        home = tmp_path / "home"
        job = _queue(root, export)
        assert not any("asked to stop" in p for p in bridge.status(root, platform="linux", home=home).problems)
        bridge.claim_job(root, job.id, INSTANCE, "0.1.0")
        bridge.request_cancel(root, job.id, now=T0 + 1)
        state = bridge.status(root, platform="linux", home=home)
        assert any(
            f"job {job.id} was asked to stop at 2023-11-14T22:13:21Z" in p and "15 minutes" in p for p in state.problems
        )
        assert state.job.cancel_requested and state.job.status == "claimed"


# ---------------------------------------------------------------------------
# Following a job from the command line
# ---------------------------------------------------------------------------


class TestFollowAndRun:
    def test_follow_events_sees_lines_as_a_thread_appends_them(self, root, export):
        job = _queue(root, export)

        def writer():
            for i, event in enumerate(({"event": "phase", "phase": "running"}, {"event": "status", "text": "a"}, {"event": "done", "result": {}})):
                time.sleep(0.03)
                bridge.append_event(root, job.id, event, now=T0 + i)

        thread = threading.Thread(target=writer)
        thread.start()
        try:
            seen = list(bridge.follow_events(root, job.id, poll=0.01))
        finally:
            thread.join(5)
        assert [e["event"] for e in seen] == ["phase", "status", "done"]

    def test_follow_events_stop_and_timeout(self, root, export):
        job = _queue(root, export)
        bridge.append_event(root, job.id, {"event": "phase", "phase": "running"})
        polls = []
        seen = list(bridge.follow_events(root, job.id, sleep=polls.append, clock=lambda: 0.0, stop=lambda: True))
        assert [e["event"] for e in seen] == ["phase"] and polls == []
        t = [0.0]

        def sleep(s):
            t[0] += s

        seen = list(bridge.follow_events(root, job.id, poll=1.0, sleep=sleep, clock=lambda: t[0], timeout=2.5))
        assert len(seen) == 1 and t[0] == 3.0

    def _run(self, root, job, events, **kw):
        for event in events:
            bridge.append_event(root, job.id, event, now=T0)
        lines: list[str] = []
        outcome = bridge.run_import(root, job, say=lines.append, sleep=lambda s: None, clock=lambda: 0.0, **kw)
        return outcome, lines

    def test_run_import_done_prints_the_story_and_returns_the_result(self, root, export):
        job = _queue(root, export)
        result = {
            "created": {"id": "chan_1", "name": "Demo", "url": "https://claude.ai/code/project/chan_1"},
            "status": 'Done - "Demo" was created with 2 files and 1 history file.',
            "link": "https://claude.ai/code/project/chan_1",
            "paused": True,
            "rows": [{"group": "file", "item": "a", "result": "added", "detail": ""}, "not a row"],
            "counts": {"added": 1},
        }
        outcome, lines = self._run(root, job, [
            {"event": "claimed", "instance": INSTANCE, "extension_version": "0.1.0", "chrome": "140"},
            {"event": "phase", "phase": "preflight", "detail": ""},
            {"event": "phase", "phase": "loading", "detail": ""},
            {"event": "phase", "phase": "ready", "detail": ""},
            {"event": "phase", "phase": "running", "detail": ""},
            {"event": "phase", "phase": "running", "detail": ""},
            {"event": "status", "text": "Adding file 1/2: a", "link": ""},
            {"event": "status", "text": "Adding file 1/2: a", "link": ""},
            {"event": "wait", "state": "start", "reason": "spacing", "until": None, "seconds": 0.5},
            {"event": "wait", "state": "start", "reason": "retry-after", "until": "x", "seconds": 120},
            {"event": "wait", "state": "end", "reason": "retry-after", "until": None, "seconds": 120},
            {"event": "wait", "state": "start", "reason": "script-backoff", "until": None, "seconds": 3},
            {"event": "held", "requestId": "r17", "stepKey": "k", "reason": "failed-step", "status": 503, "attempt": 4, "method": "POST", "path": "/api/x/upload"},
            {"event": "released", "action": "retry"},
            {"event": "interruption", "kind": "challenge", "what": "claude.ai asked this browser to pass a Cloudflare check.", "todo": "Open claude.ai in a NEW tab.", "evidence": {}},
            {"event": "resumed", "by": "person", "after_seconds": 84},
            {"event": "created", "id": "chan_1", "url": "https://claude.ai/code/project/chan_1", "name": "Demo"},
            {"event": "log", "level": "warn", "msg": "something odd", "data": {}},
            {"event": "log", "level": "info", "msg": "quiet", "data": {}},
            {"event": "done", "result": result},
        ])
        assert outcome.status == "done" and outcome.job_id == job.id
        assert outcome.link == "https://claude.ai/code/project/chan_1" and outcome.name == "Demo"
        assert outcome.summary == result["status"] and outcome.paused is True
        assert outcome.rows == [{"group": "file", "item": "a", "result": "added", "detail": ""}]
        text = "\n".join(lines)
        assert "Chrome picked the job up (extension 0.1.0, Chrome 140)." in lines
        assert lines.count("Importing...") == 1 and lines.count("  Adding file 1/2: a") == 1
        assert "Checking the claude.ai tab" in text and "Loading the export" in text and "pressing its button" in text
        assert "Waiting 120 s: the site said Retry-After 120" in lines
        assert "Waiting 3 s: the script is backing off after an error" in lines
        assert "minimum spacing" not in text
        assert "Held at POST /api/x/upload (HTTP 503, attempt 4, failed-step). Press Resume (which sends it again) or Skip this step in the cswap side panel." in lines
        assert "Stopped: claude.ai asked this browser to pass a Cloudflare check." in lines
        assert "  Open claude.ai in a NEW tab." in lines
        assert "Resumed after 84 s." in lines
        assert 'Created "Demo": https://claude.ai/code/project/chan_1' in lines
        assert "  [warn] something odd" in lines and "quiet" not in text
        assert lines[-2] == result["status"] and lines[-1] == "The new project is at https://claude.ai/code/project/chan_1"
        assert "Nothing has picked the job up" not in text

    def test_run_import_failed_and_cancelled(self, root, export):
        job = _queue(root, export)
        outcome, lines = self._run(root, job, [
            {"event": "claimed", "instance": INSTANCE},
            {"event": "failed", "error": "The page went away after the project was created.",
             "result": {"created": {"id": "c", "name": "Demo", "url": "https://claude.ai/code/project/c"}, "rows": []}},
        ])
        assert outcome.status == "failed" and outcome.message == "The page went away after the project was created."
        assert outcome.link == "https://claude.ai/code/project/c"
        assert any("Import failed: The page went away" in line for line in lines)
        assert "The project created before that is at https://claude.ai/code/project/c" in lines
        job2 = _queue(root, export) if False else job
        bridge.events_path(root, job2.id).write_bytes(b"")
        outcome, lines = self._run(root, job2, [{"event": "cancelled", "result": None}])
        assert outcome.status == "cancelled" and outcome.link == "" and outcome.message == "The import was cancelled."
        assert lines == ["The import was cancelled."]
        bridge.events_path(root, job2.id).write_bytes(b"")
        outcome, lines = self._run(root, job2, [{"event": "cancelled", "result": {"link": "https://claude.ai/code/project/c"}}])
        assert outcome.message.endswith("The project created so far is at https://claude.ai/code/project/c.")

    def test_run_import_prints_the_pickup_hint_once_and_keeps_waiting(self, root, export):
        job = _queue(root, export)
        t = [0.0]
        calls = [0]

        def sleep(s):
            t[0] += 30
            calls[0] += 1
            if calls[0] == 3:
                bridge.append_event(root, job.id, {"event": "claimed", "instance": INSTANCE})
                bridge.append_event(root, job.id, {"event": "done", "result": {"status": "Done."}})

        lines: list[str] = []
        outcome = bridge.run_import(root, job, say=lines.append, sleep=sleep, clock=lambda: t[0], pickup_timeout=60.0)
        assert outcome.status == "done"
        assert sum(1 for line in lines if line.startswith("Nothing has picked the job up")) == 1
        hint = next(line for line in lines if line.startswith("Nothing has picked"))
        assert "Allow User Scripts" in hint and "cswap bridge install --register" in hint
        assert lines.index(hint) < lines.index("Chrome picked the job up (extension ?, Chrome ?).")

    def test_run_import_without_waiting(self, root, export):
        job = _queue(root, export)
        outcome = bridge.run_import(root, job, say=lambda *_: None, wait=False)
        assert outcome.status == "queued" and job.id in outcome.message

    def test_run_import_detaches_on_ctrl_c(self, root, export):
        job = _queue(root, export)

        def sleep(s):
            raise KeyboardInterrupt

        lines: list[str] = []
        outcome = bridge.run_import(root, job, say=lines.append, sleep=sleep, clock=lambda: 0.0)
        assert outcome.status == "detached"
        assert any("--watch" in line and "--cancel" in line and job.id in line for line in lines)
        assert bridge.load_job(root).status == "queued"
