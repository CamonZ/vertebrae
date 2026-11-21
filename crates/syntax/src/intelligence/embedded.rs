//! The embedded provider: tree-sitter extraction per file, cached by
//! content, and the name-based resolver over it. Each request reads only
//! the files it needs (the symbol's file, the modules its imports name,
//! and files containing the searched name), within its budget.

use super::extract::{self, FileSymbols};
use super::resolve::{Found, Res};
use super::rules::Rules;
use super::{
    Answer, Budget, Call, CodeIntelligence, CodeSymbol, IncomingCall, IntelligenceError, Outcome,
    ProviderId, Reference, ReferenceKind, Resolution, Snapshot, SnapshotError, SourceLocation,
    SymbolKey, Truncation,
};
use crate::Grammar;
use std::cell::{Cell, OnceCell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Extracted files kept, past either limit the oldest go first.
const CACHE_ENTRIES: usize = 8_192;
const CACHE_BYTES: usize = 256 * 1024 * 1024;

/// The cache key: grammar, length and a 64-bit FNV-1a digest of the text.
type Key = (Grammar, usize, u64);

fn digest(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

#[derive(Default)]
struct Cache {
    entries: HashMap<Key, (Arc<FileSymbols>, usize)>,
    order: VecDeque<Key>,
    bytes: usize,
}

impl Cache {
    fn get(&self, key: &Key) -> Option<Arc<FileSymbols>> {
        self.entries.get(key).map(|(file, _)| file.clone())
    }

    fn store(&mut self, key: Key, file: Arc<FileSymbols>, limits: (usize, usize)) {
        let weight = file.weight();
        if let Some((_, replaced)) = self.entries.insert(key, (file, weight)) {
            self.bytes -= replaced;
        } else {
            self.order.push_back(key);
        }
        self.bytes += weight;
        while self.order.len() > limits.0 || self.bytes > limits.1 {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some((_, weight)) = self.entries.remove(&oldest) {
                self.bytes -= weight;
            }
        }
    }
}

/// Counters, for tests and diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EmbeddedStats {
    /// Files parsed and extracted (cache misses).
    pub extractions: u64,
    /// Files whose extraction came from the cache.
    pub cache_hits: u64,
}

/// Tree-sitter code intelligence for every language the registry gives
/// resolution rules. Thread-safe; one instance can serve every snapshot,
/// as its cache is keyed by content.
pub struct EmbeddedProvider {
    cache: Mutex<Cache>,
    limits: (usize, usize),
    extractions: AtomicU64,
    cache_hits: AtomicU64,
}

impl Default for EmbeddedProvider {
    fn default() -> Self {
        Self::with_cache_limits(CACHE_ENTRIES, CACHE_BYTES)
    }
}

impl EmbeddedProvider {
    pub const ID: &'static str = "embedded";

    pub fn new() -> Self {
        Self::default()
    }

    /// A provider keeping at most `entries` extracted files and about
    /// `bytes` of them.
    pub fn with_cache_limits(entries: usize, bytes: usize) -> Self {
        Self {
            cache: Mutex::new(Cache::default()),
            limits: (entries, bytes),
            extractions: AtomicU64::new(0),
            cache_hits: AtomicU64::new(0),
        }
    }

    pub fn stats(&self) -> EmbeddedStats {
        EmbeddedStats {
            extractions: self.extractions.load(Ordering::Relaxed),
            cache_hits: self.cache_hits.load(Ordering::Relaxed),
        }
    }

    fn answer<T>(&self, ctx: &Ctx, mut items: Vec<T>) -> Outcome<T> {
        if let Some(error) = ctx.error.borrow_mut().take() {
            return Err(error.into());
        }
        let mut truncated = ctx.truncated.get();
        if items.len() > ctx.budget.max_results {
            items.truncate(ctx.budget.max_results);
            truncated = truncated.or(Some(Truncation::ResultLimit));
        }
        Ok(Answer {
            provider: ProviderId::new(Self::ID),
            items,
            truncated,
        })
    }
}

/// One request's view of a snapshot: files read so far, the budget left.
pub(super) struct Ctx<'a> {
    provider: &'a EmbeddedProvider,
    snapshot: &'a dyn Snapshot,
    pub(super) budget: &'a Budget,
    deadline: Instant,
    paths: OnceCell<BTreeSet<String>>,
    texts: RefCell<HashMap<String, Option<Arc<str>>>>,
    files: RefCell<HashMap<String, Option<Arc<FileSymbols>>>>,
    reads: Cell<usize>,
    truncated: Cell<Option<Truncation>>,
    error: RefCell<Option<SnapshotError>>,
    pub(super) crates: OnceCell<BTreeMap<String, String>>,
    /// Declared modules by project root and full name, as found.
    pub(super) declared: RefCell<HashMap<(String, String), Vec<super::modules::ModuleLoc>>>,
}

