use futures::{stream, StreamExt};
use std::time::{Duration, Instant};
use std::{collections::HashMap, path::PathBuf, sync::Arc};

use async_trait::async_trait;
use tokio::sync::{Mutex, RwLock};
use vertebrae_harness::{AcpDiscovery, AcpRuntime, HarnessFactoryConfig, HarnessRuntimeFactory};
use vertebrae_harness_core::{
    HarnessError, HarnessRuntime, RequestConfig, SendTurnRequest, SessionHandle, SessionMode,
    SpeedTier, StartSessionRequest, TurnHandle, TurnId, TurnSettings,
};
use vertebrae_sacrum_client::config::lock_config_snapshot_at;

use super::shared::{steer_session, LocalChatControlSink, LocalChatHarnessEventSink};
use crate::local_chat::harness::{
    HarnessCreateSessionInput, LocalChatHarness, LocalChatHarnessInfo, LocalChatHarnessKind,
    LocalChatModelOption, LocalChatPermissionModeOption, LocalChatProviderInfo,
    LocalChatReasoningEffortOption, LocalChatRuntime, LocalChatSessionError,
    LocalChatSpeedTierOption, LocalChatTurnSettings,
};

type DiscoveryCache = HashMap<String, (Arc<AcpRuntime>, Instant, LocalChatProviderInfo)>;

pub(crate) struct AcpLocalChatHarness {
    discovery_cache: Mutex<DiscoveryCache>,
    config_path: Option<PathBuf>,
    sessions: Arc<RwLock<HashMap<String, Arc<ChatSession>>>>,
}

struct ChatSession {
    handle: Arc<dyn SessionHandle>,
    events: Arc<LocalChatHarnessEventSink>,
    active_turn: Mutex<Option<Arc<dyn TurnHandle>>>,
}

#[derive(serde::Serialize, specta::Type)]
pub(crate) struct RecoveredAcpMessage {
    user: bool,
    text: String,
}

impl AcpLocalChatHarness {
    pub(crate) fn new(config_path: Option<PathBuf>) -> Self {
        Self {
            discovery_cache: Mutex::default(),
            config_path,
            sessions: Default::default(),
        }
    }

    async fn with_agents<T: Send + 'static>(
        path: Option<PathBuf>,
        read: impl FnOnce(
                &vertebrae_sacrum_client::VertebraeConfigFile,
                &HarnessRuntimeFactory,
            ) -> Result<T, LocalChatSessionError>
            + Send
            + 'static,
    ) -> Result<T, LocalChatSessionError> {
        tokio::task::spawn_blocking(move || {
            let shell = crate::shell_environment::user_shell_environment();
            let factory = HarnessRuntimeFactory::new(HarnessFactoryConfig {
                search_path: Some(shell.path.into()),
                environment: shell.variables,
                ..Default::default()
            });
            match path {
                Some(path) => {
                    let snapshot = lock_config_snapshot_at(&path).map_err(|_| {
                        LocalChatSessionError::StartFailed(
                            "Could not read ACP settings from config.toml.".into(),
                        )
                    })?;
                    read(snapshot.config(), &factory)
                }
                None => read(&Default::default(), &factory),
            }
        })
        .await
        .map_err(|_| {
            LocalChatSessionError::StartFailed("Could not load ACP agent settings.".into())
        })?
    }

    async fn configured_adapter(
        path: Option<PathBuf>,
        provider_id: Option<String>,
    ) -> Result<Arc<AcpRuntime>, LocalChatSessionError> {
        Self::with_agents(path, move |config, factory| {
            let id = provider_id
                .as_deref()
                .and_then(|id| id.strip_prefix("local:acp:"));
            let (key, agent) = config
                .acp_agents()
                .find(|(key, _)| Some(key.as_str()) == id)
                .ok_or_else(|| {
                    LocalChatSessionError::StartFailed("Select a configured ACP connection.".into())
                })?;
            factory
                .create_acp_provider(key, agent)
                .map_err(|error| LocalChatSessionError::StartFailed(error.to_string()))
        })
        .await
    }

    pub(crate) async fn recover_history(
        config_path: Option<PathBuf>,
        provider_id: String,
        provider_resume_id: String,
        working_dir: PathBuf,
    ) -> Result<Vec<RecoveredAcpMessage>, LocalChatSessionError> {
        let adapter = Self::configured_adapter(config_path, Some(provider_id)).await?;
        let messages = adapter
            .load_history(Some(working_dir), &provider_resume_id)
            .await
            .map_err(|error| LocalChatSessionError::StartFailed(error.to_string()))?;
        Ok(messages
            .into_iter()
            .map(|message| RecoveredAcpMessage {
                user: message.user,
                text: message.text,
            })
            .collect())
    }

    async fn session(&self, id: &str) -> Result<Arc<ChatSession>, LocalChatSessionError> {
        self.sessions
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| LocalChatSessionError::SessionNotFound(id.into()))
    }
}

