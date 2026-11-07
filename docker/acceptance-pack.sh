#!/usr/bin/env bash
set -euo pipefail
suite="$1"
test_binary="$2"
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/target/debug/acceptance-tests"

for binary in vtb vtb-daemon mock-claude mock-codex; do
    install -m 0755 "/app/target/debug/$binary" "$staging/target/debug/$binary"
done
install -m 0755 "$test_binary" "$staging/target/debug/acceptance-tests/$suite"
cp /app/test-output/runtime-manifest.json "$staging/acceptance-runtime.json"

paths=(-C "$staging" acceptance-runtime.json target)
if [ "$suite" = gui ]; then
    for binary in gui vtb-gate; do
        install -m 0755 "/app/target/debug/$binary" "$staging/target/debug/$binary"
    done
    paths+=(-C /app crates/gui/node_modules)
fi

tar -czf /app/test-output/runtime.tar.gz "${paths[@]}"
