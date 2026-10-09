use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::Utc;
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, watch};
use vertebrae_harness_core::{
    ControlSink, DiagnosticEvent, EventCorrelation, EventSequencer, EventSink, HarnessError,
    HarnessEventDraftV1, HarnessEventPayloadV1, ProviderResumeId, ProviderThreadRef,
    SequencedEventSink, SessionCloseStatus, SessionId, SessionStarted, SpeedTier, StreamId,
    ThreadDeclared, ThreadId, ThreadKind, UpdateSemantics,
};

use super::connection::{CodexConnection, is_draining};
use super::session::SessionState;
use super::subscription::OwnedThreads;
use super::trace::trace;
use crate::{
    CodexAppServerEndpoint, CodexProviderConfig,
    launcher::{CodexAppServerLauncher, ManagedCodexAppServerLauncher},
    optional_string, required_string,
};

pub(crate) async fn setup_session(
    config: Arc<CodexProviderConfig>,
    stream_id: StreamId,
    request_config: vertebrae_harness_core::RequestConfig,
    resume_id: Option<ProviderResumeId>,
    event_sink: Arc<dyn EventSink>,
    control_sink: Arc<dyn ControlSink>,
) -> Result<Arc<SessionState>, HarnessError> {
    config.validate_request(&request_config)?;
    let default_output_schema = request_config.output_schema.clone();
    let thread_params = thread_params(&config, &request_config);
    let (method, params) = if let Some(resume) = &resume_id {
        (
            "thread/resume",
            resume_params(&thread_params, resume.as_str()),
        )
    } else {
        let mut params = thread_params.clone();
        params["serviceName"] = json!("vertebrae");
        ("thread/start", params)
    };
    let owned_threads = Arc::new(OwnedThreads::default());
    let (connection, response, skill_root_warnings) = attach(
        &config,
        &control_sink,
        &owned_threads,
        Some((method, &params)),
    )
    .await?;
    let sink = Arc::new(SequencedEventSink::new(
        Arc::new(EventSequencer::default()),
        event_sink,
    ));
    let thread = match required_string(
        response.get("thread").unwrap_or(&response),
        &["/id", "/thread/id"],
        "thread id",
    ) {
        Ok(thread) => thread,
        Err(error) => {
            connection.close().await;
            return Err(HarnessError::Operation(error));
        }
    };
    owned_threads.insert(thread.clone());
    trace(
        Some(&thread),
        "connection.attached",
        "internal",
        None,
        "running",
        Some(&format!("method={method}; stream_id={stream_id}")),
        None,
    );
    for warning in skill_root_warnings {
        if let Err(error) = emit_direct(
            &sink,
            stream_id.clone(),
            EventCorrelation::default(),
            HarnessEventPayloadV1::Warning(warning),
        )
        .await
        {
            connection.close().await;
            return Err(error);
        }
    }
    let model = optional_string(&response, &["/model"])
        .or(request_config.model)
        .unwrap_or_else(|| "Codex default".into());
    let root_session_id = SessionId::new(thread.clone());
    let root_thread_id = ThreadId::new(thread.clone());
    connection.set_root_thread(root_thread_id.clone());
    let provider_ref = ProviderThreadRef::new(thread.clone());
    let (closed, closed_rx) = watch::channel(false);
    let state = Arc::new(SessionState {
        connection: Mutex::new(connection),
        reconnect_gate: AsyncMutex::new(()),
        control_sink,
        owned_threads,
        resume_params: resume_params(&thread_params, &thread),
        config,
        sink,
        root_stream_id: stream_id.clone(),
        root_session_id: root_session_id.clone(),
        root_thread_id: root_thread_id.clone(),
        default_output_schema,
        root_turn_gate: AsyncMutex::new(()),
        cleanup: AsyncMutex::new(None),
        children: Mutex::new(HashMap::new()),
        declared_threads: Mutex::new([thread.clone()].into_iter().collect()),
        closed,
        closed_rx,
    });
    if let Err(error) = emit_direct(
        &state.sink,
        stream_id.clone(),
        state.root_correlation(None, None),
        HarnessEventPayloadV1::SessionStarted(SessionStarted {
            provider: "openai".into(),
            model: Some(model),
            provider_resume_id: Some(ProviderResumeId::new(thread.clone())),
            speed_tier_status: None,
            tools: Vec::new(),
        }),
    )
    .await
    {
        let _ = state
            .close(SessionCloseStatus::Failed, Some(error.to_string()))
            .await;
        return Err(error);
    }
    if let Err(error) = emit_direct(
        &state.sink,
        stream_id.clone(),
        state.root_correlation(None, None),
        HarnessEventPayloadV1::ThreadDeclared(ThreadDeclared {
            thread_id: root_thread_id,
            parent_thread_id: None,
            kind: ThreadKind::Root,
            caused_by_tool_call_id: None,
            provider_thread_ref: Some(provider_ref),
            agent_metadata: None,
        }),
    )
    .await
    {
        let _ = state
            .close(SessionCloseStatus::Failed, Some(error.to_string()))
            .await;
        return Err(error);
    }
    Ok(state)
}

