"""Acceptance orchestration contracts; no Docker or live database required."""
from contextlib import nullcontext
import importlib.util
import io
import hashlib
import tarfile
import json
import re
import sys
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
        self.env.update({runner.image_env(suite): f"registry/{suite}:tag" for suite in runner.SUITES})
        self.calls = []
        # Images are present locally unless a test says otherwise.
        succeeds = patch.object(runner, "succeeds", return_value=True)
        self.succeeds = succeeds.start()
        self.addCleanup(succeeds.stop)
        platform = patch.object(runner, "docker_platform", return_value="linux/amd64")
        platform.start()
        self.addCleanup(platform.stop)

    def fake_run(self, args, env, output, phase):
        self.calls.append((phase, args))
        return 7 if phase == "cli" else 0

    def test_feature_shards_cover_each_suite_exactly_once(self):
        for suite, count in [("cli", 2), ("daemon", 6), ("gui", 8)]:
            partitions = [runner.shard_features(suite, index, count) for index in range(1, count + 1)]
            names = [name for _, selected in partitions for name in selected]
            crate = {"cli": "acceptance", "daemon": "daemon-acceptance", "gui": "gui-acceptance"}[suite]
            directory = runner.ROOT / "crates" / crate / "tests/features"
            expected = sorted(path.relative_to(directory).as_posix() for path in directory.rglob("*.feature"))
            self.assertEqual(sorted(names), expected)
            self.assertEqual(len(names), len(set(names)))
            self.assertTrue(all(selected for _, selected in partitions))
            self.assertEqual(partitions, [runner.shard_features(suite, index, count) for index in range(1, count + 1)])

    def test_ci_matrix_matches_the_covered_shards(self):
        workflows = runner.ROOT / ".github/workflows"
        caller = (workflows / "acceptance.yml").read_text()
        shard_job = (workflows / "acceptance-shards.yml").read_text()
        entries = re.findall(
            r"^      suite: (\w+)\n      shards: '([^']+)'\n      homelab-shards: '([^']+)'$",
            caller,
            re.M,
        )
        actual = [(suite, json.loads(shards), json.loads(homelab)) for suite, shards, homelab in entries]
        self.assertEqual(actual, [
            ("cli", [1, 2], [2]),
            ("daemon", [1, 2, 3, 4, 5, 6], [2, 4]),
            ("gui", [1, 2, 3, 4, 5, 6, 7, 8], [2, 4, 8]),
        ])
        self.assertIn("shard: ${{ fromJSON(inputs.shards) }}", shard_job)
        self.assertIn("contains(fromJSON(inputs.homelab-shards), matrix.shard) && 'homelab' || 'ubuntu-latest'",
                      shard_job)
        self.assertIn("--shard-count ${{ strategy.job-total }}", shard_job)
        self.assertIn("fail-fast: false", shard_job)
        self.assertNotIn("max-parallel:", shard_job)

    def test_weighted_partition_separates_large_features_and_is_deterministic(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            features = []

            for index, steps in enumerate([94, 34, 24, 14, 4, 4]):
                path = directory / f"{index}.feature"
                body = "Feature: fixture\nScenario: fixture\n" + "  Then fixture\n" * steps

                path.write_text(body)
                features.append(path)

            partitions = runner.balanced_partitions(features, 2)
            reverse_partitions = runner.balanced_partitions(list(reversed(features)), 2)
            loads = [sum(runner.feature_weight(path) for path in paths) for paths in partitions]

            self.assertEqual(partitions, reverse_partitions)
            self.assertLessEqual(max(loads) - min(loads), 10)
            self.assertNotEqual(partitions[0], features[::2])

    def test_work_estimate_accounts_for_steps_scenarios_and_example_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            feature = Path(tmp) / "outline.feature"
            feature.write_text("Feature: fixture\nScenario Outline: fixture\n  Given value\n"
                               "  Then result\nExamples:\n  | value |\n  | a |\n  | b |\n")

            self.assertEqual(runner.feature_weight(feature), 10)

    def write_runtime(self, path, manifest, extra_member=None):
        contents = json.dumps(manifest).encode()
        info = tarfile.TarInfo("acceptance-runtime.json")
        info.size = len(contents)

        with tarfile.open(path, "w:gz") as archive:
            archive.addfile(info, io.BytesIO(contents))

            if extra_member:
                archive.addfile(tarfile.TarInfo(extra_member))

    def test_runtime_bundle_is_bound_to_suite_source_platform_and_runner_image(self):
        manifest = {"schema_version": 1, "suite": "gui", "image": "registry/gui:tag",
                    "platform": "linux/amd64", "source": "checkout-fingerprint"}

        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(runner, "source_fingerprint", return_value="checkout-fingerprint"):
            bundle = Path(tmp) / "runtime.tar.gz"
            self.write_runtime(bundle, manifest)

            runner.validate_runtime(bundle, "gui", self.env)

            for field in ("schema_version", "suite", "image", "platform", "source"):
                changed = {**manifest, field: "wrong"}
                self.write_runtime(bundle, changed)

                with self.assertRaisesRegex(ValueError, "does not match"):
                    runner.validate_runtime(bundle, "gui", self.env)

            self.write_runtime(bundle, manifest, "../source.rs")

            with self.assertRaisesRegex(ValueError, "unexpected runtime archive member"):
                runner.validate_runtime(bundle, "gui", self.env)

    @patch.object(runner.subprocess, "run")
    def test_prebuilt_shard_receives_read_only_bundle_and_never_invokes_the_producer(self, _docker):
        self.env["VTB_ACCEPTANCE_PREBUILT_BUNDLE"] = "/tmp/runtime.tar.gz"

        with patch.object(runner, "validate_runtime") as validate, \
                patch.object(runner, "run", side_effect=self.fake_run):
            status = runner.execute(["gui"], self.env, Path("unused"))

        command = next(args for phase, args in self.calls if phase == "gui")

        self.assertEqual(status, 0)
        validate.assert_called_once_with("/tmp/runtime.tar.gz", "gui", self.env)
        self.assertIn("VTB_ACCEPTANCE_PREBUILT=1", command)
        self.assertIn("/tmp/runtime.tar.gz:/acceptance-runtime.tar.gz:ro", command)
        self.assertEqual([phase for phase, _ in self.calls], ["backend", "seed", "gui", "cleanup"])

    @patch.object(runner.subprocess, "run")
    def test_producer_builds_once_and_packages_one_suite_without_a_backend(self, _docker):
        def fake_build(args, env, output, phase):
            self.calls.append((phase, args))

            if phase == "build":
                record = {"reason": "compiler-artifact", "target": {"name": "gui_acceptance"},
                          "executable": "/app/target/debug/deps/gui_acceptance-fixture"}
                contents = json.dumps(record)
                (output / "build-tests.jsonl").write_text(contents)

            return 0

        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(runner, "source_fingerprint", return_value="same-checkout"), \
                patch.object(runner, "run", side_effect=fake_build):
            output = Path(tmp)
            status = runner.build_runtime("gui", self.env, output)
            manifest = json.loads((output / "runtime-manifest.json").read_text())

        self.assertEqual(status, 0)
        self.assertEqual([phase for phase, _ in self.calls], ["build", "package"])
        self.assertEqual(manifest["suite"], "gui")
        self.assertEqual(manifest["source"], "same-checkout")
        self.assertEqual(self.calls[0][1][-2:], ["/app/docker/acceptance-build.sh", "gui"])
        self.assertEqual(self.calls[1][1][-2:], ["gui", "/app/target/debug/deps/gui_acceptance-fixture"])

    def test_ci_builds_each_suite_before_shards_and_distributes_the_same_artifact(self):
        workflows = runner.ROOT / ".github/workflows"
        workflow = (workflows / "acceptance.yml").read_text()
        image = (workflows / "acceptance-images.yml").read_text()
        build = (workflows / "acceptance-build.yml").read_text()
        shards = (workflows / "acceptance-shards.yml").read_text()
        jobs = dict(re.findall(r"^  ([\w-]+):\n(.*?)(?=^  [\w-]+:\n|\Z)", workflow.split("jobs:\n")[1], re.M | re.S))
        artifact_name = "acceptance-runtime-${{ inputs.suite }}-${{ github.sha }}"

        for suite, runner_label in [
            ("cli", "ubuntu-latest"),
            ("daemon", "ubuntu-latest"),
            ("gui", "homelab"),
        ]:
            with self.subTest(suite=suite):
                for phase, reusable, dependency in [
                    ("image", "images", None),
                    ("build", "build", f"{suite}-image"),
                    ("runtime", "runtime-ready", f"{suite}-image"),
                    ("shards", "shards", f"{suite}-runtime"),
                ]:
                    job = jobs[f"{suite}-{phase}"]
                    self.assertIn(f"uses: ./.github/workflows/acceptance-{reusable}.yml", job)
                    self.assertIn(f"      suite: {suite}\n", job)
                    self.assertEqual(re.findall(r"^    needs: (.+)$", job, re.M),
                                     [f"[{dependency}]"] if dependency else [])
                self.assertIn(f"      runner: {runner_label}\n", jobs[f"{suite}-build"])

        colima = jobs["colima"]
        self.assertIn("needs: [gui-image]", colima)
        self.assertIn("actions: read", colima)
        self.assertIn("runs-on: ubuntu-24.04", colima)
        self.assertIn("DOCKER_CONTEXT: colima", colima)
        self.assertLess(colima.index("Start real Colima Docker engine"),
                        colima.index("Load prepared runner image into Colima"))
        self.assertLess(colima.index("Load prepared runner image into Colima"),
                        colima.index("uses: ./.github/actions/wait-acceptance-runtime"))
        self.assertLess(colima.index("Capture Colima diagnostics on failure"),
                        colima.index("Remove Colima VM and its test data"))
        self.assertLess(colima.index("uses: ./.github/actions/wait-acceptance-runtime"),
                        colima.index("Download GUI suite runtime"))
        self.assertIn("name: acceptance-runtime-gui-${{ github.sha }}", jobs["colima"])
        self.assertIn("needs: [cli-build, cli-shards, daemon-build, daemon-shards, gui-build, gui-shards]",
                      jobs["acceptance-summary"])
        self.assertIn("if: always()", jobs["acceptance-summary"])
        for result in ("failure", "cancelled", "skipped"):
            self.assertIn(f"!contains(needs.*.result, '{result}')", jobs["acceptance-summary"])
        self.assertIn("github.event_name == 'push' && github.ref == 'refs/heads/master'", jobs["publish-images"])
        self.assertIn("acceptance-image-${{ inputs.suite }}-${{ github.sha }}", image)
        for consumer in (build, shards):
            self.assertIn("uses: ./.github/actions/load-acceptance-image", consumer)
            self.assertIn(artifact_name, consumer)
        self.assertIn("--build-only", build)
        self.assertIn("--prebuilt", shards)
        self.assertNotIn("Restore acceptance build cache", shards)

    def test_ci_bootstraps_compose_before_building_or_running_suites(self):
        workflows = runner.ROOT / ".github/workflows"
        build = (workflows / "acceptance-build.yml").read_text()
        shards = (workflows / "acceptance-shards.yml").read_text()

        operations = [(build, "Build suite runtime once"), (shards, "Run acceptance suites")]

        for job, operation in operations:
            setup_position = job.index("name: Set up Docker Compose")
            verify_position = job.index("name: Verify Docker Compose")
            operation_position = job.index("name: " + operation)

            self.assertLess(setup_position, verify_position)
            self.assertLess(verify_position, operation_position)
            self.assertIn("docker/setup-compose-action@54042514f505b273907334ae2b9cdbb9a0213c1a", job)
            self.assertIn("version: v2.38.2", job)
            self.assertIn("github.event.pull_request.head.repo.full_name != github.repository", job)
            self.assertIn("'ubuntu-latest' ||", job)

    def test_nested_features_are_not_silently_omitted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            features = root / "crates/acceptance/tests/features"
            (features / "nested").mkdir(parents=True)
            for name in ["a.feature", "nested/b.feature"]:
                (features / name).write_text("Feature: fixture\n")
            with patch.object(runner, "ROOT", root):
                partitions = [runner.shard_features("cli", i, 2) for i in [1, 2]]
            self.assertEqual([names for _, names in partitions], [["a.feature"], ["nested/b.feature"]])
            self.assertTrue(partitions[1][0].endswith("{nested/b.feature}"))

    def test_single_feature_shards_keep_a_glob_component(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            features = root / "crates/gui-acceptance/tests/features"
            features.mkdir(parents=True)
            (features / "only.feature").write_text("Feature: fixture\n")

            with patch.object(runner, "ROOT", root):
                pattern, names = runner.shard_features("gui", 1, 1)

            self.assertEqual(names, ["only.feature"])
            self.assertTrue(pattern.endswith("/{only.feature}"))

    def test_invalid_and_empty_shards_fail(self):
        for index, count in [(0, 2), (3, 2), (1, 0), (10000, 10000)]:
            with self.assertRaises(ValueError):
                runner.shard_features("cli", index, count)

    @patch.object(runner.subprocess, "run")
    def test_feature_filter_reaches_container_and_cleanup_is_unchanged(self, _volume_create):
        self.env["VTB_ACCEPTANCE_FEATURE_GLOB"] = "/app/crates/acceptance/tests/features/{a,b}.feature"
        with patch.object(runner, "run", side_effect=self.fake_run):
            runner.execute(["cli"], self.env, Path("unused"))
        command = next(args for phase, args in self.calls if phase == "cli")
        self.assertEqual(command[-3:], ["-e", "VTB_ACCEPTANCE_FEATURE_GLOB=" + self.env["VTB_ACCEPTANCE_FEATURE_GLOB"], "test-runner"])
        self.assertEqual(self.calls[-1][0], "cleanup")

    @patch.object(runner.subprocess, "run")
    def test_optional_build_cache_is_job_private_and_preserved_by_cleanup(self, _volume_create):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "build cache"
            self.env["VTB_ACCEPTANCE_BUILD_CACHE_DIR"] = str(directory)

            with patch.object(runner, "run", side_effect=self.fake_run):
                runner.execute(["gui"], self.env, Path("unused"))

            for kind in ("cargo", "target", "npm"):
                self.assertTrue((directory / kind).is_dir())

            for _, command in self.calls:
                self.assertIn("docker/acceptance-build-cache.yml", command)

            self.assertEqual(self.calls[-1][0], "cleanup")
            self.assertTrue(directory.exists())

    def test_build_cache_cleanup_context_can_restore_the_optional_overlay(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            output = directory / "output"
            output.mkdir()
            cache = directory / "build cache"
            context = {**self.env, "VTB_ACCEPTANCE_OUTPUT": str(output),
                       "VTB_ACCEPTANCE_BUILD_CACHE_DIR": str(cache)}
            context_file = output / "runner-context.json"
            encoded_context = json.dumps(context)

            context_file.write_text(encoded_context)

            with patch.dict(runner.os.environ, {"VTB_ACCEPTANCE_OUTPUT": str(output)}), \
                    patch.object(sys, "argv", ["acceptance.py", "--cleanup"]), \
                    patch.object(runner, "exclusive_lock", side_effect=lambda _: nullcontext()) as lock, \
                    patch.object(runner, "cleanup", return_value=0) as cleanup:
                self.assertEqual(runner.main(), 0)

            command, restored_env, _ = cleanup.call_args.args

            self.assertIn("docker/acceptance-build-cache.yml", command)
            self.assertEqual(restored_env["VTB_ACCEPTANCE_BUILD_CACHE_DIR"], str(cache))
            lock.assert_any_call(str(cache))

    @patch.object(runner.subprocess, "run")
    def test_failed_suite_does_not_skip_other_suites_and_cleanup(self, volume_create):
        with patch.object(runner, "run", side_effect=self.fake_run):
            status = runner.execute(["cli", "gui", "daemon"], self.env, Path("unused"))
        self.assertEqual(status, 7)
        self.assertEqual([p for p, _ in self.calls], ["backend", "seed", "cli", "gui", "daemon", "cleanup"])
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
        self.succeeds.return_value = False
        with patch.object(runner, "run", side_effect=[1, 2, 0]) as run:
            self.assertEqual(runner.execute(["cli"], self.env, Path("unused")), 2)
        self.assertEqual([c.args[-1] for c in run.call_args_list], ["image-cli", "image-cli-build", "cleanup"])

    @patch.object(runner.subprocess, "run")
    def test_cleanup_failure_fails_successful_run(self, _volume_create):
        with patch.object(runner, "run", side_effect=[0, 0, 0, 3]):
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

    def test_images_are_pulled_and_built_only_when_missing(self):
        local = {"registry/cli:tag"}
        self.succeeds.side_effect = lambda args, env: args[-1] in local
        pulled = {"registry/gui:tag"}
        def fake_run(args, env, output, phase):
            self.calls.append((phase, args))
            return 0 if args[:2] != ["docker", "pull"] or args[-1] in pulled else 1
        with patch.object(runner, "run", side_effect=fake_run):
            self.assertEqual(runner.prepare_images(["cli", "gui", "daemon"], self.env, Path("unused")), 0)
        self.assertEqual([p for p, _ in self.calls], ["image-gui", "image-daemon", "image-daemon-build"])
        self.assertEqual(self.calls[0][1], ["docker", "pull", "--platform", "linux/amd64", "registry/gui:tag"])
        self.assertEqual(self.calls[-1][1][-3:], ["-t", "registry/daemon:tag", "docker"])

    def test_ci_image_handoff_resolves_warm_digest_or_builds_one_cold_archive(self):
        archive_body = b"docker archive fixture"
        digest = "registry/gui@sha256:" + "b" * 64
        for warm in (False, True):
            with self.subTest(warm=warm), tempfile.TemporaryDirectory() as directory:
                handoff = Path(directory)
                self.calls.clear()
                self.env["GITHUB_ENV"] = str(handoff / "github-env")

                def docker(args, env, output, phase):
                    self.calls.append((phase, args))
                    if phase == "image-gui-save":
                        (handoff / "runner.tar").write_bytes(archive_body)
                    return int(args[-1] == "registry/gui:tag" and phase == "image-gui" and not warm)

                with patch.object(runner, "run", side_effect=docker), \
                        patch.object(runner.subprocess, "check_output", return_value=json.dumps([digest])) as inspect, \
                        patch.object(runner.subprocess, "run") as tag:
                    self.assertEqual(runner.prepare_ci_image("gui", self.env, handoff, handoff), 0)
                    metadata = json.loads((handoff / "runner.json").read_text())
                    self.assertEqual(metadata["build_count"], int(not warm))
                    self.assertEqual(metadata["digest"], digest if warm else None)
                    # Simulate a clean suite builder and clean shard loading the same handoff.
                    for _ in range(2):
                        self.assertEqual(runner.load_ci_image("gui", self.env, handoff, handoff), 0)
                        identity = "b" * 64 if warm else hashlib.sha256(archive_body).hexdigest()
                        ref = f"vtb-acceptance-gui:{identity}"
                        self.assertEqual(tag.call_args.args[0],
                                         ["docker", "tag", digest if warm else "registry/gui:tag", ref])

                    self.assertEqual((handoff / "github-env").read_text(),
                                     f"VTB_ACCEPTANCE_PREPARED_IMAGE={ref}\n" * 2)
                    if warm:
                        # Docker IDs can differ by image store. Only preparation inspects the registry digest.
                        self.assertEqual([args[-1] for _, args in self.calls], ["registry/gui:tag", digest, digest])
                        inspect.assert_called_once()
                    else:
                        self.assertEqual([phase for phase, _ in self.calls],
                                         ["image-gui", "image-gui-build", "image-gui-save",
                                          "image-gui-load", "image-gui-load"])

                        (handoff / "runner.tar").write_bytes(b"corrupt")
                        with self.assertRaisesRegex(ValueError, "archive checksum does not match"):
                            runner.load_ci_image("gui", self.env, handoff, handoff)

    def test_ci_publisher_pushes_cold_archive_without_rebuilding(self):
        self.succeeds.return_value = False
        with tempfile.TemporaryDirectory() as directory:
            handoff = Path(directory)
            archive_body = b"docker archive fixture"
            (handoff / "runner.tar").write_bytes(archive_body)
            metadata = {"suite": "gui", "platform": "linux/amd64", "archive_sha256": hashlib.sha256(archive_body).hexdigest(),
                        "tag": self.env[runner.image_env("gui")], "digest": None, "build_count": 1}
            (handoff / "runner.json").write_text(json.dumps(metadata))
            with patch.object(runner, "run", side_effect=self.fake_run):
                self.assertEqual(runner.load_ci_image("gui", self.env, handoff, handoff, publish=True), 0)

        self.assertEqual([phase for phase, _ in self.calls], ["image-gui-load", "image-gui-push"])

    def test_missing_prepared_image_fails_without_pull_or_build(self):
        prepared = "vtb-acceptance-gui:" + "a" * 64
        self.env.update({runner.image_env("gui"): prepared, "VTB_ACCEPTANCE_PREPARED_IMAGE": prepared})
        self.succeeds.return_value = False
        with patch.object(runner, "run") as docker:
            self.assertEqual(runner.prepare_images(["gui"], self.env, Path("unused")), 1)
        docker.assert_not_called()

    def test_publish_pushes_only_unpublished_images(self):
        self.succeeds.side_effect = lambda args, env: args[-1] != "registry/gui:tag"
        with patch.object(runner, "run", side_effect=self.fake_run):
            self.assertEqual(runner.publish_images(self.env, Path("unused")), 0)
        self.assertEqual([p for p, _ in self.calls], ["image-gui-build", "image-gui-push"])
        self.assertEqual(self.calls[-1][1], ["docker", "push", "registry/gui:tag"])

    def test_image_ref_is_content_addressed_per_suite(self):
        refs = {suite: runner.image_ref(suite, "registry") for suite in runner.SUITES}
        self.assertEqual(refs["gui"], runner.image_ref("gui", "registry"))
        self.assertEqual(len(set(refs.values())), len(refs))
        self.assertRegex(refs["cli"], r"^registry/vtb-acceptance-cli:[0-9a-f]{16}$")

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
