#!/usr/bin/env bash
# One producer per suite; no backend or scenario state is created here.
set -euo pipefail
suite="$1"
export ACCEPTANCE_SUITE="$suite"
source /app/docker/acceptance-timing.sh
mkdir -p /app/test-output

if [ "$suite" = gui ]; then
    (cd /app/crates/gui && acceptance_time npm-install npm ci --prefer-offline)
    acceptance_time build-sidecars env SIDECAR_PROFILE=debug node /app/crates/gui/scripts/prepare-sidecars.mjs
    acceptance_time build-gui env VERTEBRAE_BUNDLE_SIDECARS=1 cargo build --locked -p gui --bin gui --quiet
    crate=gui-acceptance
    test_name=gui_acceptance
elif [ "$suite" = daemon ] || [ "$suite" = cli ]; then
    acceptance_time build-components cargo build --locked --quiet --bin vtb --bin vtb-daemon
    if [ "$suite" = daemon ]; then
        crate=daemon-acceptance
        test_name=daemon_acceptance
    else
        crate=acceptance
        test_name=acceptance
    fi
else
    echo "Unknown acceptance suite: $suite" >&2
    exit 2
fi

acceptance_time build-mocks cargo build --locked --quiet -p daemon-acceptance --bin mock-claude --bin mock-codex
cargo test --locked -p "$crate" --test "$test_name" --no-run --message-format=json > /app/test-output/build-tests.jsonl
