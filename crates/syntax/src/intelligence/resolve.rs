//! Name resolution: which definitions a name at a call site (or other use)
//! may refer to, from the language's rules.
//!
//! A bare name's *bindings* are the definitions visible where it is used
//! (in an enclosing definition or at the file's top level, members
//! excluded), the imports binding it there, and the top-level definitions
//! of files in its reach. One binding to one definition is
//! [`Res::Exact`]; several bindings (shadowed or duplicated names) are
//! [`Res::Ambiguous`] with every candidate, innermost first. With no
//! binding, the name is searched among other files' exported definitions
//! in the same unit (crate, package): one is [`Res::NameMatch`], several
//! [`Res::Ambiguous`], none [`Res::Unresolved`].
//!
//! A qualified name (`self.m`, `a::b::f`, `ns.f`, `x.m`) resolves through
//! the enclosing type, a module, a type, or (for a value receiver) by
//! searching members with the name.
//!
//! Where the language identifies callables by arity (Elixir), a call
//! binds only definitions taking its number of arguments; where modules
//! are declared by name (Elixir), a qualified call names a module
//! (`Accounts.get`, through an `alias`) and reaches its public
//! definitions only, and a call through a value is dynamic: unresolved.

use super::embedded::{parent, Ctx};
use super::extract::{bare_type_name, is_type_container, FileSymbols, ImportTarget, Qualifier};
use super::modules::{declared_name, ModuleLoc};
use super::rules::{Modules, Reach, Rules};
use crate::semantic::DeclarationKind;
use std::sync::Arc;

/// A definition in a file read by the request.
#[derive(Clone)]
pub(super) struct Found {
    pub(super) path: Arc<str>,
    pub(super) file: Arc<FileSymbols>,
    pub(super) index: usize,
}

impl PartialEq for Found {
    fn eq(&self, other: &Self) -> bool {
        self.index == other.index && self.path == other.path
    }
}

pub(super) enum Res {
    Exact(Found),
    NameMatch(Found),
    Ambiguous(Vec<Found>),
    Unresolved,
}

impl Res {
    pub(super) fn includes(&self, target: &Found) -> bool {
        match self {
            Self::Exact(found) | Self::NameMatch(found) => found == target,
            Self::Ambiguous(candidates) => candidates.contains(target),
            Self::Unresolved => false,
        }
    }

    /// Several definitions found by name alone.
    fn by_name(mut found: Vec<Found>) -> Self {
        dedup(&mut found);
        match found.len() {
            0 => Self::Unresolved,
            1 => Self::NameMatch(found.remove(0)),
            _ => Self::Ambiguous(found),
        }
    }

    /// Definitions found by following bindings: one is exact.
    fn bound(mut found: Vec<Found>) -> Self {
        dedup(&mut found);
        match found.len() {
            0 => Self::Unresolved,
            1 => Self::Exact(found.remove(0)),
            _ => Self::Ambiguous(found),
        }
    }
}

fn dedup(found: &mut Vec<Found>) {
    let mut seen: Vec<Found> = Vec::new();
    found.retain(|item| {
        if seen.contains(item) {
            false
        } else {
            seen.push(item.clone());
            true
        }
    });
}

/// What a name may be: something called (with this many arguments, where
/// arity counts), or anything at all.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Wanted {
    Callable(Option<u32>),
    Any,
    Type,
}

impl Wanted {
    fn arity(self) -> Option<u32> {
        match self {
            Self::Callable(arity) => arity,
            Self::Any | Self::Type => None,
        }
    }

    /// Whether a definition is what is wanted, its arity included.
    fn matches(self, def: &super::extract::Def) -> bool {
        self.accepts(def.kind) && def.takes(self.arity())
    }

    fn accepts(self, kind: DeclarationKind) -> bool {
        match self {
            Self::Any => !matches!(kind, DeclarationKind::Import | DeclarationKind::Impl),
            Self::Callable(_) => matches!(
                kind,
                DeclarationKind::Function | DeclarationKind::Class | DeclarationKind::Constant
            ),
            Self::Type => matches!(
                kind,
                DeclarationKind::Class | DeclarationKind::Interface | DeclarationKind::Type
            ),
        }
    }
}

