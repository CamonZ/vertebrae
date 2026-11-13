"""Unit tests for the Hammerspoon MCP server's pure logic.

Run with the MCP server's virtualenv (it needs the `mcp` package):

    hammerspoon/mcp/.venv/bin/python -m unittest hammerspoon/mcp/test_server.py
"""

import base64
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import server  # noqa: E402

MAIN = "/repo/vertebrae"
WORKTREE = "/repo/vertebrae-1234"


def instance(pid, root, windows=True, name="gui"):
    return {
        "pid": pid,
        "name": name,
        "root": root,
        "windows": [{"id": pid * 10}] if windows else [],
    }


class SelectInstanceTest(unittest.TestCase):
    def setUp(self):
        realpath = mock.patch("server.os.path.realpath", side_effect=lambda p: p)
        realpath.start()
        self.addCleanup(realpath.stop)

    def test_picks_the_instance_running_from_the_worktree(self):
        running = [instance(1, MAIN), instance(2, WORKTREE), instance(3, None)]
        chosen = server.select_instance(running, WORKTREE, explicit=True)
        self.assertEqual(chosen["pid"], 2)

    def test_installed_selects_the_bundled_app(self):
        running = [instance(1, MAIN), instance(3, None, name="Vertebrae")]
        chosen = server.select_instance(running, server.INSTALLED, explicit=True)
        self.assertEqual(chosen["pid"], 3)

    def test_prefers_a_matching_instance_that_has_windows(self):
        running = [instance(1, WORKTREE, windows=False), instance(2, WORKTREE)]
        chosen = server.select_instance(running, WORKTREE, explicit=True)
        self.assertEqual(chosen["pid"], 2)

    def test_implicit_target_falls_back_to_the_only_running_instance(self):
        running = [instance(3, None, name="Vertebrae")]
        chosen = server.select_instance(running, MAIN, explicit=False)
        self.assertEqual(chosen["pid"], 3)

    def test_explicit_target_never_falls_back(self):
        running = [instance(1, MAIN)]
        with self.assertRaisesRegex(ValueError, "no instance running from"):
            server.select_instance(running, WORKTREE, explicit=True)

    def test_ambiguity_is_an_error_listing_what_is_running(self):
        running = [instance(1, WORKTREE), instance(3, None)]
        with self.assertRaises(ValueError) as caught:
            server.select_instance(running, MAIN, explicit=False)
        message = str(caught.exception)
        self.assertIn(f"pid 1 (gui) -> {WORKTREE}", message)
        self.assertIn("pid 3 (gui) -> installed", message)

    def test_nothing_running_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "not running"):
            server.select_instance([], WORKTREE, explicit=False)


class InstanceRootTest(unittest.TestCase):
    def test_dev_build_resolves_through_its_working_directory(self):
        # The binary lives in a shared target dir under the main checkout, but
        # tauri dev runs it from the worktree's src-tauri directory.
        with mock.patch.object(
            server, "_process_cwd", return_value=f"{WORKTREE}/crates/gui/src-tauri"
        ), mock.patch.object(
            server,
            "_checkout_root",
            side_effect=lambda p: WORKTREE if p and p.startswith(WORKTREE) else None,
        ):
            root = server._instance_root(
                {"pid": 1, "path": f"{MAIN}/target/debug/gui"}
            )
        self.assertEqual(root, WORKTREE)

    def test_installed_app_has_no_checkout(self):
        with mock.patch.object(server, "_process_cwd", return_value="/"), mock.patch.object(
            server, "_checkout_root", return_value=None
        ):
            root = server._instance_root(
                {"pid": 1, "path": "/Applications/Vertebrae.app"}
            )
        self.assertIsNone(root)


class DefaultWorktreeTest(unittest.TestCase):
    def test_environment_overrides_the_server_checkout(self):
        with mock.patch.dict(os.environ, {"VTB_GUI_WORKTREE": WORKTREE}):
            self.assertEqual(server._default_worktree(), WORKTREE)


class PngImageTest(unittest.TestCase):
    def test_decodes_hammerspoon_base64_into_png_bytes(self):
        png = b"\x89PNG\r\n\x1a\nrest"
        image = server._png_image({"image_base64": base64.b64encode(png).decode()})
        self.assertEqual(image.data, png)

    def test_surfaces_hammerspoon_errors(self):
        with self.assertRaisesRegex(ValueError, "window not found"):
            server._png_image({"error": "window not found"})


if __name__ == "__main__":
    unittest.main()
