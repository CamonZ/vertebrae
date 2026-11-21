//! What one file declares, calls and imports, from its language's queries:
//! definitions from the declarations (tags) query, calls from the facts
//! query's `@call` captures, imports from the imports query. The result
//! depends only on the grammar and the text, so it is cached by content.

use super::rules::{Exports, ImportCapture, Rules};
use crate::semantic::profile::Compiled;
use crate::semantic::{facts_call_parts, facts_ignored, facts_inside, DeclarationKind, LineSpan};
use crate::Grammar;
use std::collections::HashMap;
use std::ops::Range;
use std::sync::Arc;
use std::time::Instant;
use tree_sitter::{Node, QueryCursor, StreamingIterator, Tree};

/// A 1-based line and byte column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct Position {
    pub(crate) line: u32,
    pub(crate) column: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct Def {
    pub(crate) name: String,
    pub(crate) kind: DeclarationKind,
    pub(crate) bytes: Range<usize>,
    pub(crate) lines: LineSpan,
    pub(crate) at: Position,
    /// The innermost definition containing it.
    pub(crate) container: Option<usize>,
    /// Visible to other files (always, where the language exports all).
    pub(crate) exported: bool,
    pub(crate) default_export: bool,
    /// For types and impls: the type's bare name (`Foo` for `impl<T>
    /// Display for a::Foo<T>`).
    pub(crate) type_name: Option<String>,
    /// The fewest and most arguments it takes, where the language
    /// identifies callables by arity; `None` for what is not callable.
    pub(crate) arity: Option<(u32, u32)>,
}

impl Def {
    /// Whether a call with `arity` arguments may be to it.
    pub(crate) fn takes(&self, arity: Option<u32>) -> bool {
        match (arity, self.arity) {
            (None, _) => true,
            (Some(arity), Some((min, max))) => (min..=max).contains(&arity),
            (Some(_), None) => false,
        }
    }
}

/// How a callee is reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Qualifier {
    /// `receiver.name`: the receiver's text.
    Receiver(String),
    /// `path::name`: the path's text.
    Path(String),
}

#[derive(Debug, Clone)]
pub(crate) struct CallSite {
    pub(crate) name: String,
    pub(crate) qualifier: Option<Qualifier>,
    pub(crate) byte: usize,
    pub(crate) at: Position,
    /// The innermost definition containing the call.
    pub(crate) caller: Option<usize>,
    /// Arguments passed, the piped one included, where the language
    /// identifies callables by arity.
    pub(crate) arity: Option<u32>,
}

