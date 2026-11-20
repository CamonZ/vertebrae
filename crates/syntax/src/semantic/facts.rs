//! Facts: what kind of code a change touches (effects at system
//! boundaries, concurrency, error handling, API surface, control flow,
//! calls, data, test code).
//!
//! Each language's facts query (`queries/<language>/facts.scm`) captures
//! the nodes facts are about; the vocabulary is in `queries/README.md`.
//! For one change, the captures of the nodes it touches are gathered on
//! each side: the changed nodes and their descendants, the nodes enclosing
//! them, and the counterparts of all of those on the other side. A fact
//! appears exactly when that capture multiset differs between the sides,
//! with two refinements:
//!
//! - literals and type annotations are reported when they are replaced
//!   (`~ 1 → 2`) or are themselves the changed node; adding or removing
//!   code adds or removes its literals and types, which says nothing more;
//! - calls, uses and annotations are classified by the language's
//!   known-API tables (`apis/`): an effect, a concurrency primitive, a
//!   trivial call that is not reported, or (for calls) a plain call.
//!
//! Captures are compared by structure (the hashes the matcher uses), so
//! layout never counts. The result is a pure function of grammar, query,
//! tables and both texts.

use super::tree::{display_name, NodeId, SyntaxTree};
use serde::Serialize;
use std::collections::BTreeMap;
use tree_sitter::{Language, Query, QueryCursor, StreamingIterator, Tree};

/// Fact groups, in display order: what crosses the system boundary first,
/// plain calls and data last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum FactCategory {
    Effects,
    Concurrency,
    ErrorHandling,
    Api,
    ControlFlow,
    Calls,
    Data,
    Test,
}

/// What a known API touches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum EffectKind {
    Filesystem,
    Network,
    Process,
    Database,
    IpcCommand,
    Event,
    Env,
    Ui,
}

/// What a fact is about. Declared in [`FactCategory`] order, so facts sort
/// by category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FactKind {
    /// A use of a known API at a system boundary.
    Effect {
        effect: EffectKind,
    },
    Spawn,
    Lock,
    Async,
    Await,
    /// Rust's `?`.
    Propagation,
    /// `unwrap`/`expect`, TypeScript's non-null `!`.
    Unwrap,
    /// A `catch` or `except` handler.
    Catch,
    /// `throw`, `raise` or a panicking macro.
    Throw,
    /// The error type of a `Result` or an `except` clause.
    ErrorType,
    /// `pub`, `export` or an accessibility modifier.
    Visibility,
    /// The parameters or return type of a public callable.
    Signature,
    /// An `if`, `else`, ternary or `elif`; its subject is the condition.
    Branch,
    /// A `match` arm, `case` or `switch` case; its subject is the pattern.
    MatchArm,
    EarlyReturn,
    /// Its subject is the condition or iterable.
    Loop,
    /// A call to code no API table knows.
    Call,
    Literal,
    Field,
    TypeAnnotation,
    /// The change is inside test code.
    TestCode,
}

impl FactKind {
    pub fn category(self) -> FactCategory {
        match self {
            Self::Effect { .. } => FactCategory::Effects,
            Self::Spawn | Self::Lock | Self::Async | Self::Await => FactCategory::Concurrency,
            Self::Propagation | Self::Unwrap | Self::Catch | Self::Throw | Self::ErrorType => {
                FactCategory::ErrorHandling
            }
            Self::Visibility | Self::Signature => FactCategory::Api,
            Self::Branch | Self::MatchArm | Self::EarlyReturn | Self::Loop => {
                FactCategory::ControlFlow
            }
            Self::Call => FactCategory::Calls,
            Self::Literal | Self::Field | Self::TypeAnnotation => FactCategory::Data,
            Self::TestCode => FactCategory::Test,
        }
    }

    /// Kinds whose removal and addition in one change read as one thing
    /// changed (a condition, a literal, a type), paired in source order.
    fn pairs(self) -> bool {
        matches!(
            self,
            Self::Branch
                | Self::MatchArm
                | Self::Loop
                | Self::ErrorType
                | Self::Literal
                | Self::TypeAnnotation
                | Self::Visibility
                | Self::Signature
        )
    }

