//! Node matching on fixture pairs written for this crate.

use super::*;

fn semantic(path: &str, old: &str, new: &str) -> Vec<SemanticChange> {
    let budget = Budget {
        time: Duration::from_secs(10),
        ..Budget::default()
    };
    let grammar = Grammar::for_path(path).expect("a supported path");
    node_changes(grammar, old, new, &budget)
        .unwrap_or_else(|reason| panic!("fell back: {reason:?}"))
}

fn kinds(changes: &[SemanticChange]) -> Vec<&'static str> {
    changes
        .iter()
        .map(|change| match change.edit {
            Edit::Insert { .. } => "insert",
            Edit::Delete { .. } => "delete",
            Edit::Update { .. } => "update",
            Edit::Move { .. } => "move",
            Edit::Rename { .. } => "rename",
        })
        .collect()
}

fn scope_names(change: &SemanticChange) -> Vec<&str> {
    change
        .scope
        .iter()
        .map(|segment| segment.name.as_str())
        .collect()
}

const ACCOUNT: &str = r#"pub struct Account {
    balance: i64,
}

impl Account {
    pub fn deposit(&mut self, amount: i64) {
        self.balance += amount;
    }

    pub fn withdraw(&mut self, amount: i64) -> bool {
        if amount > self.balance {
            return false;
        }
        self.balance -= amount;
        true
    }
}
"#;

#[test]
fn inserted_function_is_one_insert_in_its_impl() {
    let new = ACCOUNT.replace(
        "    pub fn withdraw",
        "    pub fn reset(&mut self) {\n        self.balance = 0;\n    }\n\n    pub fn withdraw",
    );
    let changes = semantic("a.rs", ACCOUNT, &new);
    assert_eq!(kinds(&changes), ["insert"], "{changes:#?}");
    let change = &changes[0];
    assert_eq!(change.node_kind, "function_item");
    assert_eq!(scope_names(change), ["Account", "reset"]);
    assert_eq!(change.edit.spans(), (None, Some(LineSpan::new(10, 12))));
}

#[test]
fn deleted_function_is_one_delete() {
    let old = ACCOUNT;
    let new = ACCOUNT.replace(
        "    pub fn deposit(&mut self, amount: i64) {\n        self.balance += amount;\n    }\n\n",
        "",
    );
    let changes = semantic("a.rs", old, &new);
    assert_eq!(kinds(&changes), ["delete"], "{changes:#?}");
    assert_eq!(changes[0].edit.spans(), (Some(LineSpan::new(6, 8)), None));
    assert_eq!(scope_names(&changes[0]), ["Account", "deposit"]);
}

#[test]
fn changed_literal_is_an_update_scoped_to_its_function() {
    let new = ACCOUNT.replace("        true\n", "        false\n");
    let changes = semantic("a.rs", ACCOUNT, &new);
    assert_eq!(kinds(&changes), ["update"], "{changes:#?}");
    let change = &changes[0];
    assert_eq!(scope_names(change), ["Account", "withdraw"]);
    assert_eq!(change.scope[1].new_line, Some(10));
    assert_eq!(change.scope[1].old_line, Some(10));
    assert!(!change.signature);
}

#[test]
fn reordered_functions_are_one_move() {
    let new = r#"pub struct Account {
    balance: i64,
}

impl Account {
    pub fn withdraw(&mut self, amount: i64) -> bool {
        if amount > self.balance {
            return false;
        }
        self.balance -= amount;
        true
    }

    pub fn deposit(&mut self, amount: i64) {
        self.balance += amount;
    }
}
"#;
    let changes = semantic("a.rs", ACCOUNT, new);
    assert_eq!(kinds(&changes), ["move"], "{changes:#?}");
    // The smaller function moved; the larger one kept its place.
    assert_eq!(
        changes[0].edit.spans(),
        (Some(LineSpan::new(6, 8)), Some(LineSpan::new(14, 16)))
    );
    assert_eq!(scope_names(&changes[0]), ["Account", "deposit"]);
}