/// One binding of a bare name.
enum Binding {
    Def(usize),
    Import(usize),
    Elsewhere(Found),
    /// A parameter or local variable: no definition to point to.
    Local,
}

impl Ctx<'_> {
    pub(super) fn resolve_call(
        &self,
        path: &Arc<str>,
        file: &Arc<FileSymbols>,
        index: usize,
    ) -> Res {
        let Some(rules) = file.grammar.rules() else {
            return Res::Unresolved;
        };
        let call = &file.calls[index];
        let wanted = Wanted::Callable(call.arity);
        match &call.qualifier {
            None => self.bare(rules, path, file, call.byte, &call.name, wanted),
            Some(Qualifier::Receiver(receiver))
                if matches!(rules.modules, Modules::Declared { .. }) =>
            {
                self.declared_call(rules, path, file, call.byte, receiver, &call.name, wanted)
            }
            Some(qualifier) => {
                self.qualified(rules, path, file, call.byte, qualifier, &call.name, wanted)
            }
        }
    }

    /// A plain use of `name` at byte `at`.
    pub(super) fn resolve_use(
        &self,
        path: &Arc<str>,
        file: &Arc<FileSymbols>,
        at: usize,
        name: &str,
    ) -> Res {
        match file.grammar.rules() {
            Some(rules) => self.bare(rules, path, file, at, name, Wanted::Any),
            None => Res::Unresolved,
        }
    }

    /// The definitions an import binds.
    pub(super) fn resolve_import(
        &self,
        path: &Arc<str>,
        file: &Arc<FileSymbols>,
        index: usize,
    ) -> Res {
        match file.grammar.rules() {
            Some(rules) => Res::bound(self.import_targets(rules, path, file, index, None)),
            None => Res::Unresolved,
        }
    }

    fn bare(
        &self,
        rules: &Rules,
        path: &Arc<str>,
        file: &Arc<FileSymbols>,
        at: usize,
        name: &str,
        wanted: Wanted,
    ) -> Res {
        let here = file.enclosing(at);
        // Where modules are scopes, only the use's own module's items and
        // imports are visible.
        let module_of = |index: Option<usize>| {
            rules
                .module_scopes
                .then(|| enclosing_module(file, index))
                .flatten()
        };
        let site_module = module_of(here);
        let mut bindings: Vec<(usize, Binding)> = Vec::new();
        for (index, def) in file.defs.iter().enumerate() {
            if def.name != name || !wanted.matches(def) || file.is_member(index) {
                continue;
            }
            // Visible where its container encloses the use.
            let visible = match def.container {
                None => true,
                Some(container) => file.within(here, container),
            };
            if visible && module_of(def.container) == site_module {
                bindings.push((depth(file, def.container), Binding::Def(index)));
            }
        }
        // Parameters and local variables shadow definitions without being
        // one; nested functions see them where the language says so.
        // Where a variable is not called by name, it binds no call.
        let locals_bind = rules.local_calls || !matches!(wanted, Wanted::Callable(_));
        for local in file.locals.iter().filter(|_| locals_bind) {
            if local.name != name {
                continue;
            }
            let visible = match local.scope {
                None => true,
                Some(scope) if rules.nested_sees_locals => file.within(here, scope),
                Some(scope) => closest_function(file, here) == Some(scope),
            };
            if visible && module_of(local.scope) == site_module {
                if rules.locals_hide_call_targets && wanted == Wanted::Callable {
                    return Res::Unresolved;
                }
                bindings.push((depth(file, local.scope) + 1, Binding::Local));
            }
        }
        let mut globs = Vec::new();
        for (index, import) in file.imports.iter().enumerate() {
            let in_scope = match import.scope {
                None => true,
                Some(scope) => file.within(here, scope),
            };
            if !in_scope || module_of(file.enclosing(import.byte)) != site_module {
                continue;
            }
            if matches!(import.target, ImportTarget::Glob { .. }) {
                globs.push(index);
            } else if import.local == name {
                // An import of other arities binds nothing here.
                let arity = wanted.arity();
                let mismatched = arity.is_some()
                    && (import.arity.is_some_and(|only| Some(only) != arity)
                        || !self
                            .import_targets(rules, path, file, index, None)
                            .is_empty()
                            && self
                                .import_targets(rules, path, file, index, arity)
                                .is_empty());
                if !mismatched {
                    bindings.push((depth(file, import.scope), Binding::Import(index)));
                }
            }
        }
        for other in self.reach_files(rules, path) {
            let Some(other_file) = self.file(&other) else {
                continue;
            };
            let other: Arc<str> = Arc::from(other.as_str());
            for index in 0..other_file.defs.len() {
                let def = &other_file.defs[index];
                if def.container.is_none() && def.name == name && wanted.matches(def) {
                    bindings.push((
                        0,
                        Binding::Elsewhere(Found {
                            path: other.clone(),
                            file: other_file.clone(),
                            index,
                        }),
                    ));
                }
            }
        }
        // Explicit bindings shadow glob imports.
        if bindings.is_empty() {
            for index in globs {
                let import = &file.imports[index];
                let ImportTarget::Glob { source, except } = &import.target else {
                    continue;
                };
                let left_out = except.iter().any(|(left_out, arity)| {
                    left_out == name
                        && (arity.is_none() || wanted.arity().is_none() || *arity == wanted.arity())
                });
                if left_out {
                    continue;
                }
                if let Some(module) = self.import_module(rules, path, file, import.byte, source) {
                    for found in self.items(&module, name, wanted.arity()) {
                        if reachable(rules, &found) {
                            bindings.push((0, Binding::Elsewhere(found)));
                        }
                    }
                }
            }
        }
        // Innermost first; source order within a level.
        bindings.sort_by_key(|(depth, _)| std::cmp::Reverse(*depth));
        let count = bindings.len();
        let mut targets = Vec::new();
        for (_, binding) in bindings {
            match binding {
                Binding::Def(index) => targets.push(Found {
                    path: path.clone(),
                    file: file.clone(),
                    index,
                }),
                Binding::Import(index) => {
                    targets.extend(self.import_targets(rules, path, file, index, wanted.arity()));
                }
                Binding::Local => {}
                Binding::Elsewhere(found) => targets.push(found),
            }
        }
        match count {
            0 if !rules.unbound_search => Res::Unresolved,
            0 => self.exported_search(rules, path, name, wanted),
            1 => Res::bound(targets),
            _ => {
                dedup(&mut targets);
                if targets.is_empty() {
                    Res::Unresolved
                } else {
                    Res::Ambiguous(targets)
                }
            }
        }
    }

    /// Files whose top-level definitions `path` sees without importing.
    fn reach_files(&self, rules: &Rules, path: &str) -> Vec<String> {
        let dir = match rules.reach {
            Reach::File => return Vec::new(),
            Reach::PackageDirectory => parent(path).to_owned(),
            Reach::ModuleTarget => self.unit_root(path, rules),
        };
        self.paths()
            .iter()
            .filter(|other| *other != path)
            .filter(|other| match rules.reach {
                Reach::PackageDirectory => parent(other) == dir,
                _ => dir.is_empty() || other.starts_with(&format!("{dir}/")),
            })
            .filter(|other| {
                crate::Grammar::for_path(other)
                    .and_then(crate::Grammar::rules)
                    .is_some_and(|other_rules| other_rules.family == rules.family)
            })
            .cloned()
            .collect()
    }

    /// Other files' exported, non-member definitions named `name`, in the
    /// unit.
    fn exported_search(&self, rules: &Rules, path: &Arc<str>, name: &str, wanted: Wanted) -> Res {
        let unit = self.unit_root(path, rules);
        let mut found = Vec::new();
        for other in self.search(rules.family, &unit, &[name]) {
            if *other == **path {
                continue;
            }
            let Some(file) = self.file(&other) else {
                continue;
            };
            let other: Arc<str> = Arc::from(other.as_str());
            for index in 0..file.defs.len() {
                let def = &file.defs[index];
                if def.name == name
                    && def.container.is_none()
                    && def.exported
                    && wanted.matches(def)
                {
                    found.push(Found {
                        path: other.clone(),
                        file: file.clone(),
                        index,
                    });
                }
            }
        }
        Res::by_name(found)
    }

    /// Members named `name` in the unit, of types named `owner` if given.
    fn member_search(
        &self,
        rules: &Rules,
        path: &Arc<str>,
        owner: Option<&str>,
        name: &str,
    ) -> Vec<Found> {
        let unit = self.unit_root(path, rules);
        let needles: Vec<&str> = std::iter::once(name).chain(owner).collect();
        let mut found = Vec::new();
        for other in self.search(rules.family, &unit, &needles) {
            let Some(file) = self.file(&other) else {
                continue;
            };
            let other: Arc<str> = Arc::from(other.as_str());
            for index in 0..file.defs.len() {
                if file.defs[index].name != name || !file.is_member(index) {
                    continue;
                }
                if owner.is_some() && owner_type(&file, index).as_deref() != owner {
                    continue;
                }
                found.push(Found {
                    path: other.clone(),
                    file: file.clone(),
                    index,
                });
            }
        }
        found
    }

    /// A call through a declared module (`Accounts.get(x)`): the receiver
    /// names a module, absolutely, through an `alias`, as a module nested
    /// in an enclosing one, or as the enclosing module itself
    /// (`__MODULE__`). Only its public definitions are reached. A receiver
    /// that is a value (`mod.f()`) or an atom (`:ets`) is dynamic or
    /// external: unresolved.
    #[allow(clippy::too_many_arguments, reason = "the call site's parts")]
    fn declared_call(
        &self,
        rules: &Rules,
        path: &Arc<str>,
        file: &Arc<FileSymbols>,
        at: usize,
        receiver: &str,
        name: &str,
        wanted: Wanted,
    ) -> Res {
        let Modules::Declared {
            separator, current, ..
        } = &rules.modules
        else {
            return Res::Unresolved;
        };
        let segments: Vec<&str> = receiver.split(*separator).collect();
        if !segments.iter().all(|segment| plain(segment)) {
            return Res::Unresolved;
        }
        let (head, rest) = (segments[0], &segments[1..]);
        let joined = |base: &str| {
            std::iter::once(base)
                .chain(rest.iter().copied())
                .collect::<Vec<_>>()
                .join(separator)
        };
        let here = file.enclosing(at);
        let enclosing = declared_name(file, here, separator);
        let module = if head == *current {
            match &enclosing {
                Some(enclosing) => joined(enclosing),
                None => return Res::Unresolved,
            }
        } else if !head.starts_with(|c: char| c.is_uppercase()) {
            return Res::Unresolved;
        } else if let Some(import) = self.visible_import(file, at, head) {
            match &import.target {
                ImportTarget::Path(full) => joined(full),
                _ => receiver.to_owned(),
            }
        } else {
            // `Inner` inside `Outer` (or a module nested in it) may name
            // `Outer.Inner`, innermost first; else the name is absolute.
            let mut scopes: Vec<String> = Vec::new();
            let mut next = here;
            while let Some(index) = next {
                if file.defs[index].kind == DeclarationKind::Module {
                    scopes.extend(declared_name(file, Some(index), separator));
                }
                next = file.defs[index].container;
            }
            scopes
                .into_iter()
                .map(|scope| format!("{scope}{separator}{receiver}"))
                .find(|nested| !self.declared_modules(rules, path, nested).is_empty())
                .unwrap_or_else(|| receiver.to_owned())
        };
        let mut found = Vec::new();
        for module in self.declared_modules(rules, path, &module) {
            found.extend(
                self.items(&module, name, wanted.arity())
                    .into_iter()
                    .filter(|found| reachable(rules, found)),
            );
        }
        Res::bound(found)
    }

    #[allow(clippy::too_many_arguments, reason = "the call site's parts")]
    fn qualified(
        &self,
        rules: &Rules,
        path: &Arc<str>,
        file: &Arc<FileSymbols>,
        at: usize,
        qualifier: &Qualifier,
        name: &str,
        wanted: Wanted,
    ) -> Res {
        let arity = wanted.arity();
        let (text, is_path) = match qualifier {
            Qualifier::Path(text) => (text.as_str(), true),
            Qualifier::Receiver(text) => (text.as_str(), false),
        };
        let separator = if is_path { "::" } else { "." };
        let segments: Option<Vec<String>> = text
            .split(separator)
            .map(|segment| plain(segment).then(|| segment.to_owned()))
            .collect();
        let known = |ctx: &Self| {
            ctx.file_apis(file)
                .is_some_and(|apis| apis.knows_call(Some((is_path, text)), name))
        };
        let Some(segments) = segments else {
            // A computed receiver (`f().g()`): a value.
            return self.value_member(rules, path, name, known(self));
        };
        if segments.len() == 1 && rules.receivers.contains(&segments[0].as_str()) {
            return self.self_member(rules, path, file, at, name);
        }
        let dotted_modules = !matches!(rules.modules, Modules::Crate { .. });
        if !is_path && !dotted_modules {
            // Rust receivers are values.
            return self.value_member(rules, path, name, known(self));
        }
        if !is_path {
            // `.` joins modules and types too: only when the head is
            // bound to an import or a type here.
            let head = &segments[0];
            let here = file.enclosing(at);
            let head_bound = self.visible_import(file, at, head).is_some()
                || file.defs.iter().enumerate().any(|(index, def)| {
                    def.name == *head
                        && Wanted::Type.accepts(def.kind)
                        && !file.is_member(index)
                        && def
                            .container
                            .is_none_or(|container| file.within(here, container))
                });
            if !head_bound {
                return self.value_member(rules, path, name, known(self));
            }
        }
        // Substitute an imported head.
        let mut expanded = segments.clone();
        let mut head_item = None;
        if let Some(import) = self.visible_import(file, at, &segments[0]) {
            match &import.target {
                ImportTarget::Path(full) => {
                    let mut replaced: Vec<String> = full
                        .split(rules.modules.separator())
                        .map(str::to_owned)
                        .collect();
                    replaced.extend(segments[1..].iter().cloned());
                    expanded = replaced;
                }
                ImportTarget::Module { source } if dotted_modules => {
                    if let Some(module) = self.module_from_source(rules, path, source) {
                        if segments.len() == 1 {
                            return Res::bound(self.items(&module, name, arity));
                        }
                    }
                    let mut replaced: Vec<String> = source.split('.').map(str::to_owned).collect();
                    replaced.extend(segments[1..].iter().cloned());
                    expanded = replaced;
                }
                ImportTarget::Item { source, name: item } => {
                    head_item = Some((source.clone(), item.clone()));
                    let mut replaced = vec![source.clone(), item.clone()];
                    replaced.extend(segments[1..].iter().cloned());
                    expanded = replaced;
                }
                _ => {}
            }
        }
        let module = match &head_item {
            // `from a import b; b.f()`: `b` may be module `a.b`.
            Some((source, item)) if segments.len() == 1 => {
                let joined = if source.ends_with('.') {
                    format!("{source}{item}")
                } else {
                    format!("{source}.{item}")
                };
                self.module_from_source(rules, path, &joined)
            }
            Some(_) => None,
            None => self.module_at(rules, path, file, at, &expanded),
        };
        if let Some(module) = module {
            return Res::bound(self.items(&module, name, arity));
        }
        // A type: `Type::f`, `mod::Type::f`, `Class.f`.
        let owner = segments.last().cloned().unwrap_or_default();
        let types = match (&head_item, segments.len()) {
            (Some((source, item)), 1) => self
                .module_from_source(rules, path, source)
                .map_or(Res::Unresolved, |module| {
                    Res::bound(self.items(&module, item, None))
                }),
            (None, 1) => self.bare(rules, path, file, at, &owner, Wanted::Type),
            _ => {
                let module_path = &expanded[..expanded.len() - 1];
                self.module_at(rules, path, file, at, module_path)
                    .map_or(Res::Unresolved, |module| {
                        Res::bound(self.items(&module, &owner, None))
                    })
            }
        };
        let type_names: Vec<String> = match &types {
            Res::Exact(found) | Res::NameMatch(found) => vec![type_name_of(found)],
            Res::Ambiguous(found) => found.iter().map(type_name_of).collect(),
            Res::Unresolved => vec![bare_type_name(&owner)],
        };
        // Members in the type's file (its body, impls beside it) and in
        // the calling file.
        let mut members = Vec::new();
        if let Res::Exact(found) | Res::NameMatch(found) = &types {
            members.extend(type_members_in(
                &found.path,
                &found.file,
                &type_names[0],
                name,
            ));
            if found.path != *path {
                members.extend(type_members_in(path, file, &type_names[0], name));
            }
        }
        dedup(&mut members);
        if !members.is_empty() {
            return match types {
                Res::Exact(_) => Res::bound(members),
                _ => Res::by_name(members),
            };
        }
        let mut found = Vec::new();
        for owner in &type_names {
            found.extend(self.member_search(rules, path, Some(owner), name));
        }
        Res::by_name(found)
    }

    /// `self.m()`: methods of the enclosing type, else members by name.
    fn self_member(
        &self,
        rules: &Rules,
        path: &Arc<str>,
        file: &Arc<FileSymbols>,
        at: usize,
        name: &str,
    ) -> Res {
        let mut next = file.enclosing(at);
        let mut owner = None;
        while let Some(index) = next {
            if is_type_container(file.defs[index].kind) {
                owner = file.defs[index].type_name.clone();
                break;
            }
            next = file.defs[index].container;
        }
        let Some(owner) = owner else {
            return self.value_member(rules, path, name, false);
        };
        let local = type_members_in(path, file, &owner, name);
        if !local.is_empty() {
            return Res::bound(local);
        }
        let elsewhere = self.member_search(rules, path, Some(&owner), name);
        if !elsewhere.is_empty() {
            return Res::by_name(elsewhere);
        }
        self.value_member(rules, path, name, false)
    }

    /// `x.m()` on a value: members named `m` anywhere in the unit, unless
    /// the API tables know the call.
    fn value_member(&self, rules: &Rules, path: &Arc<str>, name: &str, known: bool) -> Res {
        if known {
            return Res::Unresolved;
        }
        Res::by_name(self.member_search(rules, path, None, name))
    }

    fn file_apis<'f>(&self, file: &'f FileSymbols) -> Option<&'f crate::semantic::ApiTable> {
        file.grammar.compiled().map(|compiled| &compiled.apis)
    }

    fn visible_import<'f>(
        &self,
        file: &'f FileSymbols,
        at: usize,
        local: &str,
    ) -> Option<&'f super::extract::Import> {
        let here = file.enclosing(at);
        file.imports.iter().rev().find(|import| {
            import.local == local
                && !matches!(import.target, ImportTarget::Glob { .. })
                && import.scope.is_none_or(|scope| file.within(here, scope))
        })
    }

    /// The module an import source names, as seen where the import is
    /// (Rust paths depend on the inline module it sits in).
    fn import_module(
        &self,
        rules: &Rules,
        path: &Arc<str>,
        file: &FileSymbols,
        at: usize,
        source: &str,
    ) -> Option<ModuleLoc> {
        match rules.modules {
            Modules::Crate { separator, .. } => {
                let segments: Vec<String> = source.split(separator).map(str::to_owned).collect();
                self.module_at(rules, path, file, at, &segments)
            }
            _ => self.module_from_source(rules, path, source),
        }
    }

    /// The definitions an import's target names (taking `arity`
    /// arguments, when given).
    fn import_targets(
        &self,
        rules: &Rules,
        path: &Arc<str>,
        file: &FileSymbols,
        index: usize,
        arity: Option<u32>,
    ) -> Vec<Found> {
        let import = &file.imports[index];
        let at = import.byte;
        // An import of one arity names only definitions taking it.
        let arity = arity.or(import.arity);
        let mut targets = match &import.target {
            ImportTarget::Item { source, name } => self
                .import_module(rules, path, file, at, source)
                .map(|module| self.items(&module, name, arity))
                .unwrap_or_default(),
            ImportTarget::Path(full) => {
                let separator = rules.modules.separator();
                let Some((module, name)) = full.rsplit_once(separator) else {
                    return Vec::new();
                };
                self.import_module(rules, path, file, at, module)
                    .map(|module| self.items(&module, name, arity))
                    .unwrap_or_default()
            }
            ImportTarget::Default { source } => {
                let Some(module) = self.module_from_source(rules, path, source) else {
                    return Vec::new();
                };
                let Some(file) = self.file(&module.path) else {
                    return Vec::new();
                };
                let module_path: Arc<str> = Arc::from(module.path.as_str());
                (0..file.defs.len())
                    .filter(|&index| {
                        file.defs[index].default_export && file.defs[index].container.is_none()
                    })
                    .map(|index| Found {
                        path: module_path.clone(),
                        file: file.clone(),
                        index,
                    })
                    .collect()
            }
            ImportTarget::Module { .. } | ImportTarget::Glob { .. } => Vec::new(),
        };
        targets.retain(|found| reachable(rules, found));
        targets
    }

    /// A module's definitions named `name` (taking `arity` arguments, when
    /// given).
    fn items(&self, module: &ModuleLoc, name: &str, arity: Option<u32>) -> Vec<Found> {
        let Some(file) = self.file(&module.path) else {
            return Vec::new();
        };
        let path: Arc<str> = Arc::from(module.path.as_str());
        self.module_items(module, name)
            .into_iter()
            .filter(|&index| file.defs[index].takes(arity))
            .map(|index| Found {
                path: path.clone(),
                file: file.clone(),
                index,
            })
            .collect()
    }
}

