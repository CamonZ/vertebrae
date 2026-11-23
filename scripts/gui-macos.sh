#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
    start|status|logs|shell|stop) ;;
    *) echo "Usage: $0 {start|status|logs|shell|stop}" >&2; exit 2 ;;
esac

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
if [[ $(uname -s) != Darwin ]]; then
    echo "Run this launcher on macOS." >&2
    exit 1
fi
context=$(docker context show)
case "$context" in
    colima|colima-*) ;;
    *) echo "Select a running Colima Docker context with DOCKER_CONTEXT." >&2; exit 1 ;;
esac
key=$(printf '%s' "$root" | shasum -a 256 | cut -c1-16)
app_home="$root/test-output/macos-gui-home"
export SEED_TOKEN="${SEED_TOKEN:-sac_dev-local-token}"
compose() {
    docker --context "$context" compose -p "vtb-macos-$key" \
        -f "$root/docker-compose.dev.yml" -f - "$@" <<'YAML'
services:
  postgres:
    image: public.ecr.aws/docker/library/postgres:17-alpine
  sacrum:
    ports: !override
      - "127.0.0.1::4000"
YAML
}

case "$1" in
    start)
        if lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null; then
            echo "Port 1420 is already in use by a host process." >&2
            exit 1
        fi
        compose up -d --wait postgres sacrum
        compose run --rm -T --no-deps seeder
        binding=$(compose port sacrum 4000)
        address="localhost:${binding##*:}"
        config="$app_home/Library/Application Support/vertebrae"
        mkdir -p "$config"
        if [[ ! -e "$config/config.toml" ]]; then
            (umask 077; export address; export config_path="$config/config.toml"; python3 - <<'PYTHON'
import json
import os

with open(os.environ["config_path"], "x") as config:
    config.write("[sacrum]\n")
    config.write("url = " + json.dumps("http://" + os.environ["address"]) + "\n")
    config.write("token = " + json.dumps(os.environ["SEED_TOKEN"]) + "\n")
PYTHON
            )
        fi
        printf 'Worktree: %s\nBackend: http://%s\n' "$root" "$address"
        cd "$root/crates/gui"
        # Install dependencies with the normal host home. Scope app processes
        # to the worktree home once npm starts Tauri.
        npm ci --prefer-offline
        node_bin=$(node -p 'process.execPath')
        export PATH="$(dirname "$node_bin"):$PATH"
        export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
        export HOME="$app_home" VTB_URL="http://$address" VTB_TOKEN="$SEED_TOKEN"
        export SIDECAR_PROFILE=debug CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0
        exec npm run tauri:dev
        ;;
    status) compose ps --all ;;
    logs) compose logs --follow --tail 80 sacrum postgres ;;
    shell)
        binding=$(compose port sacrum 4000)
        export HOME="$app_home" VTB_URL="http://localhost:${binding##*:}" VTB_TOKEN="$SEED_TOKEN"
        cd "$root"
        exec "${SHELL:-/bin/bash}"
        ;;
    stop) compose down ;;
esac
