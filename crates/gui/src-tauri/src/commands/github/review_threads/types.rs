//! The review-thread contract with the frontend: mirrors of the adapter's
//! plain types, and the placement request and answer.

use crate::commands::chat_catalog::ReviewThreadSide;
use serde::{Deserialize, Serialize};
use vertebrae_github::{DiffSide, ReviewComment, ReviewThread};

impl From<DiffSide> for ReviewThreadSide {
    fn from(side: DiffSide) -> Self {
        match side {
            DiffSide::Left => Self::Left,
            DiffSide::Right => Self::Right,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubReviewAuthor {
    pub login: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubReviewComment {
    pub id: String,
    /// `None` when the author's account was deleted.
    pub author: Option<GithubReviewAuthor>,
    /// GitHub-flavoured Markdown as written; untrusted.
    pub body: String,
    pub created_at: Option<String>,
    pub url: String,
}

impl From<ReviewComment> for GithubReviewComment {
    fn from(comment: ReviewComment) -> Self {
        Self {
            id: comment.id,
            author: comment.author.map(|author| GithubReviewAuthor {
                login: author.login,
            }),
            body: comment.body,
            created_at: comment.created_at,
            url: comment.url,
        }
    }
}

/// Where a thread is anchored on the PR's published diff, as GitHub
/// reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubThreadAnchor {
    pub path: String,
    /// Side of the last commented line.
    pub side: ReviewThreadSide,
    /// Side of the first commented line; `None` for a single line.
    pub start_side: Option<ReviewThreadSide>,
    /// Published range on the PR head; `None` once the thread is outdated.
    pub line: Option<u32>,
    pub start_line: Option<u32>,
    /// Range on the commit the thread was written against.
    pub original_line: Option<u32>,
    pub original_start_line: Option<u32>,
    pub original_commit_oid: Option<String>,
    pub file_level: bool,
    pub outdated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubReviewThread {
    pub id: String,
    pub anchor: GithubThreadAnchor,
    pub resolved: bool,
    pub viewer_can_resolve: bool,
    pub viewer_can_unresolve: bool,
    pub viewer_can_reply: bool,
    pub comments: Vec<GithubReviewComment>,
    pub comments_truncated: bool,
}

impl From<ReviewThread> for GithubReviewThread {
    fn from(thread: ReviewThread) -> Self {
        Self {
            id: thread.id,
            anchor: GithubThreadAnchor {
                path: thread.path,
                side: thread.side.into(),
                start_side: thread.start_side.map(Into::into),
                line: thread.line,
                start_line: thread.start_line,
                original_line: thread.original_line,
                original_start_line: thread.original_start_line,
                original_commit_oid: thread.original_commit_oid,
                file_level: thread.file_level,
                outdated: thread.outdated,
            },
            resolved: thread.resolved,
            viewer_can_resolve: thread.viewer_can_resolve,
            viewer_can_unresolve: thread.viewer_can_unresolve,
            viewer_can_reply: thread.viewer_can_reply,
            comments: thread.comments.into_iter().map(Into::into).collect(),
            comments_truncated: thread.comments_truncated,
        }
    }
}

/// One read of a PR's review threads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubPrReviewThreads {
    pub repo: String,
    pub pr_number: u32,
    /// Commit the published `Right` anchors refer to.
    pub head_oid: String,
    pub base_oid: String,
    pub threads: Vec<GithubReviewThread>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubAnchoredThread {
    pub thread_id: String,
    pub anchor: GithubThreadAnchor,
}

/// The published commits and the comparison Changes shows.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubThreadMappingRequest {
    pub head_oid: String,
    pub base_oid: String,
    /// The shown new side: a commit, or the working tree when `None`.
    pub shown_target: Option<String>,
    /// The shown old side.
    pub shown_base: String,
    pub threads: Vec<GithubAnchoredThread>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubSnippetLine {
    pub number: u32,
    pub text: String,
    /// One of the commented lines.
    pub focus: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GithubUnplaceableReason {
    /// The published range does not exist in the published file.
    InvalidAnchor,
    /// The file is not readable text (binary, too large, or a Git failure).
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GithubThreadPlacement {
    /// The commented lines are unchanged in the shown comparison; local
    /// edits above them may have moved them from `published_line`, the
    /// published end line.
    #[serde(rename_all = "camelCase")]
    Anchored {
        start_line: u32,
        line: u32,
        published_line: u32,
    },
    /// Local edits changed the commented lines: the thread stays at its
    /// published range, with the published text.
    #[serde(rename_all = "camelCase")]
    Edited {
        start_line: u32,
        line: u32,
        published: Vec<GithubSnippetLine>,
        /// The published lines the local edit changed or removed; empty
        /// when it only inserted lines inside the range.
        edited_lines: Vec<u32>,
        /// The commit `published` was read from: the commented lines as
        /// reviewers see them.
        published_commit: String,
    },
    /// GitHub no longer places the thread on the PR's diff; `original` is
    /// the commented code where its commit is available locally.
    #[serde(rename_all = "camelCase")]
    Outdated {
        original_start_line: Option<u32>,
        original_line: Option<u32>,
        original: Vec<GithubSnippetLine>,
        /// The commit `original` was read from; `None` without a snippet.
        original_commit: Option<String>,
    },
    /// A commit is not available locally (fetch to verify): shown at the
    /// published range as GitHub reports it.
    #[serde(rename_all = "camelCase")]
    Unverified { start_line: u32, line: u32 },
    /// The thread cannot be placed locally.
    Unplaceable { reason: GithubUnplaceableReason },
    /// The thread comments on the whole file.
    FileLevel,
    /// The file is absent from the shown side of the comparison, or HEAD is
    /// unborn and the working tree is shown.
    NotShown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubThreadPosition {
    pub thread_id: String,
    pub placement: GithubThreadPlacement,
}