    /// Kinds reported unpaired only when the captured node is itself what
    /// changed: inserted or deleted code brings its own literals and types.
    fn replaced_only(self) -> bool {
        matches!(self, Self::Literal | Self::TypeAnnotation)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FactChange {
    /// Present on the new side only.
    Added { subject: String },
    /// Present on the old side only.
    Removed { subject: String },
    /// One subject replaced by another (`x > 1` → `x > 2`).
    Changed { from: String, to: String },
    /// Context rather than a difference: the change sits inside it.
    Inside,
}

/// One fact about a change, e.g. "now calls `retry`".
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Fact {
    pub kind: FactKind,
    pub change: FactChange,
}

impl Fact {
    pub fn category(&self) -> FactCategory {
        self.kind.category()
    }

    /// The same fact seen from the other direction.
    pub fn mirrored(&self) -> Self {
        let change = match &self.change {
            FactChange::Added { subject } => FactChange::Removed {
                subject: subject.clone(),
            },
            FactChange::Removed { subject } => FactChange::Added {
                subject: subject.clone(),
            },
            FactChange::Changed { from, to } => FactChange::Changed {
                from: to.clone(),
                to: from.clone(),
            },
            FactChange::Inside => FactChange::Inside,
        };
        Self {
            kind: self.kind,
            change,
        }
    }

    /// A direction-free ordering, so a capped list keeps the same facts
    /// in both directions.
    fn priority(&self) -> (FactKind, &str, &str) {
        let (x, y) = match &self.change {
            FactChange::Added { subject } | FactChange::Removed { subject } => (subject, subject),
            FactChange::Changed { from, to } => (from, to),
            FactChange::Inside => return (self.kind, "", ""),
        };
        (self.kind, x.min(y), x.max(y))
    }
}

/// The facts of one change, at most [`Facts::MAX`] of them (the most
/// telling first); `omitted` counts the rest.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Facts {
    /// Sorted by category, then kind.
    pub items: Vec<Fact>,
    pub omitted: u32,
}

impl Facts {
    pub const MAX: usize = 64;

    pub fn is_empty(&self) -> bool {
        self.items.is_empty() && self.omitted == 0
    }

    /// The same facts seen from the other direction.
    pub fn mirrored(&self) -> Self {
        let mut items: Vec<Fact> = self.items.iter().map(Fact::mirrored).collect();
        items.sort();
        Self {
            items,
            omitted: self.omitted,
        }
    }
}

/// What a primary capture marks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Role {
    Call,
    Reference,
    Annotation,
    /// The node is test code.
    Test,
    /// The next item after it (past attributes and comments) is test code.
    TestMarker,
    Fact(FactKind),
}

