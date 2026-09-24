use std::{
    collections::BTreeSet,
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    time::Duration,
};

use opentelemetry::{global, metrics::Counter, trace::TracerProvider as _, KeyValue};
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::{
    error::OTelSdkResult,
    logs::SdkLoggerProvider,
    metrics::SdkMeterProvider,
    trace::{SdkTracerProvider, SpanData, SpanExporter as SdkSpanExporter},
    Resource,
};
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::{layer::SubscriberExt, EnvFilter};
use vertebrae_sacrum_client::{
    ObservabilityConfig, ObservabilityLevel, ObservabilityProtocol, ObservabilitySignal,
    ObservabilitySubsystem,
};

const EXPORT_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const MESSAGE_CONTENT_LIMIT_BYTES: usize = 32 * 1024;
const MAX_INFERENCE_DELTA_EVENTS_PER_TURN: u32 = 2_048;
const OTLP_TRACES_PATH: &str = "/v1/traces";
const OTLP_METRICS_PATH: &str = "/v1/metrics";
const OTLP_LOGS_PATH: &str = "/v1/logs";

// TEMP: keep these diagnostics while investigating why GUI spans are missing in SigNoz.
#[derive(Debug)]
struct DiagnosticSpanExporter {
    inner: opentelemetry_otlp::SpanExporter,
}

impl SdkSpanExporter for DiagnosticSpanExporter {
    fn export(&self, batch: Vec<SpanData>) -> impl Future<Output = OTelSdkResult> + Send {
        let batch_span_count = batch.len();
        let span_names = batch
            .iter()
            .map(|span| span.name.as_ref())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
            .join(",");
        let started_at = std::time::Instant::now();
        log::info!(
            target: "vertebrae.telemetry",
            "[OTEL-DIAG] exporting trace batch: span_count={batch_span_count} span_names={span_names}"
        );

        let export = self.inner.export(batch);
        async move {
            let result = export.await;
            match &result {
                Ok(()) => log::info!(
                    target: "vertebrae.telemetry",
                    "[OTEL-DIAG] trace batch export succeeded: span_count={batch_span_count} elapsed_ms={}",
                    started_at.elapsed().as_millis()
                ),
                Err(error) => log::error!(
                    target: "vertebrae.telemetry",
                    "[OTEL-DIAG] trace batch export failed: span_count={batch_span_count} elapsed_ms={} error={error:?}",
                    started_at.elapsed().as_millis()
                ),
            }
            result
        }
    }

    fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.inner.shutdown_with_timeout(timeout)
    }

    fn force_flush(&self) -> OTelSdkResult {
        self.inner.force_flush()
    }

    fn set_resource(&mut self, resource: &Resource) {
        self.inner.set_resource(resource);
    }
}

#[derive(Clone, Default)]
struct RuntimeSettings {
    config: ObservabilityConfig,
}

static SETTINGS: OnceLock<RuntimeSettings> = OnceLock::new();
static MESSAGE_EVENTS: OnceLock<Counter<u64>> = OnceLock::new();

pub(crate) struct ClaudeInferenceTrace {
    span: tracing::Span,
    delta_sequence: u64,
    dropped_delta_events: u64,
    captured_content_bytes: usize,
    finished: bool,
}

impl ClaudeInferenceTrace {
    pub(crate) fn new(span: tracing::Span) -> Self {
        Self {
            span,
            delta_sequence: 0,
            dropped_delta_events: 0,
            captured_content_bytes: 0,
            finished: false,
        }
    }

    pub(crate) fn record_text_delta(&mut self, delta: InferenceDelta<'_>, text: &str) {
        self.record_text_delta_with_capture(
            delta,
            text,
            capture_message_content(),
            MESSAGE_CONTENT_LIMIT_BYTES,
            MAX_INFERENCE_DELTA_EVENTS_PER_TURN,
        );
    }

