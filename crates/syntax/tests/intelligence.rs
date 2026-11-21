//! Code intelligence on hand-written fixtures, one per language and rule:
//! imports, module paths, methods, shadowing, budgets and the cache.

use std::time::Duration;
use vertebrae_syntax::intelligence::{
    Budget, Call, CodeIntelligence, CodeSymbol, EmbeddedProvider, IncomingCall, MemorySnapshot,
    Resolution, SymbolKey, Truncation,
};
use vertebrae_syntax::semantic::DeclarationKind;

fn symbol(
    provider: &EmbeddedProvider,
    snapshot: &MemorySnapshot,
    path: &str,
    name: &str,
) -> SymbolKey {
    let answer = provider
        .definitions(snapshot, path, &Budget::default())
        .unwrap();
    let found: Vec<&CodeSymbol> = answer
        .items
        .iter()
        .filter(|s| s.name == name && s.kind != DeclarationKind::Impl)
        .collect();
    assert_eq!(found.len(), 1, "{name} in {path}: {:#?}", answer.items);
    found[0].key()
}

fn outgoing(
    provider: &EmbeddedProvider,
    snapshot: &MemorySnapshot,
    path: &str,
    name: &str,
) -> Vec<Call> {
    let key = symbol(provider, snapshot, path, name);
    let answer = provider
        .outgoing_calls(snapshot, &key, &Budget::default())
        .unwrap();
    assert_eq!(answer.truncated, None);
    answer.items
}

