#!/usr/bin/env bash
# Source from Docker entrypoints. Commands retain their original exit status.
acceptance_time() {
    local phase="$1" started finished result=0
    shift
    started=$(date +%s%N)
    "$@" || result=$?
    finished=$(date +%s%N)
    mkdir -p /app/test-output
    printf '{"phase":"%s","duration_ms":%s,"exit_code":%s}\n' \
        "$phase" "$(( (finished - started) / 1000000 ))" "$result" \
        | tee -a "/app/test-output/${ACCEPTANCE_SUITE}-timings.jsonl"
    return "$result"
}
