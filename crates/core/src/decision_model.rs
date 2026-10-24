//! Optional machine-wide model selection for background decisions.
use crate::ProviderId;
use serde::{Deserialize, Serialize};

/// References an existing provider; credentials and harness settings stay with it.
/// Disabled by default. Validation is deferred until this optional role is used.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DecisionModelConfig {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl DecisionModelConfig {
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
}
