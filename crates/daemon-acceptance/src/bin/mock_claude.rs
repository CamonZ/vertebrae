//! mock-claude: deterministic stand-in for the Claude Code CLI used by the
//! daemon-acceptance test suite. Selected via `CLAUDE_CODE_PATH` so the daemon
//! source is unchanged.
//!
//! The prompt (via `-p <envelope>`) is a JSON envelope:
//! `{ "exit_code": i32, "delay_ms": u64, "stdout_file": string|null, "stderr_file": string|null }`.
//! Fixture paths resolve against `$MOCK_OUTPUT_DIR`; absolute paths and `..`
//! components are rejected. Sleep is interruptible so the daemon's cancel-by-
//! SIGKILL path works.
//!
//! When `MOCK_CAPTURE_DIR` is set, writes `argv.json` (array of strings) and
//! `cwd.txt` to that directory on startup so tests can assert on how the daemon
//! invoked the CLI. The envelope prompt is not required for capture, which lets
//! scenarios exercise the daemon's empty-prompt fallback.

use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();

    if let Some(dir) = std::env::var_os("MOCK_CAPTURE_DIR") {
        capture_invocation(Path::new(&dir), &args);
    }

    let prompt = extract_prompt(&args);
    // Empty-prompt fallback sends `-p "Execute step"` — not an envelope. Skip
    // streaming and sleeping in that case; capture alone is enough.
    if let Some(envelope) = parse_envelope(prompt) {
        let mock_dir =
            PathBuf::from(std::env::var_os("MOCK_OUTPUT_DIR").expect("MOCK_OUTPUT_DIR env var"));

        if let Some(ref rel) = envelope.stdout_file {
            stream_lines(&resolve_fixture(&mock_dir, rel), StreamTarget::Stdout);
        }
        if let Some(ref rel) = envelope.stderr_file {
            stream_lines(&resolve_fixture(&mock_dir, rel), StreamTarget::Stderr);
        }

        if envelope.delay_ms > 0 {
            interruptible_sleep(Duration::from_millis(envelope.delay_ms));
        }

        ExitCode::from(envelope.exit_code as u8)
    } else {
        ExitCode::from(0)
    }
}

fn capture_invocation(dir: &Path, args: &[String]) {
    std::fs::create_dir_all(dir).expect("create MOCK_CAPTURE_DIR");
    let argv_json = serde_json::to_string(args).expect("argv serialises");
    std::fs::write(dir.join("argv.json"), argv_json).expect("write argv.json");
    let cwd = std::env::current_dir().expect("current_dir");
    std::fs::write(dir.join("cwd.txt"), cwd.to_string_lossy().as_bytes()).expect("write cwd.txt");
}

#[derive(Debug)]
struct Envelope {
    exit_code: i32,
    delay_ms: u64,
    stdout_file: Option<String>,
    stderr_file: Option<String>,
}

fn extract_prompt(args: &[String]) -> &str {
    let mut iter = args.iter();
    iter.next();
    while let Some(arg) = iter.next() {
        if arg == "-p" || arg == "--prompt" {
            return iter.next().expect("-p requires a value").as_str();
        }
        if let Some(rest) = arg.strip_prefix("--prompt=") {
            return rest;
        }
    }
    panic!("no '-p <envelope-json>' argument found in {args:?}");
}

/// Returns `None` if the prompt is not a JSON object (e.g. the empty-prompt
/// fallback string "Execute step"). Returns `Some(envelope)` for a valid
/// fixture envelope. Panics on malformed envelopes.
fn parse_envelope(raw: &str) -> Option<Envelope> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = value.as_object()?;

    let exit_code = obj["exit_code"]
        .as_i64()
        .expect("'exit_code' must be an integer");
    let exit_code = i32::try_from(exit_code).expect("'exit_code' does not fit in i32");

    let delay_ms = obj["delay_ms"]
        .as_i64()
        .expect("'delay_ms' must be an integer");
    assert!(delay_ms >= 0, "'delay_ms' must be >= 0, got {delay_ms}");

    Some(Envelope {
        exit_code,
        delay_ms: delay_ms as u64,
        stdout_file: optional_string(obj, "stdout_file"),
        stderr_file: optional_string(obj, "stderr_file"),
    })
}

fn optional_string(obj: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    match &obj[key] {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        other => panic!("'{key}' must be a string or null, got {other}"),
    }
}

fn resolve_fixture(base: &Path, rel: &str) -> PathBuf {
    assert!(!rel.is_empty(), "fixture path is empty");
    let candidate = Path::new(rel);
    assert!(
        !candidate.is_absolute(),
        "fixture path must be relative: {rel:?}"
    );
    for component in candidate.components() {
        match component {
            Component::ParentDir => panic!("fixture path must not contain '..': {rel:?}"),
            Component::Prefix(_) | Component::RootDir => {
                panic!("fixture path must be relative: {rel:?}")
            }
            Component::CurDir | Component::Normal(_) => {}
        }
    }
    base.join(candidate)
}

enum StreamTarget {
    Stdout,
    Stderr,
}

fn stream_lines(path: &Path, target: StreamTarget) {
    let file = std::fs::File::open(path)
        .unwrap_or_else(|e| panic!("failed to open fixture {}: {e}", path.display()));
    let reader = BufReader::new(file);
    let mut stdout;
    let mut stderr;
    let writer: &mut dyn Write = match target {
        StreamTarget::Stdout => {
            stdout = std::io::stdout().lock();
            &mut stdout
        }
        StreamTarget::Stderr => {
            stderr = std::io::stderr().lock();
            &mut stderr
        }
    };
    for line in reader.lines() {
        let line = line.expect("fixture read");
        writer.write_all(line.as_bytes()).expect("fixture write");
        writer.write_all(b"\n").expect("fixture write");
    }
    writer.flush().expect("fixture flush");
}

// Poll in short slices so SIGKILL from the daemon's cancel path terminates us
// promptly even mid-sleep. (SIGKILL bypasses user-space; std::thread::sleep
// loops on EINTR, so we wake ourselves to let the signal land.)
fn interruptible_sleep(total: Duration) {
    let start = Instant::now();
    let slice = Duration::from_millis(50);
    while Instant::now().duration_since(start) < total {
        let remaining = total - Instant::now().duration_since(start);
        std::thread::sleep(remaining.min(slice));
    }
}
