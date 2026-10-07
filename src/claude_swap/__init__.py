"""Multi-account switcher for Claude Code."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("claude-swap-cloud")
except PackageNotFoundError:
    # Run from a checkout that was never installed (a PYTHONPATH launcher,
    # or the bridge host Chrome starts): the code works all the same.
    __version__ = "0+unknown"

from claude_swap.switcher import ClaudeAccountSwitcher

__all__ = ["ClaudeAccountSwitcher", "__version__"]
