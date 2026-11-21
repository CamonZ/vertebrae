//! The language registry: one entry per grammar holding everything this
//! crate knows about it (its tree-sitter grammar, the paths it applies to
//! and, for languages the semantic diff supports, the scope profile, the
//! declarations and facts queries and the known-API tables, and the
//! name-resolution rules code intelligence follows). Supporting a
//! language means adding its entry here; nothing else matches on
//! [`Grammar`].

use crate::intelligence::rules::{Exports, ImportsQuery, Modules, Reach, Rules};
use crate::semantic::profile::{Arity, Compiled, Profile};
use std::sync::OnceLock;
use tree_sitter::Language;
use tree_sitter_language::LanguageFn;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Grammar {
    Bash,
    Elixir,
    JavaScript,
    Python,
    Rust,
    TypeScript,
    Tsx,
}

pub(crate) struct LanguageEntry {
    pub(crate) grammar: Grammar,
    pub(crate) name: &'static str,
    pub(crate) language: LanguageFn,
    /// Lowercase file extensions the semantic diff reads as this language.
    pub(crate) extensions: &'static [&'static str],
    /// `None` for grammars the semantic diff does not cover.
    pub(crate) profile: Option<Profile>,
    /// Name resolution for code intelligence; `None` without a profile.
    pub(crate) rules: Option<Rules>,
}

/// Leaf kinds of JavaScript names.
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

const ECMASCRIPT_DECLARATIONS: &str = include_str!("../queries/ecmascript/declarations.scm");
const ECMASCRIPT_FACTS: &str = include_str!("../queries/ecmascript/facts.scm");

/// Known APIs of the JavaScript ecosystems, most specific first.
const ECMASCRIPT_APIS: &[&str] = &[
    include_str!("../apis/tauri-js.tsv"),
    include_str!("../apis/node.tsv"),
    include_str!("../apis/web.tsv"),
    include_str!("../apis/ecmascript-trivial.tsv"),
];

/// ECMAScript resolution: a module sees what it declares and imports;
/// other files see what it exports. Parameters differ between the
/// grammars, so each adds its own locals.
const fn ecmascript_rules(bindings: &'static [&'static str]) -> Rules {
    Rules {
        family: "ecmascript",
        bindings,
        nested_sees_locals: true,
        locals_hide_call_targets: false,
        module_scopes: false,
        reach: Reach::File,
        modules: Modules::Specifier {
            extensions: &["ts", "tsx", "d.ts", "js", "jsx", "mjs", "cjs", "mts", "cts"],
            index: "index",
        },
        exports: Exports::Wrapper {
            kind: "export_statement",
            default: "default",
        },
        receivers: &["this"],
        qualified: &[("member_expression", "property")],
        prefix: None,
        unit_markers: &["package.json"],
        local_calls: true,
        unbound_search: true,
    }
}

const ECMASCRIPT_IMPORTS: &str = include_str!("../queries/ecmascript/imports.scm");
const ECMASCRIPT_LOCALS: &str = include_str!("../queries/ecmascript/locals.scm");
const JAVASCRIPT_RULES: Rules = ecmascript_rules(&[
    ECMASCRIPT_IMPORTS,
    ECMASCRIPT_LOCALS,
    include_str!("../queries/javascript/locals.scm"),
]);
const TYPESCRIPT_RULES: Rules = ecmascript_rules(&[
    ECMASCRIPT_IMPORTS,
    ECMASCRIPT_LOCALS,
    include_str!("../queries/typescript/locals.scm"),
]);

/// TypeScript's tags query extends JavaScript's.
const TYPESCRIPT: Profile = Profile {
    identifiers: TYPESCRIPT_IDENTIFIERS,
    literals: ECMASCRIPT_LITERALS,
    declarations: &[
        tree_sitter_javascript::TAGS_QUERY,
        tree_sitter_typescript::TAGS_QUERY,
        ECMASCRIPT_DECLARATIONS,
        include_str!("../queries/typescript/declarations.scm"),
    ],
    facts: &[
        ECMASCRIPT_FACTS,
        include_str!("../queries/typescript/facts.scm"),
    ],
    apis: ECMASCRIPT_APIS,
    test_files: &[],
    arity: None,
};

/// Elixir's definition forms: the call targets that define a function.
/// Private ones are not visible outside their module.
const ELIXIR_PRIVATE: &[&str] = &["defp", "defmacrop", "defguardp", "defnp"];

