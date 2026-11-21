//! Property tests for code intelligence, against an independent oracle.
//!
//! Generated programs are several modules of top-level functions drawn
//! from a small name pool (so names repeat within and across modules),
//! some exported, some holding a nested function, each calling names from
//! the pool or a name nothing defines. Modules import names from each
//! other, sometimes ones the source module lacks or holds twice. The
//! oracle predicts every call's resolution from the generator's model and
//! the language-neutral binding rules (never from the provider's queries):
//!
//! - bindings of a name in a function: its nested function of that name,
//!   the module's top-level functions of that name, and the module's
//!   import of it;
//! - one binding to one definition is exact; one import binding follows to
//!   the source module's definitions (none: unresolved, several:
//!   ambiguous); several bindings are ambiguous with every candidate,
//!   innermost first;
//! - without bindings, exported functions of that name in other modules:
//!   one is a name match, several ambiguous, none unresolved.
//!
//! The tests check the provider against the oracle, that every call is
//! reported, and that incoming and outgoing calls agree. Each run must
//! reach every resolution class and language, so a generator change
//! cannot quietly stop exercising one.

use hegel::generators as gs;
use hegel::{Hegel, Settings, TestCase};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use vertebrae_syntax::intelligence::{
    Budget, Call, CodeIntelligence, EmbeddedProvider, MemorySnapshot, Resolution, SymbolKey,
};

#[derive(Clone, Copy, Debug, PartialEq)]
enum Language {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
}

const LANGUAGES: [Language; 5] = [
    Language::Rust,
    Language::TypeScript,
    Language::Tsx,
    Language::JavaScript,
    Language::Python,
];

/// Defined names; `omega` is called but never defined; `aliased` is only
/// ever a local name for an import (`alpha as aliased`).
const NAMES: [&str; 4] = ["alpha", "beta", "gamma", "delta"];
const UNDEFINED: &str = "omega";
const ALIAS: &str = "aliased";
/// The imported name of a default import (ECMAScript only).
const DEFAULT: &str = "default";

#[derive(Clone, Debug)]
struct Function {
    name: &'static str,
    exported: bool,
    /// A nested function's name and calls.
    nested: Option<(&'static str, Vec<&'static str>)>,
    /// A parameter: a local binding that shadows definitions.
    param: Option<&'static str>,
    calls: Vec<&'static str>,
}

impl Function {
    fn nested_name(&self) -> Option<&'static str> {
        self.nested.as_ref().map(|(name, _)| *name)
    }

    /// The calls of the function or of its nested one.
    fn calls_of(&self, nested: bool) -> &[&'static str] {
        match (&self.nested, nested) {
            (Some((_, calls)), true) => calls,
            _ => &self.calls,
        }
    }
}

#[derive(Clone, Debug)]
struct Module {
    functions: Vec<Function>,
    /// Imports: the local name, the imported name ([`DEFAULT`] for a
    /// default import) and its module.
    imports: Vec<(&'static str, &'static str, usize)>,
    /// The function exported as the module's default (ECMAScript only).
    default: Option<usize>,
}

#[derive(Clone, Debug)]
struct Program {
    modules: Vec<Module>,
}

/// A definition: module, function, and whether it is the nested one.
type Def = (usize, usize, bool);

/// The oracle's resolution, with candidates as definitions.
#[derive(Clone, Debug, PartialEq)]
enum Expected {
    Exact(Def),
    NameMatch(Def),
    Ambiguous(Vec<Def>),
    Unresolved,
}

