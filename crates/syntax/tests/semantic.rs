//! Property tests for the semantic diff: generated programs, random edits,
//! and invariants checked against `git diff` as an independent oracle.

use hegel::generators as gs;
use hegel::TestCase;
use std::process::Command;
use std::time::Duration;
use vertebrae_syntax::semantic::{
    self, Budget, DeclarationChange, DeclarationDiff, LineSpan, Occurrence, Part, ScopeSegment,
    SemanticOutcome,
};

/// String values: whitespace-only differences between them are real
/// changes the diff must report.
const TEXTS: &[&str] = &["ab", "a b", "ab ", " ab", "a  b", " ", ""];
const NOTES: &[&str] = &["note", "keep this", "check later"];

#[derive(Clone, Debug)]
enum Value {
    Arithmetic {
        operand: String,
        op: char,
        literal: u32,
    },
    /// A string literal; `quote` picks among the language's quote styles.
    Text { text: String, quote: usize },
}

#[derive(Clone, Debug)]
struct Statement {
    var: String,
    value: Value,
}

#[derive(Clone, Debug)]
struct Function {
    name: String,
    /// A comment line before the function.
    note: Option<String>,
    body: Vec<Statement>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Language {
    Rust,
    TypeScript,
    JavaScript,
    Python,
    Elixir,
}

const LANGUAGES: [Language; 5] = [
    Language::Rust,
    Language::TypeScript,
    Language::JavaScript,
    Language::Python,
    Language::Elixir,
];

impl Language {
    fn path(self) -> &'static str {
        match self {
            Self::Rust => "fixture.rs",
            Self::TypeScript => "fixture.ts",
            Self::JavaScript => "fixture.js",
            Self::Python => "fixture.py",
            Self::Elixir => "lib/fixture.ex",
        }
    }

    fn quotes(self) -> &'static [char] {
        match self {
            Self::Rust => &['"'],
            Self::TypeScript | Self::JavaScript => &['"', '\'', '`'],
            Self::Python => &['"', '\''],
            // Single quotes make a charlist, a different value.
            Self::Elixir => &['"'],
        }
    }
}

/// Whitespace-only layout choices.
#[derive(Clone, Copy, Debug)]
struct Style {
    indent: usize,
    blank_lines: usize,
    spaced: bool,
    one_line: bool,
}

const PLAIN: Style = Style {
    indent: 4,
    blank_lines: 1,
    spaced: true,
    one_line: false,
};

#[derive(Clone, Debug)]
struct Program {
    functions: Vec<Function>,
    fresh: usize,
}

impl Program {
    fn fresh(&mut self, prefix: &str) -> String {
        self.fresh += 1;
        format!("{prefix}{}", self.fresh)
    }

