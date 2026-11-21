//! Property tests for semantic diff facts, against an independent oracle.
//!
//! Generated programs hold calls (from a small pool, so callees repeat),
//! effectful calls, assignments (of a literal, or of one or two calls),
//! branches and loops with nested bodies, guarded early returns and
//! throws, sometimes the same body in several functions. Each mutation
//! changes one of them, and the oracle predicts the file's whole fact set
//! from the generator's model (never from the engine's queries); the test
//! asserts equality. Each run must reach every case class (nesting,
//! repeated callees, every mutation kind and language), so a generator
//! change cannot quietly stop exercising one.

use hegel::generators as gs;
use hegel::{Hegel, Settings, TestCase};
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::time::Duration;
use vertebrae_syntax::semantic::{
    self, Budget, DeclarationDiff, EffectKind, Fact, FactChange, FactKind, SemanticOutcome,
};

#[derive(Clone, Copy, Debug, PartialEq)]
enum Language {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Elixir,
}

const LANGUAGES: [Language; 6] = [
    Language::Rust,
    Language::TypeScript,
    Language::Tsx,
    Language::JavaScript,
    Language::Python,
    Language::Elixir,
];

impl Language {
    fn path(self) -> &'static str {
        match self {
            Self::Rust => "fixture.rs",
            Self::TypeScript => "fixture.ts",
            Self::Tsx => "fixture.tsx",
            Self::JavaScript => "fixture.js",
            Self::Python => "fixture.py",
            Self::Elixir => "lib/fixture.ex",
        }
    }

    /// Statements the language has: Elixir has no early return.
    fn stmt_kinds(self) -> Vec<StmtKind> {
        STMT_KINDS
            .into_iter()
            .filter(|kind| self != Self::Elixir || *kind != StmtKind::Return)
            .collect()
    }

    /// A loop's subject as the fact names it: Elixir loops over `x` with
    /// `for`, the others while `x > 0`.
    fn loop_subject(self) -> &'static str {
        match self {
            Self::Elixir => "x",
            _ => "x > 0",
        }
    }

    fn typed(self) -> bool {
        matches!(self, Self::Rust | Self::TypeScript | Self::Tsx)
    }

    /// The effectful call [`Stmt::Effect`] renders, as the fact names it.
    fn effect(self) -> &'static str {
        match self {
            Self::Rust => "std::fs::remove_file",
            Self::Python => "os.remove",
            Self::Elixir => "File.rm",
            _ => "fs.unlinkSync",
        }
    }

    fn throw(self) -> &'static str {
        match self {
            Self::Rust => "panic",
            Self::Python | Self::Elixir => "raise",
            _ => "throw",
        }
    }

    /// The parameter type of a function, `wide` or not.
    fn param_type(self, wide: bool) -> &'static str {
        match (self, wide) {
            (Self::Rust, false) => "u32",
            (Self::Rust, true) => "u64",
            (_, false) => "number",
            (_, true) => "string",
        }
    }
}

const CALLEES: [&str; 3] = ["step", "load", "save"];

