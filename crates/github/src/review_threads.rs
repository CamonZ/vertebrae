//! Pull request review threads: their published anchors and comments.

use crate::{
    auth::GitHubToken, error::bounded_message, wire::GraphQlPageInfo, GitHubClient, GitHubError,
    RepoRef,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

const THREAD_PAGE_SIZE: u32 = 50;
const COMMENTS_PER_THREAD: u32 = 30;
/// Bounds one read to `THREAD_PAGE_SIZE * MAX_THREAD_PAGES` threads.
const MAX_THREAD_PAGES: usize = 10;
const AVATAR_SIZE: u32 = 48;

const REVIEW_THREADS_QUERY: &str = r#"
query PullRequestReviewThreads(
  $owner: String!, $repo: String!, $number: Int!,
  $first: Int!, $comments: Int!, $after: String, $avatar: Int!
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      baseRefOid
      reviewThreads(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          path
          diffSide
          startDiffSide
          line
          startLine
          originalLine
          originalStartLine
          subjectType
          isOutdated
          isResolved
          viewerCanResolve
          viewerCanUnresolve
          viewerCanReply
          comments(first: $comments) {
            totalCount
            nodes {
              id
              body
              createdAt
              url
              originalCommit { oid }
              author { login avatarUrl(size: $avatar) }
            }
          }
        }
      }
    }
  }
}
"#;