    fn record_text_delta_with_capture(
        &mut self,
        delta: InferenceDelta<'_>,
        text: &str,
        capture_content: bool,
        content_limit_bytes: usize,
        max_delta_events: u32,
    ) {
        if self.finished {
            return;
        }
        if self.delta_sequence >= u64::from(max_delta_events) {
            self.delta_sequence = self.delta_sequence.saturating_add(1);
            self.dropped_delta_events = self.dropped_delta_events.saturating_add(1);
            return;
        }
        let captured_len = if capture_content {
            utf8_prefix_len(
                text,
                content_limit_bytes.saturating_sub(self.captured_content_bytes),
            )
        } else {
            0
        };
        let content_captured = capture_content
            && self.captured_content_bytes < content_limit_bytes
            && (text.is_empty() || captured_len > 0);
        let content_truncated = capture_content && captured_len < text.len();
        let mut attributes = vec![
            KeyValue::new("event.id", delta.event_id.to_owned()),
            KeyValue::new("stream.id", delta.stream_id.to_owned()),
            KeyValue::new("session.id", delta.session_id.to_owned()),
            KeyValue::new("turn.id", delta.turn_id.to_owned()),
            KeyValue::new("event.sequence", otel_i64(delta.sequence)),
            KeyValue::new("event.timestamp", delta.timestamp.to_owned()),
            KeyValue::new("message.delta.sequence", otel_i64(self.delta_sequence)),
            KeyValue::new("message.delta.type", "text"),
            KeyValue::new("message.content_len", otel_i64(text.len() as u64)),
            KeyValue::new(
                "message.content_captured_bytes",
                otel_i64(captured_len as u64),
            ),
            KeyValue::new("message.content_captured", content_captured),
            KeyValue::new("message.content_truncated", content_truncated),
        ];
        append_optional(&mut attributes, "thread.id", delta.thread_id);
        append_optional(&mut attributes, "run.id", delta.run_id);
        append_optional(&mut attributes, "message.item_id", delta.item_id);
        append_optional(&mut attributes, "tool.call_id", delta.tool_call_id);
        append_optional(
            &mut attributes,
            "tool.parent_call_id",
            delta.parent_tool_call_id,
        );
        append_optional(
            &mut attributes,
            "provider.resume_id",
            delta.provider_resume_id,
        );
        if let Some(provider_sequence) = delta.provider_sequence {
            attributes.push(KeyValue::new(
                "event.provider_sequence",
                otel_i64(provider_sequence),
            ));
        }
        if content_captured {
            attributes.push(KeyValue::new(
                "message.delta",
                text[..captured_len].to_owned(),
            ));
        }

        self.span
            .add_event("local_chat.inference_delta", attributes);
        self.delta_sequence = self.delta_sequence.saturating_add(1);
        self.captured_content_bytes = self.captured_content_bytes.saturating_add(captured_len);
    }

    pub(crate) fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.span
            .record("inference.delta_count", otel_i64(self.delta_sequence));
        self.span.record(
            "inference.delta_events_dropped",
            otel_i64(self.dropped_delta_events),
        );
        self.finished = true;
    }
}

pub(crate) struct InferenceDelta<'a> {
    pub(crate) event_id: &'a str,
    pub(crate) stream_id: &'a str,
    pub(crate) sequence: u64,
    pub(crate) provider_sequence: Option<u64>,
    pub(crate) timestamp: &'a str,
    pub(crate) session_id: &'a str,
    pub(crate) thread_id: Option<&'a str>,
    pub(crate) turn_id: &'a str,
    pub(crate) run_id: Option<&'a str>,
    pub(crate) item_id: Option<&'a str>,
    pub(crate) tool_call_id: Option<&'a str>,
    pub(crate) parent_tool_call_id: Option<&'a str>,
    pub(crate) provider_resume_id: Option<&'a str>,
}

fn append_optional(attributes: &mut Vec<KeyValue>, key: &'static str, value: Option<&str>) {
    if let Some(value) = value {
        attributes.push(KeyValue::new(key, value.to_owned()));
    }
}

