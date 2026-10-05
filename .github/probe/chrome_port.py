"""Temporary CI probe: which Chrome flags make DevToolsActivePort appear."""
import os, subprocess, sys, tempfile, time
from pathlib import Path

sys.path.insert(0, "src")
from claude_swap import cdp  # noqa: E402

exe = cdp.find_browser()
print("browser:", exe, flush=True)
if sys.platform == "win32":
    subprocess.run(["reg", "query", r"HKLM\SOFTWARE\Policies\Google\Chrome", "/s"])
    subprocess.run(["reg", "query", r"HKCU\SOFTWARE\Policies\Google\Chrome", "/s"])
    subprocess.run(["powershell", "-c", f"(Get-Item '{exe}').VersionInfo.ProductVersion"])
else:
    subprocess.run([exe, "--version"])
    subprocess.run(["sh", "-c", "ls -la '/Library/Managed Preferences' 2>&1; defaults read com.google.Chrome 2>&1 | head -40"])

variants = {
    "tests-as-now": ["--headless=new", "--no-sandbox", "--disable-gpu"],
    "headless-only": ["--headless=new"],
    "headful": [],
    "fixed-port": ["--headless=new", "--no-sandbox", "--disable-gpu", "PORT"],
    "old-style-headless": ["--headless", "--no-sandbox", "--disable-gpu"],
}
for name, extra in variants.items():
    profile = Path(tempfile.mkdtemp()) / "p"
    profile.mkdir()
    port_arg = "--remote-debugging-port=9333" if "PORT" in extra else "--remote-debugging-port=0"
    extra = [a for a in extra if a != "PORT"]
    args = [exe, f"--user-data-dir={profile}", port_arg, "--no-first-run",
            "--no-default-browser-check", "--enable-logging=stderr", "--v=1", *extra, "about:blank"]
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    seen = None
    for _ in range(100):
        if (profile / "DevToolsActivePort").exists():
            seen = (profile / "DevToolsActivePort").read_text().split()
            break
        time.sleep(0.2)
    p.kill()
    out = p.communicate(timeout=20)[0].decode("utf-8", "replace").splitlines()
    hits = [l for l in out if any(k in l.lower() for k in ("devtools", "remote", "debugging", "policy"))]
    print(f"== {name}: port file {seen}", flush=True)
    for l in hits[:25]:
        print("   ", l[:300])