impl ChatSession {
    async fn send(
        self: Arc<Self>,
        content: &str,
        settings: LocalChatTurnSettings,
    ) -> Result<(), LocalChatSessionError> {
        let speed_tier = settings
            .speed_tier
            .as_deref()
            .map(|value| {
                SpeedTier::parse(value).ok_or_else(|| {
                    LocalChatSessionError::SendFailed("Unsupported ACP speed tier".into())
                })
            })
            .transpose()?;
        let mut active_turn = self.active_turn.lock().await;
        let turn = self
            .handle
            .send(SendTurnRequest {
                turn_id: TurnId::new(uuid::Uuid::new_v4().to_string()),
                content: content.into(),
                output_schema: None,
                settings: TurnSettings {
                    model: settings.model_id,
                    reasoning_effort: settings.reasoning_effort,
                    speed_tier,
                    permission_mode: settings.permission_mode.map(Into::into),
                },
            })
            .await
            .map_err(|error| match error {
                HarnessError::SessionNotFound(id) => LocalChatSessionError::SessionNotFound(id),
                error => LocalChatSessionError::SendFailed(error.to_string()),
            })?;
        *active_turn = Some(turn.clone());
        drop(active_turn);
        self.events.record_turn();
        tokio::spawn(async move {
            if let Err(error) = turn.await_outcome().await {
                let _ = self.events.emit_error(error.to_string());
            }
            let mut active = self.active_turn.lock().await;
            if active
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &turn))
            {
                *active = None;
            }
        });
        Ok(())
    }
}

#[async_trait]
impl LocalChatHarness for AcpLocalChatHarness {
    fn kind(&self) -> LocalChatHarnessKind {
        LocalChatHarnessKind::Acp
    }

    async fn info(&self) -> LocalChatHarnessInfo {
        LocalChatHarnessInfo {
            harness: self.kind(),
            label: "ACP agent".into(),
            available: true,
            unavailable_reason: None,
            default_model_id: None,
            models: Vec::new(),
            default_reasoning_effort: None,
            reasoning_efforts: Vec::new(),
            speed_tiers: Vec::new(),
            permission_modes: Some(Vec::new()),
            personality_options: None,
            supports_resume: false,
        }
    }

