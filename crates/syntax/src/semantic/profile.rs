//! Per-grammar data for the semantic diff. Declarations come from each
//! grammar's own tags query (`queries/tags.scm`, the one code navigation
//! uses), plus a short supplement for what that query leaves out: Rust
//! impls and constants, fields, enum variants and imports. Supporting a
//! language means adding its grammar, its queries and its identifier kinds
//! here; the matcher and edit script are grammar-neutral.

use super::DeclarationKind;
use crate::Grammar;
use std::sync::OnceLock;
use tree_sitter::Query;

pub(crate) struct Profile {
    /// Leaf kinds whose text changes are reported as renames.
    pub(crate) identifiers: &'static [&'static str],
    /// String and character literal kinds: whitespace inside them is
    /// content, so changing it is a change, not reformatting.
    pub(crate) literals: &'static [&'static str],
    /// Tags query sources, joined; only `@definition.*` patterns are used.
    queries: &'static [&'static str],
}

const RUST_SUPPLEMENT: &str = r#"
(impl_item type: (_) @name) @definition.impl
(function_signature_item name: (identifier) @name) @definition.method
(const_item name: (identifier) @name) @definition.constant
(static_item name: (identifier) @name) @definition.constant
(field_declaration name: (field_identifier) @name) @definition.field
(enum_variant name: (identifier) @name) @definition.variant
(use_declaration argument: (_) @name) @definition.import
"#;

/// Shared by JavaScript, TypeScript and TSX.
const ECMASCRIPT_SUPPLEMENT: &str = r#"
(method_definition name: (_) @name) @definition.method
(import_statement source: (string) @name) @definition.import
(import_specifier name: (_) @name) @definition.import
(program (lexical_declaration (variable_declarator name: (identifier) @name) @definition.constant))
(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name) @definition.constant)))
"#;

const JAVASCRIPT_SUPPLEMENT: &str = r#"
(field_definition property: (_) @name) @definition.field
"#;

const TYPESCRIPT_SUPPLEMENT: &str = r#"
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.class
(internal_module name: (_) @name) @definition.module
(public_field_definition name: (_) @name) @definition.field
(property_signature name: (_) @name) @definition.field
(enum_body name: (_) @name @definition.variant)
(enum_assignment name: (_) @name) @definition.variant
"#;

const PYTHON_SUPPLEMENT: &str = r#"
(import_statement name: (_) @name) @definition.import
(import_from_statement module_name: (_) @name) @definition.import
"#;

const RUST: Profile = Profile {
    identifiers: &[
        "identifier",
        "type_identifier",
        "field_identifier",
        "shorthand_field_identifier",
    ],
    literals: &["string_literal", "raw_string_literal", "char_literal"],
    queries: &[tree_sitter_rust::TAGS_QUERY, RUST_SUPPLEMENT],
};

const JAVASCRIPT_IDENTIFIERS: &[&str] = &[
    "identifier",
    "property_identifier",
    "private_property_identifier",
    "shorthand_property_identifier",
    "shorthand_property_identifier_pattern",
];

/// JavaScript's, plus type names.
const TYPESCRIPT_IDENTIFIERS: &[&str] = &[
    "identifier",
    "property_identifier",
    "private_property_identifier",
    "shorthand_property_identifier",
    "shorthand_property_identifier_pattern",
    "type_identifier",
];

const ECMASCRIPT_LITERALS: &[&str] = &["string", "template_string"];

const JAVASCRIPT: Profile = Profile {
    identifiers: JAVASCRIPT_IDENTIFIERS,
    literals: ECMASCRIPT_LITERALS,
    queries: &[
        tree_sitter_javascript::TAGS_QUERY,
        ECMASCRIPT_SUPPLEMENT,
        JAVASCRIPT_SUPPLEMENT,
    ],
};

/// TypeScript's tags query extends JavaScript's.
const TYPESCRIPT: Profile = Profile {
    identifiers: TYPESCRIPT_IDENTIFIERS,
    literals: ECMASCRIPT_LITERALS,
    queries: &[
        tree_sitter_javascript::TAGS_QUERY,
        tree_sitter_typescript::TAGS_QUERY,
        ECMASCRIPT_SUPPLEMENT,
        TYPESCRIPT_SUPPLEMENT,
    ],
};