#[test]
fn function_moved_between_impls_is_a_move() {
    let old = "impl A {\n    fn keep(&self) -> u8 { 1 }\n    fn shift(&self) -> u8 { let x = 2; x * 3 }\n}\n\nimpl B {\n    fn other(&self) -> u8 { 4 }\n}\n";
    let new = "impl A {\n    fn keep(&self) -> u8 { 1 }\n}\n\nimpl B {\n    fn other(&self) -> u8 { 4 }\n    fn shift(&self) -> u8 { let x = 2; x * 3 }\n}\n";
    let changes = semantic("a.rs", old, new);
    assert_eq!(kinds(&changes), ["move"], "{changes:#?}");
    assert_eq!(scope_names(&changes[0]), ["B", "shift"]);
    assert_eq!(
        changes[0].edit.spans(),
        (Some(LineSpan::new(3, 3)), Some(LineSpan::new(7, 7)))
    );
}

#[test]
fn renamed_local_is_one_rename_with_every_use() {
    let old = r#"fn total(items: &[u32]) -> u32 {
    let mut sum = 0;
    for item in items {
        sum += item;
    }
    if sum > 100 {
        sum = 100;
    }
    println!("{}", sum);
    sum
}
"#;
    let new = old.replace("sum", "acc");
    let changes = semantic("a.rs", old, &new);
    assert_eq!(kinds(&changes), ["rename"], "{changes:#?}");
    let Edit::Rename {
        from,
        to,
        occurrences,
        new: binding,
        ..
    } = &changes[0].edit
    else {
        unreachable!()
    };
    assert_eq!((from.as_str(), to.as_str()), ("sum", "acc"));
    assert_eq!(binding.start, 2, "anchored on the `let`");
    // The macro's token tree reports the identifier too.
    assert_eq!(occurrences.len(), 6, "{occurrences:#?}");
    assert_eq!(scope_names(&changes[0]), ["total"]);
}

#[test]
fn reformatting_a_rust_function_has_no_changes() {
    let old = "fn add(a: i32, b: i32) -> i32 { let c = a + b; c }\n";
    let new = "fn add(\n    a: i32,\n    b: i32,\n) -> i32 {\n    let c = a +   b;\n    c\n}\n";
    assert!(semantic("a.rs", old, new).is_empty());
}

#[test]
fn whitespace_inside_string_literals_is_a_change() {
    // Trailing, leading, internal and whitespace-only string content, in
    // every literal form each grammar has.
    let cases: &[(&str, &str, &str)] = &[
        (
            "a.rs",
            r#"fn f() -> &'static str { "hello " }"#,
            r#"fn f() -> &'static str { "hello" }"#,
        ),
        (
            "a.rs",
            r#"fn f() -> &'static str { " " }"#,
            r#"fn f() -> &'static str { "" }"#,
        ),
        (
            "a.rs",
            r#"fn f() -> &'static str { "a  b" }"#,
            r#"fn f() -> &'static str { "a b" }"#,
        ),
        (
            "a.rs",
            r##"fn f() -> &'static str { r"ab " }"##,
            r##"fn f() -> &'static str { r"ab" }"##,
        ),
        ("a.rs", "fn f() -> char { ' ' }", "fn f() -> char { '\t' }"),
        ("a.ts", "const a = `ab `;", "const a = `ab`;"),
        ("a.ts", "const a = 'ab ';", "const a = 'ab';"),
        ("a.ts", "const a = \" \";", "const a = \"\";"),
        ("a.ts", "const a = `x ${b} `;", "const a = `x ${b}`;"),
        ("a.js", "const a = 'ab ';", "const a = 'ab';"),
        ("a.py", "a = 'ab '\n", "a = 'ab'\n"),
        ("a.py", "a = ' '\n", "a = ''\n"),
        ("a.py", "a = 'a\\n '\n", "a = 'a\\n'\n"),
        ("a.py", "a = f'x {b} '\n", "a = f'x {b}'\n"),
        ("a.py", "a = \"\"\"doc \"\"\"\n", "a = \"\"\"doc\"\"\"\n"),
    ];
    for (path, old, new) in cases {
        let forward = semantic(path, old, new);
        assert!(!forward.is_empty(), "{path}: {old} → {new}");
        assert!(
            !semantic(path, new, old).is_empty(),
            "{path}: {new} → {old}"
        );
    }
}

