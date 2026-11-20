//! Fixture pairs for semantic diff facts: every fact category in every
//! supported language, written for this repository. Expectations are
//! exact: a fixture lists every fact its diff reports.

use std::collections::BTreeSet;
use vertebrae_syntax::semantic::{
    self, Budget, DeclarationChange, DeclarationDiff, Fact, FactCategory, FactChange, FactKind,
    LineSpan, SemanticOutcome,
};

fn word<T: serde::Serialize>(value: T) -> String {
    match serde_json::to_value(value).unwrap() {
        serde_json::Value::String(s) => s,
        serde_json::Value::Object(o) => o["type"].as_str().unwrap().to_owned(),
        other => panic!("{other}"),
    }
}

/// A fact as `+kind subject`, `-kind subject`, `~kind from → to` or
/// `@kind`, with effects as `effect.<kind>`.
fn line(fact: &Fact) -> String {
    let kind = match fact.kind {
        FactKind::Effect { effect } => format!("effect.{}", word(effect)),
        kind => word(kind),
    };
    match &fact.change {
        FactChange::Added { subject } => format!("+{kind} {subject}"),
        FactChange::Removed { subject } => format!("-{kind} {subject}"),
        FactChange::Changed { from, to } => format!("~{kind} {from} → {to}"),
        FactChange::Inside => format!("@{kind}"),
    }
}

fn declarations(path: &str, old: &str, new: &str) -> Vec<DeclarationDiff> {
    match semantic::diff(path, old, new, &Budget::default()) {
        SemanticOutcome::Semantic { declarations, .. } => declarations,
        SemanticOutcome::Fallback { reason } => panic!("{path} fell back: {reason:?}"),
    }
}

fn facts(path: &str, old: &str, new: &str) -> Vec<Fact> {
    declarations(path, old, new)
        .iter()
        .flat_map(|d| {
            d.facts
                .items
                .iter()
                .chain(d.parts.iter().flat_map(|part| &part.facts().items))
                .cloned()
                .collect::<Vec<_>>()
        })
        .collect()
}

fn lines(path: &str, old: &str, new: &str) -> BTreeSet<String> {
    facts(path, old, new).iter().map(line).collect()
}

struct Fixture {
    path: &'static str,
    category: FactCategory,
    old: &'static str,
    new: &'static str,
    /// Every line (see [`line`]) the diff reports.
    expect: &'static [&'static str],
}

