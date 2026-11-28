//! Where published review-thread anchors land in the comparison Changes
//! shows. Local Git work only.

use super::{
    GithubAnchoredThread, GithubSnippetLine, GithubThreadAnchor, GithubThreadMappingRequest,
    GithubThreadPlacement, GithubThreadPosition, GithubUnplaceableReason,
};
use crate::{
    commands::{chat_catalog::ReviewThreadSide, github::GithubFailure},
    review_anchors::{
        numbered_lines, open_head, place_published_anchors, AnchorError, PublishedAnchor,
        PublishedPlacement, ReviewLineRange, Source, Texts,
    },
};
use git2::{Oid, Repository};

/// Lines of published context shown around an edited or outdated anchor.
const SNIPPET_BEFORE: u32 = 2;
const SNIPPET_AFTER: u32 = 1;
/// More than one read can return (see `vertebrae_github`), with headroom.
pub(super) const MAX_MAPPED_THREADS: usize = 1_000;

fn parse_oid(raw: &str) -> Result<Oid, GithubFailure> {
    Oid::from_str(raw).map_err(|_| GithubFailure::other(format!("{raw:?} is not a commit id")))
}

struct Commits {
    /// The PR's base ref, as GitHub reports it.
    base: Oid,
    head: Oid,
    /// GitHub's `Left` side: the merge base of the PR's base and head.
    published_base: Oid,
    shown_target: Source,
    shown_base: Oid,
}

impl Commits {
    /// The published commit of `side`, and the shown side it maps onto.
    fn sides(&self, side: ReviewThreadSide) -> (Oid, Source) {
        match side {
            ReviewThreadSide::Right => (self.head, self.shown_target),
            ReviewThreadSide::Left => (self.published_base, Source::Commit(self.shown_base)),
        }
    }
}

/// A range spanning both sides is placed on its last line alone: its first
/// line lives in the other version of the file.
fn range(anchor: &GithubThreadAnchor, start_line: Option<u32>, line: u32) -> (u32, u32) {
    let cross_side = anchor.start_side.is_some_and(|side| side != anchor.side);
    let start_line = if cross_side {
        line
    } else {
        start_line.unwrap_or(line)
    };
    (start_line, line)
}

fn snippet(
    texts: &mut Texts<'_>,
    commit: Oid,
    path: &str,
    start_line: u32,
    line: u32,
) -> Vec<GithubSnippetLine> {
    let Ok(Some(bytes)) = texts.text(Source::Commit(commit), path) else {
        return Vec::new();
    };
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Vec::new();
    };
    numbered_lines(
        text,
        start_line.saturating_sub(SNIPPET_BEFORE),
        line.saturating_add(SNIPPET_AFTER),
    )
    .into_iter()
    .map(|(number, text)| GithubSnippetLine {
        number,
        text,
        focus: (start_line..=line).contains(&number),
    })
    .collect()
}

/// The commented code where its commit is available locally: the head of
/// the original diff for `Right`, its base for `Left`.
fn outdated(
    repo: &Repository,
    texts: &mut Texts<'_>,
    commits: &Commits,
    anchor: &GithubThreadAnchor,
) -> GithubThreadPlacement {
    let Some(line) = anchor.original_line else {
        return GithubThreadPlacement::Outdated {
            original_start_line: None,
            original_line: None,
            original: Vec::new(),
            original_commit: None,
        };
    };
    let (start_line, line) = range(anchor, anchor.original_start_line, line);
    let commit = anchor
        .original_commit_oid
        .as_deref()
        .and_then(|raw| Oid::from_str(raw).ok())
        .and_then(|commit| match anchor.side {
            ReviewThreadSide::Right => Some(commit),
            ReviewThreadSide::Left => repo.merge_base(commit, commits.base).ok(),
        });
    let (original, original_commit) = match commit {
        Some(commit) if start_line >= 1 && start_line <= line => {
            let original = snippet(texts, commit, &anchor.path, start_line, line);
            let read = (!original.is_empty()).then(|| commit.to_string());
            (original, read)
        }
        _ => (Vec::new(), None),
    };
    GithubThreadPlacement::Outdated {
        original_start_line: Some(start_line),
        original_line: Some(line),
        original,
        original_commit,
    }
}