#[test]
fn layout_around_string_literals_and_interpolations_is_not_a_change() {
    let cases: &[(&str, &str, &str)] = &[
        (
            "a.rs",
            r#"fn f() { g("a b",1) }"#,
            "fn f() {\n    g(\"a b\", 1)\n}",
        ),
        ("a.ts", "const a = `x ${ b } y`;", "const a = `x ${b} y`;"),
        (
            "a.py",
            "a = f'x {b} y'\nc = ('p'  'q')\n",
            "a = f'x {b} y'\nc = ('p' 'q')\n",
        ),
    ];
    for (path, old, new) in cases {
        let changes = semantic(path, old, new);
        assert!(changes.is_empty(), "{path}: {changes:#?}");
    }
}

#[test]
fn typescript_change_is_scoped_to_its_exported_function() {
    let old = r#"export default function f(items: string[]): number {
  let count = 0;
  for (const item of items) {
    if (item.length > 2) {
      count += 1;
    }
  }
  return count;
}
"#;
    let new = old.replace("count += 1;", "count += 2;");
    let changes = semantic("view.tsx", old, &new);
    assert_eq!(kinds(&changes), ["update"], "{changes:#?}");
    assert_eq!(scope_names(&changes[0]), ["f"]);
    assert_eq!(changes[0].scope[0].new_line, Some(1));
    assert_eq!(changes[0].edit.spans().1, Some(LineSpan::new(5, 5)));
}

#[test]
fn arrow_function_constants_are_scopes() {
    let old = "export const pick = (xs: number[]) => {\n  return xs[0];\n};\n";
    let new = "export const pick = (xs: number[]) => {\n  return xs[1];\n};\n";
    let changes = semantic("a.ts", old, new);
    assert_eq!(scope_names(&changes[0]), ["pick"]);
}

#[test]
fn python_method_insert_is_scoped_to_its_class() {
    let old = "class Greeter:\n    def hello(self):\n        return 'hi'\n";
    let new = "class Greeter:\n    def hello(self):\n        return 'hi'\n\n    def bye(self):\n        return 'bye'\n";
    let changes = semantic("g.py", old, new);
    assert_eq!(kinds(&changes), ["insert"], "{changes:#?}");
    assert_eq!(scope_names(&changes[0]), ["Greeter", "bye"]);
}

#[test]
fn unsupported_and_broken_files_fall_back() {
    let budget = Budget::default();
    assert_eq!(
        diff("notes.md", "a", "b", &budget),
        SemanticOutcome::Fallback {
            reason: FallbackReason::UnsupportedLanguage
        }
    );
    assert_eq!(
        diff("a.rs", "fn a() {}", "fn a( {}", &budget),
        SemanticOutcome::Fallback {
            reason: FallbackReason::SyntaxError
        }
    );
    let tiny = Budget {
        max_bytes: 4,
        ..budget
    };
    assert_eq!(
        diff("a.rs", "fn a() {}", "fn b() {}", &tiny),
        SemanticOutcome::Fallback {
            reason: FallbackReason::TooLarge
        }
    );
    let instant = Budget {
        time: Duration::ZERO,
        ..budget
    };
    assert_eq!(
        diff("a.rs", "fn a() {}", "fn b() {}", &instant),
        SemanticOutcome::Fallback {
            reason: FallbackReason::TimedOut
        }
    );
}

#[test]
fn a_leading_comment_moves_with_its_function() {
    // `main` is longer, so `first` (with its comment) is what moved.
    let main = "export function main() {\n  const a = first([1, 2]);\n  const b = first([3]);\n  return a + b;\n}\n";
    let first = "/** Picks the first. */\nfunction first(xs: number[]) {\n  return xs[0];\n}\n";
    let (old, new) = (format!("{first}\n{main}"), format!("{main}\n{first}"));
    let (old, new) = (old.as_str(), new.as_str());
    let changes = semantic("a.ts", old, new);
    assert_eq!(kinds(&changes), ["move"], "{changes:#?}");
    assert_eq!(
        changes[0].edit.spans(),
        (Some(LineSpan::new(1, 4)), Some(LineSpan::new(7, 10)))
    );
}

