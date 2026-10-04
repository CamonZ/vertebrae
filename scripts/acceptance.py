#!/usr/bin/env python3
"""Run acceptance suites with persistent build caches and disposable test state."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
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


def execute(suites, env, output):
    compose = ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker/acceptance-cache.yml"]
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
                result = run(compose + ["run", "--rm", "--no-deps", SUITES[suite]], env, output, suite)
                status = status or result
    finally:
        # External build caches survive; database and GUI node_modules do not.
        cleanup_status = cleanup(compose, env, output)
        status = status or cleanup_status
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cleanup", action="store_true", help="Dispose a recorded run using VTB_ACCEPTANCE_OUTPUT")
    parser.add_argument("--publish-images", action="store_true", help="Build and push unpublished runner images")
    # Older argparse versions validate the entire default list as one choice.
    # Validate supplied names separately and apply the default after parsing.
    parser.add_argument("suites", nargs="*", metavar="{cli,gui,daemon}")
    args = parser.parse_args()
    for suite in args.suites:
        if suite not in SUITES:
            parser.error(f"unknown suite {suite!r}; choose from {', '.join(SUITES)}")
    args.suites = args.suites or list(SUITES)
    env = os.environ.copy()
    for suite in SUITES:
        env[image_env(suite)] = image_ref(suite, env.get("VTB_ACCEPTANCE_REGISTRY", IMAGE_REGISTRY))
    env["VTB_ACCEPTANCE_CACHE_KEY"] = cache_key(env.get("VTB_ACCEPTANCE_CACHE_KEY", str(ROOT)))
    env["COMPOSE_PROJECT_NAME"] = f"vtb-acceptance-{uuid.uuid4().hex[:12]}"
    output = Path(env.get("VTB_ACCEPTANCE_OUTPUT", ROOT / "test-output" / env["COMPOSE_PROJECT_NAME"])).resolve()
    output.mkdir(parents=True, exist_ok=True)
    env["VTB_ACCEPTANCE_OUTPUT"] = str(output)
    context_file = output / "runner-context.json"
    if args.publish_images:
        return publish_images(env, output)
    if args.cleanup:
        if not os.environ.get("VTB_ACCEPTANCE_OUTPUT"):
            parser.error("--cleanup requires VTB_ACCEPTANCE_OUTPUT")
        if not context_file.exists():
            print("No acceptance run was started; nothing to clean up")
            return 0
        context = json.loads(context_file.read_text())
        env.update({key: context[key] for key in
                    ("COMPOSE_PROJECT_NAME", "VTB_ACCEPTANCE_CACHE_KEY", "VTB_ACCEPTANCE_OUTPUT")})
    print(f"Project: {env['COMPOSE_PROJECT_NAME']}\nCache: {env['VTB_ACCEPTANCE_CACHE_KEY']}\nOutput: {output}", flush=True)

    def interrupted(signum, _frame):
        raise KeyboardInterrupt(f"received signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    with ExitStack() as stack:
        # Lock both source staging paths and reusable compiled binaries.
        stack.enter_context(exclusive_lock(str(ROOT)))
        stack.enter_context(exclusive_lock(env["VTB_ACCEPTANCE_CACHE_KEY"]))
        if args.cleanup:
            compose = ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker/acceptance-cache.yml"]
            return cleanup(compose, env, output)
        context_file.write_text(json.dumps({key: env[key] for key in
                               ("COMPOSE_PROJECT_NAME", "VTB_ACCEPTANCE_CACHE_KEY", "VTB_ACCEPTANCE_OUTPUT")}))
        return execute(args.suites, env, output)


if __name__ == "__main__":
    raise SystemExit(main())
