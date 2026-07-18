use std::collections::HashSet;

use serde_json::{Map, Value};
use vertebrae_harness_core::{
    AgentMetadata, DiagnosticEvent, HarnessEventDraftV1, HarnessEventPayloadV1, ThreadDeclared,
    ThreadId, ThreadKind, ToolCallId, UpdateSemantics,
};

use super::{
    BufferedAgentRecord, BufferedRootRecord, ClaudeDecodeError, ClaudeStreamDecoder,
    MAX_PENDING_AGENT_RECORDS, MAX_PENDING_ROOT_RECORDS,
};
use super::{agent_metadata, provider_thread_ref, string};

impl ClaudeStreamDecoder {
    pub(super) fn should_buffer_root(
        &mut self,
        object: &Map<String, Value>,
    ) -> Result<bool, ClaudeDecodeError> {
        if self.root_declared {
            return Ok(false);
        }
        let is_init =
            string(object, "type") == Some("system") && string(object, "subtype") == Some("init");
        if is_init {
            let conversation_id = string(object, "session_id")
                .or_else(|| string(object, "uuid"))
                .ok_or_else(|| {
                    ClaudeDecodeError::Malformed(
                        "Claude init has no canonical session_id or uuid".into(),
                    )
                })?
                .to_owned();
            let session_id = super::SessionId::new(conversation_id.clone());
            self.context.session_id = Some(session_id.clone());
            self.context.root_thread_id = ThreadId::new(conversation_id.clone());
            self.context.provider_resume_id = Some(super::ProviderResumeId::new(conversation_id));
            self.root_init_seen = true;
            self.root_locator = provider_thread_ref(object).or_else(|| self.root_locator.clone());
            if self.root_locator.is_none()
                && let Some(resolver) = &self.root_locator_resolver
            {
                self.root_locator = resolver
                    .resolve(&session_id)
                    .map_err(ClaudeDecodeError::RootLocator)?;
            }
            return Ok(true);
        }
        if self.root_init_seen {
            if let Some(locator) = provider_thread_ref(object) {
                self.root_locator = Some(locator);
            }
            return Ok(true);
        }
        Ok(false)
    }

    pub(super) fn buffer_root_record(
        &mut self,
        value: Value,
        provider_sequence: u64,
    ) -> Result<(), ClaudeDecodeError> {
        if self.pending_root_records.len() >= MAX_PENDING_ROOT_RECORDS {
            return Err(ClaudeDecodeError::RootLocator(format!(
                "unresolved-root buffer exceeded {MAX_PENDING_ROOT_RECORDS} records"
            )));
        }
        self.pending_root_records.push_back(BufferedRootRecord {
            value,
            provider_sequence,
        });
        Ok(())
    }

    pub(super) fn flush_root_records(
        &mut self,
    ) -> Result<Vec<HarnessEventDraftV1>, ClaudeDecodeError> {
        if self.root_locator.is_none() || !self.root_init_seen {
            return Ok(Vec::new());
        }
        let mut records = self.pending_root_records.drain(..).collect::<Vec<_>>();
        records.sort_by_key(|record| record.provider_sequence);
        let mut drafts = Vec::new();
        for record in records {
            drafts.extend(self.decode_canonical_value(record.value, record.provider_sequence)?);
        }
        Ok(drafts)
    }

    pub(super) fn agent_is_resolvable(&self, agent_id: &str) -> bool {
        let Some(spawn_id) = self.agent_spawn_tools.get(agent_id) else {
            return false;
        };
        self.agent_locators.contains_key(agent_id) && self.spawn_tools.contains_key(spawn_id)
    }

    pub(super) fn buffer_agent_record(
        &mut self,
        value: Value,
        provider_sequence: u64,
        agent_id: String,
    ) -> Vec<HarnessEventDraftV1> {
        let mut drafts = Vec::new();
        if self.pending_agent_records.len() >= MAX_PENDING_AGENT_RECORDS {
            self.pending_agent_records.pop_front();
            let root = self.context.root_thread_id.clone();
            drafts.push(self.draft(
                self.context.root_stream_id.clone(),
                &root,
                None,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::Warning(DiagnosticEvent {
                    message: format!(
                        "Claude unresolved-agent buffer exceeded {MAX_PENDING_AGENT_RECORDS} records; oldest record was discarded"
                    ),
                    code: Some("claude_agent_buffer_overflow".into()),
                }),
            ));
        }
        self.pending_agent_records.push_back(BufferedAgentRecord {
            value,
            provider_sequence,
            agent_id,
        });
        drafts
    }