/// Primary capture names: every name a facts query may use, with
/// [`Part`]s and `_`-prefixed predicate captures.
const PRIMARY: &[(&str, Role)] = &[
    ("call", Role::Call),
    ("reference", Role::Reference),
    ("annotation", Role::Annotation),
    ("test", Role::Test),
    ("test.marker", Role::TestMarker),
    ("control.branch", Role::Fact(FactKind::Branch)),
    ("control.match_arm", Role::Fact(FactKind::MatchArm)),
    ("control.early_return", Role::Fact(FactKind::EarlyReturn)),
    ("control.loop", Role::Fact(FactKind::Loop)),
    ("error.propagation", Role::Fact(FactKind::Propagation)),
    ("error.unwrap", Role::Fact(FactKind::Unwrap)),
    ("error.catch", Role::Fact(FactKind::Catch)),
    ("error.throw", Role::Fact(FactKind::Throw)),
    ("error.type", Role::Fact(FactKind::ErrorType)),
    ("data.literal", Role::Fact(FactKind::Literal)),
    ("data.field", Role::Fact(FactKind::Field)),
    ("data.type", Role::Fact(FactKind::TypeAnnotation)),
    ("api.visibility", Role::Fact(FactKind::Visibility)),
    ("api.signature", Role::Fact(FactKind::Signature)),
    ("concurrency.async", Role::Fact(FactKind::Async)),
    ("concurrency.await", Role::Fact(FactKind::Await)),
    ("concurrency.spawn", Role::Fact(FactKind::Spawn)),
    ("concurrency.lock", Role::Fact(FactKind::Lock)),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Part {
    /// Identifies and names the capture in place of the primary node.
    Subject,
    /// `receiver.name`.
    Receiver,
    /// `path::name`.
    Path,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CaptureName {
    Primary(Role),
    Part(Role, Part),
    /// `_`-prefixed: for predicates only.
    Ignored,
}

/// The meaning of a facts query capture name; `None` for an unknown one.
pub(crate) fn capture_name(name: &str) -> Option<CaptureName> {
    if name.starts_with('_') {
        return Some(CaptureName::Ignored);
    }
    let primary = |name: &str| {
        PRIMARY
            .iter()
            .find(|(known, _)| *known == name)
            .map(|(_, role)| *role)
    };
    if let Some(role) = primary(name) {
        return Some(CaptureName::Primary(role));
    }
    let (base, part) = name.rsplit_once('.')?;
    let part = match part {
        "subject" => Part::Subject,
        "receiver" => Part::Receiver,
        "path" => Part::Path,
        _ => return None,
    };
    Some(CaptureName::Part(primary(base)?, part))
}

/// A compiled facts query and the meaning of each capture index.
pub(crate) struct FactsQuery {
    pub(crate) query: Query,
    pub(crate) names: Vec<CaptureName>,
}

impl FactsQuery {
    pub(crate) fn compile(language: &Language, sources: &[&str]) -> Result<Self, String> {
        let source = sources.join("\n");
        let query = Query::new(language, &source).map_err(|error| error.to_string())?;
        let names = query
            .capture_names()
            .iter()
            .map(|name| capture_name(name).ok_or_else(|| format!("unknown capture @{name}")))
            .collect::<Result<_, _>>()?;
        Ok(Self { query, names })
    }
}

/// One primary capture in a tree.
pub(crate) struct Captured {
    pub(crate) node: NodeId,
    pub(crate) role: Role,
    /// Identifies and names it: its `.subject` part, else itself.
    pub(crate) subject: NodeId,
    pub(crate) qualifier: Option<(Part, NodeId)>,
}

/// Captures by node (sorted by node, then role), and the subtrees that
/// are test code.
#[derive(Default)]
pub(crate) struct Captures {
    pub(crate) all: Vec<Captured>,
    pub(crate) tests: Vec<NodeId>,
}

impl Captures {
    /// Runs the facts query; `ids` maps tree-sitter node ids to arena ids.
    pub(crate) fn find(
        tree: &SyntaxTree,
        syntax: &Tree,
        facts: &FactsQuery,
        ids: &std::collections::HashMap<usize, NodeId>,
        deadline: &super::Deadline,
    ) -> Result<Self, super::FallbackReason> {
        let mut out = Self::default();
        let mut markers = Vec::new();
        let mut cursor = QueryCursor::new();
        let mut matches = cursor.matches(&facts.query, syntax.root_node(), tree.source.as_bytes());
        let mut seen: usize = 0;
        while let Some(found) = matches.next() {
            seen += 1;
            if seen.is_multiple_of(256) {
                deadline.check()?;
            }
            let id = |node: &tree_sitter::Node| ids.get(&node.id()).copied();
            let parts = |role: Role, want: Part| {
                found.captures().iter().find_map(|capture| {
                    match facts.names[capture.index as usize] {
                        CaptureName::Part(of, part) if of == role && part == want => {
                            id(&capture.node)
                        }
                        _ => None,
                    }
                })
            };
            for capture in found.captures() {
                let CaptureName::Primary(role) = facts.names[capture.index as usize] else {
                    continue;
                };
                let Some(node) = id(&capture.node) else {
                    continue;
                };
                match role {
                    Role::Test => {
                        out.tests.push(node);
                        continue;
                    }
                    Role::TestMarker => {
                        markers.push(node);
                        continue;
                    }
                    _ => {}
                }
                let qualifier = parts(role, Part::Receiver)
                    .map(|id| (Part::Receiver, id))
                    .or_else(|| parts(role, Part::Path).map(|id| (Part::Path, id)));
                out.all.push(Captured {
                    node,
                    role,
                    subject: parts(role, Part::Subject).unwrap_or(node),
                    qualifier,
                });
            }
        }
        // A marker (`#[test]`) marks itself, the attributes and comments
        // after it, and the item they precede.
        for marker in markers {
            out.tests.push(marker);
            let mut next = tree.siblings(marker).1;
            while let Some(id) = next {
                out.tests.push(id);
                let kind = tree.nodes[id].kind;
                if !(kind.contains("attribute") || kind.contains("comment")) {
                    break;
                }
                next = tree.siblings(id).1;
            }
        }
        // One capture per node and role: patterns overlap, and a node is
        // one thing.
        out.all.sort_by_key(|c| (c.node, c.role));
        out.all.dedup_by_key(|c| (c.node, c.role));
        out.tests.sort_unstable();
        out.tests.dedup();
        Ok(out)
    }

    pub(crate) fn at(&self, node: NodeId) -> &[Captured] {
        let start = self.all.partition_point(|c| c.node < node);
        let end = start + self.all[start..].partition_point(|c| c.node == node);
        &self.all[start..end]
    }
}

/// What a known API is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Api {
    Effect(EffectKind),
    Spawn,
    Lock,
    /// A trivial call (`map`, `clone`, `len`): not reported.
    Ignore,
}

/// How a segment joins the one before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sep {
    /// `a::b`: a path.
    Path,
    /// `a.b`: a member of a value (or a module, where the language uses
    /// `.` for both).
    Member,
}