const RUST: &[Fixture] = &[
    Fixture {
        path: "src/sync.rs",
        category: FactCategory::Calls,
        old: "fn sync(state: &State) {\n    state.flush();\n}\n",
        new: "fn sync(state: &State) {\n    state.flush();\n    retry(state);\n    state.queue.drain();\n}\n",
        expect: &["+call retry", "+call state.queue.drain"],
    },
    Fixture {
        path: "src/sync.rs",
        category: FactCategory::Effects,
        old: "fn save(path: &Path, body: &str) {\n    log(body);\n}\n",
        new: "fn save(path: &Path, body: &str) {\n    std::fs::write(path, body);\n    let home = env::var(\"HOME\");\n    Command::new(\"git\").status();\n    app.emit(\"saved\", ());\n}\n",
        expect: &[
            "+effect.filesystem std::fs::write",
            "+effect.env env::var",
            "+effect.process Command::new",
            "+effect.event app.emit",
            "+call Command::new(…).status",
            "-call log",
        ],
    },
    Fixture {
        path: "src/commands.rs",
        category: FactCategory::Effects,
        old: "fn list_tasks() -> Vec<Task> {\n    Vec::new()\n}\n",
        new: "#[tauri::command]\nfn list_tasks() -> Vec<Task> {\n    Vec::new()\n}\n",
        expect: &["+effect.ipc_command tauri::command"],
    },
    Fixture {
        path: "src/flow.rs",
        category: FactCategory::ControlFlow,
        old: "fn step(x: u32) -> u32 {\n    if x > 1 {\n        go();\n    }\n    match x {\n        0 => 1,\n        _ => 2,\n    }\n}\n",
        new: "fn step(x: u32) -> u32 {\n    if x > 2 {\n        go();\n    }\n    for item in items() {\n        if item == x {\n            return item;\n        }\n    }\n    match x {\n        0 => 1,\n        1 => 3,\n        _ => 2,\n    }\n}\n",
        expect: &[
            "~branch x > 1 → x > 2",
            "+loop items()",
            "+branch item == x",
            "+early_return return",
            "+match_arm 1",
            "+call items",
            "~literal 1 → 2",
        ],
    },
    Fixture {
        path: "src/load.rs",
        category: FactCategory::ErrorHandling,
        old: "fn load() -> Result<u8, Error> {\n    let v = read();\n    Ok(v)\n}\n",
        new: "fn load() -> Result<u8, LoadError> {\n    let v = read()?;\n    let w = parse(v).unwrap();\n    if w == 0 {\n        panic!(\"empty\");\n    }\n    Ok(w)\n}\n",
        expect: &[
            "~error_type Error → LoadError",
            "+propagation ?",
            "+unwrap unwrap",
            "+throw panic",
            "+branch w == 0",
            "+call parse",
            "~type_annotation Result<u8, Error> → Result<u8, LoadError>",
        ],
    },
    Fixture {
        path: "src/model.rs",
        category: FactCategory::Data,
        old: "struct Budget {\n    max: u32,\n}\n\nconst LIMIT: u32 = 200;\n",
        new: "struct Budget {\n    max: u64,\n    spent: u64,\n}\n\nconst LIMIT: u32 = 250;\n",
        expect: &[
            "~type_annotation u32 → u64",
            "+field spent",
            "~literal 200 → 250",
        ],
    },
    Fixture {
        path: "src/api.rs",
        category: FactCategory::Api,
        old: "fn open() {}\n\npub fn close(id: u32) {}\n",
        new: "pub(crate) fn open() {}\n\npub fn close(id: u64) {}\n",
        expect: &[
            "+visibility pub(crate)",
            "~signature (id: u32) → (id: u64)",
            "~type_annotation u32 → u64",
        ],
    },
    Fixture {
        path: "src/run.rs",
        category: FactCategory::Concurrency,
        old: "fn run(state: &Shared) {\n    work(state);\n}\n",
        new: "async fn run(state: &Shared) {\n    let guard = state.inner.lock();\n    tokio::spawn(work(state));\n    ready().await;\n}\n",
        expect: &[
            "+async async",
            "+lock state.inner.lock",
            "+spawn tokio::spawn",
            "+await await",
            "+call ready",
        ],
    },
    Fixture {
        path: "src/budget.rs",
        category: FactCategory::Test,
        old: "#[cfg(test)]\nmod checks {\n    #[test]\n    fn fits() {\n        assert_eq!(total(), 1);\n    }\n}\n",
        new: "#[cfg(test)]\nmod checks {\n    #[test]\n    fn fits() {\n        assert_eq!(total(), 2);\n    }\n}\n",
        expect: &["@test_code", "~literal 1 → 2"],
    },
];

