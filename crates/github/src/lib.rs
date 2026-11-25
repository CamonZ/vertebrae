//! Read-only GitHub GraphQL adapter with `gh` CLI authentication.

mod auth;
mod client;
mod error;
mod remote;
mod review_threads;
mod types;
mod wire;

pub use auth::{GhCliAuth, GitHubToken};
pub use client::GitHubClient;
pub use error::GitHubError;
pub use remote::parse_github_remote_url;
pub use review_threads::{
    DiffSide, PullRequestReviewThreads, ReviewAuthor, ReviewComment, ReviewThread,
};
pub use types::{OpenPrSearchResult, PullRequestState, PullRequestSummary, RepoRef};