/// What an import binds its local name to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ImportTarget {
    /// `name` from module `source` (ECMAScript, Python).
    Item { source: String, name: String },
    /// A whole path whose last segment is the item or module (Rust).
    Path(String),
    /// A module itself.
    Module { source: String },
    /// A module's default export.
    Default { source: String },
    /// Every name of a module (`source`) or path, but those `except`
    /// names (at that arity, where one is given).
    Glob {
        source: String,
        except: Vec<(String, Option<u32>)>,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct Import {
    /// The bound name; empty for globs.
    pub(crate) local: String,
    pub(crate) target: ImportTarget,
    /// The innermost definition containing it (imports in a function).
    pub(crate) scope: Option<usize>,
    pub(crate) byte: usize,
    pub(crate) at: Position,
    /// The only arity imported, where the import gives one (Elixir's
    /// `only: [save: 1]`).
    pub(crate) arity: Option<u32>,
}

/// The arity beside an imported or excluded name written as a keyword
/// key with an integer value (Elixir's `save: 1`).
fn keyword_arity(node: &Node, source: &str) -> Option<u32> {
    let value = node.parent()?.child_by_field_name("value")?;
    if value.kind() != "integer" {
        return None;
    }
    source.get(value.byte_range())?.parse().ok()
}

/// A local binding (parameter, `let`, assignment target): a name that
/// shadows definitions without being one.
#[derive(Debug, Clone)]
pub(crate) struct Local {
    pub(crate) name: String,
    pub(crate) byte: usize,
    /// The innermost definition containing it: the function it is local to.
    pub(crate) scope: Option<usize>,
}

/// One file's definitions, calls, imports, locals and other name uses.
pub(crate) struct FileSymbols {
    pub(crate) grammar: Grammar,
    pub(crate) text: Arc<str>,
    /// Sorted by start byte (then outermost first).
    pub(crate) defs: Vec<Def>,
    /// In source order.
    pub(crate) calls: Vec<CallSite>,
    pub(crate) imports: Vec<Import>,
    pub(crate) locals: Vec<Local>,
    /// Plain uses of names (not calls, imports, declarations or names
    /// reached through a value or path), as byte ranges with their
    /// innermost definition.
    pub(crate) uses: Vec<(Range<usize>, Option<usize>)>,
    /// Start byte of each line.
    line_starts: Vec<usize>,
}

impl FileSymbols {
    pub(crate) fn position(&self, byte: usize) -> Position {
        let line = self.line_starts.partition_point(|&start| start <= byte);
        let start = self.line_starts[line.saturating_sub(1)];
        Position {
            line: u32::try_from(line).unwrap_or(u32::MAX),
            column: u32::try_from(byte - start + 1).unwrap_or(u32::MAX),
        }
    }

    pub(crate) fn slice(&self, bytes: &Range<usize>) -> &str {
        self.text.get(bytes.clone()).unwrap_or_default()
    }

    /// The innermost definition whose bytes contain `byte`.
    pub(crate) fn enclosing(&self, byte: usize) -> Option<usize> {
        // Definitions nest, so the last one starting before `byte` that
        // contains it is the innermost.
        let end = self.defs.partition_point(|def| def.bytes.start <= byte);
        (0..end)
            .rev()
            .find(|&index| self.defs[index].bytes.contains(&byte))
    }

    /// Whether `inner` is `outer` or nested in it.
    pub(crate) fn within(&self, mut inner: Option<usize>, outer: usize) -> bool {
        while let Some(index) = inner {
            if index == outer {
                return true;
            }
            inner = self.defs[index].container;
        }
        false
    }

    /// A member of a type: a method, or anything declared directly in a
    /// class, interface or impl. Reached only through a receiver or path.
    pub(crate) fn is_member(&self, index: usize) -> bool {
        let def = &self.defs[index];
        def.kind == DeclarationKind::Method
            || def
                .container
                .is_some_and(|container| is_type_container(self.defs[container].kind))
    }

    /// The enclosing definitions' names, outermost first.
    pub(crate) fn scope_names(&self, index: usize) -> Vec<String> {
        let mut names = Vec::new();
        let mut next = self.defs[index].container;
        while let Some(container) = next {
            names.push(self.defs[container].name.clone());
            next = self.defs[container].container;
        }
        names.reverse();
        names
    }

    /// Bytes retained, for cache accounting.
    pub(crate) fn weight(&self) -> usize {
        let names: usize = self
            .defs
            .iter()
            .map(|def| def.name.len() + 96)
            .sum::<usize>()
            + self
                .calls
                .iter()
                .map(|call| call.name.len() + 80)
                .sum::<usize>()
            + self.imports.len() * 96
            + self.locals.len() * 48;
        self.text.len() + names + self.uses.len() * 24 + self.line_starts.len() * 8
    }
}

pub(crate) fn is_type_container(kind: DeclarationKind) -> bool {
    matches!(
        kind,
        DeclarationKind::Class | DeclarationKind::Interface | DeclarationKind::Impl
    )
}

/// `Foo` for `a::Foo<T>`, `&mut Foo` or `dyn Foo`.
pub(crate) fn bare_type_name(text: &str) -> String {
    let text = text.split('<').next().unwrap_or(text);
    let text = text
        .trim_start_matches(['&', '*'])
        .trim_start_matches("mut ")
        .trim_start_matches("dyn ")
        .trim();
    text.rsplit([':', '.'])
        .next()
        .unwrap_or(text)
        .trim()
        .to_owned()
}

/// Extracts a file; `None` when the grammar lacks queries or parsing ran
/// past `deadline`.
pub(crate) fn extract(grammar: Grammar, text: Arc<str>, deadline: Instant) -> Option<FileSymbols> {
    let compiled = grammar.compiled()?;
    let rules = grammar.rules()?;
    let tree = grammar.parse_with_deadline(&text, Some(deadline))?;
    let source = text.as_bytes();
    let mut line_starts = vec![0];
    line_starts.extend(
        source
            .iter()
            .enumerate()
            .filter(|(_, byte)| **byte == b'\n')
            .map(|(index, _)| index + 1),
    );
    let mut file = FileSymbols {
        grammar,
        text: text.clone(),
        defs: Vec::new(),
        calls: Vec::new(),
        imports: Vec::new(),
        locals: Vec::new(),
        uses: Vec::new(),
        line_starts,
    };
    let names = definitions(&mut file, &tree, compiled, rules);
    let call_names = calls(&mut file, &tree, compiled);
    let import_spans = bindings(&mut file, &tree, rules, &names);
    uses(&mut file, &tree, rules, &names, &call_names, &import_spans);
    Some(file)
}

fn definitions(
    file: &mut FileSymbols,
    tree: &Tree,
    compiled: &Compiled,
    rules: &Rules,
) -> Vec<Range<usize>> {
    let declarations = &compiled.declarations;
    let arity_rule = file.grammar.profile().and_then(|p| p.arity.as_ref());
    let source = file.text.clone();
    // By definition node: kind (most specific wins), node, name node and
    // parameters.
    type Found<'t> = (DeclarationKind, Node<'t>, Node<'t>, Option<Node<'t>>);
    let mut found: HashMap<usize, Found> = HashMap::new();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&declarations.query, tree.root_node(), source.as_bytes());
    while let Some(found_match) = matches.next() {
        let mut name = None;
        let mut parameters = None;
        let mut declaration = None;
        for capture in found_match.captures() {
            if capture.index == declarations.name {
                name = Some(capture.node);
            } else if Some(capture.index) == declarations.parameters {
                parameters = Some(capture.node);
            } else if let Some(Some(kind)) = declarations.kinds.get(capture.index as usize) {
                declaration = Some((*kind, capture.node));
            }
        }
        let (Some(name), Some((kind, node))) = (name, declaration) else {
            continue;
        };
        if kind == DeclarationKind::Import {
            continue;
        }
        let replace = found
            .get(&node.id())
            .is_none_or(|(existing, ..)| kind.precedence() < existing.precedence());
        if replace {
            found.insert(node.id(), (kind, node, name, parameters));
        }
    }
    let mut defs: Vec<(Node, DeclarationKind, Node, Option<Node>)> = found
        .into_values()
        .map(|(k, n, name, parameters)| (n, k, name, parameters))
        .collect();
    defs.sort_by_key(|(node, ..)| (node.start_byte(), std::cmp::Reverse(node.end_byte())));
    let mut stack: Vec<usize> = Vec::new();
    let mut name_spans = Vec::new();
    for (node, kind, name_node, parameters) in defs {
        while let Some(&top) = stack.last() {
            if file.defs[top].bytes.end >= node.end_byte() {
                break;
            }
            stack.pop();
        }
        let raw = source
            .get(name_node.byte_range())
            .unwrap_or_default()
            .trim_matches(|c| matches!(c, '"' | '\'' | '`'));
        let type_name = matches!(
            kind,
            DeclarationKind::Class
                | DeclarationKind::Interface
                | DeclarationKind::Impl
                | DeclarationKind::Type
        )
        .then(|| bare_type_name(raw));
        let (exported, default_export) = exported(node, &rules.exports, source.as_bytes());
        let arity = match (arity_rule, kind) {
            (Some(rule), DeclarationKind::Function | DeclarationKind::Method) => {
                Some(rule.of_parameters(parameters, source.as_bytes()))
            }
            _ => None,
        };
        let start = node.start_position();
        let end = node.end_position();
        let end_row = if end.column == 0 && end.row > start.row {
            end.row
        } else {
            end.row + 1
        };
        let container = stack.last().copied();
        // Tags queries call any function in a `declaration_list` a method,
        // an inline module's too.
        let kind = match container {
            Some(container)
                if kind == DeclarationKind::Method
                    && !is_type_container(file.defs[container].kind) =>
            {
                DeclarationKind::Function
            }
            _ => kind,
        };
        name_spans.push(name_node.byte_range());
        // A further clause of a function in the same module (same name and
        // most arguments) extends it rather than defining another.
        let clause_of = arity.and_then(|(_, max)| {
            file.defs.iter().position(|def| {
                def.container == container
                    && def.name == raw
                    && def.kind == kind
                    && def.arity.is_some_and(|(_, other)| other == max)
            })
        });
        if let Some(first) = clause_of {
            let def = &mut file.defs[first];
            def.bytes.end = def.bytes.end.max(node.end_byte());
            def.lines.end = def.lines.end.max(line(end_row));
            if let (Some((min, max)), Some((other, _))) = (arity, def.arity) {
                def.arity = Some((min.min(other), max));
            }
            stack.push(first);
            continue;
        }
        let index = file.defs.len();
        file.defs.push(Def {
            name: raw.to_owned(),
            kind,
            bytes: node.byte_range(),
            lines: LineSpan {
                start: line(start.row + 1),
                end: line(end_row),
            },
            at: point(name_node),
            container,
            exported,
            default_export,
            type_name,
            arity,
        });
        stack.push(index);
    }
    name_spans
}

