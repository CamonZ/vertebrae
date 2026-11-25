use crate::{error::bounded_message, GitHubError, PullRequestState, PullRequestSummary};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub(crate) struct HttpErrorBody {
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct GraphQlRequest<'a> {
    pub query: &'a str,
    pub variables: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GraphQlResponse<T> {
    pub data: Option<T>,
    #[serde(default)]
    pub errors: Vec<GraphQlError>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GraphQlError {
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphQlPullRequestNode {
    pub number: u64,
    pub title: String,
    pub state: String,
    #[serde(default)]
    pub is_draft: bool,
    pub head_ref_name: String,
    pub head_repository: Option<GraphQlRepoRef>,
    pub base_ref_name: String,
    pub url: String,
    pub author: Option<GraphQlActor>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphQlRepoRef {
    pub name_with_owner: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GraphQlActor {
    pub login: String,
}

impl TryFrom<GraphQlPullRequestNode> for PullRequestSummary {
    type Error = GitHubError;

    fn try_from(pr: GraphQlPullRequestNode) -> Result<Self, Self::Error> {
        let state = match pr.state.as_str() {
            "OPEN" if pr.is_draft => PullRequestState::Draft,
            "OPEN" => PullRequestState::Open,
            "MERGED" => PullRequestState::Merged,
            "CLOSED" => PullRequestState::Closed,
            unknown => {
                return Err(GitHubError::Decode {
                    message: format!(
                        "Unknown state {} for pull request #{}",
                        bounded_message(unknown),
                        pr.number
                    ),
                })
            }
        };

        Ok(Self {
            number: pr.number,
            title: pr.title,
            state,
            head_ref: pr.head_ref_name,
            head_repo: pr.head_repository.map(|r| r.name_with_owner),
            base_ref: pr.base_ref_name,
            url: pr.url,
            author: pr.author.map(|a| a.login),
            updated_at: pr.updated_at,
        })
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct PullRequestsQueryData {
    pub repository: Option<PullRequestsRepoData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequestsRepoData {
    pub pull_requests: PullRequestConnection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequestConnection {
    pub nodes: Vec<Option<GraphQlPullRequestNode>>,
    #[serde(default)]
    pub page_info: Option<GraphQlPageInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphQlPageInfo {
    #[serde(default)]
    pub has_next_page: bool,
    #[serde(default)]
    pub end_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PullRequestByNumberData {
    pub repository: Option<PullRequestByNumberRepoData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequestByNumberRepoData {
    pub pull_request: Option<GraphQlPullRequestNode>,
}