    fn render(&self, language: Language, style: Style) -> String {
        // Python's layout is its syntax; it is never put on one line.
        // Elixir separates statements on one line with `;`, a token of
        // its own, as no formatter writes them.
        let one_line = style.one_line && !matches!(language, Language::Python | Language::Elixir);
        let pad = " ".repeat(style.indent);
        let (open, close) = if one_line { (" ", " ") } else { ("\n", "\n") };
        let indent = if one_line { "" } else { pad.as_str() };
        let separator = "\n".repeat(style.blank_lines + 1);
        let body = self
            .functions
            .iter()
            .map(|function| {
                let name = &function.name;
                let mut out = match (&function.note, language) {
                    (Some(note), Language::Python | Language::Elixir) => format!("# {note}\n"),
                    (Some(note), _) => format!("// {note}\n"),
                    (None, _) => String::new(),
                };
                out += &match language {
                    Language::Rust => format!("fn {name}(x: u32) -> u32 {{{open}"),
                    Language::TypeScript => {
                        format!("function {name}(x: number): number {{{open}")
                    }
                    Language::JavaScript => format!("function {name}(x) {{{open}"),
                    Language::Python => format!("def {name}(x):{open}"),
                    Language::Elixir => format!("def {name}(x) do{open}"),
                };
                for statement in &function.body {
                    let value = match &statement.value {
                        Value::Arithmetic {
                            operand,
                            op,
                            literal,
                        } => {
                            if style.spaced {
                                format!("{operand} {op} {literal}")
                            } else {
                                format!("{operand}{op}{literal}")
                            }
                        }
                        Value::Text { text, quote } => {
                            let quotes = language.quotes();
                            let quote = quotes[quote % quotes.len()];
                            format!("{quote}{text}{quote}")
                        }
                    };
                    let var = &statement.var;
                    out += &match language {
                        Language::Rust => format!("{indent}let {var} = {value};{open}"),
                        Language::TypeScript | Language::JavaScript => {
                            format!("{indent}const {var} = {value};{open}")
                        }
                        Language::Python | Language::Elixir => {
                            format!("{indent}{var} = {value}{open}")
                        }
                    };
                }
                let last = function.body.last().map_or("x", |s| s.var.as_str());
                out += &match language {
                    Language::Rust => format!("{indent}{last}{close}}}"),
                    Language::TypeScript | Language::JavaScript => {
                        format!("{indent}return {last};{close}}}")
                    }
                    Language::Python => format!("{indent}return {last}"),
                    Language::Elixir => format!("{indent}{last}{close}end"),
                };
                out
            })
            .collect::<Vec<_>>()
            .join(&separator)
            + "\n";
        // Elixir's functions live in a module.
        match language {
            Language::Elixir => format!("defmodule Fixture do\n{body}end\n"),
            _ => body,
        }
    }
}

fn program(tc: &TestCase) -> Program {
    let mut program = Program {
        functions: Vec::new(),
        fresh: 0,
    };
    let count = tc.draw(gs::integers::<usize>().min_value(1).max_value(6));
    for _ in 0..count {
        let name = program.fresh("f");
        let note = note(tc);
        let mut body = Vec::new();
        let statements = tc.draw(gs::integers::<usize>().min_value(0).max_value(6));
        for _ in 0..statements {
            body.push(statement(tc, &mut program, &body));
        }
        program.functions.push(Function { name, note, body });
    }
    program
}

fn note(tc: &TestCase) -> Option<String> {
    tc.draw(gs::booleans())
        .then(|| tc.draw(gs::sampled_from(NOTES.to_vec())).to_owned())
}