/// A name's segments, each with how it joins the one before (ignored for
/// the first). `None` text is an expression that is not a name (`f(x)`).
type Segments<'t> = Vec<(Sep, Option<&'t str>)>;

/// Splits `std::fs`, `self.client` or `os.path` into segments; `None`
/// when the text is not a plain name chain.
fn name_segments(text: &str) -> Option<Segments<'_>> {
    let plain = |c: char| c.is_alphanumeric() || matches!(c, '_' | '$' | '#');
    let mut out = Vec::new();
    let mut sep = Sep::Member;
    let mut rest = text;
    loop {
        let end = rest.find(|c: char| !plain(c)).unwrap_or(rest.len());
        if end == 0 {
            return None;
        }
        out.push((sep, Some(&rest[..end])));
        rest = &rest[end..];
        if rest.is_empty() {
            return Some(out);
        }
        if let Some(after) = rest.strip_prefix("::") {
            sep = Sep::Path;
            rest = after;
        } else {
            rest = rest.strip_prefix('.')?;
            sep = Sep::Member;
        }
    }
}

struct ApiRule {
    /// A leading `**`, and how the first matched segment must join what
    /// is before it (if anything is).
    open: Option<Sep>,
    /// `None` text is `*`.
    segments: Vec<(Sep, Option<String>)>,
    api: Api,
}

/// Known-API rows from a language's tables, in order.
pub(crate) struct ApiTable {
    rules: Vec<ApiRule>,
}

