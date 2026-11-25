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

#[derive(Debug, Deserialize)]
pub(crate) struct RestPullRequest {
    pub state: String,
    #[serde(default)]
    pub draft: Option<bool>,
    #[serde(default)]
    pub merged_at: Option<String>,
    pub head: RestCommitRef,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RestCommitRef {
    pub sha: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RestRepository {
    /// Present only for authenticated requests.
    #[serde(default)]
    pub permissions: Option<RestPermissions>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub(crate) struct RestPermissions {
    #[serde(default)]
    pub admin: bool,
    #[serde(default)]
    pub maintain: bool,
    #[serde(default)]
    pub push: bool,
}

impl RestPermissions {
    /// Re-running Actions jobs needs write access to the repository.
    pub fn can_write(self) -> bool {
        self.admin || self.maintain || self.push
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct RestCheckRunsPage {
    pub total_count: u64,
    pub check_runs: Vec<RestCheckRun>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RestCheckRun {
    pub id: u64,
    pub name: String,
    pub status: String,
    #[serde(default)]
    pub conclusion: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub html_url: Option<String>,
    #[serde(default)]
    pub details_url: Option<String>,
    #[serde(default)]
    pub app: Option<RestApp>,
    #[serde(default)]
    pub output: Option<RestCheckOutput>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RestApp {
    #[serde(default)]
    pub slug: Option<String>,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RestCheckOutput {
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RestCombinedStatus {
    pub total_count: u64,
    pub statuses: Vec<RestCommitStatus>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RestCommitStatus {
    pub context: String,
    pub state: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub target_url: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RestJob {
    #[serde(default)]
    pub steps: Option<Vec<RestJobStep>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RestJobStep {
    pub name: String,
    #[serde(default)]
    pub conclusion: Option<String>,
}
