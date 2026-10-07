"""The computer's own file windows, opened for the side panel.

Export this project asks where the export goes in the Save As window the
computer always shows, and Import asks which export to take in its Open
window: Windows' common dialogs through PowerShell, the Mac's through
osascript, zenity or kdialog on Linux, and tkinter's as the last resort
everywhere. Each runs as a program of its own, so the bridge keeps
answering while a window is open, and gets what to show (a title, the
folder to start in, the name to suggest, the kinds of file) through
environment variables, never through its command line, which could be
read by anyone on the computer. The program writes the chosen path, and
nothing else, to its standard output; an empty answer is the window
closed without a choice. The bridge (``bridge.py``) keeps the record of
the window open and reads the answer; this module only knows how to open
one and how to read what it said.
"""

from __future__ import annotations

import base64
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path


class DialogError(Exception):
    """No file window could be opened on this computer."""


@dataclass
class DialogSpec:
    """What a file window shows: ``kind`` is ``save`` or ``open``."""

    kind: str
    title: str
    directory: str = ""
    filename: str = ""
    filter_label: str = "Project export"
    patterns: list[str] = field(default_factory=lambda: ["*.tar", "export.json"])
    extension: str = "tar"
    owner: str = ""  # Windows: the handle of the browser window the dialog belongs to, decimal


# Windows: the .NET common dialogs, owned by the browser window Chrome
# names (so the window comes to the front and belongs to it, as Chrome's
# own Save As does) or, when Chrome names none, by an invisible window kept
# on top. The script is passed base64-encoded, which no execution policy
# applies to, and reads its parameters from the environment.
_POWERSHELL_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
trap { [Console]::Error.WriteLine($_); exit 3 }
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
$kind = $env:CSWAP_DIALOG_KIND
if ($kind -eq 'save') {
  $d = New-Object System.Windows.Forms.SaveFileDialog
  $d.OverwritePrompt = $true
  $d.AddExtension = $true
  if ($env:CSWAP_DIALOG_EXT) { $d.DefaultExt = $env:CSWAP_DIALOG_EXT }
} else {
  $d = New-Object System.Windows.Forms.OpenFileDialog
  $d.CheckFileExists = $true
  $d.Multiselect = $false
}
$d.Title = $env:CSWAP_DIALOG_TITLE
if ($env:CSWAP_DIALOG_FILTER) {
  $d.Filter = $env:CSWAP_DIALOG_FILTER_LABEL + ' (' + $env:CSWAP_DIALOG_FILTER.Replace(' ', ';') + ')|' + $env:CSWAP_DIALOG_FILTER.Replace(' ', ';') + '|All files (*.*)|*.*'
}
if ($env:CSWAP_DIALOG_DIR -and (Test-Path -LiteralPath $env:CSWAP_DIALOG_DIR)) { $d.InitialDirectory = $env:CSWAP_DIALOG_DIR }
if ($env:CSWAP_DIALOG_NAME) { $d.FileName = $env:CSWAP_DIALOG_NAME }
$owner = $null
if ($env:CSWAP_DIALOG_OWNER -match '^[0-9]+$' -and [int64]$env:CSWAP_DIALOG_OWNER -gt 0) {
  $owner = New-Object System.Windows.Forms.NativeWindow
  $owner.AssignHandle([IntPtr][int64]$env:CSWAP_DIALOG_OWNER)
}
if ($owner -eq $null) {
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.Opacity = 0
  $owner.FormBorderStyle = 'None'
  $owner.Width = 1
  $owner.Height = 1
  $owner.StartPosition = 'CenterScreen'
  $owner.Show()
  $owner.Activate()
}
try { $result = $d.ShowDialog($owner) } catch { $result = $d.ShowDialog() }
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
exit 0
"""

# The Mac: AppleScript's own choose file name and choose file. `activate`
# brings the window in front of the browser.
_APPLESCRIPT = """
set theKind to system attribute "CSWAP_DIALOG_KIND"
set theTitle to system attribute "CSWAP_DIALOG_TITLE"
set theDir to system attribute "CSWAP_DIALOG_DIR"
set theName to system attribute "CSWAP_DIALOG_NAME"
activate
if theKind is "save" then
  if theDir is "" then
    set chosen to choose file name with prompt theTitle default name theName
  else
    set chosen to choose file name with prompt theTitle default name theName default location (POSIX file theDir)
  end if
