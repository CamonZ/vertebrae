use hegel::generators as gs;
use hegel::TestCase;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::time::{Duration, Instant};
use vertebrae_syntax::{analyze_activity, ActivityAnalysis, ActivityInput};

fn input(name: &str, value: Value) -> ActivityInput {
    serde_json::from_value(json!({"name": name, "input": value})).unwrap()
}

fn shell(source: &str) -> ActivityAnalysis {
    analyze_activity(&input("exec_command", json!({"cmd": source})))
}

fn js(source: &str) -> ActivityAnalysis {
    analyze_activity(&input("exec", json!({"code": source})))
}

fn labels(row: &ActivityAnalysis) -> BTreeSet<&str> {
    row.operations
        .iter()
        .flat_map(|op| op.activities.iter().map(String::as_str))
        .collect()
}

fn sources(row: &ActivityAnalysis) -> Vec<&str> {
    row.operations.iter().map(|op| op.source.as_str()).collect()
}

fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

const COMMANDS: [(&str, &str); 4] = [
    ("cargo test", "checks"),
    ("git status", "Git inspection"),
    ("cat src/a.rs", "source inspection"),
    ("cat docs/testing.md", "documentation"),
];

fn leaf(tc: &TestCase) -> (&'static str, &'static str) {
    COMMANDS[tc.draw(gs::integers::<usize>().max_value(COMMANDS.len() - 1))]
}

fn leaves(tc: &TestCase, max: usize) -> Vec<(&'static str, &'static str)> {
    let count = tc.draw(gs::integers::<usize>().min_value(1).max_value(max));
    (0..count).map(|_| leaf(tc)).collect()
}

#[derive(Deserialize)]
struct RecordedActivity {
    call: ActivityInput,
    expected: Value,
}

#[test]
fn matches_recorded_typescript_parser_output() {
    // Captured from the repository's parser.test.ts, including the prototype controls.
    for line in include_str!("fixtures/tool-activity.jsonl")
        .lines()
        .chain(include_str!("fixtures/association-syntax.jsonl").lines())
        .chain(include_str!("fixtures/review-compatibility.jsonl").lines())
    {
        let RecordedActivity { call, expected } = serde_json::from_str(line).unwrap();
        let actual = serde_json::to_value(analyze_activity(&call)).unwrap();
        assert_eq!(actual, expected, "{call:?}");
    }
}

