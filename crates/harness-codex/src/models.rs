use std::{collections::BTreeSet, process::Stdio};

use serde::Deserialize;
use tokio::process::Command;
use vertebrae_harness_core::{
    ApprovalCategory, HarnessCapabilities, HarnessError, ModelCapability, PermissionModeCapability,
    QuestionCapabilities,
};

use crate::CodexProviderConfig;

const CODEX_DEFAULT_MODEL_ID: &str = "default";
const CODEX_DEFAULT_MODEL_LABEL: &str = "Codex default";

#[derive(Debug, Deserialize)]
struct CodexModelCatalog {
    models: Vec<CodexCatalogModel>,
}

#[derive(Debug, Deserialize)]
struct CodexCatalogModel {
    slug: String,
    display_name: String,
    visibility: String,
    priority: u32,
    #[serde(default)]
    supported_reasoning_levels: Vec<CodexReasoningLevel>,
}

#[derive(Debug, Deserialize)]
struct CodexReasoningLevel {
    effort: String,
}

pub(crate) async fn discover_capabilities(
    config: &CodexProviderConfig,
) -> Result<HarnessCapabilities, HarnessError> {
    let binary = config.resolve_executable()?;
    let mut command = Command::new(&binary);
    command
        .args(["debug", "models", "--bundled"])
        .envs(config.environment.clone())
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped());
    if let Some(path) = &config.search_path {
        command.env("PATH", path.to_string_lossy().into_owned());
    }

    let output = command.output().await.map_err(|error| {
        HarnessError::Unavailable(format!(
            "failed to query Codex model catalog from {}: {error}",
            binary.display()
        ))
    })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if detail.is_empty() {
            output.status.to_string()
        } else {
            format!("{}: {detail}", output.status)
        };
        return Err(HarnessError::Unavailable(format!(
            "Codex model catalog query failed: {detail}"
        )));
    }

    let output = String::from_utf8(output.stdout).map_err(|error| {
        HarnessError::Unavailable(format!("Codex model catalog was not valid UTF-8: {error}"))
    })?;
    let catalog: CodexModelCatalog = serde_json::from_str(&output).map_err(|error| {
        HarnessError::Unavailable(format!("Invalid Codex model catalog: {error}"))
    })?;

    Ok(capabilities_from_catalog(catalog))
}

fn capabilities_from_catalog(mut catalog: CodexModelCatalog) -> HarnessCapabilities {
    catalog.models.sort_by_key(|model| model.priority);

    let visible_models: Vec<_> = catalog
        .models
        .into_iter()
        .filter(|model| model.visibility == "list")
        .map(|model| {
            let reasoning_efforts = model
                .supported_reasoning_levels
                .into_iter()
                .map(|level| level.effort)
                .collect::<BTreeSet<_>>();
            (model.slug, model.display_name, reasoning_efforts)
        })
        .collect();
    let default_reasoning_efforts = visible_models
        .iter()
        .flat_map(|(_, _, efforts)| efforts.iter().cloned())
        .collect();
    let mut models = vec![ModelCapability {
        id: CODEX_DEFAULT_MODEL_ID.into(),
        label: CODEX_DEFAULT_MODEL_LABEL.into(),
        reasoning_efforts: default_reasoning_efforts,
    }];
    for (id, label, reasoning_efforts) in visible_models {
        models.push(ModelCapability {
            id,
            label,
            reasoning_efforts,
        });
    }

    HarnessCapabilities {
        provider: "openai".into(),
        available: true,
        unavailable_reason: None,
        persistent_sessions: true,
        one_shot_runs: true,
        session_resumption: true,
        default_model: Some(CODEX_DEFAULT_MODEL_ID.into()),
        models,
        default_permission_mode: Some("default".into()),
        permission_modes: vec![
            PermissionModeCapability {
                id: "default".into(),
                label: "Ask for approval".into(),
                is_default: true,
            },
            PermissionModeCapability {
                id: "auto".into(),
                label: "Approve for me".into(),
                is_default: false,
            },
            PermissionModeCapability {
                id: "bypass_permissions".into(),
                label: "Full access".into(),
                is_default: false,
            },
        ],
        approval_categories: [
            ApprovalCategory::CommandExecution,
            ApprovalCategory::FileChange,
            ApprovalCategory::AdditionalPermission,
        ]
        .into_iter()
        .collect(),
        questions: QuestionCapabilities {
            multiple_selection: true,
            free_form_answers: true,
            automatic_resolution: true,
        },
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

    use tempfile::tempdir;
    use vertebrae_harness_core::HarnessRuntime;

    use super::*;

    fn catalog_json() -> &'static str {
        r#"{
          "models": [
            {
              "slug": "hidden-model",
              "display_name": "Hidden model",
              "visibility": "hide",
              "priority": 0,
              "supported_reasoning_levels": [{"effort": "secret"}]
            },
            {
              "slug": "server-model",
              "display_name": "Server model",
              "visibility": "list",
              "priority": 2,
              "supported_reasoning_levels": [
                {"effort": "ultra"},
                {"effort": "medium"}
              ]
            },
            {
              "slug": "earlier-model",
              "display_name": "Earlier model",
              "visibility": "list",
              "priority": 1,
              "supported_reasoning_levels": [{"effort": "ultra"}]
            }
          ]
        }"#
    }

    #[test]
    fn catalog_maps_visible_models_by_priority_and_preserves_efforts() {
        let catalog: CodexModelCatalog = serde_json::from_str(catalog_json()).unwrap();
        let capabilities = capabilities_from_catalog(catalog);

        assert_eq!(
            capabilities
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["default", "earlier-model", "server-model"]
        );
        assert_eq!(
            capabilities.models[2].reasoning_efforts,
            BTreeSet::from(["medium".into(), "ultra".into()])
        );
        assert_eq!(
            capabilities.models[0].reasoning_efforts,
            BTreeSet::from(["medium".into(), "ultra".into()])
        );
        assert!(
            !capabilities
                .models
                .iter()
                .any(|model| model.id == "hidden-model")
        );
    }

    #[tokio::test]
    async fn discovery_uses_the_codex_command_output() {
        let directory = tempdir().unwrap();
        let executable = directory.path().join("codex");
        fs::write(
            &executable,
            format!("#!/bin/sh\nprintf '%s' '{}'\n", catalog_json()),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();

        let capabilities = discover_capabilities(&CodexProviderConfig {
            executable: Some(PathBuf::from(&executable)),
            ..Default::default()
        })
        .await
        .unwrap();

        assert!(capabilities.available);
        assert_eq!(capabilities.models[1].id, "earlier-model");
        assert_eq!(capabilities.models[2].id, "server-model");
        assert_eq!(
            capabilities.models[2].reasoning_efforts,
            BTreeSet::from(["medium".into(), "ultra".into()])
        );
    }

    #[tokio::test]
    async fn runtime_reports_discovery_failure_without_a_static_catalog() {
        let directory = tempdir().unwrap();
        let executable = directory.path().join("codex");
        fs::write(&executable, "#!/bin/sh\nexit 1\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();

        let runtime = crate::CodexRuntime::new(CodexProviderConfig {
            executable: Some(executable),
            ..Default::default()
        });
        let capabilities = runtime.capabilities().await.unwrap();

        assert!(!capabilities.available);
        assert!(capabilities.models.is_empty());
        assert!(capabilities.unavailable_reason.is_some());
    }
}
