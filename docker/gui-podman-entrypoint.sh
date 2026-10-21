#!/usr/bin/env bash
# A real rootless Podman lane in the disposable GUI acceptance container.
set -euo pipefail
if [ "$(id -u)" -eq 0 ]; then
    test_binary=$(python3 -c 'import json; records=[json.loads(line) for line in open("/tmp/gui-acceptance-build.jsonl") if line.startswith("{")]; print(next(r["executable"] for r in records if r.get("reason")=="compiler-artifact" and r.get("target",{}).get("name")=="gui_acceptance" and r.get("executable")))')
    install -d -o podmantest -g podmantest -m 0700 /run/user/1000
    install -d -o podmantest -g podmantest /home/podmantest/.local/share/vertebrae/bin /home/podmantest/.local/bin /app/test-output/podman
    for component in vtb vtb-daemon vtb-gate; do
        install -o podmantest -g podmantest -m 0755 "/app/target/debug/$component" "/home/podmantest/.local/share/vertebrae/bin/$component"
        ln -sf "/home/podmantest/.local/share/vertebrae/bin/$component" "/home/podmantest/.local/bin/$component"
    done
    chown -R podmantest:podmantest /home/podmantest/.local
    # Retain SYS_ADMIN only inside the already privileged outer container so
    # kernels restricting unprivileged user namespaces allow nested rootless
    # re-exec. The engine still runs as UID 1000 with a real subuid/subgid map.
    exec setpriv --reuid=1000 --regid=1000 --init-groups \
        --inh-caps=+sys_admin --ambient-caps=+sys_admin env -u VTB_URL -u VTB_TOKEN -u VTB_PROJECT_ID \
        HOME=/home/podmantest XDG_CONFIG_HOME=/home/podmantest/.config \
        XDG_DATA_HOME=/home/podmantest/.local/share XDG_RUNTIME_DIR=/run/user/1000 \
        PATH=/home/podmantest/.local/bin:/usr/local/bin:/usr/bin:/bin \
        MOCK_CAPTURE_DIR=/home/podmantest/harness-capture GUI_ACCEPTANCE_PODMAN=1 WEBDRIVER_URL=http://localhost:4454 DISPLAY=:100 \
        ACCEPTANCE_OUTPUT_DIR=/app/test-output/podman \
        /bin/bash "$0" "$test_binary"
fi

cleanup() {
    for process_id in "${DRIVER_PID:-}" "${HEALTH_PID:-}" "${API_PID:-}" "${XVFB_PID:-}"; do
        if [ -n "$process_id" ]; then kill "$process_id" 2>/dev/null || true; fi
    done
    # This user/storage exists only in this disposable runner. Never a host socket.
    env -u CONTAINER_HOST -u CONTAINER_CONNECTION podman --remote=false rm --all --force >/dev/null 2>&1 || true
    env -u CONTAINER_HOST -u CONTAINER_CONNECTION podman --remote=false volume rm --all --force >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$HOME/.config/containers" "$XDG_RUNTIME_DIR/podman"
cat > "$HOME/.config/containers/storage.conf" <<'CONFIG'
[storage]
driver = "vfs"
CONFIG
cat > "$HOME/.config/containers/containers.conf" <<'CONFIG'
[containers]
cgroups = "disabled"
[engine]
cgroup_manager = "cgroupfs"
events_logger = "file"
helper_binaries_dir = ["/usr/lib/podman", "/usr/libexec/podman", "/usr/bin"]
[network]
default_rootless_network_cmd = "slirp4netns"
CONFIG
podman --remote=false info --format json > /app/test-output/podman/engine-info.json
docker-compose version > /app/test-output/podman/compose-version.txt
python3 -c 'import json; x=json.load(open("/app/test-output/podman/engine-info.json")); assert x["host"]["security"]["rootless"], "acceptance engine must be rootless"'
podman system service --time=0 "unix://$XDG_RUNTIME_DIR/podman/podman.sock" > /app/test-output/podman/api.log 2>&1 &
API_PID=$!
for attempt in $(seq 1 100); do
    if curl --silent --fail --unix-socket "$XDG_RUNTIME_DIR/podman/podman.sock" http://localhost/_ping >/dev/null; then break; fi
    if ! kill -0 "$API_PID" 2>/dev/null || [ "$attempt" -eq 100 ]; then
        echo "Rootless Podman API failed to start; see podman/api.log" >&2
        exit 1
    fi
    sleep 0.1
done
# This disposable container has no systemd user manager to schedule health checks.
# Execute the containers' real configured checks instead; never synthesize status.
(
    while true; do
        env -u CONTAINER_HOST -u CONTAINER_CONNECTION podman --remote=false ps --format '{{.ID}}' |
        while read -r container_id; do
            env -u CONTAINER_HOST -u CONTAINER_CONNECTION podman --remote=false healthcheck run "$container_id" || true
        done
        sleep 2
    done
) > /app/test-output/podman/healthchecks.log 2>&1 &
HEALTH_PID=$!
Xvfb :100 -screen 0 1280x1024x24 -nolisten tcp > /app/test-output/podman/xvfb.log 2>&1 &
XVFB_PID=$!
for attempt in $(seq 1 100); do
    if xdpyinfo -display :100 >/dev/null 2>&1; then break; fi
    if ! kill -0 "$XVFB_PID" 2>/dev/null || [ "$attempt" -eq 100 ]; then exit 1; fi
    sleep 0.1
done
# Real targeting must survive poisoned inherited engine/provider variables.
export DOCKER_HOST=tcp://127.0.0.1:9 CONTAINER_HOST=ssh://invalid.example/run/podman.sock
export CONTAINER_CONNECTION=unrelated PODMAN_COMPOSE_PROVIDER=/does/not/exist
/usr/local/cargo/bin/tauri-driver --port 4454 --native-port 4455 > /app/test-output/podman/driver.log 2>&1 &
DRIVER_PID=$!
for attempt in $(seq 1 100); do
    if (echo > /dev/tcp/127.0.0.1/4454) 2>/dev/null; then break; fi
    if ! kill -0 "$DRIVER_PID" 2>/dev/null || [ "$attempt" -eq 100 ]; then exit 1; fi
    sleep 0.1
done
cd /app/crates/gui-acceptance
"$1"