/// The side of a pull request diff a thread is anchored on: `Left` is the
/// base version, `Right` the head.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffSide {
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewAuthor {
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewComment {
    pub id: String,
    /// `None` when the author's account was deleted.
    pub author: Option<ReviewAuthor>,
    /// GitHub-flavoured Markdown as written.
    pub body: String,
    pub created_at: Option<String>,
    pub url: String,
}

/// One review thread with its anchor on the PR's published diff.
///
/// `line`/`start_line` locate the thread on the current head (`None` once
/// GitHub considers the thread outdated); `original_*` locate it on the
/// commit it was written against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewThread {
    pub id: String,
    pub path: String,
    pub side: DiffSide,
    pub start_side: Option<DiffSide>,
    pub line: Option<u32>,
    pub start_line: Option<u32>,
    pub original_line: Option<u32>,
    pub original_start_line: Option<u32>,
    /// Commit the thread was written against (`original_*` refer to it).
    pub original_commit_oid: Option<String>,
    /// The thread comments on the file rather than on lines.
    pub file_level: bool,
    pub outdated: bool,
    pub resolved: bool,
    pub viewer_can_resolve: bool,
    pub viewer_can_unresolve: bool,
    pub viewer_can_reply: bool,
    pub comments: Vec<ReviewComment>,
    /// Comments beyond `comments` exist on GitHub.
    pub comments_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestReviewThreads {
    /// Commit the published (`Right`) anchors refer to.
    pub head_oid: String,
    pub base_oid: String,
    pub threads: Vec<ReviewThread>,
    /// More threads exist than one read returns.
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
struct ReviewThreadsData {
    repository: Option<ReviewThreadsRepo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewThreadsRepo {
    pull_request: Option<ReviewThreadsPr>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewThreadsPr {
    head_ref_oid: String,
    base_ref_oid: String,
    review_threads: ThreadConnection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadConnection {
    #[serde(default)]
    page_info: Option<GraphQlPageInfo>,
    nodes: Vec<Option<ThreadNode>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadNode {
    id: String,
    path: String,
    diff_side: String,
    start_diff_side: Option<String>,
    line: Option<u32>,
    start_line: Option<u32>,
    original_line: Option<u32>,
    original_start_line: Option<u32>,
    subject_type: Option<String>,
    #[serde(default)]
    is_outdated: bool,
    #[serde(default)]
    is_resolved: bool,
    #[serde(default)]
    viewer_can_resolve: bool,
    #[serde(default)]
    viewer_can_unresolve: bool,
    #[serde(default)]
    viewer_can_reply: bool,
    comments: CommentConnection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentConnection {
    #[serde(default)]
    total_count: usize,
    nodes: Vec<Option<CommentNode>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentNode {
    id: String,
    body: String,
    created_at: Option<String>,
    url: String,
    original_commit: Option<CommitNode>,
    author: Option<AuthorNode>,
}

#[derive(Debug, Deserialize)]
struct CommitNode {
    oid: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorNode {
    login: String,
    avatar_url: Option<String>,
}

fn diff_side(raw: &str, thread: &str) -> Result<DiffSide, GitHubError> {
    match raw {
        "LEFT" => Ok(DiffSide::Left),
        "RIGHT" => Ok(DiffSide::Right),
        unknown => Err(GitHubError::Decode {
            message: format!(
                "Unknown diff side {} for review thread {}",
                bounded_message(unknown),
                bounded_message(thread)
            ),
        }),
    }
}

impl TryFrom<ThreadNode> for ReviewThread {
    type Error = GitHubError;

    fn try_from(node: ThreadNode) -> Result<Self, Self::Error> {
        let side = diff_side(&node.diff_side, &node.id)?;
        let start_side = node
            .start_diff_side
            .as_deref()
            .map(|raw| diff_side(raw, &node.id))
            .transpose()?;
        let nodes: Vec<CommentNode> = node.comments.nodes.into_iter().flatten().collect();
        let original_commit_oid = nodes
            .first()
            .and_then(|comment| comment.original_commit.as_ref())
            .map(|commit| commit.oid.clone());
        let comments: Vec<ReviewComment> = nodes
            .into_iter()
            .map(|comment| ReviewComment {
                id: comment.id,
                author: comment.author.map(|author| ReviewAuthor {
                    login: author.login,
                    avatar_url: author.avatar_url,
                }),
                body: comment.body,
                created_at: comment.created_at,
                url: comment.url,
            })
            .collect();
        Ok(Self {
            comments_truncated: node.comments.total_count > comments.len(),
            id: node.id,
            path: node.path,
            side,
            start_side,
            line: node.line,
            start_line: node.start_line,
            original_line: node.original_line,
            original_start_line: node.original_start_line,
            original_commit_oid,
            file_level: node.subject_type.as_deref() == Some("FILE"),
            outdated: node.is_outdated,
            resolved: node.is_resolved,
            viewer_can_resolve: node.viewer_can_resolve,
            viewer_can_unresolve: node.viewer_can_unresolve,
            viewer_can_reply: node.viewer_can_reply,
            comments,
        })
    }
}

impl GitHubClient {
    /// Every review thread of PR `number`, with its first comments, read in
    /// pages up to a fixed bound (`truncated` reports what was left out).
    /// Read-only.
    pub async fn list_review_threads(
        &self,
        token: &GitHubToken,
        repo: &RepoRef,
        number: u64,
    ) -> Result<PullRequestReviewThreads, GitHubError> {
        if number == 0 {
            return Err(GitHubError::InvalidInput {
                message: "Pull request number must be greater than zero".into(),
            });
        }

        let mut after: Option<String> = None;
        let mut threads = Vec::new();
        let mut oids = None;
        for _ in 0..MAX_THREAD_PAGES {
            let data: ReviewThreadsData = self
                .graphql(
                    token,
                    REVIEW_THREADS_QUERY,
                    json!({
                        "owner": repo.owner,
                        "repo": repo.repo,
                        "number": number,
                        "first": THREAD_PAGE_SIZE,
                        "comments": COMMENTS_PER_THREAD,
                        "after": after,
                        "avatar": AVATAR_SIZE,
                    }),
                )
                .await?;
            let pr = data
                .repository
                .and_then(|repo| repo.pull_request)
                .ok_or_else(|| GitHubError::NotFound {
                    message: format!("Pull request #{number} not found in {}", repo.full_name()),
                })?;
            // Anchors refer to the head of the first page; a push between
            // pages is picked up by the caller's next refresh.
            oids.get_or_insert((pr.head_ref_oid, pr.base_ref_oid));
            for node in pr.review_threads.nodes.into_iter().flatten() {
                threads.push(ReviewThread::try_from(node)?);
            }
            let next = pr
                .review_threads
                .page_info
                .filter(|info| info.has_next_page)
                .and_then(|info| info.end_cursor);
            match next {
                Some(cursor) => after = Some(cursor),
                None => {
                    after = None;
                    break;
                }
            }
        }

        let (head_oid, base_oid) = oids.unwrap_or_default();
        Ok(PullRequestReviewThreads {
            head_oid,
            base_oid,
            threads,
            truncated: after.is_some(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        matchers::{body_partial_json, method, path},
        Mock, MockServer, ResponseTemplate,
    };

    fn demo_repo() -> RepoRef {
        RepoRef::new("github.com", "example", "demo-repo")
    }

    fn token() -> GitHubToken {
        GitHubToken::new("gho_synthetic_token").unwrap()
    }

    fn comment(id: &str, login: Option<&str>, body: &str) -> serde_json::Value {
        json!({
            "id": id,
            "body": body,
            "createdAt": "2026-11-24T12:00:00Z",
            "url": format!("https://github.com/example/demo-repo/pull/7#discussion_{id}"),
            "originalCommit": { "oid": "3333333333333333333333333333333333333333" },
            "author": login.map(|login| json!({
                "login": login,
                "avatarUrl": format!("https://avatars.example.invalid/{login}")
            })),
        })
    }

    fn thread(id: &str, side: &str, line: Option<u32>, outdated: bool) -> serde_json::Value {
        json!({
            "id": id,
            "path": "src/retry.rs",
            "diffSide": side,
            "startDiffSide": null,
            "line": line,
            "startLine": null,
            "originalLine": 12,
            "originalStartLine": null,
            "subjectType": "LINE",
            "isOutdated": outdated,
            "isResolved": false,
            "viewerCanResolve": true,
            "viewerCanUnresolve": false,
            "viewerCanReply": true,
            "comments": {
                "totalCount": 1,
                "nodes": [comment(&format!("{id}-c1"), Some("alice"), "Bound the retries")]
            }
        })
    }

    fn page(nodes: serde_json::Value, next: Option<&str>) -> serde_json::Value {
        json!({
            "data": {
                "repository": {
                    "pullRequest": {
                        "headRefOid": "1111111111111111111111111111111111111111",
                        "baseRefOid": "2222222222222222222222222222222222222222",
                        "reviewThreads": {
                            "pageInfo": { "hasNextPage": next.is_some(), "endCursor": next },
                            "nodes": nodes
                        }
                    }
                }
            }
        })
    }

    async fn client_for(server: &MockServer) -> GitHubClient {
        GitHubClient::with_base_url(&server.uri()).unwrap()
    }

    #[tokio::test]
    async fn reads_threads_across_pages_with_normalized_anchors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_partial_json(
                json!({ "variables": { "after": null, "number": 7 } }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(page(
                json!([thread("T1", "RIGHT", Some(14), false), null]),
                Some("cursor-1"),
            )))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_partial_json(
                json!({ "variables": { "after": "cursor-1" } }),
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(page(json!([thread("T2", "LEFT", None, true)]), None)),
            )
            .expect(1)
            .mount(&server)
            .await;

        let result = client_for(&server)
            .await
            .list_review_threads(&token(), &demo_repo(), 7)
            .await
            .unwrap();

        assert_eq!(result.head_oid, "1111111111111111111111111111111111111111");
        assert!(!result.truncated);
        assert_eq!(result.threads.len(), 2);
        let first = &result.threads[0];
        assert_eq!(first.side, DiffSide::Right);
        assert_eq!(first.line, Some(14));
        assert_eq!(first.original_line, Some(12));
        assert_eq!(
            first.original_commit_oid.as_deref(),
            Some("3333333333333333333333333333333333333333")
        );
        assert!(!first.file_level && !first.outdated && first.viewer_can_resolve);
        assert_eq!(first.comments[0].body, "Bound the retries");
        assert_eq!(
            first.comments[0].author.as_ref().map(|a| a.login.as_str()),
            Some("alice")
        );
        assert!(!first.comments_truncated);
        let second = &result.threads[1];
        assert_eq!(second.side, DiffSide::Left);
        assert_eq!(second.line, None);
        assert!(second.outdated);
    }

    #[tokio::test]
    async fn truncation_and_deleted_authors_are_reported() {
        let server = MockServer::start().await;
        let mut node = thread("T1", "RIGHT", Some(3), false);
        node["comments"] = json!({
            "totalCount": 40,
            "nodes": [comment("c1", None, "ghost comment")]
        });
        node["subjectType"] = json!("FILE");
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(page(json!([node]), Some("more"))),
            )
            .mount(&server)
            .await;

        let result = client_for(&server)
            .await
            .list_review_threads(&token(), &demo_repo(), 7)
            .await
            .unwrap();

        assert!(result.truncated);
        assert_eq!(result.threads.len(), MAX_THREAD_PAGES);
        let first = &result.threads[0];
        assert!(first.comments_truncated);
        assert!(first.file_level);
        assert_eq!(first.comments[0].author, None);
    }

    #[tokio::test]
    async fn unknown_side_and_missing_pr_are_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_partial_json(json!({ "variables": { "number": 7 } })))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(page(json!([thread("T1", "MIDDLE", Some(1), false)]), None)),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_partial_json(json!({ "variables": { "number": 8 } })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "repository": { "pullRequest": null } }
            })))
            .mount(&server)
            .await;
        let client = client_for(&server).await;

        assert!(matches!(
            client.list_review_threads(&token(), &demo_repo(), 7).await,
            Err(GitHubError::Decode { ref message }) if message.contains("MIDDLE")
        ));
        assert!(matches!(
            client.list_review_threads(&token(), &demo_repo(), 8).await,
            Err(GitHubError::NotFound { .. })
        ));
        assert!(matches!(
            client.list_review_threads(&token(), &demo_repo(), 0).await,
            Err(GitHubError::InvalidInput { .. })
        ));
    }
}