fn line(row: usize) -> u32 {
    u32::try_from(row).unwrap_or(u32::MAX)
}

fn point(node: Node) -> Position {
    let point = node.start_position();
    Position {
        line: line(point.row + 1),
        column: line(point.column + 1),
    }
}

/// Whether a definition is visible to other files, and is a default export.
fn exported(node: Node, exports: &Exports, source: &[u8]) -> (bool, bool) {
    match exports {
        Exports::All => (true, false),
        Exports::Modifier(kind) => {
            let mut cursor = node.walk();
            let found = node
                .children(&mut cursor)
                .any(|child| child.kind() == *kind);
            (found, false)
        }
        Exports::Unless { field, private } => {
            let private = node
                .child_by_field_name(field)
                .and_then(|child| child.utf8_text(source).ok())
                .is_some_and(|text| private.contains(&text));
            (!private, false)
        }
        Exports::Wrapper { kind, default } => {
            let mut next = node.parent();
            while let Some(parent) = next {
                if parent.kind() == *kind {
                    let mut cursor = parent.walk();
                    let is_default = parent.children(&mut cursor).any(|child| {
                        !child.is_named() && child.utf8_text(source).ok() == Some(*default)
                    });
                    return (true, is_default);
                }
                next = parent.parent();
            }
            (false, false)
        }
    }
}