fn otel_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn utf8_prefix_len(text: &str, max_bytes: usize) -> usize {
    let mut end = text.len().min(max_bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}

pub(crate) struct TelemetryGuard {
    tracer_provider: Option<SdkTracerProvider>,
    meter_provider: Option<SdkMeterProvider>,
    logger_provider: Option<SdkLoggerProvider>,
    shutdown: AtomicBool,
}

impl TelemetryGuard {
    // Keep exporter initialization fail-open so telemetry cannot block GUI startup.
    pub(crate) fn initialize(config: ObservabilityConfig) -> Self {
        // TEMP: keep this summary while investigating missing GUI spans. Message bodies
        // and the configured endpoint are intentionally excluded from console output.
        log::info!(
            target: "vertebrae.telemetry",
            "[OTEL-DIAG] initializing telemetry: enabled={} protocol={:?} signals={:?} subsystems={:?} level={:?} capture_message_content={}",
            config.enabled,
            config.protocol,
            config.signals,
            config.subsystems,
            config.level,
            config.capture_message_content
        );
        let _ = SETTINGS.set(RuntimeSettings {
            config: config.clone(),
        });
        let mut guard = Self {
            tracer_provider: None,
            meter_provider: None,
            logger_provider: None,
            shutdown: AtomicBool::new(false),
        };

        if !config.enabled {
            return guard;
        }
        if config.signals.is_empty() || config.subsystems.is_empty() {
            log::warn!("OpenTelemetry is enabled but has no signals or subsystems selected");
            return guard;
        }
        if validate_endpoint(&config.endpoint).is_err() {
            log::warn!(
                "OpenTelemetry endpoint must be an HTTP(S) URL without credentials or a path"
            );
            return guard;
        }

        let resource = Resource::builder()
            .with_service_name("vertebrae-gui")
            .build();

        let tracer_provider = if config.signals.contains(&ObservabilitySignal::Traces) {
            match build_span_exporter(&config) {
                Ok(exporter) => Some(
                    SdkTracerProvider::builder()
                        .with_resource(resource.clone())
                        .with_max_events_per_span(MAX_INFERENCE_DELTA_EVENTS_PER_TURN)
                        .with_batch_exporter(DiagnosticSpanExporter { inner: exporter })
                        .build(),
                ),
                Err(error) => {
                    log::error!(
                        target: "vertebrae.telemetry",
                        "[OTEL-DIAG] could not create trace exporter: {error:?}"
                    );
                    None
                }
            }
        } else {
            None
        };
        let trace_layer = tracer_provider.as_ref().map(|provider| {
            tracing_opentelemetry::layer().with_tracer(provider.tracer("vertebrae.gui"))
        });

        if config.signals.contains(&ObservabilitySignal::Metrics) {
            match build_metric_exporter(&config) {
                Ok(exporter) => {
                    let provider = SdkMeterProvider::builder()
                        .with_resource(resource.clone())
                        .with_periodic_exporter(exporter)
                        .build();
                    global::set_meter_provider(provider.clone());
                    guard.meter_provider = Some(provider);
                }
                Err(_) => {
                    log::warn!("Could not create the configured OpenTelemetry metrics exporter")
                }
            }
        }

        let logger_provider = if config.signals.contains(&ObservabilitySignal::Logs) {
            match build_log_exporter(&config) {
                Ok(exporter) => Some(
                    SdkLoggerProvider::builder()
                        .with_resource(resource)
                        .with_batch_exporter(exporter)
                        .build(),
                ),
                Err(_) => {
                    log::warn!("Could not create the configured OpenTelemetry log exporter");
                    None
                }
            }
        } else {
            None
        };
        let log_layer = logger_provider.as_ref().map(|provider| {
            opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge::new(provider)
        });

        if trace_layer.is_some() || log_layer.is_some() {
            let subscriber = tracing_subscriber::registry()
                .with(trace_layer)
                .with(log_layer)
                .with(make_filter(config));
            match tracing::subscriber::set_global_default(subscriber) {
                Ok(()) => log::info!(
                    target: "vertebrae.telemetry",
                    "[OTEL-DIAG] OpenTelemetry tracing subscriber installed"
                ),
                Err(error) => log::warn!(
                    target: "vertebrae.telemetry",
                    "[OTEL-DIAG] could not install OpenTelemetry tracing subscriber: {error}"
                ),
            }
        }
        guard.tracer_provider = tracer_provider;
        guard.logger_provider = logger_provider;

        if guard.tracer_provider.is_some()
            || guard.meter_provider.is_some()
            || guard.logger_provider.is_some()
        {
            log::info!("Configured OpenTelemetry collection for selected Vertebrae GUI signals");
        }
        guard
    }

    pub(crate) fn shutdown(&self) {
        if self.shutdown.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(provider) = &self.tracer_provider {
            if provider.shutdown_with_timeout(SHUTDOWN_TIMEOUT).is_err() {
                log::warn!("Timed out shutting down the OpenTelemetry trace exporter");
            }
        }
        if let Some(provider) = &self.meter_provider {
            if provider.shutdown_with_timeout(SHUTDOWN_TIMEOUT).is_err() {
                log::warn!("Timed out shutting down the OpenTelemetry metrics exporter");
            }
        }
        if let Some(provider) = &self.logger_provider {
            if provider.shutdown_with_timeout(SHUTDOWN_TIMEOUT).is_err() {
                log::warn!("Timed out shutting down the OpenTelemetry log exporter");
            }
        }
    }
}

pub(crate) fn record_message_received(
    origin: &'static str,
    session_id: &str,
    thread_id: &str,
    turn_id: Option<&str>,
    sequence: Option<u64>,
    timestamp: Option<&str>,
    content: &str,
) {
    if enabled_for_claude_chat(ObservabilitySignal::Traces) {
        // TEMP: log span creation without exposing the message body.
        log::info!(
            target: "vertebrae.telemetry",
            "[OTEL-DIAG] creating local-chat message span: origin={origin} content_bytes={}",
            content.len()
        );
        let span = tracing::info_span!(
            target: "vertebrae.local_chat.claude_code",
            "local_chat.message_received",
            message.origin = origin,
            session.id = session_id,
            thread.id = thread_id,
            turn.id = turn_id.unwrap_or_default(),
            message.sequence = sequence.unwrap_or_default(),
            message.timestamp = timestamp.unwrap_or_default(),
            message.content_len = content.len(),
            message.content = tracing::field::Empty,
        );
        record_message_content(&span, content);
        let _entered = span.enter();
        tracing::info!(
            target: "vertebrae.local_chat.claude_code",
            message_origin = origin,
            session_id,
            thread_id,
            turn_id = turn_id.unwrap_or_default(),
            message_sequence = sequence.unwrap_or_default(),
            message_timestamp = timestamp.unwrap_or_default(),
            message_content_len = content.len(),
            "Human chat message received"
        );
    } else if enabled_for_claude_chat(ObservabilitySignal::Logs) {
        tracing::info!(
            target: "vertebrae.local_chat.claude_code",
            message_origin = origin,
            session_id,
            thread_id,
            turn_id = turn_id.unwrap_or_default(),
            message_sequence = sequence.unwrap_or_default(),
            message_timestamp = timestamp.unwrap_or_default(),
            message_content_len = content.len(),
            "Human chat message received"
        );
    }
    record_claude_chat_metric(origin, "received");
}

pub(crate) fn record_message_outcome(origin: &'static str, outcome: &'static str) {
    record_claude_chat_metric(origin, outcome);
}

pub(crate) fn record_message_content(span: &tracing::Span, content: &str) {
    if !capture_message_content() {
        return;
    }
    let end = utf8_prefix_len(content, MESSAGE_CONTENT_LIMIT_BYTES);
    span.record("message.content", &content[..end]);
}

pub(crate) fn traces_enabled(subsystem: ObservabilitySubsystem) -> bool {
    if matches!(
        subsystem,
        ObservabilitySubsystem::LocalChat | ObservabilitySubsystem::ClaudeCode
    ) {
        enabled_for_claude_chat(ObservabilitySignal::Traces)
    } else {
        enabled_for(subsystem, ObservabilitySignal::Traces)
    }
}

pub(crate) fn capture_message_content() -> bool {
    SETTINGS.get().is_some_and(|settings| {
        settings.config.enabled
            && settings.config.capture_message_content
            && settings
                .config
                .signals
                .contains(&ObservabilitySignal::Traces)
    })
}

fn enabled_for(subsystem: ObservabilitySubsystem, signal: ObservabilitySignal) -> bool {
    SETTINGS.get().is_some_and(|settings| {
        settings.config.enabled
            && settings.config.signals.contains(&signal)
            && settings.config.subsystems.contains(&subsystem)
    })
}

fn record_claude_chat_metric(origin: &'static str, outcome: &'static str) {
    if !enabled_for_claude_chat(ObservabilitySignal::Metrics) {
        return;
    }
    let counter = MESSAGE_EVENTS.get_or_init(|| {
        global::meter("vertebrae.gui.local_chat")
            .u64_counter("vertebrae.local_chat.message_events")
            .with_description("Observed live and replayed local chat message events")
            .build()
    });
    counter.add(
        1,
        &[
            KeyValue::new("origin", origin),
            KeyValue::new("outcome", outcome),
        ],
    );
}

fn enabled_for_claude_chat(signal: ObservabilitySignal) -> bool {
    enabled_for(ObservabilitySubsystem::LocalChat, signal)
        || enabled_for(ObservabilitySubsystem::ClaudeCode, signal)
}

fn validate_endpoint(endpoint: &str) -> Result<(), ()> {
    let url = url::Url::parse(endpoint).map_err(|_| ())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(());
    }
    Ok(())
}