/// Indexed by `Grammar as usize`.
pub(crate) const LANGUAGES: [LanguageEntry; 7] = [
    LanguageEntry {
        grammar: Grammar::Bash,
        name: "bash",
        language: tree_sitter_bash::LANGUAGE,
        extensions: &[],
        profile: None,
        rules: None,
    },
    // Elixir declares with calls (`defmodule`, `def`): its declarations
    // query replaces the grammar's tags query, naming each construct by
    // its call target.
    LanguageEntry {
        grammar: Grammar::Elixir,
        name: "elixir",
        language: tree_sitter_elixir::LANGUAGE,
        extensions: &["ex", "exs"],
        profile: Some(Profile {
            identifiers: &["identifier", "alias"],
            literals: &["string", "charlist", "sigil", "quoted_content"],
            declarations: &[include_str!("../queries/elixir/declarations.scm")],
            facts: &[include_str!("../queries/elixir/facts.scm")],
            apis: &[
                include_str!("../apis/elixir-libs.tsv"),
                include_str!("../apis/elixir-stdlib.tsv"),
                include_str!("../apis/elixir-trivial.tsv"),
            ],
            test_files: &[("test", "_test.exs")],
            arity: Some(Arity {
                default: ("binary_operator", "\\\\"),
            }),
        }),
        // A module's functions see each other; other modules' are reached
        // through their name, an `alias` or an `import`, by name and
        // arity, and only when public.
        rules: Some(Rules {
            family: "elixir",
            bindings: &[
                include_str!("../queries/elixir/imports.scm"),
                include_str!("../queries/elixir/locals.scm"),
            ],
            nested_sees_locals: true,
            locals_hide_call_targets: false,
            module_scopes: true,
            reach: Reach::File,
            modules: Modules::Declared {
                dirs: &["lib", "test/support", "test"],
                extensions: &["ex", "exs"],
                separator: ".",
                current: "__MODULE__",
            },
            exports: Exports::Unless {
                field: "target",
                private: ELIXIR_PRIVATE,
            },
            receivers: &[],
            qualified: &[("dot", "right")],
            prefix: Some(("dot", "left")),
            unit_markers: &["mix.exs"],
            local_calls: false,
            unbound_search: false,
        }),
    },
    LanguageEntry {
        grammar: Grammar::JavaScript,
        name: "javascript",
        language: tree_sitter_javascript::LANGUAGE,
        extensions: &["js", "mjs", "cjs", "jsx"],
        profile: Some(Profile {
            identifiers: JAVASCRIPT_IDENTIFIERS,
            literals: ECMASCRIPT_LITERALS,
            declarations: &[
                tree_sitter_javascript::TAGS_QUERY,
                ECMASCRIPT_DECLARATIONS,
                include_str!("../queries/javascript/declarations.scm"),
            ],
            facts: &[
                ECMASCRIPT_FACTS,
                include_str!("../queries/javascript/facts.scm"),
            ],
            apis: ECMASCRIPT_APIS,
            test_files: &[],
            arity: None,
        }),
        rules: Some(JAVASCRIPT_RULES),
    },
    LanguageEntry {
        grammar: Grammar::Python,
        name: "python",
        language: tree_sitter_python::LANGUAGE,
        extensions: &["py", "pyi"],
        profile: Some(Profile {
            identifiers: &["identifier"],
            // `string_content` holds escapes as children; the text between
            // them is the string's.
            literals: &["string", "string_content"],
            declarations: &[
                tree_sitter_python::TAGS_QUERY,
                include_str!("../queries/python/declarations.scm"),
            ],
            facts: &[include_str!("../queries/python/facts.scm")],
            apis: &[
                include_str!("../apis/python-stdlib.tsv"),
                include_str!("../apis/python-trivial.tsv"),
            ],
            test_files: &[],
            arity: None,
        }),
        rules: Some(Rules {
            family: "python",
            bindings: &[
                include_str!("../queries/python/imports.scm"),
                include_str!("../queries/python/locals.scm"),
            ],
            nested_sees_locals: true,
            locals_hide_call_targets: false,
            module_scopes: false,
            reach: Reach::File,
            modules: Modules::Dotted {
                files: &["{}.py", "{}.pyi", "{}/__init__.py", "{}/__init__.pyi"],
            },
            exports: Exports::All,
            receivers: &["self", "cls"],
            qualified: &[("attribute", "attribute"), ("keyword_argument", "name")],
            prefix: None,
            unit_markers: &["pyproject.toml", "setup.py", "setup.cfg"],
            local_calls: true,
            unbound_search: true,
        }),
    },
    LanguageEntry {
        grammar: Grammar::Rust,
        name: "rust",
        language: tree_sitter_rust::LANGUAGE,
        extensions: &["rs"],
        profile: Some(Profile {
            identifiers: &[
                "identifier",
                "type_identifier",
                "field_identifier",
                "shorthand_field_identifier",
            ],
            literals: &["string_literal", "raw_string_literal", "char_literal"],
            declarations: &[
                tree_sitter_rust::TAGS_QUERY,
                include_str!("../queries/rust/declarations.scm"),
            ],
            facts: &[include_str!("../queries/rust/facts.scm")],
            apis: &[
                include_str!("../apis/tauri-rust.tsv"),
                include_str!("../apis/rust-tokio.tsv"),
                include_str!("../apis/rust-std.tsv"),
                include_str!("../apis/rust-trivial.tsv"),
            ],
            test_files: &[],
            arity: None,
        }),
        // Items in a module (a file, or an inline `mod`) see each other;
        // others are reached by `use` or a path from the crate root.
        rules: Some(Rules {
            family: "rust",
            bindings: &[
                include_str!("../queries/rust/imports.scm"),
                include_str!("../queries/rust/locals.scm"),
            ],
            nested_sees_locals: false,
            locals_hide_call_targets: true,
            module_scopes: true,
            reach: Reach::File,
            modules: Modules::Crate {
                manifest: "Cargo.toml",
                source: "src",
                roots: &["lib.rs", "main.rs"],
                files: &["{}.rs", "{}/mod.rs"],
                root: "crate",
                current: "self",
                parent: "super",
                separator: "::",
            },
            exports: Exports::Modifier("visibility_modifier"),
            receivers: &["self", "Self"],
            qualified: &[
                ("field_expression", "field"),
                ("scoped_identifier", "name"),
                ("scoped_type_identifier", "name"),
                ("field_initializer", "field"),
                ("shorthand_field_initializer", "name"),
            ],
            prefix: Some(("scoped_use_list", "path")),
            unit_markers: &["Cargo.toml"],
            local_calls: true,
            unbound_search: true,
        }),
    },
    LanguageEntry {
        grammar: Grammar::TypeScript,
        name: "typescript",
        language: tree_sitter_typescript::LANGUAGE_TYPESCRIPT,
        extensions: &["ts", "mts", "cts"],
        profile: Some(TYPESCRIPT),
        rules: Some(TYPESCRIPT_RULES),
    },
    LanguageEntry {
        grammar: Grammar::Tsx,
        name: "tsx",
        language: tree_sitter_typescript::LANGUAGE_TSX,
        extensions: &["tsx"],
        profile: Some(TYPESCRIPT),
        rules: Some(TYPESCRIPT_RULES),
    },
];

