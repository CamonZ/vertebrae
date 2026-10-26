#!/usr/bin/env python3
"""Exercise project setup via the real GUI, using a disposable Colima stack."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("acceptance", ROOT / "scripts/acceptance.py")
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


def cleanup_backend(home, context):
    state_path = home / ".local/share/vertebrae/local-backend/state.json"
    if not state_path.exists():
        return
    state = json.loads(state_path.read_text())
    installation = uuid.UUID(state["installation_id"])
    project = f"vertebrae-local-{installation.hex}"
    docker = ["docker", "--context", context]
    ids = subprocess.check_output(docker + ["ps", "-aq", "--filter", f"label=com.docker.compose.project={project}"], text=True).split()
    if ids:
        subprocess.run(docker + ["rm", "-f", *ids], check=True)
    volume = project + "_pgdata"
    volumes = subprocess.check_output(docker + ["volume", "ls", "--format", "{{.Name}}"], text=True).splitlines()
    if volume in volumes:
        subprocess.run(docker + ["volume", "rm", volume], check=True)
    assert not subprocess.check_output(docker + ["ps", "-aq", "--filter", f"label=com.docker.compose.project={project}"], text=True).strip()
    assert volume not in subprocess.check_output(docker + ["volume", "ls", "--format", "{{.Name}}"], text=True).splitlines()
    print("Verified removal of test-owned containers and database volume", flush=True)


def main():
    context = subprocess.check_output(["docker", "context", "show"], text=True).strip()
    endpoint = subprocess.check_output(["docker", "context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"], text=True).strip()
    if not context.startswith("colima") or not endpoint.startswith("unix://"):
        raise SystemExit("Select a running local Colima Docker context first")
    subprocess.run(["colima", "status"], check=True)
    run_id = "colima-" + uuid.uuid4().hex[:12]
    env = os.environ.copy()
    output = Path(env.get("VTB_ACCEPTANCE_OUTPUT", ROOT / "test-output" / run_id)).resolve()
    output.mkdir(parents=True, exist_ok=True)
    base = acceptance.image_ref("gui")
    env[acceptance.image_env("gui")] = base
    cache = acceptance.cache_key(env.get("VTB_ACCEPTANCE_CACHE_KEY", str(ROOT)))
    print(f"Output: {output}", flush=True)
    with acceptance.exclusive_lock(str(ROOT)), acceptance.exclusive_lock(cache):
        status = acceptance.prepare_images(["gui"], env, output)
        if status:
            return status
        image = f"vtb-colima-gui:{run_id}"
        status = acceptance.run(["docker", "build", "--build-arg", f"GUI_BASE_IMAGE={base}", "-f", "docker/gui-colima-test-runner.Dockerfile", "-t", image, "docker"], env, output, "image")
        if status:
            return status
        home = Path(tempfile.mkdtemp(prefix=".colima-gui-acceptance-", dir=Path.home()))
        (home / ".colima-gui-acceptance").touch()
        command = ["docker", "run", "--rm", "--name", run_id, "--network", "host", "--shm-size", "1g",
                   "-v", f"{ROOT}:/app", "-v", f"{home}:{home}", "-v", "/var/run/docker.sock:/var/run/docker.sock",
                   "-v", f"{output}:/app/test-output", "-e", f"HOME={home}", "-e", "CARGO_HOME=/cargo",
                   "-e", "RUSTUP_HOME=/usr/local/rustup", "-e", "npm_config_cache=/npm-cache",
                   "-e", "GUI_ACCEPTANCE_SCREENSHOTS=all", "-e", "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1"]
        for kind, target in [("cargo", "/cargo"), ("target", "/app/target"), ("rustup", "/usr/local/rustup"), ("npm", "/npm-cache"), ("colima-node", "/app/crates/gui/node_modules")]:
            volume = f"{cache}-{kind}"
            subprocess.run(["docker", "volume", "create", volume], check=True, stdout=subprocess.DEVNULL)
            command.extend(["-v", f"{volume}:{target}"])
        command.extend([image, "bash", "/app/docker/gui-colima-entrypoint.sh"])
        try:
            return acceptance.run(command, env, output, "gui")
        finally:
            subprocess.run(["docker", "rm", "-f", run_id], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            cleanup_backend(home, context)
            shutil.rmtree(home)


if __name__ == "__main__":
    raise SystemExit(main())
