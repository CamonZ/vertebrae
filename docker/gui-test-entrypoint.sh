#!/usr/bin/env bash
set -euo pipefail

# Build the frontend assets
echo "==> Building frontend assets..."
cd /app/crates/gui
npm ci --prefer-offline
npm run build
cd /app

# Build the Tauri app binary (debug mode for speed)
echo "==> Building Tauri app binary..."
cargo build --bin gui --quiet

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
exit $TEST_EXIT