impl Grammar {
    pub(crate) fn entry(self) -> &'static LanguageEntry {
        &LANGUAGES[self as usize]
    }

    pub fn name(self) -> &'static str {
        self.entry().name
    }

    pub fn language(self) -> Language {
        self.entry().language.into()
    }

    /// The grammar for a path's extension, when semantic diffs support it.
    pub fn for_path(path: &str) -> Option<Self> {
        let name = path.rsplit('/').next().unwrap_or(path);
        let extension = name.rsplit_once('.')?.1.to_ascii_lowercase();
        LANGUAGES
            .iter()
            .find(|entry| entry.extensions.contains(&extension.as_str()))
            .map(|entry| entry.grammar)
    }

    /// The semantic diff profile; `None` for grammars it does not cover.
    pub(crate) fn profile(self) -> Option<&'static Profile> {
        self.entry().profile.as_ref()
    }

    /// The profile's compiled queries and tables, built once per grammar on
    /// its first diff (tens of milliseconds, outside that diff's time
    /// budget).
    pub(crate) fn compiled(self) -> Option<&'static Compiled> {
        static COMPILED: [OnceLock<Option<Compiled>>; LANGUAGES.len()] =
            [const { OnceLock::new() }; LANGUAGES.len()];
        let profile = self.profile()?;
        // The queries and tables are fixed at build time and covered by a
        // test, so a failure here is a packaging bug; the grammar then
        // reports `UnsupportedLanguage` rather than diffing without them.
        COMPILED[self as usize]
            .get_or_init(|| Compiled::new(self, profile).ok())
            .as_ref()
    }

    /// Name-resolution rules; `None` for grammars code intelligence does
    /// not cover.
    pub(crate) fn rules(self) -> Option<&'static Rules> {
        self.entry().rules.as_ref()
    }

    /// The compiled imports query, built once per grammar.
    pub(crate) fn imports(self) -> Option<&'static ImportsQuery> {
        static IMPORTS: [OnceLock<Option<ImportsQuery>>; LANGUAGES.len()] =
            [const { OnceLock::new() }; LANGUAGES.len()];
        let rules = self.rules()?;
        // Fixed at build time and covered by a test, as for `compiled`.
        IMPORTS[self as usize]
            .get_or_init(|| ImportsQuery::compile(self, rules.bindings).ok())
            .as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_sit_at_their_grammar_index() {
        for (index, entry) in LANGUAGES.iter().enumerate() {
            assert_eq!(entry.grammar as usize, index, "{}", entry.name);
        }
    }

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
        assert!(matches!(
            Grammar::for_path("lib/app/accounts.ex"),
            Some(Grammar::Elixir)
        ));
        assert!(matches!(
            Grammar::for_path("test/accounts_test.exs"),
            Some(Grammar::Elixir)
        ));
        assert!(Grammar::for_path("run.sh").is_none());
        assert!(Grammar::for_path("Makefile").is_none());
        assert!(Grammar::for_path("dir.rs/README").is_none());
        // Every extension maps to one language.
        let mut extensions: Vec<_> = LANGUAGES.iter().flat_map(|e| e.extensions).collect();
        let count = extensions.len();
        extensions.sort();
        extensions.dedup();
        assert_eq!(extensions.len(), count);
    }

    /// Editing a query or table changes the engine's output; the digest
    /// pinned beside `ENGINE_VERSION` makes that edit bump it.
    #[test]
    fn engine_inputs_are_pinned_to_the_engine_version() {
        let mut digest: u64 = 0xcbf2_9ce4_8422_2325;
        for entry in &LANGUAGES {
            let Some(profile) = &entry.profile else {
                continue;
            };
            let sources = [profile.declarations, profile.facts, profile.apis];
            for source in sources.iter().flat_map(|group| group.iter()) {
                for byte in entry.name.bytes().chain(source.bytes()) {
                    digest = (digest ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
                }
            }
        }
        let (version, pinned) = crate::semantic::ENGINE_INPUTS;
        assert_eq!(version, crate::semantic::ENGINE_VERSION);
        assert_eq!(
            pinned, digest,
            "queries or API tables changed: bump ENGINE_VERSION and set \
             ENGINE_INPUTS to (ENGINE_VERSION, {digest:#x})"
        );
    }

    #[test]
    fn every_language_with_a_profile_has_resolution_rules() {
        for entry in &LANGUAGES {
            assert_eq!(
                entry.profile.is_some(),
                entry.rules.is_some(),
                "{}",
                entry.name
            );
            let Some(rules) = &entry.rules else { continue };
            let imports = ImportsQuery::compile(entry.grammar, rules.bindings);
            assert!(imports.is_ok(), "{}: {:?}", entry.name, imports.err());
            // A typo in a node kind would silently disable a rule.
            let language = entry.grammar.language();
            let mut kinds: Vec<&str> = rules.qualified.iter().map(|(kind, _)| *kind).collect();
            kinds.extend(rules.prefix.map(|(kind, _)| kind));
            match &rules.exports {
                Exports::Modifier(kind) | Exports::Wrapper { kind, .. } => kinds.push(kind),
                Exports::All | Exports::Unless { .. } => {}
            }
            let arity = entry.profile.as_ref().and_then(|p| p.arity.as_ref());
            kinds.extend(arity.map(|arity| arity.default.0));
            for kind in kinds {
                assert_ne!(
                    language.id_for_node_kind(kind, true),
                    0,
                    "{} lacks {kind}",
                    entry.name
                );
            }
            let fields = rules.qualified.iter().map(|(_, field)| *field);
            let export_field = match &rules.exports {
                Exports::Unless { field, .. } => Some(*field),
                _ => None,
            };
            for field in fields
                .chain(rules.prefix.map(|(_, field)| field))
                .chain(export_field)
            {
                assert!(
                    language.field_id_for_name(field).is_some(),
                    "{} lacks field {field}",
                    entry.name
                );
            }
        }
    }

    #[test]
    fn every_language_with_a_profile_has_extensions() {
        for entry in &LANGUAGES {
            assert_eq!(
                entry.profile.is_some(),
                !entry.extensions.is_empty(),
                "{}",
                entry.name
            );
        }
    }
}