fn calls(file: &mut FileSymbols, tree: &Tree, compiled: &Compiled) -> Vec<Range<usize>> {
    let source = file.text.clone();
    let arity_rule = file.grammar.profile().and_then(|p| p.arity.as_ref());
    let mut cursor = QueryCursor::new();
    let facts = &compiled.facts;
    let mut ignored = Vec::new();
    let mut matches = cursor.matches(&facts.query, tree.root_node(), source.as_bytes());
    while let Some(found) = matches.next() {
        ignored.extend(facts_ignored(facts, found.captures()));
        for parts in facts_call_parts(facts, found.captures()) {
            let call = parts.name;
            let name = source.get(call.byte_range()).unwrap_or_default().to_owned();
            let arity = arity_rule.map(|rule| rule.of_call(parts.arguments, parts.piped));
            let qualifier = parts.qualifier.map(|(path, node)| {
                let text = compact(source.get(node.byte_range()).unwrap_or_default());
                if path {
                    Qualifier::Path(text)
                } else {
                    Qualifier::Receiver(text)
                }
            });
            file.calls.push(CallSite {
                name,
                qualifier,
                byte: call.start_byte(),
                at: point(call),
                caller: None,
                arity,
            });
        }
    }
    // Names in a head or attribute are not calls.
    ignored.sort_by_key(|range| range.start);
    file.calls.retain(|call| {
        let range = call.byte..call.byte + call.name.len();
        !facts_inside(&ignored, &range)
    });
    // Patterns overlap; a call is one call. Keep the one with a qualifier,
    // then the one that counts a piped argument (a piped call also matches
    // the plain call pattern).
    file.calls.sort_by(|a, b| {
        a.byte
            .cmp(&b.byte)
            .then(b.qualifier.is_some().cmp(&a.qualifier.is_some()))
            .then(b.arity.cmp(&a.arity))
    });
    file.calls.dedup_by_key(|call| call.byte);
    let callers: Vec<_> = file
        .calls
        .iter()
        .map(|call| file.enclosing(call.byte))
        .collect();
    for (call, caller) in file.calls.iter_mut().zip(callers) {
        call.caller = caller;
    }
    file.calls
        .iter()
        .map(|call| call.byte..call.byte + call.name.len())
        .collect()
}

/// Text with whitespace collapsed, and none around `.` and `::`
/// (`a\n  .b` → `a.b`).
fn compact(text: &str) -> String {
    let mut out = text.split_whitespace().collect::<Vec<_>>().join(" ");
    for (spaced, joined) in [(" .", "."), (". ", "."), (" ::", "::"), (":: ", "::")] {
        while out.contains(spaced) {
            out = out.replace(spaced, joined);
        }
    }
    out
}

