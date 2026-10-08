"""Turn the plain wheel into the public one: bytecode only, no source.

The repository is private, and what the public installs from PyPI must
carry no `.py` file. This script takes the wheel hatchling builds (`uv build
--wheel`) and writes the wheel that is published instead: every Python
module compiled to a `.pyc` that sits where the module was (the legacy
place, the only one the import system reads when there is no source),
the extension's readable scripts replaced by the minified files of the
store package when `--extension-zip` names it (or dropped), the dist-info
stamped with the Python tag the bytecode is for, and the RECORD rebuilt.
It compiles with the interpreter that runs it, so the publish workflow
runs it once per Python version and gets one wheel per version; pip and
uv pick the one that matches.

The export and import scripts (`claude_swap/browser/project-*.js`, the
logic that runs in a claude.ai tab) travel in the store package too, since
the extension runs only what it carries (greg chose on 2026-10-07 to
publish them), so the wheel takes them minified from there as well; a
wheel whose scripts are still readable is refused. What stays readable, by
design: the manifest and the icons of the extension, `browser/automation.js`
(which drives cswap's own Chrome window and has no minified copy), the
Textual stylesheet, and the metadata. The `.pyc` files are hash based and
the zip's timestamps fixed, so the same input gives the same bytes.

Standard library only, like the rest of the package.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import os
import py_compile
import re
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

# The members of the extension folder that are the extension's code: the
# store package carries them minified, and the public wheel takes those.
EXTENSION_CODE = re.compile(r"^(src/[a-z-]+\.js|sidepanel\.html)$")
# The export and import scripts cswap hands out for the console: the same
# files as the extension's src/project-*.js, so the public wheel takes the
# store package's minified copies for them too.
BROWSER_SCRIPT = re.compile(r"^browser/(project-(?:import|export)\.js)$")
# Fixed timestamp for every member (1980-01-01, the earliest a zip holds),
# so the wheel's bytes depend on its contents alone.
ZIP_TIME = (1980, 1, 1, 0, 0, 0)


def python_tag() -> str:
    return f"cp{sys.version_info.major}{sys.version_info.minor}"


def compile_module(source: bytes, relative: str) -> bytes:
    """The hash-based `.pyc` of one module, as bytes; `relative` is the path a traceback shows."""
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "m.py"
        out = Path(tmp) / "m.pyc"
        src.write_bytes(source)
        py_compile.compile(
            str(src),
            cfile=str(out),
            dfile=relative,
            doraise=True,
            invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,
        )
        return out.read_bytes()


def minified_extension(zip_path: Path) -> dict[str, bytes]:
    """The extension's code files from the store package, keyed like the wheel keys them (`src/x.js`)."""
    out: dict[str, bytes] = {}
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            if EXTENSION_CODE.match(name):
                out[name] = z.read(name)
    if not any(k.startswith("src/") for k in out):
        raise SystemExit(f"{zip_path} holds no src/*.js; is it the store package?")
    return out


def looks_minified(data: bytes) -> bool:
    """A few long lines, as esbuild writes them (a template literal keeps its own line breaks); source is many short ones."""
    lines = data.splitlines()
    return len(lines) <= 3 or len(data) / len(lines) >= 200


