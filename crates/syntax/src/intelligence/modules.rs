//! Import paths to files, per the language's [`Modules`] rule.

use super::embedded::{join, parent, Ctx};
use super::extract::FileSymbols;
use super::rules::{Modules, Rules};
use crate::semantic::DeclarationKind;
use std::collections::BTreeMap;

/// A module: its file, and the inline modules (`mod a { … }`) inside it,
/// outermost first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ModuleLoc {
    pub(super) path: String,
    pub(super) inline: Vec<String>,
}

/// A Rust-like module: its crate's directory and path from the crate
/// root. `own_root` is a file outside the source directory that is its
/// own crate root (an integration test, an example).
#[derive(Debug, Clone)]
struct CrateModule {
    dir: String,
    own_root: Option<String>,
    path: Vec<String>,
}

impl Ctx<'_> {
    /// The module an import source names (`./a`, `.a`, `a.b`), seen from
    /// file `from`. Not for Rust-like paths, which go through
    /// [`Ctx::module_at`].
    pub(super) fn module_from_source(
        &self,
        rules: &Rules,
        from: &str,
        source: &str,
    ) -> Option<ModuleLoc> {
        match &rules.modules {
            Modules::Specifier { extensions, index } => {
                self.specifier(from, source, extensions, index)
            }
            Modules::Dotted { files } => self.dotted(from, source, files),
            Modules::Crate { separator, .. } => {
                let segments: Vec<String> = source.split(separator).map(str::to_owned).collect();
                self.crate_path(rules, from, None, 0, &segments)
            }
        }
    }

    /// The module a qualifier's segments name at byte `at` of `from`
    /// (imports already substituted).
    pub(super) fn module_at(
        &self,
        rules: &Rules,
        from: &str,
        file: &FileSymbols,
        at: usize,
        segments: &[String],
    ) -> Option<ModuleLoc> {
        match &rules.modules {
            Modules::Crate { .. } => self.crate_path(rules, from, Some(file), at, segments),
            Modules::Dotted { .. } => self.module_from_source(rules, from, &segments.join(".")),
            Modules::Specifier { .. } => None,
        }
    }

    /// The top-level (or inline module's) definitions of a module named
    /// `name`, members excluded.
    pub(super) fn module_items(&self, module: &ModuleLoc, name: &str) -> Vec<usize> {
        let Some(file) = self.file(&module.path) else {
            return Vec::new();
        };
        let Some(container) = inline_module(&file, &module.inline) else {
            return Vec::new();
        };
        (0..file.defs.len())
            .filter(|&index| {
                let def = &file.defs[index];
                // An impl is not an item a path can name.
                def.container == container
                    && def.name == name
                    && def.kind != DeclarationKind::Impl
                    && !file.is_member(index)
            })
            .collect()
    }

    fn specifier(
        &self,
        from: &str,
        source: &str,
        extensions: &[&str],
        index: &str,
    ) -> Option<ModuleLoc> {
        if !(source.starts_with("./") || source.starts_with("../")) {
            // A package; not followed.
            return None;
        }
        let base = normalize(&join(parent(from), source))?;
        // `./a.js` may be written for `a.ts`.
        let stem = extensions
            .iter()
            .find_map(|extension| base.strip_suffix(&format!(".{extension}")))
            .map(str::to_owned);
        let mut candidates = vec![base.clone()];
        for stem in [Some(base.clone()), stem].into_iter().flatten() {
            candidates.extend(
                extensions
                    .iter()
                    .map(|extension| format!("{stem}.{extension}")),
            );
        }
        candidates.extend(
            extensions
                .iter()
                .map(|extension| format!("{base}/{index}.{extension}")),
        );
        candidates
            .into_iter()
            .find(|path| self.exists(path) && crate::Grammar::for_path(path).is_some())
            .map(|path| ModuleLoc {
                path,
                inline: Vec::new(),
            })
    }

    fn dotted(&self, from: &str, source: &str, files: &[&str]) -> Option<ModuleLoc> {
        let dots = source.chars().take_while(|c| *c == '.').count();
        let rest = &source[dots..];
        let segments: Vec<&str> = rest.split('.').filter(|s| !s.is_empty()).collect();
        let file_in = |dir: &str| -> Option<String> {
            let stem = join(dir, &segments.join("/"));
            if segments.is_empty() {
                return files
                    .iter()
                    .filter(|pattern| pattern.starts_with("{}/"))
                    .map(|pattern| join(dir, &pattern[3..]))
                    .find(|path| self.exists(path));
            }
            files
                .iter()
                .map(|pattern| pattern.replace("{}", &stem))
                .find(|path| self.exists(path))
        };
        let found = if dots > 0 {
            let mut dir = parent(from);
            for _ in 1..dots {
                dir = parent(dir);
            }
            file_in(dir)
        } else {
            // From the importing file's directory up to the root.
            let mut dir = parent(from);
            loop {
                if let Some(found) = file_in(dir) {
                    break Some(found);
                }
                if dir.is_empty() {
                    break None;
                }
                dir = parent(dir);
            }
        };
        found.map(|path| ModuleLoc {
            path,
            inline: Vec::new(),
        })
    }

    /// The crate module `from` (at byte `at`, inside its inline modules)
    /// is in.
    fn current_module(
        &self,
        rules: &Rules,
        from: &str,
        file: Option<&FileSymbols>,
        at: usize,
    ) -> Option<CrateModule> {
        let Modules::Crate {
            manifest,
            source,
            roots,
            ..
        } = &rules.modules
        else {
            return None;
        };
        let mut dir = parent(from);
        let crate_dir = loop {
            if self.exists(&join(dir, manifest)) {
                break dir.to_owned();
            }
            if dir.is_empty() {
                // No manifest: the snapshot's root holds the crate.
                break String::new();
            }
            dir = parent(dir);
        };
        let source_dir = join(&crate_dir, source);
        let mut module = match from.strip_prefix(&format!("{source_dir}/")) {
            Some(relative) if roots.contains(&relative) => CrateModule {
                dir: crate_dir,
                own_root: None,
                path: Vec::new(),
            },
            Some(relative) => {
                let stem = relative.strip_suffix(".rs").unwrap_or(relative);
                let stem = stem.strip_suffix("/mod").unwrap_or(stem);
                CrateModule {
                    dir: crate_dir,
                    own_root: None,
                    path: stem.split('/').map(str::to_owned).collect(),
                }
            }
            None => CrateModule {
                dir: crate_dir,
                own_root: Some(from.to_owned()),
                path: Vec::new(),
            },
        };
        if let Some(file) = file {
            let mut inline = Vec::new();
            let mut next = file.enclosing(at);
            while let Some(index) = next {
                if file.defs[index].kind == DeclarationKind::Module {
                    inline.push(file.defs[index].name.clone());
                }
                next = file.defs[index].container;
            }
            inline.reverse();
            module.path.extend(inline);
        }
        Some(module)
    }

    fn crate_path(
        &self,
        rules: &Rules,
        from: &str,
        file: Option<&FileSymbols>,
        at: usize,
        segments: &[String],
    ) -> Option<ModuleLoc> {
        let Modules::Crate {
            root,
            current,
            parent: up,
            ..
        } = &rules.modules
        else {
            return None;
        };
        let here = self.current_module(rules, from, file, at)?;
        let (first, rest) = segments.split_first()?;
        let mut module = if first == root {
            CrateModule {
                path: Vec::new(),
                ..here
            }
        } else if first == current {
            here
        } else if first == up {
            let mut module = here;
            module.path.pop()?;
            module
        } else {
            let mut child = here.clone();
            child.path.push(first.clone());
            if self.locate_crate_module(rules, &child).is_some() {
                child
            } else {
                let dir = self.crate_dirs(rules).get(first.as_str())?.clone();
                CrateModule {
                    dir,
                    own_root: None,
                    path: Vec::new(),
                }
            }
        };
        let mut rest = rest.iter().peekable();
        // `super::super::…`
        while rest.peek().is_some_and(|segment| *segment == up) {
            rest.next();
            module.path.pop()?;
        }
        module.path.extend(rest.cloned());
        self.locate_crate_module(rules, &module)
    }

    /// The file and inline modules holding a crate module, if it exists.
    fn locate_crate_module(&self, rules: &Rules, module: &CrateModule) -> Option<ModuleLoc> {
        let Modules::Crate {
            source,
            roots,
            files,
            ..
        } = &rules.modules
        else {
            return None;
        };
        let source_dir = join(&module.dir, source);
        let root_file = || match &module.own_root {
            Some(own) => Some(own.clone()),
            None => roots
                .iter()
                .map(|root| join(&source_dir, root))
                .find(|path| self.exists(path)),
        };
        // The longest prefix that is a file; the rest are inline modules.
        for split in (0..=module.path.len()).rev() {
            let path = if split == 0 {
                root_file()
            } else if module.own_root.is_some() {
                None
            } else {
                let stem = join(&source_dir, &module.path[..split].join("/"));
                files
                    .iter()
                    .map(|pattern| pattern.replace("{}", &stem))
                    .find(|path| self.exists(path))
            };
            let Some(path) = path else { continue };
            let found = ModuleLoc {
                path,
                inline: module.path[split..].to_vec(),
            };
            let file = self.file(&found.path)?;
            return inline_module(&file, &found.inline).map(|_| found);
        }
        None
    }

    /// Crate names (as written in paths) to their directories, from every
    /// manifest's `[package] name`.
    fn crate_dirs(&self, rules: &Rules) -> &BTreeMap<String, String> {
        self.crates.get_or_init(|| {
            let Modules::Crate { manifest, .. } = &rules.modules else {
                return BTreeMap::new();
            };
            let manifests: Vec<String> = self
                .paths()
                .iter()
                .filter(|path| path.rsplit('/').next() == Some(*manifest))
                .cloned()
                .collect();
            let mut crates = BTreeMap::new();
            for path in manifests {
                let Some(text) = self.text(&path) else {
                    continue;
                };
                if let Some(name) = package_name(&text) {
                    crates
                        .entry(name.replace('-', "_"))
                        .or_insert_with(|| parent(&path).to_owned());
                }
            }
            crates
        })
    }
}