    async fn catalog_entries(
        &self,
    ) -> Result<(LocalChatHarnessInfo, Vec<LocalChatProviderInfo>), LocalChatSessionError> {
        let entries = Self::with_agents(self.config_path.clone(), |config, factory| {
            Ok(config
                .acp_agents()
                .map(|(id, agent)| {
                    let adapter = factory.create_acp_provider(id, agent);
                    let provider = LocalChatProviderInfo {
                        id: format!("local:acp:{id}"),
                        label: agent.name.clone().unwrap_or_else(|| id.to_string()),
                        harness: LocalChatHarnessKind::Acp,
                        custom: true,
                        available: adapter.is_ok(),
                        unavailable_reason: adapter.as_ref().err().map(ToString::to_string),
                        models: (!agent.models.is_empty()).then(|| {
                            agent
                                .models
                                .iter()
                                .map(|id| LocalChatModelOption {
                                    id: id.clone(),
                                    label: id.clone(),
                                    supported_reasoning_effort_ids: None,
                                    supported_speed_tier_ids: None,
                                    supports_personality: None,
                                })
                                .collect()
                        }),
                        default_model_id: agent.default_model.clone(),
                        discovered: None,
                        supports_steering: None,
                    };
                    (provider, adapter.ok())
                })
                .collect::<Vec<_>>())
        })
        .await?;
        let base = self.info().await;
        let mut cache = self.discovery_cache.lock().await;
        let mut previous = std::mem::take(&mut *cache);
        let probes = entries.into_iter().map(|(mut provider, adapter)| {
            let cached = previous.remove(&provider.id);
            let base = base.clone();
            async move {
                let Some(adapter) = adapter else {
                    return (provider, None);
                };
                if let Some((old, checked, result)) = cached {
                    if old == adapter && checked.elapsed() < Duration::from_secs(60) {
                        provider.discovered = result.discovered.clone();
                        provider.supports_steering = result.supports_steering;
                        provider.available = result.available;
                        provider.unavailable_reason = result.unavailable_reason.clone();
                        return (provider, Some((old, checked, result)));
                    }
                }
                match tokio::time::timeout(Duration::from_secs(12), adapter.discover()).await {
                    Ok(Ok(discovered)) => {
                        provider.supports_steering = Some(discovered.supports_steering);
                        provider.discovered = Some(discovered_info(base, discovered));
                    }
                    result => {
                        provider.available = false;
                        provider.unavailable_reason = Some(match result {
                            Ok(Err(error)) => error.to_string(),
                            Err(_) => "ACP connection discovery timed out.".into(),
                            Ok(Ok(_)) => unreachable!(),
                        });
                    }
                }
                let cached = (adapter, Instant::now(), provider.clone());
                (provider, Some(cached))
            }
        });
        let mut probes = stream::iter(probes).buffered(2);
        let mut providers = Vec::new();
        while let Some((mut provider, cached)) = probes.next().await {
            if let Some(cached) = cached {
                cache.insert(provider.id.clone(), cached);
            }
            if let Some(discovered) = &mut provider.discovered {
                if let Some(configured) = provider.models.take() {
                    discovered
                        .models
                        .retain(|model| configured.iter().any(|entry| entry.id == model.id));
                    if discovered.models.is_empty() {
                        provider.available = false;
                        provider.unavailable_reason =
                            Some("The ACP agent did not advertise any configured models.".into());
                    }
                }
                let preferred = provider
                    .default_model_id
                    .take()
                    .into_iter()
                    .chain(discovered.default_model_id.take())
                    .find(|model| discovered.models.iter().any(|entry| &entry.id == model));
                discovered.default_model_id =
                    preferred.or_else(|| discovered.models.first().map(|entry| entry.id.clone()));
            }
            providers.push(provider);
        }
        let mut info = self.info().await;
        info.available = providers.iter().any(|provider| provider.available);
        Ok((info, providers))
    }

    async fn create_session(
        &self,
        input: HarnessCreateSessionInput,
        runtime: LocalChatRuntime,
    ) -> Result<(), LocalChatSessionError> {
        if input.read_only || input.gate.is_some() {
            return Err(LocalChatSessionError::UnsupportedHarness(self.kind()));
        }
        let adapter = Self::configured_adapter(self.config_path.clone(), input.provider_id).await?;
        let id = input.backend_session_id;
        let events = Arc::new(
            LocalChatHarnessEventSink::new(
                id.clone(),
                self.kind(),
                runtime.event_sink(),
                None,
                0,
                true,
            )
            .with_recording(runtime.recording()),
        );
        let handle = adapter
            .start_session(
                StartSessionRequest {
                    session_id: id.as_str().into(),
                    stream_id: format!("local-chat:{id}").into(),
                    mode: input
                        .provider_resume_id
                        .map_or(SessionMode::New, |id| SessionMode::Resume(id.into())),
                    config: RequestConfig {
                        working_directory: input.working_dir.map(PathBuf::from),
                        ..Default::default()
                    },
                },
                events.clone(),
                Arc::new(LocalChatControlSink::new(id.clone(), runtime)),
            )
            .await
            .map_err(|error| LocalChatSessionError::StartFailed(error.to_string()))?;
        let session = Arc::new(ChatSession {
            handle,
            events,
            active_turn: Mutex::default(),
        });
        self.sessions
            .write()
            .await
            .insert(id.clone(), session.clone());
        if let Some(termination) = session.handle.termination() {
            let sessions = Arc::downgrade(&self.sessions);
            let session = Arc::downgrade(&session);
            let terminated_id = id.clone();
            tokio::spawn(async move {
                termination.await;
                if let (Some(sessions), Some(session)) = (sessions.upgrade(), session.upgrade()) {
                    let mut sessions = sessions.write().await;
                    if sessions
                        .get(&terminated_id)
                        .is_some_and(|current| Arc::ptr_eq(current, &session))
                    {
                        sessions.remove(&terminated_id);
                    }
                }
            });
        }
        let initial_turn = match input.initial_prompt {
            Some(prompt) => {
                session
                    .send(
                        &prompt,
                        LocalChatTurnSettings {
                            model_id: input.model_id,
                            reasoning_effort: input.reasoning_effort,
                            speed_tier: input.speed_tier,
                            permission_mode: input.permission_mode,
                        },
                    )
                    .await
            }
            None => Ok(()),
        };
        if let Err(error) = initial_turn {
            let _ = self.close_session(&id).await;
            return Err(error);
        }
        Ok(())
    }

