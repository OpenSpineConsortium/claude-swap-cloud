"""The public wheel: bytecode in place of every module, the minified extension, no source."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_public_wheel.py"


def load_script():
    spec = importlib.util.spec_from_file_location("build_public_wheel", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def script():
    return load_script()


DIST_INFO = "fakepkg-1.2.3.dist-info/"
WHEEL_META = "Wheel-Version: 1.0\nGenerator: hatchling 1.27.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
MEMBERS = {
    "fakepkg/__init__.py": b'"""A package."""\nfrom fakepkg.mod import answer\n',
    "fakepkg/mod.py": b"def answer():\n    return 42\n",
    "fakepkg/extension/manifest.json": b'{"name": "x", "key": "abc"}\n',
    "fakepkg/extension/README.md": b"# design notes\n",
    "fakepkg/extension/src/background.js": b"// the readable worker\nconst a = 1;\n\nexport { a };\n",
    "fakepkg/extension/sidepanel.html": b"<!DOCTYPE html>\n<html>\n<body>panel</body>\n</html>\n",
    "fakepkg/extension/icons/16.png": b"\x89PNG\r\n\x1a\n",
    DIST_INFO + "METADATA": b"Metadata-Version: 2.3\nName: fakepkg\nVersion: 1.2.3\n",
    DIST_INFO + "WHEEL": WHEEL_META.encode(),
    DIST_INFO + "entry_points.txt": b"[console_scripts]\nfake = fakepkg.mod:answer\n",
}
MINIFIED = {
    "manifest.json": b'{"name": "x"}\n',
    "src/background.js": b"const a=1;export{a};\n",
    "sidepanel.html": b"<!DOCTYPE html><html><body>panel</body></html>\n",
    "icons/16.png": b"\x89PNG\r\n\x1a\n",
    "PRIVACY.md": b"# policy\n",
}


def write_zip(path: Path, members: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w") as z:
        for name, data in members.items():
            z.writestr(name, data)
        if DIST_INFO + "WHEEL" in members:
            z.writestr(DIST_INFO + "RECORD", "fakepkg-1.2.3.dist-info/RECORD,,\n")
    return path


@pytest.fixture
def plain_wheel(tmp_path):
    return write_zip(tmp_path / "fakepkg-1.2.3-py3-none-any.whl", MEMBERS)


@pytest.fixture
def store_zip(tmp_path):
    return write_zip(tmp_path / "fake-1.0-chrome.zip", MINIFIED)


def names_of(wheel: Path) -> list[str]:
    with zipfile.ZipFile(wheel) as z:
        return sorted(z.namelist())


def test_every_module_becomes_bytecode_in_its_place(script, plain_wheel, store_zip, tmp_path):
    out = script.convert(plain_wheel, tmp_path / "out", package="fakepkg", extension_zip=store_zip)
    tag = script.python_tag()
    assert out.name == f"fakepkg-1.2.3-{tag}-none-any.whl"
    names = names_of(out)
    assert not [n for n in names if n.endswith(".py")]
    assert "fakepkg/__init__.pyc" in names and "fakepkg/mod.pyc" in names
    assert not any("__pycache__" in n for n in names)
    with zipfile.ZipFile(out) as z:
        assert z.read("fakepkg/extension/src/background.js") == MINIFIED["src/background.js"]
        assert z.read("fakepkg/extension/sidepanel.html") == MINIFIED["sidepanel.html"]
        assert z.read("fakepkg/extension/manifest.json") == MEMBERS["fakepkg/extension/manifest.json"], "the manifest with its key stays the wheel's own"
        assert z.read(DIST_INFO + "WHEEL").decode() == WHEEL_META.replace("py3-none-any", f"{tag}-none-any")
        assert z.read(DIST_INFO + "entry_points.txt") == MEMBERS[DIST_INFO + "entry_points.txt"]
    assert "fakepkg/extension/README.md" not in names
    assert script.check(out, "fakepkg") == []


def test_the_record_names_every_member_with_its_hash(script, plain_wheel, store_zip, tmp_path):
    out = script.convert(plain_wheel, tmp_path / "out", package="fakepkg", extension_zip=store_zip)
    with zipfile.ZipFile(out) as z:
        record = z.read(DIST_INFO + "RECORD").decode().splitlines()
        listed = {}
        for line in record:
            name, digest, size = line.rsplit(",", 2)
            listed[name] = (digest, size)
        assert set(listed) == set(z.namelist())
        for name in z.namelist():
            if name == DIST_INFO + "RECORD":
                assert listed[name] == ("", "")
                continue
            data = z.read(name)
            expected = "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
            assert listed[name] == (expected, str(len(data))), name


def test_without_the_store_package_the_extension_code_is_left_out(script, plain_wheel, tmp_path):
    out = script.convert(plain_wheel, tmp_path / "out", package="fakepkg")
    names = names_of(out)
    assert "fakepkg/extension/manifest.json" in names and "fakepkg/extension/icons/16.png" in names
    assert "fakepkg/extension/src/background.js" not in names
    assert "fakepkg/extension/sidepanel.html" not in names
    assert script.check(out, "fakepkg") == []


def test_the_compiled_package_imports_and_runs(script, plain_wheel, store_zip, tmp_path):
    out = script.convert(plain_wheel, tmp_path / "out", package="fakepkg", extension_zip=store_zip)
    site = tmp_path / "site"
    with zipfile.ZipFile(out) as z:
        z.extractall(site)
    assert not list(site.rglob("*.py"))
    result = subprocess.run(
        [sys.executable, "-I", "-c", f"import sys; sys.path.insert(0, {str(site)!r}); import fakepkg; print(fakepkg.answer())"],
        capture_output=True, text=True, check=True,
    )
    assert result.stdout.strip() == "42"


def test_the_same_input_gives_the_same_bytes(script, plain_wheel, store_zip, tmp_path):
    a = script.convert(plain_wheel, tmp_path / "a", package="fakepkg", extension_zip=store_zip).read_bytes()
    b = script.convert(plain_wheel, tmp_path / "b", package="fakepkg", extension_zip=store_zip).read_bytes()
    assert a == b


def test_a_wheel_with_the_browser_scripts_is_never_built(script, tmp_path, store_zip):
    # The export and import logic moves into cswap before anything is
    # published (greg, 2026-10-07); until then the real wheel is refused.
    with_scripts = write_zip(tmp_path / "fakepkg-1.2.3-py3-none-any.whl", {
        **MEMBERS,
        "fakepkg/browser/project-import.js": b"console.log('import');\n",
        "fakepkg/browser/automation.js": b"console.log('auto');\n",
    })
    with pytest.raises(SystemExit, match="still carries the browser scripts.*automation.js.*project-import.js"):
        script.convert(with_scripts, tmp_path / "out", package="fakepkg", extension_zip=store_zip)
    assert not (tmp_path / "out").exists()


def test_check_refuses_source_and_readable_code(script, tmp_path):
    bad = write_zip(tmp_path / "fakepkg-1.2.3-cp313-none-any.whl", {
        "fakepkg/__init__.pyc": b"\x00" * 16,
        "fakepkg/left.py": b"x = 1\n",
        "fakepkg/browser/project-export.js": b"console.log('export');\n",
        "fakepkg/extension/src/background.js": MEMBERS["fakepkg/extension/src/background.js"],
        DIST_INFO + "WHEEL": WHEEL_META.replace("py3-none-any", "cp313-none-any").encode(),
    })
    problems = script.check(bad, "fakepkg")
    assert any("left.py is source" in p for p in problems)
    assert any("background.js is not minified" in p for p in problems)
    assert any("project-export.js is a browser script" in p for p in problems)
    plain = write_zip(tmp_path / "fakepkg-1.2.3-py3-none-any.whl", MEMBERS)
    assert any("not tagged for one Python version" in p for p in script.check(plain, "fakepkg"))


def test_a_zip_that_is_not_the_store_package_is_refused(script, plain_wheel, tmp_path):
    not_store = write_zip(tmp_path / "other.zip", {"README.md": b"x\n"})
    with pytest.raises(SystemExit, match="holds no src"):
        script.convert(plain_wheel, tmp_path / "out", package="fakepkg", extension_zip=not_store)


def test_the_command_line_builds_and_checks(script, plain_wheel, store_zip, tmp_path, capsys):
    assert script.main([str(plain_wheel), "--out", str(tmp_path / "out"), "--extension-zip", str(store_zip), "--package", "fakepkg"]) == 0
    built = next((tmp_path / "out").glob("*.whl"))
    assert script.main([str(built), "--check", "--package", "fakepkg"]) == 0
    assert "ok" in capsys.readouterr().out