fn statement(tc: &TestCase, program: &mut Program, before: &[Statement]) -> Statement {
    let operands: Vec<String> = std::iter::once("x".to_string())
        .chain(before.iter().map(|s| s.var.clone()))
        .collect();
    let value = if tc.draw(gs::integers::<u8>().min_value(0).max_value(3)) == 0 {
        Value::Text {
            text: tc.draw(gs::sampled_from(TEXTS.to_vec())).to_owned(),
            quote: index(tc, 3),
        }
    } else {
        Value::Arithmetic {
            operand: tc.draw(gs::sampled_from(operands)),
            op: tc.draw(gs::sampled_from(vec!['+', '*', '-'])),
            literal: tc.draw(gs::integers::<u32>().min_value(0).max_value(99)),
        }
    };
    Statement {
        var: program.fresh("v"),
        value,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mutation {
    Insert,
    Delete,
    Rename,
    Move,
    Reformat,
    Update,
    /// Changes only whitespace inside one string literal: a real change
    /// that must never read as reformatting.
    Respace,
}

const MUTATIONS: [Mutation; 7] = [
    Mutation::Insert,
    Mutation::Delete,
    Mutation::Rename,
    Mutation::Move,
    Mutation::Reformat,
    Mutation::Update,
    Mutation::Respace,
];

fn index(tc: &TestCase, len: usize) -> usize {
    tc.draw(gs::integers::<usize>().min_value(0).max_value(len - 1))
}

/// Applies one mutation; returns the new program and style.
fn mutate(tc: &TestCase, mut p: Program, mutation: Mutation) -> (Program, Style) {
    let f = index(tc, p.functions.len());
    match mutation {
        Mutation::Insert => {
            if tc.draw(gs::booleans()) {
                let name = p.fresh("f");
                let at = tc.draw(
                    gs::integers::<usize>()
                        .min_value(0)
                        .max_value(p.functions.len()),
                );
                let note = note(tc);
                p.functions.insert(
                    at,
                    Function {
                        name,
                        note,
                        body: Vec::new(),
                    },
                );
            } else {
                let len = p.functions[f].body.len();
                let at = tc.draw(gs::integers::<usize>().min_value(0).max_value(len));
                let before = p.functions[f].body[..at].to_vec();
                let added = statement(tc, &mut p, &before);
                p.functions[f].body.insert(at, added);
            }
        }
        Mutation::Delete => {
            let len = p.functions[f].body.len();
            if len > 0 && tc.draw(gs::booleans()) {
                let at = index(tc, len);
                let removed = p.functions[f].body.remove(at);
                // Keep later uses valid by pointing them at `x`.
                for statement in &mut p.functions[f].body {
                    if let Value::Arithmetic { operand, .. } = &mut statement.value {
                        if *operand == removed.var {
                            *operand = "x".into();
                        }
                    }
                }
            } else {
                tc.assume(p.functions.len() > 1);
                p.functions.remove(f);
            }
        }
        Mutation::Rename => {
            let to = p.fresh("r");
            let len = p.functions[f].body.len();
            if len > 0 && tc.draw(gs::booleans()) {
                let at = index(tc, len);
                let from = p.functions[f].body[at].var.clone();
                for statement in &mut p.functions[f].body {
                    if statement.var == from {
                        statement.var = to.clone();
                    }
                    if let Value::Arithmetic { operand, .. } = &mut statement.value {
                        if *operand == from {
                            *operand = to.clone();
                        }
                    }
                }
            } else {
                p.functions[f].name = to;
            }
        }
        Mutation::Move => {
            tc.assume(p.functions.len() > 1);
            let function = p.functions.remove(f);
            let mut at = index(tc, p.functions.len() + 1);
            if at == f {
                at = (at + 1) % (p.functions.len() + 1);
            }
            p.functions.insert(at, function);
        }
        Mutation::Update => {
            let function = &mut p.functions[f];
            let len = function.body.len();
            let edit_note = function.note.is_some() && (len == 0 || tc.draw(gs::booleans()));
            if let (true, Some(note)) = (edit_note, function.note.as_mut()) {
                note.push_str(" more");
            } else {
                tc.assume(len > 0);
                let at = index(tc, len);
                match &mut function.body[at].value {
                    Value::Arithmetic { literal, .. } => *literal += 100,
                    Value::Text { text, .. } => text.push('z'),
                }
            }
        }
        Mutation::Respace => {
            let texts: Vec<(usize, usize)> = p
                .functions
                .iter()
                .enumerate()
                .flat_map(|(f, function)| {
                    function
                        .body
                        .iter()
                        .enumerate()
                        .filter(|(_, s)| matches!(s.value, Value::Text { .. }))
                        .map(move |(at, _)| (f, at))
                })
                .collect();
            tc.assume(!texts.is_empty());
            let (f, at) = texts[index(tc, texts.len())];
            let Value::Text { text, .. } = &mut p.functions[f].body[at].value else {
                unreachable!()
            };
            let respaced = match tc.draw(gs::integers::<u8>().min_value(0).max_value(3)) {
                0 => format!("{text} "),
                1 => format!(" {text}"),
                2 => text.replacen(' ', "  ", 1),
                _ => text.trim_end().to_owned(),
            };
            *text = if respaced == *text {
                format!("{text} ")
            } else {
                respaced
            };
        }
        Mutation::Reformat => {
            return (
                p,
                Style {
                    indent: tc.draw(gs::sampled_from(vec![2, 4, 8])),
                    blank_lines: tc.draw(gs::integers::<usize>().min_value(0).max_value(2)),
                    spaced: tc.draw(gs::booleans()),
                    one_line: tc.draw(gs::booleans()),
                },
            );
        }
    }
    (p, PLAIN)
}

fn changes(language: Language, old: &str, new: &str) -> Vec<DeclarationDiff> {
    let budget = Budget {
        time: Duration::from_secs(10),
        ..Budget::default()
    };
    match semantic::diff(language.path(), old, new, &budget) {
        SemanticOutcome::Semantic { declarations, .. } => declarations,
        SemanticOutcome::Fallback { reason } => panic!("fell back: {reason:?}\n{old}\n---\n{new}"),
    }
}

/// What a declaration reports, flattened: its change to all of it (when
/// there is one) and each part, as spans per side plus rename sites.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Fact {
    Added,
    Removed,
    Changed,
    Signature,
    Moved,
    Renamed { from: String, to: String },
}

struct Touch<'d> {
    fact: Fact,
    old: Option<LineSpan>,
    new: Option<LineSpan>,
    sites: &'d [Occurrence],
    /// What kind of code it touches.
    facts: &'d [semantic::Fact],
}