/// `keyword name` of each segment, e.g. `["impl Account", "fn reset"]`.
fn labels(change: &SemanticChange) -> Vec<String> {
    change
        .scope
        .iter()
        .map(|segment| format!("{} {}", segment.keyword, segment.name))
        .collect()
}

fn declared(changes: &[SemanticChange]) -> Vec<(&'static str, String)> {
    changes
        .iter()
        .filter(|change| change.declares)
        .map(|change| {
            let last = change.scope.last().expect("a declaration");
            (
                kinds(std::slice::from_ref(change))[0],
                format!("{} {}", last.keyword, last.name),
            )
        })
        .collect()
}

#[test]
fn declarations_carry_their_kind_and_source_keyword() {
    let old = "use std::fmt;\n\npub struct Account {\n    balance: i64,\n}\n\nimpl fmt::Display for Account {\n    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {\n        write!(f, \"{}\", self.balance)\n    }\n}\n\nstatic LIMIT: i64 = 5;\n";
    let new = old
        .replace("balance: i64", "balance: u64")
        .replace("\"{}\"", "\"{} cents\"")
        .replace("= 5", "= 6");
    let changes = semantic("a.rs", old, &new);
    let scopes: Vec<Vec<String>> = changes.iter().map(labels).collect();
    assert_eq!(
        scopes,
        [
            vec!["struct Account", "field balance"],
            vec!["impl fmt::Display for Account", "fn fmt"],
            vec!["static LIMIT"],
        ],
        "{changes:#?}"
    );
    assert_eq!(changes[0].scope[1].kind, DeclarationKind::Field);
    assert_eq!(changes[1].scope[1].kind, DeclarationKind::Method);
    assert!(changes.iter().all(|change| !change.declares));
}

#[test]
fn adjacent_added_declarations_are_one_change_each() {
    let old = "fn a() {}\n";
    let new = "fn a() {}\n\n/// Second.\nfn b() {}\n\n#[test]\nfn c() {}\n";
    let changes = semantic("a.rs", old, new);
    assert_eq!(
        declared(&changes),
        [("insert", "fn b".into()), ("insert", "fn c".into())],
        "{changes:#?}"
    );
    // The doc comment and attribute travel with their function.
    assert_eq!(changes[0].edit.spans().1, Some(LineSpan::new(3, 4)));
    assert_eq!(changes[1].edit.spans().1, Some(LineSpan::new(6, 7)));
}

#[test]
fn fields_variants_and_imports_are_declarations() {
    let old = "use std::fmt;\n\nstruct P {\n    x: i32,\n}\n\nenum Mode {\n    Fast,\n}\n";
    let new = "use std::fmt;\nuse std::io;\n\nstruct P {\n    x: i32,\n    y: i32,\n}\n\nenum Mode {\n    Fast,\n    Slow,\n}\n";
    let changes = semantic("a.rs", old, new);
    assert_eq!(
        declared(&changes),
        [
            ("insert", "use std::io".into()),
            ("insert", "field y".into()),
            ("insert", "variant Slow".into()),
        ],
        "{changes:#?}"
    );
    assert_eq!(labels(&changes[1]), ["struct P", "field y"]);
}

#[test]
fn typescript_wrappers_declare_what_they_wrap() {
    let old = "import { a } from \"./a\";\n\nexport class Box {\n  size = 1;\n}\n";
    let new = "import { a, b } from \"./a\";\nimport type { C } from \"./c\";\n\nexport class Box {\n  size = 1;\n  label = \"\";\n  open(): void {}\n}\n\nexport const pick = (xs: number[]) => xs[0];\n\nexport enum Mode {\n  Fast,\n}\n";
    let changes = semantic("a.ts", old, new);
    assert_eq!(
        declared(&changes),
        [
            ("insert", "import b".into()),
            ("insert", "import ./c".into()),
            ("insert", "field label".into()),
            ("insert", "method open".into()),
            ("insert", "const pick".into()),
            ("insert", "enum Mode".into()),
        ],
        "{changes:#?}"
    );
}