impl<'a> Ctx<'a> {
    fn new(provider: &'a EmbeddedProvider, snapshot: &'a dyn Snapshot, budget: &'a Budget) -> Self {
        Self {
            provider,
            snapshot,
            budget,
            deadline: Instant::now() + budget.time,
            paths: OnceCell::new(),
            texts: RefCell::new(HashMap::new()),
            files: RefCell::new(HashMap::new()),
            reads: Cell::new(0),
            truncated: Cell::new(None),
            error: RefCell::new(None),
            crates: OnceCell::new(),
            declared: RefCell::new(HashMap::new()),
        }
    }

    pub(super) fn truncate(&self, why: Truncation) {
        if self.truncated.get().is_none() {
            self.truncated.set(Some(why));
        }
    }

    /// False (and the answer marked) once the time is spent or reading
    /// failed. Running out of files only stops further reads.
    pub(super) fn within_budget(&self) -> bool {
        if self.truncated.get() == Some(Truncation::TimedOut) || self.error.borrow().is_some() {
            return false;
        }
        if Instant::now() >= self.deadline {
            self.truncate(Truncation::TimedOut);
            return false;
        }
        true
    }

    fn fail(&self, error: SnapshotError) {
        self.error.borrow_mut().get_or_insert(error);
    }

    /// Every path in the snapshot.
    pub(super) fn paths(&self) -> &BTreeSet<String> {
        self.paths.get_or_init(|| match self.snapshot.paths() {
            Ok(paths) => paths.into_iter().collect(),
            Err(error) => {
                self.fail(error);
                BTreeSet::new()
            }
        })
    }

    pub(super) fn exists(&self, path: &str) -> bool {
        self.paths().contains(path)
    }

    /// A file's text, read once per request and counted against the
    /// budget.
    pub(super) fn text(&self, path: &str) -> Option<Arc<str>> {
        if let Some(text) = self.texts.borrow().get(path) {
            return text.clone();
        }
        if !self.within_budget() {
            return None;
        }
        if self.reads.get() >= self.budget.max_files {
            self.truncate(Truncation::FileLimit);
            return None;
        }
        self.reads.set(self.reads.get() + 1);
        let text = match self.snapshot.read(path, self.budget.max_file_bytes) {
            Ok(text) => text.map(Arc::from),
            Err(error) => {
                self.fail(error);
                None
            }
        };
        self.texts
            .borrow_mut()
            .insert(path.to_owned(), text.clone());
        text
    }

    /// A file's extraction, from the provider's cache when its content was
    /// seen before.
    pub(super) fn file(&self, path: &str) -> Option<Arc<FileSymbols>> {
        if let Some(file) = self.files.borrow().get(path) {
            return file.clone();
        }
        let file = self.load(path);
        self.files
            .borrow_mut()
            .insert(path.to_owned(), file.clone());
        file
    }

    fn load(&self, path: &str) -> Option<Arc<FileSymbols>> {
        let grammar = Grammar::for_path(path).filter(|grammar| grammar.rules().is_some())?;
        let text = self.text(path)?;
        let key = (grammar, text.len(), digest(&text));
        let cached = self
            .provider
            .cache
            .lock()
            .ok()
            .and_then(|cache| cache.get(&key));
        if let Some(file) = cached {
            self.provider.cache_hits.fetch_add(1, Ordering::Relaxed);
            return Some(file);
        }
        let Some(file) = extract::extract(grammar, text, self.deadline) else {
            // Queries are covered by tests, so this is the parse deadline.
            self.truncate(Truncation::TimedOut);
            return None;
        };
        self.provider.extractions.fetch_add(1, Ordering::Relaxed);
        let file = Arc::new(file);
        if let Ok(mut cache) = self.provider.cache.lock() {
            cache.store(key, file.clone(), self.provider.limits);
        }
        Some(file)
    }

