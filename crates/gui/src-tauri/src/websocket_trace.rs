//! Opt-in diagnostics for the Sacrum WebSocket event path.
//!
//! Normal WebSocket operation does not create a file or serialize trace
//! records. Set `VERTEBRAE_WEBSOCKET_DIAGNOSTICS=1` to enable the sink, and
//! optionally set `VERTEBRAE_WEBSOCKET_TRACE_PATH` to choose its path.

use std::fmt;
use std::io::{LineWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex as StdMutex, OnceLock};

const WEBSOCKET_DIAGNOSTICS_ENV: &str = "VERTEBRAE_WEBSOCKET_DIAGNOSTICS";
const WEBSOCKET_TRACE_PATH_ENV: &str = "VERTEBRAE_WEBSOCKET_TRACE_PATH";
const DEFAULT_WEBSOCKET_TRACE_PATH: &str = "/app/test-output/websocket-events.log";

#[derive(Debug, Clone, PartialEq, Eq)]
struct WebSocketTraceConfig {
    enabled: bool,
    path: PathBuf,
}

impl WebSocketTraceConfig {
    fn from_environment() -> Self {
        Self {
            enabled: Self::enabled_for_value(std::env::var(WEBSOCKET_DIAGNOSTICS_ENV).ok()),
            path: std::env::var_os(WEBSOCKET_TRACE_PATH_ENV)
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(DEFAULT_WEBSOCKET_TRACE_PATH)),
        }
    }

    fn enabled_for_value(value: Option<String>) -> bool {
        value.is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
    }
}

struct WebSocketTraceSink {
    writer: StdMutex<LineWriter<std::fs::File>>,
    next_sequence: AtomicU64,
}

impl WebSocketTraceSink {
    fn from_config(config: &WebSocketTraceConfig) -> Option<Self> {
        if !config.enabled {
            return None;
        }

        if let Some(parent) = config.path.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                log::warn!(
                    "[WebSocket] Could not initialize diagnostic trace directory '{}': {}",
                    parent.display(),
                    error
                );
                return None;
            }
        }

        let file = match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&config.path)
        {
            Ok(file) => file,
            Err(error) => {
                log::warn!(
                    "[WebSocket] Could not initialize diagnostic trace file '{}': {}",
                    config.path.display(),
                    error
                );
                return None;
            }
        };

        Some(Self {
            writer: StdMutex::new(LineWriter::new(file)),
            next_sequence: AtomicU64::new(1),
        })
    }

    fn write(&self, entry: fmt::Arguments<'_>) {
        let sequence = self.next_sequence.fetch_add(1, Ordering::Relaxed);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let Ok(mut writer) = self.writer.lock() else {
            log::warn!("[WebSocket] Diagnostic trace lock was poisoned");
            return;
        };
        if let Err(error) = writeln!(writer, "[{timestamp} #{sequence}] {entry}") {
            log::warn!("[WebSocket] Failed to write diagnostic trace: {}", error);
        }
    }
}

static WEBSOCKET_TRACE_SINK: OnceLock<Option<WebSocketTraceSink>> = OnceLock::new();

pub(crate) fn websocket_diagnostics_enabled() -> bool {
    WebSocketTraceConfig::from_environment().enabled
}

pub(crate) fn trace_event(entry: fmt::Arguments<'_>) {
    let sink = WEBSOCKET_TRACE_SINK
        .get_or_init(|| WebSocketTraceSink::from_config(&WebSocketTraceConfig::from_environment()));
    if let Some(sink) = sink.as_ref() {
        sink.write(entry);
    }
}

#[cfg(test)]
mod tests {
    use super::{WebSocketTraceConfig, WebSocketTraceSink};

    #[test]
    fn websocket_diagnostics_are_explicitly_opt_in() {
        assert!(!WebSocketTraceConfig::enabled_for_value(None));
        assert!(!WebSocketTraceConfig::enabled_for_value(Some(
            "false".into()
        )));
        assert!(!WebSocketTraceConfig::enabled_for_value(Some("0".into())));
        assert!(WebSocketTraceConfig::enabled_for_value(Some("1".into())));
        assert!(WebSocketTraceConfig::enabled_for_value(Some(
            " TRUE ".into()
        )));
    }

    #[test]
    fn production_trace_burst_does_not_initialize_a_file_sink() {
        let config = WebSocketTraceConfig {
            enabled: false,
            path: tempfile::tempdir()
                .expect("create temporary trace directory")
                .path()
                .join("should-not-exist/websocket-events.log"),
        };

        for _ in 0..1_000 {
            assert!(WebSocketTraceSink::from_config(&config).is_none());
        }
        assert!(!config.path.exists());
    }

    #[test]
    fn diagnostic_trace_sink_preserves_order_metadata() {
        let directory = tempfile::tempdir().expect("create temporary trace directory");
        let path = directory.path().join("websocket-events.log");
        let config = WebSocketTraceConfig {
            enabled: true,
            path: path.clone(),
        };
        let sink = WebSocketTraceSink::from_config(&config).expect("diagnostic sink");

        sink.write(format_args!("RECV event='session_log_created'"));
        sink.write(format_args!("EMIT event='session_log_created'"));
        drop(sink);

        let trace = std::fs::read_to_string(path).expect("read diagnostic trace");
        let first = trace
            .find("#1] RECV event='session_log_created'")
            .expect("first trace sequence");
        let second = trace
            .find("#2] EMIT event='session_log_created'")
            .expect("second trace sequence");
        assert!(first < second, "trace sequence must preserve event order");
    }
}
