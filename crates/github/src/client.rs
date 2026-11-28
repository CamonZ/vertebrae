use crate::{
    auth::GitHubToken,
    error::bounded_message,
    wire::{
        GraphQlError, GraphQlRequest, GraphQlResponse, HttpErrorBody, PullRequestByNumberData,
        PullRequestsQueryData,
    },
    GitHubError, OpenPrSearchResult, PullRequestSummary, RepoRef,
};
use crate::{rate_limit::RateLimitStatus, step_cache::FailedStepCache};
use reqwest::{
    header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT},
    StatusCode,
};
use serde::de::DeserializeOwned;
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const DEFAULT_API_BASE_URL: &str = "https://api.github.com";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
pub(crate) const MAX_RESPONSE_BODY_BYTES: usize = 4 * 1024 * 1024;
const GITHUB_API_VERSION_HEADER: &str = "X-GitHub-Api-Version";
const GITHUB_API_VERSION: &str = "2022-11-28";
const USER_AGENT_VALUE: &str = concat!("vertebrae-github/", env!("CARGO_PKG_VERSION"));
const OPEN_PR_PAGE_SIZE: u32 = 50;

const LIST_OPEN_PRS_QUERY: &str = r#"
query ListOpenPullRequests($owner: String!, $repo: String!, $headRefName: String, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(
      states: [OPEN]
      headRefName: $headRefName
      first: $first
      after: $after
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        state
        isDraft
        headRefName
        headRepository { nameWithOwner }
        baseRefName
        url
        author { login }
        updatedAt
      }
    }
  }
}
"#;

const GET_PR_QUERY: &str = r#"
query GetPullRequest($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      title
      state
      isDraft
      headRefName
      headRepository { nameWithOwner }
      baseRefName
      url
      author { login }
      updatedAt
    }
  }
}
"#;

/// The pool is shared, but credentials are supplied per request.
#[derive(Debug, Clone)]
pub struct GitHubClient {
    pub(crate) http: reqwest::Client,
    pub(crate) base_url: url::Url,
    /// Steps of failed check runs, read once per run.
    pub(crate) failed_steps: Arc<FailedStepCache>,
}

fn validate_base_url(raw: &str) -> Result<url::Url, GitHubError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(GitHubError::InvalidInput {
            message: "GitHub API base URL cannot be empty".into(),
        });
    }
    let normalized = if trimmed.ends_with('/') {
        trimmed.to_string()
    } else {
        format!("{trimmed}/")
    };
    let parsed = url::Url::parse(&normalized).map_err(|err| GitHubError::InvalidInput {
        message: format!("Invalid GitHub API base URL: {err}"),
    })?;
    let is_loopback = matches!(
        parsed.host_str(),
        Some("127.0.0.1" | "localhost" | "::1" | "[::1]")
    );
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && is_loopback) {
        return Err(GitHubError::InvalidInput {
            message: "GitHub API base URL must use https (or http on loopback)".into(),
        });
    }
    Ok(parsed)
}

impl GitHubClient {
    pub fn new() -> Result<Self, GitHubError> {
        Self::with_base_url(DEFAULT_API_BASE_URL)
    }

    pub(crate) fn with_base_url(base_url: &str) -> Result<Self, GitHubError> {
        Self::with_base_url_and_timeout(base_url, REQUEST_TIMEOUT)
    }