fn make_filter(config: ObservabilityConfig) -> EnvFilter {
    let level = match config.level {
        ObservabilityLevel::Trace => "trace",
        ObservabilityLevel::Debug => "debug",
        ObservabilityLevel::Info => "info",
        ObservabilityLevel::Warn => "warn",
        ObservabilityLevel::Error => "error",
    };
    let targets = config
        .subsystems
        .iter()
        .flat_map(|_| ["vertebrae.local_chat", "vertebrae.claude_code"])
        .collect::<BTreeSet<_>>();
    targets
        .into_iter()
        .fold(EnvFilter::new("off"), |filter, target| {
            let directive = format!("{target}={level}").parse();
            match directive {
                Ok(directive) => filter.add_directive(directive),
                Err(_) => filter,
            }
        })
}

fn build_span_exporter(
    config: &ObservabilityConfig,
) -> Result<opentelemetry_otlp::SpanExporter, opentelemetry_otlp::ExporterBuildError> {
    match config.protocol {
        ObservabilityProtocol::HttpProtobuf => opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_endpoint(http_signal_endpoint(&config.endpoint, OTLP_TRACES_PATH))
            .with_timeout(EXPORT_TIMEOUT)
            .with_protocol(Protocol::HttpBinary)
            .build(),
        ObservabilityProtocol::Grpc => opentelemetry_otlp::SpanExporter::builder()
            .with_tonic()
            .with_endpoint(config.endpoint.clone())
            .with_timeout(EXPORT_TIMEOUT)
            .build(),
    }
}

