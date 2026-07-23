//! GUI-owned Claude session registry backed by the reusable Claude harness.

use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use async_trait::async_trait;
use tauri::Manager;
use tokio::sync::RwLock;
use vertebrae_core::{AgentConfig, PermissionMode as CorePermissionMode, Provider};
use vertebrae_harness::{HarnessFactoryConfig, HarnessRuntimeFactory, HarnessRuntimeOptions};
use vertebrae_harness_core::{
    EventSink, HarnessError, HarnessEventPayloadV1, HarnessEventV1, ProviderResumeId,
    ProviderThreadRef, RequestConfig, SendTurnRequest, SessionCloseStatus, SessionHandle,
    SessionId, StartSessionRequest, StreamId, TurnId,
};

use crate::commands::AppState;
use crate::helpers::{build_augmented_path, find_claude_binary, find_vtb_gate_binary};
use crate::local_chat::harnesses::claude::args::resolve_requested_claude_model;
use crate::local_chat::{
    HarnessCreateSessionInput, LocalChatEvent, LocalChatEventSink, LocalChatHarnessKind,
    LocalChatRuntime, LocalChatSessionError, LocalChatSessionErrorEvent,
    LocalChatSessionWarningEvent,
};
use crate::types::PermissionMode;
use vertebrae_installer::{resolve_claude_plugin_dir, ClaudePluginDirResolution};

type RuntimeFactory = dyn Fn(
        HarnessFactoryConfig,
        HarnessRuntimeOptions,
    ) -> Result<vertebrae_harness::HarnessRuntimeInstance, HarnessError>
    + Send
    + Sync
    + 'static;

const DEFAULT_CLAUDE_CONTEXT_WINDOW: u32 = 200_000;

/// GUI startup discovery shared by every Claude local-chat session.
#[derive(Debug, Clone)]
pub(crate) struct ClaudeStartupCapabilities {
    pub(crate) binary: Option<PathBuf>,
    pub(crate) binary_diagnostic: Option<String>,
    pub(crate) augmented_path: String,
    pub(crate) plugin_resolution: ClaudePluginDirResolution,
}

impl ClaudeStartupCapabilities {
    /// Resolve Claude and its managed-skill compatibility once from the Tauri
    /// setup hook. A missing executable is retained as a diagnostic without
    /// preventing the GUI from launching.
    pub(crate) fn resolve(working_dir: &Path) -> Self {
        let augmented_path = build_augmented_path();
        let (binary, binary_diagnostic) = match find_claude_binary() {
            Ok(binary) => (Some(binary), None),
            Err(error) => (None, Some(error)),
        };
        let plugin_resolution = binary.as_deref().map_or(
            ClaudePluginDirResolution {
                plugin_root: None,
                warning: None,
            },
            |binary| resolve_claude_plugin_dir(binary, working_dir, &augmented_path),
        );

        Self {
            binary,
            binary_diagnostic,
            augmented_path,
            plugin_resolution,
        }
    }

    /// Build the compatibility-free default used by unit-test adapters. The
    /// production Tauri path always uses [`Self::resolve`] during setup.
    fn without_compatibility_probe() -> Self {
        let augmented_path = build_augmented_path();
        let (binary, binary_diagnostic) = match find_claude_binary() {
            Ok(binary) => (Some(binary), None),
            Err(error) => (None, Some(error)),
        };
        Self {
            binary,
            binary_diagnostic,
            augmented_path,
            plugin_resolution: ClaudePluginDirResolution {
                plugin_root: None,
                warning: None,
            },
        }
    }
}

struct ActiveSession {
    generation: u64,
    handle: Arc<dyn SessionHandle>,
    active_turn: Arc<Mutex<Option<Arc<dyn vertebrae_harness_core::TurnHandle>>>>,
    permission_bridge: crate::local_chat::permissions::PermissionBridge,
    #[cfg(unix)]
    _permission_socket: Option<crate::local_chat::permissions::PermissionSocketGuard>,
}

/// A backend id is reserved before any asynchronous session startup. Keeping
/// the reservation and active entry under one lock prevents concurrent create
/// requests from both launching a Claude process. The monotonically increasing
/// generation also lets stale lifecycle events leave a replacement untouched.
#[derive(Default)]
struct SessionRegistry {
    active: HashMap<String, ActiveSession>,
    starting: HashMap<String, u64>,
    closing: HashMap<String, u64>,
    next_generation: u64,
}

