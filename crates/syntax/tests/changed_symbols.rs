use hegel::{generators as gs, Hegel, Settings, TestCase};
use std::collections::BTreeSet;
use vertebrae_syntax::changed_symbols::{project, ChangedFile, ChangedSymbols, EditKind, Side};
use vertebrae_syntax::intelligence::{Budget, EmbeddedProvider, MemorySnapshot, Resolution};
use vertebrae_syntax::semantic::{self, EffectKind, SemanticOutcome};

fn analyze(files: &[(&str, Option<&str>, Option<&str>)]) -> ChangedSymbols {
    let mut base = MemorySnapshot::new();
    let mut target = MemorySnapshot::new();
    let edits = files
        .iter()
        .map(|&(path, old, new)| {
            if let Some(old) = old {
                base.insert(path, old);
            }
            if let Some(new) = new {
                target.insert(path, new);
            }
            let SemanticOutcome::Semantic { declarations, .. } = semantic::diff(
                path,
                old.unwrap_or_default(),
                new.unwrap_or_default(),
                &semantic::Budget::default(),
            ) else {
                panic!("fixture must have a semantic diff: {path}")
            };
            ChangedFile {
                path,
                old_path: path,
                old: old.unwrap_or_default(),
                new: new.unwrap_or_default(),
                old_revision: old.map(|_| "base"),
                new_revision: new.map(|_| "target"),
                declarations,
            }
        })
        .collect();
    let graph = project(
        edits,
        &EmbeddedProvider::new(),
        &base,
        &target,
        &Budget::default(),
    );
    assert!(!graph.incomplete);
    graph
}

const NAMES: [&str; 3] = ["alpha", "beta", "gamma"];
const CHAIN: [(usize, usize); 2] = [(0, 1), (1, 2)];

fn render(calls: u8, edits: u8) -> String {
    NAMES
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let mut body = format!("let _marker = {};", (edits >> i) & 1);
            if let Some((_, target)) = CHAIN.get(i).filter(|_| calls & (1 << i) != 0) {
                body.push_str(&format!("\n    {}();", NAMES[*target]));
            }
            format!("fn {name}() {{\n    {body}\n}}\n")
        })
        .collect()
}

#[test]
fn relations_match_the_program_model_after_random_edits() {
    Hegel::new(|tc: TestCase| {
        let before = tc.draw(gs::integers::<u8>().max_value(3));
        let after = tc.draw(gs::integers::<u8>().max_value(3));
        let edits = tc.draw(gs::integers::<u8>().max_value(7));
        let changed = edits | (before ^ after);
        let old = render(before, 0);
        let new = render(after, edits);
        let graph = analyze(&[("lib.rs", Some(&old), Some(&new))]);
        let expected_symbols: BTreeSet<_> = NAMES
            .iter()
            .enumerate()
            .filter_map(|(i, name)| (changed & (1 << i) != 0).then_some(*name))
            .collect();
        assert_eq!(
            graph.symbols.len(),
            expected_symbols.len(),
            "{old} -> {new}"
        );
        assert_eq!(
            graph
                .symbols
                .iter()
                .map(|s| s.id.scope[0].as_str())
                .collect::<BTreeSet<_>>(),
            expected_symbols,
            "{old} -> {new}"
        );
        for (side, mask) in [(Side::Old, before), (Side::New, after)] {
            let expected: BTreeSet<_> = CHAIN
                .iter()
                .enumerate()
                .filter_map(|(i, &(from, to))| {
                    (mask & (1 << i) != 0 && changed & ((1 << from) | (1 << to)) != 0)
                        .then_some((NAMES[from], NAMES[to]))
                })
                .collect();
            let actual: BTreeSet<_> = graph
                .calls
                .iter()
                .filter(|edge| edge.side == side)
                .map(|edge| {
                    let Resolution::Exact { target } = &edge.call.resolution else {
                        panic!("local binding should be exact: {edge:?}\n{old} -> {new}");
                    };
                    let caller = edge.call.caller.as_ref().unwrap();
                    assert_eq!(
                        edge.changed_caller
                            .map(|i| graph.symbols[i as usize].id.scope[0].as_str()),
                        expected_symbols
                            .contains(caller.name.as_str())
                            .then_some(caller.name.as_str())
                    );
                    assert_eq!(
                        edge.changed_targets
                            .iter()
                            .map(|i| graph.symbols[*i as usize].id.scope[0].as_str())
                            .collect::<Vec<_>>(),
                        expected_symbols
                            .contains(target.name.as_str())
                            .then_some(target.name.as_str())
                            .into_iter()
                            .collect::<Vec<_>>()
                    );
                    (caller.name.as_str(), target.name.as_str())
                })
                .collect();
            assert_eq!(actual, expected, "{side:?}\n{old} -> {new}");
        }
    })
    .settings(Settings::new().test_cases(100))
    .run();
}

