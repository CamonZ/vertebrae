//! Writes to pull request review threads: reply, resolve, reopen, and start
//! a thread on published lines. Each write is one GraphQL mutation sent
//! once, to the node it names (a thread, or the pull request a read
//! answered); callers reconcile a failed or timed-out write by reading the
//! threads again.
//!
//! A new thread is published at once, as a review of its one comment:
//! GitHub files a bare `addPullRequestReviewThread` in the viewer's pending
//! review, where nobody else sees it and it cannot be resolved.

use crate::{auth::GitHubToken, node_id::is_valid_node_id, DiffSide, GitHubClient, GitHubError};
use serde::Deserialize;
use serde_json::{json, Value};

/// GitHub's limit on a comment body, in characters.
pub const MAX_COMMENT_CHARS: usize = 65_536;

const REPLY_MUTATION: &str = r#"
mutation ReplyToReviewThread($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) {
    comment { id }
  }
}
"#;

const RESOLVE_MUTATION: &str = r#"
mutation ResolveReviewThread($thread: ID!) {
  resolveReviewThread(input: { threadId: $thread }) {
    thread { id }
  }
}
"#;

const UNRESOLVE_MUTATION: &str = r#"
mutation UnresolveReviewThread($thread: ID!) {
  unresolveReviewThread(input: { threadId: $thread }) {
    thread { id }
  }
}
"#;

/// Answers with the PR's newest threads, since a review lists its comments
/// but not their threads; the new thread is the one its comment starts.
const START_MUTATION: &str = r#"
mutation StartReviewThread(
  $pullRequest: ID!, $path: String!, $body: String!,
  $line: Int!, $side: DiffSide!, $startLine: Int, $startSide: DiffSide
) {
  addPullRequestReview(input: {
    pullRequestId: $pullRequest, event: COMMENT,
    threads: [{
      path: $path, body: $body,
      line: $line, side: $side, startLine: $startLine, startSide: $startSide
    }]
  }) {
    pullRequestReview {
      comments(first: 1) { nodes { id } }
      pullRequest {
        reviewThreads(last: 100) { nodes { id comments(first: 1) { nodes { id } } } }
      }
    }
  }
}
"#;

/// A new thread on lines `start_line..=line` of `path` on one side of the
/// pull request's published diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewReviewThread {
    pub path: String,
    pub side: DiffSide,
    /// `None` (or equal to `line`) for a single line.
    pub start_line: Option<u32>,
    pub line: u32,
    pub body: String,
}

/// One write to a pull request's review threads. Each names the node it
/// writes to, so none can go out without its target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewThreadWrite {
    Reply {
        thread_id: String,
        body: String,
    },
    Resolve {
        thread_id: String,
    },
    Reopen {
        thread_id: String,
    },
    /// A new thread on the pull request whose node ID a read of its threads
    /// answered ([`crate::PullRequestReviewThreads::pull_request_id`]).
    Start {
        pull_request_id: String,
        thread: NewReviewThread,
    },
}

fn invalid(message: &str) -> GitHubError {
    GitHubError::InvalidInput {
        message: message.into(),
    }
}

fn check_node_id(id: &str, what: &str) -> Result<(), GitHubError> {
    if is_valid_node_id(id) {
        Ok(())
    } else {
        Err(invalid(&format!("{what} ID is not a GitHub node ID")))
    }
}

fn check_body(body: &str) -> Result<(), GitHubError> {
    if body.trim().is_empty() {
        return Err(invalid("A comment needs some text"));
    }
    if body.chars().count() > MAX_COMMENT_CHARS {
        return Err(invalid("The comment is longer than GitHub allows"));
    }
    Ok(())
}

/// Rejects a write GitHub would refuse, before anything is sent.
pub(crate) fn validate(write: &ReviewThreadWrite) -> Result<(), GitHubError> {
    match write {
        ReviewThreadWrite::Reply { thread_id, body } => {
            check_node_id(thread_id, "Review thread")?;
            check_body(body)
        }
        ReviewThreadWrite::Resolve { thread_id } | ReviewThreadWrite::Reopen { thread_id } => {
            check_node_id(thread_id, "Review thread")
        }
        ReviewThreadWrite::Start {
            pull_request_id,
            thread,
        } => {
            check_node_id(pull_request_id, "Pull request")?;
            if thread.path.trim().is_empty() {
                return Err(invalid("A new thread needs a file path"));
            }
            if thread.line == 0 || thread.start_line.is_some_and(|start| start == 0) {
                return Err(invalid("Line numbers start at 1"));
            }
            if thread.start_line.is_some_and(|start| start > thread.line) {
                return Err(invalid("A thread's first line comes before its last"));
            }
            check_body(&thread.body)
        }
    }
}

fn side_name(side: DiffSide) -> &'static str {
    match side {
        DiffSide::Left => "LEFT",
        DiffSide::Right => "RIGHT",
    }
}

