#!/usr/bin/env bash
set -euo pipefail
source /app/docker/acceptance-timing.sh
ACCEPTANCE_SUITE=gui
cleanup() {
    for process_id in "${TAURI_DRIVER_PID:-}" "${VITE_PID:-}" "${XVFB_PID:-}"; do
        if [ -n "$process_id" ]; then
            kill "$process_id" 2>/dev/null || true
        fi
    done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Copy the base config to a writable location — tests need to register/unregister
# per-scenario projects into this file.
cp /root/.config/vertebrae/config.toml.base /root/.config/vertebrae/config.toml

# Start Xvfb manually (xvfb-run's SIGUSR1-based readiness check is unreliable
# in Docker containers). Poll with xdpyinfo instead.
# Clean up any lock left by a previous run first.
pkill -f "Xvfb :99" 2>/dev/null || true
rm -f /tmp/.X99-lock
echo "==> Starting Xvfb on :99..."
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp &
XVFB_PID=$!
export DISPLAY=:99

for i in $(seq 1 40); do
    if xdpyinfo -display :99 >/dev/null 2>&1; then
        echo "==> Xvfb ready"
        break
    fi
    if [ $i -eq 40 ]; then
        echo "ERROR: Xvfb did not become ready in time"
        exit 1
    fi
    sleep 0.5
done

# Install frontend dependencies
echo "==> Installing frontend dependencies..."
cd /app/crates/gui
acceptance_time npm-install npm ci --prefer-offline

# Start Vite dev server in the background — the debug Tauri binary connects to
# localhost:1420 rather than serving embedded assets.
echo "==> Starting Vite dev server on port 1420..."
npm run dev &
VITE_PID=$!

# Wait for Vite to be ready
for i in $(seq 1 30); do
    if curl -sf http://localhost:1420 >/dev/null 2>&1; then
        echo "==> Vite dev server ready"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "ERROR: Vite dev server did not become ready in time"
        exit 1
    fi
    sleep 1
done
cd /app

# Stage the vtb/vtb-daemon/vtb-gate sidecars before building the GUI: Tauri's build
# script validates that every `externalBin` declared in tauri.conf.json exists
# for the active target triple, so they must be present first.
echo "==> Staging vtb/vtb-daemon/vtb-gate sidecars (debug)..."
acceptance_time build-sidecars env SIDECAR_PROFILE=debug node /app/crates/gui/scripts/prepare-sidecars.mjs

# Build the Tauri app and mock-claude (debug mode for speed). The sidecars
# were already built by the sidecar staging step above.
echo "==> Building Tauri app, mock Claude/Codex binaries..."
acceptance_time build-gui env VERTEBRAE_BUNDLE_SIDECARS=1 cargo build --locked -p gui --bin gui --quiet
acceptance_time build-mocks cargo build --locked -p daemon-acceptance --bin mock-claude --bin mock-codex --quiet

# Install the component binaries that the GUI expects to find on a normal
# machine. The files in data_bin are the managed install; ~/.local/bin contains
# only the user-facing symlinks. This keeps the acceptance precondition aligned
# with installer::installed_at_symlink_path instead of using marker files.
echo "==> Installing prebuilt GUI component binaries..."
GUI_DATA_BIN="/root/.local/share/vertebrae/bin"
GUI_LINK_BIN="/root/.local/bin"
mkdir -p "$GUI_DATA_BIN" "$GUI_LINK_BIN"
export PATH="$GUI_LINK_BIN:$PATH"
for component in vtb vtb-daemon vtb-gate; do
    source_binary="/app/target/debug/$component"
    if [ ! -x "$source_binary" ]; then
        echo "ERROR: expected GUI component binary at $source_binary"
        exit 1
    fi
    install -m 0755 "$source_binary" "$GUI_DATA_BIN/$component"
    rm -f "$GUI_LINK_BIN/$component"
    ln -s "$GUI_DATA_BIN/$component" "$GUI_LINK_BIN/$component"
done

for component in vtb vtb-daemon vtb-gate; do
    test -L "$GUI_LINK_BIN/$component"
    test "$(readlink "$GUI_LINK_BIN/$component")" = "$GUI_DATA_BIN/$component"
    test -x "$GUI_LINK_BIN/$component"
    command -v "$component" >/dev/null
done
echo "==> GUI component prerequisites installed in $GUI_DATA_BIN"

# Install mock-claude where the daemon expects it.
ln -sf /app/target/debug/mock-claude /usr/local/bin/mock-claude
ln -sf /app/target/debug/mock-codex /usr/local/bin/mock-codex
export CLAUDE_CODE_PATH=/usr/local/bin/mock-claude
export CODEX_PATH=/usr/local/bin/mock-codex
mkdir -p /mocks
export MOCK_OUTPUT_DIR=/mocks

# Start tauri-driver in the background on port 4444
echo "==> Starting tauri-driver on port 4444..."
tauri-driver --port 4444 &
TAURI_DRIVER_PID=$!

# Check the listening socket instead of paying a fixed startup delay.
for i in $(seq 1 100); do
    if (echo > /dev/tcp/127.0.0.1/4444) 2>/dev/null; then
        break
    fi
    if ! kill -0 "$TAURI_DRIVER_PID" 2>/dev/null || [ "$i" -eq 100 ]; then
        echo "ERROR: tauri-driver failed to become ready" >&2
        exit 1
    fi
    sleep 0.1
done

echo "==> Running GUI acceptance tests..."
acceptance_time build-tests cargo test --locked -p gui-acceptance --test gui_acceptance --no-run
acceptance_time scenarios cargo test --locked -p gui-acceptance --test gui_acceptance -- "$@"
