//! GitHub adapter with `gh` CLI authentication: pull requests and their
//! checks over GraphQL, batched per repository, and Actions job re-runs and
//! workflow-run cancels over REST.

mod auth;
mod checks;
mod client;
mod error;
mod remote;
mod rest;
mod types;
mod wire;

pub use auth::{GhCliAuth, GitHubToken};
pub use checks::{
    CheckCancel, CheckOutcome, CheckRerun, CheckStatus, PullRequestCheck, PullRequestChecks,
    PullRequestChecksBatch, PULL_REQUESTS_PER_QUERY,
};
pub use client::GitHubClient;
pub use error::GitHubError;
pub use remote::parse_github_remote_url;
pub use rest::RateLimitStatus;
pub use types::{OpenPrSearchResult, PullRequestState, PullRequestSummary, RepoRef};