def record_line(name: str, data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode("ascii")
    return f"{name},sha256={digest},{len(data)}"


def convert(
    wheel: Path,
    out_dir: Path,
    *,
    package: str = "claude_swap",
    extension_zip: Path | None = None,
    tag: str | None = None,
) -> Path:
    """Write the public wheel beside `out_dir` and return its path."""
    tag = tag or python_tag()
    minified = minified_extension(extension_zip) if extension_zip else None
    prefix = f"{package}/"
    ext_prefix = f"{package}/extension/"
    members: list[tuple[str, bytes]] = []
    dist_info = ""
    with zipfile.ZipFile(wheel) as z:
        names = z.namelist()
        for name in names:
            if name.endswith(".dist-info/WHEEL"):
                dist_info = name[: -len("WHEEL")]
        if not dist_info:
            raise SystemExit(f"{wheel} has no .dist-info/WHEEL")
        if not any(n.startswith(prefix) for n in names):
            raise SystemExit(f"{wheel} holds no {package}/")
        for name in names:
            data = z.read(name)
            if name == dist_info + "RECORD":
                continue  # rebuilt at the end
            if name == dist_info + "WHEEL":
                text = data.decode("utf-8")
                if "Tag: py3-none-any" not in text:
                    raise SystemExit(f"{name} is not a pure py3-none-any wheel:\n{text}")
                data = text.replace("Tag: py3-none-any", f"Tag: {tag}-none-any").encode("utf-8")
            elif name.startswith(prefix) and name.endswith(".py"):
                members.append((name[:-3] + ".pyc", compile_module(data, name)))
                continue
            elif name.startswith(prefix) and BROWSER_SCRIPT.match(name[len(prefix):]):
                script = "src/" + BROWSER_SCRIPT.match(name[len(prefix):]).group(1)
                if minified is not None:
                    if script not in minified:
                        raise SystemExit(f"the store package has no {script} to stand for {name}")
                    data = minified[script]
            elif name.startswith(ext_prefix):
                inner = name[len(ext_prefix):]
                if inner == "README.md":
                    continue  # the extension's design notes are not for the public wheel
                if EXTENSION_CODE.match(inner):
                    if minified is None or inner not in minified:
                        continue  # no store package named: the readable code stays out
                    data = minified[inner]
            members.append((name, data))
    if minified is not None:
        kept = {n[len(ext_prefix):] for n, _ in members if n.startswith(ext_prefix)}
        missing = sorted(k for k in minified if k not in kept)
        if missing:
            raise SystemExit(f"the store package has {', '.join(missing)} but the wheel had no such file to replace")
    leftover = [n for n, _ in members if n.endswith(".py")]
    if leftover:
        raise SystemExit(f"source left in the wheel: {', '.join(leftover)}")

    record = "\n".join(record_line(n, d) for n, d in members) + f"\n{dist_info}RECORD,,\n"
    members.append((dist_info + "RECORD", record.encode("utf-8")))

    m = re.match(r"^(.+)-py3-none-any\.whl$", wheel.name)
    if not m:
        raise SystemExit(f"{wheel.name} is not named like a pure wheel")
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{m.group(1)}-{tag}-none-any.whl"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in members:
            info = zipfile.ZipInfo(name, date_time=ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o644 << 16)
            z.writestr(info, data)
    out.write_bytes(buffer.getvalue())
    return out


def check(wheel: Path, package: str = "claude_swap") -> list[str]:
    """What is wrong with a public wheel, or nothing: no source, bytecode in place, a Python tag."""
    problems = []
    with zipfile.ZipFile(wheel) as z:
        names = z.namelist()
        for name in names:
            if name.endswith(".py"):
                problems.append(f"{name} is source")
            if name.startswith(f"{package}/") and BROWSER_SCRIPT.match(name[len(package) + 1:]) and not looks_minified(z.read(name)):
                problems.append(f"{name} is not minified")
        if not any(n.startswith(f"{package}/") and n.endswith(".pyc") for n in names):
            problems.append(f"no {package}/*.pyc")
        if f"{package}/__init__.pyc" not in names:
            problems.append(f"no {package}/__init__.pyc")
        wheel_meta = [n for n in names if n.endswith(".dist-info/WHEEL")]
        if not wheel_meta or not re.search(r"^Tag: cp3\d+-none-any$", z.read(wheel_meta[0]).decode("utf-8"), re.M):
            problems.append("the WHEEL file does not carry a cp3XX-none-any tag")
        for name in names:
            if name.startswith(f"{package}/extension/src/") and not looks_minified(z.read(name)):
                problems.append(f"{name} is not minified")
    if not re.search(r"-cp3\d+-none-any\.whl$", wheel.name):
        problems.append(f"{wheel.name} is not tagged for one Python version")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("wheel", type=Path, help="the plain wheel uv build wrote (...-py3-none-any.whl)")
    parser.add_argument("--out", type=Path, default=Path("dist/public"), help="where the public wheel goes")
    parser.add_argument("--extension-zip", type=Path, help="the store package whose minified files the wheel carries")
    parser.add_argument("--package", default="claude_swap", help="the import package to compile (default claude_swap)")
    parser.add_argument("--check", action="store_true", help="check a public wheel instead of building one")
    args = parser.parse_args(argv)
    if args.check:
        problems = check(args.wheel, args.package)
        for p in problems:
            print(p, file=sys.stderr)
        print(f"{args.wheel.name}: {'ok' if not problems else f'{len(problems)} problem(s)'}")
        return 1 if problems else 0
    out = convert(args.wheel, args.out, package=args.package, extension_zip=args.extension_zip, tag=python_tag())
    problems = check(out, args.package)
    if problems:
        for p in problems:
            print(p, file=sys.stderr)
        return 1
    with zipfile.ZipFile(out) as z:
        pyc = sum(1 for n in z.namelist() if n.endswith(".pyc"))
    print(f"{out} ({pyc} compiled modules, {os.path.getsize(out)} bytes, {python_tag()})")
    if args.extension_zip is None:
        print("no --extension-zip: the extension's code is left out of the wheel", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
