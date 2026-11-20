//! Groups node-level edits by the declaration they change: one entry per
//! changed declaration, saying what happened to it as a whole and what
//! changed inside it.

use super::{Edit, LineSpan, Occurrence, ScopeSegment, SemanticChange};
use serde::Serialize;

/// One changed declaration (or the code outside every declaration).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct DeclarationDiff {
    /// Enclosing declarations, outermost first. Never a field, variant or
    /// import: changes inside one belong to its container.
    pub scope: Vec<ScopeSegment>,
    /// The declaration; `None` for code outside every declaration. A field,
    /// variant or import is a subject only when it is itself added,
    /// removed, moved or renamed.
    pub subject: Option<ScopeSegment>,
    pub change: DeclarationChange,
    /// What changed inside it, in line order.
    pub parts: Vec<Part>,
}

/// What happened to a declaration as a whole.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeclarationChange {
    Added {
        new: LineSpan,
    },
    Removed {
        old: LineSpan,
    },
    /// It now sits elsewhere (and may be edited inside).
    Moved {
        old: LineSpan,
        new: LineSpan,
    },
    /// Its name changed; the spans locate the name and `sites` every
    /// changed use, the name included.
    Renamed {
        old: LineSpan,
        new: LineSpan,
        from: String,
        to: String,
        sites: Vec<Occurrence>,
    },
    /// Only code inside it changed.
    Modified,
}

/// One change inside a declaration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Part {
    Added {
        new: LineSpan,
    },
    Removed {
        old: LineSpan,
    },
    /// Code that stayed in place and changed.
    Changed {
        old: LineSpan,
        new: LineSpan,
    },
    /// A change to a callable's header (parameters, return type, ...).
    Signature {
        old: Option<LineSpan>,
        new: Option<LineSpan>,
    },
    Moved {
        old: LineSpan,
        new: LineSpan,
    },
    /// A local name changed consistently; `sites` are every changed use.
    Renamed {
        old: LineSpan,
        new: LineSpan,
        from: String,
        to: String,
        sites: Vec<Occurrence>,
    },
}

impl Part {
    /// The part's lines on the old and new side, where it has them.
    pub fn spans(&self) -> (Option<LineSpan>, Option<LineSpan>) {
        match self {
            Self::Added { new } => (None, Some(*new)),
            Self::Removed { old } => (Some(*old), None),
            Self::Signature { old, new } => (*old, *new),
            Self::Changed { old, new }
            | Self::Moved { old, new }
            | Self::Renamed { old, new, .. } => (Some(*old), Some(*new)),
        }
    }
}

impl DeclarationChange {
    /// The declaration's own lines on each side, for a change to all of it.
    pub fn spans(&self) -> (Option<LineSpan>, Option<LineSpan>) {
        match self {
            Self::Added { new } => (None, Some(*new)),
            Self::Removed { old } => (Some(*old), None),
            Self::Moved { old, new } | Self::Renamed { old, new, .. } => (Some(*old), Some(*new)),
            Self::Modified => (None, None),
        }
    }
}

/// The same declaration: its kind and opening line on each side. Names are
/// not compared, as a renamed declaration's differ between sides.
fn same(x: &ScopeSegment, y: &ScopeSegment) -> bool {
    x.kind == y.kind && x.old_line == y.old_line && x.new_line == y.new_line
}

fn same_place(
    entry: &DeclarationDiff,
    scope: &[ScopeSegment],
    subject: Option<&ScopeSegment>,
) -> bool {
    let subjects = match (&entry.subject, subject) {
        (Some(x), Some(y)) => same(x, y),
        (None, None) => true,
        _ => false,
    };
    subjects
        && entry.scope.len() == scope.len()
        && entry.scope.iter().zip(scope).all(|(x, y)| same(x, y))
}

