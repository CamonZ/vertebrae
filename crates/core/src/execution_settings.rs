//! Provider-neutral execution settings shared by persisted workflow config
//! and provider request adapters.

use serde::{Deserialize, Serialize};

/// Serving speed requested for one workflow execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeedTier {
    /// Preserve the provider's normal serving behavior.
    Default,
    /// Prefer the provider's low-latency serving tier when available.
    Fast,
}

impl SpeedTier {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "default" => Some(Self::Default),
            "fast" => Some(Self::Fast),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Fast => "fast",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Default => "Standard",
            Self::Fast => "Fast",
        }
    }
}

/// Output-detail setting supported by the OpenAI Responses API and Codex.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputVerbosity {
    Low,
    Medium,
    High,
}

impl OutputVerbosity {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{OutputVerbosity, SpeedTier};

    #[test]
    fn parses_shared_execution_settings_case_insensitively() {
        assert_eq!(SpeedTier::parse(" FAST "), Some(SpeedTier::Fast));
        assert_eq!(
            OutputVerbosity::parse(" Medium "),
            Some(OutputVerbosity::Medium)
        );
        assert_eq!(OutputVerbosity::parse("verbose"), None);
    }

    #[test]
    fn serializes_wire_names() {
        assert_eq!(serde_json::to_string(&SpeedTier::Fast).unwrap(), "\"fast\"");
        assert_eq!(
            serde_json::to_string(&OutputVerbosity::High).unwrap(),
            "\"high\""
        );
    }
}