enum TerminalSession {
    Starting,
    Active(ActiveSession),
    Closing,
}

impl SessionRegistry {
    fn reserve(&mut self, backend_session_id: &str) -> Result<u64, LocalChatSessionError> {
        if self.active.contains_key(backend_session_id)
            || self.starting.contains_key(backend_session_id)
            || self.closing.contains_key(backend_session_id)
        {
            return Err(LocalChatSessionError::SessionExists(
                backend_session_id.to_string(),
            ));
        }
        self.next_generation = self.next_generation.wrapping_add(1);
        let generation = self.next_generation;
        self.starting
            .insert(backend_session_id.to_string(), generation);
        Ok(generation)
    }

    fn release_reservation(&mut self, backend_session_id: &str, generation: u64) {
        if self.starting.get(backend_session_id) == Some(&generation) {
            self.starting.remove(backend_session_id);
        }
    }

    fn activate(
        &mut self,
        backend_session_id: String,
        generation: u64,
        session: ActiveSession,
    ) -> bool {
        if self.starting.get(&backend_session_id) != Some(&generation) {
            return false;
        }
        self.starting.remove(&backend_session_id);
        self.active.insert(backend_session_id, session);
        true
    }

    fn is_starting_generation(&self, backend_session_id: &str, generation: u64) -> bool {
        self.starting.get(backend_session_id) == Some(&generation)
    }

    fn begin_terminal_close(
        &mut self,
        backend_session_id: &str,
        generation: u64,
    ) -> Option<TerminalSession> {
        if self.starting.get(backend_session_id) == Some(&generation) {
            self.starting.remove(backend_session_id);
            self.closing
                .insert(backend_session_id.to_string(), generation);
            return Some(TerminalSession::Starting);
        }
        if let Some(session) = self.active.remove(backend_session_id) {
            if session.generation == generation {
                self.closing
                    .insert(backend_session_id.to_string(), generation);
                return Some(TerminalSession::Active(session));
            }
            self.active.insert(backend_session_id.to_string(), session);
        }
        (self.closing.get(backend_session_id) == Some(&generation))
            .then_some(TerminalSession::Closing)
    }

    fn begin_close(&mut self, backend_session_id: &str) -> Option<ActiveSession> {
        let session = self.active.remove(backend_session_id)?;
        self.closing
            .insert(backend_session_id.to_string(), session.generation);
        Some(session)
    }

    fn finish_close(&mut self, backend_session_id: &str, generation: u64) {
        if self.closing.get(backend_session_id) == Some(&generation) {
            self.closing.remove(backend_session_id);
        }
    }

    fn abandon_reservation(&mut self, backend_session_id: &str, generation: u64) {
        self.release_reservation(backend_session_id, generation);
        self.finish_close(backend_session_id, generation);
    }
}

/// Removes a startup reservation if the create future is cancelled before it
/// can either activate the session or report a normal startup error.
struct SessionReservation {
    sessions: Arc<RwLock<SessionRegistry>>,
    backend_session_id: String,
    generation: u64,
    active: bool,
}

impl SessionReservation {
    fn generation(&self) -> u64 {
        self.generation
    }

    async fn release(mut self) {
        self.sessions
            .write()
            .await
            .release_reservation(&self.backend_session_id, self.generation);
        self.active = false;
    }

    async fn abandon(mut self) {
        self.sessions
            .write()
            .await
            .abandon_reservation(&self.backend_session_id, self.generation);
        self.active = false;
    }

    fn disarm(mut self) {
        self.active = false;
    }
}

impl Drop for SessionReservation {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let sessions = self.sessions.clone();
        let backend_session_id = self.backend_session_id.clone();
        let generation = self.generation;
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                sessions
                    .write()
                    .await
                    .abandon_reservation(&backend_session_id, generation);
            });
        }
    }
}

/// Owns a successfully started handle until the registry activates it. This
/// closes and retires a process if its startup future is cancelled in the
/// narrow window before activation.
struct StartedSession {
    handle: Arc<dyn SessionHandle>,
    reservation: Option<SessionReservation>,
    #[cfg(unix)]
    permission_socket: Option<crate::local_chat::permissions::PermissionSocketGuard>,
}

impl StartedSession {
    fn handle(&self) -> Arc<dyn SessionHandle> {
        self.handle.clone()
    }

    #[cfg(unix)]
    fn take_permission_socket(
        &mut self,
    ) -> Option<crate::local_chat::permissions::PermissionSocketGuard> {
        self.permission_socket.take()
    }

