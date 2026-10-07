"""The native-messaging bridge between ``cswap`` and its Chrome extension.

``cswap project-move import --to N`` queues an import job on disk; the
extension, running in the destination account's own Chrome, picks it up
through this bridge, runs the unchanged import script in the signed-in tab,
and reports back. Three parts live here:

1. **The host** (``cswap bridge``): a native messaging host Chrome starts
   when the extension connects. It speaks JSON frames on stdio (4-byte
   little-endian length, then UTF-8 JSON), only ever in reply, and keeps
   nothing in memory that matters: Chrome spawns one host per connection and
   ends it when the port closes, so the job lives in files under
   ``<backup_dir>/bridge/`` that the command line writes and the host updates
   from the extension's events.
2. **Install**: the host manifest Chrome needs, a launcher that runs
   ``python -m claude_swap bridge``, and the per-user registration (an HKCU
   registry key on Windows, a manifest copy in the browser's
   ``NativeMessagingHosts`` folder on macOS and Linux).
3. **The command-line side of an import**: queue a job, hold the
   one-import-per-machine lock, tail the job's events and print them.

Nothing here signs in to claude.ai, reads a cookie or a credential, or sends
a request: the page does that in the person's own profile. The host reads
only regular files under the export, hands out the import script's text, and
appends what the extension reports. Its stdout is the protocol and nothing
else; its logging goes to ``bridge.log`` through a redacting filter.
"""

from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import json
import logging
import os
import re
import secrets
import shlex
import stat
import struct
import subprocess
import sys
import tarfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import BinaryIO, Callable, Iterable, Iterator

from claude_swap import paths
from claude_swap import process_detection
from claude_swap import project_move as pm
from claude_swap.exceptions import ClaudeSwitchError, LockError
from claude_swap.handoff import redact as _redact_known_secrets
from claude_swap.locking import FileLock
from claude_swap.settings import atomic_write_json

HOST_NAME = "com.claude_swap.bridge"
PROTOCOL = 1
PRODUCT = "claude-swap"
CAPABILITIES = ("job", "export", "script", "events", "account", "duplicate", "driven", "drop", "exports")
BRIDGE_DIRNAME = "bridge"

# Chrome caps a host-to-extension frame at 1 MB; a file travels in raw chunks
# of CHUNK_BYTES, which is about 700 KB once base64-encoded, comfortably
# under that with the JSON around it. The other direction allows 64 MB.
MAX_HOST_MESSAGE = 1024 * 1024
MAX_EXTENSION_MESSAGE = 64 * 1024 * 1024
CHUNK_BYTES = 512 * 1024

JOB_FILE = "job.json"
LOCK_FILE = ".lock"
IMPORT_LOCK = "import.lock"
LOG_FILE = "bridge.log"
EVENTS_KEEP = 5

# A claimed job that was asked to stop and whose browser has not said a word
# since (no event, so no ack) for this long is taken for abandoned: the
# profile was removed or the extension unloaded, and nothing will ever end
# the job otherwise. A browser that is only waiting out a Retry-After says so
# with a wait event first, which counts as a word.
CANCEL_STALE_SECONDS = 15 * 60

JOB_VERSION = 1
JOB_KINDS = ("import", "export")
SEQUENCE_FILE = "sequence.json"
JOB_STATUSES = ("queued", "claimed", "running", "held", "done", "failed", "cancelled")
ACTIVE_STATUSES = frozenset({"queued", "claimed", "running", "held"})
SERVED_STATUSES = frozenset({"claimed", "running", "held"})
TERMINAL_STATUSES = frozenset({"done", "failed", "cancelled"})
TERMINAL_EVENTS = frozenset({"done", "failed", "cancelled"})

# A job id is made here and comes back from the extension in every request;
# it names a file, so anything that is not exactly this shape is refused.
_JOB_ID_RE = re.compile(r"^job_[0-9]{8}T[0-9]{6}_[0-9a-f]{6}$")
_EXTENSION_ID_RE = re.compile(r"^[a-p]{32}$")
_ORIGIN_PREFIX = "chrome-extension://"

_logger = logging.getLogger("claude-swap")


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class BridgeError(ClaudeSwitchError):
    """Anything the bridge refuses, with a short code the protocol can carry."""

    code = "error"

    def __init__(self, message: str, *, code: str | None = None, **details):
        super().__init__(message)
        if code is not None:
            self.code = code
        self.details = details


class BridgeProtocolError(BridgeError):
    """A frame that is not one, or a message that does not fit a frame."""

    code = "protocol"


class BridgeBusy(BridgeError):
    """Another ``cswap project-move import`` holds the one-import lock."""

    code = "busy"


class BridgeNotInstalled(BridgeError):
    """The extension is not packaged, or the host is not registered."""

    code = "not-installed"


class JobActiveError(BridgeError):
    """A new job was asked for while the current one is not finished."""

    code = "job-active"


class JobClaimedElsewhere(BridgeError):
    """Another browser profile holds the job."""

    code = "claimed-elsewhere"


class JobFileDamaged(BridgeError):
    """``job.json`` is there but not readable as a job."""

    code = "job-file"


# ---------------------------------------------------------------------------
# Time and ids
# ---------------------------------------------------------------------------


def _at(now) -> float:
    """Epoch seconds from an injected clock: a callable, a number, or None (the wall clock)."""
    if now is None:
        return time.time()
    if callable(now):
        return float(now())
    return float(now)


def _iso(epoch: float) -> str:
    """ISO-8601 UTC to the second, the shape every file written here uses."""
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _from_iso(text: str) -> float | None:
    """Epoch seconds from what :func:`_iso` wrote; None for anything else."""
    try:
        return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
    except (TypeError, ValueError):
        return None


def make_job_id(now=None) -> str:
    """``job_<yyyymmddThhmmss>_<6 hex>``, UTC so two machines never disagree."""
    return f"job_{time.strftime('%Y%m%dT%H%M%S', time.gmtime(_at(now)))}_{secrets.token_hex(3)}"


def _cswap_version() -> str:
    try:
        from importlib.metadata import version

        return version("claude-swap")
    except Exception:
        return "unknown"


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------


