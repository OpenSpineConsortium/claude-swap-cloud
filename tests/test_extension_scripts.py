"""The Chrome extension's own suites, run under Node, and the facts Python and JS share.

extension/ runs in Chrome, so its tests are JavaScript (tests/js/extension/,
node:test). This file runs them from pytest, and holds the two languages to
the same literals: every file loadable in the browser is plain ASCII, the
copies page.js and content.js carry equal protocol.js, and the extension id
cswap registers is the one pinned by the packaged manifest and written in
the extension's README.

The suites are skipped where Node 24 is not installed; the text checks run
everywhere.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from claude_swap import bridge

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
JS = Path(__file__).parent / "js"
BROWSER = ROOT / "src" / "claude_swap" / "browser"
MIN_NODE = 24
SUITES = sorted(path.name for path in (JS / "extension").glob("*.test.js"))
KIT = ROOT / "release-kit" / "tests"
KIT_SUITES = sorted(path.name for path in KIT.glob("*.test.js"))


def _node() -> str | None:
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


@pytest.mark.skipif(NODE is None, reason=f"needs Node {MIN_NODE} or newer on the PATH")
@pytest.mark.parametrize("suite", SUITES)
def test_extension_suite_passes(suite):
    # One suite per test, by name: Node 24 takes files, not a bare folder,
    # and separate runs let pytest-xdist spread them out.
    result = subprocess.run(
        [NODE, "--test", str(JS / "extension" / suite)],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=900,
        cwd=ROOT,
    )
    said = f"exit code {result.returncode}\n{result.stdout[-6000:]}\n{result.stderr[-6000:]}"
    assert result.returncode == 0, said
    assert re.search(r"\bfail 0\b", result.stdout), said


@pytest.mark.skipif(NODE is None, reason=f"needs Node {MIN_NODE} or newer on the PATH")
@pytest.mark.parametrize("suite", KIT_SUITES)
def test_release_kit_suite_passes(suite):
    # The Chrome Web Store release kit (release-kit/), whose scripts the
    # release workflow runs; its suites live beside it so the folder can
    # move to a repository of its own.
    result = subprocess.run(
        [NODE, "--test", str(KIT / suite)],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=900,
        cwd=ROOT,
    )
    said = f"exit code {result.returncode}\n{result.stdout[-6000:]}\n{result.stderr[-6000:]}"
    assert result.returncode == 0, said
    assert re.search(r"\bfail 0\b", result.stdout), said


def test_there_are_suites_to_run():
    assert {"gate.test.js", "interrupt.test.js", "config.test.js", "log.test.js", "integration.test.js", "release.test.js"} <= set(SUITES)
    assert {"lib.test.js", "package.test.js", "stamp.test.js", "publish.test.js", "kit.test.js"} <= set(KIT_SUITES)


# --- what the browser loads is plain ASCII --------------------------------------------


def _loadable() -> list[Path]:
    files = [p for p in EXT.rglob("*") if p.suffix in (".js", ".html", ".json")]
    files += [p for p in BROWSER.rglob("*") if p.suffix in (".js", ".html", ".json")]
    return sorted(files)


def test_every_loadable_file_is_plain_ascii():
    assert _loadable(), "the extension and the browser scripts are on disk"
    for path in _loadable():
        data = path.read_bytes()
        bad = [i for i, byte in enumerate(data) if byte > 0x7F]
        assert not bad, f"{path.relative_to(ROOT)} has a non-ASCII byte at offset {bad[0]}"


def test_extension_package_is_a_plain_module_package():
    assert json.loads((EXT / "package.json").read_text(encoding="ascii")) == {"type": "module", "private": True}


# --- the literal copies in the classic scripts equal protocol.js ----------------------


def _strings_of(source: str, name: str) -> list[str]:
    """The string items of the array literal assigned to ``name`` in ``source``."""
    match = re.search(rf"\b{re.escape(name)}\s*=\s*(?:Object\.freeze\()?\[(.*?)\]\)?;", source, re.DOTALL)
    assert match, f"{name} is not an array literal in the source"
    return re.findall(r"'([^']*)'", match.group(1))


def _numbers_of(source: str, name: str) -> list[int]:
    match = re.search(rf"\b{re.escape(name)}\s*=\s*(?:Object\.freeze\()?\[(.*?)\]\)?;", source, re.DOTALL)
    assert match, f"{name} is not an array literal in the source"
    return [int(n) for n in re.findall(r"\d+", match.group(1))]


def _string_of(source: str, name: str) -> str:
    match = re.search(rf"\b{re.escape(name)}\s*=\s*'([^']*)';", source)
    assert match, f"{name} is not a string literal in the source"
    return match.group(1)


@pytest.fixture(scope="module")
def sources() -> dict[str, str]:
    return {
        name: (EXT / "src" / f"{name}.js").read_text(encoding="ascii")
        for name in ("protocol", "page", "content")
    }


def test_page_js_copies_equal_protocol_js(sources):
    for name in ("BODY_MARKERS", "HEADER_ALLOWLIST", "ACCOUNT_ENDPOINTS"):
        assert _strings_of(sources["page"], name) == _strings_of(sources["protocol"], name), name
    assert _string_of(sources["page"], "IMPORTER_ID") == _string_of(sources["protocol"], "IMPORTER_ID")
    assert _string_of(sources["page"], "EXPORTER_ID") == _string_of(sources["protocol"], "EXPORTER_ID")


def test_content_js_copies_equal_protocol_js(sources):
    assert _strings_of(sources["content"], "PAGE_MARKER_SELECTORS") == _strings_of(
        sources["protocol"], "PAGE_MARKER_SELECTORS"
    )
    assert _numbers_of(sources["content"], "RECONNECT_BACKOFF_MS") == _numbers_of(
        sources["protocol"], "RECONNECT_BACKOFF_MS"
    )
    assert _string_of(sources["content"], "IMPORTER_ID") == _string_of(sources["protocol"], "IMPORTER_ID")
    assert _string_of(sources["content"], "EXPORTER_ID") == _string_of(sources["protocol"], "EXPORTER_ID")


# --- the scripts the extension carries are cswap's own --------------------------------


@pytest.mark.parametrize("stage", ["import", "export"])
def test_the_extension_carries_cswaps_script_byte_for_byte(stage):
    # The extension runs its own copy, from its package; the console paste
    # and project-move auto hand out cswap's. Both are one script.
    ours = (EXT / "src" / f"project-{stage}.js").read_bytes()
    assert ours == (BROWSER / f"project-{stage}.js").read_bytes(), (
        f"extension/src/project-{stage}.js differs from src/claude_swap/browser/project-{stage}.js: copy it over"
    )


def test_the_markers_the_design_relies_on_are_all_there(sources):
    markers = _strings_of(sources["protocol"], "BODY_MARKERS")
    for needed in ("cf_chl_opt", "/cdn-cgi/challenge-platform/", "error code: 1020", "error code: 1015", "turnstile"):
        assert needed in markers
    assert _strings_of(sources["protocol"], "HEADER_ALLOWLIST") == [
        "retry-after", "content-type", "content-length", "cf-mitigated", "cf-ray",
        "server", "server-timing", "location", "date",
    ]


def test_page_js_never_mentions_cookies(sources):
    assert "cookie" not in sources["page"].lower()
    assert "cookie" not in sources["content"].lower()


# --- the manifest and the id cswap registers ------------------------------------------


@pytest.fixture(scope="module")
def manifest() -> dict:
    return json.loads((EXT / "manifest.json").read_text(encoding="ascii"))


def test_manifest_asks_for_exactly_the_agreed_permissions(manifest):
    assert manifest["manifest_version"] == 3
    assert sorted(manifest["permissions"]) == sorted(
        ["nativeMessaging", "scripting", "storage", "sidePanel", "alarms", "notifications"]
    )
    assert manifest["host_permissions"] == ["https://claude.ai/*"]
    assert manifest["background"] == {"service_worker": "src/background.js", "type": "module"}
    assert manifest["minimum_chrome_version"] == "135"
    for path in ("src/background.js", "src/content.js", "src/project-import.js", "src/project-export.js", "sidepanel.html", "icons/128.png"):
        assert (EXT / path).is_file(), path


def test_the_packaged_extension_id_is_pinned_and_documented(manifest):
    ext_id = bridge.default_extension_id()
    assert re.fullmatch(r"[a-p]{32}", ext_id)
    assert ext_id == bridge.extension_id_from_key(manifest["key"])
    assert ext_id in (EXT / "README.md").read_text(encoding="ascii")
    assert bridge.extension_dir() == EXT
