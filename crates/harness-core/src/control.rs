use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ControlRequestId, SessionId, TurnId};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalCategory {
    CommandExecution,
    FileChange,
    NetworkAccess,
    AdditionalPermission,
    Other(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantScope {
    Turn,
    Session,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub category: ApprovalCategory,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    pub modification_supported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionGrantRequest {
    pub permissions: Vec<String>,
    pub scope_supported: Vec<GrantScope>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserQuestion {
    pub id: String,
    pub prompt: String,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    pub multiple: bool,
    pub free_form: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum ControlRequest {
    Approval(ApprovalRequest),
    PermissionGrant(PermissionGrantRequest),
    UserQuestion { questions: Vec<UserQuestion> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuestionAnswer {
    pub question_id: String,
    #[serde(default)]
    pub selected_option_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free_form: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "decision", content = "data", rename_all = "snake_case")]
pub enum ControlDecision {
    AllowOnce,
    AllowForSession,
    Deny,
    Cancel,
    Modified(Value),
    PermissionsGranted {
        permissions: Vec<String>,
        scope: GrantScope,
    },
    QuestionsAnswered(Vec<QuestionAnswer>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlRequestEnvelope {
    pub request_id: ControlRequestId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub request: ControlRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automatic_resolution: Option<ControlDecision>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionSource {
    Consumer,
    Provider,
    Timeout,
    Interrupted,
    Cancelled,
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlResolution {
    pub request_id: ControlRequestId,
    pub source: ResolutionSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<ControlDecision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
