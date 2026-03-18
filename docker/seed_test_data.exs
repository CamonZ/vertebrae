# Seed script for acceptance testing with fixed/known values.
# Idempotent — safe to run multiple times.
#
# Fixed values (also hardcoded in docker-compose.yml and acceptance.yml):
#   SACRUM_API_TOKEN=sac_acceptance-test-token-vertebrae
#   SACRUM_PROJECT_ID=a0000000-0000-0000-0000-000000000001

Application.ensure_all_started(:sacrum)

alias Sacrum.Repo.Users

fixed_token = "sac_acceptance-test-token-vertebrae"
fixed_project_id = "a0000000-0000-0000-0000-000000000001"
now = DateTime.utc_now() |> DateTime.truncate(:microsecond)

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

Sacrum.Repo.insert(
  %Sacrum.Repo.Schemas.Project{
    id: fixed_project_id,
    user_id: user.id,
    name: "Acceptance Test Project",
    slug: "acceptance-test",
    inserted_at: now,
    updated_at: now
  },
  on_conflict: :nothing
)
