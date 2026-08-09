#!/usr/bin/env bash
# Build Vertebrae's Rust sidecars, stage them for Tauri, then build the GUI bundle.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${SIDECAR_PROFILE:-release}"
RUN_AFTER_BUILD=0
BUNDLES="${TAURI_BUNDLES:-}"
LOCAL_TAURI_CONFIG="src-tauri/tauri.local.conf.json"

if [ -z "$BUNDLES" ] && [ "$(uname -s)" = "Darwin" ]; then
  BUNDLES="app"
fi

usage() {
  cat <<EOF
Usage: scripts/build-package.sh [--debug|--release] [--bundles <list>] [--run]

Builds vtb, vtb-daemon, and vtb-gate, stages them through
crates/gui/scripts/prepare-sidecars.mjs, then builds the Tauri GUI bundle.

Local bundles do not create signed updater artifacts or use platform signing.
Release artifacts are signed by the release workflow.

Options:
  --debug     Build debug sidecars and a debug GUI bundle
  --release   Build release sidecars and a release GUI bundle (default)
  --bundles   Bundle formats to pass to Tauri (defaults to app on macOS)
  --run       Launch the built macOS .app after bundling
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --debug)
      PROFILE=debug
      ;;
    --release)
      PROFILE=release
      ;;
    --run)
      RUN_AFTER_BUILD=1
      ;;
    --bundles)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --bundles requires a value" >&2
        exit 2
      fi
      BUNDLES="$2"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ "$PROFILE" != "debug" ] && [ "$PROFILE" != "release" ]; then
  echo "ERROR: SIDECAR_PROFILE must be debug or release" >&2
  exit 2
fi

bundle_list_includes() {
  local wanted="$1"
  local bundle

  for bundle in ${BUNDLES//,/ }; do
    if [ "$bundle" = "$wanted" ] || [ "$bundle" = "all" ]; then
      return 0
    fi
  done

  return 1
}

latest_rw_dmg_name() {
  local macos_dir="$1"
  local dmg_dir="$2"
  local image
  local latest=""

  for image in "$macos_dir"/rw.*.dmg "$dmg_dir"/rw.*.dmg; do
    [ -e "$image" ] || continue
    if [ -z "$latest" ] || [ "$image" -nt "$latest" ]; then
      latest="$image"
    fi
  done

  if [ -z "$latest" ]; then
    return 1
  fi

  local name
  name="$(basename "$latest")"
  name="${name#rw.}"
  printf '%s\n' "${name#*.}"
}

remove_dmg_artifacts() {
  local macos_dir="$1"
  local dmg_dir="$2"
  local dmg_name="$3"
  local image

  rm -f "$macos_dir/$dmg_name" "$dmg_dir/$dmg_name"
  for image in "$macos_dir"/rw.*."$dmg_name" "$dmg_dir"/rw.*."$dmg_name"; do
    [ -e "$image" ] && rm -f "$image"
  done
}

retry_dmg_without_finder() {
  if [ "$(uname -s)" != "Darwin" ] || ! bundle_list_includes dmg; then
    return 1
  fi

  local bundle_root="$REPO_ROOT/target/$PROFILE/bundle"
  local macos_dir="$bundle_root/macos"
  local dmg_dir="$bundle_root/dmg"
  local dmg_script="$dmg_dir/bundle_dmg.sh"

  if [ ! -x "$dmg_script" ] || [ ! -d "$macos_dir" ]; then
    return 1
  fi

  local app_path
  app_path="$(find "$macos_dir" -maxdepth 1 -type d -name "*.app" -print -quit)"
  if [ -z "$app_path" ]; then
    return 1
  fi

  local app_name
  local product_name
  local dmg_name
  app_name="$(basename "$app_path")"
  product_name="${app_name%.app}"
  if ! dmg_name="$(latest_rw_dmg_name "$macos_dir" "$dmg_dir")"; then
    return 1
  fi

  echo "==> Tauri DMG bundling failed; retrying without Finder window customization..."
  echo "    This skips create-dmg's AppleScript layout step, but keeps the app and Applications link."

  remove_dmg_artifacts "$macos_dir" "$dmg_dir" "$dmg_name"

  local dmg_args=(
    --skip-jenkins
    --volname "$product_name"
    --app-drop-link 480 170
  )
  if [ -f "$dmg_dir/icon.icns" ]; then
    dmg_args+=(--volicon "../dmg/icon.icns")
  fi
  dmg_args+=("$dmg_name" "$app_name")

  (cd "$macos_dir" && "$dmg_script" "${dmg_args[@]}")

  mkdir -p "$dmg_dir"
  mv -f "$macos_dir/$dmg_name" "$dmg_dir/$dmg_name"
  echo "==> DMG fallback complete: target/$PROFILE/bundle/dmg/$dmg_name"
}

export SIDECAR_PROFILE="$PROFILE"
export VERTEBRAE_BUNDLE_SIDECARS=1

echo "==> Preparing $PROFILE Tauri sidecars..."
(cd "$REPO_ROOT/crates/gui" && npm run tauri:prepare-sidecars -- --profile "$PROFILE")

echo "==> Building $PROFILE Tauri bundle..."
TAURI_BUILD_ARGS=()
TAURI_BUILD_ARGS+=(--config "$LOCAL_TAURI_CONFIG")
if [ "$PROFILE" = "debug" ]; then
  TAURI_BUILD_ARGS+=(--debug)
fi
if [ -n "$BUNDLES" ]; then
  TAURI_BUILD_ARGS+=(--bundles "$BUNDLES")
fi
if [ "$(uname -s)" = "Darwin" ]; then
  TAURI_BUILD_ARGS+=(--no-sign)
fi
echo "    Local bundle: updater artifacts disabled; platform signing disabled"
set +e
(cd "$REPO_ROOT/crates/gui" && npm run tauri:build -- "${TAURI_BUILD_ARGS[@]}")
TAURI_BUILD_STATUS=$?
set -e
if [ "$TAURI_BUILD_STATUS" -ne 0 ]; then
  if ! retry_dmg_without_finder; then
    exit "$TAURI_BUILD_STATUS"
  fi
fi

if [ "$RUN_AFTER_BUILD" -eq 1 ]; then
  case "$(uname -s)" in
    Darwin)
      open "$REPO_ROOT/target/$PROFILE/bundle/macos/Vertebrae.app"
      ;;
    *)
      echo "Built GUI bundles under target/$PROFILE/bundle."
      echo "--run is currently automatic only on macOS; launch the Linux bundle for your target format from that directory."
      ;;
  esac
fi

cat <<EOF

Build complete.
  CLI:    target/$PROFILE/vtb
  Daemon: target/$PROFILE/vtb-daemon
  Gate:   target/$PROFILE/vtb-gate
  GUI:    target/$PROFILE/bundle/
EOF
