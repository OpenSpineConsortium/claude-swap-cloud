"""A temporary probe of what a plain headless window shows while it runs. To be reverted.

Prints, once a second, what each sign of a sign-in gives on this system:
the session-restore files and whether they can be read, the history, the
cookie store's stamp and whether it can be read; then what each way of
closing the window answers, whether the browser exits, and whether the
sign-in is in the store afterwards.

usage: probe_plain_window.py <out dir>
"""
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, "src")
from claude_swap import project_move_auto as pma  # noqa: E402

BROWSER = os.environ["CSWAP_BROWSER"]
NODE = "node"
JS = Path("tests/js")
ARGS = [
    *(["--no-sandbox", "--disable-gpu"] if sys.platform.startswith("linux") else []),
    *(["--use-mock-keychain"] if sys.platform == "darwin" else []),
    "--no-proxy-server",
    "--disable-features=ChromeWhatsNewUI,LocalNetworkAccessChecks,NetworkServiceSandbox",
    "--enable-logging",
    "--v=0",
]


def say(t0: float, *parts) -> None:
    print(f"{time.monotonic() - t0:6.1f}s", *parts, flush=True)


def readable(path: str) -> str:
    try:
        return f"read {len(Path(path).read_bytes())} bytes"
    except OSError as e:
        return f"{type(e).__name__}: {e}"[:80]


def run(mode: str, out: Path) -> None:
    print(f"===== {mode} =====", flush=True)
    args = ["--signed-out", "--login-as", "src@example.com"] + (["--stay-open"] if mode == "stay" else [])
    mock = subprocess.Popen([NODE, str(JS / "mock_http_server.js"), *args], stdout=subprocess.PIPE, text=True)
    port = int(mock.stdout.readline().split()[1])
    site = f"http://127.0.0.1:{port}"
    account = pma.Account("source", "2", "src@example.com")
    profile = account.profile_dir(out)
    profile.mkdir(parents=True, exist_ok=True)
    try:
        url = pma.label_page(account, site, out, continue_after=1)
        files_before = pma.session_files(profile)
        stamp0 = pma.store_stamp(profile)
        since = pma.chrome_time(time.time())
        process = pma.launch_plain(BROWSER, profile, url, headless=True, extra_args=ARGS)
        t0 = time.monotonic()
        last = None
        while time.monotonic() - t0 < 45 and process.poll() is None:
            new = {p: readable(p) for p, v in pma.session_files(profile).items() if files_before.get(p) != v}
            pages = pma.session_pages(profile, files_before)
            hist = pma.history_pages(profile, since)
            stamp = pma.store_stamp(profile)
            cookies = pma.session_cookies(profile, "127.0.0.1")
            line = (
                {Path(p).name: r for p, r in new.items()},
                pages[-2:],
                hist[-2:],
                stamp,
                stamp != stamp0,
                len(cookies),
            )
            if line != last:
                say(t0, "files/read:", line[0], "session pages:", line[1], "history:", line[2], "store stamp:", line[3], "changed:", line[4], "cookies readable:", line[5])
                last = line
            time.sleep(1)
        say(t0, "process:", "running" if process.poll() is None else f"exited {process.poll()}")
        if process.poll() is None and sys.platform == "win32":
            for command in (
                ["powershell", "-NoProfile", "-Command", f"(Get-Process -Id {process.pid}).CloseMainWindow()"],
                ["taskkill", "/PID", str(process.pid)],
            ):
                done = subprocess.run(command, capture_output=True, text=True, timeout=30)
                say(t0, command[0], "->", done.returncode, repr(done.stdout.strip()[:120]), repr(done.stderr.strip()[:120]))
                try:
                    code = process.wait(10)
                    say(t0, "exited", code, "after", command[0])
                    break
                except subprocess.TimeoutExpired:
                    say(t0, "still running after", command[0])
        if process.poll() is None:
            say(t0, "ending the process")
            pma._close_gently(process, profile=profile, stamp=stamp0)
            say(t0, "exit code", process.poll())
        time.sleep(1)
        say(t0, "after exit: cookies in store:", len(pma.session_cookies(profile, "127.0.0.1")), "store stamp:", pma.store_stamp(profile))
        say(t0, "after exit: session pages:", pma.session_pages(profile, files_before)[-3:])
        say(t0, "after exit: history:", pma.history_pages(profile, since)[-3:])
        log = profile / "chrome_debug.log"
        if log.is_file():
            lines = log.read_text(errors="replace").splitlines()
            say(t0, "chrome_debug.log:", len(lines), "lines; last:", [l[-120:] for l in lines[-6:]])
    finally:
        mock.kill()


if __name__ == "__main__":
    out = Path(sys.argv[1])
    run("stay", out / "stay")
    run("self", out / "self")