/// Walk only pattern positions: constructor paths, explicit field labels,
/// range endpoints and macro contents do not introduce locals.
fn rust_pattern_bindings(pattern: Node<'_>, mut record: impl FnMut(Node<'_>)) {
    let mut pending = vec![pattern];
    while let Some(node) = pending.pop() {
        match node.kind() {
            "identifier" | "shorthand_field_identifier" => record(node),
            "field_pattern" => {
                if let Some(binding) = node
                    .child_by_field_name("pattern")
                    .or_else(|| node.child_by_field_name("name"))
                {
                    pending.push(binding);
                }
            }
            "tuple_pattern"
            | "tuple_struct_pattern"
            | "struct_pattern"
            | "slice_pattern"
            | "mut_pattern"
            | "ref_pattern"
            | "reference_pattern"
            | "captured_pattern"
            | "or_pattern" => {
                let constructor = node.child_by_field_name("type");
                pending.extend(
                    node.named_children(&mut node.walk())
                        .filter(|child| Some(*child) != constructor),
                );
            }
            _ => {}
        }
    }
}

/// Imports and locals; returns the spans they cover (not plain uses).
fn bindings(
    file: &mut FileSymbols,
    tree: &Tree,
    rules: &Rules,
    def_names: &[Range<usize>],
) -> Vec<Range<usize>> {
    let Some(query) = file.grammar.imports() else {
        return Vec::new();
    };
    let source = file.text.clone();
    // A keyword list's key (`only: [save: 1]`) reads `save: `.
    let text = |node: &Node| {
        let text = source.get(node.byte_range()).unwrap_or_default();
        match node.kind() {
            "keyword" => text.trim_end().trim_end_matches(':').to_owned(),
            _ => text.to_owned(),
        }
    };
    let separator = rules.modules.separator();
    let def_names: std::collections::HashSet<(usize, usize)> = def_names
        .iter()
        .map(|range| (range.start, range.end))
        .collect();
    let mut spans = Vec::new();
    let mut found: Vec<Import> = Vec::new();
    // Names left out of the glob import at a byte.
    let mut excepts: HashMap<usize, Vec<(String, Option<u32>)>> = HashMap::new();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query.query, tree.root_node(), source.as_bytes());
    while let Some(found_match) = matches.next() {
        let mut parts: HashMap<ImportCapture, Node> = HashMap::new();
        for capture in found_match.captures() {
            let role = query.captures[capture.index as usize];
            if role != ImportCapture::Ignored {
                if role != ImportCapture::RustPattern {
                    spans.push(capture.node.byte_range());
                }
                parts.insert(role, capture.node);
            }
        }
        let mut record_local = |local: Node<'_>| {
            // A declarator that is a definition binds the definition.
            if !def_names.contains(&(local.start_byte(), local.end_byte())) {
                file.locals.push(Local {
                    name: text(&local),
                    byte: local.start_byte(),
                    scope: None,
                });
            }
        };
        if let Some(&local) = parts.get(&ImportCapture::Local) {
            record_local(local);
            continue;
        }
        if let Some(&pattern) = parts.get(&ImportCapture::RustPattern) {
            rust_pattern_bindings(pattern, |local| {
                spans.push(local.byte_range());
                record_local(local);
            });
            continue;
        }
        let source_text = parts.get(&ImportCapture::Source).map(&text);
        let alias = parts.get(&ImportCapture::Alias).map(&text);
        let (anchor, local, target) = if let Some(name) = parts.get(&ImportCapture::Name) {
            let name_text = compact(&text(name));
            match source_text {
                Some(source) => {
                    let local = alias.unwrap_or_else(|| last_segment(&name_text, separator));
                    (
                        *name,
                        local,
                        ImportTarget::Item {
                            source,
                            name: name_text,
                        },
                    )
                }
                None => {
                    let path = prefixed(*name, &name_text, rules, &source);
                    let path = match &rules.modules {
                        super::rules::Modules::Crate { current, .. } => path
                            .strip_suffix(&format!("{separator}{current}"))
                            .map(str::to_owned)
                            .unwrap_or(path),
                        _ => path,
                    };
                    let local = alias.unwrap_or_else(|| last_segment(&path, separator));
                    (*name, local, ImportTarget::Path(path))
                }
            }
        } else if let Some(module) = parts.get(&ImportCapture::Module) {
            let module_text = compact(&text(module));
            match source_text {
                Some(source) => (*module, module_text, ImportTarget::Module { source }),
                None => match alias {
                    Some(alias) => (
                        *module,
                        alias,
                        ImportTarget::Module {
                            source: module_text,
                        },
                    ),
                    None => {
                        let head = module_text
                            .split(separator)
                            .next()
                            .unwrap_or_default()
                            .to_owned();
                        (*module, head.clone(), ImportTarget::Module { source: head })
                    }
                },
            }
        } else if let Some(default) = parts.get(&ImportCapture::Default) {
            let Some(source) = source_text else { continue };
            (*default, text(default), ImportTarget::Default { source })
        } else if let Some(glob) = parts.get(&ImportCapture::Glob) {
            if let Some(except) = parts.get(&ImportCapture::Except) {
                excepts
                    .entry(glob.start_byte())
                    .or_default()
                    .push((text(except), keyword_arity(except, &source)));
            }
            let source = match source_text {
                Some(source) => source,
                None => prefixed(*glob, &compact(&text(glob)), rules, &source),
            };
            let target = ImportTarget::Glob {
                source,
                except: Vec::new(),
            };
            (*glob, String::new(), target)
        } else {
            continue;
        };
        let arity = match target {
            ImportTarget::Item { .. } => keyword_arity(&anchor, &source),
            _ => None,
        };
        found.push(Import {
            local,
            target,
            scope: None,
            byte: anchor.start_byte(),
            at: point(anchor),
            arity,
        });
    }
    found.sort_by_key(|import| import.byte);
    found.dedup_by(|a, b| a.byte == b.byte && a.local == b.local && a.target == b.target);
    for import in &mut found {
        if let (ImportTarget::Glob { except, .. }, Some(names)) =
            (&mut import.target, excepts.get(&import.byte))
        {
            except.clone_from(names);
            except.sort();
            except.dedup();
        }
    }
    for import in &mut found {
        import.scope = file.enclosing(import.byte);
    }
    file.imports = found;
    let mut locals = std::mem::take(&mut file.locals);
    locals.sort_by_key(|local| local.byte);
    locals.dedup_by_key(|local| local.byte);
    for local in &mut locals {
        local.scope = file.enclosing(local.byte);
    }
    file.locals = locals;
    spans
}

