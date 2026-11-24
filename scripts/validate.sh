#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

usage() {
  cat <<'EOF'
Usage: scripts/validate.sh [rust|gui|full]

  rust           all Rust checks and workspace coverage
  rust-checks    format, clippy, guideline fixtures, and GUI Rust tests
  rust-coverage  instrumented workspace tests and the line coverage gate
  gui            sidecar staging, GUI static checks, and GUI tests
  full           rust and gui validation (default)
EOF
}

run_rust_checks() {
  cargo fmt --check
  echo "==> Clippy"
  time cargo clippy --locked --workspace --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance -- -D warnings
  python3 scripts/check-rust-guidelines.py
  # The GUI crate is outside coverage; its Hegel property tests run here.
  echo "==> GUI Rust tests"
  time run_gui_rust_tests
}

run_gui_rust_tests() {
  cargo test --locked -p gui --lib local_chat::worktree_delta
  cargo test --locked -p gui --lib local_chat::file_history
  cargo test --locked -p gui --lib local_chat::annotations
  cargo test --locked -p gui --lib local_chat::code_intelligence
  # Background-work bridge mapping (harness event -> local chat event).
  cargo test --locked -p gui --lib local_chat::harnesses::shared::tests::background_work_bridge
}

run_rust_coverage() {
  time cargo llvm-cov --workspace --exclude gui --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance --fail-under-lines 75
}

run_rust() {
  run_rust_checks
  run_rust_coverage
}

run_gui() {
  (cd crates/gui && SIDECAR_PROFILE=debug npm run tauri:prepare-sidecars)
  (cd crates/gui && npm run test:sidecars)
  (cd crates/gui && npm run test:cascade)
  (cd crates/gui && npm run test:font-size)
  (cd crates/gui && npm run lint)
  (cd crates/gui && npm run lint:css)
  (cd crates/gui && npm run typecheck)
  (cd crates/gui && npm test)
}

mode=${1:-full}
case "$mode" in
  rust) run_rust ;;
  rust-checks) run_rust_checks ;;
  rust-coverage) run_rust_coverage ;;
  gui) run_gui ;;
  full) run_rust; run_gui ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