#[derive(Clone, Debug, PartialEq)]
enum Value {
    Literal(u32),
    /// `callee(x)`, or `callee(x) + callee(x)` when `twice`.
    Calls {
        callee: &'static str,
        twice: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
enum Stmt {
    Assign {
        var: String,
        value: Value,
    },
    Call {
        callee: &'static str,
    },
    Effect,
    Branch {
        bound: u32,
        body: Vec<Stmt>,
    },
    /// `while x > 0 { body }`.
    Loop {
        body: Vec<Stmt>,
    },
    /// `if x > bound { return x; }`.
    Return {
        bound: u32,
    },
    Throw,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum StmtKind {
    Assign,
    Call,
    Effect,
    Branch,
    Loop,
    Return,
    Throw,
}

const STMT_KINDS: [StmtKind; 7] = [
    StmtKind::Assign,
    StmtKind::Call,
    StmtKind::Effect,
    StmtKind::Branch,
    StmtKind::Loop,
    StmtKind::Return,
    StmtKind::Throw,
];

const MAX_DEPTH: usize = 2;

#[derive(Clone, Debug)]
struct Function {
    name: String,
    public: bool,
    wide: bool,
    body: Vec<Stmt>,
}

#[derive(Clone, Debug)]
struct Program {
    functions: Vec<Function>,
    fresh: usize,
}

#[derive(Clone, Copy, Debug)]
struct Style {
    indent: usize,
    blank_lines: usize,
}

const PLAIN: Style = Style {
    indent: 4,
    blank_lines: 1,
};

struct Render<'a> {
    language: Language,
    pad: &'a str,
}

impl Render<'_> {
    fn block(&self, out: &mut String, keyword: &str, condition: &str, body: &[Stmt], depth: usize) {
        let indent = self.pad.repeat(depth + 1);
        match self.language {
            Language::Python => {
                out.push_str(&format!("{keyword} {condition}:\n"));
                if body.is_empty() {
                    out.push_str(&format!("{indent}{}pass\n", self.pad));
                } else {
                    self.body(out, body, depth + 1);
                }
                return;
            }
            Language::Elixir => {
                let (keyword, condition) = match keyword {
                    "while" => ("for", "y <- x"),
                    _ => (keyword, condition),
                };
                out.push_str(&format!("{keyword} {condition} do\n"));
                self.body(out, body, depth + 1);
                out.push_str(&format!("{indent}end\n"));
                return;
            }
            Language::Rust => out.push_str(&format!("{keyword} {condition} {{")),
            _ => out.push_str(&format!("{keyword} ({condition}) {{")),
        }
        if !body.is_empty() {
            out.push('\n');
            self.body(out, body, depth + 1);
            out.push_str(&indent);
        }
        out.push_str("}\n");
    }

    fn body(&self, out: &mut String, body: &[Stmt], depth: usize) {
        let language = self.language;
        let indent = self.pad.repeat(depth + 1);
        for stmt in body {
            out.push_str(&indent);
            let line = match stmt {
                Stmt::Assign { var, value } => {
                    let value = match value {
                        Value::Literal(n) => format!("x + {n}"),
                        Value::Calls {
                            callee,
                            twice: true,
                        } => format!("{callee}(x) + {callee}(x)"),
                        Value::Calls { callee, .. } => format!("{callee}(x)"),
                    };
                    match language {
                        Language::Rust => format!("let {var} = {value};"),
                        Language::Python | Language::Elixir => format!("{var} = {value}"),
                        _ => format!("const {var} = {value};"),
                    }
                }
                Stmt::Call { callee } => match language {
                    Language::Python | Language::Elixir => format!("{callee}(x)"),
                    _ => format!("{callee}(x);"),
                },
                Stmt::Effect => match language {
                    Language::Python | Language::Elixir => format!("{}(x)", language.effect()),
                    _ => format!("{}(x);", language.effect()),
                },
                Stmt::Branch { bound, body } => {
                    self.block(out, "if", &format!("x > {bound}"), body, depth);
                    continue;
                }
                Stmt::Loop { body } => {
                    self.block(out, "while", "x > 0", body, depth);
                    continue;
                }
                Stmt::Return { bound } => match language {
                    Language::Elixir => unreachable!("Elixir has no early return"),
                    Language::Rust => format!("if x > {bound} {{ return x; }}"),
                    Language::Python => format!("if x > {bound}:\n{indent}{}return x", self.pad),
                    _ => format!("if (x > {bound}) return x;"),
                },
                Stmt::Throw => match language {
                    Language::Rust => "panic!(\"stop\");".to_owned(),
                    Language::Python => "raise x".to_owned(),
                    Language::Elixir => "raise \"stop\"".to_owned(),
                    _ => "throw x;".to_owned(),
                },
            };
            out.push_str(&line);
            out.push('\n');
        }
    }
}

impl Program {
    fn fresh(&mut self, prefix: &str) -> String {
        self.fresh += 1;
        format!("{prefix}{}", self.fresh)
    }