fn draw_program(tc: &TestCase, language: Language) -> Program {
    let ecmascript = !matches!(language, Language::Rust | Language::Python);
    let count = tc.draw(gs::integers::<usize>().min_value(2).max_value(4));
    let name = || tc.draw(gs::sampled_from(NAMES.to_vec()));
    let calls = |max: usize| -> Vec<&'static str> {
        (0..tc.draw(gs::integers::<usize>().min_value(0).max_value(max)))
            .map(
                |_| match tc.draw(gs::integers::<u8>().min_value(0).max_value(9)) {
                    0 => UNDEFINED,
                    1 => ALIAS,
                    _ => name(),
                },
            )
            .collect()
    };
    let mut modules: Vec<Module> = (0..count)
        .map(|_| {
            let functions = (0..tc.draw(gs::integers::<usize>().min_value(1).max_value(3)))
                .map(|_| Function {
                    name: name(),
                    exported: tc.draw(gs::booleans()),
                    nested: tc.draw(gs::booleans()).then(|| (name(), calls(2))),
                    param: (tc.draw(gs::integers::<u8>().min_value(0).max_value(1)) == 0)
                        .then(name),
                    calls: calls(3),
                })
                .collect::<Vec<_>>();
            let default = (ecmascript && tc.draw(gs::booleans())).then(|| {
                tc.draw(
                    gs::integers::<usize>()
                        .min_value(0)
                        .max_value(functions.len() - 1),
                )
            });
            Module {
                functions,
                imports: Vec::new(),
                default,
            }
        })
        .collect();
    for (index, module) in modules.iter_mut().enumerate() {
        for _ in 0..tc.draw(gs::integers::<usize>().min_value(0).max_value(3)) {
            let mut imported = name();
            let local = if tc.draw(gs::booleans()) {
                ALIAS
            } else {
                imported
            };
            if local == ALIAS && ecmascript && tc.draw(gs::booleans()) {
                imported = DEFAULT;
            }
            // Any module but this one.
            let from = (index + tc.draw(gs::integers::<usize>().min_value(1).max_value(count - 1)))
                % count;
            let taken = module.imports.iter().any(|(l, ..)| *l == local);
            if from != index && !taken {
                module.imports.push((local, imported, from));
            }
        }
    }
    Program { modules }
}

/// Rendered files, and each definition's path and name line.
struct Rendered {
    snapshot: MemorySnapshot,
    lines: BTreeMap<Def, (String, u32)>,
}

impl Language {
    fn module_path(self, index: usize) -> String {
        match self {
            Self::Rust => format!("src/m{index}.rs"),
            Self::TypeScript => format!("m{index}.ts"),
            Self::Tsx => format!("m{index}.tsx"),
            Self::JavaScript => format!("m{index}.js"),
            Self::Python => format!("m{index}.py"),
        }
    }

    /// Python exports every top-level function; a default export is
    /// exported.
    fn exported(self, module: &Module, f: usize) -> bool {
        self == Self::Python || module.functions[f].exported || module.default == Some(f)
    }
}