impl ApiTable {
    pub(crate) fn parse(tables: &[&str]) -> Result<Self, String> {
        let mut rules = Vec::new();
        for table in tables {
            for line in table.lines().map(str::trim) {
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let mut fields = line.split_whitespace();
                let (Some(pattern), Some(kind), None) =
                    (fields.next(), fields.next(), fields.next())
                else {
                    return Err(format!("bad API row: {line}"));
                };
                let api = match kind {
                    "filesystem" => Api::Effect(EffectKind::Filesystem),
                    "network" => Api::Effect(EffectKind::Network),
                    "process" => Api::Effect(EffectKind::Process),
                    "database" => Api::Effect(EffectKind::Database),
                    "ipc_command" => Api::Effect(EffectKind::IpcCommand),
                    "event" => Api::Effect(EffectKind::Event),
                    "env" => Api::Effect(EffectKind::Env),
                    "ui" => Api::Effect(EffectKind::Ui),
                    "spawn" => Api::Spawn,
                    "lock" => Api::Lock,
                    "ignore" => Api::Ignore,
                    _ => return Err(format!("unknown API kind {kind}: {line}")),
                };
                let bad = || format!("bad API pattern: {line}");
                let (open, body) = if let Some(rest) = pattern.strip_prefix("**::") {
                    (Some(Sep::Path), rest)
                } else if let Some(rest) = pattern.strip_prefix("**.") {
                    (Some(Sep::Member), rest)
                } else {
                    (None, pattern)
                };
                // `*` is a plain name for splitting, then a wildcard.
                let segments = name_segments(&body.replace('*', "_wildcard_"))
                    .ok_or_else(bad)?
                    .into_iter()
                    .map(|(sep, text)| {
                        let text = text.unwrap_or_default();
                        match text {
                            "_wildcard_" => Ok((sep, None)),
                            _ if text.contains("_wildcard_") => Err(bad()),
                            _ => Ok((sep, Some(text.to_owned()))),
                        }
                    })
                    .collect::<Result<_, _>>()?;
                rules.push(ApiRule {
                    open,
                    segments,
                    api,
                });
            }
        }
        Ok(Self { rules })
    }

    /// The first row matching a name's segments.
    fn lookup(&self, name: &Segments) -> Option<Api> {
        self.rules
            .iter()
            .find(|rule| {
                let n = rule.segments.len();
                let start = match rule.open {
                    Some(_) if name.len() >= n => name.len() - n,
                    None if name.len() == n => 0,
                    _ => return false,
                };
                // What precedes the matched suffix must join it as the
                // row says (`**::env::*` is not `job.env.get`).
                if let (Some(sep), true) = (rule.open, start > 0) {
                    if name[start].0 != sep {
                        return false;
                    }
                }
                rule.segments.iter().zip(&name[start..]).enumerate().all(
                    |(i, ((sep, want), (have_sep, have)))| {
                        (i == 0 || sep == have_sep)
                            && match (want, have) {
                                (None, _) => true,
                                (Some(want), Some(have)) => want == have,
                                (Some(_), None) => false,
                            }
                    },
                )
            })
            .map(|rule| rule.api)
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.rules.len()
    }
}

/// Text with whitespace collapsed, and none around `.` and `::`.
fn compact(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::with_capacity(collapsed.len());
    for (i, c) in collapsed.char_indices() {
        if c == ' ' {
            let after = &collapsed[i + 1..];
            let joins = |s: &str| s.starts_with('.') || s.starts_with("::");
            if out.ends_with('.') || out.ends_with("::") || joins(after) {
                continue;
            }
        }
        out.push(c);
    }
    out
}

/// The index of the `)` or `]` closing the bracket at `open`.
fn closing(text: &str, open: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (i, c) in text[open..].char_indices() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(open + i);
                }
            }
            _ => {}
        }
    }
    None
}

/// A call's name for a label: `self.client.send`, `fs::write`, a single
/// call receiver with its arguments elided (`open(…).write`), or a longer
/// chain cut to its root (`CACHE…and_then`).
fn call_name(qualifier: Option<(Part, &str)>, name: &str) -> String {
    let Some((part, receiver)) = qualifier else {
        return name.to_owned();
    };
    let sep = if part == Part::Path { "::" } else { "." };
    let Some(open) = receiver.find(['(', '[']) else {
        return format!("{receiver}{sep}{name}");
    };
    let head = &receiver[..open];
    let simple_head = !head.is_empty() && !head.contains(['.', ' ']);
    if simple_head && closing(receiver, open) == Some(receiver.len() - 1) {
        let elided = if receiver[open..].starts_with('[') {
            "[…]"
        } else {
            "(…)"
        };
        return format!("{head}{elided}{sep}{name}");
    }
    let root = receiver
        .find(['.', ':', '(', '[', ' '])
        .map_or(receiver, |end| &receiver[..end]);
    format!("{root}…{name}")
}