/// Whether another module may reach a definition: where modules are
/// declared by name, only a public one is (Elixir's `defp` is not).
fn reachable(rules: &Rules, found: &Found) -> bool {
    !matches!(rules.modules, Modules::Declared { .. }) || found.file.defs[found.index].exported
}

/// The innermost inline module at or around a definition.
fn enclosing_module(file: &FileSymbols, mut index: Option<usize>) -> Option<usize> {
    while let Some(current) = index {
        if file.defs[current].kind == DeclarationKind::Module {
            return Some(current);
        }
        index = file.defs[current].container;
    }
    None
}

/// The innermost function or method at or around a definition.
fn closest_function(file: &FileSymbols, mut index: Option<usize>) -> Option<usize> {
    while let Some(current) = index {
        if matches!(
            file.defs[current].kind,
            DeclarationKind::Function | DeclarationKind::Method
        ) {
            return Some(current);
        }
        index = file.defs[current].container;
    }
    None
}

/// How many definitions enclose a binding's container.
fn depth(file: &FileSymbols, mut container: Option<usize>) -> usize {
    let mut depth = 0;
    while let Some(index) = container {
        depth += 1;
        container = file.defs[index].container;
    }
    depth
}

fn plain(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '$'))
}

/// The bare name of the type a member belongs to.
fn owner_type(file: &FileSymbols, index: usize) -> Option<String> {
    let container = file.defs[index].container?;
    file.defs[container].type_name.clone()
}

fn type_name_of(found: &Found) -> String {
    let def = &found.file.defs[found.index];
    def.type_name
        .clone()
        .unwrap_or_else(|| bare_type_name(&def.name))
}

/// Members named `name` of any type definition or impl in `file` whose
/// type is `owner`.
fn type_members_in(
    path: &Arc<str>,
    file: &Arc<FileSymbols>,
    owner: &str,
    name: &str,
) -> Vec<Found> {
    (0..file.defs.len())
        .filter(|&index| {
            file.defs[index].name == name
                && file.is_member(index)
                && owner_type(file, index).as_deref() == Some(owner)
        })
        .map(|index| Found {
            path: path.clone(),
            file: file.clone(),
            index,
        })
        .collect()
}
