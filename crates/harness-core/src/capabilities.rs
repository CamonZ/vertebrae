use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::ApprovalCategory;
pub use vertebrae_core::{OutputVerbosity, SpeedTier};

/// Provider-reported speed state for a started session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpeedTierStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested: Option<SpeedTier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<SpeedTier>,
    pub eligible: bool,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

/// A provider model exposed during harness discovery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCapability {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub reasoning_efforts: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub supported_speed_tiers: BTreeSet<SpeedTier>,
    /// Whether this model exposes provider personality instructions. `None`
    /// means the installed provider did not report the capability.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_personality: Option<bool>,
}

/// A permission policy exposed by a provider during capability discovery.
///
/// The id is intentionally opaque to the provider-neutral contract. Surface
/// crates can map it to their local input type while still rendering the
/// provider's live catalog and preserving unknown values safely.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionModeCapability {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub is_default: bool,
}

/// User-question features supported by a provider adapter.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionCapabilities {
    pub multiple_selection: bool,
    pub free_form_answers: bool,
    pub automatic_resolution: bool,
}

/// Versioned, provider-neutral capabilities discovered at runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HarnessCapabilities {
    pub provider: String,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    pub persistent_sessions: bool,
    pub one_shot_runs: bool,
    pub session_resumption: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default)]
    pub models: Vec<ModelCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_permission_mode: Option<String>,
    #[serde(default)]
    pub permission_modes: Vec<PermissionModeCapability>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub approval_categories: BTreeSet<ApprovalCategory>,
    pub questions: QuestionCapabilities,
}