    pub(crate) fn with_base_url_and_timeout(
        base_url: &str,
        request_timeout: Duration,
    ) -> Result<Self, GitHubError> {
        let base_url = validate_base_url(base_url)?;

        let mut default_headers = HeaderMap::new();
        default_headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_VALUE));
        default_headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github+json"),
        );
        default_headers.insert(
            GITHUB_API_VERSION_HEADER,
            HeaderValue::from_static(GITHUB_API_VERSION),
        );

        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(request_timeout)
            .redirect(reqwest::redirect::Policy::none())
            .default_headers(default_headers)
            .build()
            .map_err(|err| GitHubError::Network {
                message: format!("Could not initialize HTTP client: {err}"),
            })?;

        Ok(Self {
            http,
            base_url,
            failed_steps: Arc::default(),
        })
    }

    /// Uses GitHub's GraphQL `headRefName` filter so GitHub filters server-side
    /// across both same-repo and fork PRs (matching `gh`). Reads one page and
    /// reports `has_more` when additional pages exist, so callers never
    /// auto-link from an incomplete result.
    pub async fn list_open_prs_for_branch(
        &self,
        token: &GitHubToken,
        repo: &RepoRef,
        branch: &str,
    ) -> Result<OpenPrSearchResult, GitHubError> {
        let branch = branch.trim();
        if branch.is_empty() {
            return Err(GitHubError::InvalidInput {
                message: "Branch name cannot be empty".into(),
            });
        }

        self.query_open_prs(token, repo, Some(branch), 1).await
    }

    /// The repository's open pull requests, most recently updated first,
    /// following up to `max_pages` pages of 50.
    pub async fn list_open_prs(
        &self,
        token: &GitHubToken,
        repo: &RepoRef,
        max_pages: usize,
    ) -> Result<OpenPrSearchResult, GitHubError> {
        self.query_open_prs(token, repo, None, max_pages).await
    }

    async fn query_open_prs(
        &self,
        token: &GitHubToken,
        repo: &RepoRef,
        head_ref_name: Option<&str>,
        max_pages: usize,
    ) -> Result<OpenPrSearchResult, GitHubError> {
        let mut result = OpenPrSearchResult {
            prs: Vec::new(),
            has_more: false,
            rate_limit: None,
        };
        let mut after: Option<String> = None;
        for _ in 0..max_pages.max(1) {
            let (envelope, rate_limit) = self
                .graphql_envelope::<PullRequestsQueryData>(
                    token,
                    LIST_OPEN_PRS_QUERY,
                    json!({
                        "owner": repo.owner,
                        "repo": repo.repo,
                        "headRefName": head_ref_name,
                        "first": OPEN_PR_PAGE_SIZE,
                        "after": after,
                    }),
                )
                .await?;
            result.rate_limit = RateLimitStatus::tightest(result.rate_limit, rate_limit);
            let data = data_of(envelope, rate_limit)?;
            let repo_data = data.repository.ok_or_else(|| GitHubError::NotFound {
                message: format!("Repository {} not found", repo.full_name()),
            })?;
            let connection = repo_data.pull_requests;
            for node in connection.nodes.into_iter().flatten() {
                result.prs.push(PullRequestSummary::try_from(node)?);
            }
            let page = connection.page_info.filter(|info| info.has_next_page);
            result.has_more = page.is_some();
            match page.and_then(|info| info.end_cursor) {
                Some(cursor) => after = Some(cursor),
                None => break,
            }
        }
        Ok(result)
    }

    pub async fn get_pull_request(
        &self,
        token: &GitHubToken,
        repo: &RepoRef,
        number: u64,
    ) -> Result<PullRequestSummary, GitHubError> {
        if number == 0 {
            return Err(GitHubError::InvalidInput {
                message: "Pull request number must be greater than zero".into(),
            });
        }

        let data: PullRequestByNumberData = self
            .graphql(
                token,
                GET_PR_QUERY,
                json!({
                    "owner": repo.owner,
                    "repo": repo.repo,
                    "number": number,
                }),
            )
            .await?;

        let pr = data
            .repository
            .and_then(|r| r.pull_request)
            .ok_or_else(|| GitHubError::NotFound {
                message: format!("Pull request #{number} not found in {}", repo.full_name()),
            })?;

        PullRequestSummary::try_from(pr)
    }

    pub(crate) async fn graphql<T: DeserializeOwned>(
        &self,
        token: &GitHubToken,
        query: &str,
        variables: serde_json::Value,
    ) -> Result<T, GitHubError> {
        let (envelope, rate_limit) = self.graphql_envelope(token, query, variables).await?;
        data_of(envelope, rate_limit)
    }

    /// The raw envelope, for queries whose aliases can fail independently,
    /// with the rate-limit window GitHub reported for it.
    pub(crate) async fn graphql_envelope<T: DeserializeOwned>(
        &self,
        token: &GitHubToken,
        query: &str,
        variables: serde_json::Value,
    ) -> Result<(GraphQlResponse<T>, Option<RateLimitStatus>), GitHubError> {
        let url = self
            .base_url
            .join("graphql")
            .map_err(|err| GitHubError::InvalidInput {
                message: format!("Invalid GraphQL endpoint URL: {err}"),
            })?;
        let payload = serde_json::to_vec(&GraphQlRequest { query, variables }).map_err(|err| {
            GitHubError::InvalidInput {
                message: format!("Could not encode GraphQL request: {err}"),
            }
        })?;

        let response = self
            .http
            .post(url)
            .header(AUTHORIZATION, format!("Bearer {}", token.expose()))
            .header(CONTENT_TYPE, "application/json")
            .body(payload)
            .send()
            .await
            .map_err(map_transport_error)?;
        let rate_limit = RateLimitStatus::from_headers(response.headers());

        let bytes = read_checked_response(response).await?;
        let envelope = serde_json::from_slice(&bytes).map_err(|err| GitHubError::Decode {
            message: format!("Invalid GraphQL response JSON: {err}"),
        })?;
        Ok((envelope, rate_limit))
    }
}

