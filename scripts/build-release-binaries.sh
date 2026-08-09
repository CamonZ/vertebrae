#!/usr/bin/env bash

set -euo pipefail

: "${TARGET:?TARGET is required}"
: "${UPDATE_VERSION:?UPDATE_VERSION is required}"
: "${UPDATE_BUILD:?UPDATE_BUILD is required}"

release_assets_dir="${RELEASE_ASSETS_DIR:-release-assets}"
cargo build --release --target "$TARGET" -p vertebrae-cli -p vertebrae-daemon -p vtb-gate
mkdir -p "$release_assets_dir"

for component in "vtb:vtb" "vtb-daemon:vtb-daemon" "vtb-gate:vtb-gate"; do
  name="${component%%:*}"
  source="${component##*:}"
  cp "target/$TARGET/release/$source" \
    "$release_assets_dir/$name-$UPDATE_VERSION-$UPDATE_BUILD-$TARGET"
done