#[hegel::test]
fn quoted_data_comments_and_heredocs_do_not_create_activities(tc: TestCase) {
    let noise = || {
        tc.draw(
            gs::text()
                .max_size(60)
                .alphabet("abc XYZ012/\\'\"`$(){}[];|&<>\n\t#"),
        )
    };
    let payload = format!("{}\n{}\n{}", noise(), leaf(&tc).0, noise());
    let literal = json!(payload);
    assert!(labels(&js(&format!(
        "const data = {{cmd:{literal}}}; const text = {literal};"
    )))
    .is_empty());
    let comments = payload
        .split('\n')
        .map(|line| format!("# {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(
        labels(&shell(&format!("git status\n{comments}\n"))),
        BTreeSet::from(["Git inspection"])
    );
    assert_eq!(
        labels(&shell(&format!("rg -- {} src", quote(&payload)))),
        BTreeSet::from(["source search"])
    );
    let row = shell(&format!(
        "cat > /tmp/generated.txt <<'PAYLOAD_END'\n{payload}\nPAYLOAD_END\n"
    ));
    assert!(labels(&row).iter().all(|label| *label == "file edits"));
    if labels(&row).is_empty() {
        assert!(row.operations.iter().any(|op| op.unresolved.is_some()));
    }
}

#[hegel::test]
fn sequences_preserve_sources_activities_and_repeats(tc: TestCase) {
    let (commands, expected): (Vec<_>, Vec<_>) = leaves(&tc, 18).into_iter().unzip();
    let row = shell(&commands.join("; "));
    assert_eq!(sources(&row), commands);
    let actual: Vec<_> = row
        .operations
        .iter()
        .map(|op| op.activities[0].as_str())
        .collect();
    assert_eq!(actual, expected);
}

struct ConditionalLeaf {
    source: &'static str,
    conditions: BTreeSet<&'static str>,
}

fn condition_tree(tc: &TestCase, depth: usize) -> (String, Vec<ConditionalLeaf>) {
    if depth == 3 || tc.draw(gs::booleans()) {
        let (source, _) = leaf(tc);
        return (
            source.into(),
            vec![ConditionalLeaf {
                source,
                conditions: BTreeSet::new(),
            }],
        );
    }
    let (left, mut leaves) = condition_tree(tc, depth + 1);
    let (right, mut governed) = condition_tree(tc, depth + 1);
    let (operator, relation) = if tc.draw(gs::booleans()) {
        ("&&", "on success")
    } else {
        ("||", "on failure")
    };
    for leaf in &mut governed {
        leaf.conditions.insert(relation);
    }
    leaves.extend(governed);
    (format!("( {left} ) {operator} ( {right} )"), leaves)
}

#[hegel::test]
fn conditions_apply_only_to_governed_operations(tc: TestCase) {
    let (code, expected) = condition_tree(&tc, 0);
    let row = shell(&code);
    assert_eq!(row.operations.len(), expected.len());
    for (op, leaf) in row.operations.iter().zip(expected) {
        assert_eq!(op.source, leaf.source);
        let conditions: BTreeSet<_> = op
            .relationships
            .iter()
            .map(String::as_str)
            .filter(|rel| matches!(*rel, "on success" | "on failure"))
            .collect();
        assert_eq!(conditions, leaf.conditions);
    }
}

#[hegel::test]
fn pipelines_and_background_commands_preserve_request_relationships(tc: TestCase) {
    let (first, activity) = leaf(&tc);
    let (second, _) = leaf(&tc);
    let filters = ["grep marker", "head -5", "sort", "wc -l"];
    let count = tc.draw(gs::integers::<usize>().min_value(1).max_value(8));
    let pipeline = std::iter::once(first)
        .chain(
            (0..count)
                .map(|_| filters[tc.draw(gs::integers::<usize>().max_value(filters.len() - 1))]),
        )
        .collect::<Vec<_>>()
        .join(" | ");
    let row = shell(&pipeline);
    assert_eq!(labels(&row), BTreeSet::from([activity]));
    assert!(row
        .operations
        .iter()
        .all(|op| op.relationships.iter().any(|rel| rel == "pipeline")));

    let row = shell(&format!("{first} & {second}"));
    assert_eq!(sources(&row), [first, second]);
    assert!(row.operations.iter().all(|op| op
        .relationships
        .iter()
        .any(|rel| rel == "background / parallel")));
}

#[hegel::test]
fn nested_javascript_wrappers_preserve_operations_and_unresolved_calls(tc: TestCase) {
    let (commands, expected): (Vec<_>, Vec<_>) = leaves(&tc, 12).into_iter().unzip();
    let parallel = tc.draw(gs::booleans());
    let mut calls = commands
        .iter()
        .map(|cmd| format!("tools.exec_command({{cmd:{}}})", json!(cmd)))
        .collect::<Vec<_>>();
    calls.push("tools.exec_command(dynamic)".into());
    let code = if parallel {
        format!("await Promise.all([{}]);", calls.join(","))
    } else {
        format!("await {};", calls.join("; await "))
    };
    let row = js(&code);
    assert_eq!(row.operations.len(), commands.len() + 1);
    for ((op, cmd), label) in row.operations.iter().zip(commands).zip(expected) {
        assert_eq!(op.source, cmd);
        assert_eq!(op.activities, [label]);
    }
    assert!(row.operations.iter().any(|op| op.unresolved.is_some()));
    for op in &row.operations {
        assert!(op
            .relationships
            .iter()
            .any(|rel| rel == "nested invocation (requested)"));
        assert_eq!(
            op.relationships
                .iter()
                .any(|rel| rel == "parallel requests"),
            parallel
        );
    }
}

#[hegel::test]
fn arbitrary_fragments_are_total_and_deterministic(tc: TestCase) {
    let text = tc.draw(gs::text().max_size(160));
    let names = ["exec", "exec_command", "ruby", "powershell", "Read", "Grep"];
    let name = names[tc.draw(gs::integers::<usize>().max_value(names.len() - 1))];
    let call = input(name, json!({"cmd":text, "code":text}));
    let before = serde_json::to_value(&call).unwrap();
    let result = analyze_activity(&call);
    assert!(!result.operations.is_empty());
    assert_eq!(before, serde_json::to_value(&call).unwrap());
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        serde_json::to_value(analyze_activity(&call)).unwrap()
    );
    match name {
        "Read" => assert_eq!(labels(&result), BTreeSet::from(["source inspection"])),
        "Grep" => assert_eq!(labels(&result), BTreeSet::from(["source search"])),
        "ruby" | "powershell" => assert!(labels(&result).is_empty()),
        _ => {}
    }
}

