Application.ensure_all_started(:sacrum)

alias Sacrum.Repo.Users

email = System.fetch_env!("SEED_EMAIL")
username = System.fetch_env!("SEED_USERNAME")
password = System.fetch_env!("SEED_PASSWORD")
token = System.fetch_env!("SEED_TOKEN")

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
    name: "local-token"
  },
  on_conflict: :nothing
)

IO.puts("Local Sacrum account is ready.")
