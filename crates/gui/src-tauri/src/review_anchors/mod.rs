//! Surface-agnostic review anchors: reading a file's text from a commit or
//! the working tree, and following a line range across an edit. Local
//! review threads and published (GitHub) threads both build on these.

mod git_source;
mod line_map;

use git2::{Oid, Repository};
use std::{collections::BTreeMap, rc::Rc};

pub(crate) use git_source::{commit_file, open_head, read_text, working_file, Source};
pub use line_map::ReviewLineRange;
pub(crate) use line_map::{map_range, numbered_lines, LineMap};

/// Why an anchor could not be read or followed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AnchorError {
    NotRepository,
    UnbornHead,
    /// The commit is not in the local object database (fetch to verify).
    MissingCommit,
    InvalidPath,
    /// The range is empty, starts at 0, or reaches past the content; also a
    /// published anchor on a file its commit does not have.
    InvalidRange,
    /// Not a text blob within the size limit.
    Unreadable,
    Git,
}

impl From<git2::Error> for AnchorError {
    fn from(error: git2::Error) -> Self {
        tracing::warn!(code = ?error.code(), class = ?error.class(), "review_anchor_git_failed");
        Self::Git
    }
}

/// Where a published anchor lands on the shown side.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PublishedPlacement {
    /// The anchored lines are unchanged; they now sit at this range.
    Mapped(ReviewLineRange),
    /// Edits changed the anchored lines.
    Edited,
    /// The file is absent from the shown side.
    Missing,
}

/// Lines `range` of `path` as published at `published`, to follow onto
/// `shown`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PublishedAnchor<'a> {
    pub published: Oid,
    pub shown: Source,
    pub path: &'a str,
    pub range: ReviewLineRange,
}

/// Place many published anchors at once. Anchors sharing a file and a pair
/// of sides read and diff that file once. Results keep the input order.
pub(crate) fn place_published_anchors(
    repo: &Repository,
    anchors: &[PublishedAnchor<'_>],
) -> Vec<Result<PublishedPlacement, AnchorError>> {
    let mut groups: BTreeMap<(Oid, Source, &str), Vec<usize>> = BTreeMap::new();
    for (index, anchor) in anchors.iter().enumerate() {
        groups
            .entry((anchor.published, anchor.shown, anchor.path))
            .or_default()
            .push(index);
    }
    let mut texts = Texts::new(repo);
    let mut placed = vec![Err(AnchorError::Git); anchors.len()];
    for ((published, shown, path), indices) in groups {
        let pair = texts
            .text(Source::Commit(published), path)
            .and_then(|original| original.ok_or(AnchorError::InvalidRange))
            .and_then(|original| Ok((original, texts.text(shown, path)?)));
        let map = match &pair {
            Err(error) => Err(*error),
            Ok((_, None)) => Ok(None),
            Ok((original, Some(current))) => LineMap::new(original, current).map(Some),
        };
        for index in indices {
            placed[index] = match &map {
                Err(error) => Err(*error),
                // Still an anchor on the published file, even when the shown
                // side lacks the file.
                Ok(None) => pair
                    .as_ref()
                    .map_err(|error| *error)
                    .and_then(|(original, _)| anchors[index].range.slice(original))
                    .map(|_| PublishedPlacement::Missing),
                Ok(Some(map)) => map.map(anchors[index].range).map(|mapped| match mapped {
                    Some(range) => PublishedPlacement::Mapped(range),
                    None => PublishedPlacement::Edited,
                }),
            };
        }
    }
    placed
}

/// A file's text, `None` when absent.
type Text = Result<Option<Rc<[u8]>>, AnchorError>;

/// File texts, read at most once per source and path; failures included.
pub(crate) struct Texts<'r> {
    repo: &'r Repository,
    read: BTreeMap<(Source, String), Text>,
}

impl<'r> Texts<'r> {
    pub(crate) fn new(repo: &'r Repository) -> Self {
        Self {
            repo,
            read: BTreeMap::new(),
        }
    }

    /// The text of `path` at `source`; `None` when the file is absent.
    pub(crate) fn text(&mut self, source: Source, path: &str) -> Text {
        let repo = self.repo;
        self.read
            .entry((source, path.to_owned()))
            .or_insert_with(|| Ok(read_text(repo, source, path)?.map(Rc::from)))
            .clone()
    }
}

#[cfg(test)]
mod tests;
