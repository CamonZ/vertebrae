//! Daemon-wide admission and settlement for Rhai execute evaluations.
//!
//! Every admitted attempt owns its queue permit and cancellation signal. The
//! active permit stays inside the blocking closure, including panic unwinding;
//! cancelling the async waiter never releases a still-running evaluation.
//!
//! Host functions run on that blocking worker thread. Each one blocks the
//! thread on a single async service call through [`HostContext::call`], which
//! races only the attempt's cancellation. Nothing else bounds a script: there
//! is no deadline, operation limit, or size cap. Rhai's default expression and
//! call depth guards stay because a stack overflow aborts the whole daemon.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use rhai::{Dynamic, Engine, EvalAltResult, Position, Scope};
use tokio::runtime::Handle;
use tokio::sync::{Semaphore, watch};
use vertebrae_core::models::ExecuteConfig;
use vertebrae_core::{ServiceError, ServiceResult, VertebraeServices};

use crate::actors::step_executor::{StepResult, step_result_for_schema_error};
use crate::config::ScriptSlots;
use crate::output_validator::{CompiledSchema, SchemaError};

pub const SCRIPT_CONTEXT_NAMESPACES: [&str; 6] = [
    "task",
    "execution",
    "inputs",
    "steps",
    "workflow",
    "artifacts",
];

/// Registers host modules on each attempt's fresh engine.
pub type HostApi = Arc<dyn Fn(&mut Engine, &HostContext) + Send + Sync>;

pub struct ScriptWorker {
    admitted: Arc<Semaphore>,
    active: Arc<Semaphore>,
    slots: ScriptSlots,
    host_api: HostApi,
}

impl std::fmt::Debug for ScriptWorker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScriptWorker")
            .field("slots", &self.slots)
            .field("active_available", &self.active.available_permits())
            .field("admitted_available", &self.admitted.available_permits())
            .finish()
    }
}

impl Default for ScriptWorker {
    fn default() -> Self {
        Self::new(ScriptSlots::default())
    }
}

/// The execution's project and its project-scoped services. Scripts never
/// see or pass a project ID; every host call receives this one.
#[derive(Clone)]
pub struct ScriptScope {
    pub project_id: String,
    pub services: Arc<VertebraeServices>,
}

/// What a host function needs to make a cancellable service call from the
/// script's blocking worker thread.
#[derive(Clone)]
pub struct HostContext {
    runtime: Handle,
    cancellation: watch::Receiver<bool>,
    scope: ScriptScope,
}

impl HostContext {
    pub fn project_id(&self) -> &str {
        &self.scope.project_id
    }

    /// Block the worker thread on one direct service call. The call races
    /// only the attempt's cancellation; on cancel the request future is
    /// dropped, so a hung request cannot hold the thread or its slot.
    ///
    /// Must only run on the script's blocking worker thread; Tokio panics if
    /// this is reached from async code.
    pub fn call<'a, T, F>(
        &'a self,
        request: impl FnOnce(&'a VertebraeServices, &'a str) -> F,
    ) -> Result<T, HostError>
    where
        F: Future<Output = ServiceResult<T>>,
    {
        let mut cancellation = self.cancellation.clone();
        let request = request(&self.scope.services, &self.scope.project_id);
        self.runtime.block_on(async move {
            tokio::select! {
                biased;
                () = cancelled(&mut cancellation) => Err(HostError::cancelled()),
                result = request => result.map_err(HostError::from),
            }
        })
    }
}

/// Resolve on an explicit cancel. A dropped sender is not a cancel.
async fn cancelled(cancellation: &mut watch::Receiver<bool>) {
    if cancellation.wait_for(|cancelled| *cancelled).await.is_err() {
        std::future::pending::<()>().await;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostErrorKind {
    NotFound,
    Invalid,
    Cancelled,
    Transport,
}

impl HostErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::Invalid => "invalid",
            Self::Cancelled => "cancelled",
            Self::Transport => "transport",
        }
    }
}

/// A failed host call. Raised into Rhai as `#{ kind, message, function }`
/// so scripts can `try`/`catch` and branch on `err.kind`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostError {
    pub kind: HostErrorKind,
    pub message: String,
    pub function: Option<String>,
}

impl HostError {
    pub fn new(kind: HostErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            function: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(HostErrorKind::Invalid, message)
    }

    /// Name the qualified host function that raised this error.
    pub fn in_function(mut self, function: impl Into<String>) -> Self {
        self.function = Some(function.into());
        self
    }

    fn cancelled() -> Self {
        Self::new(HostErrorKind::Cancelled, "Cancelled")
    }
}

impl From<ServiceError> for HostError {
    fn from(error: ServiceError) -> Self {
        let kind = match &error {
            ServiceError::TaskNotFound { .. }
            | ServiceError::WorkflowNotFound { .. }
            | ServiceError::ArtifactNotFound { .. }
            | ServiceError::ParentNotFound { .. }
            | ServiceError::DependencyNotFound { .. } => HostErrorKind::NotFound,
            ServiceError::InvalidTransition { .. }
            | ServiceError::TaskBlocked { .. }
            | ServiceError::ValidationFailed { .. }
            | ServiceError::CyclicDependency
            | ServiceError::InvalidInput(_) => HostErrorKind::Invalid,
            ServiceError::ApiError { .. }
            | ServiceError::NetworkError(_)
            | ServiceError::ConfigError(_) => HostErrorKind::Transport,
        };
        Self::new(kind, error.to_string())
    }
}