fn placed(
    texts: &mut Texts<'_>,
    anchor: &PublishedAnchor<'_>,
    result: Result<PublishedPlacement, AnchorError>,
) -> GithubThreadPlacement {
    let ReviewLineRange { start_line, line } = anchor.range;
    match result {
        Ok(PublishedPlacement::Mapped(mapped)) => GithubThreadPlacement::Anchored {
            start_line: mapped.start_line,
            line: mapped.line,
            published_line: line,
        },
        Ok(PublishedPlacement::Edited { lines }) => GithubThreadPlacement::Edited {
            start_line,
            line,
            published: snippet(texts, anchor.published, anchor.path, start_line, line),
            edited_lines: lines,
            published_commit: anchor.published.to_string(),
        },
        Ok(PublishedPlacement::Missing) | Err(AnchorError::UnbornHead) => {
            GithubThreadPlacement::NotShown
        }
        Err(AnchorError::MissingCommit) => GithubThreadPlacement::Unverified { start_line, line },
        Err(AnchorError::InvalidRange | AnchorError::InvalidPath) => {
            GithubThreadPlacement::Unplaceable {
                reason: GithubUnplaceableReason::InvalidAnchor,
            }
        }
        Err(AnchorError::NotRepository | AnchorError::Unreadable | AnchorError::Git) => {
            GithubThreadPlacement::Unplaceable {
                reason: GithubUnplaceableReason::Unreadable,
            }
        }
    }
}

pub(super) fn map_threads(
    repo: &Repository,
    request: &GithubThreadMappingRequest,
) -> Result<Vec<GithubThreadPosition>, GithubFailure> {
    if request.threads.len() > MAX_MAPPED_THREADS {
        return Err(GithubFailure::other(format!(
            "Too many review threads to place ({})",
            request.threads.len()
        )));
    }
    let head = parse_oid(&request.head_oid)?;
    let base = parse_oid(&request.base_oid)?;
    let commits = Commits {
        base,
        head,
        published_base: repo.merge_base(base, head).unwrap_or(base),
        shown_target: match request.shown_target.as_deref() {
            Some(raw) => Source::Commit(parse_oid(raw)?),
            None => Source::WorkingTree,
        },
        shown_base: parse_oid(&request.shown_base)?,
    };
    // Without a commit there is no comparison to show threads on.
    let unborn = commits.shown_target == Source::WorkingTree
        && open_head(repo) == Err(AnchorError::UnbornHead);

    let mut texts = Texts::new(repo);
    let mut placements = Vec::with_capacity(request.threads.len());
    let mut live = Vec::new();
    for (index, GithubAnchoredThread { anchor, .. }) in request.threads.iter().enumerate() {
        let placement = if anchor.file_level {
            Some(GithubThreadPlacement::FileLevel)
        } else if let Some(line) = anchor.line.filter(|_| !anchor.outdated) {
            let (start_line, line) = range(anchor, anchor.start_line, line);
            if start_line == 0 || start_line > line {
                Some(GithubThreadPlacement::Unplaceable {
                    reason: GithubUnplaceableReason::InvalidAnchor,
                })
            } else if unborn {
                Some(GithubThreadPlacement::NotShown)
            } else {
                let (published, shown) = commits.sides(anchor.side);
                live.push((
                    index,
                    PublishedAnchor {
                        published,
                        shown,
                        path: &anchor.path,
                        range: ReviewLineRange { start_line, line },
                    },
                ));
                None
            }
        } else {
            Some(outdated(repo, &mut texts, &commits, anchor))
        };
        placements.push(placement);
    }

    let anchors: Vec<_> = live.iter().map(|(_, anchor)| *anchor).collect();
    for ((index, anchor), result) in live.iter().zip(place_published_anchors(repo, &anchors)) {
        placements[*index] = Some(placed(&mut texts, anchor, result));
    }
    Ok(request
        .threads
        .iter()
        .zip(placements)
        .map(|(thread, placement)| GithubThreadPosition {
            thread_id: thread.thread_id.clone(),
            placement: placement.unwrap_or(GithubThreadPlacement::NotShown),
        })
        .collect())
}