    async fn send_message(
        &self,
        id: &str,
        content: &str,
        settings: LocalChatTurnSettings,
    ) -> Result<(), LocalChatSessionError> {
        self.session(id).await?.send(content, settings).await
    }

    async fn steer_turn(
        &self,
        id: &str,
        expected_turn_id: &str,
        content: String,
    ) -> Result<String, LocalChatSessionError> {
        steer_session(
            self.session(id).await?.handle.as_ref(),
            expected_turn_id,
            content,
        )
        .await
    }

    async fn close_session(&self, id: &str) -> Result<(), LocalChatSessionError> {
        let session = self
            .sessions
            .write()
            .await
            .remove(id)
            .ok_or_else(|| LocalChatSessionError::SessionNotFound(id.into()))?;
        session
            .handle
            .close()
            .await
            .map_err(|error| LocalChatSessionError::SendFailed(error.to_string()))?;
        Ok(())
    }

    async fn interrupt_turn(&self, id: &str) -> Result<(), LocalChatSessionError> {
        let session = self.session(id).await?;
        let turn = session.active_turn.lock().await.clone();
        if let Some(turn) = turn {
            turn.interrupt()
                .await
                .map_err(|error| LocalChatSessionError::SendFailed(error.to_string()))?;
        }
        Ok(())
    }

    async fn has_session(&self, id: &str) -> bool {
        self.sessions.read().await.contains_key(id)
    }
}

