//! Semantic (syntax-aware) diffs: parse both versions of a file, match
//! their syntax nodes, and report what happened to each changed
//! declaration ([`DeclarationDiff`]): added, removed, moved, renamed, or
//! changed inside, with the scopes that enclose it, and the [`Fact`]s about
//! what kind of code each change touches (calls, effects, control flow,
//! error handling, data, API surface, concurrency, test code).
//!
//! The output is a pure function of the grammar and both texts (no clocks or
//! hash-map order feed into it), so it can be cached by content. Every file
//! gets either a change list or a [`FallbackReason`]; nothing here errors.
//!
//! Invariants, checked by the property tests:
//! - `diff(a, a)` has no changes;
//! - `diff(b, a)` mirrors `diff(a, b)`: insertions become deletions, moves
//!   and renames swap sides;
//! - whitespace-only edits produce no changes (except where the grammar
//!   makes layout significant, such as Python blocks); whitespace inside a
//!   string or character literal is content, not layout;
//! - facts mirror too (added ↔ removed), and appear for a change exactly
//!   when the facts query's captures it touches differ between the sides
//!   (literals and types only where replaced or themselves changed, calls
//!   as the API tables classify them; see `facts`).

mod declarations;
mod facts;
mod matching;
pub(crate) mod profile;
mod script;
mod tree;

use crate::Grammar;
pub use declarations::{DeclarationChange, DeclarationDiff, Part};
pub(crate) use facts::{
    call_parts as facts_call_parts, ignored_ranges as facts_ignored, inside as facts_inside,
    ApiTable,
};
pub use facts::{EffectKind, Fact, FactCategory, FactChange, FactKind, Facts};
use serde::Serialize;
use std::cell::Cell;
use std::time::{Duration, Instant};

/// Identifies the engine's output format and behaviour: callers caching
/// results by content key them with it too. Bump it whenever output for
/// the same input changes (a query, table, or derivation edit), and update
/// [`ENGINE_INPUTS`] with it.
pub const ENGINE_VERSION: u32 = 3;

/// A digest of every query and API table the engine reads, pinned with
/// [`ENGINE_VERSION`]: a test fails when they change without a bump.
#[cfg(test)]
pub(crate) const ENGINE_INPUTS: (u32, u64) = (ENGINE_VERSION, 0x4119_4238_4ea7_b0c2);

/// 1-based inclusive line range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct LineSpan {
    pub start: u32,
    pub end: u32,
}

impl LineSpan {
    fn new(start: u32, end: u32) -> Self {
        Self {
            start,
            end: end.max(start),
        }
    }

    pub fn contains(&self, line: u32) -> bool {
        (self.start..=self.end).contains(&line)
    }

    pub fn overlaps(&self, start: u32, end: u32) -> bool {
        self.start <= end && start <= self.end
    }
}

/// One use of a renamed name, on both sides.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Occurrence {
    pub old_line: u32,
    pub new_line: u32,
}

/// What happened to a node, with its location on the side(s) it exists on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Edit {
    Insert {
        new: LineSpan,
    },
    Delete {
        old: LineSpan,
    },
    /// The node stayed in place and its own text changed.
    Update {
        old: LineSpan,
        new: LineSpan,
    },
    /// The node (possibly edited inside) now sits elsewhere.
    Move {
        old: LineSpan,
        new: LineSpan,
    },
    /// A name changed consistently; the spans locate its binding and
    /// `occurrences` every changed use, the binding included.
    Rename {
        old: LineSpan,
        new: LineSpan,
        from: String,
        to: String,
        occurrences: Vec<Occurrence>,
    },
}

impl Edit {
    /// The edited node's lines on the old and new side, where it exists.
    pub(crate) fn spans(&self) -> (Option<LineSpan>, Option<LineSpan>) {
        match self {
            Self::Insert { new } => (None, Some(*new)),
            Self::Delete { old } => (Some(*old), None),
            Self::Update { old, new } | Self::Move { old, new } | Self::Rename { old, new, .. } => {
                (Some(*old), Some(*new))
            }
        }
    }
}

/// What a declaration declares, from the grammar's tags query
/// (`@definition.<kind>`) or this crate's supplement to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum DeclarationKind {
    Function,
    Method,
    /// Classes, structs, enums and unions.
    Class,
    Interface,
    Module,
    Macro,
    Constant,
    Impl,
    Type,
    Field,
    Variant,
    Import,
}

/// A named declaration such as `impl Foo` or `fn bar`, with its opening
/// line on each side it exists on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ScopeSegment {
    pub kind: DeclarationKind,
    /// The source's keyword before the name (`fn`, `struct`, `def`), or
    /// a word for the kind where there is none.
    pub keyword: String,
    pub name: String,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
}

/// One node-level edit, before grouping by declaration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SemanticChange {
    pub(crate) edit: Edit,
    /// Grammar node kind, e.g. `function_item`.
    pub(crate) node_kind: String,
    /// Enclosing scopes, outermost first; includes the node when it is one.
    pub(crate) scope: Vec<ScopeSegment>,
    /// The change sits in a callable's header (parameters, return type, ...).
    pub(crate) signature: bool,
    /// The edit inserts, deletes, moves or renames the innermost scope
    /// segment's declaration itself, not something inside it.
    pub(crate) declares: bool,
    /// What kind of code it touches.
    pub(crate) facts: Facts,
    /// For a declaration added or removed as a whole: its own first line
    /// (past leading comments and attributes).
    pub(crate) head: Option<u32>,
}