impl From<HostError> for Box<EvalAltResult> {
    fn from(error: HostError) -> Self {
        let mut value = rhai::Map::new();
        value.insert("kind".into(), error.kind.as_str().into());
        value.insert("message".into(), error.message.into());
        if let Some(function) = error.function {
            value.insert("function".into(), function.into());
        }
        EvalAltResult::ErrorRuntime(value.into(), Position::NONE).into()
    }
}

/// Production host modules, registered on every attempt's engine.
fn register_host_api(engine: &mut Engine, host: &HostContext) {
    crate::script_host::register(engine, host);
}

pub struct ScriptAttempt {
    cancellation: Arc<AtomicBool>,
    cancel_tx: watch::Sender<bool>,
    settlement: tokio::task::JoinHandle<StepResult>,
}

/// Coordinates the ordinary parent terminal path with actor shutdown. A result
/// is recorded before messaging the parent so shutdown can drain it even when
/// that message was queued behind the parent's stop signal.
#[derive(Default)]
pub struct ScriptCompletion {
    result: std::sync::Mutex<Option<StepResult>>,
    claimed: AtomicBool,
}

impl ScriptCompletion {
    pub fn record(&self, result: StepResult) {
        // The slot holds only owned result primitives. Its assignment has no
        // user callbacks or fallible partial mutation; poison leaves a valid
        // previous/new Option, which shutdown may safely inspect.
        *self
            .result
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(result);
    }

    pub fn result(&self) -> Option<StepResult> {
        self.result
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn claim_persistence(&self) -> bool {
        // This atomic only arbitrates one request; result publication uses
        // the mutex above, independently of this relaxed ownership flag.
        !self.claimed.swap(true, Ordering::Relaxed)
    }
}

impl ScriptAttempt {
    pub fn cancel(&self) {
        self.cancellation.store(true, Ordering::Relaxed);
        self.cancel_tx.send_replace(true);
    }

    pub async fn settle(self) -> StepResult {
        self.settlement.await.unwrap_or_else(|error| {
            StepResult::failed(None, format!("Rhai worker failed: {error}"))
        })
    }
}

impl ScriptWorker {
    pub fn new(slots: ScriptSlots) -> Self {
        Self::with_host_api(slots, Arc::new(register_host_api))
    }

    pub fn with_host_api(slots: ScriptSlots, host_api: HostApi) -> Self {
        Self {
            admitted: Arc::new(Semaphore::new(
                slots
                    .active
                    .saturating_add(slots.pending)
                    .min(Semaphore::MAX_PERMITS),
            )),
            active: Arc::new(Semaphore::new(slots.active.min(Semaphore::MAX_PERMITS))),
            slots,
            host_api,
        }
    }

    /// Reject overflow synchronously before allocating a waiter or blocking job.
    /// The settlement callback is invoked only after the worker has been joined.
    pub fn admit(
        &self,
        config: ExecuteConfig,
        scope: ScriptScope,
        settled: impl FnOnce(StepResult) + Send + 'static,
    ) -> Result<ScriptAttempt, String> {
        let host_api = Arc::clone(&self.host_api);
        self.admit_with(config, scope, settled, move |config, cancellation, host| {
            evaluate_with(
                config,
                cancellation,
                |engine| host_api(engine, &host),
                CompiledSchema::compile,
                || {},
            )
        })
    }

    fn admit_with(
        &self,
        config: ExecuteConfig,
        scope: ScriptScope,
        settled: impl FnOnce(StepResult) + Send + 'static,
        evaluation: impl FnOnce(ExecuteConfig, Arc<AtomicBool>, HostContext) -> StepResult
        + Send
        + 'static,
    ) -> Result<ScriptAttempt, String> {
        let admitted = Arc::clone(&self.admitted)
            .try_acquire_owned()
            .map_err(|_| {
                format!(
                    "Rhai execution capacity exceeded ({} active, {} pending)",
                    self.slots.active, self.slots.pending
                )
            })?;
        validate_context(&config)?;
        config
            .validate_structure()
            .map_err(|error| error.to_string())?;
        let active = Arc::clone(&self.active);
        // Reserve an idle active slot immediately, so simultaneous admissions
        // allocate at most the configured pending waiters before any task polls.
        let immediate = Arc::clone(&active).try_acquire_owned().ok();
        let cancellation = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancellation);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let settlement = tokio::spawn(async move {
            let mut queue_cancel = cancel_rx.clone();
            let acquisition = if *queue_cancel.borrow() {
                Err("Cancelled".to_string())
            } else if let Some(permit) = immediate {
                Ok(permit)
            } else {
                tokio::select! {
                    biased;
                    _ = queue_cancel.changed() => Err("Cancelled".to_string()),
                    permit = active.acquire_owned() => permit.map_err(|_| "Rhai worker closed".to_string()),
                }
            };
            let result = match acquisition {
                Err(error) => StepResult::failed(None, error),
                Ok(permit) => {
                    let host = HostContext {
                        runtime: Handle::current(),
                        cancellation: cancel_rx,
                        scope,
                    };
                    // No timeout/abort races this join: the closure cooperates
                    // with its cancellation flag, and host calls race the same
                    // signal, so the permit is released only once both settle.
                    match tokio::task::spawn_blocking(move || {
                        let _permit = permit;
                        evaluation(config, worker_cancel, host)
                    })
                    .await
                    {
                        Ok(result) => result,
                        Err(error) => {
                            StepResult::failed(None, format!("Rhai worker panicked: {error}"))
                        }
                    }
                }
            };
            drop(admitted);
            settled(result.clone());
            result
        });
        Ok(ScriptAttempt {
            cancellation,
            cancel_tx,
            settlement,
        })
    }
}