    /// Files of a language family below `dir` (`""` for all) whose text
    /// contains every needle, in path order. Stops at the budget.
    pub(super) fn search(&self, family: &str, dir: &str, needles: &[&str]) -> Vec<String> {
        self.search_by(family, dir, |text| needles.iter().all(|n| text.contains(n)))
    }

    /// Files whose text contains any of the needles.
    fn search_any(&self, family: &str, needles: &[String]) -> Vec<String> {
        self.search_by(family, "", |text| {
            needles.iter().any(|n| text.contains(n.as_str()))
        })
    }

    fn search_by(&self, family: &str, dir: &str, matches: impl Fn(&str) -> bool) -> Vec<String> {
        let candidates: Vec<String> = self
            .paths()
            .iter()
            .filter(|path| under(path, dir))
            .filter(|path| {
                Grammar::for_path(path)
                    .and_then(Grammar::rules)
                    .is_some_and(|rules| rules.family == family)
            })
            .cloned()
            .collect();
        let mut found = Vec::new();
        for path in candidates {
            let Some(text) = self.text(&path) else {
                if !self.within_budget() {
                    break;
                }
                continue;
            };
            if matches(&text) {
                found.push(path);
            }
        }
        found
    }

    /// The directory of the nearest unit marker above `path` (`""` for the
    /// snapshot's root).
    pub(super) fn unit_root(&self, path: &str, rules: &Rules) -> String {
        let mut dir = parent(path);
        loop {
            let has_marker = rules
                .unit_markers
                .iter()
                .any(|marker| self.exists(&join(dir, marker)));
            if has_marker || dir.is_empty() {
                return dir.to_owned();
            }
            dir = parent(dir);
        }
    }

    pub(super) fn symbol(&self, found: &Found) -> CodeSymbol {
        let def = &found.file.defs[found.index];
        CodeSymbol {
            path: found.path.to_string(),
            name: def.name.clone(),
            kind: def.kind,
            span: def.lines,
            line: def.at.line,
            scope: found.file.scope_names(found.index),
        }
    }

    pub(super) fn resolution(&self, res: &Res) -> Resolution {
        match res {
            Res::Exact(found) => Resolution::Exact {
                target: self.symbol(found),
            },
            Res::NameMatch(found) => Resolution::NameMatch {
                target: self.symbol(found),
            },
            Res::Ambiguous(candidates) => Resolution::Ambiguous {
                candidates: candidates.iter().map(|found| self.symbol(found)).collect(),
            },
            Res::Unresolved => Resolution::Unresolved,
        }
    }

    /// The definition a key names; `None` when the budget ran out before
    /// its file was read.
    fn locate(&self, key: &SymbolKey) -> Result<Option<Found>, IntelligenceError> {
        let file = match self.source_file(&key.path) {
            Ok(file) => file,
            Err(IntelligenceError::Unreadable { .. }) if self.truncated.get().is_some() => {
                return Ok(None)
            }
            Err(error) => return Err(error),
        };
        let index = file
            .defs
            .iter()
            .position(|def| def.name == key.name && def.at.line == key.line)
            .ok_or_else(|| IntelligenceError::UnknownSymbol { key: key.clone() })?;
        Ok(Some(Found {
            path: Arc::from(key.path.as_str()),
            file,
            index,
        }))
    }

    fn source_file(&self, path: &str) -> Result<Arc<FileSymbols>, IntelligenceError> {
        if Grammar::for_path(path).and_then(Grammar::rules).is_none() {
            return Err(IntelligenceError::UnsupportedLanguage {
                path: path.to_owned(),
            });
        }
        let file = self.file(path);
        if let Some(error) = self.error.borrow_mut().take() {
            return Err(error.into());
        }
        file.ok_or_else(|| IntelligenceError::Unreadable {
            path: path.to_owned(),
        })
    }

    fn call(&self, path: &Arc<str>, file: &Arc<FileSymbols>, index: usize) -> Call {
        let res = self.resolve_call(path, file, index);
        self.call_resolved(path, file, index, &res)
    }

    fn call_resolved(
        &self,
        path: &Arc<str>,
        file: &Arc<FileSymbols>,
        index: usize,
        res: &Res,
    ) -> Call {
        let site = &file.calls[index];
        Call {
            caller: site.caller.map(|caller| {
                self.symbol(&Found {
                    path: path.clone(),
                    file: file.clone(),
                    index: caller,
                })
            }),
            callee: match &site.qualifier {
                Some(super::extract::Qualifier::Path(path)) => format!("{path}::{}", site.name),
                Some(super::extract::Qualifier::Receiver(receiver)) => {
                    format!("{receiver}.{}", site.name)
                }
                None => site.name.clone(),
            },
            site: location(path, site.at),
            resolution: self.resolution(res),
        }
    }

