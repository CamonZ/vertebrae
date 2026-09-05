#!/usr/bin/env bash
set -euo pipefail
source /app/docker/acceptance-timing.sh
ACCEPTANCE_SUITE=cli
acceptance_time build-vtb cargo build --locked --bin vtb --quiet
acceptance_time build-tests cargo test --locked -p acceptance --test acceptance --no-run
acceptance_time scenarios cargo test --locked -p acceptance --test acceptance -- --concurrency 8