fn touches(declaration: &DeclarationDiff) -> Vec<Touch<'_>> {
    let whole = |fact, (old, new), sites, facts| Touch {
        fact,
        old,
        new,
        sites,
        facts,
    };
    let spans = declaration.change.spans();
    let mut out: Vec<Touch> = match &declaration.change {
        DeclarationChange::Added { .. } => {
            vec![whole(Fact::Added, spans, &[], &declaration.facts.items)]
        }
        DeclarationChange::Removed { .. } => {
            vec![whole(Fact::Removed, spans, &[], &declaration.facts.items)]
        }
        DeclarationChange::Moved { .. } => {
            vec![whole(Fact::Moved, spans, &[], &declaration.facts.items)]
        }
        DeclarationChange::Renamed {
            from, to, sites, ..
        } => vec![whole(
            Fact::Renamed {
                from: from.clone(),
                to: to.clone(),
            },
            spans,
            sites,
            &declaration.facts.items,
        )],
        DeclarationChange::Modified => Vec::new(),
    };
    for part in &declaration.parts {
        let (fact, sites): (Fact, &[Occurrence]) = match part {
            Part::Added { .. } => (Fact::Added, &[]),
            Part::Removed { .. } => (Fact::Removed, &[]),
            Part::Changed { .. } => (Fact::Changed, &[]),
            Part::Signature { .. } => (Fact::Signature, &[]),
            Part::Moved { .. } => (Fact::Moved, &[]),
            Part::Renamed {
                from, to, sites, ..
            } => (
                Fact::Renamed {
                    from: from.clone(),
                    to: to.clone(),
                },
                sites,
            ),
        };
        out.push(whole(fact, part.spans(), sites, &part.facts().items));
    }
    out
}

/// A declaration as seen from the other direction, without names (a
/// renamed declaration's name differs between sides): old and new swap,
/// additions become removals, renames reverse.
fn mirror(declaration: &DeclarationDiff) -> String {
    let segment = |s: &ScopeSegment| (s.kind, s.new_line, s.old_line);
    let mut touched: Vec<String> = touches(declaration)
        .into_iter()
        .map(|touch| {
            let fact = match touch.fact {
                Fact::Added => Fact::Removed,
                Fact::Removed => Fact::Added,
                Fact::Renamed { from, to } => Fact::Renamed { from: to, to: from },
                fact => fact,
            };
            let sites: Vec<(u32, u32)> = touch
                .sites
                .iter()
                .map(|site| (site.new_line, site.old_line))
                .collect();
            let mut facts: Vec<_> = touch.facts.iter().map(semantic::Fact::mirrored).collect();
            facts.sort();
            format!(
                "{fact:?} {:?} {:?} {sites:?} {facts:?}",
                touch.new, touch.old
            )
        })
        .collect();
    touched.sort();
    let scope: Vec<_> = declaration.scope.iter().map(segment).collect();
    format!(
        "{scope:?} {:?} {touched:?}",
        declaration.subject.as_ref().map(segment)
    )
}

