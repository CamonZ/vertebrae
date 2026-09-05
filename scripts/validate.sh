#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

usage() {
  cat <<'EOF'
Usage: scripts/validate.sh [rust|gui|full]

  rust  format, clippy, guideline fixtures, and workspace coverage
  gui   sidecar staging, GUI static checks, and GUI tests
  full  rust and gui validation (default)
EOF
}

run_rust() {
  cargo fmt --check
  cargo clippy --locked --workspace --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance -- -D warnings
  python3 scripts/check-rust-guidelines.py
  cargo llvm-cov --workspace --exclude gui --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance --fail-under-lines 75
}

run_gui() {
  (cd crates/gui && SIDECAR_PROFILE=debug npm run tauri:prepare-sidecars)
  (cd crates/gui && npm run test:sidecars)
  (cd crates/gui && npm run lint)
  (cd crates/gui && npm run typecheck)
  (cd crates/gui && npm test)
}

mode=${1:-full}
case "$mode" in
  rust) run_rust ;;
  gui) run_gui ;;
  full) run_rust; run_gui ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