    fn disarm(mut self) {
        if let Some(reservation) = self.reservation.take() {
            reservation.disarm();
        }
    }

    async fn shutdown(mut self) {
        let _ = self.handle.close().await;
        #[cfg(unix)]
        drop(self.permission_socket.take());
        if let Some(reservation) = self.reservation.take() {
            reservation.abandon().await;
        }
    }
}

impl Drop for StartedSession {
    fn drop(&mut self) {
        let Some(reservation) = self.reservation.take() else {
            return;
        };
        let sessions = reservation.sessions.clone();
        let backend_session_id = reservation.backend_session_id.clone();
        let generation = reservation.generation;
        let handle = self.handle.clone();
        #[cfg(unix)]
        let permission_socket = self.permission_socket.take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            reservation.disarm();
            runtime.spawn(async move {
                let _ = handle.close().await;
                #[cfg(unix)]
                drop(permission_socket);
                sessions
                    .write()
                    .await
                    .abandon_reservation(&backend_session_id, generation);
            });
        }
    }
}

/// Keeps an explicit close reservation alive until its active session—and
/// therefore its deterministic permission socket—has been dropped.
struct ClosingSession {
    sessions: Arc<RwLock<SessionRegistry>>,
    backend_session_id: String,
    generation: u64,
    session: Option<ActiveSession>,
}

impl ClosingSession {
    fn session(&self) -> &ActiveSession {
        self.session.as_ref().expect("closing session is present")
    }

    async fn finish(mut self) {
        drop(self.session.take());
        self.sessions
            .write()
            .await
            .finish_close(&self.backend_session_id, self.generation);
    }
}

impl Drop for ClosingSession {
    fn drop(&mut self) {
        let Some(session) = self.session.take() else {
            return;
        };
        let sessions = self.sessions.clone();
        let backend_session_id = self.backend_session_id.clone();
        let generation = self.generation;
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = session.handle.close().await;
                drop(session);
                sessions
                    .write()
                    .await
                    .finish_close(&backend_session_id, generation);
            });
        }
    }
}

#[derive(Clone)]
struct ClaudeGuiEventSink {
    backend_session_id: String,
    generation: u64,
    adapter: Arc<crate::local_chat::harnesses::shared::LocalChatHarnessEventSink>,
    sessions: Arc<RwLock<SessionRegistry>>,
    permission_bridge: crate::local_chat::permissions::PermissionBridge,
    closed: Arc<AtomicBool>,
    lifecycle_gate: Arc<tokio::sync::Mutex<()>>,
}

impl ClaudeGuiEventSink {
    fn new(
        backend_session_id: String,
        generation: u64,
        event_sink: LocalChatEventSink,
        sessions: Arc<RwLock<SessionRegistry>>,
        initial_model: Option<String>,
        permission_bridge: crate::local_chat::permissions::PermissionBridge,
        lifecycle_gate: Arc<tokio::sync::Mutex<()>>,
    ) -> Self {
        let adapter_backend_session_id = backend_session_id.clone();
        Self {
            backend_session_id,
            generation,
            adapter: Arc::new(
                crate::local_chat::harnesses::shared::LocalChatHarnessEventSink::new(
                    adapter_backend_session_id,
                    LocalChatHarnessKind::Claude,
                    event_sink,
                    initial_model,
                    DEFAULT_CLAUDE_CONTEXT_WINDOW,
                    false,
                ),
            ),
            sessions,
            permission_bridge,
            closed: Arc::new(AtomicBool::new(false)),
            lifecycle_gate,
        }
    }