fn build_metric_exporter(
    config: &ObservabilityConfig,
) -> Result<opentelemetry_otlp::MetricExporter, opentelemetry_otlp::ExporterBuildError> {
    match config.protocol {
        ObservabilityProtocol::HttpProtobuf => opentelemetry_otlp::MetricExporter::builder()
            .with_http()
            .with_endpoint(http_signal_endpoint(&config.endpoint, OTLP_METRICS_PATH))
            .with_timeout(EXPORT_TIMEOUT)
            .with_protocol(Protocol::HttpBinary)
            .build(),
        ObservabilityProtocol::Grpc => opentelemetry_otlp::MetricExporter::builder()
            .with_tonic()
            .with_endpoint(config.endpoint.clone())
            .with_timeout(EXPORT_TIMEOUT)
            .build(),
    }
}

fn build_log_exporter(
    config: &ObservabilityConfig,
) -> Result<opentelemetry_otlp::LogExporter, opentelemetry_otlp::ExporterBuildError> {
    match config.protocol {
        ObservabilityProtocol::HttpProtobuf => opentelemetry_otlp::LogExporter::builder()
            .with_http()
            .with_endpoint(http_signal_endpoint(&config.endpoint, OTLP_LOGS_PATH))
            .with_timeout(EXPORT_TIMEOUT)
            .with_protocol(Protocol::HttpBinary)
            .build(),
        ObservabilityProtocol::Grpc => opentelemetry_otlp::LogExporter::builder()
            .with_tonic()
            .with_endpoint(config.endpoint.clone())
            .with_timeout(EXPORT_TIMEOUT)
            .build(),
    }
}

