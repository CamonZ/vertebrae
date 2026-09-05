#!/usr/bin/env python3
"""Check JSON mappings, workspace inheritance and real Clippy policy fixtures.

Requires Python 3.11+ and the repository Rust toolchain. Run after the normal
Clippy job has cached tracing; fixture builds are offline and isolated.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def main():
    workspace = tomllib.loads((ROOT / "Cargo.toml").read_text())
    policy = workspace["workspace"]["lints"]["clippy"]
    audit = json.loads((ROOT / "docs/rust-guideline-enforcement.json").read_text())
    assert {"clippy::" + key for key in policy} == set(audit["policy"]["clippy_lints"])
    assert all(level == "deny" for level in policy.values())
    rules = audit["rules"]
    assert len({r["rule_id"] for r in rules}) == len(rules) == 209
    for rule in rules:
        assert rule["checks"] and rule["remaining_verification"]
        for check in rule["checks"]:
            if check["status"] == "explicit_policy":
                assert set(check["lints"]) <= set(audit["policy"]["clippy_lints"])
                assert check["coverage"] == "partial"
    for member in workspace["workspace"]["members"]:
        manifest = tomllib.loads((ROOT / member / "Cargo.toml").read_text())
        assert manifest.get("lints") == {"workspace": True}, member

    with tempfile.TemporaryDirectory(prefix="vtb-clippy-policy-") as temporary:
        path = Path(temporary)
        (path / "src").mkdir()
        # Read levels from the real policy rather than duplicating flags here.
        lint_table = "\n".join(f'{name} = "{level}"' for name, level in policy.items())
        lock = tomllib.loads((ROOT / "Cargo.lock").read_text())
        tracing_version = next(package["version"] for package in lock["package"]
                               if package["name"] == "tracing")
        shutil.copyfile(ROOT / "Cargo.lock", path / "Cargo.lock")
        (path / "Cargo.toml").write_text(
            '[package]\nname = "vtb-clippy-policy-fixture"\nversion = "0.0.0"\n'
            f'edition = "2021"\n[workspace]\n[dependencies]\ntracing = "={tracing_version}"\n'
            '[lints.clippy]\n' + lint_table + "\n"
        )
        shutil.copyfile(ROOT / "clippy.toml", path / "clippy.toml")
        env = os.environ.copy()
        env["CLIPPY_CONF_DIR"] = str(path)
        env["CARGO_TARGET_DIR"] = str(path / "target")

        def lint(source):
            (path / "src/lib.rs").write_text(source)
            result = subprocess.run(
                ["cargo", "clippy", "--offline", "--manifest-path", str(path / "Cargo.toml"),
                 "--message-format=json"], cwd=ROOT, env=env, text=True, capture_output=True,
                timeout=180,
            )
            messages = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
            codes = [m["message"].get("code", {}).get("code")
                     for m in messages if m.get("reason") == "compiler-message"
                     and m["message"].get("code")]
            return result, codes

        negative = '''#![allow(dead_code)]
async fn lock() {
    let lock = std::sync::Mutex::new(0);
    let guard = lock.lock().unwrap();
    std::future::ready(()).await;
    drop(guard);
}
async fn cell() {
    let cell = std::cell::RefCell::new(0);
    let guard = cell.borrow();
    std::future::ready(()).await;
    drop(guard);
}
async fn entered() {
    let span = tracing::info_span!("fixture");
    let guard = span.enter();
    std::future::ready(()).await;
    drop(guard);
}
async fn owned_entered() {
    let guard = tracing::info_span!("fixture").entered();
    std::future::ready(()).await;
    drop(guard);
}
fn discarded() { let _ = std::future::ready(()); }
fn debug_output() { dbg!(42); }
'''
        failed, codes = lint(negative)
        expected = set(audit["policy"]["clippy_lints"])
        assert failed.returncode != 0, "negative fixture unexpectedly compiled"
        assert expected <= set(codes), (expected - set(codes), failed.stderr, failed.stdout)
        assert codes.count("clippy::await_holding_invalid_type") == 2, codes

        positive = '''#![allow(dead_code)]
async fn scoped() {
    let lock = std::sync::Mutex::new(0);
    { let guard = lock.lock().unwrap(); assert_eq!(*guard, 0); }
    let cell = std::cell::RefCell::new(0);
    { let guard = cell.borrow(); assert_eq!(*guard, 0); }
    let span = tracing::info_span!("fixture");
    { let _guard = span.enter(); }
    { let _guard = tracing::info_span!("fixture").entered(); }
    std::future::ready(()).await;
}
#[expect(clippy::dbg_macro, reason = "Intentional lint-policy exception fixture")]
fn justified_exception() { dbg!(42); }
'''
        passed, codes = lint(positive)
        assert passed.returncode == 0, (passed.stderr, passed.stdout)
        assert not (expected & set(codes)), codes
    print("209 rule mappings and all workspace members validated; five lints rejected violations, both tracing guards detected, valid code and scoped exception passed.")


if __name__ == "__main__":
    main()