    fn emit_error(&self, error: impl Into<String>) -> Result<(), HarnessError> {
        self.adapter.emit_error(error)
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
}

#[async_trait]
impl EventSink for ClaudeGuiEventSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        let HarnessEventV1 {
            event_id,
            stream_id,
            sequence,
            correlation,
            timestamp,
            semantics,
            provider_sequence,
            payload,
        } = event;
        match payload {
            HarnessEventPayloadV1::SessionClosed(outcome) => {
                let _lifecycle = self.lifecycle_gate.lock().await;
                self.closed.store(true, Ordering::Release);
                let terminal_session = self
                    .sessions
                    .write()
                    .await
                    .begin_terminal_close(&self.backend_session_id, self.generation);
                match terminal_session {
                    Some(TerminalSession::Active(session)) => {
                        // Do not release the ID or its permission socket until
                        // the matching generation's controls are denied. That
                        // prevents a same-ID replacement from being cleaned up
                        // by this terminal event while the bridge mutex waits.
                        session
                            .permission_bridge
                            .fail_pending_permissions_for_session(
                                &self.backend_session_id,
                                "Claude session ended before the permission request was resolved",
                            );
                        drop(session);
                        self.sessions
                            .write()
                            .await
                            .finish_close(&self.backend_session_id, self.generation);
                    }
                    Some(TerminalSession::Starting) => {
                        self.permission_bridge.fail_pending_permissions_for_session(
                            &self.backend_session_id,
                            "Claude session ended before the permission request was resolved",
                        );
                    }
                    Some(TerminalSession::Closing) => {}
                    None => {
                        // A previous generation can finish after a replacement
                        // has been registered. Its terminal event must not
                        // alter the replacement's registry, controls, or
                        // visible status.
                        return Ok(());
                    }
                }
                match outcome.status {
                    SessionCloseStatus::Closed => {}
                    SessionCloseStatus::ProcessLost => self.emit_error(
                        outcome
                            .error
                            .unwrap_or_else(|| "Claude session process was lost".into()),
                    )?,
                    SessionCloseStatus::Failed => self.emit_error(
                        outcome
                            .error
                            .unwrap_or_else(|| "Claude session failed while closing".into()),
                    )?,
                }
            }
            payload => {
                self.adapter
                    .emit(HarnessEventV1 {
                        event_id,
                        stream_id,
                        sequence,
                        correlation,
                        timestamp,
                        semantics,
                        provider_sequence,
                        payload,
                    })
                    .await?;
            }
        }
        Ok(())
    }
}

/// GUI adapter that owns backend-session routing and provider-neutral handles.
#[derive(Clone)]
pub(crate) struct ClaudeSessionRuntime {
    sessions: Arc<RwLock<SessionRegistry>>,
    runtime_factory: Arc<RuntimeFactory>,
    pub(crate) startup_capabilities: Arc<ClaudeStartupCapabilities>,
    #[cfg(test)]
    registry_insert_hook: Option<RegistryInsertHook>,
}

#[cfg(test)]
#[derive(Clone)]
struct RegistryInsertHook {
    reached: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

impl ClaudeSessionRuntime {
    pub(crate) fn new() -> Self {
        Self::with_startup_capabilities_and_factory(
            ClaudeStartupCapabilities::without_compatibility_probe(),
            |config, options| HarnessRuntimeFactory::new(config).create(options),
        )
    }

    pub(crate) fn with_startup_capabilities(
        startup_capabilities: ClaudeStartupCapabilities,
    ) -> Self {
        Self::with_startup_capabilities_and_factory(startup_capabilities, |config, options| {
            HarnessRuntimeFactory::new(config).create(options)
        })
    }

    pub(crate) fn startup_binary_resolution(&self) -> Result<(), String> {
        match (
            &self.startup_capabilities.binary,
            &self.startup_capabilities.binary_diagnostic,
        ) {
            (Some(_), _) => Ok(()),
            (None, Some(error)) => Err(error.clone()),
            (None, None) => Err("Claude Code CLI was not resolved at startup".into()),
        }
    }

    #[cfg(test)]
    fn with_runtime_factory(
        runtime_factory: impl Fn(
                HarnessFactoryConfig,
                HarnessRuntimeOptions,
            ) -> Result<vertebrae_harness::HarnessRuntimeInstance, HarnessError>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        Self::with_startup_capabilities_and_factory(
            ClaudeStartupCapabilities::without_compatibility_probe(),
            runtime_factory,
        )
    }

