use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::protocol::{
    collab_agent_identity_keys, collab_receiver_thread_id_strings, is_error_child_status,
    is_terminal_child_status,
};

#[derive(Default)]
pub(super) struct CodexThreadState {
    pub(super) child_thread_parents: HashMap<String, String>,
    parent_child_threads: HashMap<String, HashSet<String>>,
    parent_child_statuses: HashMap<String, HashMap<String, String>>,
    child_turn_results: HashMap<ChildTurnKey, String>,
    emitted_synthetic_spawn_tool_ids: HashSet<String>,
    completed_parent_spawn_tool_ids: HashSet<String>,
}

impl CodexThreadState {
    pub(super) fn remember_child_thread_parents(&mut self, item: &Value, tool_id: &str) {
        let child_keys = collab_agent_identity_keys(item);
        let is_spawn_agent = item
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("spawnAgent")
            == "spawnAgent";
        if is_spawn_agent {
            let child_thread_ids = collab_receiver_thread_id_strings(item);
            if !child_thread_ids.is_empty() {
                self.parent_child_threads
                    .entry(tool_id.to_string())
                    .or_default()
                    .extend(child_thread_ids);
            }
        }
        for child_key in child_keys {
            if is_spawn_agent {
                self.child_thread_parents
                    .insert(child_key, tool_id.to_string());
            } else {
                self.child_thread_parents
                    .entry(child_key)
                    .or_insert_with(|| tool_id.to_string());
            }
        }
    }

    pub(super) fn parent_tool_use_id_for_notification(&self, params: &Value) -> Option<String> {
        collab_agent_identity_keys(params)
            .into_iter()
            .find_map(|key| self.child_thread_parents.get(&key).cloned())
    }

    pub(super) fn ensure_parent_for_child_notification(
        &mut self,
        params: &Value,
    ) -> Option<SyntheticSpawnParent> {
        if let Some(tool_id) = self.parent_tool_use_id_for_notification(params) {
            return Some(SyntheticSpawnParent {
                tool_id,
                should_emit: false,
            });
        }

        let keys = collab_agent_identity_keys(params);
        let agent_key = keys.first()?.to_string();
        let tool_id = format!("agent:{agent_key}");
        for key in keys {
            self.child_thread_parents
                .entry(key)
                .or_insert_with(|| tool_id.clone());
        }
        let should_emit = self
            .emitted_synthetic_spawn_tool_ids
            .insert(tool_id.clone());
        Some(SyntheticSpawnParent {
            tool_id,
            should_emit,
        })
    }

    pub(super) fn remember_child_turn_result(
        &mut self,
        thread_id: &str,
        turn_id: Option<&str>,
        text: String,
    ) {
        self.child_turn_results
            .insert(ChildTurnKey::new(thread_id, turn_id), text);
    }

    pub(super) fn take_child_turn_result(
        &mut self,
        thread_id: &str,
        turn_id: Option<&str>,
    ) -> Option<String> {
        self.child_turn_results
            .remove(&ChildTurnKey::new(thread_id, turn_id))
            .or_else(|| {
                if turn_id.is_some() {
                    self.child_turn_results
                        .remove(&ChildTurnKey::new(thread_id, None))
                } else {
                    None
                }
            })
    }

    pub(super) fn record_child_thread_status(
        &mut self,
        parent_tool_use_id: &str,
        thread_id: &str,
        status: &str,
    ) -> Option<bool> {
        self.parent_child_threads
            .entry(parent_tool_use_id.to_string())
            .or_default()
            .insert(thread_id.to_string());
        self.parent_child_statuses
            .entry(parent_tool_use_id.to_string())
            .or_default()
            .insert(thread_id.to_string(), status.to_string());
        if !is_terminal_child_status(status) {
            return None;
        }
        let child_threads = self.parent_child_threads.get(parent_tool_use_id)?;
        let statuses = self.parent_child_statuses.get(parent_tool_use_id)?;
        let all_terminal = child_threads.iter().all(|thread_id| {
            statuses
                .get(thread_id)
                .is_some_and(|status| is_terminal_child_status(status))
        });
        if !all_terminal {
            return None;
        }
        if !self
            .completed_parent_spawn_tool_ids
            .insert(parent_tool_use_id.to_string())
        {
            return None;
        }
        Some(
            statuses
                .values()
                .any(|status| is_error_child_status(status)),
        )
    }
}

#[derive(Hash, Eq, PartialEq)]
pub(super) struct ChildTurnKey {
    thread_id: String,
    turn_id: String,
}

impl ChildTurnKey {
    fn new(thread_id: &str, turn_id: Option<&str>) -> Self {
        Self {
            thread_id: thread_id.to_string(),
            turn_id: turn_id.unwrap_or_default().to_string(),
        }
    }
}

pub(super) struct SyntheticSpawnParent {
    pub(super) tool_id: String,
    pub(super) should_emit: bool,
}