fn add_developer_instructions(
    params: &mut Value,
    request_config: &vertebrae_harness_core::RequestConfig,
) {
    if let Some(instructions) = request_config
        .developer_instructions
        .as_deref()
        .map(str::trim)
        .filter(|instructions| !instructions.is_empty())
    {
        params["developerInstructions"] = json!(instructions);
    }
}

fn add_service_tier(params: &mut Value, request_config: &vertebrae_harness_core::RequestConfig) {
    let Some(speed_tier) = request_config.speed_tier else {
        return;
    };
    params["serviceTier"] = json!(match speed_tier {
        SpeedTier::Default => "default",
        SpeedTier::Fast => "priority",
    });
}

/// Thread parameters shared by `thread/start` and `thread/resume`. Codex does
/// not persist per-thread config, so resume carries the same parameters.
fn thread_params(
    config: &CodexProviderConfig,
    request_config: &vertebrae_harness_core::RequestConfig,
) -> Value {
    let mut params = json!({});
    if let Some(cwd) = &request_config.working_directory {
        params["cwd"] = json!(cwd);
    }
    if let Some(model) = &request_config.model {
        params["model"] = json!(model);
    }
    if let Some(effort) = &request_config.reasoning_effort {
        params["effort"] = json!(effort);
    }
    add_service_tier(&mut params, request_config);
    if let Some(personality) = &request_config.personality {
        params["personality"] = json!(personality);
    }
    if let Some(provider) = config.effective_model_provider() {
        params["modelProvider"] = json!(provider);
    }
    add_developer_instructions(&mut params, request_config);
    config.permission.apply_to_params(&mut params);
    if let Some(thread_config) = thread_config(config, request_config) {
        params["config"] = thread_config;
    }
    params
}

fn resume_params(thread_params: &Value, thread_id: &str) -> Value {
    let mut params = thread_params.clone();
    params["threadId"] = json!(thread_id);
    params["excludeTurns"] = json!(true);
    params
}

/// Per-thread config overrides for the shared App Server daemon: the custom
/// model provider, output verbosity, and the tool-execution environment.
/// None of these may be applied to the daemon process itself.
fn thread_config(
    config: &CodexProviderConfig,
    request_config: &vertebrae_harness_core::RequestConfig,
) -> Option<Value> {
    let mut table = serde_json::Map::new();
    if let Some(provider) = &config.custom_model_provider {
        table.insert(
            "model_providers".into(),
            json!({ provider.id.clone(): provider.thread_provider_table() }),
        );
    }
    if let Some(verbosity) = request_config.verbosity {
        table.insert("model_verbosity".into(), json!(verbosity.as_str()));
    }
    let environment = tool_environment(config, request_config);
    if !environment.is_empty() {
        // `inherit = "all"` keeps Codex's default policy for the daemon's own
        // environment; `set` layers the surface and request environment on
        // top. Codex still prepends its own entries (for example
        // `~/.cargo/bin` and its codex-path directory) to PATH.
        table.insert(
            "shell_environment_policy".into(),
            json!({"inherit": "all", "set": environment}),
        );
    }
    (!table.is_empty()).then_some(Value::Object(table))
}

/// Environment for tool execution in Codex turns: surface, custom-provider,
/// and request variables plus the request PATH. Codex's default policy
/// excludes inherited variables whose names contain KEY, SECRET, or TOKEN;
/// the same names are withheld from the explicit set.
fn tool_environment(
    config: &CodexProviderConfig,
    request_config: &vertebrae_harness_core::RequestConfig,
) -> BTreeMap<String, String> {
    let mut environment = config.environment.clone();
    if let Some(provider) = &config.custom_model_provider {
        environment.extend(provider.environment.clone());
    }
    environment.extend(request_config.environment.clone());
    environment.retain(|name, _| {
        let name = name.to_ascii_uppercase();
        !["KEY", "SECRET", "TOKEN"]
            .iter()
            .any(|pattern| name.contains(pattern))
    });
    if let Some(path) = request_config.environment.get("PATH").cloned().or_else(|| {
        config
            .search_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned())
    }) {
        environment.insert("PATH".into(), path);
    }
    environment
}