    fn with_startup_capabilities_and_factory(
        startup_capabilities: ClaudeStartupCapabilities,
        runtime_factory: impl Fn(
                HarnessFactoryConfig,
                HarnessRuntimeOptions,
            ) -> Result<vertebrae_harness::HarnessRuntimeInstance, HarnessError>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(SessionRegistry::default())),
            runtime_factory: Arc::new(runtime_factory),
            startup_capabilities: Arc::new(startup_capabilities),
            #[cfg(test)]
            registry_insert_hook: None,
        }
    }

    async fn reserve_session(
        &self,
        backend_session_id: &str,
    ) -> Result<SessionReservation, LocalChatSessionError> {
        let generation = self.sessions.write().await.reserve(backend_session_id)?;
        Ok(SessionReservation {
            sessions: self.sessions.clone(),
            backend_session_id: backend_session_id.to_string(),
            generation,
            active: true,
        })
    }

    pub(crate) async fn create_session(
        &self,
        input: HarnessCreateSessionInput,
        runtime: LocalChatRuntime,
    ) -> Result<(), LocalChatSessionError> {
        let backend_session_id = input.backend_session_id.clone();
        let reservation = self.reserve_session(&backend_session_id).await?;

        let prepared = match PreparedSession::new(&input, &runtime, &self.startup_capabilities) {
            Ok(prepared) => prepared,
            Err(error) => {
                reservation.release().await;
                emit_start_error(
                    &runtime.event_sink(),
                    &backend_session_id,
                    error.to_string(),
                );
                return Err(error);
            }
        };
        self.create_reserved_prepared_session(input, runtime, prepared, reservation)
            .await
    }

    #[cfg(test)]
    async fn create_prepared_session(
        &self,
        input: HarnessCreateSessionInput,
        runtime: LocalChatRuntime,
        prepared: PreparedSession,
    ) -> Result<(), LocalChatSessionError> {
        let backend_session_id = input.backend_session_id.clone();
        let reservation = self.reserve_session(&backend_session_id).await?;
        self.create_reserved_prepared_session(input, runtime, prepared, reservation)
            .await
    }

    async fn create_reserved_prepared_session(
        &self,
        input: HarnessCreateSessionInput,
        runtime: LocalChatRuntime,
        prepared: PreparedSession,
        reservation: SessionReservation,
    ) -> Result<(), LocalChatSessionError> {
        let backend_session_id = input.backend_session_id.clone();
        let generation = reservation.generation();
        let PreparedSession {
            working_dir,
            model,
            model_warning,
            factory_config,
            plugin_resolution,
            #[cfg(unix)]
            permission_socket,
        } = prepared;
        #[cfg(unix)]
        let mut permission_socket = permission_socket;
        if let Some(warning) = &model_warning {
            emit_warning(&runtime.event_sink(), &backend_session_id, warning.clone());
        }
        report_plugin_dir_resolution(
            &runtime.event_sink(),
            &backend_session_id,
            &plugin_resolution,
        );

        let lifecycle_gate = Arc::new(tokio::sync::Mutex::new(()));
        let event_sink = Arc::new(ClaudeGuiEventSink::new(
            backend_session_id.clone(),
            generation,
            runtime.event_sink(),
            self.sessions.clone(),
            model.clone(),
            runtime.permission_bridge(),
            lifecycle_gate.clone(),
        ));
        let control_sink = Arc::new(
            crate::local_chat::harnesses::shared::LocalChatControlSink::new(
                backend_session_id.clone(),
                runtime.clone(),
            ),
        );
        let agent_config = AgentConfig {
            provider: Some(Provider::Anthropic),
            model: model.clone(),
            permission_mode: input.permission_mode.as_ref().map(core_permission_mode),
            ..AgentConfig::default()
        };
        let mut request = StartSessionRequest {
            session_id: SessionId::new(backend_session_id.clone()),
            stream_id: StreamId::new(format!("local-chat:{backend_session_id}")),
            resume_id: input.provider_resume_id.clone().map(ProviderResumeId::new),
            config: RequestConfig {
                working_directory: Some(working_dir),
                model,
                reasoning_effort: input.reasoning_effort,
                ..RequestConfig::default()
            },
        };
        let instance = match (self.runtime_factory)(
            factory_config,
            HarnessRuntimeOptions {
                agent_config,
                request_config: request.config.clone(),
            },
        ) {
            Ok(harness) => harness,
            Err(error) => {
                #[cfg(unix)]
                drop(permission_socket.take());
                reservation.abandon().await;
                let _ = event_sink.emit_error(error.to_string());
                return Err(start_error(error));
            }
        };
        request.config = instance.request_config;
        let handle = match instance
            .runtime
            .start_session(request, event_sink.clone(), control_sink)
            .await
        {
            Ok(handle) => handle,
            Err(error) => {
                #[cfg(unix)]
                drop(permission_socket.take());
                reservation.abandon().await;
                let _ = event_sink.emit_error(error.to_string());
                return Err(start_error(error));
            }
        };
        let mut started = StartedSession {
            handle,
            reservation: Some(reservation),
            #[cfg(unix)]
            permission_socket: permission_socket.take(),
        };

        let _lifecycle = lifecycle_gate.lock().await;
        if event_sink.is_closed() {
            drop(_lifecycle);
            started.shutdown().await;
            return Err(LocalChatSessionError::StartFailed(
                "Claude session ended during initialization".into(),
            ));
        }

        let active_turn = Arc::new(Mutex::new(None));
        #[cfg(test)]
        if let Some(hook) = &self.registry_insert_hook {
            hook.reached.notify_one();
            hook.release.notified().await;
        }
        if !self
            .sessions
            .read()
            .await
            .is_starting_generation(&backend_session_id, generation)
        {
            drop(_lifecycle);
            started.shutdown().await;
            return Err(LocalChatSessionError::StartFailed(
                "Claude session reservation ended during initialization".into(),
            ));
        }
        let handle = started.handle();
        let activated = self.sessions.write().await.activate(
            backend_session_id.clone(),
            generation,
            ActiveSession {
                generation,
                handle: handle.clone(),
                active_turn: active_turn.clone(),
                permission_bridge: runtime.permission_bridge(),
                #[cfg(unix)]
                _permission_socket: started.take_permission_socket(),
            },
        );
        debug_assert!(activated, "checked the startup reservation while gated");
        started.disarm();
        drop(_lifecycle);

        if let Some(prompt) = input
            .initial_prompt
            .filter(|prompt| !prompt.trim().is_empty())
        {
            if let Err(error) = send_turn(&handle, &active_turn, prompt).await {
                let closing_session = self.sessions.write().await.begin_close(&backend_session_id);
                if let Some(session) = closing_session {
                    let closing_session = ClosingSession {
                        sessions: self.sessions.clone(),
                        backend_session_id: backend_session_id.clone(),
                        generation: session.generation,
                        session: Some(session),
                    };
                    closing_session
                        .session()
                        .permission_bridge
                        .fail_pending_permissions_for_session(
                            &backend_session_id,
                            "Claude session ended before the permission request was resolved",
                        );
                    let _ = closing_session.session().handle.close().await;
                    closing_session.finish().await;
                } else {
                    let _ = handle.close().await;
                }
                let _ = event_sink.emit_error(error.to_string());
                return Err(send_error(error));
            }
        }

        log::info!("Claude harness session {} created", backend_session_id);
        Ok(())
    }

    pub(crate) async fn send_message(
        &self,
        session_id: &str,
        content: &str,
    ) -> Result<(), LocalChatSessionError> {
        let (handle, active_turn) = self
            .sessions
            .read()
            .await
            .active
            .get(session_id)
            .map(|session| (session.handle.clone(), session.active_turn.clone()))
            .ok_or_else(|| LocalChatSessionError::SessionNotFound(session_id.to_string()))?;
        send_turn(&handle, &active_turn, content.to_string())
            .await
            .map_err(send_error)
    }

    pub(crate) async fn close_session(
        &self,
        session_id: &str,
    ) -> Result<(), LocalChatSessionError> {
        let session = self
            .sessions
            .write()
            .await
            .begin_close(session_id)
            .ok_or_else(|| LocalChatSessionError::SessionNotFound(session_id.to_string()))?;
        let closing_session = ClosingSession {
            sessions: self.sessions.clone(),
            backend_session_id: session_id.to_string(),
            generation: session.generation,
            session: Some(session),
        };
        // Closing the GUI handle also cancels any permission dialog that was
        // waiting on either the legacy vtb-gate transport or a harness control.
        // The harness emits SessionClosed too, so this operation is idempotent.
        //
        // Keep the socket guard alive until `close` finishes by retaining
        // `closing_session` for the duration of the await. Its drop guard
        // releases the reservation if this future is cancelled midway.
        closing_session
            .session()
            .permission_bridge
            .fail_pending_permissions_for_session(
                session_id,
                "Claude session ended before the permission request was resolved",
            );
        let active_turn = closing_session
            .session()
            .active_turn
            .lock()
            .map_err(|_| LocalChatSessionError::SendFailed("Claude turn state is poisoned".into()))?
            .take();
        let interrupt_error = if let Some(turn) = active_turn {
            turn.interrupt().await.err()
        } else {
            None
        };
        let close_result = closing_session.session().handle.close().await;
        let result = match (interrupt_error, close_result) {
            (_, Ok(_)) => Ok(()),
            (None, Err(error)) => Err(LocalChatSessionError::SendFailed(error.to_string())),
            (Some(interrupt), Err(close)) => Err(LocalChatSessionError::SendFailed(format!(
                "failed to interrupt active Claude turn: {interrupt}; failed to close Claude session: {close}"
            ))),
        };
        closing_session.finish().await;
        result
    }

    pub(crate) async fn has_session(&self, session_id: &str) -> bool {
        self.sessions.read().await.active.contains_key(session_id)
    }
}