/// `callee → quality@path:line` for each call, for compact assertions.
fn edges(calls: &[Call]) -> Vec<String> {
    calls
        .iter()
        .map(|call| {
            let resolution = match &call.resolution {
                Resolution::Exact { target } => format!("exact@{}:{}", target.path, target.line),
                Resolution::NameMatch { target } => {
                    format!("name_match@{}:{}", target.path, target.line)
                }
                Resolution::Ambiguous { candidates } => format!(
                    "ambiguous@{}",
                    candidates
                        .iter()
                        .map(|c| format!("{}:{}", c.path, c.line))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
                Resolution::Unresolved => "unresolved".to_owned(),
            };
            format!("{} → {resolution}", call.callee)
        })
        .collect()
}

fn rust_crate() -> MemorySnapshot {
    [
        ("Cargo.toml", "[package]\nname = \"demo-crate\"\n"),
        (
            "src/lib.rs",
            "mod store;\nmod util;\n\nuse crate::store::{save, Store};\n\npub fn run() {\n    let s = Store::new();\n    save(&s);\n    util::helper();\n    s.flush();\n    std::fs::write(\"a\", \"b\");\n    missing();\n}\n",
        ),
        (
            "src/store.rs",
            "pub struct Store;\n\nimpl Store {\n    pub fn new() -> Self {\n        Store\n    }\n\n    pub fn flush(&self) {\n        self.sync();\n    }\n\n    fn sync(&self) {}\n}\n\npub fn save(store: &Store) {\n    store.flush();\n}\n",
        ),
        (
            "src/util.rs",
            "pub fn helper() {\n    inner::deep();\n}\n\nmod inner {\n    pub fn deep() {}\n}\n",
        ),
        (
            "other/Cargo.toml",
            "[package]\nname = \"other\"\n",
        ),
        (
            "other/src/lib.rs",
            "use demo_crate::run;\n\npub fn main_entry() {\n    run();\n    demo_crate::run();\n}\n",
        ),
    ]
    .into_iter()
    .collect()
}

#[test]
fn rust_calls_resolve_through_use_paths_types_and_self() {
    let provider = EmbeddedProvider::new();
    let snapshot = rust_crate();
    let calls = outgoing(&provider, &snapshot, "src/lib.rs", "run");
    assert_eq!(
        edges(&calls),
        [
            "Store::new → exact@src/store.rs:4",
            "save → exact@src/store.rs:15",
            "util::helper → exact@src/util.rs:1",
            "s.flush → name_match@src/store.rs:8",
            "std::fs::write → unresolved",
            "missing → unresolved",
        ]
    );
    assert_eq!(
        edges(&outgoing(&provider, &snapshot, "src/store.rs", "flush")),
        ["self.sync → exact@src/store.rs:12"]
    );
    assert_eq!(
        edges(&outgoing(&provider, &snapshot, "src/util.rs", "helper")),
        ["inner::deep → exact@src/util.rs:6"]
    );
    assert_eq!(
        edges(&outgoing(
            &provider,
            &snapshot,
            "other/src/lib.rs",
            "main_entry"
        )),
        [
            "run → exact@src/lib.rs:6",
            "demo_crate::run → exact@src/lib.rs:6"
        ]
    );
}

#[test]
fn incoming_calls_walk_callers_to_the_requested_depth() {
    let provider = EmbeddedProvider::new();
    let snapshot = rust_crate();
    let flush = symbol(&provider, &snapshot, "src/store.rs", "flush");
    let answer = provider
        .incoming_calls(&snapshot, &flush, 2, &Budget::default())
        .unwrap();
    let callers = |items: &[IncomingCall]| -> Vec<String> {
        items
            .iter()
            .map(|item| {
                format!(
                    "{}:{}<-{}",
                    item.depth,
                    item.target.name,
                    item.call.caller.as_ref().map_or("-", |c| c.name.as_str())
                )
            })
            .collect()
    };
    assert_eq!(
        callers(&answer.items),
        [
            "1:flush<-run",
            "1:flush<-save",
            "2:run<-main_entry",
            "2:run<-main_entry",
            "2:save<-run"
        ]
    );
    assert_eq!(answer.truncated, None);
    let shallow = provider
        .incoming_calls(
            &snapshot,
            &flush,
            1,
            &Budget {
                max_depth: 1,
                ..Budget::default()
            },
        )
        .unwrap();
    assert_eq!(callers(&shallow.items), ["1:flush<-run", "1:flush<-save"]);
    let capped = provider
        .incoming_calls(
            &snapshot,
            &flush,
            3,
            &Budget {
                max_depth: 1,
                ..Budget::default()
            },
        )
        .unwrap();
    assert_eq!(capped.truncated, Some(Truncation::DepthLimit));
}

#[test]
fn typescript_imports_namespaces_defaults_and_methods() {
    let provider = EmbeddedProvider::new();
    let snapshot: MemorySnapshot = [
        ("package.json", "{}"),
        (
            "src/app.ts",
            "import { load, save as persist } from './store';\nimport * as fmt from './format';\nimport render from './view';\n\nexport function main() {\n  const data = load();\n  persist(data);\n  fmt.pretty(data);\n  render();\n  data.map((x) => x);\n  console.log(data);\n}\n",
        ),
        (
            "src/store.ts",
            "export function load() {\n  return [];\n}\n\nexport function save(data: number[]) {\n  new Writer().write(data);\n}\n\nclass Writer {\n  write(data: number[]) {\n    this.flush();\n  }\n  flush() {}\n}\n",
        ),
        ("src/format.ts", "export function pretty(x: unknown) {}\n"),
        ("src/view.tsx", "export default function View() {\n  return null;\n}\n"),
    ]
    .into_iter()
    .collect();
    assert_eq!(
        edges(&outgoing(&provider, &snapshot, "src/app.ts", "main")),
        [
            "load → exact@src/store.ts:1",
            "persist → exact@src/store.ts:5",
            "fmt.pretty → exact@src/format.ts:1",
            "render → exact@src/view.tsx:1",
            "data.map → unresolved",
            "console.log → unresolved",
        ]
    );
    assert_eq!(
        edges(&outgoing(&provider, &snapshot, "src/store.ts", "save")),
        [
            "Writer → exact@src/store.ts:9",
            "new Writer().write → name_match@src/store.ts:10"
        ]
    );
    assert_eq!(
        edges(&outgoing(&provider, &snapshot, "src/store.ts", "write")),
        ["this.flush → exact@src/store.ts:13"]
    );
}

#[test]
fn python_imports_modules_and_shadowing() {
    let provider = EmbeddedProvider::new();
    let snapshot: MemorySnapshot = [
        ("pyproject.toml", ""),
        ("pkg/__init__.py", ""),
        (
            "pkg/app.py",
            "from pkg.store import load\nfrom . import util\nimport pkg.store as st\n\n\ndef main():\n    def load():\n        pass\n    load()\n    util.helper()\n    st.save()\n    print('x')\n\n\nclass Job:\n    def run(self):\n        self.step()\n\n    def step(self):\n        pass\n",
        ),
        ("pkg/store.py", "def load():\n    pass\n\n\ndef save():\n    pass\n"),
        ("pkg/util.py", "def helper():\n    pass\n"),
    ]
    .into_iter()
    .collect();
    assert_eq!(
        edges(&outgoing(&provider, &snapshot, "pkg/app.py", "main")),
        [
            "load → ambiguous@pkg/app.py:7,pkg/store.py:1",
            "util.helper → exact@pkg/util.py:1",
            "st.save → exact@pkg/store.py:5",
            "print → unresolved",
        ]
    );
    assert_eq!(
        edges(&outgoing(&provider, &snapshot, "pkg/app.py", "run")),
        ["self.step → exact@pkg/app.py:19"]
    );
}

#[test]
fn references_find_calls_imports_and_uses() {
    let provider = EmbeddedProvider::new();
    let snapshot = rust_crate();
    let save = symbol(&provider, &snapshot, "src/store.rs", "save");
    let answer = provider
        .references(&snapshot, &save, &Budget::default())
        .unwrap();
    let found: Vec<String> = answer
        .items
        .iter()
        .map(|r| format!("{:?}@{}:{}", r.kind, r.site.path, r.site.line))
        .collect();
    assert_eq!(found, ["Import@src/lib.rs:4", "Call@src/lib.rs:8"]);
    let store = symbol(&provider, &snapshot, "src/store.rs", "Store");
    let uses = provider
        .references(&snapshot, &store, &Budget::default())
        .unwrap();
    assert!(uses
        .items
        .iter()
        .any(|r| r.site.path == "src/store.rs" && r.site.line == 15));
}

#[test]
fn definitions_list_every_declaration_with_its_scope() {
    let provider = EmbeddedProvider::new();
    let snapshot = rust_crate();
    let answer = provider
        .definitions(&snapshot, "src/store.rs", &Budget::default())
        .unwrap();
    let found: Vec<(String, DeclarationKind, Vec<String>)> = answer
        .items
        .iter()
        .map(|s| (s.name.clone(), s.kind, s.scope.clone()))
        .collect();
    assert_eq!(
        found,
        [
            ("Store".into(), DeclarationKind::Class, vec![]),
            ("Store".into(), DeclarationKind::Impl, vec![]),
            ("new".into(), DeclarationKind::Method, vec!["Store".into()]),
            (
                "flush".into(),
                DeclarationKind::Method,
                vec!["Store".into()]
            ),
            ("sync".into(), DeclarationKind::Method, vec!["Store".into()]),
            ("save".into(), DeclarationKind::Function, vec![]),
        ]
    );
    assert_eq!(answer.provider.as_str(), "embedded");
}

#[test]
fn requery_after_a_one_file_edit_extracts_only_that_file() {
    let provider = EmbeddedProvider::new();
    let mut snapshot = rust_crate();
    let flush = symbol(&provider, &snapshot, "src/store.rs", "flush");
    provider
        .incoming_calls(&snapshot, &flush, 2, &Budget::default())
        .unwrap();
    let before = provider.stats().extractions;
    provider
        .incoming_calls(&snapshot, &flush, 2, &Budget::default())
        .unwrap();
    assert_eq!(
        provider.stats().extractions,
        before,
        "a repeat extracts nothing"
    );
    snapshot.insert(
        "src/util.rs",
        "pub fn helper() {\n    inner::deep();\n    crate::store::save(&crate::store::Store);\n}\n\nmod inner {\n    pub fn deep() {}\n}\n",
    );
    let answer = provider
        .incoming_calls(&snapshot, &flush, 2, &Budget::default())
        .unwrap();
    assert_eq!(
        provider.stats().extractions,
        before + 1,
        "only the edited file"
    );
    assert!(answer.items.iter().any(|item| item
        .call
        .caller
        .as_ref()
        .is_some_and(|c| c.name == "helper")));
}

#[test]
fn a_request_past_its_budget_returns_partial_results_marked_truncated() {
    let provider = EmbeddedProvider::new();
    let mut snapshot = MemorySnapshot::new();
    snapshot.insert("src/lib.rs", "pub fn target() {}\n");
    for i in 0..50 {
        snapshot.insert(
            format!("src/m{i:02}.rs"),
            "fn caller() {\n    crate::target();\n}\n",
        );
    }
    let target = symbol(&provider, &snapshot, "src/lib.rs", "target");
    let files = Budget {
        max_files: 10,
        ..Budget::default()
    };
    let answer = provider
        .incoming_calls(&snapshot, &target, 1, &files)
        .unwrap();
    assert_eq!(answer.truncated, Some(Truncation::FileLimit));
    assert!(!answer.items.is_empty() && answer.items.len() < 50);
    let time = Budget {
        time: Duration::ZERO,
        ..Budget::default()
    };
    let answer = provider
        .incoming_calls(&snapshot, &target, 1, &time)
        .unwrap();
    assert_eq!(answer.truncated, Some(Truncation::TimedOut));
    let results = Budget {
        max_results: 3,
        ..Budget::default()
    };
    let answer = provider
        .incoming_calls(&snapshot, &target, 1, &results)
        .unwrap();
    assert_eq!(answer.truncated, Some(Truncation::ResultLimit));
    assert_eq!(answer.items.len(), 3);
}

/// Review repros: a parameter or local shadowing a definition is not exact.
#[test]
fn locals_and_parameters_shadow_definitions() {
    let provider = EmbeddedProvider::new();
    let cases = [
        (
            "a.ts",
            "function save() {}\n\nfunction run(save: () => void) {\n  save();\n}\n",
        ),
        (
            "a.js",
            "function save() {}\n\nfunction run(save) {\n  save();\n}\n",
        ),
        (
            "src/lib.rs",
            "fn save() {}\n\nfn run() {\n    let save = || {};\n    save();\n}\n",
        ),
        (
            "a.py",
            "def save():\n    pass\n\n\ndef run(save):\n    save()\n",
        ),
    ];
    for (path, text) in cases {
        let snapshot: MemorySnapshot = [(path, text)].into_iter().collect();
        let calls = outgoing(&provider, &snapshot, path, "run");
        assert_eq!(
            edges(&calls),
            [if path.ends_with(".rs") {
                "save → unresolved".to_owned()
            } else {
                format!("save → ambiguous@{path}:1")
            }],
            "{path}"
        );
    }
    // Only the parameter binds it: no definition to point to.
    let snapshot: MemorySnapshot = [("a.ts", "function run(load: () => void) {\n  load();\n}\n")]
        .into_iter()
        .collect();
    assert_eq!(
        edges(&outgoing(&provider, &snapshot, "a.ts", "run")),
        ["load → unresolved"]
    );
    // Rust's nested `fn` items do not capture the enclosing function's
    // locals; JavaScript's nested functions do.
    let snapshot: MemorySnapshot = [(
        "src/lib.rs",
        "fn save() {}\n\nfn run(save: fn()) {\n    fn inner() {\n        save();\n    }\n}\n",
    )]
    .into_iter()
    .collect();
    assert_eq!(
        edges(&outgoing(&provider, &snapshot, "src/lib.rs", "inner")),
        ["save → exact@src/lib.rs:1"]
    );
}

#[test]
fn rust_destructured_locals_hide_call_targets() {
    let provider = EmbeddedProvider::new();
    let path = "src/lib.rs";
    for (pattern, value, shadowed) in [
        ("(retry,)", "(other,)", true),
        (
            "Wrap { callback: (ref retry,) }",
            "Wrap { callback: (other,) }",
            true,
        ),
        ("Named { retry }", "Named { retry: other }", true),
        ("(mut retry,)", "(other,)", true),
        ("Pair([retry])", "Pair([other])", true),
        ("whole @ (retry,)", "(other,)", true),
        ("Named { retry: _ }", "Named { retry: other }", false),
        (
            "constructors::retry(_)",
            "constructors::retry(other)",
            false,
        ),
    ] {
        let source = format!(
            "fn retry() {{}}\nstruct Wrap {{ callback: (fn(),) }}\nstruct Named {{ retry: fn() }}\nstruct Pair([fn(); 1]);\nmod constructors {{ pub struct retry(pub fn()); }}\nfn review(other: fn()) {{ let {pattern} = {value}; retry(); }}\nfn direct() {{ retry(); }}\n"
        );
        let snapshot: MemorySnapshot = [(path, source.as_str())].into_iter().collect();
        let retry_resolution = if shadowed {
            "retry → unresolved"
        } else {
            "retry → exact@src/lib.rs:1"
        };
        let mut review = outgoing(&provider, &snapshot, path, "review");
        review.retain(|call| call.callee == "retry");
        assert_eq!(edges(&review), [retry_resolution], "{pattern}");
        let direct = outgoing(&provider, &snapshot, path, "direct");
        assert_eq!(edges(&direct), ["retry → exact@src/lib.rs:1"]);

        let Resolution::Exact { target } = &direct[0].resolution else {
            panic!("direct call must resolve exactly");
        };
        let incoming = provider
            .incoming_calls(&snapshot, &target.key(), 1, &Budget::default())
            .unwrap();
        assert_eq!(incoming.truncated, None);
        let mut sites: Vec<_> = incoming
            .items
            .iter()
            .map(|edge| edge.call.site.line)
            .collect();
        sites.sort_unstable();
        assert_eq!(
            sites,
            if shadowed { vec![7] } else { vec![6, 7] },
            "{pattern}"
        );
    }
}

/// Review nit: Rust inline modules are scopes; `use super::*` reaches out.
#[test]
fn rust_inline_modules_see_parent_items_only_through_imports() {
    let provider = EmbeddedProvider::new();
    let snapshot: MemorySnapshot = [
        ("Cargo.toml", "[package]\nname = \"demo\"\n"),
        (
            "src/a.rs",
            "pub fn helper() {}\n\nmod plain {\n    fn run() {\n        helper();\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    fn check() {\n        helper();\n    }\n}\n",
        ),
    ]
    .into_iter()
    .collect();
    assert_eq!(
        edges(&outgoing(&provider, &snapshot, "src/a.rs", "run")),
        ["helper → unresolved"]
    );
    assert_eq!(
        edges(&outgoing(&provider, &snapshot, "src/a.rs", "check")),
        ["helper → exact@src/a.rs:1"]
    );
}

/// Review repro: a default import calls the definition under another name,
/// in a file that never spells it.
#[test]
fn default_imports_appear_in_incoming_calls_and_references() {
    let provider = EmbeddedProvider::new();
    let snapshot: MemorySnapshot = [
        ("package.json", "{}"),
        ("m0.ts", "export default function save() {}\n"),
        (
            "m1.ts",
            "import persist from './m0';\n\nexport function run() {\n  persist();\n}\n",
        ),
    ]
    .into_iter()
    .collect();
    assert_eq!(
        edges(&outgoing(&provider, &snapshot, "m1.ts", "run")),
        ["persist → exact@m0.ts:1"]
    );
    let save = symbol(&provider, &snapshot, "m0.ts", "save");
    let incoming = provider
        .incoming_calls(&snapshot, &save, 1, &Budget::default())
        .unwrap();
    assert_eq!(incoming.truncated, None);
    let callers: Vec<_> = incoming
        .items
        .iter()
        .map(|item| item.call.caller.as_ref().unwrap().name.as_str())
        .collect();
    assert_eq!(callers, ["run"]);
    let references = provider
        .references(&snapshot, &save, &Budget::default())
        .unwrap();
    let kinds: Vec<String> = references
        .items
        .iter()
        .map(|r| format!("{:?}@{}:{}", r.kind, r.site.path, r.site.line))
        .collect();
    assert_eq!(kinds, ["Import@m1.ts:1", "Call@m1.ts:4"]);
}

/// Review finding: `DepthLimit` means callers exist past the last level.
#[test]
fn depth_limit_reports_only_callers_beyond_the_answer() {
    let provider = EmbeddedProvider::new();
    let snapshot = rust_crate();
    let flush = symbol(&provider, &snapshot, "src/store.rs", "flush");
    let main_entry = symbol(&provider, &snapshot, "other/src/lib.rs", "main_entry");
    let run = symbol(&provider, &snapshot, "src/lib.rs", "run");
    let incoming = |key: &SymbolKey, depth: u32, max_depth: u32| {
        provider
            .incoming_calls(
                &snapshot,
                key,
                depth,
                &Budget {
                    max_depth,
                    ..Budget::default()
                },
            )
            .unwrap()
            .truncated
    };
    // Callers of `flush`'s callers exist past depth 1.
    assert_eq!(incoming(&flush, 1, 8), Some(Truncation::DepthLimit));
    // `run`'s only caller has none: clamping the depth cuts nothing.
    assert_eq!(incoming(&run, 3, 1), None);
    assert_eq!(incoming(&flush, 3, 8), None);
    assert_eq!(incoming(&main_entry, 1, 8), None);
}