def encode(message: dict) -> bytes:
    """One frame: little-endian length, then compact ASCII JSON.

    ``ensure_ascii`` so that a project name with any character in it is still
    a frame of plain bytes, whatever the pipe or the console does with
    code pages. A reply that would not fit Chrome's limit is refused here
    rather than cut off: a truncated frame would hang the extension.
    """
    if not isinstance(message, dict):
        raise BridgeProtocolError("a bridge message is a JSON object")
    body = json.dumps(message, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    if len(body) > MAX_HOST_MESSAGE:
        raise BridgeProtocolError(
            f"a reply of {len(body)} bytes is over the {MAX_HOST_MESSAGE}-byte frame limit",
            code="too-large",
        )
    return struct.pack("<I", len(body)) + body


def _read_exact(stream: BinaryIO, count: int) -> bytes:
    """Read ``count`` bytes, or fewer only at end of file: a pipe may hand them out in pieces."""
    parts: list[bytes] = []
    remaining = count
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            break
        parts.append(chunk)
        remaining -= len(chunk)
    return b"".join(parts)


def read_message(stream: BinaryIO) -> dict | None:
    """The next frame as a dict; None at a clean end of file.

    Anything else that is wrong (a header cut short, a body cut short, a
    length over the limit, JSON that is not an object) is a protocol error:
    there is no way to find the next frame after one of those.
    """
    header = _read_exact(stream, 4)
    if not header:
        return None
    if len(header) < 4:
        raise BridgeProtocolError("the frame header was cut short")
    (length,) = struct.unpack("<I", header)
    if length > MAX_EXTENSION_MESSAGE:
        raise BridgeProtocolError(f"a frame of {length} bytes is over the {MAX_EXTENSION_MESSAGE}-byte limit")
    body = _read_exact(stream, length)
    if len(body) < length:
        raise BridgeProtocolError(f"the frame body was cut short ({len(body)} of {length} bytes)")
    try:
        message = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise BridgeProtocolError(f"the frame is not JSON ({e})") from None
    if not isinstance(message, dict):
        raise BridgeProtocolError("the frame is not a JSON object")
    return message


def write_message(stream: BinaryIO, message: dict) -> None:
    """Write one frame and flush it: Chrome waits for whole frames, never partial ones."""
    stream.write(encode(message))
    stream.flush()


# ---------------------------------------------------------------------------
# Redaction for the log
# ---------------------------------------------------------------------------

# Keys whose values are secrets whatever they hold, after normalizing the key
# (lowercase, non-alphanumerics removed), plus the suffixes that make any
# key one. The same set the extension's log.js uses.
_SECRET_KEYS = frozenset(
    {
        "cookie", "setcookie", "cookies", "authorization", "proxyauthorization", "xapikey",
        "apikey", "anthropicapikey", "sessionkey", "sessionid", "session", "secret", "password",
        "passwd", "token", "accesstoken", "refreshtoken", "idtoken", "bearer", "csrftoken",
        "xcsrftoken", "xsrftoken", "authtoken", "cfclearance", "cfbm",
    }
)
_SECRET_KEY_SUFFIXES = ("token", "secret", "password", "apikey")
REDACTED = "[redacted]"

# String rules on top of handoff's (private keys, sk-ant-, GitHub and AWS
# tokens, Bearer, KEY=value): a JWT, a cookie pair by name, and the query
# parameters that carry a session or a token.
_JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")
_COOKIE_PAIR_RE = re.compile(
    r"(?i)\b(sessionKey|session_key|cf_clearance|__cf_bm|__Secure-[\w-]+|__Host-[\w-]+|"
    r"csrftoken|intercom-session-[\w-]+)=[^;&\s]+"
)
_QUERY_PARAMS = (
    "token", "key", "api_key", "apikey", "session", "sessionKey", "code", "state", "auth",
    "access_token", "refresh_token",
)
_QUERY_RE = re.compile(r"(?i)([?&](?:" + "|".join(re.escape(p) for p in _QUERY_PARAMS) + r")=)[^&#\s]*")
_MAX_DEPTH = 20


def _secret_key(key: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", key.lower())
    return normalized in _SECRET_KEYS or normalized.endswith(_SECRET_KEY_SUFFIXES)


def redact_text(text: str) -> str:
    """Every string rule, in the order that keeps a later rule from seeing a secret already masked."""
    text, _ = _redact_known_secrets(text)
    text = _JWT_RE.sub(REDACTED, text)
    text = _COOKIE_PAIR_RE.sub(lambda m: f"{m.group(1)}={REDACTED}", text)
    if "?" in text:
        text = _QUERY_RE.sub(lambda m: f"{m.group(1)}{REDACTED}", text)
    return text


def redact_for_log(value, _depth: int = 0, _seen: set[int] | None = None):
    """A deep copy of ``value`` with secrets masked, safe to log.

    Keys are judged by name, strings by content; a chunk's ``data`` and a
    script's ``text`` become their size, since neither is worth a log line.
    Cycles and depth are guarded, so a strange object never takes the host
    down with it: logging must never be what fails.
    """
    seen = _seen if _seen is not None else set()
    if _depth > _MAX_DEPTH:
        return "[deep]"
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"<{len(value)} bytes>"
    if isinstance(value, dict):
        if id(value) in seen:
            return "[cycle]"
        seen.add(id(value))
        kind = value.get("type")
        out = {}
        for key, item in value.items():
            name = str(key)
            if _secret_key(name):
                out[name] = REDACTED
            elif name == "data" and kind in ("file.chunk", "file.write") and isinstance(item, str):
                out[name] = f"<{_base64_size(item)} bytes>"
            elif name == "text" and kind == "script" and isinstance(item, str):
                out[name] = f"<{len(item)} chars>"
            else:
                out[name] = redact_for_log(item, _depth + 1, seen)
        seen.discard(id(value))
        return out
    if isinstance(value, (list, tuple, set, frozenset)):
        if id(value) in seen:
            return "[cycle]"
        seen.add(id(value))
        out = [redact_for_log(item, _depth + 1, seen) for item in value]
        seen.discard(id(value))
        return out
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return redact_text(str(value))


def _base64_size(data: str) -> int:
    """How many bytes a base64 string decodes to, without decoding all of it."""
    stripped = data.rstrip("=")
    return max(0, (len(stripped) * 3) // 4)


class _RedactingFilter(logging.Filter):
    """Masks secrets in every record before a handler formats it."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.msg = redact_text(record.getMessage())
        except Exception:
            record.msg = "[unloggable record]"
        record.args = ()
        return True


class _PrivateRotatingFileHandler(RotatingFileHandler):
    """A rotating handler whose files are the person's alone, like the rest of the backup dir."""

    def _open(self):  # type: ignore[override]
        Path(self.baseFilename).parent.mkdir(parents=True, exist_ok=True)
        stream = super()._open()
        if sys.platform != "win32":
            try:
                os.chmod(self.baseFilename, 0o600)
            except OSError:
                pass
        return stream


def host_logger(root: Path) -> logging.Logger:
    """The host's own logger: a rotating ``bridge.log``, redacted, never a console.

    Separate from the ``claude-swap`` logger and not propagating to it, so
    nothing a debug flag adds to that one can ever reach stdout, which is
    the protocol.
    """
    logger = logging.getLogger("claude-swap.bridge")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    logger.handlers.clear()
    handler = _PrivateRotatingFileHandler(
        bridge_dir(root) / LOG_FILE, maxBytes=1024 * 1024, backupCount=3, delay=True
    )
    handler.setLevel(logging.DEBUG)
    handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
    handler.addFilter(_RedactingFilter())
    logger.addHandler(handler)
    return logger


# ---------------------------------------------------------------------------
# The packaged extension
# ---------------------------------------------------------------------------


def extension_id_from_key(key_b64: str) -> str:
    """Chrome's id for a manifest ``key``: sha256 of the DER, first 16 bytes as hex, ``0-9a-f`` -> ``a-p``."""
    try:
        der = base64.b64decode(key_b64, validate=True)
    except (ValueError, TypeError) as e:
        raise BridgeError(f"the manifest key is not base64 ({e})") from None
    digest = hashlib.sha256(der).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def extension_dir() -> Path | None:
    """Where the extension's files are: inside the wheel first, then the checkout."""
    here = Path(__file__).resolve()
    for candidate in (here.parent / "extension", here.parents[2] / "extension"):
        if (candidate / "manifest.json").is_file():
            return candidate
    return None


def default_extension_id() -> str:
    """The id pinned by the packaged manifest's public key."""
    directory = extension_dir()
    if directory is None:
        raise BridgeNotInstalled(
            "The cswap extension is not packaged with this cswap (no extension/manifest.json); "
            "pass --extension-id with the id chrome://extensions shows."
        )
    try:
        raw = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise BridgeNotInstalled(f"{directory / 'manifest.json'} could not be read ({e})") from None
    key = raw.get("key") if isinstance(raw, dict) else None
    if not isinstance(key, str) or not key:
        raise BridgeNotInstalled(f"{directory / 'manifest.json'} has no \"key\", so its id is not pinned")
    return extension_id_from_key(key)


def script_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# The files on disk
# ---------------------------------------------------------------------------


def bridge_dir(root: Path) -> Path:
    return Path(root) / BRIDGE_DIRNAME


def _ensure_dir(root: Path) -> Path:
    directory = bridge_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    if sys.platform != "win32":
        os.chmod(directory, 0o700)
    return directory


def _job_path(root: Path) -> Path:
    return bridge_dir(root) / JOB_FILE


class _Locked:
    """``FileLock`` on ``bridge/.lock`` with a message that says what is going on."""

    def __init__(self, root: Path, timeout: float = 5.0):
        self._lock = FileLock(bridge_dir(root) / LOCK_FILE, timeout=timeout)

    def __enter__(self):
        try:
            return self._lock.__enter__()
        except LockError:
            raise BridgeBusy(
                "The bridge files are busy (another cswap or the bridge host holds them); try again in a moment."
            ) from None

    def __exit__(self, *exc):
        self._lock.release()
        return False


@dataclass
class Job:
    """One job, as ``job.json`` holds it (section 2.3 of the design).

    ``kind`` says which script runs: an ``import`` queued from the command
    line, or an ``export`` started from the side panel's Duplicate, whose
    ``duplicate`` field holds the project chosen, the destination account
    and the name for the copy (and, on the import that follows, the export
    job it came from). ``extra`` keeps what a newer cswap may add, so a
    round trip loses nothing. ``last_status`` and ``last_interruption`` are
    kept on top of the agreed fields so that ``cswap bridge status`` and a
    reattached ``--watch`` can say where the job stands without replaying
    the events.
    """

    id: str
    created_at: str = ""
    updated_at: str = ""
    status: str = "queued"
    phase: str = ""
    export: dict = field(default_factory=dict)
    account: dict = field(default_factory=dict)
    name: str | None = None
    script: dict = field(default_factory=dict)
    claimed_by: dict | None = None
    cancel_requested: bool = False
    created_project: dict | None = None
    result: dict | None = None
    error: str | None = None
    last_status: dict | None = None
    last_interruption: dict | None = None
    kind: str = "import"
    duplicate: dict | None = None
    version: int = JOB_VERSION
    extra: dict = field(default_factory=dict)

    _FIELDS = (
        "version", "id", "created_at", "updated_at", "status", "phase", "export", "account", "name",
        "script", "claimed_by", "cancel_requested", "created_project", "result", "error",
        "last_status", "last_interruption", "kind", "duplicate",
    )

    @property
    def active(self) -> bool:
        return self.status in ACTIVE_STATUSES

    @property
    def terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES

    def owned_by(self, instance: str | None) -> bool:
        return bool(instance) and isinstance(self.claimed_by, dict) and self.claimed_by.get("instance") == instance

    def to_dict(self) -> dict:
        out = {key: getattr(self, key) for key in self._FIELDS}
        for key, value in self.extra.items():
            out.setdefault(key, value)
        return out

    @classmethod
    def from_dict(cls, raw: object) -> "Job":
        """A job from its JSON; :class:`JobFileDamaged` when it is not one.

        Lenient about what it can be (a missing dict becomes an empty one, a
        missing flag False), strict about what it must be (an object with an
        id of the right shape, a known status, this version).
        """
        if not isinstance(raw, dict):
            raise JobFileDamaged("job.json is not a JSON object")
        job_id = raw.get("id")
        if not isinstance(job_id, str) or not _JOB_ID_RE.match(job_id):
            raise JobFileDamaged("job.json has no job id")
        version = raw.get("version", JOB_VERSION)
        if version != JOB_VERSION:
            raise JobFileDamaged(f"job.json was written by another cswap (version {version!r})")
        status = raw.get("status")
        if status not in JOB_STATUSES:
            raise JobFileDamaged(f"job.json has an unknown status {status!r}")

        def text(key: str) -> str:
            value = raw.get(key)
            return value if isinstance(value, str) else ""

        def mapping(key: str) -> dict:
            value = raw.get(key)
            return dict(value) if isinstance(value, dict) else {}

        def optional(key: str) -> dict | None:
            value = raw.get(key)
            return dict(value) if isinstance(value, dict) else None

        name = raw.get("name")
        error = raw.get("error")
        job = cls(
            id=job_id,
            created_at=text("created_at"),
            updated_at=text("updated_at"),
            status=status,
            phase=text("phase"),
            export=mapping("export"),
            account=mapping("account"),
            name=name if isinstance(name, str) and name else None,
            script=mapping("script"),
            claimed_by=optional("claimed_by"),
            cancel_requested=raw.get("cancel_requested") is True,
            created_project=optional("created_project"),
            result=optional("result"),
            error=error if isinstance(error, str) and error else None,
            last_status=optional("last_status"),
            last_interruption=optional("last_interruption"),
            kind="export" if raw.get("kind") == "export" else "import",
            duplicate=optional("duplicate"),
            version=JOB_VERSION,
            extra={key: value for key, value in raw.items() if key not in cls._FIELDS},
        )
        return job


def load_job(root: Path) -> Job | None:
    """The current job, None when there is none; :class:`JobFileDamaged` when the file is unreadable."""
    path = _job_path(root)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as e:
        raise JobFileDamaged(f"{path} could not be read ({e.strerror or e})") from None
    try:
        raw = json.loads(text)
    except ValueError:
        raise JobFileDamaged(f"{path} is not valid JSON") from None
    return Job.from_dict(raw)


def _save_unlocked(root: Path, job: Job, now=None) -> None:
    job.updated_at = _iso(_at(now))
    atomic_write_json(_job_path(root), job.to_dict())


def save_job(root: Path, job: Job, now=None) -> None:
    """Write ``job`` as the current job, atomically and under the lock."""
    _ensure_dir(root)
    with _Locked(root):
        _save_unlocked(root, job, now)


def _safe_name(name: str, fallback: str = "export") -> str:
    """A folder name the page's root may carry: no separators, no control characters."""
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", name or "").strip(" .")
    return cleaned[:200] or fallback


def new_job(
    root: Path,
    *,
    export: pm.ExportCheck,
    account: tuple[str, str, str],
    name: str | None,
    script_text: str,
    now=None,
    stale_after: float = CANCEL_STALE_SECONDS,
    duplicate: dict | None = None,
    signed_in: bool = False,
) -> Job:
    """Queue a new import of ``export`` into ``account``.

    With ``signed_in`` the import goes into whichever account claude.ai is
    signed in as when the extension runs it (a Duplicate's Import): the
    account is ``("", "", "")`` here, recorded as ``signed_in``, and the
    extension names the one it found with an ``account`` event, which
    :func:`update_from_event` fills in.

    Refuses while the current job is not finished: the extension would not
    know which one it is running. Two jobs that only look unfinished are
    settled first (see :func:`_settle` and :func:`_abandoned`), so a job
    nobody will ever end cannot block every import after it. A ``job.json``
    that cannot be read at all is replaced, since nothing can be continued
    from it either way. The job's events file is started empty and older
    ones are pruned, so a reattached ``--watch`` never reads another job's
    lines.

    The export's listing is built once here, as the page will see it, so an
    export the bridge cannot hand over whole (a file export.json names that
    is not a plain file, or more files than fit one frame) is refused now,
    with the reason, rather than part-way through the import.
    """
    if not isinstance(export, pm.ExportCheck):
        raise BridgeError("new_job needs the export as checked by project-move")
    if not export.complete:
        why = export.error or (f"{len(export.missing)} listed files are missing" if export.missing else "sizes differ")
        raise BridgeError(f"The export at {export.path} cannot be imported: {why}")
    if not (isinstance(account, tuple) and len(account) == 3 and all(isinstance(part, str) for part in account)):
        raise BridgeError("new_job needs the account as (slot, email, organizationUuid)")
    slot, email, org_uuid = account
    if not email.strip() and not signed_in:
        raise BridgeError(f"Account-{slot} has no email on record; the extension cannot check who is signed in")
    if not isinstance(script_text, str) or not script_text.strip():
        raise BridgeError("new_job needs the import script's text")
    if name is not None and not isinstance(name, str):
        raise BridgeError("the project name must be text")

    _ensure_dir(root)
    with _Locked(root):
        when = _at(now)
        _make_room(root, when, stale_after)
        with ExportSource(export) as source:
            _check_listing_fits(source)
        job = Job(
            id=make_job_id(when),
            created_at=_iso(when),
            status="queued",
            kind="import",
            duplicate=copy.deepcopy(duplicate) if isinstance(duplicate, dict) else None,
            export={
                "path": str(export.path),
                "archive": export.archive is not None,
                "name": export.name or export.path.stem,
                "kind": export.kind,
                "files": export.files,
                "conversations": export.conversations,
                "bytes": export.bytes,
            },
            account={"slot": slot, "email": email.strip(), "org_uuid": org_uuid or "", **({"signed_in": True} if signed_in else {})},
            name=name.strip() if isinstance(name, str) and name.strip() else None,
            script={
                "sha256": script_sha256(script_text),
                "bytes": len(script_text.encode("utf-8")),
                "cswap_version": _cswap_version(),
            },
        )
        _save_unlocked(root, job, when)
        _start_events(root, job)
    return job


def _make_room(root: Path, when: float, stale_after: float) -> None:
    """Under the caller's lock: refuse while the current job is unfinished.

    Two jobs that only look unfinished are settled first (see
    :func:`_settle` and :func:`_abandoned`), so a job nobody will ever end
    cannot block every job after it. A ``job.json`` that cannot be read at
    all is replaced, since nothing can be continued from it either way.
    """
    try:
        current = load_job(root)
    except JobFileDamaged as e:
        _logger.warning("Replacing an unreadable bridge/job.json: %s", e)
        current = None
    current = _settle(root, current, when)
    if current is not None and current.active and _abandoned(current, when, stale_after):
        _logger.warning("Dropping job %s: asked to stop, and its browser never answered", current.id)
        current = _end_from_here(root, current, _abandoned_reason(current, stale_after), when)
    if current is not None and current.active:
        raise JobActiveError(_active_message(current, when, stale_after))
    # A finished Duplicate export whose import runs in a window of its own
    # is still at work: a new job would take its place in job.json, where
    # that import records how it ended.
    driven = current.duplicate.get("driven") if current is not None and isinstance(current.duplicate, dict) else None
    if _driven_running(driven, when):
        raise JobActiveError(
            f"The import of job {current.id} is running in its own window (process {driven['pid']}, "
            f"since {driven['started_at']}). Wait for it to finish, or stop it ({driven_stop_hint(driven['pid'])}); "
            "if it is gone and this still says it runs, `cswap project-move import --cancel` lets go of it."
        )


def _start_events(root: Path, job: Job) -> None:
    """The job's events file, started empty, and older ones pruned, so a reattached ``--watch`` never reads another job's lines."""
    events = events_path(root, job.id)
    with open(events, "wb"):
        pass
    _private(events)
    _prune_events(root, keep=EVENTS_KEEP, current=events)


# ---------------------------------------------------------------------------
# Duplicate: an export started from the side panel, and the import after it
# ---------------------------------------------------------------------------


def _slot_key(slot: str) -> tuple[int, str]:
    return (int(slot), "") if slot.isdigit() else (1 << 30, slot)


def list_accounts(root: Path) -> list[dict]:
    """The registry's accounts as the side panel offers them, read-only.

    Only ``sequence.json`` is read, and only each account's slot, email,
    organization, alias and kind: that file holds no credential, and
    nothing here opens the files that do. An account an import cannot go
    into (an API-key account, or one with no email to check the sign-in
    against) is listed with the reason, so the panel can say why rather
    than leave it out.
    """
    path = Path(root) / SEQUENCE_FILE
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as e:
        raise BridgeError(f"the account registry could not be read ({e})", code="registry") from None
    if not isinstance(raw, dict) or not isinstance(raw.get("accounts"), dict):
        return []
    accounts = raw["accounts"]
    sequence = raw.get("sequence") if isinstance(raw.get("sequence"), list) else []
    order = [str(n) for n in sequence if isinstance(n, (int, str)) and not isinstance(n, bool)]
    slots = [slot for slot in order if slot in accounts]
    slots += sorted((slot for slot in accounts if slot not in slots), key=_slot_key)
    out = []
    for slot in slots:
        record = accounts.get(slot)
        if not isinstance(record, dict):
            continue
        email = str(record.get("email") or "").strip()
        kind = "api_key" if record.get("kind") == "api_key" else "oauth"
        if kind == "api_key":
            why = "an API-key account; projects need a claude.ai login"
        elif not email:
            why = "no email on record, so the sign-in cannot be checked"
        else:
            why = ""
        out.append(
            {
                "slot": slot,
                "email": email,
                "organization": str(record.get("organizationName") or ""),
                "org_uuid": str(record.get("organizationUuid") or ""),
                "alias": str(record.get("alias") or ""),
                "kind": kind,
                "usable": not why,
                "why": why,
            }
        )
    return out


def resolve_destination(root: Path, identifier: object) -> dict:
    """The account ``identifier`` names, usable for an import.

    The same precedence as ``--to``: a slot number, then an alias, then an
    email; an email two accounts share is refused rather than guessed.
    """
    if not isinstance(identifier, str) or not identifier.strip():
        raise BridgeError("name the destination account (a slot, an alias or an email)", code="no-account")
    wanted = identifier.strip()
    accounts = list_accounts(root)
    found = [a for a in accounts if a["slot"] == wanted] if wanted.isdigit() else []
    if not found:
        found = [a for a in accounts if a["alias"] and a["alias"].lower() == wanted.lower()]
    if not found:
        found = [a for a in accounts if a["email"] and a["email"].lower() == wanted.lower()]
    if not found:
        raise BridgeError(f"No account found with identifier: {wanted}", code="no-account")
    if len(found) > 1:
        slots = ", ".join(a["slot"] for a in found)
        raise BridgeError(f"{wanted} names accounts {slots}; choose one by number", code="no-account")
    account = found[0]
    if not account["usable"]:
        raise BridgeError(
            f"Account-{account['slot']} ({account['email'] or 'no email'}) cannot take an import: {account['why']}",
            code="account-unusable",
        )
    return account


def new_export_job(
    root: Path,
    *,
    instance: str,
    extension_version: str = "",
    folder: Path | None = None,
    now=None,
    stale_after: float = CANCEL_STALE_SECONDS,
) -> Job:
    """Start a Duplicate: an export job the extension holds from the start.

    The side panel that asked for it is the one that runs it, so the job is
    born claimed by ``instance``; what is exported and where it goes come
    later (:func:`choose_export`). The export lands in the folder ``cswap
    project-move export`` uses, so ``cswap project-move check`` finds it
    afterwards like any other. The same rule as :func:`new_job` keeps two
    jobs from being current at once.
    """
    if not isinstance(instance, str) or not instance.strip():
        raise BridgeError("an export job names the browser instance that runs it", code="bad-instance")
    if folder is None:
        folder = pm.resolve_folder(pm.MoveState.load(root), None)
    script_text = pm.script_text("export")
    _ensure_dir(root)
    with _Locked(root):
        when = _at(now)
        _make_room(root, when, stale_after)
        job = Job(
            id=make_job_id(when),
            created_at=_iso(when),
            status="claimed",
            kind="export",
            export={
                "path": "",
                "archive": False,
                "name": "",
                "kind": "",
                "files": 0,
                "conversations": 0,
                "bytes": 0,
                "folder": str(folder),
                "top": "",
            },
            account={"slot": "", "email": "", "org_uuid": ""},
            script={
                "sha256": script_sha256(script_text),
                "bytes": len(script_text.encode("utf-8")),
                "cswap_version": _cswap_version(),
            },
            claimed_by={"instance": instance, "at": _iso(when), "extension_version": str(extension_version or "")},
            duplicate={"project": None, "destination": None, "name": None, "import_job": None},
        )
        _save_unlocked(root, job, when)
        _start_events(root, job)
    return job


_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")


def _project_spec(raw: object) -> dict:
    """The chosen project as the page listed it, checked field by field."""
    if not isinstance(raw, dict):
        raise BridgeError("export.choose names the project as an object", code="bad-project")
    ident = raw.get("id")
    if not isinstance(ident, str) or not _PROJECT_ID_RE.match(ident):
        raise BridgeError("the project has no id of a known shape", code="bad-project")
    name = raw.get("name")
    return {
        "id": ident,
        "name": name.strip()[:500] if isinstance(name, str) and name.strip() else ident,
        "kind": "code" if raw.get("kind") == "code" else "standard",
        "org_uuid": str(raw.get("org_uuid") or "")[:100],
        "org_name": str(raw.get("org_name") or "")[:200],
    }


def _held_export_job(root: Path, job_id: object, instance: str | None) -> Job:
    """The export job ``instance`` holds, for a caller under the lock; a refusal otherwise."""
    if not isinstance(job_id, str) or not _JOB_ID_RE.match(job_id):
        raise BridgeError("that is not a job id", code="not-claimed")
    job = load_job(root)
    if job is None or job.id != job_id:
        raise BridgeError(f"job {job_id} is not the current job", code="not-claimed")
    if job.status not in SERVED_STATUSES or not job.owned_by(instance):
        raise BridgeError(f"job {job_id} is not claimed by this browser", code="not-claimed")
    if job.kind != "export":
        raise BridgeError(f"job {job_id} is an import, not an export", code="not-export")
    return job


def choose_export(
    root: Path,
    job_id: object,
    instance: str | None,
    *,
    project: object,
    destination: object = None,
    name: object = None,
    source: object = None,
    now=None,
) -> Job:
    """Record what the Duplicate exports, and the name for the copy if one was typed.

    ``source`` is the account the page found signed in, kept as the job's
    account the way an import keeps its destination. The copy goes into
    whichever account is signed in when Import is pressed, so no
    ``destination`` is needed; one an earlier panel chose is resolved and
    recorded as before, for the line to type and the import in a window of
    its own. The choice can be changed until the first file is written;
    after that the export on disk belongs to the project chosen, and a
    change takes a new job.
    """
    spec = _project_spec(project)
    account = resolve_destination(root, destination) if isinstance(destination, str) and destination.strip() else None
    if name is not None and not isinstance(name, str):
        raise BridgeError("the project name must be text", code="bad-name")
    with _Locked(root):
        when = _at(now)
        job = _held_export_job(root, job_id, instance)
        if job.export.get("top"):
            raise BridgeError(
                "the export has started writing; stop this job and start a new Duplicate to change it",
                code="already-chosen",
            )
        job.duplicate = {
            "project": spec,
            "destination": {
                "slot": account["slot"],
                "email": account["email"],
                "org_uuid": account["org_uuid"],
                "organization": account["organization"],
            } if account else None,
            "name": name.strip() if isinstance(name, str) and name.strip() else None,
            "import_job": None,
        }
        job.export["name"] = spec["name"]
        job.export["kind"] = spec["kind"]
        if isinstance(source, dict):
            job.account = {
                "slot": "",
                "email": str(source.get("email") or "").strip(),
                "org_uuid": str(source.get("org_uuid") or ""),
            }
        _save_unlocked(root, job, when)
    return job


def _chosen_without_a_name(project: dict) -> bool:
    """Whether the Duplicate's project was recorded with no name the site gave.

    The bridge records the id when the panel sends no name; an older
    extension sent the panel's own stand-in label in its place.
    """
    ident = project.get("id")
    name = project.get("name")
    if not isinstance(name, str):
        return True
    return name.strip() in ("", ident, "(unnamed project)", f"This tab's workspace ({ident})")


def _export_manifest_name(job: Job) -> str:
    """The project's name as the finished export's ``export.json`` gives it, or ''; never raises.

    Read as UTF-8, as ``project_move.read_export`` reads it. A manifest
    whose source names another project is not this export's and gives
    nothing.
    """
    path = job.export.get("path")
    if not isinstance(path, str) or not path:
        return ""
    try:
        raw = json.loads(Path(_long_path(str(Path(path) / pm.MANIFEST_NAME))).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    if not isinstance(raw, dict):
        return ""
    project = (job.duplicate or {}).get("project") or {}
    source = raw.get("source")
    if isinstance(source, dict) and source.get("id") and source.get("id") != project.get("id"):
        return ""
    name = raw.get("name")
    return name.strip()[:500] if isinstance(name, str) and name.strip() else ""


def _name_unnamed_export(job: Job) -> None:
    """Give a finished Duplicate export chosen without a name the name its export gives; in place.

    The side panel offers a Claude Code project the site named nowhere by
    its id alone, while the export script, on the project's page, finds the
    name itself and writes it into ``export.json``. That name then stands
    in the job (and so in the import queued from it) for the id. A name the
    listing gave is never replaced.
    """
    duplicate = job.duplicate if isinstance(job.duplicate, dict) else {}
    project = duplicate.get("project")
    if not isinstance(project, dict) or not _chosen_without_a_name(project):
        return
    name = _export_manifest_name(job)
    if name:
        project["name"] = name
        job.export["name"] = name
        _logger.info("job %s: the project's name was taken from its export.json", job.id)


def _unique_top(folder: Path, name: str) -> str:
    """``name``, or ``name (n)`` when the folder already has one: the rule ``project-move auto`` keeps."""
    chosen, n = name, 1
    while os.path.lexists(_long_path(str(folder / chosen))):
        n += 1
        chosen = f"{name} ({n})"
    return chosen


def _already_written(target: str, size: int, offset: int, piece: bytes) -> bool:
    """Whether the piece is the one that already ends the file on disk."""
    if size < 0 or size != offset + len(piece):
        return False
    if not piece:
        return True
    with open(target, "rb") as handle:
        handle.seek(offset)
        return handle.read(len(piece) + 1) == piece


def write_export_file(
    root: Path,
    job_id: object,
    instance: str | None,
    *,
    path: object,
    offset: object,
    data: object,
    last: bool,
    now=None,
) -> dict:
    """Save one piece of a file the export script writes; the sizes so far.

    The script writes every file under one top folder named after the
    project; that folder gets a name of its own in the exports folder when
    one exists already, the way ``project-move auto`` does it, and the
    mapping is kept in the job so every piece lands in the same place. A
    path that could leave the folder is refused, and so is a piece that
    does not follow on from what is on disk: the page sends them in order
    and waits for each answer, so a gap is something that went wrong, never
    something to paper over. A file's first piece starts it afresh.

    The answer names the export's folder (``export_path``), fixed at the
    first write, so the extension can show the line that imports it.

    An empty last piece at the end of the bytes on disk closes the file:
    the page sends one when the file's bytes went out in full pieces
    before it closed. It is counted once; the same piece sent again (its
    answer was lost) is answered as before and counted no further.
    """
    if not isinstance(path, str) or not path:
        raise BridgeError("file.write names a path", code="bad-path")
    parts = pm._plain_parts(path)
    if parts is None or len(parts) < 2:
        raise BridgeError(f"refused a path that does not stay under the export's folder: {path!r}", code="bad-path")
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise BridgeError("file.write carries the offset its piece starts at", code="bad-offset")
    if not isinstance(data, str):
        raise BridgeError("file.write carries its piece as base64 text", code="bad-data")
    try:
        piece = base64.b64decode(data, validate=True)
    except (ValueError, binascii.Error):
        raise BridgeError("file.write carries its piece as base64 text", code="bad-data") from None
    with _Locked(root):
        when = _at(now)
        job = _held_export_job(root, job_id, instance)
        if not (job.duplicate or {}).get("project"):
            raise BridgeError("choose the project and the destination before the export writes", code="not-chosen")
        folder_text = job.export.get("folder")
        if not isinstance(folder_text, str) or not folder_text:
            raise BridgeError("the job names no exports folder", code="export-missing")
        folder = Path(folder_text)
        script_top = job.export.get("script_top")
        if not script_top:
            os.makedirs(_long_path(str(folder)), exist_ok=True)
            top = _unique_top(folder, parts[0])
            job.export["script_top"] = parts[0]
            job.export["top"] = top
            job.export["path"] = str(folder / top)
            _save_unlocked(root, job, when)
        elif parts[0] != script_top:
            raise BridgeError(
                f"the export writes under one folder, {script_top!r}, not {parts[0]!r}", code="bad-path"
            )
        target = _long_path(str(folder.joinpath(str(job.export["top"]), *parts[1:])))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        try:
            size = os.path.getsize(target)
        except OSError:
            size = -1
        closing = last and not piece
        resent = (
            job.export.get("closed") == {"path": path, "size": size} and size == offset
            if closing
            else _already_written(target, size, offset, piece)
        )
        if resent:
            # The page sends a piece again when the answer to it was lost
            # (the port dropped between the write and the reply). The bytes
            # are on disk and were counted, so the answer is repeated and
            # nothing is written or counted twice.
            return {
                "path": path,
                "size": size,
                "files": int(job.export.get("files") or 0),
                "bytes": int(job.export.get("bytes") or 0),
                "cancel_requested": job.cancel_requested,
                "export_path": str(job.export.get("path") or ""),
            }
        if offset == 0:
            mode = "wb"
        else:
            if size != offset:
                raise BridgeError(
                    f"{path}: a piece starting at {offset} arrived with {max(size, 0)} bytes on disk",
                    code="out-of-order",
                    size=max(size, 0),
                )
            mode = "ab"
        with open(target, mode) as handle:
            handle.write(piece)
        size = os.path.getsize(target)
        if last:
            job.export["files"] = int(job.export.get("files") or 0) + 1
            job.export["bytes"] = int(job.export.get("bytes") or 0) + size
            # The file counted last, so an empty closing piece sent again is
            # known for what it is.
            job.export["closed"] = {"path": path, "size": size}
            _save_unlocked(root, job, when)
        return {
            "path": path,
            "size": size,
            "files": int(job.export.get("files") or 0),
            "bytes": int(job.export.get("bytes") or 0),
            "cancel_requested": job.cancel_requested,
            "export_path": str(job.export.get("path") or ""),
        }


def queue_duplicate_import(
    root: Path,
    job_id: object,
    instance: str | None,
    now=None,
    stale_after: float = CANCEL_STALE_SECONDS,
    *,
    destination: object = None,
    name: object = None,
    signed_in: bool = False,
) -> Job:
    """Queue the import half of a Duplicate from its finished export.

    What ``cswap project-move import --to`` does, into whichever account
    claude.ai is signed in as when the extension runs it (``signed_in``,
    what the side panel's Import asks for; the extension names the account
    it finds with an ``account`` event), or, as an older panel asked, into
    the destination the export job recorded or the one given now
    (``destination``, an account as ``resolve_destination`` takes it).
    ``name`` is the name typed for the copy, if any. The export on disk is
    read back whole first, so one that stopped short is refused here with
    the reason rather than part-way through the import, and the move state
    is written as the export and import stages write it, so ``cswap
    project-move check`` and ``--watch`` see the move like any other. A
    destination or a name given now is recorded on the export job too, so
    the line to type and ``cswap bridge status`` say the same.

    Asked again for the same export (the answer, or the claim after it,
    was lost on the way), the import already queued from it is the answer,
    while it is unfinished and not another browser's: nothing is queued
    twice.
    """
    if not isinstance(job_id, str) or not _JOB_ID_RE.match(job_id):
        raise BridgeError("that is not a job id", code="not-claimed")
    try:
        current = load_job(root)
    except JobFileDamaged as e:
        raise BridgeError(str(e), code="job-file") from None
    if (
        current is not None
        and current.kind == "import"
        and isinstance(current.duplicate, dict)
        and current.duplicate.get("export_job") == job_id
        and not current.terminal
        and (current.status == "queued" or current.owned_by(instance))
    ):
        return current
    if current is None or current.id != job_id or not current.owned_by(instance):
        raise BridgeError(f"job {job_id} is not this browser's current job", code="not-claimed")
    if current.kind != "export":
        raise BridgeError(f"job {job_id} is an import, not an export", code="not-export")
    if current.status != "done":
        raise BridgeError(f"the export job {job_id} is {current.status}, not done", code="not-done")
    if name is not None and not isinstance(name, str):
        raise BridgeError("the project name must be text", code="bad-name")
    if isinstance(name, str) and _CONTROL_RE.search(name):
        raise BridgeError("the name for the copy holds a control character", code="bad-name")
    duplicate = current.duplicate if isinstance(current.duplicate, dict) else {}
    if destination is not None and not signed_in:
        account_now = resolve_destination(root, destination)
        duplicate = {
            **duplicate,
            "destination": {
                "slot": account_now["slot"],
                "email": account_now["email"],
                "org_uuid": account_now["org_uuid"],
                "organization": account_now["organization"],
            },
        }
    if name is not None:
        duplicate = {**duplicate, "name": name.strip() or None}
    if (destination is not None and not signed_in) or name is not None:
        with _Locked(root):
            held = load_job(root)
            if held is not None and held.id == current.id:
                held.duplicate = {**(held.duplicate if isinstance(held.duplicate, dict) else {}), **duplicate}
                _save_unlocked(root, held, _at(now))
                current = held
    destination = duplicate.get("destination") if isinstance(duplicate.get("destination"), dict) else None
    if signed_in:
        destination = None
    elif not destination or not destination.get("email"):
        raise BridgeError("the export job names no destination account", code="not-chosen")
    path_text = current.export.get("path")
    if not isinstance(path_text, str) or not path_text:
        raise BridgeError("the export job wrote no files", code="export-incomplete")
    check = pm.read_export(Path(path_text))
    if not check.complete:
        why = check.error or (f"{len(check.missing)} listed files are missing" if check.missing else "sizes differ")
        raise BridgeError(f"The export at {path_text} is not whole: {why}", code="export-incomplete")
    account = (
        str(destination.get("slot") or ""),
        str(destination.get("email") or ""),
        str(destination.get("org_uuid") or ""),
    ) if destination else ("", "", "")
    name = duplicate.get("name") if isinstance(duplicate.get("name"), str) else None
    job = new_job(
        root,
        export=check,
        account=account,
        name=name,
        script_text=pm.script_text("import"),
        now=now,
        stale_after=stale_after,
        signed_in=signed_in,
        duplicate={
            "export_job": current.id,
            "source": {
                "email": str(current.account.get("email") or ""),
                "org_uuid": str(current.account.get("org_uuid") or ""),
                "project": duplicate.get("project"),
            },
        },
    )
    state = pm.MoveState.load(root)
    pm.begin_move(state, pm.CARRIER_FOLDER)
    state.folder = str(current.export.get("folder") or "")
    state.export_path = str(check.path)
    state.export_seen_at = pm._now_iso()
    state.save(root)
    return job


# How many exports on disk the side panel is offered, newest first. A
# folder that holds more is one to tidy, not a list to scroll.
LIST_EXPORTS_MAX = 100


def exports_folder(root: Path) -> Path:
    """The folder a Duplicate's export lands in and ``cswap project-move`` reads: the remembered one, or the default."""
    return pm.resolve_folder(pm.MoveState.load(root), None)


def list_exports(root: Path) -> dict:
    """The exports on disk, as the side panel offers them to import.

    What ``cswap project-move check`` sees in the exports folder, every
    export counted whatever its age, newest first, whole ones only (one
    that stopped short cannot be imported, and :func:`queue_import_of_export`
    would refuse it): each one's folder (or .tar), the project's name and
    kind as its export.json gives them, its size, and when it finished.
    Nothing but names and counts leaves the folder; the files themselves
    are read only by an import, one by one, as ever.
    """
    folder = exports_folder(root)
    found = pm.check_folder(folder)
    exports = [
        {
            "path": str(export.path),
            "archive": export.archive is not None,
            "name": export.name or export.path.stem,
            "kind": export.kind,
            "files": export.files,
            "conversations": export.conversations,
            "bytes": export.bytes,
            "finished_at": _iso(export.finished_at) if export.finished_at else "",
        }
        for export in found.exports
        if export.complete
    ]
    return {
        "folder": str(folder),
        "exists": found.exists,
        "exports": exports[:LIST_EXPORTS_MAX],
        "more": max(0, len(exports) - LIST_EXPORTS_MAX),
        "unfinished": len(found.unfinished),
        "error": found.error,
    }


def queue_import_of_export(
    root: Path,
    path_text: object,
    instance: str | None,
    now=None,
    stale_after: float = CANCEL_STALE_SECONDS,
    *,
    name: object = None,
) -> Job:
    """Queue the import of an export on disk, one :func:`list_exports` offers.

    The side panel's Import for an export other than the one this browser
    just made: the same job ``cswap project-move import --to`` queues,
    into whichever account claude.ai is signed in as when the extension
    runs it (``signed_in``, as :func:`queue_duplicate_import` with it),
    under the name typed, if any. Only an export the listing offers is
    taken, an entry of the exports folder (or the folder itself when it
    is one export): a path from anywhere else is refused, so the
    extension can name nothing the bridge did not show it. Asked again
    for the same export while the import queued from it is unfinished
    and this browser's, that import is the answer.
    """
    if not isinstance(path_text, str) or not path_text.strip():
        raise BridgeError("import.queue names the export to import by its path, or the export job", code="not-listed")
    if name is not None and not isinstance(name, str):
        raise BridgeError("the project name must be text", code="bad-name")
    if isinstance(name, str) and _CONTROL_RE.search(name):
        raise BridgeError("the name for the copy holds a control character", code="bad-name")
    folder = exports_folder(root)
    asked = Path(os.path.abspath(path_text.strip()))
    if asked != folder and asked.parent != folder:
        raise BridgeError(f"{asked} is not an export in {folder}; only an export listed there can be imported", code="not-listed")
    if pm.is_archive(asked) and asked.is_file():
        check = pm.read_export_tar(asked)
    elif (asked / pm.MANIFEST_NAME).is_file():
        check = pm.read_export(asked)
    else:
        raise BridgeError(f"there is no export at {asked}", code="not-listed")
    if not check.complete:
        why = check.error or (f"{len(check.missing)} listed files are missing" if check.missing else "sizes differ")
        raise BridgeError(f"The export at {asked} is not whole: {why}", code="export-incomplete")
    try:
        current = load_job(root)
    except JobFileDamaged as e:
        raise BridgeError(str(e), code="job-file") from None
    if (
        current is not None
        and current.kind == "import"
        and str(current.export.get("path") or "") == str(check.path)
        and not current.terminal
        and (current.status == "queued" or current.owned_by(instance))
    ):
        return current
    job = new_job(
        root,
        export=check,
        account=("", "", ""),
        name=(name.strip() or None) if isinstance(name, str) else None,
        script_text=pm.script_text("import"),
        now=now,
        stale_after=stale_after,
        signed_in=True,
    )
    state = pm.MoveState.load(root)
    pm.begin_move(state, pm.CARRIER_FOLDER)
    state.folder = str(folder)
    state.export_path = str(check.path)
    state.export_seen_at = pm._now_iso()
    state.save(root)
    return job


def _note_imported(root: Path) -> None:
    """The move's import stage is done, as ``cswap project-move import`` records it; never fails the ack."""
    try:
        state = pm.MoveState.load(root)
        state.imported_at = pm._now_iso()
        state.save(root)
    except OSError as e:
        _logger.warning("could not record the import in the move state: %s", e)


# ---------------------------------------------------------------------------
# Duplicate: the import in a window of its own
# ---------------------------------------------------------------------------

DRIVEN_LOG = "driven-{}.log"
DRIVEN_TAIL_LINES = 12
DRIVEN_TAIL_BYTES = 64 * 1024
DRIVEN_LINE_CHARS = 300
# How long a driven import can be believed to be running: two sign-ins and
# the import script's own limits, with room to spare. Past it, a record that
# never said how it ended counts as lost, whatever its process id names now.
DRIVEN_MAX_SECONDS = 9 * 3600
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_URL_TAIL_RE = re.compile(r"(https?://[^\s?#]+)[?#]\S*")
_CLAUDE_URL_RE = re.compile(r"^https://claude\.ai/[^\s?#]*$")
_CODE_PROJECT_URL_RE = re.compile(r"^https://claude\.ai/code/project/chan_[A-Za-z0-9_-]+/?$")
_NEW_PROJECT_RE = re.compile(r"the new project is at (https://claude\.ai/\S+)")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
# Windows process creation, by number: subprocess names these on Windows only.
_CREATE_NEW_CONSOLE = 0x00000010
_CREATE_BREAKAWAY_FROM_JOB = 0x01000000
_STARTF_USESHOWWINDOW = 0x00000001
_SW_SHOWNORMAL = 1
# How far the start of a process may be read apart from the one recorded and
# still be the same process: Windows gives it exactly, ``ps`` in wall-clock
# seconds that a clock step can move (see process_detection).
_CREATED_SLACK = 2.0 if sys.platform == "win32" else float(process_detection.PID_REUSE_SLACK_S)

# Module names, so a test can stand in for them.
_pid_alive = process_detection.is_pid_alive


def is_job_id(value: object) -> bool:
    return isinstance(value, str) and bool(_JOB_ID_RE.match(value))


def driven_log_path(root: Path, job_id: str) -> Path:
    """``bridge/driven-<job>.log``: what the import in a window of its own printed."""
    if not is_job_id(job_id):
        raise BridgeError(f"not a job id: {job_id!r}", code="not-claimed")
    return bridge_dir(root) / DRIVEN_LOG.format(job_id)


def strip_query(text: str) -> str:
    """``text`` with the query string and fragment of every web address cut off."""
    return _URL_TAIL_RE.sub(r"\1", text)


def driven_log_text(text: str) -> str:
    """A line of the driven import's output as it may be kept: no colour codes, no query strings, secrets masked."""
    return redact_text(strip_query(_ANSI_RE.sub("", text)))


def _claude_url(value: object) -> str:
    return value if isinstance(value, str) and _CLAUDE_URL_RE.match(value) else ""


# What a line to type says in place of a name it cannot carry: a comment,
# so PowerShell and POSIX shells run the rest and the person sees why (cmd
# refuses the line instead). The side panel's own lines say the same.
UNTYPED_NAME_NOTE = "# add --name yourself: no quoting carries the copy's name whole on a line to copy"


def typed_value(text: str, platform: str | None = None) -> str | None:
    """``text`` as the value after ``--option=`` on a line to copy into a shell; None when no quoting keeps it whole.

    The value always follows ``--option=``, so one that starts with ``-``
    or ``@`` is never a word of its own (an option to argparse, splatting
    to PowerShell). POSIX shells take ``shlex.quote``. A Windows line is
    for PowerShell, which a terminal opens there: a plain value goes bare;
    one with a space or a comma in double quotes, which cmd reads the same
    way; one with ``$`` or a backtick, which PowerShell expands inside
    double quotes, in single quotes with each ``'`` doubled. A double quote
    cannot be carried at all: Windows PowerShell and PowerShell 7 hand it
    to a program differently, and neither form survives the other. Nor can
    a trailing backslash inside quotes, which a program reads as escaping
    the closing quote.
    """
    if not text or _CONTROL_RE.search(text):
        return None
    if _plat(platform) != "win32":
        return shlex.quote(text)
    if re.fullmatch(r"[\w@+=:./\\-]+", text):
        return text
    if '"' in text or text.endswith("\\"):
        return None
    if not re.search(r"[$`]", text):
        return f'"{text}"'
    return "'" + text.replace("'", "''") + "'"


def driven_stop_hint(pid: object, platform: str | None = None) -> str:
    """How the person stops an import running in a window of its own, as one clause.

    On Windows it has a console window of its own. Elsewhere it has no
    window but its browser window, which it opens again once when that is
    closed; ending its process with ``kill`` ends it as Ctrl+C does.
    """
    if _plat(platform) == "win32":
        return "close its console window"
    return f"end its process with kill {pid}" if isinstance(pid, int) and not isinstance(pid, bool) else "end its process with kill"


def driven_command(root: Path, job: Job, *, python: str | None = None, platform: str | None = None) -> tuple[list[str], str]:
    """The command that imports a finished Duplicate export in a window of its own, and the line a person would type.

    ``cswap project-move auto --export <the export's folder> --to <slot>``,
    with ``--name`` when one was typed for the copy, and ``--into`` the
    project an earlier try of it stopped in, so nothing is made twice. Built
    from ``job.json`` alone, which cswap wrote: nothing the extension sends
    but the job id goes into it. The name is one argument of its own
    (``--name=<name>``), and the ``=`` form keeps a value that starts with
    ``-`` from being read as an option; no shell ever reads the command.
    The line to type does the same (see :func:`typed_value`).
    """
    if job.kind != "export":
        raise BridgeError(f"job {job.id} is an import, not an export", code="not-export")
    if job.status != "done":
        raise BridgeError(f"the export job {job.id} is {job.status}, not done", code="not-done")
    duplicate = job.duplicate if isinstance(job.duplicate, dict) else {}
    destination = duplicate.get("destination") if isinstance(duplicate.get("destination"), dict) else None
    if not destination or not destination.get("email"):
        raise BridgeError("the export job names no destination account", code="not-chosen")
    path_text = job.export.get("path")
    if not isinstance(path_text, str) or not path_text:
        raise BridgeError("the export job wrote no files", code="export-incomplete")
    check = pm.read_export(Path(path_text))
    if not check.complete:
        why = check.error or (f"{len(check.missing)} listed files are missing" if check.missing else "sizes differ")
        raise BridgeError(f"The export at {path_text} is not whole: {why}", code="export-incomplete")
    # The account is looked up again: a slot that names another account now
    # would put the copy somewhere the person did not choose.
    account = resolve_destination(root, str(destination.get("slot") or "") or str(destination["email"]))
    if account["email"].lower() != str(destination["email"]).lower():
        raise BridgeError(
            f"Account-{account['slot']} is {account['email']} now, not {destination['email']}; start the Duplicate again",
            code="account-changed",
        )
    name = duplicate.get("name").strip() if isinstance(duplicate.get("name"), str) else ""
    if _CONTROL_RE.search(name):
        raise BridgeError("the name for the copy holds a control character", code="bad-name")
    name = name[:500]
    earlier = duplicate.get("driven") if isinstance(duplicate.get("driven"), dict) else {}
    into = earlier.get("carry_on") if isinstance(earlier.get("carry_on"), str) else ""
    into = into if _CODE_PROJECT_URL_RE.match(into) else ""
    argv = [
        python or sys.executable, "-m", "claude_swap", "project-move", "auto",
        f"--export={check.path}", f"--to={account['slot']}",
    ]
    if name:
        argv.append(f"--name={name}")
    if into:
        argv.append(f"--into={into}")
    argv.append(f"--bridge-job={job.id}")
    folder = typed_value(str(check.path), platform) or f'"{check.path}"'
    words = [f"cswap project-move auto --export={folder}", "--to", account["slot"]]
    shown = typed_value(name, platform) if name else None
    if shown:
        words.append(f"--name={shown}")
    if into:
        words += ["--into", into]
    line = " ".join(words)
    if name and not shown:
        line += f"  {UNTYPED_NAME_NOTE}"
    return argv, line


def _child_env(root: Path, environ=None, *, platform: str | None = None, backup_root: Path | None = None) -> dict:
    """The driven import's environment: the host's (Chrome's), with this cswap's code first on its path.

    The host runs with Chrome's environment, which may not be the shell's:
    the child is pointed at the code this host runs from, and must find the
    same backup folder, or its accounts and its record would be somewhere
    else. On Linux that folder follows ``XDG_DATA_HOME``, which is set to
    match; anywhere else a mismatch is refused rather than guessed. Nothing
    else is added or removed.
    """
    env = dict(os.environ if environ is None else environ)
    code = code_dir()
    env["PYTHONPATH"] = code + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    env["PYTHONIOENCODING"] = "utf-8"
    found = Path(backup_root) if backup_root is not None else paths.get_backup_root()
    if not _same_dir(str(found), str(root)):
        if _plat(platform) == "linux" and Path(root).name == "claude-swap":
            env["XDG_DATA_HOME"] = str(Path(root).parent)
        else:
            raise BridgeError(
                f"cswap would look for its accounts in {found}, not in {root}; run the import by hand", code="root-mismatch"
            )
    return env


def _shown_window():
    """A STARTUPINFO that shows the new console window, though Chrome started the host hidden. Windows only."""
    info = subprocess.STARTUPINFO()  # type: ignore[attr-defined]
    info.dwFlags |= _STARTF_USESHOWWINDOW
    info.wShowWindow = _SW_SHOWNORMAL
    return info


def _spawn_detached(
    argv: list[str], *, cwd: Path, env: dict, log_path: Path, platform: str | None = None, popen=None, startupinfo=None
) -> int:
    """Start ``argv`` on its own, so it outlives this host; its process id.

    The host's stdout is the protocol with Chrome. On Windows the child gets
    a console of its own and none of the host's handles: stdin, stdout and
    stderr all left alone, since any one of them given would make the child
    inherit the host's, the protocol's pipe among them. It writes its own
    log (see ``project-move auto --bridge-job``). Elsewhere it has no window
    and its output goes to the log, in a session of its own.
    """
    run = popen or subprocess.Popen
    try:
        if _plat(platform) == "win32":
            info = startupinfo if startupinfo is not None else _shown_window()
            common = dict(cwd=str(cwd), env=env, startupinfo=info, stdin=None, stdout=None, stderr=None, close_fds=True)
            try:
                proc = run(argv, creationflags=_CREATE_NEW_CONSOLE | _CREATE_BREAKAWAY_FROM_JOB, **common)
            except OSError:
                # Chrome may keep the host in a job that cannot be left: the
                # import then starts inside it, and ends if Chrome is quit.
                proc = run(argv, creationflags=_CREATE_NEW_CONSOLE, **common)
        else:
            with open(log_path, "ab") as log:
                proc = run(
                    argv, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                    start_new_session=True, close_fds=True,
                )
    except OSError as e:
        raise BridgeError(f"could not start the import: {e}", code="spawn-failed") from None
    return int(proc.pid)


def _process_created(pid: object) -> float | None:
    """When process ``pid`` started, in epoch seconds; None when that cannot be read.

    It tells the import's own process from another that got its number
    after it ended: Windows and POSIX both reuse process ids, and an id
    that is alive says nothing about whose it is.
    """
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return None
    if sys.platform != "win32":
        started = process_detection.process_started_at(pid)
        return float(started) if started is not None else None
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return None
        try:
            times = [wintypes.FILETIME() for _ in range(4)]
            if not kernel32.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
                return None
            ticks = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
            return ticks / 10_000_000 - 11_644_473_600
        finally:
            kernel32.CloseHandle(handle)
    except (OSError, AttributeError, ValueError, TypeError):
        return None


def _same_process(record: dict, pid: int) -> bool | None:
    """True when ``pid`` started when the record says, False when it did not, None when either is not known."""
    recorded = record.get("created")
    if isinstance(recorded, bool) or not isinstance(recorded, (int, float)):
        return None
    seen = _process_created(pid)
    if seen is None:
        return None
    return abs(seen - float(recorded)) <= _CREATED_SLACK


def _driven_running(record: object, now: float) -> bool:
    """Whether the import a driven record names is still running.

    Its process is alive, it has not said how it ended, it is younger than
    ``DRIVEN_MAX_SECONDS``, and, whenever the process's start can be read,
    it is the process the record names, not another with the same id.
    """
    if not isinstance(record, dict) or record.get("ended_at"):
        return False
    pid = record.get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return False
    started = _from_iso(record.get("started_at") or "")
    if started is None or now - started >= DRIVEN_MAX_SECONDS:
        return False
    if not _pid_alive(pid):
        return False
    return _same_process(record, pid) is not False


def _prune_driven_logs(root: Path, keep: int, current: Path) -> None:
    """The oldest driven logs beyond ``keep`` are dropped, never the current one; as the events files are."""
    try:
        files = sorted(
            (p for p in bridge_dir(root).glob("driven-*.log") if p != current),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return
    for old in files[max(keep - 1, 0):]:
        try:
            old.unlink()
        except OSError:
            pass


def _driven_record(root: Path, job_id: object, instance: str | None) -> tuple[Job, dict | None]:
    """The export job ``instance`` holds and its driven record, for a caller under the lock; a refusal otherwise."""
    if not is_job_id(job_id):
        raise BridgeError("that is not a job id", code="not-claimed")
    try:
        job = load_job(root)
    except JobFileDamaged as e:
        raise BridgeError(str(e), code="job-file") from None
    if job is None or job.id != job_id or not job.owned_by(instance):
        raise BridgeError(f"job {job_id} is not this browser's current job", code="not-claimed")
    duplicate = job.duplicate if isinstance(job.duplicate, dict) else {}
    record = duplicate.get("driven")
    return job, record if isinstance(record, dict) else None


def start_driven_import(
    root: Path,
    job_id: object,
    instance: str | None,
    *,
    now=None,
    spawn=None,
    python: str | None = None,
    environ=None,
    platform: str | None = None,
    backup_root: Path | None = None,
) -> Job:
    """Start a finished Duplicate export's import in a window of its own: ``project-move auto --export``.

    The extension asks with the job id alone; the command is built here from
    ``job.json`` (:func:`driven_command`) and started detached
    (:func:`_spawn_detached`), with its output kept in
    ``bridge/driven-<job>.log``. The record of it goes on the export job,
    where the import writes how it ended (:func:`note_driven_end`). Asked
    again while it runs, the same one is the answer and nothing is started
    twice; once it made the copy, it is not started again.
    """
    _ensure_dir(root)
    with _Locked(root):
        when = _at(now)
        job, before = _driven_record(root, job_id, instance)
        if _driven_running(before, when):
            return job
        if before is not None and before.get("exit_code") == 0:
            made = _claude_url(before.get("url"))
            raise BridgeError(f"the copy is already made{': ' + made if made else ''}", code="driven-done")
        argv, line = driven_command(root, job, python=python, platform=platform)
        env = _child_env(root, environ, platform=platform, backup_root=backup_root)
        log = driven_log_path(root, job.id)
        with open(log, "a", encoding="utf-8") as handle:
            handle.write(f"--- {_iso(when)} started by the cswap side panel ---\n")
        _private(log)
        pid = (spawn or _spawn_detached)(argv, cwd=Path(root), env=env, log_path=log, platform=platform)
        earlier = before or {}
        job.duplicate["driven"] = {
            "pid": pid,
            "created": _process_created(pid),
            "started_at": _iso(when),
            "log": str(log),
            "command": line,
            "attempt": int(earlier.get("attempt") or 0) + 1,
            "ended_at": None,
            "exit_code": None,
            "url": "",
            # The project an earlier try stopped in stays named until this
            # one says otherwise: this try carries on in it (--into).
            "carry_on": _claude_url(earlier.get("carry_on")),
            "made": "",
            "message": "",
        }
        _save_unlocked(root, job, when)
    _prune_driven_logs(root, keep=EVENTS_KEEP, current=log)
    return job


def note_driven_link(root: Path, job_id: object, url: str, *, now=None) -> None:
    """Record the project a running driven import just made, the moment its page names it; never raises.

    The record is otherwise written only as the run ends, and a run that is
    killed (its console window closed, its process ended) cannot do that:
    the project it made stays named all the same, as the one to carry on
    in when it is a Claude Code project, so the next start makes nothing
    twice. Only a claude.ai address is kept, and only on a record that has
    not ended.
    """
    try:
        link = _claude_url(url)
        if not is_job_id(job_id) or not link:
            return
        with _Locked(root):
            when = _at(now)
            job = load_job(root)
            duplicate = job.duplicate if job is not None and job.id == job_id and isinstance(job.duplicate, dict) else None
            record = duplicate.get("driven") if duplicate else None
            if not isinstance(record, dict) or record.get("ended_at"):
                return
            record["made"] = link
            if _CODE_PROJECT_URL_RE.match(link):
                record["carry_on"] = link
            _save_unlocked(root, job, when)
    except (OSError, LockError, BridgeError, ValueError) as e:
        _logger.warning("could not record the project the import of job %s made: %s", job_id, e)


def note_driven_end(
    root: Path,
    job_id: object,
    *,
    exit_code: object,
    url: str = "",
    carry_on: str = "",
    made: str = "",
    message: str = "",
    forget_carry_on: bool = False,
    now=None,
) -> None:
    """Record how a driven import ended on its export job; never raises.

    The import's own process calls this as it ends. Only claude.ai addresses
    are kept, and the message is masked and cut. A project an import that
    stopped did not name again stays named, since it still holds what was
    added, unless ``forget_carry_on`` says it is gone (not in view from the
    destination login any more), so the next start makes a new one instead
    of failing on it again. A failure here is logged and nothing more: the
    window said what happened anyway.
    """
    try:
        if not is_job_id(job_id):
            return
        with _Locked(root):
            when = _at(now)
            job = load_job(root)
            duplicate = job.duplicate if job is not None and job.id == job_id and isinstance(job.duplicate, dict) else None
            record = duplicate.get("driven") if duplicate else None
            if not isinstance(record, dict):
                return
            code = exit_code if isinstance(exit_code, int) and not isinstance(exit_code, bool) else None
            kept = "" if code == 0 or forget_carry_on else _claude_url(record.get("carry_on"))
            record.update(
                {
                    "ended_at": _iso(when),
                    "exit_code": code,
                    "url": _claude_url(url),
                    "carry_on": _claude_url(carry_on) or kept,
                    # What this try made, as its end says or, failing that,
                    # as the page named it while it ran.
                    "made": _claude_url(made) or _claude_url(record.get("made")),
                    "message": driven_log_text(str(message or ""))[:500],
                }
            )
            _save_unlocked(root, job, when)
    except (OSError, LockError, BridgeError, ValueError) as e:
        _logger.warning("could not record how the import of job %s ended: %s", job_id, e)


def drop_driven(root: Path, job_id: str | None = None, now=None) -> str:
    """Let go of a driven import that never said how it ended: ``dropped``, ``running`` or ``none``.

    The way past a record that keeps new jobs out (see :func:`_make_room`)
    when its window is gone but its process id names something alive, which
    Windows allows. A process that is verifiably the import's own (its start
    read and matching) is ``running``: closing its window is the person's
    way to stop it.
    """
    try:
        with _Locked(root):
            when = _at(now)
            job = load_job(root)
            duplicate = job.duplicate if job is not None and isinstance(job.duplicate, dict) else None
            record = duplicate.get("driven") if duplicate else None
            if not isinstance(record, dict) or record.get("ended_at") or (job_id and job.id != job_id):
                return "none"
            pid = record.get("pid")
            if _driven_running(record, when) and isinstance(pid, int) and _same_process(record, pid) is True:
                return "running"
            record.update({"ended_at": _iso(when), "exit_code": None, "message": "dropped from the command line"})
            _save_unlocked(root, job, when)
            return "dropped"
    except JobFileDamaged:
        return "none"


def _log_tail(path: Path) -> list[str]:
    """The last lines of a driven import's log, as they may be shown: masked, without query strings, short."""
    try:
        with open(path, "rb") as handle:
            size = handle.seek(0, os.SEEK_END)
            start = max(0, size - DRIVEN_TAIL_BYTES)
            handle.seek(start)
            data = handle.read()
    except OSError:
        return []
    lines = data.decode("utf-8", errors="replace").splitlines()
    if start > 0 and lines:
        lines = lines[1:]  # the read began inside this one
    shown = [driven_log_text(line).rstrip()[:DRIVEN_LINE_CHARS] for line in lines]
    return [line for line in shown if line.strip()][-DRIVEN_TAIL_LINES:]


def driven_state(root: Path, job_id: object, instance: str | None, *, now=None) -> dict:
    """Where the driven import of ``job_id`` stands, for the side panel: running, how it ended, its last lines."""
    with _Locked(root):
        job, record = _driven_record(root, job_id, instance)
    if record is None:
        raise BridgeError(f"job {job.id} has no import in a window of its own", code="not-driven")
    when = _at(now)
    running = _driven_running(record, when)
    tail = _log_tail(driven_log_path(root, job.id))
    code = record.get("exit_code")
    code = code if isinstance(code, int) and not isinstance(code, bool) else None
    url = _claude_url(record.get("url"))
    if not url and code == 0:
        found = next((m.group(1) for m in map(_NEW_PROJECT_RE.search, reversed(tail)) if m), "")
        url = _claude_url(found.rstrip(".,;"))
    pid = record.get("pid")
    return {
        "running": running,
        "lost": not running and not record.get("ended_at"),
        "pid": pid if isinstance(pid, int) and not isinstance(pid, bool) else None,
        "attempt": int(record.get("attempt") or 0),
        "started_at": str(record.get("started_at") or ""),
        "ended_at": str(record.get("ended_at") or ""),
        "exit_code": code,
        "url": url,
        "carry_on": _claude_url(record.get("carry_on")),
        "made": _claude_url(record.get("made")),
        "message": driven_log_text(str(record.get("message") or ""))[:500],
        "command": str(record.get("command") or ""),
        "log": str(driven_log_path(root, job.id)),
        "tail": tail,
    }


def driven_summary(record: object, now: float | None = None) -> str:
    """One line on a driven import for ``cswap bridge status``; '' when there is none."""
    if not isinstance(record, dict):
        return ""
    when = _at(now)
    code = record.get("exit_code")
    if _driven_running(record, when):
        state = f"running (process {record.get('pid')}) since {record.get('started_at')}"
    elif record.get("ended_at") and code == 0:
        state = f"done {_claude_url(record.get('url')) or ''}".rstrip()
    elif record.get("ended_at"):
        carry = _claude_url(record.get("carry_on"))
        state = f"stopped (exit {code if code is not None else '?'})" + (f"; carries on in {carry}" if carry else "")
    else:
        state = "ended without a word"
    log = record.get("log") or ""
    return f"Import in its own window: {state}" + (f"; log: {log}" if log else "")


def _private(path: Path) -> None:
    if sys.platform != "win32":
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


def _prune_events(root: Path, keep: int, current: Path) -> None:
    """Drop the oldest events files beyond ``keep``, never the current job's.

    Age is the file's mtime, which on a coarse file system can tie with
    the file just created; naming the current one keeps it whatever the
    tie breaks to. A file that will not delete is left for next time.
    """
    try:
        files = sorted(
            (p for p in bridge_dir(root).glob("events-*.jsonl") if p != current),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return
    for old in files[max(keep - 1, 0):]:
        try:
            old.unlink()
        except OSError:
            pass


def claim_job(root: Path, job_id: str, instance: str, extension_version: str, now=None) -> Job:
    """Hand the queued job to one browser profile.

    Idempotent for the profile that holds it (a worker restart claims again
    after a reload), refused for any other with the holder named, so two
    profiles never run one import.
    """
    if not isinstance(job_id, str) or not _JOB_ID_RE.match(job_id):
        raise BridgeError("that is not a job id", code="not-queued")
    if not isinstance(instance, str) or not instance.strip():
        raise BridgeError("a claim names the browser instance that makes it", code="bad-instance")
    _ensure_dir(root)
    with _Locked(root):
        job = load_job(root)
        if job is None or job.id != job_id:
            current = job.id if job else "none"
            raise BridgeError(f"job {job_id} is not queued (the current job is {current})", code="not-queued")
        if job.terminal:
            raise BridgeError(f"job {job_id} is already {job.status}", code="not-queued")
        if job.owned_by(instance):
            return job
        if job.status != "queued":
            raise JobClaimedElsewhere(
                f"job {job_id} is held by another browser profile", claimed_by=job.claimed_by
            )
        when = _at(now)
        job.claimed_by = {
            "instance": instance,
            "at": _iso(when),
            "extension_version": str(extension_version or ""),
        }
        job.status = "claimed"
        _save_unlocked(root, job, when)
        return job


def _settle(root: Path, job: Job | None, now) -> Job | None:
    """``job`` as its events say it stands, for a caller that holds the lock.

    The host appends a terminal event and then saves the job file; a host
    that died between the two left the events saying done and the file
    saying running, and nothing would ever change the file again. The
    events are the record the command line prints from, so they win.
    """
    if job is None or not job.active:
        return job
    events, _ = read_events(root, job.id)
    ending = next((event for event in reversed(events) if event.get("event") in TERMINAL_EVENTS), None)
    if ending is None:
        return job
    _logger.warning("job %s had ended (%s) by its events while job.json said %s", job.id, ending["event"], job.status)
    job = update_from_event(job, ending, now=now)
    if job.kind == "export" and job.status == "done":
        _name_unnamed_export(job)
    _save_unlocked(root, job, now)
    return job


def _silent_for(job: Job, now: float) -> float:
    """Seconds since anything touched the job file; a file with no readable time has been silent for ever."""
    last = _from_iso(job.updated_at) or _from_iso(job.created_at)
    return now - last if last is not None else float("inf")


def _abandoned(job: Job, now: float, stale_after: float) -> bool:
    """Whether a job that was asked to stop will never answer.

    A job no browser claimed has nobody to answer for it. A claimed one is
    given ``stale_after`` seconds from the request (or the last ack, each
    of which rewrites the job file) before the browser is taken for gone.
    """
    if not (job.active and job.cancel_requested):
        return False
    return job.claimed_by is None or _silent_for(job, now) >= stale_after


def _abandoned_reason(job: Job, stale_after: float) -> str:
    if job.claimed_by is None:
        return "no browser ever picked the job up"
    return f"the browser that held the job did not answer the stop request for {int(stale_after // 60)} minutes"


def _end_from_here(root: Path, job: Job, reason: str, now, by: str = "cswap") -> Job:
    """End ``job`` as cancelled from outside the browser that holds it, under the caller's lock.

    The event goes first so a ``--watch`` sees the end, then the job file,
    the same order the host keeps. ``by`` names who ended it: the command
    line, or the side panel of another browser (:func:`drop_job`).
    """
    record = _append_unlocked(root, job.id, {"event": "cancelled", "by": by, "reason": reason, "result": None}, now)
    job = update_from_event(job, record, now=now)
    job.cancel_requested = True
    _save_unlocked(root, job, now)
    return job


def _active_message(job: Job, now: float, stale_after: float) -> str:
    """Why a new job is refused, and the way past it."""
    head = (
        f"An import is already queued or running (job {job.id}, {job.status} since "
        f"{job.updated_at or job.created_at})."
    )
    if not job.cancel_requested:
        return head + " Wait for it, or cancel it with `cswap project-move import --cancel`."
    left = max(0.0, stale_after - _silent_for(job, now))
    minutes = max(1, int(-(-left // 60)))
    return head + (
        " It was asked to stop and the browser holding it has not answered yet. If that browser is gone "
        f"for good, run this again in {minutes} minute(s) and the job is dropped."
    )


def request_cancel(
    root: Path,
    job_id: str | None = None,
    now=None,
    *,
    force: bool = False,
    stale_after: float = CANCEL_STALE_SECONDS,
) -> bool:
    """Stop the current job (or ``job_id``); False when there is nothing to stop.

    A job no browser has claimed is ended here and now, with a cancelled
    event, since nobody will ever answer for it. A claimed job is asked to
    stop: the flag rides back on the host's next ack, and the extension
    does the stopping, since only it can reload the tab. When that answer
    never comes (the profile is gone, the extension unloaded) the job is
    dropped after ``stale_after`` seconds of silence, by the next call here
    or the next :func:`new_job`; ``force`` drops a claimed job at once, for
    a person who knows the browser is gone. A job whose events already say
    it ended is settled, not stopped.
    """
    try:
        with _Locked(root):
            when = _at(now)
            job = _settle(root, load_job(root), when)
            if job is None or not job.active or (job_id and job.id != job_id):
                return False
            if job.claimed_by is None or force or _abandoned(job, when, stale_after):
                reason = "stopped from the command line" if force and job.claimed_by is not None else _abandoned_reason(job, stale_after)
                _end_from_here(root, job, reason, when)
                return True
            if not job.cancel_requested:
                job.cancel_requested = True
                _save_unlocked(root, job, when)
            return True
    except JobFileDamaged:
        return False


def drop_job(root: Path, job_id: str, instance: str, now=None) -> Job | None:
    """End the unfinished job ``job_id`` from the side panel of ``instance``, whoever holds it.

    The person's act for a job another browser profile claimed and will
    never answer for: an earlier copy of the extension, say, which a
    reinstall made a new instance of, leaving its job to block every job
    after it until a stop request has gone unanswered for fifteen
    minutes. The job is ended here and now with a cancelled event, as
    ``project-move import --cancel`` ends one no browser claimed, and the
    next job can start; a browser that still runs it hears the end on its
    next event. None, with nothing changed, when there is no such job to
    drop: none at all, another id, or one that already ended.
    """
    if not isinstance(job_id, str) or not _JOB_ID_RE.match(job_id):
        raise BridgeError("that is not a job id", code="not-found")
    if not isinstance(instance, str) or not instance.strip():
        raise BridgeError("a drop names the browser instance that asks for it", code="bad-instance")
    _ensure_dir(root)
    with _Locked(root):
        when = _at(now)
        try:
            job = _settle(root, load_job(root), when)
        except JobFileDamaged:
            # Nothing can be continued from an unreadable job file, and the
            # next new job replaces it (see _make_room): nothing to drop.
            return None
        if job is None or job.id != job_id or not job.active:
            return None
        holder = job.claimed_by.get("instance") if isinstance(job.claimed_by, dict) else None
        reason = (
            "dropped from the side panel of the browser that held it" if holder == instance
            else "dropped from the side panel of another browser" if holder
            else "dropped from the side panel; no browser had picked the job up"
        )
        _logger.warning("Dropping job %s: %s", job.id, reason)
        return _end_from_here(root, job, reason, when, by="extension")


_PROJECT_URL_RE = re.compile(r"/(?:code/)?project/([A-Za-z0-9_-]+)/?(?:[?#]|$)")


def _project_id_of(url: str) -> str:
    """The project id in a claude.ai project url (``/project/<uuid>`` or ``/code/project/<id>``), else ''."""
    match = _PROJECT_URL_RE.search(url or "")
    return match.group(1) if match else ""


_PHASE_STATUS = {
    "preflight": "claimed",
    "choosing": "claimed",
    "loading": "claimed",
    "ready": "claimed",
    "running": "running",
    "held": "held",
    "done": "done",
    "failed": "failed",
    "cancelled": "cancelled",
}


def update_from_event(job: Job, event: dict, now=None) -> Job:
    """A copy of ``job`` with what ``event`` (section 2.5) says applied; pure.

    A finished job stays finished whatever arrives late: the extension's
    event queue can deliver a ``log`` or a ``phase`` after ``done``.
    """
    out = copy.deepcopy(job)
    out.updated_at = _iso(_at(now))
    kind = event.get("event") if isinstance(event, dict) else None
    if not isinstance(kind, str) or out.terminal:
        return out

    def text(key: str, limit: int = 2000) -> str:
        value = event.get(key)
        return value[:limit] if isinstance(value, str) else ""

    def mapping(key: str) -> dict | None:
        value = event.get(key)
        return dict(value) if isinstance(value, dict) else None

    if kind == "claimed":
        if out.status == "queued":
            out.status = "claimed"
        if out.claimed_by is None and text("instance"):
            out.claimed_by = {
                "instance": text("instance"),
                "at": out.updated_at,
                "extension_version": text("extension_version"),
            }
    elif kind == "phase":
        phase = text("phase")
        if phase in _PHASE_STATUS:
            out.phase = phase
            out.status = _PHASE_STATUS[phase]
            if phase == "failed" and not out.error and text("detail"):
                out.error = text("detail", 500)
    elif kind == "status":
        out.last_status = {"text": text("text"), "link": text("link"), "at": out.updated_at}
    elif kind == "account":
        # An import queued for whoever is signed in: the account the page
        # named is the job's from here on; one already named stays.
        if out.account.get("signed_in") is True and not out.account.get("email") and text("email", 200).strip():
            out.account = {**out.account, "email": text("email", 200).strip()}
    elif kind == "interruption":
        out.status = "held"
        out.phase = "held"
        out.last_interruption = {
            "kind": text("kind"),
            "what": text("what"),
            "todo": text("todo"),
            "at": out.updated_at,
        }
    elif kind == "held":
        out.status = "held"
        out.phase = "held"
    elif kind == "resumed":
        out.last_interruption = None
        if out.status == "held":
            out.status = "running"
            out.phase = "running"
    elif kind == "created":
        # The project's id travels as `id`, which the transport also uses
        # for its message id; the url names the project either way.
        out.created_project = {
            "id": text("id") or _project_id_of(text("url")),
            "name": text("name"),
            "url": text("url"),
            "at": out.updated_at,
        }
    elif kind in TERMINAL_EVENTS:
        out.status = kind
        out.phase = kind
        out.result = mapping("result")
        if kind == "failed":
            out.error = text("error", 500) or "the import failed"
        created = (out.result or {}).get("created") if out.result else None
        if isinstance(created, dict) and not out.created_project:
            out.created_project = {
                "id": str(created.get("id") or ""),
                "name": str(created.get("name") or ""),
                "url": str(created.get("url") or ""),
                "at": out.updated_at,
            }
    # wait, released, log, request and anything unknown: the events file
    # keeps them; the job's state does not change.
    return out


def events_path(root: Path, job_id: str) -> Path:
    if not isinstance(job_id, str) or not _JOB_ID_RE.match(job_id):
        raise BridgeError(f"not a job id: {job_id!r}", code="not-queued")
    return bridge_dir(root) / f"events-{job_id}.jsonl"


def append_event(root: Path, job_id: str, event: dict, now=None) -> dict:
    """Append one event line, with ``ts`` and ``job`` filled in when missing; returns the line's dict."""
    if not isinstance(event, dict):
        raise BridgeError("an event is a JSON object")
    events_path(root, job_id)  # refuses a job id that is not one before anything is touched
    _ensure_dir(root)
    with _Locked(root):
        return _append_unlocked(root, job_id, event, now)


def _append_unlocked(root: Path, job_id: str, event: dict, now) -> dict:
    """``append_event`` for a caller that already holds the lock.

    The message's own ``id`` and ``type`` are the transport's, not the
    event's; ``ts`` and ``job`` are kept when the extension sent them and
    filled in when it did not.
    """
    path = events_path(root, job_id)
    record = {"ts": _iso(_at(now)), "job": job_id}
    for key, value in event.items():
        if key in ("id", "type"):
            continue
        if key in ("ts", "job"):
            if isinstance(value, str) and value:
                record[key] = value
        else:
            record[key] = value
    created = not path.exists()
    with open(path, "ab") as f:
        f.write((json.dumps(record, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii"))
        f.flush()
    if created:
        _private(path)
    return record


def read_events(root: Path, job_id: str, start: int = 0) -> tuple[list[dict], int]:
    """The complete lines after byte ``start``, and the offset to continue from.

    A line still being written (no newline yet) is left for the next call;
    a line that is not JSON is skipped. A file shorter than ``start`` was
    started over, so reading starts over too.
    """
    path = events_path(root, job_id)
    try:
        with open(path, "rb") as f:
            size = f.seek(0, os.SEEK_END)
            if start > size or start < 0:
                start = 0
            f.seek(start)
            data = f.read()
    except FileNotFoundError:
        return [], 0
    except OSError:
        return [], start
    end = data.rfind(b"\n")
    if end < 0:
        return [], start
    events: list[dict] = []
    for raw in data[: end + 1].split(b"\n"):
        if not raw.strip():
            continue
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
    return events, start + end + 1


class ImportLock:
    """The one-import-per-machine lock, held by ``cswap project-move import`` for its whole run."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self._lock = FileLock(bridge_dir(self.root) / IMPORT_LOCK, timeout=0)

    def __enter__(self) -> "ImportLock":
        _ensure_dir(self.root)
        if not self._lock.acquire():
            try:
                job = load_job(self.root)
            except JobFileDamaged:
                job = None
            if job is not None and job.active:
                which = f"job {job.id}, started {job.created_at}"
            else:
                which = "another cswap project-move import holds the lock"
            raise BridgeBusy(
                f"An import is already running ({which}). Wait for it, cancel it with "
                "`cswap project-move import --cancel`, or in the cswap side panel."
            )
        return self

    def __exit__(self, *exc) -> bool:
        self._lock.release()
        return False


# ---------------------------------------------------------------------------
# The export, as the page reads it
# ---------------------------------------------------------------------------


_WIN_LONG_PREFIX = "\\\\?\\"


def _long_path(path: str) -> str:
    """``path`` made absolute and, on Windows, past the 260-character limit.

    An export nests folders, and a plain Windows path stops at 260
    characters: a walk would skip the deep folder without a word and an
    open would fail, while project-move's check, which uses this same
    prefix, had found every file. Elsewhere the path is only made absolute.
    """
    full = os.path.abspath(path)
    if sys.platform != "win32" or full.startswith(_WIN_LONG_PREFIX):
        return full
    if full.startswith("\\\\"):
        return _WIN_LONG_PREFIX + "UNC\\" + full[2:]
    return _WIN_LONG_PREFIX + full


def _plain_path(path: str) -> str:
    """``path`` as a person would write it: the Windows long-path prefix taken off again."""
    if path.startswith(_WIN_LONG_PREFIX + "UNC\\"):
        return "\\\\" + path[len(_WIN_LONG_PREFIX) + 4:]
    if path.startswith(_WIN_LONG_PREFIX):
        return path[len(_WIN_LONG_PREFIX):]
    return path


def _listed_paths(raw: object) -> list[str]:
    """Every file ``export.json`` names, in its order: the same rows :func:`pm.read_export` counts."""
    if not isinstance(raw, dict):
        return []
    paths = [row["path"] for key in ("files", "history") for row in pm._rows(raw, key)]
    memory = raw.get("memory")
    if isinstance(memory, dict) and isinstance(memory.get("path"), str):
        paths.append(memory["path"])
    return paths


def _frame_bytes(message: dict) -> int:
    """How many bytes ``message`` takes as a frame body, the same way :func:`encode` writes it."""
    return len(json.dumps(message, separators=(",", ":"), ensure_ascii=True))


def _check_listing_fits(source: "ExportSource") -> None:
    """Refuse an export whose listing would not fit the one frame it is sent in.

    Chrome caps a host frame at :data:`MAX_HOST_MESSAGE`, and the worker
    takes the listing as one reply, so a listing split over several would
    reach the page cut short. An export with that many files goes the
    paste route instead; the count and the size say why.
    """
    size = source.listing_bytes()
    if size > MAX_HOST_MESSAGE:
        raise BridgeError(
            f"The export at {source.path} lists {len(source.list())} files; their listing is {size} bytes, "
            f"over the {MAX_HOST_MESSAGE}-byte frame the bridge can send, so it cannot go through the "
            "extension. Import it with the paste route: `cswap project-move import --clipboard`.",
            code="too-large",
        )


class ExportSource:
    """The files of one export, a folder or a .tar, by the paths ``export.json`` uses.

    The listing is what the page's folder shows the script; a file's bytes
    are read only when the script asks for them, in chunks. Only regular
    files under the export are served: symlinks are skipped, and a path
    that could leave the export (``..``, a drive letter) is never listed, so
    it can never be read. The listing must hold every file ``export.json``
    names, or it is refused as a whole: a page given less would import
    with files missing while the job said the export was whole.
    """

    def __init__(self, export: pm.ExportCheck):
        if export.error:
            raise BridgeError(f"The export at {export.path} cannot be read: {export.error}", code="export-missing")
        self.export = export
        self.path = Path(export.path)
        self.archive = export.archive
        self.root_name = _safe_name(export.name or self.path.stem)
        self._files: list[dict] | None = None
        self._sizes: dict[str, int] = {}
        self._refusal: BridgeError | None = None
        self._tar: tarfile.TarFile | None = None
        self._members: dict[str, tarfile.TarInfo] = {}

    # -- listing ------------------------------------------------------------

    def list(self) -> list[dict]:
        if self._refusal is not None:
            raise self._refusal
        if self._files is None:
            files = self._list_tar() if self.archive is not None else self._list_folder()
            files.sort(key=lambda row: row["path"])
            self._files = files
            self._sizes = {row["path"]: row["bytes"] for row in files}
            try:
                self._check_manifest()
            except BridgeError as e:
                # Nothing is served from a listing that is short: the
                # refusal stands for every later call too.
                self._files, self._sizes, self._refusal = None, {}, e
                raise
        return [dict(row) for row in self._files]

    def listing_reply(self, cancel_requested: bool = False) -> dict:
        """The host's ``export`` reply to the page, without its ``re``."""
        return {
            "type": "export",
            "root": self.root_name,
            "files": self.list(),
            "cancel_requested": cancel_requested,
        }

    def listing_bytes(self) -> int:
        """How many bytes that reply takes as a frame, at its largest (``re`` and the flag at their widest)."""
        return _frame_bytes({"re": 2**31 - 1, **self.listing_reply(cancel_requested=False)})

    def _check_manifest(self) -> None:
        """Refuse a listing that lacks a file ``export.json`` names.

        project-move's check looks each listed file up by its own path;
        the listing is what a walk of the folder or the .tar finds. Where
        the two disagree (a listed file that is a link, or was unreadable
        here) the page would be handed less than the job promised.
        """
        if pm.MANIFEST_NAME not in self._sizes:
            raise BridgeError(
                f"The export at {self.path} has no {pm.MANIFEST_NAME} among its plain files", code="export-missing"
            )
        try:
            with self._open(pm.MANIFEST_NAME) as f:
                raw = json.loads(f.read().decode("utf-8"))
        except (OSError, ValueError, UnicodeDecodeError) as e:
            raise BridgeError(
                f"{pm.MANIFEST_NAME} in the export at {self.path} cannot be read ({e})", code="export-missing"
            ) from None
        missing = [path for path in _listed_paths(raw) if path not in self._sizes]
        if missing:
            shown = ", ".join(missing[:5]) + (f" and {len(missing) - 5} more" if len(missing) > 5 else "")
            raise BridgeError(
                f"The export at {self.path} lists {len(missing)} file(s) the bridge cannot read as plain "
                f"files under it: {shown}",
                code="export-missing",
            )

    def _list_folder(self) -> list[dict]:
        rows: list[dict] = []
        base = _long_path(str(self.path))
        unlisted: list[str] = []

        def note(error: OSError) -> None:
            # os.walk would pass a folder it cannot list over in silence;
            # a folder of the export the page never sees is a refusal.
            where = _plain_path(str(error.filename or base))
            unlisted.append(f"{where} ({error.strerror or error})")

        for dirpath, dirnames, filenames in os.walk(base, onerror=note, followlinks=False):
            # A folder reached through a link is not under the export.
            dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
            below = dirpath[len(base):].strip("\\/").replace(os.sep, "/")
            for filename in filenames:
                full = os.path.join(dirpath, filename)
                try:
                    info = os.lstat(full)
                except OSError:
                    continue
                if not stat.S_ISREG(info.st_mode):
                    continue
                relative = f"{below}/{filename}" if below else filename
                if pm._plain_parts(relative) is None:
                    continue
                rows.append({"path": relative, "bytes": info.st_size})
        if unlisted:
            raise BridgeError(
                f"A folder of the export at {self.path} could not be listed: {'; '.join(unlisted[:3])}",
                code="export-missing",
            )
        return rows

    def _open_tar(self) -> tarfile.TarFile:
        if self._tar is None:
            try:
                self._tar = tarfile.open(self.archive, "r:")
            except (OSError, tarfile.TarError) as e:
                raise BridgeError(f"The .tar at {self.archive} cannot be read ({e})", code="export-missing") from None
        return self._tar

    def _list_tar(self) -> list[dict]:
        tar = self._open_tar()
        try:
            members = tar.getmembers()
        except (tarfile.TarError, EOFError, ValueError) as e:
            raise BridgeError(f"The .tar at {self.archive} is damaged ({e})", code="export-missing") from None
        files = pm._archive_files(members)
        # The export's folder inside, found exactly as project-move finds it.
        tops = [
            name[: -len(pm.MANIFEST_NAME) - 1]
            for name in files
            if name.count("/") == 1 and name.endswith("/" + pm.MANIFEST_NAME)
        ]
        if pm.MANIFEST_NAME in files:
            root = ""
        elif len(tops) == 1:
            root = tops[0] + "/"
        else:
            raise BridgeError(f"The .tar at {self.archive} holds no export", code="export-missing")
        rows: list[dict] = []
        self._members = {}
        for name, member in files.items():
            if not name.startswith(root):
                continue
            relative = name[len(root):]
            if pm._plain_parts(relative) is None or not member.isfile():
                continue
            self._members[relative] = member
            rows.append({"path": relative, "bytes": member.size})
        return rows

    # -- reading ------------------------------------------------------------

    def _open(self, path: str):
        """An open binary file for a listed path; ``ValueError`` for any other."""
        self.list()
        if path not in self._sizes:
            raise ValueError(f"not in the export: {path!r}")
        if self.archive is not None:
            member = self._members[path]
            handle = self._open_tar().extractfile(member)
            if handle is None:
                raise ValueError(f"not a file in the export: {path!r}")
            return handle
        target = self.path.joinpath(*pm._plain_parts(path))
        return open(_long_path(str(target)), "rb")

    def read(self, path: str, offset: int, length: int) -> bytes:
        if offset < 0 or length < 0:
            raise ValueError("offset and length are not negative")
        with self._open(path) as f:
            f.seek(offset)
            return f.read(length)

    def chunks(self, path: str) -> Iterator[tuple[int, bytes, bool]]:
        """``(offset, data, last)`` in CHUNK_BYTES steps; an empty file is one empty last chunk.

        The listed size is what the page was told, so a file that grew since
        is cut at that size, and one that shrank ends early with ``last``.
        """
        self.list()
        if path not in self._sizes:
            raise ValueError(f"not in the export: {path!r}")
        size = self._sizes[path]
        if size == 0:
            yield 0, b"", True
            return
        with self._open(path) as f:
            offset = 0
            while offset < size:
                data = f.read(min(CHUNK_BYTES, size - offset))
                if not data:
                    yield offset, b"", True
                    return
                offset += len(data)
                yield offset - len(data), data, offset >= size

    def close(self) -> None:
        if self._tar is not None:
            try:
                self._tar.close()
            except Exception:
                pass
            self._tar = None

    def __enter__(self) -> "ExportSource":
        return self

    def __exit__(self, *exc) -> bool:
        self.close()
        return False


def _export_check(job: Job) -> pm.ExportCheck:
    """A fresh look at the job's export: it must still be whole when the page asks for it."""
    raw = job.export if isinstance(job.export, dict) else {}
    path_text = raw.get("path")
    if not isinstance(path_text, str) or not path_text:
        raise BridgeError("the job names no export", code="export-missing")
    path = Path(path_text)
    check = pm.read_export_tar(path) if raw.get("archive") else pm.read_export(path)
    if not check.complete:
        why = check.error or "files listed in export.json are missing or have another size"
        raise BridgeError(f"The export at {path} is no longer whole: {why}", code="export-missing")
    return check


# ---------------------------------------------------------------------------
# The host
# ---------------------------------------------------------------------------


class BridgeHost:
    """One connection's worth of the native messaging host.

    ``handle`` is the protocol of section 2.12 as a pure dispatch: a message
    in, replies out, never an exception (a refusal is an error reply). The
    state is in the files; the only things remembered here are the hello's
    instance id and an open export, so a worker that restarts and
    reconnects finds the same job in the same place.
    """

    def __init__(
        self,
        root: Path,
        stdin: BinaryIO,
        stdout: BinaryIO,
        *,
        origin: str,
        now: Callable[[], float] | None = None,
        log: logging.Logger | None = None,
    ):
        self.root = Path(root)
        self.stdin = stdin
        self.stdout = stdout
        self.origin = origin
        self.now = now or time.time
        self.log = log or logging.getLogger("claude-swap.bridge")
        self.instance: str | None = None
        self.stop = False
        self._source: ExportSource | None = None
        self._source_job: str | None = None

    # -- the loop -------------------------------------------------------------

    def serve(self) -> int:
        """Read frames until end of file, answer each; 0 at EOF, 1 on a broken frame or a refused hello."""
        try:
            while not self.stop:
                try:
                    msg = read_message(self.stdin)
                except BridgeProtocolError as e:
                    self.log.error("broken frame from the extension: %s", e)
                    return 1
                if msg is None:
                    self.log.info("the extension closed the port")
                    return 0
                for reply in self.handle(msg):
                    self.log.debug("out: %s", json.dumps(redact_for_log(reply), ensure_ascii=True))
                    try:
                        write_message(self.stdout, reply)
                    except BridgeProtocolError as e:
                        write_message(self.stdout, self._error(reply.get("re"), e.code, str(e)))
                        break
                    except OSError as e:
                        self.log.error("stdout closed: %s", e)
                        return 0
            return 1
        finally:
            self._close_source()

    # -- dispatch ---------------------------------------------------------------

    def handle(self, msg: dict) -> Iterable[dict]:
        """The replies to ``msg``: a list, or for ``file.read`` a lazy stream of chunks.

        Every reply carries ``re``. Nothing raises: a :class:`BridgeError`
        becomes an error reply with its code, anything else ``internal``.
        """
        msg_id = msg.get("id") if isinstance(msg, dict) else None
        if isinstance(msg_id, bool) or not isinstance(msg_id, int):
            msg_id = None
        self.log.debug("in: %s", json.dumps(redact_for_log(msg), ensure_ascii=True))
        kind = msg.get("type") if isinstance(msg, dict) else None
        try:
            if msg_id is None:
                raise BridgeError("every message carries an integer id", code="bad-id")
            if kind == "hello":
                replies = [self._hello(msg)]
            elif self.instance is None:
                raise BridgeError("say hello first", code="no-hello")
            elif kind == "job.get":
                replies = [self._job_get()]
            elif kind == "job.claim":
                replies = [self._job_claim(msg)]
            elif kind == "job.drop":
                replies = [self._job_drop(msg)]
            elif kind == "export.list":
                replies = [self._export_list(msg)]
            elif kind == "file.read":
                return self._stream(msg_id, self._file_read(msg))
            elif kind == "script.get":
                replies = [self._script_get(msg)]
            elif kind == "event":
                replies = [self._event(msg)]
            elif kind == "accounts.list":
                replies = [self._accounts_list()]
            elif kind == "exports.list":
                replies = [self._exports_list()]
            elif kind == "export.new":
                replies = [self._export_new(msg)]
            elif kind == "export.choose":
                replies = [self._export_choose(msg)]
            elif kind == "file.write":
                replies = [self._file_write(msg)]
            elif kind == "import.queue":
                replies = [self._import_queue(msg)]
            elif kind == "import.driven":
                replies = [self._import_driven(msg)]
            elif kind == "import.driven.state":
                replies = [self._import_driven_state(msg)]
            else:
                raise BridgeError(f"unknown message type {kind!r}", code="unknown-type")
        except BridgeError as e:
            replies = [self._error(msg_id, e.code, str(e), **e.details)]
        except Exception as e:  # the host answers, whatever went wrong
            self.log.exception("unhandled error on %s", kind)
            replies = [self._error(msg_id, "internal", f"{type(e).__name__}: {e}")]
        for reply in replies:
            reply.setdefault("re", msg_id)
        return replies

    def _stream(self, msg_id: int, parts: Iterator[dict]) -> Iterator[dict]:
        """Chunks one by one, so a large file never sits in memory whole; a failure mid-way is an error reply."""
        try:
            for part in parts:
                part.setdefault("re", msg_id)
                yield part
        except BridgeError as e:
            yield self._error(msg_id, e.code, str(e), **e.details)
        except ValueError as e:
            yield self._error(msg_id, "not-found", str(e))
        except Exception as e:
            self.log.exception("unhandled error while streaming a file")
            yield self._error(msg_id, "internal", f"{type(e).__name__}: {e}")

    def _error(self, msg_id, code: str, message: str, **details) -> dict:
        reply = {"re": msg_id, "type": "error", "code": code, "message": message}
        for key, value in details.items():
            if key not in reply:
                reply[key] = value
        self.log.warning("refused %s: %s", code, message)
        return reply

    # -- handlers ------------------------------------------------------------------

    def _hello(self, msg: dict) -> dict:
        protocol = msg.get("protocol")
        if protocol != PROTOCOL:
            # A protocol the host does not speak: say so once, then go, so
            # the extension's hint ("update cswap or the extension") stands
            # and nothing is served to a mismatched partner.
            self.stop = True
            raise BridgeError(
                f"this bridge speaks protocol {PROTOCOL}, the extension protocol {protocol!r}",
                code="protocol",
                product=PRODUCT,
                protocol=PROTOCOL,
            )
        extension = msg.get("extension") if isinstance(msg.get("extension"), dict) else {}
        instance = extension.get("instance")
        self.instance = instance if isinstance(instance, str) and instance.strip() else "anonymous"
        self.log.info(
            "hello from extension %s (instance %s, Chrome %s, userScripts %s)",
            extension.get("version"), self.instance, msg.get("chrome"), msg.get("userScripts"),
        )
        return {
            "type": "hello",
            "protocol": PROTOCOL,
            "product": PRODUCT,
            "cswap": _cswap_version(),
            "capabilities": list(CAPABILITIES),
            "backup_dir": str(self.root),
        }

    def _job_reply(self, job: Job | None) -> dict:
        return {
            "type": "job",
            "job": job.to_dict() if job else None,
            "cancel_requested": bool(job and job.cancel_requested),
        }

    def _job_get(self) -> dict:
        return self._job_reply(load_job(self.root))

    def _job_claim(self, msg: dict) -> dict:
        instance = msg.get("instance")
        if isinstance(instance, str) and instance.strip() and instance != self.instance:
            raise BridgeError("the claim names another instance than the hello did", code="bad-instance")
        job = claim_job(
            self.root, msg.get("job"), self.instance, str(msg.get("extension_version") or ""), now=self.now
        )
        self.log.info("job %s claimed by %s", job.id, self.instance)
        return self._job_reply(job)

    def _job_drop(self, msg: dict) -> dict:
        """The side panel drops a job, whoever holds it (see :func:`drop_job`): the job as it then stands, and whether it was dropped now."""
        dropped = drop_job(self.root, msg.get("job"), self.instance, now=self.now)
        if dropped is not None:
            self.log.info("job %s dropped by %s", dropped.id, self.instance)
            return {**self._job_reply(dropped), "dropped": True}
        try:
            current = load_job(self.root)
        except JobFileDamaged:
            current = None
        return {**self._job_reply(current), "dropped": False}

    def _served_job(self, msg: dict) -> Job:
        """The job this instance holds and may be served files for; a refusal otherwise."""
        job_id = msg.get("job")
        if not isinstance(job_id, str) or not _JOB_ID_RE.match(job_id):
            raise BridgeError("that is not a job id", code="not-claimed")
        job = load_job(self.root)
        if job is None or job.id != job_id:
            raise BridgeError(f"job {job_id} is not the current job", code="not-claimed")
        if job.status not in SERVED_STATUSES or not job.owned_by(self.instance):
            raise BridgeError(f"job {job_id} is not claimed by this browser", code="not-claimed")
        return job

    def _source_for(self, job: Job) -> ExportSource:
        if self._source is None or self._source_job != job.id:
            self._close_source()
            self._source = ExportSource(_export_check(job))
            self._source_job = job.id
        return self._source

    def _close_source(self) -> None:
        if self._source is not None:
            self._source.close()
        self._source = None
        self._source_job = None

    def _export_list(self, msg: dict) -> dict:
        job = self._served_job(msg)
        source = self._source_for(job)
        # new_job refused a listing that does not fit; the check runs again
        # for a job queued by an older cswap, so the refusal names the
        # listing rather than a frame that could not be written.
        _check_listing_fits(source)
        reply = source.listing_reply(cancel_requested=job.cancel_requested)
        self.log.info("export listed for job %s: %d files", job.id, len(reply["files"]))
        return reply

    def _file_read(self, msg: dict) -> Iterator[dict]:
        job = self._served_job(msg)
        path = msg.get("path")
        if not isinstance(path, str) or not path:
            raise BridgeError("file.read names a path", code="not-found")
        source = self._source_for(job)
        try:
            chunks = source.chunks(path)
            first = next(chunks)
        except ValueError:
            raise BridgeError(f"not in the export: {path}", code="not-found") from None
        self.log.debug("file.read %s for job %s", path, job.id)
        for offset, data, last in _chain(first, chunks):
            yield {
                "type": "file.chunk",
                "path": path,
                "offset": offset,
                "data": base64.b64encode(data).decode("ascii"),
                "last": last,
                "cancel_requested": job.cancel_requested,
            }

    def _script_get(self, msg: dict) -> dict:
        job = self._served_job(msg)
        stage = "export" if job.kind == "export" else "import"
        text = pm.script_text(stage)
        sha = script_sha256(text)
        wanted = job.script.get("sha256") if isinstance(job.script, dict) else None
        if isinstance(wanted, str) and wanted and wanted != sha:
            again = "start the Duplicate again" if stage == "export" else "run cswap project-move import again"
            raise BridgeError(
                f"the {stage} script changed since the job was queued (cswap was updated?); {again}",
                code="script-changed",
            )
        return {
            "type": "script",
            "text": text,
            "sha256": sha,
            "bytes": len(text.encode("utf-8")),
            "cswap_version": _cswap_version(),
            "cancel_requested": job.cancel_requested,
        }

    def _event(self, msg: dict) -> dict:
        """Append the event and apply it to the job; the ack carries the cancel flag back."""
        body = {key: value for key, value in msg.items() if key not in ("id", "type")}
        job_id = body.get("job")
        with _Locked(self.root):
            try:
                job = load_job(self.root)
            except JobFileDamaged as e:
                raise BridgeError(str(e), code="job-file") from None
            if not isinstance(job_id, str) or not job_id:
                if job is None:
                    raise BridgeError("the event names no job and none is queued", code="not-claimed")
                job_id = job.id
            if not _JOB_ID_RE.match(job_id):
                raise BridgeError("that is not a job id", code="not-claimed")
            mine = job is not None and job.id == job_id and job.owned_by(self.instance)
            if not mine:
                raise BridgeError(f"job {job_id} is not claimed by this browser", code="not-claimed")
            # The extension redacts before it sends; the same rules run here
            # once more, so a secret that slipped past one side never
            # reaches the events file the command line prints from.
            record = _append_unlocked(self.root, job_id, redact_for_log(body), self.now)
            updated = update_from_event(job, record, now=self.now)
            if updated.kind == "export" and updated.status == "done" and not job.terminal:
                _name_unnamed_export(updated)
            _save_unlocked(self.root, updated, self.now)
            # An import the panel queued (a Duplicate's, or one chosen from
            # the exports on disk) ends the move's import stage here; one
            # the command line queued is followed by the command line.
            panels = bool(updated.duplicate) or updated.account.get("signed_in") is True
            if updated.status == "done" and not job.terminal and updated.kind == "import" and panels:
                _note_imported(self.root)
        level = logging.WARNING if record.get("event") in ("interruption", "failed", "log") else logging.INFO
        self.log.log(level, "event %s", json.dumps(redact_for_log(record), ensure_ascii=True))
        return {"type": "ack", "cancel_requested": updated.cancel_requested}

    # -- Duplicate ---------------------------------------------------------------

    def _accounts_list(self) -> dict:
        accounts = list_accounts(self.root)
        self.log.info("accounts listed: %d", len(accounts))
        return {"type": "accounts", "accounts": accounts}

    def _export_new(self, msg: dict) -> dict:
        job = new_export_job(
            self.root,
            instance=self.instance or "",
            extension_version=str(msg.get("extension_version") or ""),
            now=self.now,
        )
        self.log.info("export job %s started by %s into %s", job.id, self.instance, job.export.get("folder"))
        return self._job_reply(job)

    def _export_choose(self, msg: dict) -> dict:
        job = choose_export(
            self.root,
            msg.get("job"),
            self.instance,
            project=msg.get("project"),
            destination=msg.get("destination"),
            name=msg.get("name"),
            source=msg.get("source"),
            now=self.now,
        )
        chosen = job.duplicate or {}
        project = chosen.get("project") or {}
        destination = chosen.get("destination") or {}
        self.log.info(
            "job %s exports %s (%s) for %s", job.id, project.get("id"), project.get("kind"),
            f"Account-{destination.get('slot')}" if destination else "whichever account is signed in at Import",
        )
        return self._job_reply(job)

    def _file_write(self, msg: dict) -> dict:
        written = write_export_file(
            self.root,
            msg.get("job"),
            self.instance,
            path=msg.get("path"),
            offset=msg.get("offset"),
            data=msg.get("data"),
            last=msg.get("last") is True,
            now=self.now,
        )
        self.log.debug("file.write %s at %s for job %s", written["path"], msg.get("offset"), msg.get("job"))
        return {"type": "written", **written}

    def _exports_list(self) -> dict:
        listing = list_exports(self.root)
        self.log.info("exports listed: %d in %s", len(listing["exports"]), listing["folder"])
        return {"type": "exports", **listing}

    def _import_queue(self, msg: dict) -> dict:
        signed_in = msg.get("signed_in") is True
        if msg.get("job") is None and msg.get("export_path") is not None:
            # An export chosen from the list on disk: the import goes into
            # whichever account is signed in, as every import the panel queues.
            job = queue_import_of_export(self.root, msg.get("export_path"), self.instance, now=self.now, name=msg.get("name"))
            self.log.info("import job %s queued from the export at %s into whichever account is signed in", job.id, job.export.get("path"))
            return self._job_reply(job)
        job = queue_duplicate_import(
            self.root, msg.get("job"), self.instance, now=self.now,
            destination=msg.get("destination"), name=msg.get("name"), signed_in=signed_in,
        )
        self.log.info(
            "import job %s queued from export job %s%s", job.id, msg.get("job"),
            " into whichever account is signed in" if signed_in else "",
        )
        return self._job_reply(job)

    # Only the job id is read from these two messages: what runs is the
    # host's own command, built from job.json (see driven_command).

    def _import_driven(self, msg: dict) -> dict:
        job = start_driven_import(self.root, msg.get("job"), self.instance, now=self.now)
        state = driven_state(self.root, job.id, self.instance, now=self.now)
        self.log.info("job %s: its import runs in its own window, process %s", job.id, state.get("pid"))
        return {"type": "driven", "driven": state}

    def _import_driven_state(self, msg: dict) -> dict:
        return {"type": "driven", "driven": driven_state(self.root, msg.get("job"), self.instance, now=self.now)}


def _chain(first, rest):
    yield first
    yield from rest


def host_manifest_path(root: Path) -> Path:
    return bridge_dir(root) / f"{HOST_NAME}.json"


def _read_host_manifest(root: Path) -> dict | None:
    try:
        raw = json.loads(host_manifest_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


def _root_from_argv(argv: list[str]) -> Path | None:
    """The ``--root <dir>`` (or ``--root=<dir>``) the launcher pins; None when it pins none."""
    for i, arg in enumerate(argv):
        if not isinstance(arg, str):
            continue
        if arg == "--root" and i + 1 < len(argv) and isinstance(argv[i + 1], str) and argv[i + 1]:
            return Path(argv[i + 1])
        if arg.startswith("--root=") and len(arg) > len("--root="):
            return Path(arg[len("--root="):])
    return None


def serve(argv: list[str], root: Path | None = None, stdin=None, stdout=None, stderr=None) -> int:
    """The entry point of ``cswap bridge``: ``argv`` is what follows ``bridge`` on the command line.

    The launcher ``install`` wrote passes ``--root <backup dir>`` first,
    then Chrome's own arguments: the extension's origin
    (``chrome-extension://<id>/``) and, on Windows, ``--parent-window=N``.
    The pinned root is used ahead of working one out from this process's
    environment, which is Chrome's and not the shell's. The origin must be
    the one the host manifest allows, or the host leaves with code 2 and
    one line on stderr, before reading a byte: a host that answers any
    caller would hand the export to any extension. Nothing is ever printed
    to stdout; it is the protocol.
    """
    if root is None:
        root = _root_from_argv(argv)
    root = Path(root) if root is not None else paths.get_backup_root()
    err = stderr if stderr is not None else sys.stderr
    origin = next((arg for arg in argv if isinstance(arg, str) and arg.startswith(_ORIGIN_PREFIX)), "")
    manifest = _read_host_manifest(root)
    if manifest is None:
        print(
            f"cswap bridge: no host manifest at {host_manifest_path(root)}; run `cswap bridge install --register`.",
            file=err,
        )
        return 2
    allowed = manifest.get("allowed_origins")
    allowed = [o for o in allowed if isinstance(o, str)] if isinstance(allowed, list) else []
    if not origin or origin not in allowed:
        print(
            f"cswap bridge: origin {origin or '(none)'!r} is not one this host serves; "
            "run `cswap bridge install --register` for the extension you loaded.",
            file=err,
        )
        return 2

    if stdin is None:
        stdin = sys.stdin.buffer
        _binary_stdio(sys.stdin)
    if stdout is None:
        stdout = sys.stdout.buffer
        _binary_stdio(sys.stdout)
    log = host_logger(root)
    log.info("bridge started for %s", origin)
    host = BridgeHost(root, stdin, stdout, origin=origin, log=log)
    try:
        code = host.serve()
    except Exception:
        log.exception("the bridge host stopped")
        return 1
    log.info("bridge exiting with %d", code)
    return code


def _binary_stdio(stream) -> None:
    """Windows translates ``\\n`` on text streams; the frames are bytes."""
    if sys.platform != "win32":
        return
    try:
        import msvcrt

        msvcrt.setmode(stream.fileno(), os.O_BINARY)
    except (ImportError, OSError, ValueError, AttributeError):
        pass


# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------


@dataclass
class Registration:
    """One browser's registration of the host: where it is, what it holds, what was done."""

    browser: str
    kind: str  # "registry" (Windows HKCU) or "file" (a manifest copy)
    location: str  # the registry key, or the file
    value: str  # the host manifest path the registration points at
    present: bool = False  # something is registered there
    done: bool = False  # this call registered or unregistered it
    detail: str = ""
    command: str = ""  # how to do it by hand

    @property
    def points_here(self) -> bool:
        return self.present and self.detail.startswith("points at this manifest")


# Per browser and platform: the HKCU subkey, or the folder under the home
# directory, where Chrome-family browsers look for a host manifest.
BROWSERS: dict[str, dict[str, str]] = {
    "chrome": {
        "win32": r"Software\Google\Chrome\NativeMessagingHosts",
        "darwin": "Library/Application Support/Google/Chrome/NativeMessagingHosts",
        "linux": ".config/google-chrome/NativeMessagingHosts",
    },
    "chromium": {
        "win32": r"Software\Chromium\NativeMessagingHosts",
        "darwin": "Library/Application Support/Chromium/NativeMessagingHosts",
        "linux": ".config/chromium/NativeMessagingHosts",
    },
    "edge": {
        "win32": r"Software\Microsoft\Edge\NativeMessagingHosts",
        "darwin": "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
        "linux": ".config/microsoft-edge/NativeMessagingHosts",
    },
    "brave": {
        "win32": r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
        "darwin": "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
        "linux": ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    },
}


def _plat(platform: str | None) -> str:
    value = platform or sys.platform
    if value == "win32" or value == "darwin":
        return value
    return "linux"


def _home(home) -> Path:
    return Path(home) if home is not None else Path.home()


def launcher_path(root: Path, platform: str | None = None) -> Path:
    name = "cswap-bridge.cmd" if _plat(platform) == "win32" else "cswap-bridge.sh"
    return bridge_dir(root) / name


def code_dir() -> str:
    """The folder that holds this ``claude_swap`` package: site-packages, or a checkout's ``src``."""
    return str(Path(__file__).resolve().parents[1])


def launcher_text(
    python: str, platform: str | None = None, root: Path | str | None = None, code: Path | str | None = None
) -> str:
    """What the launcher holds: this interpreter, ``-m claude_swap bridge --root <backup dir>``, Chrome's arguments passed on.

    The backup directory is pinned in the launcher because the host runs
    with Chrome's environment, not the shell's: an ``XDG_DATA_HOME`` set in
    a shell rc file would send a host that worked it out for itself to
    another directory than the one ``install`` wrote the manifest to, where
    it would find nothing and leave. Without ``root`` (an older launcher)
    the host falls back to working it out.

    ``code`` is pinned for the same reason: the interpreter alone may not
    find ``claude_swap`` (a checkout run through a ``PYTHONPATH`` launcher
    puts it nowhere the interpreter looks), and then Chrome's host dies with
    "No module named claude_swap" and the extension sees no bridge. The
    launcher puts that folder first on ``PYTHONPATH``, so the host runs the
    same code that installed it. Without ``code`` (an older launcher) the
    interpreter is on its own.
    """
    pinned = f' --root "{os.path.abspath(str(root))}"' if root is not None else ""
    where = os.path.abspath(str(code)) if code is not None else ""
    if _plat(platform) == "win32":
        path_line = (
            f'if defined PYTHONPATH (set "PYTHONPATH={where};%PYTHONPATH%") else (set "PYTHONPATH={where}")\r\n'
            if where
            else ""
        )
        return f'@echo off\r\n{path_line}"{python}" -m claude_swap bridge{pinned} %*\r\n'
    path_line = f'PYTHONPATH="{where}${{PYTHONPATH:+:$PYTHONPATH}}"\nexport PYTHONPATH\n' if where else ""
    return f'#!/bin/sh\n{path_line}exec "{python}" -m claude_swap bridge{pinned} "$@"\n'


def write_launcher(
    root: Path, python: str = sys.executable, platform: str | None = None, code: Path | str | None = None
) -> Path:
    """Write the launcher Chrome starts. Bytes, so the ``.cmd`` keeps its CRLF on every platform."""
    if not python:
        raise BridgeError("no Python interpreter to put in the launcher")
    _ensure_dir(root)
    path = launcher_path(root, platform)
    path.write_bytes(launcher_text(python, platform, root, code).encode("utf-8"))
    if _plat(platform) != "win32" and sys.platform != "win32":
        os.chmod(path, 0o755)
    return path


def _launcher_line(root: Path, platform: str | None) -> str:
    try:
        return launcher_path(root, platform).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def launcher_python(root: Path, platform: str | None = None) -> str | None:
    """The interpreter the launcher names, or None when there is no launcher."""
    match = re.search(r'"([^"]+)" -m claude_swap bridge', _launcher_line(root, platform))
    return match.group(1) if match else None


def launcher_root(root: Path, platform: str | None = None) -> str | None:
    """The backup directory the launcher pins, or None when it pins none (no launcher, or an older one)."""
    match = re.search(r' -m claude_swap bridge --root "([^"]+)"', _launcher_line(root, platform))
    return match.group(1) if match else None


def launcher_code(root: Path, platform: str | None = None) -> str | None:
    """The folder of cswap's code the launcher puts on PYTHONPATH, or None when it names none."""
    # Windows: set "PYTHONPATH=<folder>;%PYTHONPATH%"; sh: PYTHONPATH="<folder>${PYTHONPATH:+:$PYTHONPATH}".
    match = re.search(r'PYTHONPATH="?([^"$;%]+)', _launcher_line(root, platform))
    return match.group(1) if match else None


def _same_dir(a: str, b: str) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def host_manifest(root: Path, launcher: Path, extension_id: str) -> dict:
    if not _EXTENSION_ID_RE.match(extension_id or ""):
        raise BridgeError(f"not a Chrome extension id: {extension_id!r} (32 letters a to p)")
    return {
        "name": HOST_NAME,
        "description": "cswap project-move: hands an export and the import script to the cswap extension",
        "path": str(launcher),
        "type": "stdio",
        "allowed_origins": [f"{_ORIGIN_PREFIX}{extension_id}/"],
    }


def _browser_names(browsers) -> list[str]:
    names = list(browsers) if browsers else ["chrome"]
    unknown = [name for name in names if name not in BROWSERS]
    if unknown:
        raise BridgeError(f"unknown browser {', '.join(unknown)}; one of {', '.join(BROWSERS)}")
    return names


def _registration(root: Path, browser: str, platform: str | None, home) -> Registration:
    manifest = str(host_manifest_path(root))
    plat = _plat(platform)
    if plat == "win32":
        subkey = f"{BROWSERS[browser]['win32']}\\{HOST_NAME}"
        return Registration(
            browser=browser,
            kind="registry",
            location=f"HKCU\\{subkey}",
            value=manifest,
            command=f'reg add "HKCU\\{subkey}" /ve /t REG_SZ /d "{manifest}" /f',
        )
    folder = _home(home) / BROWSERS[browser][plat]
    target = folder / f"{HOST_NAME}.json"
    return Registration(
        browser=browser,
        kind="file",
        location=str(target),
        value=manifest,
        command=f'mkdir -p "{folder}" && cp "{manifest}" "{target}"',
    )


_WINREG_NEEDS = ("HKEY_CURRENT_USER", "REG_SZ", "CreateKey", "SetValueEx", "QueryValue", "DeleteKey", "CloseKey")


def _winreg(winreg):
    """The registry API to use: the injected one, else the real module; None when neither can serve."""
    api = winreg
    if api is None:
        try:
            import winreg as api  # type: ignore[no-redef]
        except ImportError:
            return None
    return api if all(hasattr(api, name) for name in _WINREG_NEEDS) else None


def _inspect(reg: Registration, winreg, root: Path) -> None:
    """Fill ``present`` and ``detail`` from what is registered now; reads only."""
    expected = os.path.normcase(str(host_manifest_path(root)))
    if reg.kind == "registry":
        api = _winreg(winreg)
        if api is None:
            reg.present, reg.detail = False, "the registry is not reachable from here"
            return
        subkey = reg.location[len("HKCU\\"):]
        try:
            value = api.QueryValue(api.HKEY_CURRENT_USER, subkey)
        except OSError:
            reg.present, reg.detail = False, "not registered"
            return
        reg.present = True
        reg.detail = (
            "points at this manifest" if os.path.normcase(str(value)) == expected else f"points at {value}"
        )
        return
    target = Path(reg.location)
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except FileNotFoundError:
        reg.present, reg.detail = False, "not registered"
        return
    except (OSError, ValueError):
        reg.present, reg.detail = True, "the registered manifest is not readable"
        return
    reg.present = True
    ours = _read_host_manifest(root)
    same = isinstance(raw, dict) and ours is not None and raw.get("path") == ours.get("path") and raw.get(
        "allowed_origins"
    ) == ours.get("allowed_origins")
    if same:
        reg.detail = "points at this manifest (a copy)"
    else:
        reg.detail = f"holds another manifest (path {raw.get('path') if isinstance(raw, dict) else '?'})"


def plan(
    root: Path,
    *,
    browsers=("chrome",),
    extension_id: str | None = None,
    platform: str | None = None,
    home=None,
) -> list[Registration]:
    """What ``install --register`` would do, per browser; nothing is performed or read."""
    names = _browser_names(browsers)
    if extension_id is not None and not _EXTENSION_ID_RE.match(extension_id):
        raise BridgeError(f"not a Chrome extension id: {extension_id!r} (32 letters a to p)")
    return [_registration(root, name, platform, home) for name in names]


def install(
    root: Path,
    *,
    register: bool,
    browsers=("chrome",),
    extension_id: str | None = None,
    python: str = sys.executable,
    platform: str | None = None,
    home=None,
    winreg=None,
    code: Path | str | None = None,
) -> list[Registration]:
    """Write the launcher and the host manifest; with ``register``, tell each browser about them.

    Without ``register`` the returned plan carries the exact command for
    each browser, for a person who would rather see what touches their
    registry or their config folder before it happens. The launcher names
    this cswap's code (``code``, by default where this package is) so the
    host Chrome starts runs the same code whatever its environment.
    """
    ext_id = extension_id or default_extension_id()
    _ensure_dir(root)
    launcher = write_launcher(root, python, platform, code_dir() if code is None else code)
    atomic_write_json(host_manifest_path(root), host_manifest(root, launcher, ext_id))
    regs = plan(root, browsers=browsers, extension_id=ext_id, platform=platform, home=home)
    if not register:
        return regs
    for reg in regs:
        if reg.kind == "registry":
            api = _winreg(winreg)
            if api is None:
                reg.detail = "the registry is not reachable from here; run the command by hand"
                continue
            subkey = reg.location[len("HKCU\\"):]
            key = api.CreateKey(api.HKEY_CURRENT_USER, subkey)
            try:
                api.SetValueEx(key, "", 0, api.REG_SZ, reg.value)
            finally:
                api.CloseKey(key)
        else:
            target = Path(reg.location)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(
                json.dumps(host_manifest(root, launcher, ext_id), indent=2) + "\n", encoding="utf-8"
            )
        reg.done = True
        reg.present = True
        reg.detail = "points at this manifest" + (" (a copy)" if reg.kind == "file" else "")
    return regs


def uninstall(
    root: Path,
    *,
    register: bool,
    browsers=("chrome",),
    platform: str | None = None,
    home=None,
    winreg=None,
) -> list[Registration]:
    """Remove the registrations (with ``register``), then the manifest and the launcher."""
    regs = plan(root, browsers=browsers, platform=platform, home=home)
    if register:
        for reg in regs:
            if reg.kind == "registry":
                api = _winreg(winreg)
                if api is None:
                    reg.detail = "the registry is not reachable from here"
                    continue
                subkey = reg.location[len("HKCU\\"):]
                try:
                    api.DeleteKey(api.HKEY_CURRENT_USER, subkey)
                except OSError:
                    reg.detail = "was not registered"
                    continue
            else:
                try:
                    Path(reg.location).unlink()
                except FileNotFoundError:
                    reg.detail = "was not registered"
                    continue
            reg.done = True
            reg.present = False
            reg.detail = "removed"
    for path in (host_manifest_path(root), launcher_path(root, platform)):
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    return regs


@dataclass
class BridgeStatus:
    manifest_ok: bool
    launcher_ok: bool
    python_ok: bool
    extension_id: str
    extension_dir: Path | None
    registrations: list[Registration]
    job: Job | None
    problems: list[str] = field(default_factory=list)
    root_ok: bool = True  # the launcher pins this backup directory
    code_ok: bool = True  # the launcher names a folder that holds claude_swap

    @property
    def installed(self) -> bool:
        return (
            self.manifest_ok
            and self.launcher_ok
            and self.python_ok
            and self.root_ok
            and self.code_ok
            and any(reg.points_here for reg in self.registrations)
        )


def status(
    root: Path,
    *,
    browsers=("chrome",),
    platform: str | None = None,
    home=None,
    winreg=None,
) -> BridgeStatus:
    """Everything ``cswap bridge status`` shows; reads only, never raises for a missing piece."""
    problems: list[str] = []
    directory = extension_dir()
    try:
        ext_id = default_extension_id()
    except BridgeNotInstalled as e:
        ext_id = ""
        problems.append(str(e))

    manifest = _read_host_manifest(root)
    launcher = launcher_path(root, platform)
    manifest_ok = False
    if manifest is None:
        problems.append(f"no host manifest at {host_manifest_path(root)}")
    else:
        origins = manifest.get("allowed_origins")
        origins = [o for o in origins if isinstance(o, str)] if isinstance(origins, list) else []
        manifest_ok = (
            manifest.get("name") == HOST_NAME
            and manifest.get("type") == "stdio"
            and manifest.get("path") == str(launcher)
            and bool(origins)
        )
        if not manifest_ok:
            problems.append("the host manifest is not the one this cswap writes; run `cswap bridge install`")
        elif ext_id and f"{_ORIGIN_PREFIX}{ext_id}/" not in origins:
            problems.append(
                f"the host manifest allows {', '.join(origins)}, not the packaged extension "
                f"({ext_id}); run `cswap bridge install --register` again"
            )

    launcher_ok = launcher.is_file()
    if not launcher_ok:
        problems.append(f"no launcher at {launcher}")
    python = launcher_python(root, platform)
    python_ok = bool(python) and Path(python).is_file()
    if launcher_ok and not python_ok:
        problems.append(
            f"the launcher names a Python that is not there ({python}); run `cswap bridge install --register` again"
        )
    pinned = launcher_root(root, platform)
    root_ok = launcher_ok and pinned is not None and _same_dir(pinned, str(root))
    if launcher_ok and not root_ok:
        which = f"it names {pinned}" if pinned else "it was written by an older cswap"
        problems.append(
            f"the launcher does not name this backup directory ({which}), so the host Chrome starts would "
            "look for the manifest elsewhere; run `cswap bridge install --register` again"
        )
    code = launcher_code(root, platform)
    code_ok = launcher_ok and code is not None and (Path(code) / "claude_swap" / "__init__.py").is_file()
    if launcher_ok and not code_ok:
        which = f"{code} holds no claude_swap" if code else "it was written by an older cswap"
        problems.append(
            f"the launcher does not name where cswap's code is ({which}), so the host Chrome starts may find "
            "no claude_swap and the extension no bridge; run `cswap bridge install --register` again"
        )

    regs = []
    try:
        regs = plan(root, browsers=browsers, platform=platform, home=home)
    except BridgeError as e:
        problems.append(str(e))
    for reg in regs:
        _inspect(reg, winreg, root)
    if regs and not any(reg.points_here for reg in regs):
        problems.append("no browser is registered for this host; run `cswap bridge install --register`")

    job = None
    try:
        job = load_job(root)
    except JobFileDamaged as e:
        problems.append(str(e))
    if job is not None and job.active and job.cancel_requested and job.claimed_by is not None:
        # Read-only here: new_job and request_cancel are what drop it.
        problems.append(
            f"job {job.id} was asked to stop at {job.updated_at} and the browser holding it has not answered; "
            f"if that browser is gone, the next `cswap project-move import` after "
            f"{int(CANCEL_STALE_SECONDS // 60)} minutes of silence drops it"
        )

    return BridgeStatus(
        manifest_ok=manifest_ok,
        launcher_ok=launcher_ok,
        python_ok=python_ok,
        extension_id=ext_id,
        extension_dir=directory,
        registrations=regs,
        job=job,
        problems=problems,
        root_ok=root_ok,
        code_ok=code_ok,
    )


def is_installed(root: Path, *, browsers=("chrome",), platform: str | None = None, home=None, winreg=None) -> bool:
    """Whether ``cswap project-move import`` can go through the extension here."""
    try:
        return status(root, browsers=browsers, platform=platform, home=home, winreg=winreg).installed
    except Exception:
        return False


# ---------------------------------------------------------------------------
# The command-line side of an import
# ---------------------------------------------------------------------------


@dataclass
class ImportOutcome:
    """How an import ended, as ``cswap project-move import`` reports it."""

    status: str  # done | failed | cancelled | queued | detached
    link: str = ""
    name: str = ""
    summary: str = ""
    rows: list[dict] = field(default_factory=list)
    paused: bool = False
    message: str = ""
    job_id: str = ""


def follow_events(
    root: Path,
    job_id: str,
    *,
    poll: float = 0.5,
    sleep=time.sleep,
    clock=time.monotonic,
    stop=lambda: False,
    timeout: float | None = None,
) -> Iterator[dict]:
    """Yield the job's events as they land, until a terminal one, ``stop()`` says so, or ``timeout`` passes."""
    offset = 0
    started = clock()
    while True:
        events, offset = read_events(root, job_id, offset)
        for event in events:
            yield event
            if event.get("event") in TERMINAL_EVENTS:
                return
        if stop():
            return
        if timeout is not None and clock() - started >= timeout:
            return
        sleep(poll)


_WAIT_REASONS = {
    "retry-after": "the site asked to slow down",
    "script-backoff": "the script is backing off after an error",
    "spacing": "minimum spacing",
    "paused": "paused from the side panel",
    "held": "held for you in the side panel",
    "interrupted": "stopped until you press Resume",
}

_PHASE_LINES = {
    "preflight": "Checking the claude.ai tab and who is signed in...",
    "loading": "Loading the export and the import script into the tab...",
    "ready": "The import script is ready; pressing its button.",
    "running": "Importing...",
    "held": "Held: waiting for you in the cswap side panel.",
}

_EXPORT_PHASE_LINES = {
    "preflight": "Checking the claude.ai tab and who is signed in...",
    "choosing": "Naming the project the tab shows...",
    "loading": "Loading the export script into the tab...",
    "ready": "The export script is ready; pressing its button.",
    "running": "Exporting...",
    "held": "Held: waiting for you in the cswap side panel.",
}


def _phase_line(phase: str, kind: str) -> str | None:
    return (_EXPORT_PHASE_LINES if kind == "export" else _PHASE_LINES).get(phase)

PICKUP_HINT = (
    "Nothing has picked the job up yet. The three one-time steps, if not done:\n"
    "  1. Load the extension unpacked from extension/ in chrome://extensions (Developer mode).\n"
    "  2. On its card, turn on \"Allow User Scripts\".\n"
    "  3. Run `cswap bridge install --register`.\n"
    "Then open https://claude.ai signed in as the destination account, or open the cswap side panel."
)


def _outcome_from(kind: str, event: dict, job_id: str, flow: str = "import") -> ImportOutcome:
    result = event.get("result") if isinstance(event.get("result"), dict) else {}
    created = result.get("created") if isinstance(result.get("created"), dict) else {}
    raw_rows = result.get("rows")
    rows = [row for row in raw_rows if isinstance(row, dict)] if isinstance(raw_rows, list) else []
    link = str(result.get("link") or created.get("url") or "")
    summary = str(result.get("status") or "")
    if kind == "done":
        message = summary or f"The {flow} finished."
    elif kind == "failed":
        message = str(event.get("error") or summary or f"The {flow} failed.")
    else:
        message = f"The {flow} was cancelled." + (f" The project created so far is at {link}." if link else "")
    return ImportOutcome(
        status=kind,
        link=link,
        name=str(created.get("name") or ""),
        summary=summary,
        rows=rows,
        paused=result.get("paused") is True,
        message=message,
        job_id=job_id,
    )


def run_import(
    root: Path,
    job: Job,
    *,
    say=print,
    sleep=time.sleep,
    clock=time.monotonic,
    pickup_timeout: float = 60.0,
    wait: bool = True,
) -> ImportOutcome:
    """Follow ``job`` to its end, printing what the extension reports.

    Ctrl-C leaves the job running in the browser (the extension does not
    need this process) and says how to come back (``--watch``) or stop it
    (``--cancel``). ``wait=False`` returns as soon as the job is queued.
    """
    from claude_swap import printer

    if not wait:
        return ImportOutcome(status="queued", job_id=job.id, message=f"Job {job.id} is queued.")

    started = clock()
    picked_up = False
    hinted = False
    last_phase = ""
    last_status = ""

    def stop() -> bool:
        nonlocal hinted
        if not picked_up and not hinted and clock() - started >= pickup_timeout:
            hinted = True
            say(PICKUP_HINT)
        return False

    try:
        for event in follow_events(root, job.id, sleep=sleep, clock=clock, stop=stop):
            kind = event.get("event")
            if kind == "claimed":
                picked_up = True
                say(
                    f"Chrome picked the job up (extension {event.get('extension_version') or '?'}, "
                    f"Chrome {event.get('chrome') or '?'})."
                )
            elif kind == "phase":
                phase = str(event.get("phase") or "")
                line = _phase_line(phase, job.kind)
                if line and phase != last_phase:
                    say(line)
                last_phase = phase
            elif kind == "status":
                text = str(event.get("text") or "")
                if text and text != last_status:
                    say(f"  {text}")
                    last_status = text
            elif kind == "wait":
                if event.get("state") == "start" and event.get("reason") != "spacing":
                    seconds = event.get("seconds")
                    reason = str(event.get("reason") or "")
                    why = _WAIT_REASONS.get(reason, reason)
                    if reason == "retry-after" and isinstance(seconds, (int, float)):
                        why = f"the site said Retry-After {int(seconds)}"
                    head = f"Waiting {int(seconds)} s" if isinstance(seconds, (int, float)) else "Waiting"
                    say(f"{head}: {why}")
            elif kind == "held":
                step = " ".join(str(event.get(key) or "") for key in ("method", "path")).strip()
                say(
                    printer.yellowed(
                        f"Held{f' at {step}' if step else ''} (HTTP {event.get('status') or 0}, "
                        f"attempt {event.get('attempt') or 0}, {event.get('reason') or 'held'}). "
                        "Press Resume (which sends it again) or Skip this step in the cswap side panel."
                    )
                )
            elif kind == "interruption":
                say(printer.yellowed(f"Stopped: {event.get('what') or event.get('kind') or 'interrupted'}"))
                if event.get("todo"):
                    say(printer.yellowed(f"  {event['todo']}"))
            elif kind == "resumed":
                after = event.get("after_seconds")
                say(f"Resumed{f' after {int(after)} s' if isinstance(after, (int, float)) else ''}.")
            elif kind == "account":
                say(f"Importing into {event.get('email') or 'the account signed in'}, the account signed in on the page.")
            elif kind == "created":
                say(f"Created \"{event.get('name') or ''}\": {event.get('url') or ''}")
            elif kind == "log":
                level = str(event.get("level") or "info")
                if level in ("warn", "error"):
                    say(f"  [{level}] {event.get('msg') or ''}")
            elif kind in TERMINAL_EVENTS:
                outcome = _outcome_from(kind, event, job.id, flow=job.kind)
                if kind == "done":
                    say(outcome.message)
                    if outcome.link:
                        say(f"The new project is at {outcome.link}")
                elif kind == "failed":
                    say(printer.yellowed(f"{job.kind.capitalize()} failed: {outcome.message}"))
                    if outcome.link:
                        say(f"The project created before that is at {outcome.link}")
                else:
                    say(outcome.message)
                return outcome
    except KeyboardInterrupt:
        say("")
        say(
            f"Detached; the import goes on in the browser. Reattach with `cswap project-move import --watch`, "
            f"or stop it with `cswap project-move import --cancel` (job {job.id})."
        )
        return ImportOutcome(status="detached", job_id=job.id, message="detached")
    return ImportOutcome(status="detached", job_id=job.id, message="the events ended without an outcome")
