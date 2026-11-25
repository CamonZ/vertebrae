//! GitHub adapter with `gh` CLI authentication: pull request lookup over
//! GraphQL, checks over conditional REST requests, and Actions job re-runs.

mod auth;
mod checks;
mod client;
mod error;
mod remote;
mod rest;
mod types;
mod wire;

pub use auth::{GhCliAuth, GitHubToken};
pub use checks::{CheckOutcome, CheckRerun, CheckStatus, PullRequestCheck, PullRequestChecks};
pub use client::GitHubClient;
pub use error::GitHubError;
pub use remote::parse_github_remote_url;
pub use rest::RateLimitStatus;
pub use types::{OpenPrSearchResult, PullRequestState, PullRequestSummary, RepoRef};
