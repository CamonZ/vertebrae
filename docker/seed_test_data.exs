# Seed script for acceptance testing with fixed/known values.
# Idempotent — safe to run multiple times.
#
# Creates a user and API token for authentication.
# Projects are created per-scenario by the acceptance test framework via GraphQL.
#
# Fixed values (also hardcoded in docker-compose.yml):
#   VTB_TOKEN=sac_acceptance-test-token-vertebrae

Application.ensure_all_started(:sacrum)

alias Sacrum.Repo.Users

fixed_token = "sac_acceptance-test-token-vertebrae"

user =
  case Users.insert(%{
    email: "acceptance@test.local",
    username: "acceptance_test",
    password: "test_password_123"
  }) do
    {:ok, user} -> user
    {:error, _} -> Sacrum.Repo.get_by!(Sacrum.Repo.Schemas.User, email: "acceptance@test.local")
  end

token_hash = Base.encode64(:crypto.hash(:sha256, fixed_token))

Sacrum.Repo.insert(
  %Sacrum.Repo.Schemas.ApiToken{
    user_id: user.id,
    token_hash: token_hash,
    name: "acceptance-test-token"
  },
  on_conflict: :nothing
)