fn data_of<T>(
    envelope: GraphQlResponse<T>,
    rate_limit: Option<RateLimitStatus>,
) -> Result<T, GitHubError> {
    if !envelope.errors.is_empty() {
        return Err(map_graphql_errors(envelope.errors, rate_limit));
    }
    envelope.data.ok_or_else(|| GitHubError::Decode {
        message: "GraphQL response contained neither data nor errors".into(),
    })
}

/// GraphQL errors as one failure. A `RATE_LIMITED` error arrives with HTTP
/// 200, so its retry comes from the response's rate-limit reset.
pub(crate) fn map_graphql_errors(
    errors: Vec<GraphQlError>,
    rate_limit: Option<RateLimitStatus>,
) -> GitHubError {
    let joined = bounded_message(
        &errors
            .iter()
            .map(|e| e.message.as_str())
            .collect::<Vec<_>>()
            .join("; "),
    );
    let has_kind = |kind: &str| errors.iter().any(|e| e.kind.as_deref() == Some(kind));

    if has_kind("RATE_LIMITED") {
        GitHubError::RateLimited {
            retry_after_secs: rate_limit.map(|window| window.reset_in_secs),
            message: joined,
        }
    } else if has_kind("FORBIDDEN") {
        GitHubError::Forbidden { message: joined }
    } else if has_kind("NOT_FOUND") {
        GitHubError::NotFound { message: joined }
    } else {
        GitHubError::GraphQl { message: joined }
    }
}

/// A transport failure, by whether the request can have reached GitHub: no
/// connection (or no request built) means nothing was sent; any other drop
/// happened once the request was out, so a write's outcome is unknown.
pub(crate) fn map_transport_error(err: reqwest::Error) -> GitHubError {
    if err.is_timeout() {
        GitHubError::Timeout {
            message: "GitHub request timed out".to_string(),
        }
    } else if err.is_connect() {
        GitHubError::Network {
            message: "Could not connect to GitHub".to_string(),
        }
    } else if err.is_builder() {
        GitHubError::Network {
            message: format!("Could not build the GitHub request: {err}"),
        }
    } else {
        GitHubError::Interrupted {
            message: format!("the connection dropped: {err}"),
        }
    }
}