/// The mutation for `write`, its variables, and the response field it
/// answers in.
pub(crate) fn mutation(write: &ReviewThreadWrite) -> (&'static str, Value, &'static str) {
    match write {
        ReviewThreadWrite::Reply { thread_id, body } => (
            REPLY_MUTATION,
            json!({ "thread": thread_id, "body": body }),
            "addPullRequestReviewThreadReply",
        ),
        ReviewThreadWrite::Resolve { thread_id } => (
            RESOLVE_MUTATION,
            json!({ "thread": thread_id }),
            "resolveReviewThread",
        ),
        ReviewThreadWrite::Reopen { thread_id } => (
            UNRESOLVE_MUTATION,
            json!({ "thread": thread_id }),
            "unresolveReviewThread",
        ),
        ReviewThreadWrite::Start {
            pull_request_id,
            thread,
        } => {
            // GitHub wants a range's start only when it differs from its end.
            let start = thread.start_line.filter(|start| *start < thread.line);
            (
                START_MUTATION,
                json!({
                    "pullRequest": pull_request_id,
                    "path": thread.path,
                    "body": thread.body,
                    "line": thread.line,
                    "side": side_name(thread.side),
                    "startLine": start,
                    "startSide": start.map(|_| side_name(thread.side)),
                }),
                "addPullRequestReview",
            )
        }
    }
}

#[derive(Debug, Deserialize)]
struct NodeRef {
    id: String,
}

#[derive(Debug, Deserialize)]
struct Nodes<T> {
    nodes: Vec<Option<T>>,
}

impl<T> Nodes<T> {
    fn iter(&self) -> impl Iterator<Item = &T> {
        self.nodes.iter().flatten()
    }
}

/// What a mutation answers with: the posted comment, the written thread, or
/// the review that published a new thread.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    comment: Option<NodeRef>,
    thread: Option<NodeRef>,
    pull_request_review: Option<PublishedReview>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishedReview {
    comments: Nodes<NodeRef>,
    pull_request: ReviewedPullRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewedPullRequest {
    review_threads: Nodes<StartedThread>,
}

#[derive(Debug, Deserialize)]
struct StartedThread {
    id: String,
    comments: Nodes<NodeRef>,
}

impl PublishedReview {
    /// The thread the review's comment starts.
    fn thread_id(self) -> Option<String> {
        let comment = &self.comments.iter().next()?.id;
        self.pull_request
            .review_threads
            .iter()
            .find(|thread| {
                thread
                    .comments
                    .iter()
                    .next()
                    .is_some_and(|c| &c.id == comment)
            })
            .map(|thread| thread.id.clone())
    }
}

impl GitHubClient {
    /// Sends `write` once and returns the ID of the thread it wrote (for a
    /// new thread, the one GitHub created). Posts to GitHub.
    pub async fn write_review_thread(
        &self,
        token: &GitHubToken,
        write: &ReviewThreadWrite,
    ) -> Result<String, GitHubError> {
        validate(write)?;
        let (query, variables, field) = mutation(write);
        let mut data: serde_json::Map<String, Value> = self
            .graphql(token, query, variables)
            .await
            .map_err(unresolved_after_send)?;
        // GitHub answered the mutation without errors, so from here on the
        // write may well be on the PR: an answer that does not name it is
        // unconfirmed, never a failure to send again blindly.
        let payload: Payload = data
            .remove(field)
            .filter(|value| !value.is_null())
            .map(serde_json::from_value)
            .transpose()
            .map_err(|err| GitHubError::Unconfirmed {
                message: format!("Invalid {field} response: {err}"),
            })?
            .ok_or_else(|| GitHubError::Unconfirmed {
                message: format!("GitHub answered {field} without a result"),
            })?;
        match (write, payload) {
            (
                ReviewThreadWrite::Reply { thread_id, .. },
                Payload {
                    comment: Some(_), ..
                },
            ) => Ok(thread_id.clone()),
            (
                ReviewThreadWrite::Resolve { .. } | ReviewThreadWrite::Reopen { .. },
                Payload {
                    thread: Some(thread),
                    ..
                },
            ) => Ok(thread.id),
            (
                ReviewThreadWrite::Start { .. },
                Payload {
                    pull_request_review: Some(review),
                    ..
                },
            ) => review.thread_id().ok_or_else(|| GitHubError::Unconfirmed {
                message: "GitHub published the thread without listing it".into(),
            }),
            _ => Err(GitHubError::Unconfirmed {
                message: format!("GitHub answered {field} without the written node"),
            }),
        }
    }
}

/// A failed write, by whether GitHub may have applied it. A server error,
/// an answer that could not be read, or a GraphQL error GitHub gave no
/// type to (its own failures, timeouts included, come back that way) all
/// follow a request GitHub received: unconfirmed, so it is checked before
/// it is sent again. Anything else says the write was not applied.
fn unresolved_after_send(err: GitHubError) -> GitHubError {
    match err {
        GitHubError::Http { status, .. } if status >= 500 => GitHubError::Unconfirmed {
            message: err.to_string(),
        },
        GitHubError::Decode { .. } | GitHubError::GraphQl { .. } => GitHubError::Unconfirmed {
            message: err.to_string(),
        },
        other => other,
    }
}

#[cfg(test)]
mod tests;