/// The definition index of nested inline modules (`None` for the file's
/// top level); `None` when one is missing.
fn inline_module(file: &FileSymbols, inline: &[String]) -> Option<Option<usize>> {
    let mut container = None;
    for name in inline {
        container = Some(file.defs.iter().position(|def| {
            def.kind == DeclarationKind::Module && def.name == *name && def.container == container
        })?);
    }
    Some(container)
}

/// `name` in a manifest's `[package]` table.
fn package_name(manifest: &str) -> Option<String> {
    let mut in_package = false;
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            in_package = line == "[package]";
            continue;
        }
        if !in_package {
            continue;
        }
        let Some(value) = line.strip_prefix("name") else {
            continue;
        };
        let value = value.trim_start().strip_prefix('=')?.trim();
        return Some(value.trim_matches('"').to_owned());
    }
    None
}

/// `a/./b/../c` → `a/c`; `None` past the root.
fn normalize(path: &str) -> Option<String> {
    let mut out: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            _ => out.push(segment),
        }
    }
    Some(out.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_names_come_from_the_package_table() {
        let manifest = "[workspace]\nname = \"no\"\n[package]\nname = \"vertebrae-syntax\"\n";
        assert_eq!(package_name(manifest).as_deref(), Some("vertebrae-syntax"));
        assert_eq!(package_name("[dependencies]\nname = \"x\"\n"), None);
    }

    #[test]
    fn paths_normalize_within_the_root() {
        assert_eq!(normalize("a/./b/../c").as_deref(), Some("a/c"));
        assert_eq!(normalize("../a"), None);
    }
}
