#!/bin/bash
# Setup script for vertebrae development environment
# Configures git hooks and installs dependencies

set -e

echo "Setting up vertebrae development environment..."

# Configure git to use project hooks
echo "==> Configuring git hooks..."
git config core.hooksPath .githooks
echo "    Git hooks configured to use .githooks/"

# Install GUI dependencies
echo "==> Installing GUI dependencies..."
(cd crates/gui && npm install)
echo "    GUI dependencies installed"

# Verify Rust toolchain
echo "==> Checking Rust toolchain..."
if command -v cargo &> /dev/null; then
    echo "    Rust toolchain found: $(rustc --version)"
else
    echo "    WARNING: Rust toolchain not found. Please install from https://rustup.rs/"
fi

# Check for cargo-llvm-cov (optional but needed for coverage)
echo "==> Checking for cargo-llvm-cov..."
if cargo llvm-cov --version &> /dev/null; then
    echo "    cargo-llvm-cov found"
else
    echo "    WARNING: cargo-llvm-cov not found. Install with: cargo install cargo-llvm-cov"
    echo "    (Required for pre-commit coverage checks)"
fi

echo ""
echo "Setup complete! You can now:"
echo "  - Run 'cargo build' to build the project"
echo "  - Run 'cd crates/gui && npm run tauri:dev' to start the GUI"
echo "  - Commits will automatically run tests and linting"