pub(crate) fn validate_context(config: &ExecuteConfig) -> Result<(), String> {
    let context = runtime_context(config)?;
    for namespace in SCRIPT_CONTEXT_NAMESPACES {
        if !context
            .get(namespace)
            .is_some_and(serde_json::Value::is_object)
        {
            return Err(format!("execute context.{namespace} must be a JSON object"));
        }
    }
    Ok(())
}

fn runtime_context(
    config: &ExecuteConfig,
) -> Result<&serde_json::Map<String, serde_json::Value>, String> {
    config
        .context
        .as_ref()
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "execute requires a resolved context JSON object".into())
}

fn evaluate_with(
    config: ExecuteConfig,
    cancellation: Arc<AtomicBool>,
    register_host: impl FnOnce(&mut Engine),
    compile_schema: impl FnOnce(&serde_json::Value) -> Result<CompiledSchema, SchemaError>,
    progress: impl Fn() + 'static,
) -> StepResult {
    let check_interruption = || cancellation.load(Ordering::Relaxed).then_some("Cancelled");
    if let Some(error) = check_interruption() {
        return StepResult::failed(None, error);
    }
    // Schema compilation shares the worker's permit. It cannot be
    // interrupted by Rhai callbacks, so observe cancellation after it joins.
    let schema = compile_schema(&config.output_schema);
    if let Some(error) = check_interruption() {
        return StepResult::failed(None, error);
    }
    let schema = match schema {
        Ok(schema) => schema,
        Err(error) => return step_result_for_schema_error(error),
    };
    let mut engine = Engine::new();
    engine
        .set_module_resolver(rhai::module_resolvers::DummyModuleResolver::new())
        .set_fail_on_invalid_map_property(true)
        .disable_symbol("eval")
        .disable_symbol("import")
        .on_print(|_| {})
        .on_debug(|_, _, _| {});
    let progress_cancel = Arc::clone(&cancellation);
    engine.on_progress(move |_| {
        progress();
        progress_cancel
            .load(Ordering::Relaxed)
            .then(|| "Cancelled".into())
    });
    register_host(&mut engine);
    let context = match runtime_context(&config) {
        Ok(context) => context,
        Err(error) => return StepResult::failed(None, error),
    };
    let mut scope = Scope::new();
    // Bind the server's canonical namespaces as typed values. Context strings
    // are data; no rendering, source interpolation, or mutable server lookup.
    for namespace in SCRIPT_CONTEXT_NAMESPACES {
        let Some(value) = context.get(namespace) else {
            return StepResult::failed(None, format!("execute context.{namespace} is missing"));
        };
        let value = match json_to_rhai(value, &format!("/context/{namespace}")) {
            Ok(value) => value,
            Err(error) => {
                return StepResult::failed(
                    None,
                    format!("Invalid Rhai context.{namespace}: {error}"),
                );
            }
        };
        scope.push_dynamic(namespace, value);
    }
    if let Some(error) = check_interruption() {
        return StepResult::failed(None, error);
    }
    let result = match engine.eval_with_scope::<Dynamic>(&mut scope, &config.script) {
        Ok(result) => result,
        Err(error) => {
            return StepResult::failed(
                None,
                check_interruption()
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("Rhai execution failed: {error}")),
            );
        }
    };
    if let Some(error) = check_interruption() {
        return StepResult::failed(None, error);
    }
    if let Err(error) = validate_json_result(&result) {
        return StepResult::failed(None, error);
    }
    let output = match rhai::serde::from_dynamic::<serde_json::Value>(&result) {
        Ok(output) => output,
        Err(error) => return StepResult::failed(None, format!("Rhai result is not JSON: {error}")),
    };
    if let Err(error) = schema.validate_output(Some(&output), None) {
        return step_result_for_schema_error(error);
    }
    if let Some(error) = check_interruption() {
        return StepResult::failed(None, error);
    }
    StepResult::Completed {
        exit_code: 0,
        metrics: None,
        output: Some(output.to_string()),
    }
}

/// Convert the context without serde's unsigned-to-float
/// fallback. Rhai integers are signed 64-bit; reject larger JSON integers
/// with their JSON pointer rather than persisting a rounded successful result.
pub(crate) fn json_to_rhai(value: &serde_json::Value, path: &str) -> Result<Dynamic, String> {
    use serde_json::Value;

    Ok(match value {
        Value::Null => Dynamic::UNIT,
        Value::Bool(value) => Dynamic::from_bool(*value),
        Value::Number(value) if value.is_f64() => {
            Dynamic::from_float(value.as_f64().expect("JSON float"))
        }
        Value::Number(value) => Dynamic::from_int(value.as_i64().ok_or_else(|| {
            format!("{path}: integer {value} is outside Rhai's signed 64-bit integer range")
        })?),
        Value::String(value) => Dynamic::from(value.clone()),
        Value::Array(values) => Dynamic::from_array(
            values
                .iter()
                .enumerate()
                .map(|(index, value)| json_to_rhai(value, &format!("{path}/{index}")))
                .collect::<Result<rhai::Array, _>>()?,
        ),
        Value::Object(values) => Dynamic::from_map(
            values
                .iter()
                .map(|(key, value)| {
                    let pointer = key.replace('~', "~0").replace('/', "~1");
                    json_to_rhai(value, &format!("{path}/{pointer}"))
                        .map(|value| (key.clone().into(), value))
                })
                .collect::<Result<rhai::Map, _>>()?,
        ),
    })
}

