#!/usr/bin/env bash

set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${VTB_UPDATE_PRIVATE_KEY:?VTB_UPDATE_PRIVATE_KEY is required}"
: "${VTB_UPDATE_PUBLIC_KEY:?VTB_UPDATE_PUBLIC_KEY is required}"
: "${IMMUTABLE_RELEASE_TAG:?IMMUTABLE_RELEASE_TAG is required}"
: "${UPDATE_SHA:?UPDATE_SHA is required}"
: "${UPDATE_CHANNEL:?UPDATE_CHANNEL is required}"
: "${CHANNEL_TAG:?CHANNEL_TAG is required}"
: "${UPDATE_VERSION:?UPDATE_VERSION is required}"
: "${UPDATE_BUILD:?UPDATE_BUILD is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

gh release create "$IMMUTABLE_RELEASE_TAG" \
  --target "$UPDATE_SHA" \
  --title "$UPDATE_CHANNEL components $UPDATE_VERSION ($UPDATE_BUILD)" \
  --notes "Signed immutable component artifacts for the $UPDATE_CHANNEL channel."

for target_dir in release-input/binaries-*; do
  for artifact in "$target_dir"/*; do
    gh release upload "$IMMUTABLE_RELEASE_TAG" "$artifact#$(basename "$artifact")" --clobber=false
  done
done

mkdir -p gui-assets
copy_gui_asset() {
  local platform="$1"
  local input_dir="$2"
  local pattern="$3"
  local key="${platform//-/_}"
  local artifact
  artifact="$(find "release-input/$input_dir" -type f -name "$pattern" | head -1)"
  if [[ -z "$artifact" || ! -f "$artifact.sig" ]]; then
    echo "Missing signed GUI artifact for $platform" >&2
    exit 1
  fi

  local suffix
  suffix="$(basename "$artifact" | sed 's/^.*\(\.app\.tar\.gz\|\.AppImage\.tar\.gz\)$/\1/')"
  local asset="vertebrae-gui-$platform$suffix"
  cp "$artifact" "gui-assets/$asset"
  cp "$artifact.sig" "gui-assets/$asset.sig"
  printf '%s_artifact=gui-assets/%s\n' "$key" "$asset" >> gui-assets/paths.env
  printf '%s_signature=gui-assets/%s.sig\n' "$key" "$asset" >> gui-assets/paths.env
  gh release upload "$IMMUTABLE_RELEASE_TAG" \
    "gui-assets/$asset" "gui-assets/$asset.sig" --clobber=false
}

: > gui-assets/paths.env
copy_gui_asset darwin-aarch64 gui-macos-14 '*.app.tar.gz'
copy_gui_asset darwin-x86_64 gui-macos-13 '*.app.tar.gz'
copy_gui_asset linux-x86_64 gui-ubuntu-22.04 '*.AppImage.tar.gz'
source gui-assets/paths.env

node scripts/create-gui-update-manifest.mjs \
  --version "$UPDATE_VERSION" \
  --base-url "https://github.com/$GITHUB_REPOSITORY/releases/download/$IMMUTABLE_RELEASE_TAG" \
  --darwin-aarch64-artifact "$darwin_aarch64_artifact" \
  --darwin-aarch64-signature "$darwin_aarch64_signature" \
  --darwin-x86_64-artifact "$darwin_x86_64_artifact" \
  --darwin-x86_64-signature "$darwin_x86_64_signature" \
  --linux-x86_64-artifact "$linux_x86_64_artifact" \
  --linux-x86_64-signature "$linux_x86_64_signature" \
  --output gui-assets/gui-latest.json

# The channel release is a mutable pointer to signed metadata. Creation is
# intentionally idempotent because it may already exist from an earlier run.
gh release create "$CHANNEL_TAG" \
  --target "$UPDATE_SHA" \
  --title "$UPDATE_CHANNEL channel" \
  --notes "Signed channel metadata" || true
gh release upload "$CHANNEL_TAG" gui-assets/gui-latest.json --clobber

mkdir -p manifests
for target in \
  aarch64-apple-darwin \
  x86_64-apple-darwin \
  aarch64-unknown-linux-gnu \
  x86_64-unknown-linux-gnu; do
  node scripts/create-release-manifest.mjs \
    --channel "$UPDATE_CHANNEL" \
    --version "$UPDATE_VERSION" \
    --build "$UPDATE_BUILD" \
    --target "$target" \
    --base-url "https://github.com/$GITHUB_REPOSITORY/releases/download/$IMMUTABLE_RELEASE_TAG" \
    --cli "$(find "release-input/binaries-$target" -name "vtb-$UPDATE_VERSION-*" -type f | head -1)" \
    --daemon "$(find "release-input/binaries-$target" -name 'vtb-daemon-*' -type f | head -1)" \
    --gate "$(find "release-input/binaries-$target" -name 'vtb-gate-*' -type f | head -1)" \
    --output "manifests/latest-$target.json"
done

gh release upload "$IMMUTABLE_RELEASE_TAG" manifests/latest-*.json --clobber=false
gh release upload "$CHANNEL_TAG" manifests/latest-*.json --clobber
