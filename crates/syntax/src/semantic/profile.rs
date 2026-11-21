//! Per-grammar data for the semantic diff, as held by each language's
//! registry entry (`crate::registry`). Declarations come from each
//! grammar's own tags query (`queries/tags.scm`, the one code navigation
//! uses), plus a short supplement (`queries/<language>/declarations.scm`)
//! for what that query leaves out: Rust impls and constants, fields, enum
//! variants and imports. Facts come from `queries/<language>/facts.scm` and
//! the known-API tables in `apis/`. The matcher, edit script and fact
//! deriver are grammar-neutral.

use super::facts::{ApiTable, FactsQuery};
use super::DeclarationKind;
use crate::Grammar;
use tree_sitter::{Node, Query};

pub(crate) struct Profile {
    /// Leaf kinds whose text changes are reported as renames.
    pub(crate) identifiers: &'static [&'static str],
    /// String and character literal kinds: whitespace inside them is
    /// content, so changing it is a change, not reformatting.
    pub(crate) literals: &'static [&'static str],
    /// Tags query sources, joined; only `@definition.*` patterns are used.
    pub(crate) declarations: &'static [&'static str],
    /// Facts query sources, joined.
    pub(crate) facts: &'static [&'static str],
    /// Known-API tables, most specific first: the first matching row wins.
    pub(crate) apis: &'static [&'static str],
    /// Test files: a path with directory `.0` above a file name ending in
    /// `.1` (Elixir's `test/…_test.exs`) is test code throughout.
    pub(crate) test_files: &'static [(&'static str, &'static str)],
    /// Callables are identified by name and arity (Elixir's `get/1` and
    /// `get/2` are different functions); `None` where calls match by
    /// name alone.
    pub(crate) arity: Option<Arity>,
}

/// How arity is counted, where it identifies a callable: a definition's
/// `@parameters` and a call's `@call.arguments` are counted by their named
/// children, a call's `@call.piped` value adds one, and a parameter with a
/// default (`b \\ 1`) makes it optional. A function's clauses (several
/// definitions of one name and arity in one module) are one function: one
/// scope in the semantic diff, one definition for code intelligence.
pub(crate) struct Arity {
    /// The node kind and operator of a parameter with a default value.
    pub(crate) default: (&'static str, &'static str),
}

impl Arity {
    /// The fewest and most arguments a definition with these parameters
    /// takes (none without a parameter list).
    pub(crate) fn of_parameters(&self, parameters: Option<Node>, source: &[u8]) -> (u32, u32) {
        let Some(parameters) = parameters else {
            return (0, 0);
        };
        let (kind, operator) = self.default;
        let mut cursor = parameters.walk();
        let (mut min, mut max) = (0, 0);
        for child in parameters.named_children(&mut cursor) {
            if child.is_extra() {
                continue;
            }
            max += 1;
            let defaulted = child.kind() == kind
                && child
                    .child_by_field_name("operator")
                    .and_then(|op| op.utf8_text(source).ok())
                    == Some(operator);
            if !defaulted {
                min += 1;
            }
        }
        (min, max)
    }

    /// Arguments a call passes: its `@call.arguments` node's (comments
    /// aside) and a piped value.
    pub(crate) fn of_call(&self, arguments: Option<Node>, piped: bool) -> u32 {
        let passed = arguments.map_or(0, |arguments| {
            let mut cursor = arguments.walk();
            let count = arguments
                .named_children(&mut cursor)
                .filter(|child| !child.is_extra())
                .count();
            u32::try_from(count).unwrap_or(u32::MAX)
        });
        passed.saturating_add(u32::from(piped))
    }
}

impl Profile {
    /// Whether every change in the file at `path` is in test code.
    pub(crate) fn is_test_file(&self, path: &str) -> bool {
        let mut parts = path.rsplit('/');
        let name = parts.next().unwrap_or(path);
        let dirs: Vec<&str> = parts.collect();
        self.test_files
            .iter()
            .any(|(dir, suffix)| name.ends_with(suffix) && dirs.contains(dir))
    }
}

/// A profile's queries and tables, compiled.
pub(crate) struct Compiled {
    pub(crate) declarations: Declarations,
    pub(crate) facts: FactsQuery,
    pub(crate) apis: ApiTable,
}

impl Compiled {
    pub(crate) fn new(grammar: Grammar, profile: &Profile) -> Result<Self, String> {
        let error = |error: String| format!("{}: {error}", grammar.name());
        Ok(Self {
            declarations: Declarations::compile(grammar, profile.declarations)?,
            facts: FactsQuery::compile(&grammar.language(), profile.facts).map_err(error)?,
            apis: ApiTable::parse(profile.apis).map_err(error)?,
        })
    }
}

/// A compiled declarations query: the `@definition.<kind>` captures, the
/// `@name` capture and the optional ones: `@keyword` (the token naming
/// the construct, where the grammar has no keyword token: Elixir's
/// `def`), `@parameters` (a callable's parameters, for its arity) and
/// `@body` (where a callable's signature ends, where the grammar has no
/// `body` field).
pub(crate) struct Declarations {
    pub(crate) query: Query,
    pub(crate) name: u32,
    pub(crate) keyword: Option<u32>,
    pub(crate) parameters: Option<u32>,
    pub(crate) body: Option<u32>,
    /// Per capture index, the declaration kind it marks.
    pub(crate) kinds: Vec<Option<DeclarationKind>>,
}