else
  if theDir is "" then
    set chosen to choose file with prompt theTitle
  else
    set chosen to choose file with prompt theTitle default location (POSIX file theDir)
  end if
end if
return POSIX path of chosen
"""

# Everywhere, when nothing better is there: Python's own tkinter dialogs.
_TKINTER_SCRIPT = """
import os, sys
try:
    import tkinter
    from tkinter import filedialog
    root = tkinter.Tk()
except Exception as e:
    sys.stderr.write('tkinter cannot open a window here: %s' % e)
    sys.exit(3)
root.withdraw()
try:
    root.attributes('-topmost', True)
except tkinter.TclError:
    pass
env = os.environ.get
kw = {'title': env('CSWAP_DIALOG_TITLE', ''), 'filetypes': [(env('CSWAP_DIALOG_FILTER_LABEL', 'Files'), env('CSWAP_DIALOG_FILTER', '*')), ('All files', '*')]}
if env('CSWAP_DIALOG_DIR'):
    kw['initialdir'] = env('CSWAP_DIALOG_DIR')
if env('CSWAP_DIALOG_KIND') == 'save':
    ext = env('CSWAP_DIALOG_EXT', '')
    path = filedialog.asksaveasfilename(initialfile=env('CSWAP_DIALOG_NAME', ''), defaultextension=('.' + ext) if ext else '', **kw)
else:
    path = filedialog.askopenfilename(**kw)