fn discovered_info(
    mut info: LocalChatHarnessInfo,
    discovery: AcpDiscovery,
) -> LocalChatHarnessInfo {
    let AcpDiscovery {
        config,
        model_options,
        supports_resume,
        ..
    } = discovery;
    info.supports_resume = supports_resume;
    for settings in
        std::iter::once(&config).chain(model_options.iter().map(|(_, settings)| settings))
    {
        for choice in settings.choices("thought_level") {
            if !info
                .reasoning_efforts
                .iter()
                .any(|effort| effort.id == choice.value)
            {
                info.reasoning_efforts.push(LocalChatReasoningEffortOption {
                    id: choice.value.clone(),
                    label: choice.name.clone(),
                });
            }
        }
        for choice in settings.choices("speed") {
            if SpeedTier::parse(&choice.value).is_some()
                && !info.speed_tiers.iter().any(|tier| tier.id == choice.value)
            {
                info.speed_tiers.push(LocalChatSpeedTierOption {
                    id: choice.value.clone(),
                    label: choice.name.clone(),
                    is_default: config.current("speed") == Some(&choice.value),
                });
            }
        }
    }
    info.default_model_id = config.current("model").map(str::to_owned);
    info.default_reasoning_effort = config.current("thought_level").map(str::to_owned);
    info.models = config
        .choices("model")
        .map(|choice| {
            let settings = model_options
                .iter()
                .find(|(model, _)| model == &choice.value)
                .map(|(_, settings)| settings)
                .or_else(|| (config.current("model") == Some(&choice.value)).then_some(&config));
            LocalChatModelOption {
                id: choice.value.clone(),
                label: choice.name.clone(),
                supported_reasoning_effort_ids: Some(
                    settings
                        .into_iter()
                        .flat_map(|settings| settings.choices("thought_level"))
                        .map(|effort| effort.value.clone())
                        .collect(),
                ),
                supported_speed_tier_ids: Some(
                    settings
                        .into_iter()
                        .flat_map(|settings| settings.choices("speed"))
                        .filter(|tier| SpeedTier::parse(&tier.value).is_some())
                        .map(|tier| tier.value.clone())
                        .collect(),
                ),
                supports_personality: None,
            }
        })
        .collect();
    info.permission_modes = Some(
        config
            .permission_modes()
            .map(|(mode, choice)| LocalChatPermissionModeOption {
                id: mode.into(),
                label: choice.name.clone(),
                is_default: config.current("mode") == Some(&choice.value),
            })
            .collect(),
    );
    info
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use vertebrae_core::{ProviderId, ProviderProfile, StepHarness};
    use vertebrae_sacrum_client::VertebraeConfigFile;

    #[tokio::test]
    async fn catalog_surfaces_agent_discovery_failure() {
        let directory = tempfile::tempdir().unwrap();
        let config = VertebraeConfigFile {
            providers: [(
                ProviderId::new("broken").unwrap(),
                ProviderProfile {
                    name: Some("Broken ACP".into()),
                    executable: Some("/usr/bin/false".into()),
                    ..ProviderProfile::new(StepHarness::Acp)
                },
            )]
            .into(),
            ..Default::default()
        };
        let path = directory.path().join("config.toml");
        std::fs::write(&path, toml::to_string(&config).unwrap()).unwrap();
        let harness = AcpLocalChatHarness::new(Some(path));
        for _ in 0..2 {
            let (info, providers) = harness.catalog_entries().await.unwrap();
            assert!(!info.available);
            assert_eq!(providers.len(), 1);
            assert!(!providers[0].available);
            assert!(providers[0].unavailable_reason.is_some());
        }
    }

    #[tokio::test]
    async fn acp_named_providers_route_to_their_own_literal_arguments() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = directory.path().join("fixture.py");
        std::fs::write(
            &fixture,
            r#"
import json, sys

def send(**fields):
    print(json.dumps(dict(jsonrpc='2.0', **fields)), flush=True)

for line in sys.stdin:
    req = json.loads(line)
    method = req['method']
    if method == 'initialize':
        send(id=req['id'], result={'protocolVersion': 1})
    elif method == 'session/new':
        send(id=req['id'], result={'sessionId': 'test'})
    elif method == 'session/prompt':
        send(method='session/update', params={
            'sessionId': 'test',
            'update': {'sessionUpdate': 'agent_message_chunk',
                       'content': {'type': 'text', 'text': sys.argv[1]}}
        })
        send(id=req['id'], result={'stopReason': 'end_turn'})
"#,
        )
        .unwrap();
        let config = VertebraeConfigFile {
            providers: ["first", "second"]
                .into_iter()
                .map(|name| {
                    (
                        ProviderId::new(name).unwrap(),
                        ProviderProfile {
                            name: Some(format!("Agent {name}")),
                            executable: Some("/usr/bin/env".into()),
                            args: vec![
                                "python3".into(),
                                fixture.to_str().unwrap().into(),
                                format!("{name} connection"),
                            ],
                            ..ProviderProfile::new(StepHarness::Acp)
                        },
                    )
                })
                .collect(),
            ..Default::default()
        };
        let path = directory.path().join("config.toml");
        std::fs::write(&path, toml::to_string(&config).unwrap()).unwrap();
        let harness = AcpLocalChatHarness::new(Some(path));
        let (info, providers) = harness.catalog_entries().await.unwrap();
        assert!(info.available);
        assert_eq!(providers.len(), 2);

        for (provider, name) in providers.into_iter().zip(["first", "second"]) {
            assert_eq!(provider.label, format!("Agent {name}"));
            assert_eq!(provider.id, format!("local:acp:{name}"));
            let (runtime, events) = LocalChatRuntime::capturing_for_tests();
            harness
                .create_session(
                    HarnessCreateSessionInput {
                        read_only: false,
                        backend_session_id: name.into(),
                        working_dir: Some(directory.path().to_str().unwrap().into()),
                        initial_prompt: None,
                        provider_resume_id: None,
                        model_id: None,
                        reasoning_effort: None,
                        speed_tier: None,
                        permission_mode: None,
                        personality: None,
                        provider: None,
                        provider_id: Some(provider.id),
                        gate: None,
                    },
                    runtime,
                )
                .await
                .unwrap();
            harness
                .send_message(name, "Hello", Default::default())
                .await
                .unwrap();
            let session = harness.session(name).await.unwrap();
            let turn = session.active_turn.lock().await.clone();
            if let Some(turn) = turn {
                tokio::time::timeout(std::time::Duration::from_secs(5), turn.await_outcome())
                    .await
                    .unwrap()
                    .unwrap();
            }
            assert!(events.lock().unwrap().iter().any(|event| matches!(
                event, crate::local_chat::LocalChatEvent::Text(text)
                    if text.text == format!("{name} connection")
            )));
            harness.close_session(name).await.unwrap();
        }
    }
}
