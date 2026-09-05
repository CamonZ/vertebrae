#!/usr/bin/env bash
# Entrypoint for the daemon-acceptance test runner. Builds the binaries,
# symlinks the provider mocks to the paths the daemon looks up,
# writes the Sacrum config, and hands off to cargo test.

set -euo pipefail
source /app/docker/acceptance-timing.sh
ACCEPTANCE_SUITE=daemon

: "${VTB_URL:=http://localhost:4000}"
: "${VTB_TOKEN:?VTB_TOKEN must be set}"
: "${MOCK_OUTPUT_DIR:=/mocks}"

echo "==> Building vtb, vtb-daemon, and provider mocks..."
acceptance_time build-components cargo build --locked --quiet --bin vtb --bin vtb-daemon
acceptance_time build-mocks cargo build --locked --quiet -p daemon-acceptance --bin mock-claude --bin mock-codex

echo "==> Installing mock-claude to /usr/local/bin/mock-claude..."
ln -sf /app/target/debug/mock-claude /usr/local/bin/mock-claude
if [ ! -x /usr/local/bin/mock-claude ]; then
    echo "ERROR: mock-claude is not executable at /usr/local/bin/mock-claude" >&2
    exit 1
fi
ln -sf /app/target/debug/mock-codex /usr/local/bin/mock-codex
if [ ! -x /usr/local/bin/mock-codex ]; then
    echo "ERROR: mock-codex is not executable at /usr/local/bin/mock-codex" >&2
    exit 1
fi

echo "==> Writing ~/.config/vertebrae/config.toml..."
mkdir -p /root/.config/vertebrae
cat > /root/.config/vertebrae/config.toml <<EOF
[sacrum]
url = "${VTB_URL}"
token = "${VTB_TOKEN}"
EOF

mkdir -p "${MOCK_OUTPUT_DIR}"

export VTB_URL VTB_TOKEN MOCK_OUTPUT_DIR
export CLAUDE_CODE_PATH=/usr/local/bin/mock-claude
export CODEX_PATH=/usr/local/bin/mock-codex
export CUCUMBER_FILTER_TAGS="${CUCUMBER_FILTER_TAGS:-not @skip}"

echo "==> Running daemon-acceptance tests..."
acceptance_time build-tests cargo test --locked -p daemon-acceptance --test daemon_acceptance --no-run
acceptance_time scenarios cargo test --locked -p daemon-acceptance --test daemon_acceptance
