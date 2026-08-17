#!/usr/bin/env bash

set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${VTB_UPDATE_PRIVATE_KEY:?VTB_UPDATE_PRIVATE_KEY is required}"
: "${VTB_UPDATE_PUBLIC_KEY:?VTB_UPDATE_PUBLIC_KEY is required}"
: "${ARTIFACT_TAG:?ARTIFACT_TAG is required}"
: "${UPDATE_SHA:?UPDATE_SHA is required}"
: "${UPDATE_CHANNEL:?UPDATE_CHANNEL is required}"
: "${CHANNEL_TAG:?CHANNEL_TAG is required}"
: "${UPDATE_VERSION:?UPDATE_VERSION is required}"
: "${UPDATE_BUILD:?UPDATE_BUILD is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

case "$UPDATE_CHANNEL" in
  master) release_label=edge ;;
  release) release_label=stable ;;
  *)
    echo "Unsupported update channel: $UPDATE_CHANNEL" >&2
    exit 1
    ;;
esac

ensure_release() {
  local release_tag="$1"
  shift

  # A fixed channel release is expected to exist on reruns. Check first so
  # expected reuse does not emit a release-creation conflict. A missing
  # release is the normal first-publish case; creation failures remain visible.
  if gh release view "$release_tag" >/dev/null 2>&1; then
    return 0
  fi
  gh release create "$release_tag" "$@"
}

if [[ "$ARTIFACT_TAG" == "$CHANNEL_TAG" ]]; then
  # The preview channel is both the moving pointer and the artifact store.
  # Asset names include the build identity, so uploads are collision-free while
  # stale assets are pruned after the publish completes.
  ensure_release "$ARTIFACT_TAG" \
    --target "$UPDATE_SHA" \
    --title "$UPDATE_CHANNEL channel" \
    --notes "Signed preview component artifacts"
else
  gh release create "$ARTIFACT_TAG" \
    --target "$UPDATE_SHA" \
    --title "Vertebrae [$release_label] $UPDATE_VERSION ($UPDATE_BUILD)" \
    --notes "Signed immutable component artifacts for the $release_label channel."
fi

existing_assets=""
if [[ "$ARTIFACT_TAG" == "$CHANNEL_TAG" ]]; then
  existing_assets="$(gh release view "$ARTIFACT_TAG" --json assets --jq '.assets[].name')"
fi

keep_assets=()
record_kept_asset() {
  local asset_name="$1"
  keep_assets+=("$asset_name")
}

upload_unique_asset() {
  local artifact="$1"
  local asset_name="${2:-$(basename "$artifact")}"

  # Re-running a master build for the same SHA should not replace an existing
  # signed asset. Stable releases intentionally fail if an asset already exists.
  if [[ "$ARTIFACT_TAG" == "$CHANNEL_TAG" ]] \
    && grep -Fxq "$asset_name" <<<"$existing_assets"; then
    record_kept_asset "$asset_name"
    return
  fi
  gh release upload "$ARTIFACT_TAG" "$artifact#$asset_name" --clobber=false
  record_kept_asset "$asset_name"
  if [[ "$ARTIFACT_TAG" == "$CHANNEL_TAG" ]]; then
    existing_assets+=$'\n'"$asset_name"
  fi
}