fn unmirrored(declaration: &DeclarationDiff) -> String {
    let segment = |s: &ScopeSegment| (s.kind, s.old_line, s.new_line);
    let mut touched: Vec<String> = touches(declaration)
        .into_iter()
        .map(|touch| {
            let sites: Vec<(u32, u32)> = touch
                .sites
                .iter()
                .map(|site| (site.old_line, site.new_line))
                .collect();
            format!(
                "{:?} {:?} {:?} {sites:?} {:?}",
                touch.fact, touch.old, touch.new, touch.facts
            )
        })
        .collect();
    touched.sort();
    let scope: Vec<_> = declaration.scope.iter().map(segment).collect();
    format!(
        "{scope:?} {:?} {touched:?}",
        declaration.subject.as_ref().map(segment)
    )
}

fn sorted<T: std::fmt::Debug>(edits: impl Iterator<Item = T>) -> Vec<String> {
    let mut edits: Vec<_> = edits.map(|edit| format!("{edit:?}")).collect();
    edits.sort();
    edits
}

/// One side of a changed block: its inclusive line range (none when the
/// block only adds or only removes) and its text.
#[derive(Default)]
struct BlockSide {
    lines: Option<(u32, u32)>,
    text: Vec<String>,
}

impl BlockSide {
    fn from_header(start: u32, count: u32) -> Self {
        Self {
            lines: (count > 0).then(|| (start, start + count - 1)),
            text: Vec::new(),
        }
    }

    fn join(&mut self, other: BlockSide) {
        self.lines = match (self.lines, other.lines) {
            (Some((a, _)), Some((_, d))) => Some((a, d)),
            (one, None) | (None, one) => one,
        };
        self.text.extend(other.text);
    }

    fn overlaps(&self, span: Option<semantic::LineSpan>) -> bool {
        matches!((self.lines, span), (Some((start, end)), Some(span)) if span.overlaps(start, end))
    }

    fn contains(&self, line: u32) -> bool {
        self.lines
            .is_some_and(|(start, end)| (start..=end).contains(&line))
    }
}

/// One contiguous changed block from `git diff -U0`.
struct Block {
    old: BlockSide,
    new: BlockSide,
    /// Unchanged old lines before and after the block.
    old_before: u32,
    old_after: u32,
}

fn git_blocks(old: &str, new: &str) -> Vec<Block> {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = (dir.path().join("a"), dir.path().join("b"));
    std::fs::write(&a, old).unwrap();
    std::fs::write(&b, new).unwrap();
    let output = Command::new("git")
        .args([
            "diff",
            "--no-index",
            "--no-color",
            "--histogram",
            "-U0",
            "--",
        ])
        .arg(&a)
        .arg(&b)
        .output()
        .expect("git is available");
    let text = String::from_utf8(output.stdout).unwrap();
    let mut blocks: Vec<Block> = Vec::new();
    for line in text.lines() {
        if let Some(header) = line.strip_prefix("@@ ") {
            let range = |part: &str| -> (u32, u32) {
                let part = &part[1..];
                match part.split_once(',') {
                    Some((start, count)) => (start.parse().unwrap(), count.parse().unwrap()),
                    None => (part.parse().unwrap(), 1),
                }
            };
            let mut parts = header.split_whitespace();
            let (os, oc) = range(parts.next().unwrap());
            let (ns, nc) = range(parts.next().unwrap());
            // `-5,0` sits after old line 5.
            let (old_before, old_after) = if oc == 0 {
                (os, os + 1)
            } else {
                (os - 1, os + oc)
            };
            blocks.push(Block {
                old: BlockSide::from_header(os, oc),
                new: BlockSide::from_header(ns, nc),
                old_before,
                old_after,
            });
        } else if let Some(block) = blocks.last_mut() {
            if let Some(removed) = line.strip_prefix('-').filter(|_| !line.starts_with("---")) {
                block.old.text.push(removed.into());
            } else if let Some(added) = line.strip_prefix('+').filter(|_| !line.starts_with("+++"))
            {
                block.new.text.push(added.into());
            }
        }
    }
    merge_across_blank_lines(old, blocks)
}