/// Attach to the App Server (starting the managed daemon when absent) and
/// optionally send one thread request. Connection, initialization, and
/// draining failures retry with backoff; launcher failures are final.
pub(crate) async fn attach(
    config: &CodexProviderConfig,
    control_sink: &Arc<dyn ControlSink>,
    owned_threads: &Arc<OwnedThreads>,
    request: Option<(&str, &Value)>,
) -> Result<(Arc<CodexConnection>, Value, Vec<DiagnosticEvent>), HarnessError> {
    let launcher: Arc<dyn CodexAppServerLauncher> = config
        .launcher
        .clone()
        .unwrap_or_else(|| Arc::new(ManagedCodexAppServerLauncher::new(Arc::new(config.clone()))));
    let attempts = config.launch_attempts.max(1);
    let mut attempt = 0;
    loop {
        attempt += 1;
        let launched = launcher.launch().await?;
        let error =
            match connect_and_initialize(config, &launched.endpoint, control_sink, owned_threads)
                .await
            {
                Err(error) => error,
                Ok(connection) => {
                    let warnings = register_skill_roots(config, &connection).await;
                    let Some((method, params)) = request else {
                        return Ok((connection, Value::Null, warnings));
                    };
                    match connection
                        .request_with_timeout(method, params.clone(), config.request_timeout, None)
                        .await
                    {
                        Ok(response) => return Ok((connection, response, warnings)),
                        Err(error) => {
                            connection.close().await;
                            // A draining rejection is the only request failure
                            // known not to have started work (`thread/start` is
                            // not idempotent).
                            if !is_draining(&error) {
                                return Err(error);
                            }
                            error
                        }
                    }
                }
            };
        if attempt >= attempts {
            return Err(error);
        }
        log::info!("[Codex] App Server attach attempt {attempt} failed; retrying: {error}");
        tokio::time::sleep(Duration::from_millis(250 * attempt as u64)).await;
    }
}

async fn connect_and_initialize(
    config: &CodexProviderConfig,
    endpoint: &CodexAppServerEndpoint,
    control_sink: &Arc<dyn ControlSink>,
    owned_threads: &Arc<OwnedThreads>,
) -> Result<Arc<CodexConnection>, HarnessError> {
    let connection = CodexConnection::connect(
        endpoint,
        Arc::clone(control_sink),
        Arc::clone(owned_threads),
    )
    .await?;
    let initialized = async {
        connection
            .request_with_timeout(
                "initialize",
                json!({"clientInfo":{"name":config.client_name,"title":config.client_title,"version":config.client_version},"capabilities":{"experimentalApi":true}}),
                config.request_timeout,
                None,
            )
            .await?;
        connection.notify("initialized", json!({})).await
    }
    .await;
    match initialized {
        Ok(()) => Ok(connection),
        Err(error) => {
            connection.close().await;
            Err(error)
        }
    }
}

async fn register_skill_roots(
    config: &CodexProviderConfig,
    connection: &CodexConnection,
) -> Vec<DiagnosticEvent> {
    let mut warnings = Vec::new();
    for root in &config.installed_skills_roots {
        if root.is_absolute() && root.is_dir() {
            if let Err(error) = connection
                .request("skills/extraRoots/set", json!({"extraRoots":[root]}))
                .await
            {
                warnings.push(DiagnosticEvent {
                    message: format!(
                        "Codex installed skill root registration failed for {}: {error}",
                        root.display()
                    ),
                    code: Some("codex_skill_root_registration".into()),
                });
            }
        } else {
            warnings.push(DiagnosticEvent {
                message: format!(
                    "Codex installed skill root was not registered: {}",
                    root.display()
                ),
                code: Some("codex_invalid_skill_root".into()),
            });
        }
    }
    warnings
}

