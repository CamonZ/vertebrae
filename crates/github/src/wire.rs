use crate::{error::bounded_message, GitHubError, PullRequestState, PullRequestSummary};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GraphQlError {
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
    pub message: String,
    /// Where in `data` the error applies, e.g. `["repository", "pr7"]`.
    #[serde(default)]
    pub path: Vec<serde_json::Value>,
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

/// `repository { viewerPermission prN: pullRequest(...) }` with one alias per
/// requested pull request; an alias is `null` when that PR is missing.
#[derive(Debug, Deserialize)]
pub(crate) struct ChecksQueryData {
    pub repository: Option<ChecksRepoData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChecksRepoData {
    /// `ADMIN`, `MAINTAIN`, `WRITE`, `TRIAGE`, `READ`, or `null`.
    pub viewer_permission: Option<String>,
    #[serde(flatten)]
    pub pull_requests: HashMap<String, Option<ChecksPullRequestNode>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChecksPullRequestNode {
    #[serde(flatten)]
    pub summary: GraphQlPullRequestNode,
    pub head_ref_oid: String,
    pub commits: Nodes<CommitNode>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Nodes<T> {
    #[serde(default = "Vec::new")]
    pub nodes: Vec<Option<T>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CommitNode {
    pub commit: CommitChecks,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitChecks {
    /// `null` when nothing reported a check or status for the commit.
    pub status_check_rollup: Option<StatusCheckRollup>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusCheckRollup {
    pub contexts: ContextConnection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextConnection {
    pub total_count: u64,
    #[serde(default = "Vec::new")]
    pub nodes: Vec<Option<CheckContext>>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "__typename")]
pub(crate) enum CheckContext {
    CheckRun(GraphQlCheckRun),
    StatusContext(GraphQlStatusContext),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphQlCheckRun {
    /// Global node id, used to look up the steps of failed runs.
    pub id: String,
    pub database_id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    /// The check run on GitHub.
    pub url: Option<String>,
    /// The provider's own page for the check.
    pub details_url: Option<String>,
    pub title: Option<String>,
    pub check_suite: Option<CheckSuite>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckSuite {
    pub app: Option<CheckApp>,
    pub workflow_run: Option<WorkflowRunRef>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CheckApp {
    pub name: String,
    pub slug: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowRunRef {
    pub database_id: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphQlStatusContext {
    pub context: String,
    pub state: String,
    pub description: Option<String>,
    pub target_url: Option<String>,
    pub created_at: Option<String>,
}

/// `nodes(ids: ...)` for the steps of failed check runs.
#[derive(Debug, Deserialize)]
pub(crate) struct CheckStepsQueryData {
    #[serde(default = "Vec::new")]
    pub nodes: Vec<Option<CheckRunSteps>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckRunSteps {
    pub database_id: u64,
    pub steps: Nodes<CheckStep>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CheckStep {
    pub name: String,
    pub conclusion: Option<String>,
}