pub(crate) async fn read_checked_response(
    mut response: reqwest::Response,
) -> Result<Vec<u8>, GitHubError> {
    let status = response.status();
    let headers = response.headers().clone();
    let too_large = || GitHubError::Decode {
        message: format!("GitHub response exceeded {MAX_RESPONSE_BODY_BYTES} byte limit"),
    };

    if response
        .content_length()
        .is_some_and(|len| len > MAX_RESPONSE_BODY_BYTES as u64)
    {
        return Err(too_large());
    }

    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(map_transport_error)? {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY_BYTES {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }

    if status.is_success() {
        return Ok(body);
    }

    let api_message = serde_json::from_slice::<HttpErrorBody>(&body)
        .ok()
        .and_then(|err| err.message)
        .map(|message| bounded_message(&message))
        .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));

    Err(map_http_status(status, &headers, api_message))
}

fn map_http_status(status: StatusCode, headers: &HeaderMap, message: String) -> GitHubError {
    match status {
        StatusCode::UNAUTHORIZED => GitHubError::AuthExpired { message },
        StatusCode::NOT_FOUND => GitHubError::NotFound { message },
        StatusCode::TOO_MANY_REQUESTS => GitHubError::RateLimited {
            retry_after_secs: retry_after_secs(headers),
            message,
        },
        StatusCode::FORBIDDEN => {
            let remaining_zero = header_str(headers, "x-ratelimit-remaining") == Some("0");
            let mentions_rate = message.to_ascii_lowercase().contains("rate limit");
            if remaining_zero || mentions_rate {
                GitHubError::RateLimited {
                    retry_after_secs: retry_after_secs(headers),
                    message,
                }
            } else {
                GitHubError::Forbidden { message }
            }
        }
        _ => GitHubError::Http {
            status: status.as_u16(),
            message,
        },
    }
}

pub(crate) fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok().map(str::trim)
}

