use std::collections::HashSet;
use std::sync::Mutex;

use serde_json::Value;

use crate::{is_known_notification, optional_string};

#[derive(Default)]
pub(crate) struct OwnedThreads {
    ids: Mutex<HashSet<String>>,
}

impl OwnedThreads {
    pub(crate) fn insert(&self, thread_id: impl Into<String>) {
        self.ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(thread_id.into());
    }

    /// The daemon broadcasts `thread/started` and `thread/status/changed` for
    /// every thread, including the user's own Codex sessions; other
    /// notifications reach only connections subscribed to the thread. Admit a
    /// broadcast only for an owned thread or a child of one, and drop unknown
    /// notifications that name no thread, so an idle session's queue cannot
    /// fill with foreign traffic and stall request responses.
    pub(crate) fn admits(&self, method: &str, params: &Value) -> bool {
        let thread_id = optional_string(params, &["/threadId", "/thread/id"]);
        if !matches!(method, "thread/started" | "thread/status/changed") {
            return thread_id.is_some() || is_known_notification(method);
        }
        let Some(thread_id) = thread_id else {
            return false;
        };
        let mut ids = self
            .ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if ids.contains(&thread_id) {
            return true;
        }
        let parent = optional_string(params, &["/parentThreadId", "/thread/parentThreadId"]);
        if parent.is_some_and(|parent| ids.contains(&parent)) {
            ids.insert(thread_id);
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn owned_threads_drop_foreign_broadcasts_and_admit_owned_children() {
        let owned = OwnedThreads::default();
        owned.insert("root-thread");

        assert!(owned.admits("thread/status/changed", &json!({"threadId": "root-thread"})));
        assert!(!owned.admits("thread/status/changed", &json!({"threadId": "foreign"})));
        assert!(!owned.admits("thread/started", &json!({"thread": {"id": "foreign"}})));
        assert!(owned.admits(
            "thread/started",
            &json!({"thread": {"id": "child", "parentThreadId": "root-thread"}})
        ));
        assert!(owned.admits("thread/status/changed", &json!({"threadId": "child"})));
        assert!(owned.admits("item/started", &json!({"threadId": "child"})));
        assert!(owned.admits("turn/completed", &json!({"turn": {"status": "completed"}})));
        assert!(!owned.admits("account/rateLimits/updated", &json!({})));
    }
}
