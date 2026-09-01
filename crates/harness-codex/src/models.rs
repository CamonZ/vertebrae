use std::{collections::BTreeSet, process::Stdio, sync::Arc};

use async_trait::async_trait;
use serde::Deserialize;
use tokio::process::Command;
use vertebrae_harness_core::{
    ApprovalCategory, ControlRequestEnvelope, ControlResolution, ControlSink, HarnessCapabilities,
    HarnessError, ModelCapability, PermissionModeCapability, QuestionCapabilities, SpeedTier,
};

use crate::{
    CodexProviderConfig,
    launcher::{CodexAppServerLauncher, ProcessCodexAppServerLauncher, cleanup_process},
    runtime::CodexConnection,
};

const CODEX_DEFAULT_MODEL_ID: &str = "default";
const CODEX_DEFAULT_MODEL_LABEL: &str = "Codex default";

#[derive(Debug, Deserialize)]
struct CodexModelCatalog {
    models: Vec<CodexCatalogModel>,
}

#[derive(Debug, Deserialize)]
struct CodexAppServerModelList {
    data: Vec<CodexAppServerModel>,
    #[serde(default, rename = "nextCursor")]
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexAppServerModel {
    id: String,
    model: String,
    display_name: String,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    is_default: bool,
    #[serde(default)]
    supported_reasoning_efforts: Vec<CodexAppServerReasoningEffort>,
    #[serde(default)]
    additional_speed_tiers: Vec<String>,
    #[serde(default)]
    service_tiers: Vec<CodexServiceTier>,
    #[serde(default)]
    supports_personality: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexAppServerReasoningEffort {
    reasoning_effort: String,
}

#[derive(Default)]
struct DiscoveryControlSink;

#[async_trait]
impl ControlSink for DiscoveryControlSink {
    async fn request(
        &self,
        _request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        Err(HarnessError::Operation(
            "Codex capability discovery received an unexpected control request".into(),
        ))
    }
}

#[derive(Debug, Deserialize)]
struct CodexCatalogModel {
    slug: String,
    display_name: String,
    visibility: String,
    priority: u32,
    #[serde(default)]
    supported_reasoning_levels: Vec<CodexReasoningLevel>,
    #[serde(default)]
    supported_service_tiers: Option<Vec<String>>,
    #[serde(default)]
    additional_speed_tiers: Option<Vec<String>>,
    #[serde(default)]
    service_tiers: Option<Vec<CodexServiceTier>>,
    #[serde(default)]
    supports_personality: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct CodexServiceTier {
    id: String,
}

#[derive(Debug, Deserialize)]
struct CodexReasoningLevel {
    effort: String,
}

pub(crate) async fn discover_capabilities(
    config: &CodexProviderConfig,
) -> Result<HarnessCapabilities, HarnessError> {
    match discover_from_app_server(config).await {
        Ok(catalog) => return Ok(capabilities_from_app_server(catalog)),
        Err(app_server_error) => {
            log::debug!(
                "Codex app-server capability discovery failed; trying bundled catalog fallback: {app_server_error}"
            );
        }
    }

    discover_from_bundled_catalog(config).await
}

async fn discover_from_app_server(
    config: &CodexProviderConfig,
) -> Result<Vec<CodexAppServerModel>, HarnessError> {
    let launch_config = config.clone();
    let launcher: Arc<dyn CodexAppServerLauncher> = config
        .launcher
        .clone()
        .unwrap_or_else(|| Arc::new(ProcessCodexAppServerLauncher::new(Arc::new(launch_config))));
    let mut launched = launcher.launch().await?;
    let connection =
        match CodexConnection::connect(&launched.ws_url, Arc::new(DiscoveryControlSink)).await {
            Ok(connection) => connection,
            Err(error) => {
                cleanup_process(&mut launched.process, config.cleanup_timeout).await;
                return Err(error);
            }
        };

    let result = async {
        connection
            .request(
                "initialize",
                serde_json::json!({
                    "clientInfo": {
                        "name": config.client_name,
                        "title": config.client_title,
                        "version": config.client_version
                    },
                    "capabilities": {"experimentalApi": true}
                }),
            )
            .await?;
        connection
            .notify("initialized", serde_json::json!({}))
            .await?;

        let mut cursor = None;
        let mut models = Vec::new();
        loop {
            let params = cursor
                .as_ref()
                .map(|cursor| serde_json::json!({"cursor": cursor}))
                .unwrap_or_else(|| serde_json::json!({}));
            let response = connection.request("model/list", params).await?;
            let page: CodexAppServerModelList =
                serde_json::from_value(response).map_err(|error| {
                    HarnessError::Operation(format!(
                        "Invalid Codex app-server model/list response: {error}"
                    ))
                })?;
            models.extend(page.data);
            match page.next_cursor.filter(|cursor| !cursor.is_empty()) {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        Ok(models)
    }
    .await;

    connection.close().await;
    cleanup_process(&mut launched.process, config.cleanup_timeout).await;
    result
}

async fn discover_from_bundled_catalog(
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

fn capabilities_from_app_server(catalog: Vec<CodexAppServerModel>) -> HarnessCapabilities {
    let mut visible_models: Vec<_> = catalog.into_iter().filter(|model| !model.hidden).collect();
    visible_models.sort_by_key(|model| (!model.is_default, model.model.clone()));

    let default_reasoning_efforts = visible_models
        .iter()
        .flat_map(|model| {
            model
                .supported_reasoning_efforts
                .iter()
                .map(|effort| effort.reasoning_effort.clone())
        })
        .collect();
    let default_speed_tiers = visible_models
        .iter()
        .flat_map(|model| supported_app_server_speed_tiers(model).into_iter())
        .collect();
    let default_supports_personality = aggregate_personality_support(
        visible_models
            .iter()
            .map(|model| model.supports_personality),
    );

    let mut models = vec![ModelCapability {
        id: CODEX_DEFAULT_MODEL_ID.into(),
        label: CODEX_DEFAULT_MODEL_LABEL.into(),
        reasoning_efforts: default_reasoning_efforts,
        supported_speed_tiers: default_speed_tiers,
        supports_personality: default_supports_personality,
    }];
    models.extend(visible_models.into_iter().map(|model| {
        let id = if model.model.is_empty() {
            model.id.clone()
        } else {
            model.model.clone()
        };
        let reasoning_efforts = model
            .supported_reasoning_efforts
            .iter()
            .map(|effort| effort.reasoning_effort.clone())
            .collect();
        let supported_speed_tiers = supported_app_server_speed_tiers(&model);
        ModelCapability {
            id,
            label: model.display_name,
            reasoning_efforts,
            supported_speed_tiers,
            supports_personality: Some(model.supports_personality),
        }
    }));

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

fn aggregate_personality_support(supports: impl IntoIterator<Item = bool>) -> Option<bool> {
    let supports = supports.into_iter().collect::<Vec<_>>();
    if supports.is_empty()
        || (supports.iter().any(|value| *value) && supports.iter().any(|value| !*value))
    {
        None
    } else {
        supports.first().copied()
    }
}

fn supported_app_server_speed_tiers(model: &CodexAppServerModel) -> BTreeSet<SpeedTier> {
    let names = model
        .additional_speed_tiers
        .iter()
        .chain(model.service_tiers.iter().map(|tier| &tier.id));
    let mut tiers = names
        .filter_map(|tier| match tier.as_str() {
            "default" => Some(SpeedTier::Default),
            "fast" | "priority" | "ultrafast" => Some(SpeedTier::Fast),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    if tiers.contains(&SpeedTier::Fast) {
        tiers.insert(SpeedTier::Default);
    }
    tiers
}

fn capabilities_from_catalog(mut catalog: CodexModelCatalog) -> HarnessCapabilities {
    catalog.models.sort_by_key(|model| model.priority);

    let visible_models: Vec<_> = catalog
        .models
        .into_iter()
        .filter(|model| model.visibility == "list")
        .map(|model| {
            let supported_speed_tiers = supported_speed_tiers(&model);
            let reasoning_efforts = model
                .supported_reasoning_levels
                .into_iter()
                .map(|level| level.effort)
                .collect::<BTreeSet<_>>();
            (
                model.slug,
                model.display_name,
                reasoning_efforts,
                supported_speed_tiers,
                model.supports_personality,
            )
        })
        .collect();
    let default_reasoning_efforts = visible_models
        .iter()
        .flat_map(|(_, _, efforts, _, _)| efforts.iter().cloned())
        .collect();
    let default_speed_tiers = visible_models
        .iter()
        .flat_map(|(_, _, _, tiers, _)| tiers.iter().copied())
        .collect();
    let default_supports_personality = if visible_models
        .iter()
        .any(|(_, _, _, _, supports)| *supports == Some(true))
    {
        Some(true)
    } else if visible_models
        .iter()
        .all(|(_, _, _, _, supports)| *supports == Some(false))
        && !visible_models.is_empty()
    {
        Some(false)
    } else {
        None
    };
    let mut models = vec![ModelCapability {
        id: CODEX_DEFAULT_MODEL_ID.into(),
        label: CODEX_DEFAULT_MODEL_LABEL.into(),
        reasoning_efforts: default_reasoning_efforts,
        supported_speed_tiers: default_speed_tiers,
        supports_personality: default_supports_personality,
    }];
    for (id, label, reasoning_efforts, supported_speed_tiers, supports_personality) in
        visible_models
    {
        models.push(ModelCapability {
            id,
            label,
            reasoning_efforts,
            supported_speed_tiers,
            supports_personality,
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

fn supported_speed_tiers(model: &CodexCatalogModel) -> BTreeSet<SpeedTier> {
    let mut tiers = model
        .supported_service_tiers
        .iter()
        .flatten()
        .chain(model.additional_speed_tiers.iter().flatten())
        .chain(model.service_tiers.iter().flatten().map(|tier| &tier.id))
        .filter_map(|tier| match tier.as_str() {
            "default" => Some(SpeedTier::Default),
            "fast" | "priority" => Some(SpeedTier::Fast),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    if tiers.contains(&SpeedTier::Fast) {
        tiers.insert(SpeedTier::Default);
    }
    tiers
}

#[cfg(all(test, unix))]
mod tests {
    use std::{
        fs,
        io::Write,
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
    };

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
              ],
              "supported_service_tiers": null,
              "additional_speed_tiers": ["fast"],
              "service_tiers": [{"id": "priority"}]
            },
            {
              "slug": "earlier-model",
              "display_name": "Earlier model",
              "visibility": "list",
              "priority": 1,
              "supported_reasoning_levels": [{"effort": "ultra"}],
              "supported_service_tiers": ["default"]
            }
          ]
        }"#
    }

    fn app_server_model(
        id: &str,
        supports_personality: bool,
        is_default: bool,
        efforts: &[&str],
        tiers: &[&str],
    ) -> CodexAppServerModel {
        CodexAppServerModel {
            id: id.into(),
            model: id.into(),
            display_name: id.into(),
            hidden: false,
            is_default,
            supported_reasoning_efforts: efforts
                .iter()
                .map(|effort| CodexAppServerReasoningEffort {
                    reasoning_effort: (*effort).into(),
                })
                .collect(),
            additional_speed_tiers: Vec::new(),
            service_tiers: tiers
                .iter()
                .map(|tier| CodexServiceTier { id: (*tier).into() })
                .collect(),
            supports_personality,
        }
    }

    /// Publish test executables only after their contents and permissions are
    /// complete. Some CI filesystems return ETXTBSY when a freshly-written
    /// executable is launched before the writer's handle is fully closed.
    fn write_executable(path: &Path, contents: &str) {
        let parent = path.parent().expect("executable parent");
        let mut temporary = tempfile::NamedTempFile::new_in(parent).unwrap();
        temporary.write_all(contents.as_bytes()).unwrap();
        temporary.as_file().sync_all().unwrap();
        let temporary = temporary.into_temp_path();

        let mut permissions = fs::metadata(&temporary).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&temporary, permissions).unwrap();
        fs::rename(&temporary, path).unwrap();
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
            capabilities.models[2].supported_speed_tiers,
            BTreeSet::from([SpeedTier::Default, SpeedTier::Fast])
        );
        assert_eq!(
            capabilities.models[1].supported_speed_tiers,
            BTreeSet::from([SpeedTier::Default])
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

    #[test]
    fn app_server_capabilities_preserve_model_personality_and_speed_support() {
        let capabilities = capabilities_from_app_server(vec![
            app_server_model(
                "gpt-5.5",
                true,
                true,
                &["low", "high"],
                &["default", "priority"],
            ),
            app_server_model(
                "gpt-5.6-luna",
                false,
                false,
                &["low", "medium", "max"],
                &["priority"],
            ),
        ]);

        assert_eq!(
            capabilities
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["default", "gpt-5.5", "gpt-5.6-luna"]
        );
        assert_eq!(capabilities.models[1].supports_personality, Some(true));
        assert_eq!(capabilities.models[2].supports_personality, Some(false));
        assert_eq!(
            capabilities.models[2].supported_speed_tiers,
            BTreeSet::from([SpeedTier::Default, SpeedTier::Fast])
        );
        assert_eq!(
            capabilities.models[0].supports_personality, None,
            "mixed model support must remain an explicit aggregate unknown"
        );
    }

    #[tokio::test]
    async fn discovery_uses_the_codex_command_output() {
        let directory = tempdir().unwrap();
        let executable = directory.path().join("codex");
        write_executable(
            &executable,
            &format!("#!/bin/sh\nprintf '%s' '{}'\n", catalog_json()),
        );

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
        write_executable(&executable, "#!/bin/sh\nexit 1\n");

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