const TYPESCRIPT: &[Fixture] = &[
    Fixture {
        path: "src/sync.ts",
        category: FactCategory::Calls,
        old: "export function sync(store: Store) {\n  store.flush();\n}\n",
        new: "export function sync(store: Store) {\n  store.flush();\n  retry(store);\n  new Queue(store);\n}\n",
        expect: &["+call retry", "+call Queue"],
    },
    Fixture {
        path: "src/sync.ts",
        category: FactCategory::Effects,
        old: "async function save(body: string) {\n  log(body);\n}\n",
        new: "async function save(body: string) {\n  await invoke(\"save_file\", { body });\n  await fetch(\"/api\");\n  const home = process.env.HOME;\n  localStorage.setItem(\"body\", body);\n  document.title = body;\n  await listen(\"saved\", done);\n}\n",
        expect: &[
            "+effect.ipc_command invoke",
            "+effect.network fetch",
            "+effect.env process.env",
            "+effect.database localStorage.setItem",
            "+effect.ui document.title",
            "+effect.event listen",
            "+await await",
            "-call log",
        ],
    },
    Fixture {
        path: "src/flow.ts",
        category: FactCategory::ControlFlow,
        old: "function step(x: number): number {\n  if (x > 1) {\n    go();\n  }\n  return x;\n}\n",
        new: "function step(x: number): number {\n  if (x > 2) {\n    go();\n  }\n  for (const item of items()) {\n    if (item === x) {\n      return item;\n    }\n  }\n  switch (x) {\n    case 0:\n      break;\n  }\n  return x;\n}\n",
        expect: &[
            "~branch x > 1 → x > 2",
            "+loop items()",
            "+branch item === x",
            "+early_return return",
            "+match_arm 0",
            "+call items",
            "~literal 1 → 2",
        ],
    },
    Fixture {
        path: "src/load.ts",
        category: FactCategory::ErrorHandling,
        old: "function load(input: Input) {\n  return parse(input);\n}\n",
        new: "function load(input: Input) {\n  try {\n    return parse(input)!;\n  } catch (error) {\n    throw new LoadError(error);\n  }\n}\n",
        expect: &[
            "+catch catch",
            "+throw throw",
            "+unwrap !",
            "+call LoadError",
            "+early_return return",
        ],
    },
    Fixture {
        path: "src/model.ts",
        category: FactCategory::Data,
        old: "interface Budget {\n  max: number;\n}\n\nconst LIMIT = 200;\n",
        new: "interface Budget {\n  max: bigint;\n  spent: Date;\n}\n\nconst LIMIT = 250;\n",
        // `number` and `bigint` do not pair as one node: the type is
        // removed by one change and added by another.
        expect: &[
            "-type_annotation number",
            "+type_annotation bigint",
            "+field spent",
            "~literal 200 → 250",
        ],
    },
    Fixture {
        path: "src/api.ts",
        category: FactCategory::Api,
        old: "export function close(id: number): void {}\n\nclass Pool {\n  drain() {}\n}\n",
        new: "export function close(id: string): void {}\n\nclass Pool {\n  private drain() {}\n}\n",
        expect: &[
            "~signature (id: number) → (id: string)",
            "~type_annotation number → string",
            "+visibility private",
        ],
    },
    Fixture {
        path: "src/run.ts",
        category: FactCategory::Concurrency,
        old: "function run(state: State) {\n  work(state);\n}\n",
        new: "async function run(state: State) {\n  await work(state);\n  new Worker(\"pool.js\");\n}\n",
        expect: &["+async async", "+await await", "+spawn Worker"],
    },
    Fixture {
        path: "src/budget.test.ts",
        category: FactCategory::Test,
        old: "describe(\"budget\", () => {\n  it(\"fits\", () => {\n    expect(total()).toBe(1);\n  });\n});\n",
        new: "describe(\"budget\", () => {\n  it(\"fits\", () => {\n    expect(total()).toBe(2);\n  });\n});\n",
        expect: &["@test_code", "~literal 1 → 2"],
    },
];

const TSX: &[Fixture] = &[
    Fixture {
        path: "src/Panel.tsx",
        category: FactCategory::Calls,
        old: "export function Panel() {\n  return <div />;\n}\n",
        new: "export function Panel() {\n  const [open] = useState(false);\n  return <div />;\n}\n",
        expect: &["+call useState"],
    },
    Fixture {
        path: "src/Panel.tsx",
        category: FactCategory::Effects,
        old: "export function Panel() {\n  return <div />;\n}\n",
        new: "export function Panel() {\n  useEffect(() => {\n    window.addEventListener(\"resize\", fit);\n  });\n  return <div />;\n}\n",
        expect: &["+call useEffect", "+effect.event window.addEventListener"],
    },
    Fixture {
        path: "src/Panel.tsx",
        category: FactCategory::ControlFlow,
        old: "export function Panel({ open }: Props) {\n  return <div />;\n}\n",
        new: "export function Panel({ open }: Props) {\n  if (!open) return null;\n  return <div />;\n}\n",
        expect: &["+branch !open", "+early_return return"],
    },
    Fixture {
        path: "src/Panel.tsx",
        category: FactCategory::ErrorHandling,
        old: "export function Panel() {\n  return <div />;\n}\n",
        new: "export function Panel() {\n  if (missing) throw new Error(\"missing\");\n  return <div />;\n}\n",
        expect: &["+throw throw", "+branch missing", "+call Error"],
    },
    Fixture {
        path: "src/Panel.tsx",
        category: FactCategory::Data,
        old: "export function Panel() {\n  return <div className=\"panel\" />;\n}\n",
        new: "export function Panel() {\n  return <div className=\"panel open\" />;\n}\n",
        expect: &["~literal \"panel\" → \"panel open\""],
    },
    Fixture {
        path: "src/Panel.tsx",
        category: FactCategory::Api,
        old: "function Panel() {\n  return <div />;\n}\n",
        new: "export function Panel() {\n  return <div />;\n}\n",
        // Exporting exposes the signature.
        expect: &["+visibility export", "+signature ()"],
    },
    Fixture {
        path: "src/Panel.tsx",
        category: FactCategory::Concurrency,
        old: "export function Panel() {\n  const load = () => fetchAll();\n  return <div />;\n}\n",
        new: "export function Panel() {\n  const load = async () => await fetchAll();\n  return <div />;\n}\n",
        expect: &["+async async", "+await await"],
    },
    Fixture {
        path: "src/Panel.test.tsx",
        category: FactCategory::Test,
        old: "test(\"renders\", () => {\n  render(<Panel />);\n});\n",
        new: "test(\"renders\", () => {\n  render(<Panel open />);\n});\n",
        expect: &["@test_code"],
    },
];