    pub(super) fn flush_resolvable_agents(
        &mut self,
    ) -> Result<Vec<HarnessEventDraftV1>, ClaudeDecodeError> {
        let agents = self
            .pending_agent_records
            .iter()
            .map(|record| record.agent_id.clone())
            .filter(|agent_id| self.agent_is_resolvable(agent_id))
            .collect::<HashSet<_>>();
        let mut drafts = Vec::new();
        for agent_id in agents {
            drafts.extend(self.flush_agent(&agent_id)?);
        }
        Ok(drafts)
    }

    pub(super) fn flush_agent(
        &mut self,
        agent_id: &str,
    ) -> Result<Vec<HarnessEventDraftV1>, ClaudeDecodeError> {
        if !self.agent_is_resolvable(agent_id) {
            return Ok(Vec::new());
        }
        let mut records = Vec::new();
        self.pending_agent_records.retain(|record| {
            if record.agent_id == agent_id {
                records.push(record.clone());
                false
            } else {
                true
            }
        });
        records.sort_by_key(|record| record.provider_sequence);
        let mut drafts = Vec::new();
        for record in records {
            drafts.extend(self.decode_canonical_value(record.value, record.provider_sequence)?);
        }
        Ok(drafts)
    }

    pub fn unresolved_agent_diagnostics(&mut self) -> Vec<HarnessEventDraftV1> {
        if self.pending_agent_records.is_empty() {
            return Vec::new();
        }
        let count = self.pending_agent_records.len();
        self.pending_agent_records.clear();
        let root = self.context.root_thread_id.clone();
        vec![self.draft(
            self.context.root_stream_id.clone(),
            &root,
            None,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::Warning(DiagnosticEvent {
                message: format!(
                    "discarded {count} unresolved Claude agent record(s) without canonical spawn lineage and provider locator"
                ),
                code: Some("claude_unresolved_agent".into()),
            }),
        )]
    }

    pub fn unresolved_diagnostics(&mut self) -> Vec<HarnessEventDraftV1> {
        let mut drafts = Vec::new();
        if !self.pending_root_records.is_empty() {
            let count = self.pending_root_records.len();
            self.pending_root_records.clear();
            let root = self.context.root_thread_id.clone();
            drafts.push(self.draft(
                self.context.root_stream_id.clone(),
                &root,
                None,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::Warning(DiagnosticEvent {
                    message: format!(
                        "discarded {count} Claude root record(s) without a canonical provider locator"
                    ),
                    code: Some("claude_unresolved_root_locator".into()),
                }),
            ));
        }
        drafts.extend(self.unresolved_agent_diagnostics());
        drafts
    }

    pub(super) fn resolve_thread(
        &mut self,
        object: &Map<String, Value>,
        agent_id: Option<&str>,
        parent_tool_call: Option<&ToolCallId>,
    ) -> (ThreadId, super::StreamId, Option<ThreadDeclared>) {
        let Some(agent_id) = agent_id else {
            return (
                self.context.root_thread_id.clone(),
                self.context.root_stream_id.clone(),
                None,
            );
        };
        let thread_id = self
            .agent_threads
            .entry(agent_id.to_owned())
            .or_insert_with(|| ThreadId::new(agent_id))
            .clone();
        let stream_id = super::StreamId::new(format!(
            "{}/agent/{agent_id}",
            self.context.root_stream_id.as_str()
        ));
        if !self.declared_threads.insert(thread_id.clone()) {
            return (thread_id, stream_id, None);
        }
        let spawn_id = self
            .agent_spawn_tools
            .get(agent_id)
            .or(parent_tool_call)
            .expect("resolvable agent has spawn id");
        let spawn = self
            .spawn_tools
            .get(spawn_id)
            .expect("resolvable agent has spawn record");
        let parent_thread_id = spawn.parent_thread_id.clone();
        let metadata = if spawn.metadata != AgentMetadata::default() {
            Some(spawn.metadata.clone())
        } else {
            Some(agent_metadata(object)).filter(|metadata| metadata != &AgentMetadata::default())
        };
        (
            thread_id.clone(),
            stream_id,
            Some(ThreadDeclared {
                thread_id,
                parent_thread_id: Some(parent_thread_id),
                kind: ThreadKind::Subagent,
                caused_by_tool_call_id: Some(spawn.tool_call_id.clone()),
                provider_thread_ref: self.agent_locators.get(agent_id).cloned(),
                agent_metadata: metadata,
            }),
        )
    }
}
