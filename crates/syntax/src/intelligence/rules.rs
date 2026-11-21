//! Name-resolution rules, as held by each language's registry entry
//! (`crate::registry`): how imports are written (an imports query), which
//! files see each other's definitions without an import (reach), how an
//! import path maps to files, what marks a definition visible to other
//! files, and which receivers mean the enclosing type. The resolver is
//! language-neutral; supporting a language means writing this data.

use crate::Grammar;
use tree_sitter::Query;

pub(crate) struct Rules {
    /// Languages whose files may import each other share a family (`.ts`
    /// imports `.js`); calls are searched within a family.
    pub(crate) family: &'static str,
    /// Bindings query sources (imports and locals), joined; the capture
    /// vocabulary is in `queries/README.md`.
    pub(crate) bindings: &'static [&'static str],
    /// A nested function sees its enclosing functions' locals (closures
    /// do in every language; Rust's nested `fn` items do not).
    pub(crate) nested_sees_locals: bool,
    /// Inline modules are scopes of their own: an item outside one is not
    /// visible inside without an import (Rust's `mod`, not TypeScript's
    /// `namespace`).
    pub(crate) module_scopes: bool,
    pub(crate) reach: Reach,
    pub(crate) modules: Modules,
    pub(crate) exports: Exports,
    /// Receivers and path heads naming the enclosing type (`self`,
    /// `this`, `Self`).
    pub(crate) receivers: &'static [&'static str],
    /// `(parent kind, field)` of a name reached through a value or path
    /// (`x.name`, `a::name`): not a plain use of a definition.
    pub(crate) qualified: &'static [(&'static str, &'static str)],
    /// `(kind, field)` of a list prefixing the paths inside it
    /// (`a::{b, c}`), at any depth.
    pub(crate) prefix: Option<(&'static str, &'static str)>,
    /// Files marking the root of a package or crate: name-matched
    /// fallbacks search below the nearest one.
    pub(crate) unit_markers: &'static [&'static str],
}

/// Files whose top-level definitions a file sees without importing them,
/// besides its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reach {
    /// None (Rust modules, ECMAScript and Python modules).
    File,
    /// Files of the language in the same directory (Go packages).
    #[allow(dead_code, reason = "for language entries such as Go")]
    PackageDirectory,
    /// Files of the language below the nearest unit marker (Swift
    /// module targets).
    #[allow(dead_code, reason = "for language entries such as Swift")]
    ModuleTarget,
}

/// How an import path maps to files.
pub(crate) enum Modules {
    /// Rust-like: `crate::a::b` from a crate root, `self::`, `super::`;
    /// modules are files below the crate's source directory.
    Crate {
        manifest: &'static str,
        source: &'static str,
        /// Root files of a crate's source directory.
        roots: &'static [&'static str],
        /// Files of module `{}` below its parent's directory.
        files: &'static [&'static str],
        root: &'static str,
        current: &'static str,
        parent: &'static str,
        separator: &'static str,
    },
    /// Python-like: dotted paths, relative with leading dots, else from
    /// the importing file's directory or one of its ancestors.
    Dotted { files: &'static [&'static str] },
    /// ECMAScript-like: relative specifiers (`./a`) with optional
    /// extension, or a directory's index file; bare ones are packages.
    Specifier {
        extensions: &'static [&'static str],
        index: &'static str,
    },
}

impl Modules {
    /// How a qualifier's segments are joined (`a::b`, `a.b`).
    pub(crate) fn separator(&self) -> &'static str {
        match self {
            Self::Crate { separator, .. } => separator,
            Self::Dotted { .. } | Self::Specifier { .. } => ".",
        }
    }
}

/// What makes a top-level definition visible to other files.
pub(crate) enum Exports {
    /// Every definition (Python).
    All,
    /// A child node of this kind (`pub`).
    Modifier(&'static str),
    /// An enclosing node of this kind (`export`); `default` is the keyword
    /// marking a default export.
    Wrapper {
        kind: &'static str,
        default: &'static str,
    },
}

/// The compiled bindings query (imports and locals) and its capture
/// indices.
pub(crate) struct ImportsQuery {
    pub(crate) query: Query,
    pub(crate) captures: Vec<ImportCapture>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ImportCapture {
    /// The module the names come from.
    Source,
    /// An imported name, relative to the source when there is one, else a
    /// whole path whose last segment it binds.
    Name,
    /// The local name, when not the imported one.
    Alias,
    /// A local name for the source module, or (without a source) a module
    /// path whose first segment it binds.
    Module,
    /// A local name for the source's default export.
    Default,
    /// A path (or the source) all of whose names are imported.
    Glob,
    /// A local binding (parameter, `let`, assignment): it shadows
    /// definitions without being one.
    Local,
    Ignored,
}

impl ImportsQuery {
    pub(crate) fn compile(grammar: Grammar, sources: &[&str]) -> Result<Self, String> {
        let error = |error: String| format!("{}: {error}", grammar.name());
        let query = Query::new(&grammar.language(), &sources.join("\n"))
            .map_err(|e| error(e.to_string()))?;
        let captures = query
            .capture_names()
            .iter()
            .map(|name| {
                Ok(match *name {
                    "import.source" => ImportCapture::Source,
                    "import.name" => ImportCapture::Name,
                    "import.alias" => ImportCapture::Alias,
                    "import.module" => ImportCapture::Module,
                    "import.default" => ImportCapture::Default,
                    "import.glob" => ImportCapture::Glob,
                    "local" => ImportCapture::Local,
                    _ if name.starts_with('_') => ImportCapture::Ignored,
                    _ => return Err(error(format!("unknown capture @{name}"))),
                })
            })
            .collect::<Result<_, _>>()?;
        Ok(Self { query, captures })
    }
}