fn http_signal_endpoint(base_endpoint: &str, signal_path: &str) -> String {
    format!("{}{signal_path}", base_endpoint.trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use opentelemetry::{trace::TracerProvider as _, Value};
    use opentelemetry_sdk::{
        error::OTelSdkResult,
        trace::{SdkTracerProvider, SpanData, SpanExporter},
    };
    use tracing_subscriber::prelude::*;

    use super::{
        http_signal_endpoint, ClaudeInferenceTrace, InferenceDelta, OTLP_LOGS_PATH,
        OTLP_METRICS_PATH, OTLP_TRACES_PATH,
    };

    #[derive(Clone, Default, Debug)]
    struct MemorySpanExporter(Arc<Mutex<Vec<SpanData>>>);

    impl SpanExporter for MemorySpanExporter {
        async fn export(&self, mut batch: Vec<SpanData>) -> OTelSdkResult {
            self.0.lock().unwrap().append(&mut batch);
            Ok(())
        }
    }

    #[test]
    fn http_exporter_appends_the_otlp_signal_path_to_the_base_endpoint() {
        let endpoint = "http://192.168.1.39:30418/";

        assert_eq!(
            http_signal_endpoint(endpoint, OTLP_TRACES_PATH),
            "http://192.168.1.39:30418/v1/traces"
        );
        assert_eq!(
            http_signal_endpoint(endpoint, OTLP_METRICS_PATH),
            "http://192.168.1.39:30418/v1/metrics"
        );
        assert_eq!(
            http_signal_endpoint(endpoint, OTLP_LOGS_PATH),
            "http://192.168.1.39:30418/v1/logs"
        );
    }

    #[test]
    fn inference_text_deltas_are_correlated_and_respect_content_capture_limits() {
        let exporter = MemorySpanExporter::default();
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .build();
        let subscriber = tracing_subscriber::registry().with(
            tracing_opentelemetry::layer()
                .with_tracer(provider.tracer("telemetry-test"))
                .with_filter(tracing::level_filters::LevelFilter::TRACE),
        );

        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!(
                "local_chat.send_message",
                inference.delta_count = tracing::field::Empty,
                inference.delta_events_dropped = tracing::field::Empty,
            );
            let mut trace = ClaudeInferenceTrace::new(span);
            trace.record_text_delta_with_capture(
                test_delta("event-1", 41, 9001),
                "éclair",
                true,
                3,
                3,
            );
            trace.record_text_delta_with_capture(
                test_delta("event-2", 42, 9002),
                "tail",
                true,
                3,
                3,
            );
            trace.record_text_delta_with_capture(
                test_delta("event-3", 43, 9003),
                "private body omitted",
                false,
                3,
                3,
            );
            trace.record_text_delta_with_capture(
                test_delta("event-4", 44, 9004),
                "beyond event cap",
                false,
                3,
                3,
            );
            trace.finish();
        });
        drop(provider);

        let spans = exporter.0.lock().unwrap();
        let span = spans
            .iter()
            .find(|span| span.name == "local_chat.send_message")
            .expect("the turn send span is exported");
        assert_eq!(span.events.len(), 3);
        assert_eq!(span_int_attr(span, "inference.delta_count"), Some(4));
        assert_eq!(
            span_int_attr(span, "inference.delta_events_dropped"),
            Some(1)
        );

        let first = &span.events[0];
        assert_eq!(first.name, "local_chat.inference_delta");
        assert_eq!(string_attr(first, "turn.id"), Some("turn-1"));
        assert_eq!(string_attr(first, "thread.id"), Some("thread-1"));
        assert_eq!(string_attr(first, "stream.id"), Some("stream-1"));
        assert_eq!(string_attr(first, "message.item_id"), Some("item-1"));
        assert_eq!(string_attr(first, "tool.parent_call_id"), Some("tool-1"));
        assert_eq!(string_attr(first, "event.id"), Some("event-1"));
        assert_eq!(int_attr(first, "event.sequence"), Some(41));
        assert_eq!(int_attr(first, "event.provider_sequence"), Some(9001));
        assert_eq!(int_attr(first, "message.delta.sequence"), Some(0));
        assert_eq!(string_attr(first, "message.delta"), Some("éc"));
        assert_eq!(int_attr(first, "message.content_captured_bytes"), Some(3));
        assert_eq!(bool_attr(first, "message.content_truncated"), Some(true));

        let second = &span.events[1];
        assert_eq!(int_attr(second, "message.delta.sequence"), Some(1));
        assert_eq!(string_attr(second, "message.delta"), None);
        assert_eq!(bool_attr(second, "message.content_captured"), Some(false));
        assert_eq!(bool_attr(second, "message.content_truncated"), Some(true));

        let third = &span.events[2];
        assert_eq!(int_attr(third, "message.delta.sequence"), Some(2));
        assert_eq!(string_attr(third, "message.delta"), None);
        assert_eq!(bool_attr(third, "message.content_captured"), Some(false));
        assert_eq!(bool_attr(third, "message.content_truncated"), Some(false));
    }

    fn test_delta(
        event_id: &'static str,
        sequence: u64,
        provider_sequence: u64,
    ) -> InferenceDelta<'static> {
        InferenceDelta {
            event_id,
            stream_id: "stream-1",
            sequence,
            provider_sequence: Some(provider_sequence),
            timestamp: "2026-09-24T05:47:13Z",
            session_id: "session-1",
            thread_id: Some("thread-1"),
            turn_id: "turn-1",
            run_id: None,
            item_id: Some("item-1"),
            tool_call_id: None,
            parent_tool_call_id: Some("tool-1"),
            provider_resume_id: Some("resume-1"),
        }
    }

    fn string_attr<'a>(event: &'a opentelemetry::trace::Event, key: &str) -> Option<&'a str> {
        event
            .attributes
            .iter()
            .find(|attribute| attribute.key.as_str() == key)
            .and_then(|attribute| match &attribute.value {
                Value::String(value) => Some(value.as_str()),
                _ => None,
            })
    }

    fn int_attr(event: &opentelemetry::trace::Event, key: &str) -> Option<i64> {
        event
            .attributes
            .iter()
            .find(|attribute| attribute.key.as_str() == key)
            .and_then(|attribute| match attribute.value {
                Value::I64(value) => Some(value),
                _ => None,
            })
    }

    fn bool_attr(event: &opentelemetry::trace::Event, key: &str) -> Option<bool> {
        event
            .attributes
            .iter()
            .find(|attribute| attribute.key.as_str() == key)
            .and_then(|attribute| match attribute.value {
                Value::Bool(value) => Some(value),
                _ => None,
            })
    }

    fn span_int_attr(span: &SpanData, key: &str) -> Option<i64> {
        span.attributes
            .iter()
            .find(|attribute| attribute.key.as_str() == key)
            .and_then(|attribute| match &attribute.value {
                Value::I64(value) => Some(*value),
                _ => None,
            })
    }
}
