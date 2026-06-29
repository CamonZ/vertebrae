use super::*;

// ========================================================================
// Shared test helpers
// ========================================================================

/// A reader that yields its data then returns errors forever.
/// Use this to test that processing stops on read error.
struct FailingReader {
    data: std::io::Cursor<Vec<u8>>,
    has_errored: bool,
}

impl FailingReader {
    fn new(data: &str) -> Self {
        Self {
            data: std::io::Cursor::new(data.as_bytes().to_vec()),
            has_errored: false,
        }
    }
}

impl std::io::Read for FailingReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.has_errored {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "pipe broke",
            ));
        }
        let n = self.data.read(buf)?;
        if n == 0 {
            self.has_errored = true;
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "pipe broke",
            ));
        }
        Ok(n)
    }
}

impl BufRead for FailingReader {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        if self.has_errored {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "pipe broke",
            ));
        }
        let buf = self.data.fill_buf()?;
        if buf.is_empty() {
            self.has_errored = true;
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "pipe broke",
            ));
        }
        Ok(buf)
    }
    fn consume(&mut self, amt: usize) {
        self.data.consume(amt);
    }
}

// ========================================================================
// process_jsonl_lines tests
// ========================================================================

#[test]
fn test_process_jsonl_lines_parses_and_emits() {
    let input = concat!(
        r#"{"type":"system","subtype":"init","model":"claude-sonnet-4"}"#,
        "\n",
        r#"{"type":"result","duration_ms":100}"#,
        "\n",
    );

    let mut all_events = Vec::new();
    ClaudeSessionManager::process_jsonl_lines(std::io::Cursor::new(input), "sess-1", |events| {
        all_events.extend(events)
    });

    assert_eq!(all_events.len(), 2);
    assert!(matches!(&all_events[0], EmittedEvent::Init(_)));
    assert!(matches!(&all_events[1], EmittedEvent::SessionEnd(_)));
}

#[test]
fn test_process_jsonl_lines_skips_empty_lines() {
    let input = concat!(
        r#"{"type":"system","subtype":"init"}"#,
        "\n",
        "\n",
        "\n",
        r#"{"type":"result"}"#,
        "\n",
    );

    let mut count = 0;
    ClaudeSessionManager::process_jsonl_lines(std::io::Cursor::new(input), "sess-1", |_| {
        count += 1
    });

    // Two valid messages, empty lines skipped
    assert_eq!(count, 2);
}

#[test]
fn test_process_jsonl_lines_skips_invalid_json() {
    let input = concat!(
        r#"{"type":"system","subtype":"init"}"#,
        "\n",
        "not valid json\n",
        r#"{"type":"result"}"#,
        "\n",
    );

    let mut all_events = Vec::new();
    ClaudeSessionManager::process_jsonl_lines(std::io::Cursor::new(input), "sess-1", |events| {
        all_events.extend(events)
    });

    // Only the two valid messages should produce events
    assert_eq!(all_events.len(), 2);
}

#[test]
fn test_process_jsonl_lines_empty_input() {
    let mut called = false;
    ClaudeSessionManager::process_jsonl_lines(std::io::Cursor::new(""), "sess-1", |_| {
        called = true
    });
    assert!(!called);
}

#[test]
fn test_process_jsonl_lines_stops_on_read_error() {
    let input = format!("{}\n", r#"{"type":"system","subtype":"init"}"#);
    let reader = FailingReader::new(&input);

    let mut all_events = Vec::new();
    ClaudeSessionManager::process_jsonl_lines(reader, "sess-1", |events| all_events.extend(events));

    // Should have processed the one valid line before the error
    assert_eq!(all_events.len(), 1);
    assert!(matches!(&all_events[0], EmittedEvent::Init(_)));
}

// ========================================================================
// process_stderr_lines tests
// ========================================================================

#[test]
fn test_process_stderr_lines_collects_errors() {
    let input = "something went wrong\nanother error\n";

    let mut errors = Vec::new();
    ClaudeSessionManager::process_stderr_lines(std::io::Cursor::new(input), "sess-1", |msg| {
        errors.push(msg)
    });

    assert_eq!(errors.len(), 2);
    assert_eq!(errors[0], "[stderr] something went wrong");
    assert_eq!(errors[1], "[stderr] another error");
}

#[test]
fn test_process_stderr_lines_skips_empty_lines() {
    let input = "error one\n\n\nerror two\n";

    let mut errors = Vec::new();
    ClaudeSessionManager::process_stderr_lines(std::io::Cursor::new(input), "sess-1", |msg| {
        errors.push(msg)
    });

    assert_eq!(errors.len(), 2);
}

#[test]
fn test_process_stderr_lines_empty_input() {
    let mut called = false;
    ClaudeSessionManager::process_stderr_lines(std::io::Cursor::new(""), "sess-1", |_| {
        called = true
    });
    assert!(!called);
}

#[test]
fn test_process_stderr_lines_stops_on_read_error() {
    let reader = FailingReader::new("first error\n");

    let mut errors = Vec::new();
    ClaudeSessionManager::process_stderr_lines(reader, "sess-1", |msg| errors.push(msg));

    // Should have processed the one valid line before the error
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0], "[stderr] first error");
}
