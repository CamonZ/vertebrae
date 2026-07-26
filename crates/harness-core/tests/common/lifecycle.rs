#![allow(dead_code)]

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use tokio::sync::Notify;
use vertebrae_harness_core::{
    CompletionStatus, EventSink, HarnessError, HarnessEventPayloadV1, HarnessEventV1, TurnHandle,
    TurnId, TurnOutcome,
};

#[derive(Default)]
pub struct LifecycleProbeSink {
    events: Mutex<Vec<HarnessEventV1>>,
    terminal_entered: Notify,
    terminal_release: Notify,
}

#[async_trait]
impl EventSink for LifecycleProbeSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        if matches!(event.payload, HarnessEventPayloadV1::TurnFinished(_)) {
            self.terminal_entered.notify_one();
            self.terminal_release.notified().await;
        }
        self.events.lock().unwrap().push(event);
        Ok(())
    }
}

impl LifecycleProbeSink {
    pub async fn wait_until_terminal_dispatch(&self) {
        tokio::time::timeout(Duration::from_secs(2), self.terminal_entered.notified())
            .await
            .expect("expected a TurnFinished dispatch attempt");
    }

    pub async fn assert_outcome_pending(&self, turn: &Arc<dyn TurnHandle>) {
        assert!(
            tokio::time::timeout(Duration::from_millis(20), turn.await_outcome())
                .await
                .is_err(),
            "outcome became observable before TurnFinished dispatch completed"
        );
    }

    pub fn release_terminal(&self) {
        self.terminal_release.notify_one();
    }

    pub fn events(&self) -> Vec<HarnessEventV1> {
        self.events.lock().unwrap().clone()
    }

    pub async fn await_ordered_outcome(
        &self,
        turn: &Arc<dyn TurnHandle>,
        expected_status: CompletionStatus,
    ) -> TurnOutcome {
        self.wait_until_terminal_dispatch().await;
        self.assert_outcome_pending(turn).await;
        self.release_terminal();
        let outcome = turn.await_outcome().await.expect("turn outcome");
        assert_eq!(outcome.status, expected_status);
        assert_balanced_turn(&self.events(), turn.turn_id().as_str(), &outcome);
        outcome
    }
}

pub fn assert_balanced_turn(
    events: &[HarnessEventV1],
    turn_id: &str,
    expected_outcome: &TurnOutcome,
) {
    let turn_id = TurnId::from(turn_id);
    let starts = correlated(events, &turn_id, |payload| {
        matches!(payload, HarnessEventPayloadV1::TurnStarted(_))
    });
    let finishes = correlated(events, &turn_id, |payload| {
        matches!(payload, HarnessEventPayloadV1::TurnFinished(_))
    });

    assert_eq!(starts.len(), 1, "expected one correlated TurnStarted");
    assert_eq!(finishes.len(), 1, "expected one correlated TurnFinished");
    let start = starts[0];
    let finish = finishes[0];
    assert_eq!(start.stream_id, finish.stream_id);
    assert_eq!(start.correlation.session_id, finish.correlation.session_id);
    assert_eq!(start.correlation.thread_id, finish.correlation.thread_id);
    assert_eq!(start.correlation.turn_id.as_ref(), Some(&turn_id));
    assert_eq!(finish.correlation.turn_id.as_ref(), Some(&turn_id));
    assert!(
        start.sequence < finish.sequence,
        "TurnStarted must precede TurnFinished"
    );
    assert!(matches!(
        &finish.payload,
        HarnessEventPayloadV1::TurnFinished(outcome) if outcome == expected_outcome
    ));
}

fn correlated<'a>(
    events: &'a [HarnessEventV1],
    turn_id: &TurnId,
    predicate: impl Fn(&HarnessEventPayloadV1) -> bool,
) -> Vec<&'a HarnessEventV1> {
    events
        .iter()
        .filter(|event| {
            event.correlation.turn_id.as_ref() == Some(turn_id) && predicate(&event.payload)
        })
        .collect()
}