async fn emit_direct(
    sink: &Arc<SequencedEventSink>,
    stream: StreamId,
    correlation: EventCorrelation,
    payload: HarnessEventPayloadV1,
) -> Result<(), HarnessError> {
    sink.emit(HarnessEventDraftV1 {
        stream_id: stream,
        correlation,
        timestamp: Utc::now(),
        semantics: UpdateSemantics::Snapshot,
        provider_sequence: None,
        payload,
    })
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        add_developer_instructions, add_service_tier, resume_params, thread_config, thread_params,
    };
    use crate::{CodexCustomModelProvider, CodexProviderConfig};
    use vertebrae_harness_core::{OutputVerbosity, SpeedTier};

    #[test]
    fn maps_additive_instructions_to_codex_developer_layer() {
        let mut params = json!({"serviceName": "vertebrae"});
        add_developer_instructions(
            &mut params,
            &vertebrae_harness_core::RequestConfig {
                verbosity: None,
                developer_instructions: Some("reference contract".into()),
                ..Default::default()
            },
        );
        assert_eq!(params["developerInstructions"], "reference contract");
    }

    #[test]
    fn maps_speed_tiers_to_codex_service_tiers() {
        for (speed_tier, service_tier) in [
            (SpeedTier::Default, "default"),
            (SpeedTier::Fast, "priority"),
        ] {
            let mut params = json!({});
            add_service_tier(
                &mut params,
                &vertebrae_harness_core::RequestConfig {
                    verbosity: None,
                    speed_tier: Some(speed_tier),
                    ..Default::default()
                },
            );
            assert_eq!(params["serviceTier"], service_tier);
        }
    }

    #[test]
    fn omits_codex_service_tier_when_unset() {
        let mut params = json!({"serviceName": "vertebrae"});
        add_service_tier(
            &mut params,
            &vertebrae_harness_core::RequestConfig::default(),
        );
        assert_eq!(params, json!({"serviceName": "vertebrae"}));
    }

    #[test]
    fn maps_verbosity_to_a_per_thread_codex_config_override() {
        let config = thread_config(
            &CodexProviderConfig {
                search_path: None,
                ..Default::default()
            },
            &vertebrae_harness_core::RequestConfig {
                verbosity: Some(OutputVerbosity::Medium),
                ..Default::default()
            },
        )
        .expect("thread config");
        assert_eq!(config, json!({"model_verbosity": "medium"}));
    }

    #[test]
    fn custom_model_provider_travels_per_thread_with_a_bearer_token() {
        let config = CodexProviderConfig {
            search_path: None,
            custom_model_provider: Some(CodexCustomModelProvider {
                id: "openrouter".into(),
                base_url: Some("https://openrouter.ai/api/v1".into()),
                api_key: Some("provider-secret".into()),
                wire_api: Some("chat".into()),
                environment: [("OPENROUTER_REFERER".to_string(), "vtb".to_string())].into(),
            }),
            ..Default::default()
        };
        let request = vertebrae_harness_core::RequestConfig {
            environment: [("PATH".to_string(), "/usr/bin:/bin".to_string())].into(),
            ..Default::default()
        };

        let params = thread_params(&config, &request);

        assert_eq!(params["modelProvider"], "openrouter");
        assert_eq!(
            params["config"]["model_providers"]["openrouter"],
            json!({
                "name": "openrouter",
                "base_url": "https://openrouter.ai/api/v1",
                "wire_api": "chat",
                "experimental_bearer_token": "provider-secret",
            })
        );
        assert_eq!(
            params["config"]["shell_environment_policy"],
            json!({
                "inherit": "all",
                "set": {"OPENROUTER_REFERER": "vtb", "PATH": "/usr/bin:/bin"},
            })
        );
        assert!(!format!("{config:?}").contains("provider-secret"));

        let resume = resume_params(&params, "root-thread");
        assert_eq!(resume["threadId"], "root-thread");
        assert_eq!(resume["excludeTurns"], true);
        assert_eq!(resume["config"], params["config"]);
        assert!(resume.get("serviceName").is_none());
    }

    #[test]
    fn tool_environment_withholds_secret_names_and_falls_back_to_the_search_path() {
        let config = CodexProviderConfig {
            search_path: Some("/opt/bin:/usr/bin".into()),
            environment: [
                ("OPENAI_API_KEY".to_string(), "sk".to_string()),
                ("GITHUB_TOKEN".to_string(), "gh".to_string()),
                ("client_secret".to_string(), "s".to_string()),
                ("LANG".to_string(), "C".to_string()),
            ]
            .into(),
            ..Default::default()
        };

        let thread_config =
            thread_config(&config, &vertebrae_harness_core::RequestConfig::default())
                .expect("thread config");

        assert_eq!(
            thread_config["shell_environment_policy"]["set"],
            json!({"LANG": "C", "PATH": "/opt/bin:/usr/bin"})
        );
    }

    #[test]
    fn omits_thread_config_when_nothing_is_overridden() {
        let config = CodexProviderConfig {
            search_path: None,
            ..Default::default()
        };
        assert!(
            thread_config(&config, &vertebrae_harness_core::RequestConfig::default()).is_none()
        );
    }
}
