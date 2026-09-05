"""Acceptance orchestration contracts; no Docker or live database required."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("acceptance", Path(__file__).parents[1] / "acceptance.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.env = {"VTB_ACCEPTANCE_CACHE_KEY": "test-cache", "COMPOSE_PROJECT_NAME": "test-run"}
        self.calls = []

    def fake_run(self, args, env, output, phase):
        self.calls.append((phase, args))
        return 7 if phase == "cli" else 0

    @patch.object(runner.subprocess, "run")
    def test_failed_suite_does_not_skip_other_suites_and_cleanup(self, volume_create):
        with patch.object(runner, "run", side_effect=self.fake_run):
            status = runner.execute(["cli", "gui", "daemon"], self.env, Path("unused"))
        self.assertEqual(status, 7)
        self.assertEqual([p for p, _ in self.calls], ["images", "backend", "seed", "cli", "gui", "daemon", "cleanup"])
        self.assertEqual(self.calls[-1][1][-5:], ["down", "--timeout", "10", "--volumes", "--remove-orphans"])
        self.assertEqual(volume_create.call_count, 4)
        self.assertEqual([c.args[0][-1] for c in volume_create.call_args_list],
                         ["test-cache-cargo", "test-cache-target", "test-cache-rustup", "test-cache-npm"])

    @patch.object(runner.subprocess, "run")
    def test_interrupt_still_cleans_up(self, _volume_create):
        def interrupt(args, env, output, phase):
            self.calls.append(phase)
            if phase == "gui":
                raise KeyboardInterrupt()
            return 0
        with patch.object(runner, "run", side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):
                runner.execute(["gui"], self.env, Path("unused"))
        self.assertEqual(self.calls[-1], "cleanup")

    @patch.object(runner.subprocess, "run")
    def test_failed_build_skips_runtime_and_cleans_up(self, _volume_create):
        with patch.object(runner, "run", side_effect=[2, 0]) as run:
            self.assertEqual(runner.execute(["cli"], self.env, Path("unused")), 2)
        self.assertEqual([c.args[-1] for c in run.call_args_list], ["images", "cleanup"])

    @patch.object(runner.subprocess, "run")
    def test_cleanup_failure_fails_successful_run(self, _volume_create):
        with patch.object(runner, "run", side_effect=[0, 0, 0, 0, 3]):
            self.assertEqual(runner.execute(["cli"], self.env, Path("unused")), 3)

    def test_cleanup_command_deadline_terminates_hung_client(self):
        process = Mock(pid=12345)
        process.communicate.side_effect = runner.subprocess.TimeoutExpired("docker", 45)
        process.wait.return_value = -15
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runner.subprocess, "Popen", return_value=process), \
                patch.object(runner.os, "killpg") as terminate:
            with self.assertRaises(runner.subprocess.TimeoutExpired):
                runner.run(["docker", "compose", "down"], self.env, Path(directory), "cleanup")
        process.communicate.assert_called_once_with(timeout=45)
        terminate.assert_called_once_with(12345, runner.signal.SIGTERM)
        process.wait.assert_called_once_with(timeout=10)

    def test_cleanup_ignores_repeat_signals_and_restores_handlers(self):
        before = {sig: runner.signal.getsignal(sig) for sig in (runner.signal.SIGINT, runner.signal.SIGTERM)}
        def inspect(*args):
            for sig in before:
                self.assertEqual(runner.signal.getsignal(sig), runner.signal.SIG_IGN)
            return 0
        with patch.object(runner, "run", side_effect=inspect):
            self.assertEqual(runner.cleanup(["docker", "compose"], self.env, Path("unused")), 0)
        for sig, handler in before.items():
            self.assertEqual(runner.signal.getsignal(sig), handler)

    def test_distinct_cache_names_do_not_collide_after_sanitizing(self):
        self.assertNotEqual(runner.cache_key("Runner A"), runner.cache_key("Runner-A"))
        self.assertEqual(runner.cache_key("Runner A"), runner.cache_key("Runner A"))
        self.assertRegex(runner.cache_key("/tmp/My Checkout"), r"^[a-z0-9-]+$")

    def test_lock_rejects_overlapping_use_and_releases_after_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "Another acceptance run"):
                with runner.exclusive_lock(directory):
                    with runner.exclusive_lock(directory):
                        self.fail("overlapping lock was acquired")
            with runner.exclusive_lock(directory):
                pass


if __name__ == "__main__":
    unittest.main()
