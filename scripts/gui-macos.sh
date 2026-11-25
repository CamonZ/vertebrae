#!/usr/bin/env bash
set -euo pipefail

usage="Usage: $0 {start [--use-host-logins]|status|logs|shell|stop}"
host_logins=false
(( $# <= 2 )) || { echo "$usage" >&2; exit 2; }
case "${1:-}:${2:-}" in
    start:--use-host-logins) host_logins=true ;;
    start:|status:|logs:|shell:|stop:) ;;
    *) echo "$usage" >&2; exit 2 ;;
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
# The Vite dev server port; set another to run beside a checkout holding 1420.
port="${GUI_DEV_PORT:-1420}"
[[ $port =~ ^[0-9]+$ ]] || { echo "GUI_DEV_PORT must be a port number." >&2; exit 2; }
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
        if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null; then
            echo "Port $port is already in use by a host process; set GUI_DEV_PORT to another." >&2
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
        # Claude and Codex keep their state, history and logins in the app
        # home by default. With --use-host-logins they share the host's:
        # Claude reads its token from the login Keychain, which resolves
        # through $HOME, and Codex uses its real home so token refreshes stay
        # shared. Either way Codex's home stays short enough for the Unix
        # socket length limit.
        mkdir -p "$app_home/Library" "$app_home/.local"
        for entry in Library/Keychains .claude .claude.json .local/bin; do
            if [[ $host_logins == true ]]; then
                if [[ -e "$HOME/$entry" && ! -e "$app_home/$entry" ]]; then
                    ln -s "$HOME/$entry" "$app_home/$entry"
                fi
            elif [[ -L "$app_home/$entry" ]]; then
                # Drop links left by an earlier --use-host-logins run.
                rm "$app_home/$entry"
            fi
        done
        if [[ $host_logins == true ]]; then
            export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
        else
            export CODEX_HOME="/tmp/vtb-codex-$key"
            mkdir -p "$CODEX_HOME"
        fi
        # The tool binaries hold no credentials; use the host installs.
        for tool in claude:CLAUDE_CODE_PATH codex:CODEX_PATH; do
            if path=$(command -v "${tool%%:*}"); then export "${tool#*:}=$path"; fi
        done
        export HOME="$app_home" VTB_URL="http://$address" VTB_TOKEN="$SEED_TOKEN"
        export SIDECAR_PROFILE=debug CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0
        if [[ $port == 1420 ]]; then
            exec npm run tauri:dev
        fi
        export VERTEBRAE_BUNDLE_SIDECARS=1
        exec npx tauri dev --config "{\"build\":{\"devUrl\":\"http://localhost:$port\",\"beforeDevCommand\":\"npm run tauri:prepare-sidecars && npx vite --port $port\"}}"
        ;;
    status) compose ps --all ;;
    logs) compose logs --follow --tail 80 sacrum postgres ;;
    shell)
        binding=$(compose port sacrum 4000)
        # Match the default app's Codex home, for provider sign-in.
        export CODEX_HOME="/tmp/vtb-codex-$key"
        mkdir -p "$CODEX_HOME"
        export HOME="$app_home" VTB_URL="http://localhost:${binding##*:}" VTB_TOKEN="$SEED_TOKEN"
        cd "$root"
        exec "${SHELL:-/bin/bash}"
        ;;
    stop) compose down ;;
esac