/// Joins blocks separated only by blank unchanged lines: a line diff
/// anchors on blank lines, which splits one reflow into unbalanced blocks.
fn merge_across_blank_lines(old: &str, blocks: Vec<Block>) -> Vec<Block> {
    let lines: Vec<&str> = old.lines().collect();
    let blank = |from: u32, to: u32| {
        (from..to).all(|line| {
            lines
                .get(line as usize - 1)
                .is_none_or(|text| text.trim().is_empty())
        })
    };
    let mut merged: Vec<Block> = Vec::new();
    for block in blocks {
        match merged.last_mut() {
            Some(last) if blank(last.old_after, block.old_before + 1) => {
                last.old.join(block.old);
                last.new.join(block.new);
                last.old_after = block.old_after;
            }
            _ => merged.push(block),
        }
    }
    merged
}

/// Text without layout: whitespace is dropped except inside a quoted
/// string, where it is content. Generated strings hold no quotes or escapes.
fn squash(text: &str) -> String {
    let mut out = String::new();
    let mut quote = None;
    for c in text.chars() {
        match quote {
            Some(open) => {
                out.push(c);
                if c == open {
                    quote = None;
                }
            }
            None if matches!(c, '"' | '\'' | '`') => {
                out.push(c);
                quote = Some(c);
            }
            None if c.is_whitespace() => {}
            None => out.push(c),
        }
    }
    out
}

/// Every git block with a difference beyond layout overlaps a reported
/// change on one of its sides: no real change is hidden. When the diff
/// reports moves, a block may instead be the line diff's half of a
/// relocation: every line it removes is added by another block and every
/// line it adds is removed by another, so it changes no text overall.
fn assert_covers(old: &str, new: &str, changes: &[DeclarationDiff]) {
    let blocks = git_blocks(old, new);
    let touched: Vec<Touch> = changes.iter().flat_map(touches).collect();
    let moves = touched.iter().any(|touch| touch.fact == Fact::Moved);
    let lines = |side: &BlockSide| -> Vec<String> {
        side.text
            .iter()
            .map(|line| squash(line))
            .filter(|line| !line.is_empty())
            .collect()
    };
    for (index, block) in blocks.iter().enumerate() {
        let (removed, added) = (lines(&block.old), lines(&block.new));
        if removed.concat() == added.concat() {
            continue;
        }
        let elsewhere = |pick: fn(&Block) -> &BlockSide| -> Vec<String> {
            blocks
                .iter()
                .enumerate()
                .filter(|(other, _)| *other != index)
                .flat_map(|(_, other)| lines(pick(other)))
                .collect()
        };
        let relocated = |own: &[String], others: Vec<String>| {
            let mut others = others;
            own.iter().all(|line| {
                let found = others.iter().position(|other| other == line);
                found.map(|at| others.swap_remove(at)).is_some()
            })
        };
        if moves
            && relocated(&removed, elsewhere(|b| &b.new))
            && relocated(&added, elsewhere(|b| &b.old))
        {
            continue;
        }
        let covered = touched.iter().any(|touch| {
            let site_hit = touch
                .sites
                .iter()
                .any(|o| block.old.contains(o.old_line) || block.new.contains(o.new_line));
            block.old.overlaps(touch.old) || block.new.overlaps(touch.new) || site_hit
        });
        assert!(
            covered,
            "git block {:?} → {:?} is not covered\n{old}\n---\n{new}\n{changes:#?}",
            block.old.lines, block.new.lines
        );
    }
}