fn render(language: Language, program: &Program) -> Rendered {
    let mut snapshot = MemorySnapshot::new();
    let mut lines = BTreeMap::new();
    match language {
        Language::Rust => {
            snapshot.insert("Cargo.toml", "[package]\nname = \"generated\"\n");
            let mods: String = (0..program.modules.len())
                .map(|i| format!("mod m{i};\n"))
                .collect();
            snapshot.insert("src/lib.rs", mods);
        }
        Language::Python => snapshot.insert("pyproject.toml", ""),
        _ => snapshot.insert("package.json", "{}"),
    }
    for (m, module) in program.modules.iter().enumerate() {
        let path = language.module_path(m);
        let mut out: Vec<String> = Vec::new();
        for (local, name, from) in &module.imports {
            let alias = if local == name {
                String::new()
            } else {
                format!(" as {local}")
            };
            out.push(match language {
                _ if *name == DEFAULT => format!("import {local} from './m{from}';"),
                Language::Rust => format!("use crate::m{from}::{name}{alias};"),
                Language::Python => format!("from m{from} import {name}{alias}"),
                _ => format!("import {{ {name}{alias} }} from './m{from}';"),
            });
        }
        for (f, function) in module.functions.iter().enumerate() {
            out.push(String::new());
            let line = |out: &Vec<String>| u32::try_from(out.len() + 1).unwrap();
            lines.insert((m, f, false), (path.clone(), line(&out)));
            let name = function.name;
            let export = function.exported;
            let param = match (function.param, language) {
                (None, _) => String::new(),
                (Some(p), Language::Rust) => format!("{p}: fn()"),
                (Some(p), Language::TypeScript | Language::Tsx) => format!("{p}: () => void"),
                (Some(p), _) => p.to_owned(),
            };
            out.push(match language {
                Language::Rust if export => format!("pub fn {name}({param}) {{"),
                Language::Rust => format!("fn {name}({param}) {{"),
                Language::Python => format!("def {name}({param}):"),
                _ if module.default == Some(f) => {
                    format!("export default function {name}({param}) {{")
                }
                _ if export => format!("export function {name}({param}) {{"),
                _ => format!("function {name}({param}) {{"),
            });
            let pad = if language == Language::Python {
                "    "
            } else {
                "  "
            };
            if let Some((nested, calls)) = &function.nested {
                lines.insert((m, f, true), (path.clone(), line(&out)));
                out.push(match language {
                    Language::Rust => format!("{pad}fn {nested}() {{"),
                    Language::Python => format!("{pad}def {nested}():"),
                    _ => format!("{pad}function {nested}() {{"),
                });
                for call in calls {
                    out.push(match language {
                        Language::Python => format!("{pad}{pad}{call}()"),
                        _ => format!("{pad}{pad}{call}();"),
                    });
                }
                match language {
                    Language::Python if calls.is_empty() => out.push(format!("{pad}{pad}pass")),
                    Language::Python => {}
                    _ => out.push(format!("{pad}}}")),
                }
            }
            for call in &function.calls {
                out.push(match language {
                    Language::Python => format!("{pad}{call}()"),
                    _ => format!("{pad}{call}();"),
                });
            }
            match language {
                Language::Python if function.nested.is_none() && function.calls.is_empty() => {
                    out.push(format!("{pad}pass"));
                }
                Language::Python => {}
                _ => out.push("}".to_owned()),
            }
        }
        out.push(String::new());
        snapshot.insert(path, out.join("\n"));
    }
    Rendered { snapshot, lines }
}

/// The oracle: a call to `name` in function `f` of module `m`, or in its
/// nested function, which sees the same bindings (itself included), and
/// the function's parameter except in Rust, whose nested `fn` items do
/// not capture.
fn expected(
    language: Language,
    program: &Program,
    m: usize,
    f: usize,
    nested: bool,
    name: &str,
) -> Expected {
    let module = &program.modules[m];
    let function = &module.functions[f];
    let mut bindings: Vec<Vec<Def>> = Vec::new();
    if function.nested_name() == Some(name) {
        bindings.push(vec![(m, f, true)]);
    }
    // A parameter binds no definition.
    if function.param == Some(name) && !(nested && language == Language::Rust) {
        bindings.push(Vec::new());
    }
    let top_level = |module: usize, name: &str| -> Vec<Def> {
        program.modules[module]
            .functions
            .iter()
            .enumerate()
            .filter(|(_, g)| g.name == name)
            .map(|(g, _)| (module, g, false))
            .collect()
    };
    bindings.extend(top_level(m, name).into_iter().map(|def| vec![def]));
    if let Some((_, imported, from)) = module.imports.iter().find(|(l, ..)| *l == name) {
        bindings.push(if *imported == DEFAULT {
            program.modules[*from]
                .default
                .map(|g| (*from, g, false))
                .into_iter()
                .collect()
        } else {
            top_level(*from, imported)
        });
    }
    match bindings.len() {
        0 => {
            let found: Vec<Def> = (0..program.modules.len())
                .filter(|other| *other != m)
                .flat_map(|other| top_level(other, name))
                .filter(|(o, g, _)| language.exported(&program.modules[*o], *g))
                .collect();
            match found.len() {
                0 => Expected::Unresolved,
                1 => Expected::NameMatch(found[0]),
                _ => Expected::Ambiguous(found),
            }
        }
        1 => {
            let targets = bindings.remove(0);
            match targets.len() {
                0 => Expected::Unresolved,
                1 => Expected::Exact(targets[0]),
                _ => Expected::Ambiguous(targets),
            }
        }
        _ => {
            let candidates: Vec<Def> = bindings.into_iter().flatten().collect();
            if candidates.is_empty() {
                Expected::Unresolved
            } else {
                Expected::Ambiguous(candidates)
            }
        }
    }
}