/// Why a file is shown as a line diff instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum FallbackReason {
    UnsupportedLanguage,
    SyntaxError,
    TooLarge,
    TimedOut,
    /// A side is binary, unreadable or not UTF-8. The engine takes text, so
    /// only callers that read the sides report this.
    NotText,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SemanticOutcome {
    Semantic {
        language: String,
        /// Changed declarations, in line order.
        declarations: Vec<DeclarationDiff>,
    },
    Fallback {
        reason: FallbackReason,
    },
}

/// Limits past which a file falls back to the line diff.
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    /// Per side.
    pub max_bytes: usize,
    /// Syntax nodes per side.
    pub max_nodes: usize,
    /// Wall time for parsing and matching both sides.
    pub time: Duration,
}

impl Default for Budget {
    fn default() -> Self {
        Self {
            max_bytes: 512 * 1024,
            max_nodes: 250_000,
            time: Duration::from_millis(200),
        }
    }
}

/// The time budget's end. Loops report work with [`Deadline::tick`], which
/// reads the clock once per [`Deadline::STEP`] units, so they can count as
/// they go without reading the clock each time.
pub(crate) struct Deadline {
    at: Instant,
    work: Cell<usize>,
}

impl Deadline {
    const STEP: usize = 4096;

    fn new(at: Instant) -> Self {
        Self {
            at,
            work: Cell::new(0),
        }
    }

    pub(crate) fn check(&self) -> Result<(), FallbackReason> {
        if Instant::now() >= self.at {
            Err(FallbackReason::TimedOut)
        } else {
            Ok(())
        }
    }

    /// Records `work` units (roughly, nodes visited).
    pub(crate) fn tick(&self, work: usize) -> Result<(), FallbackReason> {
        let total = self.work.get() + work.max(1);
        if total < Self::STEP {
            self.work.set(total);
            return Ok(());
        }
        self.work.set(0);
        self.check()
    }
}

/// Semantic diff of two versions of `path`. The grammar comes from the
/// path's extension; in a test file (by the language's convention, such
/// as Elixir's `test/…_test.exs`) every change is test code.
pub fn diff(path: &str, old: &str, new: &str, budget: &Budget) -> SemanticOutcome {
    let Some(grammar) = Grammar::for_path(path) else {
        return SemanticOutcome::Fallback {
            reason: FallbackReason::UnsupportedLanguage,
        };
    };
    let test_file = grammar
        .profile()
        .is_some_and(|profile| profile.is_test_file(path));
    outcome(
        grammar,
        node_changes(grammar, old, new, budget).map(|changes| match test_file {
            true => changes.into_iter().map(in_test).collect(),
            false => changes,
        }),
    )
}

pub fn diff_with(grammar: Grammar, old: &str, new: &str, budget: &Budget) -> SemanticOutcome {
    outcome(grammar, node_changes(grammar, old, new, budget))
}

/// A change in a test file is test code, as one under `#[test]` is.
fn in_test(mut change: SemanticChange) -> SemanticChange {
    let inside = Fact {
        kind: FactKind::TestCode,
        change: FactChange::Inside,
    };
    if !change.facts.items.contains(&inside) {
        change.facts.items.push(inside);
    }
    change
}

fn outcome(
    grammar: Grammar,
    changes: Result<Vec<SemanticChange>, FallbackReason>,
) -> SemanticOutcome {
    match changes {
        Ok(changes) => SemanticOutcome::Semantic {
            language: grammar.name().into(),
            declarations: declarations::group(changes),
        },
        Err(reason) => SemanticOutcome::Fallback { reason },
    }
}

/// The node-level edits, in line order.
pub(crate) fn node_changes(
    grammar: Grammar,
    old: &str,
    new: &str,
    budget: &Budget,
) -> Result<Vec<SemanticChange>, FallbackReason> {
    let (Some(profile), Some(compiled)) = (grammar.profile(), grammar.compiled()) else {
        return Err(FallbackReason::UnsupportedLanguage);
    };
    if old.len() > budget.max_bytes || new.len() > budget.max_bytes {
        return Err(FallbackReason::TooLarge);
    }
    if old == new {
        return Ok(Vec::new());
    }
    let deadline = Deadline::new(Instant::now() + budget.time);
    let parse = |source: &str| {
        let tree = grammar
            .parse_with_deadline(source, Some(deadline.at))
            .ok_or(FallbackReason::TimedOut)?;
        if tree.root_node().has_error() {
            return Err(FallbackReason::SyntaxError);
        }
        Ok(tree)
    };
    let (old_tree, new_tree) = (parse(old)?, parse(new)?);
    let build = |source, tree| {
        tree::SyntaxTree::build(
            source,
            tree,
            &compiled.declarations,
            &compiled.facts,
            profile.literals,
            profile.arity.as_ref(),
            budget.max_nodes,
            &deadline,
        )
    };
    let (old_tree, new_tree) = (build(old, &old_tree)?, build(new, &new_tree)?);
    let mapping = matching::match_trees(&old_tree, &new_tree, &deadline)?;
    deadline.check()?;
    let changes = script::changes(
        &old_tree,
        &new_tree,
        &mapping,
        profile,
        &compiled.apis,
        &deadline,
    )?;
    deadline.check()?;
    Ok(changes)
}

#[cfg(test)]
mod tests;