/// The nodes one change touches on one side.
pub(crate) struct Touched<'a, 's> {
    pub(crate) tree: &'a SyntaxTree<'s>,
    /// Sorted, distinct.
    pub(crate) nodes: Vec<NodeId>,
    /// The changed nodes themselves (topmost).
    pub(crate) roots: Vec<NodeId>,
}

/// Identity of a capture: its role and the structure of its subject and
/// qualifier.
type Key = (Role, u64, u64);

struct Seen {
    count: usize,
    /// First occurrence, in document order.
    first: NodeId,
    side: usize,
    capture: usize,
    /// Some occurrence is one of the changed nodes themselves.
    at_root: bool,
}

/// The facts of one change.
pub(crate) fn derive(sides: [&Touched; 2], apis: &ApiTable) -> Facts {
    let key = |tree: &SyntaxTree, c: &Captured| -> Key {
        let qualifier = c.qualifier.map_or(0, |(part, id)| {
            tree.nodes[id].hash ^ (part as u64 + 1).rotate_left(7)
        });
        (c.role, tree.nodes[c.subject].hash, qualifier)
    };
    let mut seen: [BTreeMap<Key, Seen>; 2] = [BTreeMap::new(), BTreeMap::new()];
    for (side, touched) in sides.iter().enumerate() {
        for &node in &touched.nodes {
            let at = touched.tree.captures.all.partition_point(|c| c.node < node);
            let root = touched.roots.binary_search(&node).is_ok();
            for (index, capture) in touched.tree.captures.at(node).iter().enumerate() {
                let entry = seen[side]
                    .entry(key(touched.tree, capture))
                    .or_insert(Seen {
                        count: 0,
                        first: node,
                        side,
                        capture: at + index,
                        at_root: false,
                    });
                entry.count += 1;
                entry.at_root |= root;
            }
        }
    }
    let describe = |seen: &Seen| -> Option<(FactKind, String)> {
        let tree = sides[seen.side].tree;
        let capture = &tree.captures.all[seen.capture];
        if capture.role == Role::Fact(FactKind::Literal) {
            return Some((FactKind::Literal, display_name(tree.text(capture.subject))));
        }
        let subject = compact(tree.text(capture.subject));
        let Role::Fact(kind) = capture.role else {
            let qualifier = capture
                .qualifier
                .map(|(part, id)| (part, compact(tree.text(id))));
            let opaque = || vec![(Sep::Member, None)];
            let name = match &qualifier {
                Some((part, text)) => {
                    let mut name = name_segments(text).unwrap_or_else(opaque);
                    let sep = if *part == Part::Path {
                        Sep::Path
                    } else {
                        Sep::Member
                    };
                    name.push((sep, Some(subject.as_str())));
                    name
                }
                // An annotation or use may be a whole path (`tauri::command`).
                None => name_segments(&subject).unwrap_or_else(opaque),
            };
            let kind = match (apis.lookup(&name), capture.role) {
                (Some(Api::Effect(effect)), _) => FactKind::Effect { effect },
                (Some(Api::Spawn), _) => FactKind::Spawn,
                (Some(Api::Lock), _) => FactKind::Lock,
                (None, Role::Call) => FactKind::Call,
                _ => return None,
            };
            let qualifier = qualifier
                .as_ref()
                .map(|(part, text)| (*part, text.as_str()));
            return Some((kind, display_name(&call_name(qualifier, &subject))));
        };
        Some((kind, display_name(&subject)))
    };
    // Differences, by kind: removed and added subjects in document order,
    // and whether each is a changed node itself.
    type Found = Vec<(NodeId, String, bool)>;
    let mut found: BTreeMap<FactKind, [Found; 2]> = BTreeMap::new();
    for (side, other) in [(0, 1), (1, 0)] {
        for (key, here) in &seen[side] {
            let there = seen[other].get(key).map_or(0, |s| s.count);
            if here.count <= there {
                continue;
            }
            if let Some((kind, subject)) = describe(here) {
                found.entry(kind).or_default()[side].push((here.first, subject, here.at_root));
            }
        }
    }
    let mut facts = Vec::new();
    for (kind, [mut removed, mut added]) in found {
        removed.sort();
        added.sort();
        let paired = if kind.pairs() {
            removed.len().min(added.len())
        } else {
            0
        };
        for ((_, from, _), (_, to, _)) in removed.drain(..paired).zip(added.drain(..paired)) {
            facts.push(Fact {
                kind,
                change: FactChange::Changed { from, to },
            });
        }
        let reported = |(_, _, root): &(NodeId, String, bool)| *root || !kind.replaced_only();
        for (_, subject, _) in removed.into_iter().filter(reported) {
            facts.push(Fact {
                kind,
                change: FactChange::Removed { subject },
            });
        }
        for (_, subject, _) in added.into_iter().filter(reported) {
            facts.push(Fact {
                kind,
                change: FactChange::Added { subject },
            });
        }
    }
    facts.sort();
    facts.dedup();
    let mut omitted = 0;
    if facts.len() > Facts::MAX {
        facts.sort_by(|x, y| x.priority().cmp(&y.priority()));
        omitted = u32::try_from(facts.len() - Facts::MAX).unwrap_or(u32::MAX);
        facts.truncate(Facts::MAX);
        facts.sort();
    }
    let in_test = sides
        .iter()
        .any(|touched| touched.roots.iter().any(|&root| touched.tree.in_test(root)));
    if in_test {
        facts.push(Fact {
            kind: FactKind::TestCode,
            change: FactChange::Inside,
        });
    }
    Facts {
        items: facts,
        omitted,
    }
}

