//! Runtime harness selection for workflow steps.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Shared harness runtimes selectable for an individual workflow step.
///
/// This is separate from model/provider and request configuration: the
/// harness selects the runtime adapter, while model and request settings
/// remain in their existing configuration objects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepHarness {
    Claude,
    Codex,
    Typesafe,
}

impl StepHarness {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Typesafe => "typesafe",
        }
    }
}

impl fmt::Display for StepHarness {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::StepHarness;

    #[test]
    fn step_harness_uses_exact_wire_values_and_rejects_unknown_values() {
        for (harness, wire) in [
            (StepHarness::Claude, "claude"),
            (StepHarness::Codex, "codex"),
            (StepHarness::Typesafe, "typesafe"),
        ] {
            assert_eq!(
                serde_json::to_string(&harness).unwrap(),
                format!("\"{wire}\"")
            );
            assert_eq!(
                serde_json::from_str::<StepHarness>(&format!("\"{wire}\"")).unwrap(),
                harness
            );
            assert_eq!(harness.as_str(), wire);
        }

        assert!(serde_json::from_str::<StepHarness>("\"openai\"").is_err());
        assert!(serde_json::from_str::<StepHarness>("\"future\"").is_err());
    }
}