#[test]
fn unique_cross_file_move_keeps_both_semantic_locations() {
    let function = "pub fn moved() {\n    println!(\"move\");\n}\n";
    let graph = analyze(&[
        ("from.rs", Some(function), None),
        ("to.rs", None, Some(function)),
    ]);
    let [symbol] = graph.symbols.as_slice() else {
        panic!("{graph:?}")
    };
    assert_eq!(symbol.change, EditKind::Moved);
    assert_eq!(symbol.id.path, "to.rs");
    assert_eq!(
        symbol
            .edits
            .iter()
            .map(|edit| (edit.path.as_str(), edit.declaration.change.spans()))
            .collect::<Vec<_>>(),
        vec![
            (
                "to.rs",
                (None, Some(semantic::LineSpan { start: 1, end: 3 }))
            ),
            (
                "from.rs",
                (Some(semantic::LineSpan { start: 1, end: 3 }), None)
            )
        ]
    );
}

#[test]
fn duplicated_content_is_not_paired_as_a_move() {
    let function = "pub fn repeated() {}\n";
    let graph = analyze(&[
        ("from.rs", Some(function), None),
        ("one.rs", None, Some(function)),
        ("two.rs", None, Some(function)),
    ]);
    assert_eq!(graph.symbols.len(), 3);
    assert!(graph
        .symbols
        .iter()
        .all(|symbol| symbol.change != EditKind::Moved));
}

#[test]
fn reachable_boundary_effects_follow_exact_calls() {
    let graph = analyze(&[(
        "lib.rs",
        None,
        Some("fn alpha() { beta(); }\nfn beta() { std::fs::read(\"file\"); }\n"),
    )]);
    for symbol in &graph.symbols {
        assert_eq!(symbol.effects.len(), 1, "{graph:?}");
        assert_eq!(
            graph.calls[symbol.effects[0] as usize].effect,
            Some(EffectKind::Filesystem)
        );
    }
}

#[test]
fn ambiguous_candidates_keep_their_provider_quality() {
    let graph = analyze(&[
        (
            "lib.ts",
            None,
            Some("export function caller() { shared(); }\n"),
        ),
        (
            "one.ts",
            None,
            Some("export function shared() { return 1; }\n"),
        ),
        (
            "two.ts",
            None,
            Some("export function shared() { return 2; }\n"),
        ),
    ]);
    let [edge] = graph.calls.as_slice() else {
        panic!("{graph:?}")
    };
    assert!(matches!(edge.call.resolution, Resolution::Ambiguous { .. }));
    assert_eq!(edge.changed_targets.len(), 2);
}

#[test]
fn exact_unchanged_callee_contributes_boundary_effects() {
    let old = "fn changed() { helper(); }\nfn helper() { std::fs::read(\"file\"); }\n";
    let new =
        "fn changed() { helper(); let _value = 2; }\nfn helper() { std::fs::read(\"file\"); }\n";
    let graph = analyze(&[("lib.rs", Some(old), Some(new))]);
    let [symbol] = graph.symbols.as_slice() else {
        panic!("{graph:?}")
    };
    assert_eq!(symbol.id.scope, ["changed"]);
    assert_eq!(symbol.effects.len(), 2);
    for &index in &symbol.effects {
        let edge = &graph.calls[index as usize];
        assert_eq!(edge.call.callee, "helper");
        assert!(edge.changed_targets.is_empty());
        assert_eq!(edge.callee_effects[0].kind, EffectKind::Filesystem);
        assert_eq!(edge.callee_effects[0].site.line, 2);
    }
}

#[test]
fn top_level_changes_are_one_file_symbol_with_provider_calls() {
    let old = "function run() {}\nrun();\n";
    let new = "function run() {}\nrun();\nrun();\n";
    let graph = analyze(&[("module.ts", Some(old), Some(new))]);
    let [symbol] = graph.symbols.as_slice() else {
        panic!("{graph:?}")
    };
    assert_eq!(symbol.id.kind, None);
    assert!(symbol.id.scope.is_empty());
    assert_eq!(graph.calls.len(), 3);
    assert!(graph.calls.iter().all(|edge| edge.changed_caller == Some(0)
        && matches!(edge.call.resolution, Resolution::Exact { .. })));
}
