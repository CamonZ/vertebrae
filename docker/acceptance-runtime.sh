#!/usr/bin/env bash
# Sourced after acceptance-timing.sh; ordinary local runs retain the build path.
if [ "${VTB_ACCEPTANCE_PREBUILT:-0}" = 1 ]; then
    if [ ! -f /acceptance-runtime.tar.gz ]; then
        echo "Prebuilt acceptance runtime is missing; refusing to compile in a shard" >&2
        exit 1
    fi

    # The host validates the manifest; do not write metadata into the checkout.
    acceptance_time unpack-runtime tar -xzf /acceptance-runtime.tar.gz --exclude=acceptance-runtime.json -C /app
    export VTB_ACCEPTANCE_TEST_BINARY="/app/target/debug/acceptance-tests/$ACCEPTANCE_SUITE"

    for binary in vtb vtb-daemon mock-claude mock-codex; do
        test -x "/app/target/debug/$binary"
    done
    test -x "$VTB_ACCEPTANCE_TEST_BINARY"

    if [ "$ACCEPTANCE_SUITE" = gui ]; then
        test -x /app/target/debug/gui
        test -x /app/target/debug/vtb-gate
        test -x /app/crates/gui/node_modules/.bin/vite
    fi
fi
