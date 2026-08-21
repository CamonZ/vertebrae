# Seed script for a LOCAL DEV backend.
# Idempotent — safe to run multiple times.
#
# Creates one user and one API token from env vars (with dev defaults).
# Unlike seed_test_data.exs (which hardcodes acceptance values), this reads:
#
#   SEED_EMAIL     (default: dev@local.test)
#   SEED_USERNAME  (default: dev)
#   SEED_PASSWORD  (default: dev_password_123)
#   SEED_TOKEN     (default: sac_dev-local-token)  -- keep the `sac_` prefix
#
# The token is whatever plaintext you choose: only base64(sha256(token)) is
# stored. Put the SAME plaintext in ~/.config/vertebrae/config.toml [sacrum].token.

Application.ensure_all_started(:sacrum)

alias Sacrum.Repo.Users

email = System.get_env("SEED_EMAIL") || "dev@local.test"
username = System.get_env("SEED_USERNAME") || "dev"
password = System.get_env("SEED_PASSWORD") || "dev_password_123"
token = System.get_env("SEED_TOKEN") || "sac_dev-local-token"

user =
  case Users.insert(%{email: email, username: username, password: password}) do
    {:ok, user} -> user
    {:error, _} -> Sacrum.Repo.get_by!(Sacrum.Repo.Schemas.User, email: email)
  end

token_hash = Base.encode64(:crypto.hash(:sha256, token))

Sacrum.Repo.insert(
  %Sacrum.Repo.Schemas.ApiToken{
    user_id: user.id,
    token_hash: token_hash,
    name: "dev-local-token"
  },
  on_conflict: :nothing
)

IO.puts("")
IO.puts("Seeded dev user: #{email} (username: #{username})")
IO.puts("API token:       configured")
IO.puts("The API token was not printed; use the configured client settings.")
IO.puts("")
