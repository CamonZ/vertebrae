#!/usr/bin/env bash
set -euo pipefail
ulimit -c 0
cleanup() {
    for process_id in "${driver_pid:-}" "${vite_pid:-}" "${xvfb_pid:-}"; do
        if [ -n "$process_id" ]; then kill "$process_id" 2>/dev/null || true; fi
    done
}
trap cleanup EXIT
export PATH="$HOME/.local/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin"
export DISPLAY=:99 GUI_ACCEPTANCE_COLIMA=1 GSETTINGS_BACKEND=memory
export XDG_CACHE_HOME=/tmp/colima-gui-cache XDG_RUNTIME_DIR=/tmp/colima-gui-runtime
mkdir -p "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
chmod 0700 "$XDG_RUNTIME_DIR"
test -f "$HOME/.colima-gui-acceptance"
! command -v podman
docker context create colima --docker host=unix:///var/run/docker.sock
docker context use colima
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp &
xvfb_pid=$!
for attempt in $(seq 1 50); do
    if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
    sleep 0.1
done
cd /app/crates/gui
npm ci --prefer-offline
npm run dev -- --host 127.0.0.1 &
vite_pid=$!
cd /app
env SIDECAR_PROFILE=debug node crates/gui/scripts/prepare-sidecars.mjs
env VERTEBRAE_BUNDLE_SIDECARS=1 cargo build --locked -p gui --bin gui --quiet
cargo build --locked -p daemon-acceptance --bin mock-claude --bin mock-codex --quiet
# Component installation is a fixture; backend/project setup remains entirely UI-driven.
mkdir -p "$HOME/.local/share/vertebrae/bin" "$HOME/.local/bin" /mocks
for component in vtb vtb-daemon vtb-gate; do
    install -m 0755 "/app/target/debug/$component" "$HOME/.local/share/vertebrae/bin/$component"
    ln -s "$HOME/.local/share/vertebrae/bin/$component" "$HOME/.local/bin/$component"
done
ln -sf /app/target/debug/mock-claude /usr/local/bin/mock-claude
ln -sf /app/target/debug/mock-codex /usr/local/bin/mock-codex
export CLAUDE_CODE_PATH=/usr/local/bin/mock-claude CODEX_PATH=/usr/local/bin/mock-codex
export MOCK_OUTPUT_DIR=/mocks MOCK_CAPTURE_DIR=/tmp/gui-acceptance-harness-capture
tauri-driver --port 4444 &
driver_pid=$!
for attempt in $(seq 1 100); do
    if (echo > /dev/tcp/127.0.0.1/4444) 2>/dev/null; then break; fi
    sleep 0.1
done
cargo test --locked -p gui-acceptance --test gui_acceptance -- --tags @colima
