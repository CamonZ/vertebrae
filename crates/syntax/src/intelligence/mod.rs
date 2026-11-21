//! Code intelligence: definitions, references and calls between symbols,
//! behind a provider-neutral contract ([`CodeIntelligence`]).
//!
//! Every edge carries a [`Resolution`] saying how sure its target is, and
//! every answer names the [`ProviderId`] that produced it; answers from
//! different providers are never merged. The first provider is
//! [`EmbeddedProvider`] (tree-sitter, name-based, always available);
//! external servers (language servers, indexes) plug in later behind the
//! same trait, their wire protocols in their own adapters.
//!
//! Work is on demand: a request reads the files it needs from a
//! [`Snapshot`] (a worktree or a commit), within a [`Budget`]. Past the
//! budget a request returns what it found so far, marked
//! [`Truncation`], rather than blocking. There is no upfront index.
//!
//! Invariants, checked by the property tests:
//! - an edge is [`Resolution::Exact`] only when exactly one definition is
//!   bound to the name at the call site; several bindings give
//!   [`Resolution::Ambiguous`] listing every candidate; a call nothing
//!   resolves is reported as [`Resolution::Unresolved`], never dropped;
//! - for one snapshot and provider, `outgoing_calls(A)` has an edge to `B`
//!   (as its target or a candidate) iff `incoming_calls(B)` has that edge
//!   from `A`, unless either answer is truncated.

mod embedded;
mod extract;
mod modules;
mod resolve;
pub(crate) mod rules;
mod snapshot;

pub use embedded::{EmbeddedProvider, EmbeddedStats};
pub use snapshot::{MemorySnapshot, Snapshot, SnapshotError};

use crate::semantic::{DeclarationKind, LineSpan};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::Duration;

/// Which provider produced an answer, such as `embedded`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(transparent)]
pub struct ProviderId(String);

impl ProviderId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A definition: where it is and what it is.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct CodeSymbol {
    /// Snapshot-relative, with `/` separators.
    pub path: String,
    pub name: String,
    pub kind: DeclarationKind,
    /// The whole definition, comments and attributes before it excluded.
    pub span: LineSpan,
    /// The line of its name (1-based); with `path` and `name`, it
    /// identifies the symbol in requests ([`SymbolKey`]).
    pub line: u32,
    /// Enclosing definitions' names, outermost first.
    pub scope: Vec<String>,
}

impl CodeSymbol {
    pub fn key(&self) -> SymbolKey {
        SymbolKey {
            path: self.path.clone(),
            name: self.name.clone(),
            line: self.line,
        }
    }
}

/// Identifies a definition in a request: its file, name and the line of
/// its name, as a [`CodeSymbol`] from an earlier answer reports them.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SymbolKey {
    pub path: String,
    pub name: String,
    pub line: u32,
}

/// A point in a file, 1-based.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SourceLocation {
    pub path: String,
    pub line: u32,
    /// In UTF-8 bytes from the line's start, 1-based.
    pub column: u32,
}

/// How sure an edge's target is.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "quality", rename_all = "snake_case")]
pub enum Resolution {
    /// Exactly one definition is bound to the name where it is used.
    Exact { target: CodeSymbol },
    /// Nothing binds the name there; one definition elsewhere has it.
    NameMatch { target: CodeSymbol },
    /// Several definitions may be meant: shadowed or duplicated names, or
    /// several definitions sharing the name. Innermost binding first.
    Ambiguous { candidates: Vec<CodeSymbol> },
    /// No definition was found (an external API, a dynamic call, a name
    /// the provider cannot follow).
    Unresolved,
}

impl Resolution {
    /// The definitions the edge may lead to.
    pub fn targets(&self) -> &[CodeSymbol] {
        match self {
            Self::Exact { target } | Self::NameMatch { target } => std::slice::from_ref(target),
            Self::Ambiguous { candidates } => candidates,
            Self::Unresolved => &[],
        }
    }
}

/// One call site.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Call {
    /// The definition the call is in; `None` for code outside every
    /// definition (module-level code).
    pub caller: Option<CodeSymbol>,
    /// The callee as written, receiver or path included (`self.save`,
    /// `fs::write`).
    pub callee: String,
    /// The callee's name at the call.
    pub site: SourceLocation,
    pub resolution: Resolution,
}

/// A call into a symbol, `depth` calls away from the requested one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct IncomingCall {
    /// The symbol called: the requested one at depth 1, a caller of the
    /// previous depth's below that.
    pub target: SymbolKey,
    pub call: Call,
    pub depth: u32,
}

