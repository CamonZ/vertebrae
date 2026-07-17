//! Persistence adapter for provider-neutral harness events.

use std::sync::Arc;

use async_trait::async_trait;
use vertebrae_core::{ExecutionService, SessionLog};
use vertebrae_harness_core::{EventSink, HarnessError, HarnessEventV1};

/// Persists already-sequenced harness events as daemon-owned session logs.
pub struct SessionLogEventSink {
    step_execution_id: String,
    execution_service: Arc<dyn ExecutionService>,
}

impl SessionLogEventSink {
    pub fn new(
        step_execution_id: impl Into<String>,
        execution_service: Arc<dyn ExecutionService>,
    ) -> Self {
        Self {
            step_execution_id: step_execution_id.into(),
            execution_service,
        }
    }
}

#[async_trait]
impl EventSink for SessionLogEventSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        let content = serde_json::to_string(&event).map_err(|error| {
            HarnessError::EventSink(format!(
                "failed to serialize harness event {} for step execution {}: {error}",
                event.event_id, self.step_execution_id
            ))
        })?;
        let logical_key = format!("harness:{}", event.event_id);
        let log = SessionLog::new(&self.step_execution_id, content)
            .with_format("harness")
            .with_logical_key(logical_key);

        self.execution_service.add_log(log).await.map_err(|error| {
            HarnessError::EventSink(format!(
                "failed to persist harness event {} for step execution {}: {error}",
                event.event_id, self.step_execution_id
            ))
        })?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };

    use async_trait::async_trait;
    use vertebrae_core::{
        ExecutionService, ServiceError, ServiceResult, SessionLog, StepExecution, StopRunTarget,
        TaskRun, TaskRunTrace, UpdateExecutionStatusParams,
    };
    use vertebrae_harness_core::{
        EventSequencer, EventSink, HarnessError, HarnessEventDraftV1, HarnessEventPayloadV1,
        HarnessEventV1, SequencedEventSink, ThreadKind, TurnInputProvenance,
    };

    use super::SessionLogEventSink;

    const EXACT_EVENT_JSON: &str = r#"{"version":1,"event_id":"event-1","stream_id":"stream-1","sequence":7,"correlation":{"session_id":"session-1","thread_id":"thread-1","turn_id":"turn-1","run_id":"run-1","item_id":"item-1","tool_call_id":"tool-1","parent_tool_call_id":"parent-tool","provider_resume_id":"resume-1"},"timestamp":"2026-07-17T10:11:12.123456Z","semantics":"snapshot","provider_sequence":41,"type":"text","data":{"text":"exact text"}}"#;

    fn event_from_json(json: &str) -> HarnessEventV1 {
        serde_json::from_str(json).expect("test event should be valid")
    }

    #[derive(Default)]
    struct CapturingExecutionService {
        logs: Mutex<Vec<SessionLog>>,
        reject_next: AtomicBool,
        block_add: AtomicBool,
        add_started: tokio::sync::Notify,
        release_add: tokio::sync::Notify,
    }

    impl CapturingExecutionService {
        fn rejecting() -> Self {
            Self {
                reject_next: AtomicBool::new(true),
                ..Self::default()
            }
        }

        fn blocking() -> Self {
            Self {
                block_add: AtomicBool::new(true),
                ..Self::default()
            }
        }

        fn logs(&self) -> Vec<SessionLog> {
            self.logs.lock().unwrap().clone()
        }
    }

    fn unused<T>() -> ServiceResult<T> {
        Err(ServiceError::invalid_input(
            "unused CapturingExecutionService method",
        ))
    }

    #[async_trait]
    impl ExecutionService for CapturingExecutionService {
        async fn create_execution(&self, _execution: StepExecution) -> ServiceResult<String> {
            unused()
        }

        async fn get_execution(&self, _id: &str) -> ServiceResult<Option<StepExecution>> {
            unused()
        }

        async fn list_executions_for_task(
            &self,
            _task_id: &str,
        ) -> ServiceResult<Vec<StepExecution>> {
            unused()
        }

        async fn add_log(&self, log: SessionLog) -> ServiceResult<String> {
            self.add_started.notify_one();
            if self.block_add.load(Ordering::SeqCst) {
                self.release_add.notified().await;
            }
            if self.reject_next.swap(false, Ordering::SeqCst) {
                return Err(ServiceError::network_error("simulated transport failure"));
            }
            self.logs.lock().unwrap().push(log);
            Ok("log-id".into())
        }

        async fn list_logs_for_execution(
            &self,
            _execution_id: &str,
        ) -> ServiceResult<Vec<SessionLog>> {
            unused()
        }

        async fn get_latest_execution_for_task(
            &self,
            _task_id: &str,
        ) -> ServiceResult<Option<StepExecution>> {
            unused()
        }

        async fn update_execution(
            &self,
            _execution_id: &str,
            _output: Option<String>,
            _transition_result: Option<String>,
        ) -> ServiceResult<()> {
            unused()
        }

        async fn run_step(&self, _task_id: &str, _step_id: &str) -> ServiceResult<StepExecution> {
            unused()
        }

        async fn update_execution_status(
            &self,
            _execution_id: &str,
            _params: UpdateExecutionStatusParams,
        ) -> ServiceResult<()> {
            unused()
        }

        async fn orchestrate_task(&self, _task_id: &str) -> ServiceResult<()> {
            unused()
        }

        async fn stop_orchestrator(&self, _task_id: &str) -> ServiceResult<()> {
            unused()
        }

        async fn active_run(&self, _task_id: &str) -> ServiceResult<Option<TaskRun>> {
            unused()
        }

        async fn task_runs(&self, _task_id: &str) -> ServiceResult<Vec<TaskRun>> {
            unused()
        }

        async fn task_run(&self, _task_run_id: &str) -> ServiceResult<Option<TaskRun>> {
            unused()
        }

        async fn task_run_trace(&self, _root_task_run_id: &str) -> ServiceResult<TaskRunTrace> {
            unused()
        }

        async fn run_workflow(&self, _task_id: &str) -> ServiceResult<TaskRun> {
            unused()
        }

        async fn stop_run(&self, _target: StopRunTarget) -> ServiceResult<Option<TaskRun>> {
            unused()
        }
    }

    #[tokio::test]
    async fn persists_exact_harness_json_and_stable_log_identity() {
        let service = Arc::new(CapturingExecutionService::default());
        let sink = SessionLogEventSink::new("step-execution-1", service.clone());
        let event = event_from_json(EXACT_EVENT_JSON);

        sink.emit(event.clone()).await.unwrap();
        sink.emit(event.clone()).await.unwrap();

        let logs = service.logs();
        assert_eq!(logs.len(), 2);
        for log in &logs {
            assert_eq!(log.step_execution_id, "step-execution-1");
            assert_eq!(log.content, EXACT_EVENT_JSON);
            assert_eq!(log.format.as_deref(), Some("harness"));
            assert_eq!(log.logical_key.as_deref(), Some("harness:event-1"));
            let stored = event_from_json(&log.content);
            assert_eq!(stored, event);
            assert_eq!(stored.event_id.as_str(), "event-1");
            assert_eq!(stored.stream_id.as_str(), "stream-1");
            assert_eq!(stored.sequence, 7);
            assert_eq!(
                stored.correlation.session_id.as_ref().unwrap().as_str(),
                "session-1"
            );
            assert_eq!(
                stored.correlation.thread_id.as_ref().unwrap().as_str(),
                "thread-1"
            );
            assert_eq!(stored.timestamp, event.timestamp);
            assert_eq!(stored.semantics, event.semantics);
            assert_eq!(stored.provider_sequence, Some(41));
            let HarnessEventPayloadV1::Text(text) = stored.payload else {
                panic!("expected text event payload")
            };
            assert_eq!(text.text, "exact text");
        }
        assert_eq!(logs[0].logical_key, logs[1].logical_key);
    }

    #[tokio::test]
    async fn awaits_persistence_before_reporting_success() {
        let service = Arc::new(CapturingExecutionService::blocking());
        let sink = Arc::new(SessionLogEventSink::new(
            "step-execution-1",
            service.clone(),
        ));
        let event = event_from_json(EXACT_EVENT_JSON);
        let emit_task = tokio::spawn(async move { sink.emit(event).await });

        service.add_started.notified().await;
        assert!(!emit_task.is_finished());
        assert!(service.logs().is_empty());

        service.release_add.notify_one();
        emit_task.await.unwrap().unwrap();
        assert_eq!(service.logs().len(), 1);
    }

    #[tokio::test]
    async fn preserves_thread_lineage_opaque_locator_and_turn_input_provenance() {
        let event_json = [
            r#"{"version":1,"event_id":"root-declared","stream_id":"root-stream","sequence":1,"correlation":{"session_id":"session-1","thread_id":"root-thread"},"timestamp":"2026-07-17T10:12:00Z","semantics":"snapshot","type":"thread_declared","data":{"thread_id":"root-thread","kind":"root"}}"#,
            r#"{"version":1,"event_id":"child-declared","stream_id":"child-stream","sequence":1,"correlation":{"session_id":"session-1","thread_id":"child-thread","parent_tool_call_id":"spawn-tool"},"timestamp":"2026-07-17T10:12:01Z","semantics":"snapshot","type":"thread_declared","data":{"thread_id":"child-thread","parent_thread_id":"root-thread","kind":"subagent","caused_by_tool_call_id":"spawn-tool","provider_thread_ref":"provider://opaque/%2Fchild?token=a%3Ab","agent_metadata":{"name":"researcher","role":"find exact evidence","model":"model-x"}}}"#,
            r#"{"version":1,"event_id":"human-input","stream_id":"root-stream","sequence":2,"correlation":{"session_id":"session-1","thread_id":"root-thread","turn_id":"turn-1"},"timestamp":"2026-07-17T10:12:02Z","semantics":"snapshot","type":"turn_input","data":{"thread_id":"root-thread","content":"Line one\nLine two — keep  spaces  and symbols: {}[]","provenance":"human"}}"#,
            r#"{"version":1,"event_id":"agent-input","stream_id":"child-stream","sequence":2,"correlation":{"thread_id":"child-thread","run_id":"run-9"},"timestamp":"2026-07-17T10:12:03Z","semantics":"snapshot","type":"turn_input","data":{"thread_id":"child-thread","run_id":"run-9","content":"Investigate verbatim:\n  αβγ\nDo not abbreviate.","provenance":"agent"}}"#,
        ];
        let service = Arc::new(CapturingExecutionService::default());
        let sink = SessionLogEventSink::new("step-execution-lineage", service.clone());

        for json in event_json {
            sink.emit(event_from_json(json)).await.unwrap();
        }

        let logs = service.logs();
        assert_eq!(logs.len(), event_json.len());
        for (log, expected_json) in logs.iter().zip(event_json) {
            assert_eq!(
                event_from_json(&log.content),
                event_from_json(expected_json)
            );
        }

        let root_event = event_from_json(&logs[0].content);
        assert_eq!(
            root_event.correlation.session_id.as_ref().unwrap().as_str(),
            "session-1"
        );
        assert_eq!(
            root_event.correlation.thread_id.as_ref().unwrap().as_str(),
            "root-thread"
        );
        let HarnessEventPayloadV1::ThreadDeclared(root) = root_event.payload else {
            panic!("expected root thread declaration")
        };
        assert_eq!(root.kind, ThreadKind::Root);
        assert!(root.parent_thread_id.is_none());

        let child_event = event_from_json(&logs[1].content);
        assert_eq!(
            child_event
                .correlation
                .parent_tool_call_id
                .as_ref()
                .unwrap()
                .as_str(),
            "spawn-tool"
        );
        assert_eq!(
            child_event.correlation.thread_id.as_ref().unwrap().as_str(),
            "child-thread"
        );
        let HarnessEventPayloadV1::ThreadDeclared(child) = child_event.payload else {
            panic!("expected child thread declaration")
        };
        assert_eq!(child.kind, ThreadKind::Subagent);
        assert_eq!(child.parent_thread_id.unwrap().as_str(), "root-thread");
        assert_eq!(
            child.provider_thread_ref.unwrap().as_str(),
            "provider://opaque/%2Fchild?token=a%3Ab"
        );
        assert_eq!(child.caused_by_tool_call_id.unwrap().as_str(), "spawn-tool");
        assert_eq!(
            child.agent_metadata.unwrap().role.as_deref(),
            Some("find exact evidence")
        );

        let human_event = event_from_json(&logs[2].content);
        assert_eq!(
            human_event.correlation.turn_id.as_ref().unwrap().as_str(),
            "turn-1"
        );
        assert_eq!(
            human_event.correlation.thread_id.as_ref().unwrap().as_str(),
            "root-thread"
        );
        let HarnessEventPayloadV1::TurnInput(human) = human_event.payload else {
            panic!("expected human turn input")
        };
        assert_eq!(human.provenance, TurnInputProvenance::Human);
        assert_eq!(
            human.content,
            "Line one\nLine two — keep  spaces  and symbols: {}[]"
        );

        let agent_event = event_from_json(&logs[3].content);
        assert_eq!(
            agent_event.correlation.run_id.as_ref().unwrap().as_str(),
            "run-9"
        );
        assert_eq!(
            agent_event.correlation.thread_id.as_ref().unwrap().as_str(),
            "child-thread"
        );
        let HarnessEventPayloadV1::TurnInput(agent) = agent_event.payload else {
            panic!("expected agent turn input")
        };
        assert_eq!(agent.provenance, TurnInputProvenance::Agent);
        assert_eq!(agent.run_id.unwrap().as_str(), "run-9");
        assert_eq!(agent.thread_id.as_str(), "child-thread");
        assert_eq!(
            agent.content,
            "Investigate verbatim:\n  αβγ\nDo not abbreviate."
        );
    }

    #[tokio::test]
    async fn unknown_neutral_event_round_trips_losslessly() {
        let json = r#"{"version":1,"event_id":"future-1","stream_id":"future-stream","sequence":99,"correlation":{"thread_id":"future-thread","run_id":"future-run"},"timestamp":"2026-07-17T10:13:00Z","semantics":"delta","provider_sequence":812,"type":"future_neutral_event","data":{"nested":{"items":[1,true,null,"x"]},"opaque":"do-not-interpret"}}"#;
        let service = Arc::new(CapturingExecutionService::default());
        let sink = SessionLogEventSink::new("step-execution-unknown", service.clone());

        sink.emit(event_from_json(json)).await.unwrap();

        let log = service.logs().pop().unwrap();
        assert_eq!(log.content, json);
        let stored = event_from_json(&log.content);
        let HarnessEventPayloadV1::Unknown { event_type, data } = stored.payload else {
            panic!("expected unknown event payload")
        };
        assert_eq!(event_type, "future_neutral_event");
        assert_eq!(
            data,
            serde_json::json!({
                "nested": {"items": [1, true, null, "x"]},
                "opaque": "do-not-interpret"
            })
        );
    }

    #[tokio::test]
    async fn persistence_failure_closes_only_the_failed_sequenced_stream() {
        let service = Arc::new(CapturingExecutionService::rejecting());
        let durable_sink: Arc<dyn EventSink> = Arc::new(SessionLogEventSink::new(
            "step-execution-failure",
            service.clone(),
        ));
        let sink = SequencedEventSink::new(Arc::new(EventSequencer::default()), durable_sink);
        let draft = |stream_id: &str| {
            let event = event_from_json(EXACT_EVENT_JSON);
            HarnessEventDraftV1 {
                stream_id: stream_id.into(),
                correlation: event.correlation,
                timestamp: event.timestamp,
                semantics: event.semantics,
                provider_sequence: event.provider_sequence,
                payload: event.payload,
            }
        };

        let first_error = sink.emit(draft("failed-stream")).await.unwrap_err();
        assert!(matches!(first_error, HarnessError::EventSink(_)));
        assert!(
            first_error
                .to_string()
                .contains("simulated transport failure")
        );
        assert!(first_error.to_string().contains("step-execution-failure"));
        assert!(service.logs().is_empty());

        let closed_error = sink.emit(draft("failed-stream")).await.unwrap_err();
        assert!(matches!(closed_error, HarnessError::EventSink(_)));
        assert!(
            closed_error
                .to_string()
                .contains("closed after a prior dispatch failure")
        );
        assert!(service.logs().is_empty());

        let persisted = sink.emit(draft("usable-stream")).await.unwrap();
        assert_eq!(persisted.sequence, 1);
        let logs = service.logs();
        assert_eq!(logs.len(), 1);
        assert_eq!(
            event_from_json(&logs[0].content).stream_id.as_str(),
            "usable-stream"
        );
    }
}
