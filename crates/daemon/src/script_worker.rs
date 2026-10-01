//! Daemon-wide admission and settlement for pure JSON Rhai transformations.
//!
//! Every admitted attempt owns its queue permit and cancellation signal. The
//! active permit stays inside the blocking closure, including panic unwinding;
//! cancelling the async waiter never releases a still-running evaluation.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rhai::{Dynamic, Engine, Scope};
use tokio::sync::{Semaphore, watch};
use vertebrae_core::models::ExecuteConfig;

use crate::actors::step_executor::{StepResult, step_result_for_schema_error};
use crate::output_validator::{CompiledSchema, SchemaError};

pub const SCRIPT_PENDING_CAPACITY: usize = 4;
pub const SCRIPT_MAX_OPERATIONS: u64 = 100_000;
pub const SCRIPT_DEADLINE: Duration = Duration::from_secs(2);
pub const SCRIPT_MAX_SOURCE_BYTES: usize = 256 * 1024;
pub const SCRIPT_MAX_JSON_BYTES: usize = 1024 * 1024;
pub const SCRIPT_CONTEXT_NAMESPACES: [&str; 6] = [
    "task",
    "execution",
    "inputs",
    "steps",
    "workflow",
    "artifacts",
];
const MAX_STRING_BYTES: usize = 256 * 1024;
const MAX_ARRAY_ITEMS: usize = 16_384;
const MAX_MAP_ENTRIES: usize = 4096;
const MAX_DEPTH: usize = 64;

#[derive(Debug)]
pub struct ScriptWorker {
    admitted: Arc<Semaphore>,
    active: Arc<Semaphore>,
    deadline: Duration,
    max_operations: u64,
}

impl Default for ScriptWorker {
    fn default() -> Self {
        Self {
            admitted: Arc::new(Semaphore::new(1 + SCRIPT_PENDING_CAPACITY)),
            active: Arc::new(Semaphore::new(1)),
            deadline: SCRIPT_DEADLINE,
            max_operations: SCRIPT_MAX_OPERATIONS,
        }
    }
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
    #[cfg(test)]
    pub(crate) fn without_operation_limit_for_test() -> Self {
        Self {
            max_operations: u64::MAX,
            ..Self::default()
        }
    }
    /// Reject overflow synchronously before allocating a waiter or blocking job.
    /// The settlement callback is invoked only after the worker has been joined.
    pub fn admit(
        &self,
        config: ExecuteConfig,
        settled: impl FnOnce(StepResult) + Send + 'static,
    ) -> Result<ScriptAttempt, String> {
        self.admit_with(config, settled, evaluate)
    }

