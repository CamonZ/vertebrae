#!/usr/bin/env bash
set -euo pipefail

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
npm ci --prefer-offline

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

# Build the Tauri app, vtb CLI, vtb-daemon, and mock-claude (debug mode for speed)
echo "==> Building Tauri app, vtb, vtb-daemon, mock-claude binaries..."
cargo build --bin gui --bin vtb --bin vtb-daemon --quiet
cargo build -p daemon-acceptance --bin mock-claude --quiet

# Install mock-claude where the daemon expects it.
ln -sf /app/target/debug/mock-claude /usr/local/bin/mock-claude
export CLAUDE_CODE_PATH=/usr/local/bin/mock-claude
mkdir -p /mocks
export MOCK_OUTPUT_DIR=/mocks

# Start tauri-driver in the background on port 4444
echo "==> Starting tauri-driver on port 4444..."
tauri-driver --port 4444 &
TAURI_DRIVER_PID=$!

# Give tauri-driver a moment to bind
sleep 1

# Verify tauri-driver is running
if ! kill -0 "$TAURI_DRIVER_PID" 2>/dev/null; then
    echo "ERROR: tauri-driver failed to start"
    exit 1
fi
echo "==> tauri-driver started (PID: $TAURI_DRIVER_PID)"

# Run the GUI acceptance tests
echo "==> Running GUI acceptance tests..."
cargo test -p gui-acceptance --test gui_acceptance
TEST_EXIT=$?

# Cleanup
kill "$TAURI_DRIVER_PID" 2>/dev/null || true
kill "$VITE_PID" 2>/dev/null || true
kill "$XVFB_PID" 2>/dev/null || true
exit $TEST_EXIT