fn retry_after_secs(headers: &HeaderMap) -> Option<u64> {
    if let Some(secs) = header_str(headers, "retry-after").and_then(|v| v.parse().ok()) {
        return Some(secs);
    }
    let reset: u64 = header_str(headers, "x-ratelimit-reset")?.parse().ok()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some(reset.saturating_sub(now))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PullRequestState;
    use wiremock::{
        matchers::{body_partial_json, header, method, path},
        Mock, MockServer, ResponseTemplate,
    };

    fn demo_repo() -> RepoRef {
        RepoRef::new("github.com", "example", "demo-repo")
    }

    fn token() -> GitHubToken {
        GitHubToken::new("gho_synthetic_token").unwrap()
    }

    struct SyntheticPr<'a> {
        number: u64,
        title: &'a str,
        state: &'a str,
        is_draft: bool,
        head_ref: &'a str,
        head_repo: &'a str,
        author: &'a str,
    }

    fn synthetic_pr_node(pr: SyntheticPr<'_>) -> serde_json::Value {
        json!({
            "number": pr.number,
            "title": pr.title,
            "state": pr.state,
            "isDraft": pr.is_draft,
            "headRefName": pr.head_ref,
            "headRepository": { "nameWithOwner": pr.head_repo },
            "baseRefName": "main",
            "url": format!("https://github.com/example/demo-repo/pull/{}", pr.number),
            "author": { "login": pr.author },
            "updatedAt": "2026-11-24T12:00:00Z"
        })
    }

    fn open_pr(number: u64) -> serde_json::Value {
        synthetic_pr_node(SyntheticPr {
            number,
            title: "Fix retry budget",
            state: "OPEN",
            is_draft: false,
            head_ref: "feature/retry",
            head_repo: "example/demo-repo",
            author: "alice",
        })
    }

    fn prs_page(nodes: serde_json::Value) -> serde_json::Value {
        json!({ "data": { "repository": { "pullRequests": { "nodes": nodes } } } })
    }

    async fn server_responding(response: ResponseTemplate) -> (MockServer, GitHubClient) {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(response)
            .mount(&server)
            .await;
        let client = GitHubClient::with_base_url(&server.uri()).unwrap();
        (server, client)
    }

    async fn get_pr_error(response: ResponseTemplate) -> GitHubError {
        let (_server, client) = server_responding(response).await;
        client
            .get_pull_request(&token(), &demo_repo(), 7)
            .await
            .unwrap_err()
    }

    #[tokio::test]
    async fn lists_matching_open_prs_for_branch_via_graphql_head_ref_filter() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(header("authorization", "Bearer gho_synthetic_token"))
            .and(header("user-agent", USER_AGENT_VALUE))
            .and(body_partial_json(json!({
                "variables": {
                    "owner": "example",
                    "repo": "demo-repo",
                    "headRefName": "feature/retry"
                }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(prs_page(json!([
                open_pr(101),
                synthetic_pr_node(SyntheticPr {
                    number: 102,
                    title: "Fork retry experiment",
                    state: "OPEN",
                    is_draft: true,
                    head_ref: "feature/retry",
                    head_repo: "bob/demo-repo",
                    author: "bob",
                }),
            ]))))
            .expect(1)
            .mount(&server)
            .await;

        let client = GitHubClient::with_base_url(&server.uri()).unwrap();
        let result = client
            .list_open_prs_for_branch(&token(), &demo_repo(), "feature/retry")
            .await
            .unwrap();
        assert!(!result.has_more);
        let matches = result.prs;
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].number, 101);
        assert_eq!(matches[0].state, PullRequestState::Open);
        assert_eq!(matches[0].head_repo.as_deref(), Some("example/demo-repo"));
        assert_eq!(matches[1].number, 102);
        assert_eq!(matches[1].state, PullRequestState::Draft);
        assert_eq!(matches[1].head_repo.as_deref(), Some("bob/demo-repo"));
    }

    fn page(cursor: Option<&str>, nodes: serde_json::Value) -> serde_json::Value {
        json!({
            "data": {
                "repository": {
                    "pullRequests": {
                        "pageInfo": { "hasNextPage": cursor.is_some(), "endCursor": cursor },
                        "nodes": nodes
                    }
                }
            }
        })
    }

    #[tokio::test]
    async fn open_prs_follow_cursors_up_to_the_page_cap() {
        let server = MockServer::start().await;
        for (after, next, number) in [
            (None, Some("c1"), 1),
            (Some("c1"), Some("c2"), 2),
            (Some("c2"), Some("c3"), 3),
            (Some("c3"), None, 4),
        ] {
            Mock::given(method("POST"))
                .and(path("/graphql"))
                .and(body_partial_json(
                    json!({ "variables": { "after": after } }),
                ))
                .respond_with(
                    ResponseTemplate::new(200).set_body_json(page(next, json!([open_pr(number)]))),
                )
                .mount(&server)
                .await;
        }
        let client = GitHubClient::with_base_url(&server.uri()).unwrap();

        let capped = client
            .list_open_prs(&token(), &demo_repo(), 3)
            .await
            .unwrap();
        let numbers: Vec<u64> = capped.prs.iter().map(|pr| pr.number).collect();
        assert_eq!(numbers, [1, 2, 3]);
        assert!(capped.has_more);

        let all = client
            .list_open_prs(&token(), &demo_repo(), 4)
            .await
            .unwrap();
        assert_eq!(all.prs.len(), 4);
        assert!(!all.has_more);

        let for_branch = client
            .list_open_prs_for_branch(&token(), &demo_repo(), "feature/retry")
            .await
            .unwrap();
        assert_eq!(for_branch.prs.len(), 1);
        assert!(for_branch.has_more);
    }

    #[tokio::test]
    async fn null_nodes_head_repository_and_author_are_tolerated() {
        let (_server, client) =
            server_responding(ResponseTemplate::new(200).set_body_json(prs_page(json!([
                null,
                {
                    "number": 5,
                    "title": "Deleted fork",
                    "state": "OPEN",
                    "isDraft": false,
                    "headRefName": "feature/retry",
                    "headRepository": null,
                    "baseRefName": "main",
                    "url": "https://github.com/example/demo-repo/pull/5",
                    "author": null,
                    "updatedAt": null
                }
            ]))))
            .await;

        let result = client
            .list_open_prs(&token(), &demo_repo(), 3)
            .await
            .unwrap();
        assert_eq!(result.prs.len(), 1);
        assert_eq!(result.prs[0].number, 5);
        assert_eq!(result.prs[0].head_repo, None);
        assert_eq!(result.prs[0].author, None);
    }

    #[tokio::test]
    async fn unknown_pr_state_is_a_decode_error_not_open() {
        let err = {
            let (_server, client) =
                server_responding(ResponseTemplate::new(200).set_body_json(prs_page(json!([
                    synthetic_pr_node(SyntheticPr {
                        number: 9,
                        title: "Odd",
                        state: "QUEUED",
                        is_draft: false,
                        head_ref: "feature/retry",
                        head_repo: "example/demo-repo",
                        author: "alice",
                    })
                ]))))
                .await;
            client
                .list_open_prs(&token(), &demo_repo(), 3)
                .await
                .unwrap_err()
        };
        assert!(matches!(err, GitHubError::Decode { ref message } if message.contains("QUEUED")));
    }

    #[tokio::test]
    async fn get_pull_request_maps_merged_and_not_found() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_partial_json(json!({ "variables": { "number": 42 } })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "repository": {
                        "pullRequest": synthetic_pr_node(SyntheticPr {
                            number: 42,
                            title: "Already merged",
                            state: "MERGED",
                            is_draft: false,
                            head_ref: "feature/done",
                            head_repo: "example/demo-repo",
                            author: "alice",
                        })
                    }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_partial_json(json!({ "variables": { "number": 999 } })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "repository": { "pullRequest": null } }
            })))
            .mount(&server)
            .await;

        let client = GitHubClient::with_base_url(&server.uri()).unwrap();
        let pr = client
            .get_pull_request(&token(), &demo_repo(), 42)
            .await
            .unwrap();
        assert_eq!(pr.state, PullRequestState::Merged);
        assert_eq!(pr.number, 42);

        assert!(matches!(
            client
                .get_pull_request(&token(), &demo_repo(), 999)
                .await
                .unwrap_err(),
            GitHubError::NotFound { .. }
        ));
        assert!(matches!(
            client.get_pull_request(&token(), &demo_repo(), 0).await,
            Err(GitHubError::InvalidInput { .. })
        ));
    }

    #[tokio::test]
    async fn missing_repository_maps_to_not_found() {
        let (_server, client) = server_responding(
            ResponseTemplate::new(200).set_body_json(json!({ "data": { "repository": null } })),
        )
        .await;
        assert!(matches!(
            client.list_open_prs(&token(), &demo_repo(), 3).await,
            Err(GitHubError::NotFound { .. })
        ));
    }

    #[tokio::test]
    async fn http_statuses_map_to_distinct_errors() {
        assert_eq!(
            get_pr_error(
                ResponseTemplate::new(401).set_body_json(json!({ "message": "Bad credentials" }))
            )
            .await,
            GitHubError::AuthExpired {
                message: "Bad credentials".into(),
            }
        );
        assert_eq!(
            get_pr_error(
                ResponseTemplate::new(403)
                    .insert_header("x-ratelimit-remaining", "0")
                    .insert_header("retry-after", "45")
                    .set_body_json(json!({ "message": "API rate limit exceeded" }))
            )
            .await,
            GitHubError::RateLimited {
                retry_after_secs: Some(45),
                message: "API rate limit exceeded".into(),
            }
        );
        assert_eq!(
            get_pr_error(
                ResponseTemplate::new(403)
                    .set_body_json(json!({ "message": "Resource not accessible by integration" }))
            )
            .await,
            GitHubError::Forbidden {
                message: "Resource not accessible by integration".into(),
            }
        );
        assert_eq!(
            get_pr_error(
                ResponseTemplate::new(404).set_body_json(json!({ "message": "Not Found" }))
            )
            .await,
            GitHubError::NotFound {
                message: "Not Found".into(),
            }
        );
        assert_eq!(
            get_pr_error(ResponseTemplate::new(429).insert_header("retry-after", "7")).await,
            GitHubError::RateLimited {
                retry_after_secs: Some(7),
                message: "HTTP 429".into(),
            }
        );
        assert_eq!(
            get_pr_error(ResponseTemplate::new(502).set_body_string("<html>bad gateway</html>"))
                .await,
            GitHubError::Http {
                status: 502,
                message: "HTTP 502".into(),
            }
        );
    }

    #[tokio::test]
    async fn rate_limit_reset_header_yields_retry_hint() {
        let reset = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 120;
        match get_pr_error(
            ResponseTemplate::new(403)
                .insert_header("x-ratelimit-remaining", "0")
                .insert_header("x-ratelimit-reset", reset.to_string().as_str())
                .set_body_json(json!({ "message": "API rate limit exceeded" })),
        )
        .await
        {
            GitHubError::RateLimited {
                retry_after_secs: Some(secs),
                ..
            } => assert!((100..=120).contains(&secs), "{secs}"),
            other => panic!("expected RateLimited with hint, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn long_server_messages_are_truncated() {
        let long = "x".repeat(5_000);
        match get_pr_error(ResponseTemplate::new(403).set_body_json(json!({ "message": long })))
            .await
        {
            GitHubError::Forbidden { message } => assert!(message.chars().count() <= 301),
            other => panic!("expected Forbidden, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn oversize_and_malformed_bodies_are_decode_errors() {
        let oversize = "x".repeat(MAX_RESPONSE_BODY_BYTES + 1);
        assert!(matches!(
            get_pr_error(ResponseTemplate::new(200).set_body_string(oversize)).await,
            GitHubError::Decode { ref message } if message.contains("byte limit")
        ));
        assert!(matches!(
            get_pr_error(ResponseTemplate::new(200).set_body_string("{not json")).await,
            GitHubError::Decode { .. }
        ));
        assert!(matches!(
            get_pr_error(ResponseTemplate::new(200).set_body_json(json!({}))).await,
            GitHubError::Decode { ref message } if message.contains("neither data nor errors")
        ));
    }

    #[tokio::test]
    async fn redirects_are_not_followed() {
        let err = get_pr_error(
            ResponseTemplate::new(302).insert_header("location", "https://example.invalid/graphql"),
        )
        .await;
        assert!(matches!(err, GitHubError::Http { status: 302, .. }));
    }

    #[tokio::test]
    async fn graphql_error_types_map_to_typed_variants() {
        let graphql_error = |kind: Option<&str>| {
            let mut error = json!({ "message": "synthetic failure" });
            if let Some(kind) = kind {
                error["type"] = json!(kind);
            }
            ResponseTemplate::new(200).set_body_json(json!({ "data": null, "errors": [error] }))
        };

        assert!(matches!(
            get_pr_error(graphql_error(Some("NOT_FOUND"))).await,
            GitHubError::NotFound { .. }
        ));
        assert!(matches!(
            get_pr_error(graphql_error(Some("RATE_LIMITED"))).await,
            GitHubError::RateLimited { .. }
        ));
        assert!(matches!(
            get_pr_error(graphql_error(Some("FORBIDDEN"))).await,
            GitHubError::Forbidden { .. }
        ));
        assert_eq!(
            get_pr_error(graphql_error(None)).await,
            GitHubError::GraphQl {
                message: "synthetic failure".into(),
            }
        );
    }

    #[test]
    fn rejects_non_https_base_url() {
        assert!(matches!(
            GitHubClient::with_base_url("http://api.github.com"),
            Err(GitHubError::InvalidInput { .. })
        ));
        assert!(matches!(
            GitHubClient::with_base_url("  "),
            Err(GitHubError::InvalidInput { .. })
        ));
        assert!(GitHubClient::with_base_url("http://127.0.0.1:9").is_ok());
        assert!(GitHubClient::new().is_ok());
    }
}