    /// What a file must contain to possibly refer to `target`: its name,
    /// or for a default export (imported under any name) its module's
    /// name as an import specifier holds it.
    fn needles(target: &Found) -> Vec<String> {
        let def = &target.file.defs[target.index];
        let mut needles = vec![def.name.clone()];
        if def.default_export {
            let file_name = target.path.rsplit('/').next().unwrap_or(&target.path);
            let stem = file_name.split('.').next().unwrap_or(file_name);
            let stem = if stem == "index" {
                parent(&target.path).rsplit('/').next().unwrap_or(stem)
            } else {
                stem
            };
            needles.push(stem.to_owned());
        }
        needles
    }

    /// Calls anywhere in the snapshot's family that may reach `target`.
    fn callers_of(&self, target: &Found) -> Vec<Call> {
        let Some(rules) = target.file.grammar.rules() else {
            return Vec::new();
        };
        let name = target.file.defs[target.index].name.clone();
        let mut out = Vec::new();
        for path in self.search_any(rules.family, &Self::needles(target)) {
            let Some(file) = self.file(&path) else {
                continue;
            };
            let path: Arc<str> = Arc::from(path.as_str());
            let names = local_names(&file, &name);
            for index in 0..file.calls.len() {
                if !names.contains(&file.calls[index].name) {
                    continue;
                }
                let res = self.resolve_call(&path, &file, index);
                if res.includes(target) {
                    out.push(self.call_resolved(&path, &file, index, &res));
                }
            }
            if !self.within_budget() {
                break;
            }
        }
        out
    }
}

fn location(path: &str, at: super::extract::Position) -> SourceLocation {
    SourceLocation {
        path: path.to_owned(),
        line: at.line,
        column: at.column,
    }
}

pub(super) fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

pub(super) fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

fn under(path: &str, dir: &str) -> bool {
    dir.is_empty()
        || path
            .strip_prefix(dir)
            .is_some_and(|rest| rest.starts_with('/'))
}

impl CodeIntelligence for EmbeddedProvider {
    fn id(&self) -> ProviderId {
        ProviderId::new(Self::ID)
    }

    fn definitions(
        &self,
        snapshot: &dyn Snapshot,
        path: &str,
        budget: &Budget,
    ) -> Outcome<CodeSymbol> {
        let ctx = Ctx::new(self, snapshot, budget);
        let file = ctx.source_file(path)?;
        let path: Arc<str> = Arc::from(path);
        let items = (0..file.defs.len())
            .map(|index| {
                ctx.symbol(&Found {
                    path: path.clone(),
                    file: file.clone(),
                    index,
                })
            })
            .collect();
        self.answer(&ctx, items)
    }

    fn references(
        &self,
        snapshot: &dyn Snapshot,
        symbol: &SymbolKey,
        budget: &Budget,
    ) -> Outcome<Reference> {
        let ctx = Ctx::new(self, snapshot, budget);
        let Some(target) = ctx.locate(symbol)? else {
            return self.answer(&ctx, Vec::new());
        };
        let Some(rules) = target.file.grammar.rules() else {
            return self.answer(&ctx, Vec::new());
        };
        let name = target.file.defs[target.index].name.clone();
        let mut items = Vec::new();
        for path in ctx.search_any(rules.family, &Ctx::needles(&target)) {
            let Some(file) = ctx.file(&path) else {
                continue;
            };
            let path: Arc<str> = Arc::from(path.as_str());
            let enclosing = |index: Option<usize>| {
                index.map(|index| {
                    ctx.symbol(&Found {
                        path: path.clone(),
                        file: file.clone(),
                        index,
                    })
                })
            };
            let names = local_names(&file, &name);
            for index in 0..file.calls.len() {
                if !names.contains(&file.calls[index].name) {
                    continue;
                }
                let res = ctx.resolve_call(&path, &file, index);
                if res.includes(&target) {
                    let call = ctx.call_resolved(&path, &file, index, &res);
                    items.push(Reference {
                        kind: ReferenceKind::Call,
                        site: call.site,
                        enclosing: call.caller,
                        resolution: call.resolution,
                    });
                }
            }
            for (index, import) in file.imports.iter().enumerate() {
                if !names.contains(&import.local) && !import_names(&import.target, &name) {
                    continue;
                }
                let res = ctx.resolve_import(&path, &file, index);
                if res.includes(&target) {
                    items.push(Reference {
                        kind: ReferenceKind::Import,
                        site: location(&path, import.at),
                        enclosing: enclosing(import.scope),
                        resolution: ctx.resolution(&res),
                    });
                }
            }
            for (range, scope) in &file.uses {
                let used = file.slice(range);
                if !names.contains(used) {
                    continue;
                }
                let res = ctx.resolve_use(&path, &file, range.start, used);
                if res.includes(&target) {
                    items.push(Reference {
                        kind: ReferenceKind::Use,
                        site: location(&path, file.position(range.start)),
                        enclosing: enclosing(*scope),
                        resolution: ctx.resolution(&res),
                    });
                }
            }
            if !ctx.within_budget() {
                break;
            }
        }
        items.sort_by(|a, b| a.site.cmp(&b.site));
        self.answer(&ctx, items)
    }