/// The class of an expectation, for coverage.
fn class(
    expected: &Expected,
    language: Language,
    program: &Program,
    (m, f, nested): Def,
    name: &str,
) -> &'static str {
    let module = &program.modules[m];
    let imported = module.imports.iter().any(|(l, ..)| *l == name);
    let default = module
        .imports
        .iter()
        .any(|(l, i, _)| *l == name && *i == DEFAULT);
    let param = module.functions[f].param == Some(name);
    match expected {
        _ if param && nested && language == Language::Rust => "param_not_captured",
        Expected::Ambiguous(_) if param => "param_shadows_definition",
        Expected::Unresolved if param => "param_only",
        Expected::Exact(_) if default => "exact_default",
        Expected::Exact(_) if name == ALIAS => "exact_alias",
        Expected::Exact((_, _, true)) => "exact_nested",
        Expected::Exact((o, ..)) if *o == m => "exact_local",
        Expected::Exact(_) => "exact_import",
        Expected::NameMatch(_) => "name_match",
        Expected::Ambiguous(_) if module.functions[f].nested_name() == Some(name) => {
            "ambiguous_shadowed"
        }
        Expected::Ambiguous(_) if imported && module.functions.iter().any(|g| g.name == name) => {
            "ambiguous_import_shadowed"
        }
        Expected::Ambiguous(c) if c.iter().all(|(o, ..)| *o == m) => "ambiguous_duplicate",
        Expected::Ambiguous(_) if imported => "ambiguous_import_targets",
        Expected::Ambiguous(_) => "ambiguous_name_match",
        Expected::Unresolved if name == UNDEFINED => "unresolved_undefined",
        Expected::Unresolved => "unresolved_other",
    }
}

struct Case {
    language: Language,
    program: Program,
    rendered: Rendered,
}

impl Case {
    fn describe(&self) -> String {
        let mut out = format!("{:?}\n", self.language);
        for (m, _) in self.program.modules.iter().enumerate() {
            let path = self.language.module_path(m);
            out.push_str(&format!(
                "--- {path}\n{}\n",
                self.rendered.snapshot_text(&path)
            ));
        }
        out
    }

    fn key(&self, def: Def) -> SymbolKey {
        let (path, line) = self.rendered.lines[&def].clone();
        let function = &self.program.modules[def.0].functions[def.1];
        let name = if def.2 {
            function.nested_name().unwrap()
        } else {
            function.name
        };
        SymbolKey {
            path,
            name: name.to_owned(),
            line,
        }
    }

    fn def_at(&self, path: &str, line: u32) -> Option<Def> {
        self.rendered
            .lines
            .iter()
            .find(|(_, (p, l))| p == path && *l == line)
            .map(|(def, _)| *def)
    }

    /// The provider's resolution in the oracle's terms.
    fn observed(&self, resolution: &Resolution) -> Expected {
        let def = |target: &vertebrae_syntax::intelligence::CodeSymbol| {
            self.def_at(&target.path, target.line)
                .unwrap_or_else(|| panic!("unknown target {target:?}\n{}", self.describe()))
        };
        match resolution {
            Resolution::Exact { target } => Expected::Exact(def(target)),
            Resolution::NameMatch { target } => Expected::NameMatch(def(target)),
            Resolution::Ambiguous { candidates } => {
                Expected::Ambiguous(candidates.iter().map(def).collect())
            }
            Resolution::Unresolved => Expected::Unresolved,
        }
    }
}

impl Rendered {
    fn snapshot_text(&self, path: &str) -> String {
        use vertebrae_syntax::intelligence::Snapshot;
        self.snapshot
            .read(path, usize::MAX)
            .unwrap()
            .unwrap_or_default()
    }
}

fn draw_case(tc: &TestCase) -> Case {
    let language = tc.draw(gs::sampled_from(LANGUAGES.to_vec()));
    let program = draw_program(tc, language);
    let rendered = render(language, &program);
    Case {
        language,
        program,
        rendered,
    }
}