    fn render(&self, language: Language, style: Style) -> String {
        let pad = " ".repeat(style.indent);
        let render = Render {
            language,
            pad: &pad,
        };
        let separator = "\n".repeat(style.blank_lines + 1);
        let body = self
            .functions
            .iter()
            .map(|f| {
                let name = &f.name;
                let public = f.public && language != Language::Python;
                let ty = language.param_type(f.wide);
                let mut out = match language {
                    Language::Rust => {
                        let vis = if public { "pub " } else { "" };
                        format!("{vis}fn {name}(x: {ty}) -> u32 {{\n")
                    }
                    Language::JavaScript => {
                        let vis = if public { "export " } else { "" };
                        format!("{vis}function {name}(x) {{\n")
                    }
                    Language::Python => format!("def {name}(x):\n"),
                    Language::Elixir => {
                        let def = if f.public { "def" } else { "defp" };
                        format!("{def} {name}(x) do\n")
                    }
                    _ => {
                        let vis = if public { "export " } else { "" };
                        format!("{vis}function {name}(x: {ty}): number {{\n")
                    }
                };
                render.body(&mut out, &f.body, 0);
                out += &match language {
                    Language::Rust => format!("{pad}x\n}}"),
                    Language::Python => format!("{pad}return x"),
                    Language::Elixir => format!("{pad}x\nend"),
                    _ => format!("{pad}return x;\n}}"),
                };
                out
            })
            .collect::<Vec<_>>()
            .join(&separator)
            + "\n";
        match language {
            Language::Elixir => format!("defmodule Fixture do\n{body}end\n"),
            _ => body,
        }
    }
}

/// The facts a statement brings when added (or takes when removed), as
/// `kind subject` lines. Inserted code's literals and types are not
/// reported; a repeated callee is one fact.
fn brings(stmt: &Stmt, language: Language, out: &mut BTreeSet<String>) {
    match stmt {
        Stmt::Assign {
            value: Value::Calls { callee, .. },
            ..
        }
        | Stmt::Call { callee } => {
            out.insert(format!("call {callee}"));
        }
        Stmt::Assign { .. } => {}
        Stmt::Effect => {
            out.insert(format!("effect.filesystem {}", language.effect()));
        }
        Stmt::Branch { bound, body } => {
            out.insert(format!("branch x > {bound}"));
            body.iter().for_each(|s| brings(s, language, out));
        }
        Stmt::Loop { body } => {
            out.insert(format!("loop {}", language.loop_subject()));
            body.iter().for_each(|s| brings(s, language, out));
        }
        Stmt::Return { bound } => {
            out.insert(format!("branch x > {bound}"));
            out.insert("early_return return".to_owned());
        }
        Stmt::Throw => {
            out.insert(format!("throw {}", language.throw()));
        }
    }
}

fn index(tc: &TestCase, len: usize) -> usize {
    tc.draw(gs::integers::<usize>().min_value(0).max_value(len - 1))
}

fn stmt(tc: &TestCase, language: Language, p: &mut Program, kind: StmtKind, depth: usize) -> Stmt {
    let callee = || tc.draw(gs::sampled_from(CALLEES.to_vec()));
    let bound = || tc.draw(gs::integers::<u32>().min_value(1).max_value(9));
    match kind {
        StmtKind::Assign => Stmt::Assign {
            var: p.fresh("v"),
            value: if tc.draw(gs::booleans()) {
                Value::Literal(bound())
            } else {
                Value::Calls {
                    callee: callee(),
                    twice: tc.draw(gs::booleans()),
                }
            },
        },
        StmtKind::Call => Stmt::Call { callee: callee() },
        StmtKind::Effect => Stmt::Effect,
        StmtKind::Branch => Stmt::Branch {
            bound: bound(),
            body: body(tc, language, p, depth + 1),
        },
        StmtKind::Loop => Stmt::Loop {
            body: body(tc, language, p, depth + 1),
        },
        StmtKind::Return => Stmt::Return { bound: bound() },
        StmtKind::Throw => Stmt::Throw,
    }
}

fn body(tc: &TestCase, language: Language, p: &mut Program, depth: usize) -> Vec<Stmt> {
    let max = if depth >= MAX_DEPTH { 0 } else { 3 };
    let len = tc.draw(gs::integers::<usize>().min_value(0).max_value(max));
    (0..len)
        .map(|_| {
            let kind = tc.draw(gs::sampled_from(language.stmt_kinds()));
            stmt(tc, language, p, kind, depth)
        })
        .collect()
}

fn program(tc: &TestCase, language: Language) -> Program {
    let mut p = Program {
        functions: Vec::new(),
        fresh: 0,
    };
    let count = tc.draw(gs::integers::<usize>().min_value(1).max_value(3));
    for _ in 0..count {
        let name = p.fresh("f");
        // Sometimes the same body as the function before.
        let body = match p.functions.last() {
            Some(previous) if tc.draw(gs::booleans()) => previous.body.clone(),
            _ => body(tc, language, &mut p, 0),
        };
        p.functions.push(Function {
            name,
            public: tc.draw(gs::booleans()),
            wide: tc.draw(gs::booleans()),
            body,
        });
    }
    p
}

/// A block of a function: the indices of the branches and loops leading
/// to it.
type BlockPath = Vec<usize>;

fn block<'b>(body: &'b mut Vec<Stmt>, path: &[usize]) -> &'b mut Vec<Stmt> {
    match path.split_first() {
        None => body,
        Some((&i, rest)) => match &mut body[i] {
            Stmt::Branch { body, .. } | Stmt::Loop { body } => block(body, rest),
            _ => unreachable!("a path only goes through branches and loops"),
        },
    }
}