fn part(edit: Edit, signature: bool) -> Part {
    if signature {
        let (old, new) = edit.spans();
        return Part::Signature { old, new };
    }
    match edit {
        Edit::Insert { new } => Part::Added { new },
        Edit::Delete { old } => Part::Removed { old },
        Edit::Update { old, new } => Part::Changed { old, new },
        Edit::Move { old, new } => Part::Moved { old, new },
        Edit::Rename {
            old,
            new,
            from,
            to,
            occurrences,
        } => Part::Renamed {
            old,
            new,
            from,
            to,
            sites: occurrences,
        },
    }
}

/// A change to all of the declaration, when the edit is one.
fn whole(edit: &Edit) -> Option<DeclarationChange> {
    Some(match edit.clone() {
        Edit::Insert { new } => DeclarationChange::Added { new },
        Edit::Delete { old } => DeclarationChange::Removed { old },
        Edit::Move { old, new } => DeclarationChange::Moved { old, new },
        Edit::Rename {
            old,
            new,
            from,
            to,
            occurrences,
        } => DeclarationChange::Renamed {
            old,
            new,
            from,
            to,
            sites: occurrences,
        },
        Edit::Update { .. } => return None,
    })
}

/// Which of several changes to all of one declaration (moved and renamed)
/// is its `change`; the others are parts. Fixed, so both directions agree.
fn precedence(change: &DeclarationChange) -> u8 {
    match change {
        DeclarationChange::Added { .. } | DeclarationChange::Removed { .. } => 0,
        DeclarationChange::Moved { .. } => 1,
        DeclarationChange::Renamed { .. } => 2,
        DeclarationChange::Modified => 3,
    }
}

/// Node-level changes (in line order) by declaration, in order of each
/// declaration's first change. Scopes are named as on the new side where
/// a change was seen there.
pub(crate) fn group(changes: Vec<SemanticChange>) -> Vec<DeclarationDiff> {
    struct Entry {
        diff: DeclarationDiff,
        /// Its names come from the new side.
        named_new: bool,
        edits: Vec<SemanticChange>,
    }
    let mut entries: Vec<Entry> = Vec::new();
    for change in changes {
        let new_side = !matches!(change.edit, Edit::Delete { .. });
        let declared = change.declares && whole(&change.edit).is_some();
        let mut scope = change.scope.clone();
        // The declaration changed as a whole is the subject; otherwise the
        // innermost container around the change.
        if !declared {
            scope.retain(|segment| !segment.kind.member());
        }
        let subject = scope.pop();
        scope.retain(|segment| !segment.kind.member());
        let found = entries
            .iter()
            .position(|entry| same_place(&entry.diff, &scope, subject.as_ref()));
        let index = found.unwrap_or_else(|| {
            entries.push(Entry {
                diff: DeclarationDiff {
                    scope: Vec::new(),
                    subject: None,
                    change: DeclarationChange::Modified,
                    parts: Vec::new(),
                },
                named_new: false,
                edits: Vec::new(),
            });
            entries.len() - 1
        });
        let entry = &mut entries[index];
        if found.is_none() || (new_side && !entry.named_new) {
            entry.diff.scope = scope;
            entry.diff.subject = subject;
            entry.named_new = new_side;
        }
        entry.edits.push(change);
    }
    entries
        .into_iter()
        .map(|entry| {
            let mut diff = entry.diff;
            let main = entry
                .edits
                .iter()
                .enumerate()
                .filter(|(_, change)| change.declares)
                .filter_map(|(index, change)| Some((index, whole(&change.edit)?)))
                .min_by_key(|(_, change)| precedence(change));
            if let Some((_, change)) = &main {
                diff.change = change.clone();
            }
            diff.parts = entry
                .edits
                .into_iter()
                .enumerate()
                .filter(|(index, _)| main.as_ref().map(|(main, _)| main) != Some(index))
                .map(|(_, change)| part(change.edit, change.signature))
                .collect();
            diff
        })
        .collect()
}