    fn admit_with(
        &self,
        config: ExecuteConfig,
        settled: impl FnOnce(StepResult) + Send + 'static,
        evaluation: impl FnOnce(ExecuteConfig, Arc<AtomicBool>, Instant, u64) -> StepResult
        + Send
        + 'static,
    ) -> Result<ScriptAttempt, String> {
        let admitted = Arc::clone(&self.admitted)
            .try_acquire_owned()
            .map_err(|_| {
                format!(
                    "Rhai execution capacity exceeded (1 active, {SCRIPT_PENDING_CAPACITY} pending)"
                )
            })?;
        let deadline = Instant::now() + self.deadline;
        validate_limits(&config)?;
        config
            .validate_structure()
            .map_err(|error| error.to_string())?;
        let active = Arc::clone(&self.active);
        // Reserve an idle active slot immediately, so simultaneous admissions
        // allocate at most four genuine pending waiters before any task polls.
        let immediate = Arc::clone(&active).try_acquire_owned().ok();
        let cancellation = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancellation);
        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        let max_operations = self.max_operations;
        let settlement = tokio::spawn(async move {
            let acquisition = if *cancel_rx.borrow() {
                Err("Cancelled".to_string())
            } else if Instant::now() >= deadline {
                Err("Rhai execution deadline exceeded while queued".to_string())
            } else if let Some(permit) = immediate {
                Ok(permit)
            } else {
                tokio::select! {
                    biased;
                    _ = cancel_rx.changed() => Err("Cancelled".to_string()),
                    _ = tokio::time::sleep_until(deadline.into()) => Err("Rhai execution deadline exceeded while queued".to_string()),
                    permit = active.acquire_owned() => permit.map_err(|_| "Rhai worker closed".to_string()),
                }
            };
            let result = match acquisition {
                Err(error) => StepResult::failed(None, error),
                Ok(permit) => {
                    // No timeout/abort races this join: the closure cooperates
                    // with its own cancellation flag and deadline instead.
                    match tokio::task::spawn_blocking(move || {
                        let _permit = permit;
                        evaluation(config, worker_cancel, deadline, max_operations)
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

pub(crate) fn validate_limits(config: &ExecuteConfig) -> Result<(), String> {
    if config.script.len() > SCRIPT_MAX_SOURCE_BYTES {
        return Err(format!(
            "execute script exceeds {SCRIPT_MAX_SOURCE_BYTES} byte limit"
        ));
    }
    let context_value = config
        .context
        .as_ref()
        .ok_or_else(|| "execute requires a resolved context JSON object".to_string())?;
    let context = runtime_context(config)?;
    for namespace in SCRIPT_CONTEXT_NAMESPACES {
        if !context
            .get(namespace)
            .is_some_and(serde_json::Value::is_object)
        {
            return Err(format!("execute context.{namespace} must be a JSON object"));
        }
    }
    for (label, value) in [
        ("context", context_value),
        ("output_schema", &config.output_schema),
    ] {
        validate_json_limits(value, label)?;
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

fn validate_json_limits(value: &serde_json::Value, label: &str) -> Result<(), String> {
    let mut pending = vec![(value, 0)];
    while let Some((value, depth)) = pending.pop() {
        if depth > MAX_DEPTH {
            return Err(format!(
                "execute {label} exceeds JSON depth limit {MAX_DEPTH}"
            ));
        }
        match value {
            serde_json::Value::Array(items) => {
                if items.len() > MAX_ARRAY_ITEMS {
                    return Err(format!(
                        "execute {label} exceeds array size limit {MAX_ARRAY_ITEMS}"
                    ));
                }
                pending.extend(items.iter().map(|value| (value, depth + 1)));
            }
            serde_json::Value::Object(fields) => {
                if fields.len() > MAX_MAP_ENTRIES {
                    return Err(format!(
                        "execute {label} exceeds map size limit {MAX_MAP_ENTRIES}"
                    ));
                }
                pending.extend(fields.values().map(|value| (value, depth + 1)));
            }
            serde_json::Value::String(text) if text.len() > MAX_STRING_BYTES => {
                return Err(format!(
                    "execute {label} exceeds string size limit {MAX_STRING_BYTES}"
                ));
            }
            _ => {}
        }
    }
    let encoded =
        serde_json::to_vec(value).map_err(|error| format!("Invalid execute {label}: {error}"))?;
    if encoded.len() > SCRIPT_MAX_JSON_BYTES {
        return Err(format!(
            "execute {label} exceeds {SCRIPT_MAX_JSON_BYTES} byte JSON limit"
        ));
    }
    Ok(())
}

fn evaluate(
    config: ExecuteConfig,
    cancellation: Arc<AtomicBool>,
    deadline: Instant,
    max_operations: u64,
) -> StepResult {
    evaluate_with(
        config,
        cancellation,
        deadline,
        max_operations,
        CompiledSchema::compile,
        || {},
    )
}

fn evaluate_with(
    config: ExecuteConfig,
    cancellation: Arc<AtomicBool>,
    deadline: Instant,
    max_operations: u64,
    compile_schema: impl FnOnce(&serde_json::Value) -> Result<CompiledSchema, SchemaError>,
    progress: impl Fn() + 'static,
) -> StepResult {
    let check_interruption = || {
        if cancellation.load(Ordering::Relaxed) {
            Some("Cancelled")
        } else if Instant::now() >= deadline {
            Some("Rhai execution deadline exceeded")
        } else {
            None
        }
    };
    if let Some(error) = check_interruption() {
        return StepResult::failed(None, error);
    }
    // Schema compilation shares the worker's permit and deadline. It cannot
    // be interrupted by Rhai callbacks, so observe cancellation after it joins.
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
        .set_max_operations(max_operations)
        .set_max_string_size(MAX_STRING_BYTES)
        .set_max_array_size(MAX_ARRAY_ITEMS)
        .set_max_map_size(MAX_MAP_ENTRIES)
        .set_max_expr_depths(MAX_DEPTH, MAX_DEPTH)
        .set_max_call_levels(32)
        .set_max_variables(128)
        .set_max_functions(64)
        .set_fail_on_invalid_map_property(true)
        .disable_symbol("eval")
        .on_print(|_| {})
        .on_debug(|_, _, _| {});
    let progress_cancel = Arc::clone(&cancellation);
    engine.on_progress(move |_| {
        progress();
        if progress_cancel.load(Ordering::Relaxed) {
            Some("Cancelled".into())
        } else if Instant::now() >= deadline {
            Some("Rhai execution deadline exceeded".into())
        } else {
            None
        }
    });
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
    if let Err(error) = validate_dynamic_result(&result, 0, &mut 0) {
        return StepResult::failed(None, error);
    }
    let output = match rhai::serde::from_dynamic::<serde_json::Value>(&result) {
        Ok(output) => output,
        Err(error) => return StepResult::failed(None, format!("Rhai result is not JSON: {error}")),
    };
    if let Err(error) = validate_json_limits(&output, "result") {
        return StepResult::failed(None, error);
    }
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

/// Convert the already-bounded context without serde's unsigned-to-float
/// fallback. Rhai integers are signed 64-bit; reject larger JSON integers
/// with their JSON pointer rather than persisting a rounded successful result.
fn json_to_rhai(value: &serde_json::Value, path: &str) -> Result<Dynamic, String> {
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

/// Count the aggregate encoded size before serde can expand shared strings or
/// nested containers into an owned JSON tree. Bounds also reject non-JSON types.
fn validate_dynamic_result(value: &Dynamic, depth: usize, bytes: &mut usize) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err(format!("Rhai result exceeds JSON depth limit {MAX_DEPTH}"));
    }
    let mut add_bytes = |count: usize| -> Result<(), String> {
        *bytes = bytes.saturating_add(count);
        if *bytes > SCRIPT_MAX_JSON_BYTES {
            Err(format!(
                "Rhai result exceeds {SCRIPT_MAX_JSON_BYTES} byte JSON limit"
            ))
        } else {
            Ok(())
        }
    };
    if value.is_unit() || value.is::<bool>() || value.is::<rhai::INT>() {
        return add_bytes(32);
    }
    if value.is::<rhai::FLOAT>() {
        if !value.as_float().map_err(str::to_string)?.is_finite() {
            return Err("Rhai result contains a non-finite JSON number".into());
        }
        return add_bytes(32);
    }
    if value.is::<rhai::ImmutableString>() {
        let text = value.clone_cast::<rhai::ImmutableString>();
        return add_bytes(json_string_size(&text));
    }
    if value.is::<rhai::Array>() {
        let items = value.as_array_ref().map_err(str::to_string)?;
        add_bytes(items.len().saturating_add(2))?;
        for item in items.iter() {
            validate_dynamic_result(item, depth + 1, bytes)?;
        }
        return Ok(());
    }
    if value.is::<rhai::Map>() {
        let fields = value.as_map_ref().map_err(str::to_string)?;
        add_bytes(fields.len().saturating_add(2))?;
        for (key, item) in fields.iter() {
            *bytes = bytes.saturating_add(json_string_size(key).saturating_add(1));
            if *bytes > SCRIPT_MAX_JSON_BYTES {
                return Err(format!(
                    "Rhai result exceeds {SCRIPT_MAX_JSON_BYTES} byte JSON limit"
                ));
            }
            validate_dynamic_result(item, depth + 1, bytes)?;
        }
        return Ok(());
    }
    Err(format!(
        "Rhai result type '{}' is not JSON",
        value.type_name()
    ))
}

fn json_string_size(text: &str) -> usize {
    text.bytes().fold(2_usize, |bytes, byte| {
        bytes.saturating_add(match byte {
            b'"' | b'\\' | b'\n' | b'\r' | b'\t' | 8 | 12 => 2,
            0..=31 => 6,
            _ => 1,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::oneshot;

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
        worker.admit(config, |_| {}).unwrap().settle().await
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
    async fn rejects_missing_malformed_and_oversized_whole_context_before_admission() {
        let worker = ScriptWorker::default();
        for context in [None, Some(json!(null)), Some(json!([])), Some(json!({}))] {
            let mut attempt = config("42", json!(null));
            attempt.context = context;
            assert!(
                worker
                    .admit(attempt, |_| {})
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
                        .admit(attempt, |_| {})
                        .err()
                        .unwrap()
                        .contains(namespace)
                );
            }
        }
        let mut attempt = config("42", json!(null));
        for namespace in SCRIPT_CONTEXT_NAMESPACES {
            attempt.context.as_mut().unwrap()[namespace] = json!({"values":[
                "x".repeat(100_000), "y".repeat(100_000)
            ]});
        }
        assert!(
            worker
                .admit(attempt, |_| {})
                .err()
                .unwrap()
                .contains("context exceeds")
        );
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
    async fn limits_deadline_and_cancellation_recover_capacity() {
        let worker = ScriptWorker {
            max_operations: 100,
            ..ScriptWorker::default()
        };
        let error = failure(run(&worker, config("loop {}", json!(null))).await);
        assert!(error.contains("operations"), "{error}");
        assert_eq!(
            output(run(&worker, config("42", json!(null))).await),
            json!(42)
        );
        let worker = ScriptWorker {
            max_operations: u64::MAX,
            deadline: Duration::from_millis(20),
            ..ScriptWorker::default()
        };
        assert!(failure(run(&worker, config("loop {}", json!(null))).await).contains("deadline"));
        assert_eq!(
            output(run(&worker, config("7", json!(null))).await),
            json!(7)
        );
        let worker = ScriptWorker {
            max_operations: u64::MAX,
            ..ScriptWorker::default()
        };
        let progress = Arc::new(tokio::sync::Notify::new());
        let notify = Arc::clone(&progress);
        let attempt = worker
            .admit_with(
                config("loop {}", json!(null)),
                |_| {},
                move |config, cancellation, deadline, operations| {
                    evaluate_with(
                        config,
                        cancellation,
                        deadline,
                        operations,
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

        for cancel in [true, false] {
            let worker = ScriptWorker {
                deadline: Duration::from_millis(100),
                ..ScriptWorker::default()
            };
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
                    move |result| {
                        let _ = terminal_tx.send(result);
                    },
                    move |config, cancellation, deadline, operations| {
                        evaluate_with(
                            config,
                            cancellation,
                            deadline,
                            operations,
                            move |schema| {
                                compile_count.fetch_add(1, Ordering::Relaxed);
                                let _ = started_tx.send(deadline);
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
            let deadline = match started {
                Ok(Ok(deadline)) => deadline,
                error => {
                    let _ = release_tx.send(());
                    active.cancel();
                    let result = active.settle().await;
                    panic!("schema worker did not start: {error:?}; {result:?}");
                }
            };
            let mut queued = Vec::new();
            for _ in 0..SCRIPT_PENDING_CAPACITY {
                queued.push(worker.admit(invalid_schema.clone(), |_| {}).unwrap());
            }
            assert!(
                worker
                    .admit(invalid_schema, |_| {})
                    .err()
                    .unwrap()
                    .contains("capacity exceeded")
            );
            let queued_cancel = queued.pop().unwrap();
            queued_cancel.cancel();
            assert_eq!(failure(queued_cancel.settle().await), "Cancelled");
            if cancel {
                active.cancel();
            } else {
                tokio::time::sleep_until(deadline.into()).await;
            }
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
            assert!(
                error.contains(if cancel { "Cancelled" } else { "deadline" }),
                "{error}"
            );
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
                {
                    let terminal_tx = terminal_tx.clone();
                    move |result| {
                        let _ = terminal_tx.send(result);
                    }
                },
                move |_, _, _, _| {
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
        for _ in 0..SCRIPT_PENDING_CAPACITY {
            let terminal_tx = terminal_tx.clone();
            queued.push(
                worker
                    .admit(config("42", json!(null)), move |result| {
                        let _ = terminal_tx.send(result);
                    })
                    .unwrap(),
            );
        }
        assert_eq!(worker.active.available_permits(), 0);
        assert_eq!(worker.admitted.available_permits(), 0);
        let overflow = worker
            .admit(config("42", json!(null)), |_| {})
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
            .admit(config("inputs.value", json!("replacement")), |_| {})
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
    async fn rejects_malformed_and_oversized_data_before_admission() {
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
            config(&"x".repeat(SCRIPT_MAX_SOURCE_BYTES + 1), json!(null)),
            config("inputs.value", json!("x".repeat(MAX_STRING_BYTES + 1))),
        ] {
            assert!(worker.admit(invalid, |_| {}).is_err());
            assert_eq!(worker.admitted.available_permits(), 5);
        }
        let error = failure(
            run(
                &worker,
                config(
                    "let result = []; for x in 0..100 { result.push(inputs.value); } result",
                    json!("x".repeat(16_384)),
                ),
            )
            .await,
        );
        assert!(error.contains("Length of string too large"), "{error}");
        assert_eq!(
            output(run(&worker, config("10", json!(null))).await),
            json!(10)
        );
        let error = failure(run(&worker, config("|| 42", json!(null))).await);
        assert!(error.contains("not JSON"), "{error}");
    }

    #[test]
    fn aggregate_result_budget_counts_repeated_strings_before_json_conversion() {
        let text = rhai::ImmutableString::from("x".repeat(16_384));
        let values: rhai::Array = (0..100).map(|_| Dynamic::from(text.clone())).collect();
        let result = Dynamic::from(values);
        let error = validate_dynamic_result(&result, 0, &mut 0).unwrap_err();
        assert!(error.contains("1048576 byte JSON limit"), "{error}");
        assert!(
            validate_dynamic_result(&Dynamic::from(rhai::FLOAT::NAN), 0, &mut 0)
                .unwrap_err()
                .contains("non-finite")
        );
        assert_eq!(
            json_string_size("quote \" newline\n slash \\"),
            serde_json::to_string("quote \" newline\n slash \\")
                .unwrap()
                .len()
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
                |_| {},
                move |_, _, _, _| {
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
}
