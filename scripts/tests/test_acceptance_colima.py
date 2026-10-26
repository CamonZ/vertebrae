"""Colima runner contracts used by the CI job, without a VM or live backend."""
from contextlib import nullcontext
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("colima_runner", Path(__file__).parents[1] / "acceptance-colima.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class ColimaRunnerTests(unittest.TestCase):
    def test_ci_output_survives_failed_scenario_and_test_home_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            output = root / "ci-artifacts"
            calls = []
            homes = []

            def run(args, env, destination, phase):
                calls.append((phase, args, destination))
                (destination / f"{phase}.log").write_text("diagnostics")
                return 7 if phase == "gui" else 0

            def cleanup(home, context):
                self.assertEqual(context, "colima")
                self.assertTrue((home / ".colima-gui-acceptance").is_file())
                homes.append(home)

            with patch.dict(os.environ, {"VTB_ACCEPTANCE_OUTPUT": str(output)}), \
                    patch.object(runner.Path, "home", return_value=root), \
                    patch.object(runner.subprocess, "check_output", side_effect=["colima\n", "unix:///colima.sock\n"]), \
                    patch.object(runner.subprocess, "run"), \
                    patch.object(runner.acceptance, "exclusive_lock", side_effect=lambda _: nullcontext()), \
                    patch.object(runner.acceptance, "prepare_images", return_value=0), \
                    patch.object(runner.acceptance, "run", side_effect=run), \
                    patch.object(runner, "cleanup_backend", side_effect=cleanup):
                self.assertEqual(runner.main(), 7)

            self.assertEqual([phase for phase, _, _ in calls], ["image", "gui"])
            self.assertTrue(all(destination == output for _, _, destination in calls))
            self.assertIn(f"{output}:/app/test-output", calls[-1][1])
            self.assertEqual((output / "gui.log").read_text(), "diagnostics")
            self.assertEqual(len(homes), 1)
            self.assertFalse(homes[0].exists())

    def test_does_not_substitute_plain_docker_for_colima(self):
        with patch.object(runner.subprocess, "check_output", side_effect=["default\n", "unix:///var/run/docker.sock\n"]), \
                patch.object(runner.acceptance, "prepare_images") as prepare:
            with self.assertRaisesRegex(SystemExit, "Colima Docker context"):
                runner.main()
            prepare.assert_not_called()


if __name__ == "__main__":
    unittest.main()