const JAVASCRIPT: &[Fixture] = &[
    Fixture {
        path: "scripts/sync.mjs",
        category: FactCategory::Calls,
        old: "export function sync(store) {\n  store.flush();\n}\n",
        new: "export function sync(store) {\n  store.flush();\n  retry(store);\n}\n",
        expect: &["+call retry"],
    },
    Fixture {
        path: "scripts/sync.mjs",
        category: FactCategory::Effects,
        old: "function save(body) {\n  log(body);\n}\n",
        new: "function save(body) {\n  fs.writeFileSync(\"out.json\", body);\n  child_process.execSync(\"git add .\");\n  https.get(\"https://example.invalid\");\n}\n",
        expect: &[
            "+effect.filesystem fs.writeFileSync",
            "+effect.process child_process.execSync",
            "+effect.network https.get",
            // The matcher pairs `log(body)` with the first call, so the
            // path literal is itself an inserted node.
            "+literal \"out.json\"",
            "-call log",
        ],
    },
    Fixture {
        path: "scripts/flow.js",
        category: FactCategory::ControlFlow,
        old: "function step(x) {\n  return x;\n}\n",
        new: "function step(x) {\n  while (x > 0) {\n    if (done(x)) {\n      return x;\n    }\n    x -= 1;\n  }\n  return x;\n}\n",
        expect: &[
            "+loop x > 0",
            "+branch done(x)",
            "+early_return return",
            "+call done",
        ],
    },
    Fixture {
        path: "scripts/load.js",
        category: FactCategory::ErrorHandling,
        old: "function load(input) {\n  return parse(input);\n}\n",
        new: "function load(input) {\n  try {\n    return parse(input);\n  } catch (error) {\n    throw error;\n  }\n}\n",
        expect: &["+catch catch", "+throw throw", "+early_return return"],
    },
    Fixture {
        path: "scripts/model.js",
        category: FactCategory::Data,
        old: "class Budget {\n  max = 200;\n}\n",
        new: "class Budget {\n  max = 250;\n  spent = 0;\n}\n",
        expect: &["~literal 200 → 250", "+field spent"],
    },
    Fixture {
        path: "scripts/api.js",
        category: FactCategory::Api,
        old: "export function close(id) {}\n",
        new: "export function close(id, force) {}\n",
        expect: &["~signature (id) → (id, force)"],
    },
    Fixture {
        path: "scripts/run.js",
        category: FactCategory::Concurrency,
        old: "function run(state) {\n  work(state);\n}\n",
        new: "async function run(state) {\n  await work(state);\n}\n",
        expect: &["+async async", "+await await"],
    },
    Fixture {
        path: "scripts/budget.test.js",
        category: FactCategory::Test,
        old: "it(\"fits\", () => {\n  expect(total()).toBe(1);\n});\n",
        new: "it(\"fits\", () => {\n  expect(total()).toBe(2);\n});\n",
        expect: &["@test_code", "~literal 1 → 2"],
    },
];