impl Declarations {
    fn compile(grammar: Grammar, sources: &[&str]) -> Result<Self, String> {
        let source = sources.join("\n");
        let mut query = Query::new(&grammar.language(), &source)
            .map_err(|error| format!("{}: {error}", grammar.name()))?;
        // References (calls, types) are not declarations; skip matching them.
        let starts: Vec<usize> = (0..query.pattern_count())
            .map(|pattern| query.start_byte_for_pattern(pattern))
            .chain([source.len()])
            .collect();
        for pattern in 0..query.pattern_count() {
            if !source[starts[pattern]..starts[pattern + 1]].contains("@definition.") {
                query.disable_pattern(pattern);
            }
        }
        let kinds = query
            .capture_names()
            .iter()
            .map(|name| {
                name.strip_prefix("definition.")
                    .and_then(DeclarationKind::from_tag)
            })
            .collect();
        let name = query
            .capture_index_for_name("name")
            .ok_or_else(|| format!("{}: no @name capture", grammar.name()))?;
        Ok(Self {
            name,
            keyword: query.capture_index_for_name("keyword"),
            parameters: query.capture_index_for_name("parameters"),
            body: query.capture_index_for_name("body"),
            query,
            kinds,
        })
    }
}

impl DeclarationKind {
    /// The kind for a tags query's `@definition.<tag>`.
    fn from_tag(tag: &str) -> Option<Self> {
        Some(match tag {
            "function" => Self::Function,
            "method" => Self::Method,
            "class" => Self::Class,
            "interface" => Self::Interface,
            "module" => Self::Module,
            "macro" => Self::Macro,
            "constant" => Self::Constant,
            "impl" => Self::Impl,
            "type" => Self::Type,
            "field" => Self::Field,
            "variant" => Self::Variant,
            "import" => Self::Import,
            _ => return None,
        })
    }

    /// Changes before a callable's body are labelled as signature changes.
    pub(crate) fn callable(self) -> bool {
        matches!(self, Self::Function | Self::Method)
    }

    /// A part of a declaration (a field, variant or imported name) rather
    /// than a container code lives in.
    pub(crate) fn member(self) -> bool {
        matches!(self, Self::Field | Self::Variant | Self::Import)
    }

    /// When one node is captured as several kinds, the most specific wins:
    /// a function inside an impl is a method; a constant whose value is a
    /// function is a function.
    pub(crate) fn precedence(self) -> u8 {
        match self {
            Self::Method => 0,
            Self::Function => 1,
            Self::Constant => 3,
            _ => 2,
        }
    }

    /// The label when the source has no keyword before the name.
    pub(crate) fn word(self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Method => "method",
            Self::Class => "class",
            Self::Interface => "interface",
            Self::Module => "module",
            Self::Macro => "macro",
            Self::Constant => "const",
            Self::Impl => "impl",
            Self::Type => "type",
            Self::Field => "field",
            Self::Variant => "variant",
            Self::Import => "import",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEMANTIC: [Grammar; 6] = [
        Grammar::Rust,
        Grammar::JavaScript,
        Grammar::TypeScript,
        Grammar::Tsx,
        Grammar::Python,
        Grammar::Elixir,
    ];

    #[test]
    fn every_profile_compiles_for_its_grammar() {
        for grammar in SEMANTIC {
            let profile = grammar.profile().unwrap();
            let compiled = Compiled::new(grammar, profile);
            let compiled = compiled.unwrap_or_else(|error| panic!("{error}"));
            assert!(compiled.declarations.kinds.iter().any(Option::is_some));
        }
    }

    #[test]
    fn test_files_need_their_directory_and_suffix() {
        let elixir = Grammar::Elixir.profile().unwrap();
        assert!(elixir.is_test_file("test/accounts_test.exs"));
        assert!(elixir.is_test_file("apps/web/test/web/page_test.exs"));
        assert!(!elixir.is_test_file("lib/accounts_test.exs"));
        assert!(!elixir.is_test_file("test/support/fixtures.ex"));
        assert!(!elixir.is_test_file("test_test.exs"));
        let rust = Grammar::Rust.profile().unwrap();
        assert!(!rust.is_test_file("test/a_test.exs"));
    }

    #[test]
    fn identifier_and_literal_kinds_exist_in_their_grammar() {
        // A typo in a table would silently disable renames or let string
        // whitespace edits pass as reformatting.
        for grammar in SEMANTIC {
            let language = grammar.language();
            let profile = grammar.profile().unwrap();
            for kind in profile.identifiers.iter().chain(profile.literals) {
                assert_ne!(
                    language.id_for_node_kind(kind, true),
                    0,
                    "{} lacks {kind}",
                    grammar.name()
                );
            }
        }
    }
}