for target_dir in release-input/binaries-*; do
  for artifact in "$target_dir"/*; do
    upload_unique_asset "$artifact"
  done
done

mkdir -p gui-assets
copy_gui_asset() {
  local platform="$1"
  local input_dir="$2"
  local pattern="$3"
  local key="${platform//-/_}"
  local artifact
  artifact="$(find "release-input/$input_dir" -type f -name "$pattern" ! -name '*.sig' | head -1)"
  if [[ -z "$artifact" || ! -f "$artifact.sig" ]]; then
    echo "Missing signed GUI artifact for $platform" >&2
    exit 1
  fi

  local suffix
  case "$(basename "$artifact")" in
    *.app.tar.gz) suffix='.app.tar.gz' ;;
    *.AppImage) suffix='.AppImage' ;;
    *.AppImage.tar.gz) suffix='.AppImage.tar.gz' ;;
    *)
      echo "Unsupported GUI artifact format for $platform: $(basename "$artifact")" >&2
      exit 1
      ;;
  esac
  local asset="vertebrae-gui-$platform-$UPDATE_VERSION-$UPDATE_BUILD$suffix"
  cp "$artifact" "gui-assets/$asset"
  cp "$artifact.sig" "gui-assets/$asset.sig"
  printf '%s_artifact=gui-assets/%s\n' "$key" "$asset" >> gui-assets/paths.env
  printf '%s_signature=gui-assets/%s.sig\n' "$key" "$asset" >> gui-assets/paths.env
  upload_unique_asset "gui-assets/$asset"
  upload_unique_asset "gui-assets/$asset.sig"
}

: > gui-assets/paths.env
copy_gui_asset darwin-aarch64 gui-macos-26 '*.app.tar.gz'
copy_gui_asset linux-x86_64 gui-ubuntu-22.04 '*.AppImage*'
source gui-assets/paths.env

node scripts/create-gui-update-manifest.mjs \
  --version "$UPDATE_VERSION" \
  --build "$UPDATE_BUILD" \
  --base-url "https://github.com/$GITHUB_REPOSITORY/releases/download/$ARTIFACT_TAG" \
  --darwin-aarch64-artifact "$darwin_aarch64_artifact" \
  --darwin-aarch64-signature "$darwin_aarch64_signature" \
  --linux-x86_64-artifact "$linux_x86_64_artifact" \
  --linux-x86_64-signature "$linux_x86_64_signature" \
  --output gui-assets/gui-latest.json

# The channel release is a mutable pointer to signed metadata. For master it
# is also the artifact release; for stable it remains a separate pointer.
if [[ "$ARTIFACT_TAG" != "$CHANNEL_TAG" ]]; then
  ensure_release "$CHANNEL_TAG" \
    --target "$UPDATE_SHA" \
    --title "$UPDATE_CHANNEL channel" \
    --notes "Signed channel metadata"
fi
gh release upload "$CHANNEL_TAG" gui-assets/gui-latest.json --clobber
if [[ "$ARTIFACT_TAG" == "$CHANNEL_TAG" ]]; then
  record_kept_asset "gui-latest.json"
fi

mkdir -p manifests
for target in \
  aarch64-apple-darwin \
  aarch64-unknown-linux-gnu \
  x86_64-unknown-linux-gnu; do
  manifest_args=(
    --channel "$UPDATE_CHANNEL"
    --version "$UPDATE_VERSION"
    --build "$UPDATE_BUILD"
    --target "$target"
    --base-url "https://github.com/$GITHUB_REPOSITORY/releases/download/$ARTIFACT_TAG"
  )
  case "$target" in
    aarch64-apple-darwin) manifest_args+=(--gui "$darwin_aarch64_artifact") ;;
    x86_64-unknown-linux-gnu) manifest_args+=(--gui "$linux_x86_64_artifact") ;;
  esac
  manifest_args+=(
    --cli "$(find "release-input/binaries-$target" -name "vtb-$UPDATE_VERSION-*" -type f | head -1)" \
    --daemon "$(find "release-input/binaries-$target" -name 'vtb-daemon-*' -type f | head -1)" \
    --gate "$(find "release-input/binaries-$target" -name 'vtb-gate-*' -type f | head -1)" \
    --output "manifests/latest-$target.json"
  )
  node scripts/create-release-manifest.mjs "${manifest_args[@]}"
done

if [[ "$ARTIFACT_TAG" == "$CHANNEL_TAG" ]]; then
  gh release upload "$CHANNEL_TAG" manifests/latest-*.json --clobber
else
  gh release upload "$ARTIFACT_TAG" manifests/latest-*.json --clobber=false
  gh release upload "$CHANNEL_TAG" manifests/latest-*.json --clobber
fi
if [[ "$ARTIFACT_TAG" == "$CHANNEL_TAG" ]]; then
  for manifest in manifests/latest-*.json; do
    record_kept_asset "$(basename "$manifest")"
  done
fi

if [[ "$UPDATE_CHANNEL" == "master" && "$ARTIFACT_TAG" == "$CHANNEL_TAG" ]]; then
  current_assets="$(gh release view "$ARTIFACT_TAG" --json assets --jq '.assets[].name')"
  while IFS= read -r asset_name; do
    [ -n "$asset_name" ] || continue
    keep=0
    for kept_asset in "${keep_assets[@]}"; do
      if [[ "$asset_name" == "$kept_asset" ]]; then
        keep=1
        break
      fi
    done
    if [ "$keep" -eq 0 ]; then
      gh release delete-asset "$ARTIFACT_TAG" "$asset_name" --yes
    fi
  done <<< "$current_assets"
fi
