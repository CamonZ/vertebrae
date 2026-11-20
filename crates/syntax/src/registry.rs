//! The language registry: one entry per grammar holding everything this
//! crate knows about it (its tree-sitter grammar, the paths it applies to
//! and, for languages the semantic diff supports, the scope profile, the
//! declarations and facts queries and the known-API tables). Supporting a
//! language means adding its entry here; nothing else matches on
//! [`Grammar`].

use crate::semantic::profile::{Compiled, Profile};
use std::sync::OnceLock;
use tree_sitter::Language;
use tree_sitter_language::LanguageFn;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Grammar {
    Bash,
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
};

/// Indexed by `Grammar as usize`.
pub(crate) const LANGUAGES: [LanguageEntry; 6] = [
    LanguageEntry {
        grammar: Grammar::Bash,
        name: "bash",
        language: tree_sitter_bash::LANGUAGE,
        extensions: &[],
        profile: None,
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
        }),
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
        }),
    },
    LanguageEntry {
        grammar: Grammar::TypeScript,
        name: "typescript",
        language: tree_sitter_typescript::LANGUAGE_TYPESCRIPT,
        extensions: &["ts", "mts", "cts"],
        profile: Some(TYPESCRIPT),
    },
    LanguageEntry {
        grammar: Grammar::Tsx,
        name: "tsx",
        language: tree_sitter_typescript::LANGUAGE_TSX,
        extensions: &["tsx"],
        profile: Some(TYPESCRIPT),
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
