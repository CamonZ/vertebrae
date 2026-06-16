#!/bin/bash
# Spin up a local Sacrum backend in Docker and point the Vertebrae app at it.
#
# One command to get a working local stack: a Postgres DB, the sacrum backend
# on http://localhost:4000, and a seeded user + API token. It also writes the
# app's config.toml so the GUI/CLI talk to this local backend instead of prod.
#
# Usage:
#   scripts/dev-backend.sh up        # start backend, seed user/token, write app config
#   scripts/dev-backend.sh seed      # (re)create the user/token only
#   scripts/dev-backend.sh config    # (re)write app config.toml only
#   scripts/dev-backend.sh status    # show stack state + health
#   scripts/dev-backend.sh restore   # restore the backed-up prod config.toml
#   scripts/dev-backend.sh down      # stop & remove the stack (drops the DB volume)
#
# Credentials/token are overridable via env (defaults shown):
#   SEED_EMAIL=dev@local.test
#   SEED_USERNAME=dev
#   SEED_PASSWORD=dev_password_123
#   SEED_TOKEN=sac_dev-local-token        # keep the sac_ prefix
#
# Example with custom creds:
#   SEED_PASSWORD=hunter2 SEED_TOKEN=sac_my-token scripts/dev-backend.sh up

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.dev.yml"

SACRUM_URL="${SACRUM_URL:-http://localhost:4000}"
export SEED_EMAIL="${SEED_EMAIL:-dev@local.test}"
export SEED_USERNAME="${SEED_USERNAME:-dev}"
export SEED_PASSWORD="${SEED_PASSWORD:-dev_password_123}"
export SEED_TOKEN="${SEED_TOKEN:-sac_dev-local-token}"

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# Resolve the app config dir the same way Rust's dirs::config_dir() does.
config_dir() {
  case "$(uname -s)" in
    Darwin) printf '%s' "$HOME/Library/Application Support/vertebrae" ;;
    *)      printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/vertebrae" ;;
  esac
}

require_docker() {
  command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not found on PATH" >&2; exit 1; }
}

wait_for_health() {
  echo "==> Waiting for sacrum at $SACRUM_URL/healthz ..."
  for _ in $(seq 1 60); do
    if curl -fs "$SACRUM_URL/healthz" >/dev/null 2>&1; then
      echo "    sacrum is healthy"
      return 0
    fi
    sleep 2
  done
  echo "    ERROR: sacrum did not become healthy in time. Recent logs:" >&2
  compose logs --tail 40 sacrum >&2 || true
  return 1
}

do_seed() {
  echo "==> Seeding user + token (email=$SEED_EMAIL token=$SEED_TOKEN) ..."
  compose run --rm seeder
}

write_config() {
  local dir cfg
  dir="$(config_dir)"
  cfg="$dir/config.toml"
  mkdir -p "$dir"

  if [ -f "$cfg" ]; then
    if [ ! -f "$cfg.bak" ]; then
      cp -p "$cfg" "$cfg.bak"
      echo "==> Backed up existing config -> $cfg.bak"
    else
      echo "==> Existing backup preserved (not overwriting $cfg.bak)"
    fi
  fi

  cat > "$cfg" <<EOF
[sacrum]
url = "$SACRUM_URL"
token = "$SEED_TOKEN"
EOF
  echo "==> Wrote dev config -> $cfg"
  echo "    Projects are created from the app (GUI first-run wizard / vtb init)."
}

restore_config() {
  local cfg; cfg="$(config_dir)/config.toml"
  if [ -f "$cfg.bak" ]; then
    mv -f "$cfg.bak" "$cfg"
    echo "==> Restored config from backup -> $cfg"
  else
    echo "No backup found at $cfg.bak — nothing to restore." >&2
    return 1
  fi
}

cmd_up() {
  require_docker
  echo "==> Starting dev backend (postgres + sacrum) ..."
  compose up -d postgres sacrum
  wait_for_health
  do_seed
  write_config
  cat <<EOF

Done. Local backend is up at $SACRUM_URL
  user:  $SEED_EMAIL  (password: $SEED_PASSWORD)
  token: $SEED_TOKEN

Next:
  - Launch the GUI (cd crates/gui && npm run tauri:dev) and create your project
    via the first-run wizard, or run 'vtb init' inside a repo.
  - When you're done: scripts/dev-backend.sh restore   # put your prod config back
                      scripts/dev-backend.sh down      # tear down the stack
EOF
}

cmd_status() {
  require_docker
  compose ps
  echo "--- health ---"
  if curl -fs "$SACRUM_URL/healthz" >/dev/null 2>&1; then
    echo "sacrum: healthy ($SACRUM_URL)"
  else
    echo "sacrum: not reachable at $SACRUM_URL"
  fi
}

cmd_down() {
  require_docker
  echo "==> Tearing down dev backend (removes the DB volume) ..."
  compose down -v
}

case "${1:-up}" in
  up)      cmd_up ;;
  seed)    require_docker; do_seed ;;
  config)  write_config ;;
  restore) restore_config ;;
  status)  cmd_status ;;
  down)    cmd_down ;;
  *) echo "Usage: $0 {up|seed|config|status|restore|down}" >&2; exit 2 ;;
esac