#[test]
fn python_decorated_and_async_definitions_are_declarations() {
    let old = "import os\n\nclass A:\n    pass\n";
    let new = "import os\nfrom typing import Any\n\nclass A:\n    pass\n\n@cache\nasync def load():\n    return 1\n\nLIMIT = 3\n";
    let changes = semantic("a.py", old, new);
    assert_eq!(
        declared(&changes),
        [
            ("insert", "from typing".into()),
            ("insert", "def load".into()),
            ("insert", "const LIMIT".into()),
        ],
        "{changes:#?}"
    );
}

#[test]
fn a_moved_exported_function_declares_it() {
    let f = "export function first(xs: number[]) {\n  return xs[0];\n}\n";
    let main = "export function main() {\n  const a = first([1, 2]);\n  const b = first([3]);\n  return a + b;\n}\n";
    let (old, new) = (format!("{f}\n{main}"), format!("{main}\n{f}"));
    let changes = semantic("a.ts", &old, &new);
    assert_eq!(
        declared(&changes),
        [("move", "function first".into())],
        "{changes:#?}"
    );
}

#[test]
fn a_new_file_diffs_against_an_empty_side() {
    let new = "pub fn a() {}\n\npub struct B;\n";
    let changes = semantic("a.rs", "", new);
    assert_eq!(
        declared(&changes),
        [("insert", "fn a".into()), ("insert", "struct B".into())]
    );
    let removed = semantic("a.rs", new, "");
    assert_eq!(
        declared(&removed),
        [("delete", "fn a".into()), ("delete", "struct B".into())]
    );
}

#[test]
fn a_function_replaced_in_place_is_a_removal_and_an_addition() {
    let old = "fn keep() {}\n\nfn legacy_report(accounts: &[u8]) -> String {\n    accounts.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(\"\\n\")\n}\n";
    let new = "fn keep() {}\n\nfn apply(account: &mut u8, entry: u8) {\n    match entry {\n        0 => *account += 1,\n        _ => *account -= 1,\n    }\n}\n";
    let changes = semantic("a.rs", old, new);
    assert_eq!(
        declared(&changes),
        [
            ("insert", "fn apply".into()),
            ("delete", "fn legacy_report".into())
        ],
        "{changes:#?}"
    );
}

// Each matching heuristic has a fixture here that fails without it.

/// Recovery pairs identical children beside matched neighbours first.
#[test]
fn swapped_functions_keep_their_identical_leading_comments() {
    let function = |name: &str| {
        format!("// note\nfunction {name}(x: number): number {{\n    return x;\n}}\n\n")
    };
    let tail = "function f3(x: number): number {\n    return x;\n}\n";
    let old = format!("{}{}{tail}", function("f1"), function("f2"));
    let new = format!("{}{}{tail}", function("f2"), function("f1"));
    let changes = semantic("a.ts", &old, &new);
    assert_eq!(kinds(&changes), ["move"], "{changes:#?}");
}

/// Recovery aligns identical children in order (patience) before pairing
/// by kind, which would scatter a long list.
#[test]
fn one_entry_added_to_a_long_macro_list_is_one_insert() {
    let names = |n: usize| (0..n).map(|i| format!("c{i}")).collect::<Vec<_>>();
    let render = |names: &[String]| {
        format!(
            "fn main() {{\n    run(handler![{}]);\n}}\n",
            names.join(", ")
        )
    };
    let mut more = names(200);
    more.insert(100, "added".into());
    let changes = semantic("a.rs", &render(&names(200)), &render(&more));
    assert_eq!(kinds(&changes), ["insert"], "{} changes", changes.len());
}

/// A trailing comment's own-line sibling is the one before it: neighbours
/// weigh by that, and the comment moves with that statement.
#[test]
fn trailing_comments_move_with_their_statement() {
    for (path, old, new) in [
        (
            "a.rs",
            "fn f() {\n    let a = 1; // same\n    let b = 2; // same\n    let c = 3;\n    let d = 4;\n}\n",
            "fn f() {\n    let b = 2; // same\n    let a = 1; // same\n    let c = 3;\n    let d = 4;\n}\n",
        ),
        (
            "a.ts",
            "function f() {\n  g(1); // same\n  h(2); // same\n  k(3);\n  m(4);\n}\n",
            "function f() {\n  h(2); // same\n  g(1); // same\n  k(3);\n  m(4);\n}\n",
        ),
    ] {
        let changes = semantic(path, old, new);
        assert_eq!(kinds(&changes), ["move"], "{path}: {changes:#?}");
    }
}

