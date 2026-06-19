#!/usr/bin/env bash
# Build Vertebrae's Rust sidecars, stage them for Tauri, then build the GUI bundle.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${SIDECAR_PROFILE:-release}"
RUN_AFTER_BUILD=0
BUNDLES="${TAURI_BUNDLES:-}"

if [ -z "$BUNDLES" ] && [ "$(uname -s)" = "Darwin" ]; then
  BUNDLES="app"
fi

usage() {
  cat <<EOF
Usage: scripts/build-package.sh [--debug|--release] [--bundles <list>] [--run]

Builds vtb, vtb-daemon, and vtb-gate, stages them through
crates/gui/scripts/prepare-sidecars.mjs, then builds the Tauri GUI bundle.

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

export SIDECAR_PROFILE="$PROFILE"
export VERTEBRAE_BUNDLE_SIDECARS=1

echo "==> Preparing $PROFILE Tauri sidecars..."
(cd "$REPO_ROOT/crates/gui" && npm run tauri:prepare-sidecars -- --profile "$PROFILE")

echo "==> Building $PROFILE Tauri bundle..."
TAURI_BUILD_ARGS=()
if [ "$PROFILE" = "debug" ]; then
  TAURI_BUILD_ARGS+=(--debug)
fi
if [ -n "$BUNDLES" ]; then
  TAURI_BUILD_ARGS+=(--bundles "$BUNDLES")
fi
(cd "$REPO_ROOT/crates/gui" && npm run tauri:build -- "${TAURI_BUILD_ARGS[@]}")

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