/// What a reference is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ReferenceKind {
    Call,
    Import,
    /// Any other use of the name.
    Use,
}

/// One use of a symbol's name that may refer to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Reference {
    pub kind: ReferenceKind,
    pub site: SourceLocation,
    /// The definition the use is in, if any.
    pub enclosing: Option<CodeSymbol>,
    pub resolution: Resolution,
}

/// Why an answer is incomplete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum Truncation {
    /// The time budget ran out.
    TimedOut,
    /// More files needed reading than the budget allows.
    FileLimit,
    /// More results were found than the budget allows.
    ResultLimit,
    /// Callers exist beyond the deepest level answered (the depth asked,
    /// or the budget's `max_depth` when that is lower).
    DepthLimit,
}

/// An answer: its items, the provider and, when incomplete, why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Answer<T> {
    pub provider: ProviderId,
    pub items: Vec<T>,
    /// `None` when the answer is complete.
    pub truncated: Option<Truncation>,
}

/// Limits of one request. Past any of them it stops and returns what it
/// found, marked truncated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    /// Wall time for the whole request.
    pub time: Duration,
    /// Files read (parsed or only searched for the name).
    pub max_files: usize,
    /// Items in the answer.
    pub max_results: usize,
    /// Deepest level of incoming calls.
    pub max_depth: u32,
    /// Files larger than this are skipped.
    pub max_file_bytes: usize,
}

impl Default for Budget {
    fn default() -> Self {
        Self {
            time: Duration::from_secs(2),
            max_files: 4_000,
            max_results: 2_000,
            max_depth: 8,
            max_file_bytes: 1024 * 1024,
        }
    }
}

/// Why a request has no answer at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IntelligenceError {
    /// No provider covers the file's language.
    UnsupportedLanguage { path: String },
    /// The file is missing, binary or too large.
    Unreadable { path: String },
    /// No definition matches the key (the file may have changed).
    UnknownSymbol { key: SymbolKey },
    /// Reading the snapshot failed.
    Snapshot { message: String },
}

impl fmt::Display for IntelligenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedLanguage { path } => write!(formatter, "{path}: unsupported language"),
            Self::Unreadable { path } => write!(formatter, "{path} cannot be read as source"),
            Self::UnknownSymbol { key } => {
                write!(formatter, "no {} at {}:{}", key.name, key.path, key.line)
            }
            Self::Snapshot { message } => write!(formatter, "snapshot: {message}"),
        }
    }
}

impl std::error::Error for IntelligenceError {}

impl From<SnapshotError> for IntelligenceError {
    fn from(error: SnapshotError) -> Self {
        Self::Snapshot {
            message: error.to_string(),
        }
    }
}

pub type Outcome<T> = Result<Answer<T>, IntelligenceError>;

/// The provider-neutral contract. Calls block the calling thread for at
/// most about the budget's time; callers on an async runtime run them on
/// a blocking worker. Implementations must be deterministic for a given
/// snapshot content: no clocks or hash order in results (a time budget
/// running out is reported as [`Truncation::TimedOut`]).
pub trait CodeIntelligence: Send + Sync {
    fn id(&self) -> ProviderId;

    /// The definitions in one file, in source order (imports excluded).
    fn definitions(
        &self,
        snapshot: &dyn Snapshot,
        path: &str,
        budget: &Budget,
    ) -> Outcome<CodeSymbol>;

    /// Uses of the symbol's name that may refer to it.
    fn references(
        &self,
        snapshot: &dyn Snapshot,
        symbol: &SymbolKey,
        budget: &Budget,
    ) -> Outcome<Reference>;

    /// The calls inside the symbol (not inside definitions nested in it),
    /// in source order, each with its resolution.
    fn outgoing_calls(
        &self,
        snapshot: &dyn Snapshot,
        symbol: &SymbolKey,
        budget: &Budget,
    ) -> Outcome<Call>;

    /// Calls made outside any declaration.
    fn module_calls(&self, snapshot: &dyn Snapshot, path: &str, budget: &Budget) -> Outcome<Call>;

    /// Calls that may reach the symbol, up to `depth` callers away
    /// (1: direct callers), each caller visited once.
    fn incoming_calls(
        &self,
        snapshot: &dyn Snapshot,
        symbol: &SymbolKey,
        depth: u32,
        budget: &Budget,
    ) -> Outcome<IncomingCall>;
}