const PYTHON: &[Fixture] = &[
    Fixture {
        path: "scripts/sync.py",
        category: FactCategory::Calls,
        old: "def sync(store):\n    store.flush()\n",
        new: "def sync(store):\n    store.flush()\n    retry(store)\n    store.queue.drain()\n",
        expect: &["+call retry", "+call store.queue.drain"],
    },
    Fixture {
        path: "scripts/sync.py",
        category: FactCategory::Effects,
        old: "def save(body):\n    log(body)\n",
        new: "def save(body):\n    open(\"out.json\", \"w\").write(body)\n    subprocess.run([\"git\", \"add\", \".\"])\n    home = os.environ[\"HOME\"]\n    sqlite3.connect(\"tasks.db\")\n",
        expect: &[
            "+effect.filesystem open",
            "+effect.process subprocess.run",
            "+effect.env os.environ",
            "+effect.database sqlite3.connect",
            "+call open(…).write",
            "-call log",
        ],
    },
    Fixture {
        path: "scripts/flow.py",
        category: FactCategory::ControlFlow,
        old: "def step(x):\n    if x > 1:\n        go()\n    return x\n",
        new: "def step(x):\n    if x > 2:\n        go()\n    for item in items():\n        if item == x:\n            return item\n    match x:\n        case 0:\n            pass\n    return x\n",
        expect: &[
            "~branch x > 1 → x > 2",
            "+loop items()",
            "+branch item == x",
            "+early_return return",
            "+match_arm 0",
            "~literal 1 → 2",
        ],
    },
    Fixture {
        path: "scripts/load.py",
        category: FactCategory::ErrorHandling,
        old: "def load(text):\n    try:\n        return parse(text)\n    except ValueError:\n        return None\n",
        new: "def load(text):\n    try:\n        return parse(text)\n    except KeyError:\n        raise LoadError(text)\n",
        expect: &[
            "~error_type ValueError → KeyError",
            "+throw raise",
            "+call LoadError",
            "-early_return return",
        ],
    },
    Fixture {
        path: "scripts/model.py",
        category: FactCategory::Data,
        old: "class Budget:\n    max = 200\n\n\ndef total(x: int) -> int:\n    return x\n",
        new: "class Budget:\n    max = 250\n    spent = 0\n\n\ndef total(x: float) -> int:\n    return x\n",
        expect: &[
            "~literal 200 → 250",
            "+field spent",
            "~type_annotation int → float",
            "~signature (x: int) → (x: float)",
        ],
    },
    Fixture {
        path: "scripts/api.py",
        category: FactCategory::Api,
        old: "def close(task_id):\n    pass\n",
        new: "def close(task_id, force=False):\n    pass\n",
        expect: &["~signature (task_id) → (task_id, force=False)"],
    },
    Fixture {
        path: "scripts/run.py",
        category: FactCategory::Concurrency,
        old: "def run(state):\n    work(state)\n",
        new: "async def run(state):\n    await work(state)\n    asyncio.create_task(watch(state))\n    with state.lock:\n        pass\n",
        expect: &[
            "+async async",
            "+await await",
            "+spawn asyncio.create_task",
            "+call watch",
            "+lock state.lock",
        ],
    },
    Fixture {
        path: "scripts/test_budget.py",
        category: FactCategory::Test,
        old: "def test_fits():\n    assert total() == 1\n",
        new: "def test_fits():\n    assert total() == 2\n",
        expect: &["@test_code", "~literal 1 → 2"],
    },
];

const LANGUAGES: [(&str, &[Fixture]); 5] = [
    ("rust", RUST),
    ("typescript", TYPESCRIPT),
    ("tsx", TSX),
    ("javascript", JAVASCRIPT),
    ("python", PYTHON),
];

const CATEGORIES: [FactCategory; 8] = [
    FactCategory::Calls,
    FactCategory::Effects,
    FactCategory::ControlFlow,
    FactCategory::ErrorHandling,
    FactCategory::Data,
    FactCategory::Api,
    FactCategory::Concurrency,
    FactCategory::Test,
];

