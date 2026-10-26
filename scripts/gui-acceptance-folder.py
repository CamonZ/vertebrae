#!/usr/bin/env python3
"""Choose a directory using the actual GTK dialog and native keyboard events."""
import subprocess
import sys
import time
from pathlib import Path
import gi

gi.require_version("Gdk", "3.0")
from gi.repository import Gdk


def screenshot(label):
    Gdk.init([])
    window = Gdk.get_default_root_window()
    pixels = Gdk.pixbuf_get_from_window(window, 0, 0, window.get_width(), window.get_height())
    pixels.savev(f"/app/test-output/native-folder-{label}.png", "png", [], [])


def xdo(*args):
    return subprocess.check_output(["xdotool", *args], text=True, timeout=15).strip()


def main():
    window = xdo("search", "--sync", "--onlyvisible", "--name", "Select Project Directory").splitlines()[-1]
    xdo("windowfocus", "--sync", window)
    screenshot("opened")
    xdo("key", "--clearmodifiers", "alt+Home")
    xdo("key", "--clearmodifiers", "ctrl+l")
    xdo("type", "--clearmodifiers", "--delay", "5", str(Path(sys.argv[1])))
    screenshot("typed")
    xdo("key", "--clearmodifiers", "Return")
    screenshot("entered")
    # GTK puts Open at the bottom right. Use the native window's geometry
    # and click it until directory loading completes and the chooser closes.
    geometry = dict(line.split("=", 1) for line in xdo("getwindowgeometry", "--shell", window).splitlines())
    button_x, button_y = str(int(geometry["WIDTH"]) - 50), str(int(geometry["HEIGHT"]) - 24)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        visible = subprocess.run(["xdotool", "search", "--onlyvisible", "--name", "^Select Project Directory$"], capture_output=True, text=True)
        if window not in visible.stdout.splitlines():
            screenshot("confirmed")
            return
        moved = subprocess.run(["xdotool", "mousemove", "--window", window, button_x, button_y], capture_output=True)
        if moved.returncode == 0:
            xdo("click", "1")

        time.sleep(0.1)
    screenshot("failure")
    raise RuntimeError("Native folder chooser did not close after Open")


if __name__ == "__main__":
    main()