fn blocks(body: &[Stmt], path: &mut BlockPath, out: &mut Vec<BlockPath>) {
    out.push(path.clone());
    if path.len() >= MAX_DEPTH {
        return;
    }
    for (i, stmt) in body.iter().enumerate() {
        if let Stmt::Branch { body, .. } | Stmt::Loop { body } = stmt {
            path.push(i);
            blocks(body, path, out);
            path.pop();
        }
    }
}

/// Every statement of a function, as (block, index), with the statement.
fn statements(f: &Function) -> Vec<(BlockPath, usize, Stmt)> {
    let mut paths = Vec::new();
    blocks(&f.body, &mut Vec::new(), &mut paths);
    let mut body = f.body.clone();
    paths
        .into_iter()
        .flat_map(|path| {
            block(&mut body, &path)
                .iter()
                .enumerate()
                .map(|(i, s)| (path.clone(), i, s.clone()))
                .collect::<Vec<_>>()
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mutation {
    Add(StmtKind),
    Remove,
    ChangeLiteral,
    ChangeCallee,
    /// `callee(x)` ↔ `callee(x) + callee(x)`: one call more or fewer of a
    /// callee already in the statement.
    ToggleTwice,
    ChangeType,
    ToggleVisibility,
    RenameFunction,
    RenameLocal,
    Reformat,
}

fn mutations() -> Vec<Mutation> {
    STMT_KINDS
        .iter()
        .map(|&k| Mutation::Add(k))
        .chain([
            Mutation::Remove,
            Mutation::ChangeLiteral,
            Mutation::ChangeCallee,
            Mutation::ToggleTwice,
            Mutation::ChangeType,
            Mutation::ToggleVisibility,
            Mutation::RenameFunction,
            Mutation::RenameLocal,
            Mutation::Reformat,
        ])
        .collect()
}

fn mutation_class(mutation: Mutation) -> String {
    match mutation {
        Mutation::Add(kind) => format!("Add({kind:?})"),
        other => format!("{other:?}"),
    }
}

struct Mutated {
    program: Program,
    style: Style,
    /// The predicted facts, as canonical lines (see [`canonical`]).
    facts: BTreeSet<String>,
    /// Predicted facts the diff may leave out, depending on how the
    /// matcher reports the edit (see `ChangeLiteral`).
    optional: BTreeSet<String>,
    /// Case classes this case reaches.
    classes: Vec<String>,
}

/// Picks a statement of function `f` matching `want`.
fn pick(tc: &TestCase, f: &Function, want: impl Fn(&Stmt) -> bool) -> (BlockPath, usize, Stmt) {
    let found: Vec<_> = statements(f)
        .into_iter()
        .filter(|(_, _, s)| want(s))
        .collect();
    tc.assume(!found.is_empty());
    found[index(tc, found.len())].clone()
}

/// Makes sure function `f` has a statement the mutation needs, so cases
/// are not rejected: a call, an assignment of calls, a literal or local.
fn seed(tc: &TestCase, language: Language, p: &mut Program, f: usize, mutation: Mutation) {
    let kind = match mutation {
        Mutation::ChangeCallee => StmtKind::Call,
        Mutation::ToggleTwice | Mutation::ChangeLiteral | Mutation::RenameLocal => StmtKind::Assign,
        _ => return,
    };
    let fits = |s: &Stmt| match mutation {
        Mutation::ChangeCallee => matches!(s, Stmt::Call { .. }),
        Mutation::ToggleTwice => matches!(
            s,
            Stmt::Assign {
                value: Value::Calls { .. },
                ..
            }
        ),
        Mutation::ChangeLiteral => matches!(
            s,
            Stmt::Assign {
                value: Value::Literal(_),
                ..
            } | Stmt::Branch { .. }
                | Stmt::Return { .. }
        ),
        _ => matches!(s, Stmt::Assign { .. }),
    };
    if statements(&p.functions[f]).iter().any(|(_, _, s)| fits(s)) {
        return;
    }
    let mut added = stmt(tc, language, p, kind, 0);
    if let Stmt::Assign { value, .. } = &mut added {
        *value = match mutation {
            Mutation::ChangeLiteral => Value::Literal(1),
            _ => Value::Calls {
                callee: CALLEES[0],
                twice: false,
            },
        };
    }
    p.functions[f].body.push(added);
}

fn mutate(
    tc: &TestCase,
    language: Language,
    mut p: Program,
    mutation: Mutation,
    f: usize,
) -> Mutated {
    let mut facts = BTreeSet::new();
    let mut optional = BTreeSet::new();
    let mut classes = Vec::new();
    let mut style = PLAIN;
    let sign = |added: bool, lines: BTreeSet<String>| -> BTreeSet<String> {
        let mark = if added { '+' } else { '-' };
        lines.into_iter().map(|l| format!("{mark}{l}")).collect()
    };
    let mut nested = |path: &BlockPath| {
        if !path.is_empty() {
            classes.push("nested".to_owned());
        }
    };
    match mutation {
        Mutation::Add(kind) => {
            tc.assume(language.stmt_kinds().contains(&kind));
            let mut paths = Vec::new();
            blocks(&p.functions[f].body, &mut Vec::new(), &mut paths);
            let path = paths[index(tc, paths.len())].clone();
            nested(&path);
            let added = stmt(tc, language, &mut p, kind, path.len());
            let target = block(&mut p.functions[f].body, &path);
            let at = tc.draw(gs::integers::<usize>().min_value(0).max_value(target.len()));
            target.insert(at, added.clone());
            let mut brought = BTreeSet::new();
            brings(&added, language, &mut brought);
            facts = sign(true, brought);
        }
        Mutation::Remove => {
            let (path, i, _) = pick(tc, &p.functions[f], |_| true);
            nested(&path);
            let removed = block(&mut p.functions[f].body, &path).remove(i);
            let mut taken = BTreeSet::new();
            brings(&removed, language, &mut taken);
            facts = sign(false, taken);
        }
        Mutation::ChangeLiteral => {
            let (path, i, _) = pick(tc, &p.functions[f], |s| {
                matches!(
                    s,
                    Stmt::Assign {
                        value: Value::Literal(_),
                        ..
                    } | Stmt::Branch { .. }
                        | Stmt::Return { .. }
                )
            });
            nested(&path);
            match &mut block(&mut p.functions[f].body, &path)[i] {
                Stmt::Assign {
                    value: Value::Literal(n),
                    ..
                } => {
                    facts.insert(format!("~literal {n} → {}", *n + 10));
                    *n += 10;
                }
                Stmt::Branch { bound, .. } | Stmt::Return { bound } => {
                    // Among identical branches the matcher may replace the
                    // whole branch instead of editing its bound; the
                    // inserted branch's literal is then not a fact.
                    optional.insert(format!("~literal {bound} → {}", *bound + 10));
                    facts.insert(format!("~branch x > {bound} → x > {}", *bound + 10));
                    *bound += 10;
                }
                _ => unreachable!(),
            }
        }
        Mutation::ChangeCallee => {
            let (path, i, _) = pick(tc, &p.functions[f], |s| matches!(s, Stmt::Call { .. }));
            nested(&path);
            let to = tc.draw(gs::sampled_from(CALLEES.to_vec()));
            let Stmt::Call { callee } = &mut block(&mut p.functions[f].body, &path)[i] else {
                unreachable!()
            };
            tc.assume(*callee != to);
            facts.insert(format!("-call {callee}"));
            facts.insert(format!("+call {to}"));
            *callee = to;
        }
        Mutation::ToggleTwice => {
            let (path, i, _) = pick(tc, &p.functions[f], |s| {
                matches!(
                    s,
                    Stmt::Assign {
                        value: Value::Calls { .. },
                        ..
                    }
                )
            });
            nested(&path);
            let Stmt::Assign {
                value: Value::Calls { callee, twice },
                ..
            } = &mut block(&mut p.functions[f].body, &path)[i]
            else {
                unreachable!()
            };
            let mark = if *twice { '-' } else { '+' };
            facts.insert(format!("{mark}call {callee}"));
            *twice = !*twice;
            classes.push("repeated_in_statement".to_owned());
        }
        Mutation::ChangeType => {
            tc.assume(language.typed());
            let function = &mut p.functions[f];
            let (from, to) = (
                language.param_type(function.wide),
                language.param_type(!function.wide),
            );
            facts.insert(format!("~type_annotation {from} → {to}"));
            if function.public {
                facts.insert(format!("~signature (x: {from}) → (x: {to})"));
            }
            function.wide = !function.wide;
        }
        Mutation::ToggleVisibility => {
            tc.assume(language != Language::Python);
            let function = &mut p.functions[f];
            function.public = !function.public;
            let mut lines = BTreeSet::new();
            if language == Language::Elixir {
                // `def` and `defp` are both visibilities; as with Rust's
                // `pub`, only that token changes.
                let (from, to) = if function.public {
                    ("defp", "def")
                } else {
                    ("def", "defp")
                };
                facts.insert(format!("~visibility {from} → {to}"));
            } else if language == Language::Rust {
                lines.insert("visibility pub".to_owned());
            } else {
                // `export` wraps the function, exposing its signature.
                lines.insert("visibility export".to_owned());
                if language == Language::JavaScript {
                    lines.insert("signature (x)".to_owned());
                } else {
                    let ty = language.param_type(function.wide);
                    lines.insert(format!("signature (x: {ty})"));
                    lines.insert("signature number".to_owned());
                }
            }
            facts.extend(sign(function.public, lines));
        }
        Mutation::RenameFunction => p.functions[f].name = p.fresh("r"),
        Mutation::RenameLocal => {
            let (path, i, _) = pick(tc, &p.functions[f], |s| matches!(s, Stmt::Assign { .. }));
            let to = p.fresh("r");
            if let Stmt::Assign { var, .. } = &mut block(&mut p.functions[f].body, &path)[i] {
                *var = to;
            }
        }
        Mutation::Reformat => {
            style = Style {
                indent: tc.draw(gs::sampled_from(vec![2, 4, 8])),
                blank_lines: tc.draw(gs::integers::<usize>().min_value(0).max_value(2)),
            };
        }
    }
    let mut callees = Vec::new();
    collect_callees(&p.functions[f].body, &mut callees);
    callees.sort();
    if callees.windows(2).any(|w| w[0] == w[1]) {
        classes.push("repeated_callee".to_owned());
    }
    let bodies: Vec<_> = p.functions.iter().map(|f| &f.body).collect();
    if bodies
        .iter()
        .enumerate()
        .any(|(i, b)| !b.is_empty() && bodies[..i].contains(b))
    {
        classes.push("same_body_twice".to_owned());
    }
    Mutated {
        program: p,
        style,
        facts,
        optional,
        classes,
    }
}

fn collect_callees(body: &[Stmt], out: &mut Vec<&'static str>) {
    for stmt in body {
        match stmt {
            Stmt::Call { callee }
            | Stmt::Assign {
                value: Value::Calls { callee, .. },
                ..
            } => out.push(callee),
            Stmt::Branch { body, .. } | Stmt::Loop { body } => collect_callees(body, out),
            _ => {}
        }
    }
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

/// Every fact a declaration reports, for its change and each part.
fn facts(declaration: &DeclarationDiff) -> impl Iterator<Item = &Fact> {
    declaration.facts.items.iter().chain(
        declaration
            .parts
            .iter()
            .flat_map(|part| &part.facts().items),
    )
}

fn word<T: serde::Serialize>(value: T) -> String {
    match serde_json::to_value(value).unwrap() {
        serde_json::Value::String(s) => s,
        serde_json::Value::Object(o) => o["type"].as_str().unwrap().to_owned(),
        other => panic!("{other}"),
    }
}

fn kind_word(kind: FactKind) -> String {
    match kind {
        FactKind::Effect { effect } => format!("effect.{}", word(effect)),
        _ => word(kind),
    }
}

/// A file's facts as a set of lines: `+kind subject`, `-kind subject` or
/// `~kind from → to`, net over the file: where the grammar or matcher
/// replaces a node rather than editing it, two changes report its facts,
/// so the same fact removed and added cancels, and a lone removal and
/// addition of one pairing kind read as one replacement.
fn canonical<'f>(facts: impl Iterator<Item = &'f Fact>) -> BTreeSet<String> {
    let mut removed: BTreeSet<(String, String)> = BTreeSet::new();
    let mut added: BTreeSet<(String, String)> = BTreeSet::new();
    let mut out = BTreeSet::new();
    for fact in facts {
        let kind = kind_word(fact.kind);
        match &fact.change {
            FactChange::Added { subject } => {
                added.insert((kind, subject.clone()));
            }
            FactChange::Removed { subject } => {
                removed.insert((kind, subject.clone()));
            }
            FactChange::Changed { from, to } => {
                out.insert(format!("~{kind} {from} → {to}"));
            }
            FactChange::Inside => {
                out.insert(format!("@{kind}"));
            }
        }
    }
    // The same fact removed by one change and added by another (a node the
    // matcher replaced rather than edited) is no difference for the file.
    let both: BTreeSet<_> = removed.intersection(&added).cloned().collect();
    removed.retain(|fact| !both.contains(fact));
    added.retain(|fact| !both.contains(fact));
    for kind in [
        "type_annotation",
        "literal",
        "signature",
        "branch",
        "loop",
        "match_arm",
        "visibility",
        "error_type",
    ] {
        let r: Vec<_> = removed.iter().filter(|(k, _)| k == kind).cloned().collect();
        let a: Vec<_> = added.iter().filter(|(k, _)| k == kind).cloned().collect();
        if let ([(_, from)], [(_, to)]) = (r.as_slice(), a.as_slice()) {
            out.insert(format!("~{kind} {from} → {to}"));
            removed.retain(|(k, _)| k != kind);
            added.retain(|(k, _)| k != kind);
        }
    }
    out.extend(removed.into_iter().map(|(k, s)| format!("-{k} {s}")));
    out.extend(added.into_iter().map(|(k, s)| format!("+{k} {s}")));
    out
}

/// One generated case: the language, programs before and after, and the
/// mutation.
struct Case {
    language: Language,
    mutation: Mutation,
    old: String,
    new: String,
    mutated: Mutated,
}

fn draw_case(tc: &TestCase) -> Case {
    let language = tc.draw(gs::sampled_from(LANGUAGES.to_vec()));
    let mut before = program(tc, language);
    let mutation = tc.draw(gs::sampled_from(mutations()));
    let f = index(tc, before.functions.len());
    seed(tc, language, &mut before, f, mutation);
    let mutated = mutate(tc, language, before.clone(), mutation, f);
    Case {
        language,
        mutation,
        old: before.render(language, PLAIN),
        new: mutated.program.render(language, mutated.style),
        mutated,
    }
}

/// Runs `test` as a Hegel property over drawn cases, then checks every
/// case class was reached at least once.
fn run(cases: u64, test: impl Fn(&Case)) {
    let reached = RefCell::new(BTreeSet::new());
    Hegel::new(|tc: TestCase| {
        let case = draw_case(&tc);
        test(&case);
        let mut reached = reached.borrow_mut();
        reached.insert(format!("{:?}", case.language));
        reached.insert(mutation_class(case.mutation));
        reached.extend(case.mutated.classes.iter().cloned());
    })
    .settings(Settings::new().test_cases(cases))
    .run();
    let reached = reached.into_inner();
    let mut wanted: Vec<String> = LANGUAGES.iter().map(|l| format!("{l:?}")).collect();
    wanted.extend(mutations().into_iter().map(mutation_class));
    wanted.extend(
        [
            "nested",
            "repeated_callee",
            "repeated_in_statement",
            "same_body_twice",
        ]
        .map(String::from),
    );
    let missing: Vec<_> = wanted.iter().filter(|w| !reached.contains(*w)).collect();
    assert!(missing.is_empty(), "never reached: {missing:?}");
}

#[test]
fn facts_match_the_oracle_for_every_mutation() {
    run(500, |case| {
        let forward = changes(case.language, &case.old, &case.new);
        let found = canonical(forward.iter().flat_map(facts));
        let required = &case.mutated.facts;
        let allowed: BTreeSet<String> = required.union(&case.mutated.optional).cloned().collect();
        assert!(
            found.is_superset(required) && found.is_subset(&allowed),
            "{found:?} is not {required:?} (optionally {:?})\n{:?} in {:?}\n{}\n---\n{}\n{forward:#?}",
            case.mutated.optional,
            case.mutation,
            case.language,
            case.old,
            case.new
        );
    });
}

#[test]
fn facts_mirror_and_are_deterministic() {
    run(300, |case| {
        let forward = changes(case.language, &case.old, &case.new);
        let backward = changes(case.language, &case.new, &case.old);
        let lines = |diff: &[DeclarationDiff], mirror: bool| {
            let mut out: Vec<String> = diff
                .iter()
                .flat_map(|d| std::iter::once(&d.facts).chain(d.parts.iter().map(|p| p.facts())))
                .map(|f| format!("{:?}", if mirror { f.mirrored() } else { f.clone() }))
                .collect();
            out.sort();
            out
        };
        assert_eq!(
            lines(&forward, true),
            lines(&backward, false),
            "{}\n---\n{}",
            case.old,
            case.new
        );
        assert_eq!(forward, changes(case.language, &case.old, &case.new));
    });
}

#[test]
fn the_oracle_names_effects_as_the_engine_does() {
    assert_eq!(
        kind_word(FactKind::Effect {
            effect: EffectKind::Filesystem
        }),
        "effect.filesystem"
    );
}
