#!/usr/bin/env bash
set -euo pipefail
feature_args=()
if [ -n "${VTB_ACCEPTANCE_FEATURE_GLOB:-}" ]; then
    feature_args=(--input "$VTB_ACCEPTANCE_FEATURE_GLOB")
fi
source /app/docker/acceptance-timing.sh
ACCEPTANCE_SUITE=cli
acceptance_time build-vtb cargo build --locked --bin vtb --bin vtb-daemon --quiet
acceptance_time build-mock cargo build --locked -p daemon-acceptance --bin mock-claude --quiet
acceptance_time build-tests cargo test --locked -p acceptance --test acceptance --no-run
acceptance_time scenarios cargo test --locked -p acceptance --test acceptance -- --concurrency 8 "${feature_args[@]}"
