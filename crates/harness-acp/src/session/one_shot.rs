use super::{PromptMode, SessionClient, wait_for_signal};
use crate::{AcpRuntime, protocol::operation};
use async_trait::async_trait;
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use std::sync::Arc;
use tokio::sync::watch;
use vertebrae_harness_core::{
    CompletionStatus, EventCorrelation, EventSequencer, EventSink, HarnessError,
    HarnessEventDraftV1, HarnessEventPayloadV1, RequestConfig, RunHandle, RunId, RunOutcome,
    RunRequest, SequencedEventSink, ThreadId, TurnInput, TurnInputProvenance, TurnSettings,
    UpdateSemantics,
};

struct Run {
    id: RunId,
    cancel: watch::Sender<bool>,
    result: Shared<BoxFuture<'static, Result<RunOutcome, String>>>,
}

#[async_trait]
impl RunHandle for Run {
    fn run_id(&self) -> &RunId {
        &self.id
    }

    async fn cancel(&self) -> Result<(), HarnessError> {
        self.cancel.send_replace(true);
        Ok(())
    }

    async fn await_outcome(&self) -> Result<RunOutcome, HarnessError> {
        self.result.clone().await.map_err(operation)
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}

pub(crate) fn run_once(
    mut runtime: AcpRuntime,
    request: RunRequest,
    events: Arc<dyn EventSink>,
) -> Result<Arc<dyn RunHandle>, HarnessError> {
    let RunRequest {
        run_id,
        stream_id,
        prompt,
        mut config,
    } = request;
    let directory = config.working_directory.take();
    let settings = TurnSettings {
        model: config.model.take(),
        reasoning_effort: config.reasoning_effort.take(),
        speed_tier: config.speed_tier.take(),
        ..Default::default()
    };
    config.environment.append(&mut runtime.environment);
    runtime.environment = std::mem::take(&mut config.environment);
    if config != RequestConfig::default() {
        return Err(HarnessError::Unsupported(
            "ACP workflows do not support read-only mode, structured output, personality, verbosity, or developer instructions".into(),
        ));
    }
    if prompt.trim().is_empty() {
        return Err(HarnessError::InvalidRequest("ACP prompt is empty".into()));
    }
    let (cancel, mut cancelled) = watch::channel(false);
    let thread_id = ThreadId::new(run_id.as_str());
    let correlation = EventCorrelation {
        run_id: Some(run_id.clone()),
        thread_id: Some(thread_id.clone()),
        ..Default::default()
    };
    let sequenced = Arc::new(SequencedEventSink::new(
        Arc::new(EventSequencer::default()),
        events,
    ));
    let task = tokio::spawn(async move {
        let execution = async {
            if *cancelled.borrow() {
                return Ok((CompletionStatus::Cancelled, String::new()));
            }
            let opened = runtime.open(directory, None, None, Some(&mut cancelled)).await;
            let (process, session) = match opened {
                Ok(opened) => opened,
                Err(_) if *cancelled.borrow() => return Ok((CompletionStatus::Cancelled, String::new())),
                Err(error) => return Err(operation(format!("Could not start ACP workflow agent: {error}"))),
            };
            let mut client = SessionClient {
                process,
                agent_session: session.id,
                config: session.config,
                next_id: 2,
                stream: stream_id.clone(),
                events: sequenced.clone(),
            };
            let result = async {
                if let Some(usage) = session.initial_usage {
                    client.emit(usage, UpdateSemantics::Snapshot, &correlation).await?;
                }
                tokio::select! {
                    biased;
                    _ = wait_for_signal(&mut cancelled) => return Ok((CompletionStatus::Cancelled, String::new())),
                    result = client.apply_settings(&settings) => result?,
                };
                client.emit(
                    HarnessEventPayloadV1::TurnInput(TurnInput {
                        thread_id,
                        run_id: correlation.run_id.clone(),
                        content: prompt.clone(),
                        provenance: TurnInputProvenance::Human,
                    }),
                    UpdateSemantics::Snapshot,
                    &correlation,
                ).await?;
                if *cancelled.borrow() {
                    return Ok((CompletionStatus::Cancelled, String::new()));
                }
                client.prompt(&prompt, &mut cancelled, &correlation, PromptMode::OneShot).await
            }.await;
            let interrupted = *cancelled.borrow();
            if !interrupted && session.supports_close && matches!(result, Ok((CompletionStatus::Completed, _))) {
                client.close().await;
            }
            client.process.reap().await;
            if interrupted { Ok((CompletionStatus::Cancelled, String::new())) } else { result }
        }.await;
        let (status, result_text, error) = match execution {
            Ok((CompletionStatus::Cancelled, _)) => (CompletionStatus::Cancelled, None, None),
            Ok((status, text)) => (status, Some(text), None),
            Err(error) => (CompletionStatus::Failed, None, Some(error.to_string())),
        };
        let outcome = RunOutcome {
            status,
            result_text,
            structured_output: None,
            usage: None,
            metrics: Default::default(),
            error,
        };
        let mut terminal = HarnessEventDraftV1::new(
            stream_id,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::RunFinished(outcome.clone()),
        );
        terminal.correlation = correlation;
        let delivered = sequenced.emit(terminal).await.map(|_| outcome);
        delivered.map_err(|error| error.to_string())
    });
    Ok(Arc::new(Run {
        id: run_id,
        cancel,
        result: async move { task.await.map_err(|error| error.to_string())? }
            .boxed()
            .shared(),
    }))
}
