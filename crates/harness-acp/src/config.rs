use serde::Deserialize;
use serde_json::{Value, json};
use vertebrae_harness_core::{HarnessError, PermissionMode, TurnSettings};

use crate::protocol::{Process, operation};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Choice {
    pub value: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
enum Entry {
    Choice(Choice),
    Group { options: Vec<Choice> },
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Select {
    id: String,
    category: Option<String>,
    current_value: String,
    options: Vec<Entry>,
}

impl Select {
    fn choices(&self) -> impl Iterator<Item = &Choice> {
        self.options.iter().flat_map(|entry| match entry {
            Entry::Choice(choice) => std::slice::from_ref(choice),
            Entry::Group { options } => options,
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionConfig(Vec<Select>);

pub struct Discovery {
    pub config: SessionConfig,
    pub model_options: Vec<(String, SessionConfig)>,
    pub supports_steering: bool,
    pub supports_resume: bool,
}

impl SessionConfig {
    pub(crate) fn replace(&mut self, payload: &Value) {
        if let Some(options) = payload["configOptions"].as_array() {
            self.0 = options
                .iter()
                .filter(|option| option["type"] == "select")
                .filter_map(|option| serde_json::from_value(option.clone()).ok())
                .collect();
        }
    }

    fn select(&self, category: &str) -> Option<&Select> {
        self.0.iter().find(|option| {
            option.category.as_deref() == Some(category)
                || option.id == category
                || (category == "speed" && option.id == "speed_tier")
        })
    }

    pub fn choices(&self, category: &str) -> impl Iterator<Item = &Choice> {
        self.select(category).into_iter().flat_map(Select::choices)
    }

    pub fn current(&self, category: &str) -> Option<&str> {
        self.select(category)
            .map(|option| option.current_value.as_str())
    }

    pub fn permission_modes(&self) -> impl Iterator<Item = (PermissionMode, &Choice)> {
        self.choices("mode").filter_map(|choice| {
            let mode = match choice.value.as_str() {
                "default" => PermissionMode::Default,
                "accept-edits" | "acceptEdits" | "auto_edit" => PermissionMode::AcceptEdits,
                "auto" => PermissionMode::Auto,
                "plan" => PermissionMode::Plan,
                "yolo" | "bypassPermissions" => PermissionMode::BypassPermissions,
                "dontAsk" => PermissionMode::DontAsk,
                _ => return None,
            };
            Some((mode, choice))
        })
    }

    pub(crate) async fn set(
        &mut self,
        process: &mut Process,
        id: u64,
        session: &str,
        category: &str,
        value: &str,
    ) -> Result<(), HarnessError> {
        let option = self.select(category).ok_or_else(|| {
            HarnessError::InvalidRequest(format!(
                "ACP agent does not advertise a {category} setting"
            ))
        })?;
        if !option.choices().any(|choice| choice.value == value) {
            return Err(HarnessError::InvalidRequest(format!(
                "ACP agent did not offer the selected {category} value"
            )));
        }
        if option.current_value == value {
            return Ok(());
        }
        let response = process
            .request(
                id,
                "session/set_config_option",
                json!({"sessionId":session, "configId":option.id, "value":value}),
            )
            .await?;
        self.replace(&response);
        if self.current(category) != Some(value) {
            return Err(operation(format!(
                "ACP agent did not confirm the {category} change"
            )));
        }
        Ok(())
    }

    pub(crate) async fn apply(
        &mut self,
        process: &mut Process,
        id: &mut u64,
        session: &str,
        settings: &TurnSettings,
    ) -> Result<(), HarnessError> {
        for (category, value) in [
            ("model", settings.model.as_deref()),
            ("thought_level", settings.reasoning_effort.as_deref()),
            (
                "speed",
                settings
                    .speed_tier
                    .filter(|tier| {
                        *tier != vertebrae_harness_core::SpeedTier::Default
                            || self.select("speed").is_some()
                    })
                    .map(|tier| tier.as_str()),
            ),
        ] {
            if let Some(value) = value {
                *id += 1;
                self.set(process, *id, session, category, value).await?;
            }
        }
        if let Some(mode) = &settings.permission_mode {
            let value = self
                .permission_modes()
                .find(|(candidate, _)| candidate == mode)
                .map(|(_, choice)| choice.value.clone());
            if let Some(value) = value {
                *id += 1;
                self.set(process, *id, session, "mode", &value).await?;
            } else if *mode != PermissionMode::Default {
                return Err(HarnessError::InvalidRequest(
                    "ACP agent did not offer the selected permission mode".into(),
                ));
            }
        }
        Ok(())
    }
}

pub(crate) fn supports_steering(initialized: &Value) -> bool {
    let info = &initialized["agentInfo"];
    // Antigravity began treating concurrent prompts as steering in version 1.5.
    info["name"] == "Antigravity ACP Server"
        && info["version"]
            .as_str()
            .and_then(|version| {
                let mut parts = version.split('.');
                Some((
                    parts.next()?.parse::<u32>().ok()?,
                    parts.next()?.parse::<u32>().ok()?,
                ))
            })
            .is_some_and(|version| version >= (1, 5))
}