#[hegel::test]
fn python_edit_implementations_absorb_reads_but_not_printed_commands(tc: TestCase) {
    let reads = tc.draw(gs::integers::<usize>().max_value(5));
    let writes = tc.draw(gs::integers::<usize>().min_value(1).max_value(4));
    let snippet = leaf(&tc).0;
    let mut program = String::from("from pathlib import Path\np = Path('src/generated.py')\n");
    program.push_str(&"before = p.read_text()\n".repeat(reads));
    program.push_str(&format!("p.write_text({})\n", json!(snippet)).repeat(writes));
    let row = shell(&format!("python3 - <<'PY_END'\n{program}PY_END\n"));
    assert_eq!(labels(&row), BTreeSet::from(["file edits"]));
    assert_eq!(row.operations.len(), 1);
    let printed = format!("{snippet}; p.write_text('x'); open('a')");
    let row = shell(&format!(
        "python3 - <<'PY_END'\nprint({})\nPY_END\n",
        json!(printed)
    ));
    assert!(labels(&row).is_empty());
}

#[hegel::test]
fn literal_shell_wrappers_only_add_the_wrapper_relationship(tc: TestCase) {
    let commands = leaves(&tc, 12)
        .into_iter()
        .map(|(source, _)| source)
        .collect::<Vec<_>>();
    let paths = ["/bin/zsh", "/bin/bash", "/bin/sh", "zsh", "bash", "sh"];
    let flags = ["-c", "-lc", "-ic"];
    let executable = paths[tc.draw(gs::integers::<usize>().max_value(paths.len() - 1))];
    let flag = flags[tc.draw(gs::integers::<usize>().max_value(flags.len() - 1))];
    let source = commands.join("; ");
    let mut wrapped = shell(&format!("{executable} {flag} {}", quote(&source)));
    for op in &mut wrapped.operations {
        assert!(op
            .relationships
            .iter()
            .any(|rel| rel == "shell wrapper (requested)"));
        op.relationships
            .retain(|rel| rel != "shell wrapper (requested)");
    }
    assert_eq!(
        serde_json::to_value(wrapped).unwrap(),
        serde_json::to_value(shell(&source)).unwrap()
    );
}

#[hegel::test]
fn git_option_values_do_not_inject_commands(tc: TestCase) {
    let path = tc.draw(gs::text().max_size(70).alphabet("abc XYZ012/;|&$()\n"));
    let unknown = format!("unknown-command --text {}", quote(&path));
    let row = shell(&format!(
        "git -C {} status; gh pr view 531 --json url; {unknown}",
        quote(&path)
    ));
    assert_eq!(
        labels(&row),
        BTreeSet::from(["Git inspection", "GitHub inspection"])
    );
    let eligible: Vec<_> = row
        .operations
        .iter()
        .filter(|op| op.decision_eligible == Some(true))
        .map(|op| op.source.as_str())
        .collect();
    assert_eq!(eligible, [unknown]);
}

#[test]
fn parses_a_200_call_group_in_under_50ms() {
    let calls: Vec<_> = include_str!("fixtures/tool-activity.jsonl")
        .lines()
        .cycle()
        .take(200)
        .map(|line| serde_json::from_str::<RecordedActivity>(line).unwrap().call)
        .collect();
    // Initialize regex tables outside the measured path.
    for call in &calls {
        std::hint::black_box(analyze_activity(call));
    }
    let start = Instant::now();
    let rows: Vec<_> = calls.iter().map(analyze_activity).collect();
    let elapsed = start.elapsed();
    assert_eq!(rows.len(), 200);
    eprintln!("200-call parser: {elapsed:?}");
    assert!(elapsed < Duration::from_millis(50), "{elapsed:?}");
}

#[test]
fn long_flat_shell_sequence_honors_the_deadline() {
    let code = "true;".repeat(20_000);
    let start = Instant::now();
    let row = shell(&code);
    let duration = start.elapsed();
    assert!(duration < Duration::from_millis(500), "{duration:?}");
    assert_eq!(row.operations.len(), 1);
    assert_eq!(
        row.operations[0].unresolved.as_deref(),
        Some("Tool activity analysis exceeded its time budget")
    );
    assert_ne!(row.operations[0].decision_eligible, Some(true));
    eprintln!("20,000-command shell input returned in {duration:?}");
}