/// Reject values serde would otherwise coerce or refuse, such as functions,
/// custom types, and non-finite floats, before the result is persisted.
fn validate_json_result(value: &Dynamic) -> Result<(), String> {
    if value.is_unit()
        || value.is::<bool>()
        || value.is::<rhai::INT>()
        || value.is::<rhai::ImmutableString>()
    {
        return Ok(());
    }
    if value.is::<rhai::FLOAT>() {
        return if value.as_float().map_err(str::to_string)?.is_finite() {
            Ok(())
        } else {
            Err("Rhai result contains a non-finite JSON number".into())
        };
    }
    if value.is::<rhai::Array>() {
        let items = value.as_array_ref().map_err(str::to_string)?;
        return items.iter().try_for_each(validate_json_result);
    }
    if value.is::<rhai::Map>() {
        let fields = value.as_map_ref().map_err(str::to_string)?;
        return fields.values().try_for_each(validate_json_result);
    }
    Err(format!(
        "Rhai result type '{}' is not JSON",
        value.type_name()
    ))
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// Services pointed at an unroutable endpoint; tests that use it must not
    /// make real service calls.
    pub(crate) fn scope() -> ScriptScope {
        use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};
        ScriptScope {
            project_id: "script-project".into(),
            services: Arc::new(vertebrae_sacrum_client::from_sacrum(Arc::new(
                GraphqlClient::new(SacrumConfig::new(
                    "http://127.0.0.1:9".into(),
                    "token".into(),
                    "script-project".into(),
                )),
            ))),
        }
    }

    /// Registers `test::hang()`, a host call whose service request never
    /// completes, so only cancellation can end it.
    pub(crate) fn hanging_host_api() -> HostApi {
        Arc::new(|engine, host| {
            let host = host.clone();
            let mut module = rhai::Module::new();
            module.set_native_fn("hang", move || {
                Ok(host.call(|_, _| std::future::pending::<ServiceResult<rhai::INT>>())?)
            });
            engine.register_static_module("test", module.into());
        })
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{hanging_host_api, scope};
    use super::*;
    use serde_json::json;
    use std::time::Duration;
    use tokio::sync::{Notify, oneshot};

    const PENDING: usize = 4;

    fn config(script: &str, input: serde_json::Value) -> ExecuteConfig {
        ExecuteConfig {
            version: 1,
            script: script.into(),
            context: Some(
                json!({"task":{},"execution":{},"inputs":{"value":input},"steps":{},"workflow":{},"artifacts":{}}),
            ),
            output_schema: json!({}),
        }
    }

    fn output(result: StepResult) -> serde_json::Value {
        match result {
            StepResult::Completed {
                output: Some(output),
                metrics,
                ..
            } => {
                assert_eq!(metrics, None, "execute never fabricates provider metrics");
                serde_json::from_str(&output).unwrap()
            }
            other => panic!("expected completion, got {other:?}"),
        }
    }

    fn failure(result: StepResult) -> String {
        match result {
            StepResult::Failed { error, .. } => error,
            other => panic!("expected failure, got {other:?}"),
        }
    }

    async fn run(worker: &ScriptWorker, config: ExecuteConfig) -> StepResult {
        worker
            .admit(config, scope(), |_| {})
            .unwrap()
            .settle()
            .await
    }

    #[tokio::test]
    async fn transforms_typed_input_and_preserves_nested_json() {
        let worker = ScriptWorker::default();
        let mut transform = config(
            "#{ name: inputs.value.name, total: inputs.value.quantity * inputs.value.unit_price }",
            json!({"name":"example","quantity":3,"unit_price":12}),
        );
        transform.output_schema = json!({"type":"object","properties":{"name":{"type":"string"},"total":{"type":"number"}},"required":["name","total"],"additionalProperties":false});
        assert_eq!(
            output(run(&worker, transform.clone()).await),
            json!({"name":"example","total":36})
        );
        transform.context.as_mut().unwrap()["inputs"]["value"]["quantity"] = json!(4);
        assert_eq!(
            output(run(&worker, transform).await),
            json!({"name":"example","total":48})
        );
        let input = json!({"nested":[null,true,false,7,1.25,{"text":"quotes \" and newline\n and slash \\"}]});
        assert_eq!(
            output(run(&worker, config("inputs.value", input.clone())).await),
            input
        );
        assert_eq!(
            output(run(&worker, config("inputs.value", json!(null))).await),
            json!(null)
        );
    }

    #[tokio::test]
    async fn context_integer_boundaries_are_exact_or_fail_with_a_json_pointer() {
        let worker = ScriptWorker::default();
        let input = json!({
            "min": i64::MIN,
            "max": i64::MAX,
            "above_float_precision": 9_007_199_254_740_993_i64,
            "nested": [0, -1, 1.25, true, null, "quoted \"text\""],
        });
        assert_eq!(
            output(run(&worker, config("inputs.value", input.clone())).await),
            input
        );
        for namespace in SCRIPT_CONTEXT_NAMESPACES {
            for integer in [i64::MAX as u64 + 1, i64::MAX as u64 + 2, u64::MAX] {
                let mut attempt = config("42", json!(null));
                attempt.context.as_mut().unwrap()[namespace] =
                    json!({"nested/key": [{"integer~id": integer}]});
                let error = failure(run(&worker, attempt).await);
                assert!(
                    error.contains(&format!("/context/{namespace}/nested~1key/0/integer~0id")),
                    "{error}"
                );
                assert!(error.contains(&integer.to_string()), "{error}");
                assert!(error.contains("signed 64-bit integer range"), "{error}");
            }
        }
        assert_eq!(
            output(run(&worker, config("42", json!(null))).await),
            json!(42)
        );
    }

    #[tokio::test]
    async fn binds_all_canonical_namespaces_without_rendering_or_losing_json_values() {
        let worker = ScriptWorker::default();
        let context = json!({
            "task": {"id":"task-id","title":"{{ steps.secret.output }}","description":"",
                "level":"task","tags":["test"],"goals":[{"content":"quoted \"text\""}],
                "constraints":[],"code_refs":[{"path":"src/lib.rs","line":12}]},
            "execution": {"previous_output":{"quantity":3,"unit_price":12},"handoff":null,
                "run_count":2,"completed_count":1,"failed_count":1,
                "history":[{"step_name":"prepare","output":"{\"quantity\":3}"}]},
            "inputs": {"adjustment":1,"enabled":false,"nested":[null,true,1.25,"{% raw %}"]},
            "steps": {"prepare":{"output":{"quantity":3,"unit_price":12}}},
            "workflow": {"name":"demo","current_step":"transform","current_step_goal":"",
                "step_count":4,"output_schema":null},
            "artifacts": {"task":{"result":{"id":"task-artifact"}},
                "project":{"rules":{"id":"project-artifact"}},
                "task_run":{"summary":{"id":"run-artifact"}},
                "step_execution":{"prepare":{"report":{"id":"execution-artifact"}}}}
        });
        let mut attempt = config(
            "#{ task: task, execution: execution, inputs: inputs, steps: steps, workflow: workflow, artifacts: artifacts }",
            json!(null),
        );
        attempt.context = Some(context.clone());
        assert_eq!(output(run(&worker, attempt.clone()).await), context);
        attempt.script = "(execution.previous_output.quantity + inputs.adjustment) * steps.prepare.output.unit_price".into();
        assert_eq!(output(run(&worker, attempt.clone()).await), json!(48));
        attempt.script = "task.contains(\"worktree\")".into();
        assert_eq!(output(run(&worker, attempt.clone()).await), json!(false));
        for script in ["task.worktree", "input"] {
            attempt.script = script.into();
            assert!(
                failure(run(&worker, attempt.clone()).await).contains(if script == "input" {
                    "input"
                } else {
                    "worktree"
                })
            );
        }
    }

    #[tokio::test]
    async fn rejects_missing_and_malformed_whole_context_before_admission() {
        let worker = ScriptWorker::default();
        for context in [None, Some(json!(null)), Some(json!([])), Some(json!({}))] {
            let mut attempt = config("42", json!(null));
            attempt.context = context;
            assert!(
                worker
                    .admit(attempt, scope(), |_| {})
                    .err()
                    .unwrap()
                    .contains("context")
            );
        }
        for namespace in SCRIPT_CONTEXT_NAMESPACES {
            for malformed in [None, Some(json!(null)), Some(json!(false)), Some(json!([]))] {
                let mut attempt = config("42", json!(null));
                let context = attempt.context.as_mut().unwrap().as_object_mut().unwrap();
                if let Some(value) = malformed {
                    context.insert(namespace.into(), value);
                } else {
                    context.remove(namespace);
                }
                assert!(
                    worker
                        .admit(attempt, scope(), |_| {})
                        .err()
                        .unwrap()
                        .contains(namespace)
                );
            }
        }
        assert_eq!(worker.admitted.available_permits(), 5);
        assert_eq!(worker.active.available_permits(), 1);
    }

    #[tokio::test]
    async fn failures_include_rhai_positions_and_schema_paths() {
        let worker = ScriptWorker::default();
        for (script, needle) in [
            ("let =", "line"),
            ("inputs.value.missing", "missing"),
            ("inputs.value.quantity * true", "*"),
        ] {
            let error = failure(run(&worker, config(script, json!({"quantity":3}))).await);
            assert!(error.contains(needle), "{script}: {error}");
        }
        let mut invalid = config("#{ total: \"wrong\" }", json!(null));
        invalid.output_schema =
            json!({"type":"object","properties":{"total":{"type":"number"}},"required":["total"]});
        match run(&worker, invalid).await {
            StepResult::Failed {
                schema_errors: Some(errors),
                error,
                ..
            } => {
                assert!(error.contains("output_schema"));
                assert_eq!(errors[0].instance_path, "/total");
                assert_eq!(errors[0].schema_path, "/properties/total/type");
            }
            other => panic!("expected schema failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn scopes_are_fresh_and_imports_and_eval_are_disabled() {
        let worker = ScriptWorker::default();
        assert_eq!(
            output(
                run(
                    &worker,
                    config(
                        "let secret = 99; inputs.value.total = secret; inputs.value",
                        json!({"total":1})
                    )
                )
                .await
            ),
            json!({"total":99})
        );
        assert_eq!(
            output(run(&worker, config("inputs.value", json!({"total":2}))).await),
            json!({"total":2})
        );
        assert!(failure(run(&worker, config("secret", json!(null))).await).contains("secret"));
        for script in [
            "import \"/tmp/private\" as secret; secret",
            "eval(\"40 + 2\")",
        ] {
            assert!(
                failure(run(&worker, config(script, json!(null))).await)
                    .contains("Rhai execution failed")
            );
        }
    }

    #[tokio::test]
    async fn scripts_have_no_operation_limit_and_stop_only_on_cancellation() {
        let worker = ScriptWorker::default();
        assert_eq!(
            output(
                run(
                    &worker,
                    config(
                        "let total = 0; for i in 0..200000 { total += 1; } total",
                        json!(null)
                    )
                )
                .await
            ),
            json!(200_000)
        );
        let progress = Arc::new(Notify::new());
        let notify = Arc::clone(&progress);
        let attempt = worker
            .admit_with(
                config("loop {}", json!(null)),
                scope(),
                |_| {},
                move |config, cancellation, _| {
                    evaluate_with(
                        config,
                        cancellation,
                        |_| {},
                        CompiledSchema::compile,
                        move || notify.notify_one(),
                    )
                },
            )
            .unwrap();
        let progressed = tokio::time::timeout(Duration::from_secs(1), progress.notified())
            .await
            .is_ok();
        attempt.cancel();
        let result = attempt.settle().await;
        assert!(
            progressed,
            "the actual Rhai progress callback must run before cancellation: {result:?}"
        );
        assert!(failure(result).contains("Cancelled"));
        assert_eq!(worker.active.available_permits(), 1);
        assert_eq!(worker.admitted.available_permits(), 5);
        assert_eq!(
            output(run(&worker, config("8", json!(null))).await),
            json!(8)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn schema_compilation_is_admitted_once_and_settles_before_releasing_capacity() {
        use std::sync::atomic::AtomicUsize;

        {
            let worker = ScriptWorker::default();
            let compiled = Arc::new(AtomicUsize::new(0));
            let compile_count = Arc::clone(&compiled);
            let (started_tx, started_rx) = oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let (terminal_tx, mut terminal_rx) = tokio::sync::mpsc::unbounded_channel();
            let mut invalid_schema = config("let =", json!(null));
            invalid_schema.output_schema = json!({"type":"invalid"});
            let active = worker
                .admit_with(
                    invalid_schema.clone(),
                    scope(),
                    move |result| {
                        let _ = terminal_tx.send(result);
                    },
                    move |config, cancellation, _| {
                        evaluate_with(
                            config,
                            cancellation,
                            |_| {},
                            move |schema| {
                                compile_count.fetch_add(1, Ordering::Relaxed);
                                let _ = started_tx.send(());
                                release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                                CompiledSchema::compile(schema)
                            },
                            || {},
                        )
                    },
                )
                .unwrap();
            // A current-thread runtime can receive this only if compilation
            // is off its async thread and admission did not compile the schema.
            let started = tokio::time::timeout(Duration::from_secs(1), started_rx).await;
            match started {
                Ok(Ok(())) => {}
                error => {
                    let _ = release_tx.send(());
                    active.cancel();
                    let result = active.settle().await;
                    panic!("schema worker did not start: {error:?}; {result:?}");
                }
            }
            let mut queued = Vec::new();
            for _ in 0..PENDING {
                queued.push(
                    worker
                        .admit(invalid_schema.clone(), scope(), |_| {})
                        .unwrap(),
                );
            }
            assert!(
                worker
                    .admit(invalid_schema, scope(), |_| {})
                    .err()
                    .unwrap()
                    .contains("capacity exceeded")
            );
            let queued_cancel = queued.pop().unwrap();
            queued_cancel.cancel();
            assert_eq!(failure(queued_cancel.settle().await), "Cancelled");
            active.cancel();
            assert_eq!(worker.active.available_permits(), 0);
            assert_eq!(compiled.load(Ordering::Relaxed), 1);
            assert!(
                terminal_rx.try_recv().is_err(),
                "compilation is not settled yet"
            );
            for attempt in &queued {
                attempt.cancel();
            }
            release_tx.send(()).unwrap();
            let error = failure(active.settle().await);
            assert!(error.contains("Cancelled"), "{error}");
            for attempt in queued {
                let _ = attempt.settle().await;
            }
            assert_eq!(compiled.load(Ordering::Relaxed), 1);
            assert!(terminal_rx.try_recv().is_ok());
            assert!(
                terminal_rx.try_recv().is_err(),
                "one settled terminal result"
            );
            assert_eq!(worker.active.available_permits(), 1);
            assert_eq!(worker.admitted.available_permits(), 5);
            assert_eq!(
                output(run(&worker, config("42", json!(null))).await),
                json!(42)
            );
        }
    }

    #[tokio::test]
    async fn invalid_schema_fails_before_rhai_evaluation_and_recovers_capacity() {
        let worker = ScriptWorker::default();
        let mut invalid = config("let =", json!(null));
        invalid.output_schema = json!({"type":"invalid"});
        let error = failure(run(&worker, invalid).await);
        assert!(error.contains("output_schema"), "{error}");
        assert!(error.contains("malformed"), "{error}");
        assert_eq!(worker.active.available_permits(), 1);
        assert_eq!(worker.admitted.available_permits(), 5);
        assert_eq!(
            output(run(&worker, config("42", json!(null))).await),
            json!(42)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn saturation_queued_cancel_and_panic_settle_once_before_recovery() {
        let worker = ScriptWorker::default();
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (terminal_tx, mut terminal_rx) = tokio::sync::mpsc::unbounded_channel();
        let active = worker
            .admit_with(
                config("42", json!(null)),
                scope(),
                {
                    let terminal_tx = terminal_tx.clone();
                    move |result| {
                        let _ = terminal_tx.send(result);
                    }
                },
                move |_, _, _| {
                    let _ = started_tx.send(());
                    release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                    panic!("injected worker panic")
                },
            )
            .unwrap();
        let started = tokio::time::timeout(Duration::from_secs(1), started_rx).await;
        if !matches!(started, Ok(Ok(()))) {
            let _ = release_tx.send(());
            active.cancel();
            let result = active.settle().await;
            panic!("blocking worker did not start: {result:?}");
        }
        let mut queued = Vec::new();
        for _ in 0..PENDING {
            let terminal_tx = terminal_tx.clone();
            queued.push(
                worker
                    .admit(config("42", json!(null)), scope(), move |result| {
                        let _ = terminal_tx.send(result);
                    })
                    .unwrap(),
            );
        }
        assert_eq!(worker.active.available_permits(), 0);
        assert_eq!(worker.admitted.available_permits(), 0);
        let overflow = worker
            .admit(config("42", json!(null)), scope(), |_| {})
            .err()
            .unwrap();
        assert!(overflow.contains("capacity exceeded"));
        let cancelled = queued.pop().unwrap();
        cancelled.cancel();
        assert_eq!(failure(cancelled.settle().await), "Cancelled");
        assert_eq!(
            worker.active.available_permits(),
            0,
            "queued cancellation cannot release the running slot"
        );
        assert_eq!(worker.admitted.available_permits(), 1);
        let replacement = worker
            .admit(
                config("inputs.value", json!("replacement")),
                scope(),
                |_| {},
            )
            .unwrap();
        // The only Tokio thread remains responsive while the blocking worker waits.
        tokio::task::yield_now().await;
        release_tx.send(()).unwrap();
        assert!(failure(active.settle().await).contains("injected worker panic"));
        for attempt in queued {
            assert_eq!(output(attempt.settle().await), json!(42));
        }
        assert_eq!(output(replacement.settle().await), json!("replacement"));
        for _ in 0..5 {
            tokio::time::timeout(Duration::from_secs(1), terminal_rx.recv())
                .await
                .unwrap()
                .unwrap();
        }
        assert!(
            terminal_rx.try_recv().is_err(),
            "each admitted tracked attempt has exactly one settlement callback"
        );
        assert_eq!(worker.active.available_permits(), 1);
        assert_eq!(worker.admitted.available_permits(), 5);
        assert_eq!(
            output(run(&worker, config("9", json!(null))).await),
            json!(9)
        );
    }

    #[tokio::test]
    async fn rejects_malformed_config_but_never_caps_script_context_or_result_size() {
        let worker = ScriptWorker::default();
        for invalid in [
            ExecuteConfig {
                version: 2,
                ..config("inputs.value", json!(null))
            },
            config(" ", json!(null)),
            ExecuteConfig {
                output_schema: json!([]),
                ..config("inputs.value", json!(null))
            },
        ] {
            assert!(worker.admit(invalid, scope(), |_| {}).is_err());
            assert_eq!(worker.admitted.available_permits(), 5);
        }
        let large = "x".repeat(2 * 1024 * 1024);
        let padded = format!("// {large}\ninputs.value.len()");
        assert_eq!(
            output(run(&worker, config(&padded, json!(large))).await),
            json!(large.len())
        );
        let wide: Vec<_> = (0..20_000).collect();
        let deep = (0..100).fold(json!(1), |value, _| json!([value]));
        assert_eq!(
            output(
                run(
                    &worker,
                    config("inputs.value", json!({"wide": wide, "deep": deep}))
                )
                .await
            ),
            json!({"wide": wide, "deep": deep})
        );
        assert_eq!(
            output(
                run(
                    &worker,
                    config(
                        "let result = []; for x in 0..100 { result.push(inputs.value); } result.len()",
                        json!("x".repeat(16_384)),
                    ),
                )
                .await
            ),
            json!(100)
        );
        let error = failure(run(&worker, config("|| 42", json!(null))).await);
        assert!(error.contains("not JSON"), "{error}");
        assert!(
            validate_json_result(&Dynamic::from(rhai::FLOAT::NAN))
                .unwrap_err()
                .contains("non-finite")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_before_evaluation_never_spawns_the_blocking_body() {
        let worker = ScriptWorker::default();
        let evaluated = Arc::new(AtomicBool::new(false));
        let marker = Arc::clone(&evaluated);
        let attempt = worker
            .admit_with(
                config("42", json!(null)),
                scope(),
                |_| {},
                move |_, _, _| {
                    marker.store(true, Ordering::Relaxed);
                    panic!("cancelled evaluation must not start")
                },
            )
            .unwrap();
        attempt.cancel();
        assert_eq!(failure(attempt.settle().await), "Cancelled");
        assert!(!evaluated.load(Ordering::Relaxed));
        assert_eq!(worker.active.available_permits(), 1);
        assert_eq!(worker.admitted.available_permits(), 5);
    }

    fn host_worker(
        register: impl Fn(&mut rhai::Module, &HostContext) + Send + Sync + 'static,
    ) -> ScriptWorker {
        ScriptWorker::with_host_api(
            ScriptSlots::default(),
            Arc::new(move |engine, host| {
                let mut module = rhai::Module::new();
                register(&mut module, host);
                engine.register_static_module("test", module.into());
            }),
        )
    }

    #[tokio::test]
    async fn active_and_pending_slots_come_from_daemon_settings() {
        let worker = ScriptWorker::new(ScriptSlots {
            active: 2,
            pending: 1,
        });
        assert_eq!(worker.active.available_permits(), 2);
        assert_eq!(worker.admitted.available_permits(), 3);
        let attempts: Vec<_> = (0..3)
            .map(|_| {
                worker
                    .admit(config("loop {}", json!(null)), scope(), |_| {})
                    .unwrap()
            })
            .collect();
        let overflow = worker
            .admit(config("42", json!(null)), scope(), |_| {})
            .err()
            .unwrap();
        assert!(
            overflow.contains("capacity exceeded (2 active, 1 pending)"),
            "{overflow}"
        );
        for attempt in &attempts {
            attempt.cancel();
        }
        for attempt in attempts {
            assert_eq!(failure(attempt.settle().await), "Cancelled");
        }
        assert_eq!(worker.active.available_permits(), 2);
        assert_eq!(worker.admitted.available_permits(), 3);
        let default = ScriptWorker::default();
        assert_eq!(default.active.available_permits(), 1);
        assert_eq!(default.admitted.available_permits(), 1 + PENDING);
    }

    #[tokio::test]
    async fn host_calls_receive_the_execution_project_and_return_values_to_the_script() {
        let worker = host_worker(|module, host| {
            let host = host.clone();
            module.set_native_fn("project", move || {
                Ok(host.call(|_, project| async move { Ok(project.to_string()) })?)
            });
        });
        assert_eq!(
            output(run(&worker, config("test::project()", json!(null))).await),
            json!("script-project")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn slow_host_call_blocks_only_its_worker_thread() {
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let worker = {
            let (started, release) = (Arc::clone(&started), Arc::clone(&release));
            host_worker(move |module, host| {
                let (host, started, release) =
                    (host.clone(), Arc::clone(&started), Arc::clone(&release));
                module.set_native_fn("slow", move || {
                    started.notify_one();
                    let release = Arc::clone(&release);
                    Ok(host.call(|_, _| async move {
                        release.notified().await;
                        Ok(7 as rhai::INT)
                    })?)
                });
            })
        };
        let attempt = worker
            .admit(config("test::slow() * 6", json!(null)), scope(), |_| {})
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), started.notified())
            .await
            .expect("host call started");
        // The only Tokio thread still runs timers and other tasks while the
        // host call is in flight on the blocking worker.
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(tokio::spawn(async { 41 + 1 }).await.unwrap(), 42);
        assert_eq!(worker.active.available_permits(), 0);
        release.notify_one();
        assert_eq!(output(attempt.settle().await), json!(42));
        assert_eq!(worker.active.available_permits(), 1);
        assert_eq!(worker.admitted.available_permits(), 5);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelling_a_hung_host_call_settles_once_and_releases_the_slot() {
        let worker = ScriptWorker::with_host_api(ScriptSlots::default(), hanging_host_api());
        for script in [
            "test::hang()",
            // Catching the cancellation cannot turn it into a success.
            "let kind = (); try { test::hang(); } catch (error) { kind = error.kind; } kind",
        ] {
            let (terminal_tx, mut terminal_rx) = tokio::sync::mpsc::unbounded_channel();
            let attempt = worker
                .admit(config(script, json!(null)), scope(), move |result| {
                    let _ = terminal_tx.send(result);
                })
                .unwrap();
            let queued = worker
                .admit(config("5", json!(null)), scope(), |_| {})
                .unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert_eq!(worker.active.available_permits(), 0, "{script}");
            attempt.cancel();
            assert_eq!(failure(attempt.settle().await), "Cancelled", "{script}");
            assert_eq!(output(queued.settle().await), json!(5));
            assert_eq!(failure(terminal_rx.recv().await.unwrap()), "Cancelled");
            assert!(terminal_rx.try_recv().is_err(), "one terminal result");
            assert_eq!(worker.active.available_permits(), 1);
            assert_eq!(worker.admitted.available_permits(), 5);
        }
    }

    #[tokio::test]
    async fn host_function_panic_fails_the_attempt_and_capacity_recovers() {
        let worker = host_worker(|module, _| {
            module.set_native_fn("boom", || -> Result<rhai::INT, Box<EvalAltResult>> {
                panic!("injected host panic")
            });
        });
        let error = failure(run(&worker, config("test::boom()", json!(null))).await);
        assert!(error.contains("panicked"), "{error}");
        assert!(error.contains("injected host panic"), "{error}");
        assert_eq!(worker.active.available_permits(), 1);
        assert_eq!(worker.admitted.available_permits(), 5);
        assert_eq!(
            output(run(&worker, config("11", json!(null))).await),
            json!(11)
        );
    }

    #[tokio::test]
    async fn service_errors_raise_catchable_kinds_distinguishing_not_found_from_transport() {
        let worker = host_worker(|module, host| {
            let host = host.clone();
            module.set_native_fn("fail", move |kind: rhai::ImmutableString| {
                let error = match kind.as_str() {
                    "missing" => ServiceError::task_not_found("gone"),
                    "invalid" => ServiceError::InvalidInput("bad".into()),
                    _ => ServiceError::NetworkError("connection refused".into()),
                };
                Ok(host.call(|_, _| async move { Err::<rhai::INT, _>(error) })?)
            });
        });
        for (argument, kind) in [
            ("missing", "not_found"),
            ("invalid", "invalid"),
            ("network", "transport"),
        ] {
            let script = format!(
                "let caught = (); try {{ test::fail(\"{argument}\"); }} catch (error) {{ caught = error; }} caught"
            );
            let caught = output(run(&worker, config(&script, json!(null))).await);
            assert_eq!(caught["kind"], kind);
            assert!(!caught["message"].as_str().unwrap().is_empty());
        }
        let error = failure(run(&worker, config("test::fail(\"network\")", json!(null))).await);
        assert!(error.contains("transport"), "{error}");
        assert!(error.contains("connection refused"), "{error}");
    }
}