    fn outgoing_calls(
        &self,
        snapshot: &dyn Snapshot,
        symbol: &SymbolKey,
        budget: &Budget,
    ) -> Outcome<Call> {
        let ctx = Ctx::new(self, snapshot, budget);
        let Some(target) = ctx.locate(symbol)? else {
            return self.answer(&ctx, Vec::new());
        };
        let mut items = Vec::new();
        for index in 0..target.file.calls.len() {
            if target.file.calls[index].caller != Some(target.index) {
                continue;
            }
            if !ctx.within_budget() {
                break;
            }
            items.push(ctx.call(&target.path, &target.file, index));
        }
        self.answer(&ctx, items)
    }

    fn incoming_calls(
        &self,
        snapshot: &dyn Snapshot,
        symbol: &SymbolKey,
        depth: u32,
        budget: &Budget,
    ) -> Outcome<IncomingCall> {
        let ctx = Ctx::new(self, snapshot, budget);
        let Some(start) = ctx.locate(symbol)? else {
            return self.answer(&ctx, Vec::new());
        };
        let allowed = depth.min(budget.max_depth);
        let mut seen: BTreeSet<SymbolKey> = BTreeSet::from([symbol.clone()]);
        let mut level: Vec<Found> = vec![start];
        let mut items = Vec::new();
        let mut answered = 0;
        for current in 1..=allowed {
            let mut next = Vec::new();
            for target in &level {
                let key = ctx.symbol(target).key();
                for call in ctx.callers_of(target) {
                    if let Some(caller) = &call.caller {
                        if seen.insert(caller.key()) {
                            if let Ok(Some(found)) = ctx.locate(&caller.key()) {
                                next.push(found);
                            }
                        }
                    }
                    items.push(IncomingCall {
                        target: key.clone(),
                        call,
                        depth: current,
                    });
                }
                if !ctx.within_budget() {
                    break;
                }
            }
            if !ctx.within_budget() {
                break;
            }
            answered = current;
            level = next;
            if level.is_empty() {
                break;
            }
        }
        // Every level asked (or allowed) was answered and the last one's
        // callers have callers of their own: the answer stops short.
        let deeper = answered == allowed
            && ctx.truncated.get().is_none()
            && level
                .iter()
                .any(|caller| !ctx.callers_of(caller).is_empty());
        if deeper && ctx.truncated.get().is_none() {
            ctx.truncate(Truncation::DepthLimit);
        }
        self.answer(&ctx, items)
    }
}

/// The names a definition called `name` may be called by in `file`: its
/// own, and the local names of imports that may bind it (`save as
/// persist`, a default import).
fn local_names(file: &FileSymbols, name: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::from([name.to_owned()]);
    for import in &file.imports {
        let default = matches!(import.target, super::extract::ImportTarget::Default { .. });
        if default || import_names(&import.target, name) {
            names.insert(import.local.clone());
        }
    }
    names
}

/// Whether an import names `name` (rather than only binding it locally).
fn import_names(target: &super::extract::ImportTarget, name: &str) -> bool {
    use super::extract::ImportTarget;
    match target {
        ImportTarget::Item { name: imported, .. } => imported == name,
        ImportTarget::Path(path) => path.rsplit("::").next() == Some(name),
        _ => false,
    }
}
