use std::time::Duration;
use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
};

use opentelemetry::{global, metrics::Counter, trace::TracerProvider as _, KeyValue};
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::{
    logs::SdkLoggerProvider, metrics::SdkMeterProvider, trace::SdkTracerProvider, Resource,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use vertebrae_sacrum_client::{
    ObservabilityConfig, ObservabilityLevel, ObservabilityProtocol, ObservabilitySignal,
    ObservabilitySubsystem,
};

const EXPORT_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Default)]
struct RuntimeSettings {
    config: ObservabilityConfig,
}

static SETTINGS: OnceLock<RuntimeSettings> = OnceLock::new();
static MESSAGE_EVENTS: OnceLock<Counter<u64>> = OnceLock::new();

pub(crate) struct TelemetryGuard {
    tracer_provider: Option<SdkTracerProvider>,
    meter_provider: Option<SdkMeterProvider>,
    logger_provider: Option<SdkLoggerProvider>,
    shutdown: AtomicBool,
}

impl TelemetryGuard {
    // Keep exporter initialization fail-open so telemetry cannot block GUI startup.
    pub(crate) fn initialize(config: ObservabilityConfig) -> Self {
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
                        .with_batch_exporter(exporter)
                        .build(),
                ),
                Err(_) => {
                    log::warn!("Could not create the configured OpenTelemetry trace exporter");
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
            if let Err(error) = tracing_subscriber::registry()
                .with(trace_layer)
                .with(log_layer)
                .with(make_filter(config))
                .try_init()
            {
                log::warn!("Could not install configured OpenTelemetry tracing layers: {error}");
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
    let mut end = content.len().min(32 * 1024);
    while !content.is_char_boundary(end) {
        end -= 1;
    }
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
            .with_endpoint(config.endpoint.clone())
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
            .with_endpoint(config.endpoint.clone())
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
            .with_endpoint(config.endpoint.clone())
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