impl SyntaxTree<'_> {
    /// Whether a node is inside (or is) test code.
    pub(crate) fn in_test(&self, id: NodeId) -> bool {
        self.captures
            .tests
            .iter()
            .any(|&test| test == id || self.nodes[test].descendants(test).contains(&id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_names_resolve_to_the_vocabulary() {
        assert_eq!(capture_name("call"), Some(CaptureName::Primary(Role::Call)));
        assert_eq!(
            capture_name("test.marker"),
            Some(CaptureName::Primary(Role::TestMarker))
        );
        assert_eq!(
            capture_name("call.receiver"),
            Some(CaptureName::Part(Role::Call, Part::Receiver))
        );
        assert_eq!(
            capture_name("control.branch.subject"),
            Some(CaptureName::Part(
                Role::Fact(FactKind::Branch),
                Part::Subject
            ))
        );
        assert_eq!(capture_name("_result"), Some(CaptureName::Ignored));
        for typo in [
            "calls",
            "control.brnach",
            "call.reciever",
            "data",
            "error.type.x",
        ] {
            assert_eq!(capture_name(typo), None, "{typo}");
        }
    }

    #[test]
    fn a_query_with_an_unknown_capture_does_not_compile() {
        let rust = crate::Grammar::Rust.language();
        assert!(FactsQuery::compile(&rust, &["(identifier) @call"]).is_ok());
        let typo = FactsQuery::compile(&rust, &["(identifier) @contrl.branch"]);
        assert!(typo.is_err_and(|error| error.contains("contrl.branch")));
    }

    #[test]
    fn every_primary_kind_but_api_derived_ones_is_used_by_some_query() {
        // Spawn and lock come from the API tables; the rest must each be
        // captured somewhere, or a category is silently missing.
        let mut used = std::collections::BTreeSet::new();
        for entry in &crate::registry::LANGUAGES {
            let Some(profile) = &entry.profile else {
                continue;
            };
            let query = FactsQuery::compile(&entry.language.into(), profile.facts).unwrap();
            used.extend(query.names.iter().filter_map(|name| match name {
                CaptureName::Primary(role) => Some(*role),
                _ => None,
            }));
        }
        for (name, role) in PRIMARY {
            if matches!(
                role,
                Role::Fact(FactKind::Spawn) | Role::Fact(FactKind::Lock)
            ) {
                continue;
            }
            assert!(used.contains(role), "no query captures @{name}");
        }
    }

    fn lookup(table: &ApiTable, text: &str) -> Option<Api> {
        let (qualifier, name) = match text.rfind(['.', ':']) {
            Some(end) => {
                let start = if text[..=end].ends_with("::") {
                    end - 1
                } else {
                    end
                };
                (&text[..start], &text[end + 1..])
            }
            None => ("", text),
        };
        let sep = if text[qualifier.len()..].starts_with("::") {
            Sep::Path
        } else {
            Sep::Member
        };
        let mut segments = if qualifier.is_empty() {
            Vec::new()
        } else {
            name_segments(qualifier).unwrap_or_else(|| vec![(Sep::Member, None)])
        };
        segments.push((sep, Some(name)));
        table.lookup(&segments)
    }

    #[test]
    fn api_patterns_match_segments_and_separators() {
        let table = ApiTable::parse(&[
            "# comment\n**::fs::*   filesystem\nfetch network\n**.lock lock\nprocess.env env\n**::env::* env\n**.map ignore\n",
        ])
        .unwrap();
        let fs = Some(Api::Effect(EffectKind::Filesystem));
        assert_eq!(lookup(&table, "fs::write"), fs);
        assert_eq!(lookup(&table, "std::fs::write"), fs);
        assert_eq!(lookup(&table, "fs"), None);
        assert_eq!(
            lookup(&table, "fetch"),
            Some(Api::Effect(EffectKind::Network))
        );
        assert_eq!(lookup(&table, "client.fetch"), None);
        assert_eq!(lookup(&table, "self.state.lock"), Some(Api::Lock));
        assert_eq!(
            lookup(&table, "process.env"),
            Some(Api::Effect(EffectKind::Env))
        );
        assert_eq!(lookup(&table, "items.map"), Some(Api::Ignore));
        // Paths are not members: a field named `env` or `fs` is no module.
        assert_eq!(lookup(&table, "job.env.get"), None);
        assert_eq!(lookup(&table, "self.fs.write"), None);
        assert_eq!(
            lookup(&table, "env::var"),
            Some(Api::Effect(EffectKind::Env))
        );
        assert!(ApiTable::parse(&["fs.* storage"]).is_err());
        assert!(ApiTable::parse(&["fs.read* filesystem"]).is_err());
        assert!(ApiTable::parse(&["fs.read"]).is_err());
    }

    #[test]
    fn every_api_table_parses_with_rows() {
        for entry in &crate::registry::LANGUAGES {
            let Some(profile) = &entry.profile else {
                continue;
            };
            for table in profile.apis {
                let parsed = ApiTable::parse(&[table]).unwrap_or_else(|e| panic!("{e}"));
                assert!(parsed.len() > 0, "{}", entry.name);
            }
        }
    }

    #[test]
    fn call_names_are_compact() {
        assert_eq!(compact("self . client\n    .send"), "self.client.send");
        assert_eq!(compact("std :: fs"), "std::fs");
        assert_eq!(compact("a  +  b"), "a + b");
        let member = |r: &str, n: &str| call_name(Some((Part::Receiver, r)), n);
        assert_eq!(member("self.client", "send"), "self.client.send");
        assert_eq!(
            member("open(\"out.json\", \"w\")", "write"),
            "open(…).write"
        );
        assert_eq!(member("CACHE.lock().ok()", "and_then"), "CACHE…and_then");
        assert_eq!(member("items[0]", "len"), "items[…].len");
        assert_eq!(
            member("Command::new(\"git\")", "status"),
            "Command::new(…).status"
        );
        assert_eq!(compact("a ? b : c"), "a ? b : c");
        assert_eq!(
            call_name(Some((Part::Path, "std::fs")), "write"),
            "std::fs::write"
        );
        assert_eq!(call_name(None, "retry"), "retry");
    }
}