/// Every function definition, nested ones included.
fn functions(program: &Program) -> Vec<Def> {
    let mut out = Vec::new();
    for (m, module) in program.modules.iter().enumerate() {
        for (f, function) in module.functions.iter().enumerate() {
            out.push((m, f, false));
            if function.nested.is_some() {
                out.push((m, f, true));
            }
        }
    }
    out
}

fn outgoing(provider: &EmbeddedProvider, case: &Case, def: Def) -> Vec<Call> {
    let answer = provider
        .outgoing_calls(&case.rendered.snapshot, &case.key(def), &Budget::default())
        .unwrap_or_else(|error| panic!("{error}\n{}", case.describe()));
    assert_eq!(answer.truncated, None, "{}", case.describe());
    answer.items
}

/// Runs `test` as a Hegel property, then checks every class was reached.
fn run(cases: u64, test: impl Fn(&Case, &mut BTreeSet<&'static str>)) {
    let reached = RefCell::new(BTreeSet::new());
    Hegel::new(|tc: TestCase| {
        let case = draw_case(&tc);
        let mut classes = BTreeSet::new();
        test(&case, &mut classes);
        let mut reached = reached.borrow_mut();
        reached.insert(match case.language {
            Language::Rust => "Rust",
            Language::TypeScript => "TypeScript",
            Language::Tsx => "Tsx",
            Language::JavaScript => "JavaScript",
            Language::Python => "Python",
        });
        reached.extend(classes);
    })
    .settings(Settings::new().test_cases(cases))
    .run();
    let reached = reached.into_inner();
    let wanted = [
        "Rust",
        "TypeScript",
        "Tsx",
        "JavaScript",
        "Python",
        "exact_local",
        "exact_nested",
        "exact_import",
        "name_match",
        "ambiguous_shadowed",
        "ambiguous_import_shadowed",
        "ambiguous_duplicate",
        "ambiguous_import_targets",
        "ambiguous_name_match",
        "unresolved_undefined",
        "unresolved_other",
        "calls_in_nested",
        "exact_alias",
        "exact_default",
        "param_shadows_definition",
        "param_only",
        "param_not_captured",
    ];
    let missing: Vec<_> = wanted.iter().filter(|w| !reached.contains(*w)).collect();
    assert!(missing.is_empty(), "never reached: {missing:?}");
}

#[test]
fn calls_resolve_as_the_oracle_predicts() {
    run(300, |case, classes| {
        let provider = EmbeddedProvider::new();
        for (m, f, nested) in functions(&case.program) {
            let function = &case.program.modules[m].functions[f];
            let calls = outgoing(&provider, case, (m, f, nested));
            // Every call is reported, unresolved ones included, and only
            // the definition's own (not its nested function's).
            let callees: Vec<&str> = calls.iter().map(|c| c.callee.as_str()).collect();
            assert_eq!(callees, function.calls_of(nested), "{}", case.describe());
            if nested && !calls.is_empty() {
                classes.insert("calls_in_nested");
            }
            {
                for (call, name) in calls.iter().zip(function.calls_of(nested)) {
                    let want = expected(case.language, &case.program, m, f, nested, name);
                    classes.insert(class(
                        &want,
                        case.language,
                        &case.program,
                        (m, f, nested),
                        name,
                    ));
                    let got = case.observed(&call.resolution);
                    // Candidates are compared as sets, but the innermost
                    // binding comes first.
                    let normalized = |e: &Expected| match e {
                        Expected::Ambiguous(c) => {
                            let mut c = c.clone();
                            c.sort();
                            Expected::Ambiguous(c)
                        }
                        other => other.clone(),
                    };
                    assert_eq!(
                        normalized(&got),
                        normalized(&want),
                        "call to {name} in {}#{f}\n{}",
                        case.language.module_path(m),
                        case.describe()
                    );
                    if let (Expected::Ambiguous(got), true) =
                        (&got, function.nested_name() == Some(*name))
                    {
                        assert_eq!(got[0], (m, f, true), "innermost first\n{}", case.describe());
                    }
                    // Exact only for a unique binding.
                    if let Resolution::Exact { .. } = call.resolution {
                        assert!(matches!(want, Expected::Exact(_)));
                    }
                }
            }
        }
    });
}

#[test]
fn incoming_and_outgoing_calls_agree() {
    run(200, |case, classes| {
        let provider = EmbeddedProvider::new();
        let snapshot = &case.rendered.snapshot;
        for (m, f, nested) in functions(&case.program) {
            let function = &case.program.modules[m].functions[f];
            if nested && !function.calls_of(nested).is_empty() {
                classes.insert("calls_in_nested");
            }
            {
                for name in function.calls_of(nested) {
                    let want = expected(case.language, &case.program, m, f, nested, name);
                    classes.insert(class(
                        &want,
                        case.language,
                        &case.program,
                        (m, f, nested),
                        name,
                    ));
                }
            }
        }
        // Edges as (caller, site line, callee) from both directions.
        let mut forward = BTreeSet::new();
        for caller in functions(&case.program) {
            for call in outgoing(&provider, case, caller) {
                for target in call.resolution.targets() {
                    let target = case.def_at(&target.path, target.line).unwrap();
                    forward.insert((caller, call.site.path.clone(), call.site.line, target));
                }
            }
        }
        let mut backward = BTreeSet::new();
        let mut truncated = BTreeMap::new();
        for target in functions(&case.program) {
            let answer = provider
                .incoming_calls(snapshot, &case.key(target), 1, &Budget::default())
                .unwrap();
            truncated.insert(target, answer.truncated);
            for item in answer.items {
                assert_eq!(item.depth, 1);
                let caller = item.call.caller.as_ref().expect("calls are in functions");
                let caller = case.def_at(&caller.path, caller.line).unwrap();
                assert!(
                    item.call
                        .resolution
                        .targets()
                        .iter()
                        .any(|t| case.def_at(&t.path, t.line) == Some(target)),
                    "{}",
                    case.describe()
                );
                backward.insert((caller, item.call.site.path, item.call.site.line, target));
            }
        }
        assert_eq!(forward, backward, "{}", case.describe());
        // Depth 1 is marked short exactly when a caller (other than the
        // target itself: visited symbols are not expanded again) has
        // callers.
        for (target, truncated) in truncated {
            let deeper = backward.iter().any(|(caller, _, _, callee)| {
                *callee == target
                    && *caller != target
                    && backward.iter().any(|(_, _, _, c)| c == caller)
            });
            let want = deeper.then_some(vertebrae_syntax::intelligence::Truncation::DepthLimit);
            assert_eq!(truncated, want, "{target:?}\n{}", case.describe());
        }
    });
}

/// A focused regression: a name defined twice, imported, and shadowed.
#[test]
fn shadowed_and_duplicated_names_list_their_candidates() {
    let program = Program {
        modules: vec![
            Module {
                functions: vec![
                    Function {
                        name: "alpha",
                        exported: true,
                        nested: Some(("beta", vec![])),
                        param: None,
                        calls: vec!["beta", "gamma"],
                    },
                    Function {
                        name: "beta",
                        exported: false,
                        nested: None,
                        param: None,
                        calls: vec![],
                    },
                ],
                imports: vec![("gamma", "gamma", 1)],
                default: None,
            },
            Module {
                functions: vec![
                    Function {
                        name: "gamma",
                        exported: true,
                        nested: None,
                        param: None,
                        calls: vec![],
                    },
                    Function {
                        name: "gamma",
                        exported: true,
                        nested: None,
                        param: None,
                        calls: vec![],
                    },
                ],
                imports: vec![],
                default: None,
            },
        ],
    };
    for language in LANGUAGES {
        let case = Case {
            language,
            rendered: render(language, &program),
            program: program.clone(),
        };
        let provider = EmbeddedProvider::new();
        let calls = outgoing(&provider, &case, (0, 0, false));
        let got: Vec<Expected> = calls.iter().map(|c| case.observed(&c.resolution)).collect();
        assert_eq!(
            got,
            [
                Expected::Ambiguous(vec![(0, 0, true), (0, 1, false)]),
                Expected::Ambiguous(vec![(1, 0, false), (1, 1, false)]),
            ],
            "{}",
            case.describe()
        );
    }
}

/// One step of the cache model.
#[derive(Clone, Debug)]
enum Step {
    /// File `file` now holds version `version` of its text.
    Edit { file: usize, version: usize },
    /// File `file` now holds file `from`'s text: the same content.
    Copy { file: usize, from: usize },
    /// Ask for file `file`'s definitions.
    Define { file: usize },
}

/// Model-based test of the content-keyed extraction cache: across a drawn
/// sequence of edits, copies and requests, each request extracts exactly
/// when its file's content is not among the most recently stored
/// `CAPACITY` contents (oldest evicted first; a hit does not refresh), and
/// answers from the current content.
#[test]
fn the_extraction_cache_follows_its_model() {
    const FILES: usize = 3;
    const CAPACITY: usize = 3;
    let text = |file: usize, version: usize| format!("pub fn f{file}_{version}() {{}}\n");
    let reached = RefCell::new(BTreeSet::new());
    Hegel::new(|tc: TestCase| {
        let provider = EmbeddedProvider::with_cache_limits(CAPACITY, usize::MAX);
        let mut snapshot = MemorySnapshot::new();
        let mut contents: Vec<String> = (0..FILES).map(|file| text(file, 0)).collect();
        for (file, content) in contents.iter().enumerate() {
            snapshot.insert(format!("src/f{file}.rs"), content.clone());
        }
        let mut cache: std::collections::VecDeque<String> = Default::default();
        let mut history = Vec::new();
        let file = || tc.draw(gs::integers::<usize>().min_value(0).max_value(FILES - 1));
        for _ in 0..tc.draw(gs::integers::<usize>().min_value(1).max_value(24)) {
            let step = match tc.draw(gs::integers::<u8>().min_value(0).max_value(4)) {
                0 => Step::Edit {
                    file: file(),
                    version: tc.draw(gs::integers::<usize>().min_value(0).max_value(2)),
                },
                1 => Step::Copy {
                    file: file(),
                    from: file(),
                },
                _ => Step::Define { file: file() },
            };
            history.push(step.clone());
            match step {
                Step::Edit { file, version } => contents[file] = text(file, version),
                Step::Copy { file, from } => contents[file] = contents[from].clone(),
                Step::Define { file } => {
                    let before = provider.stats();
                    let path = format!("src/f{file}.rs");
                    snapshot.insert(path.clone(), contents[file].clone());
                    let answer = provider
                        .definitions(&snapshot, &path, &Budget::default())
                        .unwrap();
                    let after = provider.stats();
                    let hit = cache.contains(&contents[file]);
                    if !hit {
                        cache.push_back(contents[file].clone());
                        if cache.len() > CAPACITY {
                            cache.pop_front();
                            reached.borrow_mut().insert("eviction");
                        }
                    }
                    reached
                        .borrow_mut()
                        .insert(if hit { "hit" } else { "miss" });
                    assert_eq!(
                        (
                            after.extractions - before.extractions,
                            after.cache_hits - before.cache_hits
                        ),
                        if hit { (0, 1) } else { (1, 0) },
                        "after {history:?}"
                    );
                    let names: Vec<&str> = answer.items.iter().map(|s| s.name.as_str()).collect();
                    let want = contents[file].trim_start_matches("pub fn ");
                    assert_eq!(
                        names,
                        [&want[..want.find('(').unwrap()]],
                        "after {history:?}"
                    );
                }
            }
            if matches!(history.last(), Some(Step::Copy { file, from }) if file != from) {
                reached.borrow_mut().insert("shared_content");
            }
        }
    })
    .settings(Settings::new().test_cases(200))
    .run();
    let reached = reached.into_inner();
    for class in ["hit", "miss", "eviction", "shared_content"] {
        assert!(reached.contains(class), "never reached: {class}");
    }
}
