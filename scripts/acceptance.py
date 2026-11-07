#!/usr/bin/env python3
"""Run acceptance suites with persistent build caches and disposable test state."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import subprocess
import tarfile
import tempfile
import time
import uuid
from contextlib import ExitStack, contextmanager

ROOT = Path(__file__).resolve().parent.parent
SUITES = {"cli": "test-runner", "gui": "gui-test-runner", "daemon": "daemon-test-runner"}
CACHE_TYPES = ("cargo", "target", "rustup", "npm")
DOCKERFILES = {"cli": "test-runner.Dockerfile", "gui": "gui-test-runner.Dockerfile",
               "daemon": "daemon-test-runner.Dockerfile"}
IMAGE_REGISTRY = "ghcr.io/camonz"


def cache_key(value):
    # The digest keeps distinct runner/workspace names distinct after sanitizing.
    slug = re.sub(r"[^a-z0-9-]", "-", value.lower()).strip("-")[:40] or "local"
    digest = hashlib.sha256(value.encode()).hexdigest()[:12]
    return f"vtb-acceptance-{slug}-{digest}"


def feature_weight(path):
    """Source-work estimate, not a measured duration: steps, scenarios and table rows."""
    contents = path.read_text()
    lines = contents.splitlines()
    step_pattern = re.compile(r"(?:Given|When|Then|And|But|\*)\s")
    scenario_pattern = re.compile(r"Scenario(?: Outline)?:")
    steps = 0
    scenarios = 0
    table_rows = 0

    for line in lines:
        stripped = line.lstrip()

        if step_pattern.match(stripped):
            steps += 1
        if scenario_pattern.match(stripped):
            scenarios += 1
        if stripped.startswith("|"):
            table_rows += 1

    weight = steps + scenarios * 5 + table_rows

    return max(1, weight)


def balanced_partitions(features, count):
    weighted = [(feature_weight(path), path) for path in features]
    ordered = sorted(weighted, key=lambda item: (-item[0], item[1]))
    partitions = [[] for _ in range(count)]
    loads = [0] * count
    shard_indexes = range(count)

    for weight, path in ordered:
        index = min(shard_indexes, key=lambda candidate: (loads[candidate], candidate))

        partitions[index].append(path)
        loads[index] += weight

    return [sorted(partition) for partition in partitions]


def shard_features(suite, index, count):
    """Deterministic whole-feature partitions, preserving every feature exactly once."""
    if not 1 <= index <= count:
        raise ValueError("shard index must be between 1 and shard count")

    crate = {"cli": "acceptance", "gui": "gui-acceptance", "daemon": "daemon-acceptance"}[suite]
    directory = ROOT / "crates" / crate / "tests/features"
    discovered = directory.rglob("*.feature")
    features = sorted(discovered)

    if count > len(features):
        raise ValueError("empty acceptance shard; reduce shard count")

    if suite in ("gui", "daemon"):
        partitions = balanced_partitions(features, count)
        selected = partitions[index - 1]
    else:
        selected = features[index - 1::count]

    if not selected:
        raise ValueError("empty acceptance shard; reduce shard count")
    names = [path.relative_to(directory).as_posix() for path in selected]
    name_pattern = re.compile(r"(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\.feature")
    invalid_names = [name for name in names if not name_pattern.fullmatch(name)]

    if invalid_names:
        raise ValueError("feature filename cannot be represented safely in the shard glob")
    # globwalk treats a literal absolute filename as its traversal root and
    # matches nothing. Braces keep even a singleton filename in the glob part.
    glob_names = ",".join(names)
    pattern = f"{{{glob_names}}}"

    return f"/app/crates/{crate}/tests/features/{pattern}", names


def image_env(suite):
    return f"VTB_ACCEPTANCE_IMAGE_{suite.upper()}"


def image_ref(suite, registry=IMAGE_REGISTRY):
    # Runner images hold only system tools; the checkout is mounted and compiled
    # at run time. The Dockerfile is therefore the image's only input, so its
    # digest names the image. Include any file a Dockerfile starts to COPY.
    digest = hashlib.sha256((ROOT / "docker" / DOCKERFILES[suite]).read_bytes()).hexdigest()[:16]
    return f"{registry}/vtb-acceptance-{suite}:{digest}"


def succeeds(args, env):
    return subprocess.run(args, cwd=ROOT, env=env, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL).returncode == 0


def build_image(suite, ref, env, output):
    return run(["docker", "build", "-f", f"docker/{DOCKERFILES[suite]}", "-t", ref, "docker"],
               env, output, f"image-{suite}-build")


def docker_platform(env):
    arch = subprocess.run(["docker", "version", "--format", "{{.Server.Arch}}"], cwd=ROOT, env=env,
                          capture_output=True, text=True, check=True).stdout.strip()
    return f"linux/{arch}"


def prepare_images(suites, env, output):
    """Reuse a local or published runner image; build only when neither exists."""
    # Published images match the CI runners. Pull only that platform so other
    # hosts build natively instead of running an emulated image.
    platform = docker_platform(env)
    for suite in suites:
        ref = env[image_env(suite)]
        if succeeds(["docker", "image", "inspect", ref], env):
            continue
        if run(["docker", "pull", "--platform", platform, ref], env, output, f"image-{suite}") == 0:
            continue
        status = build_image(suite, ref, env, output)
        if status:
            return status
    return 0


def publish_images(env, output):
    """Build and push each runner image whose content digest is not yet published."""
    for suite in SUITES:
        ref = env[image_env(suite)]
        if succeeds(["docker", "manifest", "inspect", ref], env):
            print(f"{ref} already published", flush=True)
            continue
        status = build_image(suite, ref, env, output) or run(["docker", "push", ref], env, output, f"image-{suite}-push")
        if status:
            return status
    return 0


@contextmanager
def exclusive_lock(name):
    path = Path(tempfile.gettempdir()) / f"vtb-acceptance-{os.getuid()}-{hashlib.sha256(name.encode()).hexdigest()}.lock"
    # Do not unlink: other processes may already hold this inode open.
    with path.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError(f"Another acceptance run owns {name}; wait for it to finish") from None
        yield


def run(args, env, output, phase):
    started = time.monotonic()
    print(f"==> {phase}", flush=True)
    status = 1
    try:
        # Preserve console diagnostics and a per-phase log for CI artifacts.
        with (output / f"{phase}.log").open("w") as log:
            process = subprocess.Popen(args, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True, start_new_session=True)
            try:
                if phase == "cleanup":
                    # Docker's --timeout only bounds container stop, not a hung
                    # daemon request. Bound the entire teardown command too.
                    content, _ = process.communicate(timeout=45)
                    print(content, end="", flush=True)
                    log.write(content)
                else:
                    for line in process.stdout:
                        print(line, end="", flush=True)
                        log.write(line)
                status = process.wait()
            except BaseException:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                raise
    finally:
        record = {"phase": phase, "duration_seconds": round(time.monotonic() - started, 3), "exit_code": status}
        with (output / "runner-timings.jsonl").open("a") as timings:
            timings.write(json.dumps(record) + "\n")
        print(json.dumps(record), flush=True)
    return status


def cleanup(compose, env, output):
    # A second cancellation signal must not interrupt resource disposal.
    previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        return run(compose + ["down", "--timeout", "10", "--volumes", "--remove-orphans"], env, output, "cleanup")
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def compose_command(env):
    command = ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker/acceptance-cache.yml"]

    if env.get("VTB_ACCEPTANCE_BUILD_CACHE_DIR"):
        command.extend(["-f", "docker/acceptance-build-cache.yml"])

    return command


def source_fingerprint():
    command = ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]
    output = subprocess.check_output(command, cwd=ROOT)
    decoded = output.decode()
    entries = decoded.split("\0")
    unique_names = set(entries) - {""}
    names = sorted(unique_names)
    digest = hashlib.sha256()

    for name in names:
        path = ROOT / name
        if path.is_symlink():
            contents = os.readlink(path).encode()
        elif path.is_file():
            contents = path.read_bytes()
        else:
            contents = b"<deleted>"

        digest.update(name.encode())
        digest.update(b"\0")
        digest.update(contents)
        digest.update(b"\0")

    return digest.hexdigest()


def validate_runtime(path, suite, env):
    with tarfile.open(path, "r:gz") as archive:
        for member in archive.getmembers():
            name = PurePosixPath(member.name)
            allowed = (str(name) in ("acceptance-runtime.json", "target", "target/debug")
                       or str(name).startswith("target/debug/")
                       or str(name) == "crates/gui/node_modules"
                       or str(name).startswith("crates/gui/node_modules/"))

            if name.is_absolute() or ".." in name.parts or not allowed:
                raise ValueError(f"unexpected runtime archive member: {member.name}")

        try:
            manifest_file = archive.extractfile("acceptance-runtime.json")
        except KeyError:
            raise ValueError("runtime bundle has no manifest") from None
        if manifest_file is None:
            raise ValueError("runtime bundle has no manifest")
        manifest = json.load(manifest_file)

    expected = {"schema_version": 1, "suite": suite, "image": env[image_env(suite)],
                "platform": docker_platform(env), "source": source_fingerprint()}

    if manifest != expected:
        raise ValueError("runtime bundle does not match this suite, checkout or runner image/platform; rebuild it")


def build_runtime(suite, env, output):
    fingerprint = source_fingerprint()
    node_volume = f"{env['COMPOSE_PROJECT_NAME']}-build-node"
    cache_directory = env.get("VTB_ACCEPTANCE_BUILD_CACHE_DIR")
    mounts = ["-v", f"{ROOT}:/app", "-v", f"{output}:/app/test-output"]

    for kind, target in [("cargo", "/cargo"), ("target", "/app/target"),
                         ("rustup", "/usr/local/rustup"), ("npm", "/npm-cache")]:
        if cache_directory and kind != "rustup":
            directory = Path(cache_directory) / kind
            directory.mkdir(parents=True, exist_ok=True)
            source = str(directory)
        else:
            source = f"{env['VTB_ACCEPTANCE_CACHE_KEY']}-{kind}"
            subprocess.run(["docker", "volume", "create", source], env=env, check=True,
                           stdout=subprocess.DEVNULL)

        mounts.extend(["-v", f"{source}:{target}"])

    if suite == "gui":
        mounts.extend(["-v", f"{node_volume}:/app/crates/gui/node_modules"])

    build_container = f"{env['COMPOSE_PROJECT_NAME']}-build"
    container = ["docker", "run", "--rm", "--name", build_container, "--entrypoint", "/bin/bash", "-w", "/app",
                 "-e", "CARGO_HOME=/cargo", "-e", "npm_config_cache=/npm-cache",
                 *mounts, env[image_env(suite)]]
    status = prepare_images([suite], env, output)

    try:
        if status:
            return status

        status = run(container + ["/app/docker/acceptance-build.sh", suite], env, output, "build")
        if status:
            return status
        if source_fingerprint() != fingerprint:
            raise ValueError("checkout changed during the runtime build; rebuild before distributing it")

        build_log = output / "build-tests.jsonl"
        build_output = build_log.read_text()
        lines = build_output.splitlines()
        records = [json.loads(line) for line in lines]
        test_name = {"gui": "gui_acceptance", "daemon": "daemon_acceptance", "cli": "acceptance"}[suite]
        executables = [record["executable"] for record in records
                       if record.get("reason") == "compiler-artifact"
                       and record.get("target", {}).get("name") == test_name
                       and record.get("executable")]
        if len(executables) != 1:
            raise ValueError("build did not produce exactly one acceptance test executable")

        manifest = {"schema_version": 1, "suite": suite, "image": env[image_env(suite)],
                    "platform": docker_platform(env), "source": fingerprint}
        manifest_body = json.dumps(manifest)
        manifest_file = output / "runtime-manifest.json"

        manifest_file.write_text(manifest_body)

        package_command = container + ["/app/docker/acceptance-pack.sh", suite, executables[0]]

        return run(package_command, env, output, "package")
    finally:
        subprocess.run(["docker", "rm", "--force", build_container], env=env, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        if suite == "gui":
            subprocess.run(["docker", "volume", "rm", node_volume], env=env, check=False,
                           stdout=subprocess.DEVNULL)


def execute(suites, env, output):
    compose = compose_command(env)
    cache_directory = env.get("VTB_ACCEPTANCE_BUILD_CACHE_DIR")

    if cache_directory:
        for kind in ("cargo", "target", "npm"):
            directory = Path(cache_directory) / kind
            directory.mkdir(parents=True, exist_ok=True)

    prebuilt = env.get("VTB_ACCEPTANCE_PREBUILT_BUNDLE")

    if prebuilt:
        validate_runtime(prebuilt, suites[0], env)

    status = 0
    try:
        for kind in CACHE_TYPES:
            subprocess.run(["docker", "volume", "create", f"{env['VTB_ACCEPTANCE_CACHE_KEY']}-{kind}"],
                           env=env, check=True, stdout=subprocess.DEVNULL)
        status = prepare_images(suites, env, output)
        if not status:
            status = run(compose + ["up", "--wait", "postgres", "sacrum"], env, output, "backend")
        if not status:
            status = run(compose + ["run", "--rm", "seeder"], env, output, "seed")
        if not status:
            for suite in suites:
                shard_env = (["-e", f"VTB_ACCEPTANCE_FEATURE_GLOB={env['VTB_ACCEPTANCE_FEATURE_GLOB']}"]
                             if env.get("VTB_ACCEPTANCE_FEATURE_GLOB") else [])
                runtime_args = []

                if prebuilt:
                    runtime_args = ["-e", "VTB_ACCEPTANCE_PREBUILT=1", "-v", f"{prebuilt}:/acceptance-runtime.tar.gz:ro"]

                result = run(compose + ["run", "--rm", "--no-deps"] + shard_env + runtime_args + [SUITES[suite]], env, output, suite)
                status = status or result
    finally:
        # External build caches survive; database and GUI node_modules do not.
        cleanup_status = cleanup(compose, env, output)
        status = status or cleanup_status
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cleanup", action="store_true", help="Dispose a recorded run using VTB_ACCEPTANCE_OUTPUT")
    parser.add_argument("--build-only", action="store_true", help="Build one suite runtime bundle without starting a backend")
    parser.add_argument("--prebuilt", type=Path, help="Run shards from a matching runtime bundle, without compiling")
    parser.add_argument("--publish-images", action="store_true", help="Build and push unpublished runner images")
    # Older argparse versions validate the entire default list as one choice.
    # Validate supplied names separately and apply the default after parsing.
    parser.add_argument("suites", nargs="*", metavar="{cli,gui,daemon}")
    parser.add_argument("--shard-index", type=int, default=1)
    parser.add_argument("--shard-count", type=int, default=1)
    args = parser.parse_args()
    if not 1 <= args.shard_index <= args.shard_count:
        parser.error("shard index must be between 1 and shard count")
    if args.build_only and (args.prebuilt or args.shard_count != 1 or args.cleanup or args.publish_images):
        parser.error("--build-only cannot be combined with sharding, --prebuilt, --cleanup or --publish-images")
    if (args.build_only or args.prebuilt) and len(args.suites) != 1:
        parser.error("prebuilt runtime operations require exactly one suite")
    if args.shard_count > 1 and len(args.suites) != 1:
        parser.error("sharding requires exactly one suite")
    for suite in args.suites:
        if suite not in SUITES:
            parser.error(f"unknown suite {suite!r}; choose from {', '.join(SUITES)}")
    args.suites = args.suites or list(SUITES)
    env = os.environ.copy()

    if args.prebuilt:
        env["VTB_ACCEPTANCE_PREBUILT_BUNDLE"] = str(args.prebuilt.resolve())
    for suite in SUITES:
        env[image_env(suite)] = image_ref(suite, env.get("VTB_ACCEPTANCE_REGISTRY", IMAGE_REGISTRY))
    env["VTB_ACCEPTANCE_CACHE_KEY"] = cache_key(env.get("VTB_ACCEPTANCE_CACHE_KEY", str(ROOT)))
    if env.get("VTB_ACCEPTANCE_BUILD_CACHE_DIR"):
        cache_directory = Path(env["VTB_ACCEPTANCE_BUILD_CACHE_DIR"]).resolve()
        env["VTB_ACCEPTANCE_BUILD_CACHE_DIR"] = str(cache_directory)

    env["COMPOSE_PROJECT_NAME"] = f"vtb-acceptance-{uuid.uuid4().hex[:12]}"
    output = Path(env.get("VTB_ACCEPTANCE_OUTPUT", ROOT / "test-output" / env["COMPOSE_PROJECT_NAME"])).resolve()
    output.mkdir(parents=True, exist_ok=True)
    env["VTB_ACCEPTANCE_OUTPUT"] = str(output)
    if args.shard_count > 1 and not args.cleanup:
        try:
            pattern, features = shard_features(args.suites[0], args.shard_index, args.shard_count)
        except ValueError as error:
            parser.error(str(error))
        env["VTB_ACCEPTANCE_FEATURE_GLOB"] = pattern
        (output / "shard-manifest.json").write_text(json.dumps({"suite": args.suites[0],
            "index": args.shard_index, "count": args.shard_count, "features": features}, indent=2))
    context_file = output / "runner-context.json"
    context_keys = ("COMPOSE_PROJECT_NAME", "VTB_ACCEPTANCE_CACHE_KEY", "VTB_ACCEPTANCE_OUTPUT",
                    "VTB_ACCEPTANCE_BUILD_CACHE_DIR")
    if args.publish_images:
        return publish_images(env, output)
    if args.cleanup:
        if not os.environ.get("VTB_ACCEPTANCE_OUTPUT"):
            parser.error("--cleanup requires VTB_ACCEPTANCE_OUTPUT")
        if not context_file.exists():
            print("No acceptance run was started; nothing to clean up")
            return 0
        context = json.loads(context_file.read_text())
        env.update({key: context[key] for key in context_keys if key in context})
    print(f"Project: {env['COMPOSE_PROJECT_NAME']}\nCache: {env['VTB_ACCEPTANCE_CACHE_KEY']}\nOutput: {output}", flush=True)

    def interrupted(signum, _frame):
        raise KeyboardInterrupt(f"received signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    with ExitStack() as stack:
        # Lock both source staging paths and reusable compiled binaries.
        stack.enter_context(exclusive_lock(str(ROOT)))
        stack.enter_context(exclusive_lock(env["VTB_ACCEPTANCE_CACHE_KEY"]))

        if env.get("VTB_ACCEPTANCE_BUILD_CACHE_DIR"):
            build_cache_lock = exclusive_lock(env["VTB_ACCEPTANCE_BUILD_CACHE_DIR"])

            stack.enter_context(build_cache_lock)

        if args.cleanup:
            compose = compose_command(env)
            return cleanup(compose, env, output)
        if args.build_only:
            return build_runtime(args.suites[0], env, output)

        context = {key: env[key] for key in context_keys if key in env}

        context_file.write_text(json.dumps(context))
        return execute(args.suites, env, output)


if __name__ == "__main__":
    raise SystemExit(main())