sys.stdout.write(path if isinstance(path, str) else '')
"""


def environment(spec: DialogSpec, base: dict | None = None) -> dict:
    """The child's environment: the computer's own, with what the window shows added."""
    env = dict(os.environ if base is None else base)
    env["CSWAP_DIALOG_KIND"] = "save" if spec.kind == "save" else "open"
    env["CSWAP_DIALOG_TITLE"] = spec.title
    env["CSWAP_DIALOG_DIR"] = spec.directory
    env["CSWAP_DIALOG_NAME"] = spec.filename
    env["CSWAP_DIALOG_FILTER_LABEL"] = spec.filter_label
    env["CSWAP_DIALOG_FILTER"] = " ".join(spec.patterns)
    env["CSWAP_DIALOG_EXT"] = spec.extension
    env["CSWAP_DIALOG_OWNER"] = spec.owner
    return env


def _powershell(platform: str) -> str | None:
    """Windows PowerShell as Windows ships it, else whichever PowerShell is on the path."""
    if platform != "win32":
        return None
    system_root = os.environ.get("SystemRoot") or r"C:\Windows"
    shipped = os.path.join(system_root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    if os.path.isfile(shipped):
        return shipped
    return shutil.which("powershell") or shutil.which("pwsh")


def _encoded(script: str) -> str:
    return base64.b64encode(script.encode("utf-16-le")).decode("ascii")


def candidates(spec: DialogSpec, platform: str | None = None, python: str | None = None) -> list[tuple[str, list[str]]]:
    """The programs that could show this window, best first: (name, argv). Only ones found on this computer."""
    plat = platform or sys.platform
    found: list[tuple[str, list[str]]] = []
    if plat == "win32":
        shell = _powershell(plat)
        if shell:
            found.append(("powershell", [shell, "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", _encoded(_POWERSHELL_SCRIPT)]))
    elif plat == "darwin":
        osascript = shutil.which("osascript")
        if osascript:
            found.append(("osascript", [osascript, "-e", _APPLESCRIPT]))
    else:
        zenity = shutil.which("zenity")
        if zenity:
            argv = [zenity, "--file-selection", f"--title={spec.title}", f"--file-filter={spec.filter_label} | {' '.join(spec.patterns)}"]
            if spec.kind == "save":
                argv += ["--save", "--confirm-overwrite"]
                if spec.directory or spec.filename:
                    argv.append(f"--filename={os.path.join(spec.directory, spec.filename)}")
            elif spec.directory:
                argv.append(f"--filename={os.path.join(spec.directory, '')}")
            found.append(("zenity", argv))
        kdialog = shutil.which("kdialog")
        if kdialog:
            start = os.path.join(spec.directory, spec.filename if spec.kind == "save" else "")
            which = "--getsavefilename" if spec.kind == "save" else "--getopenfilename"
            found.append(("kdialog", [kdialog, "--title", spec.title, which, start, f"{spec.filter_label} ({' '.join(spec.patterns)})"]))
    interpreter = python or sys.executable
    if interpreter:
        found.append(("tkinter", [interpreter, "-I", "-c", _TKINTER_SCRIPT]))
    return found


_CREATE_NO_WINDOW = 0x08000000
_CREATE_BREAKAWAY_FROM_JOB = 0x01000000


def start(
    spec: DialogSpec,
    *,
    out_path: Path,
    err_path: Path,
    platform: str | None = None,
    popen=None,
    python: str | None = None,
    environ: dict | None = None,
) -> tuple[str, int, object]:
    """Open the window: the program's name, its process id and its handle (a ``Popen``).

    The first program that starts wins. Its standard input is nothing
    (never the bridge's protocol pipe), its output goes to ``out_path``
    and what it complains of to ``err_path``, both files of the bridge's.
    On Windows it gets no console window and leaves the job Chrome may
    keep the bridge in, so it outlives a bridge that is restarted
    meanwhile; when it cannot leave that job it starts inside it.
    """
    plat = platform or sys.platform
    run = popen or subprocess.Popen
    env = environment(spec, environ)
    failures: list[str] = []
    for name, argv in candidates(spec, plat, python):
        try:
            with open(out_path, "wb") as out, open(err_path, "wb") as err:
                common = dict(env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err, close_fds=True)
                if plat == "win32":
                    try:
                        proc = run(argv, creationflags=_CREATE_NO_WINDOW | _CREATE_BREAKAWAY_FROM_JOB, **common)
                    except OSError:
                        proc = run(argv, creationflags=_CREATE_NO_WINDOW, **common)
                else:
                    proc = run(argv, start_new_session=True, **common)
        except OSError as e:
            failures.append(f"{name}: {e}")
            continue
        return name, int(proc.pid), proc
    raise DialogError(
        "no file window could be opened on this computer"
        + (f" ({'; '.join(failures)})" if failures else " (no PowerShell, osascript, zenity, kdialog or tkinter found)")
    )


# What a complaint on the error output says when the program failed rather
# than the window being closed (zenity and kdialog write warnings there
# that mean nothing).
_FAILURE_WORDS = ("traceback", "error", "exception", "not recognized", "cannot", "could not", "no module")


def outcome(out: bytes, err: bytes, exit_code: int | None) -> tuple[str, str]:
    """What the window said: ``('chosen', path)``, ``('cancelled', '')`` or ``('error', why)``.

    A path on the output is a choice. Nothing on it is the window closed
    without one, which the programs report differently (PowerShell and
    tkinter leave with 0, osascript, zenity and kdialog with 1 and a word
    about it): a program that leaves with 3 (the PowerShell and tkinter
    scripts' own code for a failure), with another code, or with 1 and a
    complaint that reads as a failure, did not show the window.
    """
    lines = out.decode("utf-8-sig", errors="replace").strip().splitlines()
    chosen = lines[-1].strip() if lines else ""
    if chosen:
        return "chosen", chosen
    complaint = err.decode("utf-8-sig", errors="replace").strip()
    lowered = complaint.lower()
    if "cancel" in lowered:
        return "cancelled", ""
    failed = exit_code == 3 or exit_code not in (0, 1, None) or (exit_code == 1 and any(w in lowered for w in _FAILURE_WORDS))
    if not failed:
        return "cancelled", ""
    tail = complaint.splitlines()[-1][:300] if complaint else f"it left with code {exit_code}"
    return "error", f"the file window failed: {tail}"