const PYTHON: Profile = Profile {
    identifiers: &["identifier"],
    // `string_content` holds escapes as children; the text between them
    // is the string's.
    literals: &["string", "string_content"],
    queries: &[tree_sitter_python::TAGS_QUERY, PYTHON_SUPPLEMENT],
};

/// A compiled declarations query: the `@definition.<kind>` captures and the
/// `@name` capture.
pub(crate) struct Declarations {
    pub(crate) query: Query,
    pub(crate) name: u32,
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
        Ok(Self { query, name, kinds })
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

impl Grammar {
    /// The grammar for a path's extension, when semantic diffs support it.
    pub fn for_path(path: &str) -> Option<Self> {
        let name = path.rsplit('/').next().unwrap_or(path);
        let extension = name.rsplit_once('.')?.1.to_ascii_lowercase();
        match extension.as_str() {
            "rs" => Some(Self::Rust),
            "ts" | "mts" | "cts" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            "js" | "mjs" | "cjs" | "jsx" => Some(Self::JavaScript),
            "py" | "pyi" => Some(Self::Python),
            _ => None,
        }
    }

    /// The semantic diff profile; `None` for grammars it does not cover.
    pub(crate) fn profile(self) -> Option<&'static Profile> {
        match self {
            Self::Rust => Some(&RUST),
            Self::JavaScript => Some(&JAVASCRIPT),
            Self::TypeScript | Self::Tsx => Some(&TYPESCRIPT),
            Self::Python => Some(&PYTHON),
            Self::Bash => None,
        }
    }

    /// The compiled declarations query, built once per grammar on its first
    /// diff (tens of milliseconds, outside that diff's time budget).
    pub(crate) fn declarations(self) -> Option<&'static Declarations> {
        static RUST_QUERY: OnceLock<Option<Declarations>> = OnceLock::new();
        static JAVASCRIPT_QUERY: OnceLock<Option<Declarations>> = OnceLock::new();
        static TYPESCRIPT_QUERY: OnceLock<Option<Declarations>> = OnceLock::new();
        static TSX_QUERY: OnceLock<Option<Declarations>> = OnceLock::new();
        static PYTHON_QUERY: OnceLock<Option<Declarations>> = OnceLock::new();
        let cell = match self {
            Self::Rust => &RUST_QUERY,
            Self::JavaScript => &JAVASCRIPT_QUERY,
            Self::TypeScript => &TYPESCRIPT_QUERY,
            Self::Tsx => &TSX_QUERY,
            Self::Python => &PYTHON_QUERY,
            Self::Bash => return None,
        };
        let profile = self.profile()?;
        // The queries are fixed at build time and covered by a test, so a
        // failure here is a packaging bug; the grammar then reports
        // `UnsupportedLanguage` rather than diffing without declarations.
        cell.get_or_init(|| Declarations::compile(self, profile.queries).ok())
            .as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_map_to_supported_grammars_only() {
        assert!(matches!(Grammar::for_path("src/a.rs"), Some(Grammar::Rust)));
        assert!(matches!(Grammar::for_path("x/App.TSX"), Some(Grammar::Tsx)));
        assert!(matches!(
            Grammar::for_path("lib/index.mjs"),
            Some(Grammar::JavaScript)
        ));
        assert!(matches!(
            Grammar::for_path("tool.py"),
            Some(Grammar::Python)
        ));
        assert!(Grammar::for_path("run.sh").is_none());
        assert!(Grammar::for_path("Makefile").is_none());
        assert!(Grammar::for_path("dir.rs/README").is_none());
    }

    #[test]
    fn every_declarations_query_compiles_for_its_grammar() {
        for grammar in [
            Grammar::Rust,
            Grammar::JavaScript,
            Grammar::TypeScript,
            Grammar::Tsx,
            Grammar::Python,
        ] {
            let profile = grammar.profile().unwrap();
            let compiled = Declarations::compile(grammar, profile.queries);
            let compiled = compiled.unwrap_or_else(|error| panic!("{error}"));
            assert!(compiled.kinds.iter().any(Option::is_some));
        }
    }

    #[test]
    fn identifier_and_literal_kinds_exist_in_their_grammar() {
        // A typo in a table would silently disable renames or let string
        // whitespace edits pass as reformatting.
        for grammar in [
            Grammar::Rust,
            Grammar::JavaScript,
            Grammar::TypeScript,
            Grammar::Tsx,
            Grammar::Python,
        ] {
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
