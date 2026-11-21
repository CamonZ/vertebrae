//! The semantic diff of a 2,000-line file, facts included, fits the
//! default 200 ms budget.
//! That timing is only asserted in optimized builds
//! (`cargo test --release -p vertebrae-syntax --test semantic_budget`);
//! in every build, the deadline itself is checked to stop the work promptly.

use std::time::{Duration, Instant};
use vertebrae_syntax::semantic::{self, Budget, FactChange, FactKind, SemanticOutcome};

/// About 2,000 lines of Rust: 200 ten-line functions in one impl.
fn rust_file(edit: bool) -> String {
    let mut out = String::from("pub struct Ledger { total: i64 }\n\nimpl Ledger {\n");
    for i in 0..200 {
        let step = if edit && i % 50 == 7 { i + 1000 } else { i };
        let name = if edit && i == 120 {
            "renamed_entry".to_string()
        } else {
            format!("entry_{i}")
        };
        // Edited entries also call `audit` (a call fact).
        let audit = if edit && i % 50 == 7 {
            "audit(scaled); "
        } else {
            ""
        };
        out += &format!(
            "    pub fn {name}(&mut self, amount: i64) -> i64 {{\n        let scaled = amount * {step};\n        if scaled > {i} {{\n            self.total += scaled;\n        }} else {{\n            self.total -= {i};\n        }}\n        {audit}let check = self.total % 7;\n        check + scaled\n    }}\n"
        );
    }
    out + "}\n"
}

fn typescript_file(edit: bool) -> String {
    let mut out = String::new();
    for i in 0..200 {
        let step = if edit && i % 40 == 3 { i + 500 } else { i };
        let audit = if edit && i % 40 == 3 {
            "audit(total); "
        } else {
            ""
        };
        out += &format!(
            "export function entry{i}(items: number[]): number {{\n  let total = 0;\n  for (const item of items) {{\n    if (item > {step}) {{\n      total += item;\n    }}\n  }}\n  {audit}const check = total % 7;\n  return check + total;\n}}\n"
        );
    }
    out
}

/// About 2,000 lines of Elixir: 200 ten-line functions, with a pipeline
/// and a `case`, in one module.
fn elixir_file(edit: bool) -> String {
    let mut out = String::from("defmodule Ledger do\n");
    for i in 0..200 {
        let step = if edit && i % 40 == 5 { i + 500 } else { i };
        let audit = if edit && i % 40 == 5 {
            "    audit(scaled)\n"
        } else {
            ""
        };
        out += &format!(
            "  def entry_{i}(amount) do\n    scaled = amount * {step}\n    case scaled do\n      n when n > {i} -> n\n      _ -> {i}\n    end\n{audit}    check = rem(scaled, 7)\n    check |> Kernel.+(scaled)\n  end\n\n"
        );
    }
    out + "end\n"
}

fn assert_within_budget(path: &str, old: &str, new: &str) {
    assert!(
        old.lines().count() >= 2_000,
        "{} lines",
        old.lines().count()
    );
    let optimized = !cfg!(debug_assertions);
    let budget = if optimized {
        Budget::default()
    } else {
        Budget {
            time: Duration::from_secs(30),
            ..Budget::default()
        }
    };
    // A grammar's queries compile once per process, on its first diff,
    // outside that diff's budget (Elixir's take the longest, about
    // 0.2 s in optimized builds); that is not per-file work.
    semantic::diff(path, "", " ", &Budget::default());
    let started = Instant::now();
    let outcome = semantic::diff(path, old, new, &budget);
    let elapsed = started.elapsed();
    let SemanticOutcome::Semantic { declarations, .. } = outcome else {
        panic!("{path} fell back after {elapsed:?}: {outcome:?}");
    };
    assert!(!declarations.is_empty());
    let audits = declarations
        .iter()
        .flat_map(|d| {
            d.facts
                .items
                .iter()
                .chain(d.parts.iter().flat_map(|p| &p.facts().items))
        })
        .filter(|fact| {
            fact.kind == FactKind::Call
                && fact.change
                    == FactChange::Added {
                        subject: "audit".into(),
                    }
        })
        .count();
    assert!(audits > 0, "{path}: no call facts");
    if optimized {
        assert!(elapsed < Duration::from_millis(200), "{path}: {elapsed:?}");
    }
    println!(
        "{path}: {} lines, {} declarations in {elapsed:?}",
        old.lines().count(),
        declarations.len()
    );
}

#[test]
fn two_thousand_line_rust_file_fits_the_budget() {
    assert_within_budget("ledger.rs", &rust_file(false), &rust_file(true));
}

#[test]
fn two_thousand_line_typescript_file_fits_the_budget() {
    assert_within_budget(
        "entries.ts",
        &typescript_file(false),
        &typescript_file(true),
    );
}

#[test]
fn two_thousand_line_elixir_file_fits_the_budget() {
    assert_within_budget("lib/ledger.ex", &elixir_file(false), &elixir_file(true));
}

/// Every phase (parsing, tree building, matching, the edit script) checks
/// the deadline as it goes, so a diff stops soon after its budget runs out
/// in any build, rather than only after matching finishes.
#[test]
fn the_deadline_stops_every_phase_promptly() {
    // The longest stretch between deadline checks is about a millisecond;
    // the rest is room for a loaded CI machine.
    let slack = if cfg!(debug_assertions) {
        Duration::from_millis(100)
    } else {
        Duration::from_millis(25)
    };
    let inputs = [
        ("ledger.rs", rust_file(false), rust_file(true)),
        ("entries.ts", typescript_file(false), typescript_file(true)),
        ("lib/ledger.ex", elixir_file(false), elixir_file(true)),
    ];
    for (path, old, new) in &inputs {
        // Each grammar's declarations query compiles once per process, on
        // its first diff; that is not per-file work.
        semantic::diff(path, "", "", &Budget::default());
        for millis in [1, 5, 10, 20, 40, 80, 160] {
            let budget = Budget {
                time: Duration::from_millis(millis),
                ..Budget::default()
            };
            let started = Instant::now();
            let outcome = semantic::diff(path, old, new, &budget);
            let elapsed = started.elapsed();
            assert!(
                elapsed < budget.time + slack,
                "{path} with {millis} ms: {elapsed:?} ({outcome:?})"
            );
        }
    }
}