#[test]
fn every_fixture_reports_its_facts() {
    let mut failures = Vec::new();
    for (language, fixtures) in LANGUAGES {
        for fixture in fixtures {
            let found = facts(fixture.path, fixture.old, fixture.new);
            let lines: BTreeSet<String> = found.iter().map(line).collect();
            let wanted: BTreeSet<String> = fixture.expect.iter().map(|s| s.to_string()).collect();
            if lines != wanted {
                failures.push(format!(
                    "{language} {:?} ({}):\n  missing {:?}\n  extra   {:?}",
                    fixture.category,
                    fixture.path,
                    wanted.difference(&lines).collect::<Vec<_>>(),
                    lines.difference(&wanted).collect::<Vec<_>>()
                ));
            }
            // Facts mirror (added ↔ removed) on the reverse diff.
            let mut forward: Vec<Fact> = found.iter().map(Fact::mirrored).collect();
            let mut backward = facts(fixture.path, fixture.new, fixture.old);
            forward.sort();
            backward.sort();
            if forward != backward {
                failures.push(format!(
                    "{language} {:?} ({}): not mirrored\n  {:?}\n  {:?}",
                    fixture.category,
                    fixture.path,
                    forward.iter().map(line).collect::<Vec<_>>(),
                    backward.iter().map(line).collect::<Vec<_>>()
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn fixtures_cover_every_category_in_every_language() {
    for (language, fixtures) in LANGUAGES {
        for category in CATEGORIES {
            let covered = fixtures.iter().any(|fixture| {
                fixture.category == category
                    && facts(fixture.path, fixture.old, fixture.new)
                        .iter()
                        .any(|fact| fact.category() == category)
            });
            assert!(covered, "{language} has no {category:?} fixture");
        }
    }
}

#[test]
fn formatting_only_and_unchanged_files_have_no_facts() {
    for (path, old, new) in [
        (
            "a.rs",
            "fn a(x: u8) -> u8 { if x > 1 { retry(x); } x }\n",
            "fn a(x: u8) -> u8 {\n    if x > 1 {\n        retry(x);\n    }\n    x\n}\n",
        ),
        (
            "a.ts",
            "export function a(x: number) { if (x > 1) { retry(x); } return x; }\n",
            "export function a(x: number) {\n  if (x > 1) {\n    retry(x);\n  }\n  return x;\n}\n",
        ),
    ] {
        assert!(facts(path, old, new).is_empty(), "{path}");
        assert!(facts(path, new, new).is_empty(), "{path}");
    }
}

/// Exact facts of small diffs, one per case.
fn assert_lines(path: &str, old: &str, new: &str, want: &[&str]) {
    let found = lines(path, old, new);
    let want: BTreeSet<String> = want.iter().map(|s| s.to_string()).collect();
    assert_eq!(found, want, "{path}\n{old}\n---\n{new}");
}

#[test]
fn field_and_method_names_are_not_module_paths() {
    // `::` rows match paths only; `job.env` is a field, not `std::env`.
    assert_lines(
        "src/a.rs",
        "fn a() {}\n",
        "fn a() {\n    job.env.get();\n    self.process.name();\n    self.fs.write(b);\n}\n",
        &[
            "+call job.env.get",
            "+call self.process.name",
            "+call self.fs.write",
        ],
    );
    assert_lines(
        "scripts/a.py",
        "def a():\n    pass\n",
        "def a():\n    os.cpu_count()\n    os.getpid()\n    pool.submit(work)\n    confirm(x)\n",
        &[
            "+call os.cpu_count",
            "+call os.getpid",
            "+call pool.submit",
            "+call confirm",
        ],
    );
    assert_lines(
        "src/a.ts",
        "function a() {}\n",
        "function a() {\n  confirm(x);\n  prompt(x);\n  client.fetch(x);\n}\n",
        &["+call confirm", "+call prompt", "+call client.fetch"],
    );
}

#[test]
fn test_code_is_found_past_comments_attributes_and_compound_cfgs() {
    let edit = |head: &str| {
        (
            format!("{head}fn t() {{\n    go(1);\n}}\n"),
            format!("{head}fn t() {{\n    go(2);\n}}\n"),
        )
    };
    for head in [
        "#[test]\n/// Checks the total.\n",
        "#[test]\n#[ignore]\n#[should_panic]\n",
        "#[tokio::test]\n// note\n#[ignore]\n",
    ] {
        let (old, new) = edit(head);
        assert_lines("src/a.rs", &old, &new, &["~literal 1 → 2", "@test_code"]);
    }
    let module =
        |cfg: &str, n: u8| format!("#[cfg({cfg})]\nmod checks {{\n    fn t() {{ go({n}); }}\n}}\n");
    assert_lines(
        "src/a.rs",
        &module("all(test, unix)", 1),
        &module("all(test, unix)", 2),
        &["~literal 1 → 2", "@test_code"],
    );
    assert_lines(
        "src/a.rs",
        &module("not(test)", 1),
        &module("not(test)", 2),
        &["~literal 1 → 2"],
    );
}

#[test]
fn calls_are_named_compactly_and_trivial_ones_are_not_reported() {
    assert_lines(
        "src/a.rs",
        "fn a() {}\n",
        "fn a() {\n    CACHE\n        .lock()\n        .ok()\n        .and_then(read);\n    let s = name.clone().to_string();\n    open(path).flush();\n}\n",
        &["+lock CACHE.lock", "+call open", "+call open(…).flush"],
    );
    assert_lines(
        "scripts/a.py",
        "def a():\n    pass\n",
        "def a():\n    n = len(items)\n    open(\"out.json\", \"w\").write(b)\n",
        &["+effect.filesystem open", "+call open(…).write"],
    );
}

#[test]
fn a_repeated_call_is_counted_not_just_seen() {
    // Both sides call `step`; only a multiset sees one call more or fewer.
    assert_lines(
        "src/a.rs",
        "fn a(x: u32) -> u32 {\n    let v = step(x);\n    v\n}\n",
        "fn a(x: u32) -> u32 {\n    let v = step(x) + step(x);\n    v\n}\n",
        &["+call step"],
    );
    assert_lines(
        "src/a.ts",
        "function a(x: number) {\n  const v = step(x) + step(x);\n  return v;\n}\n",
        "function a(x: number) {\n  const v = step(x);\n  return v;\n}\n",
        &["-call step"],
    );
}

#[test]
fn code_added_inside_a_branch_reports_only_itself() {
    // The enclosing branch is on both sides: matched to its counterpart, it
    // is no fact.
    assert_lines(
        "src/a.rs",
        "fn a(x: u32) {\n    if x > 1 {\n        go(x);\n    }\n}\n",
        "fn a(x: u32) {\n    if x > 1 {\n        go(x);\n        retry(x);\n    }\n}\n",
        &["+call retry"],
    );
    assert_lines(
        "scripts/a.py",
        "def a(x):\n    while x > 0:\n        if x > 1:\n            go(x)\n",
        "def a(x):\n    while x > 0:\n        if x > 1:\n            go(x)\n            retry(x)\n",
        &["+call retry"],
    );
}

#[test]
fn added_declarations_are_labelled_at_their_own_first_line() {
    let new = "//! Module doc.\n//! More.\n\nuse super::changes::Snapshot;\n\n// Cached results.\n#[allow(dead_code)]\nconst CACHE: usize = 16;\n";
    let heads: Vec<(String, u32, LineSpan)> = declarations("src/a.rs", "", new)
        .into_iter()
        .filter_map(|d| match d.change {
            DeclarationChange::Added { new, head } => Some((d.subject?.name, head, new)),
            _ => None,
        })
        .collect();
    let at = |start, end| LineSpan { start, end };
    assert_eq!(
        heads,
        [
            // The module doc comment is not the import's.
            ("super::changes::Snapshot".to_owned(), 4, at(4, 4)),
            // The comment and attribute go with the constant; its label
            // goes on the constant itself.
            ("CACHE".to_owned(), 8, at(6, 8)),
        ]
    );
    // The same for a removal, on the old side.
    let removed: Vec<u32> = declarations("src/a.rs", new, "")
        .into_iter()
        .filter_map(|d| match d.change {
            DeclarationChange::Removed { head, .. } => Some(head),
            _ => None,
        })
        .collect();
    assert_eq!(removed, [4, 8]);
}

#[test]
fn facts_per_change_are_capped_the_same_way_in_both_directions() {
    let calls: String = (0..100).map(|i| format!("    call_{i:03}();\n")).collect();
    let old = "fn a() {}\n";
    let new = format!("fn a() {{}}\n\nfn b() {{\n    std::fs::remove_file(p);\n{calls}}}\n");
    let added = declarations("src/a.rs", old, &new);
    let facts = &added
        .iter()
        .find(|d| d.subject.as_ref().is_some_and(|s| s.name == "b"))
        .unwrap()
        .facts;
    assert_eq!(facts.items.len(), semantic::Facts::MAX);
    assert_eq!(facts.omitted as usize, 101 - semantic::Facts::MAX);
    // The effect is kept: categories that cross the boundary come first.
    assert!(facts
        .items
        .iter()
        .any(|f| matches!(f.kind, FactKind::Effect { .. })));
    let removed = declarations("src/a.rs", &new, old);
    let back = &removed
        .iter()
        .find(|d| d.subject.as_ref().is_some_and(|s| s.name == "b"))
        .unwrap()
        .facts;
    assert_eq!(back.mirrored(), *facts);
}