#[hegel::test(test_cases = 300)]
fn semantic_diff_invariants_hold_under_random_edits(tc: TestCase) {
    let language = tc.draw(gs::sampled_from(LANGUAGES.to_vec()));
    let before = program(&tc);
    let mutation = tc.draw(gs::sampled_from(MUTATIONS.to_vec()));
    let (after, style) = mutate(&tc, before.clone(), mutation);
    let old = before.render(language, PLAIN);
    let new = after.render(language, style);

    // Identity.
    assert!(changes(language, &old, &old).is_empty());
    assert!(changes(language, &new, &new).is_empty());

    let forward = changes(language, &old, &new);
    let backward = changes(language, &new, &old);

    // Symmetry: the reverse diff mirrors the forward one.
    assert_eq!(
        sorted(forward.iter().map(mirror)),
        sorted(backward.iter().map(unmirrored)),
        "{old}\n---\n{new}"
    );

    // One entry per declaration.
    for diff in [&forward, &backward] {
        let place = |d: &DeclarationDiff| {
            let segment =
                |s: &ScopeSegment| format!("{:?} {:?} {:?}", s.kind, s.old_line, s.new_line);
            let scope: Vec<_> = d.scope.iter().map(segment).collect();
            (scope, d.subject.as_ref().map(segment))
        };
        let mut places: Vec<_> = diff.iter().map(place).collect();
        places.sort();
        places.dedup();
        assert_eq!(places.len(), diff.len(), "{old}\n---\n{new}\n{diff:#?}");
    }

    // Coverage against git, both ways.
    assert_covers(&old, &new, &forward);
    assert_covers(&new, &old, &backward);

    let facts: Vec<Fact> = forward
        .iter()
        .flat_map(touches)
        .map(|touch| touch.fact)
        .collect();
    match mutation {
        Mutation::Reformat => assert!(forward.is_empty(), "{forward:#?}"),
        // One rename is one declaration reporting just that rename, which
        // changes no facts.
        Mutation::Rename => assert!(
            matches!(
                (forward.as_slice(), facts.as_slice()),
                ([_], [Fact::Renamed { .. }])
            ) && forward.iter().flat_map(touches).all(|t| t.facts.is_empty()),
            "{old}\n---\n{new}\n{forward:#?}"
        ),
        Mutation::Move => assert!(
            !facts.is_empty() && facts.iter().all(|fact| *fact == Fact::Moved),
            "{old}\n---\n{new}\n{forward:#?}"
        ),
        Mutation::Insert | Mutation::Delete | Mutation::Update | Mutation::Respace => {
            assert!(!forward.is_empty(), "{old}\n---\n{new}")
        }
    }

    // An added or removed function is one declaration, removed as a whole
    // (both ways).
    let names =
        |p: &Program| -> Vec<String> { p.functions.iter().map(|f| f.name.clone()).collect() };
    let (was, is) = (names(&before), names(&after));
    let (was, is) = match mutation {
        Mutation::Insert | Mutation::Delete => (was, is),
        _ => (Vec::new(), Vec::new()),
    };
    for (gone, kept, diff) in [(&was, &is, &forward), (&is, &was, &backward)] {
        for name in gone.iter().filter(|name| !kept.contains(name)) {
            let about: Vec<_> = diff
                .iter()
                .filter(|d| d.subject.as_ref().is_some_and(|s| &s.name == name))
                .collect();
            assert!(
                matches!(about[..], [d] if matches!(d.change, DeclarationChange::Removed { .. }) && d.parts.is_empty()),
                "{name}: {old}\n---\n{new}\n{diff:#?}"
            );
        }
    }
}

#[hegel::test(test_cases = 40)]
fn semantic_diff_is_deterministic(tc: TestCase) {
    let language = tc.draw(gs::sampled_from(LANGUAGES.to_vec()));
    let before = program(&tc);
    let (after, style) = mutate(&tc, before.clone(), Mutation::Insert);
    let (old, new) = (
        before.render(language, PLAIN),
        after.render(language, style),
    );
    assert_eq!(changes(language, &old, &new), changes(language, &old, &new));
}