fn declarations(path: &str, old: &str, new: &str) -> Vec<DeclarationDiff> {
    let budget = Budget {
        time: Duration::from_secs(10),
        ..Budget::default()
    };
    match diff(path, old, new, &budget) {
        SemanticOutcome::Semantic { declarations, .. } => declarations,
        SemanticOutcome::Fallback { reason } => panic!("fell back: {reason:?}"),
    }
}

/// `subject` as `keyword name`, under its scope's names.
fn place(declaration: &DeclarationDiff) -> (Vec<&str>, Option<String>) {
    (
        declaration.scope.iter().map(|s| s.name.as_str()).collect(),
        declaration
            .subject
            .as_ref()
            .map(|s| format!("{} {}", s.keyword, s.name)),
    )
}

#[test]
fn edits_inside_one_function_are_one_declaration() {
    let old = "fn total(items: &[u32]) -> u32 {\n    let mut sum = 0;\n    for item in items {\n        sum += item;\n    }\n    sum + 1\n}\n";
    let new = old.replace("sum", "acc").replace("+ 1", "+ 2");
    let found = declarations("a.rs", old, &new);
    assert_eq!(found.len(), 1, "{found:#?}");
    assert_eq!(place(&found[0]), (vec![], Some("fn total".into())));
    assert_eq!(found[0].change, DeclarationChange::Modified);
    let parts: Vec<_> = found[0]
        .parts
        .iter()
        .map(|part| match part {
            Part::Renamed {
                from, to, sites, ..
            } => format!("renamed {from} → {to} ×{}", sites.len()),
            Part::Changed { .. } => "changed".into(),
            other => format!("{other:?}"),
        })
        .collect();
    assert_eq!(parts, ["renamed sum → acc ×3", "changed"]);
}

#[test]
fn a_renamed_function_edited_inside_is_one_renamed_declaration() {
    let old =
        "fn total(xs: &[u8]) -> usize {\n    xs.len() + 1\n}\n\nfn main() {\n    total(&[]);\n}\n";
    let new = old.replace("total", "count").replace("+ 1", "+ 2");
    let found = declarations("a.rs", old, &new);
    let renamed: Vec<_> = found
        .iter()
        .filter(|d| matches!(d.change, DeclarationChange::Renamed { .. }))
        .collect();
    assert_eq!(renamed.len(), 1, "{found:#?}");
    assert_eq!(place(renamed[0]), (vec![], Some("fn count".into())));
    assert!(
        renamed[0]
            .parts
            .iter()
            .any(|part| matches!(part, Part::Changed { .. })),
        "{found:#?}"
    );
}

#[test]
fn a_field_change_belongs_to_its_struct_and_an_added_field_is_its_own() {
    let old = "pub struct Account {\n    id: u32,\n    balance: i64,\n}\n";
    let changed = old.replace("balance: i64", "balance: u64");
    let found = declarations("a.rs", old, &changed);
    assert_eq!(found.len(), 1, "{found:#?}");
    assert_eq!(place(&found[0]), (vec![], Some("struct Account".into())));
    assert_eq!(found[0].change, DeclarationChange::Modified);

    let added = old.replace("}\n", "    owner: String,\n}\n");
    let found = declarations("a.rs", old, &added);
    assert_eq!(found.len(), 1, "{found:#?}");
    assert_eq!(
        place(&found[0]),
        (vec!["Account"], Some("field owner".into()))
    );
    assert!(matches!(found[0].change, DeclarationChange::Added { .. }));
}

#[test]
fn a_parameter_change_is_a_signature_part() {
    let new = ACCOUNT.replace(
        "deposit(&mut self, amount: i64)",
        "deposit(&mut self, amount: u64)",
    );
    let found = declarations("a.rs", ACCOUNT, &new);
    assert_eq!(found.len(), 1, "{found:#?}");
    assert_eq!(
        place(&found[0]),
        (vec!["Account"], Some("fn deposit".into()))
    );
    assert!(
        !found[0].parts.is_empty()
            && found[0]
                .parts
                .iter()
                .all(|part| matches!(part, Part::Signature { .. })),
        "{found:#?}"
    );
}