impl Default for ClaudeSessionRuntime {
    fn default() -> Self {
        Self::new()
    }
}

struct PreparedSession {
    working_dir: PathBuf,
    model: Option<String>,
    model_warning: Option<String>,
    factory_config: HarnessFactoryConfig,
    plugin_resolution: ClaudePluginDirResolution,
    #[cfg(unix)]
    permission_socket: Option<crate::local_chat::permissions::PermissionSocketGuard>,
}

impl PreparedSession {
    fn new(
        input: &HarnessCreateSessionInput,
        runtime: &LocalChatRuntime,
        startup_capabilities: &ClaudeStartupCapabilities,
    ) -> Result<Self, LocalChatSessionError> {
        let app_handle = runtime.app_handle().ok_or_else(|| {
            LocalChatSessionError::SpawnFailed(
                "Tauri app handle is required to start a Claude session".into(),
            )
        })?;
        let working_dir = resolve_working_dir(input.working_dir.clone(), &app_handle)
            .map(PathBuf::from)
            .ok_or_else(|| {
                LocalChatSessionError::StartFailed(
                    "Cannot start Claude session without a selected project path".into(),
                )
            })?;
        if !working_dir.is_dir() {
            return Err(LocalChatSessionError::StartFailed(format!(
                "Working directory does not exist or is not a directory: {}",
                working_dir.display()
            )));
        }

        let claude_binary = startup_capabilities.binary.clone().ok_or_else(|| {
            LocalChatSessionError::SpawnFailed(
                startup_capabilities
                    .binary_diagnostic
                    .clone()
                    .unwrap_or_else(|| "Claude Code CLI was not resolved at startup".into()),
            )
        })?;
        let augmented_path = startup_capabilities.augmented_path.clone();
        let plugin_resolution = startup_capabilities.plugin_resolution.clone();
        let gate = find_vtb_gate_binary().map_err(LocalChatSessionError::StartFailed)?;
        #[cfg(unix)]
        let permission_socket = runtime
            .permission_bridge()
            .start_socket(&input.backend_session_id, app_handle)
            .map_err(LocalChatSessionError::StartFailed)?;

        let resolved_model = resolve_requested_claude_model(
            input.model_id.clone(),
            input.provider_resume_id.is_some(),
        );
        let root_locator_dir = claude_project_directory(&working_dir);
        let factory_config = build_factory_config(
            claude_binary,
            &augmented_path,
            &plugin_resolution,
            gate,
            &input.backend_session_id,
            root_locator_dir,
            #[cfg(unix)]
            Some(permission_socket.path()),
            #[cfg(not(unix))]
            None,
        );

        Ok(Self {
            working_dir,
            model: resolved_model.model_id,
            model_warning: resolved_model.warning,
            factory_config,
            plugin_resolution,
            #[cfg(unix)]
            permission_socket: Some(permission_socket),
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn build_factory_config(
    claude_binary: PathBuf,
    augmented_path: &str,
    plugin_resolution: &ClaudePluginDirResolution,
    gate: PathBuf,
    backend_session_id: &str,
    root_locator_dir: PathBuf,
    permission_socket: Option<&Path>,
) -> HarnessFactoryConfig {
    let mut environment = BTreeMap::from([(
        "VTB_CLAUDE_SESSION_ID".to_string(),
        backend_session_id.to_string(),
    )]);
    if let Some(permission_socket) = permission_socket {
        environment.insert(
            "VTB_GATE_SOCKET".to_string(),
            permission_socket.to_string_lossy().into_owned(),
        );
    }
    HarnessFactoryConfig {
        anthropic_executable: Some(claude_binary),
        provider_resolution_cached: true,
        search_path: Some(augmented_path.into()),
        environment,
        claude_plugin_roots: plugin_resolution.plugin_root.clone().into_iter().collect(),
        claude_permission_prompt_tool: Some("mcp__vtb-gate__permission_prompt".into()),
        claude_mcp_config: Some(serde_json::json!({
            "mcpServers": { "vtb-gate": { "command": gate } }
        })),
        claude_root_locator_resolver: Some(Arc::new(move |session_id: &SessionId| {
            Ok(Some(ProviderThreadRef::new(
                root_locator_dir
                    .join(format!("{}.jsonl", session_id.as_str()))
                    .to_string_lossy()
                    .into_owned(),
            )))
        })),
        ..HarnessFactoryConfig::default()
    }
}

async fn send_turn(
    handle: &Arc<dyn SessionHandle>,
    active_turn: &Arc<Mutex<Option<Arc<dyn vertebrae_harness_core::TurnHandle>>>>,
    content: String,
) -> Result<(), HarnessError> {
    let turn = handle
        .send(SendTurnRequest {
            turn_id: TurnId::new(uuid::Uuid::new_v4().to_string()),
            content,
            output_schema: None,
        })
        .await?;
    active_turn
        .lock()
        .map_err(|_| HarnessError::Operation("Claude turn state is poisoned".into()))?
        .replace(turn.clone());
    let active_turn = active_turn.clone();
    let turn_id = turn.turn_id().clone();
    tokio::spawn(async move {
        if let Err(error) = turn.await_outcome().await {
            log::warn!("Claude harness turn ended without an outcome: {}", error);
        }
        if let Ok(mut active) = active_turn.lock() {
            if active
                .as_ref()
                .is_some_and(|candidate| candidate.turn_id() == &turn_id)
            {
                active.take();
            }
        }
    });
    Ok(())
}

fn start_error(error: HarnessError) -> LocalChatSessionError {
    match error {
        HarnessError::Unavailable(message) => LocalChatSessionError::SpawnFailed(message),
        error => LocalChatSessionError::StartFailed(error.to_string()),
    }
}

fn send_error(error: HarnessError) -> LocalChatSessionError {
    LocalChatSessionError::SendFailed(error.to_string())
}

fn core_permission_mode(mode: &PermissionMode) -> CorePermissionMode {
    match mode {
        PermissionMode::AcceptEdits => CorePermissionMode::AcceptEdits,
        PermissionMode::Auto => CorePermissionMode::Auto,
        PermissionMode::BypassPermissions => CorePermissionMode::BypassPermissions,
        PermissionMode::Default => CorePermissionMode::Default,
        PermissionMode::DontAsk => CorePermissionMode::DontAsk,
        PermissionMode::Plan => CorePermissionMode::Plan,
    }
}

fn current_project_path<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) -> Option<String> {
    let state = app_handle.try_state::<AppState>()?;
    let slug = state.project_config.get_current_project()?;
    match vertebrae_sacrum_client::load_config_file() {
        Ok(config) => config
            .projects
            .get(&slug)
            .map(|project| project.path.clone()),
        Err(error) => {
            log::warn!(
                "Failed to load config while resolving current project path: {}",
                error
            );
            None
        }
    }
}

fn resolve_working_dir<R: tauri::Runtime>(
    working_dir: Option<String>,
    app_handle: &tauri::AppHandle<R>,
) -> Option<String> {
    working_dir
        .filter(|dir| !dir.trim().is_empty())
        .or_else(|| current_project_path(app_handle))
        .filter(|dir| !dir.trim().is_empty())
}

fn claude_project_directory(working_dir: &Path) -> PathBuf {
    let encoded = working_dir
        .to_string_lossy()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    dirs::home_dir()
        .unwrap_or_default()
        .join(".claude")
        .join("projects")
        .join(encoded)
}

fn report_plugin_dir_resolution(
    event_sink: &LocalChatEventSink,
    session_id: &str,
    resolution: &ClaudePluginDirResolution,
) {
    if let Some(warning) = &resolution.warning {
        log::warn!("{}", warning);
        emit_warning(event_sink, session_id, warning.clone());
    } else if let Some(plugin_root) = &resolution.plugin_root {
        log::info!(
            "Loading Vertebrae-installed Claude skills from plugin root: {}",
            plugin_root.display()
        );
    }
}

fn emit_start_error(event_sink: &LocalChatEventSink, session_id: &str, error: String) {
    event_sink.emit(LocalChatEvent::Error(LocalChatSessionErrorEvent {
        backend_session_id: session_id.to_string(),
        harness: LocalChatHarnessKind::Claude,
        error,
    }));
}

fn emit_warning(event_sink: &LocalChatEventSink, session_id: &str, warning: String) {
    event_sink.emit(LocalChatEvent::Warning(LocalChatSessionWarningEvent {
        backend_session_id: session_id.to_string(),
        harness: LocalChatHarnessKind::Claude,
        warning,
    }));
}

#[cfg(test)]
mod tests;