fn last_segment(path: &str, separator: &str) -> String {
    path.rsplit(separator).next().unwrap_or(path).to_owned()
}

/// A path inside nested prefixed lists (`a::{b::{c}}`), joined with
/// their prefixes.
fn prefixed(node: Node, text: &str, rules: &Rules, source: &str) -> String {
    let Some((kind, field)) = rules.prefix else {
        return text.to_owned();
    };
    let separator = rules.modules.separator();
    let mut segments = vec![text.to_owned()];
    let mut next = node.parent();
    while let Some(parent) = next {
        if parent.kind() == kind {
            if let Some(prefix) = parent.child_by_field_name(field) {
                segments.push(compact(source.get(prefix.byte_range()).unwrap_or_default()));
            }
        }
        next = parent.parent();
    }
    segments.reverse();
    segments.join(separator)
}

fn uses(
    file: &mut FileSymbols,
    tree: &Tree,
    rules: &Rules,
    names: &[Range<usize>],
    calls: &[Range<usize>],
    imports: &[Range<usize>],
) {
    let Some(profile) = file.grammar.profile() else {
        return;
    };
    let mut skip: Vec<Range<usize>> = names.iter().chain(calls).chain(imports).cloned().collect();
    skip.sort_by_key(|range| range.start);
    let skipped = |range: &Range<usize>| {
        let end = skip.partition_point(|s| s.start <= range.start);
        skip[..end]
            .iter()
            .rev()
            .take(64)
            .any(|s| s.end >= range.end)
    };
    let mut cursor = tree.walk();
    let mut found = Vec::new();
    'walk: loop {
        let node = cursor.node();
        if node.child_count() == 0 && profile.identifiers.contains(&node.kind()) {
            let range = node.byte_range();
            let qualified = node.parent().is_some_and(|parent| {
                rules.qualified.iter().any(|(kind, field)| {
                    parent.kind() == *kind
                        && parent
                            .child_by_field_name(field)
                            .is_some_and(|child| child.id() == node.id())
                })
            });
            if !qualified && !skipped(&range) {
                found.push(range);
            }
        }
        if cursor.goto_first_child() || cursor.goto_next_sibling() {
            continue;
        }
        loop {
            if !cursor.goto_parent() {
                break 'walk;
            }
            if cursor.goto_next_sibling() {
                break;
            }
        }
    }
    file.uses = found
        .into_iter()
        .map(|range| {
            let enclosing = file.enclosing(range.start);
            (range, enclosing)
        })
        .collect();
}
